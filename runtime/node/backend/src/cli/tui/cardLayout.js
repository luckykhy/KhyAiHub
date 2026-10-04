'use strict';

/**
 * cardLayout — 浮层卡片（询问框 / 权限框）共用的排版语法**单一真源**。
 *
 * 为什么单独立一个叶子：两块表面此前各写一套 —— 询问框把说明句拼在标签后（折行掉回
 * 卡片左边界，续行与标签断链），权限框把字段串成散文（`红灯 L2 ·…` / `动作 x · 范围 y`
 * 各占一行、同一灰度、没有列）。同一屏里两张卡片因而长得不像一家人，且卡宽撑满终端 ——
 * 内容只占左边几十列，右边一大片空白，框看着既重又空。
 *
 * 本叶子只定义三件事，别的一概不管（选项、颜色、交互都在调用方）：
 *   1. **卡宽贴合内容**：`width = min(最宽行, 可用宽)`。撑满终端是「不美观」的头号来源；
 *   2. **一行一格 + 列对齐**：字段用 `标签 + 值`（标签列由调用方定宽对齐），续行悬挂在
 *      值列之下（复用 permissionFieldRows 的口径，CJK 按显示列计）；
 *   3. **右对齐尾注**：`确认执行 …… YES` —— 尾注（确认词 / 计数 / 键位）贴右边界，
 *      头行被裁到 `width − 尾注 − 间隔`，所以**任何一行都不会超宽**，卡片高度才可记账。
 *
 * 纯叶子：零 IO、确定性、绝不抛。
 */

const { clipCell, visWidth } = require('./wrapCell');
const { fieldRows } = require('./permissionFieldRows');

/** `borderStyle:'round'`（左右各 1 列）+ 左右各 1 列 padding。 */
const BOX_CHROME_COLS = 4;
/** 头行与右对齐尾注之间的最小空白。 */
const TAIL_GAP = 2;
/** 低于这个宽度就不再认真排版（矮窄屏）：原样交出去，别制造「全是 … 的行」。 */
const MIN_CONTENT_COLS = 8;
/** 被裁的**资源/命令**行补的指路文案：只在真的裁了的时候出现（放得下就不出现）。 */
const POINTER = '↑全文见上';
/** 作为**裁剪标记**（紧贴被裁文本）时要自带间隔，否则会与最后一个字粘在一起。 */
const POINTER_MARK = '  ' + POINTER;

function _int(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 单行裁剪。放得下时**不加任何标记**；裁了才加：
 *   · 普通行 → `…`
 *   · 带指路的行（资源/命令） → `…` + `  ↑全文见上`（进得下就用这个，进不下退化为纯 `…`）
 */
function clipRow(text, width, marker) {
  const t = String(text == null ? '' : text);
  const w = _int(width);
  if (w <= 0) return t;
  if (visWidth(t) <= w) return t;
  if (marker === POINTER_MARK) {
    const room = w - visWidth(POINTER_MARK);
    if (room >= MIN_CONTENT_COLS) {
      // 先按剩余列裁出正文（clipCell 自带 `…`），再补指路 —— 两件事都看得见。
      return clipCell(t, room) + POINTER_MARK;
    }
  }
  return clipCell(t, w, marker && marker !== POINTER_MARK ? marker : '…');
}

/**
 * 一行 → 恰好一行文本。
 * 有尾注时：头行裁到 `width − 尾注宽 − TAIL_GAP`，再补空白把尾注推到右边界。
 */
function renderRow(row, width) {
  const r = row && typeof row === 'object' ? row : { head: row };
  const w = _int(width);
  const tail = r.tail == null ? '' : String(r.tail);
  const tw = visWidth(tail);
  if (!tail || w <= 0) {
    return clipRow(r.head, w, r.pointer ? POINTER_MARK : null);
  }
  const budget = Math.max(MIN_CONTENT_COLS, w - tw - TAIL_GAP);
  const head = clipRow(r.head, budget, r.pointer ? POINTER_MARK : null);
  const pad = Math.max(TAIL_GAP, w - visWidth(head) - tw);
  return head + ' '.repeat(pad) + tail;
}

/** 该行占的显示列（用于定卡宽）。 */
function rowWidth(row, avail) {
  const r = row && typeof row === 'object' ? row : { head: row };
  const a = _int(avail);
  const tail = r.tail == null ? '' : String(r.tail);
  const tw = visWidth(tail);
  if (!tail) {
    return visWidth(clipRow(r.head, a, r.pointer ? POINTER_MARK : null));
  }
  const budget = Math.max(MIN_CONTENT_COLS, a - tw - TAIL_GAP);
  return Math.min(a, visWidth(clipRow(r.head, budget, r.pointer ? POINTER_MARK : null)) + TAIL_GAP + tw);
}

/**
 * 一批行 → 卡宽 + 已排好的文本行。
 *
 * 两遍：先按可用宽裁一遍量出最宽行（卡宽），再按卡宽重排一遍（尾注才能真正贴右边界）。
 * 卡宽 ≤ 可用宽 ⇒ 第二遍的预算只会更紧，裁过的行不会因为变宽而回退。
 *
 * @param {Array<{head:string,tail?:string,pointer?:boolean}|string>} rows
 * @param {number} avail 卡片可占的显示列数（含边框）
 * @returns {{width:number, lines:string[]}} width = **内容**宽（不含边框/padding）
 */
function layoutCard(rows, avail) {
  const list = Array.isArray(rows) ? rows : [];
  const a = _int(avail);
  const content = Math.max(MIN_CONTENT_COLS, a - BOX_CHROME_COLS);
  let width = 0;
  for (const r of list) {
    width = Math.max(width, rowWidth(r, content));
  }
  width = Math.min(Math.max(width, MIN_CONTENT_COLS), content);
  return { width, lines: list.map((r) => renderRow(r, width)) };
}

/**
 * `标签 + 值` 的续行（悬挂在值列之下）。宽度不足或值太短 → 单行。
 * @returns {string[]} 至少一行
 */
function hangingRows(label, value, width) {
  const head = String(label == null ? '' : label);
  const rows = fieldRows({ label: head, value: String(value == null ? '' : value), width: _int(width) });
  if (rows && rows.length) return rows;
  return [head + String(value == null ? '' : value)];
}

/**
 * 页脚拆行 —— 一行放不下时**按 ` · ` 分段折成两行**，绝不用 `…` 吃掉退出键。
 *
 * 为什么不能直接裁：页脚承载的是「handler 实际接受哪些键」（BUG-36），窄屏上被裁掉的
 * 往往正是尾巴上的 `Esc 取消` —— 用户看不见退出键是已登记缺陷（BUG-57 同族）。
 * 折行会多占一行，所以**调用方必须把折出来的行数记进帧高**（账面与画面同源）。
 *
 * 选折点：在所有 ≤ width 的折法里取两行宽度差最小的一种（贪心会把 `Esc 取消` 单独
 * 留在第二行，看着像掉了半句）；都不行时退化为裁剪。
 *
 * @param {string} text
 * @param {number} width 单行可占显示列
 * @returns {string[]} 1 或 2 行，每行 ≤ width（放不下时第二行仍带 `…`）
 */
function splitFooter(text, width) {
  const t = String(text == null ? '' : text);
  const w = _int(width);
  if (w <= 0 || visWidth(t) <= w) return [t];
  const parts = t.split(' · ').filter((p) => p !== '');
  if (parts.length < 2) return [clipRow(t, w)];
  let best = null;
  for (let i = 1; i < parts.length; i += 1) {
    const a = parts.slice(0, i).join(' · ');
    const b = parts.slice(i).join(' · ');
    const wa = visWidth(a);
    const wb = visWidth(b);
    if (wa > w || wb > w) continue;
    const spread = Math.abs(wa - wb);
    if (!best || spread < best.spread) best = { a, b, spread };
  }
  if (!best) {
    // 任何折法都有一行超宽：仍折，超宽那行按 `…` 收尾（不静默丢整行）
    const half = Math.ceil(parts.length / 2);
    return [clipRow(parts.slice(0, half).join(' · '), w), clipRow(parts.slice(half).join(' · '), w)];
  }
  return [best.a, best.b];
}

module.exports = {
  BOX_CHROME_COLS,
  TAIL_GAP,
  MIN_CONTENT_COLS,
  POINTER,
  POINTER_MARK,
  visWidth,
  clipRow,
  renderRow,
  rowWidth,
  layoutCard,
  hangingRows,
  splitFooter,
};
