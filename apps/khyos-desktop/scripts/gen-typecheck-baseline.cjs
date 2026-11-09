'use strict';
// 一次性工具：把 tsc 当前实际报的错写成基线文件。改动 include 或修完既有错后
// 重新跑一次即可（跑之前请人工看过一遍，别把新错一起吞进基线）。

const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

let stdout = '';
try {
  stdout = execFileSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.check.json'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  stdout = `${e.stdout || ''}`;
}
const seen = new Map();
for (const line of stdout.split('\n')) {
  const m = /^([^\s(]+)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
  if (m) seen.set(`${m[1]}|${m[2]}|${m[4]}`, { file: m[1], line: Number(m[2]), code: m[4], message: m[5] });
}
const known = [...seen.values()];
writeFileSync(
  path.join(ROOT, 'tsconfig.check-baseline.json'),
  JSON.stringify(
    {
      _comment: [
        'tsconfig.check.json（src/host + src/renderer）的既有类型错误基线。',
        'npm run typecheck 只在出现**不在此列**的错误时判红。',
        '本轮只报不改——清零既有错误并升为阻断门是独立的一条改造线。',
      ],
      known,
    },
    null,
    2,
  ) + '\n',
  'utf8',
);
console.log('baseline 条数:', known.length);