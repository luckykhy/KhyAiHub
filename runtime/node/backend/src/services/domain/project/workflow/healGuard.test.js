'use strict';
// Co-located unit test for ./healGuard.js — batch B31 (D2 functional-unit conformance).
// Pure leaf (zero IO, deterministic, never throws). No filesystem/socket/timer access.
// Pure node:test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const hg = require('./healGuard.js');

// A prev graph carrying nodes n1/n2 so healedFrom can point at them.
function prevGraph() {
  return {
    nodes: [{ id: 'n1', type: 'prompt' }, { id: 'n2', type: 'end' }],
    connections: [{ from: 'n1', to: 'n2' }],
  };
}

// ── surface ───────────────────────────────────────────────────────────────────

test('exported surface is exactly the documented 3 keys', () => {
  assert.deepEqual(Object.keys(hg).sort(), ['DEFAULT_MAX_HEAL_DEPTH', 'checkHealClaim', 'computeHealVerdict']);
  assert.equal(hg.DEFAULT_MAX_HEAL_DEPTH, 5);
});

// ── checkHealClaim: the four gates ────────────────────────────────────────────

test('checkHealClaim: a well-formed claim passes and reports depth', () => {
  const r = hg.checkHealClaim({ healedFrom: 'n1', prevGraph: prevGraph(), prevMeta: { healDepth: 0 } });
  assert.deepEqual(r, { ok: true, depth: 1 });
});

test('checkHealClaim 1: healedFrom must be a non-empty string', () => {
  for (const bad of ['', '   ', null, undefined, 5, {}]) {
    const r = hg.checkHealClaim({ healedFrom: bad, prevGraph: prevGraph() });
    assert.equal(r.ok, false, String(bad));
    assert.match(r.errors[0], /必须是非空字符串/);
  }
});

test('checkHealClaim 2: requires a traceable previous version', () => {
  const r = hg.checkHealClaim({ healedFrom: 'n1', prevGraph: null });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /不存在上一版流程/);
  // prev graph with no nodes counts as "no previous version"
  const empty = hg.checkHealClaim({ healedFrom: 'n1', prevGraph: { nodes: [], connections: [] } });
  assert.match(empty.errors[0], /不存在上一版流程/);
});

test('checkHealClaim 3: root-cause node must exist in the previous graph', () => {
  const r = hg.checkHealClaim({ healedFrom: 'ghost', prevGraph: prevGraph() });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /该节点不在上一版流程中（上一版共 2 个节点）/);
});

test('checkHealClaim 4: heal chain depth may not exceed the cap', () => {
  // prevMeta.healDepth = 5 => depth 6 > default cap 5 => reject
  const r = hg.checkHealClaim({ healedFrom: 'n1', prevGraph: prevGraph(), prevMeta: { healDepth: 5 } });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /自愈链深度 6 超过上限 5/);
});

test('checkHealClaim 4: corrupted previous healDepth is fail-closed', () => {
  const r = hg.checkHealClaim({ healedFrom: 'n1', prevGraph: prevGraph(), prevMeta: { healDepth: 'oops' } });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /上一版 _meta.healDepth 非法/);
  const neg = hg.checkHealClaim({ healedFrom: 'n1', prevGraph: prevGraph(), prevMeta: { healDepth: -1 } });
  assert.match(neg.errors[0], /非法/);
});

test('checkHealClaim: prevMeta.healDepth absent/null is treated as depth 0 (chain restarts)', () => {
  assert.deepEqual(hg.checkHealClaim({ healedFrom: 'n1', prevGraph: prevGraph(), prevMeta: {} }), { ok: true, depth: 1 });
  assert.deepEqual(hg.checkHealClaim({ healedFrom: 'n1', prevGraph: prevGraph(), prevMeta: null }), { ok: true, depth: 1 });
});

test('checkHealClaim: custom maxDepth string is honoured when numeric', () => {
  // prev healDepth 1 => depth 2; cap '2' => 2<=2 accept
  const r = hg.checkHealClaim({ healedFrom: 'n1', prevGraph: prevGraph(), prevMeta: { healDepth: 1 }, maxDepth: '2' });
  assert.deepEqual(r, { ok: true, depth: 2 });
});

test('B31-W4: maxDepth:null collapses to cap 0 (Number(null)=0 is finite) and rejects every claim', () => {
  // healGuard.js:106 `Number.isFinite(Number(c.maxDepth))` — Number(null)=0 is a
  // finite number, so a null maxDepth is treated as an EXPLICIT cap of 0 rather
  // than falling back to DEFAULT_MAX_HEAL_DEPTH. Any real claim (depth>=1) is then
  // rejected with "超过上限 0". Same Number-coercion family as retryPrimitives
  // retries:null and contractChecker expect:null.
  const r = hg.checkHealClaim({ healedFrom: 'n1', prevGraph: prevGraph(), prevMeta: { healDepth: 0 }, maxDepth: null });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /自愈链深度 1 超过上限 0/);
});

test('checkHealClaim: never throws on garbage input', () => {
  assert.doesNotThrow(() => hg.checkHealClaim(null));
  assert.equal(hg.checkHealClaim(null).ok, false);
  assert.doesNotThrow(() => hg.checkHealClaim(42));
});

// ── computeHealVerdict: three-state replay verdict ─────────────────────────────

test('computeHealVerdict: returns null when there is no healedFrom to judge', () => {
  assert.equal(hg.computeHealVerdict({ meta: {}, succeeded: true }), null);
  assert.equal(hg.computeHealVerdict({ meta: { healedFrom: '' }, succeeded: true }), null);
  assert.equal(hg.computeHealVerdict(null), null);
});

test('computeHealVerdict: healVerified requires success AND an all-green declared contract', () => {
  const v = hg.computeHealVerdict({ meta: { healedFrom: 'n1', contract: [{ path: 'x' }], healDepth: 1, previousVersion: 3 }, succeeded: true, contractFailed: false, flowName: 'F' });
  assert.equal(v.healVerified, true);
  assert.equal(v.healedFrom, 'n1');
  assert.equal(v.healDepth, 1);
  assert.deepEqual(v.rollbackTarget, { name: 'F', version: 3 });
});

test('computeHealVerdict: run failure => healRejected run-failed', () => {
  const v = hg.computeHealVerdict({ meta: { healedFrom: 'n1', contract: [{ path: 'x' }] }, succeeded: false });
  assert.equal(v.healRejected, true);
  assert.equal(v.healRejectReason, 'run-failed');
});

test('computeHealVerdict: contract assertion failure => healRejected contract-failed', () => {
  const v = hg.computeHealVerdict({ meta: { healedFrom: 'n1', contract: [{ path: 'x' }] }, succeeded: true, contractFailed: true });
  assert.equal(v.healRejected, true);
  assert.equal(v.healRejectReason, 'contract-failed');
});

test('computeHealVerdict: contract checker blew up => healUnverified (honest, not silent pass)', () => {
  const v = hg.computeHealVerdict({ meta: { healedFrom: 'n1', contract: [{ path: 'x' }] }, succeeded: true, contractCheckError: 'boom' });
  assert.equal(v.healUnverified, true);
  assert.match(v.healUnverifiedReason, /契约校验环节异常/);
});

test('computeHealVerdict: no contract declared => healUnverified (gate is inert)', () => {
  const v = hg.computeHealVerdict({ meta: { healedFrom: 'n1' }, succeeded: true });
  assert.equal(v.healUnverified, true);
  assert.match(v.healUnverifiedReason, /未声明 contract/);
});

test('computeHealVerdict: rollbackTarget null when previousVersion missing / not > 0', () => {
  const v = hg.computeHealVerdict({ meta: { healedFrom: 'n1', contract: [{ path: 'x' }], previousVersion: 0 }, succeeded: true });
  assert.equal(v.rollbackTarget, null);
  assert.equal(v.healVerified, true);
});

test('computeHealVerdict: malformed healDepth reports null (not a bogus number)', () => {
  const v = hg.computeHealVerdict({ meta: { healedFrom: 'n1', healDepth: 'x', contract: [{ path: 'x' }] }, succeeded: true });
  assert.equal(v.healDepth, null);
});

test('computeHealVerdict: never throws (verdict-error fallback)', () => {
  // Passing a getter that throws on access exercises the catch arm.
  const meta = {};
  Object.defineProperty(meta, 'healedFrom', { get() { throw new Error('explodes'); } });
  const v = hg.computeHealVerdict({ meta, succeeded: true });
  assert.equal(v.healRejected, true);
  assert.equal(v.healRejectReason, 'verdict-error');
});
