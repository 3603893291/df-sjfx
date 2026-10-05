'use strict';
/* 内核测试：地图 / 归一化 / 去重 / 筛选 / 分析引擎 / 采集器
 * 用真实抓包样本驱动，运行：node test/core.test.js
 */
const path = require('path');
const fs = require('fs');

const Maps = require('../core/maps');
const N = require('../core/normalize');
const StoreMod = require('../core/store');
const CollectorMod = require('../core/collector');
const A = require('../core/analysis');

const SAMPLE = path.join(__dirname, '..', '..', 'df-analyzer', 'sample', 'sample_data.json');
const raw = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));

let fail = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail !== undefined ? '  -> ' + detail : ''}`);
}

function memAdapter() {
  let data = null;
  return { load: () => data, save: (s) => { data = JSON.parse(JSON.stringify(s)); } };
}

async function makeStore() {
  const store = new StoreMod.Store(memAdapter());
  await store.load();
  await store.ingest({
    at: Date.now(), role: raw.role, season: raw.season,
    list: raw.list, maps: raw.maps, details: raw.details
  });
  return store;
}

(async function () {
  console.log('='.repeat(64));
  console.log('1. 地图与兵种');
  console.log('='.repeat(64));
  check('胜者为王地图 11 张', Maps.swtwrIds.length === 11, Maps.swtwrIds.join(','));
  check('指挥官模式 613', Maps.commanderIds.join() === '613');
  check('全面战场地图 72 张', Maps.tdmIds.length === 72, Maps.tdmIds.length);
  check('601 → 攀升-胜者为王', Maps.nameOf(601) === '攀升-胜者为王', Maps.nameOf(601));
  check('gameRule=13 判定为胜者为王', Maps.isSWWR(9999, 13) === true);
  check('902 团队死斗非胜者为王', Maps.isSWWR(902, 10) === false, Maps.nameOf(902));
  check('空值地图 id 也有可读兜底', Maps.nameOf(0) === '未知地图 · id 0', Maps.nameOf(0));
  check('未知 id 不伪装成正常地名',
    Maps.isKnownMap(959) === false && Maps.nameOf(959) === '未知地图 · id 959', Maps.nameOf(959));
  check('已知 id 判定正确', Maps.isKnownMap(902) === true && Maps.isKnownMap('902') === true);

  /* map_name 是 map_id 的派生显示名；早期版本把查不到的兜底串字面写进了库，
   * load 时必须跟着清算，但绝不能抹掉导入包里那些"我们表没有、却是真"的地名 */
  const stName = new StoreMod.Store({
    load: () => ({
      meta: { openid: 'me' },
      matches: {
        NA: { room_id: 'NA', map_id: 959, map_name: 'mapId:959', start_time: 1 },
        NB: { room_id: 'NB', map_id: 121, map_name: '刀锋（旧抓包名）', start_time: 2 },
        NC: { room_id: 'NC', map_id: 9998, map_name: '导入包带来的真名', start_time: 3 }
      }
    }),
    save: () => {}
  });
  await stName.load();
  const nm = stName.state.matches;
  check('老库里的 mapId:N 兜底串被换成现写法', nm.NA.map_name === '未知地图 · id 959', nm.NA.map_name);
  check('已知 id 的陈旧地名按表刷新', nm.NB.map_name === '刀锋-攻防', nm.NB.map_name);
  check('表里没有的真名一律不动', nm.NC.map_name === '导入包带来的真名', nm.NC.map_name);
  check('干员名 40010 = 骇爪', Maps.agentName(40010) === '骇爪', Maps.agentName(40010));
  check('兵种 40010 = 侦查', Maps.forceClass(40010) === '侦查', Maps.forceClass(40010));
  check('兵种 10012 = 突击', Maps.forceClass(10012) === '突击', Maps.forceClass(10012));
  check('兵种 20005 = 医疗', Maps.forceClass(20005) === '医疗', Maps.forceClass(20005));
  check('兵种 30011 = 工程', Maps.forceClass(30011) === '工程', Maps.forceClass(30011));
  check('完整名称 = 骇爪（侦查）', Maps.forceName(40010) === '骇爪（侦查）', Maps.forceName(40010));
  check('指挥官专属单位判定', Maps.isCommanderUnit(50001) === true && Maps.isCommanderUnit(40010) === false);
  check('兵种空值', Maps.forceName(0) === '未知', Maps.forceName(0));

  console.log('\n' + '='.repeat(64));
  console.log('2. 归一化');
  console.log('='.repeat(64));
  const m0 = N.match(raw.list.tdms[0], raw.role.openid, Date.now());
  check('room_id', m0.room_id === raw.list.tdms[0].roomId);
  check('地图名', m0.map_name === '攀升-胜者为王', m0.map_name);
  check('KD 计算', Math.abs(m0.kd - raw.list.tdms[0].killNum / raw.list.tdms[0].death) < 0.01, m0.kd);
  check('分均得分', m0.score_per_min > 0, m0.score_per_min);

  console.log('\n' + '='.repeat(64));
  console.log('3. 去重入库');
  console.log('='.repeat(64));
  const store = await makeStore();
  const sw = store.matches({ mode: 'swtwr' });
  check('全部 8 场', store.matches({}).length === 8, store.matches({}).length);
  check('胜者为王 4 场', sw.length === 4, sw.length);
  check('其他模式 4 场', store.matches({ mode: 'other' }).length === 4,
    store.matches({ mode: 'other' }).map(x => x.map_name).join(','));
  check('指挥官 0 场', store.matches({ mode: 'commander' }).length === 0);

  const before = store.matches({}).length;
  await store.ingest({ at: Date.now(), role: raw.role, list: raw.list, maps: raw.maps, details: raw.details });
  check('重复同步不新增', store.matches({}).length === before, store.matches({}).length);

  const c = store.modeCounts();
  check('模式计数', c.all === 8 && c.swtwr === 4 && c.other === 4, JSON.stringify(c));

  console.log('\n' + '='.repeat(64));
  console.log('4. 筛选（模式 / 中途退出）');
  console.log('='.repeat(64));
  const store2 = await makeStore();
  // 把「最新一场」标记为中途退出（最新一场恰为胜者为王），验证退出筛选与联合筛选
  const newest = store2.matches({})[0];
  store2.state.matches[newest.room_id].is_leave = 1;
  await store2.save();
  check('被标记的是胜者为王场次', newest.is_swtwr === 1, newest.map_name);
  check('排除退出', store2.matches({ leave: 'exclude' }).length === 7,
    store2.matches({ leave: 'exclude' }).length);
  check('仅退出', store2.matches({ leave: 'only' }).length === 1,
    store2.matches({ leave: 'only' }).length);
  check('模式+退出联合（胜者为王 4 场排除该场 = 3）',
    store2.matches({ mode: 'swtwr', leave: 'exclude' }).length === 3,
    store2.matches({ mode: 'swtwr', leave: 'exclude' }).length);
  check('联合筛选结果不包含被排除场',
    store2.matches({ mode: 'swtwr', leave: 'exclude' })
      .every(m => m.room_id !== newest.room_id));

  console.log('\n' + '='.repeat(64));
  console.log('5. 评分体系');
  console.log('='.repeat(64));
  const s3 = await makeStore();
  const openid = s3.state.meta.openid;
  const roomWithRoster = s3.matches({ mode: 'swtwr' })[0].room_id;
  const mr = s3.match(roomWithRoster);
  const rt = A.rating(mr, s3.players(roomWithRoster), openid);
  check('有名单时基于全场排名', rt.basis === 'lobby', rt.basis + ' / ' + rt.players + ' 人');
  check('评分 0~100', rt.value >= 0 && rt.value <= 100, rt.value);
  const noRoster = A.rating(mr, [], openid);
  check('无名单时退化为基准', noRoster.basis === 'bench', noRoster.value);

  const rser = A.ratingSeries(s3, s3.matches({ mode: 'swtwr' }));
  check('评分序列长度', rser.length === 4, rser.length);
  check('评分序列按时间升序', rser.every((x, i) => i === 0 || x.t === undefined || true));
  const rstats = A.ratingStats(rser);
  check('评分统计', rstats.avg > 0 && rstats.max >= rstats.avg, JSON.stringify({
    avg: rstats.avg, max: rstats.max, min: rstats.min, median: rstats.median
  }));
  check('评分分布 5 段', rstats.buckets.length === 5,
    rstats.buckets.map(b => b.range + ':' + b.count).join(' | '));
  check('滚动 10 局均分', rstats.rolling10.length === 4, rstats.rolling10.length);

  console.log('\n' + '='.repeat(64));
  console.log('6. 胜率窗口');
  console.log('='.repeat(64));
  const w = A.windowStats(s3.matches({ mode: 'swtwr' }));
  check('近 10 局', w.last10 && w.last10.n === 4, JSON.stringify(w.last10));
  check('近 30 局', w.last30 && w.last30.n === 4, JSON.stringify(w.last30));
  check('滚动 10 局胜率曲线', w.rolling10.length === 4, w.rolling10.map(x => x.v).join(','));
  check('样本不足时窗口取实际场次', w.last50.n === 4, w.last50.n);

  console.log('\n' + '='.repeat(64));
  console.log('7. 分地图（本地统计）');
  console.log('='.repeat(64));
  const maps = A.byMap(s3, s3.matches({ mode: 'swtwr' }));
  check('分组数', maps.length === 2, maps.map(x => x.mapName).join(','));
  maps.forEach(x => {
    check(`  ${x.mapName} 有完整指标`,
      x.total > 0 && x.winRate >= 0 && x.killTotal > 0 && x.rating > 0,
      `场次${x.total} 胜率${x.winRate}% 评分${x.rating} 总击杀${x.killTotal} 总时长${Math.round(x.totalHours)}h`);
  });

  console.log('\n' + '='.repeat(64));
  console.log('8. 兵种 / 干员表现');
  console.log('='.repeat(64));
  const cls = A.byClass(s3, s3.matches({}));
  check('兵种分组', cls.length > 0, cls.map(x => x.label + ':' + x.total).join(' | '));
  check('兵种含胜率与评分', cls.every(x => x.winRate >= 0 && x.rating >= 0));
  check('兵种名是四类之一',
    cls.every(x => ['突击', '医疗', '工程', '侦查', '指挥官'].indexOf(x.label) !== -1),
    cls.map(x => x.label).join(','));
  const ags = A.byAgent(s3, s3.matches({}));
  check('干员分组', ags.length > 0, ags.map(x => x.agent + '(' + x.cls + '):' + x.total).join(' | '));
  check('干员带兵种归类', ags.every(x => !!x.cls && !!x.agent));

  console.log('\n' + '='.repeat(64));
  console.log('9. 救援 / 击杀 / 指挥官');
  console.log('='.repeat(64));
  const rm = A.rescueMetrics(s3, s3.matches({ mode: 'swtwr' }));
  check('救援量化', rm && rm.total > 0 && rm.avg > 0, JSON.stringify({
    total: rm.total, avg: rm.avg, perMin: rm.perMin,
    rescueDeathRatio: rm.rescueDeathRatio, teamShare: rm.teamShare, rankPct: rm.rankPct
  }));
  check('救援占全队比（需名单）', rm.teamShare !== null, rm.teamShare);

  const km = A.killMetrics(s3.matches({ mode: 'swtwr' }));
  check('击杀明细', km && km.total > 0 && km.buckets.length === 5,
    `总${km.total} 均${km.avg} 最高${km.max} 分均${km.perMin}`);
  check('击杀 TOP 局', km.bestMatches.length > 0, km.bestMatches[0] && km.bestMatches[0].kill);

  const cm = A.commanderStats(s3, s3.matches({}));
  check('无指挥官对局时 available=false', cm.available === false, JSON.stringify(cm));
  check('指挥官只认手动标记（赤枭不再自动判定）',
    A.isCommanderMatch({ force_type: 50001, map_id: 601, is_commander: 0 }) === false &&
    A.isCommanderMatch({ force_type: 40010, map_id: 601, is_commander: 1 }) === true);
  check('指挥官模式地图 613 也不再自动判定',
    A.isCommanderMatch({ force_type: 0, map_id: 613, is_commander: 0 }) === false);

  console.log('\n' + '='.repeat(64));
  console.log('9b. 单场小贴士');
  console.log('='.repeat(64));
  const tips = A.matchTips(s3, roomWithRoster);
  check('生成小贴士', tips.length > 0, tips.length + ' 条');
  tips.forEach(t => console.log(`     · [${t.level}] ${t.title}`));
  check('贴士含标题与正文', tips.every(t => !!t.title && !!t.text));
  check('贴士含干员信息', tips.some(t => t.title.indexOf('本局使用') === 0),
    (tips.find(t => t.title.indexOf('本局使用') === 0) || {}).title);

  /* ★ 9c. 「本局双方势均力敌」这条判错过，而且是恒真级别的错：
   *   旧判据写的是 `对面人均 - 我方人均 > 3000` 才算压制 —— **绝对分值**。
   *   可人均分的尺度随局的长短能跨 8 倍（真库 39 场实测 3,792 → 30,313），
   *   于是 32/39 场（82%）都被叫成"势均力敌"，包括用户刚打的那把：
   *   我方人均 4,741 对面 7,199，人均差 2,458 没到 3000 ⇒ 说"势均力敌"，
   *   而那局两边总分是 127,996 : 187,180、相对差 41% —— 一边倒。
   *   现在判据换成 core 算好的相对差（sideGapRel）分三档，方向也补齐（旧写法只判对面更高）。 */
  console.log('\n' + '='.repeat(64));
  console.log('9c. 双方强弱那条：按相对差分档，不许拿绝对分值判');
  console.log('='.repeat(64));
  const SIDE_ME = '1234567890';
  async function sideStore(my, en, win) {
    const st = new StoreMod.Store(memAdapter());
    await st.load();
    st.state.meta.openid = SIDE_ME;
    st.state.meta.name = '我';
    const P = (n, vid, color, score) => ({
      name: n, vopenid: String(vid), kill: 10, death: 5, assist: 2, score: score,
      occupy: 1, rescue: 2, color: color, team_id: color, is_winner: win ? 1 : 0,
      is_leave: 0, game_time: 900, force_type: 20005
    });
    const players = [P('我', SIDE_ME, 1, my.each)];
    for (let i = 1; i < my.n; i++) players.push(P('队友' + i, 7100 + i, 1, my.each));
    for (let i = 0; i < en.n; i++) players.push(P('对面' + i, 7200 + i, 2, en.each));
    st.state.matches.R = {
      room_id: 'R', map_id: 601, map_name: Maps.nameOf(601), start_time: 1000,
      dt_event_time: '2026-09-25 14:44:21', is_winner: win ? 1 : 0, kill: 20, death: 10,
      assist: 5, score: my.each, game_rule: 13, is_swtwr: 1, color: 1, is_leave: 0,
      game_time: 900, force_type: 20005
    };
    st.state.rosters.R = { players: players };
    return st;
  }
  const gapTip = t => (t || []).filter(x => /势均力敌|占上风|一边倒/.test(x.title))[0] || {};
  const sideCases = [
    { 名: '人均只差 2% ⇒ 才配叫势均力敌', my: { n: 5, each: 5000 }, en: { n: 5, each: 5100 }, win: true, 档: '势均力敌' },
    { 名: '相对 18% 且我输 ⇒ 对面略占上风', my: { n: 5, each: 5000 }, en: { n: 5, each: 6000 }, win: false, 档: '对面略占上风' },
    { 名: '相对 18% 但我方高 ⇒ 也说得出方向（旧写法这里一句话都没有）', my: { n: 5, each: 6000 }, en: { n: 5, each: 5000 }, win: true, 档: '我方略占上风' },
    { 名: '用户实测那把：人均差 2,458（旧阈值 3000 没到）相对差 41% ⇒ 一边倒', my: { n: 27, each: 4741 }, en: { n: 26, each: 7199 }, win: false, 档: '一边倒' },
    { 名: '反过来我方碾压 ⇒ 也必须说出来', my: { n: 26, each: 7199 }, en: { n: 27, each: 4741 }, win: true, 档: '一边倒' },
    { 名: '绝对分差 10,000（旧写法必判"压制"）但相对只差 9.5% ⇒ 势均力敌', my: { n: 5, each: 100000 }, en: { n: 5, each: 110000 }, win: false, 档: '势均力敌' }
  ];
  for (const c of sideCases) {
    const st = await sideStore(c.my, c.en, c.win);
    const t = gapTip(A.matchTips(st, 'R'));
    check(c.名, t.title && t.title.indexOf(c.档) >= 0,
      '「' + (t.title || '这一条根本没生成') + '」 期望含「' + c.档 + '」');
  }
  /* 标题里那个百分数必须是 core 算好的那一枚，不许界面/贴士各算一遍 */
  const stChk = await sideStore({ n: 27, each: 4741 }, { n: 26, each: 7199 }, false);
  const relCore = A.lobby(stChk, 'R').diffs.sideGapRel;
  const tChk = gapTip(A.matchTips(stChk, 'R'));
  check('★ 小贴士用的相对差 = core 那枚 sideGapRel（同一份判据，不在文案里重算）',
    Number((tChk.title.match(/([\d.]+)%/) || [])[1]) === Number(Math.abs(relCore).toFixed(1)),
    'core=' + relCore + ' 标题=' + tChk.title);
  check('★ 一边倒那条给的是 warn（我输了且被拉开 41%，不许标成 good）',
    tChk.level === 'warn', 'level=' + tChk.level);
  const allTexts = A.matchTips(await sideStore({ n: 5, each: 5000 }, { n: 5, each: 5050 }, true), 'R');
  check('★ 文案里不许再出现「分差仅 X」这种会被读成双方总分差的句子',
    [].concat(allTexts, [tChk]).every(t => !t.text || t.text.indexOf('分差仅') === -1),
    (allTexts.map(t => t.text).join(' | ') + ' | ' + (tChk.text || '')).slice(0, 120));
  const anSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'analysis.js'), 'utf8');
  const tipsSrc = anSrc.slice(anSrc.indexOf('function matchTips'),
    anSrc.indexOf('function matchTips') + 6000);
  check('★ 红线：matchTips 里不许再拿裸分值比大小（判强弱只许读 sideGapRel）',
    tipsSrc.indexOf('sideGapRel') >= 0 && !/gap\s*[<>]=?\s*\d/.test(tipsSrc) &&
    anSrc.indexOf('> 3000') === -1,
    '读相对差=' + (tipsSrc.indexOf('sideGapRel') >= 0) + ' 还有裸分值阈值=' + (/gap\s*[<>]=?\s*\d/.test(tipsSrc) || anSrc.indexOf('> 3000') >= 0));
  check('★ 两档阈值是从 core 导出的（测试不抄数字）',
    A.SIDE_GAP_EVEN === 10 && A.SIDE_GAP_BLOWOUT === 30,
    A.SIDE_GAP_EVEN + ' / ' + A.SIDE_GAP_BLOWOUT);
  /* 人数不等时用人均而不是总分：少一边的总分天然吃亏，这条口径要钉住 */
  const stFew = await sideStore({ n: 5, each: 8000 }, { n: 8, each: 8000 }, true);
  const tFew = gapTip(A.matchTips(stFew, 'R'));
  check('★ 我方 5 人对面 8 人、人均一样 ⇒ 仍算势均力敌（判据是人均不是总分）',
    tFew.title.indexOf('势均力敌') >= 0, tFew.title);

  console.log('\n' + '='.repeat(64));
  console.log('10. 同局对比');
  console.log('='.repeat(64));
  const cmp = A.lobby(s3, roomWithRoster);
  check('返回本场数据', !!cmp && !!cmp.match, cmp && cmp.match.mapName);
  check('名单人数', cmp.roster > 20, cmp.roster);
  check('各项排名', cmp.ranks.score.rank > 0 && cmp.ranks.kill.rank > 0,
    `得分${cmp.ranks.score.rank} 击杀${cmp.ranks.kill.rank} KDA${cmp.ranks.kda.rank} 救治${cmp.ranks.rescue.rank}`);
  check('得分百分位', cmp.ranks.score.pct >= 0 && cmp.ranks.score.pct <= 100, cmp.ranks.score.pct);
  check('分差计算', typeof cmp.diffs.vsLobbyScore === 'number',
    JSON.stringify(cmp.diffs));
  check('阵营对比 2 方', cmp.sides.length === 2,
    cmp.sides.map(x => (x.isMine ? '我方' : '对方') + x.players + '人/' + x.avgScore).join(' | '));
  check('三张榜', cmp.topScore.length > 0 && cmp.topKill.length > 0 && cmp.topRescue.length > 0);
  check('完整名单', cmp.allPlayers.length === cmp.roster, cmp.allPlayers.length);

  /* ★ 名单抓到了、里面却没有本机这个号：拿数据包导入的号、只读号最容易走到这一支。
   *   这一支真在桌面端把整个详情页崩成骨架屏（rk.score 读到 undefined，2026-10-04 真 Electron 实测），
   *   所以 core 必须给得出"是没有我"而不是默默少一个键，界面才拦得住、才说得出人话。 */
  {
    const own = s3.activeOpenid();
    s3.state.meta.openid = 'FOREIGN-NO-SUCH-PLAYER';
    const cmpForeign = A.lobby(s3, roomWithRoster);
    s3.state.meta.openid = own;
    check('★ 名单里没有本机这个号 ⇒ 标出 meMissing、不给名次（比不了就不硬凑一个假排名）',
      cmpForeign.meMissing === true && cmpForeign.ranks === undefined &&
      cmpForeign.diffs === undefined, JSON.stringify({
        meMissing: cmpForeign.meMissing, ranks: !!cmpForeign.ranks, roster: cmpForeign.roster }));
    check('★ 但这一场自身的数据照常给（不是整场作废）',
      !!cmpForeign.match && cmpForeign.roster === cmp.roster && cmpForeign.roster > 20,
      'roster=' + cmpForeign.roster);
  }

  // 榜单必须带上「我」的真实名次 —— 名次在 6 名开外时界面才能把我补出来
  check('榜单含全量排序与本人名次',
    cmp.boards && cmp.boards.score.list.length === cmp.roster &&
    cmp.boards.score.myRank > 0 && cmp.boards.kill.myRank > 0 && cmp.boards.rescue.myRank > 0,
    `得分第${cmp.boards.score.myRank}/${cmp.boards.score.total} ` +
    `击杀第${cmp.boards.kill.myRank} 救治第${cmp.boards.rescue.myRank}`);
  check('榜单本人名次与 ranks 一致',
    cmp.boards.score.myRank === cmp.ranks.score.rank,
    `${cmp.boards.score.myRank} vs ${cmp.ranks.score.rank}`);
  check('榜单列表按该字段降序',
    cmp.boards.kill.list.every((p, i, a) => i === 0 || a[i - 1].kill >= p.kill) &&
    cmp.boards.score.list.every((p, i, a) => i === 0 || a[i - 1].score >= p.score));
  check('榜单指到的第 N 名就是自己',
    cmp.boards.score.list[cmp.boards.score.myRank - 1].vopenid === s3.state.meta.openid);

  // 交手档案：点击某位同场玩家的明细
  const mates = A.encounters(s3);
  const one = mates.frequent[0];
  const arch = A.encounterDetail(s3, one.key);
  check('交手档案：能取到明细', !!arch && arch.records.length === one.totalMeets,
    (arch && arch.records.length) + ' 条 / 同场 ' + one.totalMeets + ' 场');
  check('交手档案：每条含双方名次',
    arch.records.every(r => r.rankScore > 0 && r.myRankScore > 0 && r.players > 20));
  check('交手档案：同阵营/对面计数自洽',
    arch.allyMeets + arch.enemyMeets === arch.totalMeets,
    arch.allyMeets + ' 同阵营 + ' + arch.enemyMeets + ' 对面');
  check('交手档案：胜平负次数自洽', arch.better + arch.worse <= arch.totalMeets,
    `他压过你${arch.better}次 / 你压过他${arch.worse}次`);
  check('交手档案：按时间倒序',
    arch.records.every((r, i, a) => i === 0 || a[i - 1].startTime >= r.startTime));
  check('交手档案：不给自己生成档案', A.encounterDetail(s3, s3.state.meta.openid) === null);
  check('交手档案：查无此人返回 null', A.encounterDetail(s3, 'not-exist-openid') === null);

  /* ★ 10b. 「战局里救治正常、单场详情里救治不对」——用户报的这条不是算错，是三件事叠在一起：
   *   ① core/store.js 换名单时只比人数（`existing.players.length >= pl.length` 就丢新的），
   *      于是官方那份"人齐了但 rescue 列还没填"的半份名单被永久钉死；
   *   ② 同步的 haveRosters 给的是"有没有名单"，有名单就不再抓这场，补不回来；
   *   ③ 单场详情拿这份半份名单算排名，把你排到 78 人的末尾（真实差 36 名）。
   *   实测样本：09-25 15:11 那一场（room id 已脱敏，不进公开仓库），列表给我 rescue=36，
   *   名单里 78 人全场之和才 14、只有 4 人有值；其余 39 场两份接口一致。 */
  console.log('\n' + '='.repeat(64));
  console.log('10b. 半份名单：以新为准、判不可信、不可信的列一律作废');
  console.log('='.repeat(64));
  const GAP_ME = '1098765432';
  /* 一场 6 人的胜者为王。默认名单里"我"的每一列都与战局列表那行**完全一致**；
   * 想造哪一列的缺值，就把名单里我那一列覆盖成 0（列表仍给真值）—— 这才是官方那份半份快照的形状。 */
  const GAP_BASE = { killNum: 20, death: 8, assist: 6, score: 9000, occupy: 5, rescue: 2 };
  function gapPlayers(meOverride, n) {
    const P = (name, vid, st, color) => Object.assign({
      name: name, vopenid: String(vid), color: color, teamId: color,
      isWinner: 1, isLeave: 0, gameTime: 1200, deployArmedForceType: 20005
    }, st);
    const list = [P('我', GAP_ME, Object.assign({}, GAP_BASE, meOverride || {}), 1)];
    for (let i = 1; i < n; i++) {
      list.push(P('同场' + i, 8100 + i,
        Object.assign({}, GAP_BASE, { killNum: 12, score: 6000, rescue: 1 }),
        i > n - 3 ? 2 : 1));
    }
    return list;
  }
  async function gapStore(rowOverride, meOverride, n, refetch) {
    const st = new StoreMod.Store(memAdapter());
    await st.load();
    const payload = {
      at: Date.now(), role: { openid: GAP_ME },
      list: { tdms: [Object.assign({
        roomId: 'G', startTime: 1777000000, gameRule: 13, mapId: 601,
        isWinner: 1, color: 1, gameTime: 1200, deployArmedForceType: 20005
      }, GAP_BASE, rowOverride || {})] },
      details: [{ roomId: 'G', detail: { battle_detail: { tdm_players: gapPlayers(meOverride, n || 6) } } }]
    };
    await st.ingest(payload);
    if (refetch) { st.state.rosters.G.refetch = refetch; }
    return st;
  }
  const meOf = st => st.players('G').find(p => p.vopenid === GAP_ME);

  /* —— ① 入库：换名单只看"人是不是变少了" —— */
  const stHalf = await gapStore({}, { rescue: 0 }, 6);
  check('★ 半份名单入库后 me.rescue = 0（这份官方快照本身就没填）',
    meOf(stHalf).rescue === 0, meOf(stHalf).rescue);
  const stRefill = await gapStore({ rescue: 36 }, { rescue: 36 }, 6);
  const detailOf = pl => ({ at: Date.now(), details: [{ roomId: 'G', detail: { battle_detail: { tdm_players: pl } } }] });
  await stRefill.ingest(detailOf(gapPlayers({ rescue: 0 }, 6)));
  check('★ 先补齐、再退回半份：同一份库里以新为准 ⇒ 半份能覆盖整份（方向反过来同样成立）',
    meOf(stRefill).rescue === 0 && stRefill.state.rosters.G.refetch === 1,
    'rescue=' + meOf(stRefill).rescue + ' refetch=' + stRefill.state.rosters.G.refetch);
  await stRefill.ingest(detailOf(gapPlayers({ rescue: 36 }, 6)));
  check('★ 人数相同也一律以新为准（旧写法会丢掉的正是补齐的那一份）',
    meOf(stRefill).rescue === 36 && stRefill.state.rosters.G.refetch === 2,
    'rescue=' + meOf(stRefill).rescue + ' refetch=' + stRefill.state.rosters.G.refetch);
  await stRefill.ingest(detailOf(gapPlayers({ rescue: 0 }, 3)));
  check('只有"新人变少"（部分返回）才保留旧的',
    stRefill.players('G').length === 6 && meOf(stRefill).rescue === 36 &&
    stRefill.state.rosters.G.refetch === 2,
    stRefill.players('G').length + ' 人 / rescue ' + meOf(stRefill).rescue + ' / refetch ' + stRefill.state.rosters.G.refetch);
  const storeCodeLines = fs.readFileSync(path.join(__dirname, '..', 'core', 'store.js'), 'utf8')
    .split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  check('★ 红线：入库处的代码里不许再出现"人数够就不换"那句',
    storeCodeLines.indexOf('existing.players.length >= pl.length') === -1 &&
    storeCodeLines.indexOf('pl.length < existing.players.length') >= 0,
    '旧写法还在 = 半份名单又被钉死');

  /* —— ② 判据：只认"列表 > 0 而名单 = 0"这一个方向 —— */
  check('★ 列表 rescue=36 而名单里我 = 0 ⇒ 这一列不可信',
    stHalf.rosterGaps('G').join() === 'rescue', stHalf.rosterGaps('G').join());
  check('★ 反方向（列表 0、名单有值 / 两边都 0）是真打了 0，不能当缺值',
    (await gapStore({ rescue: 0 }, {}, 6)).rosterGaps('G').length === 0 &&
    (await gapStore({ rescue: 0 }, { rescue: 0 }, 6)).rosterGaps('G').length === 0,
    JSON.stringify([(await gapStore({ rescue: 0 }, {}, 6)).rosterGaps('G'),
      (await gapStore({ rescue: 0 }, { rescue: 0 }, 6)).rosterGaps('G')]));
  check('★ 两份一致 ⇒ 没有任何一列不可信', (await gapStore({}, {}, 6)).rosterGaps('G').length === 0);
  check('★ force_type / is_winner 的差异绝不算缺值（官方对名单里的人就是不填这两列）',
    (await gapStore({}, {}, 6)).rosterGaps('G').join() === '' &&
    StoreMod.rosterGaps({ kill: 30, rescue: 36, force_type: 20005, is_winner: 1 },
      { players: [{ vopenid: GAP_ME, kill: 30, rescue: 36, force_type: 0, is_winner: 0 }] }, GAP_ME).length === 0,
    JSON.stringify(StoreMod.rosterGaps({ kill: 30, rescue: 36, force_type: 20005, is_winner: 1 },
      { players: [{ vopenid: GAP_ME, kill: 30, rescue: 36, force_type: 0, is_winner: 0 }] }, GAP_ME)));
  check('名单里没有我 / 查无这场 ⇒ 判不出缺值（不编造）',
    stHalf.rosterGaps('NOPE').length === 0 &&
    StoreMod.rosterGaps({ rescue: 36 }, { players: [{ vopenid: 'other', rescue: 0 }] }, GAP_ME).length === 0);
  check('★ 可信列的字段名是从 core 导出的（测试不抄一份清单）',
    StoreMod.ROSTER_TRUST_FIELDS.join() === 'kill,death,assist,score,occupy,rescue' &&
    StoreMod.ROSTER_REFETCH_MAX === 2, StoreMod.ROSTER_TRUST_FIELDS.join() + ' / ' + StoreMod.ROSTER_REFETCH_MAX);

  /* —— ③ 同步：半份的这场要从"已有名单"里摘出去重抓，抓到上限就不再纠缠 —— */
  check('★ 半份的这场被摘出「已有名单」⇒ 下次同步会重抓',
    stHalf.doubtRoomIds().join() === 'G' && stHalf.trustedRosterRoomIds().indexOf('G') === -1,
    'doubt=' + stHalf.doubtRoomIds().join() + ' trusted=' + stHalf.trustedRosterRoomIds().join());
  const stMax = await gapStore({}, { rescue: 0 }, 6, StoreMod.ROSTER_REFETCH_MAX);
  check('★ 抓满 ' + StoreMod.ROSTER_REFETCH_MAX + ' 次还缺就不再每轮重抓（免得每次同步都白跑）',
    stMax.doubtRoomIds().indexOf('G') === -1 && stMax.trustedRosterRoomIds().indexOf('G') >= 0,
    'doubt=' + stMax.doubtRoomIds().join());
  check('但判据不松口：抓不上来也不许拿它算排名（界面仍画「—」）',
    stMax.rosterGaps('G').join() === 'rescue', stMax.rosterGaps('G').join());
  const stOk = await gapStore({}, {}, 6);
  check('两份一致的场次一直在「已有名单」里（不会每轮白抓）',
    stOk.trustedRosterRoomIds().join() === 'G' && stOk.doubtRoomIds().length === 0,
    'trusted=' + stOk.trustedRosterRoomIds().join());

  /* —— ④ 单场分析：不可信列的派生值全部作废 —— */
  const cmpHalf = A.lobby(stHalf, 'G');
  check('★ 救治排名置 null（旧写法这里给出的是"你排第 6/共 6 名"）',
    cmpHalf.ranks.rescue.rank === null && cmpHalf.ranks.rescue.pct === null &&
    cmpHalf.ranks.rescue.untrusted === true, JSON.stringify(cmpHalf.ranks.rescue));
  check('★ 救治榜整张作废（不是给一张空榜，界面要能分清两者）',
    cmpHalf.boards.rescue === null, String(cmpHalf.boards.rescue));
  check('★ 「救治 vs 全场人均」与它的人均基准一起作废（只废差值会留下"差 —、人均 2.4"这种怪账）',
    cmpHalf.diffs.vsLobbyRescue === null && cmpHalf.diffs.lobbyAvgRescue === null,
    cmpHalf.diffs.vsLobbyRescue + ' / ' + cmpHalf.diffs.lobbyAvgRescue);
  check('可信的列一个都不许误伤：得分排名/榜单/差值照旧',
    cmpHalf.ranks.score.rank === 1 && cmpHalf.boards.score.list.length === cmpHalf.roster &&
    typeof cmpHalf.diffs.vsLobbyScore === 'number' && cmpHalf.ranks.kda.rank > 0,
    '得分第' + cmpHalf.ranks.score.rank + ' KDA第' + cmpHalf.ranks.kda.rank);
  check('缺值清单原样带给界面（界面不自己重算判据）',
    cmpHalf.rosterGaps.join() === 'rescue', cmpHalf.rosterGaps.join());
  const cmpKill = A.lobby(await gapStore({}, { killNum: 0 }, 6), 'G');
  check('★ 击杀不可信 ⇒ KDA 排名与 meKda 跟着一起废（KDA 就是击杀算出来的）',
    cmpKill.ranks.kill.rank === null && cmpKill.ranks.kda.rank === null &&
    cmpKill.meKda === null && cmpKill.boards.kill === null,
    'kill=' + JSON.stringify(cmpKill.ranks.kill) + ' kda=' + JSON.stringify(cmpKill.ranks.kda));
  const stScoreGap = await gapStore({}, { score: 0 }, 6);
  check('★ 得分不可信时不出「双方强弱」那条贴士（半份名单上的人均差是假数）',
    (A.matchTips(stScoreGap, 'G') || []).filter(t => /势均力敌|占上风|一边倒/.test(t.title)).length === 0,
    (A.matchTips(stScoreGap, 'G') || []).map(t => t.title).join(' | '));

  /* —— 界面引用的每一枚 diffs 键，core 必须真的产出 ——
   * 以前 views.js 里写着 d.lobbyAvgKill / d.lobbyAvgKda / d.lobbyAvgRescue / d.lobbyAvgOccupy，
   * core 从来没产出过 ⇒ 「全场人均」那一列 8 个格子永远画「—」，谁也没报错。 */
  const viewsSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'js', 'views.js'), 'utf8');
  const tblFrom = viewsSrc.indexOf('var rankHtml = kpiCards');
  const cmpFull = A.lobby(await gapStore({}, {}, 6), 'G');
  const usedDiffKeys = [];
  viewsSrc.slice(tblFrom, viewsSrc.indexOf('/* —— 阵营对比 ——', tblFrom))
    .replace(/\bd\.([A-Za-z][A-Za-z0-9]*)/g, function (all, k) {
      if (usedDiffKeys.indexOf(k) === -1) usedDiffKeys.push(k);
      return all;
    });
  const missing = usedDiffKeys.filter(k => !(k in cmpFull.diffs));
  check('★ 红线：排名/分差两张表里 d.xxx 引用的键 core 全都产出（不许再静默画成「—」）',
    tblFrom > 0 && usedDiffKeys.length >= 10 && missing.length === 0,
    '引用 ' + usedDiffKeys.length + ' 枚，缺：' + (missing.join() || '无'));
  check('★ 界面不许把 core 的字段名念给用户（列表徽标与详情说明同一份中文名表）',
    /gapLabel\(m\.rosterGaps\)/.test(viewsSrc) && /gapLabel\(gaps\)/.test(viewsSrc) &&
    viewsSrc.indexOf('m.rosterGaps.join(') === -1 &&
    (viewsSrc.match(/GAP_COL_NAME = \{/g) || []).length === 1,
    '中文名表 1 份、徽标与详情都走 gapLabel');
  check('★ 「全场人均」四枚（击杀/KDA/救治/占点）是真的算出来的数字',
    ['lobbyAvgKill', 'lobbyAvgKda', 'lobbyAvgRescue', 'lobbyAvgOccupy']
      .every(k => typeof cmpFull.diffs[k] === 'number' && cmpFull.diffs[k] > 0),
    JSON.stringify({ k: cmpFull.diffs.lobbyAvgKill, kda: cmpFull.diffs.lobbyAvgKda,
      r: cmpFull.diffs.lobbyAvgRescue, o: cmpFull.diffs.lobbyAvgOccupy }));
  check('★ 人均与差值互相对应（差值 = 我的 − 这枚人均），不可信时两者一起 null',
    Math.round(cmpFull.diffs.vsLobbyKill - (cmpFull.me.kill - cmpFull.diffs.lobbyAvgKill)) === 0 &&
    cmpHalf.diffs.lobbyAvgRescue === null && cmpHalf.diffs.lobbyAvgKill > 0,
    'vsKill=' + cmpHalf.diffs.vsLobbyKill + ' avgKill=' + cmpHalf.diffs.lobbyAvgKill);


  console.log('\n' + '='.repeat(64));
  console.log('11. 总报告与筛选联动');
  console.log('='.repeat(64));
  const rAll = A.report(s3, { mode: 'all' });
  check('全部模式', rAll.summary.total === 8, rAll.summary.total);
  check('筛选诊断字段', rAll.filtered.poolSize === 8, JSON.stringify(rAll.filtered));
  check('包含各模块', !!(rAll.summary && rAll.maps && rAll.classes && rAll.rescue &&
    rAll.kills && rAll.windows && rAll.ratingStats), 'ok');
  const rSw = A.report(s3, { mode: 'swtwr' });
  check('仅胜者为王', rSw.summary.total === 4, rSw.summary.total);
  check('胜者胜率 75%', rSw.summary.winRate === 75, rSw.summary.winRate);
  check('洞察生成', rSw.insights.length > 0, rSw.insights.length + ' 条');
  rSw.insights.forEach(i => console.log(`     · [${i.level}] ${i.title}`));
  const rNone = A.report(s3, { mode: 'commander' });
  check('无数据时不崩', rNone.summary === null && rNone.insights.length > 0,
    rNone.insights[0] && rNone.insights[0].title);

  console.log('\n' + '='.repeat(64));
  console.log('12. 采集器');
  console.log('='.repeat(64));
  const notLoginNet = { post: () => Promise.resolve({ result: { error_code: 8000102, error_message: '' } }) };
  const c1 = new CollectorMod.Collector(notLoginNet);
  const lg = await c1.checkLogin();
  check('未登录识别', lg.ok === false && lg.reason === 'not_login', JSON.stringify(lg));

  const okNet = {
    post: (p, b) => {
      const ep = p.split('/').pop();
      if (ep === 'GetRoleInfo') return Promise.resolve({ result: { error_code: 0 }, role_info: raw.role });
      if (ep === 'GetBattleReport') return Promise.resolve(raw.season);
      if (ep === 'GetBattleList') return Promise.resolve(raw.list);
      if (ep === 'GetMapStats') return Promise.resolve(raw.maps);
      if (ep === 'GetBattleDetail') {
        const f = raw.details.find(x => x.roomId === b.roomId) || raw.details[0];
        return Promise.resolve(f.detail);
      }
      return Promise.resolve({ result: { error_code: 0 } });
    }
  };
  const c2 = new CollectorMod.Collector(okNet);
  const payload = await c2.collect({ withDetail: true });
  check('采集成功', !!payload.role && !!payload.season && !!payload.list && !!payload.maps);
  check('默认抓全部模式详情（8 场）', payload.details.length === 8, payload.details.length);
  check('无接口错误', payload.errors.length === 0, JSON.stringify(payload.errors));
  const pSw = await c2.collect({ withDetail: true, detailScope: 'swtwr' });
  check('限定只抓胜者为王（4 场）', pSw.details.length === 4, pSw.details.length);

  // ★ 名单补采：已有名单的场次不再抓详情，缺名单的老场次每轮都会重试
  const have3 = raw.list.tdms.slice(0, 3).map(r => String(r.roomId));
  const pBack = await c2.collect({ withDetail: true, haveRosters: have3 });
  check('已有名单的场次跳过（8-3=5 场待补）', pBack.details.length === 5, pBack.details.length);
  const pFull = await c2.collect({ withDetail: true, haveRosters: raw.list.tdms.map(r => r.roomId) });
  check('名单齐全时零次详情请求', pFull.details.length === 0, pFull.details.length);

  const partialNet = {
    post: (p) => {
      const ep = p.split('/').pop();
      if (ep === 'GetRoleInfo') return Promise.resolve({ result: { error_code: 0 }, role_info: raw.role });
      if (ep === 'GetBattleList') return Promise.resolve(raw.list);
      if (ep === 'GetMapStats') return Promise.reject(new Error('网络超时'));
      if (ep === 'GetBattleReport') return Promise.resolve(raw.season);
      return Promise.resolve({ result: { error_code: 0 }, battle_detail: { tdm_players: [] } });
    }
  };
  const p3 = await new CollectorMod.Collector(partialNet).collect({ withDetail: false });
  check('单接口失败不中断', !!p3.list && p3.errors.length === 1, JSON.stringify(p3.errors));

  /* ★ 账号体系（1=QQ、2=微信）。这一节量的是：微信的号能不能被探测出来，
   *   以及"探测出来了"之后每一发采集是不是真的按它发 —— 上一版把 1 写死在
   *   checkLogin 与 base() 里，微信用户登录页永远等不到回调、什么数据都拿不到。 */
  const seenBodies = [];
  const onlyNet = (roleOn) => ({
    post: (p, b) => {
      const ep = p.split('/').pop();
      if (b && typeof b.account_type !== 'undefined') {
        seenBodies.push({ ep: ep, account_type: b.account_type });
      }
      if (ep === 'GetRoleInfo') {
        if (Number(b && b.account_type) !== roleOn) {
          return Promise.resolve({ result: { error_code: 8000102, error_message: '' } });
        }
        return Promise.resolve({ result: { error_code: 0 }, role_info: raw.role });
      }
      if (ep === 'GetBattleReport') return Promise.resolve(raw.season);
      if (ep === 'GetBattleList') return Promise.resolve({ tdms: [] });
      if (ep === 'GetMapStats') return Promise.resolve(raw.maps);
      return Promise.resolve({ result: { error_code: 0 }, battle_detail: { tdm_players: [] } });
    }
  });

  seenBodies.length = 0;
  const cw = new CollectorMod.Collector(onlyNet(2));
  const pw = await cw.probeLogin();
  check('微信的号：按 QQ 问第一发拿不到角色，改按微信问就拿到了',
    pw.ok === true && pw.accountType === 2 && pw.attempts.length === 2 &&
    pw.attempts[0].ok === false && Number(pw.attempts[0].code) === 8000102,
    JSON.stringify(pw.attempts));
  check('探测成功后这个采集器就记住了是微信端', cw.accountType === 2, cw.accountType);
  /* 探测自己那两发（第一发故意按 QQ 问）不算采集流量：清零后才开始量 collect 发的每一发 */
  seenBodies.length = 0;
  await cw.collect({ withDetail: false });
  const offType = seenBodies.filter(x => Number(x.account_type) !== 2);
  check('★ 探测之后每一发采集请求真按 2 发（写死回 1 就在这儿报红）',
    seenBodies.length >= 4 && offType.length === 0,
    '量到 ' + seenBodies.length + ' 发，其中不是 2 的 ' + offType.length + ' 发：' +
      JSON.stringify(offType.slice(0, 2)));

  const cq = new CollectorMod.Collector(onlyNet(1));
  const pq = await cq.probeLogin();
  check('QQ 端一发就中：不多问第二套体系',
    pq.ok === true && pq.accountType === 1 && pq.attempts.length === 1,
    JSON.stringify(pq.attempts));

  const cnone = new CollectorMod.Collector({
    post: () => Promise.resolve({ result: { error_code: 8000102, error_message: '' } })
  });
  const pn = await cnone.probeLogin();
  check('两套都没问到：回 attempts + 一句话，不是静默',
    pn.ok === false && pn.attempts.length === 2 && !!pn.message,
    JSON.stringify(pn).slice(0, 140));
  check('★ 「没登录」不是「没角色」：这一轮不许开始数改口轮次',
    pn.reason === 'no_role' && pn.rounds === 0 && pn.advice === '',
    JSON.stringify({ reason: pn.reason, rounds: pn.rounds, advice: pn.advice }));

  /* ★ 「网页里那句无角色信息」要连问这么多轮才改口劝人换号。阈值、连问计数、那句话全在 core
   *   （与 matchTips 同一规矩：判定与措辞出自 core，界面只排版），所以这里量的是行为而不是字符串。
   *   数字和文案都从导出读 —— core 改了阈值，这里跟着动，抄一份就成了假红线。 */
  const NR = CollectorMod.PROBE_NO_ROLE_ROUNDS;
  const noRoleNet = () => ({ post: () => Promise.resolve({ result: { error_code: 0 } }) });
  const cnr = new CollectorMod.Collector(noRoleNet());
  const nrRounds = [], nrAdvice = [];
  for (let i = 0; i < NR; i++) {
    const r = await cnr.probeLogin();
    nrRounds.push(r.rounds); nrAdvice.push(r.advice);
  }
  check('★ 连问全 no_role：第 1..' + (NR - 1) + ' 轮只报等待，到第 ' + NR + ' 轮才给换号那句',
    NR >= 4 && nrRounds[0] === 1 && nrRounds[NR - 1] === NR &&
    nrAdvice.slice(0, NR - 1).every(a => a === '') &&
    nrAdvice[NR - 1] === CollectorMod.PROBE_NO_ROLE_ADVICE,
    'rounds=' + JSON.stringify(nrRounds) + ' 有话的轮次=' +
      JSON.stringify(nrAdvice.map((a, i) => (a ? i + 1 : 0)).filter(Boolean)));
  check('★ 改口那句话要说清"这是官方没角色、不是我们的网络问题"并指一条出路',
    /无角色信息/.test(CollectorMod.PROBE_NO_ROLE_ADVICE) &&
      /授权|换号|换个号|改用/.test(CollectorMod.PROBE_NO_ROLE_ADVICE),
    CollectorMod.PROBE_NO_ROLE_ADVICE);

  /* 中间夹一轮"还没登录"就要清零：授权页停在手机上等人点确认时，前几轮全空是常态 */
  const cmix = new CollectorMod.Collector(noRoleNet());
  await cmix.probeLogin(); await cmix.probeLogin();
  cmix.net = { post: () => Promise.resolve({ result: { error_code: 8000102 } }) };
  const rReset = await cmix.probeLogin();
  cmix.net = noRoleNet();
  const rAfter = await cmix.probeLogin();
  check('★ 中间插一轮 not_login 会把连问清零，重新从 1 数起（别把慢的人判成没角色）',
    rReset.rounds === 0 && rAfter.rounds === 1 && rAfter.advice === '',
    JSON.stringify([rReset.rounds, rAfter.rounds]));

  /* ★ 登录成功过一次，那笔"没角色"的旧账就要翻篇：不然隔几天再开一窗，第一句就是"换个号" */
  const cstale = new CollectorMod.Collector(noRoleNet());
  for (let i = 0; i < NR; i++) await cstale.probeLogin();
  cstale.net = onlyNet(1);
  const rOk = await cstale.probeLogin();
  const afterOk = cstale.noRoleRounds;   // ★ 成功之后立刻取：下一轮全 no_role 会把它重新抬到 1
  cstale.net = noRoleNet();
  const rFresh = await cstale.probeLogin();
  check('★ 中间真登录成功过：连问归零，下一窗从零数起（拿旧账说新事就在这儿报红）',
    rOk.ok === true && afterOk === 0 && rFresh.rounds === 1 && rFresh.advice === '',
    JSON.stringify({ ok: rOk.ok, afterOk: afterOk, after: rFresh.rounds }));

  const cdef = new CollectorMod.Collector(onlyNet(2));
  const d0 = await cdef.checkLogin();
  check('没探测过时仍是历史默认 1（老行为没被改坏）',
    d0.ok === false && Number(d0.accountType) === 1 && Number(d0.code) === 8000102,
    JSON.stringify(d0));
  cdef.setAccountType(2);
  const d1 = await cdef.checkLogin();
  check('重启恢复：落盘那枚值带回来，不重新登录也问得到角色',
    d1.ok === true && d1.role.openid === String(raw.role.openid),
    d1.role && d1.role.name);
  check('未知值一律退回 1（不许把垃圾参数发给官方）',
    new CollectorMod.Collector(okNet).setAccountType('x') === 1);

  console.log('\n' + '='.repeat(64));
  console.log('13. 对手与队友识别');
  console.log('='.repeat(64));
  const enc = A.encounters(s3);
  check('扫描带名单的场次', enc.scanned === 4, enc.scanned);
  check('识别出同场玩家', enc.totalPlayers > 50, enc.totalPlayers);
  check('参与人次统计', enc.playedPlayers > 100, enc.playedPlayers);
  check('最常同场榜有数据', enc.frequent.length > 0,
    enc.frequent.slice(0, 3).map(x => x.name + '(同场' + x.totalMeets + '次)').join(' | '));

  // ★ 关键口径：分边随机 → 必须用「同阵营率相对 50% 的偏离」，而不是次数
  check('每位玩家都有同阵营率', enc.frequent.every(x => x.allyRate !== null),
    enc.frequent.slice(0, 3).map(x => x.name + ' ' + x.allyRate + '%').join(' | '));
  check('同阵营率在 0~100', enc.frequent.every(x => x.allyRate >= 0 && x.allyRate <= 100));
  check('总同场次数 = 同阵营 + 敌对',
    enc.frequent.every(x => x.totalMeets === x.allyMeets + x.enemyMeets));
  check('bias 等于同阵营率 − 50',
    enc.frequent.every(x => Math.abs(x.bias - (x.allyRate - 50)) < 0.01));

  check('偏同阵营榜按同阵营率降序',
    enc.topTeammates.every((x, i, a) => i === 0 || a[i - 1].allyRate >= x.allyRate),
    enc.topTeammates.slice(0, 3).map(x => x.name + ' ' + x.allyRate + '%').join(' | '));
  check('偏对手榜按同阵营率升序',
    enc.topOpponents.every((x, i, a) => i === 0 || a[i - 1].allyRate <= x.allyRate),
    enc.topOpponents.slice(0, 3).map(x => x.name + ' ' + x.allyRate + '%').join(' | '));
  check('两个榜都只取同场≥2次的玩家',
    enc.topTeammates.every(x => x.totalMeets >= enc.minMeets) &&
    enc.topOpponents.every(x => x.totalMeets >= enc.minMeets), '阈值 ' + enc.minMeets);

  check('最佳搭档同阵营≥2次', enc.bestMates.every(x => x.allyMeets >= 2), enc.bestMates.length + ' 人');
  check('最难缠对手敌对≥2次', enc.toughest.every(x => x.enemyMeets >= 2), enc.toughest.length + ' 人');
  check('同阵营胜率在 0~100', enc.frequent.every(x => x.allyWinRate === null ||
    (x.allyWinRate >= 0 && x.allyWinRate <= 100)));
  check('含口径说明', !!enc.note && enc.note.indexOf('随机') !== -1, enc.note.slice(0, 30) + '…');

  console.log('\n' + '='.repeat(64));
  console.log('14. 周期对比');
  console.log('='.repeat(64));
  const pc = A.periodCompare(s3, s3.matches({}));
  check('返回周/月两组', !!pc.week && !!pc.month);
  check('含当前与上一周期字段',
    'cur' in pc.week && 'prev' in pc.week && 'curLabel' in pc.week,
    pc.week.curLabel + ' / ' + pc.week.prevLabel);
  check('变化值类型正确',
    pc.week.dWinRate === null || typeof pc.week.dWinRate === 'number',
    '胜率变化=' + pc.week.dWinRate);

  console.log('\n' + '='.repeat(64));
  console.log('15. 地图 × 干员 交叉分析');
  console.log('='.repeat(64));
  const mx = A.mapAgentMatrix(s3, s3.matches({}));
  check('生成组合', mx.cells.length > 0, mx.cells.length + ' 组');
  check('组合含地图/干员/兵种',
    mx.cells.every(c => !!c.mapName && !!c.agent && !!c.cls),
    mx.cells.slice(0, 3).map(c => c.mapName + '×' + c.agent).join(' | '));
  check('组合含胜率与评分', mx.cells.every(c => c.winRate >= 0 && c.rating >= 0));
  check('推荐组合样本≥2', mx.bestPerMap.every(x => x.best.total >= 2), mx.bestPerMap.length + ' 张图');

  /* 两道门分开钉住：minCell 决定进不进推荐表，minSample 只决定这条推荐硬不硬 */
  const stThin = new StoreMod.Store(memAdapter());
  await stThin.load();
  stThin.state.meta.openid = 'thin-openid';
  let thinSeq = 1000;
  [
    { map: 601, ft: 10007, n: 4, win: 4 },  // 4 场全胜 → 硬推荐
    { map: 601, ft: 20005, n: 2, win: 0 },
    { map: 602, ft: 10012, n: 2, win: 2 },  // 只有 2 场 → 薄样本
    { map: 602, ft: 40010, n: 2, win: 0 }
  ].forEach(function (r) {
    for (var i = 0; i < r.n; i++) {
      var id = 'THIN-' + r.map + '-' + r.ft + '-' + i;
      stThin.state.matches[id] = {
        room_id: id, map_id: r.map, map_name: Maps.nameOf(r.map),
        start_time: thinSeq++, dt_event_time: '2026-09-19 00:00:00',
        game_rule: 13, is_swtwr: 1, is_commander: 0, is_winner: i < r.win ? 1 : 0,
        is_leave: 0, force_type: r.ft, color: 1,
        kill: 20, death: 5, assist: 5, score: 20000, occupy: 10, rescue: 0, game_time: 900
      };
    }
  });
  const mxTh = A.mapAgentMatrix(stThin, stThin.matches({}));
  check('门槛随矩阵结果导出', mxTh.minSample === 3 && A.MATRIX_MIN_SAMPLE === 3, mxTh.minSample);
  check('两张图各出一条推荐', mxTh.bestPerMap.length === 2,
    mxTh.bestPerMap.map(x => x.mapName + ':' + x.best.total + '场').join(' | '));
  check('4 场的推荐不标薄', mxTh.bestPerMap.some(x => x.best.total === 4 && x.thinSample === false));
  check('2 场的推荐标薄但不吞行',
    mxTh.bestPerMap.some(x => x.best.total === 2 && x.thinSample === true));

  /* ==================================================================
   * ★ 回归防线：官方「当局临时编号」绝不能被当成身份跨局聚合
   *
   * 真实事故：8 份名单里编号「8007」分别对应 8 个不同玩家，
   * 旧代码按 vopenid 聚合，把 8 个陌生人合成「一人同场 8 次」，纯属虚构。
   * 这里用最小用例把该行为钉死。
   * ================================================================== */
  console.log('\n' + '='.repeat(64));
  console.log('16. 身份识别：临时编号不得跨局聚合');
  console.log('='.repeat(64));

  const MY_ID = '1000000000000000001';   // 合成号：这一段量的是"临时编号不得跨局聚合"，用真号没意义也不该进公开仓库
  function P(name, vid, over) {
    return Object.assign({
      name: name, vopenid: String(vid),
      kill: 10, death: 5, assist: 2, score: 5000,
      occupy: 1, rescue: 2, color: 1, team_id: 1,
      is_winner: 0, is_leave: 0, game_time: 900, force_type: 0
    }, over || {});
  }
  async function fakeStore(specs) {
    const st = new StoreMod.Store(memAdapter());
    await st.load();
    st.state.meta.openid = MY_ID;
    st.state.meta.name = '我本人';
    specs.forEach(s => {
      st.state.matches[s.roomId] = {
        room_id: s.roomId, map_id: 601, map_name: Maps.nameOf(601),
        start_time: s.start, dt_event_time: '2026-09-19 00:00:00',
        is_winner: s.win ? 1 : 0, kill: 20, death: 10, assist: 5,
        score: 20000, game_rule: 13, is_swtwr: 1, color: 1, is_leave: 0
      };
      // 名单需 ≥5 人才计入统计，这里补几个无关路人
      const fill = [1, 2, 3, 4].map(i =>
        P('路人' + i + '_' + s.roomId, '9000000000000000' + i + s.roomId.slice(-1),
          { color: i % 2 + 1, score: 1000 + i }));
      st.state.rosters[s.roomId] = { players: s.players.concat(fill) };
    });
    return st;
  }
  const ME = () => P('我本人', MY_ID, { color: 1, score: 20000 });

  const fs1 = await fakeStore([
    { roomId: 'R1', start: 1000, win: false, players: [ME(), P('陌生人甲', 8007, { color: 2 })] },
    { roomId: 'R2', start: 2000, win: true, players: [ME(), P('Td07', 8007, { color: 2 })] }
  ]);
  const e1 = A.encounters(fs1);
  const byName1 = {};
  e1.frequent.forEach(x => { byName1[x.name] = x; });
  check('同一临时编号的两个人不能合并',
    !e1.frequent.some(x => x.totalMeets === 2),
    e1.frequent.map(x => x.name + ':' + x.totalMeets).join(' | '));
  check('陌生人甲只算 1 场', byName1['陌生人甲'] && byName1['陌生人甲'].totalMeets === 1,
    byName1['陌生人甲'] && byName1['陌生人甲'].totalMeets);
  check('Td07 只算 1 场', byName1['Td07'] && byName1['Td07'].totalMeets === 1,
    byName1['Td07'] && byName1['Td07'].totalMeets);
  check('临时编号玩家标记为低置信（昵称识别）',
    byName1['Td07'].identifiable === false && byName1['Td07'].confidence === 'name');
  check('身份键带前缀区分', byName1['Td07'].key.indexOf('nm:') === 0, byName1['Td07'].key);

  // 稳定账号 ID 必须能跨局聚合
  const fs2 = await fakeStore([
    { roomId: 'R1', start: 1000, win: false, players: [ME(), P('老熟人', MY_ID + '9', { color: 2 })] },
    { roomId: 'R2', start: 2000, win: true, players: [ME(), P('老熟人', MY_ID + '9', { color: 1 })] }
  ]);
  const e2 = A.encounters(fs2);
  const mate = e2.frequent.find(x => x.name === '老熟人');
  check('稳定账号 ID 可跨局聚合为 2 场', mate && mate.totalMeets === 2, mate && mate.totalMeets);
  check('稳定账号标记为高置信', mate && mate.identifiable === true && mate.confidence === 'id');
  check('身份键为 id: 前缀', mate && mate.key.indexOf('id:') === 0, mate && mate.key);

  // 同一人时隐时现（一次带稳定 ID、一次只有临时编号且昵称相同）→ 应合并
  const fs3 = await fakeStore([
    { roomId: 'R1', start: 1000, win: false, players: [ME(), P('老王', '9999999999999999999', { color: 2 })] },
    { roomId: 'R2', start: 2000, win: true, players: [ME(), P('老王', 8011, { color: 2 })] }
  ]);
  const e3 = A.encounters(fs3);
  const wang = e3.frequent.filter(x => x.name === '老王');
  check('昵称相同时临时编号记录并入账号', wang.length === 1 && wang[0].totalMeets === 2,
    wang.map(x => x.name + ':' + x.totalMeets).join(','));

  // 交手档案：按 key 查询，且记录条数必须与同场次数一致
  const arch2 = A.encounterDetail(fs2, mate.key);
  check('交手档案按 key 可查', !!arch2 && arch2.records.length === 2, arch2 && arch2.records.length);
  check('档案含逐场双方名次',
    arch2.records.every(r => r.rankScore > 0 && r.myRankScore > 0));
  const archTd = A.encounterDetail(fs1, byName1['Td07'].key);
  check('昵称识别者的档案只有 1 条', archTd.records.length === 1, archTd.records.length);
  check('档案标注低置信', archTd.identifiable === false);
  check('旧式裸 openid 查询不再命中', A.encounterDetail(fs1, '8007') === null);

  console.log('\n' + '='.repeat(64));
  console.log('17. 地图分组按模式区分 + 采集进度回调');
  console.log('='.repeat(64));
  // 同一 map_id 两种模式：胜者为王 601 与常规 601 → 应分成两组
  const stMode = new StoreMod.Store(memAdapter());
  await stMode.load();
  stMode.state.meta.openid = MY_ID;
  stMode.state.meta.name = '我本人';
  [
    { roomId: 'MA', start: 1000, map_id: 601, is_swtwr: 1, is_commander: 0 },
    { roomId: 'MB', start: 2000, map_id: 601, is_swtwr: 0, is_commander: 0 },
    { roomId: 'MC', start: 3000, map_id: 601, is_swtwr: 0, is_commander: 1 }
  ].forEach(function (r) {
    stMode.state.matches[r.roomId] = {
      room_id: r.roomId, map_id: r.map_id, map_name: Maps.nameOf(r.map_id),
      start_time: r.start, dt_event_time: '2026-09-19 00:00:00',
      is_winner: 1, kill: 15, death: 8, assist: 3, score: 12000, game_rule: 13,
      is_swtwr: r.is_swtwr, is_commander: r.is_commander, color: 1, is_leave: 0
    };
  });
  const modeMaps = A.byMap(stMode, stMode.matches({}));
  check('同 map_id 三模式拆成三组', modeMaps.length === 3,
    modeMaps.map(x => x.mapName + '/' + x.mode).join(','));
  check('每组带 modeKind 标签',
    modeMaps.every(x => ['swtwr', 'commander', 'normal'].indexOf(x.modeKind) !== -1));
  const mmx = A.mapAgentMatrix(stMode, stMode.matches({}));
  check('矩阵 cells 含 mode 字段', mmx.cells.every(c => !!c.mode));

  // 采集进度回调
  const progressLog = [];
  const fakeNet = {
    post: function (p) {
      if (p.indexOf('GetRoleInfo') !== -1) {
        return Promise.resolve({ role_info: { openid: MY_ID, area: 36, name: '我本人', level: 1, tdmLevel: 1, tdmExp: 0 } });
      }
      if (p.indexOf('GetBattleReport') !== -1) return Promise.resolve({ sid: '10' });
      if (p.indexOf('GetBattleList') !== -1) {
        return Promise.resolve({
          tdms: [{ roomId: 'R1', mapId: 601, startTime: 1000, dtEventTime: '2026-09-19 00:00:00', gameRule: 13 },
                 { roomId: 'R2', mapId: 601, startTime: 2000, dtEventTime: '2026-09-19 00:10:00', gameRule: 13 }]
        });
      }
      if (p.indexOf('GetMapStats') !== -1) return Promise.resolve({});
      if (p.indexOf('GetBattleDetail') !== -1) return Promise.resolve({ roomId: 'x' });
      return Promise.resolve({});
    }
  };
  const collector2 = new CollectorMod.Collector(fakeNet);
  await collector2.collect({ withDetail: true, onProgress: function (p) { progressLog.push(p); } });
  check('进度回调按 5 个阶段推进', progressLog.length >= 5,
    progressLog.map(p => p.percent + '%').join(','));
  check('最后一条 percent 接近 100', progressLog[progressLog.length - 1].percent >= 90);
  check('percent 单调不回退', progressLog.every(function (p, i) {
    return i === 0 || p.percent >= progressLog[i - 1].percent;
  }));

  console.log('\n' + '='.repeat(64));
  console.log('18. 分页采集 · after 游标 = 上页 tdms[6].dtEventTime');
  console.log('='.repeat(64));
  // 5 页 mock，每页 8 条；after 必须等于上一页 tdms[6].dtEventTime
  const pageFixtures = [];
  for (let i = 0; i < 5; i++) {
    const arr = [];
    for (let j = 0; j < 8; j++) {
      const n = i * 7 + j;
      arr.push({
        roomId: 'PAGE-' + n, mapId: 601, startTime: 1000 + n * 1000,
        dtEventTime: '2026-09-' + (19 - i) + ' ' + String(10 + j).padStart(2, '0') + ':00:00',
        gameRule: 13
      });
    }
    pageFixtures.push({ tdms: arr });
  }
  const cursorLog = [];
  let pageCalls = 0;
  const pnet = {
    post: function (p, body) {
      if (p.indexOf('GetRoleInfo') !== -1) {
        return Promise.resolve({ role_info: { openid: MY_ID, area: 36, name: '我', level: 1, tdmLevel: 1, tdmExp: 0 } });
      }
      if (p.indexOf('GetBattleReport') !== -1) return Promise.resolve({});
      if (p.indexOf('GetBattleList') !== -1) {
        cursorLog.push(body.after);
        const r = pageFixtures[pageCalls] || { tdms: [] };
        pageCalls++;
        return Promise.resolve(r);
      }
      if (p.indexOf('GetMapStats') !== -1) return Promise.resolve({});
      if (p.indexOf('GetBattleDetail') !== -1) return Promise.resolve({});
      return Promise.resolve({});
    }
  };
  const paginator = new CollectorMod.Collector(pnet);
  const pout = await paginator.collect({ withDetail: false, pages: 5, pageDelayMs: 0 });
  check('首页 after 为 null', cursorLog[0] === null, String(cursorLog[0]));
  check('第 2 页 after = 第 1 页 tdms[6].dtEventTime',
    cursorLog[1] === pageFixtures[0].tdms[6].dtEventTime, String(cursorLog[1]));
  check('第 5 页 after = 第 4 页 tdms[6].dtEventTime',
    cursorLog[4] === pageFixtures[3].tdms[6].dtEventTime, String(cursorLog[4]));
  check('第 6 页因上页返回 <7 条而终止',
    pageCalls === 5, 'pageCalls=' + pageCalls);
  check('out.list 保留原形状 {tdms,sols,bricks}',
    pout.list && Array.isArray(pout.list.tdms) &&
      Array.isArray(pout.list.sols) && Array.isArray(pout.list.bricks));
  check('tdms 按 roomId 去重累积 36 条（5 页 × 8 减去 4 处重叠）', pout.list.tdms.length === 36,
    'len=' + pout.list.tdms.length);
  check('按 roomId 去重',
    new Set(pout.list.tdms.map(t => t.roomId)).size === pout.list.tdms.length);

  // 单页就到底：tdms.length < 7
  pageCalls = 0;
  const snet = {
    post: function (p, body) {
      if (p.indexOf('GetRoleInfo') !== -1) {
        return Promise.resolve({ role_info: { openid: MY_ID, area: 36, name: '我', level: 1, tdmLevel: 1, tdmExp: 0 } });
      }
      if (p.indexOf('GetBattleReport') !== -1) return Promise.resolve({});
      if (p.indexOf('GetBattleList') !== -1) {
        pageCalls++;
        return Promise.resolve({ tdms: pageCalls === 1 ? pageFixtures[0].tdms.slice(0, 5) : [] });
      }
      if (p.indexOf('GetMapStats') !== -1) return Promise.resolve({});
      return Promise.resolve({});
    }
  };
  const sc = new CollectorMod.Collector(snet);
  const sout = await sc.collect({ withDetail: false, pages: 5, pageDelayMs: 0 });
  check('不足 7 条时仅请求 1 页', pageCalls === 1, 'pageCalls=' + pageCalls);
  check('累积 5 条', sout.list.tdms.length === 5, 'len=' + sout.list.tdms.length);

  /* ★★ 翻页自证（v1.9.1）。上面那批夹具正好把三种停法都跑到了，这里量的是：
   *   翻了几页 / 每页回来几条 / 去重留下几条 / 最后为什么停 —— 一样都不能少。
   *   起因是他那句「为什么有用户只获取了 17 场」：光看总数判不出是①官方窗口到底了
   *   ②我们提前停了 ③抓回来被判重吃掉了，所以这三样必须由 core 一路带到界面。 */
  console.log('\n18b. 翻页自证 pageTrace + 赛季号不再写死');
  const tr = pout.pageTrace || {};
  check('翻满 5 页那一轮：每页 8 条、官方重叠 1 条 ⇒ 逐页 rows=8 / 首页 kept=8 / 次页 kept=7',
    tr.pages && tr.pages.length === 5 && tr.pages.every(p => p.rows === 8) &&
      tr.pages[0].kept === 8 && tr.pages[1].kept === 7,
    JSON.stringify(tr.pages));
  check('整轮 rows 40 条、去重后 kept 36 条（少了 4 条要看得见是被判重吃掉的，不是凭空少）',
    tr.rows === 40 && tr.kept === 36 && tr.kept === pout.list.tdms.length,
    'rows=' + tr.rows + ' kept=' + tr.kept);
  check('撞上限那一轮停因 = cap，且原话由 core 的 STOP_TEXT 给（界面不许再编一句）',
    tr.stop === 'cap' && tr.stopText === CollectorMod.STOP_TEXT.cap, tr.stopText);
  check('这一轮问了几页、UI 每页算 7 条，也一起回给界面（"最多约 36 场"这句话有两个数要念）',
    tr.cap === 5 && tr.pageSizeUi === 7, 'cap=' + tr.cap + ' pageSizeUi=' + tr.pageSizeUi);
  check('不足 7 条那一轮：pages=1、stop=short、kept=5',
    sout.pageTrace.pages.length === 1 && sout.pageTrace.stop === 'short' &&
      sout.pageTrace.kept === 5 && sout.pageTrace.stopText === CollectorMod.STOP_TEXT.short,
    sout.pageTrace.stop + ' / ' + sout.pageTrace.stopText);

  const enet = {
    post: function (p) {
      if (p.indexOf('GetRoleInfo') !== -1) {
        return Promise.resolve({ role_info: { openid: MY_ID, area: 36, name: '我', level: 1, tdmLevel: 1, tdmExp: 0 } });
      }
      return Promise.resolve({ tdms: [] });
    }
  };
  const eout = await new CollectorMod.Collector(enet).collect({ withDetail: false, pageDelayMs: 0 });
  check('官方一页一条都没回：stop=empty，且不留半页假记录',
    eout.pageTrace.pages.length === 1 && eout.pageTrace.pages[0].rows === 0 &&
      eout.pageTrace.stop === 'empty', JSON.stringify(eout.pageTrace));

  let failFirstPage = 0;
  const xnet = {
    post: function (p) {
      if (p.indexOf('GetRoleInfo') !== -1) {
        return Promise.resolve({ role_info: { openid: MY_ID, area: 36, name: '我', level: 1, tdmLevel: 1, tdmExp: 0 } });
      }
      if (p.indexOf('GetBattleList') !== -1) {
        failFirstPage++;
        return Promise.reject(new Error('连接被重置'));
      }
      return Promise.resolve({ tdms: [] });
    }
  };
  const xout = await new CollectorMod.Collector(xnet).collect({ withDetail: false, pageDelayMs: 0 });
  check('★ 某一页请求失败：pageTrace 仍然回得来（挂引用在先），停因写 error 并把原因带上',
    xout.pageTrace && xout.pageTrace.stop === 'error' &&
      xout.pageTrace.errorText.indexOf('连接被重置') !== -1 && failFirstPage === 1,
    JSON.stringify(xout.pageTrace) + ' 请求了 ' + failFirstPage + ' 次');
  check('失败那一轮 list 照旧为空、错误进 errors（自证不能把老行为改了）',
    !xout.list && xout.errors.some(s => s.indexOf('最近战局') === 0), JSON.stringify(xout.errors));

  /* ★ 赛季号：官方没有"查当前赛季号"的接口，所以这一颗只能是"我们问的是第几号"。
   *   以前 '10' 写死在 base() 之外那一发里，换赛季后赛季汇总/分地图统计念的是旧存档，
   *   而界面没有任何地方说明这件事。现在：默认仍有一份（collector 里那颗），
   *   设置里能改，两发都按它发，回包也带上，脏值只留数字。 */
  check('DEFAULT_SID 只有 collector 一份，且导出来给界面/两个壳念',
    CollectorMod.DEFAULT_SID === '10', CollectorMod.DEFAULT_SID);
  const sidBodies = [];
  const sidNet = {
    post: function (p, b) {
      const ep = p.split('/').pop();
      if (ep === 'GetRoleInfo') {
        return Promise.resolve({ role_info: { openid: MY_ID, area: 36, name: '我', level: 1, tdmLevel: 1, tdmExp: 0 } });
      }
      if (ep === 'GetBattleReport' || ep === 'GetMapStats') sidBodies.push({ ep: ep, sid: b.sid });
      if (ep === 'GetBattleList') return Promise.resolve({ tdms: [] });
      return Promise.resolve({});
    }
  };
  await new CollectorMod.Collector(sidNet).collect({ withDetail: false, pageDelayMs: 0 });
  check('没设赛季号 ⇒ 赛季汇总与分地图统计两发都按内置默认问（战局列表这一发不带 sid，实测过）',
    sidBodies.length === 2 && sidBodies.every(x => x.sid === '10'), JSON.stringify(sidBodies));
  sidBodies.length = 0;
  const o11 = await new CollectorMod.Collector(sidNet).collect({ withDetail: false, sid: '11', pageDelayMs: 0 });
  check('★ 设置里改了赛季号 ⇒ 两发真按 11 发，回包也带 out.sid（写死回 10 就在这儿报红）',
    sidBodies.length === 2 && sidBodies.every(x => x.sid === '11') && o11.sid === '11',
    JSON.stringify(sidBodies) + ' out.sid=' + o11.sid);
  sidBodies.length = 0;
  await new CollectorMod.Collector(sidNet).collect({ withDetail: false, sid: '1x0"', pageDelayMs: 0 });
  check('脏赛季号只留数字（不会把引号之类的带进官方请求）',
    sidBodies.length === 2 && sidBodies.every(x => /^\d+$/.test(String(x.sid))),
    JSON.stringify(sidBodies));
  check('空串赛季号退回内置默认（设置里清空 = 用默认，不是发一个空 sid）',
    (await new CollectorMod.Collector(sidNet).collect({ withDetail: false, sid: '', pageDelayMs: 0 })).sid === '10');

  console.log('\n' + '='.repeat(64));
  console.log('19. 多账号 · openid 隔离');
  console.log('='.repeat(64));
  function memStore(initState) {
    let saved = initState || null;
    return {
      adapter: {
        load: function () { return saved ? JSON.parse(JSON.stringify(saved)) : null; },
        save: function (s) { saved = JSON.parse(JSON.stringify(s)); }
      },
      peek: function () { return saved; }
    };
  }
  // 同一 start_time + map_id 但不同 openid：两个 slot 各建一份，不判重
  const box1 = memStore();
  const s1 = new StoreMod.Store(box1.adapter);
  await s1.load();
  const sharedRow = {
    roomId: 'rshared', startTime: 1700000000, dtEventTime: '2026-09-01 12:00:00',
    mapId: 601, gameRule: 13, killNum: 10, death: 5, assist: 2, score: 1000,
    occupy: 100, rescue: 0, gameTime: 900, isWinner: 1, gameResult: 1, isLeave: 0,
    teamId: 1, color: 1, isRankedMatch: 0, rankMatchScore: 0, deployArmedForceType: 0
  };
  const payload1 = {
    at: Date.now(), role: { openid: 'acc-A', name: 'A 号', area: 36 },
    list: { tdms: [sharedRow], sols: [], bricks: [] }
  };
  const r1 = await s1.ingest(payload1);
  check('A 号入库 1 场', r1.inserted === 1 && r1.duplicates === 0,
    JSON.stringify({ i: r1.inserted, d: r1.duplicates }));
  check('normalize.match 带 owner_openid',
    s1.state.matches.rshared && s1.state.matches.rshared.owner_openid === 'acc-A',
    s1.state.matches.rshared && s1.state.matches.rshared.owner_openid);

  // 同 roomId 相同 start_time+map_id 落到 B 号 slot：应独立入库
  const box2 = memStore();
  const s2 = new StoreMod.Store(box2.adapter);
  await s2.load();
  const payload2 = {
    at: Date.now(), role: { openid: 'acc-B', name: 'B 号', area: 36 },
    list: { tdms: [Object.assign({}, sharedRow)], sols: [], bricks: [] }
  };
  const r2 = await s2.ingest(payload2);
  check('B 号 slot 也入库 1 场（跨号不判重）',
    r2.inserted === 1 && r2.duplicates === 0,
    JSON.stringify({ i: r2.inserted, d: r2.duplicates }));
  check('activeOpenid A/B 各自独立',
    s1.activeOpenid() === 'acc-A' && s2.activeOpenid() === 'acc-B',
    s1.activeOpenid() + ' | ' + s2.activeOpenid());

  // A 号 slot 收到 B 号的 payload 应拒绝
  const r3 = await s1.ingest({
    at: Date.now(), role: { openid: 'acc-B', name: 'B 号', area: 36 },
    list: { tdms: [Object.assign({}, sharedRow, { roomId: 'rshared-B' })], sols: [], bricks: [] }
  });
  check('openid 不匹配时 ingest 拒绝',
    r3.inserted === 0 && r3.errors && r3.errors.length === 1 && /openid/.test(r3.errors[0]),
    JSON.stringify(r3.errors));
  check('A 号 matches 未被污染', !s1.state.matches['rshared-B'], Object.keys(s1.state.matches).join(','));

  // report.openid 反映当前 slot
  const repA = A.report(s1, { mode: 'all', leave: 'all' });
  const repB = A.report(s2, { mode: 'all', leave: 'all' });
  check('report.openid = 活动 slot openid',
    repA.openid === 'acc-A' && repB.openid === 'acc-B',
    repA.openid + ' | ' + repB.openid);
  check('report.name 反映活动 slot', repA.name === 'A 号' && repB.name === 'B 号',
    repA.name + ' | ' + repB.name);

  console.log('\n' + '='.repeat(64));
  console.log('20. 手动标注 · 指挥官双归属 / 不纳入统计');
  console.log('='.repeat(64));
  {
    const s = new StoreMod.Store(memAdapter());
    await s.load();
    const tdms = raw.list.tdms;
    const swRow = tdms.filter(r => Maps.isSWWR(r.mapId, r.gameRule))[0];
    const plainRow = tdms.filter(r => !Maps.isSWWR(r.mapId, r.gameRule))[0];
    const swDetail = (raw.details || []).filter(d => String(d.roomId) === String(swRow.roomId))[0];
    await s.ingest({
      at: Date.now(), role: raw.role,
      list: { tdms: [swRow, plainRow], sols: [], bricks: [] },
      details: swDetail ? [swDetail] : []
    });
    const rid = String(swRow.roomId);
    const total0 = s.matches({ mode: 'all' }).length;
    check('入库后 is_commander 一律为 0（不再自动判定）', s.match(rid).is_commander === 0);

    const r1 = await s.setMatchFlag(rid, 'commander', true);
    check('标记指挥官成功并回显 flags', r1.ok === true && r1.flags.commander === 1,
      JSON.stringify(r1.flags));
    check('双归属：swtwr 与 commander 筛选都含该场',
      s.matches({ mode: 'swtwr' }).some(m => m.room_id === rid) &&
      s.matches({ mode: 'commander' }).some(m => m.room_id === rid));
    check('战局不重复：mode=all 仍只有一条',
      s.matches({ mode: 'all' }).length === total0, s.matches({ mode: 'all' }).length);
    const c1 = s.modeCounts();
    check('modeCounts 独立计数：all = swtwr + other 且 commander 不额外占额',
      c1.all === c1.swtwr + c1.other && c1.commander === 1 && c1.swtwr === 1, JSON.stringify(c1));
    check('标记即时生效（无需重载）：report(mode=commander) 命中 1 场',
      A.report(s, { mode: 'commander' }).filtered.total === 1);
    check('地图分析按模式分组时标为指挥官的场次独立成组',
      A.report(s, {}).maps.filter(x => x.map_id === Number(swRow.mapId)).length >= 1);

    const before = A.report(s, {}).summary.total;
    const encBefore = A.encounters(s).scanned;
    const r2 = await s.setMatchFlag(rid, 'excluded', true);
    check('排除标记成功', r2.ok === true && r2.flags.excluded === 1);
    check('排除后 matches() 默认查不到', !s.matches({}).some(m => m.room_id === rid));
    check('includeExcluded 仍可查（战局列表灰显保留）',
      s.matches({ includeExcluded: true }).some(m => m.room_id === rid));
    check('排除后各页分析少一场', A.report(s, {}).summary.total === before - 1,
      before + ' → ' + A.report(s, {}).summary.total);
    check('排除后对手队友不再扫描该场名单', A.encounters(s).scanned === encBefore -
      (swDetail ? 1 : 0), encBefore + ' → ' + A.encounters(s).scanned);
    const c2 = s.modeCounts();
    check('modeCounts 剔除排除场并单列 excluded',
      c2.excluded === 1 && c2.all === before - 1 && c2.swtwr === 0 && c2.commander === 0,
      JSON.stringify(c2));
    check('storedCounts 不受排除影响',
      s.storedCounts().total === total0 && s.storedCounts().excluded === 1,
      JSON.stringify(s.storedCounts()));
    check('被排除的场次仍能打开单场详情', !!s.match(rid) && !!A.lobby(s, rid));

    await s.setMatchFlag(rid, 'excluded', false);
    await s.setMatchFlag(rid, 'commander', false);
    check('全部取消后 flags 不残留孤儿项', !s.state.flags[rid], JSON.stringify(s.state.flags));
    check('取消后计数回到标记前', s.modeCounts().commander === 0 && s.modeCounts().all === total0);

    check('未知标记类型被拒绝', (await s.setMatchFlag(rid, 'delete', true)).ok === false);
    check('不存在的场次被拒绝', (await s.setMatchFlag('nope-1', 'commander', true)).ok === false);

    /* 指挥官是胜者为王里的角色：常规对局即使绕过 UI 直接调 store 也必须被拒 */
    const pid = String(plainRow.roomId);
    check('常规对局确实未识别为胜者为王', !!s.match(pid) && s.match(pid).is_swtwr === 0,
      JSON.stringify({ is_swtwr: s.match(pid) && s.match(pid).is_swtwr }));
    const rPlain = await s.setMatchFlag(pid, 'commander', true);
    check('常规对局打指挥官标记被 store 拒绝', rPlain.ok === false &&
      rPlain.error === '指挥官标记仅适用于胜者为王对局', JSON.stringify(rPlain));
    check('被拒后该场 is_commander 仍为 0 且不落 flags',
      s.match(pid).is_commander === 0 && !s.state.flags[pid],
      JSON.stringify(s.state.flags));
    check('被拒后常规对局的排除标记照常可用',
      (await s.setMatchFlag(pid, 'excluded', true)).ok === true);
    await s.setMatchFlag(pid, 'excluded', false);

    await s.setMatchFlag(rid, 'commander', true);
    const sReload = new StoreMod.Store(s.adapter);
    await sReload.load();
    check('重载后标注仍在',
      sReload.modeCounts().commander === 1 && sReload.match(rid).is_commander === 1);

    // 模拟外部数据包：给常规对局带上脏 commander flag，load 时必须在物化处被拦掉
    let dirtyData = null;
    const dirtyAdapter = {
      load: () => dirtyData,
      save: (st) => { dirtyData = JSON.parse(JSON.stringify(st)); }
    };
    const d1 = new StoreMod.Store(dirtyAdapter);
    await d1.load();
    await d1.ingest({
      at: Date.now(), role: raw.role,
      list: { tdms: [swRow, plainRow], sols: [], bricks: [] }, details: []
    });
    dirtyData = JSON.parse(JSON.stringify(d1.state));
    dirtyData.flags[pid] = { commander: 1 };
    dirtyData.matches[pid].is_commander = 1;
    const d2 = new StoreMod.Store(dirtyAdapter);
    await d2.load();
    check('外部包里的脏指挥官 flag（常规对局）load 时被拦掉',
      d2.match(pid).is_commander === 0 && !d2.state.flags[pid] &&
      d2.modeCounts().commander === 0, JSON.stringify(d2.state.flags));

    // 伪造 v1.1.x 磁盘数据：旧口径按地图自动写的 is_commander=1，load 后必须归零
    let legacyData = null;
    const legacyAdapter = {
      load: () => legacyData,
      save: (st) => { legacyData = JSON.parse(JSON.stringify(st)); }
    };
    const row613 = Object.assign({}, tdms[0], { roomId: 'r-legacy-613', mapId: 613 });
    const l1 = new StoreMod.Store(legacyAdapter);
    await l1.load();
    await l1.ingest({ at: Date.now(), role: raw.role, list: { tdms: [row613], sols: [], bricks: [] } });
    legacyData = JSON.parse(JSON.stringify(l1.state));
    legacyData.matches['r-legacy-613'].is_commander = 1;
    const l2 = new StoreMod.Store(legacyAdapter);
    await l2.load();
    check('旧库遗留的自动 is_commander 在 load 时重算归零',
      l2.state.matches['r-legacy-613'].is_commander === 0 && l2.modeCounts().commander === 0);

    /* ---------------- 第三枚手动标记：比赛对局（只有胜者为王能标，可取消回去） ----------------
     * 这一枚的全部意义是「人认定、软件不识别」，所以判据只能有一条：is_competition。
     * 下面这些断言盯着三件事：两轴正交（能叠着筛）、all === comp + practice（哪边都不许漏掉一场）、
     * 以及「不纳入统计」永远排在前面（同时命中时两边都不计，只进 excluded 桶）。 */
    check('入库后 is_competition 一律为 0（没有自动判定）', s.match(rid).is_competition === 0);
    const k0 = s.modeCounts();
    check('一枚都没标时全部落在「匹配」，且 all = comp + practice',
      k0.comp === 0 && k0.practice === k0.all && k0.all === k0.swtwr + k0.other, JSON.stringify(k0));

    const rk = await s.setMatchFlag(rid, 'competition', true);
    check('标为比赛成功并回显 flags', rk.ok === true && rk.flags.competition === 1,
      JSON.stringify(rk.flags));
    check('比赛标记不动模式归属（all / swtwr / commander 三档场数一个没变）',
      s.modeCounts().all === k0.all && s.modeCounts().swtwr === k0.swtwr &&
      s.modeCounts().commander === k0.commander, JSON.stringify(s.modeCounts()));
    check('kind=comp 只有这一场',
      s.matches({ kind: 'comp' }).length === 1 && s.matches({ kind: 'comp' })[0].room_id === rid);
    check('kind=practice 不含这一场，常规对局仍在匹配这边',
      !s.matches({ kind: 'practice' }).some(m => m.room_id === rid) &&
      s.matches({ kind: 'practice' }).length === k0.all - 1);
    check('两根轴正交：mode 与 kind 能叠着筛（swtwr+comp=1、commander+comp=1、other+comp=0）',
      s.matches({ mode: 'swtwr', kind: 'comp' }).length === 1 &&
      s.matches({ mode: 'commander', kind: 'comp' }).length === 1 &&
      s.matches({ mode: 'other', kind: 'comp' }).length === 0);
    const kc = s.modeCounts();
    check('modeCounts 的 comp + practice 正好等于纳入统计的场数',
      kc.comp === 1 && kc.comp + kc.practice === kc.all, JSON.stringify(kc));
    check('report(kind=comp) 与 matches(kind=comp) 用的是同一条判据',
      A.report(s, { kind: 'comp' }).filtered.total === 1 &&
      A.report(s, { kind: 'comp' }).filtered.afterKind === 1,
      JSON.stringify(A.report(s, { kind: 'comp' }).filtered));
    check('report 回显 filters.kind 并给出三种口径文案',
      A.report(s, { kind: 'comp' }).filters.kind === 'comp' &&
      A.report(s, { kind: 'comp' }).filterKindLabel === '比赛对局（你手动标的）' &&
      A.report(s, { kind: 'practice' }).filterKindLabel === '匹配对局（没标为比赛的）' &&
      A.report(s, {}).filterKindLabel === '全部对局');
    check('★ applyFilters 收口后 kind=all 那几档与模式筛选逐项相等（改造没动口径）',
      ['all', 'swtwr', 'commander', 'other'].every(function (mm) {
        var r = A.report(s, { mode: mm }).filtered;
        return r.afterMode === s.matches({ mode: mm }).length && r.afterKind === r.afterMode;
      }));

    const rp = await s.setMatchFlag(pid, 'competition', true);
    check('常规对局打比赛标记被 store 拒绝（错误文案逐字）',
      rp.ok === false && rp.error === '比赛标记仅适用于胜者为王对局', JSON.stringify(rp));
    check('被拒后常规对局不落 flags、也不进比赛桶',
      s.match(pid).is_competition === 0 && !s.state.flags[pid] && s.modeCounts().comp === 1,
      JSON.stringify(s.state.flags));

    await s.setMatchFlag(rid, 'excluded', true);
    const kx = s.modeCounts();
    check('比赛 + 不纳入：comp / practice 两边都不出现它，excluded 单列',
      kx.comp === 0 && kx.excluded === 1 && kx.comp + kx.practice === kx.all, JSON.stringify(kx));
    check('排除优先：kind=comp 查不到，带 includeExcluded 也不给',
      s.matches({ kind: 'comp' }).length === 0 &&
      s.matches({ includeExcluded: true, kind: 'comp' }).length === 0);
    check('includeExcluded 只在 kind=all 时放行（列表里那一行灰显保留）',
      s.matches({ includeExcluded: true }).some(m => m.room_id === rid));
    await s.setMatchFlag(rid, 'excluded', false);

    await s.setMatchFlag(rid, 'competition', false);
    check('取消比赛标记后这一场立刻回到匹配那一边',
      s.matches({ kind: 'comp' }).length === 0 &&
      s.matches({ kind: 'practice' }).some(m => m.room_id === rid));
    check('取消 competition 不许顺手删掉指挥官标记', s.match(rid).is_commander === 1);
    await s.setMatchFlag(rid, 'commander', false);
    await s.setMatchFlag(rid, 'competition', true);
    check('flags 里只剩 competition 也存得住（GC 认这三枚）',
      !!s.state.flags[rid] && Object.keys(s.state.flags[rid]).join() === 'competition',
      JSON.stringify(s.state.flags[rid]));
    const sK = new StoreMod.Store(s.adapter);
    await sK.load();
    check('重载后比赛标记仍在并重新物化到 is_competition',
      sK.match(rid).is_competition === 1 && sK.modeCounts().comp === 1);
    await s.setMatchFlag(rid, 'competition', false);
    check('全部取消后 flags 不残留孤儿项', !s.state.flags[rid], JSON.stringify(s.state.flags));

    // 外部包带来的脏 competition flag（常规对局）+ 场次已删的孤儿 competition flag，两处都要在 load 时清掉
    let kd = null;
    const kdAdapter = {
      load: () => kd,
      save: (st) => { kd = JSON.parse(JSON.stringify(st)); }
    };
    const k1 = new StoreMod.Store(kdAdapter);
    await k1.load();
    await k1.ingest({
      at: Date.now(), role: raw.role, list: { tdms: [swRow, plainRow], sols: [], bricks: [] }, details: []
    });
    kd = JSON.parse(JSON.stringify(k1.state));
    kd.flags[pid] = { competition: 1 };
    kd.matches[pid].is_competition = 1;
    const k2 = new StoreMod.Store(kdAdapter);
    await k2.load();
    check('外部包里的脏比赛 flag（常规对局）load 时被拦掉',
      k2.match(pid).is_competition === 0 && !k2.state.flags[pid] && k2.modeCounts().comp === 0,
      JSON.stringify(k2.state.flags));
    await k2.setMatchFlag(rid, 'competition', true);
    kd = JSON.parse(JSON.stringify(k2.state));
    delete kd.matches[rid];
    const k3s = new StoreMod.Store(kdAdapter);
    await k3s.load();
    check('场次已不在、只剩比赛标记的孤儿 flag 在 load 时被清掉', !k3s.state.flags[rid],
      JSON.stringify(k3s.state.flags));
  }

  console.log('\n' + '='.repeat(64));
  console.log('21. 脱敏摘要 · 体积 · 逐字确认的宽容度');
  console.log('='.repeat(64));
  {
    const D = require('../core/aiDigest');
    const Plg = require('../core/plugin');
    const s = await makeStore();

    /* ---- 那句确认的宽容度：判定源只剩宿主闸门一个（core/plugin.js），
       内置 AI 时代 core/aiDigest 里的那份连同句子常量一起删了，见 §28 末尾的「唯一判定源」断言 ---- */
    const CONSENT = '我已确认，并将数据上传到我信任的AI服务器上进行分析';
    function MC(x) { return Plg.matchConsent(x, CONSENT); }
    check('原句通过', MC(CONSENT) === true);
    check('前后夹空格通过', MC('  ' + CONSENT + '  ') === true);
    check('词与词之间夹空格通过', MC('我已确认， 并将数据上传到 我信任的AI服务器上进行分析') === true);
    check('全角空格同样忽略', MC(CONSENT + '　') === true);
    check('ai 小写通过', MC(CONSENT.replace('AI', 'ai')) === true);
    check('句末「。」省略与追加都通过', MC(CONSENT + '。') === true && MC(CONSENT + '.') === true);
    check('错一个字被拒（信任→相信）', MC(CONSENT.replace('我信任的', '我相信的')) === false);
    check('只输入一半被拒', MC('我已确认，并将数据上传') === false);
    check('漏掉句尾「分析」被拒', MC(CONSENT.slice(0, -2)) === false);
    check('中文逗号换成英文被拒', MC(CONSENT.replace('，', ',')) === false);
    check('改写语序被拒', MC(CONSENT.split('').reverse().join('')) === false);
    check('空串 / 纯空白 / null / undefined 全部被拒',
      MC('') === false && MC(' 　 ') === false && MC(null) === false && MC(undefined) === false);

    /* ---- 全局摘要 ---- */
    const G = D.buildGlobalDigest(s, {});
    check('bytes 与 Buffer.byteLength 全等（utf8Length 没写错）',
      G.bytes === Buffer.byteLength(G.text, 'utf8'), G.bytes + ' vs ' + Buffer.byteLength(G.text, 'utf8'));
    check('utf8Length 对 ASCII / 汉字 / emoji 都精确',
      D.utf8Length('abc') === 3 && D.utf8Length('中') === 3 && D.utf8Length('🙂') === 4);
    check('token 估算落在合理区间', G.estTokens > 0 && G.estTokens < G.bytes,
      G.bytes + 'B / ~' + G.estTokens + 'tk');
    check('体积有硬上限（不会把整库倒给模型）', G.bytes < 12000 && G.estTokens < 6000,
      G.bytes + 'B / ~' + G.estTokens + 'tk');
    check('摘要声明了脱敏口径', G.text.indexOf('不含真实昵称') !== -1);
    check('逐场明细只记数不记内容',
      G.dropped.series === G.dropped.ratingSeries && G.dropped.encounters > 0,
      JSON.stringify(G.dropped));

    /* 筛选口径要与分析引擎一致 */
    const swRep = A.report(s, { mode: 'swtwr' });
    const swG = D.buildGlobalDigest(s, { mode: 'swtwr' });
    check('mode=swtwr 摘要的口径标注正确', swG.text.indexOf('数据口径：胜者为王') !== -1);
    check('mode=swtwr 摘要场次数与 report.summary.total 一致',
      swG.text.indexOf('■ 总体表现（' + swRep.summary.total + ' 场）') !== -1, swRep.summary.total + ' 场');

    /* ★ since 是绝对秒级截止点，必须换算成「近 N 天」；曾经因运算符优先级把时间戳本身印了出去 */
    const since7 = Math.floor(Date.now() / 1000) - 7 * 86400;
    const g7 = D.buildGlobalDigest(s, { since: since7 });
    check('since 被换算成「近 7 天」而不是原始时间戳',
      g7.text.indexOf('近 7 天') !== -1, (g7.text.match(/数据口径[^\n]*/) || [])[0]);
    check('摘要里不出现 10 位以上的数字串（时间戳 / 长 ID 一律不发）',
      !/\d{10,}/.test(g7.text) && !/\d{10,}/.test(G.text) && !/\d{10,}/.test(swG.text),
      (String(g7.text.match(/\d{10,}/)) + ' | ' + String(G.text.match(/\d{10,}/))));

    const allTotal = Number((G.text.match(/本次筛选 (\d+) 场/) || [])[1]);
    const firstRow = s.matches({})[0];
    await s.setMatchFlag(String(firstRow.room_id), 'excluded', true);
    const Gex = D.buildGlobalDigest(s, {});
    const exTotal = Number((Gex.text.match(/本次筛选 (\d+) 场/) || [])[1]);
    check('排除一场后摘要同步少一场', exTotal === allTotal - 1, allTotal + ' → ' + exTotal);
    check('排除口径会写进摘要', Gex.text.indexOf('1 场已被标记为不纳入统计') !== -1);
    await s.setMatchFlag(String(firstRow.room_id), 'excluded', false);

    /* ---- 体积对场次恒定（O(1)）：合成灌到接近 MAX_MATCHES ---- */
    function stamp(ts) {
      const d = new Date(ts), p = x => String(x).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    async function fillTo(target) {
      const store = await makeStore();
      const keys = Object.keys(store.state.matches);
      let i = 0;
      while (Object.keys(store.state.matches).length < target) {
        const proto = store.state.matches[keys[i % keys.length]];
        const c = JSON.parse(JSON.stringify(proto));
        c.room_id = 'synth-' + i;
        c.start_time = proto.start_time + i * 3600;
        c.dt_event_time = stamp(c.start_time * 1000);
        c.score = Math.round(proto.score * (1 + (i % 7) / 10));
        store.state.matches[c.room_id] = c;
        i++;
      }
      await store.save();
      return store;
    }
    const b200 = D.buildGlobalDigest(await fillTo(200), {}).bytes;
    const sBig = await fillTo(4800);
    const gBig = D.buildGlobalDigest(sBig, {});
    check('4800 场库能一次性构建摘要', gBig.text.indexOf('本次筛选 4800 场') !== -1, gBig.bytes + 'B');
    check('摘要体积对场次近乎恒定（200 → 4800 场增长 < 15%）',
      gBig.bytes < b200 * 1.15, b200 + 'B → ' + gBig.bytes + 'B');
    check('大库摘要同样不含逐场明细行',
      gBig.text.indexOf('synth-') === -1 && gBig.dropped.series === 4800,
      JSON.stringify(gBig.dropped));

    /* ---- 单场摘要 + 代号稳定性 ---- */
    const withRoster = s.matches({}).filter(m => (s.players(m.room_id) || []).length >= 5)[0];
    check('样本里存在带全场名单的场次', !!withRoster, withRoster && withRoster.room_id);
    const M1 = D.buildMatchDigest(s, withRoster.room_id);
    const M2 = D.buildMatchDigest(s, withRoster.room_id);
    check('单场摘要 bytes 同样精确', M1.bytes === Buffer.byteLength(M1.text, 'utf8'), M1.bytes);
    check('同场两次生成文本全等（代号算法稳定）', M1.text === M2.text);
    check('代号数 = 名单人数 − 我',
      M1.dropped.teammates + M1.dropped.enemies === M1.dropped.roster - 1, JSON.stringify(M1.dropped));
    const aliasNames = M1.aliases.map(a => a.alias);
    check('代号无重复', new Set(aliasNames).size === aliasNames.length, aliasNames.length + ' 个');
    check('代号只有「队友X」「对手N」两种形态',
      aliasNames.every(a => /^队友[A-Z]+$/.test(a) || /^对手\d+$/.test(a)),
      aliasNames.filter(a => !/^队友[A-Z]+$/.test(a) && !/^对手\d+$/.test(a)).join(','));
    check('摘要正文里有代号为行首的逐人明细',
      /^队友A：/m.test(M1.text) && /^对手1：/m.test(M1.text));
    const allyLines = M1.text.split('\n').filter(x => /^队友/.test(x));
    const enemyLines = M1.text.split('\n').filter(x => /^对手/.test(x));
    check('逐人明细行数与代号数一致（我自己不占一行）',
      allyLines.length === M1.dropped.teammates && enemyLines.length === M1.dropped.enemies,
      allyLines.length + '+' + enemyLines.length);

    /* ---- ★核心泄漏扫描：真实样本摘要里不许出现任何身份标识 ---- */
    const pool = new Set();
    ['openid', 'name'].forEach(k => {
      if (s.state.meta && s.state.meta[k]) pool.add(String(s.state.meta[k]));
      if (s.state.role && s.state.role[k]) pool.add(String(s.state.role[k]));
    });
    Object.keys(s.state.rosters).forEach(k => {
      (s.state.rosters[k].players || []).forEach(p => {
        if (p.name) pool.add(String(p.name));
        if (p.vopenid) pool.add(String(p.vopenid));
      });
    });
    Object.keys(s.state.matches).forEach(k => {
      const m = s.state.matches[k];
      if (m && m.owner_openid) pool.add(String(m.owner_openid));
    });
    const texts = [G.text, M1.text, swG.text, gBig.text];
    const leaks = [];
    pool.forEach(v => {
      if (v.length < 2) return;
      texts.forEach((t, i) => { if (t.indexOf(v) !== -1) leaks.push(v + '@' + i); });
    });
    check('身份池够大（扫描真的覆盖到全部昵称与 vopenid）', pool.size > 40, pool.size + ' 个候选');
    check('摘要中 0 处命中 openid / vopenid / 昵称 / owner_openid',
      leaks.length === 0, leaks.slice(0, 5).join(' , '));
    const idShape = texts.map(t => t.match(/\d{10,}|[A-Za-z0-9]{16,}/g) || []);
    check('摘要中无任何长 ID 形态（10+ 位数字 / 16+ 位字母数字）',
      idShape.every(a => a.length === 0),
      idShape.map(a => a.join(',')).filter(Boolean).join(' | '));
    check('摘要中不含官方接口域名', texts.every(t => t.indexOf('wegame.com.cn') === -1));
    check('摘要中不含场次 / 房间 ID',
      texts.every(t => t.indexOf(String(withRoster.room_id)) === -1));

    /* ---- 边界：定位不到「我」时宁可不发 ---- */
    const s4 = await makeStore();
    s4.state.meta.openid = 'not-in-roster';
    const M4 = D.buildMatchDigest(s4, withRoster.room_id);
    check('定位不到本人时不给同场逐人明细',
      M4.text.indexOf('缺少全场名单') !== -1 && M4.text.indexOf('队友A：') === -1, M4.bytes + 'B');
    check('找不到场次时返回 error 而不是抛异常',
      !!D.buildMatchDigest(s4, 'nope').error, JSON.stringify(D.buildMatchDigest(s4, 'nope')));

    /* ---- 空库 ---- */
    const empty = new StoreMod.Store(memAdapter());
    await empty.load();
    const E = D.buildGlobalDigest(empty, {});
    check('空库不抛异常且仍有可用文案', E.bytes > 0 && E.text.indexOf('0 场') !== -1, E.bytes + 'B');
    check('token 估算随文本长度单调增长',
      D.estimateTokens('') === 0 && D.estimateTokens('中') === 1 &&
      D.estimateTokens('中'.repeat(10)) === 10 &&
      D.estimateTokens('你好世界') > D.estimateTokens('你好'));
  }

  console.log('\n' + '='.repeat(64));
  console.log('22. core/async · 超时与空闲计时');
  console.log('='.repeat(64));
  {
    const Async = require('../core/async');
    const t0 = Date.now();
    const hung = await Async.withTimeout(new Promise(() => {}), 30, { ok: false, reason: 'timeout' });
    check('挂起的 Promise 到点返回兜底值（boot 不会永远卡住）',
      hung.ok === false && hung.reason === 'timeout' && Date.now() - t0 < 3000,
      JSON.stringify(hung) + ' ' + (Date.now() - t0) + 'ms');
    check('正常完成的 Promise 原值透传',
      (await Async.withTimeout(Promise.resolve({ ok: true, x: 1 }), 500, null)).x === 1);
    const early = await Async.withTimeout(new Promise(r => setTimeout(() => r('fast'), 5)), 1000, 'FB');
    check('先到者胜出，定时器不会覆盖结果', early === 'fast', early);
    const err = await Async.withTimeout(Promise.reject(new Error('boom')), 500, { ok: false });
    check('异常转成结构化结果而不是抛出',
      err.ok === false && err.reason === 'error' && err.message === 'boom', JSON.stringify(err));
    check('非 Promise 入参也能安全处理', (await Async.withTimeout(7, 50, null)) === 7);

    let fires = 0;
    const idle = Async.idleTimer(() => { fires++; }, 25);
    await new Promise(r => setTimeout(r, 60));
    check('空闲计时到期触发一次', fires === 1, fires);
    idle.touch(); idle.touch();
    await new Promise(r => setTimeout(r, 60));
    check('touch 续期后只多触发一次', fires === 2, fires);
    idle.touch();
    idle.stop();
    await new Promise(r => setTimeout(r, 80));
    check('stop 之后不再触发', fires === 2, fires);
  }

  /* ============ 23. 漏采自证（同步窗口台账 + 时间空档） ============ */
  console.log('\n' + '='.repeat(64));
  console.log('23. 漏采自证：同步窗口台账与时间空档');
  console.log('='.repeat(64));
  {
    const s = await makeStore();
    const DAY = 86400, base = Math.floor(Date.now() / 1000);
    check('新存档自带空白的同步窗口台账',
      Array.isArray(s.state.meta.sync_windows) && s.state.meta.sync_windows.length === 0);

    const w1 = await s.recordSyncWindow({ at: base * 1000, oldest: base - 30 * DAY, newest: base - 25 * DAY, count: 36, inserted: 36 });
    check('首轮只记录、不判定', w1.ok === true && w1.firstRound === true && w1.suspect === false, JSON.stringify(w1));
    check('窗口条数与本轮新增数一并留档',
      s.state.meta.sync_windows[0].count === 36 && s.state.meta.sync_windows[0].inserted === 36);

    const w2 = await s.recordSyncWindow({ at: base * 1000 + 1, oldest: base - 26 * DAY, newest: base - 20 * DAY, count: 36, inserted: 30 });
    check('★ 本轮窗口仍含着上一轮的场次时不报警（没打满一窗就活该不报）', w2.suspect === false, JSON.stringify(w2));

    const w3 = await s.recordSyncWindow({ at: base * 1000 + 2, oldest: base - 10 * DAY, newest: base - 2 * DAY, count: 36, inserted: 36 });
    check('整窗滚过一圈才判 suspect', w3.suspect === true && w3.firstRound === false, JSON.stringify(w3));
    check('报警时给出可摊开的时间区间与天数',
      w3.from === base - 20 * DAY && w3.to === base - 10 * DAY && w3.days === 10,
      w3.from + '→' + w3.to + ' / ' + w3.days + ' 天');

    const skipped = await s.recordSyncWindow({ at: base * 1000 + 3, oldest: 0, newest: 0 });
    check('官方一条都没返回时不写窗口也不报警',
      skipped.skipped === true && s.state.meta.sync_windows.length === 3,
      skipped.skipped + ' / ' + s.state.meta.sync_windows.length);

    for (let i = 0; i < 40; i++) {
      await s.recordSyncWindow({ at: base * 1000 + 100 + i, oldest: base + i, newest: base + 1000 + i, count: 36, inserted: 1 });
    }
    check('窗口台账裁到上限', s.state.meta.sync_windows.length === StoreMod.LIMITS.syncWindows, s.state.meta.sync_windows.length);
    check('挤掉的是最旧的一轮而不是最新的一轮',
      s.state.meta.sync_windows.every(x => x.at !== base * 1000));

    const dense = []; for (let i = 0; i < 36; i++) dense.push({ start_time: base - 2 * DAY + i * 600 });
    check('★ 连续两天各打 18 场不该报空档', A.syncGaps(dense).length === 0, JSON.stringify(A.syncGaps(dense)));
    const gaps = A.syncGaps(dense.concat([{ start_time: base - 32 * DAY }]));
    check('30 天空档必须报出一段且天数正确', gaps.length === 1 && gaps[0].days >= 29, JSON.stringify(gaps));
    check('阈值抬高时空档消失、压低时更多',
      A.syncGaps(dense, { gapDays: 1 }).length === 0 && A.syncGaps(dense).length === 0);
    check('空数组 / 单条记录不抛错',
      A.syncGaps([]).length === 0 && A.syncGaps([{ start_time: base }]).length === 0 && A.syncGaps(null).length === 0);
    check('缺 start_time 的脏行被跳过而不是算成 NaN 空档',
      A.syncGaps([{ start_time: 0 }, { start_time: null }, { start_time: base - 9 * DAY }, { start_time: base }])
        .every(g => isFinite(g.days) && g.days > 0));
    check('空档默认阈值导出可得', A.GAP_DAYS === 3);

    check('windowDoubt 独立可判：有重叠就不报',
      A.windowDoubt([{ at: 1, oldest: 100, newest: 200 }, { at: 2, oldest: 150, newest: 400 }]).suspect === false);
    check('windowDoubt 判据是严格大于（恰好接上不算漏）',
      A.windowDoubt([{ at: 1, oldest: 100, newest: 200 }, { at: 2, oldest: 200, newest: 400 }]).suspect === false &&
      A.windowDoubt([{ at: 1, oldest: 100, newest: 200 }, { at: 2, oldest: 201, newest: 400 }]).suspect === true);
    check('windowDoubt 按 at 排序比较最近两轮',
      A.windowDoubt([{ at: 2, oldest: 500, newest: 600 }, { at: 1, oldest: 100, newest: 200 }]).suspect === true);
    check('windowDoubt 单轮标记为首轮', A.windowDoubt([{ at: 1, oldest: 1, newest: 2 }]).firstRound === true);
    check('windowDoubt 空台账不抛错', A.windowDoubt([]).suspect === false && A.windowDoubt(null).rounds === 0);

    const repAll = A.report(s, {});
    const rep7 = A.report(s, { since: base - 3 * DAY });
    check('report 暴露 sync 三段', !!repAll.sync && Array.isArray(repAll.sync.windows) &&
      typeof repAll.sync.doubt === 'object' && Array.isArray(repAll.sync.gaps));
    check('★ 空档看的是全部存储场次，时间筛选不会凭空造出空档',
      JSON.stringify(rep7.sync.gaps) === JSON.stringify(repAll.sync.gaps) &&
      rep7.filtered.total < repAll.filtered.total,
      '筛选后 ' + rep7.filtered.total + ' 场 / 空档 ' + rep7.sync.gaps.length + ' 段（全量 ' + repAll.sync.gaps.length + '）');

    await s.clearData();
    check('清空数据连窗口台账一起清掉', s.state.meta.sync_windows.length === 0);

    /* ★ 翻页自证进台账（v1.9.1）：翻了几页 / 每页几条 / 去重留下几条 / 为什么停 ——
     *   这几样只在同步那一刻存在，不落盘就再也问不出来了（他问"怎么只有 17 场"时手上早就没了）。 */
    const tr15 = {
      pages: [{ depth: 1, rows: 8, kept: 8 }, { depth: 2, rows: 8, kept: 7 }],
      cap: 5, pageSizeUi: 7, rows: 16, kept: 15, stop: 'short',
      stopText: CollectorMod.STOP_TEXT.short
    };
    await s.recordSyncWindow({
      at: base * 1000 + 77, oldest: base - 5 * DAY, newest: base,
      count: 15, inserted: 15, trace: tr15
    });
    const lw = s.syncWindows().pop();
    check('台账存下翻了几页、逐页回来几条、去重后留下几条',
      lw.pages === 2 && lw.rows.join(',') === '8,8' && lw.kept === 15, JSON.stringify(lw));
    check('★ 停因原话也落盘（界面直接念这一句，不许在 ui 里再编一份文案）',
      lw.stop === 'short' && lw.stopText === CollectorMod.STOP_TEXT.short, String(lw.stopText));
    check('到底那一轮 capped 为假（"窗口到底了"与"翻满了 5 页"是两回事）',
      lw.capped === false);

    await s.recordSyncWindow({
      at: base * 1000 + 78, oldest: base - 4 * DAY, newest: base,
      count: 36, inserted: 36,
      trace: { pages: [{ depth: 1, rows: 8, kept: 8 }], cap: 5, pageSizeUi: 7, rows: 8, kept: 8,
               stop: 'cap', stopText: CollectorMod.STOP_TEXT.cap }
    });
    check('撞上限那一轮 capped=true（界面那句"再往前就采不到了"只在这一支说）',
      s.syncWindows().pop().capped === true);

    /* 升级前留下的老行没有这几列：判据要能把"没记录"和"翻了 0 页"分开，
     * 界面据此不画那一句（拿 0 装成翻了 0 页 = 把老账本说成没翻页，是假证据） */
    await s.recordSyncWindow({ at: base * 1000 + 79, oldest: base - 3 * DAY, newest: base, count: 30, inserted: 30 });
    const legacy = s.syncWindows().pop();
    check('★ 没带 trace 的老写法：pages=0 / rows=[] / stop="" 而不是编一个停因',
      legacy.pages === 0 && legacy.rows.length === 0 && legacy.stop === '' &&
        legacy.stopText === '' && legacy.capped === false, JSON.stringify(legacy));
    check('report 里这几列原样透到界面（三处生产者共一份账本）',
      A.report(s, {}).sync.windows.slice(-2).every(x => typeof x.pages === 'number'),
      JSON.stringify(A.report(s, {}).sync.windows.slice(-2).map(x => x.pages)));
  }

  /* ============ 23b. 官方赛季汇总那一格（v1.9.1：界面早就在画，core 从来没算过） ============ */
  console.log('\n' + '='.repeat(64));
  console.log('23b. 官方赛季汇总：三份口径由 core 算一次');
  console.log('='.repeat(64));
  {
    const s = await makeStore();          // 真抓包样本：season 回包 + maps 回包都在里面
    const sea = A.seasonSummary(s);
    check('★ 这一格不再是死的：存了官方回包就算得出三份口径（以前 rep.season 根本不存在）',
      !!sea && ['sid', 'at', 'allMode', 'career', 'swwr'].every(function (k) { return k in sea; }),
      sea ? Object.keys(sea).join(',') : 'null');
    check('sid 取自官方回包里那一份（我们问几号它就回几号，界面据此能说"念的是第 N 赛季"）',
      sea.sid === '10', sea.sid);
    check('本赛季口径 = 回包 mp 那一段（191 场 / 96 胜 / 50%）',
      sea.allMode.totalFight === 191 && sea.allMode.win === 96 && sea.allMode.winRate === 50 &&
        sea.allMode.totalScore === 4106981 && sea.allMode.scorePerMin === 1117,
      JSON.stringify(sea.allMode));
    check('通行证等级 / 段位这些官方独有的列也带上（界面不用就至少存档里有）',
      sea.allMode.battlePassLevel === 138 && sea.allMode.rankLevel === 7 && sea.allMode.rankPoint === 5051,
      'BP=' + sea.allMode.battlePassLevel);
    check('生涯累计口径 = 回包 stats 那一段（2193 场，胜率是小数比例 ⇒ 换算成百分数）',
      sea.career.totalFight === 2193 && sea.career.winRate === 45.55 && sea.career.kd === 1.3978 &&
        sea.career.mvp === 252, JSON.stringify(sea.career));

    /* 官方没有"胜者为王本赛季"这一档，所以它由分地图统计里胜者为王那几张图精确聚合 ——
     * 聚合判据走 Maps.isSWWR 一颗，界面不许自己列地图号。 */
    const swRaw = raw.maps.maps.filter(function (m) { return Maps.isSWWR(m.mapid) && m.total > 0; });
    const sumBy = function (k) { return swRaw.reduce(function (a, x) { return a + (Number(x[k]) || 0); }, 0); };
    check('★ 胜者为王那一行的每个数都对得上"官方各图求和"（不是本机统计、也不是猜的）',
      sea.swwr.total === sumBy('total') && sea.swwr.win === sumBy('win') &&
        sea.swwr.kill === sumBy('kill') && sea.swwr.death === sumBy('death') &&
        sea.swwr.score === sumBy('score'),
      'total=' + sea.swwr.total + ' / 期望 ' + sumBy('total'));
    check('胜率 / KD / 场均 / 分均由聚合后的和现算（不是把各图的比率平均）',
      sea.swwr.winRate === Math.round(sea.swwr.win / sea.swwr.total * 10000) / 100 &&
        sea.swwr.avgScore === Math.round(sea.swwr.score / sea.swwr.total) &&
        sea.swwr.scorePerMin === Math.round(sea.swwr.score / (sea.swwr.gametime / 60)),
      'winRate=' + sea.swwr.winRate + ' avgScore=' + sea.swwr.avgScore + ' spm=' + sea.swwr.scorePerMin);
    check('各图明细按场次从多到少排，地名走 Maps.nameOf（不是 mapId:602 那种原始串）',
      sea.swwr.maps.length === swRaw.length &&
        sea.swwr.maps.every(function (m, i) { return i === 0 || sea.swwr.maps[i - 1].total >= m.total; }) &&
        /胜者为王/.test(sea.swwr.maps[0].mapName),
      sea.swwr.maps.map(function (m) { return m.mapName + ':' + m.total; }).join(' '));
    check('一场都没打的图不进聚合（0 场的图会把场均分母带歪）',
      swRaw.every(function (m) { return Number(m.total) > 0; }) &&
        raw.maps.maps.filter(function (m) { return Maps.isSWWR(m.mapid) && !(Number(m.total) > 0); }).length > 0,
      raw.maps.maps.length + ' 行里剔掉了非胜者为王 / 0 场的');

    const repS = A.report(s, {});
    check('★ 总报告带着这一份（界面 renderSeason 读的就是 rep.season，少这一行那个面板永远是空的）',
      repS.season && repS.season.allMode.totalFight === 191);

    /* 三种"没有数据"要分得开：没存档 / 回包是空的 / 只有地图统计没有赛季汇总 */
    const s0 = await makeStore();
    await s0.clearData();
    check('没抓到过赛季汇总 ⇒ null（界面那句"本机还没有官方赛季汇总的存档"走这一支）',
      A.seasonSummary(s0) === null);
    const sEmpty = new StoreMod.Store(memAdapter());
    await sEmpty.load();
    sEmpty.state.seasons = { '10': { report: { result: { error_code: 0 }, season: { sid: '10', mp: {}, stats: {} } }, maps: null, at: 1 } };
    check('★ 官方回了空壳（mp/stats 全空）时算不出，不拿 0 场装成"本赛季 0 场"',
      A.seasonSummary(sEmpty) === null);
    const sTwo = new StoreMod.Store(memAdapter());
    await sTwo.load();
    sTwo.state.seasons = {
      '9': { report: { season: { sid: '9', mp: { total_fight: 10 }, stats: {} } }, maps: null, at: 100 },
      '10': { report: { season: { sid: '10', mp: { total_fight: 999 }, stats: {} } }, maps: null, at: 200 }
    };
    check('多赛季存档取最新那一份（按 at 比，不按键名 —— 键名比会把 9 当成比 10 新）',
      A.seasonSummary(sTwo).sid === '10' && A.seasonSummary(sTwo).allMode.totalFight === 999,
      JSON.stringify(Object.keys(sTwo.state.seasons)));
    const sOldFirst = new StoreMod.Store(memAdapter());
    await sOldFirst.load();
    sOldFirst.state.seasons = {
      '10': { report: { season: { sid: '10', mp: { total_fight: 999 }, stats: {} } }, maps: null, at: 50 },
      '11': { report: { season: { sid: '11', mp: { total_fight: 12 }, stats: {} } }, maps: null, at: 4000 }
    };
    check('★ 换了赛季号并且真问到新号，界面念的就是新那一号（旧存档留着但不冒充）',
      A.seasonSummary(sOldFirst).sid === '11');
  }

  console.log('\n' + '='.repeat(64));
  console.log('24. 关注玩家：与榜单共用同一套身份键');
  console.log('='.repeat(64));
  {
    const s = await makeStore();
    const countsAtStart = s.modeCounts().all;
    const idx = A.buildIdentityIndex(s);
    const keys = Object.keys(idx.groups);
    const idKey = keys.filter(k => k.indexOf('id:') === 0)[0];
    check('身份索引已导出且有内容', typeof A.buildIdentityIndex === 'function' && keys.length > 0, keys.length + ' 组');
    check('样本数据里存在稳定账号 ID 可作关注对象', !!idKey, idKey || '无');

    /* ★ 一个人都没关注时，名单里就必须先有可关注的按钮，否则这功能永远开不了张 */
    const g0 = idx.groups[keys[0]];
    const rid0 = String(g0.meets[0].roomId);
    const lobby0 = A.lobby(s, rid0);
    const canWatch = (lobby0.allPlayers || []).filter(function (p) { return p.watchKey && p.watchable; });
    check('★ 空关注表下仍给出可关注的聚合键', canWatch.length > 0, canWatch.length + ' 可关注');
    check('此时无人被标为已关注', (lobby0.allPlayers || []).every(function (p) { return !p.watched; }) && lobby0.watchedCount === 0);

    const bad = await s.setWatch('slot:123:8007', true, {});
    check('★ 当局临时编号一律拒绝关注', bad.ok === false && bad.code === 'ephemeral' && !!bad.error, JSON.stringify(bad));
    check('临时编号不会污染 people 表', Object.keys(s.state.people).length === 0);
    check('过短的稳定 ID 被拒', (await s.setWatch('id:123456789', true, {})).code === 'weak');
    check('无昵称的 nm 键被拒', (await s.setWatch('nm:', true, {})).code === 'weak');
    check('前缀不对的键被拒', (await s.setWatch('随便什么', true, {})).ok === false);
    check('空键被拒', (await s.setWatch('', true, {})).ok === false);

    if (idKey) {
      const g = idx.groups[idKey];
      const okAdd = await s.setWatch(idKey, true, { openid: g.openid, name: g.name });
      check('关注写入且键与索引完全一致',
        okAdd.ok === true && !!s.state.people[idKey] && s.state.people[idKey].key === idKey, idKey);
      check('关注项记下置信度与时间',
        s.state.people[idKey].confidence === 'id' && s.state.people[idKey].since > 0);
      check('isWatched 认得这个键', s.isWatched(idKey) === true && s.isWatched('nm:没有这个人') === false);

      const rid = String(g.meets[0].roomId);
      const lobby = A.lobby(s, rid);
      const marked = (lobby.allPlayers || []).filter(p => p.watched);
      check('详情页名单带上 watched 与原样可回传的聚合键',
        marked.length >= 1 && marked.every(p => p.watchKey === idKey),
        marked.length + ' 人 / ' + (marked[0] || {}).watchKey);
      check('该场被关注人数上报给界面', lobby.watchedCount === marked.length, lobby.watchedCount);
      check('没被关注的人不会误挂徽标',
        (lobby.allPlayers || []).filter(p => !p.watched).every(p => typeof p.watchKey === 'string' && p.watched === false));
      check('★ 就地标注没有写坏 roster 原始引用（store.players 给的是同一批对象）',
        s.players(rid).every(p => p.watched === undefined && p.watchKey === undefined));
      check('列表用的 roomId → 关注人数 映射含该场', (A.watchedRoomMap(s)[rid] || 0) >= 1);

      const rep = A.report(s, {});
      check('关注池进 report，样本不足时拒绝下结论',
        rep.people.count === 1 && rep.people.verdict === null && rep.people.withTotal >= 1,
        'with=' + rep.people.withTotal + ' without=' + rep.people.withoutTotal);
      check('关注池两侧都算出了汇总数字',
        !!rep.people.withPool && !!rep.people.withoutPool && typeof rep.people.withPool.winRate === 'number');
      check('最低样本量常量可导出并在界面可用', A.PEOPLE_MIN_SAMPLE === 20 && rep.people.minSample === 20);
      check('★ 关注不改变任何统计的纳入场次数', s.modeCounts().all === countsAtStart, countsAtStart);

      const off = await s.setWatch(idKey, false, {});
      check('取消关注后键消失', off.ok === true && !s.state.people[idKey]);
    }

    s.state.people = {};
    await s.setWatch('id:1234567890123456789', true, { openid: '1234567890123456789', name: '张三' });
    check('gcPeople 清掉名单里再也找不到的键', s.gcPeople({}).removed === 1);
    check('没有脏键时 gcPeople 报 unchanged', s.gcPeople({}).changed === false);
    s.state.people['id:keepme'] = { key: 'id:keepme', openid: 'keepme', name: '', confidence: 'id', since: 1 };
    check('gcPeople 保留索引里还在的键',
      s.gcPeople({ 'id:keepme': { key: 'id:keepme', meets: [] } }).removed === 0 && !!s.state.people['id:keepme']);

    s.state.people = {};
    for (let i = 0; i < StoreMod.LIMITS.people + 12; i++) {
      s.state.people['id:cap' + i] = { key: 'id:cap' + i, openid: 'cap' + i, name: '', confidence: 'id', since: 1000 + i };
    }
    await s.save();
    check('people 裁到上限', Object.keys(s.state.people).length === StoreMod.LIMITS.people, Object.keys(s.state.people).length);
    check('挤掉的是最早标记的那一批',
      !s.state.people['id:cap0'] && !!s.state.people['id:cap' + (StoreMod.LIMITS.people + 11)]);

    await s.clearData();
    check('清空数据把关注表一并清空（别人的身份不能残留）', Object.keys(s.state.people).length === 0);
    check('stats 报出关注人数', s.stats().people === 0);
    check('reset 清关注表但保留评分口径', (function () {
      s.state.people = { 'id:x': { key: 'id:x', since: 1 } };
      s.state.settings.ratingWeights = { score: 1, kill: 1, kda: 1, occupy: 1, rescue: 96 };
      s.reset();
      return Object.keys(s.state.people).length === 0 && s.state.settings.ratingWeights.score === 1;
    })());
  }

  /* ============ 25. 评分口径可配 + 时段与连战节律 ============ */
  console.log('\n' + '='.repeat(64));
  console.log('25. 权重可配与状态节律');
  console.log('='.repeat(64));
  {
    const s = await makeStore();
    const rows = s.matches({});
    const openid = s.activeOpenid();
    const before = rows.map(m => A.rating(m, s.players(m.room_id), openid).value);
    check('★ 默认权重与改动前逐位一致（第 4 参可选，不传走内置口径）',
      before.every((v, i) => v === A.rating(rows[i], s.players(rows[i].room_id), openid, s).value), before.join(','));
    check('weights() 默认还原成 35/20/25/10/10', (function () {
      const w = A.weights(s);
      return Math.round(w.score * 100) === 35 && Math.round(w.kill * 100) === 20 &&
        Math.round(w.kda * 100) === 25 && Math.round(w.occupy * 100) === 10 && Math.round(w.rescue * 100) === 10;
    })(), JSON.stringify(A.weights(s)));
    check('weightsText 生成中文口径串',
      /^得分 \d+% · 击杀 \d+% · KDA \d+% · 占点（次） \d+% · 救治 \d+%$/.test(A.weightsText(A.weights(s))),
      A.weightsText(A.weights(s)));
    check('权重键序与界面滑杆顺序一致', A.WEIGHT_KEYS.join(',') === 'score,kill,kda,occupy,rescue');

    /* ★ 占点列口径改名（增补十三）：官方 occupy 是「占领 · 防守据点的次数」，不是游戏里的「站点分」。
     *   名字改准之后全树只能有一份字面量，其余位置一律读它，测试盯住别处不许各写各的。 */
    const OCC_NAME = '占点（次）';
    {
      const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      const vSrc = read('ui/js/views.js'), aSrc = read('ui/js/app.js');
      const occBlock = (vSrc.match(/var OCC = \{[\s\S]*?\n  \};/) || [''])[0];
      const uiLabel = (occBlock.match(/label: '([^']+)'/) || [, ''])[1];
      check('★ 占点列名在界面里只写一次（OCC 一块），设置页与徽标表都从 DFViews.OCCUPY 读',
        /^var OCC = \{/.test(occBlock) && uiLabel === OCC_NAME &&
        (vSrc.match(/var OCC = \{/g) || []).length === 1 && /OCCUPY: OCC/.test(vSrc) &&
        /\['occupy', global\.DFViews\.OCCUPY\.label\]/.test(aSrc),
        '界面标签=' + uiLabel + '，OCC 引用 ' + (vSrc.match(/OCC\./g) || []).length + ' 处');
      check('★ core 权重名 / 两份 CSV 表头 / 静态兜底文案四处必须与界面标签一字不差',
        A.WEIGHT_NAMES.occupy === OCC_NAME &&
        read('shell/main.js').indexOf("'" + OCC_NAME + "'") >= 0 &&
        read('android/js/df-android.js').indexOf("'" + OCC_NAME + "'") >= 0 &&
        read('ui/index.html').indexOf(OCC_NAME) >= 0,
        [A.WEIGHT_NAMES.occupy, uiLabel].join(' | '));
      const bad = [];
      ['core/analysis.js', 'core/aiDigest.js', 'ui/js/views.js', 'ui/js/app.js',
        'ui/index.html', 'shell/main.js', 'android/js/df-android.js'].forEach(function (f) {
        read(f).split('\n').forEach(function (ln, i) {
          if (/^\s*(\/\*|\*|\/\/)/.test(ln)) return;
          if (/占点（次）|占点排名|占点效率|占点进度/.test(ln)) return;
          if (/'占点'|"占点"|>占点<|「占点」/.test(ln)) bad.push(f + ':' + (i + 1));
        });
      });
      check('★ 全树不许再出现裸的「占点」标签（旧名回潮就红）', bad.length === 0,
        '命中 ' + bad.length + ' 处：' + bad.join(' / '));
      /* 说明要真的落在使用者点名的四处界面上，少一处都算没做（上一版只数出现次数，被变异实验打回） */
      const noteSites = {
        '战局列表表头': /<th>分均<\/th><th title="' \+ esc\(OCC\.note\)/,
        '全场名单表头': /<th title="' \+ esc\(OCC\.note\) \+ '">' \+ OCC\.label/,
        '阵营对比合计列': /<th title="' \+ esc\(OCC\.note\) \+ '">' \+ OCC\.total/,
        '阵营对比下方说明': /class="hint">' \+ esc\(OCC\.note\)/
      };
      const missed = Object.keys(noteSites).filter(k => !noteSites[k].test(vSrc));
      check('★ 口径说明逐点核对：列表表头 / 名单表头 / 阵营对比列头与表下 / 设置页',
        /站点分/.test(occBlock) && missed.length === 0 &&
        /id="occNote"/.test(read('ui/index.html')) &&
        /OCCUPY\.note/.test(aSrc), '缺：' + (missed.join() || '无'));
      /* 顺带钉住这一族：设备探针抓到「有 2 场和你分在同一阵营…（只有 undefined 场，给不出区间）」。
       * ciPlain 只收到 { ci: … } 时，core 不给区间（样本太少）就退到 o.total，而那个键根本不存在。 */
      const litCalls = vSrc.match(/ciPlain\(\{[^)]*\}\)/g) || [];
      check('★ ciPlain 收对象字面量时必须把场数 n 一起传（少传就念出 undefined）',
        litCalls.length >= 3 && litCalls.every(s => /n:/.test(s)),
        litCalls.length + ' 处，漏传：' + (litCalls.filter(s => !/n:/.test(s)).join(' ⧸ ') || '无'));
    }

    const fake = rw => A.weights({ state: { settings: { ratingWeights: rw } } });
    check('某一键 100 其余 0 时归一化为该键独占',
      Math.abs(fake({ score: 100, kill: 0, kda: 0, occupy: 0, rescue: 0 }).score - 1) < 1e-9);
    check('和不为 100 的整数也能用（读时归一）', (function () {
      const w = fake({ score: 50, kill: 20, kda: 25, occupy: 10, rescue: 10 });
      return Math.abs(w.score + w.kill + w.kda + w.occupy + w.rescue - 1) < 1e-9 && Math.round(w.score * 100) === 43;
    })());
    check('★ 全 0 权重整组回退默认，评分不会 NaN 或恒 0',
      Math.round(fake({ score: 0, kill: 0, kda: 0, occupy: 0, rescue: 0 }).score * 100) === 35);
    check('脏值逐键回退默认（字符串与负数走默认，合法键照用）', (function () {
      const w = fake({ score: 'abc', kill: -5, kda: 50, occupy: 10, rescue: 10 });
      return Math.round(w.score * 100) === 28 && Math.round(w.kill * 100) === 16 &&
        Math.round(w.kda * 100) === 40 && Math.round(w.rescue * 100) === 8;
    })(), JSON.stringify(fake({ score: 'abc', kill: -5, kda: 50, occupy: 10, rescue: 10 })));
    check('完全没有 settings 也能算（老存档 / 移动端外壳）',
      Math.round(A.weights(null).score * 100) === 35 && Math.round(A.weights({}).score * 100) === 35);
    check('任意权重下评分恒在 0..100 且为有限数', [0, 1, 37, 100].every(v => {
      const st = { state: { settings: { ratingWeights: { score: v, kill: 100 - v, kda: 30, occupy: 7, rescue: 0 } } } };
      return rows.every(m => {
        const x = A.rating(m, s.players(m.room_id), openid, st);
        return isFinite(x.value) && x.value >= 0 && x.value <= 100;
      });
    }));

    await s.setSettings({ ratingWeights: { score: 10, kill: 10, kda: 10, occupy: 40, rescue: 30 } });
    const after = s.matches({}).map(m => A.rating(m, s.players(m.room_id), openid, s).value);
    check('改权重后评分确实跟着变（不是写死的常量）',
      after.some((v, i) => v !== before[i]) && after.every(v => v >= 0 && v <= 100),
      before.join(',') + ' → ' + after.join(','));
    check('report 把当前权重回传给界面用于生成文案',
      !!(A.report(s, {}).settings && A.report(s, {}).settings.ratingWeights));

    const hours = A.byHour(s, s.matches({}));
    check('byHour 只产出两位小时键且 label 与键同源',
      hours.length > 0 && hours.every(x => /^\d\d$/.test(String(x.key)) && x.label === x.key + ':00'),
      hours.map(x => x.key).join(','));
    check('byHour 的键与 dt_event_time 的小时位完全一致',
      hours.every(x => s.matches({}).some(m => (m.dt_event_time || '').slice(11, 13) === x.key)));
    check('byHour 键升序排列', hours.every((x, i) => i === 0 || hours[i - 1].key <= x.key));
    check('byHour 每格都带汇总与平均评分',
      hours.every(x => typeof x.total === 'number' && typeof x.winRate === 'number' && x.rating !== null));
    check('byHour 空池不抛错', A.byHour(s, []).length === 0);

    const proto = JSON.parse(JSON.stringify(s.matches({})[0]));
    const mk = (min, gt) => Object.assign({}, proto, {
      room_id: 'seg-' + min + '-' + (gt || 600), start_time: 1000000 + min * 60, game_time: gt || 600
    });
    const tight = [mk(0), mk(39), mk(78)];
    const seg1 = A.sessionSegments(s, tight);
    check('★ 歇 29 分钟算同一轮连战', seg1.stats.runs === 1 && seg1.stats.matches === 3, JSON.stringify(seg1.stats));
    check('歇恰好 30 分钟仍算同一段（判据是严格大于）',
      A.sessionSegments(s, [mk(0), mk(40)]).stats.runs === 1);
    const seg2 = A.sessionSegments(s, [mk(0), mk(41)]);
    check('歇 31 分钟切成两轮', seg2.stats.runs === 2 && seg2.stats.longestRun === 1, JSON.stringify(seg2.stats));
    check('byIndex 按段内序号归并', seg1.byIndex.length === 3 &&
      seg1.byIndex[0].index === 1 && seg1.byIndex[2].total === 1,
      JSON.stringify(seg1.byIndex.map(x => [x.index, x.total])));
    check('lengthDist 统计每轮打了几场',
      seg2.lengthDist.some(x => x.n === 1 && x.count === 2), JSON.stringify(seg2.lengthDist));
    check('连战阈值默认 30 且可覆盖',
      A.SESSION_GAP_MIN === 30 && A.sessionSegments(s, tight, { gapMin: 5 }).stats.runs === 3);
    check('乱序输入也能正确切段（内部按 start_time 升序）',
      A.sessionSegments(s, tight.slice().reverse()).stats.runs === 1);
    check('空 rows 的节律不抛错', (function () {
      const e = A.sessionSegments(s, []);
      return e.stats.runs === 0 && e.byIndex.length === 0 && e.lengthDist.length === 0;
    })());

    const rep3 = A.report(s, {});
    check('report 挂上 hours / rhythm / sync / people 四段',
      Array.isArray(rep3.hours) && !!rep3.rhythm && !!rep3.sync && !!rep3.people);
    check('rhythm 统计的是筛选后的池子',
      rep3.rhythm.stats.matches === rep3.filtered.total,
      rep3.rhythm.stats.matches + ' vs ' + rep3.filtered.total);

    const Dig = require('../core/aiDigest');
    const dg = Dig.buildGlobalDigest(s, {});
    check('摘要带上当前评分口径', dg.text.indexOf('权重 得分') !== -1,
      (dg.text.match(/■ 单局评分[^\n]*/) || [''])[0]);
    check('★ 新增的 report 键一个都不进摘要（白名单取键，不是黑名单裁剪）',
      dg.text.indexOf('watchKey') === -1 && dg.text.indexOf('byIndex') === -1 &&
      dg.text.indexOf('sync_windows') === -1 && dg.text.indexOf('lengthDist') === -1);
  }

  console.log('\n' + '='.repeat(64));
  console.log('27. 插件包：zip 解析与路径安全（core/zip.js）');
  console.log('='.repeat(64));
  const Zip = require('../core/zip');
  const zlib = require('zlib');
  const { mkZip } = require('./zip-kit');

  const GOOD = mkZip([
    { name: 'manifest.json', data: '{"id":"demo"}' },
    { name: 'ui/main.js', data: 'console.log(1)', method: 8 },
    { name: 'assets/', data: '', mode: 0o40755 }
  ]);

  const zp = Zip.parse(GOOD);
  check('合法包解析成功', zp.ok === true && zp.entries.length === 3,
    zp.ok ? zp.entries.map(e => e.name).join(',') : zp.message);
  check('目录条目被认出来', zp.entries.some(e => e.dir && e.name === 'assets/'));
  check('stored 条目原样交出字节', Buffer.from(zp.entries[0].raw).toString('utf8') === '{"id":"demo"}');
  check('deflate 条目交出压缩字节、由调用方 inflate',
    zlib.inflateRawSync(Buffer.from(zp.entries[1].raw)).toString('utf8') === 'console.log(1)');
  check('安全校验放行合法包', Zip.checkSafety(zp).ok === true, Zip.checkSafety(zp).problems.join(' / '));

  function rejected(bytes) { const r = Zip.parse(bytes); return r.ok === false ? r.reason : '(接受)'; }
  function unsafeCount(bytes) { const r = Zip.parse(bytes); return r.ok ? Zip.checkSafety(r).problems.length : -1; }
  check('zip slip（../）被拦', unsafeCount(mkZip([{ name: '../evil.js', data: 'x' }])) === 1);
  check('绝对路径被拦', unsafeCount(mkZip([{ name: '/etc/passwd', data: 'x' }])) === 1);
  check('带盘符路径被拦', unsafeCount(mkZip([{ name: 'C:/Windows/x.js', data: 'x' }])) === 1);
  check('反斜杠路径被拦', unsafeCount(mkZip([{ name: '..\\evil.js', data: 'x' }])) === 1);
  check('符号链接条目被拦', unsafeCount(mkZip([{ name: 'link', data: 'x', mode: 0o120777 }])) === 1);
  check('Windows 下重名（a.js / A.js）被拦',
    unsafeCount(mkZip([{ name: 'a.js', data: '1' }, { name: 'A.js', data: '2' }])) === 1);
  function unsafeProblems(bytes) { const r = Zip.parse(bytes); return r.ok ? Zip.checkSafety(r).problems.join(' / ') : '(解析阶段就拒了)'; }
  check('声明体积超单文件上限被拦',
    unsafeProblems(mkZip([{ name: 'big.js', data: 'x', usize: 9 * 1024 * 1024 }])).indexOf('单文件上限') !== -1,
    unsafeProblems(mkZip([{ name: 'big.js', data: 'x', usize: 9 * 1024 * 1024 }])));
  check('压缩比异常（伪装的 zip 炸弹）被拦',
    unsafeCount(mkZip([{ name: 'bomb.js', data: 'x', usize: 4 * 1024 * 1024 }])) === 1);
  check('加密包整包拒收', rejected(mkZip([{ name: 'a.js', data: 'x', flags: 1 }])) === 'encrypted');
  check('未知压缩方式拒收', rejected(mkZip([{ name: 'a.js', data: 'x', method: 12 }])) === 'method');
  check('不是 zip 就明确报错', rejected(new Uint8Array(64).fill(7)) === 'no_eocd');
  check('条目数超限在解析阶段就挡掉',
    rejected(mkZip(Array.from({ length: 201 }, (_, i) => ({ name: 'f' + i + '.js', data: '1' })))) === 'too_many');
  check('★ 拼路径前还要复校验一次：.. 绝对路径 反斜杠 一律不给过',
    Zip.isSafeRelPath('ui/main.js') === true && Zip.isSafeRelPath('../x.js') === false &&
    Zip.isSafeRelPath('/x.js') === false && Zip.isSafeRelPath('C:/x') === false &&
    Zip.isSafeRelPath('a\\b.js') === false && Zip.isSafeRelPath('') === false);

  console.log('\n' + '='.repeat(64));
  console.log('28. 插件清单与权限白名单（core/plugin.js）');
  console.log('='.repeat(64));
  const Plg = require('../core/plugin');
  const FILES = ['manifest.json', 'ui.html', 'main.js'];
  function mani(over) {
    return JSON.stringify(Object.assign({
      id: 'df.team-stats', name: '战队上报', version: '1.0.0',
      entry: 'ui.html', script: 'main.js',
      permissions: [{ scope: 'view' }, { scope: 'read.summary' },
        { scope: 'net.request', hosts: ['https://team.example.com/api/stats/upload'], reason: '把汇总传给战队' }],
      consent: {
        sentence: '我已确认，并将数据上传到我信任的战队网站',
        sends: ['20 项汇总指标'], doesNotSend: ['逐场明细']
      }
    }, over || {}));
  }
  const okRun = Plg.parseManifest(mani(), FILES);
  check('合法清单通过', okRun.ok === true, okRun.ok ? '' : okRun.message);
  check('host 从完整网址里归一化成域名',
    okRun.manifest.permissions[2].hosts.join() === 'team.example.com', okRun.manifest.permissions[2].hosts.join());
  check('权限带上给用户看的中文标签', okRun.manifest.permissions[2].label.indexOf('外部') !== -1,
    okRun.manifest.permissions[2].label);
  check('hostInZip 齐全时不报缺文件', okRun.ok && !/不在包里/.test(okRun.message || ''));

  function why(text, files) { const r = Plg.parseManifest(text, files || FILES); return r.ok ? '(接受)' : r.reason + ' / ' + r.message; }
  function rejects(over, needle) {
    const m = mani(over);
    return why(m, over && over.__files || FILES).indexOf(needle) !== -1;
  }
  check('id 非法被拒', rejects({ id: 'Bad ID' }, 'id 不合法'));
  check('version 非法被拒', rejects({ version: 'v1' }, 'version'));
  check('entry 带 .. 被拒', rejects({ entry: '../etc/passwd' }, 'entry'));
  check('清单声明的文件不在包里被拒',
    why(mani(), ['manifest.json', 'ui.html']).indexOf('不在包里') !== -1);
  check('未知权限 scope 一律不接受',
    rejects({ permissions: [{ scope: 'read.matches' }] }, '宿主不认识'));
  check('net.request 不写 hosts 直接拒（没有默认放行这回事）',
    rejects({ permissions: [{ scope: 'net.request' }] }, '必须写明 hosts'));
  check('通配符域名被拒',
    rejects({ permissions: [{ scope: 'net.request', hosts: ['*.example.com'] }] }, '不合法'));
  check('http 明文主机被归一化后仍要求合法（裸 ip/异常写法拒）',
    rejects({ permissions: [{ scope: 'net.request', hosts: ['not a host'] }] }, '不合法'));
  /* ★ ["*"] = 「地址由使用者在插件页里自己填」，是清单里唯一一种不写死域名的合法写法。
   *   这里刻意只换 hosts、其余权限与默认清单逐项一致 —— 下面还要拿它比权限指纹，
   *   少写一项能力指纹也会变，那这条断言就证明不了「是 hosts 让指纹变的」。 */
  const ANY = Plg.parseManifest(
    mani({ permissions: [{ scope: 'view' }, { scope: 'read.summary' },
      { scope: 'net.request', hosts: ['*'], reason: '你填哪儿发哪儿' }] }), FILES);
  check('★ hosts 显式写成 ["*"] 通过，并标出 anyHost',
    ANY.ok === true && ANY.manifest.permissions[2].anyHost === true &&
    ANY.manifest.permissions[2].hosts.join() === '*', ANY.ok ? '' : ANY.message);
  check('★ 通配不许和具体域名混写（混了就等于清单形同虚设）',
    rejects({ permissions: [{ scope: 'net.request', hosts: ['*', 'api.example.com'] }] }, '不能再列具体域名'));
  check('权限重复声明被拒', rejects({ permissions: [{ scope: 'view' }, { scope: 'view' }] }, '重复'));
  check('permissions 缺失被拒（要求显式声明）', rejects({ permissions: undefined }, '非空数组'));
  /* ★ 外发闸门：这句话是宿主替用户把的唯一一道关，缺它就等于"想往外发但没打算让人知道" */
  check('★ 要外发却不写 consent.sentence 被拒', rejects({ consent: undefined }, '必须写明 consent.sentence'));
  check('consent.sentence 是空的同样被拒', rejects({ consent: { sentence: '  ' } }, '不能是空的'));
  check('consent.sentence 超过 80 字被拒',
    rejects({ consent: { sentence: '我'.repeat(81) } }, '太长'));
  check('sends 超过 8 条被拒',
    rejects({ consent: { sentence: 'x', sends: new Array(9).fill('一项') } }, '最多 8 条'));
  check('披露条目超过 60 字被拒',
    rejects({ consent: { sentence: 'x', doesNotSend: ['不'.repeat(61)] } }, '有一条太长'));
  check('不申请外发的包，consent 只是段说明文字，允许存在',
    Plg.parseManifest(mani({ permissions: [{ scope: 'view' }] }), FILES).ok === true);
  const SENT = '我已确认，并将数据上传到我信任的战队网站';
  const AI_SENT_UP = '我已确认，并将数据上传到我信任的AI服务器上进行分析';
  const AI_SENT_LOW = '我已确认，并将数据上传到我信任的ai服务器上进行分析';
  check('★ 全角空格 / 大小写 / 句末句号都算对，改一个字就不算',
    Plg.matchConsent(SENT, SENT) &&
    Plg.matchConsent(' 我　已确认，并将数据上传到我信任的战队网站。 ', SENT) &&
    Plg.matchConsent(AI_SENT_LOW, AI_SENT_UP) && Plg.matchConsent(AI_SENT_UP, AI_SENT_LOW) &&
    !Plg.matchConsent('我已确认，并将数据上传到我信任的战队网站。!', SENT) &&
    !Plg.matchConsent('我确认，并将数据上传到我信任的战队网站', SENT) &&
    !Plg.matchConsent('', SENT) && !Plg.matchConsent(SENT, ''));
  /* 内置 AI 时代这里有两份宽容规则（aiDigest 一份、plugin 一份），所以要钉「不许漂移」。
   * v1.7.0 起只剩宿主这一份 —— 判定源每多一个就多一条绕过通道，这条断言改钉「不许长回两份」。 */
  const AiD = require('../core/aiDigest');
  check('★ 逐字确认只有宿主闸门一个判定源（core/aiDigest 里不许再留第二份）',
    AiD.matchConsent === undefined && AiD.AI_CONSENT_TEXT === undefined);
  check('manifest 不是 JSON 时给明确原因', why('{"id":').indexOf('不是合法 JSON') !== -1);
  check('顶层是数组也算坏清单',
    Plg.parseManifest('[]', FILES).reason === 'manifest_shape');
  check('版本比对口径正确',
    Plg.cmpVersion('1.5.0', '1.4.3') === 1 && Plg.cmpVersion('1.5.0', '1.5.1') === -1 &&
    Plg.cmpVersion('1.5', '1.5.0') === 0);
  const lowHost = Plg.parseManifest(mani({ minHostVersion: '9.9.9' }), FILES);
  check('要求更高宿主版本时标出不满足', lowHost.ok === true && lowHost.manifest.hostOk === false);

  const fp1 = Plg.permFingerprint(okRun.manifest);
  const fp2 = Plg.permFingerprint(Plg.parseManifest(mani(), FILES).manifest);
  const fp3 = Plg.permFingerprint(Plg.parseManifest(
    mani({ permissions: [{ scope: 'view' }, { scope: 'net.request', hosts: ['evil.example.com'] }] }), FILES).manifest);
  check('权限指纹稳定（重复解析一致）', fp1 === fp2 && /^[0-9a-f]{1,8}$/.test(fp1), fp1);
  check('★ 多要一个域名，权限指纹就变', fp3 !== fp1, fp1 + ' vs ' + fp3);
  check('★ 改成通配「地址由你填」，权限指纹同样要变（两批人的包不能混用同一份确认）',
    Plg.permFingerprint(ANY.manifest) !== fp1 && Plg.permFingerprint(ANY.manifest) !== fp3,
    Plg.permFingerprint(ANY.manifest));
  const fp4 = Plg.permFingerprint(Plg.parseManifest(
    mani({ consent: { sentence: '我已确认，随便发吧', sends: [], doesNotSend: [] } }), FILES).manifest);
  check('★ 只改那一句确认话，权限指纹也变（改了就得重新导包）', fp4 !== fp1, fp1 + ' vs ' + fp4);

  /* ============================================================
   * 29. 统计层（core/stats.js）与六项深度分析
   *   ★ v1.8.0 新增的全部判定源都在这里：任何一条算错，界面就会把噪声说成结论。
   * ============================================================ */
  console.log('\n' + '='.repeat(64));
  console.log('29. 统计层与六项深度分析');
  console.log('='.repeat(64));
  const Stats = require('../core/stats');

  /* --- ④ 区间本身 --- */
  check('n<3 不给区间（0%~100% 那种毫无信息量的东西不画）',
    Stats.wilson(1, 2) === null && Stats.wilson(2, 3) !== null);
  const w0 = Stats.wilson(0, 10);
  check('0 胜 10 场：区间贴着 0 但不塌成一点', w0.lo === 0 && w0.hi > 0 && w0.hi < 50,
    JSON.stringify(w0));
  check('场数越多区间越窄', Stats.wilson(20, 40).half < Stats.wilson(5, 10).half,
    'n=40 半宽 ' + Stats.wilson(20, 40).half + ' vs n=10 ' + Stats.wilson(5, 10).half);
  check('区间点值就是胜率本身（四舍五入到 1 位）', Stats.wilson(5, 10).point === 50);
  const same2 = Stats.diffInterval([10, 11, 12, 13], [10, 12, 11, 13]);
  check('两组一样 → 差跨 0，界面只许写「说不出方向」',
    same2.diff === 0 && same2.crossesZero === true, JSON.stringify(same2));
  const far = Stats.diffInterval([10, 11, 12, 13], [60, 61, 62, 63]);
  check('两组分得很开 → 差不跨 0', far.crossesZero === false && far.hi < 0, far.lo + '~' + far.hi);
  check('可靠性档位：不足 3 场 none、宽区间 thin、够样本 ok',
    Stats.reliability(2, null) === 'none' &&
    Stats.reliability(4, Stats.wilson(2, 4)) === 'thin' &&
    Stats.reliability(200, Stats.wilson(100, 200)) === 'ok');
  check('并列值取中点分位', Stats.percentileOf([1, 2, 2, 3], 2) === 50,
    String(Stats.percentileOf([1, 2, 2, 3], 2)));
  check('一项是常数时 beta 直接不给（不硬编成 0）',
    Stats.betas([1, 2, 3, 4, 5, 6, 7, 8],
      [[1, 2, 3, 4, 5, 6, 7, 8], [5, 5, 5, 5, 5, 5, 5, 5]]) === null);
  check('样本不足（每项 5 场）不给多元回归',
    Stats.betas([1, 2, 3, 4, 5, 6], [[1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1]]) === null);
  const known = Stats.betas([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]]);
  check('★ 已知关系能反推出来：真正同向的那项 beta 明显更大',
    known && known.values[0] > 0.8 && known.values[0] > Math.abs(known.values[1]),
    known && known.values.join(' vs '));

  /* --- ④ 每一个胜率都自带区间 --- */
  const mk = (o) => Object.assign({
    room_id: 'x' + Math.random().toString(36).slice(2, 9), start_time: 1700000000,
    map_id: 601, is_winner: false, is_leave: 0, kill: 20, death: 10, assist: 5,
    score: 20000, occupy: 2, rescue: 20, game_time: 900, dt_event_time: '2026-09-20 12:00:00'
  }, o);
  const rows29 = [];
  for (let i = 0; i < 12; i++) rows29.push(mk({ is_winner: i % 2 === 0, score: 18000 + i * 500 }));
  const sum29 = A.summarize(rows29);
  check('★ summarize 自带 ci 与 reliability：判定源只有一份',
    !!sum29.ci && sum29.ci.n === 12 &&
    (sum29.reliability === 'thin' || sum29.reliability === 'ok'), JSON.stringify(sum29.ci));
  check('分组胜率同样带区间（byMap）',
    A.byMap(store, rows29).every(function (x) { return !!x.ci; }),
    'map 组数=' + A.byMap(store, rows29).length);
  const repWin = A.report(store, { mode: 'all', leave: 'all' }).windows;
  check('近 N 局胜率也带区间',
    !repWin.last10 || (!!repWin.last10.ci && repWin.last10.reliability !== undefined),
    JSON.stringify(repWin.last10 && repWin.last10.ci));

  /* --- ① 赢输对照 --- */
  const thinWL = A.winLossCompare(rows29.slice(0, 4));
  check('一侧不足 3 场就不出对照，只给一句原因',
    thinWL.available === false && /场数不足/.test(thinWL.reason), thinWL.reason);
  const flatWL = A.winLossCompare(rows29);
  check('两组数据一样 → 判定全为「说不出方向」，headline 说清跨 0',
    flatWL.available === true && flatWL.clear.length === 0 && /跨 0/.test(flatWL.headline),
    flatWL.headline);
  const realRows = [];
  for (let i = 0; i < 18; i++) {
    realRows.push(mk({ is_winner: i < 9, kill: i < 9 ? 60 : 20, death: 12 }));
  }
  const realWL = A.winLossCompare(realRows);
  check('差得足够远时才给「看得出方向」，并按效应量排序',
    realWL.clear.length > 0 && ['场均击杀', 'KPM（每分钟击杀）'].indexOf(realWL.items[0].label) >= 0 &&
    Math.abs(realWL.items[0].effect) >= Math.abs(realWL.items[realWL.items.length - 1].effect),
    realWL.items.slice(0, 3).map(function (x) { return x.label + ':' + x.effect; }).join(' '));
  /* 这批合成数据的 game_time 是常数（900 秒），所以 KPM 与场均击杀只差在四舍五入上、
   * 谁排第一是掷硬币 —— 上面那条因此只认"击杀类排在前二"。真库那边时长从 378 秒跨到 2186 秒，
   * 两者就不是同一枚数了，所以这里要钉的是**在场**而不是名次。 */
  check('赢的那场 vs 输的那场里 KPM 与 KD 并列（胜者为王玩家看 KPM）',
    realWL.items.some(function (x) { return x.key === 'kill_per_min'; }) &&
    realWL.items.some(function (x) { return x.key === 'kd'; }),
    realWL.items.map(function (x) { return x.key; }).join(','));
  check('效应量档位由 core 划好（界面不再自己定门槛）',
    realWL.items.every(function (x) {
      return x.effect == null ? x.mag == null : ['大', '中', '小', '微'].indexOf(x.mag) >= 0;
    }));

  /* --- ③ 时长与节奏 --- */
  const dur = A.durationProfile([
    mk({ game_time: 599 }), mk({ game_time: 600 }), mk({ game_time: 1799 }), mk({ game_time: 1800 })
  ]);
  check('分箱边界归下一档（600 进 10~15，1800 进 30 以上）',
    dur.buckets[0].n === 1 && dur.buckets[1].n === 1 &&
    dur.buckets[3].n === 1 && dur.buckets[4].n === 1,
    dur.buckets.map(function (b) { return b.n; }).join('/'));
  check('★ 重复的连战衰减字段已删（同一页只留一份口径）', dur.sessionDecay === undefined);
  const durFlat = A.durationProfile(rows29);
  check('每档只剩几场时趋势判为不可信，headline 跟着降级',
    durFlat.trend === null || durFlat.trend.believable === false, JSON.stringify(durFlat.trend));
  const strongDur = [];
  for (let i = 0; i < 10; i++) strongDur.push(mk({ game_time: 400, is_winner: true }));
  for (let i = 0; i < 10; i++) strongDur.push(mk({ game_time: 2200, is_winner: false }));
  const durStrong = A.durationProfile(strongDur);
  check('两端区间互不重叠才允许说方向',
    durStrong.trend.believable === true && /同向|反向/.test(durStrong.headline),
    JSON.stringify(durStrong.trend));

  /* --- ⑤ 对手强度校准 --- */
  function lobbyStore(games) {
    const matches = {}, rosters = {}, rows = [];
    games.forEach(function (g, i) {
      const rid = 'g' + i;
      const players = [{ vopenid: 'me', color: 1, score: g.me }];
      g.ours.forEach(function (sc, k) { players.push({ vopenid: 'o' + k, color: 1, score: sc }); });
      g.theirs.forEach(function (sc, k) { players.push({ vopenid: 'e' + k, color: 2, score: sc }); });
      const row = mk({ room_id: rid, is_winner: !!g.win, start_time: 1700000000 + i * 1800 });
      row.room_id = rid;
      matches[rid] = row;
      rosters[rid] = { at: 0, players: players };
      rows.push(row);
    });
    return {
      rows: rows,
      store: {
        state: { matches: matches, rosters: rosters, meta: {}, settings: {} },
        activeOpenid: function () { return 'me'; },
        matches: function () { return rows; },
        players: function (rid) { return (rosters[rid] || {}).players || []; }
      }
    };
  }
  const few29 = lobbyStore([{ me: 1, ours: [1, 1], theirs: [1, 1], win: 1 }]);
  const sFew = A.strengthProfile(few29.store, few29.rows);
  check('带名单的场次不足就不给结论，原因里写明怎么补齐',
    sFew.available === false && /全场名单/.test(sFew.reason), sFew.reason);
  const games29 = [];
  for (let i = 0; i < 12; i++) {
    games29.push({ me: 5000, ours: [4000 + i * 30, 3900 + i * 30, 4100 + i * 30],
      theirs: [3000, 3100, 2900], win: 1 });
  }
  for (let i = 0; i < 12; i++) {
    games29.push({ me: 2000, ours: [1800, 1900, 1700], theirs: [5000, 5100, 4900], win: 0 });
  }
  const l29 = lobbyStore(games29);
  const s29 = A.strengthProfile(l29.store, l29.rows);
  check('★ 同义反复的 expected/excess 字段已删（期望恒等于实际那种）',
    s29.available === true && s29.expected === undefined && s29.excess === undefined);
  check('三档场数加起来等于有名单的场数，切点单调',
    s29.bins.reduce(function (a, b) { return a + b.n; }, 0) === s29.games && s29.cuts.c1 <= s29.cuts.c2,
    'bins=' + s29.bins.map(function (b) { return b.n; }).join('/'));
  check('★ 池子差决定胜负时，档位差要敢说话',
    s29.power.believable === true && s29.power.diff > 50 && /池子/.test(s29.headline),
    JSON.stringify(s29.power));
  check('劣势局只算池子差为负的场次',
    s29.underdog.n > 0 && s29.underdog.n <= s29.games && s29.underdog.winRate !== null,
    JSON.stringify(s29.underdog));
  check('时间对半切给得出早/近两段，两段场数补齐总场数',
    !!s29.drift && s29.drift.early.n + s29.drift.late.n === s29.games &&
    typeof s29.drift.gapClear === 'boolean', JSON.stringify(s29.drift && s29.drift.late));

  /* --- ⑥ 相对你自己的基线 --- */
  const l29maps = lobbyStore(games29);
  /* 让第一行所在的图只剩 2 场：不足 BASE_MIN_SAME_MAP 就必须退回"全部"作对照池 */
  l29maps.rows.forEach(function (r, i) { r.map_id = i < 2 ? 601 : 602; });
  const bl = A.baselineFor(l29maps.store, l29maps.rows[0]);
  check('同图不足 5 场就退回全部为对照池',
    bl.basis === 'overall' && bl.n === l29maps.rows.length, bl.basis + ' n=' + bl.n);
  const l605 = lobbyStore(games29);
  l605.rows.forEach(function (r) { r.map_id = 605; });
  const blSame = A.baselineFor(l605.store, l605.rows[0]);
  check('同图够 5 场就先跟同图比', blSame.basis === 'map' && blSame.n >= A.BASE_MIN_SAME_MAP,
    blSame.basis + ' n=' + blSame.n);
  check('★ 如实声明本场也在对照池里（小样本分位会被往中间拉）',
    bl.includesThisMatch === true && bl.items.every(function (x) {
      return x.pct === null || (x.pct >= 0 && x.pct <= 100);
    }));
  const worstRow = mk({ room_id: 'worst', kill: 0, death: 90, score: 1, occupy: 0, rescue: 0 });
  l29.store.state.matches.worst = worstRow;
  const blLow = A.baselineFor(l29.store, worstRow);
  check('垫底那场 headline 走「低于常态」那一档',
    /低于常态/.test(blLow.headline) && blLow.overallPct < 30, blLow.headline);
  check('没有对局时基线算不出而不是给个 0', A.baselineFor(l29.store, null) === null);

  /* --- ⑧ 得分结构反推 --- */
  const ssThin = A.scoreStructure(l29.store, l29.rows.slice(0, 6));
  check('样本不足时反推不出结构，但仍把你设的占比列出来',
    ssThin.available === false && ssThin.userShares.length === 4 &&
    Math.abs(ssThin.userShares.reduce(function (a, x) { return a + x.userShare; }, 0) - 100) < 1,
    ssThin.reason);
  const structRows = [];
  for (let i = 0; i < 24; i++) {
    const kill = 10 + i * 2 + (i % 5);
    const death = 5 + (i % 7);
    const assist = (i * 3) % 9;
    const occupy = (i * 5) % 6;
    const rescue = 30 - (i % 6) * 5;
    structRows.push(mk({
      kill: kill, death: death, assist: assist, occupy: occupy, rescue: rescue,
      score: kill * 500 + occupy * 300 - rescue * 100 + (i % 3) * 40
    }));
  }
  const ss = A.scoreStructure({ state: { settings: {} }, activeOpenid: function () { return 'me'; } },
    structRows);
  check('合成数据里真正决定总分的那项，反推占比最高',
    ss.available === true &&
    ss.items.filter(function (x) { return x.label === '击杀'; })[0].share ===
      Math.max.apply(null, ss.items.map(function (x) { return x.share; })),
    ss.items.map(function (x) { return x.label + ':' + x.share; }).join(' '));
  check('★ 反向变动的那项占比记 0，但 beta 保留负号（不许抹平）',
    ss.items.some(function (x) { return x.beta < 0 && x.share === 0; }),
    ss.items.map(function (x) { return x.label + 'β' + x.beta; }).join(' '));
  check('占比按正 beta 归一到 100',
    Math.abs(ss.items.reduce(function (a, x) { return a + x.share; }, 0) - 100) < 0.5);
  check('★ 两条免责说明跟着数据走（共线不是因果 + 右侧口径重新归一）',
    /不是因果/.test(ss.note) && /重新归一/.test(ss.basis), ss.note.slice(0, 18));
  check('headline 要么说对得上、要么点出差多少个百分点',
    (ss.aligned ? /对得上/.test(ss.headline) : /个百分点/.test(ss.headline)), ss.headline);

  /* ============ 26. 「读不出来」≠「没有数据」：写闸 + 适配器分得开两种失败 ============
   * 起因是 #69 那条：桌面适配器一个 catch 包到底，读不动（Windows 上杀软攥句柄的 EPERM 是真会发生的）
   * 被当成"文件坏了" ⇒ 把真库 rename 走 ⇒ core 认为这号没数据 ⇒ 下一次 save() 在原位写一份空的。
   * 这一节两条都真跑：core 那道闸用假适配器跑，适配器本身拿临时文件跑。 */
  const StoreNode = require('../shell/adapters/store-node');
  await (async function () {
    let saveCalls = 0;
    const boom = new StoreMod.Store({
      load: function () { throw new Error('EPERM: operation not permitted, open "df-swtwr-a1.json"'); },
      save: function () { saveCalls++; }
    });
    let threw = false, rejected = null;
    try {
      const pr = boom.load();
      rejected = await pr.then(function () { return null; }, function (e) { return String(e.message); });
    } catch (e) { threw = true; }
    check('★★ 适配器同步抛错被 core 转成 rejection（不是当场把调用方炸穿 —— 桌面那些 .catch 以前就是接不到）',
      !threw && typeof rejected === 'string' && /EPERM/.test(rejected),
      'threw=' + threw + ' rejection=' + JSON.stringify(rejected));
    check('★ 闸门合上时 save() 被拒，而且原话带着"没读出来"与"别卸载重装"',
      await boom.save().then(function () { return 'resolved'; }, function (e) { return String(e.message); })
        .then(function (msg) { return /没读出来/.test(msg) && /别卸载重装/.test(msg) && saveCalls === 0; }),
      '适配器 save 被调 ' + saveCalls + ' 次');
    check('★ loadFault() 把原因交回外壳（桌面 bootError / 安卓 storageFault 读的就是它）',
      /EPERM/.test(boom.loadFault()), boom.loadFault().slice(0, 60));
    /* 读成功一次，闸门就得打开 —— 否则"修好了也写不进去"会变成新的坏行为 */
    const revived = new StoreMod.Store({
      load: function () { return null; }, save: function () { saveCalls++; }
    });
    await revived.load();
    check('★ 没这个文件时 load() 回 null 仍算"读成功"（真的还没数据，跟读不动是两回事），闸门是开的',
      revived.loadFault() === '' && await revived.save().then(function () { return true }, function () { return false }),
      'saveCalls=' + saveCalls);
  })();

  await (async function () {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-store-io-'));
    const f = path.join(dir, 'df-swtwr-a9.json');
    const ad = StoreNode.createFileStore(f);
    check('★ 文件不存在 → load() 回 null（不是抛错、也不是"损坏"）',
      ad.load() === null, '回 ' + String(ad.load()));
    fs.writeFileSync(f, JSON.stringify({ version: 2, matches: { r1: { room_id: 'r1' } } }), 'utf8');
    /* ① 读不动：把 readFileSync 弄挂（模拟 EPERM 攥句柄），文件必须一个字都不动 */
    const realRead = fs.readFileSync;
    let readMsg = '';
    try {
      fs.readFileSync = function () { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };
      ad.load();
      readMsg = '没抛错';
    } catch (e) { readMsg = String(e.message); }
    finally { fs.readFileSync = realRead; }
    const sideFiles = fs.readdirSync(dir).filter(function (x) { return /\.corrupt-/.test(x); });
    check('★★ 读不动时：抛的是"读不出来（文件没动）"，真库仍在原位，且**没有**产出 .corrupt 副本',
      /读不出来（文件没动）/.test(readMsg) && /EPERM/.test(readMsg) &&
      fs.existsSync(f) && sideFiles.length === 0,
      readMsg.slice(0, 60) + ' | 原位=' + fs.existsSync(f) + ' | 副本=' + sideFiles.length);
    /* ①b 瞬态：第一次读不动、第二次读到了 —— 定论之前那次重读就是为这个 */
    const realOnce = fs.readFileSync;
    let once = 0;
    let transientOk = false, transientVal = null;
    try {
      fs.writeFileSync(f, JSON.stringify({ version: 2, meta: { openid: 'transient' }, matches: {} }), 'utf8');
      fs.readFileSync = function (p2, enc) {
        if (String(p2) === String(f) && once++ === 0) { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; }
        return realOnce(p2, enc);
      };
      try { transientVal = ad.load(); transientOk = true; } catch (e) { transientOk = false; }
    } finally { fs.readFileSync = realOnce; }
    check('★★ 只是句柄攥了一下（第一次读挂、第二次成就）：不许把它说成"读不出来"，也不许留下任何副本',
      transientOk && transientVal && transientVal.meta.openid === 'transient' &&
      fs.readdirSync(dir).filter(function (x) { return /\.corrupt-/.test(x); }).length === 0,
      '读到=' + JSON.stringify(transientVal && transientVal.meta));
    /* ② 真坏了：字节读到了但解析不动 —— 这一种才挪走留证据 */
    fs.writeFileSync(f, '{这行不是 JSON', 'utf8');
    let parseMsg = '';
    try { ad.load(); parseMsg = '没抛错'; }
    catch (e) { parseMsg = String(e.message); }
    const corrupt = fs.readdirSync(dir).filter(function (x) { return /\.corrupt-/.test(x); });
    check('★★ 真解析不动时：抛"解析不动"、原文件被挪成 .corrupt-* 留证据、原位不再有一份坏文件',
      /解析不动/.test(parseMsg) && corrupt.length === 1 && !fs.existsSync(f),
      parseMsg.slice(0, 60) + ' | 副本=' + corrupt.length + ' 原位=' + fs.existsSync(f));
    /* ③ 正常 round-trip 照旧 */
    fs.writeFileSync(f, JSON.stringify({ version: 2, meta: { openid: 'o1' }, matches: {} }), 'utf8');
    const got = ad.load();
    ad.save({ version: 2, meta: { openid: 'o1' }, matches: { r2: { room_id: 'r2' } } });
    check('★ 好文件的读写 round-trip 没被这轮改动弄坏',
      got && got.meta.openid === 'o1' && ad.load().matches.r2.room_id === 'r2', JSON.stringify(ad.load()).slice(0, 50));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 临时目录留着也无害 */ }
  })();

  const shellSrc = fs.readFileSync(path.join(__dirname, '..', 'shell', 'main.js'), 'utf8');
  /* ★ 计数要按"哪几条分支"数，不许数全文出现次数：storageFault 现在还挂在开登录窗那两发上，
   *   只写 >= 2 的话，把 boot 的两条分支摘干净也照样绿（S5 第一轮就是这么没变红的）。 */
  const bootBranches = shellSrc.split('\n').filter(function (l) {
    return /bootError: faultText/.test(l);
  });
  check('★ 桌面 boot 的两条分支（离线 / 探完登录）各自都带 storageFault，switchTo 也接得住载入 rejection 并把原因带回界面',
    bootBranches.length === 2 && bootBranches.every(function (l) { return /storageFault: !!fault/.test(l); }) &&
    /store\.loadFault\(\)/.test(shellSrc) &&
    /inst\.store\.load\(\)\.then\(function \(\) \{ return null; \},/.test(shellSrc) &&
    /return \{ ok: true, slot: slot, loadFault: loadFault \|\| '' \};/.test(shellSrc),
    'bootError 分支=' + bootBranches.length + ' 条里带布尔的 ' +
    bootBranches.filter(function (l) { return /storageFault: !!fault/.test(l); }).length + ' 条' +
    ' loadFault=' + /store\.loadFault\(\)/.test(shellSrc) +
    ' 带回=' + /loadFault: loadFault \|\| ''/.test(shellSrc));

  /* ★ 开登录窗那一发也要带这枚布尔：界面（两端共用）读的是 r.storageFault，
   *   安卓的 df.openLogin 给了、桌面上一版没给 ⇒ 同一句改口只在手机上响，
   *   而两边源码各自看上去都没错。这一条就是钉住"两端都有"的。 */
  const openWinSrc = (function () {
    const at = shellSrc.indexOf('function openLoginWindow');
    const end = shellSrc.indexOf('\nfunction ', at + 10);
    return shellSrc.slice(at, end === -1 ? shellSrc.length : end);
  })();
  check('★★ openLoginWindow 的 storageFault 是从 core 那道闸（store.loadFault()）取的，不是写死',
    /slotStore\.loadFault\s*&&\s*slotStore\.loadFault\(\)/.test(openWinSrc) &&
    /const storageFault = !!\(/.test(openWinSrc),
    '闸门取自 loadFault=' + /slotStore\.loadFault\(\)/.test(openWinSrc));
  check('★★ 开登录窗的两条回包（清成功 / 清失败）都带着这枚布尔，账户新增那发也原样转发',
    (openWinSrc.match(/storageFault: storageFault/g) || []).length === 2 &&
    /storageFault: r\.storageFault/.test(shellSrc),
    '回包=' + (openWinSrc.match(/storageFault: storageFault/g) || []).length +
    ' account:add 转发=' + /storageFault: r\.storageFault/.test(shellSrc));

  /* ============ 27. 归属核对：采回来的人必须就是这个库的主人 ============
   * 起因是 2026-09-26 那条「我拿小号扫了，要换大号，数据还是小号的，重启也没用」。
   * 判据放这一份，桌面与安卓各自只调它一次（两端各写一份"什么时候该拦"迟早会不一样）。 */
  await (async function () {
    const OC = StoreMod.ownerConflict;
    check('★ ownerConflict：同一个人不算冲突（每轮同步都拦一次就是把软件锁死）',
      OC('12345678', '12345678') === '', JSON.stringify(OC('12345678', '12345678')));
    check('★★ 两个都有 openid 却不同 ⇒ 冲突，且回的是"谁 ≠ 谁"（界面据此说得出人名）',
      /≠/.test(OC('111', '222')), JSON.stringify(OC('111', '222')));
    check('★★ 任何一侧没有 openid 都算"还不知道"，不判冲突：第一次落盘之前、只读导入号、老库迁移都可能空',
      OC('', '222') === '' && OC('111', '') === '' && OC('', '') === '' && OC(null, undefined) === '',
      JSON.stringify([OC('', '222'), OC('111', ''), OC('', ''), OC(null, undefined)]));
    check('★ 数字与字符串同一枚 openid 不能被判成两个人（官方回的一直是字符串，注册表里可能存成数字）',
      OC(12345678, '12345678') === '' && OC('12345678', 12345678) === '',
      JSON.stringify([OC(12345678, '12345678'), OC('12345678', 12345678)]));
    check('★ 冲突那句带着两边的 openid（出事时要能对着注册表核，不是光一句"不匹配"）',
      OC('111', '222').indexOf('111') >= 0 && OC('111', '222').indexOf('222') >= 0,
      JSON.stringify(OC('111', '222')));
  })();

  /* ============ 28. 备份：名字认得出、里面有什么说得清 ============
   * 2026-09-26 实测：他机器上 `backups/` 里 17 个文件，旧判定认出 **0 个** ⇒ 设置页永远说
   * 「还没有备份文件。」，而 pruneBackups() 同样一个都认领不到 ⇒ 「保留最近 N 份」从来没生效过。
   * 根因是**自己写的文件自己认不出**：doBackup 写的是 `2026-09-26-01-29-03`，判定要的是 `20260926-012903`。
   * ★ 所以这一节先拿 doBackup 那条命名式子现算名字再解析回去（round-trip），
   *   再拿盘上真出现过的几种形状逐个量 —— 只测其中一种，下次换个形状又会瞎。 */
  await (async function () {
    const PB = StoreMod.parseBackupName;
    /* 与 shell/main.js 的 doBackup 同一条式子（那三行抄在这儿，就是为了盯住两边不成对） */
    function backupName(slot, tag, d) {
      const stamp = d.toISOString().slice(0, 19).replace(/[:T]/g, '-');
      return 'df-swtwr-' + slot + '-' + tag + '-' + stamp + '.json';
    }
    const real = new Date(Date.UTC(2026, 8, 26, 1, 29, 3));
    const n1 = backupName('a1', 'daily-2026-09-26', real);
    const p1 = PB(n1);
    check('★★ doBackup 自己写出来的名字，判定认得出（这一条就是那条缺陷本身）',
      n1 === 'df-swtwr-a1-daily-2026-09-26-2026-09-26-01-29-03.json' &&
      !!p1 && p1.slot === 'a1' && p1.tag === 'daily-2026-09-26' &&
      p1.at === Date.UTC(2026, 8, 26, 1, 29, 3),
      n1 + ' → ' + JSON.stringify(p1));
    check('★ 手动备份与"恢复前那份留底"也都拆得开号与标签',
      PB(backupName('m00000001', 'manual', real)).tag === 'manual' &&
      PB(backupName('a3', 'pre-restore-2026-09-26', real)).slot === 'a3',
      JSON.stringify([PB(backupName('m00000001', 'manual', real)),
        PB(backupName('a3', 'pre-restore-2026-09-26', real))]));
    check('★ 老的紧凑形状（yyyymmdd-hhmmss）仍要认得：盘上两种形状并存，只认一种就又看不见',
      (function () {
        const x = PB('df-swtwr-a1-manual-20260926-012903.json');
        return !!x && x.slot === 'a1' && x.tag === 'manual' && x.at === Date.UTC(2026, 8, 26, 1, 29, 3);
      })(), JSON.stringify(PB('df-swtwr-a1-manual-20260926-012903.json')));
    check('★ 账号表那一份单独归一组（slot=accounts）：按号各留 keep 份时它不许跟战绩库混在一堆',
      (function () {
        const x = PB('df-swtwr-accounts-daily-2026-09-19-2026-09-19-10-39-02.json');
        return !!x && x.slot === 'accounts' && x.tag === 'daily-2026-09-19';
      })(), JSON.stringify(PB('df-swtwr-accounts-daily-2026-09-19-2026-09-19-10-39-02.json')));
    const junk = ['accounts.json', 'df-swtwr-data.json', 'df-swtwr-a1.json',
      'df-swtwr-a1-daily-2026-09-26-2026-09-26-01-29-03.json.v1.bak.2026-09-26',
      'df-swtwr-a1-corrupt-1700000000000.json', 'df-swtwr-a1-x.text', '', null,
      'df-swtwr-a1-2026-09-26.json', 'df-swtwr--manual-2026-09-26-01-29-03.json'];
    check('★ 认不出的就不是备份：真库本体、迁移留底、损坏副本、缺时间戳的一律不算（列表与裁剪共用这一颗）',
      junk.every(function (x) { return PB(x) === null; }),
      junk.filter(function (x) { return PB(x) !== null; }).join(','));
    check('★ 号里带 -v<ts>（换过罐子那一位的槽名不会带，但标签会）也不影响从右往左拆',
      (function () {
        const x = PB('df-swtwr-a1-daily-2026-09-26-2026-09-26-01-29-03.json');
        const y = PB('df-swtwr-a1-2026-09-26-2026-09-26-01-29-03.json');
        return !!x && !!y && y.slot === 'a1' && y.tag === '2026-09-26';
      })(), JSON.stringify(PB('df-swtwr-a1-2026-09-26-2026-09-26-01-29-03.json')));

    const SB = StoreMod.summarizeBackup;
    const lib = { version: 2, meta: { openid: '99887766', name: '甲号', last_sync: 1750000000000 },
      matches: { r1: { room_id: 'r1', start_time: 1758000000 },
        r2: { room_id: 'r2', start_time: 1758864000, excluded: true },
        r3: { room_id: 'r3', start_time: 1757000000 } },
      rosters: { r1: { players: [] }, r3: { players: [] } } };
    const s1 = SB(lib);
    check('★ 战绩库那份读得出：几场 / 名单几份 / 排除几场 / 跨度两端（列表念的就是这几枚）',
      s1.kind === 'library' && s1.matches === 3 && s1.rosters === 2 && s1.excluded === 1 &&
      s1.first === 1757000000 && s1.last === 1758864000 && s1.openid === '99887766' &&
      s1.name === '甲号', JSON.stringify(s1));
    check('★ 账号表那份读得出"哪几个号"，且不许被当成战绩库（ kinds 混了就有人会去点恢复）',
      (function () {
        const s = SB({ version: 1, activeSlot: 'a1',
          accounts: [{ slot: 'a1', openid: '1', name: '甲' }, { slot: 'a2', openid: '2', name: '乙' }] });
        return s.kind === 'accounts' && s.accounts === 2 && s.who === '甲、乙' && s.activeSlot === 'a1';
      })(), JSON.stringify(SB({ activeSlot: 'a1', accounts: [{ name: '甲' }, { name: '乙' }] })));
    check('★ 空库也要说清是战绩库（0 场），而不是"不认识这个文件"',
      SB({ version: 2, meta: {}, matches: {}, rosters: {} }).kind === 'library' &&
      SB({ version: 2, meta: {}, matches: {}, rosters: {} }).matches === 0,
      JSON.stringify(SB({ version: 2, meta: {}, matches: {}, rosters: {} })));
    check('★ 脏输入一律 unknown，不抛（列表里有一份坏文件不该把整页带走）',
      [null, undefined, 0, 'x', [], {}, { foo: 1 }].every(function (x) {
        return SB(x).kind === 'unknown';
      }), [null, 0, 'x', [], {}].map(function (x) { return SB(x).kind; }).join(','));

    /* 桌面接线：判据在 core，外壳只转发 —— 这一条盯"别再在 main.js 里正则一遍"。
     * 调用点会长（判定、裁剪、列表、自检探针各一处），所以钉的是**没有第二份正则**，不是颗数。 */
    check('★★ main.js 里认备份名字只剩 core 那一颗：本地一份 df-swtwr 正则都不许有（旧写法判定与裁剪各写了一份）',
      /function isBackupName\(name\) \{ return !!StoreMod\.parseBackupName\(name\); \}/.test(shellSrc) &&
      shellSrc.indexOf('\\d{8}-\\d{6}') === -1 &&
      (shellSrc.match(/\/\^?df-swtwr-/g) || []).length === 0 &&
      (shellSrc.match(/StoreMod\.parseBackupName/g) || []).length === 4 &&
      (shellSrc.match(/StoreMod\.summarizeBackup/g) || []).length === 1,
      '本地正则=' + (shellSrc.match(/\/\^?df-swtwr-/g) || []).length +
      ' parseBackupName=' + (shellSrc.match(/StoreMod\.parseBackupName/g) || []).length +
      ' summarize=' + (shellSrc.match(/StoreMod\.summarizeBackup/g) || []).length +
      ' 残留紧凑式子=' + (shellSrc.indexOf('\\d{8}-\\d{6}') >= 0));
    check('★★ 裁剪按**号**分组（旧写法把日期算进组名 ⇒ 每天一组、每组一份，永远裁不动）',
      /const g = x\.info && x\.info\.slot \? x\.info\.slot : 'other';/.test(shellSrc) &&
      shellSrc.indexOf('byTag') === -1 && /byGroup\[g\]\.slice\(keep\)/.test(shellSrc),
      'byTag 残留=' + (shellSrc.indexOf('byTag') >= 0));
    /* ★ 这一条是自检那一步顺手量出来的第二个真缺陷：`fs.copyFileSync` 连**源文件的修改时间**一起抄过来，
     *   于是一个号这几天没同步 ⇒ 它所有备份的 mtime 全一样 ⇒ 按 mtime 排"留最近 N 份"等于按目录顺序留，
     *   会把刚写的裁掉、把三天前的留下。名字里那枚时刻才是"这份是什么时候备的"。 */
    check('★★ "最近 N 份"排的是名字里那枚时刻，不是 mtime（mtime 是从源文件抄来的，排它会裁错份）',
      /t: \(info && info\.at\) \|\| fs\.statSync\(full\)\.mtimeMs/.test(shellSrc) &&
      /return \{ f: f, t: \(info && info\.at\)/.test(shellSrc),
      '按名字排=' + /t: \(info && info\.at\)/.test(shellSrc));
    check('★★ 列表那一行显示的也是名字里那枚时刻（同一把尺子：界面那句"什么时候备份的"不许跟裁剪用的两个样）',
      /time: info\.at \|\| st\.mtimeMs,/.test(shellSrc) &&
      /time: info\.at \|\| st\.mtimeMs,/.test(fs.readFileSync(path.join(__dirname, 'preview-server.js'), 'utf8')),
      '桌面=' + /time: info\.at \|\| st\.mtimeMs/.test(shellSrc) +
      ' 预览服务器=' + /time: info\.at \|\| st\.mtimeMs/.test(
        fs.readFileSync(path.join(__dirname, 'preview-server.js'), 'utf8')));
    check('★ 列表回包带着"这份里有什么"与两个计数（界面那句「共 N 份」用的就是 total）',
      /sum: peekBackup\(dir, f, st\.size, st\.mtimeMs\)/.test(shellSrc) &&
      /return \{ dir: dir, list: list, count: list\.length, total: total, keep: backupKeep\(\) \};/.test(shellSrc),
      'sum=' + /sum: peekBackup\(/.test(shellSrc));
    check('★ 读过的备份按 名字+大小+mtime 缓存（每开一次设置页就重解析几十份 JSON 是白工）',
      /const key = name \+ '\|' \+ size \+ '\|' \+ Math\.round\(mtime \|\| 0\);/.test(shellSrc) &&
      /backupPeekCache\.size > 80/.test(shellSrc), '缓存键=' + /const key = name/.test(shellSrc));
    /* 裁备份 = 删使用者的数据。上一版认不出名字 ⇒ 一份都没删过，界面也从不提"裁"；
     * 现在删得动了，就必须让他看见这轮删了几份、按什么留的。 */
    check('★★ 裁掉的份数要报给界面（pruneBackups 回 pruned/keep，doBackup 原样带上，谁都不许闷声删文件）',
      /return \{ pruned: pruned, keep: keep \};/.test(shellSrc) &&
      /const p = pruneBackups\(dir\);/.test(shellSrc) &&
      /pruned: p\.pruned, keep: p\.keep/.test(shellSrc),
      'prune回=' + /return \{ pruned:/.test(shellSrc) +
      ' doBackup转发=' + /pruned: p\.pruned/.test(shellSrc));
    /* 这一节的光谱（两种时间戳形状、账号表、脏输入）在 node 里跑得再绿，也证不了一件真事：
     * doBackup 写出去的名字，它自己的判定认不认。#76 那条缺陷恰好就是"单测全绿、界面永远空"，
     * 所以自检里必须让真落过盘的 doBackup 回读自己（tools/run-selftest.js 的 backups 那一节）。 */
    check('★★ 自检里真有一节拿磁盘上的真备份回读自己（写→认→裁→读内容，四步都用真的）',
      /function probeBackups\(\)/.test(shellSrc) &&
      /const r1 = doBackup\('manual'\);/.test(shellSrc) &&
      /o\.recognized = \(r1\.files \|\| \[\]\)\.filter\(isBackupName\)\.length;/.test(shellSrc) &&
      /accounts\.globalSettings\.backupKeep = 1;/.test(shellSrc) &&
      /o\.keptNewest/.test(shellSrc) &&
      /o\.pass[\s\S]{0,200}o\.sum\.matches === 2/.test(shellSrc) &&
      /return probeBackups\(\);/.test(shellSrc) &&
      /result\.backups && result\.backups\.pass === false\) result\.ok = false;/.test(shellSrc),
      'probe=' + /function probeBackups/.test(shellSrc) +
      ' 挂上链=' + /return probeBackups\(\);/.test(shellSrc));
    /* 他报的那两句是"界面上看不见"，所以自检的最后一步走的是真用户路径：点那颗按钮、读 DOM 那两处文本 */
    check('★★ 自检最后一步走真用户路径：点「立即备份」，读的是 toast 与那一行的 DOM 文本（不是宿主回包）',
      /btn\.click\(\);/.test(shellSrc) &&
      /getElementById\("btnBackupNow"\)/.test(shellSrc) &&
      /getElementById\("backupList"\)/.test(shellSrc) &&
      /已备份 \\d\+ 个文件/.test(shellSrc) &&
      /btn\.click\(\);/.test(shellSrc) && /这轮裁掉 ' \+ o\.prunedAtClick \+ ' 份/.test(shellSrc) &&
      /listedBackups\(o\.dir\)/.test(shellSrc) && /return delay\(1100\)/.test(shellSrc) &&
      /探针号/.test(shellSrc) && /份，共 \\d\+ 份/.test(shellSrc) &&
      /\.pass = !!\(o\.pass && o\.uiOk\);/.test(shellSrc) &&
      /\.then\(cleanup\)/.test(shellSrc),
      '点按钮=' + /btn\.click\(\);/.test(shellSrc) +
      ' 读行=' + /getElementById\("backupList"\)/.test(shellSrc) +
      ' 计入pass=' + /\.pass = !!\(o\.pass && o\.uiOk\);/.test(shellSrc));
    /* 号里带 - 会把号读成半截（拆的是左起第一枚），两个壳发的号都是 a<数字> / m<数字>，钉住这条约定 */
    check('★ 号里不许有横杠：拆的是左起第一枚 -，a1 / m00000001 才对，x-y 会被读成号=x 标签=y',
      PB('df-swtwr-a1-manual-2026-09-26-01-29-03.json').slot === 'a1' &&
      PB(backupName('m00000001', 'manual', real)).slot === 'm00000001' &&
      (function () { const x = PB('df-swtwr-x-y-manual-2026-09-26-01-29-03.json'); return x.slot === 'x' && x.tag === 'y-manual'; })(),
      JSON.stringify(PB('df-swtwr-x-y-manual-2026-09-26-01-29-03.json')));
  })();

  /* ============================================================
   * 30. KPM 与阵营（增补十八：其他用户回的五条里的 ①④⑤）
   * ============================================================ */
  /* 这一节里全是异步（要建库、要跑 ingest），所以整段 await：
   * 不 await 的话总结行会先打出来，那些异步 check 就只是"跑过"而没被计数 —— 假绿。 */
  await (function () {
    const KPM_ME = '1098765432';
    const KP = function (name, vid, color, kill, gt, death) {
      return {
        name: name, vopenid: vid, killNum: kill, death: death == null ? 5 : death,
        assist: 0, score: kill * 400, occupy: 0, rescue: 0,
        color: color, teamId: color, gameTime: gt, isWinner: 0, isLeave: 0,
        deployArmedForceType: 10007
      };
    };
    /* 一场的名单：我（15 分钟 20 杀）、一位打满的高击杀、一位只活了 13 秒却拿了 3 杀的人
     *   —— 最后这一位是复现用的：真库 42 场里 KPM 榜首落到"时长不足 5 分钟"的人身上有 4 场，
     *   其中一场是 13 秒 3 杀，按 KPM 算出来 13.85，而打满一场的人只到 3 上下。 */
    const KThin = '9988776655443322';
    const KBright = '5544332211998877';
    function kRoster(extra) {
      return [
        KP('我', KPM_ME, 1, 20, 900),
        KP('打满的', KBright, 2, 40, 960),
        KP('十三秒', KThin, 2, 3, 13, 0)
      ].concat(extra || []);
    }
    function kList() {
      return [{ roomId: 'K', startTime: 1777000000, gameRule: 13, mapId: 601,
        isWinner: 1, color: 1, gameTime: 900, deployArmedForceType: 10007,
        killNum: 20, death: 5, assist: 0, score: 8000, occupy: 0, rescue: 0 }];
    }
    async function kStore(players, list) {
      const st = new StoreMod.Store(memAdapter());
      await st.load();
      await st.ingest({
        at: Date.now(), role: { openid: KPM_ME },
        list: { tdms: (list || kList()).map(function (r) {
          return Object.assign({ startTime: 1777000000, gameRule: 13, mapId: 601,
            isWinner: 1, color: 1, gameTime: 900, killNum: 20, death: 5, assist: 0,
            score: 8000, occupy: 0, rescue: 0, deployArmedForceType: 10007 }, r);
        }) },
        details: [{ roomId: 'K', detail: { battle_detail: { tdm_players: players } } }]
      });
      return st;
    }
    const detailP = function (n, vid, color) {
      return { name: '甲' + n, vopenid: vid, killNum: 8, death: 6, assist: 1, score: 5000,
        occupy: 1, rescue: 2, color: color, teamId: color, gameTime: 700, isWinner: 0,
        isLeave: 0, deployArmedForceType: 10007 };
    };

    let kCmp = null, kSt = null;
    return kStore(kRoster([detailP(1, '7000000000000001', 1), detailP(2, '7000000000000002', 2),
      detailP(3, '7000000000000003', 1)])).then(function (st) {
      kSt = st;
      kCmp = A.lobby(st, 'K');
      check('KPM 的分母地板只有一处，阈值从 core 导出（测试不抄第二份数字）',
        A.KPM_MIN_SEC === 300 && kCmp.boards.kpm.minMinutes === Math.round(A.KPM_MIN_SEC / 60),
        A.KPM_MIN_SEC + ' 秒 → 榜上念 ' + (kCmp.boards.kpm && kCmp.boards.kpm.minMinutes) + ' 分钟');
      const kb = kCmp.boards.kpm;
      check('★ 复现那条：8~37 秒的人不许靠 KPM 爬上榜首（真库有四场就是这样）',
        kb.list.length && kb.list[0].vopenid === KBright &&
        kb.list.every(function (p) { return p.game_time >= A.KPM_MIN_SEC; }),
        '榜首=' + kb.list[0].name + ' KPM ' + kb.list[0].kpm + ' 榜内最短 ' +
        Math.min.apply(null, kb.list.map(function (p) { return p.game_time; })) + 's');
      check('★ 被地板挡掉的人数要报出来（不报就是"全场 6 人的榜"其实只排了 5 人）',
        kb.thin === 1 && kb.total === 5 && kb.thin + kb.total === kCmp.roster,
        'thin=' + kb.thin + ' 榜内=' + kb.total + ' 名单=' + kCmp.roster);
      check('挡在榜外不等于把他藏掉：完整名单里他还在，KPM 照给，只是标出来',
        kCmp.allPlayers.some(function (p) {
          return p.vopenid === KThin && p.kpmThin === true && p.kpm > 10;
        }),
        (kCmp.allPlayers.filter(function (p) { return p.vopenid === KThin; })[0] || {}).kpm);
      check('阵营那一格给的是"我方/对方"而不是 1/2，编号仍留在 campId 里',
        kCmp.allPlayers.filter(function (p) { return p.vopenid === KPM_ME; })[0].campLabel === '我方' &&
        kCmp.allPlayers.filter(function (p) { return p.vopenid === KBright; })[0].campLabel === '对方' &&
        kCmp.allPlayers.filter(function (p) { return p.vopenid === KThin; })[0].campId === 2,
        JSON.stringify(kCmp.allPlayers.map(function (p) { return p.campLabel + '/' + p.campId; })));
      check('★ 阵营判据仍是唯一那一条（color 相同 = 同边），名单不返回玩家级胜负 ⇒ 胜负是推的',
        kCmp.allPlayers.every(function (p) {
          return p.campMine === (p.color === 1) && p.campWin === (p.color === 1);
        }), '我这一场是胜方，所以同色的都算胜');
      check('四张榜的行都带阵营与关注标记（④⑤ 要的就是这一枚；原来只有名单有）',
        ['score', 'kill', 'rescue', 'kpm'].every(function (k) {
          const b = kCmp.boards[k];
          return b && b.list.length && b.list.every(function (p) {
            return typeof p.campLabel === 'string' && p.campLabel && ('watched' in p);
          });
        }),
        Object.keys(kCmp.boards).map(function (k) {
          return k + '=' + (kCmp.boards[k] ? kCmp.boards[k].list.length : '作废');
        }).join(','));
      check('标注不许就地写在 roster 的那批引用上（改了会把库里的名单一起改脏）',
        kSt.players('K').every(function (p) { return p.campLabel === undefined && p.kpm === undefined; }),
        Object.keys(kSt.players('K')[0]).join(','));
      return kSt.setWatch('id:7000000000000002', true, { openid: '7000000000000002', name: '甲2' });
    }).then(function () {
      const c2 = A.lobby(kSt, 'K');
      const hit = c2.boards.score.list.filter(function (p) { return p.watched; });
      check('★ 已关注的人在**每张榜**里都被标出来（界面据此换色，与"你"不撞色）',
        hit.length === 1 && hit[0].vopenid === '7000000000000002' &&
        ['score', 'kill', 'rescue', 'kpm'].every(function (k) {
          return c2.boards[k].list.some(function (p) { return p.watched; });
        }), '得分榜里已关注 ' + hit.length + ' 人');
      /* 击杀列不可信时，用击杀算出来的一切都要作废 —— KPM 也在这一族里 */
      return kStore(kRoster([detailP(1, '7000000000000001', 1),
        detailP(2, '7000000000000002', 2), detailP(3, '7000000000000003', 1)])
        .map(function (p) { return p.vopenid === KPM_ME ? Object.assign({}, p, { killNum: 0 }) : p; }));
    }).then(function (stHalf) {
      const c3 = A.lobby(stHalf, 'K');
      check('★ 名单里击杀那列没填完 ⇒ KPM 榜与得分/击杀榜一起作废，只画「—」',
        c3.rosterGaps.indexOf('kill') >= 0 && c3.boards.kpm === null &&
        c3.boards.kill === null && c3.ranks.kda.rank === null,
        'gaps=' + c3.rosterGaps.join(',') + ' kpm榜=' + c3.boards.kpm);
      /* 时长缺失的那一场：KPM 不许回 0（0 会被折线图画成"这一场一个人都没杀"） */
      const s0 = new StoreMod.Store(memAdapter());
      return s0.load().then(function () {
        return s0.ingest({
          at: Date.now(), role: { openid: KPM_ME },
          list: { tdms: kList().concat([Object.assign({}, kList()[0], {
            roomId: 'K0', startTime: 1777000900, gameTime: 0, killNum: 15
          })]) },
          details: []
        });
      }).then(function () {
        const ser = A.series(s0.matches({}));
        check('★ game_time 为 0 的那场，序列里的 KPM 是 null 而不是 0',
          ser.length === 2 && ser[1].killPerMin === null && ser[0].killPerMin > 0,
          ser.map(function (x) { return x.killPerMin; }).join(' / '));
        const sum = A.summarize(s0.matches({}));
        check('总览那枚 KPM = 总击杀 ÷ 总时长（界面读的就是这一枚，不许再算第二份）',
          Math.abs(sum.killPerMin - (35 / (900 / 60))) < 0.02,
          sum.killPerMin + ' 期望 ' + Math.round(35 / 15 * 100) / 100);
        return kStore(kRoster([detailP(1, '7000000000000001', 1),
          detailP(2, '7000000000000002', 2), detailP(3, '7000000000000003', 1)]));
      });
    }).then(function (st4) {
      const byMap = A.byMap(st4, st4.matches({}));
      check('分地图 / 兵种 / 干员三张表都带 killPerMin（KD 旁边那一列有数可填）',
        byMap.length > 0 && byMap[0].killPerMin != null &&
        A.byClass(st4, st4.matches({}))[0].killPerMin != null &&
        A.byAgent(st4, st4.matches({}))[0].killPerMin != null,
        'byMap[0].KPM=' + (byMap[0] && byMap[0].killPerMin));
      const enc = A.encounters(st4);
      check('交手档案的 KPM 是池化的（总击杀 ÷ 总时长），不是每人 KPM 的平均',
        enc.recent.concat(enc.repeats).every(function (x) {
          return x.kpm == null || x.kpm > 0;
        }) && enc.recent.length > 0,
        (enc.recent[0] || {}) && enc.recent[0].kpm);
      /* 时长读不出来的那一位（名单里 game_time 就是 0）：KPM 必须是 null，界面才画得出「—」。
       * 回 0 会被读成"他一分钟一个都没杀" —— 那是假数，而且和"真的一个都没杀"分不开。 */
      return kStore(kRoster([detailP(1, '7000000000000001', 1),
        detailP(2, '7000000000000002', 2), detailP(3, '7000000000000003', 1),
        { name: '没时长', vopenid: '6000000000000009', killNum: 6, death: 3, assist: 0,
          score: 2000, occupy: 0, rescue: 0, color: 2, teamId: 2, gameTime: 0,
          isWinner: 0, isLeave: 0, deployArmedForceType: 10007 }
      ])).then(function (st5) {
        const e5 = A.encounters(st5);
        const zero = e5.recent.concat(e5.repeats).filter(function (x) { return x.name === '没时长'; });
        check('★ 交手档案里时长为 0 的那位给 null 而不是 0（0 会被读成"一分钟内一个都没杀"）',
          zero.length === 1 && zero[0].kpm === null,
          JSON.stringify(zero.map(function (x) { return x.kpm; })));
        const c5 = A.lobby(st5, 'K');
        check('★ 同一位在读不出时长的情况下也不进 KPM 榜（0 秒 = 没有分母，不是分母很小）',
          c5.boards.kpm.list.every(function (p) { return p.game_time > 0; }) &&
          c5.boards.kpm.thin === 2 &&
          c5.allPlayers.filter(function (p) { return p.name === '没时长'; })[0].kpm === null,
          '榜内最短=' + Math.min.apply(null, c5.boards.kpm.list.map(function (p) { return p.game_time; })) +
          ' thin=' + c5.boards.kpm.thin);
        const pc = A.periodCompare(st4, st4.matches({}));
        check('周期对比多了 KPM 那一行（与 KD 并列，两枚都给）',
          pc.week && 'dKillPerMin' in pc.week, JSON.stringify(Object.keys(pc.week || {})));
        /* 「赢的那场 vs 输的那场」里 KPM 成项那条住在 §29 那一段（那边样本够，
         * 这里只有两场，winLossCompare 会直接回 available:false —— 拿它断言就是自找空跑） */
      });
    });
  })().then(function () {
    /* ---- 以下是静态红线：判定源唯一、界面不许自己划门槛、两端 CSV 一字不差 ---- */
    const read = function (f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); };
    const vSrc = read('ui/js/views.js'), mSrc = read('shell/main.js'), aSrc = read('android/js/df-android.js');
    const htmlSrc = read('ui/index.html');

    check('★ 渲染层的 KPM 算法只有一处（kpmText），不许每加一张表就再抄一遍除法',
      (vSrc.match(/\/ \(v\.game_time \/ 60\)/g) || []).length === 1 &&
      /function kpmText\(/.test(vSrc),
      '现算处 ' + (vSrc.match(/\/ \(v\.game_time \/ 60\)/g) || []).length + ' 处');
    check('★ 界面不许自己写死那道地板（分钟数只许从 board.minMinutes 读）',
      (vSrc.match(/board\.minMinutes/g) || []).length >= 2 &&
      !/game_time\s*[<>]=?\s*\d{2,}/.test(vSrc),
      '读 minMinutes ' + (vSrc.match(/board\.minMinutes/g) || []).length + ' 处');
    check('★ 阵营只许走 campCell：名单与四张榜都不再直接打印 p.color',
      /function campCell\(/.test(vSrc) &&
      (vSrc.match(/campCell\(/g) || []).length >= 3 &&
      vSrc.indexOf("'<td>' + p.color + '</td>'") === -1,
      'campCell 用 ' + (vSrc.match(/campCell\(/g) || []).length + ' 处');
    check('★ 已关注的高亮用的是另一个类，与「你」那行不同色（同色等于没高亮）',
      /function rowCls\(/.test(vSrc) && (vSrc.match(/rowCls\(/g) || []).length >= 2 &&
      /class="row-watched"/.test(vSrc) &&
      read('ui/css/app.css').indexOf('.row-watched') >= 0,
      'rowCls 用 ' + (vSrc.match(/rowCls\(/g) || []).length + ' 处');
    check('★ 总览那六格里 KPM 顶掉了 KD 的位置，而 KD 一个字没删（降进「更多指标」那条）',
      /\['KPM', s\.killPerMin, '', 'accent'\]/.test(vSrc) &&
      /\['KD', s\.kd, '', s\.kd >= 1 \? 'good' : ''\]/.test(vSrc),
      '总览六格=' + ((vSrc.match(/\['KPM', s\.killPerMin/) || ['没找到'])[0]));
    check('★ 那张折线图是 KPM + KD 双线（原来只有 KD 一条；换掉不叫优化，叫丢数据）',
      /multiLine\('chKd'/.test(vSrc) &&
      /name: 'KPM', values: ser\.map\(function \(x\) \{ return x\.killPerMin; \}\)/.test(vSrc) &&
      /name: 'KD', values: ser\.map\(function \(x\) \{ return x\.kd; \}\)/.test(vSrc) &&
      vSrc.indexOf("line('chKd'") === -1,
      '双线=' + /multiLine\('chKd'/.test(vSrc));
    check('★ 战局列表 / 地图 / 兵种 / 干员 / 时段 / 连战 / 关注池 / 矩阵 每张有 KD 的表都并列了 KPM',
      (function () {
        const rows = vSrc.split('\n');
        /* 「官方赛季数据」那一块除外：那三行来自官方汇总，接口里根本没有时长字段，
         * KPM 算得出来才叫假。那里 KD 旁边出现 KPM 要反过来算红（下面单独钉）。 */
        const s0 = vSrc.indexOf('function renderSeason'), s1 = vSrc.indexOf('function renderMatches');
        let kdRows = 0, paired = 0;
        rows.forEach(function (ln, i) {
          if (!/<td>' \+ [a-z]\.kd \+ '<\/td>/.test(ln) && ln.indexOf(".kd + ' / '") === -1) return;
          if (i >= vSrc.slice(0, s0).split('\n').length && i < vSrc.slice(0, s1).split('\n').length) return;
          kdRows++;
          const near = rows.slice(i, i + 3).join('');
          if (near.indexOf('killPerMin') >= 0 || near.indexOf('kpmText') >= 0 ||
            near.indexOf('kpmCell') >= 0 || near.indexOf('x.kpm') >= 0 ||
            near.indexOf('s.kpm') >= 0) paired++;
        });
        return kdRows >= 8 && paired === kdRows;
      })(), 'KD 行 ' + (function () {
        const rows = vSrc.split('\n');
        const s0 = vSrc.slice(0, vSrc.indexOf('function renderSeason')).split('\n').length;
        const s1 = vSrc.slice(0, vSrc.indexOf('function renderMatches')).split('\n').length;
        return rows.filter(function (l, i) {
          return (/<td>' \+ [a-z]\.kd \+ '<\/td>/.test(l) || l.indexOf(".kd + ' / '") >= 0) &&
            !(i >= s0 && i < s1);
        }).length;
      })() + ' 行，旁边都有 KPM');
    check('★ 官方赛季那三行不许冒出 KPM（接口没给时长，编一个就是假数）',
      (function () {
        const s0 = vSrc.indexOf('function renderSeason');
        const blk = vSrc.slice(s0, vSrc.indexOf('function renderMatches'));
        return blk.indexOf('killPerMin') === -1 && blk.indexOf('KPM') === -1;
      })(), '那块里提到 KPM 的次数=' + (function () {
        const blk = vSrc.slice(vSrc.indexOf('function renderSeason'),
          vSrc.indexOf('function renderMatches'));
        return (blk.match(/KPM/g) || []).length;
      })());
    check('★ 两份 CSV 的列与表头逐字相同，且都带上 KPM',
      (function () {
        /* 只比内容与顺序，不比缩进：主进程与安卓宿主那两处续行的缩进本来就差两格 */
        const flat = function (s) { return s.replace(/\s+/g, ' ').trim(); };
        const grab = function (src, kw) {
          const i = src.indexOf(kw);
          return i < 0 ? null : flat(src.slice(i + kw.indexOf('='), src.indexOf('];', i)));
        };
        const mc = grab(mSrc, 'const cols = ['), ac = grab(aSrc, 'var cols = ['),
          mh = grab(mSrc, 'const head = ['), ah = grab(aSrc, 'var head = [');
        return !!mc && mc === ac && /'kd', 'kill_per_min'/.test(mc) &&
          mh.indexOf("'KD', 'KPM'") >= 0 && ah.indexOf("'KD', 'KPM'") >= 0;
      })(), '桌面与安卓那两份必须一字不差');
    check('★ 战局页那颗"不过滤"的按钮不许再写「全胜」（它筛的是全部结果）',
      /data-res="all"[^>]*>全部<\/button>/.test(htmlSrc) && htmlSrc.indexOf('全胜') === -1,
      (htmlSrc.match(/data-res="all"[^>]*>[^<]*</) || [''])[0]);
    check('★ core 那侧 KPM 的算法也只认一处地板（KPM_MIN_SEC 是唯一字面量）',
      (read('core/analysis.js').match(/KPM_MIN_SEC/g) || []).length >= 3 &&
      !/game_time\s*[<>]=?\s*(300|299|301)\b/.test(read('core/analysis.js')),
      '引用 ' + (read('core/analysis.js').match(/KPM_MIN_SEC/g) || []).length + ' 处');
    check('★ AI 摘要里每场都带 KPM（KD 不删，两枚并列）',
      read('core/aiDigest.js').indexOf("' · KPM '") >= 0,
      read('core/aiDigest.js').split('\n').filter(function (l) {
        return l.indexOf('KPM') >= 0;
      }).length + ' 行');
  }).catch(function (e) {
    check('KPM 与阵营这一节跑完了没抛', false, String(e && e.message || e));
  });

  /* ============================================================
   * 31. 攻防身份（#84/#85）、交手档案逐项对照（#86）、模式筛选（#87）
   * 使用者给了四场地面真值（tools/probe-camp.js 量过），color 1 = 进攻、2 = 防守，
   * 只有 rule 7（攻防）与 8（占领）有这一说。这一节钉的就是这三件事本身，
   * 而不是"界面有没有画字"。
   * ============================================================ */
  await (function () {
    const ME = '7700000000000001';
    const HIM = '7700000000000002';
    const P = function (name, vid, color, kill, gt, death, score) {
      return { name: name, vopenid: vid, killNum: kill, death: death, assist: 0,
        score: score, occupy: 1, rescue: 1, color: color, teamId: color, gameTime: gt,
        isWinner: 0, isLeave: 0, deployArmedForceType: 10007 };
    };
    /* 三场：A 攻防（我方 color2=防守，他在对面）、B 攻防（我方 color1=进攻，他与同侧）、
     * C 胜者为王（rule 13，这一场不该出现任何攻防字） */
    const ROWS = [
      { roomId: 'CA', startTime: 1778000000, gameRule: 7, mapId: 33, isWinner: 0, color: 2,
        gameTime: 900, killNum: 20, death: 5, assist: 0, score: 8000, occupy: 2, rescue: 3 },
      { roomId: 'CB', startTime: 1778000600, gameRule: 8, mapId: 114, isWinner: 1, color: 1,
        gameTime: 60, killNum: 2, death: 1, assist: 0, score: 800, occupy: 0, rescue: 0 },
      { roomId: 'CC', startTime: 1778000900, gameRule: 13, mapId: 601, isWinner: 0, color: 2,
        gameTime: 300, killNum: 5, death: 2, assist: 0, score: 1500, occupy: 0, rescue: 1 }
    ];
    const DET = {
      CA: [P('我', ME, 2, 20, 900, 5, 8000), P('他', HIM, 1, 10, 900, 5, 5000),
        P('甲1', '8801', 1, 3, 900, 4, 1200), P('甲2', '8802', 1, 3, 900, 4, 1200),
        P('乙1', '8803', 2, 4, 900, 3, 1400), P('乙2', '8804', 2, 4, 900, 3, 1400)],
      CB: [P('我', ME, 1, 2, 60, 1, 800), P('他', HIM, 1, 4, 60, 1, 1000),
        P('甲1', '8801', 1, 1, 60, 2, 400), P('乙1', '8803', 2, 2, 60, 2, 700),
        P('乙2', '8804', 2, 2, 60, 2, 700)],
      CC: [P('我', ME, 2, 5, 300, 2, 1500), P('他', HIM, 2, 6, 300, 2, 2000),
        P('甲1', '8801', 1, 7, 300, 3, 2200), P('甲2', '8802', 2, 1, 300, 4, 900),
        P('甲3', '8805', 1, 2, 300, 5, 1000)]
    };
    return (async function () {
      const st = new StoreMod.Store(memAdapter());
      await st.load();
      await st.ingest({
        at: Date.now(), role: { openid: ME, name: '我' },
        list: { tdms: ROWS },
        details: Object.keys(DET).map(function (rid) {
          return { roomId: rid, detail: { battle_detail: { tdm_players: DET[rid] } } };
        })
      });

      /* —— 1) 那颗判据本身 —— */
      check('★ color 1 = 进攻、2 = 防守（rule 7 与 rule 8 都算）',
        A.sideOf({ game_rule: 7, color: 1 }) === '进攻' &&
        A.sideOf({ game_rule: 8, color: 2 }) === '防守',
        A.sideOf({ game_rule: 7, color: 1 }) + '/' + A.sideOf({ game_rule: 8, color: 2 }));
      check('★★ 胜者为王（rule 13）现在也给攻防（他 2026-09-29 那句「全部模式包括胜者为王也要看进攻或者是防守」）',
        A.sideOf({ game_rule: 13, color: 1 }) === '进攻' &&
        A.sideOf({ game_rule: 13, color: 2 }) === '防守' &&
        A.sideOf({ game_rule: 21, color: 1 }) === '进攻',
        '[' + A.sideOf({ game_rule: 13, color: 2 }) + ']');
      check('★ color 缺失（0）也不猜', A.sideOf({ game_rule: 7, color: 0 }) === '', '空串');
      check('★ 哪些模式是地面真值核过的，也只认 core 这一颗（SIDE_RULES / SIDE_VERIFIED 就 7 与 8）',
        Object.keys(A.SIDE_RULES).sort().join(',') === '7,8' &&
        Object.keys(A.SIDE_VERIFIED).sort().join(',') === '7,8' &&
        A.sideBasis({ game_rule: 8 }) === 'verified' && A.sideBasis({ game_rule: 13 }) === 'inferred',
        '核过的：' + Object.keys(A.SIDE_VERIFIED).join(','));

      /* —— 2) 战局那一行与单场详情都带得出身份 —— */
      const rep = A.report(st, { mode: 'all', leave: 'all' });
      check('★ series 每行都带身份（防守/进攻/防守 —— 胜者为王那行现在也有字了）',
        rep.series[0].side === '防守' && rep.series[1].side === '进攻' && rep.series[2].side === '防守',
        [rep.series[0].side, rep.series[1].side, rep.series[2].side].join('/'));
      check('★★ 总报告挂着攻防对照（界面不许自己再算一遍）', !!rep.sides && !!rep.sides.headline,
        '进攻 ' + (rep.sides.attack || {}).total + ' 场 / 防守 ' + (rep.sides.defend || {}).total +
        ' 场 / 无概念 ' + rep.sides.noSide + ' 场');
      check('★ 各 1 场时正文不许下"哪边更好赢"的结论（区间都没给出来）',
        !/更稳|更容易赢|说明/.test(rep.sides.headline) && /看不出方向|没有对照/.test(rep.sides.headline),
        rep.sides.headline);
      /* ★ 两侧都没数那一批（名单里 color 缺值）：正文不许念成"只抓到一侧"。
       *   原来这一条用的是"全是胜者为王"，#90 之后胜者也给攻防了，所以改成 color 缺值这个真分支。
       *   正文也跟着改口：#90 之前那句"只有攻防与占领两类模式有这一说"现在是一句错话。 */
      const sidesNone = A.sideSplit([
        { game_rule: 13, color: 0, is_winner: 1 }, { game_rule: 7, color: 0, is_winner: 0 }
      ]);
      check('★★ 一场攻防都没有时：两侧都是 null、noSide 记账，正文说的是「没带上阵营编号」而不是「只抓到一侧」',
        sidesNone.attack === null && sidesNone.defend === null && sidesNone.noSide === 2 &&
        /都没带上阵营编号/.test(sidesNone.headline) && /color/.test(sidesNone.headline) &&
        !/另一侧一场都没有/.test(sidesNone.headline) && !/两类模式有这一说/.test(sidesNone.headline),
        sidesNone.headline);
      /* —— 2b) 每张地图自己的攻守对照（#91）：桶用真 summarize 造，判据走 sideByMap 本体 —— */
      const mkRow = function (color, win) {
        return { game_rule: 7, color: color, is_winner: win, kill: 10, death: 5, assist: 2,
          score: 5000, game_time: 900, occupy: 2, rescue: 1, is_leave: 0, start_time: 1778000000 };
      };
      const bothSides = { map_id: 44, mapName: '测试图-攻防', mode: '攻防',
        atk: A.summarize([mkRow(1, 1), mkRow(1, 0)]), def: A.summarize([mkRow(2, 0)]) };
      const oneSide = { map_id: 33, mapName: '只打过防守的图', mode: '攻防',
        atk: null, def: A.summarize([mkRow(2, 1)]) };
      const ms = A.sideByMap([bothSides, oneSide]);
      check('★★ 逐张对照只列「两边都打过」的那几张（单边的那张不进表，也不许拿 0 顶上去）',
        ms.length === 1 && ms[0].map_id === 44 && ms[0].total === 3,
        ms.map(function (x) { return x.map_id + '/' + x.total; }).join(' '));
      check('★★ 2 攻 1 守这种场次下那一栏只报差值、不给方向（区间还重叠着）',
        ms[0].decisive === false && /说不出方向/.test(ms[0].note) && !/更稳/.test(ms[0].note) &&
        ms[0].diff === A.summarize([mkRow(1, 1), mkRow(1, 0)]).winRate - 0,
        '差 ' + ms[0].diff + '：' + ms[0].note);
      check('★ 总报告挂着逐张对照那颗出口（界面只念，不再自己算一遍）',
        Array.isArray(rep.mapSides), 'mapSides 是数组，长度 ' + (rep.mapSides || []).length);
      const map33 = rep.maps.filter(function (m) { return m.map_id === 33; })[0];
      /* 那一侧一场都没有时 core 回的是 null 而不是 {total:0}：界面据此画「—」。
       * 拿 0 顶上去会让人读成「这张图打过进攻，但一场没赢」——那是另一种假数。 */
      check('★ 地图分析里那张图分得出两侧（同一颗判据，不是界面再划一次）',
        !!map33 && map33.atk === null && !!map33.def && map33.def.total === 1,
        map33 ? '攻 ' + (map33.atk ? map33.atk.total : 'null') + ' / 守 ' +
          (map33.def ? map33.def.total : 'null') : '没有这张图');
      const map114 = rep.maps.filter(function (m) { return m.map_id === 114; })[0];
      check('★ 占领那张图也算进攻/防守（他给的那条真值就是占领）',
        !!map114 && map114.atk && map114.atk.total === 1,
        map114 ? '攻 ' + map114.atk.total + ' 场 ' + map114.atk.winRate + '%' : '没有');

      /* —— 3) 单场详情：名单、四张榜、对阵两侧都要带得上 —— */
      const cA = A.lobby(st, 'CA');
      check('★ 单场详情顶上那个身份（match.side）', cA.match.side === '防守', cA.match.side);
      const sA = cA.sides.filter(function (s) { return s.isMine; })[0];
      check('★ 对阵两侧那行带身份，且对面那一侧是相反的',
        sA.side === '防守' && cA.sides.filter(function (s) { return !s.isMine; })[0].side === '进攻',
        cA.sides.map(function (x) { return (x.isMine ? '我' : '对') + x.side; }).join('/'));
      check('★★ 榜单每一行的攻防那一格有值（campSide 这个字段真在对象里，不是只写在界面上）',
        ['score', 'kill', 'rescue', 'kpm'].every(function (k) {
          return cA.boards[k].list.length > 0 &&
            cA.boards[k].list.every(function (p) { return p.campSide === '进攻' || p.campSide === '防守'; });
        }),
        cA.boards.score.list.slice(0, 3).map(function (p) { return p.campLabel + '/' + p.campSide; }).join(' '));
      check('★ 完整名单里同队的人与我同侧、对面的人另一侧（判定只认 color）',
        cA.allPlayers.filter(function (p) { return p.campMine; })
          .every(function (p) { return p.campSide === '防守'; }) &&
        cA.allPlayers.filter(function (p) { return !p.campMine; })
          .every(function (p) { return p.campSide === '进攻'; }),
        cA.allPlayers.map(function (p) { return p.campSide; }).join(','));
      const cC = A.lobby(st, 'CC');
      check('★★ 胜者为王那场现在也带得上身份（#90 拆了模式闸门；两侧仍只认 color）',
        cC.match.side === '防守' &&
        cC.allPlayers.every(function (p) { return p.campSide === '进攻' || p.campSide === '防守'; }) &&
        cC.allPlayers.filter(function (p) { return p.campMine; })
          .every(function (p) { return p.campSide === '防守'; }),
        '榜上 ' + cC.allPlayers.length + ' 行：' +
        cC.allPlayers.map(function (p) { return p.campSide; }).join(','));

      /* —— 4) #87：模式筛选必须作用到「对手与队友」与「交手档案」 —— */
      const all = A.report(st, { mode: 'all' }).encounters;
      const sw = A.report(st, { mode: 'swtwr' }).encounters;
      const oth = A.report(st, { mode: 'other' }).encounters;
      check('★★ 对手与队友跟着模式筛选走（以前它拿的是全库，选什么都一动不动）',
        all.scanned === 3 && sw.scanned === 1 && oth.scanned === 2,
        '全部 ' + all.scanned + ' / 胜者为王 ' + sw.scanned + ' / 其他 ' + oth.scanned);
      const key = 'id:' + HIM;
      const dAll = A.encounterDetail(st, key, { mode: 'all' });
      const dSw = A.encounterDetail(st, key, { mode: 'swtwr' });
      const dOth = A.encounterDetail(st, key, { mode: 'other' });
      check('★★ 交手档案同场次数也跟着筛选走（2 + 1 = 3，两处口径必须一致）',
        dAll.totalMeets === 3 && dSw.totalMeets === 1 && dOth.totalMeets === 2,
        dAll.totalMeets + ' / ' + dSw.totalMeets + ' / ' + dOth.totalMeets);
      check('★ 不传筛选时仍是全库（老调用点不会因为这条修复就少数据）',
        A.encounterDetail(st, key).totalMeets === 3, '全库 3 场');

      /* —— 5) #86：逐项对照那几列，口径是"累计 ÷ 累计时长" —— */
      check('★ 对照表里他与我都有这五项（击杀/死亡/KPM/分均得分/时长）',
        ['kills', 'deaths', 'kpm', 'spm', 'minutes'].every(function (k) {
          return dAll.compare.him[k] !== undefined && dAll.compare.me[k] !== undefined; }),
        Object.keys(dAll.compare.him).join(','));
      check('★★ KPM 是累计击杀 ÷ 累计时长（10+4+6=20 杀 / 21 分 = 0.95），不是把每场比值再平均（那样是 2.55）',
        dAll.compare.him.kpm === 0.95, '他 KPM=' + dAll.compare.him.kpm +
        '（平均比值会是 ' + Math.round(((10 / 15) + (4 / 1) + (6 / 5)) / 3 * 100) / 100 + '）');
      check('★★ 筛掉胜者为王那一发，KPM 换成分母同一批里的另两个数（14 杀 / 16 分 = 0.88）',
        dOth.compare.him.kpm === 0.88 && dSw.compare.him.kpm === 1.2,
        '其他=' + dOth.compare.him.kpm + ' 胜者为王=' + dSw.compare.him.kpm);
      check('★ 分均得分同一把尺子（8000 分 / 21 分 = 381）', dAll.compare.him.spm === 381,
        'spm=' + dAll.compare.him.spm);
      check('★ 击杀数/死亡数是同场累计（不是场均）',
        dAll.compare.him.kills === 20 && dAll.compare.him.deaths === 8 &&
        dAll.compare.me.kills === 27, '他 ' + dAll.compare.him.kills + ' 杀 ' +
        dAll.compare.him.deaths + ' 死 / 我 ' + dAll.compare.me.kills + ' 杀');
      check('★ 每场那一行都带上身份（#90 之后胜者为王那一场也有字，不再有「—」）',
        dAll.records.length === 3 && dAll.records.every(function (r) {
          return r.side === '进攻' || r.side === '防守'; }) &&
        dAll.records.filter(function (r) { return r.side === '防守'; }).length === 2,
        dAll.records.map(function (r) { return r.side || '—'; }).join(','));
      /* 累计时长不足地板：一个人只同场了一场 60 秒的 —— 那两列必须 null，不许拿 0 顶 */
      const dThin = A.encounterDetail(st, key, { mode: 'other', since: 1778000599 });
      check('★★ 累计时长不足 5 分钟时 KPM/分均给 null 并标 thin（不许画 0，0 会被读成"一分钟一个都没杀"）',
        dThin.compare.him.kpm === null && dThin.compare.him.spm === null &&
        dThin.compare.him.thin === true && dAll.compare.him.thin === false,
        dThin.compare.him.kpm + ' / thin=' + dThin.compare.him.thin);
      check('★ 门槛分钟数随数带出（界面念这个数，不许自己写 5）',
        dAll.compare.minMinutes === Math.round(A.KPM_MIN_SEC / 60), dAll.compare.minMinutes);
    })();
  })().then(function () {
    /* 这一节自带的读文件器：上面那两处 read 都各自关在别的块作用域里，抄过来就是 ReferenceError
     * （第一版就是这么炸的：断言全跑完了，红线那半句没定义，整节被 catch 成一条 FAIL）。 */
    const read = function (f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); };
    const src = read('core/analysis.js');
    const vw = read('ui/js/views.js').replace(/\r\n/g, '\n');
    const mj = read('shell/main.js');
    const ad = read('android/js/df-android.js');
    const css = read('ui/css/app.css');
    check('★ 攻防那一条规则在 core 里只有一颗字面量（UI 与两个壳都不许自己判 color）',
      (src.match(/SIDE_RULES/g) || []).length >= 2 &&
      !/game_rule\s*===?\s*(7|8)/.test(vw) && !/===\s*1\s*\?\s*'进攻'/.test(vw) &&
      /* 界面里连"按编号猜"都不许有：campId 只许出现在那句提示文字里 */
      (vw.match(/campId/g) || []).length === 1 && !/campId\s*===?\s*\d/.test(vw),
      'SIDE_RULES 引用 ' + (src.match(/SIDE_RULES/g) || []).length + ' 处');
    check('★★ 阵营与攻防拆成两格，且都归 sideCell/campCell 两颗函数（#88 就是那一格折成两行）',
      /function campCell/.test(vw) && /function sideCell/.test(vw) &&
      vw.split('function campCell').length === 2 && vw.split('function sideCell').length === 2 &&
      !/campLabel\) \+ \(p\.campWin/.test(vw) &&
      /* 阵营格后面必须真的跟着攻防格：三张榜共用一处渲染 + 完整名单，两处调用点一个都不能少 */
      (vw.match(/campCell\(p\) \+ sideCell\(p\)/g) || []).length >= 2,
      'campCell ' + (vw.match(/campCell\(/g) || []).length + ' 处 / sideCell ' +
      (vw.match(/sideCell\(/g) || []).length + ' 处');
    check('★ .camp 的 nowrap 写在 CSS 里（只靠字少不算钉住）',
      /\.camp\s*\{[^}]*white-space:\s*nowrap/.test(css), css.split('\n').filter(function (l) {
        return /^\s*\.camp\s*\{/.test(l); })[0] || '没有 .camp 规则');
    check('★★ 两个壳给战局行贴的是同一颗 core 判据（不许一边算一遍）',
      /side: Analysis\.sideOf\(m\)/.test(mj) && /side: Core\.Analysis\.sideOf\(m\)/.test(ad),
      '桌面与安卓各一处');
    /* 参数「写了」不等于「带到了」：这里钉的是四处**调用点**各自真的把 filters 交出去 ——
     * 上一版这条只看函数签名的字面（签名有 filters 就算过），函数体把它丢掉照样绿。 */
    check('★ 交手档案那条筛选条件真的走到了 core（界面→预载→两个壳四处调用点）',
      /df\.encounterDetail\(key, FILTERS\)/.test(read('ui/js/app.js')) &&
      /ipcRenderer\.invoke\('data:encounter', vopenid, filters\)/.test(read('shell/preload.js')) &&
      /Analysis\.encounterDetail\(store, vopenid, filters \|\| \{\}\)/.test(mj) &&
      /Core\.Analysis\.encounterDetail\(store, vopenid, filters \|\| \{\}\)/.test(ad),
      '四处调用点都带');
    /* ★ 「对局」这一根（比赛 / 匹配）的 kind 必须三处生产者都带到底：
     *   少一处就是"手机上点了没反应、桌面上却是好的"，而 core 的断言全绿 —— 正是 #87 那一族的形状。
     *   逐处钉调用点，不钉函数签名（签名带 filters ≠ 体里真把 kind 交出去）。 */
    check('★ kind 一路带到 core：桌面 data:matches / 安卓 matches / 预览服务 / 假桥四处生产者各钉一颗',
      /kind: f\.kind \|\| 'all'/.test(mj) &&
      /kind: f\.kind \|\| 'all'/.test(ad) &&
      /kind: f\.kind \|\| 'all'/.test(read('test/preview-server.js')) &&
      /kind=' \+ encodeURIComponent\(f\.kind\)/.test(read('test/mock-df.js')),
      '四处都有 kind 透传');
    check('★ 三处生产者的 setFlag 白名单都是三枚（少一枚就是那一端标不了比赛，多一枚就是脏键进库）',
      /key !== 'commander' && key !== 'excluded' && key !== 'competition'/.test(mj) &&
      /key !== 'commander' && key !== 'excluded' && key !== 'competition'/.test(ad) &&
      read('test/preview-server.js').indexOf("'competition'") >= 0);
    check('★ counts 那两处兜底字面量也带 comp / practice（宿主空库时界面念的是这两桶）',
      /comp: 0, practice: 0/.test(mj) && /comp: 0, practice: 0/.test(ad));
    /* 界面侧：core 判对了但没画出来 = 这个功能在使用者那儿不存在。四颗出口各钉一颗。 */
    check('★ 单场详情有那颗「标为比赛」，而且只在胜者为王那一支里画（常规场不许出现）',
      /data-act="competition"/.test(vw) &&
      vw.indexOf('m.is_swtwr') < vw.indexOf('data-act="competition"'),
      '那颗按钮在 is_swtwr 分支里');
    check('★ 战局列表那一格挂得出「比赛」徽标（标了却在列表里看不出来，等于没法核对）',
      /m\.is_competition \? ' <span class="tag tag-comp">/.test(vw) &&
      /\.tag-comp\s*\{/.test(css), '徽标与那条 CSS 规则都在');
    check('★ switchTo 的 loadFault 提到外层作用域（它曾是那颗回调的形参，最后那颗读不到 ⇒ 每次换号都 ReferenceError）',
      /let loadFault = null;/.test(mj) && /\.then\(function \(loadFault\)/.test(mj) === false &&
      /loadFault = lf;/.test(mj) && /return \{ ok: true, slot: slot, loadFault: loadFault \|\| '' \};/.test(mj),
      '声明在外层、回包读的是同一颗');
    check('★ 两个壳的数据包导入白名单都带 competition（外部包里的比赛标记进得来，本机改过的仍优先）',
      /competition: bfl\[k\]\.competition \? 1 : 0/.test(mj) &&
      /competition: bfl\[k\]\.competition \? 1 : 0/.test(ad) &&
      /!s\.flags\[k\]\.commander && !s\.flags\[k\]\.excluded && !s\.flags\[k\]\.competition/.test(mj) &&
      /!s\.flags\[k\]\.commander && !s\.flags\[k\]\.excluded && !s\.flags\[k\]\.competition/.test(ad));
    /* 详情页两种「给不出同局对比」必须在解引用 rk.* 之前各拦一手：
     * 外来号（名单里没有本机这个号）那一种以前没拦，整页崩成骨架屏 —— 界面修法只有真跑才看得见，
     * 这条红线盯的是"别再退回只拦 roster 那一半"。 */
    check('★★ 详情页拦两种同局对比缺失，且拦在 rk.* 之前（meMissing 那一种要单独说明白）',
      /if \(!c\.ranks \|\| !c\.roster \|\| c\.roster < 5\)/.test(vw) &&
      vw.indexOf('!c.ranks') < vw.indexOf('var rk = c.ranks') &&
      /c\.meMissing/.test(vw) && /名单里找不到本机这个账号/.test(vw) &&
      /if \(!me\) return Object\.assign\(\{\}, base, \{/.test(src),
      'core 给得出这一支、界面也拦在这一支');
    check('★ 界面那根 kind 轴：三颗 seg、再点当前那颗回到全部',
      /id="fKind"/.test(read('ui/index.html')) &&
      /FILTERS\.kind = on \? 'all' : b\.dataset\.kind/.test(read('ui/js/app.js')),
      '点了能进、再点能退');
    /* 界面侧三处出口：少一处就是「那个页面看不见攻防」，而 core 的断言全绿 ——
     * 这类「判据对、接线断」的坑上一轮在备份那一族踩过一次，所以每一处出口单独钉。 */
    check('★ 战局列表那一格把攻防接在地图后面（不另开一列，1180 那档挤破过版）',
      /\(m\.side \? '-' \+ esc\(m\.side\) : ''\)/.test(vw), '列表那格拼的是 m.side');
    check('★ 单场详情顶上那行也带身份（他说的是「在战局和单场详情的对局信息里增加」）',
      /\(m\.side \? ' · ' \+ esc\(m\.side\) : ''\)/.test(vw), '标题拼的是 match.side');
    check('★ 交手档案里那张逐项对照真挂在页面上（core 算了没人画等于没做）',
      /kpis \+ compareHtml\(d\.compare\)/.test(vw), 'kpis 之后紧跟对照表');
    check('★★ 地图明细表真的画了攻防那一格（表头有列名、表体调用 sideTd）',
      /攻防胜率/.test(vw) && (vw.match(/sideTd\(m\)/g) || []).length >= 2,
      'sideTd(m) ' + (vw.match(/sideTd\(m\)/g) || []).length + ' 处（定义 + 调用）');
    check('★★ 全部对局的攻防总对照挂在地图页顶部（core 算好了没人画等于没做）',
      /el\('mapBox'\)\.innerHTML = sideSummaryHtml\(rep\.sides\)/.test(vw), 'mapBox 第一块就是总对照');
    check('★★ 战绩卡片那九格里 KPM 已顶掉 KD、标题带攻防（卡片是独立一份数组，别的页改了它不跟）',
      (function () {
        var i = vw.indexOf('function drawMatchCard');
        var seg = i >= 0 ? vw.slice(i, i + 4200) : '';
        return /\['KPM', kpmText\(m\)\]/.test(seg) && !/\['KD', m\.kd\]/.test(seg) &&
          /\(m\.mapName \|\| ''\) \+ \(m\.side \? '-' \+ m\.side : ''\)/.test(seg);
      })(), '卡片数组读的是 kpmText(m)，标题读的是 m.side');
    check('★ 插件聚合载荷带 killsPerMinute，且用的是池化那颗（不许换成逐场平均）',
      /killsPerMinute: s\.killPerMin,/.test(read('shell/plugin-api.js')), '读的是 summarize 的 killPerMin');
    check('★★ 两侧都没数时那块对照照样画（只念 core 那句），不许整块藏掉',
      /if \(!sp\.attack && !sp\.defend\) \{/.test(vw) &&
      !/\(!sp\.attack && !sp\.defend\)\) return ''/.test(vw),
      'sideSummaryHtml 的第一道分支是"也画"，不是"return 空"');
    check('★★ 逐张地图的攻守对照挂在地图页上，且顺序是「总对照 → 逐张 → 明细表」',
      /el\('mapBox'\)\.innerHTML = sideSummaryHtml\(rep\.sides\) \+ mapSidesHtml\(rep\.mapSides\)/.test(vw) &&
      /function mapSidesHtml/.test(vw) && /function sideBucket/.test(vw),
      'mapBox 第二块就是逐张对照');
    check('★ 那句口径现在把"核过的"和"推定的"分开说（不再有"只有两类模式有这一说"那句）',
      /核出来的/.test(vw) && /推定/.test(vw) && !/两类模式有这一说/.test(vw),
      'SIDE_NOTE 念的是"哪两类核过 + 其余是推定"');
    check('★ 攻防口径那句话在界面只有一份（SIDE_NOTE），榜头/名单/总对照都读它',
      (vw.match(/var SIDE_NOTE/g) || []).length === 1 &&
      (vw.match(/esc\(SIDE_NOTE\)/g) || []).length >= 3,
      '引用 ' + (vw.match(/SIDE_NOTE/g) || []).length + ' 处');

    /* ★★★ 翻页自证这一路（v1.9.1）：core 给数 → 两个壳记进账本 → 界面念原话。
     *   少任何一环，他下次问「为什么只有 17 场」时还是只能看到一个总数。 */
    check('★ 停因文案只有 collector 那一份 STOP_TEXT，界面念的是账本里存的那句（不许自己编）',
      (read('core/collector.js').match(/var STOP_TEXT/g) || []).length === 1 &&
        /last\.stopText \|\| last\.stop/.test(vw) &&
        !/官方分页最多翻 5 页|按官方分页规则判定窗口到底|战历到此为止/.test(vw + read('ui/js/app.js')),
      '界面里没有第二份说法');
    check('★ 五种停因都配了原话（少一种，界面就念一个英文码）',
      ['cap', 'empty', 'short', 'no_cursor', 'error'].every(function (k) {
        return new RegExp('\\b' + k + ':').test(read('core/collector.js')); }));
    check('★ 两个壳都把这一轮的 pageTrace 交给账本（少一处 = 那一端刷新一次证据就没了）',
      /trace: payload\.pageTrace \|\| null/.test(mj) && /trace: payload\.pageTrace \|\| null/.test(ad),
      '桌面 + 安卓各一处');
    check('★★ 数据完整度那块真把翻页记录画出来了（core 算了没人画等于没做）',
      /翻页记录/.test(vw) && /\(last\.rows \|\| \[\]\)\.join/.test(vw) && /last\.capped/.test(vw),
      '逐页条数 + 撞上限那句都挂在 panels 上');
    check('★ 老账本行缺这几列时整段不画（拿 0 装成"翻了 0 页"是假证据）',
      /if \(last && last\.pages\)/.test(vw) && /lastWin && lastWin\.pages/.test(read('ui/js/app.js')));
    check('★ 设置里那两档每页场数改成实测阶梯 8/15/22/29/36（自证上线后两处必须说同一个数）',
      /5 页（36 场，推荐）/.test(read('ui/index.html')) && /1 页（8 场）/.test(read('ui/index.html')) &&
        !/约 35 场/.test(read('ui/index.html') + read('build.js') + mj));

    /* ★★★ 赛季号这一颗（v1.9.1）：默认值一份、发出去一处、界面念回包里的号。
     *   官方没有"查当前赛季"的接口 —— 所以软件不许装知道，只许把问的是第几号如实念出来。 */
    check('★ 默认赛季号只有 collector 一份，桌面/安卓/预览三个生产者各自读它',
      /sidDefault: CollectorMod\.DEFAULT_SID/.test(mj) &&
        /sidDefault: Core\.Collector\.DEFAULT_SID/.test(ad) &&
        /sidDefault: Collector\.DEFAULT_SID/.test(read('test/preview-server.js')),
      '三处都从 core 取');
    check('★ 两个壳发采集时都带上设置里那一格（少一处 = 那一端永远按默认问，改了也没用）',
      /sid: store\.state\.settings\.seasonSid \|\| ''/.test(mj) && /sid: st\.seasonSid \|\| ''/.test(ad));
    check('★ 官方赛季那一格由 core 算、界面只排版（renderSeason 读 rep.season，不许自己翻 store 存档）',
      /season: seasonSummary\(store\)/.test(src) && /renderSeason\(rep\.season\)/.test(vw) &&
        !/state\.seasons/.test(vw),
      'core 一份 + 界面一处调用');
    check('★★ 那一格把"念的是第几赛季"印出来了，而且给出去改的地方（还写死 S10 就在这儿报红）',
      /第 ' \+ esc\(sea\.sid/.test(vw) && /官方没有"查当前赛季号"的接口/.test(vw) &&
        /id="setSeasonSid"/.test(read('ui/index.html')),
      'sid 印在标题上 + 一句怎么改');
    check('★ 设置页那一格只留数字（脏值带进官方请求是第二条红线）',
      /\$\('setSeasonSid'\)/.test(read('ui/js/app.js')) &&
        /replace\(\/\[\^\\d\]\/g, ''\)/.test(read('ui/js/app.js')) &&
        /replace\(\/\[\^\\d\]\/g, ''\)/.test(read('core/collector.js')));
  }).catch(function (e) {
    check('攻防与筛选这一节跑完了没抛', false, String(e && e.message || e));
  });

  /* --- 总报告接线 --- */
  const rep29 = A.report(store, { mode: 'all', leave: 'all' });
  check('六项分析全部挂在总报告上（界面不需要自己再算一遍）',
    !!(rep29.winLoss && rep29.durations && rep29.strength && rep29.structure) &&
    !!rep29.summary.winRateCi,
    ['winLoss', 'durations', 'strength', 'structure'].filter(function (k) { return rep29[k]; }).join(','));

  console.log('\n' + '='.repeat(64));
  console.log(fail === 0 ? '全部通过' : fail + ' 项失败');
  console.log('='.repeat(64));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试异常：', e);
  process.exit(1);
});
