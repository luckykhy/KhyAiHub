'use strict';

/**
 * BUG-120 — the cold-start "first Enter is swallowed" defect, pinned at the
 * ink parser boundary (the exact consumer granularity).
 *
 * Live PTY forensics (.khy/feedback/tui-resize-ux-20260924/differential.md
 * #16–#25, read()-boundary probe) measured: during the boot/first-frame
 * event-loop freeze the typed '/cost' and a 0.5s-later Enter are still sitting
 * unread in stdin; when ink wakes it drains them as ONE chunk '/cost\r', and
 * — this file proves — ink's own parse-keypress turns that whole buffer into a
 * SINGLE event whose sequence is '/cost\r' (length > 1) and whose name is NOT
 * 'return'. useTextInput.js keys its submit branch on `key.return` and its
 * paste branch on `input.length > 1`, so the merged input goes down the paste
 * path, where flushPaste() maps '\r'→'\n' (:195) and trims a trailing newline
 * (:200): the Enter is consumed as paste content and the turn never submits.
 *
 * The split path is the control: when the two keystrokes arrive as separate
 * stdin reads (the 3s-gap family — prewarm already settled, no freeze), the
 * lone '\r' parses to name='return' and reaches the single-char drain at :324
 * (which flushes pasteBuf first, so cur.text is '/cost'), and it submits.
 *
 * These tests assert the upstream ink fact against ink's own parser (not our
 * reading of it) and pin the source-shape invariant the defect depends on.
 *
 * 2026-09-28 (§6 nightly): fixed by SPLITTING the merged chunk inside
 * useTextInput.onInput — the body goes through the existing paste accumulator,
 * then the lone CR is handed back to the same handler, which is exactly the
 * event pair two separate stdin reads produce. The invariant guards below were
 * written on the assumption that a fix would invert them; it did not: the paste
 * branch, flushPaste's trim and the `if (key.return) {` submit branch all still
 * exist, so those pins keep guarding the split (working) path. The new pins for
 * the fix itself are at the bottom of this file.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOOK_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../src/cli/tui/hooks/useTextInput.js'),
  'utf8'
);

/** ink ships a CJS build; requiring the parser directly keeps this node:test. */
function loadKeypressParser() {
  const p = path.resolve(__dirname, '../../../../node_modules/ink/build/parse-keypress.js');
  if (!fs.existsSync(p)) return null;
  try {
    const mod = require(p);
    return typeof mod === 'function' ? mod : mod.default;
  } catch {
    return null;
  }
}

test('ink 把冻结期合并的 "/cost"+CR 解析成单个非 return 事件（BUG-120 吞键根因）', () => {
  const parse = loadKeypressParser();
  if (!parse) return; // node_modules layout differs; the source guards below still pin the defect.
  const ev = parse(Buffer.from('/cost\r'));
  // One event for the whole buffer — the trailing Enter is NOT split out.
  assert.strictEqual(ev.sequence, '/cost\r');
  assert.ok(ev.sequence.length > 1, '合并块必须以 length>1 整串到达 onInput，才会落进 paste 分支');
  // And ink names it NOT 'return', so useTextInput's key.return submit branch cannot fire.
  assert.notStrictEqual(ev.name, 'return');
});

test('拆分到达时（3s 间隔族）裸 CR 单独成 return 事件 → 正常提交（对照组）', () => {
  const parse = loadKeypressParser();
  if (!parse) return;
  const text = parse(Buffer.from('/cost'));
  assert.strictEqual(text.sequence, '/cost');
  assert.notStrictEqual(text.name, 'return');
  const cr = parse(Buffer.from('\r'));
  assert.strictEqual(cr.name, 'return'); // this is what makes a split Enter submit
});

test('源不变量：提交分支只认 key.return；粘贴分支按 input.length>1 抢走合并块', () => {
  // Submit is gated ONLY on key.return — an event named '' (the merged case) cannot submit.
  const submitIdx = HOOK_SRC.indexOf('if (key.return) {');
  assert.ok(submitIdx > 0, 'submit 分支应基于 key.return');
  // The paste accumulator grabs ANY multi-char chunk before submit can see a lone CR.
  const pasteIdx = HOOK_SRC.indexOf('if (input.length > 1) {');
  assert.ok(pasteIdx > 0, '缺 input.length>1 粘贴分支（合并块入口）');
  // flushPaste maps CR/CRLF to LF then trims ONE trailing newline — the swallow step.
  assert.ok(HOOK_SRC.includes(".replace(/\\r\\n?/g, '\\n')"), 'flushPaste 应归一 \\r→\\n');
  assert.ok(HOOK_SRC.includes(".replace(/\\n$/, '')"), 'flushPaste 应 trim 尾部换行（吞掉合并 Enter）');
  // The single-char drain (:324) is why a SPLIT Enter still submits — pin it so the
  // owner fix cannot regress the working path while repairing the merged one.
  assert.ok(
    HOOK_SRC.includes('if (pasteBuf.current && !(input && input.length > 1))'),
    '单字符事件应在使用前 drain pasteBuf（拆分包的正常提交前提）'
  );
});

// ── 修复自身（2026-09-28 §6）─────────────────────────────────────────────────

const { _internals: hookInternals } = require('../../src/cli/tui/hooks/useTextInput');
const { splitMergedEnter, isMergedEnterEnabled } = hookInternals;

test('合并块判据：纯正文 + 恰好一个尾部 CR 才拆，其余形态一律放行', () => {
  // The two shapes the freeze actually produces.
  assert.strictEqual(splitMergedEnter('zzhello\r'), 'zzhello');
  assert.strictEqual(splitMergedEnter('hello world\r'), 'hello world');
  assert.strictEqual(splitMergedEnter('你好世界\r'), '你好世界');
  // A lone CR is already handled by the key.return branch — must not be claimed.
  assert.strictEqual(splitMergedEnter('\r'), null);
  // Multi-line payloads stay paste content (that is what folding/archiving is for).
  assert.strictEqual(splitMergedEnter('ab\ncd\r'), null);
  assert.strictEqual(splitMergedEnter('ab\r\n'), null);
  assert.strictEqual(splitMergedEnter('ab\r\r'), null);
  // Any chunk carrying escape/control bytes is not plain text: a bracketed GUI
  // paste (ESC[200~ … ESC[201~) or an arrow-key burst must never auto-submit.
  assert.strictEqual(splitMergedEnter('\x1b[200~ab\x1b[201~\r'), null);
  assert.strictEqual(splitMergedEnter('a\x1b[C\r'), null);
});

test('菜单前缀 / @ ! # 不拆：那里 Enter 的语义是取回补全行，提交半截命令会烧一轮', () => {
  for (const s of ['/cost\r', '/co\r', '!dir\r', '@src/a.js\r', '#note\r']) {
    assert.strictEqual(splitMergedEnter(s), null, s);
  }
});

test('门控 KHY_TUI_MERGED_ENTER：默认开，off 值回到改前逐字节路径', () => {
  assert.strictEqual(isMergedEnterEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no', ' OFF ']) {
    assert.strictEqual(isMergedEnterEnabled({ KHY_TUI_MERGED_ENTER: v }), false, v);
  }
  assert.strictEqual(isMergedEnterEnabled({ KHY_TUI_MERGED_ENTER: '1' }), true);
});

test('源不变量：拆分块必须排在粘贴累积分支之前，并把 CR 交回本 handler', () => {
  const splitIdx = HOOK_SRC.indexOf('const body = splitMergedEnter(input);');
  const pasteIdx = HOOK_SRC.indexOf('if (input.length > 1) {');
  assert.ok(splitIdx > 0, '缺合并块拆分（BUG-120 未修）');
  assert.ok(pasteIdx > 0);
  // Below the paste branch the chunk is already swallowed — ordering is the fix.
  assert.ok(splitIdx < pasteIdx, '拆分必须早于 input.length>1 粘贴分支');
  // Window = the split block itself (it sits between the paste drain and the
  // shell-mode section), so the assertions below cannot be diluted by the rest
  // of onInput.
  const blockEnd = HOOK_SRC.indexOf('// ── Shell mode', splitIdx);
  assert.ok(blockEnd > splitIdx, '拆分块应位于 paste drain 与 shell-mode 段之间');
  const block = HOOK_SRC.slice(splitIdx, blockEnd);
  // Hand the CR back through the same handler (so the menu/IME/paste-guard layer
  // of a real lone-CR event is reproduced), and route the body through the
  // existing paste accumulator (so folding keeps working) instead of a second
  // insert path.
  assert.ok(block.includes("onInput('\\r', { return: true })"), 'CR 应回灌本 handler');
  assert.ok(block.includes('pasteBuf.current += body;'), '正文应走既有粘贴累加器');
  assert.ok(block.includes('imeCommitGuard.noteImeCommit(body);'), '应保持 IME 近因判定');
  // The submit itself must not be re-implemented here (one submit path only).
  assert.doesNotMatch(block, /onSubmit\(/, '不得在拆分块内另起一条提交路径');
});
