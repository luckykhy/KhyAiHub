'use strict';

/**
 * toolSurfacePromptWireInvariant.test.js — 「提示词广告的工具 ≡ wire 上线的工具」
 *
 * 这是本次修复的**用户可见判据**，也是当初那个 bug 的定义：
 *   系统提示词按全注册表（185 个名字）命令模型「用 Agent 派子代理 / 用 TodoWrite 维护
 *   清单 / 用 Skill 执行 /commit」，而同一请求发到 wire 的是另一批工具（claude 直连旧池
 *   38 个、收尾轮 0 个、弱模型 curated 16 个、只读子代理 6 个……）。模型被指令驱动去调
 *   线上并不存在的工具 → 执行器查无此工具 → 重试/nudge → 用户看到「它说派了子代理、
 *   建了清单，其实一步没走」，或改用散文描述动作 → 漏步骤 + 伪造结果。
 *
 * 修法：wire 与提示词共用同一个治理函数（services/tool/effectiveToolSurface.js），
 * 本测试把两侧接起来逐场景比对，任何一个场景对不上即红。
 */

const test = require('node:test');
const assert = require('node:assert');

const E = require('../src/services/tool/effectiveToolSurface');
const D = require('../src/services/gateway/adapters/_directToolSurface');
const P = require('../src/constants/prompts');

/** 走一遍真实链路：治理 → 提示词名单 + 直连实际上线形状。 */
function runScenario(opts = {}) {
  const wire = E.computeEffectiveToolDefs(opts);
  const promptNames = E.effectiveToolNames(wire);
  // 收尾轮：aiMessageBuilder 把 toolDefs 置 undefined 并下发 _forceNoTools
  const sent = D.resolveDirectToolSurface(
    { tools: wire, _forceNoTools: opts._forceNoTools === true ? true : undefined },
    () => [{ name: 'LEGACY_POOL' }]
  );
  return { promptNames, sentNames: sent.map((d) => d.name), section: P.getUsingYourToolsSection(promptNames) };
}

/**
 * B 形态（官方端点 deferral 合流）下的链路：wire 会**多于**提示词广告的数量
 * （25 个全 schema + N 个 name-only 存根 + 私有 tool_search）。
 *
 * 不变量因此从「两侧数量相等」弱化为**安全方向仍然成立**的那条：
 *   提示词广告的每一个工具，都必须在 wire 上**且带完整 schema**（绝不是裸存根）。
 * 即「提示词绝不承诺线上没有或不可用的东西」——反方向（wire 多出可发现的裸名）
 * 是 B 的既定代价，风险是弱模型可能盲调存根（Anthropic 会报错并指向 tool_search）。
 */
function runScenarioWithDeferral(opts = {}) {
  const surface = E.computeToolSurface(opts);
  const promptNames = E.effectiveToolNames(surface.kept);
  const sent = D.resolveDirectToolSurface(
    { tools: surface.kept, _droppedToolDefs: surface.dropped },
    () => [{ name: 'LEGACY_POOL' }],
    { baseUrl: 'https://api.anthropic.com' }
  );
  return { promptNames, sent, surface };
}

const SCENARIOS = [
  ['default (full governed list)', {}],
  ['read-only subagent (explore)', { _agentContext: { toolFilter: 'explore' } }],
  ['weak model (flash-lite)', { preferredModel: 'sensenova-flash-lite' }],
  ['lightweight turn', { _lightweightConversation: true }],
  ['first-turn greeting (no tools)', { _pureFirstTurnGreeting: true, _forceNoTools: true }],
  ['denylist-trimmed', { _agentContext: { disallowedTools: ['WebFetch', 'WebSearch'] } }],
  // 工具表预算裁剪也必须保持不变量：窗口越小裁得越狠，但提示词与 wire 始终同一批。
  ['64K window (tool-table budget bites)', { _contextWindow: 64000 }],
  ['32K window (floor)', { _contextWindow: 32000 }],
  ['200K window (proportional)', { _contextWindow: 200000 }],
  ['1M window (ceiling)', { _contextWindow: 1048576 }],
  ['64K window + weak model (both trims)', { _contextWindow: 64000, preferredModel: 'minimax-m2-flash' }],
];

for (const [label, opts] of SCENARIOS) {
  test(`prompt advertises exactly the wire surface — ${label}`, () => {
    const { promptNames, sentNames, section } = runScenario(opts);
    // 1) 名字集合逐一相等（提示词侧名单 === wire 侧上线名单）
    assert.deepStrictEqual(
      [...sentNames].sort(),
      [...promptNames].sort(),
      'wire tools and prompt tool list diverged'
    );
    // 2) 提示词里出现「Use the Agent tool …」当且仅当 Agent 真的在清单里
    const advertisesAgent = /Use the Agent tool with specialized agents/.test(section);
    assert.strictEqual(advertisesAgent, promptNames.includes('Agent'), 'Agent advertisement diverged');
    // 3) Skill 同理
    const advertisesSkill = /Use the Skill tool/.test(section);
    assert.strictEqual(advertisesSkill, promptNames.includes('Skill'), 'Skill advertisement diverged');
    // 4) 空清单 → 一个工具都不广告（这是「不再撒谎」的底线）
    if (promptNames.length === 0) {
      assert.ok(!/Use the Agent tool/.test(section), 'empty surface must advertise nothing');
      assert.ok(!/TodoWrite|TaskCreate/.test(section), 'empty surface must not name a checklist tool');
    }
  });
}

test('an EMPTY effective list means "no tools", not "caller gave nothing"', () => {
  // 回归：khyUpgradeRuntime 曾用 `_eff.length` 判断，把「明确为空」（问候轮/收尾轮）
  // 当成「没提供」→ 回退全注册表 → 提示词重新开始广告 191 个工具，而 wire 上是 0 个。
  const empty = P.getUsingYourToolsSection([]);
  assert.ok(!/Use the Agent tool/.test(empty));
  assert.ok(!/TodoWrite|TaskCreate/.test(empty));
  // 未提供（undefined）才回退全量表 —— 老调用方行为不变
  const full = P.getUsingYourToolsSection(
    E.effectiveToolNames(E.computeEffectiveToolDefs({}))
  );
  assert.ok(/Use the Agent tool/.test(full), 'no list supplied → full registry prompt (legacy)');
});

test('WIRING LOCK: aiChatCore must feed chatOpts (not opts) to both sides', () => {  // 回归一个实测踩过的接线 bug：`baseChatOpts = {...opts}` 是副本(:1545)，而
  // _gatewayGenerate 收到的是 chatOpts。把 _contextWindow 写在 opts 上，提示词用真窗口、
  // wire 用默认 128K —— 两边再次分家，且没有任何单测会红（因为叶子本身是对的）。
  // 故在此锁调用点的形状。
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'cli', 'aiChatCore.js'),
    'utf8'
  );
  assert.ok(
    /chatOpts\._contextWindow\s*=/.test(src),
    'aiChatCore must set _contextWindow on chatOpts (the object _gatewayGenerate receives)'
  );
  assert.ok(
    /computeEffectiveToolDefs\(chatOpts\)/.test(src),
    'prompt side must compute the tool surface from the same chatOpts the wire side reads'
  );
  assert.ok(
    !/opts\._contextWindow\s*=/.test(src),
    'setting it on opts is a no-op for the wire path — do not regress to that'
  );
  assert.ok(
    !/computeEffectiveToolDefs\(opts\)/.test(src),
    'computing the prompt surface from opts (a stale copy) desyncs prompt from wire'
  );
});

// ── B：官方端点 deferral 合流下的不变量 ────────────────────────────────────
test('B (official endpoint): every advertised tool is on the wire WITH a full schema', () => {
  const { promptNames, sent, surface } = runScenarioWithDeferral({ _contextWindow: 64000 });
  assert.ok(surface.dropped.length > 100, 'the 64K trim must actually drop a lot');
  assert.ok(sent.length > promptNames.length, 'B adds discoverable stubs on top of the governed list');

  const withSchema = new Set(sent.filter((d) => d.input_schema && d.defer_loading !== true).map((d) => d.name));
  for (const n of promptNames) {
    assert.ok(withSchema.has(n), `advertised tool ${n} must be on the wire with a FULL schema, not a stub`);
  }
  // 反方向也锁：全 schema 的那一批必须正好是提示词广告的那一批
  assert.deepStrictEqual(
    [...withSchema].sort(),
    [...promptNames].sort(),
    'the full-schema set must equal the advertised set'
  );
});

test('B (official endpoint): stubs are name-only and the discovery channel is present', () => {
  const { sent } = runScenarioWithDeferral({ _contextWindow: 64000 });
  const stubs = sent.filter((d) => d.defer_loading === true);
  assert.ok(stubs.length > 100, 'dropped tools come back as stubs');
  for (const s of stubs) {
    assert.ok(s.name && typeof s.name === 'string');
    assert.ok(!s.input_schema, 'a stub carries no schema');
    assert.ok(!s.description, 'a stub carries no description');
  }
  assert.ok(
    sent.some((d) => d.type === 'tool_search_tool_regex_20251119' && d.name === 'tool_search'),
    'the private tool_search must be there or the stubs are undiscoverable'
  );
  assert.strictEqual(sent[sent.length - 1].name, 'tool_search', 'pseudo-tool goes last');
  // 不重名
  const names = sent.map((d) => d.name);
  assert.strictEqual(new Set(names).size, names.length, 'no duplicate tool names on the wire');
});

test('B (relay endpoint): no stubs, no private type — the wire equals the governed list', () => {
  const surface = E.computeToolSurface({ _contextWindow: 64000 });
  const sent = D.resolveDirectToolSurface(
    { tools: surface.kept, _droppedToolDefs: surface.dropped },
    () => [{ name: 'LEGACY_POOL' }],
    { baseUrl: 'https://relay.example/anthropic' }
  );
  assert.deepStrictEqual(
    sent.map((d) => d.name).sort(),
    surface.kept.map((t) => t.name).sort(),
    'on a relay the wire is exactly the governed list (local toolSearch is the escape hatch)'
  );
  assert.ok(!sent.some((d) => d.defer_loading === true));
  assert.ok(!sent.some((d) => d.type === 'tool_search_tool_regex_20251119'));
});

test('B: the escape hatch (local toolSearch) survives the trim on BOTH endpoint kinds', () => {
  // 官方端点有服务端 tool_search，中转只有本地 toolSearch —— 两条路都必须通。
  for (const baseUrl of ['https://api.anthropic.com', 'https://relay.example/anthropic', undefined]) {
    const kept = E.computeEffectiveToolDefs({ _contextWindow: 64000 }).map((t) => t.name);
    assert.ok(kept.includes('toolSearch'), `local toolSearch must survive at baseUrl=${baseUrl}`);
  }
});
