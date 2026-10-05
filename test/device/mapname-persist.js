/* 真机（MuMu WebView）探针：本机字典里"我改的名字"到底有没有落到盘上、重启之后还在不在。
 * 用法（两次，中间把应用真杀掉重开）：
 *   node tools/android-cdp.js --serial=127.0.0.1:16384 --file=test/device/mapname-persist.js
 * 这一份是**状态驱动**的：同一个脚本
 *   第一次跑 = 记下图 601 现在的名字，改成标记名，报 action=set；
 *   第二次跑 = 看字典里那一条还在不在（在 ⇒ 盘上那份 accounts 真带着它），然后原样撤掉，报 action=check。
 * ★ 为什么非要跑两趟：installMapNames 那条"boot 时把使用者那一层也推给 core"的路径，
 *   在同一次进程里永远测不到 —— 名字是这一趟刚写进内存的，读回来当然在。只有冷启动之后还在，
 *   才证明它进了 accounts.json 并被装回来（这正是变异针 M8/M9 钉的那两条的运行时 counterpart）。 */
(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var MARK = '冷启动验真名';
  var out = { at: new Date().toISOString() };
  if (!window.df || !window.df.mapNames || !window.df.mapNames.dict || !window.df.mapNames.setName) {
    return JSON.stringify({ fail: '这台设备的宿主没有 dict/setName' });
  }
  var d0 = await window.df.mapNames.dict();
  out.before = { user: d0.user, builtin: d0.builtin, learned: d0.learned, unknown: d0.unknown };
  var marked = (d0.userEdits || []).filter(function (x) { return x.name === MARK; });
  if (marked.length === 0) {
    /* 第一趟：挑一张有官方名的图（601 = 攀升-胜者为王，设备库里有），改成标记名 */
    var r = await window.df.mapNames.setName({ id: '601', name: MARK });
    out.action = 'set';
    out.set = { ok: r.ok, applied: r.applied, renamed: r.renamed, error: r.error || '' };
    var d1 = await window.df.mapNames.dict();
    out.after = { user: d1.user, seesMark: JSON.stringify(d1.userEdits).indexOf(MARK) >= 0,
      base: (d1.userEdits[0] || {}).base };
    return JSON.stringify(out);
  }
  /* 第二趟（冷启动之后）：还在不在 + 那张图现在显示什么名，然后撤干净 */
  var usage = (d0.usage || []).filter(function (x) { return x.id === '601'; })[0] || {};
  out.action = 'check';
  out.persisted = d0.user === 1 && marked.length === 1 && marked[0].base === '攀升-胜者为王';
  out.rowShows = { name: usage.name, source: usage.source, count: usage.count };
  var r2 = await window.df.mapNames.setName({ id: '601', name: '' });
  out.cleanup = { ok: r2.ok, cleared: r2.cleared, renamed: r2.renamed };
  var d2 = await window.df.mapNames.dict();
  out.userAfterCleanup = d2.user;
  return JSON.stringify(out);
})();
