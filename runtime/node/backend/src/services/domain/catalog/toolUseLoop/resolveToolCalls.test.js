'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeToolCall } = require('../../../claudeCompat');
const { resolveToolCalls } = require('./resolveToolCalls');

const identity = (call) => call;

function makeCtx(overrides = {}) {
  const crumbs = [];
  const stray = [];
  const ctx = {
    aiResult: { reply: '', toolUseBlocks: [] },
    normalizedStopReason: 'end_turn',
    isTextProtocol: false,
    activeAdapter: { parseToolCalls: () => [] },
    modelLacksNativeTools: false,
    iteration: 1,
    parseToolCalls: () => [],
    canonicalizeToolCall: identity,
    loopBreadcrumb: (event, detail) => crumbs.push({ event, detail }),
    forceNoTools: false,
    onStrayToolCallWhenNoTools: (info) => stray.push(info),
    crumbs,
    stray,
  };
  return Object.assign(ctx, overrides);
}

function run(ctx) {
  return resolveToolCalls({
    aiResult: ctx.aiResult,
    normalizedStopReason: ctx.normalizedStopReason,
    isTextProtocol: ctx.isTextProtocol,
    activeAdapter: ctx.activeAdapter,
    modelLacksNativeTools: ctx.modelLacksNativeTools,
    iteration: ctx.iteration,
    parseToolCalls: ctx.parseToolCalls,
    canonicalizeToolCall: ctx.canonicalizeToolCall,
    loopBreadcrumb: ctx.loopBreadcrumb,
    forceNoTools: ctx.forceNoTools,
    onStrayToolCallWhenNoTools: ctx.onStrayToolCallWhenNoTools,
  });
}

test('forceNoTools: 终止指令权威，即使模型嵌入了调用也返空', () => {
  const ctx = makeCtx({
    forceNoTools: true,
    aiResult: {
      reply: '前置文本 内嵌一个调用',
      toolUseBlocks: [{ type: 'tool_use', name: 'read', input: { file_path: 'a.js' }, id: 't1' }],
    },
    parseToolCalls: () => [{ name: 'read', params: { file_path: 'x' } }],
  });
  assert.deepEqual(run(ctx), []);
});

test('forceNoTools: 有 stray 调用时落 breadcrumb 并通知回调', () => {
  const ctx = makeCtx({
    forceNoTools: true,
    aiResult: { reply: '有文本内调用', toolUseBlocks: [{ type: 'tool_use', name: 'read', input: {}, id: 't1' }] },
    parseToolCalls: () => [
      { name: 'read', params: {} },
      { name: 'grep', params: {} },
    ],
  });
  assert.deepEqual(run(ctx), []);
  assert.equal(ctx.crumbs.length, 1);
  assert.equal(ctx.crumbs[0].event, 'tools-free-stray-call-dropped');
  assert.equal(ctx.crumbs[0].detail.hasStructuredToolUse, true);
  assert.equal(ctx.crumbs[0].detail.strayTextCalls, 2);
  assert.equal(ctx.crumbs[0].detail.iteration, 1);
  // count = 文本 stray(2) + 结构化块(1)
  assert.equal(ctx.stray.length, 1);
  assert.equal(ctx.stray[0].count, 3);
  assert.equal(ctx.stray[0].iteration, 1);
});

test('forceNoTools: 无结构化块时 count 只计文本 stray', () => {
  const ctx = makeCtx({
    forceNoTools: true,
    aiResult: { reply: '文本', toolUseBlocks: [] },
    parseToolCalls: () => [{ name: 'read', params: {} }],
  });
  run(ctx);
  assert.equal(ctx.crumbs[0].detail.hasStructuredToolUse, false);
  assert.equal(ctx.stray[0].count, 1);
});

test('forceNoTools: 干净收尾（无任何调用）不打 breadcrumb、不通知', () => {
  const ctx = makeCtx({
    forceNoTools: true,
    aiResult: { reply: '就是收尾话', toolUseBlocks: [] },
    parseToolCalls: () => [],
  });
  assert.deepEqual(run(ctx), []);
  assert.deepEqual(ctx.crumbs, []);
  assert.deepEqual(ctx.stray, []);
});

test('forceNoTools: parseToolCalls 抛错被吞并按 0 条处理', () => {
  const ctx = makeCtx({
    forceNoTools: true,
    aiResult: { reply: 'x', toolUseBlocks: [] },
    parseToolCalls: () => {
      throw new Error('boom');
    },
  });
  assert.doesNotThrow(() => run(ctx));
  assert.deepEqual(ctx.crumbs, []);
});

test('forceNoTools: 回调缺失（非函数）时仍正常丢弃并留 breadcrumb', () => {
  const ctx = makeCtx({
    forceNoTools: true,
    onStrayToolCallWhenNoTools: null,
    aiResult: { reply: 'x', toolUseBlocks: [{ type: 'tool_use', name: 'read', input: {} }] },
  });
  assert.doesNotThrow(() => run(ctx));
  assert.equal(ctx.crumbs.length, 1);
});

test('forceNoTools: 回调抛错被吞（通知不得断循环）', () => {
  const ctx = makeCtx({
    forceNoTools: true,
    aiResult: { reply: 'x', toolUseBlocks: [{ type: 'tool_use', name: 'read', input: {} }] },
    onStrayToolCallWhenNoTools: () => {
      throw new Error('notify failed');
    },
  });
  assert.doesNotThrow(() => run(ctx));
  assert.equal(ctx.crumbs.length, 1);
});

test('forceNoTools 优先于文本协议：两条路都不放行', () => {
  const ctx = makeCtx({
    forceNoTools: true,
    isTextProtocol: true,
    aiResult: { reply: 'x', toolUseBlocks: [] },
    activeAdapter: { parseToolCalls: () => [{ name: 'read', params: {} }] },
  });
  assert.deepEqual(run(ctx), []);
});

test('文本协议：adapter 的输出原样透传（本簇不再过 normalizeToolCall），不告警', () => {
  const ctx = makeCtx({
    isTextProtocol: true,
    aiResult: { reply: '标签包裹的调用', toolUseBlocks: [] },
    activeAdapter: {
      parseToolCalls: (res) => {
        assert.equal(res, ctx.aiResult);
        return [{ name: 'Read', params: { file_path: 'a.js' }, id: 'w1' }];
      },
    },
  });
  const out = run(ctx);
  assert.equal(out.length, 1);
  assert.deepEqual(ctx.crumbs, []);
  // 与原生路径的关键不对称：text 分支只过注入的 canonicalizeToolCall，
  // 不调 claudeCompat.normalizeToolCall —— 名字/参数规范化完全托付给 adapter。
  assert.deepEqual(out[0], { name: 'Read', params: { file_path: 'a.js' }, id: 'w1' });
  assert.equal(out[0]._structured, undefined);
});

test('文本协议：adapter 返回空时不落任何 breadcrumb', () => {
  const ctx = makeCtx({
    isTextProtocol: true,
    activeAdapter: { parseToolCalls: () => [] },
  });
  assert.deepEqual(run(ctx), []);
  assert.deepEqual(ctx.crumbs, []);
});

test('原生结构化块：权威路径，server_tool_use 被过滤', () => {
  const ctx = makeCtx({
    aiResult: {
      reply: '',
      toolUseBlocks: [
        { type: 'tool_use', name: 'read', input: { file_path: 'a.js' }, id: 'u1' },
        { type: 'server_tool_use', name: 'tool_search', input: {}, id: 'srv' },
      ],
    },
  });
  const out = run(ctx);
  assert.equal(out.length, 1);
  const want = normalizeToolCall('read', { file_path: 'a.js' });
  assert.equal(out[0].name, want.name);
  assert.deepEqual(out[0].params, want.params);
  assert.equal(out[0]._toolUseId, 'u1');
  assert.equal(out[0]._structured, true);
  assert.deepEqual(ctx.crumbs, []);
});

test('原生块：name 从 block.name 回退到 function.name', () => {
  const ctx = makeCtx({
    aiResult: {
      reply: '',
      toolUseBlocks: [{ type: 'tool_use', function: { name: 'grep', arguments: { pattern: 'p' } } }],
    },
  });
  const out = run(ctx);
  assert.equal(out.length, 1);
  const want = normalizeToolCall('grep', { pattern: 'p' });
  assert.equal(out[0].name, want.name);
  assert.deepEqual(out[0].params, want.params);
  assert.equal(out[0]._toolUseId, null);
});

test('原生块：input / params / function.arguments 三种参数拼法都接受', () => {
  const cases = [
    { name: 'read', input: { file_path: 'i' } },
    { name: 'read', params: { file_path: 'p' } },
    { name: 'read', function: { arguments: { file_path: 'f' } } },
  ];
  for (const block of cases) {
    const ctx = makeCtx({ aiResult: { reply: '', toolUseBlocks: [block] } });
    const out = run(ctx);
    assert.equal(out.length, 1);
    const raw = block.input || block.params || block.function.arguments;
    assert.deepEqual(out[0].params, normalizeToolCall('read', raw).params);
  }
});

test('原生块：字符串参数按 JSON 解析，解析失败回落空对象', () => {
  const ctx = makeCtx({
    aiResult: {
      reply: '',
      toolUseBlocks: [
        { name: 'read', input: '{"file_path":"ok.js"}' },
        { name: 'grep', input: '{not json' },
      ],
    },
  });
  const out = run(ctx);
  assert.deepEqual(out[0].params, normalizeToolCall('read', { file_path: 'ok.js' }).params);
  assert.deepEqual(out[1].params, normalizeToolCall('grep', {}).params);
});

test('原生块：tool_use_id 是 id 的回退拼法', () => {
  const ctx = makeCtx({
    aiResult: { reply: '', toolUseBlocks: [{ name: 'read', input: {}, tool_use_id: 'legacy' }] },
  });
  const out = run(ctx);
  assert.equal(out[0]._toolUseId, 'legacy');
});

test('canonicalizeToolCall 是最后一步：拿到的是规范化后的形状', () => {
  const seen = [];
  const ctx = makeCtx({
    aiResult: { reply: '', toolUseBlocks: [{ name: 'read', input: { file_path: 'a' }, id: 'x' }] },
    canonicalizeToolCall: (call) => {
      seen.push(call);
      return { ...call, _canon: true };
    },
  });
  const out = run(ctx);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]._structured, true);
  assert.equal(out[0]._canon, true);
});

test('全为 server_tool_use：只剩 0 条但仍带结构化信号 → 落诊断 breadcrumb', () => {
  const ctx = makeCtx({
    aiResult: { reply: '服务端处理', toolUseBlocks: [{ type: 'server_tool_use', name: 'tool_search', input: {} }] },
  });
  assert.deepEqual(run(ctx), []);
  assert.equal(ctx.crumbs.length, 1);
  assert.equal(ctx.crumbs[0].event, 'tool-parse-empty-despite-signal');
  assert.equal(ctx.crumbs[0].detail.hasStructuredToolUse, true);
});

test('stop_reason=tool_use 但无块：回退文本解析并落两条 breadcrumb', () => {
  const ctx = makeCtx({
    normalizedStopReason: 'tool_use',
    aiResult: { reply: '被截断的调用标签', stopReason: 'tool_use', toolUseBlocks: [] },
    parseToolCalls: () => [{ name: 'read', params: { file_path: 'a.js' } }],
  });
  const out = run(ctx);
  assert.equal(out.length, 1);
  assert.deepEqual(
    ctx.crumbs.map((c) => c.event),
    ['tool-parse-fallback', 'tool-parse-recovered']
  );
  assert.deepEqual(ctx.crumbs[0].detail, { stopReason: 'tool_use', reason: 'no toolUseBlocks' });
  assert.deepEqual(ctx.crumbs[1].detail, { count: 1, method: 'text-fallback' });
});

test('stop_reason=tool_use 且回退仍解析不到：只落 fallback + 诊断，不落 recovered', () => {
  const ctx = makeCtx({
    normalizedStopReason: 'tool_use',
    aiResult: { reply: '纯文本', stopReason: 'tool_use', toolUseBlocks: [] },
    parseToolCalls: () => [],
  });
  assert.deepEqual(run(ctx), []);
  assert.deepEqual(
    ctx.crumbs.map((c) => c.event),
    ['tool-parse-fallback', 'tool-parse-empty-despite-signal']
  );
  assert.equal(ctx.crumbs[1].detail.hasStructuredToolUse, false);
  assert.equal(ctx.crumbs[1].detail.stopReason, 'tool_use');
});

test('纯文本解析：模型已知无原生工具调用 → 预期路径（calm breadcrumb）', () => {
  const ctx = makeCtx({
    modelLacksNativeTools: true,
    aiResult: { reply: '文本协议输出', toolUseBlocks: [] },
    parseToolCalls: () => [{ name: 'read', params: {} }],
  });
  const out = run(ctx);
  assert.equal(out.length, 1);
  assert.deepEqual(ctx.crumbs, [
    { event: 'tool-parse-text-protocol', detail: { count: 1, expected: true } },
  ]);
});

test('纯文本解析：本应有原生块的模型 → 适配器缺口（warning breadcrumb）', () => {
  const ctx = makeCtx({
    modelLacksNativeTools: false,
    aiResult: { reply: '文本协议输出', toolUseBlocks: [] },
    parseToolCalls: () => [
      { name: 'read', params: {} },
      { name: 'grep', params: {} },
    ],
  });
  run(ctx);
  assert.deepEqual(ctx.crumbs, [
    { event: 'tool-parse-text-fallback', detail: { count: 2, reason: 'adapter-gap' } },
  ]);
});

test('纯文本解析且解析不到：不打任何 breadcrumb（无信号可归因）', () => {
  const ctx = makeCtx({
    aiResult: { reply: '就是普通回答', toolUseBlocks: [] },
    parseToolCalls: () => [],
  });
  assert.deepEqual(run(ctx), []);
  assert.deepEqual(ctx.crumbs, []);
});

test('诊断 breadcrumb 的 replyHead 截到 200 字符', () => {
  const long = 'x'.repeat(500);
  const ctx = makeCtx({
    normalizedStopReason: 'tool_use',
    aiResult: { reply: long, toolUseBlocks: [] },
    parseToolCalls: () => [],
  });
  run(ctx);
  const diag = ctx.crumbs.find((c) => c.event === 'tool-parse-empty-despite-signal');
  assert.equal(diag.detail.replyHead.length, 200);
});

test('诊断 breadcrumb：reply 缺失时 replyHead 为空串、iteration 透传', () => {
  const ctx = makeCtx({
    iteration: 7,
    normalizedStopReason: 'tool_use',
    aiResult: { toolUseBlocks: [] },
    parseToolCalls: () => [],
  });
  run(ctx);
  const diag = ctx.crumbs.find((c) => c.event === 'tool-parse-empty-despite-signal');
  assert.equal(diag.detail.replyHead, '');
  assert.equal(diag.detail.iteration, 7);
  assert.equal(diag.detail.stopReason, undefined);
});

test('toolUseBlocks 非数组：不算结构化信号，落进纯文本分支', () => {
  const ctx = makeCtx({
    aiResult: { reply: '文本', toolUseBlocks: { not: 'array' } },
    parseToolCalls: () => [{ name: 'read', params: {} }],
  });
  const out = run(ctx);
  assert.equal(out.length, 1);
  assert.equal(ctx.crumbs[0].event, 'tool-parse-text-fallback');
});

test('结构化优先于 stop_reason：有块时不进回退分支', () => {
  const ctx = makeCtx({
    normalizedStopReason: 'tool_use',
    aiResult: {
      reply: '',
      toolUseBlocks: [{ type: 'tool_use', name: 'read', input: { file_path: 'a' }, id: 'u' }],
    },
    parseToolCalls: () => {
      throw new Error('不应被调用');
    },
  });
  const out = run(ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0]._toolUseId, 'u');
  assert.deepEqual(ctx.crumbs, []);
});

test('stop_reason 非 tool_use 的其它值：不触发回退分支', () => {
  for (const reason of ['stop', 'max_tokens', 'toolUse', '', null, undefined]) {
    const ctx = makeCtx({
      normalizedStopReason: reason,
      aiResult: { reply: '普通回答', toolUseBlocks: [] },
      parseToolCalls: () => [],
    });
    assert.deepEqual(run(ctx), []);
    assert.deepEqual(ctx.crumbs, [], `reason=${String(reason)} 不应落 breadcrumb`);
  }
});

test('本簇不改循环状态：同一 deps 连跑两次结果一致', () => {
  const ctx = makeCtx({
    aiResult: { reply: '', toolUseBlocks: [{ name: 'read', input: { file_path: 'a' }, id: 'u' }] },
  });
  assert.deepEqual(run(ctx), run(ctx));
});
