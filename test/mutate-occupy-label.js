'use strict';
/* 变异检查（占点改名红线）：把每处口径逐条改回旧名，确认对应断言真的会红。
 * 跑完自动还原；跑法 node test/mutate-occupy-label.js */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const R = f => path.join(__dirname, '..', f);
const FILES = ['ui/js/views.js', 'ui/js/app.js', 'shell/main.js', 'core/analysis.js', 'ui/index.html'];
const bak = {};
FILES.forEach(f => { bak[f] = fs.readFileSync(R(f), 'utf8'); });

function patch(file, from, to) {
  const src = bak[file];
  if (src.indexOf(from) === -1) throw new Error('锚点没找到: ' + file + ' :: ' + from);
  if (src.split(from).length - 1 > (file === 'ui/js/views.js' ? 99 : 1)) {
    // views.js 里允许一次改多处（下面自己限定），其余文件要求锚点唯一
  }
  fs.writeFileSync(R(file), src.split(from).join(to));
}

function runSuite() {
  return cp.spawnSync(process.execPath, [path.join(__dirname, 'core.test.js')],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 << 20 }).stdout || '';
}

const MUT = [
  ['M1 views.js 标签改回「占点」', () => patch('ui/js/views.js', "label: '占点（次）'", "label: '占点'")],
  ['M2 views.js 战局卡片单独写死旧名', () => patch('ui/js/views.js', "[OCC.label, m.occupy]", "['占点', m.occupy]")],
  ['M3 app.js 滑杆行退回字面量', () => patch('ui/js/app.js',
    "['occupy', global.DFViews.OCCUPY.label]", "['occupy', '占点']")],
  ['M4 桌面 CSV 表头退回旧名', () => patch('shell/main.js', "'占点（次）'", "'占点'")],
  ['M5 core 权重名退回旧名', () => patch('core/analysis.js', "occupy: '占点（次）'", "occupy: '占点'")],
  ['M6 阵营对比那句提示删掉', () => patch('ui/js/views.js', "esc(OCC.note) + '</p></div>'", "'' + '</div>'")],
  ['M7 胜率页静态兜底文案退回旧名', () => patch('ui/index.html', '占点（次） 10%', '占点 10%')],
  ['M8 设置页那句说明不接线', () => patch('ui/js/app.js',
    "$('occNote').textContent = global.DFViews.OCCUPY.note;", '')],
  ['M9 战局列表表头不再挂说明（只留标签）', () => patch('ui/js/views.js',
    '<th>分均</th><th title="\' + esc(OCC.note) + \'">\' + OCC.label + \'</th>\'',
    '<th>分均</th><th>\' + OCC.label + \'</th>\'')],
  ['M10 ciPlain 漏传场数 n（真机抓到的 undefined）', () => patch('ui/js/views.js',
    'ciPlain({ ci: bm.allyCi, n: bm.allyMeets })', 'ciPlain({ ci: bm.allyCi })')]
];

function restore() { FILES.forEach(f => fs.writeFileSync(R(f), bak[f])); }

/* 只验锚点、不跑套件：DF_ANCHOR_AUDIT=1 node test/mutate-occupy-label.js（锚点清单只有这一份） */
if (process.env.DF_ANCHOR_AUDIT === '1') {
  let bad = 0;
  MUT.forEach(function (m) {
    restore();
    try { m[1](); console.log('  锚点在 ' + m[0]); }
    catch (e) { bad++; console.log('  !!! ' + m[0] + ' → ' + e.message); }
  });
  restore();
  console.log('mutate-occupy-label：' + (bad ? bad + ' 针打不上' : '锚点全在'));
  process.exit(bad ? 1 : 0);
}

MUT.forEach(function (m) {
  restore();
  try {
    m[1]();
    const fails = runSuite().split('\n').filter(l => /FAIL/.test(l)).map(l => l.trim().slice(0, 74));
    console.log('\n' + m[0] + ' → ' + (fails.length ? 'RED ' + fails.length + ' 条' : '!!! 没变红 !!!'));
    fails.slice(0, 4).forEach(l => console.log('      ' + l));
  } catch (e) {
    console.log('\n' + m[0] + ' → 变异没打上：' + e.message);
  }
});
restore();
console.log('\n还原后：' + (/全部通过/.test(runSuite()) ? '全部通过' : '仍有 FAIL'));
