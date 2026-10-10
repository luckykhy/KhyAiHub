'use strict';

/**
 * asciiBox.test.js — 锁盒式基元 boxRow/boxRule 的口径。
 *
 * 这是 diskAnalyzeReport / upstreamStudyReport 两处 `_row`/`_rule` 收敛后的
 * 单一真源;此测同时是逐字节回退的护栏:若填充/截断/分隔线规则漂移,两份
 * 报告输出会一起变,此测先红。
 */

const test = require('node:test');
const assert = require('node:assert');

const { boxRow, boxRule, boxTop } = require('../src/services/asciiBox');
const stringWidth = require('string-width');

test('boxTop: 全角标题后横线按显示宽度补齐,与 boxRow 同宽', () => {
  const top = boxTop('─ khyos 磁盘分析', 60);
  const row = boxRow('x', 60);
  assert.ok(top.startsWith('┌─ khyos 磁盘分析'), top);
  assert.ok(top.endsWith('┐'), top);
  assert.strictEqual(stringWidth(top), stringWidth(row), `top=${stringWidth(top)} row=${stringWidth(row)}`);
});

test('boxTop: 纯 ASCII 标题逐字节 = ┌ + lead + 补齐横线 + ┐', () => {
  const out = boxTop('─ ab ', 8);
  // 内部宽 = width+2 = 10；lead 宽 5 → 5 根横线
  assert.strictEqual(out, '┌─ ab ─────┐');
});


test('boxRow: 全角 CJK 按显示宽度补齐(每行可视宽度恒等)', () => {
  // 同一 width 下，纯 ASCII 与 CJK 行的显示宽度必须相等，右边界才能对齐。
  const ascii = boxRow('short', 60);
  const cjk = boxRow('磁盘分析报告', 60);
  assert.strictEqual(stringWidth(cjk), stringWidth(ascii));
  assert.strictEqual(stringWidth(ascii), 60 + 4); // │ + 空格 + 60 + 空格 + │
});

test('boxRow: 全角 CJK 超宽按显示宽度截断且不切半角字符', () => {
  const out = boxRow('这是一个非常非常长的中文标题需要被截断', 10);
  assert.strictEqual(stringWidth(out), 10 + 4);
  const inner = out.slice(2, -2).trim();
  // 截断结果必须仍是合法字符串（无孤立代理对）且不超过 width。
  assert.ok([...inner].every((c) => c.length === 1), 'no split surrogate');
  assert.ok(stringWidth(inner) <= 10);
});

test('boxRule: 全角 label 的分隔线显示宽度与其它盒行一致', () => {
  const rule = boxRule('最大文件', 60);
  const row = boxRow('x', 60);
  assert.strictEqual(stringWidth(rule), stringWidth(row));
});

test('boxRow: 右侧补空格到 width,包边框', () => {
  assert.strictEqual(boxRow('hi', 5), '│ hi    │');
  assert.strictEqual(boxRow('', 3), '│     │');
});

test('boxRow: 超宽截断到 width', () => {
  assert.strictEqual(boxRow('abcdef', 3), '│ abc │');
});

test('boxRow: null/undefined → 空串填充', () => {
  assert.strictEqual(boxRow(null, 2), '│    │');
  assert.strictEqual(boxRow(undefined, 2), '│    │');
});

test('boxRule: 无 label → 纯分隔线(width+2 根横线)', () => {
  assert.strictEqual(boxRule('', 4), `├${'─'.repeat(6)}┤`);
  assert.strictEqual(boxRule(undefined, 4), `├${'─'.repeat(6)}┤`);
});

test('boxRule: 有 label → ├─ label ───┤ 填满 width+2', () => {
  const out = boxRule('X', 6);
  assert.ok(out.startsWith('├─ X '), out);
  assert.ok(out.endsWith('┤'), out);
  // 可视长度 = 1(├) + (width+2) 内部 + 1(┤)
  assert.strictEqual([...out].length, 1 + (6 + 2) + 1);
});

test('boxRule: 极窄 label 溢出时 fill 不为负(Math.max 0)', () => {
  const out = boxRule('verylonglabel', 2);
  assert.ok(out.startsWith('├─ verylonglabel '), out);
  assert.ok(out.endsWith('┤'), out);
});

test('纯函数:同输入同输出', () => {
  assert.strictEqual(boxRow('x', 4), boxRow('x', 4));
  assert.strictEqual(boxRule('y', 4), boxRule('y', 4));
});
