/* 设备上真跑一次「保存战绩卡片」——这一发会弹系统「另存为」并停在那儿等。
 * 跑法（两条命令，第二条在后台跑着，先去点掉面板）：
 *   node tools/android-cdp.js --serial=... --file=test/device/card-save.js --timeout=150000
 * 验收：r.ok 为真、r.path 是系统给的真实显示名（不是我们建议的那个字符串），
 *       且 /sdcard/Download/ 里真出现这个文件。
 * ★ 卡片数据这里用一张 1×1 PNG 顶替：要验的是"位置由谁定"，不是画布。
 */
(async function () {
  var PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAf'
    + 'FcSJYAAAAA1EQVR42mP8z8Dw/x8DBgQNBmQgCQAA1gU/AnSUgQAAAABJRU5ErkJggg==';
  var t0 = Date.now();
  var r = await window.df.saveCard({ dataUrl: PNG, name: '战绩卡片-设备验证.png' });
  return JSON.stringify({
    ms: Date.now() - t0,
    ok: !!(r && r.ok),
    cancelled: !!(r && r.cancelled),
    path: (r && r.path) || '',
    error: (r && r.error) || '',
    note: (r && r.note) || ''
  });
})();
