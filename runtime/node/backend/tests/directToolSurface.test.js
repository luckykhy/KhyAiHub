'use strict';

/**
 * directToolSurface.test.js — Claude 直连路径工具面单一出口
 *
 * 锁死的契约（BUG 类：提示词与 wire 两份真源）：
 *   claudeAdapter.runClaudeDirect 原先用 buildDirectToolDefs() 自建 38 工具池、
 *   从不读 options.tools，导致 aiMessageBuilder 四道治理（agent profile / deny /
 *   弱模型 curated / 轻量轮 curated）与 _forceNoTools 收尾轮在 direct 分支全部失效，
 *   而系统提示词仍按全注册表命令模型用 Agent/Skill/TodoWrite —— 模型被指令驱动去调
 *   线上并不存在的工具。本测试保证治理清单优先、收尾轮权威、legacy 兜底不变。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  resolveDirectToolSurface,
  toAnthropicToolDef,
} = require('../src/services/gateway/adapters/_directToolSurface');

const KHY_GOVERNED = [
  {
    name: 'Read',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

test('governed khy shape {name,description,parameters} → Anthropic input_schema', () => {
  const out = resolveDirectToolSurface({ tools: KHY_GOVERNED }, () => ['FALLBACK']);
  assert.deepStrictEqual(out, [
    {
      name: 'Read',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ]);
});

test('Anthropic-native shape (input_schema) passes through untouched', () => {
  const schema = { type: 'object', properties: { q: { type: 'string' } } };
  const out = resolveDirectToolSurface({ tools: [{ name: 'X', description: '', input_schema: schema }] }, () => ['F']);
  assert.strictEqual(out[0].input_schema, schema);
});

test('OpenAI function shape {type:function,function:{...}} is unwrapped', () => {
  const out = resolveDirectToolSurface(
    { tools: [{ type: 'function', function: { name: 'Y', description: 'z', parameters: { type: 'object', properties: {} } } }] },
    () => ['F']
  );
  assert.strictEqual(out[0].name, 'Y');
  assert.strictEqual(out[0].description, 'z');
  assert.strictEqual(out[0].input_schema.type, 'object');
});

test('server-tool type marker is preserved (passthrough must not lose it)', () => {
  const out = resolveDirectToolSurface({ tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, () => ['F']);
  assert.strictEqual(out[0].type, 'web_search_20250305');
  assert.strictEqual(out[0].name, 'web_search');
});

test('a def with no usable schema degrades to an empty object schema, never undefined', () => {
  const out = toAnthropicToolDef({ name: 'NoSchema', description: 'd' });
  assert.deepStrictEqual(out.input_schema, { type: 'object', properties: {} });
});

test('_forceNoTools===true is authoritative even when a governed list is present', () => {
  // toolUseLoop 的强制收尾轮：aiMessageBuilder 把 toolDefs 置 undefined，但 direct 路径
  // 的 legacy 兜底池仍会诱导弱模型继续调工具。此处必须连兜底一起不发。
  assert.deepStrictEqual(resolveDirectToolSurface({ tools: KHY_GOVERNED, _forceNoTools: true }, () => ['F']), []);
  assert.deepStrictEqual(resolveDirectToolSurface({ _forceNoTools: true }, () => ['F']), []);
});

test('an empty governed array means "no tools this turn" — not "fall back"', () => {
  assert.deepStrictEqual(resolveDirectToolSurface({ tools: [] }, () => ['F']), []);
});

test('no governed list at all → legacy fallback (byte-identical to today)', () => {
  assert.deepStrictEqual(resolveDirectToolSurface({}, () => ['F']), ['F']);
  assert.deepStrictEqual(resolveDirectToolSurface(undefined, () => ['F']), ['F']);
  assert.deepStrictEqual(resolveDirectToolSurface({ tools: 'nope' }, () => ['F']), ['F']);
});

test('completely unrecognizable defs → legacy fallback rather than an empty wire', () => {
  assert.deepStrictEqual(resolveDirectToolSurface({ tools: [{ foo: 1 }, { bar: 2 }] }, () => ['F']), ['F']);
});

test('partially recognizable defs keep the recognizable ones (no all-or-nothing)', () => {
  const out = resolveDirectToolSurface({ tools: [KHY_GOVERNED[0], { foo: 1 }] }, () => ['F']);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'Read');
});

test('no fallback supplied → never throws, returns []', () => {
  assert.deepStrictEqual(resolveDirectToolSurface({}), []);
  assert.deepStrictEqual(resolveDirectToolSurface({ tools: [{ foo: 1 }] }), []);
});

// ── B：官方端点的 deferral 合流 ────────────────────────────────────────────
// 被预算裁掉的工具以 name-only 存根补回 wire + 私有 tool_search，让模型仍能发现它们。
// 代价已实测（64K 窗口 / 167 个被裁）：+1,815 token/轮 ≈ +13%；赢在长会话「揭示不膨胀」。

const DROPPED = [
  { name: 'AmooBridge', description: 'x', parameters: { type: 'object', properties: {} } },
  { name: 'ComputerUse', description: 'y', parameters: { type: 'object', properties: {} } },
  { name: 'Skill', description: 'z', parameters: { type: 'object', properties: {} } },
];
const OFFICIAL = 'https://api.anthropic.com';
const RELAY = 'https://relay.example/anthropic';

test('B: official endpoint gets the dropped tools back as name-only stubs + tool_search', () => {
  const out = resolveDirectToolSurface(
    { tools: [{ name: 'Read', description: 'd', parameters: { type: 'object', properties: {} } }], _droppedToolDefs: DROPPED },
    () => ['FALLBACK'],
    { baseUrl: OFFICIAL }
  );
  const names = out.map((d) => d.name);
  assert.ok(names.includes('Read'), 'the governed tool keeps its full schema');
  for (const n of ['AmooBridge', 'ComputerUse', 'Skill']) {
    assert.ok(names.includes(n), `${n} must come back as a discoverable stub`);
  }
  const stub = out.find((d) => d.name === 'AmooBridge');
  assert.strictEqual(stub.defer_loading, true, 'stubs are name-only (defer_loading)');
  assert.ok(!stub.input_schema, 'a stub must NOT carry a schema (that is the whole point)');
  assert.ok(!stub.description, 'a stub must NOT carry a description either');
  assert.ok(
    out.some((d) => d.type === 'tool_search_tool_regex_20251119' && d.name === 'tool_search'),
    'the private tool_search pseudo-tool must be appended last'
  );
  assert.strictEqual(out[out.length - 1].name, 'tool_search', 'pseudo-tool goes last (cache breakpoint)');
});

test('B: relay endpoint gets NO stubs and NO private pseudo-tool', () => {
  const out = resolveDirectToolSurface(
    { tools: [{ name: 'Read', description: 'd', parameters: { type: 'object', properties: {} } }], _droppedToolDefs: DROPPED },
    () => ['FALLBACK'],
    { baseUrl: RELAY }
  );
  assert.deepStrictEqual(out.map((d) => d.name), ['Read']);
  assert.ok(!out.some((d) => d.defer_loading === true), 'relays cannot resolve defer_loading stubs');
  assert.ok(!out.some((d) => d.type === 'tool_search_tool_regex_20251119'), 'private type would 400 a strict relay');
});

test('B: no baseUrl at all → no stubs (private protocol needs an explicit verdict)', () => {
  // isOfficialAnthropicBase 对空值返回 true 是为兼容 legacy 路径；但往线上发 Anthropic
  // 私有 type 不能靠默认值放行。
  const out = resolveDirectToolSurface(
    { tools: [{ name: 'Read', description: 'd', parameters: { type: 'object', properties: {} } }], _droppedToolDefs: DROPPED },
    () => ['FALLBACK'],
    {}
  );
  assert.deepStrictEqual(out.map((d) => d.name), ['Read']);
});

test('B: KHY_DEFER_TOOLS=0 turns the whole thing off', () => {
  const prev = process.env.KHY_DEFER_TOOLS;
  process.env.KHY_DEFER_TOOLS = '0';
  try {
    const out = resolveDirectToolSurface(
      { tools: [{ name: 'Read', description: 'd', parameters: { type: 'object', properties: {} } }], _droppedToolDefs: DROPPED },
      () => ['F'],
      { baseUrl: OFFICIAL }
    );
    assert.deepStrictEqual(out.map((d) => d.name), ['Read']);
  } finally {
    if (prev === undefined) delete process.env.KHY_DEFER_TOOLS;
    else process.env.KHY_DEFER_TOOLS = prev;
  }
});

test('B: a dropped tool that is already on the wire is not stubbed twice', () => {
  const out = resolveDirectToolSurface(
    { tools: [{ name: 'Read', description: 'd', parameters: { type: 'object', properties: {} } }], _droppedToolDefs: [{ name: 'Read', description: 'dup', parameters: { type: 'object', properties: {} } }] },
    () => ['F'],
    { baseUrl: OFFICIAL }
  );
  assert.strictEqual(out.filter((d) => d.name === 'Read').length, 1, 'no duplicate names');
  assert.ok(!out.some((d) => d.name === 'tool_search'), 'nothing to discover → no pseudo-tool');
});

test('B: empty dropped list → no stubs, no pseudo-tool', () => {
  const out = resolveDirectToolSurface(
    { tools: [{ name: 'Read', description: 'd', parameters: { type: 'object', properties: {} } }], _droppedToolDefs: [] },
    () => ['F'],
    { baseUrl: OFFICIAL }
  );
  assert.deepStrictEqual(out.map((d) => d.name), ['Read']);
});

test('B: the closing round still sends ZERO tools even with stubs available', () => {
  const out = resolveDirectToolSurface(
    { tools: [{ name: 'Read', description: 'd', parameters: { type: 'object', properties: {} } }], _droppedToolDefs: DROPPED, _forceNoTools: true },
    () => ['F'],
    { baseUrl: OFFICIAL }
  );
  assert.deepStrictEqual(out, [], '_forceNoTools is authoritative — no stubs either');
});

test('B: the cost is what we measured — stubs are ~11 tokens, real schemas are ~50x', () => {
  const { estimateTokens } = require('../src/constants/promptAnchors');
  const { getToolDefinitions } = require('../src/services/toolCalling');
  const real = getToolDefinitions().find((d) => d.name === 'ComputerUse') || DROPPED[1];
  const stubTokens = estimateTokens(JSON.stringify({ name: 'AmooBridge', defer_loading: true }));
  const fullTokens = estimateTokens(JSON.stringify(real));
  assert.strictEqual(stubTokens, 11, 'a stub is exactly 11 tokens (measured)');
  assert.ok(fullTokens > stubTokens * 10, `a real schema must dwarf a stub (${fullTokens} vs ${stubTokens})`);
});

test('the governed list the loop actually produces survives a round trip', () => {
  // 端到端形状契约：getToolDefinitions() 的产出必须能被 direct 路径原样上线，
  // 且 Agent/Skill/TodoWrite 这些提示词无条件引用的协调工具必须在清单里（回归哨兵）。
  const { getToolDefinitions } = require('../src/services/toolCalling');
  const governed = getToolDefinitions();
  const names = new Set(governed.map((d) => d.name || (d.function && d.function.name)));
  for (const n of ['Agent', 'Skill', 'TodoWrite', 'WebFetch']) {
    assert.ok(names.has(n), `governed list must advertise ${n}`);
  }
  const out = resolveDirectToolSurface({ tools: governed }, () => ['FALLBACK']);
  assert.strictEqual(out.length, governed.length);
  for (const d of out) {
    assert.ok(typeof d.name === 'string' && d.name.length > 0, 'every def keeps a name');
    assert.ok(d.input_schema && typeof d.input_schema === 'object', 'every def gets input_schema');
  }
});
