'use strict';

// 单元契约测试：route.js 的观测层——序列化必须**确定性**（不共享引用、丢 requires 明细），
// 人类形态必须一屏看懂「哪些能力组合了、为什么别的没进」。

const test = require('node:test');
const assert = require('node:assert/strict');

const { serializeRoute, formatRouteHuman } = require('./route');

const ROUTE = {
  preset: { id: 'delivery' },
  signals: { modes: ['coding', 'goal'] },
  active: ['structuredFurnace', 'verifyGate'],
  gatedOff: [{ id: 'selfKickoff', reason: 'gated-off' }],
  suppressed: [{ id: 'proactiveCollab', reason: 'subagent' }],
  budgetDropped: [{ id: 'depHealing', reason: 'budget' }],
  budgetUsed: 7,
  steps: [{
    id: 'verifyGate',
    label: '交付前校验',
    seam: 'EMPTY_TOOLCALLS',
    phase: 12,
    enabled: true,
    eligible: true,
    reason: null,
    inPreset: true,
    requires: { tool_use: 3 },
  }],
};

test('空/垃圾入参 → 固定空壳，绝不抛', () => {
  for (const junk of [null, undefined, 'x', 42]) {
    assert.deepEqual(serializeRoute(junk), {
      active: [],
      preset: null,
      signals: { modes: [] },
      gatedOff: [],
      suppressed: [],
      budgetDropped: [],
    });
    assert.equal(formatRouteHuman(junk), 'route: (empty)');
  }
});

test('序列化只留观测字段：steps 压成 7 个字段并丢弃 requires 明细', () => {
  const out = serializeRoute(ROUTE);
  assert.equal(out.preset, 'delivery');
  assert.deepEqual(out.signals.modes, ['coding', 'goal']);
  assert.deepEqual(out.active, ['structuredFurnace', 'verifyGate']);
  assert.deepEqual(out.gatedOff, [{ id: 'selfKickoff', reason: 'gated-off' }]);
  assert.deepEqual(out.budgetDropped, [{ id: 'depHealing', reason: 'budget' }]);
  assert.equal(out.budgetUsed, 7);
  assert.deepEqual(Object.keys(out.steps[0]).sort(), [
    'eligible', 'enabled', 'id', 'inPreset', 'phase', 'reason', 'seam',
  ]);
  // The observation-only contract: nothing that costs bytes or leaks internals survives.
  for (const dropped of ['label', 'owner', 'requires', 'cost', 'wired', 'isReversible']) {
    assert.equal(dropped in out.steps[0], false, `serializeRoute must drop ${dropped}`);
  }
});

test('确定性：数组字段是副本而不是同一引用（事件序列化不得被后续改写）', () => {
  const out = serializeRoute(ROUTE);
  out.active.push('mutated');
  ROUTE.signals.modes.push('mutated');
  assert.deepEqual(serializeRoute(ROUTE).active, ['structuredFurnace', 'verifyGate']);
  assert.equal(ROUTE.signals.modes.includes('mutated'), true, '探针自身要证明原数组仍可改');
});

test('缺件容忍：没有 steps / 没有 preset 的半截 Route 也要出得来', () => {
  const out = serializeRoute({ active: ['a'] });
  assert.equal(out.preset, null);
  assert.deepEqual(out.steps, []);
  assert.deepEqual(out.gatedOff, []);
  assert.equal(out.budgetUsed, 0);
});

test('人类形态：管线用 → 连接，三类排除各占一行并带原因', () => {
  const line = formatRouteHuman(ROUTE);
  assert.ok(line.startsWith('route[delivery]: structuredFurnace→verifyGate'), line);
  assert.ok(line.includes('· gated-off: selfKickoff'), line);
  assert.ok(line.includes('· suppressed: proactiveCollab(subagent)'), line);
  assert.ok(line.includes('· budget-dropped: depHealing(budget)'), line);
});

test('人类形态：无预设、无活动能力时读数诚实（不伪装成有管线）', () => {
  assert.equal(formatRouteHuman({ active: [] }), 'route: (none active)');
  assert.equal(formatRouteHuman({ preset: null, active: ['a'] }), 'route: a');
});
