#!/usr/bin/env node
/* probe-app-layout.js — 用真实 Electron 量「整个软件外壳」在竖屏与平板宽度下会不会破版
 *
 * 为什么要有这个文件（而不是量插件页那个）：
 *   tools/probe-plugin-layout.js 量的是插件页与宿主确认面板，它当年如实记下过一句话 ——
 *   「挡在移动端前面的不是那块面板，是桌面外壳（主窗 minWidth:1080 + 那条常驻侧栏）」。
 *   现在要做安卓竖屏，要换的正是这个外壳，所以量测必须从外壳这一层做起。
 *   渲染层没有 DOM 测试台（五套 Node 测试完全不含 ui/js/*），界面缺陷只能真开窗口量。
 *
 * 跑法：
 *   node test/preview-server.js 起在 8770（本脚本会自己拉，端口已被占用就直接复用 ——
 *   它是每次请求现读 ui/，所以复用不会量到旧代码）；
 *   然后把 dist 的运行时**硬链接**到临时目录（200MB 瞬间、不占空间），
 *   只把 resources/app 换成探针应用，按 360 / 390 / 720 / 900 / 1180 / 1440 六档宽度，
 *   用真实排版引擎逐页点过去量。
 *
 * 五类判定（都是"看一眼就会遇到、Node 测试全绿却照样坏"的那类）：
 *   ① 不破版：没有任何元素的右边界越过视口且祖先里没有横向滚动容器；
 *   ② 图表拿得到宽度：.chart 容器宽 < 40 就是坑 13（.content 一横向溢出会把图表挤成 0 宽、静默不画）；
 *   ③ ★ 不许靠藏内容适配：每一页可见的 .panel / .chart / table / 数据行数，
 *      必须和 1440 那一档一模一样 —— 少一个就红。这是"内容 UI 都保持不变"的可执行版本；
 *   ④ 竖屏外壳本身：抽屉默认关着且完全在屏外、那颗开关可点高度 ≥40、内容区拿回整幅宽度；
 *   ⑤ 手指不是鼠标：≤900 这一档所有可见可点目标不低于 40px。
 *
 * 用法：node tools/probe-app-layout.js            # 正常应当 0 失败
 *       node tools/probe-app-layout.js --widen    # 反向验证：把整页撑宽，每一档都必须报破版
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TMP = path.join(os.tmpdir(), 'df-app-layout-probe');
const WIDEN = process.argv.indexOf('--widen') !== -1;
/* 只量几档时用的开关：调竖屏筛选栏那种一处布局，全跑 80 个组合太慢（一次三分多钟）。
 * 不带这两个参数时行为与以前完全一致。 */
const only = function (name) {
  const a = process.argv.filter(function (s) { return s.indexOf(name) === 0; })[0];
  return a ? a.slice(name.length).split(',').filter(Boolean) : null;
};
const BASE_URL = 'http://127.0.0.1:8770/';
const ALL_WIDTHS = [360, 390, 720, 900, 1180, 1440];
const WIDTHS = (only('--widths=') || ALL_WIDTHS).map(Number);
const PHONE = 900;
/* 12 页全点。sandbox / plugin 两页只量外壳与溢出（它们的内容是外站与沙箱 iframe，
 * 探针没有 webviewTag，插件页也要真装过包才有内容 —— 那两页各自的窄屏量测在插件探针里） */
const ALL_VIEWS = ['overview', 'winrate', 'matches', 'detail', 'maps', 'classes',
  'encounters', 'rhythm', 'settings', 'about', 'sandbox', 'plugin'];
const VIEWS = only('--views=') || ALL_VIEWS;

function die(msg) { killSpawned(); console.error('探针没能跑起来：' + msg); process.exit(2); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function get(url) {
  return new Promise(function (resolve) {
    const req = http.get(url, function (res) {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', function () { resolve(0); });
    req.setTimeout(2500, function () { req.destroy(); resolve(-1); });
  });
}

/* ---------- 0) 预览服务：已在跑就复用，没在跑就自己拉 ---------- */
let spawned = null;
(async function main() {
  if (await get(BASE_URL) === 200) {
    console.log('· 复用已在跑的预览服务（127.0.0.1:8770）');
  } else {
    spawned = spawn(process.execPath, [path.join(ROOT, 'test', 'preview-server.js')],
      { cwd: ROOT, stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      if (await get(BASE_URL) === 200) break;
      if (i === 39) { killSpawned(); die('预览服务起不来（8770 无响应）'); }
    }
    console.log('· 已拉起预览服务（跑完自己收）');
  }

  buildProbeApp();
  runProbe();
})().catch(function (e) {
  killSpawned();
  die((e && e.stack) || String(e));
});

function killSpawned() {
  if (!spawned) return;
  try { spawned.kill(); } catch (e) { /* 已经走了 */ }
  spawned = null;
}

/* ---------- 1) 组探针应用（配方同 §7 坑 17） ---------- */
function buildProbeApp() {
  if (!fs.existsSync(DIST)) die('还没有 dist/ —— 先 node build.js');
  const distApp = fs.readdirSync(DIST).map(function (n) { return path.join(DIST, n); })
    .filter(function (p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } })
    .filter(function (p) { return fs.existsSync(path.join(p, 'resources', 'app')); })[0];
  if (!distApp) die('dist 下没找到带 resources/app 的运行时目录');
  /* ★ 跑的是临时目录里那份 exe：Electron 按 exe 所在位置找 resources/app，
   *   用 dist 那份会启动真正的出厂应用（主窗 minWidth 1080），探针窗口根本轮不到 */
  const exeName = fs.readdirSync(distApp).filter(function (n) { return /\.exe$/i.test(n); })[0];
  if (!exeName) die('dist 运行时里没有 exe');

  rmrf(TMP);
  fs.mkdirSync(TMP, { recursive: true });
  (function linkTree(src, dst) {
    fs.readdirSync(src).forEach(function (name) {
      const s = path.join(src, name), d = path.join(dst, name);
      if (s === path.join(distApp, 'resources', 'app')) return;
      const st = fs.statSync(s);
      if (st.isDirectory()) { fs.mkdirSync(d, { recursive: true }); linkTree(s, d); }
      else { try { fs.linkSync(s, d); } catch (e) { fs.copyFileSync(s, d); } }
    });
  })(distApp, TMP);
  if (!fs.existsSync(path.join(TMP, exeName))) die('临时目录里没有 exe（硬链接没成功）');

  const APP = path.join(TMP, 'resources', 'app');
  rmrf(APP);
  fs.mkdirSync(APP, { recursive: true });
  fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({
    name: 'df-app-layout-probe', version: '1.0.0', main: 'probe-main.js'
  }, null, 2));
  fs.writeFileSync(path.join(APP, 'probe-main.js'), MAIN_JS);
  /* 生成的主脚本自己先过一遍语法检查：它解析不了的时候 Electron 只会弹一个模态框然后干等，
   * 父进程看到的就只是"超时没产出"，根因藏得死死的（实测踩过一次）。 */
  const chk = spawnSync(process.execPath, ['--check', path.join(APP, 'probe-main.js')],
    { encoding: 'utf8' });
  if (chk.status !== 0) {
    die('生成的探针主脚本通不过语法检查：\n' +
      String(chk.stderr || '').split(/\r?\n/).slice(0, 6).join('\n'));
  }
  return path.join(TMP, exeName);
}

const MEASURE = `(function (view) {
  function esc(s) { return String(s == null ? '' : s); }
  function path(el) {
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
      (el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
  }
  function scrollableAncestor(el) {
    var p = el.parentElement;
    while (p) { var cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowX)) return p; p = p.parentElement; }
    return null;
  }
  var w = window.innerWidth;
  var over = [];
  Array.prototype.forEach.call(document.querySelectorAll('body *'), function (el) {
    var r = el.getBoundingClientRect();
    if (!r.width || r.right <= w + 1) return;
    if (el.closest('.nav-scrim')) return;
    if (!scrollableAncestor(el)) over.push(path(el) + ' right=' + Math.round(r.right));
  });
  var active = document.querySelector('.view.active') || document.body;
  function visCount(sel, root) {
    return Array.prototype.filter.call((root || active).querySelectorAll(sel),
      function (el) { return el.offsetParent !== null || /fixed/.test(getComputedStyle(el).position); }).length;
  }
  var charts = [];
  Array.prototype.forEach.call(active.querySelectorAll('.chart'), function (el) {
    var r = el.getBoundingClientRect();
    var painted = !!el.querySelector('canvas');
    if (r.width < 40 || (painted && r.width < 40)) {
      charts.push({ id: el.id || path(el), w: Math.round(r.width), h: Math.round(r.height), painted: painted });
    }
  });
  var rows = 0;
  Array.prototype.forEach.call(active.querySelectorAll('tbody tr'), function (tr) {
    if (tr.offsetParent !== null) rows++;
  });
  var minTap = { total: 0, short: 0, which: [] };
  if (w <= ${PHONE}) {
    var seen = [];
    Array.prototype.forEach.call(document.querySelectorAll(
        'button, input:not([type=checkbox]):not([type=radio]), select, label.pl-switch, .switch, .mt-sw, a'),
      function (el) {
        if (!el.offsetHeight) return;
        /* 复选框/开关的可点区域是整条 label，量本体没意义；label 自己出现过就不重复算 */
        var unit = el.closest('label') || el;
        if (seen.indexOf(unit) >= 0) return;
        seen.push(unit);
        var h = unit.offsetHeight;
        minTap.total++;
        if (h < 40) { minTap.short++; if (minTap.which.length < 6) minTap.which.push(path(unit) + '=' + h); }
      });
  }
  var sb = document.querySelector('.sidebar');
  /* ★ #88 那一类缺陷：格子没破版、也没被藏，就是**折成了两行** —— 上面这些量测一个都看不见它。
   *   所以逐颗 .camp 格数它的内容实际占几行（Range 的矩形数 = 文本折了几行），
   *   并把每张表"表头列数 vs 表体第一行列数"配一次对（加一列忘了另一处就是这么露出来的）。 */
  var campWorst = 0, campBad = [];
  Array.prototype.forEach.call(active.querySelectorAll('td.camp'), function (td) {
    var rg = document.createRange();
    rg.selectNodeContents(td);
    var lines = rg.getClientRects().length;
    if (lines > campWorst) campWorst = lines;
    if (lines > 1) campBad.push((td.textContent || '').trim().slice(0, 12) + '=' + lines + '行');
  });
  var colMis = [];
  Array.prototype.forEach.call(active.querySelectorAll('table'), function (t) {
    var th = t.querySelectorAll('thead th').length;
    var tr0 = t.querySelector('tbody tr');
    if (!th || !tr0) return;
    var td = tr0.querySelectorAll('td').length;
    if (th !== td) colMis.push((t.id || (t.closest('.panel') || {}).id || '表') +
      ' 头' + th + '/身' + td);
  });
  var sbs = sb ? sb.getBoundingClientRect() : null;
  var btn = document.getElementById('btnNavDrawer');
  var content = document.querySelector('.content');
  return {
    view: view,
    innerWidth: w,
    innerHeight: window.innerHeight,
    docScrollWidth: document.documentElement.scrollWidth,
    overflowCount: over.length,
    overflow: over.slice(0, 8),
    narrowCharts: charts,
    panels: visCount('.panel'),
    charts: visCount('.chart'),
    tables: visCount('table'),
    rows: rows,
    headings: visCount('h3'),
    minTap: minTap,
    campWorst: campWorst, campBad: campBad, colMis: colMis,
    navOpen: document.body.classList.contains('nav-open'),
    drawerBtn: btn ? { shown: !!btn.offsetHeight, h: btn.offsetHeight || 0 } : null,
    sidebarOffscreen: sbs ? (sbs.right <= 1) : null,
    sidebarFixed: sb ? getComputedStyle(sb).position === 'fixed' : null,
    contentWidth: content ? Math.round(content.getBoundingClientRect().width) : 0,
    bodyOverflowX: getComputedStyle(document.body).overflowX,
    contentScrollWidth: content ? content.scrollWidth : 0
  };
})(window.__view || 'overview')`;

/* 抽屉的开合是"点出来的"，只量默认关着的状态等于没量 —— 这一页跑在真实点击上：
 * 开 → 量几何与遮罩 → 点第三项（战局）→ 必须换页且自己收回去 → 再开 → 点遮罩 → 必须收回。
 * 用 async IIFE + sleep 等过渡（app.css 那条 transform 是 260ms）。 */
const DRAWER_JS = `(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var body = document.body, sb = document.querySelector('.sidebar');
  var btn = document.getElementById('btnNavDrawer'), scrim = document.getElementById('navScrim');
  var r = { ok: true };
  function shownNav() {
    return Array.prototype.filter.call(sb.querySelectorAll('.nav-item'),
      function (b) { return getComputedStyle(b).display !== 'none'; });
  }
  r.startClosed = !body.classList.contains('nav-open');
  /* ★ 探针窗口是 show:false —— 隐藏页面不推进 CSS transition 的时钟，
   *   translateX(-100%) → none 会一直停在起点，getBoundingClientRect 量到的是"没推开"的假象
   *   （实测 openLeft=-289 而 nav-open 与遮罩都已经在）。动画是装饰，量几何就按终态量。 */
  var stall = document.createElement('style');
  stall.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
  document.head.appendChild(stall);
  r.noAnimation = true;
  btn.click();
  await sleep(420);
  var rect = sb.getBoundingClientRect();
  r.openWidth = Math.round(rect.width);
  r.openLeft = Math.round(rect.left);
  r.openRight = Math.round(rect.right);
  r.scrimShown = scrim ? getComputedStyle(scrim).display !== 'none' : false;
  var navs = shownNav();
  r.navTotal = navs.length;
  r.navTappable = navs.filter(function (b) { return b.offsetHeight >= 40; }).length;
  r.drawerScrolls = /(auto|scroll)/.test(getComputedStyle(sb).overflowY);
  r.accountReachable = !!sb.querySelector('#accountSwitch');
  r.syncReachable = !!sb.querySelector('#btnSync');
  if (navs[2]) { navs[2].click(); await sleep(420); }
  r.closedAfterNav = !body.classList.contains('nav-open');
  r.activeView = (document.querySelector('.view.active') || {}).id || '';
  btn.click();
  await sleep(420);
  r.reopened = body.classList.contains('nav-open');
  if (scrim) { scrim.click(); await sleep(420); }
  r.closedByScrim = !body.classList.contains('nav-open');
  r.aria = btn.getAttribute('aria-expanded');
  r.contentTopClear = (function () {
    var c = document.querySelector('.content');
    return c ? Math.round(c.getBoundingClientRect().left) : -1;
  })();
  return r;
})()`;

/* 竖屏那条筛选栏到底吃掉多少高度（真机反馈：「中途退出、时间这个选择功能，占用一大把位置」）。
 * 先量再改：行数 / 每项宽高 / 有没有被裁掉 / 有没有横向滚，四样都报出来。 */
const FILTER_JS = `(function () {
  var bar = document.querySelector('.filterbar');
  if (!bar) return { ok: false, error: '没有 .filterbar' };
  var b = bar.getBoundingClientRect();
  var col = document.querySelector('.main-col');
  var r = {
    ok: true, barTop: Math.round(b.top), barH: Math.round(b.height),
    barW: Math.round(b.width), viewportW: window.innerWidth, viewportH: window.innerHeight,
    colH: col ? Math.round(col.getBoundingClientRect().height) : 0,
    scrollX: bar.scrollWidth > bar.clientWidth + 1
  };
  var kids = Array.prototype.filter.call(bar.children, function (el) {
    return el.getBoundingClientRect().width > 0;
  });
  /* 按"垂直中心"分行，不是按 top：align-items:center 下 16px 的文本行和 44px 的控件行
   * 同一行却 top 差 14px —— 拿 top 分桶会把一行数成两行（第一版就是这么误判 5 行的）。 */
  var cents = [];
  r.kids = kids.map(function (el) {
    var q = el.getBoundingClientRect();
    var cy = q.top + q.height / 2;
    for (var i = 0; i < cents.length; i++) {
      if (Math.abs(cents[i] - cy) <= 16) return record(i, q);
    }
    cents.push(cy);
    return record(cents.length - 1, q);
    function record(line, rect) {
      r['line' + line] = (r['line' + line] || 0) + 1;
      return { cls: String(el.id || el.className || el.tagName).slice(0, 20),
        w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top),
        line: line, over: Math.round(rect.right - b.right) };
    }
  });
  r.lines = cents.length;
  r.groups = kids.length;
  /* 把控件压窄有个坏得多的失败方式：字被挤掉。藏 = 少一块内容，挤 = 少一块内容但探针看着"没藏"。 */
  r.clipped = Array.prototype.map.call(bar.querySelectorAll('.seg, select.input'), function (el) {
    return el.scrollWidth > el.clientWidth + 1 ? (el.textContent || el.id).trim().slice(0, 8) +
      '(' + el.scrollWidth + '>' + el.clientWidth + ')' : null;
  }).filter(Boolean);
  r.overflowRight = r.kids.filter(function (k) { return k.over > 1; }).map(function (k) { return k.cls; });
  r.tallest = r.kids.slice().sort(function (a, c) { return c.h - a.h; })[0];
  return r;
})()`;

/* ⑧ 单场详情 + 对手与队友这两页的"点开才有内容"的量测（#84/#86/#87/#88 全压在这里）：
 * 上面每一档量的都是默认落地的那一页，而这几条要真点一行、真点一个人、真换一次模式筛选。
 * 全是"真点"，不是拿源码正则扫一遍当验过。 */
const DETAIL_JS = `(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function linesOf(el) {
    var rg = document.createRange();
    rg.selectNodeContents(el);
    return rg.getClientRects().length;
  }
  var r = { ok: true };
  /* —— 1) 战局页点第一行，开单场详情 —— */
  var nav = document.querySelector('.nav-item[data-view="matches"]');
  if (nav) { nav.click(); await sleep(520); }
  var row = document.querySelector('#matchTable tbody tr.clickable');
  r.rowClicked = !!row;
  if (row) { row.click(); await sleep(1100); }
  var box = document.getElementById('detailBox');
  r.detailShown = !!(box && box.offsetHeight > 0);
  var h3 = Array.prototype.map.call(box ? box.querySelectorAll('h3') : [],
    function (x) { return (x.textContent || '').trim(); });
  r.title = h3[0] || '';
  /* 战局列表那一行的地图格里有没有带攻防（'-' 连接，他给的样子是 地图-身份） */
  var firstCell = row ? (row.querySelector('td.l') || {}).textContent : '';
  r.listMapCell = String(firstCell || '').trim().slice(0, 26);
  /* 榜单：表头列数 / 表体第一行列数 / 攻防列在不在。
   * ★ 不能拿"第一张 mini-table"当榜单 —— 详情里那张「各项排名百分位」也是 mini-table（它 5 列，
   *   第一版探针就是抓了它，把配对判成 5/5 通过、真正 6 列的榜一张没量）。
   *   按表头里有没有「阵营」来抓，那才是榜。 */
  var board = null;
  Array.prototype.forEach.call(box ? box.querySelectorAll('table.mini-table') : [], function (t) {
    if (!board && /阵营/.test((t.querySelector('thead') || {}).textContent || '')) board = t;
  });
  r.boardTh = board ? board.querySelectorAll('thead th').length : 0;
  r.boardTd = board && board.querySelector('tbody tr')
    ? board.querySelector('tbody tr').querySelectorAll('td').length : 0;
  r.boards = box ? box.querySelectorAll('table.mini-table').length : 0;
  r.boardSideCol = !!board && /攻防/.test((board.querySelector('thead') || {}).textContent || '');
  /* 阵营与攻防那两格：任何宽度都只许一行（#88 就是它折成了两行） */
  r.campCells = box ? box.querySelectorAll('td.camp').length : 0;
  r.campWorst = 0;
  Array.prototype.forEach.call(box ? box.querySelectorAll('td.camp') : [], function (td) {
    var n = linesOf(td);
    if (n > r.campWorst) r.campWorst = n;
  });
  r.campWords = (function () {
    var set = {};
    Array.prototype.forEach.call(box ? box.querySelectorAll('td.camp') : [], function (td) {
      var t = (td.textContent || '').trim();
      if (t) set[t] = 1;
    });
    return Object.keys(set).join('/');
  })();
  /* 破版：详情这页横向有没有溢出 */
  r.overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
  /* —— 1b) 战绩卡片：这一张不是 DOM，是 Canvas。把 getContext 临时换成记录器，
   *   让 drawMatchCard 真画一遍，收回它落到画布上的每一行字。
   *   ★ 不许用"源码里有没有 KPM 这个词"代替这一步 —— 卡片那份数组是独立的一处，
   *     上一轮 #79 换了总览六格、这一轮的 KD→KPM 就得单独验它跟没跟。 —— */
  var ridEl = document.getElementById('roomPick');
  r.cardRid = ridEl ? String(ridEl.value || '') : '';
  r.cardTexts = '';
  r.cardPng = false;
  r.cardSide = '';
  if (r.cardRid && window.DFViews && window.df) {
    try {
      var cmp = await window.df.match(r.cardRid);
      r.cardSide = (cmp && cmp.match && cmp.match.side) || '';
      var rec = [];
      var origGC = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (tp) {
        var ctx = origGC.apply(this, arguments);
        if (ctx && tp === '2d') {
          var ft = ctx.fillText;
          ctx.fillText = function (s) { rec.push(String(s)); return ft.apply(ctx, arguments); };
        }
        return ctx;
      };
      var url = '';
      try { url = String(window.DFViews.drawMatchCard(cmp) || ''); }
      catch (e2) { r.cardErr = String((e2 && e2.message) || e2); }
      HTMLCanvasElement.prototype.getContext = origGC;
      r.cardTexts = rec.join('|');
      r.cardPng = url.indexOf('data:image/png') === 0 && url.length > 4000;
    } catch (e3) { r.cardErr = String((e3 && e3.message) || e3); }
  }
  /* —— 2) 对手与队友：模式筛选要真的改得动这一页（#87）——
   * ★ 判据不是"文字长度变了没有"：库里只有一种模式时，全对 / 胜者为王 本来就该一样，
   *   那种写法会把正确当成 bug。这里钉的是**页面念出来的场数 == 同一筛选下 core 算出来的场数**，
   *   数据里两种模式都有时，等式两边自然就分开了（第一版就是拿长度比的，样本 4 场全是胜者为王，
   *   于是一次"正确的没变"被我读成了"筛选没生效"）。 */
  var nav2 = document.querySelector('.nav-item[data-view="encounters"]');
  if (nav2) { nav2.click(); await sleep(900); }
  var view = document.getElementById('view-encounters');
  function scannedNow() {
    var t = String((view && view.textContent) || '').replace(/\\s+/g, ' ');
    var m = /扫描\\s*(\\d+)\\s*场/.exec(t);
    return m ? Number(m[1]) : -1;
  }
  async function expectOf(f) {
    try {
      const j = await fetch('/mock/report?mode=' + f).then(function (x) { return x.json(); });
      return j.encounters ? j.encounters.scanned : -2;
    } catch (e) { return -3; }
  }
  r.encScannedAll = scannedNow();
  r.expectAll = await expectOf('all');
  var sw = document.querySelector('#fMode [data-mode="swtwr"]');
  var all = document.querySelector('#fMode [data-mode="all"]');
  r.swtwrBtn = !!sw;
  if (sw) { sw.click(); await sleep(1200); }
  r.encScannedSwwr = scannedNow();
  r.expectSwwr = await expectOf('swtwr');
  if (all) { all.click(); await sleep(1200); }
  r.encScannedBack = scannedNow();
  /* —— 3) 交手档案：点一个人，逐项对照那张表画出来没有 —— */
  var prow = view ? view.querySelector('tbody tr[data-key]') : null;
  r.personClicked = !!prow;
  if (prow) { prow.click(); await sleep(1300); }
  var enc = document.getElementById('encDetail');
  var et = enc ? (enc.textContent || '') : '';
  r.compareTable = /逐项对照/.test(et);
  r.compareRows = ['击杀数', '死亡数', 'KPM（每分钟击杀）', '分均得分', '累计时长']
    .filter(function (w) { return et.indexOf(w) >= 0; }).length;
  r.encOverflow = !!enc && enc.scrollWidth > window.innerWidth + 1;
  return r;
})()`;

/* ---------- 1.4) ⑥ 进门那一下（四条分支）：抽屉"默认关着"的那一条例外 ----------
 * 上面每一档都在量"默认关着"，这一档量的是那条例外：刚进主界面这一下必须落在总览、
 * 并且把侧栏抽屉拉开 —— 竖屏上第一次进来的人看不见左侧那串功能项，就会以为软件只有眼前这一页。
 * 三条分支各有各的死法：
 *   skip     = 点「跳过登录」进去（本机有数据 / 没数据都该进得去）；
 *   login    = 走 login:done 那条链进去（真机上这就是登录成功的唯一路径）；
 *   readonly = 数据包导进来的只读号 boot 直接进主界面，它不算"刚登录"，抽屉就该保持关着；
 *   nodata   = 本机一场数据都没有：那颗「跳过」按新规矩必须藏着（跳进去是一整屏空面板），但要说清为什么。 */
function entryJS(mode) {
  return `(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function vis(id) {
    var e = document.getElementById(id);
    return !!e && !e.classList.contains('hidden') && e.offsetHeight > 0;
  }
  function txt(id) { return String((document.getElementById(id) || {}).textContent || '').trim(); }
  var stall = document.createElement('style');
  stall.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
  document.head.appendChild(stall);
  var MODE = ${JSON.stringify(mode)};
  var r = { mode: MODE };
  for (var i = 0; i < 60; i++) {
    /* ★ 就绪信号 = "boot 真的把这一屏的话说完了"：要么已进主界面，要么登录状态那句不再是「正在检查…」。
     *   不能等那颗跳过按钮 —— nodata 那一档它按新规矩就不会出现，等它就等于白等九秒再量到半成品。
     *   （也不能只看 #loginView 可见：它在出厂 HTML 上一开始就可见，boot 还没回来 = 点了颗藏着的按钮。） */
    if (vis('appView') || (vis('loginView') && txt('loginStatus').indexOf('正在检查') < 0)) break;
    await sleep(150);
  }
  r.loginViewShown = vis('loginView');
  r.skipShown = vis('btnSkipLogin');
  r.skipText = txt('btnSkipLogin');
  r.hintShown = vis('skipHint');
  r.hintText = txt('skipHint');
  r.drawerBefore = document.body.classList.contains('nav-open');
  if (MODE === 'login') {
    window.df.__fire('login:done', { role: { name: '探针号', openid: '12345678' }, slot: 'a1' });
  } else if (MODE === 'skip') {
    var b = document.getElementById('btnSkipLogin');
    if (b) b.click();
  }
  await sleep(MODE === 'readonly' ? 600 : 1400);
  var sb = document.querySelector('.sidebar');
  var rect = sb ? sb.getBoundingClientRect() : { left: -999, width: 0 };
  r.appViewShown = vis('appView');
  r.loginViewHidden = !vis('loginView');
  r.drawerOpen = document.body.classList.contains('nav-open');
  r.activeView = (document.querySelector('.view.active') || {}).id || '';
  r.sidebarLeft = Math.round(rect.left);
  r.sidebarWidth = Math.round(rect.width);
  /* ★ 「都在屏内」量的必须是**画出来的**那些项：#navPlugin 出厂就是 display:none，
   *   只有装了插件才亮。以前拿 querySelectorAll 的总数当分母，等于要求一颗刻意藏起来的项
   *   出现在视口里 —— 那台机器上没装插件时这条必然红（报的是"11/12 项"，其实一项都没破版）。 */
  r.navRendered = Array.prototype.filter.call(document.querySelectorAll('.nav-item'),
    function (n) { return n.offsetHeight > 0; }).length;
  r.navVisible = Array.prototype.filter.call(document.querySelectorAll('.nav-item'), function (n) {
    var q = n.getBoundingClientRect();
    return n.offsetHeight > 0 && q.right <= window.innerWidth + 1 && q.left >= -1;
  }).length;
  r.navTotal = document.querySelectorAll('.nav-item').length;
  r.offlineShown = vis('offlineBar');
  r.offlineText = txt('offlineText');
  r.scrollX = document.documentElement.scrollWidth > window.innerWidth + 1;
  return r;
})()`;
}
const ENTRY_JS = {
  skip: entryJS('skip'), login: entryJS('login'),
  readonly: entryJS('readonly'), nodata: entryJS('nodata')
};

/* ⑦ 设置页那一行地图名字典与那颗按钮：这功能是「官方出新图时你自己点一下」，
 *   所以必须量到点之前/点之后的差别 —— 只看按钮在不在，等于没量。 */
function mapNamesJS() {
  return `(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function vis(id) {
    var e = document.getElementById(id);
    return !!e && !e.classList.contains('hidden') && e.offsetHeight > 0;
  }
  function txt(id) { return String((document.getElementById(id) || {}).textContent || '').trim(); }
  var stall = document.createElement('style');
  stall.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
  document.head.appendChild(stall);
  var nav = document.querySelector('.nav-item[data-view="settings"]');
  if (nav) nav.click();
  await sleep(900);
  var r = {};
  r.onSettings = (document.querySelector('.view.active') || {}).id === 'view-settings';
  r.rowShown = vis('mapNamesText');
  r.before = txt('mapNamesText');
  r.btnShown = vis('btnMapNamesRefresh');
  r.btnLabel = txt('btnMapNamesRefresh');
  var b = document.getElementById('btnMapNamesRefresh');
  if (b) b.click();
  /* 按下去之后先变「正在更新…」再变回来：这一趟没走完就量，量到的是半成品 */
  r.busy = txt('btnMapNamesRefresh');
  for (var i = 0; i < 40; i++) {
    await sleep(150);
    var e2 = document.getElementById('btnMapNamesRefresh');
    if (e2 && !e2.disabled && txt('btnMapNamesRefresh') === r.btnLabel) break;
  }
  r.after = txt('mapNamesText');
  r.changed = r.after !== r.before;
  r.btnBack = txt('btnMapNamesRefresh');
  r.btnUsable = !!(document.getElementById('btnMapNamesRefresh') || {}).disabled === false;
  r.scrollX = document.documentElement.scrollWidth > window.innerWidth + 1;
  /* —— #92 本机字典：打开 → 表与输入框在 → 真改一名 → 那行状态与表里的名字都跟上 → 再还原 —— */
  r.dictClosedBefore = !vis('mapDictBox');
  var db = document.getElementById('btnMapDict');
  r.dictBtnBefore = txt('btnMapDict');
  if (db) db.click();
  await sleep(800);
  r.dictOpen = vis('mapDictBox');
  r.dictBtnAfter = txt('btnMapDict');
  var box = document.getElementById('mapDictBox') || {};
  var boxText = function () { return String(box.textContent || '').replace(/\\s+/g, ' '); };
  r.dictText = boxText().slice(0, 160);
  r.dictRows = box.querySelectorAll ? box.querySelectorAll('tbody tr').length : -1;
  r.dictInputs = !!(document.getElementById('dictMapId') &&
    document.getElementById('dictMapName') && document.getElementById('dictSave'));
  /* 每张表都配一次「表头列数 vs 表体第一行列数」：加一列忘改另一处就是这么露出来的 */
  r.dictColMis = [];
  if (box.querySelectorAll) {
    Array.prototype.forEach.call(box.querySelectorAll('table'), function (t) {
      var th = t.querySelectorAll('thead th').length;
      var tr0 = t.querySelector('tbody tr');
      if (!th || !tr0) return;
      var td = tr0.querySelectorAll('td').length;
      if (th !== td) r.dictColMis.push('头' + th + '/身' + td);
    });
  }
  /* 挑一颗「改名」：优先挑还不认识的那一行（data-dict-name 是空串），没有就退回第一行 */
  var pickId = '', pickHow = '';
  if (box.querySelectorAll) {
    var btns = box.querySelectorAll('[data-dict-act="edit"]');
    for (var j = 0; j < btns.length; j++) {
      if (!btns[j].getAttribute('data-dict-name')) {
        pickId = btns[j].getAttribute('data-dict-id') || ''; pickHow = 'unknown'; break;
      }
    }
    if (!pickId && btns.length) {
      pickId = btns[0].getAttribute('data-dict-id') || ''; pickHow = 'first';
    }
  }
  r.pickId = pickId; r.pickHow = pickHow;
  if (pickId) {
    document.getElementById('dictMapId').value = pickId;
    document.getElementById('dictMapName').value = '探针起的名字';
    /* 诊断用：输入框里真正躺着的那串字（读回来才有意义，写进去的不算） */
    r.typedId = document.getElementById('dictMapId').value;
    r.typedName = document.getElementById('dictMapName').value;
    r.typedCodePoints = Array.prototype.map.call(r.typedName, function (c) {
      return c.charCodeAt(0); }).join(',');
    document.getElementById('dictSave').click();
    for (var w1 = 0; w1 < 40; w1++) { await sleep(200); if (boxText().indexOf('探针起的名字') >= 0) break; }
    r.statusRenamed = txt('mapNamesText');
    r.dictAfterRename = boxText();
    r.renameShown = r.dictAfterRename.indexOf('探针起的名字') >= 0;
    /* 那块里第一张表的第一行（我改过的那一条）到底写的什么字 */
    r.editRow = (function () {
      var t = box.querySelector ? box.querySelector('table') : null;
      var tr = t ? t.querySelector('tbody tr') : null;
      return tr ? String(tr.textContent || '').replace(/\\s+/g, ' ').slice(0, 60) : '（第一张表没有行）';
    })();
    r.toast = txt('toast');
    r.renameOk = r.renameShown &&
      /我改的 \\d+ 张/.test(r.statusRenamed);
    /* 还原：同一编号留空再保存一次 —— 「我改的」那一档与表里那行都该退回去 */
    document.getElementById('dictMapId').value = pickId;
    document.getElementById('dictMapName').value = '';
    document.getElementById('dictSave').click();
    for (var g = 0; g < 40; g++) {
      if (boxText().indexOf('探针起的名字') < 0 && !/我改的 \\d+ 张/.test(txt('mapNamesText'))) break;
      await sleep(200);
    }
    r.reverted = boxText().indexOf('探针起的名字') < 0 &&
      !/我改的 \\d+ 张/.test(txt('mapNamesText'));
    r.statusReverted = txt('mapNamesText');
  }
  r.dictScrollX = document.documentElement.scrollWidth > window.innerWidth + 1;
  return r;
})()`;
}
const MAPNAMES_JS = mapNamesJS();

const MAIN_JS = `(function(){
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const WIDTHS = ${JSON.stringify(WIDTHS)};
const VIEWS = ${JSON.stringify(VIEWS)};
const URL = '${BASE_URL}';
const WIDEN = ${JSON.stringify(WIDEN)};
const MEASURE = ${JSON.stringify(MEASURE)};
const DRAWER = ${JSON.stringify(DRAWER_JS)};
const FILTER = ${JSON.stringify(FILTER_JS)};
const MAPNAMES = ${JSON.stringify(MAPNAMES_JS)};
const DETAIL = ${JSON.stringify(DETAIL_JS)};
const ENTRY = ${JSON.stringify(ENTRY_JS)};
const OUT = process.env.PROBE_OUT || path.join(require('os').tmpdir(), 'df-app-layout-probe', 'report.json');
const TRACE = OUT + '.trace';
function tr(s) { try { fs.appendFileSync(TRACE, s + '\\n'); } catch (e) {} }
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
tr('start ' + process.versions.electron);

app.whenReady().then(async function () {
  const out = [];
  let win = null;
  try {
    win = new BrowserWindow({
      show: false, width: 1440, height: 900, minWidth: 0, minHeight: 0,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    tr('window');
    for (const w of WIDTHS) {
      win.setBounds({ x: 0, y: 0, width: w, height: w <= 900 ? 780 : 900 });
      await win.loadURL(URL + '?probe=' + w);
      /* 等外壳真的画出来：#appView 不再 hidden 才说明 boot + report 都回来了 */
      let ready = false;
      for (let i = 0; i < 80; i++) {
        ready = await win.webContents.executeJavaScript(
          '!!(document.getElementById("appView") && !document.getElementById("appView").classList.contains("hidden"))');
        if (ready) break;
        await sleep(150);
      }
      tr('loaded ' + w + ' ready=' + ready);
      if (!ready) { out.push({ width: w, error: '外壳没起来（appView 仍 hidden）' }); continue; }
      let cssKey = '';
      if (WIDEN) {
        /* 撑宽的量必须跟着这一档的视口走：固定 900px 在 1440 档根本撑不破页面，
         * 那时"没报红"是对的，反过来用它当反向验证就是把探针判成瞎的（实测踩过）。 */
        cssKey = await win.webContents.insertCSS(
          'body{min-width:' + (w + 240) + 'px}', { cssOrigin: 'user' });
      }
      for (const v of VIEWS) {
        /* 用真点击换页：data-view 那颗按钮就是用户按的那颗。
         * 选择器一律走 JSON.stringify 生成 —— 这一层已经是字符串里的字符串，
         * 手写 \\' 会在模板字面量里塌成一个裸引号，产出的脚本根本不解析（实测踩过）。 */
        const sel = JSON.stringify('.nav-item[data-view="' + v + '"]');
        const snippet = '(function(){var b=document.querySelector(' + sel + ');' +
          'if(!b)return false;' +
          'if(getComputedStyle(b).display==="none")return false;' +
          'b.click();return true;})()';
        const clicked = await win.webContents.executeJavaScript(snippet);
        if (!clicked) { out.push({ width: w, view: v, skipped: '导航项不在（扩展页没装插件 / 被隐藏）' }); continue; }
        await sleep(v === 'sandbox' ? 700 : 420);
        const rep = await win.webContents.executeJavaScript(
          '(window.__view=' + JSON.stringify(JSON.stringify(v)) + ', ' + MEASURE + ')');
        out.push({ width: w, view: v, report: rep });
      }
      if (w <= ${PHONE}) {
        out.push({ width: w, view: '__drawer', report: await win.webContents.executeJavaScript(DRAWER) });
        /* 抽屉那一段最后停在第 3 项上，回「战局列表」再量筛选栏（筛选栏在这一页必然可见） */
        await win.webContents.executeJavaScript(
          '(function(){var b=document.querySelector(' + JSON.stringify('.nav-item[data-view="matches"]') +
          ');if(b)b.click();return true;})()');
        await sleep(420);
        out.push({ width: w, view: '__filter', report: await win.webContents.executeJavaScript(FILTER) });
      }
      /* ⑧ 单场详情 / 对手与队友 / 交手档案：放在这一档所有量测的最后（它会把界面停在"点开"的状态） */
      if (!WIDEN) {
        try {
          out.push({ width: w, view: '__detail', report: await win.webContents.executeJavaScript(DETAIL) });
          tr('detail ' + w);
        } catch (e) {
          tr('detail-error ' + w + ' ' + ((e && e.stack) || e));
          out.push({ width: w, view: '__detail', error: '⑧ 详情/交手档案：' + ((e && e.message) || e) });
        }
      }
      /* insertCSS 会跨导航留着，不撤掉下一档就还带着这一档的 min-width */
      if (cssKey) {
        try { await win.webContents.removeInsertedCSS(cssKey); } catch (e) { tr('remove-css ' + e); }
      }
    }
    /* ⑥ 进门那一下：只在 360 这一档走四条分支（撑宽那一跑量的是破版，不掺进来） */
    if (!WIDEN && WIDTHS.indexOf(360) >= 0) {
      await win.setBounds({ x: 0, y: 0, width: 360, height: 780 });
      for (const name of ['skip', 'login', 'readonly', 'nodata']) {
        const q = name === 'readonly' ? 'localonly=1'
          : (name === 'nodata' ? 'nologin=1&nodata=1' : 'nologin=1');
        try {
          await win.loadURL(URL + '?probe=360&' + q);
          const rep = await win.webContents.executeJavaScript(ENTRY[name]);
          out.push({ width: 360, view: '__entry:' + name, report: rep });
          tr('entry ' + name);
        } catch (e) {
          tr('entry-error ' + name + ' ' + ((e && e.stack) || e));
          out.push({ width: 360, view: '__entry:' + name, error: '⑥ ' + name + '：' + ((e && e.message) || e) });
        }
        await sleep(300);
      }
      /* ⑦ 设置页那行地图名字典：重新 load 一次再量（上面四条把界面留在各自的状态里了） */
      try {
        await win.loadURL(URL + '?probe=360');
        const rep = await win.webContents.executeJavaScript(MAPNAMES);
        out.push({ width: 360, view: '__mapnames', report: rep });
        tr('mapnames');
      } catch (e) {
        tr('mapnames-error ' + ((e && e.stack) || e));
        out.push({ width: 360, view: '__mapnames', error: '⑦ 地图名：' + ((e && e.message) || e) });
      }
    }
  } catch (e) {
    tr('error ' + ((e && e.stack) || e));
    out.push({ error: String((e && e.message) || e), partial: out.length });
  }
  try { fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); } catch (e) { tr('write-fail ' + e); }
  tr('done');
  app.exit(0);
}).catch(function (e) {
  tr('ready-error ' + ((e && e.stack) || e));
  try { fs.writeFileSync(OUT, JSON.stringify({ error: String((e && e.message) || e) })); } catch (x) {}
  app.exit(1);
});
})()`;

/* ---------- 2) 跑 ---------- */
function runProbe() {
  const EXE = path.join(TMP, fs.readdirSync(TMP).filter(function (n) { return /\.exe$/i.test(n); })[0]);
  const OUT = path.join(TMP, 'report.json');
  try { fs.unlinkSync(OUT); } catch (e) {}
  const env = Object.assign({}, process.env, {
    PROBE_OUT: OUT, ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  });
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(EXE, ['--no-sandbox'], { env: env, cwd: TMP, timeout: 420000 });
  if (!fs.existsSync(OUT)) {
    killSpawned();
    die('探针没有产出报告（spawn status=' + r.status + '）。GUI exe 从脚本环境直接后台拉起不会有任何输出，' +
      '这里用的是 spawnSync 同步等退出。');
  }
  const rep = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  killSpawned();
  judge(rep);
}

/* ---------- 3) 判 ---------- */
function judge(rep) {
  let fail = 0, brokeFound = 0, total = 0;
  const rows = rep.filter(function (x) { return x.report; });
  function check(name, ok, detail) {
    if (!ok) fail++;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  -> ' + detail : ''));
  }
  console.log(WIDEN
    ? '反向验证模式：整页被故意撑宽 —— PASS = 探针看得见破版，FAIL = 探针是瞎的'
    : '外壳竖屏/平板实测（真实 Electron 排版，数据来自预览服务的真实样本）');
  if (rep.error) die('探针内部报错：' + rep.error);

  /* 基准：1440 那一档每页可见内容数 —— 「不许靠藏内容适配」就是拿它比 */
  const base = {};
  rows.forEach(function (x) {
    if (x.width === 1440) base[x.view] = x.report;
  });

  rows.forEach(function (x) {
    const b = x.report, label = x.view + ' @' + x.width;
    if ((x.view === '__drawer' || x.view === '__filter') && WIDEN) return;   // 反向验证只判"页 × 宽度"那 72 档
    total++;
    if (x.view === '__filter') {
      /* 真机反馈：「中途退出、时间这个选择功能，占用一大把位置」—— 先量再改。
       * 改之前实测：360 档 6 行 / 243px = 视口 34%。改之后目标 3 行 / ≈133px = 18.6%。
       * 第三行是「筛选后 N 场 / 纳入统计 …」那句计数：它是内容，既不藏也不许压成 40px 宽竖排。
       * 一行两项已经是极限 —— 再压就要把 40px 的可点目标缩回 33px（手指不是鼠标，那条更早就定死了）。 */
      const budget = Math.round(b.viewportH * 0.19);
      check('★ ' + label + ' 筛选栏最多三行（改之前实测六行）', b.lines <= 3,
        'lines=' + b.lines + ' 高=' + b.barH + 'px 各项=' + b.kids.map(function (k) {
          return k.cls + ' ' + k.w + '×' + k.h;
        }).join(' / '));
      check('★★ ' + label + ' 筛选栏吃掉的高度 ≤ 视口 19%（' + budget + 'px）', b.barH <= budget,
        'barH=' + b.barH + ' / 视口 ' + b.viewportH + ' = ' + Math.round(b.barH / b.viewportH * 100) + '%');
      check('★★ ' + label + ' 三组筛选一颗没少（开关 + 模式 + 退出 + 时间 + 撑开 + 计数）', b.groups >= 5,
        'groups=' + b.groups);
      check(label + ' 没有子项被裁掉、这条自己不横向滚',
        b.overflowRight.length === 0 && b.scrollX === false,
        '越界=' + (b.overflowRight.join(',') || '无') + ' scrollX=' + b.scrollX);
      check('★★ ' + label + ' 没有一颗控件的字被挤掉（压窄的坏法）',
        !b.clipped || b.clipped.length === 0, b.clipped ? b.clipped.join(' ') : '没这项量测');
      return;
    }
    if (x.view === '__drawer') {
      check('★ ' + label + ' 默认是关着的', b.startClosed === true, 'startClosed=' + b.startClosed);
      check('★ ' + label + ' 一开整条都在屏内（贴左、宽 ≥240）',
        b.openLeft === 0 && b.openWidth >= 240, 'left=' + b.openLeft + ' 宽=' + b.openWidth);
      check(label + ' 打开时遮罩在（点外面才关得掉）', b.scrimShown === true, 'scrim=' + b.scrimShown);
      check('★ ' + label + ' 抽屉里每一行导航都按得着（≥40px）',
        b.navTappable === b.navTotal && b.navTotal >= 11,
        b.navTappable + '/' + b.navTotal + ' 行达标，抽屉里可见导航 ' + b.navTotal + ' 项');
      check(label + ' 抽屉可滚（12 项 + 切号 + 同步在小屏放不下）', b.drawerScrolls === true,
        'overflow-y=' + b.drawerScrolls);
      check('★★ ' + label + ' 切号与「立即同步」还在（没被竖屏挤掉）',
        b.accountReachable === true && b.syncReachable === true,
        'accountSwitch=' + b.accountReachable + ' btnSync=' + b.syncReachable);
      check('★ ' + label + ' 点导航项既换页又把抽屉收回去',
        b.closedAfterNav === true && b.activeView === 'view-matches',
        'activeView=' + b.activeView + ' 收回=' + b.closedAfterNav);
      check(label + ' 再开一次能开、点遮罩能关',
        b.reopened === true && b.closedByScrim === true,
        'reopened=' + b.reopened + ' 遮罩关=' + b.closedByScrim);
      check(label + ' aria-expanded 跟上了状态', b.aria === 'false', 'aria=' + b.aria);
      return;
    }
    if (x.view.indexOf('__entry:') === 0) {
      const mode = x.view.slice('__entry:'.length);
      if (mode === 'skip') {
        check('★ ' + label + ' 登录页上有「跳过」这颗按钮，且说清了进去能干什么',
          b.skipShown === true && !!b.skipText && b.hintShown === true && !!b.hintText,
          '按钮「' + b.skipText + '」提示=' + b.hintText.slice(0, 26));
        check(label + ' 人还在登录页时不许先把抽屉拉开', b.drawerBefore === false,
          'drawerBefore=' + b.drawerBefore);
      }
      if (mode === 'readonly') {
        check('★ ' + label + ' 只读号（数据包导进来的）boot 直接进主界面，不挡在登录页',
          b.appViewShown === true && b.loginViewHidden === true,
          'app=' + b.appViewShown + ' 登录页=' + !b.loginViewHidden);
        check('★ ' + label + ' 只读号不算"刚登录"：抽屉保持默认关着', b.drawerOpen === false,
          'drawerOpen=' + b.drawerOpen);
        check('★ ' + label + ' 顶上那句说的是只读，不是"未登录"', /只读/.test(b.offlineText), b.offlineText);
        return;
      }
      if (mode === 'nodata') {
        check('★★ ' + label + ' 本机一场数据都没有时不给跳：那颗「跳过」必须藏着',
          b.loginViewShown === true && b.skipShown === false,
          '登录页=' + b.loginViewShown + ' 跳过可见=' + b.skipShown + '「' + b.skipText + '」');
        check('★ ' + label + ' 但要用人话说清为什么跳不了（不是只把按钮藏了）',
          b.hintShown === true && /还没有战绩数据/.test(b.hintText), b.hintText);
        check(label + ' 没进主界面就别拉开抽屉', b.drawerOpen === false, 'drawerOpen=' + b.drawerOpen);
        return;
      }
      check('★★ ' + label + ' 进主界面那一下抽屉是开着的（功能清单立刻看得见）',
        b.appViewShown === true && b.loginViewHidden === true && b.drawerOpen === true,
        'app=' + b.appViewShown + ' 登录页=' + !b.loginViewHidden + ' 抽屉=' + b.drawerOpen);
      check('★ ' + label + ' 落地在总览', b.activeView === 'view-overview', 'activeView=' + b.activeView);
      check('★ ' + label + ' 侧栏整条在屏内（贴左、宽 ≥240）',
        b.sidebarLeft === 0 && b.sidebarWidth >= 240, 'left=' + b.sidebarLeft + ' 宽=' + b.sidebarWidth);
      check('★★ ' + label + ' 抽屉里画出来的导航项一项不漏地都在视口内',
        b.navRendered >= 11 && b.navVisible === b.navRendered,
        '屏内 ' + b.navVisible + '/' + b.navRendered + ' 项（DOM 里共 ' + b.navTotal +
        ' 项，没装插件时那颗扩展页是刻意藏着的）');
      check(label + ' 拉开抽屉没撑出横向滚动', b.scrollX === false, 'scrollX=' + b.scrollX);
      return;
    }
    if (x.view === '__mapnames') {
      check('★★ 设置页那一行地图名字典看得见、那颗「更新地图名」也在',
        b.onSettings === true && b.rowShown === true && b.btnShown === true && !!b.btnLabel,
        '在设置页=' + b.onSettings + ' 按钮「' + b.btnLabel + '」状态「' + b.before + '」');
      /* ★ 这一条量的是"那一行有没有说实话"，两种机器状态都算：
       *   没取过 → 必须念「还没更新过」；已经取过 → 必须念出学到几条 + 上次更新时间。
       *   留空、或把已经取过的说成没取过，两边都不放过。
       *   （预览用的那份真库 22:09 已经取过一次，所以不能只认前一支。） */
      check('★ 那一行说的是实话：没取过就念「还没更新过」，取过就念出学到几条与上次更新时间',
        /还没更新过/.test(b.before) ||
        (/本机学到 \d+ 张/.test(b.before) && /上次更新 \d{4}-\d\d-\d\d/.test(b.before)),
        b.before);
      check('★★ 点一下真的取到了一次：那行状态变了，且报出学到几条与上次更新时间',
        b.changed === true && /本机学到 \d+ 张/.test(b.after) && /上次更新 \d{4}-/.test(b.after),
        '点完=' + b.after);
      check('★ 按钮跑完恢复原样且仍可点（不许停在「正在更新…」上）',
        b.btnBack === b.btnLabel && b.btnUsable === true,
        '回到「' + b.btnBack + '」可点=' + b.btnUsable);
      check('360 那一档多出来的这块 panel 不破版', b.scrollX === false, 'scrollX=' + b.scrollX);
      /* —— #92 本机字典：这一整段是"点出来的"，只看 HTML 里有没有那颗按钮不算量到 —— */
      check('★★ 本机字典点得开（默认藏着，点一下才取、才画）',
        b.dictClosedBefore === true && b.dictOpen === true &&
        b.dictBtnBefore !== b.dictBtnAfter && !!b.dictBtnAfter,
        '开前藏着=' + b.dictClosedBefore + ' 开后=' + b.dictOpen + ' 按钮「' + b.dictBtnBefore +
        '」→「' + b.dictBtnAfter + '」');
      check('★★ 那块里真画出了表与那一对手动输入（编号 + 名字 + 保存），不是一句"问不到"',
        b.dictRows >= 1 && b.dictInputs === true && /我改的|本机学到|还不认识/.test(b.dictText),
        '行数=' + b.dictRows + ' 输入框=' + b.dictInputs + ' 首屏文字=' + String(b.dictText || '').slice(0, 70));
      check('★ 字典里每张表「表头列数 = 表体第一行列数」', (b.dictColMis || []).length === 0,
        (b.dictColMis || []).join(' | ') || '配对');
      check('★★ 真改一名落到了两端：表里那行显示新名字，顶上那行状态也念出「我改的 N 张」',
        b.renameOk === true, '挑的是' + (b.pickHow === 'unknown' ? '一把不认识的图 ' : '第一行 ') +
        b.pickId + ' 输入框里=' + JSON.stringify(b.typedName) + ' 码位=' + b.typedCodePoints +
        ' 第一张表第一行=「' + b.editRow + '」 toast=「' + b.toast + '」 状态行=' + b.statusRenamed);
      check('★★ 还原也落地：撤掉之后表里那行不再挂着我起的名字，状态行也不再报「我改的」',
        b.reverted === true, '状态行=' + b.statusReverted);
      check('★ 360 那一档这块字典不破版', b.dictScrollX === false, 'scrollX=' + b.dictScrollX);
      return;
    }
    if (x.view === '__detail') {
      check('★★ 战绩卡片真画了一遍并给出 PNG（卡片只能这么验，源码里有词不算）',
        b.cardRid !== '' && b.cardPng === true && !b.cardErr,
        'room=' + b.cardRid + ' png=' + b.cardPng + (b.cardErr ? '  err=' + b.cardErr : ''));
      check('★ 卡片上念的是 KPM，不再是 KD（#89 第一条：KD 让位这一处也得跟上）',
        /\|KPM\|/.test('|' + b.cardTexts + '|') && !/\|KD\|/.test('|' + b.cardTexts + '|'),
        String(b.cardTexts || '').slice(0, 150));
      check('★★ 卡片标题带攻防身份（这一场名单里 color 有值才要求 —— #90 之后不限模式了）',
        !b.cardSide || b.cardTexts.indexOf('-' + b.cardSide) >= 0,
        '身份=' + (b.cardSide || '（这一场没带上阵营编号）') + ' 标题串=' +
        String(b.cardTexts || '').slice(0, 60));
      check('★ 卡片上那几个每分钟指标没画成 0 或 undefined',
        !/undefined|NaN/.test(b.cardTexts), String(b.cardTexts || '').slice(0, 120));
      check('★★ ' + label + ' 真点得开单场详情', b.rowClicked === true && b.detailShown === true,
        '点了行=' + b.rowClicked + ' 详情高=' + b.detailShown);
      check('★★ ' + label + ' 榜单里「阵营 / 攻防」那一格只有一行（#88 它折成两行）',
        b.campWorst === 1, '最长的那格占 ' + b.campWorst + ' 行，画出来的字：' + b.campWords);
      check('★ ' + label + ' 那一格里念得出攻防身份（进攻/防守/—，不是裸的 1 和 2）',
        /(进攻|防守|—)/.test(String(b.campWords || '')) && !/[①②]/.test(String(b.campWords || '')),
        b.campWords);
      check('★ ' + label + ' 详情标题那格带上攻防（地图后面）',
        b.campCells > 0, '阵营格 ' + b.campCells + ' 颗，标题「' + String(b.title).slice(0, 34) + '」');
      check('★★ ' + label + ' 每张榜的表头列数与表体列数配对', b.boardTh === b.boardTd && b.boardTh >= 6,
        '头 ' + b.boardTh + ' / 身 ' + b.boardTd + '，榜 ' + b.boards + ' 张');
      check('★ ' + label + ' 榜里那一格攻防列在（表头念得出「攻防」）', b.boardSideCol === true,
        'boardSideCol=' + b.boardSideCol);
      check('★ ' + label + ' 单场详情这页不破版', b.overflowX === false, '横向溢出=' + b.overflowX);
      check('★★ ' + label + ' 「对手与队友」念的场数 == 同一筛选下 core 算的场数（#87）',
        b.swtwrBtn === true && b.encScannedAll === b.expectAll &&
        b.encScannedSwwr === b.expectSwwr && b.encScannedBack === b.expectAll,
        '页面 全部=' + b.encScannedAll + ' 胜者为王=' + b.encScannedSwwr + ' 切回=' + b.encScannedBack +
        '；core 该是 全部=' + b.expectAll + ' 胜者为王=' + b.expectSwwr);
      check('★ ' + label + ' 交手档案点得开，且逐项对照那张表在（#86）',
        b.personClicked === true && b.compareTable === true,
        '点了人=' + b.personClicked + ' 对照表=' + b.compareTable);
      check('★ ' + label + ' 逐项对照里那几项都给了（击杀/死亡/KPM/分均得分/时长）',
        b.compareRows >= 5, '命中 ' + b.compareRows + '/5 项');
      return;
    }
    const broke = b.docScrollWidth > b.innerWidth + 1 || b.overflowCount > 0;
    if (WIDEN) {
      if (broke) brokeFound++;
      check('★ ' + label + ' 撑宽之后必须报破版', broke,
        broke ? 'scrollWidth=' + b.docScrollWidth + ' 越界 ' + b.overflowCount + ' 个' : '没报红 —— 这个探针是假的');
      return;
    }
    check('★ ' + label + ' 不破版（无横向溢出）', !broke,
      'scrollWidth=' + b.docScrollWidth + '/inner=' + b.innerWidth +
      (b.overflowCount ? ' 越界：' + b.overflow.slice(0, 3).join(', ') : ''));
    check(label + ' 图表都拿得到宽度（≥40，坑 13）', b.narrowCharts.length === 0,
      b.narrowCharts.map(function (c) { return c.id + ' 宽=' + c.w + (c.painted ? '' : ' 未画'); }).join(' '));
    /* 这一页上凡是带 .camp 的格（榜单 / 名单 / 交手档案）都要单行；表头与表体的列数也要配成对 */
    check('★ ' + label + ' 阵营/攻防那些格没折行、每张表头身列数配对',
      (!b.campWorst || b.campWorst === 1) && (!b.colMis || b.colMis.length === 0),
      (b.campWorst > 1 ? '最长 ' + b.campWorst + ' 行：' + (b.campBad || []).join(' ') : '') +
      (b.colMis && b.colMis.length ? ' 列数不对：' + b.colMis.join(' / ') : ''));

    const ref = base[x.view];
    if (ref && x.width !== 1440) {
      const same = b.panels === ref.panels && b.charts === ref.charts &&
        b.tables === ref.tables && b.rows === ref.rows && b.headings === ref.headings;
      check('★★ ' + label + ' 可见内容和 1440 那档一样多（没靠藏内容装窄屏）', same,
        'panel ' + b.panels + '/' + ref.panels + ' chart ' + b.charts + '/' + ref.charts +
        ' table ' + b.tables + '/' + ref.tables + ' 行 ' + b.rows + '/' + ref.rows +
        ' h3 ' + b.headings + '/' + ref.headings);
    }

    if (x.width <= PHONE) {
      check('★ ' + label + ' 抽屉默认关着且整条在屏外',
        b.navOpen === false && b.sidebarOffscreen === true && b.sidebarFixed === true,
        'navOpen=' + b.navOpen + ' 屏外=' + b.sidebarOffscreen + ' fixed=' + b.sidebarFixed);
      check(label + ' 那颗抽屉开关看得见、按得着（≥40px）',
        !!b.drawerBtn && b.drawerBtn.shown && b.drawerBtn.h >= 40,
        b.drawerBtn ? 'shown=' + b.drawerBtn.shown + ' h=' + b.drawerBtn.h : '没有 #btnNavDrawer');
      check(label + ' 内容区拿回整幅宽度（≥ 视口 - 28）',
        b.contentWidth >= b.innerWidth - 28, 'content=' + b.contentWidth + ' inner=' + b.innerWidth);
      check('★ ' + label + ' 可点目标不低于 40px（手指不是鼠标）',
        b.minTap.short === 0,
        b.minTap.short ? b.minTap.which.join(' ') : (b.minTap.total + ' 个目标全部达标'));
    } else if (b.drawerBtn && b.drawerBtn.shown) {
      check(label + ' 宽屏上不该看见抽屉开关', false, 'drawerBtn 可见');
    }
  });

  /* ⑥ 三条分支一条都不许缺：漏跑会让这一段悄悄变成"没测" */
  if (!WIDEN) {
    ['skip', 'login', 'readonly', 'nodata'].forEach(function (m) {
      check('★ ⑥ ' + m + ' 这一跑真的量到了',
        rows.some(function (x) { return x.view === '__entry:' + m; }));
    });
    check('★ ⑦ 设置页那颗「更新地图名」这一跑真的量到了',
      rows.some(function (x) { return x.view === '__mapnames'; }));
  }

  const skipped = rep.filter(function (x) { return x.skipped; });
  skipped.forEach(function (x) {
    console.log('  —     ' + x.view + ' @' + x.width + ' 跳过：' + x.skipped);
  });
  const errs = rep.filter(function (x) { return x.error; });
  errs.forEach(function (x) { check('窗口档 ' + x.width + ' 跑通', false, x.error); });

  console.log('\n量了 ' + total + ' 档：' + VIEWS.length + ' 页 × ' + WIDTHS.length + ' 档宽度（' +
    WIDTHS.join('/') + '），外加抽屉、筛选栏、⑥ 进门四条分支与 ⑦ 地图名那颗按钮；跳过的见上');
  console.log(WIDEN
    ? (brokeFound === total && total > 0
        ? '反向验证 OK：撑宽的 ' + total + ' 档全被看见'
        : '★ 反向验证失败：撑宽 ' + total + ' 档只看见 ' + brokeFound + ' 档 —— 这个探针不可信')
    : (fail === 0 ? '竖屏/平板全部通过' : fail + ' 项失败'));
  process.exit(WIDEN ? (brokeFound === total && total > 0 ? 0 : 1) : (fail === 0 ? 0 : 1));
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
