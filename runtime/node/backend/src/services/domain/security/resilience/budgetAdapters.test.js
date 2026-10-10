'use strict';

// Unit-level contract tests for budgetAdapters.js (co-located, per [RESEARCH-018] §2.3).
// These adapters feed the executor's two budget gates, so the arithmetic ladders below
// (explicit-zero vs fallback, flooring, clamping, rounding) ARE the gate semantics.
// The adversarial fix recorded in the source header — explicit 0 is a real exhausted
// budget, not a missing argument — is pinned here so it cannot silently regress.

const test = require('node:test');
const assert = require('node:assert/strict');

const budgetAdapters = require('./budgetAdapters');
const { makeStepBudget, makeTokenBudget } = budgetAdapters;
const { MAX_FALLBACK_DEPTH } = require('./fallbackTree');

test('module face: two factories, no executor back-edge', () => {
  assert.deepEqual(Object.keys(budgetAdapters).sort(), ['makeStepBudget', 'makeTokenBudget']);
  // budgetAdapters.js must not re-require budgetExecutor (pure leaf per its header).
  assert.equal(budgetAdapters.makeStepBudget, require('./budgetExecutor').makeStepBudget,
    'budgetExecutor re-binds the same function objects — identity, not a copy');
});

test('makeStepBudget: no parseable number falls back to the tree max depth (3)', () => {
  for (const junk of [undefined, NaN, 'abc', {}]) {
    assert.equal(makeStepBudget(junk).snapshot().totalUnits, MAX_FALLBACK_DEPTH, String(junk));
  }
  // null is NOT in the fallback set: Number(null) === 0 is parseable, so an explicit
  // null is treated as an exhausted (0-unit) budget, not as "argument missing".
  assert.equal(makeStepBudget(null).snapshot().totalUnits, 0);
});

test('makeStepBudget: explicit numbers are taken literally, floor-clamped to >=0', () => {
  assert.equal(makeStepBudget(5).snapshot().totalUnits, 5);
  assert.equal(makeStepBudget(2.7).snapshot().totalUnits, 2, 'floors, does not round');
  assert.equal(makeStepBudget(-4).snapshot().totalUnits, 0, 'negative clamps to 0, no fallback');
  assert.equal(makeStepBudget('4').snapshot().totalUnits, 4, 'numeric strings parse');
  assert.equal(makeStepBudget(true).snapshot().totalUnits, 1, 'Number(true)=1 is "parseable"');
});

test('makeStepBudget: explicit 0 means exhausted NOW — 0 units, 0 pct, never 3', () => {
  const s = makeStepBudget(0).snapshot();
  assert.deepEqual(s, { totalUnits: 0, remainingUnits: 0, remainingPct: 0 });
  // Regression lock for the old `Number(x) || MAX` bug: 0 must not silently become 3.
});

test('makeStepBudget: spendOne ladder walks pct down and clamps at zero', () => {
  const b = makeStepBudget(4);
  assert.deepEqual(b.snapshot(), { totalUnits: 4, remainingUnits: 4, remainingPct: 100 });
  b.spendOne();
  assert.deepEqual(b.snapshot(), { totalUnits: 4, remainingUnits: 3, remainingPct: 75 });
  b.spendOne();
  b.spendOne();
  assert.deepEqual(b.snapshot(), { totalUnits: 4, remainingUnits: 1, remainingPct: 25 });
  b.spendOne();
  assert.deepEqual(b.snapshot(), { totalUnits: 4, remainingUnits: 0, remainingPct: 0 });
  b.spendOne(); // overspend: clamps, never goes negative
  assert.deepEqual(b.snapshot(), { totalUnits: 4, remainingUnits: 0, remainingPct: 0 });
});

test('makeStepBudget: pct rounds to nearest integer percent', () => {
  assert.equal(makeStepBudget(3).snapshot().remainingPct, 100);
  const b = makeStepBudget(3);
  b.spendOne();
  assert.equal(b.snapshot().remainingPct, 67, 'round(2/3*100)=67, not 66 or 66.67');
});

test('makeTokenBudget: reads the live external source on every snapshot', () => {
  let spent = 20;
  const b = makeTokenBudget({ total: 100, spent: () => spent });
  assert.deepEqual(b.snapshot(), { totalUnits: 100, remainingUnits: 80, remainingPct: 80 });
  spent = 95;
  assert.deepEqual(b.snapshot(), { totalUnits: 100, remainingUnits: 5, remainingPct: 5 });
});

test('makeTokenBudget: spendOne is a no-op — only the external ledger burns tokens', () => {
  const b = makeTokenBudget({ total: 100, spent: () => 30 });
  b.spendOne();
  b.spendOne();
  assert.deepEqual(b.snapshot(), { totalUnits: 100, remainingUnits: 70, remainingPct: 70 });
});

test('makeTokenBudget: malformed source degrades to zeros/defaults without throwing', () => {
  assert.deepEqual(makeTokenBudget().snapshot(),
    { totalUnits: 0, remainingUnits: 0, remainingPct: 100 },
    'no source at all: total 0; pct is 100 (no denominator) — gate 2 still sees 0 units');
  assert.deepEqual(makeTokenBudget({ total: 50, spent: 'not-a-fn' }).snapshot(),
    { totalUnits: 50, remainingUnits: 50, remainingPct: 100 },
    'non-function spent is treated as "spend nothing"');
  assert.deepEqual(makeTokenBudget({ total: 50, spent: () => 'garbage' }).snapshot(),
    { totalUnits: 50, remainingUnits: 50, remainingPct: 100 },
    'unparseable spend counts as 0 spent');
});

test('makeTokenBudget: exhausted-overdriven source clamps remaining at 0 / pct 0', () => {
  const b = makeTokenBudget({ total: 100, spent: () => 150 });
  assert.deepEqual(b.snapshot(), { totalUnits: 100, remainingUnits: 0, remainingPct: 0 });
});

test('step vs token disagree on total=0 pct BY DESIGN (0% vs 100%)', () => {
  // Step budget total=0 → pct 0: an explicitly declared-empty plan budget trips gate 1.
  // Token budget total=0 → pct 100: pct is meaningless without a real denominator,
  // and the executor's gate 2 (remainingUnits < remainingPlans) still trips on 0 units.
  // Pinned so nobody "unifies" them and breaks one of the two circuit paths.
  assert.equal(makeStepBudget(0).snapshot().remainingPct, 0);
  assert.equal(makeTokenBudget({ total: 0 }).snapshot().remainingPct, 100);
  assert.equal(makeTokenBudget({ total: 0 }).snapshot().remainingUnits, 0);
});
