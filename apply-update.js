'use strict';
/* 把「-新」目录替换成正式目录（旧版本关闭后运行） */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'dist');
const OLD = path.join(dir, '三角洲全面战场分析器');
const NEW = path.join(dir, '三角洲全面战场分析器-新');

if (!fs.existsSync(NEW)) {
  console.log('没有待替换的新版本目录，当前已是最终版本。');
  process.exit(0);
}
try {
  if (fs.existsSync(OLD)) fs.rmSync(OLD, { recursive: true, force: true });
  fs.renameSync(NEW, OLD);
  console.log('替换成功：' + OLD);
} catch (e) {
  console.log('替换失败（软件可能仍在运行）：' + (e.code || e.message));
  console.log('请关闭正在运行的软件后再试，或直接使用：' + NEW);
  process.exit(1);
}
