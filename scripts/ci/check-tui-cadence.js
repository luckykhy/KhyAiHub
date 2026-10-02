#!/usr/bin/env node
'use strict';

/**
 * check-tui-cadence.js — TUI 动画节拍三方一致守卫（`RUNTIME-011`）。
 *
 * 判定真源：`scripts/lib/tuiCadenceGuard.js`（纯叶子，零 IO）。
 * 本文件只负责**采集事实**（读源 / 枚举导出 / 取改动集）并渲染，不含任何判据。
 *
 * ## 为什么它是一条「守卫」而不是一次性脚本
 *
 * TUI 节拍有三个可能各说各话的地方：规范表（`tui/AGENTS.md` §3.3）、实现真源
 * （`perfTunables.js` 默认值）、组件兜底字面量（`Spinner.js` / `topicBar.js`）。
 * 三者漂移时**没有任何一处会报错** —— 用户看到「动画一顿一顿」，而所有守卫全绿。
 *
 * 实测（2026-09-29，`[DESIGN-PERF-004]` §2.1）：Spinner 规范 80ms / 实现 160ms，
 * 漂移 ×2.00，**存在了很久没人发现**。同族还有 `ProgressBar.RENDER_MS` 从错误的
 * 源派生（`LOW_POWER` 下一跳 2%）—— 也是靠人工读代码才发现的。
 *
 * ## 门档语义
 *
 * `gate=commit` + `severity=advisory`（S1 观察者）：
 * - 恒 `exit 0`（不阻断任何人），符合「先观察后收紧」的四阶段纪律；
 * - 但会出现在 `rules:gate:commit` 的 `action=start` 里 ⇒ 证明它**真的被执行**，
 *   而不是像 `gate=advisory` 那样恒不被 spawn（`GATE_ORDER.advisory=4 > max=2`）。
 *
 * ⚠ `STAGE` 是阶段唯一权威（`FEATURE-OWNERSHIP.json` 只是镜像，
 * `check-rollout-stage.js` 会比对两者，漂移即 error）。`severityFor()` 由 `STAGE`
 * **单点派生** —— 若把 severity 写死在判定处，S1 与 S3 会跑出完全相同的结果与退出码，
 * 升阶后**仍不拦截**，而所有守卫全绿。
 *
 * ⚠ **S3 升档前置**（`[DESIGN-PERF-004]` §8）：`A1`（降低单帧成本）已落地。否则
 * 本守卫会逼人把节拍值改回去交差 —— **过早阻断比不阻断更危险**。
 *
 * ## finding 方言（`ruleguard` 解析，写错即静默丢弃）
 *
 * - **有行号** → 逐项方言：`[WARN ] <id> <file>:<line>`，消息体在**下一行**且两空格缩进。
 *   ⚠ 该行**不得带尾随文字**（`FINDING_LINE` 的 `\s*$` 会失配 ⇒ finding 被静默丢弃）。
 * - **无行号**（`binding-orphan` / `spec-unreadable` / `fallback-unreadable`）→ 聚合方言：
 *   `- [warn] <消息> (id: <id>)`。**不给假行号** —— 宁可没有抑制锚点，也不伪造位置。
 * - **info** 不参与任何方言（`ruleguard` 只认 `ERROR`/`WARN `），按普通行打印。
 *
 * ## 用法
 *
 *   node scripts/ci/check-tui-cadence.js                   # 全量
 *   node scripts/ci/check-tui-cadence.js --changed          # commit 快档（改动集未触及节拍面则恒静默）
 *   node scripts/ci/check-tui-cadence.js --list             # 附完整盘点（含 info）
 *   node scripts/ci/check-tui-cadence.js --json             # 机器可读（末尾仍追加 Summary 行）
 *   node scripts/ci/check-tui-cadence.js --scenario=matrix  # 反例矩阵（含「应放行」对照）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const guard = require('../lib/tuiCadenceGuard.js');

// ── 阶段常量：唯一权威（FEATURE-OWNERSHIP.json 的 rollout 段只是镜像）──────────
const STAGE = 'S1';

const ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return path.resolve(__dirname, '..', '..');
  }
})();

/** 本守卫关心的文件面 —— 用于 `--changed` 的「是否触及」判定与登记表 `paths`。 */
const WATCH = Object.freeze([
  guard.SPEC_FILE,
  guard.IMPL_FILE,
  ...guard.BINDINGS.map((b) => b.fallbackFile).filter(Boolean),
]);

// ── 采集（本文件唯一有 IO 的地方）────────────────────────────────────────────

function readIfExists(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function collect() {
  const specAbs = path.join(ROOT, guard.SPEC_FILE);
  const specSrc = readIfExists(specAbs);
  const spec = specSrc === null
    ? { rows: [], error: '规范表文件读不到：' + guard.SPEC_FILE }
    : guard.parseSpecTable(specSrc);

  let impl = {};
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(path.join(ROOT, guard.IMPL_FILE));
    impl = guard.loadImpl(mod, {});
  } catch (err) {
    impl = {};
    // 静默吞掉会让判据整体失效 —— 记进 spec.error 不可行（不同文件），故单独标记
    // eslint-disable-next-line no-param-reassign
    spec.error = spec.error || `perfTunables 载入失败：${err && err.message}`;
  }

  const fallbacks = {};
  for (const b of guard.BINDINGS) {
    if (!b.fallbackFile || !b.spec) continue;
    const src = readIfExists(path.join(ROOT, b.fallbackFile));
    fallbacks[b.spec] = src === null
      ? { value: null, line: null, error: '文件读不到：' + b.fallbackFile }
      : guard.extractFallback(src, b.fallbackRe);
  }

  return { spec, impl, fallbacks, bindings: guard.BINDINGS };
}

/** 暂存区（`--cached`）文件名列表。⚠ 判改动集一律用暂存区，不用工作区全量。 */
function stagedFiles() {
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * `--files=` 的**空值与未提供必须可区分**（本仓血泪：两者都返 `''` ⇒ 空值会静默
 * fall through 到真实暂存集，而 khy-os 暂存区常有数千项）。
 * @returns {string[]|null} null = 未提供
 */
function filesArgOrNull(argv) {
  const hit = argv.find((a) => a.startsWith('--files='));
  if (!hit) return null;
  const raw = hit.slice('--files='.length);
  if (!raw.trim()) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

function render(findings, meta) {
  const L = [];
  if (meta && meta.verbose) {
    L.push(`节拍守卫（RUNTIME-011 · 阶段 ${meta.stage}）`);
    L.push(`  模式：${meta.mode}`);
    L.push(`  关心面：${WATCH.join(', ')}`);
    L.push(`  对账：${meta.boundCount} 条绑定 / 规范表 ${meta.specRows} 行 / perfTunables ${meta.implCount} 个旋钮`);
    L.push('');
  }

  if (!findings.length) {
    L.push('✓ 规范表 / perfTunables / 组件兜底值三方一致（或无绑定缺口）。');
    return L.join('\n');
  }

  for (const f of findings) {
    if (f.severity === guard.SEV.INFO) {
      // info 不参与 ruleguard 方言（它只认 ERROR/WARN）—— 按普通行打印即可
      L.push(`${guard.labelOf(f.severity)} ${f.criterion} ${f.file}${f.line ? `:${f.line}` : ''} — ${f.message}`);
      continue;
    }
    if (typeof f.line === 'number' && f.line > 0) {
      // 逐项方言：`[WARN ] <id> <file>:<line>` + 两空格缩进的消息体。
      // ⚠ 该行**不得带尾随文字** —— 否则 FINDING_LINE 的 `\s*$` 失配，finding 被静默丢弃。
      L.push(`${guard.labelOf(f.severity)} ${f.criterion} ${f.file}:${f.line}`);
      L.push(`  ${f.message}`);
    } else {
      // 聚合方言：无 file:line 的盘点型 finding。**不伪造行号**。
      L.push(`- [${f.severity === guard.SEV.ERROR ? 'error' : 'warn'}] ${f.message} (id: ${f.criterion})`);
    }
  }
  return L.join('\n');
}

function runMatrix() {
  const real = collect();
  const failed = [];
  for (const name of guard.SCENARIOS) {
    const findings = guard.evaluate(guard.applyScenario(name, real), { stage: STAGE });
    const res = guard.checkScenario(name, findings);
    const s = guard.summarize(findings);
    console.log(`${res.ok ? '✓' : '✗'} ${name} — ${s.errors}e/${s.warnings}w/${s.infos}i`);
    if (!res.ok) {
      for (const r of res.reasons) console.log(`    期望不符：${r}`);
      failed.push(name);
    }
  }
  console.log(`\n反例矩阵：${guard.SCENARIOS.length - failed.length}/${guard.SCENARIOS.length} 通过。`);
  return failed;
}

function main() {
  const argv = process.argv.slice(2);
  const argValue = (name, dflt) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
  };
  const isChanged = argv.includes('--changed');
  const showList = argv.includes('--list');
  const showVerbose = argv.includes('--verbose') && !isChanged;
  const scenario = argValue('scenario', '');

  if (scenario === 'matrix' || scenario === 'all') {
    const failed = runMatrix();
    console.log(`Summary: ${failed.length} error(s), 0 warning(s).`);
    return failed.length > 0 ? 1 : 0;
  }

  const real = collect();

  let input = real;
  let mode = isChanged ? 'changed' : 'full';
  if (scenario) {
    try {
      input = guard.applyScenario(scenario, real);
      mode = `scenario:${scenario}`;
    } catch (err) {
      console.error(`未知场景 ${scenario}；可用：${guard.SCENARIOS.join(', ')}, matrix`);
      return 2;
    }
  } else if (isChanged) {
    // `--changed` 的语义是「**本次改动是否触及本守卫的关心面**」，而不是「只看被改的
    // 那几个文件里的 finding」。后者会漏报：改 `perfTunables.js` 造成的漂移，其
    // finding 落在 `tui/AGENTS.md`（未被暂存）上 ⇒ 会被过滤掉。
    const explicit = filesArgOrNull(argv);
    const changed = explicit === null ? stagedFiles() : explicit;
    const touched = changed.filter((f) => WATCH.includes(f.replace(/\\/g, '/')));
    if (touched.length === 0) {
      const s = { errors: 0, warnings: 0, infos: 0, total: 0 };
      console.log(
        `本改动集未触及节拍面（${WATCH.length} 个文件），跳过。`
        + ` 若你改的是节拍值却看到这行，说明暂存区里没有它 —— 检查 git add。`
      );
      console.log(`Summary: ${s.errors} error(s), ${s.warnings} warning(s).`);
      return 0;
    }
    mode = `changed:${touched.length}`;
  }

  const findings = guard.evaluate(input, { stage: STAGE });
  const s = guard.summarize(findings);
  const meta = {
    mode,
    stage: STAGE,
    verbose: showVerbose,
    boundCount: guard.BINDINGS.filter((b) => b.spec && b.impl).length,
    specRows: (input.spec && input.spec.rows ? input.spec.rows.length : 0),
    implCount: Object.keys(input.impl || {}).length,
  };

  if (argv.includes('--json')) {
    // ⚠ `$g` 约定：`--json` 后仍追加 Summary 行 ⇒ 消费者先 split(/\n(?=Summary:)/)[0] 再 parse
    console.log(JSON.stringify({ stage: STAGE, meta, findings, summary: s }, null, 2));
    console.log(`\nSummary: ${s.errors} error(s), ${s.warnings} warning(s).`);
    return s.errors > 0 ? 1 : 0;
  }

  // info 是「缺口盘点」（恒定存在），默认不列 —— 否则 commit 快档每次都被同一批
  // 存量条目淹没，信噪比归零。要看全部用 `--list`。
  const visible = showList || showVerbose
    ? findings
    : findings.filter((f) => f.severity !== guard.SEV.INFO);
  console.log(render(visible, meta));
  if (findings.length > visible.length) {
    console.log(`（另有 ${findings.length - visible.length} 条 info 缺口盘点，未在此列出；用 --list 查看全部）`);
  }
  console.log(`Summary: ${s.errors} error(s), ${s.warnings} warning(s).`);

  // gate=commit + severity=advisory ⇒ S1 恒 exit 0；升到 S3 后由 severityFor 派生 error 才阻断
  return s.errors > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { STAGE, WATCH, collect, stagedFiles, filesArgOrNull, render, runMatrix, main };
