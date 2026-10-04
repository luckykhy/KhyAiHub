'use strict';

/**
 * footerWidthBudget.js — 页脚网关警告段的宽度预算纯叶子(BUG-012)。
 *
 * 页脚是 height:1 的单行;网关警告(`⟲ <通道> 通道已停用回退…`)是唯一可变长的段,
 * 曾在 ~125 列窗口把行尾挤出终端列数,闭合括号折行留残影。本叶子回答一个问题:
 * 「给定其余各段的实测宽与可用列数,警告段该渲什么」——判定收敛在此,组件壳
 * (ink-components/FooterBar.js)只消费结果,列宽本身仍由 App 经 effectiveCols
 * → props 传入(叶子 wiring 契约:叶子不自读 process.stdout.columns)。
 *
 * 降级阶梯:完整文案 → 按预算截断(带省略号) → `⟲ <通道名>` 短标记 → 整段让位。
 * 宁可少一条警告,不可让整行残影。
 *
 * @module cli/tui/footerWidthBudget
 */

function _displayWidth() {
  try {
    const { displayWidth } = require('../formatters');
    if (typeof displayWidth === 'function') return displayWidth;
  } catch {
    /* formatters unavailable → char-count fallback */
  }
  return (s) => String(s).length;
}

/** 按显示宽度截断,超限时留 1 列给省略号。max<=0 → 空串。 */
function truncateToWidth(text, max, widthOf) {
  const s = String(text == null ? '' : text);
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  if (limit <= 0) return '';
  if (widthOf(s) <= limit) return s;
  let out = '';
  let w = 0;
  for (const ch of Array.from(s)) {
    const cw = widthOf(ch);
    if (w + cw > limit - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/**
 * 计算警告段最终渲出的纯文本。
 * @param {object} p
 * @param {string} p.fullText 完整警告文案(段前缀空格不计入,由组件壳统一加)
 * @param {string} p.shortMark 降级短标记(`⟲ <通道名>`)
 * @param {number} p.otherWidth 其余各段(左+右,不含本段)的显示宽度之和
 * @param {number} p.cols 可用列数(effectiveCols 口径);<=0 表示未预算,原样返回
 * @param {number} [p.gapMargin] 左右两侧 space-between 间隙与安全余量,默认 4
 * @returns {{ text: string, mode: 'full'|'truncated'|'short'|'dropped' }}
 */
function skipSegment({ fullText, shortMark, otherWidth, cols, gapMargin = 4 }) {
  const widthOf = _displayWidth();
  const total = Number(cols) || 0;
  if (total <= 0) {
    return { text: String(fullText || ''), mode: 'full' };
  }
  const budget = total - (Number(otherWidth) || 0) - Math.max(0, Number(gapMargin) || 0);
  const short = String(shortMark || '');
  // 截断只有在「比短标多露出信息」时才值得(至少多 2 列,否则省略号占了便宜);
  // 不值得且短标能放下 → 短标;连短标都放不下 → 整段让位。
  const truncationUseful = budget >= widthOf(short) + 2;
  if (!truncationUseful) {
    if (short && widthOf(short) <= budget) {
      return { text: short, mode: 'short' };
    }
    return { text: '', mode: 'dropped' };
  }
  const truncated = truncateToWidth(fullText, budget, widthOf);
  return { text: truncated, mode: truncated === String(fullText || '') ? 'full' : 'truncated' };
}

module.exports = { skipSegment, truncateToWidth };
