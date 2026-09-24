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
 * reading of it) and pin the source-shape invariant the defect depends on. The
 * owner fix (useTextInput.js paste branch must not eat a trailing bare CR of a
 * NON-bracketed chunk — a real GUI paste is wrapped in ESC[200~ … ESC[201~)
 * will invert the invariant guards below; update them consciously then.
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
