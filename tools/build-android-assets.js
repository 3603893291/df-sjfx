'use strict';
/* build-android-assets.js — 把 core/ + ui/ + 安卓那一层 JS 装进 APK 的 assets
 *
 *   node tools/build-android-assets.js
 *
 * 为什么要在构建时改 index.html 而不是直接用它：
 *   桌面端 ui/index.html 里**一个 core/* 都不许出现**（进程分裂的 hygiene，见手册 §6），
 *   安卓只有一个 WebView，没有第二个 JS 世界，core 必须进来。
 *   所以"core 进页面"这件事只发生在**这份产出的副本**里，源文件 ui/index.html 保持桌面原样；
 *   取而代之钉住的是一条更实的红线：ui/js/* 里出现 DFCore 字样就判红
 *   （见 test/isolation.test.js —— 界面上仍只许通过 window.df 拿数据）。
 *
 * 顺带把 <script src="js/theme.js"> 之前该排的队排好：core 全部 → df-android.js → 才是 ui 自己的那几个。
 * df-android.js 要在 ui/js/app.js 之前定义好 window.df，晚一步 app.js 的 DOMContentLoaded 就会走「未检测到应用环境」。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const ASSETS = path.join(ANDROID, 'app', 'src', 'main', 'assets', 'app');
/* ★ 顺序是**依赖顺序**，不是字母顺序：每个 core 文件的 UMD 头在"被加载的那一刻"就去
 *   root.DFCore 上取它的依赖，取早了就是 undefined（Node 里 require 会自己解析，
 *   所以这条只在打进 assets 的那一份上成立 —— 2026-09-24 手机上就是这么炸的：
 *   plugin 排在 zip 前面 ⇒ Zip.isSafeRelPath 读不到）。
 *   test/android-shim.test.js 里有一条红线把这张表按 UMD 头重算一遍。 */
const CORE_ORDER = ['maps', 'mapConfig', 'update', 'stats', 'async', 'normalize',
  'store', 'collector', 'analysis', 'zip', 'plugin', 'aiDigest'];

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
function copy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.readdirSync(src).forEach(function (n) { copy(path.join(src, n), path.join(dst, n)); });
    return;
  }
  fs.copyFileSync(src, dst);
}
function size(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    return fs.readdirSync(p).reduce(function (a, n) { return a + size(path.join(p, n)); }, 0);
  }
  return st.size;
}
function count(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    return fs.readdirSync(p).reduce(function (a, n) { return a + count(path.join(p, n)); }, 0);
  }
  return 1;
}

function inject(html) {
  const core = CORE_ORDER.map(function (n) {
    const f = path.join(ROOT, 'core', n + '.js');
    if (!fs.existsSync(f)) throw new Error('core/' + n + '.js 不存在，装配表该改了');
    return '<script src="/app/core/' + n + '.js"></script>';
  }).join('\n');
  const block = '<!-- ↓ 安卓装配时注入：core 与原生桥必须在 ui 之前就位（build-android-assets.js） -->\n' +
    core + '\n<script src="/app/android/plugin-host.js"></script>' +
    '\n<script src="/app/android/df-android.js"></script>\n<!-- ↑ -->\n';
  const anchor = '<script src="js/theme.js"></script>';
  if (html.indexOf(anchor) < 0) {
    throw new Error('ui/index.html 里找不到注入锚点 ' + anchor + ' —— 脚本顺序变了，装配必须跟着改，不能默默装出一份跑不起来的包');
  }
  return html.replace(anchor, block + anchor);
}

if (require.main === module) {
  rmrf(ASSETS);
  fs.mkdirSync(ASSETS, { recursive: true });

  CORE_ORDER.forEach(function (n) {
    copy(path.join(ROOT, 'core', n + '.js'), path.join(ASSETS, 'core', n + '.js'));
  });
  copy(path.join(ROOT, 'ui'), path.join(ASSETS, 'ui'));
  copy(path.join(ANDROID, 'js'), path.join(ASSETS, 'android'));

  const idx = path.join(ASSETS, 'ui', 'index.html');
  fs.writeFileSync(idx, inject(fs.readFileSync(idx, 'utf8')), 'utf8');

  const kb = (size(ASSETS) / 1024).toFixed(0);
  console.log('assets/app ← ' + count(ASSETS) + ' 个文件 / ' + (kb / 1024).toFixed(2) + ' MB');
  console.log('  core ' + CORE_ORDER.length + ' 个（' + CORE_ORDER.join(', ') + '）');
  console.log('  入口 https://dfapp.local/app/ui/index.html');
}

module.exports = { inject: inject, ASSETS: ASSETS };
