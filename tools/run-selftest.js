const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..');
const exe = path.join(root, 'dist', '三角洲全面战场分析器', '三角洲全面战场分析器.exe');
const outDir = path.join(process.env.TEMP, 'st-150');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'out.json');
try { fs.unlinkSync(outFile); } catch (e) {}
const env = Object.assign({}, process.env);
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(exe, [
  '--selftest',
  '--user-data-dir=' + path.join(outDir, 'profile'),
  '--selftest-out=' + outFile
], { env, cwd: root, timeout: 180000 });
console.log('status', r.status, 'err', r.error && r.error.message);
if (fs.existsSync(outFile)) {
  console.log(fs.readFileSync(outFile, 'utf8'));
} else console.log('NO OUTPUT FILE');
