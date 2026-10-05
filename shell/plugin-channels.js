/* plugin-channels.js — 宿主交给插件的两条数据通道（主进程专用，Node 模块）
 *
 * 为什么单独成文件而不是写在 shell/main.js 里：main.js 一 require 就会启动 Electron，
 * 「摘要怎么生成」「旧数据怎么归档」这两件事必须有能被测试真跑一遍的地方。
 * 业务算法一律在 core/ 里，这里只做取数、发号牌、改名字这类编排。
 *
 *   digest 通道：把本机战绩算成一份**去敏摘要文本**交给插件。
 *     ★ 逐场明细、玩家名单、openid 都留在宿主 —— 插件只拿到成品文字。
 *     ★ 单场点评要能选中某一场，但稳定的 room_id 不出去：宿主发一张只在本次进程里有效的号牌。
 *
 *   legacy 通道：旧版本机里存的 AI 配置与历史结果（那一版还没搬进插件体系）。
 *     ★ 一次性：交出去的同时把本机那份归档（改名留底，绝不删），第二次来就只有"没有了"。
 *     ★ 顺序不能反 —— 先落留底、再摘 state，中间崩溃最多是重复，反过来就是丢。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const AiDigest = require('../core/aiDigest');
const Maps = require('../core/maps');
const Analysis = require('../core/analysis');

const DIGEST_HANDLE_MAX = 80;
const DIGEST_ROWS_MAX = 40;
const DIGEST_MODES = ['all', 'swtwr', 'other', 'commander'];
const HISTORY_MAX = 50;
const DAYS_MAX = 365;

/* ---------------- 摘要通道 ---------------- */
function createDigestChannel(opts) {
  const getStore = opts.getStore;
  const handles = new Map();      /* handle -> room_id */
  const back = new Map();         /* room_id -> handle（同一场复用一张，别发一堆） */

  function store() { return getStore ? getStore() : null; }

  function handleForRoom(rid) {
    let h = back.get(rid);
    if (h) return h;
    h = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    back.set(rid, h);
    handles.set(h, rid);
    while (handles.size > DIGEST_HANDLE_MAX) {
      const oldest = handles.keys().next().value;
      const dead = handles.get(oldest);
      handles.delete(oldest);
      back.delete(dead);
    }
    return h;
  }

  function list() {
    const s = store();
    if (!s) return { ok: false, error: '未选择账号，也没有本机数据' };
    let rows = [];
    try { rows = s.matches({ mode: 'all' }); }
    catch (e) { return { ok: false, error: '读场次清单失败：' + String((e && e.message) || e) }; }
    return {
      ok: true, total: rows.length,
      /* 只给"够选人"的字段：日期、地图名、模式与胜负的标志位。文案由页面自己拼。 */
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

  function run(id, args) {
    const s = store();
    if (!s) return { ok: false, error: '未选择账号，也没有本机数据' };
    const a = args || {};
    if (a.list) return list();
    const scope = a.scope === 'match' ? 'match' : 'global';
    const filters = {};
    if (DIGEST_MODES.indexOf(a.mode) !== -1) filters.mode = a.mode;
    /* 只收「近 N 天」，换算成绝对截止点由宿主做 —— 时间戳本身不必经插件的手 */
    const days = Math.floor(Number(a.days) || 0);
    if (days > 0) filters.since = Math.floor(Date.now() / 1000) - Math.min(days, DAYS_MAX) * 86400;

    let roomId = '';
    if (scope === 'match') {
      roomId = handles.get(String(a.handle || '')) || '';
      if (!roomId) return { ok: false, error: '场次号牌已失效，请重新选一次场次（号牌只在本次运行中有效）' };
    }
    let d;
    try {
      d = scope === 'match' ? AiDigest.buildMatchDigest(s, roomId)
                            : AiDigest.buildGlobalDigest(s, filters);
    } catch (e) {
      return { ok: false, error: '生成摘要失败：' + String((e && e.message) || e) };
    }
    if (!d || d.error) return { ok: false, error: (d && d.error) || '无法生成摘要' };
    return {
      ok: true, scope: scope, handle: scope === 'match' ? handleForRoom(roomId) : '',
      text: d.text, bytes: d.bytes, estTokens: d.estTokens,
      aliases: d.aliases || [], dropped: d.dropped || null,
      slot: String((s.state.meta || {}).slot || ''),
      weights: Analysis.weightsText(Analysis.weights(s))
    };
  }

  return { run: run, list: list, handleCount: function () { return handles.size; } };
}

/* ---------------- 旧数据通道 ---------------- */
function createLegacyChannel(opts) {
  const getStore = opts.getStore;
  const dirOf = opts.userDataDir;
  function cfgFile() { return path.join(dirOf(), 'ai-config.json'); }
  function reportsFile() { return path.join(dirOf(), 'ai-reports-legacy.json'); }
  function store() { return getStore ? getStore() : null; }

  /* 归档位不能撞名：撞了就往后加序号，绝不覆盖上一次迁移留下的证据 */
  function freeArchivePath(base) {
    let p = base, i = 1;
    while (fs.existsSync(p)) { p = base + '.' + i; i++; }
    return p;
  }
  function readCfg() {
    try {
      const j = JSON.parse(fs.readFileSync(cfgFile(), 'utf8'));
      return j && typeof j === 'object' ? j : null;
    } catch (e) { return null; }
  }
  function reportList() {
    const s = store();
    const all = (s && s.state && s.state.aiReports) || {};
    return Object.keys(all).map(function (k) { return all[k]; })
      .sort(function (a, b) { return (b.at || 0) - (a.at || 0); }).slice(0, HISTORY_MAX);
  }

  /* 只回答「有没有、多少」，一个字节的内容都不给：按钮该不该出现，用得上这个就够 */
  function check() {
    let hasConfig = false, archived = false;
    try {
      hasConfig = fs.existsSync(cfgFile());
      archived = fs.existsSync(reportsFile());
    } catch (e) { /* 读不到就当没有 */ }
    const reports = reportList().length;
    return { ok: true, hasConfig: hasConfig, reports: reports, archived: archived,
      hasAnything: !!(hasConfig || reports) };
  }

  async function take(id) {
    const out = { ok: true, config: null, reports: [], archived: [], slot: '' };
    const cfg = readCfg();
    const list = reportList();
    if (!cfg && !list.length) return { ok: false, error: '本机没有可搬的旧记录（已经搬过，或从来没用过）' };

    if (cfg) {
      const from = cfgFile();
      let to = null;
      try {
        to = freeArchivePath(from + '.migrated');
        fs.renameSync(from, to);
      } catch (e) {
        return { ok: false, error: '旧配置归档失败，未交出任何数据：' + String((e && e.message) || e) };
      }
      out.archived.push('ai-config.json → ' + path.basename(to));
      out.config = {
        presetKey: String(cfg.presetKey || ''), baseUrl: String(cfg.baseUrl || ''),
        model: String(cfg.model || ''), apiKey: String(cfg.apiKey || ''),
        autoDaily: !!cfg.autoDaily, hadConsent: !!cfg.consent
      };
    }

    if (!list.length) return out;
    const s = store();
    out.slot = String(((s && s.state && s.state.meta) || {}).slot || '');
    try {
      fs.writeFileSync(reportsFile(), JSON.stringify({
        migratedAt: Date.now(), slot: out.slot, fromPlugin: String(id || ''), reports: list
      }, null, 1), 'utf8');
      s.state.aiReports = {};
      await s.save();
    } catch (e) {
      return { ok: false, error: '历史归档失败，未交出任何数据：' + String((e && e.message) || e) };
    }
    out.reports = list;
    out.archived.push('历史结果 → ' + path.basename(reportsFile()));
    return out;
  }

  return { check: check, take: take };
}

module.exports = {
  createDigestChannel: createDigestChannel,
  createLegacyChannel: createLegacyChannel,
  DIGEST_HANDLE_MAX: DIGEST_HANDLE_MAX,
  DIGEST_ROWS_MAX: DIGEST_ROWS_MAX,
  HISTORY_MAX: HISTORY_MAX
};
