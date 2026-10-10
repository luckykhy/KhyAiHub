'use strict';

const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

// The leaf lazily requires this shim inside try/catch; stubbing the cache entry
// lets us exercise both the registry path and the env-only fallback branch.
const REGISTRY_PATH = path.resolve(__dirname, '../../../flagRegistry.js');
const { isEvalTimeoutEnabled, resolveEvalTimeoutMs } = require('./_evalTimeout.js');

// Restored-into state shared across stubs: node runs `t.after` hooks in
// registration order, so a nested stub must never restore to the previous stub.
let REAL_REGISTRY;

function stubRegistry(exportsObj, t) {
  const key = require.resolve(REGISTRY_PATH);
  if (REAL_REGISTRY === undefined) REAL_REGISTRY = require.cache[key];
  require.cache[key] = {
    id: key,
    filename: key,
    loaded: true,
    exports: exportsObj,
    children: [],
    paths: [],
  };
  t.after(() => {
    if (REAL_REGISTRY) require.cache[key] = REAL_REGISTRY;
    else delete require.cache[key];
  });
}

function isolateProcessEnv(t) {
  const saved = {
    KHY_BROWSER_EVAL_TIMEOUT: process.env.KHY_BROWSER_EVAL_TIMEOUT,
    KHY_BROWSER_EVAL_TIMEOUT_MS: process.env.KHY_BROWSER_EVAL_TIMEOUT_MS,
  };
  delete process.env.KHY_BROWSER_EVAL_TIMEOUT;
  delete process.env.KHY_BROWSER_EVAL_TIMEOUT_MS;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('默认（env 未给任何开关）：超时启用且墙钟为 15000ms', (t) => {
  isolateProcessEnv(t);
  assert.equal(isEvalTimeoutEnabled({}), true);
  assert.equal(resolveEvalTimeoutMs({}), 15000);
});

test('关闭写法集合：0 / "0" / "false" / "off" / "no" 大小写与空格均判为关', (t) => {
  isolateProcessEnv(t);
  for (const off of [0, '0', 'false', 'FALSE', 'off', 'OFF', ' no ', false]) {
    assert.equal(isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: off }), false, `${off}`);
  }
});

test('开启写法集合：1 / true / 任意非关闭 token 判为开', (t) => {
  isolateProcessEnv(t);
  for (const on of ['1', 'true', 'yes', 'on']) {
    assert.equal(isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: on }), true, on);
  }
  assert.equal(isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: 1 }), true);
});

test('超时毫秒：合法值原样返回，越界值夹到 [1000, 300000]', (t) => {
  isolateProcessEnv(t);
  assert.equal(resolveEvalTimeoutMs({ KHY_BROWSER_EVAL_TIMEOUT_MS: '2000' }), 2000);
  assert.equal(resolveEvalTimeoutMs({ KHY_BROWSER_EVAL_TIMEOUT_MS: '500' }), 1000);
  assert.equal(resolveEvalTimeoutMs({ KHY_BROWSER_EVAL_TIMEOUT_MS: '999999999' }), 300000);
  assert.equal(resolveEvalTimeoutMs({ KHY_BROWSER_EVAL_TIMEOUT_MS: 1500 }), 1500);
});

test('非法超时值回落默认 15000（非数字 / 空串 / 负数 / undefined）', (t) => {
  isolateProcessEnv(t);
  for (const junk of ['abc', '', '-5', undefined, null]) {
    assert.equal(resolveEvalTimeoutMs({ KHY_BROWSER_EVAL_TIMEOUT_MS: junk }), 15000, `${junk}`);
  }
  assert.equal(resolveEvalTimeoutMs({}), 15000);
});

test('env 参数缺省时回退 process.env，注入对象优先于全局', (t) => {
  isolateProcessEnv(t);
  process.env.KHY_BROWSER_EVAL_TIMEOUT = '0';
  process.env.KHY_BROWSER_EVAL_TIMEOUT_MS = '2500';
  // falsy 注入值（null / undefined / 0 / ''）被 `_env` 的 || 视为「未注入」→ 读全局
  assert.equal(isEvalTimeoutEnabled(null), false);
  assert.equal(isEvalTimeoutEnabled(undefined), false);
  assert.equal(isEvalTimeoutEnabled(0), false);
  assert.equal(resolveEvalTimeoutMs(null), 2500);
  // 真值注入（含空对象）→ 完全忽略全局
  assert.equal(isEvalTimeoutEnabled({}), true);
  assert.equal(resolveEvalTimeoutMs({}), 15000);
  // 非对象真值注入（字符串）→ 取不到属性 → 走「未设置」默认
  assert.equal(isEvalTimeoutEnabled('nope'), true);
});

test('委托 flagRegistry：开关与数值都以登记表返回值为准，参数为 (flagName, env)', (t) => {
  isolateProcessEnv(t);
  const calls = [];
  stubRegistry(
    {
      isFlagEnabled(name, env) {
        calls.push(['isFlagEnabled', name, env]);
        return false;
      },
      resolveNumeric(name, env) {
        calls.push(['resolveNumeric', name, env]);
        return 4321;
      },
    },
    t
  );
  const env = { KHY_BROWSER_EVAL_TIMEOUT: '1', KHY_BROWSER_EVAL_TIMEOUT_MS: '9000' };
  // 登记表说关就是关，即使 env 写的是开
  assert.equal(isEvalTimeoutEnabled(env), false);
  assert.equal(resolveEvalTimeoutMs(env), 4321);
  assert.deepEqual(calls, [
    ['isFlagEnabled', 'KHY_BROWSER_EVAL_TIMEOUT', env],
    ['resolveNumeric', 'KHY_BROWSER_EVAL_TIMEOUT_MS', env],
  ]);
});

test('登记表返回 0 / NaN 时不当作有效值，回落到 env 直读并 clamp', (t) => {
  isolateProcessEnv(t);
  stubRegistry({ isFlagEnabled: () => true, resolveNumeric: () => 0 }, t);
  assert.equal(resolveEvalTimeoutMs({ KHY_BROWSER_EVAL_TIMEOUT_MS: '2500' }), 2500);
  stubRegistry({ isFlagEnabled: () => true, resolveNumeric: () => NaN }, t);
  assert.equal(resolveEvalTimeoutMs({ KHY_BROWSER_EVAL_TIMEOUT_MS: '99' }), 1000);
  assert.equal(resolveEvalTimeoutMs({ KHY_BROWSER_EVAL_TIMEOUT_MS: 'zzz' }), 15000);
});

test('登记表 require 抛错时开关判定降级为 OFF_VALUES 白名单', (t) => {
  isolateProcessEnv(t);
  stubRegistry(
    {
      isFlagEnabled() {
        throw new Error('registry unavailable');
      },
      resolveNumeric() {
        throw new Error('registry unavailable');
      },
    },
    t
  );
  // 未设置 → 兜底开
  assert.equal(isEvalTimeoutEnabled({}), true);
  assert.equal(isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: null }), true);
  assert.equal(isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: undefined }), true);
  // 白名单（trim + 转小写）命中才关
  assert.equal(isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: ' OFF ' }), false);
  assert.equal(isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: 0 }), false);
  assert.equal(isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: 'no' }), false);
  // 白名单外的任意写法（含拼错的关闭意图）都判开
  assert.equal(isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: 'nope' }), true);
  assert.equal(isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: 'disabled' }), true);
});

test('KNOWN-DEFECT: _evalTimeout.js:57 降级分支下 MS="0" → 15000，登记表分支下同一 env → 1000', (t) => {
  isolateProcessEnv(t);
  const env = { KHY_BROWSER_EVAL_TIMEOUT_MS: '0' };
  // 正常路径：登记表把 0 clamp 到下限 1000（「0 = 不限」的意图被静默改成 1 秒强杀）
  assert.equal(resolveEvalTimeoutMs(env), 1000);
  // 降级路径：parseInt('0')=0 不 > 0 → 直接回落默认，两分支结果相差 14 倍
  stubRegistry(
    {
      isFlagEnabled: () => true,
      resolveNumeric() {
        throw new Error('registry unavailable');
      },
    },
    t
  );
  assert.equal(resolveEvalTimeoutMs(env), 15000);
});

test('KNOWN-DEFECT: KHY_BROWSER_EVAL_TIMEOUT="" 空串（shell 里等于「想关掉」）实测判为启用', (t) => {
  isolateProcessEnv(t);
  assert.equal(isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: '' }), true);
  // 登记表 require 失败的降级分支同样判 true（'' 不在 OFF_VALUES 里）
  stubRegistry(
    {
      isFlagEnabled() {
        throw new Error('registry unavailable');
      },
      resolveNumeric: () => 15000,
    },
    t
  );
  assert.equal(isEvalTimeoutEnabled({ KHY_BROWSER_EVAL_TIMEOUT: '' }), true);
});
