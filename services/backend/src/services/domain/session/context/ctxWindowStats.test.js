'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeContextStats } = require('./ctxWindowStats');

test('适配器真值上限走 adapter 来源并给出健康分级', () => {
  const r = computeContextStats({ used: 50000, limit: 100000 });
  assert.strictEqual(r.limitSource, 'adapter');
  assert.strictEqual(r.remaining, 50000);
  assert.strictEqual(r.percentUsed, 50);
  assert.strictEqual(r.status, 'healthy');
});

test('上限为 0 时回退到默认 128000 并标 env-fallback', () => {
  const r = computeContextStats({ used: 0, limit: 0 });
  assert.strictEqual(r.limit, 128000);
  assert.strictEqual(r.limitSource, 'env-fallback');
  assert.strictEqual(r.status, 'healthy');
});

test('占用率达阈值分别判 critical / warning', () => {
  assert.strictEqual(computeContextStats({ used: 95000, limit: 100000 }).status, 'critical');
  assert.strictEqual(computeContextStats({ used: 80000, limit: 100000 }).status, 'warning');
});

test('env.KHY_CONTEXT_WINDOW 覆盖回退上限', () => {
  const r = computeContextStats({ used: 100, limit: 0 }, { KHY_CONTEXT_WINDOW: '64000' });
  assert.strictEqual(r.limit, 64000);
  assert.strictEqual(r.remaining, 63900);
});

test('非法 env 回退值落回默认 128000', () => {
  assert.strictEqual(computeContextStats({}, { KHY_CONTEXT_WINDOW: 'abc' }).limit, 128000);
});

test('env 阈值生效并映射健康分级', () => {
  const r = computeContextStats({ used: 55, limit: 100 }, { KHY_CTX_WARN_PCT: '50', KHY_CTX_CRIT_PCT: '60' });
  assert.strictEqual(r.warnPct, 50);
  assert.strictEqual(r.critPct, 60);
  assert.strictEqual(r.status, 'warning');
});

test('超出 100 的阈值回退默认，小数阈值向下取整', () => {
  assert.strictEqual(computeContextStats({}, { KHY_CTX_CRIT_PCT: '150' }).critPct, 90);
  assert.strictEqual(computeContextStats({}, { KHY_CTX_WARN_PCT: '75.9' }).warnPct, 75);
});

test('used 超过 limit 时余量钳 0、占用钳 100、判 critical', () => {
  const r = computeContextStats({ used: 120000, limit: 100000 });
  assert.strictEqual(r.remaining, 0);
  assert.strictEqual(r.percentUsed, 100);
  assert.strictEqual(r.status, 'critical');
});

test('会话累计字段透传并求和', () => {
  const r = computeContextStats({ used: 10, limit: 100, sessionInput: 5, sessionOutput: 7, requestCount: '3', model: 'gpt' });
  assert.strictEqual(r.sessionInput, 5);
  assert.strictEqual(r.sessionOutput, 7);
  assert.strictEqual(r.sessionTotal, 12);
  assert.strictEqual(r.requestCount, 3);
  assert.strictEqual(r.model, 'gpt');
});

test('负 used 归零、model 假值归空串、非假 model 转字符串', () => {
  assert.strictEqual(computeContextStats({ used: -5, limit: 0 }).used, 0);
  assert.strictEqual(computeContextStats({ used: 1, limit: 100, model: 0 }).model, '');
  assert.strictEqual(computeContextStats({ used: 1, limit: 100, model: 123 }).model, '123');
});

test('无参调用返回全零/默认结构', () => {
  const r = computeContextStats();
  assert.strictEqual(r.used, 0);
  assert.strictEqual(r.limit, 128000);
  assert.strictEqual(r.status, 'healthy');
  assert.strictEqual(r.model, '');
});

test('非对象入参（字符串/数组）读不到字段，全部落默认', () => {
  assert.strictEqual(computeContextStats('junk').limit, 128000);
  assert.strictEqual(computeContextStats([1, 2]).used, 0);
});

test('KNOWN-DEFECT: critPct 被 Math.max 强制不低于 warnPct，env 想让 crit 低于 warn 无效', () => {
  // Input warn=90 crit=50 -> measured critPct=90 (Math.max collapses), status judged at 90.
  const r = computeContextStats({ used: 95, limit: 100 }, { KHY_CTX_WARN_PCT: '90', KHY_CTX_CRIT_PCT: '50' });
  assert.strictEqual(r.critPct, 90);
  assert.strictEqual(r.status, 'critical');
});

test('KNOWN-DEFECT: computeContextStats(null) 抛 TypeError，违反「绝不抛」契约', () => {
  // Input null -> measured: throws "Cannot read properties of null (reading 'used')".
  assert.throws(() => computeContextStats(null), TypeError);
});
