'use strict';

/**
 * conditionalRoute 纯叶子 + autoModelRouting.rank 的条件路由接入点测试
 * （[MGMT-RPT-035] §四 L6，借鉴 Portkey gateway 的 conditionalRouter）。
 *
 * 测两件事，缺一不可：
 *   1. 叶子：算子求值 / 顺序命中 / default 兜底 / 优先级提升（纯函数，全离线）
 *   2. 接缝：**不给 opts.conditional 时 rank 的结果与今日逐字节一致** ——
 *      这是本项落地唯一的风险点。L5/L6 这一类「加一个可选轴」的改动，
 *      最常见的死法就是顺手改了默认路径还全绿。
 */

const test = require('node:test');
const assert = require('node:assert');

const cr = require('./conditionalRoute');
const amr = require('./autoModelRouting');

const RANK_ENV = {
  KHY_AUTO_MODEL_HEALTH_AWARE: '1',
  KHY_ROUTING_MODES: '1',
  GATEWAY_ROUTING_MODE: 'auto',
};

// ── 1. 纯叶子 ────────────────────────────────────────────────────────────

test('getPath: 点号路径取值，缺段返回 undefined 且不抛', () => {
  const ctx = { metadata: { user: { plan: 'paid' } }, params: { model: 'gpt' }, path: '/v1/chat' };
  assert.strictEqual(cr.getPath('metadata.user.plan', ctx), 'paid');
  assert.strictEqual(cr.getPath('params.model', ctx), 'gpt');
  assert.strictEqual(cr.getPath('path', ctx), '/v1/chat');
  assert.strictEqual(cr.getPath('metadata.user.missing', ctx), undefined);
  assert.strictEqual(cr.getPath('metadata.user.plan.deeper', ctx), undefined);
  assert.strictEqual(cr.getPath('', ctx), undefined);
  assert.strictEqual(cr.getPath('a.b', null), undefined);
  assert.strictEqual(cr.getPath('a.b', 'nope'), undefined);
});

test('evaluate: 全部算子的真假（对齐 Portkey conditionalRouter 的算子表）', () => {
  const ctx = { metadata: { plan: 'paid', seats: 12 }, params: { model: 'gpt-4o' }, path: '/v1/chat' };
  assert.ok(cr.evaluate({ 'metadata.plan': { $eq: 'paid' } }, ctx));
  assert.ok(!cr.evaluate({ 'metadata.plan': { $eq: 'free' } }, ctx));
  assert.ok(cr.evaluate({ 'metadata.plan': { $ne: 'free' } }, ctx));
  assert.ok(cr.evaluate({ 'metadata.seats': { $gt: 10 } }, ctx));
  assert.ok(cr.evaluate({ 'metadata.seats': { $gte: 12 } }, ctx));
  assert.ok(!cr.evaluate({ 'metadata.seats': { $gt: 12 } }, ctx));
  assert.ok(cr.evaluate({ 'metadata.seats': { $lt: 20 } }, ctx));
  assert.ok(cr.evaluate({ 'metadata.seats': { $lte: 12 } }, ctx));
  assert.ok(cr.evaluate({ 'metadata.plan': { $in: ['paid', 'trial'] } }, ctx));
  assert.ok(!cr.evaluate({ 'metadata.plan': { $nin: ['paid', 'trial'] } }, ctx));
  assert.ok(cr.evaluate({ 'params.model': { $regex: '^gpt' } }, ctx));
  assert.ok(!cr.evaluate({ 'params.model': { $regex: '^claude' } }, ctx));
});

test('evaluate: 裸值简写等价于 $eq', () => {
  const ctx = { metadata: { plan: 'paid' } };
  assert.ok(cr.evaluate({ 'metadata.plan': 'paid' }, ctx));
  assert.ok(!cr.evaluate({ 'metadata.plan': 'free' }, ctx));
});

test('evaluate: $and / $or 组合', () => {
  const ctx = { metadata: { plan: 'paid', seats: 12 } };
  assert.ok(cr.evaluate({ $and: [{ 'metadata.plan': { $eq: 'paid' } }, { 'metadata.seats': { $gte: 10 } }] }, ctx));
  assert.ok(!cr.evaluate({ $and: [{ 'metadata.plan': { $eq: 'paid' } }, { 'metadata.seats': { $gte: 99 } }] }, ctx));
  assert.ok(cr.evaluate({ $or: [{ 'metadata.plan': { $eq: 'free' } }, { 'metadata.seats': { $gte: 10 } }] }, ctx));
  assert.ok(!cr.evaluate({ $or: [{ 'metadata.plan': { $eq: 'free' } }] }, ctx));
  // 空 $or 不命中（而不是「 vacuously true 」）
  assert.ok(!cr.evaluate({ $or: [] }, ctx));
});

test('evaluate: 不认识的算子与坏正则都按不命中，绝不抛', () => {
  const ctx = { metadata: { plan: 'paid' } };
  assert.ok(!cr.evaluate({ 'metadata.plan': { $wildcard: 'x' } }, ctx));
  assert.ok(!cr.evaluate({ 'metadata.plan': { $regex: '([unclosed' } }, ctx));
  assert.ok(!cr.evaluate(null, ctx));
  assert.ok(!cr.evaluate('nope', ctx));
  assert.ok(!cr.evaluate({}, ctx));
  // 非标量比较不猜：$gt 对 undefined 为假
  assert.ok(!cr.evaluate({ 'metadata.missing': { $gt: 1 } }, ctx));
});

test('matchConditional: 顺序命中即返回；未命中走 default；两者都无返回 null', () => {
  const strategy = {
    conditions: [
      { query: { 'metadata.user_plan': { $eq: 'paid' } }, then: 'anthropic' },
      { query: { 'metadata.user_plan': { $eq: 'free' } }, then: 'openai' },
    ],
    default: 'openai',
  };
  assert.deepStrictEqual(cr.matchConditional(strategy, { metadata: { user_plan: 'paid' } }), { target: 'anthropic', via: 'condition' });
  assert.deepStrictEqual(cr.matchConditional(strategy, { metadata: { user_plan: 'free' } }), { target: 'openai', via: 'condition' });
  assert.deepStrictEqual(cr.matchConditional(strategy, { metadata: { user_plan: 'trial' } }), { target: 'openai', via: 'default' });
  assert.deepStrictEqual(cr.matchConditional({ conditions: [] }, { metadata: {} }), null);
  assert.deepStrictEqual(cr.matchConditional({ conditions: [], default: null }, {}), null);
  assert.deepStrictEqual(cr.matchConditional(null, {}), null);
  assert.deepStrictEqual(cr.matchConditional(undefined, undefined), null);
});

test('prioritize: 命中 target 的候选提到前列，组内相对次序不变', () => {
  const cands = [
    { adapter: 'openai', model: 'a' },
    { adapter: 'anthropic', model: 'b' },
    { adapter: 'openai', model: 'c' },
    { adapter: 'anthropic', model: 'd' },
  ];
  const r = cr.prioritize(cands, { target: 'anthropic', via: 'condition' });
  assert.deepStrictEqual(r.ordered.map((x) => x.model), ['b', 'd', 'a', 'c']);
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.matchedCount, 2);
  assert.strictEqual(r.target, 'anthropic');
  assert.strictEqual(r.via, 'condition');
});

test('prioritize: 无命中时原样返回同一数组引用（这是「默认路径逐字节不变」的根）', () => {
  const cands = [{ adapter: 'openai', model: 'a' }];
  const r = cr.prioritize(cands, null);
  assert.strictEqual(r.ordered, cands, '必须返回同一引用，而不是一个拷贝');
  assert.strictEqual(r.applied, false);
  assert.strictEqual(r.target, null);
});

test('prioritize: target 在池里没有候选时 applied=false，但不掏空池子', () => {
  const cands = [{ adapter: 'openai', model: 'a' }, { adapter: 'openai', model: 'b' }];
  const r = cr.prioritize(cands, { target: 'anthropic', via: 'default' });
  assert.strictEqual(r.applied, false);
  assert.strictEqual(r.matchedCount, 0);
  assert.strictEqual(r.ordered.length, 2, '硬过滤会在这里把池子掏空——提升语义不会');
});

// ── 2. rank 接入点：可选轴的默认路径必须逐字节不变 ────────────────────────

function multiGw() {
  return {
    _adapters: [
      { key: 'openai', enabled: true, available: true },
      { key: 'anthropic', enabled: true, available: true },
    ],
    listModels: async function (key) {
      if (key === 'openai') return [{ model: 'rank-probe-a' }];
      return [{ model: 'zzz-sonnet-4' }];
    },
  };
}

test('rank: 不给 opts.conditional 时 conditional 读数为 null（不是空对象）', async () => {
  const gw = multiGw();
  await amr.refreshPool(gw, RANK_ENV);
  const r = amr.rank(gw, 'conversation', {}, RANK_ENV);
  assert.ok(r, 'rank 应返回结果');
  assert.strictEqual(r.conditional, null, '没开条件路由必须报 null，让消费方能区分「没开」与「开了没命中」');
});

test('rank: 不给 opts.conditional 与给一个无命中且无 default 的 conditional，结果逐字节一致', async () => {
  const gw1 = multiGw();
  await amr.refreshPool(gw1, RANK_ENV);
  const base = amr.rank(gw1, 'conversation', {}, RANK_ENV);

  const gw2 = multiGw();
  await amr.refreshPool(gw2, RANK_ENV);
  const withEmpty = amr.rank(
    gw2,
    'conversation',
    { conditional: { conditions: [{ query: { 'metadata.plan': { $eq: 'never-matches' } }, then: 'anthropic' }] } },
    RANK_ENV
  );

  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(withEmpty.ranked)),
    JSON.parse(JSON.stringify(base.ranked)),
    '无命中的条件路由不许改动位次'
  );
  assert.strictEqual(withEmpty.conditional.applied, false);
  assert.strictEqual(withEmpty.winner.adapter, base.winner.adapter);
});

test('rank: 条件命中时 target 的候选被提到前列，且读数可观测', async () => {
  const gw = multiGw();
  await amr.refreshPool(gw, RANK_ENV);
  const r = amr.rank(
    gw,
    'conversation',
    {
      conditional: {
        conditions: [{ query: { 'metadata.plan': { $eq: 'paid' } }, then: 'anthropic' }],
        ctx: { metadata: { plan: 'paid' } },
      },
    },
    RANK_ENV
  );
  assert.ok(r, 'rank 应返回结果');
  assert.strictEqual(r.conditional.applied, true, 'anthropic 在池里，理应命中');
  assert.strictEqual(r.conditional.target, 'anthropic');
  assert.strictEqual(r.conditional.via, 'condition');
  assert.ok(r.conditional.matchedCount >= 1);
  assert.strictEqual(r.ranked[0].adapter, 'anthropic', '命中的 target 必须出现在首位');
});

test('rank: 条件未命中走 default，且 default 指向不存在的 adapter 时不掏空池子', async () => {
  const gw = multiGw();
  await amr.refreshPool(gw, RANK_ENV);
  const r = amr.rank(
    gw,
    'conversation',
    { conditional: { conditions: [], default: 'no-such-adapter', ctx: {} } },
    RANK_ENV
  );
  assert.ok(r, 'rank 应返回结果');
  assert.strictEqual(r.conditional.applied, false);
  assert.strictEqual(r.conditional.via, 'default');
  assert.ok(r.ranked.length > 0, '池子不许被掏空');
  assert.ok(r.winner, 'winner 必须还在');
});

test('rank: conditional 不是对象时按没给处理（不抛、不改位次）', async () => {
  const gw = multiGw();
  await amr.refreshPool(gw, RANK_ENV);
  const base = amr.rank(gw, 'conversation', {}, RANK_ENV);
  const weird = amr.rank(gw, 'conversation', { conditional: 'nope' }, RANK_ENV);
  assert.strictEqual(weird.conditional, null);
  assert.strictEqual(weird.winner.adapter, base.winner.adapter);
});
