#!/usr/bin/env node
/* 软件图标：一张位图源图 → app-icon/app.ico + app-icon/app.png（→ 可选地打进 exe）。

   node tools/make-icon.js [源图]            只生成资产
   node tools/make-icon.js [源图] --apply    顺手把 app.ico 打进 dist 里那个 exe

   为什么分两步：本项目零 npm 依赖、装不了 sharp，缩放只能借本机 .NET 的 System.Drawing（tools/make-icon.ps1）；
   而 ICO 是个纯二进制容器，Node 拼得出来 —— 让 PowerShell 直接吐 32bpp BMP，这边连 PNG 解码器都不必写。
   源图默认取仓库旁边那张 Image_1790083148198_991.jpg，换图就把新路径当第一个参数传进来。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'app-icon');
const ICO = path.join(OUT_DIR, 'app.ico');
const PNG = path.join(OUT_DIR, 'app.png');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const DEFAULT_SRC = path.join(ROOT, '..', 'Image_1790083148198_991.jpg');
/* rcedit 不在仓库里：它是 electron-builder 拉下来的工具，本机有缓存就用，没有就只生成资产 */
const RCEDIT_CANDIDATES = [
  process.env.RCEDIT || '',
  path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache/winCodeSign/winCodeSign-2.6.0/rcedit-x64.exe'),
  path.join(ROOT, 'tools', 'rcedit-x64.exe')
].filter(Boolean);

function die(msg) { console.log(msg); process.exit(1); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* 临时目录，删不掉就算了 */ } }

const argv = process.argv.slice(2);
const src = path.resolve(argv.find(function (a) { return !a.startsWith('--'); }) || DEFAULT_SRC);
if (!fs.existsSync(src)) die('找不到源图：' + src);

/* ---- 1) 缩放交给 PowerShell，产物落在临时目录 ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'df-icon-'));
const ps = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(ROOT, 'tools', 'make-icon.ps1'), '-Src', src, '-Out', tmp],
  { encoding: 'utf8', windowsHide: true });
(ps.match(/^(source|ok).*$/gm) || []).forEach(function (l) { console.log('  · ' + l); });

/* ---- 2) 32bpp BMP → ICO 里的一条 DIB 图像 ---- */
function dibFromBmp(file, size) {
  const b = fs.readFileSync(file);
  if (b.slice(0, 2).toString('ascii') !== 'BM') throw new Error(file + ' 不是 BMP');
  if (b.readUInt32LE(14) !== 40) throw new Error('只要 BITMAPINFOHEADER(40)，这份是 ' + b.readUInt32LE(14));
  if (b.readInt32LE(18) !== size || b.readInt32LE(22) !== size) {
    throw new Error(size + 'px 那份尺寸不对：' + b.readInt32LE(18) + 'x' + b.readInt32LE(22));
  }
  if (b.readUInt16LE(28) !== 32 || b.readUInt32LE(30) !== 0) {
    throw new Error('只要 32bpp 未压缩的 BMP，这份是 ' + b.readUInt16LE(28) + 'bpp / 压缩法 ' + b.readUInt32LE(30));
  }
  const px = b.slice(b.readUInt32LE(10));            // BGRA，行已按 4 字节对齐、自下而上 —— ICO 要的就是这个顺序
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);  // 1bpp AND 掩码全 0：一律看 alpha，不额外抠掉任何像素
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(size, 4);
  hdr.writeInt32LE(size * 2, 8);                     // ★ ICO 的 biHeight 写「图像 + 掩码」两倍高，这是它和 BMP 唯一的区别
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  hdr.writeUInt32LE(0, 16);
  hdr.writeUInt32LE(px.length + mask.length, 20);
  return Buffer.concat([hdr, px, mask]);
}

const images = SIZES.map(function (s) { return dibFromBmp(path.join(tmp, 'icon-' + s + '.bmp'), s); });
const dir = Buffer.alloc(6 + 16 * images.length);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);                             // 1 = 图标（不是组图标）
dir.writeUInt16LE(images.length, 4);
let off = dir.length;
images.forEach(function (img, i) {
  const s = SIZES[i], e = 6 + 16 * i;
  dir.writeUInt8(s >= 256 ? 0 : s, e);               // ★ 256 在字节里写作 0
  dir.writeUInt8(s >= 256 ? 0 : s, e + 1);
  dir.writeUInt8(0, e + 2);
  dir.writeUInt8(0, e + 3);
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(img.length, e + 8);
  dir.writeUInt32LE(off, e + 12);
  off += img.length;
});
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(ICO, Buffer.concat([dir].concat(images)));
fs.copyFileSync(path.join(tmp, 'icon-512.png'), PNG);
rmrf(tmp);
console.log('图标资产已生成：' + path.relative(ROOT, ICO) + '（' + images.length + ' 档 / ' +
  fs.statSync(ICO).size + ' 字节）与 ' + path.relative(ROOT, PNG));

/* ---- 3) 可选：打进 exe ---- */
if (argv.indexOf('--apply') < 0) {
  console.log('只生成了资产。要打进交付包的 exe：node tools/make-icon.js --apply');
  process.exit(0);
}
const rc = RCEDIT_CANDIDATES.find(function (p) { return fs.existsSync(p); });
if (!rc) die('本机没找到 rcedit-x64.exe（试过：' + RCEDIT_CANDIDATES.join(' , ') + '）。资产已生成，exe 没动。');
const exe = path.join(ROOT, 'dist', '三角洲全面战场分析器', '三角洲全面战场分析器.exe');
if (!fs.existsSync(exe)) die('还没有交付包，先 node build.js 再 --apply。');
execFileSync(rc, [exe, '--set-icon', ICO], { windowsHide: true });
console.log('已把 app.ico 打进 ' + path.relative(ROOT, exe));
console.log('★ 资源管理器有图标缓存：看不到变化就换个文件夹视图 / 按 F5，别以为没打进去。');
