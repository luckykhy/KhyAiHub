'use strict';

/**
 * toolExecutionRender.js — S3 渲染层：结构化工具执行输出的**显示模型**生产者（facade）。
 *
 * 谁要：`services/domain/catalog/toolUseLoop/toolExecutionGroups.js`（D2）把「这一轮跑了哪些
 * 工具」变成封闭集合上的组 / 行 / 计数；本文件（连同 toolExecutionRenderRows.js 与
 * toolExecutionRenderDiff.js 两个拆件）把那套投影变成**显示模型**——一条条带状态字形、类型标签、
 * 折叠态、截断标记的行，供 Ink TUI / 经典 REPL / 桌面 React / 网页 Vue 四端共用。此前四端各自
 * 拼分组，同一次会话出现四种形态（[DESIGN-ARCH-155] §0.3 的 Z1–Z5 同源问题）。
 *
 * 为什么是独立新模块、且此刻零消费者：CC TUI 的 AGENTS.md §0.1 写死「新增文件优先于修改现有
 * 文件」「门控关闭时行为逐字节相同」。R1 期间没有任何文件 require 本模块，所以对既有运行时
 * 行为的影响是**零**；接线（谁把投影喂进来、谁把显示模型画出去）是后续阶段的事，等人点头。
 *
 * 位置选在 cli/（D1）而不是地基同目录（D2）：渲染是 D1 的职责，而且 D2 的 RENDERERS 锚点表
 * 正是**留给本层的接口**——D2 不许 require D1，所以渲染器实现不可能放在 D2 那一侧。
 *
 * 三个文件怎么分（拆的是文件，不是职责；本 facade 原样再导出两个拆件的一切，调用方一个入口）：
 *   - 本文件：覆盖率闸、渲染上下文、按锚点表派发、投影 → 显示模型；
 *   - toolExecutionRenderRows.js：四个行渲染器的实现 + 字形/标签封闭表 + 截断与折叠元数据；
 *   - toolExecutionRenderDiff.js：展开态 ±行（本层唯一碰外部模块的一间小屋）。
 * 分成三件而不是一件，只因 COMP-001 的文件预算是 500 行（check-code-standards.js）——
 * 硬往一件里塞就得删承重注释，那是拿可维护性换门禁绿灯。
 *
 * 显示契约（[DESIGN-ARCH-081] 图 8 / 图 9 提炼，逐条由 toolExecutionRender.test.js 钉住）：
 *   ① 分组头可折叠、带计数（"执行工具 N 次"）、带起止时间戳、带复制按钮；
 *   ② 每条 = 状态图标 + 类型标签 + 截断摘要；
 *   ③ 带产物的调用（编辑 / 替换）展开后是 diff：行号 + ++/--；
 *   ④ 子步骤折叠成聚合计数，组级叙述折叠成 "思考 11 秒，执行 1 条命令" 一句；
 *   ⑤ 叙述（assistant 推理）是一等行，● bullet，绝不被摘要吞掉；
 *   ⑥ 分组级 nextAction 上提到紧邻分组头，不埋在最后一段文字里；
 *   ⑦ 截断只作用于显示；全文保留在数据模型里（本层只读、绝不回写投影）。
 *
 * 纯叶子：零 IO（不 require fs / child_process / net，不写标准流，不读 env）、确定性
 * （同一份投影 → 同一份显示模型；时钟不读、随机不用、env 不碰——时间戳只被**格式化**，
 * 不被读取）、绝不抛（任何坏输入都退化成「能渲染的最短合法结构」，一条坏数据不让整组消失）。
 * 唯一的例外关在 toolExecutionRenderDiff.js 里：±行模型经注入或延迟 require 取用。
 *
 * 渲染安全（AGENTS.md §0.2）：本层**不产出任何 ANSI 字节**——没有 DECSTBM 滚动区、没有
 * \x1B[2J、连颜色都不给（颜色是端上主题的事，四端各有一套，且 AGENTS.md §0.7 限四色）。
 * 它给的是结构化显示模型，端侧自己决定怎么画，于是「杀死滚动历史」在本层结构上不可能发生。
 */

const foundation = require('../services/domain/catalog/toolUseLoop/toolExecutionGroups');
const { ROW_KIND, RENDERERS } = foundation;
const rows = require('./toolExecutionRenderRows');
const diff = require('./toolExecutionRenderDiff');

// ── 覆盖率闸：RENDERERS 锚点表 ↔ 实现 ─────────────────────────────────────

/** 渲染器 id 的封闭集合——从 D2 锚点表**派生**，不另抄一份（抄一份就会漂移）。 */
const RENDERER_IDS = Object.freeze(Object.values(RENDERERS));

/**
 * RENDERERS 留给渲染层的接口的实现表。键必须穷尽 RENDERER_IDS——
 * 由 rendererCoverage() 与 toolExecutionRender.test.js 双向钉住。
 */
const RENDERER_IMPL = Object.freeze({
  GroupHeader: rows.renderGroupHeader,
  StepRow: rows.renderStepRow,
  NarrationRow: rows.renderNarrationRow,
  DividerRow: rows.renderDividerRow,
});

/**
 * findUnimplementedRenderers — 锚点表里哪些渲染器 id 没有实现。
 *
 * 这是「RENDERERS 是留给渲染层的接口」的机器判据：D2 那侧的测试只保证「每个 RowKind 都有个
 * 渲染器 id」，本函数保证「每个 id 都有实现」。两边合起来才是穷尽——只查一边时，往 ROW_KIND
 * 与 RENDERERS **同时**加一个成员（D2 的测试因此仍是绿的）就能静默漏一个渲染器。
 *
 * @param {object} table RENDERERS 形状的锚点表（RowKind → 渲染器 id）
 * @param {object} impl 渲染器 id → 函数
 * @returns {string[]} 未实现的渲染器 id；空数组 = 全覆盖
 */
function findUnimplementedRenderers(table, impl) {
  const have = _obj(impl) || {};
  const out = [];
  for (const id of Object.values(_obj(table) || {})) {
    if (typeof have[id] !== 'function') out.push(String(id));
  }
  return out;
}

/** 现网口径的覆盖率：锚点表 = D2 的 RENDERERS，实现 = 本层的 RENDERER_IMPL。 */
function rendererCoverage() {
  return findUnimplementedRenderers(RENDERERS, RENDERER_IMPL);
}

// ── 内部小工具 ───────────────────────────────────────────────────────────

function _str(raw) {
  return raw == null ? '' : String(raw);
}

function _obj(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

function _int(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// ── 渲染上下文 ───────────────────────────────────────────────────────────

/**
 * _adoptGroup — 收编一个组。
 *
 * 投影里的 group 已经是 buildToolGroup 的产物（带 stepIds / counts，**不带** step 本体）。
 * 对它再跑一次 buildToolGroup 会让 count 归零——那个函数只认入参里的 steps。所以先判形态：
 * 像产物的原样收编，否则（调用方给的是原始组）才建。
 */
function _adoptGroup(g) {
  const bag = _obj(g) || {};
  const built = Array.isArray(bag.stepIds) && _obj(bag.counts) && !Array.isArray(bag.steps);
  return built ? bag : foundation.buildToolGroup(bag);
}

/**
 * buildRenderContext — 投影 + 扁平 steps → 渲染上下文。
 *
 * 为什么还要 steps：`projectToolExecution` 只回 `{groups, rows, totals}`，group 上带的是
 * stepIds 而**不是 step 本体**（数据层刻意不复制 step）。于是渲染层必须由调用方把 steps 一并
 * 给它；两组来源都解码并按 id 去重（与 projectToolExecution 同口径），totals 才不会翻倍。
 *
 * @param {object} input { steps, groups, rows }
 * @param {object} [opts] 渲染选项，原样挂在 ctx.opts 上供各渲染器取
 * @returns {{stepsById: Map, groupsById: Map, groups: object[], rows: object[], opts: object}}
 */
function buildRenderContext(input, opts = {}) {
  const bag = _obj(input) || {};
  const stepsById = new Map();
  const rawSteps = Array.isArray(bag.steps) ? bag.steps : [];
  const rawGroups = (Array.isArray(bag.groups) ? bag.groups : []).map((g) => _obj(g) || {});
  const push = (list, offset) => {
    for (let i = 0; i < list.length; i += 1) {
      const s = foundation.decodeToolStep(list[i], offset + i);
      if (!stepsById.has(s.id)) stepsById.set(s.id, s);
    }
  };
  push(rawSteps, 0);
  for (const g of rawGroups) push(Array.isArray(g.steps) ? g.steps : [], rawSteps.length);
  const groups = rawGroups.map(_adoptGroup);
  const groupsById = new Map();
  for (const g of groups) if (!groupsById.has(g.id)) groupsById.set(g.id, g);
  const rowList = (Array.isArray(bag.rows) ? bag.rows : []).map((r) => _obj(r) || {});
  return { stepsById, groupsById, groups, rows: rowList, opts: _obj(opts) || {} };
}

// ── 按 RENDERERS 锚点表派发 ──────────────────────────────────────────────

/**
 * renderRow — 按 D2 的 RENDERERS 锚点表派发。
 *
 * 用锚点表而不是本地 switch on row.kind：kind → 渲染器 id 的映射只有 D2 一份真源，本地再抄
 * 一份就会在新增 RowKind 时两边不一致。行上的 kind 不在表内 → FallbackRow（不丢行、不抛）。
 *
 * @param {object} row 投影里的行
 * @param {object} [ctx] buildRenderContext 的产物
 * @returns {object} DisplayLine
 */
function renderRow(row, ctx) {
  const bag = _obj(row) || {};
  const c = _obj(ctx) || {};
  const o = _obj(c.opts) || {};
  const kind = ROW_KIND.includes(bag.kind) ? bag.kind : null;
  const rendererId = kind ? RENDERERS[kind] : 'FallbackRow';
  if (rendererId === 'GroupHeader') {
    const group = c.groupsById instanceof Map ? c.groupsById.get(_str(bag.groupId)) : null;
    return rows.renderGroupHeader(group || {}, { ...o, childCount: _int(o.childCount) });
  }
  if (rendererId === 'StepRow') {
    const step = c.stepsById instanceof Map ? c.stepsById.get(_str(bag.stepId)) : null;
    if (!step) return _orphanStepRow(bag);
    return rows.renderStepRow(step, o);
  }
  if (rendererId === 'NarrationRow') return rows.renderNarrationRow(bag, o);
  if (rendererId === 'DividerRow') return rows.renderDividerRow(bag);
  return _unknownRow(bag, rendererId, kind);
}

/** stepId 指不到任何 step：出一条显眼的坏行，不静默消失（ZCode 信封层两起事故的教训）。 */
function _orphanStepRow(row) {
  const bag = _obj(row) || {};
  return {
    kind: 'step',
    renderer: 'StepRow',
    rowKind: 'step',
    id: `step:${_str(bag.stepId)}`,
    stepId: _str(bag.stepId),
    groupId: _str(bag.groupId),
    status: 'error',
    glyph: rows.STATUS_GLYPH.error,
    statusLabel: rows.STATUS_LABEL.error,
    family: 'other',
    label: rows.FAMILY_LABEL.other,
    summary: _str(bag.summary),
    full: _str(bag.summary),
    truncated: false,
    text: `${rows.STATUS_GLYPH.error} ${rows.FAMILY_LABEL.other} · 步骤数据缺失`,
    missing: true,
    fold: rows.foldMeta('step', 1, false),
  };
}

/** 锚点表里没有的渲染器 id：照原样标出来，让漏登记在上屏时就是可见的。 */
function _unknownRow(row, rendererId, kind) {
  const bag = _obj(row) || {};
  const text = _str(bag.text) || _str(bag.summary);
  return {
    kind: 'unknown',
    renderer: _str(rendererId),
    rowKind: _str(kind),
    id: `row:${_str(bag.id)}`,
    groupId: _str(bag.groupId),
    text,
    full: text,
    truncated: false,
    unknownRenderer: true,
    fold: rows.foldMeta('unknown', 1, false),
  };
}

function _stepChildren(step, ctx) {
  const c = _obj(ctx) || {};
  const out = [];
  if (!(c.stepsById instanceof Map)) return out;
  const ids = _obj(step) && Array.isArray(step.childStepIds) ? step.childStepIds : [];
  for (const id of ids) {
    const child = c.stepsById.get(_str(id));
    if (child) out.push(child);
  }
  return out;
}

/** 一行 → 一到多条显示行（步骤行可能再带子步骤的聚合行或展开行）。 */
function _rowLines(bag, ctx) {
  const c = _obj(ctx) || {};
  const o = _obj(c.opts) || {};
  const line = renderRow(bag, c);
  const out = [line];
  if (line.kind !== 'step' || line.missing) return out;
  const step = c.stepsById instanceof Map ? c.stepsById.get(line.stepId) : null;
  const children = step ? _stepChildren(step, c) : [];
  if (!children.length) return out;
  if (o.expandSubsteps) for (const child of children) out.push(rows.renderStepRow(child, o));
  else out.push(rows.renderSubstepSummary(step, children));
  return out;
}

// ── 投影 → 显示模型 ──────────────────────────────────────────────────────

/** 组索引条目（端侧做「整组折叠」时查它，不必自己反查行）。 */
function _groupEntry(g, header) {
  return {
    id: g.id,
    header,
    headerLineId: header.id,
    lineIds: [],
    status: g.status,
    countText: header.countText,
    narrative: header.narrative,
    nextAction: null,
  };
}

/**
 * renderProjection — ToolExecutionProjection + steps → 显示模型。
 *
 * 输出**保持 rows 的 order 不重排**（text ↔ tool 的真实交错就在这个序里，与
 * `cli/tui/hooks/queryBridgeTimeline.js` 的 timeline 同口径）：分组头在该组第一行之前插入，
 * nextAction 紧跟在分组头之后（需求 ⑥）。组结构另有一份 `groups` 索引（headerLineId /
 * lineIds / nextAction），端侧要做「整组折叠」时不必自己反查。
 *
 * @param {object} projection projectToolExecution 的产物
 * @param {object[]} [steps] 与投影同源的扁平 steps（raw 或已解码，幂等）
 * @param {object} [opts] { expanded, expandSubsteps, summaryCap, narrationCap,
 *                          formatClock, formatDuration, familyLabel, familyVerb,
 *                          buildDiffRows, childCount }
 * @returns {{lines: object[], groups: object[], nextActions: object[], totals: object}}
 */
function renderProjection(projection, steps, opts = {}) {
  const proj = _obj(projection) || {};
  const ctx = buildRenderContext({ steps, groups: proj.groups, rows: proj.rows }, opts);
  const lines = [];
  const groups = [];
  const nextActions = [];
  const entryByGroup = new Map();
  const rowsByGroup = new Map();
  for (const bag of ctx.rows) {
    const gid = _str(bag.groupId);
    if (!gid) continue;
    if (!rowsByGroup.has(gid)) rowsByGroup.set(gid, []);
    rowsByGroup.get(gid).push(bag);
  }
  const emitGroup = (g) => {
    const own = rowsByGroup.get(g.id) || [];
    const header = rows.renderGroupHeader(g, { ...ctx.opts, childCount: own.length });
    lines.push(header);
    const entry = _groupEntry(g, header);
    entryByGroup.set(g.id, entry);
    groups.push(entry);
    if (g.nextAction) {
      const na = rows.renderNextAction(g.nextAction, g, ctx.opts);
      lines.push(na);
      entry.nextAction = na;
      nextActions.push(na);
    }
  };
  for (const bag of ctx.rows) {
    const gid = _str(bag.groupId);
    if (gid && !entryByGroup.has(gid)) {
      const g = ctx.groupsById.get(gid);
      if (g) emitGroup(g);
    }
    const produced = _rowLines(bag, ctx);
    for (const line of produced) lines.push(line);
    if (gid && entryByGroup.has(gid)) {
      const ids = entryByGroup.get(gid).lineIds;
      for (const line of produced) ids.push(line.id);
    }
  }
  // 一行都没有的组（例如整组被取消、没留下任何行）仍要出分组头，否则它在显示上不存在。
  for (const g of ctx.groups) if (!entryByGroup.has(g.id)) emitGroup(g);
  // 分组头的折叠行数按**实际画出来的行**回填（含子步骤聚合行，它展开时也在组里）。
  for (const entry of groups) rows.withExpandedRows(entry.header, entry.lineIds.length);
  return { lines, groups, nextActions, totals: _obj(proj.totals) || {} };
}

/**
 * renderToolExecution — 原始输入 → 显示模型（一步到位的便捷入口）。
 *
 * 分组由 D2 的 projectToolExecution 做（相邻同 family 聚合），本函数只负责把结果画出来。
 * 已经手持投影的调用方请用 renderProjection，避免重复分组。
 *
 * @param {object} input projectToolExecution 的入参（{ steps, groups, rows, describeGroup, … }）
 * @param {object} [opts] 同 renderProjection
 * @returns {{lines: object[], groups: object[], nextActions: object[], totals: object}}
 */
function renderToolExecution(input, opts = {}) {
  const bag = _obj(input) || {};
  const projection = foundation.projectToolExecution(bag);
  const steps = [];
  const push = (list) => {
    for (const s of Array.isArray(list) ? list : []) steps.push(s);
  };
  push(bag.steps);
  for (const g of Array.isArray(bag.groups) ? bag.groups : []) push(_obj(g) && g.steps);
  return renderProjection(projection, steps, opts);
}

/**
 * @typedef {object} DisplayLine
 * @property {string} kind        'group-header'|'step'|'substep-summary'|'diff'|'narration'
 *                                |'divider'|'next-action'|'unknown'
 * @property {string} renderer    产出它的渲染器 id（RENDERERS 的值，或 'FallbackRow'）
 * @property {string} rowKind     它对应的 RowKind
 * @property {string} text        显示串（含行首字形 / bullet / ± 标记，已截断）
 * @property {string} full        未截断正文（不含行首字形）——复制与悬停取它
 * @property {boolean} truncated  显示串是否被截过
 * @property {object} fold        { expanded, collapsedRows, expandedRows, signature }
 */

module.exports = {
  // 两个拆件原样再导出：调用方只 require 本 facade 一个入口。
  ...rows,
  ...diff,
  RENDERER_IDS,
  RENDERER_IMPL,
  findUnimplementedRenderers,
  rendererCoverage,
  buildRenderContext,
  renderRow,
  renderProjection,
  renderToolExecution,
};
