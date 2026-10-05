'use strict';
/* 变异桩（「比赛对局」这一枚手动标记：#87 那一族的形状 —— core 判对了、接缝断了，界面就是"点了没反应"）。
 * 起因：这一枚要穿过六份文件才落到使用者手上（core/store 的判据、core/analysis 的漏斗、
 *   桌面 / 安卓 / 预览服务 / 假桥四处透传、数据包导入的白名单）。少一处，另几处看上去都还是对的。
 * ★ 每一条都跑真套件，不看源码像不像：F13 那一针特意只断掉安卓 bridges 里 data:matches 的 kind 透传，
 *   而 filtersArgs / exportData 里还有 kind 字面 —— 只数源码的红线照样绿，真跑一遍才会红。
 * 跑法：node test/mutate-flag.js            （全套：二十针，每针跑一遍套件，F13 / F19 跑的是安卓那一套）
 *       node test/mutate-flag.js F2,F6     （单跑几针）
 *       DF_ANCHOR_AUDIT=1 node test/mutate-flag.js   （只验锚点，几秒）
 * ★ 这套脚本会改 core/ 与 shell/ 与 android/ 的源码再还原 —— 一次只准跑一套，别跟别的变异桩或编辑并行。 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const R = f => path.join(__dirname, '..', f);
const FILES = ['core/store.js', 'core/analysis.js', 'shell/main.js',
  'android/js/df-android.js', 'test/mock-df.js', 'test/preview-server.js', 'ui/js/views.js'];
const bak = {};
FILES.forEach(f => { bak[f] = fs.readFileSync(R(f), 'utf8'); });
function restore() { FILES.forEach(f => fs.writeFileSync(R(f), bak[f])); }
function patch(file, from, to) {
  const src = fs.readFileSync(R(file), 'utf8');
  if (src.indexOf(from) === -1) throw new Error('锚点没找到: ' + file + ' :: ' + from.slice(0, 46));
  fs.writeFileSync(R(file), src.split(from).join(to));
}

const CS = 'core/store.js';
const CA = 'core/analysis.js';
const VJ = 'ui/js/views.js';
const MJ = 'shell/main.js';
const AD = 'android/js/df-android.js';
const MD = 'test/mock-df.js';
const PS = 'test/preview-server.js';

/* 两条套件：core = 内核 + 那批源码红线；android = 真跑安卓 JS 桥（端到端把 kind 打到 core 再收回来） */
function runCore() {
  return cp.spawnSync(process.execPath, [path.join(__dirname, 'core.test.js')],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 << 20 }).stdout || '';
}
function runAndroid() {
  return cp.spawnSync(process.execPath, [path.join(__dirname, 'android-shim.test.js')],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 << 20 }).stdout || '';
}
const SUITES = { core: runCore, android: runAndroid };

const COMP_BRANCH = "    if (kind === 'comp' && !m.is_competition) return false;\n";
const PRAC_BRANCH = "    if (kind === 'practice' && m.is_competition) return false;\n";

const MUT = [
  ['F1 passes() 里「比赛」那一支摘掉（切到比赛等于没切，两类混着算胜率）', () => patch(CS, COMP_BRANCH, ''), 'core'],
  ['F2 passes() 里「匹配」那一支摘掉（标过比赛的还留在匹配里，两边各数一次）', () => patch(CS, PRAC_BRANCH, ''), 'core'],
  ['F3 排除那一条退回旧写法（切到比赛/匹配时被排除的那场又露面，两边各数一次）', () => patch(
    CS, "    if (m.excluded && !(o.includeExcluded === true && kind === 'all')) return false;",
      "    if (m.excluded && o.includeExcluded !== true) return false;"), 'core'],
  ['F4 modeCounts 不再分 comp / practice 两桶（顶上那句"多少场算比赛"就成 0）', () => patch(
    CS, "      if (m.is_competition) c.comp++; else c.practice++;\n", ''), 'core'],
  ['F5 FLAG_KEYS 少一枚 competition（store 直接把标记拒了）', () => patch(
    CS, '  var FLAG_KEYS = { commander: 1, excluded: 1, competition: 1 };',
      '  var FLAG_KEYS = { commander: 1, excluded: 1 };'), 'core'],
  ['F6 prune 的门槛只看标记不看模式（外部包里的脏比赛值物化进常规场）', () => patch(
    CS, '      m2.is_competition = (f.competition && m2.is_swtwr) ? 1 : 0;',
      '      m2.is_competition = f.competition ? 1 : 0;'), 'core'],
  ['F7 setMatchFlag 那道"只有胜者为王能标"的门槛被短路（绕过界面就能给常规场标比赛）', () => patch(
    CS, "    if (key === 'competition' && val && !this.state.matches[rid].is_swtwr) {",
      "    if (key === 'competition' && val && false) {"), 'core'],
  ['F8 setMatchFlag 的收尾 GC 不认 competition（只剩这一枚时当场被删，标了等于没标）', () => patch(
    CS, '    if (!f.commander && !f.excluded && !f.competition) delete this.state.flags[rid];',
      '    if (!f.commander && !f.excluded) delete this.state.flags[rid];'), 'core'],
  ['F9 prune 的孤儿 GC 不认 competition（重载后比赛标记被当空条目清走）', () => patch(
    CS, '      if (!live[k3] || (!f3.commander && !f3.excluded && !f3.competition)) delete state.flags[k3];',
      '      if (!live[k3] || (!f3.commander && !f3.excluded)) delete state.flags[k3];'), 'core'],
  ['F10 applyFilters 把 kind 写死成 all（漏斗、报告、界面全按全部对局算）', () => patch(
    CA, "    var kind = f.kind || 'all';", "    var kind = 'all';"), 'core'],
  ['F11 口径文案不跟着 kind 走（顶上永远念「全部对局」，切了筛选也看不见）', () => patch(
    CA, "        return k === 'comp' ? '比赛对局（你手动标的）' :\n" +
      "          (k === 'practice' ? '匹配对局（没标为比赛的）' : '全部对局');",
      "        return '全部对局';"), 'core'],
  ['F12 桌面 data:matches 不带 kind（桌面上那根轴点了没反应）', () => patch(
    MJ, "      kind: f.kind || 'all',", "      kind: 'all',"), 'core'],
  /* ★ 这一针特意挑「源码里还有别的 kind 字面」的那一处：只数字面的红线打不动它，必须真跑桥。 */
  ['F13 安卓桥 matches 不带 kind（手机上那根轴点了没反应，桌面照旧是好的）', () => patch(
    AD, "        mode: f.mode || 'all', kind: f.kind || 'all', leave: f.leave || 'all', since: f.since, mapId: f.mapId,",
      "        mode: f.mode || 'all', leave: f.leave || 'all', since: f.since, mapId: f.mapId,"), 'android'],
  ['F14 预览服务不带 kind（开发时看到的永远是全部对局，界面接线错了也看不出来）', () => patch(
    PS, "store.matches({ mode: f.mode || 'all', kind: f.kind || 'all', leave: f.leave || 'all', since: f.since,",
      "store.matches({ mode: f.mode || 'all', leave: f.leave || 'all', since: f.since,"), 'core'],
  ['F15 假桥不把 kind 拼进查询串（预览那一跑等于压根没传这一维）', () => patch(
    MD, "    if (f.kind) p.push('kind=' + encodeURIComponent(f.kind));\n", ''), 'core'],
  ['F16 数据包导入白名单丢了 competition（换机 / 分享包里本机的比赛标记进不来）', () => patch(
    MJ, '      competition: bfl[k].competition ? 1 : 0', '      competition: 0'), 'core'],
  ['F17 安卓那侧的导入白名单同样丢了 competition（手机收包标不了比赛，桌面却正常）', () => patch(
    AD, '        competition: bfl[k].competition ? 1 : 0', '        competition: 0'), 'core'],
  ['F18 桌面 data:flag 的白名单退回两枚（界面那颗按钮的请求被宿主直接拒掉）', () => patch(
    MJ, "    if (key !== 'commander' && key !== 'excluded' && key !== 'competition') {",
      "    if (key !== 'commander' && key !== 'excluded') {"), 'core'],
  ['F19 安卓 setFlag 的白名单退回两枚（手机端标不了比赛）', () => patch(
    AD, "      if (key !== 'commander' && key !== 'excluded' && key !== 'competition') {",
      "      if (key !== 'commander' && key !== 'excluded') {"), 'android'],
  /* 物化出来的字段名漂了：core 与界面各读各的，列表徽标、详情开关、modeText 一起失效，
   * 而"标记有没有存进库"那几条断言照样绿 —— 这类接缝只有读同一颗字段名的断言能咬。 */
  ['F20 物化字段名漂成 is_comp（界面与 core 读的不是同一颗，开关与徽标一起哑）', () => patch(
    CS, '      m2.is_competition = (f.competition && m2.is_swtwr) ? 1 : 0;',
      '      m2.is_comp = (f.competition && m2.is_swtwr) ? 1 : 0;'), 'core'],
  /* 下面两针不是「比赛」这一枚，是这一跑顺手抓到并修掉的那处真崩：详情页只拦"没名单"、
   * 不拦"有名单但名单里没有本机这个号"，于是 rk.score 读到 undefined，整页停在骨架屏。
   * 钉在这套桩里，是因为它和被测的那枚同一条路（详情页那颗按钮），修完必须咬得住回归。 */
  ['F21 详情页那道闸退回只拦 roster（名单里有别人没有我 ⇒ 整页崩成骨架屏）', () => patch(
    VJ, '    if (!c.ranks || !c.roster || c.roster < 5) {',
      '    if (!c.roster || c.roster < 5) {'), 'core'],
  ['F22 core 不再标 meMissing（界面分不清"没抓到名单"与"名单里没有我"，那句话就说错）', () => patch(
    CA, '      meMissing: true', '      meMissing: undefined'), 'core']
];

const ONLY = (process.argv[2] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const SELECTED = ONLY.length ? MUT.filter(m => ONLY.some(id => m[0].toUpperCase().startsWith(id + ' '))) : MUT;
if (!SELECTED.length) { console.log('一条都没匹配上：' + ONLY.join(',')); process.exit(1); }

/* 只验锚点、不跑套件：锚点清单只有这一份，check-mutation-anchors 现读现打（抄第二份必然漂移） */
if (process.env.DF_ANCHOR_AUDIT === '1') {
  let bad = 0;
  SELECTED.forEach(function (m) {
    restore();
    try { m[1](); console.log('  锚点在 ' + m[0]); }
    catch (e) { bad++; console.log('  !!! ' + m[0] + ' → ' + e.message); }
  });
  restore();
  console.log('mutate-flag：' + (bad ? bad + ' 针打不上' : '锚点全在'));
  process.exit(bad ? 1 : 0);
}

const seen = {};
SELECTED.forEach(function (m) {
  restore();
  const runner = SUITES[m[2]] || runCore;
  let out;
  try { m[1](); } catch (e) { console.log('\n' + m[0] + ' → 变异没打上：' + e.message); return; }
  out = runner();
  const fails = out.split('\n').filter(l => /FAIL/.test(l)).map(l => l.trim().slice(0, 92));
  const ranClean = /全部通过|项失败/.test(out);
  console.log('\n' + m[0] + ' → ' + (fails.length && ranClean ? 'RED ' + fails.length + ' 条'
    : (!ranClean ? '!!! 套件压根没跑完（结论不能用）!!!' : '!!! 没变红 !!!')));
  fails.slice(0, 3).forEach(l => console.log('      ' + l));
  seen[m[2]] = (seen[m[2]] || 0) + (fails.length ? 1 : 0);
});
restore();
['core', 'android'].forEach(function (k) {
  const out = (SUITES[k] || runCore)();
  console.log('还原后 ' + k + '：' + (/FAIL/.test(out)
    ? '仍有 FAIL：' + out.split('\n').filter(l => /FAIL/.test(l)).slice(0, 3).join(' | ')
    : (/全部通过/.test(out) ? '全部通过' : '没跑到结论')));
});
