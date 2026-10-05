'use strict';
/* ai-leak-scan.js — 用**真实**本机数据复核脱敏摘要有没有漏身份信息
 * 运行：node test/ai-leak-scan.js     （需要先在本机登录并同步过）
 * core.test.js §21 的泄漏扫描跑的是抓包样本，样本里的昵称/ID 覆盖面有限，池子小就等于扫了个空；
 * 只有对真实数据跑，「零命中」这句话才算被证明。
 * 两阶段：① 拿真库里现成的身份扫；② 在内存副本上**主动关注四个人**再扫一遍
 *        （v1.4.0 的 people 表存的是别人的真昵称 + openid，真机通常还没关注过人，①扫不到这条路）。
 * store 适配器是「读真文件 / 写丢弃」，第二阶段用的是深拷贝，所以这一步绝不会碰真实数据。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const StoreMod = require('../core/store');
const AiDigest = require('../core/aiDigest');

const REAL = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'df-swtwr', 'df-swtwr-a1.json');
if (!fs.existsSync(REAL)) {
  console.log('跳过：本机没有 ' + REAL + '\n（先在软件里登录并同步一次，再回来跑这个扫描）');
  process.exit(0);
}
const state = JSON.parse(fs.readFileSync(REAL, 'utf8'));
const store = new StoreMod.Store({ load: () => state, save: () => { throw new Error('不该写盘'); } });
store.state = state;
store._reindex();

const matches = Object.keys(store.state.matches || {});
const rosters = Object.keys(store.state.rosters || {});
console.log('真实数据：' + matches.length + ' 场 / ' + rosters.length + ' 份名单 / slot ' + (store.state.meta.openid || '').slice(0, 6));

/* 泄漏池：所有身份类字段 */
const pool = new Set();
function add(v) { v = String(v == null ? '' : v); if (v.length >= 2) pool.add(v); }
add(store.state.meta.openid); add(store.state.meta.name);
add(store.state.role && store.state.role.openid); add(store.state.role && store.state.role.name);
rosters.forEach(function (k) {
  (store.state.rosters[k].players || []).forEach(function (p) { add(p.name); add(p.vopenid); });
});
matches.forEach(function (k) { add(store.state.matches[k].owner_openid); });
/* v1.4.0 关注名单：存的是**别人**的真昵称 + openid，而聚合键本身就把身份嵌进去了 */
Object.keys(store.state.people || {}).forEach(function (k) {
  const w = store.state.people[k] || {};
  add(k); add(w.name); add(w.openid);
});
const ids = [];
pool.forEach(function (v) { ids.push(v); });
console.log('泄漏池 ' + ids.length + ' 条');

/* 严格池 = 真实身份：昵称（含非数字字符，即不是一串纯数字的临时编号）+ 10 位以上的稳定 ID。
 * 宽松池 = 2~4 位纯数字，官方名单里那是「当局临时编号」（每局重分配，跨局无意义），
 * 它们和「场均击杀 61.5」这类统计值必然撞车，所以只单独计数、不作为泄漏判据。 */
const strict = [], loose = [];
ids.forEach(function (v) {
  const isNum = /^[0-9]+$/.test(v);
  if (!isNum && v.length >= 3) strict.push(v);
  else if (isNum && v.length >= 10) strict.push(v);
  else if (isNum) loose.push(v);
});
const strictIds = strict;
console.log('严格身份池 ' + strictIds.length + ' 条（昵称 + 10 位以上稳定 ID），宽松临时编号 ' + loose.length + ' 条');

let hits = 0, looseHits = 0;
function esc1(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function boundary(v) { return new RegExp('(?<![0-9A-Za-z])' + esc1(v) + '(?![0-9A-Za-z])'); }
function scan(label, text) {
  const bad = [];
  strictIds.forEach(function (v) {
    const m = boundary(v).exec(text);
    if (m) bad.push('★' + v + ' @…' + text.slice(Math.max(0, m.index - 22), m.index + v.length + 22).replace(/\n/g, '⏎') + '…');
  });
  loose.forEach(function (v) { if (boundary(v).test(text)) looseHits++; });
  const long = [];
  (text.match(/\d{10,}|[A-Za-z0-9]{16,}/g) || []).forEach(function (t) {
    const m = boundary(t).exec(text);
    long.push(t + ' @…' + text.slice(Math.max(0, m.index - 26), m.index + t.length + 8).replace(/\n/g, '⏎') + '…');
  });
  const dom = /wegame\.com\.cn/i.test(text);
  if (bad.length || long.length || dom) {
    console.log('HIT ' + label + '  ' + Buffer.byteLength(text) + ' B' +
      (bad.length ? '\n       ' + bad.slice(0, 4).join('\n       ') : '') +
      (long.length ? '\n       长 ID ' + long.slice(0, 2).join('\n       长 ID ') : '') +
      (dom ? '\n       站内域名' : ''));
  } else console.log('ok   ' + label + '  ' + Buffer.byteLength(text) + ' B');
  hits += bad.length + (dom ? 1 : 0);
}

const g = AiDigest.buildGlobalDigest(store, {});
scan('全局摘要（全部时间）', g.text);
const g7 = AiDigest.buildGlobalDigest(store, { since: Math.floor(Date.now() / 1000) - 30 * 86400 });
scan('全局摘要（近 30 天）', g7.text);
const gsw = AiDigest.buildGlobalDigest(store, { mode: 'swtwr' });
scan('全局摘要（胜者为王）', gsw.text);

let n = 0;
matches.forEach(function (rid) {
  const d = AiDigest.buildMatchDigest(store, rid);
  if (!d || d.error) { console.log('skip ' + rid + '  ' + (d && d.error)); return; }
  if (n++ < 12) scan('单场摘要 #' + n + '（' + (d.aliases || []).length + ' 代号）', d.text);
  else strictIds.forEach(function (v) { if (boundary(v).test(d.text)) hits++; });
});
console.log('单场摘要共扫 ' + n + ' 场');
console.log('严格身份泄漏 ' + hits + ' 处；临时编号与统计值的撞车 ' + looseHits + ' 处（不计为泄漏）');

/* ---- 第二阶段：主动造出关注名单再扫（v1.4.0 的 people 表）----
 * 真实数据里通常还没关注任何人，上面那一阶段就扫不到这条路径。这里在**内存副本**上关注
 * 四个真玩家（id: / nm: 两种键各半，键里就嵌着身份），然后重跑摘要。
 * ★ 正对照：先证明这些身份值确实在 report 原文里，否则「摘要 0 命中」只是一句空话。 */
const Analysis = require('../core/analysis');
const clone = JSON.parse(fs.readFileSync(REAL, 'utf8'));
if (!clone.people) clone.people = {};   // 真机 load 时 store.js 会补这个键
const wstore = new StoreMod.Store({ load: () => clone, save: () => Promise.resolve() });
wstore.state = clone;
wstore._reindex();
const cand = [];
rosters.forEach(function (k) {
  (clone.rosters[k].players || []).forEach(function (p) {
    const nm = String(p.name || '').trim(), id = String(p.openid || p.vopenid || '').trim();
    if (nm.length >= 3 && id.length >= 10) cand.push({ name: nm, openid: id });
  });
});
const picked = cand.slice(0, 4);
Promise.all(picked.map(function (p, i) {
  return i % 2 ? wstore.setWatch('nm:' + p.name, true, p)
               : wstore.setWatch('id:' + p.openid, true, p);
})).then(function () {
  const evil = new Set();
  picked.forEach(function (p) {
    [p.name, p.openid, 'id:' + p.openid, 'nm:' + p.name].forEach(function (v) {
      if (v && v.length >= 3) evil.add(v);
    });
  });
  wstore.watched().forEach(function (w) {
    [w.name, w.openid, w.key].forEach(function (v) { if (v && v.length >= 3) evil.add(v); });
  });
  const uv = Array.from(evil);
  const repJson = JSON.stringify(Analysis.report(wstore, {}));
  const inRep = uv.filter(function (v) { return repJson.indexOf(v) !== -1; }).length;

  const wd = [AiDigest.buildGlobalDigest(wstore, {}), AiDigest.buildMatchDigest(wstore, matches[0])]
    .filter(function (d) { return d && !d.error; });
  let wHits = 0;
  wd.forEach(function (d, di) {
    uv.forEach(function (v) {
      const m = boundary(v).exec(d.text);
      if (m) {
        wHits++;
        console.log('HIT(watch) 摘要#' + di + '  ★' + v + ' @…' +
          d.text.slice(Math.max(0, m.index - 22), m.index + v.length + 22).replace(/\n/g, '⏎') + '…');
      }
    });
  });
  console.log('\n关注名单复核：关注 ' + wstore.watched().length + ' 人 / 泄漏池 ' + uv.length +
    ' 条 / report 原文含其中 ' + inRep + ' 条 / 摘要 ' + wd.length + ' 份命中 ' + wHits + ' 处');
  if (!inRep) console.log('⚠ 正对照为空（report 里没有这些身份），本节结论无效');
  const ok = hits === 0 && wHits === 0 && inRep > 0;
  console.log(ok ? '\n真实数据：严格身份零命中（含关注名单与 watchKey）'
                 : '\n真实数据：有问题，见上');
  process.exit(ok ? 0 : 1);
}).catch(function (e) {
  console.error('关注名单复核异常：', e);
  process.exit(1);
});
