'use strict';

/**
 * cliFailureEnvelopeEnvironmental.test.js — [DESIGN-ARCH-181] 一期 D3-3 的验收用例。
 *
 * 主题:环境级(网络/代理全断)时,失败信封的主标题不再说「所有 AI 通道均不可用」,
 * 改说「网络/代理不通(不是通道问题)」并把「检查网络与代理」置为 hint 首条。
 *
 * 判据来源是 `result.routeFact.environmental`([181] D2 的透传结论),**不改判码**
 * (保 [DESIGN-ARCH-114] 单射互斥与 [DESIGN-ARCH-136] 码序)。
 * 白名单外的码(auth / rate_limit / model_not_found / 5xx / unavailable / 钉选类 /
 * NO_ATTEMPT)承载通道侧或请求侧的具体事实,环境级判定**不得覆盖**。
 *
 * ⚠ 实测前提(2026-10-04):级联耗尽时 `result.errorType` 取**最后一条失败**的
 * errorType(aiGatewayGenerateMethod.js:6561-6562),故断网场景在信封里落的码是
 * NETWORK_ERROR 而非 CHANNEL_EXHAUSTED(后者只产自 buildCliFailureEnvelope 的
 * catch 兜底)。白名单据此取「连通层失败/未知」的通用码。
 *
 * 本文件用 `require('node:test')`(jest.config.js 按标记自动忽略;test:node 全量 glob
 * 会跑它 ⇒ 落地即须绿)。既有 jest 套件 tests/gateway/cliFailureEnvelope.test.js 与
 * node:test 套件 cliFailureEnvelopeZeroAttempt.test.js 保持不动,只做影子跑。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  buildCliFailureEnvelope,
  renderCliFailureEnvelope,
} = require('../../src/services/gateway/cliFailureEnvelope');

const ENV = {};

/** 断网型失败:两个不同远端均 network 失败 + routeFact 透出 environmental。 */
const outageResult = (overrides = {}) => ({
  success: false,
  errorType: 'network',
  preferredAdapter: 'auto',
  attempts: [
    { adapterKey: 'api', success: false, errorType: 'network', error: 'ECONNRESET' },
    { adapterKey: 'relay_api', success: false, errorType: 'network', error: 'ECONNRESET' },
  ],
  routeFact: { environmental: true },
  ...overrides,
});

const ENV_TITLE = '本次请求未能完成 —— 网络/代理不通（不是通道问题）';
const ENV_HINT_0 = '检查网络与代理（`khy doctor`）；恢复后说「继续」';

test('E-01 环境级 + NETWORK_ERROR → 标题分流 + hint 首条置环境指引', () => {
  const e = buildCliFailureEnvelope({ result: outageResult(), env: ENV });
  assert.strictEqual(e.code, 'NETWORK_ERROR');
  assert.strictEqual(e.title, ENV_TITLE);
  assert.strictEqual(e.hint[0], ENV_HINT_0);
  assert.ok(e.hint.length >= 2, '既有 hint 条目保留,不丢信息');
  assert.deepStrictEqual(e.hint.slice(1), [
    '运行 `/proxy` 配置代理,或检查网络连通性',
    '运行 `khy gateway status` 看实测状态',
  ]);
});

test('E-02 环境级 + TIMEOUT → 同型分流', () => {
  const e = buildCliFailureEnvelope({
    result: outageResult({ errorType: 'timeout', attempts: [{ adapterKey: 'api', success: false, errorType: 'timeout', error: 'request timed out' }] }),
    env: ENV,
  });
  assert.strictEqual(e.code, 'TIMEOUT');
  assert.strictEqual(e.title, ENV_TITLE);
  assert.strictEqual(e.hint[0], ENV_HINT_0);
});

test('E-03 环境级 + NONE(类型未知但有尝试) → 同型分流', () => {
  const e = buildCliFailureEnvelope({
    result: outageResult({
      errorType: 'weird_unknown',
      attempts: [{ adapterKey: 'api', success: false, errorType: 'weird_unknown', error: 'boom' }],
    }),
    env: ENV,
  });
  assert.strictEqual(e.code, 'NONE');
  assert.strictEqual(e.title, ENV_TITLE);
  assert.strictEqual(e.hint[0], ENV_HINT_0);
});

test('E-04 无 routeFact / environmental=false → 逐字节维持现状(零回归基线)', () => {
  const noFact = buildCliFailureEnvelope({ result: outageResult({ routeFact: undefined }), env: ENV });
  assert.strictEqual(noFact.title, '本次请求未能完成 —— 网络不可达');
  assert.deepStrictEqual(noFact.hint, [
    '运行 `/proxy` 配置代理,或检查网络连通性',
    '运行 `khy gateway status` 看实测状态',
  ]);

  const factFalse = buildCliFailureEnvelope({ result: outageResult({ routeFact: { environmental: false } }), env: ENV });
  assert.strictEqual(factFalse.title, '本次请求未能完成 —— 网络不可达');
  assert.strictEqual(factFalse.hint.length, 2);
});

test('E-05 白名单外的码即便环境级也不改写:auth / rate_limit / model_not_found', () => {
  const cases = [
    ['auth', '本次请求未能完成 —— 认证失败'],
    ['rate_limit', '本次请求未能完成 —— 通道被限流'],
    ['model_not_found', '本次请求未能完成 —— 模型不存在'],
  ];
  for (const [errorType, wantTitle] of cases) {
    const e = buildCliFailureEnvelope({
      result: outageResult({
        errorType,
        attempts: [{ adapterKey: 'api', success: false, errorType, error: 'x' }],
      }),
      env: ENV,
    });
    assert.strictEqual(e.title, wantTitle, errorType);
    assert.ok(!e.hint.includes(ENV_HINT_0), `${errorType} 不得混入环境级 hint`);
  }
});

test('E-06 白名单外的码:5xx / unavailable / 钉选类 / NO_ATTEMPT 同样不覆盖', () => {
  const upstream = buildCliFailureEnvelope({
    result: outageResult({
      errorType: 'server_error',
      attempts: [{ adapterKey: 'api', success: false, errorType: 'server_error', statusCode: 502, error: 'bad gateway' }],
    }),
    env: ENV,
  });
  assert.strictEqual(upstream.title, '本次请求未能完成 —— 上游服务异常');

  const unavailable = buildCliFailureEnvelope({
    result: outageResult({
      errorType: 'unavailable',
      attempts: [{ adapterKey: 'api', success: false, errorType: 'unavailable', error: 'not registered' }],
    }),
    env: ENV,
  });
  assert.strictEqual(unavailable.title, '本次请求未能完成 —— 目标通道不可用');

  const pinned = buildCliFailureEnvelope({
    result: outageResult({
      errorType: 'auth',
      preferredAdapter: 'api',
      attempts: [{ adapterKey: 'api', success: false, errorType: 'auth', statusCode: 401, error: 'unauthorized' }],
    }),
    env: ENV,
  });
  assert.strictEqual(pinned.title, '本次请求未能完成 —— 认证失败(通道被钉选,回退已抑制)');

  const noAttempt = buildCliFailureEnvelope({
    result: {
      success: false,
      errorType: 'unknown',
      preferredAdapter: 'api',
      attempts: [],
      routeFact: { environmental: true },
      registryFacts: { registered: 3, enabled: 1, preferred: 'api', strictPinned: true },
    },
    env: ENV,
  });
  assert.strictEqual(noAttempt.code, 'NO_ATTEMPT');
  assert.strictEqual(noAttempt.title, '本次请求未能完成 —— 本轮未尝试任何通道');
  assert.ok(noAttempt.hint[0].startsWith('通道注册表实况:注册 3 条 / enabled 1 条'), noAttempt.hint[0]);
});

test('E-07 renderCliFailureEnvelope 首屏出现环境级标题与首条指引', () => {
  const e = buildCliFailureEnvelope({ result: outageResult(), env: ENV });
  const text = renderCliFailureEnvelope(e);
  assert.ok(text.includes('网络/代理不通（不是通道问题）'), text);
  assert.ok(text.includes('→ 检查网络与代理'), text);
  assert.ok(!text.includes('所有 AI 通道均不可用'), text);
});

test('E-08 environmental 字段形状严格:仅 ===true 生效(字符串 "true" 不算)', () => {
  for (const environmental of ['true', 1, 'yes', null, undefined, {}]) {
    const e = buildCliFailureEnvelope({
      result: outageResult({ routeFact: { environmental } }),
      env: ENV,
    });
    assert.strictEqual(e.title, '本次请求未能完成 —— 网络不可达', String(environmental));
  }
});

test('E-09 绝不抛:畸形 routeFact / 畸形 result 一律安全', () => {
  const hostile = [
    { result: outageResult({ routeFact: 'environmental' }), env: ENV },
    { result: outageResult({ routeFact: null }), env: ENV },
    { result: { success: false, routeFact: { environmental: true } }, env: ENV },
    { result: null, env: ENV },
    { result: undefined, env: ENV },
    {},
  ];
  for (const input of hostile) {
    assert.doesNotThrow(() => buildCliFailureEnvelope(input));
  }
  // catch 兜底路径:构造失败 → CHANNEL_EXHAUSTED,且**不**套环境级变体(最小惊讶)
  const boom = buildCliFailureEnvelope({
    get result() {
      throw new Error('boom');
    },
  });
  assert.strictEqual(boom.enabled, true);
  assert.strictEqual(boom.code, 'CHANNEL_EXHAUSTED');
  assert.strictEqual(boom.title, '本次请求未能完成 —— 所有 AI 通道均不可用');
});

test('E-10 环境级分流不影响判码与 cause 口径(只动 title/hint 首条)', () => {
  const withEnv = buildCliFailureEnvelope({ result: outageResult(), env: ENV });
  const withoutFact = buildCliFailureEnvelope({ result: outageResult({ routeFact: undefined }), env: ENV });
  assert.strictEqual(withEnv.code, withoutFact.code);
  assert.deepStrictEqual(withEnv.cause, withoutFact.cause);
  assert.deepStrictEqual(withEnv.routing, withoutFact.routing);
  assert.strictEqual(withEnv.showPromoPanel, withoutFact.showPromoPanel, '一期不动 promo 面板');
});
