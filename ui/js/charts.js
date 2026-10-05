/* charts.js — ECharts 封装，自动跟随主题 */
(function (global) {
  'use strict';

  var charts = {};

  /* 丢掉一个实例：dispose 会把容器上的 _echarts_instance_ 标记一起摘掉，
   * 所以下一次 echarts.init 才认这个容器是干净的。只 delete 不 dispose 是漏的。 */
  function drop(id) {
    var c = charts[id];
    if (c && !c.isDisposed()) c.dispose();
    delete charts[id];
  }

  function palette() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      text: dark ? '#98989D' : '#6E6E73',
      textStrong: dark ? '#F5F5F7' : '#1D1D1F',
      grid: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)',
      accent: dark ? '#0A84FF' : '#0071E3',
      green: dark ? '#30D158' : '#34C759',
      orange: dark ? '#FF9F0A' : '#FF9500',
      red: dark ? '#FF453A' : '#FF3B30',
      area: dark ? 'rgba(10,132,255,0.18)' : 'rgba(0,113,227,0.12)'
    };
  }

  function base(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    // 容器不可见时尺寸为 0，此时初始化会得到坏实例，直接跳过；
    // 切换页面时 app.js 会用缓存数据重画，届时尺寸已正确。
    if (!el.offsetWidth || !el.offsetHeight) {
      if (charts[id]) drop(id);
      return null;
    }
    /* ★ 自愈：登记的实例只有在"画布还挂在这个容器上"时才作数。
     *   视图在空数据分支里把容器 innerHTML 清空、或整块换掉面板，都会把画布摘走，
     *   而复用那个实例等于把 setOption 画进一个游离节点 —— 界面就永久空白了（切回有数据也不回来）。 */
    if (charts[id] && (charts[id].getDom() !== el || !el.firstElementChild)) drop(id);
    if (!charts[id] || charts[id].isDisposed()) {
      charts[id] = global.echarts.init(el, null, { renderer: 'canvas' });
    }
    return charts[id];
  }

  function axis(p) {
    return {
      axisLine: { lineStyle: { color: p.grid } },
      axisTick: { show: false },
      axisLabel: { color: p.text, fontSize: 11 },
      splitLine: { lineStyle: { color: p.grid } }
    };
  }

  function tooltip() {
    return {
      trigger: 'axis',
      backgroundColor: 'rgba(30,30,32,0.94)',
      borderWidth: 0,
      textStyle: { color: '#F5F5F7', fontSize: 12 },
      padding: [8, 12]
    };
  }

  function line(id, cats, values, name, colorKey, opts) {
    var c = base(id);
    if (!c) return;
    var p = palette();
    opts = opts || {};
    var color = p[colorKey] || p.accent;
    c.setOption({
      grid: { left: 50, right: 18, top: 18, bottom: 34 },
      tooltip: tooltip(),
      xAxis: Object.assign({ type: 'category', data: cats, boundaryGap: false }, axis(p)),
      yAxis: Object.assign({ type: 'value', scale: !!opts.scale }, axis(p)),
      series: [{
        name: name, type: 'line', data: values,
        smooth: 0.35,
        symbol: 'circle', symbolSize: 6, showSymbol: cats.length <= 40,
        lineStyle: { color: color, width: 2 },
        itemStyle: { color: color, borderWidth: 0 },
        areaStyle: opts.area ? { color: p.area } : null
      }]
    }, true);
  }

  /* 横向条形（地图胜率等） */
  function hbar(id, labels, values, colorKey, unit) {
    var c = base(id);
    if (!c) return;
    var p = palette();
    var color = p[colorKey] || p.accent;
    c.setOption({
      grid: { left: 120, right: 46, top: 8, bottom: 20 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        backgroundColor: 'rgba(30,30,32,0.94)', borderWidth: 0,
        textStyle: { color: '#F5F5F7', fontSize: 12 },
        formatter: function (a) { return a[0].name + '：' + a[0].value + (unit || ''); }
      },
      xAxis: Object.assign({ type: 'value' }, axis(p)),
      yAxis: Object.assign({ type: 'category', data: labels }, axis(p)),
      series: [{
        type: 'bar', data: values, barWidth: 14,
        itemStyle: { color: color, borderRadius: [0, 7, 7, 0] },
        label: {
          show: true, position: 'right', color: p.text,
          fontSize: 11, formatter: '{c}' + (unit || '')
        }
      }]
    }, true);
  }

  /* 柱 + 线组合（每日场次 + 胜率） */
  function combo(id, cats, bars, lines) {
    var c = base(id);
    if (!c) return;
    var p = palette();
    c.setOption({
      grid: { left: 46, right: 46, top: 18, bottom: 34 },
      tooltip: tooltip(),
      legend: { show: true, textStyle: { color: p.text, fontSize: 11 }, top: 0, right: 0 },
      xAxis: Object.assign({ type: 'category', data: cats }, axis(p)),
      yAxis: [
        Object.assign({ type: 'value', name: '' }, axis(p)),
        Object.assign({ type: 'value', max: 100, splitLine: { show: false } }, axis(p))
      ],
      series: [
        { name: bars.name, type: 'bar', data: bars.values, barWidth: 12,
          itemStyle: { color: p.accent, borderRadius: [4, 4, 0, 0] } },
        { name: lines.name, type: 'line', yAxisIndex: 1, data: lines.values,
          smooth: true, symbolSize: 5,
          lineStyle: { color: p.orange, width: 2 }, itemStyle: { color: p.orange } }
      ]
    }, true);
  }

  /* 纵向柱状（分布图） */
  function vbar(id, cats, values, colorKey, unit) {
    var c = base(id);
    if (!c) return;
    var p = palette();
    var color = p[colorKey] || p.accent;
    c.setOption({
      grid: { left: 44, right: 16, top: 26, bottom: 30 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        backgroundColor: 'rgba(30,30,32,0.94)', borderWidth: 0,
        textStyle: { color: '#F5F5F7', fontSize: 12 },
        formatter: function (a) { return a[0].name + '：' + a[0].value + (unit || ''); }
      },
      xAxis: Object.assign({ type: 'category', data: cats }, axis(p)),
      yAxis: Object.assign({ type: 'value' }, axis(p)),
      series: [{
        type: 'bar', data: values, barWidth: '46%',
        itemStyle: { color: color, borderRadius: [6, 6, 0, 0] },
        label: { show: true, position: 'top', color: p.text, fontSize: 11 }
      }]
    }, true);
  }

  /* 多折线（胜率 / 评分并列对比） */
  function multiLine(id, cats, lines) {
    var c = base(id);
    if (!c) return;
    var p = palette();
    c.setOption({
      grid: { left: 46, right: 46, top: 30, bottom: 34 },
      tooltip: tooltip(),
      legend: { show: true, textStyle: { color: p.text, fontSize: 11 }, top: 0, right: 0 },
      xAxis: Object.assign({ type: 'category', data: cats, boundaryGap: false }, axis(p)),
      yAxis: Object.assign({ type: 'value' }, axis(p)),
      series: lines.map(function (l) {
        var col = p[l.color] || p.accent;
        return {
          name: l.name, type: 'line', data: l.values, smooth: 0.35,
          symbol: 'circle', symbolSize: 5, showSymbol: cats.length <= 40,
          lineStyle: { color: col, width: 2 },
          itemStyle: { color: col },
          areaStyle: l.area ? { color: col, opacity: 0.10 } : null
        };
      })
    }, true);
  }

  function onThemeChange() {
    Object.keys(charts).forEach(function (id) {
      var c = charts[id];
      if (c && !c.isDisposed()) c.resize();
    });
  }

  function resizeAll() {
    Object.keys(charts).forEach(function (id) {
      var c = charts[id];
      if (c && !c.isDisposed()) c.resize();
    });
  }

  global.DFCharts = {
    line: line, hbar: hbar, combo: combo, vbar: vbar, multiLine: multiLine,
    onThemeChange: onThemeChange, resize: resizeAll,
    /* ★ 视图里要「这块图暂时没数据」就调它，别自己 container.innerHTML='' ——
     *   那样画布被摘走而实例还在，下一次 setOption 就画进游离节点，图永久空白。 */
    clear: function (id) { drop(id); var el = document.getElementById(id); if (el) el.innerHTML = ''; },
    clearAll: function () {
      Object.keys(charts).forEach(function (id) { drop(id); });
      charts = {};
    }
  };
})(window);
