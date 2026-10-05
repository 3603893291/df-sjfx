'use strict';
/* team-stats-plugin.test.js — 战队战绩同步插件的口径契约测试（不依赖 Electron / 不联网）
 * 运行：node test/team-stats-plugin.test.js
 *
 * 插件正文是给用户自行导入的外部件，宿主不参与它的计算，所以它的映射只能这样单独钉：
 * 把 plugins-src/team-stats/main.js 在沙箱里跑起来，拿到它注册的定义，
 * 用真样本算出的聚合摘要喂进去，逐项核对那 20 个字段。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');

const StoreMod = require('../core/store');
const { PluginHost } = require('../shell/plugins');
const { createPluginApi } = require('../shell/plugin-api');
const Plg = require('../core/plugin');
const { mkZip } = require('./zip-kit');

const SAMPLE = path.join(__dirname, '..', '..', 'df-analyzer', 'sample', 'sample_data.json');
const SRC = path.join(__dirname, '..', 'plugins-src', 'team-stats', 'main.js');

let fail = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail !== undefined ? '  -> ' + detail : ''}`);
}

/* 文档第 7 节的取值范围与小数位：越界或位数不对，网站会整批拒收 */
const SPEC = {
  matches: [0, 1000000, 0], win_rate: [0, 100, 2], avg_score: [0, 99999, 2], kd: [0, 99999, 2],
  score_per_match: [0, 999999, 2], score_per_minute: [0, 99999, 2], kills: [0, 99999999, 0],
  deaths: [0, 99999999, 0], kda: [0, 99999, 2], kills_per_match: [0, 9999, 2],
  assists_per_match: [0, 9999, 2], sites_per_match: [0, 9999, 2], healing_per_match: [0, 99999999, 2],
  revives: [0, 99999999, 0], best_match_kills: [0, 9999, 0], kill_duration: [0, 99999999, 0],
  quit_rate: [0, 100, 2], max_win_streak: [0, 9999, 0], win_rate_last10: [0, 100, 2], win_rate_last30: [0, 100, 2]
};

(async function () {
  const src = fs.readFileSync(SRC, 'utf8');
  const sandbox = { DFPlugin: null, Promise: Promise, JSON: JSON, Math: Math, Number: Number, String: String, isFinite: isFinite, console: console };
  let def = null;
  sandbox.DFPlugin = {
    register: function (d) { def = d; },
    call: function () { return Promise.resolve({ ok: false }); },
    kv: { get: function () { return Promise.resolve(null); }, set: function () { return Promise.resolve({}); } }
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'team-stats/main.js' });

  check('★ 插件正文能脱离宿主被加载（只依赖 DFPlugin 这一个全局）', !!def && typeof def.mount === 'function');
  check('导出 buildPayload 供口径核对', def && typeof def.buildPayload === 'function');
  check('★ 确认句已经不在插件正文里（判定归宿主）',
    !def.CONSENT_TEXT && !/我已确认/.test(src), '正文里找不到确认句才对');

  /* 真样本 → 真摘要 → 插件的 20 项 */
  const raw = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  const store = new StoreMod.Store({ load: () => null, save: () => {} });
  await store.load();
  await store.ingest({ at: Date.now(), role: raw.role, season: raw.season, list: raw.list, maps: raw.maps, details: raw.details });

  /* 把这个包按用户导入的路径走一遍：打 zip → inspect → install → 启用
   * ★ 清单里 hosts 是 ["*"]（站点地址由使用者在页面上自己填），所以这里不再替换任何占位符 */
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'df-teamstats-'));
  const host = PluginHost({ userDataDir: TMP });
  const DIR = path.join(__dirname, '..', 'plugins-src', 'team-stats');
  const pkgFiles = ['manifest.json', 'ui.html', 'main.js'].map(function (n) {
    return { name: n, data: Buffer.from(fs.readFileSync(path.join(DIR, n), 'utf8'), 'utf8'), method: n === 'main.js' ? 8 : 0 };
  });
  const pv = host.inspectWithBuffers(mkZip(pkgFiles));
  check('★ 这个包本身能被宿主收下', pv.ok === true, pv.message || pv.files.map(f => f.name).join(','));
  const ins = host.install(pv, {
    acceptedScopes: ['view', 'read.summary', 'storage', 'net.request']
  });
  check('全勾之后可安装', ins.ok === true, ins.message || 'enabled=' + ins.plugin.enabled);
  check('启用成功', host.setEnabled('df.team.stats', true).ok === true);
  const api = createPluginApi({ host: host, getStore: function () { return store; } });
  const ID = 'df.team.stats';

  /* ---------- ★ 外发闸门：这句话在清单里，判定在宿主，插件页说了不算 ---------- */
  const consent = (pv.manifest && pv.manifest.consent) || {};
  check('★ 清单里的确认句非空、两栏披露都填了',
    !!consent.sentence && consent.sentence.length >= 12 &&
    (consent.sends || []).length >= 3 && (consent.doesNotSend || []).length >= 3,
    consent.sentence || '(空)');
  check('披露条目每条不超过 60 字（宿主面板要塞得下）',
    [].concat(consent.sends || [], consent.doesNotSend || []).every(function (t) { return t.length <= 60; }));
  check('★ 明细与身份一定在"不会发出去"那一栏',
    (consent.doesNotSend || []).join(' ').indexOf('逐场') !== -1 &&
    (consent.doesNotSend || []).join(' ').indexOf('身份') !== -1);
  const blocked = await api.dispatch(ID, 'net.request', { url: 'https://127.0.0.1/api/auth/login' });
  check('★ 没在宿主这里确认过，登录请求一个字节也发不出去',
    blocked.ok === false && /还没在宿主这里逐字确认/.test(blocked.error || ''), blocked.error);
  check('未确认时 host.info 如实报 consentOk:false / needsConsent:true',
    (await api.dispatch(ID, 'host.info', {})).consentOk === false &&
    (await api.dispatch(ID, 'host.info', {})).needsConsent === true);
  check('★ 逐字输入清单里那句之后才放行',
    host.grantConsent(ID, ' 我　已确认，并将数据上传到我信任的战队网站。 ').ok === true &&
    host.consentOk(ID) === true &&
    (await api.dispatch(ID, 'host.info', {})).consentOk === true);

  const sum = await api.dispatch('df.team.stats', 'summary.get', { mode: 'swtwr' });
  check('胜者为王摘要经能力桥给到插件', sum.ok === true && sum.totals.matches > 0,
    sum.ok ? 'matches=' + sum.totals.matches : sum.error);

  const p = def.buildPayload(sum);
  const keys = Object.keys(p).sort();
  check('★ 正好 20 项，一次发满（网站是整行覆盖）', keys.length === 20, keys.length + ':' + keys.join(','));
  check('★ 默认不带 game_pid（不传即保留网站已有那一份）', !('game_pid' in p));
  check('★ 请求体里没有任何身份参数',
    !['user_id', 'username', 'team_id', 'tenant_id', 'openid', 'password'].some(k => k in p), keys.join(','));
  check('写死的游戏 ID 会带上且被截到 60 字',
    def.buildPayload(sum, 'PID-演示-001').game_pid === 'PID-演示-001');

  Object.keys(SPEC).forEach(function (k) {
    const v = p[k], lim = SPEC[k];
    if (v === null) { check(k + ' 允许为 null（网站显示 —）', true, 'null'); return; }
    const dec = lim[2];
    const scaled = Math.round(v * Math.pow(10, dec));
    check(k + ' 在 ' + lim[0] + '~' + lim[1] + ' 内、小数位 ≤ ' + dec,
      typeof v === 'number' && v >= lim[0] && v <= lim[1] && Math.abs(scaled / Math.pow(10, dec) - v) < 1e-9,
      String(v));
  });

  const t = sum.totals, w = sum.windows, s = sum.streak;
  check('场次 / 胜率 / KD 直接照搬本机口径',
    p.matches === t.matches && p.win_rate === Math.round(t.winRate * 100) / 100 && p.kd === Math.round(t.kd * 100) / 100,
    p.matches + '/' + p.win_rate + '/' + p.kd);
  check('★ avg_score 用的是本面板的结算评分（不是得分）',
    p.avg_score === Math.round(sum.avgRating * 100) / 100 && p.score_per_match === Math.round(t.scorePerMatch * 100) / 100,
    'avg_score=' + p.avg_score + ' score_per_match=' + p.score_per_match);
  check('★ 治疗口径 = 场均救治次数，revives = 累计救治次数',
    p.healing_per_match === Math.round(t.rescuePerMatch * 100) / 100 && p.revives === Math.round(t.rescueTotal),
    p.healing_per_match + ' / ' + p.revives);
  check('★ 站点口径 = 场均占领/互动', p.sites_per_match === Math.round(t.occupyPerMatch * 100) / 100, p.sites_per_match);
  check('★ 击杀时长 = 总时长秒 ÷ 总击杀（秒，取整）',
    p.kill_duration === Math.round(t.totalSeconds / t.kills) && p.kill_duration > 0,
    t.totalSeconds + 's / ' + t.kills + ' = ' + p.kill_duration);
  check('最长连胜取区间内最好那条', p.max_win_streak === Math.round(s.bestWin), p.max_win_streak);
  check('近 10 / 近 30 局胜率跟着本机窗口走，凑不满就留空',
    (w.last10 ? p.win_rate_last10 === Math.round(w.last10.winRate * 100) / 100 : p.win_rate_last10 === null) &&
    (w.last30 ? p.win_rate_last30 === Math.round(w.last30.winRate * 100) / 100 : p.win_rate_last30 === null),
    p.win_rate_last10 + ' / ' + p.win_rate_last30);

  const empty = def.buildPayload({ ok: true, totals: {}, windows: {}, streak: {} });
  check('摘要缺项时全部落成 null，不编 0 出来',
    Object.keys(empty).every(k => empty[k] === null) && Object.keys(empty).length === 20,
    JSON.stringify(empty).slice(0, 60));
  check('零击杀时击杀时长留 null（不炸也不编数）',
    def.buildPayload({ totals: { kills: 0, totalSeconds: 600 }, windows: {}, streak: {} }).kill_duration === null);

  /* 站点地址：只放 https，明文只允许本机；战队目录要保住 */
  check('https + 战队目录通过', def.normSite('https://team.example.com/team-a').url === 'https://team.example.com/team-a');
  check('末尾斜杠被去掉', def.normSite('https://team.example.com/team-a/').url === 'https://team.example.com/team-a');
  check('★ 明文 http 指向外站被拒', def.normSite('http://team.example.com/team-a').ok === false);
  check('本机自测的 http 放行', def.normSite('http://127.0.0.1:8899/team-a').ok === true);
  check('没写协议就当不合法', def.normSite('team.example.com').ok === false);
  check('空地址提示先填', /请先填/.test(def.normSite('').error));

  /* 密码不落盘 */
  check('★ 密码只进登录请求，不进任何持久化调用',
    !/kv\.set\(\s*['"]\w*['"]\s*,\s*[^)]*pw/.test(src) && !/kv\.set\([^)]*password/.test(src));
  check('★ 登录成功后立刻清空密码输入框', /pw.+?value\s*=\s*''/.test(src.replace(/\s+/g, ' ')) ||
    /\$\('pw'\)\.value = ''/.test(src));
  check('插件只声明宿主认过的能力，且站点地址交给使用者自己填', (function () {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'plugins-src', 'team-stats', 'manifest.json'), 'utf8');
    const man = JSON.parse(raw);
    const net = man.permissions.filter(x => x.scope === 'net.request')[0] || {};
    return man.permissions.every(x => Plg.SCOPES[x.scope]) &&
      JSON.stringify(net.hosts) === JSON.stringify([Plg.ANY_HOST]) &&
      !/\{\{[A-Z_]*_HOST\}\}/.test(raw);
  })());

  /* ---------- 拿一个照文档写的模拟站点，走真能力桥把这一趟跑完 ---------- */
  let row = null, pid = '', at = null;
  const hits = [];
  const SITE = http.createServer(function (req, res) {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      const cookie = /PHPSESSID_t9=ses-1/.test(req.headers.cookie || '');
      function out(code, obj, status) {
        res.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      }
      if (req.url === '/team-a/api/auth/login') {
        const j = JSON.parse(body || '{}');
        if (j.username !== '100010001' || j.password !== 'pw-ok') return out(200, { code: 1, msg: '账号或密码错误', data: null });
        res.setHeader('Set-Cookie', ['PHPSESSID_t9=ses-1; Path=/', 'remember_me=r1; Path=/; Max-Age=604800']);
        return out(200, { code: 0, msg: '登录成功', data: { id: 7, username: j.username, nickname: '演示队员', role: 'user' } });
      }
      if (req.url === '/team-a/api/stats/upload') {
        if (!cookie) return out(401, { code: 401, msg: '未登录', data: null }, 401);
        hits.push(Date.now());
        if (hits.length > 10) {
          return out(200, { code: 429, msg: '该账号上传过于频繁：60 秒内最多 10 次，请稍后再试', data: null }, 429);
        }
        const j = JSON.parse(body || '{}');
        const errs = [];
        Object.keys(SPEC).forEach(function (k) {
          if (!(k in j)) return;
          const v = j[k];
          if (v === null) return;
          if (typeof v !== 'number' || !isFinite(v)) { errs.push(k); return; }
          if (v < SPEC[k][0] || v > SPEC[k][1]) errs.push(k);
        });
        if (errs.length) return out(200, { code: 1, msg: '字段不合法：' + errs.join('、'), data: null });
        if (!Object.keys(SPEC).some(function (k) { return j[k] !== null && j[k] !== undefined; })) {
          return out(200, { code: 1, msg: '请至少提交一项战绩指标', data: null });
        }
        const action = row ? 'updated' : 'created';
        row = {};                                        /* ★ 整行覆盖：没传的落 null */
        Object.keys(SPEC).forEach(function (k) { row[k] = (j[k] === undefined) ? null : j[k]; });
        if (j.game_pid) pid = String(j.game_pid);
        at = '2026-09-21 20:00:00';
        return out(200, { code: 0, msg: '战绩已更新', data: { action: action, user_id: 7, nickname: '演示队员', game_pid: pid, uploaded_at: at, stat: row } });
      }
      if (req.url === '/team-a/api/stats/my') {
        if (!cookie) return out(401, { code: 401, msg: '未登录', data: null }, 401);
        return out(200, { code: 0, msg: 'ok', data: {
          fields: Object.keys(SPEC).map(function (k) { return { key: k, label: k, type: SPEC[k][2] ? 'float' : 'int', decimals: SPEC[k][2], min: SPEC[k][0], max: SPEC[k][1], suffix: '', note: '' }; }),
          stat: row, game_pid: pid, uploaded_at: at, first_at: at
        } });
      }
      out(404, { code: 404, msg: 'not found', data: null }, 404);
    });
  });
  await new Promise(function (r) { SITE.listen(0, '127.0.0.1', r); });
  const SITE_BASE = 'http://127.0.0.1:' + SITE.address().port + '/team-a';
  const net = function (opts) { return api.dispatch('df.team.stats', 'net.request', opts); };

  const bad = await net({ url: SITE_BASE + '/api/auth/login', method: 'POST', body: { username: '100010001', password: '错的' } });
  check('密码错时网站回 code=1', bad.ok === true && bad.json && bad.json.code === 1, JSON.stringify(bad.json || bad.error));
  check('★ 未登录就上传会被挡在 401',
    (await net({ url: SITE_BASE + '/api/stats/upload', method: 'POST', body: p })).status === 401);
  const lg = await net({ url: SITE_BASE + '/api/auth/login', method: 'POST', body: { username: '100010001', password: 'pw-ok', remember: 1 } });
  check('登录成功', lg.ok === true && lg.json && lg.json.code === 0, JSON.stringify(lg.json || lg.error));
  const up = await net({ url: SITE_BASE + '/api/stats/upload', method: 'POST', body: def.buildPayload(sum, 'PID-演示') });
  check('★ 20 项一次发满并被网站接受', up.ok === true && up.json && up.json.code === 0,
    JSON.stringify((up.json && (up.json.msg || up.json.code)) || up.error));
  check('第一次是新建这一行', up.json && up.json.data && up.json.data.action === 'created', up.json && up.json.data && up.json.data.action);
  const stored = up.json && up.json.data && up.json.data.stat;
  const sent = def.buildPayload(sum, 'PID-演示');
  check('★ 网站存下来的 20 项与本机发出去的一致',
    Object.keys(SPEC).every(function (k) { return Number(stored[k]) === Number(sent[k]); }),
    Object.keys(SPEC).filter(function (k) { return Number(stored[k]) !== Number(sent[k]); }).join(','));
  check('游戏 ID 按自报值存下来了', up.json.data.game_pid === 'PID-演示', up.json.data.game_pid);

  const only4 = await net({ url: SITE_BASE + '/api/stats/upload', method: 'POST', body: { matches: 1, win_rate: 50, kills: 1, deaths: 1 } });
  check('★ 只发 4 项会把其余 16 项清空（所以必须每次发满）',
    only4.json && only4.json.data && only4.json.data.stat.revives === null && only4.json.data.stat.kd === null);
  const again = await net({ url: SITE_BASE + '/api/stats/upload', method: 'POST', body: sent });
  check('再发一次是覆盖而不是新增', again.json && again.json.data && again.json.data.action === 'updated');

  const over = await net({ url: SITE_BASE + '/api/stats/upload', method: 'POST', body: Object.assign({}, sent, { win_rate: 101 }) });
  check('★ 超上限被拒（code=1）且报出是哪个字段',
    over.json && over.json.code === 1 && /win_rate/.test(over.json.msg), over.json && over.json.msg);
  const mine = await net({ url: SITE_BASE + '/api/stats/my' });
  check('拒掉的那一次没有改动已有战绩',
    mine.json && Number(mine.json.data.stat.win_rate) === Number(sent.win_rate),
    mine.json && mine.json.data && mine.json.data.stat.win_rate);
  check('读回来的 fields 是机器可读的 20 项口径',
    mine.json && mine.json.data && mine.json.data.fields.length === 20);
  check('读回来的 stat 与本机这次算的逐项对得上',
    mine.json && Object.keys(SPEC).every(function (k) { return Number(mine.json.data.stat[k]) === Number(sent[k]); }));

  await api.dispatch('df.team.stats', 'net.clearSession', {});
  check('★ 清掉会话之后网站就不认识你了',
    (await net({ url: SITE_BASE + '/api/stats/my' })).status === 401);
  await net({ url: SITE_BASE + '/api/auth/login', method: 'POST', body: { username: '100010001', password: 'pw-ok' } });
  let limited = '';
  for (let i = 0; i < 12; i++) {
    const r = await net({ url: SITE_BASE + '/api/stats/upload', method: 'POST', body: sent });
    if (r.json && r.json.code === 429) { limited = r.json.msg; break; }
  }
  check('★ 网站的按账号限频能读到（HTTP 429 + code=429）', /过于频繁/.test(limited), limited || '没触发');
  SITE.close();

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不影响结论 */ }

  console.log('\n' + '='.repeat(64));
  console.log(fail === 0 ? '战队战绩插件口径：全部通过' : fail + ' 项失败');
  console.log('='.repeat(64));
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('测试异常：', e);
  process.exit(1);
});
