'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { CapabilitySchema, CapabilityRefSchema } = require('./capability.schema');

test('能力：三态合法，missing 必须带 reason（降级不静默）', () => {
  assert.strictEqual(CapabilitySchema.safeParse({ id: 'gateway.llm', version: '1', state: 'available' }).success, true);
  const missing = CapabilitySchema.parse({ id: 'session.sync', version: '1', state: 'missing', reason: '提供方未装配' });
  assert.strictEqual(missing.reason, '提供方未装配');
  assert.strictEqual(CapabilitySchema.safeParse({ id: 'x', version: '1', state: 'zombie' }).success, false);
});

test('能力引用（终端清单的 consumes/provides 项）：capability 必填，required 可缺省', () => {
  assert.strictEqual(CapabilityRefSchema.safeParse({ capability: 'ui.shell.web' }).success, true);
  assert.strictEqual(CapabilityRefSchema.safeParse({ capability: 'session.sync', required: false }).success, true);
  assert.strictEqual(CapabilityRefSchema.safeParse({ capability: '' }).success, false);
});
