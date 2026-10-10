'use strict';

/**
 * upstreamTruthLabel.test.js — 「上游真因上桌」纯叶子契约。
 *
 * 用户实测复现（2026-10-09，会话 9cb05116…，模型 api:opencode-zen:step-5-preview-free）：
 * OpenCode Zen 免费层上游回 429 + `server_error: Upstream request failed: Endpoint is
 * unavailable.`，gateway 却把该失败显示成 `[network]`，用户被带去查网络/代理。本套件锁死：
 *   - 已知语义 → 中文真因标签（且 transient 标记正确）；
 *   - 类别已自证真因（timeout/…）→ 不补，绝不无意义覆盖；
 *   - auth/bad_request 只在命中已知语义时改写（真实的 key 无效不得被覆盖成英文类型名）；
 *   - 门控关 / 认不出 / 垃圾输入 → null，调用方逐字节回退；绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  isEnabled,
  describeUpstream,
  describeFromAttempts,
} = require('../../../src/services/gateway/upstreamTruthLabel');

const ZEN_429 =
  '{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}';
const ZEN_FREE_TIER =
  '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}}';
const ZEN_401_UNSUPPORTED =
  '{"type":"error","error":{"type":"ModelError","message":"Model deepseek-v4-flash-free is not supported"}}';
const REAL_AUTH =
  '{"error":{"message":"Incorrect API key provided: sk-***. You can find your API key at https://platform.openai.com/account/api-keys","type":"invalid_request_error"}}';

// ── isEnabled ───────────────────────────────────────────────────────────────

test('isEnabled: 默认开', () => {
  assert.strictEqual(isEnabled({}), true);
});

test('isEnabled: 0/false/off/no 关', () => {
  for (const v of ['0', 'false', 'OFF', 'no', ' No ']) {
    assert.strictEqual(isEnabled({ KHY_UPSTREAM_TRUTH_LABEL: v }), false, v);
  }
});

// ── 已知语义 ────────────────────────────────────────────────────────────────

test('Zen 429 endpoint-unavailable + network → 「上游端点不可用·瞬态」', () => {
  const d = describeUpstream(ZEN_429, { errorType: 'network', env: {} });
  assert.ok(d, '应提炼出真因');
  assert.strictEqual(d.label, '上游端点不可用');
  assert.strictEqual(d.transient, true);
  assert.strictEqual(d.message, 'Upstream request failed: Endpoint is unavailable.');
  assert.ok(d.advice.length > 0, '瞬态必须给一句可操作建议');
});

test('免费层指纹被拒 → 「免费层客户端校验未通过」（非瞬态）', () => {
  const d = describeUpstream(ZEN_FREE_TIER, { errorType: 'auth', env: {} });
  assert.ok(d);
  assert.strictEqual(d.label, '免费层客户端校验未通过');
  assert.strictEqual(d.transient, false);
});

test('401 not-supported（被归成 auth）+ auth → 「该模型不被上游支持」', () => {
  const d = describeUpstream(ZEN_401_UNSUPPORTED, { errorType: 'auth', env: {} });
  assert.ok(d, 'auth 命中已知语义时应改写（否则用户以为 key 坏了）');
  assert.strictEqual(d.label, '该模型不被上游支持');
});

test('真实 key 无效（无任何已知语义）+ auth → null（绝不覆盖）', () => {
  assert.strictEqual(describeUpstream(REAL_AUTH, { errorType: 'auth', env: {} }), null);
});

// ── 类别已自证 / 认不出 ─────────────────────────────────────────────────────

test('errorType=timeout → null（类别自身已说清真因，不再补）', () => {
  assert.strictEqual(describeUpstream(ZEN_429, { errorType: 'timeout', env: {} }), null);
});

test('errorType=model_not_found → null（留给既有存在性纠偏，不抢）', () => {
  assert.strictEqual(describeUpstream(ZEN_429, { errorType: 'model_not_found', env: {} }), null);
});

test('认不出的结构化 type + network → 退「上游 <type>」，比裸 [network] 具体', () => {
  const d = describeUpstream('{"error":{"type":"WeirdError","message":"boom"}}', {
    errorType: 'network',
    env: {},
  });
  assert.ok(d);
  assert.strictEqual(d.label, '上游 WeirdError');
  assert.strictEqual(d.message, 'boom');
});

test('认不出的结构化 type + auth → null（不把真实 auth 覆盖成英文类型名）', () => {
  assert.strictEqual(
    describeUpstream('{"error":{"type":"invalid_request_error","message":"nope"}}', {
      errorType: 'auth',
      env: {},
    }),
    null
  );
});

test('纯文本（非 JSON）命中语义串 → 仍能提炼', () => {
  const d = describeUpstream('Upstream request failed: Endpoint is unavailable.', {
    errorType: 'network',
    env: {},
  });
  assert.ok(d);
  assert.strictEqual(d.label, '上游端点不可用');
});

// ── 门控 / 健壮性 ───────────────────────────────────────────────────────────

test('门控关 → 一律 null（调用方逐字节回退）', () => {
  assert.strictEqual(
    describeUpstream(ZEN_429, { errorType: 'network', env: { KHY_UPSTREAM_TRUTH_LABEL: '0' } }),
    null
  );
});

test('垃圾输入绝不抛：null / undefined / 数字 / 半截 JSON', () => {
  for (const bad of [null, undefined, 42, '', '   ', '{not json', '{"error":null}']) {
    assert.doesNotThrow(() => describeUpstream(bad, { errorType: 'network', env: {} }));
    assert.strictEqual(describeUpstream(bad, { errorType: 'network', env: {} }), null);
  }
});

// ── describeFromAttempts ────────────────────────────────────────────────────

test('describeFromAttempts: 跳过成功项，取第一条可提炼的失败项', () => {
  const d = describeFromAttempts(
    [
      { success: true, error: ZEN_429, errorType: 'network' },
      { success: false, error: 'read ECONNRESET', errorType: 'network' },
      { success: false, error: ZEN_429, errorType: 'network', statusCode: 429 },
    ],
    { env: {} }
  );
  assert.ok(d);
  assert.strictEqual(d.label, '上游端点不可用');
});

test('describeFromAttempts: 非数组 / 无可提炼项 → null，绝不抛', () => {
  assert.strictEqual(describeFromAttempts(null, { env: {} }), null);
  assert.strictEqual(describeFromAttempts([{ success: true }], { env: {} }), null);
  assert.strictEqual(
    describeFromAttempts([{ success: false, error: 'plain timeout', errorType: 'timeout' }], {
      env: {},
    }),
    null
  );
});
