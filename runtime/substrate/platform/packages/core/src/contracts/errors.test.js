'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { CORE_ERROR_CODES, CoreError, formatCoreError } = require('./errors');

test('错误码共 13 个，与 API-SURFACE 登记数一致', () => {
  assert.strictEqual(CORE_ERROR_CODES.length, 13);
  assert.strictEqual(new Set(CORE_ERROR_CODES).size, 13);
});

test('CoreError：默认 retryable 按码派生，自定义可覆盖', () => {
  const unavailable = new CoreError('CORE_UNAVAILABLE', '端点无响应');
  assert.strictEqual(unavailable.retryable, true);
  const locked = new CoreError('CORE_LOCKED', '已有核心');
  assert.strictEqual(locked.retryable, false);
  const once = new CoreError('CORE_UNAVAILABLE', '探活失败', { retryable: false });
  assert.strictEqual(once.retryable, false);
});

test('未登记的错误码在构造期即拒绝', () => {
  assert.throws(() => new CoreError('TOTALLY_NEW_CODE', 'x'), /未登记的核心错误码/);
});

test('formatCoreError 产出「问题：原因，修复建议」三段且建议逐码给全', () => {
  const msg = formatCoreError('CORE_LOCKED', '已有核心运行于 PID 1234、端口 9090（心跳 2s 前，epoch 3）');
  assert.ok(msg.startsWith('CORE_LOCKED：已有核心运行于 PID 1234'));
  assert.ok(msg.includes('khy doctor'));
  for (const code of CORE_ERROR_CODES) {
    assert.doesNotThrow(() => formatCoreError(code), `${code} 缺 hint`);
  }
});
