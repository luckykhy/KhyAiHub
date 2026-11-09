'use strict';

/**
 * index.test.js — co-located suite for reproducible evaluation aggregation (A6).
 *
 * IO: none — runEvaluation is a pure function of its arguments. The provider
 * measurement layer is deliberately absent, so unmeasured input must error
 * instead of returning simulated scores (the old 0.85+Math.random() path gave
 * a different score for identical input on every call).
 *
 * Formula aligned item-by-item with guiEval ScoringEngine:
 *   autoScore = earnedWeight / totalWeight
 *   verdict:  >= 0.8 pass / >= 0.5 partial / else fail
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { runEvaluation } = require('./index');

const BASE = { model: 'test-model', prompt: 'test-prompt' };

describe('runEvaluation — 加权聚合（公式对齐 guiEval）', () => {
  it('按权重逐项累计：过 2 不过 3 得 0.4，判 fail', async () => {
    const r = await runEvaluation({
      ...BASE,
      metrics: [
        { metric: 'accuracy', passed: true, weight: 2 },
        { metric: 'relevance', passed: false, weight: 3 },
      ],
    });
    assert.equal(r.success, true);
    assert.equal(r.results.overallScore, 0.4);
    assert.equal(r.results.verdict, 'fail');
    assert.equal(r.results.breakdown.totalWeight, 5);
    assert.equal(r.results.breakdown.earnedWeight, 2);
    assert.deepEqual(
      r.results.breakdown.items.map((i) => [i.metric, i.passed, i.weight]),
      [['accuracy', true, 2], ['relevance', false, 3]]
    );
  });

  it('weight 缺省为 1：等权三项过二得 0.6667（四位小数），判 partial', async () => {
    const r = await runEvaluation({
      ...BASE,
      metrics: ['accuracy', 'relevance', 'coherence'].map((m, i) => ({ metric: m, passed: i < 2 })),
    });
    assert.equal(r.results.overallScore, 0.6667);
    assert.equal(r.results.verdict, 'partial');
    assert.deepEqual(r.results.breakdown.items.map((i) => i.weight), [1, 1, 1]);
    assert.equal(r.results.scores.accuracy.type, 'Accuracy Score');
  });

  it('三档边界含等号：0.8 判 pass、0.5 判 partial、0.4 判 fail', async () => {
    const scoreAt = async (passedCount) => {
      const r = await runEvaluation({
        ...BASE,
        metrics: Array.from({ length: 10 }, (_, i) => ({ metric: `c${i}`, passed: i < passedCount })),
      });
      return r.results;
    };
    const pass = await scoreAt(8);
    assert.equal(pass.overallScore, 0.8);
    assert.equal(pass.verdict, 'pass');
    const partial = await scoreAt(5);
    assert.equal(partial.overallScore, 0.5);
    assert.equal(partial.verdict, 'partial');
    const fail = await scoreAt(4);
    assert.equal(fail.overallScore, 0.4);
    assert.equal(fail.verdict, 'fail');
  });

  it('全过得 1 判 pass', async () => {
    const r = await runEvaluation({
      ...BASE,
      metrics: [{ metric: 'accuracy', passed: true }, { metric: 'safety', passed: true }],
    });
    assert.equal(r.results.overallScore, 1);
    assert.equal(r.results.verdict, 'pass');
  });

  it('evidence 逐项带入 scores 与 breakdown（可解释结构）', async () => {
    const r = await runEvaluation({
      ...BASE,
      metrics: [{ metric: 'accuracy', passed: false, evidence: 'expectedOutput 未提供，无法比对' }],
    });
    assert.equal(r.results.scores.accuracy.evidence, 'expectedOutput 未提供，无法比对');
    assert.equal(r.results.breakdown.items[0].evidence, 'expectedOutput 未提供，无法比对');
    assert.equal(r.results.breakdown.earnedWeight, 0);
  });

  it('同输入两次调用逐字段一致（可复算，无随机分）', async () => {
    const opts = {
      ...BASE,
      metrics: [
        { metric: 'accuracy', passed: true, weight: 2 },
        { metric: 'safety', passed: false },
      ],
    };
    const a = await runEvaluation(opts);
    const b = await runEvaluation(opts);
    assert.equal(a.results.overallScore, b.results.overallScore);
    assert.equal(a.results.verdict, b.results.verdict);
    assert.deepEqual(a.results.breakdown, b.results.breakdown);
    assert.deepEqual(a.results.scores, b.results.scores);
  });

  // Mirrors guiEval KNOWN-DEFECT SC-E1 (scoringEngine.test.js): the copied
  // `weight || 1` promotes an explicit 0 to 1, so both engines stay identical
  // — and any future drift between the two copies becomes visible here.
  it('KNOWN-DEFECT: weight 0 被 || 兜底悄悄升为 1（与 guiEval SC-E1 同源）', async () => {
    const r = await runEvaluation({
      ...BASE,
      metrics: [{ metric: 'accuracy', passed: true, weight: 0 }],
    });
    assert.equal(r.results.breakdown.items[0].weight, 1);
    assert.equal(r.results.breakdown.totalWeight, 1);
    assert.equal(r.results.overallScore, 1);
  });
});

describe('runEvaluation — 无实测结果明确报错', () => {
  it('默认字符串 metrics：报错且不返回任何分数', async () => {
    const r = await runEvaluation({ ...BASE });
    assert.equal(r.success, undefined);
    assert.equal(r.results, undefined);
    assert.match(r.error, /无法评分/);
    assert.match(r.error, /accuracy/);
  });

  it('metrics 为空数组：报错而非零分', async () => {
    const r = await runEvaluation({ ...BASE, metrics: [] });
    assert.equal(r.success, undefined);
    assert.match(r.error, /无法评分/);
  });

  it('混合输入：未实测项列名报错，不静默按未过计入', async () => {
    const r = await runEvaluation({
      ...BASE,
      metrics: [{ metric: 'accuracy', passed: true }, 'relevance'],
    });
    assert.equal(r.success, undefined);
    assert.match(r.error, /relevance/);
  });

  it('缺 model 或 prompt 仍报错（既有契约不变）', async () => {
    assert.match((await runEvaluation({ prompt: 'p' })).error, /Model is required/);
    assert.match((await runEvaluation({ model: 'm' })).error, /Prompt is required/);
  });
});
