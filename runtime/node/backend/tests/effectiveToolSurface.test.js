'use strict';

/**
 * effectiveToolSurface.test.js — 工具面治理单一真源
 *
 * 锁死的契约：
 *   1. wire 与系统提示词必须描述**同一批**工具（本测试的函数就是两侧共用的那一个）。
 *   2. 弱模型 curated 必须真的生效 —— 曾经因 require 相对路径写错（'../../gateway/...' 从
 *      src/services/tool/ 解析到不存在的 src/gateway/）被 fail-soft 静默吞掉，191 个工具
 *      照常全量注入，「弱模型裁剪」名存实亡。这条回归测试就是为那个 bug 立的。
 *   3. 问候轮明确「无工具」（undefined），不是「空数组」——语义不同：undefined 走
 *      aiMessageBuilder 的 toolDefs=undefined 分支，[] 会被当作「治理方判定无工具」。
 */

const test = require('node:test');
const assert = require('node:assert');

const E = require('../src/services/tool/effectiveToolSurface');

const names = (defs) => (Array.isArray(defs) ? defs.map((d) => d.name || (d.function && d.function.name)) : defs);

test('no window supplied → the repo\'s documented fallback (128K) drives the budget', () => {
  // 未知窗口不搞特例：用 constants/contextWindowDefaults.js 的 UNKNOWN_MODEL_CONTEXT_WINDOW
  // （仓内既定约定「未知模型的保守回退」），于是预算对该调用方同样生效、可预期。
  const { UNKNOWN_MODEL_CONTEXT_WINDOW } = require('../src/constants/contextWindowDefaults');
  const defs = E.computeEffectiveToolDefs({});
  const { getToolDefinitions } = require('../src/services/toolCalling');
  const full = getToolDefinitions().length;
  assert.strictEqual(UNKNOWN_MODEL_CONTEXT_WINDOW, 128000);
  assert.ok(defs.length > 0 && defs.length < full, `budget must bite at the fallback window, got ${defs.length}/${full}`);
});

test('gate off (KHY_TOOL_TABLE_BUDGET=0) → the FULL governed list, byte-identical to before', () => {
  const prev = process.env.KHY_TOOL_TABLE_BUDGET;
  process.env.KHY_TOOL_TABLE_BUDGET = '0';
  try {
    const { getToolDefinitions } = require('../src/services/toolCalling');
    const defs = E.computeEffectiveToolDefs({});
    assert.strictEqual(defs.length, getToolDefinitions().length);
  } finally {
    if (prev === undefined) delete process.env.KHY_TOOL_TABLE_BUDGET;
    else process.env.KHY_TOOL_TABLE_BUDGET = prev;
  }
});

test('weak model (flash/lite) → curated core set, NOT the full list', () => {
  const defs = E.computeEffectiveToolDefs({ preferredModel: 'sensenova-flash-lite' });
  const n = names(defs);
  assert.ok(n.length > 0 && n.length < 40, `curated core expected, got ${n.length}`);
  for (const must of ['Read', 'Write', 'Edit', 'Glob', 'Grep']) {
    assert.ok(n.includes(must), `core set must keep ${must}`);
  }
  // 跑偏源：这些名字在 curated 集里不该出现
  for (const absent of ['ComputerUse', 'DesktopControl', 'import_model', 'download_model']) {
    assert.ok(!n.includes(absent), `curated set must drop ${absent}`);
  }
});

test('weak-model curation is not silently disabled by a broken require path', () => {
  // 直接验证能力判定与裁剪结果一致：判定为「缺原生工具」时，结果必须短于全量。
  const { modelLacksReliableToolCalling } = require('../src/services/gateway/modelToolingCapability');
  const model = 'minimax-m2-flash';
  assert.strictEqual(modelLacksReliableToolCalling(model, { measured: null }), true);
  const curated = E.computeEffectiveToolDefs({ preferredModel: model });
  const full = E.computeEffectiveToolDefs({});
  assert.ok(curated.length < full.length, 'curated must be strictly smaller than full');
});

test('a model that is NOT weak keeps the full list', () => {
  assert.strictEqual(E.computeEffectiveToolDefs({ preferredModel: 'deepseek-chat' }).length, E.computeEffectiveToolDefs({}).length);
});

test('first-turn pure greeting → undefined (explicitly "no tools"), not []', () => {
  assert.strictEqual(E.computeEffectiveToolDefs({ _pureFirstTurnGreeting: true }), undefined);
  // 后续轮不再清零
  assert.ok(Array.isArray(E.computeEffectiveToolDefs({ _pureFirstTurnGreeting: true, _isFollowUp: true })));
});

test('agent profile filter (explore) → read-only surface', () => {
  const defs = E.computeEffectiveToolDefs({ _agentContext: { toolFilter: 'explore' } });
  const n = names(defs);
  assert.ok(n.length > 0 && n.length < 30, `read-only surface expected, got ${n.length}`);
  assert.ok(!n.includes('Write'), 'explore must not see Write');
  assert.ok(!n.some((x) => /^bash$/i.test(x)), 'explore must not see bash');
  assert.ok(n.includes('Read') || n.includes('Grep') || n.includes('Glob'), 'explore keeps search/read');
});

test('disallowedTools denylist is applied after the profile filter', () => {
  const defs = E.computeEffectiveToolDefs({ _agentContext: { disallowedTools: ['WebFetch'] } });
  assert.ok(!names(defs).includes('WebFetch'));
});

test('lightweight turn → tiny non-mutating surface; follow-up turns are NOT trimmed', () => {
  const light = E.computeEffectiveToolDefs({ _lightweightConversation: true });
  const n = names(light);
  assert.ok(n.length > 0 && n.length < 30, `light surface expected, got ${n.length}`);
  assert.ok(!n.includes('Write') && !n.includes('Edit'), 'light turn drops mutating tools');
  assert.ok(n.includes('Read'), 'light turn keeps Read');
  const followUp = E.computeEffectiveToolDefs({ _lightweightConversation: true, _isFollowUp: true });
  assert.strictEqual(followUp.length, E.computeEffectiveToolDefs({}).length);
});

test('gate off (KHY_WEAK_TOOL_CURATION=0) → byte-fallback to full injection', () => {
  const prev = process.env.KHY_WEAK_TOOL_CURATION;
  process.env.KHY_WEAK_TOOL_CURATION = '0';
  try {
    assert.strictEqual(
      E.computeEffectiveToolDefs({ preferredModel: 'sensenova-flash-lite' }).length,
      E.computeEffectiveToolDefs({}).length
    );
  } finally {
    if (prev === undefined) delete process.env.KHY_WEAK_TOOL_CURATION;
    else process.env.KHY_WEAK_TOOL_CURATION = prev;
  }
});

test('effectiveToolNames is the prompt-side view of the very same surface', () => {
  const defs = E.computeEffectiveToolDefs({});
  assert.deepStrictEqual(E.effectiveToolNames(defs), names(defs));
  assert.deepStrictEqual(E.effectiveToolNames(undefined), []);
  assert.deepStrictEqual(E.effectiveToolNames([]), []);
});

test('tool-name predicates match the documented core/mutating sets', () => {
  for (const n of ['Read', 'read_file', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'bash', 'shellCommand', 'PowerShell', 'WebSearch', 'WebFetch', 'TodoWrite', 'AskUserQuestion', 'mcp__x']) {
    assert.ok(E.isWeakCoreTool(n), `${n} must be a core tool`);
  }
  for (const n of ['Write', 'Edit', 'bash', 'ComputerUse', 'DesktopControl']) {
    assert.ok(!E.isNonMutatingLightTool(n), `${n} must count as mutating`);
  }
  for (const n of ['Read', 'Glob', 'Grep', 'WebSearch', 'toolSearch']) {
    assert.ok(E.isNonMutatingLightTool(n), `${n} must be non-mutating`);
  }
});
