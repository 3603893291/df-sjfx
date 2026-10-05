/* plugin-net.js — 插件的网络出口（主进程专用）
 *
 * 插件自己碰不到 net / http / Node：所有对外请求都从这里出去，而这里只认三件事：
 *   1. 协议必须是 https（唯一例外：127.0.0.1 / localhost，给本地自测用），且只认标准 443 端口
 *   2. 主机名必须在**这个插件的域名清单**里 —— 每一跳都重查。
 *      ★ 清单写成 `["*"]` 时意思是「地址由使用者在插件页里自己填」，此时这一条不再筛域名，
 *      上面那道协议 + 端口的闸门仍然逐跳生效（通配 ≠ 放行明文）。
 *   3. 响应有大小上限与总超时，重定向最多 3 跳，且每一跳重新校验
 *
 * Cookie 由宿主代管（每个插件一个罐子），所以战队那边的会话 Cookie 不会流经渲染层，
 * 更不会被插件写进它自己的 kv 存储。
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { StringDecoder } = require('node:string_decoder');
const Async = require('../../core/async');
const Plg = require('../../core/plugin');

const MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT = 15000;
const MAX_HOPS = 3;
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

function isAllowedHost(host, allowlist) {
  if (Plg.hostsAreAny(allowlist)) return true;
  const h = String(host || '').toLowerCase();
  return (allowlist || []).some(function (a) { return String(a).toLowerCase() === h; });
}

function validate(urlStr, allowlist) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return { ok: false, error: '网址格式不对：' + urlStr }; }
  const host = String(u.hostname || '').toLowerCase();
  if (u.protocol === 'https:') {
    /* 不带端口或标准端口；自定义端口容易被当成内网穿透的口子，先禁 */
    if (u.port && u.port !== '443') return { ok: false, error: '只允许标准 https 端口' };
  } else if (u.protocol === 'http:') {
    if (LOOPBACK.indexOf(host) === -1) return { ok: false, error: '明文 http 只允许本机自测，对外必须是 https' };
  } else {
    return { ok: false, error: '不支持的协议：' + u.protocol };
  }
  if (!isAllowedHost(host, allowlist)) {
    return { ok: false, error: '这个网址不在你为插件批准的域名清单里：' + host };
  }
  return { ok: true, url: u };
}

function cookieName(c) { return String(c).split('=')[0].trim(); }

function createJar(initial) {
  let store = {};
  if (initial && typeof initial === 'object') {
    Object.keys(initial).forEach(function (k) { store[k] = initial[k]; });
  }
  return {
    absorb: function (setCookies) {
      (setCookies || []).forEach(function (c) {
        const name = cookieName(c);
        if (!name) return;
        if (/expires=Thu, 01 Jan 1970/i.test(c) || /max-age=0/i.test(c)) { delete store[name]; return; }
        store[name] = c;
      });
    },
    header: function () {
      const parts = Object.keys(store).map(function (k) { return store[k].split(';')[0]; });
      return parts.join('; ');
    },
    dump: function () { return Object.assign({}, store); },
    clear: function () { store = {}; }
  };
}

function once(opts) {
  return new Promise(function (resolve) {
    const u = opts.url;
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    const done = function (r) { if (!settled) { settled = true; resolve(r); } };

    const req = mod.request(u, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: opts.timeout || DEFAULT_TIMEOUT
    }, function (res) {
      const chunks = [];
      let size = 0, overflow = false;
      res.on('data', function (c) {
        size += c.length;
        /* 上限由调用方给（宿主自己那一发要能拉几百 KB 的更新包，插件那几发只要 4 MB 默认档） */
        const cap = opts.maxBytes || MAX_BYTES;
        if (size > cap) { overflow = true; req.destroy(); done({ ok: false, error: '响应超过 ' + Math.round(cap / 1024) + ' KB 上限，已中断' }); return; }
        chunks.push(c);
      });
      res.on('end', function () {
        if (overflow || settled) return;
        const raw = Buffer.concat(chunks);
        /* binary：原样交出这段字节（更新包是 zip，走 utf8 会被改坏 —— 那正是要防的错法）。
         * 非 binary：与以前一字一样，只交 text。 */
        done(opts.binary
          ? { ok: true, status: res.statusCode, headers: res.headers, buf: raw }
          : { ok: true, status: res.statusCode, headers: res.headers, text: raw.toString('utf8') });
      });
      res.on('error', function (e) { if (!settled) done({ ok: false, error: String(e.message || e) }); });
    });

    req.on('error', function (e) { if (!settled) done({ ok: false, error: String(e.message || e) }); });
    req.on('timeout', function () { req.destroy(); if (!settled) done({ ok: false, error: '请求超时' }); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* 一次完整调用：校验 → 发 → 处理重定向（每跳重校验）→ 收 Cookie
 * maxText：交回给调用方的正文档位，默认 4000 —— 这是**插件能看到多少**的档位，
 *   不是网络档位（网络档位是上面的 MAX_BYTES，超了直接中断）。
 *   宿主自己的取数（地图名配置表）要拿整份，所以传一个大值进来，复用的还是同一套出网地板。 */
async function request(opts) {
  const o = opts || {};
  const allowlist = o.allowlist || [];
  const jar = o.jar || createJar();
  const maxText = positive(o.maxText, 4000);
  let target = String(o.url || '');
  let hops = 0, last = null;

  while (true) {
    const v = validate(target, allowlist);
    if (!v.ok) return { ok: false, error: v.error, stage: 'validate' };

    const headers = Object.assign({
      'User-Agent': 'df-swtwr-plugin/1.0',
      Accept: 'application/json'
    }, o.headers || {});
    const ck = jar.header();
    if (ck && !headers.Cookie) headers.Cookie = ck;
    if (o.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (o.body) headers['Content-Length'] = Buffer.byteLength(o.body);

    last = await once({
      url: v.url, method: o.method || (o.body ? 'POST' : 'GET'),
      headers: headers, body: o.body, timeout: o.timeout || DEFAULT_TIMEOUT,
      binary: !!o.binary, maxBytes: positive(o.maxBytes, MAX_BYTES)
    });
    if (!last.ok) return last;

    jar.absorb(last.headers['set-cookie']);

    const loc = last.headers.location;
    if ([301, 302, 303, 307, 308].indexOf(last.status) !== -1 && loc) {
      if (hops >= MAX_HOPS) return { ok: false, error: '重定向超过 ' + MAX_HOPS + ' 跳', status: last.status };
      hops++;
      let next;
      try { next = new URL(loc, v.url).toString(); } catch (e) { return { ok: false, error: '重定向地址不合法：' + loc }; }
      /* 303 之后必须换回 GET；307/308 保留方法 */
      if (last.status === 303 && o.body) { o = Object.assign({}, o, { method: 'GET', body: null }); }
      target = next;
      continue;
    }
    break;
  }

  let json = null;
  if (last.text) {
    try { json = JSON.parse(last.text); } catch (e) { json = null; }
  }
  if (o.binary) {
    /* 二进制这一路只交字节：不去 toString、不猜编码，切多少由 maxBytes 那道闸管 */
    return {
      ok: last.status >= 200 && last.status < 300,
      status: last.status, bytes: last.buf.length, buf: last.buf,
      contentType: String(last.headers['content-type'] || '')
    };
  }
  return {
    ok: last.status >= 200 && last.status < 300,
    status: last.status,
    json: json,
    text: last.text.length > maxText ? last.text.slice(0, maxText) : last.text,
    contentType: String(last.headers['content-type'] || ''),
    cookies: jar.dump()
  };
}

/* ============ 流式出口 ============
 * 为什么宿主要替插件管这条：插件页跑在沙箱 iframe 里，既没有 Node 也没有自己的 fetch，
 * 所以"慢服务商两分钟才说完一句话"这种等待也必须从本文件出去，不能因为要流式就给它开一条真网络。
 *
 * ★ 这里刻意不做任何协议解读：不拆 SSE、不认 JSON、不翻译 HTTP 状态的含义，
 *   只把解码后的文本原片交回调用方。服务商词汇留在插件包里，出厂的那一份只有"管子"。
 *
 * 三个窗口各管一段（v1.4.4 真跑量出来的教训：当年空闲计时在进函数那一刻就开始数，
 * 于是首字节慢于 30 秒的服务商被判成「流式中断」——错的不快的那个数字，而是每一段从哪儿起算）：
 *   connect  发出请求 → 第一个字节（排队 / TLS / 模型思考都算在这一段）
 *   idle     确实开始有字节之后，两次数据之间的最长静默 —— 只有这一段判"断流"
 *   total    单次回答的兜顶，防无人值守时连接悬着无限烧额度
 */
const STREAM_CONNECT_TIMEOUT = 120000;
const STREAM_IDLE_TIMEOUT = 30000;
const STREAM_TOTAL_TIMEOUT = 600000;
const STREAM_MAX_BYTES = 4 * 1024 * 1024;
const FORBIDDEN_HEADERS = ['cookie', 'host', 'content-length', 'connection', 'upgrade'];

function positive(v, dflt) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : dflt;
}

/* opts: { url, method, headers, body, allowlist, jar, onEvent,
 *         connectTimeout, idleTimeout, totalTimeout, maxBytes }
 * onEvent({type:'open'|'data'|'end', ...})；end 一定发且只发一次。
 * 返回 { ok, error? , abort() } —— 地址不合法时同步就给 ok:false，一个字节也不发出去。 */
function stream(opts) {
  const o = opts || {};
  const allowlist = o.allowlist || [];
  const jar = o.jar || createJar();
  const emit = typeof o.onEvent === 'function' ? o.onEvent : function () {};
  /* 流式的 Cookie 落在最后：整条流收尾时才有意义，所以让调用方给一个"现在可以落盘"的回调 */
  const persist = typeof o.onPersist === 'function' ? o.onPersist : function () {};
  const connectMs = positive(o.connectTimeout, STREAM_CONNECT_TIMEOUT);
  const idleMs = positive(o.idleTimeout, STREAM_IDLE_TIMEOUT);
  const totalMs = positive(o.totalTimeout, STREAM_TOTAL_TIMEOUT);
  const maxBytes = positive(o.maxBytes, STREAM_MAX_BYTES);

  let finished = false, delivered = 0, chunkCount = 0, bytes = 0,
      idle = null, totalTimer = null, req = null, aborted = false;
  const t0 = Date.now();

  function finish(result) {
    if (finished) return;
    finished = true;
    if (totalTimer) clearTimeout(totalTimer);
    if (idle) idle.stop();
    persist();
    const out = Object.assign({ ok: false, bytes: bytes, chunks: chunkCount,
      ms: Date.now() - t0 }, result || {});
    emit({ type: 'end', end: out });
    return out;
  }
  function kill(msg, extra) {
    if (req) { try { req.destroy(); } catch (e) {} }
    finish(Object.assign({ ok: false, error: msg }, extra || {}));
  }
  function hop(targetUrl, hops) {
    const v = validate(targetUrl, allowlist);
    if (!v.ok) { finish({ ok: false, error: v.error, stage: 'validate' }); return; }

    const headers = Object.assign({ 'User-Agent': 'df-swtwr-plugin/1.0' }, o.headers || {});
    FORBIDDEN_HEADERS.forEach(function (k) {
      Object.keys(headers).forEach(function (h) { if (h.toLowerCase() === k) delete headers[h]; });
    });
    const ck = jar.header();
    if (ck) headers.Cookie = ck;
    if (o.body && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(o.body);

    const mod = v.url.protocol === 'https:' ? https : http;
    req = mod.request(v.url, {
      method: o.method || (o.body ? 'POST' : 'GET'),
      headers: headers,
      timeout: connectMs
    }, function (res) {
      const status = res.statusCode || 0;
      jar.absorb(res.headers['set-cookie'] || []);

      /* 改道先判、再报 open：一个流只该有一次「开了」，否则调用方要自己猜哪一次算数 */
      const loc = res.headers.location;
      if ([301, 302, 303, 307, 308].indexOf(status) !== -1 && loc) {
        res.resume();
        if (delivered) { kill('重定向发生在开始返回内容之后，已中断', { status: status }); return; }
        if (hops >= MAX_HOPS) { finish({ ok: false, status: status, error: '重定向超过 ' + MAX_HOPS + ' 跳' }); return; }
        let next;
        try { next = new URL(loc, v.url).toString(); }
        catch (e) { finish({ ok: false, status: status, error: '重定向地址不合法：' + loc }); return; }
        hop(next, hops + 1);
        return;
      }

      emit({ type: 'open', open: { status: status, contentType: String(res.headers['content-type'] || '') } });
      const dec = new StringDecoder('utf8');
      res.on('data', function (c) {
        if (finished) { return; }
        chunkCount++;
        bytes += c.length;
        if (bytes > maxBytes) {
          kill('响应超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB 上限，已中断', { status: status, truncated: true });
          return;
        }
        if (!idle) {
          idle = Async.idleTimer(function () {
            kill('流式中断：' + (idleMs / 1000) + ' 秒没有新内容', { status: status });
          }, idleMs);
        } else idle.touch();
        const text = dec.write(c);
        if (text) { delivered++; emit({ type: 'data', text: text }); }
      });
      res.on('end', function () {
        if (finished) return;
        const tail = dec.end();
        if (tail) { delivered++; emit({ type: 'data', text: tail }); }
        finish({ ok: status >= 200 && status < 300, status: status, empty: delivered === 0 });
      });
      res.on('error', function (e) { kill(String(e && e.message || e), { status: status }); });
    });

    req.setTimeout(connectMs, function () {
      kill('连接超时：' + (connectMs / 1000) + ' 秒内没有任何响应', { stage: 'connect' });
    });
    req.on('error', function (e) {
      const msg = String((e && e.message) || e);
      if (aborted || msg === 'aborted' || msg.indexOf('abort') !== -1) {
        finish({ ok: false, aborted: true, error: '已停止' });
        return;
      }
      finish({ ok: false, error: msg === 'socket hang up' ? '连接被对端关闭' : msg });
    });
    if (o.body) req.write(o.body);
    req.end();
  }

  totalTimer = setTimeout(function () {
    kill('超过 ' + (totalMs / 1000) + ' 秒未完成，已中断', { timeout: true });
  }, totalMs);

  const first = validate(String(o.url || ''), allowlist);
  if (!first.ok) {
    clearTimeout(totalTimer);
    return { ok: false, error: first.error, abort: function () {} };
  }
  hop(String(o.url || ''), 0);
  return {
    ok: true,
    abort: function () { aborted = true; if (req) { try { req.destroy(); } catch (e) {} } finish({ ok: false, aborted: true, error: '已停止' }); }
  };
}

module.exports = {
  request: request, stream: stream, createJar: createJar, validate: validate, isAllowedHost: isAllowedHost,
  MAX_BYTES: MAX_BYTES, DEFAULT_TIMEOUT: DEFAULT_TIMEOUT, MAX_HOPS: MAX_HOPS,
  STREAM_CONNECT_TIMEOUT: STREAM_CONNECT_TIMEOUT, STREAM_IDLE_TIMEOUT: STREAM_IDLE_TIMEOUT,
  STREAM_TOTAL_TIMEOUT: STREAM_TOTAL_TIMEOUT, STREAM_MAX_BYTES: STREAM_MAX_BYTES
};
