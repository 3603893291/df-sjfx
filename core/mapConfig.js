/* mapConfig.js — 官方「地图 id → 名字」配置表的解析与出处（纯 JS，UMD，两端共用）
 *
 * 为什么要这一份：战绩接口只回 `mapId` 这种数字，**名字不在接口里**。
 * 名字在另一份公开的静态配置表（CDN 上一个 JSON，匿名可取、不需要登录、不携带任何本机数据）。
 * 以前这张表是当年抓包后手抄进 `core/maps.js` 的，于是官方一加新图本机就显示
 * 「未知地图 · id 262」（实证：2026-09-24 用户打的两把新图正是 262 = 摩格旧城区-占领）。
 *
 * ★ 三条硬规矩：
 *   1) **URL 与允许的域名只写在这一处**（桌面与安卓都从这里取，判定不许有第二个源头）；
 *   2) 本文件**不碰任何平台 API**（不发请求、不读文件）—— 请求由 shell / DfBridge 各做一份，
 *      这里只管"拿到一段文本之后怎么解析"，所以它能完全离线测；
 *   3) 解析结果只当**补充**：内置表永远优先，学到的进本机学名表（见 maps.js 的 applyExtra）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.DFCore = root.DFCore || {}; root.DFCore.MapConfig = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var URL = 'https://jsonschema.qpic.cn/f17859b917badfa9a083ad92c9eca90b' +
    '/558596903da9c0e12df38eee20dcfc36/map';
  /* 只认这一个主机；换 host 就是换承诺（isolation 有一条红线钉着） */
  var HOST = 'jsonschema.qpic.cn';
  var MAX_BYTES = 256 * 1024;   /* 实测约 20 KB，留十倍余量，超了直接不解析 */
  var NAME_MAX = 40;            /* 地名最长的一条是「攻防-指挥官模式-克劳狄斗兽场」 */
  var MAX_NAMES = 600;
  var CTRL = /[\x00-\x1F\x7F]/;
  /* 「隔多久允许自动再取一次」这一枚天数判据写在这里（不在 shell 里各写一份）：
   * 桌面与安卓各自 boot 时问这一颗，两边算出来的"该不该发"必须一字不差。
   * v1.8.2 起：以前是「这台机器从来没成功取到过才自动取一次」，现在改成「距上次成功取表超过一天」。 */
  var AUTO_AGE_MS = 24 * 60 * 60 * 1000;

  /** 该不该自动取一次配置表。`at` = 上一次**真取到**的时刻（0 = 从没取到过）。
   *  ★ 只认这一个判据：`at` 由 `learnMapNames` 在真取到表时才写；同步流程里顺带学到的名字
   *    不写它（那条路不算"自动取过表"），所以不会因为同步勤快就把这一发顶掉。 */
  function dueToRefresh(at, now) {
    var prev = Number(at) || 0;
    if (!prev) return true;
    var t = Number(now);
    if (!(t > 0)) return false;          /* 时钟都没对上就不瞎发 */
    return t - prev >= AUTO_AGE_MS;
  }

  /* 只许 https + 这个主机 + 标准端口。
   * `indexOf(head)!==0` 一次挡掉三种坏写法：http:// 、别的 host、host:端口。 */
  function okUrl(u) {
    if (typeof u !== 'string' || !u) return false;
    if (CTRL.test(u)) return false;
    var head = 'https://' + HOST + '/';
    if (u.indexOf(head) !== 0) return false;
    var tail = u.slice(head.length);
    return tail.indexOf('@') === -1 && tail.indexOf('\\') === -1;
  }

  /* 名字要写进库、要显示进表格 —— 脏数据**整条拒收**，不许洗白了收下：
   * 「带\x01脏」这种中间夹控制字符的，洗掉一个字符就等于我们替官方编了一个地名。
   * ★ 这条口径与 core/maps.js 的 applyExtra 必须一致（那边也是 BAD → 整条不要） */
  function cleanName(v) {
    var s = String(v == null ? '' : v);
    if (CTRL.test(s)) return '';
    s = s.trim();
    if (!s || s.length > NAME_MAX) return '';
    if (/[<>]/.test(s)) return '';
    return s;
  }
  function cleanId(v) {
    var s = String(v == null ? '' : v).trim();
    return /^\d{1,8}$/.test(s) ? s : '';
  }

  /**
   * 配置表文本 → { id: 名字 }。
   * 官方结构是 `{ mapDetail: [ {id, name, pic}, … ] }`（扁平一张表，模式已经拼在名字里）。
   * 同一个 id 出现两次时**先出现的赢** —— 顺序固定 = 结果固定，不然两次同步会来回改名。
   * @returns {ok, names, swtwr, count} | {ok:false, error}
   */
  function parse(text) {
    var s = String(text == null ? '' : text);
    if (!s) return { ok: false, error: '配置表是空的' };
    if (s.length > MAX_BYTES) return { ok: false, error: '配置表超过 ' + MAX_BYTES + ' 字节，不解析' };
    var j = null;
    try { j = JSON.parse(s); } catch (e) { return { ok: false, error: '不是合法 JSON' }; }
    var rows = j && Array.isArray(j.mapDetail) ? j.mapDetail : null;
    if (!rows) return { ok: false, error: '配置表里没有 mapDetail' };
    var names = {}, n = 0, swtwr = [];
    for (var i = 0; i < rows.length && n < MAX_NAMES; i++) {
      var r = rows[i] || {};
      var id = cleanId(r.id), name = cleanName(r.name);
      if (!id || !name || Object.prototype.hasOwnProperty.call(names, id)) continue;
      names[id] = name;
      n++;
      /* 名字里带「胜者为王」的，一并记成胜者为王图 —— 新图不用改代码也不会被算成常规场 */
      if (name.indexOf('胜者为王') !== -1) swtwr.push(Number(id));
    }
    if (!n) return { ok: false, error: '配置表里一条名字都没解析出来' };
    return { ok: true, names: names, swtwr: swtwr, count: n };
  }

  return { URL: URL, HOST: HOST, MAX_BYTES: MAX_BYTES, NAME_MAX: NAME_MAX,
    AUTO_AGE_MS: AUTO_AGE_MS, dueToRefresh: dueToRefresh,
    okUrl: okUrl, parse: parse, cleanName: cleanName, cleanId: cleanId };
});
