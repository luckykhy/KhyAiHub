'use strict';

/**
 * uninstallRoute.test.js — co-located suite for the uninstall tier router (pure leaf).
 *
 * IO: none — all facts are injected by the caller; nothing is probed here.
 *
 * Defects pinned as CURRENT behaviour (documentation, never approval):
 *   UR-E1  decideUninstallRoute(null) throws, breaking the file's own "never throws"
 *          contract (the `= {}` default only fires on undefined).
 *   UR-E2  Number.isFinite rejects a numeric string, so a registry count of '3' —
 *          straight from JSON or a parsed command — collapses to 0 and refuses.
 *   UR-E3  fractional counts pass the `> 0` gate, yielding a native tier that quotes
 *          "0.5 个同名条目" and reports ambiguous: false.
 *   UR-E4  negative counts skip both refuse-reason branches, so the honest reason
 *          string omits the registry entirely.
 *   UR-E5  `facts.query || ''` treats a falsy target (0, []) as "no target given".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { decideUninstallRoute } = require('./uninstallRoute');

const PM_REASON = '匹配包管理器标识,按包管理器清单精确卸载';
const NATIVE_ONE_REASON = '包管理器未覆盖;命中注册表自带卸载器,跑其原生卸载器';
const NO_TARGET = { tier: 'refuse', reason: '未指定卸载目标' };

test('导出唯一纯函数且每次返回新对象', () => {
  assert.equal(typeof decideUninstallRoute, 'function');
  assert.notEqual(decideUninstallRoute({ query: 'a' }), decideUninstallRoute({ query: 'a' }));
});

test('空目标一律先拒绝，早于任何档位判定', () => {
  for (const facts of [{}, { isPmAppId: true, pmAvailable: true }, { query: '' },
    { query: '   ' }, { query: '\n\t ' }, { query: null }, { query: false }]) {
    assert.deepEqual(decideUninstallRoute(facts), NO_TARGET, JSON.stringify(facts));
  }
  assert.deepEqual(decideUninstallRoute(), NO_TARGET);
});

test('T1 包管理器档只回 tier 与 reason，且优先于注册表命中', () => {
  const r = decideUninstallRoute({ query: 'Notepad.Notion', isPmAppId: true, pmAvailable: true });
  assert.deepEqual(r, { tier: 'pm', reason: PM_REASON });
  const withNative = decideUninstallRoute({
    query: 'foo', isPmAppId: true, pmAvailable: true, nativeAvailable: true, nativeMatchCount: 3,
  });
  assert.deepEqual(withNative, { tier: 'pm', reason: PM_REASON });
});

test('T2 单命中走原生卸载器且 ambiguous 显式为 false', () => {
  const r = decideUninstallRoute({ query: 'My Editor 1.2', nativeAvailable: true, nativeMatchCount: 1 });
  assert.deepEqual(r, { tier: 'native', reason: NATIVE_ONE_REASON, ambiguous: false });
});

test('T2 多命中带上计数并标记歧义', () => {
  const r = decideUninstallRoute({ query: 'My Editor', nativeAvailable: true, nativeMatchCount: 2 });
  assert.equal(r.tier, 'native');
  assert.equal(r.ambiguous, true);
  assert.equal(r.reason, '包管理器未覆盖;注册表命中 2 个同名条目,需选定后再卸');
  assert.equal(
    decideUninstallRoute({ query: 'x', nativeAvailable: true, nativeMatchCount: 1000000 }).reason,
    '包管理器未覆盖;注册表命中 1000000 个同名条目,需选定后再卸'
  );
});

test('命中数边界 0 走拒绝、1 走原生、2 起判歧义', () => {
  assert.equal(decideUninstallRoute({ query: 'x', nativeAvailable: true, nativeMatchCount: 0 }).tier, 'refuse');
  assert.equal(decideUninstallRoute({ query: 'x', nativeAvailable: true, nativeMatchCount: 1 }).tier, 'native');
  assert.equal(decideUninstallRoute({ query: 'x', nativeAvailable: true, nativeMatchCount: 1 }).ambiguous, false);
  assert.equal(decideUninstallRoute({ query: 'x', nativeAvailable: true, nativeMatchCount: 2 }).ambiguous, true);
});

test('原生卸载器不可用时再多命中也不进 T2', () => {
  const r = decideUninstallRoute({ query: 'My Editor', nativeAvailable: false, nativeMatchCount: 5 });
  assert.equal(r.tier, 'refuse');
  assert.match(r.reason, /原生卸载器不可用\(非 Windows 或门关\)/);
});

test('拒绝理由按缺失项拼装，四种组合各有其文', () => {
  const combos = [
    [{ query: 'x' }, '未找到清单或自带卸载器(非包管理器标识、原生卸载器不可用(非 Windows 或门关));拒绝盲删安装目录'],
    [{ query: 'x', nativeAvailable: true }, '未找到清单或自带卸载器(非包管理器标识、注册表未匹配到自带卸载器);拒绝盲删安装目录'],
    [{ query: 'x', isPmAppId: true, pmAvailable: false }, '未找到清单或自带卸载器(无可用包管理器、原生卸载器不可用(非 Windows 或门关));拒绝盲删安装目录'],
    [{ query: 'x', isPmAppId: true, pmAvailable: false, nativeAvailable: true }, '未找到清单或自带卸载器(无可用包管理器、注册表未匹配到自带卸载器);拒绝盲删安装目录'],
  ];
  for (const [facts, reason] of combos) {
    const r = decideUninstallRoute(facts);
    assert.equal(r.tier, 'refuse', JSON.stringify(facts));
    assert.equal(r.reason, reason, JSON.stringify(facts));
    assert.deepEqual(Object.keys(r), ['tier', 'reason']);
  }
});

test('三个布尔事实按 truthy 强转，字符串与对象都算授予', () => {
  assert.equal(decideUninstallRoute({ query: 'x', isPmAppId: 'no', pmAvailable: 'yes' }).tier, 'pm');
  assert.equal(decideUninstallRoute({ query: 'x', isPmAppId: {}, pmAvailable: 1 }).tier, 'pm');
  assert.equal(decideUninstallRoute({ query: 'x', nativeAvailable: 'yes', nativeMatchCount: 1 }).tier, 'native');
  assert.equal(decideUninstallRoute({ query: 'x', isPmAppId: '', pmAvailable: 1, nativeAvailable: 1, nativeMatchCount: 1 }).tier, 'native');
});

test('目标按 String 归一，数字与数组元素都能成靶', () => {
  assert.equal(decideUninstallRoute({ query: 5, isPmAppId: true, pmAvailable: true }).tier, 'pm');
  assert.equal(decideUninstallRoute({ query: ['notepad'], isPmAppId: true, pmAvailable: true }).tier, 'pm');
  assert.equal(decideUninstallRoute({ query: true, isPmAppId: true, pmAvailable: true }).reason, PM_REASON);
  const objTarget = decideUninstallRoute({ query: { toString: () => 'My Editor' }, nativeAvailable: true, nativeMatchCount: 1 });
  assert.equal(objTarget.tier, 'native');
});

test('tier 恒在 pm 与 native 与 refuse 三值之内', () => {
  const samples = [
    {}, { query: 'a' }, { query: 'a', isPmAppId: true, pmAvailable: true },
    { query: 'a', nativeAvailable: true, nativeMatchCount: 4 },
    { query: 'a', isPmAppId: true, pmAvailable: true, nativeAvailable: true, nativeMatchCount: 4 },
  ];
  for (const facts of samples) {
    assert.ok(['pm', 'native', 'refuse'].includes(decideUninstallRoute(facts).tier), JSON.stringify(facts));
  }
});

test('KNOWN-DEFECT: UR-E1 显式传 null 抛 TypeError，击穿「绝不抛」叶子契约', () => {
  assert.throws(() => decideUninstallRoute(null), {
    name: 'TypeError',
    message: /Cannot read properties of null \(reading 'query'\)/,
  });
  const hostile = { get query() { throw new Error('hostile getter'); }, isPmAppId: true, pmAvailable: true };
  assert.throws(() => decideUninstallRoute(hostile), { message: 'hostile getter' });
});

test('KNOWN-DEFECT: UR-E2 数字字符串命中数被 Number.isFinite 归零，明明有卸载器却拒绝', () => {
  // measured: '3' / '1' / true / Infinity / -Infinity all collapse to 0 matches.
  for (const count of ['3', '1', true, [2], Infinity, -Infinity, NaN, null, undefined, {}, '0']) {
    const r = decideUninstallRoute({ query: 'My Editor', nativeAvailable: true, nativeMatchCount: count });
    assert.equal(r.tier, 'refuse', String(count));
    assert.match(r.reason, /注册表未匹配到自带卸载器/, String(count));
  }
});

test('KNOWN-DEFECT: UR-E3 0.5 与 1e21 的命中数照样进原生档并写进文案', () => {
  // measured: any finite value > 0 clears the gate, ambiguity needs > 1.
  const half = decideUninstallRoute({ query: 'x', nativeAvailable: true, nativeMatchCount: 0.5 });
  assert.equal(half.tier, 'native');
  assert.equal(half.ambiguous, false);
  assert.equal(half.reason, '包管理器未覆盖;注册表命中 0.5 个同名条目,需选定后再卸');
  const huge = decideUninstallRoute({ query: 'x', nativeAvailable: true, nativeMatchCount: 1e21 });
  assert.equal(huge.ambiguous, true);
  assert.match(huge.reason, /1e\+21/);
});

test('KNOWN-DEFECT: UR-E4 负命中数的拒绝理由漏掉注册表这一项', () => {
  // measured: matches > 0 is false yet matches === 0 is also false, so the registry
  // clause disappears and the reason reads as if only the id check failed.
  const neg = decideUninstallRoute({ query: 'x', nativeAvailable: true, nativeMatchCount: -1 });
  assert.equal(neg.tier, 'refuse');
  assert.equal(neg.reason, '未找到清单或自带卸载器(非包管理器标识);拒绝盲删安装目录');
  assert.ok(!/注册表/.test(neg.reason));
  assert.equal(
    decideUninstallRoute({ query: 'x', isPmAppId: true, pmAvailable: false, nativeAvailable: true, nativeMatchCount: -3 }).reason,
    '未找到清单或自带卸载器(无可用包管理器);拒绝盲删安装目录'
  );
});

test('KNOWN-DEFECT: UR-E5 目标 0 与空数组被当成未指定目标', () => {
  // measured: `facts.query || ''` — a legitimate falsy identifier is indistinguishable
  // from "nothing typed", while [0] survives as the string "0".
  assert.deepEqual(decideUninstallRoute({ query: 0, isPmAppId: true, pmAvailable: true }), NO_TARGET);
  assert.deepEqual(decideUninstallRoute({ query: [], isPmAppId: true, pmAvailable: true }), NO_TARGET);
  assert.equal(decideUninstallRoute({ query: [0], isPmAppId: true, pmAvailable: true }).tier, 'pm');
});
