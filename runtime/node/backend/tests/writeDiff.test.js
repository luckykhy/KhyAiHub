'use strict';

/**
 * Tests for the red/green ±diff capture pipeline used to render precise file
 * modification diffs in the agent's Observation stream.
 *
 * Architecture under test (tool-agnostic):
 *   _captureWriteFileDiffContext(call)  → snapshot { filePath, beforeContent } BEFORE the write
 *   <the real tool writes to disk>
 *   _finalizeWriteDiff(writeCtx)        → read AFTER content from disk → { filePath, beforeContent, afterContent }
 *
 * Plus the terminal renderer (renderStructuredDiff) for ANSI + UTF-8 safety.
 *
 * 防呆 invariants asserted:
 *   ① diff failure never throws (returns null) — the write itself is unaffected.
 *   ② new file → before='' ; deleted file → after='' .
 *   ③ binary / oversize content is skipped (returns null), never garbled.
 *   + UTF-8 / multibyte (Chinese) is preserved exactly — no mojibake / truncation.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  _captureWriteFileDiffContext,
  _finalizeWriteDiff,
  _safeReadForDiff,
} = require('../src/services/toolUseLoop');
const { renderStructuredDiff, computeStructuredDiffHunks } = require('../src/cli/diffRenderer');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-writediff-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function tmp(name) {
  return path.join(tmpDir, name);
}

describe('_captureWriteFileDiffContext — tool-agnostic pre-write snapshot', () => {
  test('replaceAtLocation (registered fs editor) → captured + full chain renders rows', () => {
    // 复现(用户实测「红绿 diff 不显示」):replaceAtLocation 是注册在案的文本文件
    // 编辑工具(src/tools/replaceAtLocation.js,file_path 参数、改写文件内容),
    // 但 _WRITE_TOOL_NAMES 没有 replaceatlocation → capture 恒 null → 永远没有
    // _khyWriteDiff → 两条 UI 路径(经典 REPL maybeRenderWriteDiff / TUI
    // ToolLines)都无从显示。此测试钉死:该工具名必须进采集白名单,且
    // capture→write→finalize→buildWriteDiffRows 全链路产出可渲染红绿行。
    const fp = tmp('loc.txt');
    fs.writeFileSync(fp, 'alpha beta gamma\n', 'utf-8');
    const call = { name: 'replaceAtLocation', params: { file_path: fp, word: 'beta', replacement: 'BETA!' } };
    const ctx = _captureWriteFileDiffContext(call);
    assert.ok(ctx, 'replaceAtLocation must be captured by the whitelist');
    assert.equal(ctx.beforeContent, 'alpha beta gamma\n');

    // 模拟工具写盘,再走 finalize(与 toolUseLoopCore 的真实次序一致)。
    fs.writeFileSync(fp, 'alpha BETA! gamma\n', 'utf-8');
    const diff = _finalizeWriteDiff(ctx);
    assert.ok(diff, 'finalize reads AFTER content back from disk');
    assert.equal(diff.beforeContent, 'alpha beta gamma\n');
    assert.equal(diff.afterContent, 'alpha BETA! gamma\n');

    // 显示链(name-agnostic:两条 UI 路径都只认 result._khyWriteDiff)→ 行模型可渲染。
    const { buildWriteDiffRows } = require('../src/cli/writeDiffRows');
    const rows = buildWriteDiffRows(diff, true);
    assert.ok(Array.isArray(rows) && rows.length > 0, 'rows renderable');
    assert.ok(rows.some((r) => r.kind === 'del' && r.text === 'alpha beta gamma'));
    assert.ok(rows.some((r) => r.kind === 'add' && r.text === 'alpha BETA! gamma'));
  });

  test('writeFile new file → beforeContent is empty', () => {
    const fp = tmp('new.txt');
    const ctx = _captureWriteFileDiffContext({ name: 'writeFile', params: { path: fp, content: 'hi' } });
    assert.ok(ctx);
    assert.equal(ctx.filePath, fp);
    assert.equal(ctx.beforeContent, '');
  });

  test('editFile existing file → snapshots current content', () => {
    const fp = tmp('edit.txt');
    fs.writeFileSync(fp, 'original\n', 'utf-8');
    const ctx = _captureWriteFileDiffContext({ name: 'editFile', params: { file_path: fp, old_string: 'original', new_string: 'changed' } });
    assert.ok(ctx);
    assert.equal(ctx.beforeContent, 'original\n');
  });

  test('MultiEdit (edits array) is covered via file_path — no per-tool logic needed', () => {
    const fp = tmp('multi.txt');
    fs.writeFileSync(fp, 'a\nb\nc\n', 'utf-8');
    const ctx = _captureWriteFileDiffContext({
      name: 'MultiEdit',
      params: { file_path: fp, edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'c', new_string: 'C' }] },
    });
    assert.ok(ctx, 'MultiEdit must be captured by path alone');
    assert.equal(ctx.beforeContent, 'a\nb\nc\n');
  });

  test('NotebookEdit is covered via notebook_path', () => {
    const fp = tmp('nb.ipynb');
    fs.writeFileSync(fp, '{"cells":[]}', 'utf-8');
    const ctx = _captureWriteFileDiffContext({ name: 'NotebookEdit', params: { notebook_path: fp, new_source: 'x' } });
    assert.ok(ctx);
    assert.equal(ctx.beforeContent, '{"cells":[]}');
  });

  test('non-write tool (bash) → null', () => {
    assert.equal(_captureWriteFileDiffContext({ name: 'bash', params: { command: 'ls' } }), null);
  });

  test('missing path → null', () => {
    assert.equal(_captureWriteFileDiffContext({ name: 'writeFile', params: { content: 'x' } }), null);
  });

  test('binary file (NUL byte) → null (防呆 ③: never garble)', () => {
    const fp = tmp('blob.bin');
    fs.writeFileSync(fp, Buffer.from([0x41, 0x00, 0x42]));
    assert.equal(_captureWriteFileDiffContext({ name: 'writeFile', params: { path: fp, content: 'x' } }), null);
  });
});

describe('_finalizeWriteDiff — post-write disk re-read', () => {
  test('new file: before="" after=content (防呆 ②)', () => {
    const fp = tmp('created.txt');
    const ctx = _captureWriteFileDiffContext({ name: 'writeFile', params: { path: fp, content: 'whatever' } });
    // Simulate the real tool writing the file:
    fs.writeFileSync(fp, 'line1\nline2\n', 'utf-8');
    const diff = _finalizeWriteDiff(ctx);
    assert.ok(diff);
    assert.equal(diff.beforeContent, '');
    assert.equal(diff.afterContent, 'line1\nline2\n');
  });

  test('edit: before and after differ as written to disk', () => {
    const fp = tmp('m.txt');
    fs.writeFileSync(fp, 'hello world\n', 'utf-8');
    const ctx = _captureWriteFileDiffContext({ name: 'editFile', params: { file_path: fp, old_string: 'world', new_string: 'there' } });
    fs.writeFileSync(fp, 'hello there\n', 'utf-8'); // the tool's actual write
    const diff = _finalizeWriteDiff(ctx);
    assert.ok(diff);
    assert.equal(diff.beforeContent, 'hello world\n');
    assert.equal(diff.afterContent, 'hello there\n');
  });

  test('deletion: before=content after="" (防呆 ②)', () => {
    const fp = tmp('gone.txt');
    fs.writeFileSync(fp, 'to be removed\n', 'utf-8');
    const ctx = _captureWriteFileDiffContext({ name: 'fileOp', params: { path: fp } });
    fs.rmSync(fp); // the tool deletes it
    const diff = _finalizeWriteDiff(ctx);
    assert.ok(diff);
    assert.equal(diff.beforeContent, 'to be removed\n');
    assert.equal(diff.afterContent, '');
  });

  test('no-op write (content unchanged) → null', () => {
    const fp = tmp('same.txt');
    fs.writeFileSync(fp, 'unchanged\n', 'utf-8');
    const ctx = _captureWriteFileDiffContext({ name: 'writeFile', params: { path: fp, content: 'unchanged\n' } });
    // tool "writes" identical content
    fs.writeFileSync(fp, 'unchanged\n', 'utf-8');
    assert.equal(_finalizeWriteDiff(ctx), null);
  });

  test('防呆 ①: null / malformed ctx never throws', () => {
    assert.equal(_finalizeWriteDiff(null), null);
    assert.equal(_finalizeWriteDiff({}), null);
    assert.equal(_finalizeWriteDiff({ filePath: 12345 }), null);
  });

  test('UTF-8 / Chinese multibyte preserved exactly (no mojibake / truncation)', () => {
    const fp = tmp('cn.txt');
    fs.writeFileSync(fp, '第一行：你好世界\n第二行：原始内容\n', 'utf-8');
    const ctx = _captureWriteFileDiffContext({ name: 'editFile', params: { file_path: fp, old_string: '原始内容', new_string: '修改后的内容🚀' } });
    fs.writeFileSync(fp, '第一行：你好世界\n第二行：修改后的内容🚀\n', 'utf-8');
    const diff = _finalizeWriteDiff(ctx);
    assert.ok(diff);
    assert.equal(diff.beforeContent, '第一行：你好世界\n第二行：原始内容\n');
    assert.equal(diff.afterContent, '第一行：你好世界\n第二行：修改后的内容🚀\n');
    // Byte-exact round trip — the emoji (4-byte) and CJK (3-byte) survive intact.
    assert.equal(Buffer.byteLength(diff.afterContent, 'utf-8'), Buffer.byteLength('第一行：你好世界\n第二行：修改后的内容🚀\n', 'utf-8'));
  });
});

describe('_safeReadForDiff — guards', () => {
  test('nonexistent path → "" (creation case)', () => {
    assert.equal(_safeReadForDiff(tmp('nope.txt')), '');
  });

  test('directory → null', () => {
    assert.equal(_safeReadForDiff(tmpDir), null);
  });

  test('binary → null', () => {
    const fp = tmp('b.bin');
    fs.writeFileSync(fp, Buffer.from([0x00, 0x01, 0x02]));
    assert.equal(_safeReadForDiff(fp), null);
  });
});

describe('renderStructuredDiff — ANSI + encoding safety', () => {
  test('emits line-level minus / plus markers with context', () => {
    const out = renderStructuredDiff('a\nb\nc\n', 'a\nB\nc\n', 'x.txt');
    assert.match(out, /- b/, 'removed line marked');
    assert.match(out, /\+ B/, 'added line marked');
    assert.match(out, /  a/, 'unmodified context line retained');
  });

  test('Chinese diff renders without mojibake', () => {
    const out = renderStructuredDiff('标题：旧\n', '标题：新\n', 'cn.txt');
    assert.ok(out.includes('新') || out.includes('标题'), 'Chinese characters survive rendering');
    // The replacement char (U+FFFD) must not appear — proves no broken UTF-8 slicing.
    assert.ok(!out.includes('�'), 'no replacement char / mojibake');
  });

  test('astral emoji (surrogate pair) is not split into replacement chars', () => {
    // Word-level diff must keep an astral code point (U+1F680) intact.
    const out = renderStructuredDiff('deploy now\n', 'deploy now \u{1F680}\n', 'e.txt');
    assert.ok(out.includes('\u{1F680}'), 'emoji survives word-level diff');
    assert.ok(!out.includes('�'), 'no lone-surrogate replacement char');
  });
});

describe('_captureWriteFileDiffContext — path expansion parity (regression)', () => {
  // Regression: the capture used to resolve the RAW param against cwd, so an
  // env-var / ~ path (e.g. "~/桌面/x", "$HOME/x") pointed at a phantom
  // "<cwd>/~/桌面/x". before===after==='' → the red/green diff silently
  // vanished. Capture must expand exactly like the tool does.
  test('env-var path is expanded so the diff is NOT silently dropped', () => {
    process.env.KHY_DIFF_TEST_ROOT = tmpDir;
    try {
      const raw = process.platform === 'win32'
        ? '%KHY_DIFF_TEST_ROOT%\\note.txt'
        : '$KHY_DIFF_TEST_ROOT/note.txt';
      const ctx = _captureWriteFileDiffContext({ name: 'writeFile', params: { path: raw, content: 'x' } });
      assert.ok(ctx, 'context must be captured for an env-var path');
      assert.equal(ctx.filePath, path.join(tmpDir, 'note.txt'), 'path expanded to the real target');
      assert.equal(ctx.beforeContent, '', 'new file → empty before');

      // Simulate the tool writing to the (correctly expanded) path.
      fs.writeFileSync(path.join(tmpDir, 'note.txt'), 'hello\nworld\n', 'utf-8');
      const diff = _finalizeWriteDiff(ctx);
      assert.ok(diff, 'diff must be produced (was null before the fix)');
      assert.equal(diff.afterContent, 'hello\nworld\n');
      assert.equal(diff.beforeContent, '');
    } finally {
      delete process.env.KHY_DIFF_TEST_ROOT;
    }
  });
});

describe('computeStructuredDiffHunks — multi-hunk line diff (P2)', () => {
  test('separates two distant edits into two hunks with accurate counts', () => {
    const before = Array.from({ length: 40 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
    const after = before.replace('L3\n', 'L3x\n').replace('L33\n', 'L33x\n');
    const d = computeStructuredDiffHunks(before, after, { context: 3 });
    assert.equal(d.hunks.length, 2, 'two separate hunks');
    assert.equal(d.added, 2, 'only the 2 real additions counted');
    assert.equal(d.removed, 2, 'only the 2 real removals counted');
    assert.equal(d.hunks[0].gapBefore, -1, 'first hunk has no preceding gap');
    assert.ok(d.hunks[1].gapBefore > 0, 'second hunk records the elided line count');
    assert.ok(d.scanned, 'LCS path was taken (small file)');
  });

  test('a nearby pair of edits coalesces into a single hunk', () => {
    // Edits only 2 lines apart (≤ 2*context) must stay one hunk, not split.
    const before = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
    const after = before.replace('L8\n', 'L8x\n').replace('L10\n', 'L10x\n');
    const d = computeStructuredDiffHunks(before, after, { context: 3 });
    assert.equal(d.hunks.length, 1, 'coalesced into one hunk');
    assert.equal(d.added, 2);
    assert.equal(d.removed, 2);
  });

  test('each change block lists removals before additions', () => {
    const d = computeStructuredDiffHunks('a\nb\nc\n', 'a\nB\nc\n', { context: 3 });
    const kinds = d.hunks[0].rows.map((r) => r.kind);
    assert.deepEqual(kinds, ['ctx', 'del', 'add', 'ctx'], 'del precedes add');
  });

  test('size guard: an oversize rewrite falls back to one block (no O(n²) scan)', () => {
    const before = Array.from({ length: 50 }, (_, i) => `old${i}`).join('\n') + '\n';
    const after = Array.from({ length: 50 }, (_, i) => `new${i}`).join('\n') + '\n';
    const d = computeStructuredDiffHunks(before, after, { context: 3, maxScan: 10 });
    assert.equal(d.scanned, false, 'LCS skipped under the size guard');
    assert.equal(d.hunks.length, 1, 'single coalesced hunk');
    assert.equal(d.removed, 50);
    assert.equal(d.added, 50);
  });

  test('no change → empty hunks, zero counts', () => {
    const d = computeStructuredDiffHunks('x\ny\n', 'x\ny\n');
    assert.equal(d.hunks.length, 0);
    assert.equal(d.added, 0);
    assert.equal(d.removed, 0);
  });
});

describe('buildWriteDiffRows — 相似度交错配对(词级,KHY_DIFF_WORD_PAIRS 默认开)', () => {
  const { buildWriteDiffRows } = require('../src/cli/writeDiffRows');

  const withGate = (name, value, fn) => {
    const saved = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try { return fn(); } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  };

  test('等量逐行小改 → del/add 按原位交错(每对词级可标)', () => {
    const rows = buildWriteDiffRows({
      beforeContent: 'a\nconst x = 1;\nconst y = 2;\nb\n',
      afterContent: 'a\nconst x = 100;\nconst y = 200;\nb\n',
    });
    const kinds = rows.filter((r) => r.kind !== 'stat' && r.kind !== 'ctx').map((r) => r.kind);
    assert.deepStrictEqual(kinds, ['del', 'add', 'del', 'add'], '交错而非先红后绿整块');
    // 双列 gutter:add 行带 numNew。
    const addRow = rows.find((r) => r.kind === 'add');
    assert.equal(addRow.numNew, 2);
  });

  test('整行重写(词级不可标)→ 保留「先红后绿」整块', () => {
    const rows = buildWriteDiffRows({
      beforeContent: 'a\ncompletely different alpha beta\nb\n',
      afterContent: 'a\nzzzz qqqq totally other words\nb\n',
    });
    const kinds = rows.filter((r) => r.kind !== 'stat' && r.kind !== 'ctx').map((r) => r.kind);
    assert.deepStrictEqual(kinds, ['del', 'add'], '非词级 → 回退整块,del 在前');
  });

  test('数量不等(1 删 2 增)→ 回退整块', () => {
    const rows = buildWriteDiffRows({
      beforeContent: 'a\nold line\nb\n',
      afterContent: 'a\nnew one\nnew two\nb\n',
    });
    const kinds = rows.filter((r) => r.kind !== 'stat' && r.kind !== 'ctx').map((r) => r.kind);
    assert.deepStrictEqual(kinds, ['del', 'add', 'add']);
  });

  test('门控 KHY_DIFF_WORD_PAIRS=0 → 交错关闭,先红后绿', () => {
    withGate('KHY_DIFF_WORD_PAIRS', '0', () => {
      const rows = buildWriteDiffRows({
        beforeContent: 'a\nconst x = 1;\nconst y = 2;\nb\n',
        afterContent: 'a\nconst x = 100;\nconst y = 200;\nb\n',
      });
      const kinds = rows.filter((r) => r.kind !== 'stat' && r.kind !== 'ctx').map((r) => r.kind);
      assert.deepStrictEqual(kinds, ['del', 'del', 'add', 'add']);
    });
  });

  test('门控 KHY_DIFF_DUAL_GUTTER=0 → 无 numNew 字段', () => {
    withGate('KHY_DIFF_DUAL_GUTTER', '0', () => {
      const rows = buildWriteDiffRows({
        beforeContent: 'a\nconst x = 1;\nb\n',
        afterContent: 'a\nconst x = 100;\nb\n',
      });
      for (const r of rows) {
        assert.equal(r.numNew, undefined);
      }
    });
  });
});

describe('renderStructuredDiff — classic-path hunk rendering (刀25)', () => {
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  // A 40-line file with only line 3 and line 33 changed; interior lines 4..32
  // are untouched. Legacy collapses the whole span into one churn block with
  // inflated ±counts; the hunked path must split + report real counts.
  const before = Array.from({ length: 40 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
  const after = before.replace('L3\n', 'L3x\n').replace('L33\n', 'L33x\n');

  function withGate(value, fn) {
    const saved = process.env.KHY_CLASSIC_DIFF_HUNKS;
    if (value === undefined) delete process.env.KHY_CLASSIC_DIFF_HUNKS;
    else process.env.KHY_CLASSIC_DIFF_HUNKS = value;
    try { return fn(); } finally {
      if (saved === undefined) delete process.env.KHY_CLASSIC_DIFF_HUNKS;
      else process.env.KHY_CLASSIC_DIFF_HUNKS = saved;
    }
  }

  test('gate on (default): multi-region edit splits into hunks with a "⋯ N unchanged lines" separator', () => {
    withGate(undefined, () => {
      const out = strip(renderStructuredDiff(before, after, 'f.txt'));
      assert.match(out, /⋯ 23 unchanged lines/, 'elided interior run reported as a single dim gap');
      // The interior unchanged lines (L10..L25) must NOT be redrawn as churn.
      assert.ok(!/[-+] L20\b/.test(out), 'interior unchanged line L20 is not redrawn as ±churn');
      // Both real edits still render (dual old|new gutter: del shows only the old
      // number, add only the new one).
      assert.match(out, /3\s+- L3\b/, 'line 3 removal (old column only)');
      assert.match(out, /3 \+ L3x\b/, 'line 3 addition (new column only)');
      assert.match(out, /33\s+- L33\b/, 'line 33 removal (old column only)');
      assert.match(out, /33 \+ L33x\b/, 'line 33 addition (new column only)');
      assert.match(out, / 4  4 {3}L4/, 'ctx row carries BOTH old and new numbers (dual gutter)');
    });
  });

  test('gate on: stat line reports the REAL ±counts, not the inflated churn span', () => {
    withGate(undefined, () => {
      const out = strip(renderStructuredDiff(before, after, 'f.txt'));
      assert.match(out, /└ Added 2 lines, removed 2 lines/, 'real counts: +2 / -2');
      assert.ok(!/Added 31 lines/.test(out), 'no inflated count');
    });
  });

  test('gate off: byte-identical legacy single-block churn (inflated counts, no separator)', () => {
    withGate('0', () => {
      const out = strip(renderStructuredDiff(before, after, 'f.txt'));
      assert.ok(!out.includes('⋯'), 'legacy has no gap separator');
      assert.match(out, /└ Added 31 lines, removed 31 lines/, 'legacy over-counts the whole span');
      // Legacy redraws every interior line as both removal and addition.
      assert.match(out, /- L20\b/, 'legacy churn: L20 drawn as removed');
      assert.match(out, /\+ L20\b/, 'legacy churn: L20 drawn as added');
    });
  });

  test('gate on: a single-region edit renders identically to legacy (no separator, same counts)', () => {
    const simpleBefore = 'a\nb\nc\n';
    const simpleAfter = 'a\nB\nc\n';
    const on = withGate(undefined, () => strip(renderStructuredDiff(simpleBefore, simpleAfter, 'x.txt')));
    const off = withGate('0', () => strip(renderStructuredDiff(simpleBefore, simpleAfter, 'x.txt')));
    assert.equal(on, off, 'single-region edit: hunked path == legacy path (only multi-region diverges)');
    assert.ok(!on.includes('⋯'), 'no separator for a single contiguous change');
  });
});
