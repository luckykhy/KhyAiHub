'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { CoreEventSchema, PublishEventSchema, EventFilterSchema } = require('./event.schema');

test('事件帧：seq/ts 可缺省于发布侧，核心侧必填', () => {
  const published = PublishEventSchema.parse({ id: 'e1', type: 'session.appended', payload: { x: 1 } });
  assert.deepStrictEqual(Object.keys(published).sort(), ['id', 'payload', 'type']);
  const stored = CoreEventSchema.parse({ ...published, seq: 7, ts: 1700000000 });
  assert.strictEqual(stored.seq, 7);
  assert.strictEqual(CoreEventSchema.safeParse({ ...published, seq: -1, ts: 1 }).success, false);
});

test('过滤器：空对象放行（全量订阅），type/terminalId 可选', () => {
  assert.strictEqual(EventFilterSchema.safeParse({}).success, true);
  assert.strictEqual(EventFilterSchema.safeParse({ type: 'session.appended' }).success, true);
  assert.strictEqual(EventFilterSchema.safeParse({ type: '' }).success, false);
});
