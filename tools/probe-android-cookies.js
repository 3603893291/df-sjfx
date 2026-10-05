'use strict';
/* probe-android-cookies.js — 读一份从安卓设备拉下来的 WebView cookie 库，只报名字与条数，值一个都不打印。
 *
 * 为什么要这一份：设备探针里 `document.cookie` 看不见 HttpOnly 的那些（WeGame / QQ 的登录凭据全是 HttpOnly），
 * 所以"打开登录窗有没有真的把会话清干净"这件事在页面里量不到，只能到 cookie 库本身去量。
 * 用法：node tools/probe-android-cookies.js <Cookies 文件路径>
 */
const path = require('path');
process.env.NODE_OPTIONS = '';
const { DatabaseSync } = require('node:sqlite');

const file = process.argv[2];
if (!file) { console.log('用法：node tools/probe-android-cookies.js <Cookies>'); process.exit(1); }
const db = new DatabaseSync(file, { readOnly: true });
const rows = db.prepare('SELECT host_key, name, COUNT(*) AS n FROM cookies GROUP BY host_key, name')
  .all().map(function (r) {
    return { host: String(r.host_key), name: String(r.name), n: Number(r.n) };
  });
const total = db.prepare('SELECT COUNT(*) AS c FROM cookies').get();
console.log(JSON.stringify({
  file: path.basename(file),
  total: Number(total && total.c),
  kinds: rows.length,
  list: rows.map(function (r) { return r.host + ' | ' + r.name; }).sort()
}, null, 1));
db.close();
