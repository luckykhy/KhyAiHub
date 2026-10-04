'use strict';

/**
 * taskGraph.test.js — co-located unit test for taskGraph.js (D2 unit
 * structuredFurnace). Pure node:test, synchronous, zero I/O.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TaskGraph, EDGE_TYPES } = require('./taskGraph');

function linear(n) {
  const g = new TaskGraph();
  for (let i = 1; i <= n; i++) {
    g.addNode({ uid: `n${i}`, action: 'READ' });
  }
  for (let i = 2; i <= n; i++) {
    g.addEdge(`n${i - 1}`, `n${i}`, 'seq');
  }
  return g;
}

test('module surface is the class plus the frozen edge-type enum', () => {
  assert.deepEqual(Object.keys(require('./taskGraph')), ['TaskGraph', 'EDGE_TYPES']);
  assert.ok(Object.isFrozen(EDGE_TYPES));
  assert.deepEqual([...EDGE_TYPES], ['seq', 'cond', 'cause']);
});

test('a fresh graph is empty and vacuously acyclic', () => {
  const g = new TaskGraph();
  assert.equal(g.nodeCount(), 0);
  assert.equal(g.edgeCount(), 0);
  assert.equal(g.isAcyclic(), true);
  assert.equal(g.findCycle(), null);
  assert.deepEqual(g.toJSON(), { nodes: [], edges: [] });
});

test('addNode requires a uid', () => {
  const g = new TaskGraph();
  assert.throws(() => g.addNode(null), /node\.uid required/);
  assert.throws(() => g.addNode({}), /node\.uid required/);
  assert.throws(() => g.addNode({ uid: '' }), /node\.uid required/);
  assert.throws(() => g.addNode(undefined), /node\.uid required/);
});

test('addNode fills the documented defaults and returns the uid', () => {
  const g = new TaskGraph();
  assert.equal(g.addNode({ uid: 'a', action: 'READ' }), 'a');
  assert.deepEqual(g.nodes.get('a'), { status: 'PENDING', confidence: 1, params: {}, uid: 'a', action: 'READ' });
});

test('node fields win over the defaults', () => {
  const g = new TaskGraph();
  g.addNode({ uid: 'a', status: 'DONE', confidence: 0.3, params: { k: 1 } });
  assert.deepEqual(g.nodes.get('a'), { uid: 'a', status: 'DONE', confidence: 0.3, params: { k: 1 } });
});

// B31-F13: the defaults live on the LEFT of the spread, so a caller that passes a
// key with an explicit `undefined` does not get the default — it gets `undefined`,
// and JSON.stringify then drops the field entirely. taskGraph.js:9 documents
// `{ uid, action, target, params, confidence, status }` as the node shape, and
// forgeSchema never checks node.status/confidence, so the gap stays invisible.
test('B31-F13 explicit undefined defeats the node defaults (current, wrong)', () => {
  const g = new TaskGraph();
  g.addNode({ uid: 'c', action: 'READ', status: undefined, confidence: undefined });
  assert.equal('status' in g.nodes.get('c'), true);
  assert.equal(g.nodes.get('c').status, undefined);
  assert.equal(g.nodes.get('c').confidence, undefined);
  // Whatever gets sealed is the JSON form: both documented node fields vanish there.
  assert.equal(JSON.stringify(g.toJSON().nodes), '[{"params":{},"uid":"c","action":"READ"}]');
});

test('re-adding a uid replaces the node instead of forking it', () => {
  const g = new TaskGraph();
  g.addNode({ uid: 'a', action: 'READ' });
  g.addNode({ uid: 'a', action: 'DELETE', status: 'DONE' });
  assert.equal(g.nodeCount(), 1);
  assert.equal(g.nodes.get('a').action, 'DELETE');
  assert.equal(g.nodes.get('a').status, 'DONE');
});

test('addEdge rejects endpoints that were never added', () => {
  const g = new TaskGraph();
  g.addNode({ uid: 'a' });
  assert.throws(() => g.addEdge('a', 'missing'), /endpoint not found \(a -> missing\)/);
  assert.throws(() => g.addEdge('missing', 'a'), /endpoint not found/);
  assert.equal(g.edgeCount(), 0);
});

test('addEdge defaults to a seq edge and only stores condition when truthy', () => {
  const g = new TaskGraph();
  g.addNode({ uid: 'a' });
  g.addNode({ uid: 'b' });
  g.addEdge('a', 'b');
  g.addEdge('a', 'b', 'cond', null);
  g.addEdge('a', 'b', 'cause', { on: 'a', expect: true });
  assert.deepEqual(g.edges[0], { from: 'a', to: 'b', type: 'seq' });
  assert.deepEqual(g.edges[1], { from: 'a', to: 'b', type: 'cond' });
  assert.equal('condition' in g.edges[1], false, 'a null condition leaves no key at all');
  assert.deepEqual(g.edges[2], { from: 'a', to: 'b', type: 'cause', condition: { on: 'a', expect: true } });
  assert.equal(g.edgeCount(), 3);
});

// B31-F9: an edge type outside EDGE_TYPES is silently rewritten to 'seq' instead of
// being rejected. 'seq' is the least informative member of the enum, so a typo'd
// 'causal' / 'conditional' edge loses its dependency semantics while every gate
// (schema, cycle detection, envelope) still reports a healthy graph — the opposite
// posture from the unit's own "绝不脑补" claim.
test('B31-F9 an unknown edge type becomes seq without any signal (current, wrong)', () => {
  const g = new TaskGraph();
  g.addNode({ uid: 'a' });
  g.addNode({ uid: 'b' });
  g.addEdge('a', 'b', 'causal');
  assert.equal(g.edges[0].type, 'seq');
  g.addEdge('a', 'b', 'conditional', { on: 'a' });
  assert.equal(g.edges[1].type, 'seq');
  assert.deepEqual(g.edges[1].condition, { on: 'a' }, 'the condition survives, the type does not');
  // A legitimate type is untouched, proving the rewrite is about the enum, not the value.
  g.addEdge('a', 'b', 'cond', { on: 'a' });
  assert.equal(g.edges[2].type, 'cond');
});

test('topoSort orders a linear chain', () => {
  assert.deepEqual(linear(4).topoSort(), { ok: true, order: ['n1', 'n2', 'n3', 'n4'] });
});

test('topoSort orders a diamond and keeps every node exactly once', () => {
  const g = new TaskGraph();
  ['a', 'b', 'c', 'd'].forEach((u) => g.addNode({ uid: u }));
  g.addEdge('a', 'b');
  g.addEdge('a', 'c');
  g.addEdge('b', 'd');
  g.addEdge('c', 'd');
  const r = g.topoSort();
  assert.equal(r.ok, true);
  assert.deepEqual(new Set(r.order), new Set(['a', 'b', 'c', 'd']));
  assert.ok(r.order.indexOf('a') < r.order.indexOf('d'));
});

test('a self-loop is reported as a cycle on that very node', () => {
  const g = new TaskGraph();
  g.addNode({ uid: 'a' });
  g.addEdge('a', 'a');
  assert.deepEqual(g.topoSort(), { ok: false, cycle: ['a'] });
  assert.equal(g.isAcyclic(), false);
  assert.deepEqual(g.findCycle(), ['a']);
});

test('a two-node cycle yields exactly the two nodes of the cycle', () => {
  const g = new TaskGraph();
  ['a', 'b'].forEach((u) => g.addNode({ uid: u }));
  g.addEdge('a', 'b');
  g.addEdge('b', 'a');
  assert.deepEqual(g.findCycle().sort(), ['a', 'b']);
});

// B31-F7: topoSort's `cycle` is really "every node that was never emitted", which
// also includes plain downstream victims of the deadlock. taskGraph.js:69-70 calls
// it "仍处于环中（入度未清零）的节点集合 —— 死锁证据", and chaosInterceptor.js:93
// forwards it verbatim as FurnaceRejection.conflicts, so the human doing the
// clarification is told that n4 (which only WAITS for n3) is part of the deadlock.
test('B31-F7 the reported "cycle" contains non-cycle victims (current, wrong)', () => {
  const g = new TaskGraph();
  ['n1', 'n2', 'n3', 'n4'].forEach((u) => g.addNode({ uid: u, action: 'READ' }));
  g.addEdge('n1', 'n2');
  g.addEdge('n2', 'n3');
  g.addEdge('n3', 'n2'); // the only real cycle: n2 <-> n3
  g.addEdge('n3', 'n4'); // n4 is downstream, NOT in a cycle
  const r = g.topoSort();
  assert.equal(r.ok, false);
  assert.deepEqual(r.cycle, ['n2', 'n3', 'n4']);
  assert.deepEqual(g.findCycle(), ['n2', 'n3', 'n4']);
});

test('_indegrees counts multi-edges and starts every node at zero', () => {
  const g = new TaskGraph();
  g.addNode({ uid: 'a' });
  g.addNode({ uid: 'b' });
  g.addEdge('a', 'b');
  g.addEdge('a', 'b');
  assert.deepEqual([...g._indegrees()], [['a', 0], ['b', 2]]);
  assert.deepEqual(g.topoSort(), { ok: true, order: ['a', 'b'] });
});

test('toJSON exposes nodes and a copied edge array', () => {
  const g = linear(2);
  const j = g.toJSON();
  assert.equal(j.nodes.length, 2);
  assert.deepEqual(j.edges, [{ from: 'n1', to: 'n2', type: 'seq' }]);
  j.edges.push({ from: 'x', to: 'y', type: 'seq' });
  assert.equal(g.edgeCount(), 1, 'the edges ARRAY is copied');
});

test('toJSON nodes are the live Map values, not copies (aliasing)', () => {
  const g = new TaskGraph();
  g.addNode({ uid: 'a', action: 'READ' });
  g.toJSON().nodes[0].status = 'DONE';
  assert.equal(g.nodes.get('a').status, 'DONE', 'the node OBJECT is shared');
});

test('a graph with nodes but no edges is acyclic with every node in insertion order', () => {
  const g = new TaskGraph();
  g.addNode({ uid: 'z' });
  g.addNode({ uid: 'y' });
  assert.deepEqual(g.topoSort(), { ok: true, order: ['z', 'y'] });
});
