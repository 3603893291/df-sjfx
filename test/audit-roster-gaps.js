/* 真库量测（不进 npm test）：官方"战局列表"与"单局详情"这两份接口，
 * 在真库的哪几场上不一致、core 的判据（store.rosterGaps）会把哪几场判成半份、
 * 下次同步会重抓哪几场。全部走 core 自己那颗判据，不在这儿重算一遍口径。
 * 只读：load 从文件读，save 是空的，一个字都不回写。
 * 用法：node test/audit-roster-gaps.js [数据包路径] */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../core/store.js');
const Store = S.Store;

const f = process.argv[2] || path.join(process.env.APPDATA, 'df-swtwr', 'df-swtwr-a1.json');
const s = new Store({ load: function () { return JSON.parse(fs.readFileSync(f, 'utf8')); }, save: function () {} });

s.load().then(function () {
  const ms = s.state.matches || {}, rs = s.state.rosters || {};
  const ids = Object.keys(ms).filter(k => rs[k] && (rs[k].players || []).length);
  console.log('文件：' + f);
  console.log('场次 ' + Object.keys(ms).length + ' 场，其中带全场名单 ' + ids.length + ' 场');
  console.log('可信列清单（core 导出）：' + S.ROSTER_TRUST_FIELDS.join(' / ') +
    '；同一场最多自动重抓 ' + S.ROSTER_REFETCH_MAX + ' 次\n');

  const flagged = ids.filter(k => s.rosterGaps(k).length);
  console.log('★ 判成「名单这一列还没填完」的：' + flagged.length + ' / ' + ids.length + ' 场');
  flagged.forEach(function (k) {
    const m = ms[k], gaps = s.rosterGaps(k);
    const mine = (rs[k].players.filter(p => String(p.vopenid) === String(s.activeOpenid()))[0]) || {};
    console.log('  ' + String(m.dt_event_time || '').slice(5, 16).padEnd(14) +
      ' room ' + k + ' 名单' + rs[k].players.length + ' 人  refetch=' + (rs[k].refetch || 0) +
      '  ' + gaps.map(function (g) {
        return g + '：列表=' + (m[g] || 0) + ' 名单里我=' + (mine[g] || 0) +
          ' 全场之和=' + rs[k].players.reduce((t, p) => t + (p[g] || 0), 0);
      }).join('；'));
  });

  const doubt = s.doubtRoomIds();
  const trusted = s.trustedRosterRoomIds();
  console.log('\n★ 下次同步会重抓（doubtRoomIds）：' + doubt.length + ' 场 -> ' + (doubt.join(', ') || '无'));
  console.log('★ 下次同步跳过（trustedRosterRoomIds）：' + trusted.length + ' 场');
  console.log('   两者相加 ' + (doubt.length + trusted.length) + ' = 名单数 ' + Object.keys(rs).length +
    '（必须相等，否则同一场会被两端各算一遍）');

  /* 反向检查：判据只在"列表 > 0 而名单 = 0"一个方向上成立。
   * 名单里比列表大的那些场是真信号（比如列表那一行是中途快照），一律不许进缺值清单。 */
  const bigger = ids.filter(function (k) {
    const mine = (rs[k].players.filter(p => String(p.vopenid) === String(s.activeOpenid()))[0]) || {};
    return S.ROSTER_TRUST_FIELDS.some(g => Number(mine[g] || 0) > Number(ms[k][g] || 0));
  });
  const falsePositive = bigger.filter(k => s.rosterGaps(k).length);
  console.log('\n名单里我某一列 > 列表的那 ' + bigger.length + ' 场里，被误判成缺值的：' +
    falsePositive.length + ' 场' + (falsePositive.length ? ' -> ' + falsePositive.join(', ') : '（判据方向没漏）'));

  const noMe = ids.filter(k => !(rs[k].players || []).some(p => String(p.vopenid) === String(s.activeOpenid())));
  console.log('名单里根本找不到我的场次（判据一律沉默，不编造缺值）：' + noMe.length + ' 场');
}).catch(function (e) { console.log('ERR ' + e.message); process.exit(1); });
