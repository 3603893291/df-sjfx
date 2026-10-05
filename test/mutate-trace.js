'use strict';
/* 变异桩（v1.9.1 那两件：① 采集翻页自证 pageTrace ② 官方赛季号不再写死）。
 * 起因是他那句「为什么有用户只获取了 17 场，但是他打了很多把对局啊」，以及跟着看到的第二件事：
 *   「官方赛季数据」那一格在每个人机器上都是空的 —— 界面早在 v1.0 就画了 renderSeason(sea)，
 *   可 core 里一份都没算过，rep.season 从来不存在。两件都属于同一种缺陷形状：
 *   **数只在同步那一刻存在，链路断在哪一环，用户手上就什么都没有了。**
 * 所以这一套逐环打桩：collector 记 → 回包带 → 两个壳交账 → store 落盘 → analysis 算 → 界面念 → 设置那格跟着发。
 * 跑法：node test/mutate-trace.js
 *       node test/mutate-trace.js T3,T7
 *       DF_ANCHOR_AUDIT=1 node test/mutate-trace.js   （只验锚点，几秒）
 * ★ 这套脚本会改 core/ 与 shell/ 与 android/ 与 ui/ 的源码再还原 —— 一次只准跑一套，
 *   别跟别的变异桩或别的编辑并行（同一份源码树）。 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const R = f => path.join(__dirname, '..', f);
const FILES = ['core/collector.js', 'core/store.js', 'core/analysis.js',
  'shell/main.js', 'android/js/df-android.js', 'test/preview-server.js',
  'ui/js/views.js', 'ui/js/app.js'];
const bak = {};
FILES.forEach(f => { bak[f] = fs.readFileSync(R(f), 'utf8'); });
function restore() { FILES.forEach(f => fs.writeFileSync(R(f), bak[f])); }
function patch(file, from, to) {
  const src = fs.readFileSync(R(file), 'utf8');
  if (src.indexOf(from) === -1) throw new Error('锚点没找到: ' + file + ' :: ' + from.slice(0, 46));
  fs.writeFileSync(R(file), src.split(from).join(to));
}

const CJ = 'core/collector.js';
const CS = 'core/store.js';
const CA = 'core/analysis.js';
const MJ = 'shell/main.js';
const AD = 'android/js/df-android.js';
const PS = 'test/preview-server.js';
const VJ = 'ui/js/views.js';
const AJ = 'ui/js/app.js';

function runCore() {
  return cp.spawnSync(process.execPath, [path.join(__dirname, 'core.test.js')],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 << 20 }).stdout || '';
}
function runAndroid() {
  return cp.spawnSync(process.execPath, [path.join(__dirname, 'android-shim.test.js')],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 << 20 }).stdout || '';
}
const SUITES = { core: runCore, android: runAndroid };

/* ---------------- ① 翻页自证：collector 记 ---------------- */
const TRACE_MOUNT = '            out.pageTrace = tr;   /* 先按引用挂上：中途失败那一发也要让界面看得到记到第几页 */';
const PUSH_PAGE = '                tr.pages.push({ depth: depth, rows: tdms.length, kept: all.tdms.length - before });';
const ADD_ROWS = '                tr.rows += tdms.length;';
const ADD_KEPT = '                tr.kept += all.tdms.length - before;';
const STOP_CAP = "                if (depth >= pages) { stopHere('cap'); return null; }";
const STOP_TEXT_LINE = '              tr.stopText = STOP_TEXT[code] || code;';

/* ---------------- ② 赛季号：collector 发 ---------------- */
const SID_LINE = "      var sid = String(opts.sid || DEFAULT_SID).replace(/[^\\d]/g, '') || DEFAULT_SID;";
const SID_ECHO = '      out.sid = sid;';
const REPORT_CALL = "self.api('GetBattleReport', Object.assign({}, b, { sid: sid, queue: QUEUE }))";
const MAPS_CALL = '              sid: sid, queue: QUEUE, mapids: Maps.tdmIds';

const MUT = [
  ['T1 pageTrace 不先挂引用（中途失败那一发界面就什么自证都看不到）', () => patch(CJ, TRACE_MOUNT, '            /* 跑完再挂 */'), 'core'],
  ['T2 逐页记录不再 push（"翻了 3 页"变成"翻了 0 页"）', () => patch(CJ, PUSH_PAGE, ''), 'core'],
  ['T3 每页回来几条不再累加（rows 恒 0，判不出官方到底给了多少）', () => patch(CJ, ADD_ROWS, ''), 'core'],
  ['T4 去重后留下几条不再累加（少了 4 条看不出是被判重吃掉的）', () => patch(CJ, ADD_KEPT, ''), 'core'],
  ['T5 撞上限那一轮报成 short（"官方窗口到底"与"我们只翻了一页"混成一句）', () => patch(CJ, STOP_CAP, "                if (depth >= pages) { stopHere('short'); return null; }"), 'core'],
  ['T6 停因退化成英文码（界面念一个 cap / empty，那句话等于没说）', () => patch(CJ, STOP_TEXT_LINE, '              tr.stopText = code;'), 'core'],
  ['T7 赛季号写死回内置默认（设置里改了那一格没用 —— 这正是这一次要修的那一颗）', () => patch(CJ, SID_LINE, '      var sid = DEFAULT_SID;'), 'core'],
  ['T8 赛季号不做数字清洗（脏值直接进官方请求）', () => patch(CJ, SID_LINE, '      var sid = String(opts.sid || DEFAULT_SID);'), 'core'],
  ['T9 回包不回 out.sid（界面拿不到"这一轮问的是第几号"，只能猜）', () => patch(CJ, SID_ECHO, "      out.sid = '';"), 'core'],
  ['T10 只有赛季汇总跟着改，分地图统计仍按默认问（一个号两发问出两套数）', () => patch(CJ, MAPS_CALL, '              sid: DEFAULT_SID, queue: QUEUE, mapids: Maps.tdmIds'), 'core'],
  ['T11 反过来：只有分地图统计跟着改，赛季汇总仍按默认问', () => patch(CJ, REPORT_CALL, "self.api('GetBattleReport', Object.assign({}, b, { sid: DEFAULT_SID, queue: QUEUE }))"), 'core'],

  /* ---------------- ① 翻页自证：落盘 ---------------- */
  ['T12 账本不存停因原话（界面刷新一次就没得念，只能自己编一句）', () => patch(CS, "      stopText: (w.trace && w.trace.stopText) || '',", ''), 'core'],
  ['T13 缺列的老实录 0 改成编一个 1（老账本行被说成"翻了 1 页"= 假证据）', () => patch(CS, '      pages: (w.trace && w.trace.pages && w.trace.pages.length) || 0,', '      pages: (w.trace && w.trace.pages && w.trace.pages.length) || 1,'), 'core'],
  ['T14 逐页条数一律记空数组（"每页回来 8/7 条"那句没了）', () => patch(CS, '      rows: (w.trace && w.trace.pages ? w.trace.pages.map(function (p) { return p.rows; }) : []),', '      rows: [],'), 'core'],
  ['T15 去重后条数一律记 0（看起来像"抓回来全被判重吃了"）', () => patch(CS, '      kept: (w.trace && w.trace.kept) || 0,', '      kept: 0,'), 'core'],
  ['T16 capped 永远为假（那句"再往前就采不到了"永远不说）', () => patch(CS, "      capped: !!(w.trace && w.trace.stop === 'cap')", '      capped: false'), 'core'],

  /* ---------------- ③ 官方赛季汇总：core 算 ---------------- */
  ['T17 总报告不带 season（回到那个面板永远空白的老样子）', () => patch(CA, '      season: seasonSummary(store),', ''), 'core'],
  ['T18 多赛季存档按键名取而不是按时间（换了赛季号还念旧的）', () => patch(CA, '      if (!best || (Number(v.at) || 0) > (Number(best.at) || 0)) best = v;', '      if (!best) best = v;'), 'core'],
  ['T19 官方回空壳也算得出"本赛季 0 场"（把没数据说成数据）', () => patch(CA, '    if (!Number(mp.total_fight) && !Number(st.tdmTotalFight)) return null;', '    /* 空壳也照样往下算 */'), 'core'],
  ['T20 生涯胜率忘了乘 100（官方回的是比例，界面念成 0.46%）', () => patch(CA, '        winRate: r2((Number(st.tdmSuccessRatio) || 0) * 100),', '        winRate: r2(Number(st.tdmSuccessRatio) || 0),'), 'core'],
  ['T21 不回显 sid（那一格说不出自己念的是第几赛季）', () => patch(CA, "      sid: String(sea.sid || ''),", "      sid: '',"), 'core'],
  ['T22 0 场的图也进聚合（官方那 72 行里的空行把明细拉成一堆 0）', () => patch(CA, '      return m && Maps.isSWWR(m.mapid) && Number(m.total) > 0;', '      return m && Maps.isSWWR(m.mapid);'), 'core'],
  ['T23 胜者为王那一行的胜率改成"各图比率求平均"（3 场的图和 41 场的图同权）', () => patch(CA, '        winRate: total ? r2((win / total) * 100) : 0,', '        winRate: rows.length ? r2(rows.reduce(function (a, x) { return a + (Number(x.total) ? Number(x.win) / Number(x.total) * 100 : 0); }, 0) / rows.length) : 0,'), 'core'],

  /* ---------------- ② 两个壳：交账 + 带号（这两针跑安卓那一套，行为端到端） ---------------- */
  ['T24 桌面不把 pageTrace 交给账本（那一轮的证据当场丢）', () => patch(MJ, '        trace: payload.pageTrace || null', '        trace: null'), 'core'],
  ['T25 安卓不把 pageTrace 交给账本（手机上问"为什么只有 17 场"永远没答案）', () => patch(AD, '          trace: payload.pageTrace || null', '          trace: null'), 'android'],
  ['T26 桌面发采集时不带设置里的赛季号', () => patch(MJ, "    sid: store.state.settings.seasonSid || '',", "    sid: '',"), 'core'],
  ['T27 安卓发采集时不带设置里的赛季号（改了格还是不生效 —— 就是 F13 那一族）', () => patch(AD, "      sid: st.seasonSid || '',", "      sid: '',"), 'android'],

  /* ---------------- ④ 界面：念出来（core 算了没人画等于没做） ---------------- */
  ['T28 那一格不再调 renderSeason（core 算好了没人画）', () => patch(VJ, '    renderSeason(rep.season);', ''), 'core'],
  ['T29 数据完整度那块去掉"有翻页记录才画"的门槛（老账本行被画成翻了 0 页）', () => patch(VJ, '    if (last && last.pages) {', '    if (last) {'), 'core'],
  ['T30 界面自己编一句停因（第二份说法必漂移，且盖掉 core 那句）', () => patch(VJ, "        '<br>停在这里的原因：<b>' + esc(last.stopText || last.stop || '未记录') + '</b>' +", "        '<br>停在这里的原因：<b>抓完了</b>' +"), 'core'],
  ['T31 顶上状态行去掉 lastWin.pages 门槛（同上，拿 0 装成没翻页）', () => patch(AJ, '    if (lastWin && lastWin.pages) {', '    if (lastWin) {'), 'core'],
  ['T32 设置那一格不再清洗输入（脏值写进存档、下一发就发给官方）', () => patch(AJ, "      var v = String(sid.value || '').replace(/[^\\d]/g, '');", "      var v = String(sid.value || '');"), 'core'],
  ['T33 预览这第三个生产者不给默认赛季号（浏览器里那一格念不出"留空 = 第 N 赛季"）', () => patch(PS, '          sidDefault: Collector.DEFAULT_SID,', ''), 'core']
];

const ONLY = (process.argv[2] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const SELECTED = ONLY.length ? MUT.filter(m => ONLY.some(id => m[0].toUpperCase().startsWith(id + ' '))) : MUT;
if (!SELECTED.length) { console.log('一条都没匹配上：' + ONLY.join(',')); process.exit(1); }

/* 只验锚点、不跑套件：锚点清单只有这一份，check-mutation-anchors 现读现打（抄第二份必然漂移） */
if (process.env.DF_ANCHOR_AUDIT === '1') {
  let bad = 0;
  SELECTED.forEach(function (m) {
    restore();
    try { m[1](); console.log('  锚点在 ' + m[0]); }
    catch (e) { bad++; console.log('  !!! ' + m[0] + ' → ' + e.message); }
  });
  restore();
  console.log('mutate-trace：' + (bad ? bad + ' 针打不上' : '锚点全在'));
  process.exit(bad ? 1 : 0);
}

const seen = {};
SELECTED.forEach(function (m) {
  restore();
  const runner = SUITES[m[2]] || runCore;
  let out;
  try { m[1](); } catch (e) { console.log('\n' + m[0] + ' → 变异没打上：' + e.message); return; }
  out = runner();
  const fails = out.split('\n').filter(l => /FAIL/.test(l)).map(l => l.trim().slice(0, 92));
  const ranClean = /全部通过|项失败/.test(out);
  console.log('\n' + m[0] + ' → ' + (fails.length && ranClean ? 'RED ' + fails.length + ' 条'
    : (!ranClean ? '!!! 套件压根没跑完（结论不能用）!!!' : '!!! 没变红 !!!')));
  fails.slice(0, 3).forEach(l => console.log('      ' + l));
  seen[m[2]] = (seen[m[2]] || 0) + (fails.length ? 1 : 0);
});
restore();
['core', 'android'].forEach(function (k) {
  const out = (SUITES[k] || runCore)();
  console.log('还原后 ' + k + '：' + (/FAIL/.test(out)
    ? '仍有 FAIL：' + out.split('\n').filter(l => /FAIL/.test(l)).slice(0, 3).join(' | ')
    : (/全部通过/.test(out) ? '全部通过' : '没跑到结论')));
});
