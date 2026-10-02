'use strict';

// Unit-level contract tests for intentTrees.js (co-located).
// Covers: the built-in fetch-web-content tree shape, per-plan buildParams /
// extractSalvage contracts, the frozen intent registry, getIntentTree lookup
// semantics, and the _textSalvage extraction tables. Pure in-memory — no IO,
// no timers, every sweep bounded (RUNTIME-003 posture).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildWebContentTree,
  getIntentTree,
  INTENT_TREE_BUILDERS,
  _textSalvage,
} = require('./intentTrees');

const LONG = 'x'.repeat(5000);

test('face: module exports exactly the four documented names', () => {
  assert.deepEqual(Object.keys(require('./intentTrees')).sort(), [
    'INTENT_TREE_BUILDERS', '_textSalvage', 'buildWebContentTree', 'getIntentTree',
  ]);
});

test('buildWebContentTree: intent, description, depth and plan roster', () => {
  const tree = buildWebContentTree();
  assert.equal(tree.intent, 'fetch-web-content');
  assert.equal(tree.description, '获取网页内容');
  assert.equal(tree.maxDepth, 3);
  assert.deepEqual(tree.plans.map((p) => [p.plan, p.tool]), [
    ['WebBrowser', 'WebBrowser'],
    ['WebFetch', 'WebFetch'],
    ['WebSearch', 'WebSearch'],
  ]);
  for (const p of tree.plans) {
    assert.equal(p.maxRetry, 1, 'each plan carries the protocol-fixed single retry');
    assert.equal(p.isSuccess, null, 'no custom judge — default success===true semantics');
    assert.equal(p.extractSalvage, _textSalvage, 'all three plans share the same extractor');
  }
  assert.deepEqual(tree.plans.map((p) => p.suggestion), [
    '浏览器渲染失败，多因依赖缺失或目标反爬；可改用轻量抓取或搜索。',
    '直接抓取失败，多因鉴权/限频/动态渲染；可退化到搜索摘要。',
    '搜索兜底也未命中；请核对关键词或更换信息源。',
  ]);
});

test('buildWebContentTree: tree and nodes are frozen (no runtime layer smuggling)', () => {
  const tree = buildWebContentTree();
  assert.ok(Object.isFrozen(tree));
  assert.ok(Object.isFrozen(tree.plans));
  // In strict mode, mutation of any frozen member throws — pin all three sites.
  assert.throws(() => { tree.intent = 'hacked'; }, TypeError);
  assert.throws(() => { tree.plans.push({}); }, TypeError);
  assert.throws(() => { tree.plans[0].tool = 'X'; }, TypeError);
});

test('per-plan buildParams contract (exact surviving shape)', () => {
  const tree = buildWebContentTree();
  const [webBrowser, webFetch, webSearch] = tree.plans;
  const ctx = { intent: 'fetch-web-content', url: 'https://example.com', query: 'q1' };
  assert.deepEqual(webBrowser.buildParams(ctx),
    { url: 'https://example.com', action: 'read', query: 'q1' });
  assert.deepEqual(webFetch.buildParams(ctx), { url: 'https://example.com' });
  assert.deepEqual(webSearch.buildParams(ctx), { query: 'q1' });
  // WebSearch falls back to the url when there is no query…
  assert.deepEqual(webSearch.buildParams({ url: 'u2' }), { query: 'u2' });
  // …and when neither is given the key still exists with value undefined.
  const empty = webSearch.buildParams({});
  assert.deepEqual(Object.keys(empty), ['query']);
  assert.equal(empty.query, undefined);
  assert.deepEqual(webBrowser.buildParams({ url: 'u3' }),
    { url: 'u3', action: 'read', query: undefined });
});

test('INTENT_TREE_BUILDERS: frozen registry with exactly one core intent', () => {
  assert.ok(Object.isFrozen(INTENT_TREE_BUILDERS));
  assert.deepEqual(Object.keys(INTENT_TREE_BUILDERS), ['fetch-web-content']);
  assert.equal(INTENT_TREE_BUILDERS['fetch-web-content'], buildWebContentTree,
    'registry stores the builder itself, no wrapper');
});

test('getIntentTree: hit → fresh frozen tree; miss → null', () => {
  const a = getIntentTree('fetch-web-content');
  const b = getIntentTree('fetch-web-content');
  assert.notEqual(a, b, 'no memoization: every call builds a new tree');
  // Freshly built plans carry NEW buildParams closures, so structural equality is
  // asserted on the data fields only (function identity is pinned in other tests).
  const shape = (t) => ({
    intent: t.intent,
    description: t.description,
    maxDepth: t.maxDepth,
    plans: t.plans.map((p) => ({
      plan: p.plan, tool: p.tool, maxRetry: p.maxRetry,
      isSuccess: p.isSuccess, suggestion: p.suggestion,
    })),
  });
  assert.deepEqual(shape(a), shape(b));
  assert.equal(a.plans[0].extractSalvage, b.plans[0].extractSalvage,
    'extractor is the shared module-level _textSalvage, not a per-build closure');
  assert.ok(Object.isFrozen(a));
  const misses = [
    ['unknown name', 'nope'],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['undefined', undefined],
    ['null', null],
    ['number', 123],
    ['wrong case', 'Fetch-Web-Content'],
  ];
  const failures = [];
  for (const [label, key] of misses) {
    try {
      assert.equal(getIntentTree(key), null, label);
    } catch (e) {
      failures.push(e.message);
    }
  }
  assert.deepEqual(failures, []);
});

test('getIntentTree: trims surrounding whitespace before lookup', () => {
  const t = getIntentTree('  fetch-web-content  ');
  assert.equal(t && t.intent, 'fetch-web-content');
});

// FIXED defect (repro chain: .khy/feedback/b23-resilience-2/repro-before.txt →
// repro-after.txt): the lookup INTENT_TREE_BUILDERS[key] walked the prototype chain,
// so inherited Object.prototype keys leaked a pseudo-tree ('constructor' → {}) or
// threw ('valueOf'/'hasOwnProperty', unbound native calls) instead of answering null.
// The lookup is now own-key only; this test pins the corrected contract.
test('getIntentTree: inherited keys return null — only own keys build a tree', () => {
  for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'nope']) {
    assert.equal(getIntentTree(key), null, key);
  }
});

test('_textSalvage: strings pass through, capped at 4000 chars', () => {
  assert.equal(_textSalvage('plain text'), 'plain text');
  assert.equal(_textSalvage(''), '', 'empty string is still a string — returned as-is');
  assert.equal(_textSalvage(LONG).length, 4000);
  assert.equal(_textSalvage(LONG), LONG.slice(0, 4000));
});

test('_textSalvage: non-object non-string inputs yield null', () => {
  const failures = [];
  for (const v of [null, undefined, 42, true, () => {}]) {
    try {
      assert.equal(_textSalvage(v), null, String(v));
    } catch (e) {
      failures.push(e.message);
    }
  }
  assert.deepEqual(failures, []);
});

test('_textSalvage: candidate precedence, trim, and the whitespace-shadow trap', () => {
  const cases = [
    [{ content: 'c', text: 't', body: 'b', html: 'h' }, 'c'],
    [{ text: 't', body: 'b', html: 'h' }, 't'],
    [{ body: 'b', html: 'h' }, 'b'],
    [{ html: 'h', summary: 's' }, 'h'],
    [{ summary: 's', snippet: 'sn', markdown: 'm' }, 's'],
    [{ snippet: 'sn', markdown: 'm' }, 'sn'],
    [{ markdown: 'm' }, 'm'],
    [{ data: { content: 'dc' } }, 'dc'],
    [{ data: { text: 'dt' } }, 'dt'],
    [{ content: '  padded  ' }, 'padded'],
    // A whitespace-only `content` is truthy so it wins the || chain, then fails
    // the trim gate — sibling candidates are NOT re-tried. Pinned real behavior.
    [{ content: '   ', text: 'real' }, null],
    [{ content: 42, text: 'ok' }, null],
    [{ text: '' }, null],
    [{ data: {} }, null],
  ];
  const failures = [];
  for (const [input, expected] of cases) {
    try {
      assert.equal(_textSalvage(input), expected, JSON.stringify(input));
    } catch (e) {
      failures.push(e.message);
    }
  }
  assert.deepEqual(failures, []);
});

test('_textSalvage: results[] roster → numbered title+url lines, first five only', () => {
  const cases = [
    [{ results: [{ title: 'T1', url: 'U1' }, { name: 'N2', link: 'L2' }] }, '1. T1 U1\n2. N2 L2'],
    // Missing title leaves its empty slot — trim() only touches the line ends, so
    // the separator between the empty title and the url survives as a double space.
    [{ results: [{ url: 'U' }] }, '1.  U'],
    [{ results: [{}] }, '1.'],
    [{ data: { results: [{ title: 't' }] } }, '1. t'],
    [{ results: [] }, null],
    [{ results: 'not-an-array' }, null],
    [{ results: [1, 2, 3, 4, 5, 6].map((n) => ({ title: `t${n}`, url: `u${n}` })) },
      '1. t1 u1\n2. t2 u2\n3. t3 u3\n4. t4 u4\n5. t5 u5'],
  ];
  const failures = [];
  for (const [input, expected] of cases) {
    try {
      assert.equal(_textSalvage(input), expected, JSON.stringify(input));
    } catch (e) {
      failures.push(e.message);
    }
  }
  assert.deepEqual(failures, []);
});

test('_textSalvage: joined roster output is also capped at 4000 chars', () => {
  const out = _textSalvage({
    results: Array.from({ length: 5 }, () => ({ title: 't'.repeat(1200), url: 'u' })),
  });
  assert.equal(out.length, 4000, '5 × 1200+ chars must be sliced to exactly 4000');
  assert.ok(out.startsWith('1. ttt'), 'slicing keeps the head, not the tail');
});

// b23 deliverable additions — the two content-level deviations that were pinned here
// are now FIXED centrally (evidence .khy/feedback/b23-resilience/repro-before.txt,
// and the same own-vs-inherited guard as getIntentTree). These tests assert the
// corrected contract; the `_deviation_note` in the unit manifest was written off.
test('_textSalvage: null/undefined list entries never reach the property reads (绝不抛错)', () => {
  assert.equal(_textSalvage({ results: [null] }), null);
  assert.equal(_textSalvage({ results: [undefined] }), null);
  assert.equal(_textSalvage({ results: [{ title: 'T', url: 'U' }, null, undefined] }), '1. T U');
});

test('_textSalvage: a bare-string entry is used verbatim, not via String.prototype.link', () => {
  const out = _textSalvage({ results: ['https://example.com'] });
  assert.equal(out, '1. https://example.com', 'the actual value survives, no native-code leak');
  assert.ok(!out.includes('native code'), 'String.prototype.link must never be stringified');
  assert.equal(
    _textSalvage({ results: ['a.com', { title: 'B', url: 'b.com' }] }),
    '1. a.com\n2. B b.com',
    'mixed lists keep both kinds',
  );
});
