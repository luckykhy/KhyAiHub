'use strict';

// Unit-level contract tests for degradeStateMachine.js (co-located, per [RESEARCH-018] §2.3).
// decideFlow is a TOTAL function over (resolution, action): every input maps to one of the
// two states and it is defined for missing/odd inputs — this is the substance of 红线3
// (no branch may white-screen) and 红线2 (unknown ⇒ explicit placeholder + hand back
// control). The real behavior to lock is the PROCEED-vs-MANUAL_CONFIRM decision rule:
// PROCEED requires BOTH isKnown === true AND a function handler; everything else degrades.

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideFlow, STATES } = require('./degradeStateMachine');
const { buildUnknownActionPlaceholder } = require('./unknownActionView');

test('STATES is a frozen two-state enum with self-matching values', () => {
  assert.deepEqual(STATES, { PROCEED: 'PROCEED', MANUAL_CONFIRM: 'MANUAL_CONFIRM' });
  assert.equal(Object.isFrozen(STATES), true);
});

const fn = () => 'x';

test('a known resolution with a function handler PROCEEDs with control=auto', () => {
  const action = { type: 'say', params: {} };
  const flow = decideFlow({ isKnown: true, handler: fn, origin: 'core' }, action);
  assert.equal(flow.state, STATES.PROCEED);
  assert.equal(flow.control, 'auto');
  assert.equal(flow.handler, fn);
  assert.equal(flow.action, action, 'action is passed through by reference');
  assert.equal(flow.placeholder, null);
  assert.equal(flow.message, null);
  assert.equal(flow.origin, 'core');
});

test('origin is carried verbatim on the PROCEED path (override vs core)', () => {
  assert.equal(decideFlow({ isKnown: true, handler: fn, origin: 'override' }, {}).origin, 'override');
});

test('a known resolution whose handler is NOT a function degrades to MANUAL_CONFIRM', () => {
  // This is the guard `res.isKnown && typeof res.handler === 'function'` — a handler
  // slot that is truthy but not callable must not PROCEED.
  const flow = decideFlow({ isKnown: true, handler: null, origin: 'core' }, { type: 'say' });
  assert.equal(flow.state, STATES.MANUAL_CONFIRM);
  assert.equal(flow.control, 'human');
  assert.equal(flow.handler, null);
  assert.equal(flow.origin, 'unknown', 'degraded flow always reports origin unknown');
});

test('an unknown resolution degrades to MANUAL_CONFIRM with a real placeholder', () => {
  const action = { type: 'ghost', _raw: { z: 1 } };
  const flow = decideFlow({ isKnown: false, handler: null, origin: 'unknown' }, action);
  assert.equal(flow.state, STATES.MANUAL_CONFIRM);
  assert.equal(flow.control, 'human');
  assert.deepEqual(flow.placeholder, buildUnknownActionPlaceholder(action));
  assert.equal(flow.message, flow.placeholder.message, 'message mirrors the placeholder');
  assert.equal(flow.action, action);
  assert.equal(flow.handler, null);
});

test('a missing/undefined resolution falls back to the unknown default (never throws)', () => {
  // Defensive default: `resolution || { isKnown:false, handler:null, origin:'unknown' }`.
  for (const missing of [undefined, null]) {
    const flow = decideFlow(missing, { type: 'say' });
    assert.equal(flow.state, STATES.MANUAL_CONFIRM);
    assert.equal(flow.control, 'human');
    assert.equal(flow.origin, 'unknown');
    assert.equal(flow.placeholder.renderable, true);
  }
});

test('isKnown true but handler provided as a non-callable object degrades', () => {
  const flow = decideFlow({ isKnown: true, handler: { not: 'callable' }, origin: 'core' }, {});
  assert.equal(flow.state, STATES.MANUAL_CONFIRM);
});

test('decideFlow never returns undefined for any resolution/action combination', () => {
  const resolutions = [undefined, null, {}, { isKnown: true }, { isKnown: true, handler: fn }];
  const actions = [undefined, null, {}, { type: 'a' }];
  for (const r of resolutions) {
    for (const a of actions) {
      const flow = decideFlow(r, a);
      assert.ok(flow, `flow must be defined for resolution=${JSON.stringify(r)}`);
      assert.ok(
        flow.state === STATES.PROCEED || flow.state === STATES.MANUAL_CONFIRM,
        'state is always one of the two enum members',
      );
      assert.ok(flow.control === 'auto' || flow.control === 'human');
    }
  }
});
