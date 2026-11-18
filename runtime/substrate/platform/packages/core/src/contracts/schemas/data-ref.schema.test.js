'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { DataRefSchema, DataRefInfoSchema } = require('./data-ref.schema');

test('DataRef：tier 限定 T0–T4，name 非空', () => {
  assert.strictEqual(DataRefSchema.safeParse({ tier: 'T2', name: 'sessions.db' }).success, true);
  assert.strictEqual(DataRefSchema.safeParse({ tier: 'T9', name: 'x' }).success, false);
  assert.strictEqual(DataRefSchema.safeParse({ tier: 'T0' }).success, false);
});

test('DataRefInfo：version 必填、size 可缺省', () => {
  assert.strictEqual(DataRefInfoSchema.safeParse({ tier: 'T1', name: 'conversations', version: 'v1' }).success, true);
  assert.strictEqual(DataRefInfoSchema.safeParse({ tier: 'T1', name: 'c' }).success, false);
});
