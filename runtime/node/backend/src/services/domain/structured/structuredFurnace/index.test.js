'use strict';

/**
 * index.test.js — co-located unit test for index.js (D2 unit structuredFurnace).
 * The facade is the only import surface the design doc allows (§3.1 绝对前置拦截),
 * so this file pins (a) the façade wiring, (b) the documented end-to-end protocol and
 * (c) the adversarial-input behaviour callers actually observe.
 * Pure node:test, synchronous, zero I/O.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const furnace = require('./index');

const FACADE_KEYS = [
  'intercept',
  'assertForged',
  'isForged',
  'SEAL_BRAND',
  'FurnaceRejection',
  'reduce',
  'weave',
  'reconstruct',
  'assess',
  'adjudicate',
  'validate',
  'entropyAssessor',
  'entityRegistry',
  'EntityRegistry',
  'taskGraph',
  'TaskGraph',
  'stateMachine',
  'StateMachine',
  'forgeSchema',
  'dimensionReducer',
  'intentWeaver',
  'skeletonReconstructor',
  'anomalyHandler',
  'chaosInterceptor',
];

test('the façade exports exactly the documented 24 names, in source order', () => {
  assert.deepEqual(Object.keys(furnace), FACADE_KEYS);
  assert.equal(FACADE_KEYS.length, 24);
});

test('the façade is a reference-identical re-export, not a copy or a wrapper', () => {
  const ci = require('./chaosInterceptor');
  assert.equal(furnace.intercept, ci.intercept);
  assert.equal(furnace.assertForged, ci.assertForged);
  assert.equal(furnace.isForged, ci.isForged);
  assert.equal(furnace.SEAL_BRAND, ci.SEAL_BRAND);
  assert.equal(furnace.FurnaceRejection, require('./anomalyHandler').FurnaceRejection);
  assert.equal(furnace.reduce, require('./dimensionReducer').reduce);
  assert.equal(furnace.weave, require('./intentWeaver').weave);
  assert.equal(furnace.reconstruct, require('./skeletonReconstructor').reconstruct);
  assert.equal(furnace.assess, require('./entropyAssessor').assess);
  assert.equal(furnace.adjudicate, require('./anomalyHandler').adjudicate);
  assert.equal(furnace.validate, require('./forgeSchema').validate);
  assert.equal(furnace.EntityRegistry, require('./entityRegistry').EntityRegistry);
  assert.equal(furnace.TaskGraph, require('./taskGraph').TaskGraph);
  assert.equal(furnace.StateMachine, require('./stateMachine').StateMachine);
  // namespace re-exports point at the very same module objects => one require cache,
  // hence exactly one per-process seal salt whoever imports the furnace.
  assert.equal(furnace.chaosInterceptor, ci);
  assert.equal(require('./index'), furnace);
  assert.equal(Object.isFrozen(furnace), false);
});

test('documented happy path from the header example: intercept -> assertForged -> read payload only', () => {
  let env;
  try {
    env = furnace.intercept('删除 a.js');
  } catch (e) {
    assert.fail('the documented happy path must not reject: ' + e.message);
  }
  assert.equal(furnace.assertForged(env), env);
  assert.equal(furnace.isForged(env), true);
  assert.equal(env.kind, 'ActionIntent');
  assert.equal(env.payload.action, 'DELETE');
  assert.equal(env.verdict, 'PASS');
  assert.equal(env.degraded, false);
});

test('documented rejection path: instanceof the façade class, and toJSON is the clarification payload', () => {
  let err;
  try {
    furnace.intercept('   ');
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof furnace.FurnaceRejection, 'the class exported by the façade is the thrown class');
  assert.deepEqual(err.toJSON(), {
    error: 'FurnaceRejection',
    kind: 'MISSING_ELEMENTS',
    message: '空输入，无可坍缩要素',
    missing: ['raw'],
    conflicts: [],
    detail: {},
  });
  assert.equal(err.recoverable, false);
  assert.equal(err.stack.split('\n')[0].startsWith('FurnaceRejection'), true);
});

test('the three collapse layers and the interceptor agree through the façade', () => {
  const table = [
    ['删除 a.js', 'L0', 'ActionIntent'],
    ['先备份然后清理 b.js', 'L1', 'TaskGraph'],
    ['删除 a.js。但是保留 b.js', 'L2', 'StateMachine'],
  ];
  for (const [text, level, kind] of table) {
    assert.equal(furnace.assess(text).level, level, `router for ${text}`);
    const env = furnace.intercept(text);
    assert.equal(env.level, level, `envelope level for ${text}`);
    assert.equal(env.kind, kind, `envelope kind for ${text}`);
  }
  // L0 goes through reduce() untouched, so the sealed payload is byte-identical to the
  // standalone reducer output.
  assert.equal(
    JSON.stringify(furnace.reduce('删除 a.js')),
    JSON.stringify(furnace.intercept('删除 a.js').payload)
  );
  // One salt per process: two interceptions of the same sentence seal identically.
  assert.equal(furnace.intercept('删除 a.js').seal, furnace.intercept('删除 a.js').seal);
});

test('validate dispatches on payload.kind and fail-safes on anything else', () => {
  assert.equal(furnace.validate(furnace.reduce('删除 a.js')).valid, true);
  assert.equal(furnace.validate(furnace.weave('先备份然后清理 b.js')).valid, true);
  assert.equal(furnace.validate(furnace.reconstruct('删除 a.js。但是保留 b.js')).valid, true);
  for (const junk of [{ kind: 'Nonsense' }, {}, '删除 a.js', 42, null]) {
    const r = furnace.validate(junk);
    assert.equal(r.valid, false, `rejects ${JSON.stringify(junk)}`);
    assert.match(r.error, /未知坍缩产出 kind/);
  }
});

test('adjudicate is reachable standalone and reproduces the interceptor verdict', () => {
  const payload = furnace.reconstruct('选中全部文件，取消隐藏文件夹，取消只读属性');
  assert.equal(payload.contradictions.length, 2);
  assert.throws(
    () => furnace.adjudicate({ payload, contradictions: payload.contradictions }),
    (e) => e instanceof furnace.FurnaceRejection && e.kind === 'CONTRADICTION'
  );
  assert.equal(furnace.adjudicate({ payload: furnace.reduce('读取 a.js') }).verdict, 'PASS');
});

// B31-F1 (high): the furnace is the mandated front gate for ALL untrusted natural language
// ("任何外部自然语言在触达 Khyos 核心推理/业务逻辑之前", chaosInterceptor.js:6-9), yet a
// shell-injection-shaped request sails through it. The gate is lexical, so `rm` maps to the
// DELETE primitive, the rest of the command line becomes the entity name, and the verdict is
// PASS with the seal minted. Nothing in the unit inspects shell metacharacters, and the only
// in-unit consumer (services/tool/toolUseLoopHelpers.js) does not call assertForged either,
// so the sealed envelope is the artefact downstream code trusts.
test('B31-F1 shell-injection shaped text is sealed as a legitimate intent (current, wrong)', () => {
  const env = furnace.intercept('rm -rf / && echo pwned');
  assert.equal(env.level, 'L0');
  assert.equal(env.verdict, 'PASS');
  assert.equal(env.payload.action, 'DELETE');
  assert.equal(env.strategy, 'Code_Hard');
  assert.deepEqual(Object.values(env.payload.entities).map((e) => e.canonical), ['-rf / && echo pwned']);
  assert.equal(furnace.assertForged(env), env, 'and the tamper check is satisfied by it');

  const quoted = furnace.intercept("'; DROP TABLE users;--");
  assert.equal(quoted.level, 'L1');
  assert.equal(quoted.verdict, 'PASS');
  assert.deepEqual(Object.values(quoted.payload.entities).map((e) => e.canonical), ["'", 'DROP TABLE users', '--']);
});

// B31-F17: extractTarget's file-token regex runs before the verb-stripping path, so a path
// traversal attempt is not contained or rejected — it is *mangled* into a topic entity that
// no longer names the requested file ('../../etc/passwd' -> '/ /etc/passwd', because '.' is
// inside the token class and the dots get eaten by the separator collapse). READ on a
// traversal target therefore leaves the mandated front gate at the lightest lock.
test('B31-F17 a traversal path is rewritten, never contained (current, wrong)', () => {
  const env = furnace.intercept('../../etc/passwd 读取');
  assert.equal(env.level, 'L0');
  assert.equal(env.verdict, 'PASS');
  assert.equal(env.payload.action, 'READ');
  assert.equal(env.strategy, 'Prompt_Soft', 'READ is not in RISKY_ACTIONS, so traversal gets the lightest lock');
  assert.deepEqual(Object.values(env.payload.entities).map((e) => e.canonical), ['/ /etc/passwd']);
  assert.equal(env.entities, env.payload.entities, 'the envelope aliases the very map it certifies');
});

// B31-F16 (low): the façade is the documented single import面, but the two thresholds the
// verdicts depend on (DEGRADE_CONFIDENCE_FLOOR, CONTRADICTION_DEGRADE_MAX) and ANOMALY_KINDS
// are only reachable through the namespace re-exports, and the dead predicate
// hasCausalDependency is not on the flat surface at all. A consumer that follows the header
// example (furnace.X) cannot read the numbers it is being judged by — which is how the same
// constant drifted apart in this unit.
test('the tuning constants sit behind namespaces, not on the flat façade', () => {
  assert.equal(furnace.ANOMALY_KINDS, undefined);
  assert.equal(furnace.DEGRADE_CONFIDENCE_FLOOR, undefined);
  assert.equal(furnace.hasCausalDependency, undefined);
  assert.deepEqual(furnace.anomalyHandler.ANOMALY_KINDS, [
    'MISSING_ELEMENTS',
    'DEADLOCK_CYCLE',
    'CONTRADICTION',
    'LOW_CONFIDENCE',
    'UNKNOWN_ACTION',
  ]);
  assert.equal(furnace.anomalyHandler.DEGRADE_CONFIDENCE_FLOOR, 0.65);
  assert.equal(furnace.anomalyHandler.CONTRADICTION_DEGRADE_MAX, 1);
  assert.equal(typeof furnace.entropyAssessor.hasCausalDependency, 'function');
});

test('a seal minted through the façade is verifiable through the deep import path', () => {
  const deep = require('./chaosInterceptor');
  const env = furnace.intercept('读取 config.yaml');
  assert.equal(deep.assertForged(env), env, 'deep import accepts the façade envelope');
  assert.equal(furnace.assertForged(deep.intercept('读取 config.yaml')).sealed, true, 'and vice versa');
  assert.equal(env.seal, deep.intercept('读取 config.yaml').seal, 'one salt for both import paths');
});

test('the empty-input guard rejects only the string/absent family, not punctuation', () => {
  // '', null and undefined hit the trim guard (chaosInterceptor.js:47-53) and are the ONLY
  // "nothing to collapse" inputs that reject. A bare '。' still mints a topic entity and is
  // sealed as an ActionIntent (B31-F1: unrecognised text is never an anomaly).
  for (const raw of ['', '   ', null, undefined]) {
    assert.throws(() => furnace.intercept(raw), furnace.FurnaceRejection, `rejects ${String(raw)}`);
  }
  for (const raw of ['。', '。 。', NaN]) {
    const env = furnace.intercept(raw);
    assert.equal(env.verdict, 'PASS', `${String(raw)} passes instead of rejecting`);
    assert.equal(env.kind, 'ActionIntent');
    assert.equal(env.payload.action, 'UNKNOWN');
  }
});
