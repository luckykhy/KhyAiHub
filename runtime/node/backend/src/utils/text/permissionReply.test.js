'use strict';

// 单元契约测试：权限答复分类器的三条排序契约（否定优先 → allow-always → allow → null）
// 与「不认识绝不算同意」的 fail-closed 底线。行为回归在 services/backend/tests/cli/。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pr = require('./permissionReply');

test('导出面与零 require 纯度', () => {
  assert.deepEqual(Object.keys(pr).sort(), ['classifyPermissionReply', 'permissionReplyEnabled']);
  const src = fs.readFileSync(path.join(__dirname, 'permissionReply.js'), 'utf8');
  assert.ok(!src.includes('require('), '本叶子必须零 require（答复文本由入参给，动作由 call-site 做）');
});

test('门控缺省为开，关闭后一律返回 null（call-site 保持原路径）', () => {
  assert.equal(pr.permissionReplyEnabled({}), true);
  assert.equal(pr.permissionReplyEnabled({ KHY_PERMISSION_REPLY_TOKENS: '0' }), false);
  assert.equal(pr.permissionReplyEnabled({ KHY_PERMISSION_REPLY_TOKENS: 'OFF' }), false);
  for (const say of ['y', '同意', '始终允许', '不']) {
    assert.equal(pr.classifyPermissionReply(say, { KHY_PERMISSION_REPLY_TOKENS: '0' }), null);
  }
});

test('三档分类：allow / allow-always / deny', () => {
  const env = {};
  assert.equal(pr.classifyPermissionReply('y', env), 'allow');
  assert.equal(pr.classifyPermissionReply('同意', env), 'allow');
  assert.equal(pr.classifyPermissionReply('可以', env), 'allow');
  assert.equal(pr.classifyPermissionReply('always', env), 'allow-always');
  assert.equal(pr.classifyPermissionReply('始终允许', env), 'allow-always');
  assert.equal(pr.classifyPermissionReply('信任这台机器', env), 'allow-always');
  assert.equal(pr.classifyPermissionReply('no', env), 'deny');
  assert.equal(pr.classifyPermissionReply('取消', env), 'deny');
});

test('排序契约①：否定优先——「不同意」是 deny 而不是 allow', () => {
  assert.equal(pr.classifyPermissionReply('不同意', {}), 'deny');
  assert.equal(pr.classifyPermissionReply('不要总是允许', {}), 'deny');
});

test('排序契约②：allow-always 在 allow 之前（「总是允许」含「允许」）', () => {
  assert.equal(pr.classifyPermissionReply('总是允许', {}), 'allow-always');
});

test('fail-closed：不认识的答复返回 null，交给 call-site 的 default-deny', () => {
  for (const junk of ['', '   ', '苹果汁', 'hello world 42', null, undefined, 123]) {
    assert.equal(pr.classifyPermissionReply(junk, {}), null, `junk=${String(junk)}`);
  }
});

test('归一化：NFKC 把全角 ASCII 折半角，大小写与首尾空白不敏感', () => {
  assert.equal(pr.classifyPermissionReply('Ｙ', {}), 'allow');
  assert.equal(pr.classifyPermissionReply('  YES  ', {}), 'allow');
  assert.equal(pr.classifyPermissionReply('Yes', {}), 'allow');
});
