'use strict';
/* zip-kit.js — 测试用的最小 zip 写入器
 * core.test.js（校验 core/zip.js 的解析）与 plugin-bridge.test.js（造真插件包）共用一份，
 * 免得两处各写一个、改一处漏一处。只支持 stored / deflate，够造测试包。
 */
const zlib = require('zlib');

function crc32(buf) {
  const table = crc32.t || (crc32.t = (function () {
    const a = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let x = n;
      for (let k = 0; k < 8; k++) x = x & 1 ? (0xEDB88320 ^ (x >>> 1)) : (x >>> 1);
      a[n] = x;
    }
    return a;
  })());
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 255];
  return (c ^ -1) >>> 0;
}

/* files: [{ name, data, method:0|8, mode, flags, usize }] */
function mkZip(files) {
  const chunks = [], central = [];
  let off = 0;
  files.forEach(function (f) {
    const name = Buffer.from(f.name, 'utf8');
    const body = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data == null ? '' : f.data), 'utf8');
    const raw = f.method === 8 ? zlib.deflateRawSync(body) : body;
    const crc = f.crc === undefined ? crc32(body) : f.crc;
    const usize = f.usize === undefined ? body.length : f.usize;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(f.flags || 0, 6);
    lh.writeUInt16LE(f.method || 0, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(raw.length, 18);
    lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    chunks.push(lh, name, raw);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(f.flags || 0, 8); ch.writeUInt16LE(f.method || 0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(raw.length, 20); ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(((f.mode || 0o100644) << 16) >>> 0, 38);
    ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += lh.length + name.length + raw.length;
  });
  const cdBuf = Buffer.concat(central), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat(chunks.concat([cdBuf, eocd]));
}

/* 常见压缩工具都会把外层文件夹带进来，用它顺手测「压掉一层根目录」这条路 */
function withRoot(root, files) {
  return files.map(function (f) { return Object.assign({}, f, { name: root + '/' + f.name }); });
}

module.exports = { crc32: crc32, mkZip: mkZip, withRoot: withRoot };
