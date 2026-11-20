'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { obtainCoreNode } = require('@khy/core/locator-host');
const { CoreError } = require('@khy/core/contracts');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khy-core-order-'));
}

const HEALTH = {
  status: 'ok', coreId: 'core-1', protocolVersion: 1, pid: 4321, port: 54321, epoch: 1,
  coreVersion: '0.1.0', uptimeMs: 0, capabilities: [],
};
const HELLO = {
  coreId: 'core-1', coreVersion: '0.1.0', protocolVersion: 1, enginesKhy: '>=1.0.0 <2.0.0', epoch: 1,
  capabilities: [], paths: {}, sessionToken: 'tok', expiresAt: 99,
};
const fetchImpl = async (url) => ({
  ok: true,
  json: async () => (url.endsWith('/core/health') ? HEALTH : HELLO),
});

const fakeServer = {
  createCoreServer: async (options) => {
    if (!options || !options.dataHome) throw new Error('fakeServer 需要 dataHome');
    return { port: 0, start: async () => {}, close: async () => {} };
  },
};

// 四段定位顺序（[DESIGN-ARCH-220] §10.2 表）：沙箱全在临时目录，无工作树相对路径可用。
test('显式注入命中且失败即报：不静默回退到 bundled/node_modules', async () => {
  const handle = await obtainCoreNode({
    terminalId: 'test', clientVersion: '0.1.0', mode: 'embedded',
    entry: fakeServer, paths: { dataHome: tempHome() }, allowSpawn: true,
  });
  assert.strictEqual(handle.mode, 'embedded');
  await handle.close();
  await assert.rejects(
    () => obtainCoreNode({ terminalId: 't', clientVersion: '0.1.0', mode: 'embedded', entry: 'Z:/no/such.js', bundledEntry: fakeServer, paths: { dataHome: tempHome() }, allowSpawn: true }),
    (err) => err instanceof CoreError && err.code === 'CORE_LOCATOR_FAILED',
  );
});

test('bundled 入口命中：entry 缺省时用宿主传入模块', async () => {
  const home = tempHome();
  const handle = await obtainCoreNode({
    terminalId: 'test', clientVersion: '0.1.0', mode: 'embedded',
    bundledEntry: fakeServer, paths: { dataHome: home }, allowSpawn: true,
  });
  assert.ok(fs.existsSync(path.join(home, 'core', 'core.lock')), 'embedded 必须落锁');
  assert.ok(fs.existsSync(path.join(home, 'core', 'locator.json')), 'embedded 必须写 locator');
  await handle.close();
  assert.strictEqual(fs.existsSync(path.join(home, 'core', 'core.lock')), false, 'close 释放锁');
});

// S4 真实集成：定位器 + 真 core server + 宿主注入成员，三段拼起来跑通。
// 宿主注入的 gateway 经 B1 createGateway() 造（core 永不 import backend）。
test('embedded 真 server：注入的 gateway 直调可达，未注入成员报 member-pending', async () => {
  const home = tempHome();
  const handle = await obtainCoreNode({
    terminalId: 'test', clientVersion: '0.1.0', mode: 'embedded',
    entry: require('@khy/core/server'),
    members: { gateway: { generate: async () => ({ text: 'pong' }) } },
    paths: { dataHome: home },
    allowSpawn: true,
  });
  try {
    assert.strictEqual(handle.mode, 'embedded');
    const out = await handle.gateway.generate({ prompt: 'ping' });
    assert.strictEqual(out.text, 'pong');
    await assert.rejects(
      () => handle.session.create({ cwd: 'D:/w', terminalId: 'test' }),
      (err) => err instanceof CoreError && err.code === 'CORE_UNAVAILABLE' && err.details.reason === 'member-pending',
    );

    // 第二实例：locator 已在，先试 attach 成功 → 转 attached，不起第二个核心
    // （[DESIGN-ARCH-220] §4.4「抢不到锁且持锁者新鲜 → 转 attach，不 spawn」）。
    const second = await obtainCoreNode({
      terminalId: 't2', clientVersion: '0.1.0', mode: 'embedded',
      entry: require('@khy/core/server'),
      members: { gateway: { generate: async () => ({ text: 'x' }) } },
      paths: { dataHome: home },
      allowSpawn: true,
    });
    assert.strictEqual(second.mode, 'attached', '第二实例应转 attach 而非起新核心');
    assert.strictEqual(second.coreId, handle.coreId, '应连到同一个核心');
  } finally {
    await handle.close();
  }
  assert.strictEqual(fs.existsSync(path.join(home, 'core', 'core.lock')), false, 'close 释放锁');
});

test('三段全无：CORE_LOCATOR_FAILED 且文案三段齐全', async () => {
  await assert.rejects(
    () =>
      obtainCoreNode({
        terminalId: 'test', clientVersion: '0.1.0', mode: 'embedded',
        nodeModulesCwd: tempHome(), paths: { dataHome: tempHome() }, allowSpawn: true,
      }),
    (err) =>
      err instanceof CoreError &&
      err.code === 'CORE_LOCATOR_FAILED' &&
      err.message.includes('CORE_LOCATOR_FAILED') &&
      /bundledEntry/.test(err.message),
  );
});

test('attached：mode=attached 走 client 发现，不起锁', async () => {
  const handle = await obtainCoreNode({
    terminalId: 'test', clientVersion: '0.1.0', mode: 'attached',
    endpoint: 'http://127.0.0.1:54321', fetchImpl,
  });
  assert.strictEqual(handle.mode, 'attached');
  assert.strictEqual(handle.coreId, 'core-1');
});
