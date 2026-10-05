#!/usr/bin/env node
/* probe-plugin-layout.js — 用真实 Electron 量插件页与宿主面板在窄屏下会不会破版
 *
 * 为什么要有这个文件：插件页跑在 `<iframe sandbox="allow-scripts">` 里，
 * 没有 allow-same-origin，父页面脚本读不到它的 DOM —— 所以"390px 下这张 20 项表格破没破版"
 * 这件事在浏览器工具里根本量不出来（坑 21：三层各自全绿，接缝处是坏的）。
 *
 * 做法（手册 §7 坑 17 的配方）：把 dist 的运行时**硬链接**到临时目录（200MB 瞬间完成、不占空间），
 * 只把 resources/app 换成一个探针应用，它按 360 / 390 / 720 / 900 四档宽度，
 * 用真实排版引擎加载"宿主注入后的插件页"，量 scrollWidth 与越界元素。
 * 插件的 main.js 也真跑（用一个假 DFPlugin 桥喂汇总数据并点「先看会上传什么」），
 * 因为**表格内容是点出来的**，只量静态骨架等于没量。
 *
 * 五份页面：demo / team（两个参考插件）、ai（本版最宽的一页：摘要 pre + 代号标签 +
 * 模型回答里的六列宽表，走一遍假流式才画得出来）、vocab（plugin-base.css 词表自检页）、
 * gate（宿主自己的外发确认面板，markup 直接从真实 ui/index.html 切，穿 app.css）。
 *
 * 两条尺度：① 宽表唯一的容身处是 .pl-scroll，裸表撑破页面就红；
 * ② 插件侧可点目标在 ≤720 下不低于 34px。gate 那一档只报数不判红 ——
 *   实测它自身在 360px 下不破版，挡在移动端前面的是桌面外壳（主窗 minWidth:1080 + 常驻侧栏），
 *   那句话要写进文档，而不是靠探针假装已经适配。
 *
 * 用法：node tools/probe-plugin-layout.js            # 正常应当 0 失败
 *       node tools/probe-plugin-layout.js --widen    # 反向验证：每档撑宽都必须被报出来，漏一档就退 1
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TMP = path.join(os.tmpdir(), 'df-plugin-layout-probe');
const WIDEN = process.argv.indexOf('--widen') !== -1;
const WIDTHS = [360, 390, 720, 900];

const PLUGINS = [
  { key: 'demo', dir: 'plugins-src/demo-summary', click: null },
  { key: 'team', dir: 'plugins-src/team-stats', click: 'peek' },
  /* ★ AI 分析页：本版最宽的一页。摘要是一整块 pre、代号一排标签、模型回答里还会有 Markdown 表格，
   *   而表格只有真喂一段流式回答才会出现 —— 所以这页既要点「生成摘要」也要走一遍 SSE。 */
  { key: 'ai', dir: 'plugins-src/ai-analyst', click: 'btnBuild', answer: true },
  /* ★ 词表自检页：不是插件，是把 plugin-base.css 的响应式规则单独量一遍。
   *   两个参考插件都没有 .pl-cols（两栏披露今天画在宿主面板里），
   *   不补这一页，那份 CSS 的窄屏断言就没有任何真实消费者。 */
  { key: 'vocab', dir: null, click: null },
  /* ★ 宿主面板：外发确认那块（.gate-*）长在 app.css 里，不属于任何插件页，
   *   markup 直接从真实 ui/index.html 切出来量，绝不在探针里另抄一份会漂移的假面板。 */
  { key: 'gate', dir: null, click: null, host: true }
];

function die(msg) { console.error('探针没能跑起来：' + msg); process.exit(2); }

/* ---------- 1) 组探针应用 ---------- */
const distApp = (function () {
  if (!fs.existsSync(DIST)) die('还没有 dist/ —— 先 node build.js');
  const hit = fs.readdirSync(DIST).map(function (n) { return path.join(DIST, n); })
    .filter(function (p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } })
    .filter(function (p) { return fs.existsSync(path.join(p, 'resources', 'app')); })[0];
  if (!hit) die('dist 下没找到带 resources/app 的运行时目录');
  return hit;
})();
/* 注意：跑的是**临时目录里那份 exe**，不是 dist 里的。
 * Electron 按 exe 自己所在位置找 resources/app —— 用 dist 那份会启动真正的出厂应用，
 * 探针应用（临时目录里的 resources/app）就永远轮不到。 */
const EXE_NAME = (function () {
  const hit = fs.readdirSync(distApp).filter(function (n) { return /\.exe$/i.test(n); })[0];
  if (!hit) die('dist 运行时里没有 exe');
  return hit;
})();

rmrf(TMP);
fs.mkdirSync(TMP, { recursive: true });
/* 运行时按文件硬链接过来；resources/app 例外（那是探针自己的，必须是真目录） */
(function linkTree(src, dst) {
  fs.readdirSync(src).forEach(function (name) {
    const s = path.join(src, name), d = path.join(dst, name);
    if (s === path.join(distApp, 'resources', 'app')) return;
    const st = fs.statSync(s);
    if (st.isDirectory()) { fs.mkdirSync(d, { recursive: true }); linkTree(s, d); }
    else { try { fs.linkSync(s, d); } catch (e) { fs.copyFileSync(s, d); } }
  });
})(distApp, TMP);

const EXE = path.join(TMP, EXE_NAME);
if (!fs.existsSync(EXE)) die('临时目录里没有 exe（硬链接没成功？）：' + EXE);

const APP = path.join(TMP, 'resources', 'app');
rmrf(APP);
fs.mkdirSync(path.join(APP, 'pages'), { recursive: true });
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({
  name: 'df-plugin-layout-probe', version: '1.0.0', main: 'probe-main.js'
}, null, 2));

const THEME_CSS = fs.readFileSync(path.join(ROOT, 'ui', 'css', 'theme.css'), 'utf8');
const BASE_CSS = fs.readFileSync(path.join(ROOT, 'ui', 'css', 'plugin-base.css'), 'utf8');
const APP_CSS = fs.readFileSync(path.join(ROOT, 'ui', 'css', 'app.css'), 'utf8');
fs.writeFileSync(path.join(APP, 'pages', 'theme.css'), THEME_CSS);
fs.writeFileSync(path.join(APP, 'pages', 'plugin-base.css'), BASE_CSS);
fs.writeFileSync(path.join(APP, 'pages', 'app.css'), APP_CSS);

/* 宿主那块外发确认面板：直接从真实 ui/index.html 里切，切不到就停 —— 静默量一份空页等于没量 */
function gateHtmlFromIndex() {
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const a = src.indexOf('<div class="panel" id="pluginConsent"');
  const b = src.indexOf('<div class="plugin-frame-wrap"', a);
  if (a < 0 || b < 0) die('ui/index.html 里找不到外发确认面板或插件页容器的锚点，探针的 host 档没法量');
  const panel = src.slice(a, b).trim();
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>宿主确认面板</title></head><body>' +
    panel + '</body></html>';
}

/* 词表自检页：只用 .pl-*，不写一条私有样式 —— 它量的是 plugin-base.css 本身 */
const VOCAB_HTML = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>词表自检</title></head><body>',
  '<div id="app">',
  '<div class="pl-head"><h3 class="pl-title">共享词表自检页</h3>',
  '<span class="pl-sub">这一页不属于任何插件，只把 .pl-* 每一项都摆出来量一遍响应式</span></div>',
  '<div class="pl-cols">',
  '  <div><h4 class="pl-sec">会发出去</h4><ul class="pl-list"><li>20 项聚合指标</li><li>覆盖的时间区间</li><li>游戏 ID（可选）</li></ul></div>',
  '  <div><h4 class="pl-sec">不会发出去</h4><ul class="pl-list no"><li>逐场明细</li><li>队友与对手的名字</li><li>本机数据文件</li></ul></div>',
  '</div>',
  '<div class="pl-card"><h4 class="pl-sec">配置项</h4>',
  '  <div class="pl-row"><span class="pl-lbl">站点地址</span><input placeholder="https://你的域名/战队目录"></div>',
  '  <div class="pl-row"><span class="pl-lbl">模式</span><select><option>胜者为王</option><option>全面战场</option></select></div>',
  '  <div class="pl-row"><span class="pl-lbl">备注</span><textarea rows="2" placeholder="一段会被一起发出去的长文本，看看窄屏下它会不会撑破版面"></textarea></div>',
  '  <div class="pl-btns"><button class="pl-btn">普通按钮</button><button class="pl-btn primary">主操作</button><button class="pl-btn danger">危险操作</button></div>',
  '</div>',
  '<div class="pl-card"><div class="pl-need">请在下面的输入框里逐字输入这句话：</div>',
  '<div class="pl-consent-text">我已确认，并将数据上传到我信任的战队网站</div></div>',
  '<div class="pl-card"><h4 class="pl-sec">本地预览</h4><pre class="pl-pre">{ "matches": 36, "winRate": 52.78, "kd": 1.83, "rating": 84.6, "occupyPerMatch": 3.11, "rescuePerMatch": 2.67 }</pre></div>',
  /* v1.7.0 新增的几组词汇：分段、开关、代号标签、结果块（宽表）、历史行、骨架 */
  '<div class="pl-card"><h4 class="pl-sec">发送范围与开关</h4>',
  '  <div class="pl-row"><div class="pl-seg"><button class="on">整体深度报告</button><button>单场点评</button></div></div>',
  '  <div class="pl-row"><span class="pl-lbl">同步之后</span><label class="pl-switch"><input type="checkbox">提醒我出日报</label></div>',
  '  <div class="pl-tags"><span class="pl-note">代号对照</span><span class="pl-tag">队友甲-12</span><span class="pl-tag">队友乙-34</span><span class="pl-tag mute">对手丙-56</span></div>',
  '</div>',
  '<div class="pl-card"><h4 class="pl-sec">分析结果</h4>',
  '  <div class="pl-answer"><h3>总体判断</h3><p>这份摘要覆盖 <b>18 场</b>有效样本，得分中枢在 1900 附近。</p>',
  '  <div class="pl-scroll"><table><thead><tr><th>维度</th><th>我的场均</th><th>全队均值</th><th>相对差</th><th>置信度</th><th>建议动作</th></tr></thead>',
  '  <tbody><tr><td>占点参与</td><td>412 分</td><td>501 分</td><td>-17.8%</td><td>样本 18 场</td><td>推进阶段先落点再找击杀</td></tr>',
  '  <tr><td>救治贡献</td><td>63 次</td><td>48 次</td><td>+31.2%</td><td>样本 18 场</td><td>保持，医疗兵位优先</td></tr></tbody></table></div>',
  '  <blockquote>样本不足 20 场时以上结论按「参考」看待，不要当定论。</blockquote></div>',
  '  <div class="pl-hist"><span class="pl-hist-k">09-20 21:14</span><span class="pl-hist-t">整体深度报告 · 12.4 KB</span><span class="pl-hist-x">deepseek-chat</span></div>',
  '  <div class="pl-hist on"><span class="pl-hist-k">09-19 08:02</span><span class="pl-hist-t">单场点评 · 电视台 · 负</span><span class="pl-hist-x">按当时口径</span></div>',
  '  <div class="pl-skeleton">正在生成…</div>',
  '</div>',
  '<p class="pl-empty">这里还没有内容。</p>',
  '</div></body></html>'
].join('\n');

PLUGINS.forEach(function (p) {
  const isPlugin = !!p.dir;
  const dir = isPlugin ? path.join(ROOT, p.dir) : null;
  let html = !isPlugin ? (p.host ? gateHtmlFromIndex() : VOCAB_HTML)
    : fs.readFileSync(path.join(dir, 'ui.html'), 'utf8');
  const mainJs = isPlugin ? fs.readFileSync(path.join(dir, 'main.js'), 'utf8') : '';
  /* 反向验证：把整页撑宽。注意不能只撑表格 —— 表格在 .pl-scroll 里，
   * 撑它只会让容器内部滚动，页面本身不破版，那样探针"没报红"反而是对的。 */
  if (WIDEN) html = html.replace('</head>', '<style>body{min-width:900px}</style></head>');
  /* 宿主面板穿 app.css，插件页穿宿主注入的 plugin-base.css —— 两套词汇各量各的 */
  const head = '<link rel="stylesheet" href="theme.css">' +
    (p.host ? '<link rel="stylesheet" href="app.css">' : '<link rel="stylesheet" href="plugin-base.css">');
  html = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, function (m) { return m + head; })
    : head + html;
  const tail = '<script>window.__PROBE=' +
    JSON.stringify({ plugin: p.key, click: p.click || '', answer: !!p.answer }) + ';</script>' +
    '<script src="probe-shim.js"></script>' +
    (isPlugin ? '<script src="' + p.key + '.main.js"></script>' : '');
  html = /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, function () { return tail + '</body>'; })
    : html + tail;
  fs.writeFileSync(path.join(APP, 'pages', p.key + '.html'), html);
  if (isPlugin) fs.writeFileSync(path.join(APP, 'pages', p.key + '.main.js'), mainJs);
});

/* 假桥：只喂数据，不参与判定 —— 量的是排版 */
fs.writeFileSync(path.join(APP, 'pages', 'probe-shim.js'), [
  '(function(){',
  '  var cfg = window.__PROBE || {};',
  '  var clickId = cfg.click || "";',
  '  var def = null, hooks = [];',
  '  var SUM = { ok: true, mode: "swtwr",',
  '    span: { from: 0, to: 1, fromText: "2026-08-01", toText: "2026-09-20", days: 50 },',
  '    totals: { matches: 36, wins: 19, winRate: 52.78, kd: 1.83, rating: 84.6, avgScore: 1234.5,',
  '      totalScore: 44442, kills: 812, deaths: 443, assists: 210, rescueTotal: 96, rescuePerMatch: 2.67,',
  '      occupyPerMatch: 3.11, revives: 44, sites: 112, quits: 2, quitRate: 5.56, duration: 41234 }',
  '      ,',
  '    streak: { bestWin: 5, bestLose: 2, current: 1 },',
  '    windows: { last10: { n: 10, winRate: 60 }, last20: { n: 20, winRate: 55 }, last30: { n: 30, winRate: 53 } },',
  '    avgRating: 84.6 };',
  '  /* 一份形状逼真的摘要：长行 + 表格 + 代号，pre 与标签都要在 360px 下各就各位 */',
  '  var DIGEST = ["【《三角洲行动》全面战场 · 个人战绩聚合摘要】",',
  '    "范围：近 50 天 · 全部模式 · 36 场",',
  '    "■ 总体：胜率 52.78% · K/D 1.83 · 场均得分 1234.5 · 平均评分 84.6",',
  '    "■ 参与：占点 3.11/场 · 救治 2.67/场 · 复活 1.22/场 · 撤离点位 3.1/场",',
  '    "■ 连战：最长连胜 5 · 最长连败 2 · 当前 1",',
  '    "| 地图 | 场次 | 胜率 | 场均得分 | 占点 | 救治 |",',
  '    "|---|---|---|---|---|---|",',
  '    "| 瓦尔扎霍德 | 9 | 66.7% | 1421 | 4.2 | 1.9 |",',
  '    "| 电视台 | 7 | 42.9% | 1088 | 2.6 | 3.4 |",',
  '    "■ 同场代号（不含真实昵称）：队友甲-12、队友乙-34、对手丙-56 …"].join("\\n");',
  '  var ROOMS = { ok: true, rows: [',
  '    { handle: "m1", at: "09-20 21:14", map: "电视台", swtwr: true, commander: true, winner: false },',
  '    { handle: "m2", at: "09-20 18:02", map: "瓦尔扎霍德", swtwr: false, commander: false, winner: true },',
  '    { handle: "m3", at: "09-19 22:41", map: "休息站", swtwr: true, commander: false, winner: true }',
  '  ] };',
  '  window.DFPlugin = {',
  '    register: function (d) { def = d; },',
  '    on: function (f) { hooks.push(f); },',
  '    fire: function (ev, data) { hooks.forEach(function (f) { try { f(ev, data); } catch (e) {} }); },',
  '    calls: [],',
  '    call: function (m, a) {',
  '      window.DFPlugin.calls.push(m);',
  '      a = a || {};',
  '      if (m === "summary.get") return Promise.resolve(SUM);',
  '      if (m === "ai.digest") return Promise.resolve(a.list ? ROOMS',
  '        : { ok: true, scope: a.scope || "global", text: DIGEST, bytes: DIGEST.length * 3,',
  '          estTokens: DIGEST.length, weights: "权重 得分 35 / 占点 20 / 击杀 25 / 救治 10 / 阵亡 10",',
  '          aliases: [{ alias: "队友甲-12", side: "ally" }, { alias: "对手丙-56", side: "enemy" }],',
  '          dropped: { encounters: 12 } });',
  '      if (m === "host.info") return Promise.resolve({ ok: true, plugin: { id: "probe", version: "1.0.0" },',
  '        consentOk: true, needsConsent: true, account: { slot: "a1", name: "探针号" } });',
  '      if (m === "legacy.check") return Promise.resolve({ ok: true, hasAnything: false });',
  '      /* 让「同步后提醒出日报」那块卡片也进窄屏测量：它平时只有取到待办时才出现，不喂就等于没量过 */',
  '      if (m === "trigger.take") return Promise.resolve(cfg.plugin === "ai"',
  '        ? { ok: true, trigger: { count: 2, at: Date.now() - 120000, info: { slot: "a1", inserted: 1, matches: 37 } } }',
  '        : { ok: true, trigger: null });',
  '      return Promise.resolve({ ok: true });',
  '    },',
  '    kv: { get: function () { return Promise.resolve(null); }, set: function () { return Promise.resolve({}); } },',
  '    secret: { get: function () { return Promise.resolve(null); }, set: function () { return Promise.resolve({}); } }',
  '  };',
  '  /* 流式回答：点完按钮之后自己走一遍 net.*，把带宽表的结果画出来。',
  '     这张表是本页最容易撑破 360px 的东西，不喂它就只量到骨架。 */',
  '  function feedAnswer() {',
  '    var t = def && def.t && def.t.state;',
  '    if (!t) return;',
  '    t.streamId = "probe"; t.status = 200; t.contentType = "text/event-stream";',
  '    t.sseBuf = ""; t.text = ""; t.streaming = true;',
  '    window.DFPlugin.fire("net.open", { streamId: "probe", status: 200, contentType: "text/event-stream" });',
  '    var md = "### 总体判断\\n\\n这份摘要覆盖 **18 场**，得分中枢在 1900 附近。\\n\\n' +
      '| 维度 | 我的场均 | 全队均值 | 相对差 | 置信度 | 建议动作 |\\n' +
      '|---|---|---|---|---|---|\\n' +
      '| 占点参与 | 412 分 | 501 分 | -17.8% | 样本 18 场 | 推进阶段先落点再找击杀 |\\n' +
      '| 救治贡献 | 63 次 | 48 次 | +31.2% | 样本 18 场 | 保持，医疗兵位优先 |\\n\\n' +
      '> 样本不足 20 场，以上按参考看待。\\n";',
  '    window.DFPlugin.fire("net.data", { streamId: "probe",',
  '      text: "data: " + JSON.stringify({ choices: [{ delta: { content: md } }] }) + "\\n\\n" });',
  '    window.DFPlugin.fire("net.end", { streamId: "probe", ok: true, bytes: md.length, ms: 800 });',
  '  }',
  '  function run(){',
  '    var root = document.getElementById("app") || document.body;',
  '    if (def && typeof def.mount === "function") { try { def.mount(root, {}); } catch (e) { window.__mountError = String(e); } }',
  '    /* 表格是点出来的：不点就只量到骨架 */',
  '    var b = clickId && document.getElementById(clickId);',
  '    if (b) { try { b.click(); } catch (e) { window.__clickError = String(e); } }',
  '    if (cfg.answer) setTimeout(feedAnswer, 180);',
  '    setTimeout(function () {',
  '      var w = window.innerWidth, over = [];',
  '      Array.prototype.forEach.call(document.querySelectorAll("body *"), function (el) {',
  '        var r = el.getBoundingClientRect();',
  '        if (r.width && r.right > w + 1) {',
  '          var scrollable = false, pp = el.parentElement;',
  '          while (pp) { var cs = getComputedStyle(pp); if (/(auto|scroll)/.test(cs.overflowX)) { scrollable = true; break; } pp = pp.parentElement; }',
  '          if (!scrollable) over.push(el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "") + " right=" + Math.round(r.right));',
  '        }',
  '      });',
  '      var cols = document.querySelector(".pl-cols, .gate-cols");',
  '      var scroll = [];',
  '      Array.prototype.forEach.call(document.querySelectorAll(".pl-scroll"), function (el) {',
  '        var t = el.querySelector("table");',
  '        scroll.push({ id: el.id || "", box: Math.round(el.getBoundingClientRect().width),',
  '          inner: t ? Math.round(t.getBoundingClientRect().width) : 0,',
  '          ox: getComputedStyle(el).overflowX, oxParent: getComputedStyle(el.parentElement).overflowX });',
  '      });',
  '      window.__report = {',
  '        innerWidth: w, docScrollWidth: document.documentElement.scrollWidth,',
  '        bodyScrollWidth: document.body.scrollWidth,',
  '        overflow: over.slice(0, 8), overflowCount: over.length,',
  '        colsPresent: !!cols,',
  '        colsColumns: cols ? getComputedStyle(cols).gridTemplateColumns.split(" ").length : 0,',
  '        scrollers: scroll,',
  '        answerTable: (function(){ var t = document.querySelector(".pl-answer table"); if (!t) return null;',
  '          var p = t.parentElement, sc = null;',
  '          while (p) { if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) { sc = p; break; } p = p.parentElement; }',
  '          var r = t.getBoundingClientRect();',
  '          return { table: Math.round(r.width), right: Math.round(r.right),',
  '            holder: sc ? String(sc.className || sc.tagName) : "" }; })(),',
  '        msg: (document.getElementById("msg") || {}).textContent || "",',
  '        calls: (window.DFPlugin.calls || []).join(","),',
  '        minTap: (function(){ var n = 0, bad = [];',
  '          Array.prototype.forEach.call(document.querySelectorAll("button,input,select"), function (el) {',
  '            /* 复选框的可点区域是整条 label（.pl-switch 窄屏 40px 高），量本体没意义 */',
  '            if (el.type === "checkbox") return;',
  '            /* 隐藏的控件（display:none 的折叠区、还没出现的按钮）量高度没意义 */',
  '            if (!el.offsetHeight) return;',
  '            n++; if (el.offsetHeight < 34) bad.push(el.tagName.toLowerCase() +',
  '              (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string"',
  '                ? "." + el.className.trim().split(/\\s+/).join(".") : "") + "=" + el.offsetHeight); });',
  '          return { total: n, short: bad.length, which: bad.slice(0, 5).join(" ") }; })(),',
  '        mountError: window.__mountError || "", clickError: window.__clickError || "",',
  '        rows: document.querySelectorAll("#preview tbody tr, #mine tbody tr").length',
  '      };',
  '    }, 700);',
  '  }',
  '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();',
  '})();'
].join('\n'));

fs.writeFileSync(path.join(APP, 'probe-main.js'), [
  'const { app, BrowserWindow } = require("electron");',
  'const fs = require("fs");',
  'const path = require("path");',
  'const WIDTHS = ' + JSON.stringify(WIDTHS) + ';',
  'const KEYS = ' + JSON.stringify(PLUGINS.map(function (p) { return p.key; })) + ';',
  'const OUT = process.env.PROBE_OUT || path.join(require("os").tmpdir(), "df-plugin-layout-probe", "report.json");',
  'const TRACE = OUT + ".trace";',
  'function tr(s) { try { fs.appendFileSync(TRACE, s + "\\n"); } catch (e) {} }',
  'tr("start " + process.versions.electron);',
  'app.whenReady().then(async function () {',
  '  tr("ready");',
  '  const out = [];',
  '  try {',
  '    const win = new BrowserWindow({ show: false, width: 360, height: 780,',
  '      webPreferences: { contextIsolation: true, nodeIntegration: false } });',
  '    tr("window");',
  '    for (const w of WIDTHS) {',
  '      win.setBounds({ x: 0, y: 0, width: w, height: 780 });',
  '      for (const k of KEYS) {',
  '        const f = path.join(__dirname, "pages", k + ".html");',
  '        await win.loadFile(f);',
  '        tr("load " + k + "@" + w);',
  '        let rep = null;',
  '        for (let i = 0; i < 40; i++) {',
  '          rep = await win.webContents.executeJavaScript("window.__report || null");',
  '          if (rep) break;',
  '          await new Promise(function (r) { setTimeout(r, 100); });',
  '        }',
  '        out.push({ plugin: k, width: w, report: rep });',
  '      }',
  '    }',
  '  } catch (e) {',
  '    tr("error " + ((e && e.stack) || e));',
  '    out.push({ error: String((e && e.message) || e), partial: out.length });',
  '  }',
  '  try { fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); } catch (e) { tr("write-fail " + e); }',
  '  tr("done");',
  '  app.quit();',
  '}).catch(function (e) {',
  '  tr("ready-error " + ((e && e.stack) || e));',
  '  try { fs.writeFileSync(OUT, JSON.stringify({ error: String((e && e.message) || e) })); } catch (x) {}',
  '  app.quit();',
  '});'
].join('\n'));

/* ---------- 2) 跑 ---------- */
const OUT = path.join(TMP, 'report.json');
try { fs.unlinkSync(OUT); } catch (e) {}
const env = Object.assign({}, process.env, {
  PROBE_OUT: OUT,
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
});
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(EXE, ['--no-sandbox'], { env: env, cwd: TMP, timeout: 240000 });
if (!fs.existsSync(OUT)) {
  die('探针没有产出报告（spawn status=' + r.status + '）。GUI exe 从脚本环境直接后台拉起不会有任何输出，' +
    '这里用的是 spawnSync 同步等退出；先检查 dist/ 是否是可运行的完整包。');
}
const rep = JSON.parse(fs.readFileSync(OUT, 'utf8'));
if (rep.error) die('探针内部报错：' + rep.error);

/* ---------- 3) 判 ---------- */
let fail = 0;
let brokeFound = 0;
function check(name, ok, detail) {
  if (!ok) fail++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  -> ' + detail : ''));
}
console.log(WIDEN
  ? '反向验证模式：这一页被故意撑宽了 —— PASS = 探针看得见破版，FAIL = 探针是瞎的'
  : '插件页窄屏实测（真实 Electron 排版）');
const expectBreak = WIDEN;
rep.forEach(function (row) {
  const b = row.report;
  if (!b) { check(row.plugin + ' @' + row.width + ' 没量到（探针挂了）', false); return; }
  const label = row.plugin + ' @' + row.width;
  if (b.mountError || b.clickError) {
    check(label + ' 插件正文在探针里跑通', false, b.mountError || b.clickError);
    return;
  }
  const broke = b.docScrollWidth > b.innerWidth + 1 || b.overflowCount > 0;
  if (expectBreak) {
    if (broke) brokeFound++;
    check('★ ' + label + ' 撑宽之后探针必须报破版', broke,
      broke ? 'scrollWidth=' + b.docScrollWidth + ' 越界 ' + b.overflowCount + ' 个' : '没报红 —— 这个探针是假的');
  } else {
    check('★ ' + label + ' 不破版（无横向溢出）', !broke,
      'scrollWidth=' + b.docScrollWidth + '/inner=' + b.innerWidth +
      (b.overflowCount ? ' 越界：' + b.overflow.slice(0, 3).join(', ') : ''));
  }
  if (!expectBreak) {
    const BP = { gate: 920 };                       // 宿主 .gate-cols 的断点与插件词表不同
    const bp = BP[row.plugin] || 720;
    if (b.colsPresent) {
      const want = row.width <= bp ? 1 : 2;
      check(label + ' 两栏披露跟着断点走（≤' + bp + ' 单列，更宽两栏）',
        b.colsColumns === want, 'columns=' + b.colsColumns + ' 期望=' + want);
    } else if (row.plugin === 'vocab' || row.plugin === 'gate') {
      check(row.plugin + ' 这份 fixture 里必须有两栏披露块（没有就是写漏了）', false, 'colsPresent=false');
    } else {
      console.log('  —     ' + label + ' 这一页没有两栏披露块（它在宿主面板里，不在插件页内）');
    }
  }
  if (!expectBreak) (b.scrollers || []).forEach(function (s) {
    if (!s.inner) return;                       /* 还没内容的空容器不判 */
    check(label + ' #' + s.id + ' 是横向滚动容器（宽表唯一的容身处）',
      /auto|scroll/.test(s.ox), 'overflow-x=' + s.ox);
    if (row.width <= 390) {
      check('★ ' + label + ' #' + s.id + ' 里这张表在窄屏真的装不下（' + s.inner + '>' + s.box + '），靠滚动消化而不是撑破页面',
        s.inner > s.box, '容器=' + s.box + ' 表=' + s.inner);
    }
  });
  if (!expectBreak && row.plugin === 'team' && row.width === 360) {
    check('team 的 20 项表格真的被点出来了（不然量的是空壳）', b.rows >= 20,
      'rows=' + b.rows + ' 调用=' + b.calls + ' 页面回话=' + b.msg);
  }
  if (!expectBreak && row.plugin === 'ai') {
    const at = b.answerTable;
    check('★ ' + label + ' 模型回答里的宽表真的画出来了（不然这一页量的是空壳）', !!at,
      '调用=' + b.calls + ' 摘要块=' + (at ? '有表' : '无表'));
    if (at) {
      if (row.width <= 390) {
        check(label + ' 这张表在窄屏确实装不下（靠滚动消化，而不是把页面撑宽）',
          at.table > b.innerWidth - 36, '表宽=' + at.table + ' 可视=' + b.innerWidth);
      }
      check('★ ' + label + ' 宽表被横向滚动容器接着（.pl-scroll 是唯一允许的位置）',
        !!at.holder, 'holder=' + (at.holder || '无') + ' 右边界=' + at.right);
    }
  }
});
if (!expectBreak) {
  /* 点击目标这条只管插件侧：那一层跑在 iframe 里，将来竖屏外壳直接复用，所以现在就按 34px 量死。
   * 宿主自己的确认面板穿的是 app.css（桌面外壳，主窗 minWidth 1080），本条只报数不判红 ——
   * 报出来是给移动端那一版记账，不是假装这一版已经适配。 */
  const side = rep.filter(function (x) { return x.report && x.width <= 720 && x.plugin !== 'gate'; });
  check('窄屏下插件侧可点目标不低于 34px',
    side.every(function (x) { return x.report.minTap.short === 0; }),
    side.map(function (x) { return x.report.minTap.short ? x.plugin + '@' + x.width + ' ' + x.report.minTap.which : ''; })
      .filter(Boolean).join(' | ') || side.map(function (x) { return x.plugin + '@' + x.width; }).join(' '));
  const host = rep.filter(function (x) { return x.report && x.width === 360 && x.plugin === 'gate'; })[0];
  if (host) console.log('  —     宿主确认面板自身在 360px 下不破版、可点目标低于 34px 的有 ' +
    host.report.minTap.short + ' 个' +
    (host.report.minTap.short ? '（' + host.report.minTap.which + '）' : '') +
    '；挡在移动端前面的不是这块面板，是桌面外壳（主窗 minWidth 与那条侧栏）—— 移动端那一版要换的是外壳。');
}

const total = rep.length;
console.log(WIDEN
  ? (brokeFound === total && total > 0
      ? '反向验证 OK：撑宽的 ' + total + ' 档全被探针看见（每档都报了横向溢出）'
      : '★ 反向验证失败：撑宽了 ' + total + ' 档，探针只看见 ' + brokeFound + ' 档 —— 这个探针不可信')
  : (fail === 0 ? '窄屏全部通过' : fail + ' 项失败'));
process.exit(WIDEN ? (brokeFound === total && total > 0 ? 0 : 1) : (fail === 0 ? 0 : 1));

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
