'use strict';

/**
 * plainProcessTable — 纯叶子:把 markdown 表格渲染成**无边框、按列对齐的纯文本**。
 *
 * 背景(用户报告「输出过程表格线条太多,复制生成的过程文案太混乱」):模型 narration 里的
 * markdown 表格被 markdownRenderer._formatTableFromData 画成 `╭┬╮ │ ├┼┤ ╰┴╯` 盒线表格,
 * 复制过程文案时这些边框字符与内容混在一起,粘出来一团乱。本叶子提供一个**复制友好**的替代:
 * 列按内容宽度左对齐、以两空格分隔、表头下一行用 `---` 分隔(markdown 源风格)——没有竖线、
 * 没有盒角,且**每行去掉尾随空白**(尾随空格正是复制噪声的一大来源)。
 *
 * 契约(leaf-contract):零 IO、确定性、绝不抛。量宽/格式化/配色等**渲染器相关**能力全部由
 * 调用方注入(displayWidth、inline 格式化、表头着色、dim),故本叶子不依赖 renderTheme/formatters,
 * 保持零依赖可纯测。门控 KHY_PLAIN_PROCESS_TABLE(默认开)由渲染器读取:关 → 渲染器走旧盒线分支
 * 逐字节回退。异常输入 → 返回 null(让调用方回退),绝不抛。
 *
 * @module cli/plainProcessTable
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

// Preferred floor for a column that has to shrink. It doubles as the
// "label column" threshold: a column whose natural width is at or below this is
// left COMPLETELY alone, because those are the short key columns (`维度`,
// `Name`, `持久化`) whose whole value is being readable at a glance — letting
// them lose one column to a rounding split turned `错、只记录` into `错、只记` +
// `录`, which is exactly the ragged look we are fixing. Columns wider than this
// share what is left, in proportion to how much they actually need.
//
// It is capped per-table at floor(avail / colCount) so a many-column table on a
// narrow terminal degrades gracefully instead of refusing to shrink at all.
const MIN_COL_DEFAULT = 12;
const MIN_COL_HARD_FLOOR = 4;

/**
 * 门控。优先 flagRegistry(集中优先级),不可用时回退本地 CANON 词表。默认开。
 * @param {object} [env]
 * @returns {boolean}
 */
function plainProcessTableEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('../services/flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_PLAIN_PROCESS_TABLE', e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e.KHY_PLAIN_PROCESS_TABLE;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 把解析好的表格数据渲染成无边框、按列对齐的纯文本行数组。
 *
 * @param {{rows:string[][], colCount:number}} data  _parseTableData 的输出
 * @param {object} [helpers]  渲染器注入的能力(全部可选,缺省退化为恒等/length)
 * @param {(s:string)=>number} [helpers.measure]  显示宽度(CJK 安全);默认 .length
 * @param {(s:string)=>string} [helpers.stripMd]  剥 markdown 标记用于量宽;默认恒等
 * @param {(s:string)=>string} [helpers.format]   对可见文本套 inline 格式;默认恒等
 * @param {(s:string)=>string} [helpers.header]   表头文本着色;默认恒等
 * @param {(s:string)=>string} [helpers.dim]      分隔线着色;默认恒等
 * @param {string} [helpers.indent]  行首缩进;默认 '  '(与盒线表格一致)
 * @param {number} [helpers.maxWidth]  可用总显示列数(含 indent)。给了它**且**给了
 *   wrapLines 时,超出可用宽度的表格会被**收缩列宽 + 单元格折行**;不给 = 旧行为
 *   (列宽 = 内容最大宽度,不折行),逐字节兼容。
 * @param {(s:string,width:number,measure:(s:string)=>number)=>string[]} [helpers.wrapLines]
 *   折行函数(纯文本 → 行数组)。由调用方注入(渲染器传 markdownTableWrap.wrapCellLines),
 *   使本叶子保持零依赖。
 * @param {number} [helpers.minCol]  收缩时"宽列"的最小宽度(<= 此宽度的列视为标签列,
 *   完整保留);默认 12,并按 floor(avail/列数) 自适应下调。
 * @returns {string[]|null}  渲染行;数据非法 → null
 */
function renderPlainTable(data, helpers = {}) {
  try {
    if (!data || typeof data !== 'object') {
      return null;
    }
    const rows = Array.isArray(data.rows) ? data.rows : null;
    if (!rows || rows.length === 0) {
      return null;
    }
    const colCount =
      Number.isInteger(data.colCount) && data.colCount > 0
        ? data.colCount
        : Math.max(...rows.map((r) => (Array.isArray(r) ? r.length : 0)), 0);
    if (colCount <= 0) {
      return null;
    }

    const h = helpers || {};
    const measure =
      typeof h.measure === 'function' ? h.measure : (s) => String(s == null ? '' : s).length;
    const stripMd = typeof h.stripMd === 'function' ? h.stripMd : (s) => String(s == null ? '' : s);
    const format = typeof h.format === 'function' ? h.format : (s) => String(s == null ? '' : s);
    const header = typeof h.header === 'function' ? h.header : (s) => s;
    const dim = typeof h.dim === 'function' ? h.dim : (s) => s;
    const indent = typeof h.indent === 'string' ? h.indent : '  ';
    const maxWidth = Number.isFinite(h.maxWidth) && h.maxWidth > 0 ? Math.floor(h.maxWidth) : 0;
    const wrapLines = typeof h.wrapLines === 'function' ? h.wrapLines : null;
    const minCol = Number.isFinite(h.minCol) && h.minCol > 0 ? Math.floor(h.minCol) : MIN_COL_DEFAULT;

    const cellText = (row, col) => String(row && row[col] != null ? row[col] : '');
    // Every width in this file is measured on the STRIPPED text so markdown
    // markers never inflate a column, and so a wrapped segment (already plain)
    // measures identically to the unstripped original.
    const cellW = (s) => measure(stripMd(s));

    // Column widths from stripped (plain) content — left-align, no truncation.
    const widths = new Array(colCount).fill(0);
    for (const row of rows) {
      for (let col = 0; col < colCount; col++) {
        const w = cellW(cellText(row, col));
        if (w > widths[col]) {
          widths[col] = w;
        }
      }
    }

    // Width-aware shrink. Without it a single long cell sets its column's width
    // to the full cell length, the physical line overflows the terminal, and the
    // consumer (ink) hard-wraps it — which loses the column geometry entirely:
    // continuation rows restart at column 0 (the "表格很乱" report). Shrinking
    // here means THIS renderer owns the wrap, so continuations land back on their
    // column.
    //
    // Allocation: a column at or below `minCol` is a LABEL column and keeps its
    // natural width untouched (demand 0); the rest are floored at minCol and the
    // remaining budget is split in proportion to their UNMET demand. A table that
    // cannot fit even at the floor is left at natural width — the caller's own
    // wrapper then does what it always did, so this never regresses into an
    // unreadable sliver.
    const gutterW = 2 * Math.max(0, colCount - 1);
    const avail = maxWidth > 0 ? maxWidth - measure(indent) - gutterW : 0;
    let colW = widths;
    let wrapping = false;
    if (wrapLines && avail > 0) {
      const total = widths.reduce((a, b) => a + b, 0);
      if (total > avail) {
        // Per-table floor: many columns on a narrow terminal must still shrink.
        const floorW = Math.max(
          MIN_COL_HARD_FLOOR,
          Math.min(minCol, Math.floor(avail / colCount))
        );
        const floors = widths.map((w) => Math.min(w, floorW));
        const base = floors.reduce((a, b) => a + b, 0);
        if (base <= avail) {
          const extra = avail - base;
          const demands = widths.map((w, i) => Math.max(0, w - floors[i]));
          const totalDemand = demands.reduce((a, b) => a + b, 0);
          if (totalDemand > 0) {
            const next = floors.map((m, i) => m + Math.floor((extra * demands[i]) / totalDemand));
            // Rounding residue goes to the hungriest column so ΣcolW === avail
            // exactly (otherwise the last column silently loses a column).
            let rest = avail - next.reduce((a, b) => a + b, 0);
            if (rest > 0) {
              let widest = 0;
              for (let i = 1; i < colCount; i++) {
                if (demands[i] > demands[widest]) {
                  widest = i;
                }
              }
              next[widest] += rest;
            }
            colW = next;
            wrapping = true;
          }
        }
      }
    }

    const hasHeader = rows.length > 1;

    // Build the one-or-more physical lines a row occupies. A cell wider than its
    // column is wrapped into segments; shorter cells stay on the first line and
    // their column is padded out so the next column still starts on its own
    // column. Every line is right-padded then trimmed, so copied text is clean.
    const buildLines = (row, isHeader) => {
      const cellSegs = [];
      let maxLines = 1;
      for (let col = 0; col < colCount; col++) {
        const raw = cellText(row, col);
        let segs = null;
        if (wrapping && cellW(raw) > colW[col]) {
          try {
            segs = wrapLines(stripMd(raw), colW[col], measure);
          } catch {
            segs = null;
          }
        }
        if (!segs || segs.length === 0) {
          segs = [raw];
        }
        cellSegs.push(segs);
        if (segs.length > maxLines) {
          maxLines = segs.length;
        }
      }
      const lines = [];
      for (let li = 0; li < maxLines; li++) {
        const parts = [];
        for (let col = 0; col < colCount; col++) {
          const seg = cellSegs[col][li];
          if (seg === undefined) {
            // This cell is shorter than the row's tallest cell: pad its column
            // so the following columns keep their alignment.
            parts.push(' '.repeat(colW[col]));
            continue;
          }
          const visible = isHeader ? header(format(seg)) : format(seg);
          const gap = Math.max(0, colW[col] - cellW(seg));
          parts.push(visible + ' '.repeat(gap));
        }
        lines.push((indent + parts.join('  ')).replace(/\s+$/, ''));
      }
      return lines;
    };

    const out = [];
    out.push(...buildLines(rows[0], hasHeader));
    if (hasHeader) {
      // Header underline: dashes sized to each column, joined by two spaces.
      // Must mirror buildLines geometry exactly — a min-3 rule made narrow
      // columns (digits, "ok") bleed into the 2-space gutter and skew every
      // following segment off its column. Uses the SHRUNK widths so the rule
      // can never be wider than the table it underlines.
      const dashes = colW.map((w) => '-'.repeat(w));
      out.push((indent + dim(dashes.join('  '))).replace(/\s+$/, ''));
      for (let r = 1; r < rows.length; r++) {
        out.push(...buildLines(rows[r], false));
      }
    }
    return out;
  } catch {
    return null;
  }
}

module.exports = {
  plainProcessTableEnabled,
  renderPlainTable,
};
