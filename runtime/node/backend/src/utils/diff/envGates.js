'use strict';

// Default-on env gates for the structured-diff surface. Relocated verbatim from
// `cli/diffGutter.js` (P2 batch 11, [DESIGN-LAY-008] §12.2l): the pure hunk engine
// (`utils/diff/structuredHunks.js`) lives in D3 and must not require back up into
// `cli/` for a flag it reads itself. Bodies are byte-identical to the originals;
// `cli/diffGutter.js` re-exports both names so every existing call site and test
// keeps its import path.

const DUAL_FALSY = new Set(['0', 'false', 'off', 'no']);

/** 双列(旧|新)行号 gutter 开关。KHY_DIFF_DUAL_GUTTER 默认开。 */
function dualGutterEnabled(env = process.env) {
  const flag = String((env && env.KHY_DIFF_DUAL_GUTTER) || '')
    .trim()
    .toLowerCase();
  return !DUAL_FALSY.has(flag);
}

/**
 * 结构化 diff 体首行的文件路径头开关（KHY_DIFF_PATH_HEADER，默认开）。
 * DSH note(2026-07-27)在「卡片标题已含路径」的 TUI 里去掉重复路径头;经典 ANSI
 * 路径没有标题,相反**必须**自报路径 —— 同一「不重复、不缺席」原则按呈现面各取一侧。
 */
function diffPathHeaderEnabled(env = process.env) {
  const flag = String((env && env.KHY_DIFF_PATH_HEADER) || '')
    .trim()
    .toLowerCase();
  return !DUAL_FALSY.has(flag);
}

module.exports = {
  dualGutterEnabled,
  diffPathHeaderEnabled,
};
