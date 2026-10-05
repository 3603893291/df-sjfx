/* maps.js — 地图/模式映射（纯 JS，UMD：Node 与浏览器通用）
 * 数据来源：WeGame 官方地图配置表（抓包取得）
 * swtwrIds 胜者为王地图 ｜ commanderIds 指挥官模式 ｜ tdmIds 全面战场全部地图
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.DFCore = root.DFCore || {}; root.DFCore.Maps = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var MAP_NAME = {
    "33": "烬区-攻防",
    "34": "烬区-占领",
    "569": "烬区-箭羽争锋",
    "903": "烬区-团队死斗",
    "557": "烬区-游刃有余",
    "119": "烬区-钢铁洪流",
    "113": "贯穿-攻防",
    "114": "贯穿-占领",
    "905": "贯穿-团队死斗",
    "54": "攀升-攻防",
    "103": "攀升-占领",
    "568": "攀升-箭羽争锋",
    "901": "攀升-团队死斗",
    "556": "攀升-游刃有余",
    "117": "攀升-钢铁洪流",
    "75": "临界点-攻防",
    "210": "临界点-占领",
    "570": "临界点-箭羽争锋",
    "906": "临界点-团队死斗",
    "558": "临界点-游刃有余",
    "107": "堑壕战-攻防",
    "108": "堑壕战-占领",
    "567": "堑壕战-箭羽争锋",
    "902": "堑壕战-团队死斗",
    "555": "堑壕战-游刃有余",
    "227": "堑壕战-钢铁洪流",
    "111": "断轨-攻防",
    "112": "断轨-占领",
    "565": "断轨-箭羽争锋",
    "904": "断轨-团队死斗",
    "553": "断轨-游刃有余",
    "526": "断轨-钢铁洪流",
    "121": "刀锋-攻防",
    "122": "刀锋-占领",
    "566": "刀锋-箭羽争锋",
    "514": "刀锋-团队死斗",
    "554": "刀锋-游刃有余",
    "302": "风暴眼-攻防",
    "303": "风暴眼-占领",
    "907": "风暴眼-团队死斗",
    "151": "断层-攻防",
    "152": "断层-占领",
    "950": "断层-箭羽争锋",
    "946": "断层-团队死斗",
    "951": "断层-游刃有余",
    "138": "金字塔-攻防",
    "139": "金字塔-占领",
    "948": "金字塔-箭羽争锋",
    "947": "金字塔-团队死斗",
    "949": "金字塔-游刃有余",
    "145": "余震-攻防",
    "146": "余震-占领",
    "964": "余震-团队死斗",
    "311": "乌姆斯运河-攻防",
    "312": "乌姆斯运河-占领",
    "885": "乌姆斯运河-团队死斗",
    "171": "克劳狄斗兽场-攻防",
    "172": "克劳狄斗兽场-占领",
    "982": "克劳狄斗兽场-团队死斗",
    "2858": "克劳狄斗兽场-钢铁洪流",
    "609": "金字塔-胜者为王",
    "610": "余震-胜者为王",
    "601": "攀升-胜者为王",
    "602": "烬区-胜者为王",
    "603": "临界点-胜者为王",
    "604": "贯穿-胜者为王",
    "605": "堑壕战-胜者为王",
    "606": "断轨-胜者为王",
    "607": "刀锋-胜者为王",
    "608": "风暴眼-胜者为王",
    "612": "乌姆斯运河-胜者为王",
    "613": "攻防-指挥官模式-克劳狄斗兽场"
  };
  var SWWR_IDS = [601, 602, 603, 604, 605, 606, 607, 608, 609, 610, 612];
  var COMMANDER_IDS = [613];
  var TDM_IDS = [33, 34, 54, 75, 103, 107, 108, 111, 112, 113, 114, 117, 119, 121, 122, 138, 139, 145, 146, 151, 152, 171, 172, 210, 227, 302, 303, 311, 312, 514, 526, 553, 554, 555, 556, 557, 558, 565, 566, 567, 568, 569, 570, 601, 602, 603, 604, 605, 606, 607, 608, 609, 610, 612, 613, 885, 901, 902, 903, 904, 905, 906, 907, 946, 947, 948, 949, 950, 951, 964, 982, 2858];
  /* ★ 官方接口只回 mapId，地图名只能靠这张抓包表 —— 表里没有就是不知道，不许猜：
   *   同一个 game_rule 只能说明「模式族相同」（例：959 与 902 堑壕战-团队死斗都是 rule 10），
   *   推不出这张图叫什么。兜底串要一眼看得出是缺映射，不能伪装成正常地名。 */
  /* ---- 本机学名表：官方公开配置表（见 mapConfig.js）学到、且内置表里没有的 id ----
   * 内置表一个字都不改：它是抓包实证，官方配置表若哪天把某个地名改了，本机仍旧显示实证值，
   * 免得改名这件事变成"看不见的漂移"。所以这张表只补空位、且只在内置表查不到时才被查。
   * 模块级单例（一个 JS 上下文一份）：库里的 state.map_names 由载入方在 load 后 push 进来。 */
  var EXTRA = {};         // id(字符串) -> 地名
  var EXTRA_SWWR = {};    // id(数字) -> 1，地名里带「胜者为王」的：新图不用改代码也不会被算成常规场
  /* ★ 使用者自己改的地名（2026-09-29 他要求「在地图名那里可以编辑地图名…本机字典也可以查看或编辑」）。
   *   这一层**优先于内置表**：内置那 72 条仍是抓包实证、一个字没动，但"这台机器上我叫它什么"
   *   归使用者 —— 与"官方改了名本机不许跟着漂"是两件事，那条靠"内置优先于学到的"来保证。
   *   刻意与 EXTRA 分开两份：更新地图名（applyExtra）永远不许把使用者手改的名字盖掉。 */
  var USER = {};          // id(字符串) -> 使用者起的名字
  var ID_OK = /^\d{1,8}$/;
  var BAD = /[\x00-\x1F\x7F<>]/;
  var NAME_MAX = 40;

  /* 名字本身的规矩（学的与用户改的同一把尺）：不合规就整条不要，不做截断、不洗控制字符 */
  function cleanName(v) {
    if (typeof v !== 'string') return null;
    v = v.trim();
    if (!v || v.length > NAME_MAX || BAD.test(v)) return null;
    return v;
  }

  /** 合并一批学名。输入来自磁盘/导入包 —— 那是不可信数据，所以这里自己再验一遍，
   *  不依赖调用方有没有先过 mapConfig 的清洗（清洗口径与那边一致，宁可不学也不存脏名）。
   * @param {object} names id -> 地名
   * @returns {{added:number, ignored:number, total:number}} */
  function applyExtra(names) {
    var added = 0, ignored = 0;
    if (names && typeof names === 'object') {
      Object.keys(names).forEach(function (id) {
        if (!ID_OK.test(id)) { ignored++; return; }
        var v = names[id];
        if (typeof v !== 'string') { ignored++; return; }
        v = v.trim();
        if (!v || v.length > 40 || BAD.test(v)) { ignored++; return; }
        if (Object.prototype.hasOwnProperty.call(MAP_NAME, id)) return;   /* 内置优先，不覆盖 */
        if (Object.prototype.hasOwnProperty.call(EXTRA, id)) return;      /* 先来的赢：两次同步不许来回改名 */
        if (Object.prototype.hasOwnProperty.call(USER, id)) return;       /* 使用者改过的，学的也不许盖回去 */
        EXTRA[id] = v;
        if (v.indexOf('胜者为王') !== -1) EXTRA_SWWR[Number(id)] = 1;
        added++;
      });
    }
    return { added: added, ignored: ignored, total: Object.keys(EXTRA).length };
  }

  /** 合并一批"使用者自己起的名字"。清洗口径与 applyExtra 一致（那是不可信输入：来自磁盘 / 导入包）。
   *  与 EXTRA 唯一的差别就是这一层**可以**压过内置表，且值为空串就是撤销这一条。
   *  ★ 这一层永远不参与模式判定：名字是给用户看的，图算不算「胜者为王」只认官方 id 与 game_rule ——
   *    否则一个人把 611 改成「胜者为王-测试」就能把自己库里的统计口径改掉。
   * @returns {{applied:number, cleared:number, ignored:number, total:number}} */
  function applyUser(names) {
    var applied = 0, cleared = 0, ignored = 0;
    if (names && typeof names === 'object') {
      Object.keys(names).forEach(function (id) {
        if (!ID_OK.test(id)) { ignored++; return; }
        var v = names[id];
        if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) {
          if (Object.prototype.hasOwnProperty.call(USER, id)) { delete USER[id]; cleared++; }
          return;
        }
        if (typeof v !== 'string') { ignored++; return; }
        v = v.trim();
        if (!v || v.length > NAME_MAX || BAD.test(v)) { ignored++; return; }
        if (USER[id] === v) return;                       /* 一字未改不算应用，界面上别说"改了 N 条" */
        USER[id] = v;
        applied++;
      });
    }
    return { applied: applied, cleared: cleared, ignored: ignored, total: Object.keys(USER).length };
  }
  function setUserName(id, name) {
    if (!ID_OK.test(String(id == null ? '' : id))) return { applied: 0, ignored: 1, total: Object.keys(USER).length };
    var o = {}; o[String(id)] = name;
    return applyUser(o);
  }
  function clearUserName(id) { return setUserName(id, ''); }
  function userNames() { return Object.assign({}, USER); }
  /** 撤销这一条之后，这张图本来该显示什么名字（内置 / 学到的 / 兜底）—— 界面念完这句才知道"还原"还原到哪儿 */
  function nameWithoutUser(id) {
    var k = String(id);
    return MAP_NAME[k] || EXTRA[k] || ('未知地图 · id ' + id);
  }
  /** 字典一览（设置页那一块就看这个）：内置 / 学到的 / 我改过的 三层各归各，不合并成一坨 */
  function nameDict() {
    function pack(src, map) {
      return Object.keys(map).map(function (id) {
        return { id: id, name: map[id], source: src,
          base: src === 'user' ? nameWithoutUser(id) : '' };
      }).sort(function (a, b) { return Number(a.id) - Number(b.id); });
    }
    return { builtin: pack('builtin', MAP_NAME), learned: pack('learned', EXTRA), user: pack('user', USER) };
  }
  function extraNames() { return Object.assign({}, EXTRA); }
  function clearExtra() { EXTRA = {}; EXTRA_SWWR = {}; }
  /** 只清使用者那一层（预览层与测试每次起进程要回到干净起点用） */
  function clearUser() { USER = {}; }
  /** 这个名字是哪来的：'user' 使用者改的 / 'builtin' 抓包实证 / 'learned' 本机学的 / '' 不知道 */
  function nameSource(id) {
    var k = String(id);
    if (Object.prototype.hasOwnProperty.call(USER, k)) return 'user';
    if (Object.prototype.hasOwnProperty.call(MAP_NAME, k)) return 'builtin';
    return Object.prototype.hasOwnProperty.call(EXTRA, k) ? 'learned' : '';
  }
  function mapNameCounts() {
    return { builtin: Object.keys(MAP_NAME).length, learned: Object.keys(EXTRA).length,
      user: Object.keys(USER).length };
  }

  function isKnownMap(id) {
    var k = String(id);
    return Object.prototype.hasOwnProperty.call(USER, k) ||
      Object.prototype.hasOwnProperty.call(MAP_NAME, k) ||
      Object.prototype.hasOwnProperty.call(EXTRA, k);
  }
  function nameOf(id) {
    var k = String(id);
    /* ★ 使用者在这一台机器上起的名字优先；其余仍是"内置实证 > 本机学到 > 兜底" */
    return USER[k] || MAP_NAME[k] || EXTRA[k] || ('未知地图 · id ' + id);
  }
  function isSWWR(id, gameRule) {
    var n = Number(id);
    return SWWR_IDS.indexOf(n) !== -1 || EXTRA_SWWR[n] === 1 || Number(gameRule) === 13;
  }
  function isCommander(id) { return COMMANDER_IDS.indexOf(Number(id)) !== -1; }

  /* 干员表（deployArmedForceType）—— 来自官方 agentInfo 配置表
   * 首位数字即兵种：1=突击 2=医疗 3=工程 4=侦查 5=指挥官（赤枭系列）
   */
  var AGENT_NAME = {
    10007: '红狼', 10010: '威龙', 10011: '无名', 10012: '疾风',
    20003: '蜂医', 20004: '蛊', 20005: '蝶',
    30008: '牧羊人', 30009: '乌鲁鲁', 30010: '深蓝', 30011: '比特', 30012: '液氮',
    40005: '露娜', 40010: '骇爪', 40011: '银翼', 40012: '回响',
    50001: '赤枭', 50002: '赤枭亲卫', 50003: '赤枭亲卫'
  };
  var FORCE_CLASS = { 1: '突击', 2: '医疗', 3: '工程', 4: '侦查', 5: '指挥官' };

  function forceClassCode(code) { return Math.floor((Number(code) || 0) / 10000); }
  function forceClass(code) {
    var c = forceClassCode(code);
    return c ? (FORCE_CLASS[c] || '其他') : '未知';
  }
  function agentName(code) {
    var c = Number(code) || 0;
    if (!c) return '';
    return AGENT_NAME[c] || ('干员 ' + c);
  }
  function forceName(code) {
    var c = Number(code) || 0;
    if (!c) return '未知';
    return agentName(c) + '（' + forceClass(c) + '）';
  }
  /* 是否指挥官专属单位（赤枭 / 赤枭亲卫） */
  function isCommanderUnit(code) { return forceClassCode(code) === 5; }

  return { mapName: MAP_NAME, swtwrIds: SWWR_IDS, commanderIds: COMMANDER_IDS,
           tdmIds: TDM_IDS, nameOf: nameOf, isKnownMap: isKnownMap,
           isSWWR: isSWWR, isCommander: isCommander,
           applyExtra: applyExtra, extraNames: extraNames, clearExtra: clearExtra,
           nameSource: nameSource, mapNameCounts: mapNameCounts,
           applyUser: applyUser, setUserName: setUserName, clearUserName: clearUserName,
           userNames: userNames, nameWithoutUser: nameWithoutUser, nameDict: nameDict,
           clearUser: clearUser,
           forceName: forceName, forceClass: forceClass, agentName: agentName,
           isCommanderUnit: isCommanderUnit, agentNames: AGENT_NAME };
});
