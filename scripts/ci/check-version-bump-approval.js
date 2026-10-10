#!/usr/bin/env node
'use strict';

/**
 * check-version-bump-approval.js — MINOR/MAJOR 版本递增的批准闸（工具无关）。
 *
 * 解决什么问题：`scripts/release/version-mode.js bump --minor|--major --approved-by <人>`
 * 是 R-2a 的**主**执行面，但它只挡住「走那个脚本」的路径。另一个 AI（Codex / Cursor /
 * ZCode / CodeArts）或人类开发者直接编辑 pyproject.toml，那个闸就绕过去了。
 *
 * 所以这里补一道**工具无关**的闸：比对工作区/暂存区与 HEAD 的版本号，
 * 只要 MAJOR 或 MINOR 变了，就要求提交信息里带批准标记。
 *
 *   批准标记：提交正文含 `version-bump-approved-by: <批准人>`（非空）
 *
 * 为什么用提交信息而不是别的载体：本仓已有同形机制——`check-commit-message.js`
 * 用同一思路硬拦 AI 署名（`Co-Authored-By: <AI>`）。批准人要随提交进历史，
 * 事后才查得清「这一跳是谁点头的」。
 *
 * PATCH 不受限：开发态批次 bump 已由 T4 预授权，逐次审批会把自动 bump 废掉。
 *
 * 用法：
 *   node scripts/ci/check-version-bump-approval.js                  # 检查暂存区 vs HEAD
 *   node scripts/ci/check-version-bump-approval.js --changed         # 同上，语义别名
 *   node scripts/ci/check-version-bump-approval.js --message-file f  # 指定提交信息文件
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const G1_SOURCES = [
  'pyproject.toml',
  'works/ship/npm/package.json',
  'runtime/node/backend/package.json',
  'works/ship/modules/modules.json',
];

const args = process.argv.slice(2);
const msgIdx = args.indexOf('--message-file');
const msgFile = msgIdx === -1 ? null : args[msgIdx + 1];

function git(argv) {
  try {
    return execFileSync('git', argv, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return '';
  }
}

function readVersionFrom(text) {
  const m = text.match(/^version\s*=\s*"([^"]+)"/m) || text.match(/"version"\s*:\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

function parse(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

// HEAD 侧的版本（任一真源取到即用；四源一致性由 check-version-sync 负责）
const headVersion = readVersionFrom(git(['show', `HEAD:${G1_SOURCES[0]}`]));

// 待提交侧的版本：**暂存区与工作区两边都要看**。只看暂存区会漏掉「手改了但没 git add」
// 这一种——而那正是本守卫要拦的主要路径（绕过 version-mode.js 私改版本号）。
const pending = [];
const seen = new Set();
function consider(label, text) {
  const v = text ? readVersionFrom(text) : null;
  if (v && !seen.has(v)) {
    seen.add(v);
    pending.push({ label, version: v });
  }
  return v;
}

consider('暂存区', git(['show', `:${G1_SOURCES[0]}`]));
const wtPath = path.join(REPO_ROOT, G1_SOURCES[0]);
if (fs.existsSync(wtPath)) {
  consider('工作区', fs.readFileSync(wtPath, 'utf8'));
}

if (!headVersion || pending.length === 0) {
  // 取不到版本号时不误伤——那不是本守卫该管的事。
  console.log('check-version-bump-approval: 取不到版本号，跳过。');
  process.exit(0);
}

const a = parse(headVersion);

// 任一侧出现 MINOR/MAJOR 移动就要批准。报「走得最远」的那个，避免同一跳报两遍。
let worst = null;
for (const p of pending) {
  const b = parse(p.version);
  if (!b) continue; // 非 X.Y.Z 由 check-version-sync 管
  if (b.major === a.major && b.minor === a.minor) continue;
  const level = b.major !== a.major ? 'MAJOR' : 'MINOR';
  if (!worst || level === 'MAJOR' || worst.level === 'MINOR') {
    worst = { level, from: headVersion, to: p.version, where: p.label };
  }
}

if (!worst) {
  const patchMoved = pending.some((p) => {
    const b = parse(p.version);
    return b && b.major === a.major && b.minor === a.minor && b.patch !== a.patch;
  });
  if (patchMoved) {
    console.log(`check-version-bump-approval: PATCH ${headVersion} → ${pending.map((p) => p.version).join('/')}，开发态已预授权，放行。`);
  } else {
    console.log('check-version-bump-approval: 版本号未变，放行。');
  }
  process.exit(0);
}

const level = worst.level;
console.error(`check-version-bump-approval: ${level} 递增 ${worst.from} → ${worst.to}（${worst.where}）需要人批准（R-2a）。`);

// 取提交信息：优先 --message-file，其次 git 的标准 COMMIT_EDITMSG，再次暫存区参数
let message = '';
if (msgFile && fs.existsSync(msgFile)) {
  message = fs.readFileSync(msgFile, 'utf8');
} else {
  const candidates = [
    path.join(REPO_ROOT, '.git', 'COMMIT_EDITMSG'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { message = fs.readFileSync(c, 'utf8'); break; }
  }
}

const approval = message.match(/^version-bump-approved-by:\s*(.+)$/mi);
if (approval && approval[1].trim()) {
  console.log(`  批准人：${approval[1].trim()} —— 放行。`);
  process.exit(0);
}

console.error('');
console.error('  AI 不得自行决定小版本/大版本递增（CLAUDE.md B7 / [DESIGN-SEMVER-002] R-2a）。');
console.error('  请先向人说明：命中 T1（功能新增）还是 T2（行为/破坏性变更）、影响面');
console.error('  （哪些对外契约/CLI 用法/数据格式受影响）、建议递增到几，然后：');
console.error('');
console.error('    ① 用正规入口（推荐，四源同步 + CHANGELOG 段一并搞定）：');
console.error(`       node scripts/release/version-mode.js bump --${level.toLowerCase()} --approved-by <批准人>`);
console.error('    ② 若已手改完版本号，在提交信息里加一行：');
console.error('       version-bump-approved-by: <批准人>');
process.exit(1);
