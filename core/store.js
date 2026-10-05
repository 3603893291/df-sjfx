/* store.js — 数据仓库：去重入库、查询（纯 JS，UMD）
 * 存储介质通过适配器注入（桌面=文件，移动=SQLite/IndexedDB），本文件不碰任何平台 API
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./maps'), require('./normalize'));
  } else {
    root.DFCore = root.DFCore || {};
    root.DFCore.Store = factory(root.DFCore.Maps, root.DFCore.Normalize);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Maps, N) {
  'use strict';

  var MAX_MATCHES = 5000;
  var MAX_ROSTERS = 400;
  var MAX_AI_REPORTS = 50;
  /* 每轮同步只留一条窗口记录（约 100 B），40 条 = 够回看几十次同步，又能防 meta 无限膨胀 */
  var MAX_SYNC_WINDOWS = 40;
  var MAX_PEOPLE = 200;
  var SCHEMA_VERSION = 1;

  function defaultState() {
    return {
      version: SCHEMA_VERSION,
      meta: { openid: '', name: '', area: 36, last_sync: 0, first_seen: 0, sync_windows: [] },
      role: null,
      seasons: {},
      matches: {},
      rosters: {},
      flags: {},        // room_id -> { commander: 0|1, excluded: 0|1, competition: 0|1 }，用户手动标注
                        // ★ 不进任何导出的是 people；flags 是「我自己场次的标注」，people 是「别人的身份」
      people: {},       // 聚合键 -> { key, openid, name, confidence, since }，用户关注的同场玩家（仅存本机）
      aiReports: {},    // ★ 遗留字段（≤v1.6.x 写的）：v1.7.0 起没人再写它，
                        //   只由插件的 read.legacy 一次性取走并腾空；旧数据不静默删，落一份 ai-reports-legacy.json
      settings: {
        theme: 'system',
        autoSyncDetail: true,
        detailScope: 'all',
        autoSyncInterval: 30,   // 分钟，0 = 关闭定时同步（启动时不再自动同步，这是唯一的自动途径）
        syncPages: 5,           // 采集翻页数（1-5）
        syncPageDelayMs: 500,   // 每页间隔，避免限流
        /* 官方赛季号：空 = 用采集器内置那颗默认值（core/collector.js 的 DEFAULT_SID）。
         * ★ 这里刻意不写死 '10' 一遍：官方没有"当前第几赛季"的接口，写两份默认值就必然漂移。 */
        seasonSid: '',
        autoBackup: true,       // 每日自动备份
        backupKeep: 7,          // 保留最近 N 份
        backupDir: '',          // 空 = 数据目录下的 backups/
        /* 单局评分权重，整数百分比；不要求和为 100，读取时归一化（见 analysis.weights）
         * 存整对象而不是拆成五个键：这样老存档缺整个字段时 Object.assign 兜得住 */
        ratingWeights: { score: 35, kill: 20, kda: 25, occupy: 10, rescue: 10 }
      }
    };
  }

  /* 状态规范化 + 容量裁剪
   * 规范化：用户标注（flags）物化到 match 上 —— is_commander / excluded 由此而来，
   * 采集时不再自动判定，所以每次 save 都要重算一遍（新入库的场次也要覆盖到）
   */
  function prune(state) {
    var mk = Object.keys(state.matches);
    if (mk.length > MAX_MATCHES) {
      mk.sort(function (a, b) { return state.matches[b].start_time - state.matches[a].start_time; });
      mk.slice(MAX_MATCHES).forEach(function (k) { delete state.matches[k]; });
    }
    var rk = Object.keys(state.rosters);
    if (rk.length > MAX_ROSTERS) {
      rk.sort(function (a, b) { return (state.rosters[b].at || 0) - (state.rosters[a].at || 0); });
      rk.slice(MAX_ROSTERS).forEach(function (k) { delete state.rosters[k]; });
    }
    if (!state.flags) state.flags = {};
    if (!state.aiReports) state.aiReports = {};
    var ak = Object.keys(state.aiReports);
    if (ak.length > MAX_AI_REPORTS) {
      ak.sort(function (a, b) { return (state.aiReports[b].at || 0) - (state.aiReports[a].at || 0); });
      ak.slice(MAX_AI_REPORTS).forEach(function (k) { delete state.aiReports[k]; });
    }
    /* v1.4.0 新增的两张表：老存档里压根没有，必须先补上再裁剪
     * ★ people 的脏键回收不在这里 —— 那要扫全部名单建身份索引，而 prune 每次 save 都跑。
     *   回收走 Store.gcPeople(groups)，由载入方（主进程 / 预览服务）在 load 之后调一次。 */
    if (!state.people) state.people = {};
    var pk = Object.keys(state.people);
    if (pk.length > MAX_PEOPLE) {
      pk.sort(function (a, b) { return (state.people[b].since || 0) - (state.people[a].since || 0); });
      pk.slice(MAX_PEOPLE).forEach(function (k) { delete state.people[k]; });
    }
    if (!state.meta) state.meta = defaultState().meta;
    if (!Array.isArray(state.meta.sync_windows)) state.meta.sync_windows = [];
    if (state.meta.sync_windows.length > MAX_SYNC_WINDOWS) {
      state.meta.sync_windows = state.meta.sync_windows
        .slice().sort(function (a, b) { return (b.at || 0) - (a.at || 0); })
        .slice(0, MAX_SYNC_WINDOWS);
    }
    var live = {};
    for (var k2 in state.matches) {
      if (!Object.prototype.hasOwnProperty.call(state.matches, k2)) continue;
      live[k2] = 1;
      var m2 = state.matches[k2], f = state.flags[k2] || {};
      /* 指挥官是「胜者为王」里的角色，非胜者为王的场次不接受该标记
       * （导入的外部包里若有脏 flag，也在这里被拦掉，不进任何统计） */
      m2.is_commander = (f.commander && m2.is_swtwr) ? 1 : 0;
      /* 「比赛对局」是**纯人工**标记：拿他真库量过，官方字段认不出比赛（唯一"完美分开"的是地图 id，
       * 而那是当晚轮图的巧合），所以这里不猜、不预填，人点了才算。门槛与指挥官同一套：
       * 只有胜者为王能标，导入的外部包里若混进非胜者为王的脏值，也在这里拦掉、不进任何统计。 */
      m2.is_competition = (f.competition && m2.is_swtwr) ? 1 : 0;
      m2.excluded = f.excluded ? 1 : 0;
      if (f.commander && !m2.is_commander) delete f.commander;
      if (f.competition && !m2.is_competition) delete f.competition;
      /* map_name 是 map_id 的派生显示名，早期把查不到的兜底串字面写进了库，
       * 所以这里跟着清算：已知 id 用最新地名覆盖陈旧值；老库里的 `mapId:N` 换成现写法。
       * ★ 其余情况一律不动 —— 导入的外部包可能带着我们表里没有、但确实是真的地名。 */
      if (Maps.isKnownMap(m2.map_id)) {
        if (m2.map_name !== Maps.nameOf(m2.map_id)) m2.map_name = Maps.nameOf(m2.map_id);
      } else if (/^mapId:/.test(String(m2.map_name || ''))) {
        m2.map_name = Maps.nameOf(m2.map_id);
      }
    }
    Object.keys(state.flags).forEach(function (k3) {
      var f3 = state.flags[k3] || {};
      if (!live[k3] || (!f3.commander && !f3.excluded && !f3.competition)) delete state.flags[k3];
    });
    return state;
  }

  function Store(adapter) {
    this.adapter = adapter;
    this.state = defaultState();
    this._startIndex = {};   // start_time -> room_id，用于「相同时间」二次去重
    /* ★ 这一次到底有没有真读到过库。没读到过就绝不许往这个文件上写（见 save()）。 */
    this._loadFault = '';
  }

  /* ★★ 适配器是**同步**的：它抛错发生在 `Promise.resolve(...)` 取参数的那一刻，
   *   于是 `store.load()` 根本不会返回 Promise，而是当场把调用方一起炸穿 ——
   *   桌面 boot / switchTo 那些 `.catch` 全都接不到，读不出来的库就一路走成"没有数据"。
   *   所以这一层先把同步抛错转成 rejection，让"读不出来"有它该有的形状。 */
  Store.prototype.load = function () {
    var self = this;
    var data;
    try {
      data = this.adapter.load();
    } catch (e) {
      this._loadFault = String((e && e.message) || e);
      return Promise.reject(e);
    }
    return Promise.resolve(data).then(function (d) {
      data = d;
      self._loadFault = '';          // 读到了，写闸打开
      var s = defaultState();
      if (data) {
        s = Object.assign(s, data);
        s.meta = Object.assign(defaultState().meta, data.meta || {});
        s.settings = Object.assign(defaultState().settings, data.settings || {});
        s.matches = data.matches || {};
        s.rosters = data.rosters || {};
        s.seasons = data.seasons || {};
        s.flags = data.flags || {};
        s.people = data.people && typeof data.people === 'object' ? data.people : {};
      }
      self.state = prune(s);
      self._reindex();
      return s;
    }, function (e) {
      self._loadFault = String((e && e.message) || e);
      throw e;
    });
  };

  /* 这一次载入到底成没成 —— 外壳拿它去说实话（桌面 bootError / 安卓 storageFault 同一用途）。 */
  Store.prototype.loadFault = function () { return this._loadFault; };

  Store.prototype.save = function () {
    var self = this;
    /* ★★ 这条闸门是这一处最要命的东西：没读成功过的库 = 我们手里现在只有 defaultState()。
     *   这时候写下去，就把人家里程碑式的东西（几百场战绩、全场名单）换成一份空的。
     *   上一次是"读不出来被当成文件坏了"，于是挪走真库、写空库 —— 顺序对了也照样丢数据。 */
    if (this._loadFault) {
      return Promise.reject(new Error('这个号的库这次没读出来（' + this._loadFault +
        '），软件不会往它上面写 —— 别卸载重装，原文件还在原位'));
    }
    prune(this.state);
    this._reindex();
    try {
      return Promise.resolve(this.adapter.save(this.state));
    } catch (e) {
      return Promise.reject(e);
    }
  };

  Store.prototype._reindex = function () {
    var idx = {};
    var ms = this.state.matches;
    for (var k in ms) {
      if (Object.prototype.hasOwnProperty.call(ms, k)) idx[ms[k].start_time + '|' + ms[k].map_id] = k;
    }
    this._startIndex = idx;
  };

  /* ---- 采集结果入库（★核心去重） ----
   * 去重规则：
   *   1. room_id 已存在 → 不计入
   *   2. 相同 start_time + 相同 map_id 已存在 → 视为同一场，不计入
   */
  Store.prototype.ingest = function (payload) {
    var out = { inserted: 0, duplicates: 0, players: 0, totalMatches: 0, totalRosters: 0, errors: [] };
    if (!payload) { out.errors.push('空数据'); return Promise.resolve(out); }

    var s = this.state;
    var role = N.role(payload.role);
    if (role.openid && s.meta.openid && role.openid !== s.meta.openid) {
      out.errors.push('openid 与当前账号不一致（当前 ' + s.meta.openid + '，收到 ' + role.openid + '）');
      return Promise.resolve(out);
    }
    if (role.openid) {
      s.role = role;
      s.meta.openid = role.openid;
      s.meta.name = role.name || s.meta.name;
      s.meta.area = role.area;
      if (!s.meta.first_seen) s.meta.first_seen = Date.now();
    }

    if (payload.season && payload.season.season) {
      var sid = String(payload.season.season.sid || '10');
      s.seasons[sid] = { report: payload.season, maps: payload.maps || null, at: payload.at || Date.now() };
    } else if (payload.maps) {
      var sid2 = String((payload.maps && payload.sid) || '10');
      s.seasons[sid2] = Object.assign({}, s.seasons[sid2] || { at: Date.now() }, { maps: payload.maps });
    }

    s.meta.last_sync = payload.at || Date.now();

    var openid = s.meta.openid;
    var tdms = (payload.list && payload.list.tdms) || [];
    var self = this;
    tdms.forEach(function (row) {
      if (!row || !row.roomId) return;
      var m = N.match(row, openid, payload.at);
      if (s.matches[m.room_id]) { out.duplicates++; return; }
      var key = m.start_time + '|' + m.map_id;
      var existingRid = self._startIndex[key];
      if (existingRid) {
        var existing = s.matches[existingRid];
        // 只有当既有记录也归属当前账号（或未标注归属）时才判重；
        // 若既有记录 owner_openid 与当前不同（历史遗留/迁移未清理），允许重新入库。
        if (!existing || !existing.owner_openid || existing.owner_openid === openid) {
          out.duplicates++;
          return;
        }
      }
      s.matches[m.room_id] = m;
      self._startIndex[key] = m.room_id;
      out.inserted++;
    });

    (payload.details || []).forEach(function (d) {
      var pl = (d.detail && d.detail.battle_detail && d.detail.battle_detail.tdm_players) || [];
      if (!pl.length || !d.roomId) return;
      var rid = String(d.roomId);
      var existing = s.rosters[rid];
      /* ★ 这句以前只比人数（`existing.players.length >= pl.length` 就丢），结果把一份
      *   "人齐了、但某些列官方还没填"的半份名单永久钉死：实测 09-25 15:11 那场，
      *   列表接口给"我"的 rescue = 36，而详情名单里 78 人全场之和只有 14（只有 4 人有值）。
      *   官方只会往后补齐不会倒退 ⇒ 人数相同也一律以**新抓的**为准，
      *   只有"新人少了"（部分返回）才留着旧的。 */
      if (existing && existing.players && pl.length < existing.players.length) return;
      s.rosters[rid] = {
        at: Date.now(),
        refetch: existing ? (Number(existing.refetch) || 0) + 1 : 0,
        players: pl.map(N.player).filter(function (p) { return p.vopenid || p.name; })
      };
      out.players += s.rosters[rid].players.length;
    });

    return this.save().then(function () {
      out.totalMatches = Object.keys(s.matches).length;
      out.totalRosters = Object.keys(s.rosters).length;
      return out;
    });
  };

  /* ---- 查询 ----
   * opts:
   *   mode:  'all' | 'swtwr' | 'commander' | 'other'   模式筛选（默认 all）
   *   leave: 'all' | 'exclude' | 'only'                中途退出筛选（默认 all）
   *   includeExcluded: true 时连「不纳入统计」的场次一起返回（仅战局列表用）
   *   mapId, since, until, search
   * 注意：mode 三条判定是独立的，已手动标记指挥官的胜者为王场次会同时命中
   * 'swtwr' 与 'commander'，但 mode='all' 仍只返回一行 —— 战局不会重复。
   */
  /* ★ 一场到底进不进统计，全项目只有这一处判据（core/analysis.js 里那份重复实现这次一并收掉）。
   * 三条口径写死在这儿：
   *   ① 「不纳入统计」**赢**：被排除的场次只在 `includeExcluded` 且 kind='all' 时才露面
   *      （战局列表里灰显保留），切到「比赛」或「匹配」都不出现 —— 免得既标比赛又排除的那场两边各数一次；
   *      它仍然要过下面其余条件，这一条与旧版逐字一致，不改任何既有调用方的结果集。
   *   ② mode 与 kind 是**两个正交的轴**（官方怎么分模式 vs 人认不认这是比赛），谁也不改写谁。
   *   ③ 比赛 ⊆ 胜者为王（门槛在 setMatchFlag 与 prune，脏值进不来）。 */
  Store.prototype.passes = function (m, o) {
    o = o || {};
    var mode = o.mode || (o.swtwrOnly ? 'swtwr' : 'all');
    var leave = o.leave || (o.excludeLeave ? 'exclude' : 'all');
    var kind = o.kind || 'all';
    if (m.excluded && !(o.includeExcluded === true && kind === 'all')) return false;
    if (mode === 'swtwr' && !m.is_swtwr) return false;
    if (mode === 'commander' && !m.is_commander) return false;
    if (mode === 'other' && (m.is_swtwr || m.is_commander)) return false;
    if (kind === 'comp' && !m.is_competition) return false;
    if (kind === 'practice' && m.is_competition) return false;
    if (leave === 'exclude' && m.is_leave) return false;
    if (leave === 'only' && !m.is_leave) return false;
    if (o.mapId && String(m.map_id) !== String(o.mapId)) return false;
    if (o.since && m.start_time < o.since) return false;
    if (o.until && m.start_time > o.until) return false;
    if (o.search && String(m.map_name || '').indexOf(o.search) === -1) return false;
    return true;
  };

  Store.prototype.matches = function (opts) {
    var self = this, rows = [], ms = this.state.matches;
    for (var k in ms) {
      if (!Object.prototype.hasOwnProperty.call(ms, k)) continue;
      if (self.passes(ms[k], opts)) rows.push(ms[k]);
    }
    rows.sort(function (a, b) { return b.start_time - a.start_time; });
    return rows;
  };

  /* 模式计数，用于筛选器显示数量。
   * 与 matches() 一样默认剔除「不纳入统计」的场次，另给 excluded 桶供 UI 显示总数。
   * 口径：all === swtwr + other；commander ⊆ swtwr（手动标记，不额外占场次额度）；
   *      all === comp + practice（人工那一枚的第二套划分，与模式轴正交，所以两条等式同时成立）
   */
  Store.prototype.modeCounts = function () {
    var c = { all: 0, swtwr: 0, commander: 0, other: 0, leave: 0, excluded: 0, comp: 0, practice: 0 };
    var ms = this.state.matches;
    for (var k in ms) {
      if (!Object.prototype.hasOwnProperty.call(ms, k)) continue;
      var m = ms[k];
      if (m.excluded) { c.excluded++; continue; }
      c.all++;
      if (m.is_swtwr) c.swtwr++;
      if (m.is_commander) c.commander++;
      if (!m.is_swtwr && !m.is_commander) c.other++;
      if (m.is_competition) c.comp++; else c.practice++;
      if (m.is_leave) c.leave++;
    }
    return c;
  };

  Store.prototype.match = function (roomId) {
    return this.state.matches[String(roomId)] || null;
  };

  Store.prototype.players = function (roomId) {
    var r = this.state.rosters[String(roomId)];
    if (!r) return [];
    return r.players.slice().sort(function (a, b) { return b.score - a.score; });
  };

  Store.prototype.setSettings = function (patch) {
    this.state.settings = Object.assign(this.state.settings, patch || {});
    return this.save();
  };

  /* ---- 用户标注：手动指挥官标记 / 不纳入统计 / 手动比赛标记 ----
   * 只存进 flags 表，save() 时由 prune() 物化到 match.is_commander / match.excluded / match.is_competition
   */
  var FLAG_KEYS = { commander: 1, excluded: 1, competition: 1 };
  Store.prototype.setMatchFlag = function (roomId, key, val) {
    var rid = String(roomId || '');
    if (!rid || !this.state.matches[rid]) return Promise.resolve({ ok: false, error: '找不到这场对局' });
    if (!FLAG_KEYS[key]) return Promise.resolve({ ok: false, error: '未知的标记类型' });
    /* 按钮只在胜者为王场次显示，但这里才是唯一的真门槛：不信任调用方 */
    if (key === 'commander' && val && !this.state.matches[rid].is_swtwr) {
      return Promise.resolve({ ok: false, error: '指挥官标记仅适用于胜者为王对局' });
    }
    /* 「比赛对局」同一道门槛：它是纯人工标记（官方字段认不出比赛，所以没有任何自动预填这条路），
     * 但只有胜者为王能标 —— 攻防/占领图上冒出来的比赛值一律拒，宁缺毋滥。 */
    if (key === 'competition' && val && !this.state.matches[rid].is_swtwr) {
      return Promise.resolve({ ok: false, error: '比赛标记仅适用于胜者为王对局' });
    }
    var f = this.state.flags[rid] || (this.state.flags[rid] = {});
    f[key] = val ? 1 : 0;
    if (!f.commander && !f.excluded && !f.competition) delete this.state.flags[rid];
    var self = this;
    return this.save().then(function () {
      return { ok: true, roomId: rid, flags: self.flag(rid), counts: self.modeCounts() };
    });
  };

  Store.prototype.flag = function (roomId) {
    return Object.assign({}, this.state.flags[String(roomId)] || {});
  };

  /* ---- 关注玩家（people 表）----
   * ★ 主键必须是 analysis.buildIdentityIndex 产出的聚合键，全项目只有一套身份规则：
   *   'id:<openid>' 稳定账号 / 'nm:<昵称>' 昵称聚合 / 'slot:<场>:<vid>' 当局临时编号。
   *   slot 级一律拒绝 —— 4 位编号每局重分配（实测同一个编号在 8 场里对应 8 个不同的人），
   *   存下来只会得到一个凭空捏造的"熟人"。
   */
  var WATCH_KEY = /^(id|nm):/;
  Store.prototype.setWatch = function (key, on, info) {
    var k = String(key || '');
    if (!k) return Promise.resolve({ ok: false, error: '缺少玩家标识' });
    if (k.indexOf('slot:') === 0) {
      return Promise.resolve({
        ok: false, code: 'ephemeral',
        error: '这个人的账号标识是当局临时编号，每局重新分配，无法跨局认出他，所以不能关注'
      });
    }
    if (!WATCH_KEY.test(k)) return Promise.resolve({ ok: false, error: '无法识别的玩家标识' });
    info = info || {};
    var openid = String(info.openid || (k.indexOf('id:') === 0 ? k.slice(3) : ''));
    if (k.indexOf('id:') === 0 && openid.length < 10) {
      return Promise.resolve({ ok: false, code: 'weak', error: '账号标识不完整，无法稳定识别这个人' });
    }
    if (k.indexOf('nm:') === 0 && !String(info.name || '').trim()) {
      return Promise.resolve({ ok: false, code: 'weak', error: '缺少昵称，无法按昵称识别' });
    }
    if (on) {
      this.state.people[k] = {
        key: k, openid: openid, name: String(info.name || ''),
        confidence: k.indexOf('id:') === 0 ? 'id' : 'name', since: Date.now()
      };
    } else {
      delete this.state.people[k];
    }
    var self = this;
    return this.save().then(function () {
      return { ok: true, key: k, on: !!on, people: self.watched() };
    });
  };

  Store.prototype.watched = function () {
    var p = this.state.people || {};
    return Object.keys(p).map(function (k) { return p[k]; })
      .sort(function (a, b) { return (b.since || 0) - (a.since || 0); });
  };

  Store.prototype.isWatched = function (key) {
    return !!(this.state.people || {})[String(key || '')];
  };

  /* 脏键回收：只应由载入方调用一次（要拿全量身份索引，不能塞进 prune 的热路径）。
   * groups 传的是 buildIdentityIndex(store).groups —— 由调用方建好传进来，
   * 这样 store 不反向依赖 analysis。changed 为真时调用方自己决定要不要 save()。 */
  Store.prototype.gcPeople = function (groups) {
    var p = this.state.people || {};
    var removed = 0;
    Object.keys(p).forEach(function (k) {
      if (!groups || !groups[k]) { delete p[k]; removed++; }
    });
    return { removed: removed, changed: removed > 0 };
  };

  /* ---- 同步窗口台账：漏采检测唯一的证据来源 ----
   * 官方每轮只回最新约 36 场。设上一轮窗口里最新一场为 prev.newest、本轮窗口里最老一场为 w.oldest：
   *   w.oldest > prev.newest  ⟺ 上一轮见到的每一场都已经跌出官方窗口，
   *                             且 [prev.newest, w.oldest] 这段里的场次我们从未见过。
   * 这段区间可以直接摊给用户看，不需要猜「你到底打了几场」；
   * 只要没打超一窗，本轮窗口必然还含着上一轮的场次，判据自然为假 —— 这就是它比"新增数逼近整窗"
   * 那种比率启发式可靠的原因。不足两轮无从比较，只记录不判定。
   */
  Store.prototype.recordSyncWindow = function (w) {
    w = w || {};
    var oldest = Number(w.oldest) || 0, newest = Number(w.newest) || 0;
    if (!oldest || !newest) return Promise.resolve({ ok: true, skipped: true, suspect: false });

    var list = this.state.meta.sync_windows || [];
    var prev = null;
    list.forEach(function (x) { if (!prev || (x.at || 0) > (prev.at || 0)) prev = x; });

    var out = { ok: true, firstRound: !prev, suspect: false, from: 0, to: 0, days: 0 };
    if (prev && (Number(prev.newest) || 0) > 0 && oldest > Number(prev.newest)) {
      out.suspect = true;
      out.from = Number(prev.newest);
      out.to = oldest;
      out.days = Math.max(1, Math.round((oldest - Number(prev.newest)) / 86400));
    }
    list.push({
      at: Number(w.at) || Date.now(), oldest: oldest, newest: newest,
      count: Number(w.count) || 0, inserted: Number(w.inserted) || 0,
      /* ★ 翻页自证（判据在 core/collector.js 的 pageTrace）：这一轮翻了几页、每页回来几条、
       *   最后为什么停。使用者问"我打了很多把怎么只有 17 场"时，只有这三样能分清
       *   是官方窗口到底了、还是我们提前停了、还是抓回来被判重吃掉了。缺信息就如实留空。 */
      pages: (w.trace && w.trace.pages && w.trace.pages.length) || 0,
      rows: (w.trace && w.trace.pages ? w.trace.pages.map(function (p) { return p.rows; }) : []),
      kept: (w.trace && w.trace.kept) || 0,
      stop: (w.trace && w.trace.stop) || '',
      /* 停因的原话由 collector 的 STOP_TEXT 给，存进账本是为了让界面直接念 ——
       * 界面不许再抄一份"翻满 5 页就是到底了"的说法（抄第二份必漂移）。 */
      stopText: (w.trace && w.trace.stopText) || '',
      capped: !!(w.trace && w.trace.stop === 'cap')
    });
    this.state.meta.sync_windows = list;

    var self = this;
    return this.save().then(function () {
      out.windows = self.state.meta.sync_windows.length;
      return out;
    });
  };

  /* 按时间升序返回，方便画"每轮窗口最老一场"的推进轨迹 */
  Store.prototype.syncWindows = function () {
    return (this.state.meta.sync_windows || []).slice()
      .sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
  };

  /* 本地库总量（不受「不纳入统计」影响），用于 UI 区分「本地 N 场 / 纳入 M 场」 */
  Store.prototype.storedCounts = function () {
    var total = 0, excluded = 0, ms = this.state.matches;
    for (var k in ms) {
      if (!Object.prototype.hasOwnProperty.call(ms, k)) continue;
      total++;
      if (ms[k].excluded) excluded++;
    }
    return { total: total, excluded: excluded };
  };

  Store.prototype.activeOpenid = function () {
    return this.state.meta.openid || '';
  };

  Store.prototype.activeName = function () {
    return this.state.meta.name || '';
  };

  /* 完整数据包的字段白名单 —— 「什么可以离开这台机器」是策略，放在 core 里才断言得住。
   * ★ 刻意不含：people（别人的 openid 与昵称）、aiReports（大模型回复）、settings（设备与个人偏好）。
   *   flags 在里面，因为那是用户对自己场次的标注，不是第三方身份。 */
  Store.prototype.bundleView = function () {
    var s = this.state;
    return {
      meta: s.meta,
      role: s.role,
      seasons: s.seasons,
      matches: s.matches,
      rosters: s.rosters,
      flags: s.flags || {}
    };
  };

  Store.prototype.clearData = function () {
    this.state.matches = {};
    this.state.rosters = {};
    this.state.seasons = {};
    this.state.flags = {};
    this.state.aiReports = {};
    /* 关注表装的是别人的 openid/昵称，窗口台账是采集历史 —— 「清空」必须连它们一起清 */
    this.state.people = {};
    this.state.meta = Object.assign(this.state.meta, { sync_windows: [] });
    this.state.role = null;
    this._reindex();
    return this.save();
  };

  Store.prototype.reset = function () {
    var keep = this.state.settings;
    this.state = defaultState();
    this.state.settings = keep;
    return this.save();
  };

  /* ★ 本机还有多少场「认不出地名」（内置表与本机学名表都查不到）——
   *   这是设置页那行状态与「更新地图名到底有没有生效」唯一的度量口径。
   *   判定只用 Maps.isKnownMap：别处再数一遍就会跟着兜底串的写法各说各话。 */
  Store.prototype.unknownMaps = function () {
    var ms = this.state.matches || {}, n = 0;
    Object.keys(ms).forEach(function (k) {
      if (!Maps.isKnownMap(ms[k].map_id)) n++;
    });
    return n;
  };

  /* 本机打过的图有哪些、各多少场、现在显示什么名、那名字是哪来的（user/builtin/learned/空=不认得）。
   * 设置页那块「本机字典」与地图页那颗「改名」都读这一份；判定只用 Maps.nameOf / nameSource，
   * 与上面 unknownMaps 同一条规矩 —— 别处再拼一遍就会跟着兜底串的写法各说各话。 */
  Store.prototype.mapUsage = function () {
    var ms = this.state.matches || {}, g = {};
    Object.keys(ms).forEach(function (k) {
      var id = String(ms[k].map_id);
      if (!g[id]) g[id] = { id: id, name: Maps.nameOf(ms[k].map_id),
        source: Maps.nameSource(ms[k].map_id), count: 0 };
      g[id].count++;
    });
    return Object.keys(g).map(function (k) { return g[k]; })
      .sort(function (a, b) { return b.count - a.count || Number(a.id) - Number(b.id); });
  };

  /** 撤销一条「使用者自己起的名字」：把库里那些正显示着那个名字的场次退回它现在该显示的值。
   *  为什么 prune 那条清算办不到：它只在 **id 认得出** 的时候改名，而"还原"恰恰是让 id
   *  重新变回认不出（或退回本来的名字）—— 那一头结构上够不着，所以这半边由这里补一刀，
   *  不能让界面自己猜（三个壳共用这一份，桌面/安卓/预览层同一条口径）。
   *  ★ 只动「名字正好等于我刚才撤掉的那一个」的场次：别人包里带来的真名一个字都不碰（坑 19 同一道闸）。
   * @returns {number} 改回了几场 */
  Store.prototype.rollbackMapName = function (id, wasName) {
    var ms = this.state.matches || {}, key = String(id), was = String(wasName == null ? '' : wasName);
    var now = Maps.nameOf(id), n = 0;
    Object.keys(ms).forEach(function (k) {
      var m = ms[k];
      if (String(m.map_id) === key && String(m.map_name || '') === was && m.map_name !== now) {
        m.map_name = now; n++;
      }
    });
    return n;
  };

  Store.prototype.stats = function () {
    return {
      matches: Object.keys(this.state.matches).length,
      rosters: Object.keys(this.state.rosters).length,
      people: Object.keys(this.state.people || {}).length,
      players: Object.keys(this.state.rosters).reduce(function (a, k) {
        return a + this.state.rosters[k].players.length;
      }.bind(this), 0)
    };
  };

  /* ---- 名单可信度：官方两份接口填列有先后 ----------------------------------
   * 同一场比赛，"战局列表"给的那一行与"单局详情"名单里我这一行应当一致；
   * 若列表说我有 36 个救治而名单里我是 0（且全场之和才 14），那不是我们算错，
   * 是**详情接口这一列当时还没填**。判据只在"列表 > 0 而名单 = 0"这一个方向上成立：
   * 反过来（列表 0、名单有值）是真打了 0，不能当缺值。
   * force_type / is_winner 一律不比 —— 官方对名单里的人（包括我）就是不填这两列。 */
  var ROSTER_TRUST_FIELDS = ['kill', 'death', 'assist', 'score', 'occupy', 'rescue'];
  var ROSTER_REFETCH_MAX = 2;    // 同一场最多自动重抓几次，抓不回就别每轮都发

  function rosterGaps(match, roster, openid) {
    if (!match || !roster || !roster.players || !roster.players.length) return [];
    var me = null;
    for (var i = 0; i < roster.players.length; i++) {
      if (String(roster.players[i].vopenid) === String(openid)) { me = roster.players[i]; break; }
    }
    if (!me) return [];
    return ROSTER_TRUST_FIELDS.filter(function (f) {
      return Number(match[f] || 0) > 0 && Number(me[f] || 0) === 0;
    });
  }

  Store.prototype.rosterGaps = function (roomId) {
    var rid = String(roomId);
    return rosterGaps(this.state.matches[rid], this.state.rosters[rid], this.activeOpenid());
  };

  /* 哪些场次的名单是半份、还要不要再抓：同步据此决定"已有名单"的清单 */
  Store.prototype.doubtRoomIds = function () {
    var self = this, out = [];
    Object.keys(this.state.rosters).forEach(function (k) {
      var r = self.state.rosters[k];
      if (!rosterGaps(self.state.matches[k], r, self.activeOpenid()).length) return;
      if ((Number(r && r.refetch) || 0) >= ROSTER_REFETCH_MAX) return;   // 抓 over 就算了，只保留标记
      out.push(k);
    });
    return out;
  };

  /* 「本机已经有这场名单」= 有名单 **且** 不打算再重抓。两个壳同步时都调这一颗，
   * 免得一边漏了过滤、另一边每轮都去重抓同一场。 */
  Store.prototype.trustedRosterRoomIds = function () {
    var doubt = this.doubtRoomIds();
    return Object.keys(this.state.rosters || {}).filter(function (k) {
      return doubt.indexOf(k) === -1;
    });
  };

  /* ★ 归属核对（2026-09-26，桌面「换号后读的还是小号的」那一条的判据）。
   * 采回来的一堆场次要写进哪个库，凭的是"这个槽登记的人"；而会话里此刻是谁，只有官方回的角色知道。
   * 两边都有 openid 却不一致 ⇒ 冲突，一个字都不许写：两个号的场次混进同一份库，
   * 胜率、评分曲线、对手档案全部算错，而且事后分不开 —— 比"同步失败"坏得多。
   * 任何一侧没有 openid 都算"还不知道"，不判冲突（第一次落盘之前、老版本迁移过来的记录都是这种）。
   * 判据放这一份，两个壳各自只负责把自己的措辞接上（与 localOnly 那句同一手法）。 */
  function ownerConflict(claimedOpenid, gotOpenid) {
    var a = String(claimedOpenid || ''), b = String(gotOpenid || '');
    return (a && b && a !== b) ? (a + ' ≠ ' + b) : '';
  }

  /* ★★ 备份文件名怎么认（2026-09-26，「点立即备份说已备份到 undefined、备份列表一直是空的」的根因）。
   * doBackup 写出来的名字里那枚时间戳是 `toISOString().slice(0,19)` 把 `:` 与 `T` 都换成 `-`，
   * 也就是 `2026-09-26-01-29-03`（六位、每两枚一组）；而老的判定要的是 `yyyymmdd-hhmmss` 那种紧凑形状 ⇒
   * **自己写的文件自己认不出**：目录里 17 个文件一个都不算备份，列表永远空，保留份数也永远裁不动。
   * 这一颗两种形状都认，并把「哪个号 / 哪一次（manual | daily-… | pre-restore-…）/ 什么时候」拆出来。
   * 号与标签之间可能有多个 `-`（tag 自己带日期），所以时间戳只能从**右**往左拆。 */
  function parseBackupName(name) {
    var s = String(name || '');
    if (!/^df-swtwr-.+\.json$/.test(s)) return null;
    if (s.indexOf('.v1.bak.') !== -1 || s.indexOf('.corrupt-') !== -1) return null;
    var body = s.slice('df-swtwr-'.length, -'.json'.length);
    var m = /-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/.exec(body) ||
            /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(body);
    if (!m) return null;
    var mid = body.slice(0, body.length - m[0].length);
    if (!mid) return null;
    var firstDash = mid.indexOf('-');
    var slot = firstDash === -1 ? mid : mid.slice(0, firstDash);
    /* 号名为空（`df-swtwr--manual-…`）不是我们的备份：恢复要靠它找目标槽，空槽名什么都指不到 */
    if (!slot) return null;
    return {
      file: s,
      slot: slot,
      tag: firstDash === -1 ? '' : mid.slice(firstDash + 1),
      at: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4]), Number(m[5]), Number(m[6])),
      when: m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6]
    };
  }

  /* "这是不是一个备份"只这一个问题，判据也只在这一处（目录遍历与裁剪共用） */
  function isBackupName(name) { return !!parseBackupName(name); }

  /* ★ 一个备份文件里到底装了什么：列表要念给人听的那几句（几场、跨度到哪、谁的号）从这里出。
   * 纯函数：给它解析好的对象，不碰文件 —— 两个壳自己读盘再交进来。
   * kind 三种：library（某个号的战绩库，可恢复）/ accounts（整机账号表）/ unknown（不是我们的东西）。 */
  function summarizeBackup(data) {
    if (!data || typeof data !== 'object') return { kind: 'unknown' };
    if (Array.isArray(data.accounts)) {
      var names = data.accounts.map(function (a) {
        return String((a && a.name) || (a && a.slot) || '');
      }).filter(Boolean);
      return { kind: 'accounts', accounts: names.length, who: names.join('、'),
        activeSlot: String(data.activeSlot || '') };
    }
    var matches = data.matches && typeof data.matches === 'object' ? data.matches : null;
    if (!matches && !data.rosters) return { kind: 'unknown' };
    var rows = Object.keys(matches || {}).map(function (k) { return matches[k] || {}; });
    var ts = rows.map(function (r) { return Number(r.start_time) || 0; })
      .filter(function (t) { return t > 0; });
    var meta = data.meta || {};
    return {
      kind: 'library',
      matches: rows.length,
      rosters: data.rosters ? Object.keys(data.rosters).length : 0,
      excluded: rows.filter(function (r) { return !!r.excluded; }).length,
      first: ts.length ? Math.min.apply(null, ts) : 0,
      last: ts.length ? Math.max.apply(null, ts) : 0,
      lastSync: Number(meta.last_sync) || 0,
      openid: String(meta.openid || ''),
      name: String(meta.name || '')
    };
  }

  return {
    Store: Store, defaultState: defaultState, prune: prune,
    rosterGaps: rosterGaps, ownerConflict: ownerConflict,
    parseBackupName: parseBackupName, isBackupName: isBackupName, summarizeBackup: summarizeBackup,
    ROSTER_TRUST_FIELDS: ROSTER_TRUST_FIELDS, ROSTER_REFETCH_MAX: ROSTER_REFETCH_MAX,
    LIMITS: { matches: MAX_MATCHES, rosters: MAX_ROSTERS, aiReports: MAX_AI_REPORTS,
      syncWindows: MAX_SYNC_WINDOWS, people: MAX_PEOPLE }
  };
});
