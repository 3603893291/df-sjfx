/* 使用者裁定（2026-09-25）：**只有「打开登录浏览器」这一件事**要把整机会话痕迹清干净。
 *
 * ★ 这一版探针量的是"页面上看得见的那一半"：开窗的回包（cleared / storageFault）、界面那句有没有跟着改口、
 *   探测事件带不带 rounds/advice、以及清会话**不许把数据一起清走**。
 * ★ cookie 有没有真被删掉，这一页量不了 —— WeGame / QQ 的凭据全是 HttpOnly，`document.cookie` 看不见它们，
 *   埋一枚标记 cookie 也只会量到"页面写 cookie 这件事本身在这台 WebView 上成不成"（MuMu 上连写都不落）。
 *   那一条的取证在设备外面做：
 *     adb -s 127.0.0.1:16384 exec-out run-as com.df.battleanalyzer cat app_webview/Default/Cookies > $TEMP/ck.sqlite
 *     node tools/probe-android-cookies.js $TEMP/ck.sqlite
 *   量之前这台设备得先真登录过一次（MuMu 里没有 QQ / 微信，登不进去，cookie 库永远是 0 条 = 空证）。
 *
 * 跑法：node tools/android-cdp.js --serial=127.0.0.1:16384 --file=test/device/login-wipe-session.js
 * 跑完记得 adb -s 127.0.0.1:16384 shell input keyevent KEYCODE_BACK 把登录窗关掉（它盖在我们那个 WebView 上面）。
 */
(async function () {
  await window.__dfReady;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var out = { at: Date.now() };
  var boot0 = await window.df.boot();
  out.before = {
    matchCount: boot0.matchCount, accounts: (boot0.accounts || []).length,
    activeSlot: boot0.activeSlot || '', bootError: boot0.bootError || '',
    storageFault: !!boot0.storageFault
  };
  /* ① 开窗这一发：回包 + 界面那句话 */
  var probes = [];
  window.df.on('login:probe', function (e) { probes.push(e); });
  var opened = await window.df.openLogin();
  await sleep(2500);
  var st = document.getElementById('loginStatus');
  out.open = {
    ok: !!(opened && opened.ok), cleared: !!(opened && opened.cleared),
    storageFault: !!(opened && opened.storageFault), slot: (opened && opened.slot) || '',
    statusLine: st ? st.textContent : '(没有 #loginStatus)'
  };
  /* ② 探测事件在真设备上带不带 core 那两枚字段（判定在 core，这里只看链上有没有） */
  out.probeEvents = {
    n: probes.length,
    first: probes[0] ? { ok: !!probes[0].ok, rounds: probes[0].rounds,
      advice: probes[0].advice ? '有字' : '', attempts: (probes[0].attempts || []).length,
      codes: (probes[0].attempts || []).map(function (a) { return a.code || a.reason; }) } : null
  };
  /* ③ 清的是会话，不是数据：这一发之后库里的场数不许变 */
  var boot1 = await window.df.boot();
  out.data = { before: boot0.matchCount, after: boot1.matchCount,
    intact: boot0.matchCount === boot1.matchCount, bootError: boot1.bootError || '' };
  return JSON.stringify(out, null, 1);
})()
