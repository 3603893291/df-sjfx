'use strict';
/* ============================================================
 * main.js — Electron 主进程
 * 职责：窗口管理 · 登录窗口 · 采集调度 · 数据读写 · IPC · 多账号
 * 业务逻辑一律委托给 core/ 下的纯 JS 模块
 *
 * 多账号：
 *   userData/
 *     accounts.json                ← 全局账号注册表 + 全局设置（主题/备份目录/保留份数）
 *     df-swtwr-<slot>.json         ← 每个 slot 独立的 store 数据
 *     df-swtwr-data.v1.bak.<ts>.json ← v1 迁移后归档
 *     ai-config.json               ← 旧版本遗留（v1.7.0 起宿主不再内置 AI；只由 plugin-channels 读一次后归档）
 *     plugins/                     ← 用户自行导入的扩展插件（出厂时这个目录不存在）
 *     plugin-data/                 ← 插件私有数据（全部 0600，且刻意不带 df-swtwr- 前缀 → 不进备份）
 *       <id>.json / <id>.secret.json ← 插件配置与密钥分两存：kv.get() 不带 key 时摸不到密钥层
 *       <id>.cookies.json          ← 宿主代管的插件会话 Cookie，插件的 kv 读不到
 *       triggers.json              ← 「同步记一笔」待办账本（页面取走即清零）
 *     Partitions/wegame-slot-<slot>/ ← Electron 会话目录，slot 编号一经写入不可改名
 *
 * ★ doBackup 会把每个 df-swtwr-<slot>.json 和 accounts.json 原样复制到用户自选的备份目录，
 *   所以任何秘密都不许放进 store.state.settings / accounts.globalSettings —— 否则会跟着每日备份外流。
 *   plugins/ 与 plugin-data/（插件配置、会话 Cookie）压根不在复制名单里，因此天然不外流。
 * ============================================================ */
const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const { createFileStore } = require('./adapters/store-node');
const { createNetAdapter, CHROME_UA, ORIGIN } = require('./adapters/net');
/* 出网只有两层地板：① adapters/net —— 采集，带着这个号的 WeGame 登录态，域名钉死在 ORIGIN；
 * ② adapters/plugin-net —— 其余一切（插件外发、地图名配置表），只认 https/标准端口、逐跳重校验、
 *   有字节与超时上限，且**永远碰不到 ①**：登录态活在 session 分区里，不在这些罐子里。
 * 这里不再有 ./adapters/ai：服务商协议与词汇一律留在用户自己导入的插件包里。 */
const PluginNet = require('./adapters/plugin-net');

const Maps = require('../core/maps');
const MapConfig = require('../core/mapConfig');
const Normalize = require('../core/normalize');
const Async = require('../core/async');
const StoreMod = require('../core/store');
const CollectorMod = require('../core/collector');
const Analysis = require('../core/analysis');
const Plg = require('../core/plugin');

const Update = require('../core/update');
const { PluginHost } = require('./plugins');
const Channels = require('./plugin-channels');
const { createPluginApi } = require('./plugin-api');

const WEGAME_HOME = ORIGIN + '/helper/df/score/';
const LEGACY_DATA_NAME = 'df-swtwr-data.json';

/* 外部信息一律写死在主进程，渲染层只能按名字触发，避免任意外链被注入主窗口 */
const GITHUB_URL = 'https://github.com/3603893291/';
const QQ_GROUP = '129994517';
/* 地图沙盘换到这一家（他 2026-09-29 点名要换成 https://aeuicey.github.io/DeltaForce-TacticalPanel/ ）。
 * 它是 GitHub Pages 上的一份静态站：没有登录、没有 cookie，弹出的那一块宣传遮罩由下面 SANDBOX_CSS 隐藏。 */
const SANDBOX_URL = 'https://aeuicey.github.io/DeltaForce-TacticalPanel/';
/* 对方站点每次进来先压一块「欢迎使用…QQ 群 1104802274」的全屏遮罩，地图在它后面（他要求去掉）。
 * 这是第三方站点：我们不改它一个字、不注入脚本、不拦它的请求 —— 只往自己这块 webContents 里
 * 加一条 CSS，把那一层遮罩藏掉（insertCSS 是宿主侧 API，跨源也管得住）。
 * 选择器 2026-09-29 从对方 main-VXHv6ki3.js 里定位：startup-notice-backdrop / -dialog / -enter。
 * ★ 哪天对方改了类名，最坏结果只是"弹窗又回来了"，不会把地图弄坏 —— 要改的就是这一颗常量。 */
const SANDBOX_CSS = '.startup-notice-backdrop,.startup-notice-dialog{display:none!important}';

/* 单实例：两个实例会各自载入同一个 df-swtwr-<slot>.json，保存时后者直接覆盖前者，
 * 刚同步到的场次会静默丢失。抢不到锁就直接退出。 */
if (!app.requestSingleInstanceLock()) {
  console.log('[启动] 已有实例在运行，本次退出');
  app.exit(0);
}

/* ---------------- 全局可变状态 ---------------- */
let mainWin = null;
let loginWin = null;
let loginPoller = null;

/* accounts 注册表：{version, activeSlot, globalSettings, accounts:[{slot,openid,name,area,created_at,last_sync,partition}]} */
let accounts = { version: 2, activeSlot: '', globalSettings: defaultGlobalSettings(), accounts: [] };

/* slot -> {slot, store, session, collector, account} */
const slots = new Map();

/* 当前活动 slot 的 store/collector/session 快捷引用：IPC handler 与 runSync 都读这三个变量。
 * switchTo() 会在切号时重新绑定。 */
let store = null;
let collector = null;
let wegameSession = null;

function defaultGlobalSettings() {
  return {
    theme: 'system',
    backupDir: '',
    backupKeep: 7,
    autoBackup: true
  };
}

/* ---------------- 数据路径 ---------------- */
function userDataDir() { return app.getPath('userData'); }
function accountsFile() { return path.join(userDataDir(), 'accounts.json'); }
function legacyDataFile() { return path.join(userDataDir(), LEGACY_DATA_NAME); }
function dataFileFor(slot) { return path.join(userDataDir(), 'df-swtwr-' + slot + '.json'); }
function partitionFor(slot) { return 'persist:wegame-slot-' + slot; }

/* 一个号的会话罐子记在它的注册表记录上（`acc.partition`），**不是**按 slot 现算 ——
 * ★ 因为"这一罐里刚刚扫进来的是谁"要等到登录成功那一刻才知道：为 a1 开的窗口里扫了 B 号，
 *   这一罐装的就是 B 的会话。以前按 slot 命名 ⇒ B 的会话留在 a1 名下，两头同时错：
 *   切回 a1 点同步会把 B 的场次写进 a1 的库（两个号混成一堆，再也分不开），
 *   而 B 自己那个号点同步是空的。`handoffSession()` 就是"罐子跟人走"那一手。 */
function acctOfSlot(slot) {
  for (let i = 0; i < accounts.accounts.length; i++) {
    if (accounts.accounts[i].slot === slot) return accounts.accounts[i];
  }
  return null;
}
function jarOf(slot) {
  const a = acctOfSlot(slot);
  return (a && a.partition) || partitionFor(slot);
}
function currentDataFile() {
  return store ? (store._filePath || dataFileFor(accounts.activeSlot)) : legacyDataFile();
}

/* ---------------- accounts.json 读写 ---------------- */
function loadAccountsSync() {
  try {
    const raw = fs.readFileSync(accountsFile(), 'utf8');
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.accounts)) {
      accounts = Object.assign({ version: 2, activeSlot: '', globalSettings: defaultGlobalSettings(), accounts: [] }, j);
      accounts.globalSettings = Object.assign(defaultGlobalSettings(), j.globalSettings || {});
      return true;
    }
  } catch (e) { /* 不存在或损坏 → 视为未初始化 */ }
  return false;
}

function saveAccountsSync() {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    fs.writeFileSync(accountsFile(), JSON.stringify(accounts, null, 1), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------------- 插件通道（编排见 shell/plugin-channels.js） ----------------
 * 摘要是宿主自己算的，旧数据是一次性交出去的 —— 两件事的算法与顺序都在那个文件里，
 * 这里只把它们接到当前的 store / userDataDir 上，另外加上「同步后记一笔待办」。
 * ★ 自动日报的形态是用户定过的：宿主绝不自己跑插件代码。要出报告，得有人把那一页打开、
 *   看见「同步之后你还没看过」并且亲手点下去。
 */
let _digestChannel = null, _legacyChannel = null;
function digestChannel() {
  if (!_digestChannel) _digestChannel = Channels.createDigestChannel({ getStore: function () { return store; } });
  return _digestChannel;
}
function legacyChannel() {
  if (!_legacyChannel) _legacyChannel = Channels.createLegacyChannel({
    getStore: function () { return store; }, userDataDir: userDataDir
  });
  return _legacyChannel;
}

/* 同步收尾：只往 plugin-data/triggers.json 记一笔，不发任何东西、也不 await */
function notePluginTriggers(info) {
  let host = null, list = [];
  try { host = plugins(); list = host.list(); } catch (e) { return; }
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

/* ---------------- v1 → v2 迁移 ----------------
 * 若 accounts.json 不存在但 legacy df-swtwr-data.json 存在，
 * 按 rosters[room_id].players 中 vopenid === meta.openid 反查归属，
 * 把所有 match/roster/season 搬到 slot='a1' 的新文件；openid 未知或无 roster 命中的整包 → slot='legacy'。
 * 幂等：accounts.json 已存在则直接 skip；legacy 文件改名成 .v1.bak.<ts>.json。
 */
function migrateV1IfNeeded() {
  const report = { ran: false, targetSlot: '', legacySlot: '', moved: 0, orphan: 0, message: '' };
  if (fs.existsSync(accountsFile())) { report.message = 'accounts.json 已存在，跳过迁移'; return report; }
  if (!fs.existsSync(legacyDataFile())) {
    accounts = { version: 2, activeSlot: '', globalSettings: defaultGlobalSettings(), accounts: [] };
    saveAccountsSync();
    report.message = '无 v1 数据，已初始化空 accounts.json';
    return report;
  }
  let v1;
  try {
    v1 = JSON.parse(fs.readFileSync(legacyDataFile(), 'utf8'));
  } catch (e) {
    report.message = 'v1 数据文件解析失败：' + ((e && e.message) || e) + '，请手工处理 ' + legacyDataFile();
    return report;
  }
  const meta = (v1 && v1.meta) || {};
  const openid = String(meta.openid || '');
  const targetSlot = 'a1';
  report.ran = true;
  report.targetSlot = targetSlot;

  // 反查：matches 里凡是 roster 中存在 vopenid === openid 的 → 归属当前 openid
  // 若无 openid（未登录过）或无 roster 命中，全部作为 orphan 归到 legacy slot
  const matches = (v1.matches || {});
  const rosters = (v1.rosters || {});
  const belongsToMe = {};
  if (openid) {
    Object.keys(rosters).forEach(function (rid) {
      const r = rosters[rid];
      if (!r || !Array.isArray(r.players)) return;
      if (r.players.some(function (p) { return String(p.vopenid || '') === openid; })) {
        belongsToMe[rid] = true;
      }
    });
  }
  const mine = {}, orphan = {};
  Object.keys(matches).forEach(function (rid) {
    const m = matches[rid];
    // roster 命中或该场没有 roster → 若 openid 存在，一律归当前号（v1 时代只可能有一个号）
    if (openid) mine[rid] = m; else orphan[rid] = m;
  });
  const myRosters = {}, orphanRosters = {};
  Object.keys(rosters).forEach(function (rid) {
    if (openid) myRosters[rid] = rosters[rid]; else orphanRosters[rid] = rosters[rid];
  });

  function writeSlotFile(slot, payload) {
    const p = dataFileFor(slot);
    const body = Object.assign({
      version: 1,
      meta: payload.meta || { openid: '', name: '', area: 36, last_sync: 0, first_seen: 0 },
      role: payload.role || null,
      seasons: payload.seasons || {},
      matches: payload.matches || {},
      rosters: payload.rosters || {},
      settings: payload.settings || StoreMod.defaultState().settings
    });
    fs.writeFileSync(p, JSON.stringify(body, null, 1), 'utf8');
  }

  const v1Settings = Object.assign(StoreMod.defaultState().settings, v1.settings || {});
  const globalKeys = ['theme', 'backupDir', 'backupKeep', 'autoBackup'];
  globalKeys.forEach(function (k) {
    if (v1Settings[k] !== undefined) accounts.globalSettings[k] = v1Settings[k];
  });
  const accountKeys = ['autoSyncDetail', 'detailScope', 'autoSyncInterval', 'syncPages', 'syncPageDelayMs'];
  const slotSettings = {};
  accountKeys.forEach(function (k) { slotSettings[k] = v1Settings[k]; });

  writeSlotFile(targetSlot, {
    meta: meta, role: v1.role || null, seasons: v1.seasons || {},
    matches: mine, rosters: myRosters, settings: slotSettings
  });
  accounts.accounts.push({
    slot: targetSlot,
    openid: openid,
    name: meta.name || '',
    area: meta.area || 36,
    partition: partitionFor(targetSlot),
    created_at: meta.first_seen || Date.now(),
    last_sync: meta.last_sync || 0
  });
  accounts.activeSlot = targetSlot;
  report.moved = Object.keys(mine).length;

  if (Object.keys(orphan).length) {
    const legacySlot = 'legacy';
    writeSlotFile(legacySlot, {
      meta: { openid: '', name: '', area: 36, last_sync: meta.last_sync || 0, first_seen: Date.now() },
      seasons: {}, matches: orphan, rosters: orphanRosters, settings: slotSettings
    });
    accounts.accounts.push({
      slot: legacySlot, openid: '', name: '（未识别）', area: 36,
      partition: partitionFor(legacySlot), created_at: Date.now(), last_sync: 0
    });
    report.legacySlot = legacySlot;
    report.orphan = Object.keys(orphan).length;
  }

  saveAccountsSync();

  // 归档 legacy 文件：只改名不删
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const bak = path.join(userDataDir(), 'df-swtwr-data.v1.bak.' + stamp + '.json');
  try { fs.renameSync(legacyDataFile(), bak); } catch (e) { /* ignore */ }

  // 迁移报告
  try {
    const lines = [
      'v1 → v2 数据迁移报告',
      '生成时间: ' + new Date().toISOString(),
      '',
      '归档原文件: ' + bak,
      '账号数: ' + accounts.accounts.length,
      ''
    ];
    accounts.accounts.forEach(function (a) {
      const file = dataFileFor(a.slot);
      let mc = 0, rc = 0;
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        mc = Object.keys(j.matches || {}).length;
        rc = Object.keys(j.rosters || {}).length;
      } catch (e) { /* ignore */ }
      lines.push('  slot=' + a.slot + ' openid=' + (a.openid || '(空)') +
        ' name=' + (a.name || '(空)') + ' matches=' + mc + ' rosters=' + rc);
    });
    fs.writeFileSync(path.join(userDataDir(), 'migration-report.txt'), lines.join('\n'), 'utf8');
  } catch (e) { /* ignore */ }

  report.message = '已迁移。原文件归档为 ' + path.basename(bak);
  return report;
}

/* ---------------- v1 登录态继承 ----------------
 * v1 的 WeGame 会话在 Partitions/wegame，v2 每个 slot 用 Partitions/wegame-slot-<slot>。
 * 不搬过去的话，老用户升级后「数据在、登录没了」，还得重新扫码。
 * 干净升级路径上本函数先于 ensureSlot() 运行，目标分区目录还不存在 → 整棵树拷过去。
 * 若目标目录已有内容（Electron 一旦绑定分区就会建目录并写出空的 Cookies，
 * 所以「有 Cookies」不等于「已登录」），一律跳过，绝不覆盖已有会话。
 */
function copyTreeMissing(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.lstatSync(s);
    if (st.isDirectory()) { n += copyTreeMissing(s, d); }
    else if (!fs.existsSync(d)) { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

function dirHasContent(d) {
  try { return fs.readdirSync(d).length > 0; } catch (e) { return false; }
}

function adoptLegacySession(slot) {
  const out = { ran: false, files: 0, message: '' };
  if (!slot) { out.message = '无活动 slot，跳过登录态继承'; return out; }
  const partRoot = path.join(userDataDir(), 'Partitions');
  const legacy = path.join(partRoot, 'wegame');
  const target = path.join(partRoot, 'wegame-slot-' + slot);
  if (!fs.existsSync(legacy)) { out.message = '无 v1 会话目录，跳过'; return out; }
  if (dirHasContent(target)) {
    out.message = 'slot ' + slot + ' 分区已存在，跳过';
    return out;
  }
  try {
    out.files = copyTreeMissing(legacy, target);
    out.ran = true;
    out.message = '已把 v1 登录态继承到 slot ' + slot + '（' + out.files + ' 个文件）';
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      fs.renameSync(legacy, legacy + '.v1.bak.' + stamp);
    } catch (e) { /* 改名失败不影响本次继承 */ }
  } catch (e) {
    out.message = '继承登录态失败：' + ((e && e.message) || e);
  }
  try {
    const rep = path.join(userDataDir(), 'migration-report.txt');
    if (fs.existsSync(rep)) fs.appendFileSync(rep, '\n登录态: ' + out.message, 'utf8');
  } catch (e) { /* ignore */ }
  return out;
}

/* ---------------- slot 实例化 ---------------- */
function ensureSlot(slot) {
  if (!slot) return null;
  if (slots.has(slot)) return slots.get(slot);
  const acc = accounts.accounts.filter(function (a) { return a.slot === slot; })[0];
  if (!acc) return null;
  const s = new StoreMod.Store(createFileStore(dataFileFor(slot)));
  s._filePath = dataFileFor(slot);
  const session = require('electron').session.fromPartition(jarOf(slot));
  session.setUserAgent(CHROME_UA);
  const net = createNetAdapter(session);
  const col = new CollectorMod.Collector(net);
  /* 这个号当初是按哪套账号体系登进来的（1=QQ / 2=微信）：恢复时一并带回来，
   * 不然微信号一重启就退回 1，每发请求官方都认不到这个人。老记录没这枚值时仍是 1。 */
  col.setAccountType(acc.accountType);
  const inst = { slot: slot, store: s, session: session, collector: col, account: acc };
  slots.set(slot, inst);
  return inst;
}

function switchTo(slot) {
  const inst = ensureSlot(slot);
  if (!inst) return Promise.resolve({ ok: false, error: '账号不存在：' + slot });
  accounts.activeSlot = slot;
  store = inst.store;
  collector = inst.collector;
  wegameSession = inst.session;
  saveAccountsSync();
  let loadFault = null;
  return inst.store.load().then(function () { return null; },
    /* ★ 读不出来 ≠ 这个号不存在：号照旧切过去，但把原因一路带回去让界面说实话。
     *   这一步绝不能"当成没数据"就走完 —— core 那道写闸（Store.prototype.save 里的 _loadFault）
     *   此时已经合上，随后任何一次 save() 都会被拒，真库不会被一份空的盖掉。 */
    function (e) { return String((e && e.message) || e); }
  ).then(function (lf) {
    /* ★ 这一枚必须提到外层：以前它是这颗回调的形参，而最后那个回包（下面 loadFault || ''）在
     *   **另一颗回调**里读它 —— 作用域够不着 ⇒ 每次换号都在最后一步抛 ReferenceError，
     *   界面收到的是"切换失败"，号其实已经切过去了。2026-10-04 真 Electron 端到端跑出来的。 */
    loadFault = lf;
    /* 关注表里指向「全部名单再也找不到的人」的脏键就地清掉（导入外部包、换过昵称都可能留下）。
     * 这一步要扫全量名单，所以只在载入时做一次，绝不放进 prune；失败也不该挡住进账号。
     * ★ 没读成功过就跳过：手里是 defaultState()，回收算出来的"找不到了"全是假的。 */
    if (!loadFault) {
      try {
        const gc = inst.store.gcPeople(Analysis.buildIdentityIndex(inst.store).groups);
        if (gc.changed) return inst.store.save().catch(function () { /* 清不掉无所谓 */ });
      } catch (e) { /* 数据异常时跳过回收 */ }
    }
  }).then(function () {
    scheduleAutoSync();
    emit('account:changed', {
      slot: slot,
      openid: inst.store.state.meta.openid,
      name: inst.store.state.meta.name
    });
    return { ok: true, slot: slot, loadFault: loadFault || '' };
  });
}

function findSlotByOpenid(openid) {
  openid = String(openid || '');
  for (let i = 0; i < accounts.accounts.length; i++) {
    if (accounts.accounts[i].openid === openid && openid) return accounts.accounts[i].slot;
  }
  return '';
}

/* 登录成功后调用：
 * - 若 openid 已注册 → 直接把 last_sync 更新
 * - 若是新号 → 分配下一个 aN slot，落 accounts.json
 * 返回 {slot, isNew}
 */
function bindLogin(openid, name, area, accountType) {
  let slot = findSlotByOpenid(openid);
  let isNew = false;
  /* 登录探测定下来的那套账号体系（1=QQ / 2=微信）要跟着这个号落盘：
   * 采集的每一发都按它问，写死 1 就是"微信用户明明登录了却什么都拿不到"。 */
  const acctType = Number(accountType) === 2 ? 2 : 1;
  if (!slot) {
    /* 当前槽还没登记过任何身份（刚点开一扇登录窗）⇒ 这个身份就归它，不去新开一个槽：
     * 场次已经落在这一槽的库里，注册表却登记到另一槽名下，那是把一次登录劈成两半。
     * （安卓那一侧 bindLogin 的"归属优先 + 认领 slotWanted"同一手，桌面以前缺这一半。） */
    const cur = acctOfSlot(accounts.activeSlot);
    if (cur && !cur.openid) slot = cur.slot;
  }
  if (!slot) {
    let n = 1;
    while (accounts.accounts.some(function (a) { return a.slot === 'a' + n; })) n++;
    slot = 'a' + n;
    accounts.accounts.push({
      slot: slot, openid: String(openid || ''), name: name || '', area: area || 36,
      accountType: acctType,
      partition: partitionFor(slot), created_at: Date.now(), last_sync: Date.now()
    });
    isNew = true;
  } else {
    accounts.accounts.forEach(function (a) {
      if (a.slot === slot) {
        /* 认领来的槽（上面那条 `!cur.openid`） openid 是空的：不补上，下一次这个人再登录
         * 又走一遍"找不到归属 ⇒ 新开一个槽"，一个人就变成两条记录、两份库。 */
        if (!a.openid) a.openid = String(openid || '');
        a.name = name || a.name;
        a.area = area || a.area;
        a.accountType = acctType;
        a.last_sync = Date.now();
        /* 真登录落到这个号上了：它不再是"只读的导入号" */
        if (a.imported) delete a.imported;
      }
    });
  }
  if (slots.has(slot)) slots.get(slot).collector.setAccountType(acctType);
  saveAccountsSync();
  return { slot: slot, isNew: isNew, accountType: acctType };
}

function nextFreeSlot() {
  let n = 1;
  while (accounts.accounts.some(function (a) { return a.slot === 'a' + n; })) n++;
  return 'a' + n;
}

/* ★ 罐子跟人走（2026-09-26，"换号后读的还是旧号"的正面修法）。
 * 一扇登录窗开的时候只能按 slot 挑罐子，可"扫进来的是谁"要等官方回角色才知道：
 * 为 a1 开的窗里扫了 B 号 ⇒ B 的会话此刻在 a1 的罐子里。这时候两条都是错的：
 *   拿 a1 继续用 → 以后每次同步都把 B 的场次写进 a1（小号的库），两个号混成一堆；
 *   只把界面切到 B → B 自己的罐子是空的，点同步就是"未登录"，看着像换了个寂寞。
 * 所以：把**这一罐**改挂到 B 名下（`partition` 是注册表里的字段，改指针不搬数据），
 * 再给 a1 换一枚全新的空罐 —— a1 下次要同步就得重新授权，那是官方单点互踢本来的样子。
 * 参数是**罐子的名字**而不是 fromSlot：开窗时那枚 slot 可能只是预留、还没登记进注册表，按记录去找会扑空。
 * 返回 { moved, to, jar, displaced }。 */
function handoffSession(jarName, toSlot) {
  const to = acctOfSlot(toSlot);
  if (!jarName || !to) return { moved: false };
  if (to.partition === jarName) return { moved: false };
  const displaced = [];
  accounts.accounts.forEach(function (a) {
    if (a.slot === toSlot) return;
    if ((a.partition || partitionFor(a.slot)) === jarName) {
      /* ★ 被顶掉的那一位必须换一枚**全新空罐**：只把 jar 挂给别人而不给自己换一枚，
       *   两个人就还指着同一罐 ⇒ 串号一点没修掉（这一行是 O3 那根变异针要验的东西）。 */
      a.partition = partitionFor(a.slot) + '-v' + Date.now();
      displaced.push(a.slot);
    }
  });
  to.partition = jarName;
  /* 已经建出来的实例抱着旧 session/collector：作废掉，下一次 ensureSlot 按新罐子重做。
   * 被顶掉的那一位正是当前号的话，全局 store/collector 也当场摘干净 ——
   * 留着它就是拿 B 的会话去采 A 的库，那正是这条改法要挡的事。 */
  slots.delete(toSlot);
  displaced.forEach(function (s) { slots.delete(s); });
  if (displaced.indexOf(accounts.activeSlot) !== -1) {
    store = null; collector = null; wegameSession = null;
  }
  saveAccountsSync();
  return { moved: true, to: toSlot, jar: jarName, displaced: displaced };
}

/* ---------------- 广播给渲染进程 ---------------- */
function emit(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

/* ---------------- 登录窗口 ----------------
 * ★ 使用者裁定（2026-09-26，把上一轮「桌面刻意不清」那条翻了过来）：**每次打开登录浏览器都是
 * 一次全新会话**。官方 WeGame 隔一阵会自己把账号退掉，罐子里留下的正是那半死会话 —— 网页显示
 * 「无角色信息」、我们两套 account_type 都问不到角色，人就永远卡在登录页（安卓那一侧同一个病根）。
 *
 * 范围（红线盯着，别处一律不许清）：**只清这一个号的持久分区**。桌面是每号一罐（`persist:wegame-slot-<slot>`），
 * 顺手把别的号一起清掉会静悄悄把它们也登出，那不是"打开登录窗这一下"该有的代价。
 * 主界面、同步、切号、启动都不碰这里；设置页「退出登录」和移除账号照旧只清 cookie（那是使用者主动点的）。
 */

/* 这一串名字是在 Electron 33.4.11 上真拿数据落检出来的（`node` 跑不了，见 tools/probe-desktop-session-wipe.js）：
 * `clearStorageData({storages:[…]})` 对**不存在的名字静悄悄忽略**，所以名字不许凭印象写；
 * 尤其 `history` **不是**一个 storage 名字 —— 会话历史在 `webContents.clearHistory()` 上，Session 没这个口子。 */
var LOGIN_WIPE_STORAGES = ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage',
  'shadercache', 'websql', 'serviceworkers', 'cachestorage', 'mediasource'];

function wipeLoginSession(ses, webContents) {
  const failed = [];
  function run(label, fn) {
    let p;
    try { p = Promise.resolve(fn()); }
    catch (e) { return Promise.resolve(failed.push(label + '：' + ((e && e.message) || e))); }
    return p.then(function () { /* 清掉了 */ },
      function (e) { failed.push(label + '：' + ((e && e.message) || e)); });
  }
  return run('清存储', function () {
    return ses.clearStorageData({ storages: LOGIN_WIPE_STORAGES });
  }).then(function () {
    return run('清缓存', function () { return ses.clearCache(); });
  }).then(function () {
    return run('清认证缓存', function () { return ses.clearAuthCache(); });
  }).then(function () {
    if (!webContents || webContents.isDestroyed()) return Promise.resolve();
    return run('清历史', function () { webContents.clearHistory(); });
  }).then(function () {
    return run('落盘', function () { ses.flushStorageData(); });
  }).then(function () {
    return { cleared: failed.length === 0, clearError: failed.join('；') };
  });
}

function openLoginWindow(targetSlot) {
  // 添加新号：给一个尚未注册的 slot，登录后 bindLogin 会写 accounts.json
  const slot = targetSlot || accounts.activeSlot || nextFreeSlot();
  /* ★ 罐子按注册表记录取（不是按 slot 现算）：这个号上一次被 handed-over 到哪儿，窗就开在哪儿。 */
  const partition = jarOf(slot);
  const session = require('electron').session.fromPartition(partition);
  session.setUserAgent(CHROME_UA);
  if (!slots.has(slot)) {
    const s = new StoreMod.Store(createFileStore(dataFileFor(slot)));
    s._filePath = dataFileFor(slot);
    const col = new CollectorMod.Collector(createNetAdapter(session));
    slots.set(slot, { slot: slot, store: s, session: session, collector: col,
      account: { slot: slot, openid: '', name: '', area: 36, partition: partition,
        created_at: Date.now(), last_sync: 0 } });
  }
  const probeCollector = slots.get(slot).collector;
  /* ★ 这一号的库这一版有没有"没读动"的账（闸门在 core：Store.prototype.loadFault）。
   *   界面那句改口读的是回包里的 storageFault，安卓那侧早就给了这枚布尔 ——
   *   桌面不给的话，同一句话在一端响、在一端永远不响，而源码看上去两边都对。 */
  const slotStore = slots.get(slot).store;
  const storageFault = !!(slotStore && slotStore.loadFault && slotStore.loadFault());
  /* ★ 这台采集器是按号长驻的（安卓每开一窗 new 一个探测采集器），所以"连问几轮没角色"的计数
   *   要在开窗这一刻归零：开一窗就是重新等一次授权，上一窗攒下的轮次不该替这一窗说话。 */
  probeCollector.noRoleRounds = 0;

  /* 窗还开着，且就是这一个号的 → 不新建，但同样先清后加载（他要的就是"这页挂了，给我换一扇新的"）。
   * ★ 分区的归属在 `new BrowserWindow` 那一刻就钉死了：拿着 A 的窗去清 B 的罐子，
   *   结果是"清了 B、登录的还是 A"，比不清更坏 —— 所以要换号就得换窗。 */
  if (loginWin && !loginWin.isDestroyed() && loginWin.__dfSlot !== slot) {
    const stale = loginWin;
    loginWin = null;                     // 先摘引用：它 close() 的回调不许把下面新建的那扇判成"自己"
    try { stale.close(); } catch (e) { /* 关不掉也要开新的 */ }
  }
  if (!loginWin || loginWin.isDestroyed()) {
    loginWin = new BrowserWindow({
      width: 1080, height: 760,
      title: '登录 WeGame',
      backgroundColor: '#000000',
      webPreferences: {
        partition: partition,          // 持久化分区：登录态长期保留
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    loginWin.__dfSlot = slot;
    loginWin.setMenuBarVisibility(false);
    loginWin.webContents.setUserAgent(CHROME_UA);
    const win = loginWin;
    loginWin.on('closed', function () {
      /* 只有"我这扇还是当前那扇"时才收摊：换号重建时旧窗的回调晚一步到，
       * 不能把新窗的引用清成 null（那之后新窗就再也关不掉了）。 */
      if (loginWin === win) { loginWin = null; stopLoginWatch(); }
      emit('login:window-closed', { slot: win.__dfSlot });
    });
  } else {
    loginWin.focus();
  }

  /* ★ 顺序是这条裁定的全部意义：**先清罐子，后 loadURL**。
   *   反过来写就等于第一屏还是那个半死会话，清没清都白清（安卓那侧同一条红线：wipeSession 排在 loadUrl 之前）。 */
  return wipeLoginSession(session, loginWin.webContents).then(function (res) {
    loginWin.loadURL(WEGAME_HOME);
    startLoginWatch(probeCollector, partition);
    return { ok: true, slot: slot, cleared: res.cleared, clearError: res.clearError,
      storageFault: storageFault };
  }, function (e) {
    /* 清不干净也要把窗开出来 —— 否则人连重新授权的门都没了，但这一发必须当场说实话 */
    loginWin.loadURL(WEGAME_HOME);
    startLoginWatch(probeCollector, partition);
    return { ok: true, slot: slot, cleared: false, storageFault: storageFault,
      clearError: '清旧登录痕迹这一步没跑成：' + ((e && e.message) || e) };
  });
}

/* 登录成功判定：直接试调官方接口，能拿到玩家资料即视为登录成功。
 * ★ 这里必须**两套账号体系都问**（1=QQ、2=微信）：上一版只按 1 问，
 *   微信登录的人页面明明已经登录、cookie 也落进分区了，却永远等不到回调。
 *   试探只在这个窗口开着的时候跑，回到主界面后一律按落盘那枚值发。 */
function startLoginWatch(probeCollector, openedJar) {
  stopLoginWatch();          // 重复开窗不许叠两张表（每轮现在是两发出网）
  let checking = false;
  loginPoller = setInterval(function () {
    if (checking) return;
    checking = true;
    probeCollector.probeLogin().then(function (r) {
      checking = false;
      /* ★ rounds/advice 是 core 判出来的（连问几轮全 no_role ⇒ 该劝人换号），这里只许照转：
       *   界面不许自己数轮次，否则两端各数各的，桌面改了阈值手机还按旧的说话。 */
      emit('login:probe', { ok: !!r.ok, accountType: r.accountType || 0,
        attempts: r.attempts || [], rounds: r.rounds || 0, advice: r.advice || '',
        message: r.ok ? '' : (r.message || '') });
      if (r.ok) {
        stopLoginWatch();
        const bound = bindLogin(r.role.openid, r.role.name, r.role.area, r.accountType);
        /* ★★ 认出来是谁之后还差两步，缺一步就是他那句「换号后读的还是小号的」：
         *   ① 罐子跟人走（这一罐里的会话属于 bound.slot，不属于开窗时那个 slot）；
         *   ② 当场切过去 —— 以前这里只 bindLogin + emit，全局 store/collector 仍指旧号，
         *      界面 refresh 读的是旧号的库，紧跟着那次 doSync 更是拿新号的会话往旧号的库里写。 */
        const moved = handoffSession(openedJar, bound.slot);
        if (loginWin && !loginWin.isDestroyed()) loginWin.__dfSlot = bound.slot;
        Promise.resolve(switchTo(bound.slot)).then(function (sw) {
          return { loadFault: (sw && sw.loadFault) || '', switched: !!(sw && sw.ok) };
        }, function (e) {
          return { loadFault: '切不过去：' + ((e && e.message) || e), switched: false };
        }).then(function (r2) {
          emit('login:done', { role: r.role, slot: bound.slot, isNew: bound.isNew,
            accountType: bound.accountType, jarMoved: moved.moved,
            loadFault: r2.loadFault, switched: r2.switched });
          if (loginWin && !loginWin.isDestroyed()) loginWin.close();
        });
      }
    }).catch(function (e) {
      /* 连探测本身都抛了（网络断、适配器坏）也要喊出来，不能回到"没反应"那种状态 */
      checking = false;
      emit('login:probe', { ok: false, accountType: 0, attempts: [],
        message: '登录探测出错：' + ((e && e.message) || e) });
    });
  }, 2500);
}

function stopLoginWatch() {
  if (loginPoller) { clearInterval(loginPoller); loginPoller = null; }
}

/* ---------------- 主窗口 ----------------
 * 自检模式：加 --selftest 启动（不弹窗，结果写 JSON 后自动退出）
 * 输出路径可用 --selftest-out=<路径> 指定，默认写到用户数据目录
 */
const SELFTEST = process.argv.includes('--selftest');

function selftestOutPath() {
  const arg = process.argv.find(function (a) { return a.indexOf('--selftest-out=') === 0; });
  if (arg) return arg.slice('--selftest-out='.length);
  return path.join(app.getPath('userData'), 'selftest.json');
}

/* ---------------- 内嵌内容白名单 ----------------
 * 地图沙盘页用了 webviewTag，等于把「渲染层可挂载远程内容」开放出去，
 * 因此所有内嵌内容统一收口到 SANDBOX_URL：挂载时校验 src，导航时再校验一次，
 * guest 弹窗与敏感权限一律拒绝。
 */
function isAllowedEmbed(rawUrl) {
  var u = String(rawUrl || '');
  if (!u || u === 'about:blank') return true;
  return u === SANDBOX_URL || u.indexOf(SANDBOX_URL) === 0;
}

function guardEmbeddedContents() {
  app.on('web-contents-created', function (evt, contents) {
    // 挂载时校验：必须用 will-attach-webview —— did-attach-webview 已经晚了且不可阻止
    contents.on('will-attach-webview', function (e, webPreferences, params) {
      const src = params && params.src;
      // src 允许为空：沙盘页的 <webview> 是懒赋值，首次进入才带上 URL
      if (src && !isAllowedEmbed(src)) {
        console.log('[安全] 拒绝挂载非白名单内嵌内容：' + src);
        e.preventDefault();
        return;
      }
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
    });
    if (contents.getType() !== 'webview') return;

    contents.on('will-navigate', function (e, url) {
      if (!isAllowedEmbed(url)) {
        console.log('[安全] 内嵌内容越界导航已阻止：' + url);
        e.preventDefault();
      }
    });
    contents.on('did-start-navigation', function (e, url, isInPlace, isMainFrame) {
      if (isMainFrame && !isAllowedEmbed(url)) {
        try { contents.stop(); contents.loadURL('about:blank'); } catch (err) {}
      }
    });
    contents.setWindowOpenHandler(function (d) {
      if (isAllowedEmbed(d.url) && d.url !== 'about:blank') shell.openExternal(d.url);
      return { action: 'deny' };
    });
    contents.on('permission-request', function (e) { e.preventDefault(); });
    /* 沙盘那页的第一个弹窗（见上面 SANDBOX_CSS 那段）：只压一条 CSS，不注入脚本。
     * 每次导航都要重注一次 —— insertCSS 不跨页保留，所以挂在 dom-ready 上而不是只来一回的 attach。 */
    contents.on('dom-ready', function () {
      if (!isAllowedEmbed(contents.getURL())) return;
      try {
        const p = contents.insertCSS(SANDBOX_CSS);
        if (p && typeof p.catch === 'function') p.catch(function () { /* 下面这一句已经说了同一件事 */ });
      } catch (e) {
        /* 页面已经销毁 / 对方还在跳转：这一发丢掉就好，绝不把沙盘页弄成「加载失败」 */
      }
    });
  });
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1320, height: 860,
    minWidth: 1080, minHeight: 700,
    title: '全面战场数据分析',
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 地图沙盘要内嵌第三方站点：file:// 下的 <iframe> 属第三方上下文，
      // 对方的 SameSite=Lax 会话 cookie 会被丢，只能用独立 webContents 的 <webview>
      webviewTag: true
    }
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  mainWin.once('ready-to-show', function () {
    if (!SELFTEST) mainWin.show();
  });
  mainWin.on('closed', function () { mainWin = null; });

  if (SELFTEST) runSelfTest();
}

function runSelfTest() {
  const reportPath = selftestOutPath();
  const LIVE_SYNC = process.argv.includes('--live-sync');
  const result = {
    phase: 'started',
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    dataFile: currentDataFile(),
    accountsFile: accountsFile(),
    activeSlot: accounts.activeSlot,
    accountCount: accounts.accounts.length,
    storeLoaded: !!store && !!store.state,
    mapsSwwr: Maps.swtwrIds.length,
    sessionPartition: !!wegameSession
  };
  function write(extra) {
    Object.assign(result, extra || {});
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(result, null, 1), 'utf8');
    } catch (e) {
      result.writeError = String((e && e.message) || e);
    }
  }
  write({ uiPath: path.join(__dirname, '..', 'ui', 'index.html'),
          uiExists: fs.existsSync(path.join(__dirname, '..', 'ui', 'index.html')) });

  /* 退出条件：界面走完 && 登录探针走完 && 实时采集（若开了 --live-sync）结束 */
  let uiDone = false, probeDone = false, livePending = LIVE_SYNC;
  function maybeQuit() {
    if (!uiDone || !probeDone || livePending) return;
    setTimeout(function () { app.quit(); }, 200);
  }
  function finish() {
    uiDone = true;
    write();
    maybeQuit();
  }
  if (LIVE_SYNC) {
    setTimeout(function () { livePending = false; maybeQuit(); }, 240000);
  }
  // 探针卡住也不能永远不退出
  setTimeout(function () { probeDone = true; maybeQuit(); }, LIVE_SYNC ? 30000 : 12000);

  /* QA 探针：拿当前 slot 的真实会话探登录态；--live-sync 时再跑一次完整分页采集 */
  function runLiveSync() {
    const before = Object.keys(store.state.matches || {}).length;
    const t0 = Date.now();
    runSync({ withDetail: true }).then(function (res) {
      write({ liveSync: {
        ok: !!(res && res.ok !== false),
        ms: Date.now() - t0,
        inserted: res && res.inserted, duplicates: res && res.duplicates,
        players: res && res.players,
        errors: ((res && res.errors) || []).slice(0, 6),
        matchesBefore: before,
        matchesAfter: Object.keys(store.state.matches || {}).length,
        swtwr: store.matches({ mode: 'swtwr' }).length,
        commander: store.matches({ mode: 'commander' }).length
      } });
    }).catch(function (e) {
      write({ liveSync: { ok: false, error: String((e && e.message) || e) } });
    }).then(function () {
      livePending = false;
      maybeQuit();
    });
  }

  function probe(round) {
    if (!collector || !store) {
      if (round < 20) { setTimeout(function () { probe(round + 1); }, 500); }
      else {
        write({ loginProbe: { ok: false, message: 'collector/store 未就绪' } });
        probeDone = true;
      }
      return;
    }
    collector.checkLogin().then(function (r) {
      probeDone = true;
      write({ loginProbe: {
        ok: !!r.ok, slot: accounts.activeSlot,
        reason: r.reason || '', message: r.message || '',
        openid: r.role ? r.role.openid : String(store.state.meta.openid || ''),
        matchesStored: Object.keys(store.state.matches || {}).length
      } });
      if (r.ok && LIVE_SYNC) runLiveSync();
      else { livePending = false; maybeQuit(); }
    }).catch(function (e) {
      probeDone = true;
      write({ loginProbe: { ok: false, message: String((e && e.message) || e) } });
      livePending = false;
      maybeQuit();
    });
  }
  setTimeout(function () { probe(0); }, 1200);

  setTimeout(function () {
    if (result.phase === 'started') {
      write({ ok: false, error: 'did-finish-load 超时' });
      setTimeout(function () { app.quit(); }, 200);
    }
  }, LIVE_SYNC ? 30000 : 15000);

  /* 出厂无痕迹自检：这一节以前叫 probeAiGate（断言 AI 门禁锁着）。
   * AI 搬进插件体系之后，要断言的换成两件事：界面上找不回它，且替代它的两条通道
   * （ai.digest / net.stream）对一个没登记过的插件 id 一律给不出东西。
   * ★ 只删界面不改桥不算无痕迹 —— 所以 df.ai 与视图与导航项三个都查。 */
  function probeAiTrace() {
    return mainWin.webContents.executeJavaScript(
      '(async function(){' +
      '  var o = {};' +
      '  o.aiBridge = !!(window.df && window.df.ai);' +
      '  o.viewAi = !!document.getElementById("view-ai");' +
      '  o.navAi = !!document.getElementById("navAi");' +
      '  var d = await window.df.plugin.call("df.selftest.absent", "ai.digest", { scope: "global" });' +
      '  o.digestRefused = !(d && d.ok); o.digestError = (d && d.error) || "";' +
      '  var s = await window.df.plugin.call("df.selftest.absent", "net.stream", { url: "https://df-selftest.invalid/x" });' +
      '  o.streamRefused = !(s && s.ok);' +
      '  return JSON.stringify(o);' +
      '})()'
    ).then(function (r) {
      const o = JSON.parse(r);
      o.pass = !!(o.aiBridge === false && o.viewAi === false && o.navAi === false &&
        o.digestRefused && o.streamRefused);
      result.aiTrace = o;
    }).catch(function (e) {
      result.aiTrace = { pass: false, error: String((e && e.message) || e) };
    });
  }

  /* 地图名这一节：那行状态必须真是宿主喂出来的（这颗按钮是「之后全手动」唯一的入口），
   * 且整屏 DOM 里找不出那台 CDN 的地址 —— 界面连域名都不该看见，出网只在主进程。 */
  function probeMapNames() {
    return mainWin.webContents.executeJavaScript(
      '(async function(){' +
      '  function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}' +
      '  var o = { bridge: !!(window.df && window.df.mapNames && window.df.mapNames.status &&' +
      '    window.df.mapNames.refresh) };' +
      '  if (!o.bridge) { o.pass = false; return JSON.stringify(o); }' +
      /* ★ #92 那条链在**出厂字节**里只这么真跑一次：界面 → preload → ipcMain → editMapName → accounts+store。
       *   静态红线量得出"源码里有这句话"，量不出这三段接得上（上一轮四针没咬住的就是这一类）。
       *   这里改的是自检自己那份临时 profile 里的字典，动不到使用者的数据；跑完必还原。 */
      '  o.userBridge = !!(window.df.mapNames.dict && window.df.mapNames.setName);' +
      '  if (o.userBridge) {' +
      '    var d0 = await window.df.mapNames.dict();' +
      '    o.dictShape = !!(d0 && d0.ok === true && Array.isArray(d0.usage) &&' +
      '      Array.isArray(d0.userEdits) && typeof d0.builtin === "number");' +
      '    var r1 = await window.df.mapNames.setName({ id: "888888", name: "自检起的名字" });' +
      '    o.setOk = !!(r1 && r1.ok === true && r1.applied === 1);' +
      '    var d1 = await window.df.mapNames.dict();' +
      '    o.dictSeesEdit = !!(d1 && d1.user === 1 &&' +
      '      String(JSON.stringify(d1.userEdits)).indexOf("自检起的名字") >= 0);' +
      '    var bad = await window.df.mapNames.setName({ id: "888888", name: "<s>坏名字" });' +
      '    o.dirtyRefused = !!(bad && bad.ok === false && !!bad.error);' +
      '    var r2 = await window.df.mapNames.setName({ id: "888888", name: "" });' +
      '    o.reverted = !!(r2 && r2.ok === true && r2.cleared === 1);' +
      '    var d2 = await window.df.mapNames.dict();' +
      '    o.dictClean = !!(d2 && d2.user === 0);' +
      '  }' +
      '  var s = await window.df.mapNames.status();' +
      '  o.shape = !!(s && s.ok === true && s.builtin >= 60 && typeof s.learned === "number" &&' +
      '    typeof s.unknown === "number" && typeof s.at === "number");' +
      '  o.status = s;' +
      '  for (var i = 0; i < 20; i++) {' +
      '    var t = document.getElementById("mapNamesText");' +
      '    if (t && String(t.textContent).indexOf("内置") === 0) { o.rowText = t.textContent; break; }' +
      '    await sleep(150);' +
      '  }' +
      '  o.rowFilled = !!o.rowText;' +
      '  o.btn = !!document.getElementById("btnMapNamesRefresh");' +
      '  o.urlHidden = String(document.body.innerHTML).indexOf("qpic") === -1;' +
      '  o.pass = !!(o.shape && o.rowFilled && o.btn && o.urlHidden && o.userBridge &&' +
      '    o.dictShape && o.setOk && o.dictSeesEdit && o.dirtyRefused && o.reverted && o.dictClean);' +
      '  return JSON.stringify(o);' +
      '})()'
    ).then(function (r) { result.mapNames = JSON.parse(r); })
      .catch(function (e) {
        result.mapNames = { pass: false, error: String((e && e.message) || e) };
      });
  }

  /* 在线更新那一栏的自检：量的是"这行字真由宿主喂出来"，不是"页面上有这么个 div"。
   * ★ 自检模式下不许真出网（上面那条红线），所以这里比的是形状与边界：
   *   桥在不在、宿主回的当前版本是不是真值、界面有没有偷偷长出"立即更新"那颗会动文件的按钮、
   *   以及整张 DOM 里找不出那个服务器域名（出网只在主进程，界面连地址都不该看见）。 */
  function probeUpdatePanel() {
    return mainWin.webContents.executeJavaScript(
      '(async function(){' +
      '  function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}' +
      '  var o = { bridge: !!(window.df && window.df.update && window.df.update.status &&' +
      '    window.df.update.check && window.df.update.openDownload) };' +
      '  if (!o.bridge) { o.pass = false; return JSON.stringify(o); }' +
      '  var s = await window.df.update.status();' +
      '  o.shape = !!(s && s.ok === true && typeof s.current === "string" &&' +
      '    s.current.split(".").length === 3 && typeof s.action === "string");' +
      '  o.status = s;' +
      '  for (var i = 0; i < 20; i++) {' +
      '    var t = document.getElementById("updStatus");' +
      '    if (t && String(t.textContent).length > 4) { o.rowText = t.textContent; break; }' +
      '    await sleep(150);' +
      '  }' +
      '  o.rowFilled = !!o.rowText;' +
      '  var v = document.getElementById("updVersion");' +
      '  o.versionShown = v ? String(v.textContent) : "";' +
      '  o.panel = !!(document.getElementById("btnUpdCheck") &&' +
      '    document.getElementById("btnUpdDownload"));' +
      '  o.noAutoInstall = !document.getElementById("btnUpdApply");' +
      '  o.hostMatches = o.versionShown.indexOf((s && s.current) || "?none?") >= 0;' +
      '  o.urlHidden = String(document.body.innerHTML).indexOf("dpx1") === -1;' +
      '  o.pass = !!(o.shape && o.rowFilled && o.panel && o.noAutoInstall &&' +
      '    o.hostMatches && o.urlHidden);' +
      '  o.pass = !!(o.shape && o.rowFilled && o.panel && o.noAutoInstall &&' +
      '    o.hostMatches && o.urlHidden);' +
      '  return JSON.stringify(o);' +
      '})()'
    ).then(function (r) { result.updatePanel = JSON.parse(r); })
      .catch(function (e) {
        result.updatePanel = { pass: false, error: String((e && e.message) || e) };
      });
  }

  /* ★ 桌面这条裁定的**真机证据**（开登录窗 = 全新会话，只动这一个号的那一罐）。
   * 离线那几项是在假 session 上跑同一段函数，量的是逻辑；这一节量的是这台 Electron：
   *   ① 那串 storage 名字在这版运行时里真的清得掉东西（`clearStorageData` 对不认识的名字是静悄悄忽略，
   *      调用没报错 ≠ 清干净了 —— 这一点是 tools/probe-desktop-session-wipe.js 实测出来的）；
   *   ② 清完那一罐真的空了；③ 隔壁那个号的会话一枚没少（不许顺手把别的号登出）。
   * 用两枚一次性的分区，不碰使用者任何真号的罐子。 */
  function probeLoginWipe() {
    const A = 'selftest-wipe-a', B = 'selftest-wipe-b';
    const sesA = require('electron').session.fromPartition(partitionFor(A));
    const sesB = require('electron').session.fromPartition(partitionFor(B));
    const URL = 'https://www.wegame.com.cn/selftest';
    function seed(ses) {
      return ses.cookies.set({ url: URL, name: 'df_selftest_sid', value: 'x', httpOnly: true, secure: true });
    }
    return Promise.all([seed(sesA), seed(sesB)]).then(function () {
      return Promise.all([sesA.cookies.get({}), sesB.cookies.get({})]);
    }).then(function (both) {
      const o = { beforeA: both[0].length, beforeB: both[1].length };
      return wipeLoginSession(sesA, null).then(function (res) {
        o.cleared = res.cleared;
        o.clearError = res.clearError;
        return Promise.all([sesA.cookies.get({}), sesB.cookies.get({})]);
      }).then(function (after) {
        o.afterA = after[0].length;
        o.afterB = after[1].length;
        /* 三条都得成立：清前确实种下去了（不然"清了"是空的）、清后 A 空、B 不受牵连 */
        o.pass = !!(o.beforeA === 1 && o.cleared === true && o.afterA === 0 && o.beforeB === 1 && o.afterB === 1);
        result.loginWipe = o;
      });
    }).catch(function (e) {
      result.loginWipe = { pass: false, error: String((e && e.message) || e) };
    });
  }

  /* 插件宿主自检：默认安装下"扩展页面"必须不可见，没登记的插件一律给不到东西 */
  function probePlugins() {
    return mainWin.webContents.executeJavaScript(
      '(async function(){' +
      '  var o = { bridge: !!(window.df && window.df.plugin) };' +
      '  if (!o.bridge) return JSON.stringify(o);' +
      '  var l = await window.df.plugin.list();' +
      '  o.listOk = !!(l && l.ok);' +
      '  o.registered = (l && l.plugins || []).length;' +
      '  o.scopesKnown = !!(l && l.scopes && l.scopes["net.request"] && l.scopes["net.request"].label);' +
      '  var views = (l && l.plugins || []).filter(function (p) {' +
      '    return p.enabled && (p.permissions || []).some(function (x) { return x.scope === "view"; }); });' +
      '  var nav = document.getElementById("navPlugin");' +
      '  o.navDisplay = nav ? getComputedStyle(nav).display : "missing";' +
      '  o.navOk = views.length ? o.navDisplay !== "none" : o.navDisplay === "none";' +
      '  var bad = await window.df.plugin.call("df.selftest.absent", "host.info", {});' +
      '  o.unknownRefused = !(bad && bad.ok);' +
      '  var pg = await window.df.plugin.page("df.selftest.absent");' +
      '  o.pageRefused = !(pg && pg.ok);' +
      '  var fr = document.getElementById("pluginFrame");' +
      '  o.frameSandbox = fr ? (fr.getAttribute("sandbox") || "") : "missing";' +
      '  o.frameNoSameOrigin = !!fr && o.frameSandbox.indexOf("allow-same-origin") === -1;' +
      '  o.frameEmpty = !fr || !/DFPlugin/.test(fr.getAttribute("srcdoc") || "");' +
      '  var pc = document.getElementById("pluginConsent");' +
      '  o.consentPanelHidden = !pc || getComputedStyle(pc).display === "none";' +
      '  o.gateApi = typeof window.df.plugin.consent === "function" &&' +
      '    typeof window.df.plugin.revokeConsent === "function";' +
      '  var cg = await window.df.plugin.consent("df.selftest.absent", "x");' +
      '  o.gateUnknownRefused = !(cg && cg.ok);' +
      '  return JSON.stringify(o);' +
      '})()'
    ).then(function (r) {
      const o = JSON.parse(r);
      o.pass = !!(o.bridge && o.listOk && o.scopesKnown && o.navOk && o.unknownRefused &&
        o.pageRefused && o.frameNoSameOrigin && o.frameEmpty &&
        o.consentPanelHidden && o.gateApi && o.gateUnknownRefused);
      result.plugins = o;
    }).catch(function (e) {
      result.plugins = { pass: false, error: String((e && e.message) || e) };
    });
  }

  /* ★ 备份那一节的真机证据：自己写的文件名自己认得出、按号裁得动、里面有什么念得出。
   *   这一条是 #76 存在的全部理由 —— 旧版的判定要紧凑时间戳，而 doBackup 写的是带横线的那种，
   *   于是仓库里 grep 一片绿、界面上永远「还没有备份文件」、保留份数从来没裁过任何东西。
   *   所以这里不能只喂名字，必须让真在磁盘上落过文件的 doBackup 回读自己。
   *   跑在 --selftest 的隔离用户数据目录里、用一枚探针号，不碰使用者任何真号。 */
  function probeBackups() {
    const slot = 'probez';
    const o = { dir: backupDir(), pass: false };
    const had = accounts.accounts.slice();
    const hadKeep = accounts.globalSettings && accounts.globalSettings.backupKeep;
    /* ★ 每一步之间隔过一秒：备份名只精确到秒（`…-2026-09-26-01-29-03`），同一秒里做两次备份会撞在
     *   同一个名字上 —— 前一份被顶掉、按 mtime 也排不出新旧。那是产品行为（已记进手册 §11 的"还没修"），
     *   不是这一节要量的东西；探针要量"认得出 / 裁得动 / 念得清"，就得让每一步的名字真的不同。 */
    function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function mine() {
      return listedBackups(o.dir).filter(function (f) {
        const i = StoreMod.parseBackupName(f);
        return i && i.slot === slot;
      });
    }
    try {
      accounts.accounts = had.concat([{ slot: slot, name: '探针号', openid: 'probe-openid' }]);
      const src = dataFileFor(slot);
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.writeFileSync(src, JSON.stringify({
        version: 2, meta: { openid: 'probe-openid', name: '探针号', last_sync: Date.now() },
        matches: { p1: { room_id: 'p1', start_time: 1780000000 },
          p2: { room_id: 'p2', start_time: 1780003600 } },
        rosters: { p1: { players: [] } }
      }), 'utf8');

      /* ① 落盘的那几个名字，自己这一个判定函数必须认（上一版就是栽在这） */
      const r1 = doBackup('manual');
      o.wrote = (r1.files || []).length;
      o.recognized = (r1.files || []).filter(isBackupName).length;
      o.grouped = mine().length;
    } catch (e) {
      o.error = String((e && e.message) || e);
      o.pass = false;
    }
    function cleanup() {
      accounts.accounts = had;
      if (accounts.globalSettings) {
        if (hadKeep === undefined) delete accounts.globalSettings.backupKeep;
        else accounts.globalSettings.backupKeep = hadKeep;
      }
      result.backups = o;
    }
    return delay(1100).then(function () {
      /* ② 保留份数真能裁：把 keep 压到 1，再写一份（换个 tag 保证名字不同、同一组），
       *    旧的那份就该被删掉 —— 上一版这里一份都删不动。
       * ③ 「看得见」那一句的内容来自真读文件：谁的号、几场、几份名单 */
      try {
        accounts.globalSettings = accounts.globalSettings || {};
        accounts.globalSettings.backupKeep = 1;
        const r2 = doBackup('probe2');
        o.pruned = r2.pruned;
        o.left = mine().length;
        const rest = o.left ? mine()[0] : '';
        o.leftName = rest;
        /* 留下的必须是**后写的那一份**（名字里带 probe2）：按 mtime 排就会留下前一份 —— 这一条
         *  就是这一节顺手量出来的那个真缺陷（copyFileSync 连源文件 mtime 一起抄）。 */
        o.keptNewest = /-probe2-/.test(rest);
        o.sum = rest ? peekBackup(o.dir, rest, fs.statSync(path.join(o.dir, rest)).size, 0) : null;
        o.pass = !!(o.wrote && o.recognized === o.wrote && o.grouped >= 1 &&
          o.pruned >= 1 && o.left === 1 && o.keptNewest && o.sum && o.sum.kind === 'library' &&
          o.sum.matches === 2 && o.sum.name === '探针号');
      } catch (e) {
        o.error = String((e && e.message) || e);
        o.pass = false;
      }
      return delay(1100);
    }).then(function () {
      /* ④ 他报的那两句都在**界面上**：「已备份到：undefined」与「显示不出来备份文件」。
       *   所以最后一步走真用户路径 —— 点那颗按钮，读 toast 与那一行的 DOM 文本。
       *   ★ 界面拿不到回包（`window.df` 是 contextBridge 挂上去的，属性只读，包不动），
       *    所以"这一轮真裁掉了几份"改由**盘上前后两次目录之差**来定：那是宿主真做过的事，
       *    界面那句必须跟它对得上，多一句、少一句、数字不对，都算红。 */
      o.beforeClick = listedBackups(o.dir);
      return mainWin.webContents.executeJavaScript(
        '(async function(){' +
        '  function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}' +
        '  var btn = document.getElementById("btnBackupNow");' +
        '  if (!btn) return JSON.stringify({ error: "没有那颗按钮" });' +
        '  var before = String((document.getElementById("toast") || {}).textContent || "");' +
        '  btn.click();' +
        '  var toast = "", row = "";' +
        '  for (var i = 0; i < 40; i++) {' +
        '    var t = document.getElementById("toast");' +
        '    var el = document.getElementById("backupList");' +
        '    if (t && !toast && String(t.textContent || "") !== before) toast = String(t.textContent);' +
        '    if (el) row = String(el.textContent || "");' +
        '    if (/已备份 \\d+ 个文件/.test(toast) && /份，共/.test(row)) break;' +
        '    await sleep(100);' +
        '  }' +
        '  return JSON.stringify({ toast: toast, row: row, before: before });' +
        '})()'
      );
    }).then(function (r) {
      const u = JSON.parse(r);
      o.toast = u.toast || '';
      o.row = u.row || '';
      o.afterClick = listedBackups(o.dir);
      /* 这一次点按钮：写出了几份、又裁掉了哪几份 —— 全部从盘上前后之差量出来，不采信界面自己的话 */
      o.madeAtClick = o.afterClick.filter(function (f) { return o.beforeClick.indexOf(f) === -1; }).length;
      o.prunedAtClick = o.beforeClick.filter(function (f) { return o.afterClick.indexOf(f) === -1; }).length;
      /* 四句都得成立：toast 报了这次写了几份、没念出 undefined；那一行念得出号与场数；
       * 而"这轮裁掉 N 份旧的"那一句，出现与否必须跟盘上真裁掉的份数一致（0 份就不许喊，>0 就必须喊对数） */
      o.uiOk = !!/已备份 \d+ 个文件/.test(o.toast) && o.toast.indexOf('undefined') === -1 &&
        o.row.indexOf('undefined') === -1 && /探针号/.test(o.row) &&
        /\d+ 场/.test(o.row) && /份，共 \d+ 份/.test(o.row) &&
        o.madeAtClick >= 1 && o.prunedAtClick >= 1 &&
        (o.prunedAtClick > 0 ? o.toast.indexOf('这轮裁掉 ' + o.prunedAtClick + ' 份') >= 0
          : o.toast.indexOf('这轮裁掉') === -1);
      o.pass = !!(o.pass && o.uiOk);
    }).catch(function (e) {
      o.uiError = String((e && e.message) || e);
      o.pass = false;
    }).then(cleanup);
  }

  mainWin.webContents.once('did-finish-load', function () {
    mainWin.webContents.executeJavaScript(
      'JSON.stringify({' +
      '  hasDfApi: typeof window.df === "object",' +
      '  loginViewPresent: !!document.getElementById("loginView"),' +
      '  appViewPresent: !!document.getElementById("appView"),' +
      '  navItems: document.querySelectorAll(".nav-item").length,' +
      '  views: Array.prototype.map.call(document.querySelectorAll(".view"), function(v){return v.id;}),' +
      '  filters: !!document.querySelector(".filterbar"),' +
      '  echartsLoaded: typeof window.echarts === "object",' +
      '  accountSwitchPresent: !!document.getElementById("accountSwitch"),' +
      /* 六项深度分析的四块容器：id 打错一块，界面就静默少一整块面板（grep 只看仓库，看不到出的包） */
      '  deepPanels: ["winLossPanel","structurePanel","durPanel","strengthPanel"].filter(function (id) {' +
      '    return !!document.getElementById(id);' +
      '  }).length,' +
      '  sandboxFrameDisplay: (function(){ var el = document.querySelector(".sandbox-frame");' +
      '    return el ? getComputedStyle(el).display : "missing"; })(),' +
      '  title: document.title' +
      '})'
    ).then(function (r) {
      Object.assign(result, JSON.parse(r));
      result.phase = 'loaded';
      // webview 宿主必须是 flex 容器，否则 guest 视口塌成 150 高（地图被压在左上角一小块里）
      result.sandboxFlex = result.sandboxFrameDisplay === 'flex' || result.sandboxFrameDisplay === 'inline-flex';
      result.ok = !!(result.hasDfApi && result.loginViewPresent && result.appViewPresent &&
        result.echartsLoaded && result.filters && result.navItems >= 6 &&
        result.accountSwitchPresent && result.sandboxFlex &&
        result.deepPanels === 4 &&
        result.views.indexOf('view-winrate') !== -1 &&
        result.views.indexOf('view-encounters') !== -1 &&
        result.views.indexOf('view-maps') !== -1 &&
        result.views.indexOf('view-sandbox') !== -1 &&
        result.views.indexOf('view-about') !== -1);
      return probeAiTrace().then(function () {
        if (result.aiTrace && result.aiTrace.pass === false) result.ok = false;
        return probePlugins();
      }).then(function () {
        if (result.plugins && result.plugins.pass === false) result.ok = false;
        return probeMapNames();
      }).then(function () {
        if (result.mapNames && result.mapNames.pass === false) result.ok = false;
        return probeUpdatePanel();
      }).then(function () {
        if (result.updatePanel && result.updatePanel.pass === false) result.ok = false;
        return probeLoginWipe();
      }).then(function () {
        if (result.loginWipe && result.loginWipe.pass === false) result.ok = false;
        return probeBackups();
      }).then(function () {
        if (result.backups && result.backups.pass === false) result.ok = false;
        finish();
      });
    }).catch(function (e) {
      result.phase = 'error';
      result.ok = false;
      result.error = String(e && e.message || e);
      finish();
    });
  });
}

/* ============================================================
 * 定时自动同步
 * 官方单次返回 8 场，通过 after 游标可翻最多 5 页 ≈ 35 场
 * ============================================================ */
let syncTimer = null;

function scheduleAutoSync() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  if (!store) return;
  const min = Number(store.state.settings.autoSyncInterval) || 0;
  if (min <= 0) return;
  syncTimer = setInterval(function () {
    if (!mainWin || mainWin.isDestroyed()) return;
    if (syncing) return;
    collector.checkLogin().then(function (r) {
      if (!r.ok) return;
      runSync({
        withDetail: store.state.settings.autoSyncDetail !== false,
        detailScope: 'all'
      }).then(function (res) {
        if (res && res.ok) emit('sync:auto', res);
      });
    }).catch(function () { /* 静默 */ });
  }, min * 60 * 1000);
}

/* ============================================================
 * 数据备份：遍历所有 slot 数据文件 + accounts.json
 * ============================================================ */
function backupDir() {
  const custom = accounts.globalSettings && accounts.globalSettings.backupDir;
  return custom || path.join(userDataDir(), 'backups');
}

function backupKeep() {
  return Number(accounts.globalSettings && accounts.globalSettings.backupKeep) || 7;
}

/* ★ 认名字这件事判据在 core（`parseBackupName`）：这一版之前这里写的判定要的是**八位日期 + 六位时间**
 *   那种紧凑时间戳，而 doBackup 写出来的是 `2026-09-26-01-29-03` ⇒ **自己写的文件自己认不出**，
 *   于是设置里那句「最近备份：…」永远是「还没有备份文件。」，而 pruneBackups 也一个都认领不到 ——
 *   「保留最近 N 份」从来没生效过。他 2026-09-26 报的「显示不出来备份文件」就是这一条。 */
function isBackupName(name) { return !!StoreMod.parseBackupName(name); }

/* 目录里此刻有哪些**认得出**的备份。自检那一步拿它量前后之差：这一次点按钮写出了几份、
 * 又裁掉了哪几份 —— 界面那句「这轮裁掉 N 份旧的」对不对，只有盘上说得清。 */
function listedBackups(dir) {
  try { return fs.readdirSync(dir).filter(isBackupName).sort(); } catch (e) { return []; }
}

/* 返回这轮真的裁掉了几个文件：裁备份是删使用者的数据，上一版认不出名字 ⇒ 一个都没删过，
 * 而界面也从不提"裁" —— 现在认得出了，就得让他看见"这轮删了哪几份、按什么删"。 */
function pruneBackups(dir) {
  const keep = backupKeep();
  let pruned = 0;
  try {
    const files = fs.readdirSync(dir).filter(isBackupName).map(function (f) {
      const full = path.join(dir, f);
      const info = StoreMod.parseBackupName(f);
      /* ★ 排的是**名字里那个时刻**，不是 mtime：`fs.copyFileSync` 连源文件的修改时间一起抄过来，
       *   所以一个号这几天没同步的话，它所有备份的 mtime 全相同 ⇒ 按 mtime 排等于按目录顺序排，
       *   "留最近 N 份"会留下旧的那几份、把刚写的裁掉（自检那一步真就这么红过一次）。 */
      return { f: f, t: (info && info.at) || fs.statSync(full).mtimeMs, info: info };
    }).sort(function (a, b) { return b.t - a.t; });
    /* ★ 分组按**号**（accounts.json 那一串单独一组），不是按"号 + 日期"：
     *   后者等于每天一组、每组只有一份，切多少份都裁不掉任何东西（旧写法就是这么写的）。 */
    const byGroup = {};
    files.forEach(function (x) {
      const g = x.info && x.info.slot ? x.info.slot : 'other';
      (byGroup[g] = byGroup[g] || []).push(x);
    });
    Object.keys(byGroup).forEach(function (g) {
      byGroup[g].slice(keep).forEach(function (x) {
        try { fs.unlinkSync(path.join(dir, x.f)); pruned++; } catch (e) { /* ignore */ }
      });
    });
  } catch (e) { /* ignore */ }
  return { pruned: pruned, keep: keep };
}

/* 备份列表里"这份里有什么"要读文件才知道（几场、跨度、谁的号）。
 * 一个目录几十份、每份几百 KB，全解析一遍不便宜 ⇒ 按 名字+大小+mtime 缓存，文件没动就复用结论。 */
const backupPeekCache = new Map();
function peekBackup(dir, name, size, mtime) {
  const key = name + '|' + size + '|' + Math.round(mtime || 0);
  if (backupPeekCache.has(key)) return backupPeekCache.get(key);
  let sum = { kind: 'unknown' };
  try {
    sum = StoreMod.summarizeBackup(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
  } catch (e) {
    sum = { kind: 'unknown', unreadable: String((e && e.message) || e) };
  }
  if (backupPeekCache.size > 80) backupPeekCache.delete(backupPeekCache.keys().next().value);
  backupPeekCache.set(key, sum);
  return sum;
}

function doBackup(tag) {
  try {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const made = [];
    // 每个已注册的 slot 数据文件都备份
    accounts.accounts.forEach(function (a) {
      const src = dataFileFor(a.slot);
      if (!fs.existsSync(src)) return;
      const name = 'df-swtwr-' + a.slot + '-' + (tag || 'manual') + '-' + stamp + '.json';
      const dst = path.join(dir, name);
      fs.copyFileSync(src, dst);
      made.push(name);
    });
    // accounts.json 也备份一份
    if (fs.existsSync(accountsFile())) {
      const aname = 'df-swtwr-accounts-' + (tag || 'manual') + '-' + stamp + '.json';
      fs.copyFileSync(accountsFile(), path.join(dir, aname));
      made.push(aname);
    }
    if (!made.length) return { ok: false, error: '还没有可备份的数据文件' };
    const p = pruneBackups(dir);
    return { ok: true, dir: dir, files: made, count: made.length,
      pruned: p.pruned, keep: p.keep };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function ensureDailyBackup() {
  if (accounts.globalSettings.autoBackup === false) return;
  try {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const has = fs.readdirSync(dir).some(function (f) {
      return f.indexOf('df-swtwr-accounts-daily-' + today) === 0;
    });
    if (!has) doBackup('daily-' + today);
  } catch (e) { /* ignore */ }
}

/* 当前号是"数据包导进来的"（本机没有它的 WeGame 会话）：只能读，不能同步。
 * 安卓上这一条更是硬事实 —— 整机只有一个共享 cookie 罐，验出来的登录态属于手机登录的那个号，
 * 拿它代表这个号等于把 A 的新场次写进 B 的库。 */
function activeAccount() {
  return accounts.accounts.filter(function (a) { return a.slot === accounts.activeSlot; })[0] || null;
}
function activeLocalOnly() {
  const a = activeAccount();
  return !!(a && a.imported);
}

/* ---------------- 导入数据包 ----------------
 * ★ 包属于谁，就落进谁的库：本机没这个号就当场登记一个（只读号），再把当前号切过去合并。
 *   以前这里直接拒收，逼着人"先切到该账号"—— 可手机上根本切不过去（没有它的会话），
 *   而并进当前号更坏：两个人的场次混在一个库里，胜率、评分曲线、对手档案全都算错，
 *   是一份看着像成功的错数据。 */
function adoptBundleOwner(openid, meta) {
  let slot = findSlotByOpenid(openid);
  let isNew = false;
  const name = String(meta.name || '');
  if (!slot) {
    slot = nextFreeSlot();
    accounts.accounts.push({
      slot: slot, openid: openid, name: name, area: Number(meta.area) || 36,
      partition: partitionFor(slot), created_at: Date.now(),
      last_sync: Number(meta.last_sync) || 0, imported: true
    });
    saveAccountsSync();
    isNew = true;
  }
  /* switchTo 会换掉 store/collector/session 并广播 account:changed，界面随后就是这一号的数据 */
  return switchTo(slot).then(function (r) {
    return r.ok ? { ok: true, slot: slot, name: name || slot, isNew: isNew } : r;
  });
}

function importBundle(bundle) {
  if (!bundle) return Promise.resolve({ ok: false, error: '空数据包' });
  if (!store) return Promise.resolve({ ok: false, error: '未选择账号' });
  /* 包里的地图名字典先收下：紧接着的合并与 prune 就能把新学 id 的场次当场改对名。
   * ★ 不传 at —— 这条路不算「首次自动拉过」，那一次该发还得发（见 pullMapNames 上方那段）。 */
  if (bundle.map_names) learnMapNames(bundle.map_names);
  /* ★ 带进来的那一层「我自己起的名字」（#92）：同一条清洗、同一个不落 at 的规矩。
   * 老包没这个键就什么也不做 —— 不许把对方本机没改过的图当成"改成空"。 */
  if (bundle.map_names_user) learnUserNames(bundle.map_names_user);
  const meta = bundle.meta || {};
  const owner = String(meta.openid || '');
  const cur = String(store.state.meta.openid || '');
  let route = Promise.resolve(null);
  if (owner && cur && owner !== cur) route = adoptBundleOwner(owner, meta);
  return route.then(function (r) {
    if (r && !r.ok) return r;
    return mergeBundle(bundle).then(function (res) {
      if (r) {
        res.slot = r.slot; res.account = r.name; res.isNew = r.isNew; res.switched = true;
      }
      return res;
    });
  });
}

/* 合并进当前 store：按 roomId 去重，名单取更完整的，赛季取更新的，标注只补本机没有的 */
function mergeBundle(bundle) {
  const s = store.state;
  let added = 0, dup = 0, rosterAdded = 0, rosterKept = 0;

  const bm = bundle.matches || {};
  Object.keys(bm).forEach(function (k) {
    if (s.matches[k]) { dup++; return; }
    s.matches[k] = bm[k];
    added++;
  });

  const br = bundle.rosters || {};
  Object.keys(br).forEach(function (k) {
    const inc = br[k] || {};
    const cur = s.rosters[k];
    if (!cur || (inc.players || []).length > (cur.players || []).length) {
      s.rosters[k] = inc;
      rosterAdded++;
    } else {
      rosterKept++;
    }
  });

  const bs = bundle.seasons || {};
  Object.keys(bs).forEach(function (sid) {
    const inc = bs[sid];
    if (!s.seasons[sid] || (inc.at || 0) > (s.seasons[sid].at || 0)) s.seasons[sid] = inc;
  });

  /* 用户标注：只补本机还没有的，且必须本机存在该场次（本机意愿优先 —— 手改过的绝不被外部包覆盖） */
  if (!s.flags) s.flags = {};
  const bfl = bundle.flags || {};
  Object.keys(bfl).forEach(function (k) {
    if (!s.matches[k] || s.flags[k]) return;
    s.flags[k] = {
      commander: bfl[k].commander ? 1 : 0,
      excluded: bfl[k].excluded ? 1 : 0,
      competition: bfl[k].competition ? 1 : 0
    };
    if (!s.flags[k].commander && !s.flags[k].excluded && !s.flags[k].competition) delete s.flags[k];
  });

  if (bundle.meta) {
    if (!s.meta.openid && bundle.meta.openid) s.meta = Object.assign({}, s.meta, bundle.meta);
    else if (bundle.meta.last_sync > (s.meta.last_sync || 0)) s.meta.last_sync = bundle.meta.last_sync;
  }

  return store.save().then(function () {
    return { ok: true, added: added, dup: dup, rosterAdded: rosterAdded, rosterKept: rosterKept };
  });
}

/* ---------------- 采集 ---------------- */
let syncing = false;
function runSync(opts) {
  opts = opts || {};
  if (!collector || !store) return Promise.resolve({ ok: false, error: '未选择账号' });
  /* ★ 只读号不许同步：这台机器上属于它的会话根本不存在，硬采一次就是把别的号的场次写进它的库 */
  if (activeLocalOnly()) {
    return Promise.resolve({
      ok: false, localOnly: true, inserted: 0, duplicates: 0, slot: accounts.activeSlot,
      error: '「' + (activeAccount().name || accounts.activeSlot) + '」是导入的只读账号，本机没有它的 WeGame 会话，不能同步'
    });
  }
  if (syncing) return Promise.resolve({ ok: false, error: '正在同步中，请稍候' });
  syncing = true;
  emit('sync:start', { slot: accounts.activeSlot });

  return collector.collect({
    withDetail: opts.withDetail !== false,
    detailScope: opts.detailScope || store.state.settings.detailScope || 'all',
    haveRosters: store.trustedRosterRoomIds(),
    pages: opts.pages || store.state.settings.syncPages || 5,
    pageDelayMs: opts.pageDelayMs != null ? opts.pageDelayMs :
      (store.state.settings.syncPageDelayMs != null ? store.state.settings.syncPageDelayMs : 500),
    /* 官方赛季号（本机设置里那一枚；空 = 采集器内置默认）。官方没有"当前第几赛季"的接口，
     * 所以这一枚只影响「赛季汇总 / 分地图统计」那两发，战局列表本身不带 sid。 */
    sid: store.state.settings.seasonSid || '',
    onProgress: function (p) { emit('sync:progress', p); }
  }).then(function (payload) {
    /* ★★ 入库前最后一道归属核对（判据在 core：Store.ownerConflict，两端共用一份）。
     *   走到这一步还不一致，说明"罐子与人"的对应关系在别处已经错了（旧版本留下的状态、
     *   或手工挪过 accounts.json），所以把话说清楚：让他切号或重新登录，而不是替他猜。 */
    const acc = acctOfSlot(accounts.activeSlot);
    const mine = (acc && acc.openid) || (store.state.meta && store.state.meta.openid) || '';
    const got = payload && payload.role && payload.role.openid ? payload.role.openid : '';
    if (StoreMod.ownerConflict(mine, got)) {
      return {
        ok: false, ownerMismatch: true, inserted: 0, duplicates: 0, players: 0, errors: [],
        error: '这个号登记的是「' + (((acc && acc.name) || (store.state.meta && store.state.meta.name))
          || accounts.activeSlot) + '」，可这次会话里的人是「' + ((payload.role && payload.role.name) || got) +
          '」—— 没有往库里写一个字节。请到「账号」里切到他，或者重新登录一次（软件会把这次的会话交给他）'
      };
    }
    emit('sync:progress', {
      stage: '入库中', stageIndex: 5, stageTotal: 6,
      done: 1, total: 1, percent: 99, label: '数据入库中…'
    });
    return store.ingest(payload).then(function (res) {
      res.errors = (res.errors || []).concat(payload.errors || []);
      // 采集成功后同步账号元数据
      if (payload.role && payload.role.openid) {
        bindLogin(payload.role.openid, payload.role.name, payload.role.area, collector.accountType);
      }
      res.ok = !res.errors.length || res.inserted > 0;
      // 只统计「本轮官方窗口内还缺名单」的场次：窗口外的老场次补不到，不该一直挂在待办数上
      const seenRoom = {};
      ((payload.list && payload.list.tdms) || []).forEach(function (r) {
        if (r && r.roomId) seenRoom[String(r.roomId)] = 1;
      });
      res.missingRosters = Object.keys(store.state.matches || {}).filter(function (rid) {
        return seenRoom[rid] && !store.state.rosters[rid];
      }).length;
      /* 漏采自证：把本轮官方窗口的时间边界记进台账（判据见 core/store.js recordSyncWindow 的注释）。
       * 台账只是诊断信息，写失败绝不能把一次成功的同步变成失败。 */
      const ts = ((payload.list && payload.list.tdms) || [])
        .map(function (r) { return Number(r && r.startTime) || 0; })
        .filter(function (t) { return t > 0; });
      return store.recordSyncWindow({
        at: payload.at || Date.now(),
        oldest: ts.length ? Math.min.apply(null, ts) : 0,
        newest: ts.length ? Math.max.apply(null, ts) : 0,
        count: ts.length, inserted: res.inserted,
        trace: payload.pageTrace || null
      }).catch(function () { return {}; }).then(function (w) {
        res.suspect = !!(w && w.suspect);
        res.firstRound = !!(w && w.firstRound);
        res.gapDays = (w && w.days) || 0;
        res.gapFrom = (w && w.from) || 0;
        res.gapTo = (w && w.to) || 0;
        res.pageTrace = payload.pageTrace || null;
        res.seasonSid = payload.sid || '';
        return res;
      });
    });
  }).then(function (res) {
    syncing = false;
    res.slot = accounts.activeSlot;
    emit('sync:done', res);
    /* 「自动日报」在这一版只剩一件事：往 plugin-data/triggers.json 记一笔。
     * 宿主不跑任何插件代码，也不发任何东西 —— 要出报告得有人把插件页打开并亲手点下去。
     * 绝不 await，也不让记账失败把一次成功的同步说成失败。 */
    if (res.ok) {
      try {
        notePluginTriggers({
          at: Date.now(), slot: res.slot, inserted: res.inserted,
          matches: store ? Object.keys(store.state.matches || {}).length : 0
        });
      } catch (e) { /* ignore */ }
    }
    return res;
  }).catch(function (e) {
    syncing = false;
    const out = {
      ok: false,
      notLogin: !!e.notLogin || !!e.loginFailed,
      error: e.message || String(e),
      slot: accounts.activeSlot
    };
    emit('sync:done', out);
    return out;
  });
}

/* ---------------- 全局设置（跨号共享） ---------------- */
function applyGlobalSettings(patch) {
  const g = ['theme', 'backupDir', 'backupKeep', 'autoBackup'];
  const out = {};
  g.forEach(function (k) { if (patch && k in patch) out[k] = patch[k]; });
  accounts.globalSettings = Object.assign({}, accounts.globalSettings, out);
  saveAccountsSync();
  return accounts.globalSettings;
}

function splitSettings(patch) {
  const globalKeys = ['theme', 'backupDir', 'backupKeep', 'autoBackup'];
  const g = {}, a = {};
  Object.keys(patch || {}).forEach(function (k) {
    if (globalKeys.indexOf(k) !== -1) g[k] = patch[k]; else a[k] = patch[k];
  });
  return { global: g, account: a };
}

/* ---------------- 地图名：官方公开配置表 → 本机学名表 ----------------
 * 战绩接口只回 `mapId` 这种数字，地名在另一份公开的静态配置表上（匿名可取、不带任何本机数据）。
 * URL、允许的域名、解析与清洗口径全在 core/mapConfig.js 一处，这一节只管「什么时候拉、拉到之后存哪儿」。
 *
 * ★ 触发口径是他定的：**首次使用自动拉一次，之后全手动**（设置页那颗「更新地图名」）。
 *   所以本文件里没有任何一处在 runSync 之后捎带这一发 —— 每次同步都往腾讯的 CDN 打一次，
 *   是他明确不要的。唯一还会自动发的一回：一次都没成功过（首次启动正好没网），下次开机再试，
 *   否则这种机器要等到用户自己发现按钮才有名字。判据就是 globalSettings.mapNames.at 是否为 0。
 *
 * 存哪儿：accounts.json 的 globalSettings.mapNames（全机一份，不按号抄）。
 *   这张表是公开地名、零个人数据；doBackup 会原样复制 accounts.json，
 *   于是备份/换机恢复也自带名字 —— 这是白捡的，不是冒险。
 *   刻意不进 store.state：那是「这个号的战绩」，字典进去就会每个号各存一份、还跟着导出包语义走。 */
let mapNamesPulling = null;   /* 正在跑的那一次出网（手动连点与启动自动共用这一道闸） */
function mapNamesRecord() {
  const rec = accounts.globalSettings && accounts.globalSettings.mapNames;
  return (rec && typeof rec === 'object') ? rec : null;
}
/** 把一批名字并进本机字典并落盘。清洗、内置优先、先来先赢全在 Maps.applyExtra 里。
 * @param {object} names id -> 地名（可以来自配置表，也可以来自别人导出的数据包）
 * @param {number} [at] 只在**真取到了官方配置表**时传：它是「首次自动拉一次」唯一的判据，
 *        导入包带进来的名字不许把它顶成非 0，否则该自动的那一回就永远不发了。 */
function learnMapNames(names, at) {
  const merged = Maps.applyExtra(names);
  if (!merged.added && !at) return merged;
  const rec = mapNamesRecord();
  accounts.globalSettings.mapNames = {
    at: at || (rec && rec.at) || 0,
    /* 只存内置表缺的那些（extraNames 就是这个口径）：内置表是抓包实证，不跟它抢 */
    names: Maps.extraNames(),
    /* ★ 使用者自己改的名字单独一层，永远不被「更新地图名」盖掉（#92） */
    userNames: Maps.userNames()
  };
  saveAccountsSync();
  return merged;
}
/** 数据包里带来的「使用者改过的名字」：走的是与本机改名同一条清洗（Maps.applyUser），
 * 只是不落「首次自动拉取」那颗 at —— 与 learnMapNames 一个规矩。
 * @param {object} names id -> 名字（空值表示对方撤销了这条改名）
 */
function learnUserNames(names) {
  const r = Maps.applyUser(names);
  if (!r.applied && !r.cleared) return r;
  const rec = mapNamesRecord();
  accounts.globalSettings.mapNames = {
    at: (rec && rec.at) || 0,
    names: Maps.extraNames(),
    userNames: Maps.userNames()
  };
  saveAccountsSync();
  return r;
}
/** 把已学的名字与使用者改过的名字都推给 core（幂等）。boot 时调一次。 */
function installMapNames() {
  const rec = mapNamesRecord();
  if (!rec) return 0;
  if (rec.names) Maps.applyExtra(rec.names);
  if (rec.userNames) Maps.applyUser(rec.userNames);
  return Maps.mapNameCounts().learned;
}
/** 使用者改一处地名：落 accounts.json + 让已有场次跟着改名（走 store 那条既有清算，不写第二套）。 */
async function editMapName(id, name, opts) {
  const o = opts || {};
  const target = String(id == null ? '' : id).trim();
  if (!/^\d{1,8}$/.test(target)) return { ok: false, error: '地图 id 不对：' + target };
  /* 动手之前先记住"这张图正显示着什么"：还原那半边要靠它对上库里那些场次（见 store.rollbackMapName） */
  const wasName = Maps.nameOf(target);
  const r = name == null || String(name).trim() === ''
    ? Maps.clearUserName(target) : Maps.setUserName(target, name);
  if (r.ignored) return { ok: false, error: '这个名字不能用（空、超过 40 字，或含尖括号与控制字符）' };
  const rec = mapNamesRecord();
  accounts.globalSettings.mapNames = {
    at: (rec && rec.at) || 0,
    names: Maps.extraNames(),
    userNames: Maps.userNames()
  };
  saveAccountsSync();
  /* 改名那一头 prune 自己会跟上（id 认得出）；还原那一头它够不着，这里补一刀 —— 两处都只算一次 */
  const touched = r.cleared && store ? store.rollbackMapName(target, wasName) : 0;
  const unknownBefore = store ? store.unknownMaps() : 0;
  if (store) await store.save();
  const st = mapNamesStatus();
  if (store && o.notify !== false) emit('mapNames:done', st);
  return Object.assign(st, { ok: true, applied: r.applied, cleared: r.cleared,
    renamed: touched + Math.max(0, unknownBefore - (store ? store.unknownMaps() : 0)) });
}
/** 设置页那块「本机字典」看的东西：三层计数 + 打过的每张图 + 我改过的那几条（含还原到哪个名字） */
function mapNamesDict() {
  const rec = mapNamesRecord();
  const c = Maps.mapNameCounts();
  const d = Maps.nameDict();
  return {
    ok: true, builtin: c.builtin, learned: c.learned, user: c.user,
    at: (rec && rec.at) || 0, never: !(rec && rec.at),
    unknown: store ? store.unknownMaps() : 0,
    usage: store ? store.mapUsage() : [],
    userEdits: d.user, learnedList: d.learned
  };
}
function mapNamesStatus() {
  const rec = mapNamesRecord();
  const c = Maps.mapNameCounts();
  return {
    ok: true, builtin: c.builtin, learned: c.learned, user: c.user, at: (rec && rec.at) || 0,
    /* 本机还挂着「未知地图」的场次：有号才问得出，没号就是 0 */
    unknown: store ? store.unknownMaps() : 0,
    never: !(rec && rec.at)
  };
}

/* 真正的一发：走 plugin-net 那套出网地板（只认 https + 标准 443、逐跳重校验、有字节上限与超时），
 * 域名清单只填 mapConfig 里那一个 host —— 换句话说这一发能走的路，比任何插件能走的都窄。
 * Cookie 用的是当场新建、用完就丢的空罐子：WeGame 的登录态在 session 分区里，物理上到不了这里。 */
async function pullMapNames(opts) {
  const o = opts || {};
  if (!MapConfig.okUrl(MapConfig.URL)) return { ok: false, error: '配置表地址不是允许的官方域名' };
  let r;
  try {
    r = await PluginNet.request({
      url: MapConfig.URL, method: 'GET',
      allowlist: [MapConfig.HOST],
      jar: PluginNet.createJar(),
      timeout: 15000,
      maxText: MapConfig.MAX_BYTES
    });
  } catch (e) { return { ok: false, error: '取配置表失败：' + ((e && e.message) || e) }; }
  if (!r.ok) return { ok: false, error: '配置表取不到（HTTP ' + (r.status || '?') + '）' };
  const parsed = MapConfig.parse(r.text);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const unknownBefore = store ? store.unknownMaps() : 0;
  const merged = learnMapNames(parsed.names, Date.now());
  /* 历史场次跟着改名走的是 store 里那条既有清算（prune 见到 id 已知就刷新 map_name），
   * 所以这里只需 save 一次即可让界面立刻变，不写第二套改名逻辑 */
  if (store) {
    await store.save();
    if (o.notify !== false) emit('mapNames:done', mapNamesStatus());
  }
  return Object.assign(mapNamesStatus(), {
    ok: true, added: merged.added, rows: parsed.count,
    renamed: Math.max(0, unknownBefore - (store ? store.unknownMaps() : 0))
  });
}

/* 出网唯一的入口：手动连点、启动那一次自动、以及两者撞车，都只会有一发在飞 */
function requestMapNamesPull() {
  if (!mapNamesPulling) {
    mapNamesPulling = pullMapNames({}).then(function (r) {
      mapNamesPulling = null; return r;
    }, function (e) {
      mapNamesPulling = null;
      return { ok: false, error: '更新失败：' + ((e && e.message) || e) };
    });
  }
  return mapNamesPulling;
}

/* ★ 「自动同步地图名」这一发，全代码库只有这一处会自动发。判据只有一颗：core/mapConfig.dueToRefresh
 *   （上次**真取到表**到现在超过一天 —— v1.8.2 起从"一辈子只有一次"改成"每天一次"，是他点的要求）。
 *   失败不记档 ⇒ 那次没网，下次启动照旧会再试；延迟 8 秒：别跟启动时的登录检查、自动同步、
 *   每日备份、在线更新检查挤在同一段时间里。 */
function autoPullMapNames() {
  setTimeout(function () {
    /* 自检与探针一律不许真出网（与自动同步同一口径：--live-sync 才是显式批准）——
     * 否则 npm test 的结果就要看腾讯那台 CDN 今天开不开门 */
    if (SELFTEST && !process.argv.includes('--live-sync')) return;
    const at = (mapNamesRecord() || {}).at || 0;
    if (!MapConfig.dueToRefresh(at, Date.now())) return;
    requestMapNamesPull();   /* 结果不追：状态行会老实显示「从未更新」，下次启动再试 */
  }, 8000);
}

/* ---------------- 在线更新 + 装机计数（合并成一发） ----------------
 * 判据全在 core/update.js 一处（这一发带什么参数、谁算新版本、这台机器报过没有）。
 * 这里只负责"打一发、按回包决定要不要提示、把状态推给界面"。
 *
 * 为什么合并：他要的"新用户打开软件 +1"与"有没有新版"是同一时机（启动），
 * 一次 GET 就把两件事办了 —— 第一次带 sec=启动软件（他那边的 +1），以后 sec 留空只查版本。
 * ★ 这一发不带任何用户内容：没有 uid、没有昵称、没有 openid，只有软件自己的事实（版本、平台）。
 *   参数名与形状由 core/update.noUserIdentity 钉着，多拼一个不认识的名字就当场拒。 */
/* 这一发出网走的还是 PluginNet 那一块地板（https + 标准端口 + 逐跳重校验 + 上限 + 超时），
 * 域名清单只填 core/update.js 里那一颗，cookie 罐当场新建、用完就丢 ⇒ 带不出任何登录态。
 * ★ 它**只问一句话**：软件自己是什么版本。所以这里没有任何写盘、下载、解压的零件 ——
 *   查到新版之后软件不动他的任何文件，只把"去哪儿下"告诉他（他自己下载整包覆盖安装）。 */
function startupRecord() {
  return (accounts.globalSettings && accounts.globalSettings.startup) || null;
}
function updateInfo() {
  return {
    platform: 'win', version: Plg.HOST_VERSION,
    firstReport: Update.shouldSend(startupRecord())
  };
}
/* 界面读的就是这一枚：查过没有、最新是哪一版、下载地址是什么。没有"我帮你装"这一档 */
const updateState = {
  checked: false, checking: false, action: 'none', latest: '', notes: '', force: 0,
  error: '', at: 0, download: '', size: 0, current: Plg.HOST_VERSION
};
function markStartupReported() {
  accounts.globalSettings = accounts.globalSettings || {};
  accounts.globalSettings.startup = Update.markSent(Date.now());
  saveAccountsSync();
}
async function checkForUpdate() {
  if (updateState.checking) return updateState;
  updateState.checking = true;
  const info = updateInfo();
  const target = Update.url(info.platform, info.version, info.firstReport);
  if (!Update.okUrl(target) || !Update.noUserIdentity(target)) {
    updateState.checking = false;
    updateState.error = '检查地址不合法（判据在 core/update.js）';
    pushUpdateState();
    return updateState;
  }
  let r, httpOk = false;
  try {
    r = await PluginNet.request({
      url: target, method: 'GET', allowlist: [Update.HOST],
      jar: PluginNet.createJar(), timeout: 10000, maxText: Update.MAX_TEXT
    });
    httpOk = !!(r && r.ok);
  } catch (e) { r = { ok: false, error: ((e && e.message) || e) }; }
  updateState.checking = false;
  updateState.checked = true;
  updateState.at = Date.now();
  /* 计数只看"这一发到底到了没有"：HTTP 成功就记档（他那边已经 +1 了）。
   * 回包格式不对是"有没有新版"那一半的事，不该让计数跟着白跑 —— 白跑的后果是一台机器被数两次。 */
  if (info.firstReport && httpOk) markStartupReported();
  const m = httpOk ? Update.parse(r.text) : { ok: false, error: '问不到（HTTP ' + ((r && r.status) || '?') + '）' };
  const p = Update.plan(m, Plg.HOST_VERSION);
  updateState.error = m.ok ? '' : String(m.error || '问不到');
  updateState.action = m.ok ? p.action : 'none';
  updateState.latest = (m.ok && m.version) || '';
  updateState.notes = (m.ok && m.notes) || '';
  updateState.force = (m.ok && m.force) ? 1 : 0;
  updateState.size = (m.ok && m.size) || 0;
  updateState.download = (m.ok && m.url) || '';
  pushUpdateState();
  return updateState;
}
/* ★ 状态一变就推给界面：原来只有"点了重新检查"那一路会推，自动那一发（启动 6 秒后）带着 quiet，
 *   量到的结果是宿主 checked:true 而界面还停在「还没检查过。」—— 他服务器没部署好那几天正是 404，
 *   这一句念不出来，"启动时问一次、有新版本在设置里念"就等于没做。安卓同一处是 onLocal('update:status')。 */
function pushUpdateState() { emit('update:status', Object.assign({}, updateState)); }
function autoCheckUpdate() {
  setTimeout(function () {
    /* 同一条自检红线：--selftest 不许真出网（探针与 npm test 的结果不该看那台服务器的脸色） */
    if (SELFTEST && !process.argv.includes('--live-sync')) return;
    checkForUpdate();
  }, 6000);
}

/* ---------------- IPC ---------------- */
/* ---------------- 插件宿主（懒初始化） ----------------
 * 必须在 app.ready 之后、且按当前 userDataDir 建：--selftest 会指向隔离目录。
 * pluginPreviews 存的是"已通过校验、等你勾权限"的临时预览，退出即失，从不落盘。
 */
let _pluginHost = null;
let _pluginApi = null;
const pluginPreviews = new Map();

function plugins() {
  if (!_pluginHost) _pluginHost = PluginHost({ userDataDir: userDataDir() });
  return _pluginHost;
}
function pluginApi() {
  if (!_pluginApi) {
    _pluginApi = createPluginApi({
      host: plugins(),
      getStore: function () { return store; },
      /* 流式回包只走这一条通道：渲染层收到后只转给当前绑定的那个沙箱 iframe，插件 id 再核一遍 */
      emit: function (pluginId, event, data) {
        emit('plugin:evt', { pluginId: pluginId, event: event, data: data || {} });
      },
      digest: function (id, args) { return digestChannel().run(id, args); },
      legacy: function (id) { return legacyChannel().take(id); },
      legacyInfo: function () { return legacyChannel().check(); }
    });
  }
  return _pluginApi;
}
/* ★ 撤销允许 / 停用 / 卸载都必须立刻掐掉正在跑的那条流：
 *   不然"撤销"只能挡住下一次请求，已经连上的还能继续吐十分钟的字。
 *   用 _pluginApi 判空：自检与从没用过插件的机器上不该为此把桥建起来。 */
function stopPluginStreams(id) {
  if (_pluginApi) { try { _pluginApi.abortAll(id); } catch (e) {} }
}
function pluginView(p) {
  return {
    id: p.id, name: p.name, version: p.version, description: p.description, author: p.author,
    entry: p.entry, script: p.script, permissions: p.permissions || [],
    consent: p.consent || null, consentGiven: !!p.consentGiven, consentAt: p.consentAt || '',
    autoTrigger: !!(p.autoTrigger && p.autoTrigger.on),
    pendingTrigger: p.pendingTrigger || null,
    enabled: !!p.enabled, imported_at: p.imported_at, packageHash: p.packageHash,
    permFp: p.permFp, totalSize: p.totalSize, fileCount: (p.fileHashes || []).length
  };
}
/* 插件页的唯一版式表。沙箱 iframe 读不到宿主的 app.css，所以这份文本随 plugin:page
 * 一起交给渲染层注入 —— 不另开一条 IPC，也不让插件自己去猜宿主的样式。 */
let pluginBaseCssCache = null;
function pluginBaseCss() {
  if (pluginBaseCssCache === null) {
    try {
      pluginBaseCssCache = fs.readFileSync(path.join(__dirname, '..', 'ui', 'css', 'plugin-base.css'), 'utf8');
    } catch (e) { pluginBaseCssCache = ''; }
  }
  return pluginBaseCssCache;
}

function pluginListView() {
  const host = plugins();
  const out = host.list().map(function (p) {
    const v = host.verifyFiles(p.id);
    return Object.assign({}, p, { intact: !!v.ok, intactMessage: v.message || '' });
  });
  const netOn = out.filter(function (p) {
    return p.enabled && (p.permissions || []).some(function (x) { return x.scope === 'net.request'; });
  });
  return {
    ok: true, hostVersion: Plg.HOST_VERSION, plugins: out,
    scopes: Plg.SCOPES, dir: host.rootDir,
    enabledCount: out.filter(function (p) { return p.enabled; }).length,
    netEnabledCount: netOn.length,
    netHosts: netOn.reduce(function (acc, p) {
      (p.permissions || []).forEach(function (x) {
        if (x.scope === 'net.request') (x.hosts || []).forEach(function (h) { if (acc.indexOf(h) === -1) acc.push(h); });
      });
      return acc;
    }, [])
  };
}

function registerIpc() {
  ipcMain.handle('app:boot', function () {
    if (!store || !collector) {
      return Promise.resolve({
        loggedIn: false, role: null, name: '', lastSync: 0,
        stats: { matches: 0, rosters: 0, players: 0 },
        matchCount: 0,
        settings: StoreMod.defaultState().settings,
        accounts: listAccountsView(),
        activeSlot: accounts.activeSlot,
        bootError: '尚未添加账号，请先登录 WeGame'
      });
    }
    /* ★ 这个号的库这一次到底读出来没有。读不出来时界面必须说"没读出来"，
     *   不许说"还没有数据" —— 后者会让人去点同步、甚至重装，而文件好好在原位。 */
    const fault = store.loadFault ? store.loadFault() : '';
    const faultText = fault ? ('这个号的战绩库这次没读出来：' + fault + ' —— 数据文件还在原位，别卸载重装；关掉再开一次通常就好') : '';
    /* 只读号（数据包导进来的）不去打网络：它没有 WeGame 会话，探一次只会白等 8 秒，
     * 然后把人挡在登录页外 —— 他刚导完数据，要看的就是这些数据。 */
    if (activeLocalOnly()) {
      return Promise.resolve({
        loggedIn: false, localOnly: true, role: store.state.role || null,
        name: store.state.meta.name, lastSync: store.state.meta.last_sync,
        stats: store.stats(),
        matchCount: Object.keys(store.state.matches || {}).length,
        settings: Object.assign({}, store.state.settings, accounts.globalSettings),
        /* 官方赛季号的默认值只有一份（core/collector.js 的 DEFAULT_SID），界面拿它写提示 */
        sidDefault: CollectorMod.DEFAULT_SID,
        accounts: listAccountsView(), activeSlot: accounts.activeSlot,
        bootError: faultText, storageFault: !!fault
      });
    }
    /* 登录检查失败不拦路：本机数据全都读得到，UI 会用 matchCount 给出「跳过」入口 */
    return Async.withTimeout(collector.checkLogin(), 8000, { ok: false, reason: 'timeout' })
      .then(function (r) {
        const stats = store.stats();
        const timedOut = r.reason === 'timeout';
        return {
          loggedIn: !!r.ok,
          loginPending: timedOut,
          loginError: r.ok ? '' : (timedOut ? '检查登录状态超时（网络不稳定）' : (r.message || r.reason || '')),
          role: r.ok ? r.role : (store.state.role || null),
          name: store.state.meta.name,
          lastSync: store.state.meta.last_sync,
          stats: stats,
          matchCount: Object.keys(store.state.matches || {}).length,
          settings: Object.assign({}, store.state.settings, accounts.globalSettings),
        /* 官方赛季号的默认值只有一份（core/collector.js 的 DEFAULT_SID），界面拿它写提示 */
        sidDefault: CollectorMod.DEFAULT_SID,
          accounts: listAccountsView(),
          activeSlot: accounts.activeSlot,
          bootError: faultText, storageFault: !!fault
        };
      });
  });

  ipcMain.handle('login:open', function (evt, payload) {
    const targetSlot = (payload && payload.slot) || null;
    /* ★ 这一发的回包里有 cleared：开窗之前把那个号的旧登录痕迹清干净了才算数，
     *   清不动也得让界面当场改口，不许挂着"已打开登录窗口"等人自己发现。 */
    return openLoginWindow(targetSlot);
  });

  ipcMain.handle('login:check', function () {
    if (!collector) return Promise.resolve({ ok: false, error: '未选择账号' });
    if (activeLocalOnly()) {
      return Promise.resolve({
        ok: false, localOnly: true,
        reason: '这个号是数据包导进来的，本机没有它的 WeGame 会话 —— 要更新数据请在电脑上同步后再导一次包'
      });
    }
    /* 离线横幅上的「重试」走这条通道：不能因为接口挂住而永远停在「检查中…」 */
    return Async.withTimeout(collector.checkLogin(), 10000,
      { ok: false, reason: 'timeout', message: '检查登录状态超时（网络不稳定）' });
  });

  ipcMain.handle('login:logout', function () {
    if (!wegameSession || !store) return Promise.resolve({ ok: false, error: '未选择账号' });
    return wegameSession.clearStorageData({ storages: ['cookies'] }).then(function () {
      store.state.role = null;
      return store.save().then(function () { return { ok: true, slot: accounts.activeSlot }; });
    });
  });

  ipcMain.handle('sync:run', function (evt, opts) { return runSync(opts || {}); });

  ipcMain.handle('data:report', function (evt, filters) {
    if (!store) return Promise.resolve(null);
    return Analysis.report(store, filters || {});
  });

  ipcMain.handle('data:matches', function (evt, filters) {
    if (!store) return [];
    var f = filters || {};
    var rows = store.matches({
      mode: f.mode || 'all',
      kind: f.kind || 'all',
      leave: f.leave || 'all',
      since: f.since,
      mapId: f.mapId,
      search: f.search,
      includeExcluded: true    // 战局列表保留「不纳入统计」的场次（灰显 + 徽标）；切到比赛/匹配时它自动不出现
    });
    /* 有没有全场名单、这场里有几个关注的人 —— 都只有主进程知道，界面不猜 */
    const watchMap = Analysis.watchedRoomMap(store);
    return rows.map(function (m) {
      return Object.assign({}, m, {
        force_name: m.force_type ? Maps.forceName(m.force_type) : '',
        /* 攻防身份（进攻/防守）判据在 core 一处（Analysis.sideOf），这里只是把字贴到行上 */
        side: Analysis.sideOf(m),
        hasRoster: !!store.state.rosters[m.room_id],
        /* 名单里哪几列官方还没填完（界面据此把救治排名/阵营合计留空并说明），判据在 core 一处 */
        rosterGaps: store.rosterGaps(m.room_id),
        watchedCount: watchMap[String(m.room_id)] || 0
      });
    });
  });

  ipcMain.handle('data:counts', function () {
    return store ? store.modeCounts()
      : { all: 0, swtwr: 0, commander: 0, other: 0, leave: 0, excluded: 0, comp: 0, practice: 0 };
  });

  /* 单场标注：key 只允许 commander / excluded / competition，真实值由 store 物化到 match 上 */
  ipcMain.handle('data:flag', function (evt, payload) {
    if (!store) return { ok: false, error: '未选择账号' };
    var roomId = payload && payload.roomId;
    var key = payload && payload.key;
    if (key !== 'commander' && key !== 'excluded' && key !== 'competition') {
      return { ok: false, error: '未知的标记类型' };
    }
    return store.setMatchFlag(roomId, key, payload.on);
  });

  /* 关注同场玩家：界面传回来的必须是 core 身份索引产出的聚合键，
   * 这里做第二道前缀校验（store 里还有一道），不让任意字符串进存储 */
  ipcMain.handle('data:watch', function (evt, payload) {
    if (!store) return { ok: false, error: '未选择账号' };
    var key = String((payload && payload.key) || '');
    if (!/^(id|nm):/.test(key)) {
      return { ok: false, error: key.indexOf('slot:') === 0
        ? '这个人的账号标识是当局临时编号，无法跨局识别，不能关注'
        : '无法识别的玩家标识' };
    }
    return store.setWatch(key, payload && payload.on, {
      openid: (payload && payload.openid) || '', name: (payload && payload.name) || ''
    });
  });

  ipcMain.handle('data:match', function (evt, roomId) {
    if (!store) return null;
    var cmp = Analysis.lobby(store, roomId);
    if (cmp) cmp.tips = Analysis.matchTips(store, roomId) || [];
    return cmp;
  });

  /* ★ 第二发参数是筛选栏那份条件（#87：交手档案以前跟着全库走，选了模式也纹丝不动）。
   *   不传 = 全库，与「对手与队友」那张表同一把尺子。 */
  ipcMain.handle('data:encounter', function (evt, vopenid, filters) {
    if (!store) return null;
    return Analysis.encounterDetail(store, vopenid, filters || {});
  });

  ipcMain.handle('data:export', function (evt, payload) {
    if (!store) return { ok: false, error: '未选择账号' };
    const fmt = (payload && payload.fmt) || 'json';
    const filters = payload && payload.filters;
    const openid = store.activeOpenid();
    const rows = store.matches({
      mode: (filters && filters.mode) || 'all',
      kind: (filters && filters.kind) || 'all',
      leave: (filters && filters.leave) || 'all'
    });
    const rep = Analysis.report(store, filters || {});
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const dir = app.getPath('documents');
    let file, content;

    if (fmt === 'csv') {
      const cols = ['dt_event_time', 'map_name', 'is_winner', 'kill', 'death', 'assist', 'kd',
        'kill_per_min', 'kda', 'score', 'score_per_min', 'occupy', 'rescue', 'game_time', 'is_leave', 'room_id'];
      const head = ['时间', '地图', '胜负', '击杀', '死亡', '助攻', 'KD', 'KPM', 'KDA', '得分',
        '分均得分', '占点（次）', '救治', '时长秒', '中途退出', '房间ID'];
      const body = rows.map(function (r) {
        const rt = Analysis.rating(r, store.players(r.room_id), openid);
        return cols.map(function (c) {
          let v = r[c];
          if (c === 'is_winner') v = v ? '胜' : '负';
          if (c === 'is_leave') v = v ? '是' : '否';
          return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        }).concat(['"' + rt.value + '"']).join(',');
      });
      content = '\ufeff' + [head.concat(['评分']).join(',')].concat(body).join('\n');
      file = path.join(dir, '战绩导出-' + stamp + '.csv');
    } else {
      content = JSON.stringify({
        exportedAt: Date.now(),
        filters: filters || {},
        report: rep,
        matches: rows.map(function (r) {
          const rt = Analysis.rating(r, store.players(r.room_id), openid);
          return Object.assign({}, r, { rating: rt.value, ratingBasis: rt.basis });
        }),
        rosters: store.state.rosters,
        flags: store.state.flags
      }, null, 1);
      file = path.join(dir, '战绩导出-' + stamp + '.json');
    }
    const fileFilters = fmt === 'csv'
      ? [{ name: 'CSV 表格', extensions: ['csv'] }]
      : [{ name: 'JSON 数据', extensions: ['json'] }];

    const r = dialog.showSaveDialogSync(mainWin, { defaultPath: file, filters: fileFilters });
    if (!r) return { ok: false, cancelled: true };
    try {
      fs.writeFileSync(r, content, 'utf8');
    } catch (e) {
      return { ok: false, error: '写入失败：' + ((e && e.message) || e) };
    }
    return { ok: true, path: r, count: rows.length };
  });

  ipcMain.handle('data:openFolder', function () {
    return shell.openPath(userDataDir()).then(function (err) {
      return err ? { ok: false, error: err } : { ok: true };
    }).catch(function (e) {
      return { ok: false, error: String((e && e.message) || e) };
    });
  });

  /* 清空数据：scope='current'（仅当前号）| 'all'（所有号 + accounts.json） */
  ipcMain.handle('data:reset', function (evt, payload) {
    const scope = (payload && payload.scope) || 'current';
    if (scope === 'all') {
      slots.forEach(function (inst) {
        try { fs.unlinkSync(dataFileFor(inst.slot)); } catch (e) { /* ignore */ }
      });
      slots.clear();
      try { fs.unlinkSync(accountsFile()); } catch (e) { /* ignore */ }
      accounts = { version: 2, activeSlot: '', globalSettings: defaultGlobalSettings(), accounts: [] };
      store = null; collector = null; wegameSession = null;
      saveAccountsSync();
      emit('account:changed', { slot: '', openid: '', name: '' });
      return Promise.resolve({ ok: true, scope: 'all' });
    }
    if (!store) return Promise.resolve({ ok: false, error: '未选择账号' });
    return store.reset().then(function () { return { ok: true, scope: 'current', slot: accounts.activeSlot }; });
  });

  ipcMain.handle('settings:set', function (evt, patch) {
    if (!store) return Promise.resolve({ ok: false, error: '未选择账号' });
    const split = splitSettings(patch || {});
    const gs = applyGlobalSettings(split.global);
    return store.setSettings(split.account).then(function () {
      if (split.account && ('autoSyncInterval' in split.account)) scheduleAutoSync();
      if (('autoBackup' in split.global) && split.global.autoBackup) ensureDailyBackup();
      return {
        ok: true,
        settings: Object.assign({}, store.state.settings, gs)
      };
    });
  });

  /* ---- 地图名：设置页的状态行、那颗「更新地图名」，以及本机字典的查看与编辑（#92） ---- */
  ipcMain.handle('mapNames:status', function () { return mapNamesStatus(); });
  ipcMain.handle('mapNames:refresh', function () {
    return requestMapNamesPull();   /* 「之后全手动」的那只手；闸门在 requestMapNamesPull 里 */
  });
  ipcMain.handle('mapNames:dict', function () { return mapNamesDict(); });
  ipcMain.handle('mapNames:setName', function (evt, payload) {
    /* 只往本机字典里写一个字：不出网、不动官方 id、也不碰内置表那 72 条实证值 */
    return editMapName(payload && payload.id, payload && payload.name);
  });

  /* ---- 在线更新（只提示，不动他的文件）----
   * 界面只有两颗手：再查一次 / 打开下载地址。判据、地址、下载全在这一侧之外，
   * 而"下载"这件事我们不做 —— 整包 115 MB，他自己去下、覆盖安装即可（数据在 APPDATA，动不到）。 */
  ipcMain.handle('update:status', function () {
    return Object.assign({ ok: true, reported: !!startupRecord() }, updateState);
  });
  ipcMain.handle('update:check', function () { return checkForUpdate(); });
  ipcMain.handle('update:openDownload', function (evt, payload) {
    /* 地址是服务器回的，这里只守一条：必须是 https（明文下载一个可执行整包不能接受）。
     * 打开动作交给系统浏览器 —— 主进程不下载、不解压、不落盘。 */
    const u = String((payload && payload.url) || updateState.download || '');
    if (!Update.cleanUrl(u)) return { ok: false, error: '下载地址不是合法的 https 地址' };
    shell.openExternal(u);
    return { ok: true };
  });

  /* ---- 数据包：导出 / 导入 ---- */
  ipcMain.handle('data:bundle', function () {
    if (!store) return { ok: false, error: '未选择账号' };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const bundle = Object.assign({
      type: 'df-swtwr-bundle',
      version: 2,
      exportedAt: Date.now(),
      app: app.getVersion(),
      slot: accounts.activeSlot,
      /* 带上本机学到的地图名（他批准的「导出包带上」）：换到另一台机器导入时，
       * 那些只有新图 id 的场次立刻就有名字，不必再等那台机器自己去取配置表。
       * 这是公开地名、零个人数据 —— 所以进包不需要额外的确认环节。 */
      map_names: (mapNamesRecord() || {}).names || {},
      /* ★ 也带上使用者自己起的名字：换机导入后那台机器不必重做一遍改名（#92）。
       * 仍是公开地名，零个人数据 —— 进包同样不需要额外确认。 */
      map_names_user: (mapNamesRecord() || {}).userNames || {}
    }, store.bundleView());
    const r = dialog.showSaveDialogSync(mainWin, {
      defaultPath: path.join(app.getPath('documents'), '战绩数据包-' + (store.state.meta.name || accounts.activeSlot) + '-' + stamp + '.json'),
      filters: [{ name: '数据包', extensions: ['json'] }]
    });
    if (!r) return { ok: false, cancelled: true };
    try {
      fs.writeFileSync(r, JSON.stringify(bundle), 'utf8');
    } catch (e) {
      return { ok: false, error: '写入失败：' + ((e && e.message) || e) };
    }
    return {
      ok: true, path: r,
      matches: Object.keys(bundle.matches).length,
      rosters: Object.keys(bundle.rosters).length
    };
  });

  ipcMain.handle('data:restore', function () {
    if (!store) return { ok: false, error: '未选择账号' };
    const files = dialog.showOpenDialogSync(mainWin, {
      properties: ['openFile'],
      filters: [{ name: '数据包', extensions: ['json'] }]
    });
    if (!files || !files.length) return { ok: false, cancelled: true };
    let bundle;
    try {
      bundle = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    } catch (e) {
      return { ok: false, error: '文件无法解析：' + ((e && e.message) || e) };
    }
    if (!bundle || (!bundle.matches && !bundle.rosters)) {
      return { ok: false, error: '这不是有效的数据包文件' };
    }
    return importBundle(bundle);
  });

  /* ---- 备份 ---- */
  ipcMain.handle('backup:now', function () { return doBackup('manual'); });

  ipcMain.handle('backup:info', function () {
    const dir = backupDir();
    let list = [], total = 0;
    try {
      const all = fs.readdirSync(dir).filter(isBackupName);
      total = all.length;
      list = all.map(function (f) {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        const info = StoreMod.parseBackupName(f) || {};
        return { name: f, size: st.size,
          /* 那一行的"什么时候备份的"取名字里那枚时刻：mtime 是从源文件抄来的（见 pruneBackups 那段），
           * 拿它当备份时刻会把"三天前最后同步的那个号"的每一份都标成三天前。文件没动过就更分不清。 */
          time: info.at || st.mtimeMs,
          slot: info.slot || '', tag: info.tag || '', at: info.at || 0,
          /* 这份里到底有什么：号、几场、跨度到哪天 —— 读的是备份文件本身，不猜 */
          sum: peekBackup(dir, f, st.size, st.mtimeMs) };
      }).sort(function (a, b) { return b.time - a.time; }).slice(0, 20);
    } catch (e) { /* 目录还不存在 = 还没备份过，界面那句实话由 count=0 来说 */ }
    /* 保留份数是**按号**各留 keep 份，所以"总共多少份"可以比 keep 大：两个数都给，
     * 界面才说得清"裁没裁、按什么裁"。 */
    return { dir: dir, list: list, count: list.length, total: total, keep: backupKeep() };
  });

  ipcMain.handle('backup:open', function () {
    const dir = backupDir();
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) { return { ok: false, error: '创建备份目录失败：' + ((e && e.message) || e) }; }
    return shell.openPath(dir).then(function (err) {
      return err ? { ok: false, error: err, dir: dir } : { ok: true, dir: dir };
    }).catch(function (e) {
      return { ok: false, error: String((e && e.message) || e), dir: dir };
    });
  });

  ipcMain.handle('backup:chooseDir', function () {
    const r = dialog.showOpenDialogSync(mainWin, { properties: ['openDirectory', 'createDirectory'] });
    if (!r || !r.length) return { ok: false, cancelled: true };
    applyGlobalSettings({ backupDir: r[0] });
    return { ok: true, dir: r[0] };
  });

  /* AI 深度分析不再是内置页：外发通道全在插件桥里（shell/plugin-api.js 的 ai.digest 与 net.stream），
   * 宿主这一侧只留上面那节「摘要 / 旧数据 / 待办」。这里刻意不留任何入口，出厂界面上看不出曾经有过这一页。 */

  /* ---- 战绩卡片 ---- */
  ipcMain.handle('card:save', function (evt, payload) {
    const dataUrl = (payload && payload.dataUrl) || '';
    if (!dataUrl) return { ok: false, error: '没有图片数据' };
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const r = dialog.showSaveDialogSync(mainWin, {
      defaultPath: path.join(app.getPath('pictures'),
        (payload && payload.name) || ('战绩卡片-' + Date.now() + '.png')),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    });
    if (!r) return { ok: false, cancelled: true };
    try {
      fs.writeFileSync(r, Buffer.from(b64, 'base64'));
      return { ok: true, path: r };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('card:copy', function (evt, payload) {
    const dataUrl = (payload && payload.dataUrl) || '';
    if (!dataUrl) return { ok: false, error: '没有图片数据' };
    try {
      clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('app:info', function () {
    return {
      dataFile: currentDataFile(),
      accountsFile: accountsFile(),
      backupDir: backupDir(),
      activeSlot: accounts.activeSlot,
      version: app.getVersion(),
      maps: Maps.tdmIds.length,
      swwrMaps: Maps.swtwrIds.length,
      sandboxUrl: SANDBOX_URL
    };
  });

  /* ---- 关于页 / 地图沙盘的外部动作：地址与群号只在主进程，渲染层无权传入 ---- */
  function openExternal(url) {
    return shell.openExternal(url)
      .then(function () { return { ok: true }; })
      .catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
  }
  ipcMain.handle('app:openGithub', function () { return openExternal(GITHUB_URL); });
  ipcMain.handle('app:openSandbox', function () { return openExternal(SANDBOX_URL); });
  ipcMain.handle('app:copyGroup', function () {
    try {
      clipboard.writeText(QQ_GROUP);
      return { ok: true, text: QQ_GROUP };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  /* ============ 多账号 IPC ============ */
  ipcMain.handle('account:list', function () { return { ok: true, activeSlot: accounts.activeSlot, accounts: listAccountsView() }; });

  ipcMain.handle('account:add', function () {
    const slot = nextFreeSlot();
    /* 这一发同样是"打开登录浏览器"，回包形状与 login:open 保持一致（带 cleared） */
    return openLoginWindow(slot).then(function (r) {
      return { ok: true, slot: slot, cleared: r.cleared, clearError: r.clearError,
        storageFault: r.storageFault };
    });
  });

  ipcMain.handle('account:switch', function (evt, slot) {
    return switchTo(slot);
  });

  ipcMain.handle('account:logout', function (evt, slot) {
    slot = slot || accounts.activeSlot;
    const inst = slots.get(slot);
    if (!inst) return Promise.resolve({ ok: false, error: 'slot 不存在' });
    return inst.session.clearStorageData({ storages: ['cookies'] })
      .then(function () { return { ok: true, slot: slot }; });
  });

  ipcMain.handle('account:remove', function (evt, slot) {
    if (!slot) return Promise.resolve({ ok: false, error: '未指定 slot' });
    if (accounts.accounts.length <= 1) {
      return Promise.resolve({ ok: false, error: '至少保留一个账号。如需清空，请使用「清空所有账号数据」。' });
    }
    const idx = accounts.accounts.findIndex(function (a) { return a.slot === slot; });
    if (idx === -1) return Promise.resolve({ ok: false, error: 'slot 不存在：' + slot });
    const inst = slots.get(slot);
    if (inst) {
      try {
        if (inst.session && inst.session.clearStorageData) {
          inst.session.clearStorageData({ storages: ['cookies'] });
        }
      } catch (e) { /* ignore */ }
      slots.delete(slot);
    }
    try { fs.unlinkSync(dataFileFor(slot)); } catch (e) { /* ignore */ }
    accounts.accounts.splice(idx, 1);
    let partitionPathHint = '';
    try {
      partitionPathHint = path.join(userDataDir(), slot ? ('Partitions' + path.sep + 'wegame-slot-' + slot) : '');
    } catch (e) { /* ignore */ }
    if (accounts.activeSlot === slot) {
      const next = accounts.accounts[0];
      return switchTo(next ? next.slot : '').then(function () {
        saveAccountsSync();
        return {
          ok: true, removed: slot, activeSlot: accounts.activeSlot,
          partitionPathHint: partitionPathHint,
          message: partitionPathHint
            ? '已移除，登录分区残留请手动清理：' + partitionPathHint
            : '已移除'
        };
      });
    }
    saveAccountsSync();
    return Promise.resolve({
      ok: true, removed: slot, activeSlot: accounts.activeSlot,
      partitionPathHint: partitionPathHint,
      message: '已移除。若曾登录过该号，可手动清理分区目录：' + partitionPathHint
    });
  });

  ipcMain.handle('account:globalSettings', function (evt, patch) {
    if (patch && Object.keys(patch).length) applyGlobalSettings(patch);
    return { ok: true, globalSettings: accounts.globalSettings };
  });

  /* ---------------- 扩展插件 ----------------
   * 出厂时 plugins 目录是空的，界面上也就没有任何插件功能；插件由用户自己找来导入。
   * 渲染层能做的只有：拿清单、选文件（文件路径由主进程弹框得到）、勾选权限、启用/禁用/卸载。
   * zip 字节与解包内容都不出主进程 —— 页面只拿到最终要显示进 iframe 的 html/script 文本。
   */
  ipcMain.handle('plugin:list', function () { return pluginListView(); });

  ipcMain.handle('plugin:inspect', function () {
    const files = dialog.showOpenDialogSync(mainWin, {
      properties: ['openFile'],
      filters: [{ name: '插件包', extensions: ['zip'] }]
    });
    if (!files || !files.length) return { ok: false, cancelled: true };
    let buf;
    try { buf = fs.readFileSync(files[0]); } catch (e) { return { ok: false, error: '读不到这个文件：' + ((e && e.message) || e) }; }
    if (buf.length > 16 * 1024 * 1024) return { ok: false, error: '插件包超过 16 MB，不接受' };
    const preview = plugins().inspectWithBuffers(buf);
    if (!preview.ok) return { ok: false, error: preview.message, stage: preview.stage };
    const token = 'pv' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    pluginPreviews.set(token, { preview: preview, at: Date.now(), source: path.basename(files[0]) });
    if (pluginPreviews.size > 6) {
      const oldest = Array.from(pluginPreviews.keys()).sort(function (a, b) {
        return pluginPreviews.get(a).at - pluginPreviews.get(b).at;
      });
      oldest.slice(0, pluginPreviews.size - 6).forEach(function (k) { pluginPreviews.delete(k); });
    }
    /* 预览里只留展示需要的字段：字节、buf、raw 都不过 IPC */
    return {
      ok: true, token: token, source: path.basename(files[0]),
      manifest: preview.manifest, permissions: preview.manifest.permissions,
      permFp: preview.permFp, packageHash: preview.packageHash,
      files: preview.files.map(function (f) { return { name: f.name, size: f.size, hash: f.hash }; }),
      fileCount: preview.fileCount, totalSize: preview.totalSize,
      replaced: !!plugins().find(preview.manifest.id)
    };
  });

  ipcMain.handle('plugin:install', function (evt, payload) {
    const p = payload || {};
    const hit = pluginPreviews.get(String(p.token || ''));
    if (!hit) return { ok: false, error: '权限确认已过期，请重新选择插件包' };
    pluginPreviews.delete(String(p.token || ''));
    const r = plugins().install(hit.preview, {
      acceptedScopes: Array.isArray(p.acceptedScopes) ? p.acceptedScopes : [],
      source: hit.source
    });
    if (!r.ok) return { ok: false, error: r.message };
    return { ok: true, plugin: pluginView(r.plugin), list: pluginListView() };
  });

  ipcMain.handle('plugin:setEnabled', function (evt, payload) {
    const p = payload || {};
    if (!p.on) stopPluginStreams(String(p.id || ''));
    const r = plugins().setEnabled(String(p.id || ''), !!p.on);
    return r.ok ? { ok: true, plugin: pluginView(r.plugin), list: pluginListView() }
                : { ok: false, error: r.message, list: pluginListView() };
  });

  /* ★ 外发确认：这句话由用户在**宿主**这里逐字输入，判定发生在主进程。
   * 插件页面里自己画的输入框一概不算数 —— 那是本软件替你往外发的唯一放行凭据。
   * 撤销时顺手清掉它的会话 Cookie：那是活的登录凭证，留着没意义。
   * 还要顺手掐掉它手上正跑着的那条流：撤销只对"下一次"生效等于没撤销。 */
  ipcMain.handle('plugin:consent', function (evt, payload) {
    const p = payload || {};
    const id = String(p.id || '');
    if (p.revoke) stopPluginStreams(id);
    const r = p.revoke ? plugins().revokeConsent(id)
                       : plugins().grantConsent(id, String(p.sentence || ''));
    if (!r.ok) return { ok: false, error: r.message, list: pluginListView() };
    if (p.revoke) plugins().cookieWrite(id, {});
    const rec = plugins().find(id);
    return { ok: true, plugin: rec ? pluginView(rec) : null, list: pluginListView() };
  });

  ipcMain.handle('plugin:remove', function (evt, payload) {
    const id = String((payload || {}).id || '');
    stopPluginStreams(id);
    const r = plugins().remove(id);
    return r.ok ? { ok: true, list: pluginListView() } : { ok: false, error: r.message };
  });

  ipcMain.handle('plugin:verify', function (evt, payload) {
    const r = plugins().verifyFiles(String((payload || {}).id || ''));
    return { ok: !!r.ok, message: r.message || '' };
  });

  ipcMain.handle('plugin:page', function (evt, payload) {
    const r = plugins().pageAssets(String((payload || {}).id || ''));
    if (!r.ok) return { ok: false, error: r.message, baseCss: pluginBaseCss() };
    if (r.hash.html !== r.hash.declared[0] || r.hash.script !== r.hash.declared[1]) {
      return { ok: false, error: '插件内容与登记哈希不一致，已拒绝加载', baseCss: pluginBaseCss() };
    }
    return {
      ok: true, plugin: r.plugin, html: r.html, script: r.script,
      baseCss: pluginBaseCss(),
      hostVersion: Plg.HOST_VERSION
    };
  });

  ipcMain.handle('plugin:call', function (evt, payload) {
    const p = payload || {};
    return pluginApi().dispatch(String(p.pluginId || ''), String(p.method || ''), p.args || {});
  });
}

function listAccountsView() {
  return accounts.accounts.map(function (a) {
    const inst = slots.get(a.slot);
    const st = inst ? inst.store.state : null;
    let file = dataFileFor(a.slot);
    let exists = false;
    try { exists = fs.existsSync(file); } catch (e) { /* ignore */ }
    return {
      slot: a.slot,
      openid: a.openid || '',
      name: a.name || '',
      area: a.area || 36,
      partition: a.partition || partitionFor(a.slot),
      created_at: a.created_at || 0,
      last_sync: (st && st.meta.last_sync) || a.last_sync || 0,
      matches: st ? Object.keys(st.matches || {}).length : 0,
      rosters: st ? Object.keys(st.rosters || {}).length : 0,
      fileExists: exists,
      imported: !!a.imported,
      active: a.slot === accounts.activeSlot
    };
  });
}

/* ---------------- 启动 ---------------- */
app.whenReady().then(function () {
  const bootLog = [];
  function mark(s) { bootLog.push(s); }
  function dumpBoot(extra) {
    if (!SELFTEST) return;
    try {
      const p = selftestOutPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(Object.assign({
        phase: 'boot', boot: bootLog,
        dataFile: currentDataFile(),
        accountsFile: accountsFile(),
        activeSlot: accounts.activeSlot
      }, extra || {}), null, 1), 'utf8');
    } catch (e) { /* ignore */ }
  }

  try {
    mark('ready');
    guardEmbeddedContents();

    // 1. 迁移 v1 → v2
    const mig = migrateV1IfNeeded();
    mark('migration:' + (mig.ran ? 'ran' : 'skip') + ':' + (mig.targetSlot || '-') + ':' + mig.moved);

    // 2. 载入 accounts.json（若刚迁移过则已在内存中）
    if (!loadAccountsSync()) mark('accounts-empty');

    // 2.1 本机学名表推进 core —— 必须早于 switchTo：
    //     store.load 里那次 prune 就是靠它把历史场次的地图名一起刷对的（晚一步这一轮就白等）
    mark('map-names:' + installMapNames());

    // 2.2 旧版 AI 记录只做诊断：这一版不加载它，也不会有任何东西替它外发
    const legacy = legacyChannel().check();
    mark('ai-legacy:' + (legacy.hasConfig ? 'config' : '-') + (legacy.archived ? '+archived' : ''));

    // 2.5 继承 v1 登录态：必须在 switchTo() 绑定分区之前完成
    if (!accounts.activeSlot && accounts.accounts.length) accounts.activeSlot = accounts.accounts[0].slot;
    const adopted = adoptLegacySession(accounts.activeSlot);
    mark('session-adopt:' + (adopted.ran ? 'ran' : 'skip') + ':' + adopted.message);

    // 3. 注册 IPC + 建窗口（早于 store.load，保证 load 失败仍能报错）
    try {
      registerIpc();
      mark('ipc-ready');
      createMainWindow();
      mark('window-created');
      autoPullMapNames();          /* ★ 地图名字典：距上次真取到表超过一天才自动取一次 */
      autoCheckUpdate();           /* ★ 在线更新 + 装机计数（同一发；第一次带 sec，之后只查版本） */
    } catch (e) {
      mark('ERR-init: ' + ((e && e.stack) || e));
      dumpBoot({ ok: false, error: 'IPC/窗口初始化失败：' + ((e && e.message) || e) });
    }

    // 4. 载入活动 slot
    if (accounts.activeSlot) {
      switchTo(accounts.activeSlot).then(function (r) {
        if (!r.ok) {
          emit('boot:error', { error: r.error || '账号加载失败' });
          return;
        }
        mark('store-loaded');
        emit('boot:ready', {
          dataFile: currentDataFile(),
          accountsFile: accountsFile(),
          activeSlot: accounts.activeSlot,
          accounts: listAccountsView(),
          migration: mig
        });
        setTimeout(ensureDailyBackup, 4000);
        setInterval(ensureDailyBackup, 60 * 60 * 1000);
        if (SELFTEST && !mainWin) dumpBoot({ ok: false, error: '窗口未创建' });
      }).catch(function (e) {
        emit('boot:error', { error: '数据文件读取失败：' + ((e && e.message) || e) });
      });
    } else {
      // 无账号：主窗口显示登录页
      emit('boot:ready', {
        dataFile: currentDataFile(),
        accountsFile: accountsFile(),
        activeSlot: '',
        accounts: [],
        migration: mig,
        needLogin: true
      });
    }
  } catch (e) {
    mark('ERR-boot: ' + ((e && e.stack) || e));
    dumpBoot({ ok: false, error: String((e && e.message) || e) });
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('second-instance', function () {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
