'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const pkgRoot = path.join(__dirname, '..');

// 封闭 exports 七键（[DESIGN-ARCH-220] §2.2）：自引用解析，深导入一律走不到。
test('七条导出子路径全部可解析', () => {
  const subpaths = [
    '@khy/core',
    '@khy/core/contracts',
    '@khy/core/contracts/core-env',
    '@khy/core/client',
    '@khy/core/locator-host',
    '@khy/core/server',
    '@khy/core/package.json',
  ];
  for (const sub of subpaths) {
    assert.doesNotThrow(() => require.resolve(sub, { paths: [pkgRoot] }), `${sub} 不可解析`);
  }
  assert.strictEqual(require('@khy/core').CORE_ERROR_CODES.length, 13);
  assert.strictEqual(typeof require('@khy/core/client').obtainCore, 'function');
  assert.strictEqual(typeof require('@khy/core/locator-host').obtainCoreNode, 'function');
  assert.strictEqual(typeof require('@khy/core/server').createCoreServer, 'function');
});

test('types 条件只暴露给 TS：运行时解析不到 .d.ts', () => {
  assert.doesNotThrow(() => require.resolve('@khy/core/contracts', { paths: [pkgRoot] }));
  assert.ok(require.resolve('@khy/core/contracts', { paths: [pkgRoot] }).endsWith('index.js'));
});
