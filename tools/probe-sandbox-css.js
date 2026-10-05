/**
 * 开发者探针（不进 npm test，要真 Electron 才能跑，而且要能联网）：
 *   "../.workbuddy/electron-dist/electron.exe" tools/probe-sandbox-css.js
 * 结果同时写 %TEMP%\df-sandbox-css.log（Electron 是 GUI 子系统进程，stdout 会被截断）。
 *
 * 这一份只量三件事，全是我们自己猜不出来、必须在这个运行时里量的：
 *   ① `webContents.insertCSS` 在这台 Electron 上到底有没有、调用回什么（Promise 还是 undefined）；
 *   ② 沙盘那家站点第一个弹窗的类名，今天真在实时页面上存在（我是从对方 main-*.js 里定位的，
 *      定位错就等于那条 CSS 永远不命中 —— 而界面只会"弹窗还在"，测试一点痕迹都没有）；
 *   ③ 注了那条 CSS 之后，那一层遮罩的 computed display 真的变成 none，且页面其余部分还在
 *      （不许顺手把地图本身也藏掉）。
 * ★ 地址与那条 CSS 都从 shell/main.js 现读，不在这里抄第二份（抄了就会漂）。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'shell', 'main.js'), 'utf8');
const URL_V = (/(?:const|var) SANDBOX_URL = '([^']+)'/.exec(mainSrc) || [])[1] || '';
const CSS_V = (/(?:const|var) SANDBOX_CSS = '([^']+)'/.exec(mainSrc) || [])[1] || '';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'df-sandbox-css-'));
app.setPath('userData', path.join(tmp, 'user-data'));

const LOG = path.join(os.tmpdir(), 'df-sandbox-css.log');
function out(obj) {
  const line = JSON.stringify(obj);
  process.stdout.write(line + '\n');
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) { /* stdout 已有 */ }
}
process.on('uncaughtException', e => { out({ crash: String((e && e.stack) || e) }); app.exit(2); });
process.on('unhandledRejection', e => { out({ rejected: String((e && e.stack) || e) }); app.exit(3); });
app.on('window-all-closed', function () { /* 由 app.exit 收尾，别让默认行为提前退 */ });
try { fs.writeFileSync(LOG, ''); } catch (e) { /* ignore */ }

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* 量的是渲染出来的那一层，不是源码里有这个词：元素在不在、display 算出来是什么、盖不盖住地图 */
const PROBE = function () {
  var el = document.querySelector('.startup-notice-backdrop');
  var dlg = document.querySelector('.startup-notice-dialog');
  var enter = document.querySelector('.startup-notice-enter');
  var q = document.querySelector('.startup-notice-group');
  function disp(n) {
    if (!n) return null;
    try { return getComputedStyle(n).display; } catch (e) { return 'err'; }
  }
  /* 弹窗底下那张地图自己还在不在：只许藏这一层，不许把整页弄白 */
  var app = document.querySelector('#app');
  return {
    backdrop: !!el, dialog: !!dlg, enterBtn: !!enter, qqLine: !!q,
    backdropDisplay: disp(el), dialogDisplay: disp(dlg),
    bodyChildren: (document.body || {}).childElementCount || 0,
    appHasContent: !!app && app.childElementCount > 0,
    title: document.title || ''
  };
};

app.whenReady().then(async function () {
  out({ step: 0, url: URL_V, css: CSS_V, electron: process.versions.electron,
    chrome: process.versions.chrome });
  if (!/^https:\/\/aeuicey\.github\.io\/DeltaForce-TacticalPanel\/$/.test(URL_V)) {
    out({ verdict: 'FAIL', why: 'shell/main.js 里的 SANDBOX_URL 不是那一家：' + URL_V });
    app.exit(1); return;
  }
  if (!/startup-notice-backdrop/.test(CSS_V)) {
    out({ verdict: 'FAIL', why: 'SANDBOX_CSS 里没有那个类名：' + CSS_V });
    app.exit(1); return;
  }

  const win = new BrowserWindow({ width: 1280, height: 800, show: false });
  const wc = win.webContents;
  out({ step: 1, api: { insertCSS: typeof wc.insertCSS, executeJavaScript: typeof wc.executeJavaScript } });
  if (typeof wc.insertCSS !== 'function') {
    out({ verdict: 'FAIL', why: '这台 Electron 的 webContents 没有 insertCSS —— 那条压弹窗的做法在这上面做不到' });
    app.exit(1); return;
  }

  let failed = '';
  wc.on('did-fail-load', function (e, code, desc, url) { failed = code + ' ' + desc + ' ' + url; });
  try { await wc.loadURL(URL_V); } catch (e) { failed = String((e && e.message) || e); }

  /* 对方是 SPA：先等它把那一层遮罩渲染出来（最多 15 秒），量"注 CSS 之前"的样子 */
  let before = null;
  for (let i = 0; i < 30; i++) {
    try { before = await wc.executeJavaScript('(' + PROBE.toString() + ')()'); }
    catch (e) { before = { err: String((e && e.message) || e) }; }
    if (before && before.backdrop) break;
    await sleep(500);
  }
  out({ step: 2, failLoad: failed, before: before });
  if (!before || !before.backdrop) {
    out({ verdict: 'FAIL', why: '页面上等 15 秒也没出现 .startup-notice-backdrop：' +
      '要么对方改了类名（那条 CSS 得跟着改），要么这一发没连上网（failLoad=' + (failed || '无') + '）' });
    app.exit(1); return;
  }

  let ret;
  try { ret = await wc.insertCSS(CSS_V); }
  catch (e) { ret = 'THROW: ' + String((e && e.message) || e); }
  out({ step: 3, insertCSS_return: ret === undefined ? 'undefined' : String(ret).slice(0, 40) });

  await sleep(400);
  const after = await wc.executeJavaScript('(' + PROBE.toString() + ')()');
  out({ step: 4, after: after });

  const hidden = after.backdrop === true && (after.backdropDisplay === 'none' ||
    after.dialogDisplay === 'none') && after.appHasContent === true;
  out({ verdict: hidden ? 'PASS' : 'FAIL',
    why: hidden ? '遮罩注 CSS 前 display=' + before.backdropDisplay + '，注后=' + after.backdropDisplay :
      '注了那条 CSS 之后那一层还在（display=' + after.backdropDisplay + '）或页面本身被弄没了' });
  app.exit(hidden ? 0 : 1);
});
