'use strict';

/**
 * index.test.js — co-located suite for the phone bridge facade.
 *
 * The facade's whole job is: one import point, no module-load side effects, and
 * a lazily built singleton that never resolves env or touches the device just
 * because something required the directory.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const childProcess = require('child_process');
const REAL_SPAWN = childProcess.spawn;
childProcess.spawn = function throwingSpawn() {
  throw new Error('index.test.js: require 阶段就 spawn adb —— facade 不得有装载期副作用');
};

const facade = require('./index');

test('facade 聚齐四个模块的面，且 key 不重不漏', () => {
  const config = require('./phoneBridgeConfig');
  const policy = require('./phoneBridgePolicy');
  const catalog = require('./phoneBridgeCatalog');
  for (const mod of [config, policy, catalog]) {
    for (const key of Object.keys(mod)) {
      assert.ok(Object.prototype.hasOwnProperty.call(facade, key), `facade 缺 ${key}`);
    }
  }
  for (const key of ['createPhoneBridgeClient', 'createPhoneBridgeMailbox',
    'getPhoneBridgeClient', 'resetPhoneBridgeForTests']) {
    assert.equal(typeof facade[key], 'function', key);
  }
});

test('重名导出指向同一个函数，不存在两份真相', () => {
  const catalog = require('./phoneBridgeCatalog');
  assert.equal(facade.isPhoneBridgeToolName, catalog.isPhoneBridgeToolName);
  assert.equal(facade.resolveBridgeToolName, catalog.resolveBridgeToolName);
});

test('require facade 不 spawn adb、不解析 env、不建客户端', () => {
  // 若 facade 在装载期就 createPhoneBridgeClient，上面那个 throwing spawn 会炸。
  assert.equal(typeof facade.resolvePhoneBridgeConfig, 'function');
  // 单例尚未建立：getPhoneBridgeClient 才是建立点
  assert.equal(facade.resetPhoneBridgeForTests(), undefined);
});

test('getPhoneBridgeClient 惰性建立，且同 env 下复用同一实例', () => {
  const first = facade.getPhoneBridgeClient({});
  const second = facade.getPhoneBridgeClient({});
  assert.equal(first, second);
  assert.equal(typeof first.ping, 'function');
  assert.equal(first.config.httpPort, 8896);
  assert.equal(first.config.baseUrl, 'http://127.0.0.1:8896');
  facade.resetPhoneBridgeForTests();
});

test('resetPhoneBridgeForTests 之后重新取到的是新实例', () => {
  const first = facade.getPhoneBridgeClient({});
  facade.resetPhoneBridgeForTests();
  const second = facade.getPhoneBridgeClient({});
  assert.notEqual(first, second);
  facade.resetPhoneBridgeForTests();
});

test('单例的状态可查，且不含 token', () => {
  const c = facade.getPhoneBridgeClient({});
  const state = c.getState();
  assert.equal(state.serial, '192.168.2.46:33743');
  assert.equal(state.httpPort, 8896);
  assert.equal(state.tokenLoaded, false);
  assert.equal(state.enabled, true);
  facade.resetPhoneBridgeForTests();
});

test('facade 上的纯判定函数不依赖手机就能用', () => {
  assert.equal(facade.classifyBridgeCall('battery', {}).requiresConfirm, false);
  assert.equal(facade.classifyBridgeCall('exec', { cmd: 'id' }).requiresConfirm, true);
  // 31 = 25 基础桥工具 + 3 个循环控制 + 3 个反代与共享记忆。
  // 25 里含 2026 新增的设备控制三件套 volume / brightness / vibrate——Android 侧
  // Tools.java 已按同名 tool 分派实现，故 31 是真实基线，不是超前声明。
  // 这条是道闸：桥的工具面长胖了而目录没跟上，调用侧就会拿旧清单做准入判断。
  assert.equal(facade.listKhyToolDefinitions().length, 31);
  assert.equal(facade.resolvePhoneBridgeConfig({}).mailboxDir, '/sdcard/bridge-amoobridge');
});

test('收尾：还原 child_process.spawn', () => {
  childProcess.spawn = REAL_SPAWN;
  assert.equal(typeof childProcess.spawn, 'function');
});
