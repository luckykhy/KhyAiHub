'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createEventBus, bus, CHANNEL, publish, subscribe, subscribeAll } = require('./eventBus');

test('CHANNEL.ALL 是通用频道，工厂造出独立总线', () => {
  assert.strictEqual(CHANNEL.ALL, 'event');
  const a = createEventBus();
  const b = createEventBus();
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a, bus);
  a.setMaxListeners(500);
  assert.doesNotThrow(() => a.emit(CHANNEL.ALL, { type: 'x' }));
});

test('按 type 与 ALL 两路 fan-out；退订后都不再收', () => {
  const typed = [];
  const all = [];
  const unTyped = subscribe('unit.test.typed', (e) => typed.push(e));
  const unAll = subscribeAll((e) => all.push(e));

  publish({ type: 'unit.test.typed', payload: 1 });
  assert.strictEqual(typed.length, 1);
  assert.strictEqual(all.length, 1);

  unTyped();
  unAll();
  publish({ type: 'unit.test.typed', payload: 2 });
  assert.strictEqual(typed.length, 1, '退订后不应再收');
  assert.strictEqual(all.length, 1, '退订后不应再收');
});

test('抛错的订阅者不会打断生产者与兄弟订阅者（fail-soft）', () => {
  const sibling = [];
  const unBad = subscribe('unit.test.throw', () => {
    throw new Error('bad subscriber');
  });
  const unOk = subscribe('unit.test.throw', (e) => sibling.push(e));
  assert.doesNotThrow(() => publish({ type: 'unit.test.throw' }));
  assert.strictEqual(sibling.length, 1);
  unBad();
  unOk();
});

test('非函数 handler 退化为 no-op 退订函数', () => {
  const un = subscribe('unit.test.none', null);
  assert.strictEqual(typeof un, 'function');
  assert.doesNotThrow(() => un());
});

test('无 type 的事件只走 ALL 一路', () => {
  const all = [];
  const un = subscribeAll((e) => all.push(e));
  publish({ payload: 'no-type' });
  assert.strictEqual(all.length, 1);
  un();
});
