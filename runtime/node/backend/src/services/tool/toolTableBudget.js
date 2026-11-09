'use strict';

/**
 * toolTableBudget.js — 工具表(token)预算的单一真源（纯叶子：零 require 循环、零 IO）。
 *
 * 为什么存在（实测数据）：
 *   `getToolDefinitions()` 产出 191 个定义，`estimateTokens(JSON.stringify(...))` =
 *   **59,235 token**，且**每一轮都全量发送**。对 64K 窗口的模型（deepseek-chat 等），
 *   光工具表就占掉 92% 的上下文——任务本身、文件内容、对话历史全部被挤出窗口，
 *   模型于是「跑偏/漏步骤/过早收尾」。这不是模型笨，是我们把它的工作空间吃光了。
 *
 *   对照 Claude Code / opencode：两者都只上线十余个工具。工具越多不只是贵，
 *   还直接降低**选型准确率**——191 个里有多组近重名（khy 曾同时在场 readFile 与 Read），
 *   模型在等价名之间随机选，选错即参数校验失败。
 *
 * 设计（单调、可测、可关）：
 *   budget(window) = clamp(window × RATIO, FLOOR, CEIL)
 *     - 64K  → 14,000（下限兜底，保证核心集活得下）
 *     - 128K → 15,360
 *     - 200K → 24,000
 *     - 1M   → 32,000（上限封顶，再大的窗口也不再无脑全发）
 *   保留顺序 = 核心按需集（isCore，**永远保留**，即便超预算）→ 元工具 → 其余按注册表原序。
 *   超预算即截断，并**把丢掉的名字交出来**（调用方记账）——不静默截断。
 *
 * 门控：`KHY_TOOL_TABLE_BUDGET=0|false|off|no` → 不裁剪（逐字节回退今日全量）；
 *       设为正整数 → 直接用作 token 预算（运营 dial）。
 */

const { estimateTokens } = require('../../constants/promptAnchors');
const { isMetaTool } = require('./toolTierCatalog');

/** 未知模型的保守回退窗口（真源 constants/contextWindowDefaults.js）。 */
const { UNKNOWN_MODEL_CONTEXT_WINDOW } = require('../../constants/contextWindowDefaults');

/** 工具表占窗口的比例。 */
const RATIO = 0.12;
/** 预算下限：weak-core(16)+meta(13) 实测约 13.4K token，14K 刚好兜住。 */
const FLOOR = 14000;
/** 预算上限：再大的窗口也不再无脑全发（191 个 = 59K token）。 */
const CEIL = 32000;

function _off(v) {
  return ['0', 'false', 'off', 'no'].includes(String(v == null ? '' : v).trim().toLowerCase());
}

function _posInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 解析本次请求的工具表 token 预算。
 * @param {number} window 模型上下文窗口（0/无效 → 回退默认窗口）
 * @param {object} [env]
 * @returns {number} Infinity = 不裁剪
 */
function resolveBudget(window, env = process.env) {
  const e = env || {};
  // 显式正整数 → 直接当预算用（运营 dial）
  const explicit = _posInt(e.KHY_TOOL_TABLE_BUDGET);
  if (explicit > 0) return explicit;
  if (_off(e.KHY_TOOL_TABLE_BUDGET)) return Infinity;
  const w = _posInt(window) || UNKNOWN_MODEL_CONTEXT_WINDOW;
  return Math.min(CEIL, Math.max(FLOOR, Math.floor(w * RATIO)));
}

/** 工具表 token 估算（复用提示词锚点的同一把尺子）。 */
function estimateToolTableTokens(toolDefs) {
  if (!Array.isArray(toolDefs) || toolDefs.length === 0) return 0;
  return estimateTokens(JSON.stringify(toolDefs));
}

/**
 * 保留优先级：核心按需集与工具发现通道（0）→ 元工具（1）→ 其余（2）；同级按原序（稳定、确定性）。
 *
 * 为什么工具发现通道与核心集同级（**永远保留，即便顶爆预算**）：
 *   裁剪把 165 个工具从清单里拿走，若连 `toolSearch` 一起裁掉，模型就再也拿不回来——
 *   「# Additional Tools」段宣传的逃生机变成谎言，裁剪从「可恢复的省 token」退化成
 *   「永久阉割能力面」。toolSearch 是 khy 的**本地**工具（揭示延迟工具），不依赖
 *   Anthropic 服务端，任何端点都能用；花 ~310 token 保住它，换来其余 165 个可按需取回。
 * @returns {number}
 */
function priorityOf(def, isCore) {
  const name = def && (def.name || (def.function && def.function.name));
  if (typeof isCore === 'function' && isCore(name)) return 0;
  if (/^(toolsearch|toolrecommend)$/i.test(String(name || ''))) return 0;
  if (isMetaTool(name)) return 1;
  return 2;
}

/**
 * 按预算裁剪工具表。
 *
 * @param {Array<object>} toolDefs 治理后的工具定义
 * @param {object} opts
 * @param {number} opts.window        模型上下文窗口
 * @param {(name:string)=>boolean} opts.isCore 核心按需集判定（永远保留）
 * @param {object} [opts.env]
 * @returns {{kept:Array<object>, dropped:Array<object>, budget:number, tokensBefore:number, tokensAfter:number}}
 */
function trimToBudget(toolDefs, opts = {}) {
  const env = opts.env || process.env;
  const budget = resolveBudget(opts.window, env);
  const tokensBefore = estimateToolTableTokens(toolDefs);
  if (!Array.isArray(toolDefs) || toolDefs.length === 0) {
    return { kept: [], dropped: [], budget, tokensBefore, tokensAfter: 0 };
  }
  if (!Number.isFinite(budget) || tokensBefore <= budget) {
    return { kept: toolDefs, dropped: [], budget, tokensBefore, tokensAfter: tokensBefore };
  }

  const isCore = typeof opts.isCore === 'function' ? opts.isCore : () => false;
  // 稳定排序：优先级升序，同级保持原序（Array.prototype.sort 在 V8 对 >10 元素不稳定，
  // 故显式带索引做 tie-break）。
  const indexed = toolDefs.map((def, i) => ({ def, i }));
  indexed.sort((a, b) => {
    const pa = priorityOf(a.def, isCore);
    const pb = priorityOf(b.def, isCore);
    return pa !== pb ? pa - pb : a.i - b.i;
  });

  const kept = [];
  const dropped = [];
  let tokens = 0;
  for (const { def } of indexed) {
    const cost = estimateTokens(JSON.stringify(def));
    // priority 0 = 核心按需集 + 工具发现通道：永远保留（即便把预算顶爆）；其余按预算取舍。
    const mustKeep = priorityOf(def, isCore) === 0;
    if (mustKeep || tokens + cost <= budget) {
      kept.push(def);
      tokens += cost;
    } else {
      dropped.push(def);
    }
  }
  // 保持原有相对顺序，避免裁剪改变工具表的稳定前缀（prompt 缓存友好）。
  const order = new Map(toolDefs.map((d, i) => [d, i]));
  kept.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { kept, dropped, budget, tokensBefore, tokensAfter: tokens };
}

module.exports = {
  RATIO,
  FLOOR,
  CEIL,
  resolveBudget,
  estimateToolTableTokens,
  priorityOf,
  trimToBudget,
};
