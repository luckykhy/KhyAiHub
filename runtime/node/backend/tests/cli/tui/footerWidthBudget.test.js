'use strict';

// Regression for BUG-012: the footer's gateway-skip warning was the only
// variable-length segment on the height:1 footer line and had no width budget —
// on a ~125-col window the long "通道已停用回退" warning pushed the line past the
// terminal columns and the closing bracket wrapped onto the next line leaving
// residue glyphs. The budget decision lives in the pure leaf footerWidthBudget.js
// (component shell just consumes it); these tests pin the degradation ladder:
// full → truncated(ellipsis) → short mark → dropped.

const { test } = require('node:test');
const assert = require('node:assert');

const { skipSegment, truncateToWidth } = require('../../../src/cli/tui/footerWidthBudget.js');

const FULL = '⟲ windsurf 通道已停用回退：请求失败将直接报错'; // 1+1+8(ascii) + 18 CJK ≈ 46 cols
const SHORT = '⟲ windsurf';

function widthOf(s) {
  // 与叶子同一宽度口径(formatters.displayWidth),消除测试与实现的度量分歧。
  return require('../../../src/cli/formatters').displayWidth(String(s));
}

test('wide window: budget fits the full warning untouched', () => {
  const r = skipSegment({ fullText: FULL, shortMark: SHORT, otherWidth: 60, cols: 125 });
  assert.strictEqual(r.mode, 'full');
  assert.strictEqual(r.text, FULL);
  assert.ok(widthOf(r.text) <= 125 - 60 - 4, 'full text must fit its budget');
});

test('narrow window: truncated with ellipsis, never exceeding the budget', () => {
  const otherWidth = 80;
  const r = skipSegment({ fullText: FULL, shortMark: SHORT, otherWidth, cols: 100 });
  assert.strictEqual(r.mode, 'truncated');
  assert.ok(r.text.endsWith('…'), 'truncation must mark itself with an ellipsis');
  const budget = 100 - otherWidth - 4;
  assert.ok(widthOf(r.text) <= budget, `width ${widthOf(r.text)} exceeded budget ${budget}`);
});

test('very narrow: degrades to the short mark (which channel broke is the key info)', () => {
  // budget = 100-85-4 = 11:放不下有信息量的截断(短标 10 列 + 2),降级短标。
  const r = skipSegment({ fullText: FULL, shortMark: SHORT, otherWidth: 85, cols: 100 });
  assert.strictEqual(r.mode, 'short');
  assert.strictEqual(r.text, SHORT);
});

test('extreme narrow: the segment yields entirely rather than wrap the line', () => {
  const r = skipSegment({ fullText: FULL, shortMark: SHORT, otherWidth: 98, cols: 100 });
  assert.strictEqual(r.mode, 'dropped');
  assert.strictEqual(r.text, '');
});

test('no cols (bypass callers like PreviewLayout): legacy byte-for-byte behavior', () => {
  for (const cols of [0, undefined, null]) {
    const r = skipSegment({ fullText: FULL, shortMark: SHORT, otherWidth: 999, cols });
    assert.strictEqual(r.mode, 'full', `cols=${cols} must disable budgeting`);
    assert.strictEqual(r.text, FULL);
  }
});

test('truncateToWidth counts CJK as 2 columns and reserves 1 col for the ellipsis', () => {
  const out = truncateToWidth('中中中中中', 7, widthOf);
  assert.strictEqual(widthOf(out), 7, 'output must exactly fill the budget');
  assert.ok(out.endsWith('…'));
  assert.strictEqual(truncateToWidth('abc', 0, widthOf), '');
  assert.strictEqual(truncateToWidth('', 5, widthOf), '');
  assert.strictEqual(truncateToWidth('abc', 5, widthOf), 'abc');
});
