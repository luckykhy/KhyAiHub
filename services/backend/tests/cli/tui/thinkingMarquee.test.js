'use strict';

/**
 * thinkingMarquee leaf tests (node:test).
 *
 * 锁住三件事实:
 *   1. 窗口永远**不超过**给定显示列数(CJK 每字 2 列 —— 按 .length 计费会超宽被裁)。
 *   2. 窗口是跟随尾部的:文本增长 ⇒ 起点单调向右推进(这就是「从左到右移动」的来源)。
 *   3. 绝不抛、半个代理对绝不切出来。
 */

const test = require('node:test');
const assert = require('node:assert');

const { tailWindow } = require('../../../src/cli/tui/thinkingMarquee');
const { visWidth } = require('../../../src/cli/tui/wrapCell');

test('fits-within-width: CJK heavy text never exceeds the column budget', () => {
  const text = '需要先看看出错的日志文件，然后定位问题所在，再比较两种方案的优缺点';
  const full = visWidth(text);
  for (const cap of [10, 20, 40, 79]) {
    const w = tailWindow(text, cap);
    assert.ok(visWidth(w.text) <= cap, `cap ${cap} got ${visWidth(w.text)}`);
    assert.strictEqual(w.headCut, full > cap);
  }
});

test('short text passes through unchanged (normalization is only newline→space)', () => {
  const w = tailWindow('  分析用户意图  ', 40);
  assert.strictEqual(w.text, '  分析用户意图  ');
  assert.strictEqual(w.headCut, false);
});

test('newlines collapse to single spaces (same normalization as before)', () => {
  const w = tailWindow('第一行\n  第二行\n\n第三行', 60);
  assert.strictEqual(w.text, '第一行 第二行 第三行');
});

test('tail-following: growing text advances the window start monotonically', () => {
  const full = 'abcdefghij klmnopqrst uvwxyz 0123456789';
  let prev = '';
  let prevStart = -1;
  for (let n = 12; n <= full.length; n += 6) {
    const w = tailWindow(full.slice(0, n), 12);
    assert.ok(w.text.length > 0);
    // 起点在原文里的位置只能不减 —— 这就是「视线从左往右移」。
    const start = full.indexOf(w.text);
    assert.ok(start >= prevStart, `start went backwards: ${prevStart} → ${start}`);
    prevStart = start;
    prev = w.text;
  }
  assert.notStrictEqual(prev, full.slice(0, 12));
});

test('surrogate pairs stay whole', () => {
  const text = 'x'.repeat(60) + '😀🙁😐';
  for (let cap = 4; cap <= 12; cap += 1) {
    const w = tailWindow(text, cap);
    // 切开的半个代理对 = 单个 UTF-16 单元落在代理区,终端上打出乱码(「乱码」同族)。
    for (const cp of w.text) {
      if (cp.length === 1) {
        const code = cp.charCodeAt(0);
        assert.ok(!(code >= 0xd800 && code <= 0xdfff), `lone surrogate at cap ${cap}`);
      }
    }
    assert.ok(visWidth(w.text) <= cap);
  }
});

test('garbage in, never throws', () => {
  assert.deepStrictEqual(tailWindow('', 40), { text: '', headCut: false });
  assert.deepStrictEqual(tailWindow(null, 40), { text: '', headCut: false });
  assert.deepStrictEqual(tailWindow(undefined, 0), { text: '', headCut: false });
  assert.deepStrictEqual(tailWindow('abc', Number.NaN), { text: '', headCut: false });
  assert.deepStrictEqual(tailWindow('abc', -5), { text: '', headCut: false });
  assert.strictEqual(tailWindow({} , 40).text, '[object Object]');
});

test('window narrower than one CJK glyph degrades to empty, not overflow', () => {
  const w = tailWindow('中文中文中文', 1);
  assert.strictEqual(w.text, '');
  assert.strictEqual(w.headCut, true);
});
