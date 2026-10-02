'use strict';

/**
 * Colocated contract test for intentGuards.js (pre-loop guard resolution).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 *
 * All five external inputs are injected as thunks/refs, so this test performs
 * ZERO IO and never loads ../khyUpgradeRuntime.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveIntentGuards } = require('./intentGuards');

const EMPTY_FRAME = { detailAnchors: [], tailDetails: [], summary: '' };

function makeDeps(overrides = {}) {
  const calls = { runtime: 0, errors: 0, follow: 0 };
  const deps = {
    originalUserMessage: '修一下登录报错',
    env: {},
    requireKhyUpgradeRuntime: () => {
      calls.runtime += 1;
      return {
        buildIntentAssuranceDirective: (msg) => ({
          detailAnchors: ['登录', '报错'],
          tailDetails: ['500'],
          summary: 'fix login error',
        }),
      };
    },
    extractErrorSignals: () => {
      calls.errors += 1;
      return ['TypeError'];
    },
    isFollowThroughGuardEnabled: () => {
      calls.follow += 1;
      return true;
    },
    ...overrides,
  };
  return { deps, calls };
}

test('all three gates default to ON with an empty env', () => {
  const { deps } = makeDeps();
  const r = resolveIntentGuards(deps);
  assert.equal(r.intentCoverageEnabled, true);
  assert.equal(r.intentPathRedosGuard, true);
  assert.equal(r.errorEnumEnabled, true);
});

test('the four off-tokens close a gate, case and space insensitive', () => {
  for (const tok of ['0', 'false', 'off', 'no', ' OFF ', 'False']) {
    const { deps } = makeDeps({ env: { KHY_INTENT_COVERAGE: tok } });
    const r = resolveIntentGuards(deps);
    assert.equal(r.intentCoverageEnabled, false, `KHY_INTENT_COVERAGE=${tok}`);
  }
  const { deps } = makeDeps({ env: { KHY_INTENT_PATH_REDOS_GUARD: '0' } });
  assert.equal(resolveIntentGuards(deps).intentPathRedosGuard, false);
  const { deps: d3 } = makeDeps({ env: { KHY_ERROR_ENUMERATION: 'off' } });
  assert.equal(resolveIntentGuards(d3).errorEnumEnabled, false);
});

test('an unrelated value (e.g. "1") does NOT close the gate', () => {
  const { deps } = makeDeps({ env: { KHY_INTENT_COVERAGE: '1' } });
  assert.equal(resolveIntentGuards(deps).intentCoverageEnabled, true);
});

test('coverage on → the intent frame is filled from the runtime directive', () => {
  const { deps, calls } = makeDeps();
  const r = resolveIntentGuards(deps);
  assert.deepEqual(r.intentFrame, {
    detailAnchors: ['登录', '报错'],
    tailDetails: ['500'],
    summary: 'fix login error',
  });
  assert.equal(calls.runtime, 1, 'the lazy provider fires exactly once per run');
});

test('coverage off → the runtime module is never required at all', () => {
  const { deps, calls } = makeDeps({
    env: { KHY_INTENT_COVERAGE: '0' },
    requireKhyUpgradeRuntime: () => {
      throw new Error('must not be called');
    },
  });
  const r = resolveIntentGuards(deps);
  assert.equal(calls.runtime, 0);
  assert.deepEqual(r.intentFrame, EMPTY_FRAME);
});

test('provider throwing → fail-soft to the empty frame, no exception escapes', () => {
  const { deps } = makeDeps({
    requireKhyUpgradeRuntime: () => {
      throw new Error('khyUpgradeRuntime absent');
    },
  });
  assert.deepEqual(resolveIntentGuards(deps).intentFrame, EMPTY_FRAME);
});

test('a directive returning null / non-arrays is normalized, not forwarded', () => {
  const cases = [
    () => null,
    () => undefined,
    () => ({}),
    () => ({ detailAnchors: 'not-an-array', tailDetails: 42, summary: null }),
  ];
  for (const build of cases) {
    const { deps } = makeDeps({
      requireKhyUpgradeRuntime: () => ({ buildIntentAssuranceDirective: build }),
    });
    const frame = resolveIntentGuards(deps).intentFrame;
    assert.ok(Array.isArray(frame.detailAnchors));
    assert.ok(Array.isArray(frame.tailDetails));
    assert.equal(typeof frame.summary, 'string');
    assert.deepEqual(frame, EMPTY_FRAME, 'garbage in → the same empty frame shape out');
  }
});

test('summary keeps a non-string coerced to string — a number does not leak through', () => {
  const { deps } = makeDeps({
    requireKhyUpgradeRuntime: () => ({
      buildIntentAssuranceDirective: () => ({ summary: 42 }),
    }),
  });
  assert.equal(resolveIntentGuards(deps).intentFrame.summary, '42');
});

test('error signals come from the extractor only when the gate is on', () => {
  const on = makeDeps();
  assert.deepEqual(resolveIntentGuards(on.deps).errorSignals, ['TypeError']);
  assert.equal(on.calls.errors, 1);

  const off = makeDeps({
    env: { KHY_ERROR_ENUMERATION: '0' },
    extractErrorSignals: () => {
      throw new Error('must not be called');
    },
  });
  const r = resolveIntentGuards(off.deps);
  assert.equal(off.calls.errors, 0);
  assert.deepEqual(r.errorSignals, []);
});

test('a throwing extractor yields [] rather than breaking the loop setup', () => {
  const { deps } = makeDeps({
    extractErrorSignals: () => {
      throw new Error('regex blew up');
    },
  });
  assert.deepEqual(resolveIntentGuards(deps).errorSignals, []);
});

test('follow-through is opt-out-by-failure: true passes through, throw becomes false', () => {
  const { deps } = makeDeps();
  assert.equal(resolveIntentGuards(deps).followThroughEnabled, true);

  const { deps: d2 } = makeDeps({
    isFollowThroughGuardEnabled: () => {
      throw new Error('guard module absent');
    },
  });
  assert.equal(resolveIntentGuards(d2).followThroughEnabled, false);

  const { deps: d3 } = makeDeps({ isFollowThroughGuardEnabled: () => false });
  assert.equal(resolveIntentGuards(d3).followThroughEnabled, false);
});

test('the follow-through guard receives the same env bag it was given', () => {
  let seen = null;
  const env = { KHY_FOLLOW_THROUGH: '1', KHY_INTENT_COVERAGE: 'on' };
  const { deps } = makeDeps({
    env,
    isFollowThroughGuardEnabled: (e) => {
      seen = e;
      return true;
    },
  });
  resolveIntentGuards(deps);
  assert.equal(seen, env, 'passed by reference — no copied env can silently diverge');
});

test('the returned bag is exactly the six documented read-only outputs', () => {
  const { deps } = makeDeps();
  assert.deepEqual(Object.keys(resolveIntentGuards(deps)).sort(), [
    'errorEnumEnabled',
    'errorSignals',
    'followThroughEnabled',
    'intentCoverageEnabled',
    'intentFrame',
    'intentPathRedosGuard',
  ]);
});
