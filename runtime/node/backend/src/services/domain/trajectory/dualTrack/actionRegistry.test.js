'use strict';

// Unit-level contract tests for actionRegistry.js (co-located, per [RESEARCH-018] §2.3).
// The registry is the physical heart of 红线5: two isolated tracks, the official core
// sealed after assemble and never touched again, user overrides living only in a shadow
// layer. Everything here is derived from the source's own JSDoc contracts: the resolve
// priority ladder (override > core > unknown fallback), the seal/registration error
// taxonomy, and the core-integrity assertion. No IO, no env.

const test = require('node:test');
const assert = require('node:assert/strict');

const { ActionRegistry, CorePollutionError } = require('./actionRegistry');

const handlerA = () => 'A';
const handlerB = () => 'B';

test('registerCore stores a handler and resolve reports it as official_core', () => {
  const reg = new ActionRegistry();
  const ret = reg.registerCore('say', handlerA);
  assert.equal(ret, reg, 'registerCore returns this for chaining');
  assert.equal(reg.isSealed(), false);
  const r = reg.resolve('say');
  assert.equal(r.type, 'say');
  assert.equal(r.handler, handlerA);
  assert.equal(r.origin, 'core');
  assert.equal(r.isKnown, true);
  assert.equal(r.source, 'official_core');
});

test('registerCore validates type and handler before sealing (plain Error, not CorePollution)', () => {
  const reg = new ActionRegistry();
  assert.throws(() => reg.registerCore('', handlerA), /type 必须为非空字符串/);
  assert.throws(() => reg.registerCore(null, handlerA), /type 必须为非空字符串/);
  assert.throws(() => reg.registerCore(123, handlerA), /type 必须为非空字符串/);
  assert.throws(() => reg.registerCore('x', 'not-a-fn'), /handler 必须为函数/);
  assert.throws(() => reg.registerCore('x', undefined), /handler 必须为函数/);
  assert.equal(reg.has('x'), false, 'a rejected registration must not land in the core track');
  assert.equal(reg.resolve('x').isKnown, false);
});

test('duplicate core registration is core pollution', () => {
  const reg = new ActionRegistry();
  reg.registerCore('say', handlerA);
  assert.throws(() => reg.registerCore('say', handlerB), CorePollutionError);
  assert.throws(
    () => reg.registerCore('say', handlerB),
    (err) => err.code === 'CORE_POLLUTION' && err.name === 'CorePollutionError',
  );
});

test('seal freezes the core track: any later registerCore throws CorePollutionError', () => {
  const reg = new ActionRegistry();
  reg.registerCore('say', handlerA);
  reg.seal();
  assert.equal(reg.isSealed(), true);
  assert.throws(() => reg.registerCore('new', handlerA), CorePollutionError);
  // Even a well-formed, previously-unregistered type is rejected after sealing.
  assert.equal(reg.has('new'), false);
});

test('registerOverride only writes the shadow layer and never touches the core track', () => {
  const reg = new ActionRegistry();
  reg.registerCore('say', handlerA);
  reg.seal();
  const before = reg.coreSnapshot();
  reg.registerOverride('say', handlerB, { source: 'user_track:my-patch' });
  reg.registerOverride('brand_new', handlerB);
  assert.deepEqual(reg.coreSnapshot(), before, 'core keys must be untouched by overrides');
  const r = reg.resolve('say');
  assert.equal(r.origin, 'override', 'override wins over core');
  assert.equal(r.handler, handlerB);
  assert.equal(r.source, 'user_track:my-patch');
});

test('registerOverride defaults source to user_track and validates its args', () => {
  const reg = new ActionRegistry();
  reg.registerOverride('x', handlerA);
  assert.equal(reg.resolve('x').source, 'user_track');
  assert.throws(() => reg.registerOverride('', handlerA), /type 必须为非空字符串/);
  assert.throws(() => reg.registerOverride('x', 42), /handler 必须为函数/);
});

test('resolve of an unknown type falls back to a well-formed unknown (never undefined, never throws)', () => {
  const reg = new ActionRegistry();
  const r = reg.resolve('ghost');
  assert.deepEqual(r, {
    type: 'ghost',
    handler: null,
    origin: 'unknown',
    isKnown: false,
    source: null,
  });
});

test('has() spans both tracks and resolve precedence is override > core > unknown', () => {
  const reg = new ActionRegistry();
  reg.registerCore('say', handlerA);
  reg.registerOverride('only_override', handlerB);
  assert.equal(reg.has('say'), true);
  assert.equal(reg.has('only_override'), true);
  assert.equal(reg.has('ghost'), false);
  assert.equal(reg.resolve('only_override').origin, 'override');
});

test('coreSnapshot returns a frozen, sorted copy of core keys', () => {
  const reg = new ActionRegistry();
  reg.registerCore('zeta', handlerA);
  reg.registerCore('alpha', handlerB);
  reg.registerCore('mid', handlerA);
  const snap = reg.coreSnapshot();
  assert.deepEqual(snap, ['alpha', 'mid', 'zeta']);
  assert.equal(Object.isFrozen(snap), true, 'snapshot must be frozen for integrity checks');
});

test('overrideList exposes shadow entries with their source, without the handler', () => {
  const reg = new ActionRegistry();
  reg.registerOverride('a', handlerA, { source: 'src-a' });
  reg.registerOverride('b', handlerB);
  assert.deepEqual(reg.overrideList(), [
    { type: 'a', source: 'src-a' },
    { type: 'b', source: 'user_track' },
  ]);
});

test('assertCoreIntact passes on a matching snapshot and throws on any drift', () => {
  const reg = new ActionRegistry();
  reg.registerCore('say', handlerA);
  reg.registerCore('read', handlerB);
  const snap = reg.coreSnapshot();
  assert.equal(reg.assertCoreIntact(snap), true);
  assert.throws(() => reg.assertCoreIntact(['say']), CorePollutionError, 'missing key = drift');
  // coreSnapshot() is sorted ['read','say']; the reverse order must be rejected as drift.
  assert.throws(() => reg.assertCoreIntact(['say', 'read']), CorePollutionError, 'order matters');
  assert.throws(() => reg.assertCoreIntact(['say', 'read', 'extra']), CorePollutionError);
  assert.throws(() => reg.assertCoreIntact(null), CorePollutionError, 'non-array snapshot drifts');
  assert.throws(() => reg.assertCoreIntact('not-an-array'), CorePollutionError);
});

test('CorePollutionError is a real Error carrying name and code', () => {
  const err = new CorePollutionError('boom');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'CorePollutionError');
  assert.equal(err.code, 'CORE_POLLUTION');
  assert.equal(err.message, 'boom');
});
