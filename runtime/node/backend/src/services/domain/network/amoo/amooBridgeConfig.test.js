'use strict';

// Co-located unit test for amooBridgeConfig.js.
//
// The config leaf is the single source of every port, path and timeout this unit
// uses, so the cases here pin three things that would otherwise drift silently:
//   1. env overrides win and garbage values fall back instead of throwing,
//   2. the loopback URL is ASSEMBLED (no host:port literal in the file, which is
//      what keeps the no-hardcoded-endpoint gate honest),
//   3. the measured device defaults (8896, /sdcard/bridge-amoobridge, the Amoo
//      component/action) are the ones actually observed on the phone.

const test = require('node:test').test;
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function pinSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-amoo-cfg-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.KHY_DATA_HOME = path.join(root, 'data');
  process.env.KHY_PROJECT_DATA_HOME = path.join(root, 'project-data');
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  // Start from a clean env: a leftover KHY_AMOO_* from another test file in the
  // same process would silently change every default below.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KHY_AMOO_')) {
      delete process.env[key];
    }
  }
  return root;
}

pinSandbox();

const { resolveAmooConfig, buildLoopbackUrl, DEFAULTS, AMOO_ACTIVITY } = require('./amooBridgeConfig');

test('defaults match the measured device', () => {
  const config = resolveAmooConfig({});
  // 空默认：未设 env 时 serial 为空、serialSource 为 default，强制 IO 层走自动探测。
  assert.equal(config.adb.serial, '');
  assert.equal(config.adb.serialSource, 'default');
  assert.equal(config.adb.connectHost, '');
  assert.equal(config.adb.serial, DEFAULTS.DEVICE_SERIAL);
  assert.equal(config.adb.connectPort, DEFAULTS.CONNECT_PORT);
  assert.equal(config.bridge.port, DEFAULTS.BRIDGE_PORT);
  assert.equal(config.bridge.aliasPort, DEFAULTS.BRIDGE_ALIAS_PORT);
  assert.equal(config.bridge.tokenPath, '/sdcard/bridge-amoobridge/token.txt');
  assert.equal(config.bridge.dir, '/sdcard/bridge-amoobridge');
  assert.equal(config.amoo.component, 'com.stepos.ailauncher/.chat.activity.ChatMainActivity');
  assert.equal(config.amoo.launchAction, 'com.stepos.ailauncher.action.OPEN_CHAT');
  assert.equal(config.amoo.inputId, 'com.stepos.ailauncher:id/et_input_bar');
  assert.equal(config.amoo.sendId, 'com.stepos.ailauncher:id/btn_text_send');
  assert.equal(config.amoo.chatListId, 'com.stepos.ailauncher:id/chat_list');
  assert.equal(AMOO_ACTIVITY, '.chat.activity.ChatMainActivity');
  assert.equal(config.adb.path, null);
  assert.equal(config.adb.pathSource, 'default');
});

test('the loopback URL is assembled, never pinned as a literal', () => {
  assert.equal(buildLoopbackUrl('127.0.0.1', 8896), 'http://127.0.0.1:8896');
  assert.equal(buildLoopbackUrl('10.0.0.5', '3000'), 'http://10.0.0.5:3000');
  const config = resolveAmooConfig({});
  assert.equal(config.bridge.baseUrl, 'http://127.0.0.1:8896');
  assert.equal(config.bridge.transport, 'forward');
});

test('env overrides win and are recorded as env provenance', () => {
  const config = resolveAmooConfig({
    KHY_AMOO_DEVICE_SERIAL: '192.168.2.99:5555',
    KHY_AMOO_BRIDGE_PORT: '9911',
    KHY_AMOO_ADB_PATH: '/opt/platform-tools/adb',
    KHY_AMOO_POLL_INTERVAL_MS: '1500',
  });
  assert.equal(config.adb.serial, '192.168.2.99:5555');
  assert.equal(config.adb.connectHost, '192.168.2.99');
  assert.equal(config.bridge.port, 9911);
  assert.equal(config.adb.path, '/opt/platform-tools/adb');
  assert.equal(config.dispatch.pollIntervalMs, 1500);
  assert.equal(config.sources.serial, 'env');
  assert.equal(config.sources.bridgePort, 'env');
  assert.equal(config.sources.adbPath, 'env');
});

test('garbage env values fall back to the default and say so', () => {
  const config = resolveAmooConfig({
    KHY_AMOO_BRIDGE_PORT: 'not-a-port',
    KHY_AMOO_POLL_MAX_ROUNDS: '-4',
    KHY_AMOO_ADB_TIMEOUT_MS: '99999999',
    KHY_AMOO_POLL_INTERVAL_MS: '   ',
  });
  assert.equal(config.bridge.port, DEFAULTS.BRIDGE_PORT);
  assert.equal(config.sources.bridgePort, 'default-invalid');
  assert.equal(config.dispatch.pollMaxRounds, DEFAULTS.POLL_MAX_ROUNDS);
  assert.equal(config.adb.timeoutMs, DEFAULTS.ADB_TIMEOUT_MS);
  assert.equal(config.dispatch.pollIntervalMs, DEFAULTS.POLL_INTERVAL_MS);
});

test('pollMaxIntervalMs never drops below pollIntervalMs', () => {
  const config = resolveAmooConfig({
    KHY_AMOO_POLL_INTERVAL_MS: '9000',
    KHY_AMOO_POLL_MAX_INTERVAL_MS: '1000',
  });
  assert.equal(config.dispatch.pollIntervalMs, 9000);
  assert.equal(config.dispatch.pollMaxIntervalMs, 9000);
});

test('lan transport targets the device host, forward targets loopback', () => {
  const lan = resolveAmooConfig({
    KHY_AMOO_BRIDGE_TRANSPORT: 'lan',
    KHY_AMOO_DEVICE_SERIAL: '192.168.2.46:33743',
  });
  assert.equal(lan.bridge.transport, 'lan');
  assert.equal(lan.bridge.baseUrl, 'http://192.168.2.46:8896');
  const fwd = resolveAmooConfig({ KHY_AMOO_BRIDGE_TRANSPORT: 'forward' });
  assert.equal(fwd.bridge.baseUrl, 'http://127.0.0.1:8896');
  // lan 但 serial 为空（未探测到设备）：baseUrl 留空串，不拼出 `http://:8896`。
  const lanNoSerial = resolveAmooConfig({ KHY_AMOO_BRIDGE_TRANSPORT: 'lan' });
  assert.equal(lanNoSerial.bridge.baseUrl, '');
  assert.equal(lanNoSerial.adb.connectHost, '');
});

test('gates default on and are readable by name', () => {
  assert.equal(resolveAmooConfig({}).gates.enabled, true);
  assert.equal(resolveAmooConfig({}).gates.mailboxEnabled, true);
  const off = resolveAmooConfig({ KHY_AMOO_BRIDGE_ENABLED: '0' });
  assert.equal(off.gates.enabled, false);
  const on = resolveAmooConfig({ KHY_AMOO_MAILBOX_ENABLED: 'yes' });
  assert.equal(on.gates.mailboxEnabled, true);
  const bogus = resolveAmooConfig({ KHY_AMOO_BRIDGE_ENABLED: 'maybe' });
  // envFlagByName semantics: an unknown value is false, not the fallback.
  assert.equal(bogus.gates.enabled, false);
});

test('resolveAmooConfig reads process.env when no env is passed', () => {
  process.env.KHY_AMOO_BRIDGE_PORT = '7777';
  const config = resolveAmooConfig();
  assert.equal(config.bridge.port, 7777);
  delete process.env.KHY_AMOO_BRIDGE_PORT;
  assert.equal(resolveAmooConfig().bridge.port, DEFAULTS.BRIDGE_PORT);
});
