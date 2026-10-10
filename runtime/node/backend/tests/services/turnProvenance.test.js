'use strict';

/**
 * turnProvenance.test.js (node:test)
 *
 * 出处判定的三条规则：显式值优先、测试运行器自动标注、其余一律 null（不许猜成真人）。
 * 这条判定决定达成率的分母能不能把夹具流量剔出去，所以规则本身要有回归网。
 */
const test = require('node:test');
const assert = require('node:assert');

const { resolveTurnSource } = require('../../src/services/turnProvenance');

test('explicit source wins over everything', () => {
  assert.strictEqual(resolveTurnSource('nightly', { JEST_WORKER_ID: '2' }), 'nightly');
  assert.strictEqual(resolveTurnSource(null, { KHY_TURN_SOURCE: 'ci' }), 'ci');
});

test('test runners are tagged, not guessed as human', () => {
  assert.strictEqual(resolveTurnSource(null, { JEST_WORKER_ID: '0' }), 'test');
  assert.strictEqual(resolveTurnSource(null, { NODE_TEST_CONTEXT: 'x' }), 'test');
  assert.strictEqual(resolveTurnSource(null, { NODE_ENV: 'test' }), 'test');
});

test('untagged stays null', () => {
  assert.strictEqual(resolveTurnSource(null, {}), null);
  assert.strictEqual(resolveTurnSource('   ', {}), null);
});

test('value is bounded to a safe length', () => {
  assert.strictEqual(resolveTurnSource('x'.repeat(120), {}).length, 40);
});
