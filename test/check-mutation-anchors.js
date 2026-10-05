/* 锚点审计：把 SCRIPTS 里那几套变异桩各跑一遍"只打桩、不跑套件"的模式（DF_ANCHOR_AUDIT=1）。
 * ★ 这台工具以前自己抄了一份 M1a~M30 的锚点清单，那是判据的第二份副本 —— 它必然漂移：
 *   O15 那条在 shell/main.js 里的式子被 #76 改过，桩自己报"锚点没找到"，而这份清单还说
 *   "锚点全在（31 针）"。现在锚点只存在于各变异桩里那一份，工具负责把每一套全过一遍并汇总
 *   （套数从 SCRIPTS 现读，别在文案里写死第几套 —— #79 那套加进来时那句"五套"就过期过一次）。
 * 跑法：node test/check-mutation-anchors.js （几十秒；跑的时候别同时跑变异桩） */
const cp = require('child_process');
const path = require('path');

const SCRIPTS = ['owner', 'backup', 'login-wipe', 'store-io', 'occupy-label', 'kpm', 'gate', 'camp',
  'mapname', 'sandbox', 'update', 'flag', 'trace'];
let bad = 0, total = 0;

SCRIPTS.forEach(function (s) {
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'mutate-' + s + '.js')], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 32 << 20,
    env: Object.assign({}, process.env, { DF_ANCHOR_AUDIT: '1' })
  });
  const out = (r.stdout || '') + (r.stderr || '');
  /* 一条都没报就等于这套桩压根没进审计模式 —— 那种"绿"最贵，必须当红看 */
  if (!/锚点在 |!!! /.test(out)) {
    bad++;
    console.log('mutate-' + s + '：!!! 没进审计模式（status=' + r.status + '）' +
      ' 尾部=' + out.slice(-120).replace(/\s+/g, ' '));
    return;
  }
  const hit = (out.match(/锚点在 /g) || []).length;
  const miss = out.split('\n').filter(l => /^\s*!!! /.test(l));
  total += hit + miss.length; bad += miss.length;
  console.log('mutate-' + s + '：' + hit + ' 针打得上' + (miss.length ? '，' + miss.length + ' 针打不上' : ''));
  miss.forEach(l => console.log('   ' + l.trim().slice(0, 110)));
});

console.log(bad ? '>>> ' + bad + ' 针打不上（共 ' + total + ' 针）'
  : '>>> 锚点全在（' + total + ' 针，' + SCRIPTS.length + ' 套桩）');
process.exit(bad ? 1 : 0);
