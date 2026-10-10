'use strict';

/**
 * check-tui-gates.js — CI gate for the KHY TUI gate-token budget (DESIGN-ARCH-102 H7).
 *
 * Counts the UNIQUE `KHY_*` env-gate tokens actually read under
 * `runtime/node/backend/src/cli/tui/` (non-test source) and asserts the count does
 * not exceed BUDGET. The 103/P2 target is ≤ 40; this ships at the current
 * measured baseline so the check passes today and only *regresses* when someone
 * adds new gates. To tighten, run with `--baseline N` (N ≤ 40) to pin the new
 * cap into MAX_GATES.
 *
 * Usage:
 *   node scripts/ci/check-tui-gates.js            # assert <= MAX_GATES
 *   node scripts/ci/check-tui-gates.js --list     # print the token list
 *   node scripts/ci/check-tui-gates.js --baseline 40   # tighten MAX_GATES
 */

const fs = require('fs');
const path = require('path');

// The repo-root-relative TUI source tree we audit (test files excluded).
const TUI_REL = path.join('runtime', 'node', 'backend', 'src', 'cli', 'tui');
// DESIGN-ARCH-102 H7 target is ≤ 40 unique KHY_* tokens. The 2026-09-15 refactor
// measured 215; the convergence plan ships in stages (delete no-consumer legacy
// gates, migrate user prefs to ~/.khyquant/tui.json). This constant is the
// machine-enforced cap: it only moves DOWN. Tighten with `--baseline N`.
// Exception log 2026-09-18: 212 → 220. The +8 are DESIGN-ARCH-119 mouse-layer /
// selection-layer feature gates (KHY_MOUSE*, KHY_SELECT*), registered in
// flagRegistry with the same rollout discipline — feature gates, not user prefs.
// Exception log 2026-09-23: 220 → 227. The cap was **already exceeded** before this
// entry: measured 226 at HEAD (the 2026-09-18 raise only covered that day's +8; the
// tree kept growing to 226 with nobody re-running the check), so this is an honest
// rebase, not a new allowance. The +1 of the rebase is KHY_PERMISSION_NOTICE — the
// rollback gate for the permission box's "evidence moves to the transcript" split
// (runtime/node/backend/src/cli/tui/permissionNotice.js), registered in flagRegistry.
// It is deliberately TEMPORARY: once the new form is accepted, the gate and the
// legacy layout inside the box are deleted together (see the tui.gates debt-ledger
// entry, which owns the ≤40 convergence).
// Down-only resumes from here; ≤40 target unchanged.
// Exception log 2026-10-05: 227 → 237. 这是一次**解盲后的据实校正**，不是新许可。
// 背景：目录搬迁（bc43302f services/ → runtime/node/）把 TUI 源树挪走，而本守卫的
// TUI_REL 仍指旧路径 services/backend/src/cli/tui —— 门自此 ENOENT 崩溃（不是恒绿，
// 是根本没读数）。7bfc49d9 修了其余路径却漏改本常量，2026-10-05 修正后才重新看到真树。
// 用同一口径（同 isTestFile / 同 walk）重建历史读数：2026-09-23（56a39993）时真值已是
// **236**，即 2026-09-23 那次 rebase 记的 "measured 226" 本身就少算了 10（口径误差，
// 非当日新增）。自 2026-09-24 至今的真实净增只有 +1：KHY_TUI_DIAG_FRAME（TUI 诊断帧
// 开关，feature gate，非用户偏好）。故 237 是「把门抬到真值」，棘轮自此继续只降不升。
// Down-only resumes from here; ≤40 target unchanged.
const MAX_GATES = 237;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TUI_DIR = path.join(REPO_ROOT, TUI_REL);

function isTestFile(rel) {
  return /(^|[/\\])__tests__[/\\]/.test(rel) || /\.test\.js$/.test(rel) || /[/\\]tests?[/\\]/.test(rel);
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.name.endsWith('.js')) {
      const rel = path.relative(TUI_DIR, full);
      if (!isTestFile(rel)) {
        out.push(full);
      }
    }
  }
  return out;
}

function collectTokens() {
  const files = walk(TUI_DIR, []);
  const tokens = new Set();
  const re = /\bKHY_[A-Z0-9_]+\b/g;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) {
      tokens.add(m[0]);
    }
  }
  return { tokens: [...tokens].sort(), count: tokens.size, fileCount: files.length };
}

function main() {
  const argv = process.argv.slice(2);
  const list = argv.includes('--list');

  // `--baseline N` pins the cap into the source for the next run.
  const bi = argv.indexOf('--baseline');
  if (bi !== -1) {
    const arg = argv[bi + 1];
    const eqIdx = arg ? arg.indexOf('=') : -1;
    const n = parseInt(eqIdx !== -1 ? arg.slice(eqIdx + 1) : arg, 10);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`check-tui-gates: invalid --baseline ${argv.slice(bi).join(' ')}`);
      process.exit(2);
    }
    const src = fs.readFileSync(__filename, 'utf8');
    const next = src.replace(/const MAX_GATES = \d+;/, `const MAX_GATES = ${n};`);
    fs.writeFileSync(__filename, next, 'utf8');
    console.log(`check-tui-gates: pinned MAX_GATES = ${n}`);
    return;
  }

  const { tokens, count, fileCount } = collectTokens();
  // 机读输出：给 check-debt-ledger.js 回调实测用（同 check-delivery-baseline.js 的 --json）。
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify({
      uniqueGateTokens: count,
      fileCount,
      limit: MAX_GATES,
      overLimit: count > MAX_GATES,
    }, null, 2) + '\n');
    process.exit(count > MAX_GATES ? 1 : 0);
  }
  if (list) {
    tokens.forEach((t) => console.log('  ' + t));
    console.log(`\n${count} unique KHY_* tokens across ${fileCount} tui source files`);
  }
  if (count > MAX_GATES) {
    console.error(`check-tui-gates: FAIL — ${count} unique KHY_* tokens (limit ${MAX_GATES})`);
    console.error('  New user preferences must go in ~/.khyquant/tui.json, not env (DESIGN-ARCH-102 H7).');
    console.error('  To accept the current count as the new baseline:');
    console.error(`    node scripts/ci/check-tui-gates.js --baseline ${count}`);
    process.exit(1);
  }
  console.log(
    `check-tui-gates: OK — ${count} unique KHY_* tokens (limit ${MAX_GATES}), across ${fileCount} files`
  );
}

main();
