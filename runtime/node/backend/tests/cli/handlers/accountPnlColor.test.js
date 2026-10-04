'use strict';

/**
 * routerHandlers.formatPnl — 账户「累计盈亏」单元格的着色契约。
 *
 * 回归:老代码 `(totalProfit >= 0 ? chalk.red('+') : chalk.green('')) + ¥...`
 * 给**空串**上绿色,亏损单元格因此完全没有颜色(作者本意「绿跌」被静默丢弃);
 * 且颜色只包住 `+` 字形、金额本身不上色,正号在 ¥ 前(`+¥`)而负号在 ¥ 后(`¥-`)。
 * 修复:整段金额用红/绿包裹,符号统一置于 ¥ 之前。
 */

const test = require('node:test');
const assert = require('node:assert');

const { createRouterHandlers } = require('../../../src/cli/routerHandlers');

// 记录型假 chalk:把颜色名与内容都留在结果里,便于断言「哪个色包住了什么」。
function mkChalk() {
  const paint = (name) => (s) => `${name}<${s}>`;
  return {
    red: paint('red'),
    green: paint('green'),
    bold: paint('bold'),
    dim: paint('dim'),
    cyan: paint('cyan'),
    yellow: paint('yellow'),
    gray: paint('gray'),
    white: paint('white'),
  };
}

function getFormatPnl() {
  const handlers = createRouterHandlers({
    logDir: '/tmp',
    fmt: () => ({
      printError: () => {},
      printSuccess: () => {},
      printInfo: () => {},
      printWarn: () => {},
      printTable: () => {},
    }),
    chk: mkChalk,
    symResolver: () => ({ resolveSymbol: async () => ({ matched: false }) }),
  });
  return handlers.formatPnl;
}

test('formatPnl: loss is painted GREEN over the full amount (regression: green("") was colorless)', () => {
  const formatPnl = getFormatPnl();
  assert.strictEqual(formatPnl(-5000, mkChalk()), 'green<-¥5000.00>');
});

test('formatPnl: gain is painted RED over the full amount', () => {
  const formatPnl = getFormatPnl();
  assert.strictEqual(formatPnl(5000, mkChalk()), 'red<+¥5000.00>');
});

test('formatPnl: zero counts as gain → red, keeps + sign', () => {
  const formatPnl = getFormatPnl();
  assert.strictEqual(formatPnl(0, mkChalk()), 'red<+¥0.00>');
});

test('formatPnl: the painted payload is never empty (the old bug colored "")', () => {
  const formatPnl = getFormatPnl();
  for (const v of [-5000, 5000, 0, -0.01]) {
    const m = /^(red|green)<(.*)>$/.exec(formatPnl(v, mkChalk()));
    assert.ok(m, `output must be color-wrapped: ${formatPnl(v, mkChalk())}`);
    assert.ok(m[2].length > 0, `painted content must be non-empty for v=${v}`);
  }
});

test('formatPnl: sign placement is consistent (before ¥) for both branches', () => {
  const formatPnl = getFormatPnl();
  assert.ok(formatPnl(1234, mkChalk()).includes('<+¥'));
  assert.ok(formatPnl(-1234, mkChalk()).includes('<-¥'));
});
