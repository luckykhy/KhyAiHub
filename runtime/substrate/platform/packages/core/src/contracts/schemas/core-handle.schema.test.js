'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { CoreLockRecordSchema, LocatorRecordSchema, HelloRequestSchema, HelloResponseSchema } = require('./core-handle.schema');

const lock = {
  coreId: 'core-1',
  pid: 100,
  port: 54321,
  host: '127.0.0.1',
  tokenHash: 'sha256:abc',
  protocolVersion: 1,
  coreVersion: '0.1.0',
  epoch: 3,
  startedAt: 1,
  heartbeatAt: 2,
};

test('锁记录：合法通过，缺 tokenHash/负 pid 拒绝', () => {
  assert.strictEqual(CoreLockRecordSchema.safeParse(lock).success, true);
  const noHash = { ...lock };
  delete noHash.tokenHash;
  assert.strictEqual(CoreLockRecordSchema.safeParse(noHash).success, false);
  assert.strictEqual(CoreLockRecordSchema.safeParse({ ...lock, pid: -1 }).success, false);
});

test('locator 记录：tokenHash 可缺省，endpoint 必填', () => {
  const locator = { coreId: 'c', protocolVersion: 1, pid: 1, endpoint: 'http://127.0.0.1:5', epoch: 0, coreVersion: '0.1.0' };
  assert.strictEqual(LocatorRecordSchema.safeParse(locator).success, true);
  assert.strictEqual(LocatorRecordSchema.safeParse({ ...locator, endpoint: '' }).success, false);
});

test('hello 帧：required 缺省为空数组，response 缺 sessionToken 拒绝', () => {
  assert.strictEqual(HelloRequestSchema.safeParse({ protocolVersion: 1, clientVersion: '0.1.0', terminalId: 'desktop' }).success, true);
  const parsed = HelloRequestSchema.parse({ protocolVersion: 1, clientVersion: '0.1.0', terminalId: 'desktop' });
  assert.deepStrictEqual(parsed.required, []);
  const res = {
    coreId: 'c', coreVersion: '0.1.0', protocolVersion: 1, enginesKhy: '>=1.0.0 <2.0.0', epoch: 0,
    capabilities: [], paths: {}, sessionToken: 'tok', expiresAt: 99,
  };
  assert.strictEqual(HelloResponseSchema.safeParse(res).success, true);
  const noToken = { ...res };
  delete noToken.sessionToken;
  assert.strictEqual(HelloResponseSchema.safeParse(noToken).success, false);
});
