'use strict';

/**
 * entropyAssessor.test.js — co-located unit test for entropyAssessor.js (D2 unit
 * structuredFurnace). Pure node:test, synchronous, zero I/O.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  assess,
  hasCausalDependency,
  CAUSAL_TEMPORAL_RE,
  MULTI_ACTION_RE,
  CONTRADICTION_RE,
  ENUMERATION_RE,
} = require('./entropyAssessor');

test('module surface: two functions and the four shared lexicons', () => {
  assert.deepEqual(Object.keys(require('./entropyAssessor')), [
    'assess',
    'hasCausalDependency',
    'CAUSAL_TEMPORAL_RE',
    'MULTI_ACTION_RE',
    'CONTRADICTION_RE',
    'ENUMERATION_RE',
  ]);
});

test('the exported lexicons are non-global, so shared .test() calls cannot drift lastIndex', () => {
  for (const [name, re] of Object.entries({ CAUSAL_TEMPORAL_RE, MULTI_ACTION_RE, CONTRADICTION_RE, ENUMERATION_RE })) {
    assert.ok(re instanceof RegExp, name);
    assert.equal(re.global, false, `${name} must not be /g`);
    assert.equal(re.lastIndex, 0);
    re.test('然后 并且 但是 - a');
    assert.equal(re.lastIndex, 0, `${name} stays stateless`);
  }
});

test('assess returns the documented three-field shape', () => {
  const r = assess('删除 a.js');
  assert.deepEqual(Object.keys(r), ['entropy', 'level', 'signals']);
  assert.deepEqual(Object.keys(r.signals), ['length', 'sentences', 'causal', 'multiAction', 'contradiction', 'enumerated']);
  assert.equal(typeof r.entropy, 'number');
  assert.equal(r.level, 'L0');
});

test('a single plain command is L0 with a near-zero entropy', () => {
  const r = assess('删除 a.js');
  assert.equal(r.signals.length, 7);
  assert.equal(r.signals.sentences, 1);
  assert.equal(r.signals.causal, 0);
  assert.equal(r.signals.enumerated, false);
  assert.ok(r.entropy >= 0 && r.entropy < 0.05, `entropy=${r.entropy}`);
});

test('non-string input is coerced, and undefined collapses to the empty case', () => {
  assert.equal(assess(undefined).signals.length, 0);
  assert.equal(assess(null).level, 'L0');
  assert.equal(assess(12345).signals.length, 5);
});

// B31-F5: the entropy sum is clamped only at the TOP (entropyAssessor.js:80 uses
// Math.min(1, ...)), while the sentence term is `sat(sentences - 1, 2)` and sat()
// is `1 - exp(-x/k)` — negative for x < 0. An input with zero sentences (empty or
// whitespace-only) therefore yields a NEGATIVE entropy, outside the "0..1 归一熵分"
// the JSDoc promises at entropyAssessor.js:60. assess() is part of the public
// surface (index.js:57), so any consumer treating it as a normalized score
// (percentages, thresholds, comparisons) gets a nonsense value.
test('B31-F5 entropy leaves the documented 0..1 band for sentence-less input (current, wrong)', () => {
  const empty = assess('');
  assert.equal(empty.entropy, -0.1038);
  assert.ok(empty.entropy < 0, 'outside the documented range');
  assert.equal(empty.signals.sentences, 0);
  assert.ok(assess('   \n ').entropy < 0);
  assert.ok(assess('\n').entropy < 0);
  // One sentence is already enough to get back inside the band.
  assert.ok(assess('，').entropy >= 0);
  assert.equal(assess('删除 a.js').level, 'L0', 'routing itself is unaffected');
});

test('sentences are counted on CJK and ASCII terminators plus newlines, not on commas', () => {
  assert.equal(assess('打开。关闭。启动。').signals.sentences, 3);
  assert.equal(assess('open! close? again\n').signals.sentences, 3);
  assert.equal(assess('打开，关闭，启动').signals.sentences, 1);
  assert.equal(assess('   ').signals.sentences, 0);
});

test('three sentences alone are enough to leave L0 (dependency by volume)', () => {
  const r = assess('打开它。关掉它。启动它。');
  assert.equal(r.signals.sentences, 3);
  assert.equal(r.level, 'L1');
});

test('causal / temporal markers route to L1', () => {
  for (const t of ['先备份然后清理', '如果 a.js 存在就删除', '等构建完成后再部署', 'back up first, then delete']) {
    assert.equal(assess(t).level, 'L1', t);
    assert.ok(assess(t).signals.causal >= 1, t);
  }
});

test('multi-action markers route to L1', () => {
  assert.equal(assess('备份 a.js 并且清理 b.js').level, 'L1');
  assert.equal(assess('备份 a.js；清理 b.js').level, 'L1');
});

test('enumeration markers route to L1', () => {
  assert.equal(assess('1. 备份\n2. 清理').signals.enumerated, true);
  assert.equal(assess('一、备份').signals.enumerated, true);
  assert.equal(assess('- 备份').signals.enumerated, true);
  assert.equal(assess('1. 备份 2. 清理').level, 'L1');
});

test('a contradiction marker outranks the dependency markers and forces L2', () => {
  const r = assess('先备份，然后清理，但是我改主意了');
  assert.ok(r.signals.contradiction >= 1, `contradiction=${r.signals.contradiction}`);
  assert.equal(r.level, 'L2');
});

test('long input forces L2 through the length channel', () => {
  const long = '删'.repeat(400);
  assert.equal(assess(long).signals.length, 400);
  assert.equal(assess(long).level, 'L2');
  assert.equal(assess(long.slice(0, 399)).level, 'L0');
});

test('six sentences force L2 even with no lexical signal at all', () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `${x} 号任务`).join('。') + '。';
  const r = assess(six);
  assert.equal(r.signals.sentences, 6);
  assert.equal(r.signals.contradiction, 0);
  assert.equal(r.level, 'L2');
});

test('entropy is reported to four decimals and stays inside the upper clamp', () => {
  const r = assess('如果先备份，然后清理，但是我又想撤销，同时还要重建，之后部署。'.repeat(20));
  assert.ok(r.entropy > 0.9 && r.entropy <= 1, `entropy=${r.entropy}`);
  // The weights sum to 1 and every channel saturates strictly below 1, so the
  // Math.min(1, ...) ceiling of entropyAssessor.js:80 is never reached in practice.
  assert.notEqual(r.entropy, 1);
  const s = assess('打开 a.js');
  assert.equal(s.entropy, Number(s.entropy.toFixed(4)));
});

test('hasCausalDependency mirrors the three lexical channels', () => {
  assert.equal(hasCausalDependency('备份然后清理'), true);
  assert.equal(hasCausalDependency('备份并且清理'), true);
  assert.equal(hasCausalDependency('1. 备份'), true);
  assert.equal(hasCausalDependency('删除 a.js'), false);
  assert.equal(hasCausalDependency(''), false);
  assert.equal(hasCausalDependency(undefined), false);
});

// B31-F4 (second half): the JSDoc at entropyAssessor.js:110 sells hasCausalDependency
// as "防呆②的判据，供织网器/校验器复用", but it has zero consumers in the repository
// (disk walk) and it does not agree with assess(): the router also treats
// `sentences >= 3` as a dependency and also promotes on contradiction/length, while
// this predicate ignores all three. So even if a caller adopted it, it would not
// reproduce the router. chaosInterceptor.js:72 hardcodes `{ hadDependency: true }`
// instead of asking either function.
test('B31-F4 the exported predicate disagrees with the router that produced the level', () => {
  const threeSentences = '打开它。关掉它。启动它。';
  assert.equal(assess(threeSentences).level, 'L1');
  assert.equal(hasCausalDependency(threeSentences), false, 'the predicate denies what the router decided');
  const chaotic = '我想删除它，但是我改主意了';
  assert.equal(assess(chaotic).level, 'L2');
  assert.equal(hasCausalDependency(chaotic), false);
});

test('causal counting is per-occurrence and does not hang on zero-width matches', () => {
  const r = assess('先备份然后清理然后再归档');
  assert.ok(r.signals.causal >= 3, `causal=${r.signals.causal}`);
  assert.equal(assess('然后然后然后').signals.causal, 3);
});
