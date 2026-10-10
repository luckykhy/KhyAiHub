#!/usr/bin/env node
'use strict';

const path = require('path');

const { loadRegistry, loadBinding } = require('./lib/registry');
const { buildManifest, selectForMode } = require('./lib/manifest');
const { applyToPaths, renderApplied } = require('./lib/apply');
const { run } = require('./lib/run');
const coverage = require('./lib/coverage');
const ledger = require('./lib/ledger');

/**
 * ruleguard — 规则遵守保障机制的绑定层 CLI（[DESIGN-ARCH-111]）。
 *
 * Usage:
 *   node scripts/ruleguard/index.js run [--mode commit|pr|release] [--json]
 *                                       [--no-ledger] [--update-baseline] [--changed]
 *   node scripts/ruleguard/index.js coverage [--ci] [--json]
 *   node scripts/ruleguard/index.js apply <path> [<path>...] [--verbose]
 *   node scripts/ruleguard/index.js manifest [--json]
 *   node scripts/ruleguard/index.js ledger [--json] [--sarif]
 *
 * Env:
 *   KHY_RULEGUARD_LEDGER     台账路径覆盖（测试夹具用）
 *   KHY_RULEGUARD_BASELINE   基线文件覆盖（测试夹具用）
 *   KHY_RULEGUARD_ROOT       仓库根覆盖（测试夹具用）
 */

const MODES = ['commit', 'pr', 'release'];

function usage(exitCode = 2) {
  process.stderr.write(`ruleguard — 规则执行绑定层

用法：
  ruleguard run [--mode commit|pr|release] [--json] [--no-ledger]
                [--update-baseline] [--changed]
  ruleguard coverage [--ci] [--json]
  ruleguard apply <path> [<path>...] [--verbose]
  ruleguard manifest [--json]
  ruleguard ledger [--json] [--sarif]   违规台账聚合（按规则/文件/门 + 趋势）

模式：commit ⊂ pr ⊂ release。commit 只跑支持 --changed 的执行器（pre-commit 快档）。
`);
  if (exitCode !== undefined) process.exitCode = exitCode;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { _: [], mode: 'pr', json: false, ci: false, verbose: false };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--mode':
        opts.mode = args[++i];
        break;
      case '--json': opts.json = true; break;
      case '--sarif': opts.sarif = true; break;
      case '--ci': opts.ci = true; break;
      case '--verbose': opts.verbose = true; break;
      case '--no-ledger': opts.ledger = false; break;
      case '--update-baseline': opts.updateBaseline = true; break;
      case '--changed': opts.changed = true; break;
      case '--help': case '-h': usage(0); process.exit(0); break;
      default:
        if (arg.startsWith('--')) {
          process.stderr.write(`[ruleguard] 未知参数：${arg}\n`);
          usage(2);
          process.exit(2);
        }
        opts._.push(arg);
    }
  }

  if (opts.mode && !MODES.includes(opts.mode)) {
    process.stderr.write(`[ruleguard] 非法 --mode "${opts.mode}"，可选：${MODES.join(' / ')}\n`);
    process.exitCode = 2;
  }
  return opts;
}

function repoRoot() {
  return path.resolve(process.env.KHY_RULEGUARD_ROOT || process.cwd());
}

function commandRun(opts) {
  const { code, report } = run({
    repoRoot: repoRoot(),
    mode: opts.mode,
    ledger: opts.ledger !== false,
    updateBaseline: Boolean(opts.updateBaseline),
    json: opts.json,
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printRunSummary(report);
  }
  return code;
}

function printRunSummary(report) {
  if (report.errors && report.errors.length) return; // already printed
  const s = report.summary;
  process.stdout.write('\n');
  process.stdout.write(
    `[ruleguard] 模式 ${report.mode}：执行器 ${s.checkersRun} 个，违规 ${s.violations} 条`
    + `（阻断 ${s.blocking}，抑制 ${s.suppressed}，超基线 ${s.overBaseline || 0}），`
    + `未登记 finding ${s.unmappedFindings || 0} 条\n`
  );

  for (const violation of report.violations) {
    // Advisory findings are recorded but not shown one by one; a checker that
    // exited non-zero is always worth surfacing, since that is the surprising
    // part of an otherwise invisible checker-failure.
    const worthShowing = violation.blocking
      || violation.suppressed
      || violation.suppressionInvalid
      || violation.finding === 'checker-failure';
    if (!worthShowing) continue;
    // `blocking` must win over the checker-failure shortcut: a fail-closed
    // checker is still blocking, and mislabeling it as "recorded" would hide
    // a red gate behind a green-looking tag.
    const tag = violation.suppressionInvalid ? 'INVALID'
      : violation.suppressed ? 'SUPP'
      : violation.blocking ? 'BLOCK'
      : violation.finding === 'checker-failure' ? 'REC' : 'ADV';
    const where = violation.file ? `${violation.file}:${violation.line || 0}` : '';
    process.stderr.write(`  [${tag}] ${violation.rule} ${where} ${violation.message || violation.finding}\n`);
  }
  for (const invalid of report.invalidSuppressions || []) {
    process.stderr.write(`  [INVALID] ${invalid.message} (${invalid.file}:${invalid.line})\n`);
  }
}

function commandCoverage(opts) {
  const data = coverage.buildCoverage(repoRoot());
  const code = coverage.coverageCode(data);
  if (opts.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(`${coverage.renderCoverage(data, { ci: opts.ci })}\n`);
  return code;
}

function commandApply(opts) {
  if (!opts._.length) {
    process.stderr.write('[ruleguard] apply 需要一个或多个路径\n');
    usage(2);
    process.exit(2);
  }
  const registry = loadRegistry(repoRoot());
  if (registry.errors.length) {
    for (const error of registry.errors) process.stderr.write(`[ruleguard] ${error.message}\n`);
    return 1;
  }
  const matched = applyToPaths(registry.rules, opts._);
  process.stdout.write(`${renderApplied(matched, opts._, { verbose: opts.verbose })}\n`);
  return 0;
}

function commandManifest(opts) {
  const registry = loadRegistry(repoRoot());
  if (registry.errors.length) {
    for (const error of registry.errors) process.stderr.write(`[ruleguard] ${error.message}\n`);
    return 1;
  }
  const { wiring } = loadBinding(repoRoot());
  const manifest = buildManifest(registry, wiring);
  const mode = opts.mode && MODES.includes(opts.mode) ? opts.mode : null;
  const rows = mode ? selectForMode(manifest, mode) : manifest.rules;

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ summary: manifest.summary, rules: rows, checkers: manifest.checkers }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`规则 ${manifest.summary.total} 条 / 执行器 ${manifest.summary.checkers} 个\n\n`);
  process.stdout.write(`${'ID'.padEnd(16)} ${'优先级'.padEnd(5)} ${'门'.padEnd(9)} ${'归类'.padEnd(16)} 执行器\n`);
  process.stdout.write('-'.repeat(96) + '\n');
  for (const rule of rows) {
    process.stdout.write(
      `${String(rule.id).padEnd(16)} ${String(rule.priority).padEnd(5)} ${String(rule.gate).padEnd(9)}`
      + ` ${String(rule.kind).padEnd(16)} ${rule.script || '-'}\n`
    );
  }
  return 0;
}

/**
 * 违规台账聚合（`ruleguard ledger`）。纯读：只读 violations.jsonl，零写操作——
 * 台账此前「写满即沉没」，聚合视图回答「哪条规则/哪个文件是惯犯、趋势升降如何」。
 * `--sarif` 给 GitHub code scanning 等 SARIF 消费方导出（Checkov 模式）。
 */
function commandLedger(opts) {
  const agg = ledger.aggregate(repoRoot());
  if (opts.sarif) {
    const sarif = ledger.toSarif(ledger.readAll(repoRoot()));
    process.stdout.write(`${JSON.stringify(sarif, null, 2)}\n`);
    return 0;
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(agg, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`违规台账聚合（${agg.span.first ? `${agg.span.first.slice(0, 10)} ~ ${agg.span.last.slice(0, 10)}` : '空台账'}）\n`);
  process.stdout.write(`累计 ${agg.total} 条（含抑制 ${agg.suppressed} 条）\n\n`);
  const printCounts = (title, entries, limit = 10) => {
    if (!entries.length) return;
    process.stdout.write(`${title}：\n`);
    for (const [key, count] of entries.slice(0, limit)) {
      process.stdout.write(`  ${String(key).padEnd(28)} ${String(count).padStart(4)}\n`);
    }
    if (entries.length > limit) {
      process.stdout.write(`  （其余 ${entries.length - limit} 项略）\n`);
    }
    process.stdout.write('\n');
  };
  printCounts('按规则', agg.byRule);
  printCounts('按文件', agg.byFile, 15);
  printCounts('按门', agg.byGate);
  if (agg.byCommit.length) {
    process.stdout.write('按提交趋势（时间序）：\n');
    for (const [commit, count] of agg.byCommit) {
      process.stdout.write(`  ${String(commit).padEnd(12)} ${'█'.repeat(Math.min(count, 30))} ${count}\n`);
    }
  } else {
    process.stdout.write('台账为空（尚无违规记录）。\n');
  }
  return 0;
}

function main(argv = process.argv) {
  const opts = parseArgs(argv);
  const command = opts._.shift() || 'run';

  let code;
  switch (command) {
    case 'run': case 'check': code = commandRun(opts); break;
    case 'coverage': case 'stats': code = commandCoverage(opts); break;
    case 'apply': code = commandApply(opts); break;
    case 'manifest': case 'list': code = commandManifest(opts); break;
    case 'ledger': case 'trend': code = commandLedger(opts); break;
    default:
      process.stderr.write(`[ruleguard] 未知子命令：${command}\n`);
      usage(2);
      code = 2;
  }
  process.exitCode = code;
  return code;
}

if (require.main === module) main();

module.exports = { main, commandRun, commandCoverage, commandApply, commandManifest, commandLedger };
