/* normalize.js — 官方原始字段 → 内部统一结构（纯 JS，UMD）
 * 不依赖任何平台 API，桌面端与移动端共用
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./maps'));
  } else {
    root.DFCore = root.DFCore || {};
    root.DFCore.Normalize = factory(root.DFCore.Maps);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Maps) {
  'use strict';

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  /* 单场战局（GetBattleList 的 tdms 元素） */
  function match(row, openid, syncedAt) {
    var mapId = num(row.mapId);
    var kill = num(row.killNum), death = num(row.death), assist = num(row.assist);
    var gt = num(row.gameTime), score = num(row.score), rule = num(row.gameRule);
    return {
      room_id: String(row.roomId || ''),
      start_time: num(row.startTime),
      dt_event_time: row.dtEventTime || '',
      map_id: mapId,
      map_name: Maps.nameOf(mapId),
      game_rule: rule,
      is_swtwr: Maps.isSWWR(mapId, rule) ? 1 : 0,
      // 指挥官只认用户手动标记，不在采集时判定（store.js prune 会物化真实值）
      is_commander: 0,
      // 「比赛对局」同样只认人工标记 —— 官方字段里没有这个信息（真库量过：能分开的只有当晚轮到的地图 id），
      // 所以采集时一律 0，绝不由机器预填。
      is_competition: 0,
      is_winner: num(row.isWinner) === 1 ? 1 : 0,
      game_result: num(row.gameResult),
      is_leave: num(row.isLeave) === 1 ? 1 : 0,
      kill: kill, death: death, assist: assist, score: score,
      occupy: num(row.occupy),
      rescue: num(row.rescue),
      game_time: gt,
      team_id: num(row.teamId),
      color: num(row.color),
      is_ranked: num(row.isRankedMatch) === 1 ? 1 : 0,
      rank_score: num(row.rankMatchScore),
      force_type: num(row.deployArmedForceType),
      kd: death > 0 ? round(kill / death, 3) : kill,
      kda: death > 0 ? round((kill + assist) / death, 3) : (kill + assist),
      score_per_min: gt > 0 ? Math.round(score / (gt / 60)) : 0,
      kill_per_min: gt > 0 ? round(kill / (gt / 60), 2) : 0,
      synced_at: syncedAt || Date.now(),
      owner_openid: String(openid || '')
    };
  }

  /* 全场名单（GetBattleDetail 的 tdm_players 元素） */
  function player(p) {
    return {
      name: p.name || '',
      vopenid: String(p.vopenid || p.playerId || ''),
      kill: num(p.killNum), death: num(p.death), assist: num(p.assist),
      score: num(p.score), occupy: num(p.occupy), rescue: num(p.rescue),
      color: num(p.color), team_id: num(p.teamId),
      is_winner: num(p.isWinner) === 1 ? 1 : 0,
      is_leave: num(p.isLeave) === 1 ? 1 : 0,
      game_time: num(p.gameTime),
      force_type: num(p.deployArmedForceType)
    };
  }

  function round(v, n) {
    var f = Math.pow(10, n);
    return Math.round(v * f) / f;
  }

  /* 玩家资料（GetRoleInfo） */
  function role(info) {
    info = info || {};
    return {
      openid: String(info.openid || ''),
      area: num(info.area) || 36,
      name: info.name || '',
      level: num(info.level),
      tdm_level: num(info.tdmLevel),
      tdm_exp: num(info.tdmExp)
    };
  }

  return { match: match, player: player, role: role, num: num, round: round };
});
