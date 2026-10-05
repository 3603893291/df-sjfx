/* 0.12-android 装上去之后，「读盘 → 写盘」这条链路还是不是通的。
 *
 * 为什么要单独跑这一发：core/store.js 这一版加了一道闸 —— 这个号的库没读出来，就不许往
 * 它上面写（桌面那侧的根因修复）。安卓的 fileAdapter 走的是另一套（自己的 faults 账本，
 * adapter.load 恒 resolve），理论上这道闸在手机上永远碰不到；但 core 是打进 assets 的
 * 同一份文件，"理论上碰不到"不等于"装上跑一遍没退化成空库"。这里量三件事：
 *   ① boot 读得到本机数据，且 storageFault / bootError 没有被误报；
 *   ② 一次普通的设置写入回 ok，且不出现 core 那句拒绝覆盖的话；
 *   ③ 切一次号（= 重新从磁盘读这个号的库）再写一遍，值还在 —— 证明盖上去的不是空库。
 *
 * 跑法：node tools/android-cdp.js --serial=127.0.0.1:16384 --file=test/device/boot-store-roundtrip.js
 * 前置：模拟器里这个号已经有本机数据（登录页能看到「跳过，直接看本机数据」）。
 */
(async function () {
  await window.__dfReady;
  var out = { bridge: typeof window.df === 'object' && !!window.df };
  if (!out.bridge) return JSON.stringify(out, null, 1);

  var b1 = await window.df.boot();
  out.boot1 = {
    matchCount: b1.matchCount,
    stats: b1.stats,
    storageFault: b1.storageFault,
    bootError: b1.bootError,
    activeSlot: b1.activeSlot,
    accounts: (b1.accounts || []).length,
    detailScope: b1.settings && b1.settings.detailScope
  };

  /* ② 真写一发，再原样写回去：只关心回包，不改他的设置 */
  var orig = b1.settings && b1.settings.detailScope;
  var flip = orig === 'all' ? 'mine' : 'all';
  var w1 = await window.df.setSettings({ detailScope: flip });
  var w2 = await window.df.setSettings({ detailScope: orig });
  out.write = {
    ok1: !!(w1 && w1.ok), ok2: !!(w2 && w2.ok),
    err1: (w1 && (w1.error || '')) || '',
    /* core 那道闸的话一旦在手机上冒出来，说明安卓也被拦住了 —— 这条必须为空 */
    gateSpoke: /这个号的库这次没读出来/.test(JSON.stringify([w1, w2]))
  };

  /* ③ 重新从磁盘读这个号（走 useSlot → store.load），再读一次设置值 */
  if (b1.activeSlot) {
    var sw = await window.df.accounts.switch(b1.activeSlot);
    var b3 = await window.df.boot();
    var w3 = await window.df.setSettings({ detailScope: flip });
    var b4 = await window.df.boot();
    var w4 = await window.df.setSettings({ detailScope: orig });
    var b5 = await window.df.boot();
    out.reread = {
      switchOk: !!(sw && sw.ok),
      matchCount: b3.matchCount,
      storageFault: b4.storageFault,
      bootError: b4.bootError,
      writeAfterSwitchOk: !!(w3 && w3.ok) && !!(w4 && w4.ok),
      /* 落盘的值能被重新读回来 = 那次保存写的是真库，不是空壳 */
      persisted: b4.settings && b4.settings.detailScope === flip,
      restored: b5.settings && b5.settings.detailScope === orig
    };
  }
  return JSON.stringify(out, null, 1);
})()
