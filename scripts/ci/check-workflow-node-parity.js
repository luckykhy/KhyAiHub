#!/usr/bin/env node
'use strict';

/**
 * check-workflow-node-parity.js — 工作流节点类型接线守卫（`[DESIGN-ARCH-141]` §6）。
 *
 * 判定真源：`scripts/lib/workflowNodeParityGuard.js`（纯叶子，零 IO）。
 * 本文件只负责**采集事实**（读源文件）并渲染，不含任何判据。
 *
 * ## 为什么它是一条「守卫」而不是一次性脚本
 *
 * `nodeCatalog.js` 是节点类型的声明 SSOT，被 5 处消费 —— **唯独执行器不消费**。
 * 两边一旦漂移，失败模式是**静默**的：目录里加了新节点类型、执行器忘了补 handler，
 * 则 `validateGraph` 放行、画布能画、导出器有文档，而运行期**整图报 completed 但那个
 * 节点什么都没做**。没有守卫就没人会发现。
 *
 * 实测（2026-09-23）：当前 11 型 == 11 型，**零存量差异** ⇒ 本守卫是纯防回归闸，
 * 可以安全做到 error 级而不让任何人替存量债买单。
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
 * ## 用法
 *
 *   node scripts/ci/check-workflow-node-parity.js              # 全量
 *   node scripts/ci/check-workflow-node-parity.js --changed     # commit 快档（本守卫无改动集依赖，恒跑）
 *   node scripts/ci/check-workflow-node-parity.js --json        # 机器可读（末尾仍追加 Summary 行）
 *   node scripts/ci/check-workflow-node-parity.js --verbose     # 附目录/执行器类型清单
 *   node scripts/ci/check-workflow-node-parity.js --scenario=matrix   # 反例矩阵（含「应放行」对照）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const guard = require('../lib/workflowNodeParityGuard.js');

// ── 阶段常量：唯一权威（FEATURE-OWNERSHIP.json 的 rollout 段只是镜像）──────────
const STAGE = 'S1';

const EXEC_REL = 'runtime/node/backend/src/services/domain/project/workflow/workflowExecutor.js';
const WORKER_REL = 'runtime/node/backend/src/services/domain/project/workflow/workflowRunWorker.js';
const CATALOG_REL = 'runtime/node/backend/vendor/shared/src/workflow/nodeCatalog.js';

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

function readOr(rel, fallback) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return fallback;
  }
}

function catalogCount() {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(path.join(ROOT, CATALOG_REL));
    return Array.isArray(mod.NODE_CATALOG) ? mod.NODE_CATALOG.length : null;
  } catch {
    return null;
  }
}

/** 采集真实事实。任何一项失败都降级为空串，绝不抛。 */
function collect() {
  return {
    execSrc: readOr(EXEC_REL, ''),
    workerSrc: readOr(WORKER_REL, ''),
    catalogSrc: readOr(CATALOG_REL, ''),
    catalogCount: catalogCount(),
  };
}

// ── 反例矩阵：合成一个「全绿基线」，再逐条注入回归 ────────────────────────────
//
// ⚠ 矩阵**不能**拿真实仓库当基线：那样期望值会随仓库当前修到哪一步而变，
//   今天绿明天红，且「应放行」那条永远不成立。正确做法是先把输入**合成到全绿**，
//   再逐条注入回归 —— 这样矩阵与仓库状态无关，才是真正的双向对照。

/** 往目录里注入一个执行器没有的类型（CRLF 安全：用正则而非字面量 `\n`）。 */
function injectCatalogType(src, type) {
  const entry =
    `{\n    type: '${type}',\n    label: '动态扇出',\n    category: 'control',\n` +
    `    inputs: IN,\n    outputs: OUT,\n    fields: [],\n    defaults: {},\n  },\n  `;
  return src.replace(/(\{\s*\r?\n\s*type:\s*'start',)/, `${entry}$1`);
}

const DEFAULT_BRANCH_RE = /^([ \t]*)default[ \t]*:[\s\S]*?(?=\n[ \t]*\})/m;

/**
 * 在 `switch (node.type)` **块内**替换 default 分支。
 *
 * ⚠⚠ 绝不能对整份源码直接 replace：`workflowExecutor.js` 里还有别的 switch
 * （`compare()` 也有 `default:`），全局找第一个会命中**错的那个** —— 实测踩过：
 * 替换"成功"、文件也变了，但改的是 `compare()` 的 default，判据依旧报 fail-open。
 * 这正是「定位必须锚定作用域」的实例。
 */
function transformDefaultBranch(execSrc, replacement) {
  const ex = guard.extractExecutorCases(execSrc);
  if (!ex.ok) return execSrc;
  // ⚠ `blockEnd` 是**排他**下标（指向 switch 的闭合 `}`）⇒ 必须 +1 把它纳入切片，
  //   否则 `(?=\n[ \t]*\})` 这个前瞻永远不成立，替换静默失效（实测踩过）。
  const block = execSrc.slice(ex.blockStart, ex.blockEnd + 1);
  if (!DEFAULT_BRANCH_RE.test(block)) return execSrc;
  const next = block.replace(DEFAULT_BRANCH_RE, replacement);
  return execSrc.slice(0, ex.blockStart) + next + execSrc.slice(ex.blockEnd + 1);
}

/** 把 default 分支改成 fail-closed（抛错）。 */
function makeFailClosed(execSrc) {
  return transformDefaultBranch(
    execSrc,
    '$1default:\n$1  throw new Error(`未知节点类型 ${node.type}`);'
  );
}

/** 把 default 分支改回 fail-open（只标 skipped、不抛）。 */
function makeFailOpen(execSrc) {
  return transformDefaultBranch(
    execSrc,
    "$1default:\n$1  entry.status = 'skipped';\n" +
      '$1  entry.summary = `未知节点类型 ${node.type}，已跳过`;'
  );
}

const VALIDATION_MARKER = '// [synthetic] validateGraph(graph);';

/**
 * 最小「未校验 worker」源：直接调 runGraph，不含任何校验入口。
 * 用它而不是「从真实源里删校验」—— 真实 worker 的校验是真代码（`assertGraphNodeTypes`），
 * 删不干净会让场景变成空转（实测：删掉合成标记后判据仍匹配到真校验 ⇒ 场景恒不触发）。
 */
const UNVALIDATED_WORKER_SRC = [
  "'use strict';",
  'const executor = require("./workflowExecutor");',
  'async function executeRun(run) {',
  '  const graph = run.graphJson || {};',
  '  const result = await executor.runGraph(graph, {});',
  '  return result;',
  '}',
  'module.exports = { executeRun };',
].join('\n');

/** 合成「全绿基线」：执行器 fail-closed + worker 含校验入口（真实 worker 已满足）。 */
function makeCleanBaseline(real) {
  return {
    ...real,
    execSrc: makeFailClosed(real.execSrc),
  };
}

const SCENARIOS = {
  clean: (base) => base,
  divergence: (base) => ({
    ...base,
    // ⚠ 探针类型名的两条约束（都实测踩过）：
    //  ① 必须**字母开头**。守卫的抽取正则要求类型名首字符是 A-Za-z，
    //     下划线开头的名字会被**静默漏掉**（实测 '__probe_injected_type__' 抽不到，
    //     注入后条数仍是 13 而非 14 ⇒ 场景报 extraction-failed 而非 node-missing-handler）。
    //  ② 必须**永不与真实目录撞名**。原用 expand，2026-09-24 真实目录声明 expand 后，
    //     注入成了重复条目，触发守卫的「重复抽取」自校验 ⇒ 同一类假红。
    // 故取一个字母开头、且明显是探针的名字。

    catalogSrc: injectCatalogType(base.catalogSrc, 'zzInjectedProbeType'),
    catalogCount: (base.catalogCount || 0) + 1,
  }),
  'fail-open': (base) => ({ ...base, execSrc: makeFailOpen(base.execSrc) }),
  'worker-unvalidated': (base) => ({ ...base, workerSrc: UNVALIDATED_WORKER_SRC }),
};

/**
 * 反例矩阵：每条场景声明期望，逐条核对。
 * ⚠ 必须同时有「应拦」与「应放行」两类 —— 只测「会拦」不测「会放行」，
 * 等于给了一个恒真断言（把判据改成无脑拦也能全绿）。
 */
function runMatrix(real) {
  const base = makeCleanBaseline(real);
  const CASES = [
    { name: 'clean', expect: [], why: '应放行：合成基线（执行器 fail-closed + worker 已校验）' },
    {
      name: 'divergence',
      expect: ['node-missing-handler'],
      why: '应拦：目录多一个类型而执行器没有 handler',
    },
    {
      name: 'fail-open',
      expect: ['unknown-node-silent-skip'],
      why: '应拦：default 分支静默跳过未知节点类型',
    },
    {
      name: 'worker-unvalidated',
      expect: ['worker-unvalidated'],
      why: '应拦：worker 丢了图校验入口',
    },
  ];

  const lines = ['═══ 反例矩阵（合成基线 + 逐条注入回归，与仓库当前状态无关）═══', ''];
  let failed = 0;

  for (const c of CASES) {
    const input = SCENARIOS[c.name](base);
    const findings = guard.evaluate(input, { stage: 'S3' }); // 用 S3 让 error 级暴露出来
    const ids = [...new Set(findings.map((f) => f.criterion))].sort();
    const want = [...c.expect].sort();
    const ok = JSON.stringify(ids) === JSON.stringify(want);
    if (!ok) failed += 1;
    lines.push(
      `${ok ? '✓' : '✗'} ${c.name.padEnd(20)} 期望 ${JSON.stringify(want)}｜实得 ${JSON.stringify(ids)}`
    );
    lines.push(`    ${c.why}`);
  }

  // 升阶自检：同一输入在 S1 与 S3 下 error 数必须不同，否则 STAGE 是装饰
  const s1 = guard.summarize(guard.evaluate(SCENARIOS['fail-open'](base), { stage: 'S1' }));
  const s3 = guard.summarize(guard.evaluate(SCENARIOS['fail-open'](base), { stage: 'S3' }));
  const stageLive = s1.errors === 0 && s3.errors > 0;
  lines.push('');
  lines.push(
    `${stageLive ? '✓' : '✗'} 升阶自检：同一输入 S1 error=${s1.errors} / S3 error=${s3.errors}（必须不同，否则 STAGE 是装饰）`
  );
  if (!stageLive) failed += 1;

  console.log(lines.join('\n'));
  console.log(`\n矩阵：${CASES.length + 1 - failed} / ${CASES.length + 1} 通过`);
  return failed;
}

// ── 渲染 ─────────────────────────────────────────────────────────────────────

function render(findings, meta, verbose) {
  const L = [];
  L.push('═══ DESIGN-ARCH-141 工作流节点类型接线 ═══');
  L.push(
    `阶段 ${STAGE}（观察期，只记录不阻断）｜模式 ${meta.mode}｜目录 ${meta.catalogTypes} 型 / 执行器 ${meta.executorTypes} 型`
  );
  if (verbose && meta.catalogList) {
    L.push(`  目录：${meta.catalogList.join(', ')}`);
    L.push(`  执行器：${meta.executorList.join(', ')}`);
  }
  L.push('');

  if (!findings.length) {
    L.push('✓ 节点类型目录与执行器 handler 双向一致；未知类型 fail-closed；worker 已校验图。');
    return L.join('\n');
  }

  // 逐项方言：`[WARN ] <criterion> <file>:<line>` + 两空格缩进的消息体。
  // ⚠ file 必须是 `\S+`（无空格），且该行**不得带尾随文字** —— 否则 ruleguard 的
  //   FINDING_LINE 正则不匹配，finding 会被静默丢弃（守卫看起来"没报"）。
  for (const f of findings) {
    const loc = f.line ? `${f.file}:${f.line}` : `${f.file}:1`;
    L.push(`${guard.labelOf(f.severity)} ${f.criterion} ${loc}`);
    L.push(`  ${f.message}`);
  }
  return L.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const argValue = (name, dflt) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
  };
  const verbose = argv.includes('--verbose');
  // ⚠ `--changed` 一票否决 verbose：门里的消费者只认 finding 方言，讲解块是噪声。
  const scenario = argValue('scenario', '');
  const showVerbose = verbose && !argv.includes('--changed');

  const real = collect();

  if (scenario === 'matrix') {
    const failed = runMatrix(real);
    console.log(`Summary: ${failed} error(s), 0 warning(s).`);
    return failed > 0 ? 1 : 0;
  }

  let input = real;
  let mode = argv.includes('--changed') ? 'changed' : 'full';
  if (scenario) {
    const fn = SCENARIOS[scenario];
    if (!fn) {
      console.error(`未知场景 ${scenario}；可用：${Object.keys(SCENARIOS).join(', ')}, matrix`);
      return 2;
    }
    input = fn(real);
    mode = `scenario:${scenario}`;
  }

  const findings = guard.evaluate(input, { stage: STAGE });
  const s = guard.summarize(findings);
  const parity = guard.analyzeParity(input.execSrc, input.catalogSrc, {
    catalogCount: input.catalogCount,
  });
  const meta = {
    mode,
    catalogTypes: parity.catalogTypes.length,
    executorTypes: parity.executorTypes.length,
    catalogList: showVerbose ? parity.catalogTypes : null,
    executorList: showVerbose ? parity.executorTypes : null,
  };

  if (argv.includes('--json')) {
    // ⚠ `$g` 约定：`--json` 后仍追加 Summary 行 ⇒ 消费者先 split(/\n(?=Summary:)/)[0] 再 parse
    console.log(JSON.stringify({ stage: STAGE, meta, findings, summary: s }, null, 2));
    console.log(`\nSummary: ${s.errors} error(s), ${s.warnings} warning(s).`);
    return s.errors > 0 ? 1 : 0;
  }

  console.log(render(findings, meta, showVerbose));
  console.log(`Summary: ${s.errors} error(s), ${s.warnings} warning(s).`);

  // gate=commit + severity=advisory ⇒ S1 恒 exit 0；升到 S3 后由 severityFor 派生 error 才阻断
  return s.errors > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { STAGE, SCENARIOS, collect, render, main };
