'use strict';

// Unit-level contract tests for composer.js (co-located, per [RESEARCH-018] §2.3).
// tests/services/capabilityMatrix/composer.test.js proves the planner's shape on
// synthetic fixtures. These tests prove the two things a fixture cannot: that the
// REAL 19-descriptor catalog survives the planner unchanged in cut 1 (inertness +
// seam/owner consistency), and the budget ladder's hard edge — irreversible steps
// are never dropped even when the budget stays breached.

const test = require('node:test');
const assert = require('node:assert/strict');

const { composeRoute, defaultRequirementsMatcher } = require('./composer');
const { DESCRIPTORS } = require('./descriptors');
const { PRESETS } = require('./routePresets');
const { SEAMS, SEAM_ORDER, SEAM_OWNER, isSeam } = require('./seams');

const ALL_ON = () => true;
const ids = (arr) => arr.map((x) => x.id);

test('composeRoute() with no arguments returns an empty, well-shaped route', () => {
  const r = composeRoute();
  assert.deepEqual(r.steps, []);
  assert.deepEqual(r.active, []);
  assert.deepEqual(r.gatedOff, []);
  assert.deepEqual(r.suppressed, []);
  assert.deepEqual(r.budgetDropped, []);
  assert.equal(r.preset, null);
  assert.deepEqual(r.signals, { modes: [] });
  assert.equal(r.budgetUsed, 0);
});

test('real catalog: every descriptor becomes exactly one step, seam and owner stay truthful', () => {
  const r = composeRoute({ descriptors: DESCRIPTORS, flagResolver: ALL_ON, ctx: {} });
  assert.equal(r.steps.length, DESCRIPTORS.length);
  assert.equal(new Set(ids(r.steps)).size, DESCRIPTORS.length);
  for (const s of r.steps) {
    assert.equal(isSeam(s.seam), true, `${s.id} has an unknown seam ${s.seam}`);
    assert.equal(Object.values(SEAMS).includes(s.seam), true);
    assert.match(s.owner, /\.js$/);
    assert.equal(typeof s.eligible, 'boolean');
    assert.equal(typeof s.isReversible, 'boolean');
    // A wired capability must report the physical host its seam is defined on.
    if (s.wired) {
      assert.equal(s.owner, SEAM_OWNER[s.seam], `${s.id} wired but seam table and owner disagree`);
    }
  }
});

test('real catalog: steps come out in non-decreasing seam+phase rank, ties keep input order', () => {
  const r = composeRoute({ descriptors: DESCRIPTORS, flagResolver: ALL_ON, ctx: {} });
  const rank = (s) => (SEAM_ORDER[s.seam] || 0) + (s.phase || 0);
  const ranks = r.steps.map(rank);
  assert.ok(ranks.every((v, i) => i === 0 || v >= ranks[i - 1]), 'rank must be monotonic');
  // Stable tie-break: re-running the planner on a shuffled catalog keeps rank order only.
  const shuffled = DESCRIPTORS.slice().reverse();
  const r2 = composeRoute({ descriptors: shuffled, flagResolver: ALL_ON, ctx: {} });
  assert.deepEqual(ids(r2.steps), ids(r.steps));
});

test('cut-1 inertness: with the all-max default vector nothing is capability-filtered', () => {
  const r = composeRoute({ descriptors: DESCRIPTORS, flagResolver: ALL_ON, ctx: {} });
  const gaps = r.steps.filter((s) => (s.reason || '').startsWith('capability-gap'));
  assert.deepEqual(gaps, []);
  assert.deepEqual(r.active, r.steps.filter((s) => s.eligible).map((s) => s.id));
  assert.equal(r.budgetUsed, r.steps.filter((s) => s.eligible).reduce((a, s) => a + s.cost, 0));
});

test('real catalog: gating stays with flags + preconditions, presets do not change who fires', () => {
  const plain = composeRoute({ descriptors: DESCRIPTORS, flagResolver: ALL_ON, ctx: {} });
  const withPreset = composeRoute({
    descriptors: DESCRIPTORS,
    flagResolver: ALL_ON,
    ctx: {},
    preset: PRESETS.find((p) => p.id === 'delivery'),
  });
  assert.deepEqual(withPreset.active, plain.active, 'preset overlay must be observability-only in cut 1');
  // inPreset is reported in the route's rank order, not the preset's declared order.
  const marked = withPreset.steps.filter((s) => s.inPreset).map((s) => s.id);
  assert.deepEqual(marked.slice().sort(), PRESETS.find((p) => p.id === 'delivery').capabilities.slice().sort());
  assert.equal(marked.length, 6);
  assert.equal(withPreset.preset.id, 'delivery');
  assert.deepEqual(plain.preset, null);
});

test('a low capability vector excludes steps and names the first gap', () => {
  const r = composeRoute({
    descriptors: DESCRIPTORS,
    flagResolver: ALL_ON,
    ctx: {},
    capabilityVector: { tool_use: 0 },
  });
  const gaps = r.steps.filter((s) => (s.reason || '').startsWith('capability-gap'));
  assert.ok(gaps.length > 0, 'the tool_use:0 vector must actually bite');
  for (const s of gaps) {
    assert.equal(s.eligible, false);
    assert.match(s.reason, /^capability-gap:[a-z_]+ \d+\/\d+$/);
    assert.ok(Object.keys(s.requires).length > 0, `${s.id} gated on a gap but declares no requires`);
  }
});

test('gated-off outranks suppression, and the two lists stay disjoint', () => {
  const d = {
    id: 'both',
    label: 'off and blocked',
    seam: SEAMS.PRE_DISPATCH,
    phase: 1,
    cost: 1,
    flag: { env: 'KHY_X' },
    preconditions: () => false,
  };
  const r = composeRoute({ descriptors: [d], flagResolver: () => false, ctx: {} });
  assert.equal(r.steps[0].reason, 'gated-off');
  assert.deepEqual(ids(r.gatedOff), ['both']);
  assert.deepEqual(r.suppressed, []);
  assert.deepEqual(r.active, []);
});

test('suppression reason ladder: subagent, then iteration, then tool-calls, else precondition', () => {
  const mk = (extra) => ({
    id: 's',
    label: 's',
    seam: SEAMS.EMPTY_TOOLCALLS,
    phase: 10,
    cost: 0,
    preconditions: () => false,
    ...extra,
  });
  const run = (descriptor, ctx) =>
    composeRoute({ descriptors: [descriptor], flagResolver: ALL_ON, ctx }).suppressed[0].reason;
  assert.equal(run(mk({ subagentSuppressed: true }), { isSubagent: true }), 'subagent');
  assert.equal(run(mk(), { isSubagent: true }), 'precondition', 'not subagent-flagged → generic');
  assert.equal(run(mk(), { iteration: 2 }), 'not-iter-1');
  assert.equal(run(mk(), { iteration: 1, toolCallsLen: 3 }), 'has-toolcalls');
  assert.equal(run(mk(), {}), 'precondition');
});

test('a throwing precondition fails closed instead of failing the whole route', () => {
  const d = {
    id: 'boom',
    label: 'boom',
    seam: SEAMS.EMPTY_TOOLCALLS,
    phase: 10,
    cost: 2,
    preconditions: () => {
      throw new Error('ctx missing');
    },
  };
  const r = composeRoute({ descriptors: [d], flagResolver: ALL_ON, ctx: {} });
  assert.equal(r.steps[0].eligible, false);
  assert.equal(r.steps[0].reason, 'precondition');
  assert.equal(r.budgetUsed, 0);
});

test('budget drops the costliest reversible steps and never touches irreversible ones', () => {
  const ds = [
    { id: 'irrev', label: 'i', seam: SEAMS.DELIVERY_GATE, phase: 10, cost: 10, isReversible: false },
    { id: 'rev5', label: 'a', seam: SEAMS.PRE_DISPATCH, phase: 10, cost: 5 },
    { id: 'rev3', label: 'b', seam: SEAMS.PRE_DISPATCH, phase: 20, cost: 3 },
  ];
  const ok = composeRoute({ descriptors: ds, flagResolver: ALL_ON, ctx: {} });
  assert.equal(ok.budgetUsed, 18);
  assert.deepEqual(ok.active, ['rev5', 'rev3', 'irrev'], 'rank order, not declaration order');

  const tight = composeRoute({ descriptors: ds, flagResolver: ALL_ON, ctx: {}, budget: 13 });
  assert.deepEqual(tight.active, ['rev3', 'irrev'], 'the costliest reversible step is cut first');
  assert.equal(tight.budgetUsed, 13);
  assert.deepEqual(tight.budgetDropped, [{ id: 'rev5', reason: 'budget:5' }]);
  const cut = tight.steps.find((s) => s.id === 'rev5');
  assert.equal(cut.eligible, false);
  assert.equal(cut.reason, 'budget');
  assert.equal(tight.steps.find((s) => s.id === 'irrev').eligible, true);

  const hopeless = composeRoute({ descriptors: ds, flagResolver: ALL_ON, ctx: {}, budget: 1 });
  assert.deepEqual(hopeless.active, ['irrev'], 'irreversible survives an impossible budget');
  assert.equal(hopeless.budgetUsed, 10, 'the breach must be reported, not hidden');
  assert.deepEqual(ids(hopeless.budgetDropped), ['rev5', 'rev3']);

  const free = composeRoute({ descriptors: ds, flagResolver: ALL_ON, ctx: {}, budget: Infinity });
  assert.deepEqual(free.active, ['rev5', 'rev3', 'irrev'], 'Infinity budget is a no-op');
});

test('defaultRequirementsMatcher: every declared dimension must be met', () => {
  assert.equal(defaultRequirementsMatcher({}, { tool_use: 0 }), true);
  assert.equal(defaultRequirementsMatcher(undefined, {}), true);
  assert.equal(defaultRequirementsMatcher({ tool_use: 3 }, { tool_use: 3 }), true);
  assert.equal(defaultRequirementsMatcher({ tool_use: 3 }, { tool_use: 2 }), false);
  assert.equal(defaultRequirementsMatcher({ tool_use: 3 }, {}), false, 'missing dim counts as 0');
  assert.equal(
    defaultRequirementsMatcher({ long_context: 2, tool_use: 3 }, { long_context: 5, tool_use: 1 }),
    false,
  );
});

test('route.signals.modes is a copy of the caller array', () => {
  const modes = ['analyze'];
  const r = composeRoute({ descriptors: [], flagResolver: ALL_ON, signals: { modes }, ctx: {} });
  modes.push('coding');
  assert.deepEqual(r.signals.modes, ['analyze']);
  const weird = composeRoute({ descriptors: [], flagResolver: ALL_ON, signals: { modes: 'analyze' }, ctx: {} });
  assert.deepEqual(weird.signals.modes, []);
});
