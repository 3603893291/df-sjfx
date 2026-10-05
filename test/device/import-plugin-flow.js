/* 设备上真跑一遍"导入插件包"那条链（在页面里求值的表达式，由 tools/android-cdp.js 送进去）。
 *
 * 为什么长这样：他报的故障在真 Java 那一侧（zip.read 借 extract 读清单），Node 里的假原生
 * 曾经全绿却照样坏。这一份不猜、不改代码，只按 android/js/plugin-host.js 的同一顺序
 * 把每条通道真喊一遍，把每一条的原始回包打出来 —— 手机上「解包失败，已回滚」那一类
 * 从此可以在这台机器上看到，而不是等回话。
 *
 * 跑法（两条命令）：
 *   adb push plugins-dist/df.demo.summary-1.1.0.zip /data/local/tmp/p.zip
 *   adb shell "run-as com.df.battleanalyzer cp /data/local/tmp/p.zip /data/data/com.df.battleanalyzer/files/import-plugin.zip"
 *   node tools/android-cdp.js --file=test/device/import-plugin-flow.js
 * ★ 前提：装的是可调试构建（MainActivity 里那道 FLAG_DEBUGGABLE 判据）。
 */
(async function () {
  var TOKEN = new URLSearchParams(location.search).get('bt') || '';
  var seq = 700000;
  function call(channel, args) {
    return new Promise(function (res) {
      var id = ++seq;
      var old = window.__reply;
      window.__reply = function (got, text) {
        if (got !== id) { old && old(got, text); return; }
        window.__reply = old;
        try { res(JSON.parse(text)); } catch (e) { res({ ok: true, raw: String(text) }); }
      };
      AndroidBridge.call(channel, JSON.stringify(args || {}), id, TOKEN);
    });
  }
  var out = { page: location.href.slice(0, 40), steps: [] };
  function push(name, ok, r) {
    out.steps.push({
      step: name, ok: !!ok,
      error: (r && r.error) || '',
      /* 只留判读要用的那几个字段，别把整份清单文本喷出来 */
      count: r && r.count, files: r && r.files && r.files.length,
      entry: r && r.entries && r.entries.length,
      textLen: r && r.text ? String(r.text).length : undefined,
      hash: r && r.files && r.files[0] && r.files[0].hash
    });
    return r;
  }
  function step(name, r) { return push(name, !!(r && r.ok), r); }
  /* ★ 反向的那一类：这一发**必须被拒**才算过（只认前缀锁那句话，别把任何错误都当通过）。 */
  function rejectStep(name, r, mustMention) {
    return push(name + '（必须被拒）', !!(r && !r.ok && String(r.error || '').indexOf(mustMention) >= 0), r);
  }

  /* 1) 开箱：列条目（Java 只报名字与大小，不猜要剥哪层） */
  const z = step('zip.list', await call('zip.list', { name: 'import-plugin.zip' }));
  const entries = (z && z.entries) || [];
  /* 2) 剥外层目录：这条判据在 JS，Java 只按对照表执行 */
  const specs = entries.filter(function (e) { return !e.dir; })
    .map(function (e) { return { want: e.name, has: e.name }; });
  /* 3) 读清单 —— 他手机上炸的就是这一发 */
  const man = specs.filter(function (s) { return s.has === 'manifest.json'; })[0];
  step('zip.read manifest.json', man
    ? await call('zip.read', { name: 'import-plugin.zip', entry: man.want })
    : { ok: false, error: '包里没有 manifest.json' });
  /* 4) 逐条 inflate 拿真实字节与哈希（键名必须是 entries） */
  step('zip.audit', await call('zip.audit', {
    name: 'import-plugin.zip', entries: specs,
    maxEntry: 2 * 1024 * 1024, maxTotal: 8 * 1024 * 1024
  }));
  /* 5) 整目录落到临时 id，再改名成正式 id —— 装包那两步 */
  const tmp = 'dev-tmp-' + Date.now().toString(36);
  step('zip.extract → ' + tmp, await call('zip.extract', {
    name: 'import-plugin.zip', into: tmp, entries: specs,
    maxEntry: 2 * 1024 * 1024, maxTotal: 8 * 1024 * 1024
  }));
  step('plugin.hashDir', await call('plugin.hashDir', { id: tmp }));
  step('plugin.read main.js', await call('plugin.read', { id: tmp, name: 'main.js' }));
  step('plugin.removeDir', await call('plugin.removeDir', { id: tmp }));

  /* 6) 顺手把两件"本机从没跑过"的也量了：地图名那一发与它的状态 */
  step('cfg.mapNames', await call('cfg.mapNames', {
    url: (window.DFCore && window.DFCore.MapConfig ? window.DFCore.MapConfig.URL : 'https://x/')
  }));
  rejectStep('cfg.mapNames 越界地址', await call('cfg.mapNames', {
    url: 'https://example.com/anything'
  }), '只允许从官方配置表');
  out.dfMapNames = window.df && window.df.mapNames ? await window.df.mapNames.status() : null;
  out.pass = out.steps.filter(function (s) { return s.ok; }).length;
  out.fail = out.steps.filter(function (s) { return !s.ok; }).map(function (s) { return s.step; });
  return JSON.stringify(out, null, 1);
})();
