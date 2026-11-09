'use strict';
/**
 * cliBridgeTokenUsage.test.js — 「底栏 ctx 一直为 0」三处修复的回归钉
 *
 * 症状（用户实测「时不时终端还有上下文长度，输出后显示不会更新一直为 0」）：
 *   底栏恒显 `0% ctx (0/128k)`，且此后再无路径能把它救回来。
 *
 * 三处独立根因，本套件各钉一条：
 *   ① cliToolAdapter 成功出口写死 `tokenUsage:{0,0,0}` —— 桥接回合（zen 免费模型
 *      默认走本机 opencode CLI）永远不更新 contextTokens；
 *   ② multiFreeService 的 400 重试**无条件**剥掉 stream_options —— 重试成功了，
 *      但这一回合 usage 必丢；
 *   ③ _protocolPipeline 的 OpenAI 请求体从不带 stream_options.include_usage ——
 *      走该管线的 8 个适配器一概拿不到 usage。
 *
 * 端到端约束（不随实现漂移）：useQueryBridge 的 contextTokens 只在占用 > 0 时更新
 * （`if (occ > 0) setContextTokens(occ)`），所以「估出来 > 0」与「恒 0」是两种
 * 完全不同的用户可见行为，不是精度问题。
 */
const { Readable } = require('node:stream');

const cliToolAdapter = require('../../src/services/gateway/adapters/cliToolAdapter');
const MultiFreeService = require('../../src/services/multiFreeService');
const { createProtocolHandler } = require('../../src/services/gateway/adapters/_protocolPipeline');

const axios = MultiFreeService.httpClient;
const PROVIDER = { name: 'fake', model: 'agnes-2.0-flash', apiKey: 'k' };

function sseStream(lines) {
  return Readable.from(lines.map((l) => l + '\n\n'));
}

/** 造一个 400 错误（nativeJsonRequest 的形状：err.response.data 是错误体字符串）。 */
function http400(bodyText) {
  const err = new Error('Request failed with status code 400');
  err.response = { status: 400, data: bodyText, headers: {} };
  return err;
}

describe('根因① cliToolAdapter 桥接回合 token 用量', () => {
  const { estimateCliTokenUsage } = cliToolAdapter.__test__;

  test('非空 prompt/content → 估出 >0 的占用（不再是写死的 0）', () => {
    const u = estimateCliTokenUsage('你好，帮我分析这段代码', '好的，这是分析结果。'.repeat(20));
    expect(u.inputTokens).toBeGreaterThan(0);
    expect(u.outputTokens).toBeGreaterThan(0);
    expect(u.totalTokens).toBe(u.inputTokens + u.outputTokens);
  });

  test('带 estimated:true 标记，让记账/诊断侧能区分真值与估值', () => {
    const u = estimateCliTokenUsage('hello world', 'hi');
    expect(u.estimated).toBe(true);
  });

  test('英文 prompt 也估得出非零值（4 字符/token 口径）', () => {
    const u = estimateCliTokenUsage('x'.repeat(400), 'y'.repeat(40));
    expect(u.inputTokens).toBeGreaterThan(50);
    expect(u.outputTokens).toBeGreaterThan(5);
  });

  test('空输入 → 全 0，不抛', () => {
    const u = estimateCliTokenUsage('', '');
    expect(u).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  test('门控 KHY_CLI_TOKEN_ESTIMATE=off → 逐字节回退写死 0 的旧行为', () => {
    const u = estimateCliTokenUsage('很长的一段提示词'.repeat(50), '很长的一段回复'.repeat(50), {
      KHY_CLI_TOKEN_ESTIMATE: 'off',
    });
    expect(u).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  test('坏输入（非字符串）不抛', () => {
    expect(() => estimateCliTokenUsage(null, undefined)).not.toThrow();
    expect(() => estimateCliTokenUsage(42, { a: 1 })).not.toThrow();
  });
});

describe('根因② multiFreeService 400 重试不再无条件剥 stream_options', () => {
  let origPost;
  beforeAll(() => {
    origPost = axios.post;
  });
  afterAll(() => {
    axios.post = origPost;
  });

  /** 第一次 400，第二次成功；返回第二次的请求体。 */
  async function retryThenSucceed(err400) {
    const bodies = [];
    let n = 0;
    axios.post = async (url, body) => {
      bodies.push(body);
      n += 1;
      if (n === 1) throw err400;
      return { data: sseStream(['data: {"choices":[{"delta":{"content":"ok"}}]}', 'data: [DONE]']) };
    };
    const svc = new MultiFreeService();
    await svc.callOpenAI(PROVIDER, 'hello', { onChunk() {} });
    return bodies;
  }

  test('400 报文没点名 stream_options → 重试体保留它（usage 不丢）', async () => {
    const bodies = await retryThenSucceed(
      http400('{"error":{"message":"model does not support tools"}}')
    );
    expect(bodies.length).toBe(2);
    expect(bodies[0].stream_options).toEqual({ include_usage: true });
    // 关键断言：重试体仍带 stream_options，这一回合的 usage 才能回流
    expect(bodies[1].stream_options).toEqual({ include_usage: true });
  });

  test('400 报文点名 stream_options → 重试体剥掉它（保请求能过去）', async () => {
    const bodies = await retryThenSucceed(
      http400('{"error":{"message":"Unrecognized request argument supplied: stream_options"}}')
    );
    expect(bodies.length).toBe(2);
    expect(bodies[1].stream_options).toBe(undefined);
  });

  test('400 报文读不到（空体）→ 保守无条件剥，不赌', async () => {
    const bodies = await retryThenSucceed(http400(''));
    expect(bodies.length).toBe(2);
    expect(bodies[1].stream_options).toBe(undefined);
  });

  test('stream_options 以外字段被点名（如 temperature）→ 不剥 stream_options', async () => {
    const bodies = await retryThenSucceed(
      http400('{"error":{"message":"unsupported parameter: temperature"}}')
    );
    expect(bodies[1].stream_options).toEqual({ include_usage: true });
  });
});

describe('根因③ _protocolPipeline OpenAI 请求体索取 usage', () => {
  test('openai + stream → 带 stream_options.include_usage', () => {
    const h = createProtocolHandler({ protocol: 'openai', adapterName: 'cursor' });
    const { body } = h.buildRequestBody('hi', { model: 'm' });
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test('anthropic / responses 管线不受影响（各有自己的 usage 通道）', () => {
    const an = createProtocolHandler({ protocol: 'anthropic', adapterName: 'x' });
    const rs = createProtocolHandler({ protocol: 'responses', adapterName: 'y' });
    expect(an.buildRequestBody('hi', { model: 'm' }).body.stream_options).toBe(undefined);
    expect(rs.buildRequestBody('hi', { model: 'm' }).body.stream_options).toBe(undefined);
  });

  test('非流式 → 不加字段', () => {
    const h = createProtocolHandler({ protocol: 'openai', adapterName: 'cursor' });
    expect(h.buildRequestBody('hi', { model: 'm', stream: false }).body.stream_options).toBe(
      undefined
    );
  });

  test('门控 KHY_STREAM_USAGE=off → 逐字节回退（不加字段）', () => {
    const h = createProtocolHandler({ protocol: 'openai', adapterName: 'cursor' });
    const { body } = h.buildRequestBody('hi', {
      model: 'm',
      env: { KHY_STREAM_USAGE: 'off' },
    });
    expect(body.stream_options).toBe(undefined);
  });

  test('加法式：不碰 messages/model/其余字段', () => {
    const h = createProtocolHandler({ protocol: 'openai', adapterName: 'cursor' });
    const withFlag = h.buildRequestBody('hi', { model: 'm1', temperature: 0.5 });
    const without = h.buildRequestBody('hi', {
      model: 'm1',
      temperature: 0.5,
      env: { KHY_STREAM_USAGE: 'off' },
    });
    const a = { ...withFlag.body };
    const b = { ...without.body };
    delete a.stream_options;
    delete b.stream_options;
    expect(a).toEqual(b);
  });
});
