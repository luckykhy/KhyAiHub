'use strict';

// Co-located unit test for index.js (the unit facade).
//
// The facade's only job is wiring order and a test reset. What matters here:
//   - the default stack is built from process.env without touching the disk or
//     the phone at require time (a require must never dial a device),
//   - createAmooStack builds a fresh, fully wired stack with injected fakes,
//   - resetAmooForTests drops the cached token,
//   - the exported surface is the star assembly the siblings promise.

const test = require('node:test').test;
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function pinSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-amoo-idx-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.KHY_DATA_HOME = path.join(root, 'data');
  process.env.KHY_PROJECT_DATA_HOME = path.join(root, 'project-data');
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KHY_AMOO_')) {
      delete process.env[key];
    }
  }
  return root;
}

pinSandbox();

// The spawn tripwire is installed BEFORE the require: the client binds spawn at
// load time, so a later patch would silently miss it. Requiring this module must
// not dial a device.
const cp = require('node:child_process');
const REAL_SPAWN = cp.spawn;
let spawnAttempts = 0;
cp.spawn = function guardedSpawn(...args) {
  spawnAttempts += 1;
  throw new Error(`test isolation: spawn(${String(args[0])}) is not allowed at require time`);
};

const facade = require('./index');
const {
  AmooBridgeClient,
  AmooBridgeMailbox,
  AmooDispatchRunner,
  createAmooStack,
  resetAmooForTests,
  resolveAmooConfig,
  config,
  client,
  mailbox,
  runner,
  dataHome,
} = facade;

test('requiring the facade spawns nothing and touches nothing', () => {
  assert.equal(spawnAttempts, 0);
  // The default stack is wired from process.env, so its shape is assertable
  // without a device.
  assert.ok(config && typeof config === 'object');
  assert.equal(config.bridge.port, 8896);
  assert.equal(config.amoo.component, 'com.stepos.ailauncher/.chat.activity.ChatMainActivity');
});

test('the default singletons are the right classes and share one config', () => {
  assert.ok(client instanceof AmooBridgeClient);
  assert.ok(mailbox instanceof AmooBridgeMailbox);
  assert.ok(runner instanceof AmooDispatchRunner);
  // One config object, one wiring: the runner drives the same client the facade
  // exports, so a token fetched through the facade is visible to the runner.
  assert.equal(runner.client, client);
  assert.equal(runner.mailbox, mailbox);
  assert.equal(mailbox.client, client);
  assert.equal(client.config, config);
});

test('createAmooStack builds a fresh wired stack with injected fakes', () => {
  const spawned = [];
  const stack = createAmooStack({
    env: { KHY_AMOO_ADB_PATH: 'C:/fake/adb.exe', KHY_AMOO_BRIDGE_PORT: '9911' },
    spawnImpl: (file, argv) => {
      spawned.push(argv.slice());
      const child = new (require('node:events').EventEmitter)();
      child.stdout = new (require('node:events').EventEmitter)();
      child.stderr = new (require('node:events').EventEmitter)();
      setImmediate(() => child.emit('close', 0));
      return child;
    },
    sleep: async () => {},
    now: () => 0,
    getAppDataDir: (...segments) => path.join(os.tmpdir(), 'khy-amoo-facade', ...segments),
  });
  assert.equal(stack.config.bridge.port, 9911);
  assert.ok(stack.client instanceof AmooBridgeClient);
  assert.ok(stack.runner instanceof AmooDispatchRunner);
  assert.equal(stack.runner.client, stack.client);
  assert.equal(stack.runner.mailbox, stack.mailbox);
  // The injected spawn really is the one used.
  return stack.client.runAdb(['devices']).then((result) => {
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0], ['devices']);
    assert.equal(result.ok, true);
  });
});

test('createAmooStack honours a caller-supplied config object', () => {
  const custom = resolveAmooConfig({ KHY_AMOO_DEVICE_SERIAL: '10.0.0.9:5555' });
  const stack = createAmooStack({
    config: custom,
    spawnImpl: () => {
      throw new Error('not used');
    },
  });
  assert.equal(stack.config, custom);
  assert.equal(stack.client.config, custom);
  assert.equal(stack.config.adb.serial, '10.0.0.9:5555');
});

test('resetAmooForTests drops the cached token', async () => {
  // Seed the cache directly: no device call is needed to prove the reset.
  client._token = '5500fae8db41cd054f45ea8834198d30';
  client._tokenFetchedAt = Date.now();
  assert.equal(client.tokenMask(), '5500…8d30');
  const reset = resetAmooForTests();
  assert.equal(reset.ok, true);
  assert.equal(client.tokenMask(), '****');
  assert.equal(client._token, null);
});

test('the facade re-exports the leaves consumers need', () => {
  assert.equal(typeof resolveAmooConfig, 'function');
  assert.equal(typeof dataHome.getAppDataDir, 'function');
  // The pure leaves stay reachable through the package, not re-exported as
  // singletons (they have no state).
  assert.equal(typeof facade.AmooBridgeClient, 'function');
  assert.equal(typeof facade.AmooBridgeMailbox, 'function');
  assert.equal(typeof facade.AmooDispatchRunner, 'function');
});

test('the panel lane is exported as references, never as a live instance', () => {
  // A panel that is never opened must never have started a poll timer: the
  // provider is a class here, not a singleton built at require time.
  assert.equal(typeof facade.AmooStatusProvider, 'function');
  assert.equal(typeof facade.buildAmooPanelModel, 'function');
  assert.equal(Object.prototype.hasOwnProperty.call(facade, 'amooStatusProvider'), false);
  const provider = new facade.AmooStatusProvider({ runner: { collectStatus: async () => null } });
  assert.equal(provider.getSnapshot().state, 'idle');
});

test('the default stack honours the layer gate from process.env', () => {
  const off = createAmooStack({ env: { KHY_AMOO_BRIDGE_ENABLED: 'false' } });
  assert.equal(off.config.gates.enabled, false);
  const on = createAmooStack({ env: {} });
  assert.equal(on.config.gates.enabled, true);
});
