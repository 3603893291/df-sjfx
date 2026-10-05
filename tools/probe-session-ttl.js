'use strict';
/* 只读量测：桌面那份 WeGame 会话到底能活多久（只看名字与过期时间，绝不打印值）。
 * 用法：node tools/probe-session-ttl.js [slot] */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');

const slot = process.argv[2] || 'a1';
const src = path.join(process.env.APPDATA, 'df-swtwr', 'Partitions', 'wegame-slot-' + slot, 'Network', 'Cookies');
if (!fs.existsSync(src)) { console.log('没有这个分区：' + src); process.exit(0); }
const tmp = path.join(os.tmpdir(), 'wg-cookies-probe.db');
fs.copyFileSync(src, tmp);

const db = new DatabaseSync(tmp, { readOnly: true });
const rows = db.prepare(
  "SELECT host_key, name, CAST(expires_utc AS TEXT) AS expires_utc, is_persistent FROM cookies " +
  "WHERE host_key LIKE '%wegame%' OR host_key LIKE '%qq.com%' OR host_key LIKE '%weixin%' " +
  "ORDER BY host_key, name").all();
const now = Date.now();
const WIN0_MS = 11644473600000;              // 1601-01-01 → 1970-01-01 的毫秒差
const toMs = us => BigInt(us) === 0n ? null : Number(BigInt(us) / 1000n) - WIN0_MS;

console.log('分区 ' + slot + ' · 相关 cookie ' + rows.length + ' 条（值一律不打印）\n');
const groups = {};
rows.forEach(function (r) {
  const g = (groups[r.host_key] = groups[r.host_key] || []);
  g.push(r);
});
Object.keys(groups).forEach(function (host) {
  console.log('■ ' + host);
  groups[host].forEach(function (r) {
    const ms = toMs(r.expires_utc);
    const days = (ms - now) / 86400000;
    console.log('   ' + (r.name + '                        ').slice(0, 24) +
      (r.is_persistent
        ? (ms > now ? '到 ' + new Date(ms).toISOString().slice(0, 16) + ' UTC（剩 ' + days.toFixed(1) + ' 天）'
          : '★ 已过期 ' + (-days).toFixed(1) + ' 天')
        : '会话级（进程一关就没）'));
  });
});
const auth = rows.filter(r => /^(login_)?(uin|skey|pt4_token|atkn|wlogin_qq_appid|pskey|RK|pt_tokenindex)$/i.test(r.name));
console.log('\n关键会话 cookie（决定"多久要重新扫一次"）：');
auth.forEach(function (r) {
  const ms = toMs(r.expires_utc);
  console.log('  ' + r.host_key + ' ' + r.name + ' → ' +
    (r.is_persistent ? (ms > now ? '剩 ' + ((ms - now) / 86400000).toFixed(1) + ' 天' : '已过期') : '会话级'));
});
db.close();
fs.unlinkSync(tmp);
