/* update.js — 「有没有新版本」这一发的判据（纯 JS，UMD，零依赖，两端共用）
 *
 * 2026-09-30 他改了口径：**不做热替换**，软件只负责告诉他"有新版本 + 去哪儿下"，
 * 每次都是下一个全新的整包，覆盖安装即可。原因很实在：整包 115 MB / 解压 283 MB，
 * 他那台服务器带宽本来就小，让软件去自动拉整包是把那条约束踩在脚下。
 *
 * 于是这一族只剩三条判据，全写在这一个文件里（桌面与安卓共用，不许各写一遍）：
 *   ① 这一发带什么参数：只有 app / platform / v / sec 四个名字，**没有任何用户内容**
 *      —— 没有 uid、没有昵称、没有 openid、没有设备号。sec 只有"这台机器第一次报"才非空，
 *      那一下就是他要在服务器上数的"+1"（每台只数一次由客户端本机记档保证）。
 *   ② 谁算新版本：三段点分数字比大小，全代码库只有这一颗 cmp。
 *   ③ 提示什么：只提示，不下载、不解压、不写盘 —— 所以这里连"能不能自动装"都不判断，
 *      界面上也就没有"立即更新"那颗会动他文件的按钮。
 *
 * 覆盖安装为什么不会丢数据：本软件的用户数据一律不在安装目录里，而在
 * `%APPDATA%\df-swtwr\`（安卓在应用私有目录），换掉整个程序目录动不到它。
 * 这句话在 core/store.js 的落盘路径上是被钉住的（见 §6 那节与 isolation 的红线）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.DFCore = root.DFCore || {}; root.DFCore.Update = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var HOST = 'app.dpx1.icu';
  var APP_ID = 'df-swtwr';
  var CHECK_PATH = '/admin/app/update';
  var SEC_FIRST = '启动软件';       /* 只有"这台机器第一次报"才带的计数标记 */
  var MAX_TEXT = 16 * 1024;         /* 回包很小，超了就是不认识 */
  var VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
  var NOTES_MAX = 400;

  /* ---------------- ① 这一发长什么样 ---------------- */
  /**
   * @param {string} platform 'win' | 'android'
   * @param {string} version  本机当前版本
   * @param {boolean} firstReport 这台机器以前没报过 ⇒ 这一发顺带把装机数 +1
   */
  function url(platform, version, firstReport) {
    var u = 'https://' + HOST + CHECK_PATH + '?app=' + APP_ID +
      '&platform=' + encodeURIComponent(String(platform || '')) +
      '&v=' + encodeURIComponent(String(version || '')) + '&sec=';
    return firstReport ? u + encodeURIComponent(SEC_FIRST) : u;
  }

  /* 去处钉死：只认这一台服务器上的这一个路径。 */
  function okUrl(u) {
    if (typeof u !== 'string' || !u) return false;
    return u.indexOf('https://' + HOST + CHECK_PATH + '?') === 0 &&
      u.indexOf('@') === -1 && u.indexOf('\\') === -1 &&
      u.indexOf('\n') === -1 && u.indexOf('\r') === -1;
  }

  /** 这一发除了软件自己的事实，不许带别的。
   *  ★ 参数名只允许那四个，值里不许出现标识形状 ——
   *    将来谁顺手把昵称/openid 拼进来，这里当场不绿（而不是等到发包才发现）。 */
  var ALLOW_PARAMS = { app: 1, platform: 1, v: 1, sec: 1 };
  var VERSION_VALUE_RE = /^[\w.\-]{1,24}$/;   /* 版本号本身：点 / 横杠 / 字母数字，不含百分号转义 */
  function noUserIdentity(u) {
    var s = String(u || '');
    var q = s.indexOf('?');
    if (q < 0) return false;
    var parts = s.slice(q + 1).split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (!ALLOW_PARAMS[kv[0]]) return false;             /* name / nick / openid / uid … 一律不过 */
      var val = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
      if (kv[0] === 'sec') { if (val !== '' && val !== SEC_FIRST) return false; continue; }
      /* 版本号是点分的短段（v=1.8.2），长数字 = 账号 / 设备号那一类形状 */
      if (/\d{7,}/.test(val)) return false;
      /* 名字认了还不够，值也必须是那一类值：把版本号拼进 platform 这种"看着规矩其实乱了口径"的要拒 */
      if (kv[0] === 'app' && val !== APP_ID) return false;
      if (kv[0] === 'platform' && val !== 'win' && val !== 'android') return false;
      if (kv[0] === 'v' && !VERSION_VALUE_RE.test(val)) return false;
    }
    return true;
  }

  /* ---------------- ② 谁算新版本 ---------------- */
  function cmp(a, b) {
    var x = String(a || '0').split('.'), y = String(b || '0').split('.'), n, m;
    m = Math.max(x.length, y.length);
    for (var i = 0; i < m; i++) {
      n = (Number(x[i]) || 0) - (Number(y[i]) || 0);
      if (n) return n > 0 ? 1 : -1;
    }
    return 0;
  }
  function isNewer(cur, want) { return cmp(want, cur) > 0; }

  /* ---------------- ③ 服务器回的那一小段 ---------------- */
  function cleanText(v, max) {
    var s = String(v == null ? '' : v);
    if (/[\x00-\x1F\x7F]/.test(s)) return '';
    return s.length > max ? s.slice(0, max) : s;
  }
  /** 下载地址：**只认 https**（http 一律不要 —— 明文下载一个可执行整包是不能接受的）。
   *  允许指向别的站点（他可能把包放网盘），所以下面单独有一条"必须是 https + 有主机名"的闸。 */
  function cleanUrl(v) {
    var s = cleanText(v, 300);
    if (!s || s.indexOf('https://') !== 0) return '';
    var rest = s.slice(8);
    var host = rest.split('/')[0];
    if (!host || host.indexOf('.') === -1 || host.indexOf('@') >= 0) return '';
    if (/[\s\\]/.test(s)) return '';
    return s;
  }
  var SHA_RE = /^[0-9a-f]{64}$/;

  /**
   * 回包文本 → 界面要念的那几句。坏一条整份作废（宁可不提示，也别照着脏回包喊"有新版本"）。
   * @returns {{ok:true, version, url, notes, force, size, sha256}|{ok:false, error}}
   */
  function parse(text) {
    var s = String(text == null ? '' : text);
    if (!s) return { ok: false, error: '服务器没有回内容' };
    if (s.length > MAX_TEXT) return { ok: false, error: '回包超过 ' + MAX_TEXT + ' 字节，不认识' };
    var j = null;
    try { j = JSON.parse(s); } catch (e) { return { ok: false, error: '回包不是合法 JSON' }; }
    if (!j || typeof j !== 'object') return { ok: false, error: '回包不是对象' };
    var version = cleanText(j.version, 20);
    if (!VERSION_RE.test(version)) return { ok: false, error: '版本号形状不对：' + version };
    var sha = cleanText(j.sha256, 64).toLowerCase();
    return {
      ok: true,
      version: version,
      url: cleanUrl(j.url == null ? j.package : j.url),
      notes: cleanText(j.notes, NOTES_MAX),
      force: (Number(j.force) === 1) ? 1 : 0,
      size: Number(j.size) > 0 ? Number(j.size) : 0,
      sha256: SHA_RE.test(sha) ? sha : ''
    };
  }

  /** 该怎么做。这一族只有两个答案：不动、提示。 **没有"我自己来装"这一档**。 */
  function plan(manifest, curVersion) {
    if (!manifest || !manifest.ok) {
      return { action: 'none', reason: (manifest && manifest.error) || '没查到版本信息' };
    }
    if (!isNewer(curVersion, manifest.version)) {
      return { action: 'none', reason: '已经是最新版本', latest: manifest.version };
    }
    return {
      action: 'hint', latest: manifest.version, m: manifest,
      reason: manifest.url ? '有新版本，去下载新的整包覆盖安装' : '有新版本，但服务器没给下载地址'
    };
  }

  /* ---------------- 装机计数：这台机器报过没有 ----------------
   * 计数不另开一发，就搭在上面那一发上（第一次多带一个 sec）。
   * 判据只有一枚 at：没报过才带 sec，报过之后 sec 留空只查版本 —— 服务器不需要认识这台机器，
   * "每台只数一次"完全由本机这份记档保证。 */
  function shouldSend(rec) { return !(rec && Number(rec.at)); }
  function markSent(now) { return { at: Number(now) || 0 }; }

  return {
    HOST: HOST, APP_ID: APP_ID, CHECK_PATH: CHECK_PATH, SEC_FIRST: SEC_FIRST,
    MAX_TEXT: MAX_TEXT, NOTES_MAX: NOTES_MAX, VERSION_RE: VERSION_RE,
    url: url, okUrl: okUrl, noUserIdentity: noUserIdentity,
    shouldSend: shouldSend, markSent: markSent,
    cmp: cmp, isNewer: isNewer, parse: parse, plan: plan, cleanUrl: cleanUrl
  };
});
