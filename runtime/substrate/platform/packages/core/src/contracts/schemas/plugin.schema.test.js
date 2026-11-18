'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { PluginInfoSchema, PluginChangedPayloadSchema } = require('./plugin.schema');

test('插件信息：namespace 非空，error 态须带 reason', () => {
  assert.strictEqual(PluginInfoSchema.safeParse({ namespace: 'demo', version: '0.1.0', state: 'enabled' }).success, true);
  assert.strictEqual(PluginInfoSchema.safeParse({ namespace: 'demo', version: '1', state: 'error', reason: '激活抛错' }).success, true);
  assert.strictEqual(PluginInfoSchema.safeParse({ namespace: '', version: '1', state: 'enabled' }).success, false);
});

test('plugin.changed 载荷：coreId 必填（多终端广播的写者身份）', () => {
  const payload = PluginChangedPayloadSchema.parse({ namespace: 'demo', state: 'enabled', coreId: 'core-1' });
  assert.strictEqual(payload.coreId, 'core-1');
  assert.strictEqual(PluginChangedPayloadSchema.safeParse({ namespace: 'demo', state: 'enabled' }).success, false);
});
