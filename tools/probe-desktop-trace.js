'use strict';
/**
 * 开发者探针（不进 npm test、不进交付包；要真 Electron 才跑得动）：
 *   node tools/probe-desktop-trace.js
 *   node tools/probe-desktop-trace.js --root="<解压出来的程序目录>" --keep
 *
 * 量的是 v1.9.1 那两件在**真界面**上到没到家：
 *   ① 采集翻页自证 —— 数据完整度那块有没有把「翻了几个页 / 每页回来几条 / 为什么停」念出来，
 *      而且那句停因必须是 core 那一份原文（界面自己编一句就是第二份说法，必漂移）。
 *   ② 官方赛季数据那一格 —— 它以前在每个人机器上都是「暂未取到官方赛季汇总」，
 *      因为界面早就画了 renderSeason(sea) 而 core 从来没算过 rep.season。现在要真画出数、
 *      并且把「这一格念的是第 N 赛季」印出来；那一格还得真能改、改完真落盘、下次同步真按它问。
 *
 * 为什么离线测试量不到：core 的 27 条新断言与那批源码红线都能全绿，而界面上少读一个字段、
 * 面板挂在别的视图里、输入框没接 change —— 这类只有真宿主 + 真界面 + 真点一遍才看得见。
 *
 * 档案里预置的三行窗口台账是这一跑的靶子（甲 = 撞上限那一轮 + 一条到底那一轮；乙 = 最新一轮是升级前那种
 * 没有翻页列的老行）。切号会真的重新读盘，所以两号各读自己那份台账，不用在宿主手上改文件。
 *
 * 数据安全：用 %TEMP% 下独立 --user-data-dir（tools/seed-multi-account-profile.js 造的那份），
 * 不碰使用者那个目录；档案里预填了 startup.at ⇒ 不会往他那台服务器计一个装机。结束时只 kill 自己起的 pid。
 */
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { seed } = require('./seed-multi-account-profile');
const Coll = require('../core/collector');

function arg(name, dft) {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(hit.indexOf('=') + 1) : dft;
}
const ROOT = path.join(__dirname, '..');
const APP = arg('root', path.join(ROOT, 'dist', '三角洲全面战场分析器'));
const EXE = path.join(APP, '三角洲全面战场分析器.exe');
const PORT = Number(arg('port', 9347));
const PROFILE = arg('profile', fs.mkdtempSync(path.join(os.tmpdir(), 'df-trace-')));
const FILE_A = path.join(PROFILE, 'df-swtwr-a1.json');
const FILE_B = path.join(PROFILE, 'df-swtwr-a2.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b)); }).on('error', rej);
});
if (!fs.existsSync(EXE)) {
  console.log('找不到 exe：' + EXE + '（先 node build.js，或 --root= 指到解压出来那一份）');
  process.exit(1);
}

let pass = 0, fail = 0;
let child = null;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name + (detail ? '  -> ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
/* 台账行里那句胜率/场数在界面上会带千位分隔符，比对时一律抹掉空格与逗号 */
const flat = (s) => String(s || '').replace(/[\s,]/g, '');

(async function main() {
  const seeded = await seed(PROFILE);
  console.log('档案：' + JSON.stringify(seeded) + '\n程序：' + APP);

  /* ---------- 预置翻页台账（宿主还没起来，直接写盘最干净） ---------- */
  const SEC = Math.floor(Date.now() / 1000);
  const wide = { oldest: SEC - 40 * 86400, newest: SEC, count: 36 };   /* 两轮都盖满 40 天 ⇒ 故意不触发"整窗滚过" */
  const shortRow = Object.assign({
    at: Date.now() - 1000, inserted: 19, pages: 3, rows: [8, 8, 5], kept: 19,
    stop: 'short', stopText: Coll.STOP_TEXT.short, capped: false
  }, wide);
  const capRow = Object.assign({
    at: Date.now(), inserted: 36, pages: 5, rows: [8, 8, 8, 8, 8], kept: 36,
    stop: 'cap', stopText: Coll.STOP_TEXT.cap, capped: true
  }, wide);
  const legacyRow = Object.assign({ at: Date.now(), inserted: 30 }, wide);   /* 升级前那种行：压根没有这几列 */
  {
    const a = JSON.parse(fs.readFileSync(FILE_A, 'utf8'));
    a.meta.sync_windows = [shortRow, capRow];
    fs.writeFileSync(FILE_A, JSON.stringify(a));
    const b = JSON.parse(fs.readFileSync(FILE_B, 'utf8'));
    b.meta.sync_windows = [shortRow, legacyRow];
    fs.writeFileSync(FILE_B, JSON.stringify(b));
    console.log('台账预置：甲 = 到底那一轮 + 撞上限那一轮（最新是 cap）；乙 = 最新一轮是没有翻页列的老行');
    console.log('甲的官方赛季存档键：' + JSON.stringify(Object.keys(a.seasons || {})));
  }

  const env = Object.assign({}, process.env);
  delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(EXE, ['--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
    '--no-sandbox', '--disable-gpu', '--in-process-gpu'], { env, stdio: 'ignore' });
  function bye(code) {
    try { child.kill(); } catch (e) {}
    if (!arg('keep', '')) {
      try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    } else console.log('档案留在：' + PROFILE);
    process.exit(code);
  }

  let page = null;
  for (let i = 0; i < 90 && !page; i++) {
    await sleep(400);
    try {
      const list = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'));
      page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    } catch (e) { /* 还没起来 */ }
  }
  if (!page) { console.log('CDP 起不来'); bye(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let n = 0; const pending = new Map();
  const send = (method, params) => new Promise((res) => { const id = ++n; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r));

  async function js(body) {
    const expr = '(async function(){try{' + body + '}catch(e){return JSON.stringify({pageError:String((e&&e.message)||e)+" @ "+String((e&&e.stack)||"").slice(0,200)})}})()';
    const m = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const r = (m.result && m.result.result) || m.result || {};      /* ★ 少剥这一层永远读不到 value */
    if (r.value === undefined) return { raw: JSON.stringify(m).slice(0, 300) };
    try { return JSON.parse(r.value); } catch (e) { return { value: r.value }; }
  }
  async function view(name) {
    await js('document.querySelector(\'[data-view="' + name + '"]\').click(); return JSON.stringify({ok:1});');
    await sleep(1500);
  }
  async function switchTo(slot) {
    await js('var s=document.getElementById("accountSwitch");' +
      'if(!s) return JSON.stringify({noSel:true});' +
      's.value=' + JSON.stringify(slot) + '; s.dispatchEvent(new Event("change"));' +
      'return JSON.stringify({ok:1});');
    await sleep(3200);
    return js('return JSON.stringify({all:(await df.matches({mode:"all",leave:"all"})).length,' +
      'name:document.getElementById("profileName").textContent})');
  }

  await js('await df.boot(); return JSON.stringify({ok:1});');
  await sleep(2600);

  /* ---------- ① 官方赛季数据那一格（以前永远空白的那一块） ---------- */
  await view('overview');
  const sea = await js([
    'var b=document.getElementById("seasonPanel");',
    'var rep=await df.report({mode:"all",kind:"all",leave:"all"});',
    'var rows=[].slice.call(b.querySelectorAll("tbody tr")).map(function(t){return t.textContent.replace(/\\s+/g," ").trim()});',
    'return JSON.stringify({len:b.innerHTML.length, head:(b.querySelector("h3")||{}).textContent,',
    '  empty:!!b.querySelector(".empty"), hint:(b.textContent.replace(/\\s+/g," ").slice(0,900)),',
    '  rows:rows, coreSeason:rep.season, mapRows:(function(){return [].slice.call(b.querySelectorAll("tbody tr")).length})()})'].join(' '));
  check('① 那一格不再是空的（以前 core 没算过 rep.season，面板永远一句「暂未取到官方赛季汇总」）',
    sea && !sea.empty && /官方赛季数据/.test(String(sea.head)) && sea.rows.length >= 3,
    '表体 ' + (sea && sea.rows.length) + ' 行：' + JSON.stringify(sea && sea.rows && sea.rows[0]));
  check('① core 真把三份口径交给了界面（allMode / career / swwr 都在）',
    sea && sea.coreSeason && sea.coreSeason.allMode && sea.coreSeason.career &&
      sea.coreSeason.swwr && sea.coreSeason.sid === '10',
    'sid=' + (sea.coreSeason && sea.coreSeason.sid) + ' 本赛季 ' +
      (sea.coreSeason && sea.coreSeason.allMode.totalFight) + ' 场 / 生涯 ' +
      (sea.coreSeason && sea.coreSeason.career.totalFight) + ' 场');
  check('★ 那一格把「念的是第几赛季」印在标题上（换赛季没改设置时，这是唯一的线索）',
    sea && /第 10 赛季/.test(String(sea.head)), String(sea.head));
  check('① 三行数字与 core 同一份（191 场本赛季 / 2193 场生涯 / 胜者为王由官方各图聚合）',
    sea && /191/.test(flat(sea.rows.join(' '))) && /2193/.test(flat(sea.rows.join(' '))) &&
      /胜者为王/.test(sea.rows.join('')),
    JSON.stringify(sea && sea.rows));
  check('★★ 那句老实声明挂在格子下面：官方查不到当前赛季号、只有这一枚不影响战局列表',
    sea && /官方没有"查当前赛季号"的接口/.test(String(sea.hint)) &&
      /战局列表不受影响/.test(String(sea.hint)) && /第 10 赛季/.test(String(sea.hint)),
    String(sea.hint).slice(180, 330));
  check('① 胜者为王各图明细也画出来了（地名来自 core，不是 mapId:602）',
    sea && /官方各图明细/.test(String(sea.hint)) && /胜者为王/.test(String(sea.hint)) &&
      !/mapId:6\d\d/.test(String(sea.hint)), '明细行数 ' + ((sea && sea.mapRows) || 0));

  /* ---------- ② 数据完整度那块：翻页自证（甲 = 最新一轮是撞上限） ---------- */
  await view('rhythm');
  const sy = await js([
    'var b=document.getElementById("syncPanel");',
    'var rep=await df.report({mode:"all",kind:"all",leave:"all"});',
    'var w=(rep.sync&&rep.sync.windows)||[];',
    'return JSON.stringify({txt:b.textContent.replace(/\\s+/g," "),' +
    '  last:w[w.length-1], rounds:w.length,',
    '  state:document.getElementById("syncState").textContent.replace(/\\s+/g," ").trim()})'].join(' '));
  check('② 数据完整度那块真的画了「最近一轮采集的翻页记录」',
    sy && /最近一轮采集的翻页记录/.test(String(sy.txt)), '台账 ' + (sy && sy.rounds) + ' 轮');
  check('★ 逐页条数与去重后的条数都在那一句里（5 页 / 8 8 8 8 8 / 留下 36 条）',
    sy && /翻了 5 页/.test(String(sy.txt)) && /8 \/ 8 \/ 8 \/ 8 \/ 8/.test(String(sy.txt)) &&
      /留下 36 条|入库 36 条/.test(String(sy.txt)),
    (String(sy.txt).match(/翻了[^。]*。/) || [''])[0].slice(0, 150));
  check('★★ 界面念的停因就是 core 那一份 STOP_TEXT 原文（第二份说法必漂移）',
    sy && String(sy.txt).indexOf(Coll.STOP_TEXT.cap) > 0, Coll.STOP_TEXT.cap);
  check('② 撞上限那一轮额外说了"再往前就采不到了"（到底那一轮不该有这句）',
    sy && /再往前的场次已经拿不到/.test(String(sy.txt)));
  check('② 顶上状态行也带上最近一轮（问"怎么只有 17 场"时不用先翻到状态页）',
    sy && /最近一轮 5 页 \/ 留下 36 条/.test(String(sy.state)), String(sy.state).slice(-70));

  /* ---------- ③ 老账本行：升级前那种没有翻页列的行，整段必须不画 ---------- */
  await switchTo('a2');
  await view('rhythm');
  const old = await js('var b=document.getElementById("syncPanel");' +
    'return JSON.stringify({txt:b.textContent.replace(/\\s+/g," "),' +
    'state:document.getElementById("syncState").textContent.replace(/\\s+/g," ").trim()})');
  check('★★ 最新一轮是升级前那种老行时，那一整段不画（拿 0 装成"翻了 0 页"就是假证据）',
    old && !/最近一轮采集的翻页记录/.test(String(old.txt)) && !/翻了 0 页/.test(String(old.txt)),
    String(old.txt).slice(0, 90));
  check('③ 顶上状态行同样跟着收掉（两处读的是同一份判据）',
    old && !/最近一轮 0 页/.test(String(old.state)) && !/最近一轮/.test(String(old.state)),
    String(old.state).slice(-60));
  await switchTo('a1');
  await view('rhythm');
  const back = await js('var b=document.getElementById("syncPanel");' +
    'return JSON.stringify({txt:b.textContent.replace(/\\s+/g," ")})');
  check('③ 切回甲那一整段又回来了（不是切号切坏了，是真的按最新那一轮判）',
    back && /最近一轮采集的翻页记录/.test(String(back.txt)));

  /* ---------- ④ 设置里那一枚官方赛季号 ---------- */
  await view('settings');
  const st0 = await js('var i=document.getElementById("setSeasonSid");' +
    'var n=document.getElementById("setSeasonSidNote");' +
    'var b=await df.boot();' +
    'return JSON.stringify({exists:!!i, value:i?i.value:null, ph:i?i.placeholder:null,' +
    '  note:n?n.textContent.replace(/\\s+/g," ").slice(0,300):null, sidDefault:b.sidDefault,' +
    '  setting:(b.settings||{}).seasonSid})');
  check('④ 那一格在设置里，且开机就按 boot 带回的默认值给 placeholder（留空 = 第 10 赛季）',
    st0 && st0.exists === true && st0.value === '' && /留空 = 第 10 赛季/.test(String(st0.ph)) &&
      st0.sidDefault === Coll.DEFAULT_SID, 'placeholder=' + (st0 && st0.ph));
  check('★ 说明那句实话：官方没有查当前赛季号的接口，且不碰战局列表',
    st0 && /没有任何接口能查/.test(String(st0.note)) && /战局列表与所有分析不受这一枚影响/.test(String(st0.note)),
    String(st0.note).slice(0, 80));
  const set11 = await js('var i=document.getElementById("setSeasonSid");' +
    'i.value="11"; i.dispatchEvent(new Event("change"));' +
    'await new Promise(function(r){setTimeout(r,1400)});' +
    'var t=document.getElementById("toast");' +
    'return JSON.stringify({toast:t?t.textContent.replace(/\\s+/g," ").trim():null, value:i.value})');
  await sleep(900);
  const disk11 = JSON.parse(fs.readFileSync(FILE_A, 'utf8'));
  check('★ 填 11：toast 说"下次同步生效"，且真的落盘（刷新后还在）',
    /第 11 赛季/.test(String(set11.toast)) && /下次同步生效/.test(String(set11.toast)) &&
      disk11.settings && String(disk11.settings.seasonSid) === '11',
    String(set11.toast).slice(0, 60) + ' 盘上=' + JSON.stringify(disk11.settings && disk11.settings.seasonSid));
  const dirty = await js('var i=document.getElementById("setSeasonSid");' +
    'i.value="1x0!"; i.dispatchEvent(new Event("change"));' +
    'await new Promise(function(r){setTimeout(r,1400)});' +
    'return JSON.stringify({value:i.value})');
  await sleep(900);
  const diskDirty = JSON.parse(fs.readFileSync(FILE_A, 'utf8'));
  check('★★ 脏值当场被清成数字（写进存档的那一枚也不能带脏字）',
    dirty.value === '10' && String(diskDirty.settings.seasonSid) === '10',
    '框里=' + dirty.value + ' 盘上=' + JSON.stringify(diskDirty.settings.seasonSid));
  const cleared = await js('var i=document.getElementById("setSeasonSid");' +
    'i.value=""; i.dispatchEvent(new Event("change"));' +
    'await new Promise(function(r){setTimeout(r,1400)});' +
    'var t=document.getElementById("toast");' +
    'return JSON.stringify({toast:t?t.textContent.replace(/\\s+/g," ").trim():null, ph:i.placeholder})');
  await sleep(900);
  const disk0 = JSON.parse(fs.readFileSync(FILE_A, 'utf8'));
  check('★ 清空 = 交回内置默认，而且那句提示把默认号念出来（不是"已清空"三个字把人打发走）',
    disk0.settings && String(disk0.settings.seasonSid) === '' &&
      /内置的默认赛季号（第 10 赛季）/.test(String(cleared.toast)), String(cleared.toast).slice(0, 80));

  console.log('\n' + '='.repeat(60));
  console.log(fail === 0 ? '桌面「翻页自证 + 官方赛季号」端到端：全部通过（' + pass + ' 项）'
    : '桌面「翻页自证 + 官方赛季号」端到端：' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项');
  console.log('='.repeat(60));
  bye(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.log('探针自己炸了：' + ((e && e.stack) || e));
  try { child.kill(); } catch (_) {}
  process.exit(2);
});
