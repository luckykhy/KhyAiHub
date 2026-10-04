'use strict';

// Structured-diff hunk engine — pure line-diff model (no ANSI, no ink, no IO).
//
// Relocated verbatim out of `cli/diffRenderer.js` (P2 batch 11,
// [DESIGN-LAY-008] §12.2l). It was authored inside the CLI renderer, which made the
// only service-layer consumer (`services/domain/trajectory/auditTrajectory/diffCapture`)
// reach up into `cli/` for it: first through the `services/cliLeafPort` IoC seam, and
// when that seam was unregistered it bootstrapped `cli/ai` (781 lines, 37 requires) as a
// side effect just to populate the port. That inversion is the reason for this file.
//
// Function bodies below are byte-identical to the originals; the only textual change is
// the dual-gutter flag, which now comes from `./envGates` (also relocated from
// `cli/diffGutter.js`) instead of `require(./diffGutter)`. `cli/diffRenderer.js` requires
// and re-exports these names, so the 20 CLI/TUI call sites keep their import path.

const { dualGutterEnabled } = require('./envGates');

const DIFF_CONTEXT_LINES = 3;

function splitDiffLines(text) {
  const source = String(text ?? '');
  if (!source) {
    return [];
  }
  const lines = source.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function computeStructuredDiffStats(oldContent, newContent) {
  const oldLines = splitDiffLines(oldContent);
  const newLines = splitDiffLines(newContent);

  const commonPrefixLen = (() => {
    let k = 0;
    while (k < oldLines.length && k < newLines.length && oldLines[k] === newLines[k]) {
      k++;
    }
    return k;
  })();

  const commonSuffixLen = (() => {
    let k = 0;
    while (
      k < oldLines.length - commonPrefixLen &&
      k < newLines.length - commonPrefixLen &&
      oldLines[oldLines.length - 1 - k] === newLines[newLines.length - 1 - k]
    ) {
      k++;
    }
    return k;
  })();

  const removeStart = commonPrefixLen;
  const removeEnd = oldLines.length - commonSuffixLen;
  const addStart = commonPrefixLen;
  const addEnd = newLines.length - commonSuffixLen;

  return {
    oldLines,
    newLines,
    commonPrefixLen,
    commonSuffixLen,
    removeStart,
    removeEnd,
    addStart,
    addEnd,
    added: Math.max(0, addEnd - addStart),
    removed: Math.max(0, removeEnd - removeStart),
  };
}

/**
 * Compute a MULTI-HUNK structured line diff. Unlike computeStructuredDiffStats
 * (which collapses everything between the common prefix/suffix into ONE block —
 * so a file edited at line 5 and line 500 renders the whole 5..500 span as a
 * single, miscounted change), this runs a real line-level LCS over the changed
 * middle and groups the edits into separate hunks, each carrying up to `context`
 * unchanged lines on either side. Unchanged islands longer than 2*context split
 * the diff into multiple hunks (standard unified-diff coalescing).
 *
 * Pure (no ink/ANSI); returns a model the caller turns into rows. The common
 * prefix/suffix are trimmed cheaply first, so the O(m*n) LCS only runs on the
 * residual changed region. Files whose changed region exceeds `maxScan` lines on
 * either side fall back to a single coalesced hunk (preserving the old behaviour
 * and avoiding an O(n²) blow-up on huge rewrites).
 *
 * @param {string} oldContent
 * @param {string} newContent
 * @param {{ context?: number, maxScan?: number }} [opts]
 * @returns {{
 *   oldLines: string[], newLines: string[], added: number, removed: number,
 *   scanned: boolean,
 *   hunks: Array<{ rows: Array<{kind:'ctx'|'del'|'add', num:number, text:string}>, gapBefore: number }>
 * }}
 */
function computeStructuredDiffHunks(oldContent, newContent, opts = {}) {
  const context =
    Number.isInteger(opts.context) && opts.context >= 0 ? opts.context : DIFF_CONTEXT_LINES;
  const maxScan = Number.isInteger(opts.maxScan) && opts.maxScan > 0 ? opts.maxScan : 4000;

  const { oldLines, newLines, removeStart, removeEnd, addStart, addEnd, added, removed } =
    computeStructuredDiffStats(oldContent, newContent);

  const empty = { oldLines, newLines, added: 0, removed: 0, scanned: true, hunks: [] };
  if (added === 0 && removed === 0) {
    return empty;
  }

  const oldMid = oldLines.slice(removeStart, removeEnd);
  const newMid = newLines.slice(addStart, addEnd);

  // ── Build the ordered edit script over the changed middle ──
  let ops; // [{ kind:'eq'|'del'|'add', oi?, ni? }] with mid-relative indices
  let scanned = true;
  if (oldMid.length > maxScan || newMid.length > maxScan) {
    // Size guard: skip LCS, emit dels then adds as one block (old behaviour).
    scanned = false;
    ops = [];
    for (let k = 0; k < oldMid.length; k++) {
      ops.push({ kind: 'del', oi: k });
    }
    for (let k = 0; k < newMid.length; k++) {
      ops.push({ kind: 'add', ni: k });
    }
  } else {
    ops = _lineDiffOps(oldMid, newMid);
  }

  // Real change counts come from the edit script, NOT computeStructuredDiffStats,
  // whose prefix/suffix collapse over-counts every line between the first and
  // last change as both removed and added (the very bug multi-hunk fixes).
  let realAdded = 0,
    realRemoved = 0;
  for (const op of ops) {
    if (op.kind === 'add') {
      realAdded++;
    } else if (op.kind === 'del') {
      realRemoved++;
    }
  }

  // ── Augment with up to `context` unchanged lines from the common prefix/suffix
  // so hunk boundaries are handled uniformly as eq rows. Prefix/suffix lines are
  // identical in both files, so the old index k maps to a known new index. ──
  // Dual gutter (KHY_DIFF_DUAL_GUTTER, default on): ctx/add rows additionally
  // carry `numNew` (the NEW-file 1-based line number) so renderers can draw the
  // DSH-style two-column old|new gutter — del keeps only its old number, add
  // only its new one, ctx both. Prefix ctx rows map old→new identity; eq rows
  // carry op.ni; suffix ctx row k maps to new index addEnd + (k - removeEnd).
  const dual = dualGutterEnabled((opts && opts.env) || process.env);
  const flat = [];
  const preFrom = Math.max(0, removeStart - context);
  for (let k = preFrom; k < removeStart; k++) {
    const row = { kind: 'ctx', num: k + 1, text: oldLines[k] };
    if (dual) {
      row.numNew = k + 1;
    }
    flat.push(row);
  }
  for (const op of ops) {
    if (op.kind === 'eq') {
      const row = {
        kind: 'ctx',
        num: removeStart + op.oi + 1,
        text: oldLines[removeStart + op.oi],
      };
      if (dual) {
        row.numNew = addStart + op.ni + 1;
      }
      flat.push(row);
    } else if (op.kind === 'del') {
      flat.push({ kind: 'del', num: removeStart + op.oi + 1, text: oldLines[removeStart + op.oi] });
    } else {
      const row = { kind: 'add', num: addStart + op.ni + 1, text: newLines[addStart + op.ni] };
      if (dual) {
        row.numNew = row.num;
      }
      flat.push(row);
    }
  }
  const sufTo = Math.min(oldLines.length, removeEnd + context);
  for (let k = removeEnd; k < sufTo; k++) {
    const row = { kind: 'ctx', num: k + 1, text: oldLines[k] };
    if (dual) {
      row.numNew = addEnd + (k - removeEnd) + 1;
    }
    flat.push(row);
  }

  // ── Split into hunks at interior unchanged runs longer than 2*context. A
  // leading run keeps only its last `context`; a trailing run only its first
  // `context`; a long interior run is cut, leaving `context` on each side and a
  // gap between two hunks. Short interior runs (≤ 2*context) are kept whole. ──
  const hunks = [];
  let cur = [];
  let pendingGapTo = -1; // old line number the next hunk resumes at (for gapBefore)
  let i = 0;
  while (i < flat.length) {
    if (flat[i].kind !== 'ctx') {
      cur.push(flat[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < flat.length && flat[j].kind === 'ctx') {
      j++;
    }
    const runLen = j - i;
    const leading = cur.length === 0;
    const trailing = j === flat.length;
    if (leading) {
      cur.push(...flat.slice(Math.max(i, j - context), j));
    } else if (trailing) {
      cur.push(...flat.slice(i, Math.min(j, i + context)));
    } else if (runLen > 2 * context) {
      cur.push(...flat.slice(i, i + context));
      const lastNum = cur[cur.length - 1].num;
      hunks.push({ rows: cur, gapBefore: pendingGapTo });
      const head = flat.slice(j - context, j);
      pendingGapTo = head.length ? head[0].num - lastNum - 1 : 0;
      cur = [...head];
    } else {
      cur.push(...flat.slice(i, j));
    }
    i = j;
  }
  if (cur.length) {
    hunks.push({ rows: cur, gapBefore: pendingGapTo });
  }
  // The first hunk never has a preceding gap.
  if (hunks.length) {
    hunks[0].gapBefore = -1;
  }

  return { oldLines, newLines, added: realAdded, removed: realRemoved, scanned, hunks };
}

/**
 * Line-level LCS producing an ordered edit script. Mirrors wordDiff's token LCS
 * but over whole lines and emitting eq/del/add ops in document order. Ties in
 * the backtrack prefer the ADD move (`>` not `>=`) so a changed block renders as
 * removals-then-additions — the unified-diff convention the row renderer and the
 * existing single-hunk tests expect.
 * @returns {Array<{kind:'eq'|'del'|'add', oi?:number, ni?:number}>}
 */
function _lineDiffOps(oldMid, newMid) {
  const m = oldMid.length;
  const n = newMid.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        oldMid[i - 1] === newMid[j - 1]
          ? dp[i - 1][j - 1] + 1
          : dp[i - 1][j] >= dp[i][j - 1]
            ? dp[i - 1][j]
            : dp[i][j - 1];
    }
  }
  const ops = [];
  let i = m,
    j = n;
  while (i > 0 && j > 0) {
    if (oldMid[i - 1] === newMid[j - 1]) {
      ops.push({ kind: 'eq', oi: i - 1, ni: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      ops.push({ kind: 'del', oi: i - 1 });
      i--;
    } else {
      ops.push({ kind: 'add', ni: j - 1 });
      j--;
    }
  }
  while (i > 0) {
    ops.push({ kind: 'del', oi: i - 1 });
    i--;
  }
  while (j > 0) {
    ops.push({ kind: 'add', ni: j - 1 });
    j--;
  }
  ops.reverse();
  return ops;
}

module.exports = {
  DIFF_CONTEXT_LINES,
  splitDiffLines,
  computeStructuredDiffStats,
  computeStructuredDiffHunks,
};
