/* 真机（MuMu WebView）探针：KPM 与阵营这两族在手机上到底画成什么样。
 *
 * 为什么要单独验：这轮改的全是渲染层的表格与卡片（core 那边只是多挂了几个派生字段），
 * 而桌面 browser-use 量到的一切都不等于装进 APK 的那份 —— 装配脚本的顺序、窄屏的撑破、
 * WebView 的类样式，只有设备上一份字节能证明。
 * 顺带钉一条"没骗人"：阵营那一格必须念 我方/对方，不许还是 1/2。
 *
 * 跑法：node tools/android-cdp.js --serial=127.0.0.1:16384 --file=test/device/kpm-camp-ui.js
 * 前置：手机里要有能进主界面的数据（跳过登录那条路），并且至少一场带全场名单。
 */
(async function () {
  await window.__dfReady;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function go(v) {
    var n = document.querySelector('.nav-item[data-view="' + v + '"]');
    if (n) n.click();
    return !!n;
  }
  var out = {};

  /* ★ 先进主界面：停在登录页时所有表格都是空的，那一跑量到的"没有 KPM 列 / 榜上没阵营"全是假的。
   *   （第一版就是这么红过一次 —— 报告能算出 4 场，页面一行都没画。） */
  var login = document.getElementById('loginView');
  if (login && !login.classList.contains('hidden')) {
    var skip = document.getElementById('btnSkipLogin');
    out.entered = { skipShown: !!skip && !skip.classList.contains('hidden') };
    if (skip && !skip.classList.contains('hidden')) {
      skip.click();
      for (var w = 0; w < 40; w++) {
        await sleep(300);
        var av = document.getElementById('appView');
        if (av && !av.classList.contains('hidden')) break;
      }
    }
    var av2 = document.getElementById('appView');
    out.entered.appViewShown = !!av2 && !av2.classList.contains('hidden');
  }

  /* ① 装载的就是这一族新判定（在页面里真调用，不查源码字样） */
  var An = window.DFCore && window.DFCore.Analysis;
  out.core = {
    kpmFloor: An ? An.KPM_MIN_SEC : null,
    /* 8 秒 3 杀那位必须爬不上榜；打满的人排第一（合成一份名单，纯算） */
    board: (function () {
      if (!An || typeof An.KPM_MIN_SEC !== 'number') return null;
      var mk = function (n, vid, color, kill, gt) {
        return { name: n, vopenid: vid, kill: kill, death: 3, assist: 0, score: kill * 300,
          occupy: 0, rescue: 0, color: color, team_id: color, game_time: gt,
          is_winner: 0, is_leave: 0, force_type: 10007 };
      };
      var ps = [mk('我', 'me1', 1, 20, 900), mk('满的', 'a2', 2, 40, 960),
        mk('八秒', 'a3', 2, 3, 8), mk('甲', 'a4', 1, 5, 700), mk('乙', 'a5', 2, 6, 700)];
      /* 这里不碰 store：只验 core 导出的地板常量与 matchMetric 的口径是否装到了页面上 */
      var km = An.matchMetric({ kill: 30, game_time: 1200 }, 'kill_per_min');
      return { floor: An.KPM_MIN_SEC, metric: km, ps: ps.length };
    })()
  };

  /* ② 总览：那六格里 KPM 顶掉了 KD 的位置 */
  go('overview');
  await sleep(500);
  var kpis = Array.prototype.map.call(document.querySelectorAll('#kpis .kpi .k'), function (x) {
    return x.textContent;
  });
  out.overview = {
    kpi: kpis.join(','),
    hasKpm: kpis.indexOf('KPM') >= 0,
    stripHasKd: (document.querySelector('#kpis').textContent.indexOf('KD') >= 0)
  };

  /* ③ 战局页：那颗"不过滤"的按钮念「全部」，表头有 KPM 列 */
  go('matches');
  await sleep(600);
  var seg = document.querySelector('#fRes .seg[data-res="all"]');
  var heads = Array.prototype.map.call(document.querySelectorAll('#matchTable thead th'), function (x) {
    return x.textContent;
  });
  out.matches = {
    allLabel: seg ? seg.textContent.trim() : null,
    heads: heads.join(','),
    hasKpm: heads.indexOf('KPM') >= 0,
    rows: document.querySelectorAll('#matchTable tbody tr').length,
    /* 窄屏（模拟器 360dp）下列表撑破页面就算红 */
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1
  };

  /* ④ 单场详情：阵营那一格 + 四张榜都有阵营列 + 已关注换色 */
  var picked = false;
  var trs = document.querySelectorAll('#matchTable tbody tr');
  for (var i = 0; i < trs.length && !picked; i++) {
    trs[i].click();
    await sleep(900);
    var box = document.getElementById('detailBox');
    if (box && box.textContent.indexOf('全场完整名单') >= 0) picked = true;
  }
  var box = document.getElementById('detailBox');
  var panels = box ? Array.prototype.slice.call(box.querySelectorAll('.panel')) : [];
  var boards = panels.filter(function (p) {
    var h = p.querySelector('h3');
    return h && /榜/.test(h.textContent);
  }).map(function (p) {
    var th = Array.prototype.map.call(p.querySelectorAll('thead th'), function (x) {
      return x.textContent;
    });
    return {
      title: p.querySelector('h3').textContent.trim().slice(0, 12),
      hasCamp: th.indexOf('阵营') >= 0,
      foot: (p.querySelector('.board-foot') || {}).textContent || ''
    };
  });
  var campCells = box ? Array.prototype.map.call(box.querySelectorAll('.camp-mine,.camp-out'),
    function (td) { return td.textContent; }) : [];
  /* 要点的是那颗写着「关注」的按钮：写成 .btn-on 的那颗是"取消关注"，
   * 盲点第二下会把上一跑标上的人摘掉，然后报"高亮没生效" —— 那是探针自己造的假红。 */
  var btns = box ? Array.prototype.slice.call(box.querySelectorAll('button[data-act="watch"]')) : [];
  var watchBtn = btns.filter(function (b) { return b.getAttribute('data-on') === '1'; })[0] || null;
  out.probe = { watchButtons: btns.length, claiming: watchBtn ? watchBtn.textContent.trim() : null };
  if (watchBtn) { watchBtn.click(); await sleep(1200); }
  box = document.getElementById('detailBox');
  var wRow = box ? box.querySelector('.row-watched') : null;
  var meRow = box ? box.querySelector('.row-me') : null;
  function colOf(el) {
    if (!el) return null;
    var td = el.querySelector('td.l');
    return td ? getComputedStyle(td).color : null;
  }
  out.detail = {
    opened: picked,
    boards: boards,
    kpmBoard: boards.some(function (b) { return b.title.indexOf('KPM') >= 0; }),
    campTexts: campCells.slice(0, 4).join(' / '),
    campHasDigit: /^\s*[12]\s*$/.test(campCells[0] || ''),
    rawColorShown: !!box && /<td>[12]<\/td>/.test(''),
    watchedColor: colOf(wRow),
    myColor: colOf(meRow),
    distinct: !!wRow && !!meRow && colOf(wRow) !== colOf(meRow)
  };
  /* ⑨ 攻防身份这一族（#84/#85）：列表那一格、详情标题、四张榜的攻防列、地图页那两处出口。
   *    ★ 一律"有没有"由 core 现算决定，不许写死条数：设备里那份库换没换、有几场攻防，探针不知道。 */
  var rep = await window.df.report({ mode: 'all', leave: 'all' });
  out.side = {};
  if (rep) {
    var withSide = (rep.series || []).filter(function (x) { return x.side; });
    out.side.coreSides = withSide.length;
    out.side.coreAttack = withSide.filter(function (x) { return x.side === '进攻'; }).length;
    /* 列表里那几格：地图名后面真跟着身份（只有该场有攻防之分时才要求） */
    var cells = Array.prototype.map.call(document.querySelectorAll('#matchTable tbody tr td.l'),
      function (td) { return (td.textContent || '').trim(); });
    go('matches'); await sleep(700);
    cells = Array.prototype.map.call(document.querySelectorAll('#matchTable tbody tr td.l'),
      function (td) { return (td.textContent || '').trim(); });
    out.side.listHasSideWord = cells.filter(function (t) {
      return /-(进攻|防守)/.test(t); }).length;
    /* 单场详情：标题带身份 + 榜上的攻防列 + 阵营/攻防那两格不许折行 */
    var trs2 = document.querySelectorAll('#matchTable tbody tr');
    var picked2 = null;
    for (var k = 0; k < trs2.length; k++) {
      trs2[k].click();
      await sleep(900);
      var bx = document.getElementById('detailBox');
      if (bx && /榜/.test(bx.textContent)) { picked2 = bx; break; }
    }
    var h3 = picked2 ? (picked2.querySelector('h3') || {}).textContent || '' : '';
    out.side.detailTitle = h3.trim().slice(0, 40);
    out.side.detailHasSide = /·\s*(进攻|防守)/.test(h3);
    var boards2 = picked2 ? Array.prototype.slice.call(picked2.querySelectorAll('table')).filter(function (t) {
      return /阵营/.test((t.querySelector('thead') || {}).textContent || '');
    }) : [];
    out.side.boardsWithSideCol = boards2.filter(function (t) {
      return /攻防/.test((t.querySelector('thead') || {}).textContent || '');
    }).length;
    out.side.boardCount = boards2.length;
    /* 同一格里不许出现第二行（#88 那两条的判据在设备上再量一遍） */
    var worst = 0;
    Array.prototype.forEach.call(picked2 ? picked2.querySelectorAll('td.camp') : [], function (td) {
      var rg = document.createRange();
      rg.selectNodeContents(td);
      var n = rg.getClientRects().length;
      if (n > worst) worst = n;
    });
    out.side.campWorstLines = worst;
    out.side.campCellCount = (picked2 ? picked2.querySelectorAll('td.camp').length : 0);
    /* 地图页：顶部那张总对照 + 地图表那一列 */
    go('maps'); await sleep(900);
    var mb = document.getElementById('mapBox');
    var mbText = mb ? (mb.textContent || '').replace(/\s+/g, ' ') : '';
    out.side.mapSummaryShown = /进攻侧胜率|各 \d+ 场|两边区间重叠|都没带上阵营编号/.test(mbText);
    /* ★ 这里必须扫所有 thead：顶部那张总对照自己也是一张 mini-table（身份/场次/胜/胜率/区间），
     *   第一版只看了 mapBox 里第一个 thead，于是把"总对照画出来了"读成"攻防胜率那一列没画"。 */
    out.side.mapColHeader = !!mb && Array.prototype.some.call(mb.querySelectorAll('thead'), function (th) {
      return /攻防胜率/.test(th.textContent || '');
    });
    out.side.sidesHeadline = rep.sides ? String(rep.sides.headline || '').slice(0, 60) : null;
    /* ⑩ 对手与队友的模式筛选（#87）：页面念的场数 == 同一筛选下 core 算的场数 */
    go('encounters'); await sleep(1000);
    function scannedNow() {
      var v = document.getElementById('view-encounters');
      var m = /扫描\s*(\d+)\s*场/.exec(String(v ? v.textContent : '').replace(/\s+/g, ' '));
      return m ? Number(m[1]) : -1;
    }
    var repSw = await window.df.report({ mode: 'swtwr', leave: 'all' });
    out.filter = {
      pageAll: scannedNow(),
      coreAll: rep && rep.encounters ? rep.encounters.scanned : -2,
      pageSwwrBefore: -1,
      coreSwwr: repSw && repSw.encounters ? repSw.encounters.scanned : -2
    };
    var swBtn = document.querySelector('#fMode [data-mode="swtwr"]');
    if (swBtn) { swBtn.click(); await sleep(1400); }
    out.filter.pageSwwrAfter = scannedNow();
    var allBtn = document.querySelector('#fMode [data-mode="all"]');
    if (allBtn) { allBtn.click(); await sleep(1200); }
    out.filter.pageBackToAll = scannedNow();
    /* ⑪ 交手档案的逐项对照（#86）：点一个人，那张表要在，五项都要念得出 */
    var prow = document.querySelector('#view-encounters tbody tr[data-key]');
    out.compare = { personRow: !!prow };
    if (prow) { prow.click(); await sleep(1600); }
    var enc = document.getElementById('encDetail');
    var et = enc ? (enc.textContent || '').replace(/\s+/g, ' ') : '';
    out.compare.shown = /逐项对照/.test(et);
    out.compare.items = ['击杀数', '死亡数', 'KPM（每分钟击杀）', '分均得分', '累计时长']
      .filter(function (w) { return et.indexOf(w) >= 0; }).length;
    /* ⑫ 分享卡：Canvas 上落的那一行字，设备上收一遍（卡片在手机上走 SAF 保存，这里只验画得出） */
    go('matches'); await sleep(700);
    var rid = (document.getElementById('roomPick') || {}).value || '';
    out.card = { rid: rid ? '有' : '无' };
    if (rid && window.DFViews) {
      var cmp2 = await window.df.match(rid);
      var rec2 = [];
      var origGc = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (tp) {
        var ctx = origGc.apply(this, arguments);
        if (ctx && tp === '2d') {
          var ft = ctx.fillText;
          ctx.fillText = function (s) { rec2.push(String(s)); return ft.apply(ctx, arguments); };
        }
        return ctx;
      };
      var url2 = '';
      try { url2 = String(window.DFViews.drawMatchCard(cmp2) || ''); } catch (e) { out.card.err = String(e); }
      HTMLCanvasElement.prototype.getContext = origGc;
      out.card.hasKpm = rec2.indexOf('KPM') >= 0;
      out.card.hasKdTile = rec2.indexOf('KD') >= 0;
      out.card.title = rec2.length ? rec2[0] : '';
      out.card.sideInTitle = !!(cmp2 && cmp2.match && cmp2.match.side) ?
        rec2[0].indexOf('-' + cmp2.match.side) >= 0 : null;
      out.card.png = url2.indexOf('data:image/png') === 0 && url2.length > 4000;
    }
    /* ⑬ 本机字典（#92）：在这一台设备上真点一遍 —— 桥的 dict / setName 两条只有这么量得出活着。
     *   改一名再还原一名，落的是这台手机自己的 accounts.json（宿主那侧），界面两处都要跟上。 */
    out.dict = {};
    go('settings'); await sleep(900);
    var dbtn = document.getElementById('btnMapDict');
    out.dict.hasBtn = !!dbtn;
    out.dict.statusBefore = ((document.getElementById('mapNamesText') || {}).textContent || '').trim();
    if (dbtn) {
      dbtn.click(); await sleep(1300);
      var box = document.getElementById('mapDictBox');
      out.dict.open = !!box && !box.classList.contains('hidden') && box.offsetHeight > 0;
      out.dict.rows = box ? box.querySelectorAll('tbody tr').length : -1;
      out.dict.inputs = !!(document.getElementById('dictMapId') &&
        document.getElementById('dictMapName') && document.getElementById('dictSave'));
      var eb = box ? box.querySelector('[data-dict-act="edit"]') : null;
      out.dict.pick = eb ? String(eb.getAttribute('data-dict-id') || '') : '';
      if (out.dict.pick) {
        document.getElementById('dictMapId').value = out.dict.pick;
        document.getElementById('dictMapName').value = '设备探针名';
        document.getElementById('dictSave').click(); await sleep(2000);
        out.dict.renameShown = String((box || {}).textContent || '').indexOf('设备探针名') >= 0;
        out.dict.statusAfter = ((document.getElementById('mapNamesText') || {}).textContent || '').trim();
        out.dict.statusSaysUser = /我改的 \d+ 张/.test(out.dict.statusAfter);
        /* 还原：同一编号留空再存一次，那块与顶上那行都该退回去 */
        document.getElementById('dictMapId').value = out.dict.pick;
        document.getElementById('dictMapName').value = '';
        document.getElementById('dictSave').click(); await sleep(2000);
        out.dict.reverted = String((box || {}).textContent || '').indexOf('设备探针名') < 0 &&
          !/我改的 \d+ 张/.test(((document.getElementById('mapNamesText') || {}).textContent || ''));
      }
    }
  }
  return JSON.stringify(out);
})();
