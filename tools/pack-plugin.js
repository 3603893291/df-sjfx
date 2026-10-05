'use strict';
/* pack-plugin.js — 把 plugins-src/<目录> 打成可直接导入的 .zip 插件包
 *
 *   node tools/pack-plugin.js demo-summary
 *   node tools/pack-plugin.js demo-summary --root     多带一层外层目录（试宿主的压平逻辑）
 *
 * 打包用的是 test/zip-kit.js —— 和自检里造测试包同一个写入器，
 * 这样"我们发出去的包"与"测试里验过的包"字节一致。
 * 出包前先用 core/plugin.js 的解析器过一遍：清单不合法就别怪宿主不给装。
 */
const fs = require('fs');
const path = require('path');
const { mkZip, withRoot } = require('../test/zip-kit');
const Plg = require('../core/plugin');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'plugins-src');
const OUT = path.join(ROOT, 'plugins-dist');
const TEXT = /\.(js|html|json|css|txt|md|svg)$/i;

function walk(dir, base, out) {
  fs.readdirSync(dir).forEach(function (name) {
    if (name.charAt(0) === '.') return;
    const p = path.join(dir, name);
    const rel = (base ? base + '/' : '') + name;
    if (fs.statSync(p).isDirectory()) walk(p, rel, out);
    else out.push({ name: rel, data: fs.readFileSync(p), method: TEXT.test(name) ? 8 : 0 });
  });
  return out;
}

const name = process.argv[2];
if (!name || name === '--help' || name === '-h') {
  console.log('用法：node tools/pack-plugin.js <plugins-src 下的目录名> [--root]');
  process.exit(name ? 0 : 1);
}
const dir = path.join(SRC, name);
if (!fs.existsSync(dir)) {
  console.log('找不到插件源码目录：' + dir);
  process.exit(1);
}
const files = walk(dir, '', []);
const hit = files.filter(function (f) { return f.name === Plg.MANIFEST_FILE; })[0];
if (!hit) {
  console.log('包里必须有 ' + Plg.MANIFEST_FILE);
  process.exit(1);
}
/* 带网络能力的包必须把域名写死在清单里（导入后就锁死了），所以出包时用 --host 填进去。
 * --host 可以写逗号分隔的多个域名（一个插件对接好几家服务商时用得上）。 */
const hostArg = process.argv.filter(function (a) { return a.indexOf('--host=') === 0; })[0];
const hostVal = hostArg ? String(hostArg.slice('--host='.length)).trim().toLowerCase() : '';
const HOST_SLOT = /\{\{[A-Z_]*_HOST\}\}/;
let manText = hit.data.toString('utf8');
if (hostVal && HOST_SLOT.test(manText)) {
  const hosts = hostVal.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!hosts.length) {
    console.log('--host 里没有可用的域名。');
    process.exit(1);
  }
  manText = manText
    /* 独立成一个数组元素的占位符 → 展开成多个元素 */
    .replace(new RegExp('"' + HOST_SLOT.source + '"', 'g'), '"' + hosts.join('", "') + '"')
    /* 写在长句子里的占位符（比如提示文字里的示例地址）→ 用第一个 */
    .replace(new RegExp(HOST_SLOT.source, 'g'), hosts[0]);
  hit.data = Buffer.from(manText, 'utf8');
}
const slot = HOST_SLOT.exec(manText);
if (slot) {
  console.log('清单里还有没替换的占位符 ' + slot[0] + '。');
  console.log('两种写法二选一：要么出包时用 --host= 把固定域名填进去，');
  console.log('要么在清单里显式写成 "hosts": ["*"] —— 意思是地址由使用者在插件页里自己填（宿主只放行 https 标准端口）。');
  console.log('  node tools/pack-plugin.js ' + name + ' --host=战队网站域名（多家用逗号分隔）');
  process.exit(1);
}
const parsed = Plg.parseManifest(manText, files.map(function (f) { return f.name; }));
if (!parsed.ok) {
  console.log('清单没过解析：' + parsed.message);
  process.exit(1);
}
const m = parsed.manifest;
if (m.hostOk === false) {
  console.log('警告：清单写了 minHostVersion ' + m.minHostVersion + '，比当前宿主接口 ' + Plg.HOST_VERSION + ' 新，装了也用不了。');
}
const packed = mkZip(process.argv.indexOf('--root') >= 0 ? withRoot(name, files) : files);
fs.mkdirSync(OUT, { recursive: true });
const out = path.join(OUT, m.id + '-' + m.version + '.zip');
fs.writeFileSync(out, packed);
console.log('已出包 ' + path.relative(process.cwd(), out).replace(/\\/g, '/') +
  '　' + files.length + ' 个文件 / ' + packed.length + ' 字节');
console.log('权限指纹 ' + Plg.permFingerprint(m) + '（导入页上会显示同一串，两边一致才对）');
m.permissions.forEach(function (p) {
  const hs = p.hosts || [];
  const tail = hs.length ? ' → ' + (p.anyHost ? '任意 https 地址（由使用者在插件页里自己填）' : hs.join(', ')) : '';
  console.log('  · ' + p.label + tail);
});
console.log('在「设置 → 扩展插件 → 导入插件包」里选它。');
