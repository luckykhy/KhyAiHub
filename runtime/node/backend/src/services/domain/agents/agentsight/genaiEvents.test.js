'use strict';

// Colocated tests for agentsight/genaiEvents.js.
// MAX_EVENTS is read from GENAI_EVENTS_MAX at module load; pin it before require
// (node --test runs each file in its own process, so this stays file-local).

process.env.GENAI_EVENTS_MAX = '5';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const svc = require('./genaiEvents');

test('recordLLMCall 产出完整事件：eventId/type/timestamp/attributes', () => {
  svc.reset();
  const ev = svc.recordLLMCall({
    model: 'test-model',
    provider: 'test-provider',
    inputTokens: 10,
    outputTokens: 20,
    latencyMs: 300,
    cost: 0.5,
    traceId: 'tr-1',
  });
  assert.equal(ev.type, svc.EVENT_TYPES.LLM_CALL);
  assert.equal(ev.traceId, 'tr-1');
  assert.equal(typeof ev.eventId, 'string');
  assert.ok(ev.eventId.startsWith('evt_'));
  assert.equal(typeof ev.timestamp, 'number');
  assert.equal(ev.attributes['gen_ai.request.model'], 'test-model');
  assert.equal(ev.attributes['gen_ai.usage.input_tokens'], 10);
  assert.equal(ev.attributes['gen_ai.request.streaming'], false);
});

test('recordLLMCall 缺省字段回退：provider/model 缺 → unknown 桶', () => {
  svc.reset();
  const ev = svc.recordLLMCall({});
  assert.equal(ev.attributes['gen_ai.system'], 'unknown');
  const st = svc.getStats();
  assert.equal(st.byModel.unknown.calls, 1);
});

test('recordToolUse：截断 500 字符、success 缺省视为成功、按工具聚合', () => {
  svc.reset();
  const ev = svc.recordToolUse({
    toolName: 'read',
    input: 'x'.repeat(600),
    output: null,
    durationMs: 42,
  });
  assert.equal(ev.type, svc.EVENT_TYPES.TOOL_USE);
  assert.equal(ev.attributes['gen_ai.tool.input'].length, 503); // 500 + '...'
  assert.equal(ev.attributes['gen_ai.tool.output'], '');
  assert.equal(ev.attributes['gen_ai.tool.success'], true);
  const ev2 = svc.recordToolUse({ toolName: 'read', success: false });
  assert.equal(ev2.attributes['gen_ai.tool.success'], false);
  const st = svc.getStats();
  assert.equal(st.byTool.read.calls, 2);
  assert.equal(st.byTool.read.totalDuration, 42);
});

test('recordAgentStep / recordError：reasoning/message 截断 300/500', () => {
  svc.reset();
  const step = svc.recordAgentStep({ sessionId: 's1', stepIndex: 2, action: 'act', reasoning: 'r'.repeat(400) });
  assert.equal(step.attributes['gen_ai.agent.reasoning'].length, 303);
  const err = svc.recordError({ source: 'gw', message: 'm'.repeat(600) });
  assert.equal(err.type, svc.EVENT_TYPES.ERROR);
  assert.equal(err.attributes['gen_ai.error.message'].length, 503);
  assert.equal(svc.getStats().errors, 1);
  assert.equal(svc.getStats().agentSteps, 1);
});

// KNOWN-DEFECT: 遥测记录器对 null/undefined 入参直接抛 TypeError（genaiEvents.js:67-99 无任何
// 参数守卫），对比同目录 walker「绝不抛」契约——调用方忘判空就会把遥测异常打进业务路径
// （低危：调用面目前都传字面量对象，未观察到真实崩溃）。
test('KNOWN-DEFECT: recordLLMCall(null) 直接抛 TypeError 而非诚实记录', () => {
  assert.throws(() => svc.recordLLMCall(null), TypeError);
  assert.throws(() => svc.recordLLMCall(undefined), TypeError);
  // recordError/recordAgentStep 同样无守卫（message 经 _truncate 有兜底，但 source 读取先炸）
  assert.throws(() => svc.recordError(null), TypeError);
});

test('环形缓冲上限：MAX_EVENTS=5（require 前 pin 的 env），旧事件被挤出', () => {
  svc.reset();
  for (let i = 0; i < 8; i++) {
    svc.recordLLMCall({ model: 'm', inputTokens: i });
  }
  const all = svc.getEvents({ limit: 1000 });
  assert.equal(all.length, 5);
  assert.equal(all[all.length - 1].attributes['gen_ai.usage.input_tokens'], 7); // 最新保留
  assert.equal(svc.getStats().totalEvents, 5); // 统计里 totalEvents 也只有环内的
});

test('getEvents 过滤：type / traceId / since / limit', () => {
  svc.reset();
  svc.recordLLMCall({ model: 'a', traceId: 'T1' });
  svc.recordToolUse({ toolName: 't', traceId: 'T2' });
  svc.recordLLMCall({ model: 'b', traceId: 'T1' });
  const t0 = Date.now();
  assert.equal(svc.getEvents({ type: svc.EVENT_TYPES.LLM_CALL, limit: 100 }).length, 2);
  assert.equal(svc.getEvents({ traceId: 'T1', limit: 100 }).length, 2);
  assert.equal(svc.getEvents({ since: t0 + 10000, limit: 100 }).length, 0);
  assert.equal(svc.getEvents({ limit: 2 }).length, 2); // 取最新 2 条
  // 垃圾 filter：NaN since 是 falsy → 不过滤；limit 0 → 默认 50
  assert.equal(svc.getEvents({ since: NaN, limit: 0 }).length, 3);
  // KNOWN-DEFECT（边缘语义）: 负 limit 未被钳制——limit=-1 走 slice(1) 丢掉最旧 1 条，
  // 而非「取最新 N 条」（低危：getEvents 只读，不丢数据源，只是返回条数与直觉不符）。
  assert.equal(svc.getEvents({ limit: -1 }).length, 2);
  assert.equal(svc.getEvents({ limit: -1 })[0].traceId, 'T2'); // 丢的是最旧的 T1 事件
});

test('getStats 聚合：tokens/cost/latency 与 avgLatencyMs', () => {
  svc.reset();
  svc.recordLLMCall({ model: 'm', inputTokens: 1, outputTokens: 2, latencyMs: 100, cost: 0.1 });
  svc.recordLLMCall({ model: 'm', inputTokens: 3, outputTokens: 4, latencyMs: 300, cost: 0.3 });
  const st = svc.getStats();
  assert.equal(st.llmCalls, 2);
  assert.equal(st.totalInputTokens, 4);
  assert.equal(st.totalOutputTokens, 6);
  assert.equal(st.totalCost, 0.4);
  assert.equal(st.avgLatencyMs, 200);
  assert.equal(st.byModel.m.inputTokens, 4);
  assert.ok(st.byModel.m.cost > 0.399 && st.byModel.m.cost < 0.4001);
});

test('createEventStream：同一 EventEmitter，event 与类型事件都播发', () => {
  svc.reset();
  const stream = svc.createEventStream();
  assert.ok(stream instanceof EventEmitter);
  const seen = [];
  const onGeneric = (e) => seen.push('generic:' + e.type);
  const onTyped = (e) => seen.push('typed:' + e.type);
  stream.on('event', onGeneric);
  stream.on(svc.EVENT_TYPES.TOOL_USE, onTyped);
  try {
    svc.recordToolUse({ toolName: 'x' });
  } finally {
    stream.off('event', onGeneric);
    stream.off(svc.EVENT_TYPES.TOOL_USE, onTyped);
  }
  assert.deepEqual(seen, ['generic:' + svc.EVENT_TYPES.TOOL_USE, 'typed:' + svc.EVENT_TYPES.TOOL_USE]);
});

test('reset 清空事件与统计', () => {
  svc.recordLLMCall({ model: 'z' });
  svc.reset();
  const st = svc.getStats();
  assert.equal(st.totalEvents, 0);
  assert.equal(st.llmCalls, 0);
  assert.deepEqual(st.byModel, {});
  assert.deepEqual(st.byTool, {});
  assert.deepEqual(svc.getEvents(), []);
});

test('EVENT_TYPES 常量表稳定', () => {
  assert.deepEqual(svc.EVENT_TYPES, {
    LLM_CALL: 'gen_ai.llm.call',
    TOOL_USE: 'gen_ai.tool.use',
    AGENT_STEP: 'gen_ai.agent.step',
    EMBEDDING: 'gen_ai.embedding',
    RETRIEVAL: 'gen_ai.retrieval',
    ERROR: 'gen_ai.error',
  });
});
