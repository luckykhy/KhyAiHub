'use strict';

// Unit-level contract tests for budgetExecutor.js (co-located, per [RESEARCH-018] §2.3).
// This is the protocol heart: the budget-gate ladders (floor / insufficient), the
// "never re-fire the same bullet" degradation walk, the single repair-gated retry, and
// the fail-safe convergence to a salvage JSON. Everything runs against scripted in-memory
// runners — no timers, no IO, bounded and fast (RUNTIME-003 posture).

const test = require('node:test');
const assert = require('node:assert/strict');

const { BudgetAwareExecutor, makeStepBudget, makeTokenBudget, DEFAULT_FLOOR_PCT } =
  require('./budgetExecutor');
const { FallbackTreeBuilder } = require('./fallbackTree');
const { DeadLoopDetector } = require('./deadLoopDetector');

const FLOOR_ENV = 'KHY_RESILIENCE_BUDGET_FLOOR_PCT';
// Hermetic baseline: the floor default must not depend on the developer's ambient env.
// node --test gives each file its own child process, so deleting here is safe and total.
delete process.env[FLOOR_ENV];

function tree3() {
  return FallbackTreeBuilder.from('t3', [
    { plan: 'A', tool: 'TA', params: { n: 1 } },
    { plan: 'B', tool: 'TB', params: { n: 2 } },
    { plan: 'C', tool: 'TC', params: { n: 3 } },
  ]);
}

function scriptedRunner(responses) {
  const calls = [];
  const runner = async (tool, params, meta) => {
    calls.push({ tool, params, meta });
    const next = responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  runner.calls = calls;
  return runner;
}

const OK = (v = 1) => ({ success: true, value: v });
const BAD = (msg) => ({ success: false, error: msg });

test('face: DEFAULT_FLOOR_PCT is 10; adapters are the same objects as budgetAdapters', () => {
  assert.equal(DEFAULT_FLOOR_PCT, 10);
  const adapters = require('./budgetAdapters');
  assert.equal(makeStepBudget, adapters.makeStepBudget, 're-bound, not re-implemented');
  assert.equal(makeTokenBudget, adapters.makeTokenBudget);
});

test('happy path: first plan succeeds, nothing else fires', async () => {
  const runner = scriptedRunner([OK(42)]);
  const out = await new BudgetAwareExecutor({ runner }).run(tree3(), { url: 'u' });
  assert.deepEqual(out, {
    ok: true, intent: 't3', plan: 'A', result: { success: true, value: 42 },
    attempted: [{ plan: 'A', reason: 'ok', retry: 0 }],
  });
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0].meta, { plan: 'A', intent: 't3', retry: 0 });
  assert.deepEqual(runner.calls[0].params, { n: 1 }, 'buildParams got the merged intent context');
  assert.equal(runner.calls[0].params.n, 1);
});

test('degrade ladder A fails → B succeeds: exactly one injection, never a retry of A', async () => {
  const runner = scriptedRunner([BAD('boom'), OK(7)]);
  const texts = [];
  const out = await new BudgetAwareExecutor({
    runner, onDegrade: (t) => texts.push(t),
  }).run(tree3());
  assert.equal(out.ok, true);
  assert.equal(out.plan, 'B');
  assert.deepEqual(out.attempted, [
    { plan: 'A', reason: 'execution-error', retry: 0 },
    { plan: 'B', reason: 'ok', retry: 0 },
  ]);
  assert.deepEqual(runner.calls.map((c) => c.tool), ['TA', 'TB']);
  assert.equal(texts.length, 1, 'degrade context injected exactly once');
  assert.match(texts[0], /Plan A 因 \[execution-error\] 失败/);
  assert.match(texts[0], /规划 Plan B（工具：TB）/);
  assert.match(texts[0], /禁止道歉/);
});

test('full ladder exhausted: three distinct shots, tree-exhausted circuit, one pass only', async () => {
  const runner = scriptedRunner([BAD('x1'), BAD('x2'), BAD('x3')]);
  const out = await new BudgetAwareExecutor({ runner }).run(tree3());
  assert.equal(out.ok, false);
  assert.equal(out.circuit, 'tree-exhausted');
  assert.equal(out.attempted.length, 3);
  assert.equal(runner.calls.length, 3, 'no second lap over the tree — 绝不开启第二遍循环');
  assert.deepEqual(runner.calls.map((c) => c.tool), ['TA', 'TB', 'TC']);
  assert.equal(out.salvage.status, 'failed_with_salvage');
  assert.deepEqual(out.salvage.attempted_paths.map((p) => p.plan), ['A', 'B', 'C']);
});

test('gate ①: pct below floor short-circuits BEFORE the first shot (budget-floor)', async () => {
  const runner = scriptedRunner([]);
  const out = await new BudgetAwareExecutor({
    runner, budget: makeTokenBudget({ total: 100, spent: () => 95 }),
  }).run(tree3());
  assert.equal(out.circuit, 'budget-floor');
  assert.equal(out.ok, false);
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(out.attempted, [
    { plan: 'A', reason: 'skipped:budget-floor(5%<10%)', retry: 0 },
  ]);
});

test('gate ②: units cannot cover the remaining plans (budget-insufficient)', async () => {
  const runner = scriptedRunner([]);
  const out = await new BudgetAwareExecutor({
    runner, budget: makeStepBudget(2), // 100% pct but only 2 units for 3 plans
  }).run(tree3());
  assert.equal(out.circuit, 'budget-insufficient');
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(out.attempted, [
    { plan: 'A', reason: 'skipped:budget-insufficient(2<3)', retry: 0 },
  ]);
});

test('exact budget = tree size walks the whole ladder (gate ② is strict <)', async () => {
  const runner = scriptedRunner([BAD('1'), BAD('2'), BAD('3')]);
  const out = await new BudgetAwareExecutor({ runner, budget: makeStepBudget(3) }).run(tree3());
  assert.equal(out.circuit, 'tree-exhausted');
  assert.equal(runner.calls.length, 3);
});

test('mid-ladder floor cut: 40% floor stops the walk at plan C after two spends', async () => {
  const runner = scriptedRunner([BAD('slow'), BAD('slower')]);
  const out = await new BudgetAwareExecutor({
    runner, budget: makeStepBudget(3), floorPct: 40,
  }).run(tree3());
  assert.equal(out.circuit, 'budget-floor');
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(out.attempted[2], {
    plan: 'C', reason: 'skipped:budget-floor(33%<40%)', retry: 0,
  });
  assert.equal(out.salvage.attempted_paths.length, 3);
});

test('floorPct resolution ladder: explicit → env → default 10 (bounds 0..100)', () => {
  try {
    assert.equal(new BudgetAwareExecutor({}).floorPct, 10);
    assert.equal(new BudgetAwareExecutor({ floorPct: 55 }).floorPct, 55);
    assert.equal(new BudgetAwareExecutor({ floorPct: 0 }).floorPct, 0,
      'explicit 0 is honored — a caller demanding no floor gets none');
    assert.equal(new BudgetAwareExecutor({ floorPct: 150 }).floorPct, 10, 'out of range → next rung');
    assert.equal(new BudgetAwareExecutor({ floorPct: 'abc' }).floorPct, 10);
    process.env[FLOOR_ENV] = '30';
    assert.equal(new BudgetAwareExecutor({}).floorPct, 30);
    assert.equal(new BudgetAwareExecutor({ floorPct: 55 }).floorPct, 55, 'explicit beats env');
    process.env[FLOOR_ENV] = 'abc';
    assert.equal(new BudgetAwareExecutor({}).floorPct, 10);
    process.env[FLOOR_ENV] = '500';
    assert.equal(new BudgetAwareExecutor({}).floorPct, 10, 'env out of range → default');
  } finally {
    delete process.env[FLOOR_ENV];
  }
});

test('repair-gated retry: changed params → one re-shot, reason ok-after-repair', async () => {
  const runner = scriptedRunner([BAD('puppeteer is not installed'), OK(9)]);
  let repairArgs = null;
  const out = await new BudgetAwareExecutor({ runner }).run(
    FallbackTreeBuilder.from('rep', [{ plan: 'A', tool: 'TA', params: { url: 'bad' } }]),
    {
      repair: async (args) => {
        repairArgs = args;
        return { changed: true, params: { url: 'fixed' } };
      },
    },
  );
  assert.equal(out.ok, true);
  assert.equal(out.attempted[0].plan, 'A');
  assert.equal(out.attempted[0].reason, 'ok-after-repair');
  assert.equal(out.attempted[0].retry, 1);
  assert.equal(runner.calls.length, 2);
  assert.equal(runner.calls[1].meta.retry, 1);
  assert.deepEqual(runner.calls[1].params, { url: 'fixed' });
  assert.equal(repairArgs.failure.reason, 'missing-dependency');
  assert.deepEqual(repairArgs.params, { url: 'bad' });
  assert.equal(repairArgs.node.plan, 'A');
});

test('repair that does not change the call buys no retry (同类错误严禁死缠)', async () => {
  const cases = [
    ['changed:false', () => ({ changed: false, params: { url: 'other' } })],
    ['changed:true but identical params', () => ({ changed: true, params: { url: 'x' } })],
    ['changed:true but no params object', () => ({ changed: true, params: null })],
    ['repair throws', () => { throw new Error('repair blew up'); }],
  ];
  for (const [label, repair] of cases) {
    const runner = scriptedRunner([BAD('boom')]);
    const out = await new BudgetAwareExecutor({ runner }).run(
      FallbackTreeBuilder.from('r', [{ plan: 'A', tool: 'TA', params: { url: 'x' } }]),
      { repair },
    );
    assert.equal(runner.calls.length, 1, `${label}: must NOT re-fire`);
    assert.equal(out.attempted[0].retry, 0, label);
    assert.equal(out.circuit, 'tree-exhausted', label);
  }
});

test('repair-gated retry that fails again: keeps the SECOND failure, retry stays 1', async () => {
  const runner = scriptedRunner([BAD('boom first'), BAD('request timed out')]);
  const out = await new BudgetAwareExecutor({ runner }).run(
    FallbackTreeBuilder.from('r', [{ plan: 'A', tool: 'TA', params: { u: 1 } }]),
    { repair: async () => ({ changed: true, params: { u: 2 } }) },
  );
  assert.equal(out.ok, false);
  assert.deepEqual(out.attempted, [{ plan: 'A', reason: 'timeout', retry: 1 }]);
  assert.equal(runner.calls.length, 2);
});

test('repaired call already seen this session → probe rejects the retry (no re-send)', async () => {
  const d = new DeadLoopDetector();
  d.inspect('TA', { u: 2 }); // seed: this exact bullet was fired earlier in the session
  const runner = scriptedRunner([BAD('boom')]);
  const out = await new BudgetAwareExecutor({
    runner, detector: d,
  }).run(
    FallbackTreeBuilder.from('r', [{ plan: 'A', tool: 'TA', params: { u: 1 } }]),
    { repair: async () => ({ changed: true, params: { u: 2 } }) },
  );
  assert.equal(runner.calls.length, 1, 'changed() passed but inspect() of the new combo was dead');
  assert.equal(out.attempted[0].retry, 0);
});

test('detector-owned skip: second plan with the identical call never reaches the runner', async () => {
  const runner = scriptedRunner([BAD('boom')]);
  const out = await new BudgetAwareExecutor({ runner }).run(
    FallbackTreeBuilder.from('dup', [
      { plan: 'A', tool: 'T', params: { x: 1 } },
      { plan: 'B', tool: 'T', params: { x: 1 } },
    ]),
  );
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(out.attempted[1], { plan: 'B', reason: 'dead-loop-skip', retry: 0 });
  assert.equal(out.circuit, 'tree-exhausted');
});

test('runner throw is classified, never propagated: timed out → reason timeout', async () => {
  const runner = scriptedRunner([new Error('connect timed out after 30s')]);
  const out = await new BudgetAwareExecutor({ runner }).run(tree3(), {});
  assert.equal(out.ok, false);
  assert.equal(out.attempted[0].reason, 'timeout');
});

test('runner returning null/undefined becomes the empty-result execution-error', async () => {
  const runner = scriptedRunner([undefined, null, undefined]);
  const out = await new BudgetAwareExecutor({ runner }).run(tree3());
  assert.deepEqual(out.attempted.map((a) => a.reason),
    ['execution-error', 'execution-error', 'execution-error']);
});

test('custom isSuccess judges the result; a throwing isSuccess counts as failure', async () => {
  const okTree = FallbackTreeBuilder.from('k', [
    { plan: 'A', tool: 'TA', params: { p: 1 }, isSuccess: (r) => r.code === 0 },
  ]);
  const r1 = scriptedRunner([{ code: 0 }]);
  const out1 = await new BudgetAwareExecutor({ runner: r1 }).run(okTree);
  assert.equal(out1.ok, true, 'no success flag, but the node-level judge says ok');

  const badTree = FallbackTreeBuilder.from('k2', [
    { plan: 'A', tool: 'TA', params: { p: 1 }, isSuccess: () => { throw new Error('judge died'); } },
  ]);
  const out2 = await new BudgetAwareExecutor({ runner: scriptedRunner([{ code: 0 }]) }).run(badTree);
  assert.equal(out2.ok, false);
  assert.equal(out2.circuit, 'tree-exhausted');
});

test('buildParams throwing degrades to empty params — the shot still fires', async () => {
  const runner = scriptedRunner([OK()]);
  const tree = FallbackTreeBuilder.from('bp', [
    { plan: 'A', tool: 'TA', buildParams: () => { throw new Error('ctx missing'); } },
  ]);
  const out = await new BudgetAwareExecutor({ runner }).run(tree);
  assert.equal(out.ok, true);
  assert.deepEqual(runner.calls[0].params, {});
});

test('salvage extraction: fragments from failed plans are pooled, best one wins', async () => {
  const runner = scriptedRunner([
    { success: false, error: 'e1', partial: 'ab' },
    { success: false, error: 'e2', partial: 'a much longer fragment' },
    { success: false, error: 'e3' },
  ]);
  const tree = FallbackTreeBuilder.from('sv', [
    { plan: 'A', tool: 'TA', params: { k: 1 }, extractSalvage: (r) => r.partial },
    { plan: 'B', tool: 'TB', params: { k: 2 }, extractSalvage: (r) => r.partial },
    { plan: 'C', tool: 'TC', params: { k: 3 }, extractSalvage: () => { throw new Error('extractor died'); } },
  ]);
  const out = await new BudgetAwareExecutor({ runner }).run(tree);
  assert.equal(out.salvage.salvage_data, 'a much longer fragment');
});

test('no runner injected: run() converges to executor-error salvage, never throws', async () => {
  const out = await new BudgetAwareExecutor({}).run(tree3());
  assert.equal(out.ok, false);
  assert.equal(out.circuit, 'executor-error');
  assert.deepEqual(out.attempted, [{ plan: '(none)', reason: 'aborted:executor-error', retry: 0 }]);
  assert.match(out.salvage.next_action_suggestion, /执行器自身遇到异常/);
});

test('invalid trees are executor-error, not caller exceptions', async () => {
  for (const tree of [null, undefined, {}, { plans: [] }, { plans: 'not-array' }]) {
    const out = await new BudgetAwareExecutor({ runner: scriptedRunner([]) }).run(tree);
    assert.equal(out.ok, false);
    assert.equal(out.circuit, 'executor-error', JSON.stringify(tree));
  }
});

test('hand-built 5-plan tree is sliced to MAX_FALLBACK_DEPTH=3 (double insurance)', async () => {
  const nodes = [1, 2, 3, 4, 5].map((n) => ({
    plan: `P${n}`, tool: `T${n}`, buildParams: () => ({ n }), maxRetry: 1,
    isSuccess: null, extractSalvage: null, suggestion: '',
  }));
  const runner = scriptedRunner([BAD('a'), BAD('b'), BAD('c')]);
  const out = await new BudgetAwareExecutor({ runner }).run({ intent: 'wide', plans: nodes });
  assert.equal(runner.calls.length, 3, 'plans 4 and 5 are unreachable');
  assert.deepEqual(runner.calls.map((c) => c.tool), ['T1', 'T2', 'T3']);
  assert.equal(out.attempted.length, 3);
  assert.equal(out.circuit, 'tree-exhausted');
});

test('degrade injection: once per failing non-terminal plan; throw inside is swallowed', async () => {
  const texts = [];
  const runner = scriptedRunner([BAD('1'), BAD('2')]);
  const out = await new BudgetAwareExecutor({
    runner,
    onDegrade: (t) => {
      texts.push(t);
      if (texts.length === 1) throw new Error('injection channel down');
    },
  }).run(FallbackTreeBuilder.from('inj', [
    { plan: 'A', tool: 'TA', params: { z: 1 } },
    { plan: 'B', tool: 'TB', params: { z: 2 } },
    { plan: 'C', tool: 'TC', params: { z: 3 } },
  ]));
  assert.equal(out.circuit, 'tree-exhausted', 'a throwing onDegrade must not derail the walk');
  assert.equal(texts.length, 2, 'A→B and B→C; the last failure (C) has no next plan');
});

test('buildDegradeContext reports budget pct, next plan, and tool roster', () => {
  const budget = makeStepBudget(3);
  budget.spendOne(); // 67% left
  const ex = new BudgetAwareExecutor({
    runner: async () => OK(), budget, availableTools: ['X', 'Y'],
  });
  const tree = tree3();
  const text = ex.buildDegradeContext(tree, tree.plans[0], tree.plans[1], { reason: 'timeout' });
  assert.match(text, /Plan A 因 \[timeout\] 失败/);
  assert.match(text, /剩余预算：67%。/);
  assert.match(text, /规划 Plan B（工具：TB）/);
  assert.match(text, /你的剩余工具：\[X, Y\]。/);
  // Without an explicit roster, the remaining plans' tools are the fallback roster.
  const ex2 = new BudgetAwareExecutor({ runner: async () => OK(), budget: makeStepBudget(3) });
  assert.match(ex2.buildDegradeContext(tree, tree.plans[0], tree.plans[1], null),
    /你的剩余工具：\[TA, TB, TC\]。/);
  assert.match(ex2.buildDegradeContext(tree, tree.plans[0], tree.plans[1], null),
    /因 \[未知原因\] 失败/, 'null failure still yields a concrete-looking line, never "undefined"');
});
