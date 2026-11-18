'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const contracts = require('./index');

test('契约出口聚合全部子面，键可枚举', () => {
  for (const key of ['CORE_ERROR_CODES', 'CoreError', 'CORE_ENV_KEYS', 'readCoreEnv', 'CORE_PROTOCOL_VERSION']) {
    assert.ok(key in contracts, `缺少导出 ${key}`);
  }
  assert.ok(contracts.LocatorRecordSchema, '缺少 LocatorRecordSchema');
  assert.ok(contracts.HelloRequestSchema, '缺少 HelloRequestSchema');
  assert.ok(contracts.CoreEventSchema, '缺少 CoreEventSchema');
  assert.ok(contracts.CapabilitySchema, '缺少 CapabilitySchema');
});
