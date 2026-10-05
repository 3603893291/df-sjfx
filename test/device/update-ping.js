/* 真机（MuMu WebView）探针：在线更新那一栏在手机上长什么样、宿主那一发装配对不对。
 * 用法：node tools/android-cdp.js --serial=127.0.0.1:16384 --file=test/device/update-ping.js
 * ★ 这一跑**不指望真问到服务器**：手机端是否真出网由 Java 那道锁管，这里量的是
 *   ① 桥在不在（df.update 三颗）②宿主回的形状（当前版本 = apk 里那份 HOST_VERSION）
 *   ③界面那句安心话 ④不许出现"立即更新"那颗按钮 ⑤整张 DOM 里找不出那个域名。 */
(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var out = {};
  var d = window.df || {};
  out.bridge = !!(d.update && d.update.status && d.update.check && d.update.openDownload);
  if (!out.bridge) { out.pass = false; return JSON.stringify(out); }
  var s = await d.update.status();
  out.status = s;
  out.shape = !!(s && s.ok === true && typeof s.current === 'string' &&
    s.current.split('.').length === 3 && typeof s.action === 'string');
  /* 走到「设置」页，把那一栏读出来（点导航那颗「设置」） */
  var nav = Array.prototype.slice.call(document.querySelectorAll('.nav-item, button, a'));
  var setBtn = nav.filter(function (b) { return String(b.textContent).trim() === '设置'; })[0];
  if (setBtn) { setBtn.click(); await sleep(1200); }
  var box = document.getElementById('updStatus');
  out.rowPresent = !!box;
  out.rowText = box ? String(box.textContent).replace(/\s+/g, ' ').slice(0, 60) : '';
  var v = document.getElementById('updVersion');
  out.versionShown = v ? String(v.textContent) : '';
  out.versionMatches = !!v && out.versionShown.indexOf((s && s.current) || '?') >= 0;
  var html = String(document.body.innerHTML);
  out.noAutoInstall = !document.getElementById('btnUpdApply');
  out.hasCheckBtn = !!document.getElementById('btnUpdCheck');
  out.urlHidden = html.indexOf('dpx1') === -1;
  out.dataSafeSaid = /覆盖安装不会丢数据/.test(html);
  /* 点一次「重新检查」：不指望问到，但这颗按钮必须真有反应（要么念新版本，要么念为什么问不到） */
  if (out.hasCheckBtn) {
    document.getElementById('btnUpdCheck').click();
    for (var i = 0; i < 25; i++) {
      await sleep(200);
      var t = String((document.getElementById('updStatus') || {}).textContent || '');
      if (t.indexOf('正在检查') !== 0) { out.afterCheck = t.replace(/\s+/g, ' ').slice(0, 60); break; }
    }
  }
  out.checkedAfter = !!(await d.update.status()).checked;
  out.pass = !!(out.bridge && out.shape && out.rowPresent && out.rowText && out.versionMatches &&
    out.noAutoInstall && out.hasCheckBtn && out.urlHidden && out.dataSafeSaid && out.checkedAfter);
  return JSON.stringify(out);
})();
