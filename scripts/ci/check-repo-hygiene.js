#!/usr/bin/env node
'use strict';

/**
 * check-repo-hygiene.js — 仓库卫生守卫（垃圾文件名形态，按 git 跟踪面判定）
 *
 * 2026-10 两批事故的形态兜底：
 *   · runtime/node/backend/ 的 11 个一次性残留被跟踪入库（TmpKoh.class/.java、
 *     m[0])、m[1])、_chk_app2/_chk_bridge/_probe_tools.js、proxy_test2.js、
 *     note.txt、.khyos-diag-tui-final.txt、.zcode-tmp-ccoverlay.txt）；
 *   · delivery/web/ai-frontend/ 的 5 份 vite.config.js.timestamp-*.mjs（vite dev
 *     会自己生成）被跟踪入库。
 * 两批已在 P2 清除；本守卫按**文件名形态**拦回流——文件名匹配便宜且无误报，
 * 内容类（密钥形态）归 check-secrets-staged.js，不在这里重复。
 *
 * 用法: node scripts/ci/check-repo-hygiene.js [--staged] [--selftest] [--json]
 *   默认扫全部 git 跟踪文件（check:changed / CI 用）；--staged 只扫暂存区新增
 *   （pre-commit 快档用）。
 * 退出: S1/S2 恒 0（只记录）；S3 起有 finding 才 1；用法错误 2
 *
 * ⚠ 阶段权威在 STAGE 常量（S1）。S1 恒 exit 0、只记录不阻断（PROCESS-008 PP-3）；
 *   BAD 命中到 S3 才派生 error 参与阻断。升阶只改这一个常量 + 登记表的条目，
 *   不改接线（check-rollout-stage.js 会比对，漂移即报）。
 */

const path = require('path');
const { execFileSync } = require('child_process');

const STAGE = 'S1';

const REPO_ROOT = process.env.KHY_RULEGUARD_ROOT
  ? path.resolve(process.env.KHY_RULEGUARD_ROOT)
  : path.resolve(__dirname, '..', '..');

// 垃圾文件名形态 —— 每条带一句「它是什么」，报给提交者看。
// 匹配对象：git 跟踪路径（posix 形态）与其 basename，任一命中即 finding。
const BAD = [
  ['env-tmp-atomic', /\.env\.tmp\.\d+$/],
  ['vite-timestamp', /vite\.config\.js\.timestamp-/],
  ['java-build-artifact', /\.(class|jar)$/],
  ['shell-redirect-junk', /^m\[\d\]\)$/],
  ['debug-leftover', /^(TmpKoh|_chk_|_probe_|proxy_test)/],
  ['zcode-tmp', /\.zcode-tmp-/],
  ['khyos-diag-tmp', /^\.khyos-diag-.*\.txt$/],
  ['backend-note', /^runtime\/node\/backend\/note\.txt$/],
];

const SELFTEST_CASES = [
  // [路径, 是否应命中]
  ['runtime/node/backend/.env.tmp.1790646792872', true],
  ['delivery/web/ai-frontend/vite.config.js.timestamp-1790123653267-x.mjs', true],
  ['runtime/node/backend/TmpKoh.class', true],
  ['runtime/node/backend/TmpKoh.java', true],
  ['runtime/node/backend/m[0])', true],
  ['runtime/node/backend/_chk_app2.js', true],
  ['runtime/node/backend/_probe_tools.js', true],
  ['runtime/node/backend/proxy_test2.js', true],
  ['runtime/node/backend/.zcode-tmp-ccoverlay.txt', true],
  ['runtime/node/backend/.khyos-diag-tui-final.txt', true],
  ['runtime/node/backend/note.txt', true],
  // 近形但合法的名字，不应命中
  ['src/index.js', false],
  ['services/backend/tests/hw_probe_spawn_bench.js', false],
  ['services/backend/tests/startup_probe_cost_bench.js', false],
  ['.env.example', false],
  ['.env', false],
  ['package-lock.json', false],
  ['vite.config.ts', false],
  ['docs/note.txt', false],
];

function classify(trackedPath) {
  const posix = trackedPath.replace(/\\/g, '/');
  const base = posix.slice(posix.lastIndexOf('/') + 1);
  for (const [name, pattern] of BAD) {
    if (pattern.test(posix) || pattern.test(base)) return name;
  }
  return null;
}

/** 全部 git 跟踪文件（-z 免路径转义） */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

/** 暂存区新增/改名文件（pre-commit 快档） */
function stagedFiles() {
  const out = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter', 'ACMR', '-z'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\0').filter(Boolean);
}

// S3 起才阻断；S1/S2 恒 exit 0（与 check-no-emoji 的 severityFor 同一模式）
const BLOCKS = STAGE !== 'S1' && STAGE !== 'S2';

function run() {
  const argv = process.argv.slice(2);
  const selftest = argv.includes('--selftest');
  const staged = argv.includes('--staged');
  const json = argv.includes('--json');

  if (selftest) {
    const misses = [];
    for (const [name, shouldHit] of SELFTEST_CASES) {
      const hit = classify(name) !== null;
      if (hit !== shouldHit) {
        misses.push(name + ' (期望' + (shouldHit ? '命中' : '不命中') + '，实测' + (hit ? '命中' : '不命中') + ')');
      }
    }
    if (misses.length) {
      process.stderr.write('✗ selftest ' + misses.length + '/' + SELFTEST_CASES.length + ' 失败：\n  ' + misses.join('\n  ') + '\n');
      return 1;
    }
    const hits = SELFTEST_CASES.filter((c) => c[1]).length;
    process.stdout.write('  ✓ selftest ' + SELFTEST_CASES.length + '/' + SELFTEST_CASES.length + ' 通过（' + hits + ' 应命中 + ' + (SELFTEST_CASES.length - hits) + ' 不应命中）\n');
    return 0;
  }

  const files = staged ? stagedFiles() : trackedFiles();
  const findings = [];
  for (const f of files) {
    const kind = classify(f);
    if (kind) findings.push({ file: f, kind });
  }

  if (json) {
    process.stdout.write(JSON.stringify({ stage: STAGE, findings }, null, 2) + '\n');
  } else if (findings.length === 0) {
    process.stdout.write('  ✓ 卫生守卫（S1 观察者）：' + (staged ? '暂存区' : '跟踪面') + ' ' + files.length + ' 个文件，无垃圾文件名形态\n');
  } else {
    process.stdout.write('✗ 卫生守卫（S1 观察者，只记录不阻断）：' + findings.length + ' 个文件命中垃圾文件名形态：\n');
    for (const f of findings) {
      process.stdout.write('  ' + f.file + '  [' + f.kind + ']\n');
    }
    process.stdout.write('\n');
    process.stdout.write('清除：git rm --cached <路径> 并补 .gitignore 形态；升 S3（提交阻断）是人的决定：\n');
    process.stdout.write('改本文件 STAGE 常量 + FEATURE-OWNERSHIP.json 的 repo-hygiene-guard 条目。\n');
  }

  return BLOCKS && findings.length > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exit(run());
}

module.exports = { run, classify, BAD, STAGE, trackedFiles, stagedFiles };
