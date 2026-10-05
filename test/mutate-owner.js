'use strict';
/* 变异桩（#77 这一族：换号以后数据必须跟着"那个人"，而且串号的那一发一个字都不许写）。
 * 每条把实现改回坏的样子，确认 android-shim 的 E10 与 core 的 §27 真的会红；跑完自动还原。
 * 单跑几针：node test/mutate-owner.js O3,O7 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const R = f => path.join(__dirname, '..', f);
const FILES = ['core/store.js', 'shell/main.js', 'android/js/df-android.js', 'ui/js/app.js'];
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
  return r;
}
/* ★★ 套件"没跑完"绝不算通过。上一版这里只看 stdout 里的 FAIL 行 ——
 *    变异把源码改坏到套件当场 SyntaxError 时，stdout 一个字都没有，于是那条变异被报成
 *    「没变红」，看起来像我的断言没用，实际是测试根本没跑（会报绿的测试比会报错的测试更贵）。
 *    反过来也别把"跑完了、打了 1 项失败、退出码自然是 1"当成没跑完：判据是**总结行在不在**，
 *    不是退出码（上一版就是这么把每条 RED 都念成"没跑完"的，看着像措施严，其实是量测自己糊）。 */
function failsOf(r, label) {
  const out = r.stdout || '';
  const ran = /全部通过|项失败|\d+ 项全部通过/.test(out);
  if (r.error || !ran) {
    return ['!! ' + label + ' 没跑完：status=' + r.status +
      ' err=' + ((r.error && r.error.message) || (r.stderr || '').slice(0, 120)) +
      ' stdout 尾部=' + out.slice(-90).replace(/\s+/g, ' ')];
  }
  return out.split('\n').filter(l => /^ *FAIL /.test(l)).map(l => (label || '') + ' ' + l.trim().slice(0, 92));
}

const MJ = 'shell/main.js', AD = 'android/js/df-android.js', CO = 'core/store.js', AP = 'ui/js/app.js';

const MUT = [
  ['O1 桌面登录成功后不切号（只 bindLogin + emit —— 他报的那一句就是这个）', () => patch(
    MJ, "        Promise.resolve(switchTo(bound.slot)).then(function (sw) {",
      "        Promise.resolve({ ok: true, loadFault: '' }).then(function (sw) {")],
  ['O2 桌面不交罐子（新号的会话留在旧号名下，下一次同步写进旧号的库）', () => patch(
    MJ, "        const moved = handoffSession(openedJar, bound.slot);",
      "        const moved = { moved: false };")],
  ['O3 交了罐子但不给旧号换空罐（两个人指向同一罐 ⇒ 串号还在）', () => patch(
    MJ, "      a.partition = partitionFor(a.slot) + '-v' + Date.now();\n", "")],
  ['O4 罐子没真的改挂到人名下（handoff 变成只改注释）', () => patch(
    MJ, "  to.partition = jarName;\n", "")],
  ['O5 桌面入库前的归属核对整个不生效（先污染再道歉）', () => patch(
    MJ, "    if (StoreMod.ownerConflict(mine, got)) {",
      "    if (false && StoreMod.ownerConflict(mine, got)) {")],
  ['O6 桌面 openLoginWindow 退回按 slot 现算罐子（换过罐子的号又开回别人那罐）', () => patch(
    MJ, "  const partition = jarOf(slot);", "  const partition = partitionFor(slot);")],
  ['O7 安卓 bindLogin 退回旧写法：新号直接把当前槽抢过来（小号的 openid 被改掉）', () => patch(
    AD, "    var slot = acctOfOpenid(openid);\n    if (!slot) {\n" +
      "      var want = slotWanted && !acctOf(slotWanted) ? slotWanted : '';\n" +
      "      if (!want && slotWanted && acctOf(slotWanted) && !acctOf(slotWanted).openid) want = slotWanted;\n" +
      "      slot = want || (acctOf(slotOf(openid)) ? nextFreeSlot() : slotOf(openid));\n" +
      "    }",
      "    var slot = acctOfOpenid(openid) || slotWanted || slotOf(openid);")],
  ['O8 安卓入库守卫整个不生效（切到 C 号、罐子里是 A 号时照写不误）', () => patch(
    AD, "      if (Core.Store.ownerConflict(", "      if (false && Core.Store.ownerConflict(")],
  ['O9 安卓守卫一律拒（把"对得上就该放过去"这条也挡死）', () => patch(
    AD, "      if (Core.Store.ownerConflict(", "      if (true || Core.Store.ownerConflict(")],
  ['O10 core 判据放宽成"任何一侧为空也算冲突"（第一次落盘之前就被自己拦住）', () => patch(
    CO, "    return (a && b && a !== b) ? (a + ' ≠ ' + b) : '';",
      "    return (a !== b) ? (a + ' ≠ ' + b) : '';")],
  ['O11 jarOf 不再读注册表那枚 partition（按 slot 现算 = 换过的罐子找不回来）', () => patch(
    CO + '', 'x', 'x') /* 真针见下 */],
  ['O12 界面那句"库没读出来"改成无条件念（没坏也说坏）', () => patch(
    AP, "        (e.loadFault ? '（这个号的库这次没读出来：' + e.loadFault + '）' : '');",
      "        ('（这个号的库这次没读出来：' + (e.loadFault || '') + '）' );")],
  ['O13 界面那句永远不念（切过去了但库没读动，界面还喊一切正常）', () => patch(
    AP, "        (e.loadFault ? '（这个号的库这次没读出来：' + e.loadFault + '）' : '');",
      "        '';")],
  ['O14 桌面 emit 排在切号之前（界面 refresh 的时候当前号还没换过去）', () => patch(
    MJ, "        Promise.resolve(switchTo(bound.slot)).then(function (sw) {",
      "        emit('login:done', { role: r.role, slot: bound.slot });\n        Promise.resolve(switchTo(bound.slot)).then(function (sw) {")],
  ['O15 doBackup 不再回 count（界面那句「已备份 N 个文件」又变回 undefined）', () => patch(
    MJ, "    return { ok: true, dir: dir, files: made, count: made.length,\n      pruned: p.pruned, keep: p.keep };",
      "    return { ok: true, dir: dir, files: made, pruned: p.pruned, keep: p.keep };")]
];

/* O11 的真针在 main.js（jarOf 就住在那儿） */
MUT[10] = ['O11 jarOf 不再读注册表那枚 partition（按 slot 现算 = 换过的罐子找不回来）', () => patch(
  MJ, "  return (a && a.partition) || partitionFor(slot);", "  return partitionFor(slot);")];

const ONLY = (process.argv[2] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const SELECTED = ONLY.length ? MUT.filter(m => ONLY.some(id => m[0].toUpperCase().startsWith(id + ' '))) : MUT;
if (!SELECTED.length) { console.log('一条都没匹配上：' + ONLY.join(',')); process.exit(1); }

/* 只验锚点、不跑套件：DF_ANCHOR_AUDIT=1 node test/mutate-owner.js
 * 锚点抄在第二处（那台审计工具）必然漂移 —— O15 就漂过一次，工具说"全在"、真跑说"打不上"。
 * 所以锚点清单只留这一份，审计改成现读现打。 */
if (process.env.DF_ANCHOR_AUDIT === '1') {
  let bad = 0;
  SELECTED.forEach(function (m) {
    restore();
    try { (m[2] || m[1])(); console.log('  锚点在 ' + m[0]); }
    catch (e) { bad++; console.log('  !!! ' + m[0] + ' → ' + e.message); }
  });
  restore();
  console.log('mutate-owner：' + (bad ? bad + ' 针打不上' : '锚点全在'));
  process.exit(bad ? 1 : 0);
}

SELECTED.forEach(function (m) {
  restore();
  try {
    m[1]();
    const fails = failsOf(run('core.test.js')).concat(failsOf(run('android-shim.test.js')));
    console.log('\n' + m[0] + ' → ' + (fails.length ? 'RED ' + fails.length + ' 条' : '!!! 没变红 !!!'));
    fails.slice(0, 3).forEach(l => console.log('      ' + l));
  } catch (e) {
    console.log('\n' + m[0] + ' → 变异没打上：' + e.message);
  }
});
restore();
const left = failsOf(run('core.test.js'), 'core').concat(failsOf(run('android-shim.test.js'), '安卓桥'));
console.log('\n还原后：' + (left.length ? '仍有问题：' + left.join(' | ') : 'core + 安卓桥 全部通过'));
