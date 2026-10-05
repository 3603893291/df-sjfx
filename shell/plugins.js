/* plugins.js — 插件宿主（主进程专用，Node 模块）
 *
 * 职责：导入 .zip 插件包 → 安全解包 → 登记 → 启用/禁用 → 按权限提供能力。
 * 出厂时这个目录树是空的，软件里也就没有任何插件功能；插件由用户自己找来导入。
 *
 * 三道独立防线，缺一不可：
 *   1) core/zip.js    —— 结构与路径校验（在碰 fs 之前）
 *   2) core/plugin.js —— 清单与权限白名单校验（在给你看权限页之前）
 *   3) 本文件的 verifyFiles() —— 落盘后按哈希复核（在启用之前，防"导入之后被换过"）
 *
 * 约定：所有对外能力都从这个类出去，插件自己拿不到 fs / net / Node。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const Zip = require('../core/zip');
const Plg = require('../core/plugin');

const FILE_EXT_OK = ['.json', '.js', '.css', '.html', '.txt', '.svg', '.png', '.jpg', '.ico'];
const REGISTRY = 'plugins.json';

function sha16(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}
function nowStr() {
  const d = new Date(), z = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' +
    z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
}

function PluginHost(opts) {
  const rootDir = path.join(opts.userDataDir, 'plugins');
  const dataDir = path.join(opts.userDataDir, 'plugin-data');
  const registryFile = path.join(rootDir, REGISTRY);

  function ensureDirs() {
    fs.mkdirSync(rootDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
  }
  function readRegistry() {
    try {
      const j = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      return Array.isArray(j.plugins) ? j : { plugins: [] };
    } catch (e) { return { plugins: [] }; }
  }
  /* ★ Windows 实测会撞到（同一场里撞了两次：整目录改名一次、plugins.json 改名一次）：
   *   刚写出来的文件还被杀软/索引器攥着句柄，renameSync 当场 EPERM。重试几次就过去了；
   *   真重试不上照旧抛出去 —— 目录那一侧走「已回滚」，配置这一侧让调用方看见错误，都不留半套文件。 */
  function renameInto(from, to) {
    for (let i = 0; ; i++) {
      try { return fs.renameSync(from, to); }
      catch (e) {
        if (i >= 4) throw e;
        const until = Date.now() + 80;
        while (Date.now() < until) { /* 让句柄松开，几十毫秒够 */ }
      }
    }
  }
  /* 插件目录里的文件一律 0600 + 先写临时文件再改名（口径照 shell/main.js 的 saveAiConfigSync）：
   * 这里存的有"谁批准了什么"、往后还会有服务商密钥，不该在崩溃时留下半个 JSON，更不该同机可读。 */
  function writePrivateJson(file, obj, indent) {
    const tmp = file + '.tmp';
    /* mode 只在新建时生效：上一步崩了留下的 tmp 要先清掉，否则会以它的旧权限被改名上去 */
    try { fs.unlinkSync(tmp); } catch (e) {}
    fs.writeFileSync(tmp, JSON.stringify(obj, null, indent), { encoding: 'utf8', mode: 0o600 });
    renameInto(tmp, file);
  }
  function writeRegistry(reg) {
    ensureDirs();
    writePrivateJson(registryFile, reg, 2);
  }
  function find(id) { return readRegistry().plugins.filter(p => p.id === id)[0] || null; }

  /* ---------- 解包 ---------- */

  function inflateEntry(en) {
    const raw = Buffer.from(en.raw.buffer, en.raw.byteOffset, en.raw.byteLength);
    if (en.method === Zip.METHOD_DEFLATE) return zlib.inflateRawSync(raw);
    return raw;
  }

  /* 把 zip 内的目录层级压掉一层：绝大多数压缩工具都会把「插件文件夹/」整个带进来 */
  function stripRoot(name, entries) {
    const first = entries.filter(e => !e.dir).map(e => e.name.split('/')[0]);
    if (!first.length) return name;
    const top = first[0];
    if (!top || first.some(s => s !== top)) return name;
    return name.indexOf(top + '/') === 0 ? name.slice(top.length + 1) : name;
  }

  /* 只做解析与校验，一个字节都不写盘 —— 权限确认页要靠这份数据先渲染出来 */
  function inspect(zipBuf) {
    const parsed = Zip.parse(new Uint8Array(zipBuf));
    if (!parsed.ok) return { ok: false, stage: 'zip', reason: parsed.reason, message: parsed.message };
    const safe = Zip.checkSafety(parsed);
    if (!safe.ok) return { ok: false, stage: 'zip', reason: 'unsafe_path', message: safe.problems.join('；') };

    const entries = parsed.entries.filter(e => !e.dir).map(e => ({
      name: stripRoot(e.name, parsed.entries), method: e.method, size: e.size, raw: e.raw
    }));
    const names = entries.map(e => e.name);
    if (names.indexOf(Plg.MANIFEST_FILE) === -1) {
      return { ok: false, stage: 'zip', reason: 'no_manifest', message: '包根目录里没有 ' + Plg.MANIFEST_FILE + '（插件至少要带清单）' };
    }
    const byName = {};
    entries.forEach((e, i) => { byName[e.name] = e; });
    const mfText = inflateEntry(byName[Plg.MANIFEST_FILE]).toString('utf8');
    const m = Plg.parseManifest(mfText, names);
    if (!m.ok) return { ok: false, stage: 'manifest', reason: m.reason, message: m.message, errors: m.errors };

    const files = entries.map(e => ({
      name: e.name,
      size: e.size,
      hash: sha16(inflateEntry(e))
    }));
    const exts = files.map(f => path.extname(f.name).toLowerCase());
    const badExt = files.filter((f, i) => FILE_EXT_OK.indexOf(exts[i]) === -1).map(f => f.name);
    if (badExt.length) {
      return { ok: false, stage: 'manifest', reason: 'bad_ext', message: '包里有不允许的文件类型：' + badExt.join('、') };
    }
    return {
      ok: true,
      manifest: m.manifest,
      permFp: Plg.fingerprintOf(m.manifest),
      files: files,
      /* 整包哈希 = 落盘文件清单的稳定摘要，用户在确认页上看到的就是它 */
      packageHash: sha16(Buffer.from(files.map(f => f.name + ':' + f.hash).sort().join('\n'), 'utf8')),
      totalSize: files.reduce((a, f) => a + f.size, 0),
      fileCount: files.length
    };
  }

  function install(preview, opts) {
    const o = opts || {};
    if (!preview || !preview.ok) return { ok: false, message: '包没通过校验，不能安装' };
    if (!o.acceptedScopes) return { ok: false, message: '需要先确认权限清单' };
    const declared = preview.manifest.permissions.map(p => p.scope);
    const missing = declared.filter(s => o.acceptedScopes.indexOf(s) === -1);
    if (missing.length) {
      return { ok: false, message: '还有权限没被勾选确认：' + missing.join('、') + ' —— 要么全部同意，要么不装' };
    }
    const reg = readRegistry();
    const id = preview.manifest.id;
    const dir = path.join(rootDir, id);
    const tmp = dir + '__tmp';
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });

    /* 先解到临时目录，全部成功再换正位 —— 中途失败不能留下半套文件 */
    let realTotal = 0;
    try {
      for (const f of preview.files) {
        if (!Buffer.isBuffer(f.buf)) throw new Error('内部错误：缺少条目内容');
        if (f.buf.length > Zip.MAX_ENTRY_BYTES) throw new Error('「' + f.name + '」解压后超过单文件上限');
        realTotal += f.buf.length;
        if (!Zip.isSafeRelPath(f.name)) throw new Error('非法的插件内路径：' + f.name);
        const dest = path.resolve(tmp, f.name);
        if (dest.indexOf(path.resolve(tmp) + path.sep) !== 0) throw new Error('解包路径越界：' + f.name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.buf);
      }
      if (realTotal > Zip.TOTAL_BUDGET) throw new Error('解压后总大小超过上限');
      fs.rmSync(dir, { recursive: true, force: true });
      renameInto(tmp, dir);
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) {}
      return { ok: false, message: '解包失败，已回滚：' + e.message };
    }

    const rec = {
      id: id,
      name: preview.manifest.name,
      version: preview.manifest.version,
      description: preview.manifest.description,
      author: preview.manifest.author,
      entry: preview.manifest.entry,
      script: preview.manifest.script,
      permissions: preview.manifest.permissions,
      consent: preview.manifest.consent || null,
      consentGiven: false,
      consentAt: '',
      permFp: preview.permFp,
      packageHash: preview.packageHash,
      fileHashes: preview.files.map(f => ({ name: f.name, hash: f.hash })),
      totalSize: realTotal,
      enabled: false,
      imported_at: nowStr(),
      source: String(o.source || '').slice(0, 120)
    };
    const i = reg.plugins.findIndex(p => p.id === id);
    if (i >= 0) reg.plugins[i] = rec; else reg.plugins.push(rec);
    writeRegistry(reg);
    /* 新导入的一律先禁用：装上是装上的意思，用不用是另一个动作 */
    return { ok: true, plugin: rec };
  }

  /* inspect() 只留了哈希，install() 需要内容 —— 用一个内存副本把两步粘起来，避免二次读盘解包 */
  function inspectWithBuffers(zipBuf) {
    const p = inspect(zipBuf);
    if (!p.ok) return p;
    const parsed = Zip.parse(new Uint8Array(zipBuf));
    const byName = {};
    parsed.entries.filter(e => !e.dir).forEach(e => { byName[stripRoot(e.name, parsed.entries)] = e; });
    p.files.forEach(f => { f.buf = inflateEntry(byName[f.name]); });
    return p;
  }

  function setEnabled(id, on) {
    const reg = readRegistry();
    const p = reg.plugins.find(x => x.id === id);
    if (!p) return { ok: false, message: '没有这个插件' };
    if (on) {
      const v = verifyFiles(id);
      if (!v.ok) return { ok: false, message: '文件校验不过，不能启用：' + v.message };
      if (v.permDrift) return { ok: false, message: v.message };
    }
    p.enabled = !!on;
    writeRegistry(reg);
    return { ok: true, plugin: p };
  }

  /* ---------- 外发确认闸门 ----------
   * ★ 判定只看登记表，不看插件页面里画了什么。插件自己那个确认框只是给用户看的装饰，
   *   真正"能不能替你出网"由这里说了算 —— 哪些能力需要这句话，只有 core/plugin.js 的
   *   SCOPES[x].needsConsent 一处定义，这里绝不另列一份名单。 */
  function needsConsent(id) {
    const p = find(id);
    if (!p) return false;
    return (p.permissions || []).some(function (x) {
      const def = Plg.SCOPES[x.scope];
      return !!(def && def.needsConsent);
    });
  }
  function consentOk(id) {
    if (!needsConsent(id)) return true;
    const p = find(id);
    return !!(p && p.consentGiven && p.consent && p.consent.sentence);
  }
  function grantConsent(id, input) {
    const reg = readRegistry();
    const p = reg.plugins.find(x => x.id === id);
    if (!p) return { ok: false, message: '没有这个插件' };
    const sentence = p.consent && p.consent.sentence;
    if (!needsConsent(id) || !sentence) return { ok: false, message: '这个插件没有需要逐字确认的外发能力' };
    if (!Plg.matchConsent(input, sentence)) return { ok: false, message: '输入的这句话与清单里那句不一致，未确认' };
    p.consentGiven = true;
    p.consentAt = nowStr();
    writeRegistry(reg);
    return { ok: true, plugin: { id: p.id, consentGiven: true, consentAt: p.consentAt } };
  }
  function revokeConsent(id) {
    const reg = readRegistry();
    const p = reg.plugins.find(x => x.id === id);
    if (!p) return { ok: false, message: '没有这个插件' };
    p.consentGiven = false;
    p.consentAt = '';
    writeRegistry(reg);
    return { ok: true, plugin: { id: p.id, consentGiven: false, consentAt: '' } };
  }

  function verifyFiles(id) {
    const p = find(id);
    if (!p) return { ok: false, message: '没有这个插件' };
    const changed = [], missing = [];
    (p.fileHashes || []).forEach(f => {
      const fp = path.join(rootDir, id, f.name);
      if (!Zip.isSafeRelPath(f.name)) { changed.push(f.name); return; }
      let buf;
      try { buf = fs.readFileSync(fp); } catch (e) { missing.push(f.name); return; }
      if (buf.length > Zip.MAX_ENTRY_BYTES || sha16(buf) !== f.hash) changed.push(f.name);
    });
    if (missing.length || changed.length) {
      return {
        ok: false,
        permDrift: false,
        message: '插件文件与导入时不一致' +
          (missing.length ? '（少了：' + missing.slice(0, 3).join('、') + '）' : '') +
          (changed.length ? '（被改过：' + changed.slice(0, 3).join('、') + '）' : '') +
          '。请重新导入这个包。'
      };
    }
    /* 权限指纹单独判一遍：文件没变但登记表被手工改过的场合 */
    const now = Plg.fingerprintOf(p);
    if (now !== p.permFp) {
      return { ok: false, permDrift: true, message: '登记信息里的权限与本机指纹不一致（' + now + ' ≠ ' + p.permFp + '），已拒绝启用。' };
    }
    return { ok: true };
  }

  function remove(id) {
    const reg = readRegistry();
    const i = reg.plugins.findIndex(x => x.id === id);
    if (i < 0) return { ok: false, message: '没有这个插件' };
    reg.plugins.splice(i, 1);
    writeRegistry(reg);
    try { fs.rmSync(path.join(rootDir, id), { recursive: true, force: true }); } catch (e) {}
    /* Cookie 里是活的登录凭证，插件都没了就不能留在盘上；原子写的 .tmp 也一并清 */
    [path.join(dataDir, id + '.json'), cookieFile(id), secretFile(id)].forEach(function (f) {
      [f, f + '.tmp'].forEach(function (p) { try { fs.unlinkSync(p); } catch (e) {} });
    });
    dropTrigger(id);
    return { ok: true };
  }

  function list() {
    const trig = triggerReadAll();
    return readRegistry().plugins.map(p => ({
      id: p.id, name: p.name, version: p.version, description: p.description, author: p.author,
      entry: p.entry, script: p.script, permissions: p.permissions, enabled: !!p.enabled,
      consent: p.consent || null, consentGiven: !!p.consentGiven, consentAt: p.consentAt || '',
      autoTrigger: !!(p.autoTrigger && p.autoTrigger.on),
      pendingTrigger: trig[p.id] && typeof trig[p.id] === 'object'
        ? { at: trig[p.id].at || 0, count: trig[p.id].count || 0 } : null,
      imported_at: p.imported_at, packageHash: p.packageHash, permFp: p.permFp,
      totalSize: p.totalSize, fileCount: (p.fileHashes || []).length
    }));
  }

  /* 只有已启用的插件能读文件；读不到目录外任何东西 */
  function readFile(id, rel) {
    const p = find(id);
    if (!p || !p.enabled) return null;
    if (!Zip.isSafeRelPath(rel)) return null;
    const known = (p.fileHashes || []).some(f => f.name === rel);
    if (!known) return null;
    try { return fs.readFileSync(path.join(rootDir, id, rel)); } catch (e) { return null; }
  }

  /* 插件私有存储：与账号数据包完全分开，不进导出、不进备份 */
  function kvRead(id) {
    const p = find(id);
    if (!p) return null;
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, id + '.json'), 'utf8')); } catch (e) { return {}; }
  }
  function kvWrite(id, obj) {
    const p = find(id);
    if (!p) return { ok: false, message: '没有这个插件' };
    ensureDirs();
    try {
      writePrivateJson(path.join(dataDir, id + '.json'), obj, 2);
      return { ok: true };
    } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
  }
  function hasStorage(id) {
    const p = find(id);
    return !!(p && (p.permissions || []).some(x => x.scope === 'storage'));
  }
  /* 会话 Cookie 由宿主代管：单独一个文件，插件的 kv 读不到，也不会跟着数据包导出 */
  function cookieFile(id) { return path.join(dataDir, id + '.cookies.json'); }
  function cookieRead(id) {
    if (!find(id)) return {};
    try { return JSON.parse(fs.readFileSync(cookieFile(id), 'utf8')) || {}; } catch (e) { return {}; }
  }
  function cookieWrite(id, obj) {
    if (!find(id)) return { ok: false, message: '没有这个插件' };
    ensureDirs();
    try {
      writePrivateJson(cookieFile(id), obj || {}, 1);
      return { ok: true };
    } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
  }

  /* ---- 密钥层：和 kv 分成两个文件 ----
   * 为什么单独一份：kv.get() 不带 key 时是"把整个配置对象给我"，
   * 密钥混在里面就会被打包一起回给页面。分开之后，取密钥必须显式开口，
   * 界面上"它读了自己的配置"和"它拿到了密钥"是两件事，日志里也分得清。 */
  function secretFile(id) { return path.join(dataDir, id + '.secret.json'); }
  function secretRead(id) {
    if (!find(id)) return null;
    try { return JSON.parse(fs.readFileSync(secretFile(id), 'utf8')) || {}; } catch (e) { return {}; }
  }
  function secretWrite(id, obj) {
    if (!find(id)) return { ok: false, message: '没有这个插件' };
    ensureDirs();
    try {
      writePrivateJson(secretFile(id), obj || {}, 1);
      return { ok: true };
    } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
  }

  /* ---- 待办登记（triggers.json）----
   * ★ 这是"自动日报"唯一允许的形态：同步成功时宿主只往这里记一笔，
   *   谁也别替使用者跑一段插件代码。插件页被打开时 takeTrigger 取走并清零，
   *   按钮始终握在一个看得见界面的人手里。 */
  function triggerFile() { return path.join(dataDir, 'triggers.json'); }
  function triggerReadAll() {
    try { return JSON.parse(fs.readFileSync(triggerFile(), 'utf8')) || {}; } catch (e) { return {}; }
  }
  function triggerWriteAll(obj) {
    ensureDirs();
    writePrivateJson(triggerFile(), obj, 1);
  }
  function noteTrigger(id, info) {
    const all = triggerReadAll();
    const cur = all[id] && typeof all[id] === 'object' ? all[id] : { count: 0 };
    cur.count = Math.min(Number(cur.count) || 0, 999) + 1;
    cur.at = Date.now();
    cur.info = info && typeof info === 'object' ? info : null;
    all[id] = cur;
    try { triggerWriteAll(all); return { ok: true, count: cur.count }; }
    catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
  }
  function peekTrigger(id) {
    const rec = triggerReadAll()[id];
    return rec && typeof rec === 'object' ? rec : null;
  }
  function takeTrigger(id) {
    const all = triggerReadAll();
    const rec = all[id];
    if (!rec || typeof rec !== 'object') return null;
    delete all[id];
    try { triggerWriteAll(all); } catch (e) { /* 取不走也要如实回 */ }
    return rec;
  }
  function dropTrigger(id) {
    const all = triggerReadAll();
    if (all[id] === undefined) return;
    delete all[id];
    try { triggerWriteAll(all); } catch (e) {}
  }
  /* 使用者在插件页上自己打开的开关，记在登记表上。
   * ★ 它刻意不在权限指纹里（指纹只含 id/version/permissions/consent）—— 一个会用着改的开关
   *   要是进了指纹，插件每次被设一下"日报"都会把自己判成被篡改。 */
  function armTrigger(id, on) {
    const reg = readRegistry();
    const p = reg.plugins.filter(function (x) { return x.id === id; })[0];
    if (!p) return { ok: false, message: '没有这个插件' };
    p.autoTrigger = { on: !!on, at: Date.now() };
    try { writeRegistry(reg); return { ok: true, on: !!on }; }
    catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
  }
  function triggerArmed(id) {
    const p = find(id);
    return !!(p && p.autoTrigger && p.autoTrigger.on);
  }

  /* 给 iframe 的页面资源：启用 + 文件校验通过才给，且回哈希让渲染层能发现"读的瞬间被换过" */
  function pageAssets(id) {
    const p = find(id);
    if (!p) return { ok: false, message: '没有这个插件' };
    if (!p.enabled) return { ok: false, message: '插件未启用' };
    const v = verifyFiles(id);
    if (!v.ok) return { ok: false, message: v.message };
    const html = readFile(id, p.entry);
    if (html === null) return { ok: false, message: '入口文件读不到：' + p.entry };
    const script = p.script ? readFile(id, p.script) : null;
    if (p.script && script === null) return { ok: false, message: '脚本文件读不到：' + p.script };
    const want = {};
    (p.fileHashes || []).forEach(function (f) { want[f.name] = f.hash; });
    return {
      ok: true,
      plugin: { id: p.id, name: p.name, version: p.version, permissions: p.permissions },
      html: html.toString('utf8'),
      script: script ? script.toString('utf8') : '',
      hash: {
        html: sha16(html),
        script: script ? sha16(script) : '',
        declared: [want[p.entry] || '', p.script ? (want[p.script] || '') : '']
      }
    };
  }
  /* ★ 域名能不能出网，判定只有一处：plugin-api 从登记表取出 hosts 交给 plugin-net 逐跳校验。
   *   这里以前有个 mayRequest 自己又比了一遍 —— 没有任何调用方，且清单写成 ["*"] 时它会对每个
   *   真实主机返回 false。两处判定迟早会漂移，删掉，别留第二个源头。 */
  function canScope(id, scope) {
    const p = find(id);
    return !!(p && p.enabled && (p.permissions || []).some(x => x.scope === scope));
  }

  return {
    rootDir: rootDir, dataDir: dataDir,
    inspect: inspect, inspectWithBuffers: inspectWithBuffers, install: install,
    list: list, find: find, setEnabled: setEnabled, remove: remove,
    verifyFiles: verifyFiles, readFile: readFile,
    kvRead: kvRead, kvWrite: kvWrite, hasStorage: hasStorage,
    secretRead: secretRead, secretWrite: secretWrite,
    noteTrigger: noteTrigger, peekTrigger: peekTrigger, takeTrigger: takeTrigger,
    armTrigger: armTrigger, triggerArmed: triggerArmed, dropTrigger: dropTrigger,
    cookieRead: cookieRead, cookieWrite: cookieWrite, pageAssets: pageAssets,
    needsConsent: needsConsent, consentOk: consentOk,
    grantConsent: grantConsent, revokeConsent: revokeConsent,
    canScope: canScope
  };
}

module.exports = { PluginHost: PluginHost, REGISTRY: REGISTRY };
