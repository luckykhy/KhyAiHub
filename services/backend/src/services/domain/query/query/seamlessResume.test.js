'use strict';

/**
 * seamlessResume.test.js — co-located suite for the silent-resume budget leaf.
 *
 * IO: none — every case passes an explicit env bag; the process.env default is
 * exercised only inside a try/finally that restores the touched key.
 *
 * Defects pinned as CURRENT behaviour (documentation, never approval):
 *   SR-E1  a falsy-but-not-nullish env bag leaks its own value into the off-detection
 *          (`env && env.KHY_SEAMLESS_RESUME` short-circuits), so isEnabled(0) and
 *          isEnabled(false) report the gate OFF.
 *   SR-E2  any non-object env bag fails open: isEnabled('off') stays true.
 *   SR-E3  an env object with a throwing accessor propagates TypeError, breaking the
 *          file's own "never throws" leaf contract.
 *   SR-E4  OFF_VALUES is exported unfrozen while the two budget tables are frozen, so
 *          any consumer can flip the global gate by pushing into the array.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('./seamlessResume');

const OFF = { KHY_SEAMLESS_RESUME: 'off' };

test('导出五个成员且规模表键齐全', () => {
  assert.deepEqual(Object.keys(leaf).sort(), [
    'OFF_VALUES', 'LEGACY_DEFAULTS', 'ON_DEFAULTS', 'defaultTransientBudget', 'isEnabled',
  ].sort());
  assert.deepEqual(Object.getOwnPropertyNames(leaf.ON_DEFAULTS), ['small', 'normal', 'large']);
  assert.deepEqual(Object.getOwnPropertyNames(leaf.LEGACY_DEFAULTS), ['small', 'normal', 'large']);
});

test('两张预算表冻结且门控开为 1/2/3、门控关为 0/1/3', () => {
  assert.ok(Object.isFrozen(leaf.ON_DEFAULTS));
  assert.ok(Object.isFrozen(leaf.LEGACY_DEFAULTS));
  assert.deepEqual({ ...leaf.ON_DEFAULTS }, { small: 1, normal: 2, large: 3 });
  assert.deepEqual({ ...leaf.LEGACY_DEFAULTS }, { small: 0, normal: 1, large: 3 });
  assert.throws(() => { leaf.ON_DEFAULTS.small = 99; }, TypeError);
  assert.throws(() => { leaf.LEGACY_DEFAULTS.large = 0; }, TypeError);
  assert.equal(leaf.ON_DEFAULTS.small, 1);
  assert.equal(leaf.ON_DEFAULTS, require('./seamlessResume').ON_DEFAULTS);
});

test('isEnabled 认识四种显式关闭值且大小写与空白不敏感', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'FaLsE', '  off  ', 'false ', 'NO']) {
    assert.equal(leaf.isEnabled({ KHY_SEAMLESS_RESUME: v }), false, v);
  }
  assert.equal(leaf.isEnabled({ KHY_SEAMLESS_RESUME: 0 }), false);
  assert.equal(leaf.isEnabled({ KHY_SEAMLESS_RESUME: false }), false);
});

test('isEnabled 对未设值与一切不可识别值一律默认开', () => {
  for (const env of [{}, { KHY_SEAMLESS_RESUME: undefined }, { KHY_SEAMLESS_RESUME: null },
    { KHY_SEAMLESS_RESUME: '' }, { KHY_SEAMLESS_RESUME: '   ' }, { KHY_SEAMLESS_RESUME: '1' },
    { KHY_SEAMLESS_RESUME: '2' }, { KHY_SEAMLESS_RESUME: '-1' }, { KHY_SEAMLESS_RESUME: 'disabled' },
    { KHY_SEAMLESS_RESUME: true }, { KHY_SEAMLESS_RESUME: NaN }, { KHY_SEAMLESS_RESUME: [] },
    { KHY_SEAMLESS_RESUME: {} }]) {
    assert.equal(leaf.isEnabled(env), true, JSON.stringify(env));
  }
});

test('门控只认 KHY_SEAMLESS_RESUME 这一个键，其他开关名被忽略', () => {
  assert.equal(leaf.isEnabled({ KHY_SEAMLESS_RESUMEX: 'off' }), true);
  assert.equal(leaf.isEnabled({ seamlessResume: 'off' }), true);
});

test('defaultTransientBudget 按规模取表，large 两表同为 3 使门控对它成为空操作', () => {
  assert.equal(leaf.defaultTransientBudget('small', {}), 1);
  assert.equal(leaf.defaultTransientBudget('normal', {}), 2);
  assert.equal(leaf.defaultTransientBudget('large', {}), 3);
  assert.equal(leaf.defaultTransientBudget('small', OFF), 0);
  assert.equal(leaf.defaultTransientBudget('normal', OFF), 1);
  assert.equal(leaf.defaultTransientBudget('large', OFF), 3);
});

test('规模归一化容忍大小写与空白，其余一切落到 normal', () => {
  const onCases = [['small', 1], ['SMALL', 1], [' small ', 1], ['large', 3], ['Large', 3]];
  for (const [scale, expected] of onCases) {
    assert.equal(leaf.defaultTransientBudget(scale, {}), expected, scale);
  }
  const toNormal = ['', '   ', 'tiny', 'huge', 'larger', 'normal', 'NORMAL', 0, 1, -1, true,
    false, {}, [], NaN, Infinity, 1e21, null, undefined];
  for (const scale of toNormal) {
    assert.equal(leaf.defaultTransientBudget(scale, {}), 2, String(scale));
    assert.equal(leaf.defaultTransientBudget(scale, OFF), 1, String(scale));
  }
});

test('原型键作为规模不会漏进预算表，白名单归一后仍返回 normal 档', () => {
  for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    assert.equal(leaf.defaultTransientBudget(key, {}), 2, key);
    assert.equal(leaf.defaultTransientBudget(key, OFF), 1, key);
  }
});

test('数组入参按 String 归一，[small] 命中 small 档', () => {
  assert.equal(leaf.defaultTransientBudget(['small'], {}), 1);
  assert.equal(leaf.defaultTransientBudget(['large'], OFF), 3);
});

test('BigInt 与 Symbol 规模不抛，落到 normal 档', () => {
  assert.equal(leaf.defaultTransientBudget(1n, {}), 2);
  assert.equal(leaf.defaultTransientBudget(Symbol('small'), {}), 2);
  assert.equal(leaf.isEnabled({ KHY_SEAMLESS_RESUME: 1n }), true);
  assert.equal(leaf.isEnabled({ KHY_SEAMLESS_RESUME: Symbol('off') }), true);
});

test('缺省 env 参数即读 process.env，撤掉开关回到现状默认值', () => {
  const key = 'KHY_SEAMLESS_RESUME';
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const before = process.env[key];
  try {
    delete process.env[key];
    assert.equal(leaf.isEnabled(), true);
    assert.equal(leaf.defaultTransientBudget('normal'), 2);
    process.env[key] = 'off';
    assert.equal(leaf.isEnabled(), false);
    assert.equal(leaf.defaultTransientBudget('normal'), 1);
    assert.equal(leaf.defaultTransientBudget('small'), 0);
  } finally {
    if (had) process.env[key] = before;
    else delete process.env[key];
  }
  assert.equal(leaf.isEnabled(), true);
});

test('KNOWN-DEFECT: SR-E1 假值但非 nullish 的 env 袋子把自身值当成开关值', () => {
  // measured: env && env.KHY... short-circuits to 0 / false, String() maps them to
  // the off tokens '0' / 'false', so the gate reads as explicitly disabled.
  assert.equal(leaf.isEnabled(0), false);
  assert.equal(leaf.isEnabled(false), false);
  assert.equal(leaf.defaultTransientBudget('small', 0), 0);
  assert.equal(leaf.defaultTransientBudget('normal', false), 1);
  // while nullish / empty-string bags still land on "enabled"
  assert.equal(leaf.isEnabled(''), true);
  assert.equal(leaf.isEnabled(NaN), true);
});

test('KNOWN-DEFECT: SR-E2 非对象 env 袋子一律 fail-open，写成 off 也关不掉', () => {
  // measured: a string bag has no KHY_SEAMLESS_RESUME property, so the gate stays on.
  assert.equal(leaf.isEnabled('off'), true);
  assert.equal(leaf.isEnabled(['off']), true);
  assert.equal(leaf.isEnabled(5), true);
  assert.equal(leaf.defaultTransientBudget('small', 'off'), 1);
  assert.equal(leaf.defaultTransientBudget('small', null), 1);
  assert.equal(leaf.defaultTransientBudget('small', undefined), 1);
});

test('KNOWN-DEFECT: SR-E3 抛错的 env 访问器直接击穿「绝不抛」契约', () => {
  const hostile = Object.defineProperty({}, 'KHY_SEAMLESS_RESUME', {
    get() { throw new Error('boom'); },
  });
  assert.throws(() => leaf.isEnabled(hostile), { name: 'Error', message: 'boom' });
  assert.throws(() => leaf.defaultTransientBudget('small', hostile), { message: 'boom' });
});

test('KNOWN-DEFECT: SR-E4 OFF_VALUES 未冻结，任何消费者 push 即可翻转全局门控', () => {
  // measured: two of three exported tables are frozen; the off-token array is not.
  assert.equal(Object.isFrozen(leaf.OFF_VALUES), false);
  assert.ok(Array.isArray(leaf.OFF_VALUES));
  assert.deepEqual(leaf.OFF_VALUES, ['0', 'false', 'off', 'no']);
  leaf.OFF_VALUES.push('zzz');
  try {
    assert.equal(leaf.isEnabled({ KHY_SEAMLESS_RESUME: 'zzz' }), false);
  } finally {
    leaf.OFF_VALUES.pop();
  }
  assert.equal(leaf.isEnabled({ KHY_SEAMLESS_RESUME: 'zzz' }), true);
});
