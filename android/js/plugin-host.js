'use strict';
/* plugin-host.js — 安卓上的「插件宿主」，对应桌面端 shell/plugins.js + shell/plugin-api.js
 *
 * 桌面端那份宿主跑在主进程里，安卓没有主进程，所以这一份跑在**宿主主框**的 JS 里。
 * 它能站得住脚只因为一件事：沙箱 iframe 够不到原生桥（DfBridge 的桥令牌只随首页 URL 进主框），
 * 而界面里那一层 ui/js/app.js 只做转发 —— 判定全部在这一份文件里，每一次调用都复算。
 *
 * ★ 三条与桌面同源的判定，一条都不许在这里改口径：
 *   1) 清单、权限白名单、逐字确认、权限指纹 → core/plugin.js（同一份源码，不是"照抄"）；
 *   2) 包内路径与体积上限 → core/zip.js（checkSafety / isSafeRelPath，上限数值由这里传给原生）；
 *   3) 出网的线上底线（https / 443 / 域名名单 / 逐跳复校）→ PluginNet.java，
 *      与桌面 shell/adapters/plugin-net.js 同一套三条。
 *   这里只做桌面 main.js + plugins.js + plugin-api.js 那三层**编排**：谁批过什么、能拿到什么。
 *
 * 与桌面不同的两件事（都是平台事实，不是偷懒）：
 *   · 解包在原生做（桥只能传字符串，几十 KB 的包 base64 过来不划算），
 *     但**要解哪些条目、上限多少**由这里决定，原生只照单执行；
 *   · 旧版本机记录（read.legacy）在这台机器上不存在 —— 如实报"没有"，不演。
 */
(function (global) {
  var Core = global.DFCore || null;

  var FILE_EXT_OK = ['.json', '.js', '.css', '.html', '.txt', '.svg', '.png', '.jpg', '.ico'];
  var REGISTRY_FILE = 'plugins.json';
  var ZIP_PICK = 'import-plugin.zip';
  var ZIP_MAX_BYTES = 16 * 1024 * 1024;
  var NET_WINDOW_MS = 60000;
  var NET_WINDOW_MAX = 20;
  var MAX_STREAMS_PER_PLUGIN = 1;
  var STREAM_MERGE_MS = 40;
  var STREAM_BODY_MAX = 256 * 1024;
  var KV_MAX = 64 * 1024;
  var NET_BODY_MAX = 64 * 1024;   /* 与桌面 net.request 同一个上限 */
  var SECRET_MAX = 8 * 1024;
  var DIGEST_HANDLE_MAX = 80;
  var DIGEST_ROWS_MAX = 40;
  var DIGEST_MODES = ['all', 'swtwr', 'other', 'commander'];
  var DAYS_MAX = 365;
  var MODES = { all: 1, swtwr: 1, other: 1, commander: 1 };
  var HEADER_BLOCK = ['cookie', 'host', 'content-length', 'connection', 'upgrade'];

  function extname(n) {
    var s = String(n || '');
    var i = s.lastIndexOf('.');
    var slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i > slash ? s.slice(i).toLowerCase() : '';
  }
  function nowStr() {
    var d = new Date();
    function z(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' +
      z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
  }
  function errOf(e) { return String((e && e.message) || e); }

  function create(deps) {
    var to = deps.to;                 /* 唯一的原生出口（带桥令牌，由 df-android.js 那一层管） */
    var onRaw = deps.onRaw;           /* 原生推来的事件（流式分片走这一条） */
    var emit = deps.emit;             /* 对应桌面 main.js 的 emit('plugin:evt', …) */
    var getStore = deps.getStore;
    var getAccounts = deps.getAccounts;
    var Plg = Core.Plugin;
    var Zip = Core.Zip;
    var Analysis = Core.Analysis;
    var Maps = Core.Maps;
    var AiDigest = Core.AiDigest;

    var previews = {};                /* token -> {preview, at, source} */
    var previewSeq = 0;
    var netLog = {};                  /* 插件 id -> [时间戳] */
    var streams = {};                 /* streamId -> {id} */
    var pending = {};                 /* streamId -> {buf, timer} 分片合并 */
    var handles = {};                 /* 号牌 -> room_id（只在本次运行里有效） */
    var back = {};                    /* room_id -> 号牌 */
    var handleSeq = 0;

    /* --------------------------------------------- 登记表 */

    function readRegistry() {
      return to('fs.read', { name: REGISTRY_FILE }).then(function (r) {
        if (!r || !r.text) return { plugins: [] };
        try {
          var j = JSON.parse(r.text);
          return (j && Array.isArray(j.plugins)) ? j : { plugins: [] };
        } catch (e) { return { plugins: [] }; }
      });
    }
    function writeRegistry(reg) {
      return to('fs.write', { name: REGISTRY_FILE, text: JSON.stringify(reg, null, 2) });
    }
    function find(id) {
      return readRegistry().then(function (reg) {
        var hit = null;
        reg.plugins.forEach(function (p) { if (p.id === id) hit = p; });
        return hit;
      });
    }

    function kvFile(id) { return 'plugin-' + id + '.json'; }
    function secretFile(id) { return 'plugin-' + id + '.secret.json'; }
    function cookieFile(id) { return 'plugin-' + id + '.cookies.json'; }
    var TRIGGER_FILE = 'plugin-triggers.json';

    function readJson(name, dflt) {
      return to('fs.read', { name: name }).then(function (r) {
        if (!r || !r.text) return dflt;
        try {
          var j = JSON.parse(r.text);
          return (j && typeof j === 'object') ? j : dflt;
        } catch (e) { return dflt; }
      });
    }
    function writeJson(name, obj) {
      return to('fs.write', { name: name, text: JSON.stringify(obj, null, 1) });
    }

    /* --------------------------------------------- 视图（界面吃的那一份） */

    function view(p) {
      return {
        id: p.id, name: p.name, version: p.version, description: p.description, author: p.author,
        entry: p.entry, script: p.script, permissions: p.permissions || [],
        consent: p.consent || null, consentGiven: !!p.consentGiven, consentAt: p.consentAt || '',
        autoTrigger: !!(p.autoTrigger && p.autoTrigger.on),
        enabled: !!p.enabled, imported_at: p.imported_at, packageHash: p.packageHash,
        permFp: p.permFp, totalSize: p.totalSize, fileCount: (p.fileHashes || []).length
      };
    }

    function list() {
      return Promise.all([readRegistry(), readJson(TRIGGER_FILE, {})]).then(function (res) {
        var reg = res[0];
        var trig = res[1];
        return Promise.all(reg.plugins.map(function (p) {
          return verifyFiles(p.id).then(function (v) {
            var o = view(p);
            o.intact = !!v.ok;
            o.intactMessage = v.message || '';
            var t = trig[p.id];
            o.pendingTrigger = (t && typeof t === 'object')
              ? { at: t.at || 0, count: t.count || 0 } : null;
            return o;
          });
        })).then(function (out) {
          var netOn = out.filter(function (p) {
            return p.enabled && (p.permissions || []).some(function (x) {
              return x.scope === 'net.request';
            });
          });
          var hosts = [];
          netOn.forEach(function (p) {
            (p.permissions || []).forEach(function (x) {
              if (x.scope !== 'net.request') return;
              (x.hosts || []).forEach(function (h) { if (hosts.indexOf(h) === -1) hosts.push(h); });
            });
          });
          return {
            ok: true, hostVersion: Plg.HOST_VERSION, plugins: out, scopes: Plg.SCOPES,
            dir: '本机私有目录 plugins/',
            enabledCount: out.filter(function (p) { return p.enabled; }).length,
            netEnabledCount: netOn.length, netHosts: hosts
          };
        });
      });
    }

    /* --------------------------------------------- 解包与安装 */

    /* 把 zip 内的目录层级压掉一层：绝大多数压缩工具都会把「插件文件夹/」整个带进来（与桌面同判据） */
    function stripRoot(name, entries) {
      var first = [];
      entries.forEach(function (e) { if (!e.dir) first.push(String(e.name).split('/')[0]); });
      if (!first.length) return name;
      var top = first[0];
      for (var i = 0; i < first.length; i++) {
        if (first[i] !== top) return name;
      }
      return name.indexOf(top + '/') === 0 ? name.slice(top.length + 1) : name;
    }

    function parsedFrom(listResult) {
      var raw = (listResult.entries || []).map(function (e) {
        return {
          name: e.name, dir: !!e.dir, size: Number(e.size) || 0,
          compressedSize: Number(e.compressedSize) || 0, symlink: !!e.symlink
        };
      });
      return { ok: true, entries: raw, totalSize: Number(listResult.totalSize) || 0 };
    }

    function inspect() {
      return to('file.pick', { saveAs: ZIP_PICK }).then(function (r) {
        if (!r || !r.ok) {
          return { ok: false, cancelled: !!(r && r.cancelled), error: (r && r.error) || '没选中文件' };
        }
        if (!/\.zip$/i.test(String(r.saved || r.name || ''))) {
          return { ok: false, error: '插件包必须是 .zip（选中的是 ' + (r.name || '未知') + '）' };
        }
        return to('zip.list', { name: ZIP_PICK }).then(function (z) {
          if (!z || !z.ok) return { ok: false, stage: 'zip', error: (z && z.error) || '读不了这个 zip' };
          var parsed = parsedFrom(z);
          var safety = Zip.checkSafety(parsed);
          if (!safety.ok) {
            return { ok: false, stage: 'zip', error: safety.problems.join('；') };
          }
          var flat = parsed.entries.filter(function (e) { return !e.dir; }).map(function (e) {
            var has = stripRoot(e.name, parsed.entries);
            return {
              want: e.name, has: has, name: has, dir: false, size: e.size,
              compressedSize: e.compressedSize, symlink: false
            };
          });
          var names = flat.map(function (e) { return e.has; });
          /* ★ 对照表：want = zip 里的真条目名（压层级之前），has = 落盘用的相对路径。
           *   「压掉外层目录」这条判据只写在 JS 这一处，原生只按表执行，不猜名字。 */
          var specs = flat.map(function (e) { return { want: e.want, has: e.has }; });
          var manifestSpec = flat.filter(function (e) { return e.has === Plg.MANIFEST_FILE; })[0];
          if (!manifestSpec) {
            return {
              ok: false, stage: 'zip',
              error: '包根目录里没有 ' + Plg.MANIFEST_FILE + '（插件至少要带清单）'
            };
          }
          return to('zip.read', { name: ZIP_PICK, entry: manifestSpec.want }).then(function (m) {
            if (!m || !m.ok) {
              return { ok: false, stage: 'zip', error: '读不到清单：' + ((m && m.error) || '') };
            }
            var parsed2 = { ok: true, entries: flat, totalSize: parsed.totalSize };
            var s2 = Zip.checkSafety(parsed2);
            if (!s2.ok) return { ok: false, stage: 'zip', error: s2.problems.join('；') };
            var pm = Plg.parseManifest(m.text, names);
            if (!pm.ok) {
              return { ok: false, stage: 'manifest', error: pm.message, errors: pm.errors };
            }
            var badExt = names.filter(function (n) {
              return FILE_EXT_OK.indexOf(extname(n)) === -1;
            });
            if (badExt.length) {
              return {
                ok: false, stage: 'manifest',
                error: '包里有不允许的文件类型：' + badExt.join('、')
              };
            }
            /* 清单说了算之后才去真解一遍：声明的大小可以撒谎，解压后的字节数不能 */
            return to('zip.audit', {
              name: ZIP_PICK, entries: specs,
              maxEntry: Zip.MAX_ENTRY_BYTES, maxTotal: Zip.TOTAL_BUDGET
            }).then(function (a) {
              if (!a || !a.ok) {
                return { ok: false, stage: 'zip', error: '解包失败：' + ((a && a.error) || '') };
              }
              var files = a.files || [];
              var over = files.filter(function (f) { return f.size > Zip.MAX_ENTRY_BYTES; });
              if (over.length) {
                return {
                  ok: false, stage: 'zip',
                  error: '「' + over[0].name + '」解压后超过单文件上限'
                };
              }
              return shaText(files.map(function (f) { return f.name + ':' + f.hash; })
                .sort().join('\n')).then(function (packageHash) {
                var token = 'pv' + Date.now().toString(36) + '-' + (++previewSeq);
                previews[token] = {
                  preview: {
                    ok: true, manifest: pm.manifest, specs: specs,
                    permFp: Plg.fingerprintOf(pm.manifest), files: files,
                    packageHash: packageHash,
                    totalSize: Number(a.totalSize) || 0, fileCount: files.length
                  },
                  at: Date.now(), source: String(r.name || ZIP_PICK)
                };
                Object.keys(previews).sort(function (x, y) {
                  return previews[x].at - previews[y].at;
                }).slice(0, Math.max(0, Object.keys(previews).length - 6))
                  .forEach(function (k) { delete previews[k]; });
                var out = {
                  ok: true, token: token, source: String(r.name || ZIP_PICK),
                  manifest: pm.manifest, permissions: pm.manifest.permissions,
                  permFp: Plg.fingerprintOf(pm.manifest), packageHash: packageHash,
                  files: files, fileCount: files.length, totalSize: Number(a.totalSize) || 0,
                  hostVersion: Plg.HOST_VERSION
                };
                return find(pm.manifest.id).then(function (old) {
                  out.replaced = !!old;
                  return out;
                });
              });
            });
          });
        });
      });
    }

    function shaText(text) {
      return to('hash.text', { text: text }).then(function (r) {
        return (r && r.hash) || '';
      });
    }

    function install(token, acceptedScopes) {
      var hit = previews[String(token || '')];
      if (!hit) return Promise.resolve({ ok: false, error: '权限确认已过期，请重新选择插件包' });
      delete previews[String(token || '')];
      var pv = hit.preview;
      var acc = acceptedScopes || [];
      var missing = pv.manifest.permissions.map(function (p) { return p.scope; })
        .filter(function (s) { return acc.indexOf(s) === -1; });
      if (missing.length) {
        return Promise.resolve({
          ok: false,
          error: '还有权限没被勾选确认：' + missing.join('、') + ' —— 要么全部同意，要么不装'
        });
      }
      var id = pv.manifest.id;
      var tmp = id + '__tmp';
      return to('zip.extract', {
        name: ZIP_PICK, into: tmp, entries: pv.specs,
        maxEntry: Zip.MAX_ENTRY_BYTES, maxTotal: Zip.TOTAL_BUDGET
      }).then(function (x) {
        if (!x || !x.ok) {
          return { ok: false, error: '解包失败，已回滚：' + ((x && x.error) || '') };
        }
        var byName = {};
        (x.files || []).forEach(function (f) { byName[f.name] = f; });
        var drift = pv.files.filter(function (f) {
          var got = byName[f.name];
          return !got || got.hash !== f.hash;
        });
        if (drift.length) {
          return to('plugin.removeDir', { id: tmp }).then(function () {
            return {
              ok: false,
              error: '落盘内容与确认页上看到的不一致（' + drift[0].name + '），已回滚'
            };
          });
        }
        return to('plugin.renameDir', { from: tmp, to: id }).then(function (mv) {
          if (!mv || !mv.ok) {
            return { ok: false, error: '插件目录没能就位：' + ((mv && mv.error) || '未知') };
          }
          var rec = {
            id: id, name: pv.manifest.name, version: pv.manifest.version,
            description: pv.manifest.description, author: pv.manifest.author,
            entry: pv.manifest.entry, script: pv.manifest.script,
            permissions: pv.manifest.permissions, consent: pv.manifest.consent || null,
            consentGiven: false, consentAt: '',
            permFp: pv.permFp, packageHash: pv.packageHash,
            fileHashes: pv.files.map(function (f) { return { name: f.name, hash: f.hash }; }),
            totalSize: pv.totalSize, enabled: false,
            imported_at: nowStr(), source: String(hit.source || '').slice(0, 120)
          };
          return readRegistry().then(function (reg) {
            var i = -1;
            reg.plugins.forEach(function (p, k) { if (p.id === id) i = k; });
            if (i >= 0) reg.plugins[i] = rec; else reg.plugins.push(rec);
            return writeRegistry(reg).then(function () { return { ok: true, plugin: rec }; });
          });
        });
      }).then(function (r) {
        if (!r.ok) return r;
        return list().then(function (l) {
          return { ok: true, plugin: view(r.plugin), list: l };
        });
      });
    }

    /* --------------------------------------------- 完整性与权限 */

    function verifyFiles(id) {
      return find(id).then(function (p) {
        if (!p) return { ok: false, message: '没有这个插件' };
        return to('plugin.hashDir', { id: id }).then(function (h) {
          var onDisk = {};
          ((h && h.files) || []).forEach(function (f) { onDisk[f.name] = f; });
          var missing = [], changed = [];
          (p.fileHashes || []).forEach(function (f) {
            if (!Zip.isSafeRelPath(f.name)) { changed.push(f.name); return; }
            var got = onDisk[f.name];
            if (!got) { missing.push(f.name); return; }
            if (got.size > Zip.MAX_ENTRY_BYTES || got.hash !== f.hash) changed.push(f.name);
          });
          if (missing.length || changed.length) {
            return {
              ok: false, permDrift: false,
              message: '插件文件与导入时不一致' +
                (missing.length ? '（少了：' + missing.slice(0, 3).join('、') + '）' : '') +
                (changed.length ? '（被改过：' + changed.slice(0, 3).join('、') + '）' : '') +
                '。请重新导入这个包。'
            };
          }
          var now = Plg.fingerprintOf(p);
          if (now !== p.permFp) {
            return {
              ok: false, permDrift: true,
              message: '登记信息里的权限与本机指纹不一致（' + now + ' ≠ ' + p.permFp + '），已拒绝启用。'
            };
          }
          return { ok: true };
        });
      });
    }

    function canScope(id, scope) {
      return find(id).then(function (p) {
        return !!(p && p.enabled && (p.permissions || []).some(function (x) {
          return x.scope === scope;
        }));
      });
    }
    function hasStorage(id) { return canScope(id, 'storage'); }

    function needsConsent(p) {
      return (p.permissions || []).some(function (x) {
        var def = Plg.SCOPES[x.scope];
        return !!(def && def.needsConsent);
      });
    }
    function consentOk(id) {
      return find(id).then(function (p) {
        if (!p) return false;
        if (!needsConsent(p)) return true;
        return !!(p.consentGiven && p.consent && p.consent.sentence);
      });
    }
    function grantConsent(id, input) {
      return readRegistry().then(function (reg) {
        var p = null;
        reg.plugins.forEach(function (x) { if (x.id === id) p = x; });
        if (!p) return { ok: false, error: '没有这个插件' };
        var sentence = p.consent && p.consent.sentence;
        if (!needsConsent(p) || !sentence) {
          return { ok: false, error: '这个插件没有需要逐字确认的外发能力' };
        }
        if (!Plg.matchConsent(input, sentence)) {
          return { ok: false, error: '输入的这句话与清单里那句不一致，未确认' };
        }
        p.consentGiven = true;
        p.consentAt = nowStr();
        return writeRegistry(reg).then(function () {
          return { ok: true, plugin: { id: id, consentGiven: true, consentAt: p.consentAt } };
        });
      });
    }
    function revokeConsent(id) {
      return readRegistry().then(function (reg) {
        var p = null;
        reg.plugins.forEach(function (x) { if (x.id === id) p = x; });
        if (!p) return { ok: false, error: '没有这个插件' };
        p.consentGiven = false;
        p.consentAt = '';
        return writeRegistry(reg).then(function () {
          return { ok: true, plugin: { id: id, consentGiven: false, consentAt: '' } };
        });
      });
    }

    function setEnabled(id, on) {
      return readRegistry().then(function (reg) {
        var p = null;
        reg.plugins.forEach(function (x) { if (x.id === id) p = x; });
        if (!p) return { ok: false, error: '没有这个插件' };
        if (!on) abortAll(id);
        return (on ? verifyFiles(id) : Promise.resolve({ ok: true })).then(function (v) {
          if (on && !v.ok) {
            return list().then(function (l) {
              return {
                ok: false,
                error: (v.permDrift ? v.message : '文件校验不过，不能启用：' + v.message),
                list: l
              };
            });
          }
          p.enabled = !!on;
          return writeRegistry(reg).then(function () {
            return list().then(function (l) {
              return { ok: true, plugin: view(p), list: l };
            });
          });
        });
      });
    }

    function remove(id) {
      abortAll(id);
      return readRegistry().then(function (reg) {
        var i = -1;
        reg.plugins.forEach(function (x, k) { if (x.id === id) i = k; });
        if (i < 0) return { ok: false, error: '没有这个插件' };
        reg.plugins.splice(i, 1);
        return writeRegistry(reg).then(function () {
          return to('plugin.removeDir', { id: id });
        });
      }).then(function () {
        return Promise.all([
          to('fs.remove', { name: kvFile(id) }),
          to('fs.remove', { name: secretFile(id) }),
          to('fs.remove', { name: cookieFile(id) })
        ]);
      }).then(function () {
        return dropTrigger(id).then(list).then(function (l) { return { ok: true, list: l }; });
      });
    }

    /* --------------------------------------------- 待办（同步记一笔） */

    function noteTrigger(id, info) {
      return readJson(TRIGGER_FILE, {}).then(function (all) {
        var cur = (all[id] && typeof all[id] === 'object') ? all[id] : { count: 0 };
        cur.count = Math.min(Number(cur.count) || 0, 999) + 1;
        cur.at = Date.now();
        cur.info = (info && typeof info === 'object') ? info : null;
        all[id] = cur;
        return writeJson(TRIGGER_FILE, all).then(function () { return { ok: true, count: cur.count }; });
      });
    }
    function takeTrigger(id) {
      return readJson(TRIGGER_FILE, {}).then(function (all) {
        var rec = all[id];
        if (!rec || typeof rec !== 'object') return null;
        delete all[id];
        return writeJson(TRIGGER_FILE, all).then(function () { return rec; });
      });
    }
    function dropTrigger(id) {
      return readJson(TRIGGER_FILE, {}).then(function (all) {
        if (all[id] === undefined) return { ok: true };
        delete all[id];
        return writeJson(TRIGGER_FILE, all).then(function () { return { ok: true }; });
      });
    }
    function armTrigger(id, on) {
      return readRegistry().then(function (reg) {
        var p = null;
        reg.plugins.forEach(function (x) { if (x.id === id) p = x; });
        if (!p) return { ok: false, error: '没有这个插件' };
        p.autoTrigger = { on: !!on, at: Date.now() };
        return writeRegistry(reg).then(function () { return { ok: true, on: !!on }; });
      });
    }
    /** 同步成功后宿主只记一笔账：谁也别替使用者跑一段插件代码 */
    function noteSync(info) {
      return readRegistry().then(function (reg) {
        var ids = reg.plugins.filter(function (p) {
          return p.enabled && p.autoTrigger && p.autoTrigger.on;
        }).map(function (p) { return p.id; });
        return ids.reduce(function (chain, id) {
          return chain.then(function () { return noteTrigger(id, info); });
        }, Promise.resolve());
      });
    }

    /* --------------------------------------------- 摘要通道（号牌） */

    function handleForRoom(rid) {
      if (back[rid]) return back[rid];
      var h = 'm' + (Date.now().toString(36)) + (++handleSeq);
      back[rid] = h;
      handles[h] = rid;
      var keys = Object.keys(handles);
      while (keys.length > DIGEST_HANDLE_MAX) {
        var dead = keys.shift();
        var rid = handles[dead];
        delete handles[dead];
        if (back[rid] === dead) delete back[rid];
      }
      return h;
    }
    function digestList(store) {
      var rows = [];
      try { rows = store.matches({ mode: 'all' }); }
      catch (e) { return { ok: false, error: '读场次清单失败：' + errOf(e) }; }
      return {
        ok: true, total: rows.length,
        rows: rows.slice(0, DIGEST_ROWS_MAX).map(function (m) {
          return {
            handle: handleForRoom(String(m.room_id)),
            at: String(m.dt_event_time || ''),
            map: Maps.nameOf(m.map_id),
            mapId: Number(m.map_id) || 0,
            swtwr: !!m.is_swtwr, commander: !!m.is_commander, winner: !!m.is_winner,
            durationMin: Math.round((Number(m.game_time) || 0) / 60)
          };
        })
      };
    }
    function runDigest(store, a) {
      if (a.list) return digestList(store);
      var scope = a.scope === 'match' ? 'match' : 'global';
      var filters = {};
      if (DIGEST_MODES.indexOf(a.mode) !== -1) filters.mode = a.mode;
      var days = Math.floor(Number(a.days) || 0);
      if (days > 0) {
        filters.since = Math.floor(Date.now() / 1000) - Math.min(days, DAYS_MAX) * 86400;
      }
      var roomId = '';
      if (scope === 'match') {
        roomId = handles[String(a.handle || '')] || '';
        if (!roomId) {
          return { ok: false, error: '场次号牌已失效，请重新选一次场次（号牌只在本次运行中有效）' };
        }
      }
      var d;
      try {
        d = scope === 'match' ? AiDigest.buildMatchDigest(store, roomId)
          : AiDigest.buildGlobalDigest(store, filters);
      } catch (e) {
        return { ok: false, error: '生成摘要失败：' + errOf(e) };
      }
      if (!d || d.error) return { ok: false, error: (d && d.error) || '无法生成摘要' };
      return {
        ok: true, scope: scope, handle: scope === 'match' ? handleForRoom(roomId) : '',
        text: d.text, bytes: d.bytes, estTokens: d.estTokens,
        aliases: d.aliases || [], dropped: d.dropped || null,
        slot: String((store.state.meta || {}).slot || ''),
        weights: Analysis.weightsText(Analysis.weights(store))
      };
    }

    /* --------------------------------------------- 汇总（read.summary） */

    function summaryFor(store, mode) {
      var m = MODES[mode] ? mode : 'all';
      var rows = store.matches({ mode: m });
      if (!rows.length) return { ok: false, error: '本机在这个模式下还没有对局数据' };
      var s = Analysis.summarize(rows);
      var st = Analysis.streak(rows);
      var w = Analysis.windowStats(rows);
      var asc = rows.slice().sort(function (a, b) { return (a.start_time || 0) - (b.start_time || 0); });
      var daySet = {};
      asc.forEach(function (r) {
        var d = String(r.dt_event_time || '').slice(0, 10);
        if (d) daySet[d] = 1;
      });
      var best = 0;
      rows.forEach(function (r) { best = Math.max(best, r.kill || 0); });
      return {
        ok: true, mode: m,
        span: {
          from: asc[0].start_time || 0, to: asc[asc.length - 1].start_time || 0,
          fromText: asc[0].dt_event_time || '', toText: asc[asc.length - 1].dt_event_time || '',
          days: Object.keys(daySet).length
        },
        totals: {
          matches: s.total, win: s.win, lose: s.lose, winRate: s.winRate,
          kills: s.kill, deaths: s.death, assists: s.assist, kd: s.kd, kda: s.kda,
          score: s.score, scorePerMatch: s.avgScore, scorePerMinute: s.scorePerMin,
          killsPerMatch: s.avgKill, deathsPerMatch: s.avgDeath, assistsPerMatch: s.avgAssist,
          occupyTotal: s.occupy, occupyPerMatch: s.avgOccupy,
          rescueTotal: s.rescue, rescuePerMatch: s.avgRescue,
          bestMatchKills: best,
          totalSeconds: Math.round(rows.reduce(function (a2, r) {
            return a2 + (r.game_time || 0);
          }, 0)),
          quitRate: s.leaveRate, totalHours: s.totalHours, avgDurationMin: s.avgDurationMin
        },
        streak: {
          bestWin: st.bestWin, worstLose: st.worstLose,
          currentStreak: st.currentStreak, currentWin: st.currentWin
        },
        windows: {
          last10: w.last10 ? { n: w.last10.n, winRate: w.last10.winRate } : null,
          last20: w.last20 ? { n: w.last20.n, winRate: w.last20.winRate } : null,
          last30: w.last30 ? { n: w.last30.n, winRate: w.last30.winRate } : null
        },
        avgRating: Analysis.avgRating(store, rows)
      };
    }

    /* --------------------------------------------- 出口：cookie 罐与闸门 */

    function jarFor(id) {
      return readJson(cookieFile(id), {}).then(function (j) { return j || {}; });
    }
    function jarHeader(jar) {
      var parts = Object.keys(jar || {}).map(function (k) {
        return String(jar[k]).split(';')[0];
      });
      return parts.join('; ');
    }
    function absorb(jar, setCookies) {
      (setCookies || []).forEach(function (c) {
        var name = String(c).split('=')[0].trim();
        if (name) jar[name] = String(c);
      });
      return jar;
    }
    function allowlistFor(id) {
      return find(id).then(function (p) {
        var perm = p && (p.permissions || []).filter(function (x) {
          return x.scope === 'net.request';
        })[0];
        return (perm && perm.hosts) || [];
      });
    }
    function throttle(id) {
      var now = Date.now();
      var arr = (netLog[id] = (netLog[id] || []).filter(function (t) { return now - t < NET_WINDOW_MS; }));
      if (arr.length >= NET_WINDOW_MAX) {
        return '插件请求过于频繁（' + Math.round(NET_WINDOW_MS / 1000) + ' 秒内最多 ' +
          NET_WINDOW_MAX + ' 次），稍后再试';
      }
      arr.push(now);
      return '';
    }
    function cleanHeaders(src) {
      var out = {};
      Object.keys(src || {}).forEach(function (k) {
        if (HEADER_BLOCK.indexOf(String(k).toLowerCase()) === -1) {
          out[k] = String(src[k]).slice(0, 300);
        }
      });
      return out;
    }
    function countStreams(id) {
      return Object.keys(streams).filter(function (sid) { return streams[sid].id === id; }).length;
    }
    function abortAll(id) {
      Object.keys(streams).forEach(function (sid) {
        if (streams[sid].id !== id) return;
        delete streams[sid];
        to('plugin.abort', { streamId: sid });
      });
    }

    function netBody(a, cap) {
      if (a.body === undefined || a.body === null) return { body: null };
      var body = typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
      if (body.length > cap) return { error: '请求体超过 ' + Math.round(cap / 1024) + ' KB' };
      return { body: body };
    }

    /* --------------------------------------------- 能力派发（每次都复算权限） */

    function dispatch(id, method, args) {
      var a = args || {};
      return find(id).then(function (p) {
        if (!p) return { ok: false, error: '插件不存在：' + id };
        if (!p.enabled) return { ok: false, error: '插件未启用' };
        return verifyFiles(id).then(function (v) {
          if (!v.ok) {
            return { ok: false, error: '插件文件校验未通过，已拒绝调用：' + v.message };
          }
          return one(p, method, a);
        });
      }).catch(function (e) {
        return { ok: false, error: errOf(e) };
      });
    }

    function one(p, method, a) {
      var id = p.id;
      var store = getStore();
      switch (method) {
        case 'host.info':
          return Promise.resolve({
            ok: true, hostVersion: Plg.HOST_VERSION,
            plugin: { id: p.id, name: p.name, version: p.version },
            scopes: (p.permissions || []).map(function (x) { return x.scope; }),
            account: store ? {
              slot: String((store.state.meta || {}).slot || getAccounts().activeSlot || ''),
              synced: !!((store.state.meta || {}).last_sync || 0)
            } : null
          });

        case 'summary.get':
          if (!hasPerm(p, 'read.summary')) {
            return Promise.resolve({ ok: false, error: '插件没有申请「读取汇总统计」权限' });
          }
          if (!store) return Promise.resolve({ ok: false, error: '未选择账号，也没有本机数据' });
          try { return Promise.resolve(summaryFor(store, a.mode)); }
          catch (e) { return Promise.resolve({ ok: false, error: errOf(e) }); }

        case 'kv.get':
          if (!hasPerm(p, 'storage')) {
            return Promise.resolve({ ok: false, error: '插件没有申请「保存自己的配置」权限' });
          }
          return readJson(kvFile(id), {}).then(function (all) {
            if (a.key === undefined) return { ok: true, value: all };
            return {
              ok: true,
              value: Object.prototype.hasOwnProperty.call(all, a.key) ? all[a.key] : null
            };
          });

        case 'kv.set':
          if (!hasPerm(p, 'storage')) {
            return Promise.resolve({ ok: false, error: '插件没有申请「保存自己的配置」权限' });
          }
          if (typeof a.key !== 'string' || !a.key || a.key.length > 60) {
            return Promise.resolve({ ok: false, error: 'kv 的 key 必须是 1~60 字的字符串' });
          }
          if (/^__/.test(a.key)) {
            return Promise.resolve({ ok: false, error: '这个前缀是宿主保留的' });
          }
          var size = 0;
          try { size = JSON.stringify(a.value).length; }
          catch (e) { return Promise.resolve({ ok: false, error: '值无法序列化' }); }
          if (size > KV_MAX) {
            return Promise.resolve({ ok: false, error: '单个插件的配置不能超过 64 KB' });
          }
          return readJson(kvFile(id), {}).then(function (cur) {
            if (a.value === null || a.value === undefined) delete cur[a.key];
            else cur[a.key] = a.value;
            return writeJson(kvFile(id), cur).then(function () { return { ok: true }; });
          });

        case 'secret.get':
          if (!hasPerm(p, 'storage')) {
            return Promise.resolve({ ok: false, error: '插件没有申请「保存自己的配置」权限' });
          }
          return readJson(secretFile(id), {}).then(function (all) {
            /* 不带 key 时只回键名 —— 这一条就是这个层存在的理由 */
            if (a.key === undefined) return { ok: true, keys: Object.keys(all) };
            var hit = Object.prototype.hasOwnProperty.call(all, a.key) ? all[a.key] : null;
            return { ok: true, value: hit, has: hit !== null };
          });

        case 'secret.set':
          if (!hasPerm(p, 'storage')) {
            return Promise.resolve({ ok: false, error: '插件没有申请「保存自己的配置」权限' });
          }
          if (typeof a.key !== 'string' || !a.key || a.key.length > 60) {
            return Promise.resolve({ ok: false, error: '密钥的 key 必须是 1~60 字的字符串' });
          }
          if (/^__/.test(a.key)) {
            return Promise.resolve({ ok: false, error: '这个前缀是宿主保留的' });
          }
          if (a.value !== null && a.value !== undefined && typeof a.value !== 'string') {
            return Promise.resolve({ ok: false, error: '密钥只能是字符串或 null（删除）' });
          }
          if (typeof a.value === 'string' && a.value.length > SECRET_MAX) {
            return Promise.resolve({ ok: false, error: '单条密钥不超过 8 KB' });
          }
          return readJson(secretFile(id), {}).then(function (cur) {
            if (a.value === null || a.value === undefined) delete cur[a.key];
            else cur[a.key] = a.value;
            return writeJson(secretFile(id), cur).then(function () { return { ok: true }; });
          });

        case 'ai.digest':
          if (!hasPerm(p, 'read.digest')) {
            return Promise.resolve({ ok: false, error: '插件没有申请「读取去敏分析摘要」权限' });
          }
          if (!store) return Promise.resolve({ ok: false, error: '未选择账号，也没有本机数据' });
          if (!AiDigest) return Promise.resolve({ ok: false, error: '摘要模块没装配上' });
          try { return Promise.resolve(runDigest(store, a)); }
          catch (e) { return Promise.resolve({ ok: false, error: '生成摘要失败：' + errOf(e) }); }

        /* 旧版本机记录：这台机器上从来没有过"上一版"，所以永远是没有 */
        case 'legacy.check':
          if (!hasPerm(p, 'read.legacy')) {
            return Promise.resolve({ ok: false, error: '插件没有申请「搬入旧版的本机记录」权限' });
          }
          return Promise.resolve({
            ok: true, hasConfig: false, reports: 0, archived: false, hasAnything: false
          });
        case 'legacy.ai':
          if (!hasPerm(p, 'read.legacy')) {
            return Promise.resolve({ ok: false, error: '插件没有申请「搬入旧版的本机记录」权限' });
          }
          return Promise.resolve({
            ok: false, error: '这台机器上没有旧版本机记录（安卓版之前没有装过本软件）'
          });

        case 'trigger.arm':
          if (!hasPerm(p, 'view')) {
            return Promise.resolve({ ok: false, error: '插件没有页面，谈不上待办' });
          }
          return armTrigger(id, !!a.on);
        case 'trigger.take':
          if (!hasPerm(p, 'view')) {
            return Promise.resolve({ ok: false, error: '插件没有页面，谈不上待办' });
          }
          return takeTrigger(id).then(function (rec) { return { ok: true, trigger: rec || null }; });

        case 'net.clearSession':
          if (!hasPerm(p, 'net.request')) {
            return Promise.resolve({ ok: false, error: '插件没有申请「向外部发送请求」权限' });
          }
          return writeJson(cookieFile(id), {}).then(function () { return { ok: true }; });

        case 'net.request':
          return netRequest(p, a);
        case 'net.stream':
          return netStream(p, a);
        case 'net.abort':
          return netAbort(p, a);

        default:
          return Promise.resolve({ ok: false, error: '宿主没有这个方法：' + method });
      }
    }

    function hasPerm(p, scope) {
      return (p.permissions || []).some(function (x) { return x.scope === scope; });
    }

    /* ★ 闸门：没在这份登记表上逐字确认过，就一个字节也不发出去。
     *   判定只看登记表，插件自己页面里画了什么确认框一概不算数。 */
    function gate(p) {
      if (!hasPerm(p, 'net.request')) {
        return Promise.resolve('插件没有申请「向外部发送请求」权限');
      }
      if (!needsConsent(p)) return Promise.resolve('');
      return Promise.resolve(!!(p.consentGiven && p.consent && p.consent.sentence)).then(function (ok) {
        return ok ? '' : '还没在宿主这里逐字确认，本软件不会替你向外发送任何数据';
      });
    }

    function netRequest(p, a) {
      var id = p.id;
      return gate(p).then(function (why) {
        if (why) return { ok: false, error: why };
        var limit = throttle(id);
        if (limit) return { ok: false, error: limit };
        return allowlistFor(id).then(function (allow) {
          if (!allow.length) return { ok: false, error: '这个插件没有获批任何域名' };
          var b = netBody(a, NET_BODY_MAX);
          if (b.error) return { ok: false, error: b.error };
          return jarFor(id).then(function (jar) {
            return to('plugin.net', {
              url: String(a.url || ''), method: a.method ? String(a.method).toUpperCase() : 'GET',
              headers: cleanHeaders(a.headers), body: b.body, jar: jarHeader(jar),
              allow: allow, timeout: Math.min(Number(a.timeout) || 20000, 60000)
            }).then(function (r) {
              if (r && r.setCookies) {
                return writeJson(cookieFile(id), absorb(jar, r.setCookies)).then(function () {
                  return r;
                });
              }
              return r;
            });
          });
        }).then(function (r) {
          if (!r) return { ok: false, error: '原生没有回话' };
          return {
            ok: !!r.ok, status: r.status, json: parseMaybe(r.text),
            text: r.text == null ? '' : r.text, contentType: r.contentType || '',
            error: r.error
          };
        });
      });
    }

    function parseMaybe(text) {
      if (text == null || text === '') return null;
      try { return JSON.parse(text); } catch (e) { return null; }
    }

    function netStream(p, a) {
      var id = p.id;
      return gate(p).then(function (why) {
        if (why) return { ok: false, error: why };
        if (countStreams(id) >= MAX_STREAMS_PER_PLUGIN) {
          return { ok: false, error: '上一条请求还没结束，先等它完成或点「停止」' };
        }
        var limit = throttle(id);
        if (limit) return { ok: false, error: limit };
        return allowlistFor(id).then(function (allow) {
          if (!allow.length) return { ok: false, error: '这个插件没有获批任何域名' };
          var b = netBody(a, STREAM_BODY_MAX);
          if (b.error) return { ok: false, error: b.error };
          return jarFor(id).then(function (jar) {
            return to('plugin.stream', {
              url: String(a.url || ''), method: a.method ? String(a.method).toUpperCase() : 'POST',
              headers: cleanHeaders(a.headers), body: b.body, jar: jarHeader(jar),
              allow: allow, timeout: Math.min(Number(a.timeout) || 20000, 120000)
            }).then(function (r) {
              if (!r || !r.ok) return { ok: false, error: (r && r.error) || '没能发出请求' };
              streams[r.streamId] = { id: id };
              return { ok: true, streamId: r.streamId };
            });
          });
        });
      });
    }

    function netAbort(p, a) {
      var id = p.id;
      if (!hasPerm(p, 'net.request')) {
        return Promise.resolve({ ok: false, error: '插件没有申请「向外部发送请求」权限' });
      }
      var sid = String(a.streamId || '');
      var s = streams[sid];
      if (!s || s.id !== id) {
        return Promise.resolve({ ok: false, error: '没有这条请求，或者它已经结束了' });
      }
      delete streams[sid];
      return to('plugin.abort', { streamId: sid }).then(function () { return { ok: true }; });
    }

    /* 原生推来的流式分片：只认这里发出去的 streamId，40ms 合并一次再转给界面 */
    onRaw(function (name, payload) {
      if (name !== 'plugin:net' || !payload) return;
      var sid = String(payload.streamId || '');
      var s = streams[sid];
      if (!s) return;
      var type = String(payload.type || '');
      var data = payload.data || {};
      if (type === 'net.open') {
        if (data.setCookies) {
          jarFor(s.id).then(function (jar) {
            return writeJson(cookieFile(s.id), absorb(jar, data.setCookies));
          });
        }
        emit(s.id, 'net.open', {
          streamId: sid, status: data.status, contentType: data.contentType || ''
        });
        return;
      }
      if (type === 'net.data') {
        var q = pending[sid] || (pending[sid] = { buf: '', timer: null });
        q.buf += String(data.text || '');
        if (!q.timer) {
          q.timer = setTimeout(function () {
            q.timer = null;
            if (!q.buf) return;
            emit(s.id, 'net.data', { streamId: sid, text: q.buf });
            q.buf = '';
          }, STREAM_MERGE_MS);
        }
        return;
      }
      /* 尾巴先冲出去，再报结束 */
      var q2 = pending[sid];
      if (q2) {
        if (q2.timer) clearTimeout(q2.timer);
        if (q2.buf) emit(s.id, 'net.data', { streamId: sid, text: q2.buf });
        delete pending[sid];
      }
      delete streams[sid];
      emit(s.id, 'net.end', Object.assign({ streamId: sid }, data));
    });

    /* --------------------------------------------- 供页 */

    var baseCssCache = null;
    function baseCss() {
      if (baseCssCache !== null) return Promise.resolve(baseCssCache);
      /* 沙箱是另一个源，读不到宿主的 app.css，所以版式表随 plugin:page 一起给（与桌面同一条承诺）。
       * 安卓没有"读任意文件"的通道，就用它自己的假 https 源把这份 css 取回来。 */
      if (!global.fetch) {
        baseCssCache = '';
        return Promise.resolve('');
      }
      return global.fetch('/app/ui/css/plugin-base.css').then(function (r) {
        return r.text();
      }).then(function (t) {
        baseCssCache = String(t || '');
        return baseCssCache;
      }).catch(function () {
        baseCssCache = '';
        return '';
      });
    }

    function page(id) {
      return find(id).then(function (p) {
        if (!p) throw new Error('没有这个插件');
        if (!p.enabled) throw new Error('插件未启用');
        return verifyFiles(id).then(function (v) {
          if (!v.ok) throw new Error(v.message);
          var want = {};
          (p.fileHashes || []).forEach(function (f) { want[f.name] = f.hash; });
          return to('plugin.read', { id: id, name: p.entry }).then(function (h) {
            if (!h || !h.ok) throw new Error('入口文件读不到：' + p.entry);
            var chain = p.script
              ? to('plugin.read', { id: id, name: p.script }).then(function (s) {
                if (!s || !s.ok) throw new Error('脚本文件读不到：' + p.script);
                return s;
              })
              : Promise.resolve({ text: '', hash: '' });
            return chain.then(function (sc) {
              return baseCss().then(function (css) {
                if (h.hash !== want[p.entry] || (p.script && sc.hash !== want[p.script])) {
                  return {
                    ok: false, baseCss: css,
                    error: '插件内容与登记哈希不一致，已拒绝加载'
                  };
                }
                return {
                  ok: true, plugin: {
                    id: p.id, name: p.name, version: p.version, permissions: p.permissions
                  },
                  html: h.text, script: sc.text || '', baseCss: css,
                  hostVersion: Plg.HOST_VERSION
                };
              });
            });
          });
        });
      }).catch(function (e) {
        return baseCss().then(function (css) {
          return { ok: false, error: errOf(e), baseCss: css };
        });
      });
    }

    /* --------------------------------------------- 对外 */

    return {
      list: list, inspect: inspect, install: install,
      setEnabled: setEnabled, remove: remove, verify: verifyFiles, page: page,
      consent: function (id, sentence) {
        return grantConsent(id, sentence).then(function (r) {
          return r.ok ? list().then(function (l) {
            return { ok: true, plugin: r.plugin, list: l };
          }) : list().then(function (l) { return { ok: false, error: r.error, list: l }; });
        });
      },
      revoke: function (id) {
        abortAll(id);
        return revokeConsent(id).then(function (r) {
          if (!r.ok) return list().then(function (l) { return { ok: false, error: r.error, list: l }; });
          return writeJson(cookieFile(id), {}).then(function () {
            return list().then(function (l) { return { ok: true, plugin: r.plugin, list: l }; });
          });
        });
      },
      dispatch: dispatch,
      summaryFor: summaryFor,
      noteSync: noteSync,
      consentOk: consentOk,
      needsConsent: function (id) {
        return find(id).then(function (p) { return !!(p && needsConsent(p)); });
      }
    };
  }

  global.DfPluginHost = { create: create };
})(window);
