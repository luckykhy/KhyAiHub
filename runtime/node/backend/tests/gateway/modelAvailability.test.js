'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyModelAvailability } = require('../../src/services/gateway/modelAvailability');

test('probe ok with exactly one model -> single / only_available_model', () => {
  const probe = {
    ok: true,
    status: 200,
    models: [{ id: 'X', contextWindow: 128000 }],
    error: '',
  };
  assert.deepStrictEqual(classifyModelAvailability({ probe }), {
    state: 'single',
    modelIds: ['X'],
    reason: 'only_available_model',
  });
});

test('probe ok with zero models -> empty, never collapsed into single', () => {
  const probe = { ok: true, status: 200, models: [], error: '' };
  assert.deepStrictEqual(classifyModelAvailability({ probe }), {
    state: 'empty',
    modelIds: [],
    reason: 'default_fallback',
  });
});

test('probe ok:false -> unprobed, distinct from empty', () => {
  const probe = { ok: false, status: 401, models: [], error: 'unauthorized' };
  assert.deepStrictEqual(classifyModelAvailability({ probe }), {
    state: 'unprobed',
    modelIds: [],
    reason: 'default_fallback',
  });
});

test('probe null (not run) -> unprobed', () => {
  assert.deepStrictEqual(classifyModelAvailability({ probe: null }), {
    state: 'unprobed',
    modelIds: [],
    reason: 'default_fallback',
  });
});

test('probe ok with multiple models -> multiple, no forced bypass', () => {
  const probe = {
    ok: true,
    status: 200,
    models: [{ id: 'A', contextWindow: 1 }, { id: 'B', contextWindow: 2 }],
    error: '',
  };
  assert.deepStrictEqual(classifyModelAvailability({ probe }), {
    state: 'multiple',
    modelIds: ['A', 'B'],
    reason: null,
  });
});

test('a single configured model outranks a multi-model probe', () => {
  const probe = {
    ok: true,
    status: 200,
    models: [{ id: 'A' }, { id: 'B' }],
    error: '',
  };
  assert.deepStrictEqual(classifyModelAvailability({ probe, configured: ['manual-X'] }), {
    state: 'single',
    modelIds: ['manual-X'],
    reason: 'only_available_model',
  });
});

test('malformed inputs never throw and never mutate the caller arrays', () => {
  const configured = ['  ', null, 42, {}];
  const probe = { ok: true, models: 'not-an-array' };
  const configuredSnapshot = JSON.stringify(configured);
  const probeSnapshot = JSON.stringify(probe);

  assert.deepStrictEqual(classifyModelAvailability({ configured, probe }), {
    state: 'empty',
    modelIds: [],
    reason: 'default_fallback',
  });
  assert.strictEqual(JSON.stringify(configured), configuredSnapshot);
  assert.strictEqual(JSON.stringify(probe), probeSnapshot);
  assert.doesNotThrow(() => classifyModelAvailability());
  assert.doesNotThrow(() => classifyModelAvailability(null));
  assert.doesNotThrow(() => classifyModelAvailability('garbage'));
});

test('deduplicates configured ids before deciding single', () => {
  assert.deepStrictEqual(
    classifyModelAvailability({ configured: ['X', { id: 'X' }, ' X ', ''] }),
    { state: 'single', modelIds: ['X'], reason: 'only_available_model' }
  );
});

test('deterministic: same input yields deep-equal output', () => {
  const input = {
    configured: [],
    probe: { ok: true, status: 200, models: [{ id: 'X' }], error: '' },
  };
  assert.deepStrictEqual(
    classifyModelAvailability(input),
    classifyModelAvailability(input),
  );
});
