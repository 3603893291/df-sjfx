'use strict';
/* scan-dist.js —— 把 dist 交出去之前扫一遍：**里面不许有本机任何一个人的数据，也不许有插件**
 *
 * 跑法：
 *   node tools/scan-dist.js                        扫默认的 dist/
 *   node tools/scan-dist.js --root=<目录>           扫指定目录
 *   node tools/scan-dist.js --against=<目录>         反向验证：同一套判据在真数据上必须报红
 *
 * 为什么写成脚本而不是"我看一眼"：判据要从**他机器上真实存在的数据**里现取（昵称、openid、
 * 战队站点、密钥、房间号…），手抄一份清单第二天就过期了；而 271 MB 的包里除了 29 个代码文件
 * 还有那颗 189 MB 的 exe，人翻不动。
 * ★ 两档信号是分开的，别混：**Chromium 的 .pak/.dll/.exe 里几百万字节随机数，任何 3~5 字符
 *   的串都会命中**（第一版就是把昵称按 3 字符起扫，报出 2073 条"命中"，全是垃圾）。
 *   所以短信号（名字、短 id）只扫**文本类文件**，二进制里只扫"长到不可能撞"的那一类。
 * ★ 与离线测试同一规矩：**"扫不到"不等于"没有"** —— 带 --against 拿他真实运行目录当靶子，
 *   扫不出红就等于这套判据是瞎的，那句"零命中"不能信。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
function arg(name, dflt) {
  const hit = process.argv.find(function (a) { return a.indexOf('--' + name + '=') === 0; });
  return hit ? hit.slice(name.length + 3) : dflt;
}
const target = path.resolve(arg('root', path.join(ROOT, 'dist')));
const against = arg('against', '');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL = path.join(APPDATA, 'df-swtwr');

/* ------------------------------------------------ 1) 从真运行目录里现取"我的数据"长什么样 */

const strong = new Map();   // 长到不可能撞：任何文件里出现都是泄漏
const weak = new Map();     // 短名字/短 id：只在文本类文件里判
function put(map, v, why, min) {
  const s = String(v == null ? '' : v).trim();
  if (s.length >= min && !map.has(s)) map.set(s, why);
}
function addSignal(v, why, tier) {
  if (tier === 'weak') { put(weak, v, why, 3); return; }
  put(strong, v, why, 8);
}
function walkDeep(node, cb, depth) {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) { node.forEach(function (x) { walkDeep(x, cb, depth + 1); }); return; }
  if (typeof node === 'object') {
    Object.keys(node).forEach(function (k) {
      cb(k, node[k]);
      walkDeep(node[k], cb, depth + 1);
    });
  }
}
function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}
const ID_KEY = /^(openid|playerId|player_id|vopenid)$/i;
const NAME_KEY = /^(name|nick|nickname|playerName)$/i;
const URLISH = /^(site|url|baseUrl|endpoint|host|apiBase|proxy|webhook)$/i;
const SECRET = /^(key|token|secret|apiKey|api_key|password|authorization)$/i;

function eatValue(k, v, where, cls) {
  if (v == null || typeof v === 'object') return;
  const s = String(v).trim();
  if (!s) return;
  const digits = /^\d+$/.test(s);
  if (cls === 'plugin') {
    /* plugin-data 里放的是站点地址、密钥、令牌 —— 键名是插件自己起的，整份都要当信号，长度门槛放低 */
    addSignal(s, where + (k ? ' 字段 ' + k : ' 的值'), s.length >= 8 ? 'strong' : 'weak');
    return;
  }
  if (cls === 'plugin-meta') {
    /* 插件注册表与 manifest：里面那些 name / label / desc / sentence 是**出厂目录文案**，
     * 随包发的 core/plugin.js 里就有同一批字 —— 当信号取就是"自己扫自己"（实测把
     * true / false / main / view / storage / 四条中文说明全报成"本机数据"，一个干净包被自己判红）。
     * 这一层只按身份类键名取：站点、密钥、openid 这一类。*/
    if (digits) { if (s.length >= 9) addSignal(s, where + ' 字段 ' + k, 'strong'); return; }
    if (ID_KEY.test(k) && s.length >= 9) addSignal(s, where + ' 字段 ' + k, 'strong');
    else if (URLISH.test(k) || SECRET.test(k)) addSignal(s, where + ' 字段 ' + k, 'strong');
    /* name 这一层刻意不取：注册表里那个 name 是插件显示名与包内文件名（main.js / manifest.json /
     * ui.html），随包发的目录文案里就有这几串 —— 取它等于把自己扫红。
     * 插件真拿了什么站点 / 令牌 / PID，写在 plugin-data 那一层，仍按整份扫。*/
    return;
  }
  if (cls !== 'identity') return;                       // 别的文件（报告正文等）不参与
  if (digits) {
    /* 只有 openid / roomId 这个量级的数字才算身份，短数字串在代码里满地都是 */
    if (s.length >= 9) addSignal(s, where + ' 字段 ' + k, 'strong');
    return;
  }
  if (ID_KEY.test(k) && s.length >= 9) addSignal(s, where + ' 字段 ' + k, 'strong');
  else if (URLISH.test(k) || SECRET.test(k)) addSignal(s, where + ' 字段 ' + k, 'strong');
  else if (NAME_KEY.test(k)) addSignal(s, where + ' 字段 ' + k, s.length >= 8 ? 'strong' : 'weak');
}
function collectFromDataDir(dir) {
  if (!fs.existsSync(dir)) return 0;
  let files = 0;
  (function walk(d, cls) {
    fs.readdirSync(d, { withFileTypes: true }).forEach(function (ent) {
      const p = path.join(d, ent.name);
      /* 这两层的取样规则不一样，别混成一个布尔：
       *   plugin-data = 插件自己写的键（站点 / 令牌 / PID）⇒ 整份都是信号
       *   plugins/    = 注册表与各包 manifest（出厂目录文案）⇒ 只按身份类键名取 */
      const sub = cls || (/^plugin-data$/i.test(ent.name) ? 'plugin'
        : /^plugins$/i.test(ent.name) ? 'plugin-meta' : '');
      if (ent.isDirectory()) { walk(p, sub); return; }
      files++;
      if (!/\.(json|txt)$/i.test(ent.name)) return;
      const j = readJson(p);
      if (!j) return;
      /* 只有账号注册表 / 号库文件 / plugin-data / plugins 参与取样：
       * 日报与 ai-reports-legacy 里那些 name 是**报告正文**里的词，拿去扫代码就是几千条噪音 */
      const use = sub || (/^df-swtwr-[a-z0-9]+\.json$/i.test(ent.name) || /^accounts\.json$/i.test(ent.name)
        ? 'identity' : '');
      if (!use) return;
      walkDeep(j, function (k, v) { eatValue(k, v, ent.name, use); }, 0);
    });
  })(dir, '');
  return files;
}
const realFiles = collectFromDataDir(REAL);

/* 机器身份：给别人用的包里不该出现我这台机器的用户名、路径与机器名 */
[process.env.USERPROFILE, '\\Users\\' + os.userInfo().username, os.hostname()]
  .forEach(function (v) { addSignal(v, '本机身份', 'strong'); });
addSignal(os.userInfo().username, '本机 Windows 用户名', 'weak');

/* 仓库里那份样本是他自己的战绩样本，也不该混进交付包 */
const SAMPLE = path.join(ROOT, '..', 'df-analyzer', 'sample', 'sample_data.json');
if (fs.existsSync(SAMPLE)) {
  const sj = readJson(SAMPLE);
  if (sj) walkDeep(sj, function (k, v) { eatValue(k, v, 'sample_data.json', 'identity'); }, 0);
}

/* ------------------------------------------------ 2) 扫 */

function listFiles(root) {
  const out = [];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach(function (ent) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p); else out.push(p);
    });
  })(root);
  return out;
}
/* 文本类 = 短信号也判；其余（.pak/.dll/.exe/.bin/dat/tf 与任何大文件）只判长信号 */
function isTexty(f, size) {
  /* vendor（echarts 那种压缩过的第三方包）里 3~5 字符随机串满地都是，短信号扫它只会造噪音 */
  if (/[\\/]vendor[\\/]/i.test(f)) return false;
  return size <= 4 * 1024 * 1024 &&
    /\.(js|mjs|cjs|json|html?|css|txt|md|map|svg|xml|ya?ml|ipc|sh|ps1)$/i.test(f);
}
/* 结构判据：这些名字本身就是"这里有个人数据/插件"的证据，出现即红，不看内容 */
function structural(rel) {
  const parts = path.normalize(rel).split(/[\\/]+/).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  const dirs = parts.slice(0, -1).map(function (p) { return p.toLowerCase(); });
  const hasDir = function (n) { return dirs.indexOf(n) >= 0; };
  if (/^accounts\.json$/i.test(last)) return '账号注册表 accounts.json';
  if (/^df-swtwr-[a-z0-9]+\.json$/i.test(last)) return '某个号的战绩库文件';
  if (hasDir('plugin-data')) return '插件数据目录 plugin-data';
  if (hasDir('plugins')) return '已安装的插件目录 plugins';
  if (/\.secret\.json$/i.test(last)) return '插件的密钥文件';
  if (hasDir('backups')) return '自动备份目录';
  if (/migration-report/i.test(last)) return '数据迁移报告';
  if (/\.(log|sqlite|ldb|wal|localstorage-journal)$/i.test(last)) return '运行期日志/存储文件';
  if (/^(local state|preferences|cookies|login data|visits|history|transportsecurity)$/i.test(last)) {
    return 'Chromium 配置/cookie 文件';
  }
  if (/\.tmp$/i.test(last)) return '运行期临时文件';
  const DEV = ['test', 'tools', 'plugins-src', 'plugins-dist', 'android', 'dist-android', 'app-icon'];
  const dev = dirs.filter(function (p) { return DEV.indexOf(p) >= 0; });
  if (dev.length) return '开发目录不该进交付包：' + dev[0];
  return '';
}
const CHUNK = 4 * 1024 * 1024, OVERLAP = 512;
function scanFile(f, size, label, hits) {
  const texty = isTexty(f, size);
  const keys = texty
    ? [].concat([...strong.keys(), ...weak.keys()])
    : [...strong.keys()];
  if (!keys.length) return;
  const needles = keys.map(function (k) {
    return { k: k, b: Buffer.from(k, 'utf8') };
  });
  const fd = fs.openSync(f, 'r');
  try {
    for (let start = 0; start < size; start += CHUNK) {
      const from = Math.max(0, start - OVERLAP);      // 上一块的尾巴再读一遍，别让信号压在边界上
      const len = Math.min(CHUNK + OVERLAP, size - from);
      if (len <= 0) break;
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, from);
      if (n <= 0) break;
      const view = buf.subarray(0, n);
      needles.forEach(function (nd) {
        if (view.indexOf(nd.b) < 0) return;
        if (!hits.has(nd.k)) hits.set(nd.k, []);
        if (hits.get(nd.k).length < 3) hits.get(nd.k).push(label);
      });
      if (from + n >= size) break;
    }
  } finally { fs.closeSync(fd); }
}

/* ------------------------------------------------ 3) 包必须等于当前源码 */

function staleCheck() {
  const out = [];
  const appDir = path.join(target, '三角洲全面战场分析器', 'resources', 'app');
  ['core', 'shell', 'ui'].forEach(function (d) {
    const srcDir = path.join(ROOT, d), pkgDir = path.join(appDir, d);
    if (!fs.existsSync(pkgDir)) { out.push(d + '/ 整个没进包'); return; }
    const md5 = function (f) {
      return crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
    };
    const rel = function (base) {
      const set = new Set();
      (function w(dir) {
        fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) w(p); else set.add(path.relative(base, p));
        });
      })(base);
      return set;
    };
    const a = rel(srcDir), b = rel(pkgDir);
    a.forEach(function (r) {
      if (!b.has(r)) { out.push(d + '/' + r + ' 包里没有'); return; }
      if (md5(path.join(srcDir, r)) !== md5(path.join(pkgDir, r))) {
        out.push(d + '/' + r + ' 包内那份与源码不同（构建过期）');
      }
    });
    b.forEach(function (r) { if (!a.has(r)) out.push(d + '/' + r + ' 包里多出来的文件'); });
  });
  return out;
}

function mask(v) { return JSON.stringify(v.slice(0, 4)) + '…（' + v.length + ' 字符）'; }

/* ★ 取样规则的反向验证（默认就跑，不用记着另外敲一颗参数）。
 * 这道闸的红线是"扫不到不等于没有"，而取样本身也有另一头的风险：**规则一旦放宽，
 * 包就再也扫不出真泄漏了**，而且放宽那天没人知道（上一轮就是这条把干净包判红 ——
 * 注册表里那些出厂目录文案被整份当身份信号，于是"自己扫自己"）。
 * 所以每次进门先现造四条只可能从这三个分支出来的串，逐条验一遍取样规则还站在原位：
 *   1) 号库里的 nickname ⇒ 必须被取（身份类键名）
 *   2) plugin-data 里键名叫 anything 的串 ⇒ 必须被取（那一层整份都算，键名是插件自己起的）
 *   3) plugins 注册表里键名叫 site 的串 ⇒ 必须被取（这一层只认身份键名）
 *   4) plugins 注册表里键名叫 desc 的串 ⇒ 必须**不**被取（那就是随包发的目录文案）
 * 串是随机现造的 ⇒ 除了这颗夹具，任何地方都不会出现它，判"有没有进信号池"就是判这条规则本身。*/
function plantCheck() {
  const P1 = 'zzpl' + crypto.randomBytes(9).toString('hex');   // 22 字符，含字母 ⇒ 只认键名那条
  const P2 = 'zzpd' + crypto.randomBytes(9).toString('hex');
  const P3 = 'zzpm' + crypto.randomBytes(9).toString('hex');
  const P4 = 'zzcat' + crypto.randomBytes(9).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfscan-plant-'));
  const fails = [];
  try {
    fs.writeFileSync(path.join(dir, 'df-swtwr-a1.json'), JSON.stringify({ nickname: P1 }));
    fs.mkdirSync(path.join(dir, 'plugin-data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin-data', 'x.json'), JSON.stringify({ anything: P2 }));
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugins', 'plugins.json'),
      JSON.stringify({ site: P3, desc: P4, label: '在左侧栏加一页', anyHost: false }));
    collectFromDataDir(dir);
    if (!strong.has(P1)) fails.push('号库里的 nickname 没被取样（identity 那一支断了）');
    if (!strong.has(P2)) fails.push('plugin-data 里键名叫 anything 的串没被取样（那一层不再整份扫 ⇒ 令牌扫不出来）');
    if (!strong.has(P3)) fails.push('plugins 注册表里的 site 没被取样（身份键名那一支也一起断了）');
    if (strong.has(P4) || weak.has(P4)) fails.push('plugins 注册表里的目录文案仍被当身份信号 ⇒ 干净包会再次被自己判红');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const taken = [P1, P2, P3].filter(function (v) { return strong.has(v); }).length;
  return { fails: fails, taken: taken };
}

function main() {
  if (!fs.existsSync(target)) { console.log('× 找不到要扫的目录：' + target); return 1; }
  console.log('扫描目标：' + target);
  console.log('信号：长 ' + strong.size + ' 条 / 短 ' + weak.size + ' 条' +
    '（从 ' + REAL + ' 的 ' + realFiles + ' 个文件、仓库样本与本机身份现取）');
  if (strong.size < 6) {
    console.log('× 只取到 ' + strong.size + ' 条长信号，这套扫描等于没扫 —— 先看真运行目录在不在');
    return 1;
  }
  /* ★ 这句 ✓ 不许白拿：taken 是"三条现造串真进了信号池"的条数，谁把上面那颗夹具摘掉或
   *    把长度门槛抬走，taken 就掉下来，这道闸直接不干活（G5 那针钉的就是这一条）。 */
  const plant = plantCheck();
  if (plant.fails.length) {
    console.log('\n× 取样规则本身不成立（' + plant.fails.length + ' 条），这次扫描的结果不能引用：');
    plant.fails.forEach(function (m) { console.log('  ' + m); });
    return 1;
  }
  if (plant.taken < 3) {
    console.log('\n× 取样夹具没跑成（现造串只有 ' + plant.taken + '/3 进了信号池），这次扫描的结果不能引用');
    return 1;
  }
  console.log('✓ 取样规则现造验过（号库 nickname / plugin-data 任意键 / 注册表 site 三条都取得到，注册表文案不取）');
  const hits = new Map();
  const bad = [];
  const files = listFiles(target);
  files.forEach(function (f) {
    const rel = path.relative(target, f);
    const s = structural(rel);
    if (s) bad.push(rel + '  ← ' + s);
    scanFile(f, fs.statSync(f).size, rel, hits);
  });
  const stale = fs.existsSync(path.join(target, '三角洲全面战场分析器')) ? staleCheck() : [];

  const bytes = files.reduce(function (n, f) { return n + fs.statSync(f).size; }, 0);
  console.log('文件 ' + files.length + ' 个 / ' + bytes.toLocaleString('en-US') + ' 字节' +
    '（其中按短信号判的文本文件 ' +
    files.filter(function (f) { return isTexty(f, fs.statSync(f).size); }).length + ' 个）');
  let rc = 0;
  if (bad.length) {
    rc = 1;
    console.log('\n× 结构上就不该进交付包（' + bad.length + ' 项）：');
    bad.slice(0, 30).forEach(function (b) { console.log('  ' + b); });
  }
  if (hits.size) {
    rc = 1;
    console.log('\n× 内容里扫到本机数据（' + hits.size + ' 类）：');
    [...hits.entries()].slice(0, 20).forEach(function (e) {
      console.log('  ' + mask(e[0]) + ' ← ' + (strong.get(e[0]) || weak.get(e[0])) +
        '；出现在 ' + e[1].join(' , '));
    });
  }
  if (stale.length) {
    rc = 1;
    console.log('\n× 包与源码不一致（' + stale.length + ' 项）：');
    stale.slice(0, 20).forEach(function (s) { console.log('  ' + s); });
  }
  if (!rc) console.log('\n✓ 干净：没有本机数据、没有插件与运行期文件，且包内代码与源码逐字节一致');

  if (against) {
    const dir = path.resolve(against);
    const probe = new Map();
    let scanned = 0;
    listFiles(dir).forEach(function (f) {
      const st = fs.statSync(f);
      if (st.size > 40 * 1024 * 1024) return;
      scanFile(f, st.size, path.relative(dir, f), probe); scanned++;
    });
    console.log('\n[反向验证] 同一套判据扫 ' + dir + '（' + scanned + ' 个文件）→ 命中 ' +
      probe.size + ' 类信号');
    if (!probe.size) { console.log('× 扫真数据都扫不出来，那"零命中"这句话不能信'); return 1; }
    console.log('✓ 判据看得见真数据');
  }
  return rc;
}
process.exit(main());
