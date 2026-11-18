'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { CORE_ENV_KEYS, CORE_MODE_VALUES, DEFAULT_BIND_HOST, readCoreEnv } = require('./core-env');

test('键名三件：endpoint/token/mode，模式枚举三值', () => {
  assert.deepStrictEqual(CORE_ENV_KEYS, {
    endpoint: 'KHY_CORE_ENDPOINT',
    token: 'KHY_CORE_TOKEN',
    mode: 'KHY_CORE_MODE',
  });
  assert.deepStrictEqual([...CORE_MODE_VALUES], ['auto', 'embedded', 'attached']);
  assert.strictEqual(DEFAULT_BIND_HOST, '127.0.0.1');
});

test('有 process 时按注入 env 读取，缺项不出键', () => {
  const out = readCoreEnv({ KHY_CORE_ENDPOINT: 'http://127.0.0.1:9', KHY_CORE_MODE: 'attached' });
  assert.deepStrictEqual(out, { endpoint: 'http://127.0.0.1:9', mode: 'attached' });
  assert.deepStrictEqual(readCoreEnv({}), {});
});

test('无 process 的环境：readCoreEnv 返回 {} 且不抛（浏览器/worker）', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('./core-env'), 'utf8');
  const sandbox = { module: { exports: {} }, exports: {} }; // 刻意不含 process
  const out = vm.runInNewContext(`${src}\n;module.exports.readCoreEnv()`, sandbox);
  // vm 里的对象原型跨 realm，deepStrictEqual 会比原型；按键判空。
  assert.strictEqual(Object.keys(out).length, 0);
});

test('import 期零副作用：重新 require 后行为一致，env 只在调用时读', () => {
  const first = require('./core-env');
  delete require.cache[require.resolve('./core-env')];
  const second = require('./core-env');
  assert.strictEqual(typeof second.readCoreEnv, 'function');
  const a = first.readCoreEnv({ KHY_CORE_MODE: 'attached' });
  const b = second.readCoreEnv({ KHY_CORE_MODE: 'attached' });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(second.readCoreEnv({}).mode, undefined);
});
