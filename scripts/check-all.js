'use strict';

/**
 * 语法检查：覆盖 server.js 与 core/ 下所有 .js。
 * 之前是手写文件列表，responses.js（改动量最大的文件）不在其中，
 * 导致语法错误/笔误无法被 npm test 发现。这里改为自动遍历，新增文件自动纳入。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const targets = ['server.js'];

const coreDir = path.join(root, 'core');
if (fs.existsSync(coreDir)) {
  for (const f of fs.readdirSync(coreDir).sort()) {
    if (f.endsWith('.js')) targets.push(path.join('core', f));
  }
}

let failed = 0;
for (const t of targets) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, t)], { stdio: 'pipe' });
    console.log(`  ok   ${t}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${t}`);
    console.error(String(e.stderr || e.message).trim());
  }
}

console.log(`\n语法检查：${targets.length - failed}/${targets.length} 通过`);
process.exit(failed ? 1 : 0);
