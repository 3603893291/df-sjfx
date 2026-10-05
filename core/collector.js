/* collector.js — 采集器（纯 JS，UMD）
 * 网络能力通过适配器注入：net.post(path, body) -> Promise<Object>
 * 桌面端适配器 = Electron session.fetch（自带登录态）
 * 移动端适配器 = WebView 内请求
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./maps'));
  } else {
    root.DFCore = root.DFCore || {};
    root.DFCore.Collector = factory(root.DFCore.Maps);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Maps) {
  'use strict';

  var API = '/api/v1/wegame.pallas.dfm.DfmBattle/';
  var QUEUE = 'tdm';                  // tdm = 全面战场
  /* 官方用 account_type 挑**账号体系**：1 = QQ、2 = 微信。这两枚值当初是从一个 QQ 会话里
   * 抄出来的，于是代码里到处写死 1 —— 微信登录的人拿 1 去问，官方认不到这个人，
   * 回的是"没有角色 / 未登录"那一类错误码（不是异常），表现就是"网页明明登录了，
   * 软件却一直不回调"。 */
  var ACCOUNT_TYPES = [1, 2];
  var NOT_LOGIN_CODES = [8000102, 8000103, 1001001, 1001002];
  var AFTER_IDX = 6;                  // 官方 tdms[6].dtEventTime 是下一页游标
  var PAGE_SIZE_UI = 7;               // 服务端固定返 8 条，UI 每页 7 条
  var DEFAULT_PAGES = 5;              // 最多 5 页
  var DEFAULT_PAGE_DELAY = 500;
  /* ★ 官方没有"当前是第几赛季"可查的接口（这条是核过的：抓到的那 12 个端点里没有一个给赛季清单），
   *   而 GetBattleList 根本不带 sid ⇒ 只有「赛季汇总」「分地图统计」这两发用得上 sid。
   *   以前这里写死 '10'（从浏览器插件那版抄来的），换赛季后那两块就把旧赛季的总数念成"本赛季"。
   *   所以现在改成：由调用方传（本机设置里那一枚），没传就用这颗默认值，
   *   并且**每一发都把实际问出去的 sid 记回包里**（out.sid），界面据此如实说是第几赛季 ——
   *   "猜不出当前赛季"这件事由使用者自己看见、自己调，比软件假装知道要诚实。 */
  var DEFAULT_SID = '10';
  /* 翻页为什么停 —— 每一种都对应一种真实可能，混成一句"抓完了"就没法判"是不是我们提前停了" */
  var STOP_TEXT = {
    cap: '已到最多 ' + DEFAULT_PAGES + ' 页的上限（官方窗口再往前就不给了）',
    empty: '官方这一页一条都没回 ⇒ 战历到此为止',
    short: '官方这一页少于 ' + PAGE_SIZE_UI + ' 条 ⇒ 按官方分页规则判定窗口到底',
    no_cursor: '这一页第 7 条没有时间游标 ⇒ 没法再往后翻，只能停在这里',
    error: '这一页请求失败（原因见同步报错），后面的页没再问'
  };

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* 从上一页响应里提取 after 游标：tdms[6].dtEventTime，字符串"YYYY-MM-DD HH:MM:SS"
   * 少于 7 条说明到底了；返回 null 让上层停止翻页 */
  function extractAfter(tdms) {
    if (!tdms || tdms.length < PAGE_SIZE_UI) return null;
    return (tdms[AFTER_IDX] && tdms[AFTER_IDX].dtEventTime) || null;
  }

  function Collector(net) {
    this.net = net;
    /* 这个号属于哪套账号体系：登录探测成功那一次定下来，之后每一发采集都按它发。
     * 默认 1 是历史行为（QQ 端），微信的号要靠 probeLogin 把它纠成 2。 */
    this.accountType = 1;
  }

  Collector.prototype.setAccountType = function (t) {
    this.accountType = Number(t) === 2 ? 2 : 1;
    return this.accountType;
  };

  Collector.prototype.api = function (endpoint, body) {
    return this.net.post(API + endpoint, body).then(function (d) {
      if (d && d.result && d.result.error_code) {
        var code = d.result.error_code;
        var err = new Error('接口 ' + endpoint + ' 返回错误码 ' + code +
          (d.result.error_message ? '：' + d.result.error_message : ''));
        err.code = code;
        err.notLogin = NOT_LOGIN_CODES.indexOf(Number(code)) !== -1;
        err.payload = d;
        throw err;
      }
      return d;
    });
  };

  /* 登录态检测：能正常拿到玩家资料即视为已登录 */
  Collector.prototype.checkLogin = function (accountType) {
    var t = Number(accountType) || this.accountType || 1;
    return this.api('GetRoleInfo', { from_src: 'df_web', account_type: t, area: 36 })
      .then(function (d) {
        var ri = d.role_info;
        if (!ri || !ri.openid) {
          return { ok: false, accountType: t, reason: 'no_role', message: '未获取到账号信息' };
        }
        return {
          ok: true,
          accountType: t,
          role: {
            openid: String(ri.openid), area: Number(ri.area) || 36, name: ri.name || '',
            level: Number(ri.level) || 0, tdm_level: Number(ri.tdmLevel) || 0,
            tdm_exp: Number(ri.tdmExp) || 0
          }
        };
      })
      .catch(function (e) {
        /* ★ 官方错误码要留着：上一版这里只回一句话，调用方又整个吞掉，
         *   微信用户能描述的就只有"网页登录了但软件没反应"。 */
        return {
          ok: false,
          accountType: t,
          reason: e.notLogin ? 'not_login' : 'error',
          code: e.code || '',
          message: e.message || String(e)
        };
      });
  };

  /* 「两套体系都没问到角色」连问这么多轮才劝人换号（安卓 2 秒一轮、桌面 2.5 秒一轮 ⇒ 约 16~20 秒）。
   * 留这段余量是因为真有人慢：授权页停在手机上等人点确认，前几轮全空是常态，
   * 一上来就喊"换个号"会把正在正常登录的人劝走。
   * ★ 阈值、连问计数、那句话全在这里（与 matchTips 同一规矩：判定与措辞都出自 core，界面只排版）。
   *   计数挂在采集器实例上，并且**登录成功那一发就归零**：不然一个人上一次被卡过 8 轮，
   *   下一次真登录成功了、隔几天再开一窗，第一句就是"换个号"——那是拿旧账说新事。
   *   两端都保证"开一窗从零数起"：安卓每开一窗 new 一个探测采集器，桌面复用长驻采集器所以开窗时显式归零。 */
  var PROBE_NO_ROLE_ROUNDS = 8;
  var PROBE_NO_ROLE_ADVICE = '官方认得这个登录态，但它下面没有三角洲角色（网页里那句「无角色信息」就是它）。' +
    '关掉这个窗口，改用有角色的那个号（QQ 或微信）重新授权 —— 继续等不会自己变出角色来。';
  function allNoRole(attempts) {
    return attempts.length > 0 && attempts.every(function (a) { return a.reason === 'no_role'; });
  }

  /* 登录窗里用的那一发：两套账号体系逐个问，谁问到角色就是谁。
   * attempts 是给界面看的证据（每发试了什么、回了什么码），不是日志：
   * 对不上的时候使用者能把这行字回过来，而不是让我们猜。 */
  Collector.prototype.probeLogin = function (types) {
    var list = (types && types.length) ? types : ACCOUNT_TYPES;
    var self = this, i = 0, attempts = [];
    function one() {
      if (i >= list.length) {
        self.noRoleRounds = allNoRole(attempts) ? (self.noRoleRounds || 0) + 1 : 0;
        return { ok: false, reason: 'no_role', attempts: attempts,
          rounds: self.noRoleRounds,
          advice: self.noRoleRounds >= PROBE_NO_ROLE_ROUNDS ? PROBE_NO_ROLE_ADVICE : '',
          message: 'QQ 与微信两套账号体系都没问到角色信息（多半是登录态还没落进来）' };
      }
      var t = list[i++];
      return self.checkLogin(t).then(function (r) {
        attempts.push({ accountType: t, ok: !!r.ok, code: r.code || '',
          reason: r.ok ? '' : (r.reason || 'no_role') });
        if (!r.ok) return one();
        self.setAccountType(t);
        self.noRoleRounds = 0;
        r.accountType = self.accountType;
        r.attempts = attempts;
        return r;
      });
    }
    return one();
  };

  function base(openid, area, accountType) {
    return { openid: String(openid), area: Number(area) || 36,
      account_type: Number(accountType) || 1, from_src: 'df_web' };
  }

  /* 完整采集：赛季汇总 + 分地图 + 最近战局 + 逐局全场名单
   * opts.haveRosters   已有名单的 roomId 列表，这些场次不再抓详情（缺名单的老场次会自动补采）
   * opts.onProgress(p)  p = { stage, done, total, percent, label, roomId? }
   */
  Collector.prototype.collect = function (opts) {
    opts = opts || {};
    var self = this;
    var out = { at: Date.now(), role: null, season: null, list: null, sid: '',
                maps: null, details: [], errors: [], pageTrace: null };

    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var stages = ['登录检测', '赛季汇总', '最近战局', '分地图统计', '全场名单'];
    function emitProgress(stageIdx, done, total, extra) {
      var pct = 0;
      var detailTotal = Math.max(1, total || 1);
      pct = Math.min(99, Math.round(((stageIdx + (done / detailTotal)) / stages.length) * 100));
      var p = {
        stage: stages[stageIdx] || '处理中',
        stageIndex: stageIdx,
        stageTotal: stages.length,
        done: done || 0,
        total: total || 0,
        percent: pct,
        label: (stages[stageIdx] || '处理中') +
          (total > 1 ? ' ' + done + '/' + total : '')
      };
      if (extra) Object.assign(p, extra);
      try { onProgress(p); } catch (e) { /* 回调异常不阻断采集 */ }
    }

    return this.checkLogin().then(function (login) {
      if (!login.ok) {
        var e = new Error(login.message || '未登录');
        e.notLogin = login.reason === 'not_login';
        e.loginFailed = true;
        throw e;
      }
      out.role = login.role;
      var b = base(login.role.openid, login.role.area, self.accountType);
      var sid = String(opts.sid || DEFAULT_SID).replace(/[^\d]/g, '') || DEFAULT_SID;
      out.sid = sid;                  // 回包带上"这一轮问的是第几赛季"，界面不许再猜
      emitProgress(0, 1, 1);

      function step(name, fn) {
        return Promise.resolve()
          .then(fn)
          .catch(function (err) {
            out.errors.push(name + '：' + (err.message || err));
            if (err.loginFailed || err.notLogin) throw err;
          });
      }

      return step('赛季汇总', function () {
        return self.api('GetBattleReport', Object.assign({}, b, { sid: sid, queue: QUEUE }))
          .then(function (d) { out.season = d; emitProgress(1, 1, 1); });
      })
        .then(function () {
          return step('最近战局', function () {
            var pages = Math.max(1, Math.min(5, Number(opts.pages) || DEFAULT_PAGES));
            var delay = Number(opts.pageDelayMs);
            if (isNaN(delay)) delay = DEFAULT_PAGE_DELAY;
            var all = { tdms: [], sols: [], bricks: [] };
            var seen = {};
            var after = null;
            /* ★ 翻页自证：官方一次返 8 条、游标前进 7 条，所以一轮同步能落地的场数只会是
             *   8 / 15 / 22 / 29 / 36 这一串。使用者报"我打了很多把却只抓到 17 场"时，
             *   光看总数判不出是①官方窗口真的到底了 ②我们提前停了 ③抓回来被判重吃掉了 ——
             *   所以每一页回来几条、留下几条、最后为什么停，全记进 pageTrace 一路带到界面。 */
            var tr = { pages: [], cap: pages, pageSizeUi: PAGE_SIZE_UI, delayMs: delay,
                       rows: 0, kept: 0, stop: '', stopText: '' };
            out.pageTrace = tr;   /* 先按引用挂上：中途失败那一发也要让界面看得到记到第几页 */
            function stopHere(code) {
              tr.stop = code;
              tr.stopText = STOP_TEXT[code] || code;
            }
            function fetchPage(depth) {
              return self.api('GetBattleList', Object.assign({}, b, {
                size: 5, queue: QUEUE, after: after, filters: []
              })).then(function (d) {
                var tdms = (d && d.tdms) || [];
                var before = all.tdms.length;
                tdms.forEach(function (t) {
                  if (!t || !t.roomId || seen[t.roomId]) return;
                  seen[t.roomId] = 1;
                  all.tdms.push(t);
                });
                tr.rows += tdms.length;
                tr.kept += all.tdms.length - before;
                tr.pages.push({ depth: depth, rows: tdms.length, kept: all.tdms.length - before });
                emitProgress(2, depth, pages, { pageCount: depth, matchesSoFar: all.tdms.length });
                if (depth >= pages) { stopHere('cap'); return null; }
                if (tdms.length === 0) { stopHere('empty'); return null; }
                var next = extractAfter(tdms);
                if (!next) { stopHere(tdms.length < PAGE_SIZE_UI ? 'short' : 'no_cursor'); return null; }
                after = next;
                return sleep(delay).then(function () { return fetchPage(depth + 1); });
              }).catch(function (e) {
                /* 这一页失败 = 后面没再问，停因必须写清楚（step 那一层照旧把原因记进 errors） */
                stopHere('error');
                tr.errorText = String((e && e.message) || e);
                throw e;
              });
            }
            return fetchPage(1).then(function () {
              out.list = all;
              emitProgress(2, pages, pages);
            });
          });
        })
        .then(function () {
          return step('分地图统计', function () {
            return self.api('GetMapStats', Object.assign({}, b, {
              sid: sid, queue: QUEUE, mapids: Maps.tdmIds
            })).then(function (d) { out.maps = d; emitProgress(3, 1, 1); });
          });
        })
        .then(function () {
          if (!opts.withDetail) { emitProgress(4, 1, 1); return null; }
          var rows = (out.list && out.list.tdms) || [];
          var scope = opts.detailScope || 'all';
          var have = {};
          (opts.haveRosters || []).forEach(function (rid) { have[String(rid)] = 1; });
          var targets = rows.filter(function (r) {
            if (scope === 'swtwr' && !Maps.isSWWR(r.mapId, r.gameRule)) return false;
            return !have[String(r.roomId)];
          });
          var total = targets.length;
          if (!total) { emitProgress(4, 1, 1); return null; }
          var chain = Promise.resolve();
          targets.forEach(function (row, i) {
            chain = chain.then(function () {
              return self.api('GetBattleDetail', Object.assign({}, b, {
                queue: QUEUE, roomId: row.roomId, mapId: row.mapId, startTime: row.startTime
              })).then(function (d) {
                out.details.push({ roomId: row.roomId, detail: d });
              }).catch(function (err) {
                out.errors.push('战局详情 ' + row.roomId + '：' + (err.message || err));
              }).then(function () {
                emitProgress(4, i + 1, total, { roomId: row.roomId });
              });
            });
          });
          return chain;
        })
        .then(function () { return out; });
    });
  };

  return { Collector: Collector, QUEUE: QUEUE, NOT_LOGIN_CODES: NOT_LOGIN_CODES,
    /* DEFAULT_SID / STOP_TEXT 只在这里有一份：界面念"这一轮为什么停在这里"、设置页念默认赛季号，
     * 都读这两颗，不许在 ui 或两个壳里再抄一份说法（抄第二份必漂移，这条项目里已经踩过多次）。 */
    PROBE_NO_ROLE_ROUNDS: PROBE_NO_ROLE_ROUNDS, PROBE_NO_ROLE_ADVICE: PROBE_NO_ROLE_ADVICE,
    DEFAULT_SID: DEFAULT_SID, STOP_TEXT: STOP_TEXT };
});
