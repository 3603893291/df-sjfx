/* views.js — 各视图渲染（纯 JS，无框架） */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmt(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('zh-CN');
  }
  function signed(n) {
    if (n == null || isNaN(n)) return '—';
    var v = Math.round(n);
    return (v > 0 ? '+' : '') + v.toLocaleString('zh-CN');
  }
  function pct(n) { return (n == null || isNaN(n)) ? '—' : n + '%'; }
  function el(id) { return document.getElementById(id); }
  function empty(t) { return '<div class="empty">' + t + '</div>'; }
  /* ★ 空数据分支要清掉图表，一律走这里：DFCharts.clear 会连实例一起 dispose。
   *   自己写 container.innerHTML='' 只摘走画布、实例还留在登记表里，
   *   下次切回有数据时 setOption 就画进一个游离节点 —— 图永久空白，刷新页面才回来。 */
  function clearCharts(ids) { ids.forEach(function (id) { global.DFCharts.clear(id); }); }
  function rateCls(v) { return v >= 60 ? 'good' : (v < 45 ? 'bad' : ''); }
  function wrColor(v) { return v >= 50 ? 'var(--green)' : (v < 30 ? 'var(--red)' : 'inherit'); }

  /* ★ ④ 胜率一律带 95% 区间。区间与可靠性档位由 core/stats.js 算好后挂在每一条汇总上，
   *   这里只做排版 —— 渲染层不加载 core/*，判定源必须只有一份，
   *   否则切一个界面就有人把 3 场的 100% 说成结论。 */
  function ciFoot(o) {
    if (!o) return '';
    var n = o.n != null ? o.n : (o.ci && o.ci.n != null ? o.ci.n : o.total);
    if (!o.ci) return n == null ? '' : '<span class="ci">仅 ' + n + ' 场</span>';
    return '<span class="ci' + (o.reliability === 'thin' ? ' warn' : '') + '">' +
      o.ci.lo + '~' + o.ci.hi + '%' + (o.reliability === 'thin' ? ' 样本薄' : '') + '</span>';
  }
  function wrTd(o) {
    if (!o || o.winRate == null) return '<td class="dim">—</td>';
    return '<td><span style="color:' + wrColor(o.winRate) + '">' + o.winRate + '%</span>' +
      ciFoot(o) + '</td>';
  }
  /* 结论文案走 esc()，所以这里的区间是纯文本而不是标签 */
  function ciPlain(o) {
    if (!o) return '';
    var n = o.n != null ? o.n : (o.ci && o.ci.n != null ? o.ci.n : o.total);
    return o.ci ? '（95% 区间 ' + o.ci.lo + '~' + o.ci.hi + '%，' + n + ' 场）'
      : '（只有 ' + n + ' 场，给不出区间）';
  }
  function ciLine(pairs) {
    var txt = (pairs || []).filter(function (p) { return p[1] && p[1].winRate != null; }).map(function (p) {
      return p[0] + ' ' + p[1].winRate + '%' + ciPlain(p[1]);
    });
    return txt.length
      ? '<p class="hint">胜率不是一个点值：' + esc(txt.join(' · ')) +
        '。官方只保留最近约 36 场，区间这么宽就是样本还少的意思。</p>'
      : '';
  }

  /* ★ 结论门槛：官方接口只保留最近约 36 场，落到单个地图 / 兵种 / 干员常常只剩 1~2 场。
   *   这种样本下的结论会自相矛盾（实测出现过「需要加强：侦查 2 场，胜率仅 0%，
   *   平均评分 88.7」——评分比「最擅长」的还高）。不足这个场次的一律只列在表里，
   *   不参与「最擅长 / 短板 / 需要加强 / 高评分」这类排名式结论。 */
  var MIN_TIP_SAMPLE = 3;

  /* 主指标卡（固定 6 列） */
  function kpi6(items) {
    return '<div class="kpis-6">' + items.map(function (k) {
      return '<div class="kpi ' + (k[3] || '') + '"><div class="k">' + k[0] + '</div>' +
        '<div class="v">' + k[1] + (k[2] ? '<small>' + k[2] + '</small>' : '') + '</div></div>';
    }).join('') + '</div>';
  }
  /* 紧凑指标条 */
  function strip(items) {
    return '<div class="strip">' + items.map(function (k) {
      return '<div class="item"><div class="k">' + k[0] + '</div>' +
        '<div class="v ' + (k[3] || '') + '">' + k[1] +
        (k[2] ? '<small>' + k[2] + '</small>' : '') + '</div></div>';
    }).join('') + '</div>';
  }
  /* 自适应列数的指标卡组：自带栅格容器，避免被外层栅格当普通块挤压 */
  function kpiCards(items) {
    return '<div class="kpis">' + items.map(function (k) {
      return '<div class="kpi ' + (k[3] || '') + '"><div class="k">' + k[0] + '</div>' +
        '<div class="v">' + k[1] + (k[2] ? '<small>' + k[2] + '</small>' : '') + '</div></div>';
    }).join('') + '</div>';
  }
  function insightsHtml(list) {
    return '<div class="insights">' + (list || []).map(function (i) {
      return '<div class="insight ' + esc(i.level) + '"><div>' +
        '<div class="insight-t">' + esc(i.title) + '</div>' +
        '<div class="insight-x">' + esc(i.text) + '</div></div></div>';
    }).join('') + '</div>';
  }
  function tipsHtml(list) {
    if (!list || !list.length) return '';
    return '<div class="tips">' + list.map(function (t) {
      return '<div class="tip ' + esc(t.level || '') + '"><div>' +
        '<div class="tip-t">' + esc(t.title) + '</div>' +
        '<div class="tip-x">' + esc(t.text) + '</div></div></div>';
    }).join('') + '</div>';
  }

  /* ============================================================
   * 总览
   * ============================================================ */
  function renderOverview(rep) {
    var s = rep.summary;
    if (!s) {
      el('kpis').innerHTML = '';
      el('insights').innerHTML = insightsHtml(rep.insights);
      el('seasonPanel').innerHTML = rep.filtered.poolSize
        ? '<h3>当前筛选无数据</h3><p class="hint">本地已采集 <b>' + rep.filtered.poolSize +
          '</b> 场，换个筛选条件看看。</p>'
        : empty('还没有采集到对局。点击左下角「立即同步」开始采集。');
      clearCharts(['chScore', 'chKd', 'chMap', 'chDay']);
      return;
    }

    el('overviewSub').textContent = '筛选后 ' + s.total + ' 场 · 数据截至 ' +
      (rep.lastSync ? new Date(rep.lastSync).toLocaleString('zh-CN', { hour12: false }) : '—');

    var w = rep.windows || {}, rs = rep.ratingStats, st = rep.streak || {};
    var kills = rep.kills, rescue = rep.rescue, cm = rep.commander;

    el('kpis').innerHTML =
      kpi6([
        ['场次', fmt(s.total), '', ''],
        ['胜率', s.winRate, '%', s.winRate >= 50 ? 'good' : 'bad'],
        ['平均评分', rs ? rs.avg : '—', '', rs ? rateCls(rs.avg) : ''],
        /* ★ KD 从这一格让给 KPM（使用者的原话：「大多数胜者为王玩家都认为 kpm 比 kd 更重要」）。
         *   KD 一个字都没删 —— 它降到下面「更多指标」那条里，两处都读 summarize 那一份。 */
        ['KPM', s.killPerMin, '', 'accent'],
        ['场均得分', fmt(s.avgScore), '', 'accent'],
        ['分均得分', fmt(s.scorePerMin), '', 'accent']
      ]) +
      '<div class="hint" style="margin:-6px 0 8px 2px">更多指标</div>' +
      strip([
        ['总击杀', fmt(s.kill)],
        ['总死亡', fmt(s.death)],
        ['KD', s.kd, '', s.kd >= 1 ? 'good' : ''],
        ['KDA', s.kda],
        ['场均击杀', s.avgKill],
        ['场均助攻', s.avgAssist],
        [OCC.avg, s.avgOccupy],
        ['场均救治', s.avgRescue],
        ['救治/阵亡', rescue ? rescue.rescueDeathRatio : '—'],
        ['单局最高击杀', kills ? kills.max : '—'],
        ['时长(小时)', s.totalHours],
        ['中途退出率', s.leaveRate, '%', s.leaveRate > 10 ? 'bad' : ''],
        ['最长连胜/连败', st.bestWin + ' / ' + st.worstLose]
      ]) +
      strip([
        ['近 10 局胜率', w.last10 ? w.last10.winRate : '—', '%',
          w.last10 && w.last10.winRate >= 50 ? 'good' : 'bad'],
        ['近 30 局胜率', w.last30 ? w.last30.winRate : '—', '%',
          w.last30 && w.last30.winRate >= 50 ? 'good' : 'bad'],
        ['当前连胜', st.currentStreak || 0, st.currentWin ? ' 连胜' : ' 连败',
          st.currentWin ? 'good' : 'bad'],
        ['评分中位数', rs ? rs.median : '—'],
        ['最高评分', rs ? rs.max : '—', '', 'good'],
        ['指挥官对局', cm && cm.available ? cm.total : 0, ' 场']
      ]) +
      ciLine([['总胜率', s], ['近 10 局', w.last10], ['近 30 局', w.last30]]);

    el('insights').innerHTML = insightsHtml(rep.insights);

    var ser = rep.series || [];
    var cats = ser.map(function (x) { return x.label; });
    global.DFCharts.line('chScore', cats, ser.map(function (x) { return x.score; }), '得分', 'accent', { area: true });
    /* 这一张图原来是单线的 KD。画成 KPM + KD 双线而不是换掉：
     * 那两枚数在真库里只重合 56%（见上面 KPM 那段），一条线讲不清"这场赢得多但打得慢"这种事。 */
    global.DFCharts.multiLine('chKd', cats, [
      { name: 'KPM', values: ser.map(function (x) { return x.killPerMin; }), color: 'orange' },
      { name: 'KD', values: ser.map(function (x) { return x.kd; }), color: 'green' }
    ]);

    var days = rep.days || [];
    global.DFCharts.combo('chDay',
      days.map(function (x) { return x.day.slice(5); }),
      { name: '场次', values: days.map(function (x) { return x.total; }) },
      { name: '胜率 %', values: days.map(function (x) { return x.winRate; }) });

    var maps = rep.maps || [];
    global.DFCharts.hbar('chMap',
      maps.slice(0, 12).map(function (m) { return m.mapName; }).reverse(),
      maps.slice(0, 12).map(function (m) { return m.winRate; }).reverse(), 'accent', '%');

    renderSeason(rep.season);
  }

  function renderSeason(sea) {
    var box = el('seasonPanel');
    if (!sea || !sea.allMode || !sea.allMode.totalFight) {
      box.innerHTML = '<h3>官方赛季数据</h3><p class="hint">本机还没有官方赛季汇总的存档 —— ' +
        '同步一次就会带上（这一发失败的话，「同步」那一步的报错里能看到原因）。<br>' +
        '问的是第几赛季由「设置 → 官方赛季号」决定，留空即内置默认。</p>';
      return;
    }
    var a = sea.allMode, c = sea.career, w = sea.swwr;
    function row(label, cells, hl) {
      return '<tr><td class="l"' + (hl ? ' style="color:var(--accent);font-weight:500"' : '') + '>' +
        label + '</td>' + cells.map(function (x) { return '<td>' + x + '</td>'; }).join('') + '</tr>';
    }
    var html = '<h3>官方赛季数据 <span class="dim" style="font-weight:400;font-size:12px">' +
      '第 ' + esc(sea.sid || '?') + ' 赛季 · 官方口径' +
      (sea.at ? ' · 存档于 ' + new Date(sea.at).toLocaleString('zh-CN', { hour12: false }) : '') + '</span></h3>' +
      '<table><thead><tr><th class="l">统计口径</th><th>场次</th><th>胜率</th><th>KD</th>' +
      '<th>场均得分</th><th>分均得分</th><th>总击杀</th></tr></thead><tbody>';
    if (w) {
      html += row('胜者为王 · 本赛季', [fmt(w.total), pct(w.winRate), w.kd,
        fmt(w.avgScore), fmt(w.scorePerMin), fmt(w.kill)], true);
    }
    html += row('全模式 · 本赛季', [fmt(a.totalFight), pct(a.winRate), '—',
      a.totalFight ? fmt(Math.round(a.totalScore / a.totalFight)) : '—',
      fmt(a.scorePerMin), fmt(a.totalKill)]);
    html += row('全模式 · 生涯累计', [fmt(c.totalFight), pct(c.winRate), c.kd, '—', '—', fmt(c.totalKill)]);
    html += '</tbody></table>';
    /* ★ 一句话把"第几赛季"这件事交代清楚：官方没有可查当前赛季号的接口，
     *   这一格问的是几号由设置里那一格决定，留空走内置默认。换赛季却没人告诉软件时，
     *   这里念的就是旧赛季的存档 —— 与其装成"本赛季"，不如把号印出来。 */
    html += '<p class="hint">上面三行都是官方口径，与「地图分析」页那套本机统计不是同一套数。<br>' +
      '<b>这里念的是第 ' + esc(sea.sid || '?') + ' 赛季</b>：官方没有"查当前赛季号"的接口，' +
      '号由「设置 → 官方赛季号」决定（留空 = 内置默认）。换赛季后如果这一格没跟着改，' +
      '看到的就是旧赛季的存档。只有赛季汇总与分地图统计用得上这个号，' +
      '<b>战局列表不受影响</b>，照常拿最新场次。</p>';

    if (w && w.maps && w.maps.length) {
      html += '<h3 style="margin-top:20px">胜者为王 · 官方各图明细</h3>' +
        '<table><thead><tr><th class="l">地图</th><th>场次</th><th>胜率</th><th>KD</th>' +
        '<th>场均得分</th><th>总击杀</th></tr></thead><tbody>' +
        w.maps.map(function (m) {
          return '<tr><td class="l">' + esc(m.mapName) + '</td><td>' + m.total + '</td>' +
            '<td style="color:' + wrColor(m.winRate) + '">' + m.winRate + '%</td><td>' + m.kd + '</td>' +
            '<td>' + fmt(m.avgScore) + '</td><td>' + fmt(m.kill) + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<p class="hint">这一段来自官方赛季汇总，覆盖整个赛季（含本软件使用前的场次）。' +
        '「地图分析」页的数据则完全由本软件采集的对局统计。</p>';
    }
    box.innerHTML = html;
  }

  /* ============================================================
   * 六项深度分析（v1.8.0）面板：①③⑤⑥⑧
   * ④ 不在这里 —— 它挂在每个胜率数字下面（见文件顶部 ciFoot / wrTd / ciPlain）。
   * ★ 这五块一律照抄 core 的 headline：界面只排版，不写第二种判定 ——
   *   判定源每多一个，就多一条把噪声说成结论的通道。
   * ============================================================ */
  function sub(title) {
    return '<h3>' + title + '<span class="dim" style="font-weight:400;font-size:12px">' +
      ' 结论由本机数据现算 · 样本不足时只列数字</span></h3>';
  }

  /* ① 你赢的那场 vs 你输的那场 */
  function renderWinLoss(rep) {
    var box = el('winLossPanel');
    if (!box) return;
    var wl = rep.winLoss || {};
    var html = sub('你赢的那场 vs 你输的那场');
    if (!wl.available) {
      box.innerHTML = html + empty(esc(wl.reason || '数据不足'));
      return;
    }
    html += '<p class="hint">' + esc(wl.headline) + '</p>' +
      '<table class="tbl-lite"><thead><tr><th class="l">项目</th>' +
      '<th>赢的 ' + wl.wins + ' 场</th><th>输的 ' + wl.losses + ' 场</th>' +
      '<th>差</th><th>差的 95% 区间</th><th>效应量</th><th>判定</th></tr></thead><tbody>' +
      wl.items.map(function (x) {
        return '<tr><td class="l">' + esc(x.label) + '</td>' +
          '<td>' + x.a + '</td><td>' + x.b + '</td>' +
          '<td>' + (x.diff > 0 ? '+' : '') + x.diff + '</td>' +
          '<td class="dim">' + x.lo + '~' + x.hi + '</td>' +
          '<td>' + (x.effect == null ? '—' : x.effect + '（' + x.mag + '）') + '</td>' +
          '<td>' + (x.clear
            ? '<span style="color:var(--green)">看得出方向</span>'
            : '<span class="dim">说不出方向</span>') + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="hint">「差」= 赢场均值 − 输场均值；它的区间跨过 0 就意味着连哪边更高都还说不出来。' +
      '「效应量」= 差多少个你自己的单场波动，档位（微 / 小 / 中 / 大）由 core 统一划。' +
      '两侧各不足 ' + wl.minSide + ' 场时这块不出表。这是相关不是因果：赢输本身也会反过来改变你的数据。</p>';
    box.innerHTML = html;
  }

  /* ③ 时长与节奏结构 */
  function renderDurations(rep) {
    var box = el('durPanel');
    if (!box) return;
    var d = rep.durations || {};
    var html = sub('时长与节奏结构');
    if (!d.total) { box.innerHTML = html + empty('当前筛选下没有带时长记录的对局'); return; }
    html += '<p class="hint">' + esc(d.headline) + '</p>' +
      '<table class="tbl-lite"><thead><tr><th class="l">单场时长</th><th>场次</th><th>胜率</th>' +
      '<th>场均得分</th><th>该档实际平均</th></tr></thead><tbody>' +
      d.buckets.map(function (b) {
        return '<tr' + (b.n < d.minBucket ? ' class="row-excluded"' : '') + '>' +
          '<td class="l">' + esc(b.label) + '</td><td>' + b.n + '</td>' + wrTd(b) +
          '<td>' + fmt(b.avgScore) + '</td>' +
          '<td class="dim">' + (b.avgMinutes == null ? '—' : b.avgMinutes + ' 分') + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="hint">时长按官方每场 game_time 分箱。灰显行不足 ' + d.minBucket +
      ' 场，只是碰巧打得少。短局既可能是速推也可能是早期崩盘，' +
      '这份数据里没有局内事件序列，分不开这两者。「连打到第几场开始掉」在同一页下面的连战衰减表里。</p>';
    box.innerHTML = html;
  }

  /* ⑤ 对手强度校准 */
  function renderStrength(rep) {
    var box = el('strengthPanel');
    if (!box) return;
    var s = rep.strength || {};
    var html = sub('对手强度校准');
    if (!s.available) {
      box.innerHTML = html + empty(esc(s.reason || '带全场名单的场次不足'));
      return;
    }
    html += '<p class="hint">' + esc(s.headline) + '</p>' +
      '<table class="tbl-lite"><thead><tr><th class="l">两边池子差</th><th>场次</th>' +
      '<th>平均差值</th><th>胜率</th></tr></thead><tbody>' +
      s.bins.map(function (b) {
        return '<tr><td class="l">' + esc(b.label) + '</td><td>' + b.n + '</td>' +
          '<td class="dim">' + signed(b.avgGap) + '</td>' + wrTd(b) + '</tr>';
      }).join('') + '</tbody></table>' +
      (s.underdog && s.underdog.n
        ? '<p class="hint">池子差为负的劣势局 ' + s.underdog.n + ' 场，你赢了 ' +
          s.underdog.winRate + '%' + ciPlain(s.underdog) + '。</p>' : '') +
      (s.drift ? (function () {
        var e = s.drift.early, l = s.drift.late, gd = s.drift.gapDiff;
        return '<p class="hint">时间对半切：早 ' + e.n + ' 场平均池子差 ' + signed(e.avgGap) +
          '（胜率 ' + e.winRate + '%）→ 近 ' + l.n + ' 场 ' + signed(l.avgGap) +
          '（胜率 ' + l.winRate + '%）。匹配给你的局' +
          (s.drift.gapClear
            ? (l.avgGap > e.avgGap ? '更好打' : '更难打') + '了（差 ' + signed(gd.diff) +
              '，区间 ' + Math.round(gd.lo) + '~' + Math.round(gd.hi) + '，不跨 0）'
            : '有没有变好打还说不出来（差 ' + signed(gd.diff) + '，区间 ' +
              Math.round(gd.lo) + '~' + Math.round(gd.hi) + '，跨过 0）') +
          '。这两半的胜率差 ' + (s.drift.rateDiff > 0 ? '+' : '') + s.drift.rateDiff +
          ' 个百分点，但强度那边说不清方向，所以这一项归不到「局变好打了」头上。</p>';
      })() : '') +
      (s.ownPartCaveat ? '<p class="hint">' + esc(s.ownPartCaveat) + '</p>' : '') +
      '<p class="hint">「池子差」= 我方全场平均得分 − 对方全场平均得分（每边约 26 人，含你自己那一份），' +
      '三档按你这批场次实测三分位切（切点 ' + signed(s.cuts.c1) + ' / ' + signed(s.cuts.c2) +
      '），不写死「多少分算强敌」。它衡量的是两边名单谁更深，不是匹配公不公道。</p>';
    box.innerHTML = html;
  }

  /* ⑧ 得分结构反推 vs 你手设的权重 */
  function renderStructure(rep) {
    var box = el('structurePanel');
    if (!box) return;
    var st = rep.structure || {};
    var html = sub('得分结构反推 · 对照你设的权重');
    if (!st.available) {
      box.innerHTML = html + empty(esc(st.reason || '样本不足')) +
        (st.userShares ? '<table class="tbl-lite"><thead><tr><th class="l">项目</th>' +
          '<th>你设的占比</th></tr></thead><tbody>' + st.userShares.map(function (x) {
            return '<tr><td class="l">' + esc(x.label) + '</td><td>' + x.userShare + '%</td></tr>';
          }).join('') + '</tbody></table>' : '');
      return;
    }
    function bar(v, color) {
      return '<span class="sbar"><i style="width:' + Math.max(0, Math.min(100, v)) +
        '%;background:' + color + '"></i></span>' + v + '%';
    }
    html += '<p class="hint">' + esc(st.headline) + '</p>' +
      '<table class="tbl-lite"><thead><tr><th class="l">项目</th>' +
      '<th>数据说的占比</th><th>你设的占比</th><th>差</th>' +
      '<th>偏回归 beta</th><th>与总分相关</th></tr></thead><tbody>' +
      st.items.map(function (x) {
        return '<tr><td class="l">' + esc(x.label) + '</td>' +
          '<td>' + bar(x.share, 'var(--accent)') + '</td>' +
          '<td>' + bar(x.userShare, 'var(--text-3)') + '</td>' +
          '<td style="color:' + (Math.abs(x.gap) >= st.minGap ? 'var(--orange)' : 'inherit') +
          '">' + (x.gap > 0 ? '+' : '') + x.gap + '</td>' +
          '<td>' + x.beta + '</td><td>' + x.r + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="hint">' + esc(st.note) + ' ' + esc(st.basis) +
      ' beta 的读法：其它三项都一样时，这一项每高一个标准差，你的总分跟着动多少个标准差；' +
      'beta 为负表示这项在你的数据里和总分反向。占比只按正的 beta 归一，' +
      '所以「0%」的意思是「这项在数据里没在往高分走」，不等于「它不重要」。样本 ' + st.n + ' 场。</p>';
    box.innerHTML = html;
  }

  /* ⑥ 相对你自己的基线（单场详情里）。renderDetail 会整块重写 detailBox，
   *   所以这里返回 HTML 而不是往某个节点里写。 */
  function baselineHtml(c) {
    var b = c.baseline;
    if (!b) return '';
    return '<div class="panel"><h3>这场比你自己平时<span class="dim" ' +
      'style="font-weight:400;font-size:12px"> 比的是你自己的分布，不是同场那几十人</span></h3>' +
      '<p class="hint">' + esc(b.headline) + '</p>' +
      '<table class="tbl-lite"><thead><tr><th class="l">项目</th><th>本场</th><th>你的常态</th>' +
      '<th>分位</th><th>标准化</th></tr></thead><tbody>' +
      b.items.map(function (x) {
        return '<tr><td class="l">' + esc(x.label) + '</td><td>' + x.value + '</td>' +
          '<td class="dim">' + x.avg + '</td>' +
          '<td>' + (x.pct == null ? '—' : '第 ' + x.pct + ' 分位') + '</td>' +
          '<td class="dim">' + (x.z == null ? '—' : (x.z > 0 ? '+' : '') + x.z + 'σ') + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="hint">对照口径：' + (b.basis === 'map'
        ? '同一张图（' + esc(b.mapName) + '）的 ' + b.n + ' 场'
        : '同图场次不足，改用全部 ' + b.n + ' 场') + '。你自己也在这口池子里，' +
      '场数小的时候分位会被往中间拉，所以「第 50 分位」比看上去更常见。</p></div>';
  }

  /* ============================================================
   * 胜率
   * ============================================================ */
  function renderWinRate(rep) {
    var s = rep.summary, w = rep.windows || {}, rs = rep.ratingStats, st = rep.streak || {};

    if (!s) {
      el('rateKpis').innerHTML = '';
      el('rateTable').innerHTML = empty('当前筛选下没有对局');
      el('winLossPanel').innerHTML = '';
      el('structurePanel').innerHTML = '';
      clearCharts(['chRating', 'chRatingRoll', 'chWinRoll', 'chRatingDist']);
      return;
    }

    el('rateKpis').innerHTML =
      kpi6([
        ['总场次', fmt(s.total), '', ''],
        ['总胜率', s.winRate, '%', s.winRate >= 50 ? 'good' : 'bad'],
        ['近 10 局', w.last10 ? w.last10.winRate : '—', '%',
          w.last10 && w.last10.winRate >= 50 ? 'good' : 'bad'],
        ['近 30 局', w.last30 ? w.last30.winRate : '—', '%',
          w.last30 && w.last30.winRate >= 50 ? 'good' : 'bad'],
        ['平均评分', rs ? rs.avg : '—', '', rs ? rateCls(rs.avg) : ''],
        ['评分中位数', rs ? rs.median : '—', '', '']
      ]) +
      '<div class="hint" style="margin:-6px 0 8px 2px">评分分布与极值</div>' +
      strip([
        ['最高评分', rs ? rs.max : '—', '', 'good'],
        ['最低评分', rs ? rs.min : '—', '', 'bad'],
        ['P25', rs ? rs.p25 : '—'],
        ['P75', rs ? rs.p75 : '—'],
        ['最长连胜', st.bestWin, ' 场', 'good'],
        ['最长连败', st.worstLose, ' 场', 'bad'],
        ['当前连胜/连败', (st.currentStreak || 0) + ' 场', st.currentWin ? ' 连胜' : ' 连败',
          st.currentWin ? 'good' : 'bad'],
        ['近 20 局', w.last20 ? w.last20.winRate : '—', '%'],
        ['近 50 局', w.last50 ? w.last50.winRate : '—', '%'],
        ['评分样本', rs ? (rs.lobbyBasis + ' 有名单 / ' + rs.benchBasis + ' 估算') : '—']
      ]);

    var rser = rep.ratingSeries || [];
    global.DFCharts.line('chRating',
      rser.map(function (x) { return x.label; }),
      rser.map(function (x) { return x.value; }), '评分', 'accent', { scale: true, area: true });

    if (rs) {
      global.DFCharts.line('chRatingRoll',
        rs.rolling10.map(function (x) { return x.label; }),
        rs.rolling10.map(function (x) { return x.v; }), '10局均分', 'green', { scale: true });
      global.DFCharts.vbar('chRatingDist',
        rs.buckets.map(function (b) { return b.range.split(' ')[0]; }),
        rs.buckets.map(function (b) { return b.count; }), 'accent', ' 局');
    }
    if (w.rolling10 && w.rolling10.length) {
      global.DFCharts.line('chWinRoll',
        w.rolling10.map(function (x) { return x.label; }),
        w.rolling10.map(function (x) { return x.v; }), '10局胜率 %', 'orange', { scale: true });
    }

    var winRows = [['近 10 局', w.last10], ['近 20 局', w.last20],
                   ['近 30 局', w.last30], ['近 50 局', w.last50]].map(function (o) {
      if (!o[1]) return '<tr><td class="l">' + o[0] + '</td><td colspan="5" class="dim">样本不足</td></tr>';
      return '<tr><td class="l">' + o[0] + '</td><td>' + o[1].n + '</td><td>' + o[1].win + '</td>' +
        '<td>' + o[1].lose + '</td><td style="color:' + wrColor(o[1].winRate) + '">' +
        o[1].winRate + '%</td><td>' + (o[1].ci
          ? o[1].ci.lo + '~' + o[1].ci.hi + '%' + (o[1].reliability === 'thin' ? ' 薄' : '')
          : '—') + '</td></tr>';
    }).join('');

    var distRows = rs ? rs.buckets.map(function (b) {
      return '<tr><td class="l">' + esc(b.range) + '</td><td>' + b.count + '</td><td>' + b.pct + '%</td></tr>';
    }).join('') : '';

    el('rateTable').innerHTML =
      '<div class="split" style="margin-bottom:0">' +
      '<div><h3>分窗口胜率</h3>' +
      '<table><thead><tr><th class="l">窗口</th><th>场次</th><th>胜</th><th>负</th><th>胜率</th>' +
      '<th>95% 区间</th></tr></thead>' +
      '<tbody>' + winRows + '</tbody></table></div>' +
      '<div><h3>评分分布</h3>' +
      (rs ? '<table><thead><tr><th class="l">评分区间</th><th>场次</th><th>占比</th></tr></thead>' +
        '<tbody>' + distRows + '</tbody></table>' : '<p class="hint">暂无评分数据</p>') +
      '</div></div>' +
      ciLine([['总胜率', s], ['近 10 局', w.last10], ['近 30 局', w.last30]]) +
      (rs ? '<p class="hint">评分体系：' + esc(rep.ratingWeightsText ||
        '得分 35% · 击杀 20% · KDA 25% · 占点（次） 10% · 救治 10%') + '。' +
        (rs.lobbyBasis ? rs.lobbyBasis + ' 场基于同局真实排名，' : '') +
        (rs.benchBasis ? rs.benchBasis + ' 场因缺少名单按固定基准估算。' : '') + '</p>' : '');

    renderWinLoss(rep);
    renderStructure(rep);
  }

  /* ============================================================
   * 战局列表
   * ============================================================ */
  function renderMatches(rows, opts) {
    var box = el('matchTable');
    opts = opts || {};
    var exN = rows.reduce(function (n, m) { return n + (m.excluded ? 1 : 0); }, 0);
    var sub = el('matchSub');
    if (sub) {
      sub.textContent = '点任意一行查看该场全场数据' +
        (exN ? ' · 灰显 ' + exN + ' 场已标记不纳入统计，不计入任何分析（在单场详情里可恢复）' : '');
    }
    /* ★ 计数必须在空态早退之前写：否则页内筛选归零时屏幕上留着上一次的数字 */
    var mc = el('matchCount');
    if (mc) {
      var total = opts.total == null ? rows.length : opts.total;
      mc.innerHTML = rows.length
        ? (rows.length < total
            ? '本页筛选出 <b>' + rows.length + '</b> / ' + total + ' 场'
            : '共 <b>' + rows.length + '</b> 场' + (rows.length > 500 ? '（表格只画最近 500 行）' : ''))
        : '<b>0</b> / ' + total + ' 场（本页筛选太窄）';
    }
    if (!rows.length) {
      box.innerHTML = empty(opts.poolSize
        ? '本地已采集 <b>' + opts.poolSize + '</b> 场，但当前筛选条件下没有匹配项。<br>试试把「模式」改成「全部」，或点上方「清除」去掉本页筛选。'
        : '还没有采集到对局数据，点击左下角「立即同步」。');
      return;
    }
    var head = '<thead><tr><th class="l">时间</th><th class="l">地图</th><th class="l">模式</th>' +
      '<th>评分</th><th>结果</th><th>击杀</th><th>死亡</th><th>助攻</th><th>KD</th>' +
      '<th title="' + esc(KPM.note) + '">' + KPM.label + '</th>' +
      '<th>得分</th><th>分均</th><th title="' + esc(OCC.note) + '">' + OCC.label + '</th>' +
      '<th>救治</th><th>干员</th><th>时长</th></tr></thead>';
    var body = rows.slice(0, 500).map(function (m) {
      var rt = opts.ratingOf ? opts.ratingOf(m) : null;
      return '<tr class="clickable' + (m.excluded ? ' row-excluded' : '') + '" data-rid="' + esc(m.room_id) + '">' +
        '<td class="l">' + esc((m.dt_event_time || '').slice(5, 16)) + '</td>' +
        '<td class="l">' + esc(m.map_name) + (m.side ? '-' + esc(m.side) : '') +
          (m.excluded ? ' <span class="tag tag-muted">已排除</span>' : '') +
          (m.is_competition ? ' <span class="tag tag-comp">比赛</span>' : '') +
          (m.watchedCount ? ' <span class="tag tag-watch">关注 ' + m.watchedCount + '</span>' : '') +
          (m.hasRoster === false ? ' <span class="tag tag-dim">缺名单</span>' : '') +
          (m.rosterGaps && m.rosterGaps.length ? ' <span class="tag tag-soft" title="' +
            esc('官方这场名单里「' + gapLabel(m.rosterGaps) + '」还没填完，下次同步会自动重抓') +
            '">名单不全</span>' : '') + '</td>' +
        '<td class="l dim">' + modeText(m) + '</td>' +
        '<td class="' + (rt != null ? rateCls(rt) : '') + '" style="font-weight:500">' +
          (rt != null ? rt : '—') + '</td>' +
        '<td class="' + (m.is_winner ? 'win-text' : 'lose-text') + '">' +
          (m.is_winner ? '胜' : '负') + (m.is_leave ? ' · 退' : '') + '</td>' +
        '<td>' + m.kill + '</td><td>' + m.death + '</td><td>' + m.assist + '</td>' +
        '<td>' + m.kd + '</td><td>' + kpmText(m) + '</td><td>' + fmt(m.score) + '</td>' +
        '<td>' + m.score_per_min + '</td><td>' + m.occupy + '</td><td>' + m.rescue + '</td>' +
        '<td>' + esc(m.force_name || '—') + '</td>' +
        '<td>' + Math.round(m.game_time / 60) + '分</td></tr>';
    }).join('');
    box.innerHTML = '<table>' + head + '<tbody>' + body + '</tbody></table>';
    Array.prototype.forEach.call(box.querySelectorAll('tr.clickable'), function (tr) {
      tr.addEventListener('click', function () {
        if (opts.onPick) opts.onPick(tr.getAttribute('data-rid'));
      });
    });
  }

  /* ============================================================
   * 单场详情
   * ============================================================ */
  /* 模式文案：指挥官是胜者为王的子集（手动标记），两者同时命中时并列显示。
   * 比赛 / 匹配同样是手动认定的一枚标记，跟指挥官并列而不是替换模式名 */
  function modeText(m) {
    if (!m) return '常规模式';
    var base = m.is_swtwr ? '胜者为王' : '常规模式';
    if (m.is_swtwr) base += m.is_competition ? ' · 比赛' : ' · 匹配';
    return m.is_commander ? base + ' · 指挥官' : base;
  }

  /* ★ 占点这一列的口径（界面侧唯一出处，表头 / 详情 / 阵营对比 / 设置页滑杆都读它）：
   *   官方 `occupy` 是**占领 · 防守据点的次数**（真库 41 场实测：战局列表 0~6、
   *   全场名单每人 0~12、四成人是 0），不是游戏结算面板里那个分值的「站点分」——
   *   两份接口都没有站点分字段，它只并进了总分 `score`。
   *   以前列头只写「占点」，使用者拿游戏里看到的分数来对，一对不上就成了"你算错了"。
   *   两份 CSV 表头在主进程 / 安卓宿主里够不到这里，只能写同名字面量，测试负责盯它们一致。 */
  var OCC = {
    label: '占点（次）', total: '总占点（次）', avg: '场均占点（次）', perMin: '次/分',
    note: '「占点（次）」是官方给的占领 · 防守据点的次数（一场通常个位数），' +
      '不是游戏结算里的「站点分」—— 站点分没有单独的字段，只并进了总分。'
  };

  /* ★ KPM 这一列的口径（与 OCC 同一条纪律：表头 / 详情 / 各统计表 / 两份 CSV 都读这一份）：
   *   KPM = 击杀 ÷ 时长（分钟），时长用官方每场自带的 game_time。
   *   为什么值得为它单开一列，而不是拿 KD 凑：真库 42 场 / 2402 人次实测，
   *   KPM 与 KD 的秩相关只有 0.867，每场按 KPM 排前五的人与按 KD 排前五的**只重合 56%**
   *   （平均名次位移 4.2 名）—— 两张榜排出来的不是同一批人。
   *   分母地板住在 core（KPM_MIN_SEC = 300 秒），界面只许读榜上带出来的 minMinutes。 */
  var KPM = {
    label: 'KPM', avg: 'KPM', perMin: '个/分',
    note: 'KPM = 每分钟击杀（击杀 ÷ 这一场的时长）。时长不足 5 分钟的人不进 KPM 榜：' +
      '真库里 13 秒 3 杀能算出 KPM 13.85，而打满一场的人只到 3 上下。'
  };

  /* 攻防这一格的口径（界面只念，判定在 core 的 sideOf / campOf）：
   * 官方字段里没有"进攻/防守"，能带出它的只有名单里那枚阵营编号 color；
   * ★ 2026-09-29 起不再限定模式（他原话「全部模式包括胜者为王 也要看进攻或者是防守」），
   *   但这句话必须把"哪些是核过的、哪些是推定的"分开说，不能一律说成实测。 */
  var SIDE_NOTE = '进攻 / 防守：官方接口没有这个字段，它由名单里的阵营编号推 —— 编号 1 = 进攻方、2 = 防守方。' +
    '这条在「攻防」「占领」两类模式上是使用者报的四场地报真值全对核出来的；' +
    '其它模式（含胜者为王）是同一枚字段的推定（量过：本机库里三种模式的名单里 color 都恰好是 1、2 两组）。' +
    '哪一场的身份对不上游戏里看到的，改的是 core 里那一颗字面量。';

  /* 攻防胜率那一格（地图明细表）：两个桶并排画在同一格里，不再各开一列 ——
   * 上一轮给 KPM 单开一列时把 1180 那档挤破过版（探针真报红），一格两数是零代价的写法。
   * ★ 不足 MIN_TIP_SAMPLE 的桶照样给数但压暗，并在 title 里说清括号是场次：
   *   直接藏掉会让人读成「这张图我没打过进攻」，那是另一种假。 */
  function sideTd(m) {
    var a = m.atk, d = m.def;
    if (!a && !d) return '<td class="dim">—</td>';
    function one(label, s) {
      if (!s) return label + ' —';
      return '<span' + (s.total < MIN_TIP_SAMPLE ? ' class="dim"' : '') + '>' + label + ' ' +
        s.winRate + '%（' + s.total + '）</span>';
    }
    return '<td style="white-space:nowrap">' + one('攻', a) + ' / ' + one('守', d) + '</td>';
  }

  /* 总对照：同一批对局里「打进攻方时」与「打防守方时」的胜率。
   * ★ 方向那句正文（包括「看不出方向」那句）由 core 的 sideSplit 算好，界面一个字都不判断。 */
  function sideSummaryHtml(sp) {
    if (!sp) return '';
    /* 两侧都空 ≠ 这块不画。一整批都是胜者为王的人，最容易被"没有这一栏"读成"软件没做/我漏了"，
     * 所以这里照样说一句为什么没有 —— 只念 core 那句，界面不另判一遍。 */
    if (!sp.attack && !sp.defend) {
      return '<div class="panel"><h3>进攻 / 防守 的胜率对照</h3>' +
        '<p class="hint">' + esc(sp.headline) + '</p>' +
        '<p class="hint">' + esc(SIDE_NOTE) + '</p></div>';
    }
    var rows = [['进攻方', sp.attack], ['防守方', sp.defend]].map(function (p) {
      var s = p[1];
      return '<tr><td class="l">' + p[0] + '</td>' +
        '<td>' + (s ? s.total : '—') + '</td><td>' + (s ? s.win : '—') + '</td>' +
        '<td>' + (s ? s.winRate + '%' : '—') + '</td>' +
        '<td class="l dim">' + (s ? esc(ciPlain(s)) : '') + '</td></tr>';
    }).join('');
    return '<div class="panel"><h3>进攻 / 防守 的胜率对照</h3>' +
      '<p class="hint">' + esc(sp.headline) + '</p>' +
      '<table class="mini-table"><thead><tr><th class="l">身份</th><th>场次</th><th>胜</th>' +
      '<th>胜率</th><th class="l">95% 区间</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      (sp.noSide ? '<p class="hint">另有 ' + sp.noSide + ' 场没有「进攻 / 防守」这个概念' +
        '（胜者为王那一类），不计入这一对照。</p>' : '') +
      '<p class="hint">' + esc(SIDE_NOTE) + '</p></div>';
  }

  /* ★ 每张地图自己的攻守对照（他 2026-09-29 点名：「我不单单只看进攻和防守的胜率对照，我要看每张地图的」）。
   * 只列两边都打过的图；方向那句由 core 判（该图两侧 Wilson 区间互不重叠才给），界面一个字都不判断。 */
  function sideBucket(s) {
    if (!s || !s.total) return '—';
    return s.total + ' 场 · ' + s.winRate + '%' + ciPlain(s);
  }
  function mapSidesHtml(list) {
    var rows = list || [];
    if (!rows.length) {
      return '<div class="panel"><h3>每张地图的进攻 / 防守</h3><p class="hint">' +
        '现在没有任何一张图是「进攻、防守两边都打过」的，所以逐张比不了。' +
        '多打几场（或把胜者为王也算进来）这张表自己就会长出来。</p>' +
        '<p class="hint">' + esc(SIDE_NOTE) + '</p></div>';
    }
    return '<div class="panel"><h3>每张地图的进攻 / 防守</h3>' +
      '<p class="hint">同一张图不同模式分开算；下面只列<strong>两边都打过</strong>的那几张。' +
      '「说法」那一栏只在一张图两侧的胜率区间互不重叠时才给方向，否则明说当前场次下看不出来。</p>' +
      '<table class="mini-table"><thead><tr><th class="l">地图</th><th class="l">模式</th>' +
      '<th>进攻</th><th>防守</th><th class="l">说法</th></tr></thead><tbody>' +
      rows.map(function (x) {
        return '<tr><td class="l">' + esc(x.mapName) + '</td>' +
          '<td class="l dim">' + esc(x.mode) + '</td>' +
          '<td>' + sideBucket(x.attack) + '</td>' +
          '<td>' + sideBucket(x.defend) + '</td>' +
          '<td class="l' + (x.decisive ? (x.diff > 0 ? ' win-text' : ' lose-text') : ' dim') + '">' +
          esc(x.note) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="hint">' + esc(SIDE_NOTE) + '</p></div>';
  }

  /* 设置页那块「本机字典」（他 2026-09-29 点名：「用户可以把未知地图编辑成想要的地图名，
   * 本机字典也可以查看或编辑」）。这一层只排版：编号怎么洗、名字能不能用、历史场次跟着改名，
   * 全在 core.maps + 壳里的 editMapName 那边 —— 界面不许自己判一个"合法"出来。
   * 改名走下面那一对手动输入：表里每行的「改名」只负责把编号与现名填进去（点一下就填好），
   * 于是移动端不必依赖 prompt()（Electron 根本不支持，安卓 WebView 也得看宿主脸色）。 */
  var SRC_LABEL = { user: '我改的', builtin: '抓包实证', learned: '本机学到' };
  function dictSourceText(s) { return SRC_LABEL[s] || '还不认识'; }
  function mapDictHtml(d) {
    if (!d || !d.ok) {
      return '<p class="hint">问不到本机字典（宿主没有回话）。改名这一条先别试，重启软件再看。</p>';
    }
    var usage = d.usage || [], edits = d.userEdits || [];
    var unknown = usage.filter(function (x) { return !x.source; });
    var html = '<div class="row"><span class="row-label">字典计数</span><span class="hint" style="margin:0;flex:1">' +
      '内置 ' + d.builtin + ' 张 · 本机学到 ' + d.learned + ' 张 · 我改的 ' + d.user + ' 张' +
      (unknown.length ? ' · 打过的图里还有 ' + unknown.length + ' 个编号不认识' : '') +
      '</span></div>';

    html += '<p class="hint">名字谁在前谁说话：<b>我改的 &gt; 内置（抓包实证）&gt; 本机学到</b>。' +
      '所以「更新地图名」永远盖不掉你自己起的名字。改名只改这一台机器上的<b>显示</b>：' +
      '不动官方编号，也不参与任何统计口径 —— 胜负、模式、进攻/防守都跟名字无关，' +
      '把一张图改成什么都不叫的名字，数字一个字都不会变。</p>';

    if (edits.length) {
      html += '<table class="mini-table"><thead><tr><th>编号</th><th class="l">现在显示</th>' +
        '<th class="l">不改的话本来叫</th><th class="l">操作</th></tr></thead><tbody>' +
        edits.map(function (x) {
          return '<tr><td>' + esc(x.id) + '</td><td class="l"><b>' + esc(x.name) + '</b></td>' +
            '<td class="l dim">' + esc(x.base) + '</td>' +
            '<td class="l"><button class="btn btn-sm" data-dict-act="clear" data-dict-id="' + esc(x.id) + '">还原</button></td></tr>';
        }).join('') + '</tbody></table>';
    }

    if (!usage.length) {
      html += '<p class="hint">这个号还没打过任何一张图，所以字典里没有可调名的对象 —— ' +
        '先用下面那一行按编号命名也行（等打过之后它自己会出现在表里）。</p>';
    } else {
      html += '<table class="mini-table"><thead><tr><th class="l">地图</th><th>编号</th>' +
        '<th class="l">名字哪来的</th><th>场次</th><th class="l">操作</th></tr></thead><tbody>' +
        usage.map(function (x) {
          return '<tr><td class="l' + (x.source ? '' : ' win-text') + '">' + esc(x.name) + '</td>' +
            '<td>' + esc(x.id) + '</td>' +
            '<td class="l dim">' + dictSourceText(x.source) + '</td>' +
            '<td>' + x.count + '</td>' +
            '<td class="l"><button class="btn btn-sm" data-dict-act="edit" data-dict-id="' + esc(x.id) +
            '" data-dict-name="' + esc(x.source ? x.name : '') + '">改名</button></td></tr>';
        }).join('') + '</tbody></table>';
    }

    html += '<div class="row" style="margin-top:10px">' +
      '<span class="row-label">按编号命名</span>' +
      '<input class="input" id="dictMapId" type="text" inputmode="numeric" autocomplete="off" placeholder="编号，如 611" style="width:110px;flex:0 0 auto">' +
      '<input class="input" id="dictMapName" type="text" autocomplete="off" spellcheck="false" placeholder="想要的名字（留空 = 还原）" style="flex:1;min-width:0">' +
      '<button class="btn btn-sm" id="dictSave">保存</button></div>' +
      '<p class="hint">编号是官方战绩接口里那个数字（表里每一行都写着）。名字最长 40 个字，' +
      '不能带尖括号与控制字符；<b>留空保存就是把这一条还原</b>。' +
      (d.unknown ? '现在还有 ' + d.unknown + ' 场挂着「未知地图」，把对应编号命名之后它们当场就有名字。' : '') +
      '</p>';
    return html;
  }

  /* 交手档案里那张逐项对照：数值全部来自 core 的 encounterDetail.compare ——
   * 每一列都是「累计量 ÷ 累计时长」，界面不许把每场的比值再求平均（短场次会把平均拽飞）。 */
  function compareHtml(c) {
    if (!c || !c.him || !c.me) return '';
    var H = c.him, M = c.me;
    function num(v) { return v == null ? '<span class="dim">—</span>' : fmt(v); }
    function row(label, hv, mv, thin) {
      return '<tr><td class="l">' + label + '</td><td>' + hv + '</td><td>' + mv + '</td>' +
        (thin ? '<td class="l dim">累计时长不足 ' + c.minMinutes + ' 分钟，按口径不给数</td>'
          : '<td class="l dim"></td>') + '</tr>';
    }
    var thin = H.thin || M.thin;
    return '<div class="panel"><h3>逐项对照（同场累计）</h3>' +
      '<table class="mini-table"><thead><tr><th class="l">项目</th><th>他</th><th>你</th>' +
      '<th class="l"></th></tr></thead><tbody>' +
      row('击杀数', H.kills, M.kills) +
      row('死亡数', H.deaths, M.deaths) +
      row('场均击杀', H.avgKill, M.avgKill) +
      row('场均死亡', H.avgDeath, M.avgDeath) +
      row('KD', num(H.kd), num(M.kd)) +
      row('KPM（每分钟击杀）', num(H.kpm), num(M.kpm), thin) +
      row('分均得分', num(H.spm), num(M.spm), thin) +
      row('累计时长（分）', H.minutes, M.minutes) +
      '</tbody></table><p class="hint">' + esc(c.headline) + '</p></div>';
  }

  /* 渲染层这一侧的 KPM 只许有这一个算法（core 那侧住在 analysis 的 kpmOf/matchMetric，
   * 两边都是「击杀 ÷（game_time/60）」，但渲染层永不加载 core/*，所以这里必须自带一份）。
   * 时长缺失就回「—」而不是 0 —— 0 会被读成"这一场一个人都没杀"，那是假数。
   * ★ 不许再出现第二处 `kill / (game_time / 60)`：isolation 有一条红线数着它。 */
  function kpmText(v) {
    if (!v || !(v.game_time > 0)) return '—';
    return Math.round(((v.kill || 0) / (v.game_time / 60)) * 100) / 100;
  }
  /* 名单里那一格用 core 已经算好的 p.kpm（它带了地板标记），不再现算第二遍 */
  function kpmCell(p) {
    if (p.kpm == null) return '—';
    return p.kpm + (p.kpmThin ? ' *' : '');
  }

  /* 名单里没填完的那几列：core 给的是字段名，界面上一律念中文名（徽标与详情同一份） */
  var GAP_COL_NAME = { kill: '击杀', death: '死亡', assist: '助攻', score: '得分',
    occupy: OCC.label, rescue: '救治' };
  function gapLabel(cols) {
    return (cols || []).map(function (f) { return GAP_COL_NAME[f] || f; }).join('、');
  }

  /* 本局标注：只认用户手动标记，所以开关放在单场详情页
   * 指挥官与比赛都是「胜者为王」里的概念 —— 常规对局不提供这两个标记（store 里也挡一层） */
  function flagBar(m) {
    var cmd = m.is_commander ? 1 : 0, ex = m.excluded ? 1 : 0, cp = m.is_competition ? 1 : 0;
    return '<div class="flag-bar">' +
      (m.is_swtwr
        ? '<button class="btn btn-sm' + (cmd ? ' btn-on' : '') + '" data-act="commander" data-on="' + (cmd ? 0 : 1) + '">' +
          (cmd ? '✓ 本场我是指挥官（点击取消）' : '标记本场为指挥官') + '</button>' +
          '<button class="btn btn-sm' + (cp ? ' btn-on' : '') + '" data-act="competition" data-on="' + (cp ? 0 : 1) + '">' +
          (cp ? '✓ 本场是比赛（点击取消）' : '标记本场为比赛对局') + '</button>'
        : '') +
      '<button class="btn btn-sm' + (ex ? ' btn-on' : '') + '" data-act="excluded" data-on="' + (ex ? 0 : 1) + '">' +
        (ex ? '✓ 本场不纳入统计（点击恢复）' : '本场不纳入统计') + '</button>' +
      (ex
        ? '<div class="flag-note">本场已从胜率、战局总览、兵种表现、对手队友等一切分析中剔除；战局列表仍会保留（灰显 + 已排除），随时可以恢复。' +
          (cp ? '<br>这一场同时被标成了比赛，但「不纳入统计」排在前面：切到「比赛」或「匹配」都不会出现它，先去掉不纳入才计入。' : '') +
          '</div>'
        : '<div class="flag-note dim">' + (m.is_swtwr
          ? (cp
            ? '已标为比赛对局：把顶部「对局」切到「比赛」，胜率、趋势、地图这些统计就只算你标过的这些局；切到「匹配」则只算没标的。'
            : '标记指挥官后，本场会同时计入「胜者为王」和「指挥官」两个筛选，战局本身仍只有一条记录。'
          ) + '<br>「比赛对局」全靠你手动认定（官方字段里没有任何能认出比赛的东西，实测过），点一次即生效，再点一次回到「匹配」。'
          : '指挥官与比赛都是胜者为王模式里的概念，本场为常规对局，不提供这两个标记。') + '</div>') +
      '</div>';
  }

  function renderDetail(c) {
    var box = el('detailBox');
    if (!c || !c.match) { box.innerHTML = empty('请选择一场对局'); return; }
    var m = c.match, rt = c.rating || {};
    var modeTxt = modeText(m);

    /* —— 顶部：本局结果 —— */
    var head = '<div class="panel">' +
      '<h3>' + esc((m.dt_event_time || '').slice(0, 16)) + ' · ' + esc(m.mapName) + (m.side ? ' · ' + esc(m.side) : '') +
      ' · <span class="' + (m.is_winner ? 'win-text' : 'lose-text') + '">' +
      (m.is_winner ? '胜利' : '失败') + '</span>' +
      '<span class="dim" style="font-weight:400;font-size:12px"> · ' + modeTxt +
      (m.is_leave ? ' · 中途退出' : '') +
      (m.force_name ? ' · ' + esc(m.force_name) : '') + '</span></h3>' +
      kpi6([
        ['单局评分', rt.value, '', rateCls(rt.value)],
        ['击杀', m.kill], ['死亡', m.death], ['助攻', m.assist],
        ['KPM', kpmText(m), '', 'accent'], ['KD', m.kd]
      ]) +
      strip([
        ['得分', fmt(m.score)],
        ['KDA', m.kda],
        ['分均得分', m.score_per_min],
        [OCC.label, m.occupy],
        ['救治', m.rescue],
        ['占点效率', (m.game_time ? Math.round(m.occupy / (m.game_time / 60) * 100) / 100 : 0), OCC.perMin],
        ['分均救治', (m.game_time ? Math.round(m.rescue / (m.game_time / 60) * 100) / 100 : 0), '/分'],
        ['时长', Math.round(m.game_time / 60), ' 分'],
        ['干员', esc(m.force_name || '—')],
        ['数据来源', rt.basis === 'lobby' ? '同局排名' : '基准估算']
      ]) +
      flagBar(m) +
      '</div>';

    /* ★ 这一场给不出"同局对比"有两种，必须分开说，且都要在解引用 rk.* 之前拦下来：
     *   ① 名单压根没抓到（roster < 5）—— 下次同步会自动补采；
     *   ② 名单抓到了、但里面找不到本机这个号（c.meMissing：数据包导入的号、只读号最容易走到这一支）。
     *   以前只拦了 ①，② 一路走到下面 rk.score 就整个详情页崩成骨架屏（真 Electron 里实测到的）。 */
    if (!c.ranks || !c.roster || c.roster < 5) {
      box.innerHTML = head + baselineHtml(c) +
        '<div class="split">' +
        '<div class="panel"><h3>同局对比</h3>' +
        empty(c.meMissing
          ? '这一场的全场名单里找不到本机这个账号（名单是 ' + c.roster + ' 人的那一份，多半来自别人导出的数据包）。<br>' +
            '同局排名、各项百分位与阵营合计都要拿你自己那一行去比，比不了就不硬凑 —— ' +
            '上面这一场自身的击杀、得分、占点那些数不受影响，照常算。'
          : '这一场还没有抓到全场名单。<br>只要它还在官方最近 5 页（约 36 场）内，点「立即同步」就会自动补采。') +
        '</div>' +
        '<div class="panel"><h3>小贴士</h3>' + tipsHtml(c.tips) + '</div>' +
        '</div>';
      return;
    }

    var rk = c.ranks, d = c.diffs;
    /* ★ 名单里哪些列不能信由 core 判（gaps）：官方两份接口填列有先后，半份名单算出来的
     *   "你排第 78"是假数。凡踩在这些列上的排名、榜单、阵营合计一律画「—」，并把原因写在面板里。 */
    var gaps = c.rosterGaps || [];
    function untrusted(col) { return gaps.indexOf(col) >= 0; }
    function rankCell(r) { return !r || r.rank == null ? '—' : r.rank + ' / ' + c.roster; }
    function gapCell(col, v) { return untrusted(col) ? '—' : v; }
    var gapNote = gaps.length
      ? '<p class="hint">这一场官方名单里的「' + gapLabel(gaps) +
        '」列还没填完（上面「你的数值」用的是战局列表给的那一份），' +
        '所以同局排名、救治榜与阵营合计里涉及它的项一律留空 —— 下次同步会自动重抓这一场。</p>'
      : '';

    /* —— 同局对比 —— */
    var rankHtml = kpiCards([
      ['全场人数', c.roster, ''],
      ['得分排名', rankCell(rk.score), '', 'accent'],
      ['得分超过', rk.score.pct == null ? '—' : rk.score.pct, '%', 'accent'],
      ['击杀排名', rankCell(rk.kill), ''],
      ['KDA 排名', rankCell(rk.kda), ''],
      ['救治排名', rankCell(rk.rescue), ''],
      ['占点排名', rankCell(rk.occupy), '']
    ]);
    var rankTable = '<h3 style="margin-top:18px">各项排名百分位</h3>' +
      '<table class="mini-table"><thead><tr><th class="l">项目</th><th>排名</th><th>超过全场</th>' +
      '<th>你的数值</th><th>全场人均</th></tr></thead><tbody>' +
      [['得分', rk.score, fmt(m.score), fmt(d.lobbyAvgScore)],
       ['击杀', rk.kill, m.kill, r2s(d.lobbyAvgKill)],
       ['KDA', rk.kda, m.kda, r2s(d.lobbyAvgKda)],
       ['救治', rk.rescue, m.rescue, r2s(d.lobbyAvgRescue)],
       [OCC.label, rk.occupy, m.occupy, r2s(d.lobbyAvgOccupy)]]
      .map(function (x) {
        return '<tr><td class="l">' + x[0] + '</td><td>' + (x[1].rank == null ? '—' : x[1].rank) + '</td>' +
          '<td style="color:' + (x[1].pct == null ? '' :
            (x[1].pct >= 50 ? 'var(--green)' : 'var(--red)')) + '">' +
          (x[1].pct != null ? x[1].pct + '%' : '—') + '</td>' +
          '<td>' + x[2] + '</td><td class="dim">' + x[3] + '</td></tr>';
      }).join('') + '</tbody></table>';

    /* —— 分差 —— */
    var diffTable = '<table class="mini-table"><thead><tr><th class="l">对比项</th>' +
      '<th>你 − 均值</th><th>对比方均值</th></tr></thead><tbody>' +
      [['得分 vs 全场人均', d.vsLobbyScore, fmt(d.lobbyAvgScore)],
       ['得分 vs 我方人均', d.vsTeamScore, fmt(d.teamAvgScore)],
       ['得分 vs 对方人均', d.vsEnemyScore, fmt(d.enemyAvgScore)],
       ['击杀 vs 全场人均', d.vsLobbyKill, r2s(d.lobbyAvgKill)],
       ['KDA vs 全场人均', d.vsLobbyKda, r2s(d.lobbyAvgKda)],
       ['救治 vs 全场人均', d.vsLobbyRescue, r2s(d.lobbyAvgRescue)],
       [OCC.label + ' vs 全场人均', d.vsLobbyOccupy, r2s(d.lobbyAvgOccupy)]]
      .map(function (r) {
        var v = r[1];
        return '<tr><td class="l">' + r[0] + '</td>' +
          '<td style="color:' + (v > 0 ? 'var(--green)' : (v < 0 ? 'var(--red)' : 'inherit')) + '">' +
          signed(v) + '</td><td class="dim">' + r[2] + '</td></tr>';
      }).join('') + '</tbody></table>';

    /* —— 阵营对比 —— */
    var sideRows = c.sides.map(function (s) {
      return '<tr' + (s.isMine ? ' style="font-weight:500"' : '') + '>' +
        '<td class="l">' + (s.isMine ? '我方' : '对方') + (s.side ? ' · ' + s.side : '') + (s.win ? '（胜）' : '（负）') + '</td>' +
        '<td>' + s.players + '</td><td>' + gapCell('kill', fmt(s.kill)) + '</td>' +
        '<td>' + fmt(s.death) + '</td>' +
        '<td>' + s.kd + '</td><td>' + gapCell('kill', s.kpm) + '</td>' +
        '<td>' + gapCell('score', fmt(s.score)) + '</td>' +
        '<td>' + gapCell('score', fmt(s.avgScore)) + '</td>' +
        '<td>' + gapCell('rescue', fmt(s.rescue)) + '</td>' +
        '<td>' + gapCell('occupy', fmt(s.occupy)) + '</td></tr>';
    }).join('');

    /* —— 阵营与攻防那两格 ——
     * 判定全在 core（campOf / sideOf，唯一出处还是那条 p.color === me.color），界面只念字。
     * ★ #88：以前这一格写「我方（胜）」—— 五字带全角括号，在四张并排的小榜里被挤成**两行**。
     *   现在拆成两格各两字（我方/对方、进攻/防守），胜负与原始编号收进 title，
     *   配合 .camp 的 nowrap，任何宽度都只许一行。
     * ★ 攻防这一格只在**有攻防之分的模式**里有字（core 给空串就画「—」）：
     *   胜者为王没有进攻方一说，硬贴一个就是编数。 */
    function campCell(p) {
      if (!p.campLabel) return '<td class="camp">—</td>';
      return '<td class="camp ' + (p.campMine ? 'camp-mine' : 'camp-out') + '" title="' +
        esc('官方名单给的阵营编号 ' + p.campId +
          '。这一场' + (p.campMine ? '我方' : '对方') + (p.campWin ? '胜' : '负') +
          '（官方名单不返回玩家级胜负，胜负是拿这一场我方的结果推的）') +
        '">' + esc(p.campLabel) + '</td>';
    }
    function sideCell(p) {
      return '<td class="camp">' + (p.campSide ? esc(p.campSide) : '—') + '</td>';
    }
    /* 行上的颜色：「你」是那抹 accent（蓝），已关注单独一色（橙）——
     * 使用者点名的就是这两色不许撞，撞了"高亮已关注"等于没高亮。 */
    function rowCls(me, p) {
      return me ? ' class="row-me"' : (p.watched ? ' class="row-watched"' : '');
    }

    /* —— 小榜（得分 / 击杀 / 救治 / KPM）——
     * 只列前 6 名；若「你」不在前 6，会在末尾补一行「你的位置」，
     * 保证任何名次都能看到自己，而不是被截断掉。 */
    var TOP_N = 6;
    var boards = c.boards || {
      score: { list: c.topScore || [], myRank: -1, total: c.roster },
      kill: { list: c.topKill || [], myRank: -1, total: c.roster },
      rescue: { list: c.topRescue || [], myRank: -1, total: c.roster }
    };
    function miniBoard(board, title, key, unit) {
      if (!board) {
        return '<div class="panel"><h3>' + title + '</h3>' +
          empty('这一列本场没有可信数据（原因见「同局对比」里的说明）') + '</div>';
      }
      if (!board.list || !board.list.length) {
        return '<div class="panel"><h3>' + title + '</h3>' + empty('暂无数据') + '</div>';
      }
      var list = board.list;
      function row(p, rank) {
        var me = c.me && p.vopenid === c.me.vopenid;
        return '<tr' + rowCls(me, p) + '>' +
          '<td>' + rank + '</td><td class="l">' + esc(p.name || '（匿名）') +
          (me ? ' · 你' : '') + '</td>' + campCell(p) + sideCell(p) +
          '<td>' + (key === 'kpm' ? kpmCell(p) : fmt(p[key])) + '</td>' +
          '<td>' + p.kill + '/' + p.death + '/' + p.assist + '</td></tr>';
      }
      var rows = list.slice(0, TOP_N).map(function (p, i) { return row(p, i + 1); }).join('');
      var myRank = board.myRank;
      var cut = myRank > TOP_N;          // 我掉出前 6，需要单独补一行
      if (cut) {
        rows += '<tr class="row-sep"><td colspan="6">⋯ 你的位置 ⋯</td></tr>' +
          row(list[myRank - 1], myRank);
      }
      var foot = myRank > 0
        ? '你：第 <b>' + myRank + '</b> 名 / 共 ' + board.total + ' 人' +
          (cut ? '' : '（已在前 ' + TOP_N + '）')
        : (board.myThin ? '你这一场打满 ' + Math.round((c.me.game_time || 0) / 60) +
            ' 分钟，不足 ' + board.minMinutes + ' 分钟，按口径没进这张榜'
            : '你不在本场名单中');
      /* KPM 榜的门槛是 core 定的（KPM_MIN_SEC），这里只念它带出来的两个数：
       * 门槛多少分钟、这一场被挡在榜外几个人。不报人数就等于"全场 52 人的榜"其实只排了 40 人。 */
      if (board.thin) {
        foot += '　<span class="dim">另有 ' + board.thin + ' 人时长不足 ' +
          board.minMinutes + ' 分钟，没进这张榜</span>';
      }
      return '<div class="panel"><h3>' + title +
        ' <span class="dim" style="font-weight:400;font-size:12px">前 ' + TOP_N + ' 名</span></h3>' +
        '<table class="mini-table"><thead><tr><th>#</th><th class="l">玩家</th>' +
        '<th>阵营</th><th title="' + esc(SIDE_NOTE) + '">攻防</th>' +
        '<th title="' + esc(KPM.note) + '">' + (key === 'kpm' ? KPM.label : unit) +
        '</th><th>K/D/A</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<p class="hint board-foot">' + foot + '</p></div>';
    }

    /* —— 完整名单 ——
     * 「关注」按钮带的是主进程身份索引算出的聚合键，界面只是原样传回；
     * 只有当局临时编号的人（watchable=false）不给按钮，避免存下一个凭空捏造的"熟人" */
    var fullRoster = '<div class="panel"><h3>全场完整名单（' + c.roster + ' 人）</h3>' +
      '<table><thead><tr><th>#</th><th class="l">玩家</th><th>阵营</th>' +
      '<th title="' + esc(SIDE_NOTE) + '">攻防</th>' +
      '<th>击杀</th><th>死亡</th><th>助攻</th><th>KDA</th>' +
      '<th title="' + esc(KPM.note) + '">' + KPM.label + '</th><th>得分</th>' +
      '<th title="' + esc(OCC.note) + '">' + OCC.label + '</th><th>救治</th><th></th></tr></thead><tbody>' +
      c.allPlayers.map(function (p, i) {
        var me = c.me && p.vopenid === c.me.vopenid;
        var kda = p.death ? Math.round((p.kill + p.assist) / p.death * 100) / 100 : (p.kill + p.assist);
        var act = (!me && p.watchable && p.watchKey)
          ? '<button class="btn btn-sm' + (p.watched ? ' btn-on' : '') + ' row-watch" data-act="watch"' +
            ' data-key="' + esc(p.watchKey) + '" data-name="' + esc(p.name || '') + '"' +
            ' data-openid="' + esc(p.vopenid || '') + '" data-on="' + (p.watched ? 0 : 1) + '">' +
            (p.watched ? '✓ 已关注' : '关注') + '</button>'
          : (p.watched ? '<span class="tag tag-watch">已关注</span>' : '');
        return '<tr' + rowCls(me, p) + '>' +
          '<td>' + (i + 1) + '</td><td class="l">' + esc(p.name || '（匿名）') +
          (me ? ' · 你' : '') + '</td>' + campCell(p) + sideCell(p) +
          '<td>' + p.kill + '</td><td>' + p.death + '</td><td>' + p.assist + '</td>' +
          '<td>' + kda + '</td><td>' + kpmCell(p) + '</td><td>' + fmt(p.score) + '</td>' +
          '<td>' + gapCell('occupy', p.occupy) + '</td><td>' + gapCell('rescue', p.rescue) + '</td>' +
          '<td class="l">' + act + '</td></tr>';
      }).join('') + '</tbody></table>' +
      /* ★ 带 * 的那一格 = 这人时长不足 core 那道地板（KPM 榜把他挡在榜外是同一原因），
       *   数照给但不许跟打满一场的人并排比。这一句必须跟着表走，否则星号没人认得。 */
      '<p class="hint">' + esc(KPM.note) + '</p>' +
      '<p class="hint">关注用的是能跨局识别的账号标识；只显示当局临时编号的玩家无法关注——' +
      '那个编号每局重新分配，存下来只会得到一个凭空捏造的「熟人」。</p></div>';

    box.innerHTML = head + baselineHtml(c) +
      '<div class="split">' +
        '<div class="panel"><h3>同局对比</h3>' + rankHtml + rankTable + gapNote + '</div>' +
        '<div class="panel"><h3>小贴士</h3>' + tipsHtml(c.tips) +
          '<h3 style="margin-top:20px">分差明细</h3>' + diffTable + '</div>' +
      '</div>' +
      '<div class="panel"><h3>阵营对比</h3>' +
        '<table><thead><tr><th class="l">阵营 / 攻防</th><th>人数</th><th>总击杀</th><th>总死亡</th>' +
        '<th>KD</th><th title="' + esc(KPM.note) + '">' + KPM.label + '</th>' +
        '<th>总分</th><th>人均分</th><th>总救治</th>' +
        '<th title="' + esc(OCC.note) + '">' + OCC.total + '</th></tr></thead>' +
        '<tbody>' + sideRows + '</tbody></table>' + gapNote +
        '<p class="hint">' + esc(OCC.note) + '</p></div>' +
      '<div class="grid-3">' +
        miniBoard(boards.kpm, '全场 KPM 榜', 'kpm', KPM.label) +
        miniBoard(boards.score, '全场得分榜', 'score', '得分') +
        miniBoard(boards.kill, '全场击杀榜', 'kill', '击杀') +
        miniBoard(boards.rescue, '全场救治榜', 'rescue', '救治') +
      '</div>' +
      fullRoster;
  }

  function r2s(v) { return v == null ? '—' : (Math.round(v * 100) / 100); }

  /* ============================================================
   * 地图分析（全部本地统计）
   * ============================================================ */
  function renderMaps(rep) {
    var maps = rep.maps || [];
    var modeTag = rep.filterModeLabel || '全部模式';
    var emptyTipBox = document.getElementById('mapTips');
    if (!maps.length) {
      el('mapBox').innerHTML = empty('当前筛选（' + modeTag + '）下没有对局');
      clearCharts(['chMapRate', 'chMapRating']);
      if (emptyTipBox) emptyTipBox.innerHTML = '';
      return;
    }
    var summary = rep.summary;
    /* 排名只从满门槛的地图里挑：1 场 100% 不算「最擅长」，1 场 0% 也不算短板
     * （真机实测过「最擅长：刀锋-占领 · 1 场胜率 0%」这种病句）。不足门槛的仍照常列进明细表 */
    var solidMaps = maps.filter(function (m) { return m.total >= MIN_TIP_SAMPLE; });
    var best = solidMaps.slice().sort(function (a, b) { return b.winRate - a.winRate; })[0];
    var worst = solidMaps.slice().sort(function (a, b) { return a.winRate - b.winRate; })[0];
    var bestRate = solidMaps.slice().sort(function (a, b) { return b.rating - a.rating; })[0];

    var tips = [];
    if (solidMaps.length >= 2 && worst !== best) {
      tips.push({
        level: worst.winRate < 40 ? 'warn' : 'info',
        title: '短板地图（' + modeTag + '）：' + worst.mapName + ' · ' + worst.mode +
          '（胜率 ' + worst.winRate + '%）',
        text: worst.total + ' 场' + ciPlain(worst) + '，比最好的 ' + best.mapName + ' · ' + best.mode +
          '（' + best.winRate + '%' + ciPlain(best) + '）低 ' + r2s(best.winRate - worst.winRate) +
          ' 个百分点。'
      });
    }
    if (bestRate) {
      tips.push({
        level: 'good', title: '个人数据最好（' + modeTag + '）：' + bestRate.mapName + ' · ' + bestRate.mode,
        text: '平均评分 ' + bestRate.rating + '，KD ' + bestRate.kd + '，' +
          bestRate.total + ' 场胜率 ' + bestRate.winRate + '%。' +
          '这条只看你自己的评分，不代表这张图更容易赢。'
      });
    }
    tips.push({
      level: 'info', title: '样本说明（' + modeTag + '）',
      text: '当前筛选：' + modeTag + ' · 共 ' + (summary ? summary.total : 0) +
        ' 场。全部指标由本软件实时统计，与官方统计口径无关；同一张图不同模式分开排名。' +
        '不足 ' + MIN_TIP_SAMPLE + ' 场的地图只列在下面的明细表里，不参与上面这些结论——' +
        '官方只保留最近约 36 场，样本越多越准确。'
    });

    var head = '<thead><tr><th class="l">地图</th><th class="l">模式</th><th>场次</th>' +
      '<th>胜率</th><th>评分</th><th>KD</th><th title="' + esc(KPM.note) + '">' + KPM.label +
      '</th><th>场均得分</th><th>分均得分</th>' +
      '<th title="' + esc(SIDE_NOTE) + '">攻防胜率</th>' +
      '<th>' + OCC.avg + '</th><th>场均救治</th><th>总击杀</th><th>总死亡</th><th>总时长</th></tr></thead>';
    var body = maps.map(function (m) {
      return '<tr><td class="l">' + esc(m.mapName) + '</td>' +
        '<td class="l dim">' + esc(m.mode) + '</td>' +
        '<td>' + m.total + '</td>' +
        wrTd(m) +
        '<td class="' + rateCls(m.rating) + '">' + m.rating + '</td>' +
        '<td>' + m.kd + '</td><td>' + m.killPerMin + '</td>' +
        '<td>' + fmt(m.avgScore) + '</td><td>' + fmt(m.scorePerMin) + '</td>' + sideTd(m) +
        '<td>' + m.avgOccupy + '</td><td>' + m.avgRescue + '</td>' +
        '<td>' + fmt(m.killTotal) + '</td><td>' + fmt(m.deathTotal) + '</td>' +
        '<td>' + Math.round(m.totalHours) + 'h</td></tr>';
    }).join('');
    el('mapBox').innerHTML = sideSummaryHtml(rep.sides) + mapSidesHtml(rep.mapSides) +
      '<h3>分地图明细</h3><table>' + head + '<tbody>' + body + '</tbody></table>';

    var tipBox = document.getElementById('mapTips');
    if (tipBox) tipBox.innerHTML = tipsHtml(tips);

    var top = maps.slice().sort(function (a, b) { return b.winRate - a.winRate; });
    global.DFCharts.hbar('chMapRate',
      top.map(function (m) { return m.mapName; }).reverse(),
      top.map(function (m) { return m.winRate; }).reverse(), 'accent', '%');
    var byRate = maps.slice().sort(function (a, b) { return b.rating - a.rating; });
    global.DFCharts.hbar('chMapRating',
      byRate.map(function (m) { return m.mapName; }).reverse(),
      byRate.map(function (m) { return m.rating; }).reverse(), 'green', '');
  }

  /* ============================================================
   * 兵种表现
   * ============================================================ */
  /* 结论只从满 MIN_TIP_SAMPLE（见文件顶部）的兵种/干员里挑，规则见那里 */
  function classTip(rep, cls, agents) {
    var tips = [];
    var best = cls.slice().sort(function (a, b) { return b.winRate - a.winRate; })[0];
    if (best && best.total >= MIN_TIP_SAMPLE) {
      tips.push({
        level: 'good', title: '最擅长兵种：' + best.label,
        text: best.total + ' 场，胜率 ' + best.winRate + '%' + ciPlain(best) + '，平均评分 ' +
          best.rating + '，场均得分 ' + fmt(best.avgScore) + '。'
      });
    }
    /* 「需要加强」只在满门槛的兵种里挑最低——否则 2 场 0 胜就会给人扣帽子 */
    var solid = cls.filter(function (c) { return c.total >= MIN_TIP_SAMPLE; });
    var worst = solid.slice().sort(function (a, b) { return a.winRate - b.winRate; })[0];
    if (worst && worst !== best && worst.winRate < 45) {
      tips.push({
        level: 'warn', title: '需要加强：' + worst.label,
        text: worst.total + ' 场，胜率仅 ' + worst.winRate + '%' + ciPlain(worst) +
          '，平均评分 ' + worst.rating +
          '。如果只是为了补位使用，属正常；否则可以针对性练习。'
      });
    }
    if (agents.length) {
      var topAgent = agents.slice().sort(function (a, b) { return b.total - a.total; })[0];
      tips.push({
        level: 'info', title: '最常用干员：' + topAgent.agent,
        text: topAgent.total + ' 场，胜率 ' + topAgent.winRate + '%' + ciPlain(topAgent) +
          '，平均评分 ' + topAgent.rating + '（' + topAgent.cls + '）。'
      });
      var bestAgent = agents.filter(function (a) { return a.total >= MIN_TIP_SAMPLE; })
        .sort(function (a, b) { return b.rating - a.rating; })[0];
      if (bestAgent && bestAgent !== topAgent) {
        tips.push({
          level: 'good', title: '高评分干员：' + bestAgent.agent,
          text: bestAgent.total + ' 场平均评分 ' + bestAgent.rating + '，胜过你最常用的 ' +
            topAgent.agent + '（' + topAgent.rating + '）。'
        });
      }
    }
    var cm = rep.commander;
    if (cm && cm.available) {
      tips.push({
        level: cm.winRate >= 50 ? 'good' : 'warn',
        title: '指挥官对局 ' + cm.total + ' 场，胜率 ' + cm.winRate + '%',
        text: '平均评分 ' + cm.rating + '，KD ' + cm.kd + '，胜率' + ciPlain(cm) +
          (cm.vsNormal ? '；相比普通对局胜率 ' + (cm.vsNormal.winRate >= 0 ? '+' : '') +
            cm.vsNormal.winRate + ' 个百分点（两侧样本都小，这个差不当结论用）。' : '。')
      });
    }
    return tips;
  }

  function renderClasses(rep) {
    var cls = rep.classes || [];
    var agents = rep.agents || [];
    if (!cls.length) {
      el('classBox').innerHTML = empty('当前筛选下没有对局（或对局未记录兵种）');
      el('commanderBox').innerHTML = '';
      var tb = document.getElementById('classTips'); if (tb) tb.innerHTML = '';
      clearCharts(['chClassRate', 'chClassRating']);
      return;
    }

    /* 兵种与干员这两张表并排在 .split 里（1180 那一档各只有 ~570px），
     * 再加一整列就会把页面撑出横向溢出 —— 所以 KD 与 KPM 合成一格「1.65 / 1.8」，
     * 两个数一个不丢，宽度不加。全宽的那几张表（战局列表 / 地图 / 阵营对比）仍旧各占一列。 */
    var head = '<thead><tr><th class="l">兵种</th><th>场次</th><th>胜率</th><th>评分</th>' +
      '<th title="' + esc(KPM.note) + '">KD / ' + KPM.label + '</th>' +
      '<th>场均击杀</th><th>场均得分</th><th>' + OCC.avg + '</th><th>场均救治</th>' +
      '<th>分均得分</th></tr></thead>';
    var body = cls.map(function (c) {
      return '<tr><td class="l">' + esc(c.label) + '</td><td>' + c.total + '</td>' +
        wrTd(c) +
        '<td class="' + rateCls(c.rating) + '">' + c.rating + '</td>' +
        '<td>' + c.kd + ' / ' + c.killPerMin + '</td>' +
        '<td>' + c.avgKill + '</td><td>' + fmt(c.avgScore) + '</td>' +
        '<td>' + c.avgOccupy + '</td><td>' + c.avgRescue + '</td><td>' + fmt(c.scorePerMin) + '</td></tr>';
    }).join('');

    var agentHead = '<thead><tr><th class="l">干员</th><th class="l">兵种</th><th>场次</th>' +
      '<th>胜率</th><th>评分</th><th title="' + esc(KPM.note) + '">KD / ' + KPM.label + '</th>' +
      '<th>场均击杀</th><th>场均得分</th><th>场均救治</th></tr></thead>';
    var agentBody = agents.map(function (a) {
      return '<tr><td class="l">' + esc(a.agent) + '</td><td class="l dim">' + esc(a.cls) + '</td>' +
        '<td>' + a.total + '</td>' +
        wrTd(a) +
        '<td class="' + rateCls(a.rating) + '">' + a.rating + '</td>' +
        '<td>' + a.kd + ' / ' + a.killPerMin + '</td>' +
        '<td>' + a.avgKill + '</td><td>' + fmt(a.avgScore) + '</td>' +
        '<td>' + a.avgRescue + '</td></tr>';
    }).join('');

    el('classBox').innerHTML =
      '<div class="split" style="margin-bottom:0">' +
      '<div><h3>兵种明细</h3><table>' + head + '<tbody>' + body + '</tbody></table></div>' +
      '<div><h3>干员明细</h3><table>' + agentHead + '<tbody>' + agentBody + '</tbody></table></div>' +
      '</div>' +
      '<p class="hint">干员与兵种对照来自官方 agentInfo 配置表；首位数字即兵种：' +
      '1=突击 2=医疗 3=工程 4=侦查 5=指挥官（这只是官方兵种分类，' +
      '与顶部筛选里的「指挥官」模式无关——那个只认你在单场详情里的手动标记）。' +
      '注意：只有你自己的对局会记录干员，同场其他玩家的兵种官方不返回。</p>';

    var tb = document.getElementById('classTips');
    if (tb) tb.innerHTML = tipsHtml(classTip(rep, cls, agents));

    global.DFCharts.hbar('chClassRate',
      cls.map(function (c) { return c.label; }).reverse(),
      cls.map(function (c) { return c.winRate; }).reverse(), 'accent', '%');
    global.DFCharts.hbar('chClassRating',
      cls.map(function (c) { return c.label; }).reverse(),
      cls.map(function (c) { return c.rating; }).reverse(), 'green', '');

    var cm = rep.commander;
    if (cm && cm.available) {
      el('commanderBox').innerHTML = '<h3>指挥官对局</h3>' +
        kpi6([
          ['场次', cm.total], ['胜率', cm.winRate, '%', cm.winRate >= 50 ? 'good' : 'bad'],
          ['评分', cm.rating, '', rateCls(cm.rating)],
          ['KPM', cm.killPerMin],
          ['场均得分', fmt(cm.avgScore)], ['场均击杀', cm.avgKill]
        ]) +
        (cm.vsNormal ? '<div class="hint" style="margin-top:10px">与普通对局对比：胜率 ' +
          (cm.vsNormal.winRate >= 0 ? '+' : '') + cm.vsNormal.winRate + ' 个百分点（普通 ' +
          cm.vsNormal.normalWinRate + '%）；场均得分 ' + (cm.vsNormal.avgScore >= 0 ? '+' : '') +
          cm.vsNormal.avgScore + '（普通 ' + fmt(cm.vsNormal.normalAvgScore) + '）</div>' : '') +
        '<p class="hint">标记方式：这些场次由你在「单场详情」里手动点上「标记本场为指挥官」，' +
        '它们仍同时计入胜者为王，不会额外多出一场。<br>' +
        '官方指挥官专用接口未开放（返回 404），用「赤枭 / 赤枭亲卫」也不等于当指挥官，所以只认手动标记。</p>';
    } else {
      el('commanderBox').innerHTML = '<h3>指挥官对局</h3>' +
        '<p class="hint">还没有标记任何指挥官对局。<br>' +
        '在《三角洲行动》里，指挥官是集成在胜者为王对局中的角色。到「单场详情」里把那一场点上' +
        '「标记本场为指挥官」，这里就会单独统计，同时它仍然算在胜者为王里。</p>';
    }
  }

  /* ============================================================
   * 周期对比（本周 vs 上周 / 本月 vs 上月）
   * ============================================================ */
  function renderPeriods(rep) {
    var box = el('periodBox');
    if (!box) return;
    var p = rep.periods;
    if (!p) { box.innerHTML = ''; return; }

    function cell(v, unit, invert) {
      if (v === null || v === undefined) return '<span class="dim">—</span>';
      var good = invert ? v < 0 : v > 0;
      var color = v === 0 ? 'inherit' : (good ? 'var(--green)' : 'var(--red)');
      return '<span style="color:' + color + '">' + (v > 0 ? '+' : '') + v + (unit || '') + '</span>';
    }
    function block(pk, title) {
      var c = pk.cur, pv = pk.prev;
      if (!c && !pv) {
        return '<div><h3>' + title + '</h3><p class="hint">这个周期还没有对局。</p></div>';
      }
      function row(label, cv, pvv, delta, unit) {
        return '<tr><td class="l">' + label + '</td>' +
          '<td>' + (cv == null ? '—' : cv) + '</td>' +
          '<td class="dim">' + (pvv == null ? '—' : pvv) + '</td>' +
          '<td>' + cell(delta, unit) + '</td></tr>';
      }
      return '<div><h3>' + title + '</h3>' +
        '<table class="mini-table"><thead><tr><th class="l">指标</th>' +
        '<th>' + pk.curLabel + '</th><th>' + pk.prevLabel + '</th><th>变化</th></tr></thead><tbody>' +
        row('场次', c ? c.total : 0, pv ? pv.total : 0, pk.dTotal, ' 场') +
        row('胜率', c ? c.winRate + '%' : '—', pv ? pv.winRate + '%' : '—', pk.dWinRate, '%') +
        row('KD', c ? c.kd : '—', pv ? pv.kd : '—', pk.dKd, '') +
        row(KPM.label, c ? c.killPerMin : '—', pv ? pv.killPerMin : '—', pk.dKillPerMin, '') +
        row('场均得分', c ? fmt(c.avgScore) : '—', pv ? fmt(pv.avgScore) : '—', pk.dAvgScore, '') +
        row('场均击杀', c ? c.avgKill : '—', pv ? pv.avgKill : '—', null, '') +
        row('场均救治', c ? c.avgRescue : '—', pv ? pv.avgRescue : '—', null, '') +
        '</tbody></table></div>';
    }

    box.innerHTML = '<h3>周期对比</h3>' +
      '<div class="hint" style="margin:-6px 0 10px 2px">和上一个周期比，看得见进步</div>' +
      '<div class="split" style="margin-bottom:0">' +
      block(p.week, '本周 vs 上周') +
      block(p.month, '本月 vs 上月') +
      '</div>';
  }

  /* ============================================================
   * 地图 × 干员 交叉分析
   * ============================================================ */
  function renderMatrix(rep) {
    var box = el('matrixBox');
    if (!box) return;
    var m = rep.matrix;
    if (!m || !m.cells || !m.cells.length) {
      box.innerHTML = '<h3>地图 × 干员 组合表现</h3>' +
        '<p class="hint">还没有足够的干员数据。每场对局记录你使用的干员后，' +
        '这里会给出「哪张图用谁最好」的建议。</p>';
      return;
    }

    var html = '<h3>地图 × 干员 组合表现</h3>';

    if (m.bestPerMap.length) {
      var minS = m.minSample || 3;
      html += '<div class="hint" style="margin:-6px 0 10px 2px">' +
        '同一张图 × 同一模式下你表现最好的干员。标了「仅 N 场」的行不足 ' + minS +
        ' 场，名次随时会被下一场翻掉，当参考就好。</div>' +
        '<table class="mini-table"><thead><tr><th class="l">地图</th><th class="l">模式</th>' +
        '<th class="l">推荐干员</th><th>场次</th><th>胜率</th><th>评分</th>' +
        '<th title="' + esc(KPM.note) + '">KD / ' + KPM.label + '</th>' +
        '<th class="l">不建议</th><th>其胜率</th></tr></thead><tbody>' +
        m.bestPerMap.map(function (x) {
          var b = x.best, w = x.worst;
          return '<tr><td class="l">' + esc(x.mapName) + '</td>' +
            '<td class="l dim">' + esc(x.mode || '') + '</td>' +
            '<td class="l" style="color:var(--accent);font-weight:500">' + esc(b.agent) +
            '（' + esc(b.cls) + '）' +
            (x.thinSample ? ' <span class="tag tag-dim">仅 ' + b.total + ' 场</span>' : '') +
            '</td>' +
            '<td>' + b.total + '</td>' +
            wrTd(b) +
            '<td>' + b.rating + '</td><td>' + b.kd + ' / ' + b.killPerMin + '</td>' +
            '<td class="l dim">' + esc(w.agent) + '</td>' +
            '<td style="color:' + wrColor(w.winRate) + '" title="' +
            esc('95% 区间 ' + (w.ci ? w.ci.lo + '~' + w.ci.hi + '%' : '给不出')) +
            '">' + w.winRate + '%</td></tr>';
        }).join('') + '</tbody></table>';
    } else {
      html += '<p class="hint">同一张图 × 同一模式下，还没出现两个干员各打过 2 场以上的对比；' +
        '多打几场后这里会给出推荐组合。</p>';
    }

    html += '<h3 style="margin-top:20px">全部组合明细</h3>' +
      '<table><thead><tr><th class="l">地图</th><th class="l">模式</th><th class="l">干员</th><th class="l">兵种</th>' +
      '<th>场次</th><th>胜率</th><th>评分</th><th>KD</th><th title="' + esc(KPM.note) + '">' + KPM.label +
      '</th><th>场均得分</th>' +
      '<th>场均击杀</th><th>场均救治</th></tr></thead><tbody>' +
      m.cells.map(function (c) {
        return '<tr><td class="l">' + esc(c.mapName) + '</td>' +
          '<td class="l dim">' + esc(c.mode || '') + '</td>' +
          '<td class="l">' + esc(c.agent) + '</td>' +
          '<td class="l dim">' + esc(c.cls) + '</td>' +
          '<td>' + c.total + '</td>' +
          '<td style="color:' + wrColor(c.winRate) + '">' + c.winRate + '%</td>' +
          '<td class="' + rateCls(c.rating) + '">' + c.rating + '</td>' +
          '<td>' + c.kd + '</td><td>' + c.killPerMin + '</td><td>' + fmt(c.avgScore) + '</td>' +
          '<td>' + c.avgKill + '</td><td>' + c.avgRescue + '</td></tr>';
      }).join('') + '</tbody></table>';

    box.innerHTML = html;
  }

  /* ============================================================
   * 对手与队友
   * ============================================================ */
  function renderEncounters(rep) {
    var e = rep.encounters;
    /* ⑤ 只依赖全场名单，不依赖「重复遇到」，必须排在下面的早退之前 */
    renderStrength(rep);
    var tips = el('encTips');
    // 数据刷新后旧的交手档案可能已过期，先收起
    var dbox = el('encDetail');
    if (dbox) { dbox.style.display = 'none'; dbox.innerHTML = ''; }
    if (!e || !e.totalPlayers) {
      if (tips) tips.innerHTML = '<h3>对手与队友</h3><p class="hint">' +
        '还没有足够的全场名单数据。开启「同步时抓取全场名单」并多同步几次后，' +
        '这里会自动识别你常遇到的同阵营玩家与对手。</p>';
      ['encMates', 'encRecent', 'encOpps', 'encBestMates', 'encToughest'].forEach(function (id) {
        var n = el(id); if (n) n.innerHTML = '';
      });
      return;
    }

    var t = [];
    // 现在只在这页放「能站得住」的结论：重复遇到的人太少时必须讲清楚
    if (e.repeatPlayers === 0) {
      t.push({
        level: 'warn', title: '目前还没有「重复遇到」的玩家',
        text: '已扫描 ' + e.scanned + ' 场、共 ' + e.playedPlayers +
          ' 人次，识别出 ' + e.totalPlayers + ' 位同场玩家，但**没有任何人同场 ≥2 次**。' +
          '也就是说：这两页现在只有「一次一面之交」，还谈不上队友或对手。' +
          '开启「设置 → 定时自动同步」持续积累，才会出现真正可分析的常遇对象。'
      });
    } else {
      t.push({
        level: 'info', title: '识别到 ' + e.repeatPlayers + ' 位重复遇到（≥' + e.minMeets + ' 次）的玩家',
        text: '共扫描 ' + e.scanned + ' 场（' + e.playedPlayers + ' 人次），识别 ' +
          e.totalPlayers + ' 位同场玩家，其中 ' + e.repeatPlayers + ' 位同场 ≥' + e.minMeets + ' 次。'
      });
    }
    if (e.bestMates && e.bestMates.length) {
      var bm = e.bestMates[0];
      t.push({
        level: 'good', title: '同阵营胜率最高：' + bm.name,
        text: '有 ' + bm.allyMeets + ' 场和你分在同一阵营，这些场次你的胜率是 ' + bm.allyWinRate + '%' +
          ciPlain({ ci: bm.allyCi, n: bm.allyMeets }) + '。'
      });
    }
    if (e.toughest && e.toughest.length) {
      var tg = e.toughest[0];
      t.push({
        level: 'warn', title: '最难缠对手：' + tg.name,
        text: '有 ' + tg.enemyMeets + ' 场在对面，这些场次你只赢了 ' + tg.enemyWinRate + '%' +
          ciPlain({ ci: tg.enemyCi, n: tg.enemyMeets }) + '。'
      });
    }
    // 身份口径：这条必须常驻，不能再让人以为次数是编的
    t.push({
      level: 'dim', title: '身份口径 · 请看完再看数字',
      text: '战绩与昵称 100% 来自官方对局详情接口，没有任何加工。' +
        '但官方对约一半玩家只返回**每局重新分配的临时编号**（同一个人下一局编号就变了，' +
        '编号「8007」在 8 场里对应 8 个不同的人），所以身份识别规则是：' +
        '账号 ID 稳定的按账号聚合，只拿到临时编号的按**昵称**聚合（表中标注「昵称」）。' +
        '另外分边是随机的，双方各 25~36 人，同阵营概率天然约 50%，' +
        '所以看的是「同阵营率」相对 50% 的偏离；同阵营 ≠ 组队队友。'
    });
    if (tips) tips.innerHTML = tipsHtml(t);

    /* 同阵营率单元格：以 50% 为基线着色 */
    function rateCell(rate, meets) {
      if (rate == null) return '<span class="dim">—</span>';
      var d = rate - 50;
      var color = Math.abs(d) < 12 ? 'inherit' : (d > 0 ? 'var(--green)' : 'var(--red)');
      var tone = Math.abs(d) < 12 ? '（接近随机）' : '';
      return '<span style="color:' + color + '">' + rate + '%</span>' +
        '<span class="dim" style="font-size:11px"> ' + tone + '</span>';
    }

    /* 行可点击 → 打开该玩家的「交手档案」（在哪些场次遇到、当时双方名次） */
    function tr(x) {
      return '<tr class="clickable-row" data-key="' + esc(x.key) + '"' +
        ' data-name="' + esc(x.name) + '" title="点击查看交手档案">';
    }
    function nameCell(x) {
      return '<td class="l">' + esc(x.name) + idBadge(x) +
        '<span class="dim" style="font-size:11px"> ›</span></td>';
    }
    /* 身份徽标：只拿到临时编号的玩家按昵称识别，必须标注，不可假装和账号一样可靠 */
    function idBadge(x) {
      if (x.identifiable) return '';
      return ' <span class="tag tag-soft" title="官方未返回稳定账号 ID，按昵称识别">昵称</span>';
    }

    /* 重复遇到的人（≥2 次）—— 唯一有统计价值的部分 */
    el('encMates').innerHTML = e.repeats && e.repeats.length
      ? '<table class="mini-table"><thead><tr><th class="l">玩家</th><th>同场次数</th>' +
        '<th>同阵营率</th><th>场均得分</th><th>KD</th><th title="' + esc(KPM.note) + '">' + KPM.label +
        '</th><th>最近同场</th></tr></thead><tbody>' +
        e.repeats.map(function (x) {
          return tr(x) + nameCell(x) +
            '<td>' + x.totalMeets + '</td>' +
            '<td>' + rateCell(x.allyRate, x.totalMeets) + '</td>' +
            '<td>' + fmt(x.avgScore) + '</td><td>' + x.kd + '</td>' +
            '<td>' + (x.kpm == null ? '—' : x.kpm) + '</td>' +
            '<td class="dim">' + (x.lastMeet ? new Date(x.lastMeet * 1000).toLocaleDateString('zh-CN') : '—') +
            '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<p class="hint">还没有人同场 ≥' + (e.minMeets || 2) + ' 次。' +
        '这两页要真正有价值，需要持续同步积累对局。</p>';

    /* 最近同场 —— 供点击查询「这一场他排第几」 */
    el('encRecent').innerHTML = e.recent && e.recent.length
      ? '<table class="mini-table"><thead><tr><th class="l">玩家</th><th>同场次数</th>' +
        '<th>场均得分</th><th>KD</th><th>' + KPM.label + '</th><th>最近同场</th></tr></thead><tbody>' +
        e.recent.map(function (x) {
          return tr(x) + nameCell(x) + '<td>' + x.totalMeets + '</td>' +
            '<td>' + fmt(x.avgScore) + '</td><td>' + x.kd + '</td>' +
            '<td>' + (x.kpm == null ? '—' : x.kpm) + '</td>' +
            '<td class="dim">' + (x.lastMeet ? new Date(x.lastMeet * 1000).toLocaleString('zh-CN', {
              month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
            }) : '—') + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<p class="hint">暂无数据</p>';

    /* 每个玩家身上的「这些场你的胜率」：字段名各家不同，统一喂给 wrTd 挂区间 */
    function allyTd(x) {
      return wrTd({ winRate: x.allyWinRate, ci: x.allyCi, n: x.allyMeets });
    }
    function enemyTd(x) {
      return wrTd({ winRate: x.enemyWinRate, ci: x.enemyCi, n: x.enemyMeets });
    }

    /* 对手倾向最强 */
    el('encOpps').innerHTML = e.topOpponents && e.topOpponents.length
      ? '<table class="mini-table"><thead><tr><th class="l">玩家</th><th>同场次数</th>' +
        '<th>同阵营率</th><th>敌对时你的胜率</th><th>对方场均得分</th></tr></thead><tbody>' +
        e.topOpponents.slice(0, 20).map(function (x) {
          return tr(x) + nameCell(x) +
            '<td>' + x.totalMeets + '</td>' +
            '<td>' + rateCell(x.allyRate, x.totalMeets) + '</td>' +
            enemyTd(x) +
            '<td>' + fmt(x.avgScore) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<p class="hint">还没有同场 ≥' + (e.minMeets || 2) + ' 次的玩家。</p>';

    /* 同阵营时胜率最高 */
    el('encBestMates').innerHTML = e.bestMates && e.bestMates.length
      ? '<table class="mini-table"><thead><tr><th class="l">玩家</th><th>同阵营次数</th>' +
        '<th>同阵营率</th><th>这些场你的胜率</th></tr></thead><tbody>' +
        e.bestMates.map(function (x) {
          return tr(x) + nameCell(x) + '<td>' + x.allyMeets + '</td>' +
            '<td>' + rateCell(x.allyRate, x.totalMeets) + '</td>' +
            allyTd(x) + '</tr>';
        }).join('') + '</tbody></table>'
      : '<p class="hint">同阵营 ≥' + (e.minMeets || 2) + ' 次的玩家还不够多。</p>';

    /* 最难缠对手 */
    el('encToughest').innerHTML = e.toughest && e.toughest.length
      ? '<table class="mini-table"><thead><tr><th class="l">玩家</th><th>敌对次数</th>' +
        '<th>同阵营率</th><th>敌对时你的胜率</th><th>对方场均得分</th></tr></thead><tbody>' +
        e.toughest.map(function (x) {
          return tr(x) + nameCell(x) + '<td>' + x.enemyMeets + '</td>' +
            '<td>' + rateCell(x.allyRate, x.totalMeets) + '</td>' +
            enemyTd(x) +
            '<td>' + fmt(x.avgScore) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<p class="hint">敌对 ≥' + (e.minMeets || 2) + ' 次的对手还不够多。</p>';
  }

  /* ============================================================
   * 交手档案：某位玩家在哪些场次与你同场、当时双方各自排第几
   * ============================================================ */
  function renderEncounterDetail(d, vopenid, fallbackName) {
    var box = el('encDetail');
    if (!box) return;
    var name = d ? d.name : (fallbackName || '该玩家');
    if (!d) {
      box.innerHTML = '<h3>交手档案 · ' + esc(name) + '</h3>' +
        '<p class="hint">没有找到与该玩家的同场记录（可能名单数据已被清空）。</p>';
      return;
    }

    function rankCell(rank, total) {
      if (!rank) return '<span class="dim">—</span>';
      var tone = rank <= 3 ? 'var(--green)' : (rank > total * 0.6 ? 'var(--red)' : 'inherit');
      return '<span style="color:' + tone + '">' + rank + '</span>' +
        '<span class="dim" style="font-size:11px">/' + total + '</span>';
    }
    function cmpCell(diff) {
      var color = diff > 0 ? 'var(--red)' : (diff < 0 ? 'var(--green)' : 'inherit');
      return '<span style="color:' + color + '">' + (diff > 0 ? '+' : '') + fmt(diff) + '</span>';
    }

    /* 结论：他名次压过你 vs 你压过他 */
    var verdict;
    if (d.better > d.worse) {
      verdict = { level: 'warn', title: '这位比你强',
        text: d.totalMeets + ' 场同场里，他的全场得分名次有 ' + d.better + ' 次高于你，你有 ' +
          d.worse + ' 次高于他。他场均得分 ' + fmt(d.avgScore) + '，你 ' + fmt(d.myAvgScore) + '。' };
    } else if (d.worse > d.better) {
      verdict = { level: 'good', title: '你稳压他一头',
        text: d.totalMeets + ' 场同场里，你有 ' + d.worse + ' 次得分名次高于他，他只压过你 ' +
          d.better + ' 次。你场均 ' + fmt(d.myAvgScore) + '，他 ' + fmt(d.avgScore) + '。' };
    } else {
      verdict = { level: 'info', title: '互有胜负',
        text: d.totalMeets + ' 场里你们的得分名次各有胜负。他场均 ' + fmt(d.avgScore) +
          '，你场均 ' + fmt(d.myAvgScore) + '。' };
    }

    var kpis = kpiCards([
      ['同场次数', d.totalMeets, '', ''],
      ['同阵营', d.allyMeets, '/ ' + d.totalMeets + ' 场', ''],
      ['同阵营率', d.allyRate, '%', ''],
      ['他场均得分', fmt(d.avgScore), '平均第 ' + d.avgRankScore + ' 名', ''],
      ['你场均得分', fmt(d.myAvgScore), '平均第 ' + d.myAvgRankScore + ' 名', ''],
      ['这些场你的胜率', d.winRate, '%', '']
    ]);

    var rows = d.records.map(function (r) {
      return '<tr>' +
        '<td class="l">' + esc(String(r.time || '').slice(5, 16)) + '</td>' +
        '<td class="l">' + esc(r.mapName) + '</td>' +
        '<td>' + (r.sameSide
          ? '<span style="color:var(--accent)">同阵营</span>'
          : '<span style="color:var(--orange)">对面</span>') + '</td>' +
        '<td>' + fmt(r.score) + '</td>' +
        '<td>' + rankCell(r.rankScore, r.players) + '</td>' +
        '<td class="camp">' + (r.side ? esc(r.side) : '—') + '</td>' +
        '<td>' + fmt(r.myScore) + '</td>' +
        '<td>' + rankCell(r.myRankScore, r.players) + '</td>' +
        '<td>' + r.kill + '/' + r.death + '</td>' +
        '<td>' + r.myKill + '/' + r.myDeath + '</td>' +
        '<td>' + cmpCell(r.diffScore) + '</td>' +
        '<td class="dim">' + (r.myWin ? '胜' : '负') + '</td></tr>';
    }).join('');

    var idNote = d.identifiable
      ? ''
      : '<p class="hint">⚠ 这位玩家官方只返回「每局重新分配的临时编号」，' +
        '因此按<b>昵称</b>识别。同名玩家理论上可能被合并，请结合实际对局判断。</p>';

    box.innerHTML = '<h3>交手档案 · ' + esc(name) +
      (d.identifiable ? '' : ' <span class="tag tag-soft">昵称识别</span>') +
      '<button class="btn btn-sm enc-close" id="encDetailClose">收起</button></h3>' +
      kpis + compareHtml(d.compare) +
      '<p class="hint">同场这些场你的胜率 ' + d.winRate + '%' +
      ciPlain({ ci: d.winRateCi, n: d.totalMeets }) +
      (d.allyMeets ? '；与你同阵营 ' + d.allyMeets + ' 场时 ' + d.allyWinRate + '%' +
        ciPlain({ ci: d.allyCi, n: d.allyMeets }) : '') +
      (d.enemyMeets ? '；他在你对面 ' + d.enemyMeets + ' 场时 ' + d.enemyWinRate + '%' +
        ciPlain({ ci: d.enemyCi, n: d.enemyMeets }) : '') + '。</p>' +
      '<div style="margin:14px 0">' + tipsHtml([verdict]) + '</div>' +
      '<table><thead><tr><th class="l">时间</th><th class="l">地图</th><th>位置</th>' +
      '<th>他得分</th><th>他名次</th><th>你得分</th><th>你名次</th>' +
      '<th title="' + esc(SIDE_NOTE) + '">攻防</th><th>他K/D</th><th>你K/D</th>' +
      '<th>分差</th><th>结果</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="hint">「名次」为该场全场排名（含双方全部 ' + d.records[0].players +
      ' 人左右）。分差 = 他得分 − 你得分，红线表示他高于你。</p>' + idNote;
  }

  /* ============================================================
   * 战绩卡片（Canvas 绘制 → PNG）
   * ============================================================ */
  function drawMatchCard(c) {
    var m = c.match, rt = c.rating || {};
    var S = 2, W = 780, H = 430;
    var cv = document.createElement('canvas');
    cv.width = W * S; cv.height = H * S;
    var g = cv.getContext('2d');
    g.scale(S, S);

    var FONT = '-apple-system, "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif';
    function rr(x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    }

    g.fillStyle = '#0B1220';
    rr(0, 0, W, H, 26); g.fill();
    g.fillStyle = m.is_winner ? '#30D158' : '#FF453A';
    rr(0, 0, W, 6, 3); g.fill();

    g.fillStyle = '#F5F5F7';
    g.font = '600 22px ' + FONT;
    g.textBaseline = 'alphabetic';
    g.fillText((m.mapName || '') + (m.side ? '-' + m.side : ''), 34, 64);
    g.font = '400 14px ' + FONT;
    g.fillStyle = '#8E8E93';
    g.fillText((m.dt_event_time || '').slice(0, 16) + ' · ' + modeText(m) +
      (m.force_name ? ' · ' + m.force_name : ''), 34, 88);

    g.font = '600 15px ' + FONT;
    var bw = 78, bh = 32, bx = W - 34 - bw, by = 44;
    g.fillStyle = m.is_winner ? 'rgba(48,209,88,0.16)' : 'rgba(255,69,58,0.16)';
    rr(bx, by, bw, bh, 10); g.fill();
    g.fillStyle = m.is_winner ? '#30D158' : '#FF453A';
    g.textAlign = 'center';
    g.fillText(m.is_winner ? '胜 利' : '失 败', bx + bw / 2, by + 21);
    g.textAlign = 'left';

    g.fillStyle = 'rgba(10,132,255,0.14)';
    rr(34, 116, 210, 172, 18); g.fill();
    g.fillStyle = '#8E8E93'; g.font = '400 13px ' + FONT;
    g.fillText('单局评分', 54, 146);
    g.fillStyle = '#0A84FF'; g.font = '600 58px ' + FONT;
    g.fillText(String(rt.value != null ? rt.value : '—'), 52, 210);
    g.fillStyle = '#8E8E93'; g.font = '400 12px ' + FONT;
    g.fillText(rt.basis === 'lobby' ? '基于同局 ' + rt.players + ' 人排名' : '基于基准估算', 54, 268);

    var stats = [
      ['击杀', m.kill], ['死亡', m.death], ['助攻', m.assist],
      ['KPM', kpmText(m)], ['KDA', m.kda], ['得分', fmt(m.score)],
      [OCC.label, m.occupy], ['救治', m.rescue], ['分均得分', m.score_per_min]
    ];
    var gx = 266, gy = 116, cw = 152, chh = 54, gapx = 12, gapy = 5;
    stats.forEach(function (s, i) {
      var col = i % 3, row = Math.floor(i / 3);
      var x = gx + col * (cw + gapx), y = gy + row * (chh + gapy);
      g.fillStyle = 'rgba(255,255,255,0.06)';
      rr(x, y, cw, chh, 12); g.fill();
      g.fillStyle = '#8E8E93'; g.font = '400 11px ' + FONT;
      g.fillText(s[0], x + 12, y + 20);
      g.fillStyle = '#F5F5F7'; g.font = '500 19px ' + FONT;
      g.fillText(String(s[1]), x + 12, y + 42);
    });

    g.fillStyle = '#1C1C1E';
    rr(34, 306, W - 68, 56, 14); g.fill();
    var bits = [];
    if (c.roster >= 5 && c.ranks) {
      bits.push('全场得分排名  ' + c.ranks.score.rank + ' / ' + c.roster);
      bits.push('击杀排名  ' + c.ranks.kill.rank + ' / ' + c.roster);
      bits.push('超过  ' + c.ranks.score.pct + '%');
    } else {
      bits.push('本局无全场名单');
    }
    bits.push('时长  ' + Math.round(m.game_time / 60) + ' 分钟');
    g.font = '400 13px ' + FONT;
    var tx = 56;
    bits.forEach(function (b, i) {
      g.fillStyle = (i === 2 && bits.length > 3) ? '#30D158' : '#98989D';
      g.fillText(b, tx, 340);
      tx += g.measureText(b).width + 26;
    });

    g.fillStyle = '#48484A'; g.font = '400 11px ' + FONT;
    g.fillText('三角洲行动 · 全面战场数据分析', 34, H - 22);
    g.textAlign = 'right';
    g.fillText('本地生成 · 数据仅存本机', W - 34, H - 22);
    g.textAlign = 'left';

    return cv.toDataURL('image/png');
  }

  /* ============================================================
   * v1.4.0 状态与节律：数据完整度 / 分时段 / 连战衰减 / 关注池
   * ============================================================ */
  function fmtTs(sec) {
    if (!sec) return '—';
    return new Date(sec * 1000).toLocaleString('zh-CN', {
      hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }
  function rateOf(r) { return r == null ? '—' : r; }

  /* 数据完整度：官方只回最近约 36 场，所以「有没有漏」只有本机说得清 */
  function renderSync(rep) {
    var box = el('syncPanel');
    if (!box) return;
    var s = rep.sync || {}, d = s.doubt || {}, gaps = s.gaps || [], wins = s.windows || [];
    var stored = (rep.stored || {}).total || 0;
    var html = '<h3>数据完整度</h3>';

    if (d.suspect) {
      html += '<div class="sync-alarm"><b>检测到一次「整窗滚过」</b>' +
        '<p>上一次同步看到的最新一场是 <b>' + fmtTs(d.from) + '</b>，' +
        '而这一次官方返回的最老一场已经是 <b>' + fmtTs(d.to) + '</b> —— 中间约 <b>' + d.days +
        '</b> 天里的对局从未进入采集窗口，且已超出官方最近 36 场，<b>无法补采</b>。</p>' +
        '<p class="dim">建议把「设置 → 定时自动同步」调到 15 分钟并让软件挂着：打得多的时候 30 分钟一轮不够用。</p></div>';
    } else if (wins.length < 2) {
      html += '<p class="hint">目前只积累了 ' + wins.length + ' 轮同步窗口，没有可比对的上一次窗口，' +
        '这里暂时给不出结论。再多同步一轮（或等定时同步跑一次）就会开始判定。</p>';
    } else {
      html += '<p class="ok-line">✓ 最近 ' + wins.length + ' 轮窗口彼此衔接，' +
        '没有出现「上一轮看到的场次被本轮全部挤出去」的情况。</p>';
    }

    /* ★ 翻页自证（判据与措辞都在 core/collector.js 的 pageTrace / STOP_TEXT，这里只排版）。
     *   「我打了很多把怎么只有 N 场」这一问题，只有翻了几页、每页回来几条、最后为什么停
     *   这三样能分清：是官方窗口到底了，是我们提前停了，还是抓回来被判重吃掉了。
     *   升级之前留下的账本行没有这几列，缺就整段不写，不拿 0 装成"翻了 0 页"。 */
    var last = wins[wins.length - 1];
    if (last && last.pages) {
      var rowsTxt = (last.rows || []).join(' / ');
      html += '<h4 class="sub-h">最近一轮采集的翻页记录' +
        '<span class="dim"> ' + fmtTs(last.at / 1000) + '</span></h4>' +
        '<p class="hint">翻了 <b>' + last.pages + '</b> 页，每页回来 <b>' + rowsTxt + '</b> 条，' +
        '去重后入库 <b>' + (last.kept || 0) + '</b> 条（本轮新增 ' + (last.inserted || 0) + ' 场）。' +
        '<br>停在这里的原因：<b>' + esc(last.stopText || last.stop || '未记录') + '</b>' +
        (last.capped ? ' —— 这一轮是撞上限停的，官方窗口里再往前的场次已经拿不到了。' +
          '如果你打的比一窗多，把定时同步调密一些，别攒着。' : '') + '</p>';
    }

    if (gaps.length) {
      var top = gaps.slice().sort(function (a, b) { return b.days - a.days; }).slice(0, 6);
      html += '<h4 class="sub-h">本机没有记录的时间段' +
        '<span class="dim"> 共 ' + gaps.length + ' 段（超过 3 天就列出）。' +
        '这只说明「本机没数据」，不代表那几天你打过，也无法据此补采。</span></h4>' +
        '<table class="tbl-lite"><thead><tr><th class="l">从</th><th class="l">到</th><th>间隔</th></tr></thead><tbody>' +
        top.map(function (g) {
          return '<tr><td class="l">' + fmtTs(g.from) + '</td><td class="l">' + fmtTs(g.to) +
            '</td><td>' + g.days + ' 天</td></tr>';
        }).join('') + '</tbody></table>';
    } else if (stored) {
      html += '<p class="hint">本机 ' + stored + ' 场记录之间没有超过 3 天的空档。</p>';
    }
    box.innerHTML = stored ? html : html + empty('还没有采集到对局数据，点左下角「立即同步」。');
  }

  /* 分时段：小时取自官方时间串，与「每日场次」同一口径，不按本机时区二次换算 */
  function renderHours(rep) {
    var hours = rep.hours || [];
    var table = el('hourTable');
    if (!hours.length) {
      clearCharts(['chHour', 'chHourRate']);
      if (table) table.innerHTML = '<h3>分时段明细</h3>' + empty('当前筛选条件下没有场次。');
      return;
    }
    var labels = hours.map(function (x) { return x.label; });
    global.DFCharts.line('chHour', labels, hours.map(function (x) { return x.avgScore; }), '场均得分', 'accent', { area: true });
    global.DFCharts.line('chHourRate', labels, hours.map(function (x) { return x.winRate; }), '胜率 %', 'green');

    /* 结论只在样本够长的时段里给，3 场以下就是噪声 */
    var enough = hours.filter(function (x) { return x.total >= 3; });
    var best = enough.slice().sort(function (a, b) { return b.winRate - a.winRate; })[0];
    var worst = enough.slice().sort(function (a, b) { return a.winRate - b.winRate; })[0];
    var concl = (best && worst && best.label !== worst.label)
      ? '胜率最高 <b>' + best.label + '</b>（' + pct(best.winRate) + '，' + best.total + ' 场' +
        '，区间 ' + (best.ci ? best.ci.lo + '~' + best.ci.hi + '%' : '—') + '）·' +
        ' 最低 <b>' + worst.label + '</b>（' + pct(worst.winRate) + '，' + worst.total + ' 场' +
        '，区间 ' + (worst.ci ? worst.ci.lo + '~' + worst.ci.hi + '%' : '—') + '）<br>'
      : '没有任何一个小时攒够 3 场，先不下时段结论。<br>';
    if (table) {
      table.innerHTML = '<h3>分时段明细</h3><p class="hint">' + concl +
        '「场次」少于 3 的行只是碰巧打得少，别当规律看（灰显）。</p>' +
        '<table class="tbl-lite"><thead><tr><th class="l">时段</th><th>场次</th><th>胜率</th>' +
        '<th>场均得分</th><th>平均评分</th><th>KD</th><th title="' + esc(KPM.note) + '">' + KPM.label +
        '</th></tr></thead><tbody>' +
        hours.map(function (x) {
          return '<tr' + (x.total < 3 ? ' class="row-excluded"' : '') + '><td class="l">' + esc(x.label) +
            '</td><td>' + x.total + '</td>' + wrTd(x) + '<td>' + fmt(x.avgScore) +
            '</td><td>' + rateOf(x.rating) + '</td><td>' + x.kd + '</td><td>' + x.killPerMin + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
  }

  /* 连战衰减：官方没给结束时间，只能用「上一场开始 + 时长」推算，歇过阈值算下一轮 */
  function renderSession(rep) {
    var r = rep.rhythm || {}, by = r.byIndex || [], st = r.stats || {};
    var hint = el('sessionHint'), table = el('sessionTable');
    if (!by.length) {
      clearCharts(['chSession']);
      if (table) table.innerHTML = '';
      if (hint) hint.textContent = '';
      return;
    }
    if (hint) {
      hint.textContent = '共 ' + st.runs + ' 轮 · 平均一轮 ' + st.avgRunLen + ' 场 · 最长一轮 ' +
        st.longestRun + ' 场 · 间隔超过 ' + r.gapMin + ' 分钟算新一轮';
    }
    global.DFCharts.combo('chSession',
      by.map(function (x) { return '第 ' + x.index + ' 场'; }),
      { name: '场次', values: by.map(function (x) { return x.total; }) },
      { name: '胜率 %', values: by.map(function (x) { return x.winRate; }) });
    if (table) {
      table.innerHTML = '<table class="tbl-lite"><thead><tr><th class="l">本轮第几场</th><th>场次</th>' +
        '<th>胜率</th><th>场均得分</th><th>平均评分</th><th>KD</th><th>' + KPM.label +
        '</th><th>每分钟得分</th></tr></thead><tbody>' +
        by.map(function (x) {
          return '<tr><td class="l">第 ' + x.index + ' 场</td><td>' + x.total + '</td>' + wrTd(x) +
            '<td>' + fmt(x.avgScore) + '</td><td>' + rateOf(x.rating) +
            '</td><td>' + x.kd + '</td><td>' + x.killPerMin + '</td><td>' + x.scorePerMin + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<p class="hint">「越打越差」有两种原因：疲劳，以及连打到后面匹配到的对手越强。' +
        '这份数据分不开这两者，只能告诉你「从第几场开始掉」。' +
        '每一行的区间之所以这么宽，是因为落到「本轮第几场」上往往只剩几场。</p>';
    }
  }

  /* 关注池：分边随机、同阵营率基线约 50%，样本不够时只列数字不下结论 */
  function renderPeople(rep) {
    var box = el('peoplePanel');
    if (!box) return;
    var p = rep.people || {}, w = p.withPool, n = p.withoutPool;
    var html = '<h3>关注池对比<span class="dim" style="font-weight:400;font-size:12px">' +
      ' 与「你标为关注的人」同场时的表现 vs 不同场</span></h3>';
    if (!p.count) {
      box.innerHTML = html + empty('还没有关注任何人。<br>在「单场详情 → 全场完整名单」里点某人的「关注」，' +
        '之后他出现在哪一场都会在战局列表里挂徽标，这里也会开始对比。<br>只有能跨局识别的账号才可能被关注。');
      return;
    }
    html += '<div class="peo-list">' + (p.list || []).map(function (x) {
      return '<span class="tag tag-watch">' + esc(x.name || '（无昵称）') +
        (x.confidence === 'id' ? '' : ' · 按昵称') + '</span>';
    }).join('') + '</div>';
    if (!w) {
      html += '<p class="hint">已关注 ' + p.count + ' 人，但当前筛选范围内没有与他们同场的场次。</p>';
    } else {
      html += '<table class="tbl-lite"><thead><tr><th class="l"></th><th>场次</th><th>胜率</th>' +
        '<th>场均得分</th><th>平均评分</th><th>KD</th><th>' + KPM.label + '</th></tr></thead><tbody>' +
        '<tr><td class="l">与关注池同场</td><td>' + w.total + '</td>' + wrTd(w) +
        '<td>' + fmt(w.avgScore) + '</td><td>' + rateOf(w.rating) + '</td><td>' + w.kd +
        '</td><td>' + w.killPerMin + '</td></tr>' +
        (n ? '<tr><td class="l">不同场</td><td>' + n.total + '</td>' + wrTd(n) +
          '<td>' + fmt(n.avgScore) + '</td><td>' + rateOf(n.rating) + '</td><td>' + n.kd +
          '</td><td>' + n.killPerMin + '</td></tr>' : '') +
        '</tbody></table>' +
        (p.verdict
          ? '<p class="hint">差值：胜率 ' + (p.verdict.dWinRate > 0 ? '+' : '') + p.verdict.dWinRate +
            ' 个百分点 · 评分 ' + (p.verdict.dRating > 0 ? '+' : '') + p.verdict.dRating +
            '。两侧都攒够 ' + p.minSample + ' 场才给这句结论，而且它仍只是相关、不是因果。</p>'
          : '<p class="hint">同场样本不足 ' + p.minSample + ' 场，' +
            '而分边本来就是随机的（同阵营概率约 50%），这里只列数字、不下结论。</p>');
    }
    html += '<p class="hint">★ 关注列表只存本机：它装的是别人的账号标识与昵称，' +
      '<b>不在完整数据包和导出文件里</b>，换电脑需要重新标记。</p>';
    box.innerHTML = html;
  }

  function renderRhythm(rep) {
    renderSync(rep);
    renderHours(rep);
    renderDurations(rep);
    renderSession(rep);
    renderPeople(rep);
  }

  /* 「评分体系：…」文案由主进程算好带回来，权重可配后不能再在 HTML 里写死一份 */
  function renderRateRule(rep) {
    var n = el('rateRule');
    if (n && rep.ratingWeightsText) {
      n.innerHTML = '评分体系：<b>' + esc(rep.ratingWeightsText) + '</b>（按同局真实排名加权 · 可在设置里改）';
    }
  }

  global.DFViews = {
    renderOverview: renderOverview,
    renderWinRate: renderWinRate,
    renderMatches: renderMatches,
    renderDetail: renderDetail,
    renderMaps: renderMaps,
    renderClasses: renderClasses,
    renderEncounters: renderEncounters,
    renderEncounterDetail: renderEncounterDetail,
    renderMatrix: renderMatrix,
    renderPeriods: renderPeriods,
    renderRhythm: renderRhythm, renderRateRule: renderRateRule,
    drawMatchCard: drawMatchCard,
    modeText: modeText,
    /* 设置页那块「本机字典」的排版（#92）：数据由 app.js 从宿主取，这里只画 */
    mapDictHtml: mapDictHtml,
    /* 占点列的口径与标签：唯一一份，设置页 / 导出表头都读它（测试盯着别处不许再写一遍「占点」） */
    OCCUPY: OCC,
    esc: esc, fmt: fmt, kpiCards: kpiCards
  };
})(window);
