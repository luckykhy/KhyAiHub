'use strict';

/**
 * Colocated contract test for budgets.js (pre-loop loop-cap triple).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 *
 * The four core resolvers and the two lazy module providers are injected, so this
 * test loads neither aiGateway nor the intent gate.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveLoopBudgets } = require('./budgets');

function makeDeps(overrides = {}) {
  const calls = { gateway: 0, intent: 0 };
  const deps = {
    chatOpts: { contextWindowTokens: 200000 },
    requestedMaxIterations: undefined,
    originalUserMessage: 'task',
    options: {},
    gatedInput: { activatedModes: [] },
    harnessProfile: {},
    resolveMaxIterations: () => 40,
    resolveTransientRecoveryMax: () => 3,
    resolveMinSafeIterations: () => 12,
    resolveMaxElapsedMs: () => 90000,
    requireGateway: () => {
      calls.gateway += 1;
      return { getModelContextWindow: () => 77000 };
    },
    requireIntentGate: () => {
      calls.intent += 1;
      return { getLoopLimitBoost: () => ({ outerBoost: 18 }) };
    },
    ...overrides,
  };
  return { deps, calls };
}

test('the returned bag is exactly the three values the loop reads downstream', () => {
  const { deps } = makeDeps();
  assert.deepEqual(Object.keys(resolveLoopBudgets(deps)).sort(), [
    'effectiveMaxIterations',
    'maxElapsedMs',
    'transientRecoveryMax',
  ]);
});

test('no explicit cap → resolved + outerBoost + transient + harness boost', () => {
  const { deps } = makeDeps({ harnessProfile: { maxIterationsBoost: 5 } });
  const r = resolveLoopBudgets(deps);
  assert.equal(r.effectiveMaxIterations, 40 + 18 + 3 + 5);
  assert.equal(r.transientRecoveryMax, 3, 'the transient allowance is returned verbatim');
  assert.equal(r.maxElapsedMs, 90000);
});

test('an explicit requestedMaxIterations BYPASSES both the 200 ceiling and every boost', () => {
  const { deps } = makeDeps({
    requestedMaxIterations: 500,
    resolveMaxIterations: (requested) => requested,
    harnessProfile: { maxIterationsBoost: 50 },
  });
  assert.equal(resolveLoopBudgets(deps).effectiveMaxIterations, 500);
});

test('null counts as "not explicitly requested" while 0 does not (strict undefined/null test)', () => {
  const asNull = makeDeps({ requestedMaxIterations: null, resolveMaxIterations: () => 40 });
  assert.equal(resolveLoopBudgets(asNull.deps).effectiveMaxIterations, 61, 'boosted path: 40+18+3, no harness boost');

  const asZero = makeDeps({
    requestedMaxIterations: 0,
    resolveMaxIterations: () => 0,
  });
  assert.equal(resolveLoopBudgets(asZero.deps).effectiveMaxIterations, 12, 'explicit path → the dynamic floor wins');
});

test('the dynamic floor always wins over a smaller computed cap', () => {
  const { deps } = makeDeps({
    resolveMaxIterations: () => 1,
    resolveTransientRecoveryMax: () => 0,
    resolveMinSafeIterations: () => 30,
    requireIntentGate: () => ({ getLoopLimitBoost: () => ({ outerBoost: 0 }) }),
  });
  assert.equal(resolveLoopBudgets(deps).effectiveMaxIterations, 30);
});

test('the implicit path is capped at 200 even when the parts add up to more', () => {
  const { deps } = makeDeps({
    resolveMaxIterations: () => 5000,
    requireIntentGate: () => ({ getLoopLimitBoost: () => ({ outerBoost: 12 }) }),
  });
  assert.equal(resolveLoopBudgets(deps).effectiveMaxIterations, 200);
});

test('a chatOpts context window suppresses the gateway probe entirely', () => {
  const { deps, calls } = makeDeps({ chatOpts: { contextWindowTokens: 128000, preferredModel: 'm' } });
  resolveLoopBudgets(deps);
  assert.equal(calls.gateway, 0, 'no synchronous gateway call on a budget-critical path');
});

test('no window + preferredModel → the gateway cache probe fills it in', () => {
  const seen = [];
  const { deps, calls } = makeDeps({
    chatOpts: { preferredModel: 'glm-4' },
    resolveMaxIterations: (_req, window) => {
      seen.push(window);
      return 40;
    },
    requireGateway: () => {
      calls.gateway += 1;
      return { getModelContextWindow: (m) => (m === 'glm-4' ? 8000 : 0) };
    },
  });
  resolveLoopBudgets(deps);
  assert.equal(calls.gateway, 1);
  assert.deepEqual(seen, [8000], 'the probed window is what the resolver is asked to size against');
});

test('a gateway without getModelContextWindow (or throwing) leaves the window at 0', () => {
  for (const gw of [{}, { getModelContextWindow: () => { throw new Error('cold cache'); } }, { getModelContextWindow: () => null }]) {
    const seen = [];
    const { deps } = makeDeps({
      chatOpts: { preferredModel: 'm' },
      requireGateway: () => gw,
      resolveMaxIterations: (_req, window) => {
        seen.push(window);
        return 40;
      },
    });
    assert.doesNotThrow(() => resolveLoopBudgets(deps));
    assert.deepEqual(seen, [0]);
  }
});

test('garbage contextWindowTokens is coerced to 0 rather than propagating', () => {
  const seen = [];
  for (const value of ['abc', {}, null, undefined, -5]) {
    const { deps } = makeDeps({
      chatOpts: { contextWindowTokens: value },
      resolveMaxIterations: (_req, window) => {
        seen.push(window);
        return 40;
      },
    });
    resolveLoopBudgets(deps);
  }
  assert.deepEqual(seen, [0, 0, 0, 0, -5], 'a NEGATIVE window is not clamped — only NaN/absent fold to 0');
});

test('activatedModes defaults to [] when the gated input carries none', () => {
  const seen = [];
  const { deps } = makeDeps({
    gatedInput: {},
    requireIntentGate: () => ({
      getLoopLimitBoost: (modes) => {
        seen.push(modes);
        return { outerBoost: 0 };
      },
    }),
  });
  resolveLoopBudgets(deps);
  assert.deepEqual(seen, [[]]);
});

test('ASYMMETRY (registered, not fixed): the gateway probe is fail-soft, the intent gate is NOT', () => {
  const { deps } = makeDeps({
    requireGateway: () => {
      throw new Error('gateway absent');
    },
  });
  assert.doesNotThrow(() => resolveLoopBudgets(deps));

  const { deps: d2 } = makeDeps({
    requireIntentGate: () => {
      throw new Error('intent gate absent');
    },
  });
  assert.throws(() => resolveLoopBudgets(d2), /intent gate absent/);

  const { deps: d3 } = makeDeps({
    requireIntentGate: () => ({ getLoopLimitBoost: () => null }),
  });
  assert.throws(() => resolveLoopBudgets(d3), TypeError, 'reading .outerBoost off null');
});
