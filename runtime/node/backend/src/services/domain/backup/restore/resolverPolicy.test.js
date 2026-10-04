'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rp = require('./resolverPolicy.js');

test('策略常量与 autonomy 词汇表逐字节钉死', () => {
  assert.equal(rp.STRATEGY_REPROBE, 'reprobe');
  assert.equal(rp.STRATEGY_RECONCILE, 'reconcile');
  assert.equal(rp.STRATEGY_TRUST_PESSIMISTIC, 'trust-pessimistic');
  assert.equal(rp.STRATEGY_ESCALATE, 'escalate');
  assert.equal(rp.AGENT, 'agent');
  assert.equal(rp.HUMAN, 'human');
});

test('_STRATEGY_ORDER 冻结且先便宜后昂贵', () => {
  assert.deepEqual(
    { ...rp._STRATEGY_ORDER },
    { reprobe: 10, reconcile: 20, 'trust-pessimistic': 30, escalate: 90 },
  );
  assert.equal(Object.isFrozen(rp._STRATEGY_ORDER), true);
});

test('_arr：数组原样返回（同一引用），非数组一律收敛为 []', () => {
  const src = [1, 2];
  assert.equal(rp._arr(src), src);
  assert.deepEqual(rp._arr(null), []);
  assert.deepEqual(rp._arr(undefined), []);
  assert.deepEqual(rp._arr('x'), []);
  assert.deepEqual(rp._arr(), []);
  assert.deepEqual(rp._arr({}), []);
});

test('_actionIsSafe：命中危险令牌判不安全，大小写不敏感', () => {
  assert.equal(rp._actionIsSafe('git push origin main'), false);
  assert.equal(rp._actionIsSafe('rm -rf ./x'), false);
  assert.equal(rp._actionIsSafe('RM - 前缀大写也拦'), false); // 'rm -' lowercased match
  assert.equal(rp._actionIsSafe('sudo rm stuff'), false);
  assert.equal(rp._actionIsSafe('echo hi > /dev/sda'), false);
  assert.equal(rp._actionIsSafe('npm publish'), false);
});

test('_actionIsSafe：普通动作与空值都算安全（fail-soft 侧写）', () => {
  assert.equal(rp._actionIsSafe('重新探测目录状态'), true);
  assert.equal(rp._actionIsSafe(''), true);
  assert.equal(rp._actionIsSafe(null), true);
  assert.equal(rp._actionIsSafe(undefined), true);
  assert.equal(rp._actionIsSafe(123), true);
  // Trailing-space tokens: 'rmx' does NOT match 'rm ' — exact token form matters.
  assert.equal(rp._actionIsSafe('rmx something'), true);
});

test('_move 正常路径：字段齐全、order 取自策略表', () => {
  const m = rp._move(rp.STRATEGY_REPROBE, rp.AGENT, '重新探测目录状态', 'khy restore check', '理由');
  assert.deepEqual(m, {
    strategy: 'reprobe',
    autonomy: 'agent',
    action: '重新探测目录状态',
    verify: 'khy restore check',
    rationale: '理由',
    order: 10,
  });
});

test('_move 危险动作：强制 human 并隐去原文，未知策略 order 兜底 99', () => {
  const m = rp._move('unknown-strategy', rp.AGENT, 'rm -rf /tmp/x', undefined, null);
  assert.equal(m.autonomy, 'human');
  assert.equal(m.action, '（原消解动作含被禁令牌，已隐去）请查阅 khyos 官方还原文档人工处置。');
  assert.equal(m.verify, '');
  assert.equal(m.rationale, '');
  assert.equal(m.order, 99);
  assert.equal(m.strategy, 'unknown-strategy');
});

test('KNOWN-DEFECT: _move 传入 undefined 策略与 autonomy 时字段原样为 undefined，不自愈也不抛', () => {
  // resolverPolicy.js:77-89 → input: _move(undefined, undefined, null, null, null).
  // action null → String('') is safe, so autonomy is NOT forced to 'human':
  // measured: strategy === undefined, autonomy === undefined, order === 99.
  // Downstream排序/分派若直接读这两个字段会拿到 undefined 而非降级值。
  const m = rp._move(undefined, undefined, null, null, null);
  assert.equal(m.strategy, undefined);
  assert.equal(m.autonomy, undefined);
  assert.equal(m.action, '');
  assert.equal(m.verify, '');
  assert.equal(m.rationale, '');
  assert.equal(m.order, 99);
});

test('_hydrationBlockersAllNormal：无 blocker 一律 false（空数组不是"全正常"）', () => {
  assert.equal(rp._hydrationBlockersAllNormal({ blockers: [{ id: 'no-node-modules' }, { id: 'modules-not-hydrated' }] }), true);
  assert.equal(rp._hydrationBlockersAllNormal({ blockers: [] }), false);
  assert.equal(rp._hydrationBlockersAllNormal({}), false);
  assert.equal(rp._hydrationBlockersAllNormal(null), false);
  assert.equal(rp._hydrationBlockersAllNormal(undefined), false);
  assert.equal(rp._hydrationBlockersAllNormal({ blockers: [{ id: 'seed-missing' }] }), false);
  assert.equal(rp._hydrationBlockersAllNormal({ blockers: [{ id: 'no-node-modules' }, 'plain-string'] }), false);
});

test('_hydrationAllAgentFixable：空阻碍为 true，结构性 seed-missing 为 false', () => {
  assert.equal(rp._hydrationAllAgentFixable(null), true);
  assert.equal(rp._hydrationAllAgentFixable({ blockers: [] }), true);
  assert.equal(rp._hydrationAllAgentFixable({ blockers: [{ id: 'splitbrain-marker' }, { id: 'no-node-modules' }] }), true);
  assert.equal(rp._hydrationAllAgentFixable({ blockers: [{ id: 'seed-missing' }] }), false);
  assert.equal(rp._hydrationAllAgentFixable({ blockers: [{ id: 'unknown-blocker' }] }), false);
  assert.equal(rp._hydrationAllAgentFixable({ blockers: [null] }), false);
});
