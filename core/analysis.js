/* analysis.js — 深度分析引擎（纯 JS，UMD）
 * 全部指标由「本软件采集到的对局」自行计算，不依赖官方统计口径
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./maps'), require('./stats'));
  } else {
    root.DFCore = root.DFCore || {};
    root.DFCore.Analysis = factory(root.DFCore.Maps, root.DFCore.Stats);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Maps, Stats) {
  'use strict';

  /* 评分权重：得分 / 击杀 / KDA / 占点（次）/ 救治
   * v1.4.0 起用户可配（settings.ratingWeights 存整数百分比），这里只是兜底口径
   * ★ `occupy` 官方给的是**占领 / 防守据点的次数**（真库 41 场实测：战局列表 0~6、
   *   全场名单里每人 0~12、四成人是 0），**不是**游戏结算面板里那个分值的「站点分」——
   *   两份接口都没有站点分这个字段，它只并进了总分 `score`。
   *   所以标签一律带「（次）」：不然使用者会拿游戏里看到的分数来对，一对不上就成了"你算错了"。 */
  var WEIGHT_KEYS = ['score', 'kill', 'kda', 'occupy', 'rescue'];
  var WEIGHT_NAMES = { score: '得分', kill: '击杀', kda: 'KDA', occupy: '占点（次）', rescue: '救治' };
  var DEFAULT_W = { score: 0.35, kill: 0.20, kda: 0.25, occupy: 0.10, rescue: 0.10 };
  /* 无全场名单时用于兜底的「满分基准」 */
  var BENCH = { score: 35000, kill: 40, kda: 3.0, occupy: 5, rescue: 60 };
  /* ★ KPM（每分钟击杀）的分母地板：名单里每个玩家都带自己的 game_time，
   *   短时段算出来的"每分钟击杀"没有可比性 —— 真库 42 场 / 2402 人次实测，
   *   按 KPM 排全场第一的人是"榜首时长不足 5 分钟"的有 **4 场**：
   *   8 秒 1 杀（KPM 7.5）、13 秒 3 杀（**KPM 13.85**）、15 秒 1 杀、37 秒 5 杀 ——
   *   而打满一场的人 KPM 只到 3 上下。四个越界者全在 60 秒以内，而 60~448 秒整段只有 357 人次
   *   （稀疏区），所以阈值落在 300 秒上并不敏感：挪到 180 或 420 秒，剔掉的是同一批人。
   *   口径只在这里定一次：界面只许读 board.minMinutes，不许自己划线。 */
  var KPM_MIN_SEC = 300;

  /* ★ 攻防身份（进攻方 / 防守方）：官方两份接口的原始字段里**没有**这个信息
   *   （抓包 tdm_players 全字段、gameResult 恒 0、官方 bundle 里连"进攻/防守"都搜不到都核过），
   *   唯一带得出它的载体是名单与战局里那枚 `color`。规则由使用者报的**地面真值**定下来
   *   （2026-09-25~28 四条，量测与复算入口：node tools/probe-camp.js --labels=...）：
   *     9-28 07:24 贯穿-占领   color=2 → 他说是【防守】
   *     9-26 15:14 摩格旧城区-攻防 color=1 → 【进攻】
   *     9-25 15:08 摩格旧城区-攻防 color=2 → 【防守】
   *     9-25 14:54 贯穿-攻防   color=2 → 【防守】
   *   ⇒ **color 1 = 进攻、2 = 防守**，四条全对；拿同一批真值试过的三条候选全错：
   *   "占点多的那边是进攻"(1/4)、"救治少的那边"(2/4)、"输的那边"(2/4) —— 所以载体只能是 color。
   *   ★ **模式闸门已拆（2026-09-29 他那句「全部模式包括胜者为王 也要看进攻或者是防守，为什么只弄了攻防？」）**：
   *   原来那句"只有攻防与占领才有攻守"是我自己加的推断，不是数据给的。量了他的库（rule 7×28 / 8×11 / 13×5）：
   *   **三种模式的名单里 color 都恰好是 1、2 两组**（如 1:20 / 2:20）⇒ 承载体是同一枚字段，
   *   所以现在一律按 color 给。哪些是地面真值核过的、哪些是按同一字段推定的，
   *   由 SIDE_VERIFIED 说给界面念，界面不许自己再划一遍。
   *   以后冒出反例，改的就是这一颗（连带 §31 那几条断言与 mutate-camp 那根针）。 */
  var SIDE_RULES = { 7: '攻防', 8: '占领' };
  /* 地面真值核过的模式：只有这两类是四条真值直接对上的，其余是同一字段推定 */
  var SIDE_VERIFIED = { 7: 1, 8: 1 };
  function sideOf(m) {
    if (!m) return '';
    return m.color === 1 ? '进攻' : (m.color === 2 ? '防守' : '');
  }
  /* 这一场的身份是"核过的"还是"推定的" —— 只给那句口径用，不参与任何计算 */
  function sideBasis(m) {
    return (m && SIDE_VERIFIED[m.game_rule]) ? 'verified' : 'inferred';
  }

  function sum(a, f) { return a.reduce(function (x, y) { return x + (f ? f(y) : y); }, 0); }
  function r2(v) { return Math.round(v * 100) / 100; }
  function r1(v) { return Math.round(v * 10) / 10; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* 读时才归一化：存档里是用户直接拖的整数（50/20/25/10/10 也行，和不为 100 也行）。
   * 单个键坏了（非数字 / 负数 / 缺键）只回退那一个键，整体和为 0 才整组回退 ——
   * 绝不能因为一处脏数据把评分算成 NaN 或者全 0。允许某个键恰好为 0。 */
  function weights(store) {
    var s = store && store.state && store.state.settings;
    var raw = (s && s.ratingWeights) || null;
    var out = {}, t = 0;
    WEIGHT_KEYS.forEach(function (k) {
      var v = raw ? Number(raw[k]) : NaN;
      out[k] = (isFinite(v) && v >= 0) ? v : (DEFAULT_W[k] * 100);
      t += out[k];
    });
    if (t <= 0) {
      WEIGHT_KEYS.forEach(function (k) { out[k] = DEFAULT_W[k] * 100; });
      t = 100;
    }
    WEIGHT_KEYS.forEach(function (k) { out[k] = out[k] / t; });
    return out;
  }

  /* 界面上那句「评分体系：…」的文案由它生成，避免 HTML 与 JS 各硬编码一份对不上 */
  function weightsText(w) {
    return WEIGHT_KEYS.map(function (k) {
      return WEIGHT_NAMES[k] + ' ' + Math.round(w[k] * 100) + '%';
    }).join(' · ');
  }

  /* ============================================================
   * 单局评分（0~100）
   *   有全场名单 → 在该场 46~52 人中的加权百分位（更能反映真实水平）
   *   无名单     → 对照固定基准的达成率
   * ============================================================ */
  function rating(m, players, openid, store) {
    var W = store ? weights(store) : DEFAULT_W;
    var v = {
      score: m.score || 0,
      kill: m.kill || 0,
      kda: m.death ? (m.kill + m.assist) / m.death : (m.kill + m.assist),
      occupy: m.occupy || 0,
      rescue: m.rescue || 0
    };
    if (players && players.length > 5) {
      var me = null;
      for (var i = 0; i < players.length; i++) {
        if (players[i].vopenid === String(openid)) { me = players[i]; break; }
      }
      if (me) {
        var total = players.length;
        function pctOf(key, val) {
          var rank = 0;
          for (var j = 0; j < players.length; j++) {
            var p = players[j];
            var pv = key === 'kda' ? (p.death ? (p.kill + p.assist) / p.death : (p.kill + p.assist)) : (p[key] || 0);
            if (pv > val) rank++;
          }
          return total > 1 ? ((total - 1 - rank) / (total - 1)) * 100 : 50;
        }
        var s = W.score * pctOf('score', v.score) +
                W.kill * pctOf('kill', v.kill) +
                W.kda * pctOf('kda', v.kda) +
                W.occupy * pctOf('occupy', v.occupy) +
                W.rescue * pctOf('rescue', v.rescue);
        return { value: r1(s), basis: 'lobby', players: total };
      }
    }
    var s2 = 100 * (W.score * clamp01(v.score / BENCH.score) +
                    W.kill * clamp01(v.kill / BENCH.kill) +
                    W.kda * clamp01(v.kda / BENCH.kda) +
                    W.occupy * clamp01(v.occupy / BENCH.occupy) +
                    W.rescue * clamp01(v.rescue / BENCH.rescue));
    return { value: r1(s2), basis: 'bench', players: 0 };
  }

  /* ============================================================
   * 基础汇总
   * ============================================================ */
  function summarize(rows) {
    var n = rows.length;
    if (!n) return null;
    var win = rows.filter(function (m) { return m.is_winner; }).length;
    var kill = sum(rows, function (m) { return m.kill; });
    var death = sum(rows, function (m) { return m.death; });
    var assist = sum(rows, function (m) { return m.assist; });
    var score = sum(rows, function (m) { return m.score; });
    var time = sum(rows, function (m) { return m.game_time; });
    var leaveRate = r2((rows.filter(function (m) { return m.is_leave; }).length / n) * 100);
    /* ★ 每一个胜率都自带区间与可靠性档位：界面只要照抄，不许再自己判断"这算不算多" */
    var ci = Stats.wilson(win, n);
    return {
      total: n, win: win, lose: n - win,
      winRate: r2((win / n) * 100),
      ci: ci, reliability: Stats.reliability(n, ci),
      kill: kill, death: death, assist: assist,
      kd: death ? r2(kill / death) : kill,
      kda: death ? r2((kill + assist) / death) : (kill + assist),
      score: score,
      avgScore: Math.round(score / n),
      avgKill: r2(kill / n), avgDeath: r2(death / n), avgAssist: r2(assist / n),
      scorePerMin: time ? Math.round(score / (time / 60)) : 0,
      killPerMin: time ? r2(kill / (time / 60)) : 0,
      avgDurationMin: r2(time / n / 60),
      occupy: sum(rows, function (m) { return m.occupy; }),
      rescue: sum(rows, function (m) { return m.rescue; }),
      avgOccupy: r2(sum(rows, function (m) { return m.occupy; }) / n),
      avgRescue: r2(sum(rows, function (m) { return m.rescue; }) / n),
      leaveRate: leaveRate,
      totalHours: r2(time / 3600)
    };
  }

  /* ============================================================
   * 筛选
   * ============================================================ */
  function applyFilters(store, f) {
    f = f || {};
    var mode = f.mode || 'all';
    var kind = f.kind || 'all';
    var leave = f.leave || 'all';
    var rows = store.matches({ mode: mode, kind: kind, leave: leave, since: f.since, mapId: f.mapId });
    var all = store.matches({});
    /* ★ 漏斗那几格以前在这儿重抄了一遍模式判定 —— 同一套规则的第二份真值，改一处必漏一处。
     *   现在全部走 store.matches()（判定唯一源头在 core/store.js 的 passes），口径与 rows 同源。
     *   kind='all' 时这三个数与重构前逐字相等，所以不动任何既有断言。 */
    var afterMode = store.matches({ mode: mode }).length;
    var afterKind = store.matches({ mode: mode, kind: kind }).length;
    var leaveExcluded = store.matches({ mode: mode, kind: kind, leave: 'exclude' }).length;
    return {
      rows: rows,
      poolSize: all.length,
      afterMode: afterMode,
      afterKind: afterKind,
      afterLeave: leaveExcluded
    };
  }

  /* ============================================================
   * 时间序列 / 日聚合 / 连胜连败
   * ============================================================ */
  function series(rows) {
    return rows.slice().sort(function (a, b) { return a.start_time - b.start_time; }).map(function (m) {
      return {
        t: m.start_time,
        label: (m.dt_event_time || '').slice(5, 16),
        date: (m.dt_event_time || '').slice(0, 10),
        score: m.score, kd: m.kd, kill: m.kill, death: m.death, assist: m.assist,
        win: m.is_winner ? 1 : 0, scorePerMin: m.score_per_min,
        /* KPM 走现算而不是只读存的 kill_per_min：导出/旧库里那一场可能压根没有这一列，
         * 没有时长就给 null（界面那一格画「—」），不许拿 0 顶 —— 0 会被折线图当成"这一场一个人都没杀"。 */
        killPerMin: (m.game_time || 0) > 0 ? r2((m.kill || 0) / (m.game_time / 60)) : null,
        occupy: m.occupy, rescue: m.rescue, mapName: Maps.nameOf(m.map_id),
        /* 攻防身份随行走（判据就是上面那颗 sideOf，界面只念）：没有这个概念的模式回 ''，
         * 界面那格要画空而不是画「—」——「—」会被读成"这场有攻防但我不知道" */
        side: sideOf(m), rule: m.game_rule,
        isLeave: m.is_leave, roomId: m.room_id, isSWWR: m.is_swtwr
      };
    });
  }

  function byDay(rows) {
    var g = {};
    rows.forEach(function (m) {
      var d = (m.dt_event_time || '').slice(0, 10) || '未知';
      (g[d] = g[d] || []).push(m);
    });
    return Object.keys(g).sort().map(function (d) {
      var s = summarize(g[d]);
      s.day = d;
      return s;
    });
  }

  function streak(rows) {
    var s = rows.slice().sort(function (a, b) { return a.start_time - b.start_time; });
    var best = 0, worst = 0, curDir = 0, curLen = 0;
    s.forEach(function (m) {
      var d = m.is_winner ? 1 : -1;
      if (d === curDir) curLen++; else { curDir = d; curLen = 1; }
      if (curDir > 0) best = Math.max(best, curLen); else worst = Math.max(worst, curLen);
    });
    var tail = 0, dir = 0;
    for (var i = s.length - 1; i >= 0; i--) {
      var dd = s[i].is_winner ? 1 : -1;
      if (dir === 0) { dir = dd; tail = 1; }
      else if (dd === dir) tail++;
      else break;
    }
    return { bestWin: best, worstLose: worst, currentStreak: tail, currentWin: dir > 0 };
  }

  /* ============================================================
   * 近 N 局胜率 / 分段胜率
   * ============================================================ */
  function windowStats(rows) {
    var desc = rows.slice().sort(function (a, b) { return b.start_time - a.start_time; });
    function winOf(n) {
      var seg = desc.slice(0, n);
      if (!seg.length) return null;
      var w = seg.filter(function (m) { return m.is_winner; }).length;
      var ci = Stats.wilson(w, seg.length);
      return { n: seg.length, win: w, lose: seg.length - w, winRate: r2((w / seg.length) * 100),
        ci: ci, reliability: Stats.reliability(seg.length, ci) };
    }
    var out = { last10: winOf(10), last20: winOf(20), last30: winOf(30), last50: winOf(50) };
    // 滚动 10 局胜率曲线（按时间正序的每个窗口）
    var asc = rows.slice().sort(function (a, b) { return a.start_time - b.start_time; });
    var roll = [];
    for (var i = 0; i < asc.length; i++) {
      var from = Math.max(0, i - 9);
      var seg = asc.slice(from, i + 1);
      var w = seg.filter(function (m) { return m.is_winner; }).length;
      roll.push({
        label: (asc[i].dt_event_time || '').slice(5, 16),
        v: r1((w / seg.length) * 100),
        n: seg.length
      });
    }
    out.rolling10 = roll;
    return out;
  }

  /* ============================================================
   * 评分曲线 / 评分分布
   * ============================================================ */
  function ratingSeries(store, rows) {
    var openid = store.activeOpenid();
    var asc = rows.slice().sort(function (a, b) { return a.start_time - b.start_time; });
    return asc.map(function (m) {
      var rt = rating(m, store.players(m.room_id), openid, store);
      return {
        roomId: m.room_id,
        label: (m.dt_event_time || '').slice(5, 16),
        date: (m.dt_event_time || '').slice(0, 10),
        value: rt.value,
        basis: rt.basis,
        win: m.is_winner ? 1 : 0,
        mapName: Maps.nameOf(m.map_id),
        score: m.score, kill: m.kill, death: m.death, assist: m.assist
      };
    });
  }

  function ratingStats(series) {
    if (!series.length) return null;
    var vals = series.map(function (x) { return x.value; });
    var avg = sum(vals) / vals.length;
    var sorted = vals.slice().sort(function (a, b) { return a - b; });
    function quantile(p) {
      var idx = (sorted.length - 1) * p;
      var lo = Math.floor(idx), hi = Math.ceil(idx);
      return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    }
    // 分段分布
    var buckets = [
      { range: '90-100 统治级', min: 90, max: 100, count: 0 },
      { range: '75-89 优秀', min: 75, max: 89.99, count: 0 },
      { range: '60-74 良好', min: 60, max: 74.99, count: 0 },
      { range: '40-59 一般', min: 40, max: 59.99, count: 0 },
      { range: '0-39 低迷', min: 0, max: 39.99, count: 0 }
    ];
    vals.forEach(function (v) {
      for (var i = 0; i < buckets.length; i++) {
        if (v >= buckets[i].min && v <= buckets[i].max) { buckets[i].count++; break; }
      }
    });
    buckets.forEach(function (b) { b.pct = r2((b.count / vals.length) * 100); });
    // 滚动 10 局均分
    var roll = series.map(function (x, i) {
      var from = Math.max(0, i - 9);
      var seg = series.slice(from, i + 1);
      return { label: x.label, v: r1(sum(seg, function (s) { return s.value; }) / seg.length) };
    });
    return {
      avg: r1(avg),
      max: Math.max.apply(null, vals),
      min: Math.min.apply(null, vals),
      median: r1(quantile(0.5)),
      p25: r1(quantile(0.25)),
      p75: r1(quantile(0.75)),
      buckets: buckets,
      rolling10: roll,
      lobbyBasis: series.filter(function (x) { return x.basis === 'lobby'; }).length,
      benchBasis: series.filter(function (x) { return x.basis === 'bench'; }).length
    };
  }

  /* ============================================================
   * 分地图（全部由本地对局统计）
   * 分组键：map_id + 模式（胜者为王 / 指挥官 / 常规），
   * 同一张图不同模式各成一行，避免胜率与评分混合失真
   * ============================================================ */
  function modeOfMatch(m) {
    return m.is_commander ? 'commander' : (m.is_swtwr ? 'swtwr' : 'normal');
  }
  function modeLabel(kind) {
    return kind === 'swtwr' ? '胜者为王' : (kind === 'commander' ? '指挥官' : '常规');
  }
  function byMap(store, rows) {
    var openid = store.activeOpenid();
    var g = {};
    rows.forEach(function (m) {
      var kind = modeOfMatch(m);
      var k = String(m.map_id) + '|' + kind;
      if (!g[k]) g[k] = { map_id: m.map_id, modeKind: kind,
        mapName: Maps.nameOf(m.map_id), rows: [] };
      g[k].rows.push(m);
    });
    return Object.keys(g).map(function (k) {
      var x = g[k];
      var s = summarize(x.rows);
      s.map_id = x.map_id;
      s.mapName = x.mapName;
      s.modeKind = x.modeKind;
      s.mode = modeLabel(x.modeKind);
      s.rating = r1(sum(x.rows, function (m) {
        return rating(m, store.players(m.room_id), openid, store).value;
      }) / x.rows.length);
      s.killTotal = sum(x.rows, function (m) { return m.kill; });
      s.deathTotal = sum(x.rows, function (m) { return m.death; });
      s.rescueTotal = sum(x.rows, function (m) { return m.rescue; });
      s.occupyTotal = sum(x.rows, function (m) { return m.occupy; });
      /* ★ 同一张图按攻防身份拆开（判据仍只有 sideOf 那一颗；color 缺值时两边都是 null） */
      s.atk = summarize(x.rows.filter(function (m) { return sideOf(m) === '进攻'; }));
      s.def = summarize(x.rows.filter(function (m) { return sideOf(m) === '防守'; }));
      return s;
    }).sort(function (a, b) { return b.total - a.total; });
  }

  /* 每张地图自己的攻守对照（他 2026-09-29 点名：「我不单单只看进攻和防守的胜率对照，我要看每张地图的」）。
   * ★ "看不看得出方向"的尺与 sideSplit 同一把：两边 Wilson 区间互不重叠才允许说哪边更稳，
   *   否则老实说"这张图当前场次下说不出方向"。方向句写在这里，界面一个字都不判断。 */
  function sideByMap(maps) {
    return (maps || []).filter(function (m) { return m.atk && m.def; }).map(function (m) {
      var diff = r1(m.atk.winRate - m.def.winRate);
      var decisive = !!(m.atk.ci && m.def.ci &&
        (m.atk.ci.lo > m.def.ci.hi || m.def.ci.lo > m.atk.ci.hi));
      return {
        map_id: m.map_id, mapName: m.mapName, mode: m.mode, modeKind: m.modeKind,
        attack: m.atk, defend: m.def, diff: diff, decisive: decisive,
        total: m.atk.total + m.def.total,
        note: decisive
          ? (diff > 0 ? '这张图打进攻方赢得更稳' : '这张图打防守方赢得更稳') +
            '（差 ' + Math.abs(diff) + ' 个百分点，两边区间不重叠）'
          : '差 ' + Math.abs(diff) + ' 个百分点，两边区间重叠 —— 这张图（' + m.atk.total + ' 攻 / ' +
            m.def.total + ' 守）在当前场次下说不出方向'
      };
    }).sort(function (a, b) { return b.total - a.total; });
  }

  /* 全部对局的攻防胜率对照。窗口只有 36 场左右，所以：
   * ① 两个桶各自的场次必须报出来（进攻 5 场 / 防守 30 场那种对照不能写成结论）；
   * ② 方向只在两边区间互不重叠时才敢说（与 §29 那条"档间决定力"同一把尺子），
   *    否则正文只报数、不排名。 */
  function sideSplit(rows) {
    var atk = rows.filter(function (m) { return sideOf(m) === '进攻'; });
    var def = rows.filter(function (m) { return sideOf(m) === '防守'; });
    var a = summarize(atk), d = summarize(def);
    var out = { attack: a, defend: d, noSide: rows.length - atk.length - def.length };
    var diff = (a && d) ? r1(a.winRate - d.winRate) : null;
    out.diff = diff;
    var decisive = !!(a && d && a.ci && d.ci && (a.ci.lo > d.ci.hi || d.ci.lo > a.ci.hi));
    out.decisive = decisive;
    out.headline = (!a && !d)
      ? '这一阵子里 ' + rows.length + ' 场都没带上阵营编号（接口那个 color 字段是空的）—— ' +
        '进攻 / 防守就是从这一个字段推的，它缺了两侧就都无从对照。这不是软件坏了：' +
        '除了这一个字段缺值，我们不对任何场次下"它没有攻防"这个结论。'
      : (!a || !d)
      ? '这一阵子里只抓到' + (a ? '进攻方 ' + a.total + ' 场' : (d ? '防守方 ' + d.total + ' 场' : '带攻防身份的对局')) +
        '，另一侧一场都没有 —— 单边没有对照，说不出"打进攻赢面大还是打防守赢面大"。'
      : (!decisive
        ? '进攻方 ' + a.total + ' 场赢 ' + a.winRate + '%，防守方 ' + d.total + ' 场赢 ' + d.winRate +
          '%（差 ' + Math.abs(diff) + ' 个百分点）—— 两边区间重叠，这个差在当前场次下看不出方向，别当结论读。'
        : '进攻方 ' + a.total + ' 场赢 ' + a.winRate + '%，防守方 ' + d.total + ' 场赢 ' + d.winRate +
          '% —— 区间互不重叠，' + (diff > 0 ? '打进攻方时' : '打防守方时') + '赢得更稳（差 ' +
          Math.abs(diff) + ' 个百分点）。');
    return out;
  }

  /* ============================================================
   * 兵种 / 干员表现
   * ============================================================ */
  function groupBy(store, rows, keyFn, metaFn) {
    var openid = store.activeOpenid();
    var g = {};
    rows.forEach(function (m) {
      var k = keyFn(m);
      if (k === null || k === undefined) return;
      if (!g[k]) g[k] = { key: k, meta: metaFn(k), rows: [] };
      g[k].rows.push(m);
    });
    return Object.keys(g).map(function (k) {
      var x = g[k];
      var s = summarize(x.rows);
      s.key = x.key;
      Object.assign(s, x.meta);
      s.rating = r1(sum(x.rows, function (m) {
        return rating(m, store.players(m.room_id), openid, store).value;
      }) / x.rows.length);
      return s;
    }).sort(function (a, b) { return b.total - a.total; });
  }

  /* 按兵种：突击 / 医疗 / 工程 / 侦查 / 指挥官 */
  function byClass(store, rows) {
    return groupBy(store, rows,
      function (m) { return m.force_type ? Maps.forceClass(m.force_type) : null; },
      function (k) { return { label: k }; });
  }

  /* 按干员：红狼 / 蜂医 / 比特 … */
  function byAgent(store, rows) {
    return groupBy(store, rows,
      function (m) { return m.force_type || null; },
      function (k) {
        return { label: Maps.forceName(k), agent: Maps.agentName(k), cls: Maps.forceClass(k) };
      });
  }

  /* ============================================================
   * 指挥官
   * 官方指挥官专用接口（GetCommanderStats 等）返回 404 未开放，
   * 而「用赤枭单位出战」并不等于当指挥官 —— 因此指挥官场次只认用户在
   * 单场详情页里的手动标记（store.flags → match.is_commander）。
   * 被标记的场次通常也是胜者为王，会同时出现在两个筛选下，但只有一条战局记录。
   * ============================================================ */
  function isCommanderMatch(m) {
    return !!(m && m.is_commander);
  }

  function commanderStats(store, allRows) {
    var openid = store.activeOpenid();
    var rows = allRows.filter(isCommanderMatch);
    if (!rows.length) {
      return { available: false, total: 0 };
    }
    var s = summarize(rows);
    s.available = true;
    s.rating = r1(sum(rows, function (m) {
      return rating(m, store.players(m.room_id), openid, store).value;
    }) / rows.length);

    var normal = allRows.filter(function (m) { return !isCommanderMatch(m); });
    if (normal.length) {
      var ns = summarize(normal);
      s.vsNormal = {
        winRate: r2(s.winRate - ns.winRate),
        kd: r2(s.kd - ns.kd),
        avgScore: Math.round(s.avgScore - ns.avgScore),
        normalWinRate: ns.winRate, normalKd: ns.kd, normalAvgScore: ns.avgScore
      };
    }
    s.agents = {};
    rows.forEach(function (m) {
      var nm = Maps.agentName(m.force_type);
      if (nm) s.agents[nm] = (s.agents[nm] || 0) + 1;
    });
    return s;
  }

  /* ============================================================
   * 救援量化
   * ============================================================ */
  function rescueMetrics(store, rows) {
    if (!rows.length) return null;
    var openid = store.activeOpenid();
    var time = sum(rows, function (m) { return m.game_time; });
    var rescue = sum(rows, function (m) { return m.rescue; });
    var death = sum(rows, function (m) { return m.death; });
    var withRoster = 0, teamShare = [], rescueRankPct = [];
    rows.forEach(function (m) {
      var ps = store.players(m.room_id);
      if (ps.length < 5) return;
      withRoster++;
      var me = null;
      for (var i = 0; i < ps.length; i++) if (ps[i].vopenid === String(openid)) { me = ps[i]; break; }
      if (!me) return;
      var myTeam = ps.filter(function (p) { return p.color === me.color; });
      var teamRescue = sum(myTeam, function (p) { return p.rescue; });
      if (teamRescue > 0) teamShare.push(me.rescue / teamRescue);
      var rank = 0;
      for (var j = 0; j < ps.length; j++) if ((ps[j].rescue || 0) > me.rescue) rank++;
      rescueRankPct.push(ps.length > 1 ? ((ps.length - 1 - rank) / (ps.length - 1)) * 100 : 50);
    });
    return {
      total: rescue,
      avg: r2(rescue / rows.length),
      perMin: time ? r2(rescue / (time / 60)) : 0,
      rescueDeathRatio: death ? r2(rescue / death) : rescue,
      teamShare: teamShare.length ? r2(sum(teamShare) / teamShare.length * 100) : null,
      rankPct: rescueRankPct.length ? r1(sum(rescueRankPct) / rescueRankPct.length) : null,
      sampleWithRoster: withRoster
    };
  }

  /* ============================================================
   * 击杀明细
   * ============================================================ */
  function killMetrics(rows) {
    if (!rows.length) return null;
    var kills = rows.map(function (m) { return m.kill; });
    var sorted = kills.slice().sort(function (a, b) { return b - a; });
    var buckets = [
      { range: '30+ 局', min: 30, count: 0 },
      { range: '20-29', min: 20, max: 29, count: 0 },
      { range: '10-19', min: 10, max: 19, count: 0 },
      { range: '5-9', min: 5, max: 9, count: 0 },
      { range: '0-4', min: 0, max: 4, count: 0 }
    ];
    kills.forEach(function (k) {
      for (var i = 0; i < buckets.length; i++) {
        var b = buckets[i];
        if (k >= b.min && (b.max === undefined || k <= b.max)) { b.count++; break; }
      }
    });
    buckets.forEach(function (b) { b.pct = r2((b.count / kills.length) * 100); });
    var time = sum(rows, function (m) { return m.game_time; });
    return {
      total: sum(kills),
      avg: r2(sum(kills) / kills.length),
      max: sorted[0],
      min: sorted[sorted.length - 1],
      perMin: time ? r2(sum(kills) / (time / 60)) : 0,
      buckets: buckets,
      bestMatches: rows.slice().sort(function (a, b) { return b.kill - a.kill; }).slice(0, 5)
        .map(function (m) {
          return { roomId: m.room_id, kill: m.kill, death: m.death, assist: m.assist,
                   mapName: Maps.nameOf(m.map_id), time: m.dt_event_time };
        })
    };
  }

  /* ============================================================
   * 单场全场对比（同局其他人的分差与表现）
   * ============================================================ */
  function lobbyCompare(store, roomId) {
    var m = store.match(roomId);
    if (!m) return null;
    var players = store.players(roomId);
    var openid = store.activeOpenid();
    var base = {
      match: Object.assign({}, m, {
        mapName: Maps.nameOf(m.map_id),
        /* 这一场的攻防身份（判据 = sideOf 那颗；没有这个概念的模式回空串） */
        side: sideOf(m),
        force_name: m.force_type ? Maps.forceName(m.force_type) : ''
      }),
      rating: rating(m, players, openid, store),
      /* 「这场比你自己平时好多少」——和上面那个"你在 52 人里排第几"是两把尺子，各自算各自的 */
      baseline: baselineFor(store, m),
      roster: players.length
    };
    if (players.length < 5) return base;

    var me = null;
    for (var i = 0; i < players.length; i++) if (players[i].vopenid === String(openid)) { me = players[i]; break; }
    if (!me) return Object.assign({}, base, {
      /* ★ 名单有了、但里面找不到"你自己"：拿数据包导入的号、只读号最容易走到这一支
       *   （名单里的 vopenid 是原账号那一侧的，本机这个号对不上）。
       *   同局排名与各项百分位都要拿自己那一行去比，比不了就不给 ——
       *   界面必须能从数据里认出"是没抓到名单"还是"抓到了但没有我"，两种要说明白不同的一句话。 */
      meMissing: true
    });

    function avgOf(list, key) { return list.length ? sum(list, function (p) { return p[key] || 0; }) / list.length : 0; }
    function kdaOf(p) { return p.death ? (p.kill + p.assist) / p.death : (p.kill + p.assist); }
    /* KPM 现算：名单里的原始字段只有 kill 与 game_time，没有第二个分母来源。
     * 不足 KPM_MIN_SEC 的人**照样算给他看**（名单里那一列不能凭空变空），但不进榜 ——
     * 榜是拿来比高低的，8 秒 1 杀不该排在打满 13 分钟的人前面。 */
    function kpmOf(p) { return p.game_time > 0 ? r2(p.kill / (p.game_time / 60)) : null; }
    function kpmEligible(p) { return (p.game_time || 0) >= KPM_MIN_SEC; }
    /* ★ 阵营只认这一处判据（p.color === me.color，与手册 §6.2 是同一条）：
     *   官方名单里**没有任何进攻/防守字段** —— 抓包原文 tdm_players 的全字段核过一遍，
     *   gameResult 真库 42 场恒为 0，官方网页那份 bundle 里连"进攻/防守/阵营"三个字都搜不到。
     *   所以这里只给得出「我方 / 对方」；胜负是推出来的（名单不返回 isWinner，见下面 sides 那段）。
     *   编号本身留在 campId 里，界面要在 title 里如实带上，别让人以为我们认得进攻方是谁。 */
    function campOf(p) {
      var mine = p.color === me.color;
      /* 攻防身份这一格也走同一颗判据（把这个人自己的 color 交回 sideOf）：
       * 有攻防概念的规则（rule 7/8）才给字，胜者为王那类回空串，界面画「—」。
       * ★ 这一颗必须写在字面量**里面**：上一版我把它接在 `};` 后面，那是个合法的字面标签语句
       *   （node --check 全绿、探针也照样画得出「—」），字段根本不存在 —— 语法过不了的错好抓，
       *   这种"过了语法但静悄悄丢字段"的才危险，所以 §31 直接钉 campSide 的取值。 */
      return { campId: p.color, campMine: mine, campLabel: mine ? '我方' : '对方',
        campWin: mine ? !!m.is_winner : !m.is_winner,
        campSide: sideOf({ game_rule: m.game_rule, color: p.color }) };
    }
    /* 名单与榜单上的行都要带关注标记，但 store.players() 给的是 roster 里的同一批引用 ——
     * 一律另建对象，绝不就地写。 */
    function annotate(p) {
      var w = wi.byVid[String(p.vopenid)];
      return Object.assign({}, p, campOf(p), {
        kpm: kpmOf(p), kpmThin: !kpmEligible(p),
        watchKey: w ? w.key : '',
        watched: !!(w && w.watched),
        watchable: !!(w && w.confidence !== 'slot')
      });
    }

    var total = players.length;
    var myTeam = players.filter(function (p) { return p.color === me.color; });
    var enemies = players.filter(function (p) { return p.color !== me.color; });
    var wi = watchIndex(store, roomId);

    function rankBy(key) {
      var ranked = players.slice().sort(function (a, b) {
        var av = key === 'kda' ? kdaOf(a) : (a[key] || 0);
        var bv = key === 'kda' ? kdaOf(b) : (b[key] || 0);
        return bv - av;
      });
      for (var r = 0; r < ranked.length; r++) if (ranked[r].vopenid === me.vopenid) return r + 1;
      return -1;
    }
    function pctOf(rank) { return rank > 0 && total > 1 ? r1(((total - rank) / (total - 1)) * 100) : null; }

    var myScore = me.score || 0;
    var lobbyAvg = avgOf(players, 'score');
    var teamAvg = avgOf(myTeam, 'score');
    var enemyAvg = avgOf(enemies, 'score');

    /* ★ 名单里哪几列不能信：官方"战局列表"与"单局详情"填列有先后。
     *   实测 09-25 15:11 那场，列表给我 rescue = 36，而详情名单里 78 人全场之和才 14 ——
     *   拿这份半份名单排名，会把你排到 78 人的末尾（差 36 名）。
     *   判据只在 core/store 那一处（rosterGaps），这里只负责把**踩在不可信列上的派生值**全部置 null，
     *   让界面只能显示「—」而不是一个看起来很正常的假数。 */
    var gaps = typeof store.rosterGaps === 'function' ? store.rosterGaps(roomId) : [];
    var GAP_DIFF = { kill: ['vsLobbyKill', 'lobbyAvgKill'], rescue: ['vsLobbyRescue', 'lobbyAvgRescue'],
      occupy: ['vsLobbyOccupy', 'lobbyAvgOccupy'], score: ['vsLobbyScore', 'lobbyAvgScore'] };
    var lobbyAvgKda = sum(players, function (p) { return kdaOf(p); }) / total;

    var out = Object.assign(base, {
      me: me,
      meKda: r2(kdaOf(me)),
      ranks: {
        score: { rank: rankBy('score'), pct: pctOf(rankBy('score')) },
        kill: { rank: rankBy('kill'), pct: pctOf(rankBy('kill')) },
        kda: { rank: rankBy('kda'), pct: pctOf(rankBy('kda')) },
        rescue: { rank: rankBy('rescue'), pct: pctOf(rankBy('rescue')) },
        occupy: { rank: rankBy('occupy'), pct: pctOf(rankBy('occupy')) }
      },
      diffs: {
        vsLobbyScore: Math.round(myScore - lobbyAvg),
        vsTeamScore: Math.round(myScore - teamAvg),
        vsEnemyScore: Math.round(myScore - enemyAvg),
        lobbyAvgScore: Math.round(lobbyAvg),
        teamAvgScore: Math.round(teamAvg),
        enemyAvgScore: Math.round(enemyAvg),
        /* ★ 判定双方强弱用这一枚**相对差**（正 = 对面人均更高），不是绝对分值差：
         *   人均分随局的长短浮动极大（真库 39 场实测 3,792 → 30,313，跨 8 倍），
         *   写死"差 3000 才算压制"会让 82% 的场次都判成"势均力敌"。 */
        sideGapRel: (teamAvg + enemyAvg) > 0 ?
          r1((enemyAvg - teamAvg) / ((teamAvg + enemyAvg) / 2) * 100) : null,
        vsLobbyKill: r2(me.kill - avgOf(players, 'kill')),
        lobbyAvgKill: r2(avgOf(players, 'kill')),
        vsLobbyKda: r2(kdaOf(me) - lobbyAvgKda),
        lobbyAvgKda: r2(lobbyAvgKda),
        vsLobbyRescue: r2(me.rescue - avgOf(players, 'rescue')),
        lobbyAvgRescue: r2(avgOf(players, 'rescue')),
        vsLobbyOccupy: r2(me.occupy - avgOf(players, 'occupy')),
        lobbyAvgOccupy: r2(avgOf(players, 'occupy'))
      },
      // 阵营胜负：官方名单里的玩家记录**不返回 isWinner**（实测 463 人次全为 0），
      // 因此用「我的 color + 我这一场的胜负」推导：我所在阵营 = 我的结果，另一阵营相反。
      // 已验证我的 color 与名单内对应记录的 color 100% 一致。
      sides: [myTeam, enemies].map(function (team) {
        var color = team[0] ? team[0].color : 0;
        var isMine = team.some(function (p) { return p.vopenid === me.vopenid; });
        return {
          color: color, players: team.length,
          kill: sum(team, function (p) { return p.kill; }),
          death: sum(team, function (p) { return p.death; }),
          assist: sum(team, function (p) { return p.assist; }),
          score: sum(team, function (p) { return p.score; }),
          rescue: sum(team, function (p) { return p.rescue; }),
          occupy: sum(team, function (p) { return p.occupy; }),
          avgScore: Math.round(avgOf(team, 'score')),
          kd: sum(team, function (p) { return p.death; })
            ? r2(sum(team, function (p) { return p.kill; }) / sum(team, function (p) { return p.death; })) : 0,
          /* 阵营 KPM = 这一边的总击杀 ÷ 这一边的总时长（分钟）。
           * 用的是**整队打满的分钟数**，不是场数，所以中途退出的人不会把这一栏抬高。 */
          kpm: sum(team, function (p) { return p.game_time; }) > 0
            ? r2(sum(team, function (p) { return p.kill; }) / (sum(team, function (p) { return p.game_time; }) / 60)) : 0,
          win: isMine ? !!m.is_winner : !m.is_winner,
          /* 这一边的攻防身份（进攻 / 防守 / 空）—— 同一颗 sideOf，只是把这一边的 color 交进去 */
          side: sideOf({ game_rule: m.game_rule, color: color }),
          isMine: isMine
        };
      }),
      /* 榜单不只给前几名，而是给「全量排序 + 我的名次」。
       * 这样界面上即使我只排到第 30 名，也能把自己那一行补出来，
       * 而不会被 slice 直接截掉——「榜上找不到自己」是很糟糕的体验。
       * 榜上的每一行都走 annotate：界面要拿阵营与关注标记，而 core 不认得分榜/击杀榜各自不同。 */
      boards: {
        score: boardOf('score'),
        kill: boardOf('kill'),
        rescue: boardOf('rescue'),
        kpm: kpmBoardOf()
      },
      topScore: players.slice().sort(function (a, b) { return b.score - a.score; }).slice(0, 10),
      topKill: players.slice().sort(function (a, b) { return b.kill - a.kill; }).slice(0, 10),
      topRescue: players.slice().sort(function (a, b) { return b.rescue - a.rescue; }).slice(0, 10),
      /* ★ store.players() 给的是 roster 里的同一批引用，标注只能另建对象，绝不能就地写 */
      allPlayers: players.slice().sort(function (a, b) { return b.score - a.score; }).map(annotate),
      watchedCount: wi.count,
      rosterGaps: gaps
    });

    /* 不可信的列：排名 / 榜单 / 与全场人均的差值全部作废（留 null，界面只能显示「—」）。
     * 击杀不可信时 KDA 与 KPM 也要跟着作废 —— 两个都是用击杀算出来的。 */
    var GAP_RANKS = { kill: ['kill', 'kda', 'kpm'] };
    gaps.forEach(function (f) {
      (GAP_RANKS[f] || [f]).forEach(function (col) {
        if (out.ranks[col]) out.ranks[col] = { rank: null, pct: null, untrusted: true };
        if (out.boards[col]) out.boards[col] = null;
        if (col === 'kda') out.meKda = null;
      });
      (GAP_DIFF[f] || []).forEach(function (key) { out.diffs[key] = null; });
    });
    return out;

    function boardOf(key) {
      var sorted = players.slice().sort(function (a, b) {
        return (b[key] || 0) - (a[key] || 0);
      }).map(annotate);
      var mine = -1;
      for (var r = 0; r < sorted.length; r++) {
        if (sorted[r].vopenid === me.vopenid) { mine = r + 1; break; }
      }
      return { key: key, list: sorted, myRank: mine, total: total };
    }

    /* KPM 榜：只在打满 KPM_MIN_SEC 的人里排（见上面那条地板的实测出处）。
     * 三个数都得带出去，界面才不至于说谎：
     *   thin = 这一场有多少人被地板挡在榜外（不报数就像"全场 52 人的榜"其实只排了 40 人）；
     *   myRank = -1 还不够，要知道"我"是不是被地板挡掉的那一个（myThin），
     *            否则界面只能念「你不在本场名单中」—— 明明在名单里，那句话是假的。 */
    function kpmBoardOf() {
      var eligible = players.filter(kpmEligible).map(annotate)
        .sort(function (a, b) { return (b.kpm || 0) - (a.kpm || 0); });
      var mine = -1;
      for (var r = 0; r < eligible.length; r++) {
        if (eligible[r].vopenid === me.vopenid) { mine = r + 1; break; }
      }
      return {
        key: 'kpm', list: eligible, myRank: mine, total: eligible.length,
        thin: total - eligible.length, myThin: mine < 0,
        minMinutes: Math.round(KPM_MIN_SEC / 60)
      };
    }
  }

  /* ============================================================
   * 洞察
   * ============================================================ */
  function insights(store, rows, allRows) {
    var out = [];
    if (!rows.length) {
      out.push({
        level: 'info',
        title: allRows.length ? '当前筛选条件下没有对局' : '还没有采集到对局',
        text: allRows.length
          ? '本地已采集 ' + allRows.length + ' 场，试试把「模式」筛选改成「全部模式」。'
          : '点左下角「立即同步」开始采集。'
      });
      return out;
    }
    var s = summarize(rows);
    var mapsAll = byMap(store, rows);
    var minSamples = Math.min(3, Math.max(2, Math.floor(rows.length / 4)));
    var maps = mapsAll.filter(function (m) { return m.total >= minSamples; });

    if (maps.length >= 2) {
      var worst = maps.slice().sort(function (a, b) { return a.winRate - b.winRate; })[0];
      var best = maps.slice().sort(function (a, b) { return b.winRate - a.winRate; })[0];
      if (worst.winRate < 40) {
        out.push({
          level: 'warn',
          title: '短板地图：' + worst.mapName + '（' + worst.mode + '）',
          text: worst.total + ' 场，胜率 ' + worst.winRate + '%，比最好的 ' + best.mapName +
                '（' + best.mode + '，' + best.winRate + '%）低 ' + r2(best.winRate - worst.winRate) + ' 个百分点。'
        });
      }
    }

    var rs = ratingStats(ratingSeries(store, rows));
    if (rs) {
      out.push({
        level: rs.avg >= 60 ? 'good' : (rs.avg < 45 ? 'warn' : 'info'),
        title: '平均评分 ' + rs.avg + '（中位数 ' + rs.median + '）',
        text: '评分区间 ' + rs.min + ' ~ ' + rs.max + '。' +
              (rs.lobbyBasis ? rs.lobbyBasis + ' 场有全场名单，评分基于同局 ' +
                '46~52 人的真实排名计算。' : '暂无全场名单，评分基于固定基准估算。')
      });
    }

    var w = windowStats(rows);
    if (w.last10 && w.last10.n >= 5) {
      var delta = r2(w.last10.winRate - s.winRate);
      if (delta <= -10) {
        out.push({ level: 'warn', title: '近期状态下滑',
          text: '近 10 局胜率 ' + w.last10.winRate + '%，比整体 ' + s.winRate + '% 低 ' +
                r2(-delta) + ' 个百分点。' });
      } else if (delta >= 10) {
        out.push({ level: 'good', title: '近期状态上升',
          text: '近 10 局胜率 ' + w.last10.winRate + '%，比整体高 ' + delta + ' 个百分点。' });
      }
    }

    if (s.leaveRate > 12) {
      out.push({ level: 'warn', title: '中途退出率 ' + s.leaveRate + '%',
        text: '共 ' + rows.filter(function (m) { return m.is_leave; }).length +
              ' 场中途退出，会拉低胜率与评分表现。' });
    }

    var rm = rescueMetrics(store, rows);
    if (rm && rm.teamShare !== null) {
      out.push({
        level: rm.teamShare >= 25 ? 'good' : 'info',
        title: '救治占全队 ' + rm.teamShare + '%',
        text: '场均救治 ' + rm.avg + '，分均 ' + rm.perMin + '，救治/阵亡比 ' + rm.rescueDeathRatio + '。' +
              (rm.teamShare >= 25 ? '支援贡献在队内属于核心级别。' : '')
      });
    }

    var km = killMetrics(rows);
    if (km) {
      out.push({
        level: 'info', title: '场均击杀 ' + km.avg + '（最高 ' + km.max + '）',
        text: '分均击杀 ' + km.perMin + '，单局 20+ 击杀占 ' +
              r2(km.buckets.filter(function (b) { return b.min >= 20; })
                .reduce(function (a, b) { return a + b.pct; }, 0)) + '%。'
      });
    }

    var cm = commanderStats(store, allRows);
    if (cm.available) {
      var vs = cm.vsNormal;
      out.push({
        level: cm.winRate >= 50 ? 'good' : 'warn',
        title: '指挥官对局胜率 ' + cm.winRate + '%（' + cm.total + ' 场）',
        text: 'KD ' + cm.kd + '，场均得分 ' + cm.avgScore + '，平均评分 ' + cm.rating + '。' +
          (vs ? '与你的普通对局相比：胜率 ' + (vs.winRate >= 0 ? '+' : '') + vs.winRate +
            ' 个百分点，场均得分 ' + (vs.avgScore >= 0 ? '+' : '') + vs.avgScore + '。' : '')
      });
    } else {
      out.push({
        level: 'info', title: '暂无指挥官对局',
        text: '到「单场详情」里把当你指挥官的那场点上「标记为指挥官」，这里就会单独统计。'
      });
    }

    return out;
  }

  /* ============================================================
   * v1.4.0：漏采自证 / 状态节律 / 关注池
   * ============================================================ */

  /* 相邻记录之间的时间空档。★ 只陈述「这段时间本机没有记录」，
   * 绝不写「你打过游戏」—— 空档同样可能只是没玩，而我们无法区分。
   * 必须喂全量存储场次（含已排除的），否则全局时间筛选会自己造出一堆假空档。 */
  var GAP_DAYS = 3;
  function syncGaps(rows, opts) {
    var need = Number(opts && opts.gapDays) > 0 ? Number(opts.gapDays) : GAP_DAYS;
    var asc = (rows || []).slice().sort(function (a, b) { return a.start_time - b.start_time; });
    var out = [];
    for (var i = 1; i < asc.length; i++) {
      var a = Number(asc[i - 1].start_time) || 0, b = Number(asc[i].start_time) || 0;
      if (!a || !b || b <= a) continue;
      var days = (b - a) / 86400;
      if (days >= need) out.push({ from: a, to: b, days: r1(days) });
    }
    return out;
  }

  /* 强信号：本轮窗口最老一场比上一轮窗口最新一场还新 ⇒ 整窗已经滚过一圈，
   * 而 [prev.newest, cur.oldest] 之间的场次我们从未见到过。
   * 只要没打满一窗，本轮窗口必然还含着上一轮的场次，判据自然为假 —— 这比
   * 「本轮新增数逼近整窗」那种比率启发式可靠，且区间能直接摊给用户看。
   * 只有一轮时没有可比对象：只记录，不判定。 */
  function windowDoubt(windows) {
    var asc = (windows || []).slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    var last = asc.length ? asc[asc.length - 1] : null;
    var out = { suspect: false, firstRound: asc.length < 2, rounds: asc.length,
      from: 0, to: 0, days: 0, last: last };
    if (asc.length < 2) return out;
    var prev = asc[asc.length - 2];
    var pn = Number(prev.newest) || 0, co = Number(last.oldest) || 0;
    if (pn > 0 && co > pn) {
      out.suspect = true; out.from = pn; out.to = co;
      out.days = Math.max(1, Math.round((co - pn) / 86400));
    }
    return out;
  }

  /* 一组场次的平均评分（与 byMap / groupBy 里同一套加权口径） */
  function avgRating(store, rows, openid) {
    if (!rows || !rows.length) return null;
    return r1(sum(rows, function (m) {
      return rating(m, store.players(m.room_id), openid, store).value;
    }) / rows.length);
  }

  /* 分时段。★ 与 byDay / periodCompare 同用 dt_event_time（官方本地时区裸串）：
   * 改用 start_time 经 new Date() 换算会按本机时区偏一格，「7 点那一格」就和每日场次对不上了。 */
  function byHour(store, rows) {
    return groupBy(store, rows || [], function (m) {
      return (m.dt_event_time || '').slice(11, 13);
    }, function (k) {
      return { label: (/^\d\d$/.test(k) ? k : '--') + ':00' };
    }).filter(function (x) { return /^\d\d$/.test(String(x.key)); })
      .sort(function (a, b) { return a.key < b.key ? -1 : 1; });
  }

  /* 连战切段：官方没给结束时间，只能用「上一场 start_time + game_time」推一场大约什么时候打完，
   * 歇过 gapMin 分钟就算另一轮。误差在分钟级，够分轮次，不够当精确计时。 */
  var SESSION_GAP_MIN = 30;
  function sessionSegments(store, rows, opts) {
    var gapMin = Number(opts && opts.gapMin) > 0 ? Number(opts.gapMin) : SESSION_GAP_MIN;
    var openid = store.activeOpenid();
    var asc = (rows || []).slice().sort(function (a, b) { return a.start_time - b.start_time; });
    var runs = [], cur = [];
    asc.forEach(function (m) {
      if (cur.length) {
        var p = cur[cur.length - 1];
        var ended = (Number(p.start_time) || 0) + (Number(p.game_time) || 0);
        if ((Number(m.start_time) || 0) - ended > gapMin * 60) { runs.push(cur); cur = []; }
      }
      cur.push(m);
    });
    if (cur.length) runs.push(cur);

    /* 段内第 N 场的表现：把每一轮的第 N 场归到同一桶 */
    var buckets = [];
    runs.forEach(function (r) {
      r.forEach(function (m, i) { (buckets[i] || (buckets[i] = [])).push(m); });
    });
    var byIndex = buckets.map(function (list, i) {
      var s = summarize(list);
      s.index = i + 1;
      s.rating = avgRating(store, list, openid);
      return s;
    });

    var dist = [], longest = 0, total = 0;
    runs.forEach(function (r) {
      total += r.length;
      if (r.length > longest) longest = r.length;
    });
    for (var n = 1; n <= Math.max(longest, 1); n++) {
      var c = runs.filter(function (r) { return r.length === n; }).length;
      if (c) dist.push({ n: n, count: c });
    }
    return {
      gapMin: gapMin,
      byIndex: byIndex,
      lengthDist: dist,
      stats: { runs: runs.length, matches: total,
        avgRunLen: runs.length ? r1(total / runs.length) : 0, longestRun: longest }
    };
  }

  /* 关注池对比。★ 分边随机、同阵营率基线约 50%（手册 §6.3），所以两侧样本都不到
   * PEOPLE_MIN_SAMPLE 场时 verdict 给 null，界面只列数字不下结论，绝不写「和谁组队更容易赢」。 */
  var PEOPLE_MIN_SAMPLE = 20;
  function peopleStats(store, rows, groups) {
    var p = store.state.people || {};
    var keys = Object.keys(p);
    var out = { list: keys.map(function (k) { return p[k]; }).sort(function (a, b) { return (b.since || 0) - (a.since || 0); }),
      count: keys.length, withTotal: 0, withoutTotal: 0,
      withPool: null, withoutPool: null, verdict: null, minSample: PEOPLE_MIN_SAMPLE };
    if (!keys.length) return out;

    /* 用身份索引把「哪些场次里出现过被关注的人」摊平 —— 与榜单同一套聚合键，不另发明一套 */
    var g = groups || buildIdentityIndex(store).groups;
    var roomHit = {};
    keys.forEach(function (k) {
      var grp = g[k];
      if (!grp) return;
      (grp.meets || []).forEach(function (x) { roomHit[String(x.roomId)] = 1; });
    });
    var wRows = [], nRows = [];
    (rows || []).forEach(function (m) { (roomHit[String(m.room_id)] ? wRows : nRows).push(m); });
    out.withTotal = wRows.length;
    out.withoutTotal = nRows.length;
    var openid = store.activeOpenid();
    if (wRows.length) {
      var s1 = summarize(wRows); s1.rating = avgRating(store, wRows, openid); out.withPool = s1;
    }
    if (nRows.length) {
      var s2 = summarize(nRows); s2.rating = avgRating(store, nRows, openid); out.withoutPool = s2;
    }
    if (wRows.length >= PEOPLE_MIN_SAMPLE && nRows.length >= PEOPLE_MIN_SAMPLE) {
      out.verdict = {
        dWinRate: r1(out.withPool.winRate - out.withoutPool.winRate),
        dRating: r1((out.withPool.rating || 0) - (out.withoutPool.rating || 0))
      };
    }
    return out;
  }

  /* ★ 返回值里带上聚合键 key：详情页要把它原样传回 setWatch，
   *   绝不让界面自己拼一个 'id:'/'nm:' —— 那正是手册 §6.1 的老坑。
   * 注意这里不能因为「还没关注任何人」就早退：那样第一个关注按钮永远出不来。
   * 一次详情页 = 一次身份索引扫描，与 report() 本就要做的同一件事同量级。 */
  function watchIndex(store, roomId, idx) {
    var p = store.state.people || {};
    var out = { byVid: {}, count: 0 };
    var rid = String(roomId);
    var g = idx || buildIdentityIndex(store);
    Object.keys(g.groups).forEach(function (k) {
      var grp = g.groups[k];
      var watched = !!p[k];
      (grp.meets || []).forEach(function (x) {
        if (String(x.roomId) !== rid || !x.p || !x.p.vopenid) return;
        var vid = String(x.p.vopenid);
        if (!out.byVid[vid]) out.byVid[vid] = { key: k, confidence: grp.confidence, watched: false };
        if (watched) { out.byVid[vid].watched = true; out.byVid[vid].key = k; out.byVid[vid].confidence = grp.confidence; }
      });
    });
    out.count = Object.keys(out.byVid).filter(function (v) { return out.byVid[v].watched; }).length;
    return out;
  }

  /* roomId -> 该场里被关注的人数，供战局列表徽标与「含关注玩家」筛选使用 */
  function watchedRoomMap(store) {
    var p = store.state.people || {};
    if (!Object.keys(p).length) return {};
    var g = buildIdentityIndex(store), map = {};
    Object.keys(p).forEach(function (k) {
      var grp = g.groups[k];
      if (!grp) return;
      (grp.meets || []).forEach(function (x) {
        var rid = String(x.roomId);
        map[rid] = (map[rid] || 0) + 1;
      });
    });
    return map;
  }

  /* ============================================================
   * 六项深度分析（v1.8.0）
   *   ① winLossCompare   你赢的那场 vs 你输的那场
   *   ③ durationProfile  时长与连战节奏
   *   ⑤ strengthProfile  对手强度校准（SOS）
   *   ⑥ baselineFor      相对你自己的基线
   *   ⑧ scoreStructure   得分结构反推 vs 你手设的权重
   * ★ 共同纪律（与 peopleStats 同一条）：官方只回最近约 36 场，落到任何一个分组常常只剩 3~8 场。
   *   区间与可靠性一律取 core/stats.js 那一份口径；不够就 available:false + 一句原因，
   *   界面只许列数字，不许写「你该怎样」。
   * ============================================================ */
  var WL_ITEMS = [
    { key: 'kill', label: '场均击杀' },
    { key: 'death', label: '场均死亡' },
    { key: 'assist', label: '场均助攻' },
    { key: 'occupy', label: '场均占点（次）' },
    { key: 'rescue', label: '场均救治' },
    { key: 'score', label: '场均得分' },
    { key: 'score_per_min', label: '分均得分' },
    { key: 'kill_per_min', label: 'KPM（每分钟击杀）' },
    { key: 'kd', label: 'KD' },
    { key: 'minutes', label: '单场时长(分)' }
  ];
  /* 每场都要现算的派生项（存的是原始字段，口径只在这里定义一次） */
  function matchMetric(m, key) {
    var kill = m.kill || 0, death = m.death || 0, assist = m.assist || 0;
    if (key === 'kd') return death ? kill / death : kill;
    if (key === 'kda') return death ? (kill + assist) / death : (kill + assist);
    if (key === 'minutes') return (m.game_time || 0) / 60;
    if (key === 'kill_per_min') return m.kill_per_min != null ? m.kill_per_min
      : (m.game_time ? kill / (m.game_time / 60) : 0);
    if (key === 'score_per_min') return m.score_per_min != null ? m.score_per_min
      : (m.game_time ? m.score / (m.game_time / 60) : 0);
    return m[key] || 0;
  }

  function winLossCompare(rows) {
    var win = [], lose = [];
    (rows || []).forEach(function (m) { (m.is_winner ? win : lose).push(m); });
    if (win.length < Stats.CI_MIN_N || lose.length < Stats.CI_MIN_N) {
      return { available: false, wins: win.length, losses: lose.length,
        reason: '赢或输的场数不足 ' + Stats.CI_MIN_N + ' 场，这个对照给不出方向。' };
    }
    var items = [];
    WL_ITEMS.forEach(function (it) {
      var a = win.map(function (m) { return matchMetric(m, it.key); });
      var b = lose.map(function (m) { return matchMetric(m, it.key); });
      var d = Stats.diffInterval(a, b);
      if (!d) return;
      var pooled = Stats.sd(a.concat(b));
      d.key = it.key; d.label = it.label;
      /* 标准化差值：把"差多少"放进"你自己的波动有多大"里看。
       * 单看 3 个击杀的差会被读成大事，可你的单场波动本来就是 ±12。 */
      d.effect = pooled ? r2(d.diff / pooled) : null;
      d.clear = !d.crossesZero;
      /* 效应量档位也在这里定：界面只照抄措辞，不许自己划"多大算大" */
      d.mag = d.effect == null ? null
        : Math.abs(d.effect) >= 0.8 ? '大'
        : Math.abs(d.effect) >= 0.5 ? '中'
        : Math.abs(d.effect) >= 0.2 ? '小' : '微';
      items.push(d);
    });
    items.sort(function (x, y) { return Math.abs(y.effect || 0) - Math.abs(x.effect || 0); });
    var clearItems = items.filter(function (x) { return x.clear; });
    return {
      available: true, wins: win.length, losses: lose.length,
      winRate: r1(win.length / (win.length + lose.length) * 100),
      ci: Stats.wilson(win.length, win.length + lose.length),
      items: items,
      clear: clearItems,
      unclear: items.filter(function (x) { return !x.clear; }),
      /* ★ 结论文案只在这里写一份。一项都不跨 0 是常态（±15 个百分点的区间就是这么宽），
       *   这种情况下最诚实的读法恰恰是"输赢和你的个人数据关系不大"，而不是硬挑一个短板。 */
      headline: clearItems.length
        ? '有 ' + clearItems.length + ' 项的差没跨过 0：' +
          clearItems.map(function (x) {
            return x.label + '（赢场 ' + x.a + ' vs 输场 ' + x.b + '，差 ' + x.diff + '，' + x.mag + '）';
          }).join('；') + '。其余 ' + (items.length - clearItems.length) + ' 项说不出方向。'
        : '这 ' + items.length + ' 项的差全部跨 0 —— 赢的 ' + win.length + ' 场和输的 ' +
          lose.length + ' 场里，你的个人数据基本重叠。',
      minSide: Stats.CI_MIN_N
    };
  }

  var DUR_BUCKETS = [
    { label: '10 分钟以内', lo: 0, hi: 600 },
    { label: '10~15 分钟', lo: 600, hi: 900 },
    { label: '15~20 分钟', lo: 900, hi: 1200 },
    { label: '20~30 分钟', lo: 1200, hi: 1800 },
    { label: '30 分钟以上', lo: 1800, hi: Infinity }
  ];
  function durationProfile(rows) {
    var list = (rows || []).filter(function (m) { return (m.game_time || 0) > 0; });
    var buckets = DUR_BUCKETS.map(function (b) {
      var g = list.filter(function (m) { return m.game_time >= b.lo && m.game_time < b.hi; });
      var w = g.filter(function (m) { return m.is_winner; }).length;
      var ci = Stats.wilson(w, g.length);
      return {
        label: b.label, n: g.length, wins: w,
        winRate: g.length ? r1(w / g.length * 100) : null,
        ci: ci, reliability: Stats.reliability(g.length, ci),
        avgScore: g.length ? Math.round(Stats.mean(g.map(function (m) { return m.score || 0; }))) : null,
        avgMinutes: g.length ? r1(Stats.mean(g.map(function (m) { return m.game_time / 60; }))) : null
      };
    });
    var used = buckets.filter(function (b) { return b.n >= Stats.CI_MIN_N && b.winRate !== null; });
    /* 方向只从"够场数的两端"读，而且两端区间必须互相错开才敢说 —— 每档 3~6 场配一条趋势线就是骗人 */
    var trend = null;
    if (used.length >= 2) {
      var a0 = used[0], a1 = used[used.length - 1];
      trend = {
        from: a0.label, to: a1.label, fromRate: a0.winRate, toRate: a1.winRate,
        diff: r1(a1.winRate - a0.winRate),
        believable: !!(a0.ci && a1.ci && (a0.ci.hi < a1.ci.lo || a0.ci.lo > a1.ci.hi))
      };
    }
    return {
      total: list.length, buckets: buckets, trend: trend,
      headline: !trend ? '够场数的时长档不足两端，先看趋势无从谈起。'
        : trend.believable
          ? '时长和胜负' + (trend.diff > 0 ? '同向' : '反向') + '：' + trend.from +
            ' 赢 ' + trend.fromRate + '%，' + trend.to + ' 赢 ' + trend.toRate +
            '%，两端区间互不重叠（差 ' + trend.diff + ' 个百分点）。'
          : trend.from + ' 与 ' + trend.to + ' 的胜率差 ' + trend.diff +
            ' 个百分点，但两端区间重叠 —— 每档只剩几场，这条曲线的形状现在还说明不了什么。',
      minBucket: Stats.CI_MIN_N
    };
  }

  var SOS_MIN_GAMES = 9;      // 分三箱，每箱至少 3 场才谈得上对照
  function strengthProfile(store, rows) {
    var openid = String(store.activeOpenid() || '');
    var games = [];
    (rows || []).forEach(function (m) {
      var players = store.players(m.room_id) || [];
      if (players.length < 5) return;
      var me = null;
      players.forEach(function (p) { if (String(p.vopenid) === openid) me = p; });
      if (!me) return;
      var mates = players.filter(function (p) { return p !== me && p.color === me.color; });
      var foes = players.filter(function (p) { return p.color !== me.color; });
      if (!mates.length || !foes.length) return;
      var myScore = me.score || 0;
      var mateAvg = Stats.mean(mates.map(function (p) { return p.score || 0; })) || 0;
      var foeAvg = Stats.mean(foes.map(function (p) { return p.score || 0; })) || 0;
      games.push({
        room_id: m.room_id, win: !!m.is_winner, myScore: myScore,
        start_time: Number(m.start_time) || 0,
        /* 我方平均含我自己：这才是"两边池子谁更深"，不是"队友带不带得动我" */
        teamAvg: (mateAvg * mates.length + myScore) / (mates.length + 1),
        foeAvg: foeAvg, mates: mates.length, foes: foes.length
      });
    });
    games.forEach(function (g) { g.gap = r1(g.teamAvg - g.foeAvg); });
    if (games.length < SOS_MIN_GAMES) {
      return { available: false, games: games.length,
        reason: '带全场名单的场次不足 ' + SOS_MIN_GAMES + ' 场（现在 ' + games.length + ' 场），' +
          '强度对照每箱只剩两三场，给不出结论。开启「同步时抓取全场名单」并多同步几次就会够。' };
    }
    /* 按实测差值切三分位，而不是写死"多少分算强敌" —— 官方分数尺度会随版本漂 */
    var asc = games.slice().sort(function (a, b) { return a.gap - b.gap; });
    var cut = function (i) { return asc[Math.floor(i * asc.length / 3)] ? asc[Math.floor(i * asc.length / 3)].gap : 0; };
    var bins = [
      { label: '我方池子更弱', hi: cut(1) },
      { label: '两边相当', lo: cut(1), hi: cut(2) },
      { label: '我方池子更强', lo: cut(2) }
    ].map(function (b) {
      var g = games.filter(function (x) {
        return (b.lo === undefined || x.gap >= b.lo) && (b.hi === undefined || x.gap < b.hi);
      });
      var w = g.filter(function (x) { return x.win; }).length;
      var ci = Stats.wilson(w, g.length);
      return {
        label: b.label, n: g.length, wins: w,
        winRate: g.length ? r1(w / g.length * 100) : null,
        avgGap: g.length ? Math.round(Stats.mean(g.map(function (x) { return x.gap; }))) : null,
        ci: ci, reliability: Stats.reliability(g.length, ci)
      };
    });
    var filled = bins.filter(function (b) { return b.n >= Stats.CI_MIN_N && b.winRate !== null; });
    var actual = r1(games.filter(function (g) { return g.win; }).length / games.length * 100);
    var ciAll = Stats.wilson(games.filter(function (g) { return g.win; }).length, games.length);
    /* 档与档之间的差才是「强度校准」的正文。以前这里算的是「按各箱场数加权的各箱胜率」，
     * 那个数恒等于总胜率，超额永远是 0 —— 是同义反复，不是校准，删掉。 */
    var power = null;
    if (filled.length >= 2) {
      var lo = filled[0], hi = filled[filled.length - 1];
      power = {
        from: lo.label, to: hi.label, fromRate: lo.winRate, toRate: hi.winRate,
        diff: r1(hi.winRate - lo.winRate),
        believable: !!(lo.ci && hi.ci && (lo.ci.hi < hi.ci.lo || lo.ci.lo > hi.ci.hi))
      };
    }
    var out = {
      available: true, games: games.length, bins: bins,
      cuts: { c1: cut(1), c2: cut(2) },
      actual: actual, ci: ciAll, power: power,
      underdog: (function () {
        var g = games.filter(function (x) { return x.gap < 0; });
        var w = g.filter(function (x) { return x.win; }).length;
        var ci = Stats.wilson(w, g.length);
        return { n: g.length, wins: w, winRate: g.length ? r1(w / g.length * 100) : null,
          ci: ci, reliability: Stats.reliability(g.length, ci) };
      })(),
      /* 时间对半切：看的是「匹配最近给我的局是变好打还是变难打」，以及这一项和我的胜率
       * 变化能不能对上。早/近各一半，每半 15 场上下，所以只有区间不跨 0 才敢说方向。 */
      drift: (function () {
        if (games.length < 8) return null;
        var ordered = games.slice().sort(function (a, b) { return a.start_time - b.start_time; });
        var half = Math.floor(ordered.length / 2);
        var early = ordered.slice(0, half), late = ordered.slice(half);
        if (!early.length || !late.length) return null;
        function side(list) {
          var w = list.filter(function (x) { return x.win; }).length;
          var ci = Stats.wilson(w, list.length);
          return { n: list.length, wins: w,
            winRate: r1(w / list.length * 100), ci: ci, reliability: Stats.reliability(list.length, ci),
            avgGap: Math.round(Stats.mean(list.map(function (x) { return x.gap; })) || 0) };
        }
        var e = side(early), l = side(late);
        var gapDiff = Stats.diffInterval(late.map(function (x) { return x.gap; }),
          early.map(function (x) { return x.gap; }));
        return {
          early: e, late: l,
          gapDiff: gapDiff,
          gapClear: !!(gapDiff && !gapDiff.crossesZero),
          rateDiff: r1(l.winRate - e.winRate),
          gapSd: Math.round(Stats.sd(games.map(function (x) { return x.gap; })) || 0)
        };
      })(),
      /* 诚实声明：池子差里含我自己那一份，所以我打得越猛这个差越可能偏正。
       * 相关度大就得提醒「这一档不全是匹配发的牌，也有我自己在牌桌上」。 */
      ownPart: Stats.pearson(games.map(function (g) { return g.gap; }),
        games.map(function (g) { return g.myScore; })),
      ownPartCaveat: null,   // 下面按 |ownPart| 决定是否填
      headline: null
    };
    out.ownPartCaveat = out.ownPart !== null && Math.abs(out.ownPart) >= 0.4
      ? '注意：池子差和你自己的得分相关 ' + out.ownPart + '，这一档里有一部分是「你本人在牌桌上」，' +
        '不全是匹配发的牌。' : null;
    out.headline = power
      ? (power.believable
        ? '两边池子谁更深，几乎就定了输赢：' + power.from + ' 赢 ' + power.fromRate +
          '%，' + power.to + ' 赢 ' + power.toRate + '%，两端区间互不重叠（差 ' + power.diff +
          ' 个百分点）。你的胜率首先要按这个读，其次才轮到你自己的数据。'
        : '三档之间的胜率差 ' + power.diff + ' 个百分点，但两端区间重叠，' +
          '现在还分不开「池子深浅」和「运气」。')
      : '三档里至少两档的场数不够，先不下结论。';
    return out;
  }

  var BASE_ITEMS = [
    { key: 'score', label: '得分' }, { key: 'kill', label: '击杀' },
    { key: 'kda', label: 'KDA' }, { key: 'occupy', label: '占点（次）' },
    { key: 'rescue', label: '救治' }
  ];
  var BASE_MIN_SAME_MAP = 5;
  /* 相对你自己：同图够 5 场就先跟同图比，否则跟全部比。评分页那个百分位是"你在 52 人里排第几"，
   * 这里回答的是另一个问题 —— "这场比**你平时**好多少"，两者不许混用 */
  function baselineFor(store, m) {
    if (!m) return null;
    var all = (store.matches({}) || []).filter(function (x) { return (x.score || 0) > 0; });
    var sameMap = all.filter(function (x) { return x.map_id === m.map_id; });
    var pool = sameMap.length >= BASE_MIN_SAME_MAP ? sameMap : all;
    if (pool.length < Stats.CI_MIN_N) return null;
    var items = BASE_ITEMS.map(function (it) {
      var vals = pool.map(function (x) { return matchMetric(x, it.key); });
      var sorted = vals.slice().sort(function (a, b) { return a - b; });
      var mine = matchMetric(m, it.key);
      return {
        key: it.key, label: it.label, value: r2(mine),
        avg: r2(Stats.mean(vals)), pct: Stats.percentileOf(sorted, mine),
        z: Stats.zOf(vals, mine)
      };
    });
    var pcts = items.map(function (x) { return x.pct; }).filter(function (x) { return x !== null; });
    var overall = pcts.length ? r1(Stats.mean(pcts)) : null;
    return {
      basis: sameMap.length >= BASE_MIN_SAME_MAP ? 'map' : 'overall',
      mapName: Maps.nameOf(m.map_id), n: pool.length,
      /* 我自己也在池子里 —— 场数小的时候把自己算进去更保守（分位会被往中间拉），这里如实说明 */
      includesThisMatch: true,
      items: items, overallPct: overall,
      headline: overall === null
        ? '可比的场次太少，排不出分位。'
        : '这场在你自己的 ' + pool.length + ' 场里综合第 ' + overall + ' 分位（' +
          (overall < 10 ? '明显低于常态' : overall < 30 ? '低于常态' :
            overall <= 70 ? '和你的常态持平' : overall <= 90 ? '高于常态' : '明显高于常态') + '）。'
    };
  }

  /* 得分结构反推：特征刻意用与评分权重同名的四项（击杀 / KDA / 占点 / 救治），
   * 这样"数据说的"和"你在设置里手选的"是同一把尺子，能逐项相减 */
  var SS_ITEMS = [
    { key: 'kill', label: '击杀', weight: 'kill' },
    { key: 'kda', label: 'KDA', weight: 'kda' },
    { key: 'occupy', label: '占点（次）', weight: 'occupy' },
    { key: 'rescue', label: '救治', weight: 'rescue' }
  ];
  /* 数据占比和你设的占比差多少个百分点才算"对不上"。放在这里，措辞和门槛才不会各改一处 */
  var SS_GAP_PP = 10;
  function scoreStructure(store, rows) {
    var list = (rows || []).filter(function (m) { return (m.score || 0) > 0; });
    var b = Stats.betas(list.map(function (m) { return m.score; }),
      SS_ITEMS.map(function (it) { return list.map(function (m) { return matchMetric(m, it.key); }); }));
    var W = weights(store);
    var wTotal = sum(SS_ITEMS, function (it) { return W[it.weight] || 0; }) || 1;
    if (!b) {
      return { available: false, n: list.length, reason: '场数不够（要 ' +
        (SS_ITEMS.length * 5) + ' 场起）或某一项你每场都一样，反推不出结构。',
        userShares: SS_ITEMS.map(function (it) {
          return { key: it.key, label: it.label, userShare: r1((W[it.weight] || 0) / wTotal * 100) };
        }) };
    }
    var raw = SS_ITEMS.map(function (it, i) {
      var beta = b.values[i], r = b.corrWithTarget[i];
      return { key: it.key, label: it.label, beta: beta, r: r,
        /* 只取偏回归系数：它是"其它三项都一样时，这一项每高一个标准差总分动多少个标准差"。
         * 再乘一次零阶相关就成了两种尺子相乘，谁也解释不了那个数是什么。负数按 0 计，
         * 但 beta 与 r 都要原样显示，负号是结论的一部分。 */
        contribution: Math.max(0, beta),
        userShare: r1((W[it.weight] || 0) / wTotal * 100) };
    });
    var cTotal = sum(raw, function (x) { return x.contribution; }) || 1;
    raw.forEach(function (x) {
      x.share = r1(x.contribution / cTotal * 100);
      x.gap = r1(x.share - x.userShare);
    });
    var byGap = raw.slice().sort(function (x, y) { return Math.abs(y.gap) - Math.abs(x.gap); });
    var worst = byGap[0];
    var topData = raw.slice().sort(function (x, y) { return y.share - x.share; })[0];
    var topUser = raw.slice().sort(function (x, y) { return y.userShare - x.userShare; })[0];
    var aligned = Math.abs(worst.gap) < SS_GAP_PP;
    var h = '数据里大头是' + topData.label + '（' + topData.share + '%），你给的最高权重是' +
      topUser.label + '（' + topUser.userShare + '%）。';
    h += aligned
      ? '四项的最大偏差不到 ' + SS_GAP_PP + ' 个百分点，你设的权重和你实际得分的来源基本对得上。'
      : '差得最远的是' + worst.label + '：数据占 ' + worst.share + '%，你设了 ' + worst.userShare +
        '%（' + (worst.gap > 0 ? '数据里更重要，你给低了' : '你给高了') + ' ' +
        Math.abs(worst.gap) + ' 个百分点）。';
    return {
      available: true, n: b.n, items: raw,
      headline: h, aligned: aligned, minGap: SS_GAP_PP,
      /* 得分是官方合成的，击杀/占点/救治本身都在往里灌分，彼此高度共线 ——
       * 所以这里说的是"哪一项和你的总分同向变动最强"，不是"打这个就加分"。
       * 这句话必须跟着数据走，否则用户会把它读成因果。 */
      note: '这是共线性很强的对照，不是因果：官方得分本身就把击杀、占点、救治折算进去了。',
      /* 你手设的五项里「得分」正是回归要解释的那个量，留着它会把四项挤扁，
       * 所以右侧口径是"在可比的四项里重新归一"。界面不许把它当成你原来的百分比。 */
      basis: '你设的百分比只在那四项可比的项里重新归一（不含「得分」项，它正是被解释的那个量）。'
    };
  }

  /* ============================================================
   * 官方赛季汇总（GetBattleReport + GetMapStats 的本机存档）
   * ★ 界面早在 v1.0 就画了 renderSeason(sea)，读 allMode / career / swwr 三档，
   *   可 core 里一份都没算过 —— rep.season 从来不存在，那个面板在每个人机器上
   *   都只显示「暂未取到官方赛季汇总」。字段全部取自官方真回包，没有一列是猜的：
   *     season.mp     本赛季口径（total_fight / win_ratio / total_score / avg_score_per_minute …）
   *     season.stats  账号累计口径（tdmTotalFight / tdmSuccessRatio / tdmKdRatio …）
   *     maps[]        官方分地图统计 —— 官方没有单独给"胜者为王本赛季"这一档，
   *                   所以它由胜者为王那几张图的行精确聚合出来（判据仍走 Maps.isSWWR 一颗）。
   *   sid 取官方回包里那一份（我们问几号它就回几号），界面因此能如实说"这一格念的是第 N 赛季"。
   * ============================================================ */
  function seasonSummary(store) {
    var seasons = (store.state && store.state.seasons) || {};
    var keys = Object.keys(seasons);
    if (!keys.length) return null;
    /* 多赛季存档取最新一次抓到数据的那份；只按 at 比，不比键名字典序（'9' > '10' 会挑错） */
    var best = null;
    keys.forEach(function (k) {
      var v = seasons[k] || {};
      if (!best || (Number(v.at) || 0) > (Number(best.at) || 0)) best = v;
    });
    var sea = (best.report && best.report.season) || {};
    var mp = sea.mp || {}, st = sea.stats || {};
    if (!Number(mp.total_fight) && !Number(st.tdmTotalFight)) return null;   // 空回包不装作有数据

    var rows = ((best.maps && best.maps.maps) || []).filter(function (m) {
      return m && Maps.isSWWR(m.mapid) && Number(m.total) > 0;
    });
    var sw = null;
    if (rows.length) {
      var total = sum(rows, function (m) { return Number(m.total) || 0; });
      var win = sum(rows, function (m) { return Number(m.win) || 0; });
      var kill = sum(rows, function (m) { return Number(m.kill) || 0; });
      var death = sum(rows, function (m) { return Number(m.death) || 0; });
      var score = sum(rows, function (m) { return Number(m.score) || 0; });
      var gt = sum(rows, function (m) { return Number(m.gametime) || 0; });
      sw = {
        total: total, win: win, kill: kill, death: death, score: score, gametime: gt,
        winRate: total ? r2((win / total) * 100) : 0,
        kd: death ? r2(kill / death) : kill,
        avgScore: total ? Math.round(score / total) : 0,
        scorePerMin: gt ? Math.round(score / (gt / 60)) : 0,
        maps: rows.map(function (m) {
          var t = Number(m.total) || 0, w = Number(m.win) || 0;
          var k = Number(m.kill) || 0, d = Number(m.death) || 0;
          var sc = Number(m.score) || 0;
          return {
            mapId: Number(m.mapid), mapName: Maps.nameOf(m.mapid),
            total: t, win: w, winRate: t ? r2((w / t) * 100) : 0,
            kill: k, death: d, assist: Number(m.assist) || 0, score: sc,
            kd: d ? r2(k / d) : k, avgScore: t ? Math.round(sc / t) : 0,
            gametime: Number(m.gametime) || 0
          };
        }).sort(function (a, b) { return b.total - a.total; })
      };
    }

    return {
      sid: String(sea.sid || ''),
      at: Number(best.at) || 0,
      allMode: {
        totalFight: Number(mp.total_fight) || 0, win: Number(mp.total_win) || 0,
        winRate: r2(Number(mp.win_ratio) || 0),
        totalKill: Number(mp.total_kill) || 0, totalScore: Number(mp.total_score) || 0,
        scorePerMin: Number(mp.avg_score_per_minute) || 0,
        killPerMin: Number(mp.avg_kill_per_minute) || 0,
        hitRatio: mp.hit_shoot_ratio, headRatio: mp.kill_head_ratio,
        rankLevel: mp.major_level, rankPoint: mp.level_score,
        battlePassLevel: mp.battle_pass_level, totalGameTime: Number(mp.total_game_time) || 0
      },
      career: {
        totalFight: Number(st.tdmTotalFight) || 0,
        winRate: r2((Number(st.tdmSuccessRatio) || 0) * 100),
        totalKill: Number(st.tdmTotalKill) || 0,
        kd: st.tdmKdRatio, mvp: Number(st.tdmTotalMVP) || 0,
        duration: Number(st.tdmDuration) || 0,
        rankPoint: st.tdmRankpoint, rankLevel: st.tdmRanklevel
      },
      swwr: sw
    };
  }

  /* ============================================================
   * 总报告
   * ============================================================ */
  function report(store, filters) {
    var f = applyFilters(store, filters);
    var rows = f.rows;
    var allRows = store.matches({});
    var openid = store.activeOpenid();
    var stats = store.stats();
    var rs = ratingSeries(store, rows);
    /* 身份索引一次建好，榜单与关注池共用；空档看的是「全部存储场次」而不是筛选后的池子，
     * 否则「近 7 天」这类筛选会自己造出一堆假空档 */
    var idIdx = buildIdentityIndex(store);
    /* ★ 「对手与队友」那一页用的是**按筛选条件建的第二份**索引（#87：模式筛选在这页以前不生效）。
     *    原来那份保持全库口径不动 —— 一份索引两处口径不一样，硬合成一份就会把空档那几句带歪。 */
    var encIdx = buildIdentityIndex(store, filters);
    var storedAll = store.matches({ includeExcluded: true });
    var wins = store.syncWindows();
    var rhythm = sessionSegments(store, rows);

    return {
      openid: openid,
      name: store.state.meta.name,
      lastSync: store.state.meta.last_sync,
      filters: filters || { mode: 'all', kind: 'all', leave: 'all' },
      filterModeLabel: (function () {
        var m = (filters && filters.mode) || 'all';
        return m === 'swtwr' ? '胜者为王' :
          (m === 'commander' ? '指挥官' :
            (m === 'other' ? '攻防 / 占领' : '全部模式'));
      })(),
      /* 「对局类型」是人工那一枚，与模式正交，所以单独一句、不与上面那枚混写。
       * 措辞老实：这是用户自己标的，软件没有识别能力（官方字段里没有这个信息）。 */
      filterKindLabel: (function () {
        var k = (filters && filters.kind) || 'all';
        return k === 'comp' ? '比赛对局（你手动标的）' :
          (k === 'practice' ? '匹配对局（没标为比赛的）' : '全部对局');
      })(),
      counts: store.modeCounts(),
      stored: store.storedCounts(),
      rosters: stats.rosters,
      players: stats.players,
      filtered: {
        total: rows.length,
        poolSize: f.poolSize,
        afterMode: f.afterMode,
        afterKind: f.afterKind,
        afterLeave: f.afterLeave
      },
      summary: (function () {
        var s = summarize(rows);
        /* ★ 胜率一律带区间：3~8 场的分组太多，没有区间的胜率会被当成结论读 */
        if (s) { s.winRateCi = Stats.wilson(s.win, s.total); s.reliability = Stats.reliability(s.total, s.winRateCi); }
        return s;
      })(),
      windows: windowStats(rows),
      ratingSeries: rs,
      ratingStats: ratingStats(rs),
      maps: byMap(store, rows),
      classes: byClass(store, rows),
      agents: byAgent(store, rows),
      commander: commanderStats(store, allRows),
      rescue: rescueMetrics(store, rows),
      kills: killMetrics(rows),
      series: series(rows),
      days: byDay(rows),
      streak: streak(rows),
      insights: insights(store, rows, allRows),
      matrix: mapAgentMatrix(store, rows),
      periods: periodCompare(store, rows),
      hours: byHour(store, rows),
      rhythm: rhythm,
      winLoss: winLossCompare(rows),
      durations: durationProfile(rows),
      strength: strengthProfile(store, rows),
      structure: scoreStructure(store, rows),
      sync: { windows: wins, doubt: windowDoubt(wins), gaps: syncGaps(storedAll) },
      people: peopleStats(store, rows, idIdx.groups),
      /* 攻防胜率对照（判据 = sideOf 那一颗）；界面只念 headline 与两个桶 */
      sides: sideSplit(rows),
      /* 每张地图自己的攻守对照（他要的是逐张图看，不是只看总体那一张） */
      mapSides: sideByMap(byMap(store, rows)),
      encounters: (function () {
        var e = encounters(store, encIdx);
        // 只回传榜单，避免每次都传全量
        return {
          scanned: e.scanned, totalPlayers: e.totalPlayers,
          playedPlayers: e.playedPlayers, note: e.note, minMeets: e.minMeets,
          repeatPlayers: e.repeatPlayers,
          hiddenSlotPlayers: e.hiddenSlotPlayers, anonymousPlayers: e.anonymousPlayers,
          frequent: e.frequent.slice(0, 20),
          repeats: e.repeats.slice(0, 30),
          recent: e.recent.slice(0, 30),
          topTeammates: e.topTeammates.slice(0, 20),
          topOpponents: e.topOpponents.slice(0, 20),
          bestMates: e.bestMates, toughest: e.toughest
        };
      })(),
      settings: store.state.settings,
      /* 官方赛季汇总那一格：判据/聚合都在上面那一份，界面只排版 */
      season: seasonSummary(store),
      /* 渲染层不加载 core/*，权重的文字描述由这里算好，避免界面另写一份归一化规则 */
      ratingWeightsText: weightsText(weights(store))
    };
  }

  /* ============================================================
   * 单场小贴士（针对这一局的结论性提示）
   * ============================================================ */
  /* 双方强弱的分档线，量的是**相对差**（两边人均之差 ÷ 两边均值，%）：
   * 小于 SIDE_GAP_EVEN 才配叫"势均力敌"，到 SIDE_GAP_BLOWOUT 以上直说"一边倒"。
   * 以前这条写的是绝对分值差 3000 —— 人均分的尺度会随局的长短跨到 8 倍，
   * 真库 39 场里有 32 场（82%）因此被叫成"势均力敌"，包括对面人均高出 41% 的那种。
   * 10 / 30 是按这批样本定的：±10% 落到 11 场（28%），39 场的相对差中位数 21.8%。 */
  var SIDE_GAP_EVEN = 10;
  var SIDE_GAP_BLOWOUT = 30;

  function matchTips(store, roomId) {
    var cmp = lobbyCompare(store, roomId);
    if (!cmp || !cmp.match) return [];
    var m = cmp.match;
    var tips = [];
    var allRows = store.matches({ mode: m.is_swtwr ? 'swtwr' : 'all' });
    var base = summarize(allRows);
    var rs = ratingStats(ratingSeries(store, allRows));

    // 1. 单局评分定位
    if (cmp.rating && rs) {
      var v = cmp.rating.value;
      var diff = r1(v - rs.avg);
      tips.push({
        level: v >= 70 ? 'good' : (v < 45 ? 'warn' : 'info'),
        title: '本局评分 ' + v + (diff >= 0 ? '，高于' : '，低于') + '你的平均 ' + Math.abs(diff) + ' 分',
        text: '你的历史平均评分 ' + rs.avg + '（中位数 ' + rs.median + '）。' +
          (cmp.rating.basis === 'lobby'
            ? '本局基于同场 ' + cmp.rating.players + ' 人的真实排名计算。'
            : '本局因缺少全场名单，按固定基准估算。')
      });
    }

    if (cmp.roster >= 5 && cmp.ranks) {
      var rk = cmp.ranks;
      // 2. 最强项
      var best = [['得分', rk.score], ['击杀', rk.kill], ['KDA', rk.kda],
                  ['救治', rk.rescue], ['占点（次）', rk.occupy]]
        .filter(function (x) { return x[1].pct !== null; })
        .sort(function (a, b) { return b[1].pct - a[1].pct; })[0];
      if (best) {
        tips.push({
          level: 'good',
          title: '本局最强项：' + best[0] + '（全场第 ' + best[1].rank + '）',
          text: '超过全场 ' + best[1].pct + '% 的玩家。'
        });
      }
      // 3. 最弱项
      var worst = [['得分', rk.score], ['击杀', rk.kill], ['KDA', rk.kda],
                   ['救治', rk.rescue], ['占点（次）', rk.occupy]]
        .filter(function (x) { return x[1].pct !== null; })
        .sort(function (a, b) { return a[1].pct - b[1].pct; })[0];
      if (worst && worst[1].pct < 40) {
        tips.push({
          level: 'warn',
          title: '本局短板：' + worst[0] + '（全场第 ' + worst[1].rank + '）',
          text: '只超过 ' + worst[1].pct + '% 的玩家。如果不是岗位分工所致，可以重点改进。'
        });
      }
      // 4. 阵营差距：判"势均力敌"用的是 core 那枚相对差（sideGapRel），**不是绝对分值**
      //    名单连"得分"这一列都没填完时这一条整条不出 —— 相对差也是假数
      var d = cmp.diffs;
      if (d && d.sideGapRel !== null && d.sideGapRel !== undefined &&
          (cmp.rosterGaps || []).indexOf('score') === -1) {
        var rel = d.sideGapRel;              // 正 = 对面人均更高
        var ar = Math.abs(rel);
        var perCap = '我方人均 ' + fmtNum(d.teamAvgScore) + '，对面人均 ' + fmtNum(d.enemyAvgScore);
        var mine = '你个人与全场人均相差 ' + (d.vsLobbyScore >= 0 ? '+' : '') + fmtNum(d.vsLobbyScore) + '。';
        if (ar < SIDE_GAP_EVEN) {
          tips.push({
            level: m.is_winner ? 'good' : 'info',
            title: '本局双方势均力敌（人均差 ' + ar + '%）',
            text: perCap + '。' + mine
          });
        } else if (ar < SIDE_GAP_BLOWOUT) {
          tips.push({
            level: 'info',
            title: (rel > 0 ? '本局对面略占上风（人均高 ' : '本局我方略占上风（人均高 ') + ar + '%）',
            text: perCap + '。' + mine
          });
        } else {
          tips.push({
            level: rel > 0 ? 'warn' : 'good',
            title: '本局一边倒：' + (rel > 0 ? '对面人均高出我方 ' : '我方人均高出对面 ') + ar + '%',
            text: perCap + '。你个人' +
              (d.vsTeamScore > 0 ? '高于我方人均 ' + fmtNum(d.vsTeamScore)
                : '低于我方人均 ' + fmtNum(-d.vsTeamScore)) + '，' +
              (rel > 0
                ? (m.is_winner ? '但仍拿下胜利。' : '整体被压制。')
                : (m.is_winner ? '这一场是推着打下来的。'
                    : '可这一场还是输了 —— 人均分不是胜负判据（官方名单里没有占点进度）。'))
          });
        }
      }
    } else {
      tips.push({
        level: 'info', title: '本局没有全场名单',
        text: '无法做同局对比。确认设置里「同步时抓取全场名单」已打开后重新同步。'
      });
    }

    // 5. 干员信息
    if (m.force_type) {
      var agentTips = ['本局使用 ' + Maps.forceName(m.force_type)];
      var agentRows = byAgent(store, allRows).filter(function (a) { return a.key === m.force_type; });
      if (agentRows.length && agentRows[0].total > 1) {
        var a = agentRows[0];
        agentTips.push('该干员你已用 ' + a.total + ' 场，胜率 ' + a.winRate + '%，平均评分 ' + a.rating +
          '（本局 ' + cmp.rating.value + '）');
      }
      tips.push({ level: 'info', title: agentTips[0], text: agentTips.slice(1).join('。') || '这是你首次使用该干员。' });
    }

    // 6. 与历史均值对比
    if (base && base.total > 3) {
      var killDiff = r1(m.kill - base.avgKill);
      tips.push({
        level: killDiff >= 0 ? 'good' : 'info',
        title: '击杀 ' + m.kill + '，' + (killDiff >= 0 ? '高于' : '低于') + '你的场均 ' + Math.abs(killDiff),
        text: '你的场均击杀 ' + base.avgKill + '、场均得分 ' + fmtNum(base.avgScore) +
          '、场均救治 ' + base.avgRescue + '。本局得分 ' + fmtNum(m.score) +
          '，' + (m.score >= base.avgScore ? '高于' : '低于') + '场均 ' + fmtNum(Math.abs(m.score - base.avgScore)) + '。'
      });
    }

    return tips;
  }

  function fmtNum(n) { return Number(n || 0).toLocaleString('zh-CN'); }

  /* ============================================================
   * 同场玩家身份归一
   *
   * ⚠️ 关键事实（实测得出，勿再踩）：
   * 官方对局详情的 tdm_players 里，**部分玩家的 vopenid 是 4~6 位的「当局临时编号」**，
   * 每局重新分配。实测 8 份名单里，编号「8007」分别对应 8 个**互不相同**的玩家（昵称此处不列：
   * 这一份是随包发出去的，别人的游戏名不往里放，要看去本机库里现取）。
   * 若直接拿它当身份键跨局聚合，会把 8 个陌生人合并成「一个人同场 8 次」——纯属虚构。
   *
   * 身份规则：
   *   · 稳定账号 ID（≥10 位数字）→ 身份 = id:<vopenid>，可信度「账号」（实测 242 个长 ID 零同名冲突）
   *   · 当局临时编号            → 身份 = 昵称，可信度「昵称」（编号不可跨局使用）
   *   · 无名且无稳定 ID          → 身份 = slot:<room>:<vopenid>，永不跨局合并
   * 兜底合并：若某昵称既出现在稳定 ID 记录、又出现在临时编号记录里（同一人时隐时现），
   * 则把临时编号记录并入该账号。
   * ============================================================ */
  function stableOpenid(v) { return String(v || '').length >= 10; }
  function nameKey(n) {
    return String(n == null ? '' : n).trim().replace(/[\u200b-\u200f\ufeff]/g, '');
  }
  function isNobodyName(n) { return !n || n === '（匿名）' || n === '匿名'; }

  /* f = 与筛选栏同一份条件（mode / leave / since / mapId）。
   * ★ 不传就是全库 —— 「空档」「扫描场次」那几句要的是全库口径，那边不能动；
   *   而「对手与队友」这一页必须跟着模式筛选走（他报的 bug #87：选了胜者为王，那页一动不动）。 */
  function buildIdentityIndex(store, f) {
    var openid = String(store.activeOpenid());
    var meName = nameKey(store.state.meta.name);
    var groups = {};
    var hiddenSlot = 0;   // 用了临时编号的人次
    var anonymous = 0;    // 既无稳定 ID 又无昵称的人次
    var scanned = 0, totalSlots = 0;

    store.matches(f || {}).forEach(function (m) {
      var ps = store.players(m.room_id);
      if (ps.length < 5) return;
      var me = null;
      for (var i = 0; i < ps.length; i++) {
        if (String(ps[i].vopenid) === openid) { me = ps[i]; break; }
      }
      if (!me) return;
      scanned++;
      totalSlots += ps.length;

      ps.forEach(function (p) {
        var vid = String(p.vopenid || '');
        if (!vid || vid === openid) return;
        var nm = nameKey(p.name);
        if (nm && meName && nm === meName) return;   // 双保险：按昵称也要排除自己

        var key, conf, accId = '';
        if (stableOpenid(vid)) {
          key = 'id:' + vid; conf = 'id'; accId = vid;
        } else if (nm && !isNobodyName(nm)) {
          key = 'nm:' + nm; conf = 'name'; hiddenSlot++;
        } else {
          key = 'slot:' + m.room_id + ':' + vid; conf = 'slot'; anonymous++;
        }

        if (!groups[key]) {
          groups[key] = { key: key, openid: accId, name: '', confidence: conf, meets: [] };
        }
        var g = groups[key];
        if (nm && !isNobodyName(nm)) g.name = nm;   // 昵称稳定，后写覆盖即可
        g.meets.push({ roomId: m.room_id, m: m, p: p, same: p.color === me.color });
      });
    });

    /* 昵称 → 稳定账号 的兜底合并（仅当该昵称唯一对应一个账号时才合并） */
    var idByName = {};
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (g.confidence === 'id' && g.name) {
        idByName[g.name] = idByName[g.name] || [];
        idByName[g.name].push(k);
      }
    });
    Object.keys(groups).slice().forEach(function (k) {
      var g = groups[k];
      if (g.confidence !== 'name' || !g.name) return;
      var hit = idByName[g.name];
      if (!hit || hit.length !== 1) return;         // 有歧义就不合并
      var target = groups[hit[0]];
      if (!target) return;
      g.meets.forEach(function (x) { target.meets.push(x); });
      delete groups[k];
    });

    return {
      groups: groups,
      scanned: scanned, totalSlots: totalSlots,
      hiddenSlot: hiddenSlot, anonymous: anonymous
    };
  }

  /* 由索引里的 meet 列表算出一位玩家的全部统计 */
  function summarizeMeets(meets) {
    var r = { allyMeets: 0, allyWins: 0, enemyMeets: 0, enemyWins: 0,
              score: 0, kill: 0, death: 0, seconds: 0, samples: 0, lastMeet: 0 };
    meets.forEach(function (x) {
      if (x.same) { r.allyMeets++; if (x.m.is_winner) r.allyWins++; }
      else { r.enemyMeets++; if (x.m.is_winner) r.enemyWins++; }
      r.score += x.p.score || 0;
      r.kill += x.p.kill || 0;
      r.death += x.p.death || 0;
      /* KPM 的分母：他这一场打了多久在名单里是每人自带的 game_time，
       * 与 summarize 那边同一个量（那边是战局的 game_time，这里是名单里那一份）。 */
      r.seconds += x.p.game_time || 0;
      r.samples++;
      if (x.m.start_time > r.lastMeet) r.lastMeet = x.m.start_time;
    });
    return r;
  }

  /* ============================================================
   * 同场玩家识别（按「昵称 / 账号」聚合，绝不用当局临时编号跨局聚合）
   * ============================================================ */
  function encounters(store, prebuilt) {
    var idx = prebuilt || buildIdentityIndex(store);

    var list = Object.keys(idx.groups).map(function (k) {
      var g = idx.groups[k];
      var r = summarizeMeets(g.meets);
      return {
        key: g.key, openid: g.openid,
        name: g.name || '（匿名）',
        identifiable: g.confidence === 'id',
        confidence: g.confidence,
        meets: r.allyMeets + r.enemyMeets,
        allyMeets: r.allyMeets, enemyMeets: r.enemyMeets,
        allyWinRate: r.allyMeets ? r2(r.allyWins / r.allyMeets * 100) : null,
        enemyWinRate: r.enemyMeets ? r2(r.enemyWins / r.enemyMeets * 100) : null,
        /* ★ 这两个胜率最容易被读成「和谁组队容易赢」，所以一律带区间（不足 3 场为 null） */
        allyCi: Stats.wilson(r.allyWins, r.allyMeets),
        enemyCi: Stats.wilson(r.enemyWins, r.enemyMeets),
        avgScore: r.samples ? Math.round(r.score / r.samples) : 0,
        avgKill: r.samples ? r2(r.kill / r.samples) : 0,
        kd: r.death ? r2(r.kill / r.death) : r.kill,
        /* 与 kd 同一个池子：总击杀 ÷ 总时长（分钟）。时长为 0 就回 null，界面画「—」，
         * 不许回 0 —— 0 会被读成"这人一分钟一个都没杀"。 */
        kpm: r.seconds > 0 ? r2(r.kill / (r.seconds / 60)) : null,
        lastMeet: r.lastMeet
      };
    });

    /* 分边是随机的：双方各 25~36 人，同阵营概率天然约 50%，
     * 所以看「同阵营率」相对 50% 的偏离，而不是次数多少。 */
    var MIN_MEETS = 2;
    list.forEach(function (x) {
      x.totalMeets = x.allyMeets + x.enemyMeets;
      x.allyRate = x.totalMeets ? r2(x.allyMeets / x.totalMeets * 100) : null;
      x.bias = x.allyRate == null ? 0 : r2(x.allyRate - 50);
    });

    var frequent = list.slice().sort(function (a, b) {
      return b.totalMeets - a.totalMeets || b.avgScore - a.avgScore;
    });
    var eligible = list.filter(function (x) { return x.totalMeets >= MIN_MEETS; });
    var leaningAlly = eligible.slice().sort(function (a, b) {
      return b.allyRate - a.allyRate || b.totalMeets - a.totalMeets;
    });
    var leaningEnemy = eligible.slice().sort(function (a, b) {
      return a.allyRate - b.allyRate || b.totalMeets - a.totalMeets;
    });
    var bestMates = eligible.filter(function (x) { return x.allyMeets >= MIN_MEETS; })
      .sort(function (a, b) { return b.allyWinRate - a.allyWinRate || b.allyMeets - a.allyMeets; });
    var toughest = eligible.filter(function (x) { return x.enemyMeets >= MIN_MEETS; })
      .sort(function (a, b) { return a.enemyWinRate - b.enemyWinRate || b.enemyMeets - a.enemyMeets; });

    // 同场 ≥2 次的人有多少（决定这页现在有没有参考价值）
    var repeat = list.filter(function (x) { return x.totalMeets >= MIN_MEETS; }).length;
    var recent = list.slice().sort(function (a, b) { return b.lastMeet - a.lastMeet; });

    return {
      scanned: idx.scanned, totalPlayers: list.length, playedPlayers: idx.totalSlots,
      minMeets: MIN_MEETS, repeatPlayers: repeat,
      hiddenSlotPlayers: idx.hiddenSlot, anonymousPlayers: idx.anonymous,
      frequent: frequent.slice(0, 30),
      repeats: frequent.filter(function (x) { return x.totalMeets >= MIN_MEETS; }).slice(0, 30),
      recent: recent.slice(0, 30),
      topTeammates: leaningAlly.slice(0, 20),
      topOpponents: leaningEnemy.slice(0, 20),
      bestMates: bestMates.slice(0, 8),
      toughest: toughest.slice(0, 8),
      note: '名单与战绩 100% 来自官方对局详情接口，未作任何加工。' +
            '身份识别：账号 ID 稳定的玩家按账号聚合；官方对约一半玩家只返回「当局临时编号」' +
            '（每局重新分配，同一编号在不同对局里是不同的人），这类玩家改按昵称聚合。' +
            '另外分边是随机的，双方各 25~36 人，同阵营概率天然约 50%，' +
            '因此看「同阵营率」相对 50% 的偏离，而不是次数多少；同阵营 ≠ 组队队友。'
    };
  }

  /* ============================================================
   * 单个玩家的「交手档案」
   * 用户点击某位玩家时按需计算：他出现在哪些场次、当时双方各自排第几。
   * 故意不放进常规报告——每人一份明细会让 IPC 载荷随对局数线性膨胀。
   * ============================================================ */
  function encounterDetail(store, key, f) {
    key = String(key || '');
    var openid = String(store.activeOpenid());
    // 严格相等：不能用前缀匹配，否则 ID 恰好以自己 ID 开头的玩家会被误判为「自己」
    if (!key || key === ('id:' + openid)) return null;

    // 复用同场玩家索引：与「对手队友」页出自同一套身份规则，两处数字必然一致
    // ★ 第三个参数就是筛选栏那份条件 —— 这一页必须跟「对手与队友」同进同退（#87）
    var idx = buildIdentityIndex(store, f);
    var g = idx.groups[key];
    if (!g || !g.meets.length) return null;

    function kd(p) { return p.death ? (p.kill + p.assist) / p.death : (p.kill + p.assist); }
    var KEYS = ['score', 'kill', 'kda', 'rescue', 'occupy'];
    var records = [];
    var allyMeets = 0, allyWins = 0, enemyMeets = 0, enemyWins = 0;

    g.meets.forEach(function (hit) {
      var m = hit.m, him = hit.p;
      var ps = store.players(m.room_id);
      var me = null;
      for (var i = 0; i < ps.length; i++) {
        if (String(ps[i].vopenid) === openid) { me = ps[i]; break; }
      }
      if (!me) return;

      // 每场现算名次映射，排序口径与「单场详情」完全一致，保证两处数字对得上。
      // 用「行下标」而非 vopenid 作键——同一场内若出现空 ID 也不会串名次。
      var rankAt = [];
      KEYS.forEach(function (k) {
        ps.map(function (p, i) { return i; }).sort(function (ia, ib) {
          var a = ps[ia], b = ps[ib];
          var av = k === 'kda' ? kd(a) : (a[k] || 0);
          var bv = k === 'kda' ? kd(b) : (b[k] || 0);
          return bv - av;
        }).forEach(function (pos, r) {
          if (!rankAt[pos]) rankAt[pos] = {};
          rankAt[pos][k] = r + 1;
        });
      });

      var himPos = ps.indexOf(him);
      var mePos = ps.indexOf(me);
      if (himPos < 0 || mePos < 0) return;
      var rk = rankAt[himPos] || {}, mrk = rankAt[mePos] || {};

      var same = him.color === me.color;
      if (same) { allyMeets++; if (m.is_winner) allyWins++; }
      else { enemyMeets++; if (m.is_winner) enemyWins++; }

      records.push({
        roomId: m.room_id,
        mapName: Maps.nameOf(m.map_id),
        side: sideOf(m),
        time: m.dt_event_time,
        startTime: m.start_time,
        sameSide: same,
        myWin: !!m.is_winner,
        players: ps.length,
        name: him.name || '（匿名）',
        score: him.score || 0, kill: him.kill || 0, death: him.death || 0,
        assist: him.assist || 0, rescue: him.rescue || 0, occupy: him.occupy || 0,
        kda: r2(kd(him)),
        /* 单场那两列「每分钟」直接按这一场自己的时长算（时长为 0 回 null，界面画「—」） */
        himSec: him.game_time || 0,
        himKpm: (him.game_time || 0) > 0 ? r2((him.kill || 0) / (him.game_time / 60)) : null,
        himSpm: (him.game_time || 0) > 0 ? Math.round((him.score || 0) / (him.game_time / 60)) : null,
        rankScore: rk.score, rankKill: rk.kill,
        rankKda: rk.kda, rankRescue: rk.rescue, rankOccupy: rk.occupy,
        myName: me.name || '',
        myScore: me.score || 0, myKill: me.kill || 0, myRescue: me.rescue || 0,
        myDeath: me.death || 0, myKda: r2(kd(me)),
        mySec: me.game_time || 0,
        myKpm: (me.game_time || 0) > 0 ? r2((me.kill || 0) / (me.game_time / 60)) : null,
        mySpm: (me.game_time || 0) > 0 ? Math.round((me.score || 0) / (me.game_time / 60)) : null,
        myRankScore: mrk.score, myRankKill: mrk.kill,
        myRankKda: mrk.kda, myRankRescue: mrk.rescue, myRankOccupy: mrk.occupy,
        diffScore: (him.score || 0) - (me.score || 0),
        diffKill: (him.kill || 0) - (me.kill || 0)
      });
    });

    if (!records.length) return null;
    records.sort(function (a, b) { return b.startTime - a.startTime; });

    function avgOf(k) { return Math.round(sum(records, function (r) { return r[k]; }) / records.length); }
    function avgRank(k) { return r1(sum(records, function (r) { return r[k] || 0; }) / records.length); }

    var total = records.length;
    return {
      key: key, name: g.name || records[0].name,
      identifiable: g.confidence === 'id',
      confidence: g.confidence,
      totalMeets: total, allyMeets: allyMeets, enemyMeets: enemyMeets,
      allyRate: r2(allyMeets / total * 100),
      allyWinRate: allyMeets ? r2(allyWins / allyMeets * 100) : null,
      enemyWinRate: enemyMeets ? r2(enemyWins / enemyMeets * 100) : null,
      winRate: r2(sum(records, function (r) { return r.myWin ? 1 : 0; }) / total * 100),
      /* 交手档案里的胜率最容易只有 2~5 场，区间一律随数带出（不足 3 场为 null） */
      allyCi: Stats.wilson(allyWins, allyMeets),
      enemyCi: Stats.wilson(enemyWins, enemyMeets),
      winRateCi: Stats.wilson(sum(records, function (r) { return r.myWin ? 1 : 0; }), total),
      avgScore: avgOf('score'), avgKill: avgOf('kill'), avgRescue: avgOf('rescue'),
      avgRankScore: avgRank('rankScore'), avgRankKill: avgRank('rankKill'),
      myAvgScore: avgOf('myScore'), myAvgRankScore: avgRank('myRankScore'),
      // 直接给结论：这些同场里，他的得分名次有多少次压过你
      better: sum(records, function (r) { return r.rankScore < r.myRankScore ? 1 : 0; }),
      worse: sum(records, function (r) { return r.rankScore > r.myRankScore ? 1 : 0 }),
      /* —— 你我对照（他点名要的：分均得分 / KPM / 击杀数 / 死亡数）——
       * ★ 每一列都按**累计量 ÷ 累计时长**算，不许把每场的比值再求平均 ——
       *   那种平均会被"8 秒 3 杀"的短场次拽飞（KPM 定地板就是因为这个，见 KPM_MIN_SEC 那段）。
       *   累计时长不足 KPM_MIN_SEC 的那个人回 null，界面画「—」并把原因念出来，不许回 0。 */
      compare: (function () {
        var hSec = sum(records, function (r) { return r.himSec; });
        var mSec = sum(records, function (r) { return r.mySec; });
        var hKill = sum(records, function (r) { return r.kill; });
        var mKill = sum(records, function (r) { return r.myKill; });
        var hDeath = sum(records, function (r) { return r.death; });
        var mDeath = sum(records, function (r) { return r.myDeath; });
        var hScore = sum(records, function (r) { return r.score; });
        var mScore = sum(records, function (r) { return r.myScore; });
        function sideOfPair(sec, kill, death, score) {
          return {
            kills: kill, deaths: death, score: score, minutes: r1(sec / 60),
            avgKill: r2(kill / total), avgDeath: r2(death / total),
            kd: death ? r2(kill / death) : kill,
            kpm: sec >= KPM_MIN_SEC ? r2(kill / (sec / 60)) : null,
            spm: sec >= KPM_MIN_SEC ? Math.round(score / (sec / 60)) : null,
            thin: sec < KPM_MIN_SEC
          };
        }
        var h = sideOfPair(hSec, hKill, hDeath, hScore);
        var me = sideOfPair(mSec, mKill, mDeath, mScore);
        var line = '同场 ' + total + ' 场：他场均 ' + h.avgKill + ' 杀 / ' + h.avgDeath +
          ' 死（KD ' + h.kd + '），你场均 ' + me.avgKill + ' 杀 / ' + me.avgDeath + ' 死（KD ' + me.kd + '）。';
        line += (h.kpm == null || me.kpm == null)
          ? ' 每分钟那两列里有人累计时长不足 ' + Math.round(KPM_MIN_SEC / 60) + ' 分钟，按口径不给数（画「—」）。'
          : ' 按累计时长算的每分钟击杀：他 ' + h.kpm + '、你 ' + me.kpm +
            '；分均得分：他 ' + h.spm + '、你 ' + me.spm + '。';
        return { him: h, me: me, minMinutes: Math.round(KPM_MIN_SEC / 60), headline: line };
      })(),
      records: records
    };
  }

  /* ============================================================
   * 周期对比（本周 vs 上周 / 本月 vs 上月）
   * ============================================================ */
  function periodCompare(store, rows) {
    function parse(m) {
      var s = m.dt_event_time || '';
      var t = Date.parse(s.replace(/-/g, '/'));
      return isNaN(t) ? m.start_time * 1000 : t;
    }
    var now = new Date();
    // 本周一 00:00（周一为一周起点）
    function weekStart(offset) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var dow = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - dow - offset * 7);
      return d.getTime();
    }
    function monthStart(offset) {
      return new Date(now.getFullYear(), now.getMonth() - offset, 1).getTime();
    }
    function seg(from, to) {
      var list = rows.filter(function (m) { var t = parse(m); return t >= from && t < to; });
      var s = summarize(list);
      return s;
    }
    var thisWeek = seg(weekStart(0), weekStart(-1));
    var lastWeek = seg(weekStart(1), weekStart(0));
    var thisMonth = seg(monthStart(0), monthStart(-1));
    var lastMonth = seg(monthStart(1), monthStart(0));

    function delta(cur, prev, key) {
      if (!cur || !prev) return null;
      return r2(cur[key] - prev[key]);
    }
    function pack(cur, prev, curLabel, prevLabel) {
      return {
        curLabel: curLabel, prevLabel: prevLabel,
        cur: cur, prev: prev,
        dWinRate: delta(cur, prev, 'winRate'),
        dAvgScore: cur && prev ? Math.round(cur.avgScore - prev.avgScore) : null,
        dKd: delta(cur, prev, 'kd'),
        dKillPerMin: delta(cur, prev, 'killPerMin'),
        dRating: null,
        dTotal: cur && prev ? cur.total - prev.total : null
      };
    }
    return {
      week: pack(thisWeek, lastWeek, '本周', '上周'),
      month: pack(thisMonth, lastMonth, '本月', '上月')
    };
  }

  /* ============================================================
   * 地图 × 干员 交叉分析（战术建议）
   * 分组键：map_id + 模式 + force_type，同一张图不同模式各成一组
   * ============================================================ */
  /* ★ 两道门不要混：`minCell` 决定「这个格子进不进推荐表」（数据门槛，稀疏时会降到 2）；
   *   `MATRIX_MIN_SAMPLE` 只决定「这条推荐硬不硬」（口径门槛，与界面小贴士的 3 场一致）。
   *   低于后者仍然出推荐，但带 thinSample，由界面把话说软 —— 不静默吞行。 */
  var MATRIX_MIN_SAMPLE = 3;
  function mapAgentMatrix(store, rows) {
    var openid = store.activeOpenid();
    var g = {};
    rows.forEach(function (m) {
      if (!m.force_type) return;
      var kind = modeOfMatch(m);
      var k = m.map_id + '|' + kind + '|' + m.force_type;
      if (!g[k]) {
        g[k] = {
          map_id: m.map_id, mapName: Maps.nameOf(m.map_id),
          modeKind: kind, mode: modeLabel(kind),
          agent: Maps.agentName(m.force_type), cls: Maps.forceClass(m.force_type),
          force_type: m.force_type, rows: []
        };
      }
      g[k].rows.push(m);
    });

    var cells = Object.keys(g).map(function (k) {
      var x = g[k];
      var s = summarize(x.rows);
      s.map_id = x.map_id; s.mapName = x.mapName;
      s.modeKind = x.modeKind; s.mode = x.mode;
      s.agent = x.agent; s.cls = x.cls; s.force_type = x.force_type;
      s.rating = r1(sum(x.rows, function (m) {
        return rating(m, store.players(m.room_id), openid, store).value;
      }) / x.rows.length);
      return s;
    }).sort(function (a, b) { return b.total - a.total; });

    // 每张地图 × 每种模式的最佳组合（样本 >= 2 才有说服力，单模式样本稀疏时降到 1）
    var minCell = Math.min(2, Math.max(1, cells.length ? Math.max.apply(null, cells.map(function (c) { return c.total; })) : 1));
    var byMapKey = {};
    cells.forEach(function (c) {
      if (c.total < minCell) return;
      var mk = c.map_id + '|' + c.modeKind;
      (byMapKey[mk] = byMapKey[mk] || []).push(c);
    });
    var bestPerMap = Object.keys(byMapKey).map(function (k) {
      var list = byMapKey[k].slice().sort(function (a, b) {
        return b.winRate - a.winRate || b.rating - a.rating;
      });
      return {
        mapName: list[0].mapName, mode: list[0].mode, modeKind: list[0].modeKind,
        thinSample: list[0].total < MATRIX_MIN_SAMPLE,
        best: list[0], worst: list[list.length - 1], options: list.length
      };
    }).filter(function (x) { return x.best && x.worst && x.best !== x.worst; })
      .sort(function (a, b) { return b.best.winRate - a.best.winRate; });

    return { cells: cells, bestPerMap: bestPerMap, minSample: MATRIX_MIN_SAMPLE };
  }

  return {
    report: report, summarize: summarize, byMap: byMap, byClass: byClass, byAgent: byAgent,
    series: series, byDay: byDay, streak: streak, windowStats: windowStats,
    rating: rating, ratingSeries: ratingSeries, ratingStats: ratingStats,
    rescueMetrics: rescueMetrics, killMetrics: killMetrics,
    commanderStats: commanderStats, isCommanderMatch: isCommanderMatch,
    matchTips: matchTips, lobby: lobbyCompare, insights: insights,
    encounters: encounters, periodCompare: periodCompare, mapAgentMatrix: mapAgentMatrix,
    /* 攻防身份那颗判据与它的适用范围：两个壳给战局行贴 side、界面念文案、以后拿新地面真值复算，
     * 全都从这里取，不许在 shell / ui 里另写一份 color 判断 */
    sideOf: sideOf, SIDE_RULES: SIDE_RULES, sideSplit: sideSplit,
    SIDE_VERIFIED: SIDE_VERIFIED, sideBasis: sideBasis, sideByMap: sideByMap,
    encounterDetail: encounterDetail,
    /* v1.4.0 */
    buildIdentityIndex: buildIdentityIndex,
    weights: weights, weightsText: weightsText, WEIGHT_KEYS: WEIGHT_KEYS,
    WEIGHT_NAMES: WEIGHT_NAMES,
    DEFAULT_W: DEFAULT_W, avgRating: avgRating,
    syncGaps: syncGaps, windowDoubt: windowDoubt,
    /* 官方赛季汇总的三份口径只在这里算一次（界面 renderSeason 直接读） */
    seasonSummary: seasonSummary,
    byHour: byHour, sessionSegments: sessionSegments,
    SIDE_GAP_EVEN: SIDE_GAP_EVEN, SIDE_GAP_BLOWOUT: SIDE_GAP_BLOWOUT,
    peopleStats: peopleStats, watchIndex: watchIndex, watchedRoomMap: watchedRoomMap,
    GAP_DAYS: GAP_DAYS, SESSION_GAP_MIN: SESSION_GAP_MIN, PEOPLE_MIN_SAMPLE: PEOPLE_MIN_SAMPLE,
    MATRIX_MIN_SAMPLE: MATRIX_MIN_SAMPLE,
    /* v1.8.0：六项深度分析 */
    matchMetric: matchMetric, winLossCompare: winLossCompare, durationProfile: durationProfile,
    strengthProfile: strengthProfile, baselineFor: baselineFor, scoreStructure: scoreStructure,
    DUR_BUCKETS: DUR_BUCKETS, SOS_MIN_GAMES: SOS_MIN_GAMES, BASE_MIN_SAME_MAP: BASE_MIN_SAME_MAP,
    /* KPM 的分母地板：界面只许读这一处（榜上那句"不足 N 分钟没进榜"的 N 也从这里来） */
    KPM_MIN_SEC: KPM_MIN_SEC
  };
});
