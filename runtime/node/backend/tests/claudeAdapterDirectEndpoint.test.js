'use strict';

/**
 * claudeAdapterDirectEndpoint.test.js — 直连路径的端点能力判别
 *
 * 锁死的契约（BUG 类：能力降级既不判别端点也不通知）：
 *   buildDirectToolDefs 原先对**任意**端点都追加 Anthropic 私有 server tool
 *   {type:'tool_search_tool_regex_20251119'}、约 45 个只有 name 没有 schema 的
 *   defer_loading 惰性桩，以及 anthropic-beta: tool-search-* 头。中转端点三者全不认
 *   （既没有服务端按需回填 schema 的能力，也不认这个 type），收到即 400，而
 *   _maybeRetryWithoutBetas 的正则只匹配 context-1m|interleaved-thinking，匹配不上、
 *   也不会重建 body，于是整轮失败。
 *
 *   修法：deferEnabled = _deferralActive() && isOfficialAnthropicBase(baseUrl)。
 *   非官方端点改发**完整 schema**（模型至少真的能调），不下发私有 pseudo-tool。
 */

const test = require('node:test');
const assert = require('node:assert');

const cx = require('../src/services/gateway/adapters/claudeAdapter');
const buildDirectToolDefs = cx.__test__.buildDirectToolDefs;

const OFFICIAL = undefined; // 未提供 baseUrl → 今日行为（官方）
const RELAY = 'https://relay.example/anthropic';

test('official endpoint keeps today\'s behavior: tool_search pseudo-tool is advertised', () => {
  const defs = buildDirectToolDefs({ baseUrl: OFFICIAL });
  assert.ok(
    defs.some((d) => d.type === 'tool_search_tool_regex_20251119'),
    'official endpoint must still advertise the private tool_search'
  );
  // 注：defer_loading 存根是否存在取决于当前哪些工具声明了 shouldDefer（本环境可能为 0），
  // 故不断言其存在；「官方才允许存根、中转绝不发存根」由下面两条测试锁死。
  for (const d of defs) {
    if (d.defer_loading === true) {
      assert.ok(d.name, 'a stub still carries its name');
    }
  }
});

test('relay endpoint gets NO private pseudo-tool and NO name-only stubs', () => {
  const defs = buildDirectToolDefs({ baseUrl: RELAY });
  assert.ok(
    !defs.some((d) => d.type === 'tool_search_tool_regex_20251119'),
    'relay must not receive the Anthropic-private tool_search (strict relays 400 on it)'
  );
  for (const d of defs) {
    assert.notStrictEqual(d.defer_loading, true, `relay must not receive a name-only stub: ${d.name}`);
    assert.ok(d.input_schema && typeof d.input_schema === 'object', `relay def needs a real schema: ${d.name}`);
  }
});

test('relay endpoint still advertises the tools themselves (capability is not silently dropped)', () => {
  const relayDefs = buildDirectToolDefs({ baseUrl: RELAY });
  const officialDefs = buildDirectToolDefs({ baseUrl: OFFICIAL });
  const relayNames = new Set(relayDefs.map((d) => d.name));
  for (const n of officialDefs.map((d) => d.name)) {
    if (n === 'tool_search') continue;
    assert.ok(relayNames.has(n), `relay must still advertise ${n}`);
  }
});

test('KHY_TOOL_SEARCH_ON_RELAY=1 opts a tool-search-capable relay back in', () => {
  const prev = process.env.KHY_TOOL_SEARCH_ON_RELAY;
  process.env.KHY_TOOL_SEARCH_ON_RELAY = '1';
  try {
    const defs = buildDirectToolDefs({ baseUrl: RELAY });
    assert.ok(defs.some((d) => d.type === 'tool_search_tool_regex_20251119'));
  } finally {
    if (prev === undefined) delete process.env.KHY_TOOL_SEARCH_ON_RELAY;
    else process.env.KHY_TOOL_SEARCH_ON_RELAY = prev;
  }
});

test('a relay that IS anthropic.com (e.g. a subdomain proxy) keeps official behavior', () => {
  const defs = buildDirectToolDefs({ baseUrl: 'https://gateway.anthropic.com' });
  assert.ok(defs.some((d) => d.type === 'tool_search_tool_regex_20251119'));
});

test('endpoint judgement: only non-anthropic hosts are treated as relays', () => {
  const { isOfficialAnthropicBase } = require('../src/services/gateway/adapters/_anthropicToolWire');
  assert.strictEqual(isOfficialAnthropicBase('https://api.anthropic.com'), true);
  assert.strictEqual(isOfficialAnthropicBase('https://api.stepfun.com/step_plan'), false);
  assert.strictEqual(isOfficialAnthropicBase('https://api.deepseek.com/anthropic'), false);
  assert.strictEqual(isOfficialAnthropicBase(''), true, 'empty → today\'s behavior');
  assert.strictEqual(isOfficialAnthropicBase('not a url'), true, 'unparseable → conservative official');
});

test('anthropic wire normalization covers the khy governed shape', () => {
  const { normalizeAnthropicTools } = require('../src/services/gateway/adapters/_anthropicToolWire');
  const out = normalizeAnthropicTools([
    { name: 'Read', description: 'd', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'X', description: '', input_schema: { type: 'object', properties: {} } },
    { type: 'function', function: { name: 'Y', description: 'z', parameters: { type: 'object', properties: {} } } },
    { type: 'web_search_20250305', name: 'web_search' },
  ]);
  assert.deepStrictEqual(out.map((d) => d.name), ['Read', 'X', 'Y', 'web_search']);
  assert.strictEqual(out[0].input_schema.properties.path.type, 'string');
  assert.strictEqual(out[3].type, 'web_search_20250305', 'server-tool type preserved');
});
