'use strict';
/* plugin-bridge.test.js — 插件能力桥的权限派发与网络出口（不依赖 Electron）
 * 运行：node test/plugin-bridge.test.js
 *
 * 这里验的不是"功能能不能跑"，而是**没批的东西能不能拿到**。
 * 网络用例走 127.0.0.1 的本地 mock（明文 http 只放本机，是 plugin-net 里唯一的例外）。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { PluginHost } = require('../shell/plugins');
const { createPluginApi } = require('../shell/plugin-api');
const Net = require('../shell/adapters/plugin-net');
const Plg = require('../core/plugin');
const StoreMod = require('../core/store');
const { mkZip, withRoot } = require('./zip-kit');

const SAMPLE = path.join(__dirname, '..', '..', 'df-analyzer', 'sample', 'sample_data.json');
const raw = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));

const TMP = path.join(os.tmpdir(), 'df-plugin-bridge');
let fail = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail !== undefined ? '  -> ' + detail : ''}`);
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }

const CONSENT = {
  sentence: '我已确认，并将数据上传到我信任的战队网站',
  sends: ['20 项汇总指标'], doesNotSend: ['逐场明细', '身份标识']
};
function wantsGate(scopes) {
  return (scopes || []).some(function (s) {
    const def = Plg.SCOPES[(s && s.scope) || s];
    return !!(def && def.needsConsent);
  });
}
function manifestOf(scopes, extra) {
  const o = Object.assign({
    id: 'df.bridge', name: '桥测试', version: '1.0.0',
    entry: 'ui.html', script: 'main.js', permissions: scopes
  }, extra || {});
  /* ★ 要外发就得带确认句（core/plugin.js 里 needsConsent 的硬要求）。
   * 默认给一份让其余用例不必重复；想测"没带"的用 consent:null 覆盖。 */
  if (o.consent === undefined && wantsGate(scopes)) o.consent = CONSENT;
  else if (o.consent === null) delete o.consent;
  return JSON.stringify(o);
}
const UI_HTML = '<!doctype html><meta charset="utf-8"><div id="app"></div>';
const MAIN_JS = 'export default { mount(){} };';

function pkg(scopes, extra) {
  return mkZip([
    { name: 'manifest.json', data: manifestOf(scopes, extra) },
    { name: 'ui.html', data: UI_HTML },
    { name: 'main.js', data: MAIN_JS, method: 8 }
  ]);
}

function installOf(host, buf, scopes) {
  const p = host.inspectWithBuffers(buf);
  if (!p.ok) return { ok: false, message: p.message };
  return host.install(p, { acceptedScopes: scopes.map(function (s) { return typeof s === 'string' ? s : s.scope; }) });
}

(async function () {
  rmrf(TMP);
  fs.mkdirSync(TMP, { recursive: true });
  const host = PluginHost({ userDataDir: TMP });
  const NET_SCOPES = [{ scope: 'view' }, { scope: 'read.summary' }, { scope: 'storage' },
    { scope: 'net.request', hosts: ['127.0.0.1'] }];

  const ins = installOf(host, pkg(NET_SCOPES), NET_SCOPES);
  check('装一个带网络权限的插件', ins.ok === true, ins.message || 'enabled=' + ins.plugin.enabled);
  check('★ 新装的插件默认是禁用的', ins.ok && ins.plugin.enabled === false);

  /* 真数据：让 summary 算的是真样本，而不是空壳 */
  const store = new StoreMod.Store({ load: () => null, save: () => {} });
  await store.load();
  await store.ingest({ at: Date.now(), role: raw.role, season: raw.season, list: raw.list, maps: raw.maps, details: raw.details });
  const api = createPluginApi({ host: host, getStore: function () { return store; } });
  const ID = 'df.bridge';

  const off = await api.dispatch(ID, 'host.info', {});
  check('未启用时任何调用都被拒', off.ok === false && /未启用/.test(off.error || ''), off.error);

  check('启用（启用前会复算文件哈希）', host.setEnabled(ID, true).ok === true);
  const info = await api.dispatch(ID, 'host.info', {});
  check('启用后 host.info 通过', info.ok === true && info.scopes.length === 4, JSON.stringify(info.scopes || info.error));
  check('host.info 不回任何密钥与路径', !/apiKey|userData|C:\\\\|plugin-data/.test(JSON.stringify(info)));

  /* ---------- ★ 外发确认闸门（判定在宿主，插件页上的确认框不算数） ---------- */
  check('host.info 如实回传闸门状态（要确认、还没确认）',
    info.needsConsent === true && info.consentOk === false, JSON.stringify([info.needsConsent, info.consentOk]));
  const preGate = await api.dispatch(ID, 'net.request', { url: 'https://127.0.0.1:9/never' });
  check('★ 没确认时 net.request 被宿主挡掉，且根本没去连（端口都没碰）',
    preGate.ok === false && /还没在宿主这里逐字确认/.test(preGate.error || ''), preGate.error);
  check('认句错的确认被拒', host.grantConsent(ID, '我确认，并将数据上传到我信任的战队网站').ok === false);
  check('空输入被拒', host.grantConsent(ID, '   ').ok === false);
  check('★ 全角空格 + 句末句号仍算逐字一致', host.grantConsent(ID, ' 我　已确认，并将数据上传到我信任的战队网站。 ').ok === true);
  check('确认之后 host.info 的镜像跟着变',
    (await api.dispatch(ID, 'host.info', {})).consentOk === true);
  const afterGate = await api.dispatch(ID, 'net.request', { url: 'https://127.0.0.1:9/never' });
  check('★ 确认之后同样的调用才轮到域名/端口校验（说明闸门真的放行过了）',
    afterGate.ok === false && /端口/.test(afterGate.error || ''), afterGate.error);
  check('★ 撤销之后立刻又发不出去', host.revokeConsent(ID).ok === true &&
    /还没在宿主这里逐字确认/.test((await api.dispatch(ID, 'net.request', { url: 'https://127.0.0.1:9/x' })).error || ''));
  /* 闸门排在限频之前：被挡掉的调用不该吃掉额度（吃掉的话，下面这 25 次会把后面所有网络用例饿死） */
  for (var g = 0; g < 25; g++) await api.dispatch(ID, 'net.request', { url: 'https://127.0.0.1:9/never' });
  host.grantConsent(ID, CONSENT.sentence);
  const notThrottled = await api.dispatch(ID, 'net.request', { url: 'https://127.0.0.1:9/never' });
  check('★ 被闸门挡掉的 25 次没吃掉限频额度',
    !/过于频繁/.test(notThrottled.error || ''), notThrottled.error);
  const kvMode = host.kvWrite(ID, { mode: 1 });
  const kvFile = path.join(TMP, 'plugin-data', ID + '.json');
  check('★ 插件配置走原子写：写完不留 .tmp 残留',
    kvMode.ok === true && !fs.existsSync(kvFile + '.tmp'), kvMode.ok ? 'no tmp' : kvMode.message);
  /* 0600 在 Windows 上量不出来（stat 恒报 666）：与其塞一条永远为真的 PASS，不如明说没测 */
  if (process.platform === 'win32') console.log('  SKIP  0600 权限位（Windows 不提供 POSIX 模式位，只能在非 win 平台实测）');
  else check('★ 插件配置文件落盘是 0600（同机别的账户读不到）', (fs.statSync(kvFile).mode & 0o077) === 0);
  const moved = installOf(host, pkg(NET_SCOPES, {
    consent: { sentence: '我同意把这份数据发出去', sends: [], doesNotSend: [] }
  }), NET_SCOPES);
  host.setEnabled(ID, true);   /* 新导入的一律先禁用，不启用的话报的是"未启用"而不是闸门 */
  check('★ 重新导入 = 重新确认：确认状态归零，之前那句不再算数',
    moved.ok === true && host.consentOk(ID) === false &&
    moved.plugin.consentGiven === false &&
    /逐字确认/.test((await api.dispatch(ID, 'net.request', { url: 'https://127.0.0.1/login' })).error || ''));
  check('旧那句在新包下不再被接受',
    host.grantConsent(ID, CONSENT.sentence).ok === false &&
    host.grantConsent(ID, '我同意把这份数据发出去').ok === true && host.consentOk(ID) === true);
  /* 恢复成原包（同句确认），后面的网络用例继续用它 */
  installOf(host, pkg(NET_SCOPES), NET_SCOPES);
  host.setEnabled(ID, true);
  host.grantConsent(ID, CONSENT.sentence);
  check('换回原包后又能服务', host.consentOk(ID) === true);

  const sum = await api.dispatch(ID, 'summary.get', { mode: 'swtwr' });
  check('summary.get(swtwr) 有数', sum.ok === true && sum.totals.matches > 0 && sum.mode === 'swtwr',
    sum.ok ? 'matches=' + sum.totals.matches : sum.error);
  check('summary 带覆盖区间与近 N 局', sum.ok && !!sum.span && !!sum.windows.last10 && !!sum.streak);
  /* 载荷新加的那格 KPM：口径必须是「累计击杀 ÷ 累计分钟」，走的是和 summaryFor 同一个池子 */
  (function () {
    const rows = store.matches({ mode: 'swtwr' });
    const kill = rows.reduce(function (a, r) { return a + (r.kill || 0); }, 0);
    const sec = rows.reduce(function (a, r) { return a + (r.game_time || 0); }, 0);
    const pooled = Math.round((kill / (sec / 60)) * 100) / 100;
    check('★ 载荷里的 killsPerMinute = 累计击杀 ÷ 累计分钟（跟 core 那颗对得上）',
      sum.totals.killsPerMinute === pooled,
      '载荷=' + sum.totals.killsPerMinute + ' 池化=' + pooled + ' 场次=' + rows.length);
    const avg = rows.filter(function (r) { return (r.game_time || 0) > 0; })
      .reduce(function (a, r) { return a + r.kill / (r.game_time / 60); }, 0) / rows.length;
    check('killsPerMinute 念的是池化值，不是逐场平均（口径没被悄悄换掉）',
      Math.round(avg * 100) / 100 !== pooled || rows.length === 1,
      '池化=' + pooled + ' 逐场平均=' + Math.round(avg * 100) / 100);
  })();
  check('未知 mode 静默回落到全部', (await api.dispatch(ID, 'summary.get', { mode: 'bogus' })).mode === 'all');

  /* ★ 汇总里绝不能混进任何可跨局关联的身份线索 */
  const sumText = JSON.stringify(sum);
  const rooms = Object.keys(store.state.matches).slice(0, 5);
  const names = [];
  Object.keys(store.state.rosters).forEach(function (k) {
    const r = store.state.rosters[k] || {};
    (Array.isArray(r) ? r : (r.players || [])).forEach(function (p) { if (p.name) names.push(String(p.name)); });
  });
  const uniqNames = Array.from(new Set(names)).filter(function (n) { return n.length >= 3; }).slice(0, 20);
  check('★ 汇总里没有 room_id', rooms.every(function (r) { return sumText.indexOf(r) === -1; }));
  check('★ 汇总里没有 openid', sumText.indexOf(String(store.state.meta.openid)) === -1 && !/openid/.test(sumText));
  check('★ 汇总里没有玩家昵称', uniqNames.every(function (n) { return sumText.indexOf(n) === -1; }),
    uniqNames.slice(0, 3).join(','));

  const kv = await api.dispatch(ID, 'kv.set', { key: 'site', value: 'https://127.0.0.1' });
  check('storage 已批 → kv 可写', kv.ok === true);
  check('kv 读回一致', (await api.dispatch(ID, 'kv.get', { key: 'site' })).value === 'https://127.0.0.1');
  check('宿主保留前缀 __ 不给写', (await api.dispatch(ID, 'kv.set', { key: '__cookies', value: 1 })).ok === false);
  check('超大 kv 值被拒', (await api.dispatch(ID, 'kv.set', { key: 'big', value: new Array(70000).join('x') })).ok === false);

  const noNet = installOf(host, pkg([{ scope: 'view' }], { id: 'df.plain', name: '只有一页' }), [{ scope: 'view' }]);
  check('装第二个只读插件', noNet.ok === true);
  host.setEnabled('df.plain', true);
  check('★ 没批 read.summary 就拿不到汇总',
    (await api.dispatch('df.plain', 'summary.get', {})).ok === false);
  check('★ 没批 storage 就拿不到 kv',
    (await api.dispatch('df.plain', 'kv.set', { key: 'a', value: 1 })).ok === false);
  check('★ 没批 net.request 就别想出网',
    (await api.dispatch('df.plain', 'net.request', { url: 'https://127.0.0.1/x' })).ok === false);
  check('★ 不申请外发的插件，闸门与它无关（consentOk 恒为真）',
    host.needsConsent('df.plain') === false && host.consentOk('df.plain') === true);
  check('未知方法名直接拒', (await api.dispatch('df.plain', 'steal.everything', {})).ok === false);

  /* ---------- 网络出口 ---------- */
  const hits = [];
  const srv = http.createServer(function (req, res) {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      hits.push({ url: req.url, cookie: req.headers.cookie || '', body: body });
      if (req.url === '/login') {
        res.setHeader('Set-Cookie', ['sid=abc123; Path=/', 'remember_me=zzz; Path=/; Max-Age=600']);
        res.end(JSON.stringify({ code: 0, msg: '登录成功' }));
      } else if (req.url === '/whoami') {
        res.end(JSON.stringify({ code: 0, cookie: req.headers.cookie || '' }));
      } else if (req.url === '/redirect-out') {
        res.writeHead(302, { Location: 'https://evil.example.com/leak' });
        res.end();
      } else if (req.url === '/upload') {
        res.end(JSON.stringify({ code: 0, got: JSON.parse(body || '{}') }));
      } else {
        res.end(JSON.stringify({ code: 0, url: req.url }));
      }
    });
  });
  await new Promise(function (r) { srv.listen(0, '127.0.0.1', r); });
  const PORT = srv.address().port;
  const BASE = 'http://127.0.0.1:' + PORT;

  const denied = await api.dispatch(ID, 'net.request', { url: 'https://example.com/api' });
  check('没批过的域名一律拒', denied.ok === false && /不在你为插件批准的域名/.test(denied.error || ''), denied.error);
  check('明文 http 指向非本机被拒',
    /必须是 https/.test(Net.validate('http://team.example.com/api', ['team.example.com']).error));
  check('https + 已批域名放行', Net.validate('https://team.example.com/api', ['team.example.com']).ok === true);
  check('带端口的 https 被拒', Net.validate('https://team.example.com:8443/api', ['team.example.com']).ok === false);

  /* ★ 清单写成 ["*"]（地址由使用者在插件页里自己填）之后，域名这一栏不再挡人，
   *   出口只剩三条：必须 https、必须标准端口、明文只认回环。这三条一条都不能随通配一起放开。 */
  check('通配放行任意 https 主机（使用者填哪儿就打哪儿）',
    Net.validate('https://any.provider.example/v1/chat', ['*']).ok === true);
  check('★ 通配 ≠ 放行明文：公网 http 照样拒',
    /明文 http 只允许本机/.test(Net.validate('http://any.provider.example/v1', ['*']).error || ''),
    Net.validate('http://any.provider.example/v1', ['*']).error);
  check('★ 通配 ≠ 放行任意端口：非 443 仍拒',
    /只允许标准 https 端口/.test(Net.validate('https://any.provider.example:8443/v1', ['*']).error || ''),
    Net.validate('https://any.provider.example:8443/v1', ['*']).error);
  check('回环明文在通配下仍然可用（局域网自建站不受这次改动影响）',
    Net.validate('http://127.0.0.1:' + PORT + '/login', ['*']).ok === true);

  const login = await api.dispatch(ID, 'net.request', {
    url: BASE + '/login', method: 'POST', body: { username: '100010001', password: 'pw' }
  });
  check('loopback 已批 → 登录请求成功', login.ok === true && login.json && login.json.code === 0,
    JSON.stringify(login.json || login.error));
  const who = await api.dispatch(ID, 'net.request', { url: BASE + '/whoami' });
  check('★ 会话 Cookie 由宿主代管并自动带上', /sid=abc123/.test(who.json && who.json.cookie || ''), who.json && who.json.cookie);
  const kvCookies = await api.dispatch(ID, 'kv.get', {});
  check('★ Cookie 不会漏进插件自己的 kv 存储',
    !/sid=abc123/.test(JSON.stringify(kvCookies.value || {})));
  const cookieFile = path.join(TMP, 'plugin-data', ID + '.cookies.json');
  check('Cookie 存在宿主单独的文件里', fs.existsSync(cookieFile) && /sid/.test(fs.readFileSync(cookieFile, 'utf8')));

  /* ★ 卸载要把活登录凭证一起带走 —— 单独用一个会消失的插件验，别拿主插件做实验 */
  const GONE = 'df.gone';
  check('装一个待卸载的联网插件', installOf(host, pkg(NET_SCOPES, { id: GONE, name: '会被卸载' }), NET_SCOPES).ok === true);
  host.setEnabled(GONE, true);
  check('★ 确认是按插件各算各的：新装的联网包不继承别家的确认', host.consentOk(GONE) === false);
  host.grantConsent(GONE, CONSENT.sentence);
  await api.dispatch(GONE, 'kv.set', { key: 'site', value: 'https://127.0.0.1' });
  await api.dispatch(GONE, 'net.request', { url: BASE + '/login' });
  const goneCookie = path.join(TMP, 'plugin-data', GONE + '.cookies.json');
  const goneKv = path.join(TMP, 'plugin-data', GONE + '.json');
  check('卸载前 Cookie 与 kv 都已落盘', fs.existsSync(goneCookie) && fs.existsSync(goneKv));
  check('卸载插件', host.remove(GONE).ok === true);
  check('★ 卸载后插件目录已清空', !fs.existsSync(path.join(TMP, 'plugins', GONE)));
  check('★ 卸载后 kv 存储已清空', !fs.existsSync(goneKv));
  check('★ 卸载后会话 Cookie 也已清空', !fs.existsSync(goneCookie));
  check('卸载后再调用一律拒', (await api.dispatch(GONE, 'host.info', {})).ok === false);

  const up = await api.dispatch(ID, 'net.request', { url: BASE + '/upload', method: 'POST', body: { matches: 7, win_rate: 71.8 } });
  check('JSON 请求体原样送达', up.ok === true && up.json && up.json.got && up.json.got.matches === 7);

  const red = await api.dispatch(ID, 'net.request', { url: BASE + '/redirect-out' });
  check('★ 重定向到没批的主机被拒', red.ok === false && /不在你为插件批准的域名/.test(red.error || ''), red.error);
  check('重定向不会把 Cookie 带去外站', !hits.some(function (h) { return h.url === '/leak'; }));

  const head = await api.dispatch(ID, 'net.request', { url: BASE + '/x', headers: { Cookie: 'sid=hijack', Host: 'evil' } });
  check('★ 插件塞的 Cookie/Host 头被忽略', head.ok === true && !/hijack/.test(hits[hits.length - 1].cookie),
    head.ok ? hits[hits.length - 1].cookie : head.error);

  let throttled = '';
  for (let i = 0; i < 24; i++) {
    const r = await api.dispatch(ID, 'net.request', { url: BASE + '/ping' });
    if (!r.ok && /过于频繁/.test(r.error || '')) { throttled = r.error; break; }
  }
  check('宿主侧也有请求频率闸门', /过于频繁/.test(throttled), throttled);

  /* ---------- 篡改与卸载 ---------- */
  const pf = path.join(TMP, 'plugins', ID, 'main.js');
  fs.writeFileSync(pf, 'export default { evil: 1 };');
  const after = await api.dispatch(ID, 'summary.get', { mode: 'swtwr' });
  check('★ 文件被改过之后，桥拒绝为该插件服务', after.ok === false && /校验未通过/.test(after.error || ''), after.error);
  check('★ 页面资源同样不给', host.pageAssets(ID).ok === false);
  fs.writeFileSync(pf, MAIN_JS);
  check('改回原内容后恢复可用', (await api.dispatch(ID, 'summary.get', { mode: 'swtwr' })).ok === true);

  host.setEnabled(ID, false);
  check('禁用后立刻停权', (await api.dispatch(ID, 'summary.get', { mode: 'swtwr' })).ok === false);

  const rooted = host.inspectWithBuffers(mkZip(withRoot('my-plugin', [
    { name: 'manifest.json', data: manifestOf([{ scope: 'view' }], { id: 'df.rooted', name: '带根目录' }) },
    { name: 'ui.html', data: UI_HTML },
    { name: 'main.js', data: MAIN_JS }
  ])));
  check('★ 压缩工具带进来的外层目录能压平', rooted.ok === true, rooted.message || rooted.files.map(f => f.name).join(','));

  /* ★ 事件通道两端要对得上：渲染层订阅的每个名字都必须在 preload 白名单里，
   *   白名单里也不许留着"没人订阅也没人发"的通道。
   *   起因是实测抓到的一个真缺陷：删内置 AI 时 app.js 里漏了一句 df.on('ai:delta', aiOnDelta)，
   *   指向已经不存在的函数，整条 DOMContentLoaded 绑定链在那里抛 ReferenceError 就断了 ——
   *   页面不报红、界面照常显示，只是它后面的 bindPlugins() 从此没跑（导入按钮点了没反应）。
   *   这种事 Node 侧任何测试都看不见，只能把两端的名单静态对一遍。 */
  {
    const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'shell', 'preload.js'), 'utf8');
    const allowText = (/const allow = \[([\s\S]*?)\];/.exec(preloadSrc) || [, ''])[1];
    const allow = (allowText.match(/'[^']+'/g) || []).map(function (s) { return s.slice(1, -1); });
    const uiSrc = ['app.js', 'views.js', 'charts.js', 'theme.js'].map(function (f) {
      return fs.readFileSync(path.join(__dirname, '..', 'ui', 'js', f), 'utf8');
    }).join('\n');
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'shell', 'main.js'), 'utf8');
    const subs = {}, emits = {};
    let mm;
    const RE_SUB = /df\.on\(\s*'([^']+)'/g;
    while ((mm = RE_SUB.exec(uiSrc))) subs[mm[1]] = 1;
    const RE_EMIT = /emit\(\s*'([^']+)'/g;
    while ((mm = RE_EMIT.exec(mainSrc))) emits[mm[1]] = 1;
    check('★ 渲染层订阅的每个事件名都在 preload 白名单里',
      Object.keys(subs).every(function (c) { return allow.indexOf(c) !== -1; }),
      Object.keys(subs).filter(function (c) { return allow.indexOf(c) === -1; }).join(','));
    check('★ 白名单里没有"没人订阅也没人发"的通道（删功能要连通道一起删）',
      allow.every(function (c) { return subs[c] || emits[c]; }),
      allow.filter(function (c) { return !subs[c] && !emits[c]; }).join(','));
    check('★ 插件的流式回包只有 plugin:evt 这一条通道，没有 ai* 残留',
      allow.indexOf('plugin:evt') !== -1 &&
      !allow.some(function (c) { return /^ai/.test(c); }), allow.join(','));
  }

  srv.close();
  rmrf(TMP);
  console.log('\n' + '='.repeat(64));
  console.log(fail === 0 ? '插件桥：全部通过' : fail + ' 项失败');
  console.log('='.repeat(64));
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('测试异常：', e);
  process.exit(1);
});
