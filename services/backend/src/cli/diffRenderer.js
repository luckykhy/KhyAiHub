/**
 * Diff Renderer — extracted from aiRenderer.js.
 *
 * Renders unified diffs and structured diffs with Claude Code's exact
 * background colors and optional word-level highlighting.
 */
// 整宽色条收敛到单一真源 cli/diffFullWidth.js(对齐 CC formatDiff:add/remove 行
// 背景补尾随空格铺到终端右缘;门控 KHY_DIFF_FULL_WIDTH 默认开,关→不补=字节回退)。
// displayWidth 是 CJK 感知的显示宽度 SSOT(cli/formatters.js),用于精确测量已用宽度。
const { diffFullWidthEnabled, diffRowPadCount } = require('./diffFullWidth');
const { displayWidth } = require('./formatters');
const { c, THEME } = require('./renderTheme');

const DIFF_CONTEXT_LINES = 3;

// 终端整宽(经典 ANSI 路径直出,无 ink trim,尾随背景空格能存活)。非 TTY → 80。
function _terminalWidth() {
  const cols = process.stdout && process.stdout.columns;
  return Number.isFinite(cols) && cols > 0 ? cols : 80;
}

// 给一行「纯文本(无 ANSI)的已用宽度」补足到整宽的尾随空格串;门控关 → 空串。
// call-site 把返回串接在该行 backgroundColor 跨度内,使色条铺到右缘。
function _padToFull(usedWidth, env) {
  if (!diffFullWidthEnabled(env || process.env)) {
    return '';
  }
  return ' '.repeat(diffRowPadCount(usedWidth, _terminalWidth()));
}

// 经典 ANSI 文件编辑 diff(renderStructuredDiff)是否走「真分 hunk」渲染。
// 门控开(默认)= 复用既有 computeStructuredDiffHunks SSOT(LCS 真编辑脚本 + 按
// 上下文切 hunk + realAdded/realRemoved),与默认 TUI(ToolLines.js)收敛;门控关 =
// 逐字节回退历史单区块渲染(把首末改动间的未改行全当 churn 重绘并虚报 ±计数)。
const _CLASSIC_DIFF_HUNKS_FALSY = new Set(['0', 'false', 'off', 'no']);
function classicDiffHunksEnabled(env = process.env) {
  const flag = String((env && env.KHY_CLASSIC_DIFF_HUNKS) || '')
    .trim()
    .toLowerCase();
  return !_CLASSIC_DIFF_HUNKS_FALSY.has(flag);
}

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
  const dual = require('./diffGutter').dualGutterEnabled((opts && opts.env) || process.env);
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

/**
 * Render a unified diff with Claude Code's exact background colors.
 * Added lines: rgb(34,92,43) background
 * Removed lines: rgb(122,41,54) background
 * @@ headers: dim
 * Context lines: dim
 */
function renderDiff(diffText) {
  const lines = diffText.split('\n');
  const rendered = [];
  let _wordDiff;
  try {
    _wordDiff = require('./wordDiff');
  } catch {
    /* fallback to line-level */
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line.startsWith('+++') || line.startsWith('---')) {
      rendered.push(c().bold.dim(line));
    } else if (line.startsWith('-')) {
      // Try word-level diff: pair adjacent -/+ lines
      if (_wordDiff && idx + 1 < lines.length && lines[idx + 1].startsWith('+')) {
        const oldContent = line.slice(1); // strip leading -
        const newContent = lines[idx + 1].slice(1); // strip leading +
        const result = _wordDiff.renderWordDiffLine(oldContent, newContent, THEME);
        if (result) {
          // 整宽色条:词级高亮内容含 ANSI,用 displayWidth(剥 ANSI)测可见宽度,
          // 末尾补背景空格铺到右缘(对齐 CC formatDiff)。门控关 → _padToFull 返空串。
          const _padR = _padToFull(displayWidth('-') + displayWidth(result.oldRendered));
          const _padA = _padToFull(displayWidth('+') + displayWidth(result.newRendered));
          rendered.push(
            c().bgHex(THEME.diffRemoved).hex('#FFFFFF')('-') +
              result.oldRendered +
              (_padR ? c().bgHex(THEME.diffRemoved).hex('#FFFFFF')(_padR) : '')
          );
          rendered.push(
            c().bgHex(THEME.diffAdded).hex('#FFFFFF')('+') +
              result.newRendered +
              (_padA ? c().bgHex(THEME.diffAdded).hex('#FFFFFF')(_padA) : '')
          );
          idx++; // skip the + line we already consumed
          continue;
        }
      }
      rendered.push(
        c().bgHex(THEME.diffRemoved).hex('#FFFFFF')(line + _padToFull(displayWidth(line)))
      );
    } else if (line.startsWith('+')) {
      rendered.push(
        c().bgHex(THEME.diffAdded).hex('#FFFFFF')(line + _padToFull(displayWidth(line)))
      );
    } else if (line.startsWith('@@')) {
      rendered.push(c().dim(line));
    } else {
      rendered.push(c().dim(line));
    }
  }

  return rendered.join('\n');
}

/**
 * Render a structured diff for file edits (Claude Code style).
 * Shows line numbers + add/remove markers with exact background colors.
 *
 * @param {string} oldContent - original file content
 * @param {string} newContent - modified file content
 * @param {string} [filePath] - file path for header
 * @returns {string} rendered diff
 */
function renderStructuredDiff(oldContent, newContent, filePath = '') {
  // 门控开(默认):走真分 hunk 渲染(消费既有 computeStructuredDiffHunks SSOT),
  // 多处编辑各自成块、块间插 dim「⋯ N unchanged lines」分隔、±计数取真值;
  // 门控关:逐字节回退历史单区块 churn 渲染。
  if (classicDiffHunksEnabled(process.env)) {
    const hunked = _renderStructuredDiffHunked(oldContent, newContent, filePath);
    if (hunked != null) {
      return hunked;
    }
    // hunk 计算判定无改动(理论不可达,maybeRenderWriteDiff 仅在有 diff 时调用)→
    // 回退 legacy 以保留任何遗留可见行为,绝不静默吞掉。
  }
  return _renderStructuredDiffLegacy(oldContent, newContent, filePath);
}

// 经典 ANSI 路径的单个「改动块」渲染:把一段连续的删除行 dels[] 与紧随的新增行 adds[]
// 按「先红后绿」渲染 —— 列出所有红色 - 行,再列出所有绿色 + 行;不做 1:1 词级配对/高亮
// (用户在多行同 hunk 改动时更易看出「哪些被删、哪些被加」的批量边界,而逐对高亮
// 让 -/+ 行交错出现,反而不易读)。与历史 renderStructuredDiff 的逐行渲染格式
// **逐字节同构**(同前缀格式 / 同 bgHex 着色 / 同整宽补白),只是把同一 hunk 内的
// del/add 行顺序从「按配对交错」改为「先 del 后 add」。
//
// 双列 gutter(KHY_DIFF_DUAL_GUTTER 默认开,DSH old|new 口径):del 行左=旧号右=空、
// add 行左=空右=新号;门控关 → 单列 `  ${num} ${sign} ${text}` 逐字节回退。
function _emitChangeBlock(rendered, dels, adds, pad, _wd) {
  const gutter = require('./diffGutter');
  const dual = gutter.dualGutterEnabled(process.env);
  // 1. 红色 - 行(原文件内容)全部先列
  for (let p = 0; p < dels.length; p++) {
    const rm = dels[p];
    const _body = dual
      ? `  ${gutter.formatDualGutterNums(rm, pad).join(' ')} - ${rm.text}`
      : `  ${String(rm.num).padStart(pad)} - ${rm.text}`;
    rendered.push(
      c().bgHex(THEME.diffRemoved).hex('#FFFFFF')(_body + _padToFull(displayWidth(_body)))
    );
  }
  // 2. 绿色 + 行(新文件内容)全部后列
  for (let p = 0; p < adds.length; p++) {
    const ad = adds[p];
    const _body = dual
      ? `  ${gutter.formatDualGutterNums(ad, pad).join(' ')} + ${ad.text}`
      : `  ${String(ad.num).padStart(pad)} + ${ad.text}`;
    rendered.push(
      c().bgHex(THEME.diffAdded).hex('#FFFFFF')(_body + _padToFull(displayWidth(_body)))
    );
  }
  // _wd(词级高亮)参数保留以维持 caller 接线,但「先红后绿」语义下不再做词级配对。
}

/**
 * 真分 hunk 的结构化 diff 渲染(门控开路径)。消费既有 computeStructuredDiffHunks SSOT
 * —— 同一引擎已被默认 TUI(ToolLines.js)采用 —— 故经典 ANSI 路径与 TUI 收敛:
 *  - 每个 hunk 的 ctx/del/add 行各自渲染(ctx dim、del/add 整行 bgHex,无词级配对);
 *  - 同一 hunk 内**先红后绿**:所有 del 行(红 -)先列、再列所有 add 行(绿 +);
 *  - 相邻 hunk 间按 gapBefore 插 dim「⋯ N unchanged lines」分隔(对齐 TUI 的 ⋯ 行),
 *    绝不再把首末改动间的未改行重绘成 churn;
 *  - 末尾 └ 摘要走 editStatLine SSOT,喂 hunk 的**真**±计数(realAdded/realRemoved)。
 * 无改动(空 hunks)→ 返回 ''(maybeRenderWriteDiff 仅在有 diff 时调用,实务不可达)。
 * @returns {string} 渲染结果
 */
function _renderStructuredDiffHunked(oldContent, newContent, filePath = '') {
  const { added, removed, hunks } = computeStructuredDiffHunks(oldContent, newContent, {
    context: DIFF_CONTEXT_LINES,
  });
  if ((added === 0 && removed === 0) || !hunks.length) {
    return '';
  }

  // gutter 数字位宽:取所有 hunk 行号的最大位数(单一真源 diffGutter,门控关 → 恒 4 位)。
  const allRows = [];
  for (const h of hunks) {
    for (const r of h.rows) {
      allRows.push(r);
    }
  }
  const _pad = require('./diffGutter').computeDiffGutterWidth(allRows, process.env);

  const rendered = [];
  // 文件路径头(KHY_DIFF_PATH_HEADER 默认开,DSH「diff 卡不重复路径」的反面:
  // 经典 ANSI 路径没有卡片标题,不在 diff 体里报路径的话用户看不到改的是哪个文件)。
  // 门控关 / filePath 空 → 不加,逐字节回退。
  if (
    filePath &&
    require('./diffGutter').diffPathHeaderEnabled(process.env)
  ) {
    rendered.push(`  ${c().dim(filePath)}`);
  }
  const gutter = require('./diffGutter');
  const dual = gutter.dualGutterEnabled(process.env);
  for (const hunk of hunks) {
    if (hunk.gapBefore > 0) {
      const word = `${hunk.gapBefore} unchanged line${hunk.gapBefore !== 1 ? 's' : ''}`;
      rendered.push(`  ${c().dim(`⋯ ${word}`)}`);
    } else if (hunk.gapBefore === 0) {
      rendered.push(`  ${c().dim('⋯')}`);
    }
    const rows = hunk.rows;
    let p = 0;
    while (p < rows.length) {
      const r = rows[p];
      if (r.kind === 'ctx') {
        if (dual) {
          const [left, right] = gutter.formatDualGutterNums(r, _pad);
          rendered.push(`  ${c().dim(left)} ${c().dim(right)}   ${c().dim(r.text)}`);
        } else {
          const num = String(r.num).padStart(_pad);
          rendered.push(`  ${c().dim(num)}   ${c().dim(r.text)}`);
        }
        p++;
        continue;
      }
      // 收集一段连续的 del 行 + 紧随的 add 行,交给 _emitChangeBlock 做「先红后绿」渲染。
      const dels = [];
      while (p < rows.length && rows[p].kind === 'del') {
        dels.push(rows[p]);
        p++;
      }
      const adds = [];
      while (p < rows.length && rows[p].kind === 'add') {
        adds.push(rows[p]);
        p++;
      }
      _emitChangeBlock(rendered, dels, adds, _pad);
    }
  }

  // Stats — 摘要串构造收敛到单一真源 cli/editStatLine.js(真 ±计数,绝不虚报)。
  const statLine = require('./editStatLine').buildEditStatLine(added, removed, process.env);
  if (statLine) {
    rendered.push(`    ${c().dim('└')} ${c().dim(statLine)}`);
  }

  return rendered.join('\n');
}

function _renderStructuredDiffLegacy(oldContent, newContent, filePath = '') {
  const { oldLines, newLines, removeStart, removeEnd, addStart, addEnd, added, removed } =
    computeStructuredDiffStats(oldContent, newContent);

  const rendered = [];

  // 文件路径头(与 hunked 路径同一门控 KHY_DIFF_PATH_HEADER;关 → 逐字节回退)。
  if (
    filePath &&
    require('./diffGutter').diffPathHeaderEnabled(process.env)
  ) {
    rendered.push(`  ${c().dim(filePath)}`);
  }

  // Context before
  const ctxStart = Math.max(0, removeStart - DIFF_CONTEXT_LINES);
  const ctxEnd = Math.min(oldLines.length, removeEnd + DIFF_CONTEXT_LINES);
  // gutter 数字位宽收敛到单一真源 cli/diffGutter.js(对齐 CC 动态位宽,门控关→恒 4 位字节回退)。
  const _gutter = require('./diffGutter');
  const _pad = _gutter.computeDiffGutterWidthForMax(
    Math.max(removeEnd, addEnd, ctxEnd),
    process.env
  );
  const _dual = _gutter.dualGutterEnabled(process.env);
  for (let k = ctxStart; k < removeStart; k++) {
    if (_dual) {
      // 前缀 ctx 行旧新同号(改动前,映射恒等)。
      const [left, right] = _gutter.formatDualGutterNums(
        { kind: 'ctx', num: k + 1, numNew: k + 1 },
        _pad
      );
      rendered.push(`  ${c().dim(left)} ${c().dim(right)}   ${c().dim(oldLines[k])}`);
    } else {
      const num = String(k + 1).padStart(_pad);
      rendered.push(`  ${c().dim(num)}   ${c().dim(oldLines[k])}`);
    }
  }

  // 「先红后绿」渲染:列出全部红色 - 行(原内容),再列出全部绿色 + 行(新内容);
  // 不做词级配对/高亮(对齐 hunked 路径的 _emitChangeBlock 新语义)。
  const removedLines = [];
  for (let k = removeStart; k < removeEnd; k++) {
    removedLines.push({ kind: 'del', num: k + 1, text: oldLines[k] });
  }
  const addedLines = [];
  for (let k = addStart; k < addEnd; k++) {
    addedLines.push({ kind: 'add', num: k + 1, numNew: k + 1, text: newLines[k] });
  }

  // 1. 红色 - 行(原文件)全部先列
  for (let p = 0; p < removedLines.length; p++) {
    const rm = removedLines[p];
    const _body = _dual
      ? `  ${_gutter.formatDualGutterNums(rm, _pad).join(' ')} - ${rm.text}`
      : `  ${String(rm.num).padStart(_pad)} - ${rm.text}`;
    rendered.push(
      c().bgHex(THEME.diffRemoved).hex('#FFFFFF')(_body + _padToFull(displayWidth(_body)))
    );
  }

  // 2. 绿色 + 行(新文件)全部后列
  for (let p = 0; p < addedLines.length; p++) {
    const ad = addedLines[p];
    const _body = _dual
      ? `  ${_gutter.formatDualGutterNums(ad, _pad).join(' ')} + ${ad.text}`
      : `  ${String(ad.num).padStart(_pad)} + ${ad.text}`;
    rendered.push(
      c().bgHex(THEME.diffAdded).hex('#FFFFFF')(_body + _padToFull(displayWidth(_body)))
    );
  }

  // Context after (ctxEnd computed once above for gutter-width sizing)
  for (let k = removeEnd; k < ctxEnd; k++) {
    if (k < oldLines.length) {
      if (_dual) {
        // 后缀 ctx 行:旧号 k+1,新号 = addEnd 起顺推(与 hunks 路径同一映射)。
        const [left, right] = _gutter.formatDualGutterNums(
          { kind: 'ctx', num: k + 1, numNew: addEnd + (k - removeEnd) + 1 },
          _pad
        );
        rendered.push(`  ${c().dim(left)} ${c().dim(right)}   ${c().dim(oldLines[k])}`);
      } else {
        const num = String(k + 1).padStart(_pad);
        rendered.push(`  ${c().dim(num)}   ${c().dim(oldLines[k])}`);
      }
    }
  }

  // Stats — 摘要串构造收敛到单一真源 cli/editStatLine.js(含 CC 句首 "Removed" 大写规则)。
  const statLine = require('./editStatLine').buildEditStatLine(added, removed, process.env);
  if (statLine) {
    rendered.push(`    ${c().dim('└')} ${c().dim(statLine)}`);
  }

  return rendered.join('\n');
}

/**
 * Detect and render inline diffs within AI response text.
 * Looks for fenced diff blocks: ```diff ... ```
 */
function renderResponseWithDiffs(text) {
  const parts = text.split(/(```diff\n[\s\S]*?```)/g);
  const rendered = [];

  for (const part of parts) {
    if (part.startsWith('```diff\n') && part.endsWith('```')) {
      const diffContent = part.slice(8, -3);
      rendered.push(renderDiff(diffContent));
    } else {
      rendered.push(part);
    }
  }

  return rendered.join('\n');
}

/**
 * renderDiffRowsChalk — rows 契约的 chalk 渲染器（[DESIGN-ARCH-157] B 刀）。
 *
 * 消费 cli/writeDiffRows.js 产出的行模型（与 TUI renderDiffRows 同一 rows），
 * 输出逐行 ANSI 字符串（\n join），行文法与经典 hunk 路径一致：
 *   add/del  `  ${num} ${sign} ${text}` + 满宽背景色条
 *   ctx      `  ${dim num}   ${dim text}`
 *   gap/more/meta  `  ${dim text}`
 *   stat     `    ${dim text}`
 * 色板真源 cli/diffSpec.js；gutter 真源 cli/diffGutter.js（按全 rows 最大行号）。
 *
 * 双列 gutter（KHY_DIFF_DUAL_GUTTER 默认开，DSH old|new 口径）：del 左=旧号右=空、
 * add 左=空右=新号、ctx 两列；词级高亮（KHY_DIFF_WORD_HIGHLIGHT 默认开）对
 * planWordDiffPairs 配上的行按 diff*Word 亮色底绘制变更子段。
 * 两门控关 → 与单列/整行着色的历史输出逐字节一致。
 * @param {Array<{kind:string,num?:number,numNew?:number,text:string}>} rows
 * @returns {string} 渲染后的多行字符串（无 rows → ''）
 */
function renderDiffRowsChalk(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return '';
  }
  const dc = require('./diffSpec').diffColors(process.env);
  const gutter = require('./diffGutter');
  const gw = gutter.computeDiffGutterWidth(rows, process.env);
  const dual = gutter.dualGutterEnabled(process.env);
  // 词级子段计划（纯行模型，无列宽裁切 → Infinity 全文本）。门控关 → 无计划,
  // 整行按行底色渲染（逐字节回退）。
  let plan = null;
  if (require('./diffSpec').wordHighlightEnabled(process.env)) {
    try {
      const wd = require('./wordDiff');
      plan = require('./writeDiffRows').planWordDiffPairs(rows, wd, Infinity);
    } catch {
      plan = null;
    }
  }
  const out = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    if (r.kind === 'add' || r.kind === 'del') {
      const sign = r.kind === 'add' ? '+' : '-';
      const bg = r.kind === 'add' ? dc.add : dc.del;
      const wordBg = r.kind === 'add' ? dc.addWord : dc.delWord;
      const seg = plan && plan.get(ri);
      if (seg) {
        // 词级行:前缀(gutter+sign)与未变更子段铺行底色,变更子段铺亮色词底,
        // 末尾整宽补足行底色条(与整行路径同一 _padToFull 口径)。
        const leftCol = dual ? gutter.formatDualGutterNums(r, gw) : [gutter.formatDiffGutterNum(r.num, gw)];
        const prefixPlain = `  ${leftCol.join(' ')} ${sign} `;
        const segsPlain = seg.segs.map((s) => s.text).join('');
        let body = c().bgHex(bg).hex(dc.text)(prefixPlain);
        for (const s of seg.segs) {
          body += c().bgHex(s.changed ? wordBg : bg).hex(dc.text)(s.text);
        }
        const used = displayWidth(prefixPlain) + displayWidth(segsPlain);
        const _pad = _padToFull(used);
        if (_pad) {
          body += c().bgHex(bg).hex(dc.text)(_pad);
        }
        out.push(body);
      } else {
        const num = gutter.formatDiffGutterNum(r.num, gw);
        const body = dual
          ? `  ${gutter.formatDualGutterNums(r, gw).join(' ')} ${sign} ${r.text}`
          : `  ${num} ${sign} ${r.text}`;
        out.push(c().bgHex(bg).hex(dc.text)(body + _padToFull(displayWidth(body))));
      }
    } else if (r.kind === 'ctx') {
      if (dual) {
        const [left, right] = gutter.formatDualGutterNums(r, gw);
        out.push(`  ${c().dim(left)} ${c().dim(right)}   ${c().dim(r.text)}`);
      } else {
        const num = gutter.formatDiffGutterNum(r.num, gw);
        out.push(`  ${c().dim(num)}   ${c().dim(r.text)}`);
      }
    } else if (r.kind === 'stat') {
      out.push(`    ${c().dim(r.text)}`);
    } else {
      // gap / more / meta：dim 单行
      out.push(`  ${c().dim(r.text)}`);
    }
  }
  return out.join('\n');
}

module.exports = {
  computeStructuredDiffStats,
  computeStructuredDiffHunks,
  renderDiff,
  renderStructuredDiff,
  renderDiffRowsChalk,
  renderResponseWithDiffs,
};
