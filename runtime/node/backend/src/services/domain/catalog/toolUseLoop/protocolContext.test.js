'use strict';

/**
 * Colocated contract test for protocolContext.js (harness/protocol resolution).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 *
 * gateway / capability / adapter modules are injected, so no real service loads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveProtocolContext } = require('./protocolContext');

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

const PROFILE = { toolCallProtocol: 'native', name: 'default' };

function makeDeps(overrides = {}) {
  const seen = { breadcrumb: [], tiers: [], capCalls: [], adapters: [] };
  const deps = {
    chatOpts: { model: 'claude-x' },
    options: {},
    modelTier: {
      resolveTier: (m) => {
        seen.tiers.push(m);
        return 'T1';
      },
      harnessProfile: (tier) => (tier === 'T0' ? { ...PROFILE, toolCallProtocol: 'native', tier } : PROFILE),
    },
    loopBreadcrumb: (...args) => seen.breadcrumb.push(args),
    toolCap: {
      isEnabled: () => true,
      modelLacksReliableToolCalling: (m, opts) => {
        seen.capCalls.push([m, opts]);
        return false;
      },
    },
    toolCapStore: { getVerdict: () => ({ verdict: 'native-ok' }) },
    toolProtocolAdapter: {
      resolveAdapter: (p) => {
        seen.adapters.push(p);
        return { __adapterFor: p };
      },
    },
    ...overrides,
  };
  return { deps, seen };
}

test('the returned bag carries exactly the five documented resolutions', () => {
  const { deps } = makeDeps();
  assert.deepEqual(Object.keys(resolveProtocolContext(deps)).sort(), [
    'activeAdapter',
    'activeProtocol',
    'harnessProfile',
    'isTextProtocol',
    'modelLacksNativeTools',
  ]);
});

test('model id precedence: chatOpts.model > options.model > env > empty string', () => {
  const a = makeDeps({ chatOpts: { model: 'fromChatOpts' }, options: { model: 'fromOptions' } });
  resolveProtocolContext(a.deps);
  assert.deepEqual(a.seen.tiers, ['fromChatOpts']);

  const b = makeDeps({ chatOpts: {}, options: { model: 'fromOptions' } });
  resolveProtocolContext(b.deps);
  assert.deepEqual(b.seen.tiers, ['fromOptions']);

  const c = makeDeps({ chatOpts: {}, options: {} });
  withEnv('GATEWAY_PREFERRED_MODEL', 'fromEnv', () => resolveProtocolContext(c.deps));
  assert.deepEqual(c.seen.tiers, ['fromEnv']);

  const d = makeDeps({ chatOpts: {}, options: {} });
  withEnv('GATEWAY_PREFERRED_MODEL', undefined, () => resolveProtocolContext(d.deps));
  assert.deepEqual(d.seen.tiers, [''], 'no model anywhere → the empty string, never undefined');
});

test('the harness profile is always announced as a breadcrumb', () => {
  const { deps, seen } = makeDeps();
  const r = resolveProtocolContext(deps);
  assert.deepEqual(seen.breadcrumb[0], ['harness-profile', r.harnessProfile]);
});

test('explicit toolCallProtocol wins over the harness default, and only text/native are honoured', () => {
  for (const p of ['text', 'native']) {
    const { deps, seen } = makeDeps({ options: { toolCallProtocol: p } });
    const r = resolveProtocolContext(deps);
    assert.equal(r.activeProtocol, p);
    assert.equal(r.isTextProtocol, p === 'text');
    assert.deepEqual(seen.adapters, [p], 'the adapter is resolved with the ACTIVE protocol');
  }
  const { deps } = makeDeps({ options: { toolCallProtocol: 'sideways' } });
  assert.equal(resolveProtocolContext(deps).activeProtocol, 'native', 'an unknown value falls back to the harness default');
});

test('with no explicit protocol the harness default is used, and a missing field means native', () => {
  const { deps } = makeDeps();
  assert.equal(resolveProtocolContext(deps).activeProtocol, 'native');

  const bare = makeDeps({
    modelTier: { resolveTier: () => 'T3', harnessProfile: () => ({}) },
  });
  assert.equal(resolveProtocolContext(bare.deps).activeProtocol, 'native');
});

test('the text protocol emits its own breadcrumb; native stays silent', () => {
  const text = makeDeps({ options: { toolCallProtocol: 'text' } });
  resolveProtocolContext(text.deps);
  assert.deepEqual(text.seen.breadcrumb[1], ['tool-protocol', { protocol: 'text' }]);

  const nat = makeDeps({ options: { toolCallProtocol: 'native' } });
  resolveProtocolContext(nat.deps);
  assert.equal(nat.seen.breadcrumb.length, 1, 'only harness-profile');
});

test('the measured verdict is looked up per model id and passed to the capability SSOT', () => {
  const { deps, seen } = makeDeps();
  resolveProtocolContext(deps);
  assert.deepEqual(seen.capCalls, [['claude-x', { measured: { verdict: 'native-ok' } }]]);
});

test('a capability store that throws still asks the SSOT — with measured: null', () => {
  const { deps, seen } = makeDeps({
    toolCapStore: {
      getVerdict: () => {
        throw new Error('store cold');
      },
    },
  });
  const r = resolveProtocolContext(deps);
  assert.deepEqual(seen.capCalls[0][1], { measured: null });
  assert.equal(r.modelLacksNativeTools, false);
});

test('a disabled capability SSOT short-circuits: the verdict is read but never consulted', () => {
  const { deps, seen } = makeDeps({ toolCap: { isEnabled: () => false, modelLacksReliableToolCalling: () => true } });
  assert.equal(resolveProtocolContext(deps).modelLacksNativeTools, false);
  assert.equal(seen.capCalls.length, 0, 'the alarming default stays off, byte-identical to legacy');
});

test('capability resolution throwing → modelLacksNativeTools false (the calm default)', () => {
  const { deps } = makeDeps({
    toolCap: {
      isEnabled: () => true,
      modelLacksReliableToolCalling: () => {
        throw new Error('ssot absent');
      },
    },
  });
  assert.equal(resolveProtocolContext(deps).modelLacksNativeTools, false);
});

test('a true verdict is forwarded verbatim into the result', () => {
  const { deps } = makeDeps({
    toolCap: { isEnabled: () => true, modelLacksReliableToolCalling: () => true },
  });
  assert.equal(resolveProtocolContext(deps).modelLacksNativeTools, true);
});

test('a missing chatOpts/options pair does not break resolution', () => {
  const { deps } = makeDeps({ chatOpts: null, options: null });
  const r = resolveProtocolContext(deps);
  assert.equal(r.activeProtocol, 'native');
  assert.equal(r.modelLacksNativeTools, false);
});

test('ASYMMETRY (registered, not fixed): the adapter is resolved outside any guard — a bare adapter escapes as a throw', () => {
  const { deps } = makeDeps({ toolProtocolAdapter: null });
  assert.throws(() => resolveProtocolContext(deps), TypeError);
  // ...while the capability pair right above it is fully fail-soft:
  const ok = makeDeps({ toolCapStore: null });
  assert.doesNotThrow(() => resolveProtocolContext(ok.deps));
});
