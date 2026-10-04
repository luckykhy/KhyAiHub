'use strict';

/**
 * transactionRunner.js contract tests — the orchestrator with stubbed primitives.
 * Zero real IO: git/node/test machinery is injected, so only the flow, the event
 * stream, the fail-soft rules and the returned shape are under test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runRepairTransaction } = require('./transactionRunner');
const leaf = require('../../../selfRepairTransaction');

const OFF = { KHY_SELF_REPAIR_TRANSACTION: 'off' };
const BROKEN = [{ file: 'a.js', line: 1, message: 'syntax error' }];

function recorder() {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
}

test('a missing runFix is a specific error, not a crash', async () => {
  assert.deepEqual(await runRepairTransaction({}), {
    text: '',
    filesModified: [],
    success: false,
    error: 'no runFix injected',
  });
});

test('gate off: byte-identical passthrough — no snapshot, no transaction wrapper', async () => {
  const rec = recorder();
  let snapCalls = 0;
  const fix = { text: 'done', filesModified: ['src/a.js'], success: true };
  const out = await runRepairTransaction({
    runFix: async () => fix,
    snapshot: async () => { snapCalls += 1; return { kind: 'git', ref: 'HEAD' }; },
    onEvent: rec.onEvent,
    env: OFF,
  });
  assert.equal(out, fix, 'the very same object is returned');
  assert.equal(out.transaction, undefined, 'no annotation when the gate is off');
  assert.equal(snapCalls, 0, 'the machinery is never entered');
  assert.deepEqual(rec.events, []);
});

test('gate on, clean validation: keep, no rollback, and the documented event ladder', async () => {
  const rec = recorder();
  let restoreCalls = 0;
  const out = await runRepairTransaction({
    runFix: async () => ({ text: 'fixed', filesModified: ['src/a.js'], success: true }),
    snapshot: async () => ({ kind: 'git', ref: 'deadbeef' }),
    restore: async () => { restoreCalls += 1; return true; },
    validateFiles: async () => ({ syntax: [], guards: [], tests: { ran: false, ok: true, summary: '' } }),
    onEvent: rec.onEvent,
    env: {},
  });
  assert.equal(out.text, 'fixed', 'the fix result is preserved');
  assert.ok(out.transaction, 'transaction annotation attached');
  assert.equal(out.transaction.decision.keep, true, JSON.stringify(out.transaction.decision));
  assert.equal(out.transaction.rolledBack, null, 'a kept fix never rolls back');
  assert.equal(restoreCalls, 0);
  const types = rec.events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 4), [
    'repair_snapshot_start',
    'repair_snapshot_done',
    'repair_validate_start',
    'repair_validate_done',
  ], JSON.stringify(types));
  assert.equal(rec.events.find((e) => e.type === 'repair_snapshot_done').snapshot, true);
});

test('gate on, failing validation with a snapshot: restore is called and its answer reported', async () => {
  const seen = [];
  const out = await runRepairTransaction({
    runFix: async () => ({ text: 'x', filesModified: ['src/a.js'], success: true }),
    snapshot: async () => ({ kind: 'git', ref: 'abc123' }),
    restore: async (snap, changeSet) => { seen.push([snap, changeSet]); return true; },
    validateFiles: async () => ({ syntax: BROKEN, guards: [], tests: { ran: false, ok: true, summary: '' } }),
    env: {},
  });
  assert.equal(seen.length, 1, 'restore ran once');
  assert.deepEqual(seen[0][0], { kind: 'git', ref: 'abc123' }, 'the snapshot handle is forwarded');
  assert.ok(Array.isArray(seen[0][1].validatable), 'the classified change set is forwarded');
  assert.equal(out.transaction.decision.keep, false);
  assert.equal(out.transaction.rolledBack, true);
  assert.equal(typeof out.transaction.annotation, 'string', 'the leaf writes the human annotation');
});

test('a throwing snapshot degrades to "no rollback capability", not to failure', async () => {
  const rec = recorder();
  const out = await runRepairTransaction({
    runFix: async () => ({ text: 'x', filesModified: ['src/a.js'], success: true }),
    snapshot: async () => { throw new Error('not a git repo'); },
    validateFiles: async () => ({ syntax: [], guards: [], tests: { ran: false, ok: true, summary: '' } }),
    onEvent: rec.onEvent,
    env: {},
  });
  assert.equal(out.transaction.snapshotMissing, true);
  const errEvt = rec.events.find((e) => e.type === 'repair_snapshot_error');
  assert.match(errEvt.error, /not a git repo/);
});

test('a failing restore still completes and never rethrows', async () => {
  const rec = recorder();
  const out = await runRepairTransaction({
    runFix: async () => ({ text: 'x', filesModified: ['src/a.js'], success: true }),
    snapshot: async () => ({ kind: 'git', ref: 'r' }),
    restore: async () => false,
    validateFiles: async () => ({ syntax: BROKEN, guards: [], tests: { ran: false, ok: true, summary: '' } }),
    onEvent: rec.onEvent,
    env: {},
  });
  assert.equal(out.transaction.rolledBack, false, 'incomplete rollback is reported honestly');
  assert.ok(rec.events.some((e) => e.type === 'repair_rollback_done'));
});

test('no validatable files: early return with decision null (bytes unchanged)', async () => {
  const out = await runRepairTransaction({
    runFix: async () => ({ text: 'x', filesModified: [], success: true }),
    snapshot: async () => ({ kind: 'git', ref: 'r' }),
    validateFiles: async () => { throw new Error('must not be called'); },
    env: {},
  });
  assert.equal(out.transaction.decision, null);
  assert.ok(Array.isArray(out.transaction.changeSet.validatable));
});

test('a non-object fix result is normalised instead of spreading garbage', async () => {
  const out = await runRepairTransaction({
    runFix: async () => 'just a string',
    env: {},
  });
  assert.deepEqual(
    { text: out.text, filesModified: out.filesModified, success: out.success },
    { text: '', filesModified: [], success: false },
  );
});

test('machinery failure is fail-soft: the fix result survives, nothing rejects', async () => {
  const rec = recorder();
  const fix = { text: 'kept', filesModified: ['src/a.js'], success: true };
  const out = await runRepairTransaction({
    runFix: async () => fix,
    snapshot: async () => ({ kind: 'git', ref: 'r' }),
    validateFiles: async () => { throw new Error('probe exploded'); },
    onEvent: rec.onEvent,
    env: {},
  });
  assert.equal(out, fix, 'the possibly-correct fix is never discarded because the checker broke');
  assert.equal(out.transaction, undefined);
  assert.match(rec.events.find((e) => e.type === 'repair_error').error, /probe exploded/);
});

test('a hostile onEvent listener cannot break the transaction', async () => {
  const out = await runRepairTransaction({
    runFix: async () => ({ text: 'x', filesModified: [], success: true }),
    onEvent: () => { throw new Error('listener bug'); },
    env: {},
  });
  assert.equal(out.text, 'x');
});

test('the gate is on by default (documented default-on behaviour)', async () => {
  assert.equal(leaf.planTransaction({}, {}).enabled, true, 'baseline for the cases above');
  let touched = 0;
  await runRepairTransaction({
    runFix: async () => ({ text: 'x', filesModified: ['src/a.js'], success: true }),
    snapshot: async () => { touched += 1; return null; },
    validateFiles: async () => ({ syntax: [], guards: [], tests: { ran: false, ok: true, summary: '' } }),
    env: {},
  });
  assert.equal(touched, 1, 'with no env the machinery does run');
});
