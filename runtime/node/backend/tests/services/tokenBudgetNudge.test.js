'use strict';

// Unit tests for the token-budget nudge pure leaf ([RESEARCH-020] 差距①).
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const nudge = require('../../src/services/tokenBudgetNudge');

// ---------------------------------------------------------------------------
// isEnabled — opt-in gate, default OFF (registered in flagRegistry as opt-in).
// ---------------------------------------------------------------------------

test('isEnabled: unset env → false (default off)', () => {
  assert.strictEqual(nudge.isEnabled({}), false);
});

test('isEnabled: only explicit true|1 opens (opt-in dialect)', () => {
  assert.strictEqual(nudge.isEnabled({ KHY_TOKEN_BUDGET_NUDGE: 'true' }), true);
  assert.strictEqual(nudge.isEnabled({ KHY_TOKEN_BUDGET_NUDGE: '1' }), true);
  for (const v of ['false', '0', 'off', 'no', '', 'yes', 'on']) {
    assert.strictEqual(nudge.isEnabled({ KHY_TOKEN_BUDGET_NUDGE: v }), false, `value ${JSON.stringify(v)}`);
  }
});

// ---------------------------------------------------------------------------
// resolveMaxNudges — default 1, clamp [0,10], bad values never unbounded.
// ---------------------------------------------------------------------------

test('resolveMaxNudges: default 1', () => {
  assert.strictEqual(nudge.resolveMaxNudges({}), 1);
});

test('resolveMaxNudges: explicit + clamp + garbage → 1', () => {
  assert.strictEqual(nudge.resolveMaxNudges({ KHY_TOKEN_BUDGET_NUDGE_MAX: '3' }), 3);
  assert.strictEqual(nudge.resolveMaxNudges({ KHY_TOKEN_BUDGET_NUDGE_MAX: '-5' }), 0);
  assert.strictEqual(nudge.resolveMaxNudges({ KHY_TOKEN_BUDGET_NUDGE_MAX: '99' }), 10);
  assert.strictEqual(nudge.resolveMaxNudges({ KHY_TOKEN_BUDGET_NUDGE_MAX: 'abc' }), 1);
});

// ---------------------------------------------------------------------------
// shouldNudge — the six-condition matrix. Gate-off ⇒ always false (byte
// fallback of today's behavior).
// ---------------------------------------------------------------------------

const ON = { KHY_TOKEN_BUDGET_NUDGE: '1' };
const BASE = {
  budgetSource: 'prompt',
  spent: 340000,
  ceiling: 500000,
  hadToolCalls: false,
  nudgesUsed: 0,
  goalGateDroveRedrive: false,
};
const onCtx = (over = {}) => ({ ...BASE, ...over });

test('shouldNudge: all six conditions hold → true', () => {
  assert.strictEqual(nudge.shouldNudge(onCtx(), ON), true);
});

test('shouldNudge: gate off → false for every ctx shape (byte fallback)', () => {
  for (const ctx of [onCtx(), onCtx({ spent: 0 }), null, undefined, {}]) {
    assert.strictEqual(nudge.shouldNudge(ctx, {}), false);
  }
});

test('shouldNudge: env-source ceiling never nudges', () => {
  assert.strictEqual(nudge.shouldNudge(onCtx({ budgetSource: 'env' }), ON), false);
  assert.strictEqual(nudge.shouldNudge(onCtx({ budgetSource: undefined }), ON), false);
});

test('shouldNudge: tool_use round (not a natural stop) → false', () => {
  assert.strictEqual(nudge.shouldNudge(onCtx({ hadToolCalls: true }), ON), false);
});

test('shouldNudge: spent >= ceiling → stop line owns it, no nudge', () => {
  assert.strictEqual(nudge.shouldNudge(onCtx({ spent: 500000 }), ON), false);
  assert.strictEqual(nudge.shouldNudge(onCtx({ spent: 500001 }), ON), false);
});

test('shouldNudge: ceiling <= 0 → false', () => {
  assert.strictEqual(nudge.shouldNudge(onCtx({ ceiling: 0 }), ON), false);
});

test('shouldNudge: nudgesUsed cap honored (default max 1)', () => {
  assert.strictEqual(nudge.shouldNudge(onCtx({ nudgesUsed: 1 }), ON), false);
  assert.strictEqual(nudge.shouldNudge(onCtx({ nudgesUsed: 1, maxNudges: 2 }), ON), true);
});

test('shouldNudge: goalStopGate redrive same-round mutual exclusion', () => {
  assert.strictEqual(nudge.shouldNudge(onCtx({ goalGateDroveRedrive: true }), ON), false);
});

test('shouldNudge: garbage input never throws, fails false', () => {
  assert.strictEqual(nudge.shouldNudge({ budgetSource: 'prompt', spent: NaN, ceiling: 'x', hadToolCalls: false }, ON), false);
  assert.strictEqual(nudge.shouldNudge('not-an-object', ON), false);
});

// ---------------------------------------------------------------------------
// buildNudgeMessage — action + target + progress (rule 2) + honesty clause.
// ---------------------------------------------------------------------------

test('buildNudgeMessage: carries numbers, round, honesty clause', () => {
  const msg = nudge.buildNudgeMessage({ spent: 340000, ceiling: 500000, round: 1 });
  assert.ok(msg.startsWith('[SYSTEM: 预算续跑 1]'));
  assert.ok(msg.includes('500000') && msg.includes('340000'));
  assert.ok(msg.includes('不要为凑预算灌水'));
});

// ---------------------------------------------------------------------------
// buildWarnNotice — warn band becomes a one-line status notice, gate-off silent.
// ---------------------------------------------------------------------------

test('buildWarnNotice: gate off → empty string', () => {
  assert.strictEqual(nudge.buildWarnNotice({ spent: 410000, ceiling: 500000 }, {}), '');
});

test('buildWarnNotice: below warn line → empty; in band → one line with numbers', () => {
  assert.strictEqual(nudge.buildWarnNotice({ spent: 100, ceiling: 500000 }, ON), '');
  const line = nudge.buildWarnNotice({ spent: 410000, ceiling: 500000 }, ON);
  assert.ok(line.includes('410000/500000'));
  assert.ok(line.includes('90000'));
  assert.ok(line.includes('KHY_TOKEN_BUDGET')); // default env-source label
});

test('buildWarnNotice: prompt-source label; stop line left to stop notice', () => {
  assert.ok(nudge.buildWarnNotice({ spent: 410000, ceiling: 500000, source: 'prompt' }, ON).includes('提示内目标'));
  assert.strictEqual(nudge.buildWarnNotice({ spent: 500000, ceiling: 500000 }, ON), '');
});

test('buildWarnNotice: custom warnRatio honored and clamped', () => {
  assert.strictEqual(nudge.buildWarnNotice({ spent: 50, ceiling: 100, warnRatio: 0 }, ON).length > 0, true);
  assert.strictEqual(nudge.buildWarnNotice({ spent: 50, ceiling: 100, warnRatio: 9 }, ON), '');
});
