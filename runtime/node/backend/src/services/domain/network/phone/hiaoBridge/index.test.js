'use strict';

/**
 * index.test.js — co-located suite for the hiao bridge facade.
 *
 * The facade exists so consumers never reach a sibling. What matters here is
 * that it stays a lazy star-assembly: requiring it must not spawn adb or open a
 * socket, the client singleton must be resettable between tests, and nothing in
 * this unit rebuilds argv that the phone unit already owns.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bridge = require('./index');

test('门面导出装配函数、config 叶子与 policy 叶子', () => {
  for (const key of [
    'getHiaoBridgeClient',
    'resetHiaoBridgeForTests',
    'createHiaoBridgeClient',
    'resolveHiaoBridgeConfig',
    'classifyHiaoCall',
    'planHiaoCall',
    'classifyHiaoFailure',
    'HIAO_READONLY_TOOLS',
  ]) {
    assert.equal(typeof bridge[key] === 'function' || Array.isArray(bridge[key]), true, key);
  }
});

test('client 是惰性单例：同 env 两次取到同一个实例', () => {
  bridge.resetHiaoBridgeForTests();
  const first = bridge.getHiaoBridgeClient({});
  const second = bridge.getHiaoBridgeClient({});
  assert.equal(first, second);
  // 刚造出来的实例没有任何 IO 动作被打过。
  const state = first.getState();
  assert.equal(state.forwardReady, false);
  assert.equal(state.tokenReady, false);
  assert.equal(state.totalCalls, 0);
});

test('reset 之后拿到新实例，且旧实例的状态被清空', () => {
  bridge.resetHiaoBridgeForTests();
  const first = bridge.getHiaoBridgeClient({});
  bridge.resetHiaoBridgeForTests();
  const second = bridge.getHiaoBridgeClient({});
  assert.notEqual(first, second);
  assert.equal(second.getState().forwardReady, false);
});

test('没有单例时 reset 不抛', () => {
  bridge.resetHiaoBridgeForTests();
  assert.doesNotThrow(() => bridge.resetHiaoBridgeForTests());
});

test('门面 spread 的是同一份 config/policy 实现，不是副本', () => {
  const config = require('./hiaoBridgeConfig');
  const policy = require('./hiaoBridgePolicy');
  assert.equal(bridge.resolveHiaoBridgeConfig, config.resolveHiaoBridgeConfig);
  assert.equal(bridge.classifyHiaoFailure, policy.classifyHiaoFailure);
});

test('默认 env 下门面造出的 client 的默认旋钮与协议文档一致', () => {
  bridge.resetHiaoBridgeForTests();
  const client = bridge.getHiaoBridgeClient({});
  const state = client.getState();
  assert.equal(state.devicePort, 8898);
  assert.equal(state.callTimeoutMs, 660000);
  assert.equal(state.approvalCeilingMs, 600000);
});

test('不重写 argv：转发与读令牌用的就是 phone 门面构造器的输出', async () => {
  // The phone unit owns adb argv building. If this unit ever started stringing
  // its own 'forward'/'shell' argv, two profiles could disagree on serial
  // handling (buildAdbArgv's -s injection) without any guard noticing.
  const phoneFacade = require('../index');
  const config = {
    adbExecutable: 'adb',
    serial: 'SER-1',
    devicePort: 8898,
    forwardPort: 18998,
    baseUrl: 'http://127.0.0.1:18998',
    tokenRemotePath: '/sdcard/hiao/token.txt',
    httpTimeoutMs: 1234,
    callTimeoutMs: 660000,
  };
  const seen = [];
  const client = bridge.createHiaoBridgeClient({
    config,
    runAdb: async (argv) => {
      seen.push(argv);
      return { ok: true, code: 0, stdout: '54321\n', stderr: '' };
    },
    httpTransport: { request: async () => ({ status: 200, bodyText: '{"ok":true}', ok: true }) },
  });

  await client.ensureForward();
  await client.readToken(true);

  assert.deepEqual(seen[0], phoneFacade.buildForwardArgv(config, 0, config.devicePort));
  assert.deepEqual(seen[1], phoneFacade.buildStatusReadArgv(config, config.tokenRemotePath));
  // 门面构造器自己带 -s：本单元复用它的输出，就不可能漏掉多设备场景。
  assert.deepEqual(seen[0].slice(0, 2), ['-s', 'SER-1']);

  for (const file of ['hiaoBridgeClient.js', 'index.js', 'hiaoBridgeConfig.js']) {
    const code = fs.readFileSync(path.join(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    for (const literal of ["'forward'", "'shell'", "'cat'", "'connect'", "'exec-out'"]) {
      assert.equal(code.includes(literal), false, `${file} 不该本地拼接 ${literal}`);
    }
  }
});
