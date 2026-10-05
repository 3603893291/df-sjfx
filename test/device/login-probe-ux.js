/* 登录页上那句"还在等你完成登录"到底念不念得出错误码 —— 设备上跑真接口。
 *
 * 为什么要在设备上验：这一条改的是「官方到底认不认这个号」的判据（account_type 1/2 两套体系），
 * 离线测试里假接口是我们自己写的，它认什么全凭我们设定；只有真机才知道官方会不会照旧回 8000102。
 * 模拟器里没有 QQ / 微信可登，所以这里能验的是"两套都问了一遍、把两边的官方错误码送回界面"，
 * 而不是"微信的号终于登得进"（那一条要等那位微信用户回话，见手册增补十）。
 *
 * 跑法：node tools/android-cdp.js --serial=127.0.0.1:16384 --file=test/device/login-probe-ux.js
 * 跑完记得 adb shell input keyevent KEYCODE_BACK 把登录窗关掉（它盖在我们那个 WebView 上面）。
 */
(async function () {
  await window.__dfReady;
  var probes = [];
  window.df.on('login:probe', function (e) { probes.push(e); });
  var opened = await window.df.openLogin();
  await new Promise(function (r) { setTimeout(r, 7000); });
  var el = document.getElementById('loginStatus');
  return JSON.stringify({
    slot: opened && opened.slot || '',
    rounds: probes.length,
    first: probes[0] || null,
    onScreen: el ? el.textContent : '(没有 #loginStatus)',
    stillOnLogin: !document.getElementById('loginView').classList.contains('hidden'),
    dataIntact: (await window.df.boot()).matchCount
  }, null, 1);
})()
