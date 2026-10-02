'use strict';

/**
 * Colocated contract test for monitorState.js (per-run auxiliary state bootstrap).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 *
 * Every service module arrives as an injected stub, so nothing here touches disk
 * or the real monitors.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLoopMonitorStates } = require('./monitorState');

function stub(on = true) {
  return {
    isEnabled: () => on,
    createState: () => ({ tag: 'state', created: true }),
  };
}

const BASE_DEPS = () => ({
  chatOpts: {},
  userMessage: 'do the thing',
  initialMessages: [{ role: 'user', content: 'do the thing' }],
  courseMonitor: stub(),
  adaptiveExec: stub(),
  promptRounds: {
    isEnabled: () => true,
    priorUserTextsFrom: (msgs) => msgs.filter((m) => m.role === 'user').map((m) => m.content),
    countRound: (msg, prior) => prior.length,
  },
  fpfGuard: {
    isEnabled: () => true,
    createState: () => ({ bugfixIntent: false }),
    looksLikeBugfixTask: () => true,
  },
  actionAttribution: { createAttributionState: () => ({ claims: [] }) },
});

test('all five handles created for a top-level run with every service enabled', () => {
  const r = createLoopMonitorStates(BASE_DEPS());
  assert.deepEqual(Object.keys(r).sort(), [
    'attributionState',
    'courseState',
    'fpfState',
    'promptRound',
    'reflectState',
  ]);
  assert.deepEqual(r.courseState, { tag: 'state', created: true });
  assert.deepEqual(r.reflectState, { tag: 'state', created: true });
  assert.deepEqual(r.attributionState, { claims: [] });
  assert.equal(r.fpfState.bugfixIntent, true, 'the bugfix latch is stamped onto the state');
  assert.equal(r.promptRound, 1);
});

test('sub-agents get suppression on four of five — attribution is the documented exception', () => {
  const deps = { ...BASE_DEPS(), chatOpts: { _isSubagent: true } };
  const r = createLoopMonitorStates(deps);
  assert.equal(r.courseState, null);
  assert.equal(r.reflectState, null);
  assert.equal(r.fpfState, null);
  assert.equal(r.promptRound, 1, 'suppressed rounds fall back to round 1, not 0');
  assert.deepEqual(r.attributionState, { claims: [] }, 'a sub-agent still claims its own writes/deletes');
});

test('a disabled service yields null rather than a half-built state', () => {
  const deps = {
    ...BASE_DEPS(),
    courseMonitor: stub(false),
    adaptiveExec: stub(false),
    fpfGuard: { ...BASE_DEPS().fpfGuard, isEnabled: () => false },
    promptRounds: { ...BASE_DEPS().promptRounds, isEnabled: () => false },
  };
  const r = createLoopMonitorStates(deps);
  assert.equal(r.courseState, null);
  assert.equal(r.reflectState, null);
  assert.equal(r.fpfState, null);
  assert.equal(r.promptRound, 1);
});

test('absent modules are null, never a thrown TypeError', () => {
  const r = createLoopMonitorStates({ chatOpts: {}, userMessage: 'x', initialMessages: [] });
  assert.equal(r.courseState, null);
  assert.equal(r.reflectState, null);
  assert.equal(r.attributionState, null);
  assert.equal(r.fpfState, null);
  assert.equal(r.promptRound, 1);
});

test('fpf service throwing is swallowed → null (fail-soft by contract)', () => {
  const deps = {
    ...BASE_DEPS(),
    fpfGuard: {
      isEnabled: () => true,
      createState: () => {
        throw new Error('guard module broken');
      },
      looksLikeBugfixTask: () => true,
    },
  };
  assert.equal(createLoopMonitorStates(deps).fpfState, null);
});

test('a throwing looksLikeBugfixTask also lands in the same catch → null', () => {
  const deps = {
    ...BASE_DEPS(),
    fpfGuard: {
      isEnabled: () => true,
      createState: () => ({ bugfixIntent: false }),
      looksLikeBugfixTask: () => {
        throw new Error('classifier regex blew up');
      },
    },
  };
  assert.equal(createLoopMonitorStates(deps).fpfState, null);
});

test('promptRound throwing is swallowed → 1', () => {
  const deps = {
    ...BASE_DEPS(),
    promptRounds: {
      isEnabled: () => true,
      priorUserTextsFrom: () => {
        throw new Error('history malformed');
      },
      countRound: () => 7,
    },
  };
  assert.equal(createLoopMonitorStates(deps).promptRound, 1);
});

test('the round count is computed from the history the extractor returned', () => {
  const seen = [];
  const deps = {
    ...BASE_DEPS(),
    initialMessages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ],
    promptRounds: {
      isEnabled: () => true,
      priorUserTextsFrom: (msgs) => msgs.filter((m) => m.role === 'user').map((m) => m.content),
      countRound: (msg, prior) => {
        seen.push([msg, prior]);
        return prior.length + 1;
      },
    },
  };
  const r = createLoopMonitorStates(deps);
  assert.equal(r.promptRound, 3);
  assert.deepEqual(seen[0], ['do the thing', ['a', 'c']], 'userMessage + prior user texts only');
});

test('ASYMMETRY (registered, not fixed): only fpf and promptRound are guarded — a throwing isEnabled upstream escapes', () => {
  for (const key of ['courseMonitor', 'adaptiveExec']) {
    const deps = { ...BASE_DEPS(), [key]: { isEnabled: () => { throw new Error(key + ' broken'); }, createState: () => ({}) } };
    assert.throws(() => createLoopMonitorStates(deps), new RegExp(`${key} broken`));
  }
  // The two documented fail-soft handles behave the opposite way:
  assert.equal(
    createLoopMonitorStates({
      ...BASE_DEPS(),
      fpfGuard: { isEnabled: () => { throw new Error('nope'); } },
    }).fpfState,
    null
  );
});

test('the sub-agent flag is read on the RAW chatOpts object, coerced by !!', () => {
  const truthy = createLoopMonitorStates({ ...BASE_DEPS(), chatOpts: { _isSubagent: 'yes' } });
  assert.equal(truthy.courseState, null, 'a non-empty string counts as sub-agent');
  const falsy = createLoopMonitorStates({ ...BASE_DEPS(), chatOpts: { _isSubagent: 0 } });
  assert.deepEqual(falsy.courseState, { tag: 'state', created: true });
});

test('two runs never share a state object', () => {
  const a = createLoopMonitorStates(BASE_DEPS());
  const b = createLoopMonitorStates(BASE_DEPS());
  assert.notEqual(a.courseState, b.courseState);
  assert.notEqual(a.attributionState, b.attributionState);
});
