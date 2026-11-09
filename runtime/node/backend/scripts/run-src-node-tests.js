#!/usr/bin/env node
'use strict';

/**
 * run-src-node-tests.js — quiet runner for the src/ node:test suite.
 *
 * Running the src/ node:test suite (`node --test` over every `*.test.js` under
 * src/) prints the whole TAP stream: measured 1.57 MB (383 suites / 6927
 * assertions) on the node that sits first on PATH here (v22.18, non-TTY default
 * reporter = tap). Automated gate runners cap a single command's stdout — this
 * repo's workflow harness caps it at 256 KB and refuses to run anything larger,
 * so the verdict never reaches the gate. Asking a model to "only report a
 * summary" cannot help: the raw stdout is already in the tool result by the
 * time anybody reads it.
 *
 * So the safeguard moves from the prompt layer to the command layer, same idea
 * as scripts/test-summary.js: the child's full output is buffered to a log file
 * and stdout carries a bounded summary (counts + failing suite names + log path)
 * no matter how large or how red the run is.
 *
 * Failure lines keep the TAP `not ok <n> - <name>` shape, so gates that compare
 * the result against a known-red baseline
 * (src/services/domain/project/projectProfile) keep working unchanged.
 *
 * Usage:
 *   node runtime/node/backend/scripts/run-src-node-tests.js   # from repo root
 *   node scripts/run-src-node-tests.js                        # from backend root
 *
 * Exit code: 1 when any suite fails (same contract as node --test), 0 when green.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..');
const GLOB = 'src/**/*.test.js';
// Forced TAP — the default reporter differs by node version and TTY (v22 → tap,
// v24 → spec) and only TAP carries the `not ok` verdict lines the summary needs.
// The flag MUST precede `--test`: measured on v24.19, a reporter flag placed
// after the test file is silently ignored and the run falls back to the spec
// reporter, which emits no `not ok` lines at all — a red run would then read as
// green. Verified identical TAP on v22.18 and v24.19 with this ordering.
const CHILD_ARGS = ['--test-reporter=tap', '--test', GLOB];
const LOG_PATH = path.join(os.tmpdir(), `khy-src-node-test-${process.pid}.log`);
const PRINT_LINE_CAP = 60; // ceiling on echoed failure lines, so red runs stay bounded
const COUNT_RE = /^# (tests|suites|pass|fail) (\d+)$/;
const VERDICT_RE = /^not ok \d+ - (.+)$/;

function runSuite() {
  // Buffer and write once: streaming plus process.exit() can lose the log.
  const result = spawnSync(process.execPath, CHILD_ARGS, {
    cwd: backendRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const spawnError = result.error
    ? `!! spawn failed: ${result.error.code || result.error.name} — child produced no output\n`
    : '';
  const out = `${spawnError}${result.stdout || ''}${result.stderr || ''}`;
  fs.writeFileSync(LOG_PATH, out);
  return { out, status: result.status, signal: result.signal, spawnError };
}

function parse(out) {
  const counts = {};
  const failing = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    const count = COUNT_RE.exec(trimmed);
    if (count) {
      counts[count[1]] = Number(count[2]);
      continue;
    }
    const verdict = VERDICT_RE.exec(trimmed);
    if (verdict) failing.push(verdict[1]);
  }
  return { counts, failing };
}

function main() {
  const run = runSuite();
  const { counts, failing } = parse(run.out);
  const suites = counts.suites || 0;
  const tests = counts.tests || 0;
  const pass = counts.pass || 0;
  const fail = counts.fail || 0;
  const ran = suites > 0 || tests > 0;
  // Counts that report failures without a single named `not ok` line mean the
  // reporter was not TAP — report it instead of letting it read as green.
  const unnamedFailures = fail > 0 && failing.length === 0;
  // A run that produced no counts did not run, no matter how tidy it looks.
  const failed = Boolean(run.spawnError) || !ran || unnamedFailures || fail > 0 || run.status !== 0;

  const lines = [];
  if (!ran) {
    lines.push('src/ node:test：无结果 —— 未采集到任何计数行，不得当作全绿。');
  } else if (unnamedFailures) {
    lines.push(
      `src/ node:test：计数报失败 ${fail} 个，却未解析到任何 not ok 行 —— reporter 不是 TAP，结论不可信。`
    );
  } else {
    lines.push(`src/ node:test：套件 ${suites}，测试 ${tests}，通过 ${pass}，失败 ${fail}`);
  }
  const shown = failing.slice(0, PRINT_LINE_CAP);
  shown.forEach((name, i) => lines.push(`not ok ${i + 1} - ${name}`));
  if (failing.length > shown.length) {
    lines.push(`... 其余 ${failing.length - shown.length} 条失败未打印，见日志`);
  }
  if (run.signal) lines.push(`子进程被信号 ${run.signal} 终止（超时或被终止）。`);
  lines.push(`完整日志：${LOG_PATH}`);

  process.stdout.write(`${lines.join('\n')}\n`);
  process.stdout.write(`结论：${failed ? 'FAIL' : 'PASS'}\n`);
  return failed ? 1 : 0;
}

process.exit(main());
