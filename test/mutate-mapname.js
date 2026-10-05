'use strict';
/* 变异桩（#92 这一族：使用者那一层的地名 —— 查看、编辑、还原、进包、重启还在）。
 * 每条把实现改回"坏的样子"，确认 map-names §F/§G 那些断言与静态红线真会红；跑完自动还原。
 * ★ 这一族最险的两条都不是判据写错：
 *   ① applyExtra 与 USER 的先后顺序 —— 写反了不会崩，只会让"点一次更新地图名"把使用者起的名
 *      悄悄冲掉，而他要在下一次看见表里名字变了才知道；
 *   ② 三处生产者（桌面 IPC / 安卓 df 桥 / 预览层 mock）少接一条 —— 那一台设备上那颗按钮
 *      点了没反应，另外两台全好，npm test 里一点痕迹都没有。
 * 单跑几针：node test/mutate-mapname.js M1,M5
 * ★ 这套脚本会改源码再还原 —— 一次只准跑一套，别跟别的变异桩或编辑并行。 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const R = f => path.join(__dirname, '..', f);
const FILES = ['core/maps.js', 'core/store.js', 'shell/main.js', 'shell/preload.js',
  'android/js/df-android.js', 'ui/js/app.js', 'ui/js/views.js', 'test/mock-df.js'];
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
function both() { return run('map-names.test.js').concat(run('android-shim.test.js')); }

const MP = 'core/maps.js', ST = 'core/store.js', MJ = 'shell/main.js', PL = 'shell/preload.js',
  AD = 'android/js/df-android.js', AP = 'ui/js/app.js', VW = 'ui/js/views.js', MK = 'test/mock-df.js';

const MUT = [
  /* —— 判据本体：三层名字的先后 —— */
  ['M1 使用者那一层不再优先（内置表压过他起的名字）', () => patch(
    MP, "return USER[k] || MAP_NAME[k] || EXTRA[k] || ('未知地图 · id ' + id);",
      "return MAP_NAME[k] || USER[k] || EXTRA[k] || ('未知地图 · id ' + id);")],
  ['M2 「更新地图名」又能盖掉使用者起的名字（applyExtra 那道 USER 闸门摘掉）', () => patch(
    MP, "if (Object.prototype.hasOwnProperty.call(USER, id)) return;       /* 使用者改过的，学的也不许盖回去 */",
      '')],
  ['M3 改了名还算「认不出」（isKnownMap 不看 USER：库里那些场次不会跟着改名）', () => patch(
    MP, '    return Object.prototype.hasOwnProperty.call(USER, k) ||', '    return false ||')],
  ['M4 地名开始参与统计口径（把一张图改名成「胜者为王…」就把自己的库改了）', () => patch(
    MP, 'return SWWR_IDS.indexOf(n) !== -1 || EXTRA_SWWR[n] === 1 || Number(gameRule) === 13;',
      "return SWWR_IDS.indexOf(n) !== -1 || EXTRA_SWWR[n] === 1 || Number(gameRule) === 13 ||\n      String(nameOf(id)).indexOf('胜者为王') !== -1;")],
  ['M5 撤销一条改名时把别人包里带来的真名也一起抹掉（坑 19 那道闸没了）', () => patch(
    ST, "if (String(m.map_id) === key && String(m.map_name || '') === was && m.map_name !== now) {",
      'if (String(m.map_id) === key && m.map_name !== now) {')],
  ['M6 还原那半边整个不做事（rollback 直接回 0，界面上"退回本来叫什么"是句空话）', () => patch(
    ST, '      if (String(m.map_id) === key', '      if (false && String(m.map_id) === key')],

  /* —— 落盘与重启：写进去的必须两层都在 —— */
  ['M7 learnMapNames 落盘不写 userNames（点一次更新，我改的名字从盘上消失）', () => patch(
    MJ, "    /* ★ 使用者自己改的名字单独一层，永远不被「更新地图名」盖掉（#92） */\n    userNames: Maps.userNames()",
      '')],
  ['M8 boot 时不装使用者那一层（重启后界面全变回官方名，盘上却还写着我的）', () => patch(
    MJ, '  if (rec.userNames) Maps.applyUser(rec.userNames);', '')],
  ['M9 安卓同一颗（三处生产者里最容易漏的那一台：手机重启后名字悄悄回官方）', () => patch(
    AD, '    if (rec.userNames) Core.Maps.applyUser(rec.userNames);', '')],

  /* —— 数据包：带出去与收进来 —— */
  ['M10 导出包漏掉 map_names_user（换机导入后要重做一遍改名）', () => patch(
    MJ, "      map_names_user: (mapNamesRecord() || {}).userNames || {}", '')],
  ['M11 导入包不收 map_names_user（别人改好的名字进不来）', () => patch(
    MJ, '  if (bundle.map_names_user) learnUserNames(bundle.map_names_user);', '')],
  ['M12 安卓那两条包接缝同样得在（少一条 = 手机与电脑之间倒腾会丢名字）', () => patch(
    AD, "      view.map_names_user = (mapNamesRecord() || {}).userNames || {};", '')],
  ['M13 导入这一路把 mapNames.at 顶成非 0（"首次自动一次"那发就永远不发了）', () => patch(
    MJ, '  const rec = mapNamesRecord();\n  accounts.globalSettings.mapNames = {\n    at: (rec && rec.at) || 0,\n    names: Maps.extraNames(),\n    userNames: Maps.userNames()\n  };\n  saveAccountsSync();\n  return r;',
      '  accounts.globalSettings.mapNames = {\n    at: Date.now(),\n    names: Maps.extraNames(),\n    userNames: Maps.userNames()\n  };\n  saveAccountsSync();\n  return r;')],

  /* —— 三处生产者与界面接线：少一条就是那一台设备上点了没反应 —— */
  ['M14 桌面不转发 setName（设置页保存按钮在这台机器上是死的）', () => patch(
    MJ, "ipcMain.handle('mapNames:setName'", "ipcMain.handle('mapNames:setName-OFF'")],
  ['M15 preload 漏 setName（桥两侧名字不一致，界面拿到 undefined 就当"宿主不支持"）', () => patch(
    PL, "    setName: (payload) => ipcRenderer.invoke('mapNames:setName', payload)", '')],
  ['M16 安卓 df 桥漏 dict（手机端"查看本机字典"永远空）', () => patch(
    AD, '      dict: function () { return Promise.resolve(mapNamesDict()); },', '')],
  ['M17 预览层 mock 漏 setName（布局探针与设备桩量的是另一个形状）', () => patch(
    MK, "      setName: function (p) { return post('/mock/mapNames/setName', p || {}); }", '')],
  ['M18 界面不取字典（按钮在、盒子在，点开却永远是一句提示）', () => patch(
    AP, 'global.DFViews.mapDictHtml(d)', "''")],
  ['M19 界面自己再验一遍编号（判据出现第二份，core 那条改了也没用）', () => patch(
    AP, "    var label = String(name == null ? '' : name).trim();",
      "    if (!/^\\\\d{1,8}$/.test(String(id))) { toast('编号不对', true); return; }\n" +
      "    var label = String(name == null ? '' : name).trim();")],
];

const ONLY = (process.argv[2] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const SELECTED = ONLY.length ? MUT.filter(m => ONLY.some(id => m[0].toUpperCase().startsWith(id + ' '))) : MUT;
if (!SELECTED.length) { console.log('一条都没匹配上：' + ONLY.join(',')); process.exit(1); }

/* 只验锚点、不跑套件：DF_ANCHOR_AUDIT=1 node test/mutate-mapname.js
 * 锚点只留这一份（审计工具不许抄第二份） */
if (process.env.DF_ANCHOR_AUDIT === '1') {
  let bad = 0;
  SELECTED.forEach(function (m) {
    restore();
    try { m[1](); console.log('  锚点在 ' + m[0]); }
    catch (e) { bad++; console.log('  !!! ' + m[0] + ' → ' + e.message); }
  });
  restore();
  console.log('mutate-mapname：' + (bad ? bad + ' 针打不上' : '锚点全在'));
  process.exit(bad ? 1 : 0);
}

restore();
const base = both();
if (base.length) {
  console.log('× 基线就不绿：这套桩的结论不能用（' + base.slice(0, 3).join(' | ') + '）');
  process.exit(1);
}
console.log('基线：地图名 + 安卓桥 全绿（' + MUT.length + ' 针待打）');

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
  : '地图名 + 安卓桥 全部通过'));
console.log(missed ? '>>> ' + missed + ' 针没咬住（这套判据不算立住）'
  : '>>> ' + SELECTED.length + ' 针全部咬住');
process.exit(missed || out.length ? 1 : 0);
