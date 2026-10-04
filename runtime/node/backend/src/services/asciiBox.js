'use strict';

/**
 * asciiBox.js — 纯叶子:盒式 ASCII 报告的行/分隔线基元(宽度参数化)。
 *
 * diskAnalyzeReport / upstreamStudyReport 两处的 `_row` / `_rule` 逐字节相同,
 * 唯一差异是各自闭包的模块级 `WIDTH`(60 vs 66)。此叶子把这两个基元收敛成
 * 单一真源,宽度改为显式入参 —— 调用方保留同名本地 `_row`/`_rule` 薄委托
 * (传入本模块 WIDTH),故 44 处调用点逐字节不变。
 *
 * 契约:零 I/O、确定性、绝不抛。宽度为盒内文本可视宽度(不含左右 `│ ` `│` 边框)。
 * 全角 CJK 占 2 格却只算 1 个 code unit,故填充/截断一律按 string-width 度量,
 * 超宽逐 code point 截断(绝不切半个全角字符),纯 ASCII 内容与旧行为逐字节相同。
 *
 * @module services/asciiBox
 */

const stringWidth = require('string-width');

/** 按显示宽度截断到 max 列(不足原样返回)。 */
function _clip(s, max) {
  if (stringWidth(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (stringWidth(out) + stringWidth(ch) > max) break;
    out += ch;
  }
  return out;
}

/**
 * 定宽内容行:`│ <padded> │`。超宽截断,不足右侧补空格。
 * @param {*} text 行内容(null/undefined → 空串)
 * @param {number} width 盒内可视宽度
 * @returns {string}
 */
function boxRow(text, width) {
  const s = String(text == null ? '' : text);
  const clip = _clip(s, width);
  const padded = clip + ' '.repeat(Math.max(0, width - stringWidth(clip)));
  return `│ ${padded} │`;
}

/**
 * 分隔线:无 label → 纯 `├───┤`;有 label → `├─ label ─────┤`。
 * @param {string} [label] 段标题(空 → 纯分隔线)
 * @param {number} width 盒内可视宽度
 * @returns {string}
 */
function boxRule(label, width) {
  if (!label) {
    return `├${'─'.repeat(width + 2)}┤`;
  }
  const inner = `─ ${label} `;
  const fill = width + 2 - stringWidth(inner);
  return `├${inner}${'─'.repeat(Math.max(0, fill))}┤`;
}

/**
 * 顶边框:`┌<lead>────┐`,`lead` 为已排好版的标题前缀(含前导 `─ `),
 * 其后横线按显示宽度补到与 boxRow/boxRule 同宽(width+2 内部)。
 * @param {string} lead 标题前缀(如 `─ 报告名`)
 * @param {number} width 盒内可视宽度
 * @returns {string}
 */
function boxTop(lead, width) {
  const l = String(lead == null ? '─' : lead);
  const fill = Math.max(0, width + 2 - stringWidth(l));
  return `┌${l}${'─'.repeat(fill)}┐`;
}

module.exports = { boxRow, boxRule, boxTop };
