#!/usr/bin/env node
'use strict';

/**
 * check-toplevel-side-effects.js — 模块顶层副作用守卫（`RUNTIME-012`）。
 *
 * 判定真源：`scripts/lib/toplevelSideEffectGuard.js`（纯叶子，零 IO、零外部依赖）。
 * 本文件只负责**采集事实**（走盘读源 / 取改动集）并渲染，不含任何判据。
 *
 * ## 为什么它是一条「守卫」而不是一次性脚本
 *
 * 判据真源：`[DESIGN-ARCH-178]` §3.1 / §4 ——
 * **任何被启动路径 require 的模块，顶层只允许声明与常量初始化；
 * 禁止在顶层调用会 `require` / `spawn` / `connect` 的函数。**
 *
 * 病灶实录（2026-10-04 实测）：`cacheService.js` 顶层写了 `initRedis();`，而
 * `initRedis()` 体内 `require('redis')` + `createClient()` + `client.connect()`。
 * 后果：`require('cacheService')` 的瞬间同步拉入整棵 redis 依赖树 ——
 * 修掉顶层调用后 `require.cache` 模块数 **543 → 1**，单这一条就是 20.4s / 542 模块。
 *
 * 为什么必须加门：仓库有 1524 个模块进首帧，**只有加门才防得住下一个**。
 *
 * ## 门档语义
 *
 * `gate=commit` + `severity=advisory`（S1 观察者）：恒 `exit 0`（不阻断任何人），
 * 但会出现在 `rules:gate:commit` 的 `action=start` 里 ⇒ 证明它**真的被执行**，
 * 而不是像 `gate=advisory` 那样恒不被 spawn（`GATE_ORDER.advisory=4 > max=2`）。
 *
 * ⚠ `STAGE` 是阶段唯一权威（`FEATURE-OWNERSHIP.json` 只是镜像，
 * `check-rollout-stage.js` 会比对两者，漂移即 error）。`severityFor()` 由 `STAGE`
 * **单点派生** —— 若把 severity 写死在判定处，S1 与 S3 会跑出完全相同的结果与退出码，
 * 升阶后**仍不拦截**，而所有守卫全绿。
 *
 * ## finding 方言（`ruleguard` 解析，写错即静默丢弃）
 *
 * - **有行号** → 逐项方言：`[WARN ] <id> <file>:<line>`，消息体在**下一行**且两空格缩进。
 *   ⚠ 该行**不得带尾随文字**（`FINDING_LINE` 的 `\s*$` 会失配 ⇒ finding 被静默丢弃）。
 * - **无行号**（`source-unreadable` / `scan-error`）→ 聚合方言：
 *   `- [warn] <消息> (id: <id>)`。**不给假行号** —— 宁可没有抑制锚点，也不伪造位置。
 * - **info**（`toplevel-side-effect-known` / `toplevel-call-imported`）不参与任何方言
 *   （`ruleguard` 只认 `ERROR`/`WARN `），按普通行打印，且**默认不列**。
 *
 * ## 用法
 *
 *   node scripts/ci/check-toplevel-side-effects.js                 # 全量
 *   node scripts/ci/check-toplevel-side-effects.js --changed        # commit 快档
 *   node scripts/ci/check-toplevel-side-effects.js --list           # 附完整盘点（含 info）
 *   node scripts/ci/check-toplevel-side-effects.js --json           # 机器可读（末尾仍追加 Summary）
 *   node scripts/ci/check-toplevel-side-effects.js --scenario=matrix # 反例矩阵（含「应放行」对照）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const guard = require('../lib/toplevelSideEffectGuard.js');

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

/** 本守卫关心的文件面 —— `--changed` 的前缀匹配与登记表 `paths` 共用同一集合。 */
const WATCH = guard.SCAN_ROOTS;

// ── 采集（本文件唯一有 IO 的地方）────────────────────────────────────────────

function walk(dir, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (guard.SKIP_SEGMENTS.includes(e.name)) continue;
      walk(p, acc);
    } else if (e.name.endsWith('.js') && !guard.TEST_FILE_RE.test(p)) {
      acc.push(p);
    }
  }
  return acc;
}

function collect() {
  const files = [];
  for (const rel of WATCH) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    for (const p of walk(abs, [])) {
      const relPath = path.relative(ROOT, p).replace(/\\/g, '/');
      try {
        files.push({ path: relPath, src: fs.readFileSync(p, 'utf8') });
      } catch (err) {
        files.push({ path: relPath, error: (err && err.message) || String(err) });
      }
    }
  }
  return { files };
}

/** 暂存区（`--cached`）文件名列表。⚠ 判改动集一律用暂存区，不用工作区全量。 */
function stagedFiles() {
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
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

/** 改动集是否触及本守卫的关心面（前缀匹配）。 */
function touchesWatch(changed) {
  const norm = changed.map((f) => String(f).replace(/\\/g, '/'));
  return norm.filter((f) => WATCH.some((r) => f === r || f.startsWith(`${r}/`)));
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

function render(findings, meta) {
  const L = [];
  if (meta && meta.verbose) {
    L.push(`顶层副作用守卫（RUNTIME-012 · 阶段 ${meta.stage}）`);
    L.push(`  模式：${meta.mode}`);
    L.push(`  关心面：${WATCH.join(', ')}`);
    L.push(`  扫描：${meta.fileCount} 个 .js（跳过测试与 node_modules）`);
    L.push(`  已知且已裁决的命中：${meta.knownCount} 条（降为 info，见 KNOWN_TOPLEVEL_SIDE_EFFECTS）`);
    L.push('  判据边界：');
    for (const x of guard.LIMITATIONS) L.push(`    · ${x}`);
    L.push('');
  }

  if (!findings.length) {
    L.push('✓ 未发现顶层副作用（顶层调用同文件函数且其体内同步可达 require/spawn/connect）。');
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
  const failed = [];
  for (const name of guard.SCENARIOS) {
    const findings = guard.evaluate(guard.applyScenario(name, {}), { stage: STAGE });
    const res = guard.checkScenario(name, findings, STAGE);
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

  // ⚠ 顺序很关键：`--changed` 的「是否触及」判定必须排在 `collect()` **之前**。
  // 否则每次提交都要白读 3000+ 个文件（实测 4.6s）才发现该跳过 —— 快档信噪比归零。
  let mode = isChanged ? 'changed' : 'full';
  let scenarioInput = null;

  if (scenario) {
    try {
      scenarioInput = guard.applyScenario(scenario, {});
      mode = `scenario:${scenario}`;
    } catch (err) {
      console.error(`未知场景 ${scenario}；可用：${guard.SCENARIOS.join(', ')}, matrix`);
      return 2;
    }
  } else if (isChanged) {
    // `--changed` 的语义是「**本次改动是否触及本守卫的关心面**」，而不是「只看被改的
    // 那几个文件里的 finding」。后者会漏报：删掉某个函数体里的 require 使别的文件
    // 从「命中」变「不命中」，finding 落在**未被暂存**的文件上 ⇒ 会被整个丢掉。
    const explicit = filesArgOrNull(argv);
    const changed = explicit === null ? stagedFiles() : explicit;
    const touched = touchesWatch(changed);
    if (touched.length === 0) {
      const s = { errors: 0, warnings: 0, infos: 0, total: 0 };
      console.log(
        `本改动集未触及顶层副作用面（${WATCH.length} 个源根），跳过。`
        + ` 若你改的是启动路径模块却看到这行，说明暂存区里没有它 —— 检查 git add。`
      );
      console.log(`Summary: ${s.errors} error(s), ${s.warnings} warning(s).`);
      return 0;
    }
    mode = `changed:${touched.length}`;
  }

  const input = scenarioInput === null ? collect() : scenarioInput;

  const findings = guard.evaluate(input, { stage: STAGE });
  const s = guard.summarize(findings);
  const meta = {
    mode,
    stage: STAGE,
    verbose: showVerbose,
    fileCount: input.files.length,
    knownCount: findings.filter((f) => f.criterion === 'toplevel-side-effect-known').length,
  };

  if (argv.includes('--json')) {
    // ⚠ `$g` 约定：`--json` 后仍追加 Summary 行 ⇒ 消费者先 split(/\n(?=Summary:)/)[0] 再 parse
    console.log(JSON.stringify({ stage: STAGE, meta, findings, summary: s }, null, 2));
    console.log(`\nSummary: ${s.errors} error(s), ${s.warnings} warning(s).`);
    return s.errors > 0 ? 1 : 0;
  }

  // info 是「缺口盘点」（已知裁决 + 盲区），恒定存在 —— 默认不列，否则 commit 快档
  // 每次都被同一批存量条目淹没，信噪比归零。要看全部用 `--list`。
  const visible = showList || showVerbose
    ? findings
    : findings.filter((f) => f.severity !== guard.SEV.INFO);
  console.log(render(visible, meta));
  if (findings.length > visible.length) {
    console.log(`（另有 ${findings.length - visible.length} 条 info 盘点，未在此列出；用 --list 查看全部）`);
  }
  console.log(`Summary: ${s.errors} error(s), ${s.warnings} warning(s).`);

  // gate=commit + severity=advisory ⇒ S1 恒 exit 0；升到 S3 后由 severityFor 派生 error 才阻断
  return s.errors > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { STAGE, WATCH, collect, stagedFiles, filesArgOrNull, touchesWatch, render, runMatrix, main };
