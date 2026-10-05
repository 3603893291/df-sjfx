'use strict';
/* 变异桩（#79 KPM 与 #80 阵营 / 关注高亮这一族，外加 #81 那条文案）。
 * 每条把实现改回"坏的样子"，确认 core §30 与那些静态红线真的会红；跑完自动还原。
 * 单跑几针：node test/mutate-kpm.js K1,K4
 * ★ 这套脚本会改源码再还原 —— 一次只准跑一套，别跟别的套件或编辑并行。 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const R = f => path.join(__dirname, '..', f);
const FILES = ['core/analysis.js', 'ui/js/views.js', 'ui/index.html',
  'shell/main.js', 'android/js/df-android.js', 'shell/plugin-api.js'];
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
  const fails = out.split('\n').filter(l => /^ *FAIL /.test(l)).map(l => l.trim().slice(0, 92));
  /* 跑不起来 / 没打总结行 ⇒ "没测到"，绝不当通过 */
  if (r.error || r.status === null || !/全部通过|项失败/.test(out)) {
    return ['!! 套件没跑完（status=' + r.status + ' err=' + (r.error && r.error.message) +
      ' 尾部=' + out.slice(-120).replace(/\s+/g, ' ') + '!!'];
  }
  return fails;
}
function both() { return run('core.test.js').concat(run('android-shim.test.js')); }

const AN = 'core/analysis.js', VW = 'ui/js/views.js', HT = 'ui/index.html',
  MJ = 'shell/main.js', AD = 'android/js/df-android.js', PA = 'shell/plugin-api.js';

const MUT = [
  ['K1 把时长地板调成 0 秒（8 秒 3 杀那位重新爬上榜首）', () => patch(
    AN, 'var KPM_MIN_SEC = 300;', 'var KPM_MIN_SEC = 0;')],
  ['K2 KPM 榜不按地板筛人（榜是排了，排的是假数）', () => patch(
    AN, 'var eligible = players.filter(kpmEligible).map(annotate)',
      'var eligible = players.map(annotate)')],
  ['K3 被挡在榜外的人数不报（"全场 61 人的榜"其实只排了 48 人）', () => patch(
    AN, 'thin: total - eligible.length, myThin: mine < 0,',
      'thin: 0, myThin: mine < 0,')],
  ['K4 总报告里不给 KPM 榜', () => patch(AN, 'kpm: kpmBoardOf()\n', '')],
  ['K5 击杀列不可信时 KPM 榜不作废（半份名单也能排出一个假第一）', () => patch(
    AN, "var GAP_RANKS = { kill: ['kill', 'kda', 'kpm'] };",
      "var GAP_RANKS = { kill: ['kill', 'kda'] };")],
  ['K6 阵营那一格退回官方编号 1 / 2（他报的第④条原样复发）', () => patch(
    AN, "campLabel: mine ? '我方' : '对方'", "campLabel: mine ? '1' : '2'")],
  ['K7 名单里不再标"时长太短"（星号消失，读者拿 13.85 去比 3.22）', () => patch(
    AN, 'kpm: kpmOf(p), kpmThin: !kpmEligible(p),', 'kpm: kpmOf(p), kpmThin: false,')],
  ['K8 三张老榜不 annotate（阵营列与关注高亮在榜上全丢 = 第⑤条没修）', () => patch(
    AN, '      }).map(annotate);', '      });')],
  ['K9 序列里时长缺失的那场回 0 而不是 null（折线图画成"这场一个都没杀"）', () => patch(
    AN, 'killPerMin: (m.game_time || 0) > 0 ? r2((m.kill || 0) / (m.game_time / 60)) : null,',
      'killPerMin: (m.game_time || 0) > 0 ? r2((m.kill || 0) / (m.game_time / 60)) : 0,')],
  ['K10 总览那枚 KPM 拿场均击杀顶（分母换了人，名字还叫 KPM）', () => patch(
    AN, 'killPerMin: time ? r2(kill / (time / 60)) : 0,', 'killPerMin: time ? r2(kill / n) : 0,')],
  ['K11 交手档案读不出时长时给 0（0 会被读成"他一分钟一个都不杀"）', () => patch(
    AN, 'kpm: r.seconds > 0 ? r2(r.kill / (r.seconds / 60)) : null,',
      'kpm: r.seconds > 0 ? r2(r.kill / (r.seconds / 60)) : 0,')],
  ['K12 「赢的那场 vs 输的那场」里去掉 KPM 那一项', () => patch(
    AN, "    { key: 'kill_per_min', label: 'KPM（每分钟击杀）' },\n", '')],
  ['K13 界面自己划那道地板（分钟数出现第二个源头）', () => patch(
    VW, 'board.minMinutes', '5')],
  ['K14 已关注与"你"用同一个类（同色 = 那条高亮等于没做）', () => patch(
    VW, "' class=\"row-watched\"'", "' class=\"row-me\"'")],
  ['K15 名单那一格不走 campCell、直接把编号打出来', () => patch(
    VW, 'campCell(p)', "'<td>' + p.color + '</td>'")],
  ['K16 那颗"不过滤"的按钮又写成「全胜」（第③条复发）', () => patch(
    HT, 'data-res="all">全部</button>', 'data-res="all">全胜</button>')],
  ['K17 桌面 CSV 表头与安卓那份漂开（两份文件对不上号）', () => patch(
    MJ, "'KD', 'KPM', 'KDA'", "'KD', '击杀分', 'KDA'")],
  ['K18 总览那六格把 KPM 换回 KD（这次要挪的那一格没挪）', () => patch(
    VW, "['KPM', s.killPerMin, '', 'accent'],", "['KD', s.kd, '', s.kd >= 1 ? 'good' : ''],")],
  /* ★ 这条锚点故意不带行尾：views.js 是 CRLF 行尾，写 `\n` 结尾的多行锚点会打不上
   *   （第一版就在这儿报了"锚点没找到"，而红线本身是好的）。 */
  ['K19 那张图退回只有 KD 一条线', () => patch(
    VW, "{ name: 'KPM', values: ser.map(function (x) { return x.killPerMin; }), color: 'orange' }",
      "{ name: 'KDA', values: ser.map(function (x) { return x.kd; }), color: 'orange' }")],
  /* —— #89 那两条：分享卡与插件聚合载荷。卡片是独立的一份数组，载荷是独立的一份对象 ——
   * 别的页面换了不代表它们跟上，所以各钉各的。 */
  ['K20 分享卡那一格又写回 KD（KD 让位这件事漏了卡片这一处）', () => patch(
    VW, "['KPM', kpmText(m)], ['KDA'", "['KD', m.kd], ['KDA'")],
  ['K21 分享卡标题不带攻防（发出去别人看不出这把是攻还是守）', () => patch(
    VW, "(m.mapName || '') + (m.side ? '-' + m.side : '')", "(m.mapName || '')")],
  ['K22 插件聚合载荷漏掉 killsPerMinute（界面有数、插件拿不到）', () => patch(
    PA, 'killsPerMinute: s.killPerMin,', '')],
  ['K23 载荷那格从池化换成逐场平均（短场次能把 KPM 拽飞，口径也换了人）', () => patch(
    PA, 'killsPerMinute: s.killPerMin,',
      "killsPerMinute: Math.round(rows.reduce(function (a, r) {\n" +
      "          return a + (r.game_time > 0 ? r.kill / (r.game_time / 60) : 0); }, 0) / rows.length * 100) / 100,")],
];

const ONLY = (process.argv[2] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const SELECTED = ONLY.length ? MUT.filter(m => ONLY.some(id => m[0].toUpperCase().startsWith(id + ' '))) : MUT;
if (!SELECTED.length) { console.log('一条都没匹配上：' + ONLY.join(',')); process.exit(1); }

/* 只验锚点、不跑套件：DF_ANCHOR_AUDIT=1 node test/mutate-kpm.js
 * 锚点清单只留这一份；审计工具那台改成现读现打（抄第二份必然漂移）。 */
if (process.env.DF_ANCHOR_AUDIT === '1') {
  let bad = 0;
  SELECTED.forEach(function (m) {
    restore();
    try { (m[2] || m[1])(); console.log('  锚点在 ' + m[0]); }
    catch (e) { bad++; console.log('  !!! ' + m[0] + ' → ' + e.message); }
  });
  restore();
  console.log('mutate-kpm：' + (bad ? bad + ' 针打不上' : '锚点全在'));
  process.exit(bad ? 1 : 0);
}

SELECTED.forEach(function (m) {
  restore();
  try {
    m[1]();
    const fails = both();
    console.log('\n' + m[0] + ' → ' + (fails.length ? 'RED ' + fails.length + ' 条' : '!!! 没变红 !!!'));
    fails.slice(0, 3).forEach(l => console.log('      ' + l));
  } catch (e) {
    console.log('\n' + m[0] + ' → 变异没打上：' + e.message);
  }
});
restore();
const out = run('core.test.js').concat(run('android-shim.test.js'));
console.log('\n还原后：' + (out.length ? '仍有 FAIL：' + out.join(' | ') : 'core + 安卓桥 全部通过'));
