'use strict';
/* 开发者脚本（不进 npm test、不进交付包）：**先量后用** —— 量"Elo + 下一场胜率预测"在这份库上能做几成。
 *
 *   node tools/audit-elo-feasibility.js                 # 只读他自己那份库，一个字节都不写
 *   node tools/audit-elo-feasibility.js --warm=15 --k=48   # 换"养评分的场数"与 K 再量一遍
 *   node tools/audit-elo-feasibility.js --file=<路径>   # 换库（默认就是当前这台机器上 a1 那一份）
 *
 * 他要的是"把现有的对战数据拿来算 Elo，预测下一场的胜率"。这句话里藏了四个必须先量死的前置问题，
 * 任何一个不达标，"预测胜率"就是给噪声套了个小数：
 *   ① 一场的队伍能不能凑出来（官方名单里 team_id 是小队、color 才是对阵的两边）；
 *   ② 交手稠密度 —— 每场面对的人有多少是"打过交道的"，这决定 Elo 序列是不是稠密；
 *   ③ 时间外回测：用**过去**建的 Elo 预测**未来**那一场，命中率比"猜多数类"高多少 ——
 *      这一条是唯一的裁判，比它高不了多少就说明现在给不出可信预测；
 *   ④ 分数差能不能用（官方名单只有每人自己的 score，没有双方总分）。
 * ★ 全程只读，只打印数量、比例与命中率：昵称、openid、单场 id 一律不出现（那是别人的身份）。
 */
const fs = require('fs');
const path = require('path');

function arg(name, dflt) {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(hit.indexOf('=') + 1) : dflt;
}
const FILE = arg('file', path.join(process.env.APPDATA || '', 'df-swtwr', 'df-swtwr-a1.json'));
const WARM = Math.max(5, Number(arg('warm', 20)));      // 前多少场只用来"养"评分，不做验收
const K = Number(arg('k', 24));
const START = Number(arg('start', 1000));
if (!fs.existsSync(FILE)) { console.log('× 没有这份库：' + FILE); process.exit(1); }
const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const me = String((j.meta && j.meta.openid) || '');
const ms = j.matches || {}, rs = j.rosters || {};

/* 名单里认自己的那一条：core 用的就是这一颗判据（vopenid === 本机 openid），不许在这里发明第二种 */
function selfOf(pl) { for (let i = 0; i < pl.length; i++) if (String(pl[i].vopenid) === me) return pl[i]; return null; }

const all = Object.keys(ms).map((k) => ms[k]).filter((m) => m && m.start_time);
const usable = all.filter((m) => {
  const r = rs[String(m.room_id)];
  return r && (r.players || []).length >= 10 && selfOf(r.players);
});
console.log('库：' + path.basename(FILE));
console.log('① 样本量与队伍结构');
console.log('   场次=' + all.length + '（其中胜者为王 ' + all.filter((m) => m.is_swtwr).length + ' 场）' +
  '  有名单且能在名单里认出自己=' + usable.length + ' 场');
const ts = usable.map((m) => m.start_time);
const spanDays = (Math.max.apply(null, ts) - Math.min.apply(null, ts)) / 86400;
console.log('   时间跨度=' + spanDays.toFixed(1) + ' 天，日均 ' + (usable.length / Math.max(1, spanDays)).toFixed(2) + ' 场');
const sizes = [], sides = new Map(), squadCount = [];
usable.forEach(function (m) {
  const pl = rs[String(m.room_id)].players;
  sizes.push(pl.length);
  const t = {};
  pl.forEach(function (p) { t[String(p.team_id)] = 1; const c = String(p.color); sides.set(c, (sides.get(c) || 0) + 1); });
  squadCount.push(Object.keys(t).length);
});
const med = function (a) { return a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0; };
console.log('   名单人数中位=' + med(sizes) + '  每场小队数中位=' + med(squadCount) +
  '  颜色（对阵的两边）取值=' + [...sides.entries()].map(function (e) { return e[0] + ':' + e[1] + '席'; }).join(' '));
console.log('   ★ 结构判读：官方名单里 team_id 是 4~6 人一小队（一场十几支），真正的对阵是 color 那两边（各约 ' +
  Math.round(med(sizes) / 2) + ' 人）。所以 Elo 只能记在"我这一边 vs 对面那一边"这一层，' +
  '小队每场重新拼 —— 想给"我的固定队伍"算 Elo，这份数据里压根没有那支固定队伍');

/* ② 交手稠密度 */
const appearances = new Map();
usable.forEach(function (m, idx) {
  (rs[String(m.room_id)].players || []).forEach(function (p) {
    const k = String(p.vopenid);
    const a = appearances.get(k) || { seats: 0, first: idx };
    a.seats++; appearances.set(k, a);
  });
});
let seats = 0, repeatSeats = 0;
appearances.forEach(function (a) { seats += a.seats; if (a.seats >= 2) repeatSeats += a.seats; });
const maxSeen = Math.max.apply(null, [...appearances.values()].map(function (a) { return a.seats; }));
console.log('② 交手稠密度（Elo 序列够不够长）');
console.log('   出现过的人=' + appearances.size + '  总席位=' + seats + '  平均每人在 ' + (seats / appearances.size).toFixed(2) + ' 场里露面' +
  '（最多的人 ' + maxSeen + ' 场）');
console.log('   落在"见过第二次及以上"的席位比例=' + (100 * repeatSeats / seats).toFixed(1) + '%');
console.log('   ★ 判读：接近一半席位是重逢，说明有稳定的对手池；但人均露面只有 ' + (seats / appearances.size).toFixed(2) +
  ' 场 —— 对面 22 个人的评分几乎全是冷启动值，模型里那一侧基本是"未知的 1000 分"');

/* ③ 走查式回测：第 i 场只用前 i-1 场建出来的评分预测，之后才把结果喂回评分（不许用未来） */
function walkForward(marginMode) {
  const rating = new Map();
  const R = function (k) { if (!rating.has(k)) rating.set(k, START); return rating.get(k); };
  const rows = usable.slice().sort(function (a, b) { return a.start_time - b.start_time; });
  const pred = [];
  rows.forEach(function (m, i) {
    const pl = rs[String(m.room_id)].players;
    const mine = selfOf(pl);
    const myColor = String(mine.color);
    const us = [], them = [];
    pl.forEach(function (p) { (String(p.color) === myColor ? us : them).push(p); });
    if (!them.length) return;
    const eu = us.reduce(function (a, p) { return a + R(String(p.vopenid)); }, 0) / us.length;
    const et = them.reduce(function (a, p) { return a + R(String(p.vopenid)); }, 0) / them.length;
    const exp = 1 / (1 + Math.pow(10, (et - eu) / 400));
    pred.push({ i: i, exp: exp, win: !!m.is_winner });
    /* 赛后更新：两边各按结果与期望之差吃到 K（marginMode 给的就是官方能给的那点信息） */
    const actual = m.is_winner ? 1 : 0;
    let mult = 1;
    if (marginMode === 'score') {
      const su = us.reduce(function (a, p) { return a + (Number(p.score) || 0); }, 0) / us.length;
      const st = them.reduce(function (a, p) { return a + (Number(p.score) || 0); }, 0) / them.length;
      /* 幅度只该放大 K、不该偏心：赢 20% 与输 20% 用同一个倍数（|比值-1| 是对称的） */
      const rel = Math.abs(su / Math.max(1, st) - 1);
      mult = Math.min(3, 1 + rel * 2);
    }
    const dK = K * mult * (actual - exp);
    us.forEach(function (p) { rating.set(String(p.vopenid), R(String(p.vopenid)) + dK); });
    them.forEach(function (p) { rating.set(String(p.vopenid), R(String(p.vopenid)) - dK); });
  });
  return pred;
}
function report(pred, label) {
  const test = pred.slice(WARM);
  const fit = pred.slice(0, WARM);
  if (test.length < 3) { console.log('   ' + label + '：验收段只有 ' + test.length + ' 场，跑不动'); return null; }
  const baseRate = fit.reduce(function (a, x) { return a + (x.win ? 1 : 0); }, 0) / Math.max(1, fit.length);
  let hit = 0, hitBase = 0, brier = 0, brierBase = 0;
  test.forEach(function (x) {
    hit += (x.win === (x.exp >= 0.5)) ? 1 : 0;
    hitBase += (x.win === (baseRate >= 0.5)) ? 1 : 0;
    brier += Math.pow(x.exp - (x.win ? 1 : 0), 2);
    brierBase += Math.pow(baseRate - (x.win ? 1 : 0), 2);
  });
  const n = test.length;
  const acc = 100 * hit / n, accBase = 100 * hitBase / n;
  const meanExp = test.reduce(function (a, x) { return a + x.exp; }, 0) / n;
  const meanAct = test.reduce(function (a, x) { return a + (x.win ? 1 : 0); }, 0) / n;
  /* 二项分布的 ±：n 这么小的时候，差异多半落在噪声里 —— 直接把误差条打出来，别只打个百分数 */
  const se = 100 * Math.sqrt(0.25 / n);
  console.log('   ' + label + '：验收 ' + n + ' 场  命中 ' + acc.toFixed(1) + '%（±' + se.toFixed(1) + 'pp 是 1 个标准误）' +
    ' vs 猜多数类 ' + accBase.toFixed(1) + '%  ｜ Brier ' + (brier / n).toFixed(3) + ' vs 常数基线 ' + (brierBase / n).toFixed(3));
  console.log('      预测均值=' + (100 * meanExp).toFixed(1) + '%  实际胜率=' + (100 * meanAct).toFixed(1) +
    '%  差=' + (100 * (meanAct - meanExp)).toFixed(1) + 'pp（这就是标定偏差；前 ' + WARM + ' 场只用来养评分，其中评分还都在冷启动区）');
  return { n: n, acc: acc, accBase: accBase, se: se, gap: acc - accBase, drift: 100 * (meanAct - meanExp) };
}
console.log('③ 时间外（走查式）回测：第 i 场只用前 i-1 场的评分预测，预测完才喂结果');
const rBin = report(walkForward('none'), '二值 Elo（只看输赢）');
const rMgn = report(walkForward('score'), '带分差 Elo（用每人 score 的队均比作 margin）');

/* ④ 官方给不给双方总分（决定分数差 Elo 是不是一等公民） */
const pk = Object.keys(rs)[0];
const keys = pk ? Object.keys((rs[pk].players || [])[0] || {}) : [];
console.log('④ 官方名单里每人一行的字段：' + keys.join(','));
console.log('   里面有每人自己的 score / kill / occupy，**没有**双方总分、没有局末比分、没有每队的 rating —— ' +
  '所以"分差 Elo"只能用本机自己算的队均分当 margin，官方没给现成的胜负幅度');

/* ⑤ 一句话结论：按量到的数推，不按意愿推 */
console.log('\n⑤ 量完之后能说什么');
if (!rBin || rBin.n < 10) {
  console.log('   ★ 验收段太短（' + (rBin ? rBin.n : 0) + ' 场）：现在给不出"下一场胜率"的可信小数，只能给区间与场数。');
} else {
  const better = rBin.gap > 2 * rBin.se;
  console.log('   二值 Elo 比"猜多数类"' + (better ? '高得出' : '高不出') + '（差 ' + rBin.gap.toFixed(1) +
    'pp，1 个标准误 ' + rBin.se.toFixed(1) + 'pp）—— ' + (better ? '方向上有信号，但样本还撑不起当结论' : '没差别，Elo 在这个样本量上不提供任何信息'));
  console.log('   标定偏差 ' + rBin.drift.toFixed(1) + 'pp：正数说明模型偏乐观，负数说明偏悲观。');
}
if (rMgn && rBin && rMgn.n === rBin.n) {
  console.log('   带分差那一档与二值那一档差 ' + (rMgn.acc - rBin.acc).toFixed(1) + 'pp（±' + rBin.se.toFixed(1) +
    'pp 内就是噪声）⇒ 分差这条信息现在买不到东西');
}
console.log('   稠密度：人均露面 ' + (seats / appearances.size).toFixed(2) + ' 场 ⇒ 对面那一侧的评分基本是冷启动值。' +
  '想真做出可用的预测，缺的不是算法而是场次：按现在日均 ' + (usable.length / Math.max(1, spanDays)).toFixed(2) +
  ' 场，攒到能压住 ±5pp 的量级还得几十到上百场。');

/* ⑥ 换个靶子量：队伍胜负量不出信号，那"他自己这一场的表现"呢？
 *    lag-1 自相关：上一场的个人分/击杀与这一场的相关有多强 —— 有相关才谈得上"预测我下一场"。
 *   相关系数的标准误 ≈ 1/√n（n=59 ⇒ ±0.13），所以 |r|<0.26 都在噪声里，别报成"稳定"。 */
function lag1(get) {
  const s = usable.slice().sort(function (a, b) { return a.start_time - b.start_time; }).map(get).filter(function (x) { return x != null && isFinite(x); });
  if (s.length < 8) return { n: s.length, r: NaN };
  const a = s.slice(0, -1), b = s.slice(1);
  const mean = function (v) { return v.reduce(function (x, y) { return x + y; }, 0) / v.length; };
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += Math.pow(a[i] - ma, 2); db += Math.pow(b[i] - mb, 2); }
  return { n: s.length, r: (da && db) ? num / Math.sqrt(da * db) : NaN };
}
const mineScore = function (m) { const p = selfOf(rs[String(m.room_id)].players); return p ? Number(p.score) : null; };
const mineKill = function (m) { const p = selfOf(rs[String(m.room_id)].players); return p ? Number(p.kill) : null; };
const winFlag = function (m) { return m.is_winner ? 1 : 0; };
const rScore = lag1(mineScore), rKill = lag1(mineKill), rWin = lag1(winFlag);
const seR = function (n) { return n > 2 ? 1 / Math.sqrt(n - 1) : NaN; };
console.log('⑥ 换个靶子：个人表现能不能延续（lag-1 自相关，±' + (100 * seR(rScore.n)).toFixed(0) + '% 是它自己的标准误）');
console.log('   我的单场分 r=' + (isFinite(rScore.r) ? rScore.r.toFixed(3) : '—') + '（n=' + rScore.n + '）' +
  '  我的击杀 r=' + (isFinite(rKill.r) ? rKill.r.toFixed(3) : '—') + '（n=' + rKill.n + '）' +
  '  胜负 r=' + (isFinite(rWin.r) ? rWin.r.toFixed(3) : '—') + '（n=' + rWin.n + '）');
console.log('   ★ 判读：' + (isFinite(rScore.r) && Math.abs(rScore.r) > 2 * seR(rScore.n)
  ? '个人分有延续性 ⇒ "我下一场的表现区间"这种预测现在就有料，比猜团队胜负靠谱得多'
  : '个人分也量不出延续性 ⇒ 现在连"我下一场打得怎么样"都给不出有信息的数'));

/* ⑦ 官方自己给不给评分 —— 名单行里有 isRankedMatch / rankMatchScore / realTotalRankedScore 三列，
 *    core 只把前两颗从**战局列表**那一份落到 match 上（is_ranked / rank_score），名单那一份没落。
 *    这里量的就是：那串 rank_score 到底是"会涨会跌的技能分（Elo）"还是"只涨不跌的累计进度"。 */
const rk = usable.filter(function (m) { return Number(m.is_ranked) === 1 && Number(m.rank_score) > 0; })
  .sort(function (a, b) { return a.start_time - b.start_time; });
console.log('⑦ 官方那两列（is_ranked / rank_score）到底是不是评分');
if (rk.length < 4) {
  console.log('   带 rank_score 的场次太少（' + rk.length + '），判不了');
} else {
  const s = rk.map(function (m) { return Number(m.rank_score); });
  const d = []; for (var i = 1; i < s.length; i++) d.push(s[i] - s[i - 1]);
  const up = d.filter(function (x) { return x > 0; }).length, down = d.filter(function (x) { return x < 0; }).length;
  const mean = d.reduce(function (a, x) { return a + x; }, 0) / d.length;
  const sd = Math.sqrt(d.reduce(function (a, x) { return a + (x - mean) * (x - mean); }, 0) / Math.max(1, d.length - 1));
  console.log('   排位场=' + rk.length + ' 场（全部 ' + usable.length + ' 场里 is_ranked=1 的）' +
    '  首=' + s[0] + ' 末=' + s[s.length - 1] + '  相邻差 均值=' + mean.toFixed(1) + ' 标准差=' + sd.toFixed(1));
  console.log('   涨 ' + up + ' 次 / 跌 ' + down + ' 次 ⇒ ' + (down === 0
    ? '**只涨不跌** ⇒ 这一列是累计进度（段位分累积），不是会随胜负波动的技能分 —— 官方没在本模式里给我们一个现成 Elo'
    : '有涨有跌 ⇒ 这一列带胜负信息，值得单独量一量能买多少'));
}

/* ⑧ 要多大样本才谈得上"预测提升"：把 ⑤ 那句"几十到上百场"换成能复算的式子 */
const perDay = usable.length / Math.max(1, spanDays);
const need = Math.ceil(Math.pow(1.96 + 0.84, 2) * 2 * 0.25 / Math.pow(0.05, 2));   // 检出 5pp 提升，80% 功效
console.log('⑧ 样本天花板（不是意愿，是算术）：要稳定检出 5pp 的命中率提升，验收段需要约 ' + need + ' 场；' +
  '按这台机器现在日均 ' + perDay.toFixed(2) + ' 场 ⇒ 约 ' + Math.round(need / Math.max(0.01, perDay)) + ' 天连续采集（' +
  (need / Math.max(0.01, perDay) / 365).toFixed(1) + ' 年）—— 而且官方窗口只回最近 36 场，中间断了就永久补不回来（见翻页自证那一行）');

/* ⑨ 那么"下一场的胜率"这句话，现在这份数据能撑到什么程度 —— 不给模型套小数：
 *    基线用 Wilson 区间（n=59 时二项区间宽到 ±13pp 是正常的），再加一条"上一场的胜负能不能用"的对照
 *    （那正是 Elo 想提供的东西：如果连上一场的结果都预测不了下一场，评分那一层的边际信息就只能落在噪声里）。 */
const seq = usable.slice().sort(function (a, b) { return a.start_time - b.start_time; });
function wilson(h, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = h / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [100 * (c - half), 100 * (c + half)];
}
const winsAll = seq.filter(function (m) { return m.is_winner; }).length;
const ciAll = wilson(winsAll, seq.length);
const last20 = seq.slice(-20), w20 = last20.filter(function (m) { return m.is_winner; }).length;
const ci20 = wilson(w20, last20.length);
const rateAll = 100 * winsAll / seq.length, rate20 = 100 * w20 / last20.length;
console.log('⑨ "下一场胜率"这句话，现在这份数据能撑到的程度');
console.log('   全部 ' + seq.length + ' 场：胜 ' + winsAll + ' 场 = ' + rateAll.toFixed(1) +
  '%（Wilson 95% 区间 ' + ciAll[0].toFixed(1) + '–' + ciAll[1].toFixed(1) + '%）');
console.log('   最近 ' + last20.length + ' 场：' + rate20.toFixed(1) + '%（区间 ' + ci20[0].toFixed(1) + '–' + ci20[1].toFixed(1) +
  '%）—— ' + (rate20 >= ciAll[0] && rate20 <= ciAll[1] ? '点值落在全区间内 ⇒ 状态位移量不出来' : '点值已跑出全区间 ⇒ 状态位移这一条有料，值得单独量'));
const cond = { w: [0, 0], l: [0, 0] };
for (let q = 1; q < seq.length; q++) {
  const key = seq[q - 1].is_winner ? 'w' : 'l';
  cond[key][0] += seq[q].is_winner ? 1 : 0; cond[key][1]++;
}
const cw = wilson(cond.w[0], cond.w[1]), cl = wilson(cond.l[0], cond.l[1]);
const pw = cond.w[0] / Math.max(1, cond.w[1]), pl = cond.l[0] / Math.max(1, cond.l[1]);
/* 两档之差的自己的标准误 —— 只打两档百分数会诱导人去看那个差，误差条必须一起给 */
const seDiff = 100 * Math.sqrt(pw * (1 - pw) / Math.max(1, cond.w[1]) + pl * (1 - pl) / Math.max(1, cond.l[1]));
console.log('   上一场赢了 → 这一场胜率 ' + (100 * pw).toFixed(1) + '%（n=' + cond.w[1] +
  '，区间 ' + cw[0].toFixed(1) + '–' + cw[1].toFixed(1) + '%）｜上一场输了 → ' +
  (100 * pl).toFixed(1) + '%（n=' + cond.l[1] + '，区间 ' + cl[0].toFixed(1) + '–' + cl[1].toFixed(1) + '%）');
console.log('   两档差=' + (100 * (pw - pl)).toFixed(1) + 'pp，而这个差的标准误=' + seDiff.toFixed(1) + 'pp ⇒ ' +
  (Math.abs(pw - pl) * 100 < seDiff
    ? '差还没到 1 个标准误 ⇒ "上一场的结果"这一条都量不出信息，而 Elo 想提供的正是它'
    : '差超过 1 个标准误 ⇒ 至少"上一场结果"是有用的，只是评分那一层（③）现在还没挣到'));
console.log('   ★ 现在唯一诚实可给的下一场胜率 = ' + rateAll.toFixed(0) + '%（区间 ' + ciAll[0].toFixed(0) + '–' + ciAll[1].toFixed(0) +
  '%）。Elo 给出的任何一个数只要落进这段，就与这个基线**无法区分** —— ③ 里那 ' +
  (rBin && isFinite(rBin.acc) ? rBin.acc.toFixed(1) : '—') + '% vs ' +
  (rBin && isFinite(rBin.accBase) ? rBin.accBase.toFixed(1) : '—') + '% 正是这个意思。');


