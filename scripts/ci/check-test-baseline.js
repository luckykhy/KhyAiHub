#!/usr/bin/env node
'use strict';

/**
 * check-test-baseline.js — 测试失败数棘轮（DEP-11 的「门说真话」那一半）。
 *
 * 背景：pr-gate 的 test-baseline job 此前整 job `continue-on-error: true`，
 * 而后端 jest 有一批既有失败（迁移遗留的死路径 + 历史腐坏）。「非阻断」加「不留
 * 基线」等于谁都没跑过 —— 新失败会被淹没在同一片红里。
 *
 * 本执行器把「既有失败」变成**可机读基线**，门只在**新增失败**时红：
 *   - 采样面 = tests/cli + tests/utils（与 test-baseline job 注释里的取样一致）；
 *   - 基线 = docs/05_TEST_测试/tests-debt/jest-baseline.json 的 failingSuites；
 *   - 当前失败 ⊆ 基线 → exit 0（并把「已转绿的 suite」提示出来，要求下调基线）；
 *   - 出现基线之外的新失败 → exit 1，逐条点名。
 *
 * 纪律：棘轮只降不升。修好一个 suite 就把基线里的那一行删掉（同批提交）。
 *
 * Usage:
 *   node scripts/ci/check-test-baseline.js                 # 跑采样面并比对
 *   node scripts/ci/check-test-baseline.js --log <file>    # 只解析已有日志
 *   node scripts/ci/check-test-baseline.js --json
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'runtime', 'node', 'backend');
const BASELINE_FILE = path.join(
  REPO_ROOT,
  'docs',
  '05_TEST_测试',
  'tests-debt',
  'jest-baseline.json'
);
const SAMPLE_DIRS = ['tests/cli', 'tests/utils'];
const RUN_TIMEOUT_MS = 20 * 60 * 1000;

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const logArg = (() => {
  const i = args.indexOf('--log');
  return i >= 0 ? args[i + 1] : null;
})();

function normalizeSuite(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .trim();
}

function readBaseline() {
  try {
    const data = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    const failing = Array.isArray(data.failingSuites) ? data.failingSuites : [];
    // flakySuites：间歇性失败（同一代码有时红有时绿，例如跨套件污染）。
    // 它们与 failingSuites 一样计入允许集合，但**不提示「已转绿」**——
    // 绿一次不代表修好了，删掉它会让下一次抖动被当成新失败。
    const flaky = Array.isArray(data.flakySuites) ? data.flakySuites : [];
    return {
      list: [...failing, ...flaky].map(normalizeSuite),
      failing: failing.map(normalizeSuite),
      flaky: flaky.map(normalizeSuite),
      data,
    };
  } catch (e) {
    return { list: null, data: null, error: e.message };
  }
}

// jest 每次真跑完都会在结尾打印这两行之一。没有它 = 这次运行没跑完（配置报错、
// worker 崩、被超时杀掉、输出没被捕获）。「没跑」不能读成「没失败」——
// 空日志曾被判成「当前失败 0 个 / 已转绿 4 个」，正是本守卫要消灭的那种假绿。
const JEST_VERDICT_RE = /^\s*(?:Test Suites|Tests):\s/m;

/** 从 jest 输出里抽 FAIL <path> 行。 */
function parseFailing(output) {
  const set = new Set();
  for (const line of String(output || '').split('\n')) {
    const m = /^FAIL\s+(\S+)/.exec(line.trim());
    if (m) set.add(normalizeSuite(m[1]));
  }
  return [...set].sort();
}

function runSample() {
  if (!fs.existsSync(path.join(BACKEND_DIR, 'node_modules', 'jest', 'bin', 'jest.js'))) {
    return { ok: false, output: 'backend node_modules 缺 jest —— 先跑 npm run install:core' };
  }
  const r = spawnSync(
    process.execPath,
    ['node_modules/jest/bin/jest.js', ...SAMPLE_DIRS, '--ci'],
    {
      cwd: BACKEND_DIR,
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' },
    }
  );
  if (r.error) {
    return { ok: false, output: `jest 未能启动：${r.error.message}` };
  }
  return { ok: true, output: `${r.stdout || ''}${r.stderr || ''}`, status: r.status };
}

function main() {
  const baseline = readBaseline();
  if (!baseline.list) {
    console.error(
      `[test-baseline] 读不到基线 ${path.relative(REPO_ROOT, BASELINE_FILE)}：${baseline.error}`
    );
    process.exitCode = 1;
    return;
  }

  let output;
  if (logArg) {
    try {
      output = fs.readFileSync(path.resolve(REPO_ROOT, logArg), 'utf8');
    } catch (e) {
      console.error(`[test-baseline] 读不到日志 ${logArg}：${e.message}`);
      process.exitCode = 1;
      return;
    }
  } else {
    const run = runSample();
    if (!run.ok) {
      console.error(`[test-baseline] ${run.output}`);
      process.exitCode = 1;
      return;
    }
    output = run.output;
  }

  const current = parseFailing(output);
  const baselineSet = new Set(baseline.list);
  const currentSet = new Set(current);

  if (!JEST_VERDICT_RE.test(output)) {
    const reason = '未拿到 jest 结论行（Test Suites: / Tests:）—— 本次运行没有跑完，不得判绿';
    if (jsonOut) {
      console.log(
        JSON.stringify({ ok: false, reason, scope: SAMPLE_DIRS, baselineCount: baseline.list.length }, null, 2)
      );
    } else {
      console.error(`[test-baseline] ${reason}`);
      console.error('[test-baseline] 先修好 jest 启动面（日志尾部：' +
        String(output).trim().split('\n').slice(-3).join(' / ') + '）');
    }
    process.exitCode = 1;
    return;
  }

  const newFailures = current.filter((s) => !baselineSet.has(s));
  const fixed = baseline.failing.filter((s) => !currentSet.has(s));
  const stillFailing = current.filter((s) => baselineSet.has(s));

  const report = {
    scope: SAMPLE_DIRS,
    baselineCount: baseline.list.length,
    currentCount: current.length,
    newFailures,
    fixed,
    stillFailing,
  };

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `[test-baseline] 采样面 ${SAMPLE_DIRS.join(' + ')}：当前失败 ${current.length} 个，基线 ${baseline.list.length} 个`
    );
    if (stillFailing.length) {
      console.log(`[test-baseline] 既有失败（在基线内，不阻断）${stillFailing.length} 个:`);
      for (const s of stillFailing) console.log(`  - ${s}`);
    }
    if (fixed.length) {
      console.log(
        `[test-baseline] 已转绿 ${fixed.length} 个 —— 请把它们从 jest-baseline.json 删掉（棘轮只降不升）:`
      );
      for (const s of fixed) console.log(`  + ${s}`);
    }
    if (newFailures.length) {
      console.error(
        `[test-baseline] 新增失败 ${newFailures.length} 个 —— 修复它们；若确属既有债务，须在基线文件中登记并说明理由:`
      );
      for (const s of newFailures) console.error(`  ! ${s}`);
    }
  }

  if (newFailures.length > 0) {
    process.exitCode = 1;
  }
}

main();
