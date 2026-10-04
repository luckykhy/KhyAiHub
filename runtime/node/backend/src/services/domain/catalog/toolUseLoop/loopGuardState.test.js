'use strict';

/**
 * Colocated contract test for loopGuardState.js (47 pre-loop guard bindings).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLoopGuardState } = require('./loopGuardState');

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

const KEYS = [
  'executionPlan', 'currentPlanStep', 'noToolNudgeUsed', '_codingVerifyNudgeUsed',
  '_verificationNudgeUsed', '_execComplexityEscalated', '_deliveryConclusionNudgeUsed',
  '_resultGuardNoticeUsed', '_intentCoverageNudgeUsed', '_errorCoverageNudgeUsed',
  '_followThroughNudgeUsed', '_failureRecoveryNudgeUsed', '_unfulfilledIntentNudges',
  '_unknownProbesUsed', '_pseudoRefusalNudgeUsed', '_stallNudgeUsed', '_stallNudgeMax',
  '_bareRefusalRetries', '_bareRefusalRetryMax', '_lastRefusalSig', '_repetitionRetries',
  '_repetitionRetryMax', '_lastRepetitionSig', '_streamRepGuard', '_streamRepetitionTripped',
  '_uphSanitizeUsed', '_allModifiedFiles', '_selfEditAdvised', '_weakModelAdvised',
  '_verifyGateRounds', '_verifyGateExhausted', '_nonEditVerifyRounds',
  '_stopReasonRecoveryUsed', '_coherenceGateRounds', '_coherenceGateExhausted',
  '_closureGuardCount', '_lastClosureSig', '_kickoffGuardCount', '_lastKickoffSig',
  '_goalStopRedrives', '_lastGoalStopSig', '_parseErrorRetried', '_auditFixDone',
  '_auditFixAnnotation', '_taskClosureRedrives', '_lastTaskClosureSig',
  '_taskClosurePartialNote',
];

test('the bag exposes exactly the documented 47 bindings', () => {
  const s = createLoopGuardState();
  assert.deepEqual(Object.keys(s).sort(), [...KEYS].sort());
  assert.equal(Object.keys(s).length, 47);
});

test('every counter starts at 0 and every one-shot flag at false', () => {
  const s = createLoopGuardState();
  for (const k of [
    'currentPlanStep', '_unfulfilledIntentNudges', '_unknownProbesUsed', '_stallNudgeUsed',
    '_bareRefusalRetries', '_repetitionRetries', '_verifyGateRounds', '_nonEditVerifyRounds',
    '_coherenceGateRounds', '_closureGuardCount', '_kickoffGuardCount', '_goalStopRedrives',
    '_taskClosureRedrives',
  ]) {
    assert.equal(s[k], 0, k);
  }
  for (const k of [
    'noToolNudgeUsed', '_codingVerifyNudgeUsed', '_verificationNudgeUsed',
    '_execComplexityEscalated', '_deliveryConclusionNudgeUsed', '_resultGuardNoticeUsed',
    '_intentCoverageNudgeUsed', '_errorCoverageNudgeUsed', '_followThroughNudgeUsed',
    '_failureRecoveryNudgeUsed', '_pseudoRefusalNudgeUsed', '_verifyGateExhausted',
    '_stopReasonRecoveryUsed', '_coherenceGateExhausted', '_uphSanitizeUsed',
    '_streamRepetitionTripped', '_parseErrorRetried', '_auditFixDone',
  ]) {
    assert.equal(s[k], false, k);
  }
});

test('the signature trackers, plan and annotation start empty rather than undefined', () => {
  const s = createLoopGuardState();
  assert.equal(s.executionPlan, null);
  assert.equal(s._lastRefusalSig, null);
  assert.equal(s._lastRepetitionSig, null);
  assert.equal(s._streamRepGuard, null);
  assert.equal(s._lastClosureSig, null);
  assert.equal(s._lastKickoffSig, null);
  assert.equal(s._lastGoalStopSig, null);
  assert.equal(s._lastTaskClosureSig, null);
  assert.equal(s._auditFixAnnotation, '');
  assert.equal(s._taskClosurePartialNote, '');
});

test('the three accumulators are real empty Sets, distinct per call', () => {
  const a = createLoopGuardState();
  const b = createLoopGuardState();
  for (const k of ['_allModifiedFiles', '_selfEditAdvised', '_weakModelAdvised']) {
    assert.ok(a[k] instanceof Set, k);
    assert.equal(a[k].size, 0, k);
    assert.notEqual(a[k], b[k], `${k} must not be shared across runs`);
  }
  a._allModifiedFiles.add('x');
  assert.equal(b._allModifiedFiles.size, 0);
});

test('caps default to 2 / 2 / 1 when the env vars are absent', () => {
  const s = withEnv('KHY_TOOL_LOOP_STALL_NUDGES', undefined, () =>
    withEnv('KHY_TOOL_LOOP_REFUSAL_RETRIES', undefined, () =>
      withEnv('KHY_TOOL_LOOP_REPETITION_RETRIES', undefined, () => createLoopGuardState())
    )
  );
  assert.equal(s._stallNudgeMax, 2);
  assert.equal(s._bareRefusalRetryMax, 2);
  assert.equal(s._repetitionRetryMax, 1);
});

test('stall nudges are clamped to [1,2]: 0 still nudges once, 9 cannot runaway', () => {
  for (const [v, expected] of [['0', 1], ['1', 1], ['2', 2], ['3', 2], ['99', 2]]) {
    const got = withEnv('KHY_TOOL_LOOP_STALL_NUDGES', v, () => createLoopGuardState()._stallNudgeMax);
    assert.equal(got, expected, `KHY_TOOL_LOOP_STALL_NUDGES=${v}`);
  }
});

test('refusal retries allow zero but cap at 3', () => {
  for (const [v, expected] of [['0', 0], ['1', 1], ['3', 3], ['9', 3]]) {
    const got = withEnv('KHY_TOOL_LOOP_REFUSAL_RETRIES', v, () => createLoopGuardState()._bareRefusalRetryMax);
    assert.equal(got, expected, `KHY_TOOL_LOOP_REFUSAL_RETRIES=${v}`);
  }
});

test('repetition retries allow zero but cap at 3', () => {
  for (const [v, expected] of [['0', 0], ['2', 2], ['9', 3]]) {
    const got = withEnv('KHY_TOOL_LOOP_REPETITION_RETRIES', v, () => createLoopGuardState()._repetitionRetryMax);
    assert.equal(got, expected, `KHY_TOOL_LOOP_REPETITION_RETRIES=${v}`);
  }
});

test('garbage env values fall back to the documented default, not NaN', () => {
  const s = withEnv('KHY_TOOL_LOOP_STALL_NUDGES', 'abc', () =>
    withEnv('KHY_TOOL_LOOP_REFUSAL_RETRIES', '', () =>
      withEnv('KHY_TOOL_LOOP_REPETITION_RETRIES', '2x', () => createLoopGuardState())
    )
  );
  // parseInt('2x') === 2 — a leading number is honoured, only full NaN falls back.
  assert.equal(s._stallNudgeMax, 2);
  assert.equal(s._bareRefusalRetryMax, 2);
  assert.equal(s._repetitionRetryMax, 2);
});

test('negative env values clamp to the floor (stall 1, others 0)', () => {
  const s = withEnv('KHY_TOOL_LOOP_STALL_NUDGES', '-5', () =>
    withEnv('KHY_TOOL_LOOP_REFUSAL_RETRIES', '-5', () =>
      withEnv('KHY_TOOL_LOOP_REPETITION_RETRIES', '-5', () => createLoopGuardState())
    )
  );
  assert.equal(s._stallNudgeMax, 1);
  assert.equal(s._bareRefusalRetryMax, 0);
  assert.equal(s._repetitionRetryMax, 0);
});
