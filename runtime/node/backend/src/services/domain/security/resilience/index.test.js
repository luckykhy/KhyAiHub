'use strict';

// Facade contract tests for resilience/index.js (ResilienceCoordinator + makeToolRunner).
// Every runner is a scripted in-memory function — no network, no DB, no timers.
// All tree walks are ≤ 3 plans deep, so each case is bounded by construction.

const test = require('node:test');
const assert = require('node:assert/strict');

const facade = require('./index');
const budgetExecutor = require('./budgetExecutor');
const budgetAdapters = require('./budgetAdapters');
const deadLoopDetector = require('./deadLoopDetector');
const errorSignature = require('./errorSignature');
const fallbackTree = require('./fallbackTree');
const intentTrees = require('./intentTrees');
const { SalvageProtector } = require('./salvage');

const FLOOR_ENV = 'KHY_RESILIENCE_BUDGET_FLOOR_PCT';
// Hermetic: the default floor must not depend on the developer's ambient env.
delete process.env[FLOOR_ENV];

const BAD = { success: false, error: 'boom' };

function scriptedRunner(responses = []) {
  const calls = [];
  const runner = async (tool, params, meta) => {
    calls.push({ tool, params, meta });
    return responses.length > 0 ? responses.shift() : BAD;
  };
  runner.calls = calls;
  return runner;
}

test('face: exports exactly the sixteen documented names', () => {
  assert.deepEqual(Object.keys(facade).slice().sort(), [
    'BudgetAwareExecutor', 'DEFAULT_FLOOR_PCT', 'DeadLoopDetector', 'FallbackTreeBuilder',
    'FallbackTreeError', 'MAX_FALLBACK_DEPTH', 'MAX_RETRY_PER_PLAN', 'ResilienceCoordinator',
    'SalvageProtector', 'buildWebContentTree', 'callSignature', 'classifyFailure',
    'getIntentTree', 'makeStepBudget', 'makeTokenBudget', 'makeToolRunner',
  ].sort());
});

test('face: every re-export is the SAME binding as its home module (re-bound, not re-implemented)', () => {
  const aliases = [
    ['makeStepBudget', facade.makeStepBudget, budgetAdapters.makeStepBudget],
    ['makeStepBudget via budgetExecutor', facade.makeStepBudget, budgetExecutor.makeStepBudget],
    ['makeTokenBudget', facade.makeTokenBudget, budgetAdapters.makeTokenBudget],
    ['BudgetAwareExecutor', facade.BudgetAwareExecutor, budgetExecutor.BudgetAwareExecutor],
    ['FallbackTreeBuilder', facade.FallbackTreeBuilder, fallbackTree.FallbackTreeBuilder],
    ['FallbackTreeError', facade.FallbackTreeError, fallbackTree.FallbackTreeError],
    ['DeadLoopDetector', facade.DeadLoopDetector, deadLoopDetector.DeadLoopDetector],
    ['SalvageProtector', facade.SalvageProtector, SalvageProtector],
    ['classifyFailure', facade.classifyFailure, errorSignature.classifyFailure],
    ['callSignature', facade.callSignature, errorSignature.callSignature],
    ['getIntentTree', facade.getIntentTree, intentTrees.getIntentTree],
    ['buildWebContentTree', facade.buildWebContentTree, intentTrees.buildWebContentTree],
  ];
  const failures = [];
  for (const [label, a, b] of aliases) {
    if (a !== b) {
      failures.push(label);
    }
  }
  assert.deepEqual(failures, []);
  assert.equal(facade.MAX_FALLBACK_DEPTH, 3);
  assert.equal(facade.MAX_RETRY_PER_PLAN, 1);
  assert.equal(facade.DEFAULT_FLOOR_PCT, 10);
});

test('face: coordinator instances are per-call DI, not a singleton', () => {
  const a = new facade.ResilienceCoordinator({ runner: async () => BAD });
  const b = new facade.ResilienceCoordinator({ runner: async () => BAD });
  assert.notEqual(a, b);
  assert.notEqual(a.opts, b.opts);
});

test('makeToolRunner: refuses non-function executeTool for every input shape', () => {
  const failures = [];
  for (const bad of [undefined, null, 0, 'x', {}, [1]]) {
    try {
      facade.makeToolRunner(bad);
      failures.push(`${String(bad)}: did not throw`);
    } catch (e) {
      if (!/executeTool/.test(e.message)) {
        failures.push(`${String(bad)}: wrong message "${e.message}"`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('makeToolRunner: adapts (tool, params, planMeta) to executeTool(tool, params, trace)', async () => {
  const seen = [];
  const executeTool = async (t, p, trace) => {
    seen.push({ t, p, trace });
    return { ok: 1 };
  };
  const run = facade.makeToolRunner(executeTool, { session: 's7' });
  const params = { a: 1 };
  const out = await run('T', params, { plan: 'P1', retry: 1 });
  assert.deepEqual(out, { ok: 1 }, 'executeTool result passed through untouched');
  assert.equal(seen[0].t, 'T');
  assert.equal(seen[0].p, params, 'params forwarded by reference, not copied');
  assert.deepEqual(seen[0].trace, { session: 's7', resiliencePlan: 'P1', resilienceRetry: 1 });
  // No planMeta → the trace keys still exist with undefined values (stable shape).
  await run('T2', {}, undefined);
  assert.deepEqual(seen[1].trace,
    { session: 's7', resiliencePlan: undefined, resilienceRetry: undefined });
  // baseTrace defaults to {} and is never mutated by the spread.
  const base = { k: 'v' };
  const run2 = facade.makeToolRunner(async () => ({}), base);
  await run2('T', {}, { plan: 'z', retry: 2 });
  assert.deepEqual(base, { k: 'v' }, 'baseTrace object untouched');
});

test('coordinator.run(intent): resolves the built-in tree and stops at the first success', async () => {
  const runner = scriptedRunner([{ success: true, value: 42 }]);
  const coord = new facade.ResilienceCoordinator({ runner });
  const out = await coord.run('fetch-web-content', { url: 'u', query: 'q' });
  assert.deepEqual(out, {
    ok: true,
    intent: 'fetch-web-content',
    plan: 'WebBrowser',
    result: { success: true, value: 42 },
    attempted: [{ plan: 'WebBrowser', reason: 'ok', retry: 0 }],
  });
  assert.equal(runner.calls.length, 1, 'never fires a plan after success');
  assert.deepEqual(runner.calls[0].params, { url: 'u', action: 'read', query: 'q' });
  assert.deepEqual(runner.calls[0].meta,
    { plan: 'WebBrowser', intent: 'fetch-web-content', retry: 0 });
});

test('coordinator.run(tree): a hand-built tree bypasses the intent registry', async () => {
  const tree = facade.FallbackTreeBuilder.from('custom', [
    { plan: 'Only', tool: 'TO', params: {} },
  ]);
  const runner = scriptedRunner([{ success: true, v: 5 }]);
  const out = await new facade.ResilienceCoordinator({ runner }).run(tree, {});
  assert.deepEqual(out, {
    ok: true,
    intent: 'custom',
    plan: 'Only',
    result: { success: true, v: 5 },
    attempted: [{ plan: 'Only', reason: 'ok', retry: 0 }],
  });
});

test('coordinator.run: unknown intent still 交差 — structured unknown-intent salvage', async () => {
  const coord = new facade.ResilienceCoordinator({ runner: scriptedRunner() });
  const out = await coord.run('nope-intent', {});
  assert.deepEqual(out, {
    ok: false,
    intent: 'nope-intent',
    circuit: 'unknown-intent',
    salvage: {
      status: 'failed_with_salvage',
      intent: 'nope-intent',
      attempted_paths: [{ plan: '(none)', reason: 'aborted:unknown-intent', retry: 0 }],
      salvage_data: '',
      next_action_suggestion:
        '已穷尽 1 条降级路径（最后失败于 (none)：unknown-intent）。' +
        '请人工核查上述尝试记录，提供更多上下文或更换策略后重试。',
    },
  });
});

test('coordinator.run: non-string non-tree inputs converge to unknown-intent with String(intent)', async () => {
  const coord = new facade.ResilienceCoordinator({ runner: scriptedRunner() });
  const cases = [
    [null, 'null'],
    [undefined, 'undefined'],
    [123, '123'],
    [{ plans: 'not-array' }, '[object Object]'],
  ];
  const failures = [];
  for (const [input, intentStr] of cases) {
    const out = await coord.run(input, {});
    if (out.circuit !== 'unknown-intent') {
      failures.push(`${intentStr}: circuit=${out.circuit}`);
    }
    if (out.intent !== intentStr) {
      failures.push(`${intentStr}: intent=${out.intent}`);
    }
    if (out.salvage.attempted_paths[0].reason !== 'aborted:unknown-intent') {
      failures.push(`${intentStr}: reason=${out.salvage.attempted_paths[0].reason}`);
    }
  }
  assert.deepEqual(failures, []);
  // Guard boundary: {plans: []} passes the facade's Array.isArray check and lands on
  // the executor's invalid-tree fail-safe instead (executor-error, not unknown-intent).
  const out = await coord.run({ plans: [] }, {});
  assert.equal(out.circuit, 'executor-error');
});

test('coordinator: default budget is one step per plan — full ladder runs once, then tree-exhausted', async () => {
  const runner = scriptedRunner([BAD, BAD, BAD]);
  const coord = new facade.ResilienceCoordinator({ runner });
  const out = await coord.run('fetch-web-content', { url: 'u', query: 'q' });
  assert.equal(out.ok, false);
  assert.equal(out.circuit, 'tree-exhausted');
  assert.deepEqual(runner.calls.map((c) => c.tool), ['WebBrowser', 'WebFetch', 'WebSearch']);
  assert.deepEqual(out.attempted, [
    { plan: 'WebBrowser', reason: 'execution-error', retry: 0 },
    { plan: 'WebFetch', reason: 'execution-error', retry: 0 },
    { plan: 'WebSearch', reason: 'execution-error', retry: 0 },
  ]);
  assert.equal(out.salvage.status, 'failed_with_salvage');
});

test('coordinator: opts.budget is forwarded to the executor (floor gate before the first shot)', async () => {
  const runner = scriptedRunner([]);
  const coord = new facade.ResilienceCoordinator({
    runner,
    budget: facade.makeTokenBudget({ total: 100, spent: () => 95 }),
  });
  const out = await coord.run('fetch-web-content', { url: 'u' });
  assert.equal(out.circuit, 'budget-floor');
  assert.equal(runner.calls.length, 0, 'gate ① fires BEFORE any tool is fired');
  assert.deepEqual(out.attempted, [
    { plan: 'WebBrowser', reason: 'skipped:budget-floor(5%<10%)', retry: 0 },
  ]);
});

test('coordinator: opts.floorPct forwarded — 40% floor cuts the walk at plan three', async () => {
  const runner = scriptedRunner([BAD, BAD]);
  const coord = new facade.ResilienceCoordinator({
    runner,
    budget: facade.makeStepBudget(3),
    floorPct: 40,
  });
  const out = await coord.run('fetch-web-content', { url: 'u', query: 'q' });
  assert.equal(out.circuit, 'budget-floor');
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(out.attempted[2], {
    plan: 'WebSearch', reason: 'skipped:budget-floor(33%<40%)', retry: 0,
  });
});

test('coordinator without runner: fail-safe executor-error, never throws', async () => {
  const out = await new facade.ResilienceCoordinator({}).run('fetch-web-content', {});
  assert.equal(out.ok, false);
  assert.equal(out.circuit, 'executor-error');
  assert.deepEqual(out.attempted, [
    { plan: '(none)', reason: 'aborted:executor-error', retry: 0 },
  ]);
  assert.match(out.salvage.next_action_suggestion, /执行器自身遇到异常/);
});

test('coordinator: opts.detector is consulted — seeded identical shot skips plan 1', async () => {
  const detector = new facade.DeadLoopDetector();
  detector.inspect('WebBrowser', { url: 'u', action: 'read', query: 'q' });
  const runner = scriptedRunner([BAD, BAD]);
  const coord = new facade.ResilienceCoordinator({ runner, detector });
  const out = await coord.run('fetch-web-content', { url: 'u', query: 'q' });
  assert.deepEqual(out.attempted[0],
    { plan: 'WebBrowser', reason: 'dead-loop-skip', retry: 0 });
  assert.deepEqual(runner.calls.map((c) => c.tool), ['WebFetch', 'WebSearch'],
    'the dead shot never reaches the runner');
});

test('coordinator: without injection each run() gets a fresh detector (no cross-run skip)', async () => {
  const tree = facade.FallbackTreeBuilder.from('dup', [
    { plan: 'A', tool: 'T', params: { x: 1 } },
    { plan: 'B', tool: 'T', params: { x: 1 } },
  ]);
  const runner = scriptedRunner();
  const coord = new facade.ResilienceCoordinator({ runner });
  const expected = [
    { plan: 'A', reason: 'execution-error', retry: 0 },
    { plan: 'B', reason: 'dead-loop-skip', retry: 0 },
  ];
  const out1 = await coord.run(tree);
  assert.deepEqual(out1.attempted, expected);
  const out2 = await coord.run(tree);
  assert.deepEqual(out2.attempted, expected,
    'plan A re-fires in run 2 — detector state did not leak across runs');
  assert.equal(runner.calls.length, 2, 'one real shot per run (B always skipped)');
});

test('coordinator: onDegrade + availableTools forwarded into the degrade-context injection', async () => {
  const texts = [];
  const runner = scriptedRunner([BAD, BAD, { success: true }]);
  const coord = new facade.ResilienceCoordinator({
    runner,
    onDegrade: (t) => texts.push(t),
    availableTools: ['X', 'Y'],
  });
  const out = await coord.run('fetch-web-content', { url: 'u', query: 'q' });
  assert.equal(out.ok, true);
  assert.equal(out.plan, 'WebSearch');
  assert.equal(texts.length, 2, 'one injection per failing non-terminal plan');
  assert.match(texts[0], /Plan WebBrowser 因 \[execution-error\] 失败/);
  assert.match(texts[0], /规划 Plan WebFetch（工具：WebFetch）/);
  assert.match(texts[0], /你的剩余工具：\[X, Y\]。/);
});

// FIXED alongside intentTrees.getIntentTree (repro-after:
// .khy/feedback/b23-resilience-2/repro-after.txt): tree resolution used to throw on
// inherited Object.prototype keys BEFORE any fail-safe wrapped it, breaking the
// facade's never-rejects promise. Resolution is own-key only now, so the contract
// holds and is asserted without a skip.
test('facade CONTRACT: run() with an inherited key returns salvage, never rejects', async () => {
  for (const key of ['valueOf', 'hasOwnProperty', 'toString', 'constructor']) {
    const out = await new facade.ResilienceCoordinator({ runner: async () => BAD }).run(key, {});
    assert.equal(out.circuit, 'unknown-intent', key);
  }
});

test('integration: makeToolRunner + coordinator — resiliencePlan/retry reach the executeTool trace', async () => {
  const seen = [];
  const executeTool = async (t, p, trace) => {
    seen.push([t, trace.resiliencePlan, trace.resilienceRetry]);
    return t === 'WebBrowser' ? BAD : { success: true };
  };
  const coord = new facade.ResilienceCoordinator({ runner: facade.makeToolRunner(executeTool) });
  const out = await coord.run('fetch-web-content', { url: 'https://a', query: 'qq' });
  assert.equal(out.ok, true);
  assert.equal(out.plan, 'WebFetch');
  assert.deepEqual(seen, [
    ['WebBrowser', 'WebBrowser', 0],
    ['WebFetch', 'WebFetch', 0],
  ]);
});
