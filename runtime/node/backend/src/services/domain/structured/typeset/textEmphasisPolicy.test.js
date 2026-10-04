'use strict';

/**
 * Co-located tests for textEmphasisPolicy.js — the single source of truth for
 * "what gets bolded / which heading tier / literal double-width or not".
 *
 * The file's own header contract is: pure leaf, zero IO, deterministic,
 * never-throw, fail-soft, and both gates off → byte-identical old behaviour.
 * Those four claims are what this suite pins, plus the tier table.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const te = require('./textEmphasisPolicy.js');

describe('门控：强调层（KHY_TYPESET_EMPHASIS，默认开）', () => {
  test('缺失/空串/null env 都视为未设置 = 开', () => {
    assert.strictEqual(te.isEmphasisEnabled({}), true);
    assert.strictEqual(te.isEmphasisEnabled(), true);
    assert.strictEqual(te.isEmphasisEnabled(null), true);
    assert.strictEqual(te.isEmphasisEnabled({ KHY_TYPESET_EMPHASIS: undefined }), true);
    assert.strictEqual(te.isEmphasisEnabled({ KHY_TYPESET_EMPHASIS: '' }), true);
    assert.strictEqual(te.isEmphasisEnabled({ KHY_TYPESET_EMPHASIS: '   ' }), true);
  });

  test('只有显式关闭词才关，大小写与首尾空白不敏感', () => {
    for (const off of ['0', 'false', 'off', 'no']) {
      assert.strictEqual(te.isEmphasisEnabled({ KHY_TYPESET_EMPHASIS: off }), false, off);
      assert.strictEqual(te.isEmphasisEnabled({ KHY_TYPESET_EMPHASIS: `  ${off.toUpperCase()}  ` }), false, off);
    }
  });

  test('其余一切值视为开（含 yes/on 之外的随意字符串）', () => {
    for (const v of ['1', 'yes', 'on', 'anything', 'true']) {
      assert.strictEqual(te.isEmphasisEnabled({ KHY_TYPESET_EMPHASIS: v }), true, v);
    }
  });

  test('数字 0 与布尔 false 经 String 强转后命中关闭词', () => {
    assert.strictEqual(te.isEmphasisEnabled({ KHY_TYPESET_EMPHASIS: 0 }), false);
    assert.strictEqual(te.isEmphasisEnabled({ KHY_TYPESET_EMPHASIS: false }), false);
  });

  test('env 传成非对象（字符串）不抛，按默认开', () => {
    assert.doesNotThrow(() => te.isEmphasisEnabled('0'));
    assert.strictEqual(te.isEmphasisEnabled('0'), true);
  });
});

describe('门控：字面双宽标题（KHY_TYPESET_BIG_HEADINGS，默认关）', () => {
  test('默认关：缺失/空串/任意非开启词都不开', () => {
    assert.strictEqual(te.isBigHeadingsEnabled({}), false);
    assert.strictEqual(te.isBigHeadingsEnabled(), false);
    assert.strictEqual(te.isBigHeadingsEnabled(null), false);
    assert.strictEqual(te.isBigHeadingsEnabled({ KHY_TYPESET_BIG_HEADINGS: 'off' }), false);
    assert.strictEqual(te.isBigHeadingsEnabled({ KHY_TYPESET_BIG_HEADINGS: '2' }), false);
  });

  test('四个开启词命中，大小写/空白不敏感', () => {
    for (const on of ['1', 'true', 'on', 'yes']) {
      assert.strictEqual(te.isBigHeadingsEnabled({ KHY_TYPESET_BIG_HEADINGS: on }), true, on);
      assert.strictEqual(te.isBigHeadingsEnabled({ KHY_TYPESET_BIG_HEADINGS: ` ${on.toUpperCase()} ` }), true, on);
    }
  });

  test('两门词表刻意不对称：off/no 关强调层但不「开」双宽门', () => {
    assert.strictEqual(te.isEmphasisEnabled({ KHY_TYPESET_EMPHASIS: 'off' }), false);
    assert.strictEqual(te.isBigHeadingsEnabled({ KHY_TYPESET_BIG_HEADINGS: 'off' }), false);
    assert.strictEqual(te.isBigHeadingsEnabled({ KHY_TYPESET_BIG_HEADINGS: 'no' }), false);
  });
});

describe('headingDescriptor：层级单一真源', () => {
  test('H1/H2 醒目加粗，H3 加粗不醒目，H4-H6 走 muted 调', () => {
    assert.deepEqual(te.headingDescriptor(1), { level: 1, bold: true, tone: 'h1', prominent: true });
    assert.deepEqual(te.headingDescriptor(2), { level: 2, bold: true, tone: 'h2', prominent: true });
    assert.deepEqual(te.headingDescriptor(3), { level: 3, bold: true, tone: 'h3', prominent: false });
    for (const lvl of [4, 5, 6]) {
      assert.deepEqual(te.headingDescriptor(lvl), { level: lvl, bold: true, tone: 'muted', prominent: false });
    }
  });

  test('越界夹紧、小数截断', () => {
    assert.strictEqual(te.headingDescriptor(0).level, 1);
    assert.strictEqual(te.headingDescriptor(-5).level, 1);
    assert.strictEqual(te.headingDescriptor(7).level, 6);
    assert.strictEqual(te.headingDescriptor(99).level, 6);
    assert.strictEqual(te.headingDescriptor(2.7).level, 2);
    assert.strictEqual(te.headingDescriptor(2.99).level, 2);
  });

  test('非有限数（NaN/Infinity/字符串）落回 H1 档', () => {
    assert.strictEqual(te.headingDescriptor(NaN).level, 1);
    assert.strictEqual(te.headingDescriptor(Infinity).level, 1);
    assert.strictEqual(te.headingDescriptor(undefined).level, 1);
    assert.strictEqual(te.headingDescriptor('3').level, 1);
  });
});

describe('shouldBoldHeading / bigHeadingPrefix', () => {
  test('强调层关 → 恒 false（调用方逐字节回退旧行为）', () => {
    const off = { KHY_TYPESET_EMPHASIS: '0' };
    for (const lvl of [1, 2, 3, 6, 99, '3', NaN]) {
      assert.strictEqual(te.shouldBoldHeading(lvl, off), false, String(lvl));
    }
  });

  test('强调层开 → 所有级别都加粗，级别不参与判定（头注释明示 H3+ 是真缺口）', () => {
    const on = { KHY_TYPESET_EMPHASIS: '1' };
    for (const lvl of [1, 3, 6, 99, '3', NaN, undefined]) {
      assert.strictEqual(te.shouldBoldHeading(lvl, on), true, String(lvl));
    }
  });

  test('双宽门默认关 → 恒返空串，一个字节都不变', () => {
    for (const lvl of [1, 2, 3]) {
      assert.strictEqual(te.bigHeadingPrefix(lvl), '');
      assert.strictEqual(te.bigHeadingPrefix(lvl, {}), '');
    }
  });

  test('双宽门开 → 有限整数级别里只有 H1/H2 拿序列，且序列就是 DEC_DOUBLE_WIDTH', () => {
    const on = { KHY_TYPESET_BIG_HEADINGS: '1' };
    assert.strictEqual(te.bigHeadingPrefix(1, on), te.DEC_DOUBLE_WIDTH);
    assert.strictEqual(te.bigHeadingPrefix(2, on), te.DEC_DOUBLE_WIDTH);
    assert.strictEqual(te.DEC_DOUBLE_WIDTH, '\x1b#6');
    for (const lvl of [3, 4, 5, 6, 7, 99]) {
      assert.strictEqual(te.bigHeadingPrefix(lvl, on), '', String(lvl));
    }
  });

  test('门控传 null/undefined 不抛（绝不抛契约）', () => {
    assert.doesNotThrow(() => te.bigHeadingPrefix(1, null));
    assert.strictEqual(te.bigHeadingPrefix(1, null), '');
    assert.doesNotThrow(() => te.shouldBoldHeading(1, 'nope'));
  });
});

describe('KNOWN-DEFECT：字符串级别的类型门不对称', () => {
  // 同一 AST 里 contentSchema.validateBlock 对 heading.level 用 Number.isInteger
  // 严格拒收字符串（'2' → invalid），本叶子却用 Number.isFinite（对字符串恒 false）
  // 把 '3' 静默当 H1。两把尺对同一字段口径相反；且方向是「往最醒目档升」。
  test('bigHeadingPrefix("3") 交出双宽序列，而数值 3 交出空串', () => {
    const on = { KHY_TYPESET_BIG_HEADINGS: '1' };
    assert.strictEqual(te.bigHeadingPrefix(3, on), '');
    assert.strictEqual(te.bigHeadingPrefix('3', on), te.DEC_DOUBLE_WIDTH);
  });

  test('headingDescriptor("3") 落到最醒目的 H1 档（prominent: true）', () => {
    assert.deepEqual(te.headingDescriptor('3'), { level: 1, bold: true, tone: 'h1', prominent: true });
  });

  // 第二个洞：放大判据写作 `lvl <= 2`，没有下界。0 与 -1 根本不是标题级别
  // （headingDescriptor 把它们夹回 1），却在双宽门里命中 H1/H2 分支，
  // 于是非法级别照样往终端发 DEC 双宽控制序列。
  test('bigHeadingPrefix(0) / (-1) 交出控制序列，尽管仓里不存在 0 级标题', () => {
    const on = { KHY_TYPESET_BIG_HEADINGS: '1' };
    assert.strictEqual(te.bigHeadingPrefix(0, on), te.DEC_DOUBLE_WIDTH);
    assert.strictEqual(te.bigHeadingPrefix(-1, on), te.DEC_DOUBLE_WIDTH);
    assert.strictEqual(te.headingDescriptor(0).level, 1);
  });

  test('非有限值（NaN/Infinity/对象/布尔）一律落 H1 分支并发出序列', () => {
    const on = { KHY_TYPESET_BIG_HEADINGS: '1' };
    for (const v of [NaN, Infinity, -Infinity, true, null, undefined, {}, []]) {
      assert.strictEqual(te.bigHeadingPrefix(v, on), te.DEC_DOUBLE_WIDTH, String(v));
    }
  });
});
