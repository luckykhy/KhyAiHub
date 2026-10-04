'use strict';

/**
 * cardClick.test.js — [DESIGN-ARCH-146] 卡片点击的**门控与命中纯逻辑**验证。
 *
 * 这些是「没有断言就没有约束」最容易失守的地方：门控族的 falsy 语义、行下标越界收束、
 * 展开态切换。全部离线（不渲染 ink、不起终端），因此坏掉时能一眼定位到本模块。
 *
 * ⚠ 反向对照是硬要求：每条断言都要能**在改坏实现时变红**。例如门控用例同时钉住
 * 「显式 falsy 关」与「unset 开」两个方向，只钉一边的实现（恒关或恒开）都会被抓到。
 */

const test = require('node:test');
const assert = require('node:assert');

const cardClick = require('../../src/cli/tui/ink-components/cardClick');

// ── 门控：KHY_CARD_CLICK ────────────────────────────────────────────────────

test('cardClickEnabled: unset 时开（门控族口径：只有显式 falsy 才关）', () => {
  assert.strictEqual(cardClick.cardClickEnabled({}, true), true);
});

test('cardClickEnabled: 显式 falsy 族全部关闭', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' false ', 'No']) {
    assert.strictEqual(
      cardClick.cardClickEnabled({ KHY_CARD_CLICK: v }, true),
      false,
      `KHY_CARD_CLICK=${JSON.stringify(v)} 应关闭点击`
    );
  }
});

test('cardClickEnabled: 非 falsy 值（含 "1"/"on"/无意义串）开启', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
    assert.strictEqual(
      cardClick.cardClickEnabled({ KHY_CARD_CLICK: v }, true),
      true,
      `KHY_CARD_CLICK=${JSON.stringify(v)} 应开启点击`
    );
  }
});

test('cardClickEnabled: 鼠标档位否决优先于门控 —— 档位不允许则恒关', () => {
  // 这条是「两条同时成立」的对照：门控开着，但档位说不行（主屏 / 未识别终端）⇒ 关。
  assert.strictEqual(cardClick.cardClickEnabled({}, false), false);
  assert.strictEqual(cardClick.cardClickEnabled({ KHY_CARD_CLICK: '1' }, false), false);
});

test('cardClickEnabled: 缺省第二参时向 mouseButtons 求值且不抛', () => {
  // 不传 buttonsEnabled → 惰性 require mouseButtons；无论环境如何都必须返回布尔、不得抛。
  // （原实现对 require 失败 fail-soft，缺依赖不该让整张开卡崩掉。）
  const r = cardClick.cardClickEnabled({});
  assert.strictEqual(typeof r, 'boolean');
});

// ── 行下标收束 ──────────────────────────────────────────────────────────────

test('normalizeRowIndex: 合法下标原样返回', () => {
  assert.strictEqual(cardClick.normalizeRowIndex(0, 3), 0);
  assert.strictEqual(cardClick.normalizeRowIndex(2, 3), 2);
});

test('normalizeRowIndex: 越界与非法值一律 null（不得回落成第 0 行）', () => {
  // 反向对照：若实现写成 `n || 0` 或 `Math.max(0, n)`，越界会被**静默**算成第 0 行 ——
  // 用户点空白处反而选中第一项，这是最坏的一类 bug。
  assert.strictEqual(cardClick.normalizeRowIndex(3, 3), null);
  assert.strictEqual(cardClick.normalizeRowIndex(-1, 3), null);
  assert.strictEqual(cardClick.normalizeRowIndex(1.5, 3), null);
  assert.strictEqual(cardClick.normalizeRowIndex(NaN, 3), null);
  assert.strictEqual(cardClick.normalizeRowIndex(undefined, 3), null);
  assert.strictEqual(cardClick.normalizeRowIndex(null, 3), null);
  assert.strictEqual(cardClick.normalizeRowIndex('2', 3), null); // 只认真整数
});

test('normalizeRowIndex: rowCount 非法（0 / 负 / 非数）恒 null', () => {
  assert.strictEqual(cardClick.normalizeRowIndex(0, 0), null);
  assert.strictEqual(cardClick.normalizeRowIndex(0, -1), null);
  assert.strictEqual(cardClick.normalizeRowIndex(0, undefined), null);
});

// ── 展开态切换 ──────────────────────────────────────────────────────────────

test('toggleExpandedRow: 点同一行 = 收起（切换语义）', () => {
  assert.strictEqual(cardClick.toggleExpandedRow(1, 1), null);
  assert.strictEqual(cardClick.toggleExpandedRow(null, null), null);
});

test('toggleExpandedRow: 点另一行 = 改展开它（至多一行展开）', () => {
  assert.strictEqual(cardClick.toggleExpandedRow(0, 2), 2);
  assert.strictEqual(cardClick.toggleExpandedRow(null, 0), 0);
});

test('toggleExpandedRow: 非整数目标视为收起', () => {
  assert.strictEqual(cardClick.toggleExpandedRow(0, undefined), null);
  assert.strictEqual(cardClick.toggleExpandedRow(0, 1.5), null);
});

// ── 可展开性判据 ────────────────────────────────────────────────────────────

test('expandable: 有完整说明且与当前渲染不同 ⇒ 可展开', () => {
  assert.strictEqual(cardClick.expandable('很长很长的完整说明', '很长很长…'), true);
});

test('expandable: 空说明不可展开（展开会凭空多出一对空白）', () => {
  assert.strictEqual(cardClick.expandable('', '  — x'), false);
  assert.strictEqual(cardClick.expandable('   ', ''), false);
  assert.strictEqual(cardClick.expandable(null, ''), false);
  assert.strictEqual(cardClick.expandable(undefined, undefined), false);
});

test('expandable: 说明已完整显示 ⇒ 不可展开（没有「另一半」）', () => {
  assert.strictEqual(cardClick.expandable('完整说明', '完整说明'), false);
  assert.strictEqual(cardClick.expandable('  完整说明  ', '完整说明'), false);
});

// ── 展开行文本 ──────────────────────────────────────────────────────────────

test('expandLine: 首行保留 head，说明独占后续行', () => {
  const out = cardClick.expandLine('   ❯ 1. [x] 选项甲', '这是完整说明');
  assert.strictEqual(out, '   ❯ 1. [x] 选项甲\n这是完整说明');
});

test('expandLine: 空说明退化为 head 单行（不产生空行）', () => {
  assert.strictEqual(cardClick.expandLine('head', ''), 'head');
  assert.strictEqual(cardClick.expandLine('head', null), 'head');
});

test('OFF_VALUES: 与仓内门控族同源', () => {
  assert.deepStrictEqual(cardClick.OFF_VALUES, ['0', 'false', 'off', 'no']);
});
