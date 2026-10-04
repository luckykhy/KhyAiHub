'use strict';

/**
 * intentWeaver.test.js — co-located unit test for intentWeaver.js (D2 unit
 * structuredFurnace). Pure node:test, synchronous, zero I/O.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { weave, splitClauses, _edgeFor } = require('./intentWeaver');
const { EntityRegistry } = require('./entityRegistry');
const S = require('../../project/metaplan/constraintStrategy');

const shape = (clauses) => clauses.map((c) => [c.connector, c.text]);

test('module surface is weave plus two introspection helpers', () => {
  assert.deepEqual(Object.keys(require('./intentWeaver')), ['weave', 'splitClauses', '_edgeFor']);
});

test('splitClauses returns { text, connector } with a null connector on clause 0', () => {
  assert.deepEqual(shape(splitClauses('备份 a.js')), [[null, '备份 a.js']]);
  assert.deepEqual(shape(splitClauses('先备份 a.js 然后清理 b.js')), [
    [null, '先备份 a.js'],
    ['seq', '清理 b.js'],
  ]);
});

test('an empty or punctuation-only input yields no clauses', () => {
  assert.deepEqual(splitClauses(''), []);
  assert.deepEqual(splitClauses('，。；'), []);
  assert.deepEqual(splitClauses(undefined), []);
});

test('a pure connector between two bodies becomes the second clause edge type', () => {
  assert.deepEqual(shape(splitClauses('备份 a.js 如果成功 清理 b.js')), [
    [null, '备份 a.js'],
    ['cond-true', '成功 清理 b.js'],
  ]);
  assert.deepEqual(shape(splitClauses('备份 a.js 否则 清理 b.js')), [
    [null, '备份 a.js'],
    ['cond-false', '清理 b.js'],
  ]);
  assert.deepEqual(shape(splitClauses('备份 a.js 因为太小 清理 b.js')), [
    [null, '备份 a.js'],
    ['cause', '太小 清理 b.js'],
  ]);
});

test('a leading connector is peeled off the clause body (cond-false before cond-true)', () => {
  assert.deepEqual(shape(splitClauses('否则清理 b.js')), [[null, '清理 b.js']]);
  assert.deepEqual(shape(splitClauses('如果登录成功然后跳转首页否则报错')), [
    [null, '登录成功'],
    ['seq', '跳转首页'],
    ['cond-false', '报错'],
  ]);
});

test('a bare comma defaults the pending edge to seq', () => {
  assert.deepEqual(shape(splitClauses('备份 a.js，清理 b.js')), [
    [null, '备份 a.js'],
    ['seq', '清理 b.js'],
  ]);
});

// B31-F20: the cond-true row of CONNECTORS (intentWeaver.js:28) lists a bare `当`
// among the alternatives, so the leading character of an ordinary word is eaten and
// the clause body arrives mangled. Because clause 0's connector is force-nulled
// (intentWeaver.js:83) the mangled text is all that survives.
test('B31-F20 a leading 当 of an ordinary word is stripped as a connector (current, wrong)', () => {
  assert.deepEqual(shape(splitClauses('当时删除 a.js')), [[null, '时删除 a.js']]);
  assert.deepEqual(shape(splitClauses('当然删除 a.js')), [[null, '然删除 a.js']]);
});

// B31-F20 (second half): a conditional marker on the FIRST clause is dropped, so
// "如果A，B，C" comes back as a plain A→seq→B→seq→C chain.
test('B31-F20 the first clause never carries a connector', () => {
  assert.deepEqual(shape(splitClauses('如果A，B，C')), [[null, 'A'], ['seq', 'B'], ['seq', 'C']]);
});

test('_edgeFor maps the four connector kinds', () => {
  assert.deepEqual(_edgeFor('cause', 'p', 'c'), { type: 'cause', condition: null });
  assert.deepEqual(_edgeFor('cond-true', 'p', 'c'), { type: 'cond', condition: { on: 'p', expect: true } });
  assert.deepEqual(_edgeFor('cond-false', 'p', 'c'), { type: 'cond', condition: { on: 'c', expect: false } });
  assert.deepEqual(_edgeFor('cond-false', 'p', null), { type: 'cond', condition: { on: 'p', expect: false } });
  assert.deepEqual(_edgeFor('seq', 'p', 'c'), { type: 'seq', condition: null });
  assert.deepEqual(_edgeFor(undefined, 'p', 'c'), { type: 'seq', condition: null });
});

test('weave emits a TaskGraph payload whose edges mirror the clause connectors', () => {
  const p = weave('先备份 a.js 然后删除 a.js');
  assert.deepEqual(Object.keys(p), ['kind', 'uid', 'graph', 'entities', 'confidence', 'strategy']);
  assert.equal(p.kind, 'TaskGraph');
  assert.match(p.uid, /^tg_[0-9a-f]{8}$/);
  assert.equal(p.graph.nodes.length, 2);
  assert.equal(p.graph.edges.length, 1);
  assert.equal(p.graph.edges[0].type, 'seq');
  assert.equal(p.graph.edges[0].from, p.graph.nodes[0].uid);
  assert.equal(p.graph.edges[0].to, p.graph.nodes[1].uid);
});

test('weave records the cond edge against the preceding node', () => {
  const p = weave('备份 a.js 如果成功 删除 b.js');
  assert.equal(p.graph.edges[0].type, 'cond');
  assert.deepEqual(p.graph.edges[0].condition, { on: p.graph.nodes[0].uid, expect: true });
});

test('an else without any preceding if falls back to the previous node', () => {
  const p = weave('备份 a.js 否则 删除 b.js');
  assert.deepEqual(p.graph.edges[0].condition, { on: p.graph.nodes[0].uid, expect: false });
});

test('a second else still points at the last if, not at its own predecessor', () => {
  const p = weave('登录 如果成功 跳转 否则 报错 否则 退出');
  assert.equal(p.graph.nodes.length, 4);
  assert.equal(p.graph.edges.length, 3);
  assert.equal(p.graph.edges[1].type, 'cond');
  assert.equal(p.graph.edges[2].type, 'cond');
  assert.equal(p.graph.edges[2].condition.expect, false);
  assert.equal(p.graph.edges[2].condition.on, p.graph.nodes[0].uid, 'lastCondSource stayed on the if-source');
});

test('weave gives every node a distinct uid even for identical clause text', () => {
  const p = weave('备份 a.js 然后 备份 a.js');
  assert.equal(p.graph.nodes.length, 2);
  assert.notEqual(p.graph.nodes[0].uid, p.graph.nodes[1].uid);
  assert.equal(p.entities[p.graph.nodes[0].target.uid].mentions, 2, 'the ENTITY still dedupes');
});

test('node uids and graph shape are deterministic across runs', () => {
  const a = weave('先备份 a.js 然后删除 a.js');
  const b = weave('先备份 a.js 然后删除 a.js');
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test('weave lifts the riskiest action into the strategy', () => {
  assert.equal(weave('先读取 a.js 然后删除 b.js').strategy, S.STRATEGIES.CODE_HARD);
  assert.equal(weave('读取 a.js 然后 读取 b.js').strategy, S.STRATEGIES.PROMPT_SOFT);
});

test('weave takes the minimum clause confidence', () => {
  const p = weave('先读取 a.js 然后可能删除 b.js');
  assert.equal(p.confidence, 0.6);
  const both = weave('先读取 "可能" 然后可能删除 b.js');
  assert.ok(both.confidence <= 0.6);
});

// B31-F7 (weave side): an empty or connector-only input still produces a
// `kind: 'TaskGraph'` payload with confidence 1 — the payload is only refused later
// by forgeSchema.validateTaskGraph, so weave() itself never fails and a caller that
// skips the schema gate gets a "complete" TaskGraph with zero nodes.
test('weave of nothing is a well-formed-looking empty TaskGraph', () => {
  const p = weave('');
  assert.deepEqual(p.graph, { nodes: [], edges: [] });
  assert.equal(p.confidence, 1);
  assert.equal(p.strategy, S.STRATEGIES.PROMPT_SOFT);
  assert.deepEqual(p.entities, {});
  assert.equal(require('./forgeSchema').validateTaskGraph(p).valid, false);
});

test('weave shares the caller registry so entities persist across calls', () => {
  const r = new EntityRegistry();
  weave('备份 a.js 然后 清理 b.js', r);
  const second = weave('读取 a.js', r);
  assert.equal(Object.keys(second.entities).length, 2);
});

test('nodes carry the L0 clause skeleton fields', () => {
  const p = weave('删除 a.js');
  assert.deepEqual(Object.keys(p.graph.nodes[0]).sort(), ['action', 'confidence', 'params', 'status', 'target', 'uid']);
  assert.equal(p.graph.nodes[0].status, 'PENDING');
});
