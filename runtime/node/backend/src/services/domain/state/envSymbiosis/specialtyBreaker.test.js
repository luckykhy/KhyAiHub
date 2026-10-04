'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SpecialtyBreaker, FUSE_CAUSE } = require('./specialtyBreaker');

test('导出面只有两个符号，FUSE_CAUSE 冻结且值都是字符串', () => {
  const mod = require('./specialtyBreaker');
  assert.deepStrictEqual(Object.keys(mod).sort(), ['FUSE_CAUSE', 'SpecialtyBreaker']);
  assert.equal(Object.isFrozen(FUSE_CAUSE), true);
  assert.deepStrictEqual(Object.keys(FUSE_CAUSE), ['SECURITY_DEGRADE', 'CRASH']);
  assert.deepStrictEqual(Object.values(FUSE_CAUSE), ['security-degrade', 'crash']);
  assert.throws(() => {
    FUSE_CAUSE.CRASH = 'hacked';
  }, TypeError);
  assert.throws(() => {
    FUSE_CAUSE.EXTRA = 'x';
  }, TypeError);
  assert.equal(FUSE_CAUSE.CRASH, 'crash');
  assert.equal('EXTRA' in FUSE_CAUSE, false);
});

test('fuse 新建桶时返回 newlyFused 与拼接好的 key，默认事由是 crash', () => {
  const b = new SpecialtyBreaker();
  const r = b.fuse('linux', 'io-uring');
  assert.deepStrictEqual(r, {
    newlyFused: true, key: 'linux::io-uring', platform: 'linux', specialty: 'io-uring', cause: 'crash', count: 1,
  });
  assert.equal(b.isFused('linux', 'io-uring'), true);
  assert.equal(b.isFused('linux', 'epoll'), false);
  assert.equal(b.isFused('mac', 'io-uring'), false);
});

test('fuse 幂等：重复熔断只加计数，保留首次事由并忽略后续 detail', () => {
  const b = new SpecialtyBreaker();
  b.fuse('win', 'ntfs', FUSE_CAUSE.SECURITY_DEGRADE, { first: 1 });
  const r = b.fuse('win', 'ntfs', FUSE_CAUSE.CRASH, { second: 1 });
  assert.deepStrictEqual(r, {
    newlyFused: false, key: 'win::ntfs', platform: 'win', specialty: 'ntfs', cause: 'security-degrade', count: 2,
  });
  assert.deepStrictEqual(b.list(), [{
    platform: 'win', specialty: 'ntfs', cause: 'security-degrade', count: 2, detail: { first: 1 },
  }]);
});

test('非法或缺省的事由一律收敛成 crash，合法值原样保留', () => {
  const b = new SpecialtyBreaker();
  assert.equal(b.fuse('p', 'bad-cause').cause, 'crash');
  assert.equal(b.fuse('p', 'upper').cause, 'crash');
  assert.equal(b.fuse('p', 'upper', 'CRASH').cause, 'crash');
  assert.equal(b.fuse('p', 'key', 'SECURITY_DEGRADE').cause, 'crash');
  assert.equal(b.fuse('p', 'ok', FUSE_CAUSE.SECURITY_DEGRADE).cause, 'security-degrade');
  assert.equal(b.fuse('p', 'nul', null).cause, 'crash');
});

test('reset 摘除熔断并如实返回布尔，isFused 随之翻转', () => {
  const b = new SpecialtyBreaker();
  b.fuse('a', 'x');
  assert.equal(b.reset('a', 'x'), true);
  assert.equal(b.reset('a', 'x'), false);
  assert.equal(b.isFused('a', 'x'), false);
  assert.deepStrictEqual(b.list(), []);
});

test('list 给的是桶的浅拷贝，改顶层字段不回写内部状态', () => {
  const b = new SpecialtyBreaker();
  b.fuse('a', 'x', FUSE_CAUSE.CRASH, 'det');
  const snap = b.list();
  snap[0].count = 999;
  snap[0].cause = 'security-degrade';
  snap[0].platform = 'zzz';
  assert.deepStrictEqual(b.list(), [{ platform: 'a', specialty: 'x', cause: 'crash', count: 1, detail: 'det' }]);
  assert.equal(b.list()[0] === snap[0], false);
});

test('list 按插入顺序排列，多桶各自独立计数', () => {
  const b = new SpecialtyBreaker();
  b.fuse('p1', 's1');
  b.fuse('p2', 's2');
  b.fuse('p1', 's1');
  b.fuse('p1', 's2', FUSE_CAUSE.SECURITY_DEGRADE);
  assert.deepStrictEqual(b.list().map((v) => `${v.platform}/${v.specialty}/${v.count}`), [
    'p1/s1/2', 'p2/s2/1', 'p1/s2/1',
  ]);
  const other = new SpecialtyBreaker();
  assert.deepStrictEqual(other.list(), []);
  assert.equal(other.isFused('p1', 's1'), false);
  assert.equal(other.fuse('p1', 's1').count, 1);
  assert.equal(b.isFused('p1', 's1'), true);
  assert.equal(b.list()[0].count, 2);
});

test('_resetForTest 清空全部熔断态', () => {
  const b = new SpecialtyBreaker();
  b.fuse('a', 'x');
  b.fuse('b', 'y');
  assert.equal(b.list().length, 2);
  assert.equal(b._resetForTest(), undefined);
  assert.deepStrictEqual(b.list(), []);
  assert.equal(b.isFused('a', 'x'), false);
});

test('垃圾入参按 String 收敛成一个真实存在的桶，不会抛', () => {
  const b = new SpecialtyBreaker();
  const r = b.fuse(null, undefined);
  assert.equal(r.key, 'null::undefined');
  assert.equal(r.specialty, undefined);
  assert.equal('specialty' in r, true);
  assert.equal(b.isFused(null, undefined), true);
  assert.equal(b.isFused(undefined, null), false);
  assert.equal(b.fuse(void 0, void 0).key, 'undefined::undefined');
  const arr = b.fuse([], {});
  assert.equal(arr.key, '::[object Object]');
});

test('边界数值平台同样只按 String 归一：0、负数、NaN、极大数', () => {
  const b = new SpecialtyBreaker();
  assert.equal(b.fuse(0, 'x').key, '0::x');
  assert.equal(b.fuse(-1, 'x').key, '-1::x');
  assert.equal(b.fuse(NaN, 'x').key, 'NaN::x');
  assert.equal(b.fuse(1e21, 'x').key, '1e+21::x');
  assert.equal(b.fuse(Number.MAX_SAFE_INTEGER, 'x').key, '9007199254740991::x');
  assert.equal(b.list().length, 5);
});

test('KNOWN-DEFECT: list 的拷贝是浅拷贝，detail 按引用外泄可回写熔断真源', () => {
  const b = new SpecialtyBreaker();
  b.fuse('linux', 'io-uring', FUSE_CAUSE.CRASH, { exploits: ['a'] });
  const snap = b.list();
  assert.equal(snap[0].detail === b.list()[0].detail, true);
  snap[0].detail.exploits.push('forged');
  snap[0].detail.causeOfRollback = 'invented';
  assert.deepStrictEqual(b.list()[0].detail, { exploits: ['a', 'forged'], causeOfRollback: 'invented' });
});

test('KNOWN-DEFECT: _key 的 String 强制让不同类型的 platform/specialty 落进同一个桶', () => {
  const b = new SpecialtyBreaker();
  assert.equal(b.fuse(123, 'x').key, '123::x');
  assert.equal(b.isFused('123', 'x'), true);
  assert.equal(b.fuse('123', 'x').newlyFused, false);
  assert.equal(b.fuse(true, 'y').count, 1);
  assert.equal(b.fuse('true', 'y').cause, 'crash');
  assert.equal(b.reset('123', 'x'), true);
  assert.equal(b.isFused(123, 'x'), false);
  const o1 = { id: 1 };
  const o2 = { id: 2 };
  assert.equal(b.fuse(o1, 'obj').key, '[object Object]::obj');
  const second = b.fuse(o2, 'obj', FUSE_CAUSE.SECURITY_DEGRADE);
  assert.equal(second.newlyFused, false);
  assert.equal(second.count, 2);
});

test('KNOWN-DEFECT: 平台名里带分隔符 :: 时两个互不相干的特长共用一个熔断桶', () => {
  const b = new SpecialtyBreaker();
  assert.equal(b.fuse('a::b', 'c', FUSE_CAUSE.SECURITY_DEGRADE).key, 'a::b::c');
  const collide = b.fuse('a', 'b::c');
  assert.equal(collide.key, 'a::b::c');
  assert.equal(collide.newlyFused, false);
  assert.equal(b.isFused('a', 'b::c'), true);
  assert.equal(b.reset('a::b', 'c'), true);
  assert.equal(b.isFused('a', 'b::c'), false);
  assert.equal(b.list().length, 0);
});

test('KNOWN-DEFECT: fuse 遇到无原型对象平台抛 TypeError，熔断器自身在异常路径上崩掉', () => {
  const b = new SpecialtyBreaker();
  assert.throws(() => b.fuse(Object.create(null), 'x'), TypeError);
  assert.throws(() => b.isFused('x', Object.create(null)), TypeError);
  assert.throws(() => b.reset('x', Object.create(null)), TypeError);
  assert.deepStrictEqual(b.list(), []);
});
