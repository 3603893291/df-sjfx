'use strict';
/**
 * 开发者探针（不进 npm test、不进交付包；要真 Electron 才跑得动）：
 *   node tools/probe-desktop-competition.js
 *   node tools/probe-desktop-competition.js --root="<解压出来的程序目录>" --keep
 *
 * 量的是使用者真会撞上那一件事：**「比赛对局」这一枚从点按钮到统计口径，整条路在桌面端通不通**。
 * 为什么离线测试量不到：core 那 25 条断言与四处透传红线都能全绿，而界面上少画一颗按钮、
 * 或者点了按钮库变了但表格没跟着变 —— 这类"判据对、接线断"只有真宿主 + 真界面 + 真点一遍才看得见。
 * 这一跑全程点的是 DOM（不是直接调 IPC），所以 preload → ipcMain → store → report → 重绘这条链一步没省。
 *
 * 八步：
 *   ① 开机：顶上「对局」那一排只有两颗、都不亮（= 全部），counts.comp=0、practice=8
 *   ② 打开一场胜者为王：那颗「标记本场为比赛对局」在；打开一场常规：那颗不许出现
 *   ③ 真点一下 → toast 念得出、按钮变「✓ 本场是比赛」、列表那一行挂上「比赛」徽标
 *   ④ 点顶上「比赛」→ 列表只剩这 1 行，且与 core 现算的场数一致；顶上那句念「比赛对局（你手动标的）」
 *   ⑤ 点「匹配」→ 这 1 行不在，行数 = 全部 − 1（一场都不许掉在两边外）
 *   ⑥ 再点当前那颗「匹配」→ 回到全部（没有「全部」那颗，退回去靠这一手，必须真退得回去）
 *   ⑦ 两轴叠加：模式=指挥官 + 对局=比赛 → 列表与 core 同为 1 行（正交，不是互相改写）
 *   ⑧ 取消标记 → comp 回到 0、徽标消失，落盘文件里那一场只剩指挥官那一枚（不留残值）
 *   ⑨ 把甲这份库的号换成名单里不存在的一个（= 导入的数据包 / 只读号最容易走到的一支），
 *      切走再切回来重读盘 ⇒ 详情页必须照画、那颗标记按钮必须还在、
 *      同局对比那一格要用人话说清为什么没有名次
 *      （这一支以前一路走到 rk.score 就整页崩成骨架屏 —— 2026-10-04 就是这一跑把它抓出来的）
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

function arg(name, dft) {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(hit.indexOf('=') + 1) : dft;
}
const ROOT = path.join(__dirname, '..');
const APP = arg('root', path.join(ROOT, 'dist', '三角洲全面战场分析器'));
const EXE = path.join(APP, '三角洲全面战场分析器.exe');
const PORT = Number(arg('port', 9345));
const PROFILE = arg('profile', fs.mkdtempSync(path.join(os.tmpdir(), 'df-comp-')));
const FILE_A = path.join(PROFILE, 'df-swtwr-a1.json');
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

(async function main() {
  const seeded = await seed(PROFILE);
  console.log('档案：' + JSON.stringify(seeded) + '\n程序：' + APP);

  /* 甲这一份把 meta.openid 换成名单里真实存在的那个号：多账号那一跑故意用两个假号（要比的是数据归属），
   * 而这一跑要量的是详情页 —— 号对不上名单时 core 走的是"名单里没有我"那一支（⑨ 单独量它），
   * 主路径必须用一份与真装机一致的档案，否则测的不是使用者会看到的那一页。 */
  {
    const j = JSON.parse(fs.readFileSync(FILE_A, 'utf8'));
    const owners = Object.keys(j.matches || {}).map(function (k) { return String(j.matches[k].owner_openid || ''); })
      .filter(function (x) { return x; });
    const real = owners.sort(function (a, b) {
      return owners.filter(function (x) { return x === b; }).length - owners.filter(function (x) { return x === a; }).length;
    })[0];
    if (!real) { console.log('档案里找不到 owner_openid，这一跑没法判「名单里有没有我」'); process.exit(1); }
    j.meta.openid = real;
    fs.writeFileSync(FILE_A, JSON.stringify(j));
    console.log('甲的号改回名单里真实存在的那个：' + real + '（原来是探测用的假号）');
  }

  const env = Object.assign({}, process.env);
  delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(EXE, ['--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
    '--no-sandbox', '--disable-gpu', '--in-process-gpu'], { env, stdio: 'ignore' });
  function bye(code) { try { child.kill(); } catch (e) {} if (!arg('keep', '')) {
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  } else console.log('档案留在：' + PROFILE); process.exit(code); }

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
  /* 点完等重绘：**只重读、不重点**（这一版探针早年就是栽在"稳定检查把 click 一起重放"上：
   * 那一排只有两颗、点一次进一次退，连点偶数次回到原点，量出来的"界面没反应"是探针自己的假象。 */
  async function click(sel) {
    return js('var b=document.querySelector(' + JSON.stringify(sel) + ');' +
      'if(!b) return JSON.stringify({noBtn:true, sel:' + JSON.stringify(sel) + '});' +
      'b.click(); return JSON.stringify({clicked:1});');
  }
  async function jsStable(body, rounds) {
    let last = null;
    for (let i = 0; i < (rounds || 8); i++) {
      const o = await js(body);
      if (o && !o.pageError && !o.raw && JSON.stringify(o) === JSON.stringify(last) && i > 1) return o;
      last = o; await sleep(500);
    }
    return last;
  }

  await js('await df.boot(); return JSON.stringify({ok:1});');
  await sleep(2500);

  /* ---------- ① 开机：那一排的形状与两桶计数 ---------- */
  const READ1 = [
    'var segs = Array.prototype.slice.call(document.querySelectorAll("#fKind .seg"));',
    'var c = await df.counts();',
    'return JSON.stringify({',
    '  segData: segs.map(function(s){return s.dataset.kind;}),',
    '  segActive: segs.filter(function(s){return s.classList.contains("active");}).length,',
    '  counts: c, allRows: (await df.matches({mode:"all",leave:"all"})).length',
    '})'].join(' ');
  const s1 = await jsStable(READ1);
  check('① 顶上「对局」这一排只有两颗：比赛 / 匹配（没有「全部」那颗）',
    s1 && String(s1.segData) === 'comp,practice', JSON.stringify(s1 && s1.segData));
  check('① 开机时两颗都不亮 = 全部对局（这一维默认不设筛选）',
    s1 && s1.segActive === 0, '亮着的 ' + (s1 && s1.segActive) + ' 颗');
  check('① 一枚没标时 comp=0、practice 等于全部纳入统计的场数',
    s1 && s1.counts && s1.counts.comp === 0 && s1.counts.practice === s1.counts.all &&
    s1.counts.all === s1.allRows, JSON.stringify(s1 && s1.counts) + ' 列表行 ' + (s1 && s1.allRows));

  /* ---------- ② 详情页那颗按钮：胜者为王有、常规没有 ---------- */
  const PICK = [
    'var rows = await df.matches({mode:"all",leave:"all"});',
    'var sw = rows.filter(function(r){return r.is_swtwr && !r.excluded;})[0];',
    'var pl = rows.filter(function(r){return !r.is_swtwr && !r.excluded;})[0];',
    'return JSON.stringify({sw: sw && sw.room_id, pl: pl && pl.room_id})'].join(' ');
  const ids = await js(PICK);
  async function openDetail(rid) {
    await js('document.querySelector(\'[data-view="detail"]\').click();' +
      'var s=document.getElementById("roomPick");s.value=' + JSON.stringify(String(rid)) + ';' +
      's.dispatchEvent(new Event("change"));return JSON.stringify({ok:1});');
    await sleep(1600);
    return js('var b=document.getElementById("detailBox");' +
      'var k=Array.prototype.slice.call(b.querySelectorAll(\'.flag-bar button[data-act]\'));' +
      'return JSON.stringify({acts:k.map(function(x){return x.getAttribute("data-act");}),' +
      'labels:k.map(function(x){return x.textContent.replace(/\\s+/g,"");}),' +
      'note:(function(){var e=b.querySelector(".flag-note");return e?e.textContent.replace(/\\s+/g," ").trim().slice(0,120):null})()})');
  }
  const dSw = await openDetail(ids.sw);
  const dPl = await openDetail(ids.pl);
  check('② 胜者为王那场有「标记本场为比赛对局」这颗（data-act=competition）',
    dSw && dSw.acts && dSw.acts.indexOf('competition') >= 0, String(dSw && dSw.acts));
  check('② 常规对局的详情页压根不出现这颗（门槛不只在 store，界面也不给入口）',
    dPl && dPl.acts && dPl.acts.indexOf('competition') === -1, String(dPl && dPl.acts));
  check('② 常规那场还留着「不纳入统计」（不受模式限制那一条没被顺手改坏）',
    dPl && dPl.acts && dPl.acts.indexOf('excluded') >= 0, String(dPl && dPl.acts));

  /* ---------- ③ 真点一下：toast / 按钮文案 / 列表徽标 ---------- */
  await openDetail(ids.sw);
  const clicked = await js('var b=document.querySelector(\'#detailBox .flag-bar button[data-act="competition"]\');' +
    'if(!b) return JSON.stringify({noBtn:true}); b.click(); return JSON.stringify({clicked:1});');
  await sleep(2200);
  const after3 = await js('var t=document.getElementById("toast");' +
    'var b=document.querySelector(\'#detailBox .flag-bar button[data-act="competition"]\');' +
    'return JSON.stringify({toast:t?t.textContent.replace(/\\s+/g," ").trim():null,' +
    'btn:b?b.textContent.replace(/\\s+/g,"") :null, on:b?b.classList.contains("btn-on"):null,' +
    'counts:await df.counts()})');
  check('③ 点一下真的落库：counts.comp 从 0 变 1',
    after3 && after3.counts && after3.counts.comp === 1 &&
    after3.counts.comp + after3.counts.practice === after3.counts.all, JSON.stringify(after3 && after3.counts));
  check('③ 按钮自己变成「✓ 本场是比赛（点击取消）」并高亮（看得出现在是标着的）',
    after3 && /✓本场是比赛/.test(String(after3.btn)) && after3.on === true, String(after3.btn));
  check('③ toast 念得出这一枚的口径（说清去顶部切「比赛」，并预告样本少时不给结论）',
    after3 && /比赛/.test(String(after3.toast)) && /样本少/.test(String(after3.toast)),
    String(after3.toast).slice(0, 90));
  /* 列表那一行的徽标 */
  await js('document.querySelector(\'[data-view="matches"]\').click(); return JSON.stringify({ok:1});');
  await sleep(1600);
  const list3 = await js('var tr=document.querySelector(\'#matchTable tr[data-rid="' + ids.sw + '"]\');' +
    'return JSON.stringify({rowFound:!!tr, tag:tr?!!tr.querySelector(".tag-comp"):null,' +
    'modeCell:tr?tr.children[2].textContent.replace(/\\s+/g,"").slice(0,26):null,' +
    'rows:document.querySelectorAll("#matchTable tr.clickable").length})');
  check('③ 战局列表那一行挂上「比赛」徽标（标了要在列表看得见，不然没法核对）',
    list3 && list3.rowFound === true && list3.tag === true, 'modeCell=' + (list3 && list3.modeCell));
  check('③ 那一行的模式文案跟着念「胜者为王 · 比赛」',
    list3 && /比赛/.test(String(list3.modeCell)), String(list3.modeCell));

  /* ---------- ④ 切到「比赛」：列表与 core 同一份场数 ---------- */
  await click('#fKind .seg[data-kind="comp"]');
  const s4 = await jsStable([
    'var cnt=(await df.matches({mode:"all",kind:"comp",leave:"all"})).length;',
    'return JSON.stringify({',
    '  tableRows: document.querySelectorAll("#matchTable tr.clickable").length,',
    '  coreRows: cnt,',
    '  count: document.getElementById("filterCount").textContent.replace(/\\s+/g," ").trim(),',
    '  segOn: document.querySelector(\'#fKind .seg[data-kind="comp"]\').classList.contains("active"),',
    '  onlyMine: (function(){var t=document.querySelector("#matchTable tr.clickable");' +
    '    return t ? t.getAttribute("data-rid") : null})()',
    '})'].join(' '));
  check('④ 点上去那颗是高亮的（点了要有反馈）', s4 && s4.segOn === true);
  check('④ 切到「比赛」：列表行数 == core 现算的场数（这一维真的走到了统计）',
    s4 && s4.tableRows === s4.coreRows && s4.coreRows === 1,
    '页面 ' + (s4 && s4.tableRows) + ' / core ' + (s4 && s4.coreRows));
  check('④ 列表里那唯一一行就是刚标的那场',
    s4 && s4.onlyMine === String(ids.sw), String(s4 && s4.onlyMine));
  check('④ 顶上那句念出当前范围「比赛对局（你手动标的）」',
    s4 && /当前对局范围：比赛对局（你手动标的）/.test(String(s4.count)), String(s4.count).slice(0, 96));

  /* ---------- ⑤ 切到「匹配」：这一场不在，且两边加起来不缺场 ---------- */
  await click('#fKind .seg[data-kind="practice"]');
  const s5 = await jsStable([
    'var cnt=(await df.matches({mode:"all",kind:"practice",leave:"all"})).length;',
    'return JSON.stringify({tableRows: document.querySelectorAll("#matchTable tr.clickable").length,',
    '  coreRows: cnt, hasMine: !!document.querySelector(\'#matchTable tr[data-rid="' + ids.sw + '"]\'),',
    '  count: document.getElementById("filterCount").textContent.replace(/\\s+/g," ").trim()})'].join(' '));
  check('⑤ 切到「匹配」：core 场数 = 全部 − 1，列表画的一样多',
    s5 && s5.coreRows === s1.counts.all - 1 && s5.tableRows === s5.coreRows,
    '页面 ' + (s5 && s5.tableRows) + ' / core ' + (s5 && s5.coreRows) + '（全部 ' + s1.counts.all + '）');
  check('⑤ 刚标的那场确实不在匹配这一边', s5 && s5.hasMine === false);
  check('⑤ 那句范围换成「匹配对局（没标为比赛的）」',
    s5 && /当前对局范围：匹配对局（没标为比赛的）/.test(String(s5.count)), String(s5.count).slice(0, 96));

  /* ---------- ⑥ 再点当前那颗 → 回到全部（这一排没有「全部」那颗，退路只有这一手） ---------- */
  await click('#fKind .seg[data-kind="practice"]');
  const s6 = await jsStable([
    'var segs=Array.prototype.slice.call(document.querySelectorAll("#fKind .seg"));',
    'return JSON.stringify({active: segs.filter(function(s){return s.classList.contains("active")}).length,',
    '  tableRows: document.querySelectorAll("#matchTable tr.clickable").length,',
    '  coreRows: (await df.matches({mode:"all",kind:"all",leave:"all"})).length,',
    '  count: document.getElementById("filterCount").textContent.replace(/\\s+/g," ").trim()})'].join(' '));
  check('⑥ 再点一次当前那颗就回到全部（两颗都不亮）',
    s6 && s6.active === 0, '亮着的 ' + (s6 && s6.active) + ' 颗');
  check('⑥ 回到全部后列表行数与 core 一致，那句范围也跟着收掉',
    s6 && s6.tableRows === s6.coreRows && !/当前对局范围/.test(String(s6.count)),
    '页面 ' + (s6 && s6.tableRows) + ' / core ' + (s6 && s6.coreRows));

  /* ---------- ⑦ 两轴叠加：模式=指挥官 + 对局=比赛 ---------- */
  await js('return JSON.stringify(await df.setFlag(' + JSON.stringify(String(ids.sw)) + ', "commander", true));');
  await click('#fKind .seg[data-kind="comp"]');
  await click('#fMode .seg[data-mode="commander"]');
  const s7 = await jsStable([
    'return JSON.stringify({tableRows: document.querySelectorAll("#matchTable tr.clickable").length,',
    '  coreRows: (await df.matches({mode:"commander",kind:"comp",leave:"all"})).length,',
    '  counts: await df.counts()})'].join(' '));
  check('⑦ 模式与对局是两根正交的轴：指挥官 + 比赛 = 同一场，两个筛选叠得住',
    s7 && s7.coreRows === 1 && s7.tableRows === s7.coreRows &&
    s7.counts.commander === 1 && s7.counts.comp === 1 && s7.counts.swtwr === 4,
    '页面 ' + (s7 && s7.tableRows) + ' / core ' + (s7 && s7.coreRows) + ' ' + JSON.stringify(s7 && s7.counts));
  /* 收回默认，别把后面的步骤建在上一筛之上 */
  await click('#fMode .seg[data-mode="all"]');
  await click('#fKind .seg[data-kind="comp"]');

  /* ---------- ⑧ 取消标记：回到匹配，落盘不留残值 ---------- */
  const s8 = await js([
    'document.querySelector(\'#fMode .seg[data-mode="all"]\').click();',
    'document.querySelector(\'#fKind .seg[data-kind="comp"]\').click();',
    'await new Promise(function(r){setTimeout(r,1200)});',
    'document.querySelector(\'[data-view="detail"]\').click();',
    'var s=document.getElementById("roomPick");s.value=' + JSON.stringify(String(ids.sw)) + ';',
    's.dispatchEvent(new Event("change"));',
    'await new Promise(function(r){setTimeout(r,1600)});',
    'var b=document.querySelector(\'#detailBox .flag-bar button[data-act="competition"]\');',
    'if(!b) return JSON.stringify({noBtn:true});',
    'b.click();',
    'await new Promise(function(r){setTimeout(r,1800)});',
    'var t=document.getElementById("toast");',
    'return JSON.stringify({toast:t?t.textContent.replace(/\\s+/g," ").trim():null, counts:await df.counts(),',
    '  practiceHas: (await df.matches({mode:"all",kind:"practice",leave:"all"}))',
    '    .some(function(r){return r.room_id===' + JSON.stringify(String(ids.sw)) + ';})})'].join(' '));
  check('⑧ 取消后 counts.comp 回到 0、这一场回到匹配那边',
    s8 && s8.counts && s8.counts.comp === 0 && s8.counts.practice === s8.counts.all &&
    s8.practiceHas === true, JSON.stringify(s8 && s8.counts));
  check('⑧ 取消那句 toast 说的是"回到匹配"，不是光一句已取消',
    s8 && /回到/.test(String(s8.toast)), String(s8.toast).slice(0, 60));
  await sleep(1200);
  const disk = fs.existsSync(FILE_A) ? JSON.parse(fs.readFileSync(FILE_A, 'utf8')) : {};
  const fl = (disk.flags || {})[String(ids.sw)];
  /* ★ 取消后 flags 里留一枚 `competition: 0` 是这版存储的既有形状（commander / excluded 同一套：
   *   只有三枚全为空才整条删掉）。要判的是语义：那一枚不再是 1，物化字段回到 0，两边筛选都回到匹配 ——
   *   拿"键必须不存在"去要求，量的就不是这一版的行为。 */
  check('⑧ 落盘文件里那一枚不再是 1，指挥官那一枚仍在（取消不伤另一枚）',
    !!fl && !fl.competition && fl.commander === 1, JSON.stringify(fl));
  check('⑧ 物化字段也没留着：那场 is_competition=0、is_commander=1',
    !!disk.matches && disk.matches[String(ids.sw)].is_competition === 0 &&
    disk.matches[String(ids.sw)].is_commander === 1,
    JSON.stringify(disk.matches && disk.matches[String(ids.sw)].is_competition) + '/' +
    JSON.stringify(disk.matches && disk.matches[String(ids.sw)].is_commander));

  /* ---------- ⑨ 名单里没有本机这个号的那一支（导入的数据包 / 只读号最容易走到这里） ----------
   * 这一支真在桌面端把整页崩成骨架屏（views.js 解引用 rk.score），修完必须实测一次：
   * 详情页要照画、那颗「标为比赛」要还在、同局对比那一格要用人话说明白为什么没有名次。
   * 做法：把甲这份库的 meta.openid 换成名单里不存在的一个号，再用真下拉切走切回来
   *   （account:switch 会重新读盘 ⇒ 界面吃到的是这份"有名单但没有我"的库）。 */
  /* 顺序要紧：先切走（别让宿主在 unload 时把内存里那份好库盖回盘上），再改盘，最后切回来读改过的那份。 */
  const sw9 = await js([
    'var sel=document.getElementById("accountSwitch");',
    'if(!sel) return JSON.stringify({noSel:true});',
    'sel.value="a2"; sel.dispatchEvent(new Event("change"));',
    'await new Promise(function(r){setTimeout(r,2800)});',
    'return JSON.stringify({away:true, all:(await df.matches({mode:"all",leave:"all"})).length})'].join(' '));
  check('⑨ 先切到乙（把甲那份库从内存里放掉，改盘才不会被回写盖掉）',
    sw9 && sw9.all === 2, JSON.stringify(sw9));
  {
    const j = JSON.parse(fs.readFileSync(FILE_A, 'utf8'));
    j.meta.openid = 'DFPROBEFOREIGN0000000009';
    fs.writeFileSync(FILE_A, JSON.stringify(j));
  }
  const back9 = await js([
    'var sel=document.getElementById("accountSwitch");',
    'sel.value="a1"; sel.dispatchEvent(new Event("change"));',
    'await new Promise(function(r){setTimeout(r,2800)});',
    'return JSON.stringify({name:document.getElementById("profileName").textContent,',
    '  all:(await df.matches({mode:"all",leave:"all"})).length})'].join(' '));
  check('⑨ 切回来仍是甲那一份库（8 场，读的是刚改过的那份盘）',
    back9 && back9.all === 8, JSON.stringify(back9));
  console.log('      盘上现在的 meta.openid = ' +
    JSON.parse(fs.readFileSync(FILE_A, 'utf8')).meta.openid + '（写进去的是 DFPROBEFOREIGN0000000009）');
  /* 切号那一下界面会重跑 refresh()：中途房号下拉是「暂无对局」那一格，这时候点不了也量不到。
   * 所以先等它把新号场次填回来 —— 等不到就如实报，别拿旧号残留的那一页当新号的一页来判。 */
  async function waitPicker(want) {
    for (let i = 0; i < 30; i++) {
      const o = await js('var s=document.getElementById("roomPick");' +
        'return JSON.stringify({opts:s?s.options.length:-1, first:s&&s.options[0]?String(s.options[0].value):null})');
      if (o && o.opts >= want) return o;
      await sleep(500);
    }
    return { timedOut: true };
  }
  const pk9 = await waitPicker(2);
  check('⑨ 切回来之后房号下拉重新装上甲的场次（没等这一步就会拿旧号残留那页误判）',
    !pk9.timedOut && pk9.opts >= 2, JSON.stringify(pk9));
  /* 量不到就把这一支的形状如实抄一份（这段只是诊断，不当结论用） */
  if (pk9.timedOut) {
    console.log('      诊断：' + JSON.stringify(await js([
      'return JSON.stringify({hostMatches:(await df.matches({mode:"all",leave:"all"})).length,',
      ' tableRows:document.querySelectorAll("#matchTable tr.clickable").length,',
      ' statsLine:(document.getElementById("statsLine")||{}).textContent,',
      ' filterCount:(document.getElementById("filterCount")||{}).textContent,',
      ' activeView:(document.querySelector(".view.active")||{}).id,',
      ' toast:(document.getElementById("toast")||{}).textContent,',
      ' offline:(document.getElementById("offlineText")||{}).textContent})'].join(' '))));
    await js('document.querySelector(\'[data-view="matches"]\').click(); return JSON.stringify({ok:1});');
    await sleep(1500);
    console.log('      点一下「战局」之后再读：' + JSON.stringify(await js(
      'var s=document.getElementById("roomPick");return JSON.stringify({opts:s.options.length,' +
      'tableRows:document.querySelectorAll("#matchTable tr.clickable").length})')));
  }
  const d9 = await js([
    'var cands = (await df.matches({mode:"all",leave:"all"})).filter(function(r){return r.hasRoster;});',
    /* ★ 挑一场"名单里有别人、但没有本机这个号"的：先问 core（df.match 走的就是详情页那一发）。
     *   挑不到就是这份档案压根走不到这一支，必须喊出来，不能拿"另一支也画出来了"冒充量过。 */
    'var pick = null;',
    'for (var i = 0; i < cands.length; i++) {',
    '  var cc = await df.match(String(cands[i].room_id));',
    '  if (cc && cc.meMissing && cc.roster >= 5) { pick = cands[i]; break; }',
    '}',
    'if (!pick) return JSON.stringify({noMeMissingRow:true, withRoster:cands.length,',
    '  each: cands.map(function(r){ var c=null; return String(r.room_id); })});',
    'document.querySelector(\'[data-view="detail"]\').click();',
    'var s=document.getElementById("roomPick"); s.value=String(pick.room_id);',
    'var setTo=s.value;',
    's.dispatchEvent(new Event("change"));',
    'await new Promise(function(r){setTimeout(r,2400)});',
    'var b=document.getElementById("detailBox");',
    'var bar=b.querySelector(".flag-bar");',
    'var cmpA = await df.match(String(pick.room_id));',
    'return JSON.stringify({rid:String(pick.room_id), len:b.innerHTML.length,',
    '  picker:{opts:s.options.length, setTo:setTo, want:String(pick.room_id), first:String(s.options[0]&&s.options[0].value),',
    '    has:!![].slice.call(s.options).filter(function(o){return o.value===String(pick.room_id)})[0]},',
    '  boxRid:b.dataset.rid, boxLoaded:b.dataset.loaded,',
    '  cmp:{roster:cmpA&&cmpA.roster, ranks:!!(cmpA&&cmpA.ranks), meMissing:!!(cmpA&&cmpA.meMissing)},',
    '  samePanel:(function(){var ps=[].slice.call(b.querySelectorAll(".panel h3"));' +
    '    var h=ps.filter(function(x){return /同局对比/.test(x.textContent)})[0];' +
    '    return h?h.parentNode.textContent.replace(/\\s+/g," ").slice(0,140):null})(),',
    '  repOpenid:(await df.report({mode:"all"})).openid,',
    '  skeleton:!!b.querySelector(".skeleton"), hasBar:!!bar,',
    '  acts: bar?[].slice.call(bar.querySelectorAll("button")).map(function(x){return x.getAttribute("data-act");}):null,',
    '  body:b.textContent.replace(/\\s+/g," ")})'].join(' '));
  if (d9 && d9.noMeMissingRow) {
    check('⑨ 这份档案里挑得出"有名单但没有本机这个号"的那一场（挑不到就是没量到）', false,
      '带名单的场次 ' + d9.withRoster + ' 场，一场都没走到这一支：' + JSON.stringify(d9.each));
  } else {
    console.log('      下拉：' + JSON.stringify(d9.picker) + ' 详情页 rid=' + d9.boxRid + ' loaded=' + d9.boxLoaded +
      ' 切号后 counts=' + JSON.stringify(await js('return JSON.stringify(await df.counts())')));
    check('★★ 名单里没有本机这个号时详情页照画（不许整页停在骨架屏 —— 这是修掉的真实崩法）',
      d9.skeleton === false && d9.hasBar === true && d9.len > 800,
      'innerLen=' + d9.len + ' flag 按钮=' + JSON.stringify(d9.acts));
    check('⑨ 同局对比那一格说的是"名单里找不到本机这个账号"，不是那句"还没抓到名单"',
      /名单里找不到本机这个账号/.test(String(d9.body)),
      '界面吃到的号=' + d9.repOpenid + ' core 给的=' + JSON.stringify(d9.cmp) +
      ' 那一格念的是：' + String(d9.samePanel).slice(0, 130));
    check('⑨ 那颗「标为比赛」在这一支里也还在（这一枚跟名单无关）',
      d9.acts && d9.acts.indexOf('competition') >= 0, JSON.stringify(d9.acts));
    const s9 = await js([
      'var b=document.querySelector(\'#detailBox .flag-bar button[data-act="competition"]\');',
      'if(!b) return JSON.stringify({noBtn:true});',
      'b.click(); await new Promise(function(r){setTimeout(r,1800)});',
      'return JSON.stringify({counts:await df.counts(),',
      '  comp:(await df.matches({mode:"all",kind:"comp",leave:"all"})).map(function(r){return String(r.room_id)})})'].join(' '));
    check('⑨ 这一支里标记照样走通：counts.comp=1，且「比赛」筛出来就是那一场',
      s9 && s9.counts && s9.counts.comp === 1 && String(s9.comp) === String(d9.rid),
      JSON.stringify(s9 && s9.counts) + ' 筛出 ' + JSON.stringify(s9 && s9.comp));
  }

  console.log('\n' + '='.repeat(60));
  console.log(fail === 0 ? '桌面「比赛对局」端到端：全部通过（' + pass + ' 项）'
    : '桌面「比赛对局」端到端：' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项');
  console.log('='.repeat(60));
  bye(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.log('探针自己炸了：' + ((e && e.stack) || e));
  try { child.kill(); } catch (_) {}
  process.exit(2);
});
