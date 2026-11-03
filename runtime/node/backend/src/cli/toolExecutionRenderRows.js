'use strict';

/**
 * toolExecutionRenderRows.js — S3 渲染层的**行渲染器**（四个 RENDERERS id 的实现）。
 *
 * 从 facade（toolExecutionRender.js）拆出来的第二半，原因只有一个：COMP-001 的文件预算是 500 行
 * （scripts/ci/check-code-standards.js），而四个行渲染器加上它们的封闭表已经装不进 facade 那一半。
 * 拆的是**文件**，不是职责—— facade 仍经 module.exports 原样再导出这里的一切，调用方只有一个入口。
 *
 * 本文件拥有：状态字形 / 类型标签 / family 量词的封闭表，显示截断与折叠元数据，时间戳格式化，
 * 以及 GroupHeader / StepRow / NarrationRow / DividerRow 四个渲染器的实现，外加它们的三件附属：
 * 组级叙述、子步骤聚合、分组级 nextAction。展开态 ±行在 toolExecutionRenderDiff.js（第三半）。
 * facade 拥有：RENDERERS 锚点表 ↔ 实现的覆盖率闸、渲染上下文、按锚点表派发、投影 → 显示模型。
 *
 * 纯叶子：零 IO、确定性（时钟只被格式化、不被读取）、绝不抛。契约与显示需求①–⑦ 的完整说明在
 * facade 的头部 docstring，这里不重复第二份（抄一份就会漂移）。
 */

const foundation = require('../services/domain/catalog/toolUseLoop/toolExecutionGroups');
const { TOOL_FAMILY, TOOL_RUN_STATUS } = foundation;
// ±行通道关在 toolExecutionRenderDiff.js 那一间小屋里（本层唯一碰外部模块的地方）。
const { renderDiffLines } = require('./toolExecutionRenderDiff');

// ── 封闭表：字形与标签 ────────────────────────────────────────────────────

/**
 * 状态字形。与 `cli/toolDisplayLine.js` 的 GLYPHS 在三个共享态上逐字相同
 * （[DESIGN-ARCH-155] §3 R2：字形只用这三个，颜色仅作增强，去色后信息不丢）；
 * 另三个态是 ZCode 六态里 khy-os 现有三态没有的，由本层补字形。
 *
 * 为什么不静态 require toolDisplayLine：那条链会拉进 formatters / string-width /
 * toolResultSummary（冷启动预算 100ms），且它在调用时才读 env。重复的字形由测试对着真源逐字
 * 断言，漂移立刻红——是机器看住的重复，不是静默的第二真源。
 */
const STATUS_GLYPH = Object.freeze({
  success: '✓',
  running: '◆',
  error: '✗',
  cancelled: '⊘',
  inputStreaming: '…',
  pendingApproval: '⏸',
});

const STATUS_LABEL = Object.freeze({
  success: '完成',
  running: '进行中',
  error: '失败',
  cancelled: '已取消',
  inputStreaming: '输入中',
  pendingApproval: '待批准',
});

const NEXT_ACTION_LABEL = Object.freeze({
  retry: '重试',
  resume: '恢复执行',
  heal: '修复',
  contract: '契约校验',
  ask: '需要确认',
  continue: '继续',
});

/** family → 行上「类型标签」那一格。比 toolVerb 的逐工具动词粗一级（族级，不需要工具名）。 */
const FAMILY_LABEL = Object.freeze({
  read: '读取', write: '写入', edit: '编辑', shell: '执行', search: '检索', web: '联网',
  agent: '子代理', todo: '待办', ask: '提问', mcp: 'MCP', other: '其它',
});

/**
 * family → 聚合句里的量词（图 9 "ran 1 shell command" 的那个名词）。
 * 只放**量词**，不放名词：名词已经在 FAMILY_LABEL 里（「检索 1 次」而不是「检索 1 次检索」）。
 */
const FAMILY_UNIT = Object.freeze({
  read: '个文件', write: '个文件', edit: '个文件', shell: '条命令', search: '次',
  web: '次', agent: '个', todo: '次', ask: '次', mcp: '次', other: '次',
});

/** 叙述行的 bullet。需求 ⑤：叙述是一等行，绝不被摘要吞掉。 */
const NARRATION_BULLET = '●';

// ── 内部小工具（全部纯函数） ──────────────────────────────────────────────

function _str(raw) {
  return raw == null ? '' : String(raw);
}

function _obj(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

/**
 * 数值解析。null / 空串 / 非有限值一律返回 null——`Number(null) === 0` 会把「没有时间戳」
 * 变成「1970-01-01」，`Number('') === 0` 会把「没有行号」变成第 0 行。
 */
function _num(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function _int(raw) {
  const n = _num(raw);
  return n === null || n < 0 ? 0 : Math.floor(n);
}

/** 封闭集合成员判定：不在表内就退到 fallback，不抛。 */
function _pick(raw, allowed, fallback) {
  return allowed.includes(raw) ? raw : fallback;
}

/**
 * 显示用截断（需求 ⑦）：只动显示串，全文由调用方留在数据模型里。
 * cap 为空 / 非正 / 未超限 → 不截。cap 数的是码元长度，不是显示宽度——CJK 宽度换算的真源是
 * utils/text/width 与 tui/wrapCell，由端侧在画之前做。
 * @returns {{text: string, clipped: boolean, full?: string}}
 */
function _displayText(raw, cap) {
  const s = _str(raw);
  const c = _num(cap);
  if (c === null || c <= 0 || s.length <= c) return { text: s, clipped: false };
  return { text: s.slice(0, c), clipped: true, full: s };
}

/**
 * 行高签名：折叠态变了签名必须变（foldModel 的 H5 教训）。
 * expandedRows 一并进签名——「展开后有 3 行」与「展开后有 30 行」必须不同。
 */
function _foldMeta(kind, expandedRows, expanded) {
  const n = Math.max(0, _int(expandedRows));
  return {
    kind,
    expanded: !!expanded,
    collapsedRows: 1,
    expandedRows: Math.max(1, n),
    signature: `${kind}:${n}:${expanded ? 1 : 0}`,
  };
}

/**
 * withExpandedRows — 按实际行数回填折叠元数据。
 *
 * 分组头必须先出行（它在组的第一行之前），而它展开后占几行要等行都画完才知道。所以头先按行数
 * 估值出，画完再由调用方回填——回填必须重算签名，否则「展开后 resize」会按旧行数擦屏。
 *
 * @param {object} line 任意 DisplayLine（原地改它的 fold）
 * @param {number} n 展开后的行数
 * @returns {object} 同一个 line
 */
function withExpandedRows(line, n) {
  const bag = _obj(line);
  if (!bag || !_obj(bag.fold)) return bag;
  const rows = Math.max(1, _int(n));
  bag.fold.expandedRows = rows;
  bag.fold.signature = `${bag.fold.kind}:${rows}:${bag.fold.expanded ? 1 : 0}`;
  return bag;
}

/**
 * family → 显示用词。注入优先（调用方可以接 toolVerb 那一套逐工具动词），缺省退封闭表。
 * @param {string} family
 * @param {object} opts 注入容器
 * @param {string} key opts 上的注入键名（'familyLabel' | 'familyVerb'）
 */
function _familyWord(family, opts, key) {
  const o = _obj(opts) || {};
  if (typeof o[key] === 'function') return _str(o[key](family));
  return FAMILY_LABEL[family];
}

function _durationText(ms, opts) {
  const o = _obj(opts) || {};
  if (typeof o.formatDuration === 'function') return _str(o.formatDuration(ms));
  // 缺省只做秒级整数兜底。分级措辞（ms / s / min）的真源是 cli/toolDisplayLine.js 的
  // formatToolDuration，由调用方注入，本层不重写一遍。
  return `${Math.round((_num(ms) || 0) / 1000)} 秒`;
}

// ── 时间戳（只格式化，不读取时钟） ────────────────────────────────────────

/**
 * formatClock — epoch ms → HH:MM:SS。
 *
 * 刻意用 UTC：本叶子要确定性，同一份投影在两台机器上必须给出同一个串；本地时区格式化由调用方
 * 经 `opts.formatClock` 注入（端侧知道用户在哪）。
 */
function formatClock(epochMs) {
  const n = _num(epochMs);
  if (n === null) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function formatStamp(start, end, fmt) {
  const f = typeof fmt === 'function' ? fmt : formatClock;
  const a = _num(start);
  const b = _num(end);
  const from = a === null ? '' : _str(f(a));
  const to = b === null ? '' : _str(f(b));
  const text = from && to ? `${from} → ${to}` : from || to;
  return { startedAt: a, endedAt: b, text };
}

// ── GroupHeader（ROW_KIND.group → 'GroupHeader'） ─────────────────────────

/**
 * 分组头一行（需求 ①：可折叠 + 计数 + 起止时间戳 + 复制按钮）。
 *
 * title 由调用方经 `cli/toolDisplayLine.js` 的 describeGroupLine() 算好带在 group 上：动词句 /
 * 量词 / 耗时不在此重复实现（那四样各有唯一真源）。title 缺省时退成计数句，分组头永不空白。
 * 复制只出**载荷**：剪贴板出口是 utils/ccClipboard.js 一个，本叶子零 IO。
 *
 * @param {object} group buildToolGroup 产出的 ToolGroup
 * @param {object} [opts] { childCount, expanded, formatClock }
 * @returns {object} DisplayLine
 */
function renderGroupHeader(group, opts = {}) {
  const g = _obj(group) || {};
  const o = _obj(opts) || {};
  const count = _int(g.count) || (Array.isArray(g.stepIds) ? g.stepIds.length : 0);
  const counts = _obj(g.counts) || {};
  const status = _pick(g.status, TOOL_RUN_STATUS, 'running');
  const title = _str(g.title);
  const head = title || groupCountText(count);
  return {
    kind: 'group-header',
    renderer: 'GroupHeader',
    rowKind: 'group',
    id: `group-header:${_str(g.id)}`,
    groupId: _str(g.id),
    status,
    glyph: STATUS_GLYPH[status],
    statusLabel: STATUS_LABEL[status],
    title,
    countText: groupCountText(count),
    count,
    text: `${STATUS_GLYPH[status]} ${head}`,
    timestamps: formatStamp(g.startedAt, g.endedAt, o.formatClock),
    totals: {
      succeeded: _int(counts.succeeded),
      failed: _int(counts.failed),
      unfinished: _int(counts.unfinished),
    },
    narrative: renderGroupNarrative(g, o),
    copy: { action: 'copy', label: '复制', text: _str(g.copyText) },
    fold: _foldMeta('group', o.childCount != null ? o.childCount : count, !!o.expanded),
  };
}

/** 计数句。中文无单复数变格，所以不需要 plural 助手。 */
function groupCountText(count) {
  return `执行工具 ${_int(count)} 次`;
}

/**
 * 组级叙述（需求 ④ 的后半，图 9 的 "Thought for 11s, ran 1 shell command"）。
 *
 * 子步骤在这里被折叠成一句，不是逐条列出来。叙述正文**不进来**——组级摘要吞不掉叙述
 * （需求 ⑤），叙述行另行一等渲染。
 *
 * @param {object} group ToolGroup
 * @param {object} [opts] { formatDuration, familyVerb }
 * @returns {string} 无内容时返回空串（调用方据此不画这一格）
 */
function renderGroupNarrative(group, opts = {}) {
  const g = _obj(group) || {};
  const o = _obj(opts) || {};
  const counts = _obj(g.counts) || {};
  const parts = [];
  const thoughtMs = _num(counts.thoughtMs);
  if (thoughtMs !== null && thoughtMs > 0) parts.push(`思考 ${_durationText(thoughtMs, o)}`);
  const byFamily = _obj(counts.byFamily) || {};
  for (const family of TOOL_FAMILY) {
    const n = _int(byFamily[family]);
    if (n > 0) parts.push(`${_familyWord(family, o, 'familyVerb')} ${n} ${FAMILY_UNIT[family]}`);
  }
  return parts.join('，');
}

// ── StepRow（ROW_KIND.step → 'StepRow'） ─────────────────────────────────

/**
 * 工具步骤一行（需求 ②：状态图标 + 类型标签 + 截断摘要）。
 *
 * `summary` 是显示串（D2 已按 SUMMARY_CAP 截过；`opts.summaryCap` 可再为窄终端截一次），
 * `full` 始终指向数据模型里的全文（step.summaryFull）——需求 ⑦：截断只作用于显示。
 * 分隔符用 ` · `（[DESIGN-ARCH-155] §1 冻结），四端同字符，去色后才可能逐字节相等。
 *
 * @param {object} step decodeToolStep 产出的 ToolStep
 * @param {object} [opts] { summaryCap, expanded, familyLabel }
 * @returns {object} DisplayLine
 */
function renderStepRow(step, opts = {}) {
  const s = _obj(step) || {};
  const o = _obj(opts) || {};
  const status = _pick(s.status, TOOL_RUN_STATUS, 'running');
  // family 缺失时按工具名现算一次（decodeToolStep 的同一张封闭表，不是第二套判定）：
  // 直接调本函数的调用方可能给的是原始 step，那不该让整行掉到「其它」去。
  const family = _pick(s.family, TOOL_FAMILY, null) || foundation.classifyToolFamily(s.name);
  const label = _familyWord(family, o, 'familyLabel');
  const view = _displayText(s.summary, o.summaryCap);
  const full = s.summaryFull == null ? view.full || view.text : _str(s.summaryFull);
  const line = {
    kind: 'step',
    renderer: 'StepRow',
    rowKind: 'step',
    id: `step:${_str(s.id)}`,
    stepId: _str(s.id),
    groupId: _str(s.groupId),
    status,
    glyph: STATUS_GLYPH[status],
    statusLabel: STATUS_LABEL[status],
    family,
    label,
    summary: view.text,
    full,
    truncated: view.clipped || !!s.truncated,
    text: `${STATUS_GLYPH[status]} ${label}${view.text ? ` · ${view.text}` : ''}`,
    fold: _foldMeta('step', s.artifact ? 1 : 0, !!o.expanded),
  };
  // 以下都是**引用**数据模型的字段，不是副本：本层不搬运产物 / 错误 / 进度的正文。
  if (s.artifact) line.artifact = s.artifact;
  if (s.error) line.error = s.error;
  if (s.progress) line.progress = s.progress;
  if (Array.isArray(s.childStepIds) && s.childStepIds.length) {
    line.childStepIds = s.childStepIds.slice();
  }
  return line;
}

/**
 * 子步骤聚合行（需求 ④ 的前半）。
 *
 * 聚合语义不在此重算：整组交给 D2 的 buildToolGroup，于是「没跑完」在组级、组级计数、投影
 * totals 与本行上是同一个定义（opencode ToolUsage.unfinished 的同款口径）。
 *
 * @param {object} step 父 ToolStep
 * @param {object[]} children 子 ToolStep
 * @returns {object} DisplayLine
 */
function renderSubstepSummary(step, children) {
  const s = _obj(step) || {};
  const agg = aggregateChildSteps(children);
  const t = _obj(agg.counts) || {};
  const parts = [`${agg.count} 个子步骤`];
  if (t.succeeded) parts.push(`${t.succeeded} 完成`);
  if (t.failed) parts.push(`${t.failed} 失败`);
  if (t.unfinished) parts.push(`${t.unfinished} 未完成`);
  return {
    kind: 'substep-summary',
    renderer: 'StepRow',
    rowKind: 'step',
    id: `substeps:${_str(s.id)}`,
    stepId: _str(s.id),
    groupId: _str(s.groupId),
    text: `└ ${parts.join(' · ')}`,
    aggregate: agg,
    fold: _foldMeta('substeps', agg.count, false),
  };
}

/**
 * aggregateChildSteps — 子步骤 → 聚合计数（折叠态下显示的就是它）。
 *
 * 走 D2 的 buildToolGroup 而不是自己数：状态聚合只有一处定义，两处必然漂移。
 * @returns {{count: number, status: string, counts: object}}
 */
function aggregateChildSteps(steps) {
  const group = foundation.buildToolGroup({ id: 'substeps', steps: Array.isArray(steps) ? steps : [] });
  return { count: group.count, status: group.status, counts: group.counts };
}

// ── NarrationRow（ROW_KIND.narration → 'NarrationRow'） ──────────────────

/**
 * 叙述行（需求 ⑤：一等行，● bullet，绝不被摘要吞掉）。
 *
 * 三个「不」：不被组级摘要吞（renderGroupNarrative 只读 counts，不读叙述正文）、不因为同组前面
 * 有步骤而被合并掉（投影保序，一行对一行）、不因为为空而被静默丢弃（空叙述仍出一行，只是 text
 * 只剩 bullet——「这里有过一次推理但内容为空」与「这里没有推理」是两件事）。
 *
 * @param {object} row 投影里的 narration 行
 * @param {object} [opts] { narrationCap }
 * @returns {object} DisplayLine
 */
function renderNarrationRow(row, opts = {}) {
  const bag = _obj(row) || {};
  const o = _obj(opts) || {};
  const view = _displayText(bag.text, o.narrationCap);
  return {
    kind: 'narration',
    renderer: 'NarrationRow',
    rowKind: 'narration',
    id: `narration:${_str(bag.id)}`,
    groupId: _str(bag.groupId),
    bullet: NARRATION_BULLET,
    phase: _pick(bag.phase, foundation.NARRATION_PHASE, 'commentary'),
    text: view.text ? `${NARRATION_BULLET} ${view.text}` : NARRATION_BULLET,
    full: view.full || view.text,
    truncated: view.clipped,
    fold: _foldMeta('narration', 1, false),
  };
}

// ── DividerRow（ROW_KIND.divider → 'DividerRow'） ────────────────────────

/**
 * 分割线行。空 divider 仍是**一行**（text 为空串），不是零行：转录里的呼吸感靠它，
 * 把它优化掉会让相邻两组糊成一片。
 * @returns {object} DisplayLine
 */
function renderDividerRow(row) {
  const bag = _obj(row) || {};
  const text = _str(bag.text) || _str(bag.summary);
  return {
    kind: 'divider',
    renderer: 'DividerRow',
    rowKind: 'divider',
    id: `divider:${_str(bag.id)}`,
    groupId: _str(bag.groupId),
    text,
    full: text,
    truncated: false,
    fold: _foldMeta('divider', 1, false),
  };
}

// ── 分组级 nextAction 上提（需求 ⑥） ─────────────────────────────────────

/**
 * nextAction 行：紧邻分组头，不在最后一段文字里。
 *
 * 为什么上提：nextAction 是「接下来要干什么」的唯一机器可读信号（重试 / 恢复 / 修复 / 契约校验 /
 * 需要确认 / 继续）。埋在最后一段散文里，端侧就得靠正则去捞——那正是四端四种形态的成因。
 * payload 原样带着（契约数据），本层只决定它长在哪一行。
 *
 * @param {object} action group.nextAction
 * @param {object} [group] 所属 ToolGroup（取 id 用）
 * @param {object} [opts] { expanded }
 * @returns {object} DisplayLine
 */
function renderNextAction(action, group, opts = {}) {
  const a = _obj(action) || {};
  const g = _obj(group) || {};
  const o = _obj(opts) || {};
  const kind = _pick(a.kind, foundation.NEXT_ACTION_KIND, 'continue');
  const label = NEXT_ACTION_LABEL[kind];
  const target = _str(a.target);
  const body = _str(a.text);
  const head = `${label}${target ? ` ${target}` : ''}`;
  return {
    kind: 'next-action',
    renderer: 'GroupHeader',
    rowKind: 'group',
    id: `next-action:${_str(g.id)}`,
    groupId: _str(g.id),
    actionKind: kind,
    label,
    target,
    body,
    text: body ? `${head}：${body}` : head,
    payload: _obj(a.payload) || null,
    fold: _foldMeta('next-action', 1, !!o.expanded),
  };
}

module.exports = {
  STATUS_GLYPH,
  STATUS_LABEL,
  NEXT_ACTION_LABEL,
  FAMILY_LABEL,
  FAMILY_UNIT,
  NARRATION_BULLET,
  foldMeta: _foldMeta,
  withExpandedRows,
  formatClock,
  formatStamp,
  groupCountText,
  renderGroupHeader,
  renderGroupNarrative,
  renderStepRow,
  renderSubstepSummary,
  aggregateChildSteps,
  renderDiffLines,
  renderNarrationRow,
  renderDividerRow,
  renderNextAction,
};
