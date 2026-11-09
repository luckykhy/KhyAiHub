'use strict';

/**
 * phoneLinkSource.test.js — CC 手机联动供数器工厂的装载期零副作用断言（node:test）。
 *
 * 锁三件事：
 *   ① **require 本模块不加载 amoo / phone 两棵栈** —— 面板没打开过，启动路径里
 *      就不该出现那两棵模块图，更不该有 adb；
 *   ② 第一次 getPhoneLinkProvider() 才建 provider，且**零 spawn**（构造器零副作用，
 *      refresh() 才碰设备）；
 *   ③ 任一步不可用 → 返回 null 并记住（fail-soft），面板降级成「尚未读取」，
 *      绝不让 CC 模式启动失败。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const AMOO_PATH = path.join(SRC, 'services', 'domain', 'network', 'amoo', 'index.js');
const PHONE_PATH = path.join(SRC, 'services', 'domain', 'network', 'phone', 'index.js');
const SOURCE_PATH = path.join(__dirname, '..', '..', '..', 'src', 'cli', 'tui', 'ccPhoneLinkSource.js');

function loaded(modPath) {
  return Object.prototype.hasOwnProperty.call(require.cache, require.resolve(modPath));
}

test('装载期零副作用：require 工厂不加载 amoo / phone 栈', () => {
  assert.equal(loaded(AMOO_PATH), false, 'amoo 栈不该在 require 工厂时被加载');
  assert.equal(loaded(PHONE_PATH), false, 'phone 栈不该在 require 工厂时被加载');
  const mod = require(SOURCE_PATH);
  assert.equal(typeof mod.getPhoneLinkProvider, 'function');
  assert.equal(loaded(AMOO_PATH), false, 'require 之后 amoo 栈仍不该被加载');
  assert.equal(loaded(PHONE_PATH), false, 'require 之后 phone 栈仍不该被加载');
});

test('第一次调用才建 provider，且构造期零 spawn', () => {
  const mod = require(SOURCE_PATH);
  mod.resetPhoneLinkProviderForTests();

  const spawnAttempts = [];
  const fakeAmoo = {
    runner: { collectStatus: () => ({ ok: true }) },
    AmooStatusProvider: class {
      constructor(opts) {
        this.opts = opts;
        spawnAttempts.push('ctor');
      }
      getSnapshot() { return { state: 'idle', model: null }; }
      refresh() { return Promise.resolve(null); }
      onChange() { return () => {}; }
    },
  };
  const fakePhone = {
    getPhoneBridgeClient: () => ({ probe: () => Promise.resolve({ ok: true }) }),
  };

  const provider = mod.getPhoneLinkProvider({ amoo: fakeAmoo, phone: fakePhone });
  assert.ok(provider, '应建出 provider');
  assert.deepEqual(spawnAttempts, ['ctor'], '只该构造一次，且不该 spawn 任何子进程');
  assert.equal(provider.opts.runner, fakeAmoo.runner);
  assert.ok(provider.opts.liveness, 'liveness 应接上（忙位期间的心跳源）');
  assert.equal(typeof provider.opts.ttlMs, 'number');
  assert.ok(provider.opts.ttlMs > 0);

  // 单例：第二次拿到同一个。
  assert.equal(mod.getPhoneLinkProvider({ amoo: fakeAmoo, phone: fakePhone }), provider);
  assert.deepEqual(spawnAttempts, ['ctor']);
});

test('amoo 栈不可用 → null（fail-soft，不抛）', () => {
  const mod = require(SOURCE_PATH);
  mod.resetPhoneLinkProviderForTests();
  assert.equal(mod.getPhoneLinkProvider({ amoo: {}, phone: {} }), null);
  // 记住坏状态：不再反复尝试加载。
  assert.equal(mod.getPhoneLinkProvider({ amoo: {}, phone: {} }), null);
});

test('require 抛错 → null（fail-soft，不抛）', () => {
  const mod = require(SOURCE_PATH);
  mod.resetPhoneLinkProviderForTests();
  const boom = {
    get AmooStatusProvider() {
      throw new Error('module graph broken');
    },
  };
  assert.equal(mod.getPhoneLinkProvider({ amoo: boom, phone: {} }), null);
});

test('轮询间隔唯一真源是 utils/ccTimers 的 TIMING.mcp.interval', () => {
  const { TIMING } = require('../../../src/cli/tui/utils/ccTimers');
  const mod = require(SOURCE_PATH);
  assert.equal(mod.PHONE_LINK_INTERVAL_MS, TIMING.mcp.interval);
});
