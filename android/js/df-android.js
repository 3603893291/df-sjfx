'use strict';
/* df-android.js — 安卓上「壳」的 JS 那一半
 *
 * 桌面端的分工是：ui/（渲染层）→ window.df（preload）→ ipc → shell/main.js → core/。
 * 安卓只有一个 WebView，没有主进程，所以这一份文件把两头接起来：
 *
 *   · 数据与分析：core/ 的同一份源码直接在这个页面里跑（Store / Collector / Analysis / Maps）。
 *     判定逻辑一行都不重写 —— 这是「跟正常电脑端的一样」唯一靠得住的解释。
 *   · 磁盘、Cookie、出网、登录窗、导出、剪贴板：只有原生能做的事，全部过 AndroidBridge 这一个洞。
 *     Java 侧不看业务、只做通道 + 独立复算安全判定（外发闸门在 #34 那一层）。
 *
 * ★ 有一条桌面端的规矩在这里必须改口径，改得很明确：
 *   「渲染层永不加载 core/*」在安卓做不到 —— 没有第二个 JS 世界。
 *   留着的是它的实质：**ui/js/* 只许通过 window.df 拿数据，一行都不许碰 DFCore**，
 *   这条由 test/isolation.test.js 里新增的红线钉住（ui 侧出现 DFCore 字样就红）。
 *   真正的安全边界从来不在这里，在「插件页是 null-origin 沙箱」+「出网只认 Java 那一道」。
 *
 * 运行前提（由 tools/build-android-assets.js 注进 index.html）：
 *   本文件排在 core/*.js 之后、ui/js/*.js 之前，且 core 全部挂上了 window.DFCore。
 */
(function (global) {
  var Core = global.DFCore;
  var Native = global.AndroidBridge || null;
  var ALLOW_EVENTS = ['sync:start', 'sync:progress', 'sync:done', 'sync:auto',
    'login:done', 'login:probe', 'login:window-closed', 'boot:ready', 'boot:error',
    'account:changed', 'plugin:evt', 'mapNames:done',
    'update:status'];

  /* 关于页那三样：地址与群号只在"壳"这一侧，界面只能打按钮（与 shell/main.js 同一口径、同一份值）。
   * ★ 不许在这里另起一个 URL：上一版凭印象写了 github 首页和 WeGame 助手页，等于把用户的入口换掉了。 */
  var GITHUB_URL = 'https://github.com/3603893291/';
  var QQ_GROUP = '129994517';
  /* 沙盘地址与桌面 shell/main.js 逐字相等（安卓这一侧不内嵌：WebView 里没有 <webview>，
   * 点这颗就是交给系统浏览器 —— 所以桌面那条「压掉对方第一个弹窗」的 CSS 在手机上做不到，
   * 也不许在这里偷偷注：那不是我们的页面，是对方在浏览器里自己的站。 */
  var SANDBOX_URL = 'https://aeuicey.github.io/DeltaForce-TacticalPanel/';

  /* ★ 桥令牌：只随首页 URL 进主框（MainActivity 生成）。
   *   插件页是同 WebView 里的 null 源沙箱帧，而 addJavascriptInterface 注入的对象在子框里也看得见 ——
   *   没有这颗令牌，装进来的插件就能绕过宿主所有权限判定，一把 fs.read 把战绩库读走。 */
  var BRIDGE_TOKEN = (function () {
    try {
      var m = /[?&]bt=([0-9a-f]{16,64})/i.exec((global.location && global.location.search) || '');
      return m ? m[1] : '';
    } catch (e) { return ''; }
  })();

  /* ------------------------------------------------ 原生通道 */

  var pending = {}, seq = 1;
  /* 每次原生调用都带一个看门狗：没有它，"Java 没回话"长得和"转圈中"一模一样，
   * 界面会永远停在那儿（离线跑测试时它就表现成进程静默退出、一句话都不打）。
   * 45s 是量出来的：采集单页的读超时 30s、登录探针 8s/10s，都要能在它之前回话。 */
  var BRIDGE_TIMEOUT = 45000;
  /* ★ 等"人"的通道不能跟等"机器"的共用一颗表。2026-09-24 在 MuMu 上实测：
   *   在系统「另存为」面板里翻目录超过 45 秒，页面就先报「原生通道 card.save 没回话」，
   *   而原生那一边稍后照样把文件写好并回执 —— 报错了其实没失败，比不报更糟。
   *   这几条的回话时刻由手指决定，给 15 分钟；真卡住的情况由"面板关了就回 cancelled"兜。 */
  var HUMAN_TIMEOUT = 900000;
  /* ★ 只列"Java 侧不立即回执、等 onActivityResult"的那几条（test/android-shim.test.js 里
   *   有一条红线拿 Java 的 `return null` 反着对这张表）。login.open 刻意不在里面：
   *   它是"开完登录窗立刻回 ok"，登录结果走 login:done 事件回来，不该拿 15 分钟兜着。 */
  var HUMAN_CHANNELS = { 'file.pick': 1, 'export.save': 1, 'card.save': 1 };
  function to(channel, args) {
    return new Promise(function (resolve) {
      if (!Native) { resolve({ ok: false, error: '没有原生桥（这不是在 APK 里打开的）' }); return; }
      /* 没令牌就别发出去：原生一定不受理，等 45 秒才回错误是把一件事拖成十件 */
      if (!BRIDGE_TOKEN) {
        resolve({ ok: false, error: '没有桥令牌（页面不是从壳里打开的）' });
        return;
      }
      var id = seq++;
      var limit = HUMAN_CHANNELS[channel] ? HUMAN_TIMEOUT : BRIDGE_TIMEOUT;
      var timer = setTimeout(function () {
        if (!pending[id]) return;
        delete pending[id];
        resolve({ ok: false, error: '原生通道 ' + channel + ' 没回话（超过 ' +
          Math.round(limit / 1000) + ' 秒）' });
      }, limit);
      pending[id] = function (v) { clearTimeout(timer); resolve(v); };
      try {
        Native.call(channel, JSON.stringify(args || {}), id, BRIDGE_TOKEN);
      } catch (e) {
        clearTimeout(timer);
        delete pending[id];
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }
  /* 回包统一走这一条：Java 侧 evaluateJavascript('__reply(id, 字符串)') */
  global.__reply = function (id, text) {
    var f = pending[id];
    delete pending[id];
    if (!f) return;
    try { f(text == null ? null : JSON.parse(text)); }
    catch (e) { f(text == null ? null : { ok: true, raw: String(text) }); }
  };

  var listeners = {};
  var rawHooks = [];
  function onLocal(name, payload) {
    (listeners[name] || []).forEach(function (cb) {
      try { cb(payload); } catch (e) { /* 一个订阅者抛错不该带走别人 */ }
    });
  }
  /* 内部模块（插件宿主）要收原生推来的事件流，又不该挤进界面那份事件白名单：另开一条 */
  function onRaw(cb) { rawHooks.push(cb); }
  global.__nativeEvent = function (name, payload) {
    /* ★ 登录窗一关就把轮询停下来：桌面是 `loginWin.on('closed') → stopLoginWatch()`，
     *   安卓这一侧以前没人停 —— 关掉窗之后照样每 1.5 秒打一发，打到进程死为止。
     *   这一版一轮是两发（QQ + 微信），不停就更贵；停在这里与桌面是同一个时机。 */
    if (name === 'login:window-closed') { stopPolling(); pendingSlot = ''; pollSlot = ''; }
    rawHooks.forEach(function (cb) {
      try { cb(name, payload); } catch (e) { /* 一条钩子抛错不带走别的 */ }
    });
    onLocal(name, payload);
  };

  /* ------------------------------------------------ 读盘的地基：三种结果必须分得开 */

  /* 「没有这个文件」「这个文件读不出来」「读到了」是三件事。合成一件就是使用者报的那条路：
   * 读失败被当成"这台机器还没有数据"，界面显示空，随后任何一次保存把还有救的库原地盖掉
   * —— 他只能卸载重装（而卸载会把私有目录一起清掉），还得从电脑再导一次包。
   * faults 是一本账：哪个文件读不出来、为什么。有账在这儿的文件，这一版之后一律不许再写。 */
  var faults = {};
  function readOnce(name) {
    return to('fs.read', { name: name }).then(function (r) {
      if (!r) return { fault: '原生没回话' };
      if (r.ok === false) return { fault: String(r.error || '读不出来') };
      if (r.missing === true) return { missing: true };
      return { text: r.text == null ? '' : String(r.text) };
    });
  }
  function readText(name) {
    return readOnce(name).then(function (r) {
      if (!r.fault) { delete faults[name]; return r; }
      /* 先重问一次再定论：这条路上真有瞬态（原生正忙、文件正在落盘），一次就过的不必下结论 */
      return readOnce(name).then(function (r2) {
        if (r2.fault) { faults[name] = r2.fault; return { fault: r2.fault }; }
        delete faults[name];
        return r2;
      });
    });
  }
  function faultNote() {
    var names = Object.keys(faults);
    if (!names.length) return '';
    return '本机文件读不出来（' + names.map(function (n) {
      return n + '：' + faults[n];
    }).join('；') + '）。这不是"没有数据" —— 已经停掉对这些文件的写入，免得把你原有的东西盖掉。' +
      '先把软件整个关掉再打开试一次；别卸载重装 —— 卸载会把这些文件一起清掉。';
  }
  /* 写之前的那道闸：读不出来的文件不许被覆盖（fs.remove 是使用者明确按「清空」，不走这一条） */
  function writeBlocked(name) {
    return faults[name]
      ? { ok: false, error: '「' + name + '」这次没读动，先不写：' + faults[name] } : null;
  }

  /* ------------------------------------------------ 账号注册表（对应 main.js 的 accounts.json） */

  var ACCT_FILE = 'accounts.json';
  var accounts = { version: 1, activeSlot: '', globalSettings: {}, accounts: [] };
  function saveAccounts() {
    /* ★ 闸门：这一发没读动就先别写。拿一份内存里的空表盖掉 accounts.json，
     *   他机器上所有号就一起没了 —— 这正是"只能重装"那种局面的来路。 */
    var blocked = writeBlocked(ACCT_FILE);
    if (blocked) return Promise.resolve(blocked);
    return to('fs.write', { name: ACCT_FILE, text: JSON.stringify(accounts, null, 1) });
  }
  function loadAccounts() {
    return readText(ACCT_FILE).then(function (r) {
      if (!r.text) return;
      try {
        var o = JSON.parse(r.text);
        if (o && Array.isArray(o.accounts)) accounts = Object.assign(accounts, o);
      } catch (e) { /* 坏文件按空表继续，别一开屏就死 */ }
    });
  }
  function slotOf(id) { return 'm' + String(id).slice(-8); }
  function acctOf(slot) {
    for (var i = 0; i < accounts.accounts.length; i++) {
      if (accounts.accounts[i].slot === slot) return accounts.accounts[i];
    }
    return null;
  }
  function dataFile(slot) { return 'df-swtwr-' + slot + '.json'; }
  /* ★ 回的是**数组**，字段名与 shell/main.js 的 listAccountsView() 逐字对齐。
   *   界面拿 boot().accounts 直接 forEach（ui/js/app.js renderAccountSwitch），
   *   上一版这里回的是 {list:[…]} 对象 → 每次开机抛「(list || []).forEach is not a function」，
   *   而且抛在 refresh() 之前，于是"启动失败"+"看不到数据"是同一个根因。 */
  function accountsView() {
    return accounts.accounts.map(function (a) {
      /* 当前号以**已载入的 store** 为准（注册表里那份是上次落库时的快照，刚同步完没回写就会报 0 场）；
       * 别的号这台机器上没载入过，只能读缓存 —— 桌面 listAccountsView 也是这个口径。 */
      var live = (a.slot === accounts.activeSlot && store && store.state) ? store.state : null;
      return {
        slot: a.slot,
        openid: a.openid || '',
        name: a.name || '',
        area: a.area || 36,
        partition: a.partition || 'webview:shared',
        created_at: a.created_at || 0,
        last_sync: live ? (live.meta.last_sync || a.last_sync || 0) : (a.last_sync || 0),
        matches: live ? Object.keys(live.matches || {}).length : (a.matches || 0),
        rosters: live ? Object.keys(live.rosters || {}).length : (a.rosters || 0),
        fileExists: !!a.hasFile || !!live,
        imported: !!a.imported,
        active: a.slot === accounts.activeSlot
      };
    });
  }
  /* df.accounts.list() 的返回形状 = 桌面 'account:list' 那颗 handler */
  function accountsPayload() {
    return { ok: true, activeSlot: accounts.activeSlot, accounts: accountsView() };
  }
  function acctOfOpenid(openid) {
    openid = String(openid || '');
    if (!openid) return '';
    for (var i = 0; i < accounts.accounts.length; i++) {
      if (String(accounts.accounts[i].openid) === openid) return accounts.accounts[i].slot;
    }
    return '';
  }
  /* ★ 只读号 = 数据包导进来的号。桌面上每个号有自己的 cookie 分区，这层是天然分开的；
   *   安卓整机只有一个共享 CookieManager，验出来的登录态永远属于「手机登录的那个号」。
   *   所以在这里，「这个号不能同步」不是提示，是必须执行的判定 —— 不然一次同步就把 A 的场次写进 B 的库。 */
  function activeLocalOnly() {
    var a = acctOf(accounts.activeSlot);
    return !!(a && a.imported);
  }

  /* ------------------------------------------------ 地图名：官方公开配置表 → 本机学名表
   * 与桌面 shell/main.js 那一节逐条对齐：同一份 core/mapConfig.js 定 URL 与解析口径，
   * 同一个 accounts.globalSettings.mapNames 落点，同一套触发口径 ——
   * **首次使用自动取一次，之后全手动**（设置页那颗按钮），同步流程里一律不捎带这一发。
   * 出网走原生的 cfg.mapNames：Java 侧只认那一台 CDN、只许 GET、带不出 cookie（见 DfBridge.java）。 */
  var mapNamesPulling = null;
  function mapNamesRecord() {
    var rec = accounts.globalSettings && accounts.globalSettings.mapNames;
    return (rec && typeof rec === 'object') ? rec : null;
  }
  /** 一批名字并进本机字典并落盘（清洗与内置优先都在 Maps.applyExtra 里）
   * @param {number} [at] 只在真取到了官方配置表时传 —— 它是「首次自动一次」唯一的判据 */
  function learnMapNames(names, at) {
    var merged = Core.Maps.applyExtra(names);
    if (!merged.added && !at) return merged;
    var rec = mapNamesRecord();
    accounts.globalSettings = accounts.globalSettings || {};
    accounts.globalSettings.mapNames = {
      at: at || (rec && rec.at) || 0,
      names: Core.Maps.extraNames(),
      /* ★ 使用者自己改的名字单独一层，永远不被「更新地图名」盖掉（#92，与桌面同形） */
      userNames: Core.Maps.userNames()
    };
    saveAccounts();
    return merged;
  }
  /** 导入包带来的「我自己起的名字」：与本机改名同一条清洗，同样不顶 at（#92，与桌面同形） */
  function learnUserNames(names) {
    var r = Core.Maps.applyUser(names);
    if (!r.applied && !r.cleared) return r;
    var rec = mapNamesRecord();
    accounts.globalSettings = accounts.globalSettings || {};
    accounts.globalSettings.mapNames = {
      at: (rec && rec.at) || 0,
      names: Core.Maps.extraNames(),
      userNames: Core.Maps.userNames()
    };
    saveAccounts();
    return r;
  }
  function installMapNames() {
    var rec = mapNamesRecord();
    if (!rec) return 0;
    if (rec.names) Core.Maps.applyExtra(rec.names);
    if (rec.userNames) Core.Maps.applyUser(rec.userNames);
    return Core.Maps.mapNameCounts().learned;
  }
  /** 使用者改一处地名：落 accounts + 让已有场次跟着改名（走 store 那条既有清算，不写第二套） */
  function editMapName(id, name) {
    var target = String(id == null ? '' : id).trim();
    if (!/^\d{1,8}$/.test(target)) return Promise.resolve({ ok: false, error: '地图 id 不对：' + target });
    /* 与桌面同形：先记住"这张图正显示着什么"，还原那半边要对上库里那些场次 */
    var wasName = Core.Maps.nameOf(target);
    var r = name == null || String(name).trim() === ''
      ? Core.Maps.clearUserName(target) : Core.Maps.setUserName(target, name);
    if (r.ignored) {
      return Promise.resolve({ ok: false, error: '这个名字不能用（空、超过 40 字，或含尖括号与控制字符）' });
    }
    var rec = mapNamesRecord();
    accounts.globalSettings = accounts.globalSettings || {};
    accounts.globalSettings.mapNames = {
      at: (rec && rec.at) || 0,
      names: Core.Maps.extraNames(),
      userNames: Core.Maps.userNames()
    };
    var touched = r.cleared && store && store.state ? store.rollbackMapName(target, wasName) : 0;
    var unknownBefore = store && store.state ? store.unknownMaps() : 0;
    return saveAccounts().then(function () {
      return store && store.state ? store.save() : Promise.resolve(null);
    }).then(function () {
      var out = mapNamesStatus();
      out.ok = true;
      out.applied = r.applied; out.cleared = r.cleared;
      out.renamed = touched + Math.max(0, unknownBefore - (store && store.state ? store.unknownMaps() : 0));
      onLocal('mapNames:done', out);
      return out;
    });
  }
  /** 设置页「本机字典」：三层计数 + 打过的每张图 + 我改过的那几条 */
  function mapNamesDict() {
    var rec = mapNamesRecord();
    var c = Core.Maps.mapNameCounts();
    var d = Core.Maps.nameDict();
    return {
      ok: true, builtin: c.builtin, learned: c.learned, user: c.user,
      at: (rec && rec.at) || 0, never: !(rec && rec.at),
      unknown: store && store.state ? store.unknownMaps() : 0,
      usage: store && store.state ? store.mapUsage() : [],
      userEdits: d.user, learnedList: d.learned
    };
  }
  function mapNamesStatus() {
    var rec = mapNamesRecord();
    var c = Core.Maps.mapNameCounts();
    return {
      ok: true, builtin: c.builtin, learned: c.learned, user: c.user, at: (rec && rec.at) || 0,
      unknown: store && store.state ? store.unknownMaps() : 0,
      never: !(rec && rec.at)
    };
  }
  function pullMapNames() {
    var Cfg = Core.MapConfig;
    if (!Cfg || !Cfg.okUrl(Cfg.URL)) {
      return Promise.resolve({ ok: false, error: '配置表地址不是允许的官方域名' });
    }
    return to('cfg.mapNames', { url: Cfg.URL }).then(function (r) {
      if (!r || r.ok === false) {
        return { ok: false, error: '配置表取不到：' + ((r && r.error) || ('HTTP ' + ((r && r.status) || '?'))) };
      }
      var parsed = Cfg.parse(r.text);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      var unknownBefore = store && store.state ? store.unknownMaps() : 0;
      var merged = learnMapNames(parsed.names, Date.now());
      /* 历史场次跟着改名走 core 里那条既有清算（prune 见到 id 已知就刷新 map_name），
       * 这里只需 save 一次让界面立刻变 —— 与桌面同一处理，不写第二套改名逻辑 */
      var next = store && store.state ? store.save() : Promise.resolve(null);
      return next.then(function () {
        var out = mapNamesStatus();
        out.added = merged.added; out.rows = parsed.count;
        out.renamed = Math.max(0, unknownBefore - (store && store.state ? store.unknownMaps() : 0));
        out.ok = true;
        onLocal('mapNames:done', out);
        return out;
      });
    });
  }
  /* 出网唯一的入口：手动连点与启动那一次自动撞在一起，也只会有一发在飞 */
  function requestMapNamesPull() {
    if (!mapNamesPulling) {
      mapNamesPulling = pullMapNames().then(function (r) {
        mapNamesPulling = null; return r;
      }, function (e) {
        mapNamesPulling = null;
        return { ok: false, error: '更新失败：' + ((e && e.message) || e) };
      });
    }
    return mapNamesPulling;
  }
  /* ★ 自动取地图名，全代码库这一族只有这里与桌面那一处会自动发。判据只有一颗：
   *   Core.MapConfig.dueToRefresh（上次真取到表到现在超过一天）—— 与桌面同一把尺，
   *   两边各写一遍迟早有一天不一样。 */
  function autoPullMapNames() {
    setTimeout(function () {
      var at = (mapNamesRecord() || {}).at || 0;
      if (!Core.MapConfig.dueToRefresh(at, Date.now())) return;
      requestMapNamesPull();
    }, 8000);
  }

  /* ---------------- 在线更新检查 + 装机计数（同一发，手机端只查不装） ----------------
   * 安卓这一侧**不做热替换**：APK 里的 assets 在签名包里，写不了也不该写 ⇒
   * 查到新版只提示，那只手交给系统浏览器去下 apk。判据与桌面共用 Core.Update / Core.Update.
   * ★ 这一发同样不带任何用户内容：只有应用号、平台、当前版本（第一次多带一个 sec）。 */
  var updateState = { checked: false, checking: false, action: 'none', latest: '', notes: '',
    force: 0, error: '', at: 0, download: '', size: 0, current: Core.Plugin.HOST_VERSION };
  function startupRecord() {
    return (accounts.globalSettings && accounts.globalSettings.startup) || null;
  }
  function checkForUpdate() {
    if (updateState.checking) return Promise.resolve(updateState);
    updateState.checking = true;
    var first = Core.Update.shouldSend(startupRecord());
    var u = Core.Update.url('android', Core.Plugin.HOST_VERSION, first);
    if (!Core.Update.okUrl(u) || !Core.Update.noUserIdentity(u)) {
      updateState.checking = false;
      updateState.error = '检查地址不合法（判据在 core/update.js）';
      onLocal('update:status', updateState);
      return Promise.resolve(updateState);
    }
    return to('cfg.update', { url: u }).then(function (r) {
      updateState.checking = false;
      updateState.checked = true;
      updateState.at = Date.now();
      if (!r || r.ok === false) {
        updateState.action = 'none';
        /* 与桌面同一句形状：原生把 HTTP 状态码带回来了（PluginNet 那一发一直带 status），
         * 就要念得出是 404（服务器上还没放文件）还是别的 —— 只念一个「?」等于把排查踢回给他猜。 */
        updateState.error = (r && r.error)
          ? ('问不到：' + r.error)
          : ('问不到（HTTP ' + ((r && r.status) || '?') + '）');
        return updateState;
      }
      /* 计数只看这一发到了没有（与桌面同一条：ok 为真才记档，别一台机器数两次） */
      if (first && r.ok !== false) {
        accounts.globalSettings = accounts.globalSettings || {};
        accounts.globalSettings.startup = Core.Update.markSent(Date.now());
        saveAccounts();
      }
      var m = Core.Update.parse(r.text);
      if (!m.ok) {
        updateState.action = 'none';
        updateState.checked = true;
        updateState.error = m.error || '回包不认识';
        return updateState;
      }
      updateState.error = '';
      updateState.checked = true;
      updateState.latest = m.version;
      updateState.notes = m.notes;
      updateState.force = m.force;
      updateState.size = m.size || 0;
      var p = Core.Update.plan(m, Core.Plugin.HOST_VERSION);
      /* 手机端永远是 hint：APK 不能自己覆盖自己，最多给一个下载地 */
      updateState.action = p.action;
      updateState.download = m.url || '';
      return updateState;
    }, function (e) {
      updateState.checking = false;
      updateState.error = '问不到：' + ((e && e.message) || e);
      return updateState;
    }).then(pushUpdateState);          /* ★ 每一条出路都推（见 pushUpdateState 上那一段） */
  }
  /* ★ 状态一变就推给界面：只有"查到新版"才推的那一版，会把 404 / 断网 / 回包不认识留在
   *   启动时那句「还没检查过。」上 —— 自动那一发（启动 6 秒后）没人去点「重新检查」，
   *   界面从此不更新。桌面同一处是 emit('update:status')，两端一条口径。 */
  function pushUpdateState() { onLocal('update:status', updateState); }
  function autoCheckUpdate() {
    setTimeout(function () { checkForUpdate(); }, 6000);
  }

  /* ------------------------------------------------ 当前号：store + collector */

  var store = null, collector = null, ready = false;
  var currentSlot = '', pendingSlot = '';

  /* 存储适配器：只搬字节，业务一律在 core */
  function fileAdapter(name, slot) {
    return {
      path: name,
      load: function () {
        return readText(name).then(function (r) {
          /* 读不出来 → 上面那本账已经记下了，这里当空库交给 core 只为让界面起得来；
           * 真正兜住后果的是 save 那道闸：没读动的文件，这一版之内一律不许盖。 */
          if (!r.text) return null;
          try { return JSON.parse(r.text); }
          catch (e) {
            /* 和桌面 store-node 同一手：损坏就先留一份再当空库，别让软件起不来 */
            to('fs.write', { name: name + '.corrupt-' + Date.now(), text: r.text });
            return null;
          }
        });
      },
      save: function (state) {
        var blocked = writeBlocked(name);
        if (blocked) return Promise.resolve(blocked);
        if (slot) observe(slot, state);
        return to('fs.write', { name: name, text: JSON.stringify(state) });
      }
    };
  }

  /* 安卓没有「列目录」这条通道，所以某个号的库在不在本机，只能靠真打开过一次来记。
   * 记在 accounts.json 上，界面那句「已注册 / 空槽」才有依据，而不是猜。 */
  function observe(slot, state) {
    var a = acctOf(slot);
    if (!a || !state) return;
    var m = Object.keys(state.matches || {}).length;
    var r = Object.keys(state.rosters || {}).length;
    if (a.hasFile && a.matches === m && a.rosters === r) return;
    a.hasFile = true; a.matches = m; a.rosters = r;
    saveAccounts();
  }

  /* 出网适配器：cookie 由 WebView 的 CookieManager 带（Java 侧拼），这里从不碰登录凭据明文 */
  var netAdapter = {
    ua: 'android-webview',
    post: function (pathname, body) {
      return to('net.post', { pathname: pathname, body: JSON.stringify(body || {}) })
        .then(function (r) {
          if (!r || r.ok === false) {
            var e = new Error((r && (r.error || r.message)) || '接口请求失败');
            if (r && r.notLogin) e.notLogin = true;
            throw e;
          }
          try { return JSON.parse(r.text); }
          catch (x) {
            var err = new Error('接口返回非 JSON（长度 ' + String(r.text || '').length + '）：' +
              String(r.text || '').slice(0, 120));
            err.raw = r.text;
            throw err;
          }
        });
    }
  };

  /* 打开这一号的库。**slot 可不在注册表里** —— 桌面 `openLoginWindow` 就是这一手：
   * 登录窗打开之前先把 Store/Collector 立起来，登录成功那一刻界面才有的可刷。
   * 安卓上一版漏了这一步：store 仍是 null，login:done 打进 refresh() 当场抛（链上无 catch），
   * 真机表现成「授权完成了却停在登录页，退回重进才进去」。 */
  function openSlotStore(slot) {
    if (!slot) return Promise.resolve(false);
    if (store && collector && currentSlot === slot) { ready = true; return Promise.resolve(true); }
    var s = new Core.Store.Store(fileAdapter(dataFile(slot), slot));
    store = s;
    collector = new Core.Collector.Collector(netAdapter);
    /* 这个号当初登进来时用的是哪套账号体系（1=QQ / 2=微信）：从注册表里带回来，
     * 不然微信号每次重启都退回 1，官方一路都认不到人。 */
    var rec = acctOf(slot);
    if (rec) collector.setAccountType(rec.accountType);
    currentSlot = slot; ready = false;
    return s.load().then(function () {
      ready = true;
      observe(slot, s.state);
      return true;
    });
  }

  /* 只问「登录了没」的一次性探针（boot 那发、df.checkLogin 都走这里）。
   * 每回都 new 一个采集器是因为它不该碰当前号那份库；但**账号体系必须从注册表带过来**：
   * 微信号拿默认的 1 去问，官方永远回「没这个角色」，看着就像"没登录"。 */
  function loginProbeCollector() {
    var c = new Core.Collector.Collector(netAdapter);
    var a = acctOf(accounts.activeSlot) || (pendingSlot ? acctOf(pendingSlot) : null);
    if (a) c.setAccountType(a.accountType);
    return c;
  }

  function useSlot(slot) {
    if (!slot || (!acctOf(slot) && slot !== pendingSlot)) {
      store = null; collector = null; currentSlot = ''; ready = false;
      return Promise.resolve(false);
    }
    return openSlotStore(slot);
  }

  /* 新号的 slot 名沿用桌面那一套 a1 / a2 …（slotOf(openid) 只在没有指名时用）。
   * 同名还有个实打实的好处：导出的数据包在电脑和手机之间倒来倒去，文件名对得上。 */
  function nextFreeSlot() {
    var n = 1;
    while (acctOf('a' + n) || pendingSlot === 'a' + n) n++;
    return 'a' + n;
  }

  /* 登录成功后把号钉进注册表（对应 main.js 的 bindLogin） */
  function bindLogin(openid, name, area, slotWanted, accountType) {
    /* ★★ 一个槽只属于一个人，openid 定了就不改名换主（与使用者定下的 A 方案同一条：
     *   「包属于谁就落进谁的库」，两个人的场次绝不并成一堆）。
     *   上一版这里写的是 `acctOfOpenid(openid) || slotWanted || slotOf(openid)`，
     *   而 slotWanted 常常就是"当前那个号"的槽 ⇒ 为小号开的窗里扫进大号，
     *   会把小号的 openid 直接改成大号：小号那几场变成大号的库，小号下次登录又新建一个空槽 ——
     *   两个人谁都对不上，正是他报的那句「换号后读的还是小号的」。
     * 现在：认得这个人 → 他自己的槽；认不得 → 只认领"还没登记过任何人"的预留槽，
     *   否则按 openid 新建一个（末 8 位撞车就顺延）。 */
    var slot = acctOfOpenid(openid);
    if (!slot) {
      var want = slotWanted && !acctOf(slotWanted) ? slotWanted : '';
      if (!want && slotWanted && acctOf(slotWanted) && !acctOf(slotWanted).openid) want = slotWanted;
      slot = want || (acctOf(slotOf(openid)) ? nextFreeSlot() : slotOf(openid));
    }
    var a = acctOf(slot);
    var isNew = false;
    /* 登录探测定下来的一套体系要跟着号落盘：采集的每一发都按它问 */
    var acctType = Number(accountType) === 2 ? 2 : 1;
    if (!a) {
      a = { slot: slot, openid: openid, name: name || '', area: Number(area) || 36,
        accountType: acctType, created_at: Date.now(), last_sync: 0 };
      accounts.accounts.push(a);
      isNew = true;
    } else {
      a.openid = openid; a.name = name || a.name; a.area = Number(area) || a.area;
      a.accountType = acctType;
      /* 真授权落到这个号上了：它不再是"只读的导入号" */
      if (a.imported) delete a.imported;
    }
    a.last_sync = a.last_sync || Date.now();
    accounts.activeSlot = slot;
    return saveAccounts().then(function (saved) {
      var r = { slot: slot, isNew: isNew, accountType: acctType };
      /* ★ 闸门把这一发挡回来了（accounts.json 这次没读动）：号在本机内存里是登进来了，
       *   可这次没记住。不喊出来，人重启一次发现号又没了，只会当我们又一次"没反应"。 */
      if (saved && saved.ok === false) {
        r.persistError = saved.error || '';
        to('toast', { text: '这次登录没记住：' + r.persistError });
      }
      return r;
    });
  }

  /* 登录窗打开期间轮询（桌面在 main.js 里 setInterval，这里同样一份节奏）
   * ★ 判定不在这里：交给 core 的 probeLogin，一次把 QQ 与微信两套账号体系都问到 ——
   *   上一版这里手写一发 account_type:1，微信授权完成后页面明明登录了，
   *   软件却永远等不到"我是谁"的回答，表现成"授权回来了却停在登录页"。 */
  var poller = null, pollSlot = '', pollSeq = 0;
  function startPolling(slot) {
    stopPolling();
    pollSlot = slot || '';
    var seq = pollSeq;
    var probe = new Core.Collector.Collector(netAdapter);
    /* 每轮两套各一发，所以把节奏从 1.5 秒抬到 2 秒：出网频率与上一版同一量级 */
    poller = setInterval(function () {
      probe.probeLogin().then(function (r) {
        /* ★ 这一表已经作废（关了窗、或又开了一窗 ⇒ 原生刚把整机会话痕迹清干净）：
         *   迟到的回包一个字都不许落地。放它过去等于拿"上一个会话"的 role 去 bindLogin，
         *   刚清掉的半死会话又被填回界面 —— 清空就白清了。 */
        if (seq !== pollSeq) return;
        onLocal('login:probe', { ok: !!r.ok, accountType: r.accountType || 0,
          attempts: r.attempts || [], rounds: r.rounds || 0, advice: r.advice || '',
          message: r.ok ? '' : (r.message || '') });
        if (!r.ok) return;
        stopPolling();
        var role = r.role;
        /* ★ 先落号再对库，顺序不能反：注册表里还没有这个号时 useSlot 会直接返回 false，
         *   store 留成 null，login:done 打到界面上 refresh() 就抛（真机停在登录页那条）。 */
        bindLogin(role.openid, role.name, role.area, pollSlot || null, r.accountType)
          .then(function (bound) {
            pendingSlot = '';     /* 这一轮结束了：预留的槽位不管用没用上都还回去 */
            return openSlotStore(bound.slot).then(function () { return bound; });
          }).then(function (bound) {
            pollSlot = '';
            onLocal('login:done', { role: role, slot: bound.slot, isNew: bound.isNew,
              accountType: bound.accountType, persistError: bound.persistError || '' });
          });
      });
    }, 2000);
  }
  function stopPolling() {
    /* ★ 代号先加再清表：清掉 setInterval 只能挡住"下一发",挡不住已经在路上的那一发。 */
    pollSeq++;
    if (poller) { clearInterval(poller); poller = null; }
  }

  /* ------------------------------------------------ 同步（整条跑在 core 里） */

  var syncing = false;
  function runSync(opts) {
    opts = opts || {};
    if (!collector || !store) return Promise.resolve({ ok: false, error: '未选择账号' });
    if (activeLocalOnly()) {
      var a = acctOf(accounts.activeSlot) || {};
      return Promise.resolve({
        ok: false, localOnly: true, inserted: 0, duplicates: 0, slot: accounts.activeSlot,
        error: '「' + (a.name || accounts.activeSlot) + '」是导入的只读账号，手机上的会话不属于它 —— 要更新请在电脑上同步后再导一次包'
      });
    }
    if (syncing) return Promise.resolve({ ok: false, error: '正在同步中，请稍候' });
    syncing = true;
    onLocal('sync:start', { slot: accounts.activeSlot });
    var st = store.state.settings || {};
    return collector.collect({
      withDetail: opts.withDetail !== false,
      detailScope: opts.detailScope || st.detailScope || 'all',
      haveRosters: store.trustedRosterRoomIds(),
      pages: opts.pages || st.syncPages || 5,
      pageDelayMs: opts.pageDelayMs != null ? opts.pageDelayMs :
        (st.syncPageDelayMs != null ? st.syncPageDelayMs : 500),
      /* 与桌面同一颗：官方赛季号取自本机设置，空 = 用采集器内置默认（判据只在 core 一份） */
      sid: st.seasonSid || '',
      onProgress: function (p) { onLocal('sync:progress', p); }
    }).then(function (payload) {
      /* ★★ 入库前的归属核对，判据在 core（`Store.ownerConflict`，与桌面同一份）。
       *   手机上整机只有一罐共享会话：切到 C 号而罐子里其实是 A 号时，少这一道就是把 A 的场次
       *   写进 C 的库 —— 两个人的场数混在一堆，胜率与评分曲线从此全错，而且事后分不开。 */
      var claimed = acctOf(accounts.activeSlot) || {};
      if (Core.Store.ownerConflict(
          claimed.openid || (store.state.meta && store.state.meta.openid),
          (payload.role && payload.role.openid) || '')) {
        return {
          ok: false, ownerMismatch: true, inserted: 0, duplicates: 0, players: 0, errors: [],
          error: '这个号登记的是「' + ((claimed.name || (store.state.meta && store.state.meta.name))
            || accounts.activeSlot) + '」，可手机上的会话是「' + ((payload.role && payload.role.name)
            || payload.role.openid) + '」的 —— 没有往库里写一个字节。请在登录里换成他，或切回他自己那个号'
        };
      }
      onLocal('sync:progress', { stage: '入库中', stageIndex: 5, stageTotal: 6,
        done: 1, total: 1, percent: 99, label: '数据入库中…' });
      return store.ingest(payload).then(function (res) {
        res.errors = (res.errors || []).concat(payload.errors || []);
        if (payload.role && payload.role.openid) {
          bindLogin(payload.role.openid, payload.role.name, payload.role.area);
        }
        res.ok = !res.errors.length || res.inserted > 0;
        var seen = {};
        ((payload.list && payload.list.tdms) || []).forEach(function (r) {
          if (r && r.roomId) seen[String(r.roomId)] = 1;
        });
        res.missingRosters = Object.keys(store.state.matches || {}).filter(function (rid) {
          return seen[rid] && !store.state.rosters[rid];
        }).length;
        var ts = ((payload.list && payload.list.tdms) || [])
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
          res.pageTrace = payload.pageTrace || null;
          res.seasonSid = payload.sid || '';
          return res;
        });
      });
    }).then(function (res) {
      syncing = false;
      res.slot = accounts.activeSlot;
      /* ★ 宿主只记一笔账：谁也别替使用者跑一段插件代码（与桌面 notePluginTriggers 同一语义）。
       *   绝不 await，也不让记账失败把一次成功的同步说成失败。 */
      if (res.ok && global.__dfPlugins) {
        try {
          global.__dfPlugins.noteSync({
            at: Date.now(), slot: res.slot, inserted: res.inserted,
            matches: store ? Object.keys(store.state.matches || {}).length : 0
          });
        } catch (e) { /* ignore */ }
      }
      onLocal('sync:done', res);
      return res;
    }).catch(function (e) {
      syncing = false;
      var notLogin = !!(e && (e.notLogin || e.loginFailed));
      var res = { ok: false, notLogin: notLogin, inserted: 0, duplicates: 0,
        error: (e && e.message) || String(e) };
      onLocal('sync:done', res);
      return res;
    });
  }

  /* ------------------------------------------------ df：与 shell/preload.js 同名同形 */

  function filtersArgs(f) {
    f = f || {};
    return { mode: f.mode || 'all', kind: f.kind || 'all', leave: f.leave || 'all', since: f.since,
      mapId: f.mapId, search: f.search };
  }
  function rowsWithRating(rows) {
    var openid = store && store.activeOpenid();
    return rows.map(function (r) {
      var rt = Core.Analysis.rating(r, store.players(r.room_id), openid);
      return Object.assign({}, r, { rating: rt.value, ratingBasis: rt.basis });
    });
  }

  /* 导入数据包：判据与 shell/main.js 同一条 —— **包属于谁就落进谁的库**。
   * 手机上这一步尤其重要：整机只有一个 WeGame 会话，别的号没法在手机上登录，
   * 「把电脑上导出的包传进来」就是它们在手机上的唯一存在方式。
   * 旧版这里直接拒收（"请先切到该账号"），而那个"该账号"在手机上根本切不过去。
   * 而并进当前号更坏：两个人的场次混在一个库里，胜率、评分曲线、对手档案全都算错。 */
  function adoptBundleOwner(openid, meta) {
    var slot = acctOfOpenid(openid);
    var name = String(meta.name || '');
    var isNew = false;
    if (!slot) {
      slot = nextFreeSlot();
      accounts.accounts.push({
        slot: slot, openid: openid, name: name, area: Number(meta.area) || 36,
        created_at: Date.now(), last_sync: Number(meta.last_sync) || 0,
        imported: true, hasFile: true
      });
      isNew = true;
    }
    return openSlotStore(slot).then(function () {
      accounts.activeSlot = slot;
      return saveAccounts();
    }).then(function () {
      onLocal('account:changed', { slot: slot, openid: openid, name: name });
      return { ok: true, slot: slot, name: name || slot, isNew: isNew };
    });
  }

  function importBundle(bundle) {
    if (!bundle) return Promise.resolve({ ok: false, error: '空数据包' });
    if (!store) return Promise.resolve({ ok: false, error: '未选择账号' });
    /* 包里的地图名字典先收下（桌面导出的包带着它）：紧接着的合并与 prune 就能把
     * 新学 id 的场次当场改对名。★ 不传 at —— 这条路不算「首次自动取过」，那一次该发还得发。 */
    if (bundle.map_names) learnMapNames(bundle.map_names);
    /* ★ 带进来的那一层「我自己起的名字」（#92）：老包没这个键就什么也不做。 */
    if (bundle.map_names_user) learnUserNames(bundle.map_names_user);
    var meta = bundle.meta || {};
    var owner = String(meta.openid || '');
    var cur = String(store.state.meta.openid || '');
    var route = Promise.resolve(null);
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

  /* 合并进当前 store（按 roomId 去重、名单取更完整的、赛季取更新的、
   * 标注只补本机没有的且必须本机有这场）*/
  function mergeBundle(bundle) {
    var s = store.state, added = 0, dup = 0, rosterAdded = 0, rosterKept = 0;
    var bm = bundle.matches || {};
    Object.keys(bm).forEach(function (k) {
      if (s.matches[k]) { dup++; return; }
      s.matches[k] = bm[k];
      added++;
    });
    var br = bundle.rosters || {};
    Object.keys(br).forEach(function (k) {
      var inc = br[k] || {}, cur = s.rosters[k];
      if (!cur || (inc.players || []).length > (cur.players || []).length) {
        s.rosters[k] = inc;
        rosterAdded++;
      } else rosterKept++;
    });
    var bs = bundle.seasons || {};
    Object.keys(bs).forEach(function (sid) {
      var inc = bs[sid];
      if (!s.seasons[sid] || (inc.at || 0) > (s.seasons[sid].at || 0)) s.seasons[sid] = inc;
    });
    if (!s.flags) s.flags = {};
    var bfl = bundle.flags || {};
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

  var df = {
    boot: function () {
      /* ★ 这枚布尔是给界面分色用的（读盘故障=错色；只是还没号=正常等待）。
       *   不许让界面去正则匹配 bootError 的中文措辞来判断是哪一种。 */
      var storageFault = !!Object.keys(faults).length;
      if (!store || !collector) {
        return Promise.resolve({
          loggedIn: false, role: null, name: '', lastSync: 0,
          stats: { matches: 0, rosters: 0, players: 0 }, matchCount: 0,
          settings: Core.Store.defaultState().settings,
          accounts: accountsView(), activeSlot: accounts.activeSlot,
          storageFault: storageFault,
          /* core 没接对时必须喊出来：不然手机上看到的是一副「还没有数据」的空界面，
             和真的没数据长得一模一样（这一版就差一点这么坏着发出去）。 */
          bootError: global.__dfFatal
            ? '软件内部没装配好：' + global.__dfFatal
            : (faultNote() || (accounts.accounts.length ? '' : '尚未添加账号，请先登录 WeGame'))
        });
      }
      /* ★ 只读号（数据包导进来的）不去打网络：这机器上属于它的会话不存在，
       *   而共享 cookie 罐探回来的是「手机登录的那个号」—— 拿它当这个号的登录态是假的。 */
      if (activeLocalOnly()) {
        return Promise.resolve({
          loggedIn: false, localOnly: true, role: store.state.role || null,
          name: store.state.meta.name, lastSync: store.state.meta.last_sync,
          stats: store.stats(),
          matchCount: Object.keys(store.state.matches || {}).length,
          settings: Object.assign({}, store.state.settings, accounts.globalSettings),
          sidDefault: Core.Collector.DEFAULT_SID,
          accounts: accountsView(), activeSlot: accounts.activeSlot,
          storageFault: storageFault, bootError: faultNote()
        });
      }
      /* ★ 那 8 秒不许动（用户长期裁定）：登录检查失败/超时都不拦本机数据的阅读 */
      return Core.Async.withTimeout(
        loginProbeCollector().checkLogin(), 8000, { ok: false, reason: 'timeout' }
      ).then(function (r) {
        var timedOut = r.reason === 'timeout';
        return {
          loggedIn: !!r.ok,
          loginPending: timedOut,
          loginError: r.ok ? '' : (timedOut ? '检查登录状态超时（网络不稳定）' : (r.message || r.reason || '')),
          role: r.ok ? r.role : (store.state.role || null),
          name: store.state.meta.name,
          lastSync: store.state.meta.last_sync,
          stats: store.stats(),
          matchCount: Object.keys(store.state.matches || {}).length,
          settings: Object.assign({}, store.state.settings, accounts.globalSettings),
          sidDefault: Core.Collector.DEFAULT_SID,
          accounts: accountsView(),
          activeSlot: accounts.activeSlot,
          storageFault: storageFault,
          bootError: faultNote()
        };
      });
    },
    info: function () {
      return to('app.info', {}).then(function (r) {
        return Object.assign({ platform: 'android', dataDir: '' }, (r && r.value) || r || {});
      });
    },

    openLogin: function (slot) {
      var target = slot || accounts.activeSlot || nextFreeSlot();
      /* 不在这里停旧表：startPolling 第一件事就是 stopPolling()（顺带给那张表加代号，
       * 代号不匹配的迟到回包一律不作数 —— 守卫在那儿，写两处只是看着安心，M4 变异证过它挡不住任何东西）。 */
      pendingSlot = target;
      /* ★ 顺序照桌面 openLoginWindow：先把这一号的库立起来，再开登录窗。
       *   登录成功时 refresh() 才有 store 可刷，不会停在登录页。 */
      return openSlotStore(target).then(function () {
        return to('login.open', { slot: target });
      }).then(function (r) {
        startPolling((r && r.slot) || target);
        return { ok: true, slot: target, cleared: !!(r && r.cleared),
          storageFault: !!Object.keys(faults).length };
      });
    },
    checkLogin: function () {
      if (activeLocalOnly()) {
        return Promise.resolve({
          ok: false, localOnly: true,
          reason: '这个号是数据包导进来的，手机上的 WeGame 会话不属于它 —— 要更新数据请在电脑上同步后再导一次包'
        });
      }
      /* ★ 不许因为"还没选号"就不查：装完软件就是没号的状态，而登录窗关掉的瞬间界面正好打这一条 ——
       *   回「未选择账号」等于登录成功了也验不出来，人就被留在登录页（真机第 2 条）。
       *   登录态只看 cookie，与本机有没有库无关，所以和 boot() 一样用一次性 Collector 探。 */
      return Core.Async.withTimeout(loginProbeCollector().checkLogin(), 10000,
        { ok: false, reason: 'timeout', message: '检查登录状态超时（网络不稳定）' });
    },
    logout: function () {
      return to('login.clearCookies', {}).then(function () {
        if (!store) return { ok: false, error: '未选择账号' };
        store.state.role = null;
        return store.save().then(function () { return { ok: true, slot: accounts.activeSlot }; });
      });
    },

    sync: function (opts) { return runSync(opts || {}); },

    /* ★ 桌面上 window.df 的每一个方法都是 ipcRenderer.invoke ⇒ 恒返回 Promise。
     *   界面里 `df.match(rid).then(...)`、`df.encounterDetail(key).then(...)` 就是按这个契约写的，
     *   这里同步返回裸对象就会当场抛（真机表现：单场详情一直转圈，桌面 exe 一切正常）。
     *   凡是 preload 里回 Promise 的，这一层一个都不许"顺手返回对象"。 */
    report: function (filters) {
      return Promise.resolve(store ? Core.Analysis.report(store, filters || {}) : null);
    },
    matches: function (filters) {
      if (!store) return Promise.resolve([]);
      var f = filters || {};
      var watchMap = Core.Analysis.watchedRoomMap(store);
      return Promise.resolve(store.matches({
        mode: f.mode || 'all', kind: f.kind || 'all', leave: f.leave || 'all', since: f.since, mapId: f.mapId,
        search: f.search, includeExcluded: true
      }).map(function (m) {
        return Object.assign({}, m, {
          force_name: m.force_type ? Core.Maps.forceName(m.force_type) : '',
        /* 攻防身份判据在 core 一处（与桌面那一发同一颗），这里只贴字 */
        side: Core.Analysis.sideOf(m),
          hasRoster: !!store.state.rosters[m.room_id],
          rosterGaps: store.rosterGaps(m.room_id),
          watchedCount: watchMap[String(m.room_id)] || 0
        });
      }));
    },
    counts: function () {
      return Promise.resolve(store ? store.modeCounts()
        : { all: 0, swtwr: 0, commander: 0, other: 0, leave: 0, excluded: 0, comp: 0, practice: 0 });
    },
    match: function (roomId) {
      if (!store) return Promise.resolve(null);
      var cmp = Core.Analysis.lobby(store, roomId);
      if (cmp) cmp.tips = Core.Analysis.matchTips(store, roomId) || [];
      return Promise.resolve(cmp);
    },
    setFlag: function (roomId, key, on) {
      if (!store) return Promise.resolve({ ok: false, error: '未选择账号' });
      if (key !== 'commander' && key !== 'excluded' && key !== 'competition') {
        return Promise.resolve({ ok: false, error: '未知的标记类型' });
      }
      return Promise.resolve(store.setMatchFlag(roomId, key, !!on));
    },
    setWatch: function (key, on, info) {
      if (!store) return Promise.resolve({ ok: false, error: '未选择账号' });
      var k = String(key || '');
      if (!/^(id|nm):/.test(k)) {
        return Promise.resolve({ ok: false, error: k.indexOf('slot:') === 0
          ? '这个人的账号标识是当局临时编号，无法跨局识别，不能关注' : '无法识别的玩家标识' });
      }
      return Promise.resolve(store.setWatch(k, !!on, {
        openid: (info && info.openid) || '', name: (info && info.name) || ''
      }));
    },
    encounterDetail: function (vopenid, filters) {
      return Promise.resolve(store ? Core.Analysis.encounterDetail(store, vopenid, filters || {}) : null);
    },

    exportData: function (fmt, filters) {
      if (!store) return Promise.resolve({ ok: false, error: '未选择账号' });
      var f = filters || {};
      var rows = store.matches({ mode: f.mode || 'all', kind: f.kind || 'all', leave: f.leave || 'all' });
      var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      var text, name;
      if (fmt === 'csv') {
        var cols = ['dt_event_time', 'map_name', 'is_winner', 'kill', 'death', 'assist', 'kd',
          'kill_per_min', 'kda', 'score', 'score_per_min', 'occupy', 'rescue', 'game_time', 'is_leave', 'room_id'];
        var head = ['时间', '地图', '胜负', '击杀', '死亡', '助攻', 'KD', 'KPM', 'KDA', '得分',
          '分均得分', '占点（次）', '救治', '时长秒', '中途退出', '房间ID', '评分'];
        var body = rows.map(function (r) {
          var rt = Core.Analysis.rating(r, store.players(r.room_id), store.activeOpenid());
          return cols.map(function (c) {
            var v = r[c];
            if (c === 'is_winner') v = v ? '胜' : '负';
            if (c === 'is_leave') v = v ? '是' : '否';
            return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
          }).concat(['"' + rt.value + '"']).join(',');
        });
        text = '﻿' + [head.join(',')].concat(body).join('\n');
        name = '战绩导出-' + stamp + '.csv';
      } else {
        text = JSON.stringify({
          exportedAt: Date.now(), filters: f, report: Core.Analysis.report(store, f),
          matches: rowsWithRating(rows), rosters: store.state.rosters, flags: store.state.flags
        }, null, 1);
        name = '战绩导出-' + stamp + '.json';
      }
      return to('export.save', { name: name, text: text }).then(function (r) {
        /* ★ 界面那句是「已导出 ' + r.count + ' 场到：…」，桌面 data:export 一直带着 count，
         *   而 Java 只回 {ok,path} ⇒ 手机上会念成「已导出 undefined 场」。补在接缝上，不新增判定。 */
        if (r && r.ok) r.count = rows.length;
        return r;
      });
    },
    bundle: function () {
      if (!store) return Promise.resolve({ ok: false, error: '未选择账号' });
      var view = store.bundleView();
      /* 与桌面同一口径：带上本机学到的地图名（公开地名、零个人数据），
       * 这样包在电脑与手机之间倒腾时，只有新图编号的场次落到哪儿都有名字。 */
      view.map_names = (mapNamesRecord() || {}).names || {};
      /* ★ 也带上使用者自己起的名字：包在手机与电脑之间倒腾时不必重做一遍改名（#92） */
      view.map_names_user = (mapNamesRecord() || {}).userNames || {};
      return to('export.save', {
        name: '数据包-' + (accounts.activeSlot || 'slot') + '-' +
          new Date().toISOString().slice(0, 10) + '.json',
        text: JSON.stringify(view)
      }).then(function (r) {
        /* 同上：界面读 r.matches / r.rosters（桌面 data:bundle 的返回里就有这两个） */
        if (r && r.ok) {
          r.matches = Object.keys(view.matches || {}).length;
          r.rosters = Object.keys(view.rosters || {}).length;
        }
        return r;
      });
    },
    restore: function () {
      return to('file.pick', {}).then(function (r) {
        if (!r || !r.text) {
          return { ok: false, cancelled: !!(r && r.cancelled), error: (r && r.error) || '没选中文件' };
        }
        var bundle;
        try { bundle = JSON.parse(r.text); }
        catch (e) { return { ok: false, error: '这个文件不是有效的数据包' }; }
        return importBundle(bundle);
      });
    },
    openFolder: function () {
      return to('toast', { text: '数据存在本机应用私有目录，卸载即清除' });
    },
    reset: function (scope) {
      var all = scope === 'all';
      if (!all) {
        if (!store) return Promise.resolve({ ok: false, error: '未选择账号' });
        return Promise.resolve(store.clearData()).then(function () {
          return store.save();
        }).then(function () { return { ok: true, cleared: 1 }; });
      }
      var names = accounts.accounts.map(function (a) { return dataFile(a.slot); });
      return names.reduce(function (chain, n) {
        return chain.then(function () { return to('fs.remove', { name: n }); });
      }, Promise.resolve()).then(function () {
        accounts.accounts = [];
        accounts.activeSlot = '';
        store = null; collector = null; ready = false;
        currentSlot = ''; pendingSlot = '';
        return saveAccounts().then(function () { return { ok: true, cleared: names.length }; });
      });
    },

    /* 备份/恢复目录选择这类桌面动作，安卓上先给一句实话，别假装成功 */
    backupNow: function () { return Promise.resolve({ ok: false, error: '安卓版备份走「导出数据包」' }); },
    backupInfo: function () {
      return Promise.resolve({
        ok: true, count: 0,
        dir: '每次导出时由系统「另存为」指定位置（数据包与卡片都是）'
      });
    },
    backupOpen: function () { return Promise.resolve({ ok: false, error: '安卓版没有备份目录' }); },
    backupChooseDir: function () { return Promise.resolve({ ok: false, cancelled: true }); },

    saveCard: function (payload) {
      var b64 = String((payload && payload.dataUrl) || '').split(',').pop() || '';
      return to('card.save', { name: (payload && payload.name) || '战绩卡片.png', b64: b64 });
    },
    copyCard: function (payload) {
      var b64 = String((payload && payload.dataUrl) || '').split(',').pop() || '';
      return to('card.copy', { b64: b64 });
    },

    openGithub: function () { return to('open.url', { url: GITHUB_URL }); },
    openSandbox: function () { return to('open.url', { url: SANDBOX_URL }); },
    /* ★ 群号是这一侧的常量，界面只拿得到 {ok,text}：上一版这里发的是空串，
     *   原生确实"复制成功"了 —— 复制了个空，表现就是「复制QQ群无法复制」。 */
    copyGroup: function () {
      return to('clipboard', { text: QQ_GROUP }).then(function (r) {
        return (r && r.ok !== false)
          ? { ok: true, text: QQ_GROUP }
          : { ok: false, error: (r && r.error) || '剪贴板写入失败' };
      });
    },

    setSettings: function (patch) {
      if (!store) return Promise.resolve({ ok: false, error: '未选择账号' });
      var p = patch || {};
      var globalKeys = ['autoSync', 'syncPages', 'theme', 'detailScope', 'syncPageDelayMs', 'weights'];
      var gPatch = {}, local = {};
      Object.keys(p).forEach(function (k) {
        if (globalKeys.indexOf(k) !== -1 && !accounts.accounts.length) gPatch[k] = p[k];
        else local[k] = p[k];
      });
      var chain = Object.keys(local).length ? store.setSettings(local) : Promise.resolve();
      return chain.then(function () {
        if (Object.keys(gPatch).length) {
          accounts.globalSettings = Object.assign(accounts.globalSettings || {}, gPatch);
          return saveAccounts();
        }
      }).then(function () {
        return { ok: true, settings: Object.assign({}, store.state.settings, accounts.globalSettings) };
      });
    },

    accounts: {
      list: function () { return Promise.resolve(accountsPayload()); },
      add: function () {
        return df.openLogin(null).then(function (r) {
          return { ok: !!(r && r.ok), slot: (r && r.slot) || '', error: (r && r.error) || '' };
        });
      },
      switch: function (slot) {
        return useSlot(slot).then(function (okVal) {
          if (!okVal) return { ok: false, error: '账号不存在：' + slot };
          accounts.activeSlot = slot;
          return saveAccounts().then(function () {
            var a = acctOf(slot) || {};
            onLocal('account:changed', { slot: slot, openid: a.openid, name: a.name });
            return { ok: true, slot: slot };
          });
        });
      },
      logout: function (slot) {
        var a = acctOf(slot);
        if (!a) return Promise.resolve({ ok: false, error: '没有这个账号' });
        return to('login.clearCookies', { slot: slot }).then(function () {
          return { ok: true, slot: slot };
        });
      },
      remove: function (slot) {
        if (!slot) return Promise.resolve({ ok: false, error: '未指定 slot' });
        if (accounts.accounts.length <= 1) {
          return Promise.resolve({ ok: false, error: '至少保留一个账号。如需清空，请使用「清空所有账号数据」。' });
        }
        var idx = -1;
        accounts.accounts.forEach(function (a, i) { if (a.slot === slot) idx = i; });
        if (idx === -1) return Promise.resolve({ ok: false, error: 'slot 不存在：' + slot });
        accounts.accounts.splice(idx, 1);
        if (accounts.activeSlot === slot) accounts.activeSlot = '';
        return to('fs.write', { name: dataFile(slot), text: '' })
          .then(saveAccounts)
          .then(function () { return useSlot(accounts.activeSlot); })
          .then(function () {
            return { ok: true, removed: slot, activeSlot: accounts.activeSlot, message: '已移除' };
          });
      },
      globalSettings: function (patch) {
        var p = Object.assign({}, patch || {});
        /* 本机字典只由宿主自己写（取配置表 / 收导入包），界面这条路改不到它 ——
         * 与桌面 applyGlobalSettings 那份四键白名单同口径：递什么就存什么，早晚会漏一次。 */
        delete p.mapNames;
        accounts.globalSettings = Object.assign(accounts.globalSettings || {}, p);
        return saveAccounts().then(function () { return { ok: true }; });
      }
    },

    /* 地图名：与桌面 preload 的 df.mapNames 一一对应（status / refresh / dict / setName 四条，
     * 都回 Promise）。界面拿不到 URL、也拿不到名字表本身 —— 出网与合并全在这一层以下。
     * dict / setName 是 #92 那两条：只动本机字典，一律不出网。 */
    mapNames: {
      status: function () { return Promise.resolve(mapNamesStatus()); },
      refresh: function () { return requestMapNamesPull(); },
      dict: function () { return Promise.resolve(mapNamesDict()); },
      setName: function (payload) { return editMapName(payload && payload.id, payload && payload.name); }
    },

    /* 在线更新（手机端）：只有"查"和"去下载"两只手 —— APK 不能自己覆盖自己，
     * 所以这里刻意没有 start / relaunch。地址由 core/update.js 钉着，不是那台的不开。 */
    update: {
      status: function () {
        return Promise.resolve(Object.assign({ ok: true, reported: !!startupRecord() }, updateState));
      },
      check: function () { return checkForUpdate(); },
      openDownload: function (payload) {
        var u = String((payload && payload.url) || '');
        if (u.indexOf('https://' + Core.Update.HOST + '/') !== 0) {
          return Promise.resolve({ ok: false, error: '地址不在那台服务器上' });
        }
        return to('open.url', { url: u }).then(function () { return { ok: true }; });
      }
    },

    /* 插件层：判定全在 android/js/plugin-host.js（用的是与桌面同一份 core/plugin.js）。
     * 这里只负责把十颗按钮接到那一层上 —— 宿主没装配好就如实回错，不许静默回空列表。 */
    plugin: (function () {
      function host() { return global.__dfPlugins || null; }
      function noHost() {
        return Promise.resolve({ ok: false, error: '插件宿主没装配好（plugin-host.js 没加载）' });
      }
      return {
        list: function () {
          var h = host();
          if (!h) {
            return Promise.resolve({
              ok: true, plugins: [], scopes: Core && Core.Plugin ? Core.Plugin.SCOPES : {},
              netHosts: [], hostVersion: Core && Core.Plugin ? Core.Plugin.HOST_VERSION : '',
              enabledCount: 0, netEnabledCount: 0, dir: ''
            });
          }
          return h.list();
        },
        inspect: function () { var h = host(); return h ? h.inspect() : noHost(); },
        install: function (token, scopes) {
          var h = host(); return h ? h.install(token, scopes) : noHost();
        },
        setEnabled: function (id, on) {
          var h = host(); return h ? h.setEnabled(id, on) : noHost();
        },
        consent: function (id, sentence) {
          var h = host(); return h ? h.consent(id, sentence) : noHost();
        },
        revokeConsent: function (id) {
          var h = host(); return h ? h.revoke(id) : noHost();
        },
        remove: function (id) { var h = host(); return h ? h.remove(id) : noHost(); },
        verify: function (id) {
          var h = host();
          if (!h) return noHost();
          return h.verify(id).then(function (v) {
            return { ok: !!(v && v.ok), message: (v && v.message) || '' };
          });
        },
        page: function (id) { var h = host(); return h ? h.page(id) : noHost(); },
        call: function (pluginId, method, args) {
          var h = host(); return h ? h.dispatch(pluginId, method, args) : noHost();
        }
      };
    })(),

    on: function (channel, cb) {
      if (ALLOW_EVENTS.indexOf(channel) === -1) return;
      (listeners[channel] = listeners[channel] || []).push(cb);
    }
  };

  /* ------------------------------------------------ 起来 */

  function kick() {
    if (!Core || !Core.Store || !Core.Analysis || !Core.Collector) {
      global.__dfFatal = 'core 没加载齐（缺 ' + (!Core ? 'DFCore' : '') +
        (!Core || !Core.Store ? ' Store' : '') + (!Core || !Core.Analysis ? ' Analysis' : '') +
        (!Core || !Core.Collector ? ' Collector' : '') + '）';
      return Promise.resolve(false);
    }
    if (!BRIDGE_TOKEN) {
      /* 每一条原生调用都会被自己挡下：不喊出来，界面上就是一副"什么都没数据"的空壳 */
      global.__dfFatal = '没有桥令牌（页面不是从 APK 里打开的）';
      return Promise.resolve(false);
    }
    if (global.DfPluginHost && !global.__dfPlugins) {
      global.__dfPlugins = global.DfPluginHost.create({
        to: to, onRaw: onRaw,
        emit: function (pluginId, event, data) {
          onLocal('plugin:evt', { pluginId: pluginId, event: event, data: data || {} });
        },
        getStore: function () { return store; },
        getAccounts: function () { return accounts; }
      });
    }
    return loadAccounts().then(function () {
      /* ★ 学名表必须早于 useSlot：store.load 里那次 prune 就是靠它把历史场次的地图名一起刷对 */
      installMapNames();
      return useSlot(accounts.activeSlot ||
        (accounts.accounts.length ? accounts.accounts[0].slot : ''));
    }).then(function (okVal) {
      if (!okVal && accounts.accounts.length) {
        /* activeSlot 指向一个已被删掉的号：回落到第一个，别停在空屏 */
        accounts.activeSlot = accounts.accounts[0].slot;
        return useSlot(accounts.activeSlot);
      }
      autoPullMapNames();
      autoCheckUpdate();         /* ★ 与桌面同一口径：延迟 6 秒那一发（查新版 + 第一次顺带装机计数），
                                  *   不挤在启动那一下和登录检查、首屏同步抢同一段时间 */
      return !!okVal;
    }).catch(function (e) {
      global.__dfFatal = String((e && e.message) || e);
      return false;
    });
  }

  /* ★ 开机这一发必须等装配真跑完再回话。界面是在 DOMContentLoaded 上直接打 df.boot() 的，
   *   而"装配"要过两发原生 I/O（accounts.json + 这个号的战绩库）——抢在它们前面回答的那一次，
   *   给的是「没有号、0 场」，于是登录页既写着"这台机器还没有战绩数据"、又不给跳过那颗按钮。
   *   2026-09-25 在 MuMu 上实测到的就是这个：盘上明明有 8 场，界面念的是"尚未添加账号"。
   *   桌面没这件事（主进程在 ipc 之前就已经把注册表读完了），所以修在这一层，界面不动。 */
  var bootRaw = df.boot;
  df.boot = function () {
    return Promise.resolve(global.__dfReady).then(function () { return bootRaw(); });
  };

  global.df = df;
  global.__dfReady = kick();
  global.__dfKick = kick;
})(window);
