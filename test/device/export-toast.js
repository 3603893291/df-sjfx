/* 设备上真点界面那两颗导出按钮中的一颗，读它自己念出来的那句话。
 * 跑法（两条命令，第二条在旁边把系统的「另存为」面板点掉）：
 *   node tools/android-cdp.js --file=test/device/export-toast.js --timeout=240000 &
 *   python tools/android-tap-save.py            # 认 mCurrentFocus 里的 documentsui，找「保存」再点
 * ★ 一颗一颗来：原生那一侧「另存为」只有一枚槽，面板还开着就又点一颗，
 *   前一发会被顶掉（2026-09-25 在 MuMu 上连着点两颗就这么丢过一次），
 *   所以这里一颗一次，跑完再改 window.__toastBtn 跑下一颗。
 * 验的是**消费者那一句**：界面写的是「已导出 ' + r.count + ' 场到：…」与
 * 「已导出数据包（' + r.matches + ' 场 / ' + r.rosters + ' 份名单）」，
 * 手机上原来念成「已导出 undefined 场」。★ 所以这里不直接喊 df.exportData，
 * 而是点真按钮、读 #toast 的 textContent —— 判定与措辞一个字都不改，只把说出来的话量下来。
 */
(async function () {
  var id = window.__toastBtn || 'btnExportJson';
  var t = document.getElementById('toast');
  var before = t.textContent;
  t.textContent = '';
  document.getElementById(id).click();
  var got = null, deadline = Date.now() + 200000;
  while (Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 250); });
    if (t.textContent !== '' && t.textContent !== before) { got = t.textContent; break; }
  }
  return JSON.stringify({
    btn: id, toast: got, isError: t.classList.contains('err'),
    counts: await window.df.counts()
  }, null, 1);
})();
