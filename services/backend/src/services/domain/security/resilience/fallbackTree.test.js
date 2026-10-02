'use strict';

// Unit-level contract tests for fallbackTree.js (co-located, per [RESEARCH-018] §2.3).
// This file is the protocol's constitution: depth cap 3, max-retry 1, frozen output.
// The guards are enforced HERE, not by caller discipline, so each one gets a rejection
// test (throws, never silent truncation) as well as a happy-path test.

const test = require('node:test');
const assert = require('node:assert/strict');

const fallbackTree = require('./fallbackTree');
const { FallbackTreeBuilder, FallbackTreeError, MAX_FALLBACK_DEPTH, MAX_RETRY_PER_PLAN } =
  fallbackTree;

test('module face and hard constants', () => {
  assert.deepEqual(Object.keys(fallbackTree).sort(),
    ['FallbackTreeBuilder', 'FallbackTreeError', 'MAX_FALLBACK_DEPTH', 'MAX_RETRY_PER_PLAN']);
  assert.equal(MAX_FALLBACK_DEPTH, 3);
  assert.equal(MAX_RETRY_PER_PLAN, 1);
});

test('FallbackTreeError is a named Error subclass', () => {
  const e = new FallbackTreeError('x');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'FallbackTreeError');
  assert.equal(e.message, 'x');
});

test('builder: chainable, build() yields intent/description/maxDepth/plans', () => {
  const b = new FallbackTreeBuilder('my-intent', { description: '人话描述' });
  const same = b.plan('A', { tool: 'TA' });
  assert.equal(same, b, 'plan() returns this for chaining');
  const tree = b.build();
  assert.equal(tree.intent, 'my-intent');
  assert.equal(tree.description, '人话描述');
  assert.equal(tree.maxDepth, MAX_FALLBACK_DEPTH);
  assert.equal(tree.plans.length, 1);
});

test('builder: empty intent degrades to unnamed-intent; description defaults to intent', () => {
  const tree = new FallbackTreeBuilder('  ').plan('A', { tool: 'TA' }).build();
  assert.equal(tree.intent, 'unnamed-intent');
  assert.equal(tree.description, 'unnamed-intent');
});

test('depth cap: a 4th plan throws FallbackTreeError, never silent truncation', () => {
  const b = new FallbackTreeBuilder('deep');
  b.plan('A', { tool: 'TA' }).plan('B', { tool: 'TB' }).plan('C', { tool: 'TC' });
  assert.throws(() => b.plan('D', { tool: 'TD' }), (err) =>
    err instanceof FallbackTreeError && /深度超限/.test(err.message) && /最多 3 个 Plan/.test(err.message));
  // The rejected append left the builder untouched at 3 plans.
  assert.equal(b.build().plans.length, 3);
});

test('plan spec: tool falls back to display name; both missing throws', () => {
  const tree = new FallbackTreeBuilder('t').plan('WebX', {}).build();
  assert.equal(tree.plans[0].tool, 'WebX', 'name doubles as tool when spec.tool absent');
  assert.throws(() => new FallbackTreeBuilder('t').plan('', { tool: '  ' }),
    (err) => err instanceof FallbackTreeError && /缺少 tool/.test(err.message));
  assert.throws(() => new FallbackTreeBuilder('t').plan('   ', { tool: 'T' }),
    (err) => err instanceof FallbackTreeError && /缺少展示名/.test(err.message));
});

test('maxRetry is pinned to 1 even if the spec asks for more', () => {
  const tree = new FallbackTreeBuilder('t')
    .plan('A', { tool: 'TA', maxRetry: 9 })
    .build();
  assert.equal(tree.plans[0].maxRetry, MAX_RETRY_PER_PLAN);
});

test('spec.params object becomes a per-call shallow copy; buildParams function wins', () => {
  const tree = new FallbackTreeBuilder('t')
    .plan('A', { tool: 'TA', params: { url: 'x' } })
    .plan('B', { tool: 'TB', params: { p: 1 }, buildParams: () => ({ fresh: true }) })
    .build();
  const a = tree.plans[0].buildParams({ any: 'ctx' });
  const a2 = tree.plans[0].buildParams({ any: 'ctx' });
  assert.deepEqual(a, { url: 'x' });
  assert.notEqual(a, a2, 'each call returns a NEW copy — mutating one plan call cannot leak');
  a2.url = 'mutated';
  assert.equal(tree.plans[0].buildParams({}).url, 'x', 'source spec.params stays pristine');
  assert.deepEqual(tree.plans[1].buildParams({}), { fresh: true },
    'explicit buildParams beats spec.params');
});

test('plan without params or buildParams yields {} per call', () => {
  const tree = new FallbackTreeBuilder('t').plan('A', { tool: 'TA' }).build();
  assert.deepEqual(tree.plans[0].buildParams({ x: 1 }), {});
});

test('optional hooks: functions kept by identity, non-functions normalized to null', () => {
  const isOk = (r) => r.ok === 1;
  const ext = (r) => r.body;
  const tree = new FallbackTreeBuilder('t')
    .plan('A', { tool: 'TA', isSuccess: isOk, extractSalvage: ext, suggestion: '下一步试试这个' })
    .plan('B', { tool: 'TB', isSuccess: 'not-a-fn', extractSalvage: 42 })
    .build();
  assert.equal(tree.plans[0].isSuccess, isOk);
  assert.equal(tree.plans[0].extractSalvage, ext);
  assert.equal(tree.plans[0].suggestion, '下一步试试这个');
  assert.equal(tree.plans[1].isSuccess, null);
  assert.equal(tree.plans[1].extractSalvage, null);
  assert.equal(tree.plans[1].suggestion, '', 'suggestion defaults to empty string, never undefined');
});

test('frozen all the way down: tree, plans array, and every plan node', () => {
  const tree = new FallbackTreeBuilder('t').plan('A', { tool: 'TA' }).build();
  assert.ok(Object.isFrozen(tree));
  assert.ok(Object.isFrozen(tree.plans));
  assert.ok(Object.isFrozen(tree.plans[0]));
  assert.throws(() => { tree.plans.push({}); }, TypeError, 'executor cannot smuggle a 4th plan in');
});

test('empty tree is refused: build() with zero plans throws', () => {
  assert.throws(() => new FallbackTreeBuilder('t').build(),
    (err) => err instanceof FallbackTreeError && /至少需要 1 个 Plan/.test(err.message));
});

test('static from(): accepts plan|name keys, forwards opts, throws past the cap', () => {
  const tree = FallbackTreeBuilder.from('bulk', [
    { plan: 'A', tool: 'TA' },
    { name: 'B', tool: 'TB' },
  ], { description: '批量构造' });
  assert.deepEqual(tree.plans.map((p) => p.plan), ['A', 'B']);
  assert.deepEqual(tree.plans.map((p) => p.tool), ['TA', 'TB']);
  assert.equal(tree.description, '批量构造');

  assert.throws(() => FallbackTreeBuilder.from('bulk', [1, 2, 3, 4].map((n) => ({ plan: `P${n}`, tool: `T${n}` }))),
    FallbackTreeError);
  assert.throws(() => FallbackTreeBuilder.from('bulk', 'not-an-array'),
    (err) => err instanceof FallbackTreeError && /至少需要 1 个 Plan/.test(err.message),
    'non-array plans degrades to empty and the empty rule then fires');
});

test('from() with no plans array throws (empty refused); each call yields a fresh tree', () => {
  assert.throws(() => FallbackTreeBuilder.from('x'), FallbackTreeError,
    'plans defaults to [] → the empty-tree rule fires');
  const t1 = FallbackTreeBuilder.from('i', [{ plan: 'A', tool: 'TA' }]);
  const t2 = FallbackTreeBuilder.from('i', [{ plan: 'A', tool: 'TA' }]);
  assert.notEqual(t1, t2, 'trees are not memoized — per-intent mutable state cannot be shared');
  assert.notEqual(t1.plans, t2.plans);
});
