'use strict';

/**
 * toolExecutionStats.js — S3 渲染层的**第 3 区**：结构化汇总（聚合计数与统计）。
 *
 * 谁要：`toolExecutionReport.js` 把一次会话拼成三级区域（用户指令 / 过程 / 总结），本文件只管
 * 最下面那一区。它**不是又一段散文**——是计数与统计：会话级 totals + 逐工具 usage[]。
 *
 * 形状对齐 opencode v2 的 session-stats.ts（三路调研结论，非本仓发明）：
 *   Tools    = {mode:'none'} | {mode:'summary', totals} | {mode:'detail', totals, usage[]}
 *   ToolUsage = {name, calls, succeeded, failed, unfinished, durationP50}
 * `unfinished` 是**一等统计状态**：没跑完的工具必须可见，不能看起来像卡死。这条由 D2 的
 * normalizeStatus（paused → running）兑现，本文件只如实计数，不重新定义「没跑完」。
 *
 * 两个「不重算」：
 *   - totals 由 D2 的 projectToolExecution 产出（ succeeded / failed / unfinished / byFamily /
 *     durationP50 只有那一处定义）。调用方不给 totals 时，本文件经同一个函数现取，而不是本地
 *     再数一遍——两套计数器必然漂移。
 *   - 逐工具 durationP50 需要中位数，而 D2 的 `_median` 是私有的（它服务的是组级/计数级/
 *     投影级三个读数共用一个口径）。为一个 6 行的算术把 D2 的私有助手升成公开导出，契约代价
 *     比这 6 行大；故此处本地实现，并由测试钉住它与 D2 的口径一致（单样本 = 样本本身，
 *     偶数样本 = 中间两值均值）。
 *
 * 纯叶子：零 IO（不 require fs / child_process / net，不写标准流，不读 env）、确定性（同一份
 * steps → 同一份统计；时钟不读、随机不用、env 不碰）、绝不抛（坏输入退化成空 usage，不是抛）。
 */

const foundation = require('../services/domain/catalog/toolUseLoop/toolExecutionGroups');

/**
 * SUMMARY_MODE — 汇总档位的封闭集合（opencode session-stats 的 Tools.mode 三档）。
 * `none` = 只报跑了没有；`summary` = 加会话级 totals；`detail` = 再加逐工具 usage[]。
 * @type {Readonly<string[]>}
 */
const SUMMARY_MODE = Object.freeze(['none', 'summary', 'detail']);

/**
 * usage[] 每行的字段顺序（对象字面量的插入序即上屏序，端侧不自己重排）。
 * @type {Readonly<string[]>}
 */
const USAGE_FIELDS = Object.freeze([
  'name', 'calls', 'succeeded', 'failed', 'unfinished', 'durationP50',
]);

/** 汇总行内部用的分隔符，与渲染层其余部分同一个字符（[DESIGN-ARCH-155] §1 冻结）。 */
const SEP = ' · ';

// ── 内部小工具（全部纯函数） ───────────────────────────────────────────────

function _obj(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

function _str(raw) {
  return raw == null ? '' : String(raw);
}

function _num(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function _int(raw) {
  const n = _num(raw);
  return n === null || n < 0 ? 0 : Math.floor(n);
}

/**
 * 中位数。口径与 D2 的 `_median` 一致（排序后取中，偶数取中间两值均值）——
 * 见头部「两个不重算」第二条约定的本地实现理由。
 */
function _median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 档位归一化：未登记的值退到 'detail'（信息最多的一档），不抛。 */
function _mode(raw) {
  return SUMMARY_MODE.includes(raw) ? raw : 'detail';
}

// ── 逐工具统计 ───────────────────────────────────────────────────────────

/**
 * buildToolUsage — 扁平 steps → 逐工具 usage[]（按调用次数降序、同名按名字典序，确定性）。
 *
 * 状态计数经 D2 的 buildToolGroup 聚合，不在本地 if/else 六态：组级状态、组级计数、投影 totals
 * 与这里必须是同一个「没跑完」定义（opencode ToolUsage.unfinished 的同款口径）。
 *
 * @param {object[]} steps 原始或已解码的 steps（decodeToolStep 幂等）
 * @returns {Array<{name: string, calls: number, succeeded: number, failed: number, unfinished: number, durationP50: number}>}
 */
function buildToolUsage(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const byName = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const step = foundation.decodeToolStep(list[i], i);
    const name = _str(step.name) || '未命名工具';
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(step);
  }
  const usage = [];
  for (const [name, own] of byName) {
    const agg = foundation.buildToolGroup({ id: `usage:${name}`, steps: own });
    const durations = own
      .map((s) => _num(s.durationMs))
      .filter((d) => d !== null && d > 0);
    usage.push({
      name,
      calls: agg.count,
      succeeded: _int(agg.counts.succeeded),
      failed: _int(agg.counts.failed),
      unfinished: _int(agg.counts.unfinished),
      durationP50: _median(durations),
    });
  }
  usage.sort((a, b) => (b.calls - a.calls) || a.name.localeCompare(b.name));
  return usage;
}

/**
 * resolveTotals — 取会话级 totals（D2 唯一生产者）。
 *
 * 调用方（渲染层）手里通常已经有投影的 totals，直接传；没有时经 projectToolExecution 现取，
 * 于是「本地再数一遍」这条歧路不存在。
 *
 * @param {object[]} steps
 * @param {object} [totals] 已有的 totals（优先）
 * @returns {object} D2 形状的 totals
 */
function resolveTotals(steps, totals) {
  const have = _obj(totals);
  if (have && (have.succeeded !== undefined || have.unfinished !== undefined)) return have;
  return foundation.projectToolExecution({ steps: Array.isArray(steps) ? steps : [] }).totals;
}

/**
 * buildSessionStats — steps → session-stats 形状的汇总。
 *
 * 键集随档位精确变化（opencode 三形态的逐字节对应）：
 *   none    → { mode }
 *   summary → { mode, totals }
 *   detail  → { mode, totals, usage }
 * 不许多给键：多一个键，端侧就得为「这个键什么时候在」写一遍分支。
 *
 * @param {object[]} steps
 * @param {object} [opts] { mode, totals }
 * @returns {{mode: string, totals?: object, usage?: object[]}}
 */
function buildSessionStats(steps, opts = {}) {
  const o = _obj(opts) || {};
  const mode = _mode(o.mode);
  if (mode === 'none') return { mode };
  const totals = resolveTotals(steps, o.totals);
  if (mode === 'summary') return { mode, totals };
  return { mode, totals, usage: buildToolUsage(steps) };
}

// ── 汇总的显示文本（第 3 区的人读面） ─────────────────────────────────────

/**
 * renderStatsText — stats → 汇总区的显示行（纯文本，零 ANSI）。
 *
 * 第 3 区是**结构化的总结**，所以这里出的是计数行，不是叙述句：一行总会话、一行按族、
 * detail 档再一行一个工具。三行都把「未完成」显式写出来——没跑完的工具必须可见。
 *
 * @param {object} stats buildSessionStats 的产物
 * @param {object} [opts] { formatDuration }
 * @returns {string[]} 空 stats → 空数组（不画一个空的「汇总」标题）
 */
function renderStatsText(stats, opts = {}) {
  const s = _obj(stats);
  if (!s) return [];
  const o = _obj(opts) || {};
  const totals = _obj(s.totals);
  if (!totals) return [];
  const calls = Object.values(_obj(totals.byFamily) || {}).reduce((a, b) => a + _int(b), 0);
  const head = [
    `执行工具 ${calls} 次`,
    `完成 ${_int(totals.succeeded)}`,
    `失败 ${_int(totals.failed)}`,
    `未完成 ${_int(totals.unfinished)}`,
  ].join(SEP);
  const lines = [head];
  const byFamily = Object.keys(_obj(totals.byFamily) || {})
    .filter((f) => _int(totals.byFamily[f]) > 0)
    .map((f) => `${foundation.TOOL_FAMILY.includes(f) ? f : 'other'} ${_int(totals.byFamily[f])}`);
  if (byFamily.length) lines.push(`按族：${byFamily.join(SEP)}`);
  if (Array.isArray(s.usage) && s.usage.length) {
    lines.push('按工具：');
    for (const u of s.usage) lines.push(`  ${_usageLine(u, o)}`);
  }
  return lines;
}

/**
 * 一个工具的汇总行。durationP50 为 0（没有任何耗时样本）时**不写耗时格**，而不是写「0 秒」——
 * 「没有测到耗时」与「耗时是 0」是两件事。
 */
function _usageLine(usage, opts) {
  const u = _obj(usage) || {};
  const parts = [`${_str(u.name)} ${_int(u.calls)} 次`, `完成 ${_int(u.succeeded)}`];
  if (_int(u.failed)) parts.push(`失败 ${_int(u.failed)}`);
  if (_int(u.unfinished)) parts.push(`未完成 ${_int(u.unfinished)}`);
  const p50 = _num(u.durationP50);
  if (p50 !== null && p50 > 0) parts.push(`中位耗时 ${_durationText(p50, opts)}`);
  return parts.join(SEP);
}

/**
 * 耗时分词。缺省只做秒级整数兜底；分级措辞的真源是 cli/toolDisplayLine.js 的
 * formatToolDuration，由调用方经 opts.formatDuration 注入，本文件不重写一遍。
 */
function _durationText(ms, opts) {
  const o = _obj(opts) || {};
  if (typeof o.formatDuration === 'function') return _str(o.formatDuration(ms));
  return `${Math.round((_num(ms) || 0) / 1000)} 秒`;
}

module.exports = {
  SUMMARY_MODE,
  USAGE_FIELDS,
  buildToolUsage,
  resolveTotals,
  buildSessionStats,
  renderStatsText,
};
