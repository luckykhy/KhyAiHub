'use strict';

// Unit-level contract tests for capabilityMatrix/index.js (co-located, per [RESEARCH-018] §2.3).
// index.js is the ONLY runtime surface of the matrix — the loop seams call
// isEnabledAt() in place of their old inline `process.env.KHY_*` checks. Everything
// here is driven through injected deps (env / descriptors / overrides) so no test
// touches process.env or the filesystem.

const test = require('node:test');
const assert = require('node:assert/strict');

const matrix = require('./index');
const { DESCRIPTORS } = require('./descriptors');
const { SEAMS } = require('./seams');

const { CapabilityMatrix, getCapabilityMatrix, makeCapabilityMatrix, _resetCapabilityMatrix } = matrix;

const find = (id) => DESCRIPTORS.find((d) => d.id === id);

test('module exports the class plus a memoized singleton and an unmemoized DI factory', () => {
  assert.equal(typeof CapabilityMatrix, 'function');
  assert.equal(getCapabilityMatrix(), getCapabilityMatrix(), 'singleton must be memoized');
  assert.notEqual(makeCapabilityMatrix({ env: {} }), makeCapabilityMatrix({ env: {} }));
  const before = getCapabilityMatrix();
  _resetCapabilityMatrix();
  assert.notEqual(getCapabilityMatrix(), before, 'reset must drop the memoized instance');
  assert.equal(getCapabilityMatrix(), getCapabilityMatrix());
});

test('descriptor access: by id, by seam, and getAll() hands out a copy', () => {
  const m = makeCapabilityMatrix({ env: {} });
  assert.equal(m.getDescriptor('selfHeal'), find('selfHeal'));
  assert.equal(m.getDescriptor('noSuchCapability'), null);
  const all = m.getAll();
  assert.equal(all.length, DESCRIPTORS.length);
  all.pop();
  assert.equal(m.getAll().length, DESCRIPTORS.length, 'getAll must not expose the internal map');
  for (const seam of Object.values(SEAMS)) {
    const subset = m.bySeam(seam);
    assert.ok(subset.every((d) => d.seam === seam));
    assert.equal(subset.length, DESCRIPTORS.filter((d) => d.seam === seam).length);
  }
  assert.deepEqual(m.bySeam('NOT_A_SEAM'), []);
});

test('isEnabledAt guards a call-site seam typo before consulting any flag', () => {
  const d = find('selfHeal');
  const m = makeCapabilityMatrix({ env: {} });
  assert.equal(m.isEnabledAt('WRONG_SEAM', d.id, {}), false);
  assert.equal(m.isEnabledAt(d.seam, 'noSuchCapability', {}), false);
  assert.equal(m.isEnabledAt(d.seam, d.id, {}), true, 'offDisables default path stays enabled');
});

test('isEnabledAt resolves the flag from the injected env only', () => {
  const d = find('selfHeal');
  const off = makeCapabilityMatrix({ env: { KHY_SELF_HEAL: 'off' } });
  const on = makeCapabilityMatrix({ env: { KHY_SELF_HEAL: 'on' } });
  assert.equal(off.isEnabledAt(d.seam, d.id, {}), false);
  assert.equal(on.isEnabledAt(d.seam, d.id, {}), true, "'on' is not 'off', so offDisables stays enabled");
  assert.equal('KHY_SELF_HEAL' in process.env, false, 'the matrix must not leak env writes');
});

test('isEnabledAt layers preconditions on top of the flag and fails closed on a throw', () => {
  const boom = {
    id: 'boom',
    label: 'boom',
    seam: SEAMS.EMPTY_TOOLCALLS,
    phase: 10,
    owner: 'x.js',
    cost: 0,
    risk: 0,
    isReversible: true,
    wired: true,
    subagentSuppressed: false,
    flag: { env: 'KHY_BOOM', kind: 'onEnables' },
    requires: {},
    preconditions: () => {
      throw new Error('ctx missing');
    },
  };
  const m = makeCapabilityMatrix({ env: { KHY_BOOM: '1' }, descriptors: [boom] });
  assert.equal(m.isEnabledAt(boom.seam, 'boom', {}), false, 'a throwing precondition is disabled');
  const off = makeCapabilityMatrix({ env: {}, descriptors: [boom] });
  assert.equal(off.isEnabledAt(boom.seam, 'boom', {}), false, 'onEnables is default-OFF');
});

test('module-kind descriptors consult isEnabledFn and never a bare env read', () => {
  const gateOn = {
    id: 'gated',
    seam: SEAMS.POST_TOOL_GOVERNANCE,
    phase: 10,
    flag: { env: 'KHY_GATE', kind: 'module' },
    requires: {},
    isEnabledFn: () => true,
    preconditions: () => true,
  };
  const m = makeCapabilityMatrix({ env: { KHY_GATE: '1' }, descriptors: [gateOn] });
  assert.equal(m.resolveFlag(gateOn), true);
  assert.equal(m.isEnabledAt(gateOn.seam, 'gated', {}), true);
  const off = makeCapabilityMatrix({ env: {}, descriptors: [{ ...gateOn, isEnabledFn: () => false }] });
  assert.equal(off.isEnabledAt(gateOn.seam, 'gated', {}), false);
});

test('overrides are applied by copy and never mutate the frozen catalog', () => {
  const m = makeCapabilityMatrix({
    env: {},
    overrides: { selfHeal: { cost: 99, wired: false } },
  });
  assert.equal(m.getDescriptor('selfHeal').cost, 99);
  assert.equal(m.getDescriptor('selfHeal').wired, false);
  assert.equal(find('selfHeal').cost, 2, 'the shared descriptor must be untouched');
  assert.equal(Object.isFrozen(find('selfHeal')), true);
  assert.equal(m.getDescriptor('structuredFurnace').cost, find('structuredFurnace').cost);
});

test('inline KHY_CAPABILITY_MATRIX_JSON overrides win, and malformed JSON is ignored, not fatal', () => {
  const good = makeCapabilityMatrix({
    env: { KHY_CAPABILITY_MATRIX_JSON: JSON.stringify({ selfHeal: { cost: 7 } }) },
  });
  assert.equal(good.getDescriptor('selfHeal').cost, 7);
  const malformed = makeCapabilityMatrix({ env: { KHY_CAPABILITY_MATRIX_JSON: '{not json' } });
  assert.equal(malformed.getDescriptor('selfHeal').cost, find('selfHeal').cost);
  const empty = makeCapabilityMatrix({ env: { KHY_CAPABILITY_MATRIX_JSON: '   ' } });
  assert.equal(empty.getAll().length, DESCRIPTORS.length);
});

test('meetsModelRequirements: null descriptor never matches, vector drives the cut-2 path', () => {
  const m = makeCapabilityMatrix({ env: {} });
  assert.equal(m.meetsModelRequirements(null, { tool_use: 5 }), false);
  const d = find('proactiveCollab');
  assert.equal(d.requires.tool_use, 3);
  assert.equal(m.meetsModelRequirements(d, { tool_use: 3 }), true);
  assert.equal(m.meetsModelRequirements(d, { tool_use: 2 }), false);
  assert.equal(m.meetsModelRequirements(d), false, 'a missing vector means every dimension is 0');
});

test('composeRoute wires the matrix env into the composer: a switched-off flag reads gated-off', () => {
  const d = find('selfHeal');
  const on = makeCapabilityMatrix({ env: {} });
  const off = makeCapabilityMatrix({ env: { KHY_SELF_HEAL: 'off' } });
  assert.ok(on.composeRoute({ ctx: {} }).active.includes(d.id));
  const route = off.composeRoute({ ctx: {} });
  assert.equal(route.active.includes(d.id), false);
  assert.deepEqual(
    route.gatedOff.filter((g) => g.id === d.id),
    [{ id: d.id, reason: 'gated-off' }],
  );
});

test('composeRoute picks the preset from request modes and keeps the route observable', () => {
  const m = makeCapabilityMatrix({ env: {} });
  const route = m.composeRoute({ signals: { modes: ['coding'] }, ctx: {} });
  assert.equal(route.preset.id, 'delivery');
  assert.deepEqual(route.signals.modes, ['coding']);
  assert.ok(route.steps.length === DESCRIPTORS.length);
  assert.equal(m.selectPreset(['analyze']).id, 'research');
  assert.equal(m.getPreset('nope'), null);
});
