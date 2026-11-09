'use strict';

/**
 * toolTableBudget.test.js — 工具表(token)预算
 *
 * 锁死的契约（实测依据）：
 *   getToolDefinitions() = 191 个定义 = 59,235 token，**每轮全量发送**。64K 窗口的模型
 *   光工具表就占 92% 上下文，任务本身被挤出窗口 → 跑偏/漏步骤/过早收尾。
 *   预算 = clamp(window × 0.12, 14000, 32000)；核心按需集永远保留；超预算即截断并交出
 *   丢掉的名字（不静默截断）；KHY_TOOL_TABLE_BUDGET=0 逐字节回退今日全量。
 */

const test = require('node:test');
const assert = require('node:assert');

const B = require('../src/services/tool/toolTableBudget');
const E = require('../src/services/tool/effectiveToolSurface');
const { getToolDefinitions } = require('../src/services/toolCalling');

const FULL = getToolDefinitions();
const nameOf = (d) => d.name || (d.function && d.function.name);
const tokensOf = (defs) => B.estimateToolTableTokens(defs);

test('the problem this fixes is real: the full table is ~59k tokens', () => {
  assert.ok(FULL.length > 150, `expected a big table, got ${FULL.length}`);
  const t = tokensOf(FULL);
  assert.ok(t > 40000, `full table should be tens of thousands of tokens, got ${t}`);
});

test('budget is clamp(window × RATIO, FLOOR, CEIL)', () => {
  assert.strictEqual(B.resolveBudget(64000), 14000, '64K hits the FLOOR');
  assert.strictEqual(B.resolveBudget(128000), 15360);
  assert.strictEqual(B.resolveBudget(200000), 24000);
  assert.strictEqual(B.resolveBudget(1048576), B.CEIL, '1M is capped at CEIL');
  assert.strictEqual(B.resolveBudget(0), B.resolveBudget(128000), 'unknown window → default 128K');
  assert.strictEqual(B.resolveBudget(-5), B.resolveBudget(128000));
});

test('KHY_TOOL_TABLE_BUDGET=0 disables trimming entirely (byte-identical to today)', () => {
  const prev = process.env.KHY_TOOL_TABLE_BUDGET;
  process.env.KHY_TOOL_TABLE_BUDGET = '0';
  try {
    assert.strictEqual(B.resolveBudget(64000), Infinity);
    const kept = E.computeEffectiveToolDefs({ _contextWindow: 64000 });
    assert.strictEqual(kept.length, FULL.length, 'gate off → full table');
  } finally {
    if (prev === undefined) delete process.env.KHY_TOOL_TABLE_BUDGET;
    else process.env.KHY_TOOL_TABLE_BUDGET = prev;
  }
});

test('an explicit positive KHY_TOOL_TABLE_BUDGET is used verbatim (operator dial)', () => {
  const prev = process.env.KHY_TOOL_TABLE_BUDGET;
  process.env.KHY_TOOL_TABLE_BUDGET = '9000';
  try {
    assert.strictEqual(B.resolveBudget(64000), 9000);
    const kept = E.computeEffectiveToolDefs({ _contextWindow: 64000 });
    // 核心集永远保留，即便超过显式预算
    assert.ok(kept.some((d) => nameOf(d) === 'Read'));
    assert.ok(kept.some((d) => nameOf(d) === 'TodoWrite'));
  } finally {
    if (prev === undefined) delete process.env.KHY_TOOL_TABLE_BUDGET;
    else process.env.KHY_TOOL_TABLE_BUDGET = prev;
  }
});

test('a 64K window drops the table from ~59k to ~14k tokens (4x)', () => {
  const kept = E.computeEffectiveToolDefs({ _contextWindow: 64000 });
  const before = tokensOf(FULL);
  const after = tokensOf(kept);
  assert.ok(after < before / 3, `expected >3x reduction, got ${before} → ${after}`);
  assert.ok(kept.length < FULL.length / 4, `expected a much shorter list, got ${kept.length}`);
});

test('the trim is monotone in the window size', () => {
  const sizes = [32000, 64000, 128000, 200000, 1048576].map((w) => ({
    w,
    n: E.computeEffectiveToolDefs({ _contextWindow: w }).length,
  }));
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(
      sizes[i].n >= sizes[i - 1].n,
      `tool count must not shrink as the window grows: ${JSON.stringify(sizes)}`
    );
  }
});

test('the core on-demand set always survives, even over budget', () => {
  for (const w of [32000, 64000, 128000]) {
    const kept = E.computeEffectiveToolDefs({ _contextWindow: w }).map(nameOf);
    for (const must of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'AskUserQuestion', 'WebSearch', 'WebFetch']) {
      assert.ok(kept.includes(must), `${must} must survive at window ${w}`);
    }
  }
});

test('meta tools (tier 1) outrank everything else when the budget bites', () => {
  const { kept, dropped } = B.trimToBudget(FULL, {
    window: 64000,
    isCore: E.isWeakCoreTool,
    env: {},
  });
  const keptNames = new Set(kept.map(nameOf));
  for (const d of dropped) {
    assert.ok(!keptNames.has(nameOf(d)), 'a dropped tool must not also be kept');
  }
  // Agent 是元工具（委派原语），预算紧张时也必须排在领域工具之前
  assert.ok(keptNames.has('Agent'), 'meta tool Agent must outrank domain tools');
});

test('trimming preserves the original relative order (stable prefix / prompt cache)', () => {
  const { kept } = B.trimToBudget(FULL, { window: 64000, isCore: E.isWeakCoreTool, env: {} });
  const originalOrder = new Map(FULL.map((d, i) => [nameOf(d), i]));
  const idxs = kept.map((d) => originalOrder.get(nameOf(d)));
  for (let i = 1; i < idxs.length; i++) {
    assert.ok(idxs[i] > idxs[i - 1], `order broken at ${i}: ${kept.map(nameOf).join(',')}`);
  }
});

test('no silent truncation: dropped names are reported', () => {
  const { kept, dropped, budget, tokensBefore, tokensAfter } = B.trimToBudget(FULL, {
    window: 64000,
    isCore: E.isWeakCoreTool,
    env: {},
  });
  assert.strictEqual(kept.length + dropped.length, FULL.length, 'every tool is accounted for');
  assert.ok(dropped.length > 0, 'a 64K window must drop something');
  assert.ok(tokensAfter < tokensBefore);
  assert.ok(Number.isFinite(budget) && budget > 0);
  assert.ok(dropped.every((d) => nameOf(d)), 'every dropped entry carries a name');
});

test('under budget → nothing is dropped and the array is passed through', () => {
  const small = FULL.slice(0, 5);
  const r = B.trimToBudget(small, { window: 1048576, isCore: () => false, env: {} });
  assert.strictEqual(r.dropped.length, 0);
  assert.strictEqual(r.kept, small, 'pass-through must be the same array reference');
});

test('the discovery channel (toolSearch) survives even an absurdly tight budget', () => {
  // 裁掉 165 个工具却把 toolSearch 一起裁掉 = 「# Additional Tools」段宣传的逃生机变成谎言，
  // 裁剪从「可恢复的省 token」退化成「永久阉割能力面」。toolSearch 是 khy 本地工具
  // （揭示延迟工具），不依赖 Anthropic 服务端，任何端点都能用。
  for (const budget of ['3000', '8000', '15000']) {
    const prev = process.env.KHY_TOOL_TABLE_BUDGET;
    process.env.KHY_TOOL_TABLE_BUDGET = budget;
    try {
      const kept = E.computeEffectiveToolDefs({ _contextWindow: 64000 }).map(nameOf);
      assert.ok(kept.includes('toolSearch'), `toolSearch must survive budget=${budget}`);
      assert.ok(kept.includes('Read'), `core must survive budget=${budget}`);
    } finally {
      if (prev === undefined) delete process.env.KHY_TOOL_TABLE_BUDGET;
      else process.env.KHY_TOOL_TABLE_BUDGET = prev;
    }
  }
});

test('trimming is recoverable: the dropped tools are advertised as discoverable', () => {
  // 「可恢复」的另一半：被裁掉的工具必须在 deferredRecallIndex 的召回面里留名，
  // 否则模型连「还有什么」都不知道。
  const { buildDeferredToolsHint } = require('../src/services/tool/deferredRecallIndex');
  const full = getToolDefinitions();
  const kept = E.computeEffectiveToolDefs({ _contextWindow: 64000 }).map(nameOf);
  const dropped = full.map(nameOf).filter((n) => !kept.includes(n));
  assert.ok(dropped.length > 100, 'the trim must actually drop a lot');
  const hint = buildDeferredToolsHint(dropped, new Map(dropped.map((n) => [n, {}])), { env: {} });
  if (hint) {
    assert.ok(/# Additional Tools/.test(hint), 'hint keeps its marker');
    assert.ok(/toolSearch/.test(hint), 'hint must name the discovery channel');
  }
});

test('empty / bad input never throws', () => {
  assert.deepStrictEqual(B.trimToBudget([], { window: 64000, env: {} }).kept, []);
  assert.deepStrictEqual(B.trimToBudget(null, { window: 64000, env: {} }).kept, []);
  assert.deepStrictEqual(B.trimToBudget(undefined, { env: {} }).kept, []);
  assert.strictEqual(B.estimateToolTableTokens([]), 0);
  assert.strictEqual(B.estimateToolTableTokens(null), 0);
});
