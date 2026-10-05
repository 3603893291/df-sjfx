/* mock-df.js — 预览环境下的 window.df 模拟实现（仅开发预览用） */
(function (global) {
  'use strict';
  function qs(f) {
    f = f || {};
    var p = [];
    if (f.mode) p.push('mode=' + encodeURIComponent(f.mode));
    /* 「对局类型」这一维必须跟着走 —— 预览环境是第三个生产者，
     * 它在浏览器里替主进程拼查询串，少带一枚 = 界面在预览里看到的数与真机上不一样。 */
    if (f.kind) p.push('kind=' + encodeURIComponent(f.kind));
    if (f.leave) p.push('leave=' + encodeURIComponent(f.leave));
    if (f.since) p.push('since=' + encodeURIComponent(f.since));
    return p.length ? '?' + p.join('&') : '';
  }
  function get(p) { return fetch(p).then(function (r) { return r.json(); }); }
  function post(p, body) {
    return fetch(p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }
  var settings = { theme: 'system', autoSyncDetail: true, detailScope: 'all',
                   autoSyncInterval: 30, autoBackup: true, backupKeep: 7, backupDir: '' };

  /* 模拟采集：主进程 collector.collect 在预览环境不可用。
     这里让 mock 直接推进度到 /mock/sync/progress 事件队列；
     预览服务器没有 SSE，退化为本地 setTimeout 依次触发。 */
  var listeners = {};
  function fire(name, payload) {
    (listeners[name] || []).forEach(function (cb) { try { cb(payload); } catch (e) {} });
  }
  function fakeSync() {
    fire('sync:start', {});
    var stages = [
      { stage: '登录检测', percent: 5, label: '登录检测' },
      { stage: '赛季汇总', percent: 20, label: '赛季汇总' },
      { stage: '最近战局', percent: 40, label: '最近战局' },
      { stage: '分地图统计', percent: 55, label: '分地图统计' },
      { stage: '全场名单', percent: 80, done: 8, total: 8, label: '全场名单 8/8' },
      { stage: '入库中', percent: 99, label: '数据入库中…' }
    ];
    var i = 0;
    function tick() {
      if (i >= stages.length) {
        fire('sync:done', { ok: true });
        return post('/mock/sync', {});
      }
      fire('sync:progress', stages[i]);
      i++;
      setTimeout(tick, 320);
    }
    return new Promise(function (resolve) { setTimeout(tick, 100); });
  }

  /* 主进程用 webContents.send('plugin:evt') 把流式回包推给沙箱页，预览服务器没有这条通道，
     只能让浏览器来抽队列：取到的事件按同一个 name 走 fire，渲染层与插件页都不用知道自己跑在预览里。 */
  setInterval(function () {
    var frame = document.getElementById('pluginFrame');
    if (!frame || !frame.srcdoc) return;        /* 没有插件页挂着就不抽队列 */
    post('/mock/plugin/events', {}).then(function (r) {
      (r && r.events ? r.events : []).forEach(function (e) {
        fire('plugin:evt', { pluginId: e.pluginId, event: e.event, data: e.data || {} });
      });
    }).catch(function () { /* 服务器没起来就下一轮再试 */ });
  }, 40);

  /* 页面 URL 上的开关按位转发给 /mock/boot（探针 ⑥ 的四档分别用 nologin / localonly / nodata，可叠加） */
  var bootQ = (function () {
    var q = [];
    var s = global.location.search;
    if (/[?&]nologin=1/.test(s)) q.push('logged=0');
    if (/[?&]localonly=1/.test(s)) q.push('localonly=1');
    if (/[?&]nodata=1/.test(s)) q.push('nodata=1');
    return q.length ? '?' + q.join('&') : '';
  })();

  global.df = {
    boot: function () { return get('/mock/boot' + bootQ); },
    info: function () { return get('/mock/info'); },
    openLogin: function () { alert('预览模式：这里会打开 WeGame 登录窗口'); return Promise.resolve({ ok: true }); },
    checkLogin: function () {
      return get('/mock/boot' + bootQ).then(function (b) {
        return { ok: !!b.loggedIn, localOnly: !!b.localOnly, role: b.role };
      });
    },
    logout: function () { return post('/mock/logout', {}); },
    sync: function () { return fakeSync(); },

    report: function (f) { return get('/mock/report' + qs(f)); },
    matches: function (f) { return get('/mock/matches' + qs(f)); },
    counts: function () { return get('/mock/counts'); },
    match: function (rid) { return get('/mock/match/' + encodeURIComponent(rid)); },
    setFlag: function (rid, key, on) { return post('/mock/flag', { roomId: rid, key: key, on: !!on }); },
    setWatch: function (key, on, info) {
      return post('/mock/watch', { key: key, on: !!on, openid: (info && info.openid) || '', name: (info && info.name) || '' });
    },
    encounterDetail: function (vid) { return get('/mock/encounter/' + encodeURIComponent(vid)); },

    /* 关于页 / 地图沙盘：预览环境没有主进程，用浏览器能力代替 */
    openGithub: function () {
      window.open('https://github.com/3603893291/', '_blank');
      return Promise.resolve({ ok: true });
    },
    openSandbox: function () {
      window.open('https://aeuicey.github.io/DeltaForce-TacticalPanel/', '_blank');
      return Promise.resolve({ ok: true });
    },
    copyGroup: function () {
      var txt = '129994517';
      if (!navigator.clipboard) return Promise.resolve({ ok: false, error: '预览环境剪贴板不可用' });
      return navigator.clipboard.writeText(txt).then(function () {
        return { ok: true, text: txt };
      }).catch(function (e) {
        return { ok: false, error: String((e && e.message) || e) };
      });
    },

    exportData: function (fmt, filters) { return post('/mock/export', { fmt: fmt, filters: filters }); },
    bundle: function () { return post('/mock/bundle', {}); },
    restore: function () { return post('/mock/restore', {}); },
    openFolder: function () { return post('/mock/open-folder', {}); },
    reset: function (scope) { return post('/mock/reset', { scope: scope || 'current' }); },

    backupNow: function () { return post('/mock/backup/now', {}); },
    backupInfo: function () { return get('/mock/backup/info'); },
    backupOpen: function () { return post('/mock/backup/open', {}); },
    backupChooseDir: function () { return post('/mock/backup/choose-dir', {}); },

    saveCard: function () { return Promise.resolve({ ok: false, cancelled: true }); },
    copyCard: function () { return Promise.resolve({ ok: true }); },

    setSettings: function (p) { return post('/mock/settings', p || {}); },

    /* ★ 这里没有 ai.* —— 与 shell/preload.js 一致：AI 分析不再是内置功能，
       会外发的只有用户自己导入的插件包，能力面全部走下面的 df.plugin。 */
    plugin: {
      list: function () { return post('/mock/plugin/list', {}); },
      inspect: function (file) { return post('/mock/plugin/inspect', { file: file || '' }); },
      install: function (token, scopes) {
        return post('/mock/plugin/install', { token: token, acceptedScopes: scopes || [] });
      },
      setEnabled: function (id, on) { return post('/mock/plugin/setEnabled', { id: id, on: !!on }); },
      consent: function (id, sentence) {
        return post('/mock/plugin/consent', { id: id, sentence: String(sentence == null ? '' : sentence) });
      },
      revokeConsent: function (id) { return post('/mock/plugin/consent', { id: id, revoke: true }); },
      remove: function (id) { return post('/mock/plugin/remove', { id: id }); },
      verify: function (id) { return post('/mock/plugin/verify', { id: id }); },
      page: function (id) { return post('/mock/plugin/page', { id: id }); },
      call: function (id, method, args) {
        return post('/mock/plugin/call', { pluginId: id, method: method, args: args || {} });
      }
    },

    accounts: {
      list: function () { return get('/mock/account/list'); },
      add: function () { return post('/mock/account/add', {}); },
      switch: function (slot) { return post('/mock/account/switch', { slot: slot }); },
      logout: function (slot) { return post('/mock/account/logout', { slot: slot }); },
      remove: function (slot) { return post('/mock/account/remove', { slot: slot }); },
      globalSettings: function (p) { return post('/mock/account/global-settings', p || {}); }
    },

    mapNames: {
      status: function () { return get('/mock/mapNames/status'); },
      refresh: function () { return post('/mock/mapNames/refresh', {}); },
      /* #92 那两条：与桌面 preload / 安卓 df 桥同名同形（三处生产者，少一处界面就在那台设备上瘫） */
      dict: function () { return get('/mock/mapNames/dict'); },
      setName: function (p) { return post('/mock/mapNames/setName', p || {}); }
    },

    /* 在线更新：与桌面 preload / 安卓 df 桥同名同形（三处生产者，少一处界面就在那台设备上瘫）。
     * ★ 预览层这一发绝不出网 —— 回的是本地夹具，只为在浏览器里把"发现新版本"那一句版式量出来。 */
    update: {
      status: function () { return get('/mock/update/status'); },
      check: function () { return post('/mock/update/check', {}); },
      openDownload: function (p) { return post('/mock/update/openDownload', p || {}); }
    },

    on: function (name, cb) {
      listeners[name] = listeners[name] || [];
      listeners[name].push(cb);
    },
    /* 只有预览层才有的补发钩子：探针要验"刚登录上那一下"，可它点不开真 WeGame 登录窗口 */
    __fire: function (name, payload) { fire(name, payload); }
  };
})(window);
