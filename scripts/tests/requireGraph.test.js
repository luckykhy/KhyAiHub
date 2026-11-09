'use strict';

/**
 * requireGraph 单元测试 —— 锁住「顶层 vs 懒加载」分类的正确性。
 *
 * 这组用例针对的是**实测踩到的那类缺陷**：用括号深度判定顶层/懒加载时，
 * ① 模块顶层的 `try { require(...) }` 被误判成懒加载（装载期重量被漏掉）；
 * ② 字符串/正则里的花括号把深度带偏，文件后半段的真实懒加载被误判成顶层。
 *
 * 判据本身骗人时，守卫就是假的 —— 所以这里逐条钉死语义。
 */

const test = require('node:test');
const assert = require('node:assert');

const requireGraph = require('../lib/requireGraph');

/** 分类一段源码，返回顶层/懒加载的 spec 列表 */
function classify(src) {
  const r = requireGraph.classifyByAst(src);
  return r;
}

test('模块顶层的 require 是顶层边', () => {
  const r = classify("const a = require('a');\nconst b = require('b');\n");
  assert.deepStrictEqual(r.top.sort(), ['a', 'b']);
  assert.deepStrictEqual(r.lazy, []);
  assert.strictEqual(r.mode, 'ast');
});

test('顶层 try 块里的 require 仍是顶层边（装载期就会执行）', () => {
  const r = classify("try { require('./x').install(); } catch {}\n");
  assert.deepStrictEqual(r.top, ['./x']);
  assert.deepStrictEqual(r.lazy, []);
});

test('顶层 if 块里的 require 是顶层边（条件性装载，仍在模块求值期）', () => {
  const r = classify("if (process.platform === 'win32') { require('./y'); }\n");
  assert.deepStrictEqual(r.top, ['./y']);
});

test('函数体内的 require 是懒加载边', () => {
  const r = classify("function f() { return require('./z'); }\n");
  assert.deepStrictEqual(r.top, []);
  assert.deepStrictEqual(r.lazy, ['./z']);
});

test('箭头函数体内的 require 是懒加载边', () => {
  const r = classify("const f = () => require('./w');\n");
  assert.deepStrictEqual(r.top, []);
  assert.deepStrictEqual(r.lazy, ['./w']);
});

test('类方法体内的 require 是懒加载边', () => {
  const r = classify("class A { m() { require('./m'); } }\n");
  assert.deepStrictEqual(r.top, []);
  assert.deepStrictEqual(r.lazy, ['./m']);
});

test('对象字面量方法体内的 require 是懒加载边', () => {
  const r = classify("const o = { m() { require('./o'); } };\n");
  assert.deepStrictEqual(r.top, []);
  assert.deepStrictEqual(r.lazy, ['./o']);
});

test('字符串里的花括号不改变后续 require 的分类（括号深度口径的致命缺陷）', () => {
  // 旧口径在这里会把深度带偏：`'{'` 让深度 +1，从此再回不到 0，
  // 于是后面的 require 全被判成「懒加载」。
  const r = classify("const s = '{ not a brace }';\nconst t = require('./after-string');\n");
  assert.deepStrictEqual(r.top, ['./after-string']);
});

test('正则里的花括号不改变后续 require 的分类', () => {
  const r = classify("const re = /a{2,3}/;\nconst t = require('./after-regex');\n");
  assert.deepStrictEqual(r.top, ['./after-regex']);
});

test('模板字符串里的花括号不改变后续 require 的分类', () => {
  const r = classify("const s = `a { b } c`;\nconst t = require('./after-tpl');\n");
  assert.deepStrictEqual(r.top, ['./after-tpl']);
});

test('注释里的 require 不进边集', () => {
  const r = classify("// require('./commented')\n/* require('./block') */\nconst t = require('./real');\n");
  assert.deepStrictEqual(r.top, ['./real']);
});

test('动态 require 只计数，不进边集', () => {
  const r = classify("const name = 'x';\nrequire(name);\n");
  assert.deepStrictEqual(r.top, []);
  assert.deepStrictEqual(r.lazy, []);
  assert.strictEqual(r.dynamic, 1);
});

test('嵌套函数里的 require 仍是懒加载边', () => {
  const r = classify("function outer() { function inner() { require('./deep'); } }\n");
  assert.deepStrictEqual(r.top, []);
  assert.deepStrictEqual(r.lazy, ['./deep']);
});

test('顶层 IIFE 里的 require：口径边界，计入懒加载（已知盲区，见 requireGraph 头注）', () => {
  // 顶层 IIFE 在**装载期**就会执行，严格说应算顶层边；
  // 但 AST 看不出「箭头函数体在装载期被立即调用」，故记为懒加载。
  // 这里把当前口径钉死，避免以后无声漂移。
  const r = classify("(() => { require('./iife'); })();\n");
  assert.deepStrictEqual(r.top, []);
  assert.deepStrictEqual(r.lazy, ['./iife']);
});

test('classifyFile 走缓存且模式为 ast', () => {
  requireGraph.clearCache();
  const file = require.resolve('../lib/requireGraph');
  const a = requireGraph.classifyFile(file);
  const b = requireGraph.classifyFile(file);
  assert.strictEqual(a, b, '同一文件应命中缓存');
  assert.strictEqual(a.mode, 'ast');
});
