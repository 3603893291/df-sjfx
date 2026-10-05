'use strict';
/* update.test.js — 在线更新 + 装机计数（2026-09-30 那两条）
 * 运行：node test/update.test.js
 *
 * 这一族最要紧的三件事，全部有断言钉着：
 *   ① 那一发**不带任何用户内容**（只 app/platform/v/sec 四个名字，值里不许有长数字）；
 *   ② 软件**不代他下载安装**：判据只有 none / hint 两态，界面也不许出现"我帮你装好了"那种句式；
 *   ③ 桌面 / 安卓 / 预览层 三处生产者同形（少一处，只有那一台设备上那颗按钮是死的）。
 * 七段：A 判据 / B 回包 / C 谁新 / D 计划 / E 三处同形 / F 出网形状与静态红线 / G 计数
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Update = require('../core/update');

const Cfg = require('../core/mapConfig');
const Plg = require('../core/plugin');
let fail = 0;
function check(name, ok, detail) {
  const good = !!ok;
  if (!good) fail++;
  console.log(`${good ? '  PASS' : '  FAIL'}  ${name}${detail !== undefined ? '  -> ' + detail : ''}`);
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/* ---------------- A 判据：这一发长什么样 ---------------- */
console.log('\n[A] 请求的形状：四个参数名，一个用户内容都不许多');
const u1 = Update.url('win', '1.8.2', true);
const u2 = Update.url('android', '0.17-android', false);
check('★ 第一次那一发带上 sec=启动软件（服务器就靠这个 +1）',
  u1.indexOf('sec=' + encodeURIComponent('启动软件')) > 0, u1);
check('★ 以后那一发 sec 留空：还是同一发，只问版本不再计数',
  /&sec=$/.test(u2), u2);
check('★ 只走 https + 那一台服务器 + 那个路径',
  u1.indexOf('https://app.dpx1.icu/admin/app/update?') === 0, u1.slice(0, 46));
check('★ okUrl 认这一串，拒 http / 换 host / 换路径 / 带账号信息',
  Update.okUrl(u1) && !Update.okUrl(u1.replace('https', 'http')) &&
  !Update.okUrl('https://evil.example.com/admin/app/update?app=df-swtwr') &&
  !Update.okUrl('https://app.dpx1.icu/other?x=1') &&
  !Update.okUrl('https://app.dpx1.icu@evil.example.com/admin/app/update?x=1'));
check('★★ noUserIdentity：四个名字之外一个都不许有（name / nick / openid / uid 当场拒）',
  Update.noUserIdentity(u1) && Update.noUserIdentity(u2) &&
  !Update.noUserIdentity(u1 + '&name=%E5%BC%A0%E4%B8%89') &&
  !Update.noUserIdentity(u1 + '&openid=o1234567890abcdef') &&
  !Update.noUserIdentity(u1 + '&uid=297922384') &&
  !Update.noUserIdentity('https://app.dpx1.icu/admin/app/update?app=df-swtwr&platform=win&v=1.8.2&device=abc'));
check('★★ 值里也不许藏标识：v 或 platform 塞一枚长数字就拒（版本号本身是点分短段，不受影响）',
  Update.noUserIdentity(Update.url('win', '1.8.2', false)) &&
  !Update.noUserIdentity(Update.url('win', '1.8.2.297922384', false)) &&
  !Update.noUserIdentity('https://app.dpx1.icu/admin/app/update?app=df-swtwr&platform=o123456789012&v=1.8.2&sec='));
check('★ sec 只许是"启动软件"或空，别的值一律拒（防的是把这一枚当免费昵称通道）',
  !Update.noUserIdentity('https://app.dpx1.icu/admin/app/update?app=df-swtwr&platform=win&v=1.8.2&sec=%E5%BC%A0%E4%B8%89'));
check('★ 名字认了还要认值：platform 只许那两个枚举，app 只许那一个应用号（拼接出来的版本号当场拒）',
  Update.noUserIdentity(Update.url('android', '1.8.2', false)) &&
  !Update.noUserIdentity(Update.url('win1.8.2', '1.8.2', false)) &&
  !Update.noUserIdentity(Update.url('', '1.8.2', false)) &&
  !Update.noUserIdentity('https://app.dpx1.icu/admin/app/update?app=other&platform=win&v=1.8.2&sec='));

/* ---------------- B 回包 ---------------- */
console.log('\n[B] 回包解析：坏一条整份作废，不半信半疑');
const good = JSON.stringify({ version: '1.9.0', url: 'https://app.dpx1.icu/dl/app.zip', notes: '修了什么', size: 115568084, force: 1 });
const pb = Update.parse(good);
check('★ 正常回包：版本 / 地址 / 说明 / 大小 / 强制都读得到',
  pb.ok && pb.version === '1.9.0' && pb.url.indexOf('https://') === 0 &&
  pb.notes === '修了什么' && pb.size === 115568084 && pb.force === 1, JSON.stringify(pb).slice(0, 90));
check('★ 版本号形状不对（2.0 / 带字母 / 空）整份作废',
  !Update.parse('{"version":"1.9"}').ok && !Update.parse('{"version":"1.9.0-beta"}').ok &&
  !Update.parse('{"version":""}').ok);
check('★★ 下载地址只认 https：http 明文下载一个可执行整包，直接不要（宁可不提示）',
  !Update.parse('{"version":"1.9.0","url":"http://app.dpx1.icu/a.zip"}').url &&
  !!Update.parse('{"version":"1.9.0","url":"https://some.host/a.zip"}').url);
check('★ 地址里带账号 / 空白 / 反斜杠的，一律算没有地址',
  !Update.cleanUrl('https://app.dpx1.icu@evil/a.zip') && !Update.cleanUrl('https://a b/x.zip') &&
  !Update.cleanUrl('https:\\\\evil\\a.zip') && !Update.cleanUrl('//evil/a.zip'));
check('★ 不是 JSON / 不是对象 / 空 / 超长 —— 四种都拒，且都给出为什么',
  !Update.parse('not json').ok && !Update.parse('[]').ok && !Update.parse('').ok &&
  !Update.parse('{"version":"1.9.0","notes":"' + 'x'.repeat(Update.MAX_TEXT) + '"}').ok);
check('★ 没给 url 时不算坏（只是"有新版本但没下载地址"），界面那句要能分开念',
  Update.parse('{"version":"1.9.0"}').ok && Update.parse('{"version":"1.9.0"}').url === '');

/* ---------------- C 版本比较 ---------------- */
console.log('\n[C] 谁算是新版本：全代码库只有这一颗 cmp');
check('★ 三段点分按数值比（不是字符串比大小）',
  Update.isNewer('1.8.2', '1.10.0') && !Update.isNewer('1.10.0', '1.8.2') &&
  !Update.isNewer('1.8.2', '1.8.2') && !Update.isNewer('1.8.2', '1.8.1'),
  '1.10 vs 1.8:' + Update.cmp('1.10.0', '1.8.2'));
check('★ 脏的版本串（空 / 缺段 / 非数字）不当新版本',
  !Update.isNewer('1.8.2', '') && Update.cmp('1.8', '1.8.0') === 0 && !Update.isNewer('1.8.2', 'x'));

/* ---------------- D 计划 ---------------- */
console.log('\n[D] 计划只有两态：不动、提示去下载。**没有"我自己装"这一档**');
const p1 = Update.plan(Update.parse(good), '1.8.2');
check('★ 有新版本 → hint（并带上要念的那一句与地址）',
  p1.action === 'hint' && p1.latest === '1.9.0' && !!p1.m.url, p1.action + ' / ' + p1.reason);
check('★ 已是最新 → none，且不会把"没查到"和"已最新"混成一回事',
  Update.plan(Update.parse(good), '9.9.9').action === 'none' &&
  Update.plan(Update.parse('{"version":"1.9.0"}'), '1.9.0').reason.indexOf('最新') >= 0);
check('★★ 坏回包 → none + 一句为什么（不许把"问坏了"念成"已是最新"）',
  (function () {
    const bad = Update.parse('bad');
    const p = Update.plan(bad, '1.8.2');
    return p.action === 'none' && !!p.reason && p.reason === bad.error && !/最新/.test(p.reason);
  })(), '那句为什么要把坏在哪念出来，而不是给一句好消息');
check('★★ 服务器没回话也不能念"已是最新"：这一族里 reason 提到"最新"时，必须是真查到了版本',
  (function () {
    const p = Update.plan({ ok: false, error: '问不到（HTTP ?）' }, '1.8.2');
    const q = Update.plan(null, '1.8.2');
    return !/最新/.test(p.reason) && !/最新/.test(q.reason) &&
      /最新/.test(Update.plan(Update.parse(good), '9.9.9').reason);
  })(), '问不到 ≠ 没更新 —— 念错一次他那边的排查就从服务器转到软件');
check('★★ 计划里永远不许出现"自动下载 / 覆盖文件"那一类动作（这一族的边界）',
  !/hot|install|apply|extract|replace/i.test(JSON.stringify(p1)),
  JSON.stringify({ a: p1.action }));

/* ---------------- E 三处生产者同形 ---------------- */
console.log('\n[E] 桌面 / 安卓 / 预览层 三处生产者，一颗按钮都不能是死的');
const mainSrc = read('shell/main.js');
const preloadSrc = read('shell/preload.js');
const shimSrc = read('android/js/df-android.js');
const mockSrc = read('test/mock-df.js');
const previewSrc = read('test/preview-server.js');
const htmlSrc = read('ui/index.html');
const appSrc = read('ui/js/app.js');
['status', 'check', 'openDownload'].forEach(function (k) {
  check('★ ' + k + '：preload 有、安卓桥有、mock 有（三处同形）',
    new RegExp(k).test(preloadSrc) && new RegExp(k).test(shimSrc) && new RegExp(k).test(mockSrc),
    'preload/安卓/mock 三份都要认这一颗');
});
check('★ 桌面 IPC 三颗都在（update:status / update:check / update:openDownload）',
  /ipcMain\.handle\('update:status'/.test(mainSrc) &&
  /ipcMain\.handle\('update:check'/.test(mainSrc) &&
  /ipcMain\.handle\('update:openDownload'/.test(mainSrc));
check('★ 预览层三条路由都在（不出网，读本地夹具走同一份 core 判据）',
  /\/mock\/update\/status/.test(previewSrc) && /\/mock\/update\/check/.test(previewSrc) &&
  /\/mock\/update\/openDownload/.test(previewSrc));
check('★ 事件白名单里有 update:status（宿主查完要能推给界面）',
  /'update:status'/.test(preloadSrc) && /'update:status'/.test(appSrc));
check('★ 安卓那条通道：JS 发的 url 由 Java 再钉一次 host 前缀（两道锁）',
  /"cfg\.update"\.equals\(channel\)/.test(read('android/app/src/main/java/com/df/battleanalyzer/DfBridge.java')));
check('★★ 两处 host 字面量必须逐字相等（JS 那份是口径，Java 那份是第二道锁）',
  Update.HOST === 'app.dpx1.icu' &&
  read('android/app/src/main/java/com/df/battleanalyzer/DfBridge.java').indexOf('UPDATE_HOST = "app.dpx1.icu"') > 0);
check('★ 装配表认识这颗新 core 文件（漏了安卓那一侧就是 Core.Update undefined 当场崩）',
  /'update'/.test(read('tools/build-android-assets.js')));
check('★★ 那个端点在**出厂的代码**里只有一处口径：core/update.js（Java 那颗是第二道锁，另算）',
  (function () {
    const hit = [];
    const walk = function (dir) {
      fs.readdirSync(dir).forEach(function (n) {
        const p = path.join(dir, n), st = fs.statSync(p);
        if (st.isDirectory()) { walk(p); return; }
        if (!/\.(js|html|css)$/.test(n)) return;
        if (fs.readFileSync(p, 'utf8').indexOf('app.dpx1.icu') >= 0) hit.push(path.relative(ROOT, p));
      });
    };
    ['core', 'shell', 'ui', path.join('android', 'js')].forEach(function (d) {
      walk(path.join(ROOT, d));
    });
    return hit.length === 1 && hit[0].replace(/\\/g, '/') === 'core/update.js';
  })(), '出厂代码里带这个域名的文件（应当只有 core/update.js 一处）');

/* ---------------- F 出网形状与界面红线 ---------------- */
console.log('\n[F] 出网只在宿主；界面连那个域名都不该看见');
const updBody = mainSrc.slice(mainSrc.indexOf('async function checkForUpdate'), mainSrc.indexOf('function autoCheckUpdate'));
/* 安卓那一段同样抠出来：数"有没有推"要在这一段里数，别数到别的通道上去 */
const shimUpdBody = shimSrc.slice(shimSrc.indexOf('function checkForUpdate'), shimSrc.indexOf('function autoCheckUpdate'));
check('★★ 桌面这一发不带登录态：新建的空 cookie 罐，且不碰采集那个 net 适配器',
  /PluginNet\.createJar\(\)/.test(updBody) && !/createNetAdapter/.test(updBody) &&
  !/[Cc]ookie/.test(updBody), updBody.slice(0, 46).replace(/\s+/g, ' '));
check('★ 域名清单只有一条，就是 core 里那一颗',
  /allowlist: \[Update\.HOST\]/.test(updBody), 'allowlist 只填 Update.HOST');
check('★ 判据先过再发：okUrl 与 noUserIdentity 两道都在这一发上',
  /Update\.okUrl\(/.test(updBody) && /Update\.noUserIdentity\(/.test(updBody));
check('★★ 这一族不写盘：主进程那段更新代码里没有一处落盘 / 解压的零件（软件不动他的文件）',
  !/(writeFile|appendFile|copyFile|renameSync|rmSync|unlinkSync|mkdirSync|createWriteStream|unzip|extract|\.zip)/i
    .test(updBody) && !/Zip\./.test(updBody),
  'require("fs").writeFileSync 那一类换皮写法也算（针 U18 就钻过一次空子）');
check('★★ 那一发发出去的 platform 就是枚举值本身，不是拼出来的（两端各钉一处）',
  /platform: 'win',/.test(mainSrc) && /Update\.url\('android',/.test(shimSrc),
  '桌面 startupRecord 里写死 win，安卓那一发写死 android');
check('★★ 界面那行状态是问宿主拿的（自己画一个空状态 ⇒ 只有那台设备上永远"正在检查"）',
  /df\.update\.status\(\)\.then\(renderUpdate\)/.test(appSrc) &&
  /df\.update\.check\(\)\.then\(renderUpdate\)/.test(appSrc));
check('★★ 安卓那句失败话要带 HTTP 状态码（404 = 服务器上还没放文件；只念一个「?」就是把排查踢回给他猜）',
  /问不到（HTTP /.test(shimSrc) && /r\.status/.test(shimSrc),
  'Java 那一发一直回 status（PluginNet 里 out.put("status", status)），JS 不许把它丢掉');
/* ★ 这一组是 2026-09-30 在桌面真机路径上量出来的缺陷钉住的：自动那一发跑完了（宿主 checked:true、
 *   error 已是「问不到（HTTP 404）」），界面那一行却还停在启动时那句「还没检查过。」——
 *   因为原来只有"查到新版"那一条出路会推，而自动那一发没人点按钮。他那台服务器部署好之前每天都是 404。 */
check('★★ 桌面这一推没有被任何条件挡住：pushUpdateState 就是 emit，且不许出现"按参数决定推不推"',
  /function pushUpdateState\(\) \{ emit\('update:status', Object\.assign\(\{\}, updateState\)\); \}/.test(updBody) &&
  !/if[^\n]*emit\('update:status'/.test(updBody),
  '坏样子：if (!o.quiet) emit(...) —— 自动那一发带着 quiet，界面就永远等不到那句话');
check('★★ 桌面每一条出路都推（判据不合法那一条与问完那一条），少一条就有一台设备停在空状态',
  (updBody.match(/pushUpdateState\(\);/g) || []).length >= 2,
  'updBody 里 pushUpdateState() 的调用点数');
check('★★ 自动那一发自己就是普通那发（不许再塞一个"这一发不用告诉界面"的口子）',
  /function autoCheckUpdate\(\) \{[\s\S]{0,300}?checkForUpdate\(\);/.test(mainSrc) &&
  !/checkForUpdate\(\s*\{/.test(mainSrc),
  'autoCheckUpdate 里必须是光的一发 checkForUpdate()');
check('★★ 界面确实挂着这一条事件（宿主推了没人接等于没推）',
  /global\.df\.on\('update:status', function \(s\) \{ renderUpdate\(s\); \}\)/.test(appSrc),
  'app.js 里那条订阅');
check('★★ 安卓同样每一条出路都推（两端口径一致）：链尾必须挂 .then(pushUpdateState)，判据不合法那一条也要推',
  /\.then\(pushUpdateState\);/.test(shimUpdBody) &&
  /updateState\.error = '检查地址不合法（判据在 core\/update\.js）';\n\s*onLocal\('update:status', updateState\);/.test(shimSrc) &&
  /function pushUpdateState\(\) \{ onLocal\('update:status', updateState\); \}/.test(shimSrc),
  '链尾那一发 .then(pushUpdateState) 就是这一修补的落点 —— 摘掉它，"问坏了"就又没人推了');
check('★ SELFTEST 下不许真出网（npm test 的结果不能看那台服务器的脸色）',
  /SELFTEST/.test(mainSrc.slice(mainSrc.indexOf('function autoCheckUpdate'))) &&
  /--live-sync/.test(mainSrc.slice(mainSrc.indexOf('function autoCheckUpdate'))));
check('★★ 界面源码里不出现那个域名（出网只在宿主，界面连地址都不该看见）',
  htmlSrc.indexOf('dpx1') === -1 && appSrc.indexOf('dpx1') === -1);
check('★★ 界面不许出现"我帮你装/已自动安装"那类句式（我们不代他下载）',
  !/立即更新|自动安装|已为你安装|重启生效/.test(htmlSrc) &&
  !/df\.update\.start|update:relaunch/.test(appSrc) && !/update:start/.test(preloadSrc));
check('★ 界面把"覆盖安装不丢数据"这句写明了（这是他要的那条安心话）',
  /覆盖安装不会丢数据/.test(htmlSrc) && /APPDATA/.test(htmlSrc));
check('★ 那句「数据只保存在本机，不会上传任何服务器」一个字没改',
  /你的战绩始终只保存在本机，不会上传任何服务器/.test(htmlSrc));

/* ---------------- G 计数与每日判据 ---------------- */
console.log('\n[G] 装机计数（每台一次）与地图名每日自动取的判据');
check('★ 计数的判据只有一枚 at：没报过才发，报过就只查版本',
  Update.shouldSend(null) && Update.shouldSend({}) && Update.shouldSend({ at: 0 }) &&
  !Update.shouldSend({ at: 1 }) && Update.markSent(123).at === 123);
check('★ 计数就搭在查版本那一发上：整串只有四个参数，其中只有 sec 是"这台机器报过没有"',
  Update.url('win', '1.8.2', true).split('?')[1].split('&').length === 4 &&
  Update.noUserIdentity(Update.url('win', '1.8.2', true)), Update.url('win', '1.8.2', true));
check('★ 桌面把计数记在 accounts.globalSettings.startup（换机/重装不会被数两次以上）',
  /globalSettings.startup = Update.markSent/.test(mainSrc));
check('★ 安卓同一颗落点（两边都靠本机记档，服务器不需要认识这台机器）',
  /globalSettings.startup = Core.Update.markSent/.test(shimSrc));
check('★★ 那枚"+1"必须跟着落盘：改完内存的下一行就是保存（只改内存 ⇒ 每次开机再数一次）',
  /globalSettings\.startup = Update\.markSent\(Date\.now\(\)\);\n  saveAccountsSync\(\);/.test(mainSrc) &&
  /globalSettings\.startup = Core\.Update\.markSent\(Date\.now\(\)\);\n\s*saveAccounts\(\);/.test(shimSrc),
  '桌面 saveAccountsSync() / 安卓 saveAccounts()，两端各钉一行');
check('★ 地图名"该不该自动取"的尺在 core，且真的是一天',
  Cfg.dueToRefresh(0, 1000) && !Cfg.dueToRefresh(1000, 1000 + 3600 * 1000) &&
  Cfg.dueToRefresh(1000, 1000 + Cfg.AUTO_AGE_MS) && Cfg.AUTO_AGE_MS === 24 * 60 * 60 * 1000,
  'AUTO_AGE_MS=' + Cfg.AUTO_AGE_MS);
check('★ 时钟没对上（now 不是正数）时不瞎发',
  !Cfg.dueToRefresh(123, 0) && !Cfg.dueToRefresh(123, NaN));
check('★ HOST_VERSION 与 package.json 同源（版本号只有一处真值）',
  Plg.HOST_VERSION === require(path.join(ROOT, 'package.json')).version,
  'core=' + Plg.HOST_VERSION + ' package=' + require(path.join(ROOT, 'package.json')).version);

console.log('\n' + (fail ? fail + ' 项失败' : '全部通过'));
process.exit(fail ? 1 : 0);
