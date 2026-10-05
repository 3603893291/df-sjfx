/* theme.js — 主题管理：跟随系统 / 浅色 / 深色 */
(function (global) {
  'use strict';

  var mql = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;
  var pref = 'system';     // system | light | dark

  function resolve() {
    if (pref === 'system') return mql && mql.matches ? 'dark' : 'light';
    return pref;
  }

  function apply() {
    var t = resolve();
    document.documentElement.setAttribute('data-theme', t);
    if (global.DFCharts && global.DFCharts.onThemeChange) global.DFCharts.onThemeChange(t);
  }

  function set(next, persist) {
    pref = next || 'system';
    apply();
    var seg = document.getElementById('themeSeg');
    if (seg) {
      Array.prototype.forEach.call(seg.querySelectorAll('.seg'), function (b) {
        b.classList.toggle('active', b.dataset.theme === pref);
      });
    }
    if (persist && global.df && global.df.setSettings) {
      global.df.setSettings({ theme: pref });
    }
  }

  if (mql && mql.addEventListener) {
    mql.addEventListener('change', function () { if (pref === 'system') apply(); });
  }

  global.DFTheme = {
    set: set,
    apply: apply,
    current: function () { return resolve(); },
    pref: function () { return pref; }
  };
})(window);
