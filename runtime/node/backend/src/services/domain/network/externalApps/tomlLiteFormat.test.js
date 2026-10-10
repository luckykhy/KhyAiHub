'use strict';

/**
 * tomlLiteFormat.test.js — 钉死 tomlLite 的**写入侧**（stringify / emit 族）。
 *
 * 为什么这支套件必须存在：本叶子被 tomlLite.js 再导出为公共 `stringify`，deepseekTui/reasonix
 * 每次 add/remove 都靠它把内存对象落盘成 config.toml。它的「顺序（标量→子表→表数组）」、
 * 「空白行折叠」、以及「对无法表达的值抛错」三件事，直接决定写出的 TOML 能不能被自家 parse
 * 读回。尤其 `_isPlainObject` 用的是宽判定（含 Date/类实例），会把本不该当表的东西发落成
 * `[key]`——这是最容易被忽视的写出侧坑，必须钉。
 *
 * 实测更正（与源码注释/直觉不同处，按真实语义钉死）：
 *   · stringify 只接受「plain object」；null / undefined / 字符串 / 数组都抛
 *     `stringify expects a plain object`。
 *   · 值里的 undefined / null 抛 `cannot stringify scalar`（不是静默丢键）。
 *   · 数组里再套数组或对象抛 `nested/table arrays unsupported`。
 *   · Date 因 utils/isPlainObject 的宽语义被当作子表 → {x:new Date(0)} 发落成 `[x]\n`（空表），
 *     **不抛**——这是写入侧最反直觉的一处，按实测钉住（f(null) 抛，f(date) 不抛）。
 *   · 键名非 [A-Za-z0-9_-] 时加双引号；字符串值转义 \\ \" \n。
 *   · 输出规整：连续 3+ 换行折叠为 2、去首换行、尾强制单换行。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { stringify } = require('./tomlLiteFormat');
const toml = require('./tomlLite');

test('写入侧与读取侧再导出的 stringify 是同一函数引用', () => {
  assert.strictEqual(toml.stringify, stringify);
});

// ── 标量 / 数组 ──────────────────────────────────────────────────────────────

test('stringify 标量：字符串加引号并转义，数字/布尔原样字面量', () => {
  assert.strictEqual(stringify({ a: 'x', b: 1, c: true, d: false }), 'a = "x"\nb = 1\nc = true\nd = false\n');
  assert.strictEqual(stringify({ q: 'he said "hi"' }), 'q = "he said \\"hi\\""\n');
  assert.strictEqual(stringify({ nl: 'line1\nline2' }), 'nl = "line1\\nline2"\n');
});

test('stringify 标量数组 → 行内数组 [ "a", "b" ]（逗号+空格）', () => {
  assert.strictEqual(stringify({ x: ['a', 'b'] }), 'x = ["a", "b"]\n');
  assert.strictEqual(stringify({ n: [1, 2] }), 'n = [1, 2]\n');
});

// ── 子表 / 表数组 / 顺序 ─────────────────────────────────────────────────────

test('stringify 子表发落成 [sub]，且标量先于子表（顺序契约）', () => {
  const out = stringify({ top: 1, sub: { k: 'v' } });
  assert.strictEqual(out, 'top = 1\n\n[sub]\nk = "v"\n');
});

test('stringify 数组元素全为对象 → 表数组 [[p]]，逐元素展开', () => {
  assert.strictEqual(stringify({ p: [{ n: 'a' }, { n: 'b' }] }), '[[p]]\nn = "a"\n\n[[p]]\nn = "b"\n');
});

test('stringify 空对象 → 空串（不抛，不产任何行）', () => {
  assert.strictEqual(stringify({}), '');
});

test('stringify 空白规整：多子表间的连续空行折叠为单个空行、末尾单换行', () => {
  const out = stringify({ a: { x: 1 }, b: { y: 2 } });
  assert.doesNotMatch(out, /\n{3,}/, '不得残留 3+ 连续换行');
  assert.match(out, /\n$/, '末尾恰一个换行');
  assert.ok(out.includes('[a]') && out.includes('[b]'));
});

// ── 键名引号 ────────────────────────────────────────────────────────────────

test('stringify 对含空格/特殊字符的键名加双引号；合法裸键不加', () => {
  assert.strictEqual(stringify({ 'a b': 1 }), '"a b" = 1\n');
  assert.strictEqual(stringify({ 'ok-key_2': 1 }), 'ok-key_2 = 1\n');
});

// ── 抛错面（不可表达值必须抛，防误写坏配置）──────────────────────────────────

test('stringify 对非 plain-object 顶层（null/undefined/字符串/数组）抛 expects a plain object', () => {
  for (const bad of [null, undefined, 'str', [1, 2], 42]) {
    assert.throws(() => stringify(bad), /stringify expects a plain object/, `顶层 ${String(bad)} 应抛`);
  }
});

test('stringify 对 undefined/null 标量值抛 cannot stringify scalar（不静默丢键）', () => {
  assert.throws(() => stringify({ x: undefined }), /cannot stringify scalar/);
  assert.throws(() => stringify({ x: null }), /cannot stringify scalar/);
  assert.throws(() => stringify({ x: NaN }), /cannot stringify scalar/, 'NaN 非有限数字也抛');
});

test('stringify 对嵌套数组/表数组抛 nested/table arrays unsupported', () => {
  assert.throws(() => stringify({ x: [[1]] }), /nested\/table arrays unsupported/);
  assert.throws(() => stringify({ x: [{ a: 1 }, 2] }), /nested\/table arrays unsupported/, '混合类型数组抛');
});

test('实测钉住：Date 值因宽 isPlainObject 被当子表发落成 [x]，不抛（与 null 抛形成反差）', () => {
  // f(null) 抛、f(new Date()) 不抛——这条记录了写入侧最反直觉的分支
  assert.strictEqual(stringify({ x: new Date(0) }), '[x]\n');
});
