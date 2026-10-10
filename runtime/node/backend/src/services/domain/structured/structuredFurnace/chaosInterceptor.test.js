'use strict';

/**
 * chaosInterceptor.test.js — co-located unit test for chaosInterceptor.js
 * (D2 unit structuredFurnace). Pure node:test, synchronous, zero I/O.
 *
 * The seal uses a per-process random salt, so every expectation here is either
 * shape-based (hex length, key list) or same-process deterministic (two calls on
 * the same text must produce the same seal). Nothing in this file assumes a seal
 * value survives a process restart — that would be wrong to assume (see README).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  intercept,
  assertForged,
  isForged,
  FurnaceRejection,
  SEAL_BRAND,
} = require('./chaosInterceptor');
const { assess, hasCausalDependency } = require('./entropyAssessor');
const S = require('../../project/metaplan/constraintStrategy');

const ENVELOPE_KEYS = [
  'sealed',
  'seal',
  'level',
  'entropy',
  'verdict',
  'kind',
  'payload',
  'strategy',
  'degraded',
  'writeLocked',
  'entities',
  'rawHash',
];

test('module surface: the entry, the two seal guards, the rejection class, the brand', () => {
  assert.deepEqual(Object.keys(require('./chaosInterceptor')), [
    'intercept',
    'assertForged',
    'isForged',
    'FurnaceRejection',
    'SEAL_BRAND',
  ]);
  assert.equal(SEAL_BRAND, Symbol.for('khyos.structuredFurnace.sealed'));
  assert.equal(FurnaceRejection, require('./anomalyHandler').FurnaceRejection);
});

test('intercept returns a shape-complete, frozen ForgeEnvelope', () => {
  const env = intercept('删除 a.js');
  assert.deepEqual(Object.keys(env), ENVELOPE_KEYS);
  assert.equal(Object.isFrozen(env), true);
  assert.equal(env[SEAL_BRAND], true);
  assert.deepEqual(Object.getOwnPropertySymbols(env), [SEAL_BRAND]);
  assert.equal(env.sealed, true);
  assert.match(env.seal, /^[0-9a-f]{64}$/);
  assert.match(env.rawHash, /^[0-9a-f]{12}$/);
  assert.equal(env.kind, 'ActionIntent');
  assert.equal(env.verdict, 'PASS');
  assert.equal(env.level, 'L0');
  assert.equal(typeof env.entropy, 'number');
  assert.equal(env.degraded, false);
  assert.equal(env.writeLocked, false);
  assert.equal(env.strategy, env.payload.strategy);
});

test('the envelope holds no verbatim input, only the collapsed projection plus its sha1 prefix', () => {
  const raw = '把 secret-file.txt 删除';
  const env = intercept(raw);
  const json = JSON.stringify(env);
  assert.equal(json.includes(raw), false, 'the untouched sentence must not travel downstream');
  assert.equal(json.includes('secret-file.txt'), true, 'the collapsed entity does carry the target token');
  assert.equal(env.rawHash, crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12));
});

test('routing: entropy signals pick the collapse layer, L0 / L1 / L2 all reachable', () => {
  const cases = [
    ['删除 a.js', 'L0', 'ActionIntent', 'PASS'],
    ['先备份然后清理 b.js', 'L1', 'TaskGraph', 'PASS'],
    ['删除 a.js。但是保留 b.js', 'L2', 'StateMachine', 'DEGRADE'],
    ['算了改主意推翻', 'L2', 'StateMachine', 'PASS'],
  ];
  for (const [text, level, kind, verdict] of cases) {
    const env = intercept(text);
    assert.equal(env.level, level, `level for ${text}`);
    assert.equal(env.kind, kind, `kind for ${text}`);
    assert.equal(env.verdict, verdict, `verdict for ${text}`);
    assert.equal(assess(text).level, level, `router agrees with envelope for ${text}`);
  }
});

test('the seal is content-addressed: same text reproduces seal, uid and rawHash', () => {
  const a = intercept('读取 a.js');
  const b = intercept('读取 a.js');
  assert.equal(a.seal, b.seal);
  assert.equal(a.payload.uid, b.payload.uid);
  assert.equal(a.rawHash, b.rawHash);
  const c = intercept('读取 b.js');
  assert.notEqual(a.seal, c.seal);
  assert.notEqual(a.rawHash, c.rawHash);
});

test('assertForged accepts a genuine envelope and returns it unchanged', () => {
  const env = intercept('读取 a.js');
  assert.equal(assertForged(env), env);
  assert.equal(isForged(env), true);
});

test('assertForged is fail-closed on anything that was not minted here', () => {
  for (const bad of [null, undefined, 0, 'nope', {}, [], { sealed: true, seal: 'x', payload: {} }]) {
    assert.throws(() => assertForged(bad), /^Error: 未经熔炉封印的输入不得进入业务逻辑/, `rejects ${JSON.stringify(bad)}`);
    assert.equal(isForged(bad), false, `isForged false for ${JSON.stringify(bad)}`);
  }
});

test('the brand symbol alone is not enough: a hand-made envelope fails the seal check', () => {
  // SEAL_BRAND is Symbol.for(...), i.e. globally reachable, so the brand cannot be
  // the security boundary. What saves the design is the unknown per-process salt.
  const fake = { [SEAL_BRAND]: true, sealed: true, seal: '0'.repeat(64), payload: { kind: 'ActionIntent' } };
  assert.equal(isForged(fake), false);
  assert.throws(() => assertForged(fake), /^Error: 熔炉封印校验失败/);
});

test('the seal depends on the salt, so it is an in-process boundary only', () => {
  const env = intercept('读取 a.js');
  const replay = crypto
    .createHmac('sha256', crypto.randomBytes(16).toString('hex'))
    .update(JSON.stringify(env.payload))
    .digest('hex');
  assert.match(replay, /^[0-9a-f]{64}$/);
  assert.notEqual(replay, env.seal, 'a different key must give a different digest');
});

test('tampering with the sealed payload is detected by both guards', () => {
  const env = intercept('读取 a.js');
  assert.equal(env.payload.action, 'READ');
  env.payload.action = 'DELETE';
  assert.equal(env.payload.action, 'DELETE', 'the write succeeded: the payload is not frozen');
  assert.equal(isForged(env), false);
  assert.throws(() => assertForged(env), /^Error: 熔炉封印校验失败：payload 被篡改或非法构造/);
});

// B31-F4 (high): "封印（seal）= ... 业务侧用 assertForged(envelope) 验封" (chaosInterceptor.js:14-15)
// is only a *capability*, never an enforced gate. Object.freeze is shallow, so the
// envelope's own fields are immutable while the payload it certifies is writable, and
// the single production consumer (services/tool/toolUseLoopHelpers.js:1330-1339) stores
// the envelope without ever calling assertForged / isForged. Repo-wide, assertForged has
// exactly one caller (security/adversarial/stressHarness.js) and isForged has none, so in
// the shipping path a tampered intent is consumed without anyone re-checking the seal.
test('B31-F4 freeze is shallow: envelope fields are locked, the certified payload is not', () => {
  const env = intercept('读取 a.js');
  assert.equal(Object.isFrozen(env), true);
  assert.equal(Object.isFrozen(env.payload), false);
  assert.throws(() => {
    'use strict';
    env.sealed = false;
  }, TypeError, 'strict-mode write to a frozen own property throws');
  // A shallow clone of an untouched envelope still verifies: the brand is a
  // globally-reachable Symbol.for key and the seal only covers JSON.stringify(payload),
  // so "having been through the furnace" is transferable by `{ ...env }`.
  assert.equal(isForged({ ...intercept('读取 a.js') }), true);
  env.payload.action = 'DELETE';
  env.payload.strategy = S.STRATEGIES.PROMPT_SOFT;
  assert.equal(env.payload.action, 'DELETE');
  assert.equal(env.sealed, true, 'the seal metadata still claims PASS-shaped truth');
});

test('degradation is mirrored onto the envelope surface', () => {
  const env = intercept('大概删除 a.js');
  assert.equal(env.verdict, 'DEGRADE');
  assert.equal(env.degraded, true);
  assert.equal(env.writeLocked, true);
  assert.equal(env.payload.sandbox, true);
  assert.equal(env.payload.degradeReason, 'low-confidence');
  assert.deepEqual(env.payload.uncertainty, { confidence: 0.6, contradictions: 0 });
  assert.equal(env.strategy, S.STRATEGIES.CODE_HARD);
  assert.equal(S.isStrategy(env.strategy), true);
});

// B31-F15 stays visible from the interceptor: coerceVagueness emits 0.6 (forgeSchema.js:72),
// which is below anomalyHandler.DEGRADE_CONFIDENCE_FLOOR 0.65, so a single 大概/可能/maybe
// marker is enough to auto-degrade to sandbox + writeLocked. The pairing is accidental — the
// two numbers live in different modules and nothing pins them together (a floor move from
// 0.65 to 0.55 silently turns every vague word back into a plain PASS).
test('B31-F15 a lone vague word trips the degrade floor', () => {
  const { DEGRADE_CONFIDENCE_FLOOR } = require('./anomalyHandler');
  assert.equal(DEGRADE_CONFIDENCE_FLOOR, 0.65);
  for (const text of ['大概删除 a.js', '可能读取 a.js', 'maybe 归档 a.js']) {
    const env = intercept(text);
    assert.equal(env.verdict, 'DEGRADE', `degraded for ${text}`);
    assert.equal(env.payload.confidence, 0.6, `confidence for ${text}`);
    assert.ok(env.payload.confidence < DEGRADE_CONFIDENCE_FLOOR);
    assert.equal(env.degraded, true);
    assert.equal(env.writeLocked, true);
  }
  // And the vocabulary is a closed list: 大约 / 左右 are NOT vague markers at all.
  for (const text of ['大约删除 a.js', '删除 a.js 左右']) {
    assert.equal(intercept(text).verdict, 'PASS', `${text} is not in VAGUE_RE`);
  }
});

test('empty input is rejected before any collapse runs', () => {
  for (const raw of ['', '   ', '\n\n', null, undefined]) {
    assert.throws(
      () => intercept(raw),
      (err) =>
        err instanceof FurnaceRejection &&
        err.kind === 'MISSING_ELEMENTS' &&
        err.recoverable === false &&
        JSON.stringify(err.missing) === '["raw"]' &&
        err.message === '空输入，无可坍缩要素',
      `rejects ${JSON.stringify(raw)}`
    );
  }
});

test('rejection is the only leak-free exit: no envelope is returned on REJECT', () => {
  // 4 innocent 取消/推翻 slices (B31-F3) -> CONTRADICTION with 3 conflict pairs.
  assert.throws(
    () => intercept('选中全部文件，取消隐藏文件夹，取消只读属性，推翻前面的选择'),
    (err) =>
      err instanceof FurnaceRejection &&
      err.kind === 'CONTRADICTION' &&
      err.conflicts.length === 3 &&
      err.missing.length === 0 &&
      err.detail.count === 3
  );
});

// B31-F1 (high): the gate is lexical, so unrecognised text is not an anomaly at all — it
// collapses to UNKNOWN with confidence 1 and leaves the furnace at the *lightest* lock
// (Prompt_Soft). UNKNOWN_ACTION is in ANOMALY_KINDS (anomalyHandler.js:22-28) but
// adjudicate never emits it, and neither does forgeSchema, so "动作未能映射到标准原语"
// (the design doc's own promise, DESIGN-ARCH-036 §3.4) has no enforcement point.
test('B31-F1 noise and non-strings exit at the lightest lock (current, wrong)', () => {
  for (const raw of ['qwertyuiop asdfg', '你好，世界', false, 0]) {
    const env = intercept(raw);
    assert.equal(env.verdict, 'PASS', `PASS for ${JSON.stringify(raw)}`);
    assert.equal(env.level, 'L0', `L0 for ${JSON.stringify(raw)}`);
    assert.equal(env.payload.action, 'UNKNOWN', `UNKNOWN for ${JSON.stringify(raw)}`);
    assert.equal(env.payload.confidence, 1, `confidence 1 for ${JSON.stringify(raw)}`);
    assert.equal(env.strategy, S.STRATEGIES.PROMPT_SOFT, `Prompt_Soft for ${JSON.stringify(raw)}`);
    assert.equal(env.degraded, false);
    assert.equal(env.writeLocked, false);
  }
});

// B31-F2 (high): VERB_MAP is first-match-wins (dimensionReducer.js:21-23), so the compound
// clause keeps only the verb found last in the table and the destructive one disappears
// together with its lock. From the interceptor this is the observable end-to-end result:
// "delete and create" is certified as CREATE under the softest strategy.
test('B31-F2 the destructive half of a compound clause vanishes (current, wrong)', () => {
  const env = intercept('删除并创建 a.js');
  assert.equal(env.kind, 'ActionIntent');
  assert.equal(env.payload.action, 'CREATE');
  assert.equal(env.strategy, S.STRATEGIES.PROMPT_SOFT);
  assert.equal(env.verdict, 'PASS');
});

// B31-F7 (medium): chaosInterceptor.js:72 always passes { hadDependency: true } to
// validateTaskGraph, while the predicate that actually knows the answer,
// entropyAssessor.hasCausalDependency (exported at entropyAssessor.js:111), has zero
// consumers repo-wide. Consequence: anything that reaches the L1 layer is required to have
// edges, so a collapse that legitimately produced one node is reported as the *opposite*
// defect ("禁止扁平列表"), and the message tells the human to split a sentence that has
// nothing to split.
test('B31-F7 the L1 validator is told "there was a dependency" regardless of the text', () => {
  const text = '算了改主意推翻';
  assert.equal(hasCausalDependency(text), false, 'the unused predicate knows there is none');
  assert.throws(
    () => intercept(text, { forceLevel: 'L1' }),
    (err) =>
      err instanceof FurnaceRejection &&
      err.kind === 'MISSING_ELEMENTS' &&
      JSON.stringify(err.missing) === '["edges"]' &&
      err.message.includes('禁止扁平列表')
  );
});

// B31-F16 (low): opts is only defaulted for `undefined`, and forceLevel is never validated
// against the {L0,L1,L2} enum. Any other value silently means "not L0 and not L1", i.e. the
// L2 reconstructor, and the envelope echoes the bogus level back to the caller. The header
// advertises forceLevel as the testing seam, so a typo in a test becomes a different layer.
test('B31-F16 forceLevel is an unvalidated free string (current, wrong)', () => {
  const env = intercept('删除 a.js 然后 创建 b.js', { forceLevel: 'L9' });
  assert.equal(env.level, 'L9', 'the bogus level is echoed back');
  assert.equal(env.entropy, null, 'entropy assessment was skipped entirely');
  assert.equal(env.kind, 'StateMachine', 'fell through the else-branch into the L2 layer');

  const lower = intercept('删除 a.js', { forceLevel: 'l0' });
  assert.equal(lower.level, 'l0');
  assert.equal(lower.kind, 'StateMachine');

  // Only undefined triggers the default: null and non-objects become internal anomalies.
  assert.throws(
    () => intercept('删除 a.js', null),
    (err) =>
      err instanceof FurnaceRejection &&
      err.kind === 'MISSING_ELEMENTS' &&
      err.detail.stage === 'assess' &&
      JSON.stringify(err.missing) === '[]' &&
      err.message.includes('熔炉坍缩内部异常')
  );
});

// B31-F16 (b): the entry coercion at chaosInterceptor.js:47 runs BEFORE the try block, so a
// raw whose own toString throws escapes as a bare TypeError instead of the documented
// FurnaceRejection. Every other path in this module is fail-closed; this one is fail-open
// to the caller's exception type, which is what toolUseLoopHelpers' catch-all then swallows.
test('B31-F16 a hostile toString escapes the fail-closed wrapper (current, wrong)', () => {
  assert.throws(
    () => intercept({ toString() { throw new TypeError('boom from toString'); } }),
    (err) => err instanceof TypeError && err.message === 'boom from toString'
  );
  // ... while the equivalent failure inside the try is wrapped.
  assert.throws(() => intercept('删除 a.js', null), FurnaceRejection);
});

test('entities on the envelope are the same object the payload certifies', () => {
  // Object.freeze shallow + payload spread on degrade: the two surfaces alias one map, so a
  // consumer that "annotates" envelope.entities rewrites the sealed payload underneath.
  const env = intercept('读取 a.js，读取 a.js。删除 b.js', { forceLevel: 'L2' });
  assert.equal(env.entities, env.payload.entities);
  assert.equal(Object.keys(env.entities).length, 2);
  env.entities.file_marker = { uid: 'file_marker', type: 'file', canonical: 'x', attrs: {}, mentions: 1 };
  assert.equal(isForged(env), false, 'the aliasing is exactly what breaks the seal');
});

test('L2 contradictions degrade instead of rejecting when they stay under the cap', () => {
  const env = intercept('删除 a.js。但是保留 b.js');
  assert.equal(env.verdict, 'DEGRADE');
  assert.equal(env.payload.contradictions.length, 1);
  assert.equal(env.payload.degradeReason, 'isolable-contradiction');
  assert.equal(env.strategy, S.STRATEGIES.CODE_HARD);
  assert.equal(S.rankOf(env.strategy), 1);
});

test('a forged cycle would be reported as DEADLOCK_CYCLE; the lexical path cannot build one', () => {
  // _detectCycle (chaosInterceptor.js:108) only runs on the L1 branch. weave() always emits
  // a forward-only chain, so no natural-language input reaches the branch; the branch is
  // pinned here through the graph primitives it consumes instead (see taskGraph.test.js for
  // the B31-F8 over-report that would then be forwarded as FurnaceRejection.conflicts).
  const { TaskGraph } = require('./taskGraph');
  const g = new TaskGraph();
  for (const uid of ['n1', 'n2', 'n3', 'n4']) {
    g.addNode({ uid, action: 'READ', params: {} });
  }
  g.addEdge('n1', 'n2', 'seq');
  g.addEdge('n2', 'n3', 'seq');
  g.addEdge('n3', 'n2', 'seq');
  g.addEdge('n3', 'n4', 'seq');
  assert.deepEqual(g.findCycle(), ['n2', 'n3', 'n4']);
  assert.throws(
    () => require('./anomalyHandler').adjudicate({ payload: {}, cycle: g.findCycle() }),
    (err) => err instanceof FurnaceRejection && err.kind === 'DEADLOCK_CYCLE' && JSON.stringify(err.conflicts) === '["n2","n3","n4"]'
  );
});
