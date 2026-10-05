'use strict';
/* 开发预览服务：静态托管 ui/ + 用真实样本数据模拟 window.df
 * 用途：不启动 Electron 也能在浏览器里检查界面
 * 运行：node test/preview-server.js  → http://127.0.0.1:8770
 * 环境变量：
 *   DF_PREVIEW_DATA=<路径>          使用指定 JSON 而不是样本
 *   DF_PREVIEW_LOGGED_IN=0          模拟未登录，方便检查登录视图
 *   DF_PREVIEW_STATE_FILE=<路径>    主 slot 持久化文件
 * 预览模式下会同时构造两个 slot：a1（样本）、a2（空），方便肉眼验证切换/添加/移除。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Maps = require('../core/maps');
const Collector = require('../core/collector');   /* 只取 DEFAULT_SID：赛季号那份判据在 collector 一颗，预览这第三个生产者不许自己写 10 */
const Cfg = require('../core/mapConfig');
const Update = require('../core/update');
const MAP_FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'map-config.json'), 'utf8');
const StoreMod = require('../core/store');
const Analysis = require('../core/analysis');
const Channels = require('../shell/plugin-channels');
const { PluginHost } = require('../shell/plugins');
const { createPluginApi } = require('../shell/plugin-api');
const Plg = require('../core/plugin');
/* 与 shell/main.js 的 pluginBaseCss() 同一份文件：预览里注入给沙箱的样式必须和交付包一致 */
const PLUGIN_BASE_CSS = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'ui', 'css', 'plugin-base.css'), 'utf8');

const UI = path.join(__dirname, '..', 'ui');
const SAMPLE = path.join(__dirname, '..', '..', 'df-analyzer', 'sample', 'sample_data.json');
const PORT = 8770;
const TMP = path.join(os.tmpdir(), 'df-swtwr-preview');
const ACCOUNTS_FILE = process.env.DF_PREVIEW_ACCOUNTS_FILE || path.join(TMP, 'accounts.json');
const BACKUP_DIR = path.join(TMP, 'backups');
const LOGGED_IN = process.env.DF_PREVIEW_LOGGED_IN !== '0';
/* 环境变量管整场，UI 探针需要在同一场里既量已登录的外壳、又走登录页那一条 —— 再认一个查询串开关 */
function loggedOf(u) { return LOGGED_IN && u.searchParams.get('logged') !== '0'; }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml'
};

function slotFile(slot) { return path.join(TMP, 'df-swtwr-' + slot + '.json'); }

/* ---------------- 扩展插件（只服务于开发预览，不进安装包） ----------------
 * 与 shell/main.js 里那 8 个 ipcMain.handle 一一对应，跑的是同一份 PluginHost
 * 和同一份能力桥。唯一不同：浏览器里没有原生文件对话框，所以先调
 * /mock/plugin/queue 把要导入的包排上，再走 inspect → install。
 */
const PLUG_DIST = path.join(__dirname, '..', 'plugins-dist');
let plugHost = null, plugApi = null, plugQueued = '';
const plugPreviews = new Map();
/* 预览里主进程与渲染层之间没有 webContents.send，流式事件先压队列，浏览器轮询 /mock/plugin/events 取走。
   队列只在本机 127.0.0.1 上流转，且取走即清 —— 和宿主「一次性待办」同一语义。 */
const plugEvents = [];

function pluginHostOf() {
  if (!plugHost) {
    plugHost = PluginHost({ userDataDir: TMP });
    const dig = Channels.createDigestChannel({ getStore: currentStore });
    const leg = Channels.createLegacyChannel({ getStore: currentStore, userDataDir: function () { return TMP; } });
    plugApi = createPluginApi({
      host: plugHost,
      getStore: currentStore,
      emit: function (pluginId, event, data) {
        if (plugEvents.length > 4000) plugEvents.splice(0, plugEvents.length - 4000);
        plugEvents.push({ pluginId: pluginId, event: event, data: data || {} });
      },
      digest: function (id, args) { return dig.run(id, args); },
      legacy: function (id) { return leg.take(id); },
      legacyInfo: function () { return leg.check(); }
    });
  }
  return plugHost;
}
function pluginApiOf() { pluginHostOf(); return plugApi; }

/* 与 shell/main.js 的 notePluginTriggers 同一动作：同步收尾只记一笔，绝不在主进程里跑插件代码。
   要不要现在出日报，由插件页开页时把这笔取走、由人按下按钮决定。 */
function notePluginTriggers(info) {
  let host = null, list = [];
  try { host = pluginHostOf(); list = host.list(); } catch (e) { return; }
  list.forEach(function (p) {
    if (!p.enabled || !p.autoTrigger) return;
    try {
      host.noteTrigger(p.id, {
        at: Number(info && info.at) || Date.now(),
        slot: String((info && info.slot) || ''),
        inserted: Number(info && info.inserted) || 0,
        matches: Number(info && info.matches) || 0
      });
    } catch (e) { /* 记不上也不能把一次成功的同步说成失败 */ }
  });
}

function pluginViewOf(p) {
  return {
    id: p.id, name: p.name, version: p.version, description: p.description, author: p.author,
    entry: p.entry, script: p.script, permissions: p.permissions || [],
    consent: p.consent || null, consentGiven: !!p.consentGiven, consentAt: p.consentAt || '',
    autoTrigger: !!(p.autoTrigger && p.autoTrigger.on),
    pendingTrigger: p.pendingTrigger || null,
    enabled: !!p.enabled, imported_at: p.imported_at, packageHash: p.packageHash,
    permFp: p.permFp,
    totalSize: p.totalSize, fileCount: (p.fileHashes || []).length
  };
}
/* 形状与 main.js 的 pluginListView() 保持一致：界面拿的是同一套字段 */
function pluginListViewOf() {
  const host = pluginHostOf();
  const out = host.list().map(function (p) {
    const v = host.verifyFiles(p.id);
    return Object.assign({}, p, { intact: !!v.ok, intactMessage: v.message || '' });
  });
  const netOn = out.filter(function (p) {
    return p.enabled && (p.permissions || []).some(function (x) { return x.scope === 'net.request'; });
  });
  return {
    ok: true, hostVersion: Plg.HOST_VERSION, plugins: out, scopes: Plg.SCOPES, dir: host.rootDir,
    enabledCount: out.filter(function (p) { return p.enabled; }).length,
    netEnabledCount: netOn.length,
    netHosts: netOn.reduce(function (acc, p) {
      (p.permissions || []).forEach(function (x) {
        if (x.scope === 'net.request') {
          (x.hosts || []).forEach(function (h) { if (acc.indexOf(h) === -1) acc.push(h); });
        }
      });
      return acc;
    }, [])
  };
}
function pluginInspectFile(file) {
  const abs = path.resolve(PLUG_DIST, String(file || ''));
  if (abs.indexOf(path.resolve(PLUG_DIST) + path.sep) !== 0) {
    return { ok: false, error: '预览环境只允许从 plugins-dist 里挑包' };
  }
  if (!fs.existsSync(abs)) return { ok: false, error: '找不到这个包：' + path.basename(abs) };
  const preview = pluginHostOf().inspectWithBuffers(fs.readFileSync(abs));
  if (!preview.ok) return { ok: false, error: preview.message, stage: preview.stage };
  const token = 'pv' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  plugPreviews.set(token, { preview: preview, source: path.basename(abs) });
  const m = preview.manifest;
  return {
    ok: true, token: token, source: path.basename(abs), hostVersion: Plg.HOST_VERSION,
    manifest: m, permissions: m.permissions, permFp: preview.permFp, packageHash: preview.packageHash,
    files: preview.files.map(function (f) { return { name: f.name, size: f.size, hash: f.hash }; }),
    fileCount: preview.fileCount, totalSize: preview.totalSize,
    replaced: !!pluginHostOf().find(m.id)
  };
}

let _pkgVersion = null;
function pkgVersion() {
  if (_pkgVersion === null) {
    try {
      _pkgVersion = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || 'preview';
    } catch (e) { _pkgVersion = 'preview'; }
  }
  return _pkgVersion;
}

function fileAdapter(fp) {
  return {
    load: function () {
      try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return null; }
    },
    save: function (s) {
      try {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, JSON.stringify(s), 'utf8');
      } catch (e) { console.error('[预览] 状态写入失败：' + (e.message || e)); }
    }
  };
}

function readBody(req) {
  return new Promise(function (resolve) {
    let buf = '';
    req.on('data', function (c) { buf += c; if (buf.length > 8e6) req.destroy(); });
    req.on('end', function () {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { resolve({}); }
    });
  });
}

/* 全局 registry：activeSlot + accounts + per-slot stores */
const registry = {
  version: 2, activeSlot: 'a1',
  globalSettings: { theme: 'system', backupDir: '', backupKeep: 7, autoBackup: true },
  accounts: [], stores: new Map()
};

function saveRegistry() {
  try {
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({
      version: registry.version, activeSlot: registry.activeSlot,
      globalSettings: registry.globalSettings,
      accounts: registry.accounts
    }, null, 1), 'utf8');
  } catch (e) { console.error('[预览] accounts 写入失败：' + (e.message || e)); }
}

function loadRegistry() {
  try {
    const j = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    registry.version = j.version || 2;
    registry.activeSlot = j.activeSlot || 'a1';
    registry.globalSettings = Object.assign(registry.globalSettings, j.globalSettings || {});
    registry.accounts = j.accounts || [];
    return true;
  } catch (e) { return false; }
}

function makeStore(slot) {
  const s = new StoreMod.Store(fileAdapter(slotFile(slot)));
  s._filePath = slotFile(slot);
  registry.stores.set(slot, s);
  return s;
}

function currentStore() { return registry.stores.get(registry.activeSlot); }

/* 载入后清一次关注表里的脏键（与主进程 switchTo 同一动作） */
function gcPeople(st) {
  try {
    const r = st.gcPeople(Analysis.buildIdentityIndex(st).groups);
    if (r.changed) return st.save().catch(function () {});
  } catch (e) { /* 回收失败不影响预览 */ }
  return Promise.resolve();
}

function listAccountsView() {
  return registry.accounts.map(function (a) {
    const s = registry.stores.get(a.slot);
    const st = s && s.state;
    return {
      slot: a.slot, openid: a.openid || '', name: a.name || '', area: a.area || 36,
      partition: 'persist:wegame-slot-' + a.slot,
      created_at: a.created_at || 0,
      last_sync: (st && st.meta.last_sync) || a.last_sync || 0,
      matches: st ? Object.keys(st.matches || {}).length : 0,
      rosters: st ? Object.keys(st.rosters || {}).length : 0,
      fileExists: fs.existsSync(slotFile(a.slot)),
      active: a.slot === registry.activeSlot
    };
  });
}

/* 地图名字典（预览层）：不发真网络 —— 拿 test/fixtures 那份真夹具冒充「取回来的一发」，
 * 于是探针能在离线里量到按完按钮之后状态行与地名都变了。判定与落库口径照 shell/main.js。 */
function mapNamesStatus() {
  const rec = registry.globalSettings.mapNames;
  const c = Maps.mapNameCounts();
  const s = currentStore();
  return {
    ok: true, builtin: c.builtin, learned: c.learned, user: c.user, at: (rec && rec.at) || 0,
    unknown: s && s.state ? s.unknownMaps() : 0,
    never: !(rec && rec.at)
  };
}
function persistMapNames(at) {
  const rec = registry.globalSettings.mapNames;
  registry.globalSettings.mapNames = {
    at: at || (rec && rec.at) || 0,
    names: Maps.extraNames(),
    userNames: Maps.userNames()
  };
  saveRegistry();
}
function mapNamesPull() {
  const s = currentStore();
  const before = s && s.state ? s.unknownMaps() : 0;
  const p = Cfg.parse(MAP_FIXTURE);
  if (!p.ok) return Promise.resolve({ ok: false, error: p.error });
  const merged = Maps.applyExtra(p.names);
  persistMapNames(Date.now());
  return (s ? s.save() : Promise.resolve()).then(function () {
    const out = mapNamesStatus();
    out.added = merged.added; out.rows = p.count;
    out.renamed = Math.max(0, before - (out.unknown || 0));
    return out;
  });
}
/* 本机字典与就地改名（#92）：形状与桌面 ipcMain 'mapNames:dict' / 'mapNames:setName' 一字不差。
 * 预览层不发真网络，改名也不出网 —— 它只写 registry 那份 TMP accounts。 */
/* 在线更新（预览层）：绝不出网。发的是本地夹具 test/fixtures/update-sample.json，
 * 但 parse / plan 用的是与桌面、安卓同一份 core/update.js —— 界面那句"发现新版本"
 * 因此在浏览器里就能量版式，而不用等那台服务器回话。 */
const UPDATE_FIXTURE = path.join(__dirname, 'fixtures', 'update-sample.json');
let updateSeen = null;
function updateStatus() {
  return Object.assign({
    ok: true, checked: !!updateSeen, checking: false, action: 'none', latest: '',
    notes: '', force: 0, error: '', download: '', size: 0, current: Plg.HOST_VERSION
  }, updateSeen || {});
}
async function updateCheck() {
  let text = '';
  try { text = fs.readFileSync(UPDATE_FIXTURE, 'utf8'); }
  catch (e) { return updateStatus(); }
  const m = Update.parse(text);
  const p = Update.plan(m, Plg.HOST_VERSION);
  updateSeen = {
    ok: true, checked: true, action: m.ok ? p.action : 'none',
    latest: (m.ok && m.version) || '', notes: (m.ok && m.notes) || '',
    force: (m.ok && m.force) ? 1 : 0, size: (m.ok && m.size) || 0,
    download: (m.ok && m.url) || '', error: m.ok ? '' : String(m.error || ''),
    current: Plg.HOST_VERSION
  };
  return updateSeen;
}

function mapNamesDict() {  const rec = registry.globalSettings.mapNames;
  const c = Maps.mapNameCounts();
  const d = Maps.nameDict();
  const s = currentStore();
  return {
    ok: true, builtin: c.builtin, learned: c.learned, user: c.user,
    at: (rec && rec.at) || 0, never: !(rec && rec.at),
    unknown: s && s.state ? s.unknownMaps() : 0,
    usage: s && s.state ? s.mapUsage() : [],
    userEdits: d.user, learnedList: d.learned
  };
}
function mapNamesSet(id, name) {
  const target = String(id == null ? '' : id).trim();
  if (!/^\d{1,8}$/.test(target)) return Promise.resolve({ ok: false, error: '地图 id 不对：' + target });
  const wasName = Maps.nameOf(target);
  const r = name == null || String(name).trim() === ''
    ? Maps.clearUserName(target) : Maps.setUserName(target, name);
  if (r.ignored) {
    return Promise.resolve({ ok: false, error: '这个名字不能用（空、超过 40 字，或含尖括号与控制字符）' });
  }
  persistMapNames();
  const s = currentStore();
  const touched = r.cleared && s ? s.rollbackMapName(target, wasName) : 0;
  const before = s && s.state ? s.unknownMaps() : 0;
  return (s ? s.save() : Promise.resolve()).then(function () {
    const out = mapNamesStatus();
    out.ok = true; out.applied = r.applied; out.cleared = r.cleared;
    out.renamed = touched + Math.max(0, before - (out.unknown || 0));
    return out;
  });
}

(async function () {
  fs.mkdirSync(TMP, { recursive: true });
  const hadRegistry = loadRegistry();
  /* ★ 每次起服务都回到「字典还没建过」这个起点：TMP 是跨次复用的，
   *   留着上一次的字典，探针就量不出那颗按钮到底改没改这行状态（也会让改名那一段看不见）。 */
  delete registry.globalSettings.mapNames;
  Maps.clearExtra();
  Maps.clearUser();   /* 同上：使用者那一层也回到干净起点，否则上一轮探针改的名字会串进这一轮 */

  if (!hadRegistry || !registry.accounts.length) {
    // 初始化：a1 = 样本主号，a2 = 空号
    const mainSlot = 'a1';
    const mainStore = makeStore(mainSlot);
    await mainStore.load();

    const realData = process.env.DF_PREVIEW_DATA;
    const hasData = mainStore.state && mainStore.state.matches &&
      Object.keys(mainStore.state.matches).length;
    if (!hasData) {
      if (realData && fs.existsSync(realData)) {
        mainStore.state = Object.assign(mainStore.state, JSON.parse(fs.readFileSync(realData, 'utf8')));
        await mainStore.save();
      } else {
        const raw = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
        await mainStore.ingest({
          at: Date.now(), role: raw.role, season: raw.season,
          list: raw.list, maps: raw.maps, details: raw.details
        });
      }
    }
    const meta = mainStore.state.meta || {};
    registry.accounts.push({
      slot: mainSlot, openid: meta.openid || 'preview-openid-1',
      name: meta.name || '预览主号', area: meta.area || 36,
      partition: 'persist:wegame-slot-' + mainSlot,
      created_at: Date.now(), last_sync: meta.last_sync || Date.now()
    });
    registry.activeSlot = mainSlot;

    // a2：空号
    const secondSlot = 'a2';
    const second = makeStore(secondSlot);
    await second.load();
    registry.accounts.push({
      slot: secondSlot, openid: 'preview-openid-2',
      name: '预览副号（空）', area: 36,
      partition: 'persist:wegame-slot-' + secondSlot,
      created_at: Date.now(), last_sync: 0
    });
    saveRegistry();
    console.log('[预览] 首次启动：已创建 a1（样本）与 a2（空号）');
  } else {
    for (const a of registry.accounts) {
      const s = makeStore(a.slot);
      await s.load();
    }
    if (!registry.stores.has(registry.activeSlot) && registry.accounts.length) {
      registry.activeSlot = registry.accounts[0].slot;
    }
    console.log('[预览] 复用已有 accounts：' + ACCOUNTS_FILE);
  }

  for (const st of registry.stores.values()) await gcPeople(st);

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;

    function filtersOf(url) {
      const uu = new URL(url, 'http://x');
      const f = {};
      if (uu.searchParams.get('mode')) f.mode = uu.searchParams.get('mode');
      if (uu.searchParams.get('kind')) f.kind = uu.searchParams.get('kind');
      if (uu.searchParams.get('leave')) f.leave = uu.searchParams.get('leave');
      if (uu.searchParams.get('since')) f.since = Number(uu.searchParams.get('since')) || undefined;
      return f;
    }
    function send(code, type, body) { res.writeHead(code, { 'Content-Type': type }); res.end(body); }
    function jsonr(obj) { send(200, MIME['.json'], JSON.stringify(obj)); }

    const store = currentStore();

    if (req.method === 'GET') {
      if (p === '/' || p === '/index.html') {
        let html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
        html = html.replace('<script src="js/theme.js"></script>',
          '<script src="mock-df.js"></script>\n<script src="js/theme.js"></script>');
        return send(200, MIME['.html'], html);
      }
      if (p === '/mock-df.js')
        return send(200, MIME['.js'], fs.readFileSync(path.join(__dirname, 'mock-df.js')));

      if (p === '/mock/boot') {
        /* 查询串能临时改判登录态：一次运行里既要量"已登录的外壳"，也要走登录页与只读号那条分支
         * （探针 ⑥）。环境变量 DF_PREVIEW_LOGGED_IN 管的是整场，不够用。 */
        const isLogged = loggedOf(u);
        const localOnly = u.searchParams.get('localonly') === '1';
        const noData = u.searchParams.get('nodata') === '1';
        return jsonr({
          loggedIn: isLogged && !localOnly,
          localOnly: localOnly,
          loginPending: process.env.DF_PREVIEW_LOGIN_PENDING === '1',
          role: isLogged ? store.state.role : null,
          name: store.state.meta.name, lastSync: store.state.meta.last_sync,
          stats: store.stats(),
          matchCount: noData ? 0 : Object.keys(store.state.matches || {}).length,
          settings: Object.assign({}, store.state.settings, registry.globalSettings),
          /* 内置默认赛季号也照着两个壳给一份：预览里设置页那句"留空 = 第 N 赛季"要和真机念得一样 */
          sidDefault: Collector.DEFAULT_SID,
          accounts: listAccountsView(),
          activeSlot: registry.activeSlot
        });
      }
      if (p === '/mock/info') {
        return jsonr({
          dataFile: slotFile(registry.activeSlot),
          accountsFile: ACCOUNTS_FILE,
          backupDir: BACKUP_DIR, activeSlot: registry.activeSlot,
          version: pkgVersion(), maps: Maps.tdmIds.length, swwrMaps: Maps.swtwrIds.length,
          sandboxUrl: 'https://aeuicey.github.io/DeltaForce-TacticalPanel/'
        });
      }
      if (p === '/mock/report') return jsonr(Analysis.report(store, filtersOf(req.url)));
      if (p === '/mock/matches') {
        const f = filtersOf(req.url);
        const watchMap = Analysis.watchedRoomMap(store);
        return jsonr(store.matches({ mode: f.mode || 'all', kind: f.kind || 'all', leave: f.leave || 'all', since: f.since,
          includeExcluded: true })
          .map(m => Object.assign({}, m, {
            force_name: m.force_type ? Maps.forceName(m.force_type) : '',
            hasRoster: !!store.state.rosters[m.room_id],
            rosterGaps: store.rosterGaps(m.room_id),
            watchedCount: watchMap[String(m.room_id)] || 0
          })));
      }
      if (p === '/mock/counts') return jsonr(store.modeCounts());
      if (p.indexOf('/mock/match/') === 0) {
        const rid = decodeURIComponent(p.slice('/mock/match/'.length));
        const cmp = Analysis.lobby(store, rid);
        if (cmp) cmp.tips = Analysis.matchTips(store, rid) || [];
        return jsonr(cmp);
      }
      if (p.indexOf('/mock/encounter/') === 0) {
        const vid = decodeURIComponent(p.slice('/mock/encounter/'.length));
        return jsonr(Analysis.encounterDetail(store, vid));
      }
      if (p === '/mock/settings') return jsonr(Object.assign({}, store.state.settings, registry.globalSettings));
      if (p === '/mock/backup/info') {
        let list = [], total = 0;
        try {
          /* ★ 名字的判定用 core 那一颗，与桌面 `backup:info` 同一份：这一处以前也自己抄了一遍
           *   紧凑时间戳正则（`data:matches` 那份三份实现的同一个坑）⇒ 修一处忘两处就又是"预览里没有"。 */
          const all = fs.readdirSync(BACKUP_DIR).filter(f => !!StoreMod.parseBackupName(f));
          total = all.length;
          list = all.map(function (f) {
            const st = fs.statSync(path.join(BACKUP_DIR, f));
            const info = StoreMod.parseBackupName(f) || {};
            let sum = { kind: 'unknown' };
            try {
              sum = StoreMod.summarizeBackup(JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf8')));
            } catch (e) { /* 读不动就当认不出里面 */ }
            return { name: f, size: st.size, time: info.at || st.mtimeMs,
              slot: info.slot || '', tag: info.tag || '', at: info.at || 0, sum: sum };
          }).sort((a, b) => b.time - a.time).slice(0, 20);
        } catch (e) { /* dir missing */ }
        return jsonr({ dir: BACKUP_DIR, list: list, count: list.length, total: total,
          keep: registry.globalSettings.backupKeep });
      }
      if (p === '/mock/account/list') {
        return jsonr({ ok: true, activeSlot: registry.activeSlot, accounts: listAccountsView() });
      }
      /* 地图名字典：形状与桌面 ipcMain 'mapNames:status' 一字不差（探针要看的就是这行） */
      if (p === '/mock/mapNames/status') return jsonr(mapNamesStatus());
      if (p === '/mock/mapNames/dict') return jsonr(mapNamesDict());
      /* 在线更新（预览层）：不出网，读本地夹具走同一套 core 判据 */
      if (p === '/mock/update/status') return jsonr(updateStatus());

      const file = path.normalize(path.join(UI, p));
      if (file.startsWith(UI) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        return send(200, MIME[ext] || 'application/octet-stream', fs.readFileSync(file));
      }
      return send(404, 'text/plain; charset=utf-8', 'not found');
    }

    /* -------- POST -------- */
    if (req.method === 'POST') {
      return readBody(req).then(async function (body) {
        try {
          if (p === '/mock/logout') {
            store.state.role = null;
            await store.save();
            return jsonr({ ok: true, slot: registry.activeSlot });
          }
          if (p === '/mock/plugin/list') return jsonr(pluginListViewOf());
          if (p === '/mock/plugin/queue') {
            plugQueued = String((body && body.file) || '');
            return jsonr({ ok: true, queued: plugQueued });
          }
          if (p === '/mock/plugin/inspect') {
            const f = String((body && body.file) || plugQueued || '');
            if (!f) return jsonr({ ok: false, cancelled: true });
            plugQueued = '';
            return jsonr(pluginInspectFile(f));
          }
          if (p === '/mock/plugin/install') {
            const tk = String((body && body.token) || '');
            const hit = plugPreviews.get(tk);
            if (!hit) return jsonr({ ok: false, error: '权限确认已过期，请重新选包' });
            plugPreviews.delete(tk);
            const r = pluginHostOf().install(hit.preview, {
              acceptedScopes: Array.isArray(body.acceptedScopes) ? body.acceptedScopes : [],
              source: hit.source
            });
            return jsonr(r.ok ? { ok: true, plugin: pluginViewOf(r.plugin), list: pluginListViewOf() }
                              : { ok: false, error: r.message });
          }
          if (p === '/mock/plugin/setEnabled') {
            const b = body || {};
            const r = pluginHostOf().setEnabled(String(b.id || ''), !!b.on);
            if (!b.on && plugApi) plugApi.abortAll(String(b.id || ''));
            return jsonr(r.ok ? { ok: true, plugin: pluginViewOf(r.plugin), list: pluginListViewOf() }
                              : { ok: false, error: r.message, list: pluginListViewOf() });
          }
          if (p === '/mock/plugin/remove') {
            const rid = String((body || {}).id || '');
            if (plugApi) plugApi.abortAll(rid);
            const r = pluginHostOf().remove(rid);
            return jsonr(r.ok ? { ok: true, list: pluginListViewOf() } : { ok: false, error: r.message });
          }
          if (p === '/mock/plugin/verify') {
            const r = pluginHostOf().verifyFiles(String((body || {}).id || ''));
            return jsonr({ ok: !!r.ok, message: r.message || '' });
          }
          if (p === '/mock/plugin/page') {
            const r = pluginHostOf().pageAssets(String((body || {}).id || ''));
            if (!r.ok) return jsonr({ ok: false, error: r.message, baseCss: PLUGIN_BASE_CSS });
            if (r.hash.html !== r.hash.declared[0] || r.hash.script !== r.hash.declared[1]) {
              return jsonr({ ok: false, error: '插件内容与登记哈希不一致，已拒绝加载', baseCss: PLUGIN_BASE_CSS });
            }
            return jsonr({
              ok: true, plugin: r.plugin, html: r.html, script: r.script,
              baseCss: PLUGIN_BASE_CSS, hostVersion: Plg.HOST_VERSION
            });
          }
          /* ★ 外发确认：与 shell/main.js 的 plugin:consent 同一条路径，撤销同样清 cookie 罐 */
          if (p === '/mock/plugin/consent') {
            const b = body || {};
            const id = String(b.id || '');
            const host = pluginHostOf();
            const r = b.revoke ? host.revokeConsent(id) : host.grantConsent(id, String(b.sentence || ''));
            if (!r.ok) return jsonr({ ok: false, error: r.message, list: pluginListViewOf() });
            if (b.revoke) { host.cookieWrite(id, {}); if (plugApi) plugApi.abortAll(id); }
            return jsonr({ ok: true, plugin: r.plugin, list: pluginListViewOf() });
          }
          if (p === '/mock/plugin/call') {
            const b = body || {};
            return jsonr(await pluginApiOf().dispatch(String(b.pluginId || ''), String(b.method || ''), b.args || {}));
          }
          /* 主进程用 webContents.send 推事件，预览里只能让浏览器来取：取走即清，语义与宿主一致 */
          if (p === '/mock/plugin/events') {
            const out = plugEvents.splice(0, plugEvents.length);
            return jsonr({ ok: true, events: out });
          }

          if (p === '/mock/sync') {
            notePluginTriggers({
              at: Date.now(), slot: registry.activeSlot, inserted: 0,
              matches: Object.keys(store.state.matches).length
            });
            return jsonr({ ok: true, inserted: 0, duplicates: Object.keys(store.state.matches).length,
              players: 0, errors: [], slot: registry.activeSlot,
              missingRosters: Object.keys(store.state.matches).filter(k => !store.state.rosters[k]).length });
          }
          if (p === '/mock/flag') {
            const key = body && body.key;
            if (key !== 'commander' && key !== 'excluded' && key !== 'competition') {
              return jsonr({ ok: false, error: '未知的标记类型' });
            }
            return jsonr(await store.setMatchFlag(body.roomId, key, body.on));
          }
          /* 关注同场玩家：与 data:watch 同样的第二道 key 校验 */
          if (p === '/mock/watch') {
            const wk = String((body && body.key) || '');
            if (!/^(id|nm):/.test(wk)) {
              return jsonr({
                ok: false,
                error: wk.indexOf('slot:') === 0
                  ? '这个人的账号标识是当局临时编号，无法跨局识别，不能关注'
                  : '无法识别的玩家标识'
              });
            }
            return jsonr(await store.setWatch(wk, body.on, {
              openid: (body && body.openid) || '', name: (body && body.name) || ''
            }));
          }
          /* 预览环境自己不会漏数据，所以给自检留一个注入窗口的口子：
             注入两轮互不相交的窗口，才能真的把「疑似漏采」那条分支跑出来 */
          if (p === '/mock/sync-window') {
            return jsonr(await store.recordSyncWindow({
              at: Number(body && body.at) || Date.now(),
              oldest: Number(body && body.oldest) || 0,
              newest: Number(body && body.newest) || 0,
              count: Number(body && body.count) || 36,
              inserted: Number(body && body.inserted) || 0,
              /* 翻页自证那几个字段（pages/rows/kept/stop/stopText）也从体里透传：
                 探针要能把「数据完整度」里那一行真的画出来，光靠 core 单测不算界面验过 */
              trace: (body && body.trace) || null
            }));
          }
          if (p === '/mock/settings') {
            const gk = ['theme', 'backupDir', 'backupKeep', 'autoBackup'];
            const g = {}, a = {};
            Object.keys(body || {}).forEach(k => (gk.indexOf(k) !== -1 ? g : a)[k] = body[k]);
            Object.assign(registry.globalSettings, g);
            saveRegistry();
            await store.setSettings(a);
            return jsonr({ ok: true, settings: Object.assign({}, store.state.settings, registry.globalSettings) });
          }
          if (p === '/mock/reset') {
            const scope = (body && body.scope) || 'current';
            if (scope === 'all') {
              registry.stores.forEach(function (s, slot) {
                try { fs.unlinkSync(slotFile(slot)); } catch (e) {}
              });
              registry.stores.clear();
              try { fs.unlinkSync(ACCOUNTS_FILE); } catch (e) {}
              registry.accounts = [];
              registry.activeSlot = '';
              return jsonr({ ok: true, scope: 'all' });
            }
            await store.reset();
            return jsonr({ ok: true, scope: 'current', slot: registry.activeSlot });
          }
          if (p === '/mock/backup/now') {
            try {
              fs.mkdirSync(BACKUP_DIR, { recursive: true });
              const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
              const made = [];
              registry.accounts.forEach(function (a) {
                const src = slotFile(a.slot);
                if (!fs.existsSync(src)) return;
                const name = 'df-swtwr-' + a.slot + '-manual-' + stamp + '.json';
                fs.copyFileSync(src, path.join(BACKUP_DIR, name));
                made.push(name);
              });
              saveRegistry();
              const aname = 'df-swtwr-accounts-manual-' + stamp + '.json';
              fs.copyFileSync(ACCOUNTS_FILE, path.join(BACKUP_DIR, aname));
              made.push(aname);
              return jsonr({ ok: true, dir: BACKUP_DIR, files: made, count: made.length });
            } catch (e) {
              return jsonr({ ok: false, error: String((e && e.message) || e) });
            }
          }
          if (p === '/mock/backup/open') {
            return jsonr({ ok: true, dir: BACKUP_DIR, note: '预览模式：请手动打开 ' + BACKUP_DIR });
          }
          if (p === '/mock/backup/choose-dir') {
            return jsonr({ ok: false, cancelled: true, note: '预览模式：桌面版会弹出目录选择器' });
          }
          if (p === '/mock/open-folder') {
            return jsonr({ ok: true, note: '预览模式：账号目录 ' + TMP });
          }
          if (p === '/mock/bundle') {
            return jsonr({ ok: false, cancelled: true,
              note: '预览模式：桌面版会弹出保存对话框（' +
                Object.keys(store.state.matches).length + ' 场 / ' +
                Object.keys(store.state.rosters).length + ' 份名单）' });
          }
          if (p === '/mock/restore') {
            return jsonr({ ok: false, cancelled: true, note: '预览模式：桌面版会弹出文件选择器' });
          }
          if (p === '/mock/export') {
            return jsonr({ ok: false, cancelled: true, note: '预览模式：桌面版会弹出保存对话框' });
          }

          /* ---- 账号 ---- */
          if (p === '/mock/account/add') {
            let n = 1;
            while (registry.accounts.some(a => a.slot === 'a' + n)) n++;
            const slot = 'a' + n;
            registry.accounts.push({
              slot: slot, openid: 'preview-openid-' + slot, name: '新账号 ' + slot,
              area: 36, partition: 'persist:wegame-slot-' + slot,
              created_at: Date.now(), last_sync: 0
            });
            const ns = makeStore(slot); await ns.load();
            saveRegistry();
            return jsonr({ ok: true, slot: slot, note: '预览模式：直接创建空 slot ' + slot });
          }
          if (p === '/mock/account/switch') {
            const slot = body && body.slot;
            if (!registry.stores.has(slot)) return jsonr({ ok: false, error: 'slot 不存在：' + slot });
            registry.activeSlot = slot;
            saveRegistry();
            return jsonr({ ok: true, slot: slot });
          }
          if (p === '/mock/account/logout') {
            const s = currentStore();
            s.state.role = null;
            await s.save();
            return jsonr({ ok: true, slot: registry.activeSlot });
          }
          if (p === '/mock/account/remove') {
            const slot = body && body.slot;
            if (!slot) return jsonr({ ok: false, error: '未指定 slot' });
            if (registry.accounts.length <= 1) {
              return jsonr({ ok: false, error: '至少保留一个账号' });
            }
            const i = registry.accounts.findIndex(a => a.slot === slot);
            if (i === -1) return jsonr({ ok: false, error: 'slot 不存在' });
            registry.accounts.splice(i, 1);
            if (registry.stores.has(slot)) {
              try { fs.unlinkSync(slotFile(slot)); } catch (e) {}
              registry.stores.delete(slot);
            }
            if (registry.activeSlot === slot) {
              registry.activeSlot = registry.accounts[0].slot;
            }
            saveRegistry();
            return jsonr({ ok: true, removed: slot, activeSlot: registry.activeSlot });
          }
          if (p === '/mock/account/global-settings') {
            const gk = ['theme', 'backupDir', 'backupKeep', 'autoBackup'];
            const out = {};
            Object.keys(body || {}).forEach(k => { if (gk.indexOf(k) !== -1) out[k] = body[k]; });
            Object.assign(registry.globalSettings, out);
            saveRegistry();
            return jsonr({ ok: true, globalSettings: registry.globalSettings });
          }
          /* 设置页那颗「更新地图名」：预览层拿夹具冒充一发，不发真网络 */
          if (p === '/mock/mapNames/refresh') return jsonr(await mapNamesPull());
          /* 就地改名 / 还原（#92）：与桌面 ipcMain 'mapNames:setName' 同一形状，只写本机 */
          if (p === '/mock/mapNames/setName') return jsonr(await mapNamesSet(body && body.id, body && body.name));
          /* 在线更新（预览层）：不出网 —— 读 test/fixtures/update-sample.json 冒充服务器，
           * 但 parse / plan 走的是与桌面、安卓同一份 core/update.js。*/
          if (p === '/mock/update/check') return jsonr(await updateCheck());
          if (p === '/mock/update/openDownload') {
            return jsonr({ ok: !!Update.cleanUrl((body && body.url) || ''), preview: true });
          }

        } catch (e) {
          return jsonr({ ok: false, error: String((e && e.message) || e) });
        }
        return send(404, 'text/plain; charset=utf-8', 'not found');
      });
    }

    send(405, 'text/plain; charset=utf-8', 'method not allowed');
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log('[预览] http://127.0.0.1:' + PORT + '/');
    console.log('[预览] 账号目录 ' + TMP);
    console.log('[预览] 活动 slot ' + registry.activeSlot +
      '，样本：胜者为王 ' + currentStore().matches({ mode: 'swtwr' }).length +
      ' 场，名单 ' + currentStore().stats().rosters + ' 份');
  });
})().catch(e => { console.error(e); process.exit(1); });
