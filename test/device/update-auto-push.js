/* 真机（MuMu WebView）探针：在线更新「自动那一发」跑完之后，界面那一行必须自己念出来 —— 全程不点按钮。
 * 用法（先冷启动，再等过 6 秒那一发）：
 *   adb -s 127.0.0.1:16384 shell am force-stop com.df.battleanalyzer
 *   adb -s 127.0.0.1:16384 shell monkey -p com.df.battleanalyzer -c android.intent.category.LAUNCHER 1
 *   sleep 10
 *   node tools/android-cdp.js --serial=127.0.0.1:16384 --file=test/device/update-auto-push.js
 * ★ 这一份存在的理由（2026-09-30 在桌面真机路径上量到的）：宿主那边 checked:true、error 已经是
 *   「问不到（HTTP 404）」，界面那一行却还停在启动时那句「还没检查过。」—— 因为原来只有"查到新版"
 *   那一条出路才推事件，而自动那一发没人去点「重新检查」。他那台服务器部署好之前每天都是 404，
 *   这一句念不出来，"开机自己问一次、有新版本在设置里念"就等于没做。 */
(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var out = {};
  var d = window.df || {};
  if (!(d.update && d.update.status)) { out.pass = false; out.why = '桥不在'; return JSON.stringify(out); }

  /* 先记下当前这一行念的是什么，再去「设置」页读它 —— 中间绝不点「重新检查」 */
  var box = document.getElementById('updStatus');
  out.rowBefore = box ? String(box.textContent).replace(/\s+/g, ' ').trim() : null;
  var nav = Array.prototype.slice.call(document.querySelectorAll('.nav-item'));
  var setBtn = nav.filter(function (b) { return b.getAttribute('data-view') === 'settings'; })[0];
  if (setBtn) { setBtn.click(); await sleep(900); }
  out.rowAfterNav = box ? String(box.textContent).replace(/\s+/g, ' ').trim() : null;

  var s = await d.update.status();
  out.status = { checked: s.checked, reported: s.reported, error: s.error,
    action: s.action, latest: s.latest, current: s.current };
  out.rowNow = box ? String(box.textContent).replace(/\s+/g, ' ').trim() : null;

  /* ① 自动那一发真查过了（没人点按钮）②那一行不再是空状态 ③界面那句话与宿主那句是同一句话 */
  out.autoChecked = s.checked === true;
  out.rowFilled = !!out.rowNow && out.rowNow !== '还没检查过。' && out.rowNow.indexOf('正在检查') !== 0;
  out.rowMatchesStatus = !!box && (s.error
    ? out.rowNow === '检查失败：' + s.error
    : (s.action === 'hint' ? out.rowNow.indexOf('发现新版本') === 0 : out.rowNow === '已经是最新版本。'));
  /* ④软件不动他的文件：这一路走完之后界面上仍然没有那颗"我帮你装" */
  out.noAutoInstall = !document.getElementById('btnUpdApply');
  out.urlHidden = String(document.body.innerHTML).indexOf('dpx1') === -1;
  out.pass = !!(out.autoChecked && out.rowFilled && out.rowMatchesStatus &&
    out.noAutoInstall && out.urlHidden);
  return JSON.stringify(out);
})();
