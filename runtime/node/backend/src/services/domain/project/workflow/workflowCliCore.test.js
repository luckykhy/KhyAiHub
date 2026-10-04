'use strict';
// Co-located unit test for ./workflowCliCore.js — batch B31 (D2 functional-unit conformance).
// Pure leaf (zero IO, deterministic). The env gate KHY_WORKFLOW_CLI is toggled
// inside tests with try/finally restore; nothing else touches the filesystem.
// Pure node:test; no timers, no sockets, no worker/child processes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wf-'));
process.env.KHY_APP_HOME = TMP_HOME;
process.env.KHY_DATA_HOME = TMP_HOME;
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const core = require('./workflowCliCore.js');

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

// ── surface ───────────────────────────────────────────────────────────────────

test('exported surface is exactly the documented 7 keys', () => {
  assert.deepEqual(Object.keys(core).sort(), [
    '_enabled',
    'formatReport',
    'parseInputs',
    'slugify',
    'summarizeGraph',
    'toMermaid',
    'validateGraph',
  ]);
});

// ── gate ─────────────────────────────────────────────────────────────────────

test('_enabled: default on, CANON off-values only', () => {
  assert.equal(withEnv('KHY_WORKFLOW_CLI', undefined, () => core._enabled()), true);
  assert.equal(withEnv('KHY_WORKFLOW_CLI', '0', () => core._enabled()), false);
  assert.equal(withEnv('KHY_WORKFLOW_CLI', 'FALSE', () => core._enabled()), false);
  assert.equal(withEnv('KHY_WORKFLOW_CLI', ' Off ', () => core._enabled()), false);
  assert.equal(withEnv('KHY_WORKFLOW_CLI', 'no', () => core._enabled()), false);
  assert.equal(withEnv('KHY_WORKFLOW_CLI', '1', () => core._enabled()), true);
  // Unknown values default ON (fail-open on the gate itself is documented behaviour).
  assert.equal(withEnv('KHY_WORKFLOW_CLI', 'banana', () => core._enabled()), true);
});

// ── parseInputs ───────────────────────────────────────────────────────────────

test('parseInputs coerces JSON-looking scalars, keeps raw strings', () => {
  assert.deepEqual(core.parseInputs(['n=3', 'b=true', 'nil=null', 's=hello', 'f=1.5']), {
    n: 3,
    b: true,
    nil: null,
    s: 'hello',
    f: 1.5,
  });
});

test('parseInputs: objects/arrays/quoted strings via JSON, containers kept raw when unbalanced', () => {
  assert.deepEqual(core.parseInputs(['j={"a":1}', 'k=[1,2]', 'q="  spaced  "']), {
    j: { a: 1 },
    k: [1, 2],
    q: '  spaced  ',
  });
  // A string starting with { but not valid JSON stays the RAW string.
  assert.deepEqual(core.parseInputs(['x={oops']), { x: '{oops' });
});

test('parseInputs: split at FIRST = only; junk entries skipped fail-soft', () => {
  assert.deepEqual(core.parseInputs(['u=a=b', 'novalue', null, '', '=novar', '  =x']), {
    u: 'a=b',
  });
  assert.deepEqual(core.parseInputs('not-an-array'), {});
  assert.deepEqual(core.parseInputs(undefined), {});
});

test('parseInputs: gate closed returns {} (byte fallback), other exports unaffected', () => {
  // Observation for README: the file header advertises KHY_WORKFLOW_CLI as the unit
  // gate, but ONLY parseInputs consults it — validateGraph is byte-identical with
  // the gate on or off (registering, not fixing: see manifest _mayDependOn_note).
  const ref = core.validateGraph(GOOD);
  withEnv('KHY_WORKFLOW_CLI', '0', () => {
    assert.deepEqual(core.parseInputs(['a=1']), {});
    assert.deepEqual(core.validateGraph(GOOD), ref);
  });
});

// ── validateGraph ─────────────────────────────────────────────────────────────

const PORTS = {
  start: { inputs: [], outputs: ['default'] },
  end: { inputs: ['input'], outputs: [] },
  toolCall: { inputs: ['input'], outputs: ['default'] },
};
const portsFor = (t) => PORTS[t];
const KNOWN = new Set(['start', 'end', 'toolCall']);
const GOOD = {
  nodes: [
    { id: 's', type: 'start' },
    { id: 't', type: 'toolCall' },
    { id: 'e', type: 'end' },
  ],
  connections: [
    { from: 's', fromPort: 'default', to: 't', toPort: 'input' },
    { from: 't', fromPort: 'default', to: 'e', toPort: 'input' },
  ],
};

test('validateGraph: non-object graph is a structured rejection, not a throw', () => {
  assert.deepEqual(core.validateGraph(null), { ok: false, errors: ['graph 必须是对象'] });
  assert.deepEqual(core.validateGraph('str'), { ok: false, errors: ['graph 必须是对象'] });
  // Quirk (README §2): an ARRAY passes `typeof === 'object'`, so [] is treated as
  // an empty-but-valid graph in non-strict mode. Pinned as-is; checkGraphShape is
  // what actually blocks such shapes at save time (see flowRegistry.test.js).
  assert.deepEqual(core.validateGraph([]), { ok: true, errors: [] });
});

test('validateGraph: clean graph passes without and with injected capabilities', () => {
  assert.deepEqual(core.validateGraph(GOOD), { ok: true, errors: [] });
  assert.deepEqual(core.validateGraph(GOOD, { portsFor, knownTypes: KNOWN }), { ok: true, errors: [] });
  assert.deepEqual(core.validateGraph(GOOD, { portsFor, knownTypes: KNOWN, strict: true }), {
    ok: true,
    errors: [],
  });
});

test('validateGraph: structural errors accumulate (dup ids, missing id, dangling edges)', () => {
  const bad = {
    nodes: [
      { id: 'x', type: 'toolCall' },
      { id: 'x', type: 'toolCall' },
      { type: 'toolCall' },
      'not-a-node',
    ],
    connections: [
      { from: 'x', to: 'ghost' },
      { from: 'ghost2', to: 'x' },
      null,
    ],
  };
  const res = core.validateGraph(bad);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('重复节点 id')));
  assert.ok(res.errors.some((e) => e.includes('非法节点条目')));
  assert.ok(res.errors.some((e) => e.includes('不存在的目标节点')));
  assert.ok(res.errors.some((e) => e.includes('不存在的源节点')));
});

test('validateGraph: knownTypes rejects undeclared node types', () => {
  const g = { nodes: [{ id: 'z', type: 'quantumLeap' }], connections: [] };
  const res = core.validateGraph(g, { knownTypes: ['start', 'end'] });
  assert.equal(res.ok, false);
  assert.match(res.errors.join('|'), /未知节点类型 'quantumLeap'/);
});

test('validateGraph: portsFor rejects illegal ports on both sides', () => {
  const g = {
    nodes: [{ id: 's', type: 'start' }, { id: 'e', type: 'end' }],
    connections: [{ from: 's', fromPort: 'loop-body', to: 'e', toPort: 'output' }],
  };
  const res = core.validateGraph(g, { portsFor, knownTypes: KNOWN });
  assert.equal(res.ok, false);
  assert.match(res.errors.join('|'), /非法源端口 'loop-body'/);
  assert.match(res.errors.join('|'), /非法目标端口 'output'/);
});

test('validateGraph strict: exactly-one start, >=1 end, no inbound to start, no outbound from end', () => {
  const twoStarts = {
    nodes: [
      { id: 's1', type: 'start' },
      { id: 's2', type: 'start' },
      { id: 'e', type: 'end' },
    ],
    connections: [{ from: 's1', to: 'e' }],
  };
  assert.match(core.validateGraph(twoStarts, { strict: true }).errors.join('|'), /恰好有一个 start/);

  const noEnd = { nodes: [{ id: 's', type: 'start' }], connections: [] };
  assert.match(core.validateGraph(noEnd, { strict: true }).errors.join('|'), /至少有一个 end/);

  const loopIntoStart = {
    nodes: [
      { id: 's', type: 'start' },
      { id: 't', type: 'toolCall' },
      { id: 'e', type: 'end' },
    ],
    connections: [
      { from: 's', to: 't' },
      { from: 't', to: 's' },
      { from: 't', to: 'e' },
    ],
  };
  assert.match(core.validateGraph(loopIntoStart, { strict: true }).errors.join('|'), /start 节点 s 不应有入边/);
});

test('validateGraph: duplicate connection ids are reported', () => {
  const g = {
    nodes: [
      { id: 's', type: 'start' },
      { id: 'e', type: 'end' },
    ],
    connections: [
      { id: 'c1', from: 's', to: 'e' },
      { id: 'c1', from: 's', to: 'e' },
    ],
  };
  assert.match(core.validateGraph(g).errors.join('|'), /重复连接 id: c1/);
});

test('B31-W1 (medium): validateGraph THROWS on a portsFor that returns undefined for a type', () => {
  // File header contract: "fail-soft 绝不抛". But workflowCliCore.js:165/168 call
  // `portsFor(src.type).outputs` UNGUARDED, while graphPatch.js:96-109 documents
  // exactly why portsFor must be defensively captured. A portsFor that returns
  // undefined for an unknown type (any injection other than the real catalog does)
  // escapes as a TypeError — and it also escapes through graphPatch.applyPatch /
  // expandGraph._validate, breaking THEIR "绝不抛" contracts too.
  const g = {
    nodes: [
      { id: 's', type: 'start' },
      { id: 'h', type: 'ghost' },
      { id: 'e', type: 'end' },
    ],
    connections: [{ from: 's', to: 'h' }, { from: 'h', to: 'e' }],
  };
  assert.throws(
    () => core.validateGraph(g, { portsFor: (t) => (t === 'ghost' ? undefined : PORTS[t]) }),
    TypeError
  );
});

// ── summarizeGraph / toMermaid / formatReport ────────────────────────────────

test('summarizeGraph: counts, first start, all ends, junk nodes skipped', () => {
  const sum = core.summarizeGraph({ ...GOOD, nodes: [...GOOD.nodes, null] });
  assert.equal(sum.nodeCount, 3);
  assert.equal(sum.edgeCount, 2);
  assert.equal(sum.start, 's');
  assert.deepEqual(sum.ends, ['e']);
  assert.deepEqual(sum.typeCounts, { start: 1, toolCall: 1, end: 1 });
  assert.deepEqual(sum.nodes[1], { id: 't', type: 'toolCall', name: 'toolCall' });
});

test('summarizeGraph: tolerant of missing shape; unnamed nodes keep id, typed label', () => {
  const s = core.summarizeGraph({ nodes: [{ id: 'q', type: null, name: 'Q' }] });
  assert.equal(s.typeCounts.unknown, 1);
  assert.equal(s.start, null);
  assert.deepEqual(s.ends, []);
  assert.equal(core.summarizeGraph(null).nodeCount, 0);
});

test('toMermaid: shapes per type, port labels translated, ids sanitized, quotes/newlines escaped', () => {
  const g = {
    nodes: [
      { id: 'a b', type: 'start', name: 'S' },
      { id: 'i', type: 'ifElse', name: 'x"y\nz' },
      { id: 'e', type: 'end', name: 'E' },
    ],
    connections: [
      { from: 'a b', fromPort: 'default', to: 'i' },
      { from: 'i', fromPort: 'branch-true', to: 'e' },
    ],
  };
  const mm = core.toMermaid(g);
  const lines = mm.split('\n');
  assert.equal(lines[0], 'flowchart TD');
  assert.ok(mm.includes('n_a_b(["S (start)"])'));
  assert.ok(mm.includes('n_i{"x\'y z (ifElse)"}')); // quotes -> single, newline -> space
  assert.ok(mm.includes('n_a_b --> n_i'));
  assert.ok(mm.includes('n_i -- 真 --> n_e'));
  assert.equal(core.toMermaid(null), 'flowchart TD');
});

test('formatReport: minimal report renders 2 lines; rich report renders all sections with 20-item caps', () => {
  assert.deepEqual(core.formatReport({}), ['来源:?  名称:?', '节点:0  连接:0']);
  const report = {
    source: 'coze',
    name: 'N',
    nodeCount: 3,
    edgeCount: 2,
    droppedComments: 1,
    droppedEdges: 4,
    typeCounts: { toolCall: 3 },
    unsupported: Array.from({ length: 25 }, (_, i) => ({ cozeType: 't' + i, id: 'i' + i, mappedTo: 'toolCall' })),
    warnings: Array.from({ length: 22 }, (_, i) => 'w' + i),
  };
  const lines = core.formatReport(report);
  assert.ok(lines.some((l) => l.includes('已丢弃注释节点:1')));
  assert.ok(lines.some((l) => l.includes('已丢弃悬空/非法边:4')));
  assert.ok(lines.some((l) => l.includes('toolCall×3')));
  assert.ok(lines.some((l) => l.includes('不支持→映射为 toolCall 占位(25):')));
  // Source format (workflowCliCore.js:313): "  · {cozeType}(节点 {id})→ {mappedTo}"
  assert.ok(lines.some((l) => l.includes('· t0(节点 i0)→ toolCall')));
  assert.ok(lines.some((l) => l.includes('另有 5 个')));
  assert.ok(lines.some((l) => l.includes('另有 2 条')));
});

// ── slugify ──────────────────────────────────────────────────────────────────

test('slugify: keeps CJK + alphanumerics, maps illegal chars to -, collapses, trims, caps 80', () => {
  // Illegal set is [/ \ : * ? " < > | whitespace]; '!' is a legal Windows
  // filename char and intentionally survives. '/' → '-', whitespace runs → '-'.
  assert.equal(core.slugify('  Hello  World/!  '), 'Hello-World-!');
  assert.equal(core.slugify('整理发票 流程'), '整理发票-流程');
  assert.equal(core.slugify('a\\\\b::c'), 'a-b-c');
  assert.equal(core.slugify(''), 'workflow');
  assert.equal(core.slugify('   '), 'workflow');
  assert.equal(core.slugify('---x---'), 'x');
  assert.equal(core.slugify('x'.repeat(100)).length, 80);
  assert.equal(core.slugify(null), 'workflow');
});

test('B31-W7a (part of W7): slugify preserves case — flow names differing only by case stay distinct strings', () => {
  // On case-insensitive filesystems (Windows/macOS default) these two slugs
  // open THE SAME FILE; the collision consequence is pinned in
  // flowRegistry.test.js (B31-W7).
  assert.equal(core.slugify('Alpha Case'), 'Alpha-Case');
  assert.equal(core.slugify('alpha case'), 'alpha-case');
  assert.notEqual(core.slugify('Alpha Case'), core.slugify('alpha case'));
});
