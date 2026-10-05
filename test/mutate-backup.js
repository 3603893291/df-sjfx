'use strict';
/* 变异桩（#76 备份可见性这一族：认得出名字 + 里面有什么 + 保留份数真裁得动）。
 * 每条把实现改回坏的样子，确认 core 的 §28 与 android-shim 的相关红线真的会红；跑完自动还原。
 * 单跑几针：node test/mutate-backup.js B1,B4 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const R = f => path.join(__dirname, '..', f);
const FILES = ['core/store.js', 'shell/main.js', 'ui/js/app.js'];
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
  /* ★ 跑不起来 / 跑完了却没打总结行 ⇒ 一律算"没测到"，绝不当通过。
   *    （上一轮就是这么把一次 SyntaxError 读成"这条变异没咬住"的。） */
  if (r.error || r.status === null || !/全部通过|项失败/.test(out)) {
    return ['!! 套件没跑完（status=' + r.status + ' err=' + (r.error && r.error.message) +
      ' 尾部=' + out.slice(-120).replace(/\s+/g, ' ') + '!!'];
  }
  return fails;
}
function both() { return run('core.test.js').concat(run('android-shim.test.js')); }

const CS = 'core/store.js', MJ = 'shell/main.js', AP = 'ui/js/app.js';

const NAME_TAIL = " /-(\\d{4})-(\\d{2})-(\\d{2})-(\\d{2})-(\\d{2})-(\\d{2})$/.exec(body) ||\n" +
  "            /-(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})$/.exec(body);";

const MUT = [
  ['B1 名字判定退回只认紧凑形状（自己写的文件自己认不出 ⇒ 列表永远空）', () => patch(
    CS, NAME_TAIL, " /-(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})$/.exec(body);")],
  ['B2 只认新形状、把老的紧凑形状丢了（盘上两种并存时又有一半看不见）', () => patch(
    CS, NAME_TAIL, " /-(\\d{4})-(\\d{2})-(\\d{2})-(\\d{2})-(\\d{2})-(\\d{2})$/.exec(body);")],
  ['B3 号名为空也算备份（恢复时指不到目标槽）', () => patch(
    CS, "    if (!slot) return null;\n", "")],
  ['B4 裁剪又按"号 + 日期"分组（每天一组、每组一份 ⇒ 永远裁不动）', () => patch(
    MJ, "      const g = x.info && x.info.slot ? x.info.slot : 'other';",
      "      const g = x.f.replace(/-\\d{4}-?\\d{2}-?\\d{2}-\\d{2}-?\\d{2}-?\\d{2}\\.json$/, '');")],
  ['B5 外壳不转发、自己在 main.js 里再正则一遍（判据出现第二份）', () => patch(
    MJ, "function isBackupName(name) { return !!StoreMod.parseBackupName(name); }",
      "function isBackupName(name) { return /^df-swtwr-.+-\\d+-\\d+-\\d+-\\d+-\\d+-\\d+\\.json$/.test(name); }")],
  ['B6 摘要把账号表也当战绩库（列表上会给出"恢复"这种号的东西）', () => patch(
    CS, "    if (Array.isArray(data.accounts)) {", "    if (false && Array.isArray(data.accounts)) {")],
  ['B7 摘要不看 excluded / 跨度（列表那几句变成假话）', () => patch(
    CS, "      excluded: rows.filter(function (r) { return !!r.excluded; }).length,",
      "      excluded: 0,")],
  ['B8 缓存键里没有 mtime（文件被覆盖过还拿旧结论糊弄界面）', () => patch(
    MJ, "  const key = name + '|' + size + '|' + Math.round(mtime || 0);",
      "  const key = name;")],
  ['B9 列表不再带 sum（界面退回只报时间 + KB）', () => patch(
    MJ, "          sum: peekBackup(dir, f, st.size, st.mtimeMs) };", "          };")],
  ['B10 界面把"每号各留几份、共几份"丢了（看不见按什么裁、到底有多少份）', () => patch(
    AP, "' 份，共 ' + (b.total == null ? '?' : b.total) + ' 份'", "''")],
  ['B11 裁完不回这轮删了几份（删使用者的数据不吭声）', () => patch(
    MJ, "  return { pruned: pruned, keep: keep };", "  return { pruned: 0, keep: keep };")],
  ['B12 doBackup 把 pruned/keep 半路吞掉（界面那句"这轮裁掉 N 份"永远不出现）', () => patch(
    MJ, "      pruned: p.pruned, keep: p.keep };", "      };")],
  ['B13 自检那节的"认得出"改成硬写成写了几份（真认不出也报绿 —— 上一版就是没这一节才全绿）', () => patch(
    MJ, "      o.recognized = (r1.files || []).filter(isBackupName).length;",
      "      o.recognized = (r1.files || []).length;")],
  ['B14 自检那节没挂进链条（写了 probeBackups 却从不调，等于没有）', () => patch(
    MJ, "        return probeBackups();", "        return undefined;")],
  ['B15 自检跑了、结果不计入 ok（那一节成了摆设，包坏了也没人拦）', () => patch(
    MJ, "      o.pass = !!(o.pass && o.uiOk);", "      o.pass = !!o.pass;")],
  ['B16 界面那一步不点按钮，只读一眼现成的 DOM（"看不见"那两句是点出来的，不是等出来的）', () => patch(
    MJ, "  btn.click();", "  void btn;")],
  ['B17 "留最近 N 份"又按 mtime 排（copyFileSync 把源文件 mtime 抄过来 ⇒ 裁掉的是刚写的那份）', () => patch(
    MJ, "      return { f: f, t: (info && info.at) || fs.statSync(full).mtimeMs, info: info };",
      "      return { f: f, t: fs.statSync(full).mtimeMs, info: info };")],
  ['B18 列表那一行的时刻退回 mtime（跟裁剪用的两把尺子，界面那句"什么时候备的"就是假的）', () => patch(
    MJ, "          time: info.at || st.mtimeMs,", "          time: st.mtimeMs,")]
];

const ONLY = (process.argv[2] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const SELECTED = ONLY.length ? MUT.filter(m => ONLY.some(id => m[0].toUpperCase().startsWith(id + ' '))) : MUT;
if (!SELECTED.length) { console.log('一条都没匹配上：' + ONLY.join(',')); process.exit(1); }

/* 只验锚点、不跑套件：DF_ANCHOR_AUDIT=1 node test/mutate-backup.js
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
  console.log('mutate-backup：' + (bad ? bad + ' 针打不上' : '锚点全在'));
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
