'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { CORE_PROTOCOL_VERSION, CoreHealthResponseSchema, healthFingerprint, healthMatchesLocator } = require('./health');

const baseHealth = {
  status: 'ok',
  coreId: 'core-1',
  protocolVersion: 1,
  pid: 4321,
  port: 54321,
  epoch: 3,
  coreVersion: '0.1.0',
  uptimeMs: 1200,
  capabilities: [{ id: 'gateway.llm', state: 'available', version: '0.1.0' }],
};

const baseLocator = { coreId: 'core-1', protocolVersion: 1, pid: 4321 };

test('协议版本是整数 1，schema 放行合法健康帧', () => {
  assert.strictEqual(CORE_PROTOCOL_VERSION, 1);
  assert.strictEqual(CoreHealthResponseSchema.safeParse(baseHealth).success, true);
});

test('schema 拒绝缺字段/坏枚举/字符串 pid', () => {
  const noPid = { ...baseHealth };
  delete noPid.pid;
  assert.strictEqual(CoreHealthResponseSchema.safeParse(noPid).success, false);
  assert.strictEqual(
    CoreHealthResponseSchema.safeParse({ ...baseHealth, capabilities: [{ id: 'x', state: 'zombie', version: '1' }] })
      .success,
    false,
  );
  assert.strictEqual(CoreHealthResponseSchema.safeParse({ ...baseHealth, pid: '4321' }).success, false);
});

test('指纹三字段全等才认：任一不符即 false', () => {
  assert.strictEqual(healthMatchesLocator(baseHealth, baseLocator), true);
  assert.strictEqual(healthMatchesLocator(baseHealth, { ...baseLocator, pid: 9999 }), false);
  assert.strictEqual(healthMatchesLocator(baseHealth, { ...baseLocator, protocolVersion: 2 }), false);
  assert.strictEqual(healthMatchesLocator(baseHealth, { ...baseLocator, coreId: 'core-2' }), false);
  assert.deepStrictEqual(healthFingerprint(baseHealth), { coreId: 'core-1', protocolVersion: 1, pid: 4321 });
});
