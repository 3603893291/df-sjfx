/* 「名单不全」这枚徽标，在装进手机的那份 views.js 里画不画得出来。
 *
 * 为什么要单独验这一条：判据与接缝都在离线测试里钉过了（core 25 条 + 安卓 5 条），
 * 但"装进 APK 的那份渲染代码真跑起来会挂出什么字"只有设备上说得清 ——
 * 模拟器那份库里多半没有半份名单的场次，所以这里把渲染函数的入参顶成半份再喊一次，
 * 跑完立刻用真实行重画回去（一个字节的数据都不改）。
 *
 * 跑法：node tools/android-cdp.js --serial=127.0.0.1:16384 --file=test/device/roster-gap-badge.js
 * 前置：先在登录页点「跳过，直接看本机数据」进主界面（否则列表本来就没渲染，见 recheck-hides-skip.js）。
 */
(async function () {
  await window.__dfReady;
  var rows = await window.df.matches({ mode: 'all', leave: 'all' });
  var out = {
    rows: rows.length,
    rowsWithArray: rows.filter(function (r) { return Array.isArray(r.rosterGaps); }).length,
    rowsActuallyHalf: rows.filter(function (r) { return (r.rosterGaps || []).length; })
      .map(function (r) { return r.dt_event_time + ' ' + r.rosterGaps.join(); }),
    renderPath: rows.length && document.querySelectorAll('#matchTable tbody tr').length + ' 行已渲染'
  };
  function draw(rs) {
    window.DFViews.renderMatches(rs, { total: rs.length, poolSize: rs.length });
    var b = document.querySelector('#matchTable .tag-soft');
    return {
      rows: document.querySelectorAll('#matchTable tbody tr').length,
      badges: document.querySelectorAll('#matchTable .tag-soft').length,
      badgeText: b ? b.innerText : null,
      badgeTitle: b ? b.getAttribute('title') : null,
      rowHead: b && b.closest('tr') ? b.closest('tr').innerText.replace(/\s+/g, ' ').slice(0, 34) : null
    };
  }
  var forced = rows.slice();
  forced[0] = Object.assign({}, forced[0], { rosterGaps: ['rescue', 'occupy'] });
  out.forced = draw(forced);
  out.real = draw(rows);            // 还原：按真实行重画
  return JSON.stringify(out, null, 1);
})()
