/* android-cdp.js —— 把 MuMu / 真机上的那个 WebView 当回归目标驱动。
 *
 * 为什么要有这一份：这台机器以前"没有任何可跑的安卓目标"，于是 Java 那几条通道
 * 只能靠 Node 里的假原生去测 —— 而假原生写错语义的时候，测试照样全绿（导入插件
 * 「条目对照表不完整」那条真机 bug 就是这么漏过去的）。现在 MuMu + adb 能连上
 * WebView 的 DevTools 协议，页面里的 window.df 与 AndroidBridge 都可以直接喊。
 *
 * 只在"可调试构建"里能用：MainActivity 里那道 WebView.setWebContentsDebuggingEnabled
 * 认的是 FLAG_DEBUGGABLE，release 包连不上（这条工具也就自动失效，不会变成后门）。
 *
 * 用法：
 *   node tools/android-cdp.js --bridge=zip.list --args='{"name":"import-plugin.zip"}'
 *   node tools/android-cdp.js --file=path/to/probe.js         # 文件内容是一个表达式
 *   node tools/android-cdp.js --eval='location.href'
 * 可选：--serial=127.0.0.1:16384 --port=9223 --pkg=com.df.battleanalyzer
 *       --url-prefix=https://dfapp.local --timeout=30000
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

function arg(name, dflt) {
  const hit = process.argv.slice(2).find(function (a) { return a.startsWith('--' + name + '='); });
  return hit === undefined ? dflt : hit.slice(name.length + 3);
}
const has = function (name) {
  return process.argv.slice(2).some(function (a) { return a === '--' + name; });
};

const SERIAL = arg('serial', '');
const PORT = Number(arg('port', 9222));
const PKG = arg('pkg', 'com.df.battleanalyzer');
const PREFIX = arg('url-prefix', 'https://dfapp.local');
const TIMEOUT = Number(arg('timeout', 30000));

function findAdb() {
  const cands = [
    process.env.DF_ADB,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe') : '',
    process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe') : '',
  ].filter(Boolean);
  for (let i = 0; i < cands.length; i++) if (fs.existsSync(cands[i])) return cands[i];
  throw new Error('找不到 adb.exe（给 --serial 之前先设环境变量 DF_ADB 指向 SDK 里那一份）');
}

const ADB = findAdb();
/* ★ 第三个参数是"这一发打给哪台"。SERIAL 已经由这里统一拼进去，调用方再手写一遍
 *   `-s <serial>` 就会变成 `adb -s X -s X shell ...`（--serial 一给就当场失败，
 *   而报出来的错长得像"设备没在跑"）。 */
function adb(args, allowFail, serial) {
  const s = serial || SERIAL;
  try {
    return execFileSync(ADB, (s ? ['-s', s] : []).concat(args),
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (allowFail) return '';
    throw new Error('adb ' + args.join(' ') + ' 失败：' + ((e.stderr || e.message) + '').trim());
  }
}

function pickDevice() {
  if (SERIAL) return SERIAL;
  const lines = adb(['devices']).split(/\r?\n/).slice(1)
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l && /\tdevice$/.test(l); });
  if (lines.length === 0) throw new Error('adb devices 是空的（MuMu 没开？还是没 adb connect？）');
  if (lines.length > 1) {
    throw new Error('连着 ' + lines.length + ' 台目标，请用 --serial= 指定：\n  '
      + lines.map(function (l) { return l.split('\t')[0]; }).join('\n  '));
  }
  return lines[0].split('\t')[0];
}

async function pageTarget(serial) {
  const pid = adb(['shell', 'pidof', '-s', PKG], true, serial).trim();
  if (!pid) throw new Error(PKG + ' 没在跑（先 am start -n ' + PKG + '/.MainActivity）');
  const sock = 'webview_devtools_remote_' + pid;
  adb(['forward', 'tcp:' + PORT, 'localabstract:' + sock], false, serial);
  const list = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'));
  const pages = list.filter(function (t) { return t.type === 'page' && (t.url || '').startsWith(PREFIX); });
  if (!pages.length) {
    throw new Error('没有以 ' + PREFIX + ' 开头的页面；现在开着的是：'
      + list.map(function (t) { return t.type + ' ' + t.url; }).join(' | '));
  }
  /* 主框才是带令牌的那一页；同名多条时取最新的一个（旧的可能是 reload 前留下的） */
  pages.sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });
  return { ws: pages[0].webSocketDebuggerUrl, pid: pid, id: pages[0].id };
}

function get(url) {
  return new Promise(function (res, rej) {
    const req = http.get(url, function (r) {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', function (c) { body += c; });
      r.on('end', function () { res(body); });
    });
    req.on('error', rej);
    req.setTimeout(8000, function () { req.destroy(new Error('DevTools HTTP 超时')); });
  });
}

/** 一条表达式 → 页面里跑完 → 值（returnByValue + awaitPromise，所以可以回 Promise） */
function evaluate(wsUrl, expression) {
  return new Promise(function (res, rej) {
    const ws = new WebSocket(wsUrl);
    let done = false;
    const watchdog = setTimeout(function () {
      if (done) return;
      done = true;
      try { ws.close(); } catch (e) { /* ignore */ }
      rej(new Error('CDP 超时 ' + TIMEOUT + 'ms：这一发没回话（页面卡住与没接上长得很像，所以要报时间）'));
    }, TIMEOUT);
    /* 教训照搬：一条永不落地的 promise + 事件循环抽干 = Node 以 0 退出、一个字都不打。
     * 这颗表不 unref，它保证"跑不完"一定以非零退出收场。 */
    ws.onopen = function () { ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
      params: { expression: expression, returnByValue: true, awaitPromise: true } })); };
    ws.onmessage = function (ev) {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== 1) return;
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      try { ws.close(); } catch (e) { /* ignore */ }
      if (msg.error) return rej(new Error('CDP：' + msg.error.message));
      const r = msg.result || {};
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        return rej(new Error('页面里抛了：' + ((d.exception && d.exception.description) || d.text)));
      }
      res(r.result && r.result.value);
    };
    ws.onerror = function () {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      rej(new Error('WebSocket 连不上 ' + wsUrl + '（这个构建没开远程调试？还是进程又换了 pid？）'));
    };
  });
}

/** 直接喊一条原生通道：令牌从主框 URL 上现读，不在命令行里复述一遍
 *  ★ 签名是 call(channel, argsJson, id, token) —— 顺序错了不会报错，只会把通道名当 JSON 解析炸掉 */
function bridgeExpression(channel, argsJson) {
  return '(async function(){'
    + 'var tk=new URLSearchParams(location.search).get("bt")||"";'
    + 'return await new Promise(function(res,rej){'
    + '  window.__cdpSeq = (window.__cdpSeq || 900000) + 1;'
    + '  var id = window.__cdpSeq;'
    + '  var old=window.__reply;'
    + '  window.__reply=function(got,text){ if(got!==id) { old&&old(got,text); return; }'
    + '    window.__reply=old; if(text==null) return res(null);'
    + '    try { res(JSON.parse(text)); } catch (e) { res({ ok: true, raw: String(text) }); } };'
    + '  AndroidBridge.call(' + JSON.stringify(channel) + ',' + JSON.stringify(argsJson) + ',id,tk);'
    + '});'
    + '})()';
}

async function main() {
  const serial = pickDevice();
  const target = await pageTarget(serial);
  const evalArg = arg('eval', '');
  const file = arg('file', '');
  const chan = arg('bridge', '');
  let expression;
  if (chan) expression = bridgeExpression(chan, arg('args', '{}'));
  else if (file) expression = String(fs.readFileSync(file, 'utf8'));
  else if (evalArg) expression = evalArg;
  else throw new Error('要给出 --bridge= / --file= / --eval= 三者之一');

  const value = await evaluate(target.ws, expression);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, has('pretty') ? 2 : 0));
  adb(['forward', '--remove', 'tcp:' + PORT], true, serial);
}

main().catch(function (e) {
  console.error('× ' + ((e && e.message) || e));
  process.exit(1);
});
