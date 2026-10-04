'use strict';
// Co-located unit test for ./flowRegistry.js — batch B31 (D2 functional-unit conformance).
// The IO layer (save/load/list/remove/find) is exercised against a THROWAWAY data
// home: KHY_APP_HOME / KHY_DATA_HOME / KHY_PROJECT_DATA_HOME are pinned to an
// fs.mkdtempSync directory BEFORE require, so getAppDataDir('workflows') resolves
// there and nothing is ever written into the real repository or user profile.
// No sockets, no child processes, no timers. Pure node:test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wf-'));
process.env.KHY_APP_HOME = TMP_HOME;
process.env.KHY_DATA_HOME = TMP_HOME;
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const fr = require('./flowRegistry.js');

// Two distinct, structurally valid canonical graphs (both pass validateGraph-without-
// caps + checkGraphShape because each has exactly one start and one end).
function graphA() {
  return {
    nodes: [{ id: 's', type: 'start', data: {} }, { id: 'e', type: 'end', data: {} }],
    connections: [{ from: 's', to: 'e' }],
  };
}
function graphB() {
  return {
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 't', type: 'toolCall', data: { tool: 'x' } },
      { id: 'e', type: 'end', data: {} },
    ],
    connections: [{ from: 's', to: 't' }, { from: 't', to: 'e' }],
  };
}

// ── surface ───────────────────────────────────────────────────────────────────

test('exported surface is exactly the documented 11 keys', () => {
  assert.deepEqual(Object.keys(fr).sort(), [
    'checkGraphShape',
    'computeGraphHash',
    'find',
    'list',
    'load',
    'overlapScore',
    'remove',
    'save',
    'scoreFlow',
    'stableStringify',
    'tokenize',
  ]);
});

// ── stableStringify ────────────────────────────────────────────────────────────

test('stableStringify sorts object keys recursively; arrays keep order', () => {
  // Input { b: 1, a: 2 } has a=2, b=1; keys sort to [a, b] -> values [2, 1].
  assert.equal(fr.stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(fr.stableStringify({ a: { z: 1, y: 2 } }), '{"a":{"y":2,"z":1}}');
  assert.equal(fr.stableStringify([2, 1, 3]), '[2,1,3]');
  assert.equal(fr.stableStringify(null), 'null');
  assert.equal(fr.stableStringify(7), '7');
});

// ── computeGraphHash ─────────────────────────────────────────────────────────

test('computeGraphHash is key-order invariant and ignores non-graph fields', () => {
  const g1 = { nodes: [{ id: 's', type: 'start' }], connections: [] };
  const g2 = { connections: [], nodes: [{ type: 'start', id: 's' }] };
  assert.equal(fr.computeGraphHash(g1), fr.computeGraphHash(g2));
  // _meta is excluded from the hash payload.
  assert.equal(fr.computeGraphHash({ nodes: [], connections: [], _meta: { x: 1 } }), fr.computeGraphHash({ nodes: [], connections: [] }));
  assert.equal(fr.computeGraphHash(null), fr.computeGraphHash({}));
  // A different graph hashes differently.
  assert.notEqual(fr.computeGraphHash(graphA()), fr.computeGraphHash(graphB()));
});

// ── tokenize ─────────────────────────────────────────────────────────────────

test('tokenize lowercases latin words and bigrams Chinese runs', () => {
  assert.deepEqual([...fr.tokenize('Foo Bar')].sort(), ['bar', 'foo']);
  assert.deepEqual([...fr.tokenize('')], []);
  // single-char Chinese run -> unigram
  assert.deepEqual([...fr.tokenize('整')], ['整']);
  // two-char run -> one bigram; three-char -> two bigrams
  assert.deepEqual([...fr.tokenize('整理')], ['整理']);
  assert.deepEqual([...fr.tokenize('整发票')].sort(), ['发票', '整发']);
});

// ── overlapScore ───────────────────────────────────────────────────────────────

test('overlapScore reports query-coverage fraction, 0 when either side empty', () => {
  const q = fr.tokenize('alpha beta');
  assert.equal(fr.overlapScore(q, fr.tokenize('alpha')), 0.5);
  assert.equal(fr.overlapScore(q, fr.tokenize('gamma')), 0);
  assert.equal(fr.overlapScore(q, new Set()), 0);
  assert.equal(fr.overlapScore(new Set(), q), 0);
});

// ── checkGraphShape ────────────────────────────────────────────────────────────

test('checkGraphShape catches shapes validateGraph lets through', () => {
  assert.equal(fr.checkGraphShape(graphA()).ok, true);
  assert.match(fr.checkGraphShape({}).errors[0], /nodes 必须为非空数组/);
  assert.match(fr.checkGraphShape({ nodes: [{ id: 's', type: 'start' }] }).errors[0], /缺少 end/);
  assert.match(fr.checkGraphShape({ nodes: [{ id: 'e', type: 'end' }] }).errors[0], /缺少 start/);
  assert.match(
    fr.checkGraphShape({ nodes: [{ id: 'a', type: 'start' }, { id: 'b', type: 'start' }, { id: 'e', type: 'end' }] }).errors.find((x) => /1 个 start/.test(x)) || '',
    /只能有 1 个 start/
  );
});

// ── scoreFlow ──────────────────────────────────────────────────────────────────

test('scoreFlow weights intent/tags/name and scales by success rate + platform', () => {
  const flow = { name: 'alpha', _meta: { intent: 'alpha' } };
  const base = fr.scoreFlow('alpha', flow, {});
  assert.equal(base.platformMismatch, false);
  // 0.5 (intent) + 0.2 (name) = 0.7 with no tags, no success-rate applied.
  assert.equal(Math.round(base.score * 1000) / 1000, 0.7);
  // successRate 1.0 multiplies by 1.2 (0.8 + 0.4*1).
  assert.equal(Math.round(fr.scoreFlow('alpha', flow, { successRate: 1 }).score * 1000) / 1000, 0.84);
  // platform mismatch halves the score.
  const mm = fr.scoreFlow('alpha', { name: 'alpha', _meta: { intent: 'alpha', platform: 'aix' } }, { platform: 'win32' });
  assert.equal(mm.platformMismatch, true);
  assert.equal(Math.round(mm.score * 1000) / 1000, 0.35);
});

// ── save / load / idempotency / versioning ───────────────────────────────────

test('save + load round-trip; identical graph is idempotent; changed graph bumps version', () => {
  const r1 = fr.save('Reg Flow', graphA(), { intent: 'demo', createdBy: 'agent' });
  assert.equal(r1.ok, true, JSON.stringify(r1.errors || ''));
  assert.equal(r1.version, 1);
  assert.equal(r1.unchanged, false);

  const r2 = fr.save('Reg Flow', graphA());
  assert.equal(r2.unchanged, true);
  assert.equal(r2.version, 1);

  const r3 = fr.save('Reg Flow', graphB());
  assert.equal(r3.unchanged, false);
  assert.equal(r3.version, 2);

  const loaded = fr.load('Reg Flow');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.flow._meta.version, 2);
  assert.equal(loaded.flow._meta.previousVersion, 1);
  assert.equal(loaded.flow.nodes.length, 3);
});

test('save refuses a structurally invalid graph (no end node)', () => {
  const bad = { nodes: [{ id: 's', type: 'start', data: {} }], connections: [] };
  const r = fr.save('NoEnd', bad);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(';'), /缺少 end/);
});

test('load of a missing flow is fail-soft (ok:false)', () => {
  const r = fr.load('Does Not Exist At All');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /流程不存在/);
});

// ── heal claim gate integration ──────────────────────────────────────────────

test('save honours a valid heal claim (root node exists in previous version) and stamps healDepth', () => {
  fr.save('Heal Flow', graphA()); // v1 nodes: s, e
  const r = fr.save('Heal Flow', graphB(), { healedFrom: 's' }); // 's' is in v1
  assert.equal(r.ok, true, JSON.stringify(r.errors || ''));
  assert.equal(r.version, 2);
  const flow = fr.load('Heal Flow').flow;
  assert.equal(flow._meta.healedFrom, 's');
  assert.equal(flow._meta.healDepth, 1);
});

test('save rejects a fabricated heal claim (root node not in previous version)', () => {
  fr.save('Phantom Heal', graphA());
  const r = fr.save('Phantom Heal', graphB(), { healedFrom: 'ghost' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(';'), /不在上一版流程中/);
});

test('save rejects "same graph + healedFrom" as a hallucinated heal (no silent drop)', () => {
  fr.save('Noop Heal', graphA());
  const r = fr.save('Noop Heal', graphA(), { healedFrom: 's' }); // unchanged graph
  assert.equal(r.ok, false);
  assert.match(r.errors.join(';'), /逐字节相同/);
});

// ── list / remove ──────────────────────────────────────────────────────────────

test('list surfaces stored flows with a _meta summary; remove deletes them', () => {
  fr.save('Listed Flow', graphA(), { intent: '整理 发票', tags: ['finance'], contract: [{ type: 'fileExists', path: 'x' }] });
  const listed = fr.list();
  assert.equal(listed.ok, true);
  // slugify preserves case, so 'Listed Flow' -> slug 'Listed-Flow'.
  const item = listed.flows.find((f) => f.slug === 'Listed-Flow');
  assert.ok(item, 'Listed-Flow should appear');
  assert.equal(item._meta.intent, '整理 发票');
  assert.deepEqual(item._meta.tags, ['finance']);
  assert.match(item._meta.contract, /1 条断言\(fileExists\)/);

  const rm = fr.remove('Listed Flow');
  assert.equal(rm.ok, true);
  assert.equal(rm.removed, true);
  assert.equal(fr.remove('Listed Flow').removed, false); // fail-soft on already-gone
});

// ── find (intent matching) ─────────────────────────────────────────────────────

test('find ranks matching flows by intent and drops zero-score ones', () => {
  fr.save('Find Alpha', graphA(), { intent: '整理 发票 流程', tags: ['invoice'] });
  const hits = fr.find('整理 发票');
  assert.ok(Array.isArray(hits));
  assert.ok(hits.some((h) => h.name === 'Find Alpha' && h.score > 0));
  // Every returned entry must have a positive score.
  assert.ok(hits.every((h) => h.score > 0));
  // A query that shares no token with any flow yields an empty result.
  assert.deepEqual(fr.find('totally unrelated zzzqxx'), []);
});

// ── B31-W7: Windows case-insensitive flow-file collision ───────────────────────

test('B31-W7: flow names differing only by case collide on a case-insensitive filesystem (one flow overwrites the other)', () => {
  // slugify preserves case, so 'Alpha Case' -> 'Alpha-Case' and 'alpha case' ->
  // 'alpha-case' are DIFFERENT slugs on Linux but resolve to the SAME file on
  // Windows/macOS. When they collide the second save reads back the first file's
  // meta (version 2) and then overwrites it, so list() loses one of the flows.
  const r1 = fr.save('Alpha Case', graphA());
  const r2 = fr.save('alpha case', graphB());
  if (r2.version === 2) {
    // Case-insensitive FS (this repo runs on win32): collision observed.
    assert.equal(r1.version, 1);
    const matched = fr.list().flows.filter((f) => /alpha.case/i.test(f.slug));
    assert.equal(matched.length, 1);
    assert.equal(fr.load('Alpha Case').flow.nodes.length, 3); // graphA's start->end was overwritten by graphB
  } else {
    // Case-sensitive FS: the two names keep separate files; no collision occurs.
    assert.equal(r2.version, 1);
    assert.equal(fr.list().flows.filter((f) => /alpha.case/i.test(f.slug)).length, 2);
  }
});

// ── corrupt file handling (fail-soft) ──────────────────────────────────────────

test('list skips corrupt flow files and reports them as warnings', () => {
  const dir = path.join(TMP_HOME, 'workflows');
  fs.writeFileSync(path.join(dir, 'broken-flow.json'), '{ this is not json', 'utf8');
  const listed = fr.list();
  assert.equal(listed.ok, true);
  assert.ok(listed.warnings.some((w) => /broken-flow\.json/.test(w)));
  assert.equal(listed.flows.some((f) => f.slug === 'broken-flow'), false);
});
