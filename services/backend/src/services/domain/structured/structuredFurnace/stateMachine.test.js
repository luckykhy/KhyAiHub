'use strict';

/**
 * stateMachine.test.js — co-located unit test for stateMachine.js (D2 unit
 * structuredFurnace). Pure node:test, synchronous, zero I/O.
 *
 * RUNTIME-003 note: this file (and the whole unit) contains no `await`, no
 * `setTimeout` and no Promise — every transition is applied eagerly, so there is
 * no hard wall-clock timeout to drive by events here. Verified by grep over the
 * directory.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { StateMachine, STATE_STATUS } = require('./stateMachine');

function chain(...uids) {
  const m = new StateMachine();
  uids.forEach((u) => m.addState({ uid: u, name: u }));
  for (let i = 1; i < uids.length; i++) {
    m.addTransition(uids[i - 1], uids[i], 'next');
  }
  return m;
}

test('module surface is the class plus the frozen status enum', () => {
  assert.deepEqual(Object.keys(require('./stateMachine')), ['StateMachine', 'STATE_STATUS']);
  assert.ok(Object.isFrozen(STATE_STATUS));
  assert.deepEqual([...STATE_STATUS], ['PENDING', 'ACTIVE', 'DONE', 'BLOCKED', 'CONFLICT']);
});

test('a fresh machine is empty and has no initial', () => {
  const m = new StateMachine();
  assert.deepEqual(m.states.size, 0);
  assert.equal(m.initial, null);
  assert.equal(m.hasContradictions(), false);
  assert.equal(m.stateCount(), 0);
  assert.equal(m.transitionCount(), 0);
  assert.deepEqual(m.unreachableStates(), []);
  assert.deepEqual(m.matrix(), {});
});

test('addState requires a uid and defaults status to PENDING', () => {
  const m = new StateMachine();
  assert.throws(() => m.addState(null), /state\.uid required/);
  assert.throws(() => m.addState({}), /state\.uid required/);
  assert.throws(() => m.addState({ uid: '' }), /state\.uid required/);
  assert.equal(m.addState({ uid: 'a', name: 'A' }), 'a');
  assert.deepEqual(m.states.get('a'), { status: 'PENDING', uid: 'a', name: 'A' });
});

test('a status outside the enum is coerced to PENDING instead of rejected', () => {
  const m = new StateMachine();
  m.addState({ uid: 'a', status: 'WAT' });
  m.addState({ uid: 'b', status: null });
  m.addState({ uid: 'c', status: '' });
  assert.equal(m.states.get('a').status, 'PENDING');
  assert.equal(m.states.get('b').status, 'PENDING');
  assert.equal(m.states.get('c').status, 'PENDING');
});

test('a legal status is kept verbatim', () => {
  const m = new StateMachine();
  for (const s of STATE_STATUS) {
    m.addState({ uid: `s-${s}`, status: s });
    assert.equal(m.states.get(`s-${s}`).status, s);
  }
});

test('the first added state becomes initial automatically', () => {
  const m = new StateMachine();
  m.addState({ uid: 'a' });
  m.addState({ uid: 'b' });
  assert.equal(m.initial, 'a');
});

test('setInitial moves it, and only knows registered states', () => {
  const m = chain('a', 'b');
  m.setInitial('b');
  assert.equal(m.initial, 'b');
  assert.throws(() => m.setInitial('ghost'), /stateMachine\.setInitial: unknown state ghost/);
  assert.throws(() => m.setInitial(null), /unknown state/);
});

test('addTransition requires both endpoints and defaults the event to next', () => {
  const m = chain('a', 'b');
  assert.throws(() => m.addTransition('a', 'z', 'x'), /endpoint not found \(a -> z\)/);
  assert.throws(() => m.addTransition('z', 'b', 'x'), /endpoint not found/);
  m.addTransition('a', 'b');
  assert.deepEqual(m.transitions[m.transitionCount() - 1], { from: 'a', to: 'b', on: 'next', confidence: 1 });
});

test('falsy event names all collapse to the literal "next"', () => {
  const m = chain('a', 'b');
  const before = m.transitionCount();
  for (const ev of ['', 0, null, undefined, false]) {
    m.addTransition('a', 'b', ev);
  }
  assert.deepEqual(m.transitions.slice(before).map((t) => t.on), ['next', 'next', 'next', 'next', 'next']);
});

test('a truthy guard is stored, a falsy guard omits the key', () => {
  const m = chain('a', 'b');
  m.addTransition('a', 'b', 'g1', { guard: () => true });
  m.addTransition('a', 'b', 'g2', { guard: false });
  assert.equal(typeof m.transitions[1].guard, 'function');
  assert.equal('guard' in m.transitions[2], false);
});

// B31-F8: `typeof opts.confidence === 'number'` is the only validation, so the
// default of 1 (full trust) is what a malformed value gets. A numeric STRING —
// exactly what JSON round-tripping or a CLI/env value produces — is discarded and
// replaced by confidence 1, i.e. the machine silently becomes MORE trusting on bad
// input; and NaN passes the typeof gate, then serializes to `null` through
// toJSON()/JSON, so `Math.min(...)` consumers (skeletonReconstructor.js:112) go NaN.
test('B31-F8 confidence is fail-open: "0.5" becomes 1, NaN is accepted (current, wrong)', () => {
  const m = chain('a', 'b');
  m.addTransition('a', 'b', 'str', { confidence: '0.5' });
  m.addTransition('a', 'b', 'nan', { confidence: NaN });
  m.addTransition('a', 'b', 'inf', { confidence: Infinity });
  assert.equal(m.transitions[1].confidence, 1, 'a well-formed numeric string is thrown away');
  assert.ok(Number.isNaN(m.transitions[2].confidence), 'NaN passes the typeof number gate');
  assert.equal(m.transitions[3].confidence, Infinity);
  assert.equal(JSON.parse(JSON.stringify(m.toJSON())).transitions[2].confidence, null, 'NaN leaves the JSON contract');
});

test('contradictions are appended verbatim with a defaulted reason', () => {
  const m = chain('a', 'b');
  m.markContradiction('a', 'b', 'because');
  m.markContradiction('b', 'a');
  assert.deepEqual(m.contradictions, [
    { a: 'a', b: 'b', reason: 'because' },
    { a: 'b', b: 'a', reason: 'conflicting-requirements' },
  ]);
  assert.equal(m.hasContradictions(), true);
  assert.equal(m.contradictions.length, 2);
});

test('matrix() materializes from -> on -> to', () => {
  const m = chain('a', 'b', 'c');
  assert.deepEqual(m.matrix(), { a: { next: 'b' }, b: { next: 'c' }, c: {} });
});

// B31-F8b: matrix() is a dense lookup built by assignment, so the LAST transition
// for a (from,on) pair wins and the earlier one vanishes — while transitionCount()
// and toJSON() still report both. stateMachine.js:13-14 advertises matrix() as the
// "O(1) 状态流转" table, so a consumer using it takes a silently different branch
// than a consumer using the JSON payload.
test('B31-F8b matrix() silently drops a competing transition (current, wrong)', () => {
  const m = chain('a', 'b', 'c');
  m.addTransition('a', 'c', 'next'); // same event, different target
  assert.equal(m.transitionCount(), 3);
  assert.deepEqual(m.matrix(), { a: { next: 'c' }, b: { next: 'c' }, c: {} });
  assert.equal(m.transitions[0].to, 'b', 'the sparse list still holds the loser');
});

test('unreachableStates flags in-degree-zero states only', () => {
  const m = new StateMachine();
  ['a', 'b', 'orphan'].forEach((u) => m.addState({ uid: u }));
  m.addTransition('a', 'b', 'next');
  assert.deepEqual(m.unreachableStates(), ['orphan']);
});

// B31-F7b: the method is named "unreachableStates" (stateMachine.js:91) and sold as
// 不可达状态检测, but the body only looks at direct predecessors. A closed island is
// unreachable from `initial` and still reported as reachable, and conversely a state
// that IS reachable gets flagged the moment it has an incoming edge from anywhere —
// so the "早期信号" both misses and invents. Nothing consumes it:
// forgeSchema.validateStateMachine never calls it.
test('B31-F7b unreachableStates is in-degree, not reachability (current, wrong)', () => {
  const m = new StateMachine();
  ['a', 'b', 'c', 'd'].forEach((u) => m.addState({ uid: u }));
  m.addTransition('a', 'b', 'next');
  m.addTransition('c', 'd', 'next');
  m.addTransition('d', 'c', 'next'); // closed island, unreachable from initial 'a'
  assert.equal(m.initial, 'a');
  assert.deepEqual(m.unreachableStates(), [], 'the island is reported as reachable');
});

test('toJSON returns the documented snapshot shape', () => {
  const m = chain('a', 'b');
  m.markContradiction('a', 'b', 'r');
  const j = m.toJSON();
  assert.deepEqual(Object.keys(j), ['initial', 'states', 'transitions', 'contradictions']);
  assert.equal(j.initial, 'a');
  assert.equal(j.states.length, 2);
  assert.equal(j.transitions.length, 1);
  assert.deepEqual(j.contradictions, [{ a: 'a', b: 'b', reason: 'r' }]);
});

test('toJSON copies the arrays but aliases the state and transition objects', () => {
  const m = chain('a', 'b');
  m.markContradiction('a', 'b', 'r');
  const j = m.toJSON();
  j.states.length = 0;
  j.transitions.push({ from: 'x', to: 'y', on: 'next', confidence: 1 });
  j.contradictions.push({ a: 'x', b: 'y', reason: 'noise' });
  assert.equal(m.stateCount(), 2, 'the states ARRAY is a copy');
  assert.equal(m.transitionCount(), 1, 'the transitions ARRAY is a copy');
  assert.equal(m.contradictions.length, 1, 'the contradictions ARRAY is a copy');
  const j2 = m.toJSON();
  j2.transitions[0].to = 'zzz';
  assert.equal(m.transitions[0].to, 'zzz', 'the transition OBJECT is shared, not cloned');
  j2.states[0].status = 'DONE';
  assert.equal(m.states.get('a').status, 'DONE', 'the state OBJECT is shared, not cloned');
});

test('re-adding a uid replaces the state node', () => {
  const m = new StateMachine();
  m.addState({ uid: 'a', name: 'first' });
  m.addState({ uid: 'a', name: 'second', status: 'DONE' });
  assert.equal(m.stateCount(), 1);
  assert.deepEqual(m.states.get('a'), { status: 'DONE', uid: 'a', name: 'second' });
});
