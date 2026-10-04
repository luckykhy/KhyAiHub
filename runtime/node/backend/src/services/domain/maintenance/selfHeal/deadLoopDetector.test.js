'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { PrescriptionDeadLoopDetector } = require('./deadLoopDetector');

test('导出面只有 PrescriptionDeadLoopDetector，新实例处于干净初始态', () => {
  const mod = require('./deadLoopDetector');
  assert.deepStrictEqual(Object.keys(mod), ['PrescriptionDeadLoopDetector']);
  const d = new PrescriptionDeadLoopDetector();
  assert.deepStrictEqual(d._issued, new Set());
  assert.deepStrictEqual(d._counts, new Map());
  assert.equal(d._lastSignature, null);
  assert.deepStrictEqual(d.check({ fixKind: 'install', capture: { dep: 'x' } }), {
    signature: 'install:x', dead: false, repeats: 0, sameAsLast: false,
  });
});

test('缺 fixKind 的诊断（含 null/undefined/非对象/假值）统一签名 none:none', () => {
  const d = new PrescriptionDeadLoopDetector();
  const junk = [undefined, null, {}, 0, '', false, NaN, 'str', [], [1], Symbol('s')];
  for (const input of junk) {
    assert.equal(d.signature(input), 'none:none', `input=${String(input)}`);
  }
  assert.equal(d.signature({ fixKind: null, capture: { dep: 'x' } }), 'none:none');
  assert.equal(d.signature({ fixKind: 0, capture: { dep: 'x' } }), 'none:none');
  assert.equal(d.signature({ fixKind: '', capture: { dep: 'x' } }), 'none:none');
});

test('签名字段优先级：dep 覆盖候选/命令/端口/路径', () => {
  const d = new PrescriptionDeadLoopDetector();
  assert.equal(d.signature({ fixKind: 'fix', capture: { dep: 'puppeteer' } }), 'fix:puppeteer');
  assert.equal(
    d.signature({ fixKind: 'fix', capture: { dep: 'puppeteer', command: 'npm i x', path: '/p', hostPort: { host: 'h', port: 1 } } }),
    'fix:puppeteer',
  );
  assert.equal(d.signature({ fixKind: 'fix', capture: { command: 'c', candidates: ['a', 'b'] } }), 'fix:c->a');
  assert.equal(d.signature({ fixKind: 'fix', capture: { command: 'c' } }), 'fix:c');
  assert.equal(d.signature({ fixKind: 'fix', capture: { hostPort: { host: 'h', port: 80 } } }), 'fix:h:80');
  assert.equal(d.signature({ fixKind: 'fix', capture: { path: '/a/b' } }), 'fix:/a/b');
});

test('候选列表分支的边界：空数组、缺命令、命令为空串都退回下一优先级', () => {
  const d = new PrescriptionDeadLoopDetector();
  assert.equal(d.signature({ fixKind: 'fix', capture: { candidates: [] } }), 'fix:∅');
  assert.equal(d.signature({ fixKind: 'fix', capture: { candidates: ['a'] } }), 'fix:->a');
  assert.equal(d.signature({ fixKind: 'fix', capture: { command: '', candidates: ['a'] } }), 'fix:->a');
  assert.equal(d.signature({ fixKind: 'fix', capture: { hostPort: { port: 8080 } } }), 'fix::8080');
  assert.equal(d.signature({ fixKind: 'fix', capture: { hostPort: { host: 'h', port: 0 } } }), 'fix:∅');
  assert.equal(d.signature({ fixKind: 'fix', capture: { hostPort: {} } }), 'fix:∅');
});

test('capture 缺失或是标量时退回 ∅ 占位', () => {
  const d = new PrescriptionDeadLoopDetector();
  assert.equal(d.signature({ fixKind: 'install' }), 'install:∅');
  assert.equal(d.signature({ fixKind: 'install', capture: null }), 'install:∅');
  assert.equal(d.signature({ fixKind: 'install', capture: {} }), 'install:∅');
  assert.equal(d.signature({ fixKind: 'install', capture: 'a string' }), 'install:∅');
  assert.equal(d.signature({ fixKind: 'install', capture: 7 }), 'install:∅');
  assert.equal(d.signature({ fixKind: 'install', capture: [] }), 'install:∅');
});

test('check 只读：反复调用不改状态，record 才登记', () => {
  const d = new PrescriptionDeadLoopDetector();
  const dx = { fixKind: 'fix', capture: { dep: 'p' } };
  const first = d.check(dx);
  const again = d.check(dx);
  assert.deepStrictEqual(first, again);
  assert.deepStrictEqual(d._issued, new Set());
  assert.deepStrictEqual(d._counts, new Map());
  assert.equal(d._lastSignature, null);
  assert.deepStrictEqual(d.record(dx), { signature: 'fix:p', repeats: 1 });
  assert.deepStrictEqual(d.check(dx), { signature: 'fix:p', dead: true, repeats: 1, sameAsLast: true });
  assert.deepStrictEqual(d.record(dx), { signature: 'fix:p', repeats: 2 });
  assert.deepStrictEqual(d.check(dx), { signature: 'fix:p', dead: true, repeats: 2, sameAsLast: true });
});

test('sameAsLast 只跟最近一次登记比较，换个处方就翻转', () => {
  const d = new PrescriptionDeadLoopDetector();
  const a = { fixKind: 'fix', capture: { dep: 'a' } };
  const b = { fixKind: 'fix', capture: { dep: 'b' } };
  d.record(a);
  assert.equal(d.check(a).sameAsLast, true);
  assert.equal(d.check(b).sameAsLast, false);
  d.record(b);
  assert.equal(d.check(a).sameAsLast, false);
  assert.equal(d.check(a).dead, true);
  assert.equal(d.check(a).repeats, 1);
});

test('reset 清空登记态并回到 lastSignature=null', () => {
  const d = new PrescriptionDeadLoopDetector();
  const a = { fixKind: 'fix', capture: { dep: 'a' } };
  d.record(a);
  d.record({});
  assert.equal(d.check(a).dead, true);
  assert.equal(d.reset(), undefined);
  assert.deepStrictEqual(d.check(a), { signature: 'fix:a', dead: false, repeats: 0, sameAsLast: false });
  assert.equal(d._lastSignature, null);
  const other = new PrescriptionDeadLoopDetector();
  assert.equal(other.check(a).dead, false);
});

test('check/record 接受垃圾入参不抛，落到 none:none 分支', () => {
  const d = new PrescriptionDeadLoopDetector();
  assert.deepStrictEqual(d.check(), { signature: 'none:none', dead: false, repeats: 0, sameAsLast: false });
  assert.deepStrictEqual(d.check(null), { signature: 'none:none', dead: false, repeats: 0, sameAsLast: false });
  assert.deepStrictEqual(d.record('junk'), { signature: 'none:none', repeats: 1 });
  assert.deepStrictEqual(d.record(undefined), { signature: 'none:none', repeats: 2 });
  assert.deepStrictEqual(d.check(0), { signature: 'none:none', dead: true, repeats: 2, sameAsLast: true });
});

test('KNOWN-DEFECT: 签名用裸 : 拼接，fixKind 或 dep 自带 :: 时两条不同处方撞成同一个熔断键', () => {
  const d = new PrescriptionDeadLoopDetector();
  const lhs = { fixKind: 'a:b', capture: { dep: 'c' } };
  const rhs = { fixKind: 'a', capture: { dep: 'b:c' } };
  assert.equal(d.signature(lhs), 'a:b:c');
  assert.equal(d.signature(rhs), 'a:b:c');
  d.record(lhs);
  assert.equal(d.check(rhs).dead, true);
  assert.equal(d.check(rhs).sameAsLast, true);
});

test('KNOWN-DEFECT: 结构化 capture 字段被字符串化，任意两个对象 dep 共用一个签名', () => {
  const d = new PrescriptionDeadLoopDetector();
  const s1 = d.signature({ fixKind: 'x', capture: { dep: { name: 'a' } } });
  const s2 = d.signature({ fixKind: 'x', capture: { dep: { name: 'b' } } });
  assert.equal(s1, 'x:[object Object]');
  assert.equal(s1, s2);
  d.record({ fixKind: 'x', capture: { dep: { name: 'a' } } });
  assert.equal(d.check({ fixKind: 'x', capture: { dep: { name: 'b' } } }).dead, true);
  assert.equal(d.signature({ fixKind: 'x', capture: { dep: 1e21 } }), 'x:1e+21');
});

test('KNOWN-DEFECT: fixKind 或 dep 是无原型对象时抛 TypeError，违反模块自称的「绝不抛错」', () => {
  const d = new PrescriptionDeadLoopDetector();
  assert.throws(() => d.signature({ fixKind: Object.create(null) }), TypeError);
  assert.throws(() => d.signature({ fixKind: 'x', capture: { dep: Object.create(null) } }), TypeError);
  assert.throws(() => d.check({ fixKind: Object.create(null) }), TypeError);
  assert.throws(() => d.record({ fixKind: Object.create(null) }), TypeError);
});

test('KNOWN-DEFECT: 所有缺 fixKind 的诊断共享 none:none 桶，一处登记让后续无关诊断被判死循环', () => {
  const d = new PrescriptionDeadLoopDetector();
  d.record(null);
  assert.deepStrictEqual(d.check({}), { signature: 'none:none', dead: true, repeats: 1, sameAsLast: true });
  assert.deepStrictEqual(d.check('another run'), { signature: 'none:none', dead: true, repeats: 1, sameAsLast: true });
});

test('KNOWN-DEFECT: candidates 只按 length/[0] 取值，非数组字符串被截成首字符且顺序敏感', () => {
  const d = new PrescriptionDeadLoopDetector();
  assert.equal(d.signature({ fixKind: 'fix', capture: { command: 'c', candidates: 'xyz' } }), 'fix:c->x');
  assert.equal(d.signature({ fixKind: 'fix', capture: { command: 'c', candidates: 'abc' } }), 'fix:c->a');
  assert.equal(d.signature({ fixKind: 'fix', capture: { candidates: { length: 3, 0: 'q' } } }), 'fix:->q');
  assert.equal(d.signature({ fixKind: 'fix', capture: { candidates: 5 } }), 'fix:∅');
});

test('KNOWN-DEFECT: dep 存在但为假值时身份丢失，退化成与所有无处方诊断同名的 ∅', () => {
  const d = new PrescriptionDeadLoopDetector();
  assert.equal(d.signature({ fixKind: 'fix', capture: { dep: '' } }), 'fix:∅');
  assert.equal(d.signature({ fixKind: 'fix', capture: { dep: 0 } }), 'fix:∅');
  assert.equal(d.signature({ fixKind: 'fix', capture: { dep: 0 } }), d.signature({ fixKind: 'fix' }));
  assert.equal(d.signature({ fixKind: 'fix', capture: { command: 0, path: '' } }), 'fix:∅');
});
