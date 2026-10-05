'use strict';
/* android-shim.test.js — 安卓那一层 JS 桥的离线验收（不需要手机、不需要模拟器）
 * 运行：node test/android-shim.test.js
 *
 * 为什么这一份值钱：APK 在这台机器上跑不起来，但 android/js/df-android.js 里就是**全部的接缝**。
 * 它必须提供和 shell/preload.js 一模一样的 df 形状（少一个方法 = 界面上一颗按钮死的），
 * 也必须把 core 接对（Collector / bundleView 这类名字写错，是"装到手机上才发现"的那种错）。
 * 这份 shim 一行 DOM 都不碰，所以能在 Node 里拿假 window + 假原生桥直接跑起来验。
 *
 * 四组：A 形状对齐 preload / B 起得来（空机、有号、接口说未登录）/
 *       C 判定仍出自 core（区间、深度分析、matches 补字段、标注前缀校验）/
 *       D 导出→清空→导入整条 round-trip + "做不到就直说"那几条。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let fail = 0;
function check(name, ok, detail) {
  const good = !!ok;
  if (!good) fail++;
  console.log(`${good ? '  PASS' : '  FAIL'}  ${name}${detail !== undefined ? '  -> ' + detail : ''}`);
}

/* ------------------------------------------- 假原生：内存文件 + 假接口 */

/* ★ 桥令牌：DfBridge.java 上那句判定的对应物。
 *   测试里也必须判这颗令牌，否则"沙箱帧能不能绕过宿主"这一整层就是没测过的。 */
const TOKEN = 'aabbaabb11223344aabb11223344';

const Zip = require('../core/zip');
const zlib = require('zlib');
const crypto = require('crypto');
function sha16(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}
function zipEntries(buf) {
  const p = Zip.parse(new Uint8Array(buf));
  if (!p.ok) throw new Error('假原生读不了这个 zip：' + p.message);
  return p;
}
function inflateEntry(buf, en) {
  const raw = Buffer.from(en.raw.buffer, en.raw.byteOffset, en.raw.byteLength);
  return en.method === Zip.METHOD_DEFLATE ? zlib.inflateRawSync(raw) : raw;
}
/* 出网的线上底线：与 PluginNet.badTarget / 桌面 plugin-net.js 同一套三条 */
function badTarget(urlStr, allow) {
  let u;
  try { u = new URL(String(urlStr || '')); } catch (e) { return '网址不合法：' + urlStr; }
  const host = String(u.hostname || '').toLowerCase();
  if (u.protocol === 'https:') {
    if (u.port && u.port !== '443') return '只允许标准 https 端口';
  } else if (u.protocol === 'http:') {
    if (['127.0.0.1', 'localhost', '::1'].indexOf(host) === -1) return '明文 http 只允许本机自测，对外必须是 https';
    if (u.port && u.port !== '80') return '只允许标准 http 端口';
  } else return '只允许 https（本机自测可用 http://127.0.0.1）';
  if (!host) return '网址里没有主机名';
  const list = allow || [];
  if (list.indexOf('*') === -1 && list.map(function (x) { return String(x).toLowerCase(); })
    .indexOf(host) === -1) return '这个地址不在你批准的清单里：' + host;
  return null;
}

/* DfBridge.java：假原生照它判，静态红线也读它 —— 两边对着验才算配对 */
const JAVA_BRIDGE = fs.readFileSync(path.join(ROOT,
  'android/app/src/main/java/com/df/battleanalyzer/DfBridge.java'), 'utf8');
const JAVA_MAP_HOST = (/MAP_HOST = "([^"]+)"/.exec(JAVA_BRIDGE) || [])[1] || '';
/* ★ 同样从 Java 源里抠，不照抄 core：这一发"能到哪儿"的锁在 Java 侧，测试要对着它验 */
const JAVA_UPDATE_HOST = (/UPDATE_HOST = "([^"]+)"/.exec(JAVA_BRIDGE) || [])[1] || '';

function makeBridge(opts) {
  opts = opts || {};
  const files = Object.assign({}, opts.files || {});
  const zips = {};                       /* 选来的插件包：saveAs 之后就是这里那份字节 */
  const plugDirs = {};                   /* files/plugins/<id>/{name: Buffer} —— 模拟落盘 */
  const streams = {};                    /* 还在跑的假流 */
  const bridge = {
    files: files, calls: [], saved: [], zips: zips, plugDirs: plugDirs, streams: streams,
    /* 回包打到"这个桥所属的那个 window"上。以前是一条模块级全局路由，
     * 结果最后装载的 shim 替前面所有 shim 收了回包 —— 表现为进程静默退出、一句话不打。 */
    replyTo: null,
    call(channel, argsJson, id, tok) {
      const a = JSON.parse(argsJson || '{}');
      bridge.calls.push({ channel: channel, args: a });
      /* ★ 与 DfBridge.java 同一句判定：令牌不对，一个字也不回 */
      if (tok !== TOKEN) {
        setTimeout(function () {
          bridge.replyTo.window.__reply(id, JSON.stringify({ ok: false, error: '没有桥令牌：这一帧不是宿主主页面，原生通道不受理' }));
        }, 0);
        return;
      }
      let out;
      const pushLater = [];            /* ack 交付之后才启动的推流（见 plugin.stream） */
      const dirOf = function (x) {
        if (!plugDirs[x]) plugDirs[x] = {};
        return plugDirs[x];
      };
      const bufOf = function () {
        const b = zips[a.name];
        if (!b) return null;
        return b;
      };
      /* ★★ 下面这三条 zip.* 通道是照 DfBridge / PluginZip 的读法与措辞写的，不是照"我以为它会怎么写"。
       *   上一版假原生的 zip.read 自己开了一条 inflate 捷径（直接按 a.entry 取），而真 Java 是
       *   「借 extract 解到临时目录再读」—— 于是真机炸的「条目对照表不完整」在这套测试里全绿。
       *   参数键、对照表形状、错误前缀，一律以 Java 为准。 */
      const MAX_TEXT = 4 * 1024 * 1024;                 // = PluginZip.MAX_TEXT_BYTES
      const specsOf = function (args) {
        if (!Array.isArray(args.entries)) return null;
        return args.entries.map(function (s) {
          if (!s || typeof s !== 'object' || typeof s.want !== 'string' || typeof s.has !== 'string') {
            throw new Error('条目对照表不完整');
          }
          return s;
        });
      };
      const inflateInto = function (args, into, prefix) {
        const specs = specsOf(args);
        if (specs === null) return { ok: false, error: '没收到条目对照表（参数里的 entries）' };
        const b = bufOf();
        try {
          const p = b ? zipEntries(b) : null;
          const by = {};
          (p ? p.entries : []).forEach(function (e) { by[e.name] = e; });
          let total = 0;
          const arr = specs.map(function (s) {
            if (!Zip.isSafeRelPath(s.want) || !Zip.isSafeRelPath(s.has)) {
              throw new Error('非法的条目名：' + s.want);
            }
            if (!by[s.want]) throw new Error('包里没有这个条目：' + s.want);
            const buf = inflateEntry(b, by[s.want]);
            if (buf.length > args.maxEntry) throw new Error('解压后超过单文件上限');
            total += buf.length;
            if (total > args.maxTotal) throw new Error('解压后总大小超过上限');
            into[s.has] = buf;
            return { name: s.has, size: buf.length, hash: sha16(buf) };
          });
          return { ok: true, files: arr, totalSize: total };
        } catch (e) { return { ok: false, error: prefix + (e.message || e) }; }
      };
      if (channel === 'fs.read') {
        /* ★★ 与 DfBridge.fs.read 同一句判定：「没有这个文件」与「这个文件读不出来」是两种回话。
         *   上一版这里合成一条 null，于是"读失败→当成这台机器没数据→下一次保存把库盖掉"
         *   这条真机路径在这套测试里全绿（它自己就是那条假原生掩盖假红线的例子）。 */
        const failNow = typeof opts.readFails === 'function'
          ? !!opts.readFails(a.name) : !!(opts.readFails && opts.readFails[a.name]);
        if (failNow) {
          out = { ok: false, error: '读不出 ' + a.name + '：假原生不让读' };
        } else if (files[a.name] == null) out = { text: null, missing: true };
        else out = { text: files[a.name], missing: false };
      }
      else if (channel === 'fs.write') { files[a.name] = a.text; out = { ok: true }; }
      else if (channel === 'fs.remove') { delete files[a.name]; out = { ok: true }; }
      else if (channel === 'export.save' || channel === 'card.save') {
        /* Java 这一发是弹系统「另存为」，等 Activity 结果才回执；路径由使用者选，
         * 回的是真实显示名（不再是写死的 /sdcard/Download/…）。假原生照同一契约。 */
        const name = a.name || (channel === 'card.save' ? '战绩卡片.png' : 'unnamed.json');
        const pick = opts.saveTo ? opts.saveTo(name, channel) : name;
        if (pick === null || pick === false) out = { ok: false, cancelled: true };
        else {
          const shown = String(pick);
          bridge.saved.push({ name: shown, text: a.text, bytes: (a.b64 || '').length });
          out = { ok: true, path: shown };
        }
      }
      else if (channel === 'file.pick') {
        if (a.saveAs) {
          const b = opts.pickZip ? opts.pickZip(a) : null;
          out = b ? { ok: true, name: opts.zipName || '插件包.zip', saved: a.saveAs, size: b.length }
            : { ok: false, cancelled: !b, error: (opts.zipError || '没选中文件') };
          if (out.ok) zips[a.saveAs] = b;
        } else out = (opts.pick ? opts.pick(a) : { ok: false, cancelled: true });
      }
      else if (channel === 'zip.list') {
        const b = bufOf();
        try {
          const p = b ? zipEntries(b) : null;
          out = p ? {
            ok: true, totalSize: p.totalSize,
            entries: p.entries.map(function (e) {
              return {
                name: e.name, dir: !!e.dir, size: e.size,
                compressedSize: e.compressedSize, symlink: false
              };
            })
          } : { ok: false, error: '没有这个包' };
        } catch (e) { out = { ok: false, error: String(e.message || e) }; }
      }
      /* ★★ 这三条照 Java 的读法与措辞写（助手在通道链之前） */
      else if (channel === 'zip.audit') {
        out = inflateInto(a, {}, '解包失败：Exception: ');
      }
      else if (channel === 'zip.extract') {
        out = inflateInto(a, dirOf(a.into), '解包失败，已回滚：Exception: ');
      }
      else if (channel === 'zip.read') {
        /* 与 DfBridge 同一条路：造一张一条目的 {want,has} 对照表，借 extract 落到 peek，再读文本 */
        const peek = dirOf('peek');
        out = inflateInto({
          name: a.name, maxEntry: MAX_TEXT, maxTotal: MAX_TEXT,
          entries: [{ want: a.entry, has: a.entry }]
        }, peek, '解包失败，已回滚：Exception: ');
        if (out.ok) {
          const buf = peek[a.entry];
          out = buf ? { ok: true, text: buf.toString('utf8'), hash: sha16(buf) }
            : { ok: false, error: '文件不存在：' + a.entry };
        }
        Object.keys(peek).forEach(function (k) { delete peek[k]; });
      }
      else if (channel === 'plugin.read') {
        const buf = dirOf(a.id)[a.name];
        out = buf ? { ok: true, text: buf.toString('utf8'), hash: sha16(buf) }
          : { ok: false, error: '文件不存在：' + a.name };
      }
      else if (channel === 'plugin.hashDir') {
        const d = dirOf(a.id);
        const arr = Object.keys(d).sort().map(function (n) {
          return { name: n, size: d[n].length, hash: sha16(d[n]) };
        });
        out = {
          ok: true, files: arr,
          totalSize: arr.reduce(function (x, f) { return x + f.size; }, 0)
        };
      }
      else if (channel === 'plugin.renameDir') {
        plugDirs[a.to] = plugDirs[a.from] || {};
        delete plugDirs[a.from];
        out = { ok: true };
      }
      else if (channel === 'plugin.removeDir') {
        delete plugDirs[a.id];
        out = { ok: true };
      }
      else if (channel === 'hash.text') out = { ok: true, hash: sha16(Buffer.from(a.text || '', 'utf8')) };
      else if (channel === 'cfg.mapNames') {
        /* ★ 判定逐字照 DfBridge.java 里那道锁：主机字面量就是从那份 Java 源里抠出来的，
         *   这样"通道配对"才是真的对着 Java 验，而不是对着我自己想象的 Java 验。 */
        const url = String(a.url || '');
        if (url.indexOf('https://' + JAVA_MAP_HOST + '/') !== 0) {
          out = { ok: false, error: '地图名只允许从官方配置表那一个地址取' };
        } else if (a.method && a.method !== 'GET') {
          out = { ok: false, error: '这条通道只发 GET' };
        } else if (a.body || a.headers || a.jar) {
          out = { ok: false, error: '这一发不许带正文、请求头与 cookie 罐' };
        } else {
          out = opts.mapConfig ? opts.mapConfig(url) : { ok: false, error: '没配假配置表' };
        }
      }
      else if (channel === 'cfg.update') {
        /* 判定逐字照 DfBridge.java 里 cfg.update 那一段（GET、无正文、无 cookie 罐、只认 UPDATE_HOST） */
        const u = String(a.url || '');
        if (u.indexOf('https://' + JAVA_UPDATE_HOST + '/') !== 0) {
          out = { ok: false, error: '在线更新只允许问这一台服务器' };
        } else if (a.method && a.method !== 'GET') {
          out = { ok: false, error: '这条通道只发 GET' };
        } else if (a.body || a.headers || a.jar) {
          out = { ok: false, error: '这一发不许带正文、请求头与 cookie 罐' };
        } else {
          if (opts.updateCalls) opts.updateCalls.push({ url: u });
          out = opts.updateReply || { ok: false, status: 404, error: '没配假回包' };
        }
      }
      else if (channel === 'plugin.net') {
        const bad = badTarget(a.url, a.allow);
        if (bad) out = { ok: false, error: bad };
        else out = opts.netFetch ? opts.netFetch(a) : { ok: false, error: '没配假出口' };
      }
      else if (channel === 'plugin.stream') {
        const bad = badTarget(a.url, a.allow);
        if (bad) out = { ok: false, error: bad };
        else {
          const sid = 's' + (Object.keys(streams).length + 1);
          streams[sid] = { id: sid, killed: false };
          out = { ok: true, streamId: sid };
          const chunks = (opts.stream || []);
          /* ★ 先 ack 再推分片：真机 Java 就是「回 streamId」在前、网络线程推事件在后。
           *   排在这里会被 Node 的定时器桶赶过去（0 与 1 都归到 1ms 桶，先插先跑），
           *   于是宿主还没登记 streamId 就收到 net.open —— 那才是它唯一该丢的一帧。 */
          pushLater.push(function () {
            (opts.streamHold && String(a.body || '').indexOf('"hold":true') >= 0
              ? chunks.filter(function (c) { return c.type !== 'net.end'; }) : chunks)
              .forEach(function (c, i) {
                setTimeout(function () {
                  if (!streams[sid] || streams[sid].killed || !bridge.replyTo) return;
                  bridge.replyTo.window.__nativeEvent('plugin:net',
                    { streamId: sid, type: c.type, data: c.data || {} });
                }, 2 + i * 3);
              });
          });
        }
      }
      else if (channel === 'plugin.abort') {
        const s = streams[a.streamId];
        if (s) { s.killed = true; delete streams[a.streamId]; }
        out = { ok: true, killed: s ? 1 : 0 };
      }
      else if (channel === 'net.post') {
        if (String(a.pathname).indexOf('/api/v1/wegame.pallas.dfm.DfmBattle/') !== 0) {
          out = { ok: false, error: '采集通道只认 WeGame 战绩接口前缀' };
        } else out = opts.net ? opts.net(a) : { ok: false, error: '没配假接口' };
      }
      /* cleared:true 是照 DfBridge.java 抄的 —— LoginActivity.onCreate 在 loadUrl 之前一定先
       * wipeSession()，所以每一窗都是全新会话；界面那句"已清掉旧登录痕迹"只认这个字段。 */
      else if (channel === 'login.open') out = { ok: true, slot: a.slot || '', cleared: true };
      else if (channel === 'login.clearCookies') out = { ok: true };
      else if (channel === 'card.copy') {
        /* 和 DfBridge.java 同一句实话：这一版只许存，不许复制 */
        out = { ok: false, error: '安卓版暂时只能「保存卡片」到文件，复制未实现' };
      }
      else if (channel === 'open.url' || channel === 'clipboard' || channel === 'toast') out = { ok: true };
      else if (channel === 'app.info') {
        out = { version: 'test', platform: 'android', dataDir: '/files', exportDir: '/dl' };
      }
      /* 认不出来的通道回「未知通道」，跟 Java 侧一模一样：
       * 假成功会把"壳喊了一个 Java 没有的通道"这种接缝错位盖成一片绿。 */
      else out = { ok: false, error: '未知通道 ' + channel };
      setTimeout(function () {
        if (!bridge.replyTo) throw new Error('测试台忘了给这个桥接 reply 目标（call=' + channel + '）');
        bridge.replyTo.window.__reply(id, JSON.stringify(out));
        pushLater.forEach(function (f) { f(); });
      }, (channel === 'net.post' && opts.netDelayMs) ? opts.netDelayMs : 0);
    }
  };
  return bridge;
}

function loadShim(bridge, opts) {
  opts = opts || {};
  const realSetTimeout = setTimeout;
  /* clampTimers：只把 shim 自己那颗看门狗压到几毫秒，好在这份离线测试里验它，
   * 不至于为了看一次"没回话"真等 45 秒。setInterval 不压（轮询节奏保持原样）。 */
  const st = opts.clampTimers
    ? function (fn, ms) { return realSetTimeout(fn, Math.min(Number(ms) || 0, 4)); }
    : setTimeout;
  const sandbox = {
    console: console, JSON: JSON, Promise: Promise, Date: Date, Math: Math,
    Object: Object, Array: Array, String: String, Number: Number, RegExp: RegExp,
    Error: Error, setTimeout: st, clearTimeout: clearTimeout,
    setInterval: setInterval, clearInterval: clearInterval,
    encodeURIComponent: encodeURIComponent, AndroidBridge: bridge,
    /* 壳加载首页时把令牌挂在 URL 查询串上（MainActivity）—— 沙箱帧拿不到它 */
    location: { search: '?bt=' + TOKEN, href: 'https://dfapp.local/app/ui/index.html?bt=' + TOKEN },
    fetch: function (u) {
      const text = String(fs.readFileSync(path.join(ROOT, 'ui', 'css',
        path.basename(String(u))), 'utf8'));
      return Promise.resolve({ text: function () { return Promise.resolve(text); } });
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.DFCore = {
    Maps: require('../core/maps'), MapConfig: require('../core/mapConfig'),
    Update: require('../core/update'),
    Stats: require('../core/stats'),
    Async: require('../core/async'), Normalize: require('../core/normalize'),
    Store: require('../core/store'), Collector: require('../core/collector'),
    Analysis: require('../core/analysis'), Plugin: require('../core/plugin'),
    Zip: require('../core/zip'), AiDigest: require('../core/aiDigest')
  };
  bridge.replyTo = sandbox;
  vm.createContext(sandbox);
  /* 顺序与 tools/build-android-assets.js 的注入一致：core → 插件宿主 → 桥 → 界面 */
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'android/js/plugin-host.js'), 'utf8'),
    sandbox, { filename: 'plugin-host.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'android/js/df-android.js'), 'utf8'),
    sandbox, { filename: 'df-android.js' });
  return sandbox;
}

/* ------------------------------------------- 一份真样本灌出来的库（core 亲手做的） */

const SAMPLE = JSON.parse(fs.readFileSync(
  path.join(ROOT, '..', 'df-analyzer', 'sample', 'sample_data.json'), 'utf8'));
const SLOT = 'm12345678';
const SLOT_FILE = 'df-swtwr-' + SLOT + '.json';
const ACCOUNTS = JSON.stringify({
  version: 1, activeSlot: SLOT, globalSettings: {},
  accounts: [{ slot: SLOT, openid: '12345678', name: '测试号', area: 36, created_at: 1, last_sync: 2 }]
});

async function seed() {
  const Store = require('../core/store').Store;
  let state = null;
  const s = new Store({ load: function () { return null; }, save: function (x) { state = x; } });
  await s.load();
  await s.ingest(SAMPLE);
  return state;
}

async function main() {
  const seeded = await seed();
  const SEED = JSON.stringify(seeded);
  const matchCount = Object.keys(seeded.matches).length;
  check('测试台自己可信：样本能灌进 core', matchCount > 3, matchCount + ' 场');

  const ROLE_OK = { ok: true, text: JSON.stringify({
    result: { error_code: 0 },
    role_info: { openid: '12345678', area: 36, name: '测试号', level: 50, tdmLevel: 9 } }) };
  const NOT_LOGIN = { ok: true, text: JSON.stringify({
    result: { error_code: 8000102, error_message: 'not login' } }) };

  /* ---------------- A 形状对齐 preload ---------------- */
  console.log('\n[A] df 的形状必须包住 shell/preload.js 暴露的每一个方法');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'shell/preload.js'), 'utf8');
  const body = /exposeInMainWorld\('df', \{([\s\S]*)\n\}\);/.exec(preloadSrc)[1];
  /* 命名空间型成员（下面是方法而不是它自己是个方法）单独交给 nested() 逐条核对 */
  const NAMESPACES = ['plugin', 'accounts', 'mapNames', 'update'];
  const topMethods = body.split('\n')
    .map(function (l) { return (/^  ([a-zA-Z]+):/.exec(l) || [])[1]; })
    .filter(function (k) { return k && NAMESPACES.indexOf(k) === -1; });
  const nested = function (ns) {
    const m = new RegExp(ns + ': \\{([\\s\\S]*?)\\n  \\}').exec(preloadSrc);
    return m ? (m[1].match(/^    ([a-zA-Z]+):/gm) || [])
      .map(function (s) { return s.trim().replace(':', ''); }) : [];
  };
  const shimSrc = fs.readFileSync(path.join(ROOT, 'android/js/df-android.js'), 'utf8');
  const w0 = loadShim(makeBridge({}));
  const df0 = w0.window.df;
  const missing = topMethods.filter(function (k) { return typeof df0[k] !== 'function'; });
  check('★ 顶层方法一个都不许缺（' + topMethods.length + ' 个）', missing.length === 0,
    missing.join(' ') || '全部就位');
  const pm = nested('plugin'), am = nested('accounts'), nm = nested('mapNames'), um = nested('update');
  const nestedOk = function (ns, names) {
    const o = df0[ns] || {};
    return names.length > 0 && names.every(function (k) { return typeof o[k] === 'function'; });
  };
  check('★ df.plugin.*（' + pm.length + '）、df.accounts.*（' + am.length +
    '）、df.mapNames.*（' + nm.length + '）、df.update.*（' + um.length + '）同样一条不缺',
    nestedOk('plugin', pm) && nestedOk('accounts', am) && nestedOk('mapNames', nm) && nestedOk('update', um),
    'plugin=' + pm.join(',') + ' accounts=' + am.join(',') + ' mapNames=' + nm.join(','));
  const list = function (src, re) {
    return re.exec(src)[1].split(',').map(function (s) {
      return s.trim().replace(/'/g, '');
    }).filter(Boolean);
  };
  const evA = list(preloadSrc, /const allow = \[([\s\S]*?)\];/);
  const evB = list(shimSrc, /var ALLOW_EVENTS = \[([\s\S]*?)\];/);
  check('★ 事件白名单两边一字不差（多一条少一条都是接缝错位）',
    evA.slice().sort().join('|') === evB.slice().sort().join('|'),
    'preload=' + evA.length + ' shim=' + evB.length);

  /* 壳喊过的原生通道，必须正好是 Java 那边会答的那一批：
   * 手机上"点了没反应"这种 bug 在这台机器上永远测不出来，只能拿源码对源码。 */
  const javaSrc = fs.readFileSync(
    path.join(ROOT, 'android/app/src/main/java/com/df/battleanalyzer/DfBridge.java'), 'utf8');
  const grab = function (src, re) {
    const out = {};
    let m;
    while ((m = re.exec(src))) out[m[1]] = 1;
    return Object.keys(out).sort();
  };
  /* 字符类别放宽到"任何名字"：收紧的模式会把认不出来的通道**静默跳过**，
   * 拼错的通道就从比对里消失了 —— 变异验证试出来过，别再犯一次。
   * ★ 两条 JS 半边都要扫：插件宿主同样在喊原生通道，漏了它等于这批通道从没被对过。 */
  const hostSrc = fs.readFileSync(path.join(ROOT, 'android/js/plugin-host.js'), 'utf8');
  const chShim = grab(shimSrc, /to\('([^']+)'/g).concat(grab(hostSrc, /to\('([^']+)'/g))
    .filter(function (c, i, arr) { return arr.indexOf(c) === i; }).sort();
  const chJava = grab(javaSrc, /"([^"]+)"\.equals\(channel\)/g);
  const orphan = chShim.filter(function (c) { return chJava.indexOf(c) === -1; });
  check('★ 原生通道两边成对：壳喊的 Java 全都会答（' + chShim.length + ' 条）',
    orphan.length === 0,
    orphan.join(' ') || '无孤儿通道（java=' + chJava.length + '）');
  const deadJava = chJava.filter(function (c) { return chShim.indexOf(c) === -1; });
  check('★ 反方向也成对：Java 里没有"没人喊"的通道（多一条洞就多一条）',
    deadJava.length === 0, deadJava.join(' ') || '无空开通道');

  /* ★★ 通道名对上还不算对上，**参数键**也要成对。
   *   2026-09-24 在 MuMu 上真炸的两处都是这一类：zip.audit / zip.extract 读的是 names，
   *   而 JS 发的是 entries ⇒ Java 拿到 null ⇒ NullPointerException；
   *   zip.read 内部又把"一个名字"当对照表递给 extract ⇒ 「条目对照表不完整」。
   *   假原生当时全绿 —— 因为它按"我以为 Java 会怎么读"写，而不是按 Java 实际读的那几个键写。
   *   所以这一条拿源码对源码：Java 读的键，JS 必须发得出。 */
  /* ★ 括号配对必须**跳过字符串与注释**：DfBridge 里 plugin.renameDir 有一句字面量
   *   "{\"ok\":true" —— 不带引号感知的计数器会把它当开括号，于是那个块一路吞到
   *   plugin.net / plugin.stream，凭空报出一串"缺键"。这类假红比真红更贵，先修判据。 */
  const bracedBody = function (src, openIdx) {
    let depth = 0, i = openIdx;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === '"' || c === '\'') {                    // 跳过字符串字面量
        const q = c; i++;
        while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      } else if (c === '/' && src[i + 1] === '/') {      // 行注释
        while (i < n && src[i] !== '\n') i++;
        continue;
      } else if (c === '/' && src[i + 1] === '*') {
        i = src.indexOf('*/', i + 2) + 1;
      } else if (c === '{') {
        depth++;
        if (depth === 1) { openIdx = i; }
      } else if (c === '}') {
        depth--;
        if (depth === 0) return src.slice(openIdx + 1, i);
      }
      i++;
    }
    return null;
  };
  const topKeys = function (body) {
    const keys = [];
    let d = 0;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '"' || c === '\'') { const q = c; i++; while (i < body.length && body[i] !== q) { if (body[i] === '\\') i++; i++; } continue; }
      if (c === '{' || c === '(' || c === '[') d++;
      else if (c === '}' || c === ')' || c === ']') d--;
      else if (d === 0 && /[A-Za-z_$]/.test(c)) {
        const m = /^[A-Za-z_$][\w$]*\s*:/.exec(body.slice(i));
        const head = body.slice(0, i);
        /* 合法起点 = 字面量开头（前面只有空白）或紧跟在 { , 之后 */
        if (m && (/^\s*$/.test(head) || /[{,]\s*$/.test(head))) keys.push(m[0].replace(/\s*:$/, ''));
        i += m ? m[0].length - 1 : 0;
      }
    }
    return keys;
  };
  const objKeys = function (src, from) {
    const open = src.indexOf('{', from);
    if (open < 0) return null;
    const body = bracedBody(src, open);
    return body === null ? null : topKeys(body);
  };
  const jsArgs = {};
  let unparsed = 0;
  [shimSrc, hostSrc].forEach(function (src) {
    const re = /to\('([^']+)'\s*(,)?/g;
    let m;
    while ((m = re.exec(src))) {
      const chan = m[1];
      if (!m[2]) { jsArgs[chan] = jsArgs[chan] || []; continue; }   // 无参调用
      const keys = objKeys(src, re.lastIndex);
      if (!keys) { unparsed++; continue; }
      jsArgs[chan] = (jsArgs[chan] || []).concat(keys)
        .filter(function (k, i, arr) { return arr.indexOf(k) === i; });
    }
  });
  /* Java 侧：每个 "chan".equals(channel) 块里 a.optXXX("键") 读到的键 */
  const javaArgs = {};
  chJava.forEach(function (chan) {
    const at = javaSrc.indexOf('"' + chan + '".equals(channel)');
    const open = at < 0 ? -1 : javaSrc.indexOf('{', at);
    const block = open < 0 ? null : bracedBody(javaSrc, open);
    const read = [];
    if (block) {
      let mm;
      const kre = /\ba\.opt[A-Za-z]+\("([^"]+)"/g;
      while ((mm = kre.exec(block))) read.push(mm[1]);
    }
    javaArgs[chan] = read.filter(function (k, i, arr) { return arr.indexOf(k) === i; });
  });
  /* ★ 例外只准是"Java 自己会补"的可选键，写清楚为什么；缺了理由的例外就是漏。
   *   plugin.stream：streamId 由原生在缺省时生成（JS 传了才用传的），所以 JS 不传是对的。 */
  const OPTIONAL = { 'plugin.stream': ['streamId'] };
  const missingKeys = chShim.filter(function (c) {
    const need = (javaArgs[c] || []).filter(function (k) {
      return (OPTIONAL[c] || []).indexOf(k) === -1;
    });
    const sent = jsArgs[c] || [];
    return need.some(function (k) { return sent.indexOf(k) === -1; });
  }).map(function (c) {
    return c + ' 缺 ' + (javaArgs[c] || []).filter(function (k) {
      return (jsArgs[c] || []).indexOf(k) === -1 && (OPTIONAL[c] || []).indexOf(k) === -1;
    }).join('/');
  });
  check('★ 抽不出参数键的调用点必须是 0（认不出来就报红，别静默跳过）',
    unparsed === 0, 'unparsed=' + unparsed + '，通道数=' + Object.keys(jsArgs).length);
  check('★★ 参数键两边成对：Java 读的键，JS 一定发得出（'
    + chShim.reduce(function (n, c) { return n + (javaArgs[c] || []).length; }, 0) + ' 个键）',
    missingKeys.length === 0, missingKeys.join(' | ') || '无缺键通道');

  /* ★★ "等手指"的通道必须都换成长表。Java 侧判据是现成的：dispatch 里
   *   `return null` 表示"这一条不立即回执（等 Activity 结果）"，另存为走 askSaveAs 同理。
   *   新加一条这样的通道而忘了进 HUMAN_CHANNELS ⇒ 用户在面板里挑超过 45 秒，
   *   页面报「没回话」而原生稍后照样成功 —— 2026-09-24 在 MuMu 上真撞到了。 */
  const waitsForHuman = chJava.filter(function (c) {
    const at = javaSrc.indexOf('"' + c + '".equals(channel)');
    const block = at < 0 ? '' : (bracedBody(javaSrc, javaSrc.indexOf('{', at)) || '');
    return /return\s+null\s*;/.test(block) || /askSaveAs\(/.test(block);
  }).sort();
  const humanTable = (function () {
    const m = /var HUMAN_CHANNELS = \{([^}]*)\}/.exec(shimSrc);
    return m ? (m[1].match(/'([^']+)'\s*:/g) || [])
      .map(function (s) { return s.replace(/[':\s]/g, ''); }).sort() : [];
  })();
  check('★★ 等 Activity 结果的通道全都在长表里（' + waitsForHuman.join(' ') + '）',
    waitsForHuman.length > 0 && waitsForHuman.join('|') === humanTable.join('|'),
    'java=' + waitsForHuman.join(' ') + ' 表=' + humanTable.join(' '));

  /* ★★ 安卓那份 core 拼接顺序 = 依赖顺序，不是"能跑就行"。
   *   每个 core 文件的 UMD 头在**被加载的那一刻**去 root.DFCore 上取依赖，取早了就是
   *   undefined；而 Node 里 require('./zip') 会自己解析，所以这张表排错，离线测试一个字都不报。
   *   2026-09-24 手机上「Cannot read properties of undefined (reading 'isSafeRelPath')」
   *   （导入插件必现）就是这么来的：plugin 排在 zip 前面。 */
  const assetsSrc = fs.readFileSync(
    path.join(ROOT, 'tools/build-android-assets.js'), 'utf8');
  const coreOrder = ((/CORE_ORDER = \[([\s\S]*?)\];/.exec(assetsSrc) || [])[1] || '')
    .match(/'([^']+)'/g).map(function (s) { return s.replace(/'/g, ''); });
  const exportOf = {}, depsOf = {};
  coreOrder.forEach(function (n) {
    const src = fs.readFileSync(path.join(ROOT, 'core', n + '.js'), 'utf8');
    const head = /root\.DFCore\.([A-Za-z]+)\s*=\s*factory\(([^)]*)\)/.exec(src);
    if (!head) { exportOf[n] = ''; return; }
    exportOf[n] = head[1];
    depsOf[n] = (head[2].match(/root\.DFCore\.([A-Za-z]+)/g) || [])
      .map(function (s) { return s.replace('root.DFCore.', ''); });
  });
  const idxOfExport = {};
  coreOrder.forEach(function (n) { if (exportOf[n]) idxOfExport[exportOf[n]] = n; });
  const lateDeps = coreOrder.filter(function (n) {
    return (depsOf[n] || []).some(function (d) {
      return idxOfExport[d] === undefined || coreOrder.indexOf(idxOfExport[d]) >= coreOrder.indexOf(n);
    });
  }).map(function (n) {
    return n + ' 在 ' + (depsOf[n] || []).filter(function (d) {
      return idxOfExport[d] === undefined || coreOrder.indexOf(idxOfExport[d]) >= coreOrder.indexOf(n);
    }).join('/') + ' 之前';
  });
  check('★ 每个 core 文件都真的在 CORE_ORDER 里（漏一个 = 手机上少一个 DFCore.*）',
    coreOrder.length >= 11 && coreOrder.every(function (n) {
      return fs.existsSync(path.join(ROOT, 'core', n + '.js'));
    }), coreOrder.join(','));
  check('★★ 安卓 core 拼接顺序满足依赖顺序（UMD 头现算，不靠人记）',
    lateDeps.length === 0, lateDeps.join(' | ') || '全部依赖都在前面');

  /* ---------------- B 起得来 ---------------- */
  console.log('\n[B] boot 的三条路');
  await w0.window.__dfReady;
  const b0 = await df0.boot();
  check('空机也能 boot：不崩、给出「尚未添加账号」、matchCount 归零',
    b0 && b0.loggedIn === false && /尚未添加账号/.test(b0.bootError || '') && b0.matchCount === 0,
    b0 && b0.bootError);
  check('空机上那颗「打开登录窗口」仍然是个函数', typeof df0.openLogin === 'function');

  const w1 = loadShim(makeBridge({
    files: { 'accounts.json': ACCOUNTS, [SLOT_FILE]: SEED }, net: function () { return ROLE_OK; }
  }));
  await w1.window.__dfReady;
  const b1 = await w1.window.df.boot();
  check('有账号：报已登录、带出真实统计与昵称',
    b1.loggedIn === true && b1.stats.matches === matchCount && b1.name === seeded.meta.name,
    'matches=' + b1.stats.matches + ' name=' + b1.name);
  const w2 = loadShim(makeBridge({
    files: { 'accounts.json': ACCOUNTS, [SLOT_FILE]: SEED }, net: function () { return NOT_LOGIN; }
  }));
  await w2.window.__dfReady;
  const b2 = await w2.window.df.boot();
  check('★ 未登录回码：loggedIn=false 且 matchCount 不塌（离线看库这条承诺）',
    b2.loggedIn === false && b2.matchCount === matchCount && /not login|8000102/.test(b2.loginError),
    'loginError=' + b2.loginError + ' matchCount=' + b2.matchCount);
  check('★ 那 8 秒没被人动（boot=8000 / login:check=10000，用户长期裁定）',
    /,\s*8000,/.test(shimSrc) && /10000,/.test(shimSrc));

  /* ---------------- C 判定出自 core ---------------- */
  console.log('\n[C] 判定与分析仍然全部出自 core');
  const rep = await w1.window.df.report({ mode: 'all', leave: 'all', since: 0 });
  check('report 带 v1.8.0 的 95% 区间（说明真的是 core 在算，不是壳糊一个）',
    rep && rep.summary && rep.summary.ci && rep.summary.ci.lo !== undefined,
    '胜率=' + (rep.summary && rep.summary.winRate) + ' 区间=' +
    (rep.summary && rep.summary.ci ? rep.summary.ci.lo + '~' + rep.summary.ci.hi : '无'));
  check('四块深度分析都还在 report 里',
    !!(rep.winLoss && rep.durations && rep.strength && rep.structure));
  const rows = await w1.window.df.matches({ mode: 'all', leave: 'all' });
  check('matches 补齐 force_name / hasRoster / watchedCount',
    rows.length > 0 && 'force_name' in rows[0] && 'hasRoster' in rows[0] &&
    'watchedCount' in rows[0], rows.length + ' 行');
  const one = await w1.window.df.match(rows[0].room_id);
  check('单场大厅装配了 tips 且能序列化（detail 页吃得下）',
    one && Array.isArray(one.tips) && JSON.stringify(one).length > 200,
    'tips=' + (one && one.tips.length));

  /* ★ 半份名单：官方"战局列表"与"单局详情"填列有先后，同一场两份会不一致。
   *   用户报的那条"战局里救治正常、单场详情里救治不对"就是这么来的：
   *   半份快照被永久钉死（入库只比人数）+ 有名单就再也不抓这场 + 拿它算排名。
   *   安卓这边只验接缝（行带不带 rosterGaps、详情作废没作废），判据本身在 core 那 25 条里钉。 */
  const halfState = JSON.parse(JSON.stringify(seeded));
  const HALF_ME = String(halfState.meta.openid);
  const HALF_ROOM = Object.keys(halfState.rosters).filter(function (r) {
    return halfState.matches[r] && (halfState.rosters[r].players || []).some(function (p) {
      return String(p.vopenid) === HALF_ME;
    });
  })[0];
  halfState.matches[HALF_ROOM].rescue = 36;
  halfState.rosters[HALF_ROOM].players.forEach(function (p) {
    if (String(p.vopenid) === HALF_ME) p.rescue = 0;
  });
  const wh = loadShim(makeBridge({
    files: { 'accounts.json': ACCOUNTS, [SLOT_FILE]: JSON.stringify(halfState) },
    net: function () { return ROLE_OK; }
  }));
  await wh.window.__dfReady;
  await wh.window.df.boot();
  const halfRows = await wh.window.df.matches({ mode: 'all', leave: 'all' });
  const halfRow = halfRows.filter(function (r) { return r.room_id === HALF_ROOM; })[0];
  check('★ 安卓战局列表行带 rosterGaps（与桌面 data:matches 同形，界面据此挂「名单不全」）',
    !!halfRow && Array.isArray(halfRow.rosterGaps) && halfRow.rosterGaps.join() === 'rescue',
    JSON.stringify(halfRow && halfRow.rosterGaps));
  check('其余场次不受牵连（一行了缺值不等于全场都缺）',
    halfRows.filter(function (r) { return r.room_id !== HALF_ROOM; })
      .every(function (r) { return (r.rosterGaps || []).length === 0; }),
    halfRows.length + ' 行里只有 1 行有缺值');
  const halfDetail = await wh.window.df.match(HALF_ROOM);
  check('★ 安卓单场详情同样作废救治排名与救治榜（不许给一个看起来很正常的假名次）',
    halfDetail && halfDetail.ranks.rescue.rank === null && halfDetail.boards.rescue === null &&
    halfDetail.ranks.score.rank > 0,
    '救治=' + JSON.stringify(halfDetail && halfDetail.ranks.rescue) +
    ' 得分第' + (halfDetail && halfDetail.ranks.score.rank));
  const mainSyncSrc = fs.readFileSync(path.join(ROOT, 'shell/main.js'), 'utf8');
  check('★★ 两个壳同步时的「已有名单」都必须走 trustedRosterRoomIds（退回 Object.keys(rosters) 就是永不重抓）',
    /haveRosters:\s*store\.trustedRosterRoomIds\(\)/.test(mainSyncSrc) &&
    /haveRosters:\s*store\.trustedRosterRoomIds\(\)/.test(shimSrc), '两端都在这颗判据上');
  /* data:matches 的行映射一共三份实现：桌面 main.js、安卓 shim、还有浏览器里验界面用的
   * test/preview-server.js。少一处不是"少个字段"那么简单 —— 预览里看不到「名单不全」，
   * 就等于这条界面从来没被端到端验过（这次预览服务正是这么漏的）。 */
  const ROW_MAPS = ['shell/main.js', 'android/js/df-android.js', 'test/preview-server.js'];
  const rowMapSrc = ROW_MAPS.map(function (p) {
    return [p, fs.readFileSync(path.join(ROOT, p), 'utf8')];
  });
  const rowMapMissing = rowMapSrc.filter(function (x) {
    return !/rosterGaps:\s*store\.rosterGaps\(m\.room_id\)/.test(x[1]);
  }).map(function (x) { return x[0]; });
  check('★ 三处列表行映射（桌面 / 安卓 / 预览服务）都挂 rosterGaps（少一处就是那条界面没被端到端验过）',
    rowMapSrc.length === 3 && rowMapMissing.length === 0,
    rowMapMissing.join(' ') || ROW_MAPS.join(' · '));
  const badWatch = await w1.window.df.setWatch('slot:临时编号', true, {});
  check('★ 关注键前缀校验还在（任意字符串进不了存储）',
    badWatch.ok === false && /临时编号/.test(badWatch.error), JSON.stringify(badWatch));
  const badFlag = await w1.window.df.setFlag(rows[0].room_id, 'dropTable', true);
  check('标注只认 commander / excluded / competition 三枚', badFlag.ok === false, JSON.stringify(badFlag));

  /* ★ 比赛这一枚必须端到端跑一遍桥：filtersArgs / matches / counts 里少带一个 kind，
   *   手机上就是"点了没反应"，而数源码字符串的红线看不见这件事（预览服务当年正是这么漏的）。 */
  const compRow = rows.filter(function (r) { return r.is_swtwr && !r.excluded; })[0];
  check('样本里有可标比赛的胜者为王场（常规场不许标）', !!compRow, rows.length + ' 行');
  const plainRow = rows.filter(function (r) { return !r.is_swtwr && !r.excluded; })[0];
  const setCompBad = await w1.window.df.setFlag(plainRow.room_id, 'competition', true);
  check('安卓桥也拒绝给常规场标比赛',
    setCompBad.ok === false && setCompBad.error === '比赛标记仅适用于胜者为王对局',
    JSON.stringify(setCompBad));
  const setComp = await w1.window.df.setFlag(compRow.room_id, 'competition', true);
  check('安卓桥 setFlag 认 competition 并回显',
    setComp.ok === true && setComp.flags.competition === 1, JSON.stringify(setComp));
  const compRows = await w1.window.df.matches({ mode: 'all', kind: 'comp', leave: 'all' });
  check('★ 安卓桥 matches 把 kind 一路带到 core（列表里只剩刚标那一场）',
    compRows.length === 1 && compRows[0].room_id === compRow.room_id,
    JSON.stringify(compRows.map(function (r) { return r.room_id; })));
  const repComp = await w1.window.df.report({ mode: 'all', kind: 'comp', leave: 'all' });
  check('★ 安卓桥 report 的 kind 生效，口径文案跟着走',
    repComp.filtered.total === 1 && repComp.filters.kind === 'comp' &&
    repComp.filterKindLabel === '比赛对局（你手动标的）',
    'total=' + repComp.filtered.total + ' 文案=' + repComp.filterKindLabel);
  const cntComp = await w1.window.df.counts();
  check('counts 给出 comp / practice 且两桶之和 == all（一场都不许掉在两边外）',
    cntComp.comp === 1 && cntComp.comp + cntComp.practice === cntComp.all, JSON.stringify(cntComp));
  await w1.window.df.setFlag(compRow.room_id, 'competition', false);
  const backRows = await w1.window.df.matches({ mode: 'all', kind: 'practice', leave: 'all' });
  check('取消后这一场回到匹配那边（可逆、不留残值）',
    backRows.some(function (r) { return r.room_id === compRow.room_id; }) &&
    (await w1.window.df.matches({ mode: 'all', kind: 'comp', leave: 'all' })).length === 0);

  /* ---------------- D round-trip 与诚实 ---------------- */
  console.log('\n[D] 导出 → 清空 → 导入，与「做不到就直说」');
  const plug = await w1.window.df.plugin.inspect();
  check('没选中文件就如实回 cancelled（不许静默回成功）',
    plug.ok === false && plug.cancelled === true, JSON.stringify(plug));
  const pl0 = await w1.window.df.plugin.list();
  check('一台没装过插件的机器上 list 也说得出宿主版本（界面靠它判兼容）',
    pl0.ok === true && pl0.plugins.length === 0 && pl0.hostVersion === require('../core/plugin').HOST_VERSION,
    'hostVersion=' + pl0.hostVersion);
  check('复制卡片 / 备份 都如实回错误并指路，不假装成功',
    /未实现/.test(JSON.stringify(await w1.window.df.copyCard({ dataUrl: 'x' }))) &&
    /数据包/.test(JSON.stringify(await w1.window.df.backupNow())));

  let picked = '';
  const br = makeBridge({
    files: { 'accounts.json': ACCOUNTS, [SLOT_FILE]: SEED },
    net: function () { return ROLE_OK; },
    pick: function () { return { ok: true, name: '数据包.json', text: picked }; }
  });
  const w3 = loadShim(br);
  await w3.window.__dfReady;
  const exp = await w3.window.df.exportData('json', { mode: 'all', leave: 'all' });
  const dump = br.saved.length ? JSON.parse(br.saved[br.saved.length - 1].text) : null;
  check('导出：走原生 export.save，内容是真的 bundleView 那一族字段',
    exp.ok === true && !!(dump && dump.matches && dump.report && Object.keys(dump.matches).length),
    'matches=' + (dump ? Object.keys(dump.matches).length : 0) +
    ' 字节=' + (br.saved.length ? br.saved[0].text.length : 0));
  /* ★★ 导出那两发的**字段清单由界面定义**，不在这里另抄一份（照 E4 的做法）：
   *   从 ui/js/app.js 里把两个处理器读到的 r.xxx 抽出来，再量实际返回。
   *   手机上那句 toast 会念成「已导出 undefined 场」就是这一类 —— Java 只回 {ok,path}，
   *   而界面读 count / matches / rosters（桌面 data:export 与 data:bundle 一直带着）。 */
  const appSrc = fs.readFileSync(path.join(ROOT, 'ui/js/app.js'), 'utf8');
  const sliceApp = function (from, to) {
    const a = appSrc.indexOf(from), b = appSrc.indexOf(to, a + 1);
    return a < 0 || b < 0 ? '' : appSrc.slice(a, b);
  };
  const readFields = function (body) {
    return (body.match(/\br\.[a-zA-Z]+/g) || []).map(function (s) { return s.slice(2); })
      .filter(function (k) { return k !== 'ok' && k !== 'error' && k !== 'cancelled'; })
      .filter(function (k, i, arr) { return arr.indexOf(k) === i; }).sort();
  };
  const expWant = readFields(sliceApp('df.exportData(fmt', ').catch(function (e)'));
  const bundleBody = sliceApp("$('btnBundle')", "$('btnRestore')");
  const bundleWant = readFields(bundleBody);
  const bund = await w3.window.df.bundle();
  check('★ 界面确实从导出结果里读字段（抽不到 = 这条红线形同虚设）',
    expWant.length > 0 && bundleWant.length > 0,
    'exportData=' + expWant.join(',') + ' bundle=' + bundleWant.join(','));
  const expMiss = expWant.filter(function (k) { return exp[k] === undefined; });
  const bunMiss = bundleWant.filter(function (k) { return bund[k] === undefined; });
  check('★★ 导出返回带着界面要读的每个字段（手机上不许念出 undefined）',
    expMiss.length === 0 && bunMiss.length === 0,
    'exportData 缺 ' + expMiss.join(',') + ' | bundle 缺 ' + bunMiss.join(',') +
    ' → 实得 count=' + exp.count + ' matches=' + bund.matches + ' rosters=' + bund.rosters);
  const cleared = await w3.window.df.reset('current');
  const afterReset = JSON.parse(br.files[SLOT_FILE]).matches;
  check('清空当前号真的清空了（且文件仍是合法 JSON，不留坏档）',
    cleared.ok === true && Object.keys(afterReset).length === 0,
    matchCount + ' → ' + Object.keys(afterReset).length);
  picked = SEED;
  const restored = await w3.window.df.restore();
  check('★ 导入数据包：合并判据跑通，加回来的场次数与清空前一致',
    restored.ok === true && restored.added === matchCount, JSON.stringify(restored));
  const again = await w3.window.df.restore();
  check('同一份包再导一次不重复计（按 roomId 去重）',
    again.ok === true && again.added === 0 && again.dup === matchCount, JSON.stringify(again));
  const names = br.calls.filter(function (c) { return c.args.name; })
    .map(function (c) { return c.args.name; });
  check('★ 发给原生的文件名里没有任何路径记号（消毒只在一处）',
    names.every(function (n) { return !/[\/\\]|\.\./.test(n); }),
    names.slice(0, 3).join(', ') || '（无）');

  /* Java 侧一句话都不回时，界面不能永远转圈 —— 这一条就是那次"进程静默退出、
   * 一个字都没打"的现场复现：桥没有看门狗，"坏了"和"还在忙"长得一模一样。 */
  const dead = makeBridge({});
  dead.call = function () { /* 吞掉所有调用 */ };
  const w4 = loadShim(dead, { clampTimers: true });
  await w4.window.__dfReady;
  const tHang = Date.now();
  const deadRes = await w4.window.df.info();
  check('★ 原生不回话：桥自己撒手并报错，不留下永远转圈的界面',
    deadRes && deadRes.ok !== true && /没回话/.test(deadRes.error || ''),
    JSON.stringify(deadRes) + '（' + (Date.now() - tHang) + 'ms，看门狗已压到 4ms 才敢在这跑）');
  const deadBoot = await w4.window.df.boot();
  check('★ 同一条死通道下 boot 仍然给得出空机界面（不被卡死）',
    deadBoot && deadBoot.loggedIn === false && deadBoot.matchCount === 0);

  /* ---------------- E 真机回归（这三条都是他装到手机上才撞出来的） ---------------- */
  console.log('\n[E] 真机那三条：形状契约 / 常量对齐 / 登录完得真进得去');

  /* E1 ★ 桌面上 window.df 每个方法都是 ipcRenderer.invoke ⇒ 恒回 Promise。
   *    上一版 shim 的 report/matches/counts/match/encounterDetail 同步返回裸值，
   *    界面里 `df.match(rid).then(...)` 当场炸 —— 真机表现：单场详情永远转圈。
   *    所以这条红线由**界面的真实调用点**驱动：凡是 `.then(` 跟在后头的，都必须拿到 thenable。 */
  const ROOM = rows[0].room_id;
  const chained = {};
  fs.readdirSync(path.join(ROOT, 'ui/js')).filter(function (f) { return /\.js$/.test(f); })
    .forEach(function (f) {
      const src = fs.readFileSync(path.join(ROOT, 'ui/js', f), 'utf8');
      const re = /\bdf\.([a-zA-Z]+)\s*\(([^()]*)\)\s*\.(?:then|catch|finally)\b/g;
      let m;
      while ((m = re.exec(src))) (chained[m[1]] = chained[m[1]] || []).push(f);
    });
  /* 这五个在界面里走 Promise.all，正则抓不到，但契约一样是 Promise */
  ['report', 'matches', 'counts', 'match', 'encounterDetail'].forEach(function (k) {
    if (!chained[k]) chained[k] = ['(Promise.all)'];
  });
  const ARGS = {
    match: [ROOM], encounterDetail: ['id:查无此人'], report: [{}], matches: [{}],
    setFlag: [ROOM, 'commander', true], setWatch: ['id:查无此人', true, {}],
    exportData: ['json', {}], reset: ['current'], saveCard: [{ dataUrl: 'x' }],
    copyCard: [{ dataUrl: 'x' }], setSettings: [{}]
  };
  const SKIP = { sync: 1, openLogin: 1, restore: 1 };   // 会起轮询 / 起采集的，形状由各自那条判
  const sweep = new Set(Object.keys(chained).filter(function (k) { return !SKIP[k]; }));
  const w7 = loadShim(makeBridge({
    files: { 'accounts.json': ACCOUNTS, [SLOT_FILE]: SEED }, net: function () { return ROLE_OK; }
  }));
  await w7.window.__dfReady;
  check('★ 界面里确实有 `df.x(...).then` 这类调用点（不然这条是空的）',
    Object.keys(chained).length >= 6, Object.keys(chained).sort().join(' '));
  const notThenable = [];
  Array.from(sweep).sort().forEach(function (n) {
    const fn = w7.window.df[n];
    if (typeof fn !== 'function') { notThenable.push(n + '=shim 里没这个方法'); return; }
    let v = null, threw = '';
    try { v = fn.apply(w7.window.df, ARGS[n] || []); } catch (e) { threw = String((e && e.message) || e); }
    if (!v || typeof v.then !== 'function') {
      notThenable.push(n + (threw ? '（同步抛：' + threw + '）' : '（回的是 ' +
        (v === null ? 'null' : Object.prototype.toString.call(v)) + '）'));
    } else v.catch(function () { /* 只判形状 */ });
  });
  check('★★ 界面 `.then` 过的每个方法 shim 都真回 Promise（扫了 ' + sweep.size + ' 个）',
    notThenable.length === 0, notThenable.join(' | ') || '全部是 thenable');

  /* E2 关于页三常量：壳不许另起入口 */
  const constOf = function (src, key) {
    const m = new RegExp(key + "\\s*=\\s*'([^']*)'").exec(src);
    return m ? m[1] : null;
  };
  const mainSrc = fs.readFileSync(path.join(ROOT, 'shell/main.js'), 'utf8');
  const drift = ['GITHUB_URL', 'QQ_GROUP', 'SANDBOX_URL'].filter(function (k) {
    const want = constOf(mainSrc, k);
    return !want || shimSrc.indexOf(k + " = '" + want + "'") === -1;
  });
  check('★ 群号 / GitHub / 沙盘三个常量与 shell/main.js 同源同值', drift.length === 0,
    drift.join(' ') || ['GITHUB_URL', 'QQ_GROUP', 'SANDBOX_URL']
      .map(function (k) { return k + '=' + constOf(mainSrc, k); }).join(' '));
  /* #93 沙盘换址 + 压掉对方那第一个弹窗：地址只许是那一家，压法只许是一条 CSS */
  check('★★ 沙盘地址已换到他点名的那一家（两壳同值 + 桌面白名单用的就是这一颗常量）',
    constOf(mainSrc, 'SANDBOX_URL') === 'https://aeuicey.github.io/DeltaForce-TacticalPanel/' &&
    /u === SANDBOX_URL \|\| u\.indexOf\(SANDBOX_URL\) === 0/.test(mainSrc),
    constOf(mainSrc, 'SANDBOX_URL'));
  check('★★ 那块宣传遮罩靠宿主注一条 CSS 藏掉：写的是对方那两个类名，不是宽泛选择器',
    /\.startup-notice-backdrop,\.startup-notice-dialog\{display:none!important\}/.test(mainSrc) &&
    /contents\.insertCSS\(SANDBOX_CSS\)/.test(mainSrc),
    (/'\.startup[^']*'/ .exec(mainSrc) || ['（没找到）'])[0]);
  check('★ 注入挂在 webview 的 dom-ready 上（insertCSS 不跨页保留，只来一回的话第二次导航就又冒出弹窗）',
    /contents\.on\('dom-ready'[\s\S]{0,200}insertCSS\(SANDBOX_CSS\)/.test(mainSrc));
  check('★ 安卓不内嵌这一页：手机上是交给系统浏览器，所以那条 CSS 只在桌面那侧（不许在这里也注一发）',
    !/insertCSS|startup-notice/.test(shimSrc));
  const clip = makeBridge({});
  const w5 = loadShim(clip);
  await w5.window.__dfReady;
  const grp = await w5.window.df.copyGroup();
  const sent = (clip.calls.filter(function (c) { return c.channel === 'clipboard'; })[0] || {}).args || {};
  check('★★ copyGroup 真把群号发给原生并回 {ok,text}（上一版发的是空串 = 「复制不了」）',
    grp.ok === true && grp.text === constOf(mainSrc, 'QQ_GROUP') &&
    sent.text === constOf(mainSrc, 'QQ_GROUP'),
    '回=' + JSON.stringify(grp) + ' 发出去=' + JSON.stringify(sent));

  /* E3 ★ 一条全新机器的完整登录流 —— 真机第 2 条的现场复现。
   *    注册表为空 → openLogin → 轮询看见 role → login:done → 界面当刻就得能刷出东西。
   *    上一版死在"先 useSlot 再 bindLogin"：新号不在注册表里 → store 留 null →
   *    refresh() 拿到 null report 抛错（链上没 catch）→ 人停在登录页。 */
  const w6 = loadShim(makeBridge({
    files: { 'accounts.json': JSON.stringify({ version: 1, activeSlot: '', globalSettings: {}, accounts: [] }) },
    net: function () { return ROLE_OK; }
  }));
  await w6.window.__dfReady;
  const gotEvent = new Promise(function (resolve) { w6.window.df.on('login:done', resolve); });
  const opened = await w6.window.df.openLogin();
  check('★ 登录窗打开前库就立好了，且新号沿用桌面的 a1/a2 命名（数据包两边文件名对得上）',
    !!opened.slot && /^a\d+$/.test(opened.slot), 'slot=' + opened.slot);
  const evt = await Promise.race([gotEvent, new Promise(function (r) {
    setTimeout(function () { r(null); }, 9000);
  })]);
  check('★★ 轮询认出登录态并发出 login:done（带着同一个 slot）',
    !!evt && evt.slot === opened.slot && !!evt.role && evt.role.openid === '12345678',
    JSON.stringify(evt));
  const rep6 = await w6.window.df.report({ mode: 'all' });
  check('★★ 登录完成那一刻 report() 就有东西可刷（不是 null 把人卡在登录页）',
    !!rep6 && typeof rep6 === 'object', 'report=' + Object.prototype.toString.call(rep6));
  const boot6 = await w6.window.df.boot();
  check('★★ 同一次会话里 boot 立刻报已登录、号已进注册表',
    boot6.loggedIn === true && Array.isArray(boot6.accounts) &&
    boot6.accounts.length === 1 && boot6.accounts[0].slot === opened.slot,
    'loggedIn=' + boot6.loggedIn + ' 账号数=' + (boot6.accounts || []).length);
  /* E3.5 ★ 账号体系（1=QQ、2=微信）。安卓登录轮询上一版手写一发 account_type:1，
   *   微信授权回来后轮询永远认不到这个人 → "授权完成了却停在登录页"，采集也全空。
   *   这里用"只有微信端才回角色"的假接口把整条路钉住。 */
  const wxOnlyNet = function (a) {
    var body = {};
    try { body = JSON.parse(a.body); } catch (e) { body = {}; }
    return Number(body.account_type) === 2 ? ROLE_OK : NOT_LOGIN;
  };
  const brWx = makeBridge({
    files: { 'accounts.json': JSON.stringify({ version: 1, activeSlot: '', globalSettings: {}, accounts: [] }) },
    net: wxOnlyNet
  });
  const wWx = loadShim(brWx);
  await wWx.window.__dfReady;
  const probesWx = [];
  wWx.window.df.on('login:probe', function (e) { probesWx.push(e); });
  const doneWx = new Promise(function (r) { wWx.window.df.on('login:done', r); });
  await wWx.window.df.openLogin();
  const evtWx = await Promise.race([doneWx, new Promise(function (r) {
    setTimeout(function () { r(null); }, 9000);
  })]);
  check('★★ 微信的号：按 QQ 问不到、改按微信问就到了，登录流仍然走得完',
    !!evtWx && !!evtWx.role && Number(evtWx.accountType) === 2, JSON.stringify(evtWx));
  check('★ 每一轮探测都有回话：QQ 那一发的官方错误码送到了界面（不再静默等）',
    probesWx.length >= 1 && (probesWx[0].attempts || []).length >= 1 &&
    Number(probesWx[0].attempts[0].code) === 8000102,
    JSON.stringify(probesWx[0] || null));
  const savedWx = JSON.parse(brWx.files['accounts.json']);
  check('★★ 定下来的账号体系跟着号落盘（不重启就丢）',
    (savedWx.accounts || []).length === 1 && Number(savedWx.accounts[0].accountType) === 2,
    JSON.stringify(savedWx.accounts[0] || null));
  /* 重启：换一个实例读同一份假注册表，开机那一发就该直接按微信问 —— 一发成功，没有第二次 */
  let wxNetCalls = 0;
  const wxBodies = [];
  const wWx2 = loadShim(makeBridge({
    files: { 'accounts.json': brWx.files['accounts.json'] },
    net: function (a) { wxNetCalls++; wxBodies.push(a.body); return wxOnlyNet(a); }
  }));
  await wWx2.window.__dfReady;
  const bootWx = await wWx2.window.df.boot();
  check('★ 重启后开机那一发就直接按微信问（只发一发就认出人，没有退回 1 再试一次）',
    bootWx.loggedIn === true && wxNetCalls === 1,
    '发了 ' + wxNetCalls + ' 发 loggedIn=' + bootWx.loggedIn);
  /* ★ 上面那发走的是登录探针（一次性的），真跑数据的是 openSlotStore 立起来的那个采集器：
   *   它要是没带回体系，微信号每次重启后一同步就「未登录」。上一版这条没测，
   *   把 openSlotStore 里那行 setAccountType 删掉，全套测试照样一句红都不报。 */
  const probeCalls = wxNetCalls;
  const syncWx = await wWx2.window.df.sync({ withDetail: false });
  const syncTypes = wxBodies.slice(probeCalls).map(function (b) {
    try { return Number(JSON.parse(b).account_type); } catch (e) { return -1; }
  });
  check('★ 重启后第一次同步：采集的每一发也都按微信问（没有一发退回 1）',
    syncTypes.length >= 2 && syncTypes.every(function (t) { return t === 2; }),
    '同步发了 ' + syncTypes.length + ' 发，account_type=' + syncTypes.join(',') +
    ' 回=' + JSON.stringify({ ok: syncWx.ok, error: syncWx.error }));
  /* ★ 翻页自证 + 赛季号在这一端也真跑了一发同步（core 单测管不到"手机端有没有把它带回界面"，
   *   而这两样恰恰是他那句「为什么只有 17 场」在手机上的答案）。 */
  const CollRef = require('../core/collector');
  check('★ 手机端同步也回 pageTrace：空战历 ⇒ 1 页 / 停因 empty，且带着问出去的赛季号',
    !!syncWx.pageTrace && syncWx.pageTrace.pages.length === 1 &&
      syncWx.pageTrace.stop === 'empty' && syncWx.seasonSid === CollRef.DEFAULT_SID,
    JSON.stringify(syncWx.pageTrace || null) + ' sid=' + syncWx.seasonSid);
  const syncSids = wxBodies.slice(probeCalls).map(function (s) {
    try { return JSON.parse(s).sid; } catch (e) { return undefined; }
  }).filter(function (x) { return x !== undefined; });
  check('★ 没设赛季号时手机端按内置默认发（战局列表那一发不带 sid，所以量到的就是两发）',
    syncSids.length === 2 && syncSids.every(function (x) { return x === CollRef.DEFAULT_SID; }),
    '发了 ' + syncSids.join(','));
  await wWx2.window.df.setSettings({ seasonSid: '12' });
  const before12 = wxBodies.length;
  const sync12 = await wWx2.window.df.sync({ withDetail: false });
  const sids12 = wxBodies.slice(before12).map(function (s) {
    try { return JSON.parse(s).sid; } catch (e) { return undefined; }
  }).filter(function (x) { return x !== undefined; });
  check('★★ 手机上改了赛季号：下一发同步真按 12 问（设置写进去 ≠ 发得出去，这一条量的是发得出去）',
    sids12.length === 2 && sids12.every(function (x) { return x === '12'; }) &&
      sync12.seasonSid === '12', '发了 ' + sids12.join(',') + ' 回=' + sync12.seasonSid);
  check('★ 停因原话也一路带回界面（手机上那一格念的是 core 的 STOP_TEXT，不是本地编的）',
    !!sync12.pageTrace && sync12.pageTrace.stopText === CollRef.STOP_TEXT.empty,
    String(sync12.pageTrace && sync12.pageTrace.stopText));
  await wWx2.window.df.setSettings({ seasonSid: '' });
  const beforeBack = wxBodies.length;
  const syncBack = await wWx2.window.df.sync({ withDetail: false });
  const sidsBack = wxBodies.slice(beforeBack).map(function (s) {
    try { return JSON.parse(s).sid; } catch (e) { return undefined; }
  }).filter(function (x) { return x !== undefined; });
  check('★ 清空这一格就回到内置默认，不会把一个空 sid 发给官方',
    sidsBack.length === 2 && sidsBack.every(function (x) { return x === CollRef.DEFAULT_SID; }) &&
      syncBack.seasonSid === CollRef.DEFAULT_SID, '发了 ' + sidsBack.join(','));
  /* ★★ 台账那一环在手机上也真跑一遍。上面那些假接口每一发都回同一个角色包，战局列表永远空，
   *   于是 recordSyncWindow 因为"没有场次"整轮跳过 —— 那一环压根没被走过。
   *   换成认端点的假接口、让列表真回一场，再从 report 里把这一轮的翻页记录读回来：
   *   只钉源码字面（"trace: payload.pageTrace" 在不在）挡不住"传了、但传的是 null"。 */
  const trNet = function (a) {
    var ep = String(a.pathname || '').split('/').pop();
    if (ep === 'GetBattleList') {
      return { ok: true, text: JSON.stringify({ tdms: [{
        roomId: 'AND-PAGE-1', mapId: 601, gameRule: 13, startTime: 1770000000,
        dtEventTime: '2026-09-19 10:00:00', kill: 3, death: 2, assist: 1, score: 1000
      }] }) };
    }
    return wxOnlyNet(a);
  };
  const trW = loadShim(makeBridge({
    files: { 'accounts.json': brWx.files['accounts.json'] }, net: trNet
  }));
  await trW.window.__dfReady;
  await trW.window.df.boot();
  const syncTr = await trW.window.df.sync({ withDetail: false, pages: 2, pageDelayMs: 0 });
  const wRow = (((await trW.window.df.report({})) || {}).sync || {}).windows || [];
  const lastRow = wRow[wRow.length - 1] || {};
  check('★ 这一轮同步真的回了一场（否则下面那条读的是空台账，等于没测）',
    syncTr.ok === true && syncTr.inserted === 1 && syncTr.pageTrace &&
      syncTr.pageTrace.pages.length === 1 && syncTr.pageTrace.rows === 1,
    JSON.stringify(syncTr.pageTrace || null) + ' inserted=' + syncTr.inserted);
  check('★★ 手机上这一轮真落进了台账：翻了几页 / 每页几条 / 停因原话，刷新后还念得出来',
    lastRow.pages === 1 && lastRow.rows.join(',') === '1' && lastRow.kept === 1 &&
      lastRow.stop === 'short' && lastRow.stopText === CollRef.STOP_TEXT.short &&
      lastRow.inserted === 1, JSON.stringify(lastRow));
  /* 桌面端这条链是 Electron 主进程，本机测不起来（也不能拿他正在跑的实例开刀）——
   * 那就照仓库既有手法把源码当接口核：这三处任何一处回退成"只按 QQ 问"，这里就该红。 */
  const wShell = fs.readFileSync(path.join(ROOT, 'shell', 'main.js'), 'utf8');
  const wPre = fs.readFileSync(path.join(ROOT, 'shell', 'preload.js'), 'utf8');
  const wApp = fs.readFileSync(path.join(ROOT, 'ui', 'js', 'app.js'), 'utf8');
  check('★★ 桌面同一份契约：轮询走 core 的 probeLogin，全文件再没有手写的 account_type: 1',
    /probeCollector\.probeLogin\(\)/.test(wShell) && wShell.indexOf('account_type: 1') === -1 &&
    /col\.setAccountType\(acc\.accountType\)/.test(wShell) &&
    /a\.accountType = acctType/.test(wShell),
    'probeLogin=' + /probeLogin\(\)/.test(wShell) +
    ' 裸写1=' + (wShell.indexOf('account_type: 1') >= 0) + ' 带回=' + /setAccountType\(acc\.accountType\)/.test(wShell));
  check('★ 探测过程与定下的体系穿得到界面（preload 白名单 + app.js 订阅，两端同一条事件名）',
    /'login:probe'/.test(wPre) && /df\.on\('login:probe'/.test(wApp) &&
    /'login:probe'/.test(fs.readFileSync(path.join(ROOT, 'android/js/df-android.js'), 'utf8')),
    'preload=' + /'login:probe'/.test(wPre) + ' ui=' + /df\.on\('login:probe'/.test(wApp));
  /* ★★ 关掉登录窗就得停手。上一版这条只是"浪费一发"，这一版一轮是两发（QQ + 微信），
   *   不停 = 每 2 秒两发打到进程死 —— 桌面在 loginWin.on('closed') 里停表，安卓的窗也是关了就推事件，
   *   所以判据是同一个时机，量法用"关窗之后再等同样长的一刻，计数一个字不许再涨"。 */
  let closedCalls = 0;
  const wClosed = loadShim(makeBridge({
    files: { 'accounts.json': JSON.stringify({ version: 1, activeSlot: '', globalSettings: {}, accounts: [] }) },
    net: function () { closedCalls++; return NOT_LOGIN; }
  }));
  await wClosed.window.__dfReady;
  await wClosed.window.df.openLogin();
  await new Promise(function (r) { setTimeout(r, 4500); });
  const closedBefore = closedCalls;
  check('★ 登录窗开着的时候确实在轮（一轮两发，4.5 秒里不止一发）', closedBefore >= 2,
    '发了 ' + closedBefore + ' 发');
  wClosed.window.__nativeEvent('login:window-closed', { slot: '' });
  await new Promise(function (r) { setTimeout(r, 4500); });
  check('★★ 原生推来「登录窗已关」的那一刻停表：之后再一发都不许出网',
    closedCalls === closedBefore,
    '关窗前 ' + closedBefore + ' 发，关窗后又等了 4.5 秒，共 ' + closedCalls + ' 发');
  check('★ 桌面同一处也要停得干净（这一发是 main.js 的表，量它的源码）',
    /loginWin\.on\('closed'[\s\S]{0,160}?stopLoginWatch\(\)/.test(wShell),
    'closed→stopLoginWatch=' +
    /loginWin\.on\('closed'[\s\S]{0,160}?stopLoginWatch\(\)/.test(wShell));

  /* E5 ★ 使用者裁定（2026-09-25）：**只有「打开登录浏览器」这一件事**要把整机会话痕迹清干净，
   *     每一窗都必须是全新会话。根因是他回的那条：罐里残留的半死会话让 WeGame 页面显示
   *     「无角色信息」，而软件两套体系都问不到角色 ⇒ 永远停在登录页。
   *     这一组两头都量：行为（shim 透不清、旧窗的表停没停）+ 源码（Java 那一步在不在该在的位置）。 */
  const JAVA_LOGIN = fs.readFileSync(path.join(ROOT,
    'android/app/src/main/java/com/df/battleanalyzer/LoginActivity.java'), 'utf8');
  let e5Calls = 0;
  const e5 = loadShim(makeBridge({
    files: { 'accounts.json': JSON.stringify({ version: 1, activeSlot: '', globalSettings: {}, accounts: [] }) },
    net: function () { e5Calls++; return NOT_LOGIN; }
  }));
  await e5.window.__dfReady;
  const e5Open = await e5.window.df.openLogin();
  check('★ 开登录窗这一发原生回 cleared:true，shim 原样透给界面（界面只在它为真时才说那句话）',
    e5Open.ok === true && e5Open.cleared === true, JSON.stringify(e5Open));
  await new Promise(function (r) { setTimeout(r, 4400); });
  /* 再开一窗：上一窗那张表必须先停手。不停 = 两张 setInterval 叠着跑，每轮从 2 发变 4 发，
   * 出网频率翻倍且界面上念的是上一个会话的失败原因。用"同样长的一刻里发了几发"来判，
   * 单表 4.6 秒 ≈ 4 发，双表 ≈ 8 发，中间留足抖动余量。 */
  await e5.window.df.openLogin();
  const e5Mid = e5Calls;
  await new Promise(function (r) { setTimeout(r, 4600); });
  const e5Grew = e5Calls - e5Mid;
  check('★★ 重开登录窗只留一张轮询表：4.6 秒里仍是一轮两发 ×2，不许翻倍',
    e5Grew >= 2 && e5Grew <= 6, '第二窗后 4.6 秒内 ' + e5Grew + ' 发（翻倍 = 旧窗那张表没停）');
  check('★★ Java：wipeSession 必须排在 loadUrl 之前（晚一步就等于第一屏还是旧会话）',
    JAVA_LOGIN.indexOf('wipeSession(web)') >= 0 &&
    JAVA_LOGIN.indexOf('wipeSession(web)') < JAVA_LOGIN.indexOf('web.loadUrl(LOGIN_URL)'),
    'wipe@' + JAVA_LOGIN.indexOf('wipeSession(web)') + ' loadUrl@' + JAVA_LOGIN.indexOf('web.loadUrl(LOGIN_URL)'));
  const wipeBody = (JAVA_LOGIN.match(/static void wipeSession\(WebView web\) \{[\s\S]*?\n    \}/) || [''])[0];
  const WIPE_NEEDS = ['removeAllCookies', 'flush()', 'clearCache',
    'clearFormData', 'clearHistory', 'clearSslPreferences', 'WebStorage.getInstance()', 'deleteAllData()'];
  check('★ wipeSession 清的是"整套会话痕迹"，不是只清 cookie（少一样都算没做干净）',
    wipeBody.length > 40 && WIPE_NEEDS.every(function (k) { return wipeBody.indexOf(k) >= 0; }),
    '缺：' + (WIPE_NEEDS.filter(function (k) { return wipeBody.indexOf(k) === -1; }).join(',') || '无'));
  /* ★★ 上一版这九项清单里躺着三条**Android 压根没有的方法名**（removeAllSessionCookies /
   *    clearHttpAuthCache / web.clearLocalStorage），而这一套测试只核字符串，于是它全绿、
   *    gradle 直接拒编。教训：Java 那侧的红线不能替代编译。这条反向清单先把那三个名字钉死，
   *    下一次谁再凭印象写 API，这里先红一句，不用等到打包。
   *    removeSessionCookies() 无参那条同理：compileSdk 36 的桩里只剩带回调的重载，
   *    而 removeAllCookies 本就覆盖会话 cookie，不需要它。 */
  const NOT_APIS = [/removeAllSessionCookies\(\)\s*;/, /clearHttpAuthCache\(\)\s*;/,
    /clearLocalStorage\(\)\s*;/, /removeSessionCookies\(\)\s*;/];
  const javaAll = fs.readdirSync(path.join(ROOT, 'android/app/src/main/java/com/df/battleanalyzer'))
    .filter(function (f) { return /\.java$/.test(f); })
    .map(function (f) { return fs.readFileSync(path.join(ROOT,
      'android/app/src/main/java/com/df/battleanalyzer', f), 'utf8'); }).join('\n');
  check('★★ 不许再写 Android 没有的方法名（这几条都是编译器替我们验过的）',
    NOT_APIS.every(function (re) { return !re.test(javaAll); }),
    '又当成代码写了：' + NOT_APIS.filter(function (re) { return re.test(javaAll); })
      .map(function (re) { return re.source; }).join(','));
  /* 连点两下"打开登录窗口"这一条：叠两层窗时，前面那扇关掉的瞬间会推 login:window-closed，
   * 把还在屏幕上的那一扇的轮询停掉 —— 所以第二下必须落到同一实例、并重新走一遍"清空 + 加载"。 */
  const MANIFEST = fs.readFileSync(path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  const loginActivityTag = (MANIFEST.match(/<activity[^>]*\.LoginActivity[^>]*\/>/) || [''])[0];
  check('★★ manifest：LoginActivity 是 singleTop（第二下点击不许叠第二扇窗）',
    /launchMode="singleTop"/.test(loginActivityTag), '那颗 activity 声明=' + (loginActivityTag || '没找到'));
  const newIntentBody = (JAVA_LOGIN.match(/protected void onNewIntent\(Intent intent\) \{([\s\S]*?)\n    \}/) || ['', ''])[1];
  check('★★ onNewIntent 走的是同一条 startFreshSession（换 slot + 再清一遍 + 重新加载）',
    /slot = slotOf\(intent\);/.test(newIntentBody) && /startFreshSession\(\);/.test(newIntentBody) &&
    /setIntent\(intent\);/.test(newIntentBody), 'onNewIntent 体=' + JSON.stringify(newIntentBody.trim().slice(0, 120)));
  const freshBody = (JAVA_LOGIN.match(/private void startFreshSession\(\) \{([\s\S]*?)\n    \}/) || ['', ''])[1];
  check('★★ 清空与加载收在一处，onCreate 也只从这一处进（两处各写各的迟早漂移成一处清一处不清）',
    /wipeSession\(web\);/.test(freshBody) && /web\.loadUrl\(LOGIN_URL\);/.test(freshBody) &&
    freshBody.indexOf('wipeSession(web)') < freshBody.indexOf('web.loadUrl(LOGIN_URL)') &&
    /\n        startFreshSession\(\);/.test(JAVA_LOGIN.split('protected void onNewIntent')[0]) &&
    (JAVA_LOGIN.match(/startFreshSession\(\);/g) || []).length === 2,
    'helper 里 wipe@' + freshBody.indexOf('wipeSession(web)') + ' load@' +
    freshBody.indexOf('web.loadUrl(LOGIN_URL)') + ' 调用点=' +
    (JAVA_LOGIN.match(/startFreshSession\(\);/g) || []).length);
  /* 「仅限打开登录浏览器」这条的可执行版本：全仓 Java 里清 cookie 的调用点只许两处 */
  const javaDir = path.join(ROOT, 'android/app/src/main/java/com/df/battleanalyzer');
  const wipeSites = fs.readdirSync(javaDir).filter(function (f) { return /\.java$/.test(f); })
    .map(function (f) { return [f, fs.readFileSync(path.join(javaDir, f), 'utf8')]; })
    .filter(function (p) { return p[1].indexOf('removeAllCookies') >= 0; })
    .map(function (p) { return p[0]; });
  check('★★ 清 cookie 只许出现在「开登录窗」与设置页「退出登录」这两处，别处一律不许',
    wipeSites.length === 2 && wipeSites.indexOf('LoginActivity.java') >= 0 &&
    wipeSites.indexOf('DfBridge.java') >= 0, '出现于：' + wipeSites.join(', '));
  check('★ 真原生那一侧也得真的回 cleared（假桥是照它抄的，只测 shim 透传测不到 Java）',
    /login\.open"\.equals[\s\S]{0,600}?put\("cleared", true\)/.test(JAVA_BRIDGE),
    'DfBridge login.open 回包带 cleared=' +
    /login\.open"\.equals[\s\S]{0,600}?put\("cleared", true\)/.test(JAVA_BRIDGE));
  /* ============ E9 桌面那一侧（使用者裁定 2026-09-26 把上一版「桌面刻意不清」翻了过来）============
   * 病因与他给的实测一致：官方 WeGame 隔一阵自己把账号退掉，罐子里留下的是那半死会话 ⇒
   * 页面「无角色信息」、两套 account_type 都问不到角色 ⇒ 每次打开登录浏览器必须是全新会话。
   * 桌面每号一个持久分区（`persist:wegame-slot-<slot>`），所以"清整套"落在**这一个号**上；
   * 把别的号一起清会静悄悄把它们也登出，那不是这一发的范围（他原话让我自己定，我按"最小破坏"定的）。
   * ★★ 这条不许只核字符串（上一轮 Java 那九项清单就是这么把三个不存在的 API 供成"验过了"）。
   *    做法：把 main.js 里那段 helper 原样抠出来**真跑一遍假 session**，量它的调用顺序与失败收集。 */
  const wipeDecl = (wShell.match(/var LOGIN_WIPE_STORAGES = \[[\s\S]*?\];/) || [''])[0];
  const wipeFnSrc = handlerSrcOf(wShell, 'function wipeLoginSession');
  check('★★ 先从 main.js 真抠出这套清理（抠不出来 = 下面全是空的）',
    wipeDecl.length > 20 && wipeFnSrc.length > 120,
    '清单=' + wipeDecl.length + ' 字，helper=' + wipeFnSrc.length + ' 字');
  let wipeFn = null;
  try {
    /* eslint-disable no-new-func */
    wipeFn = new Function(wipeDecl + '\n' + wipeFnSrc + '\nreturn wipeLoginSession;')();
  } catch (e) { /* 下面那条会报出来 */ }
  check('★ 抠出来的那段能编译成函数（编译不过 = 与 main.js 已经漂移）', !!wipeFn, String(wipeFn && wipeFn.name || ''));

  /* 假 session 照 Electron 33.4.11 的真形状来（tools/probe-desktop-session-wipe.js 实测：
   * Session 上有 clearStorageData / clearCache / clearAuthCache / flushStorageData，
   * **没有** clearHistory —— 会话历史在 webContents 上）。 */
  function fakeSession(broken) {
    const calls = [];
    const ses = {
      clearStorageData: function (o) {
        calls.push(['storage', (o && o.storages || []).join(',')]);
        return broken === 'storage' ? Promise.reject(new Error('坏在这一步')) : Promise.resolve();
      },
      clearCache: function () { calls.push(['cache']); return broken === 'cache' ? Promise.reject(new Error('缓存没清')) : Promise.resolve(); },
      clearAuthCache: function () { calls.push(['auth']); return broken === 'auth' ? Promise.reject(new Error('认证缓存没清')) : Promise.resolve(); },
      flushStorageData: function () { calls.push(['flush']); }
    };
    return { ses: ses, calls: calls };
  }
  const fakeWc = function (calls) {
    return { isDestroyed: function () { return false; },
      clearHistory: function () { calls.push(['history']); } };
  };
  const okRun = fakeSession(null);
  const res0 = await wipeFn(okRun.ses, fakeWc(okRun.calls));
  check('★★ 桌面这一发回 cleared:true，且四步加落盘一步不落（顺序也是证据：清在加载之前由源码那条盯）',
    res0.cleared === true && res0.clearError === '' &&
    okRun.calls.map(function (c) { return c[0]; }).join(',') === 'storage,cache,auth,history,flush',
    JSON.stringify({ cleared: res0.cleared, calls: okRun.calls.map(function (c) { return c[0]; }) }));
  /* ★★ 实测过的一条坑：`clearStorageData({storages:[…]})` 对**不认识的名单静悄悄忽略**
   *    （我喂 'not_a_type' 也照样 resolve），所以名字表要钉死：
   *    被证明真会清掉的三样必须在，而 'history' 那种"看着像、其实不是 storage 名"的必须在名单里消失。 */
  const storagesArg = (okRun.calls[0] || ['', ''])[1].split(',');
  check('★★ 清理名单里必须有实测"真清得掉"的那三样（cookie / 本地存储 / IndexedDB），且不许拿 history 充当',
    ['cookies', 'localstorage', 'indexdb'].every(function (k) { return storagesArg.indexOf(k) >= 0; }) &&
    storagesArg.indexOf('history') === -1,
    '名单=' + storagesArg.join(','));
  check('★ 会话历史走的是 webContents.clearHistory（Session 上没这个口子，写在那儿就是空操作）',
    okRun.calls.indexOf(['history']) >= 0 || okRun.calls.some(function (c) { return c[0] === 'history'; }),
    '调用序列=' + okRun.calls.map(function (c) { return c[0]; }).join(','));
  const notThere = [/ses\s*\.\s*clearHistory/, /session\s*\.\s*clearHistory/,
    /\bses\s*\.\s*getCookies\b/, /webContents\s*\.\s*clearCache/];
  check('★★ 桌面也不许写这个运行时没有的 API（与安卓 NOT_APIS 同一课，这几条是探针实测出来的）',
    notThere.every(function (re) { return !re.test(wShell); }),
    '又当成代码写了：' + notThere.filter(function (re) { return re.test(wShell); })
      .map(function (re) { return re.source; }).join(','));
  /* 清不动的时候不许谎报：那一步失败就得 cleared:false，并把那一步自己的原因带出来 */
  const FAIL_MSG = { storage: '坏在这一步', cache: '缓存没清', auth: '认证缓存没清' };
  for (const bad of ['storage', 'cache', 'auth']) {
    const r = fakeSession(bad);
    const res = await wipeFn(r.ses, fakeWc(r.calls));
    check('★ 假原生把「' + bad + '」这一步弄挂：cleared 必须翻假，且 clearError 里带着那一步的原因（界面靠它改口）',
      res.cleared === false && res.clearError.indexOf(FAIL_MSG[bad]) >= 0, JSON.stringify(res));
  }
  /* 「仅限打开登录浏览器」这条在桌面的可执行版本：整套清理只许这一处（外加自检那一处，它用的是
   * 一次性分区）；登录登出/移除账号那三处照旧只清 cookie —— 那是使用者主动点的，语义不同。
   * ★ 数次数不许凭印象写常量：两处调用点各抠出来数，第三处一冒出来就对不上总数。 */
  const openBody = handlerSrcOf(wShell, 'function openLoginWindow');
  const selfBody = handlerSrcOf(wShell, 'function probeLoginWipe');
  const nOpen = (openBody.match(/wipeLoginSession\(/g) || []).length;
  const nSelf = (selfBody.match(/wipeLoginSession\(/g) || []).length;
  check('★★ 整套清理的调用点：登录窗正好一处、自检一处，别处一处都不许有',
    nOpen === 1 && nSelf === 1 &&
    (wShell.match(/wipeLoginSession\(/g) || []).length === 1 + nOpen + nSelf,
    '登录窗=' + nOpen + ' 自检=' + nSelf + ' 全文件=' + (wShell.match(/wipeLoginSession\(/g) || []).length);
  check('★★ 自检那一处用的是两枚一次性分区，绝不碰使用者真号的罐子',
    /selftest-wipe-a/.test(selfBody) && /selftest-wipe-b/.test(selfBody) &&
    !/partitionFor\(accounts\.activeSlot\)/.test(selfBody),
    '分区=' + (selfBody.match(/selftest-wipe-[ab]/g) || []).join(','));
  const cookiesOnlySites = (wShell.match(/clearStorageData\(\{\s*storages:\s*\['cookies'\]\s*\}\)/g) || []).length;
  check('★ 「退出登录」「移除账号」仍只清 cookie，没被这一轮顺手升级成整套清理',
    cookiesOnlySites === 3, '只清 cookie 的调用点=' + cookiesOnlySites + '（登录:登出 / 账号:登出 / 账号:移除）');
  check('★★ 桌面这条不许牵连别的号：清理用的是这一个 slot 的那一罐，不是遍历全部账号',
    /const session = require\('electron'\)\.session\.fromPartition\(partition\);/.test(wShell) &&
    /wipeLoginSession\(session,/.test(wShell) &&
    !/accounts\.accounts\.forEach[\s\S]{0,200}?clearStorageData/.test(wShell),
    '分区来源=partitionFor(slot)，无全局遍历');
  check('★★ IPC 不许把这一发的结果写死成 {ok:true}（上一版就是这么把 cleared 吞在主线上的）',
    /'login:open'[\s\S]{0,400}?return openLoginWindow\(targetSlot\);/.test(wShell) &&
    /'account:add'[\s\S]{0,400}?return openLoginWindow\(slot\)\.then/.test(wShell),
    'login:open 透 Promise=' + /'login:open'[\s\S]{0,400}?return openLoginWindow\(targetSlot\);/.test(wShell));
  check('★ ★ 桌面 loadURL 必须排在清理之后（晚一步 = 第一屏还是那个半死会话，清了也白清）',
    wShell.indexOf('wipeLoginSession(session, loginWin.webContents)') >= 0 &&
    wShell.indexOf('wipeLoginSession(session, loginWin.webContents)') <
      wShell.indexOf('loginWin.loadURL(WEGAME_HOME);'),
    'wipe@' + wShell.indexOf('wipeLoginSession(session, loginWin.webContents)') +
      ' loadURL@' + wShell.indexOf('loginWin.loadURL(WEGAME_HOME);'));
  check('★ 这条链子在源码上对得上：preload 把 openLogin 接到 login:open、main.js 真回 cleared',
    /openLogin:\s*\(slot\)\s*=>\s*ipcRenderer\.invoke\('login:open'/.test(wPre) &&
    /return openLoginWindow\(targetSlot\);/.test(wShell) && /cleared: res\.cleared/.test(wShell) &&
    /cleared/.test(fs.readFileSync(path.join(ROOT, 'android/js/df-android.js'), 'utf8')),
    'main.js 带 cleared=' + (wShell.indexOf('cleared') >= 0));
  /* ★★ 界面那三句话**不许用"字符串在不在"来验**（上一版就是这条漏的：把 if (r && r.cleared) 改成
   *    if (true)，全套仍然全绿 —— 与 E5 同一课）。手法照 E5：把 app.js 里那段真抠出来、喂假回包跑一遍。 */
  const openFnSrc = handlerSrcOf(wApp, 'var openLoginWin = function');
  check('★★ 先从 app.js 真抠出那颗按钮的那段（抠不出来 = 下面三条是空的）',
    openFnSrc.length > 200 && openFnSrc.indexOf('df.openLogin()') > 0, '抠到 ' + openFnSrc.length + ' 字');
  function runOpenWin(reply) {
    const els = {};
    const $$ = function (id) {
      if (!els[id]) els[id] = { textContent: '', className: 'x' };
      return els[id];
    };
    const g = { df: { openLogin: function () { return Promise.resolve(reply); } } };
    /* 抛出来的一律算失败：宁可测试红，也不要"看起来绿" */
    return new Function('$', 'global', 'return (' + openFnSrc + ')')($$, g)()
      .then(function (ret) { return { ret: ret, el: els.loginStatus }; });
  }
  const oCleared = await runOpenWin({ ok: true, cleared: true });
  check('★ 回包 cleared:true：念"旧的登录痕迹全部清掉了"，且不是错色',
    /旧的登录痕迹全部清掉/.test(oCleared.el.textContent) &&
    oCleared.el.className === 'login-status' && oCleared.ret.cleared === true,
    JSON.stringify(oCleared.el));
  const oFailed = await runOpenWin({ ok: true, cleared: false, clearError: '清存储：这版运行时不给' });
  check('★★ 清了但没清干净：必须当场改口、带着那句原因、标成错色（不许挂着"已打开登录窗口"）',
    /没能全部清掉/.test(oFailed.el.textContent) &&
    oFailed.el.textContent.indexOf('清存储：这版运行时不给') >= 0 &&
    oFailed.el.className === 'login-status err' && oFailed.ret.cleared === false,
    JSON.stringify(oFailed.el));
  const oPlain = await runOpenWin({ ok: true });
  check('★★ 回包压根没说 cleared：那句话就不许出现（这一条专治 if (r.cleared) 被改成 if (true)）',
    oPlain.el.textContent === '已打开登录窗口，请在其中完成登录…' &&
    oPlain.el.textContent.indexOf('清掉') === -1 && oPlain.el.className === 'login-status',
    JSON.stringify(oPlain.el));
  check('★ 换号重开必须换窗：分区在 new BrowserWindow 时就钉死了，拿 A 的窗清 B 的罐比不清更坏',
    /loginWin\.__dfSlot !== slot/.test(wShell) && /loginWin\.__dfSlot = slot;/.test(wShell) &&
    /if \(loginWin === win\) \{ loginWin = null; stopLoginWatch\(\); \}/.test(wShell),
    '换窗判定=' + /loginWin\.__dfSlot !== slot/.test(wShell));
  /* 同一场里的第二条：官方认得这个登录态、但它下面没有角色 —— 喊"再等等、不用关窗口"是把人往死胡同领。
   * ★★ 判定归 core、界面只排版，而"只排版"这条不许再用字符串在不在来验（上一版就是这么假过去的：
   *    把 if (e.advice) 改成 if (false) 全套测试一句都不红）。手法：把 app.js 里那段处理器原样抠出来真跑。 */
  const CORE_COLLECTOR = require('../core/collector');
  function handlerSrcOf(src, marker) {
    const from = src.indexOf(marker);
    if (from < 0) return '';
    const start = src.indexOf('function', from);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    return '';
  }
  const probeFnSrc = handlerSrcOf(wApp, "global.df.on('login:probe',");
  check('★★ 先从 app.js 真抠出 login:probe 处理器（抠不出来 = 下面两条是空的）',
    probeFnSrc.length > 200 && probeFnSrc.indexOf('e.advice') > 0,
    '抠到 ' + probeFnSrc.length + ' 字');
  function runProbeHandler(evt) {
    const els = {};
    const $$ = function (id) {
      if (!els[id]) els[id] = { textContent: '', className: '',
        /* 登录页开着 = appView 带 hidden，处理器才该往下排字 */
        classList: { contains: function (c) { return c === 'hidden'; } } };
      return els[id];
    };
    new Function('$', 'return (' + probeFnSrc + ')')($$)(evt);
    return els.loginStatus;
  }
  const NO_ROLE_ATTEMPTS = [{ accountType: 1, ok: false, code: '', reason: 'no_role' },
    { accountType: 2, ok: false, code: '', reason: 'no_role' }];
  const hAdvice = runProbeHandler({ ok: false, rounds: CORE_COLLECTOR.PROBE_NO_ROLE_ROUNDS,
    advice: CORE_COLLECTOR.PROBE_NO_ROLE_ADVICE, attempts: NO_ROLE_ATTEMPTS });
  check('★★ core 给了 advice：界面一字不改把它排出来并标成错色（不再念"不用关这个窗口"）',
    hAdvice.textContent === CORE_COLLECTOR.PROBE_NO_ROLE_ADVICE &&
    hAdvice.className === 'login-status err',
    'class=' + hAdvice.className + ' 内容=' + hAdvice.textContent.slice(0, 30) + '…');
  const hWait = runProbeHandler({ ok: false, rounds: 3, advice: '',
    message: 'QQ 与微信两套账号体系都没问到角色信息',
    attempts: [{ accountType: 1, ok: false, code: 8000102, reason: 'not_login' },
      { accountType: 2, ok: false, code: '', reason: 'no_role' }] });
  check('★ 没到阈值：报"还在等"+ 每发官方回了什么 + 数到第几轮（"等了多久"要说得出数）',
    /还在等你完成登录/.test(hWait.textContent) && /错误码 8000102/.test(hWait.textContent) &&
    /没问到角色/.test(hWait.textContent) && /已经问了 3 轮/.test(hWait.textContent),
    hWait.textContent);
  const aShell = fs.readFileSync(path.join(ROOT, 'android/js/df-android.js'), 'utf8');
  check('★★ 界面不再自己数轮次：没有阈值常量、没有 probeRounds，处理器里也不许重判 every(no_role)',
    wApp.indexOf('LOGIN_PROBE_ROUNDS') === -1 && wApp.indexOf('probeRounds') === -1 &&
    probeFnSrc.indexOf('.every(') === -1,
    '常量=' + (wApp.indexOf('LOGIN_PROBE_ROUNDS') >= 0) + ' 自己数=' + (wApp.indexOf('probeRounds') >= 0) +
    ' 重判=' + (probeFnSrc.indexOf('.every(') >= 0));
  check('★ 两端 shell 都把 core 那两枚字段原样转出去（漏转一处，界面那句改口就是死的）',
    /rounds: r\.rounds \|\| 0, advice: r\.advice \|\| ''/.test(wShell) &&
    /rounds: r\.rounds \|\| 0, advice: r\.advice \|\| ''/.test(aShell),
    '桌面=' + /rounds: r\.rounds/.test(wShell) + ' 安卓=' + /advice: r\.advice/.test(aShell));
  /* 转发这件事还能真跑一次安卓侧：量事件对象上这两枚字段在不在（不是量源码） */
  const e5b = loadShim(makeBridge({
    files: { 'accounts.json': '{"version":1,"activeSlot":"","globalSettings":{},"accounts":[]}' },
    net: function () { return { ok: true, text: '{"result":{"error_code":0}}' }; }
  }));
  await e5b.window.__dfReady;
  const e5bEvents = [];
  e5b.window.df.on('login:probe', function (e) { e5bEvents.push(e); });
  await e5b.window.df.openLogin();
  await new Promise(function (r) { setTimeout(r, 2400); });
  check('★ 安卓第一轮探测：事件里真的带着 rounds=1 且 advice 为空（字段在链上，不是只在源码里）',
    e5bEvents.length >= 1 && e5bEvents[0].rounds === 1 && e5bEvents[0].advice === '' &&
    (e5bEvents[0].attempts || []).length === 2,
    JSON.stringify(e5bEvents[0] || null).slice(0, 160));
  e5b.window.__nativeEvent('login:window-closed', { slot: '' });

  /* E6 ★ 清空会话之后，旧那一发迟到的回包不许作数（上一版 stopPolling 那两行是死代码：
   *    删掉它全套测试一句不红 —— 因为没有任何一条测到"回包还在路上"这一刻。这里把它造出来：
   *    假原生让 net 回包延迟 3 秒，用户在 2 秒表轮之后、回包落地之前再开一窗）。 */
  const ROLE_OLD = { ok: true, text: JSON.stringify({ result: { error_code: 0 },
    role_info: { openid: '77777777', area: 36, name: '旧会话的号', level: 50 } }) };
  const ROLE_NEW = { ok: true, text: JSON.stringify({ result: { error_code: 0 },
    role_info: { openid: '88888888', area: 36, name: '重新授权后的号', level: 50 } }) };
  let e6Round = 0;
  const e6Bridge = makeBridge({
    files: { 'accounts.json': '{"version":1,"activeSlot":"","globalSettings":{},"accounts":[]}' },
    netDelayMs: 3000,
    net: function () { e6Round++; return e6Round === 1 ? ROLE_OLD : ROLE_NEW; }
  });
  const e6 = loadShim(e6Bridge);
  await e6.window.__dfReady;
  const e6Done = [];
  e6.window.df.on('login:done', function (e) { e6Done.push(e.role && e.role.openid); });
  await e6.window.df.openLogin();
  await new Promise(function (r) { setTimeout(r, 2100); });
  const e6InFlight = e6Round;
  check('★ 旧那一发确实已经在路上（量不到这一步，下面那条就是空的）',
    e6InFlight >= 1 && e6Done.length === 0, '已发 ' + e6InFlight + ' 发，已落号 ' + e6Done.length + ' 次');
  await e6.window.df.openLogin();
  await new Promise(function (r) { setTimeout(r, 6800); });
  check('★★ 迟到的旧会话回包一个字都不落地：不许拿"上一个会话"的 role 落号',
    e6Done.indexOf('77777777') === -1, '落过号：' + JSON.stringify(e6Done));
  check('★ 作废的不是"所有探测"：新表自己那一发仍然认得出人（否则这条守卫就是把登录焊死）',
    e6Done.indexOf('88888888') >= 0, '落过号：' + JSON.stringify(e6Done));
  const e6Accounts = JSON.parse(e6Bridge.files['accounts.json'] || '{"accounts":[]}');
  check('★ 注册表里也没留下那个旧会话的号',
    (e6Accounts.accounts || []).every(function (a) { return a.openid !== '77777777'; }),
    JSON.stringify((e6Accounts.accounts || []).map(function (a) { return a.openid; })));
  e6.window.__nativeEvent('login:window-closed', { slot: '' });

  /* E7 ★ 「读不出来」不是「没有数据」——使用者那句"我明明存上去了，第二次打开却说没数据，只能重装清数据"的根因。
   *    原来 JS 只看 !r.text：原生读失败与"这个文件不存在"合成同一种话，于是界面报空库，
   *    而随后任何一次保存就把还有救的文件原地盖掉 —— 装上这一次真机就找不回来了。
   *    这一组量三件事：说得出原因、写闸挡得住、以及"当真没有这个文件"仍旧能正常新建。 */
  const e7a = makeBridge({
    files: { 'accounts.json': ACCOUNTS, [SLOT_FILE]: SEED },
    readFails: { 'accounts.json': true },
    net: function () { return ROLE_OK; }
  });
  const wa7 = loadShim(e7a);
  await wa7.window.__dfReady;
  const b7a = await wa7.window.df.boot();
  check('★★ 注册表读不出来时，开机那句说的是"本机文件读不出来"，不是"尚未添加账号/没有数据"',
    b7a.storageFault === true && /读不出来/.test(b7a.bootError || '') &&
    /accounts\.json/.test(b7a.bootError || '') && !/尚未添加账号/.test(b7a.bootError || ''),
    JSON.stringify({ fault: b7a.storageFault, msg: (b7a.bootError || '').slice(0, 70) }));
  const done7 = new Promise(function (r) { wa7.window.df.on('login:done', r); });
  const op7 = await wa7.window.df.openLogin();
  check('★ 开着登录窗这一发也要说实话：cleared 与 storageFault 同时给出（不许只报"已清掉痕迹"）',
    op7.cleared === true && op7.storageFault === true, JSON.stringify(op7));
  const evt7 = await Promise.race([done7, new Promise(function (r) {
    setTimeout(function () { r(null); }, 9000);
  })]);
  const writes7a = e7a.calls.filter(function (c) {
    return c.channel === 'fs.write' && c.args.name === 'accounts.json';
  });
  check('★★ 登录成功了也不许把这份内存里的空表写回 accounts.json（闸门挡下：一次写都不发）',
    !!evt7 && writes7a.length === 0 && e7a.files['accounts.json'] === ACCOUNTS,
    'fs.write 发了 ' + writes7a.length + ' 次，盘上那份还是原样=' +
    (e7a.files['accounts.json'] === ACCOUNTS));
  check('★ 挡下来这件事得当场说：login:done 带着"这次没记住"回来（不是静默假装已落盘）',
    !!evt7 && !!evt7.persistError && /没读动|先不写/.test(evt7.persistError),
    JSON.stringify((evt7 || {}).persistError));

  /* 战绩库读不出来：boot 是探完登录才回话的那一支，故障必须现算，不能拿开机那一刻的快照 */
  const e7b = makeBridge({
    files: { 'accounts.json': ACCOUNTS, [SLOT_FILE]: SEED },
    readFails: function (n) { return n === SLOT_FILE; },
    net: function () { return NOT_LOGIN; }
  });
  const wb7 = loadShim(e7b);
  await wb7.window.__dfReady;
  const b7b = await wb7.window.df.boot();
  const libReads = e7b.calls.filter(function (c) {
    return c.channel === 'fs.read' && c.args.name === SLOT_FILE;
  });
  check('★★ 库读不出来：matchCount 是 0 但话说得清（探完登录才回话的那一支也带着故障与文件名）',
    b7b.matchCount === 0 && b7b.storageFault === true &&
    b7b.bootError.indexOf(SLOT_FILE) >= 0,
    JSON.stringify({ fault: b7b.storageFault, n: b7b.matchCount, msg: (b7b.bootError || '').slice(0, 60) }));
  check('★ 读不出来先重问一次再定论（这一发真的多发了一次，不是猜的）', libReads.length >= 2,
    '读了 ' + libReads.length + ' 次');
  const set7 = await wb7.window.df.setSettings({ syncPages: 7 });
  const libWrites = e7b.calls.filter(function (c) {
    return c.channel === 'fs.write' && c.args.name === SLOT_FILE;
  });
  check('★★ 带故障时任何一次设置落盘都不许盖掉那个读不出来的库（盘上那份字节不动）',
    libWrites.length === 0 && e7b.files[SLOT_FILE] === SEED && !!set7,
    'fs.write 发了 ' + libWrites.length + ' 次');

  /* 只有「当真没有这个文件」才该当空库继续 —— 上面那条闸门不许把这个正常路径一起堵死 */
  let flaky = 0;
  const e7c = makeBridge({
    files: { 'accounts.json': ACCOUNTS },
    readFails: function (n) {
      if (n !== SLOT_FILE) return false;
      flaky++;                       // 第一次读不动、第二次就过了：这种瞬态不该下故障结论
      return flaky === 1;
    },
    net: function () { return ROLE_OK; }
  });
  const wc7 = loadShim(e7c);
  await wc7.window.__dfReady;
  const slot7 = (await wc7.window.df.openLogin()).slot;
  await new Promise(function (r) { setTimeout(r, 4200); });
  const b7c = await wc7.window.df.boot();
  const acctWrites = e7c.calls.filter(function (c) {
    return c.channel === 'fs.write' && c.args.name === 'accounts.json';
  });
  check('★★ 正常路径没被写闸一起堵死：号能登记、注册表真的落盘了',
    acctWrites.length >= 1 && slot7 === SLOT &&
    JSON.parse(e7c.files['accounts.json']).activeSlot === SLOT,
    'accounts.json 写了 ' + acctWrites.length + ' 次 slot=' + slot7);
  check('★ 第二次读得动就不算故障：账要划掉，界面那句"读不出来"不许留下来吓人',
    b7c.storageFault !== true && !/读不出来/.test(b7c.bootError || '') && b7c.loggedIn === true,
    JSON.stringify({ fault: b7c.storageFault, msg: (b7c.bootError || '').slice(0, 40) }));
  wc7.window.__nativeEvent('login:window-closed', { slot: '' });
  /* ★ 跨文件接缝（#52 那一课的规矩）：同一条 fs.read 的回包形状，Java、假原生、JS 读法三处必须还是一回事。
   *   假原生是我们照 Java 手抄的，抄漏一样，真机炸的那条就在这套测试里全绿。 */
  const FS_READ_JAVA = (JAVA_BRIDGE.match(/if \("fs\.read"\.equals\(channel\)\) \{([\s\S]*?)\n        \}/) || ['', ''])[1];
  const ownSrc = fs.readFileSync(path.join(__dirname, 'android-shim.test.js'), 'utf8');
  check('★★ fs.read 三种回话在 Java / 假原生 / JS 读法三处同形（缺文件 ≠ 读不出来 ≠ 读到了）',
    /text\\":null/.test(FS_READ_JAVA) && /missing\\":true/.test(FS_READ_JAVA) &&
    /put\("missing", false\)/.test(FS_READ_JAVA) && /err\("读不出/.test(FS_READ_JAVA) &&
    /missing: true/.test(ownSrc) && /missing: false/.test(ownSrc) &&
    /r\.missing === true/.test(fs.readFileSync(path.join(ROOT, 'android/js/df-android.js'), 'utf8')),
    'Java 三样=' + [/text\\":null/.test(FS_READ_JAVA), /missing\\":true/.test(FS_READ_JAVA),
      /put\("missing", false\)/.test(FS_READ_JAVA), /读不出/.test(FS_READ_JAVA)].join('/') +
    ' 假原生=' + /missing: true/.test(ownSrc) + '/' + /missing: false/.test(ownSrc) +
    ' JS 读法=' + /r\.missing === true/.test(aShell));
  /* 壳算得再准，界面不读等于没算：bootError 两端都产了几版，ui/js/app.js 里一处都没引用过。 */
  check('★ 界面这一环接上了：bootError 排在那句原因最前，「尚未登录。」只在它没说时才补（不叠两句同样的话）',
    /var le = b\.bootError \? b\.bootError \+ ' ' : '';/
      .test(wApp) && /else if \(!b\.bootError\) le \+= '尚未登录。'/.test(wApp) &&
    /if \(b\.loginPending\) le \+=/.test(wApp) && /b\.storageFault/.test(wApp) &&
    /\(r\.storageFault \? '。但本机有文件这次没读动/.test(wApp) &&
    /if \(r\.storageFault\)/.test(wApp),
    'bootError 打头=' + /var le = b\.bootError \?/.test(wApp) +
    ' 尚未登录有条件=' + /else if \(!b\.bootError\) le \+= '尚未登录。'/.test(wApp));

  /* E8 ★ 开机那一发不许抢在装配前面 —— 今天设备上真量到的：
   *    MuMu 里盘上有 8 场，界面念的却是「尚未添加账号，请先登录 WeGame」，而那颗「跳过」按
   *    matchCount>0 判，于是不出现 —— 使用者报的"第二次打开说没数据、也跳不过"就是这个。
   *    离线测试为什么看不见：每一条都先 await __dfReady 再打 boot，等于每次替界面把装配等完了。
   *    界面是在 DOMContentLoaded 上直接打的，这里就照界面的打法量一次。 */
  const e8 = makeBridge({
    files: { 'accounts.json': ACCOUNTS, [SLOT_FILE]: SEED },
    net: function () { return NOT_LOGIN; }
  });
  const we8 = loadShim(e8);
  const raceBoot = await we8.window.df.boot();      // ★ 故意不 await __dfReady
  check('★★ 装配没跑完时 boot() 自己等：同一台机器同一次开机，报的是那 ' + matchCount + ' 场而不是"没号"',
    raceBoot.matchCount === matchCount && (raceBoot.accounts || []).length === 1 &&
    !/尚未添加账号/.test(raceBoot.bootError || ''),
    JSON.stringify({ n: raceBoot.matchCount, 号数: (raceBoot.accounts || []).length,
      err: (raceBoot.bootError || '').slice(0, 26) }));
  const readOrder = e8.calls.map(function (c) { return c.channel; });
  check('★ 顺序对得上：boot 回话之前，accounts.json 那一发读一定已经走过原生',
    readOrder.indexOf('fs.read') >= 0 &&
    e8.calls.some(function (c) { return c.channel === 'fs.read' && c.args.name === 'accounts.json'; }),
    readOrder.slice(0, 6).join(','));
  we8.window.__nativeEvent('login:window-closed', { slot: '' });

  /* E4 ★ 真机报「启动失败：(list || []).forEach is not a function」教出来的一课：
   *     A 段对的是方法名、E1 对的是"回不回 Promise"，都没对**载荷形状**。
   *     界面 ui/js/app.js:1437 拿 boot().accounts 直接 forEach，安卓那侧回的是 {list:[…]} 对象
   *     → 每次开机当场抛，而且抛在 refresh() 之前 → "启动失败" + "看不到数据" 是同一个根因。
   *     字段名一律从渲染层源码里抽，绝不在测试里另抄一份（抄的那份会跟着两边一起改错）。 */
  const uiSrc = fs.readFileSync(path.join(ROOT, 'ui', 'js', 'app.js'), 'utf8');
  const acctFrom = uiSrc.indexOf('function renderAccountSwitch');
  const acctTo = uiSrc.indexOf('/* 生成并保存战绩卡片');
  const acctSeg = uiSrc.slice(acctFrom, acctTo > acctFrom ? acctTo : uiSrc.length);
  const acctReads = Array.from(new Set((acctSeg.match(/\ba\.[A-Za-z_][A-Za-z0-9_]*/g) || [])
    .map(function (x) { return x.slice(2); })));
  check('★ 先从渲染层真抽出它读的账号字段（抽不出来 = 这条断言是空的）',
    acctReads.length >= 6 && acctReads.indexOf('slot') >= 0, acctReads.join(','));
  check('★★ boot().accounts 必须是数组、界面读的字段一个都不缺',
    Array.isArray(boot6.accounts) && acctReads.every(function (k) {
      return Object.prototype.hasOwnProperty.call(boot6.accounts[0] || {}, k);
    }), '读了 ' + acctReads.join(',') + '；实际给了 ' + JSON.stringify(Object.keys(boot6.accounts[0] || {})));
  const accList = await w6.window.df.accounts.list();
  check('★★ accounts.list() 的形状 = 桌面 account:list 那颗 handler：{ok, activeSlot, accounts:[…]}',
    accList.ok === true && accList.activeSlot === opened.slot && Array.isArray(accList.accounts) &&
    acctReads.every(function (k) {
      return Object.prototype.hasOwnProperty.call(accList.accounts[0] || {}, k);
    }), 'keys=' + Object.keys(accList).join(',') + ' 第一条=' + JSON.stringify(accList.accounts[0] || null));
  /* 当前号那两格（N 场 / 已注册）得以**已载入的 store** 为准：注册表里那份是落库时的快照，
   * 刚同步完没回写就会在设置页报「0 场 / 空槽」。w6 是刚登录的空号，量不出这件事，借 A/B 段那个装了样本的号。 */
  const accSample = await w1.window.df.accounts.list();
  check('★ 当前号的场数/名单数读的是活着的库（不是注册表里那份快照）',
    accSample.accounts[0].matches === matchCount && accSample.accounts[0].rosters > 0 &&
    accSample.accounts[0].fileExists === true,
    'matches=' + accSample.accounts[0].matches + '/' + matchCount +
    ' 名单=' + accSample.accounts[0].rosters + ' 有档=' + accSample.accounts[0].fileExists);
  const shellSrc = fs.readFileSync(path.join(ROOT, 'shell', 'main.js'), 'utf8');
  const listView = shellSrc.slice(shellSrc.indexOf('function listAccountsView'),
    shellSrc.indexOf('function listAccountsView') + 1200);
  check('★ 桌面那份 listAccountsView 也得供得上同一批字段（同一份契约，两端一起核）',
    listView.length > 200 && acctReads.every(function (k) {
      return new RegExp('\\b' + k + ':').test(listView);
    }), '桌面缺：' + acctReads.filter(function (k) {
      return !new RegExp('\\b' + k + ':').test(listView);
    }).join(','));
  const chk6 = await w6.window.df.checkLogin();
  check('★ checkLogin 不要求"已选号"（登录窗刚关掉那一下正是没号状态）',
    chk6.ok === true, JSON.stringify(chk6).slice(0, 80));
  /* 更纯的一次：一个号都没有、也没开过登录窗（collector 确实是 null），checkLogin 仍得真去验 cookie。
   * 上一版这里回「未选择账号」，于是"窗口关闭时界面复查一次登录"这条路整个是死的。 */
  const w8 = loadShim(makeBridge({
    files: { 'accounts.json': '{"version":1,"activeSlot":"","globalSettings":{},"accounts":[]}' },
    net: function () { return ROLE_OK; }
  }));
  await w8.window.__dfReady;
  const chk8 = await w8.window.df.checkLogin();
  check('★★ 空机器上 checkLogin 仍然真去验 cookie（不许回「未选择账号」）',
    chk8.ok === true && !!chk8.role && chk8.role.openid === '12345678',
    JSON.stringify(chk8).slice(0, 70));

  /* ============ E10 换号：会话里换了人，数据必须跟着进"那个人"的库 ============
   * 他的原话（2026-09-26）：「我拿我小号扫了，我要换大号，他数据还是小号的，重启也没用」。
   * 两端各有一半，合起来才是这句话：
   * ① 桌面 `startLoginWatch` 认出人之后只 bindLogin + emit，**从不切号** ⇒ 全局 store/collector
   *    仍指旧号，界面下一屏读的还是旧号的库，紧跟着那次自动同步更是拿新号的会话往旧号的库里写；
   * ② 桌面每号一罐、窗开在"当前号"那罐上 ⇒ 新会话留在旧号名下（罐子跟人走 = handoffSession）；
   *    安卓整机一罐，但旧写法 `acctOfOpenid(openid) || slotWanted` 会把**别人的槽**改名换主。
   * ★ 这一段全是真跑：假原生回"另一个人的角色"，量注册表、量落盘文件、量被守卫挡住时一个字都没写。 */
  const ROLE_B = { ok: true, text: JSON.stringify({
    result: { error_code: 0 },
    role_info: { openid: '99999999', area: 36, name: '后来扫进来的大号', level: 50 } }) };
  const e10bridge = makeBridge({
    files: { 'accounts.json': ACCOUNTS, [SLOT_FILE]: SEED },
    net: function () { return ROLE_B; }
  });
  const e10 = loadShim(e10bridge);
  await e10.window.__dfReady;
  const e10Done = [];
  e10.window.df.on('login:done', function (e) { e10Done.push(e); });
  await e10.window.df.openLogin();
  await new Promise(function (r) { setTimeout(r, 3200); });
  const e10Acct = JSON.parse(e10bridge.files['accounts.json'] || '{"accounts":[]}');
  const e10New = (e10Acct.accounts || []).filter(function (a) { return a.openid === '99999999'; })[0] || null;
  check('★★ 小号的槽没被改名换主：大号是**另一个**槽，小号那条记录 openid 一个字没动',
    !!e10Done[0] && !!e10New && e10New.slot !== SLOT &&
    (e10Acct.accounts || []).length === 2 &&
    (e10Acct.accounts.filter(function (a) { return a.openid === '12345678'; })[0] || {}).slot === SLOT,
    'done.slot=' + (e10Done[0] || {}).slot + ' 大号槽=' + (e10New || {}).slot +
    ' 共 ' + (e10Acct.accounts || []).length + ' 条');
  const e10Boot = await e10.window.df.boot();
  check('★★ 登录成功那一下当前号就切到大号了（不是"绑上了但界面还读小号"）',
    e10Boot.activeSlot === (e10New || {}).slot && e10Boot.matchCount === 0,
    'activeSlot=' + e10Boot.activeSlot + ' matchCount=' + e10Boot.matchCount);
  check('★ 小号那 8 场仍在它自己的文件里，一个字节没被盖掉',
    e10bridge.files[SLOT_FILE] === SEED,
    '字节相同=' + (e10bridge.files[SLOT_FILE] === SEED) + ' 长度=' +
    String(e10bridge.files[SLOT_FILE] || '').length + '/' + SEED.length);
  /* 守卫的反面教材：当前号是 A 而会话是 B 时同步必须一个字都不写。
   * 这里手工把 activeSlot 摆回小号（等价于"旧版本留下的那种错状态"），再发一次同步。 */
  const e10b = JSON.parse(ACCOUNTS);
  e10b.accounts.push({ slot: 'm99999999', openid: '99999999', name: '后来扫进来的大号',
    area: 36, accountType: 1, created_at: 1, last_sync: 2 });
  const e10bridge2 = makeBridge({
    files: { 'accounts.json': JSON.stringify(e10b), [SLOT_FILE]: SEED },
    net: function () { return ROLE_B; }
  });
  const e10w2 = loadShim(e10bridge2);
  await e10w2.window.__dfReady;                       // activeSlot 仍是被摆回去的小号
  const e10Sync = await e10w2.window.df.sync({ withDetail: false });
  check('★★ 罐子里的人与这个号登记的不是同一个人：同步被挡，回包带着 ownerMismatch 与那句实话',
    e10Sync.ok === false && e10Sync.ownerMismatch === true &&
    /没有往库里写一个字节/.test(e10Sync.error || '') &&
    /后来扫进来的大号/.test(e10Sync.error || ''),
    JSON.stringify(e10Sync).slice(0, 150));
  check('★★★ 被挡这一次真的一个字都没写（小号的库与进来前逐字节相同）',
    e10bridge2.files[SLOT_FILE] === SEED,
    '相同=' + (e10bridge2.files[SLOT_FILE] === SEED));
  const e10w3 = loadShim(makeBridge({
    files: { 'accounts.json': ACCOUNTS, [SLOT_FILE]: SEED },
    net: function () { return ROLE_OK; }          // 会话里就是本号那个人
  }));
  await e10w3.window.__dfReady;
  const e10Sync2 = await e10w3.window.df.sync({ withDetail: false });
  check('★ 对得上就不该挡：同一个人同步时绝不出现 ownerMismatch（守卫不是"一律不许同步"）',
    !e10Sync2.ownerMismatch, JSON.stringify(e10Sync2).slice(0, 110));
  e10.window.__nativeEvent('login:window-closed', { slot: '' });

  /* 桌面那半：main.js 起不来（要 electron），就把这几个函数原样抠出来真跑假注册表 + 假实例表 */
  function ownFn(name) {
    const s = handlerSrcOf(wShell, 'function ' + name);
    if (!s) throw new Error('main.js 里抠不出 ' + name);
    return s;
  }
  function runOwnership(accounts, activeSlot, instanceKeys) {
    const code =
      'var accounts = ' + JSON.stringify(accounts) + ';\n' +
      'accounts.activeSlot = ' + JSON.stringify(activeSlot) + ';\n' +
      'var slots = new Map();\n' +
      (instanceKeys || []).map(function (k) {
        return 'slots.set(' + JSON.stringify(k) + ', { slot: ' + JSON.stringify(k) + ' });';
      }).join('\n') + '\n' +
      'var store = {who:"当前号的库"}, collector = {who:"当前号的采集器"}, wegameSession = {who:"当前号的罐子"};\n' +
      'var saved = 0; function saveAccountsSync(){ saved++; }\n' +
      ownFn('partitionFor') + '\n' + ownFn('acctOfSlot') + '\n' + ownFn('jarOf') + '\n' +
      ownFn('handoffSession') + '\n' +
      'return { handoff: handoffSession, jarOf: jarOf, accounts: accounts, slots: slots, ' +
      'saved: function () { return saved; }, ' +
      'live: function () { return { store: store, collector: collector, wegameSession: wegameSession }; } };';
    return new Function(code)();
  }
  const JAR_A1 = 'persist:wegame-slot-a1';
  const twoAccts = { version: 1, accounts: [
    { slot: 'a1', openid: '111', name: '小号', partition: JAR_A1 },
    { slot: 'a2', openid: '222', name: '大号', partition: 'persist:wegame-slot-a2' }
  ] };
  const own1 = runOwnership(JSON.parse(JSON.stringify(twoAccts)), 'a1', ['a1', 'a2']);
  const h1 = own1.handoff(JAR_A1, 'a2');
  const a1rec = own1.accounts.accounts[0], a2rec = own1.accounts.accounts[1];
  check('★★ 桌面罐子跟人走：a1 那罐改挂到大号名下，小号换一枚全新空罐',
    h1.moved === true && a2rec.partition === JAR_A1 &&
    a1rec.partition !== JAR_A1 && /^persist:wegame-slot-a1-v\d+$/.test(a1rec.partition) &&
    h1.displaced.join(',') === 'a1',
    'a1→' + a1rec.partition + ' a2→' + a2rec.partition + ' displaced=' + JSON.stringify(h1.displaced));
  check('★★ 换完号，旧号那套内存实例必须当场作废（留着就是拿大号的会话采小号的库）',
    !own1.slots.has('a1') && !own1.slots.has('a2') && own1.live().store === null &&
    own1.live().collector === null && own1.saved() === 1,
    '实例残留=' + (own1.slots.has('a1') || own1.slots.has('a2')) + ' store=' +
    JSON.stringify(own1.live().store));
  const before = JSON.stringify(own1.accounts);
  const h1again = own1.handoff(JAR_A1, 'a2');
  check('★ 同一罐再交一次必须什么都不做（幂等：登录轮一圈回来不该把人换来换去）',
    h1again.moved === false && JSON.stringify(own1.accounts) === before && own1.saved() === 1,
    'moved=' + h1again.moved + ' 又落盘=' + own1.saved());
  const own2 = runOwnership(JSON.parse(JSON.stringify(twoAccts)), 'a1', ['a1']);
  const h2 = own2.handoff('persist:wegame-slot-a3', 'a2');
  check('★ 罐子本来不属于任何在册的号（新开一窗的预留罐）：只认领、不顶人，当前号那套实例不许被摘',
    h2.moved === true && h2.displaced.length === 0 &&
    own2.accounts.accounts[1].partition === 'persist:wegame-slot-a3' &&
    own2.accounts.accounts[0].partition === JAR_A1 && own2.live().store !== null,
    'displaced=' + JSON.stringify(h2.displaced) + ' store 还在=' + (own2.live().store !== null));
  const own3 = runOwnership({ version: 1, accounts: [
    { slot: 'a1', openid: '111', partition: 'persist:wegame-slot-a1-v9' }] }, 'a1', []);
  check('★★ jarOf 读的是注册表里那枚 partition，不是按 slot 现算（否则换过罐子的号又开回旧罐）',
    own3.jarOf('a1') === 'persist:wegame-slot-a1-v9' &&
    own3.jarOf('a7') === 'persist:wegame-slot-a7',
    'a1=' + own3.jarOf('a1'));
  const watchSrc = handlerSrcOf(wShell, 'function startLoginWatch');
  check('★★ 桌面登录成功那一条链的顺序：bindLogin → 交罐子 → 切号 → 才许 emit login:done',
    ['bindLogin(', 'handoffSession(', 'switchTo(bound.slot)', "emit('login:done'"].every(function (k, i) {
      const at = ['bindLogin(', 'handoffSession(', 'switchTo(bound.slot)', "emit('login:done'"].map(function (x) {
        return watchSrc.indexOf(x);
      });
      return at[i] >= 0 && (i === 0 || at[i] > at[i - 1]);
    }),
    ['bindLogin(', 'handoffSession(', 'switchTo(bound.slot)', "emit('login:done'"].map(function (x) {
      return x + '@' + watchSrc.indexOf(x);
    }).join(' '));
  const openWinSrc = (function () {
    const s = handlerSrcOf(wShell, 'function openLoginWindow');
    return s;
  })();
  check('★★ 开登录窗按注册表里那枚罐子开（jarOf），不许再按 slot 现算',
    /const partition = jarOf\(slot\);/.test(openWinSrc) &&
    openWinSrc.indexOf('partitionFor(slot)') === -1,
    'jarOf=' + /const partition = jarOf\(slot\);/.test(openWinSrc) +
    ' 现算残留=' + (openWinSrc.indexOf('partitionFor(slot)') >= 0));
  const syncSrc = handlerSrcOf(wShell, 'function runSync');
  /* ★ 光钉"这个词出现在 ingest 之前"不够：把守卫写成 `if (false && ownerConflict(...))`，
   *   字面还在、顺序还对，可它永远不进 —— 那条变异（O5）就是这么躲过去的。
   *   所以要钉的是**活的**那一形：`if (StoreMod.ownerConflict(` 直接跟参数，且拒绝分支真在入库前回。 */
  check('★★ 桌面入库前的归属核对是活的（if 直接跟着那颗判据），且排在 store.ingest 之前、拒绝分支先 return',
    /if \(StoreMod\.ownerConflict\(/.test(syncSrc) &&
    syncSrc.indexOf('if (StoreMod.ownerConflict(') < syncSrc.indexOf('store.ingest(payload)') &&
    /ok: false, ownerMismatch: true, inserted: 0/.test(syncSrc) &&
    syncSrc.indexOf('ownerMismatch: true') < syncSrc.indexOf('store.ingest(payload)') &&
    syncSrc.indexOf('没有往库里写一个字节') < syncSrc.indexOf('store.ingest(payload)'),
    '活守卫=' + /if \(StoreMod\.ownerConflict\(/.test(syncSrc) +
    ' 核对@' + syncSrc.indexOf('if (StoreMod.ownerConflict(') +
    ' 入库@' + syncSrc.indexOf('store.ingest(payload)'));
  const aShell10 = fs.readFileSync(path.join(ROOT, 'android/js/df-android.js'), 'utf8');
  const aSyncSrc = handlerSrcOf(aShell10, 'function runSync');
  check('★★ 安卓入库前也走同一颗判据，同样是活的（整机一罐，切到 C 号而罐子里是 A 号时照样会串库）',
    /if \(Core\.Store\.ownerConflict\(/.test(aSyncSrc) &&
    aSyncSrc.indexOf('if (Core.Store.ownerConflict(') < aSyncSrc.indexOf('store.ingest(payload)') &&
    /ok: false, ownerMismatch: true, inserted: 0/.test(aSyncSrc) &&
    aSyncSrc.indexOf('没有往库里写一个字节') < aSyncSrc.indexOf('store.ingest(payload)'),
    '活守卫=' + /if \(Core\.Store\.ownerConflict\(/.test(aSyncSrc) +
    ' 核对@' + aSyncSrc.indexOf('if (Core.Store.ownerConflict(') +
    ' 入库@' + aSyncSrc.indexOf('store.ingest(payload)'));
  /* ★ 数的是**调用点**（`.ownerConflict(`）而不是名字出现几次：两边注释里都会提一句这颗判据，
   *    按名字数就成"注释写得多就红"，那是量测自己先说谎（S5 同一课的另一种犯法）。 */
  check('★★ 判据只有一份：两个壳各只调 core 那一颗（谁都不许另写一份"不相等就拒"）',
    (wShell.match(/\.ownerConflict\(/g) || []).length === 1 &&
    (aShell10.match(/\.ownerConflict\(/g) || []).length === 1 &&
    /function ownerConflict/.test(fs.readFileSync(path.join(ROOT, 'core/store.js'), 'utf8')),
    '桌面调用=' + (wShell.match(/\.ownerConflict\(/g) || []).length +
    ' 安卓调用=' + (aShell10.match(/\.ownerConflict\(/g) || []).length);
  /* 只认赋值那一手（注释里举旧写法当反例是刻意的，别把它算成残留） */
  check('★★ 安卓 bindLogin 不许再把别人的槽直接接过来（slot = acctOfOpenid(...) 后面不许再 || slotWanted）',
    !/=\s*acctOfOpenid\(openid\)\s*\|\|\s*slotWanted/.test(aShell10) &&
    /var slot = acctOfOpenid\(openid\);/.test(aShell10),
    '残留=' + /=\s*acctOfOpenid\(openid\)\s*\|\|\s*slotWanted/.test(aShell10));
  /* 界面那句（loadFault）照 E9 的规矩：抠出来真跑两种回包，不许用"字符串在不在"糊 */
  const doneFnSrc = handlerSrcOf(wApp, "global.df.on('login:done',");
  function runDoneHandler(evt) {
    const els = {};
    const $$ = function (id) {
      if (!els[id]) els[id] = { textContent: '', className: '' };
      return els[id];
    };
    const stubs = {
      $: $$, state: {}, setOffline: function () {},
      loadAccounts: function () { return Promise.resolve(); },
      showApp: function () {}, refresh: function () { return Promise.resolve(); },
      doSync: function () { return Promise.resolve(); }
    };
    const fn = new Function('$', 'state', 'setOffline', 'loadAccounts', 'showApp', 'refresh', 'doSync',
      'return (' + doneFnSrc + ')');
    fn(stubs.$, stubs.state, stubs.setOffline, stubs.loadAccounts, stubs.showApp,
      stubs.refresh, stubs.doSync)(evt);
    return els.loginStatus;
  }
  const dPlain = runDoneHandler({ role: { name: '甲' }, slot: 'a1' });
  const dFault = runDoneHandler({ role: { name: '甲' }, slot: 'a1',
    loadFault: '这个号的库这次没读出来：EPERM' });
  check('★ 界面：回包没带 loadFault 就不许凭空念"库没读出来"',
    dPlain.textContent.indexOf('没读出来') === -1 && /登录成功：甲/.test(dPlain.textContent),
    JSON.stringify(dPlain.textContent));
  check('★★ 界面：切过去之后发现那个号的库没读动，必须当场改口并标成错色（与"没有数据"分开）',
    /这个号的库这次没读出来/.test(dFault.textContent) &&
    dFault.textContent.indexOf('EPERM') >= 0 && dFault.className === 'login-status err',
    JSON.stringify(dFault.textContent + ' | ' + dFault.className));

  /* 「已备份到：undefined」那一发的根不在文案，在契约：界面读的字段壳里压根没回。
   * ★ 手法照 E4：字段名从**消费者**源码里抽，期望值从**生产者**（doBackup 的 return）里现取，
   *    两头都不许另抄一份清单 —— 抄的那份会跟着两边一起改错。 */
  const backupHandlerSrc = handlerSrcOf(wApp, "$('btnBackupNow').addEventListener('click', function");
  /* ★ 抽字段名之前先把注释摘掉：这段注释里正举着旧写法 `r.name` 当反例，
   *    连着注释一起扫就变成"注释在说话、测试在报警"（注释不该有断言权重）。 */
  const backupCode = backupHandlerSrc.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const backupReads = Array.from(new Set((backupCode.match(/\br\.([a-zA-Z]+)/g) || [])
    .map(function (s) { return s.slice(2); })))
    .filter(function (k) { return k !== 'ok' && k !== 'error' && k !== 'message'; });
  const returnsBackup = ((handlerSrcOf(wShell, 'function doBackup').match(/return \{[^}]*\}/g) || [])).join(' ');
  check('★★ 「立即备份」那句 toast 读的字段 doBackup 每一个都回（上一版念 r.name，回的是 files/count ⇒ 次次 undefined）',
    backupReads.length >= 2 && backupReads.every(function (k) {
      return new RegExp('\\b' + k + ':').test(returnsBackup);
    }), '读=' + backupReads.join(',') + ' 缺=' + backupReads.filter(function (k) {
      return !new RegExp('\\b' + k + ':').test(returnsBackup);
    }).join(','));

  /* 「看得见」这一句也得真跑一遍界面：抠出 loadBackupInfo，喂两份假备份，看它把什么画出来。
   * （上一版这里只有一行"最近备份：时间（KB）×3"，号、场数、跨度一个都没有 —— 而那行代码本身没写错，
   *    错的是它上游认不出文件。所以这两处要分开钉：契约钉 E10 那条，渲染钉这一条。） */
  const loadBackupSrc = handlerSrcOf(wApp, 'function loadBackupInfo');
  function runBackupInfo(reply) {
    const els = { backupDirText: { textContent: '' }, backupList: { innerHTML: '' } };
    const g = { df: { backupInfo: function () { return Promise.resolve(reply); } },
      DFViews: { esc: function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); } } };
    const fn = new Function('$', 'global', 'fmtSpan', 'fmtStamp', 'return (' + loadBackupSrc + ')');
    return fn(function (id) { return els[id]; }, g,
      function (sec) { var d = new Date(Number(sec) * 1000); return (d.getMonth() + 1) + '/' + d.getDate(); },
      function (ms) { return '09-26 09:29'; })().then(function () { return els.backupList.innerHTML; });
  }
  const bkHtml = await runBackupInfo({
    dir: 'X:\\backups', keep: 7, total: 25, count: 2,
    list: [
      { name: 'a1.json', time: 1764129000000, size: 460800, slot: 'a1', tag: 'manual',
        sum: { kind: 'library', matches: 42, rosters: 42, first: 1787000000, last: 1789900000, name: '甲号' } },
      { name: 'acc.json', time: 1764129000000, size: 1900, slot: 'accounts', tag: 'daily-2026-09-26',
        sum: { kind: 'accounts', accounts: 2, who: '甲号、乙号' } }
    ]
  });
  check('★★ 备份列表念得出"谁的号 / 几场 / 跨度到哪天 / 手动还是每日"，还带着按号留几份',
    bkHtml.indexOf('甲号') >= 0 && /42 场/.test(bkHtml) && /名单 42 份/.test(bkHtml) &&
    /共 25 份/.test(bkHtml) && bkHtml.indexOf('手动') >= 0 && bkHtml.indexOf('每日') >= 0,
    bkHtml.replace(/<[^>]+>/g, '|').slice(0, 150));
  check('★★ 列表里不许出现 undefined / null 这种"字段没接上"的字（上一版「已备份到：undefined」同一类）',
    bkHtml.indexOf('undefined') === -1 && bkHtml.indexOf('null') === -1,
    bkHtml.replace(/<[^>]+>/g, '|').slice(0, 150));
  check('★ 账号表那份要标成"账号表"，不许跟战绩库混成同一种行（它会误导人去找"恢复"）',
    bkHtml.indexOf('账号表') >= 0 && bkHtml.indexOf('甲号、乙号') >= 0,
    bkHtml.replace(/<[^>]+>/g, '|').slice(0, 200));
  const bkEmpty = await runBackupInfo({ dir: 'X:\\backups', keep: 7, total: 0, count: 0, list: [] });
  check('★ 真的一份都没有时，那句就是"还没有备份文件。"（不许拿空数组糊过去）',
    bkEmpty === '还没有备份文件。', JSON.stringify(bkEmpty));

  {
  /* ---------------- F 插件层（真跑 plugins-dist 里那两个包） ----------------
   * 这一段是 #34 的全部理由：桌面上"装一个包 → 逐条批权限 → 用它的能力"这一整条链，
   * 在手机上必须由另一份宿主（android/js/plugin-host.js）走通。
   * 这里的假原生照 Java 那几条通道的语义写（specs 对照表 / sha256 前 16 位 / 出网底线），
   * 它验的是 JS 宿主的判定与编排；Java 自己那条 inflate 路径只能等真机（见手册 §11）。 */
  console.log('\n[F] 插件层：装包 → 批权限 → 供页 → 调用 → 闸门 → 卸载');
  const DEMO_ZIP = fs.readFileSync(path.join(ROOT, 'plugins-dist', 'df.demo.summary-1.1.0.zip'));
  const AI_ZIP = fs.readFileSync(path.join(ROOT, 'plugins-dist', 'df.ai.analyst-1.1.1.zip'));
  let zipBuf = DEMO_ZIP;
  const netCalls = [];
  const fb = makeBridge({
    files: { 'accounts.json': ACCOUNTS, [SLOT_FILE]: SEED },
    net: function () { return ROLE_OK; },
    pickZip: function () { return zipBuf; },
    zipName: 'df.demo.summary-1.1.0.zip',
    netFetch: function () {
      const a = arguments[0];
      netCalls.push(a);
      return {
        ok: true, status: 200, contentType: 'application/json',
        text: JSON.stringify({ ok: 1 }), setCookies: ['sess=abc; Path=/']
      };
    },
    stream: [
      { type: 'net.open', data: { status: 200, contentType: 'text/event-stream' } },
      { type: 'net.data', data: { text: '第一段' } },
      { type: 'net.data', data: { text: '第二段' } },
      { type: 'net.end', data: { status: 200 } }
    ],
    /* 正文带 hold:true 的那条只开到一半就吊着 —— 「同时只留一条流」要有东西占着才验得出来 */
    streamHold: true
  });
  const wf = loadShim(fb);
  await wf.window.__dfReady;
  const plg = [];
  wf.window.df.on('plugin:evt', function (m) { plg.push(m); });

  const ins = await wf.window.df.plugin.inspect();
  check('★ 开箱第一步是真在解这个包：清单/权限/两条指纹/文件数都出来了',
    ins.ok === true && ins.manifest.id === 'df.demo.summary' && /^[0-9a-f]{8,}$/.test(ins.permFp || '') &&
    /^[0-9a-f]{8,}$/.test(ins.packageHash || '') && ins.files.length === ins.fileCount,
    'id=' + (ins.manifest && ins.manifest.id) + ' files=' + ins.fileCount + ' 包指纹=' + ins.packageHash);
  check('★ 权限每一项都带宿主认识的 label 与说明（文案唯一出处是 core/plugin.js）',
    (ins.permissions || []).length > 0 && ins.permissions.every(function (x) {
      return !!x.label && !!x.desc;
    }), (ins.permissions || []).map(function (x) { return x.scope; }).join(','));
  const half = ins.manifest.permissions.map(function (x) { return x.scope; }).slice(0, 1);
  const refused = await wf.window.df.plugin.install(ins.token, half);
  check('★ 少勾一项权限就是不装（不是"先装上再说"）',
    refused.ok === false && /没被勾选/.test(refused.error || ''), JSON.stringify(refused).slice(0, 90));

  const ins2 = await wf.window.df.plugin.inspect();
  const allScopes = ins2.manifest.permissions.map(function (x) { return x.scope; });
  const put = await wf.window.df.plugin.install(ins2.token, allScopes);
  const DEMO = 'df.demo.summary';
  check('★ 全批之后才装得上，且新装的插件默认是禁用的',
    put.ok === true && put.plugin && put.plugin.enabled === false && put.list.plugins.length === 1,
    'id=' + (put.plugin && put.plugin.id));
  check('★ 装完立刻复核：文件与登记一致才算 intact',
    put.list.plugins[0].intact === true && put.list.plugins[0].fileCount > 1,
    'fileCount=' + put.list.plugins[0].fileCount);
  const en = await wf.window.df.plugin.setEnabled(DEMO, true);
  check('启用后 list 里 enabledCount 跟上',
    en.ok === true && en.list.enabledCount === 1, 'enabledCount=' + en.list.enabledCount);
  const pg = await wf.window.df.plugin.page(DEMO);
  check('★ 供页：入口 html、脚本与版式表三样都拿到了（沙箱读不到宿主 css，只能随页给）',
    pg.ok === true && /<div|<section|<main/i.test(pg.html) && /DFPlugin/.test(pg.script) &&
    pg.baseCss.length > 200 && !!pg.hostVersion,
    'html=' + pg.html.length + 'B script=' + pg.script.length + 'B baseCss=' + pg.baseCss.length + 'B');
  const hi = await wf.window.df.plugin.call(DEMO, 'host.info', {});
  check('host.info 回的是宿主记的那份 scope（插件自己说了不算）',
    hi.ok === true && hi.scopes.slice().sort().join(',') === allScopes.slice().sort().join(','),
    'scopes=' + hi.scopes.join(','));
  const sum = await wf.window.df.plugin.call(DEMO, 'summary.get', { mode: 'all' });
  check('★ read.summary 给的是聚合数字，且确实是 core 算出来的同一场次数',
    sum.ok === true && sum.totals.matches === matchCount && sum.totals.winRate !== undefined &&
    JSON.stringify(sum).indexOf('room_id') === -1 && JSON.stringify(sum).indexOf('12345678') === -1,
    'matches=' + sum.totals.matches + ' 胜率=' + sum.totals.winRate);
  const kvSet = await wf.window.df.plugin.call(DEMO, 'kv.set', { key: 'note', value: '第一行' });
  const kvGet = await wf.window.df.plugin.call(DEMO, 'kv.get', { key: 'note' });
  const kvAll = await wf.window.df.plugin.call(DEMO, 'kv.get', {});
  check('kv 存进去取得回来，不带 key 就是整个对象',
    kvSet.ok === true && kvGet.value === '第一行' && kvAll.value.note === '第一行');
  check('★ 插件的配置存在宿主自己的文件里（不混进战绩数据包，也就不跟着导出走）',
    Object.keys(fb.files).indexOf('plugin-df.demo.summary.json') >= 0 &&
    (fb.files[SLOT_FILE] || '').indexOf('第一行') === -1, 'plugin-df.demo.summary.json');
  const kvBad = await wf.window.df.plugin.call(DEMO, 'kv.set', { key: '__host', value: 1 });
  check('宿主保留前缀不给插件写', kvBad.ok === false && /保留/.test(kvBad.error || ''), kvBad.error);
  const noNet = await wf.window.df.plugin.call(DEMO, 'net.request',
    { url: 'https://example.com/', body: {} });
  check('★ 没批过的 scope 就是不给（这个包压根没要 net.request）',
    noNet.ok === false && /没有申请/.test(noNet.error || ''), noNet.error);
  const noMethod = await wf.window.df.plugin.call(DEMO, 'deleteEverything', {});
  check('宿主方法表之外的名字一律拒绝', noMethod.ok === false && /没有这个方法/.test(noMethod.error || ''));
  /* ★ 落盘之后被改过：这是"请重新导入这个包"那句话唯一能被验证的地方 */
  fb.plugDirs[DEMO][put.plugin.entry] = Buffer.from('<html><body>被改过的入口</body></html>');
  const tampered = await wf.window.df.plugin.verify(DEMO);
  const tamPage = await wf.window.df.plugin.page(DEMO);
  check('★ 改一个字节就被查出来，并且拒绝继续供页',
    tampered.ok === false && /不一致/.test(tampered.message || '') &&
    tamPage.ok === false && /不一致/.test(tamPage.error || ''), tampered.message);
  await wf.window.df.plugin.remove(DEMO);
  check('卸载：登记表、插件目录、配置三份一起清掉',
    fb.plugDirs[DEMO] === undefined &&
    (fb.files['plugins.json'] || '').indexOf(DEMO) === -1 &&
    fb.files['plugin-df.demo.summary.json'] === undefined);

  /* AI 包：它带 net.request（hosts 是 ["*"]）与 read.digest，闸门与摘要这一段只有它能演 */
  zipBuf = AI_ZIP;
  const insA = await wf.window.df.plugin.inspect();
  check('★ 换包就是换一份预览：确认句从清单里来，不写死在宿主',
    insA.ok === true && insA.manifest.id === 'df.ai.analyst' && !!insA.manifest.consent &&
    !!insA.manifest.consent.sentence, '确认句=' + (insA.manifest.consent || {}).sentence);
  const allA = insA.manifest.permissions.map(function (x) { return x.scope; });
  await wf.window.df.plugin.install(insA.token, allA);
  const AI = 'df.ai.analyst';
  await wf.window.df.plugin.setEnabled(AI, true);
  const early = await wf.window.df.plugin.call(AI, 'net.request',
    { url: 'https://api.deepseek.com/v1/chat', body: { a: 1 } });
  check('★★ 没逐字确认过，一个字节也发不出去（闸门在宿主，不在插件页）',
    early.ok === false && /逐字确认/.test(early.error || '') && netCalls.length === 0, early.error);
  const wrong = await wf.window.df.plugin.consent(AI, '这句话故意打错一点点');
  check('★ 确认句差一个字都不算数', wrong.ok === false && /不一致/.test(wrong.error || ''), wrong.error);
  const okc = await wf.window.df.plugin.consent(AI, '  ' + insA.manifest.consent.sentence + '。 ');
  check('★ 句末多个句号、前后带空格仍然算同一句（归一化口径与桌面同一份）',
    okc.ok === true && (okc.list.plugins.filter(function (p) {
      return p.id === AI;
    })[0] || {}).consentGiven === true, okc.error);
  const sent = await wf.window.df.plugin.call(AI, 'net.request',
    { url: 'https://api.deepseek.com/v1/chat', body: { a: 1 }, method: 'POST' });
  const lastCall = netCalls[netCalls.length - 1] || {};
  check('★ 确认之后才真发出去，且交给原生的是清单里那份域名名单',
    sent.ok === true && lastCall.body === '{"a":1}' &&
    (lastCall.allow || []).indexOf('*') >= 0, 'allow=' + JSON.stringify(lastCall.allow));
  check('★ 回给插件的只有状态与解析结果，原生的东西（setCookies 之类）不跟着回去',
    sent.status === 200 && !!sent.json && sent.json.ok === 1 && sent.setCookies === undefined);
  const httpBad = await wf.window.df.plugin.call(AI, 'net.request',
    { url: 'http://10.1.2.3/api', body: {} });
  const portBad = await wf.window.df.plugin.call(AI, 'net.request',
    { url: 'https://api.deepseek.com:8443/v1/chat', body: {} });
  check('★ 线上底线：明文只许本机、非标准端口一律拒',
    httpBad.ok === false && /明文 http/.test(httpBad.error || '') &&
    portBad.ok === false && /标准 https 端口/.test(portBad.error || ''),
    httpBad.error + ' / ' + portBad.error);
  const dig = await wf.window.df.plugin.call(AI, 'ai.digest', { scope: 'global' });
  check('★ read.digest 给的是宿主算好的去敏文字（openid 与昵称都不在里面）',
    dig.ok === true && dig.text.length > 100 && dig.bytes > 0 &&
    dig.text.indexOf('12345678') === -1 && dig.text.indexOf(seeded.meta.name) === -1,
    'bytes=' + dig.bytes + ' tokens≈' + dig.estTokens);
  const lst = await wf.window.df.plugin.call(AI, 'ai.digest', { list: true });
  const firstHandle = ((lst.rows || [])[0] || {}).handle || '';
  const one = await wf.window.df.plugin.call(AI, 'ai.digest', { scope: 'match', handle: firstHandle });
  check('★ 单场摘要靠号牌选中场次：真 room_id 不出宿主',
    lst.ok === true && lst.rows.length > 0 && one.ok === true && one.handle === firstHandle &&
    JSON.stringify(one).indexOf(String(Object.keys(seeded.matches)[0])) === -1,
    'rows=' + lst.rows.length);
  const stale = await wf.window.df.plugin.call(AI, 'ai.digest',
    { scope: 'match', handle: 'm没有这个号牌' });
  check('号牌过期就重来（不给一个"随便哪一场"的兜底）',
    stale.ok === false && /号牌已失效/.test(stale.error || ''));
  const arm = await wf.window.df.plugin.call(AI, 'trigger.arm', { on: true });
  check('trigger.arm 记在登记表上（它不进权限指纹，不然每次开关都自判篡改）',
    arm.ok === true && arm.on === true);
  const note = await wf.window.df.plugin.call(AI, 'trigger.take', {});
  check('同步没跑过时 take 就是 null（不编一个待办出来）',
    note.ok === true && note.trigger === null, JSON.stringify(note));
  const st0 = await wf.window.df.plugin.call(AI, 'net.stream',
    { url: 'https://api.deepseek.com/v1/chat', body: { stream: true } });
  await new Promise(function (r) { setTimeout(r, 200); });
  const evs = plg.filter(function (m) { return m.pluginId === AI; });
  const kinds = evs.map(function (m) { return m.event; });
  check('★ 流式：open → data → end 三类都转成了 plugin:evt，且顺序不变',
    st0.ok === true && !!st0.streamId && kinds.join(',') === 'net.open,net.data,net.end',
    '事件=' + kinds.join(','));
  const texts = evs.filter(function (m) { return m.event === 'net.data'; })
    .map(function (m) { return m.data.text; });
  check('★ 两个分片合成一帧给界面（40ms 窗口），正文一个字不丢',
    texts.length === 1 && texts[0] === '第一段第二段', JSON.stringify(texts));
  check('★ 事件只认这条流当初挂在哪个插件上（切了页不能把上一家的正文吐进这一家）',
    evs.length > 0 && !plg.some(function (m) { return m.pluginId === DEMO; }));
  const two = await wf.window.df.plugin.call(AI, 'net.stream',
    { url: 'https://api.deepseek.com/v1/chat', body: { hold: true } });
  await new Promise(function (r) { setTimeout(r, 120); });
  const st1 = await wf.window.df.plugin.call(AI, 'net.stream',
    { url: 'https://api.deepseek.com/v1/chat', body: {} });
  check('★ 一个插件同时只留一条流（否则 20 次/分的额度能被十个连接绕过）',
    two.ok === true && st1.ok === false && /上一条请求还没结束/.test(st1.error || ''), st1.error);
  const notMine = await wf.window.df.plugin.call(AI, 'net.abort', { streamId: 's9999' });
  check('abort 只认自己名下的 streamId',
    notMine.ok === false && /没有这条请求/.test(notMine.error || ''), notMine.error);
  const ab = await wf.window.df.plugin.call(AI, 'net.abort', { streamId: two.streamId });
  const st2 = await wf.window.df.plugin.call(AI, 'net.stream',
    { url: 'https://api.deepseek.com/v1/chat', body: {} });
  check('★ abort 之后那个坑就腾出来了（吊着的流不会永远占着名额）',
    ab.ok === true && st2.ok === true, 'abort=' + JSON.stringify(ab) + ' 再开=' + JSON.stringify(st2));
  const rev = await wf.window.df.plugin.revokeConsent(AI);
  const after = await wf.window.df.plugin.call(AI, 'net.request',
    { url: 'https://api.deepseek.com/v1/chat', body: {} });
  check('★ 撤销允许之后立刻又发不出去了',
    rev.ok === true && after.ok === false && /逐字确认/.test(after.error || ''), after.error);
  const leg = await wf.window.df.plugin.call(AI, 'legacy.check', {});
  check('read.legacy 在这台机器上如实回"没有"（不演一次成功搬运）',
    leg.ok === true && leg.hasAnything === false, JSON.stringify(leg));
  /* 沙箱帧直连原生：Java 侧那句令牌判定在假原生里同样生效 */
  const spy = [];
  const realReply = wf.window.__reply;
  wf.window.__reply = function (id, text) { spy.push({ id: id, text: text }); };
  fb.call('fs.read', JSON.stringify({ name: SLOT_FILE }), 4242, '猜的令牌');
  await new Promise(function (r) { setTimeout(r, 30); });
  wf.window.__reply = realReply;
  check('★★ 沙箱帧没有令牌：一个字的内容都拿不到（这条是安卓插件层的立足点）',
    spy.length === 1 && /没有桥令牌/.test(spy[0].text) && spy[0].text.indexOf('room_id') === -1,
    (spy[0] || {}).text);

  /* ---------------- G 多账号 A 方案：包属于谁就落进谁的库 ---------------- */
  console.log('\n[G] A 方案：导别人的包 = 落一个只读号，不是并进当前号');
  const B_BUNDLE = JSON.stringify({
    meta: { openid: '99998888', name: '小号B', area: 36, last_sync: 123, first_seen: 100 },
    matches: { rB1: { room_id: 'rB1', start_time: 1, dt_event_time: '2026-09-01 10:00', kill: 3 } },
    rosters: { rB1: { players: [{ vopenid: 'id:x', name: '甲' }] } },
    seasons: {}, flags: {}
  });
  const gb = makeBridge({
    files: { 'accounts.json': ACCOUNTS, [SLOT_FILE]: SEED },
    net: function () { return ROLE_OK; },
    pick: function () { return { ok: true, name: 'B的数据包.json', text: B_BUNDLE }; }
  });
  const gw = loadShim(gb);
  await gw.window.__dfReady;
  const imp = await gw.window.df.restore();
  const greg = JSON.parse(gb.files['accounts.json']);
  const NEW = greg.accounts.filter(function (x) { return x.imported; })[0] || {};
  check('★ 不再拒收：为本机新建一个号并切过去（手机上登不进 B，导包是它唯一的来路）',
    imp.ok === true && imp.switched === true && imp.isNew === true && imp.added === 1 &&
    /^a\d+$/.test(String(NEW.slot || '')) && NEW.slot !== SLOT && imp.slot === NEW.slot,
    JSON.stringify(imp));
  check('★ 新号标成只读（imported），当前号切到它',
    greg.activeSlot === NEW.slot && greg.accounts.length === 2 &&
    NEW.openid === '99998888' && NEW.name === '小号B', 'activeSlot=' + greg.activeSlot);
  check('★ 数据落在它自己的库里；原先那个号的库一个字都没多',
    !!gb.files['df-swtwr-' + NEW.slot + '.json'] &&
    gb.files['df-swtwr-' + NEW.slot + '.json'].indexOf('rB1') > 0 &&
    Object.keys(JSON.parse(gb.files[SLOT_FILE]).matches).length === matchCount,
    NEW.slot + ' 有 rB1，' + SLOT + ' 仍然 ' + matchCount + ' 场');
  const gboot = await gw.window.df.boot();
  check('★ 只读号的 boot 不打网络、不装成已登录（手机上的会话是别人的）',
    gboot.loggedIn === false && gboot.localOnly === true && gboot.matchCount === 1 &&
    !gb.calls.some(function (c) { return c.channel === 'net.post'; }),
    'localOnly=' + gboot.localOnly);
  const gchk = await gw.window.df.checkLogin();
  const gsync = await gw.window.df.sync({});
  check('★★ 只读号上 checkLogin 与 sync 都当场说实话（放过去就是把 A 的场次写进 B 的库）',
    gchk.ok === false && gchk.localOnly === true && /不属于它/.test(gchk.reason || '') &&
    gsync.ok === false && gsync.localOnly === true, gsync.error);
  const imp2 = await gw.window.df.restore();
  check('同一个包再导一次：不再产生第二个号，重复场次按 roomId 去重',
    imp2.ok === true && !imp2.isNew && !imp2.switched && imp2.dup === 1 &&
    JSON.parse(gb.files['accounts.json']).accounts.length === 2 &&
    JSON.parse(gb.files['accounts.json']).activeSlot === NEW.slot, JSON.stringify(imp2));
  const backA = await gw.window.df.accounts.switch(SLOT);
  const chkBack = await gw.window.df.checkLogin();
  check('切回有会话的号：探测又真去做（只读那道闸不漏到别处）',
    backA.ok === true && backA.slot === SLOT && chkBack.ok === true,
    'switch=' + JSON.stringify(backA) + ' checkLogin=' + JSON.stringify(chkBack).slice(0, 40));
  const imp3 = await gw.window.df.restore();
  check('★★ 站在自己的号上导别人的包：按 openid 找回既有那个只读号切过去，不建第三个号、也不并进当前号',
    imp3.ok === true && imp3.switched === true && !imp3.isNew && imp3.slot === NEW.slot &&
    imp3.dup === 1 && JSON.parse(gb.files['accounts.json']).accounts.length === 2 &&
    Object.keys(JSON.parse(gb.files[SLOT_FILE]).matches).length === matchCount,
    JSON.stringify(imp3));
  }

  /* ---------------- H 地图名：cfg.mapNames 这条通道与设置页那颗按钮 ---------------- */
  console.log('\n[H] 地图名：官方配置表 → 本机学名 → 库里那把新图跟着改名');
  {
  const MAP_FIXTURE = fs.readFileSync(path.join(ROOT, 'test/fixtures/map-config.json'), 'utf8');
  const Cfg = require('../core/mapConfig');
  let cfgCalls = [];
  const seed262 = JSON.parse(SEED);
  seed262.matches.room262 = { room_id: 'room262', map_id: 262, game_rule: 3, start_time: 1,
    map_name: '未知地图 · id 262' };
  const hb = makeBridge({
    files: { 'accounts.json': ACCOUNTS, [SLOT_FILE]: JSON.stringify(seed262) },
    net: function () { return ROLE_OK; },
    mapConfig: function (url) {
      cfgCalls.push({ url: url, at: Date.now() });
      return { ok: true, status: 200, contentType: 'application/json', text: MAP_FIXTURE };
    }
  });
  const w9 = loadShim(hb);
  await w9.window.__dfReady;
  const st0 = await w9.window.df.mapNames.status();
  check('★★ status 的形状与桌面同一条（界面读的那几个字段一个不缺）',
    st0.ok === true && st0.builtin === 72 && st0.learned === 0 && st0.at === 0 &&
    st0.never === true && typeof st0.unknown === 'number' && st0.unknown >= 1,
    JSON.stringify(st0));
  /* ★ 这一发要等 8 秒 —— 那个延迟本身就是产品语义（别跟启动时的登录检查挤在一起） */
  await new Promise(function (r) { setTimeout(r, 9000); });
  check('★★ 首次使用那一次是自动的：没人点按钮，它也取到了一次配置表（且只一发）',
    cfgCalls.length === 1 && st0.at === 0, '发了 ' + cfgCalls.length + ' 次');
  check('★ 发的正是 core/mapConfig.js 里那个地址（JS 与 Java 两边同一份口径）',
    cfgCalls.length === 1 && cfgCalls[0].url === Cfg.URL &&
    cfgCalls[0].url.indexOf('https://' + JAVA_MAP_HOST + '/') === 0, cfgCalls[0] && cfgCalls[0].url);
  check('★★ 这一发不带任何本机数据：参数里只有 url，没有 cookie、没有 openid',
    cfgCalls.length === 1 && JSON.stringify(cfgCalls[0]).indexOf('12345678') === -1 &&
    !/cookie/i.test(JSON.stringify(cfgCalls[0])) &&
    hb.calls.filter(function (c) { return c.channel === 'cfg.mapNames'; })
      .every(function (c) { return Object.keys(c.args).join() === 'url'; }),
    JSON.stringify((hb.calls.filter(function (c) { return c.channel === 'cfg.mapNames'; })[0] || {}).args));

  const FIX = Cfg.parse(MAP_FIXTURE);
  const wantLearned = Object.keys(FIX.names).filter(function (id) {
    return !require('../core/maps').mapName[id];
  }).length;
  /* ★ 真实样本库里就有内置表认不出的图（959 / 984 / 1002 这类新号与活动图），
   *   而官方那份配置表自己也只收了其中一部分 —— 所以"取完还剩几条不认识"按数据现算，
   *   不许拍数字：那句「还有 N 场认不出地名」必须能诚实地不归零。 */
  const unknownIn = function (afterPull) {
    const ms = JSON.parse(hb.files[SLOT_FILE]).matches;
    return Object.keys(ms).filter(function (k) {
      const id = String(ms[k].map_id);
      return !(require('../core/maps').mapName[id] ||
        (afterPull && FIX.names[id]));
    }).length;
  };
  const unknownBefore = unknownIn(false), unknownAfter = unknownIn(true);
  check('★★ 取之前：本机字典是空的，那把新图和样本里几条老新图一起挂着「认不出」',
    st0.unknown === unknownBefore && unknownBefore >= 2,
    'unknown=' + st0.unknown + ' 按数据算=' + unknownBefore);
  const st1 = await w9.window.df.mapNames.status();
  check('★★ 取到之后 status 换了一副样子：学到了条数、有一枚时间戳、认不出的少了一截',
    st1.ok === true && st1.learned === wantLearned && st1.at > 0 && st1.never === false &&
    st1.unknown === unknownAfter && st1.unknown < st0.unknown,
    JSON.stringify(st1) + ' 学到=' + wantLearned + ' 还剩' + unknownAfter + '场认不出');
  const disk = JSON.parse(hb.files[SLOT_FILE]);
  check('★★ 库里那把新图跟着改名了（走的是 core 里那条既有清算，不是第二套回填）',
    disk.matches.room262.map_name === '摩格旧城区-占领', disk.matches.room262.map_name);
  const gs = JSON.parse(hb.files['accounts.json']).globalSettings;
  const dict = (gs.mapNames || {}).names || {};
  check('★ 字典落在 accounts.json 的 globalSettings 上（全机一份，不按号抄）',
    Object.keys(dict).length === wantLearned && (gs.mapNames || {}).at > 0,
    '存了 ' + Object.keys(dict).length + ' 条');
  check('★ 字典里只有内置表缺的那些：内置那 72 条一条都不许抄进去（免得回头去盖实证值）',
    Object.keys(dict).every(function (id) { return !w9.window.DFCore.Maps.mapName[id]; }),
    Object.keys(dict).slice(0, 4).join(','));
  const before = cfgCalls.length;
  const two = await Promise.all([w9.window.df.mapNames.refresh(), w9.window.df.mapNames.refresh()]);
  check('★ 连点两下只出一发（闸门在这一层，不在界面）',
    cfgCalls.length === before + 1 && two[0] === two[1] && two[0].ok === true,
    '多发了 ' + (cfgCalls.length - before) + ' 次');
  const rep9 = JSON.stringify(await w9.window.df.report({ mode: 'all' }));
  check('★★ 报告里这两把图都叫得出名字了（262 是新图，959 是样本库里那几条老的）',
    rep9.indexOf('摩格旧城区-占领') !== -1 && rep9.indexOf('烬区-焦点') !== -1 &&
    rep9.indexOf('未知地图 · id 262') === -1 && rep9.indexOf('未知地图 · id 959') === -1,
    '262/959 现名都在，兜底串都不在');
  check('★ 官方配置表自己也没收的那几条仍旧是兜底串（诚实：不许为了"好看"编名字）',
    unknownAfter > 0 ? rep9.indexOf('未知地图 · id') !== -1 : rep9.indexOf('未知地图 · id') === -1,
    '还剩 ' + unknownAfter + ' 场认不出');
  check('★ 已经取到过的机器不会再自动发第二发（判据就是字典上那枚时间戳）',
    cfgCalls.length === before + 1, '总共 ' + cfgCalls.length + ' 发');
  }

  /* ---------------- 在线更新（安卓）：自动那一发必须把话送到界面 ----------------
   * 这一节存在的理由（2026-09-30 在桌面真机路径上量到的）：宿主那边 checked:true、
   * error 已经是「问不到（HTTP 404）」，界面那一行却还停在启动时那句「还没检查过。」——
   * 因为原来只有"查到新版"那一条出路会推事件，而自动那一发没人去点「重新检查」。
   * 他那台服务器在接口部署好之前每天都是 404，正好是这条最响的场景。 */
  console.log('\n[G] 在线更新（安卓）：自动那一发，没人点按钮也要把状态念出来');
  {
    /* clampTimers：这里要量的是"每一条出路推不推"，不是"等几秒"（那枚 6000 由红线钉，与桌面同一枚）。
     * 订阅必须赶在 loadShim 之后立刻做 —— 表已被压到 4ms，等完 __dfReady 再订就晚了（会偶发漏第一条）。 */
    const updCalls = [], fired = [];
    const ub = makeBridge({
      files: { 'accounts.json': ACCOUNTS, [SLOT_FILE]: SEED },
      net: function () { return ROLE_OK; },
      updateCalls: updCalls,
      updateReply: { ok: false, status: 404 }        /* 他服务器现在这个形状：nginx 直接回 404 */
    });
    const wu = loadShim(ub, { clampTimers: true });
    wu.window.df.on('update:status', function (s) { fired.push(s); });
    await wu.window.__dfReady;
    await new Promise(function (r) { setTimeout(r, 200); });
    const stAfter = await wu.window.df.update.status();
    check('★ 自动那一发真出去了，去的正是 Java 那道锁认的同一个 host',
      updCalls.length === 1 &&
      updCalls[0].url.indexOf('https://' + JAVA_UPDATE_HOST + '/admin/app/update') === 0 &&
      updCalls[0].url.indexOf('platform=android') !== -1, JSON.stringify(updCalls));
    check('★★ 问坏了也要推：没人点「重新检查」，界面也收到过一条 update:status，念的是 404',
      fired.length >= 1 && fired[fired.length - 1].checked === true &&
      /HTTP 404/.test(fired[fired.length - 1].error || ''),
      '收到 ' + fired.length + ' 条：' + JSON.stringify(fired.slice(-1)));
    check('★★ 宿主自己那枚状态与推给界面的那一条是同一句话（不许一个说 404、一个说没查过）',
      stAfter.checked === true && /HTTP 404/.test(stAfter.error || '') &&
      stAfter.error === fired[fired.length - 1].error, JSON.stringify(stAfter));
    check('★ 404 那一次不许记档（没到服务器 ⇒ 下一台开机还得报，这才叫"每台一次"）',
      stAfter.reported === false &&
      !((JSON.parse(ub.files['accounts.json']).globalSettings || {}).startup),
      JSON.stringify(JSON.parse(ub.files['accounts.json']).globalSettings));

    const fired2 = [];
    const ub2 = makeBridge({
      files: { 'accounts.json': ACCOUNTS, [SLOT_FILE]: SEED },
      net: function () { return ROLE_OK; },
      updateReply: { ok: true, status: 200, text: JSON.stringify({
        version: '9.9.9', url: 'https://pan.example.com/df-9.9.9.zip',
        notes: '这一版改了点什么', size: 115577747 }) }
    });
    const wu2 = loadShim(ub2, { clampTimers: true });
    wu2.window.df.on('update:status', function (s) { fired2.push(s); });
    await wu2.window.__dfReady;
    await new Promise(function (r) { setTimeout(r, 200); });
    const got = fired2[fired2.length - 1] || {};
    check('★★ 查到新版那一路同样要推（hint + 版本号 + 下载地址都跟着到界面）',
      fired2.length >= 1 && got.action === 'hint' && got.latest === '9.9.9' &&
      got.download === 'https://pan.example.com/df-9.9.9.zip', JSON.stringify(got));
    check('★ 计划里不许出现"我自己装"那一档（安卓推出去的永远是提示）',
      got.action !== 'hot' && got.action !== 'install' && !!got.checked, JSON.stringify(got));
    check('★ 自动那一发的延迟与桌面同一枚（6000 毫秒，两端各自钉一处、不许一端 0 一端 6 秒）',
      /function autoCheckUpdate\(\) \{[\s\S]{0,220}?setTimeout\(function \(\) \{[\s\S]{0,120}?checkForUpdate\(\);[\s\S]{0,60}?\}, 6000\);/.test(
        fs.readFileSync(path.join(ROOT, 'android/js/df-android.js'), 'utf8')),
      '安卓 autoCheckUpdate 里那颗 6000');
  }

  console.log('\n' + '='.repeat(60));
  console.log(fail === 0 ? '安卓 JS 桥：全部通过' : fail + ' 项失败');
  console.log('='.repeat(60));
  process.exit(fail === 0 ? 0 : 1);
}

/* 这份测试最怕的失败方式不是报错，是"卡住之后静默退出"：
 * 一个永不落地的 promise + 事件循环抽干 = Node 以 0 退出，看起来跟通过一模一样。
 * 所以这里挂一颗会自己续命的表：60 秒跑不完就是挂了，明着判失败。 */
setTimeout(function () {
  console.error('\n测试台 60 秒没跑完：有 promise 永远没落 —— 当成失败，不给 exit 0');
  process.exit(1);
}, 60000);

main().catch(function (e) {
  console.error('测试台自己炸了：' + ((e && e.stack) || e));
  process.exit(2);
});
