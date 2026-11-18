'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createCoreServer, CORE_PROTOCOL_VERSION } = require('./index');
const { CoreError } = require('../contracts/errors');

test('createCoreServer：参数形状校验先行，坏参数 CORE_INVALID_ARGUMENT', () => {
  assert.throws(
    () => createCoreServer({ dataHome: '' }),
    (err) => err instanceof CoreError && err.code === 'CORE_INVALID_ARGUMENT' && /dataHome/.test(err.message),
  );
});

test('start：零业务骨架如实报未接线，文案三段齐全', async () => {
  const server = createCoreServer({ dataHome: null });
  assert.strictEqual(server.coreId, null);
  assert.strictEqual(server.protocolVersion, CORE_PROTOCOL_VERSION);
  await assert.rejects(
    () => server.start(),
    (err) => err instanceof CoreError && err.code === 'CORE_UNAVAILABLE' && err.retryable === false && /bundledEntry/.test(err.message),
  );
});

test('close：无资源可释放，重复调用不抛', async () => {
  const server = createCoreServer({ dataHome: null });
  await server.close();
  await server.close();
});
