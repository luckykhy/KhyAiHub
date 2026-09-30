'use strict';

/**
 * check-roots-isomorphic.js — 方案 P 同构观测器（S1，只记录，恒 exit 0）。
 *
 * 判据真源：DOMAIN-DEPS.json._physicalization（targets/exceptions）。
 * 每条 domains.*.roots 的前导目录若 != 所属域的 physical target，即一条
 * roots-not-isomorphic 发现——它就是「抽象层与物理层还差几步」的尺：
 * 方案 P 的 P1–P5 每完成一段，读数应单调下降；终态读数 = exceptions 数。
 *
 * 为什么独立成脚本而不是接进 check:layout：check-repo-layout.js 与
 * FEATURE-OWNERSHIP.json 现为并行窗口在飞件（` M`，2026-09-29 起），
 * 接线工单见 [DESIGN-LAY-008] §12.62；该文件干净后把本函数并入即可（判据同源）。
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const decl = JSON.parse(fs.readFileSync(
  path.join(REPO, 'docs', '10_规范', 'registry', 'DOMAIN-DEPS.json'), 'utf8'));

const phys = decl._physicalization;
if (!phys || !phys.targets) {
  console.log('_physicalization 未登记，观测器空转（exit 0）');
  process.exit(0);
}

const exceptions = new Set(phys.exceptions || []);
const bad = [];
for (const [id, def] of Object.entries(decl.domains || {})) {
  const target = phys.targets[id];
  if (!target) continue;
  for (const root of def.roots || []) {
    const r = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
    if (exceptions.has(r)) continue;
    if (r !== target && !r.startsWith(`${target}/`)) bad.push(`${id}: ${r} → ${target}/`);
  }
}

console.log(`roots-not-isomorphic: ${bad.length} 条（终态应 = exceptions ${exceptions.size}；`
  + `方案 P 每完成一段单调下降。S1 观察者档，恒 exit 0）`);
for (const b of bad) console.log(`  · ${b}`);
process.exit(0);
