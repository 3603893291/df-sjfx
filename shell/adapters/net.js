'use strict';
/* 网络适配器（Electron session 实现）
 * 关键：所有请求都走「登录窗口所用的同一个 session」，
 * 因此天然携带登录态，且插件/软件都不需要接触 Cookie 明文。
 */

const ORIGIN = 'https://www.wegame.com.cn';

// 覆盖成正常 Chrome 的 UA，避免被识别为自动化环境
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function createNetAdapter(session) {
  return {
    ua: CHROME_UA,
    post(pathname, body) {
      return session.fetch(ORIGIN + pathname, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/plain, */*',
          'origin': ORIGIN,
          'referer': ORIGIN + '/helper/df/score/',
          'user-agent': CHROME_UA
        },
        body: JSON.stringify(body || {}),
        credentials: 'include'
      }).then(function (res) {
        return res.text();
      }).then(function (txt) {
        try {
          return JSON.parse(txt);
        } catch (e) {
          const err = new Error('接口返回非 JSON（长度 ' + txt.length + '）：' + txt.slice(0, 120));
          err.raw = txt;
          throw err;
        }
      });
    }
  };
}

module.exports = { createNetAdapter, CHROME_UA, ORIGIN };
