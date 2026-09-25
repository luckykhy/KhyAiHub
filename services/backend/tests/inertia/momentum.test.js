'use strict';

/**
 * momentum.test.js — 动量纯函数 + 七类停机判定核心（[DESIGN-ARCH-160] §3.5/§3.4）。
 * node:test 纪律：CI 以 node --test 全量扫描 tests 目录，jest 风格落地即红。
 */

const test = require('node:test');
const assert = require('node:assert');

const { nextMomentum, decideStop } = require('../../src/services/inertia/momentum');
const { DEFAULTS, MOMENTUM_START } = require('../../src/services/inertia/defaults');

// ── nextMomentum ────────────────────────────────────────────────────────

test('momentum: 起点为 MOMENTUM_START（1.0）', () => {
  const r = nextMomentum(MOMENTUM_START, [], DEFAULTS.decay);
  assert.strictEqual(r.momentum, 1.0);
  assert.strictEqual(r.stopDecision, null);
});

test('momentum: progress 恢复并封顶 1.0', () => {
  const r1 = nextMomentum(0.9, ['progress'], DEFAULTS.decay);
  assert.strictEqual(r1.momentum, 1.0); // 0.9 + 0.2 → 封顶
  const r2 = nextMomentum(0.5, ['progress'], DEFAULTS.decay);
  assert.ok(Math.abs(r2.momentum - 0.7) < 1e-9);
  assert.strictEqual(r2.stopDecision, null);
});

test('momentum: 各衰减事件按常数扣减', () => {
  const d = DEFAULTS.decay;
  assert.ok(Math.abs(nextMomentum(1.0, ['no_progress'], d).momentum - (1.0 - d.noProgressPenalty)) < 1e-9);
  assert.ok(Math.abs(nextMomentum(1.0, ['repeat'], d).momentum - (1.0 - d.repeatPenalty)) < 1e-9);
  assert.ok(Math.abs(nextMomentum(1.0, ['deny'], d).momentum - (1.0 - d.denyPenalty)) < 1e-9);
  assert.ok(Math.abs(nextMomentum(1.0, ['error'], d).momentum - (1.0 - d.errorPenalty)) < 1e-9);
});

test('momentum: 多事件顺序累加', () => {
  const d = DEFAULTS.decay;
  // 1.0 - deny(0.3) - error(0.4) = 0.3
  const r = nextMomentum(1.0, ['deny', 'error'], d);
  assert.ok(Math.abs(r.momentum - 0.3) < 1e-9);
});

test('momentum: 跌破 stopBelow → stopDecision decay', () => {
  const d = DEFAULTS.decay;
  // 1.0 - error(0.4) - error(0.4) = 0.2；0.2 < stopBelow(0.2) 为 false（严格小于）
  const at = nextMomentum(1.0, ['error', 'error'], d);
  assert.strictEqual(at.stopDecision, null);
  // 再 -0.15 → 0.05 < 0.2 → decay
  const below = nextMomentum(at.momentum, ['no_progress'], d);
  assert.strictEqual(below.stopDecision, 'decay');
  assert.ok(below.momentum < d.stopBelow);
});

test('momentum: clamp 到 [0,1]，不出现负数', () => {
  const r = nextMomentum(0.1, ['error', 'error', 'error'], DEFAULTS.decay);
  assert.strictEqual(r.momentum, 0);
  assert.strictEqual(r.stopDecision, 'decay');
});

test('momentum: 未知事件忽略；坏输入不抛（绝不抛纪律）', () => {
  assert.doesNotThrow(() => {
    const r = nextMomentum(1.0, ['unknown_event', null, undefined, 42], DEFAULTS.decay);
    assert.strictEqual(r.momentum, 1.0); // 全部忽略
  });
  assert.doesNotThrow(() => nextMomentum(NaN, ['progress'], DEFAULTS.decay));
  assert.doesNotThrow(() => nextMomentum(undefined, 'not-an-array', DEFAULTS.decay));
  assert.doesNotThrow(() => nextMomentum(1.0, null, null));
  // NaN prev → 回落 MOMENTUM_START
  assert.strictEqual(nextMomentum(NaN, [], DEFAULTS.decay).momentum, MOMENTUM_START);
});

test('momentum: 不改入参（events 数组原样）', () => {
  const events = ['deny', 'error'];
  const frozen = Object.freeze([...events]);
  nextMomentum(1.0, events, DEFAULTS.decay);
  assert.deepStrictEqual(events, frozen);
});

test('momentum: constants 缺省回落 defaults；注入常数生效', () => {
  // 缺省
  assert.strictEqual(nextMomentum(1.0, ['error'], undefined).momentum, 0.6);
  // 注入收紧（更重惩罚 + 更高停车线）
  const tight = { noProgressPenalty: 0.5, repeatPenalty: 0.5, denyPenalty: 0.5, errorPenalty: 0.5, progressRestore: 0, stopBelow: 0.5 };
  const r = nextMomentum(1.0, ['error'], tight);
  assert.strictEqual(r.momentum, 0.5);
  assert.strictEqual(r.stopDecision, null); // 0.5 < 0.5 为 false
  const r2 = nextMomentum(r.momentum, ['no_progress'], tight);
  assert.strictEqual(r2.stopDecision, 'decay');
});

// ── decideStop（§3.4 七类机械判定） ─────────────────────────────────────

const BUDGET = DEFAULTS.budget;
const DECAY = DEFAULTS.decay;
const CFG = { decay: DECAY, budget: BUDGET, consecutiveErrorsForStop: DEFAULTS.consecutiveErrorsForStop };

test('decideStop: completed 优先于一切', () => {
  const r = decideStop(
    { completed: true, aborted: true, consecutiveErrors: 99, denies: 99, turns: 999 },
    CFG
  );
  assert.strictEqual(r.stop, 'completed');
  assert.strictEqual(r.reason, 'completion_probe_green');
});

test('decideStop: external（abort / 租约到期）', () => {
  assert.strictEqual(decideStop({ aborted: true }, CFG).stop, 'external');
  assert.strictEqual(decideStop({ aborted: true }, CFG).reason, 'abort_signal');
  assert.strictEqual(decideStop({ leaseExpired: true }, CFG).stop, 'external');
  assert.strictEqual(decideStop({ leaseExpired: true }, CFG).reason, 'lease_expired');
});

test('decideStop: error（连续错误达阈值）', () => {
  const r = decideStop({ consecutiveErrors: 3 }, CFG);
  assert.strictEqual(r.stop, 'error');
  assert.strictEqual(r.reason, 'consecutive_errors_3');
  assert.strictEqual(decideStop({ consecutiveErrors: 2 }, CFG).stop, null);
});

test('decideStop: privilege（deny 计数达 maxDenies）', () => {
  const r = decideStop({ denies: BUDGET.maxDenies }, CFG);
  assert.strictEqual(r.stop, 'privilege');
  assert.strictEqual(r.reason, 'deny_budget_exhausted');
  assert.strictEqual(decideStop({ denies: BUDGET.maxDenies - 1 }, CFG).stop, null);
});

test('decideStop: ambiguity', () => {
  const r = decideStop({ ambiguity: true }, CFG);
  assert.strictEqual(r.stop, 'ambiguity');
  assert.strictEqual(r.reason, 'model_decision_request');
});

test('decideStop: budget 四细分（idle > wall > turns > cost）', () => {
  assert.deepStrictEqual(decideStop({ idleMs: BUDGET.maxIdleMs }, CFG), { stop: 'budget', reason: 'idle' });
  assert.deepStrictEqual(decideStop({ wallMs: BUDGET.maxWallMs }, CFG), { stop: 'budget', reason: 'wall' });
  assert.deepStrictEqual(decideStop({ turns: BUDGET.maxTurns }, CFG), { stop: 'budget', reason: 'turns' });
  assert.deepStrictEqual(decideStop({ costCny: BUDGET.maxCostCny }, CFG), { stop: 'budget', reason: 'cost' });
});

test('decideStop: decay（momentum < stopBelow）', () => {
  const r = decideStop({ momentum: DECAY.stopBelow - 0.01 }, CFG);
  assert.strictEqual(r.stop, 'decay');
  assert.strictEqual(r.reason, 'momentum_below_stopBelow');
  assert.strictEqual(decideStop({ momentum: DECAY.stopBelow }, CFG).stop, null);
});

test('decideStop: 优先级——治理类先于资源类', () => {
  // error 与 budget 同超 → error 优先
  assert.strictEqual(decideStop({ consecutiveErrors: 3, turns: BUDGET.maxTurns }, CFG).stop, 'error');
  // privilege 与 budget 同超 → privilege 优先
  assert.strictEqual(decideStop({ denies: BUDGET.maxDenies, turns: BUDGET.maxTurns }, CFG).stop, 'privilege');
  // ambiguity 与 budget 同超 → ambiguity 优先
  assert.strictEqual(decideStop({ ambiguity: true, turns: BUDGET.maxTurns }, CFG).stop, 'ambiguity');
  // budget 与 decay 同超 → budget 优先
  assert.strictEqual(
    decideStop({ turns: BUDGET.maxTurns, momentum: DECAY.stopBelow - 0.01 }, CFG).stop,
    'budget'
  );
});

test('decideStop: 无停机 → null；坏输入不抛', () => {
  assert.strictEqual(decideStop({}, CFG).stop, null);
  assert.doesNotThrow(() => decideStop(null, null));
  assert.strictEqual(decideStop(null, null).stop, null);
});
