'use strict';

/**
 * hiaoBridgeConfig.test.js — co-located suite for the hiao profile config leaf.
 *
 * IO: none. The adb probe is injected (returns false), so no candidate is ever
 * stat'ed and nothing here touches the device.
 *
 * Pinned facts come from phone-dsh docs/AMOO-INTEGRATION.md: the bridge listens
 * on 8898 inside the phone and is forwarded to a PC port (default 18998); the
 * pairing token lives at /sdcard/hiao/token.txt; /call blocks on a human
 * approval with a 600s upstream ceiling.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const config = require('./hiaoBridgeConfig');

const NO_PROBE = { hasExecutable: () => false };

test('默认值与 protocol 文档一致（端口 / 转发口 / 超时 / 令牌落点）', () => {
  const resolved = config.resolveHiaoBridgeConfig({}, NO_PROBE);
  assert.equal(resolved.devicePort, 8898);
  assert.equal(resolved.forwardPort, 18998);
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:18998');
  assert.equal(resolved.tokenRemotePath, '/sdcard/hiao/token.txt');
  assert.equal(resolved.httpTimeoutMs, 45000);
  assert.equal(resolved.callTimeoutMs, 660000);
  assert.equal(resolved.serial, '');
  assert.match(resolved.adbExecutable, /^adb(\.exe)?$/);
});

test('callTimeoutMs 默认高于上游审批截止（600s），否则审批等待会被提前砍断', () => {
  const resolved = config.resolveHiaoBridgeConfig({}, NO_PROBE);
  assert.ok(resolved.callTimeoutMs > config.HIAO_APPROVAL_CEILING_MS);
  assert.equal(config.HIAO_APPROVAL_CEILING_MS, 600000);
});

test('显式配置的 /call 超时低于审批截止时向上夹到 600s', () => {
  assert.equal(config.resolveCallTimeoutMs({ KHY_HIAO_BRIDGE_CALL_TIMEOUT_MS: '45000' }), 600000);
  // 高于截止的值原样尊重（用户可能想给慢设备留更多余量）。
  assert.equal(config.resolveCallTimeoutMs({ KHY_HIAO_BRIDGE_CALL_TIMEOUT_MS: '900000' }), 900000);
});

test('env 覆盖端口、令牌路径与 GET 超时', () => {
  const env = {
    KHY_HIAO_BRIDGE_DEVICE_PORT: '9001',
    KHY_HIAO_BRIDGE_FORWARD_PORT: '20000',
    KHY_HIAO_BRIDGE_TOKEN_PATH: '/sdcard/custom/tok.txt',
    KHY_HIAO_BRIDGE_HTTP_TIMEOUT_MS: '5000',
  };
  const resolved = config.resolveHiaoBridgeConfig(env, NO_PROBE);
  assert.equal(resolved.devicePort, 9001);
  assert.equal(resolved.forwardPort, 20000);
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:20000');
  assert.equal(resolved.tokenRemotePath, '/sdcard/custom/tok.txt');
  assert.equal(resolved.httpTimeoutMs, 5000);
});

test('端口越界或非数字一律回退默认值，不拼出一个坏端口', () => {
  for (const bad of ['0', '-1', '70000', 'abc', '']) {
    assert.equal(config.resolveDevicePort({ KHY_HIAO_BRIDGE_DEVICE_PORT: bad }), 8898, bad);
    assert.equal(config.resolveForwardPort({ KHY_HIAO_BRIDGE_FORWARD_PORT: bad }), 18998, bad);
  }
});

test('loopback baseUrl 由端口插值拼出，不出现写死端口的第二份', () => {
  assert.equal(config.resolveHiaoBridgeConfig({}, NO_PROBE).baseUrl, 'http://127.0.0.1:18998');
  const custom = config.resolveHiaoBridgeConfig({ KHY_HIAO_BRIDGE_FORWARD_PORT: '12345' }, NO_PROBE);
  assert.equal(custom.baseUrl, 'http://127.0.0.1:12345');
});

test('adb 探针注入生效；KHY_PHONE_BRIDGE_ADB 显式值优先且不经过探针', () => {
  const hit = path.join('C:', 'sdk', 'platform-tools', 'adb.exe');
  const probe = (candidate) => candidate === hit;
  const resolved = config.resolveHiaoBridgeConfig(
    { PATH: path.join('C:', 'sdk', 'platform-tools') },
    { hasExecutable: probe }
  );
  assert.equal(resolved.adbExecutable, hit);

  const explicit = path.join('D:', 'tools', 'my-adb');
  const withEnv = config.resolveHiaoBridgeConfig(
    { KHY_PHONE_BRIDGE_ADB: `  ${explicit}  ` },
    { hasExecutable: () => { throw new Error('probe must not run'); } }
  );
  assert.equal(withEnv.adbExecutable, explicit);
});

test('serial 经 phone 门面取：env 优先，其次注入的探测结果', () => {
  assert.equal(config.resolveHiaoBridgeConfig({ KHY_PHONE_BRIDGE_SERIAL: ' AAA ' }, NO_PROBE).serial, 'AAA');
  assert.equal(config.resolveHiaoBridgeConfig({}, { hasExecutable: () => false, detectedSerial: 'BBB' }).serial, 'BBB');
  assert.equal(config.resolveHiaoBridgeConfig({}, NO_PROBE).serial, '');
});

test('本 profile 不设 on/off 门：配置里没有 enabled 键，也不读开关型 env', () => {
  // The contract is explicit: hiao ships no enable switch, only the five
  // config keys. Capability is gated structurally by the pairing token. An
  // on/off flag would need a flagRegistry row owned by another batch, and one
  // switch must not grow a second truth source.
  const resolved = config.resolveHiaoBridgeConfig({}, NO_PROBE);
  assert.equal('enabled' in resolved, false);
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'isHiaoBridgeEnabled'), false);

  const src = fs.readFileSync(path.join(__dirname, 'hiaoBridgeConfig.js'), 'utf8');
  assert.doesNotMatch(src, /KHY_HIAO_BRIDGE_ENABLED/);
  for (const key of [
    'adbExecutable',
    'serial',
    'devicePort',
    'forwardPort',
    'baseUrl',
    'tokenRemotePath',
    'httpTimeoutMs',
    'callTimeoutMs',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(resolved, key), true, key);
  }
});
