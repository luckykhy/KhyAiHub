'use strict';

// Unit-level contract tests for predicates.js (co-located, per [RESEARCH-018] §2.3).
// The exhaustive env-value equivalence proofs live in tests/services/capabilityMatrix/
// predicates.test.js. What these tests guard instead is the failure mode that suite
// cannot see: resolveFlag()'s `default: return true` branch is a deliberate FAIL-OPEN,
// so a typo'd or unregistered `kind` in any descriptor would silently switch a gated
// capability to always-on. The cross-catalog lock below is what prevents that.

const test = require('node:test');
const assert = require('node:assert/strict');

const predicates = require('./predicates');
const { envFlagEnabled, resolveFlag } = predicates;
const canonical = require('../../../../utils/envFlagEnabled');
const { DESCRIPTORS } = require('./descriptors');

const KNOWN_KINDS = ['always', 'envFlagDefault', 'offDisables', 'zeroDisables', 'onEnables', 'module'];

test('predicates re-exports the canonical env parser by identity (no second dialect)', () => {
  assert.equal(predicates.envFlagEnabled, canonical);
  assert.equal(envFlagEnabled, canonical);
});

test('envFlagEnabled tri-state: explicit on/off sets, everything else falls to the default', () => {
  for (const on of ['1', 'true', 'on', 'yes', 'y', ' ON ', 'Yes']) {
    assert.equal(envFlagEnabled(on), true, on);
  }
  for (const off of ['0', 'false', 'off', 'no', 'n', 'OFF', ' No']) {
    assert.equal(envFlagEnabled(off), false, off);
  }
  for (const blank of [undefined, null, '', '   ']) {
    assert.equal(envFlagEnabled(blank), true, 'default is on unless told otherwise');
    assert.equal(envFlagEnabled(blank, false), false);
  }
  assert.equal(envFlagEnabled('garbage'), true);
  assert.equal(envFlagEnabled('garbage', false), false);
});

test('resolveFlag: a missing or malformed flag spec means unconditional (always-on seam)', () => {
  for (const junk of [undefined, null, 'envFlagDefault', 42, []]) {
    assert.equal(resolveFlag(junk), true);
  }
  // A kind-less spec defaults to 'always' rather than disabling the capability.
  assert.equal(resolveFlag({ env: 'KHY_X' }, { env: { KHY_X: 'off' } }), true);
});

test('offDisables compares raw: only the exact string "off" disables', () => {
  const spec = { env: 'KHY_X', kind: 'offDisables' };
  assert.equal(resolveFlag(spec, { env: { KHY_X: 'off' } }), false);
  // No trim, no lowercase — 'OFF' / ' off ' stay ENABLED by design.
  assert.equal(resolveFlag(spec, { env: { KHY_X: 'OFF' } }), true);
  assert.equal(resolveFlag(spec, { env: { KHY_X: ' off ' } }), true);
  assert.equal(resolveFlag(spec, { env: {} }), true);
});

test('zeroDisables trims: "0" disables, "" and "00" do not', () => {
  const spec = { env: 'KHY_X', kind: 'zeroDisables' };
  assert.equal(resolveFlag(spec, { env: { KHY_X: '0' } }), false);
  assert.equal(resolveFlag(spec, { env: { KHY_X: ' 0 ' } }), false);
  assert.equal(resolveFlag(spec, { env: {} }), true);
  assert.equal(resolveFlag(spec, { env: { KHY_X: '00' } }), true);
  assert.equal(resolveFlag(spec, { env: { KHY_X: 'off' } }), true, 'not a member of this dialect');
});

test('onEnables is default-OFF: only an explicit 1/on enables', () => {
  const spec = { env: 'KHY_X', kind: 'onEnables' };
  assert.equal(resolveFlag(spec, { env: {} }), false);
  assert.equal(resolveFlag(spec, { env: { KHY_X: '' } }), false);
  assert.equal(resolveFlag(spec, { env: { KHY_X: '1' } }), true);
  assert.equal(resolveFlag(spec, { env: { KHY_X: ' ON ' } }), true);
  assert.equal(resolveFlag(spec, { env: { KHY_X: 'yes' } }), false, 'not accepted by this dialect');
});

test('module kind delegates to isEnabledFn and fails CLOSED', () => {
  const spec = { env: 'KHY_X', kind: 'module' };
  assert.equal(resolveFlag(spec, { env: {} }), false, 'no gate function → disabled');
  assert.equal(resolveFlag(spec, { env: {}, isEnabledFn: 42 }), false);
  assert.equal(resolveFlag(spec, { env: {}, isEnabledFn: () => true }), true);
  assert.equal(resolveFlag(spec, { env: {}, isEnabledFn: () => 0 }), false);
  assert.equal(
    resolveFlag(spec, { env: {}, isEnabledFn: () => { throw new Error('gate blew up'); } }),
    false,
    'a throwing module gate must count as disabled',
  );
});

test('envFlagDefault honours an explicit spec default and ignores a flagless env name', () => {
  assert.equal(resolveFlag({ env: 'KHY_X', kind: 'envFlagDefault' }, { env: {} }), true);
  assert.equal(
    resolveFlag({ env: 'KHY_X', kind: 'envFlagDefault', default: false }, { env: {} }),
    false,
  );
  // A spec without an env name reads `undefined` → falls to the default, never crashes.
  assert.equal(resolveFlag({ kind: 'envFlagDefault' }, { env: {} }), true);
});

test('resolveFlag reads only the injected env, never process.env', () => {
  const key = 'KHY_B22_PROBE_NEVER_SET';
  assert.equal(key in process.env, false, 'probe key must be absent from the real environment');
  assert.equal(resolveFlag({ env: key, kind: 'offDisables' }, { env: {} }), true);
  assert.equal(resolveFlag({ env: key, kind: 'onEnables' }, { env: { [key]: '1' } }), true);
});

test('unknown kind falls through to true — therefore no descriptor may use one', () => {
  assert.equal(resolveFlag({ env: 'KHY_X', kind: 'envFlagDefualt' }, { env: {} }), true);
  const known = new Set(DESCRIPTORS.map((d) => d.id));
  assert.ok(known.size > 0);
  for (const d of DESCRIPTORS) {
    if (!d.flag) continue;
    assert.ok(
      KNOWN_KINDS.includes(d.flag.kind),
      `descriptor ${d.id} declares unregistered flag kind "${d.flag.kind}" → silently always-on`,
    );
    assert.match(d.flag.env, /^KHY_[A-Z0-9_]+$/, `descriptor ${d.id} has a non-conforming env name`);
    if (d.flag.kind === 'module') {
      assert.equal(typeof d.isEnabledFn, 'function', `descriptor ${d.id} is fail-closed without a gate`);
    }
    if (d.flag.kind === 'envFlagDefault') {
      assert.equal(typeof d.flag.default, 'boolean');
    }
  }
});
