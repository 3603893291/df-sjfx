'use strict';
/* 变异检查（#69 这一族：读不出来 ≠ 没有数据）：逐条把实现改回坏的样子，确认 §26 那族断言真的会红。
 * 跑完自动还原。单跑某几针：node test/mutate-store-io.js S2,S3 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const R = f => path.join(__dirname, '..', f);
const FILES = ['shell/adapters/store-node.js', 'core/store.js', 'shell/main.js'];
const bak = {};
FILES.forEach(f => { bak[f] = fs.readFileSync(R(f), 'utf8'); });
function restore() { FILES.forEach(f => fs.writeFileSync(R(f), bak[f])); }
function patch(file, from, to) {
  const src = fs.readFileSync(R(file), 'utf8');
  if (src.indexOf(from) === -1) throw new Error('锚点没找到: ' + file + ' :: ' + from.slice(0, 46));
  fs.writeFileSync(R(file), src.split(from).join(to));
}
function runCore() {
  return cp.spawnSync(process.execPath, [path.join(__dirname, 'core.test.js')],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 << 20 }).stdout || '';
}

const SN = 'shell/adapters/store-node.js';
const CS = 'core/store.js';
const MJ = 'shell/main.js';

const MUT = [
  ['S1 读不动又被当成"文件坏了"（一个 catch 包到底 + 直接 rename）', () => {
    patch(SN, "        throw new Error('读不出来（文件没动）：' + (e.code ? e.code + ' ' : '') + (e.message || e));",
      "        try { fs.renameSync(filePath, filePath + '.corrupt-' + Date.now()); } catch (_) {}\n        return null;");
  }],
  ['S2 core 的写闸被拆（没读成功也照样往原位写一份空的）', () => patch(
    CS, "    if (this._loadFault) {\n", "    if (false) {\n")],
  ['S3 适配器同步抛错不再转 rejection（调用方的 .catch 接不到，一路炸穿）', () => patch(
    CS, "    try {\n      data = this.adapter.load();\n    } catch (e) {\n      this._loadFault = String((e && e.message) || e);\n      return Promise.reject(e);\n    }\n    return Promise.resolve(data).then(function (d) {",
    "    return Promise.resolve(this.adapter.load()).then(function (d) {")],
  ['S4 解析不动时不再挪走留证据（坏文件留在原位，也不喊）', () => patch(
    CS + '', 'x'.repeat(1), 'x') /* 占位：见下条真针 */],
  ['S5 桌面 boot 不再报 storageFault（读不出来就说"没数据"）', () => {
    patch(MJ, "        bootError: faultText, storageFault: !!fault\n      });\n    }\n    /* 登录检查失败不拦路",
      "        bootError: faultText\n      });\n    }\n    /* 登录检查失败不拦路");
    patch(MJ, "          bootError: faultText, storageFault: !!fault\n        };\n      });",
      "          bootError: faultText\n        };\n      });");
  }],
  ['S6 switchTo 把原因吞了（读不出来也当"没事"回给界面）', () => patch(
    MJ, "    return { ok: true, slot: slot, loadFault: loadFault || '' };",
    "    return { ok: true, slot: slot };")],
  ['S7 定论之前不再重读一次（一次瞬态 EPERM 就把人的库说成读不出来）', () => patch(
    SN, "  } catch (e) {\n    const until = Date.now() + 120;\n    while (Date.now() < until) { /* 等句柄松 */ }\n    return fs.readFileSync(filePath, 'utf8');   // 还是读不动就让它抛出去，由调用方说实话\n  }",
      "  } catch (e) { throw e; }")],
  /* S8~S10：开登录窗那一发的 storageFault。界面（两端共用）已经在读 r.storageFault，
   * 安卓给、桌面不给的话 = 同一句话只在手机响，而两边源码各自看上去都没错。 */
  ['S8 openLoginWindow 的 storageFault 写死成 false（闸门明明合着也说没事）', () => patch(
    MJ, "  const storageFault = !!(slotStore && slotStore.loadFault && slotStore.loadFault());",
      "  const storageFault = false;")],
  ['S9 清成功那条回包不再带 storageFault', () => patch(
    MJ, "    return { ok: true, slot: slot, cleared: res.cleared, clearError: res.clearError,\n      storageFault: storageFault };",
      "    return { ok: true, slot: slot, cleared: res.cleared, clearError: res.clearError };")],
  ['S10 账户新增那发不再转发 storageFault（回包形状和 login:open 分了家）', () => patch(
    MJ, "      return { ok: true, slot: slot, cleared: r.cleared, clearError: r.clearError,\n        storageFault: r.storageFault };",
      "      return { ok: true, slot: slot, cleared: r.cleared, clearError: r.clearError };")],
  /* S11 = 2026-10-04 真 Electron 端到端跑出来的那一条：loadFault 只是中间那颗回调的形参，
   *   最后那颗回调（回包）读不到它 ⇒ 每次换号都在最后一步 ReferenceError，
   *   界面弹「切换失败」而号其实已经切过去了。S6 盯的是"别把原因吞了"，这条盯的是"那颗作用域"。 */
  ['S11 loadFault 退回中间回调的形参（最后那颗回包读不到 ⇒ 换号必抛 ReferenceError）', () => {
    patch(MJ, '  let loadFault = null;\n', '');
    patch(MJ, '  ).then(function (lf) {', '  ).then(function (loadFault) {');
    patch(MJ, '    loadFault = lf;', '');
  }]
];

/* S4 的真针：store-node 里"只有解析不动才叫坏"这一条被改回"坏了也回 null" */
MUT[3] = ['S4 真解析不动时回 null（core 就当没数据，随后一次 save 盖掉原位）', () => patch(
  SN, "        throw new Error('战绩库解析不动：' + (e.message || e) +",
  "        return null; throw new Error('战绩库解析不动：' + (e.message || e) +")];

const ONLY = (process.argv[2] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const SELECTED = ONLY.length ? MUT.filter(m => ONLY.some(id => m[0].toUpperCase().startsWith(id + ' '))) : MUT;
if (!SELECTED.length) { console.log('一条都没匹配上：' + ONLY.join(',')); process.exit(1); }

/* 只验锚点、不跑套件：DF_ANCHOR_AUDIT=1 node test/mutate-store-io.js
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
  console.log('mutate-store-io：' + (bad ? bad + ' 针打不上' : '锚点全在'));
  process.exit(bad ? 1 : 0);
}

SELECTED.forEach(function (m) {
  restore();
  try {
    m[1]();
    const fails = runCore().split('\n').filter(l => /FAIL/.test(l)).map(l => l.trim().slice(0, 84));
    console.log('\n' + m[0] + ' → ' + (fails.length ? 'RED ' + fails.length + ' 条' : '!!! 没变红 !!!'));
    fails.slice(0, 4).forEach(l => console.log('      ' + l));
  } catch (e) {
    console.log('\n' + m[0] + ' → 变异没打上：' + e.message);
  }
});
restore();
const out = runCore();
console.log('\n还原后：' + (/全部通过/.test(out) ? 'core 全部通过' :
  '仍有 FAIL：' + out.split('\n').filter(l => /FAIL/.test(l)).join(' | ')));
