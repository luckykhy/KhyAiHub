'use strict';

/**
 * actionContractVerifier.test.js — 极小核验器 V + 可机检谓词契约（零 IO、确定性、纯计算）。
 *
 * fail 方向：**fail-closed 铁律**——未知算子 / 畸形节点 / 求值异常 / 超预算一律判不通过
 * （evaluatePredicate→false，verify→{ok:false}），门控关时 V 不工作亦 fail-closed。
 * 刻意语义：predicate 为 null = 「无此约束」→ vacuously true（≠ 放行一切，见 verify）。
 * 逐条钉投毒路径 P1-P8 已物理切断 + 资源硬上限。门控经 env 参数注入（不碰 process.env）。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  isEnabled,
  AXIOMS,
  describeAxioms,
  evaluatePredicate,
  verify,
  canonicalize,
  _get,
  _deepEq,
  MISSING,
} = require('./actionContractVerifier');

test('isEnabled 默认开，仅 falsy token 关闭', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_ACTION_CONTRACT: 'off' }), false);
  assert.strictEqual(isEnabled({ KHY_ACTION_CONTRACT: 'no' }), false);
});

test('AXIOMS 公理集非空、冻结，describeAxioms 返回副本', () => {
  assert.ok(AXIOMS.length > 0, '公理集不得为空');
  assert.ok(Object.isFrozen(AXIOMS));
  const copy = describeAxioms();
  assert.notStrictEqual(copy, AXIOMS);
  assert.deepStrictEqual(copy, AXIOMS.slice());
});

test('MISSING 是冻结的私有哨兵', () => {
  assert.ok(Object.isFrozen(MISSING));
  assert.deepStrictEqual(MISSING, { __khy_missing__: true });
});

test('eq/ne 双侧都钉（值命中与不命中）', () => {
  assert.strictEqual(evaluatePredicate({ op: 'eq', path: 'a', value: 1 }, { a: 1 }), true);
  assert.strictEqual(evaluatePredicate({ op: 'eq', path: 'a', value: 1 }, { a: 2 }), false);
  assert.strictEqual(evaluatePredicate({ op: 'ne', path: 'a', value: 1 }, { a: 2 }), true);
});

test('P1 未知算子 fail-closed 返回 false', () => {
  assert.strictEqual(evaluatePredicate({ op: 'js', src: 'evil()' }, { a: 1 }), false);
});

test('predicate 为 null = 无此约束 → vacuously true', () => {
  assert.strictEqual(evaluatePredicate(null, { a: 1 }), true);
  assert.strictEqual(evaluatePredicate(undefined, { a: 1 }), true);
});

test('门控关时 evaluatePredicate fail-closed 恒 false', () => {
  assert.strictEqual(evaluatePredicate({ op: 'true' }, {}, { KHY_ACTION_CONTRACT: 'off' }), false);
});

test('and/or/not 真值表：空 and 真、空 or 假、not 取反', () => {
  assert.strictEqual(evaluatePredicate({ op: 'and', args: [] }, {}), true);
  assert.strictEqual(evaluatePredicate({ op: 'or', args: [] }, {}), false);
  assert.strictEqual(evaluatePredicate({ op: 'and', args: [{ op: 'true' }, { op: 'false' }] }, {}), false);
  assert.strictEqual(evaluatePredicate({ op: 'or', args: [{ op: 'true' }, { op: 'false' }] }, {}), true);
  assert.strictEqual(evaluatePredicate({ op: 'not', arg: { op: 'true' } }, {}), false);
});

test('exists/absent 路径原子', () => {
  assert.strictEqual(evaluatePredicate({ op: 'exists', path: 'a' }, { a: 1 }), true);
  assert.strictEqual(evaluatePredicate({ op: 'absent', path: 'a' }, {}), true);
  assert.strictEqual(evaluatePredicate({ op: 'exists', path: 'a' }, {}), false);
});

test('type 断言实际类型', () => {
  assert.strictEqual(evaluatePredicate({ op: 'type', path: 'a', value: 'number' }, { a: 1 }), true);
  assert.strictEqual(evaluatePredicate({ op: 'type', path: 'a', value: 'string' }, { a: 1 }), false);
  assert.strictEqual(evaluatePredicate({ op: 'type', path: 'a', value: 'number' }, {}), false);
});

test('序比较要求两侧有限数，否则 fail-closed', () => {
  assert.strictEqual(evaluatePredicate({ op: 'lt', path: 'a', value: 2 }, { a: 1 }), true);
  assert.strictEqual(evaluatePredicate({ op: 'ge', path: 'a', value: 2 }, { a: 2 }), true);
  assert.strictEqual(evaluatePredicate({ op: 'lt', path: 'a', value: 2 }, { a: 'x' }), false);
  assert.strictEqual(evaluatePredicate({ op: 'lt', path: 'a', value: 'x' }, { a: 1 }), false);
});

test('in 成员判定（命中/未命中）', () => {
  assert.strictEqual(evaluatePredicate({ op: 'in', path: 'a', value: [1, 2, 3] }, { a: 2 }), true);
  assert.strictEqual(evaluatePredicate({ op: 'in', path: 'a', value: [1, 2, 3] }, { a: 9 }), false);
});

test('forbiddenKey 命中越权键即不满足、缺失对象视为满足', () => {
  assert.strictEqual(evaluatePredicate({ op: 'forbiddenKey', path: 'o', value: ['force'] }, { o: { force: 1 } }), false);
  assert.strictEqual(evaluatePredicate({ op: 'forbiddenKey', path: 'o', value: ['force'] }, { o: { ok: 1 } }), true);
  assert.strictEqual(evaluatePredicate({ op: 'forbiddenKey', path: 'o', value: ['force'] }, {}), true);
});

test('every/some 有界量词逐元素求值', () => {
  assert.strictEqual(evaluatePredicate({ op: 'every', path: 'l', as: 'x', body: { op: 'gt', path: 'x', value: 0 } }, { l: [1, 2, 3] }), true);
  assert.strictEqual(evaluatePredicate({ op: 'every', path: 'l', as: 'x', body: { op: 'gt', path: 'x', value: 0 } }, { l: [1, -2] }), false);
  assert.strictEqual(evaluatePredicate({ op: 'some', path: 'l', as: 'x', body: { op: 'eq', path: 'x', value: 2 } }, { l: [1, 2, 3] }), true);
});

test('空数组量词 vacuous：every 真、some 假', () => {
  assert.strictEqual(evaluatePredicate({ op: 'every', path: 'l', as: 'x', body: { op: 'false' } }, { l: [] }), true);
  assert.strictEqual(evaluatePredicate({ op: 'some', path: 'l', as: 'x', body: { op: 'true' } }, { l: [] }), false);
});

test('P6 量词绑定名为 __proto__ → fail-closed', () => {
  assert.strictEqual(evaluatePredicate({ op: 'every', path: 'l', as: '__proto__', body: { op: 'true' } }, { l: [1] }), false);
});

test('P7 量词路径缺失（非数组）→ fail-closed', () => {
  assert.strictEqual(evaluatePredicate({ op: 'every', path: 'nope', as: 'x', body: { op: 'true' } }, { l: [] }), false);
});

test('比较算子跨路径 ref（帧条件）命中与缺失', () => {
  assert.strictEqual(evaluatePredicate({ op: 'eq', path: 'out.id', ref: 'in.id' }, { out: { id: 7 }, in: { id: 7 } }), true);
  assert.strictEqual(evaluatePredicate({ op: 'eq', path: 'out.id', ref: 'nope' }, { out: { id: 7 } }), false);
});

test('P2 _get 拒绝原型链：__proto__/继承属性判缺失', () => {
  assert.strictEqual(_get({ a: 1 }, '__proto__'), MISSING);
  assert.strictEqual(_get(Object.create({ x: 1 }), 'x'), MISSING);
  assert.deepStrictEqual(_get({ a: { b: { c: 5 } } }, 'a.b.c'), 5);
});

test('P5 节点预算：超深嵌套 and fail-closed', () => {
  const nest = (d) => {
    let node = { op: 'true' };
    for (let i = 0; i < d; i++) node = { op: 'and', args: [node] };
    return node;
  };
  assert.strictEqual(evaluatePredicate(nest(3), {}), true);
  assert.strictEqual(evaluatePredicate(nest(600), {}), false);
});

test('P5 参数数上限：64 ok / 65 fail', () => {
  assert.strictEqual(evaluatePredicate({ op: 'and', args: Array.from({ length: 64 }, () => ({ op: 'true' })) }, {}), true);
  assert.strictEqual(evaluatePredicate({ op: 'and', args: Array.from({ length: 65 }, () => ({ op: 'true' })) }, {}), false);
});

test('P5 量词元素上限：256 ok / 257 fail', () => {
  assert.strictEqual(evaluatePredicate({ op: 'every', path: 'l', as: 'x', body: { op: 'true' } }, { l: Array.from({ length: 256 }, () => 1) }), true);
  assert.strictEqual(evaluatePredicate({ op: 'every', path: 'l', as: 'x', body: { op: 'true' } }, { l: Array.from({ length: 257 }, () => 1) }), false);
});

test('P5 路径深度上限：超 32 段判缺失', () => {
  const deep = 'a.' + 'b.'.repeat(40) + 'c';
  assert.strictEqual(evaluatePredicate({ op: 'exists', path: deep }, { a: 1 }), false);
});

test('verify 通过全链：pre 成立、post 关系不变量成立', () => {
  const contract = { name: 'transfer', pre: { op: 'gt', path: 'balance', value: 0 }, post: { op: 'le', path: 'out.balance', ref: 'in.balance' } };
  const r = verify(contract, { pre: { balance: 10 }, post: { balance: 5 } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stage, null);
  assert.strictEqual(r.contract, 'transfer');
});

test('verify 阶段定位：pre 不成立', () => {
  const r = verify({ name: 't', pre: { op: 'gt', path: 'balance', value: 0 } }, { pre: { balance: 0 }, post: {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'pre');
});

test('verify 阶段定位：post 不成立', () => {
  const r = verify({ name: 't', post: { op: 'eq', path: 'out.x', ref: 'in.x' } }, { pre: { x: 1 }, post: { x: 2 } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'post');
});

test('verify 不变量在前态/后态分别定位', () => {
  const inv = { op: 'ge', path: 'balance', value: 0 };
  assert.strictEqual(verify({ name: 't', inv }, { pre: { balance: -1 }, post: { balance: 1 } }).stage, 'inv');
  assert.strictEqual(verify({ name: 't', inv }, { pre: { balance: -1 }, post: { balance: 1 } }).reason, '不变量在前态不成立');
  assert.strictEqual(verify({ name: 't', inv }, { pre: { balance: 1 }, post: { balance: -1 } }).reason, '不变量在后态被破坏');
});

test('verify 对非纯对象契约 fail-closed 到 error 阶段', () => {
  assert.strictEqual(verify(null, {}).stage, 'error');
  assert.strictEqual(verify([1, 2], {}).stage, 'error');
  assert.strictEqual(verify(null, {}).reason, 'contract must be a plain object');
});

test('P1/P3 verify 遇未知算子收敛为 error 阶段（不 fail-open）', () => {
  const r = verify({ name: 'x', pre: { op: 'js' } }, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'error');
});

test('门控关 verify fail-closed 且 stage=error', () => {
  const r = verify({ name: 't' }, {}, { KHY_ACTION_CONTRACT: 'off' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'error');
});

test('verify 无约束契约 ok:true，name 非串则 contract=null', () => {
  assert.strictEqual(verify({ name: 'e' }, { pre: {}, post: {} }).ok, true);
  assert.strictEqual(verify({ pre: null }, {}).contract, null);
});

test('canonicalize 键序稳定 + 确定性', () => {
  assert.strictEqual(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  const A = { op: 'and', args: [{ op: 'true' }, { op: 'eq', path: 'a', value: 1 }] };
  const B = { op: 'and', args: [{ op: 'true' }, { op: 'eq', path: 'a', value: 1 }] };
  assert.strictEqual(canonicalize(A), canonicalize(B));
});

test('canonicalize 处理环/非有限数/函数/undefined 为占位串', () => {
  const cyc = {};
  cyc.self = cyc;
  assert.strictEqual(canonicalize(cyc), '{"self":"__cycle__"}');
  assert.strictEqual(canonicalize({ x: Infinity }), '{"x":"__nonfinite__"}');
  assert.strictEqual(canonicalize(undefined), '"__unrepresentable__"');
});

test('_deepEq 深比较：原始/数组/对象/NaN', () => {
  const b = { n: 0 };
  assert.strictEqual(_deepEq([1, 2], [1, 2], b), true);
  assert.strictEqual(_deepEq([1, 2], [1, 3], b), false);
  assert.strictEqual(_deepEq({ x: 1 }, { x: 1 }, { n: 0 }), true);
  assert.strictEqual(_deepEq(NaN, NaN, { n: 0 }), false);
});
