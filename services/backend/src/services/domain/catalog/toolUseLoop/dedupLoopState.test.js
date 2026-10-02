'use strict';

/**
 * Colocated contract test for dedupLoopState.js (pre-loop value initialization).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDedupLoopState } = require('./dedupLoopState');

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

test('_isFailedToolResult only reports failure on an explicit success:false', () => {
  const s = createDedupLoopState();
  const p = s._isFailedToolResult;
  assert.equal(p({ success: false }), true);
  assert.equal(p({ success: true }), false);
  assert.equal(p({ success: undefined }), false, 'absent success is NOT a failure');
  assert.equal(p({}), false);
  assert.equal(p(null), false);
  assert.equal(p(undefined), false);
  assert.equal(p('throw'), false, 'a string is not an object');
  assert.equal(p(42), false);
  assert.equal(p([]), false, 'an array carries no success:false');
});

test('no inheritance = empty maps and zeroed counters', () => {
  const s = createDedupLoopState();
  assert.ok(s.executedCallKeys instanceof Map);
  assert.equal(s.executedCallKeys.size, 0);
  assert.ok(s.fileReadHashes instanceof Map);
  assert.equal(s.fileReadHashes.size, 0);
  assert.equal(s.consecutiveDedupIterations, 0);
  assert.deepEqual(s._repeatCallStreak, { key: null, count: 0 });
  assert.deepEqual(s._streamedAnswerFps, []);
  assert.equal(s._autoWebSearchInjectedThisTurn, false);
  assert.equal(s._shortStopContinuationUsed, false);
  assert.equal(s._lengthAutoContinueUsed, 0);
  assert.equal(s._lengthRecoveryExhausted, false);
  assert.equal(s._LENGTH_AUTO_CONTINUE_MAX, 2);
});

test('inheritance keeps only reusable SUCCESS results', () => {
  const inherited = new Map([
    ['ok', { result: { success: true, text: 'x' }, count: 1 }],
    ['failed', { result: { success: false, error: 'boom' }, count: 1 }],
    ['bare-intent', { result: null, count: 1 }],
    ['no-result-key', { count: 2 }],
  ]);
  const s = createDedupLoopState({ inheritedDedupKeys: inherited });
  assert.deepEqual([...s.executedCallKeys.keys()], ['ok'], 'failures and bare markers stay retryable');
  assert.equal(s.executedCallKeys.get('ok').count, 1);
});

test('a success result of 0 / empty string still inherits (the test is `!= null`, not truthiness)', () => {
  const inherited = new Map([
    ['zero', { result: 0 }],
    ['empty', { result: '' }],
    ['nulish', { result: undefined }],
  ]);
  const s = createDedupLoopState({ inheritedDedupKeys: inherited });
  assert.deepEqual([...s.executedCallKeys.keys()].sort(), ['empty', 'zero']);
});

test('non-Map / empty inheritance is ignored instead of throwing', () => {
  for (const bad of [null, undefined, {}, [], 'map', 42]) {
    const s = createDedupLoopState({ inheritedDedupKeys: bad });
    assert.equal(s.executedCallKeys.size, 0);
  }
});

test('inherited entries are copied into a NEW map — the caller map is never mutated', () => {
  const inherited = new Map([['k', { result: { success: true } }]]);
  const s = createDedupLoopState({ inheritedDedupKeys: inherited });
  s.executedCallKeys.set('extra', { result: { success: true } });
  assert.equal(inherited.size, 1, 'seed map keeps its own size');
  assert.equal(s.executedCallKeys.size, 2);
});

test('KHY_LENGTH_TRUNCATION_AUTO_CONTINUE: default on, four off-tokens only', () => {
  const cases = [
    [undefined, true],
    ['', true],
    ['1', true],
    ['on', true],
    ['0', false],
    ['false', false],
    ['off', false],
    ['no', false],
    [' OFF ', false],
    ['False', false],
  ];
  for (const [value, expected] of cases) {
    const got = withEnv('KHY_LENGTH_TRUNCATION_AUTO_CONTINUE', value, () => createDedupLoopState()._lengthAutoContinueEnabled);
    assert.equal(got, expected, `value=${JSON.stringify(value)} → ${expected}`);
  }
});

test('each call returns fresh closures/containers — no state bleeds between runs', () => {
  const a = createDedupLoopState();
  const b = createDedupLoopState();
  assert.notEqual(a.executedCallKeys, b.executedCallKeys);
  assert.notEqual(a._repeatCallStreak, b._repeatCallStreak);
  assert.notEqual(a._streamedAnswerFps, b._streamedAnswerFps);
  a._streamedAnswerFps.push('fp');
  a._repeatCallStreak.count = 9;
  assert.deepEqual(b._streamedAnswerFps, []);
  assert.equal(b._repeatCallStreak.count, 0);
});
