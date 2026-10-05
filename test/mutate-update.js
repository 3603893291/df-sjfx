'use strict';
/* 变异桩（v1.8.2 这一族：在线更新 + 装机计数 + 地图名每天自动取）。
 * 每条把实现改回"坏的样子"，确认 update.test.js / map-names.test.js 里那些红线真会红；跑完自动还原。
 *
 * ★ 这一族最险的三条，都不是"算错了"，而是"悄悄多做了事"：
 *   ① 那一发多带一个参数（&name=昵称）—— 程序照跑、界面照新，只有隐私承诺被吃掉；
 *   ② 软件开始"自己装"（plan 里多一档 hot / 界面冒出「立即更新」）—— 他 2026-09-30 明确不要；
 *   ③ 计数判据坏掉（每次都 +1，或者记了档没落盘）—— 他那个人数从此不可信。
 *   这三条都要"打上桩就报红"，不能只靠我看代码。
 * 单跑几针：node test/mutate-update.js U1,U8
 * ★ 这套脚本会改源码再还原 —— 一次只准跑一套，别跟别的变异桩或编辑并行
 *   （要并行就用 tools/run-mutations-parallel.sh，它给每套一份副本）。 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const R = f => path.join(__dirname, '..', f);
const FILES = ['core/update.js', 'shell/main.js', 'ui/js/app.js', 'ui/index.html',
  'android/js/df-android.js', 'test/preview-server.js'];
const bak = {};
FILES.forEach(f => { bak[f] = fs.readFileSync(R(f), 'utf8'); });
function restore() { FILES.forEach(f => fs.writeFileSync(R(f), bak[f])); }
function patch(file, from, to) {
  const src = fs.readFileSync(R(file), 'utf8');
  if (src.indexOf(from) === -1) throw new Error('锚点没找到: ' + file + ' :: ' + from.slice(0, 52));
  fs.writeFileSync(R(file), src.split(from).join(to));
}
function run(suite) {
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, suite)],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 << 20 });
  const out = r.stdout || '';
  const fails = out.split('\n').filter(l => /^ *FAIL /.test(l)).map(l => l.trim().slice(0, 96));
  /* 跑不起来 / 跑完却没总结行 ⇒ 一律算"没测到"，绝不当通过 */
  if (r.error || r.status === null || !/全部通过|项失败|测试异常/.test(out)) {
    return ['!! 套件没跑完（status=' + r.status + ' err=' + (r.error && r.error.message) +
      ' 尾部=' + out.slice(-140).replace(/\s+/g, ' ') + '!!'];
  }
  return fails;
}
function both() { return run('update.test.js').concat(run('map-names.test.js')); }

const UP = 'core/update.js', MJ = 'shell/main.js', AP = 'ui/js/app.js', HT = 'ui/index.html',
  AD = 'android/js/df-android.js', PV = 'test/preview-server.js';

const MUT = [
  ['U1 参数名白名单放开（谁都能往那一发上加 &name=昵称 / &openid=号，程序照跑）', () => patch(
    UP, "      if (!ALLOW_PARAMS[kv[0]]) return false;", "      if (!kv[0]) return false;")],
  ['U2 sec 允许任意值（那枚计数参数变成免费的昵称通道）', () => patch(
    UP, "      if (kv[0] === 'sec') { if (val !== '' && val !== SEC_FIRST) return false; continue; }",
      "      if (kv[0] === 'sec') continue;")],
  ['U3 值里的长数字不再算标识（openid / 设备号就这么混进 v= 里）', () => patch(
    UP, "      if (/\\d{7,}/.test(val)) return false;", "      ;")],
  ['U4 下载地址收 http（明文下载一个可执行整包）', () => patch(
    UP, "    if (!s || s.indexOf('https://') !== 0) return '';", "    if (!s) return '';")],
  ['U5 计划里多出"我自己装"这一档（他明确不要的那一步）', () => patch(
    UP, "      action: 'hint', latest: manifest.version, m: manifest,",
      "      action: 'hot', latest: manifest.version, m: manifest,")],
  ['U6 回包问坏了也念"已经是最新版本"（问不到 ≠ 没更新）', () => patch(
    UP, "      return { action: 'none', reason: (manifest && manifest.error) || '没查到版本信息' };",
      "      return { action: 'none', reason: '已经是最新版本' };")],
  ['U7 版本比较退化成字符串比（1.10.0 被当成比 1.9.0 旧）', () => patch(
    UP, "      n = (Number(x[i]) || 0) - (Number(y[i]) || 0);",
      "      n = String(x[i] || '').localeCompare(String(y[i] || ''));")],
  ['U8 计数判据坏成"每次都算没报过"（他那台服务器一个人被数 N 次）', () => patch(
    UP, "  function shouldSend(rec) { return !(rec && Number(rec.at)); }",
      "  function shouldSend(rec) { return true; }")],
  ['U9 记了档没落盘（内存里知道报过，重启就再报一次）', () => patch(
    MJ, "  accounts.globalSettings.startup = Update.markSent(Date.now());\n  saveAccountsSync();",
      "  accounts.globalSettings.startup = Update.markSent(Date.now());")],
  ['U10 桌面这一发不再用当场新建的空 cookie 罐（把登录态带出去）', () => patch(
    MJ, "      jar: PluginNet.createJar(), timeout: 10000, maxText: Update.MAX_TEXT",
      "      jar: PluginNet.createJar(sessionCookieDump()), timeout: 10000, maxText: Update.MAX_TEXT")],
  ['U11 域名清单放开（allowlist 交空表 ⇒ 那一发可以被领到任何站）', () => patch(
    MJ, "      url: target, method: 'GET', allowlist: [Update.HOST],",
      "      url: target, method: 'GET', allowlist: [],")],
  ['U12 判据搬回主进程自己算 24 小时（第二把尺，两端迟早不一样）', () => patch(
    MJ, "    if (!MapConfig.dueToRefresh(at, Date.now())) return;",
      "    if (at && Date.now() - at < 24 * 60 * 60 * 1000) return;")],
  ['U13 界面认识那个域名（渲染层开始自己拼出网地址）', () => patch(
    AP, "  function loadUpdate() {", "  function loadUpdate() {\n    var UPD_HOST = 'dpx1' + '.icu';")],
  ['U14 界面上那颗"立即更新"的按钮被加了回来（软件承诺不动他的文件）', () => patch(
    HT, "<button class=\"btn\" id=\"btnUpdCheck\">重新检查</button>",
      "<button class=\"btn\" id=\"btnUpdCheck\">重新检查</button>\n            <button class=\"btn\" id=\"btnUpdApply\">立即更新</button>")],
  ['U15 安卓那一发去掉 markSent 落盘（手机上每台机器每次启动都 +1）', () => patch(
    AD, "        accounts.globalSettings.startup = Core.Update.markSent(Date.now());\n        saveAccounts();",
      "        accounts.globalSettings.startup = Core.Update.markSent(Date.now());")],
  ['U16 地图名那句说明改回"之后不再自动取"（口径写在代码里、话却说的是另一件）', () => patch(
    HT, "打开软件时会自动取一次，<b>距上次成功取表超过一天才会再自动取</b>",
      "首次使用软件会自动取一次，<b>之后不再自动取</b>")],
  ['U17 界面那行状态不去问宿主（自己画一个空状态 ⇒ 那一台上永远"正在检查"）', () => patch(
    AP, "    global.df.update.status().then(renderUpdate)", "    renderUpdate({})")],
  ['U18 桌面这一发开始顺手写盘（"只问一句"变成"还会动文件"）', () => patch(
    MJ, "  if (info.firstReport && httpOk) markStartupReported();",
      "  if (info.firstReport && httpOk) markStartupReported();\n  try { require('fs').writeFileSync(require('path').join(userDataDir(), 'update-state.json'), JSON.stringify(updateState)); } catch (e) {}")],
  ['U19 自检模式漏了闸门（--selftest 也真出网 ⇒ npm test 看那台服务器的脸色）', () => patch(
    MJ, "    if (SELFTEST && !process.argv.includes('--live-sync')) return;\n    checkForUpdate();",
      "    checkForUpdate();")],
  ['U20 检查地址不合法也照发（core 那两道判据成了摆设）', () => patch(
    MJ, "  if (!Update.okUrl(target) || !Update.noUserIdentity(target)) {",
      "  if (false) {")],
  ['U21 桌面把版本号拼进 platform（值里的枚举闸白设 ⇒ 服务器上按平台分组从此乱）', () => patch(
    MJ, "    platform: 'win', version: Plg.HOST_VERSION,",
      "    platform: 'win' + Plg.HOST_VERSION, version: Plg.HOST_VERSION,")],
  ['U22 预览层那颗 status 路由被搬走（三处生产者少一处 ⇒ 只有那台设备上界面永远"正在检查"）', () => patch(
    PV, "      if (p === '/mock/update/status') return jsonr(updateStatus());",
      "      if (p === '/mock/update/nothing') return jsonr(updateStatus());")],
  ['U23 安卓把 HTTP 状态码从失败话里丢掉（404 与别的都念成一个「?」⇒ 排查又得从头猜）', () => patch(
    AD, "        updateState.error = (r && r.error)\n          ? ('问不到：' + r.error)\n          : ('问不到（HTTP ' + ((r && r.status) || '?') + '）');",
      "        updateState.error = '问不到：' + ((r && r.error) || '?');")],
  /* ★ U24 / U25 钉的是 2026-09-30 真机路径上量到的那个坏样子：自动那一发跑完了，
   *   宿主 checked:true、error 已是「问不到（HTTP 404）」，界面那一行还停在「还没检查过。」。
   *   当时的形状是 `if (!o.quiet) emit(...)` + autoCheckUpdate 带着 quiet —— 推这一件事被参数关掉了。 */
  ['U24 桌面自动那一发跑完不告诉界面（那行停在「还没检查过。」，功能等于没做）', () => patch(
    MJ, "function pushUpdateState() { emit('update:status', Object.assign({}, updateState)); }",
      "function pushUpdateState() { /* 只有点了按钮才推 */ }")],
  ['U25 安卓只在"查到新版"那一条出路推（问坏了界面同样不更新，与桌面各自演化）', () => patch(
    AD, "    }).then(pushUpdateState);", "    });")]
];

const audit = process.env.DF_ANCHOR_AUDIT === '1';
const arg = (process.argv[2] || '').trim();
const SELECTED = (!audit && arg && arg !== 'all')
  ? MUT.filter(m => arg.split(',').indexOf(m[0].split(' ')[0]) >= 0) : MUT;

if (audit) {
  let bad = 0;
  SELECTED.forEach(m => {
    restore();
    try { m[1](); console.log('  锚点在 ' + m[0]); }
    catch (e) { bad++; console.log('  !!! ' + m[0] + ' → ' + e.message); }
  });
  restore();
  console.log('mutate-update：' + (bad ? bad + ' 针打不上' : '锚点全在'));
  process.exit(bad ? 1 : 0);
}

SELECTED.forEach(function (m) {
  restore();
  try {
    m[1]();
    const fails = both();
    console.log('\n' + m[0] + ' → ' + (fails.length ? 'RED ' + fails.length + ' 条' : '!!! 没变红 !!!'));
    fails.slice(0, 3).forEach(l => console.log('      ' + l));
  } catch (e) {
    console.log('\n' + m[0] + ' → 变异没打上：' + e.message);
  }
});
restore();
const left = both();
console.log('\n还原后：' + (left.length ? '仍有 FAIL：' + left.join(' | ') : '更新 + 地图名 两套全部通过'));
