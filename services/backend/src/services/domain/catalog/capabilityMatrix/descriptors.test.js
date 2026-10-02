'use strict';

// Unit-level contract tests for descriptors.js (co-located, per [RESEARCH-018] §2.3).
// descriptors.js declares itself as data-only SSOT ("this is the file a human edits").
// These tests lock exactly the ways that data can silently rot: an unresolvable
// invoke pointer, a `requires` dimension that the gateway registry has never heard
// of, a phase offset that escapes its seam band, and a catalog entry mutated by a
// consumer. tests/services/capabilityMatrix/descriptors.contract.test.js asserts the
// same shape per-entry but aborts at the first failure, so it can hide N-1 problems;
// the pointer sweep below reports every dead pointer in one pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { DESCRIPTORS, PRE } = require('./descriptors');
const { SEAMS, SEAM_ORDER } = require('./seams');
const { CAPABILITIES } = require('../../../gateway/capabilityRegistry');

// invoke.module paths are written relative to services/ (the facade root).
const SERVICES_BASE = path.resolve(__dirname, '../../../');

test('the catalog is frozen all the way down, so a consumer cannot retune a capability', () => {
  assert.equal(Object.isFrozen(DESCRIPTORS), true);
  assert.ok(DESCRIPTORS.length > 0);
  for (const d of DESCRIPTORS) {
    assert.equal(Object.isFrozen(d), true, `${d.id}: entry must be immutable`);
    assert.equal(Object.isFrozen(d.flag), true, `${d.id}: flag spec must be immutable`);
    assert.equal(Object.isFrozen(d.invoke), true, `${d.id}: invoke spec must be immutable`);
  }
  assert.throws(() => {
    'use strict';
    DESCRIPTORS[0].cost = 999;
  }, TypeError);
  assert.throws(() => {
    'use strict';
    DESCRIPTORS[0].requires.tool_use = 9;
  }, TypeError);
});

test('every descriptor carries the full declared shape', () => {
  const ids = DESCRIPTORS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate capability id');
  for (const d of DESCRIPTORS) {
    assert.equal(typeof d.id, 'string');
    assert.match(d.id, /^[a-z][A-Za-z0-9]*$/);
    assert.equal(typeof d.label, 'string');
    assert.equal(typeof d.owner, 'string');
    assert.match(d.owner, /\.js$/);
    assert.equal(typeof d.phase, 'number');
    assert.equal(Number.isInteger(d.phase), true);
    assert.equal(typeof d.cost, 'number');
    assert.equal(typeof d.risk, 'number');
    assert.equal(typeof d.isReversible, 'boolean');
    assert.equal(typeof d.wired, 'boolean');
    assert.equal(typeof d.preconditions, 'function');
    assert.equal(typeof d.subagentSuppressed, 'boolean');
    assert.match(d.designDoc, /^DESIGN-[A-Z]+-/);
    assert.ok(Object.values(SEAMS).includes(d.seam), `${d.id}: unknown seam ${d.seam}`);
  }
});

test('a phase offset never escapes its seam band (ordering cannot cross bands)', () => {
  const floors = Object.values(SEAM_ORDER).sort((a, b) => a - b);
  const nextFloor = (f) => floors.find((x) => x > f);
  for (const d of DESCRIPTORS) {
    const floor = SEAM_ORDER[d.seam];
    assert.ok(d.phase >= 0, `${d.id}: negative phase`);
    const ceiling = nextFloor(floor);
    if (ceiling === undefined) {
      assert.ok(d.phase < 100, `${d.id}: last band phase must stay inside one band`);
    } else {
      assert.ok(
        floor + d.phase < ceiling,
        `${d.id}: rank ${floor + d.phase} leaks into the next seam band (floor ${ceiling})`,
      );
    }
  }
});

test('every declared invoke.module pointer resolves — and all misses report at once', () => {
  const dead = [];
  for (const d of DESCRIPTORS) {
    assert.equal(typeof d.invoke.module, 'string', `${d.id}: invoke.module missing`);
    assert.ok(
      d.invoke.export === null || typeof d.invoke.export === 'string',
      `${d.id}: invoke.export must be a name or null`,
    );
    try {
      require.resolve(path.resolve(SERVICES_BASE, d.invoke.module));
    } catch (e) {
      dead.push(`${d.id} -> ${d.invoke.module} (${e.code})`);
    }
  }
  assert.deepEqual(dead, [], `dead invoke pointers:\n${dead.join('\n')}`);
});

test('wired capabilities name a real module; catalog-only ones stay referenced-only', () => {
  const wired = DESCRIPTORS.filter((d) => d.wired);
  const catalogOnly = DESCRIPTORS.filter((d) => !d.wired);
  assert.ok(wired.length > 0 && catalogOnly.length > 0, 'both tiers must be populated');
  for (const d of wired) {
    assert.ok(d.flag && typeof d.flag.kind === 'string', `${d.id}: wired needs a flag dialect`);
    assert.equal(typeof d.isEnabledFn === 'function', d.flag.kind === 'module', `${d.id}: gate fn drift`);
  }
});

test('requires dimensions exist in the gateway capability registry', () => {
  const dims = new Set();
  for (const d of DESCRIPTORS) {
    for (const [dim, min] of Object.entries(d.requires)) {
      dims.add(dim);
      assert.equal(Number.isInteger(min) && min > 0, true, `${d.id}: bad ${dim} floor`);
    }
  }
  assert.ok(dims.size > 0, 'the catalog must actually declare requirements');
  for (const dim of dims) {
    assert.ok(Object.keys(CAPABILITIES).includes(dim), `unknown capability dimension ${dim}`);
  }
});

test('PRE helpers are pure ctx predicates', () => {
  assert.deepEqual(Object.keys(PRE).sort(), ['always', 'emptyToolCalls', 'firstTurnEmptyNoSub', 'notSubagent']);
  assert.equal(PRE.always({}), true);
  assert.equal(PRE.always(undefined), true);
  assert.equal(PRE.emptyToolCalls({ toolCallsLen: 0 }), true);
  assert.equal(PRE.emptyToolCalls({ toolCallsLen: 2 }), false);
  assert.equal(PRE.emptyToolCalls({}), false, 'undefined is not zero');
  assert.equal(PRE.notSubagent({ isSubagent: true }), false);
  assert.equal(PRE.notSubagent({}), true);
  assert.equal(PRE.firstTurnEmptyNoSub({ iteration: 1, toolCallsLen: 0 }), true);
  assert.equal(PRE.firstTurnEmptyNoSub({ iteration: 1, toolCallsLen: 0, isSubagent: true }), false);
  assert.equal(PRE.firstTurnEmptyNoSub({ iteration: 2, toolCallsLen: 0 }), false);
  for (const junk of [null, undefined, {}, { iteration: 2 }]) {
    assert.doesNotThrow(() => PRE.firstTurnEmptyNoSub(junk || {}));
  }
});

test('subagentSuppressed is backed by a precondition that actually fires on isSubagent', () => {
  const flagged = DESCRIPTORS.filter((d) => d.subagentSuppressed);
  assert.ok(flagged.length > 0, 'the recursion guard set must not be empty');
  for (const d of flagged) {
    assert.equal(
      d.preconditions({ isSubagent: true, iteration: 1, toolCallsLen: 0 }),
      false,
      `${d.id} claims subagent suppression but its precondition ignores isSubagent`,
    );
  }
});
