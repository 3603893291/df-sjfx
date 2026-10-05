'use strict';
/* 变异桩（#83 分发闸 tools/scan-dist.js 的**取样规则**这一族）。
 * 起因：这一轮重出包后 `scan-dist --root=dist` 报了 16 类"内容里扫到本机数据"，逐条看过去
 * 全是插件注册表里的出厂目录文案（true / false / main / view / storage / 四条中文说明），
 * 而这些字随包发的 core/plugin.js 里就有 —— 判据把"包里的正常代码"扫成了泄漏。
 * ★ 放宽一条判据，比写错一条更危险：从此插件真存了个令牌进来，闸门也可能闭着嘴绿。
 *   所以这道闸现在自带一颗进门就跑的现造夹具（plantCheck），这套桩钉的是那颗夹具真会咬。
 * 单跑几针：node test/mutate-gate.js G1,G4
 * ★ 这套脚本会改 tools/scan-dist.js 再还原 —— 一次只准跑一套，别跟别的变异桩或编辑并行。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const R = f => path.join(__dirname, '..', f);
const FILES = ['tools/scan-dist.js'];
const bak = {};
FILES.forEach(f => { bak[f] = fs.readFileSync(R(f), 'utf8'); });
function restore() { FILES.forEach(f => fs.writeFileSync(R(f), bak[f])); }
function patch(file, from, to) {
  const src = fs.readFileSync(R(file), 'utf8');
  if (src.indexOf(from) === -1) throw new Error('锚点没找到: ' + file + ' :: ' + from.slice(0, 52));
  fs.writeFileSync(R(file), src.split(from).join(to));
}

/* 扫一个空目录：内容/结构/源码一致那三道都无从命中，退出码就只由取样夹具决定。
 * 拿它当"套件"用 —— 全量 283 MB 扫一遍四十秒，六针跑不下来。 */
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'dfscan-mut-'));
function run() {
  const r = cp.spawnSync(process.execPath, [R('tools/scan-dist.js'), '--root=' + EMPTY],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 16 << 20 });
  const out = r.stdout || '';
  /* 夹具没开口（既没 ✓ 也没 ×）⇒ 等于这条压根没测，绝不当通过 */
  if (r.error || r.status === null || !/取样规则|取样夹具/.test(out)) {
    return ['!! 闸门没跑到夹具（status=' + r.status + ' err=' + (r.error && r.error.message) +
      ' 尾部=' + out.slice(-140).replace(/\s+/g, ' ') + '!!'];
  }
  const lines = out.split('\n').filter(l => /^  \S+ /.test(l) || /^× 取样/.test(l));
  return r.status === 1 ? lines.slice(0, 3) : [];
}

const SC = 'tools/scan-dist.js';

/* 三段锚点各对应取样规则的一条支路；缩进不同（插件层 4 空格、号库层 2 空格），别抄成一份 */
const META_BLOCK =
  "    if (digits) { if (s.length >= 9) addSignal(s, where + ' 字段 ' + k, 'strong'); return; }\n" +
  "    if (ID_KEY.test(k) && s.length >= 9) addSignal(s, where + ' 字段 ' + k, 'strong');\n" +
  "    else if (URLISH.test(k) || SECRET.test(k)) addSignal(s, where + ' 字段 ' + k, 'strong');\n";
const ID_BLOCK =
  "  if (ID_KEY.test(k) && s.length >= 9) addSignal(s, where + ' 字段 ' + k, 'strong');\n" +
  "  else if (URLISH.test(k) || SECRET.test(k)) addSignal(s, where + ' 字段 ' + k, 'strong');\n" +
  "  else if (NAME_KEY.test(k)) addSignal(s, where + ' 字段 ' + k, s.length >= 8 ? 'strong' : 'weak');\n";

const MUT = [
  ['G1 插件注册表那一层退回"整份都当信号"（上一轮把干净包判红的就是这条）', () => patch(
    SC, META_BLOCK,
    "    addSignal(s, where + (k ? ' 字段 ' + k : ' 的值'), s.length >= 8 ? 'strong' : 'weak');\n")],
  ['G2 plugin-data 那一层不再整份取（插件把令牌存在任何键名下都扫不出来了）', () => patch(
    SC, "    addSignal(s, where + (k ? ' 字段 ' + k : ' 的值'), s.length >= 8 ? 'strong' : 'weak');\n    return;",
      "    return;")],
  ['G3 注册表连站点 / 密钥这一支也摘掉（site 漏取）', () => patch(
    SC, META_BLOCK,
    "    if (ID_KEY.test(k) && s.length >= 9) addSignal(s, where + ' 字段 ' + k, 'strong');\n")],
  ['G4 号库那一层的身份键名整支摘掉（openid 与 nickname 都漏）', () => patch(SC, ID_BLOCK, "")],
  ['G5 进门那颗自检被摘掉（规则被改宽也没人知道）', () => patch(
    SC, "  const plant = plantCheck();", "  const plant = { fails: [], taken: 0 };")],
  ['G6 长信号门槛从 8 抬走（夹具那条串进不了池子，等于整道闸空转）', () => patch(
    SC, "  put(strong, v, why, 8);", "  put(strong, v, why, 40);")],
];

const ONLY = (process.argv[2] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const SELECTED = ONLY.length ? MUT.filter(m => ONLY.some(id => m[0].toUpperCase().startsWith(id + ' '))) : MUT;
if (!SELECTED.length) { console.log('一条都没匹配上：' + ONLY.join(',')); process.exit(1); }

/* 只验锚点、不跑闸门：DF_ANCHOR_AUDIT=1 node test/mutate-gate.js */
if (process.env.DF_ANCHOR_AUDIT === '1') {
  let bad = 0;
  SELECTED.forEach(function (m) {
    restore();
    try { m[1](); console.log('  锚点在 ' + m[0]); }
    catch (e) { bad++; console.log('  !!! ' + m[0] + ' → ' + e.message); }
  });
  restore();
  console.log('mutate-gate：' + (bad ? bad + ' 针打不上' : '锚点全在'));
  process.exit(bad ? 1 : 0);
}

restore();
const base = run();
if (base.length) {
  console.log('× 基线就不绿：这套桩的结论不能用（' + base.join(' | ') + '）');
  process.exit(1);
}
console.log('基线：闸门在空目录上 exit 0，夹具那句 ✓ 在');

SELECTED.forEach(function (m) {
  restore();
  try {
    m[1]();
    const fails = run();
    console.log('\n' + m[0] + ' → ' + (fails.length ? 'RED' : '!!! 没咬住 !!!'));
    fails.slice(0, 3).forEach(l => console.log('      ' + l.trim().slice(0, 100)));
  } catch (e) {
    console.log('\n' + m[0] + ' → 变异没打上：' + e.message);
  }
});
restore();
const after = run();
console.log('\n还原后：' + (after.length ? '闸门仍报夹具：' + after.join(' | ') : 'exit 0，夹具 ✓（还原干净）'));
