'use strict';
// commandHelp 纯叶子契约:别名归一、三级描述回退、近似建议、零抛。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const LEAF = path.join(path.resolve(__dirname, '..', '..'), 'src/constants/commandHelp.js');

test('canonicalize:无连字符/简写变体归一到主名', () => {
  const { canonicalize } = require(LEAF);
  assert.strictEqual(canonicalize('adddir'), 'add-dir');
  assert.strictEqual(canonicalize('quit'), 'exit');
  assert.strictEqual(canonicalize('forest'), 'topology');
  assert.strictEqual(canonicalize('SHORTCUTS'), 'keybindings');
  assert.strictEqual(canonicalize('doctor'), 'doctor', '主名原样返回');
});

test('getHelp:EXTRA → slash → null 三级回退', () => {
  const { getHelp } = require(LEAF);
  assert.strictEqual(getHelp('quote').description, '查询实时行情');
  assert.strictEqual(getHelp('stickers').description, '趣味贴纸', 'slash 表描述');
  assert.strictEqual(getHelp('zz-no-such'), null);
  assert.strictEqual(getHelp(''), null);
  assert.strictEqual(getHelp(null), null);
});

test('getHelp:别名拼写直接解析到主名描述', () => {
  const { getHelp } = require(LEAF);
  assert.match(getHelp('adddir').description, /工作目录/);
});

test('suggest:前缀命中排前、编辑距离兜底、全不近时空', () => {
  const { suggest } = require(LEAF);
  const names = ['backtest', 'backup', 'branch', 'doctor', 'quote'];
  // 前缀命中同分时按名长度升序（确定性契约，非随机）
  assert.deepStrictEqual(suggest('back', names, { limit: 2 }), ['backup', 'backtest']);
  assert.ok(suggest('bacstest', names).includes('backtest'), '编辑距离 2 应命中');
  assert.deepStrictEqual(suggest('zzzzqqqq', names), []);
  assert.deepStrictEqual(suggest('', names), []);
});
