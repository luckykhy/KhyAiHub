'use strict';

/**
 * toolExecutionRenderDiff.js — 渲染层的 ±行通道（需求 ③：行号 + ++/--）。
 *
 * 从 toolExecutionRenderRows.js 拆出来的第三半，原因只有一个：COMP-001 的文件预算是 500 行
 * （scripts/ci/check-code-standards.js），而四个行渲染器加上它们的封闭表已经装不进那一半。
 * 拆的是**文件**，不是职责——行渲染器与 facade 都经 module.exports 原样再导出这里的一切，
 * 调用方只有一个入口。
 *
 * 为什么单独一件：这是整个渲染层**唯一**会碰外部模块的地方（延迟 require `cli/writeDiffRows.js`），
 * 也是唯一一条「算不出来就返回空」而不是「退化成最短合法行」的通路。把它关在一间小屋子里，
 *「零 IO / 确定性」的账就好算：本层其余部分没有任何 require 除了 D2 那个纯叶子。
 *
 * ±行模型的唯一真源是 `cli/writeDiffRows.js` 的 buildWriteDiffRows（红绿 diff 行模型，
 * [DESIGN-ARCH-157] B 刀；行号约定与 diffLineNumbers.js 同源，双列 gutter 的真源是
 * diffGutter.js）。本层**不重算 diff**：默认经延迟 require 取真源，测试注入假实现以保确定性。
 */

/** diff 行的 ± 标记（需求 ③）。行号不进 text——gutter 宽度/对齐的真源是 diffGutter.js。 */
const DIFF_MARKER = Object.freeze({
  add: '++', del: '--', ctx: '  ', gap: '  ', meta: '  ', more: '  ', stat: '  ',
});

/** 这些 diff 行不是内容本身（上下文 / 分隔 / 统计），端侧按 dim 画。 */
const DIFF_DIM_KINDS = new Set(['ctx', 'gap', 'meta', 'more', 'stat']);

function _str(raw) {
  return raw == null ? '' : String(raw);
}

function _obj(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

/**
 * 数值解析。null / 空串 / 非有限值一律返回 null——`Number(null) === 0` 会把「没有行号」
 * 变成第 0 行，而 diff 行的 num 是 null 时端侧根本不画 gutter。
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

/** 行高签名：折叠态变了签名必须变（foldModel 的 H5 教训）。 */
function _foldMeta(kind, expandedRows, expanded) {
  const rows = Math.max(0, _int(expandedRows));
  return {
    expanded: !!expanded,
    collapsedRows: 1,
    expandedRows: Math.max(1, rows),
    signature: `${kind}:${rows}:${expanded ? 1 : 0}`,
  };
}

/**
 * 展开态的 ±行（需求 ③：行号 + ++/--）。
 *
 * `marker` 是 ++ / -- / 两空格，`num` 是行号（算不出时为 null，端侧不画 gutter）。两者分开给：
 * 标记是内容，行号是数据——把 `12 ++ foo` 拼成一个串，端侧就没法对齐 gutter 了。
 *
 * @param {object} artifact ToolStep.artifact（形状与 _khyWriteDiff 逐字节相同）
 * @param {object} [opts] { expanded, buildDiffRows, groupId }
 * @returns {object[]} 算不出 diff 时返回空数组（绝不为难看的输入抛）
 */
function renderDiffLines(artifact, opts = {}) {
  const art = _obj(artifact);
  if (!art) return [];
  const o = _obj(opts) || {};
  const build = typeof o.buildDiffRows === 'function' ? o.buildDiffRows : _defaultDiffRows;
  let rows = null;
  try {
    rows = build(art, !!o.expanded);
  } catch {
    return [];
  }
  if (!Array.isArray(rows) || !rows.length) return [];
  const artId = _str(art.filePath) || 'diff';
  return rows.map((r, i) => {
    const kind = _str(r && r.kind);
    const marker = DIFF_MARKER[kind] || '  ';
    const text = _str(r && r.text);
    return {
      kind: 'diff',
      renderer: 'StepRow',
      rowKind: 'step',
      id: `diff:${artId}:${i}`,
      groupId: _str(o.groupId),
      diffKind: kind || 'ctx',
      marker,
      num: _num(r && r.num),
      dim: DIFF_DIM_KINDS.has(kind),
      text: `${marker}${text}`,
      full: text,
      truncated: false,
      fold: _foldMeta('diff', 1, false),
    };
  });
}

function _defaultDiffRows(artifact, expanded) {
  try {
    const { buildWriteDiffRows } = require('./writeDiffRows');
    return buildWriteDiffRows(artifact, expanded);
  } catch {
    return null;
  }
}

module.exports = { DIFF_MARKER, DIFF_DIM_KINDS, renderDiffLines };
