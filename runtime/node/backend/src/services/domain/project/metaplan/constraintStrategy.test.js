'use strict';

// Unit-level contract tests for constraintStrategy.js (co-located, per [RESEARCH-018] §2.3).
// This module is the ladder every other override layer (trust circuit-breaker,
// constitutional red line, injection engine) climbs. Its whole value is one
// invariant: combining two constraints yields the STRICTER one, never the laxer
// (强制接管只能加锁，不能减锁). A regression here would silently let an override layer
// relax a model's choice, so the tests pin the ladder table itself, the ordering
// properties over all pairs, and the fail-safe treatment of unknown values.

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('./constraintStrategy');

const SOFT = 'Prompt_Soft';
const HARD = 'Code_Hard';
const BLOCK = 'System_Block';

// What `escalate` must hand back for a value that is not on the ladder: the source
// normalizes unknowns to the strictest level rather than dropping them. Mirrored here
// (not imported) so the pair sweep has an independent oracle.
const norm = (x) => (S.isStrategy(x) ? x : BLOCK);

test('the enum is exactly the three documented levels, in strictness order', () => {
  assert.deepEqual(S.STRATEGIES, {
    PROMPT_SOFT: SOFT,
    CODE_HARD: HARD,
    SYSTEM_BLOCK: BLOCK,
  });
  assert.deepEqual(S.ALL, [SOFT, HARD, BLOCK]);
  assert.deepEqual(S.RANK, { [SOFT]: 0, [HARD]: 1, [BLOCK]: 2 });
  // ALL is derived to be ordered by rank; the ladder is meaningless if it drifts.
  assert.deepEqual(
    S.ALL.map((s) => S.RANK[s]),
    [0, 1, 2],
  );
});

test('the three public tables are frozen, so a consumer cannot retune the ladder', () => {
  assert.equal(Object.isFrozen(S.STRATEGIES), true);
  assert.equal(Object.isFrozen(S.RANK), true);
  assert.equal(Object.isFrozen(S.ALL), true);
  assert.throws(() => {
    'use strict';
    S.ALL.push('Admin_Nuke');
  }, TypeError);
  assert.throws(() => {
    'use strict';
    S.RANK[S.STRATEGIES.PROMPT_SOFT] = 9;
  }, TypeError);
  assert.throws(() => {
    'use strict';
    S.STRATEGIES.EXTRA = 'X';
  }, TypeError);
  assert.equal(S.ALL.length, 3, 'the rejected push must not have landed');
  assert.equal(S.RANK[SOFT], 0, 'the rejected write must not have landed');
});

test('isStrategy accepts only the three enum values and is prototype-safe', () => {
  assert.equal(S.isStrategy(SOFT), true);
  assert.equal(S.isStrategy(HARD), true);
  assert.equal(S.isStrategy(BLOCK), true);
  // hasOwnProperty-based: Object.prototype keys must NOT masquerade as strategies.
  assert.equal(S.isStrategy('constructor'), false);
  assert.equal(S.isStrategy('toString'), false);
  assert.equal(S.isStrategy('__proto__'), false);
  for (const junk of ['', 'Prompt_Soft ', 'prompt_soft', null, undefined, 0, {}, Symbol('Prompt_Soft')]) {
    assert.equal(S.isStrategy(junk), false, `${String(junk)} must not be a strategy`);
  }
});

test('known gap (see README 已登记的缺口): isStrategy coerces an array to its element string', () => {
  // Characterization test, NOT an endorsement. `hasOwnProperty.call(RANK, key)` stringifies
  // `key` first, so a one-element array whose element is a strategy name reads as that
  // strategy. The JSDoc says "one of the three legal enum values", so a non-string should
  // be rejected; the candidate fix is a leading `typeof s !== 'string'` guard. No current
  // caller reaches this — validateMetaPlan() and the coordinator both String()-coerce the
  // value before asking — but the predicate is public, so the gap is registered rather
  // than silently blessed. This test turns RED on purpose once the guard is added.
  assert.equal(S.isStrategy([SOFT]), true, 'array-of-one coerces — registered gap');
  assert.equal(S.isStrategy(['Code_Hard']), true, 'array-of-one coerces — registered gap');
  assert.equal(S.isStrategy([SOFT, HARD]), false, 'two elements no longer spell a rank key');
});

test('rankOf is fail-safe: anything unknown ranks as the strictest level', () => {
  assert.equal(S.rankOf(SOFT), 0);
  assert.equal(S.rankOf(HARD), 1);
  assert.equal(S.rankOf(BLOCK), 2);
  for (const junk of ['???', '', null, undefined, 'constructor', 42]) {
    assert.equal(S.rankOf(junk), 2, `${JSON.stringify(junk)} must rank as System_Block`);
  }
});

test('escalate is a commutative, idempotent least-upper-bound over every pair', () => {
  const fails = [];
  const samples = [...S.ALL, 'bogus_level', undefined];
  for (const a of samples) {
    for (const b of samples) {
      const ab = S.escalate(a, b);
      const ba = S.escalate(b, a);
      if (ab !== ba) fails.push(`not commutative: escalate(${a},${b})=${ab} vs ${ba}`);
      if (ab !== norm(a) && ab !== norm(b)) fails.push(`result ${ab} is not one of the inputs for (${a},${b})`);
      // The result must be at least as strict as BOTH inputs — never a relaxation.
      if (!S.atLeast(ab, a)) fails.push(`relaxed ${a} when escalating with ${b}: got ${ab}`);
      if (!S.atLeast(ab, b)) fails.push(`relaxed ${b} when escalating with ${a}: got ${ab}`);
      if (S.escalate(a, a) !== norm(a)) fails.push(`not idempotent for ${a}: ${S.escalate(a, a)}`);
    }
  }
  assert.deepEqual(fails, [], `escalation ladder violations:\n${fails.join('\n')}`);
});

test('escalate returns exact documented verdicts for the interesting pairs', () => {
  assert.equal(S.escalate(SOFT, HARD), HARD);
  assert.equal(S.escalate(HARD, SOFT), HARD, 'argument order must not matter');
  assert.equal(S.escalate(HARD, BLOCK), BLOCK);
  assert.equal(S.escalate(SOFT, BLOCK), BLOCK);
  assert.equal(S.escalate(SOFT, SOFT), SOFT);
  assert.equal(S.escalate(HARD, HARD), HARD);
  assert.equal(S.escalate(BLOCK, BLOCK), BLOCK);
  // An unknown input normalizes to System_Block rather than being ignored.
  assert.equal(S.escalate(SOFT, 'unknown'), BLOCK);
  assert.equal(S.escalate('unknown', SOFT), BLOCK);
  assert.equal(S.escalate('unknown', 'unknown'), BLOCK);
});

test('atLeast is the rank comparison the override layers depend on', () => {
  assert.equal(S.atLeast(HARD, SOFT), true);
  assert.equal(S.atLeast(HARD, HARD), true);
  assert.equal(S.atLeast(SOFT, HARD), false);
  assert.equal(S.atLeast(SOFT, BLOCK), false);
  assert.equal(S.atLeast(BLOCK, HARD), true);
  // Unknown actuals rank as strictest, so a corrupt strategy never unlocks.
  assert.equal(S.atLeast('corrupt', BLOCK), true);
  // Unknown requirements also rank as strictest — BLOCK is the only thing that clears them.
  assert.equal(S.atLeast(BLOCK, 'corrupt-required'), true);
  assert.equal(S.atLeast(HARD, 'corrupt-required'), false);
});

test('the module surface is exactly the seven documented members', () => {
  assert.deepEqual(Object.keys(S).sort(), [
    'ALL',
    'RANK',
    'STRATEGIES',
    'atLeast',
    'escalate',
    'isStrategy',
    'rankOf',
  ]);
  for (const fn of ['atLeast', 'escalate', 'isStrategy', 'rankOf']) {
    assert.equal(typeof S[fn], 'function', `${fn} must be a function`);
  }
});
