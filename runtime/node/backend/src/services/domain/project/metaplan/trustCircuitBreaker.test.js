'use strict';

// Unit-level contract tests for trustCircuitBreaker.js (co-located, per [RESEARCH-018] §2.3).
// This is what gives the anti-laziness rule teeth: a wrong Prompt_Soft bet must cost
// something. Two escalations, both monotone:
//   信任扣分 (per task type)  — a Soft bet that then fails marks that task TYPE distrusted,
//                             and every later action of that type is floored to Code_Hard.
//   会话级接管                — `sessionTripThreshold` consecutive Soft failures (across any
//                             type) lock the whole session to Code_Hard.
// The invariants worth locking are that the breaker can only ever RAISE the floor (never
// lower a stricter model choice), that only a Soft bet that fails counts as a trust event,
// that task types are normalized before comparison, and that all state is per-instance
// (one breaker per session — no globals to leak between coordinators).
// process.env.KHY_METAPLAN_SESSION_TRIP is set and cleared inside the tests that use it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { TrustCircuitBreaker, DEFAULT_SESSION_TRIP_THRESHOLD } = require('./trustCircuitBreaker');
const S = require('./constraintStrategy');

const SOFT = S.STRATEGIES.PROMPT_SOFT;
const HARD = S.STRATEGIES.CODE_HARD;
const BLOCK = S.STRATEGIES.SYSTEM_BLOCK;

test('the exported surface and the documented default threshold', () => {
  assert.equal(DEFAULT_SESSION_TRIP_THRESHOLD, 2);
  assert.equal(typeof TrustCircuitBreaker, 'function');
});

test('the threshold resolves opts > env > default, and junk env falls back safely', () => {
  const saved = process.env.KHY_METAPLAN_SESSION_TRIP;
  try {
    delete process.env.KHY_METAPLAN_SESSION_TRIP;
    assert.equal(new TrustCircuitBreaker().sessionTripThreshold, 2);
    assert.equal(new TrustCircuitBreaker({}).sessionTripThreshold, 2);
    process.env.KHY_METAPLAN_SESSION_TRIP = '3';
    assert.equal(new TrustCircuitBreaker().sessionTripThreshold, 3, 'env is honoured when set');
    assert.equal(
      new TrustCircuitBreaker({ sessionTripThreshold: 1 }).sessionTripThreshold,
      1,
      'an explicit option beats the env',
    );
    // Non-positive / non-numeric env values are ignored rather than trusted.
    for (const junk of ['0', '-1', 'abc', '', '   ', '2.5x']) {
      process.env.KHY_METAPLAN_SESSION_TRIP = junk;
      assert.equal(new TrustCircuitBreaker().sessionTripThreshold, 2, `junk env ${JSON.stringify(junk)} must fall back`);
    }
    // An explicit option is taken whenever it is a number — including 0.
    assert.equal(new TrustCircuitBreaker({ sessionTripThreshold: 0 }).sessionTripThreshold, 0);
    assert.equal(new TrustCircuitBreaker({ sessionTripThreshold: 7 }).sessionTripThreshold, 7);
  } finally {
    if (saved === undefined) delete process.env.KHY_METAPLAN_SESSION_TRIP;
    else process.env.KHY_METAPLAN_SESSION_TRIP = saved;
  }
});

test('a fresh breaker imposes no floor on anything', () => {
  const b = new TrustCircuitBreaker();
  assert.equal(b.flooredStrategyFor('js'), null);
  assert.equal(b.flooredStrategyFor(undefined), null);
  assert.equal(b.isSessionLocked(), false);
  assert.deepEqual(b.distrustedTypes(), []);
  assert.deepEqual(b.events(), []);
  assert.deepEqual(b._snapshot(), { distrusted: false, sessionLocked: false, consecutiveSoftFailures: 0 });
});

test('effectiveStrategy passes an untrusted model choice through untouched', () => {
  const b = new TrustCircuitBreaker();
  for (const strategy of [SOFT, HARD, BLOCK]) {
    assert.deepEqual(b.effectiveStrategy(strategy, 'js'), {
      strategy,
      floored: false,
      reason: null,
    });
  }
});

test('a Soft bet that fails floors ONLY that task type, and says why', () => {
  const b = new TrustCircuitBreaker();
  const snap = b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'js', error: 'SyntaxError: boom\n at f' });
  assert.deepEqual(snap, { distrusted: true, sessionLocked: false, consecutiveSoftFailures: 1 });
  assert.equal(b.flooredStrategyFor('js'), HARD);
  assert.equal(b.flooredStrategyFor('py'), null, 'the floor must not leak across task types');

  const out = b.effectiveStrategy(SOFT, 'js');
  assert.equal(out.strategy, HARD);
  assert.equal(out.floored, true);
  assert.equal(out.reason, '任务类型「js」此前在 Prompt_Soft 下翻车，已强制 Code_Hard。');
});

test('the floor never relaxes a stricter model choice, and reports floored:false', () => {
  const b = new TrustCircuitBreaker();
  b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'js' });
  // The model chose System_Block; the Code_Hard floor must not pull it down.
  assert.deepEqual(b.effectiveStrategy(BLOCK, 'js'), { strategy: BLOCK, floored: false, reason: null });
  assert.deepEqual(b.effectiveStrategy(HARD, 'js'), { strategy: HARD, floored: false, reason: null });
  assert.equal(b.effectiveStrategy(SOFT, 'js').strategy, HARD);
});

test('only a Soft bet that fails is a trust event — a Hard failure is the net working', () => {
  const b = new TrustCircuitBreaker();
  const snap = b.recordOutcome({ ok: false, declaredStrategy: HARD, taskType: 'js', error: 'lint error' });
  assert.deepEqual(snap, { distrusted: false, sessionLocked: false, consecutiveSoftFailures: 0 });
  assert.deepEqual(b.distrustedTypes(), []);
  assert.deepEqual(b.events(), [{ type: 'hard_failure', taskType: 'js', error: 'lint error' }]);

  // And System_Block failures likewise leave the streak alone.
  b.recordOutcome({ ok: false, declaredStrategy: BLOCK, taskType: 'js' });
  assert.equal(b._snapshot().consecutiveSoftFailures, 0);
  assert.equal(b.isSessionLocked(), false);
});

test('the session locks after N consecutive Soft failures across ANY task types', () => {
  const b = new TrustCircuitBreaker({ sessionTripThreshold: 3 });
  b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'js' });
  b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'py' });
  assert.equal(b.isSessionLocked(), false, 'two of three is not yet a lock');
  assert.equal(b.flooredStrategyFor('go'), null, 'an unseen type is still unfloored before the lock');
  b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'go' });
  assert.equal(b.isSessionLocked(), true);
  // After the lock the floor is global, including for types never seen to fail.
  assert.equal(b.flooredStrategyFor('rust'), HARD);
  assert.equal(b.flooredStrategyFor(undefined), HARD);
  const out = b.effectiveStrategy(SOFT, 'rust');
  assert.equal(out.strategy, HARD);
  assert.equal(out.reason, '本会话已触发连续误判熔断，全部操作强制 Code_Hard。');
  assert.deepEqual(b.distrustedTypes(), ['js', 'py', 'go']);
  assert.deepEqual(
    b.events().map((e) => e.type),
    ['soft_misjudgment', 'soft_misjudgment', 'soft_misjudgment', 'session_lock'],
  );
  assert.deepEqual(b.events()[3], { type: 'session_lock', threshold: 3 });
});

test('the session lock is one-way: later successes never lift it', () => {
  const b = new TrustCircuitBreaker({ sessionTripThreshold: 1 });
  b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'js' });
  assert.equal(b.isSessionLocked(), true);
  b.recordOutcome({ ok: true, declaredStrategy: SOFT, taskType: 'js' });
  assert.equal(b.isSessionLocked(), true, 'escalation is monotone');
  assert.equal(b.flooredStrategyFor('anything'), HARD);
});

test('a clean success on a Soft bet clears the streak but cannot undo a distrust', () => {
  const b = new TrustCircuitBreaker();
  b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'js' });
  assert.equal(b._snapshot().consecutiveSoftFailures, 1);
  const after = b.recordOutcome({ ok: true, declaredStrategy: SOFT, taskType: 'js' });
  assert.deepEqual(after, { distrusted: true, sessionLocked: false, consecutiveSoftFailures: 0 });
  // Two more isolated Soft failures (success in between) must NOT reach the threshold of 2.
  b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'js' });
  b.recordOutcome({ ok: true, declaredStrategy: SOFT, taskType: 'js' });
  b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'js' });
  assert.equal(b.isSessionLocked(), false, 'only CONSECUTIVE failures count towards the lock');
  // A success under a Hard declaration does not clear the streak (it was never a Soft bet).
  const c = new TrustCircuitBreaker();
  c.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'js' });
  c.recordOutcome({ ok: true, declaredStrategy: HARD, taskType: 'js' });
  assert.equal(c._snapshot().consecutiveSoftFailures, 1, 'the streak is keyed to Soft bets only');
});

test('task types are normalized before comparison, so casing and padding cannot dodge a floor', () => {
  const b = new TrustCircuitBreaker();
  b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: '  JS_Edit  ' });
  assert.deepEqual(b.distrustedTypes(), ['js_edit']);
  assert.equal(b.flooredStrategyFor('JS_EDIT'), HARD);
  assert.equal(b.flooredStrategyFor('js_edit'), HARD);
  assert.equal(b.effectiveStrategy(SOFT, 'Js_Edit').strategy, HARD);
  // A non-string type is coerced rather than crashing.
  // A non-string type is coerced rather than crashing (insertion order, not sorted).
  b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 42 });
  assert.deepEqual(b.distrustedTypes(), ['js_edit', '42']);
});

test('a missing task type lands in the shared "default" bucket, not in every bucket', () => {
  const b = new TrustCircuitBreaker();
  b.recordOutcome({ ok: false, declaredStrategy: SOFT });
  assert.deepEqual(b.distrustedTypes(), ['default'], 'nullish / blank types normalize to "default"');
  assert.equal(b.flooredStrategyFor(undefined), HARD);
  assert.equal(b.flooredStrategyFor(''), HARD);
  assert.equal(b.flooredStrategyFor('   '), HARD);
  // …but it is still a bucket, so an unrelated type is not floored by it.
  assert.equal(b.flooredStrategyFor('js'), null);
});

test('recordOutcome tolerates a bare call and records the outcome snapshot shape', () => {
  const b = new TrustCircuitBreaker();
  assert.deepEqual(b.recordOutcome(), { distrusted: false, sessionLocked: false, consecutiveSoftFailures: 0 });
  assert.deepEqual(b.recordOutcome({}), { distrusted: false, sessionLocked: false, consecutiveSoftFailures: 0 });
  // `ok` is coerced truthy: a non-boolean truthy outcome counts as success.
  assert.deepEqual(b.recordOutcome({ ok: 1, declaredStrategy: SOFT }), {
    distrusted: false,
    sessionLocked: false,
    consecutiveSoftFailures: 0,
  });
  assert.deepEqual(b.recordOutcome({ ok: 'no', declaredStrategy: SOFT }).consecutiveSoftFailures, 0);
  // …and a falsy one as a failure. Callers must pass a real boolean, not the string "false".
  assert.deepEqual(b.recordOutcome({ ok: 0, declaredStrategy: SOFT }).consecutiveSoftFailures, 1);
});

test('the audit trail records the normalized type, the first error line and the running streak', () => {
  const b = new TrustCircuitBreaker();
  const longError = `${'x'.repeat(300)}\nsecond line should never appear`;
  b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'JS', error: longError });
  b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'js', error: null });
  assert.deepEqual(b.events(), [
    {
      type: 'soft_misjudgment',
      taskType: 'js',
      error: `${'x'.repeat(200)}`,
      consecutive: 1,
    },
    { type: 'soft_misjudgment', taskType: 'js', error: '', consecutive: 2 },
    { type: 'session_lock', threshold: 2 },
  ]);
  const ev = b.events()[0];
  assert.equal(ev.error.includes('\n'), false, 'the trail must stay one line per event');
  assert.equal(ev.error.length, 200, 'the trail must be bounded');
});

test('events() and distrustedTypes() hand out copies, so the trail cannot be rewritten', () => {
  const b = new TrustCircuitBreaker();
  b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'js' });
  const types = b.distrustedTypes();
  types.push('pretend-i-never-failed');
  assert.deepEqual(b.distrustedTypes(), ['js']);

  const events = b.events();
  assert.equal(events.length, 1);
  events[0].type = 'hard_failure';
  events.push({ type: 'fabricated' });
  assert.equal(b.events().length, 1, 'pushing the returned array must not grow the trail');
  assert.equal(b.events()[0].type, 'soft_misjudgment', 'mutating a returned event must not stick');
});

test('state is per instance — no module-level accumulator leaks between sessions', () => {
  const a = new TrustCircuitBreaker();
  a.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'js' });
  a.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'js' });
  assert.equal(a.isSessionLocked(), true);
  const fresh = new TrustCircuitBreaker();
  assert.equal(fresh.isSessionLocked(), false, 'a new breaker starts clean');
  assert.deepEqual(fresh.distrustedTypes(), []);
  assert.deepEqual(fresh.events(), []);
  assert.equal(fresh.flooredStrategyFor('js'), null);
});
