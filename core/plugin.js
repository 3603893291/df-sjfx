/* plugin.js — 插件清单（manifest.json）的解析、权限白名单与给界面看的说明文案
 * 纯 JS，UMD：不碰 fs / 不碰网络 / 不碰平台 API。
 *
 * 这一份文件是整个插件机制的**边界定义**：插件能拿到什么，只由这里认过的 scope 决定。
 * 没列进 SCOPES 的能力，宿主一律不给 —— 所以新加能力时必须显式地改这里，
 * 改完界面权限清单会自动多出一条（权限文案也从这里生成，杜绝"代码里给了、界面上没说"）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./zip'));
  } else {
    root.DFCore = root.DFCore || {}; root.DFCore.Plugin = factory(root.DFCore.Zip);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Zip) {
  'use strict';

  var HOST_VERSION = '1.9.1';
  var MANIFEST_FILE = 'manifest.json';

  /* ★ 「地址由使用者自己填」的唯一字面量。清单解析、导入页那句给人看的话、
   *   以及出口闸门三处都从这里取 —— 判定写两遍就一定会有人对不上。 */
  var ANY_HOST = '*';
  function hostsAreAny(list) {
    return Array.isArray(list) && list.indexOf(ANY_HOST) !== -1;
  }

  /* ★ 能力白名单。label/desc 会原样出现在导入确认页上，是给用户看的话，不是给开发者看的注释。 */
  var SCOPES = {
    'view': {
      label: '增加一个页面',
      desc: '在左侧栏加一页，只有这一页的界面由插件绘制。',
      order: 1
    },
    'read.summary': {
      label: '读取汇总统计',
      desc: '只拿聚合数字（场次、胜率、KD、场均这类），拿不到逐场明细、拿不到玩家名单。',
      order: 2
    },
    'storage': {
      label: '保存自己的配置',
      desc: '一块只属于本插件的存储，存在本机；不会进导出包，也不会被别的插件读到。',
      order: 3
    },
    'read.digest': {
      label: '读取去敏分析摘要',
      desc: '摘要由宿主在本机算好后把文字给它，它拿不到逐场明细、玩家名单与房间号。' +
        '★ 摘要是去标识的，但它仍是你的数据 —— 给了这个权限，插件就有权把这份文字交给它自己写的网址。',
      order: 4
    },
    'read.legacy': {
      label: '搬入旧版的本机记录',
      desc: '只能取一次：把你在旧版本机里存的分析配置与历史结果交给这个插件。' +
        '取走之后本机那份会立刻归档（改名留底、不再被读），所以点了就不是静默复制。',
      order: 5
    },
    'net.request': {
      label: '向外部发送请求',
      desc: '只能访问下面列出的网址（写着「任意 https 地址」时，那个地址由你自己在插件页里填），' +
        '只能 https，每次调用都要经过宿主；插件自己碰不到网络。' +
        '★ 而且必须先由你在宿主这里逐字确认一次，宿主才会替你发。' +
        '（含流式回答：宿主只替你管出口与超时，一个字节也不会替它拼。）',
      needsHosts: true,
      needsConsent: true,
      order: 9
    }
  };

  /* ============ 逐字确认（宿主侧闸门） ============
   * 「只把按钮藏起来」不算锁 —— 判定必须在主进程。这句话的比对口径与 core/aiDigest.js
   * 是同一份（去所有空白含全角、ASCII 转大写、句末句号可省），两处不能各写一套。
   * ★ 目标句不写死在本文件里：它来自插件清单的 consent.sentence。改了这句话就是改了权限，
   *   指纹会变、旧包会被拒绝服务，只能重新导入 —— 所以也不存在"插件偷偷换个说法"的路。 */
  var CONSENT_SENTENCE_MAX = 80;
  var CONSENT_ITEM_MAX = 8;
  var CONSENT_ITEM_LEN = 60;

  function normalizeConsent(s) {
    var str = String(s == null ? '' : s).replace(/[\s　]/g, '');
    str = str.replace(/[a-z]/g, function (m) { return m.toUpperCase(); });
    return str.replace(/[。.]+$/, '');
  }

  function matchConsent(input, expected) {
    var want = normalizeConsent(expected);
    var got = normalizeConsent(input);
    return !!want && !!got && got === want;
  }

  /* 返回 { consent, errors }：没有出网权限时 consent 可以为 null（那时它只是段披露文字） */
  function parseConsent(raw, needsGate) {
    var errors = [];
    if (!raw || typeof raw !== 'object') {
      if (needsGate) errors.push('这个包要访问外部网址，必须写明 consent.sentence（用户在宿主这里逐字输入的那句话）');
      return { consent: null, errors: errors };
    }
    var sentence = String(raw.sentence || '').trim();
    if (!sentence) {
      if (needsGate) errors.push('这个包要访问外部网址，consent.sentence 不能是空的');
    } else if (sentence.length > CONSENT_SENTENCE_MAX) {
      errors.push('consent.sentence 太长（' + sentence.length + ' 字，上限 ' + CONSENT_SENTENCE_MAX + ' 字）');
    }
    function list(v, who) {
      var arr = Array.isArray(v) ? v : [];
      if (arr.length > CONSENT_ITEM_MAX) errors.push('consent.' + who + ' 最多 ' + CONSENT_ITEM_MAX + ' 条');
      return arr.map(function (t) {
        var s = String(t == null ? '' : t).trim();
        if (!s) return '';
        if (s.length > CONSENT_ITEM_LEN) {
          errors.push('consent.' + who + ' 有一条太长（' + s.length + ' 字，上限 ' + CONSENT_ITEM_LEN + ' 字）：「' + s.slice(0, 12) + '…」');
          return '';
        }
        return s;
      }).filter(function (s) { return s; });
    }
    var sends = list(raw.sends, 'sends');
    var no = list(raw.doesNotSend, 'doesNotSend');
    return {
      consent: { sentence: sentence, sends: sends, doesNotSend: no },
      errors: errors
    };
  }

  var ID_RE = /^[a-z][a-z0-9._-]{1,39}$/;
  var VER_RE = /^\d+\.\d+(\.\d+)?$/;
  var HOST_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
  /* 战队站自建在局域网 IP 上、以及本机自测都要能用；这些地址仍由用户在导入页逐项确认 */
  var IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

  function bad(reason, message) { return { ok: false, reason: reason, message: message }; }

  /* 域名允许插件写 https://x/y，但只取主机名 —— 少写一层协议就当成非法，逼开发者写清楚 */
  function normalizeHost(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return '';
    if (s.indexOf('://') !== -1) s = s.split('://')[1];
    s = s.split('/')[0].split(':')[0];
    if (s.indexOf('.') === 0 || s.charAt(s.length - 1) === '.') return null;
    if (IPV4_RE.test(s)) {
      return s.split('.').every(function (n) { return Number(n) <= 255; }) ? s : null;
    }
    return HOST_RE.test(s) ? s : null;
  }

  function parseManifest(text, fileNames) {
    var m;
    try { m = JSON.parse(String(text || '')); }
    catch (e) { return bad('manifest_json', 'manifest.json 不是合法 JSON：' + e.message); }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return bad('manifest_shape', 'manifest.json 必须是一个对象');

    var errors = [];
    var id = String(m.id || '').trim();
    var name = String(m.name || '').trim();
    var version = String(m.version || '').trim();
    if (!ID_RE.test(id)) errors.push('id 不合法（要小写字母开头，可用数字 . _ -，2~40 位）："' + id + '"');
    if (!name || name.length > 40) errors.push('name 必须是 1~40 个字的插件名');
    if (!VER_RE.test(version)) errors.push('version 要写成 1.0 或 1.0.0 这种形式');

    var entry = String(m.entry || '').trim();
    if (!Zip.isSafeRelPath(entry)) errors.push('entry 必须是包内的相对路径（不能带 .. 或绝对路径）："' + entry + '"');
    var script = m.script ? String(m.script).trim() : '';
    if (script && !Zip.isSafeRelPath(script)) errors.push('script 路径不合法："' + script + '"');

    /* 声明的文件必须真的在包里 —— 少了就是包坏了，比"启用后报找不到文件"更早告诉你 */
    var have = {};
    (fileNames || []).forEach(function (n) { have[n] = 1; });
    [entry, script, MANIFEST_FILE].forEach(function (n) {
      if (n && have[n] === undefined && have[n + '/'] === undefined) errors.push('清单声明的「' + n + '」不在包里');
    });

    var perms = [];
    var raw = m.permissions;
    if (!Array.isArray(raw) || !raw.length) errors.push('permissions 必须是非空数组（一个权限都不要也请显式写成 []）');
    else {
      var seen = {};
      raw.forEach(function (p, i) {
        var scope = p && typeof p === 'object' ? String(p.scope || '').trim() : String(p || '').trim();
        var def = SCOPES[scope];
        if (!def) { errors.push('第 ' + (i + 1) + ' 项权限「' + (scope || '?') + '」宿主不认识，不接受未列出的能力'); return; }
        if (seen[scope]) { errors.push('权限「' + scope + '」重复声明'); return; }
        seen[scope] = 1;
        var hosts = [];
        var anyHost = false;
        if (def.needsHosts) {
          var hs = Array.isArray(p.hosts) ? p.hosts : (p.host ? [p.host] : []);
          if (!hs.length) { errors.push('权限「' + scope + '」必须写明 hosts（要访问的网址，或显式写成 ["*"] 交给使用者自己填），不给默认放行'); return; }
          /* ★ `["*"]` 是一种**显式**写法，意思是「地址由使用者在插件页里自己填，宿主不预置任何域名」。
           *   此时域名不再是"导入时预批准"的东西，出口只剩三道：协议必须是 https（只有回环允许明文 http）、
           *   端口必须是标准 443、以及那句逐字确认。所以它只允许单独出现 ——
           *   混着写（`*` + 具体域名）会让人误以为清单还有约束，而实际上一条都不挡。 */
          if (hs.some(function (h) { return String(h).trim() === ANY_HOST; })) {
            if (hs.length > 1) {
              errors.push('权限「' + scope + '」的 hosts 写了 * 就不能再列具体域名（要么任意 https 地址、要么固定清单，别混写）');
              return;
            }
            hosts = [ANY_HOST];
            anyHost = true;
          } else {
            var seenHost = {};
            hs.forEach(function (h) {
              var nh = normalizeHost(h);
              if (!nh) errors.push('权限「' + scope + '」里的网址不合法："' + h + '"（只接受固定的域名或 IP，不支持通配符）');
              else if (seenHost[nh]) { /* 重复域名忽略即可 */ }
              else { seenHost[nh] = 1; hosts.push(nh); }
            });
            if (!hosts.length) return;
          }
        }
        perms.push({
          scope: scope, label: def.label, desc: def.desc, hosts: hosts, anyHost: anyHost, order: def.order || 50,
          reason: String((p && p.reason) || '').trim().slice(0, 200)
        });
      });
    }
    if (errors.length) return { ok: false, reason: 'manifest_invalid', message: errors.join('；'), errors: errors };

    /* 有没有出网权限决定这句话是不是必须存在 —— 判定表只有 SCOPES 一处，不在这里另列名单 */
    var needsGate = perms.some(function (p) {
      var def = SCOPES[p.scope];
      return !!(def && def.needsConsent);
    });
    var c = parseConsent(m.consent, needsGate);
    if (c.errors.length) return { ok: false, reason: 'manifest_invalid', message: c.errors.join('；'), errors: c.errors };

    /* 确认页的呈现顺序与开发者书写顺序无关：按敏感度排（网络出口排最后一条，最该被看到） */
    perms.sort(function (a, b) { return a.order - b.order || (a.scope < b.scope ? -1 : 1); });
    var minHost = String(m.minHostVersion || '').trim();
    return {
      ok: true,
      manifest: {
        id: id, name: name, version: version,
        description: String(m.description || '').trim().slice(0, 200),
        author: String(m.author || '').trim().slice(0, 60),
        entry: entry, script: script,
        permissions: perms,
        consent: c.consent,
        minHostVersion: minHost,
        hostOk: !minHost || cmpVersion(HOST_VERSION, minHost) >= 0
      }
    };
  }

  function cmpVersion(a, b) {
    var pa = String(a).split('.'), pb = String(b).split('.');
    for (var i = 0; i < 3; i++) {
      var x = parseInt(pa[i] || '0', 10) || 0, y = parseInt(pb[i] || '0', 10) || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  /* 权限指纹：导入时记下，之后每次启用都比对。清单被换过（哪怕只多要了一个域名）就能被发现。
   * ★ consent.sentence 也算权限的一部分：换掉那句确认话，旧包立刻指纹漂移、被拒绝服务。 */
  function permFingerprint(manifest) {
    var parts = (manifest.permissions || []).map(function (p) {
      return p.scope + (p.hosts && p.hosts.length ? '[' + p.hosts.slice().sort().join(',') + ']' : '');
    });
    var cs = manifest.consent && manifest.consent.sentence ? manifest.consent.sentence : '';
    var s = manifest.id + '|' + manifest.version + '|' + parts.join('|') + '|consent:' + cs;
    /* FNV-1a：只要是个稳定的指纹用，不是拿来做完整性 —— 完整性靠文件哈希 */
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return h.toString(16);
  }

  /* ★ 唯一一处"指纹由哪些字段构成"的定义。导入（清单）与启用复核（登记表记录）都走这里 ——
   *   之前两边各自挑字段，漏了 consent 就把自己算出的指纹判成漂移。 */
  function fingerprintOf(rec) {
    return permFingerprint({
      id: rec.id, version: rec.version,
      permissions: (rec.permissions || []).map(function (x) {
        return { scope: x.scope, hosts: x.hosts || [] };
      }),
      consent: rec.consent || null
    });
  }

  return {
    HOST_VERSION: HOST_VERSION, MANIFEST_FILE: MANIFEST_FILE, SCOPES: SCOPES,
    ANY_HOST: ANY_HOST, hostsAreAny: hostsAreAny,
    parseManifest: parseManifest, normalizeHost: normalizeHost,
    permFingerprint: permFingerprint, fingerprintOf: fingerprintOf, cmpVersion: cmpVersion,
    matchConsent: matchConsent, normalizeConsent: normalizeConsent
  };
});
