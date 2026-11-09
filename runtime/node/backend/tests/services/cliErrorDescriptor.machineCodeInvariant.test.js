'use strict';

/**
 * cliErrorDescriptor.machineCodeInvariant.test.js — 人话化**不许碰机器侧**的不变式（W8）。
 *
 * 复核点名的回归面：`upstreamTruthLabel._RULES` 扩表会经
 * `_isActionableCause`(cliFailureEnvelope.js:203) → `_tierAttempts`(:216) →
 * `_resolveCode`(:487) **静默翻机器码**（探针实测同一份 attempts 从
 * `code=RATE_LIMITED, cause.adapter=OpenCode Zen` 翻到 `code=NONE, cause.adapter=api`），
 * 且该路径不经任何门。
 *
 * 本文件钉死：H（KHY_FAILURE_HUMAN_TEXT）× T（KHY_UPSTREAM_TRUTH_LABEL）四组合下，
 * 同一份 attempts 的
 *   `code` / `cause.adapter` / `cause.statusCode` / `cause.detail` / `attempts[].error`
 * **逐字节相等**，只有渲染文本不同。今日基线值一并钉死，改动前跑即绿、改动后仍绿。
 */

const path = require('path');

const BE = path.resolve(__dirname, '../..');
const envelopeMod = require(path.join(BE, 'src/services/gateway/cliFailureEnvelope.js'));
const helpers = require(path.join(BE, 'src/cli/aiGatewayGenerateHelpers.js'));

// probe-code 复现语料：一条「400 无 statusCode 字段 + invalid_api_key 体」（会被
// _isActionableCause 认成可行动真因，排在 429 前面）+ 一条真 429。
const ATTEMPTS = [
  {
    success: false,
    adapterKey: 'api',
    errorType: 'auth',
    error: '{"error":{"type":"invalid_request_error","message":"…","code":"invalid_api_key","param":"model"}}',
  },
  {
    success: false,
    adapterKey: 'OpenCode Zen',
    errorType: 'network',
    error: '{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}',
    statusCode: 429,
  },
];

// 顶层 errorType 取 network（不是 auth）——否则 _resolveCode 的第④步会先命中 AUTH_FAILED，
// 429 那条就被遮住了，测不到「可行动真因分层 + 429 判码」这条路。
const RESULT = { success: false, errorType: 'network', attempts: ATTEMPTS, preferredAdapter: 'auto' };

function build(env) {
  return envelopeMod.buildCliFailureEnvelope({ result: RESULT, env });
}

/** 机器侧快照：只取判码/机器字段，不取任何渲染文本。 */
function machineSnapshot(env) {
  const e = build(env);
  return {
    code: e.code,
    adapter: e.cause.adapter,
    statusCode: e.cause.statusCode,
    errorType: e.cause.errorType,
    detail: e.cause.detail,
    attemptsError: e.attempts.map((a) => a.error),
    routing: JSON.stringify(e.routing),
    hint: e.hint.slice(),
  };
}

const H_ON = {};
const H_OFF = { KHY_FAILURE_HUMAN_TEXT: '0' };
const T_OFF = { KHY_UPSTREAM_TRUTH_LABEL: '0' };
const BOTH_OFF = { KHY_FAILURE_HUMAN_TEXT: '0', KHY_UPSTREAM_TRUTH_LABEL: '0' };

describe('W8 · 人话化不碰机器侧（H × T 四组合）', () => {
  test('今日基线值：code=RATE_LIMITED, cause.adapter=OpenCode Zen, cause.statusCode=429', () => {
    const s = machineSnapshot(H_ON);
    expect(s.code).toBe('RATE_LIMITED');
    expect(s.adapter).toBe('OpenCode Zen');
    expect(s.statusCode).toBe(429);
  });

  test('四组合下 code / cause.adapter / cause.statusCode / cause.detail / attempts[].error 逐字节相等', () => {
    const base = machineSnapshot(H_ON);
    for (const env of [H_ON, H_OFF, T_OFF, BOTH_OFF]) {
      expect(machineSnapshot(env)).toEqual(base);
    }
  });

  test('attempts[].error 保持结构化原文一字不改（机器通道不丢）', () => {
    const e = build(H_ON);
    expect(e.attempts[0].error).toBe(ATTEMPTS[0].error);
    expect(e.attempts[1].error).toBe(ATTEMPTS[1].error);
    expect(e.cause.detail).toContain('Upstream request failed');
  });

  test('cause.vendor 只带 type/code/param，不带 message', () => {
    const e = build(H_ON);
    expect(e.cause.vendor).toEqual({ type: 'server_error', code: '', param: '' });
    expect(e.cause.vendor.message).toBeUndefined();
  });

  test('H=1 与 H=0 的**渲染文本**必须不同（否则门没接线，假绿）', () => {
    const on = envelopeMod.renderCliFailureEnvelope(build(H_ON));
    const off = envelopeMod.renderCliFailureEnvelope(build(H_OFF));
    expect(on).not.toBe(off);
    expect(on).toContain('上游端点不可用');
    expect(off).toContain('Upstream request failed: Endpoint is unavailable.');
  });

  test('H=0 → 信封首屏第 3 行逐字节回退今日（detail 原文）', () => {
    const e = build(H_OFF);
    const head = envelopeMod.renderCliFailureEnvelope(e);
    expect(head.split('\n')[2]).toBe(
      `通道: OpenCode Zen (429) [network] — ${e.cause.detail}`
    );
    expect(e.cause.human).toBeNull();
  });

  test('墙的分组 sig 仍按脱敏原文算：同上游两条适配器仍合并成一行', () => {
    const dup = [
      { success: false, adapterKey: 'OpenAI', errorType: 'network', error: 'boom upstream', statusCode: 429 },
      { success: false, adapterKey: 'api', errorType: 'network', error: 'boom upstream', statusCode: 429 },
    ];
    for (const env of [H_ON, H_OFF]) {
      const wall = helpers._formatGatewayFailureDetails({
        success: false,
        errorType: 'network',
        attempts: dup,
      });
      const lines = wall.split('\n').filter((l) => l.startsWith('- '));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('OpenAI +1 个适配器');
    }
  });
});
