'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const gateway = require('./aiGateway');

// B1 网关工厂化（[DESIGN-ARCH-219] §10 / [DESIGN-ARCH-220] §12 S2）：
// module.exports 仍是默认单例（src 56 个调用方零改），createGateway(options) 造独立实例，
// 熔断/冷却状态按实例隔离——S3 desktop embedded 句柄与 B8 网关切分的前置。
// 注意：stream/abort/status/models/onStatus 当前不存在于本网关，属 S5 契约对齐范围，
// 本测试只断言今天真实存在的方法面（不拿设计稿的接口清单当现状）。

// 今天真实存在的方法面（原型方法 + 两个 B1 起挂原件的附件）。
const EXISTING_METHODS = ['generate', 'health', 'refreshAdapters', 'classifyError', 'syncModelSwitch'];

test('module.exports 仍是默认单例（向后兼容）', () => {
  for (const m of EXISTING_METHODS) {
    assert.strictEqual(typeof gateway[m], 'function', `单例缺方法 ${m}`);
  }
  assert.strictEqual(typeof gateway.createGateway, 'function');
});

test('createGateway 造出独立实例，互不相同且异于单例', () => {
  const a = gateway.createGateway({ label: 'a' });
  const b = gateway.createGateway({ label: 'b' });
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a, gateway);
  for (const m of EXISTING_METHODS) {
    assert.strictEqual(typeof a[m], 'function', `工厂实例缺方法 ${m}`);
  }
});

test('单例与工厂实例方法面一致（同一 prototype）', () => {
  const made = gateway.createGateway();
  for (const m of EXISTING_METHODS) {
    assert.strictEqual(made[m], gateway[m], `${m} 不是同一原型方法`);
  }
});

test('熔断/冷却状态不跨实例共享（每实例一份 breaker）', () => {
  const a = gateway.createGateway();
  const b = gateway.createGateway();
  // 适配器连续失败计数：写 a 不得影响 b
  a._adapterFailures.kiro = 3;
  assert.strictEqual(b._adapterFailures.kiro, undefined);
  assert.strictEqual(a._adapterFailures.kiro, 3);
  // 最近失败缓存（fast-fail 用）同样按实例
  a._adapterLastError.ollama = { message: 'boom', at: Date.now() };
  assert.strictEqual(b._adapterLastError.ollama, undefined);
  // cooldown 自愈探测状态与适配器顺序队列：Map/对象实例不同
  assert.notStrictEqual(a._cooldownSelfHealInFlight, b._cooldownSelfHealInFlight);
  assert.notStrictEqual(a._adapterQueue, b._adapterQueue);
  assert.notStrictEqual(a._healthStore, b._healthStore);
});
