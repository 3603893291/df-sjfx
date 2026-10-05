/* app.js — 应用引导、登录、全局筛选、导航与数据装配 */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    loggedIn: false,
    offline: false,
    matchCount: 0,
    rep: null,
    matches: [],
    ratingMap: {},
    settings: {}
  };

  /* 全局筛选条件：作用于所有页面。
   * kind 是「对局类型」这一根**独立轴**（all|comp|practice）：模式那根是官方分类，
   * 这一根是用户手工标的「这算不算比赛」——软件没有识别能力，只认他点过的那颗。 */
  var FILTERS = { mode: 'all', kind: 'all', leave: 'all', since: 0 };

  /* ★ 只作用于「战局」这一张表的客户端筛选：不参与任何统计口径，也不进 queryFilters()。
   *   两套筛选长得像但语义不同，所以控件放在页内工具条并写明「只筛这张表」。 */
  var MATCH_FILTER = { cls: 'all', res: 'all', rate: '', roster: false, watch: false };
  /* 兵种只能靠 force_type 首位推（渲染层没有 core/maps.js）：1突击 2医疗 3工程 4侦查 5指挥官 */
  var RATE_BANDS = { 90: [90, 1e9], 75: [75, 90], 60: [60, 75], 40: [40, 60], 0: [-1, 40] };

  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.classList.remove('show'); }, 3400);
  }

  /* Electron 渲染进程不支持 window.confirm，这里用页内对话框替代
   * confirmDialog({ title, message, okLabel, danger, choices:[{value,title,desc}] })
   *   无 choices → resolve(true|false)
   *   有 choices → resolve(选中 value) 或 null（取消）
   */
  function confirmDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var mask = $('confirmDlg');
      var box = $('confirmChoices');
      var body = $('confirmMsg');
      var okBtn = $('confirmOk');
      var cancelBtn = $('confirmCancel');
      $('confirmTitle').textContent = opts.title || '请确认';
      body.innerHTML = opts.message || '';
      var choices = opts.choices || null;
      if (choices && choices.length) {
        box.innerHTML = choices.map(function (c, i) {
          return '<label><input type="radio" name="cdchoice" value="' + i + '"' +
            (i === 0 ? ' checked' : '') + '>' +
            '<span><span class="opt-t">' + (c.title || '') + '</span>' +
            '<span class="opt-x">' + (c.desc || '') + '</span></span></label>';
        }).join('');
        box.style.display = '';
      } else {
        box.innerHTML = '';
        box.style.display = 'none';
      }
      okBtn.textContent = opts.okLabel || '确定';
      okBtn.className = 'btn ' + (opts.danger ? 'dlg-danger' : 'btn-primary');
      cancelBtn.textContent = opts.cancelLabel || '取消';
      mask.style.display = '';

      function cleanup() {
        mask.style.display = 'none';
        okBtn.onclick = null;
        cancelBtn.onclick = null;
        mask.onclick = null;
      }
      okBtn.onclick = function () {
        if (choices && choices.length) {
          var sel = mask.querySelector('input[name=cdchoice]:checked');
          var idx = sel ? Number(sel.value) : 0;
          cleanup(); resolve(choices[idx].value);
        } else { cleanup(); resolve(true); }
      };
      cancelBtn.onclick = function () {
        cleanup(); resolve(choices && choices.length ? null : false);
      };
      mask.onclick = function (e) {
        if (e.target === mask) {
          cleanup(); resolve(choices && choices.length ? null : false);
        }
      };
    });
  }

  function sinceTs() {
    if (!FILTERS.since) return undefined;
    return Math.floor(Date.now() / 1000) - FILTERS.since * 86400;
  }

  function queryFilters() {
    return { mode: FILTERS.mode, kind: FILTERS.kind, leave: FILTERS.leave, since: sinceTs() };
  }

  /* ---------------- 登录 ---------------- */
  /* ★ "连问几轮没角色才改口"的阈值、计数和那句话都在 core/collector.js 的 probeLogin 里，
   *   由 shell 原样转在这条事件的 advice 字段上（这一层按规矩不许碰 core，只排版）。 */

  function showLogin(msg, kind) {
    $('loginView').classList.remove('hidden');
    $('appView').classList.add('hidden');
    var s = $('loginStatus');
    if (msg) { s.textContent = msg; s.className = 'login-status ' + (kind || ''); }
    /* ★ 有本机数据才给跳：断网 / 官方接口挂掉时这是看到已有数据的唯一路径；
     *   而一场都没采到过的时候跳进去是一整屏空面板，比停在登录页更误导人（他当场问过"没数据为什么还能跳"）。 */
    var can = state.matchCount > 0;
    $('btnSkipLogin').classList.toggle('hidden', !can);
    $('skipHint').textContent = can
      ? '本机已存有战绩数据，可以离线查看全部分析页面；同步需要登录成功后再进行。'
      : '这台机器还没有战绩数据（一场都没采到过），先登录采集一次再看分析 —— 现在进去也全是空的。';
    $('skipHint').classList.remove('hidden');
    setOffline(false);
  }

  /* 侧栏在 ≤900px 是抽屉（app.css 那一节），默认关着。
   * 「刚进主界面」这一下例外：竖屏上第一次进来的人看不见左侧那串功能项，会以为软件只有眼前这一页。 */
  function isNarrow() {
    return !!(global.matchMedia && global.matchMedia('(max-width: 900px)').matches);
  }

  function showApp(opts) {
    $('loginView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    if (opts && opts.revealNav && isNarrow()) {
      switchView('overview');
      setNavDrawer(true);
    }
    global.DFCharts.resize();
    refreshPlugins();
  }

  function setOffline(on) {
    state.offline = !!on;
    $('offlineBar').classList.toggle('hidden', !on);
  }

  /* 离线进入：只读本机数据，report / matches / counts 全是本地 IPC，一个字节也不出网 */
  function enterOffline(count, localOnly) {
    setOffline(true);
    $('offlineText').textContent = localOnly
      ? '只读账号 · 本机 ' + count + ' 场由数据包导入 · 这台机器没有它的 WeGame 会话，不能同步'
      : count > 0
        ? '离线模式 · 本机 ' + count + ' 场可查看全部分析 · 未同步新场次'
        : '未登录 · 本机还没有战绩数据 · 登录后点「立即同步」即可采集';
    showApp({ revealNav: !localOnly });
    refresh().catch(function (e) {
      toast('读取本机数据失败：' + (e.message || e), true);
    });
  }

  function retryFromOffline() {
    var btn = $('btnOfflineRetry');
    if (btn) { btn.disabled = true; btn.textContent = '检查中…'; }
    function restore() {
      if (!btn) return;
      btn.disabled = false;
      btn.textContent = '重试登录并同步';
    }
    global.df.checkLogin().then(function (r) {
      restore();
      if (r && r.ok) {
        state.loggedIn = true;
        setOffline(false);
        toast('登录已恢复，开始同步');
        refresh().then(doSync);
      } else {
        /* 壳能给出具体原因（只读号 / 未登录）就直接说那句，别拿"网络不稳定"糊过去 */
        var why = (r && (r.reason || r.message || r.error)) || '';
        toast(why || '仍未连上官方接口，可继续查看本机数据', true);
      }
    }, function (e) {
      restore();
      toast('检查登录状态失败：' + ((e && e.message) || e), true);
    });
  }

  function checkLogin(silent) {
    var s = $('loginStatus');
    if (!silent) { s.textContent = '正在检查登录状态…'; s.className = 'login-status'; }
    return global.df.checkLogin().then(function (r) {
      state.loggedIn = r.ok;
      if (r.ok) {
        s.textContent = '已登录：' + (r.role.name || r.role.openid);
        s.className = 'login-status ok';
        setOffline(false);
        showApp({ revealNav: true });
        return true;
      }
      showLogin('尚未登录。点下面的按钮打开 WeGame 登录窗口，登录成功后会自动进入。', '');
      return false;
    });
  }

  /* ---------------- 数据装配 ---------------- */
  function refresh() {
    var q = queryFilters();
    return Promise.all([
      global.df.report(q),
      global.df.matches(q)
    ]).then(function (res) {
      var rep = res[0], matches = res[1];
      state.rep = rep;
      state.matches = matches;
      state.settings = rep.settings || {};
      state.matchCount = (rep.stored && rep.stored.total) || (rep.filtered && rep.filtered.poolSize) || 0;

      // 评分映射（战局列表用）
      var map = {};
      (rep.ratingSeries || []).forEach(function (x) { map[x.roomId] = x.value; });
      state.ratingMap = map;

      renderProfile(rep);
      global.DFViews.renderOverview(rep);
      global.DFViews.renderWinRate(rep);
      global.DFViews.renderMaps(rep);
      global.DFViews.renderClasses(rep);
      global.DFViews.renderMatrix(rep);
      global.DFViews.renderPeriods(rep);
      global.DFViews.renderEncounters(rep);
      global.DFViews.renderRhythm(rep);
      global.DFViews.renderRateRule(rep);
      renderFilterCount(rep);
      updateStatsLine(rep);
      bindSeeAll();
      applyMatchFilters();
      buildRoomPicker();
    });
  }

  function renderProfile(rep) {
    var name = rep.name || '未同步';
    $('profileName').textContent = name;
    $('avatar').textContent = (name && name !== '未同步') ? name.slice(-1) : '—';
    var extra = rep.stored && rep.stored.excluded ? ' · 已排除 ' + rep.stored.excluded + ' 场' : '';
    $('profileSub').textContent = '纳入 ' + rep.counts.all + ' 场 · 胜者为王 ' +
      rep.counts.swtwr + ' 场' + extra;
    var st = rep.lastSync ? new Date(rep.lastSync) : null;
    var txt = st ? '上次同步 ' + st.toLocaleString('zh-CN', { hour12: false }) : '尚未同步';
    /* 取消开机自动同步后，这一行是判断数据新鲜度的唯一线索，超过一天要显式提醒 */
    if (st && Date.now() - st.getTime() > 24 * 3600 * 1000) {
      txt += ' <span class="tag tag-soft">较久未同步</span>';
    }
    /* 检测到整窗滚过就挂在最显眼处：这类漏采不可补，越早看见越少丢 */
    if (rep.sync && rep.sync.doubt && rep.sync.doubt.suspect) {
      txt += ' <span class="tag tag-danger">疑似漏采</span>';
    }
    /* 最近一轮翻了几页、留下几条（core 的 pageTrace 落进账本的那几个字段）：
     * 「只有 N 场」到底是官方窗口到底还是我们提前停，这一眼就能分清；细则在「状态与节律」 */
    var wins = (rep.sync && rep.sync.windows) || [];
    var lastWin = wins[wins.length - 1];
    if (lastWin && lastWin.pages) {
      txt += ' · 最近一轮 ' + lastWin.pages + ' 页 / 留下 ' + (lastWin.kept || 0) + ' 条';
    }
    $('syncState').innerHTML = txt;
  }

  function renderFilterCount(rep) {
    var f = rep.filtered, s = rep.stored || { total: f.poolSize, excluded: 0 };
    /* 范围那句的措辞取自 core（filterKindLabel），界面不自己再编一句 —— 免得两处说法不一样 */
    var scope = rep.filters && rep.filters.kind && rep.filters.kind !== 'all'
      ? ' · 当前对局范围：' + rep.filterKindLabel : '';
    $('filterCount').innerHTML = '筛选后 <b>' + f.total + '</b> 场 / 纳入统计 ' +
      f.poolSize + ' 场（本地共 ' + s.total + ' 场，已排除 ' + s.excluded + ' 场）' + scope;
  }

  function updateStatsLine(rep) {
    var s = rep.stored || { total: rep.counts.all, excluded: 0 };
    $('statsLine').innerHTML =
      '本地已存战局 <b>' + s.total + '</b> 场，纳入统计 <b>' + rep.counts.all + '</b> 场' +
      (s.excluded ? '（<b>' + s.excluded + '</b> 场已在单场详情里标记为不纳入）' : '') +
      '，其中胜者为王 <b>' + rep.counts.swtwr + '</b> 场（指挥官 <b>' + rep.counts.commander +
      '</b> 场，手动标记）、其他 <b>' + rep.counts.other + '</b> 场；' +
      /* 比赛/匹配是**人工那一枚**，与模式正交，所以另起一句而不是塞进上面那串括号里。
       * 「场数少就别给结论」这条不由这里判 —— 各面板照旧走 core 的 reliability/暂无结论。 */
      '按你手动标记的对局类型分：<b>' + rep.counts.comp + '</b> 场算比赛、<b>' + rep.counts.practice +
      '</b> 场算匹配（比赛只在胜者为王里能标，被「不纳入统计」挡住的哪边都不算）；' +
      '全场名单 <b>' + (rep.rosters || 0) + '</b> 份，涉及玩家 <b>' +
      (rep.players || 0) + '</b> 条记录。' +
      '<br>官方每次返回最近 5 页约 36 场，更早的场次不再返回，定期同步即可持续积累。';
  }

  /* ---------------- 战局列表的页内筛选（只影响这张表） ---------------- */
  function applyMatchFilters() {
    var kw = ($('fMapKw') && $('fMapKw').value || '').trim();
    var rows = state.matches;
    var total = rows.length;
    var f = MATCH_FILTER;
    if (kw) rows = rows.filter(function (m) { return String(m.map_name || '').indexOf(kw) !== -1; });
    if (f.cls !== 'all') {
      rows = rows.filter(function (m) { return String(m.force_type || '').charAt(0) === f.cls; });
    }
    if (f.res === 'win') rows = rows.filter(function (m) { return !!m.is_winner; });
    else if (f.res === 'lose') rows = rows.filter(function (m) { return !m.is_winner; });
    if (f.roster) rows = rows.filter(function (m) { return m.hasRoster !== false; });
    if (f.watch) rows = rows.filter(function (m) { return (m.watchedCount || 0) > 0; });
    if (f.rate !== '') {
      var band = RATE_BANDS[f.rate] || [-1, 1e9];
      rows = rows.filter(function (m) {
        var r = state.ratingMap[m.room_id];
        return r != null && r >= band[0] && r < band[1];
      });
    }
    global.DFViews.renderMatches(rows, {
      onPick: function (rid) { openDetail(rid); },
      poolSize: state.rep ? state.rep.filtered.poolSize : 0,
      ratingOf: function (m) { return state.ratingMap[m.room_id]; },
      total: total
    });
  }

  function resetMatchTools() {
    MATCH_FILTER.cls = 'all'; MATCH_FILTER.res = 'all';
    MATCH_FILTER.rate = ''; MATCH_FILTER.roster = false; MATCH_FILTER.watch = false;
    Array.prototype.forEach.call($('fCls').querySelectorAll('.seg'), function (b) {
      b.classList.toggle('active', b.dataset.cls === 'all');
    });
    Array.prototype.forEach.call($('fRes').querySelectorAll('.seg'), function (b) {
      b.classList.toggle('active', b.dataset.res === 'all');
    });
    $('fRate').value = '';
    $('fRoster').checked = false; $('fWatch').checked = false;
  }

  function bindMatchTools() {
    if (!$('fCls')) return;
    Array.prototype.forEach.call($('fCls').querySelectorAll('.seg'), function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call($('fCls').querySelectorAll('.seg'), function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        MATCH_FILTER.cls = b.dataset.cls;
        applyMatchFilters();
      });
    });
    Array.prototype.forEach.call($('fRes').querySelectorAll('.seg'), function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call($('fRes').querySelectorAll('.seg'), function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        MATCH_FILTER.res = b.dataset.res;
        applyMatchFilters();
      });
    });
    $('fRate').addEventListener('change', function () { MATCH_FILTER.rate = this.value; applyMatchFilters(); });
    $('fRoster').addEventListener('change', function () { MATCH_FILTER.roster = this.checked; applyMatchFilters(); });
    $('fWatch').addEventListener('change', function () { MATCH_FILTER.watch = this.checked; applyMatchFilters(); });
    $('btnClearMt').addEventListener('click', function () {
      resetMatchTools();
      var kw = $('fMapKw'); if (kw) kw.value = '';
      applyMatchFilters();
    });
  }

  /* ---------------- 单场详情 ---------------- */
  function buildRoomPicker() {
    var sel = $('roomPick');
    var rows = state.matches;
    if (!rows.length) { sel.innerHTML = '<option>暂无对局</option>'; return; }
    sel.innerHTML = rows.map(function (m) {
      return '<option value="' + m.room_id + '">' +
        String(m.dt_event_time || '').slice(5, 16) + ' · ' + m.map_name +
        ' · ' + global.DFViews.modeText(m) +
        ' · ' + (m.is_winner ? '胜' : '负') +
        (m.excluded ? ' · 已排除' : '') + '</option>';
    }).join('');
    sel.onchange = function () { openDetail(sel.value); };

    // 只有当前就停在「单场详情」页时才自动加载；否则切筛选会被强制跳转到该页
    if ($('view-detail').classList.contains('active')) {
      openDetail(rows[0].room_id, { keepView: true });
    } else {
      sel.value = rows[0].room_id;
    }
  }

  function openDetail(rid, opts) {
    if (!rid) return;
    opts = opts || {};
    var sel = $('roomPick');
    if (sel) sel.value = rid;
    if (!opts.keepView) switchView('detail');
    var box = $('detailBox');
    box.dataset.loaded = '0';
    box.innerHTML = '<div class="panel"><div class="skeleton" style="height:140px"></div></div>';
    var token = String(rid);
    box.dataset.rid = token;
    global.df.match(rid).then(function (c) {
      // 防止快速切换时旧请求覆盖新内容
      if (box.dataset.rid !== token) return;
      global.DFViews.renderDetail(c);
      box.dataset.loaded = '1';
    });
  }

  /* 切到详情页时，若还没加载过就自动加载当前选中的那场 */
  function ensureDetailLoaded() {
    var box = $('detailBox');
    if (!box || box.dataset.loaded === '1') return;
    var sel = $('roomPick');
    var rid = sel && sel.value;
    if (rid) openDetail(rid, { keepView: true });
  }

  /* ---------------- 竖屏导航抽屉 ----------------
   * ≤900px 时侧栏被 CSS 变成从左推出来的浮层（app.css 末尾那一节），这里只管三件事：
   * 开关、遮罩、Esc。宽屏上那颗按钮是 display:none，绑了也不会被点到。
   * 每个取元素都判空 —— 抛一次会把 DOMContentLoaded 里后面的 bind 全带走（§7 坑 23）。 */
  function navDrawerOpen() {
    return document.body.classList.contains('nav-open');
  }
  function setNavDrawer(on) {
    document.body.classList.toggle('nav-open', !!on);
    var b = document.getElementById('btnNavDrawer');
    if (b) b.setAttribute('aria-expanded', on ? 'true' : 'false');
  }
  function bindNavDrawer() {
    var b = document.getElementById('btnNavDrawer');
    if (b) b.addEventListener('click', function () { setNavDrawer(!navDrawerOpen()); });
    var s = document.getElementById('navScrim');
    if (s) s.addEventListener('click', function () { setNavDrawer(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && navDrawerOpen()) setNavDrawer(false);
    });
  }

  /* ---------------- 导航 ---------------- */
  function switchView(name) {
    setNavDrawer(false);
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
      b.classList.toggle('active', b.dataset.view === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) {
      v.classList.toggle('active', v.id === 'view-' + name);
    });
    // 隐藏状态下渲染的图表容器尺寸为 0，切回来必须重画，否则图表空白
    rerenderView(name);
    if (name === 'detail') ensureDetailLoaded();
    if (name === 'sandbox') ensureSandboxLoaded();
    if (name === 'plugin') pluginEnsurePage();
    document.body.classList.toggle('bare-view', name === 'sandbox' || name === 'about' || name === 'plugin');
    setTimeout(function () { global.DFCharts.resize(); }, 60);
  }

  /* 用缓存数据重画当前可见页（保证图表拿到正确尺寸） */
  function rerenderView(name) {
    var rep = state.rep;
    if (!rep) return;
    try {
      if (name === 'overview') global.DFViews.renderOverview(rep);
      else if (name === 'winrate') {
        global.DFViews.renderWinRate(rep);
        global.DFViews.renderPeriods(rep);
      } else if (name === 'maps') {
        global.DFViews.renderMaps(rep);
        global.DFViews.renderMatrix(rep);
      } else if (name === 'classes') global.DFViews.renderClasses(rep);
      else if (name === 'encounters') global.DFViews.renderEncounters(rep);
      else if (name === 'rhythm') {
        global.DFViews.renderRhythm(rep);
        global.DFViews.renderRateRule(rep);
      }
    } catch (e) { /* 渲染失败不阻断导航 */ }
  }

  /* ---------------- 同步 ---------------- */
  function doSync() {
    if (state.offline) {
      toast('离线模式下不能同步，请先点上方横幅的「重试登录并同步」', true);
      return;
    }
    var btn = $('btnSync');
    btn.disabled = true;
    btn.textContent = '同步中…';
    $('syncState').textContent = '正在采集数据…';
    global.df.sync({
      withDetail: state.settings.autoSyncDetail !== false,
      detailScope: state.settings.detailScope || 'all'
    }).then(function (r) {
      btn.disabled = false;
      btn.textContent = '立即同步';
      if (r.ok) {
        toast('同步完成：新增 ' + r.inserted + ' 场，去重 ' + r.duplicates +
          ' 场，名单 ' + r.players + ' 条' +
          (r.missingRosters ? '（' + r.missingRosters + ' 场待补名单，下次同步自动补采）' : '') +
          (r.errors && r.errors.length ? '（' + r.errors.length + ' 项接口异常）' : ''));
      } else if (r.notLogin) {
        toast('登录已失效，请重新登录', true);
        showLogin('登录已失效，请重新登录 WeGame。', 'err');
      } else {
        toast('同步失败：' + (r.error || '未知错误'), true);
      }
      refresh();
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = '立即同步';
      toast('同步异常：' + (e.message || e), true);
    });
  }

  /* ---------------- 筛选栏 ---------------- */
  function bindFilters() {
    Array.prototype.forEach.call($('fMode').querySelectorAll('.seg'), function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call($('fMode').querySelectorAll('.seg'), function (x) {
          x.classList.remove('active');
        });
        b.classList.add('active');
        FILTERS.mode = b.dataset.mode;
        refresh();
      });
    });
    Array.prototype.forEach.call($('fLeave').querySelectorAll('.seg'), function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call($('fLeave').querySelectorAll('.seg'), function (x) {
          x.classList.remove('active');
        });
        b.classList.add('active');
        FILTERS.leave = b.dataset.leave;
        refresh();
      });
    });
    /* 「对局」这一根只有两颗（竖屏放不下第三颗，见 index.html 那段注释），
     * 所以「回到全部」靠再点一次当前那颗：两颗都不高亮就是全部。
     * 顶上那句计数会把当前范围念出来，不靠按钮自己说明。 */
    Array.prototype.forEach.call($('fKind').querySelectorAll('.seg'), function (b) {
      b.addEventListener('click', function () {
        var on = b.classList.contains('active');
        Array.prototype.forEach.call($('fKind').querySelectorAll('.seg'), function (x) {
          x.classList.remove('active');
        });
        if (!on) b.classList.add('active');
        FILTERS.kind = on ? 'all' : b.dataset.kind;
        refresh();
      });
    });
    $('fSince').addEventListener('change', function () {
      FILTERS.since = Number(this.value) || 0;
      refresh();
    });
  }

  function bindSeeAll() {
    var b = document.getElementById('btnSeeAll');
    if (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call($('fMode').querySelectorAll('.seg'), function (x) {
          x.classList.toggle('active', x.dataset.mode === 'all');
        });
        FILTERS.mode = 'all';
        /* 「看全部」要把两根轴一起归零：只清模式的话，用户按下它看到的还是"只剩匹配局"，
         * 而那正是这颗按钮的反面承诺。 */
        Array.prototype.forEach.call($('fKind').querySelectorAll('.seg'), function (x) {
          x.classList.toggle('active', x.dataset.kind === 'all');
        });
        FILTERS.kind = 'all';
        refresh().then(function () { switchView('matches'); });
      });
    }
  }

  /* ---------------- 对手队友：交手档案 ---------------- */
  function bindEncounters() {
    var view = document.getElementById('view-encounters');
    if (!view) return;
    view.addEventListener('click', function (evt) {
      if (evt.target && evt.target.id === 'encDetailClose') {
        $('encDetail').style.display = 'none';
        return;
      }
      var tr = evt.target && evt.target.closest ? evt.target.closest('tr[data-key]') : null;
      if (!tr) return;
      openEncounter(tr.dataset.key, tr.dataset.name);
    });
  }

  function openEncounter(key, name) {
    var box = $('encDetail');
    box.style.display = '';
    box.innerHTML = '<h3>交手档案 · ' + global.DFViews.esc(name || '') + '</h3>' +
      '<p class="hint">正在统计同场记录…</p>';
    try { box.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}

    /* 带着筛选栏那份条件去（#87）：这一页要与「对手与队友」同进同退 */
    global.df.encounterDetail(key, FILTERS).then(function (d) {
      global.DFViews.renderEncounterDetail(d, key, name);
      try { box.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
    }).catch(function (err) {
      box.innerHTML = '<h3>交手档案 · ' + global.DFViews.esc(name || '') + '</h3>' +
        '<p class="hint">读取失败：' + global.DFViews.esc(String(err && err.message || err)) + '</p>';
    });
  }

  /* ---------------- 单场标注（指挥官 / 不纳入统计） ---------------- */
  function bindMatchFlags() {
    var box = $('detailBox');
    if (!box) return;
    box.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      var key = btn.getAttribute('data-act');
      if (key === 'watch') {
        var wOn = btn.getAttribute('data-on') === '1';
        btn.disabled = true;
        global.df.setWatch(btn.getAttribute('data-key'), wOn, {
          openid: btn.getAttribute('data-openid') || '', name: btn.getAttribute('data-name') || ''
        }).then(function (r) {
          btn.disabled = false;
          if (!r || !r.ok) { toast((r && r.error) || '操作失败', true); return; }
          toast(wOn ? ('已关注，只存本机；换电脑或导出数据包都不带它') : '已取消关注');
          var rid = box.dataset.rid;
          refresh().then(function () { if (rid) openDetail(rid, { keepView: true }); });
        }).catch(function (err) {
          btn.disabled = false;
          toast('操作失败：' + ((err && err.message) || err), true);
        });
        return;
      }
      if (key !== 'commander' && key !== 'excluded' && key !== 'competition') return;
      var rid = box.dataset.rid;
      if (!rid) return;
      btn.disabled = true;
      global.df.setFlag(rid, key, btn.getAttribute('data-on') === '1').then(function (r) {
        if (!r || !r.ok) {
          btn.disabled = false;
          toast('保存标记失败：' + ((r && r.error) || '未知原因'), true);
          return;
        }
        if (key === 'commander') {
          toast(r.flags && r.flags.commander
            ? '已标记：本场同时计入「胜者为王」和「指挥官」，仍只算一场战局'
            : '已取消指挥官标记');
        } else if (key === 'competition') {
          /* ★ 措辞老实：这一枚完全是人工认定，软件没有识别能力（真库量过，官方字段里没有"比赛"这个信息）。
           *   同时把「被排除的那场两边都不计」说在前面，否则他标完去看「比赛」发现是零场，只会以为坏了。 */
          var ex = !!(r.flags && r.flags.excluded);
          if (r.flags && r.flags.competition) {
            toast(ex
              ? '已标为比赛，但本场同时被「不纳入统计」挡着：切到比赛或匹配都不会出现，去掉不纳入才计入'
              : '已标为比赛：把顶部「对局」切到「比赛」就只统计这类局（样本少时软件不给结论）');
          } else {
            toast('已取消比赛标记，这一场回到「匹配」');
          }
        } else {
          toast(r.flags && r.flags.excluded
            ? '本场已从各项统计中剔除，战局列表仍灰显保留，可随时恢复'
            : '已恢复纳入统计');
        }
        refresh().then(function () { openDetail(rid, { keepView: true }); });
      }).catch(function (err) {
        btn.disabled = false;
        toast('保存标记失败：' + (err && err.message || err), true);
      });
    });
  }

  /* ---------------- 地图沙盘（内嵌第三方工具） ---------------- */
  var sandbox = { url: '', attached: false, failed: false };

  function sandboxEl() { return $('sandboxView'); }

  /* UA 里有 Electron 不代表 <webview> 可用（嵌入式 Chromium 也会报 Electron/x），
     所以直接探测元素能力；不支持时走兜底层而不是留一块空白 */
  function sandboxSupported() {
    try {
      var probe = document.createElement('webview');
      return !!(probe && typeof probe.reload === 'function');
    } catch (e) { return false; }
  }

  function showSandboxFallback(on) {
    var f = $('sandboxFallback');
    if (f) f.style.display = on ? '' : 'none';
  }

  /* 只有真正切到该页才加载：写死 src 会让离线启动先吃一次失败加载并露错误页 */
  function ensureSandboxLoaded() {
    var wv = sandboxEl();
    if (!wv) return;
    if (!sandboxSupported()) {
      showSandboxFallback(true);
      var hint = wv.parentNode.querySelector('.sandbox-fallback .hint');
      if (hint && !sandbox.failed) {
        hint.textContent = '当前运行环境不支持内嵌第三方站点（需用桌面版打开），' +
          '可点下方「在浏览器中打开」访问。';
      }
      return;
    }
    if (!sandbox.attached) {
      sandbox.attached = true;
      wv.addEventListener('did-fail-load', function () {
        sandbox.failed = true;
        showSandboxFallback(true);
      });
      wv.addEventListener('dom-ready', function () {
        sandbox.failed = false;
        showSandboxFallback(false);
      });
    }
    if (wv.getAttribute('src')) return;
    var url = sandbox.url;
    if (!url) {
      global.df.info().then(function (r) {
        sandbox.url = (r && r.sandboxUrl) || '';
        if (sandbox.url) wv.setAttribute('src', sandbox.url);
        else showSandboxFallback(true);
      }).catch(function () { showSandboxFallback(true); });
      return;
    }
    wv.setAttribute('src', url);
  }

  function bindSandbox() {
    var reload = $('btnSandboxReload');
    if (reload) reload.addEventListener('click', function () {
      var wv = sandboxEl();
      if (!wv || !sandboxSupported()) { ensureSandboxLoaded(); return; }
      showSandboxFallback(false);
      try { wv.reload(); } catch (e) { ensureSandboxLoaded(); }
    });
    var retry = $('btnSandboxRetry');
    if (retry) retry.addEventListener('click', function () {
      var wv = sandboxEl();
      sandbox.failed = false;
      showSandboxFallback(false);
      if (wv && wv.getAttribute('src')) { try { wv.reload(); } catch (e) {} }
      else ensureSandboxLoaded();
    });
    var browser = $('btnSandboxBrowser');
    if (browser) browser.addEventListener('click', function () {
      global.df.openSandbox().then(function (r) {
        if (r && !r.ok) toast('打开失败：' + (r.error || '未知'), true);
      }).catch(function (e) { toast('打开失败：' + (e.message || e), true); });
    });
  }

  /* ---------------- 单场点评与深度分析已搬进插件体系 ----------------
   * 出厂界面上不再有这一页：摘要由宿主生成、外发由插件桥代发，页面本身在用户自己导入的插件包里。
   * 所以这里既没有 df.ai，也没有 ai.* 的 IPC —— 想找回它只能靠插件，不能靠改回来。 */

  /* ---------------- 关于 ---------------- */
  function bindAbout() {
    if (!global.df || !global.df.info) return;
    global.df.info().then(function (r) {
      if (!r) return;
      sandbox.url = r.sandboxUrl || sandbox.url;
      if (r.version) $('aboutVersion').textContent = 'v' + r.version;
    }).catch(function () { /* 拿不到版本不影响该页其余内容 */ });

    $('btnGithub').addEventListener('click', function () {
      global.df.openGithub().then(function (r) {
        if (r && !r.ok) toast('打开失败：' + (r.error || '未知'), true);
      }).catch(function (e) { toast('打开失败：' + (e.message || e), true); });
    });
    $('btnCopyGroup').addEventListener('click', function () {
      global.df.copyGroup().then(function (r) {
        toast(r && r.ok ? '群号已复制：' + r.text : '复制失败，请手动选中复制', !(r && r.ok));
      }).catch(function (e) { toast('复制失败：' + (e.message || e), true); });
    });
  }

  /* ---------------- 评分口径（权重可配） ----------------
   * 这里只负责显示与录入；归一化与脏值回退的规则在 core/analysis.weights() 里，只有一份。 */
  var WEIGHT_ROWS = [['score', '得分'], ['kill', '击杀'], ['kda', 'KDA'],
    ['occupy', global.DFViews.OCCUPY.label], ['rescue', '救治']];
  var DEFAULT_WEIGHTS = { score: 35, kill: 20, kda: 25, occupy: 10, rescue: 10 };

  function weightValues() {
    var out = {};
    WEIGHT_ROWS.forEach(function (r) {
      var el2 = $('w_' + r[0]);
      out[r[0]] = el2 ? (Number(el2.value) || 0) : DEFAULT_WEIGHTS[r[0]];
    });
    return out;
  }

  function paintWeights() {
    var v = weightValues(), t = 0, parts = [];
    WEIGHT_ROWS.forEach(function (r) { t += v[r[0]]; });
    WEIGHT_ROWS.forEach(function (r) {
      var p = t > 0 ? Math.round(v[r[0]] / t * 100) : Math.round(DEFAULT_WEIGHTS[r[0]]);
      var sp = $('wv_' + r[0]);
      if (sp) sp.textContent = p + '%';
      parts.push(r[1] + ' ' + p + '%');
    });
    var pv = $('rateRulePreview');
    if (pv) pv.textContent = '当前口径：' + parts.join(' · ');
    var hint = $('weightHint');
    if (hint) {
      hint.textContent = t <= 0 ? '五档全是 0，已自动按默认口径计算'
        : '五档之和 ' + t + '，软件按比例归一为 100%';
    }
  }

  function saveWeights(next, onDone) {
    global.df.setSettings({ ratingWeights: next }).then(function () {
      paintWeights();
      refresh().then(onDone);
    }).catch(function (e) { toast('保存评分口径失败：' + ((e && e.message) || e), true); });
  }

  function renderWeightSliders(saved) {
    var box = $('wSliders');
    if (!box) return;
    box.innerHTML = WEIGHT_ROWS.map(function (r) {
      var raw = saved && Number(saved[r[0]]);
      var v = (isFinite(raw) && raw >= 0 && raw <= 100) ? raw : DEFAULT_WEIGHTS[r[0]];
      return '<div class="w-row"><span class="w-name">' + r[1] + '</span>' +
        '<input type="range" min="0" max="100" step="1" id="w_' + r[0] + '" value="' + v + '">' +
        '<b class="w-val" id="wv_' + r[0] + '">—</b></div>';
    }).join('');
    $('occNote').textContent = global.DFViews.OCCUPY.note;
    WEIGHT_ROWS.forEach(function (r) {
      var el2 = $('w_' + r[0]);
      if (!el2) return;
      el2.addEventListener('input', paintWeights);          // 拖的时候只刷新预览
      el2.addEventListener('change', function () {          // 松手才落盘 + 重算全页
        saveWeights(weightValues());
      });
    });
    paintWeights();
  }

  /* ---------------- 扩展插件 ----------------
   * 界面只干两件事：把包申请的能力原样列出来给人看，把用户勾选的结果传回主进程。
   * 判定全在主进程（每次调用都复算启用状态、文件哈希、权限），所以这里被改也被绕过也没用。
   * ★ 转发调用时用的 id 一律取"宿主当前挂载的那个"，页面自己声称的 id 只用来做一致性核对。
   */
  var pluginData = { plugins: [], scopes: {}, netHosts: [], hostVersion: '' };
  var pluginCur = '';                        /* 沙箱 iframe 里现在挂的是哪个插件 */
  /* 外发确认面板的展开状态：不写盘 —— 每次重进这一页都回到默认（未允许=展开、已允许=收成一行） */
  var pluginGateOpen = false;
  var pluginGateShown = '';                  /* 面板上一次是为哪个插件画的，换了插件必须重画 */
  var PLUGIN_METHODS = ['host.info', 'summary.get', 'kv.get', 'kv.set',
    'secret.get', 'secret.set', 'net.request', 'net.stream', 'net.abort', 'net.clearSession',
    'ai.digest', 'legacy.check', 'legacy.ai', 'trigger.arm', 'trigger.take'];

  function pesc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function psize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function pscope(sc) { return pluginData.scopes[sc] || { label: sc, desc: '' }; }
  /* 域名清单给人看的那一句。★ 判定源头是 core/plugin.js 的 ANY_HOST（宿主把它算成 anyHost 标记），
   * 这里只负责措辞 —— 渲染层不加载 core/*，所以不在这儿再判一次 '*' 的语义。 */
  function permAnyHost(x) { return !!(x && (x.anyHost || (x.hosts || [])[0] === '*')); }
  function permHostText(x) {
    var hs = (x && x.hosts) || [];
    if (!hs.length) return '';
    if (permAnyHost(x)) return '★ 地址由你在插件页里自己填 —— 宿主不预置任何域名，但只放行 https（标准端口），且必须先逐字确认';
    return '只允许这几个地址：' + hs.join(' / ');
  }
  function permHostBadge(x) {
    var hs = (x && x.hosts) || [];
    if (!hs.length) return '';
    return '：' + (permAnyHost(x) ? '地址由你填（仅 https）' : hs.join(' / '));
  }
  function phas(p, sc) {
    return (p.permissions || []).some(function (x) { return x.scope === sc; });
  }
  function pviews() {
    return (pluginData.plugins || []).filter(function (p) { return p.enabled && phas(p, 'view'); });
  }
  function pfind(id) {
    var hit = null;
    (pluginData.plugins || []).forEach(function (p) { if (p.id === id) hit = p; });
    return hit;
  }

  function renderPluginList() {
    var box = $('pluginList'), hint = $('pluginHintLine');
    var list = pluginData.plugins || [];
    if (!list.length) {
      box.innerHTML = '';
      hint.textContent = '本机还没有导入过插件。';
    } else {
      box.innerHTML = list.map(function (p) {
        var perms = (p.permissions || []).map(function (x) {
          var m = pscope(x.scope);
          var cls = x.scope === 'net.request' ? 'perm-badge net' : 'perm-badge';
          return '<span class="' + cls + '">' + pesc(m.label) + pesc(permHostBadge(x)) + '</span>';
        }).join('');
        var meta = p.intact
          ? p.fileCount + ' 个文件 · ' + psize(p.totalSize) + ' · 导入于 ' + pesc(p.imported_at || '—')
          : '⚠ ' + pesc(p.intactMessage || '插件文件与导入时不一致，宿主已拒绝为它提供任何能力');
        return '<div class="plugin-item' + (p.enabled ? '' : ' off') + '" data-id="' + pesc(p.id) + '">' +
          '<div class="plugin-item-head">' +
            '<span class="plugin-item-name">' + pesc(p.name) + '</span>' +
            '<span class="plugin-item-ver">v' + pesc(p.version) +
              (p.author ? ' · ' + pesc(p.author) : '') + '</span>' +
            '<span class="plugin-item-spacer"></span>' +
            (p.intact ? '' : '<span class="tag" style="color:var(--red)">已被改动</span>') +
            (p.consent && p.consent.sentence && !p.consentGiven ? '<span class="tag" style="color:var(--orange)">外发待确认</span>' : '') +
            (p.enabled ? '<span class="tag tag-soft">已启用</span>' : '<span class="tag tag-dim">已禁用</span>') +
          '</div>' +
          (p.description ? '<div class="plugin-item-desc">' + pesc(p.description) + '</div>' : '') +
          '<div class="plugin-perms">' + perms + '</div>' +
          '<div class="plugin-item-meta">' + meta + '</div>' +
          '<div class="plugin-item-actions">' +
            '<button class="btn btn-sm" data-act="toggle">' + (p.enabled ? '禁用' : '启用') + '</button>' +
            (phas(p, 'view') && p.enabled ? '<button class="btn btn-sm" data-act="open">打开页面</button>' : '') +
            (phas(p, 'net.request') ? '<button class="btn btn-sm" data-act="clear">清除登录状态</button>' : '') +
            '<button class="btn btn-sm btn-danger" data-act="remove">卸载</button>' +
          '</div>' +
        '</div>';
      }).join('');
      var on = list.filter(function (p) { return p.enabled; }).length;
      hint.textContent = '已导入 ' + list.length + ' 个 · 启用 ' + on + ' 个 · ' +
        ((pluginData.netHosts || []).length
          ? '可外发到 ' + pluginData.netHosts.join(' / ')
          : '当前没有任何插件能发出网络请求');
    }
    /* 只有真启用了带页面的插件才亮出那一页：默认安装不留痕迹 */
    var views = pviews();
    $('navPlugin').style.display = views.length ? '' : 'none';
    var pick = $('pluginPagePick');
    pick.innerHTML = views.map(function (p) {
      return '<option value="' + pesc(p.id) + '">' + pesc(p.name) + '</option>';
    }).join('');
    if (!views.some(function (p) { return p.id === pluginCur; })) pluginCur = views.length ? views[0].id : '';
    if (pluginCur) pick.value = pluginCur;
    if (!views.length) pluginPageClear();
    pluginConsentRender();
  }

  function pluginApply(r) {
    if (!r || !r.ok) return;
    pluginData = {
      plugins: r.plugins || [], scopes: r.scopes || {},
      netHosts: r.netHosts || [], hostVersion: r.hostVersion || ''
    };
    renderPluginList();
  }

  function refreshPlugins() {
    if (!global.df || !global.df.plugin) return Promise.resolve();
    return global.df.plugin.list().then(pluginApply).catch(function () { /* 列表读不到不影响主界面 */ });
  }

  /* ---------- 导入：预览 → 逐项勾权限 → 装 ---------- */
  function pluginImport() {
    global.df.plugin.inspect().then(function (r) {
      if (!r) return;
      if (r.cancelled) return;
      if (!r.ok) { toast(r.error || '这个包没能通过检查', true); return; }
      pluginAskPerms(r);
    }).catch(function (e) { toast('读取插件包失败：' + (e && e.message || e), true); });
  }

  function pluginAskPerms(p) {
    var mask = $('pluginDlg'), box = $('pluginDlgPerms'), okBtn = $('pluginDlgOk');
    var m = p.manifest || {};
    $('pluginDlgWho').innerHTML =
      '<b>' + pesc(m.name) + '</b> v' + pesc(m.version) + '　<span class="dlg-meta" style="display:inline">' +
        pesc(m.id) + '</span><br>来源文件：' + pesc(p.source) +
      (m.description ? '<br>' + pesc(m.description) : '') +
      '<br><br>下面每一项都要单独勾一下。<b>只要有一项没勾，就不会装</b>——' +
      '这个包申请的能力是一整套，缺一项插件多半跑不对；不想全同意就点取消，装完之后随时能整个禁用。';
    box.innerHTML = (m.permissions || []).map(function (x) {
      var sc = pscope(x.scope);
      return '<label class="perm-item"><input type="checkbox" data-scope="' + pesc(x.scope) + '">' +
        '<span><span class="perm-t">' + pesc(sc.label) + '</span>' +
        '<span class="perm-x">' + pesc(sc.desc) + '</span>' +
        (x.reason ? '<span class="perm-x">作者写的用途：' + pesc(x.reason) + '</span>' : '') +
        (permHostText(x) ? '<span class="perm-hosts">' + pesc(permHostText(x)) + '</span>' : '') +
        '</span></label>';
    }).join('');
    $('pluginDlgMeta').innerHTML =
      '<b>' + p.fileCount + ' 个文件 · ' + psize(p.totalSize) + '</b>　宿主接口版本 ' + pesc(p.hostVersion || pluginData.hostVersion) +
      '<br>包指纹 ' + pesc(p.packageHash) +
      '<br>权限指纹 ' + pesc(p.permFp) + '（这两条用来判断"是不是同一个包、批过哪些权限"）' +
      (m.consent && m.consent.sentence
        ? '<br>装好之后它要往外发数据，还得你在这一页上方<b>逐字输入</b>这句才算允许：「' + pesc(m.consent.sentence) + '」' +
          '<br><span style="color:var(--text-3)">这句话算进权限指纹 —— 作者改它就得重新导包。</span>'
        : '') +
      (p.replaced ? '<br><b style="color:var(--orange)">本机已有同 id 插件，确认导入会直接覆盖它</b>' : '');
    okBtn.disabled = true;
    okBtn.dataset.token = p.token;
    Array.prototype.forEach.call(box.querySelectorAll('input'), function (i) {
      i.checked = false;
      i.onchange = function () {
        var rest = Array.prototype.filter.call(box.querySelectorAll('input'), function (x) { return !x.checked; });
        okBtn.disabled = rest.length > 0;
      };
    });
    mask.style.display = '';
  }

  function pluginConfirmImport() {
    var box = $('pluginDlgPerms'), okBtn = $('pluginDlgOk');
    var token = okBtn.dataset.token;
    var picked = Array.prototype.map.call(box.querySelectorAll('input'), function (i) {
      return i.checked ? i.dataset.scope : null;
    }).filter(Boolean);
    global.df.plugin.install(token, picked).then(function (r) {
      $('pluginDlg').style.display = 'none';
      if (!r.ok) { toast(r.error || '导入失败', true); return; }
      pluginApply(r.list);
      toast('已导入：新插件默认是禁用的，确认过一遍再点「启用」');
    });
  }

  function pluginToggle(id) {
    var p = pfind(id);
    if (!p) return;
    global.df.plugin.setEnabled(id, !p.enabled).then(function (r) {
      if (!r.ok) toast(r.error || '没能启用这个插件', true);
      else if (r.plugin && r.plugin.enabled) toast('已启用「' + r.plugin.name + '」');
      pluginApply(r.list);
    });
  }

  function pluginClearSession(id) {
    global.df.plugin.call(id, 'net.clearSession', {}).then(function (r) {
      toast(r.ok ? '已清掉这个插件的登录状态' : (r.error || '清除失败'), !r.ok);
    });
  }

  function pluginRemove(id) {
    var p = pfind(id);
    if (!p) return;
    confirmDialog({
      title: '卸载插件「' + p.name + '」',
      message: '插件文件、它存的配置、以及它的登录状态会一起删掉，本机战绩数据不受影响。' +
        '要再用得重新导入插件包。',
      okLabel: '卸载', danger: true
    }).then(function (yes) {
      if (!yes) return;
      global.df.plugin.remove(id).then(function (r) {
        if (!r.ok) { toast(r.error || '卸载失败', true); return; }
        if (pluginCur === id) pluginCur = '';
        pluginApply(r.list);
        toast('已卸载');
      });
    });
  }

  /* ---------- 沙箱页面宿主 ---------- */
  /* 版式词汇表在 ui/css/plugin-base.css，由主进程随 plugin:page 一起送过来。
   * 这里只负责把宿主**当前算出来的**主题令牌抄进 iframe 的 :root —— 沙箱是另一个源，
   * 它读不到 theme.css，抄一次就能让两边用同一批变量。 */
  var pluginCssText = '';
  var PL_TOKENS = ['font', 'bg', 'surface', 'surface-2', 'surface-3', 'text', 'text-2', 'text-3',
    'border', 'separator', 'accent', 'accent-soft', 'accent-text', 'green', 'orange', 'red',
    'radius-sm', 'radius-md', 'shadow'];
  function pluginTokensCss() {
    var cs = global.getComputedStyle(document.documentElement), decl = '', i, name, v;
    for (i = 0; i < PL_TOKENS.length; i++) {
      name = PL_TOKENS[i];
      v = String(cs.getPropertyValue('--' + name) || '').trim();
      /* 值本该只来自 theme.css；能闭合样式表的字符一律不带进去 */
      if (!v || /[}<]/.test(v)) continue;
      decl += '--' + name + ':' + v + ';';
    }
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return ':root{color-scheme:' + (dark ? 'dark' : 'light') + ';' + decl + '}';
  }
  function pluginBaseCss() {
    return '<style>' + pluginTokensCss() + pluginCssText + '</style>';
  }

  /* 插件脚本用间接 eval 注入：整段代码转成 JSON 字符串字面量并把 < 转义，
   * 这样脚本正文里出现 </script> 也切不断标签 —— 反正它本来就只能跑在沙箱里。 */
  function pluginScriptTag(code) {
    return '<script>(0,eval)(' + JSON.stringify(String(code || '')).replace(/</g, '\\u003c') + ')<\/script>';
  }

  function pluginBootSrc(pid, hostVersion) {
    return [
      '(function(){',
      'var PID=' + JSON.stringify(String(pid)) + ',seq=0,pend={},def=null,hooks=[];',
      'function post(m){m.pluginId=PID;parent.postMessage(m,"*");}',
      'function call(method,args){return new Promise(function(res,rej){var id=++seq;pend[id]={res:res,rej:rej};',
      'post({type:"dfp:req",id:id,method:String(method),args:args||{}});});}',
      'window.addEventListener("message",function(e){var m=e.data||{};if(m.pluginId!==PID)return;',
      'if(m.type==="dfp:res"){var p=pend[m.id];if(!p)return;delete pend[m.id];',
      'if(m.ok)p.res(m.result);else p.rej(new Error(m.error||"宿主拒绝了这次调用"));return;}',
      'if(m.type==="dfp:evt"){for(var i=0;i<hooks.length;i++){try{hooks[i](m.event,m.data);}catch(x){}}}});',
      'window.DFPlugin={register:function(d){def=d;},call:call,on:function(f){hooks.push(f);},',
      'kv:{get:function(k){return call("kv.get",{key:k}).then(function(r){return r&&r.value!==undefined?r.value:null;});},',
      'set:function(k,v){return call("kv.set",{key:k,value:v}).then(function(){return true;});}},',
      /* 密钥与配置分两层：这一层取的是宿主另存的一份文件，kv.get() 扫不到它 */
      'secret:{get:function(k){return call("secret.get",{key:k}).then(function(r){return r&&r.value!==undefined?r.value:null;});},',
      'set:function(k,v){return call("secret.set",{key:k,value:v}).then(function(r){return !!(r&&r.ok);});}},',
      /* 流式：call 只把 streamId 给你，正文靠上面的 on() 送 —— 别在沙箱里等一个 Promise */
      'stream:function(args){return call("net.stream",args||{});},',
      'abortStream:function(sid){return call("net.abort",{streamId:String(sid||"")});},',
      'host:{version:' + JSON.stringify(String(hostVersion || '')) + ',id:PID}};',
      'function go(){var root=document.getElementById("app")||document.body;',
      'post({type:"dfp:ready"});',
      'if(def&&typeof def.mount==="function"){try{def.mount(root,{call:call});}catch(e){',
      'root.innerHTML=\'<p class="err">插件页面出错了：\' + String((e&&e.message)||e) + \'</p>\';}}}',
      'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",go);else go();',
      '})()'
    ].join('\n');
  }

  function pluginDoc(page) {
    var headPart = '<meta charset="utf-8">' + pluginBaseCss() +
      '<script>' + pluginBootSrc(page.plugin.id, page.hostVersion) + '<\/script>';
    var tailPart = pluginScriptTag(page.script);
    var html = String(page.html || '');
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, function (m) { return m + headPart; });
    } else if (/<body[^>]*>/i.test(html)) {
      html = html.replace(/<body[^>]*>/i, function (m) { return m + headPart; });
    } else {
      return '<!doctype html><html><head>' + headPart + '</head><body>' + html + tailPart + '<\/body></html>';
    }
    if (/<\/body>/i.test(html)) {
      return html.replace(/<\/body>/i, function () { return tailPart + '<\/body>'; });
    }
    return html + tailPart;
  }

  function pluginErrorDoc(msg) {
    return '<!doctype html><html><head><meta charset="utf-8">' + pluginBaseCss() + '</head><body>' +
      '<h3>这个插件页面没能加载</h3><p class="err">' + pesc(msg || '未知原因') + '</p>' +
      '<p style="opacity:.7">可到「设置 → 扩展插件」里看它的完整性提示；插件文件被改过时宿主会直接拒绝供页。</p></body></html>';
  }

  /* ---------- 外发确认面板（宿主 DOM，不在沙箱里） ----------
   * 当前这一页的插件如果拿到了 net.request 且清单里钉了 consent.sentence，就在 iframe 上方摆这块面板。
   * 点「允许」只是把手打的原文递给主进程；状态一律从回传的 list 里重读 —— 渲染层不留第二份判定。 */
  function pluginGateOf(p) {
    if (!p || !phas(p, 'net.request')) return null;
    var c = p.consent || {};
    return c.sentence ? c : null;
  }
  function pluginConsentItems(id, arr, fallback) {
    var items = (arr && arr.length) ? arr : [fallback];
    $(id).innerHTML = items.map(function (t) { return '<li>' + pesc(t) + '</li>'; }).join('');
  }
  function pluginConsentRender() {
    var box = $('pluginConsent'), p = pfind(pluginCur), c = pluginGateOf(p);
    /* ★ 换插件 = 面板从头画：标题、披露两栏、那句确认话、输入框、展开状态，一项都不许从上一个插件带过来 */
    if (pluginGateShown !== pluginCur) { pluginGateShown = pluginCur; pluginGateOpen = false; }
    if (!c) { box.style.display = 'none'; return; }
    box.style.display = '';
    var given = !!p.consentGiven;
    $('pluginConsentWho').textContent = (p.name || p.id) + ' 要往外发数据';
    var st = $('pluginConsentState');
    st.textContent = given
      ? '已允许 · 确认于 ' + (p.consentAt || '—')
      : '未允许 —— 它一个字节也发不出去';
    st.className = 'gate-state' + (given ? '' : ' no');
    /* ★ 面板这句话一画出来就同步推给沙箱页：宿主面板与 iframe 里那行提示必须同一瞬间改口 */
    pluginPushGateEvent();
    /* 未允许时正文强制展开：输入框被藏起来的"闸门"就不是闸门了。已允许之后默认收成一行，把高度还给插件页 */
    var open = given ? pluginGateOpen : true;
    $('pluginConsentBody').style.display = open ? '' : 'none';
    var toggle = $('btnPluginGateToggle');
    toggle.style.display = given ? '' : 'none';
    toggle.textContent = open ? '收起' : '展开';
    $('btnPluginConsentRevoke').style.display = given ? '' : 'none';
    var input = $('pluginConsentInput'), ok = $('btnPluginConsent');
    input.value = '';
    input.disabled = given;
    ok.style.display = given ? 'none' : '';
    if (!open) return;
    pluginConsentItems('pluginConsentSends', c.sends, '插件作者没写这一栏 —— 那就由你自己判断要不要允许');
    pluginConsentItems('pluginConsentNo', c.doesNotSend, '你的登录凭据、本机数据文件、以及别的插件的东西');
    $('pluginConsentText').textContent = c.sentence;
    var netPerm = ((p.permissions || []).filter(function (x) { return x.scope === 'net.request'; })[0] || {});
    $('pluginConsentNote').textContent = given
      ? '要改主意就点上面那行的「撤销允许」—— 正在跑的那条请求会被立刻掐断，宿主顺手清掉替它代管的登录会话。'
      : '未允许：这个插件的 net.request / net.stream 一律被宿主拒绝，点了也不会发出半个字节。';
    $('pluginConsentHosts').textContent = permHostText(netPerm) || '这个插件没有获批任何地址。';
  }
  function pluginConsentSend(revoke) {
    var p = pfind(pluginCur);
    if (!p) return;
    var api = global.df.plugin;
    var job = revoke ? api.revokeConsent(p.id) : api.consent(p.id, $('pluginConsentInput').value);
    job.then(function (r) {
      pluginApply(r.list);
      pluginConsentRender();
      if (!r.ok) { toast(r.error || '未确认', true); return; }
      toast(revoke ? '已撤销允许：它再发不出去，登录会话也清掉了' : '已允许这个插件向外发送');
    }).catch(function (e) { toast('操作失败：' + ((e && e.message) || e), true); });
  }

  /* ★ 闸门状态一变就推给沙箱页。插件页只在 mount 时 host.info 问过一次的，
   *   不推的话宿主面板已经写成「已允许」，iframe 里那句「还差一步」还挂着 —— 同一屏两句话互相打脸。 */
  function pluginPushGateEvent() {
    var frame = $('pluginFrame');
    var p = pfind(pluginCur);
    if (!frame || !frame.contentWindow || !p) return;
    try {
      frame.contentWindow.postMessage({
        type: 'dfp:evt', pluginId: pluginCur, event: 'gate',
        data: { consentOk: !!p.consentGiven, needsConsent: !!pluginGateOf(p) }
      }, '*');
    } catch (x) { /* 页面刚被换掉，这一条丢掉就行 */ }
  }

  function pluginPageClear() {
    pluginCur = '';
    var frame = $('pluginFrame');
    if (frame.hasAttribute('srcdoc')) frame.removeAttribute('srcdoc');
    frame.style.display = 'none';
    $('pluginPageEmpty').style.display = '';
    pluginConsentRender();
  }

  function pluginPageShow() {
    var views = pviews();
    if (!views.length) { pluginPageClear(); return; }
    if (!pfind(pluginCur) || !phas(pfind(pluginCur), 'view') || !pfind(pluginCur).enabled) {
      pluginCur = views[0].id;
    }
    var cur = pfind(pluginCur);
    $('pluginPageEmpty').style.display = 'none';
    $('pluginFrame').style.display = '';
    $('pluginPageTitle').textContent = '扩展页面 · ' + (cur ? cur.name : '');
    var pick = $('pluginPagePick');
    if (cur) pick.value = cur.id;
    /* ★ 面板跟着当前插件走：这里漏了就会拿着 A 的确认句去给 B 用（宿主按 id 判定，不会误放行，但界面在说谎） */
    pluginConsentRender();
    global.df.plugin.page(pluginCur).then(function (r) {
      pluginCssText = String(r.baseCss || '');
      if (!r.ok) { $('pluginFrame').srcdoc = pluginErrorDoc(r.error); return; }
      if (r.plugin && r.plugin.id !== pluginCur) return;   /* 切得快就不回旧的那份 */
      $('pluginFrame').srcdoc = pluginDoc({
        plugin: r.plugin, html: r.html, script: r.script, hostVersion: r.hostVersion
      });
    });
  }

  function pluginEnsurePage() {
    if (pviews().length) pluginPageShow();
    else pluginPageClear();
  }

  /* 沙箱页 ↔ 宿主唯一的通道：只认当前那个 iframe 的 window，只认宿主自己选的插件 id */
  function pluginBindBridge() {
    global.addEventListener('message', function (e) {
      var m = e.data || {};
      if (typeof m !== 'object' || String(m.type || '').indexOf('dfp:') !== 0) return;
      var frame = $('pluginFrame');
      if (!frame || !frame.contentWindow || e.source !== frame.contentWindow) return;
      if (!pluginCur || m.pluginId !== pluginCur) return;
      function reply(obj) {
        obj.pluginId = pluginCur;
        try { frame.contentWindow.postMessage(obj, '*'); } catch (x) { /* 页面已换掉 */ }
      }
      if (m.type === 'dfp:ready') { return; }
      if (m.type !== 'dfp:req') return;
      if (PLUGIN_METHODS.indexOf(m.method) === -1) {
        reply({ type: 'dfp:res', id: m.id, ok: false, error: '这个方法宿主不提供' });
        return;
      }
      global.df.plugin.call(pluginCur, m.method, m.args).then(function (r) {
        reply({ type: 'dfp:res', id: m.id, ok: !!(r && r.ok), result: r || {} });
      }, function (e2) {
        reply({ type: 'dfp:res', id: m.id, ok: false, error: (e2 && e2.message) || String(e2) });
      });
    });

    /* 反方向：宿主推给沙箱页的事件（目前是流式回包）。
     * 只转给"当前挂着的那个插件"，切了页就丢 —— 沙箱是 null 源，页面只能靠 streamId 自己认领，
     * 所以这一层的 pluginId 过滤是唯一一道能挡住"上一个插件的正文写进下一个插件界面"的闸。 */
    global.df.on('plugin:evt', function (m) {
      if (!m || !pluginCur || String(m.pluginId || '') !== pluginCur) return;
      var frame = $('pluginFrame');
      if (!frame || !frame.contentWindow) return;
      try {
        frame.contentWindow.postMessage({
          type: 'dfp:evt', pluginId: pluginCur, event: String(m.event || ''), data: m.data || {}
        }, '*');
      } catch (x) { /* 页面刚被换掉，丢掉这一片 */ }
    });
  }

  function bindPlugins() {
    $('btnPluginImport').addEventListener('click', pluginImport);
    $('pluginDlgCancel').addEventListener('click', function () { $('pluginDlg').style.display = 'none'; });
    $('pluginDlgOk').addEventListener('click', pluginConfirmImport);
    $('pluginDlg').addEventListener('click', function (e) {
      if (e.target === $('pluginDlg')) $('pluginDlg').style.display = 'none';
    });
    $('pluginList').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      var item = btn.closest('.plugin-item');
      var id = item && item.getAttribute('data-id');
      if (!id) return;
      if (btn.getAttribute('data-act') === 'toggle') pluginToggle(id);
      else if (btn.getAttribute('data-act') === 'clear') pluginClearSession(id);
      else if (btn.getAttribute('data-act') === 'remove') pluginRemove(id);
      else if (btn.getAttribute('data-act') === 'open') { pluginCur = id; switchView('plugin'); }
    });
    $('pluginPagePick').addEventListener('change', function () {
      pluginCur = this.value;
      pluginPageShow();
    });
    $('btnPluginPageReload').addEventListener('click', pluginPageShow);
    $('btnPluginConsent').addEventListener('click', function () { pluginConsentSend(false); });
    $('btnPluginGateToggle').addEventListener('click', function () {
      pluginGateOpen = !pluginGateOpen;
      pluginConsentRender();
    });
    $('btnPluginConsentRevoke').addEventListener('click', function () { pluginConsentSend(true); });
    $('pluginConsentInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); pluginConsentSend(false); }
    });
    pluginBindBridge();
    renderPluginList();
  }

  /* ---------------- 设置 ---------------- */
  function bindSettings() {
    Array.prototype.forEach.call($('themeSeg').querySelectorAll('.seg'), function (b) {
      b.addEventListener('click', function () { global.DFTheme.set(b.dataset.theme, true); });
    });
    function safeSet(patch, onDone) {
      return global.df.setSettings(patch).then(function (r) {
        if (onDone) onDone(r);
      }).catch(function (e) { toast('保存设置失败：' + (e.message || e), true); });
    }
    $('setAutoDetail').addEventListener('change', function (e) {
      safeSet({ autoSyncDetail: e.target.checked }, function () {
        toast(e.target.checked ? '同步时会抓取全场名单' : '同步时不抓全场名单');
      });
    });
    $('setAutoSyncInterval').addEventListener('change', function () {
      var v = Number(this.value) || 0;
      safeSet({ autoSyncInterval: v }, function () {
        toast(v ? '已开启定时同步：每 ' + v + ' 分钟' : '已关闭定时同步');
      });
    });
    $('setAutoBackup').addEventListener('change', function (e) {
      safeSet({ autoBackup: e.target.checked }, function () {
        toast(e.target.checked ? '已开启每日自动备份' : '已关闭每日自动备份');
      });
    });
    $('setSyncPages').addEventListener('change', function () {
      var v = Number(this.value) || 5;
      safeSet({ syncPages: v }, function () { toast('战局翻页数已设为 ' + v + ' 页'); });
    });
    $('setSyncPageDelay').addEventListener('change', function () {
      var v = Number(this.value) || 500;
      safeSet({ syncPageDelayMs: v }, function () { toast('翻页间隔已设为 ' + v + ' ms'); });
    });
    /* 官方赛季号：只影响「官方赛季数据」那格与分地图统计（战局列表那个接口不带 sid）。
     * 输入 Anything 非数字一律清空回到"用软件内置默认"，因为猜一个错的赛季号比留空更坏 ——
     * 那一格会把旧赛季的总数念成"本赛季"。 */
    var sid = $('setSeasonSid');
    if (sid) sid.addEventListener('change', function () {
      var v = String(sid.value || '').replace(/[^\d]/g, '');
      sid.value = v;
      safeSet({ seasonSid: v }, function () {
        toast(v ? '官方赛季号已设为第 ' + v + ' 赛季，下次同步生效'
               : '已留空：用软件内置的默认赛季号（第 ' + (state.sidDefault || '?') + ' 赛季）');
      });
    });
    $('setBackupKeep').addEventListener('change', function () {
      safeSet({ backupKeep: Number(this.value) || 7 }, function () {
        toast('备份保留份数已更新');
      });
    });

    $('btnBackupNow').addEventListener('click', function () {
      global.df.backupNow().then(function (r) {
        /* ★ 说的是这次真的产出了什么：上一版这里念 `r.name`（单数），而 doBackup 回的是
         *    {ok, dir, files:[…], count} —— 于是每次点都弹「已备份到：undefined」，
         *    而备份到底在哪儿、成了没成，使用者一点都不知道（他 2026-09-26 报的就是这句）。 */
        if (r.ok) {
          toast('已备份 ' + r.count + ' 个文件到：' + r.dir +
            (r.pruned ? '（每个号只留最近 ' + r.keep + ' 份，这轮裁掉 ' + r.pruned + ' 份旧的）' : ''));
          loadBackupInfo();
        } else toast('备份失败：' + (r.error || '未知'), true);
      }).catch(function (e) { toast('备份失败：' + (e.message || e), true); });
    });
    $('btnOpenBackup').addEventListener('click', function () {
      global.df.backupOpen().then(function (r) {
        toast(r && r.ok ? '已打开备份目录' : '打开失败：' + ((r && r.error) || '未知'), !r || !r.ok);
      }).catch(function (e) { toast('打开失败：' + (e.message || e), true); });
    });
    $('btnChooseBackupDir').addEventListener('click', function () {
      global.df.backupChooseDir().then(function (r) {
        if (r.cancelled) return;
        if (r.ok) { toast('备份目录已更新'); loadBackupInfo(); }
        else toast('设置失败：' + (r.error || '未知'), true);
      }).catch(function (e) { toast('设置失败：' + (e.message || e), true); });
    });

    /* ★ 「之后全手动」的那一颗：软件只在首次自动取一次，官方出新图之后就靠这里 */
    $('btnMapNamesRefresh').addEventListener('click', function () {
      var btn = this, label = btn.textContent;
      if (!global.df.mapNames || !global.df.mapNames.refresh) {
        toast('这台设备的宿主还没有地图名更新接口', true);
        return;
      }
      btn.disabled = true;
      btn.textContent = '正在更新…';
      var done = function () { btn.disabled = false; btn.textContent = label; };
      global.df.mapNames.refresh().then(function (r) {
        done();
        if (!r) { toast('更新失败：宿主没有回话', true); return; }
        if (r.ok) {
          toast('已更新：新学到 ' + (r.added || 0) + ' 个地名' +
            (r.renamed ? '，' + r.renamed + ' 场历史场次跟着改了名' : ''));
          refresh();          /* 库里的地名真的变了，可见页必须按新地名重画 */
        } else toast('更新失败：' + (r.error || '未知'), true);
        loadMapNames();
      }).catch(function (e) {
        done();
        toast('更新失败：' + (e.message || e), true);
        loadMapNames();
      });
    });

    /* ★ 本机字典「查看 / 编辑」（#92）：改名不出网，只写宿主那一份 accounts。
     * 表里每颗「改名」只把那行的编号与现名填进下面那一对手动输入 —— Electron 渲染进程
     * 根本没有 prompt()（上面 confirm 那条注释就是同一件事），安卓 WebView 也得看宿主脸色，
     * 所以两端共用这一套真输入框，谁也不依赖系统对话框。 */
    $('btnMapDict').addEventListener('click', function () {
      var box = $('mapDictBox');
      var willOpen = box.classList.contains('hidden');
      box.classList.toggle('hidden', !willOpen);
      this.textContent = willOpen ? '收起本机字典' : '查看 / 编辑';
      if (willOpen) loadMapDict();
    });
    $('mapDictBox').addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var act = t.getAttribute('data-dict-act');
      if (act === 'edit') {
        $('dictMapId').value = t.getAttribute('data-dict-id') || '';
        $('dictMapName').value = t.getAttribute('data-dict-name') || '';
        $('dictMapName').focus();
        return;
      }
      if (act === 'clear') { setMapName(t.getAttribute('data-dict-id'), ''); return; }
      if (t.id === 'dictSave') setMapName($('dictMapId').value, $('dictMapName').value);
    });

    $('btnBundle').addEventListener('click', function () {
      global.df.bundle().then(function (r) {
        if (r.cancelled) return;
        if (r.ok) toast('已导出数据包（' + r.matches + ' 场 / ' + r.rosters + ' 份名单）');
        else toast('导出失败：' + (r.error || '未知'), true);
      }).catch(function (e) { toast('导出失败：' + (e.message || e), true); });
    });
    $('btnRestore').addEventListener('click', function () {
      global.df.restore().then(function (r) {
        if (r.cancelled) return;
        if (r.ok) {
          var line = '导入完成：新增 ' + r.added + ' 场、跳过重复 ' + r.dup +
            ' 场、补充名单 ' + r.rosterAdded + ' 份';
          if (r.switched) {
            line += '；这个包属于「' + (r.account || r.slot) + '」，' +
              (r.isNew ? '已为本机新建这个只读账号' : '已切到该账号') + '并装进它自己的库';
          }
          toast(line);
          refresh();
        } else toast('导入失败：' + (r.error || '未知'), true);
      }).catch(function (e) { toast('导入失败：' + (e.message || e), true); });
    });

    $('btnExportJson').addEventListener('click', function () { exportAs('json'); });
    $('btnExportCsv').addEventListener('click', function () { exportAs('csv'); });
    $('btnOpenFolder').addEventListener('click', function () {
      global.df.openFolder().then(function (r) {
        toast(r && r.ok ? '已打开数据目录' : '打开失败：' + ((r && r.error) || '未知'), !r || !r.ok);
      }).catch(function (e) { toast('打开失败：' + (e.message || e), true); });
    });
    $('btnWeightReset').addEventListener('click', function () {
      confirmDialog({
        title: '还原默认评分口径',
        message: '把五档权重恢复成' + WEIGHT_ROWS.map(function (r) {
          return r[1] + ' ' + DEFAULT_WEIGHTS[r[0]];
        }).join(' · ') + '，并立即按默认口径重算所有页面。',
        okLabel: '还原'
      }).then(function (v) {
        if (v !== true) return;
        renderWeightSliders(DEFAULT_WEIGHTS);
        saveWeights(DEFAULT_WEIGHTS, function () { toast('已还原默认评分口径'); });
      });
    });

    $('btnReset').addEventListener('click', function () {
      confirmDialog({
        title: '清空本地数据',
        message: '此操作不可撤销。建议先在上方「导出完整数据包」保留一份副本。',
        okLabel: '下一步', danger: true,
        choices: [
          { value: 'current', title: '仅清空当前账号',
            desc: '只删除本机的战局、名单、赛季数据；账号本身与登录状态保留。' },
          { value: 'all', title: '清空所有账号（含账号列表）',
            desc: '删除全部账号的数据文件与 accounts.json；已注册的 slot 编号不会重用。' }
        ]
      }).then(function (scope) {
        if (!scope) return;
        global.df.reset(scope).then(function (r) {
          if (r && r.ok) {
            toast(scope === 'all' ? '已清空所有账号' : '已清空当前账号数据');
            if (scope === 'all') {
              boot();
            } else {
              refresh();
              loadAccounts();
            }
          } else toast('清空失败：' + ((r && r.error) || '未知'), true);
        }).catch(function (e) { toast('清空失败：' + (e.message || e), true); });
      });
    });

    $('btnCard').addEventListener('click', makeCard);
  }

  /* ---------------- 多账号：账号列表 / 切换 / 添加 / 移除 ---------------- */
  function shortOpenid(oid) {
    oid = String(oid || '');
    if (!oid) return '（未登录）';
    if (oid.length <= 10) return oid;
    return oid.slice(0, 4) + '…' + oid.slice(-4);
  }

  function fmtSyncTime(ts) {
    if (!ts) return '未同步';
    var d = new Date(Number(ts));
    if (!isFinite(d.getTime())) return '未同步';
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function loadAccounts() {
    if (!global.df.accounts) return Promise.resolve(null);
    return global.df.accounts.list().then(function (r) {
      if (!r || !r.ok) return null;
      state.accounts = r.accounts || [];
      state.activeSlot = r.activeSlot || '';
      renderAccountSwitch(state.accounts, state.activeSlot);
      renderAccountPanel(state.accounts, state.activeSlot);
      return r;
    }).catch(function () { return null; });
  }

  function renderAccountSwitch(list, active) {
    var sel = $('accountSwitch');
    if (!sel) return;
    var html = '';
    (list || []).forEach(function (a) {
      var label = (a.name || '未命名') + (a.imported ? '（导入）' : '') + '  ·  ' + a.slot + '  ·  ' + shortOpenid(a.openid);
      html += '<option value="' + a.slot + '"' + (a.slot === active ? ' selected' : '') + '>' +
        label.replace(/[<>&]/g, '') + '</option>';
    });
    if (!html) html = '<option value="">未选择账号</option>';
    sel.innerHTML = html;
    sel.value = active || '';
  }

  function renderAccountPanel(list, active) {
    var box = $('accountList');
    if (!box) return;
    if (!list || !list.length) {
      box.innerHTML = '<p class="hint" style="margin:0">尚未添加任何账号。点下面的「添加账号」打开 WeGame 登录窗口。</p>';
      return;
    }
    box.innerHTML = list.map(function (a) {
      var isActive = a.slot === active;
      var name = (a.name || '未命名').replace(/[<>&]/g, '');
      var tag = (isActive
        ? '<span class="acc-tag">当前</span>'
        : (a.fileExists ? '<span class="acc-tag muted">已注册</span>' : '<span class="acc-tag muted">空槽</span>')) +
        (a.imported ? '<span class="acc-tag muted">只读</span>' : '');
      var stats = (a.matches || 0) + ' 场 / ' + (a.rosters || 0) + ' 名单';
      var sub = 'slot=' + a.slot + ' · openid ' + shortOpenid(a.openid) +
        ' · ' + stats + ' · 最后同步 ' + fmtSyncTime(a.last_sync) +
        (a.imported ? ' · 数据包导入，本机没有它的会话' : '');
      var actions = '';
      if (!isActive) {
        actions += '<button class="btn" data-act="switch" data-slot="' + a.slot + '">切换</button>';
        actions += '<button class="btn btn-danger" data-act="remove" data-slot="' + a.slot +
          '" data-name="' + name + '">移除</button>';
      }
      return '<div class="account-row' + (isActive ? ' active' : '') + '">' +
        '<div class="acc-main"><div class="acc-name">' + name + tag + '</div>' +
        '<div class="acc-sub">' + sub + '</div></div>' +
        (actions ? '<div class="acc-actions">' + actions + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function bindAccounts() {
    var sel = $('accountSwitch');
    if (sel) sel.addEventListener('change', function () {
      var slot = sel.value;
      if (!slot || slot === state.activeSlot) return;
      sel.disabled = true;
      global.df.accounts.switch(slot).then(function (r) {
        sel.disabled = false;
        if (r && r.ok) {
          toast('已切换到 ' + slot);
          FILTERS.mode = 'all'; FILTERS.kind = 'all'; FILTERS.leave = 'all'; FILTERS.since = 0;
          Array.prototype.forEach.call(document.querySelectorAll('#fMode .seg'), function (b) {
            b.classList.toggle('active', b.dataset.mode === 'all');
          });
          Array.prototype.forEach.call(document.querySelectorAll('#fKind .seg'), function (b) {
            b.classList.toggle('active', b.dataset.kind === 'all');
          });
          Array.prototype.forEach.call(document.querySelectorAll('#fLeave .seg'), function (b) {
            b.classList.toggle('active', b.dataset.leave === 'all');
          });
          var sl = $('fSince'); if (sl) sl.value = '0';
          boot();
        } else {
          toast('切换失败：' + ((r && r.error) || '未知'), true);
        }
      }).catch(function (e) { sel.disabled = false; toast('切换失败：' + (e.message || e), true); });
    });

    var onAdd = function () {
      if (state.offline) {
        toast('离线模式下暂不能添加账号，请先点上方横幅的「打开登录窗口」完成登录', true);
        return;
      }
      global.df.accounts.add().then(function (r) {
        if (r && r.ok) {
          toast('已打开登录窗口。在里面完成登录后会自动登记为 slot ' + r.slot + '。');
        } else toast('添加失败：' + ((r && r.error) || '未知'), true);
      }).catch(function (e) { toast('添加失败：' + (e.message || e), true); });
    };
    if ($('btnAddAccount')) $('btnAddAccount').addEventListener('click', onAdd);
    if ($('btnAddAccountSetting')) $('btnAddAccountSetting').addEventListener('click', onAdd);

    if ($('btnLogoutCurrent')) $('btnLogoutCurrent').addEventListener('click', function () {
      confirmDialog({
        title: '退出当前账号登录',
        message: '只清除当前 slot 的 WeGame cookie，数据文件与账号注册记录保留；下次同步需要重新登录。',
        okLabel: '退出登录'
      }).then(function (yes) {
        if (!yes) return;
        global.df.accounts.logout(state.activeSlot).then(function (r) {
          if (r && r.ok) { toast('已退出登录'); refresh(); }
          else toast('退出失败：' + ((r && r.error) || '未知'), true);
        }).catch(function (e) { toast('退出失败：' + (e.message || e), true); });
      });
    });

    var list = $('accountList');
    if (list) list.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      var act = btn.dataset.act, slot = btn.dataset.slot, name = btn.dataset.name || slot;
      if (act === 'switch') {
        global.df.accounts.switch(slot).then(function (r) {
          if (r && r.ok) { toast('已切换到 ' + name); boot(); }
          else toast('切换失败：' + ((r && r.error) || '未知'), true);
        });
      } else if (act === 'remove') {
        confirmDialog({
          title: '移除账号 ' + name,
          message: '将删除 ' + slot + ' 的数据文件与 cookie；accounts.json 里的 slot 编号不会重用。此操作不可撤销。',
          okLabel: '移除', danger: true
        }).then(function (yes) {
          if (!yes) return;
          global.df.accounts.remove(slot).then(function (r) {
            if (r && r.ok) {
              toast(r.message || '已移除');
              boot();
            } else toast('移除失败：' + ((r && r.error) || '未知'), true);
          }).catch(function (e) { toast('移除失败：' + (e.message || e), true); });
        });
      }
    });
  }

  /* 生成并保存战绩卡片 */
  var lastCard = null;
  function makeCard() {
    var rid = $('roomPick') && $('roomPick').value;
    if (!rid) { toast('请先选择一场对局', true); return; }
    $('btnCard').disabled = true;
    global.df.match(rid).then(function (c) {
      $('btnCard').disabled = false;
      if (!c || !c.match) { toast('这一场数据不可用', true); return; }
      try {
        lastCard = global.DFViews.drawMatchCard(c);
      } catch (e) {
        toast('绘制失败：' + (e.message || e), true);
        return;
      }
      showCardDialog(c, lastCard);
    });
  }

  function showCardDialog(c, dataUrl) {
    var mask = document.createElement('div');
    mask.className = 'card-mask';
    mask.innerHTML =
      '<div class="card-dialog">' +
      '<h3>战绩卡片预览</h3>' +
      '<img src="' + dataUrl + '" alt="战绩卡片">' +
      '<div class="card-actions">' +
      '<button class="btn btn-primary" id="cardSave">保存为 PNG</button>' +
      '<button class="btn" id="cardCopy">复制到剪贴板</button>' +
      '<button class="btn" id="cardClose">关闭</button>' +
      '</div></div>';
    document.body.appendChild(mask);

    function close() { mask.remove(); }
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    mask.querySelector('#cardClose').addEventListener('click', close);
    mask.querySelector('#cardSave').addEventListener('click', function () {
      var name = '战绩卡片-' + (c.match.mapName || '') + '-' +
        String(c.match.dt_event_time || '').slice(0, 10) + '.png';
      global.df.saveCard({ dataUrl: dataUrl, name: name }).then(function (r) {
        if (r.cancelled) return;
        if (r.ok) { toast('已保存到：' + r.path); close(); }
        else toast('保存失败：' + (r.error || '未知'), true);
      });
    });
    mask.querySelector('#cardCopy').addEventListener('click', function () {
      global.df.copyCard({ dataUrl: dataUrl }).then(function (r) {
        if (r.ok) { toast('已复制到剪贴板，可直接粘贴分享'); close(); }
        else toast('复制失败：' + (r.error || '未知'), true);
      });
    });
  }

  /* 备份列表那两个时间格式：跨度用「9/26」这种短式（core 给的 start_time 是**秒**），
   * 落盘时刻用文件 mtime（毫秒），两个量纲不许混着用。 */
  function fmtSpan(sec) {
    var d = new Date(Number(sec) * 1000);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  function fmtStamp(ms) {
    return new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false,
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function loadBackupInfo() {
    /* 回那个 promise 是为了可测（界面自己不等它），行为与以前一致。
     * 这个容器是 <p class="hint">，所以行与行之间只能用 <br>：塞 <div> 会被解析器顶到 <p> 外面去。 */
    return global.df.backupInfo().then(function (b) {
      $('backupDirText').textContent = b.dir || '—';
      if (!b.list) {
        $('backupList').innerHTML = '这台设备的宿主没有备份目录，备份请用「导出数据包」。';
        return;
      }
      if (!b.list.length) { $('backupList').innerHTML = '还没有备份文件。'; return; }
      var esc = global.DFViews.esc;
      $('backupList').innerHTML = b.list.map(function (x) {
        var s = x.sum || {};
        var what = s.kind === 'accounts'
          ? '账号表（' + (s.accounts ? s.accounts + ' 个号：' + esc(s.who) : '还没登记过账号') + '）'
          : s.kind === 'library'
            ? esc(s.name || x.slot || '没署名') + '（' + s.matches + ' 场 · 名单 ' + s.rosters + ' 份' +
              (s.excluded ? ' · 剔除 ' + s.excluded : '') +
              (s.last ? ' · 跨度 ' + fmtSpan(s.first) + '~' + fmtSpan(s.last) : '') + '）'
            : esc(x.slot || '这一份') + '（读不出里面有什么）';
        return '<b>' + what + '</b>　' + fmtStamp(x.time) + ' · ' +
          Math.round((x.size || 0) / 1024) + ' KB · ' + (x.tag === 'manual' ? '手动' :
            /^daily/.test(String(x.tag)) ? '每日' : esc(x.tag || '没标签'));
      }).join('<br>') +
        '<br>每个号各留最近 ' + (b.keep || '?') + ' 份，共 ' + (b.total == null ? '?' : b.total) + ' 份' +
        (b.total > b.list.length ? '（这里只列最近 ' + b.list.length + ' 份）' : '') + '。';
    }).catch(function () { /* 预览模式无此接口 */ });
  }

  /* 地图名字典那一行状态（桌面与安卓同一套文案，数据只来自宿主的 mapNames.status） */
  function loadMapNames() {
    var el = $('mapNamesText');
    if (!el) return;
    if (!global.df.mapNames || !global.df.mapNames.status) {
      el.textContent = '这台设备的宿主还没有地图名字典接口。';
      return;
    }
    global.df.mapNames.status().then(function (s) {
      if (!s || !s.ok) { el.textContent = '问不到字典状态。'; return; }
      var t = '内置 ' + s.builtin + ' 张';
      if (s.learned) t += ' · 本机学到 ' + s.learned + ' 张';
      if (s.user) t += ' · 我改的 ' + s.user + ' 张';
      t += ' · ' + (s.at ? '上次更新 ' + fmtSyncTime(s.at) : '还没更新过（打开软件时会自动取一次）');
      if (s.unknown) t += ' · 还有 ' + s.unknown + ' 场认不出地名';
      el.textContent = t;
    }).catch(function () { el.textContent = '问不到字典状态。'; });
  }

  /* ---------------- 在线更新那一块 ----------------
   * 界面只做三件事：把状态念出来、按状态显隐那两颗按钮、把点击转给宿主。
   * ★ 这里刻意没有"立即更新"那颗按钮 —— 本软件不代他下载安装包，只给地址。
   *   所以这一段也不许出现任何"我帮你换好了"的句式。 */
  var updLast = null;
  function renderUpdate(s) {
    var box = $('updStatus');
    if (!box) return;
    var st = updLast = (s || {});
    var v = $('updVersion');
    if (v && st.current) v.textContent = 'v' + st.current;
    var dl = $('btnUpdDownload'), cp = $('btnUpdCopy');
    [dl, cp].forEach(function (b) { if (b) b.classList.add('hidden'); });
    var note = $('updNote');
    if (note) note.textContent = st.notes || '';
    if (st.checking) { box.textContent = '正在检查…'; return; }
    if (st.error) { box.textContent = '检查失败：' + st.error; return; }
    if (!st.checked) { box.textContent = '还没检查过。'; return; }
    if (st.action === 'hint') {
      box.textContent = '发现新版本 v' + st.latest +
        (st.size ? '（整包约 ' + Math.round(st.size / 1024 / 1024) + ' MB）' : '') +
        ' —— 下载后解压覆盖原目录即可，你的数据不会丢。';
      if (st.download && dl) dl.classList.remove('hidden');
      if (st.download && cp) cp.classList.remove('hidden');
    } else {
      box.textContent = '已经是最新版本。';
    }
  }
  function loadUpdate() {
    if (!global.df.update || !global.df.update.status) {
      var el = $('updStatus');
      if (el) el.textContent = '这台设备的宿主没有在线更新接口。';
      return;
    }
    global.df.update.status().then(renderUpdate).catch(function () {
      renderUpdate({ error: '问不到宿主' });
    });
  }
  function bindUpdate() {
    var c = $('btnUpdCheck');
    if (c) c.addEventListener('click', function () {
      var el = $('updStatus');
      if (el) el.textContent = '正在检查…';
      global.df.update.check().then(renderUpdate);
    });
    var dl = $('btnUpdDownload');
    if (dl) dl.addEventListener('click', function () {
      global.df.update.openDownload({ url: (updLast && updLast.download) || '' });
    });
    var cp = $('btnUpdCopy');
    if (cp) cp.addEventListener('click', function () {
      var u = (updLast && updLast.download) || '';
      if (!u) { toast('没有可复制的地址', true); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(u).then(function () { toast('下载地址已复制'); },
          function () { toast('复制失败，长按上面那句地址自己选', true); });
      } else toast('这台设备不让复制，长按地址自己选', true);
    });
  }

  /* 本机字典那一块（#92）：数据只来自宿主的 mapNames.dict —— 界面不看名字表，也不判名字能不能用
   * （编号怎么洗、40 字与尖括号那些规矩全在 core.maps 与壳里，判据源只有一处）。 */
  function loadMapDict() {
    var el = $('mapDictBox');
    if (!el || el.classList.contains('hidden')) return;
    if (!global.df.mapNames || !global.df.mapNames.dict) {
      el.innerHTML = '<p class="hint">这台设备的宿主还没有本机字典接口，查看与编辑都用不了。</p>';
      return;
    }
    global.df.mapNames.dict().then(function (d) {
      el.innerHTML = global.DFViews.mapDictHtml(d);
    }).catch(function () {
      el.innerHTML = '<p class="hint">问不到本机字典（宿主没有回话）。</p>';
    });
  }
  /** 改一张图的名字（空名 = 还原）。改完必须让三处都跟上：状态行、字典本身、看得见的页面。 */
  function setMapName(id, name) {
    if (!global.df.mapNames || !global.df.mapNames.setName) {
      toast('这台设备的宿主不能改地图名', true);
      return;
    }
    var label = String(name == null ? '' : name).trim();
    global.df.mapNames.setName({ id: String(id == null ? '' : id).trim(), name: label }).then(function (r) {
      if (!r) { toast('改名失败：宿主没有回话', true); return; }
      if (!r.ok) { toast('改名失败：' + (r.error || '未知'), true); return; }
      toast((label ? '已改名为「' + label + '」' : '已还原这一条') +
        (r.renamed ? '，' + r.renamed + ' 场历史场次跟着改了名' : ''));
      loadMapNames();
      loadMapDict();
      /* 地名真的变了，可见页要按新地名重画。桌面与安卓还有 mapNames:done 推送做同一件事，
       * 但预览层没有推送 —— 这一句必须由界面自己说，三个生产者才是同一条口径。 */
      refresh();
    }).catch(function (e) { toast('改名失败：' + (e.message || e), true); });
  }

  function exportAs(fmt) {
    global.df.exportData(fmt, FILTERS).then(function (r) {
      if (r.cancelled) return;
      if (r.ok) toast('已导出 ' + r.count + ' 场到：' + r.path);
      else toast('导出失败：' + (r.error || '未知'), true);
    }).catch(function (e) { toast('导出失败：' + (e.message || e), true); });
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    global.df.boot().then(function (b) {
      state.settings = b.settings || {};
      var s = state.settings;
      global.DFTheme.set(s.theme || 'system', false);

      $('setAutoDetail').checked = s.autoSyncDetail !== false;
      $('setAutoSyncInterval').value = String(s.autoSyncInterval != null ? s.autoSyncInterval : 30);
      $('setSyncPages').value = String(s.syncPages != null ? s.syncPages : 5);
      $('setSyncPageDelay').value = String(s.syncPageDelayMs != null ? s.syncPageDelayMs : 500);
      /* 赛季号：值取本机设置，占位符说清"留空会问第几赛季"（默认值由宿主从 core 带来，界面不自己抄） */
      state.sidDefault = b.sidDefault || '';
      var sidEl = $('setSeasonSid');
      if (sidEl) {
        sidEl.value = String(s.seasonSid || '');
        sidEl.placeholder = state.sidDefault ? ('留空 = 第 ' + state.sidDefault + ' 赛季') : '留空 = 软件默认';
      }
      $('setAutoBackup').checked = s.autoBackup !== false;
      $('setBackupKeep').value = String(s.backupKeep || 7);
      /* 权重滑杆必须在每次 boot 时按存档重建，切号后才不会挂着上一个号的口径 */
      renderWeightSliders(s.ratingWeights);
      loadBackupInfo();
      loadMapNames();

      state.accounts = b.accounts || state.accounts || [];
      state.activeSlot = b.activeSlot || state.activeSlot || '';
      state.matchCount = b.matchCount || 0;
      renderAccountSwitch(state.accounts, state.activeSlot);
      renderAccountPanel(state.accounts, state.activeSlot);
      if (b.loggedIn) {
        /* 不再开机即同步：进主界面直接渲染本地图表，同步由用户点或定时器发起 */
        showApp();
        refresh().catch(function (e) {
          toast('加载数据失败：' + (e.message || e), true);
        });
      } else if (b.localOnly) {
        /* 只读号（数据包导进来的）：这台机器没有它的 WeGame 会话，登录页对它没有任何意义，
         * 把人挡在门外就等于「导成功了却看不到」。直接进主界面读本机数据。 */
        enterOffline(state.matchCount, true);
      } else {
        /* ★ bootError 是壳替我们问出来的"这台机器到底怎么了"（装配没接好 / 本机文件读不出来 / 还没有号）。
         *   两端都算了这个字段，而界面从来没读过它 —— 于是登录页永远只念一句"尚未登录/没有数据"，
         *   读盘出故障那种最要紧的情况反倒被说成"这台机器什么都没有"（他因此去卸载重装，数据一起没了）。
         *   分色看 b.storageFault 这枚布尔，不许拿上面那些中文措辞去正则匹配。 */
        var le = b.bootError ? b.bootError + ' ' : '';
        if (b.loginPending) le += '检查登录状态超时（网络不稳定）。';
        else if (b.loginError) le += b.loginError + '。';
        else if (!b.bootError) le += '尚未登录。';
        showLogin(le + (state.matchCount > 0
            ? '本机已有 ' + state.matchCount + ' 场数据，可直接离线查看；需要同步再登录。'
            : '点下面的按钮打开 WeGame 登录窗口，登录成功后会自动进入。'),
          (b.loginError || b.loginPending || b.storageFault) ? 'err' : '');
      }
    }).catch(function (e) {
      showLogin('启动失败：' + (e && e.message || e), 'err');
    });
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    /* 两颗开登录窗的按钮走同一条。返回值恒 resolved：{ok, cleared, clearError, storageFault, error} ——
     * "没开成"必须让界面当场改口：上一版开窗失败也挂着"已打开登录窗口"等人自己发现。
     * cleared 两端都会回（使用者裁定 2026-09-26：**每次打开登录浏览器都要是新会话**；
     * 安卓那一罐是全机共享、桌面每号一个持久分区，所以桌面清的是这一个号的那一份），
     * 清不动就当场说实话，不许无条件喊"已清掉"。 */
    var openLoginWin = function () {
      $('loginStatus').textContent = '已打开登录窗口，请在其中完成登录…';
      $('loginStatus').className = 'login-status';
      return global.df.openLogin().then(function (r) {
        if (r && r.cleared) {
          $('loginStatus').textContent = '已打开登录窗口，并把本机旧的登录痕迹全部清掉了 —— 请在新页面里重新授权' +
            (r.storageFault ? '。但本机有文件这次没读动（原因见上），别卸载重装' : '');
          if (r.storageFault) $('loginStatus').className = 'login-status err';
        } else if (r && r.clearError) {
          /* 窗开出来了但旧痕迹没清干净：这一页很可能还是那个半死会话，先把丑话说在前面 */
          $('loginStatus').textContent = '已打开登录窗口，但旧的登录痕迹没能全部清掉（' + r.clearError +
            '）—— 如果这一页又显示「无角色信息」，关掉软件再开一次试试';
          $('loginStatus').className = 'login-status err';
        }
        return { ok: true, cleared: !!(r && r.cleared), clearError: (r && r.clearError) || '',
          storageFault: !!r.storageFault };
      }, function (e) {
        var msg = '打不开登录窗口：' + ((e && e.message) || e);
        $('loginStatus').textContent = msg + ' —— 这一窗没开起来，可以再点一次';
        $('loginStatus').className = 'login-status err';
        return { ok: false, cleared: false, error: msg };
      });
    };
    $('btnOpenLogin').addEventListener('click', function () { openLoginWin(); });
    $('btnRecheck').addEventListener('click', function () { checkLogin(false); });
    $('btnSkipLogin').addEventListener('click', function () { enterOffline(state.matchCount); });
    $('btnOfflineRetry').addEventListener('click', retryFromOffline);
    $('btnOfflineLogin').addEventListener('click', function () {
      openLoginWin().then(function (r) {
        if (!r.ok) { toast(r.error, true); return; }
        if (!r.cleared && r.clearError) { toast('登录窗口打开了，但旧的登录痕迹没清干净：' + r.clearError, true); return; }
        toast(r.cleared ? '已清掉旧登录痕迹并打开登录窗口，登录成功后点「重试登录并同步」'
          : '已打开登录窗口，登录成功后点「重试登录并同步」');
      });
    });
    $('btnSync').addEventListener('click', function () {
      setNavDrawer(false);   // 竖屏下这颗按钮长在抽屉里，按完得让开看进度
      doSync();
    });

    var kw = document.getElementById('fMapKw');
    if (kw) kw.addEventListener('input', applyMatchFilters);

    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
      b.addEventListener('click', function () { switchView(b.dataset.view); });
    });

    global.df.on('login:done', function (e) {
      /* 壳会带上 persistError：登录这一步成了、可这一次没落到注册表上（安卓的读盘闸门挡的）。
       * 后半句不跟着报，人重启一次发现号又没了，只会当我们又一次"没反应"。 */
      $('loginStatus').textContent = '登录成功：' + (e.role && e.role.name || '') +
        (e.persistError ? '（但这次没记住：' + e.persistError + '）' : '') +
        /* loadFault：号切过来了、可这个号的库这次没读动 —— 与"没数据"是两件事，得说出口 */
        (e.loadFault ? '（这个号的库这次没读出来：' + e.loadFault + '）' : '');
      $('loginStatus').className = 'login-status ' +
        (e.persistError || e.loadFault ? 'err' : 'ok');
      state.loggedIn = true;
      setOffline(false);
      loadAccounts().then(function () {
        showApp({ revealNav: true });
        refresh().then(function () { doSync(); });
      });
    });
    /* 登录窗开着的时候，主进程每 2.5 秒会替我们问一次官方"我是谁"（QQ 与微信两套账号体系各一问）。
     * ★ 两套都没问到时，把官方回的错误码摊在这行字上 —— 上一版这里整个吞掉，
     *   登录不上的人能描述的只有一句"网页登录了但软件没反应"，谁也定位不到原因。 */
    global.df.on('login:probe', function (e) {
      if (!e || e.ok) return;
      if ($('appView').classList.contains('hidden') === false) return;
      var NAMES = { 1: 'QQ', 2: '微信' };
      var attempts = e.attempts || [];
      var parts = attempts.map(function (a) {
        return (NAMES[a.accountType] || a.accountType) + '：' +
          (a.code ? ('错误码 ' + a.code)
            : (a.reason === 'no_role' ? '没问到角色' : (a.reason || '没回应')));
      });
      var el = $('loginStatus');
      /* ★ 「会话有效、但这个身份下没有角色」与「还没登录完」是两件事，文案不能混着说：
       *   前者就是 WeGame 页面里那句「无角色信息」，喊"不用关窗口、再等等"是把人往死胡同里领。
       *   可这句话该第几轮说、那句原话怎么说，都不在这层判 —— core 数着轮次写好 advice，shell 原样转过来，
       *   这里只看 advice 有没有字（上一版这层自己数到 8 轮，桌面改了阈值手机还按旧的说话）。 */
      if (e.advice) {
        el.textContent = e.advice;
        el.className = 'login-status err';
        return;
      }
      el.textContent = '还在等你完成登录' +
        (parts.length ? '（' + parts.join(' · ') + '）' : '') +
        (e.message && !parts.length ? '（' + e.message + '）' : '') +
        (e.rounds ? '｜已经问了 ' + e.rounds + ' 轮' : '') +
        '—— 登录成功后这里会自己进去，不用关这个窗口。';
      el.className = 'login-status';
    });
    global.df.on('account:changed', function (e) {
      loadAccounts();
      if (e && e.slot) {
        // 切号后重跑 boot：会重新读账号数据 + 触发首次同步
        boot();
      }
    });
    global.df.on('login:window-closed', function () { checkLogin(true); });
    /* 在线更新：宿主查完（或换完）会推这一条，界面只跟着念，不自己判能不能更 */
    global.df.on('update:status', function (s) { renderUpdate(s); });
    bindUpdate();
    loadUpdate();
    /* 首次那一次自动取（全代码库唯一会自动发的一回）落地后：状态行与已经画出来的地名都要跟上 */
    global.df.on('mapNames:done', function () {
      loadMapNames();
      loadMapDict();   /* 字典开着的时候（#92）：本机学的条数与"本来叫什么"都跟着这一发变 */
      if (!$('appView').classList.contains('hidden')) refresh();
    });
    global.df.on('sync:start', function () {
      $('syncState').textContent = '正在采集数据…';
      $('syncBar').style.display = '';
      $('syncFill').style.width = '0%';
      $('syncCount').textContent = '0%';
      $('syncCount').style.display = '';
    });
    global.df.on('sync:progress', function (p) {
      p = p || {};
      var pct = Math.max(0, Math.min(100, Number(p.percent) || 0));
      $('syncState').textContent = p.label || p.stage || '处理中…';
      $('syncFill').style.width = pct + '%';
      $('syncCount').textContent = p.total > 1
        ? (pct + '%  ·  ' + p.done + '/' + p.total)
        : pct + '%';
    });
    global.df.on('sync:done', function (r) {
      var fill = $('syncFill');
      if (fill) fill.style.width = '100%';
      if (r && r.suspect) {
        toast('检测到约 ' + r.gapDays + ' 天的对局未进入采集窗口，已无法补采——详见「状态与节律」', true);
      }
      setTimeout(function () {
        $('syncBar').style.display = 'none';
        $('syncCount').style.display = 'none';
      }, 900);
    });
    global.df.on('boot:error', function (e) {
      showLogin('数据文件读取失败：' + ((e && e.error) || '未知错误'), 'err');
    });
    global.df.on('sync:auto', function (r) {
      // 定时同步是后台行为，只在真有新增时轻提示，避免打扰
      if (r && r.ok && r.inserted > 0) {
        toast('定时同步：新增 ' + r.inserted + ' 场');
        refresh();
      } else if (r && r.ok) {
        refresh();
      }
    });

    global.addEventListener('resize', function () { global.DFCharts.resize(); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindNavDrawer();
    bind();
    bindFilters();
    bindMatchTools();
    bindEncounters();
    bindMatchFlags();
    bindSandbox();
    bindAbout();
    bindSettings();
    bindAccounts();
    bindPlugins();
    if (global.df) boot();
    else showLogin('未检测到应用环境（请通过桌面程序启动）。', 'err');
  });
})(window);
