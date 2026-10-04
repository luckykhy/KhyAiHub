'use strict';
// Co-located unit test for ./graphPatch.js — batch B31 (D2 functional-unit conformance).
// Pure leaf (zero IO, deterministic). Ports vocabulary and known types are INJECTED
// (per the leaf contract: it never requires nodeCatalog). Tests supply a local caps
// shim so the unit runs fully offline with no filesystem/socket/timer access.
// Pure node:test; no timers, no sockets, no worker/child processes.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const gp = require('./graphPatch.js');

// A minimal, self-contained nodeCatalog stand-in: enough types to exercise the DSL.
const KNOWN = ['start', 'end', 'prompt', 'ifElse', 'toolCall'];
function portsFor(type) {
  switch (type) {
    case 'start':
      return { inputs: [], outputs: ['default'] };
    case 'end':
      return { inputs: ['input'], outputs: [] };
    case 'prompt':
    case 'toolCall':
      return { inputs: ['input'], outputs: ['default'] };
    case 'ifElse':
      return { inputs: ['input'], outputs: ['true', 'false'] };
    default:
      return { inputs: [], outputs: [] };
  }
}
const caps = { portsFor, knownTypes: KNOWN };

// Two-node base graph: start -> end (valid under the shim above).
function baseGraph() {
  return {
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 'e', type: 'end', data: {} },
    ],
    connections: [{ from: 's', fromPort: 'default', to: 'e', toPort: 'input' }],
  };
}

// ── surface ───────────────────────────────────────────────────────────────────

test('exported surface is exactly the documented 6 keys', () => {
  assert.deepEqual(Object.keys(gp).sort(), [
    'ALLOWED_OPS',
    'MAX_NODES',
    'MAX_REVISIONS',
    'NODE_DELETE_OPS',
    'applyPatch',
    'resolvePatchOps',
  ]);
});

test('constants hold their documented values', () => {
  assert.deepEqual(gp.ALLOWED_OPS, ['addNode', 'connect', 'disconnect']);
  assert.deepEqual(gp.NODE_DELETE_OPS, ['removeNode', 'deleteNode']);
  assert.equal(gp.MAX_NODES, 200);
  assert.equal(gp.MAX_REVISIONS, 50);
});

// ── injection gate (fail-closed) ──────────────────────────────────────────────

test('applyPatch: refuses when portsFor / knownTypes are not injected', () => {
  const r = gp.applyPatch(baseGraph(), [{ op: 'addNode', node: { id: 'x', type: 'prompt' } }], {});
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /缺少 portsFor \/ knownTypes 注入/);
  assert.deepEqual(r.applied, []);
});

test('applyPatch: partial injection (only portsFor) still refuses', () => {
  const r = gp.applyPatch(baseGraph(), [{ op: 'addNode', node: { id: 'x', type: 'prompt' } }], { portsFor });
  assert.equal(r.ok, false);
});

// ── ops shape ─────────────────────────────────────────────────────────────────

test('applyPatch: ops must be a non-empty array', () => {
  assert.match(gp.applyPatch(baseGraph(), 'nope', caps).errors[0], /必须是数组/);
  assert.match(gp.applyPatch(baseGraph(), [], caps).errors[0], /空数组/);
});

// ── addNode ───────────────────────────────────────────────────────────────────

test('applyPatch: addNode succeeds and returns a candidate (input graph untouched)', () => {
  const input = baseGraph();
  const snapshot = JSON.stringify(input);
  const r = gp.applyPatch(input, [{ op: 'addNode', node: { id: 'p', type: 'prompt', name: 'P', data: { a: 1 } } }], caps);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.graph.nodes.length, 3);
  assert.equal(r.graph.nodes.find((n) => n.id === 'p').data.a, 1);
  // Purity: the caller's graph object was not mutated.
  assert.equal(JSON.stringify(input), snapshot);
});

test('applyPatch: addNode rejects dup id / empty id / unknown type', () => {
  assert.match(gp.applyPatch(baseGraph(), [{ op: 'addNode', node: { id: 's', type: 'prompt' } }], caps).errors[0], /已存在/);
  assert.match(gp.applyPatch(baseGraph(), [{ op: 'addNode', node: { id: '', type: 'prompt' } }], caps).errors[0], /id 不能为空/);
  assert.match(gp.applyPatch(baseGraph(), [{ op: 'addNode', node: { id: 'z', type: 'mystery' } }], caps).errors[0], /未知节点类型/);
});

test('applyPatch: addNode honours ctx.maxNodes ceiling', () => {
  const r = gp.applyPatch(baseGraph(), [{ op: 'addNode', node: { id: 'p', type: 'prompt' } }], { ...caps, maxNodes: 2 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /超出节点上限 2/);
});

// ── connect ───────────────────────────────────────────────────────────────────

test('applyPatch: connect adds a legal edge; illegal ports rejected', () => {
  const r = gp.applyPatch(baseGraph(), [{ op: 'addNode', node: { id: 'p', type: 'prompt' } }, { op: 'connect', from: 'p', to: 'e' }], caps);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.graph.connections.length, 2);
  // p's output 'default' -> e's input 'input' is legal via the shim.
  const bad = gp.applyPatch(baseGraph(), [{ op: 'addNode', node: { id: 'p', type: 'prompt' } }, { op: 'connect', from: 'p', fromPort: 'nope', to: 'e' }], caps);
  assert.match(bad.errors[0], /非法源端口 'nope'/);
});

test('applyPatch: connect requires both endpoints to exist', () => {
  assert.match(gp.applyPatch(baseGraph(), [{ op: 'connect', from: 'ghost', to: 'e' }], caps).errors[0], /源节点 'ghost' 不存在/);
  assert.match(gp.applyPatch(baseGraph(), [{ op: 'connect', from: 's', to: 'ghost' }], caps).errors[0], /目标节点 'ghost' 不存在/);
});

test('B31-W9: dup check keys on (from, fromPort, to) — second edge from the SAME output port to a different target is accepted', () => {
  // GraphPatch lets a single node output port fan out to several targets. The
  // executor (workflowExecutor.js:361-364) resolves the next node with
  // edges.find(), so only the FIRST edge on a given (from, fromPort) is ever
  // taken; the second is silently shadowed (dead edge). This is the accepted
  // current behaviour, pinned as a defect.
  const r = gp.applyPatch(baseGraph(), [
    { op: 'addNode', node: { id: 'p', type: 'prompt' } },
    { op: 'addNode', node: { id: 'q', type: 'prompt' } },
    { op: 'connect', from: 'p', to: 'q' },
    { op: 'connect', from: 'p', to: 'e' },
  ], caps);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const pEdges = r.graph.connections.filter((c) => c.from === 'p');
  assert.equal(pEdges.length, 2);
});

test('applyPatch: exact-duplicate edge (same from/fromPort/to) is rejected', () => {
  const r = gp.applyPatch(baseGraph(), [
    { op: 'addNode', node: { id: 'p', type: 'prompt' } },
    { op: 'connect', from: 'p', to: 'e' },
    { op: 'connect', from: 'p', to: 'e' },
  ], caps);
  assert.match(r.errors.find((e) => /重复连接/.test(e)) || '', /重复连接 p:default → e/);
});

// ── disconnect ────────────────────────────────────────────────────────────────

test('applyPatch: disconnect removes a matching edge (edge-level delete allowed)', () => {
  const r = gp.applyPatch(baseGraph(), [{ op: 'disconnect', from: 's', fromPort: 'default', to: 'e' }], caps);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.graph.connections.length, 0);
});

test('applyPatch: disconnect with no to removes every edge on that (from, fromPort)', () => {
  const g = baseGraph();
  g.nodes.push({ id: 'p', type: 'prompt', data: {} });
  g.connections.push({ from: 's', fromPort: 'default', to: 'p', toPort: 'input' });
  const r = gp.applyPatch(g, [{ op: 'disconnect', from: 's' }], caps);
  assert.equal(r.applied[0].removed, 2);
});

test('applyPatch: disconnect fail-closed on no matching edge / missing from', () => {
  assert.match(gp.applyPatch(baseGraph(), [{ op: 'disconnect', from: 'ghost' }], caps).errors[0], /找不到匹配的边/);
  assert.match(gp.applyPatch(baseGraph(), [{ op: 'disconnect' }], caps).errors[0], /需要 from/);
});

// ── node delete forbidden ─────────────────────────────────────────────────────

test('applyPatch: node-level delete ops are refused with a searchable reason', () => {
  for (const op of ['removeNode', 'deleteNode']) {
    const r = gp.applyPatch(baseGraph(), [{ op, id: 's' }], caps);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], new RegExp(`算子 '${op}' 被拒`));
  }
});

test('applyPatch: unknown op is refused', () => {
  assert.match(gp.applyPatch(baseGraph(), [{ op: 'teleport' }], caps).errors[0], /未知算子 'teleport'/);
});

test('applyPatch: non-object op entry is refused', () => {
  assert.match(gp.applyPatch(baseGraph(), [42], caps).errors[0], /不是对象/);
});

// ── transactional validation ──────────────────────────────────────────────────

test('applyPatch: only patch-introduced errors fail the transaction (pre-existing flaws tolerated)', () => {
  // A graph that already violates strict (start has an inbound edge) should NOT
  // block an unrelated, valid addNode: the pre-existing error is filtered out.
  const g = baseGraph();
  g.connections.push({ from: 'p0', to: 's', toPort: 'input' }); // s already has an inbound
  g.nodes.push({ id: 'p0', type: 'prompt', data: {} });
  const r = gp.applyPatch(g, [{ op: 'addNode', node: { id: 'extra', type: 'prompt' } }], caps);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('B31-W1: applyPatch CRASHES when an injected portsFor returns undefined (violates its "never throws" contract)', () => {
  // graphPatch._portsFor guards its OWN calls, but the final transactional
  // validation calls validateGraph (workflowCliCore.js:165/168), which reads
  // portsFor(type).outputs / .inputs WITHOUT a guard. A base graph carrying an
  // edge whose node type resolves to undefined therefore makes applyPatch THROW,
  // contradicting the file-header contract "绝不抛 (一律返回 {ok:false, errors})".
  const crashCaps = { portsFor: () => undefined, knownTypes: ['start', 'end'] };
  assert.throws(
    () => gp.applyPatch(baseGraph(), [{ op: 'addNode', node: { id: 'p', type: 'start' } }], crashCaps),
    TypeError
  );
});

// ── resolvePatchOps ───────────────────────────────────────────────────────────

test('resolvePatchOps: surface + default static ops path', () => {
  assert.deepEqual(gp.resolvePatchOps({ ops: [{ op: 'addNode' }] }), { ok: true, ops: [{ op: 'addNode' }], source: 'ops', errors: [] });
  assert.equal(gp.resolvePatchOps().ok, false);
  assert.match(gp.resolvePatchOps({}).errors[0], /既没有 ops 数组，也没有 onVar/);
  assert.match(gp.resolvePatchOps({ ops: [] }).errors[0], /空数组/);
});

test('resolvePatchOps: onVar non-string-that-was-written is refused with typed reason', () => {
  assert.match(gp.resolvePatchOps({ onVar: 5 }).errors[0], /必须是变量名字符串（收到 数字）/);
  assert.match(gp.resolvePatchOps({ onVar: {} }).errors[0], /收到 对象/);
});

test('resolvePatchOps: blank onVar falls back to static ops; whitespace counts as blank', () => {
  const r = gp.resolvePatchOps({ onVar: '   ', ops: [{ op: 'connect' }] });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'ops');
});

test('resolvePatchOps: onVar reads an array variable directly', () => {
  const r = gp.resolvePatchOps({ onVar: 'patch', vars: { patch: [{ op: 'addNode', node: { id: 'a', type: 'prompt' } }] } });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'onVar:patch');
});

test('resolvePatchOps: onVar parses a JSON-text (fenced) variable into an array', () => {
  const text = '```json\n[{"op":"connect","from":"a","to":"b"}]\n``` tail';
  const r = gp.resolvePatchOps({ onVar: 'patch', vars: { patch: text } });
  assert.equal(r.ok, true);
  assert.equal(r.ops[0].op, 'connect');
});

test('resolvePatchOps: onVar failure modes each have a distinct reason (no silent fallback)', () => {
  // declared onVar => never falls back to ops
  assert.equal(gp.resolvePatchOps({ onVar: 'p', ops: [{ op: 'x' }], vars: {} }).ok, false);
  assert.match(gp.resolvePatchOps({ onVar: 'p', vars: {} }).errors[0], /变量袋里没有/);
  assert.match(gp.resolvePatchOps({ onVar: 'p', vars: { p: 'not json' } }).errors[0], /字符串但不是合法 JSON/);
  assert.match(gp.resolvePatchOps({ onVar: 'p', vars: { p: '{"a":1}' } }).errors[0], /不是补丁数组/);
  assert.match(gp.resolvePatchOps({ onVar: 'p', vars: { p: 123 } }).errors[0], /既不是数组也不是 JSON 文本/);
  assert.match(gp.resolvePatchOps({ onVar: 'p' }).errors[0], /需要 vars 变量袋/);
});
