/* stats.js — 统计口径（纯 JS，UMD，零依赖）
 *
 * 为什么要单独一个文件：官方只回最近约 36 场，落到单个地图 / 时段 / 胜负分组常常只剩 3~8 场。
 * 这种样本量下"胜率 67% vs 33%"完全可以只是噪声，而界面一旦把这种数字画成结论，用户就会照着改打法。
 * 所以区间、可靠性判定与相关性只在这里算一份，分析层与界面层都不许再各写一套 ——
 * 判定源每多一个，就多一条把噪声说成结论的通道。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.DFCore = root.DFCore || {};
    root.DFCore.Stats = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 95% 双侧：z=1.96。这里写死一个常数，是为了让全软件的区间口径唯一 */
  var Z95 = 1.96;
  /* 低于这个场数不给区间：Wilson 在 n<3 时会给出"0%~100%"这类毫无信息量的东西，
   * 画出来反而误导。此时只报场数。 */
  var CI_MIN_N = 3;
  /* 区间半宽超过这个百分点，就当作"看不出方向"（措辞要降级，不许写「你擅长…」） */
  var WIDE_PP = 15;

  function r2(v) { return Math.round(v * 100) / 100; }
  function r1(v) { return Math.round(v * 10) / 10; }

  function mean(values) {
    var a = numbers(values);
    if (!a.length) return null;
    return a.reduce(function (x, y) { return x + y; }, 0) / a.length;
  }
  function numbers(values) {
    return (values || []).map(Number).filter(function (v) { return isFinite(v); });
  }
  function sd(a) {
    if (a.length < 2) return 0;
    var m = mean(a), s = 0;
    for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / (a.length - 1));
  }

  /* 胜率的 Wilson 区间（比正态近似稳：n 小或 p 贴近 0/1 时不会越界、不会塌成一点） */
  function wilson(wins, n) {
    n = Number(n) || 0;
    if (n < CI_MIN_N) return null;
    wins = Math.max(0, Math.min(n, Number(wins) || 0));
    var p = wins / n;
    var z2 = Z95 * Z95;
    var den = 1 + z2 / n;
    var ctr = (p + z2 / (2 * n)) / den;
    var half = (Z95 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / den;
    return {
      n: n, point: r1(p * 100), lo: r1(Math.max(0, (ctr - half)) * 100),
      hi: r1(Math.min(1, (ctr + half)) * 100), half: r1(half * 100)
    };
  }

  /* 均值的区间：正态近似（n 小的时候它偏窄，所以只用于"量级"而不是"判定"） */
  function meanInterval(values) {
    var a = numbers(values);
    if (a.length < CI_MIN_N) return null;
    var m = mean(a), s = sd(a), half = Z95 * s / Math.sqrt(a.length);
    return { n: a.length, mean: r2(m), lo: r2(m - half), hi: r2(m + half), half: r2(half) };
  }

  /* 两组的均值差：给「赢的那场 vs 输的那场」这类对照用。
   * 不做假设检验只给区间 —— 样本 15 vs 12 的情况下，报一个 p 值只会给人虚假的确信。 */
  function diffInterval(a, b) {
    var x = meanInterval(a), y = meanInterval(b);
    if (!x || !y) return null;
    var sa = sd(numbers(a)), sb = sd(numbers(b));
    var se = Math.sqrt(sa * sa / x.n + sb * sb / y.n);
    var d = x.mean - y.mean;
    var half = Z95 * se;
    return {
      nA: x.n, nB: y.n, a: x.mean, b: y.mean, diff: r2(d),
      lo: r2(d - half), hi: r2(d + half),
      /* 区间跨过 0 = 这两组的差别说不出方向，界面必须按"看不出差别"来措辞。
       * ★ 用 <=：两组数完全一样时 half 会塌成 0，写成 < 会让"差恰好为 0"被判成"看得出方向" */
      crossesZero: (d - half) * (d + half) <= 0
    };
  }

  /* 可靠性：把"场数 + 区间宽度"合成一个界面能直接用的档位 */
  function reliability(n, ci) {
    if (!n || n < CI_MIN_N) return 'none';
    if (!ci) return 'thin';
    if (ci.half > WIDE_PP) return 'thin';
    return 'ok';
  }
  /* 一句话脚注：每个胜率类结论都带上它，别让用户拿 3 场当结论 */
  function ciText(ci, unit) {
    if (!ci) return '';
    unit = unit || '%';
    return '（n=' + ci.n + '，95% 区间 ' + ci.lo + '~' + ci.hi + unit + '）';
  }

  function pearson(xs, ys) {
    var a = numbers(xs), b = numbers(ys);
    var n = Math.min(a.length, b.length);
    if (n < CI_MIN_N) return null;
    a = a.slice(0, n); b = b.slice(0, n);
    var ma = mean(a), mb = mean(b), sab = 0, saa = 0, sbb = 0;
    for (var i = 0; i < n; i++) {
      var da = a[i] - ma, db = b[i] - mb;
      sab += da * db; saa += da * da; sbb += db * db;
    }
    if (saa <= 0 || sbb <= 0) return null;   // 有一项是常数：相关度无定义，别硬编成 0
    return r2(sab / Math.sqrt(saa * sbb));
  }

  /* 高斯消元（列主元）。矩阵坏了就返回 null，让调用方降级成"算不出"而不是给个错数 */
  function solve(A, b) {
    var n = b.length, M = [], i, j, k;
    for (i = 0; i < n; i++) M.push(A[i].slice().concat([b[i]]));
    for (k = 0; k < n; k++) {
      var p = k;
      for (i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
      if (Math.abs(M[p][k]) < 1e-9) return null;
      var t = M[k]; M[k] = M[p]; M[p] = t;
      for (i = k + 1; i < n; i++) {
        var fac = M[i][k] / M[k][k];
        if (!isFinite(fac)) return null;
        for (j = k; j <= n; j++) M[i][j] -= fac * M[k][j];
      }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) {
      var s = M[i][n];
      for (j = i + 1; j < n; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
      if (!isFinite(x[i])) return null;
    }
    return x;
  }

  /* 标准化偏回归系数（beta）：回答"控制其他项之后，这一项还和结果同向变动多少"。
   * 用它而不是简单相关，是因为击杀/助攻/得分彼此高度共线 —— 单看相关会把共线的伙伴都夸成功臣。
   * 返回 null 的情况：样本不足、某项是常数、矩阵奇异（几项彼此完全重复）。 */
  function betas(target, features) {
    var lists = (features || []).map(numbers);
    var t = numbers(target);
    if (!lists.length) return null;
    var n = Math.min(t.length, Math.min.apply(null, lists.map(function (a) { return a.length; })));
    /* 多元回归至少要"每项各 5 场"才谈得上稳定，否则 beta 会乱跳 */
    if (n < Math.max(8, lists.length * 5)) return null;
    t = t.slice(0, n);
    lists = lists.map(function (a) { return a.slice(0, n); });
    var k = lists.length, R = [], rv = [], i, j;
    for (i = 0; i < k; i++) {
      R.push([]);
      rv.push(pearson(lists[i], t));
      if (rv[i] === null) return null;
      for (j = 0; j < k; j++) {
        var r = i === j ? 1 : pearson(lists[i], lists[j]);
        if (r === null) return null;
        R[i].push(r);
      }
    }
    var b = solve(R, rv);
    if (!b) return null;
    return { n: n, keys: null, values: b.map(r2), corrWithTarget: rv };
  }

  /* 一场的成绩在"你自己的分布"里排第几：并列取中点，和评分页的百分位口径一致 */
  function percentileOf(sortedAsc, value) {
    var a = numbers(sortedAsc);
    if (!a.length) return null;
    var v = Number(value);
    if (!isFinite(v)) return null;
    var below = 0, equal = 0;
    for (var i = 0; i < a.length; i++) {
      if (a[i] < v) below++;
      else if (a[i] === v) equal++;
    }
    if (a.length === 1) return 50;
    return r1(((below + equal * 0.5) / a.length) * 100);
  }

  function zOf(values, value) {
    var a = numbers(values);
    if (a.length < CI_MIN_N) return null;
    var s = sd(a);
    if (!s) return null;
    return r2((Number(value) - mean(a)) / s);
  }

  return {
    Z95: Z95, CI_MIN_N: CI_MIN_N, WIDE_PP: WIDE_PP,
    mean: mean, sd: sd, numbers: numbers,
    wilson: wilson, meanInterval: meanInterval, diffInterval: diffInterval,
    reliability: reliability, ciText: ciText,
    pearson: pearson, betas: betas, solve: solve,
    percentileOf: percentileOf, zOf: zOf
  };
});
