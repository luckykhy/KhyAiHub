'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { assertContractSurface, assertHealthFrame } = require('./index');

test('conformance：契约面自检（13 码 + 协议版本）', () => {
  const surface = assertContractSurface();
  assert.deepStrictEqual(surface, { errorCodes: 13, protocolVersion: 1 });
});

test('conformance：健康帧放行合法、拒绝坏帧', () => {
  const ok = {
    status: 'ok',
    coreId: 'c1',
    protocolVersion: 1,
    pid: 1,
    port: 2,
    epoch: 0,
    coreVersion: '0.1.0',
    uptimeMs: 0,
    capabilities: [],
  };
  assert.strictEqual(assertHealthFrame(ok).coreId, 'c1');
  assert.throws(() => assertHealthFrame({ ...ok, status: 'degraded' }), /健康帧不合法/);
});
