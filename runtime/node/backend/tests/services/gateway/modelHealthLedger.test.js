'use strict';

/**
 * modelHealthLedger.test.js — 纯叶子契约([DESIGN-ARCH-162] §3.1)。
 *
 * 覆盖:门控 off-words、classifyFailure 三分类(permanent/transient/ignore)、
 * recordOutcome 的 broken/tripped/清除语义、statusOf 时钟注入下的 broken→probe-due→
 * re-break 流转、一次 transient 绝不拉黑(A2)、recordProbeResult 轮次累计、绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../../../src/services/gateway/modelHealthLedger'));

const ON = {}; // 默认开
const OFF = { KHY_AUTO_MODEL_HEALTH_AWARE: 'off' };
const CFG = {
  brokenTtlMs: 1800000,
  transientWindowMs: 60000,
  transientStrikes: 3,
  transientCooldownMs: 60000,
};

test('isEnabled: default ON; CANON off-words; non-CANON stays ON', () => {
  assert.equal(leaf.isEnabled(ON), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(leaf.isEnabled({ KHY_AUTO_MODEL_HEALTH_AWARE: off }), false, `off=${off}`);
  }
  assert.equal(leaf.isEnabled({ KHY_AUTO_MODEL_HEALTH_AWARE: 'disabled' }), true);
});

test('classifyFailure: model_not_found→permanent; 白名单→transient; 其余→ignore', () => {
  assert.equal(leaf.classifyFailure('model_not_found', ''), 'permanent');
  assert.equal(leaf.classifyFailure('', 'The model gpt-9 does not exist'), 'permanent');
  assert.equal(leaf.classifyFailure('rate_limit', ''), 'transient');
  assert.equal(leaf.classifyFailure('timeout', ''), 'transient');
  assert.equal(leaf.classifyFailure('auth_error', '401'), 'ignore');
  assert.equal(leaf.classifyFailure(undefined, undefined), 'ignore');
});

test('keyOf: lowercases and trims; missing part → empty', () => {
  assert.equal(leaf.keyOf(' API ', ' GLM-4V '), 'api|glm-4v');
  assert.equal(leaf.keyOf('api', ''), '');
  assert.equal(leaf.keyOf(null, 'x'), '');
});

test('permanent failure: broken until TTL; expiry → probe-due; success clears', () => {
  let s = leaf.newLedger();
  s = leaf.recordOutcome(
    s,
    { adapter: 'api', model: 'm-bad', outcome: 'failure', errorType: 'model_not_found', at: 1000 },
    CFG,
    ON
  );
  assert.equal(leaf.statusOf(s, 'api', 'm-bad', 1000), 'broken');
  assert.equal(leaf.statusOf(s, 'api', 'm-bad', 1000 + 1800000 - 1), 'broken');
  assert.equal(leaf.statusOf(s, 'api', 'm-bad', 1000 + 1800000), 'probe-due');
  s = leaf.recordOutcome(s, { adapter: 'api', model: 'm-bad', outcome: 'success', at: 2000 }, CFG, ON);
  assert.equal(leaf.statusOf(s, 'api', 'm-bad', 2000), 'ok');
});

test('transient: ONE 429 never blacklists; 3rd strike within window trips; window slides', () => {
  let s = leaf.newLedger();
  const ev = (at) => ({ adapter: 'api', model: 'm', outcome: 'failure', errorType: 'rate_limit', at });
  s = leaf.recordOutcome(s, ev(1), CFG, ON);
  assert.equal(leaf.statusOf(s, 'api', 'm', 2), 'ok', 'A2: one 429 must not affect selection');
  s = leaf.recordOutcome(s, ev(2), CFG, ON);
  assert.equal(leaf.statusOf(s, 'api', 'm', 3), 'ok');
  s = leaf.recordOutcome(s, ev(64000), CFG, ON);
  // strikes at 1 and 2 fell out of the 60s sliding window → only 1 in window → still ok
  assert.equal(leaf.statusOf(s, 'api', 'm', 64001), 'ok');
  s = leaf.recordOutcome(s, ev(65000), CFG, ON);
  assert.equal(leaf.statusOf(s, 'api', 'm', 65001), 'ok', '2 strikes in window still ok');
  s = leaf.recordOutcome(s, ev(66000), CFG, ON);
  assert.equal(leaf.statusOf(s, 'api', 'm', 66001), 'tripped');
  assert.equal(leaf.statusOf(s, 'api', 'm', 66001 + 60000), 'ok', 'trip expires back to ok');
});

test('ignore class never mutates the ledger', () => {
  const s0 = leaf.newLedger();
  const s1 = leaf.recordOutcome(
    s0,
    { adapter: 'api', model: 'm', outcome: 'failure', errorType: 'auth_error', at: 5 },
    CFG,
    ON
  );
  assert.equal(s1, s0, 'ignore returns the same ledger object');
});

test('recordProbeResult: fail extends broken and accumulates rounds; success clears', () => {
  let s = leaf.newLedger();
  s = leaf.recordOutcome(
    s,
    { adapter: 'api', model: 'm', outcome: 'failure', errorType: 'model_not_found', at: 1000 },
    CFG,
    ON
  );
  const dueAt = 1000 + 1800000;
  assert.equal(leaf.statusOf(s, 'api', 'm', dueAt), 'probe-due');
  s = leaf.recordProbeResult(s, 'api', 'm', false, dueAt, CFG, ON);
  assert.equal(leaf.statusOf(s, 'api', 'm', dueAt + 1), 'broken');
  assert.equal(leaf.brokenRounds(s, 'api', 'm'), 2);
  s = leaf.recordProbeResult(s, 'api', 'm', true, dueAt + 2, CFG, ON);
  assert.equal(leaf.statusOf(s, 'api', 'm', dueAt + 3), 'ok');
  assert.equal(leaf.brokenRounds(s, 'api', 'm'), 0);
});

test('gate OFF: every mutator is a no-op and returns input unchanged', () => {
  const s0 = leaf.newLedger();
  const s1 = leaf.recordOutcome(
    s0,
    { adapter: 'api', model: 'm', outcome: 'failure', errorType: 'model_not_found', at: 1 },
    CFG,
    OFF
  );
  assert.equal(s1, s0);
});

test('never throws on garbage input', () => {
  assert.doesNotThrow(() => leaf.recordOutcome(null, null, null, null));
  assert.doesNotThrow(() => leaf.recordOutcome({}, { adapter: 1, model: {}, outcome: 'x' }, {}, ON));
  assert.doesNotThrow(() => leaf.statusOf(undefined, undefined, undefined, 'NaN'));
  assert.doesNotThrow(() => leaf.classifyFailure({}, {}));
  assert.doesNotThrow(() => leaf.recordProbeResult(undefined));
  assert.equal(leaf.brokenRounds({}, 'a', 'b'), 0);
});

test('determinism: same event sequence → structurally identical ledger', () => {
  const run = () => {
    let s = leaf.newLedger();
    s = leaf.recordOutcome(
      s,
      { adapter: 'api', model: 'm', outcome: 'failure', errorType: 'rate_limit', at: 10 },
      CFG,
      ON
    );
    s = leaf.recordOutcome(
      s,
      { adapter: 'api', model: 'm', outcome: 'failure', errorType: 'model_not_found', at: 20 },
      CFG,
      ON
    );
    return JSON.stringify(s);
  };
  assert.equal(run(), run());
});
