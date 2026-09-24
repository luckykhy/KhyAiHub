'use strict';

// [DESIGN-ARCH-157] diffSpec 视觉规格真源的守卫测试。
const { test } = require('node:test');
const assert = require('node:assert');
const spec = require('../../src/cli/diffSpec');

test('gate off → CC 字面量逐字节回退', () => {
  const off = spec.diffColors({ KHY_DIFF_SPEC_V1: '0' });
  assert.strictEqual(off.add, '#225C2B');
  assert.strictEqual(off.del, '#7A2936');
  assert.strictEqual(off.addWord, '#38A660');
  assert.strictEqual(off.delWord, '#B3596B');
});

test('default 主题下门控开 = CC 字面量（无回归）', () => {
  const tr = require('../../src/cli/themeRegistry');
  tr.setTheme('default');
  assert.deepStrictEqual(spec.diffColors(), spec.CC_DIFF);
});

test('非默认主题门控开 → 主题色生效，关 → 恒 CC', () => {
  const tr = require('../../src/cli/themeRegistry');
  tr.setTheme('ocean');
  try {
    const on = spec.diffColors({});
    assert.strictEqual(on.add, '#1A4A42');
    assert.strictEqual(on.del, '#6B2D3C');
    const off = spec.diffColors({ KHY_DIFF_SPEC_V1: 'off' });
    assert.deepStrictEqual(off, spec.CC_DIFF);
  } finally {
    tr.setTheme('default');
  }
});

test('词级高亮开关解析：新名 > 旧名 > 默认开', () => {
  assert.strictEqual(spec.wordHighlightEnabled({}), true);
  assert.strictEqual(spec.wordHighlightEnabled({ KHY_TUI_WORD_DIFF: '0' }), false);
  assert.strictEqual(spec.wordHighlightEnabled({ KHY_TUI_WORD_DIFF: '1' }), true);
  assert.strictEqual(
    spec.wordHighlightEnabled({ KHY_TUI_WORD_DIFF: '0', KHY_DIFF_WORD_HIGHLIGHT: '1' }),
    true
  );
  assert.strictEqual(
    spec.wordHighlightEnabled({ KHY_DIFF_WORD_HIGHLIGHT: 'false' }),
    false
  );
});

test('FOLD 账本冻结（preview 10 / diff 60 / expanded Infinity）', () => {
  assert.strictEqual(spec.FOLD.previewCollapsed, 10);
  assert.strictEqual(spec.FOLD.diffCollapsed, 60);
  assert.strictEqual(spec.FOLD.expanded, Infinity);
  assert.ok(Object.isFrozen(spec.FOLD));
});
