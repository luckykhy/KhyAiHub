'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSearchPlan, _escapeRe } = require('./searchPlanBuilder');

test('文件/目录/扩展名混合信号生成 globs 且不触发联网检索', () => {
  const plan = buildSearchPlan({ fileHints: ['src/app.js'], dirHints: ['services'], extHints: ['.js'] });
  assert.deepEqual(plan.globs, ['src/app.js', 'services/**/*.js']);
  assert.deepEqual(plan.grepPatterns, []);
  assert.deepEqual(plan.searchQueries, []);
});

test('反斜杠与 ./ 前缀归一化后按是否含斜杠分叉 glob', () => {
  const plan = buildSearchPlan({ fileHints: ['.\\src\\a.js', './b.js'] });
  assert.deepEqual(plan.globs, ['src/a.js', '**/b.js']);
});

test('仅目录信号追加 /**/*，仅扩展名信号追加 **/*ext', () => {
  assert.deepEqual(buildSearchPlan({ dirHints: ['src'] }).globs, ['src/**/*']);
  assert.deepEqual(buildSearchPlan({ extHints: ['.ts'] }).globs, ['**/*.ts']);
});

test('标识符与引号去重后进入 grepPatterns', () => {
  const plan = buildSearchPlan({ identifiers: ['foo', 'foo', 'bar'], quoted: ['foo'] });
  assert.deepEqual(plan.grepPatterns, ['foo', 'bar']);
});

test('grep 元字符在 grepPatterns 中被转义', () => {
  const plan = buildSearchPlan({ identifiers: ['a.b'] });
  assert.deepEqual(plan.grepPatterns, ['a\\.b']);
});

test('_escapeRe 以 String() 强转，null 变为字面量 null', () => {
  assert.strictEqual(_escapeRe('a.b*c'), 'a\\.b\\*c');
  assert.strictEqual(_escapeRe(null), 'null');
});

test('命中外部标记（latest）时生成联网检索词', () => {
  const plan = buildSearchPlan({ keywords: ['latest', 'react'], identifiers: ['x'] });
  assert.deepEqual(plan.grepPatterns, ['x']);
  assert.deepEqual(plan.searchQueries, ['latest react']);
});

test('needWeb=true 强制生成检索词', () => {
  const plan = buildSearchPlan({ keywords: ['foo'] }, { needWeb: true });
  assert.deepEqual(plan.searchQueries, ['foo']);
});

test('无仓库候选但无可检索内容时不产出空检索词', () => {
  const plan = buildSearchPlan({}, { hasRepoCandidates: false });
  assert.deepEqual(plan, { globs: [], grepPatterns: [], searchQueries: [] });
});

test('signals 为 null 时收敛为空计划', () => {
  assert.deepEqual(buildSearchPlan(null), { globs: [], grepPatterns: [], searchQueries: [] });
});

test('空串标识符被过滤', () => {
  assert.deepEqual(buildSearchPlan({ identifiers: ['', 'a'] }).grepPatterns, ['a']);
});

test('identifiers 为非可迭代数字时抛 TypeError', () => {
  assert.throws(() => buildSearchPlan({ identifiers: 5 }), TypeError);
});

test('fileHints 为非数组字符串时抛 TypeError', () => {
  assert.throws(() => buildSearchPlan({ fileHints: 'abc' }), TypeError);
});

test('KNOWN-DEFECT: maxGrep=0 被 Number(0)||8 吞成 8，不封顶为 0', () => {
  // Input maxGrep:0 -> measured: all 3 grep tokens kept (cap falls back to 8, not 0).
  const plan = buildSearchPlan({ identifiers: ['a', 'b', 'c'] }, { maxGrep: 0 });
  assert.deepEqual(plan.grepPatterns, ['a', 'b', 'c']);
});

test('KNOWN-DEFECT: maxGlob=0 同样退化为默认 8', () => {
  // Input maxGlob:0 -> measured: globs length 3 (all kept), cap defaults to 8.
  const plan = buildSearchPlan({ extHints: ['.a', '.b', '.c'] }, { maxGlob: 0 });
  assert.strictEqual(plan.globs.length, 3);
});
