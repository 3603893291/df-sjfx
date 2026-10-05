/* 「占点（次）」这枚列名在手机上到底长什么样，设置页那句说明有没有跟着到位。
 *
 * 为什么要单独验这一条：改名后 app.js 在加载时就取 global.DFViews.OCCUPY.label，
 * 而安卓那份 index.html 是装配脚本注入过一段 <script> 的 —— 脚本顺序一旦和桌面不一样，
 * 整个界面会白屏，这件事只有装进 APK 的那份文件能证明。
 * 顺带量一次窄屏（模拟器 360dp）下列头会不会把表格撑破。
 *
 * 跑法：node tools/android-cdp.js --serial=127.0.0.1:16384 --file=test/device/occupy-label.js
 * 前置：先在登录页点「跳过，直接看本机数据」进主界面。
 */
(async function () {
  await window.__dfReady;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function bare(root) {
    if (!root) return { err: '没有这个视图' };
    var txt = root.textContent;
    var rest = txt.split('占点（次）').join('');
    var hits = rest.split('占点').length - 1;
    return {
      occCi: txt.split('占点（次）').length - 1,
      bareHits: hits,
      bareCtx: hits ? rest.split('占点').slice(1).map(function (s) { return s.slice(0, 8); }) : []
    };
  }
  var out = {
    /* ① 界面活着 = app.js 那句 DFViews.OCCUPY 在安卓的脚本顺序下没炸 */
    alive: {
      navItems: document.querySelectorAll('.nav-item').length,
      views: document.querySelectorAll('.view').length,
      dfViews: !!(window.DFViews && window.DFViews.OCCUPY),
      occLabel: window.DFViews && window.DFViews.OCCUPY ? window.DFViews.OCCUPY.label : null,
      bootError: (document.body.textContent.match(/启动失败|Uncaught|undefined/) || [null])[0]
    }
  };
  /* ② 战局列表：表头文字 + 挂的说明 + 窄屏下这列的宽度 */
  document.querySelector('[data-view="matches"]').click();
  await sleep(700);
  var th = [].slice.call(document.querySelectorAll('#matchTable thead th'))
    .filter(function (t) { return /占点/.test(t.textContent); })[0];
  out.matches = {
    thText: th && th.textContent.trim(),
    thTitle: th && (th.getAttribute('title') || '').slice(0, 26),
    thWidth: th && Math.round(th.getBoundingClientRect().width),
    tableWidth: Math.round(document.querySelector('#matchTable').getBoundingClientRect().width),
    wrapScrolls: (function () {
      var w = document.querySelector('#matchTable').parentElement;
      return getComputedStyle(w).overflowX === 'auto' && w.scrollWidth > w.clientWidth;
    })(),
    vw: window.innerWidth,
    bare: bare(document.querySelector('#view-matches'))
  };
  /* ③ 设置页：五档名字与滑杆下方的说明 */
  document.querySelector('[data-view="settings"]').click();
  await sleep(700);
  var names = [].slice.call(document.querySelectorAll('#wSliders .w-name'));
  out.settings = {
    rows: names.map(function (e) { return e.textContent.trim(); }),
    wrapped: names.filter(function (e) { return e.getBoundingClientRect().height > 24; })
      .map(function (e) { return e.textContent.trim(); }),
    occNote: (document.querySelector('#occNote') || {}).textContent,
    preview: (document.querySelector('#rateRulePreview') || {}).textContent
  };
  /* ④ 单场详情：阵营对比那一列与表下说明 */
  document.querySelector('[data-view="detail"]').click();
  await sleep(800);
  var d = document.querySelector('#view-detail');
  out.detail = {
    occThs: [].slice.call(d.querySelectorAll('table thead th'))
      .map(function (t) { return t.textContent.trim(); }).filter(function (t) { return /占点/.test(t); }),
    hint: [].slice.call(d.querySelectorAll('p.hint'))
      .map(function (p) { return p.textContent.trim(); }).filter(function (t) { return /站点分/.test(t); })[0],
    bare: bare(d)
  };
  /* ⑤ 其余各页扫一遍：除了刻意保留的「占点排名 / 占点效率」，不许再出现裸的旧名 */
  var pages = ['overview', 'winrate', 'maps', 'classes', 'rhythm'];
  out.others = {};
  for (var i = 0; i < pages.length; i++) {
    document.querySelector('[data-view="' + pages[i] + '"]').click();
    await sleep(500);
    out.others[pages[i]] = bare(document.querySelector('#view-' + pages[i]));
  }
  return JSON.stringify(out, null, 1);
})()
