/* aiDigest.js — 交给云端大模型前的「脱敏摘要」构建（纯 JS，UMD：Node 与浏览器通用）
 *
 * 为什么放在 core/ 且只由主进程调用：渲染层不加载任何 core 模块，摘要在主进程构建，
 * 原始名单（含他人昵称、vopenid）就永远不会流进渲染层，更不会流进网络请求。
 *
 * 三条硬约束：
 *   1. 只发聚合数值与一次性代号，绝不发 openid / vopenid / 任何昵称 / 场次 ID；
 *   2. 体积对场次恒定（O(1)）——逐场明细一律不发，输出走「白名单取键」而不是「黑名单裁剪」；
 *   3. 不碰任何平台 API（无 fs / path / http / window），这样才能在 core.test.js 里断言。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./maps'), require('./analysis'));
  } else {
    root.DFCore = root.DFCore || {};
    root.DFCore.AiDigest = factory(root.DFCore.Maps, root.DFCore.Analysis);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Maps, Analysis) {
  'use strict';

  /* 这里不再有确认句与它的判定：AI 分析自 v1.7.0 起是插件功能，那句确认写在插件清单里、
   * 由宿主闸门 core/plugin.js 的 matchConsent 逐字比对。出厂树的 core/ 里不留任何外发文案。 */

  /* ============ 计量 ============ */
  function utf8Length(s) {
    var n = 0, i, c, len = s.length;
    for (i = 0; i < len; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < len &&
               s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) < 0xe000) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  /* 粗略 token 估算：中日韩字符按 1 token/字，其余按 4 字符/token。
   * 只用于向用户展示「这次大概会消耗多少」，不追求与服务商计费一致。 */
  function estimateTokens(text) {
    var str = String(text || ''), cjk = 0, other = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if ((c >= 0x3000 && c <= 0x303f) || (c >= 0x4e00 && c <= 0x9fff) ||
          (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60)) cjk++;
      else other++;
    }
    return cjk + Math.ceil(other / 4);
  }

  /* ============ 文本小工具 ============ */
  function buf() {
    var rows = [];
    return {
      line: function (s) { if (s !== null && s !== undefined && s !== false) rows.push(String(s)); },
      blank: function () { rows.push(''); },
      text: function () { return rows.join('\n') + '\n'; }
    };
  }

  function n(v) {
    var x = Number(v);
    if (v === null || v === undefined || v === '' || !isFinite(x)) return '—';
    return String(Math.round(x * 100) / 100);
  }
  function pct(v) { return n(v) + '%'; }
  function kv(label, value) { return label + ' ' + value; }

  /* 一次分组（地图 / 兵种 / 干员）的统一行格式 */
  function groupRow(title, g) {
    return title + '：' + g.total + ' 场 胜率 ' + pct(g.winRate) +
      ' 场均得分 ' + n(g.avgScore) + ' 场均击杀 ' + n(g.avgKill) +
      ' 场均死亡 ' + n(g.avgDeath) + ' KD ' + n(g.kd) +
      (g.rating === undefined ? '' : ' 平均评分 ' + n(g.rating));
  }

  function bucketRow(title, buckets) {
    if (!buckets || !buckets.length) return null;
    var parts = [];
    buckets.forEach(function (b) { parts.push((b.range || '?') + ' ' + (b.count || 0) + ' 场'); });
    return title + '：' + parts.join(' / ');
  }

  var NOTE = '说明：以下数值全部来自本机离线统计。同场其他玩家以一次性代号表示（队友A、对手1……），' +
             '不含真实昵称、账号 ID 与场次 ID。';

  var MAP_CAP = 15, CLASS_CAP = 8, AGENT_CAP = 12, MATRIX_CAP = 6, INSIGHT_CAP = 10;

  /* ============ 全局聚合摘要 ============ */
  function buildGlobalDigest(store, filters) {
    filters = filters || {};
    var rep = Analysis.report(store, filters);
    var b = buf();
    var dropped = { encounters: 0, series: 0, days: 0, ratingSeries: 0, maps: 0, agents: 0, matrix: 0, insights: 0 };

    b.line('【《三角洲行动》全面战场 · 个人战绩聚合摘要】');
    b.line(NOTE);
    b.blank();

    var s = rep.summary || {}, c = rep.counts || {}, f = rep.filtered || {}, st = rep.stored || {};
    b.line('数据口径：' + (rep.filterModeLabel || '全部模式') +
      /* filters.since 是绝对秒级截止点，只换算成「近 N 天」，绝不把时间戳本身发出去 */
      (filters.since ? ' · 近 ' + Math.max(1, Math.round((Date.now() / 1000 - Number(filters.since)) / 86400)) + ' 天'
                     : ' · 全部时间'));
    b.line('本次筛选 ' + f.total + ' 场；纳入统计 ' + f.poolSize + ' 场；本机共 ' + (st.total || 0) +
      ' 场，其中 ' + (st.excluded || 0) + ' 场已被标记为不纳入统计。');
    b.line('模式构成：胜者为王 ' + (c.swtwr || 0) + ' 场（其中标记为指挥官 ' + (c.commander || 0) +
      ' 场）· 其他模式 ' + (c.other || 0) + ' 场 · 中途退出 ' + (c.leave || 0) + ' 场' +
      /* 比赛 / 匹配是用户手动标的第三个维度，而摘要通道只有 mode + 天数（宿主侧 DIGEST_MODES 里没有 kind），
       * 所以这里必须把"合并统计"这件事写给模型看，否则它会拿混合口径给出"你比赛打得差"这类结论 */
      ' · 按用户手动标记分：比赛 ' + (c.comp || 0) + ' 场、匹配 ' + (c.practice || 0) + ' 场（本摘要不按这一维筛选，两类合并统计）');

    b.blank();
    b.line('■ 总体表现（' + s.total + ' 场）');
    b.line(kv('胜负', s.win + ' 胜 ' + s.lose + ' 负 · 胜率 ' + pct(s.winRate)));
    b.line('击杀 ' + n(s.kill) + ' · 死亡 ' + n(s.death) + ' · 助攻 ' + n(s.assist) +
      ' · KD ' + n(s.kd) + ' · KDA ' + n(s.kda));
    b.line('总分 ' + n(s.score) + ' · 场均得分 ' + n(s.avgScore) + ' · 每分钟得分 ' + n(s.scorePerMin) +
      ' · 每分钟击杀 ' + n(s.killPerMin));
    b.line('场均击杀 ' + n(s.avgKill) + ' · 场均死亡 ' + n(s.avgDeath) + ' · 场均助攻 ' + n(s.avgAssist));
    b.line('占点（次）合计 ' + n(s.occupy) + '（场均 ' + n(s.avgOccupy) + '）· 救治合计 ' + n(s.rescue) +
      '（场均 ' + n(s.avgRescue) + '）');
    b.line('平均单局时长 ' + n(s.avgDurationMin) + ' 分钟 · 累计 ' + n(s.totalHours) +
      ' 小时 · 中途退出率 ' + pct(s.leaveRate));

    var rs = rep.ratingStats;
    if (rs) {
      b.blank();
      /* 权重自 v1.4.0 起用户可配，摘要里必须带上口径，否则模型会以为数字来自固定权重 */
      b.line('■ 单局评分（0~100，本软件按同局真实排名计算 · 权重 ' +
        Analysis.weightsText(Analysis.weights(store)) + '）');
      b.line('平均 ' + n(rs.avg) + ' · 中位 ' + n(rs.median) + ' · 最高 ' + n(rs.max) +
        ' · 最低 ' + n(rs.min) + ' · 25 分位 ' + n(rs.p25) + ' · 75 分位 ' + n(rs.p75));
      b.line(bucketRow('分布', rs.buckets));
    }
    if (rep.kills) {
      b.blank();
      b.line('■ 淘汰数分布');
      b.line('场均 ' + n(rep.kills.avg) + ' · 最高 ' + n(rep.kills.max) + ' · 最低 ' + n(rep.kills.min) +
        ' · 每分钟 ' + n(rep.kills.perMin));
      b.line(bucketRow('区间', rep.kills.buckets));
    }
    if (rep.rescue) {
      b.blank();
      b.line('■ 救治');
      b.line('合计 ' + n(rep.rescue.total) + ' · 场均 ' + n(rep.rescue.avg) +
        ' · 每分钟 ' + n(rep.rescue.perMin) + ' · 救治/死亡比 ' + n(rep.rescue.rescueDeathRatio) +
        ' · 占全队 ' + pct(rep.rescue.teamShare) + ' · 高于同局 ' + pct(rep.rescue.rankPct) +
        '（有名单样本 ' + (rep.rescue.sampleWithRoster || 0) + ' 场）');
    }

    var w = rep.windows || {}, sk = rep.streak || {};
    b.blank();
    b.line('■ 近期趋势');
    /* 场次不足时 last10/20/30/50 会算出同一个池，四行重复文本既浪费 token 也误导模型；
     * 覆盖整个筛选池的窗口等于「总体表现」，一律跳过。 */
    var pool = (f.total || 0);
    var printed = null;
    ['last10', 'last20', 'last30', 'last50'].forEach(function (k) {
      var x = w[k];
      if (!x || !x.n || x.n >= pool) return;
      var line = '样本 ' + x.n + ' 场，胜率 ' + pct(x.winRate) + '，场均得分 ' + n(x.avgScore);
      if (line === printed) return;
      printed = line;
      b.line('最近 ' + k.slice(4) + ' 场窗口：' + line);
    });
    b.line('最长连胜 ' + (sk.bestWin || 0) + ' 场 · 最长连败 ' + (sk.worstLose || 0) + ' 场 · 当前 ' +
      (sk.currentStreak ? sk.currentStreak + ' 连' + (sk.currentWin ? '胜' : '败') : '无连续'));
    if (rep.commander && rep.commander.available) {
      b.line('指挥官场次数 ' + rep.commander.total + '（在胜者为王中由用户手动标记）');
    }

    var p = rep.periods || {};
    function periodSeg(label, g) {
      var total = (g && g.total) || 0;
      if (!total) return label + ' 无场次';
      return label + ' ' + total + ' 场 胜率 ' + pct(g.winRate) + ' 场均得分 ' + n(g.avgScore);
    }
    [['week', '周对比'], ['month', '月对比']].forEach(function (pair) {
      var x = p[pair[0]];
      if (!x) return;
      var curN = (x.cur && x.cur.total) || 0, prevN = (x.prev && x.prev.total) || 0;
      if (!curN && !prevN) return;   /* 两段都空 → 整块没有信息量，不发 */
      var seg = [periodSeg(x.curLabel, x.cur), periodSeg(x.prevLabel, x.prev)];
      if (curN && prevN) {
        [['胜率环比', x.dWinRate, ' 个百分点'], ['场均得分环比', x.dAvgScore, ''], ['KD 环比', x.dKd, '']]
          .forEach(function (d) {
            if (typeof d[1] !== 'number' || !isFinite(d[1]) || !d[1]) return;
            seg.push(d[0] + ' ' + (d[1] > 0 ? '+' : '') + n(d[1]) + d[2]);
          });
      }
      b.blank();
      b.line('■ ' + pair[1]);
      b.line(seg.join(' · '));
    });

    var maps = (rep.maps || []);
    b.blank();
    b.line('■ 分地图（按场次排序，最多列 ' + MAP_CAP + ' 项）');
    maps.slice(0, MAP_CAP).forEach(function (g) {
      b.line(groupRow((g.mapName || g.map_id) + '（' + (g.mode || '常规') + '）', g));
    });
    dropped.maps = Math.max(0, maps.length - MAP_CAP);

    var classes = (rep.classes || []);
    b.blank();
    b.line('■ 分兵种');
    classes.slice(0, CLASS_CAP).forEach(function (g) { b.line(groupRow(g.label || g.key, g)); });

    var agents = (rep.agents || []);
    b.blank();
    b.line('■ 分干员（最多列 ' + AGENT_CAP + ' 项）');
    agents.slice(0, AGENT_CAP).forEach(function (g) { b.line(groupRow(g.label || g.agent || g.key, g)); });
    dropped.agents = Math.max(0, agents.length - AGENT_CAP);

    var allCells = (rep.matrix && rep.matrix.cells) || [];
    var cells = allCells.filter(function (x) { return x.total >= 2; })
      .sort(function (a, b2) { return (b2.rating || 0) - (a.rating || 0); })
      .slice(0, MATRIX_CAP);
    if (cells.length) {
      b.blank();
      b.line('■ 地图 × 干员（样本 ≥2 场，按平均评分取前 ' + MATRIX_CAP + ' 组）');
      cells.forEach(function (x) {
        b.line((x.mapName || x.map_id) + ' × ' + (x.agent || Maps.agentName(x.force_type) || '未知') +
          '（' + (x.cls || '') + '）：' + x.total + ' 场 胜率 ' + pct(x.winRate) +
          ' 平均评分 ' + n(x.rating));
      });
    }
    dropped.matrix = Math.max(0, allCells.length - cells.length);

    var ins = (rep.insights || []);
    if (ins.length) {
      b.blank();
      b.line('■ 本软件算法已识别的要点（供参考，你可以反驳或补充）');
      ins.slice(0, INSIGHT_CAP).forEach(function (x) {
        b.line('- ' + x.title + (x.text ? '：' + x.text : ''));
      });
    }
    dropped.insights = Math.max(0, ins.length - INSIGHT_CAP);

    /* 逐场明细一律不发：这几个字段正比于场次，是体积失控的唯一来源。只记数不记内容 */
    var enc = rep.encounters || {};
    dropped.encounters = (enc.totalPlayers || 0) + (enc.recent ? enc.recent.length : 0);
    dropped.series = (rep.series || []).length;
    dropped.days = (rep.days || []).length;
    dropped.ratingSeries = (rep.ratingSeries || []).length;

    var out = finish(b, 'global');
    out.dropped = dropped;
    return out;
  }

  /* ============ 单场摘要 ============ */
  function letters(idx) {
    var s = '', x = idx + 1;
    while (x > 0) {
      var m = (x - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      x = Math.floor((x - 1) / 26);
    }
    return s;
  }

  function rankOf(players, me, key) {
    var mine = Number(me[key] || 0), rank = 1;
    players.forEach(function (p) { if (p !== me && Number(p[key] || 0) > mine) rank++; });
    return rank;
  }

  function buildMatchDigest(store, roomId) {
    var m = store.match(roomId);
    if (!m) return { error: '找不到这场对局，请重新选择' };

    var b = buf();
    b.line('【《三角洲行动》全面战场 · 单场摘要】');
    b.line(NOTE);
    b.blank();

    var mode = Maps.isSWWR(m.map_id, m.game_rule) ? '胜者为王' : '常规模式';
    b.line('时间 ' + String(m.dt_event_time || '').slice(0, 16) + ' · 地图 ' +
      (m.map_name || Maps.nameOf(m.map_id)) + ' · 模式 ' + mode +
      (m.is_commander ? ' · 我是指挥官' : '') + ' · 结果 ' + (m.is_winner ? '胜利' : '失败') +
      (m.is_leave ? ' · 我中途退出' : '') + ' · 时长 ' + n((m.game_time || 0) / 60) + ' 分钟');
    if (m.force_type) {
      b.line('我的干员：' + (Maps.agentName(m.force_type) || Maps.forceName(m.force_type)) +
        '（' + (Maps.forceClass(m.force_type) || '') + '）');
    }

    b.blank();
    b.line('■ 我的表现');
    b.line('击杀 ' + n(m.kill) + ' · 死亡 ' + n(m.death) + ' · 助攻 ' + n(m.assist) +
      ' · KD ' + n(m.kd) + ' · KPM ' + n((m.game_time || 0) > 0 ? m.kill / (m.game_time / 60) : null) +
      ' · KDA ' + n(m.kda));
    b.line('得分 ' + n(m.score) + ' · 每分钟得分 ' + n(m.score_per_min) +
      ' · 占点（次） ' + n(m.occupy) + ' · 救治 ' + n(m.rescue));

    var players = store.players(roomId) || [];
    var openid = String(store.activeOpenid() || '');
    var me = null;
    if (openid) {
      for (var i = 0; i < players.length; i++) {
        if (String(players[i].vopenid) === openid) { me = players[i]; break; }
      }
    }

    if (players.length < 5 || !me) {
      /* 没有名单、或定位不到「我」，就没法安全地区分队友与对手 —— 宁可不发也不猜 */
      b.blank();
      b.line('（本场缺少全场名单，无法给出同场队友与对手的对比。）');
      var only = finish(b, 'match');
      only.roomId = String(roomId);
      only.aliases = [];
      only.dropped = { teammates: 0, enemies: 0, roster: players.length };
      return only;
    }

    var order = [];
    players.forEach(function (p, idx) { if (p !== me) order.push({ p: p, i: idx }); });
    /* 排序键决定代号，必须稳定：得分降序 → vopenid 升序 → 原始下标升序（同场两次生成结果全等） */
    order.sort(function (a, x) {
      var d = (x.p.score || 0) - (a.p.score || 0);
      if (d) return d;
      var av = String(a.p.vopenid || ''), bv = String(x.p.vopenid || '');
      if (av !== bv) return av < bv ? -1 : 1;
      return a.i - x.i;
    });

    var allyIdx = 0, enemyIdx = 0;
    var allyLines = [], enemyLines = [], aliases = [];
    var sum = { ally: {}, enemy: {} };

    function add(side, p) {
      var t = sum[side];
      ['kill', 'death', 'assist', 'score', 'occupy', 'rescue'].forEach(function (k) {
        t[k] = (t[k] || 0) + (Number(p[k]) || 0);
      });
      t.head = (t.head || 0) + 1;
    }

    order.forEach(function (it) {
      var p = it.p, ally = p.color === me.color;
      var alias = ally ? '队友' + letters(allyIdx++) : '对手' + (++enemyIdx);
      aliases.push({ alias: alias, side: ally ? 'ally' : 'enemy' });
      add(ally ? 'ally' : 'enemy', p);
      (ally ? allyLines : enemyLines).push(alias + '：击杀 ' + n(p.kill) + ' 死亡 ' + n(p.death) +
        ' 助攻 ' + n(p.assist) + ' 得分 ' + n(p.score) + ' 占点（次） ' + n(p.occupy) +
        ' 救治 ' + n(p.rescue) + ' 时长 ' + n((p.game_time || 0) / 60) + ' 分钟' +
        (p.force_type ? ' 干员 ' + (Maps.agentName(p.force_type) || Maps.forceName(p.force_type)) : '') +
        (p.is_leave ? ' 中途退出' : ''));
    });
    add('ally', me);

    var allies = allyLines.length + 1, enemies = enemyLines.length;

    b.blank();
    b.line('■ 团队对比（我方阵营 ' + allies + ' 人 ' + (me.is_winner ? '胜' : '负') +
      ' · 对方阵营 ' + enemies + ' 人 ' + (me.is_winner ? '负' : '胜') + '）');
    function teamLine(label, t, head) {
      return label + '：总击杀 ' + (t.kill || 0) + ' 总死亡 ' + (t.death || 0) +
        ' 总助攻 ' + (t.assist || 0) + ' 总得分 ' + (t.score || 0) +
        ' 总占点（次） ' + (t.occupy || 0) + ' 总救治 ' + (t.rescue || 0) +
        ' 人均得分 ' + n((t.score || 0) / head);
    }
    b.line(teamLine('我方', sum.ally, allies));
    b.line(teamLine('对方', sum.enemy, enemies || 1));
    b.line('我在同场 ' + players.length + ' 人中的排名：得分第 ' + rankOf(players, me, 'score') +
      ' 名 · 击杀第 ' + rankOf(players, me, 'kill') + ' 名 · 助攻第 ' + rankOf(players, me, 'assist') +
      ' 名 · 救治第 ' + rankOf(players, me, 'rescue') + ' 名 · 占点（次）第 ' + rankOf(players, me, 'occupy') + ' 名');

    var rt = Analysis.rating(m, players, store.activeOpenid());
    if (rt && rt.value !== undefined) {
      b.line('本场我的单局评分 ' + n(rt.value) + '（' +
        (rt.basis === 'lobby' ? '按同局 ' + players.length + ' 人真实排名计算' : '按官方汇总估算') + '）');
    }

    b.blank();
    b.line('■ 队友（共 ' + allyLines.length + ' 人，按得分从高到低编号）');
    allyLines.forEach(function (x) { b.line(x); });
    b.blank();
    b.line('■ 对手（共 ' + enemyLines.length + ' 人，按得分从高到低编号）');
    enemyLines.forEach(function (x) { b.line(x); });

    var out = finish(b, 'match');
    out.roomId = String(roomId);
    out.aliases = aliases;
    out.dropped = { teammates: allyLines.length, enemies: enemyLines.length, roster: players.length };
    return out;
  }

  function finish(b, scope) {
    var t = b.text();
    return { scope: scope, text: t, bytes: utf8Length(t), estTokens: estimateTokens(t) };
  }

  return {
    estimateTokens: estimateTokens,
    utf8Length: utf8Length,
    buildGlobalDigest: buildGlobalDigest,
    buildMatchDigest: buildMatchDigest
  };
});
