'use strict';

// 单元契约测试：width.js 的显示宽度 SSOT 契约——CJK 记 2、ANSI 序列记 0、
// 截断保留可见宽度上界，以及「线性截断」门控关闭时回退 legacy 支路。
// 注意：本文件一律用 String.fromCharCode(27) 造 ESC，源码里不出现裸控制字节。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const w = require('./width');
const ESC = String.fromCharCode(27);

test('导出面', () => {
  assert.deepEqual(Object.keys(w).sort(), [
    '_truncateAnsiLinearEnabled',
    '_truncateToWidthLegacy',
    'displayWidth',
    'padToWidth',
    'stripAnsi',
    'truncateToWidth',
  ]);
});

test('叶子契约：不 require cli/，不读终端尺寸', () => {
  const src = fs.readFileSync(path.join(__dirname, 'width.js'), 'utf8');
  assert.ok(!/require\(['"]\.\.[\/\\]cli/.test(src), 'width 不得伸回 cli/');
  assert.ok(!src.includes('process.stdout.columns'), '终端列宽属 CLI 呈现关注点，留在 formatters');
});

test('displayWidth：CJK 记 2，ASCII 记 1，ANSI 序列记 0', () => {
  assert.equal(w.displayWidth(''), 0);
  assert.equal(w.displayWidth('abc'), 3);
  assert.equal(w.displayWidth('标题'), 4);
  assert.equal(w.displayWidth(`${ESC}[1m标题${ESC}[0m`), 4);
  assert.equal(w.displayWidth(`${ESC}]0;窗口标题${ESC}\\`), 0);
});

test('真彩色/私有参数的 CSI 整条剥掉，数字不得被计入宽度（与 wrapCell 同步的锁）', () => {
  const truecolor = `${ESC}[38:2:255:128:0m红色${ESC}[39m`;
  assert.equal(w.displayWidth(truecolor), 4, 'SGR 参数数字被计量 = 行预算漂移');
});

test('stripAnsi 去色，padToWidth 按显示宽度补齐', () => {
  assert.equal(w.stripAnsi(`${ESC}[31mred${ESC}[39m`), 'red');
  assert.equal(w.padToWidth('ab', 6), 'ab    ');
  assert.equal(w.padToWidth('标题', 6), '标题  ');
  assert.equal(w.padToWidth('已经很长了', 3), '已经很长了', '只需补足，不裁剪');
});

test('truncateToWidth：够宽原样返回，超宽加省略号且不越上界', () => {
  assert.equal(w.truncateToWidth('abcdef', 6), 'abcdef');
  const t = w.truncateToWidth('abcdefghij', 6);
  assert.ok(t.endsWith('...'), t);
  assert.ok(w.displayWidth(t) <= 6, `width=${w.displayWidth(t)}`);
  const cjk = w.truncateToWidth('这是一个很长的中文标题串', 8);
  assert.ok(w.displayWidth(cjk) <= 8, `cjk width=${w.displayWidth(cjk)}`);
});

test('门控 KHY_TRUNCATE_ANSI_LINEAR：缺省开，关闭后走 legacy 支路且仍不越上界', () => {
  const key = 'KHY_TRUNCATE_ANSI_LINEAR';
  const saved = process.env[key];
  try {
    delete process.env[key];
    assert.equal(w._truncateAnsiLinearEnabled(), true);
    assert.equal(w.truncateToWidth('abcdefghij', 6), w.truncateToWidth('abcdefghij', 6));

    process.env[key] = '0';
    assert.equal(w._truncateAnsiLinearEnabled(), false);
    const legacy = w.truncateToWidth('这是一个很长的中文标题串', 8);
    assert.equal(legacy, w._truncateToWidthLegacy('这是一个很长的中文标题串', 8));
    assert.ok(w.displayWidth(legacy) <= 8, `legacy width=${w.displayWidth(legacy)}`);
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

test('截断保留完整色序（零宽计费），去色后不得残留参数字节', () => {
  const seq = `${ESC}[38:2:255:128:0m`;
  const s = `${seq}这是一个很长的中文标题串${ESC}[39m`;
  const t = w.truncateToWidth(s, 10);
  // 色序必须**整条**原样保留（截断丢色 = 变色），计费为零；脱色后的可见文本里不许出现参数字节
  assert.ok(t.startsWith(seq), '色序被截碎 = 残留');
  assert.ok(!/38:2/.test(w.stripAnsi(t)), '参数数字泄漏进可见文本 = 画面残留');
  assert.ok(w.displayWidth(t) <= 10, `width=${w.displayWidth(t)}`);
});

test('垃圾入参绝不抛：非串入参宽度按 0 计并原样透传', () => {
  for (const junk of [null, undefined, 42, {}, []]) {
    assert.doesNotThrow(() => w.displayWidth(junk));
    assert.doesNotThrow(() => w.truncateToWidth(junk, 5));
    assert.doesNotThrow(() => w.padToWidth(junk, 5));
  }
  assert.equal(w.displayWidth(null), 0);
  assert.equal(w.truncateToWidth(undefined, 5), undefined, '够宽即原样返回，不加工');
});
