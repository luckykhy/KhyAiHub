'use strict';

// compactNumber.test.cjs — 大数紧凑写法的钉住用例（K/M/B/T）。
// 与同目录其它纯 TS 叶子一样，走仓里的 typescript 正规转译，不剥类型。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const modPath = join(__dirname, '..', 'src', 'renderer', 'shared', 'compactNumber.ts');
const src = readFileSync(modPath, 'utf-8');

const ts = require('typescript');
function loadModule() {
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', 'require', js)(module.exports, module, require);
  return module.exports;
}

const { formatCompactNumber } = loadModule();

test('compactNumber: 三位以下保持整数', () => {
  assert.strictEqual(formatCompactNumber(0), '0');
  assert.strictEqual(formatCompactNumber(54), '54');
  assert.strictEqual(formatCompactNumber(999), '999');
});

test('compactNumber: 千位用 K，最多一位小数', () => {
  assert.strictEqual(formatCompactNumber(1_000), '1K');
  assert.strictEqual(formatCompactNumber(1_280), '1.3K');
  assert.strictEqual(formatCompactNumber(12_800), '12.8K');
  assert.strictEqual(formatCompactNumber(128_000), '128K');
  assert.strictEqual(formatCompactNumber(200_000), '200K');
});

test('compactNumber: 百万/十亿用 M/B', () => {
  assert.strictEqual(formatCompactNumber(1_000_000), '1M');
  assert.strictEqual(formatCompactNumber(62_714_194), '62.7M');
  assert.strictEqual(formatCompactNumber(1_000_000_000), '1B');
});

test('compactNumber: 四舍五入到 1000 时进位到下一单位', () => {
  assert.strictEqual(formatCompactNumber(999_499), '999K');
  assert.strictEqual(formatCompactNumber(999_999), '1M');
  assert.strictEqual(formatCompactNumber(999.6), '1K');
});

test('compactNumber: 负数与非有限值', () => {
  assert.strictEqual(formatCompactNumber(-1_500), '-1.5K');
  assert.strictEqual(formatCompactNumber(-999_999), '-1M');
  assert.strictEqual(formatCompactNumber(-999.6), '-1K');
  assert.strictEqual(formatCompactNumber(Number.NaN), '0');
  assert.strictEqual(formatCompactNumber(Number.POSITIVE_INFINITY), '0');
});
