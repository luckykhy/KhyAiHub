'use strict';

/**
 * 审计日志的请求体脱敏契约（SEC-05）。
 *
 * 此前 sanitizeBody 只替换**顶层**的固定字段名（password/token/secret/…），
 * 且名单与实际入参名脱节 —— newPassword / currentPassword / confirmPassword /
 * securityAnswer / sendKey / refreshToken 这些真正出现在请求体里的字段，以及
 * 任何嵌套层里的同名键，全部明文写进 audit_logs 表。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { sanitizeBody } = require('../../src/middleware/auditLog');

test('SEC-05：顶层口令/密保/令牌字段被脱敏', () => {
  const out = sanitizeBody({
    username: 'alice',
    password: 'P@ssw0rd',
    newPassword: 'P@ss123',
    currentPassword: 'Old123',
    confirmPassword: 'P@ss123',
    securityAnswer: 'Fluffy',
    sendKey: 'SCT123TOKEN',
    refreshToken: 'rt_abc',
    token: 'tok_abc',
    secret: 'shhh',
    apiKey: 'sk-xxx',
    api_key: 'sk-yyy',
  });
  assert.strictEqual(out.username, 'alice');
  for (const key of [
    'password',
    'newPassword',
    'currentPassword',
    'confirmPassword',
    'securityAnswer',
    'sendKey',
    'refreshToken',
    'token',
    'secret',
    'apiKey',
    'api_key',
  ]) {
    assert.strictEqual(out[key], '[REDACTED]', `${key} 必须被脱敏`);
  }
});

test('SEC-05：嵌套对象与数组里的敏感键同样被脱敏', () => {
  const out = sanitizeBody({
    profile: { password: 'nested-pw', name: 'bob' },
    items: [{ apiKey: 'sk-in-array' }, { ok: 'value' }],
    deep: { a: { b: { securityAnswer: 'nested-answer' } } },
  });
  assert.strictEqual(out.profile.password, '[REDACTED]');
  assert.strictEqual(out.profile.name, 'bob');
  assert.strictEqual(out.items[0].apiKey, '[REDACTED]');
  assert.strictEqual(out.items[1].ok, 'value');
  assert.strictEqual(out.deep.a.b.securityAnswer, '[REDACTED]');
});

test('SEC-05：非对象输入返回 null（与旧行为一致）', () => {
  assert.strictEqual(sanitizeBody(null), null);
  assert.strictEqual(sanitizeBody('string'), null);
  assert.strictEqual(sanitizeBody(42), null);
});

test('SEC-05：脱敏键名匹配不区分大小写', () => {
  const out = sanitizeBody({ PASSWORD: 'x', ApiKey: 'y', newpassword: 'z' });
  assert.strictEqual(out.PASSWORD, '[REDACTED]');
  assert.strictEqual(out.ApiKey, '[REDACTED]');
  assert.strictEqual(out.newpassword, '[REDACTED]');
});
