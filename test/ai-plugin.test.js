'use strict';
/* ai-plugin.test.js — AI 分析插件 × 宿主通道 的端到端验证（不依赖 Electron）
 * 运行：node test/ai-plugin.test.js
 *
 * 这一份替的是原来的 test/ai-transport.test.js。AI 不再是内置页之后，"外发对不对"横跨三方：
 * 插件正文（协议 / 提示词 / SSE / Markdown）、宿主桥（权限、闸门、密钥层、号牌）、
 * 网络出口（域名、超时、体积）。所以这里把真的插件包装进真的 PluginHost，
 * 接上真的 createPluginApi 与真 store，对面架一个假的 OpenAI 兼容服务商，把整条流水线点一遍。
 *
 * ★ 只有这种跑法才查得住的一件事：ui.html 里的 id 与 main.js 里 $('…') 的取用必须对得上。
 *   沙箱页没有控制台报错给你看，取错一个 id 就是"按钮点了没反应"（坑 21）。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const { PluginHost } = require('../shell/plugins');
const { createPluginApi } = require('../shell/plugin-api');
const Channels = require('../shell/plugin-channels');
const Net = require('../shell/adapters/plugin-net');
const StoreMod = require('../core/store');
const AiD = require('../core/aiDigest');
const { mkZip } = require('./zip-kit');

const DIR = path.join(__dirname, '..', 'plugins-src', 'ai-analyst');
const SAMPLE = path.join(__dirname, '..', '..', 'df-analyzer', 'sample', 'sample_data.json');
const ID = 'df.ai.analyst';

let fail = 0, n = 0;
function check(name, cond, detail) {
  n++;
  const ok = !!cond;
  if (!ok) fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail !== undefined ? '  -> ' + detail : ''}`);
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ---------------- 假服务商 ---------------- */
const seen = [];
function startProvider() {
  return new Promise(function (resolve) {
    const srv = http.createServer(function (req, res) {
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', async function () {
        const mode = (/[?&]mode=([a-z0-9]+)/.exec(req.url) || [, 'stream'])[1];
        seen.push({ url: req.url, headers: req.headers, body: body });
        if (mode === '401') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
          return;
        }
        if (mode === 'json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ model: 'mock-json', usage: { total_tokens: 42 },
            choices: [{ message: { content: '非流式也认' } }] }));
          return;
        }
        if (mode === 'idle') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n');
          return;                          /* 然后永远不再说话：断流窗口要自己把它判死 */
        }
        if (mode === 'slow') {
          await sleep(400);                /* 首字节前一直沉默：排队 / 思考都算这一段 */
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const p of ['结论一：', '你的 **KD 1.83** 偏高', '\n- 占点偏少\n']) {
          const buf = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n', 'utf8');
          res.write(buf.slice(0, Math.ceil(buf.length / 2)));   /* 中文切成两半发 */
          await sleep(12);
          res.write(buf.slice(Math.ceil(buf.length / 2)));
          await sleep(12);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    srv.listen(0, '127.0.0.1', function () { resolve(srv); });
  });
}

/* ---------------- 把插件正文装进一个最小 DOM ---------------- */
function stubEl(id) {
  return {
    id: id, value: '', textContent: '', innerHTML: '', placeholder: '', checked: false,
    disabled: false, maxLength: 0, style: {}, className: '',
    classList: { toggle: function () {}, add: function () {}, remove: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, querySelectorAll: function () { return []; }, closest: function () { return null; }
  };
}
function loadPlugin(bridge) {
  const src = fs.readFileSync(path.join(DIR, 'main.js'), 'utf8');
  const els = {}, asked = [], handlers = [];
  let def = null;
  const root = { querySelector: function (sel) {
    const id = String(sel).replace(/^#/, '');
    asked.push(id);
    return els[id] || (els[id] = stubEl(id));
  } };
  const sandbox = {
    Promise: Promise, JSON: JSON, Math: Math, Date: Date, Number: Number, String: String,
    Array: Array, Object: Object, RegExp: RegExp, Error: Error, Boolean: Boolean,
    isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat, console: console, URL: URL,
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval
  };
  sandbox.DFPlugin = {
    register: function (d) { def = d; },
    on: function (f) { handlers.push(f); },
    call: function (m, a) { return bridge.call(m, a); },
    kv: {
      get: function (k) { return bridge.call('kv.get', { key: k }).then(function (r) { return r && r.value !== undefined ? r.value : null; }); },
      set: function (k, v) { return bridge.call('kv.set', { key: k, value: v }).then(function () { return true; }); }
    },
    secret: {
      get: function (k) { return bridge.call('secret.get', { key: k }).then(function (r) { return r && r.value !== undefined ? r.value : null; }); },
      set: function (k, v) { return bridge.call('secret.set', { key: k, value: v }).then(function () { return true; }); }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'ai-analyst/main.js' });
  return { def: function () { return def; }, els: els, asked: asked, root: root,
    fire: function (ev, data) { handlers.forEach(function (h) { h(ev, data); }); } };
}

(async function main() {
  const srv = await startProvider();
  const port = srv.address().port;
  const BASE = 'http://127.0.0.1:' + port + '/v1/chat/completions';

  /* ---------- 0) 清单 ---------- */
  const man = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  const scopes = man.permissions.map(function (p) { return p.scope; });
  check('★ 清单只申请它真用的五项能力', scopes.join(',') === 'view,read.digest,storage,read.legacy,net.request', scopes.join(','));
  /* ★ 域名不再由出包方预置：清单显式写 ["*"]，地址由使用者在插件页里自己填（出口仍只认 https + 逐字确认） */
  const netPerm = man.permissions.filter(function (p) { return p.scope === 'net.request'; })[0] || {};
  check('★ 服务商地址交给使用者填：hosts 恰好是显式通配',
    JSON.stringify(netPerm.hosts) === JSON.stringify(['*']), JSON.stringify(netPerm.hosts));
  check('★ 清单里没有残留的域名占位符', !/\{\{[A-Z_]*_HOST\}\}/.test(JSON.stringify(man)));
  /* 用户定过的那一句原句：写在测试里，不再由宿主代码提供（出厂包里不许留任何 AI 痕迹） */
  const CONSENT = '我已确认，并将数据上传到我信任的AI服务器上进行分析';
  check('★ 确认句沿用用户定过的那一句，一字不改', man.consent.sentence === CONSENT, man.consent.sentence);
  check('披露两栏写满且每条 ≤60 字',
    man.consent.sends.length >= 4 && man.consent.doesNotSend.length >= 3 &&
    man.consent.sends.concat(man.consent.doesNotSend).every(function (x) { return x.length <= 60; }));
  check('minHostVersion 抬到本版接口', man.minHostVersion === '1.7.0', man.minHostVersion);
  check('★ 插件正文里不含 WeGame 域名与登录接口（拿不到登录态）',
    !/wegame|qq\.com|GetBattleList/i.test(fs.readFileSync(path.join(DIR, 'main.js'), 'utf8')));

  /* ---------- 1) 真包 → 真宿主 ---------- */
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'df-ai-plugin-'));
  const userDataDir = function () { return TMP; };
  const pkgFiles = ['manifest.json', 'ui.html', 'main.js'].map(function (f) {
    return { name: f, data: fs.readFileSync(path.join(DIR, f)), method: f === 'main.js' ? 8 : 0 };
  });
  const host = PluginHost({ userDataDir: TMP });
  const pv = host.inspectWithBuffers(mkZip(pkgFiles));
  check('★ 这个包能被宿主收下并解出清单', pv.ok === true, pv.message || '');
  const ins = host.install(pv, { acceptedScopes: scopes });
  check('全勾五项权限后装上，且默认禁用', ins.ok === true && ins.plugin.enabled === false, ins.message);
  check('启用成功', host.setEnabled(ID, true).ok === true);

  const raw = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  const store = new StoreMod.Store({ load: function () { return null; }, save: function () { return Promise.resolve(); } });
  await store.load();
  await store.ingest({ at: Date.now(), role: raw.role, season: raw.season, list: raw.list, maps: raw.maps, details: raw.details });
  store.state.meta.slot = 'a1';

  const pending = [];
  const dig = Channels.createDigestChannel({ getStore: function () { return store; } });
  const leg = Channels.createLegacyChannel({ getStore: function () { return store; }, userDataDir: userDataDir });
  const api = createPluginApi({
    host: host,
    getStore: function () { return store; },
    emit: function (id, ev, data) { pending.push([id, ev, data]); },
    digest: function (id, args) { return dig.run(id, args); },
    legacy: function (id) { return leg.take(id); },
    legacyInfo: function () { return leg.check(); }
  });
  const bridge = { call: function (m, a) { return api.dispatch(ID, m, a || {}); } };
  const page = loadPlugin(bridge);
  function pump() { while (pending.length) { const e = pending.shift(); if (e[0] === ID) page.fire(e[1], e[2]); } }

  /* ---------- 2) 挂载：id 对得上、初始化不炸 ---------- */
  let mountErr = '';
  try { page.def().mount(page.root); } catch (e) { mountErr = String((e && e.stack) || e); }
  await sleep(150); pump();
  check('★ 页面挂载不报错', mountErr === '', mountErr.split('\n')[0]);
  const UI_HTML = fs.readFileSync(path.join(DIR, 'ui.html'), 'utf8');
  const htmlIds = {};
  (UI_HTML.match(/id="([\w-]+)"/g) || [])
    .forEach(function (x) { htmlIds[/id="([\w-]+)"/.exec(x)[1]] = 1; });
  const missing = page.asked.filter(function (id) { return !htmlIds[id]; });
  check('★ 页面取的每一个 id 都在 ui.html 里', missing.length === 0, missing.join(',') || page.asked.length + ' 个全部命中');
  const t = page.def().t, st = t.state;
  check('未确认时页面只转述宿主判定，且不自带确认框',
    /宿主/.test(page.els.gate.textContent) && /逐字输入那句确认/.test(page.els.gate.textContent) &&
    /id="gate"[^>]*>\s*<\/p>/.test(UI_HTML) && !/id="\w*(consent|confirm)\w*"/i.test(UI_HTML),
    String(page.els.gate.textContent).slice(0, 20));

  /* ---------- 3) 闸门 ---------- */
  const refused = await bridge.call('net.stream', { url: BASE, method: 'POST', body: { a: 1 } });
  check('★ 未确认时流式请求被宿主拒', refused.ok === false && /还没在宿主这里逐字确认/.test(refused.error || ''), refused.error);
  check('★ 被闸门挡下的调用不吃外发额度', seen.length === 0, '服务商收到 ' + seen.length + ' 次');
  check('少一个字都不放行',
    host.grantConsent(ID, '我已确认，并将数据上传到我信任的AI服务器进行分析').ok !== true);
  check('★ 逐字输入（含全角空格与句末句号）即放行',
    host.grantConsent(ID, ' 我　已确认，并将数据上传到我信任的AI服务器上进行分析。 ').ok === true);

  /* ★ 回归（2026-09-23 用户报）：宿主面板刚允许完，iframe 里那句「还差一步…」还挂着 ——
   *   页面只在 mount 时用 host.info 问过一次性状态。修法是宿主每次画闸门都推一个 gate 事件，
   *   页面收到就重新问一遍：判定源只有宿主那一份，界面永远只是镜像。 */
  page.fire('gate', {});
  await new Promise(function (r) { setTimeout(r, 40); });
  check('★ 宿主推 gate 事件后，页面提示立刻改口（不重新 mount）',
    /已确认允许外发/.test(page.els.gate.textContent) && !/还差一步/.test(page.els.gate.textContent),
    String(page.els.gate.textContent).slice(0, 24));
  host.revokeConsent(ID);
  page.fire('gate', {});
  await new Promise(function (r) { setTimeout(r, 40); });
  check('★ 撤销也立刻改口：回到「还差一步」',
    /还差一步/.test(page.els.gate.textContent), String(page.els.gate.textContent).slice(0, 24));
  host.grantConsent(ID, CONSENT);
  page.fire('gate', {});
  await new Promise(function (r) { setTimeout(r, 40); });

  /* ---------- 4) 摘要通道 ---------- */
  const list = await bridge.call('ai.digest', { list: true });
  check('单场清单给号牌 + 选人所需字段',
    list.ok === true && list.rows.length > 0 && !!list.rows[0].handle && 'map' in list.rows[0] && 'winner' in list.rows[0],
    'rows=' + (list.rows || []).length);
  check('★ 清单里没有 room_id / openid / 玩家名单',
    !/room_id|openid|vopenid/.test(JSON.stringify(list)), JSON.stringify(list).slice(0, 70));
  const g = await bridge.call('ai.digest', { scope: 'global', mode: 'all' });
  check('整体摘要能生成，带字节与 token 估算',
    g.ok === true && g.text.length > 200 && g.bytes > 0 && g.estTokens > 0, g.ok ? 'bytes=' + g.bytes : g.error);
  check('★ 摘要正文里没有 openid', String(g.text).indexOf(String(raw.role.openid || '_none_')) === -1);
  const m1 = await bridge.call('ai.digest', { scope: 'match', handle: list.rows[0].handle });
  check('单场摘要用号牌换得到', m1.ok === true, m1.ok ? 'bytes=' + m1.bytes : m1.error);
  check('★ 编造或过期的号牌被拒',
    (await bridge.call('ai.digest', { scope: 'match', handle: 'm-nope' })).ok === false);
  const days = await bridge.call('ai.digest', { scope: 'global', days: 7 });
  check('「近 N 天」由宿主换算，正文里只出现"近 N 天"',
    days.ok === true && /近\s*7\s*天/.test(days.text), days.ok ? 'ok' : days.error);
  check('★ 摘要通道不给没批 read.digest 的插件',
    (await api.dispatch('df.nobody', 'ai.digest', { scope: 'global' })).ok === false);

  /* ---------- 5) 密钥层 ---------- */
  await bridge.call('kv.set', { key: 'note', value: 'sk-test-123 不该出现在这里' });
  await bridge.call('secret.set', { key: 'apiKey', value: 'sk-test-123' });
  check('★ 密钥落在独立文件里',
    fs.existsSync(path.join(TMP, 'plugin-data', ID + '.secret.json')));
  check('★ kv.get 不带 key 时扫不到密钥值（键名可以有，值不行）',
    JSON.stringify((await bridge.call('secret.get', {})).keys).indexOf('sk-test-123') === -1 &&
    (await bridge.call('secret.get', { key: 'apiKey' })).value === 'sk-test-123');
  check('★ 密钥只许字符串或 null', (await bridge.call('secret.set', { key: 'k', value: { a: 1 } })).ok === false);
  check('删除后取回 null',
    (await bridge.call('secret.set', { key: 'apiKey', value: null })).ok === true &&
    (await bridge.call('secret.get', { key: 'apiKey' })).value === null);
  await bridge.call('secret.set', { key: 'apiKey', value: 'sk-test-123' });
  await bridge.call('kv.set', { key: 'note', value: null });
  /* ---------- 6) 真出网 ---------- */
  const job = await bridge.call('net.stream', {
    url: BASE, method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-123', cookie: 'session=hijack' },
    body: { model: 'mock-model', stream: true, messages: t.buildMessages(g.text, '为什么我医疗兵胜率反而更低？') }
  });
  check('★ 流式调用立刻回 streamId', job.ok === true && !!job.streamId, JSON.stringify(job));
  check('★ 一个插件同时只许一条流',
    (await bridge.call('net.stream', { url: BASE, method: 'POST', body: {} })).ok === false);
  await sleep(320);
  const req = seen[seen.length - 1] || { headers: {}, body: '' };
  check('服务商真收到那一问，带的就是用户自己填的密钥',
    /^Bearer sk-test-123$/.test(String(req.headers.authorization || '')) && /为什么我医疗兵胜率反而更低/.test(req.body),
    String(req.headers.authorization));
  check('★ Cookie 头由宿主管，插件塞不进去', !req.headers.cookie, String(req.headers.cookie || ''));
  const sent = JSON.parse(req.body);
  const userMsg = (sent.messages || []).filter(function (m) { return m.role === 'user'; })[0] || { content: '' };
  check('★ 发出去的就是宿主那份摘要原文，且不含 openid',
    userMsg.content.indexOf(g.text) === 0 &&
    JSON.stringify(sent).indexOf(String(raw.role.openid || '_none_')) === -1,
    userMsg.content.slice(0, 24));
  const order = [];
  while (pending.length) order.push(pending.shift()[1]);
  check('事件按 open → data → end 的顺序送到',
    order[0] === 'net.open' && order.indexOf('net.data') > 0 && order[order.length - 1] === 'net.end', order.join(','));
  /* ---------- 7) SSE 拆包 / 错误 / 非流式回落 ---------- */
  st.streamId = 'probe'; st.status = 200; st.contentType = 'text/event-stream';
  st.sseBuf = ''; st.errBody = ''; st.text = ''; st.streaming = true; st.lastAsk = ''; st.usage = null;
  const feed = 'data: {"choices":[{"delta":{"content":"甲"}}]}\n\ndata: {"choices":[{"delta":{"content":"乙"}}]}\n' +
    ': 注释行\n\ndata: {"usage":{"total_tokens":7}}\n\ndata: [DONE]\n\ndata: 坏掉的 json\n\n';
  page.fire('net.open', { streamId: 'probe', status: 200, contentType: 'text/event-stream' });
  [feed.slice(0, 30), feed.slice(30, 61), feed.slice(61)].forEach(function (c) {
    page.fire('net.data', { streamId: 'probe', text: c });
  });
  check('★ 分片乱着来也拼回正文，注释与坏行被丢掉', st.text === '甲乙', JSON.stringify(st.text));
  check('usage 被采到（成本可见性靠它）', !!(st.usage && st.usage.total_tokens === 7), JSON.stringify(st.usage));
  const before = st.text;
  st.streamId = '';
  page.fire('net.data', { streamId: 'probe', text: '丙' });
  check('★ 不认识的 streamId 一律不认（切页后旧流不能往新页面写字）', st.text === before);
  check('错误话术由插件翻译成人话', /密钥无效/.test(t.describeError(401, '{"error":{"message":"x"}}')));
  await bridge.call('net.stream', { url: BASE + '?mode=401', method: 'POST', body: { x: 1 } });
  await sleep(160);
  const badEv = [];
  while (pending.length) badEv.push(pending.shift());
  const badEnd = badEv.filter(function (e) { return e[1] === 'net.end'; })[0];
  const badData = badEv.filter(function (e) { return e[1] === 'net.data'; }).map(function (e) { return e[2].text; }).join('');
  check('★ 401 以 ok:false + status 收尾，错误正文照样交付',
    !!badEnd && badEnd[2].ok === false && badEnd[2].status === 401 && /Incorrect API key/.test(badData),
    badEnd ? JSON.stringify(badEnd[2]).slice(0, 90) : '没有 end 事件');
  await bridge.call('net.stream', { url: BASE + '?mode=json', method: 'POST', body: { x: 1 } });
  await sleep(160);
  const jsonTxt = [];
  while (pending.length) { const e = pending.shift(); if (e[1] === 'net.data') jsonTxt.push(e[2].text); }
  check('无视 stream:true 直接回 JSON 的服务商也接得住', /非流式也认/.test(jsonTxt.join('')), jsonTxt.join('').slice(0, 40));
  /* ---------- 8) Markdown 白名单（渲染器住在插件包里，判据一条不能比宿主时代松） ----------
   * 沙箱页虽然拿不到 df.* 桥，但它要 innerHTML 远端文本 —— 所以这一节仍然只断言一件事：
   * 无论输入写成什么样，产出标签都必须落在白名单内、且永远出不来 href。 */
  const EVIL = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">点我</a>', '[点我](https://evil.example.com/x)',
    'a" onmouseover="alert(1)" b', '```html\n<script>x</script>\n```',
    '> 引用里 <i>i</i>', '`行内 code<b>`', '# 一级', '## 二级', '### 三级', '#### 四级',
    '##### 五级', '| 甲 | 乙 |\n|---|---|\n| <script> | [t](u) |', '- 列表 <em>项</em>',
    '控制字符 \x00\x07\x1b 与伪造占位 \u00010\u0001', '1. 有序 <b>一</b>'
  ].join('\n\n');
  const md = t.mdRender('# 标题\n<script>alert(1)</script>\n\n- 甲\n\n| a | b |\n|---|---|\n| 1 | <img src=x onerror=alert(1)> |\n\n' +
    '[点我](https://evil.example/)\n\n> 引用\n\n```\n<b>raw</b>\n```');
  check('★ 远端文本里的 script/img 变不成活标签',
    md.indexOf('<script>') === -1 && md.indexOf('<img') === -1 && /&lt;script&gt;/.test(md));
  check('★ 不生成任何可点外链', md.indexOf('<a ') === -1 && /点我（https/.test(md));
  check('h1 压到 h3，表格 / 列表 / 引用 / 代码块按白名单重建',
    md.indexOf('<h1') === -1 && /<h3/.test(md) && /<table/.test(md) && /<ul>/.test(md) &&
    /<blockquote>/.test(md) && /&lt;b&gt;raw/.test(md));
  const evilHtml = t.mdRender(EVIL);
  /* div 只可能来自渲染器自己写的 .pl-scroll 包装，远端文本里的 div 早就在入口被转义了 */
  const ALLOWED = { p: 1, br: 1, strong: 1, em: 1, del: 1, code: 1, pre: 1, h3: 1, h4: 1, div: 1,
    ul: 1, ol: 1, li: 1, blockquote: 1, table: 1, thead: 1, tbody: 1, tr: 1, th: 1, td: 1, hr: 1 };
  const tags = (evilHtml.match(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g) || [])
    .map(function (s) { return s.replace(/[<\/]/g, '').toLowerCase(); });
  const viol = tags.filter(function (x) { return !ALLOWED[x]; });
  check('★ 一整套恶意输入过完，产出标签全部在白名单内',
    viol.length === 0, viol.length ? viol.join(',') : tags.length + ' 个标签');
  /* 结构化判据：把合法标签整段剥掉后不能再留下任何裸 '<' ——
   * 也就是不存在「属性拼进邻近标签」或「半截标签」的通道，比查 href/onerror 字样严 */
  const stripped = evilHtml.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(\s+[a-zA-Z-]+="[^"]*")*\s*\/?>/g, '');
  check('★ 剥掉白名单标签后不残留任何裸尖括号',
    stripped.indexOf('<') === -1, (stripped.match(/<[^]{0,40}/g) || []).slice(0, 2).join(' | '));
  check('禁掉 h1/h2，远端文本盖不过页面骨架',
    tags.indexOf('h1') === -1 && tags.indexOf('h2') === -1 &&
    evilHtml.indexOf('<h3>一级</h3>') !== -1 && evilHtml.indexOf('<h4>四级</h4>') !== -1);
  check('代码块内容不参与行内替换，语言标记也不混进正文',
    /<pre class="md-code"><code>&lt;script&gt;x&lt;\/script&gt;<\/code><\/pre>/.test(evilHtml) &&
    evilHtml.indexOf('md-code"><code>html') === -1);
  check('表格与列表照常成形', evilHtml.indexOf('<table') !== -1 &&
    (evilHtml.match(/<th>/g) || []).length >= 2 && evilHtml.indexOf('<ul>') !== -1 &&
    evilHtml.indexOf('<ol>') !== -1);
  /* 360px 竖屏红线：宽表唯一的容身处是 .pl-scroll，漏一张就是一次整页撑破 */
  check('★ 每张表都被 .pl-scroll 包着（窄屏下不许有裸表）',
    (evilHtml.match(/<table/g) || []).length ===
    (evilHtml.match(/<div class="pl-scroll"><table/g) || []).length &&
    (evilHtml.match(/<table/g) || []).length >= 1,
    '表=' + (evilHtml.match(/<table/g) || []).length +
    ' 包好的=' + (evilHtml.match(/<div class="pl-scroll"><table/g) || []).length);
  check('★ 占位符伪造不了（控制字符先被剥掉）',
    t.mdRender('a\u0001b\n\u00010\u0001').indexOf('\u0001') === -1);
  const unbalanced = t.mdRender('正文\n```\n<b>y</b>');
  check('未闭合围栏不抛错且照样转义',
    unbalanced.indexOf('&lt;b&gt;y&lt;/b&gt;') !== -1 && unbalanced.indexOf('<b>') === -1);
  check('超长输入被截断', t.mdRender(new Array(400 * 1024).join('x')).length < 400 * 1024);
  check('空输入渲染成空串', t.mdRender('') === '' && t.mdRender(null) === '');
  check('提示词三条硬规则都在正文里（不许编造、代号不外推、样本小要降级）',
    /不要追问或猜测真实身份/.test(t.SYSTEM_PROMPT) && /摘要里没有的数据一律不要编造/.test(t.SYSTEM_PROMPT) &&
    /样本量小时要明说置信度不足/.test(t.SYSTEM_PROMPT));
  /* ---------- 9) 旧数据：一次性交出去，本机那份改名留底 ---------- */
  store.state.aiReports = {
    r1: { id: 'r1', kind: 'global', at: 1, text: '旧结果一', model: 'm', ask: '' },
    r2: { id: 'r2', kind: 'match', at: 2, text: '旧结果二', model: 'm', ask: '为什么输' }
  };
  fs.writeFileSync(path.join(TMP, 'ai-config.json'),
    JSON.stringify({ presetKey: 'deepseek', baseUrl: BASE, model: 'deepseek-chat', apiKey: 'sk-old', consent: true, autoDaily: true }));
  const pre = leg.check();
  check('待搬状态只报"有没有、多少"，不给内容',
    pre.hasConfig === true && pre.reports === 2 && pre.hasAnything === true && JSON.stringify(pre).indexOf('旧结果') === -1,
    JSON.stringify(pre));
  const mv = await bridge.call('legacy.ai', {});
  check('★ 配置与历史一次交出，密钥也在其中',
    mv.ok === true && mv.config && mv.config.apiKey === 'sk-old' && mv.reports.length === 2,
    JSON.stringify(mv.archived));
  check('★ 本机那份是改名留底，不是删掉',
    !fs.existsSync(path.join(TMP, 'ai-config.json')) &&
    fs.readdirSync(TMP).some(function (f) { return /^ai-config\.json\.migrated/.test(f); }) &&
    fs.readFileSync(path.join(TMP, 'ai-reports-legacy.json'), 'utf8').indexOf('旧结果一') !== -1);
  check('★ state 里的历史已摘干净（不会下次再搬一遍）',
    Object.keys(store.state.aiReports).length === 0);
  const mv2 = await bridge.call('legacy.ai', {});
  check('★ 第二次来就没有了（一次性）', mv2.ok === false && /没有可搬/.test(mv2.error || ''), mv2.error);
  check('待搬状态也随之变空', leg.check().hasAnything === false);
  /* ---------- 10) 待办：宿主只记一笔，取走要有人在页面上 ---------- */
  check('默认没开开关', (host.find(ID).autoTrigger || {}).on !== true);
  check('页面自己打开开关', host.armTrigger(ID, true).ok === true);
  check('列表里能看到"已开 + 还没看过"',
    (function () { const p = host.list().filter(function (x) { return x.id === ID; })[0];
      return p.autoTrigger === true && p.pendingTrigger === null; })());
  host.noteTrigger(ID, { at: Date.now() - 5000, slot: 'a1', inserted: 3, matches: 36 });
  host.noteTrigger(ID, { at: Date.now(), slot: 'a1', inserted: 1, matches: 37 });
  const tk = await bridge.call('trigger.take', {});
  check('★ 取到的是累计两笔，且带最近一次的口径',
    tk.ok === true && tk.trigger.count === 2 && tk.trigger.info.matches === 37, JSON.stringify(tk.trigger));
  check('★ 取走即清零（同一笔不会天天提醒）', (await bridge.call('trigger.take', {})).trigger === null);
  check('★ opt-in 不进权限指纹：开着开关，完整性复核仍然通过',
    host.verifyFiles(ID).ok === true, host.verifyFiles(ID).message);
  check('没页面的插件取不到待办',
    (await api.dispatch('df.nobody', 'trigger.take', {})).ok === false);

  /* ---------- 11) 出口的三个窗口（真量，不读代码猜） ---------- */
  const idleEnd = await new Promise(function (res) {
    Net.stream({ url: BASE + '?mode=idle', method: 'POST', body: '{}', allowlist: ['127.0.0.1'],
      idleTimeout: 160, connectTimeout: 5000, totalTimeout: 5000,
      onEvent: function (e) { if (e.type === 'end') res(e.end); } });
  });
  check('★ 开始吐字之后再沉默 = 断流', idleEnd.ok === false && /没有新内容/.test(idleEnd.error || ''), idleEnd.error);
  check('★ 断流之前已经收到的部分不丢', idleEnd.bytes > 0, 'bytes=' + idleEnd.bytes);
  const slowEnd = await new Promise(function (res) {
    Net.stream({ url: BASE + '?mode=slow', method: 'POST', body: '{}', allowlist: ['127.0.0.1'],
      idleTimeout: 5000, connectTimeout: 120, totalTimeout: 5000,
      onEvent: function (e) { if (e.type === 'end') res(e.end); } });
  });
  check('★ 第一个字节之前的沉默归连接窗口管，不误判成断流',
    slowEnd.ok === false && /连接超时/.test(slowEnd.error || ''), slowEnd.error);
  const capEnd = await new Promise(function (res) {
    Net.stream({ url: BASE, method: 'POST', body: '{}', allowlist: ['127.0.0.1'],
      maxBytes: 40, onEvent: function (e) { if (e.type === 'end') res(e.end); } });
  });
  check('★ 体积上限真的会掐（不是记个数就算了）',
    capEnd.ok === false && /上限/.test(capEnd.error || '') && capEnd.truncated === true, capEnd.error);
  const live = await bridge.call('net.stream', { url: BASE + '?mode=idle', method: 'POST', body: '{}' });
  await sleep(60);
  api.abortAll(ID);
  await sleep(60);
  const cutEv = [];
  while (pending.length) { const e = pending.shift(); if (e[1] === 'net.end') cutEv.push(e[2]); }
  check('★ 撤销允许要能掐断正在跑的那条流（不然只对下一次生效）',
    live.ok === true && cutEv.length === 1 && cutEv[0].ok === false &&
    (cutEv[0].aborted === true || /停止/.test(cutEv[0].error || '')), JSON.stringify(cutEv[0] || {}));
  check('掐断之后额度可以立刻再用一条',
    (await bridge.call('net.stream', { url: BASE, method: 'POST', body: '{}' })).ok === true);

  console.log('----------------------------------------------------------------');
  console.log(fail === 0 ? n + ' 项全部通过' : fail + ' 项失败 / 共 ' + n + ' 项');
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('测试本身炸了：', (e && e.stack) || e);
  process.exit(1);
});
