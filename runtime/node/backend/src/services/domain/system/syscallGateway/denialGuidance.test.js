'use strict';

/**
 * denialGuidance.test.js — 高危「无批准通道」拒绝的可执行指引生成器（纯叶子、零 IO）。
 *
 * 关键契约：**只浮现认知，绝不改变放行/拒绝判定**——它只为 cause='no-interactive-channel'
 * 产出指引，其余 cause 返回 null。fail 方向 = fail-**soft**：门控关、非该类拒绝、坏输入、
 * 内部异常一律返回 null，绝不影响审批本身。门控 KHY_GATEWAY_DENIAL_GUIDANCE 默认开，
 * 经 env 参数注入（不碰 process.env）。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { buildDenialGuidance, isDenialGuidanceEnabled } = require('./denialGuidance');
const { DENY_CAUSES } = require('./approvalRouter');

test('isDenialGuidanceEnabled 默认开，仅 falsy token 关闭', () => {
  assert.strictEqual(isDenialGuidanceEnabled({}), true);
  assert.strictEqual(isDenialGuidanceEnabled({ KHY_GATEWAY_DENIAL_GUIDANCE: '0' }), false);
  assert.strictEqual(isDenialGuidanceEnabled({ KHY_GATEWAY_DENIAL_GUIDANCE: 'off' }), false);
  assert.strictEqual(isDenialGuidanceEnabled({ KHY_GATEWAY_DENIAL_GUIDANCE: 'yes' }), true);
});

test('no-interactive-channel 拒绝产出含工具名的指引', () => {
  const g = buildDenialGuidance(DENY_CAUSES.NO_INTERACTIVE_CHANNEL, { tool: 'Bash' }, {});
  assert.strictEqual(typeof g, 'string');
  assert.ok(g.includes('Bash'));
  assert.ok(g.includes('合规途径'));
});

test('无 intent 时回退通用「此高危」措辞', () => {
  const g = buildDenialGuidance(DENY_CAUSES.NO_INTERACTIVE_CHANNEL, null, {});
  assert.ok(g.includes('此高危'));
});

test('其余 cause 一律 null（语义已自明，不改措辞）', () => {
  for (const cause of [
    DENY_CAUSES.USER_DECLINED,
    DENY_CAUSES.CONFIRM_MISMATCH,
    DENY_CAUSES.INTERACTION_ERROR,
  ]) {
    assert.strictEqual(buildDenialGuidance(cause, { tool: 'Bash' }, {}), null);
  }
});

test('门控关 → null（逐字节回退不附指引）', () => {
  const g = buildDenialGuidance(DENY_CAUSES.NO_INTERACTIVE_CHANNEL, { tool: 'Bash' }, {
    KHY_GATEWAY_DENIAL_GUIDANCE: 'off',
  });
  assert.strictEqual(g, null);
});

test('undefined cause → null', () => {
  assert.strictEqual(buildDenialGuidance(undefined, {}, {}), null);
});

test('坏输入（tool 取值即抛）fail-soft 返回 null', () => {
  const bad = {
    get tool() {
      throw new Error('getter');
    },
  };
  assert.strictEqual(buildDenialGuidance(DENY_CAUSES.NO_INTERACTIVE_CHANNEL, bad, {}), null);
});
