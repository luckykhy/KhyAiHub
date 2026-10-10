'use strict';

/**
 * reviewService.test.js — co-located suite for the human-review workflow.
 *
 * IO: none — `@khy/shared/models` is replaced in require.cache before the service is
 * loaded, so no sequelize instance is built and no sqlite file is opened. The real
 * PricingEngine is kept (it is a pure leaf) so payout numbers pin end-to-end behaviour.
 *
 * Defects pinned as CURRENT behaviour (documentation, never approval):
 *   RS-E1  Number(opts.manualScore) coerces null / '' / [] to 0 and true to 1, so a
 *          malformed API payload is recorded as a real score instead of being rejected.
 *   RS-E2  finalScore = Math.max(auto, manual), so a human low score can never lower
 *          the verdict or the payout of a high auto score.
 *   RS-E3  task.difficulty is forwarded unvalidated into PricingEngine's plain-object
 *          DIFFICULTY_MAP, so an inherited prototype key yields a function multiplier
 *          and a NaN payout_amount that is then persisted.
 *   RS-E4  needsReview(null) throws although the JSDoc types `run` as a plain object.
 *   RS-E5  non-numeric auto_score silently reads as "no review needed".
 *   RS-E6  three separate run.update() calls: a late failure leaves manual_score and
 *          verdict already written.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const MODELS_PATH = require.resolve('@khy/shared/models');
const ORIGINAL_MODELS = require.cache[MODELS_PATH];

let stubRun = null;
let findCalls = [];
const modelsStub = new Module(MODELS_PATH, null);
modelsStub.filename = MODELS_PATH;
modelsStub.loaded = true;
modelsStub.exports = {
  GuiEvalRun: {
    async findByPk(id) {
      findCalls.push(id);
      return stubRun;
    },
  },
};
require.cache[MODELS_PATH] = modelsStub;

after(() => {
  if (ORIGINAL_MODELS) require.cache[MODELS_PATH] = ORIGINAL_MODELS;
  else delete require.cache[MODELS_PATH];
});

const service = require('./reviewService');
const { PricingEngine } = require('./pricingEngine');

function makeRun(over = {}) {
  const updates = [];
  const run = {
    id: 7,
    auto_score: 0.4,
    manual_score: null,
    verdict: 'pending_review',
    total_duration: 100,
    _updates: updates,
    async update(patch) {
      updates.push(patch);
      Object.assign(run, patch);
      return run;
    },
  };
  return Object.assign(run, over);
}

test('导出的是单例 ReviewService 实例并自带 PricingEngine', () => {
  assert.equal(typeof service.needsReview, 'function');
  assert.equal(typeof service.submitReview, 'function');
  assert.equal(service.constructor.name, 'ReviewService');
  assert.ok(service._pricingEngine instanceof PricingEngine);
  assert.equal(require('./reviewService'), service);
});

test('needsReview 在 verdict 已是 pending_review 时无条件返回 true', () => {
  assert.equal(service.needsReview({ verdict: 'pending_review', auto_score: 1 }), true);
});

test('needsReview 的 0.5 阈值是严格小于，等号即免审', () => {
  assert.equal(service.needsReview({ auto_score: 0.5 }), false);
  assert.equal(service.needsReview({ auto_score: 0.4999 }), true);
  assert.equal(service.needsReview({ auto_score: 0 }), true);
  assert.equal(service.needsReview({ auto_score: 1 }), false);
});

test('needsReview 空 run 与缺字段一律按 0 分判需审', () => {
  assert.equal(service.needsReview({}), true);
  assert.equal(service.needsReview({ verdict: 'pass' }), true);
});

test('needsReview 优先取 manual_score，null 与 undefined 才回退 auto_score', () => {
  assert.equal(service.needsReview({ manual_score: 0, auto_score: 0.9 }), true);
  assert.equal(service.needsReview({ manual_score: null, auto_score: 0.9 }), false);
  assert.equal(service.needsReview({ manual_score: undefined, auto_score: 0.1 }), true);
  assert.equal(service.needsReview({ manual_score: 0.9, auto_score: 0.1 }), false);
  assert.equal(service.needsReview({ manual_score: false, auto_score: 0.9 }), true);
});

test('needsReview 的 verdict 比对区分大小写', () => {
  assert.equal(service.needsReview({ verdict: 'PENDING_REVIEW', auto_score: 1 }), false);
});

test('needsReview 完全忽略第二个 task 参数', () => {
  const run = { auto_score: 0.9 };
  for (const task of [undefined, null, {}, { forceReview: true }]) {
    assert.equal(service.needsReview(run, task), false);
  }
});

test('KNOWN-DEFECT: RS-E5 非数字 auto_score 被判成无需人工复核', () => {
  // measured: 'abc' / {} / true compare NaN-ish against 0.5 and fall out as false,
  // while [] coerces to 0 and flips the same guard to true.
  assert.equal(service.needsReview({ auto_score: 'abc' }), false);
  assert.equal(service.needsReview({ auto_score: '0.6' }), false);
  assert.equal(service.needsReview({ auto_score: {} }), false);
  assert.equal(service.needsReview({ auto_score: true }), false);
  assert.equal(service.needsReview({ auto_score: [] }), true);
  assert.equal(service.needsReview({ auto_score: NaN }), true);
  assert.equal(service.needsReview({ auto_score: -1 }), true);
});

test('KNOWN-DEFECT: RS-E4 needsReview(null) 抛 TypeError，非对象入参只读不到字段', () => {
  assert.throws(() => service.needsReview(null), {
    name: 'TypeError',
    message: /Cannot read properties of null \(reading 'verdict'\)/,
  });
  assert.throws(() => service.needsReview(), { name: 'TypeError' });
  assert.equal(service.needsReview('junk'), true);
  assert.equal(service.needsReview([1, 2]), true);
  assert.equal(service.needsReview(5), true);
});

test('submitReview 走完三段写入并返回 run 与 pricing', async () => {
  stubRun = makeRun();
  const r = await service.submitReview(
    7,
    { manualScore: 0.9 },
    { pricing: { basePrice: 100 }, difficulty: 'hard', max_duration: 50 }
  );
  assert.equal(r.run, stubRun);
  assert.deepEqual(Object.keys(r), ['run', 'pricing']);
  assert.equal(r.run.verdict, 'pass');
  assert.equal(r.run.manual_score, 0.9);
  assert.equal(r.pricing.payout, 90);
  assert.deepEqual(r.run._updates, [
    { manual_score: 0.9 },
    { verdict: 'pass' },
    {
      payout_amount: 90,
      pricing_breakdown: {
        basePrice: 100,
        difficulty: 'hard',
        difficultyMultiplier: 2,
        completionRatio: 0.9,
        timeFactor: 0.5,
        durationSec: 100,
        maxDuration: 50,
      },
    },
  ]);
});

test('submitReview 的判定边界 0.8 pass / 0.5 partial / 略低即 fail', async () => {
  const probes = [[0.8, 'pass'], [0.5, 'partial'], [0.49999, 'fail']];
  for (const [score, expected] of probes) {
    stubRun = makeRun({ auto_score: 0 });
    const r = await service.submitReview(7, { manualScore: score }, { pricing: { basePrice: 100 } });
    assert.equal(r.run.verdict, expected, String(score));
  }
});

test('submitReview 把 runId 原样交给 findByPk，未做任何校验', async () => {
  findCalls = [];
  stubRun = makeRun();
  await service.submitReview('42', { manualScore: 0.5 }, {});
  assert.deepEqual(findCalls, ['42']);
  findCalls = [];
  stubRun = makeRun();
  await service.submitReview(undefined, { manualScore: 0.5 }, {});
  assert.deepEqual(findCalls, [undefined]);
});

test('submitReview 拒绝越界与不可比的分数', async () => {
  for (const bad of [-1, 2, 'abc', undefined, NaN, Infinity, {}, [1, 2], '1.5']) {
    stubRun = makeRun();
    await assert.rejects(
      () => service.submitReview(7, { manualScore: bad }, {}),
      { message: 'manualScore must be between 0 and 1' },
      String(bad)
    );
  }
});

test('submitReview 在查不到 run 时抛 Run not found', async () => {
  stubRun = null;
  await assert.rejects(() => service.submitReview(99, { manualScore: 0.5 }, {}), {
    message: 'Run not found',
  });
});

test('submitReview 缺 task 时落到 320 默认价，缺 total_duration 时按 0 秒计费', async () => {
  stubRun = makeRun({ auto_score: 0.5, total_duration: undefined });
  const r = await service.submitReview(7, { manualScore: 0.5 }, null);
  assert.equal(r.pricing.breakdown.basePrice, 320);
  assert.equal(r.pricing.breakdown.durationSec, 0);
  assert.equal(r.pricing.breakdown.maxDuration, 300);
  assert.equal(r.pricing.payout, 160);
});

test('submitReview 用 run.total_duration 惩罚超时', async () => {
  stubRun = makeRun({ auto_score: 0.6, total_duration: 1000 });
  const r = await service.submitReview(
    7,
    { manualScore: 1 },
    { pricing: { basePrice: 320 }, max_duration: 100 }
  );
  assert.equal(r.pricing.breakdown.timeFactor, 0.3);
  assert.equal(r.run.verdict, 'pass');
  assert.equal(r.pricing.payout, 96);
});

test('KNOWN-DEFECT: RS-E1 null 与空串与空数组被 Number 折成 0 分，true 折成满分', async () => {
  const coerced = [[null, 0], ['', 0], [[], 0], [true, 1], ['0.5', 0.5], [[0.5], 0.5], [-0, -0]];
  for (const [input, expected] of coerced) {
    stubRun = makeRun();
    const r = await service.submitReview(7, { manualScore: input }, {});
    assert.equal(r.run.manual_score, expected, String(input));
  }
  stubRun = makeRun();
  const zero = await service.submitReview(7, { manualScore: null }, {});
  assert.equal(zero.run.verdict, 'fail');
});

test('KNOWN-DEFECT: RS-E2 人工低分永远压不动高分 auto 的判定与报酬', async () => {
  // measured: manual 0.1 against auto 0.95 still stores verdict pass and pays on 0.95.
  stubRun = makeRun({ auto_score: 0.95 });
  const r = await service.submitReview(7, { manualScore: 0.1 }, { pricing: { basePrice: 100 } });
  assert.equal(r.run.manual_score, 0.1);
  assert.equal(r.run.verdict, 'pass');
  assert.equal(r.pricing.breakdown.completionRatio, 0.95);
  assert.equal(r.pricing.payout, 95);

  stubRun = makeRun({ auto_score: 0.8 });
  const down = await service.submitReview(7, { manualScore: 0.2 }, {});
  assert.equal(down.run.verdict, 'pass');
});

test('KNOWN-DEFECT: RS-E3 task.difficulty 命中原型链时把 NaN 报酬写进库', async () => {
  for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    stubRun = makeRun({ auto_score: 0.5 });
    const r = await service.submitReview(7, { manualScore: 0.5 }, { difficulty: key, pricing: { basePrice: 100 } });
    assert.equal(typeof r.pricing.breakdown.difficultyMultiplier, 'function', key);
    assert.ok(Number.isNaN(r.pricing.payout), key);
    assert.ok(Number.isNaN(r.run._updates[2].payout_amount), key);
  }
  stubRun = makeRun({ auto_score: 0.5 });
  const proto = await service.submitReview(7, { manualScore: 0.5 }, { difficulty: '__proto__', pricing: { basePrice: 100 } });
  assert.equal(typeof proto.pricing.breakdown.difficultyMultiplier, 'object');
  assert.ok(Number.isNaN(proto.pricing.payout));
});

test('KNOWN-DEFECT: RS-E6 写入分三段，第三段失败时前两段落库且异常不被吞', async () => {
  let writes = 0;
  stubRun = {
    auto_score: 0.5,
    total_duration: 0,
    async update(patch) {
      writes += 1;
      if (writes === 3) throw new Error('db down');
      return this;
    },
  };
  await assert.rejects(() => service.submitReview(7, { manualScore: 0.5 }, {}), { message: 'db down' });
  assert.equal(writes, 3);
});

test('submitReview 的 opts 缺失即抛 TypeError，不做参数兜底', async () => {
  stubRun = makeRun();
  await assert.rejects(() => service.submitReview(7, undefined, {}), {
    name: 'TypeError',
    message: /Cannot read properties of undefined \(reading 'manualScore'\)/,
  });
  await assert.rejects(() => service.submitReview(7, null, {}), { name: 'TypeError' });
});
