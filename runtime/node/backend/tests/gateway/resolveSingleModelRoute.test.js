'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveSingleModelRoute,
  buildRouteExplain,
  explainToWire,
} = require('../../src/services/gateway/modelRouter');

test('A1 single model bypass: explain fields all match the contract', () => {
  const availability = {
    state: 'single',
    modelIds: ['sensenova-6.7-flash-lite'],
    reason: 'only_available_model',
  };
  const route = resolveSingleModelRoute({
    availability,
    routeInput: { defaultPreferredAdapter: 'localLLM' },
    probe: { ok: true, status: 200, models: [{ id: 'sensenova-6.7-flash-lite' }], error: '' },
  });

  // 命中既有 BUILTIN_MODEL_ROUTE_MAP：单模型直通不改钉选语义，仍走路由表。
  assert.strictEqual(route.modelId, 'sensenova:sensenova-6.7-flash-lite');
  assert.strictEqual(route.explain.path, 'single_model_bypass');
  assert.strictEqual(route.explain.reason, 'only_available_model');
  assert.strictEqual(route.explain.tier, 'single_model_bypass');
  assert.strictEqual(route.explain.candidateCount, 1);
  assert.strictEqual(route.explain.filter, 'skipped');
  assert.deepStrictEqual(route.explain.scores, {});
  assert.deepStrictEqual(route.explain.fallbackChain, []);
  assert.strictEqual(route.explain.sessionLock, 'session_lock_implicit');
  assert.strictEqual(route.explain.capabilityGap, null);
  assert.strictEqual(route.explain.probes.ok, true);
  assert.strictEqual(route.explain.probes.count, 1);
});

test('A2 unprobed falls back to default model without throwing', () => {
  const route = resolveSingleModelRoute({
    availability: { state: 'unprobed', modelIds: [], reason: 'default_fallback' },
    defaultModelId: 'gpt-4o-mini',
    routeInput: { defaultPreferredAdapter: 'localLLM' },
  });

  assert.strictEqual(route.modelId, 'openai:gpt-4o-mini');
  assert.strictEqual(route.explain.path, 'default_fallback');
  assert.strictEqual(route.explain.reason, 'default_fallback');
  assert.strictEqual(route.explain.tier, 'single_model_bypass');
  assert.strictEqual(route.explain.candidateCount, 0);
});

test('empty probe is distinct from single: uses default, not the empty candidate', () => {
  const route = resolveSingleModelRoute({
    availability: { state: 'empty', modelIds: [], reason: 'default_fallback' },
    defaultModelId: 'gpt-4o',
    routeInput: { defaultPreferredAdapter: 'localLLM' },
  });

  assert.strictEqual(route.explain.path, 'default_fallback');
  assert.strictEqual(route.explain.probes, null);
  assert.strictEqual(route.modelId, 'openai:gpt-4o');
});

test('multiple candidates delegate to the original route with multi_model_routed', () => {
  const availability = { state: 'multiple', modelIds: ['A', 'B'], reason: null };
  const route = resolveSingleModelRoute({
    availability,
    routeInput: { model: 'kiro/claude-sonnet-4' },
  });

  assert.strictEqual(route.adapterKey, 'kiro');
  assert.strictEqual(route.explain.path, 'multi_model_routed');
  assert.strictEqual(route.explain.reason, 'routed');
  assert.strictEqual(route.explain.tier, null);
  assert.strictEqual(route.explain.candidateCount, 2);
  assert.deepStrictEqual(route.explain.fallbackChain, []);
});

test('capability gap is accepted, never rejected', () => {
  const route = resolveSingleModelRoute({
    availability: { state: 'single', modelIds: ['X'], reason: 'only_available_model' },
    capabilityGap: true,
  });
  assert.strictEqual(route.explain.capabilityGap, 'capability_gap_accepted');
});

test('explain is deterministic and does not mutate availability', () => {
  const availability = { state: 'single', modelIds: ['X'], reason: 'only_available_model' };
  const snapshot = JSON.stringify(availability);
  const first = buildRouteExplain(availability, null);
  const second = buildRouteExplain(availability, null);
  assert.deepStrictEqual(first, second);
  assert.strictEqual(JSON.stringify(availability), snapshot);
});

test('wire mapping emits snake_case keys in one place', () => {
  const wire = explainToWire(buildRouteExplain(
    { state: 'single', modelIds: ['X'], reason: 'only_available_model' },
    null
  ));
  assert.deepStrictEqual(Object.keys(wire).sort(), [
    'candidate_count', 'capability_gap', 'fallback_chain', 'filter', 'path',
    'probes', 'reason', 'scores', 'session_lock', 'tier',
  ]);
  assert.strictEqual(wire.candidate_count, 1);
  assert.strictEqual(wire.session_lock, 'session_lock_implicit');
});

test('malformed inputs never throw', () => {
  assert.doesNotThrow(() => resolveSingleModelRoute());
  assert.doesNotThrow(() => resolveSingleModelRoute(null));
  assert.doesNotThrow(() => resolveSingleModelRoute('garbage'));
  assert.doesNotThrow(() => resolveSingleModelRoute({ availability: { state: 'single', modelIds: [] } }));
  const degraded = resolveSingleModelRoute(null);
  assert.strictEqual(degraded.explain.path, 'default_fallback');
});

test('pinned adapter semantics are preserved through the wrapper', () => {
  const route = resolveSingleModelRoute({
    availability: { state: 'single', modelIds: ['kiro/claude-sonnet-4'], reason: 'only_available_model' },
  });
  assert.strictEqual(route.adapterKey, 'kiro');
  assert.strictEqual(route.userPinned, true);
  assert.strictEqual(route.explain.path, 'single_model_bypass');
});
