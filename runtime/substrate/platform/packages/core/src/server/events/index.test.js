'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const events = require('./index');

test('出口聚合 bus/log 两面，默认实例可用', () => {
  assert.strictEqual(typeof events.createEventBus, 'function');
  assert.strictEqual(typeof events.createEventLog, 'function');
  assert.strictEqual(typeof events.append, 'function');
  assert.strictEqual(typeof events.publish, 'function');
  assert.strictEqual(events.CHANNEL.ALL, 'event');
  const seen = [];
  const un = events.subscribeAll((e) => seen.push(e));
  events.publish({ type: 'unit.test.export' });
  assert.strictEqual(seen.length, 1);
  un();
});
