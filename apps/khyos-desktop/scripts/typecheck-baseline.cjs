#!/usr/bin/env node
'use strict';

// typecheck-baseline.cjs — 跑 tsconfig.check.json 并对照基线判定。
//
// 为什么需要它：src/host 与 src/renderer 至今没有任何类型门（tsconfig.node.json
// 的 include 不含这两个目录），但本轮的关键改动正好落在那里。**只报不改**：
// 既有的 N 条错误记进 tsconfig.check-baseline.json，新增错误才判红。
// 把既有错误一次清零并升为阻断门是独立的一条改造线，不夹带进来。

const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const key = (e) => `${e.file}|${e.line}|${e.code}`;
const keyOf = (e) => `${e.file}|${e.line}|${e.code}`;

function collect() {
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.check.json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // tsc 以非 0 退出表示有错；错误走 stdout
    stdout = `${e.stdout || ''}`;
  }
  const errors = [];
  for (const line of stdout.split('\n')) {
    const m = /^([^\s(]+)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
    if (m) {
      errors.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5] });
    }
  }
  // 同一 (文件, 行, 码) 只留一条：同一行可能报多个同码错误（如 TS2339 三连），
  // 基线按同一口径去重，两边数字才对得上。
  const byKey = new Map();
  for (const e of errors) if (!byKey.has(key(e))) byKey.set(key(e), e);
  return [...byKey.values()];
}

const actual = collect();
const baselinePath = path.join(ROOT, 'tsconfig.check-baseline.json');
let baseline = [];
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).known || [];
} catch {
  console.error('读不到 tsconfig.check-baseline.json，无法判定新增错误。');
  process.exit(2);
}

const baselineKeys = new Set(baseline.map(keyOf));
const actualKeys = new Set(actual.map(key));
const added = actual.filter((e) => !baselineKeys.has(key(e)));
const resolved = baseline.filter((e) => !actualKeys.has(keyOf(e)));

console.log(`类型检查：既有 ${baseline.length} 条 / 实际 ${actual.length} 条`);
if (resolved.length) {
  console.log(`\n已修复（基线里不再出现，可从基线删掉）：${resolved.length} 条`);
  for (const e of resolved.slice(0, 20)) console.log(`  - ${keyOf(e)}`);
}
if (added.length) {
  console.log(`\n新增错误 ${added.length} 条（判红）：`);
  for (const e of added) console.log(`  ${e.file}(${e.line},${e.col}): error ${e.code}: ${e.message}`);
  process.exit(1);
}
console.log('无新增错误。');