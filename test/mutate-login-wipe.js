'use strict';
/* 变异检查（「开登录窗 = 全新会话」这一族红线，安卓 + 桌面两头）：
 * 逐条把实现改回坏的样子，确认断言真的会红。跑完自动还原；跑法 node test/mutate-login-wipe.js
 * ★ 桌面那几条（M21~M30）里钉的 API 名字不是凭印象写的，是在 Electron 33.4.11 上真量出来的：
 *   tools/probe-desktop-session-wipe.js（同一课的起因是上一轮 Java 那三个不存在的方法名）。 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const R = f => path.join(__dirname, '..', f);
const FILES = [
  'android/app/src/main/java/com/df/battleanalyzer/LoginActivity.java',
  'android/app/src/main/java/com/df/battleanalyzer/DfBridge.java',
  'android/app/src/main/java/com/df/battleanalyzer/MainActivity.java',
  'android/js/df-android.js',
  'core/collector.js',
  'shell/main.js',
  'ui/js/app.js'
];
const bak = {};
FILES.forEach(f => { bak[f] = fs.readFileSync(R(f), 'utf8'); });
function restore() { FILES.forEach(f => fs.writeFileSync(R(f), bak[f])); }
/* 打在**当前**内容上，所以一个变异里可以连打几针 */
function patch(file, from, to) {
  const src = fs.readFileSync(R(file), 'utf8');
  if (src.indexOf(from) === -1) throw new Error('锚点没找到: ' + file + ' :: ' + from.slice(0, 46));
  fs.writeFileSync(R(file), src.split(from).join(to));
}
function runSuite(which) {
  const file = which === 'core' ? 'core.test.js' : 'android-shim.test.js';
  return cp.spawnSync(process.execPath, [path.join(__dirname, file)],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 << 20 }).stdout || '';
}

const LA = 'android/app/src/main/java/com/df/battleanalyzer/LoginActivity.java';
const SHIM = 'android/js/df-android.js';
const CORE = 'core/collector.js';
const MUT = [
  ['M1 wipeSession 挪到 loadUrl 之后（第一屏还是旧会话）', 'android', () => {
    patch(LA, '        wipeSession(web);\n', '');
    patch(LA, 'web.loadUrl(LOGIN_URL);', 'web.loadUrl(LOGIN_URL);\n        wipeSession(web);');
  }],
  ['M2 wipeSession 少清一样（不清 DOM/local storage）', 'android', () => patch(
    LA, '        WebStorage.getInstance().deleteAllData();', '')],
  ['M3 别处多一处清 cookie（主界面 onCreate）', 'android', () => patch(
    'android/app/src/main/java/com/df/battleanalyzer/MainActivity.java',
    'CookieManager.getInstance().flush();',
    'CookieManager.getInstance().removeAllCookies(null); CookieManager.getInstance().flush();')],
  ['M4 重开窗不停旧表（两张 setInterval 叠着跑）', 'android', () => patch(
    SHIM, '    stopPolling();\n    pollSlot = slot || \'\';', '    pollSlot = slot || \'\';')],
  ['M5 真原生不回 cleared（界面那句成谎话）', 'android', () => patch(
    'android/app/src/main/java/com/df/battleanalyzer/DfBridge.java', '.put("cleared", true)', '')],
  ['M6 界面不看 cleared 就喊「已清掉痕迹」', 'android', () => patch(
    'ui/js/app.js', 'if (r && r.cleared) {', 'if (true) {')],
  ['M7 界面不排 core 那句 advice（永远只喊"再等等"）', 'android', () => patch(
    'ui/js/app.js', 'if (e.advice) {', 'if (false && e.advice) {')],
  ['M8 迟到的旧会话回包照样落号（代号守卫被删）', 'android', () => patch(
    SHIM, '        if (seq !== pollSeq) return;\n', '')],
  ['M9 stopPolling 不加代号（清得掉表，清不掉在路上那一发）', 'android', () => patch(
    SHIM, '    pollSeq++;\n', '')],
  ['M10 core 登录成功不清连问旧账', 'core', () => patch(
    CORE, '        self.setAccountType(t);\n        self.noRoleRounds = 0;',
    '        self.setAccountType(t);')],
  ['M11 core 阈值比较写成 >（永远差一轮）', 'core', () => patch(
    CORE, 'self.noRoleRounds >= PROBE_NO_ROLE_ROUNDS', 'self.noRoleRounds > PROBE_NO_ROLE_ROUNDS + 20')],
  ['M12 桌面 shell 漏转 advice（手机端有那句话、电脑上永远没有）', 'android', () => patch(
    'shell/main.js', "rounds: r.rounds || 0, advice: r.advice || ''", "rounds: r.rounds || 0")],
  ['M13 安卓 shell 漏转 rounds/advice', 'android', () => patch(
    SHIM, "rounds: r.rounds || 0, advice: r.advice || '',\n", '')],
  /* E7 这一族：读不出来 ≠ 没有数据 */
  ['M14 战绩库的写闸被拆（读不出来照样盖上去）', 'android', () => patch(
    SHIM, "        var blocked = writeBlocked(name);\n        if (blocked) return Promise.resolve(blocked);\n", '')],
  ['M15 注册表的写闸被拆（拿内存里那份空表盖掉 accounts.json）', 'android', () => patch(
    SHIM, "    var blocked = writeBlocked(ACCT_FILE);\n    if (blocked) return Promise.resolve(blocked);\n", '')],
  ['M16 「读不出来」重新被当成「缺文件」', 'android', () => patch(
    SHIM, "      if (r.ok === false) return { fault: String(r.error || '读不出来') };",
    "      if (r.ok === false) return { missing: true };")],
  ['M17 定论之前不再重问一次（瞬态被当成坏盘）', 'android', () => patch(
    SHIM, '      return readOnce(name).then(function (r2) {',
    '      return Promise.resolve(r).then(function (r2) {')],
  ['M18 Java 与假原生之间 missing 这条回包形状漂移', 'android', () => patch(
    'android/app/src/main/java/com/df/battleanalyzer/DfBridge.java',
    'return "{\\"text\\":null,\\"missing\\":true}";', 'return "{\\"text\\":null}";')],
  ['M19 开机那一发不等装配（今天真机那条"没号、跳不过"就是这么来的）', 'android', () => patch(
    SHIM, '  df.boot = function () {\n' +
      '    return Promise.resolve(global.__dfReady).then(function () { return bootRaw(); });\n' +
      '  };',
    '  df.boot = function () { return bootRaw(); };')],
  ['M20 开窗那句"本机文件读不动"不再看 storageFault（装了个永远不响的警）', 'android', () => patch(
    'ui/js/app.js', "(r.storageFault ? '。但本机有文件这次没读动（原因见上），别卸载重装' : '')",
    "'。但本机有文件这次没读动（原因见上），别卸载重装'")],
  /* ===== E9 这一族：桌面「开登录窗 = 这个号的全新会话」（使用者裁定 2026-09-26 翻过来的）===== */
  ['M21 桌面先加载后清理（第一屏还是那半死会话，清了也白清）', 'android', () => patch(
    'shell/main.js',
    '  return wipeLoginSession(session, loginWin.webContents).then(function (res) {\n' +
    '    loginWin.loadURL(WEGAME_HOME);\n    startLoginWatch(probeCollector, partition);',
    '  loginWin.loadURL(WEGAME_HOME);\n' +
    '  return wipeLoginSession(session, loginWin.webContents).then(function (res) {\n' +
    '    startLoginWatch(probeCollector, partition);')],
  ['M22 桌面清理名单里少了 IndexedDB（官方那页往里存东西，少一样就是没清干净）', 'android', () => patch(
    'shell/main.js', "'indexdb', ", '')],
  ['M31 桌面清理名单里少了 cookie（这一族存在的理由就是那一罐 cookie）', 'android', () => patch(
    "shell/main.js", "'appcache', 'cookies',", "'appcache',")],
  ['M23 会话历史写成 ses.clearHistory()（这版 Electron 的 Session 上没这个方法）', 'android', () => patch(
    'shell/main.js', 'webContents.clearHistory();', 'ses.clearHistory();')],
  ['M24 往 storage 名单里塞 "history" 冒充（实测那是不被识别的名字，静悄悄忽略）', 'android', () => patch(
    'shell/main.js', "var LOGIN_WIPE_STORAGES = ['appcache', 'cookies',",
    "var LOGIN_WIPE_STORAGES = ['history', 'appcache', 'cookies',")],
  ['M25 login:open 退回写死 {ok:true}（把 cleared 吞在主线上，界面那句成谎话）', 'android', () => patch(
    'shell/main.js', '    return openLoginWindow(targetSlot);',
    '    openLoginWindow(targetSlot);\n    return { ok: true };')],
  ['M26 同步那一步也来一发整套清理（"仅限打开登录浏览器"这条被破）', 'android', () => patch(
    'shell/main.js',
    "ipcMain.handle('sync:run', function (evt, opts) { return runSync(opts || {}); });",
    "ipcMain.handle('sync:run', function (evt, opts) {\n" +
    "    var s = require('electron').session.fromPartition(partitionFor(accounts.activeSlot));\n" +
    "    wipeLoginSession(s, null);\n    return runSync(opts || {});\n  });")],
  ['M27 开窗把所有号的罐子一起清（别的号被静悄悄登出）', 'android', () => patch(
    'shell/main.js', '  return wipeLoginSession(session, loginWin.webContents).then',
    "  accounts.accounts.forEach(function (a) {\n" +
    "    require('electron').session.fromPartition(a.partition).clearStorageData({ storages: ['cookies'] });\n" +
    "  });\n  return wipeLoginSession(session, loginWin.webContents).then")],
  ['M28 清不干净时界面不再改口（挂着"已打开登录窗口"等人自己发现）', 'android', () => patch(
    'ui/js/app.js', '} else if (r && r.clearError) {', '} else if (false) {')],
  ['M29 某一步失败了照样报 cleared:true（把"清干净"判据写死）', 'android', () => patch(
    'shell/main.js', 'return { cleared: failed.length === 0,', 'return { cleared: true,')],
  ['M30 换号还复用那扇窗（分区在创建时就钉死了，拿着 A 的窗清 B 的罐）', 'android', () => patch(
    'shell/main.js', 'loginWin.__dfSlot !== slot', 'false')]
];

/* 可以挑着跑：`node test/mutate-login-wipe.js M2,M7`（整套 20 条要十几分钟，改完一条锚点想单验它不值得全等） */
const ONLY = (process.argv[2] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const SELECTED = ONLY.length ? MUT.filter(m => ONLY.some(id => m[0].toUpperCase().startsWith(id + ' '))) : MUT;
if (!SELECTED.length) { console.log('一条都没匹配上：' + ONLY.join(',')); process.exit(1); }

/* 只验锚点、不跑套件：DF_ANCHOR_AUDIT=1 node test/mutate-login-wipe.js
 * 锚点抄在第二处（那台审计工具）必然漂移 —— O15 就漂过一次，工具说"全在"、真跑说"打不上"。
 * 所以锚点清单只留这一份，审计改成现读现打。 */
if (process.env.DF_ANCHOR_AUDIT === '1') {
  let bad = 0;
  SELECTED.forEach(function (m) {
    restore();
    try { (m[2] || m[1])(); console.log('  锚点在 ' + m[0]); }
    catch (e) { bad++; console.log('  !!! ' + m[0] + ' → ' + e.message); }
  });
  restore();
  console.log('mutate-login-wipe：' + (bad ? bad + ' 针打不上' : '锚点全在'));
  process.exit(bad ? 1 : 0);
}

SELECTED.forEach(function (m) {
  restore();
  try {
    m[2]();
    const fails = runSuite(m[1]).split('\n').filter(l => /FAIL/.test(l)).map(l => l.trim().slice(0, 78));
    console.log('\n' + m[0] + ' → ' + (fails.length ? 'RED ' + fails.length + ' 条' : '!!! 没变红 !!!'));
    fails.slice(0, 4).forEach(l => console.log('      ' + l));
  } catch (e) {
    console.log('\n' + m[0] + ' → 变异没打上：' + e.message);
  }
});
restore();
['core', 'android'].forEach(function (which) {
  const out = runSuite(which);
  console.log('\n还原后（' + which + '）：' + (/全部通过/.test(out) ? '全部通过' :
    '仍有 FAIL：' + out.split('\n').filter(l => /FAIL/.test(l)).join(' | ')));
});
