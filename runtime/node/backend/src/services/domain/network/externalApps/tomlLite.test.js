'use strict';

/**
 * tomlLite.test.js — 钉死零依赖 TOML 读取子集（parse）与其对 stringify 的再导出。
 *
 * 为什么这支套件必须存在：本叶子是 deepseekTui / reasonix 两个 adapter 的配置读写底座，
 * 后端不引任何 TOML 库。它的核心契约是「对无法识别的构造**显式抛错**」——因为静默误解析
 * 会把错值写坏用户真实 config.toml。因此「哪些构造抛、哪些不抛」本身就是必须钉死的行为面。
 * 同时 tomlLite 公共面只有 parse/stringify 两个键（stringify 是从 ./tomlLiteFormat 再导出），
 * 一旦有人误改导出面或删除再导出，adapter 会直接崩。
 *
 * 实测更正（与源码注释/直觉不同处，按真实语义钉死）：
 *   · 字面字符串（单引号）**不反转义**：'no\nescape' 原样保留反斜杠；只有双引号基本串处理 \n\t\r\"\\。
 *   · 行内注释剥离只在「引号外」认 #：值里含 #（"has # inside"）不被截。
 *   · parse 抛错的具体消息因构造而异（unrecognized value / unterminated array /
 *     unterminated inline table / cannot parse line）——测试按正则匹配前缀而非整串，防脆。
 *   · 数字容忍前导 +/-；浮点必须 `\.\d+`（".5" 无整数部分仍走 /^[+-]?\d*\.\d+$/ 命中）。
 *   · 布尔只认小写 true/false，其它一律 unrecognized（"True" 抛）。
 *   · stringify 非本文件实现，仅验证再导出的键名与可调用性；行为在 tomlLiteFormat.test.js 钉。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const toml = require('./tomlLite');

// ── 导出面 ──────────────────────────────────────────────────────────────────

test('tomlLite 恰导出 parse / stringify 两个公共键', () => {
  assert.deepStrictEqual(Object.keys(toml).sort(), ['parse', 'stringify']);
  assert.strictEqual(typeof toml.parse, 'function');
  assert.strictEqual(typeof toml.stringify, 'function');
});

// ── parse：标量子集 ──────────────────────────────────────────────────────────

test('parse 顶层标量：字符串/整数/布尔/浮点/字符串数组一次覆盖（输入非空）', () => {
  const out = toml.parse('a = "x"\nb = 5\nc = true\nd = 1.5\ne = ["a", "b"]');
  assert.deepStrictEqual(out, { a: 'x', b: 5, c: true, d: 1.5, e: ['a', 'b'] });
});

test('parse 空/纯空白/纯注释文本 → 空对象（不抛）', () => {
  assert.deepStrictEqual(toml.parse(''), {});
  assert.deepStrictEqual(toml.parse('   \n\n'), {});
  assert.deepStrictEqual(toml.parse('# just a comment\n# another'), {});
  assert.deepStrictEqual(toml.parse(null), {});
});

test('parse 数字容忍前导 +/- 与前导小数点；负浮点命中', () => {
  assert.deepStrictEqual(toml.parse('a = +5\nb = -3\nc = .5\nd = -1.25'), { a: 5, b: -3, c: 0.5, d: -1.25 });
});

test('parse 布尔只认小写：True/TRUE 抛（实测 unrecognized value）', () => {
  assert.deepStrictEqual(toml.parse('k = false'), { k: false });
  assert.throws(() => toml.parse('k = True'), /unrecognized value/);
});

// ── parse：字符串转义 ────────────────────────────────────────────────────────

test('parse 基本字符串（双引号）反转义 \\n \\t \\r \\" \\\\；字面字符串（单引号）原样保留', () => {
  assert.deepStrictEqual(toml.parse('k = "tab\\there"'), { k: 'tab\there' });
  assert.deepStrictEqual(toml.parse('k = "q\\"x"'), { k: 'q"x' });
  // 实测：单引号字面串不做反转义，反斜杠原样进值
  assert.deepStrictEqual(toml.parse("k = 'no\\nescape'"), { k: 'no\\nescape' });
});

test('parse 剥离引号外的行内注释，但不截引号内的 #（值含 # 完整保留）', () => {
  assert.deepStrictEqual(toml.parse('k = "v"   # trailing comment\nd = "has # inside"'), {
    k: 'v',
    d: 'has # inside',
  });
});

// ── parse：表 / 表数组 / 点分 ───────────────────────────────────────────────

test('parse 具名表与点分表名 → 嵌套对象', () => {
  assert.deepStrictEqual(toml.parse('[ui]\nx=1\n[providers.deepseek]\ny="z"'), {
    ui: { x: 1 },
    providers: { deepseek: { y: 'z' } },
  });
});

test('parse 表数组 [[p]] → 对象数组，两次进入产两元素', () => {
  assert.deepStrictEqual(toml.parse('[[p]]\nn="a"\n[[p]]\nn="b"'), { p: [{ n: 'a' }, { n: 'b' }] });
});

test('parse 行内表 key = { a = "x", b = 1 }', () => {
  assert.deepStrictEqual(toml.parse('k = { a = "x", b = 1 }'), { k: { a: 'x', b: 1 } });
});

test('parse 点分键在表内写入嵌套（a.b = 1）', () => {
  assert.deepStrictEqual(toml.parse('a.b = 1'), { a: { b: 1 } });
});

// ── parse：显式抛错面（不可识别构造必须抛，绝不静默）──────────────────────────

test('parse 对五类不可识别构造逐一显式抛错（误解析防线）', () => {
  const cases = [
    ['key = @@@', /unrecognized value/],
    ['[unclosed', /cannot parse line/],
    ['x = [1', /unterminated array/],
    ['x = {a=1', /unterminated inline table/],
    ['noEqualsHere', /cannot parse line/],
  ];
  let threw = 0;
  for (const [src, re] of cases) {
    assert.throws(() => toml.parse(src), re, `应对 ${src} 抛错`);
    threw += 1;
  }
  assert.strictEqual(threw, cases.length, '至少验证 5 个抛错分支（非空转）');
});

test('parse 空值（key =）抛 empty value', () => {
  assert.throws(() => toml.parse('k ='), /empty value/);
});

test('parse 空数组 [] → []；空行内表 {} → {}', () => {
  assert.deepStrictEqual(toml.parse('a = []\nb = {}'), { a: [], b: {} });
});

// ── round-trip（parse ∘ stringify）──────────────────────────────────────────

test('round-trip：本子集内对象 stringify 再 parse 字段等价（读写侧对齐）', () => {
  const src = { a: 'x', n: 2, arr: ['p', 'q'], sub: { k: true }, tab: [{ z: 1 }] };
  const back = toml.parse(toml.stringify(src));
  assert.deepStrictEqual(back, src);
});
