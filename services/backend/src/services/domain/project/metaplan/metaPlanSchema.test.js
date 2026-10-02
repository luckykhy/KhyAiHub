'use strict';

// Unit-level contract tests for metaPlanSchema.js (co-located, per [RESEARCH-018] §2.3).
// This module owns the 元规划 contract: the schema the model must answer, the tolerant
// parse, and — the part with teeth — the deterministic validate/normalize step where
// 防偷懒 (anti-laziness) happens. Three properties are worth locking hard:
//   1. the schema's executor enum can never drift from the live registry (防呆: 模型
//      不可凭空捏造执行器), so a new executor is automatically offerable and a removed
//      one automatically rejected;
//   2. a Prompt_Soft bet without a substantive dissent is ESCALATED, not failed —
//      skipping the justification must never be the cheaper option;
//   3. nothing else is escalated: Code_Hard / System_Block choices, and a well-argued
//      Soft choice over a no-AST executor, pass through untouched.
// process.env.KHY_METAPLAN_MIN_DISSENT is set and cleared inside the tests that use it.

const test = require('node:test');
const assert = require('node:assert/strict');

const schema = require('./metaPlanSchema');
const registry = require('./executorRegistry');
const S = require('./constraintStrategy');

const SOFT = S.STRATEGIES.PROMPT_SOFT;
const HARD = S.STRATEGIES.CODE_HARD;
const BLOCK = S.STRATEGIES.SYSTEM_BLOCK;

// 13 visible characters — under the default floor of 12 it would pass, so this string
// is chosen to be unambiguously long enough and is reused as the "good dissent".
const GOOD_DISSENT = '仅修改行内注释文本，不触及任何 AST 节点，绝不改变控制流或语义。';

test('the exported surface and the documented default dissent floor', () => {
  assert.deepEqual(Object.keys(schema).sort(), [
    'DEFAULT_MIN_DISSENT',
    'buildMetaPlanSchema',
    'parseMetaPlan',
    'validateMetaPlan',
  ]);
  assert.equal(schema.DEFAULT_MIN_DISSENT, 12);
});

test('buildMetaPlanSchema declares the contract fields the coordinator depends on', () => {
  const sc = schema.buildMetaPlanSchema();
  assert.equal(sc.type, 'object');
  assert.equal(sc.additionalProperties, false, 'the model may not smuggle extra fields in');
  assert.deepEqual(sc.required, ['toolchain', 'constraint_strategy']);
  assert.equal(sc.properties.toolchain.type, 'array');
  assert.equal(sc.properties.toolchain.minItems, 1);
  assert.equal(sc.properties.constraint_strategy.type, 'string');
  assert.equal(sc.properties.risk_dissent.type, 'string');
  assert.equal(sc.properties.risk_dissent.maxLength, 400);
  // risk_dissent must stay OPTIONAL at schema level — the escalation is the module's job,
  // not a hard validation failure, so that laziness gets tightened rather than bounced.
  assert.deepEqual(sc.required.includes('risk_dissent'), false);
});

test('the schema enum is generated from the live registry and the strategy ladder', () => {
  assert.deepEqual(schema.buildMetaPlanSchema().properties.toolchain.items.enum, registry.executorIds());
  assert.deepEqual(schema.buildMetaPlanSchema().properties.constraint_strategy.enum, [...S.ALL]);
  // A fresh object per call: the schema is handed to callers that may tweak it.
  const a = schema.buildMetaPlanSchema();
  const b = schema.buildMetaPlanSchema();
  assert.notEqual(a, b);
  assert.notEqual(a.properties.toolchain.items.enum, b.properties.toolchain.items.enum);
  assert.deepEqual(a, b);
});

test('parseMetaPlan recovers the plan from prose and fenced blocks', () => {
  const direct = schema.parseMetaPlan('{"toolchain":["js_babel_writer"],"constraint_strategy":"Code_Hard"}');
  assert.equal(direct.ok, true);
  assert.deepEqual(direct.plan, { toolchain: ['js_babel_writer'], constraint_strategy: 'Code_Hard' });

  const fenced = schema.parseMetaPlan(
    '好的，先给出元规划：\n```json\n{"toolchain":["raw_string_injector"],"constraint_strategy":"Prompt_Soft"}\n```',
  );
  assert.equal(fenced.ok, true);
  assert.deepEqual(fenced.plan.toolchain, ['raw_string_injector']);

  const narrated = schema.parseMetaPlan(
    '我打算这样执行 {"toolchain":["py_ast_replacer"],"constraint_strategy":"Code_Hard"} 请确认。',
  );
  assert.equal(narrated.ok, true);
  assert.deepEqual(narrated.plan.toolchain, ['py_ast_replacer']);
});

test('parseMetaPlan refuses anything that is not a JSON object, with the 防呆① message', () => {
  const rejected = [
    ['no json at all', '我先想想，稍后再说。'],
    ['empty string', ''],
    ['top-level array', '[1,2,3]'],
    ['bare scalar', '42'],
    ['null literal', 'null'],
  ];
  for (const [label, raw] of rejected) {
    const out = schema.parseMetaPlan(raw);
    assert.equal(out.ok, false, `${label} must not parse`);
    assert.equal(out.plan, undefined);
    assert.match(out.error, /元规划/);
  }
  assert.equal(
    schema.parseMetaPlan('no json here').error,
    '未能从输出中解析出元规划 JSON 对象（防呆①：必须先产出元规划再执行）。',
  );
});

test('validateMetaPlan rejects non-objects and unregistered / illegal plans', () => {
  const fails = [];
  const rejects = [
    ['null', null, '元规划必须是一个 JSON 对象。'],
    ['undefined', undefined, '元规划必须是一个 JSON 对象。'],
    ['array', [], '元规划必须是一个 JSON 对象。'],
    ['string', 'Code_Hard', '元规划必须是一个 JSON 对象。'],
    ['number', 7, '元规划必须是一个 JSON 对象。'],
    ['empty toolchain', { toolchain: [], constraint_strategy: HARD }, 'toolchain 必须是非空数组'],
    ['missing toolchain', { constraint_strategy: HARD }, 'toolchain 必须是非空数组'],
    ['invented executor', { toolchain: ['totally_made_up'], constraint_strategy: HARD }, '未注册执行器'],
    ['unknown strategy', { toolchain: ['js_babel_writer'], constraint_strategy: 'Nope' }, 'constraint_strategy 非法'],
    ['blank strategy', { toolchain: ['js_babel_writer'] }, 'constraint_strategy 非法「(空)」'],
  ];
  for (const [label, plan, needle] of rejects) {
    const out = schema.validateMetaPlan(plan);
    if (out.valid !== false) fails.push(`${label}: expected invalid, got ${JSON.stringify(out)}`);
    else if (!out.error.includes(needle)) fails.push(`${label}: error "${out.error}" lacks "${needle}"`);
    if (out.normalized !== undefined) fails.push(`${label}: invalid plan must not carry a normalized`);
  }
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('a valid Code_Hard plan normalizes with no escalation and preserved ids', () => {
  const out = schema.validateMetaPlan({
    toolchain: [' js_babel_writer ', 'generic_syntax_writer'],
    constraint_strategy: ' Code_Hard ',
  });
  assert.equal(out.valid, true);
  assert.deepEqual(out.normalized.toolchain, ['js_babel_writer', 'generic_syntax_writer'], 'ids are trimmed');
  assert.equal(out.normalized.constraint_strategy, HARD);
  assert.equal(out.normalized.declared_strategy, HARD, 'declared keeps the normalized spelling');
  assert.deepEqual(out.normalized.escalations, []);
  assert.equal(out.normalized.risk_dissent, '', 'absent dissent normalizes to empty string');
});

test('防偷懒 core: Prompt_Soft without a substantive dissent is escalated, not failed', () => {
  const out = schema.validateMetaPlan({
    toolchain: ['js_babel_writer'],
    constraint_strategy: SOFT,
    risk_dissent: 'ok',
  });
  assert.equal(out.valid, true, 'laziness must never make the call fail');
  assert.equal(out.normalized.declared_strategy, SOFT, 'what the model wrote stays visible');
  assert.equal(out.normalized.constraint_strategy, HARD, 'the effective lock is raised');
  assert.equal(out.normalized.escalations.length, 1);
  assert.equal(
    out.normalized.escalations[0],
    '选择 Prompt_Soft 但未给出充分的 risk_dissent（< 12 字），按规则自动升级为 Code_Hard（拒绝偷懒）。',
  );
  // The dissent text itself is preserved verbatim (trimmed) even though it lost.
  assert.equal(out.normalized.risk_dissent, 'ok');
});

test('the dissent floor counts trimmed characters, and empty is not an argument', () => {
  const fails = [];
  const mk = (dissent) => schema.validateMetaPlan({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT, risk_dissent: dissent });
  // Exactly DEFAULT_MIN_DISSENT characters clears the floor.
  if (mk('a'.repeat(12)).normalized.escalations.length !== 0) fails.push('12 chars should clear the floor');
  // One short of it does not.
  if (mk('a'.repeat(11)).normalized.escalations.length !== 1) fails.push('11 chars should escalate');
  // Surrounding whitespace is not substance.
  if (mk('   ok   ').normalized.escalations.length !== 1) fails.push('padded "ok" should escalate');
  // Absent, null and non-string all count as empty.
  for (const dissent of [undefined, null, '', '   ', 123, true, ['a long enough string']]) {
    const out = mk(dissent);
    if (out.normalized.escalations.length !== 1) fails.push(`${JSON.stringify(dissent)} should escalate`);
    if (out.normalized.risk_dissent !== '') fails.push(`${JSON.stringify(dissent)} should normalize to ''`);
  }
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('a well-argued Soft choice over a no-AST executor is the legitimate fast path', () => {
  // registry.toolchainHasUnguarded(['raw_string_injector']) is true, and this is exactly
  // the branch the goal wants to keep cheap: with a sufficient dissent the plan must
  // stay Soft with ZERO escalations — the dissent is the accountable justification.
  assert.equal(registry.toolchainHasUnguarded(['raw_string_injector']), true);
  const out = schema.validateMetaPlan({
    toolchain: ['raw_string_injector'],
    constraint_strategy: SOFT,
    risk_dissent: GOOD_DISSENT,
  });
  assert.equal(out.valid, true);
  assert.equal(out.normalized.constraint_strategy, SOFT, 'must NOT be escalated');
  assert.deepEqual(out.normalized.escalations, []);
  assert.equal(out.normalized.risk_dissent, GOOD_DISSENT);
});

test('Code_Hard and System_Block never get escalated for a missing dissent', () => {
  const fails = [];
  for (const strategy of [HARD, BLOCK]) {
    const out = schema.validateMetaPlan({ toolchain: ['raw_string_injector'], constraint_strategy: strategy });
    if (out.normalized.constraint_strategy !== strategy) fails.push(`${strategy} was changed to ${out.normalized.constraint_strategy}`);
    if (out.normalized.escalations.length !== 0) fails.push(`${strategy} carried escalations ${JSON.stringify(out.normalized.escalations)}`);
    if (out.normalized.declared_strategy !== strategy) fails.push(`${strategy} declared_strategy drifted`);
  }
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('KHY_METAPLAN_MIN_DISSENT retunes the floor, and junk falls back to the default', () => {
  const saved = process.env.KHY_METAPLAN_MIN_DISSENT;
  const lazily = () => schema.validateMetaPlan({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT, risk_dissent: 'ok' });
  try {
    process.env.KHY_METAPLAN_MIN_DISSENT = '0';
    assert.equal(lazily().normalized.escalations.length, 0, 'a zero floor never escalates');
    process.env.KHY_METAPLAN_MIN_DISSENT = '2';
    assert.equal(lazily().normalized.escalations.length, 0, '"ok" is 2 chars, exactly at the floor');
    process.env.KHY_METAPLAN_MIN_DISSENT = '3';
    assert.equal(lazily().normalized.escalations.length, 1, '"ok" is under 3');
    // The escalation message quotes the live threshold, not the compile-time default.
    assert.match(lazily().normalized.escalations[0], /< 3 字/);
    for (const junk of ['abc', '-5', '', '   ']) {
      process.env.KHY_METAPLAN_MIN_DISSENT = junk;
      const out = lazily();
      assert.equal(out.normalized.escalations.length, 1, `junk ${JSON.stringify(junk)} must fall back to 12`);
      assert.match(out.normalized.escalations[0], /< 12 字/);
    }
  } finally {
    if (saved === undefined) delete process.env.KHY_METAPLAN_MIN_DISSENT;
    else process.env.KHY_METAPLAN_MIN_DISSENT = saved;
  }
  assert.equal('KHY_METAPLAN_MIN_DISSENT' in process.env, saved !== undefined, 'the env must be restored');
});

test('validation is pure: it returns a fresh result and mutates no shared table', () => {
  const before = JSON.stringify(schema.buildMetaPlanSchema());
  const a = schema.validateMetaPlan({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT, risk_dissent: GOOD_DISSENT });
  const b = schema.validateMetaPlan({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT, risk_dissent: GOOD_DISSENT });
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(schema.buildMetaPlanSchema()), before, 'validation must not mutate the registry menu');
  assert.equal(registry.getExecutor('js_babel_writer').astSafetyNet, true);
});

test('the reject message lists the legal strategies in ladder order', () => {
  const out = schema.validateMetaPlan({ toolchain: ['js_babel_writer'], constraint_strategy: 'Lazy' });
  assert.equal(
    out.error,
    'constraint_strategy 非法「Lazy」，必须取自：Prompt_Soft / Code_Hard / System_Block。',
  );
});
