'use strict';
/**
 * 开发者脚本（不进 npm test、不进交付包）：给"多账号切换"那一跑造一份**隔离的**装机目录。
 *
 *   node tools/seed-multi-account-profile.js                 # 临时目录，打印路径
 *   node tools/seed-multi-account-profile.js --out="D:/x/y"  # 指定目录
 *
 * 它只做一件事：**用真的 core/store.js 与真的落盘适配器**写出两份战绩库 + 一枚 accounts.json，
 * 所以文件形状与使用者机器上的一字不差（自己拼 JSON 那种做法会把"形状不对"当成缺陷测出来）。
 *
 * 两个号刻意做得一眼能分：甲 = 样本里全部场次、乙 = 只留最后 2 场，昵称也不同
 * （"探测号甲 / 探测号乙"）。这样"切过去还念着上一个号的场数"是藏不住的。
 * 两枚 openid 各不相连，且都标 imported:true ⇒ 宿主走 localOnly 那一支，
 * 不打网络、不需要真 WeGame 会话就能进主界面（这一跑要量的就是本地数据归属，出网只会添乱）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const StoreMod = require(path.join(ROOT, 'core/store'));
const { createFileStore } = require(path.join(ROOT, 'shell', 'adapters', 'store-node'));
const SAMPLE = path.join(ROOT, '..', 'df-analyzer', 'sample', 'sample_data.json');

function arg(name, dft) {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(hit.indexOf('=') + 1) : dft;
}

const A = { slot: 'a1', openid: 'DFPROBEAAA0000000001', name: '探测号甲' };
const B = { slot: 'a2', openid: 'DFPROBEBBB0000000002', name: '探测号乙' };

async function seed(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const raw = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  const fileA = path.join(outDir, 'df-swtwr-' + A.slot + '.json');
  const fileB = path.join(outDir, 'df-swtwr-' + B.slot + '.json');

  /* 甲：整份样本灌进去 */
  const st = new StoreMod.Store(createFileStore(fileA));
  await st.load();
  await st.ingest({ at: Date.now(), role: raw.role, season: raw.season, list: raw.list, maps: raw.maps, details: raw.details });
  st.state.meta.openid = A.openid;
  st.state.meta.name = A.name;
  st.state.meta.area = 36;
  await st.save();

  /* 乙：从甲落盘的那一份派生，只留最后 2 场（凡是按 room_id 索引的那几张表一起裁）
   * ★ 派生而不是重新灌一份，是为了让两份文件除了"场次与身份"以外形状完全相同 ——
   *   否则测出来的差异可能只是我拼的形状不对。 */
  const j = JSON.parse(fs.readFileSync(fileA, 'utf8'));
  const ids = Object.keys(j.matches || {});
  const keep = new Set(ids.slice(-2));
  for (const k of Object.keys(j)) {
    const v = j[k];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const keys = Object.keys(v);
    /* 判"这张表是按 room_id 索引的"：只要它的键里出现过场次 id 就算（不能要求键数相等 ——
     * rosters 只有 4 份而场次有 8 场，那样判会漏裁，于是两个号的名单份数一模一样，少一个可分辨的信号） */
    const looksRoomKeyed = keys.some((x) => ids.indexOf(x) >= 0);
    if (looksRoomKeyed) {
      for (const rk of keys) if (!keep.has(rk)) delete v[rk];
    }
  }
  j.meta.openid = B.openid;
  j.meta.name = B.name;
  j.meta.sync_windows = [];
  j.meta.first_seen = Date.now();
  fs.writeFileSync(fileB, JSON.stringify(j));

  const now = Date.now();
  const acct = (a) => ({
    slot: a.slot, openid: a.openid, name: a.name, area: 36, accountType: 1,
    partition: 'persist:wegame-slot-' + a.slot, created_at: now, last_sync: now,
    imported: true
  });
  fs.writeFileSync(path.join(outDir, 'accounts.json'), JSON.stringify({
    version: 2, activeSlot: A.slot,
    /* ★ startup.at 必须先填上：那是"这台机器第一次报到"唯一的判据（Update.shouldSend 认的就是它）。
     *   空白档案开机 6 秒后会自己发一发 sec=启动软件 ⇒ 他那台生产服务器的装机数白白多一格，
     *   而这一跑测的是本地切号，一个计数都不该产生。 */
    globalSettings: { theme: 'system', backupDir: '', backupKeep: 7, autoBackup: false, startup: { at: now } },
    accounts: [acct(A), acct(B)]
  }, null, 2));

  return {
    out: outDir,
    a: { slot: A.slot, name: A.name, matches: ids.length },
    b: { slot: B.slot, name: B.name, matches: keep.size }
  };
}

module.exports = { seed, A, B };

if (require.main === module) {
  const out = arg('out', fs.mkdtempSync(path.join(os.tmpdir(), 'df-multi-')));
  seed(out).then((r) => { console.log(JSON.stringify(r, null, 1)); }, (e) => { console.log('崩：' + ((e && e.stack) || e)); process.exit(1); });
}
