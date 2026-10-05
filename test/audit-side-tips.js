/* 真库量测（不进 npm test）：小贴士那句「本局双方势均力敌」在真库上到底判错了没有。
 * 走的是 core 自己的 matchTips，不重算一遍口径。 */
'use strict';
const fs = require('fs');
const path = require('path');
const Store = require('../core/store.js').Store;
const A = require('../core/analysis.js');

const f = process.argv[2] || path.join(process.env.APPDATA, 'df-swtwr', 'df-swtwr-a1.json');
const s = new Store({ load: function () { return JSON.parse(fs.readFileSync(f, 'utf8')); }, save: function () {} });

s.load().then(function () {
  const ms = s.state.matches || {}, rs = s.state.rosters || {};
  const ids = Object.keys(ms).filter(k => rs[k] && (rs[k].players || []).length >= 10);
  ids.sort((a, b) => (ms[a].start_time || 0) - (ms[b].start_time || 0));
  console.log('文件：' + f);
  console.log('场次 ' + Object.keys(ms).length + ' 场，其中带全场名单 ' + ids.length + ' 场\n');
  console.log('时间(北京)        胜负  我方n  对面n   我方人均  对面人均   人均差  分差/我方人均  判定');
  const labeled = [];
  ids.forEach(function (k) {
    const m = ms[k], players = rs[k].players;
    const tips = A.matchTips(s, k) || [];
    const t = tips.filter(x => /势均力敌|占上风|一边倒/.test(x.title))[0];
    if (!t) { console.log(new Date((m.start_time||0)*1000+8*36e5).toISOString().slice(5,16) + '  无这一条'); return; }
    const mine = /势均力敌/.test(t.title);
    // 从 core 那条正文里取数（不自己重算，避免口径漂移）
    const nums = (t.text.match(/-?[\d,]+/g) || []).map(x => Number(x.replace(/,/g, '')));
    const ta = nums[0], ea = nums[1];
    const nMy = players.filter(p => p.color === (players.find(q => String(q.vopenid) === String(m.openid)) || {}).color).length;
    const gap = ea - ta;
    const kind = /势均力敌/.test(t.title) ? '势均力敌' : (/一边倒/.test(t.title) ? '一边倒' : '略占上风');
    labeled.push({ k, m, ta, ea, gap, title: t.title, text: t.text, kind, nMy, nAll: players.length });
    console.log([
      new Date((m.start_time || 0) * 1000 + 8 * 36e5).toISOString().slice(5, 16).padEnd(16),
      (m.is_winner ? '胜' : '负') + '    ',
      String(nMy).padStart(5), String(players.length - nMy).padStart(7),
      String(ta).padStart(9), String(ea).padStart(10), String(gap).padStart(9),
      (Math.abs(gap) / Math.max(1, Math.abs(ta)) * 100).toFixed(0).padStart(11) + '%',
      '  ' + t.title
    ].join(' '));
  });
  const even = labeled.filter(x => x.kind === '势均力敌');
  console.log('\n判成「势均力敌」的：' + even.length + ' / ' + labeled.length + ' 场');
  const abs = even.map(x => Math.abs(x.gap)).sort((a, b) => a - b);
  if (abs.length) console.log('这些人均分差的绝对值：最小 ' + abs[0] + ' 中位 ' + abs[Math.floor(abs.length/2)] + ' 最大 ' + abs[abs.length-1]);
  const all = labeled.map(x => Math.abs(x.gap)).sort((a, b) => a - b);
  console.log('全部场次的人均分差绝对值：最小 ' + all[0] + ' 中位 ' + all[Math.floor(all.length/2)] + ' 最大 ' + all[all.length-1]);
  console.log('\n最新那一条原文：');
  const lastL = labeled[labeled.length - 1];
  if (lastL) console.log('  [' + lastL.kind + '] ' + lastL.title + '\n  ' + lastL.text);
}).catch(e => { console.log('ERR ' + e.message); process.exit(1); });
