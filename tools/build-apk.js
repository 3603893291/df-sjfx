'use strict';
/* build-apk.js — 出安卓安装包
 *
 *   node tools/build-apk.js              装配 assets → gradle → 拷进 dist-android/
 *   node tools/build-apk.js --apk-only   只把已编好的 apk 拷到 dist-android/
 *
 * ★ 装配 assets 必须先跑：APK 里那份 core/ + ui/ 是 build-android-assets.js 摆进去的，
 *   跳过它就等于把上一次源码的副本又签一遍名发出去 —— 界面改了包里没有，测试还全绿。
 *
 * 为什么要有这个脚本，而不是让使用者自己敲 gradle：
 *   1) 本机没有 gradle CLI，只有一份发行版在 ~/.gradle-dists/gradle-8.13，得替它找路；
 *   2) android/local.properties 里那条 sdk.dir 必须用正斜杠，反斜杠转义一坏就是
 *      「文件名、目录名或卷标语法不正确」这种看不出根因的报错，所以由脚本生成；
 *   3) 产物要从 android/app/build/outputs/... 挪到 dist-android/，和桌面端的 dist/ 一个待遇。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const OUT_DIR = path.join(ROOT, 'dist-android');
const APK_OUT = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug');

function log(s) { console.log(s); }
function die(s) { console.error('\n✗ ' + s + '\n'); process.exit(1); }

/* ---------------------------------------------- 找 gradle / SDK */

function findGradle() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--gradle');
  const named = i >= 0 ? args[i + 1] : '';
  const cands = [];
  if (named) cands.push(named);
  if (process.env.GRADLE_HOME) cands.push(path.join(process.env.GRADLE_HOME, 'bin', 'gradle.bat'));
  cands.push(path.join(os.homedir(), '.gradle-dists', 'gradle-8.13', 'bin', 'gradle.bat'));
  cands.push(path.join(os.homedir(), '.gradle-dists', 'gradle-8.11.1', 'bin', 'gradle.bat'));
  for (const c of cands) {
    if (c && fs.existsSync(c)) return c;
  }
  die('没找到 gradle。装一份 8.13 后用 --gradle <路径>\\bin\\gradle.bat 指路。\n' +
      '  候选试过：\n  ' + cands.join('\n  '));
}

function findSdk() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--sdk');
  const named = i >= 0 ? args[i + 1] : '';
  const cands = [
    named,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : ''
  ].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'platforms'))) return c;
  }
  die('没找到 Android SDK（要有 platforms/ 目录）。装好后用 --sdk <路径> 指路。\n' +
      '  候选试过：\n  ' + cands.join('\n  '));
}

function ensureLocalProperties() {
  const f = path.join(ANDROID, 'local.properties');
  let sdk = '';
  try { sdk = findSdk(); } catch (e) {
    // 已有 local.properties 且指向一个不存在的 SDK 时，findSdk 会 die；这里让它先读文件
    if (fs.existsSync(f)) {
      const m = /sdk\.dir=(.*)/.exec(fs.readFileSync(f, 'utf8'));
      if (m && fs.existsSync(path.resolve(m[1].replace(/\\/g, '/')))) return m[1];
    }
    throw e;
  }
  // ★ 正斜杠：java.util.Properties 会把 "\U" "\x" "\A" 当坏转义吃掉，路径就废了
  const line = 'sdk.dir=' + sdk.replace(/\\/g, '/');
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (!cur.includes(line)) {
    fs.writeFileSync(f, line + '\n');
    log('  · local.properties → ' + line);
  }
  return sdk;
}

/* ---------------------------------------------------------- 构建 */

function runGradle(gradle) {
  log('▶ gradle assembleDebug');
  const r = spawnSync(process.env.ComSpec || 'cmd.exe',
    ['/c', gradle, '-p', ANDROID, 'assembleDebug', '--console=plain'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const tail = out.split(/\r?\n/).filter(function (l) {
    return /FAILED|error:|错误|BUILD |What went wrong|> Task .*(FAILED|aapt|dex|Sign)/.test(l);
  });
  (tail.length ? tail : out.split(/\r?\n/).slice(-25)).forEach(log);
  if (r.status !== 0) die('gradle 退出码 ' + r.status);
}

function collectApk() {
  if (!fs.existsSync(APK_OUT)) die('没有产物目录：' + APK_OUT);
  const apks = fs.readdirSync(APK_OUT).filter(function (f) { return f.endsWith('.apk'); });
  if (!apks.length) die(APK_OUT + ' 里没有 .apk');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const picked = apks.sort(function (a, b) {
    return fs.statSync(path.join(APK_OUT, b)).mtimeMs - fs.statSync(path.join(APK_OUT, a)).mtimeMs;
  })[0];
  const to = path.join(OUT_DIR, picked);
  fs.copyFileSync(path.join(APK_OUT, picked), to);
  const mb = (fs.statSync(to).size / 1048576).toFixed(2);
  log('\n✓ ' + path.relative(ROOT, to) + '  ' + mb + ' MB');
  log('  传到手机上点开安装即可（安装前需在系统里允许「安装未知应用」）。');
  return to;
}

if (require.main === module) {
  const apkOnly = process.argv.includes('--apk-only');
  ensureLocalProperties();
  if (!apkOnly) syncAssets();
  if (!apkOnly) runGradle(findGradle());
  collectApk();
}

function syncAssets() {
  log('▶ 装配 assets（core/ + ui/ + 安卓那一层 JS）');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-android-assets.js')],
    { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  out.split(/\r?\n/).filter(Boolean).forEach(log);
  if (r.status !== 0) die('assets 装配失败（退出码 ' + r.status + '）');
}
