/* 「第二次打开到底跳不跳得过」——设备上直接量登录页那一屏的三个事实：
 *   ① 壳报回来的场数（这台上盘里真有 8 场）；
 *   ② 那颗「跳过，直接看本机数据」在不在（hidden 就是不在了）；
 *   ③ 那行字念的是什么（有没有把"这台机器还没有战绩数据"当成结论喊出来）。
 * 三条一起量，是因为使用者报的原话就是"文案写着没有数据，也跳过不了"。
 * 跑法：node tools/android-cdp.js --serial=127.0.0.1:16384 --file=test/device/login-page-state.js
 */
(async function () {
  await window.__dfReady;
  var b = await window.df.boot();
  var btn = document.getElementById('btnSkipLogin');
  var st = document.getElementById('loginStatus');
  var out = {
    boot: { matchCount: b.matchCount, loggedIn: !!b.loggedIn, accounts: (b.accounts || []).length,
      activeSlot: b.activeSlot || '', bootError: b.bootError || '', storageFault: !!b.storageFault },
    onScreen: {
      loginViewShown: !document.getElementById('loginView').classList.contains('hidden'),
      skipHidden: btn ? btn.classList.contains('hidden') : null,
      skipText: btn ? btn.textContent.trim() : '',
      status: st ? st.textContent : '',
      statusClass: st ? st.className : '',
      skipHint: (document.getElementById('skipHint') || {}).textContent || ''
    }
  };
  /* 再按界面的路子走一遍：窗口关掉的瞬间会复查一次登录，那次复查不许把场数弄丢 */
  await window.df.checkLogin();
  var st2 = document.getElementById('loginStatus');
  var btn2 = document.getElementById('btnSkipLogin');
  out.afterRecheck = {
    skipHidden: btn2 ? btn2.classList.contains('hidden') : null,
    status: st2 ? st2.textContent : ''
  };
  return JSON.stringify(out, null, 1);
})()
