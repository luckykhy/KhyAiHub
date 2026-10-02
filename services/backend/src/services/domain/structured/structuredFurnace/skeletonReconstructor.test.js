'use strict';

/**
 * skeletonReconstructor.test.js — co-located unit test for skeletonReconstructor.js
 * (D2 unit structuredFurnace). Pure node:test, synchronous, zero I/O.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { reconstruct, splitSlices, REVERSAL_RE, NEGATION_RE } = require('./skeletonReconstructor');
const { splitClauses } = require('./intentWeaver');
const { adjudicate } = require('./anomalyHandler');
const { EntityRegistry } = require('./entityRegistry');
const S = require('../../project/metaplan/constraintStrategy');

test('module surface: the entry, the slicer and the two lexicons', () => {
  assert.deepEqual(Object.keys(require('./skeletonReconstructor')), [
    'reconstruct',
    'splitSlices',
    'REVERSAL_RE',
    'NEGATION_RE',
  ]);
});

test('splitSlices cuts on terminators, commas and sequence words', () => {
  assert.deepEqual(splitSlices('删除 a.js。清理 b.js！归档 c.js？'), ['删除 a.js', '清理 b.js', '归档 c.js']);
  // 然后/接着 are separators themselves: the connector word is consumed, not kept.
  assert.deepEqual(splitSlices('先备份，然后清理，接着归档'), ['先备份', '清理', '归档']);
  assert.deepEqual(splitSlices('a；b；c'), ['a', 'b', 'c']);
  assert.deepEqual(splitSlices(''), []);
  assert.deepEqual(splitSlices(undefined), []);
});

test('the L2 slicer is deliberately finer than the L1 weaver', () => {
  // 再 followed by a non-punctuation character also cuts (skeletonReconstructor.js:24),
  // and it does not need any punctuation — L1 keeps such a run as one clause.
  assert.deepEqual(splitSlices('先做A再做B再做C'), ['先做A', '做B', '做C']);
  const { splitClauses } = require('./intentWeaver');
  assert.deepEqual(splitClauses('先做A再做B再做C').map((c) => c.text), ['先做A再做B再做C']);
});

// B31-F21: the header comment (skeletonReconstructor.js:9) promises slicing on
// 「句末标点与显式转折/反悔词」, but SENTENCE_SPLIT_RE (line 24) contains no reversal
// word at all. An unpunctuated 但是 therefore stays inside ONE slice, and since a
// reversal only counts for i > 0 (line 58) the contradiction is never even marked —
// the layer that is supposed to surface chaos silently misses its headline case.
test('B31-F21 但是 without punctuation never becomes a slice boundary (current, wrong)', () => {
  assert.deepEqual(splitSlices('把 a.js 删了但是保留 b.js'), ['把 a.js 删了但是保留 b.js']);
  const p = reconstruct('把 a.js 删了但是保留 b.js');
  assert.equal(p.machine.states.length, 1);
  assert.deepEqual(p.contradictions, []);
  assert.equal(p.hasContradictions, false);
  // Same intent, one full stop added, and the contradiction becomes visible.
  const q = reconstruct('把 a.js 删了。但是保留 b.js');
  assert.equal(q.contradictions.length, 1);
  assert.equal(q.machine.states[1].status, 'CONFLICT');
});

test('reconstruct emits one state per slice plus a next-chain', () => {
  const p = reconstruct('读取 a.js，删除 b.js，归档 c.js');
  assert.deepEqual(Object.keys(p), [
    'kind',
    'uid',
    'machine',
    'entities',
    'strategy',
    'confidence',
    'hasContradictions',
    'contradictions',
  ]);
  assert.equal(p.kind, 'StateMachine');
  assert.match(p.uid, /^sm_[0-9a-f]{8}$/);
  assert.equal(p.machine.states.length, 3);
  assert.equal(p.machine.transitions.length, 2);
  assert.deepEqual(p.machine.transitions.map((t) => t.on), ['next', 'next']);
  assert.equal(p.machine.initial, p.machine.states[0].uid);
  assert.deepEqual(
    p.machine.transitions.map((t) => [t.from, t.to]),
    [
      [p.machine.states[0].uid, p.machine.states[1].uid],
      [p.machine.states[1].uid, p.machine.states[2].uid],
    ],
  );
});

test('state names carry the action and the entity pointer, slices are capped at 80 chars', () => {
  const p = reconstruct('读取 a.js，' + '字'.repeat(120));
  assert.match(p.machine.states[0].name, /^READ:file_/);
  assert.equal(p.machine.states[1].slice.length, 80);
  assert.equal(p.machine.states[1].slice, '字'.repeat(80));
});

test('an empty input is a shape-complete StateMachine with no states', () => {
  const p = reconstruct('');
  assert.deepEqual(p.machine, { initial: null, states: [], transitions: [], contradictions: [] });
  assert.equal(p.confidence, 1);
  assert.equal(p.hasContradictions, false);
  assert.equal(p.strategy, S.STRATEGIES.PROMPT_SOFT);
});

test('confidence is the minimum over the slices', () => {
  assert.equal(reconstruct('读取 a.js，可能删除 b.js').confidence, 0.6);
  assert.equal(reconstruct('读取 a.js，删除 b.js').confidence, 1);
});

test('risk lifts the L2 baseline strategy', () => {
  assert.equal(reconstruct('读取 a.js，删除 b.js').strategy, S.STRATEGIES.CODE_HARD);
  assert.equal(reconstruct('读取 a.js，归档 b.js').strategy, S.STRATEGIES.PROMPT_SOFT);
});

test('reconstruct is deterministic and reuses the given registry', () => {
  const a = reconstruct('读取 a.js，删除 a.js');
  const b = reconstruct('读取 a.js，删除 a.js');
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  const r = new EntityRegistry();
  reconstruct('读取 a.js', r);
  const second = reconstruct('删除 a.js', r);
  assert.equal(Object.keys(second.entities).length, 1);
  assert.equal(Object.values(second.entities)[0].mentions, 2);
});

test('a reversal marker flags the state CONFLICT and records one contradiction', () => {
  const p = reconstruct('删除 a.js，但是保留 b.js');
  assert.equal(p.hasContradictions, true);
  assert.deepEqual(p.contradictions.map((c) => c.reason), ['reversal-marker']);
  assert.equal(p.machine.states[1].status, 'CONFLICT');
  assert.equal(p.machine.states[0].status, 'PENDING');
  assert.deepEqual(
    [p.contradictions[0].a, p.contradictions[0].b],
    [p.machine.states[0].uid, p.machine.states[1].uid],
  );
});

test('the first slice can never be a reversal (no predecessor to contradict)', () => {
  const p = reconstruct('取消 a.js，读取 b.js');
  assert.deepEqual(p.contradictions, []);
  assert.equal(p.machine.states[0].status, 'PENDING');
});

// B31-F3 (a): the reversal lexicon REVERSAL_RE (skeletonReconstructor.js:27-28)
// counts 取消 / 撤销 / 反悔 / cancel / undo as "the previous slice is contradicted".
// Those are ordinary UI/file verbs in Chinese ("取消隐藏文件夹" = unhide,
// "取消只读属性" = clear the read-only attribute), so every one of them mints a
// contradiction against its predecessor. Two of them and anomalyHandler
// (CONTRADICTION_DEGRADE_MAX = 1) rejects the whole input as
// "存在多处自相矛盾" — a human is then asked to clarify instructions that never
// contradicted anything.
test('B31-F3 two innocent 取消 slices pile up as contradictions (current, wrong)', () => {
  const p = reconstruct('取消隐藏文件夹，取消只读属性');
  assert.deepEqual(p.contradictions.map((c) => c.reason), ['reversal-marker']);
  assert.equal(p.machine.states[1].status, 'CONFLICT');
  const three = reconstruct('选中全部文件，取消隐藏文件夹，取消只读属性，推翻前面的选择');
  assert.equal(three.contradictions.length, 3);
  assert.equal(
    three.contradictions.filter((c) => c.reason === 'reversal-marker').length,
    3,
  );
  // CONFLICT status is only a mark; the adjudicator is the one that refuses.
  assert.throws(
    () => adjudicate({ payload: three, contradictions: three.contradictions }),
    (err) => err.name === 'FurnaceRejection' && err.kind === 'CONTRADICTION' &&
      err.conflicts.length === 3,
  );
});

// B31-F3 (b): the two lexicons disagree about what a contradiction IS.
// entropyAssessor.CONTRADICTION_RE (which decides whether the input even reaches the
// L2 reconstructor) does not contain 取消 / 撤销 / cancel / undo, while
// REVERSAL_RE (which decides whether a slice is a contradiction) does. So the same
// text is declared "coherent" by the router and "self-contradictory" by the collapse
// layer, and the verdict depends on which list happens to fire.
test('B31-F3 the routing lexicon and the marking lexicon disagree', () => {
  const { CONTRADICTION_RE } = require('./entropyAssessor');
  const { assess } = require('./entropyAssessor');
  const t = '选中全部文件，取消隐藏文件夹，取消只读属性';
  assert.equal(REVERSAL_RE.test(t), true, 'the L2 collapse layer sees contradictions');
  assert.equal(CONTRADICTION_RE.test(t), false, 'the router does not');
  assert.equal(assess(t).level, 'L0', 'so the text never reaches the layer that flagged it');
});

test('a negated directive on the same entity is flagged as contradictory', () => {
  const p = reconstruct('删除 a.js，不要删除 a.js');
  assert.deepEqual(p.contradictions.map((c) => c.reason), ['contradictory-directive-on-entity']);
  assert.equal(p.machine.states[1].status, 'CONFLICT');
});

// B31-F3 (c): NEGATION_RE lists a bare 别 (skeletonReconstructor.js:31), which is a
// morpheme inside 别的 / 特别 / 识别, so a plain affirmative clause reads as negated.
// Combined with the "same action, same target, different polarity" rule this invents
// a contradiction between two instructions that agree.
test('B31-F3 别的 makes an affirmative clause look negated (current, wrong)', () => {
  assert.equal(NEGATION_RE.test('别的读取 a.js'), true);
  assert.equal(NEGATION_RE.test('特别读取 a.js'), true);
  assert.equal(NEGATION_RE.test('识别 a.js'), true);
  const p = reconstruct('读取 a.js，别的读取 a.js');
  assert.deepEqual(p.contradictions.map((c) => c.reason), ['contradictory-directive-on-entity']);
});

test('a different entity never triggers the polarity rule', () => {
  const p = reconstruct('读取 a.js，不要读取 b.js');
  assert.deepEqual(p.contradictions, []);
});

test('the polarity memory only keeps the last mention per entity', () => {
  // positive, negative, positive on one entity -> two pairs, both flagged.
  const p = reconstruct('删除 a.js，不要删除 a.js，删除 a.js');
  assert.equal(p.contradictions.length, 2);
  assert.deepEqual(p.contradictions.map((c) => c.reason), [
    'contradictory-directive-on-entity',
    'contradictory-directive-on-entity',
  ]);
});

test('transition confidence mirrors the successor state confidence', () => {
  const p = reconstruct('读取 a.js，可能删除 b.js');
  assert.equal(p.machine.transitions[0].confidence, 0.6);
  assert.equal(p.machine.states[1].confidence, 0.6);
});

test('slice status survives into the sealed machine snapshot', () => {
  const p = reconstruct('读取 a.js');
  assert.deepEqual(Object.keys(p.machine.states[0]).sort(), ['confidence', 'name', 'slice', 'status', 'uid']);
});
