'use strict';

/**
 * anomalyHandler.test.js — co-located unit test for anomalyHandler.js (D2 unit
 * structuredFurnace). Pure node:test, synchronous, zero I/O: this module reads no
 * env, no fs and no network (verified: the whole directory contains no
 * `process.env` / `setTimeout` / `await`).
 *
 * Several cases pin CURRENT (wrong) behaviour on purpose so the suite stays green
 * while the defect stays reproducible. Those are marked with B31-F<nn> and must not
 * be "fixed" by flipping the assertion without a human ruling.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  adjudicate,
  FurnaceRejection,
  ANOMALY_KINDS,
  DEGRADE_CONFIDENCE_FLOOR,
  CONTRADICTION_DEGRADE_MAX,
} = require('./anomalyHandler');
const S = require('../../project/metaplan/constraintStrategy');

test('module surface is the 5 documented keys, verbatim', () => {
  assert.deepEqual(Object.keys(require('./anomalyHandler')), [
    'adjudicate',
    'FurnaceRejection',
    'ANOMALY_KINDS',
    'DEGRADE_CONFIDENCE_FLOOR',
    'CONTRADICTION_DEGRADE_MAX',
  ]);
});

test('thresholds are the literal numbers the docstring argues with', () => {
  assert.equal(DEGRADE_CONFIDENCE_FLOOR, 0.65);
  assert.equal(CONTRADICTION_DEGRADE_MAX, 1);
});

test('ANOMALY_KINDS is frozen and lists five kinds', () => {
  assert.ok(Object.isFrozen(ANOMALY_KINDS));
  assert.deepEqual([...ANOMALY_KINDS], [
    'MISSING_ELEMENTS',
    'DEADLOCK_CYCLE',
    'CONTRADICTION',
    'LOW_CONFIDENCE',
    'UNKNOWN_ACTION',
  ]);
});

// B31-F1 (part): LOW_CONFIDENCE and UNKNOWN_ACTION are declared as anomaly kinds
// with per-line comments ("置信度低于阈值" / "动作未能映射到标准原语"), but no code
// path in the repository ever produces them: adjudicate() only ever constructs the
// other three kinds, and a sub-floor confidence yields verdict DEGRADE (not an
// exception), while action === 'UNKNOWN' is a legal ACTION_PRIMITIVES member and is
// therefore PASSed. Kept green by asserting the reachable subset.
test('only three of the five declared kinds are reachable from adjudicate', () => {
  const kindsSeen = new Set();
  const probe = (fn) => {
    try {
      fn();
    } catch (e) {
      kindsSeen.add(e.kind);
    }
  };
  probe(() => adjudicate({ validation: { valid: false, error: 'x' } }));
  probe(() => adjudicate({ cycle: ['n1'] }));
  probe(() => adjudicate({ contradictions: [{}, {}] }));
  probe(() => adjudicate({ payload: { action: 'UNKNOWN' }, confidence: 0.01 }));
  assert.deepEqual([...kindsSeen].sort(), ['CONTRADICTION', 'DEADLOCK_CYCLE', 'MISSING_ELEMENTS']);
});

test('FurnaceRejection fills defaults and coerces non-array collections', () => {
  const bare = new FurnaceRejection('m');
  assert.equal(bare.name, 'FurnaceRejection');
  assert.equal(bare.kind, 'MISSING_ELEMENTS');
  assert.deepEqual(bare.missing, []);
  assert.deepEqual(bare.conflicts, []);
  assert.deepEqual(bare.detail, {});
  assert.equal(bare.recoverable, false);
  assert.ok(bare instanceof Error);

  const noisy = new FurnaceRejection('m', { kind: 'X', missing: 'not-an-array', conflicts: 7, detail: { a: 1 } });
  assert.equal(noisy.kind, 'X');
  assert.deepEqual(noisy.missing, []);
  assert.deepEqual(noisy.conflicts, []);
  assert.deepEqual(noisy.detail, { a: 1 });
});

test('FurnaceRejection.toJSON carries the structured clarification payload', () => {
  const e = new FurnaceRejection('boom', { kind: 'CONTRADICTION', conflicts: ['a'], missing: ['edges'], detail: { count: 1 } });
  assert.deepEqual(e.toJSON(), {
    error: 'FurnaceRejection',
    kind: 'CONTRADICTION',
    message: 'boom',
    missing: ['edges'],
    conflicts: ['a'],
    detail: { count: 1 },
  });
});

test('adjudicate() with no arguments passes an empty payload through', () => {
  const r = adjudicate();
  assert.equal(r.verdict, 'PASS');
  assert.deepEqual(r.payload, {});
});

test('a failing validation is rejected, and the missing list is taken verbatim', () => {
  assert.throws(
    () => adjudicate({ validation: { valid: false, error: '缺 uid', missing: ['uid'] } }),
    (e) => {
      assert.ok(e instanceof FurnaceRejection);
      assert.equal(e.kind, 'MISSING_ELEMENTS');
      assert.deepEqual(e.missing, ['uid']);
      assert.equal(e.message, '结构化校验未通过：缺 uid');
      assert.deepEqual(e.detail, { error: '缺 uid' });
      return true;
    },
  );
});

// B31-F14: a validation failure that is NOT about missing elements still comes out
// as kind MISSING_ELEMENTS with an empty missing[] (forgeSchema._fail returns no
// `missing` for atomicity / ambiguity / strategy errors), so the clarification
// request the human sees names the wrong problem.
test('a schema error without a missing list rejects with kind MISSING_ELEMENTS and empty missing', () => {
  assert.throws(
    () => adjudicate({ validation: { valid: false, error: '非原子' } }),
    (e) => {
      assert.equal(e.kind, 'MISSING_ELEMENTS');
      assert.deepEqual(e.missing, []);
      assert.equal(e.message, '结构化校验未通过：非原子');
      return true;
    },
  );
});

test('valid === true and a missing validation object both stay on the non-reject path', () => {
  assert.equal(adjudicate({ validation: { valid: true }, payload: { confidence: 1 } }).verdict, 'PASS');
  assert.equal(adjudicate({ validation: undefined }).verdict, 'PASS');
  assert.equal(adjudicate({ validation: null }).verdict, 'PASS');
});

test('a non-empty cycle is rejected as DEADLOCK_CYCLE and the cycle becomes conflicts', () => {
  assert.throws(
    () => adjudicate({ cycle: ['n2', 'n3'] }),
    (e) => {
      assert.equal(e.kind, 'DEADLOCK_CYCLE');
      assert.deepEqual(e.conflicts, ['n2', 'n3']);
      assert.deepEqual(e.detail, { cycle: ['n2', 'n3'] });
      assert.match(e.message, /死锁/);
      return true;
    },
  );
  assert.equal(adjudicate({ cycle: [] }).verdict, 'PASS');
  assert.equal(adjudicate({ cycle: 'not-an-array' }).verdict, 'PASS');
  assert.equal(adjudicate({ cycle: null }).verdict, 'PASS');
});

test('contradictions: at most one degrades, two or more reject', () => {
  assert.equal(adjudicate({ contradictions: [{}] }).verdict, 'DEGRADE');
  assert.throws(() => adjudicate({ contradictions: [{}, {}] }), (e) => {
    assert.equal(e.kind, 'CONTRADICTION');
    assert.equal(e.conflicts.length, 2);
    assert.deepEqual(e.detail, { count: 2 });
    assert.match(e.message, /无法确定唯一意图/);
    return true;
  });
});

test('confidence resolution: input.confidence, then payload.confidence, then 1', () => {
  assert.equal(adjudicate({ payload: { confidence: 0.1 }, confidence: 0.4 }).payload.uncertainty.confidence, 0.4);
  assert.equal(adjudicate({ payload: { confidence: 0.1 } }).payload.uncertainty.confidence, 0.1);
  assert.equal(adjudicate({ payload: { confidence: 'high' } }).verdict, 'PASS');
  assert.equal(adjudicate({}).verdict, 'PASS');
});

test('the degrade floor is exclusive: 0.65 passes, one unit below degrades', () => {
  assert.equal(adjudicate({ payload: { confidence: 0.65 } }).verdict, 'PASS');
  assert.equal(adjudicate({ payload: { confidence: 0.6499 } }).verdict, 'DEGRADE');
});

test('degrade stamps sandbox + write lock and escalates the strategy monotonically', () => {
  const r = adjudicate({ payload: { confidence: 0.1, strategy: S.STRATEGIES.PROMPT_SOFT, keep: 'me' } });
  assert.equal(r.verdict, 'DEGRADE');
  assert.equal(r.payload.strategy, S.STRATEGIES.CODE_HARD);
  assert.equal(r.payload.sandbox, true);
  assert.equal(r.payload.writeLocked, true);
  assert.equal(r.payload.degraded, true);
  assert.equal(r.payload.keep, 'me', 'original fields must survive the spread');
  assert.deepEqual(r.payload.uncertainty, { confidence: 0.1, contradictions: 0 });
  assert.equal(r.payload.degradeReason, 'low-confidence');
});

test('escalation never relaxes a stricter strategy (Prompt_Soft is only a floor)', () => {
  const r = adjudicate({
    payload: { confidence: 0.1, strategy: S.STRATEGIES.SYSTEM_BLOCK },
    contradictions: [{}],
  });
  assert.equal(r.payload.strategy, S.STRATEGIES.SYSTEM_BLOCK);
});

test('a missing strategy still degrades to CODE_HARD (payload default is the floor)', () => {
  const r = adjudicate({ payload: { confidence: 0.1 } });
  assert.equal(r.payload.strategy, S.STRATEGIES.CODE_HARD);
});

// B31-F12 (anomalyHandler half): when BOTH causes are present (sub-floor confidence
// and one isolable contradiction) the reason string keeps only the contradiction,
// so the low-confidence cause is not reported to the human.
test('degradeReason reports the contradiction when both causes fire at once', () => {
  const r = adjudicate({ payload: { confidence: 0.2 }, contradictions: [{ a: 1, b: 2 }] });
  assert.equal(r.payload.degradeReason, 'isolable-contradiction');
  assert.deepEqual(r.payload.uncertainty, { confidence: 0.2, contradictions: 1 });
});

test('a PASS verdict returns the identical payload object (no copy, no tagging)', () => {
  const payload = { confidence: 1, strategy: S.STRATEGIES.PROMPT_SOFT };
  const r = adjudicate({ payload });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.payload, payload);
  assert.equal('degraded' in r.payload, false);
  assert.equal('writeLocked' in r.payload, false);
});

test('adjudicate never mutates the input payload on the degrade path', () => {
  const payload = { confidence: 0.2, strategy: S.STRATEGIES.PROMPT_SOFT };
  const r = adjudicate({ payload });
  assert.equal(payload.strategy, S.STRATEGIES.PROMPT_SOFT);
  assert.equal('degraded' in payload, false);
  assert.notEqual(r.payload, payload);
});
