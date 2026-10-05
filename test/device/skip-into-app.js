/* 从登录页按「跳过，直接看本机数据」进主界面，量一眼是否真看得见东西。
 * 这一条是给"第二次打开说没数据"那个报告收尾用的：场数认得出来，还得真能进去看。
 * 跑法：node tools/android-cdp.js --serial=127.0.0.1:16384 --file=test/device/skip-into-app.js
 */
(async function () {
  await window.__dfReady;
  var btn = document.getElementById('btnSkipLogin');
  if (!btn || btn.classList.contains('hidden')) {
    return JSON.stringify({ err: '那颗「跳过」不在，进不去主界面',
      status: (document.getElementById('loginStatus') || {}).textContent || '' });
  }
  btn.click();
  await new Promise(function (r) { setTimeout(r, 2600); });
  var rows = document.querySelectorAll('#matchTable tbody tr').length;
  return JSON.stringify({
    appShown: !document.getElementById('appView').classList.contains('hidden'),
    loginHidden: document.getElementById('loginView').classList.contains('hidden'),
    offlineBar: !document.getElementById('offlineBar').classList.contains('hidden'),
    navItems: document.querySelectorAll('.nav-item').length,
    kpi: [].slice.call(document.querySelectorAll('.kpi .v')).map(function (x) {
      return x.textContent.trim();
    }).slice(0, 6),
    matchRows: rows,
    bodyHasUndefined: /undefined|NaN/.test(document.body.innerText) ? '有' : '没有'
  }, null, 1);
})()
