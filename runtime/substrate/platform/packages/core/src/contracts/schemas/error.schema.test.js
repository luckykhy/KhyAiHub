'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { CoreErrorCodeSchema, CoreErrorPayloadSchema } = require('./error.schema');
const { CORE_ERROR_CODES } = require('../errors');

test('错误码枚举与 errors.js 逐字一致（13 个）', () => {
  assert.strictEqual(CoreErrorCodeSchema.options.length, 13);
  assert.deepStrictEqual([...CORE_ERROR_CODES].sort(), [...CoreErrorCodeSchema.options].sort());
});

test('错误载荷：retryable 必填、details 可缺省、未登记码拒绝', () => {
  assert.strictEqual(CoreErrorPayloadSchema.safeParse({ code: 'CORE_LOCKED', message: '已有核心', retryable: false }).success, true);
  assert.strictEqual(CoreErrorPayloadSchema.safeParse({ code: 'CORE_LOCKED', message: 'x' }).success, false);
  assert.strictEqual(CoreErrorPayloadSchema.safeParse({ code: 'NEW_CODE', message: 'x', retryable: false }).success, false);
});
