'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CoreError } = require('./contracts/errors');
const {
  readLocatorFile,
  writeLocatorFile,
  acquireLock,
  heartbeatLock,
  releaseLock,
  isAlive,
  resolveEmbedded,
} = require('./locator-host');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khy-core-loc-'));
}

const selfLock = () => ({
  coreId: 'core-self',
  pid: process.pid,
  port: 54321,
  host: '127.0.0.1',
  tokenHash: 'sha256:x',
  protocolVersion: 1,
  coreVersion: '0.1.0',
  epoch: 0,
  startedAt: Date.now(),
  heartbeatAt: Date.now(),
});

test('本文件至少 require 一个 node: 内置（防退化成空壳）', () => {
  const src = fs.readFileSync(__filename.replace(/\.test\.js$/, '.js'), 'utf8');
  assert.match(src, /require\('node:/);
});

test('isAlive：当前进程为活', () => {
  assert.strictEqual(isAlive(process.pid), true);
});

test('locator 读写：epoch 只进不退', () => {
  const home = tempHome();
  const base = {
    coreId: 'core-1',
    protocolVersion: 1,
    pid: 4321,
    endpoint: 'http://127.0.0.1:54321',
    epoch: 3,
    coreVersion: '0.1.0',
  };
  assert.strictEqual(writeLocatorFile(home, base), true);
  assert.strictEqual(readLocatorFile(home).epoch, 3);
  assert.strictEqual(writeLocatorFile(home, { ...base, epoch: 2 }), false);
  assert.strictEqual(writeLocatorFile(home, { ...base, epoch: 4 }), true);
  assert.strictEqual(readLocatorFile(home).epoch, 4);
});

test('锁：新鲜持锁者拒绝第二实例（CORE_LOCKED，文案含 PID/端口/epoch）', async () => {
  const home = tempHome();
  await acquireLock(home, selfLock(), { staleConfirmMs: 0 });
  await assert.rejects(
    () => acquireLock(home, { ...selfLock(), coreId: 'core-other' }, { staleConfirmMs: 0 }),
    (err) =>
      err instanceof CoreError &&
      err.code === 'CORE_LOCKED' &&
      /PID \d+/.test(err.message) &&
      /端口 \d+/.test(err.message) &&
      /epoch 0/.test(err.message),
  );
  assert.strictEqual(releaseLock(home, selfLock()), true);
  assert.strictEqual(releaseLock(home, selfLock()), false);
});

test('锁：stale 锁二次确认后接管，epoch+1 且旧锁留档', async () => {
  const home = tempHome();
  const dead = { ...selfLock(), coreId: 'core-dead', pid: 2147483647, heartbeatAt: Date.now() - 60000 };
  fs.mkdirSync(path.join(home, 'core'), { recursive: true });
  fs.writeFileSync(path.join(home, 'core', 'core.lock'), JSON.stringify(dead));
  const taken = await acquireLock(home, selfLock(), { staleConfirmMs: 0 });
  assert.strictEqual(taken.epoch, dead.epoch + 1);
  const leftovers = fs.readdirSync(path.join(home, 'core')).filter((f) => f.startsWith('core.lock.stale.'));
  assert.strictEqual(leftovers.length, 1);
});

test('心跳：coreId 不符即 CORE_TAKEN_OVER；相符则刷新', async () => {
  const home = tempHome();
  const lock = await acquireLock(home, selfLock(), { staleConfirmMs: 0 });
  // heartbeatLock 是同步抛：包一层 async 让 assert.rejects 收到 rejection 而不是同步炸出
  await assert.rejects(
    async () => heartbeatLock(home, { ...lock, coreId: 'core-other' }),
    (err) => err instanceof CoreError && err.code === 'CORE_TAKEN_OVER',
  );
  await new Promise((r) => setTimeout(r, 5));
  heartbeatLock(home, lock);
  const after = JSON.parse(fs.readFileSync(path.join(home, 'core', 'core.lock'), 'utf8'));
  assert.ok(after.heartbeatAt >= lock.heartbeatAt);
});

test('resolveEmbedded：显式注入优先且失败即报，不回退；全无则 CORE_LOCATOR_FAILED 三段', () => {
  const fake = { createCoreServer: () => ({}) };
  assert.strictEqual(resolveEmbedded({ entry: fake }).source, 'explicit');
  assert.strictEqual(resolveEmbedded({ entry: fake, bundledEntry: { createCoreServer: () => ({}) } }).source, 'explicit');
  assert.throws(
    () => resolveEmbedded({ entry: 'Z:/definitely/not/here.js', bundledEntry: fake }),
    (err) => err instanceof CoreError && err.code === 'CORE_LOCATOR_FAILED',
  );
  assert.throws(
    () => resolveEmbedded({ nodeModulesCwd: fs.mkdtempSync(path.join(os.tmpdir(), 'khy-core-empty-')) }),
    (err) =>
      err instanceof CoreError &&
      err.code === 'CORE_LOCATOR_FAILED' &&
      /三段定位均未命中/.test(err.message) &&
      /bundledEntry/.test(err.message),
  );
});
