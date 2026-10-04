'use strict';

/**
 * Cross-file WIRING tests for the memory-recall "process state" ([DESIGN-MEM-008] V5).
 * Uses node:test (run via `node --test`), never jest.
 *
 * Why this file exists (and why the pure-leaf unit tests are NOT enough):
 *   `memoryOpsNotice.test.js` only proves the *producer* emits a well-shaped payload.
 *   It cannot prove that the two *consumers* (REPL spinner label table, TUI busy-line
 *   label table) actually recognize that payload's `phase` value. A typo in either
 *   table — or a phase string that differs by one character — leaves every unit test
 *   green while the user sees nothing. Wiring assertions must therefore call the
 *   consumer's real function, not grep its source.
 *
 * Covers:
 *   - process payload: starting/done are a PAIR (same phase + same message, different
 *     stage) — a missing `done` terminator leaves the spinner text stuck forever
 *     (same failure mode as `compacting` without `compacted`).
 *   - message === RECALL_PROCESS_TEXT (single source of truth; three copies would
 *     drift and break the byte-revert gate).
 *   - wording honesty: contains 「正在」, contains no digits (a process state must not
 *     leak counts), distinguishable from the RESULT state wording.
 *   - REPL: PHASE_LABELS really resolves the emitted phase to a non-empty label.
 *   - TUI: _getStatusLabel really resolves it, and deriveLiveActivity returns '' for
 *     it — otherwise the busy line reads 「正在回忆… · 等待模型响应」, which contradicts
 *     itself.
 *   - gate KHY_MEMORY_NOTICE off ⇒ BOTH states return null (never emit a process
 *     state that has no terminator).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');
const NOTICE_PATH = path.join(SRC, 'services', 'memoryOpsNotice.js');

const notice = require(NOTICE_PATH);
const { PHASE_LABELS } = require(path.join(SRC, 'cli', 'renderTheme.js'));

test('process payload: starting and done are a pair (same phase + message, different stage)', () => {
  const starting = notice.formatRecallProcessPayload('starting');
  const done = notice.formatRecallProcessPayload('done');
  assert.ok(starting && done, 'both states must produce a payload');
  assert.strictEqual(starting.phase, done.phase);
  assert.strictEqual(starting.phase, 'memory-recall');
  assert.notStrictEqual(starting.stage, done.stage);
  assert.strictEqual(starting.stage, 'starting');
  assert.strictEqual(done.stage, 'done');
  assert.strictEqual(starting.message, done.message);
});

test('process payload: message is the single source of truth RECALL_PROCESS_TEXT', () => {
  const starting = notice.formatRecallProcessPayload('starting');
  assert.strictEqual(starting.message, notice.RECALL_PROCESS_TEXT);
});

test('process payload: stage normalizes — missing / unknown / non-string ⇒ starting', () => {
  assert.strictEqual(notice.formatRecallProcessPayload().stage, 'starting');
  assert.strictEqual(notice.formatRecallProcessPayload('bogus').stage, 'starting');
  assert.strictEqual(notice.formatRecallProcessPayload(42).stage, 'starting');
  assert.strictEqual(notice.formatRecallProcessPayload('done').stage, 'done');
});

test('process payload: wording is honest — progressive, count-free, distinguishable from result state', () => {
  const msg = notice.RECALL_PROCESS_TEXT;
  assert.ok(msg.includes('正在'), `must self-describe as in-progress: ${msg}`);
  assert.ok(!/\d/.test(msg), `process state must not leak counts: ${msg}`);
  assert.ok(!msg.includes('.md'), `process state must not name files: ${msg}`);
  // The RESULT state names files; the PROCESS state must not be confusable with it.
  const result = notice.formatRecallNotice(new Set(['a.md']), {});
  assert.notStrictEqual(msg, result);
});

test('REPL: PHASE_LABELS resolves the emitted phase to a non-empty label', () => {
  const phase = notice.formatRecallProcessPayload('starting').phase;
  assert.ok(Object.prototype.hasOwnProperty.call(PHASE_LABELS, phase),
    `spinner.setPhase('${phase}') would find no label ⇒ spinner shows nothing`);
  const label = PHASE_LABELS[phase];
  assert.strictEqual(typeof label, 'string');
  assert.ok(label.length > 0);
  assert.ok(label.includes('回忆'), `label should mention recalling: ${label}`);
});

test('TUI: _getStatusLabel resolves the emitted phase to a non-empty label', () => {
  const phase = notice.formatRecallProcessPayload('starting').phase;
  const helpers = require(path.join(SRC, 'cli', 'tui', 'ink-components', 'appHostHelpers.js'));
  assert.strictEqual(typeof helpers._getStatusLabel, 'function');
  const label = helpers._getStatusLabel(phase, null);
  assert.strictEqual(typeof label, 'string');
  assert.ok(label.length > 0, `TUI busy line would render nothing for ${phase}`);
  assert.ok(label.includes('正在'), `TUI label should read as in-progress: ${label}`);
});

test('TUI: deriveLiveActivity returns "" for the process phase (keep the label bare)', () => {
  const phase = notice.formatRecallProcessPayload('starting').phase;
  const mod = require(path.join(SRC, 'cli', 'repl', 'statusLiveActivity.js'));
  const fn = mod.deriveLiveActivity || (mod.default && mod.default.deriveLiveActivity);
  assert.strictEqual(typeof fn, 'function');
  // If this returns a gateway detail, the busy line becomes
  // 「正在回忆相关记忆… · 等待模型响应」 — self-contradictory.
  assert.strictEqual(fn({ phase, detail: '等待模型响应' }), '');
});

test('gate off: BOTH states return null (never emit a process state without a terminator)', () => {
  const prev = process.env.KHY_MEMORY_NOTICE;
  process.env.KHY_MEMORY_NOTICE = '0';
  try {
    delete require.cache[require.resolve(NOTICE_PATH)];
    const off = require(NOTICE_PATH);
    assert.strictEqual(off.formatRecallProcessPayload('starting'), null);
    assert.strictEqual(off.formatRecallProcessPayload('done'), null);
  } finally {
    delete require.cache[require.resolve(NOTICE_PATH)];
    if (prev === undefined) delete process.env.KHY_MEMORY_NOTICE;
    else process.env.KHY_MEMORY_NOTICE = prev;
  }
});

test('process payload: never throws on adversarial input', () => {
  for (const bad of [null, undefined, 0, '', {}, [], NaN, Symbol('s'), () => {}]) {
    assert.doesNotThrow(() => notice.formatRecallProcessPayload(bad));
  }
});
