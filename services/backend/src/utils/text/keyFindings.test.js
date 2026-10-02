'use strict';

// 单元契约测试：keyFindings 的四级门控层级（子门控必须被父门控压制）与
// 「唯一的仓内依赖是同层 D3 叶子」这条纯度锁。行为回归在 services/backend/tests/cli/keyFindings.test.js。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const kf = require('./keyFindings');

test('导出面（11 个符号）', () => {
  assert.deepEqual(Object.keys(kf).sort(), [
    '_isDegenerateFindingBody',
    'buildKeyFindingsInstruction',
    'composeFindingReport',
    'composeModelFinding',
    'degenerateGuardEnabled',
    'detectTestOutcome',
    'keyFindingsEnabled',
    'modelFindingsEnabled',
    'parseModelFindings',
    'stripFindings',
    'testFindingsEnabled',
  ]);
});

test('纯度锁：仓内只 require 同层 D3 叶子 utils/normalizeToolName', () => {
  const src = fs.readFileSync(path.join(__dirname, 'keyFindings.js'), 'utf8');
  const requires = [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  const local = requires.filter((r) => r.startsWith('.'));
  assert.deepEqual(local, ['../normalizeToolName']);
  // 真身确为 D3 叶子：normalizeToolName 直接挂在 utils/ 下
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'normalizeToolName.js')), true);
});

test('四级门控缺省全开', () => {
  const env = {};
  assert.equal(kf.keyFindingsEnabled(env), true);
  assert.equal(kf.testFindingsEnabled(env), true);
  assert.equal(kf.modelFindingsEnabled(env), true);
  assert.equal(kf.degenerateGuardEnabled(env), true);
});

test('父门控关 → 三个子门控一起关，即便各自的 env 是开', () => {
  const env = {
    KHY_KEY_FINDINGS: 'off',
    KHY_KEY_FINDINGS_TESTS: '1',
    KHY_KEY_FINDINGS_MODEL: '1',
    KHY_KEY_FINDINGS_DEGENERATE_GUARD: '1',
  };
  assert.equal(kf.keyFindingsEnabled(env), false);
  assert.equal(kf.testFindingsEnabled(env), false);
  assert.equal(kf.modelFindingsEnabled(env), false);
  assert.equal(kf.degenerateGuardEnabled(env), false);
});

test('子门控各自可关，且不反噬父门控', () => {
  assert.equal(kf.testFindingsEnabled({ KHY_KEY_FINDINGS_TESTS: '0' }), false);
  assert.equal(kf.keyFindingsEnabled({ KHY_KEY_FINDINGS_TESTS: '0' }), true);

  assert.equal(kf.modelFindingsEnabled({ KHY_KEY_FINDINGS_MODEL: 'false' }), false);
  assert.equal(kf.testFindingsEnabled({ KHY_KEY_FINDINGS_MODEL: 'false' }), true);

  assert.equal(kf.degenerateGuardEnabled({ KHY_KEY_FINDINGS_DEGENERATE_GUARD: 'no' }), false);
  assert.equal(kf.modelFindingsEnabled({ KHY_KEY_FINDINGS_DEGENERATE_GUARD: 'no' }), true);
});

test('OFF 取值集逐字节回退：0 / false / off / no 一视同仁，空白与大小写不敏感', () => {
  for (const off of ['0', 'false', 'FALSE', 'off', 'OFF', 'no', ' no ']) {
    assert.equal(kf.keyFindingsEnabled({ KHY_KEY_FINDINGS: off }), false, `off=${off}`);
  }
});

test('垃圾 env 不抛：null / 非对象一律按缺省（开）处理', () => {
  for (const junk of [null, undefined, 'string', 42]) {
    assert.equal(kf.keyFindingsEnabled(junk), true);
    assert.equal(typeof kf.degenerateGuardEnabled(junk), 'boolean');
  }
});
