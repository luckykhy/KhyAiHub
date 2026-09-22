'use strict';

/**
 * workflowNodeParityGuard.js — 工作流节点类型接线守卫的**纯判定叶子**
 * （`[DESIGN-ARCH-141]` §6 的 F1 / F2 / F3）。
 *
 * 零 IO、确定性、绝不抛、可离线单测。走盘 / 读源 / 打印全部在
 * `scripts/ci/check-workflow-node-parity.js`；本文件只做判定。
 *
 * ## 为什么需要它（真源：`[DESIGN-ARCH-141]` §1.2）
 *
 * `nodeCatalog.js` 是节点类型的**声明 SSOT**，被 5 处消费（ai-backend 的 palette 与
 * `validateGraph`、导出器、CLI handler、`workflowCliCore`）——**唯独执行器不消费**：
 * `workflowExecutor.js` 自己硬编码一个 `switch (node.type)`，且 `default:` 分支把未知
 * 类型标成 `skipped` 后**继续走 default 端口**，于是整图以 `status:'completed'` 收尾。
 *
 * 后果是最危险的一类失真：**工作流「成功」了，但那个节点什么都没做**。日志里只有一行
 * `未知节点类型 … 已跳过`，没有任何一处报错。
 *
 * 三条判据：
 *
 * | id | 判据 | 现状（2026-09-23 实测） |
 * |---|---|---|
 * | `node-missing-handler` | 目录声明的每个类型，执行器必须有 handler（**单向包含**） | 11 == 11，✅ 一致 |
 * | `node-undocumented` | 执行器有 handler、目录没声明（画布不可达 / 校验会拒） | 0 条，只提示 |
 * | `unknown-node-silent-skip` | 执行器对未知类型**静默跳过并报成功** | ❌ 命中（`:518` `default:`） |
 * | `worker-unvalidated` | worker 直接把 `graphJson` 喂执行器，未校验节点类型 | ❌ 命中（`:204`） |
 *
 * 后两条是「零存量债」判据：修掉之后本守卫永久为 0 条，成为纯防回归闸。
 */

const SEV = Object.freeze({ ERROR: 'error', WARNING: 'warning' });

/** 内部 severity 只存小写规范形；渲染时经 `labelOf()` 映射成定宽 6 字符方言。 */
function labelOf(severity) {
  return severity === SEV.ERROR ? '[ERROR]' : '[WARN ]';
}

/**
 * 阶段派生：**唯一**的强度决定点（PROCESS-006 PP-3）。
 *
 * ⚠ 绝不在判定处写死 `warning` —— 那会让 STAGE 常量变成装饰：S1 与 S3 跑出完全相同
 * 的结果与退出码，升级后**仍不拦截**，而所有守卫全绿（登记表说 S3、源码常量 S3、
 * `check-rollout-stage.js` 漂移比对也过）。验收判据：同一输入在 S1/S3 下 error 数必须不同。
 *
 * @param {string} criterion
 * @param {'S1'|'S2'|'S3'|'S4'} stage
 * @returns {'error'|'warning'}
 */
function severityFor(criterion, stage = 'S1') {
  // S1/S2 观察期：一律降级为 warning，且不参与放行（PP-3：S1/S2 禁止阻断）
  if (stage === 'S1' || stage === 'S2') {
    return SEV.WARNING;
  }
  // S3+：`node-undocumented` 仍只提示 —— 它是「画布不可达」的前置条件，不是产物问题
  if (criterion === 'node-undocumented') {
    return SEV.WARNING;
  }
  return SEV.ERROR;
}

// ── 抽取 ─────────────────────────────────────────────────────────────────────

/**
 * 从 `nodeCatalog.js` 源码文本抽取声明的节点类型（非行锚定，可跨行）。
 *
 * ⚠ 文本抽取必然可能漏项（多行写法 / 注释干扰）⇒ 调用方**必须**用
 * `opts.catalogCount`（来自真实 `require` 的 `NODE_CATALOG.length`）做条数自校验。
 * 本仓血泪：多行写法被按行匹配静默漏掉，而**漏掉的那一项永远不会进入反向检查**
 * （反向检查只遍历已抽出的集合）⇒ 静默假绿。
 *
 * @param {string} src
 * @returns {string[]}
 */
function extractCatalogTypes(src) {
  const out = [];
  const re = /\{\s*\r?\n\s*type:\s*'([A-Za-z][\w]*)'/g;
  let m;
  while ((m = re.exec(String(src == null ? '' : src))) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * 从 `workflowExecutor.js` 源码里抽取 `switch (node.type) { ... }` 的 case 标签。
 * 用花括号配平定位 switch 块，避免把文件里其它 switch 的 case 混进来。
 *
 * @param {string} src
 * @returns {{ok:boolean, reason?:string, cases:string[], line:number|null,
 *            blockStart:number, blockEnd:number}}
 */
function extractExecutorCases(src) {
  const text = String(src == null ? '' : src);
  const miss = (reason) => ({
    ok: false,
    reason,
    cases: [],
    line: null,
    blockStart: -1,
    blockEnd: -1,
  });

  const anchor = text.search(/switch\s*\(\s*node\.type\s*\)/);
  if (anchor < 0) {
    return miss('未找到 `switch (node.type)` —— 执行器结构已变，判据需重写');
  }
  const open = text.indexOf('{', anchor);
  if (open < 0) {
    return miss('switch 后无 `{`');
  }
  let depth = 0;
  let end = -1;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    return miss('switch 块未配平');
  }

  const block = text.slice(open, end);
  const cases = [];
  const re = /\bcase\s+'([A-Za-z][\w]*)'\s*:/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    cases.push(m[1]);
  }
  const line = text.slice(0, anchor).split(/\r?\n/).length;
  return { ok: true, cases, line, blockStart: open, blockEnd: end };
}

// ── 判据 F1：节点类型对账（单向包含）────────────────────────────────────────

/**
 * 节点类型对账。判据是**单向包含**：目录声明的每个类型，执行器都必须有 handler。
 * 反向不判 error：执行器允许有目录外的实验性类型，但那样画布画不出来，只记 warning。
 *
 * @param {string} execSrc      workflowExecutor.js 源码文本
 * @param {string} catalogSrc   nodeCatalog.js 源码文本
 * @param {{catalogCount?:number}} [opts]  真实 `require` 得到的目录条目数（条数自校验用）
 * @returns {{extraction:{ok:boolean,reason:string}, catalogTypes:string[],
 *   executorTypes:string[], missingHandlers:string[], extraHandlers:string[],
 *   executorSwitchLine:number|null}}
 */
function analyzeParity(execSrc, catalogSrc, opts = {}) {
  const catalogTypes = extractCatalogTypes(catalogSrc);
  const ex = extractExecutorCases(execSrc);

  // 抽取条数自校验：正则抽出的条数必须等于真实 require 的条目数，否则静默漏项。
  const expected = Number.isInteger(opts.catalogCount) ? opts.catalogCount : null;
  const uniqueCatalog = [...new Set(catalogTypes)];
  const extraction = { ok: true, reason: '' };
  if (!catalogTypes.length) {
    extraction.ok = false;
    extraction.reason = '目录类型抽取为 0 条 —— 抽取失效';
  } else if (uniqueCatalog.length !== catalogTypes.length) {
    extraction.ok = false;
    extraction.reason =
      `目录类型抽取出现重复（${catalogTypes.length} 条 / ${uniqueCatalog.length} 唯一）`;
  } else if (expected != null && expected !== catalogTypes.length) {
    extraction.ok = false;
    extraction.reason =
      `抽取条数 ${catalogTypes.length} != require 条数 ${expected}（文本抽取漏项）`;
  }
  if (!ex.ok) {
    extraction.ok = false;
    extraction.reason = ex.reason;
  }

  const execSet = new Set(ex.cases);
  const catSet = new Set(catalogTypes);
  return {
    extraction,
    catalogTypes,
    executorTypes: ex.cases,
    missingHandlers: catalogTypes.filter((t) => !execSet.has(t)),
    extraHandlers: ex.cases.filter((t) => !catSet.has(t)),
    executorSwitchLine: ex.ok ? ex.line : null,
  };
}

// ── 判据 F2：未知节点类型必须 fail-closed ────────────────────────────────────

/**
 * 检查执行器对未知节点类型是否 **fail-open**（静默跳过并让整图报成功）。
 *
 * 定位 `switch (node.type)` 内的 `default:` 分支，取该分支到块尾的文本：
 * 含 `throw` ⇒ fail-closed（合格）；只标 `skipped` 而不抛 ⇒ fail-open（违规）。
 *
 * @param {string} execSrc
 * @returns {{ok:boolean, reason:string, silentSkip:boolean, line:number|null}}
 */
function analyzeFailClosed(execSrc) {
  const text = String(execSrc == null ? '' : execSrc);
  const ex = extractExecutorCases(text);
  if (!ex.ok) {
    return { ok: false, reason: ex.reason, silentSkip: false, line: null };
  }
  const block = text.slice(ex.blockStart, ex.blockEnd);
  // ⚠ 用 `[ \t]*` 而非 `\s*`：`\s` 含 `\n`，会从上一行的空行起匹配，导致行号差 1。
  const m = block.match(/^[ \t]*default[ \t]*:/m);
  if (!m) {
    return { ok: false, reason: 'switch 内未找到 `default:` 分支', silentSkip: false, line: null };
  }
  const branch = block.slice(m.index);
  const line = text.slice(0, ex.blockStart + m.index).split(/\r?\n/).length;
  const throws = /\bthrow\b/.test(branch);
  const marksSkipped = /status\s*=\s*'skipped'/.test(branch);
  return {
    ok: true,
    reason: throws ? 'default 分支会抛错（fail-closed）' : 'default 分支不抛错',
    silentSkip: !throws && marksSkipped,
    line,
  };
}

// ── 判据 F3：worker 路径必须校验图 ───────────────────────────────────────────

/** worker 侧认可的图校验入口（任一出现即视为已校验）。 */
const VALIDATOR_PATTERNS = [
  /\bvalidateGraph\s*\(/,
  /\bportsFor\s*\(/,
  /\bgetNodeType\s*\(/,
  /\bassertGraph\b/,
];

/**
 * 检查 worker 在执行前是否校验图。
 *
 * `workflowRunWorker.executeRun` 把 `run.graphJson` **直接**交给
 * `executor.runGraph()`；端口校验只在 ai-backend 的 REST 侧
 * （`workflowService.js`），**兜不住 worker 这一路**。
 *
 * @param {string} workerSrc
 * @returns {{ok:boolean, reason:string, validated:boolean, line:number|null}}
 */
function analyzeWorkerValidation(workerSrc) {
  const text = String(workerSrc == null ? '' : workerSrc);
  const validated = VALIDATOR_PATTERNS.some((re) => re.test(text));
  const anchor = text.search(/executor\.runGraph\s*\(/);
  return {
    ok: true,
    reason: validated ? 'worker 已含图校验入口' : 'worker 无任何图校验入口',
    validated,
    line: anchor >= 0 ? text.slice(0, anchor).split(/\r?\n/).length : null,
  };
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────

/**
 * 把三条判据的原始结果整理成 finding 列表（已按 stage 派生强度）。
 *
 * @param {{execSrc:string, catalogSrc:string, workerSrc:string, catalogCount?:number}} input
 * @param {{stage?:string}} [opts]
 * @returns {Array<{criterion:string, severity:'error'|'warning', file:string, line:number|null,
 *   message:string}>}
 */
function evaluate(input, opts = {}) {
  const stage = opts.stage || 'S1';
  const findings = [];
  const execFile = 'services/backend/src/services/domain/project/workflow/workflowExecutor.js';
  const workerFile = 'services/backend/src/services/domain/project/workflow/workflowRunWorker.js';
  const catalogFile = 'services/backend/vendor/shared/src/workflow/nodeCatalog.js';

  const parity = analyzeParity(input.execSrc, input.catalogSrc, {
    catalogCount: input.catalogCount,
  });

  if (!parity.extraction.ok) {
    findings.push({
      criterion: 'node-parity-extraction-failed',
      severity: severityFor('node-parity-extraction-failed', stage),
      file: catalogFile,
      line: null,
      message: `抽取自校验失败：${parity.extraction.reason}（判据不可信，需先修抽取）`,
    });
    return findings;
  }

  for (const t of parity.missingHandlers) {
    findings.push({
      criterion: 'node-missing-handler',
      severity: severityFor('node-missing-handler', stage),
      file: execFile,
      line: parity.executorSwitchLine,
      message:
        `节点类型 '${t}' 已在 nodeCatalog 声明，但执行器无 handler —— 运行期会被静默跳过，` +
        `整图仍报 succeeded。要么补 handler，要么从目录移除。`,
    });
  }
  for (const t of parity.extraHandlers) {
    findings.push({
      criterion: 'node-undocumented',
      severity: severityFor('node-undocumented', stage),
      file: catalogFile,
      line: null,
      message:
        `节点类型 '${t}' 执行器有 handler，但不在 nodeCatalog —— 画布不可达，` +
        `且 validateGraph 会拒。请在目录登记（含 ports 与 fields）。`,
    });
  }

  const failClosed = analyzeFailClosed(input.execSrc);
  if (failClosed.ok && failClosed.silentSkip) {
    findings.push({
      criterion: 'unknown-node-silent-skip',
      severity: severityFor('unknown-node-silent-skip', stage),
      file: execFile,
      line: failClosed.line,
      message:
        `default 分支把未知节点类型标成 skipped 后继续走 default 端口 ⇒ 整图报 completed，` +
        `但那个节点什么都没做（fail-open）。应改为 throw（fail-closed）。`,
    });
  } else if (!failClosed.ok) {
    findings.push({
      criterion: 'node-parity-extraction-failed',
      severity: severityFor('node-parity-extraction-failed', stage),
      file: execFile,
      line: null,
      message: `fail-closed 判据无法定位：${failClosed.reason}`,
    });
  }

  const worker = analyzeWorkerValidation(input.workerSrc);
  if (!worker.validated) {
    findings.push({
      criterion: 'worker-unvalidated',
      severity: severityFor('worker-unvalidated', stage),
      file: workerFile,
      line: worker.line,
      message:
        `worker 直接把 graphJson 交给 runGraph，未校验节点类型 —— 上游 REST 侧的端口校验` +
        `兜不住这一路。应在 executeRun 前过 nodeCatalog 校验。`,
    });
  }

  return findings;
}

/** @param {Array<{severity:string}>} findings */
function summarize(findings) {
  const list = Array.isArray(findings) ? findings : [];
  return {
    errors: list.filter((f) => f.severity === SEV.ERROR).length,
    warnings: list.filter((f) => f.severity === SEV.WARNING).length,
    total: list.length,
  };
}

module.exports = {
  SEV,
  labelOf,
  severityFor,
  extractCatalogTypes,
  extractExecutorCases,
  analyzeParity,
  analyzeFailClosed,
  analyzeWorkerValidation,
  evaluate,
  summarize,
};
