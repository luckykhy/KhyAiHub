'use strict';

/**
 * jsonSchemaValidate.test.js — 钉死零依赖 JSON Schema 子集校验器的对外契约：
 * 无 schema 即放行、绝不抛、错误带 JSON-Pointer 路径、以及若干「宽松而非严格」
 * 的刻意取舍。
 *
 * 为什么这支套件必须存在：这是 headless 结构化输出模式里唯一的「数据 ⊨ schema?」
 * 尺子。它的失败语义（宽松放行 vs 严格拒绝）直接决定模型自纠提示的内容；文件头
 * 声称「绝不抛」「未知 type 不约束」，这些承诺只有测试能守住。
 *
 * 实测更正（与 JSON Schema 标准/直觉不同处，按真实语义钉死）：
 *   · schema=false 拒绝一切、schema=true 放行一切（布尔 schema 走 _validate）；
 *     而 null/undefined/非对象非布尔 → pass-through 视为**通过**（无 schema 不约束）。
 *   · 未知 type 字符串（如 "int"）→ _matchesType 默认 true，宽松放行。
 *   · 非法 pattern 正则被吞掉（re=null）→ 该约束**静默失效**，不报错也不拒。
 *   · type 不符时提前 return，只报一条类型错，不连锁报属性错。
 *   · items 只支持单 schema；数组形态（tuple）被整个跳过不校验。
 *   · 递归深度 > 64 的部分诚实放行（return true）。
 *   · 抛异常的 data（getter throw）会命中防御 catch →
 *     {valid:false, errors:[{path:'', message:'schema validation aborted (malformed schema)'}]}。
 *   · formatSchemaErrors 对根路径（''）显示 'root'，缺 message 显示 'invalid'。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAgainstSchema, formatSchemaErrors } = require('./jsonSchemaValidate');

test('无 schema 即放行；布尔 schema 走严格语义', () => {
  assert.deepEqual(validateAgainstSchema({ a: 1 }, null), { valid: true, errors: [] });
  assert.deepEqual(validateAgainstSchema({ a: 1 }, undefined), { valid: true, errors: [] });
  assert.deepEqual(validateAgainstSchema('x', 'not-a-schema'), { valid: true, errors: [] });
  assert.equal(validateAgainstSchema('x', true).valid, true);
  const failAll = validateAgainstSchema('x', false);
  assert.equal(failAll.valid, false);
  assert.match(failAll.errors[0].message, /schema=false/);
});

test('type 判定：integer 与 number 区分、联合数组、未知 type 宽松放行', () => {
  assert.equal(validateAgainstSchema(2, { type: 'integer' }).valid, true);
  assert.equal(validateAgainstSchema(2.5, { type: 'integer' }).valid, false);
  assert.equal(validateAgainstSchema(2.5, { type: 'number' }).valid, true);
  assert.equal(validateAgainstSchema(NaN, { type: 'number' }).valid, false); // 非有限不算 number
  assert.equal(validateAgainstSchema('s', { type: ['number', 'string'] }).valid, true);
  // 实测更正：未知 type 不约束（宽松，绝不假阳性拒）
  assert.equal(validateAgainstSchema({ any: 1 }, { type: 'int' }).valid, true);
  // type 不符时提前返回，只有一条错误，不连锁
  const r = validateAgainstSchema({ a: 1 }, { type: 'string', minLength: 5 });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /expected type string/);
});

test('nullable 只在值为 null 时短路放行，其余约束照常', () => {
  assert.equal(validateAgainstSchema(null, { type: 'string', nullable: true }).valid, true);
  assert.equal(validateAgainstSchema(null, { type: 'string' }).valid, false);
  assert.equal(validateAgainstSchema(42, { type: 'string', nullable: true }).valid, false);
});

test('对象：required / properties / additionalProperties(bool 与 schema 两形态)', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'integer' } },
    required: ['name'],
    additionalProperties: false,
  };
  assert.equal(validateAgainstSchema({ name: 'a', age: 3 }, schema).valid, true);
  const miss = validateAgainstSchema({ age: 3 }, schema);
  assert.equal(miss.valid, false);
  assert.match(miss.errors[0].message, /missing required property "name"/);
  const extra = validateAgainstSchema({ name: 'a', city: 'x' }, schema);
  assert.match(extra.errors[0].message, /additional property "city"/);
  // additionalProperties 为 schema：按类型约束扩展键，错误路径带指针
  const r = validateAgainstSchema(
    { name: 'a', city: 1 },
    { properties: { name: {} }, additionalProperties: { type: 'string' } }
  );
  assert.equal(r.valid, false);
  assert.equal(r.errors[0].path, '/city');
});

test('错误路径是 JSON-Pointer 形态：对象嵌套与数组下标', () => {
  const schema = {
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } },
    },
  };
  const r = validateAgainstSchema({ items: [{ n: 1 }, {}] }, schema);
  assert.equal(r.valid, false);
  // 实测更正：required 错误报在对象自身路径上，不是缺失键的路径
  assert.equal(r.errors[0].path, '/items/1');
  assert.match(r.errors[0].message, /missing required property "n"/);
  // 子键类型错误才落在键路径上
  const r2 = validateAgainstSchema({ items: [{ n: 1.5 }] }, schema);
  assert.equal(r2.errors[0].path, '/items/0/n');
});

test('字符串：minLength/maxLength/pattern；非法 pattern 静默失效（实测更正）', () => {
  assert.equal(validateAgainstSchema('ab', { type: 'string', minLength: 3 }).valid, false);
  assert.equal(validateAgainstSchema('abcd', { type: 'string', maxLength: 3 }).valid, false);
  assert.equal(validateAgainstSchema('a1', { pattern: '^[a-z][0-9]$' }).valid, true);
  assert.equal(validateAgainstSchema('1a', { pattern: '^[a-z][0-9]$' }).valid, false);
  // 坏正则不抛也不拒——该约束被吞掉
  assert.equal(validateAgainstSchema('anything', { pattern: '([unclosed' }).valid, true);
});

test('数值：minimum/maximum 闭区间，exclusive 开区间', () => {
  assert.equal(validateAgainstSchema(5, { minimum: 5, maximum: 5 }).valid, true);
  assert.equal(validateAgainstSchema(5, { exclusiveMinimum: 5 }).valid, false);
  assert.equal(validateAgainstSchema(5, { exclusiveMaximum: 5 }).valid, false);
  assert.equal(validateAgainstSchema(5.1, { exclusiveMinimum: 5 }).valid, true);
});

test('数组：minItems/maxItems/uniqueItems；tuple 形态 items 被跳过（实测更正）', () => {
  assert.equal(validateAgainstSchema([1, 1], { uniqueItems: true }).valid, false);
  assert.equal(validateAgainstSchema([1, 2], { uniqueItems: true }).valid, true);
  assert.equal(validateAgainstSchema([1], { minItems: 2 }).valid, false);
  assert.equal(validateAgainstSchema([1, 2, 3], { maxItems: 2 }).valid, false);
  // 数组形态 items（tuple）不校验——整个关键字被忽略
  assert.equal(validateAgainstSchema([['x'], 'y'], { items: [{ type: 'integer' }, { type: 'integer' }] }).valid, true);
});

test('组合：allOf 全过、anyOf 至少一、oneOf 恰好一（0 或 2 都拒）', () => {
  assert.equal(validateAgainstSchema(5, { allOf: [{ type: 'integer' }, { minimum: 6 }] }).valid, false);
  assert.equal(validateAgainstSchema(5, { anyOf: [{ type: 'string' }, { type: 'integer' }] }).valid, true);
  assert.equal(validateAgainstSchema(5, { anyOf: [{ type: 'string' }] }).valid, false);
  // oneOf 匹配 2 个 → 拒，报错里带 matched 数
  const two = validateAgainstSchema(5, { oneOf: [{ type: 'number' }, { type: 'integer' }] });
  assert.equal(two.valid, false);
  assert.match(two.errors[0].message, /matched 2/);
});

test('const/enum 用深比较，非原始值也认', () => {
  assert.equal(validateAgainstSchema({ a: [1, 2] }, { const: { a: [1, 2] } }).valid, true);
  assert.equal(validateAgainstSchema({ a: [1, 3] }, { const: { a: [1, 2] } }).valid, false);
  assert.equal(validateAgainstSchema('b', { enum: ['a', 'b'] }).valid, true);
  assert.equal(validateAgainstSchema('c', { enum: ['a', 'b'] }).valid, false);
  assert.equal(validateAgainstSchema(null, { enum: [null] }).valid, true);
});

test('绝不抛：data 上的 poison getter 命中防御 catch，报诚实错误而非崩溃', () => {
  const data = {
    get a() {
      throw new Error('boom');
    },
  };
  const r = validateAgainstSchema(data, { properties: { a: { type: 'string' } } });
  assert.equal(r.valid, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /aborted \(malformed schema\)/);
});

test('超深 schema（>64 层）诚实放行，不爆栈', () => {
  let schema = { type: 'string' };
  for (let i = 0; i < 70; i++) schema = { allOf: [schema] };
  // 深到顶之后不再校验：整数 1 也能过
  assert.equal(validateAgainstSchema(1, schema).valid, true);
});

test('formatSchemaErrors：空数组回空串、根路径显示 root、缺字段降级', () => {
  assert.equal(formatSchemaErrors([]), '');
  assert.equal(formatSchemaErrors(null), '');
  assert.equal(formatSchemaErrors([{ path: '', message: 'bad' }]), 'root: bad');
  assert.equal(formatSchemaErrors([{ path: '/a', message: 'x' }, {}]), '/a: x; root: invalid');
});
