/**
 * upstreamModelProbe.parseMaxTokensOverflow + probeContextWindow 返回契约。
 *
 * 背景（[DESIGN-ARCH-154] 热修 4）：probeContextWindow 从 Promise<number> 改为
 * Promise<{contextWindow, maxOutputTokens}> —— 同一次超限请求提取双真值。
 * agnes 实测 400 报文 "max_tokens exceeds the limit of 65536" 是**输出上限**
 * 而非 context 窗口；两字段互不冲突、均 0 = 未探测到（绝不臆造）。
 * 本文件钉住：解析形态不回退、对象契约不回退（含 Step 1 短路返回必须是对象）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const probe = require('../../src/services/gateway/upstreamModelProbe.js');

// ── parseMaxTokensOverflow（纯函数） ─────────────────────────────

test('parseMaxTokensOverflow: agnes 实测报文形态', () => {
  assert.equal(probe.parseMaxTokensOverflow('max_tokens exceeds the limit of 65536'), 65536);
});

test('parseMaxTokensOverflow: agnes 报文内嵌 JSON 错误体', () => {
  assert.equal(
    probe.parseMaxTokensOverflow('{"error":{"message":"max_tokens exceeds the limit of 65536"}}'),
    65536,
  );
});

test('parseMaxTokensOverflow: 泛化形态（max_tokens: value N tokens ...）', () => {
  assert.equal(
    probe.parseMaxTokensOverflow('max_tokens: value 131072 tokens exceeds the limit'),
    131072,
  );
});

test('parseMaxTokensOverflow: 中间夹数字的报文不误提取（0 胜于错数）', () => {
  // "200000 > 65536 tokens" —— 解析器跳不过中间数字，宁可 0 也不提取错值
  assert.equal(
    probe.parseMaxTokensOverflow('max_tokens is too large: 200000 > 65536 tokens'),
    0,
  );
});

test('parseMaxTokensOverflow: context 超限报文不误判为输出上限', () => {
  assert.equal(
    probe.parseMaxTokensOverflow('This model\'s maximum context length is 512000 tokens'),
    0,
  );
});

test('parseMaxTokensOverflow: junk / 空 / 无数字 → 0', () => {
  assert.equal(probe.parseMaxTokensOverflow(''), 0);
  assert.equal(probe.parseMaxTokensOverflow(null), 0);
  assert.equal(probe.parseMaxTokensOverflow('rate limit exceeded'), 0);
});

// ── probeContextWindow 返回契约（对象，不是裸数字） ──────────────

function mockFetchSeq(resps) {
  const realFetch = global.fetch;
  let i = 0;
  global.fetch = async () => {
    const r = resps[Math.min(i, resps.length - 1)];
    i += 1;
    return r;
  };
  return () => { global.fetch = realFetch; };
}

test('probeContextWindow: 缺参 → 零值对象，不发请求', async () => {
  const restore = mockFetchSeq([]);
  try {
    const out = await probe.probeContextWindow({});
    assert.deepEqual(out, { contextWindow: 0, maxOutputTokens: 0 });
    assert.ok(typeof out === 'object' && !Array.isArray(out));
  } finally {
    restore();
  }
});

test('probeContextWindow: Step1 headers 命中 → 对象契约（裸数字回归钉）', async () => {
  const restore = mockFetchSeq([
    { ok: true, headers: new Headers({ 'x-context-window': '131072' }) },
  ]);
  try {
    const out = await probe.probeContextWindow({
      endpoint: 'https://x/v1', apiKey: 'k', modelId: 'm', timeoutMs: 500,
    });
    assert.deepEqual(out, { contextWindow: 131072, maxOutputTokens: 0 });
  } finally {
    restore();
  }
});

test('probeContextWindow: Step1 body 命中 → 对象契约', async () => {
  const restore = mockFetchSeq([
    { ok: true, headers: new Headers(), json: () => Promise.resolve({ model_info: { context_window: 262144 } }) },
  ]);
  try {
    const out = await probe.probeContextWindow({
      endpoint: 'https://x/v1', apiKey: 'k', modelId: 'm', timeoutMs: 500,
    });
    assert.deepEqual(out, { contextWindow: 262144, maxOutputTokens: 0 });
  } finally {
    restore();
  }
});

test('probeContextWindow: Step2 agnes 报文 → maxOutputTokens=65536、ctx=0', async () => {
  // Step1 200（agnes 真实形态：无窗口信息）→ Step2 400 agnes 报文
  const restore = mockFetchSeq([
    {
      ok: true,
      headers: new Headers(),
      json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1 } }),
    },
    {
      ok: false,
      status: 400,
      headers: new Headers(),
      json: () => Promise.resolve({ error: { message: 'max_tokens exceeds the limit of 65536' } }),
    },
  ]);
  try {
    const out = await probe.probeContextWindow({
      endpoint: 'https://x/v1', apiKey: 'k', modelId: 'm', timeoutMs: 500,
    });
    assert.deepEqual(out, { contextWindow: 0, maxOutputTokens: 65536 });
  } finally {
    restore();
  }
});

test('probeContextWindow: Step2 OpenAI context 超限报文 → contextWindow 真值', async () => {
  // 真实 OpenAI 双数报文形态（parseContextOverflowTokens 要求 limit + resulted in 双数）
  const restore = mockFetchSeq([
    { ok: true, headers: new Headers(), json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }) },
    {
      ok: false,
      status: 400,
      headers: new Headers(),
      json: () =>
        Promise.resolve({
          error: {
            message:
              "This model's maximum context length is 512000 tokens. However, your messages resulted in 1000000 tokens. Please reduce the length of the messages or completion.",
          },
        }),
    },
  ]);
  try {
    const out = await probe.probeContextWindow({
      endpoint: 'https://x/v1', apiKey: 'k', modelId: 'm', timeoutMs: 500,
    });
    assert.deepEqual(out, { contextWindow: 512000, maxOutputTokens: 0 });
  } finally {
    restore();
  }
});

test('probeContextWindow: Step2 Anthropic prompt-too-long 报文 → contextWindow 真值', async () => {
  // Anthropic 形态："prompt is too long: 600000 tokens > 200000 maximum"（limit=200000）
  const restore = mockFetchSeq([
    { ok: true, headers: new Headers(), json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }) },
    {
      ok: false,
      status: 400,
      headers: new Headers(),
      json: () => Promise.resolve({ error: { message: 'prompt is too long: 600000 tokens > 200000 maximum' } }),
    },
  ]);
  try {
    const out = await probe.probeContextWindow({
      endpoint: 'https://x/v1', apiKey: 'k', modelId: 'm', timeoutMs: 500,
    });
    assert.deepEqual(out, { contextWindow: 200000, maxOutputTokens: 0 });
  } finally {
    restore();
  }
});
