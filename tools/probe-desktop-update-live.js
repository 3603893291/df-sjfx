/**
 * 开发者探针（不进 npm test、不进交付包，要真 Electron + 真网络才能跑）：
 *   node tools/probe-desktop-update-live.js            # 默认打 dist 里那份 exe
 *   node tools/probe-desktop-update-live.js --root="<解压出来的程序目录>"
 *
 * 它量的是**只有一台真机器上才量得到**的那件事：开机 6 秒后自动那一发跑完了，界面那一行
 * 有没有自己把话念出来 —— 全程不点「重新检查」。
 * 为什么离线测试量不到：`--selftest` 那道闸本身就挡住出网（`SELFTEST && !--live-sync` 直接 return），
 * 而 `update.test.js` 只能钉形状，钉不出"宿主 checked:true 而那一行还停在「还没检查过。」"
 * —— 2026-09-30 就是靠这一份在桌面上量出来的（手册 §11 增补二十一）。
 *
 * ★ 两条跑法上的坑（都在这份脚本里踩过）：
 *   · 等自动那一发要等过 **6 秒 + 网络超时 10 秒**，只等 11 秒读到的是"还在路上"（checked:false），
 *     看着像没修好；这里默认等 24 秒。
 *   · CDP 的 `Runtime.evaluate` 回包是 `{id, result:{result:{type,value}}}` —— 少剥一层永远读不到 value，
 *     而且不会报错，只会静悄悄给你个 undefined。
 *
 * 数据安全：这一跑用 `%TEMP%` 下的独立 `--user-data-dir`，不碰使用者那个目录；
 * 结束时只 kill 自己起的那只 pid（他的实例是从 dist 直接起的，杀错人就麻烦了）。
 */
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

function arg(name, dft) {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(hit.indexOf('=') + 1) : dft;
}
const ROOT = path.join(__dirname, '..');
const APP = arg('root', path.join(ROOT, 'dist', '三角洲全面战场分析器'));
const EXE = path.join(APP, '三角洲全面战场分析器.exe');
const PORT = Number(arg('port', 9341));
const WAIT = Number(arg('wait', 24000));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'df-upd-live-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b)); }).on('error', rej);
});
if (!fs.existsSync(EXE)) { console.log('找不到 exe：' + EXE + '（先 node build.js，或 --root= 指到解压出来那一份）'); process.exit(1); }

const env = Object.assign({}, process.env);
delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;   /* 带着这两个起 GUI 会当场认不出是 Electron */
const child = spawn(EXE, ['--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
  '--no-sandbox', '--disable-gpu', '--in-process-gpu'], { env, stdio: 'ignore' });
function bye(code) { try { child.kill(); } catch (e) {} process.exit(code); }

(async function () {
  let page = null;
  for (let i = 0; i < 90 && !page; i++) {
    await sleep(400);
    try {
      const list = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'));
      page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    } catch (e) { /* 还没起来 */ }
  }
  if (!page) { console.log('CDP 起不来（这一跑要真网络：域名解析不到时那一发也会走完，但界面得先起得来）'); bye(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let n = 0; const pending = new Map();
  const send = (method, params) => new Promise((res) => { const id = ++n; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r));

  const Q = (s) => JSON.stringify(s).replace(/"/g, '\\"');       /* 页里那串要用双引号包属性，先转义一层 */
  async function js(body) {
    const expr = '(async function(){try{' + body + '}catch(e){return JSON.stringify({pageError:String((e&&e.message)||e)})}})()';
    const m = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const r = (m.result && m.result.result) || m.result || {};   /* ★ 少剥这一层就永远读不到 value */
    if (r.value === undefined) return { raw: JSON.stringify(m).slice(0, 300) };
    try { return JSON.parse(r.value); } catch (e) { return r.value; }
  }
  const READ = [
    'var s = await df.update.status();',
    'var row = document.getElementById("updStatus");',
    'return JSON.stringify({',
    '  checked: s.checked, checking: s.checking, reported: s.reported, error: s.error,',
    '  action: s.action, latest: s.latest, current: s.current, at: s.at,',
    '  rowText: row ? row.textContent.replace(/\\s+/g, " ").trim() : null,',
    '  hasApplyBtn: !!document.getElementById("btnUpdApply"),',
    '  domainInDom: document.body.innerHTML.indexOf("dpx1") !== -1',
    '});'
  ].join('');

  await sleep(WAIT);                                    /* 越过 6 秒那一发 + 10 秒超时 */
  const noNav = await js(READ);
  await js('var st=document.querySelector("[data-view=' + Q('settings') + ']");if(st){st.click();return JSON.stringify({clicked:true})}return JSON.stringify({clicked:false})');
  await sleep(1200);
  const withNav = await js(READ);

  /* 那句话该由自动那一发自己念出来：与宿主逐字相同，且不是启动时那两句占位 */
  const want = noNav.error ? '检查失败：' + noNav.error
    : (noNav.action === 'hint' ? '发现新版本' : '已经是最新版本。');
  const out = {
    profile: PROFILE, waitedMs: WAIT,
    beforeOpeningSettings: noNav, afterOpeningSettings: withNav,
    expectRow: want,
    pass: !!(noNav.checked === true && noNav.checking === false &&
      noNav.rowText === want && withNav.rowText === want &&
      noNav.hasApplyBtn === false && noNav.domainInDom === false)
  };
  console.log(JSON.stringify(out, null, 1));
  console.log(out.pass ? '✓ 自动那一发自己把话念到了界面上（全程没点「重新检查」）'
    : '✗ 没念出来 —— 宿主那枚状态与界面那一行不是同一句话（见上面那两块原文）');
  bye(out.pass ? 0 : 1);
})().catch((e) => { console.log('崩：' + ((e && e.stack) || e)); bye(2); });
