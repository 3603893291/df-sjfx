/* plugin-api.js — 插件能力桥（主进程内的白名单派发）
 *
 * 这是插件能拿到的**全部**能力，没有别的入口。渲染层把插件 iframe 里的调用原样转过来，
 * 但每个方法都要在这里重新查一遍：这个插件是否启用、是否声明并获批了这个 scope、
 * 网络目标是否在你批准的域名里。iframe 那边说了不算。
 *
 * ★ read.summary 只回聚合数字：这里刻意不传 room_id、不传玩家名单、不传任何可跨局关联的标识。
 *   插件想要明细，得让宿主新开一个 scope —— 而不是从汇总里绕出来。
 */
'use strict';

const Analysis = require('../core/analysis');
const Plg = require('../core/plugin');
const Net = require('./adapters/plugin-net');

const MODES = { all: 'all', swtwr: 'swtwr', other: 'other', commander: 'commander' };
const NET_WINDOW_MS = 60000;
const NET_WINDOW_MAX = 20;
/* 一个插件同时只留一条流：AI 那种"一次问答"的用法要不了第二条，
 * 留着它反而给插件一个绕开 20 次/分额度、同时开十个连接的口子。 */
const MAX_STREAMS_PER_PLUGIN = 1;
const STREAM_MERGE_MS = 40;
const STREAM_BODY_MAX = 256 * 1024;

function createPluginApi(opts) {
  const host = opts.host;
  const getStore = opts.getStore;
  /* 事件出口：main.js 把它接到 webContents.send，渲染层再 postMessage 给沙箱 iframe */
  const emitTo = typeof opts.emit === 'function' ? opts.emit : function () {};
  /* 摘要与旧数据由宿主生成/交出：本文件不碰 core/aiDigest，也不碰 fs */
  const makeDigest = typeof opts.digest === 'function' ? opts.digest : null;
  const takeLegacy = typeof opts.legacy === 'function' ? opts.legacy : null;
  const probeLegacy = typeof opts.legacyInfo === 'function' ? opts.legacyInfo : null;
  const jars = Object.create(null);
  const netLog = Object.create(null);
  const streams = Object.create(null);   /* streamId -> { id, abort } */
  let streamSeq = 0;

  function jarFor(id) {
    if (!jars[id]) jars[id] = Net.createJar(host.cookieRead(id));
    return jars[id];
  }
  function persistJar(id) {
    const j = jars[id];
    if (j) host.cookieWrite(id, j.dump());
  }
  function allowlistFor(id) {
    const p = host.find(id);
    const perm = p && (p.permissions || []).filter(x => x.scope === 'net.request')[0];
    return (perm && perm.hosts) || [];
  }
  function throttle(id) {
    const now = Date.now();
    const arr = (netLog[id] = (netLog[id] || []).filter(function (t) { return now - t < NET_WINDOW_MS; }));
    if (arr.length >= NET_WINDOW_MAX) return '插件请求过于频繁（' + Math.round(NET_WINDOW_MS / 1000) + ' 秒内最多 ' + NET_WINDOW_MAX + ' 次），稍后再试';
    arr.push(now);
    return '';
  }

  /* 立刻停掉某个插件手上所有在跑的流（撤销允许 / 停用 / 卸载都要走这里）。
   * 只清账、只 abort —— net.end 由流自己的收尾事件发，这里再发一次就成双了。 */
  function abortAll(id) {
    Object.keys(streams).forEach(function (sid) {
      if (streams[sid].id !== id) return;
      const s = streams[sid];
      delete streams[sid];
      try { s.abort(); } catch (e) {}
    });
  }
  function countStreams(id) {
    return Object.keys(streams).filter(function (sid) { return streams[sid].id === id; }).length;
  }
  /* 这几个由宿主自己管，插件改不了：Cookie 走宿主代管的罐子，Host 由 URL 推出来 */
  const HEADER_BLOCK = ['cookie', 'host', 'content-length', 'connection', 'upgrade'];
  function cleanHeaders(src) {
    const out = {};
    Object.keys(src || {}).forEach(function (k) {
      if (HEADER_BLOCK.indexOf(String(k).toLowerCase()) === -1) out[k] = String(src[k]).slice(0, 300);
    });
    return out;
  }

  /* 汇总快照：只从"本机已采集 + 未被排除"的池子里算，且不受界面筛选影响 */
  function summaryFor(store, mode) {
    const m = MODES[mode] ? MODES[mode] : 'all';
    const rows = store.matches({ mode: m });
    if (!rows.length) return { ok: false, error: '本机在这个模式下还没有对局数据' };
    const s = Analysis.summarize(rows);
    const st = Analysis.streak(rows);
    const w = Analysis.windowStats(rows);
    /* rows 按 start_time 倒序：最后一条最早、第一条最晚 */
    const asc = rows.slice().sort(function (a, b) { return (a.start_time || 0) - (b.start_time || 0); });
    const daySet = {};
    asc.forEach(function (r) { const d = String(r.dt_event_time || '').slice(0, 10); if (d) daySet[d] = 1; });
    return {
      ok: true,
      mode: m,
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
        /* KPM 给池化值（累计击杀 ÷ 累计分钟），不是逐场比值求平均 —— 和界面那一列同一把尺 */
        killsPerMinute: s.killPerMin,
        occupyTotal: s.occupy, occupyPerMatch: s.avgOccupy,
        rescueTotal: s.rescue, rescuePerMatch: s.avgRescue,
        bestMatchKills: Math.max.apply(null, rows.map(function (r) { return r.kill || 0; })),
        totalSeconds: Math.round(rows.reduce(function (a, r) { return a + (r.game_time || 0); }, 0)),
        quitRate: s.leaveRate, totalHours: s.totalHours, avgDurationMin: s.avgDurationMin
      },
      streak: { bestWin: st.bestWin, worstLose: st.worstLose, currentStreak: st.currentStreak, currentWin: st.currentWin },
      windows: {
        last10: w.last10 ? { n: w.last10.n, winRate: w.last10.winRate } : null,
        last20: w.last20 ? { n: w.last20.n, winRate: w.last20.winRate } : null,
        last30: w.last30 ? { n: w.last30.n, winRate: w.last30.winRate } : null
      },
      avgRating: Analysis.avgRating(store, rows)
    };
  }

  async function dispatch(id, method, args) {
    const a = args || {};
    const p = host.find(id);
    if (!p) return { ok: false, error: '插件不存在：' + id };
    if (!p.enabled) return { ok: false, error: '插件未启用' };
    const v = host.verifyFiles(id);
    if (!v.ok) return { ok: false, error: '插件文件校验未通过，已拒绝调用：' + v.message };

    switch (method) {
      case 'host.info':
        return {
          ok: true,
          hostVersion: Plg.HOST_VERSION,
          plugin: { id: p.id, name: p.name, version: p.version },
          scopes: (p.permissions || []).map(function (x) { return x.scope; }),
          /* 插件页要靠这个如实显示"宿主还没确认"，它自己改不了这个值 */
          consentOk: !!host.consentOk(id),
          needsConsent: !!host.needsConsent(id),
          account: getStore && getStore() ? { slot: String((getStore().state.meta || {}).slot || ''), synced: !!((getStore().state.meta || {}).last_sync || 0) } : null
        };

      case 'summary.get': {
        if (!host.canScope(id, 'read.summary')) return { ok: false, error: '插件没有申请「读取汇总统计」权限' };
        const store = getStore && getStore();
        if (!store) return { ok: false, error: '未选择账号，也没有本机数据' };
        try { return summaryFor(store, a.mode); }
        catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      }

      case 'kv.get': {
        if (!host.hasStorage(id)) return { ok: false, error: '插件没有申请「保存自己的配置」权限' };
        const all = host.kvRead(id) || {};
        if (a.key === undefined) return { ok: true, value: all };
        const hit = Object.prototype.hasOwnProperty.call(all, a.key) ? all[a.key] : null;
        return { ok: true, value: hit };
      }

      case 'kv.set': {
        if (!host.hasStorage(id)) return { ok: false, error: '插件没有申请「保存自己的配置」权限' };
        if (typeof a.key !== 'string' || !a.key || a.key.length > 60) return { ok: false, error: 'kv 的 key 必须是 1~60 字的字符串' };
        if (/^__/.test(a.key)) return { ok: false, error: '这个前缀是宿主保留的' };
        let size = 0;
        try { size = JSON.stringify(a.value).length; } catch (e) { return { ok: false, error: '值无法序列化' }; }
        if (size > 64 * 1024) return { ok: false, error: '单个插件的配置不能超过 64 KB' };
        const cur = host.kvRead(id) || {};
        if (a.value === null || a.value === undefined) delete cur[a.key]; else cur[a.key] = a.value;
        return host.kvWrite(id, cur);
      }

      case 'net.request': {
        if (!host.canScope(id, 'net.request')) return { ok: false, error: '插件没有申请「向外部发送请求」权限' };
        /* ★ 闸门在宿主：插件自己页面里那个确认框说什么都没用，没在这份登记表上确认过就一个字节也不发。
         *   放在限频之前判，被闸门挡掉的调用不该吃掉插件的请求额度。 */
        if (!host.consentOk(id)) return { ok: false, error: '还没在宿主这里逐字确认，本软件不会替你向外发送任何数据' };
        const limit = throttle(id);
        if (limit) return { ok: false, error: limit };
        const allow = allowlistFor(id);
        if (!allow.length) return { ok: false, error: '这个插件没有获批任何域名' };
        let body = null;
        if (a.body !== undefined && a.body !== null) {
          body = typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
          if (body.length > 64 * 1024) return { ok: false, error: '请求体超过 64 KB' };
        }
        const headers = cleanHeaders(a.headers);
        const r = await Net.request({
          url: String(a.url || ''), method: a.method ? String(a.method).toUpperCase() : undefined,
          headers: headers, body: body, allowlist: allow, jar: jarFor(id),
          timeout: Math.min(Number(a.timeout) || Net.DEFAULT_TIMEOUT, 60000)
        });
        persistJar(id);
        if (!r.ok && r.error) return { ok: false, error: r.error, status: r.status };
        /* 明文不外传：只把状态与解析结果给插件 */
        return { ok: r.ok, status: r.status, json: r.json, text: r.text, contentType: r.contentType };
      }

      case 'net.clearSession': {
        if (!host.canScope(id, 'net.request')) return { ok: false, error: '插件没有申请「向外部发送请求」权限' };
        const j = jarFor(id);
        j.clear();
        host.cookieWrite(id, {});
        return { ok: true };
      }

      /* ---- 流式出口：闸门、域名、额度与一次性请求走的是同一套判定，一条都不许少 ---- */
      case 'net.stream': {
        if (!host.canScope(id, 'net.request')) return { ok: false, error: '插件没有申请「向外部发送请求」权限' };
        if (!host.consentOk(id)) return { ok: false, error: '还没在宿主这里逐字确认，本软件不会替你向外发送任何数据' };
        if (countStreams(id) >= MAX_STREAMS_PER_PLUGIN) {
          return { ok: false, error: '上一条请求还没结束，先等它完成或点「停止」' };
        }
        const limit = throttle(id);
        if (limit) return { ok: false, error: limit };
        const allow = allowlistFor(id);
        if (!allow.length) return { ok: false, error: '这个插件没有获批任何域名' };
        let body = null;
        if (a.body !== undefined && a.body !== null) {
          body = typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
          if (body.length > STREAM_BODY_MAX) {
            return { ok: false, error: '请求体超过 ' + Math.round(STREAM_BODY_MAX / 1024) + ' KB' };
          }
        }
        const sid = 's' + (++streamSeq);
        let pending = '', timer = null;
        function flush() {
          timer = null;
          if (!pending) return;
          emitTo(id, 'net.data', { streamId: sid, text: pending });
          pending = '';
        }
        const handle = Net.stream({
          url: String(a.url || ''), method: a.method ? String(a.method).toUpperCase() : undefined,
          headers: cleanHeaders(a.headers), body: body, allowlist: allow, jar: jarFor(id),
          onPersist: function () { persistJar(id); },
          onEvent: function (ev) {
            if (ev.type === 'open') {
              if (timer) { clearTimeout(timer); flush(); }
              emitTo(id, 'net.open', { streamId: sid, status: ev.open.status, contentType: ev.open.contentType });
              return;
            }
            if (ev.type === 'data') {
              /* SSE 一片一秒能来几十次，不合并就会把渲染进程与 iframe 的消息通道淹掉 */
              pending += ev.text;
              if (!timer) timer = setTimeout(flush, STREAM_MERGE_MS);
              return;
            }
            if (timer) { clearTimeout(timer); flush(); }   /* ★ 尾巴先冲出去，再报结束 */
            delete streams[sid];
            emitTo(id, 'net.end', Object.assign({ streamId: sid }, ev.end));
          }
        });
        if (!handle.ok) return { ok: false, error: handle.error };
        streams[sid] = { id: id, abort: handle.abort };
        return { ok: true, streamId: sid };
      }

      case 'net.abort': {
        if (!host.canScope(id, 'net.request')) return { ok: false, error: '插件没有申请「向外部发送请求」权限' };
        const sid = String(a.streamId || '');
        const s = streams[sid];
        if (!s || s.id !== id) return { ok: false, error: '没有这条请求，或者它已经结束了' };
        const abort = s.abort;
        delete streams[sid];
        try { abort(); } catch (e) {}
        return { ok: true };
      }

      /* ---- 密钥层：与 kv 同一个权限，但不是同一份文件 ---- */
      case 'secret.get': {
        if (!host.hasStorage(id)) return { ok: false, error: '插件没有申请「保存自己的配置」权限' };
        const all = host.secretRead(id) || {};
        /* 不带 key 时只回键名。这一条就是这个层存在的理由：
         * 界面想"先读一遍自己的配置"不该顺手把密钥原文捞出去。 */
        if (a.key === undefined) return { ok: true, keys: Object.keys(all) };
        const hit = Object.prototype.hasOwnProperty.call(all, a.key) ? all[a.key] : null;
        return { ok: true, value: hit, has: hit !== null };
      }

      case 'secret.set': {
        if (!host.hasStorage(id)) return { ok: false, error: '插件没有申请「保存自己的配置」权限' };
        if (typeof a.key !== 'string' || !a.key || a.key.length > 60) return { ok: false, error: '密钥的 key 必须是 1~60 字的字符串' };
        if (/^__/.test(a.key)) return { ok: false, error: '这个前缀是宿主保留的' };
        if (a.value !== null && a.value !== undefined && typeof a.value !== 'string') {
          return { ok: false, error: '密钥只能是字符串或 null（删除）' };
        }
        if (typeof a.value === 'string' && a.value.length > 8 * 1024) return { ok: false, error: '单条密钥不超过 8 KB' };
        const cur = host.secretRead(id) || {};
        if (a.value === null || a.value === undefined) delete cur[a.key]; else cur[a.key] = a.value;
        return host.secretWrite(id, cur);
      }

      /* ---- 摘要与旧数据：都由宿主算/交，插件拿到的永远是成品文本 ---- */
      case 'ai.digest': {
        if (!host.canScope(id, 'read.digest')) return { ok: false, error: '插件没有申请「读取去敏分析摘要」权限' };
        if (!makeDigest) return { ok: false, error: '宿主没有提供摘要通道' };
        try {
          const r = makeDigest(id, a);
          return r && typeof r.then === 'function' ? await r : r;
        } catch (e) { return { ok: false, error: '生成摘要失败：' + String((e && e.message) || e) }; }
      }

      case 'legacy.check': {
        if (!host.canScope(id, 'read.legacy')) return { ok: false, error: '插件没有申请「搬入旧版的本机记录」权限' };
        if (!probeLegacy) return { ok: false, error: '宿主没有提供旧数据通道' };
        try { return probeLegacy(id); }
        catch (e) { return { ok: false, error: '读旧记录状态失败：' + String((e && e.message) || e) }; }
      }

      case 'legacy.ai': {
        if (!host.canScope(id, 'read.legacy')) return { ok: false, error: '插件没有申请「搬入旧版的本机记录」权限' };
        if (!takeLegacy) return { ok: false, error: '宿主没有提供旧数据通道' };
        try {
          const r = takeLegacy(id);
          return r && typeof r.then === 'function' ? await r : r;
        } catch (e) { return { ok: false, error: '搬移失败：' + String((e && e.message) || e) }; }
      }

      /* ---- 待办：宿主只记一笔，取走必须有一个开着页面的人 ---- */
      case 'trigger.arm': {
        if (!host.canScope(id, 'view')) return { ok: false, error: '插件没有页面，谈不上待办' };
        return host.armTrigger(id, !!a.on);
      }

      case 'trigger.take': {
        if (!host.canScope(id, 'view')) return { ok: false, error: '插件没有页面，谈不上待办' };
        const rec = host.takeTrigger(id);
        return { ok: true, trigger: rec || null };
      }

      default:
        return { ok: false, error: '宿主没有这个方法：' + method };
    }
  }

  return { dispatch: dispatch, summaryFor: summaryFor, allowlistFor: allowlistFor, abortAll: abortAll };
}

module.exports = { createPluginApi: createPluginApi, MODES: MODES };
