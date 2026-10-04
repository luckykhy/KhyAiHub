'use strict';

/**
 * Colocated contract test for loopObservability.js (shadow FSM + fork wrapper).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupLoopObservability } = require('./loopObservability');

function makeFsm(initial) {
  return { name: 'toolLoop', onStateChange: initial || undefined, fire: null };
}

test('the bag exposes the four documented handles', () => {
  const seen = [];
  const r = setupLoopObservability({
    onPhase: (p) => seen.push(p),
    createLoopFsm: (name) => {
      assert.equal(name, 'toolLoop');
      return makeFsm();
    },
  });
  assert.deepEqual(Object.keys(r).sort(), ['emitLoopPhaseEvent', 'iterationRef', 'loopFsm', 'wrapForkPhase']);
  assert.equal(r.loopFsm.name, 'toolLoop');
  assert.deepEqual(r.iterationRef, { current: 0 });
});

test('a null FSM (fail-soft creation) still yields working observers', () => {
  const seen = [];
  const r = setupLoopObservability({ onPhase: (p) => seen.push(p), createLoopFsm: () => null });
  assert.equal(r.loopFsm, null);
  assert.equal(typeof r.emitLoopPhaseEvent, 'function');
  r.emitLoopPhaseEvent({ kind: 'x' });
  assert.deepEqual(seen, [{ kind: 'x' }]);
});

test('without an onPhase callback there is no emit port at all', () => {
  const r = setupLoopObservability({ onPhase: undefined, createLoopFsm: () => makeFsm() });
  assert.equal(r.emitLoopPhaseEvent, null);
  assert.equal(r.loopFsm.onStateChange, undefined, 'no hook is bolted onto a listener-less caller');
});

test('the state-change hook reports the LIVE iteration counter, not a snapshot', () => {
  const seen = [];
  const r = setupLoopObservability({ onPhase: (p) => seen.push(p), createLoopFsm: () => makeFsm() });
  r.loopFsm.onStateChange('idle', 'thinking', 'start');
  r.iterationRef.current = 7;
  r.loopFsm.onStateChange('thinking', 'tool', 'call');
  assert.equal(seen[0].iteration, 0);
  assert.equal(seen[1].iteration, 7, 'the loop mutates _iterationRef.current each round and the hook must follow');
  assert.deepEqual([seen[1].from, seen[1].to, seen[1].event], ['thinking', 'tool', 'call']);
  assert.equal(typeof seen[1].at, 'number');
});

test('a previously attached hook (attachDebugLog) keeps running, first, with the same args', () => {
  const order = [];
  const prevMeta = { meta: 1 };
  const fsm = makeFsm((from, to, event, meta) => order.push(['prev', from, to, event, meta]));
  const r = setupLoopObservability({
    onPhase: () => order.push(['onPhase']),
    createLoopFsm: () => fsm,
  });
  r.loopFsm.onStateChange('a', 'b', 'e', prevMeta);
  assert.deepEqual(order, [['prev', 'a', 'b', 'e', prevMeta], ['onPhase']]);
});

test('a throwing previous hook does not stop the new observer', () => {
  const seen = [];
  const fsm = makeFsm(() => {
    throw new Error('debug logger died');
  });
  const r = setupLoopObservability({ onPhase: (p) => seen.push(p), createLoopFsm: () => fsm });
  assert.doesNotThrow(() => r.loopFsm.onStateChange('a', 'b', 'e', null));
  assert.equal(seen.length, 1);
});

test('a throwing observer never breaks the loop', () => {
  const fsm = makeFsm();
  const r = setupLoopObservability({
    onPhase: () => {
      throw new Error('observer died');
    },
    createLoopFsm: () => fsm,
  });
  assert.doesNotThrow(() => r.loopFsm.onStateChange('a', 'b', 'e', null));
});

test('emitLoopPhaseEvent swallows observer throws as well', () => {
  const r = setupLoopObservability({
    onPhase: () => {
      throw new Error('nope');
    },
    createLoopFsm: () => makeFsm(),
  });
  assert.doesNotThrow(() => r.emitLoopPhaseEvent({ kind: 'fork' }));
});

test('wrapForkPhase passes through untouched when there is nothing to emit or nothing to wrap', () => {
  const handler = async () => 'ok';
  const noEmit = setupLoopObservability({ onPhase: undefined, createLoopFsm: () => makeFsm() });
  assert.equal(noEmit.wrapForkPhase(handler), handler);
  const r = setupLoopObservability({ onPhase: () => {}, createLoopFsm: () => makeFsm() });
  for (const bad of [undefined, null, 'not-a-function', 42]) {
    assert.equal(r.wrapForkPhase(bad), bad);
  }
});

test('a permission fork is labelled by subtype, everything else is ask_user', async () => {
  const seen = [];
  const r = setupLoopObservability({ onPhase: (p) => seen.push(p), createLoopFsm: () => makeFsm() });
  const wrapped = r.wrapForkPhase(async () => 'done');
  assert.equal(await wrapped({ request: { subtype: 'can_use_tool' } }), 'done');
  assert.equal(seen[0].kind, 'fork');
  assert.equal(seen[0].fork, 'permission');
  assert.equal(seen[1].kind, 'fork_clear');

  seen.length = 0;
  await wrapped({ request: { subtype: 'ask_user_question' } });
  assert.equal(seen[0].fork, 'ask_user');

  seen.length = 0;
  await wrapped({});
  assert.equal(seen[0].fork, 'ask_user', 'a request without subtype is treated as a question fork');
  seen.length = 0;
  await wrapped(undefined);
  assert.equal(seen[0].kind, 'fork', 'a missing control request still opens and clears the fork');
  assert.equal(seen[1].kind, 'fork_clear');
});

test('fork_clear is emitted even when the handler rejects, and the rejection still propagates', async () => {
  const seen = [];
  const r = setupLoopObservability({ onPhase: (p) => seen.push(p), createLoopFsm: () => makeFsm() });
  const wrapped = r.wrapForkPhase(async () => {
    throw new Error('approval channel closed');
  });
  await assert.rejects(() => wrapped({ request: { subtype: 'can_use_tool' } }), /approval channel closed/);
  assert.deepEqual(seen.map((p) => p.kind), ['fork', 'fork_clear']);
});

test('the fork pair wraps every await of the same handler, in order', async () => {
  const seen = [];
  const r = setupLoopObservability({ onPhase: (p) => seen.push(p.kind), createLoopFsm: () => makeFsm() });
  const wrapped = r.wrapForkPhase(async () => {
    seen.push('handler');
    return 1;
  });
  await wrapped({ request: { subtype: 'can_use_tool' } });
  assert.deepEqual(seen, ['fork', 'handler', 'fork_clear']);
});
