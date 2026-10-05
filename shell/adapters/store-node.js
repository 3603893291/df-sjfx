'use strict';
/* 存储适配器（Node 文件实现）
 * 只负责「读一个对象 / 写一个对象」，业务逻辑全在 core 层
 *
 * ★★ 这一份以前有一个会把人整库弄没的做法：`load()` 里一个 catch 包到底 ——
 *   「读不出来」（杀软/索引器攥句柄的 EPERM、EBUSY、EMFILE、权限、正在被写）
 *   和「文件真的坏了」（JSON 解析不动）走的是同一条路：把真库 rename 走、回 null。
 *   回 null 在 core 那边就是"这号还没数据"，于是下一次 save() 在原路径写一份**空的**。
 *   本机就是 Windows，攥句柄那一条不是假想（同一场测试里 `renameSync` 就 EPERM 过两次）。
 *   现在的规矩：**读不动就一个字都不动、把原因抛出去**；只有"字节读到了但解析不动"才叫损坏，
 *   那种才挪走留证据。写没读过成功的库由 `core/store.js` 那道闸门挡住（双保险）。
 */
const fs = require('fs');
const path = require('path');

/* Windows 实测：刚写出来的 .tmp 常被杀软/索引器攥着句柄，renameSync 当场 EPERM。
 * 这是战绩库唯一的落盘口，静默丢掉这一次保存 = 白跑一场采集，所以宁可多试几次再抛。 */
function renameInto(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); }
    catch (e) {
      if (i >= 4) throw e;
      const until = Date.now() + 80;
      while (Date.now() < until) { /* 让句柄松开，几十毫秒够 */ }
    }
  }
}

/* 读也是同一类病：句柄攥着的那几十毫秒里 readFileSync 会抛 EPERM/EBUSY。
 * 判"坏"之前先重读一次，否则一次瞬态就把人的库说成空的。 */
function readTextRetry(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    const until = Date.now() + 120;
    while (Date.now() < until) { /* 等句柄松 */ }
    return fs.readFileSync(filePath, 'utf8');   // 还是读不动就让它抛出去，由调用方说实话
  }
}

function createFileStore(filePath) {
  return {
    path: filePath,
    load() {
      let txt;
      if (!fs.existsSync(filePath)) return null;         // 真没有这个文件 = 确实还没数据
      try {
        txt = readTextRetry(filePath);
      } catch (e) {
        /* ★ 读不动：文件还在原位，一个字节都不许动，把原因喊出去 */
        throw new Error('读不出来（文件没动）：' + (e.code ? e.code + ' ' : '') + (e.message || e));
      }
      if (!txt) return null;                             // 空文件当"还没数据"（原行为）
      try {
        return JSON.parse(txt);
      } catch (e) {
        /* 到这一步才叫"坏了"：字节明明读到了却解析不动。挪走留证据，但仍然抛 ——
         * 回 null 就是"没数据"，紧接着一次 save() 会把这份挪走的原位写成空的。 */
        let bak = '';
        try {
          bak = filePath + '.corrupt-' + Date.now();
          fs.renameSync(filePath, bak);
        } catch (_) { /* 连挪都挪不动：那更不能写，只把解析失败这一句抛出去 */ }
        throw new Error('战绩库解析不动：' + (e.message || e) +
          (bak ? '，原文件已挪到 ' + path.basename(bak) : '，原文件没能挪动，仍在原位'));
      }
    },
    save(state) {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      renameInto(tmp, filePath);
    }
  };
}

module.exports = { createFileStore };
