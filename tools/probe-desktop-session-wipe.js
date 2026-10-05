/**
 * 开发者探针（不进 npm test，要真 Electron 才能跑）：
 *   "../.workbuddy/electron-dist/electron.exe" tools/probe-desktop-session-wipe.js
 * 结果同时写 %TEMP%\df-wipe-probe.log（Electron 是 GUI 子系统进程，stdout 会被截断）。
 *
 * 为什么要有这一份：上一轮给安卓写会话清理时，我照着别处的名字写了三个 Android 根本没有的
 * API，离线测试全绿、gradle 当场挂。所以这一轮的规矩是 **API 名字先在这个运行时里量出来**，
 * 再用真数据逐个落检（清没清干净不许靠"调用没报错"），并且确认清 A 号不牵连 B 号。
 *
 * 已经量到的两条硬事实（写在这里免得下次又猜）：
 *   · `session.clearStorageData({storages:[…]})` 对**不存在的名字静悄悄忽略** —— 传错等于没清，不许按调用成功算；
 *   · `history` **不是**一个 storage 名字，会话历史只能走 `webContents.clearHistory()`（Session 上没有 clearHistory）。
 */
const { app, session, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'df-wipe-probe-'));
app.setPath('userData', path.join(tmp, 'user-data'));
app.disableHardwareAcceleration();
/* Windows 上最后一扇窗一关，Electron 默认就退出 —— 这份探针中途要 destroy 换窗，
 * 不接管这一步它只来得及打第一条就静悄悄 exit 0（上一轮就是这么"跑过了"）。 */
app.on('window-all-closed', function () { /* 由 app.exit 收尾 */ });

const LOG = path.join(os.tmpdir(), 'df-wipe-probe.log');
function out(obj) {
  const line = JSON.stringify(obj);
  process.stdout.write(line + '\n');
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) { /* stdout 已有 */ }
}
process.on('uncaughtException', function (e) { out({ crash: String((e && e.stack) || e) }); app.exit(2); });
process.on('unhandledRejection', function (e) { out({ rejected: String((e && e.stack) || e) }); app.exit(3); });
try { fs.writeFileSync(LOG, ''); } catch (e) { /* ignore */ }

const SLOT_A = 'probe-a';
const SLOT_B = 'probe-b';
/* 本地正常源：data: / file: 都是不透明源，localStorage 与 IndexedDB 在上面直接抛 SecurityError，
 * 那样量出来的"清干净了"是假象（第一步就得先让它写得进去）。 */
const WEGAME_URL = 'https://www.wegame.com.cn/login_probe';
const READ = '(function(){return {ls: localStorage.getItem("df_probe_ls"),' +
  ' ss: sessionStorage.getItem("df_probe_ss"), idb: !!window.__idbOk};})()';

async function seedCookies(ses, tag) {
  await ses.cookies.set({ url: WEGAME_URL, name: 'df_probe_sid_' + tag, value: 'leak', httpOnly: true, secure: true });
  await ses.cookies.set({ url: WEGAME_URL, name: 'df_probe_js_' + tag, value: 'leak' });
}

async function seedStorage(win) {
  return win.webContents.executeJavaScript(
    'localStorage.setItem("df_probe_ls","1");sessionStorage.setItem("df_probe_ss","1");' +
    'new Promise(function(r){var q=indexedDB.open("df_probe_idb",1);' +
    'q.onsuccess=function(){window.__idbOk=true;r(1)};q.onerror=function(){window.__idbOk=false;r(0)}});');
}

app.whenReady().then(async function () {
  const srv = http.createServer(function (q, s) {
    s.writeHead(200, { 'Content-Type': 'text/html' }); s.end('<h1>probe</h1>');
  });
  await new Promise(function (r) { srv.listen(0, '127.0.0.1', r); });
  const PAGE = 'http://127.0.0.1:' + srv.address().port + '/p';

  const sesA = session.fromPartition('persist:wegame-slot-' + SLOT_A);
  const sesB = session.fromPartition('persist:wegame-slot-' + SLOT_B);

  /* 1) 这个运行时的 Session / WebContents 上到底有哪些清理 API —— 逐个量，不许按记忆写 */
  const api = {};
  ['clearStorageData', 'clearCache', 'clearHistory', 'clearAuthCache', 'flushStorageData', 'clearCodeCache']
    .forEach(function (n) { api['session.' + n] = typeof sesA[n]; });
  const w0 = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:wegame-slot-' + SLOT_A } });
  ['clearHistory', 'clearCache', 'reload'].forEach(function (n) { api['webContents.' + n] = typeof w0.webContents[n]; });
  w0.destroy();
  out({ step: 1, electron: process.versions.electron, chrome: process.versions.chrome, api: api });

  /* 2) storages 名单里哪些是真的、哪些被静悄悄吞掉（"调用没报错"不能当证据，所以第 4 步要落检） */
  const tried = {};
  const cands = ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache',
    'websql', 'serviceworkers', 'cachestorage', 'mediasource', 'history', 'not_a_type'];
  for (const c of cands) {
    try { await sesA.clearStorageData({ storages: [c] }); tried[c] = 'accepted'; }
    catch (e) { tried[c] = 'rejected'; }
  }
  out({ step: 2, clearStorageDataUnknownNamesAreSilentlyAccepted: tried });

  /* 3) 两个号各下一枚 cookie；A 号再写 localStorage / sessionStorage / IndexedDB */
  await seedCookies(sesA, 'A');
  await seedCookies(sesB, 'B');
  const w1 = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:wegame-slot-' + SLOT_A } });
  await w1.loadURL(PAGE);
  const seedResult = await seedStorage(w1);
  const before = await w1.webContents.executeJavaScript(READ);
  const cookiesA0 = (await sesA.cookies.get({})).map(function (c) { return c.name; });
  const cookiesB0 = (await sesB.cookies.get({})).map(function (c) { return c.name; });
  out({ step: 3, seeded: seedResult, before: before, cookiesA: cookiesA0, cookiesB: cookiesB0 });

  /* 4) 这一段与 shell/main.js 的 wipeLoginSession() 一一对应：改一处必须改两处 */
  const WIPE_STORAGES = ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage',
    'shadercache', 'websql', 'serviceworkers', 'cachestorage', 'mediasource'];
  const wipe = [];
  async function t(label, fn) {
    try { await fn(); wipe.push([label, 'ok']); }
    catch (e) { wipe.push([label, 'fail: ' + String((e && e.message) || e).slice(0, 90)]); }
  }
  await t('clearStorageData', function () { return sesA.clearStorageData({ storages: WIPE_STORAGES }); });
  await t('clearCache', function () { return sesA.clearCache(); });
  await t('clearAuthCache', function () { return sesA.clearAuthCache(); });
  await t('webContents.clearHistory', function () { w1.webContents.clearHistory(); return Promise.resolve(); });
  await t('flushStorageData', function () { sesA.flushStorageData(); return Promise.resolve(); });
  out({ step: 4, wipe: wipe });

  /* 5) 换个新窗回读（旧窗还攥着内存里那份 storage），并看 B 号有没有被牵连 */
  w1.destroy();
  const w2 = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:wegame-slot-' + SLOT_A } });
  await w2.loadURL(PAGE);
  const after = await w2.webContents.executeJavaScript(READ);
  const cookiesA1 = (await sesA.cookies.get({})).map(function (c) { return c.name; });
  const cookiesB1 = (await sesB.cookies.get({})).map(function (c) { return c.name; });
  out({ step: 5, after: after, cookiesAAfter: cookiesA1, cookiesBAfter: cookiesB1,
    verdict: {
      cookiesGone: cookiesA1.length === 0,
      localStorageGone: after.ls === null,
      indexedDbGone: after.idb === false,
      /* sessionStorage 属于"这一个页签"，换新窗本来就该是 null，不能当证据 */
      otherSlotUntouched: cookiesB1.length === cookiesB1.length && cookiesB1.length > 0
    } });
  w2.destroy();
  srv.close();
  app.exit(0);
}).catch(function (e) {
  out({ fatal: String((e && e.stack) || e) });
  app.exit(1);
});
