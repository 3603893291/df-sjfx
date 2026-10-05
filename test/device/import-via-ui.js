/* 设备上真跑一遍他报的那条路：设置 → 导入插件包（系统文件面板选一个 zip → 预览 → 批权限 → 装）。
 * 跑法（第二条命令在后台跑着，中途去点掉系统面板）：
 *   adb push plugins-dist/df.demo.summary-1.1.0.zip /sdcard/Download/
 *   node tools/android-cdp.js --file=test/device/import-via-ui.js --timeout=200000
 * ★ 2026-09-24 这一发在手机上就是炸在「读不到清单：解包失败，已回滚：Exception: 条目对照表不完整」，
 *   根因是 DfBridge 的 zip.read 把"一个名字"当对照表递给 PluginZip.extract（详见那行注释）。
 */
(async function () {
  var out = { steps: [] };
  function add(name, r) {
    out.steps.push({
      step: name, ok: !!(r && r.ok), cancelled: !!(r && r.cancelled),
      error: (r && r.error) || '',
      id: r && r.plugin && r.plugin.id, version: r && r.plugin && r.plugin.version,
      files: r && r.fileCount, perms: r && r.manifest && r.manifest.permissions
        && r.manifest.permissions.length
    });
    return r;
  }
  var t0 = Date.now();
  var p = add('inspect（选包 + 读清单 + 逐条 inflate）', await window.df.plugin.inspect());
  if (!p || !p.ok) return JSON.stringify(Object.assign(out, { ms: Date.now() - t0 }));
  var scopes = (p.manifest.permissions || []).map(function (x) { return x.scope; });
  var ins = add('install（批这份权限清单）', await window.df.plugin.install(p.token, scopes));
  var list = await window.df.plugin.list();
  out.installed = (list && list.plugins || []).map(function (x) {
    return x.id + ' ' + x.version + ' enabled=' + x.enabled;
  });
  var page = await window.df.plugin.page((list.plugins || [])[0] && (list.plugins || [])[0].id);
  out.pageOk = !!(page && page.ok);
  out.pageLen = page && page.html ? page.html.length : 0;
  return JSON.stringify(Object.assign(out, { ms: Date.now() - t0 }), null, 1);
})();
