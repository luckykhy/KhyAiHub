'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createCoreServer } = require('./index');
const { CoreError } = require('../contracts/errors');

async function withServer(options, fn) {
  const server = createCoreServer(options);
  await server.start();
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

async function httpJson(url, body) {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// S4-minimal（[DESIGN-ARCH-220] §12 S4）：server 真起 loopback 临时端口 HTTP，
// /core/hello 与 /core/health 走契约 schema，六成员由宿主注入。

test('参数形状校验先行，坏参数 CORE_INVALID_ARGUMENT', () => {
  assert.throws(
    () => createCoreServer({ dataHome: '' }),
    (err) => err instanceof CoreError && err.code === 'CORE_INVALID_ARGUMENT' && /dataHome/.test(err.message),
  );
  assert.doesNotThrow(() => createCoreServer({ dataHome: null }));
});

test('start 起 loopback 临时端口；hello/health 两帧过 schema', async () => {
  await withServer({ dataHome: null }, async (server) => {
    const port = server.getPort();
    assert.ok(port > 0, '应绑到临时端口');

    const health = await httpJson(`http://127.0.0.1:${port}/core/health`);
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.json.status, 'ok');
    assert.strictEqual(health.json.protocolVersion, 1);
    assert.strictEqual(health.json.pid, process.pid);
    assert.strictEqual(health.json.port, port);

    const hello = await httpJson(`http://127.0.0.1:${port}/core/hello`, {
      protocolVersion: 1,
      clientVersion: '0.1.0',
      terminalId: 'test',
      required: ['gateway'],
    });
    assert.strictEqual(hello.status, 200);
    assert.strictEqual(hello.json.coreId, server.coreId);
    assert.ok(hello.json.sessionToken.length >= 32, 'sessionToken 应够长');
    assert.ok(hello.json.expiresAt > Date.now());

    // 未注入成员的六态：全部 missing（required 缺失在装配期报缺谁）
    const states = Object.fromEntries(hello.json.capabilities.map((c) => [c.id, c.state]));
    assert.strictEqual(states.gateway, 'missing');
    assert.strictEqual(states.session, 'missing');
  });
});

test('注入的成员在 health 里报 available', async () => {
  await withServer(
    { dataHome: null, members: { gateway: { generate: async () => ({ text: 'ok' }) } } },
    async (server) => {
      const health = await httpJson(`http://127.0.0.1:${server.getPort()}/core/health`);
      const states = Object.fromEntries(health.json.capabilities.map((c) => [c.id, c.state]));
      assert.strictEqual(states.gateway, 'available');
      assert.strictEqual(states.events, 'missing');
    },
  );
});

test('协议版本不符 → 400 CORE_PROTOCOL_MISMATCH（绝不回退放行）', async () => {
  await withServer({ dataHome: null }, async (server) => {
    const res = await httpJson(`http://127.0.0.1:${server.getPort()}/core/hello`, {
      protocolVersion: 99,
      clientVersion: '0.1.0',
      terminalId: 'test',
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.code, 'CORE_PROTOCOL_MISMATCH');
  });
});

test('未知端点 → 404 且带错误码', async () => {
  await withServer({ dataHome: null }, async (server) => {
    const res = await httpJson(`http://127.0.0.1:${server.getPort()}/core/nope`);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.json.code, 'CORE_INVALID_ARGUMENT');
  });
});

test('close 后端口释放（可重复 close）', async () => {
  const server = createCoreServer({ dataHome: null });
  await server.start();
  const port = server.getPort();
  await server.close();
  await assert.rejects(() => httpJson(`http://127.0.0.1:${port}/core/health`));
  await server.close();
});
