/* 探针：登录页点「重新检查」之后，那枚「跳过，直接看本机数据」还在不在
 * （本机有 8 场时按 #48 的口径它应当一直在 —— 这一发是复现步骤，只点界面自己的按钮）
 * 跑法：node tools/android-cdp.js --serial=127.0.0.1:16384 --file=test/device/recheck-hides-skip.js */
(async function () {
  await window.__dfReady;
  var read = function () {
    var e = document.getElementById('btnSkipLogin');
    return {
      status: document.getElementById('loginStatus').innerText.replace(/\s+/g, ' ').slice(0, 60),
      hint: document.getElementById('skipHint').innerText.replace(/\s+/g, ' ').slice(0, 24),
      skipHidden: e.classList.contains('hidden')
    };
  };
  var out = { before: read() };
  document.getElementById('btnRecheck').click();
  await new Promise(function (r) { setTimeout(r, 12000); });
  out.afterRecheck = read();
  /* 再走一次「跳过」，确认离线进得去、列表有几行 */
  var e = document.getElementById('btnSkipLogin');
  if (!e.classList.contains('hidden')) {
    e.click();
    await new Promise(function (r) { setTimeout(r, 4000); });
    out.afterSkip = {
      appViewHidden: document.getElementById('appView').classList.contains('hidden'),
      rows: document.querySelectorAll('#matchTable tbody tr').length,
      badges: document.querySelectorAll('#matchTable .tag-soft').length,
      count: document.getElementById('matchCount').innerText.replace(/\s+/g, ' ')
    };
  }
  return JSON.stringify(out, null, 1);
})()
