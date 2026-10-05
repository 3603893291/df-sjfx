/* 只干一件事：替界面按那颗「打开登录窗口」。
 * 配套的 cookie 库取证在 bash 里做（run-as cat Cookies → node tools/probe-android-cookies.js），
 * 因为 WeGame / QQ 的凭据全是 HttpOnly，页面里的 document.cookie 根本看不见它们。
 * 跑法：node tools/android-cdp.js --serial=127.0.0.1:16384 --file=test/device/open-login-only.js
 */
(async function () {
  await window.__dfReady;
  var r = await window.df.openLogin();
  var el = document.getElementById('loginStatus');
  return JSON.stringify({
    ok: !!(r && r.ok), cleared: !!(r && r.cleared), slot: (r && r.slot) || '',
    storageFault: !!(r && r.storageFault),
    statusLine: el ? el.textContent : ''
  }, null, 1);
})()
