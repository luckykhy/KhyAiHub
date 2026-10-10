'use strict';
// Tests for services/childEnvPolicy.js (pure leaf, no IO).
// Run: node --test tests/childEnvPolicy.test.js
// Runner note: requires('node:test') -> jest.config.js auto-excludes this file;
// this suite is node:test-only by design (khyos-testing decision matrix).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const path = require('path');
const { buildChildEnv, isEnabled, isSensitiveName } = require(path.join(
  __dirname,
  '..',
  'src',
  'services',
  'childEnvPolicy'
));

const SENSITIVE_BASE = {
  PATH: 'C:\\Windows\\system32',
  COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
  TEMP: 'C:\\Temp',
  HOME: 'C:\\Users\\u',
  GITHUB_TOKEN: 'ghp_xxx',
  ANTHROPIC_API_KEY: 'sk-ant-xxx',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  DATABASE_PASSWORD: 'db-pass',
  MY_SERVICE_CREDENTIAL: 'cred',
  GIT_PRIVATE_KEY: 'pk',
  OAUTH_AUTH_TOKEN: 't',
};

test('敏感名（TOKEN/SECRET/PASSWORD/CREDENTIAL/API_KEY/PRIVATE_KEY/AUTH）默认剥离', () => {
  const out = buildChildEnv(SENSITIVE_BASE);
  for (const k of [
    'GITHUB_TOKEN',
    'ANTHROPIC_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'DATABASE_PASSWORD',
    'MY_SERVICE_CREDENTIAL',
    'GIT_PRIVATE_KEY',
    'OAUTH_AUTH_TOKEN',
  ]) {
    assert.ok(!(k in out), `${k} must be stripped`);
  }
});

test('常规变量（PATH/COMSPEC/TEMP/HOME）保留（防过度修正双向断言）', () => {
  const out = buildChildEnv(SENSITIVE_BASE);
  for (const k of ['PATH', 'COMSPEC', 'TEMP', 'HOME']) {
    assert.equal(out[k], SENSITIVE_BASE[k], `${k} must be preserved`);
  }
});

test('词边界防误伤：KEYBOARD_LAYOUT / MONKEY 不被 KEY 误剥', () => {
  const env = { KEYBOARD_LAYOUT: 'us', MONKEY: 'zoo', TURKEY: 'bird' };
  const out = buildChildEnv(env);
  assert.equal(out.KEYBOARD_LAYOUT, 'us');
  assert.equal(out.MONKEY, 'zoo');
  assert.equal(out.TURKEY, 'bird');
});

test('大小写不敏感：github_token 小写同样剥离', () => {
  const out = buildChildEnv({ github_token: 't', Path: 'p' });
  assert.ok(!('github_token' in out));
  assert.equal(out.Path, 'p');
});

test('显式放行：options.allow 数组优先于剥离', () => {
  const out = buildChildEnv(SENSITIVE_BASE, { allow: ['GITHUB_TOKEN'] });
  assert.equal(out.GITHUB_TOKEN, 'ghp_xxx');
  assert.ok(!('ANTHROPIC_API_KEY' in out), 'non-allowed sensitive vars stay stripped');
});

test('显式放行：allow 逗号串形式同样生效', () => {
  const out = buildChildEnv(SENSITIVE_BASE, { allow: 'GITHUB_TOKEN, MY_SERVICE_CREDENTIAL' });
  assert.equal(out.GITHUB_TOKEN, 'ghp_xxx');
  assert.equal(out.MY_SERVICE_CREDENTIAL, 'cred');
  assert.ok(!('DATABASE_PASSWORD' in out));
});

test('门控：KHY_CHILD_ENV_POLICY=0/false/off/no → 返回原输入（逐字节回退）', () => {
  for (const v of ['0', 'false', 'off', 'no']) {
    const env = { KHY_CHILD_ENV_POLICY: v, GITHUB_TOKEN: 't', PATH: 'p' };
    const out = buildChildEnv(env, { envOverrides: env });
    assert.equal(out, env, `gate off (${v}) must return the input reference`);
  }
});

test('门控默认开（未设置时剥离生效）', () => {
  const out = buildChildEnv({ GITHUB_TOKEN: 't', PATH: 'p' }, { envOverrides: {} });
  assert.ok(!('GITHUB_TOKEN' in out));
  assert.equal(out.PATH, 'p');
});

test('isEnabled 谓词：默认开；0/false/off/no → 关；其余 → 开', () => {
  assert.equal(isEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.equal(isEnabled({ KHY_CHILD_ENV_POLICY: v }), false, v);
  }
  assert.equal(isEnabled({ KHY_CHILD_ENV_POLICY: '1' }), true);
  assert.equal(isEnabled(), true);
});

test('纯函数：不 mutate 输入对象', () => {
  const env = { GITHUB_TOKEN: 't', PATH: 'p' };
  const snapshot = JSON.stringify(env);
  buildChildEnv(env);
  assert.equal(JSON.stringify(env), snapshot, 'input must not be mutated');
});

test('非字符串值原样保留；null/undefined env → 空对象', () => {
  const out = buildChildEnv({ PATH: 'p', PORT: 3000 });
  assert.equal(out.PORT, 3000);
  assert.deepEqual(buildChildEnv(null), {});
  assert.deepEqual(buildChildEnv(undefined), {});
});

test('isSensitiveName：直接暴露供测试与消费方复用', () => {
  assert.equal(isSensitiveName('GITHUB_TOKEN'), true);
  assert.equal(isSensitiveName('MY_PASSWORD'), true);
  assert.equal(isSensitiveName('PATH'), false);
  assert.equal(isSensitiveName('KEYBOARD_LAYOUT'), false);
});
