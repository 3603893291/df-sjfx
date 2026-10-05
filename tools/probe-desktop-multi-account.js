'use strict';
/**
 * 开发者探针（不进 npm test、不进交付包；要真 Electron 才跑得动）：
 *   node tools/probe-desktop-multi-account.js
 *   node tools/probe-desktop-multi-account.js --root="<解压出来的程序目录>" --keep
 *
 * 它量的是使用者会直接撞上的那一件事：**登了甲、再登乙，切来切去的时候界面会不会还念着上一个号的数据**。
 * 为什么离线测试量不到：`account:switch` 的归属那一半有 O 系列变异针盯着（改坏了会被咬），
 * 而"界面画出来的是谁的数"要真宿主 + 真界面 + 真落盘的库才答得出来 ——
 * 尤其是**在途的那一次重算撞上切换**这一类时序问题，静态红线根本看不见它。
 *
 * 四步：
 *   ① 开机落在甲 ⇒ 界面念"探测号甲 / 8 场"
 *   ② 用真下拉切到乙 ⇒ 界面念"探测号乙 / 2 场"（切件走的是真 change 事件，不是直接调 IPC）
 *   ③ 切回甲 ⇒ 又念回"探测号甲 / 8 场"（这一条排掉"只画第一次"那种假象）
 *   ④ 竞态（想办法真的把它串出来）：CDP 把渲染线程降到 1/10 速，连打二十轮
 *      「点筛选发起这一号的重算 → 30 ms 后切号」，看最终画的是谁；
 *   ⑤ 不给稳定机会：a1↔a2 连切二十次，最后一次停在谁，界面就必须是谁；
 *   ⑥ 顺带核两份库文件：切完一轮，甲/乙各自的 meta.openid 与场数不能被写脏。
 *
 * 数据安全：这一跑用 %TEMP% 下独立 --user-data-dir（tools/seed-multi-account-profile.js 造的那份），
 * 不碰使用者那个目录；档案里预填了 startup.at ⇒ **不会往他那台服务器计一个装机**。
 * 结束时只 kill 自己起的那只 pid。
 */
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { seed, A, B } = require('./seed-multi-account-profile');

function arg(name, dft) {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(hit.indexOf('=') + 1) : dft;
}
const ROOT = path.join(__dirname, '..');
const APP = arg('root', path.join(ROOT, 'dist', '三角洲全面战场分析器'));
const EXE = path.join(APP, '三角洲全面战场分析器.exe');
const PORT = Number(arg('port', 9343));
const PROFILE = arg('profile', fs.mkdtempSync(path.join(os.tmpdir(), 'df-multi-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b)); }).on('error', rej);
});
const md5 = (f) => (fs.existsSync(f) ? crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex').slice(0, 12) : '(无)');
if (!fs.existsSync(EXE)) { console.log('找不到 exe：' + EXE + '（先 node build.js，或 --root= 指到解压出来那一份）'); process.exit(1); }

const FILE_A = path.join(PROFILE, 'df-swtwr-a1.json');
const FILE_B = path.join(PROFILE, 'df-swtwr-a2.json');
const snapFiles = () => ({ a1: md5(FILE_A), a2: md5(FILE_B) });
/* ★ 比"语义"而不是比字节。开机后那一发地图名自动取会把认不出的 map_id 刷成学来的地名、
 *   并把时间戳重新落一遍（`map_name` 是 map_id 的派生显示名，这一版就是这么设计的），
 *   拿字节相等去判会把一次正常的地名清算读成"数据被写坏"。
 *   不许动的只有这些：这是谁的库、几场、每一场的主键与判定字段 —— 含 `owner_openid`，
 *   串号最先脏的就是它（甲的场次里冒出一个乙的 openid，就是两个人并成一堆）。 */
function semOf(f) {
  if (!fs.existsSync(f)) return null;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const rows = Object.keys(j.matches || {}).sort().map((k) => {
    const m = j.matches[k];
    return [m.room_id, m.owner_openid, m.map_id, m.is_winner, m.game_result, m.kill, m.death, m.score].join('|');
  });
  return { openid: (j.meta || {}).openid, name: (j.meta || {}).name, matches: rows.length, digest: rows.join('\n') };
}
const snapSem = () => ({ a1: semOf(FILE_A), a2: semOf(FILE_B) });

(async function main() {
  const seeded = await seed(PROFILE);
  console.log('档案：' + JSON.stringify(seeded));
  const before = Object.assign(snapFiles(), { sem: snapSem() });

  const env = Object.assign({}, process.env);
  delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, ['--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
    '--no-sandbox', '--disable-gpu', '--in-process-gpu'], { env, stdio: 'ignore' });
  function bye(code) { try { child.kill(); } catch (e) {} if (!arg('keep', '')) console.log('档案留在：' + PROFILE); process.exit(code); }

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

  /* 一次读全：界面念的（DOM） + 宿主认的（IPC 现问） */
  const READ = [
    'function num(s, re){ var m = re.exec(s||""); return m ? Number(m[1]) : null; }',
    'var t = function(id){ var e = document.getElementById(id); return e ? e.textContent.replace(/\\s+/g," ").trim() : null; };',
    'var stats = t("statsLine") || "";',
    'var sel = document.getElementById("accountSwitch");',
    'var b = await df.boot();',
    'return JSON.stringify({',
    '  dom: {',
    '    slotInSelect: sel ? sel.value : null,',
    '    optionText: sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].textContent.replace(/\\s+/g," ").trim() : null,',
    '    profileName: t("profileName"), profileSub: t("profileSub"),',
    '    stored: num(stats, /本地已存战局\\s*(\\d+)\\s*场/),',
    '    counted: num(stats, /纳入统计\\s*(\\d+)\\s*场/),',
    '    rosters: num(stats, /全场名单\\s*(\\d+)\\s*份/),',
    '    offlineText: t("offlineText"),',
    '    appShown: !!document.getElementById("appView") && !document.getElementById("appView").classList.contains("hidden")',
    '  },',
    '  host: { activeSlot: b.activeSlot, matchCount: b.matchCount, name: b.name, localOnly: !!b.localOnly, loggedIn: !!b.loggedIn, bootError: b.bootError || "" }',
    '});'
  ].join('');
  const read = () => js(READ);
  /* 等界面"稳定地说同一句话"两次（避免读到画到一半的中间态） */
  async function settle(ms, tries) {
    let prev = null;
    for (let i = 0; i < (tries || 14); i++) {
      await sleep(ms || 500);
      const now = await read();
      if (prev && JSON.stringify(prev.dom) === JSON.stringify(now.dom) && JSON.stringify(prev.host) === JSON.stringify(now.host)) return now;
      prev = now;
    }
    return prev;
  }

  /* ---------- ① 开机落在甲 ---------- */
  let first = null;
  for (let i = 0; i < 30 && !first; i++) {
    await sleep(700);
    const r = await read();
    if (r && r.host && !r.pageError) first = r;
  }
  if (!first || !first.host) { console.log('界面起不来：' + JSON.stringify(first)); bye(1); }
  const s1 = await settle(600);
  console.log('① 开机 ' + JSON.stringify({ dom: s1.dom, host: s1.host }));

  /* ★ 切号这一发"有没有真的成功"，光比数据归属看不出来：account:switch 的 promise 被拒时
   *   界面弹的是「切换失败」，而宿主那边号其实已经切过去了（store= 在 load 之前就赋了）——
   *   上一版这一跑只比"画出来的是谁的数"，那条 ReferenceError（loadFault 不在作用域里）就这么过去了。
   *   所以每一次切换都要读三件：回包 ok、toast 里没有"失败"、列表与房号下拉真的重新装上。 */
  async function switchHealth() {
    return js('var t=document.getElementById("toast");' +
      /* ★ 这一跑从头到尾停在总览页（它量的是"画出来的是谁的数"，不去点页面），
       *   所以这里自己去把战局列表与房号下拉读一眼 —— 换号成没成，这两处都得跟着重装。 */
      'document.querySelector(\'[data-view="matches"]\').click();' +
      'document.querySelector(\'[data-view="detail"]\').click();' +
      'await new Promise(function(r){setTimeout(r,700)});' +
      'var s=document.getElementById("roomPick");' +
      'return JSON.stringify({toast:t?t.textContent.replace(/\\s+/g," ").trim():"",' +
      ' pickerOpts:s?s.options.length:-1, tableRows:document.querySelectorAll("#matchTable tr.clickable").length})');
  }

  /* ---------- ②/③ 真点下拉切换 ---------- */
  async function doSwitch(slot) {
    return js('var sel=document.getElementById("accountSwitch");if(!sel)return JSON.stringify({ok:false,error:"没有那颗下拉"});' +
      'sel.value=' + JSON.stringify(slot) + ';if(sel.value!==' + JSON.stringify(slot) + ')return JSON.stringify({ok:false,error:"下拉里没有这一档"});' +
      'sel.dispatchEvent(new Event("change",{bubbles:true}));return JSON.stringify({ok:true});');
  }
  const c1 = await doSwitch('a2');
  const s2 = await settle(700);
  const h2 = await switchHealth();
  console.log('② 切到乙 ' + JSON.stringify({ clicked: c1, dom: s2.dom, host: s2.host }));
  const c2 = await doSwitch('a1');
  const s3 = await settle(700);
  const h3 = await switchHealth();
  console.log('③ 切回甲 ' + JSON.stringify({ clicked: c2, dom: s3.dom, host: s3.host }));

  /* ---------- ④ 在途重算撞上切换：想办法**真的**把它串出来 ---------- */
  /* 先说清楚这一条为什么不能靠"改页面里的 df"来测：`window.df` 是 contextBridge 挂出来的，
   * 属性不可重定义（实测量到过：Cannot redefine property: report）—— 想拖慢某一发响应，页面上没有机关。
   * 而且按大小测过本机 report() 的耗时（3000 场也只要 62 ms），拿"库很大所以很慢"去撞也不诚实。
   * 所以这里换成两件真做得出来的事：
   *   ④a 用 CDP 把渲染线程 CPU 降到 1/10（模拟一台慢笔记本 + 大库时那一串同步重画），
   *      连打 20 轮「点筛选（发出这一号的重算）→ 30 ms 后切号」，看最终画的是谁；
   *   ④b 不给它稳定下来的机会：a1↔a2 连切 20 次，最后一次停在谁，界面就必须是谁。
   * 任何一轮画错 = 串数据复现。 */
  await send('Emulation.setCPUThrottlingRate', { rate: 10 });
  const rounds = [];
  for (let i = 0; i < 20; i++) {
    /* 停在甲，然后：让甲发起一次重算，紧接着切到乙 */
    await doSwitch('a1'); await settle(400, 8);
    await js('var b=document.querySelector("#fMode .seg[data-mode=\\"swtwr\\"]"); if(b) b.click(); return JSON.stringify({clicked:!!b});');
    await sleep(30);
    await doSwitch('a2');
    const r = await settle(500, 12);
    rounds.push({
      i: i, slot: r.dom.slotInSelect, name: r.dom.profileName, stored: r.dom.stored,
      hostSlot: r.host.activeSlot, hostCount: r.host.matchCount,
      串了: (r.dom.profileName !== '探测号乙' || r.dom.stored !== 2 || r.host.activeSlot !== 'a2')
    });
  }
  await send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const wrong = rounds.filter((r) => r['串了']);
  console.log('④ 20 轮「重算在路上时切号」：串了 ' + wrong.length + ' 次' + (wrong.length ? ' ' + JSON.stringify(wrong.slice(0, 3)) : ''));

  /* ---------- ⑤ 连切 20 次不等待 ---------- */
  for (let i = 0; i < 20; i++) { doSwitch(i % 2 ? 'a2' : 'a1'); await sleep(45); }
  const s5 = await settle(700, 16);
  const h5 = await switchHealth();
  console.log('（切号后的界面形状）h2=' + JSON.stringify(h2) + ' h3=' + JSON.stringify(h3) + ' h5=' + JSON.stringify(h5));
  console.log('⑤ 连切 20 次后 ' + JSON.stringify({ dom: s5.dom, host: s5.host }));

  /* ---------- ⑥ 两份库文件有没有被写脏 ---------- */
  const after = Object.assign(snapFiles(), { sem: snapSem() });
  const sem = {};
  for (const [k, f] of [['a1', FILE_A], ['a2', FILE_B]]) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    sem[k] = { openid: j.meta.openid, name: j.meta.name, matches: Object.keys(j.matches || {}).length, rosters: Object.keys(j.rosters || {}).length };
  }

  /* ---------- 判 ---------- */
  const want = (s, slot, name, stored) => ({
    ['界面念的昵称是' + name]: s.dom.profileName === name,
    ['界面场数是' + stored]: s.dom.stored === stored,
    ['下拉停在使用者点的那一档(' + slot + ')']: s.dom.slotInSelect === slot,
    ['宿主也是' + slot]: s.host.activeSlot === slot,
    ['宿主 matchCount=' + stored]: s.host.matchCount === stored
  });
  const clean = (h, slot) => ({
    ['切到 ' + slot + ' 的 toast 里没有「失败」']: !!h && !/失败|Error|ReferenceError/.test(String(h.toast)),
    ['切到 ' + slot + ' 后房号下拉重新装上了场次']: !!h && h.pickerOpts >= 2 && h.tableRows >= 1
  });
  const checks = Object.assign({},
    want(s1, 'a1', '探测号甲', 8),
    want(s2, 'a2', '探测号乙', 2),
    want(s3, 'a1', '探测号甲', 8),
    clean(h2, '乙'), clean(h3, '甲回'), clean(h5, '连切二十次之后'),
    {
      '④ 二十轮「重算在路上时切号」一次都没串': wrong.length === 0,
      '⑤ 连切二十次后界面与宿主是同一个号': s5.dom.slotInSelect === s5.host.activeSlot &&
        s5.dom.profileName === (s5.host.activeSlot === 'a1' ? '探测号甲' : '探测号乙') &&
        s5.dom.stored === s5.host.matchCount,
      '④/⑤ 都真跑到了（不是空转）': rounds.length === 20,
      '甲与乙的场数不是同一个数（样本没退化）': s2.dom.stored !== s1.dom.stored,
      '两份库的语义一个字没被改写（谁 owns 哪几场、每场的判定字段）':
        before.sem.a1.digest === after.sem.a1.digest && before.sem.a2.digest === after.sem.a2.digest,
      '甲的库仍是甲的、乙的库仍是乙的': after.sem.a1.openid === A.openid && after.sem.a2.openid === B.openid,
      '甲的库里没有一场挂着乙的 openid（交叉写脏）': !after.sem.a1.digest.includes(B.openid) && !after.sem.a2.digest.includes(A.openid),
      '场数没串：甲 8 / 乙 2': after.sem.a1.matches === 8 && after.sem.a2.matches === 2
    });
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  console.log('\n' + '='.repeat(64));
  for (const k of Object.keys(checks)) console.log((checks[k] ? '  ✔ ' : '  ✘ ') + k);
  console.log('   （信息）字节 md5：甲 ' + before.a1 + ' → ' + after.a1 + ' ／ 乙 ' + before.a2 + ' → ' + after.a2 +
    '   —— 字节变了不等于写坏，见上面那两条语义判据');
  console.log('   语义：' + JSON.stringify(sem));
  console.log('='.repeat(64));
  console.log(bad.length === 0 ? '✓ 没串：三切一回 + 在途竞态，界面念的都是当前那个号的数据' : '✗ 有问题：\n  - ' + bad.join('\n  - '));
  bye(bad.length === 0 ? 0 : 3);
})().catch((e) => { console.log('崩：' + ((e && e.stack) || e)); try { child.kill(); } catch (e2) {} process.exit(2); });
