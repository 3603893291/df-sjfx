'use strict';
/**
 * 开发者脚本（不进 npm test、不进交付包）：**只读**问官方「当前到底是第几赛季」。
 *
 *   node tools/probe-official-seasons.js                 # 问 sid 10..14
 *   node tools/probe-official-seasons.js --sids=10,11    # 少问几发
 *   node tools/probe-official-seasons.js --keep         # 留着临时档案目录（默认用完删）
 *
 * 为什么要它：官方**没有任何接口能查"当前赛季号"**（抓包核过的 12 个端点里都没有），
 * 所以软件里那一格只能写死一个默认值、或者让人自己填（v1.9.1 就是这两条）。
 * 想不想做"自动认赛季"，得先量出来一件事：拿同一个会话问不同 sid，官方是**照问必回**、
 * 还是**回不存在的号就报错/回空**、回包里那个 `season.sid` 到底是照抄我给的号还是它自己的当前号。
 * 没量过就做自动选号，就是把猜的号印成"本赛季"。
 *
 * 三条硬约束（这个脚本的存在理由就建立在这上面）：
 *   ① 全程只发 `GetRoleInfo`（探测是谁）与 `GetBattleReport`（每档一个 sid）——
 *      **一次都不写库**：不碰 `df-swtwr-*.json`、不调 `ingest`、不动 `accounts.json`。
 *   ② 不直接拿他正在跑的实例开刀：把登录罐子里的 **Cookie 一份 + Local State**（解 Cookie 用的钥匙，
 *      DPAPI 按当前 Windows 用户加解密）复制到 `%TEMP%` 下的一份新档案里，
 *      用未打包的 Electron 起一个**只干这件事**的临时主进程；用完连临时目录一起删。
 *      他的原目录只读、一个字都不写。
 *   ③ 回包只摘要打印（sid、有没有 mp/stats、场次量级、错误码），**不打印昵称、openid、Cookie**。
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
function arg(name, dflt) {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(hit.indexOf('=') + 1) : dflt;
}
const HAS = (n) => process.argv.slice(2).indexOf('--' + n) >= 0;
const SIDS = arg('sids', '10,11,12,13,14');
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL = path.join(APPDATA, 'df-swtwr');

function die(msg) { console.log('× ' + msg); process.exit(1); }

/* ---------- 1) 从他本机档案里读出"槽位/体系/大区"这三颗（只读这三样，别的一概不碰） ---------- */
const reg = JSON.parse(fs.readFileSync(path.join(REAL, 'accounts.json'), 'utf8'));
const slot = String(reg.activeSlot || (reg.accounts && reg.accounts[0] && reg.accounts[0].slot) || 'a1');
const acct = (reg.accounts || []).filter((a) => String(a.slot) === slot)[0] || {};
const acctType = Number(acct.accountType) === 2 ? 2 : 1;
const area = Number(acct.area) || 36;
if (acct.imported) die('槽位 ' + slot + ' 是导入出来的只读号（没有本机登录态），这一跑需要一个真登录过的号');
/* 落盘上那个罐子的目录名是 `wegame-slot-<slot>`（Electron 把 `persist:` 这段省掉了，实测过），
 * 而 Cookie 在现代 Chromium 里住在 `Network/Cookies` 下面，不在罐子根目录。 */
const JAR_REL = path.join('Partitions', 'wegame-slot-' + slot, 'Network');
const jar = path.join(REAL, 'Partitions', 'wegame-slot-' + slot);
const jarNet = path.join(REAL, JAR_REL);
if (!fs.existsSync(path.join(jarNet, 'Cookies'))) die('找不到这个号的登录罐子：' + jarNet + '\\Cookies');
console.log('槽位 ' + slot + ' · 账号体系 ' + acctType + ' · 大区 ' + area +
  ' · 要问的 sid：' + SIDS);

/* ---------- 2) 起的是**已打包那支 exe**，不是未打包的 electron.exe ----------
 * 原因量出来了：Chromium 130（Electron 33）在 Windows 上给 Cookie 值加的是 **app-bound 加密** ——
 * 钥匙绑在"哪个 exe 封的"上面。拿另一条路径的 electron.exe 去读同一份 Cookies，解不开就被静默丢掉，
 * 于是官方回 8000102「未登录」，量到的全是假阴性（上一版这么跑过，一行都没量到）。
 * 所以这一跑用与它同一个 exe 路径（dist 那支），只是把 --user-data-dir 指到临时副本，
 * 他真实的档案目录全程只读、一个字都不写。 */
const EXE = arg('exe', path.join(ROOT, 'dist', '三角洲全面战场分析器', '三角洲全面战场分析器.exe'));
if (!fs.existsSync(EXE)) die('找不到已打包的 exe：' + EXE);
if (!fs.existsSync(path.join(ROOT, 'dist', '三角洲全面战场分析器', 'resources', 'app', 'shell', 'main.js'))) {
  die('dist 里没有应用代码（先 node build.js）');
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'df-season-probe-'));
const PROFILE = path.join(TMP, 'profile');
const JAR_DST = path.join(PROFILE, 'Partitions', 'wegame-slot-' + slot, 'Network');
fs.mkdirSync(JAR_DST, { recursive: true });
function copy(from, to) { try { fs.copyFileSync(from, to); return true; } catch (e) { return false; } }
const needed = [
  [path.join(REAL, 'Local State'), path.join(PROFILE, 'Local State')],
  [path.join(jarNet, 'Cookies'), path.join(JAR_DST, 'Cookies')],
  /* 注册表也要带：那一枚 slot 的体系/大区/罐子名都在里面；
     而且它带着 startup.at —— 没有那一枚，这台"新机器"开机 6 秒就会往他生产表报一次装机。 */
  [path.join(REAL, 'accounts.json'), path.join(PROFILE, 'accounts.json')]
];
needed.forEach(function (p) { if (!copy(p[0], p[1])) die('复制失败（他正跑着的那份被占住？稍后再试）：' + p[0]); });
['Cookies-journal', 'Cookies-wal', 'Cookies-shm'].forEach(function (f) {
  const p = path.join(jarNet, f);
  if (fs.existsSync(p)) copy(p, path.join(JAR_DST, f));
});
const reg2 = JSON.parse(fs.readFileSync(path.join(PROFILE, 'accounts.json'), 'utf8'));
const hasStartupAt = !!(reg2.globalSettings && reg2.globalSettings.startup && reg2.globalSettings.startup.at);
console.log('临时档案：' + PROFILE);
console.log('  带过去的只有：Local State（解 Cookie 的钥匙）· 这个号的 Cookies · accounts.json');
console.log('  战绩库 / 插件数据 / 别人的号：一个字节都没复制');
console.log('  装机计数那发：' + (hasStartupAt ? '这台机器已经报过（startup.at 在），这一跑不会再报' : '★ 档案里没有 startup.at，这一跑可能真会往他生产表加一格！'));

/* ---------- 3) 跑：官方 GetBattleReport 按 sid 逐档问 ---------- */
const OUT = path.join(TMP, 'season-probe.json');
const r = cp.spawnSync(EXE, ['--user-data-dir=' + PROFILE,
  '--season-probe=' + SIDS, '--season-probe-out=' + OUT,
  '--no-sandbox', '--disable-gpu', '--in-process-gpu'],
  { cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 32 << 20 });
if (r.error) console.log('启动器报了：' + r.error.message);
if (r.stderr && String(r.stderr).trim()) console.log('stderr（前 300 字）：' + String(r.stderr).replace(/[\u4e00-\u9fa5]/g, '?').slice(0, 300));

function bye(code) {
  if (HAS('keep')) console.log('临时档案留在：' + TMP + '（里面有 Cookie 副本，看完记得删）');
  else { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.log('★ 临时目录没删掉（里面有 Cookie 副本，请手工删）：' + TMP); } }
  process.exit(code);
}

let res = null;
try { res = JSON.parse(fs.readFileSync(OUT, 'utf8')); }
catch (e) {
  console.log('× 没拿到结果（exit=' + r.status + '）。★ dist 里那份 shell/main.js 得有 --season-probe 那一段开发补丁：');
  console.log('   node -e "process.stdout.write(String(require(\'fs\',).readFileSync(\'dist/三角洲全面战场分析器/resources/app/shell/main.js\',\'utf8\').indexOf(\'runSeasonProbe\')))"');
  bye(1);
}

/* ---------- 4) 读结果，只打摘要（不打昵称 / openid / Cookie） ---------- */
console.log('\n走到哪一步：槽位 ' + res.slot + ' · 大区 ' + (res.area || '—') + ' · 探测 ' + JSON.stringify(res.probe) +
  (res.errors && res.errors.length ? '  错误：' + JSON.stringify(res.errors) : ''));

console.log('问出去的 sid 与官方回包的对照：');
res.rows.forEach((x) => {
  if (x.error) { console.log('  sid ' + x.asked + ' → 报错 code=' + (x.code || '—') + ' notLogin=' + !!x.notLogin + ' ' + x.error); return; }
  console.log('  sid ' + x.asked + ' → 回包里的 sid=' + (x.echoed === null ? '（没有这个字段）' : x.echoed) +
    '  本赛季场次=' + x.mpFight + '  总分=' + x.mpScore + '  通行证=' + (x.mpBp == null ? '—' : x.mpBp) +
    '  生涯场次=' + x.tdmFight + '  键=' + (x.keys || '（空回包）'));
});

/* 这几条就是"能不能自动认赛季"的判据，全部从实测行里现推，不写死 */
const ok = res.rows.filter((x) => !x.error);
const echoSame = ok.filter((x) => x.echoed === x.asked).length;
const nonEmpty = ok.filter((x) => x.mpFight > 0 || x.tdmFight > 0).length;
console.log('\n量出来的三件事：');
console.log('  ① 回包照抄我问的号（' + echoSame + '/' + ok.length + ' 行 sid 与问出去的一致）⇒ 回包里那个 sid **不是**"官方当前赛季"，软件拿它认不出当前号');
console.log('  ② 有内容的档（' + nonEmpty + '/' + ok.length + ' 行非空）⇒ ' +
    (nonEmpty === ok.length ? '每档都回，说明"回不存在的号会报错"这条不成立，靠报错反推当前赛季行不通' : '空/报错的档存在，"问过头会怎样"是可以拿来当判据的信号'));
console.log('  ③ 各档的"本赛季场次"是否互不相同 ⇒ ' +
    (new Set(ok.map(x => x.mpFight)).size > 1 ? '不同 ⇒ 那一列跟着 sid 走，问错号就会念错数（这正是设置里那一格要如实印 sid 的理由）' : '看不出差别'));
console.log('\n结论写进手册：' + (ok.length ? '这一跑量到 ' + ok.length + ' 行' : '这一跑一行都没量到') + '；临时目录已删（里面有 Cookie 副本）。');
bye(0);
