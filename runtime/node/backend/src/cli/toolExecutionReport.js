'use strict';

/**
 * toolExecutionReport.js — S3 渲染层的**三级区域组装**：一次会话的完整结构化输出。
 *
 * 谁要：`toolExecutionRender.js`（行级显示模型）与 `toolExecutionStats.js`（汇总统计）各自管一
 * 段，本文件把它们拼成用户看到的**那一份**输出。此前四个显示端（Ink TUI / 经典 REPL / 桌面
 * React / 网页 Vue）各自拼装，同一次会话出现四种形态——拼装次序尤其没人管：有的端把总结提到
 * 过程前面，有的端干脆没有用户指令那一行。
 *
 * ## 输出顺序（本文件的第一约束，先于一切其他需求）
 *
 *   第 1 区（最上）用户指令   —— 原样呈现用户说了什么。不改写、不摘要、不截断。
 *   第 2 区（中段）实现过程   —— 交替的工具调用结构化日志（渲染层七条显示契约全在这一区）。
 *   第 3 区（最下）结构化总结 —— 聚合计数与统计，不是又一段散文。
 *
 * 顺序不是「我记得这么写的」：`REPORT_ZONES` 是封闭集合，组装时按它 map 出 zones（不是按代码
 * 书写顺序 push），于是调换次序只有一条路——改 `REPORT_ZONES` 本身，而那条路有测试看着
 * （`toolExecutionReport.test.js` 的次序闸：permuted zones 必须被 zoneOrderViolations 抓到，
 * 且 renderReportText 的上屏序必须是「指令在前、汇总在末」）。每份 report 还自带
 * `orderViolations`（次序）与 `layoutViolations`（次序 + 三区齐不齐）两个自检字段，
 * 端侧可以自己复验，不必信这里。
 *
 * ## 为什么是独立新模块、且此刻零消费者
 *
 * CC TUI 的 AGENTS.md §0.1 写死「新增文件优先于修改现有文件」「门控关闭时行为逐字节相同」。
 * 没有任何既有文件 require 本模块，所以对既有运行时行为的影响是**零**；接线（谁把 instruction
 * 与 steps 喂进来、谁把 zones 画出去）是后续阶段的事，等人点头。
 *
 * ## 环境变量：本层一个都不读
 *
 * 纯叶子契约禁止读 env（读了就谈不上确定性），所以 CC 模式那个主开关不在本层判断——它属于
 * **接线层**：谁把 instruction 与 steps 喂进本模块，谁决定要不要走 CC 样式（主开关与各子开关
 * 见 `cli/tui/AGENTS.md` §1.1/§1.2）。这也意味着本模块在 Legacy 路径上同样可用：它产出的是
 * 数据与纯文本，不是 ANSI 字节。
 *
 * 纯叶子：零 IO、确定性（时钟只被格式化、不被读取）、绝不抛。渲染安全（AGENTS.md §0.2）由行层
 * 保证：本文件不产出任何 ANSI 字节，没有 DECSTBM 滚动区、没有 \x1B[2J、连颜色都不给。
 */

const foundation = require('../services/domain/catalog/toolUseLoop/toolExecutionGroups');
const render = require('./toolExecutionRender');
const stats = require('./toolExecutionStats');

/**
 * REPORT_ZONES — 三级区域的封闭集合，**次序即布局契约**。
 *
 * 冻结它不只是为了防手滑：组装函数按这个数组的顺序取 zone（见 buildToolExecutionReport），
 * 所以集合一改，输出的区域次序立刻跟着变——测试对它有双向断言（成员集 + 次序）。
 * @type {Readonly<string[]>}
 */
const REPORT_ZONES = Object.freeze(['instruction', 'process', 'summary']);

/** 第 1 区不接受任何截断：这里是唯一一处显式记录该事实的地方。 */
const INSTRUCTION_TRUNCATION = 'never';

// ── 内部小工具（全部纯函数） ───────────────────────────────────────────────

function _obj(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

function _str(raw) {
  return raw == null ? '' : String(raw);
}

function _list(raw) {
  return Array.isArray(raw) ? raw : [];
}

// ── 次序闸 ────────────────────────────────────────────────────────────────

/**
 * zoneIndex — 区域名 → 它在输出里的位置（不在封闭集合内返回 -1）。
 * @returns {number}
 */
function zoneIndex(zone) {
  return REPORT_ZONES.indexOf(_str(zone));
}

/**
 * zoneOrderViolations — 一份 zones 数组的次序违规清单（空数组 = 次序正确）。
 *
 * 这是顺序约束的**机器判据**：只看 zone 名与下标，不看内容。于是「总结被排到过程之前」
 * （用户明确要求的第一约束）在这里一定报出来，而不是靠谁记得。
 *
 * @param {object[]} zones 带 zone 字段的区域数组
 * @returns {Array<{index: number, expected: string, actual: string}>}
 */
function zoneOrderViolations(zones) {
  const out = [];
  const list = _list(zones);
  for (let i = 0; i < list.length; i += 1) {
    const bag = _obj(list[i]);
    const actual = _str(bag && bag.zone) || '(missing)';
    if (actual !== REPORT_ZONES[i]) {
      out.push({ index: i, expected: REPORT_ZONES[i], actual });
    }
  }
  return out;
}

/**
 * zoneSetViolations — 一份 zones 数组的**成员**违规清单（空数组 = 三个区都在、且没有杂区）。
 *
 * 与 zoneOrderViolations 分工：那个管次序，这个管齐不齐。少一区（例如总结被整个丢掉）在次序上
 * 是「自洽的」——[instruction, process] 逐位都对——所以必须单查一遍成员，否则第 3 区可以
 * 无声消失，而次序闸全是绿的。
 *
 * @param {object[]} zones 带 zone 字段的区域数组
 * @returns {Array<{kind: 'missing'|'unknown', zone: string}>}
 */
function zoneSetViolations(zones) {
  const list = _list(zones);
  const seen = new Set();
  for (const bag of list) {
    const name = _str(_obj(bag) && bag.zone);
    if (name) seen.add(name);
  }
  const out = [];
  for (const zone of REPORT_ZONES) {
    if (!seen.has(zone)) out.push({ kind: 'missing', zone });
  }
  for (const bag of list) {
    const name = _str(_obj(bag) && bag.zone);
    if (name && !REPORT_ZONES.includes(name)) out.push({ kind: 'unknown', zone: name });
  }
  return out;
}

/**
 * zoneLayoutViolations — 布局违规全量（次序 + 成员）。端侧复验一份 report 时调这个。
 * @returns {Array<object>}
 */
function zoneLayoutViolations(zones) {
  return [...zoneOrderViolations(zones), ...zoneSetViolations(zones)];
}

/**
 * reportZone — 按区域名取一份 report 里的那一区（取不到返回 null）。
 * 端侧画某一区时不必自己扫数组，也不会因为扫错下标而画错区。
 */
function reportZone(report, zone) {
  const want = _str(zone);
  const hit = _list(_obj(report) && report.zones).find((z) => _str(_obj(z) && z.zone) === want);
  return _obj(hit) || null;
}

/** 一份 report 的布局是否合法（次序对、三区齐）。给端侧一行用。 */
function reportOrderOk(report) {
  return zoneLayoutViolations(_obj(report) && report.zones).length === 0;
}

// ── 三个区域的构造 ───────────────────────────────────────────────────────

/**
 * 第 1 区：用户指令，原样。
 *
 * 三件事刻意不做：不改写（不 trim、不折叠空白、不动一个字符）、不摘要（不喂给任何模型或
 * 模板）、不截断（opts.summaryCap 这类显示预算对本区无效——它只属于第 2 区的步骤摘要）。
 * `truncated` 恒 false 且 `truncation` 记明原因，端侧不需要猜这里为什么没有省略号。
 */
function _instructionZone(instruction) {
  const text = _str(instruction);
  return {
    zone: 'instruction',
    position: zoneIndex('instruction'),
    kind: 'instruction',
    text,
    full: text,
    truncated: false,
    truncation: INSTRUCTION_TRUNCATION,
    lines: text ? text.split('\n') : [],
  };
}

/** 第 2 区：实现用户指令的过程（行级显示模型的全部七条契约都在这一区）。 */
function _processZone(view) {
  const v = _obj(view) || {};
  return {
    zone: 'process',
    position: zoneIndex('process'),
    kind: 'process',
    lines: _list(v.lines),
    groups: _list(v.groups),
    nextActions: _list(v.nextActions),
  };
}

/** 第 3 区：结构化总结（统计，不是散文）。 */
function _summaryZone(steps, totals, opts) {
  const o = _obj(opts) || {};
  const model = stats.buildSessionStats(steps, { mode: o.statsMode, totals });
  return {
    zone: 'summary',
    position: zoneIndex('summary'),
    kind: 'summary',
    stats: model,
    text: stats.renderStatsText(model, o),
  };
}

// ── 组装 ─────────────────────────────────────────────────────────────────

/**
 * buildToolExecutionReport — 原始输入 → 三级区域的结构化输出。
 *
 * zones 的次序**只**由 REPORT_ZONES 决定：三个区域先按名字进 Map，再按封闭集合 map 出来。
 * 代码书写顺序因此不影响输出顺序——想调换次序只能改 REPORT_ZONES，而那有测试看着。
 *
 * @param {object} input projectToolExecution 的入参加上 `instruction`（第 1 区原文）；
 *        也可以直接给已经算好的 `projection`（省一次分组）
 * @param {object} [opts] 行渲染选项 + { statsMode }（第 3 区档位）
 * @returns {{zones: object[], instruction: string, lines: object[], groups: object[],
 *            nextActions: object[], totals: object, stats: object,
 *            orderViolations: object[], layoutViolations: object[]}}
 */
function buildToolExecutionReport(input, opts = {}) {
  const bag = _obj(input) || {};
  const o = _obj(opts) || {};
  const steps = _list(bag.steps);
  const proj = _obj(bag.projection) || foundation.projectToolExecution(bag);
  const view = render.renderProjection(proj, steps, o);
  const byZone = new Map();
  byZone.set('instruction', _instructionZone(bag.instruction));
  byZone.set('process', _processZone(view));
  byZone.set('summary', _summaryZone(steps, view.totals, o));
  const zones = REPORT_ZONES.map((zone) => byZone.get(zone));
  return {
    zones,
    instruction: zones[0].text,
    lines: zones[1].lines,
    groups: zones[1].groups,
    nextActions: zones[1].nextActions,
    totals: view.totals,
    stats: zones[2].stats,
    orderViolations: zoneOrderViolations(zones),
    layoutViolations: zoneLayoutViolations(zones),
  };
}

// ── 纯文本上屏（给经典 REPL / 日志 / 快照用；Ink 端请直接用 zones 数据） ─────

/**
 * renderReportText — report → 纯文本行（三级区域依次铺开）。
 *
 * 与 zones 数据同源，不是第二条渲染路径：第 1 区逐行输出原文（含空行，一个字都不动）、
 * 第 2 区输出每条 DisplayLine 的 text、第 3 区输出汇总行。端侧要彩色/折叠时请用 zones——
 * 这里的产物是给人复制进 issue 的。
 *
 * @param {object} report buildToolExecutionReport 的产物
 * @param {object} [opts] 同 buildToolExecutionReport 的 opts（汇总区分词注入口）
 * @returns {string[]}
 */
function renderReportText(report, opts = {}) {
  const out = [];
  for (const zone of _list(_obj(report) && report.zones)) {
    const bag = _obj(zone) || {};
    if (bag.zone === 'instruction') out.push(..._instructionLines(bag));
    else if (bag.zone === 'process') out.push(..._list(bag.lines).map((l) => _str(_obj(l) && l.text)));
    else if (bag.zone === 'summary') out.push(...stats.renderStatsText(bag.stats, opts));
  }
  return out;
}

/** 第 1 区的上屏行：按 '\n' 原样拆，空指令不产行（「什么都没说」不是一行空串）。 */
function _instructionLines(zone) {
  return _list(_obj(zone) && zone.lines);
}

module.exports = {
  REPORT_ZONES,
  INSTRUCTION_TRUNCATION,
  zoneIndex,
  zoneOrderViolations,
  zoneSetViolations,
  zoneLayoutViolations,
  reportZone,
  reportOrderOk,
  buildToolExecutionReport,
  renderReportText,
};
