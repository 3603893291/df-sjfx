'use strict';
/* probe-camp.js —— 量「进攻方 / 防守方」到底能不能从官方给回来的字段里推出来（只读，不改库）。
 *
 * 为什么要这颗工具：官方名单里只有 `color`（1/2）与 `team_id`（12 个班号），
 * 抓包原文与官方 bundle 里都搜不到 camp/attack/defend 这类字段 ⇒ 只能反过来推：
 * 由使用者在游戏里报几条"这一把我方是进攻方"的地面真值，再拿候选规则去逐条对。
 * ★ 这条规则一旦定下来就是**数据契约**，判据只准长在 core/analysis.js 一处，
 *   工具与界面都只搬运；地面真值不够就多要几条，不许靠猜。
 *
 * 跑法：
 *   node tools/probe-camp.js --dump                     列出每场的候选字段（不打任何玩家名）
 *   node tools/probe-camp.js --labels="09-26 03:29=进攻,09-25 03:11=防守"
 *                                                       拿地面真值逐条试候选规则
 *   node tools/probe-camp.js --db=<路径>                默认 %APPDATA%\df-swtwr\df-swtwr-a1.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name, dflt) {
  const hit = process.argv.find(a => a.indexOf('--' + name + '=') === 0);
  return hit ? hit.slice(name.length + 3) : (process.argv.indexOf('--' + name) >= 0 ? true : dflt);
}
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DB = arg('db', path.join(APPDATA, 'df-swtwr', 'df-swtwr-a1.json'));
if (!fs.existsSync(DB)) { console.log('× 读不到库文件：' + DB); process.exit(1); }

const data = JSON.parse(fs.readFileSync(DB, 'utf8'));
const matches = data.matches || {};
const rosters = data.rosters || {};
const Maps = require(path.join(__dirname, '..', 'core', 'maps.js'));

/* ★ start_time 存的是**秒**，不是毫秒（拿 new Date(秒) 去格式化会全部落在 1970-01-22，
 *    我第一版就是这么把自己的量测读成废数据的）。低于 1e12 一律当秒。 */
function ms(m) { const v = m.start_time || 0; return v < 1e12 ? v * 1000 : v; }
function local(m) {
  const d = new Date(ms(m));
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes());
}

const rows = Object.keys(matches).map(k => matches[k]).filter(Boolean)
  .sort((a, b) => ms(b) - ms(a));

console.log('库文件：' + DB);
console.log('战绩 ' + rows.length + ' 场 / 名单 ' + Object.keys(rosters).length + ' 份');

if (arg('dump')) {
  console.log('\n时间            地图(id/rule/sw)         我方color team 胜负 result 占点 救治 时长  得分  击杀  名单两边占点');
  rows.forEach(function (m) {
    const rid = String(m.room_id);
    const r = rosters[rid];
    let sides = '—';
    if (r && r.players && r.players.length) {
      const by = {};
      r.players.forEach(function (p) {
        const c = String(p.color);
        by[c] = by[c] || { n: 0, occ: 0, res: 0, teams: new Set() };
        by[c].n++; by[c].occ += p.occupy || 0; by[c].res += p.rescue || 0;
        by[c].teams.add(p.team_id);
      });
      sides = Object.keys(by).sort().map(function (c) {
        return 'c' + c + ':' + by[c].n + '人/占' + by[c].occ + '/救' + by[c].res +
          '/' + by[c].teams.size + '队';
      }).join(' | ');
    }
    console.log(local(m).padEnd(15) + ' ' +
      String(m.map_name || Maps.nameOf(m.map_id) || '?').slice(0, 8).padEnd(9) +
      String(m.map_id).padStart(4) + ' r' + String(m.game_rule).padStart(3) +
      ' sw' + m.is_swtwr + '   ' +
      String(m.color).padStart(3) + ' ' + String(m.team_id).padStart(3) + ' ' +
      (m.is_winner ? '胜' : '负') + '   ' + String(m.game_result).padStart(3) + '  ' +
      String(m.occupy).padStart(4) + ' ' + String(m.rescue).padStart(4) + ' ' +
      String(Math.round((m.game_time || 0) / 60)).padStart(3) + 'm ' +
      String(m.score).padStart(6) + ' ' + String(m.kill).padStart(3) + '  ' + sides);
  });
  process.exit(0);
}

/* ---- 拿地面真值试候选规则 ---- */
const LABELS = arg('labels', '');
if (!LABELS) { console.log('\n（加 --dump 看全表；加 --labels="MM-DD HH:MM=进攻,..." 试规则）'); process.exit(0); }

const wanted = LABELS.split(',').map(function (s) {
  const p = s.split('=');
  return { time: p[0].trim(), side: p[1].trim() };
}).filter(x => x.time && x.side);

console.log('\n地面真值 ' + wanted.length + ' 条：');
const found = [];
wanted.forEach(function (w) {
  const hit = rows.filter(function (m) {
    const t = local(m);
    return t.indexOf(w.time) >= 0 || t.slice(5).replace(' ', '') === w.time.replace(' ', '') ||
      t.slice(11) === w.time;         // 只写 HH:MM 也认
  });
  if (!hit.length) { console.log('  × ' + w.time + ' 没匹配上（库里没有这一场，或时间写的是下午）'); return; }
  hit.forEach(function (m) {
    const t = local(m);
    console.log('  ' + t + '  ' + (m.map_name || Maps.nameOf(m.map_id)) + '(map=' + m.map_id +
      ' rule=' + m.game_rule + ' swtwr=' + m.is_swtwr + ')' +
      ' 我方color=' + m.color + ' team=' + m.team_id + ' 胜负=' + (m.is_winner ? '胜' : '负') +
      ' ⇒ 他说是【' + w.side + '】');
    found.push({ m: m, side: w.side, time: t });
  });
});

if (!found.length) { console.log('一条都没配上，规则没法试。'); process.exit(1); }

/* 候选规则：给定这一场与我方的 color，返回"我方是进攻方吗" */
const RULES = [
  ['R1 color===1 就是进攻方', m => m.color === 1],
  ['R2 color===2 就是进攻方', m => m.color === 2],
  ['R3 进攻方 ⇔ 我方占点更多（名单两边占点合计比出来的）', function (m) {
    const r = rosters[String(m.room_id)];
    if (!r || !r.players || !r.players.length) return null;
    const occ = {};
    r.players.forEach(function (p) { occ[p.color] = (occ[p.color] || 0) + (p.occupy || 0); });
    const mine = occ[m.color] || 0, other = Object.keys(occ).reduce(function (a, k) {
      return k === String(m.color) ? a : a + occ[k];
    }, 0);
    return mine < other;          // 占点少的那边当进攻方（假设：防守方守着点所以占点高）
  }],
  ['R4 进攻方 ⇔ 我方救治更少', function (m) {
    const r = rosters[String(m.room_id)];
    if (!r || !r.players || !r.players.length) return null;
    const res = {};
    r.players.forEach(function (p) { res[p.color] = (res[p.color] || 0) + (p.rescue || 0); });
    const mine = res[m.color] || 0, other = Object.keys(res).reduce(function (a, k) {
      return k === String(m.color) ? a : a + res[k];
    }, 0);
    return mine < other;
  }],
  ['R5 进攻方 ⇔ 我方输（攻防里守点方常算胜方）', m => !m.is_winner],
];

console.log('\n候选规则对着地面真值逐条判：');
RULES.forEach(function (r) {
  let ok = 0, no = 0, na = 0;
  const detail = found.map(function (f) {
    const isAtk = r[1](f.m);
    if (isAtk === null || isAtk === undefined) { na++; return f.time.slice(5) + ':—'; }
    const guess = isAtk ? '进攻' : '防守';
    if (guess === f.side) { ok++; return f.time.slice(5) + ':✓'; }
    no++; return f.time.slice(5) + ':✗(猜' + guess + ')';
  });
  console.log('  ' + r[0].padEnd(46) + ' 对 ' + ok + ' / 错 ' + no + ' / 没法判 ' + na + '   ' + detail.join(' '));
});
console.log('\n★ 只有"对全部、错 0"的规则才够格写进 core；否则就要更多地面真值，不许拿半对的规则上线。');
