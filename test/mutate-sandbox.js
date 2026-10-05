'use strict';
/* 变异桩（#93 沙盘这一族：地址、白名单、压掉对方第一个弹窗的那条 CSS）。
 * 每条把实现改回"坏的样子"，确认 android-shim E2 那几条真会红；跑完自动还原。
 * ★ 这一族真正量不到的那一条不在这里：对方哪天改了类名，那条 CSS 就"悄悄不命中"（弹窗又回来了），
 *   而源码里的字面量照样对得上测试 —— 那一条归 tools/probe-sandbox-css.js（要联网、量实时页面）。
 * 单跑几针：node test/mutate-sandbox.js S1
 * ★ 这套脚本会改源码再还原 —— 一次只准跑一套，别跟别的变异桩或编辑并行。 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const R = f => path.join(__dirname, '..', f);
const FILES = ['shell/main.js', 'android/js/df-android.js'];
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
  if (r.error || r.status === null || !/全部通过|项失败|测试异常/.test(out)) {
    return ['!! 套件没跑完（status=' + r.status + ' err=' + (r.error && r.error.message) +
      ' 尾部=' + out.slice(-140).replace(/\s+/g, ' ') + '!!'];
  }
  return fails;
}
function both() { return run('android-shim.test.js').concat(run('isolation.test.js')); }

const MJ = 'shell/main.js', AD = 'android/js/df-android.js';

const MUT = [
  ['S1 那条注入整个摘掉（弹窗又压住地图，静态红线以外没人会喊）', () => patch(
    MJ, '        const p = contents.insertCSS(SANDBOX_CSS);', '        const p = null;')],
  ['S2 只挂一次 attach 不挂 dom-ready（第二次导航之后弹窗悄悄回来）', () => patch(
    MJ, "contents.on('dom-ready', function () {\n      if (!isAllowedEmbed(contents.getURL())) return;",
      "contents.on('did-fail-load', function () {\n      if (!isAllowedEmbed(contents.getURL())) return;")],
  ['S3 类名少一个字母（对方页面上一切照旧，我们这条 CSS 永远不命中）', () => patch(
    MJ, '.startup-notice-backdrop,.startup-notice-dialog', '.startup-notice-bakdrop,.startup-notice-dialog')],
  ['S4 两壳的沙盘地址漂了（手机上交给浏览器的还是那家旧的）', () => patch(
    AD, "var SANDBOX_URL = 'https://aeuicey.github.io/DeltaForce-TacticalPanel/';",
      "var SANDBOX_URL = 'https://dt.dpx1.icu/';")],
  ['S5 白名单从"前缀"退成"整串相等"（对方站内任何子路径都进不来，沙盘页变一块空白）', () => patch(
    MJ, 'return u === SANDBOX_URL || u.indexOf(SANDBOX_URL) === 0;', 'return false;')],
];

const ONLY = (process.argv[2] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const SELECTED = ONLY.length ? MUT.filter(m => ONLY.some(id => m[0].toUpperCase().startsWith(id + ' '))) : MUT;
if (!SELECTED.length) { console.log('一条都没匹配上：' + ONLY.join(',')); process.exit(1); }

/* 只验锚点、不跑套件：DF_ANCHOR_AUDIT=1 node test/mutate-sandbox.js
 * 锚点只留这一份（审计工具不许抄第二份） */
if (process.env.DF_ANCHOR_AUDIT === '1') {
  let bad = 0;
  SELECTED.forEach(function (m) {
    restore();
    try { m[1](); console.log('  锚点在 ' + m[0]); }
    catch (e) { bad++; console.log('  !!! ' + m[0] + ' → ' + e.message); }
  });
  restore();
  console.log('mutate-sandbox：' + (bad ? bad + ' 针打不上' : '锚点全在'));
  process.exit(bad ? 1 : 0);
}

restore();
const base = both();
if (base.length) {
  console.log('× 基线就不绿：这套桩的结论不能用（' + base.slice(0, 3).join(' | ') + '）');
  process.exit(1);
}
console.log('基线：安卓桥 + 隔离性 全绿（' + MUT.length + ' 针待打）');

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
  : '安卓桥 + 隔离性 全部通过'));
console.log(missed ? '>>> ' + missed + ' 针没咬住（这套判据不算立住）'
  : '>>> ' + SELECTED.length + ' 针全部咬住');
process.exit(missed || out.length ? 1 : 0);
