'use strict';

/**
 * Colocated contract test for abortCascade.js (two-tier AbortController cascade).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupAbortCascade } = require('./abortCascade');

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('no external signal: a live parent, null externalSignal, nothing aborted', () => {
  const r = setupAbortCascade({ options: {} });
  assert.deepEqual(Object.keys(r).sort(), ['_createSiblingAbort', '_isAborted', '_toolAbortSig', 'externalSignal', 'parentAbort']);
  assert.equal(r.externalSignal, null);
  assert.equal(r._isAborted(), false);
  assert.equal(r.parentAbort.signal.aborted, false);
  r.parentAbort.abort('cleanup'); // do not leak a listener into the test process
});

test('options.signal is accepted as well as options.abortSignal', () => {
  const src = new AbortController();
  const r = setupAbortCascade({ options: { signal: src.signal } });
  assert.equal(r.externalSignal, src.signal);
  src.abort('user pressed ESC');
  assert.equal(r._isAborted(), true);
  assert.equal(r.parentAbort.signal.reason, 'user pressed ESC');
});

test('an already-aborted external signal aborts the parent immediately', () => {
  const src = new AbortController();
  src.abort('pre-existing');
  const r = setupAbortCascade({ options: { abortSignal: src.signal } });
  assert.equal(r._isAborted(), true);
  assert.equal(r.parentAbort.signal.reason, 'pre-existing');
});

test('abort() 无 reason：DOM 语义下 reason 是 AbortError 异常，级联原样转发', () => {
  const src = new AbortController();
  src.abort();
  const r = setupAbortCascade({ options: { abortSignal: src.signal } });
  assert.equal(r.parentAbort.signal.aborted, true);
  // 规范里 aborted 无 reason 时 signal.reason 是 DOMException(AbortError)，是真值
  // → `reason || 'external abort'` 取到异常本身，字面量这一支对合规 signal 不可达。
  assert.equal(r.parentAbort.signal.reason, src.signal.reason);
  assert.equal(r.parentAbort.signal.reason.name, 'AbortError');
});

test('只有 reason 为 nullish 的（非规范）信号才落到字面量 "external abort"', () => {
  const listeners = [];
  const fake = { aborted: false, reason: undefined, addEventListener: (_e, h) => listeners.push(h) };
  const r = setupAbortCascade({ options: { abortSignal: fake } });
  fake.aborted = true;
  listeners.forEach((h) => h());
  assert.equal(r.parentAbort.signal.reason, 'external abort');
});

test('the external listener is { once: true } — a second abort does not re-fire', () => {
  const src = new AbortController();
  const r = setupAbortCascade({ options: { abortSignal: src.signal } });
  src.abort('first');
  assert.equal(r.parentAbort.signal.reason, 'first');
  assert.doesNotThrow(() => src.abort('second'));
  assert.equal(r.parentAbort.signal.reason, 'first', 'the parent keeps the reason that actually stopped it');
});

test('KHY_TOOL_ABORT_SIGNAL gates whether tools see the parent signal', () => {
  const on = withEnv('KHY_TOOL_ABORT_SIGNAL', undefined, () => setupAbortCascade({ options: {} }));
  assert.equal(on._toolAbortSig, on.parentAbort.signal, 'default ON: a long tool call can be cut loose');
  const off = withEnv('KHY_TOOL_ABORT_SIGNAL', '0', () => setupAbortCascade({ options: {} }));
  assert.equal(off._toolAbortSig, null, 'OFF: byte-identical legacy, no race with the tool');
  on.parentAbort.abort('cleanup');
  off.parentAbort.abort('cleanup');
});

test('a sibling created before the parent abort is linked to it, and aborts with the parent reason', () => {
  const r = setupAbortCascade({ options: {} });
  const sib = r._createSiblingAbort();
  assert.equal(sib.signal.aborted, false);
  r.parentAbort.abort('iteration timeout');
  assert.equal(sib.signal.aborted, true);
  assert.equal(sib.signal.reason, 'iteration timeout');
  assert.equal(typeof sib.controller.abort, 'function');
});

test('a sibling created AFTER the parent already aborted starts dead', () => {
  const r = setupAbortCascade({ options: {} });
  r.parentAbort.abort('session end');
  const sib = r._createSiblingAbort();
  assert.equal(sib.signal.aborted, true);
  assert.equal(sib.signal.reason, 'session end');
});

test('cleanup() detaches the sibling from the parent — a later round is not collateral damage', () => {
  const r = setupAbortCascade({ options: {} });
  const sib = r._createSiblingAbort();
  sib.cleanup();
  r.parentAbort.abort('too late');
  assert.equal(sib.signal.aborted, false, 'the unlinked sibling keeps running');
});

test('sibling.abort(reason) is self-contained and swallowing', () => {
  const r = setupAbortCascade({ options: {} });
  const sib = r._createSiblingAbort();
  sib.abort('tool said no');
  assert.equal(sib.signal.aborted, true);
  assert.equal(sib.signal.reason, 'tool said no');
  assert.doesNotThrow(() => sib.abort('again'), 'double abort is ignored by AbortController');
  r.parentAbort.abort('cleanup');
});

test('the interruptSignal poll (500ms, self-cleaning, unref) promotes an interrupt to a parent abort', async () => {
  const flag = { interrupted: false };
  const r = setupAbortCascade({ options: {}, interruptSignal: flag });
  assert.equal(r._isAborted(), false);
  flag.interrupted = true;
  await sleep(700);
  assert.equal(r.parentAbort.signal.aborted, true, 'a mid-stream interrupt must cut the provider stream, not wait for round end');
  assert.equal(r.parentAbort.signal.reason, 'interrupt');
});

test('an already-aborted parent stops the poll instead of firing a spurious interrupt', async () => {
  const flag = { interrupted: true };
  const r = setupAbortCascade({ options: {}, interruptSignal: flag });
  r.parentAbort.abort('user cancelled first');
  await sleep(700);
  assert.equal(r.parentAbort.signal.reason, 'user cancelled first', 'the real reason wins over the poll');
});

test('two siblings of the same parent both die on one parent abort', () => {
  const r = setupAbortCascade({ options: {} });
  const a = r._createSiblingAbort();
  const b = r._createSiblingAbort();
  r.parentAbort.abort('whole-session cancel');
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, true);
  assert.notEqual(a.signal, b.signal);
});

test('no interruptSignal means no poll at all', async () => {
  const r = setupAbortCascade({ options: {} });
  await sleep(50);
  assert.equal(r._isAborted(), false);
});
