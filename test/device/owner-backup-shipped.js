/* 真机（MuMu WebView）探针：交付到手机上那一份字节，量三件这轮改过的事
 *  ① 装载的就是这一族新判定：core 的 ownerConflict 真值表 + 备份认名与摘要（在页面里真调用，不查源码字样）；
 *  ② 安卓宿主回给设置页的 backupInfo 形状是"没有列表"那一种（界面因此说的是实话，不报「还没有备份文件。」）；
 *  ③ 启动链没被这两轮改动弄坏：df.boot() 等得到装配结果（增补十四那条竞态的回归）。
 * 用法：node tools/android-cdp.js --file=test/device/owner-backup-shipped.js
 * ★ 这里刻意不喊 bindLogin / runSync：那两个住在闭包里，且要一次真号会话才量得动 ——
 *   手机上量不了的就写"量不了"，不拿源码里有没有那个词来冒充"设备上验过"。 */
(async function () {
  var o = { href: location.href };
  var S = (window.DFCore && window.DFCore.Store) ? window.DFCore.Store : null;
  o.coreExposed = !!S;

  if (S) {
    var oc = S.ownerConflict;
    o.owner = !!(typeof oc === 'function' &&
      oc('111', '222') && oc('111', '111') === '' &&
      oc('', '222') === '' && oc('111', '') === '' && oc('', '') === '');
    var dashed = S.parseBackupName('df-swtwr-a1-daily-2026-09-26-2026-09-26-01-29-03.json');
    var compact = S.parseBackupName('df-swtwr-a1-manual-20260926-012903.json');
    var sum = S.summarizeBackup({ version: 2, meta: { openid: '9', name: '甲号' },
      matches: { r1: { room_id: 'r1', start_time: 1758000000 } }, rosters: { r1: {} } });
    var acc = S.summarizeBackup({ version: 1, activeSlot: 'a1', accounts: [{ name: '甲' }] });
    o.backup = !!(dashed && compact && dashed.slot === 'a1' && compact.slot === 'a1' &&
      dashed.tag === 'daily-2026-09-26' && compact.at === dashed.at &&
      S.isBackupName('accounts.json') === false &&
      S.parseBackupName('df-swtwr--manual-2026-09-26-01-29-03.json') === null &&
      sum.kind === 'library' && sum.matches === 1 && sum.name === '甲号' &&
      acc.kind === 'accounts' && acc.who === '甲');
  }

  var info = null;
  try { info = await df.backupInfo(); } catch (e) { info = { error: String(e.message || e) }; }
  /* 安卓那份回包刻意不给 list：界面读到 !list 就说"这台设备的宿主没有备份目录" */
  o.backupInfoShape = !!(info && typeof info.dir === 'string' && !('list' in info) && !info.error);

  try {
    var b = await df.boot();
    o.bootKeys = b && typeof b === 'object' ? Object.keys(b).slice(0, 10).join(',') : String(b);
    o.boot = !!(b && typeof b === 'object' && !b.error);
  } catch (e) { o.bootError = String(e.message || e); }

  o.pass = !!(o.coreExposed && o.owner && o.backup && o.backupInfoShape && o.boot);
  return JSON.stringify(o);
})()
