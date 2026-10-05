'use strict';
/* 变异桩（#84~#88 这一族：攻防身份、总对照、逐项对照、模式筛选走到哪一层、阵营格不许折行）。
 * 每条把实现改回"坏的样子"，确认 core §31 与那些静态红线真会红；跑完自动还原。
 * ★ 这一族里最险的一条不是判据写错，而是 #84 落地时我自己踩的那个：`campSide:` 被接到了
 *   对象字面量的 `};` 后面 —— 那是个合法的标签语句，node --check 全绿、界面照样画「—」，
 *   字段其实不存在。所以 C4/C5 这类针钉的是**字段在不在对象里**，不是"源码里有没有这个词"。
 * 单跑几针：node test/mutate-camp.js C1,C8
 * ★ 这套脚本会改源码再还原 —— 一次只准跑一套，别跟别的变异桩或编辑并行。
 * ★ views.js / app.css 是多行 CRLF 还是 LF 不一：这里的锚点一律取单行，免得栽行尾（K19 踩过）。 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const R = f => path.join(__dirname, '..', f);
const FILES = ['core/analysis.js', 'ui/js/views.js', 'ui/css/app.css',
  'shell/main.js', 'shell/preload.js', 'android/js/df-android.js', 'ui/js/app.js'];
const bak = {};
FILES.forEach(f => { bak[f] = fs.readFileSync(R(f), 'utf8'); });
function restore() { FILES.forEach(f => fs.writeFileSync(R(f), bak[f])); }
function patch(file, from, to) {
  const src = fs.readFileSync(R(file), 'utf8');
  if (src.indexOf(from) === -1) throw new Error('锚点没找到: ' + file + ' :: ' + from.slice(0, 52));
  fs.writeFileSync(R(file), src.split(from).join(to));
}
function run(suite) {
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, suite)],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 << 20 });
  const out = r.stdout || '';
  const fails = out.split('\n').filter(l => /^ *FAIL /.test(l)).map(l => l.trim().slice(0, 96));
  /* 跑不起来 / 跑完了却没打总结行 ⇒ 一律算"没测到"，绝不当通过 */
  if (r.error || r.status === null || !/全部通过|项失败|测试异常/.test(out)) {
    return ['!! 套件没跑完（status=' + r.status + ' err=' + (r.error && r.error.message) +
      ' 尾部=' + out.slice(-140).replace(/\s+/g, ' ') + '!!'];
  }
  return fails;
}
function both() { return run('core.test.js').concat(run('android-shim.test.js')); }

const AN = 'core/analysis.js', VW = 'ui/js/views.js', CS = 'ui/css/app.css',
  MJ = 'shell/main.js', PL = 'shell/preload.js', AD = 'android/js/df-android.js',
  AP = 'ui/js/app.js';

const MUT = [
  /* —— 判据本体 —— */
  ['C1 color 的含义反过来（1 说成防守）——他给的四条真值当场对不上三条', () => patch(
    AN, "return m.color === 1 ? '进攻' : (m.color === 2 ? '防守' : '');",
      "return m.color === 1 ? '防守' : (m.color === 2 ? '进攻' : '');")],
  ['C2 把模式门槛加回去（#90 的回归：胜者为王那一发又成了「—」，他点名的就是这条）', () => patch(
    AN, 'function sideOf(m) {\n    if (!m) return \'\';',
      "function sideOf(m) {\n    if (!m || !SIDE_RULES[m.game_rule]) return '';")],
  ['C3 color 缺失时猜成进攻（0 也算数）', () => patch(
    AN, "return m.color === 1 ? '进攻' : (m.color === 2 ? '防守' : '');",
      "return m.color === 1 ? '进攻' : '防守';")],
  ['C4 只给我方那一侧算身份，对方那一列空掉（榜上两侧不对等）', () => patch(
    AN, 'campSide: sideOf({ game_rule: m.game_rule, color: p.color }) };',
      'campSide: mine ? sideOf({ game_rule: m.game_rule, color: p.color }) : \'\' };')],
  ['C5 series 不带身份 ⇒ 战局列表那一格永远没有攻防', () => patch(
    AN, 'side: sideOf(m), rule: m.game_rule,', 'rule: m.game_rule,')],
  ['C6 地图分析不拆两侧（每行那两个桶恒空，列就是装饰）', () => patch(
    AN, 's.atk = summarize(x.rows.filter(function (m) { return sideOf(m) === \'进攻\'; }));',
      's.atk = null;')],
  ['C7 样本不足也照样下"哪边更稳"的结论（区间还没给出来）', () => patch(
    AN, 'var decisive = !!(a && d && a.ci && d.ci && (a.ci.lo > d.ci.hi || d.ci.lo > a.ci.hi));',
      'var decisive = !!(a && d);')],
  ['C8 界面自己再判一次 color（判据出现第二份，core 那条改了也没用）', () => patch(
    VW, "'\">' + esc(p.campLabel) + '</td>';",
      "'\">' + esc(p.campLabel) + (p.campId === 1 ? '进攻' : '防守') + '</td>';")],
  ['C9 阵营格退回「我方（胜）」的写法（#88 那一格就是这么折成两行的）', () => patch(
    VW, "'\">' + esc(p.campLabel) + '</td>';",
      "'\">' + esc(p.campLabel) + (p.campWin ? '（胜）' : '（负）') + '</td>';")],
  ['C10 CSS 里那句 nowrap 摘掉（窄榜一挤就又分两行）', () => patch(
    CS, '.camp { white-space: nowrap; }', '.camp { }')],
  ['C11 攻防那一格并进阵营格里、sideCell 不再被调用（列数与表头配不上对）', () => patch(
    VW, "'</td>' + campCell(p) + sideCell(p) +", "'</td>' + campCell(p) +")],
  ['C12 地图表那列只剩一侧（攻不算了）', () => patch(
    VW, "'</td><td>' + fmt(m.scorePerMin) + '</td>' + sideTd(m) +",
      "'</td>' + fmt(m.scorePerMin) + '</td>' +")],
  ['C13 顶部那张总对照不画（core 算好了但页面上看不见）', () => patch(
    VW, "el('mapBox').innerHTML = sideSummaryHtml(rep.sides) +",
      "el('mapBox').innerHTML =")],
  ['C14 交手档案里逐项对照不挂上页面（#86 那几列白算）', () => patch(
    VW, 'kpis + compareHtml(d.compare) +', 'kpis +')],
  /* —— 模式筛选这一路（#87）：每一层都可能"参数写了但没往下传" —— */
  ['C15 「对手与队友」又用回全库索引（选什么模式都一动不动 —— 就是他报的那条）', () => patch(
    AN, 'var e = encounters(store, encIdx);', 'var e = encounters(store, idIdx);')],
  ['C16 交手档案里把筛选参数丢掉（函数签名带着、函数体不用）', () => patch(
    AN, 'var idx = buildIdentityIndex(store, f);', 'var idx = buildIdentityIndex(store);')],
  ['C17 界面调用不带 FILTERS（手机端与桌面端一起失效）', () => patch(
    AP, 'global.df.encounterDetail(key, FILTERS)', 'global.df.encounterDetail(key)')],
  ['C18 预载层只转发一个参数（渲染层带了也到不了主进程）', () => patch(
    PL, "ipcRenderer.invoke('data:encounter', vopenid, filters)",
      "ipcRenderer.invoke('data:encounter', vopenid)")],
  ['C19 桌面主进程把 filters 丢了', () => patch(
    MJ, 'Analysis.encounterDetail(store, vopenid, filters || {})',
      'Analysis.encounterDetail(store, vopenid)')],
  ['C20 安卓那一发没同步改（两端不一致：手机筛选照旧无效）', () => patch(
    AD, 'Core.Analysis.encounterDetail(store, vopenid, filters || {})',
      'Core.Analysis.encounterDetail(store, vopenid)')],
  ['C21 桌面壳不给战局行贴 side（列表那一格从此空白）', () => patch(
    MJ, 'side: Analysis.sideOf(m),', '')],
  ['C22 安卓壳不给战局行贴 side（同一句话只在电脑上说得出）', () => patch(
    AD, 'side: Core.Analysis.sideOf(m),', '')],
  /* —— 累计口径（#86 最容易写歪的一处）—— */
  ['C23 对照表里的 KPM 不按时长地板筛（同场 60 秒也敢给"每分钟 4 杀"）', () => patch(
    AN, 'kpm: sec >= KPM_MIN_SEC ? r2(kill / (sec / 60)) : null,',
      'kpm: r2(kill / (sec / 60) || 0),')],
  ['C24 不足时长那两列回 0 而不是 null（0 会被读成"一分钟一个都没杀"）', () => patch(
    AN, 'spm: sec >= KPM_MIN_SEC ? Math.round(score / (sec / 60)) : null,',
      'spm: sec >= KPM_MIN_SEC ? Math.round(score / (sec / 60)) : 0,')],
  /* —— 整批都是胜者为王的那台机器（真机现状）：两侧都没数时说什么、画不画 —— */
  ['C25 两侧都没数时还念"只抓到一侧"（对着不存在的数据编方向）', () => patch(
    AN, 'out.headline = (!a && !d)', 'out.headline = (!a && !d && false)')],
  ['C26 两侧都没数时把那块对照整块藏掉（使用者读成"这栏没做"）', () => patch(
    VW, 'if (!sp.attack && !sp.defend) {', 'if (false) {')],
  ['C27 逐张对照算了却没接到 report 上（#91：那一块整张表永远不会出现）', () => patch(
    AN, 'mapSides: sideByMap(byMap(store, rows)),', '')],
  ['C28 界面不画逐张那张表（core 给了也不接 —— 红线只钉函数存在时它照样绿）', () => patch(
    VW, 'sideSummaryHtml(rep.sides) + mapSidesHtml(rep.mapSides)', 'sideSummaryHtml(rep.sides)')],
  ['C29 逐张表把只打过一侧的图也算进来（对面是 0 场，读起来像"另一边全输"）', () => patch(
    AN, '.filter(function (m) { return m.atk && m.def; })', '.filter(function (m) { return m.atk || m.def; })')],
  ['C30 逐张那一栏不问区间重叠就下"更稳"（跟 sideSplit 用了两把尺）', () => patch(
    AN, 'var decisive = !!(m.atk.ci && m.def.ci &&', 'var decisive = !!(m.atk && m.def &&')],
];

const ONLY = (process.argv[2] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const SELECTED = ONLY.length ? MUT.filter(m => ONLY.some(id => m[0].toUpperCase().startsWith(id + ' '))) : MUT;
if (!SELECTED.length) { console.log('一条都没匹配上：' + ONLY.join(',')); process.exit(1); }

/* 只验锚点、不跑套件：DF_ANCHOR_AUDIT=1 node test/mutate-camp.js
 * 锚点只留这一份（审计工具不许抄第二份） */
if (process.env.DF_ANCHOR_AUDIT === '1') {
  let bad = 0;
  SELECTED.forEach(function (m) {
    restore();
    try { m[1](); console.log('  锚点在 ' + m[0]); }
    catch (e) { bad++; console.log('  !!! ' + m[0] + ' → ' + e.message); }
  });
  restore();
  console.log('mutate-camp：' + (bad ? bad + ' 针打不上' : '锚点全在'));
  process.exit(bad ? 1 : 0);
}

restore();
const base = both();
if (base.length) {
  console.log('× 基线就不绿：这套桩的结论不能用（' + base.slice(0, 3).join(' | ') + '）');
  process.exit(1);
}
console.log('基线：core + 安卓桥 全绿（' + MUT.length + ' 针待打）');

let missed = 0;
SELECTED.forEach(function (m) {
  restore();
  try {
    m[1]();
    const fails = both();
    const bit = fails.length > 0;
    if (!bit) missed++;
    console.log('\n' + m[0] + ' → ' + (bit ? 'RED ' + fails.length + ' 条' : '!!! 没咬住 !!!'));
    fails.slice(0, 3).forEach(l => console.log('      ' + l));
  } catch (e) {
    missed++;
    console.log('\n' + m[0] + ' → 变异没打上：' + e.message);
  }
});
restore();
const out = both();
console.log('\n还原后：' + (out.length ? '仍有 FAIL：' + out.slice(0, 3).join(' | ')
  : 'core + 安卓桥 全部通过'));
console.log(missed ? '>>> ' + missed + ' 针没咬住（这套判据不算立住）'
  : '>>> ' + SELECTED.length + ' 针全部咬住');
process.exit(missed || out.length ? 1 : 0);
