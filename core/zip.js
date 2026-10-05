/* zip.js — 插件包的 zip 结构解析与路径安全校验（纯 JS，UMD：只认字节，不碰 fs / 不碰 zlib）
 *
 * 为什么解包自己做：本项目零 npm 依赖（不装 unzip 库），而插件包要求是标准 zip
 * （任何压缩工具都产得出）。这里只解析结构并交出**原始压缩字节**，inflate 由 shell 层
 * 用 Node 的 zlib 做 —— 保持 core 不碰任何平台 API（分层铁律见手册 §2）。
 *
 * 安全前提：一个 zip 就是「别人写的一棵目录树」。所以 checkSafety() 必须在落盘之前跑完，
 * 任何一条不过就整包拒绝，不做「能救多少救多少」。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.DFCore = root.DFCore || {}; root.DFCore.Zip = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SIG_EOCD = 0x06054b50, SIG_CD = 0x02014b50, SIG_LOCAL = 0x04034b50;
  var METHOD_STORE = 0, METHOD_DEFLATE = 8;
  var MAX_ENTRIES = 200;
  var MAX_ENTRY_BYTES = 2 * 1024 * 1024;
  var TOTAL_BUDGET = 8 * 1024 * 1024;
  /* 压缩比超过这个数按 zip 炸弹处理（正常 JS/文本到不了 300×） */
  var MAX_RATIO = 300;

  function u16(b, p) { return b[p] | (b[p + 1] << 8); }
  function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
  function txt(b) {
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('utf-8').decode(b); } catch (e) { /* fallthrough */ }
    }
    var s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  function fail(reason, message) { return { ok: false, reason: reason, message: message }; }

  /* EOCD 定长在末尾 22 字节起，但尾部可挂最长 65535 字节注释，所以往前扫 */
  function findEocd(b) {
    var lo = Math.max(0, b.length - 65557);
    for (var p = b.length - 22; p >= lo; p--) {
      if (u32(b, p) === SIG_EOCD) return p;
    }
    return -1;
  }

  function parse(bytes) {
    var b = bytes;
    if (!b || b.length < 22) return fail('too_small', '文件太小，不像是 zip');
    var e = findEocd(b);
    if (e < 0) return fail('no_eocd', '没找到 zip 的目录结尾标记 —— 这个文件不是有效的 zip 包');

    var count = u16(b, e + 10), cdSize = u32(b, e + 12), cdOff = u32(b, e + 16);
    if (count === 0xFFFF || cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
      return fail('zip64', '暂不支持 ZIP64 格式的包（插件包正常远用不到这个量级）');
    }
    if (cdOff + cdSize > e) return fail('bad_cd', 'zip 目录位置不对，包已损坏');
    if (count > MAX_ENTRIES) {
      return fail('too_many', '包内条目 ' + count + ' 个，超过上限 ' + MAX_ENTRIES + ' 个');
    }

    var entries = [], p = cdOff, total = 0;
    for (var i = 0; i < count; i++) {
      if (p + 46 > b.length || u32(b, p) !== SIG_CD) {
        return fail('bad_cd', '解析 zip 目录到第 ' + (i + 1) + ' 项时错位，包已损坏');
      }
      var flags = u16(b, p + 8), method = u16(b, p + 10);
      var csize = u32(b, p + 20), usize = u32(b, p + 24);
      var nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32);
      var extAttr = u32(b, p + 38), loff = u32(b, p + 42);
      var name = txt(b.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;

      if (flags & 1) return fail('encrypted', '不接受加密的插件包 —— 内容必须能被检查，才谈得上给你看权限清单');
      if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
        return fail('method', '包内有不支持的压缩方式（编号 ' + method + '），只接受「存储」与 Deflate');
      }
      if (loff + 30 > b.length || u32(b, loff) !== SIG_LOCAL) {
        return fail('bad_local', '条目「' + name + '」的本地文件头位置不对，包已损坏');
      }
      if (u16(b, loff + 6) & 1) return fail('encrypted', '不接受加密的插件包 —— 内容必须能被检查，才谈得上给你看权限清单');
      var dataStart = loff + 30 + u16(b, loff + 26) + u16(b, loff + 28);
      if (dataStart + csize > b.length) return fail('bad_local', '条目「' + name + '」的数据超出文件范围');

      total += usize;
      entries.push({
        name: name,
        dir: /\/$/.test(name),
        method: method,
        /* unix 权限位藏在 external attributes 的高 16 位，S_IFLNK = 0xA000 */
        symlink: ((extAttr >>> 16) & 0xF000) === 0xA000,
        compressedSize: csize,
        size: usize,
        raw: b.subarray(dataStart, dataStart + csize)
      });
    }
    return { ok: true, entries: entries, totalSize: total };
  }

  /* 落盘前必须过一次。一次性把所有问题列出来，不挤牙膏。 */
  function checkSafety(parsed, opts) {
    var o = opts || {};
    var maxEntries = o.maxEntries || MAX_ENTRIES;
    var maxEntry = o.maxEntryBytes || MAX_ENTRY_BYTES;
    var budget = o.totalBytes || TOTAL_BUDGET;
    var problems = [];
    if (!parsed || !parsed.ok) return { ok: false, problems: [(parsed && parsed.message) || '包无法解析'] };

    var list = parsed.entries;
    if (!list.length) problems.push('包是空的');
    if (list.length > maxEntries) problems.push('包内条目 ' + list.length + ' 个，超过上限 ' + maxEntries + ' 个');
    if (parsed.totalSize > budget) {
      problems.push('解压后约 ' + (Math.round(parsed.totalSize / 1048576 * 10) / 10) + ' MB，超过上限 ' +
        Math.round(budget / 1048576) + ' MB');
    }

    var seen = {};
    list.forEach(function (en) {
      var n = en.name, why = '';
      if (!n) why = '有条目名为空';
      else if (n.indexOf('\\') >= 0) why = '条目名里有反斜杠（不是合法的 zip 路径分隔）：' + n;
      else if (/^[A-Za-z]:/.test(n)) why = '条目名带盘符：' + n;
      else if (n.charAt(0) === '/' || n.charAt(0) === '~') why = '条目名是绝对路径：' + n;
      else if (n.split('/').some(function (s) { return s === '..' || s === '.'; })) why = '条目名里含 ../ 或 ./：' + n;
      else if (/[\x00-\x1f]/.test(n)) why = '条目名里有控制字符';
      else if (en.symlink) why = '条目是符号链接，一律不接受：' + n;
      else if (!en.dir) {
        if (en.size > maxEntry) why = '「' + n + '」解压后 ' + en.size + ' 字节，超过单文件上限 ' + maxEntry + ' 字节';
        else if (en.compressedSize > 0 && en.size / en.compressedSize > MAX_RATIO) {
          why = '「' + n + '」压缩比异常（' + Math.round(en.size / en.compressedSize) + ' 倍），按 zip 炸弹拒收';
        }
      }
      if (!why) {
        var key = n.toLowerCase();
        /* 同一目录下的 `a.js` 与 `A.js` 在 Windows 上会互相覆盖，等于包里有两条内容争一个落点 */
        if (seen[key]) why = '条目名在 Windows 下重名：「' + seen[key] + '」与「' + n + '」';
        else seen[key] = n;
      }
      if (why) problems.push(why);
    });
    return { ok: !problems.length, problems: problems };
  }

  /* 解出的名字还要再过一次这道关 —— 拼路径之前必须确认它不会跳出插件目录 */
  function isSafeRelPath(name) {
    if (!name || typeof name !== 'string') return false;
    if (name.indexOf('\\') >= 0 || /^[A-Za-z]:/.test(name) || name.charAt(0) === '/') return false;
    if (/[\x00-\x1f]/.test(name)) return false;
    var segs = name.split('/');
    if (segs.some(function (s) { return s === '..' || s === '.' || /^[~$]/.test(s); })) return false;
    return true;
  }

  function byteLength(u8) { return u8 ? u8.length : 0; }

  return {
    parse: parse, checkSafety: checkSafety, isSafeRelPath: isSafeRelPath, byteLength: byteLength,
    METHOD_STORE: METHOD_STORE, METHOD_DEFLATE: METHOD_DEFLATE,
    MAX_ENTRIES: MAX_ENTRIES, MAX_ENTRY_BYTES: MAX_ENTRY_BYTES,
    TOTAL_BUDGET: TOTAL_BUDGET, MAX_RATIO: MAX_RATIO
  };
});
