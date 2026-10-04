'use strict';
// Co-located unit test for ./expandTemplate.js — batch B31 (D2 functional-unit conformance).
// Pure leaf (zero IO, deterministic). Ports vocabulary and known types are INJECTED
// (per the leaf contract: it never requires nodeCatalog). No filesystem/socket/timer.
// Pure node:test; no timers, no sockets, no worker/child processes.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ex = require('./expandTemplate.js');

const KNOWN = ['start', 'end', 'prompt', 'expand'];
function portsFor(type) {
  switch (type) {
    case 'start':
      return { inputs: [], outputs: ['default'] };
    case 'end':
      return { inputs: ['input'], outputs: [] };
    case 'prompt':
      return { inputs: ['input'], outputs: ['default'] };
    case 'expand':
      return { inputs: ['input'], outputs: ['default'] };
    default:
      return { inputs: [], outputs: [] };
  }
}
const caps = { portsFor, knownTypes: KNOWN };

// Base graph: start -> expand -> end. The expand node is the fan-out anchor.
function baseGraph() {
  return {
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 'exp', type: 'expand', data: {} },
      { id: 'e', type: 'end', data: {} },
    ],
    connections: [
      { from: 's', fromPort: 'default', to: 'exp', toPort: 'input' },
      { from: 'exp', fromPort: 'default', to: 'e', toPort: 'input' },
    ],
  };
}

// Template fragment: start -> a -> b -> end  (a = entry, b = exit).
function template() {
  const bData = { reused: true };
  return {
    nodes: [
      { id: 'ts', type: 'start', data: {} },
      { id: 'a', type: 'prompt', data: { step: 'a' } },
      { id: 'b', type: 'prompt', data: bData },
      { id: 'te', type: 'end', data: {} },
    ],
    connections: [
      { from: 'ts', fromPort: 'default', to: 'a', toPort: 'input' },
      { from: 'a', fromPort: 'default', to: 'b', toPort: 'input' },
      { from: 'b', fromPort: 'default', to: 'te', toPort: 'input' },
    ],
  };
}

// ── surface ───────────────────────────────────────────────────────────────────

test('exported surface is exactly the documented 5 keys', () => {
  assert.deepEqual(Object.keys(ex).sort(), ['BIND_FIELD', 'MAX_NODES', 'copyId', 'expandGraph', 'extractFragment']);
});

test('copyId builds the <expandId>__<index>__<origId> namespace', () => {
  assert.equal(ex.copyId('exp', 2, 'a'), 'exp__2__a');
});

test('constants hold documented defaults', () => {
  assert.equal(ex.MAX_NODES, 200);
  assert.equal(ex.BIND_FIELD, '__bind');
});

// ── injection gate ────────────────────────────────────────────────────────────

test('expandGraph: refuses without portsFor / knownTypes injection', () => {
  const r = ex.expandGraph(baseGraph(), { expandId: 'exp', template: template(), instances: 1, items: ['x'], successor: 'e' }, {});
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /缺少 portsFor \/ knownTypes 注入/);
});

// ── argument validation ────────────────────────────────────────────────────────

test('expandGraph: expandId required', () => {
  assert.match(ex.expandGraph(baseGraph(), { instances: 0, template: template() }, caps).errors[0], /需要 expandId/);
});

test('expandGraph: instances must be a >=0 integer', () => {
  for (const bad of [-1, 1.5, 'x', undefined]) {
    assert.equal(ex.expandGraph(baseGraph(), { expandId: 'exp', instances: bad, items: [], template: template() }, caps).ok, false, String(bad));
  }
  // (part of B31-W4 coercion family) null => Number(null)=0 is an accepted integer,
  // so a null instances silently degrades to the N=0 no-op instead of being rejected.
  const nullCase = ex.expandGraph(baseGraph(), { expandId: 'exp', instances: null, items: [], template: template() }, caps);
  assert.equal(nullCase.ok, true);
  assert.equal(nullCase.copies, 0);
});

test('expandGraph: items length must equal instances', () => {
  const r = ex.expandGraph(baseGraph(), { expandId: 'exp', instances: 2, items: ['only-one'], template: template(), successor: 'e' }, caps);
  assert.match(r.errors[0], /items 长度（1）必须等于 instances（2）/);
});

test('expandGraph: instances === 0 is a no-op退场 (graph unchanged, entry/exit null)', () => {
  const g = baseGraph();
  const r = ex.expandGraph(g, { expandId: 'exp', instances: 0, items: [], template: template() }, caps);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.copies, 0);
  assert.equal(r.entry, null);
  assert.equal(r.exit, null);
  assert.deepEqual(r.applied, []);
  assert.equal(r.graph.nodes.length, 3);
});

// ── extractFragment ───────────────────────────────────────────────────────────

test('extractFragment: happy path yields entry/exit + trimmed fragment', () => {
  const f = ex.extractFragment(template());
  assert.equal(f.ok, true);
  assert.equal(f.entry, 'a');
  assert.equal(f.exit, 'b');
  assert.equal(f.entryToPort, 'input');
  assert.equal(f.exitFromPort, 'default');
  assert.deepEqual(f.nodes.map((n) => n.id).sort(), ['a', 'b']);
  assert.equal(f.connections.length, 1); // only a->b survives (edges to start/end are cut)
});

test('extractFragment: requires exactly one start and one end', () => {
  const t = template();
  t.nodes.push({ id: 'ts2', type: 'start', data: {} });
  assert.match(ex.extractFragment(t).errors[0], /恰好有一个 start 节点（实际 2）/);
  const t2 = template();
  t2.nodes = t2.nodes.filter((n) => n.type !== 'end');
  assert.match(ex.extractFragment(t2).errors.find((e) => /end 节点/.test(e)) || '', /恰好有一个 end 节点/);
});

test('extractFragment: multi-entry (start with 2 out-edges) is fail-closed', () => {
  const t = template();
  t.nodes.push({ id: 'c', type: 'prompt', data: {} });
  t.connections.push({ from: 'ts', fromPort: 'default', to: 'c', toPort: 'input' });
  const r = ex.extractFragment(t);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /单入口/);
});

test('extractFragment: multi-exit (end with 2 in-edges) is fail-closed', () => {
  const t = template();
  t.connections.push({ from: 'a', fromPort: 'default', to: 'te', toPort: 'input' });
  const r = ex.extractFragment(t);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /单出口/);
});

test('extractFragment: degenerate start->end direct is rejected', () => {
  const t = {
    nodes: [{ id: 'ts', type: 'start' }, { id: 'te', type: 'end' }],
    connections: [{ from: 'ts', fromPort: 'default', to: 'te', toPort: 'input' }],
  };
  assert.match(ex.extractFragment(t).errors[0], /退化为/);
});

test('extractFragment: empty fragment (only start/end) is rejected', () => {
  const t = {
    nodes: [{ id: 'ts', type: 'start' }, { id: 'm', type: 'prompt' }, { id: 'te', type: 'end' }],
    connections: [{ from: 'ts', fromPort: 'default', to: 'm', toPort: 'input' }, { from: 'm', fromPort: 'default', to: 'te', toPort: 'input' }],
  };
  const full = ex.extractFragment(t);
  assert.equal(full.ok, true);
  const empty = ex.extractFragment({ nodes: [{ id: 'ts', type: 'start' }, { id: 'te', type: 'end' }], connections: [] });
  assert.equal(empty.ok, false);
});

// ── expandGraph chain build ────────────────────────────────────────────────────

test('expandGraph: N=2 builds a serial chain with per-copy __bind on entry only', () => {
  const r = ex.expandGraph(baseGraph(), { expandId: 'exp', template: template(), instances: 2, items: ['x', 'y'], successor: 'e' }, caps);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.copies, 2);
  assert.equal(r.entry, 'exp__0__a');
  assert.equal(r.exit, 'exp__1__b');
  // base + 2*(a,b)
  assert.equal(r.graph.nodes.length, 3 + 4);
  const bind0 = r.graph.nodes.find((n) => n.id === 'exp__0__a').data.__bind;
  const bind1 = r.graph.nodes.find((n) => n.id === 'exp__1__a').data.__bind;
  assert.deepEqual(bind0, { var: 'item', value: 'x' });
  assert.deepEqual(bind1, { var: 'item', value: 'y' });
  // non-entry copies carry no __bind
  assert.equal(r.graph.nodes.find((n) => n.id === 'exp__0__b').data.__bind, undefined);
  // chain edges present
  assert.ok(r.graph.connections.some((c) => c.from === 'exp' && c.to === 'exp__0__a'));
  assert.ok(r.graph.connections.some((c) => c.from === 'exp__0__b' && c.to === 'exp__1__a'));
  assert.ok(r.graph.connections.some((c) => c.from === 'exp__1__b' && c.to === 'e'));
});

test('expandGraph: custom itemVar is honoured', () => {
  const r = ex.expandGraph(baseGraph(), { expandId: 'exp', template: template(), instances: 1, items: [42], itemVar: 'row', successor: 'e' }, caps);
  assert.deepEqual(r.graph.nodes.find((n) => n.id === 'exp__0__a').data.__bind, { var: 'row', value: 42 });
});

test('expandGraph: purity — input graph and template are not mutated', () => {
  const g = baseGraph();
  const t = template();
  const gs = JSON.stringify(g);
  const ts = JSON.stringify(t);
  ex.expandGraph(g, { expandId: 'exp', template: t, instances: 2, items: ['p', 'q'], successor: 'e' }, caps);
  assert.equal(JSON.stringify(g), gs);
  assert.equal(JSON.stringify(t), ts);
});

test('expandGraph: maxNodes ceiling rejects an over-large expansion', () => {
  // base=3, fragment=2, instances=3 => projected 3+6=9 > maxNodes 5
  const r = ex.expandGraph(baseGraph(), { expandId: 'exp', template: template(), instances: 3, items: ['a', 'b', 'c'], successor: 'e' }, { ...caps, maxNodes: 5 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /超出上限 5/);
});

test('expandGraph: successor declared but no matching default out-edge is fail-closed', () => {
  const g = baseGraph();
  g.connections = g.connections.filter((c) => c.from !== 'exp'); // remove exp -> e
  const r = ex.expandGraph(g, { expandId: 'exp', template: template(), instances: 1, items: ['x'], successor: 'e' }, caps);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /没有到后继 e 的 default 出边/);
});

test('B31-W8: non-entry copies ALIAS the template node data object (shared reference across copies)', () => {
  // expandTemplate.js:296 does `{ ...fn }` for every fragment node; only the ENTRY
  // node gets a fresh `data` object (line 298). Non-entry copies therefore all share
  // the SAME template node's data reference. Mutating one copy's non-entry node data
  // mutates every other copy AND the original template.
  const t = template();
  const r = ex.expandGraph(baseGraph(), { expandId: 'exp', template: t, instances: 2, items: ['x', 'y'], successor: 'e' }, caps);
  const b0 = r.graph.nodes.find((n) => n.id === 'exp__0__b');
  const b1 = r.graph.nodes.find((n) => n.id === 'exp__1__b');
  assert.equal(b0.data, b1.data); // aliased
  assert.equal(b0.data, t.nodes.find((n) => n.id === 'b').data); // === the template
  // entry copies, by contrast, each own a fresh data object
  const a0 = r.graph.nodes.find((n) => n.id === 'exp__0__a');
  const a1 = r.graph.nodes.find((n) => n.id === 'exp__1__a');
  assert.notEqual(a0.data, a1.data);
});

test('expandGraph: propagates extractFragment failures verbatim', () => {
  const badTpl = template();
  badTpl.nodes.push({ id: 'ts2', type: 'start', data: {} });
  const r = ex.expandGraph(baseGraph(), { expandId: 'exp', template: badTpl, instances: 1, items: ['x'], successor: 'e' }, caps);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /start 节点/);
});
