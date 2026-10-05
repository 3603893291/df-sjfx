'use strict';
/**
 * 开发者探针（不进 npm test、不进交付包）：在**真设备**上核 v1.9.1 那两件事。
 *
 *   1) 先起 MuMu 并装好 apk（tools/build-apk.js 的产物），再
 *      adb -s 127.0.0.1:16384 shell am start -n com.df.battleanalyzer/.MainActivity
 *   2) node tools/probe-device-trace.js            （自己找 pid、自己 forward）
 *      node tools/probe-device-trace.js --pid=2717 --port=9222
 *
 * 为什么单独要这一跑：apk 里的 assets 与源码 md5 逐字节相同，只能证明"包里有这段代码"，
 * 证明不了"这段代码在手机的 WebView 里真跑起来了"（安卓那一层桥、localStorage、
 * file:// 与 dfapp.local 的差异都在设备上）。这一跑全程只读：
 * ★ 不点「立即同步」（那会往他这台机器的库里写场次、并发他真会话的请求）。
 *   所以量到的"有没有官方赛季存档 / 台账里有没有翻页列"就是**他这一台机器现在真实的库状态**，
 *   没有就是没有，界面必须如实说没有 —— 这一条本身就是要验的行为。
 */
const cp = require('child_process');

function arg(name, dft) {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(hit.indexOf('=') + 1) : dft;
}
/* adb 不许写死某一台机器的路径：--adb= 优先 → PATH 里的 adb → 三个常见安装位置 */
function adbPath() {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--adb='));
  if (hit) return hit.slice(hit.indexOf('=') + 1);
  const la = process.env.LOCALAPPDATA || '';
  const cands = ['adb'].concat([
    la + '\\Android\\Sdk\\platform-tools\\adb.exe',
    (process.env.ANDROID_HOME || '') + '\\platform-tools\\adb.exe',
    (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)') + '\\Android\\Android Studio\\platform-tools\\adb.exe',
  ]);
  for (const c of cands) { try { cp.execFileSync(c, ['version'], { stdio: 'pipe' }); return c; } catch (e) {} }
  return 'adb';   // 交给系统报错，至少不在源码里带上别人的用户名
}
const ADB = adbPath();
const SERIAL = arg('serial', '127.0.0.1:16384');
const PORT = Number(arg('port', 9223));
const PKG = 'com.df.battleanalyzer';

let pass = 0, fail = 0, skip = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name + (detail ? '  -> ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
/* ★ 量不到就如实说量不到：设备上停在登录页时，"面板画得出"这一类判不了，
 *   把它记成 PASS 就是拿"DOM 里存在"冒充"使用者看得见"——那是这一项目最贵的假绿。 */
function skipCheck(name, why) {
  skip++; console.log('  SKIP  ' + name + '  -> ' + why);
}
function adb(args) {
  return cp.execFileSync(ADB, ['-s', SERIAL].concat(args),
    { encoding: 'utf8', windowsHide: true, maxBuffer: 32 << 20 });
}
const get = (u) => new Promise((res, rej) => {
  require('http').get(u, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b)); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  let pid = arg('pid', '');
  if (!pid) {
    pid = String(adb(['shell', 'pidof', PKG])).trim().split(/\s+/)[0];
  }
  if (!pid) { console.log('设备上没在跑：先 am start -n ' + PKG + '/.MainActivity'); process.exit(1); }
  console.log('设备：' + SERIAL + '  进程：' + pid);
  adb(['forward', 'tcp:' + PORT, 'localabstract:webview_devtools_remote_' + pid]);

  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    await sleep(400);
    try {
      const list = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'));
      target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    } catch (e) { /* forward 还没通 */ }
  }
  if (!target) { console.log('拿不到 WebView 目标（这一版 apk 必须带 FLAG_DEBUGGABLE 才开得起来）'); process.exit(1); }
  console.log('页面：' + target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let n = 0; const pending = new Map();
  const send = (method, params) => new Promise((res) => { const id = ++n; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r));

  async function js(body) {
    const expr = '(async function(){try{' + body + '}catch(e){return JSON.stringify({pageError:String((e&&e.message)||e)+" @ "+String((e&&e.stack)||"").slice(0,180)})}})()';
    const m = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const r = (m.result && m.result.result) || m.result || {};      /* ★ 少剥这一层永远读不到 value */
    if (r.value === undefined) return { raw: JSON.stringify(m).slice(0, 260) };
    try { return JSON.parse(r.value); } catch (e) { return { value: r.value }; }
  }
  async function view(name) {
    await js('var b=document.querySelector(\'[data-view="' + name + '"]\');if(b)b.click();return JSON.stringify({ok:!!b});');
    await sleep(1400);
  }

  /* ---------- ① 真跑起来了：进了主界面、桥是这一版 ---------- */
  const boot = await js([
    'var b=await df.boot();',
    'return JSON.stringify({',
    '  appVisible:!document.getElementById("appView").classList.contains("hidden"),',
    '  loginVisible:!document.getElementById("loginView").classList.contains("hidden"),',
    '  sidDefault:b.sidDefault, seasonSid:(b.settings||{}).seasonSid, slot:b.activeSlot,',
    '  matches:(await df.matches({mode:"all",leave:"all"})).length,',
    '  version:(await df.info()).version})'].join(' '));
  const LOGGED = !!(boot && boot.appVisible === true && boot.loginVisible === false);
  check('① 设备上这一版真跑起来了（桥答话、库读得出场次、版本就是 0.19-android）',
    boot && typeof boot.matches === 'number' && String(boot.version) === '0.19-android' &&
      (boot.appVisible === true || boot.loginVisible === true),
    JSON.stringify(boot));
  if (!LOGGED) {
    console.log('      ★ 这一台停在登录页（' + PKG + ' 没有 WeGame 登录态）：' +
      '下面的"面板画得出"要在主界面里才判得了，这一跑判不了 —— 需要人在模拟器里登一次，' +
      '探针不去点那颗按钮（它会清登录痕迹并开登录窗，属于写操作）。');
  }
  check('① boot 把内置默认赛季号带给了界面（安卓这一端也从 core 取，没自己写 10）',
    boot && String(boot.sidDefault) === '10', 'sidDefault=' + (boot && boot.sidDefault) +
    ' 本机设置里的 seasonSid=' + JSON.stringify(boot && boot.seasonSid));

  /* ---------- ② 官方赛季数据那一格 ---------- */
  await view('overview');
  const sea = await js([
    'var p=document.getElementById("seasonPanel");',
    'var rep=await df.report({mode:"all",kind:"all",leave:"all"});',
    'return JSON.stringify({txt:p.textContent.replace(/\\s+/g," ").trim().slice(0,420),',
    '  head:(p.querySelector("h3")||{}).textContent,',
    '  hasCore:!!rep.season, sid:rep.season&&rep.season.sid,',
    '  all:rep.season&&rep.season.allMode&&rep.season.allMode.totalFight,',
    '  career:rep.season&&rep.season.career&&rep.season.career.totalFight})'].join(' '));
  const oldBlank = /暂未取到官方赛季汇总/.test(String(sea.head || '') + String(sea.txt || ''));
  if (!LOGGED) {
    skipCheck('★★ 那一格不再是"每个人机器上都空白"的老句子（设备停在登录页，这一条判不了）',
      'core 那边读得到存档：sid=' + (sea && sea.sid) + ' 本赛季 ' + (sea && sea.all) + ' 场 / 生涯 ' + (sea && sea.career) + ' 场' +
      ' —— 但那是 df.report 的回包，不是画出来的那一格');
    skipCheck('② 三份口径真到了界面并画在标题上（判不了，同上）', '停在登录页');
    skipCheck('② 老实声明也在（判不了，同上）', '停在登录页');
  } else {
    check('★★ 那一格不再是"每个人机器上都空白"的老句子（旧文案「暂未取到官方赛季汇总」已不在画面上）',
      sea && oldBlank === false && String(sea.txt).length > 40, String(sea.txt).slice(0, 90));
    if (sea && sea.hasCore) {
      check('② 这一台有官方赛季存档 ⇒ core 三份口径真到了界面（sid / 本赛季 / 生涯）',
        /第 \d+ 赛季/.test(String(sea.head)) && Number(sea.all) > 0 && Number(sea.career) > 0,
        '标题=' + String(sea.head) + ' 本赛季 ' + sea.all + ' 场 / 生涯 ' + sea.career + ' 场');
      check('② 老实声明也在（官方查不到当前赛季号 + 战局列表不受这一枚影响）',
        /官方没有"查当前赛季号"的接口/.test(String(sea.txt)) && /战局列表不受影响/.test(String(sea.txt)),
        String(sea.txt).slice(120, 260));
    } else {
      check('② 这一台的库里没有官方赛季存档 ⇒ 界面如实说"还没有存档"，不拿 0 装成本赛季 0 场',
        /还没有官方赛季汇总的存档|本机还没有/.test(String(sea.txt)), String(sea.txt).slice(0, 120));
    }
  }

  /* ---------- ③ 翻页自证那一行：老账本不许假画 ---------- */
  await view('rhythm');
  const sy = await js([
    'var p=document.getElementById("syncPanel");',
    'var rep=await df.report({mode:"all",kind:"all",leave:"all"});',
    'var w=(rep.sync&&rep.sync.windows)||[];var l=w[w.length-1]||{};',
    'return JSON.stringify({txt:p.textContent.replace(/\\s+/g," ").trim().slice(0,520),',
    '  rounds:w.length, last:l, state:document.getElementById("syncState").textContent.replace(/\\s+/g," ").trim()})'].join(' '));
  const traceBlock = /最近一轮采集的翻页记录/.test(String(sy.txt));
  const hasCols = sy && sy.last && typeof sy.last.pages === 'number';
  if (!LOGGED) {
    skipCheck('★★ 升级前留下的台账在手机上整段不画（判不了：停在登录页，画面是空的）',
      '台账读到 ' + (sy && sy.rounds) + ' 轮，最新一轮=' + JSON.stringify(sy && sy.last));
  } else if (hasCols && sy.last.pages > 0) {
    check('③ 这一台已经有升级后的台账 ⇒ 那一行真画了页数、逐页条数与停因',
      traceBlock && /翻了 \d+ 页/.test(String(sy.txt)) && /停在这里的原因/.test(String(sy.txt)),
      JSON.stringify(sy.last));
  } else {
    check('★★ 升级前留下的台账（没有翻页那几列）在手机上整段不画 —— 不出现「翻了 0 页」那种假证据',
      traceBlock === false && !/翻了 0 页/.test(String(sy.txt)) && !/最近一轮 0 页/.test(String(sy.state)),
      '台账 ' + (sy && sy.rounds) + ' 轮，最新一轮=' + JSON.stringify(sy && sy.last) + ' 状态行=' + String(sy.state).slice(-48));
  }

  /* ---------- ④ 设置那一格在设备上摸得到 ---------- */
  await view('settings');
  const st = await js('var i=document.getElementById("setSeasonSid");' +
    'var n=document.getElementById("setSeasonSidNote");' +
    'return JSON.stringify({exists:!!i, value:i?i.value:null, ph:i?i.placeholder:null,' +
    '  note:n?n.textContent.replace(/\\s+/g," ").slice(0,120):null})');
  check('④ 手机上「设置 → 官方赛季号」那一格在 DOM 里摸得到，placeholder 念得出默认号',
    st && st.exists === true && /留空 = 第 10 赛季/.test(String(st.ph)),
    'placeholder=' + (st && st.ph) + (LOGGED ? '' : '（★ 停在登录页，只验到 DOM 在、没验到画在屏幕上）'));
  /* 只读：把框里的值读出来核对，不改设置、不发同步 */
  check('④ 框里的值与库里那枚一致（空 = 用内置默认，两边说法一样）',
    st && String(st.value) === String((boot && boot.seasonSid) || ''),
    '框里="' + (st && st.value) + '" 库里="' + JSON.stringify(boot && boot.seasonSid) + '"');

  try { adb(['forward', '--remove', 'tcp:' + PORT]); } catch (e) {}
  console.log('\n' + '='.repeat(60));
  console.log((fail === 0 ? '设备（MuMu）v1.9.1 端到端：全部通过' : '设备（MuMu）v1.9.1 端到端：' + fail + ' 项失败') +
    '（过 ' + pass + ' / 跳过 ' + skip + '）' +
    (skip ? '\n★ 跳过的这些是"画在屏幕上"那一段 —— 这台模拟器没有登录态，要人在 MuMu 里登一次再跑一遍才算设备上验过。' : ''));
  console.log('='.repeat(60));
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.log('探针自己炸了：' + ((e && e.stack) || e));
  process.exit(2);
});
