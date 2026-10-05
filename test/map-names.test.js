'use strict';
/* map-names.test.js — 地图名：官方公开配置表 → 本机学名表 → 历史场次改名
 * 运行：node test/map-names.test.js
 *
 * 为什么单独成一个套：core/maps.js 的学名层是**模块级单例**（一个 JS 上下文一份），
 * 混进 core.test.js 就会污染它那几条「959 认不出来」的断言。单开一个进程，脏的只有自己。
 *
 * 五段：A 真夹具 / B 脏输入 / C 学名层 / D 历史场次改名 / E 触发口径（两端静态红线）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Maps = require('../core/maps');
const Cfg = require('../core/mapConfig');
const StoreMod = require('../core/store');
let fail = 0;
function check(name, ok, detail) {
  const good = !!ok;
  if (!good) fail++;
  console.log(`${good ? '  PASS' : '  FAIL'}  ${name}${detail !== undefined ? '  -> ' + detail : ''}`);
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function rows(list) { return JSON.stringify({ mapDetail: list }); }
Maps.clearExtra();

/* ---------------- A 真夹具 ---------------- */
console.log('\n[A] 官方那份公开配置表（2026-09-24 抓的，原样存在 test/fixtures/）');
const RAW = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'map-config.json'), 'utf8');
const P = Cfg.parse(RAW);
check('★ 夹具能解析，条数明显比手抄那份多', P.ok === true && P.count >= 100,
  'ok=' + P.ok + ' rows=' + P.count);
check('★★ 262 = 摩格旧城区-占领（用户报的那把新图，正是内置表缺的那一条）',
  P.names['262'] === '摩格旧城区-占领', P.names['262']);
check('★ 同一批新图里另外几条也认得',
  P.names['261'] === '摩格旧城区-攻防' && P.names['433'] === '摩格旧城区-团队死斗' &&
  P.names['614'] === '攻防-指挥官模式-摩格旧城区' && P.names['959'] === '烬区-焦点',
  [P.names['261'], P.names['433'], P.names['614'], P.names['959']].join(' / '));
const builtin = Maps.mapName;
const bIds = Object.keys(builtin);
const same = bIds.filter(function (id) { return P.names[id] === builtin[id]; }).length;
const diff = bIds.filter(function (id) { return P.names[id] && P.names[id] !== builtin[id]; });
const gone = bIds.filter(function (id) { return !P.names[id]; });
check('★★ 手抄那 72 条与官方一字不差 —— 「内置优先」这条规矩就是这么量出来的',
  same === bIds.length && diff.length === 0 && gone.length === 0,
  '同名 ' + same + ' 不同名 ' + diff.length + ' 配置里没有 ' + gone.length);
const extra = Object.keys(P.names).filter(function (id) { return !builtin[id]; });
check('★ 该学的就是内置表缺的那些（多出多少条 = 能学到多少条）',
  extra.length === P.count - bIds.length && extra.length >= 40, '多出 ' + extra.length + ' 条');
check('★ 从名字反推的胜者为王清单与内置 SWWR_IDS 完全一致（错了会把新图算进常规场）',
  P.swtwr.slice().sort(function (a, b) { return a - b; }).join(',') ===
  Maps.swtwrIds.slice().sort(function (a, b) { return a - b; }).join(','),
  '夹具 ' + P.swtwr.length + ' 条 / 内置 ' + Maps.swtwrIds.length + ' 条');
check('★ 夹具里没有一条名字长过清洗上限（长过就等于整条白学）',
  Object.keys(P.names).every(function (id) { return P.names[id].length <= Cfg.NAME_MAX; }),
  '上限 ' + Cfg.NAME_MAX + ' 最长 ' + Math.max.apply(null, Object.keys(P.names)
    .map(function (id) { return P.names[id].length; })));

/* ---------------- B 脏输入 ---------------- */
console.log('\n[B] 脏输入：宁可不学，也不许替官方编一个名字');
[['', '配置表是空的'], ['{', '不是合法 JSON'], ['{"map":{"a":1}}', '没有 mapDetail'],
  ['{"mapDetail":[]}', '一条名字都没解析出来']].forEach(function (p) {
  const r = Cfg.parse(p[0]);
  check('★ 坏输入给人话错误：' + (p[0] === '' ? '空文本' : p[0].slice(0, 18)),
    r.ok === false && String(r.error).indexOf(p[1]) !== -1, r.error);
});
check('★ 截断的夹具（半份 JSON）算失败，不返回半张表',
  Cfg.parse(RAW.slice(0, 200)).ok === false, Cfg.parse(RAW.slice(0, 200)).error);
const big = '{"mapDetail":[],"pad":"' + new Array(Cfg.MAX_BYTES + 10).join('a') + '"}';
check('★ 超过 MAX_BYTES 直接不解析（不给「截一段看看」留口子）', Cfg.parse(big).ok === false);
const dup = Cfg.parse(rows([{ id: 500, name: '先来的一条' }, { id: 500, name: '后到的一条' }]));
check('★ 重复 id 先出现的赢（顺序固定 = 结果固定，不然两次同步来回改名）',
  dup.names['500'] === '先来的一条', dup.names['500']);
const CTRL = '带' + String.fromCharCode(1) + '脏';
const dirty = Cfg.parse(rows([
  { id: 501, name: CTRL }, { id: 502, name: 'x'.repeat(Cfg.NAME_MAX + 1) },
  { id: 'abc', name: '非法 id' }, { id: 503, name: '<script>' },
  { id: 504, name: '  首尾空白要 trim 掉  ' }, { id: 505, name: '正常的一条' },
  { id: 506, name: null }, { id: null, name: '没 id' }
]));
check('★ 夹控制字符 / 超长 / 尖括号 / 非法 id / 空值：一律整条不学',
  dirty.ok === true && dirty.names['501'] === undefined &&
  dirty.names['502'] === undefined && dirty.names['abc'] === undefined &&
  dirty.names['503'] === undefined && dirty.names['506'] === undefined,
  '条数 ' + dirty.count + ' ' + JSON.stringify(dirty.names));
check('★ 首尾空白 trim 掉，正文一个字不改（洗白 = 我们替官方编地名）',
  dirty.names['504'] === '首尾空白要 trim 掉', JSON.stringify(dirty.names['504']));
check('★ 一条都不剩时不许回 ok:true + 空表',
  Cfg.parse(rows([{ id: 501, name: CTRL }])).ok === false);
const many = rows(Array.from({ length: Cfg.MAX_NAMES + 60 }, function (x, i) {
  return { id: 10000 + i, name: '合成图' + i };
}));
check('★ 条数上限生效（官方哪天塞进几千条也不会把本机字典撑爆）',
  Cfg.parse(many).count === Cfg.MAX_NAMES, Cfg.parse(many).count);

/* ---------------- C 学名层 ---------------- */
console.log('\n[C] core/maps.js 的学名层：内置表一个字不改，学来的只补空位');
const r1 = Maps.applyExtra(P.names);
check('★★ 整份配置表合并进来：内置 72 条不动、本机只多内置缺的那些',
  Maps.mapNameCounts().builtin === 72 && Maps.mapNameCounts().learned === extra.length,
  JSON.stringify(Maps.mapNameCounts()));
check('★ applyExtra 报的 added 与合并后的总数自洽', r1.added === extra.length && r1.total === extra.length,
  JSON.stringify(r1));
Maps.applyExtra({ '34': '篡改内置表', '262': '篡改已学的' });
check('★ 内置表永远优先：想改 34 改不动', Maps.nameOf(34) === '烬区-占领', Maps.nameOf(34));
check('★ 已学的 id 也不许第二次改写（先来先赢）',
  Maps.nameOf(262) === '摩格旧城区-占领', Maps.nameOf(262));
check('★ 未知 id 仍旧是那句一眼看得出的兜底（不许猜、不许伪装成正常地名）',
  Maps.nameOf(999999) === '未知地图 · id 999999' && Maps.isKnownMap(999999) === false);
check('★ 名字来源分得清：builtin / learned / 空',
  Maps.nameSource('34') === 'builtin' && Maps.nameSource('262') === 'learned' &&
  Maps.nameSource(999999) === '', [Maps.nameSource('34'), Maps.nameSource('262'),
    Maps.nameSource(999999)].join('/'));
const r2 = Maps.applyExtra({ '777': '新图-胜者为王', '778': '带' + String.fromCharCode(1) + '脏',
  bad: '非法 id', '779': 'x'.repeat(60), '780': 42 });
check('★ 这一层自己也验一遍（库里的字典与导入包都是不可信输入）',
  Maps.nameOf(777) === '新图-胜者为王' && !Maps.isKnownMap(778) && !Maps.isKnownMap(779) &&
  !Maps.isKnownMap(780) && !Maps.isKnownMap('bad') && r2.added === 1, JSON.stringify(r2));
check('★★ 名字里带「胜者为王」的学进来就算胜者为王（新图不用改代码）',
  Maps.isSWWR(777, 3) === true && Maps.isSWWR(262, 3) === false);
Maps.clearExtra();
check('★ clearExtra 之后回到出厂状态（本套自己不许把脏留给别人）',
  Maps.mapNameCounts().learned === 0 && Maps.nameOf(262) === '未知地图 · id 262');

/* ---------------- D 历史场次改名 ---------------- */
console.log('\n[D] 学到名字之后：库里那些「未知地图」跟着改名（走 core 里那条既有清算）');
function memStore(state) {
  let saved = state;
  const s = new StoreMod.Store({
    load: function () { return saved; },
    save: function (x) { saved = x; return Promise.resolve(); }
  });
  return s;
}
const st = memStore(null);
st.state.meta.openid = '12345678';
st.state.matches = {
  r1: { room_id: 'r1', map_id: 262, map_name: '未知地图 · id 262', start_time: 1, game_rule: 3 },
  r2: { room_id: 'r2', map_id: 959, map_name: '未知地图 · id 959', start_time: 2, game_rule: 10 },
  r3: { room_id: 'r3', map_id: 34, map_name: '陈旧的老名字', start_time: 3, game_rule: 3 },
  r4: { room_id: 'r4', map_id: 888888, map_name: '别人包里带来的真名', start_time: 4, game_rule: 3 }
};
check('★ unknownMaps 是唯一的度量：262 / 959 / 888888 三场认不出',
  st.unknownMaps() === 3, st.unknownMaps());
check('★ bundleView 不带 map_names —— 字典是全机那一份，不跟着号库走',
  st.bundleView().map_names === undefined, Object.keys(st.bundleView()).join(','));

/* D 段要 await，E 段与总结跟在它后面 —— 整段收尾放进这一个 async 函数，
 * 否则异步那几条会打在总结之后（看不见、也不影响 exit 码，等于白测） */
async function main() {
  await st.save();
  check('★ 还没学名字时先 save 一次：三行原样不动（不许我们替官方编）',
    st.state.matches.r1.map_name === '未知地图 · id 262' &&
    st.state.matches.r4.map_name === '别人包里带来的真名');
  /* ★ 这一段是整件事的重点：学到名字之后，只需要 Maps 认得这个 id，
   *   store 里那条既有清算就会把**已经存在库里的历史场次**一起改名 —— 不写第二套回填逻辑。 */
  Maps.applyExtra({ '262': P.names['262'], '959': P.names['959'] });
  await st.save();
  check('★★ 更新完地图名，库里那两把新图的历史场次立刻跟着改名（他选的「立即重算」）',
    st.state.matches.r1.map_name === '摩格旧城区-占领' &&
    st.state.matches.r2.map_name === '烬区-焦点' && st.unknownMaps() === 1,
    st.state.matches.r1.map_name + ' / ' + st.state.matches.r2.map_name);
  check('★ 内置 id 的陈旧值也在同一次清算里刷对（这条是老规矩，不许被新功能碰坏）',
    st.state.matches.r3.map_name === '烬区-占领', st.state.matches.r3.map_name);
  check('★★ 坑 19 那条守卫还在：id 认不出、名字是导入包带来的真名 ⇒ 一律不动',
    st.state.matches.r4.map_name === '别人包里带来的真名', st.state.matches.r4.map_name);
  /* 载入方（桌面 boot / 安卓 kick）把字典推进 core 之后，load 里那次 prune 才会用它 */
  Maps.clearExtra();
  await st.load();
  check('★ 字典哪天丢了也不会把好名字抹回兜底：认不出 id 时那条守卫不动真名（坑 19 的另一面）',
    st.state.matches.r1.map_name === '摩格旧城区-占领' &&
    st.state.matches.r2.map_name === '烬区-焦点' &&
    st.state.matches.r4.map_name === '别人包里带来的真名' && st.unknownMaps() === 3,
    st.state.matches.r1.map_name + ' unknown=' + st.unknownMaps());
  Maps.applyExtra(P.names);
  await st.load();
  check('★★ installMapNames → load：整份配置表都在时，四行里只有那把真不认识的还是兜底',
    st.state.matches.r1.map_name === '摩格旧城区-占领' &&
    st.state.matches.r2.map_name === '烬区-焦点' && st.unknownMaps() === 1,
    'unknownMaps=' + st.unknownMaps());
  Maps.clearExtra();

  /* ---------------- E 触发口径：两端静态红线 ---------------- */
  console.log('\n[E] 「首次自动一次 + 之后全手动」—— 这是钦定口径，钉住在两端');
  const mainSrc = read('shell/main.js');
  const shimSrc = read('android/js/df-android.js');
  const javaSrc = read('android/app/src/main/java/com/df/battleanalyzer/DfBridge.java');
  const preloadSrc = read('shell/preload.js');
  const uiSrc = read('ui/js/app.js');
  const htmlSrc = read('ui/index.html');
  const hits = function (src, re) { return (src.match(re) || []).length; };
  /** 从某个记号起截到下一个分节注释（宁可截宽一点，也别用会漏的紧正则） */
  const sliceTo = function (src, from, to) {
    const i = src.indexOf(from);
    if (i < 0) return '';
    const j = src.indexOf(to, i + from.length);
    return src.slice(i, j < 0 ? i + 4000 : j);
  };

  /* ★ 这一条是整个需求的核心：他明确说过「不需要同步时自动拉」 */
  const syncBody = sliceTo(mainSrc, 'function runSync(', '/* ---------------- 全局设置');
  check('★★ 桌面：同步流程里一个字都不提地图名（每同步一次就打一发 CDN，是他不要的）',
    syncBody.length > 500 && !/MapNames/.test(syncBody), 'runSync 正文 ' + syncBody.length + ' 字');
  check('★★ 安卓：同样 —— runSync 里不许捎带这一发',
    !/MapNames/.test(sliceTo(shimSrc, 'function runSync(', '/* ------------------------------------------------ df：')),
    'runSync 正文 ' + sliceTo(shimSrc, 'function runSync(', '/* ------------------------------------------------ df：').length + ' 字');
  check('★ 桌面：自动那一发的定义 + 唯一一处调用点（多一处就是有人加了第二个自动时机）',
    hits(mainSrc, /autoPullMapNames/g) === 2, '出现 ' + hits(mainSrc, /autoPullMapNames/g) + ' 次');
  check('★ 安卓：同上', hits(shimSrc, /autoPullMapNames/g) === 2,
    '出现 ' + hits(shimSrc, /autoPullMapNames/g) + ' 次');
  const autoMain = sliceTo(mainSrc, 'function autoPullMapNames', '\n}\n');
  check('★★ 自动那一发自己带着两道护栏：SELFTEST 下不许真出网 + 判据只能是 core 那颗 dueToRefresh',
    /SELFTEST/.test(autoMain) && /--live-sync/.test(autoMain) &&
    /MapConfig\.dueToRefresh\(/.test(autoMain), autoMain.replace(/\s+/g, ' ').slice(0, 160));
  check('★★ 那把"该不该自动取"的尺只有一处实现（两端都调 core，谁都不许自己算 24 小时）',
    /function dueToRefresh/.test(read('core/mapConfig.js')) &&
    !/24\s*\*\s*60\s*\*\s*60/.test(mainSrc) && !/86400000/.test(mainSrc) &&
    !/24\s*\*\s*60\s*\*\s*60/.test(shimSrc) && !/86400000/.test(shimSrc),
    '桌面自己算=86400000 在 main.js:' + /86400000/.test(mainSrc));
  check('★ 手动那条路只有设置页这一颗按钮（定义 + IPC + 自动出口 = 三处，多一处就是有人加了第二个自动时机）',
    hits(mainSrc, /requestMapNamesPull\(/g) === 3 && hits(shimSrc, /requestMapNamesPull\(/g) === 3,
    '桌面 ' + hits(mainSrc, /requestMapNamesPull\(/g) + ' 安卓 ' + hits(shimSrc, /requestMapNamesPull\(/g));
  const pullBody = sliceTo(mainSrc, 'async function pullMapNames', '\n}\n');
  check('★★ 桌面这一发不带登录态：新建、用完就丢的空 cookie 罐，且不碰采集那个 net 适配器',
    /PluginNet\.createJar\(\)/.test(pullBody) && !/createNetAdapter/.test(pullBody) &&
    !/[Cc]ookie/.test(pullBody), pullBody.slice(0, 60).replace(/\s+/g, ' '));
  check('★ 这一发的域名清单只有一条，就是 mapConfig 里那台 host',
    /allowlist: \[MapConfig\.HOST\]/.test(pullBody), 'allowlist 只填 HOST');

  /* 域名唯一出处：JS 那一份是口径，Java 那一份是第二道锁 —— 两处必须逐字相等 */
  const HOST_RE = /jsonschema\.qpic\.cn/;
  const hostFiles = ['core/mapConfig.js', 'shell/main.js', 'ui/js/app.js', 'ui/index.html',
    'android/js/df-android.js', 'android/js/plugin-host.js', 'shell/preload.js',
    'android/app/src/main/java/com/df/battleanalyzer/DfBridge.java',
    'android/app/src/main/java/com/df/battleanalyzer/PluginNet.java'].filter(function (rel) {
      return HOST_RE.test(read(rel));
    });
  check('★★ 那台 CDN 的名字在源码里只许出现两处：口径（mapConfig）+ 第二道锁（DfBridge）',
    hostFiles.length === 2 && hostFiles[0] === 'core/mapConfig.js' &&
    /DfBridge\.java$/.test(hostFiles[1]), hostFiles.join(' , '));
  const javaHost = (/MAP_HOST = "([^"]+)"/.exec(javaSrc) || [])[1] || '';
  check('★★ 两处主机名逐字相等（不等就是 Java 那道锁跟着 JS 一起飘了）',
    javaHost === Cfg.HOST && Cfg.URL.indexOf('https://' + Cfg.HOST + '/') === 0,
    'java=' + javaHost + ' js=' + Cfg.HOST);
  check('★ Java 那一侧的锁是真锁：只许 https://HOST/、方法写死 GET、jar 传空 ⇒ 带不出 cookie',
    /url\.startsWith\("https:\/\/" \+ MAP_HOST \+ "\/"\)/.test(javaSrc) &&
    /PluginNet\.request\(url, "GET", new JSONObject\(\), ""/.test(javaSrc));
  check('★ 通道表里确实多了这一条（少一条 = 手机端那颗按钮点了没反应）',
    /"cfg\.mapNames"\.equals\(channel\)/.test(javaSrc));

  /* 界面上那颗按钮：桌面与安卓共用同一份 ui/，所以这一条同时管两端 */
  check('★★ 设置页有状态行与那颗按钮（少了按钮，"之后全手动"就无处可点）',
    /id="btnMapNamesRefresh"/.test(htmlSrc) && /id="mapNamesText"/.test(htmlSrc) &&
    /btnMapNamesRefresh/.test(uiSrc) && /df\.mapNames\.refresh\(\)/.test(uiSrc));
  check('★ 界面不认识那个地址（URL 只住在 core/mapConfig.js，界面连域名都不该看见）',
    !/qpic|jsonschema|http/.test(sliceTo(htmlSrc, 'id="mapNamesText"', '</div>')),
    sliceTo(htmlSrc, 'id="mapNamesText"', '</div>').replace(/\s+/g, ' ').slice(0, 80));
  check('★ 两端事件白名单都有 mapNames:done（自动那一发落地后要能刷界面）',
    /'mapNames:done'/.test(preloadSrc) && /'mapNames:done'/.test(shimSrc));
  check('★ 界面那行说明写清了口径：打开会取、超过一天才会再自动取',
    /打开软件时会自动取一次/.test(htmlSrc) && /超过一天才会再自动取/.test(htmlSrc));
  check('★ 那句「数据只保存在本机，不会上传任何服务器」一个字没改（新功能只是匿名取一次公开字典）',
    /<p>数据只保存在本机，不会上传任何服务器<\/p>/.test(htmlSrc) &&
    /你的战绩始终只保存在本机，不会上传任何服务器/.test(htmlSrc));

  /* 导出包带上字典（他批准的），而导入这一路不许占用「首次自动」那颗判据 */
  check('★★ 导出带 map_names、导入收 map_names：桌面与安卓两处都有',
    /map_names: \(mapNamesRecord\(\)/.test(mainSrc) && /if \(bundle\.map_names\) learnMapNames/.test(mainSrc) &&
    /view\.map_names = \(mapNamesRecord\(\)/.test(shimSrc) && /if \(bundle\.map_names\) learnMapNames/.test(shimSrc));
  check('★★ 导入带进来的名字不许把 mapNames.at 顶成非 0 —— 否则首次那一发就永远不发了',
    /learnMapNames\(bundle\.map_names\)/.test(mainSrc) && /learnMapNames\(bundle\.map_names\)/.test(shimSrc));

  /* ---------------- F 使用者那一层（#92）：改名 + 本机字典 ---------------- */
  console.log('\n[F] 使用者自己起的名字：压过内置、「更新地图名」盖不掉、且不参与任何统计口径');
  Maps.applyExtra({ '262': P.names['262'] });
  const u1 = Maps.setUserName('262', '我家门口的图');
  check('★★ 改一张已学 id 的名字：显示层立刻听使用者的',
    Maps.nameOf(262) === '我家门口的图' && u1.applied === 1 && Maps.nameSource('262') === 'user',
    JSON.stringify(u1) + ' -> ' + Maps.nameOf(262));
  check('★ 「不改的话本来叫什么」当场报得出 —— 界面那颗「还原」要说的就是这句',
    Maps.nameWithoutUser(262) === '摩格旧城区-占领', Maps.nameWithoutUser(262));
  /* ★★ 下面两组各钉一道闸门。上一版这两条都没钉住，是变异桩 M1/M2 报「没咬住」才暴露的：
   *   ① 要量"压过**内置表**"，就得挑一个真在内置那份抓包表里的 id —— 262 只在本机学的层里，
   *      拿它试内置优先，等于把 M1 那针让过去了；
   *   ② 要量"更新地图名盖不掉"，就得挑一个**还没进 EXTRA** 的 id —— 否则先撞上的是"先来先赢"
   *      那道闸，USER 那道闸摘没摘都照样 added=0，那句断言就成了自证。 */
  const uB = Maps.setUserName('34', '我叫它自建图');
  check('★★★ 使用者这一层压过内置表（34 就在内置那份实证表里，改得动才算数）',
    uB.applied === 1 && Maps.nameOf(34) === '我叫它自建图' && Maps.nameSource('34') === 'user' &&
    Maps.nameWithoutUser(34) === '烬区-占领',
    Maps.nameOf(34) + ' / 本来叫 ' + Maps.nameWithoutUser(34));
  Maps.clearUserName('34');
  check('★ 撤销这一条之后立刻回到内置那份（"还原"不是清成空名字）',
    Maps.nameOf(34) === '烬区-占领' && Maps.nameSource('34') === 'builtin', Maps.nameOf(34));
  Maps.setUserName('707070', '我起的');
  const stomped = Maps.applyExtra({ '707070': '官方哪天改的名' });
  check('★★★ 「更新地图名」盖不掉它：本机学名那层一条都不许加（挑没进 EXTRA 的 id 才量得到这一道闸）',
    stomped.added === 0 && Maps.extraNames()['707070'] === undefined &&
    Maps.nameOf(707070) === '我起的' &&
    Maps.nameWithoutUser(707070) === '未知地图 · id 707070',
    JSON.stringify(stomped) + ' 学名层里=' + JSON.stringify(Maps.extraNames()['707070']));
  Maps.clearUserName('707070');
  check('★★ 未知地图能被编辑成想要的名字（他点名的就是这条）：isKnownMap 当场转真',
    Maps.setUserName('999999', '这把我不认识的图').applied === 1 &&
    Maps.nameOf(999999) === '这把我不认识的图' && Maps.isKnownMap(999999) === true &&
    Maps.nameSource('999999') === 'user', Maps.nameOf(999999));
  check('★ 还原不是抹成兜底：清掉这一条就回到本来叫什么（内置/学到的那个）',
    Maps.clearUserName('262').cleared === 1 && Maps.nameOf(262) === '摩格旧城区-占领' &&
    Maps.nameSource('262') === 'learned', Maps.nameOf(262));
  check('★ 本来就不认识的编号，还原之后回到那句一眼看得出的兜底（不许留一个空名字）',
    Maps.clearUserName('999999').cleared === 1 && Maps.isKnownMap(999999) === false &&
    Maps.nameOf(999999) === '未知地图 · id 999999', Maps.nameOf(999999));
  check('★★ 脏输入整条不要（与学名同一把尺，不截断、不洗控制字符）：尖括号 / 41 字 / 控制符 / 非法编号',
    Maps.setUserName('300', '<script>alert(1)</script>').ignored === 1 && !Maps.isKnownMap(300) &&
    Maps.setUserName('301', 'x'.repeat(41)).ignored === 1 &&
    Maps.setUserName('302', '带' + String.fromCharCode(0) + '控制符').ignored === 1 &&
    Maps.setUserName('abc', '非法编号').ignored === 1 && !Maps.isKnownMap('abc'),
    [Maps.isKnownMap(300), Maps.isKnownMap(301), Maps.isKnownMap(302)].join(','));
  check('★ 一字未改不算「应用」、纯空白算「撤销」、撤销第二次就不许再报一遍',
    Maps.setUserName('707070', '第一回').applied === 1 &&
    Maps.setUserName('707070', '第一回').applied === 0 &&
    Maps.setUserName('707070', '   ').cleared === 1 &&
    Maps.setUserName('707070', '').cleared === 0 && !Maps.isKnownMap(707070),
    Maps.nameOf(707070));
  check('★★ 名字不参与统计口径：把一张常规图改名成「胜者为王…」，它照样不是胜者为王',
    Maps.setUserName('34', '胜者为王-我编的').applied === 1 &&
    Maps.isSWWR(34, 3) === false && Maps.isCommander(34) === false &&
    Maps.isCommanderUnit(34) === false, Maps.nameOf(34));
  Maps.clearUserName(34);
  Maps.setUserName('262', '甲');
  Maps.setUserName('999999', '乙');
  const dict = Maps.nameDict();
  check('★ nameDict 三层各归各（不许把「我改的」并进内置那一份），且 user 每行都带着 base',
    dict.builtin.length === 72 && dict.user.length === 2 &&
    dict.user.every(function (x) { return !!x.base && x.source === 'user'; }),
    JSON.stringify(dict.user));
  check('★ 计数口径：user 那一档就是当前挂着的条数，clearUser 之后回 0',
    Maps.mapNameCounts().user === 2 && Maps.userNames()['262'] === '甲' &&
    (Maps.clearUser(), Maps.mapNameCounts().user === 0 && Maps.nameOf(262) === '摩格旧城区-占领'),
    JSON.stringify(Maps.mapNameCounts()));

  /* 库里那些场次跟着改名 + mapUsage 那份「打过的图」（设置页那块就看它）。
   * ★ 这一张刻意只改 999999：262 保持"本机学到"，这样 usage 里两种来源都在，
   *   也能顺便证明"我给另一张图起名"不会把 262 那行的名字顺手改掉。 */
  Maps.setUserName('999999', '乙');
  const stF = memStore(null);
  stF.state.meta.openid = 'f-slot';
  stF.state.matches = {
    a: { room_id: 'a', map_id: 262, map_name: '摩格旧城区-占领', start_time: 1, game_rule: 7 },
    b: { room_id: 'b', map_id: 999999, map_name: '未知地图 · id 999999', start_time: 2, game_rule: 7 },
    c: { room_id: 'c', map_id: 999999, map_name: '未知地图 · id 999999', start_time: 3, game_rule: 8 }
  };
  const usageBefore = stF.mapUsage();
  check('★ mapUsage：打过的每张图一行，带「名字哪来的」与场次，按场次倒序',
    usageBefore.length === 2 && usageBefore[0].id === '999999' && usageBefore[0].count === 2 &&
    usageBefore[0].source === 'user' && usageBefore[1].source === 'learned' &&
    usageBefore[0].name === '乙' && usageBefore[1].name === '摩格旧城区-占领',
    JSON.stringify(usageBefore));
  check('★ 名字改了，但库里那两行的 map_name 还是旧的 —— 落地口只有 save 里那一次清算（不许界面自己回填）',
    stF.unknownMaps() === 0 && stF.state.matches.b.map_name === '未知地图 · id 999999',
    'unknown=' + stF.unknownMaps() + ' b=' + stF.state.matches.b.map_name);
  await stF.save();
  check('★★ 把未知地图编辑成想要的名字之后：库里那些场次当场就有名字了（走 core 那条既有清算，不写第二套回填）',
    stF.state.matches.b.map_name === '乙' && stF.state.matches.c.map_name === '乙' &&
    stF.unknownMaps() === 0,
    [stF.state.matches.a.map_name, stF.state.matches.b.map_name].join(' / '));
  /* ★ 反方向 prune 够不着：还原是让 id 重新变回"认不出"，那条清算只在认得出时才动手 ——
   *   不补 rollbackMapName 这一刀，界面就会一边显示我自己起的假名字、一边报"还有 2 场认不出地名"。 */
  Maps.clearUserName('999999');
  const back = stF.rollbackMapName('999999', '乙');
  check('★★ 还原那半边：正显示着「乙」的两场退回兜底，"认不出"的计数回到真话',
    back === 2 && stF.state.matches.b.map_name === '未知地图 · id 999999' &&
    stF.state.matches.c.map_name === '未知地图 · id 999999' && stF.unknownMaps() === 2,
    '退回 ' + back + ' 场 / unknown=' + stF.unknownMaps());
  check('★ 还原没伤到别的：那张本机学到的（262）还是一个字不动',
    stF.state.matches.a.map_name === '摩格旧城区-占领', stF.state.matches.a.map_name);
  await stF.save();
  check('★ 退回兜底之后 prune 也不会再把它改回那个假名字（id 认不出 ⇒ 那条守卫不动它）',
    stF.state.matches.b.map_name === '未知地图 · id 999999' && stF.unknownMaps() === 2,
    stF.state.matches.b.map_name);

  Maps.setUserName('777777', '丙');
  const stG = memStore(null);
  stG.state.meta.openid = 'g-slot';
  stG.state.matches = {
    p: { room_id: 'p', map_id: 777777, map_name: '丙', start_time: 1, game_rule: 7 },
    q: { room_id: 'q', map_id: 777777, map_name: '别人包里的真名', start_time: 2, game_rule: 7 }
  };
  Maps.clearUserName('777777');
  check('★★ rollback 只动「名字正好等于我撤掉的那一个」的场次：别人包里带来的真名一个字都不碰（坑 19 同一道闸）',
    stG.rollbackMapName(777777, '丙') === 1 &&
    stG.state.matches.p.map_name === '未知地图 · id 777777' &&
    stG.state.matches.q.map_name === '别人包里的真名',
    stG.state.matches.p.map_name + ' / ' + stG.state.matches.q.map_name);
  Maps.clearUser();
  Maps.clearExtra();

  /* ---------------- G 本机字典这条链路的接缝：三处生产者同形 ---------------- */
  console.log('\n[G] #92 这条链路：字典查看/编辑的接缝在桌面、安卓、预览层三处必须同形');
  const viewsSrc = read('ui/js/views.js');
  const mockSrc = read('test/mock-df.js');
  const prevSrc = read('test/preview-server.js');
  check('★★ 桌面与安卓各有一条「改名」出口 + 一条「看字典」出口（少一条 = 那颗按钮在这台设备上点了没反应）',
    /ipcMain\.handle\('mapNames:dict'/.test(mainSrc) && /ipcMain\.handle\('mapNames:setName'/.test(mainSrc) &&
    /dict: function \(\) \{ return Promise\.resolve\(mapNamesDict\(\)\); \}/.test(shimSrc) &&
    /setName: function \(payload\)/.test(shimSrc));
  check('★★ 三个生产者都转发这两条：preload（桌面）、mock-df（预览层）、安卓 df 桥',
    /dict: \(\) => ipcRenderer\.invoke\('mapNames:dict'\)/.test(preloadSrc) &&
    /setName: \(payload\) => ipcRenderer\.invoke\('mapNames:setName', payload\)/.test(preloadSrc) &&
    /dict: function \(\) \{ return get\('\/mock\/mapNames\/dict'\); \}/.test(mockSrc) &&
    /setName: function \(p\) \{ return post\('\/mock\/mapNames\/setName', p \|\| \{\}\); \}/.test(mockSrc));
  check('★ 预览层那两条路由在（缺一条，布局探针与设备桩量到的就是"问不到本机字典"）',
    /p === '\/mock\/mapNames\/dict'/.test(prevSrc) && /p === '\/mock\/mapNames\/setName'/.test(prevSrc));
  check('★★ 落盘那三处每次都带着 userNames：globalSettings.mapNames 写几次，userNames 就出现几次',
    hits(mainSrc, /globalSettings\.mapNames = \{/g) === hits(mainSrc, /userNames: Maps\.userNames\(\)/g) &&
    hits(shimSrc, /globalSettings\.mapNames = \{/g) === hits(shimSrc, /userNames: Core\.Maps\.userNames\(\)/g) &&
    hits(mainSrc, /userNames: Maps\.userNames\(\)/g) >= 3,
    '桌面 ' + hits(mainSrc, /userNames: Maps\.userNames\(\)/g) + ' 安卓 ' +
    hits(shimSrc, /userNames: Core\.Maps\.userNames\(\)/g));
  check('★★ boot 时两层都推给 core（只装学到的那份，重启后"我改的"就悄悄没了）',
    /if \(rec\.userNames\) Maps\.applyUser\(rec\.userNames\)/.test(mainSrc) &&
    /if \(rec\.userNames\) Core\.Maps\.applyUser\(rec\.userNames\)/.test(shimSrc));
  check('★★ 导出包带 map_names_user、导入收 map_names_user：两端都有，且都不许顶 mapNames.at',
    /map_names_user: \(mapNamesRecord\(\)/.test(mainSrc) &&
    /if \(bundle\.map_names_user\) learnUserNames/.test(mainSrc) &&
    /view\.map_names_user = \(mapNamesRecord\(\)/.test(shimSrc) &&
    /if \(bundle\.map_names_user\) learnUserNames/.test(shimSrc) &&
    !/learnUserNames\(bundle\.map_names_user\), Date\.now/.test(mainSrc + shimSrc));
  check('★ learnUserNames 自己不写 at（它是"收别人包"的那条路，不是"取到过配置表"）',
    /at: \(rec && rec\.at\) \|\| 0/.test(sliceTo(mainSrc, 'function learnUserNames', '\n}\n')) &&
    !/Date\.now\(\)/.test(sliceTo(mainSrc, 'function learnUserNames', '\n}\n')));
  check('★★ 界面上这一套是真接上了：按钮、盒子、取字典、改名四颗都在（红线钉"函数存在"不等于钉"接线"）',
    /id="btnMapDict"/.test(htmlSrc) && /id="mapDictBox"/.test(htmlSrc) &&
    /df\.mapNames\.dict\(\)/.test(uiSrc) && /df\.mapNames\.setName\(/.test(uiSrc) &&
    /global\.DFViews\.mapDictHtml\(d\)/.test(uiSrc) && /mapDictHtml: mapDictHtml/.test(viewsSrc) &&
    /dictMapId/.test(viewsSrc) && /dictSave/.test(viewsSrc));
  check('★★ 改名这条不许依赖系统对话框：Electron 渲染进程根本没有 prompt()',
    !/\.prompt\(/.test(uiSrc) && !/window\.prompt/.test(viewsSrc));
  check('★ 判据只有一处：界面自己不再验编号、也不再抄那句 40 字/尖括号的规定',
    !/\\\\d\{1,8\}/.test(uiSrc) && !/NAME_MAX|超过 40 字/.test(uiSrc) &&
    /超过 40 字/.test(mainSrc) && /超过 40 字/.test(shimSrc),
    '界面抄了一份就是两个判据源');
  check('★ 还原这件事由 core 补那一刀（prune 只在 id 认得出时改名，那是结构性的够不着）',
    /Store\.prototype\.rollbackMapName = function/.test(read('core/store.js')) &&
    /store\.rollbackMapName\(target, wasName\)/.test(mainSrc) &&
    /store\.rollbackMapName\(target, wasName\)/.test(shimSrc) &&
    /s\.rollbackMapName\(target, wasName\)/.test(prevSrc));

  console.log('\n' + '='.repeat(60));
  console.log(fail === 0 ? '地图名：全部通过' : fail + ' 项失败');
  console.log('='.repeat(60));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('测试台自己炸了：' + ((e && e.stack) || e));
  process.exit(2);
});
