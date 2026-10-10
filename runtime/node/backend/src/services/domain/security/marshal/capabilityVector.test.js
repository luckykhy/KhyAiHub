'use strict';

/**
 * capabilityVector.test.js — 钉死 marshal 选举的能力向量投影：tier→向量、加权分、
 * strong/weak 判定与 env 阈值的钳制回退。
 *
 * 为什么这支套件必须存在：本模块是 marshal「谁当元帅」的唯一打分面——分数、阈值、强弱
 * 判定任何一处悄悄漂移，选出来的元帅就换了，而这不会有任何报错。用 require.cache 桩掉
 * modelTier，把「本层只经由 resolveTier / harnessProfile 两个出口投影」钉成断言；
 * env 读写只在 strongThreshold 一处，测内保存/还原 process.env。
 *
 * 实测更正（与注释/直觉不同处，按真实语义钉死）：
 *   · assess 无记忆化：每次调用 resolveTier 恰好 2 次（capabilityVector + capabilityScore
 *     各自独立解析一遍），harnessProfile 恰好 1 次。
 *   · 未知 tier 不抛：向量回退 T2 数值，但返回的 tier 字段仍是原始未知字符串——强弱按 50 分算。
 *   · env 阈值：非数字/空串 → 65；越界钳到 [0,100]；显式 '0' 生效（0 不被当缺失）。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const MT_PATH = require.resolve('../../../modelTier');
const ORIGINAL_MT = require.cache[MT_PATH];

const ENV_KEY = 'KHY_MARSHAL_STRONG_THRESHOLD';
const ORIG_ENV = process.env[ENV_KEY];

// ── 假 modelTier：只暴露 capabilityVector 用到的两个出口 ────────────────

const calls = { resolve: [], harness: [] };
const TIER_TABLE = new Map([['m0', 'T0'], ['m1', 'T1'], ['m2', 'T2'], ['m3', 'T3']]);

require.cache[MT_PATH] = {
  id: MT_PATH,
  filename: MT_PATH,
  loaded: true,
  exports: {
    resolveTier(modelId, opts = {}) {
      calls.resolve.push({ modelId, opts });
      if (typeof opts.forceTier === 'string') {
        return opts.forceTier;
      }
      return TIER_TABLE.get(modelId) || 'T2';
    },
    harnessProfile(tier) {
      calls.harness.push(tier);
      return { profileFor: tier };
    },
  },
};

const CV = require('./capabilityVector');

after(() => {
  if (ORIGINAL_MT) {
    require.cache[MT_PATH] = ORIGINAL_MT;
  } else {
    delete require.cache[MT_PATH];
  }
  if (ORIG_ENV === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = ORIG_ENV;
  }
});

// ── 常量面 ─────────────────────────────────────────────────────────────

test('TIER_VECTORS 冻结且每个维度严格单调 T0>T1>T2>T3', () => {
  assert.equal(Object.isFrozen(CV.TIER_VECTORS), true);
  assert.equal(Object.isFrozen(CV.TIER_VECTORS.T0), true);
  const dims = ['reasoning', 'planning', 'instruction', 'jsonStrict'];
  for (const d of dims) {
    assert.ok(CV.TIER_VECTORS.T0[d] > CV.TIER_VECTORS.T1[d], d);
    assert.ok(CV.TIER_VECTORS.T1[d] > CV.TIER_VECTORS.T2[d], d);
    assert.ok(CV.TIER_VECTORS.T2[d] > CV.TIER_VECTORS.T3[d], d);
  }
  assert.throws(() => {
    CV.TIER_VECTORS.T0.reasoning = 1;
  }, TypeError, '冻结不是装饰，写入必须实际失败');
});

test('SCORE_WEIGHTS 权重和为 1，reasoning 占主导', () => {
  const w = CV.SCORE_WEIGHTS;
  assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(w.reasoning > w.planning && w.planning > w.instruction && w.instruction > w.jsonStrict);
});

// ── capabilityVector / capabilityScore ─────────────────────────────────

test('capabilityVector: tier + 该 tier 向量原样展开', () => {
  calls.resolve.length = 0;
  const v = CV.capabilityVector('m1');
  assert.equal(v.tier, 'T1');
  assert.deepEqual(
    { reasoning: v.reasoning, planning: v.planning, instruction: v.instruction, jsonStrict: v.jsonStrict },
    { reasoning: 75, planning: 72, instruction: 78, jsonStrict: 80 }
  );
  assert.equal(calls.resolve.length, 1, '向量本身只解析一次 tier');
});

test('capabilityVector: 未知 tier 回退 T2 数值但保留原始 tier 字符串', () => {
  const v = CV.capabilityVector('x', { forceTier: 'T9' });
  assert.equal(v.tier, 'T9');
  assert.equal(v.reasoning, CV.TIER_VECTORS.T2.reasoning);
});

test('capabilityScore: 四 tier 的手算加权分（改权重表必须过这关）', () => {
  assert.equal(CV.capabilityScore('m0'), 97.5);
  assert.equal(CV.capabilityScore('m1'), 75.2);
  assert.equal(CV.capabilityScore('m2'), 50.5);
  assert.equal(CV.capabilityScore('m3'), 22.55);
});

// ── strongThreshold（env 面） ──────────────────────────────────────────

test('strongThreshold: 默认 65；显式数值生效（含 0）', () => {
  delete process.env[ENV_KEY];
  assert.equal(CV.strongThreshold(), CV.DEFAULT_STRONG_THRESHOLD);
  assert.equal(CV.DEFAULT_STRONG_THRESHOLD, 65);
  process.env[ENV_KEY] = '0';
  assert.equal(CV.strongThreshold(), 0, "字符串 '0' 是显式阈值，不被当缺失");
  process.env[ENV_KEY] = '80';
  assert.equal(CV.strongThreshold(), 80);
});

test('strongThreshold: 越界钳到 [0,100]；非数字/空串回退默认', () => {
  process.env[ENV_KEY] = '150';
  assert.equal(CV.strongThreshold(), 100);
  process.env[ENV_KEY] = '-5';
  assert.equal(CV.strongThreshold(), 0);
  process.env[ENV_KEY] = 'abc';
  assert.equal(CV.strongThreshold(), 65);
  process.env[ENV_KEY] = '';
  assert.equal(CV.strongThreshold(), 65);
});

// ── assess / isStrong ──────────────────────────────────────────────────

test('assess: 完整形状 + harness 来自 harnessProfile(tier)', () => {
  delete process.env[ENV_KEY];
  calls.harness.length = 0;
  const a = CV.assess('m2');
  assert.equal(a.modelId, 'm2');
  assert.equal(a.tier, 'T2');
  assert.equal(a.score, 50.5);
  assert.equal(a.strength, 'weak', 'reasoning 50 < 65');
  assert.deepEqual(a.harness, { profileFor: 'T2' });
  assert.deepEqual(a.vector, CV.capabilityVector('m2'));
  assert.equal(calls.harness.length, 1, 'harnessProfile 恰好一次');
});

test('assess 无记忆化：resolveTier 被独立解析两次（真实语义）', () => {
  calls.resolve.length = 0;
  CV.assess('m1', { forceTier: 'T1' });
  assert.equal(calls.resolve.length, 2, 'capabilityVector 与 capabilityScore 各解析一遍');
});

test('assess: 阈值把强弱切在 reasoning 维度上', () => {
  process.env[ENV_KEY] = '80';
  assert.equal(CV.assess('m1').strength, 'weak', 'T1 reasoning 75 < 80');
  assert.equal(CV.assess('m0').strength, 'strong', 'T0 reasoning 100 ≥ 80');
  process.env[ENV_KEY] = '75';
  assert.equal(CV.assess('m1').strength, 'strong', '恰好等于阈值算 strong（>=）');
});

test('isStrong: 与 assess.strength 同判据；modelId 假值收敛为空串不抛', () => {
  delete process.env[ENV_KEY];
  assert.equal(CV.isStrong('m0'), true);
  assert.equal(CV.isStrong('m2'), false);
  const a = CV.assess(null);
  assert.equal(a.modelId, '', 'String(modelId || "")');
  assert.equal(a.tier, 'T2', '假 id 走假表默认 T2');
});
