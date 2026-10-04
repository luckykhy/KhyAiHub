/**
 * Tool-output diff + directory-tree render helpers.
 *
 * Extracted verbatim from cli/repl.js as part of the behavior-preserving
 * god-file split. Pure rendering helpers (no module-level mutable state);
 * diff rendering is delegated to the existing ../aiRenderer module.
 */
const fs = require('fs');
const path = require('path');

function normalizePathLike(inputPath = '') {
  const p = String(inputPath || '').trim();
  if (!p) {
    return '';
  }
  const cwd = process.env.KHYQUANT_CWD || process.cwd();
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

function maybeRenderWriteDiff(toolName, params, result, c) {
  try {
    const name = String(toolName)
      .toLowerCase()
      .replace(/[\s_-]/g, '');
    const isKnownWrite =
      /^(write|writefile|filewrite|createfile|edit|editfile|fileedit|multiedit|notebookedit|fileop|fileoperation)$/.test(
        name
      );
    if (!isKnownWrite && !(result && result._khyWriteDiff)) {
      return;
    }
    if (!result || !result.success) {
      return;
    }
    const diffCtx = result._khyWriteDiff || null;
    const absPath = normalizePathLike(
      diffCtx?.filePath ||
        result.path ||
        result.file ||
        params?.path ||
        params?.file_path ||
        params?.filePath ||
        ''
    );
    if (!absPath) {
      return;
    }
    const nextContent =
      diffCtx && typeof diffCtx.afterContent === 'string'
        ? diffCtx.afterContent
        : String(params?.content ?? '');
    const prevContent =
      diffCtx && typeof diffCtx.beforeContent === 'string' ? diffCtx.beforeContent : '';
    if (prevContent === nextContent) {
      return;
    }

    const renderer = require('../aiRenderer');
    const relPath = path.relative(process.cwd(), absPath) || absPath;
    // diff 色板唯一真源 cli/diffSpec.js([DESIGN-ARCH-157] A 刀):此前此处裸写
    // '#225C2B'/'#7A2936' 绕过主题系统;default 主题下与 CC 字面量逐字节相同,
    // 门控 KHY_DIFF_SPEC_V1 关 → 恒回退 CC 字面量。
    const diffSpec = require('../diffSpec');
    const diffCol = diffSpec.diffColors(process.env);

    // [DESIGN-ARCH-157] B 刀:门控开 → 消费与 TUI 同一 rows 契约(cli/writeDiffRows.js),
    // 折叠/gutter/行文法三端同源;门控关 → 走下方历史三分支(逐字节回退)。
    if (diffSpec.diffSpecEnabled(process.env)) {
      const rows = require('../writeDiffRows').buildWriteDiffRows(
        { beforeContent: prevContent, afterContent: nextContent, filePath: absPath },
        false
      );
      if (rows && rows.length) {
        const chalkRows = require('../diffRenderer').renderDiffRowsChalk(rows);
        if (chalkRows) {
          chalkRows.split('\n').forEach((line) => console.log(`    ${line}`));
        }
      }
      // rows 判定无可渲染改动(空 diff / 计算异常)→ 如实什么都不画,不回退旧分支
      // (旧分支对同数据同样画不出内容,只可能虚报)。
      return;
    }

    if (!prevContent && nextContent) {
      // New file — Claude Code style: green content preview (max 10 lines)
      const lines = nextContent.split('\n');
      // 折叠账本唯一真源 cli/diffSpec.js FOLD([DESIGN-ARCH-157] C 刀),值恒等 10,输出不变。
      const maxPreview = diffSpec.FOLD.previewCollapsed;
      // CC 折叠决策收敛到单一真源(previewOverflowMarker.resolveFold):恰藏 1 行 → 内联,
      // 不发标记(门控关 → keep=min(len,10)/hidden=max(0,len-10) 逐字节回退)。
      const { keep, hidden } = require('../previewOverflowMarker').resolveFold(
        lines.length,
        maxPreview,
        process.env
      );
      const shown = lines.slice(0, keep);
      // gutter 位宽收敛到单一真源 cli/diffGutter.js(门控关→恒 4 位字节回退)。
      const _pad = require('../diffGutter').computeDiffGutterWidthForMax(shown.length, process.env);
      for (let i = 0; i < shown.length; i++) {
        const num = String(i + 1).padStart(_pad);
        console.log(c.bgHex(diffCol.add).hex(diffCol.text)(`    ${num} + ${shown[i]}`));
      }
      if (hidden > 0) {
        console.log(
          c.dim(
            `    ${require('../previewOverflowMarker').buildLinesOverflow(hidden, '+', false, process.env)}`
          )
        );
      }
    } else if (prevContent && !nextContent) {
      // Deleted file — full red preview (防呆 rule ②: deletion shows all-red −).
      const lines = prevContent.split('\n');
      const maxPreview = diffSpec.FOLD.previewCollapsed;
      const { keep, hidden } = require('../previewOverflowMarker').resolveFold(
        lines.length,
        maxPreview,
        process.env
      );
      const shown = lines.slice(0, keep);
      // gutter 位宽收敛到单一真源 cli/diffGutter.js(门控关→恒 4 位字节回退)。
      const _pad = require('../diffGutter').computeDiffGutterWidthForMax(shown.length, process.env);
      for (let i = 0; i < shown.length; i++) {
        const num = String(i + 1).padStart(_pad);
        console.log(c.bgHex(diffCol.del).hex(diffCol.text)(`    ${num} - ${shown[i]}`));
      }
      if (hidden > 0) {
        console.log(
          c.dim(
            `    ${require('../previewOverflowMarker').buildLinesOverflow(hidden, '-', false, process.env)}`
          )
        );
      }
    } else {
      // Existing file — red/green structured diff
      const rendered = renderer.renderStructuredDiff(prevContent, nextContent, relPath);
      rendered.split('\n').forEach((line) => console.log(`    ${line}`));
    }
  } catch {
    // non-critical
  }
}

function maybeRenderInlineDiffFromToolOutput(toolName, result, c) {
  try {
    const name = String(toolName)
      .toLowerCase()
      .replace(/[\s_-]/g, '');
    if (name !== 'shellcommand' && name !== 'shell' && name !== 'bash' && name !== 'command') {
      return;
    }
    if (!result || !result.success) {
      return;
    }
    const out = String(result.output || result.content || '');
    const diffPattern = /(^|\n)(\+\+\+|---|@@|\+[^+].*|-[^-].*)/m;
    if (!diffPattern.test(out)) {
      return;
    }
    const rendered = require('../aiRenderer').renderDiff(out);
    // Route the line cut through ccTruncateLines so an over-long diff is not
    // silently clipped — gate on appends an honest "… +N 行" marker; gate off →
    // byte-identical legacy (slice(0,120) re-split prints the same 120 lines).
    // [DESIGN-ARCH-157] C 刀(病灶 D3):门控开 → 行预算收敛到 FOLD.diffCollapsed(60),
    // 与 TUI buildShellDiffRows 同一账本;门控关 → 恒 120 逐字节回退。
    const cap = require('../diffSpec').diffSpecEnabled(process.env)
      ? require('../diffSpec').FOLD.diffCollapsed
      : 120;
    require('../ccTruncateLines')
      .truncatePreview(rendered, cap, process.env)
      .split('\n')
      .forEach((line) => console.log(`    ${line}`));
  } catch {
    // non-critical
  }
}

// ── Directory tree builder for drag-and-drop directory support ──
const { DIR_SKIP: _DIR_SKIP } = require('./dirSkip');
function _buildDirTree(root, opts = {}) {
  const maxDepth = opts.maxDepth || 3;
  const maxFiles = opts.maxFiles || 80;
  let fileCount = 0;
  const lines = [];

  function walk(dir, prefix, depth) {
    if (depth > maxDepth || fileCount > maxFiles) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) {
        return -1;
      }
      if (!a.isDirectory() && b.isDirectory()) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });
    const filtered = entries
      .filter((e) => !e.name.startsWith('.') || e.name === '.env.example')
      .filter((e) => !_DIR_SKIP.has(e.name));
    for (let i = 0; i < filtered.length && fileCount <= maxFiles; i++) {
      const entry = filtered[i];
      const isLast = i === filtered.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      if (entry.isDirectory()) {
        lines.push(`${prefix}${connector}${entry.name}/`);
        walk(path.join(dir, entry.name), childPrefix, depth + 1);
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
        fileCount++;
      }
    }
    if (fileCount > maxFiles) {
      lines.push(`${prefix}... (truncated, >${maxFiles} files)`);
    }
  }

  lines.push(path.basename(root) + '/');
  walk(root, '', 0);
  return { text: lines.join('\n'), fileCount };
}

module.exports = {
  normalizePathLike,
  maybeRenderWriteDiff,
  maybeRenderInlineDiffFromToolOutput,
  _buildDirTree,
};
