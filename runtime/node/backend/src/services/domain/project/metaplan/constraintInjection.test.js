'use strict';

// Unit-level contract tests for constraintInjection.js (co-located, per [RESEARCH-018] §2.3).
// This is the 按需配发锁具 engine — compute and Token must be spent in proportion to risk,
// so the module is deliberately split in two: `resolveInjection` is a declarative, IO-free
// description of what to mount (what the orchestrator reasons about), and
// `runHardValidation` actually runs the mounted interceptors. The properties worth locking:
//   1. Prompt_Soft mounts NOTHING (that is the whole point of the fast path) and its
//      prompt tax is one fixed short sentence;
//   2. Code_Hard mounts the executors' interceptors and rejects on any violation;
//   3. System_Block keeps the code validation AND adds snapshot + confirmation;
//   4. an unrecognized / missing strategy fails safe to Code_Hard rather than to Soft;
//   5. validators are resolved through the registry, so the engine can never mount a
//      net the catalog does not advertise.
// The interceptor calls go through real (pure) validators; the failing sample is chosen
// on the dependency-free balance probe so results do not depend on optional tooling.

const test = require('node:test');
const assert = require('node:assert/strict');

const injection = require('./constraintInjection');
const S = require('./constraintStrategy');
const registry = require('./executorRegistry');

const SOFT = S.STRATEGIES.PROMPT_SOFT;
const HARD = S.STRATEGIES.CODE_HARD;
const BLOCK = S.STRATEGIES.SYSTEM_BLOCK;

const GOOD_DISSENT = '仅修改行内注释文本，不触及任何 AST 节点，绝不改变控制流或语义。';

test('the surface is the hint constant plus the two documented entry points', () => {
  assert.deepEqual(Object.keys(injection).sort(), ['SOFT_FORMAT_HINT', 'resolveInjection', 'runHardValidation']);
  assert.equal(
    injection.SOFT_FORMAT_HINT,
    '仅输出修改后的内容本身，保持原有缩进与编码，不要附加解释。',
  );
  // The prompt tax of the fast path must stay a single short sentence.
  assert.equal(injection.SOFT_FORMAT_HINT.includes('\n'), false);
  assert.ok(injection.SOFT_FORMAT_HINT.length <= 40, `hint grew to ${injection.SOFT_FORMAT_HINT.length} chars`);
});

test('Prompt_Soft mounts nothing at all — the declaration stays honest about it', () => {
  assert.deepEqual(injection.resolveInjection({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT }), {
    strategy: SOFT,
    mountInterceptors: false,
    requireSnapshot: false,
    requireConfirmation: false,
    promptHint: injection.SOFT_FORMAT_HINT,
    validators: [],
    note: 'Prompt_Soft：跳过 AST/沙箱，仅注入极简格式提示，极速执行。',
  });
  // Even a toolchain full of AST-capable executors produces an empty validator list:
  // Soft does not merely "skip running them", it refuses to describe them as mounted.
  assert.deepEqual(
    injection.resolveInjection({ toolchain: registry.executorIds(), constraint_strategy: SOFT }).validators,
    [],
  );
});

test('System_Block doubles up: code validation stays mounted AND snapshot/confirm are demanded', () => {
  const out = injection.resolveInjection({ toolchain: ['js_babel_writer'], constraint_strategy: BLOCK });
  assert.deepEqual(out, {
    strategy: BLOCK,
    mountInterceptors: true,
    requireSnapshot: true,
    requireConfirmation: true,
    promptHint: '',
    validators: [{ executor: 'js_babel_writer', validator: 'babel', astSafetyNet: true }],
    note: 'System_Block：系统级挂起，须先备份快照 + 确认才放行；并仍挂载代码校验。',
  });
});

test('Code_Hard mounts exactly the registry-declared interceptor for each executor', () => {
  const out = injection.resolveInjection({
    toolchain: ['js_babel_writer', 'py_ast_replacer', 'generic_syntax_writer', 'raw_string_injector'],
    constraint_strategy: HARD,
  });
  assert.equal(out.strategy, HARD);
  assert.equal(out.mountInterceptors, true);
  assert.equal(out.requireSnapshot, false);
  assert.equal(out.requireConfirmation, false);
  assert.equal(out.promptHint, '', 'Hard adds no prompt tax — its cost is the interceptor');
  assert.deepEqual(out.validators, [
    { executor: 'js_babel_writer', validator: 'babel', astSafetyNet: true },
    { executor: 'py_ast_replacer', validator: 'python_ast', astSafetyNet: true },
    { executor: 'generic_syntax_writer', validator: 'vm_or_native', astSafetyNet: true },
    { executor: 'raw_string_injector', validator: null, astSafetyNet: false },
  ]);
  // Order follows the toolchain (application order matters to the orchestrator).
  const reversed = injection.resolveInjection({
    toolchain: ['raw_string_injector', 'js_babel_writer'],
    constraint_strategy: HARD,
  });
  assert.deepEqual(
    reversed.validators.map((v) => v.executor),
    ['raw_string_injector', 'js_babel_writer'],
  );
});

test('an unknown strategy fails safe to Code_Hard rather than to the cheap path', () => {
  const fails = [];
  for (const bad of ['Bogus', '', 'prompt_soft', 'Soft', null, undefined]) {
    const out = injection.resolveInjection({ toolchain: ['js_babel_writer'], constraint_strategy: bad });
    if (out.strategy !== HARD) fails.push(`${JSON.stringify(bad)} resolved to ${out.strategy}, expected Code_Hard`);
    if (out.mountInterceptors !== true) fails.push(`${JSON.stringify(bad)} skipped interception`);
    if (out.requireSnapshot !== false) fails.push(`${JSON.stringify(bad)} demanded a snapshot`);
  }
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('resolveInjection tolerates a missing or malformed plan object', () => {
  for (const junk of [undefined, null, 'a string', 42, [], {}]) {
    const out = injection.resolveInjection(junk);
    assert.equal(out.strategy, HARD, `${JSON.stringify(junk)} must fail safe to Code_Hard`);
    assert.deepEqual(out.validators, [], `${JSON.stringify(junk)} has no toolchain to mount`);
    assert.equal(out.mountInterceptors, true);
  }
  // A plan with a toolchain but no strategy still reports Code_Hard and keeps its validators.
  const partial = injection.resolveInjection({ toolchain: ['generic_syntax_writer'] });
  assert.equal(partial.strategy, HARD);
  assert.deepEqual(partial.validators, [
    { executor: 'generic_syntax_writer', validator: 'vm_or_native', astSafetyNet: true },
  ]);
});

test('validators for an id outside the catalog degrade to null rather than throwing', () => {
  // resolveInjection is reachable with a hand-built plan (see constraintLattice callers),
  // so a made-up executor must produce "nothing mounted", not a crash.
  const out = injection.resolveInjection({ toolchain: ['made_up_writer'], constraint_strategy: HARD });
  assert.deepEqual(out.validators, [{ executor: 'made_up_writer', validator: null, astSafetyNet: false }]);
});

test('runHardValidation short-circuits Soft: nothing runs, nothing can fail', () => {
  const out = injection.runHardValidation({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT }, 'function (');
  assert.deepEqual(out, {
    passed: true,
    strategy: SOFT,
    ranValidation: false,
    results: [],
    violations: [],
    requireSnapshot: false,
    requireConfirmation: false,
  });
  // Syntactically catastrophic content still passes on the Soft path — that is the bet
  // the risk_dissent and the circuit-breaker are there to make expensive, not invisible.
  assert.equal(injection.runHardValidation({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT }, '{{{(((').passed, true);
});

test('runHardValidation rejects broken content under Code_Hard and names the offender', () => {
  // 'cobol' routes generic_syntax_writer to the dependency-free balance probe, so this
  // verdict does not depend on which optional parsers the machine happens to have.
  const out = injection.runHardValidation(
    { toolchain: ['generic_syntax_writer'], constraint_strategy: HARD },
    'fn main() {',
    { language: 'cobol' },
  );
  assert.equal(out.passed, false);
  assert.equal(out.strategy, HARD);
  assert.equal(out.ranValidation, true);
  assert.equal(out.requireSnapshot, false);
  assert.equal(out.requireConfirmation, false);
  assert.deepEqual(out.results, [
    {
      executor: 'generic_syntax_writer',
      validator: 'balance',
      ok: false,
      error: '括号不配平：1 个未闭合。',
    },
  ]);
  assert.deepEqual(out.violations, [
    { executor: 'generic_syntax_writer', error: '括号不配平：1 个未闭合。' },
  ]);

  const clean = injection.runHardValidation(
    { toolchain: ['generic_syntax_writer'], constraint_strategy: HARD },
    'fn main() {}',
    { language: 'cobol' },
  );
  assert.equal(clean.passed, true);
  assert.deepEqual(clean.violations, []);
  assert.equal(clean.results[0].ok, true);
  assert.equal(clean.results[0].error, undefined);
});

test('a raw (validator-less) executor passes any content under Code_Hard', () => {
  // The registry advertises this as "高（用于代码时）：无语法网" — the engine must be
  // honest about it instead of pretending a net was mounted.
  const out = injection.runHardValidation(
    { toolchain: ['raw_string_injector'], constraint_strategy: HARD },
    'function ( {{{',
    { language: 'javascript' },
  );
  assert.equal(out.ranValidation, true, 'it still reports having run the mounted set');
  assert.equal(out.passed, true);
  assert.deepEqual(out.violations, []);
  assert.deepEqual(out.results, [{ executor: 'raw_string_injector', validator: 'none', ok: true, error: undefined }]);
});

test('every mounted interceptor runs and EVERY violation is reported, not just the first', () => {
  const plan = {
    toolchain: ['generic_syntax_writer', 'raw_string_injector', 'made_up_writer'],
    constraint_strategy: HARD,
  };
  const out = injection.runHardValidation(plan, 'let s = "unterminated', { language: 'cobol' });
  assert.equal(out.results.length, 3, 'one result per mounted executor');
  assert.deepEqual(
    out.results.map((r) => r.executor),
    ['generic_syntax_writer', 'raw_string_injector', 'made_up_writer'],
  );
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[1].ok, true);
  assert.equal(out.passed, false);
  assert.equal(out.violations.length, 1);
  // A second broken executor would add a second violation — the loop does not break early.
  const two = injection.runHardValidation(
    { toolchain: ['generic_syntax_writer', 'generic_syntax_writer'], constraint_strategy: HARD },
    '}',
    { language: 'cobol' },
  );
  assert.equal(two.violations.length, 2, 'validation must not stop at the first violation');
});

test('System_Block demands snapshot + confirmation AND still rejects broken content', () => {
  const plan = { toolchain: ['generic_syntax_writer'], constraint_strategy: BLOCK };
  const bad = injection.runHardValidation(plan, 'fn main() {', { language: 'cobol' });
  assert.equal(bad.passed, false);
  assert.equal(bad.strategy, BLOCK);
  assert.equal(bad.requireSnapshot, true);
  assert.equal(bad.requireConfirmation, true);
  const good = injection.runHardValidation(plan, 'fn main() {}', { language: 'cobol' });
  assert.equal(good.passed, true, 'Block gates on snapshot/confirm, not on a free veto');
  assert.equal(good.requireSnapshot, true);
});

test('runHardValidation is honest about the missing dissent path: it mirrors resolveInjection', () => {
  // The two halves must never disagree about what is mounted, or the orchestrator would
  // reason about one plan and execute another.
  for (const strategy of [SOFT, HARD, BLOCK]) {
    for (const toolchain of [['js_babel_writer'], registry.executorIds(), []]) {
      const plan = { toolchain, constraint_strategy: strategy };
      const declared = injection.resolveInjection(plan);
      const ran = injection.runHardValidation(plan, 'const a = 1;', { language: 'javascript' });
      assert.equal(ran.strategy, declared.strategy);
      assert.equal(ran.requireSnapshot, declared.requireSnapshot);
      assert.equal(ran.requireConfirmation, declared.requireConfirmation);
      assert.equal(
        ran.results.length,
        declared.mountInterceptors ? declared.validators.length : 0,
        `${strategy} ran a different set than it declared`,
      );
    }
  }
});

test('ctx defaults to no language and a missing content is still a verdict, never a throw', () => {
  const plan = { toolchain: ['generic_syntax_writer'], constraint_strategy: HARD };
  for (const content of [undefined, null, '', 42]) {
    assert.doesNotThrow(() => injection.runHardValidation(plan, content));
  }
  // No ctx at all: generic_syntax_writer takes the empty-language JS arm.
  const out = injection.runHardValidation(plan, 'const a = 1;');
  assert.deepEqual(out.results, [{ executor: 'generic_syntax_writer', validator: 'vm', ok: true, error: undefined }]);
  assert.equal(out.passed, true);
});

test('the dissent-backed Soft plan the schema produces stays on the mount-nothing path', () => {
  // End-to-end stitch between metaPlanSchema and this engine, without the coordinator:
  // a schema-validated Soft plan must describe zero mounted interceptors.
  const schema = require('./metaPlanSchema');
  const validated = schema.validateMetaPlan({
    toolchain: ['raw_string_injector'],
    constraint_strategy: SOFT,
    risk_dissent: GOOD_DISSENT,
  });
  assert.equal(validated.valid, true);
  const declared = injection.resolveInjection(validated.normalized);
  assert.equal(declared.mountInterceptors, false);
  const ran = injection.runHardValidation(validated.normalized, 'function (', { language: 'javascript' });
  assert.deepEqual(ran.results, []);
  assert.equal(ran.passed, true);
  // …while the same plan with a thin dissent comes back already escalated to Code_Hard.
  const lazy = injection.resolveInjection(
    schema.validateMetaPlan({ toolchain: ['raw_string_injector'], constraint_strategy: SOFT, risk_dissent: 'ok' })
      .normalized,
  );
  assert.equal(lazy.strategy, HARD);
  assert.equal(lazy.mountInterceptors, true);
});
