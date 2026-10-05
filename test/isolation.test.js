'use strict';
/* isolation.test.js — 出厂交付物里到底有没有"往外发战绩"的代码、有没有内置 AI 的痕迹
 * 运行：node test/isolation.test.js
 *
 * 这条断言不是"功能没接线"，而是**那些字符串压根不在交付物里**。
 * 战队同步的能力全部住在 plugins-src/ 里，由使用者自己导入；
 * 宿主只认识抽象的 net.request，不知道世界上存在 /api/stats/upload 这个接口。
 * 一旦被谁顺手往 core / shell / ui 里塞了站点专用的代码，这里就该红。
 * v1.7.0 起同一条口径管第二件事：AI 分析也是一份由用户自己导入的插件，
 * 所以服务商品牌、协议记号、那句确认、那颗导航，都不许留在出厂树与界面里。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let fail = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail !== undefined ? '  -> ' + detail : ''}`);
}

/* 战队网站那套接口的专用记号：只允许出现在插件源码里 */
const FORBIDDEN = [
  /api\/stats\/upload/, /api\/stats\/my/, /api\/auth\/login/,
  /\bgame_pid\b/, /win_rate_last30/, /healing_per_match/, /best_match_kills/,
  /PHPSESSID/, /remember_me/, /stats_upload_limit/, /战队战绩同步/, /战绩信息/
];
/* 交付物里允许出现的地址：本机自测与文档里的示例域名 + 沙盘那一家 */
const HOST_OK = /^(127\.0\.0\.1|localhost|example\.com|evil\.example\.com|yoursite|aeuicey\.github\.io)$/i;

function walk(dir, base, out) {
  fs.readdirSync(dir).forEach(function (name) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name.charAt(0) === '.') return;
      walk(p, base, out);
    } else out.push({ abs: p, rel: base ? base + '/' + name : name });
  });
  return out;
}
function scan(files, label) {
  const hits = [];
  files.forEach(function (f) {
    let text;
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch (e) { return; }
    FORBIDDEN.forEach(function (re) {
      if (re.test(text)) hits.push(f.rel + ' 里出现了 ' + String(re).replace(/^\/|\/$/g, ''));
    });
  });
  check('★ ' + label + '：不含任何战队站点专用记号', hits.length === 0, hits.slice(0, 6).join(' | ') || files.length + ' 个文件干净');
}
function hostLiterals(files, label) {
  const bad = [];
  files.forEach(function (f) {
    const text = fs.readFileSync(f.abs, 'utf8');
    (text.match(/https?:\/\/[A-Za-z0-9._-]+/g) || []).forEach(function (u) {
      const h = u.replace(/^https?:\/\//, '');
      if (h.indexOf('.') === -1) return;             // 注释里的占位写法（https://x/y）不算域名
      if (!HOST_OK.test(h)) bad.push(f.rel + ' → ' + u);
    });
  });
  check('★ ' + label + '：插件宿主里没有写死的第三方域名', bad.length === 0, bad.slice(0, 6).join(' | ') || '只有本机与示例域名');
}

const shipped = walk(path.join(ROOT, 'core'), 'core', [])
  .concat(walk(path.join(ROOT, 'shell'), 'shell', []))
  .concat(walk(path.join(ROOT, 'ui'), 'ui', []));
scan(shipped, '源码 core/ + shell/ + ui/');
hostLiterals(shipped.filter(function (f) {
  return /^(shell\/plugins\.js|shell\/plugin-api\.js|shell\/adapters\/plugin-net\.js|core\/plugin\.js|core\/zip\.js)$/.test(f.rel);
}), '插件宿主那几个文件');

/* 插件能力桥自己不许认识任何具体接口路径 */
const bridge = fs.readFileSync(path.join(ROOT, 'shell/plugin-api.js'), 'utf8') +
  fs.readFileSync(path.join(ROOT, 'shell/adapters/plugin-net.js'), 'utf8');
check('★ 能力桥里找不到 /api/ 这种具体接口路径', !/\/api\//.test(bridge));

/* ---------- v1.7.0：AI 分析不再是内置功能，出厂树与界面都要干净 ----------
 * 用户的原话是「软件不会内置 AI 功能，只是改为插件体系」，且选了「彻底无痕迹」：
 * 不留占位入口、不留 ai-* 钩子。所以这里既查文件在不在，也查界面上说没说。 */
const REMOVED = ['shell/adapters/ai.js', 'ui/js/aiMarkdown.js', 'test/ai-transport.test.js'];
check('★ 内置 AI 时代那几个文件已经不在源码树里',
  REMOVED.every(function (f) { return !fs.existsSync(path.join(ROOT, f)); }),
  REMOVED.filter(function (f) { return fs.existsSync(path.join(ROOT, f)); }).join(', '));

/* 交接说明允许写在注释里（"这一页已搬进插件包"是给下一个维护者看的），正文与代码里不许。
 * 所以先剥注释再扫：HTML/CSS 块注释 + JS 块注释 + 行注释（[^:] 兜住 https:// 这类串）。 */
function stripComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const uiSurface = ['ui/index.html', 'ui/css/app.css'].map(function (f) {
  return stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
}).join('\n') + '\n' + ['ui/js/app.js', 'ui/js/views.js', 'ui/js/charts.js', 'ui/js/theme.js', 'shell/preload.js']
  .map(function (f) { return stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8')); }).join('\n');
const UI_TRACE = [
  /AI ?分析/, /深度分析/, /服务商/, /大模型/, /API ?密钥/,
  /view-ai/, /navAi/, /btnGotoAi/, /aiStatusText/, /\bai-[a-z]/, /aiReports/, /ai-config/,
  /\bdf\.ai\b/, /\bai:\s*[\{(]/, /data-view="ai"/
];
const uiHits = [];
UI_TRACE.forEach(function (re) { if (re.test(uiSurface)) uiHits.push(String(re).replace(/^\/|\/$/g, '')); });
check('★ 界面与预加载脚本里没有任何内置 AI 的痕迹', uiHits.length === 0, uiHits.join(' | '));
const viewCount = (stripComments(fs.readFileSync(path.join(ROOT, 'ui/index.html'), 'utf8'))
  .match(/<section class="view/g) || []).length;
check('★ 出厂视图是 12 个（那颗 AI 导航真的没了）', viewCount === 12, 'views=' + viewCount);
check('★ 事件白名单里有插件通道、没有 ai:delta',
  /'plugin:evt'/.test(fs.readFileSync(path.join(ROOT, 'shell/preload.js'), 'utf8')) &&
  !/ai:delta/.test(fs.readFileSync(path.join(ROOT, 'shell/preload.js'), 'utf8')));

/* ★ 回归（2026-09-22 用户报）：「从全部模式切换到指挥官模式，正好指挥官模式没有数据而图表是空白的，
 *   然后再切换全部模式，则图表也会跟着空白」。根因是空数据分支用 container.innerHTML='' 清图 ——
 *   画布被摘走而 ECharts 实例还留在登记表里，下次 setOption 全画进一个游离节点，图就永久空白。
 *   渲染层没有 DOM 测试台，所以这里钉三条静态红线（行为侧是浏览器里逐页量过的：五页 13 张图）。 */
const chartsSrc = stripComments(fs.readFileSync(path.join(ROOT, 'ui/js/charts.js'), 'utf8'));
const viewsSrc = stripComments(fs.readFileSync(path.join(ROOT, 'ui/js/views.js'), 'utf8'));
check('★ charts.js 会自愈：容器被清空或整块换掉时，旧实例必须丢掉重开而不是复用',
  /function drop\(/.test(chartsSrc) && /getDom\(\)\s*!==\s*el/.test(chartsSrc) &&
  /firstElementChild/.test(chartsSrc));
check('★ 视图层一次都不直接取图表容器的 DOM（要清就交给 DFCharts.clear）',
  !/el\(\s*['"]ch[A-Z]/.test(viewsSrc) && !/getElementById\(\s*['"]ch[A-Z]/.test(viewsSrc));
check('★ 六处空数据分支都在走 clearCharts（少一处就是有人退回只清画布的写法）',
  (viewsSrc.match(/clearCharts\(\[/g) || []).length === 6,
  'clearCharts 调用处=' + (viewsSrc.match(/clearCharts\(\[/g) || []).length);

/* ★ 外发确认面板的两条红线（同一批用户反馈）：
 *   ① 切到另一个插件，面板上写的还是上一个的名字和那句确认话 —— pluginPageShow 换了 pluginCur 却没重画；
 *   ② 面板原先固定占掉插件页近一半高度。收成一行可以，但「撤销允许」必须留在看得见那一行 ——
 *      收起来就找不到撤销，那等于把闸门藏了（和「只藏起按钮不算锁」是同一条规矩的两面）。 */
const appSrc = stripComments(fs.readFileSync(path.join(ROOT, 'ui/js/app.js'), 'utf8'));
const gateMarkup = stripComments(fs.readFileSync(path.join(ROOT, 'ui/index.html'), 'utf8'));
check('★ 换了当前插件一定重画外发面板（面板不许停在上一个插件的文案上）',
  /function pluginPageShow\(\)[\s\S]{0,900}?pluginConsentRender\(\)/.test(appSrc) &&
  /btnPluginGateToggle/.test(appSrc));
check('★ 「撤销允许」长在折叠那一行里（排在正文之前），收成一行也点得到',
  gateMarkup.indexOf('class="gate-bar"') >= 0 &&
  gateMarkup.indexOf('btnPluginConsentRevoke') > gateMarkup.indexOf('class="gate-bar"') &&
  gateMarkup.indexOf('btnPluginConsentRevoke') < gateMarkup.indexOf('id="pluginConsentBody"'));

/* 服务商品牌与协议记号：整棵出厂树都不许认识它们，它们只能待在插件包里 */
const BRANDS = [/deepseek/i, /\bopenai\b/i, /chat\/completions/, /text\/event-stream/,
  /bigmodel|智谱|\bglm\b/i, /moonshot|kimi|月之暗面/i, /dashscope|通义|\bqwen\b/i,
  /openrouter/i, /anthropic|\bclaude\b|gemini|\bollama\b|\bgroq\b/i];
const brandHits = [];
shipped.forEach(function (f) {
  let text;
  try { text = fs.readFileSync(f.abs, 'utf8'); } catch (e) { return; }
  BRANDS.forEach(function (re) {
    if (re.test(text)) brandHits.push(f.rel + ' → ' + String(re).replace(/^\/|\/$/g, ''));
  });
});
check('★ 出厂树里没有任何服务商品牌与协议记号', brandHits.length === 0, brandHits.slice(0, 6).join(' | '));
const aiPkg = fs.readFileSync(path.join(ROOT, 'plugins-src/ai-analyst/main.js'), 'utf8');
check('★ 这些知识确实写在用户自行导入的包里（预设域名 / 补全接口 / SSE 解析）',
  /api\.deepseek\.com/.test(aiPkg) && /chat\/completions/.test(aiPkg) && /text\/event-stream/.test(aiPkg));

/* ★ 宿主即使长出了外发闸门，也不许认识任何"服务商语汇" ——
 *   将来 AI 以插件形式进来时，prompt / messages / usage 这些只能待在包里。 */
const PROVIDER_WORDS = ['chat/completions', 'messages', 'completion', 'prompt', 'usage', 'apiKey', 'model'];
const hostPlugFiles = ['shell/plugin-api.js', 'shell/adapters/plugin-net.js', 'shell/plugins.js', 'core/plugin.js'];
const providerHits = [];
hostPlugFiles.forEach(function (rel) {
  const t = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  PROVIDER_WORDS.forEach(function (w) {
    if (new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(t)) {
      providerHits.push(rel + ' → ' + w);
    }
  });
});
check('★ 插件宿主的四个文件里没有任何服务商语汇', providerHits.length === 0, providerHits.slice(0, 6).join(' | '));
check('★ 宿主不内置确认句（那句只来自清单，改了就得重新导包）',
  !/我已确认|consentText\s*=\s*['"]/.test(hostPlugFiles.map(function (r) {
    return fs.readFileSync(path.join(ROOT, r), 'utf8');
  }).join('\n')));
const BASE_CSS_REL = 'ui/css/plugin-base.css';
check('★ 插件版式词汇表在源码树里且非空',
  fs.existsSync(path.join(ROOT, BASE_CSS_REL)) &&
  fs.readFileSync(path.join(ROOT, BASE_CSS_REL), 'utf8').indexOf('.pl-cols') !== -1);

const DIST_APP = (function () {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) return '';
  const hit = fs.readdirSync(dist).filter(function (n) {
    try { return fs.statSync(path.join(dist, n)).isDirectory(); } catch (e) { return false; }
  }).map(function (n) { return path.join(dist, n, 'resources', 'app'); })
    .filter(function (p) { return fs.existsSync(p); })[0];
  return hit || '';
})();
if (DIST_APP) {
  const distFiles = walk(DIST_APP, '', []);
  scan(distFiles, '交付包 resources/app');
  check('★ 交付包里没有 plugins-src / plugins-dist',
    !distFiles.some(function (f) { return /plugins-(src|dist)/.test(f.rel); }));
  check('★ 交付包里不带任何 .zip 插件包', !distFiles.some(function (f) { return /\.zip$/i.test(f.rel); }));
  check('★ 交付包里没有 .cookies.json（登录凭证不该被打包）',
    !distFiles.some(function (f) { return /\.cookies\.json$/i.test(f.rel); }));
  check('★ 交付包里有插件版式词汇表（缺了它插件页会是裸 HTML，而测试看不见）',
    distFiles.some(function (f) { return /(^|\/)plugin-base\.css$/.test(f.rel); }));
  check('★ 交付包里没有内置 AI 的那两个文件',
    !distFiles.some(function (f) { return /(^|\/)(adapters\/ai|aiMarkdown)\.js$/.test(f.rel); }),
    distFiles.filter(function (f) { return /(^|\/)(adapters\/ai|aiMarkdown)\.js$/.test(f.rel); })
      .map(function (f) { return f.rel; }).join(', '));
  const distIndex = distFiles.filter(function (f) { return /(^|\/)index\.html$/.test(f.rel); })[0];
  if (distIndex) {
    const dh = stripComments(fs.readFileSync(distIndex.abs, 'utf8'));
    check('★ 交付包界面里没有 AI 入口（view-ai / navAi 都不在，视图 12 个）',
      !/view-ai|navAi/.test(dh) && (dh.match(/<section class="view/g) || []).length === 12,
      'views=' + (dh.match(/<section class="view/g) || []).length);
  }
  const distProvider = [];
  distFiles.filter(function (f) {
    return /(^|\/)(plugin-api|plugin-net|plugins|plugin)\.js$/.test(f.rel);
  }).forEach(function (f) {
    const t = fs.readFileSync(f.abs, 'utf8');
    PROVIDER_WORDS.forEach(function (w) {
      if (new RegExp('\\b' + w + '\\b').test(t)) distProvider.push(f.rel + ' → ' + w);
    });
  });
  check('★ 交付包里的插件宿主同样不认识服务商语汇', distProvider.length === 0, distProvider.slice(0, 4).join(' | '));
  const pkgJson = path.join(DIST_APP, 'package.json');
  if (fs.existsSync(pkgJson)) {
    const v = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version;
    check('交付包版本号与仓库 package.json 一致',
      v === JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, v);
  }
} else {
  console.log('  SKIP  还没打包（dist/resources/app 不存在），先跑 node build.js 再复验');
}

/* 插件源码这一侧：确认能力真的写在插件里，而不是宿主替它写 */
const ts = fs.readFileSync(path.join(ROOT, 'plugins-src/team-stats/main.js'), 'utf8');
check('战队同步的接口路径只出现在插件源码里',
  FORBIDDEN.slice(0, 3).every(function (re) { return re.test(ts); }));
check('★ 插件正文里没有 fs / require / process（沙箱里也给不到）',
  !/\brequire\s*\(/.test(ts) && !/\bprocess\./.test(ts) && !/\bfs\./.test(ts));
check('★ 插件不出网：没有 fetch / XMLHttpRequest / WebSocket',
  !/\bfetch\s*\(/.test(ts) && !/XMLHttpRequest/.test(ts) && !/WebSocket/.test(ts));

/* ★ v1.8.0 六项深度分析的接线红线：判定源必须只有一份，就在 core。
 *   界面每多长出一句"这差别不大"，同一个数字就可能在两个页面给出两个结论。 */
const aiSrc = fs.readFileSync(path.join(ROOT, 'plugins-src/ai-analyst/main.js'), 'utf8');
check('★ 五块新面板都照抄 core 的 headline（界面不自己下判定）',
  (viewsSrc.match(/\.headline/g) || []).length >= 5,
  'headline 引用处=' + (viewsSrc.match(/\.headline/g) || []).length);
check('★ 渲染层不长出第二套统计判断（没有 p 值、没有自己划的效应量门槛）',
  !/p\s*[<>=]\s*0?\.\d/.test(viewsSrc) && !/significan/i.test(viewsSrc) &&
  !/0\.8[^0-9%].{0,40}0\.5.{0,40}0\.2/.test(viewsSrc));
const wrTdN = (viewsSrc.match(/wrTd\(/g) || []).length - 1;   // 减掉定义那一处
check('★ 分组胜率一律走 wrTd（自带 95% 区间与可靠性档位）', wrTdN >= 8, 'wrTd 调用处=' + wrTdN);
check('★ 四块新面板在出厂 HTML 里有容器（内容现算，容器必须先在）',
  ['winLossPanel', 'structurePanel', 'durPanel', 'strengthPanel'].every(function (id) {
    return new RegExp('id="' + id + '"').test(gateMarkup);
  }));
const consentFn = /function pluginConsentRender\(\)[\s\S]*?\n  }/.exec(appSrc);
check('★ 宿主画闸门时一定把状态推给沙箱页（不然插件页那句提示停在旧结论）',
  !!consentFn && /pluginPushGateEvent\(/.test(consentFn[0]));
check('★ 两个参考插件都订阅 gate 事件（收到就重新问一次 host.info）',
  /'gate'/.test(ts) && /'gate'/.test(aiSrc),
  'team-stats=' + (ts.match(/'gate'/g) || []).length + ' ai-analyst=' + (aiSrc.match(/'gate'/g) || []).length);

/* ★ 竖屏改造的红线（安卓那一版要用的就是这份 ui/，所以规矩在这里钉住，不在手机上重做一遍）：
 *   用户的原话是「内容UI都保持不变 但是就布局上UI调整」—— 藏内容换来的窄屏不算适配。 */
const cssSrc = fs.readFileSync(path.join(ROOT, 'ui/css/app.css'), 'utf8');
check('★ 抽屉的开关与遮罩在出厂 HTML 里（竖屏下这是唯一的导航入口）',
  /id="btnNavDrawer"/.test(gateMarkup) && /id="navScrim"/.test(gateMarkup));
check('★ 换页一定把抽屉收回去（不然它盖在内容上回不来）',
  /function switchView\([\s\S]{0,160}?setNavDrawer\(false\)/.test(appSrc));
check('★ 900 那一档里抽屉靠 body.nav-open 推开，宽屏上开关完全不存在',
  /body\.nav-open \.sidebar \{ transform: none;/.test(cssSrc) &&
  /\.nav-drawer-btn, \.nav-scrim \{ display: none; \}/.test(cssSrc));
const mqPhone = /@media \(max-width: 900px\) \{([\s\S]*)$/.exec(cssSrc);
const hiddenSel = [];
if (mqPhone) {
  const rules = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = rules.exec(mqPhone[1]))) {
    if (/display:\s*none/.test(m[2])) hiddenSel.push(m[1].replace(/\s+/g, ' ').trim());
  }
}
check('★★ 竖屏那一节唯一允许被藏起来的是全局筛选控件（且只在不吃筛选的三页），内容一块都不许少',
  hiddenSel.length === 1 && /\.fb-group/.test(hiddenSel[0]) &&
  /\.fb-spacer/.test(hiddenSel[0]) && /\.fb-count/.test(hiddenSel[0]) &&
  /bare-view/.test(hiddenSel[0]),
  hiddenSel.join(' 或 ') || '（这一节里没有任何 display:none）');

console.log('\n' + '='.repeat(64));
console.log(fail === 0 ? '隔离性：全部通过' : fail + ' 项失败');
console.log('='.repeat(64));
process.exit(fail === 0 ? 0 : 1);
