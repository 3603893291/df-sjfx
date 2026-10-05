/* async.js — Promise 工具（纯 JS，UMD：Node 与浏览器通用，零平台 API）
 * 单独成模块只为了可测：这些超时逻辑决定「断网时界面会不会永久卡住」，
 * 而主进程里的调用点在 Electron 外面跑不到，只能把纯逻辑抽出来在 core.test.js 里断言。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.DFCore = root.DFCore || {}; root.DFCore.Async = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /* 到点就用 fallback 兑现，不等原 Promise。用于「必须会返回」的启动路径：
   * 官方接口在断网时可能既不 resolve 也不 reject，调用方一挂，界面就永远停在加载态。 */
  function withTimeout(promise, ms, fallback) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve(fallback);
      }, ms);
      Promise.resolve(promise).then(function (v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      }, function (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: 'error', message: String((e && e.message) || e) });
      });
    });
  }

  /* 流式响应专用：每次收到数据就续期，长时间静默才算超时（连接活着但没字节的场景） */
  function idleTimer(onIdle, ms) {
    var timer = null, closed = false;
    function arm() {
      if (closed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { if (!closed) onIdle(); }, ms);
    }
    arm();
    return { touch: arm, stop: function () { closed = true; if (timer) clearTimeout(timer); } };
  }

  return { withTimeout: withTimeout, idleTimer: idleTimer };
});
