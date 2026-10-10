'use strict';

// Unit-level contract tests for core/coreActions.js (co-located, per [RESEARCH-018] §2.3).
// These are the official-core handlers: pure, side-effect-free, and stamped
// origin:'official_core'. The contracts worth locking are (a) the frozen surface (红线5 —
// the official source itself must not be mutable), (b) the defensive `action && … && …`
// extraction that yields '' rather than throwing on missing/malformed input, and (c) the
// CORE_ENTRY_POINTS compatibility contract that updateGuard diffs against. No IO, no env.

const test = require('node:test');
const assert = require('node:assert/strict');

const { CORE_ACTIONS, CORE_ENTRY_POINTS } = require('./coreActions');

test('CORE_ACTIONS is a frozen object exposing exactly the three documented handlers', () => {
  assert.equal(Object.isFrozen(CORE_ACTIONS), true, '红线5: the official core map must be immutable');
  assert.deepEqual(Object.keys(CORE_ACTIONS).sort(), ['noop', 'read_file', 'say']);
  for (const name of Object.keys(CORE_ACTIONS)) {
    assert.equal(typeof CORE_ACTIONS[name], 'function', `${name} must be callable`);
  }
});

test('say extracts params.text and always stamps origin official_core', () => {
  assert.deepEqual(CORE_ACTIONS.say({ params: { text: 'hello' } }), {
    ok: true,
    kind: 'say',
    text: 'hello',
    origin: 'official_core',
  });
});

test('say coerces a non-string text and falls back to empty string on any missing shape', () => {
  assert.equal(CORE_ACTIONS.say({ params: { text: 42 } }).text, '42');
  assert.equal(CORE_ACTIONS.say({ params: { text: 'x' } }).text, 'x');
  assert.equal(CORE_ACTIONS.say().text, '', 'no action at all must not throw');
  assert.equal(CORE_ACTIONS.say({}).text, '');
  assert.equal(CORE_ACTIONS.say({ params: {} }).text, '');
  assert.equal(CORE_ACTIONS.say(null).text, '');
  assert.equal(CORE_ACTIONS.say({ params: { text: '' } }).text, '');
  assert.equal(CORE_ACTIONS.say({ params: { text: 0 } }).text, '', 'falsy 0 falls through the ||');
});

test('read_file extracts params.path with the same defensive fallback', () => {
  assert.deepEqual(CORE_ACTIONS.read_file({ params: { path: 'a/b.js' } }), {
    ok: true,
    kind: 'read_file',
    path: 'a/b.js',
    origin: 'official_core',
  });
  assert.equal(CORE_ACTIONS.read_file().path, '');
  assert.equal(CORE_ACTIONS.read_file({ params: { path: 7 } }).path, '7');
});

test('noop ignores its arguments and returns a well-formed no-op', () => {
  const r = CORE_ACTIONS.noop();
  assert.deepEqual(r, { ok: true, kind: 'noop', origin: 'official_core' });
  // Passing junk must be ignored, not throw.
  assert.equal(CORE_ACTIONS.noop({ params: { boom: () => {} } }).kind, 'noop');
});

test('none of the core handlers mutate their input action', () => {
  const action = { type: 'say', params: { text: 'keep' } };
  const frozen = JSON.parse(JSON.stringify(action));
  CORE_ACTIONS.say(action);
  CORE_ACTIONS.read_file(action);
  CORE_ACTIONS.noop(action);
  assert.deepEqual(action, frozen);
});

test('CORE_ENTRY_POINTS is a frozen array of the documented stable slots', () => {
  assert.equal(Object.isFrozen(CORE_ENTRY_POINTS), true);
  assert.deepEqual(CORE_ENTRY_POINTS, [
    'registerOverride',
    'registerAction',
    'action.params',
    'action.type',
  ]);
});
