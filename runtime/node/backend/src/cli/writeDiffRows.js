'use strict';

/**
 * writeDiffRows — 红绿 diff 行模型的唯一生产者（[DESIGN-ARCH-157] B 刀）。
 *
 * 从 tui/ink-components/ToolLines.js 下移的纯函数族（行为逐字节保持）：
 *   - buildWriteDiffRows  : 工具结果 `_khyWriteDiff`(before/after) → ±rows
 *   - buildShellDiffRows  : shell stdout 的 unified diff → ±rows
 *   - looksLikeUnifiedDiff: stdout 是否形似 unified diff 的判定
 *   - planWordDiffPairs   : del/add 1:1 词级配对计划（clip 由调用方注入，
 *                           宽度感知口径真源在 ToolLines.clip）
 *
 * rows 契约：{kind:'add'|'del'|'ctx'|'gap'|'meta'|'more'|'stat', num?:number, text:string}。
 * 消费方：ToolLines.renderDiffRows(ink)、repl/toolOutputRender(chalk，经
 * diffRenderer.renderDiffRowsChalk)、审批框(PermissionsPrompt → ToolLines)。
 * 视觉规格（颜色/折叠账本）不在本文件——见 cli/diffSpec.js。
 *
 * 计算引擎仍是 diffRenderer.computeStructuredDiffHunks（本文件只做 rows 组装）。
 */

const { FOLD } = require('./diffSpec');

const DIFF_CONTEXT = 3;

// 相似度交错配对开关(KHY_DIFF_WORD_PAIRS,默认开):同一 hunk 内一段连续
// del/add,若数量相等且每一对都能做词级 diff(changeRatio ≤ 阈值,DSH/web 侧
// side-by-side 同款"按段 1:1 配对"口径),则按原位交错 del,add,del,add… 输出,
// 渲染端(planWordDiffPairs)对每对亮出"改了哪个词";任一对整行级(重写)或
// 数量不等 → 保留「先红后绿」整块,保住批量删加的块边界。同时要求
// diffSpec.wordHighlightEnabled(高亮关时交错无词级标注,只会更难读)。
function wordPairsEnabled(env = process.env) {
  const flag = String((env && env.KHY_DIFF_WORD_PAIRS) || '')
    .trim()
    .toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') {
    return false;
  }
  return FOLD ? require('./diffSpec').wordHighlightEnabled(env) : false;
}

/**
 * 判定一段连续 del/add 是否可整体 1:1 词级配对(数量相等且每对都 wordLevel)。
 * 纯函数;wordDiff 加载失败 → false(回退整块)。
 */
function _pairableWordLevel(dels, adds) {
  if (!dels.length || dels.length !== adds.length) {
    return false;
  }
  let wd;
  try {
    wd = require('./wordDiff');
  } catch {
    return false;
  }
  if (!wd || typeof wd.computeWordDiffSegments !== 'function') {
    return false;
  }
  for (let k = 0; k < dels.length; k++) {
    const segs = wd.computeWordDiffSegments(dels[k].text, adds[k].text);
    if (!segs || !segs.wordLevel) {
      return false;
    }
  }
  return true;
}

function splitDiffLines(text) {
  const arr = String(text ?? '').split('\n');
  if (arr.length && arr[arr.length - 1] === '') {
    arr.pop();
  }
  return arr;
}

/**
 * Build structured ±diff rows from a tool result's _khyWriteDiff context.
 * Pure (no ink) so it is unit-testable. Mirrors the classic REPL behaviour:
 *   - new file (no before)     → green + preview
 *   - deleted file (no after)  → red − preview
 *   - existing file            → structured line diff with 3 context lines
 * `expanded` removes the row caps so Ctrl+O genuinely shows the complete diff;
 * when collapsed a "ctrl+o to expand" hint is appended on overflow.
 * Returns null when there is no renderable change.
 * @returns {Array<{kind:'add'|'del'|'ctx'|'gap'|'more'|'stat', num?:number, text:string}>|null}
 */
function buildWriteDiffRows(diffCtx, expanded = false) {
  if (!diffCtx) {
    return null;
  }
  const before = typeof diffCtx.beforeContent === 'string' ? diffCtx.beforeContent : '';
  const after = typeof diffCtx.afterContent === 'string' ? diffCtx.afterContent : '';
  if (before === after) {
    return null;
  }

  const previewMax = expanded ? FOLD.expanded : FOLD.previewCollapsed;
  const maxRows = expanded ? FOLD.expanded : FOLD.diffCollapsed;
  // Collapsed overflow promises Ctrl+O; expanded takes every source row.
  // Marker text + plural guard live in the previewOverflowMarker SSOT (shared
  // with the classic REPL's toolOutputRender so "+1 line" never reads "+1 lines").
  const _overflow = require('./previewOverflowMarker');
  const moreText = (n, sign) => _overflow.buildLinesOverflow(n, sign, expanded, process.env);

  const rows = [];

  if (!before && after) {
    const lines = splitDiffLines(after);
    const { keep, hidden } = expanded
      ? { keep: lines.length, hidden: 0 }
      : _overflow.resolveFold(lines.length, previewMax, process.env);
    lines.slice(0, keep).forEach((ln, i) => rows.push({ kind: 'add', num: i + 1, text: ln }));
    if (hidden > 0) {
      rows.push({ kind: 'more', text: moreText(hidden, '+') });
    }
    return rows;
  }
  if (before && !after) {
    const lines = splitDiffLines(before);
    const { keep, hidden } = expanded
      ? { keep: lines.length, hidden: 0 }
      : _overflow.resolveFold(lines.length, previewMax, process.env);
    lines.slice(0, keep).forEach((ln, i) => rows.push({ kind: 'del', num: i + 1, text: ln }));
    if (hidden > 0) {
      rows.push({ kind: 'more', text: moreText(hidden, '-') });
    }
    return rows;
  }

  let diff;
  try {
    diff = require('./diffRenderer').computeStructuredDiffHunks(before, after, {
      context: DIFF_CONTEXT,
    });
  } catch {
    return null;
  }
  const { added, removed, hunks } = diff;
  if ((added === 0 && removed === 0) || !hunks.length) {
    return null;
  }

  // Flatten hunks into rows, inserting a dim "⋯ N unchanged lines" separator
  // between non-adjacent hunks so multi-spot edits read honestly instead of one
  // miscounted mega-block.
  // 「先红后绿」:同一 hunk 内把所有 del 行(红 -)先列出,再列出所有 add 行(绿 +);
  // ctx 行留在原位(行号上下文)。同一段「连续 del/add 子序列」按「先 del 后 add」重排。
  for (const hunk of hunks) {
    if (hunk.gapBefore > 0) {
      rows.push({
        kind: 'gap',
        text: `⋯ ${hunk.gapBefore} unchanged line${hunk.gapBefore !== 1 ? 's' : ''}`,
      });
    } else if (hunk.gapBefore === 0) {
      rows.push({ kind: 'gap', text: '⋯' });
    }
    // 一次扫描:遇到 ctx 直接 push;遇到一段「连续 del/add」子序列时,先收集完
    // 所有连续 del、再收集所有连续 add,然后决定行序:
    //   相似配对(门控开 + 数量相等 + 每对词级)→ 按原位交错 del,add,… 输出,
    //   渲染端逐对亮出词级变更(改哪几个词一目了然);
    //   否则 → 「先 del 后 add」整块(保住批量删加的块边界)。
    let _i = 0;
    while (_i < hunk.rows.length) {
      const r = hunk.rows[_i];
      if (r.kind === 'ctx') {
        rows.push(r);
        _i++;
      } else {
        const _segDels = [];
        const _segAdds = [];
        while (_i < hunk.rows.length && hunk.rows[_i].kind === 'del') {
          _segDels.push(hunk.rows[_i]);
          _i++;
        }
        while (_i < hunk.rows.length && hunk.rows[_i].kind === 'add') {
          _segAdds.push(hunk.rows[_i]);
          _i++;
        }
        if (wordPairsEnabled(process.env) && _pairableWordLevel(_segDels, _segAdds)) {
          for (let _k = 0; _k < _segDels.length; _k++) {
            rows.push(_segDels[_k]);
            rows.push(_segAdds[_k]);
          }
        } else {
          for (const d of _segDels) rows.push(d);
          for (const a of _segAdds) rows.push(a);
        }
      }
    }
  }

  if (rows.length > maxRows) {
    const dropped = rows.length - maxRows;
    const kept = rows.slice(0, maxRows);
    kept.push({ kind: 'more', text: _overflow.buildRowsOverflow(dropped, expanded, process.env) });
    rows.length = 0;
    rows.push(...kept);
  }

  // 摘要串构造收敛到单一真源 cli/editStatLine.js(含 CC 句首 "Removed" 大写规则)。
  const statLine = require('./editStatLine').buildEditStatLine(added, removed, process.env);
  if (statLine) {
    rows.push({ kind: 'stat', text: `└ ${statLine}` });
  }

  return rows;
}

// Does a shell/command tool's stdout look like a unified diff (e.g. `git diff`,
// `diff -u`)? Mirrors the classic REPL's maybeRenderInlineDiffFromToolOutput
// gate so the TUI can colour the same output the REPL has always coloured.
function looksLikeUnifiedDiff(text) {
  return /(^|\n)(\+\+\+ |--- |@@ |\+[^+]|-[^-])/m.test(String(text ?? ''));
}

/**
 * Parse unified-diff-looking command output into structured ±rows for the same
 * red/green renderer used for write/edit diffs. Pure (no ink), unit-testable.
 * File/hunk headers (+++/---/@@/diff/index) render dim; +lines green, -lines red,
 * context dim. Bounded by FOLD.diffCollapsed. Returns null when nothing renderable.
 *
 * Line numbers (CC-style): when KHY_DIFF_LINE_NUMBERS is on (default), each
 * `@@ -a,b +c,d @@` hunk header seeds old/new cursors; add rows get the new-file line
 * number, del rows the old-file line, ctx rows the new-file line (single gutter, each
 * row its own file's 1-based number) — identical convention to write-diffs'
 * computeStructuredDiffHunks, so both diff paths render the same gutter.
 * Gate off → no `num` assigned → byte-identical.
 * @returns {Array<{kind:'add'|'del'|'ctx'|'meta'|'more',text:string,num?:number}>|null}
 */
function buildShellDiffRows(text, expanded = false) {
  const lines = splitDiffLines(text);
  if (!lines.length) {
    return null;
  }
  const { diffLineNumbersEnabled, parseUnifiedHunkHeader } = require('./diffLineNumbers');
  const numbersOn = diffLineNumbersEnabled();
  // 双列 gutter(KHY_DIFF_DUAL_GUTTER 默认开):ctx 行带 old+new 双号(add 带 numNew),
  // del 只带旧号;门控关 → 单列历史口径(ctx 用新号)逐字节回退。
  const dual = require('./diffGutter').dualGutterEnabled();
  const maxRows = expanded ? FOLD.expanded : FOLD.diffCollapsed;
  const rows = [];
  // null until the first @@ hunk header is seen; bare ±diffs without a header
  // (non-git) stay unnumbered, matching prior behaviour for that shape.
  let oldLine = null;
  let newLine = null;
  for (const ln of lines) {
    if (rows.length >= maxRows) {
      rows.push({
        kind: 'more',
        text: expanded
          ? '... (diff truncated, capped)'
          : '... (diff truncated, ctrl+o for full output)',
      });
      break;
    }
    // Meta lines carry no gutter number and advance no cursor. The `\ No newline
    // at end of file` marker (git emits it when a changed region touches a
    // newline-less last line) is NOT file content: route it here so it renders
    // dim without a line number, instead of falling through to the ctx branch
    // where it would get a bogus number and shift every following row by one.
    // `\ ` (backslash-space) is unambiguous — diff body lines start with space
    // (ctx), `+` (add) or `-` (del), never backslash-space.
    if (/^(\+\+\+|---|@@|diff |index |\\ )/.test(ln)) {
      if (numbersOn && /^@@/.test(ln)) {
        const hh = parseUnifiedHunkHeader(ln);
        if (hh) {
          oldLine = hh.oldStart;
          newLine = hh.newStart;
        }
      }
      rows.push({ kind: 'meta', text: ln });
    } else if (/^\+/.test(ln)) {
      const row = { kind: 'add', text: ln.slice(1) };
      if (numbersOn && newLine != null) {
        row.num = newLine;
        if (dual) {
          row.numNew = newLine;
        }
        newLine++;
      }
      rows.push(row);
    } else if (/^-/.test(ln)) {
      const row = { kind: 'del', text: ln.slice(1) };
      if (numbersOn && oldLine != null) {
        row.num = oldLine;
        oldLine++;
      }
      rows.push(row);
    } else {
      const row = { kind: 'ctx', text: ln.replace(/^ /, '') };
      if (numbersOn && newLine != null && oldLine != null) {
        if (dual) {
          row.num = oldLine;
          row.numNew = newLine;
        } else {
          row.num = newLine;
        }
      } else if (numbersOn && newLine != null) {
        row.num = newLine;
      }
      if (numbersOn && oldLine != null) {
        oldLine++;
      }
      if (numbersOn && newLine != null) {
        newLine++;
      }
      rows.push(row);
    }
  }
  return rows.length ? rows : null;
}

/**
 * Plan which paired remove/add rows get word-level segment highlighting. Mirrors
 * CC's processAdjacentLines: a maximal run of consecutive `del` rows immediately
 * followed by a run of consecutive `add` rows is paired 1:1; each pair is offered
 * to wordDiff and only kept when it returns word-level segments (changeRatio at or
 * below threshold). Unpaired extras, and pairs that fall back to whole-line, get
 * no plan entry → the renderer keeps their original solid-line rendering.
 *
 * Pure (no ink). `wd` is injected (wordDiff module) for testability; `clipFn` is
 * applied first so segments stay within the same width bound as the line renderer
 * (width-aware clip 真源在 ToolLines.clip，由调用方注入；缺省退长度裁切)。
 * `clipW` is the per-cell content width (default 100 = legacy fixed cut, kept so
 * direct callers/tests stay byte-identical; renderers pass the live
 * terminal-derived budget, or Infinity when expanded so segments aren't truncated).
 * @returns {Map<number, {side:'del'|'add', segs: Array<{text:string,changed:boolean}>}>}
 */
function planWordDiffPairs(rows, wd, clipW = 100, clipFn) {
  const plan = new Map();
  if (!wd || typeof wd.computeWordDiffSegments !== 'function' || !Array.isArray(rows)) {
    return plan;
  }
  const clip =
    typeof clipFn === 'function'
      ? clipFn
      : (s, n) => {
          const t = String(s ?? '');
          if (!Number.isFinite(n)) return t;
          return t.length > n ? t.slice(0, n - 1) + '…' : t;
        };
  let i = 0;
  while (i < rows.length) {
    if (!rows[i] || rows[i].kind !== 'del') {
      i++;
      continue;
    }
    const dels = [];
    while (i < rows.length && rows[i] && rows[i].kind === 'del') {
      dels.push(i);
      i++;
    }
    const adds = [];
    while (i < rows.length && rows[i] && rows[i].kind === 'add') {
      adds.push(i);
      i++;
    }
    if (!adds.length) {
      continue;
    } // dels with no following adds → no pairing
    const pairCount = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairCount; k++) {
      const di = dels[k];
      const ai = adds[k];
      const segs = wd.computeWordDiffSegments(
        clip(rows[di].text, clipW),
        clip(rows[ai].text, clipW)
      );
      if (segs && segs.wordLevel) {
        plan.set(di, { side: 'del', segs: segs.old });
        plan.set(ai, { side: 'add', segs: segs.new });
      }
    }
  }
  return plan;
}

module.exports = {
  DIFF_CONTEXT,
  splitDiffLines,
  buildWriteDiffRows,
  looksLikeUnifiedDiff,
  buildShellDiffRows,
  planWordDiffPairs,
  wordPairsEnabled,
};
