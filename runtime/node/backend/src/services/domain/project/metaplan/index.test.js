'use strict';

// Unit-level contract tests for metaplan/index.js (co-located, per [RESEARCH-018] §2.3).
// The coordinator is the only orchestration surface: prompt → ingest → validate → record.
// Everything interesting about it is *composition*, so these tests lock the wiring rather
// than re-deriving each submodule:
//   - the override stack applies in the documented order, with the constitutional red line
//     LAST so it is unmistakably uncoverable;
//   - the ticket is the only carrier between step 2 and step 3 — a ticket without a plan
//     is refused outright (防呆①), never silently treated as Soft;
//   - there is NO singleton and NO memoization: state lives on the instance's breaker, so
//     one coordinator cannot contaminate another session;
//   - the re-exports are identity-equal to the submodule objects, not copies (mirrors
//     marshal/), so callers and the coordinator always see the same catalog.
// The breaker is injected as a stub in the wiring tests so ordering claims do not depend
// on the streak arithmetic trustCircuitBreaker.test.js already covers.

const test = require('node:test');
const assert = require('node:assert/strict');

const facade = require('./index');
const { MetaPlanCoordinator } = facade;

const strategyEnum = require('./constraintStrategy');
const registry = require('./executorRegistry');
const schema = require('./metaPlanSchema');
const interceptors = require('./codeInterceptors');
const injection = require('./constraintInjection');
const redLines = require('./constitutionalRedLines');
const { TrustCircuitBreaker } = require('./trustCircuitBreaker');

const SOFT = strategyEnum.STRATEGIES.PROMPT_SOFT;
const HARD = strategyEnum.STRATEGIES.CODE_HARD;
const BLOCK = strategyEnum.STRATEGIES.SYSTEM_BLOCK;

const GOOD_DISSENT = '仅修改行内注释文本，不触及任何 AST 节点，绝不改变控制流或语义。';
const planJson = (plan) => JSON.stringify(plan);

test('the facade re-exports the submodules by identity, plus the coordinator class', () => {
  assert.deepEqual(Object.keys(facade), [
    'MetaPlanCoordinator',
    'constraintStrategy',
    'executorRegistry',
    'metaPlanSchema',
    'codeInterceptors',
    'constraintInjection',
    'constitutionalRedLines',
    'TrustCircuitBreaker',
  ]);
  // Identity, not a copy: two require() paths must not end up with two catalogs.
  assert.equal(facade.constraintStrategy, strategyEnum);
  assert.equal(facade.executorRegistry, registry);
  assert.equal(facade.metaPlanSchema, schema);
  assert.equal(facade.codeInterceptors, interceptors);
  assert.equal(facade.constraintInjection, injection);
  assert.equal(facade.constitutionalRedLines, redLines);
  assert.equal(facade.TrustCircuitBreaker, TrustCircuitBreaker);
  assert.equal(registry.getExecutor('js_babel_writer'), facade.executorRegistry.EXECUTORS[0]);
});

test('there is no singleton: every coordinator owns its own breaker', () => {
  assert.equal(typeof MetaPlanCoordinator, 'function');
  assert.equal('getMetaPlanCoordinator' in facade, false, 'no memoized accessor is exported');
  const a = new MetaPlanCoordinator();
  const b = new MetaPlanCoordinator();
  assert.notEqual(a, b);
  assert.notEqual(a.breaker, b.breaker);
  a.recordExecutionOutcome({ declaredStrategy: SOFT, taskType: 'js' }, { ok: false });
  a.recordExecutionOutcome({ declaredStrategy: SOFT, taskType: 'js' }, { ok: false });
  assert.equal(a.isSessionLocked(), true);
  assert.equal(b.isSessionLocked(), false, 'the lock must not be process-wide');
});

test('the breaker is injectable, and breakerOptions reach the default breaker', () => {
  const stub = { effectiveStrategy: () => ({ strategy: BLOCK, floored: true, reason: 'stub floor' }) };
  const withStub = new MetaPlanCoordinator({ breaker: stub });
  assert.equal(withStub.breaker, stub);
  const configured = new MetaPlanCoordinator({ breakerOptions: { sessionTripThreshold: 5 } });
  assert.ok(configured.breaker instanceof TrustCircuitBreaker);
  assert.equal(configured.breaker.sessionTripThreshold, 5);
  assert.equal(new MetaPlanCoordinator().breaker.sessionTripThreshold, 2);
});

test('renderMetaPlanPrompt precedes execution and embeds the live registry menu (防呆①)', () => {
  const c = new MetaPlanCoordinator();
  const prompt = c.renderMetaPlanPrompt({ description: '重构异步控制流', language: 'typescript' });
  assert.match(prompt, /必须先输出一份「元规划」JSON/);
  assert.ok(prompt.includes('重构异步控制流'));
  assert.ok(prompt.includes('目标语言：typescript'));
  // The menu is generated from the registry, so the model cannot be offered a stale list.
  assert.ok(prompt.includes(registry.describeForModel()));
  for (const id of registry.executorIds()) assert.ok(prompt.includes(`"${id}"`), `menu lacks ${id}`);
  // All three ladder levels are explained, and the anti-laziness rule is stated.
  for (const level of [SOFT, HARD, BLOCK]) assert.ok(prompt.includes(level), `ladder lacks ${level}`);
  assert.match(prompt, /risk_dissent/);
  assert.match(prompt, /自动升级为 "Code_Hard"/);
  // The answer format is spelled out as the JSON skeleton.
  assert.ok(prompt.includes('"toolchain": ["<执行器id>", ...]'));
  // No executor outside the catalog may leak into the prompt.
  assert.equal(prompt.includes('made_up_writer'), false);
});

test('renderMetaPlanPrompt degrades gracefully on an empty action', () => {
  const c = new MetaPlanCoordinator();
  assert.equal(c.renderMetaPlanPrompt(), c.renderMetaPlanPrompt({}));
  assert.ok(c.renderMetaPlanPrompt().includes('(未描述的微任务)'));
  // `task` is accepted as an alias of `description`.
  assert.ok(c.renderMetaPlanPrompt({ task: '改写文案' }).includes('改写文案'));
  // No language → no 「目标语言」 clause at all.
  assert.equal(c.renderMetaPlanPrompt({ description: 'x' }).includes('目标语言'), false);
});

test('metaPlanSchema() hands out the same schema the validator enforces', () => {
  const c = new MetaPlanCoordinator();
  assert.deepEqual(c.metaPlanSchema(), schema.buildMetaPlanSchema());
  assert.deepEqual(c.metaPlanSchema().properties.toolchain.items.enum, registry.executorIds());
  assert.notEqual(c.metaPlanSchema(), c.metaPlanSchema(), 'a fresh object per call');
});

test('ingestMetaPlan refuses to produce a ticket when the meta-plan is unusable (防呆①)', () => {
  const c = new MetaPlanCoordinator();
  for (const raw of ['', '我先想想', 'null', '[1,2]', planJson({ toolchain: [], constraint_strategy: HARD })]) {
    const out = c.ingestMetaPlan(raw);
    assert.equal(out.ok, false, `${JSON.stringify(raw)} must not yield a ticket`);
    assert.equal(out.ticket, undefined);
    assert.ok(typeof out.error === 'string' && out.error.length > 0);
  }
  assert.equal(c.ingestMetaPlan('no json').error, schema.parseMetaPlan('no json').error);
  assert.equal(
    c.ingestMetaPlan(planJson({ toolchain: ['ghost'], constraint_strategy: HARD })).error,
    registry.validateToolchain(['ghost']).reason,
  );
});

test('ingestMetaPlan returns the documented ticket shape for a clean Code_Hard plan', () => {
  const c = new MetaPlanCoordinator();
  const out = c.ingestMetaPlan(
    planJson({ toolchain: ['js_babel_writer', 'raw_string_injector'], constraint_strategy: HARD }),
    { taskType: 'JS', language: 'javascript' },
  );
  assert.equal(out.ok, true);
  const t = out.ticket;
  assert.deepEqual(Object.keys(t).sort(), [
    '_plan',
    'declaredStrategy',
    'effectiveStrategy',
    'injection',
    'language',
    'overrides',
    'redLine',
    'riskDissent',
    'taskType',
    'toolchain',
  ]);
  assert.equal(t.declaredStrategy, HARD);
  assert.equal(t.effectiveStrategy, HARD);
  assert.deepEqual(t.toolchain, ['js_babel_writer', 'raw_string_injector']);
  assert.equal(t.riskDissent, '');
  assert.deepEqual(t.overrides, []);
  assert.equal(t.redLine, null);
  assert.equal(t.language, 'javascript');
  assert.equal(t.taskType, 'js', 'task types are normalized on the ticket too');
  assert.deepEqual(t.injection, injection.resolveInjection(t._plan));
});

test('taskType falls back to a language-derived bucket so distrust is scoped sensibly', () => {
  const c = new MetaPlanCoordinator();
  const mk = (action) => c.ingestMetaPlan(planJson({ toolchain: ['js_babel_writer'], constraint_strategy: HARD }), action).ticket;
  assert.equal(mk({ language: 'Python' }).taskType, 'edit:python');
  assert.equal(mk({}).taskType, 'edit:default');
  assert.equal(mk({ taskType: '  Docs  ' }).taskType, 'docs', 'an explicit taskType wins and is normalized');
  assert.equal(mk({ taskType: 'Docs', language: 'python' }).taskType, 'docs');
  assert.equal(mk({ language: 'Python' }).language, 'Python', 'language is kept verbatim for the interceptors');
  assert.equal(mk({}).language, null);
});

test('the anti-laziness escalation shows up in ticket.overrides, not as a rejection', () => {
  const c = new MetaPlanCoordinator();
  const t = c.ingestMetaPlan(
    planJson({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT, risk_dissent: 'ok' }),
    { taskType: 'js' },
  ).ticket;
  assert.equal(t.declaredStrategy, SOFT, 'the model’s own choice stays visible on the ticket');
  assert.equal(t.effectiveStrategy, HARD);
  assert.equal(t.overrides.length, 1);
  assert.match(t.overrides[0], /拒绝偷懒/);
  assert.equal(t.injection.strategy, HARD, 'the injection plan is built from the EFFECTIVE strategy');
  assert.equal(t.injection.mountInterceptors, true);
});

test('a well-argued Soft plan over a no-AST executor keeps its fast path', () => {
  const c = new MetaPlanCoordinator();
  const t = c.ingestMetaPlan(
    planJson({ toolchain: ['raw_string_injector'], constraint_strategy: SOFT, risk_dissent: GOOD_DISSENT }),
    { taskType: 'comment' },
  ).ticket;
  assert.equal(t.effectiveStrategy, SOFT);
  assert.deepEqual(t.overrides, []);
  assert.equal(t.injection.mountInterceptors, false);
  assert.equal(t.injection.promptHint, injection.SOFT_FORMAT_HINT);
});

test('the override stack applies schema → breaker → red line, with the red line LAST', () => {
  // A stubbed breaker isolates ordering from the streak arithmetic.
  const c = new MetaPlanCoordinator({
    breaker: {
      effectiveStrategy: () => ({ strategy: HARD, floored: true, reason: 'breaker floor' }),
      recordOutcome: () => ({ stub: true }),
      isSessionLocked: () => false,
    },
  });
  const out = c.ingestMetaPlan(
    planJson({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT, risk_dissent: 'ok' }),
    { taskType: 'js', tool: 'deleteFile', path: 'package.json' },
  );
  const t = out.ticket;
  assert.deepEqual(t.overrides, [
    '选择 Prompt_Soft 但未给出充分的 risk_dissent（< 12 字），按规则自动升级为 Code_Hard（拒绝偷懒）。',
    'breaker floor',
    '宪法红线 [package_core_delete]：检测到删除/清空 package.json（宪法红线 3）。',
  ]);
  assert.equal(t.effectiveStrategy, BLOCK, 'the red line dominates the whole stack');
  assert.equal(t.redLine.rule, 'package_core_delete');
  assert.equal(t.injection.requireSnapshot, true);
  assert.equal(t.injection.requireConfirmation, true);
});

test('the red line cannot be routed around by a model that already chose System_Block', () => {
  const c = new MetaPlanCoordinator();
  const t = c.ingestMetaPlan(
    planJson({ toolchain: ['js_babel_writer'], constraint_strategy: BLOCK }),
    { taskType: 'sql', params: { sql: 'DROP DATABASE khyquant' } },
  ).ticket;
  assert.equal(t.effectiveStrategy, BLOCK);
  assert.equal(t.redLine.rule, 'db_destruction');
  assert.match(t.overrides[0], /^宪法红线 \[db_destruction\]/);
});

test('the real breaker floor reaches the ticket once a task type is distrusted', () => {
  const c = new MetaPlanCoordinator({ breakerOptions: { sessionTripThreshold: 99 } });
  c.recordExecutionOutcome({ declaredStrategy: SOFT, taskType: 'js' }, { ok: false, error: 'SyntaxError' });
  assert.deepEqual(c.breaker.distrustedTypes(), ['js']);
  const t = c.ingestMetaPlan(
    planJson({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT, risk_dissent: GOOD_DISSENT }),
    { taskType: 'js' },
  ).ticket;
  assert.equal(t.declaredStrategy, SOFT);
  assert.equal(t.effectiveStrategy, HARD, 'the breaker raised the floor');
  assert.deepEqual(t.overrides, ['任务类型「js」此前在 Prompt_Soft 下翻车，已强制 Code_Hard。']);
  // An unrelated task type is not floored — 信任扣分 is per type, not a blanket veto.
  const other = c.ingestMetaPlan(
    planJson({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT, risk_dissent: GOOD_DISSENT }),
    { taskType: 'py' },
  ).ticket;
  assert.equal(other.effectiveStrategy, SOFT);
  assert.deepEqual(other.overrides, []);
});

test('validateExecution refuses any ticket without a plan — no silent Soft default', () => {
  const c = new MetaPlanCoordinator();
  for (const junk of [undefined, null, {}, { taskType: 'js' }, 'a string', 42]) {
    const out = c.validateExecution(junk, { content: 'function (' });
    assert.equal(out.allowed, false, `${JSON.stringify(junk)} must be refused`);
    assert.equal(out.strategy, BLOCK, 'a refused execution reports the strictest level');
    assert.equal(out.ranValidation, false);
    assert.deepEqual(out.violations, [{ executor: '(none)', error: '缺少有效的元规划票据，拒绝执行（防呆①）。' }]);
    assert.equal(out.requireSnapshot, true);
    assert.equal(out.requireConfirmation, true);
    assert.deepEqual(out.results, []);
  }
});

test('validateExecution runs the mounted interceptors under Code_Hard', () => {
  const c = new MetaPlanCoordinator();
  const ticket = c.ingestMetaPlan(
    planJson({ toolchain: ['generic_syntax_writer'], constraint_strategy: HARD }),
    { taskType: 'js', language: 'cobol' },
  ).ticket;
  const bad = c.validateExecution(ticket, { content: 'fn main() {' });
  assert.equal(bad.allowed, false);
  assert.equal(bad.strategy, HARD);
  assert.equal(bad.ranValidation, true);
  assert.equal(bad.violations.length, 1);
  assert.equal(bad.violations[0].executor, 'generic_syntax_writer');
  assert.deepEqual(
    bad.results.map((r) => [r.executor, r.validator, r.ok]),
    [['generic_syntax_writer', 'balance', false]],
  );
  const good = c.validateExecution(ticket, { content: 'fn main() {}' });
  assert.equal(good.allowed, true);
  assert.deepEqual(good.violations, []);
});

test('the per-call language overrides the ticket language (step 3 stays ctx-driven)', () => {
  const c = new MetaPlanCoordinator();
  const ticket = c.ingestMetaPlan(
    planJson({ toolchain: ['generic_syntax_writer'], constraint_strategy: HARD }),
    { language: 'cobol' },
  ).ticket;
  // cand.language wins, and it is the ONLY thing that changes the validator chosen here.
  assert.equal(c.validateExecution(ticket, { content: 'fn x() {', language: 'cobol' }).violations.length, 1);
  assert.equal(c.validateExecution(ticket, { content: 'const a = 1;' }).ranValidation, true);
  const js = c.validateExecution(ticket, { content: 'const a = 1;', language: 'javascript' });
  assert.equal(js.allowed, true);
  assert.equal(js.results[0].validator, 'vm', 'the ticket said cobol, this call said javascript');
});

test('a Soft ticket fast-passes step 3 even on syntactically doomed content', () => {
  const c = new MetaPlanCoordinator();
  const ticket = c.ingestMetaPlan(
    planJson({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT, risk_dissent: GOOD_DISSENT }),
    { taskType: 'comment', language: 'javascript' },
  ).ticket;
  const out = c.validateExecution(ticket, { content: 'function ( {{{' });
  assert.equal(out.allowed, true);
  assert.equal(out.ranValidation, false);
  assert.deepEqual(out.results, []);
  assert.equal(out.strategy, SOFT);
});

test('a System_Block ticket reports its gates through step 3 and still gates on content', () => {
  const c = new MetaPlanCoordinator();
  const ticket = c.ingestMetaPlan(
    planJson({ toolchain: ['generic_syntax_writer'], constraint_strategy: BLOCK }),
    { language: 'cobol' },
  ).ticket;
  const out = c.validateExecution(ticket, { content: 'ok {' });
  assert.equal(out.requireSnapshot, true);
  assert.equal(out.requireConfirmation, true);
  assert.equal(out.allowed, false, 'a snapshot does not excuse broken syntax');
});

test('recordExecutionOutcome delegates the ticket fields to the breaker (闭环自愈)', () => {
  const seen = [];
  const c = new MetaPlanCoordinator({
    breaker: {
      recordOutcome: (o) => {
        seen.push(o);
        return { recorded: true };
      },
      effectiveStrategy: (s) => ({ strategy: s, floored: false, reason: null }),
      isSessionLocked: () => false,
    },
  });
  const ticket = c.ingestMetaPlan(
    planJson({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT, risk_dissent: GOOD_DISSENT }),
    { taskType: 'JS' },
  ).ticket;
  const snap = c.recordExecutionOutcome(ticket, { ok: false, error: 'SyntaxError: boom' });
  assert.deepEqual(snap, { recorded: true }, 'the breaker snapshot is returned verbatim');
  assert.deepEqual(seen, [
    {
      ok: false,
      declaredStrategy: SOFT,
      effectiveStrategy: SOFT,
      taskType: 'js',
      error: 'SyntaxError: boom',
    },
  ]);
  // `ok` is normalized to a boolean even when the caller omits the outcome entirely.
  c.recordExecutionOutcome(ticket);
  assert.equal(seen[1].ok, false);
  // And a missing ticket still reaches the breaker with undefined fields.
  c.recordExecutionOutcome();
  assert.equal(seen[2].declaredStrategy, undefined);
});

test('isSessionLocked mirrors the breaker and never unlocks', () => {
  const c = new MetaPlanCoordinator({ breakerOptions: { sessionTripThreshold: 1 } });
  assert.equal(c.isSessionLocked(), false);
  c.recordExecutionOutcome({ declaredStrategy: SOFT, taskType: 'js' }, { ok: false });
  assert.equal(c.isSessionLocked(), true);
  c.recordExecutionOutcome({ declaredStrategy: SOFT, taskType: 'js' }, { ok: true });
  assert.equal(c.isSessionLocked(), true, 'escalation is monotone across the whole facade');
});

test('the documented four-step loop closes end to end on one realistic session', () => {
  const c = new MetaPlanCoordinator({ breakerOptions: { sessionTripThreshold: 2 } });
  // 1. ask for the plan
  const prompt = c.renderMetaPlanPrompt({ description: 'fix the async control flow', language: 'javascript' });
  assert.match(prompt, /元规划/);
  // 2. the model answers honestly → Code_Hard, interceptors mounted
  const honest = c.ingestMetaPlan(
    planJson({ toolchain: ['js_babel_writer'], constraint_strategy: HARD }),
    { taskType: 'js', language: 'javascript' },
  );
  assert.equal(honest.ok, true);
  // 3. a broken edit is rejected before it touches disk
  assert.equal(c.validateExecution(honest.ticket, { content: 'function (' }).allowed, false);
  // 2b. the model then cuts corners → Soft is auto-raised, so it gains nothing
  const lazy = c.ingestMetaPlan(
    planJson({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT, risk_dissent: 'fine' }),
    { taskType: 'js', language: 'javascript' },
  );
  assert.equal(lazy.ticket.effectiveStrategy, HARD);
  // 4. two Soft misjudgments later the whole session is forced to Hard
  const c2 = new MetaPlanCoordinator();
  for (let i = 0; i < 2; i += 1) {
    const t = c2.ingestMetaPlan(
      planJson({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT, risk_dissent: GOOD_DISSENT }),
      { taskType: 'js', language: 'javascript' },
    ).ticket;
    c2.recordExecutionOutcome(t, { ok: false, error: 'SyntaxError' });
  }
  assert.equal(c2.isSessionLocked(), true);
  const after = c2.ingestMetaPlan(
    planJson({ toolchain: ['js_babel_writer'], constraint_strategy: SOFT, risk_dissent: GOOD_DISSENT }),
    { taskType: 'unrelated', language: 'javascript' },
  ).ticket;
  assert.equal(after.effectiveStrategy, HARD, 'the session lock covers task types that never failed');
});
