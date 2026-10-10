'use strict';

/**
 * scoringEngine.test.js — co-located suite for checkpoint-weighted scoring (pure leaf).
 *
 * IO: none — ScoringEngine.compute only reads its arguments.
 *
 * Defects pinned as CURRENT behaviour (documentation, never approval):
 *   SC-E1  a checkpoint declared with weight 0 is silently promoted to weight 1
 *          (`cp.weight || 1` treats 0 as falsy).
 *   SC-E2  passing null as the checkpoints argument throws TypeError, because the
 *          `= []` default only fires on undefined.
 *   SC-E3  a non-iterable truthy checkpointResults throws TypeError — the
 *          `checkpointResults || []` guard only covers falsy values.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { ScoringEngine } = require('./scoringEngine');

describe('ScoringEngine.compute — 加权评分与判定', () => {
  it('全过检查点得满分并判 pass', () => {
    const s = new ScoringEngine();
    const r = s.compute(
      [{ checkpointId: 'a', passed: true }, { checkpointId: 'b', passed: true }],
      [{ id: 'a', weight: 2 }, { id: 'b', weight: 3 }]
    );
    assert.equal(r.autoScore, 1);
    assert.equal(r.verdict, 'pass');
    assert.equal(r.totalWeight, 5);
    assert.equal(r.earnedWeight, 5);
  });

  it('按权重比例计算并四舍五入到 4 位小数', () => {
    const s = new ScoringEngine();
    const r = s.compute(
      [{ checkpointId: 'a', passed: true }, { checkpointId: 'b', passed: false }, { checkpointId: 'c', passed: false }],
      [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }]
    );
    assert.equal(r.autoScore, 0.3333);
    assert.equal(r.verdict, 'fail');
    assert.deepEqual(r.breakdown, { totalWeight: 3, earnedWeight: 1 });
  });

  it('得分 0.8 判 pass、0.5 判 partial（边界含等号）', () => {
    const s = new ScoringEngine();
    const weights = [];
    const results = [];
    for (let i = 0; i < 10; i++) {
      weights.push({ id: 'c' + i, weight: 1 });
      results.push({ checkpointId: 'c' + i, passed: i < 8 });
    }
    assert.equal(s.compute(results, weights).verdict, 'pass');
    assert.equal(s.compute(results.map((cr, i) => ({ ...cr, passed: i < 5 })), weights).autoScore, 0.5);
    assert.equal(s.compute(results.map((cr, i) => ({ ...cr, passed: i < 5 })), weights).verdict, 'partial');
  });

  it('未知 checkpointId 回退权重 1 并原样带上结果', () => {
    const s = new ScoringEngine();
    const r = s.compute([{ checkpointId: 'x', passed: true }]);
    assert.equal(r.totalWeight, 1);
    assert.equal(r.autoScore, 1);
    assert.deepEqual(r.results, [{ checkpointId: 'x', passed: true, weight: 1 }]);
  });

  it('空结果集时 totalWeight 回退为 checkpoints.length 或 1', () => {
    const s = new ScoringEngine();
    const empty = s.compute([], [{ id: 'a' }, { id: 'b' }]);
    assert.equal(empty.totalWeight, 2);
    assert.equal(empty.autoScore, 0);
    assert.equal(empty.verdict, 'fail');
    assert.deepEqual(empty.results, []);
    assert.equal(s.compute(null, []).totalWeight, 1);
  });

  it('passed 按 truthy 判定：1 计earned、0 与 undefined 不计', () => {
    const s = new ScoringEngine();
    const r = s.compute(
      [{ checkpointId: 'a', passed: 1 }, { checkpointId: 'b', passed: 0 }, { checkpointId: 'c' }],
      [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }]
    );
    assert.equal(r.earnedWeight, 1);
    assert.equal(r.autoScore, 0.3333);
  });

  it('重复 checkpointId 各计一次权重（不去重）', () => {
    const s = new ScoringEngine();
    const r = s.compute(
      [{ checkpointId: 'a', passed: true }, { checkpointId: 'a', passed: false }],
      [{ id: 'a', weight: 2 }]
    );
    assert.equal(r.totalWeight, 4);
    assert.equal(r.earnedWeight, 2);
    assert.equal(r.autoScore, 0.5);
    assert.equal(r.verdict, 'partial');
  });

  it('负权重被 Math.max(0, w) 夹为 0，随后 totalWeight 回退为 checkpoints.length', () => {
    const s = new ScoringEngine();
    const r = s.compute(
      [{ checkpointId: 'a', passed: true, weight: -5 }],
      [{ id: 'a', weight: -5 }]
    );
    // per-item weight clamps to 0 → sum is 0 → fallback branch replaces it with 1
    assert.equal(r.results[0].weight, 0);
    assert.equal(r.earnedWeight, 0);
    assert.equal(r.totalWeight, 1);
    assert.equal(r.autoScore, 0);
    assert.equal(r.verdict, 'fail');
  });

  it('KNOWN-DEFECT: SC-E1 权重 0 被 || 兜底悄悄升为 1', () => {
    const s = new ScoringEngine();
    // measured: checkpoints [{id:'a',weight:0}] + passed:true → results[0].weight === 1, totalWeight === 1
    const r = s.compute([{ checkpointId: 'a', passed: true }], [{ id: 'a', weight: 0 }]);
    assert.equal(r.results[0].weight, 1);
    assert.equal(r.totalWeight, 1);
  });

  it('KNOWN-DEFECT: SC-E2 checkpoints 显式传 null 抛 TypeError（默认值只对 undefined 生效）', () => {
    const s = new ScoringEngine();
    assert.throws(
      () => s.compute([], null),
      { name: 'TypeError', message: /Cannot read properties of null \(reading 'map'\)/ }
    );
  });

  it('KNOWN-DEFECT: SC-E3 checkpointResults 传非可迭代的 truthy 值抛 TypeError', () => {
    const s = new ScoringEngine();
    assert.throws(
      () => s.compute({ notArray: true }),
      { name: 'TypeError', message: /is not iterable/ }
    );
  });
});
