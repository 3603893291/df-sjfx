'use strict';
/* preload.js — 暴露给渲染进程的安全 API（不暴露 Node） */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('df', {
  boot: () => ipcRenderer.invoke('app:boot'),
  info: () => ipcRenderer.invoke('app:info'),

  openLogin: (slot) => ipcRenderer.invoke('login:open', { slot: slot || null }),
  checkLogin: () => ipcRenderer.invoke('login:check'),
  logout: () => ipcRenderer.invoke('login:logout'),

  sync: (opts) => ipcRenderer.invoke('sync:run', opts || {}),

  report: (filters) => ipcRenderer.invoke('data:report', filters || {}),
  matches: (filters) => ipcRenderer.invoke('data:matches', filters || {}),
  counts: () => ipcRenderer.invoke('data:counts'),
  match: (roomId) => ipcRenderer.invoke('data:match', roomId),
  setFlag: (roomId, key, on) => ipcRenderer.invoke('data:flag', { roomId: roomId, key: key, on: !!on }),
  setWatch: (key, on, info) => ipcRenderer.invoke('data:watch', {
    key: key, on: !!on, openid: (info && info.openid) || '', name: (info && info.name) || ''
  }),
  encounterDetail: (vopenid, filters) => ipcRenderer.invoke('data:encounter', vopenid, filters),

  /* 关于页：链接与群号都写死在主进程，渲染层只能点这两个按钮 */
  openGithub: () => ipcRenderer.invoke('app:openGithub'),
  copyGroup: () => ipcRenderer.invoke('app:copyGroup'),
  openSandbox: () => ipcRenderer.invoke('app:openSandbox'),

  exportData: (fmt, filters) => ipcRenderer.invoke('data:export', { fmt: fmt, filters: filters }),
  bundle: () => ipcRenderer.invoke('data:bundle'),
  restore: () => ipcRenderer.invoke('data:restore'),
  openFolder: () => ipcRenderer.invoke('data:openFolder'),
  reset: (scope) => ipcRenderer.invoke('data:reset', { scope: scope || 'current' }),

  backupNow: () => ipcRenderer.invoke('backup:now'),
  backupInfo: () => ipcRenderer.invoke('backup:info'),
  backupOpen: () => ipcRenderer.invoke('backup:open'),
  backupChooseDir: () => ipcRenderer.invoke('backup:chooseDir'),

  /* 扩展插件：渲染层只能做这几个动作。zip 字节、文件路径、解包内容都不经渲染层，
   * 插件页面的能力调用一律由主进程重新查权限（见 shell/plugin-api.js）。
   * ★ 这里没有 ai.* —— AI 分析不再是内置功能，它会以用户自己导入的插件包回来。 */
  plugin: {
    list: () => ipcRenderer.invoke('plugin:list'),
    inspect: () => ipcRenderer.invoke('plugin:inspect'),
    install: (token, acceptedScopes) =>
      ipcRenderer.invoke('plugin:install', { token: token, acceptedScopes: acceptedScopes || [] }),
    setEnabled: (id, on) => ipcRenderer.invoke('plugin:setEnabled', { id: id, on: !!on }),
    /* 逐字确认与撤销都走这一条：判定在主进程，渲染层只是把手打字的原文递过去 */
    consent: (id, sentence) =>
      ipcRenderer.invoke('plugin:consent', { id: id, sentence: String(sentence == null ? '' : sentence) }),
    revokeConsent: (id) => ipcRenderer.invoke('plugin:consent', { id: id, revoke: true }),
    remove: (id) => ipcRenderer.invoke('plugin:remove', { id: id }),
    verify: (id) => ipcRenderer.invoke('plugin:verify', { id: id }),
    page: (id) => ipcRenderer.invoke('plugin:page', { id: id }),
    call: (pluginId, method, args) =>
      ipcRenderer.invoke('plugin:call', { pluginId: pluginId, method: method, args: args || {} })
  },

  saveCard: (payload) => ipcRenderer.invoke('card:save', payload),
  copyCard: (payload) => ipcRenderer.invoke('card:copy', payload),

  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  accounts: {
    list: () => ipcRenderer.invoke('account:list'),
    add: () => ipcRenderer.invoke('account:add'),
    switch: (slot) => ipcRenderer.invoke('account:switch', slot),
    logout: (slot) => ipcRenderer.invoke('account:logout', slot),
    remove: (slot) => ipcRenderer.invoke('account:remove', slot),
    globalSettings: (patch) => ipcRenderer.invoke('account:globalSettings', patch || {})
  },

  /* 地图名（官方公开配置表 → 本机学名表）。渲染层只有这两条：
   * 拿状态、点一下「更新」。URL、出网、合并、落盘全在主进程，界面连名字表都摸不到。 */
  mapNames: {
    status: () => ipcRenderer.invoke('mapNames:status'),
    refresh: () => ipcRenderer.invoke('mapNames:refresh'),
    /* #92 那两条：看本机字典 / 改一张图的名字。都只动本机，一律不出网。 */
    dict: () => ipcRenderer.invoke('mapNames:dict'),
    setName: (payload) => ipcRenderer.invoke('mapNames:setName', payload)
  },

  /* 在线更新：界面只拿得到"查到了什么"和"打开下载地址"，
   * 那个 URL 与下载动作都不在渲染层 —— 我们不代他下载、也不动安装目录 */
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    check: () => ipcRenderer.invoke('update:check'),
    openDownload: (payload) => ipcRenderer.invoke('update:openDownload', payload)
  },

  on: (channel, cb) => {
    const allow = ['sync:start', 'sync:progress', 'sync:done', 'sync:auto',
                   'login:done', 'login:probe', 'login:window-closed',
                   'boot:ready', 'boot:error', 'account:changed', 'plugin:evt',
                   'mapNames:done', 'update:status'];
    if (allow.indexOf(channel) === -1) return;
    ipcRenderer.on(channel, (evt, payload) => cb(payload));
  }
});
