'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { obtainCore, SUITE_INJECTION_KEY } = require('./obtain-core');
const { CoreError } = require('../contracts/errors');

const HEALTH = {
  status: 'ok',
  coreId: 'core-1',
  protocolVersion: 1,
  pid: 4321,
  port: 54321,
  epoch: 3,
  coreVersion: '0.1.0',
  uptimeMs: 10,
  capabilities: [{ id: 'gateway.llm', state: 'available', version: '0.1.0' }],
};

const HELLO = {
  coreId: 'core-1',
  coreVersion: '0.1.0',
  protocolVersion: 1,
  enginesKhy: '>=1.0.0 <2.0.0',
  epoch: 3,
  capabilities: [{ id: 'gateway.llm', state: 'available', version: '0.1.0' }],
  paths: { dataHome: 'D:/x' },
  sessionToken: 'tok',
  expiresAt: 99,
};

function makeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return { impl, calls };
}

const okJson = (body) => ({ ok: true, json: async () => body });

const BASE_OPTS = { terminalId: 'desktop', clientVersion: '0.1.0' };

test('显式 endpoint 命中即走 health→hello，不再读 env/发现', async () => {
  const { impl, calls } = makeFetch((url) =>
    url.endsWith('/core/health') ? okJson(HEALTH) : okJson(HELLO),
  );
  const handle = await obtainCore({ ...BASE_OPTS, endpoint: 'http://127.0.0.1:54321/', fetchImpl: impl });
  assert.strictEqual(handle.mode, 'attached');
  assert.strictEqual(handle.coreId, 'core-1');
  assert.strictEqual(handle.epoch, 3);
  assert.deepStrictEqual(calls.map((c) => c.url), ['http://127.0.0.1:54321/core/health', 'http://127.0.0.1:54321/core/hello']);
  await assert.rejects(() => handle.gateway.generate({ prompt: 'x' }), (err) => err instanceof CoreError && err.code === 'CORE_UNAVAILABLE');
  await handle.close();
  await handle.close();
});

test('无显式坐标时回落到用户显式 env', async () => {
  const { impl } = makeFetch((url) => (url.endsWith('/core/health') ? okJson(HEALTH) : okJson(HELLO)));
  const handle = await obtainCore({
    ...BASE_OPTS,
    env: { KHY_CORE_ENDPOINT: 'http://127.0.0.1:9' },
    fetchImpl: impl,
  });
  assert.strictEqual(handle.coreId, 'core-1');
});

test('suite 注入验活通过时直接返回注入句柄（不发起任何 fetch）', async () => {
  const injected = {
    version: { protocol: 1 },
    capabilities: { list: async () => [] },
  };
  globalThis[SUITE_INJECTION_KEY] = injected;
  try {
    const { impl, calls } = makeFetch(() => okJson(HEALTH));
    const handle = await obtainCore({ ...BASE_OPTS, fetchImpl: impl });
    assert.strictEqual(handle, injected);
    assert.strictEqual(calls.length, 0);
  } finally {
    delete globalThis[SUITE_INJECTION_KEY];
  }
});

test('注入句柄验活失败：告警后继续走 locator 发现', async () => {
  const warnings = [];
  const { impl } = makeFetch((url) => (url.endsWith('/core/health') ? okJson(HEALTH) : okJson(HELLO)));
  const handle = await obtainCore({
    ...BASE_OPTS,
    onWarning: (m) => warnings.push(m),
    locator: { coreId: 'core-1', protocolVersion: 1, pid: 4321, endpoint: 'http://127.0.0.1:54321', epoch: 3, coreVersion: '0.1.0' },
    fetchImpl: impl,
  });
  assert.strictEqual(handle.coreId, 'core-1');
  assert.strictEqual(warnings.length, 0);
});

test('指纹不符：CORE_PROTOCOL_MISMATCH 且终止（不 hello、不回退 embedded）', async () => {
  const { impl, calls } = makeFetch((url) => okJson({ ...HEALTH, pid: 9999 }));
  await assert.rejects(
    () =>
      obtainCore({
        ...BASE_OPTS,
        locator: { coreId: 'core-1', protocolVersion: 1, pid: 4321, endpoint: 'http://127.0.0.1:54321', epoch: 3, coreVersion: '0.1.0' },
        fetchImpl: impl,
      }),
    (err) => err instanceof CoreError && err.code === 'CORE_PROTOCOL_MISMATCH' && /另起核心/.test(err.message),
  );
  assert.strictEqual(calls.length, 1);
});

test('无任何坐标：浏览器侧报 CORE_LOCATOR_FAILED（不 spawn）', async () => {
  await assert.rejects(
    () => obtainCore({ ...BASE_OPTS, fetchImpl: async () => okJson(HEALTH) }),
    (err) => err instanceof CoreError && err.code === 'CORE_LOCATOR_FAILED',
  );
});

test('health 网络失败：CORE_UNAVAILABLE 且 retryable', async () => {
  const { impl } = makeFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  await assert.rejects(
    () => obtainCore({ ...BASE_OPTS, endpoint: 'http://127.0.0.1:1', fetchImpl: impl }),
    (err) => err instanceof CoreError && err.code === 'CORE_UNAVAILABLE' && err.retryable === true,
  );
});

test('缺 terminalId/clientVersion：CORE_INVALID_ARGUMENT', async () => {
  await assert.rejects(
    () => obtainCore({ clientVersion: '0.1.0', fetchImpl: async () => okJson(HEALTH) }),
    (err) => err instanceof CoreError && err.code === 'CORE_INVALID_ARGUMENT',
  );
});
