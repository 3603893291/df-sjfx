/* 量测（只读，不进 npm test）：`occupy` 这一列到底是什么量纲 —— 是游戏里那个「站点分」，还是占点次数？
 * 对比三处：战局列表行、全场名单里所有人、以及同一场名单里我自己那行的其它列尺度。
 * 用法：node test/audit-occupy-scale.js */
'use strict';
const fs = require('fs');
const path = require('path');
const j = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'df-swtwr', 'df-swtwr-a1.json'), 'utf8'));
const me = String(j.meta.openid);
const med = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const rows = Object.keys(j.matches).map(k => ({ m: j.matches[k], r: j.rosters[k] })).filter(x => x.r);

console.log('场次', Object.keys(j.matches).length, '带名单', rows.length, '\n');
const col = f => rows.map(x => Number(x.m[f] || 0));
['kill', 'death', 'assist', 'score', 'occupy', 'rescue', 'game_time'].forEach(function (f) {
  const v = col(f);
  console.log(('列表·' + f).padEnd(16),
    '0 的场次 ' + String(v.filter(x => !x).length).padStart(2) + '/' + v.length,
    ' 最小 ' + String(Math.min.apply(null, v)).padStart(6),
    ' 中位 ' + String(med(v)).padStart(7),
    ' 最大 ' + String(Math.max.apply(null, v)).padStart(7));
});

console.log('\n名单里某一列的"全场分布"（看它是每人小整数还是分数）：');
['kill', 'score', 'occupy', 'rescue'].forEach(function (f) {
  const all = [];
  rows.forEach(x => x.r.players.forEach(p => all.push(Number(p[f] || 0))));
  console.log(('名单·' + f).padEnd(16), '人次 ' + all.length,
    ' 0 的占比 ' + (all.filter(v => !v).length / all.length * 100).toFixed(0) + '%',
    ' 最小 ' + Math.min.apply(null, all), ' 中位 ' + med(all), ' 最大 ' + Math.max.apply(null, all));
});

console.log('\n逐场：列表 occupy / 名单里我的 occupy / 名单 occupy 之和 / 我这场总分 与 时长');
rows.map(x => x.m).sort((a, b) => a.start_time - b.start_time).forEach(function (m) {
  const r = j.rosters[m.room_id];
  const mine = (r.players.filter(p => String(p.vopenid) === me)[0]) || {};
  const sum = r.players.reduce((t, p) => t + (p.occupy || 0), 0);
  console.log('  ' + (m.dt_event_time || '').slice(5, 16) + ' ' + String(m.map_name).slice(0, 12).padEnd(14) +
    ' 时长' + String(Math.round((m.game_time || 0) / 60)).padStart(4) + '分' +
    ' 列表占点=' + String(m.occupy).padStart(3) +
    ' 名单我=' + String(mine.occupy === undefined ? '—' : mine.occupy).padStart(3) +
    ' 名单之和=' + String(sum).padStart(4) + ' 我总分=' + String(m.score).padStart(6));
});
