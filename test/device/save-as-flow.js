/* 设备上真跑一次「导出数据包」——看它是不是把位置交给使用者选（而不是写死到应用私有目录）。
 * 跑法：node tools/android-cdp.js --file=test/device/save-as-flow.js --timeout=120000
 * ★ 这一发会**弹出系统的另存为面板并停在那里等**，所以要配合 adb input 点掉它
 *   （或在 MuMu 窗口里手动点一下）。返回的 r.path 应该是系统给的真实显示名。
 */
(async function () {
  var t0 = Date.now();
  var r = await window.df.exportData('json', {});
  return JSON.stringify({
    ms: Date.now() - t0,
    ok: !!(r && r.ok),
    cancelled: !!(r && r.cancelled),
    path: (r && r.path) || '',
    error: (r && r.error) || '',
    note: (r && r.note) || ''
  });
})();
