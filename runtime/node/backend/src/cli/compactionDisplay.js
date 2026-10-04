'use strict';

/**
 * compactionDisplay.js — 上下文压缩过程显示的单一真源（叶子，零依赖）。
 *
 * 两个消费端：
 *   · cli/tui/ink-components/CompactionProgress.js —— Ink TUI 的压缩进度条
 *     （此前 STAGE_LABELS 内联在该组件里）；
 *   · cli/replSession.js —— 经典 REPL 的 spinner 行内嵌真条
 *     （`✻ 正在压缩对话 ███░░ 32% · AI 生成摘要`）。
 *
 * 为什么抽出来：同一套阶段名（pruning/guarding/summarizing/done）与阶段→百分比
 * 地板 previously 分散在 CompactionProgress 与 toolUseLoopCore 的字面量里，改动
 * 一处另一处就漂。这里把「阶段 → 标签 → 地板百分比」收敛成纯函数，条的**画法**
 * 仍由 services/progressiveProgress.renderBar（既有单一真源）负责，本模块只给
 * 数据，不画字符。
 *
 * 与规则 2.6 的关系：阶段名与百分比就是「步骤 n/总」的可机读形态；文案组装
 * （动作+目标+进度）由各消费端按自己的 UI 形态完成。
 */

// 阶段 → 中文标签。与 TUI CompactionProgress 的既有五阶段一一对应（含 starting）。
const STAGE_LABELS = Object.freeze({
  starting: '准备中',
  pruning: '清理冗余',
  guarding: '窗口守护',
  summarizing: '生成摘要',
  done: '完成',
});

// 阶段 → 百分比地板（真实里程碑，emitPhase 契约的取值面）。REPL 条直接画这个数；
// TUI 条以它为地板做渐进追赶。两端口径同源，不可能再漂。
const STAGE_PCT = Object.freeze({
  starting: 5,
  pruning: 15,
  guarding: 30,
  summarizing: 45,
  done: 100,
});

/**
 * 阶段 → 中文标签。未知阶段回退「压缩中」而不是 undefined（渲染层不需要再判空）。
 * @param {string} stage
 * @returns {string}
 */
function stageLabel(stage) {
  return STAGE_LABELS[String(stage || '').trim()] || '压缩中';
}

/**
 * 阶段 → 百分比地板（0..100 整数）。未知阶段按 starting 地板处理（最保守）。
 * @param {string} stage
 * @returns {number}
 */
function stagePct(stage) {
  const v = STAGE_PCT[String(stage || '').trim()];
  return Number.isFinite(v) ? v : STAGE_PCT.starting;
}

// 条的**画法**走既有单一真源。fail-soft require：引擎不可用退化为本地等价实现，
// 绝不让一个显示辅助拖垮压缩本身。
let _renderBar = null;
try {
  _renderBar = require('../services/progressiveProgress').renderBar;
} catch {
  _renderBar = null;
}

const COMPACTION_BAR_WIDTH = 20;

function _bar(pct) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  if (typeof _renderBar === 'function') {
    return _renderBar(p, COMPACTION_BAR_WIDTH);
  }
  const filled = Math.round((p / 100) * COMPACTION_BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(COMPACTION_BAR_WIDTH - filled);
}

/**
 * 组装 REPL spinner 用的一行压缩进度。
 * 形态：`正在压缩对话 ████░░░░ 32% · 生成摘要（已 12.3s）`（条画法走 renderBar 单一真源）。
 *
 * @param {object} evt - 压缩过程事件 { stage, pct?, startedAt? }
 * @param {object} [deps] - { now? }（测试注入时钟）
 * @returns {string} 完整一行（无颜色——由调用方的 chalk 着色）
 */
function buildCompactionLine(evt, deps = {}) {
  const stage = String((evt && evt.stage) || 'starting');
  const floor = Number.isFinite(Number(evt && evt.pct))
    ? Math.max(0, Math.min(100, Math.round(Number(evt.pct))))
    : stagePct(stage);
  const label = stageLabel(stage);
  const elapsed =
    Number(evt && evt.startedAt) > 0 && typeof deps.now === 'function'
      ? `（已 ${Math.max(0, (deps.now() - Number(evt.startedAt)) / 1000)
          .toFixed(1)
          .replace(/\.0$/, '')}s）`
      : '';
  return `正在压缩对话 ${_bar(floor)} ${floor}% · ${label}${elapsed}`;
}

module.exports = {
  STAGE_LABELS,
  STAGE_PCT,
  stageLabel,
  stagePct,
  buildCompactionLine,
};
