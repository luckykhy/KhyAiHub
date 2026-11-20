'use strict';

/**
 * agnesMaxTokens.test.js — Agnes 网关 max_tokens 钳位叶子(纯函数)契约锁。
 *
 * 根因回归(与 ZCode 侧同源的「max_tokens 不能超过 65536」):
 *   Agnes 网关(国际站 apihub.agnes-ai.com / 中国站 api.agnes-ai.cn)对 max_tokens
 *   有 65536 硬上限。ZCode 侧因模型规则缺 maxOutputTokens 覆盖、继承内置通配规则的
 *   128000 而每轮 400;khyos 侧同构风险:maxTokensPolicy 只认元数据,Agnes 在 khyos
 *   无任何元数据 → 放行,调用方显式携带的更高值原样撞上限。本叶子把发往 Agnes 的
 *   max_tokens 钳进 [1, 上限];其余原样透传;门控关/异常 → 逐字节回退。
 *
 * 锁死:
 *   - 命中 Agnes 模型(裸名 / provider 前缀 / 三段 id)→ 128000→65536;
 *   - 模型名不命中但端点命中(国际站 + 中国站)→ 同样钳位;
 *   - 已 ≤65536 → 原样;小数 → floor 后钳位;
 *   - 非有限值(undefined/null/NaN/≤0)→ 原样透传(内部默认 ≤4095 无隐患);
 *   - 非 Agnes 模型/端点 → 原样透传(含 undefined);
 *   - 门控关(0/false/off/no)→ 原样透传;上限旋钮 KHY_AGNES_MAX_TOKENS 生效/越界回退;
 *   - 绝不抛(null / 非字符串 model / 怪异输入)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  clampMaxTokensForAgnes,
  clampEnabled,
  resolveCap,
  isAgnesModelName,
  isAgnesEndpoint,
  AGNES_MAX_TOKENS,
} = require('../../../src/services/gateway/agnesMaxTokens');

const ON = {}; // 缺省 env → 默认开
const CN = 'https://api.agnes-ai.cn/v1'; // 中国站(实测 65536 上限)
const INTL = 'https://apihub.agnes-ai.com/v1'; // 国际站

test('上限常量 = 65536', () => {
  assert.strictEqual(AGNES_MAX_TOKENS, 65536);
  assert.strictEqual(resolveCap(ON), 65536);
});

test('命中 Agnes 模型:超上限 → 钳到 65536', () => {
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', 128000, ON), 65536);
  assert.strictEqual(clampMaxTokensForAgnes('agnes-2.0-flash', 65537, ON), 65536);
  // 带 provider 前缀 / 三段 id 亦命中。
  assert.strictEqual(clampMaxTokensForAgnes('agnes/agnes-3.0-flash', 128000, ON), 65536);
  assert.strictEqual(clampMaxTokensForAgnes('api:agnes:agnes-3.0-flash', 128000, ON), 65536);
  assert.strictEqual(clampMaxTokensForAgnes('api:agnes-cn:agnes-3.0-flash', 128000, ON), 65536);
});

test('端点兜底:模型名不命中但端点命中 → 同样钳位', () => {
  assert.strictEqual(clampMaxTokensForAgnes('some-model', 128000, ON, CN), 65536);
  assert.strictEqual(clampMaxTokensForAgnes('some-model', 128000, ON, INTL), 65536);
  // baseUrl 形态(剥过 /v1)亦命中。
  assert.strictEqual(clampMaxTokensForAgnes('some-model', 128000, ON, 'https://api.agnes-ai.cn'), 65536);
});

test('端点判定:非 Agnes 端点 → 不命中', () => {
  assert.strictEqual(isAgnesEndpoint(CN), true);
  assert.strictEqual(isAgnesEndpoint(INTL), true);
  assert.strictEqual(isAgnesEndpoint('https://api.openai.com/v1'), false);
  assert.strictEqual(isAgnesEndpoint('https://open.bigmodel.cn/api/paas/v4'), false);
  assert.strictEqual(isAgnesEndpoint(''), false);
  assert.strictEqual(isAgnesEndpoint('not-a-url'), false);
  assert.strictEqual(isAgnesEndpoint(null), false);
});

test('模型名判定', () => {
  assert.strictEqual(isAgnesModelName('agnes-3.0-flash'), true);
  assert.strictEqual(isAgnesModelName('agnes/agnes-2.0-flash'), true);
  assert.strictEqual(isAgnesModelName('api:agnes:agnes-3.0-flash'), true);
  assert.strictEqual(isAgnesModelName('glm-5.3'), false);
  assert.strictEqual(isAgnesModelName('my-agnes-proxy'), false);
  assert.strictEqual(isAgnesModelName(''), false);
  assert.strictEqual(isAgnesModelName(null), false);
});

test('已 ≤65536 → 原样透传', () => {
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', 4096, ON), 4096);
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', 65536, ON), 65536);
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', 1, ON), 1);
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', 1024, ON), 1024);
});

test('小数 → floor 后钳位', () => {
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', 70000.9, ON), 65536);
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', 2048.7, ON), 2048);
});

test('非有限值 → 原样透传(内部默认 ≤4095,无高默认值隐患)', () => {
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', undefined, ON), undefined);
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', null, ON), null);
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', NaN, ON), NaN);
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', 0, ON), 0);
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', -5, ON), -5);
});

test('非 Agnes 目标 → 原样透传(含 undefined)', () => {
  assert.strictEqual(clampMaxTokensForAgnes('glm-5.3', 128000, ON), 128000);
  assert.strictEqual(clampMaxTokensForAgnes('deepseek-chat', 128000, ON), 128000);
  assert.strictEqual(clampMaxTokensForAgnes('gpt-4o', 128000, ON, 'https://api.openai.com/v1'), 128000);
  assert.strictEqual(clampMaxTokensForAgnes('glm-5.3', undefined, ON), undefined);
});

test('门控关(0/false/off/no)→ 原样透传,不钳位', () => {
  for (const off of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    const env = { KHY_AGNES_MAX_TOKENS_CLAMP: off };
    assert.strictEqual(clampEnabled(env), false, `off=${off}`);
    assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', 128000, env), 128000, `off=${off}`);
  }
});

test('门控开(缺省 / 其它值)→ 钳位', () => {
  assert.strictEqual(clampEnabled({}), true);
  assert.strictEqual(clampEnabled({ KHY_AGNES_MAX_TOKENS_CLAMP: '1' }), true);
  assert.strictEqual(clampEnabled({ KHY_AGNES_MAX_TOKENS_CLAMP: 'on' }), true);
});

test('上限旋钮 KHY_AGNES_MAX_TOKENS:生效 / 非法回退 65536', () => {
  const env = { KHY_AGNES_MAX_TOKENS: '32768' };
  assert.strictEqual(resolveCap(env), 32768);
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', 65536, env), 32768);
  // 非法 / 越界(≤0)→ 回退默认。
  assert.strictEqual(resolveCap({ KHY_AGNES_MAX_TOKENS: 'abc' }), 65536);
  assert.strictEqual(resolveCap({ KHY_AGNES_MAX_TOKENS: '0' }), 65536);
  assert.strictEqual(resolveCap({ KHY_AGNES_MAX_TOKENS: '-1' }), 65536);
});

test('绝不抛:null / 非字符串 model / 怪异输入', () => {
  assert.strictEqual(clampMaxTokensForAgnes(null, 128000, ON), 128000);
  assert.strictEqual(clampMaxTokensForAgnes(undefined, 128000, ON), 128000);
  assert.strictEqual(clampMaxTokensForAgnes(12345, 128000, ON), 128000);
  assert.strictEqual(clampMaxTokensForAgnes({}, 128000, ON), 128000);
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', 'not-a-number', ON), 'not-a-number');
  // env=null → 门控按缺省处理(默认开),仍钳位,不抛。
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', 128000, null), 65536);
  // endpoint 传非字符串 → 端点判定 false,模型名仍命中。
  assert.strictEqual(clampMaxTokensForAgnes('agnes-3.0-flash', 128000, ON, 42), 65536);
});
