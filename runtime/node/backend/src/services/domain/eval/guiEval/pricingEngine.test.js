'use strict';

/**
 * pricingEngine.test.js — co-located suite for payout computation (pure leaf).
 *
 * IO: none — PricingEngine.compute only reads its arguments.
 *
 * Defects pinned as CURRENT behaviour (documentation, never approval):
 *   PR-E1  a non-numeric basePrice yields payout NaN with no guard.
 *   PR-E2  max_duration: 0 silently falls back to the 300s default, so an
 *          expired-at-zero SLA never decays the time factor.
 *   PR-E3  difficulty lookup is case-sensitive; 'Hard' degrades to multiplier 1.0.
 *   PR-E4  doc says "超时每 10% 递减 5%" (stepped), code applies continuous linear decay.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { PricingEngine } = require('./pricingEngine');

describe('PricingEngine.compute — 报酬计算', () => {
  it('满分全额、SLA 内：basePrice × 难度系数', () => {
    const p = new PricingEngine();
    const r = p.compute(
      { pricing: { basePrice: 100 }, difficulty: 'hard', max_duration: 60 },
      { totalWeight: 4, earnedWeight: 4 },
      30
    );
    assert.equal(r.payout, 200);
    assert.equal(r.breakdown.basePrice, 100);
    assert.equal(r.breakdown.difficultyMultiplier, 2);
    assert.equal(r.breakdown.completionRatio, 1);
    assert.equal(r.breakdown.timeFactor, 1);
  });

  it('四档难度系数 easy=0.5 medium=1 hard=2 expert=5', () => {
    const p = new PricingEngine();
    const full = { totalWeight: 1, earnedWeight: 1 };
    for (const [d, m] of [['easy', 0.5], ['medium', 1], ['hard', 2], ['expert', 5]]) {
      const r = p.compute({ pricing: { basePrice: 100 }, difficulty: d }, full, 0);
      assert.equal(r.breakdown.difficultyMultiplier, m, d);
      assert.equal(r.payout, 100 * m, d);
    }
  });

  it('缺省：task 为 null 时 basePrice=320、maxDuration=300、ratio=0 → payout 0', () => {
    const p = new PricingEngine();
    const r = p.compute(null, null);
    assert.equal(r.payout, 0);
    assert.equal(r.breakdown.basePrice, 320);
    assert.equal(r.breakdown.maxDuration, 300);
    assert.equal(r.breakdown.completionRatio, 0);
    assert.equal(r.breakdown.timeFactor, 1);
  });

  it('完成比例按 earned/total 折算并保留 4 位小数', () => {
    const p = new PricingEngine();
    const r = p.compute({ pricing: { basePrice: 300 } }, { totalWeight: 3, earnedWeight: 1 }, 10);
    assert.equal(r.breakdown.completionRatio, 0.3333);
    assert.equal(r.payout, 100);
  });

  it('totalWeight 为 0 时完成比例强制 0，earn 值再高也不 payout', () => {
    const p = new PricingEngine();
    const r = p.compute({ pricing: { basePrice: 320 } }, { totalWeight: 0, earnedWeight: 5 }, 1);
    assert.equal(r.breakdown.completionRatio, 0);
    assert.equal(r.payout, 0);
  });

  it('_timeFactor：SLA 内=1、超时 10%=0.95、超时 200%=0.3 触底', () => {
    const p = new PricingEngine();
    assert.equal(p._timeFactor(100, 100), 1);
    assert.equal(p._timeFactor(100, 110), 0.95);
    assert.equal(p._timeFactor(100, 300), 0.3);
    assert.equal(p._timeFactor(100, 100000), 0.3);
  });

  it('_timeFactor：duration<=0 一律 1.0（含负数）', () => {
    const p = new PricingEngine();
    assert.equal(p._timeFactor(1, 0), 1);
    assert.equal(p._timeFactor(1, -5), 1);
  });

  it('payout 四舍五入到 2 位小数', () => {
    const p = new PricingEngine();
    // 320 * 1 * (1/3) * 1 = 106.666... → 106.67
    const r = p.compute({}, { totalWeight: 3, earnedWeight: 1 }, 1);
    assert.equal(r.payout, 106.67);
  });

  it('KNOWN-DEFECT: PR-E1 非数字 basePrice 直接产出 NaN，不做任何兜底', () => {
    const p = new PricingEngine();
    // measured: pricing.basePrice 'abc' → breakdown.basePrice NaN, payout NaN
    const r = p.compute({ pricing: { basePrice: 'abc' } }, { totalWeight: 2, earnedWeight: 2 }, 1);
    assert.ok(Number.isNaN(r.breakdown.basePrice));
    assert.ok(Number.isNaN(r.payout));
  });

  it('KNOWN-DEFECT: PR-E2 max_duration=0 被 || 兜底成 300，零 SLA 永不超时衰减', () => {
    const p = new PricingEngine();
    // measured: task.max_duration 0, durationSec 299 → timeFactor 1 (expected decay past 0s SLA)
    const r = p.compute({ max_duration: 0 }, { totalWeight: 1, earnedWeight: 1 }, 299);
    assert.equal(r.breakdown.maxDuration, 300);
    assert.equal(r.breakdown.timeFactor, 1);
  });

  it('KNOWN-DEFECT: PR-E3 难度大小写敏感，Hard 静默退为系数 1.0', () => {
    const p = new PricingEngine();
    // measured: difficulty 'Hard' → difficultyMultiplier 1.0 (hard would be 2.0)
    const r = p.compute({ pricing: { basePrice: 100 }, difficulty: 'Hard' }, { totalWeight: 1, earnedWeight: 1 }, 0);
    assert.equal(r.breakdown.difficulty, 'Hard');
    assert.equal(r.breakdown.difficultyMultiplier, 1);
    assert.equal(r.payout, 100);
  });

  it('KNOWN-DEFECT: PR-E4 超时衰减是连续线性而非文档所述每 10% 一档', () => {
    const p = new PricingEngine();
    // measured: overage 5% (ratio 1.05) → 0.975; a stepped reading of the doc would give 1.0
    assert.equal(p._timeFactor(100, 105), 0.975);
  });
});
