'use strict';

/**
 * routeBanditDisclosure.test.js — 块 B2：UCB 选路的样本量披露。
 *
 * 覆盖三件事：
 *   ① 无 bandit 时 routeFact 字段面与 notice 文案逐字不变（KHY_UCB_ROUTING 默认关）；
 *   ② 有 bandit 时 notice 必须说出「样本 N · 均值 X · 进程内统计，重启清零」；
 *   ③ 选路读数走 ranking 数组的不可枚举旁路属性，不写进共享 assessment，
 *      也不出现在 JSON / Object.keys 里；buildRouteFact 的不变式仍然成立。
 *
 * 走 node:test（与 routeFact.cascade.test.js 同方言）；jest 按 require('node:test') 忽略本文件。
 */

const test = require('node:test');
const assert = require('node:assert');

const rf = require('../../src/services/gateway/routeFact');
const ucb = require('../../src/services/gateway/ucbRouter');
const { AIGatewayRoutingMethods, UCB_PICK_KEY } = require('../../src/services/gateway/aiGatewayRoutingMethods');

const ENV = { GATEWAY_PREFERRED_ADAPTER: 'beta' };

/** 失败→切换成功的标准现场（与 routeFact.cascade.test.js 的 R-01 同形）。 */
function switchedResult() {
  return {
    success: true,
    actualAdapter: 'alpha',
    model: 'm',
    attempts: [
      { adapter: 'beta', success: false, errorType: 'network' },
      { adapter: 'alpha', success: true },
    ],
  };
}

test('B2-01 无 bandit → routeFact 不出现该字段，notice 与旧输出逐字一致', () => {
  const fact = rf.buildRouteFact(switchedResult(), { env: ENV, at: 1 });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(fact, 'bandit'), false);
  assert.ok(!JSON.stringify(fact).includes('"bandit"'));
  assert.strictEqual(rf.formatBanditNotice(fact), '');
  assert.strictEqual(
    rf.formatCascadeNotice(fact),
    '⚑ 本次由 alpha 完成（首选 beta 因网络异常，已自动兜底）。如需固定通道：khy provider use',
  );
  assert.deepStrictEqual(rf._assertCoherent(fact), []);
});

test('B2-02 有 bandit → routeFact 附加 { adapter, pulls, mean, scope } 且不变式成立', () => {
  const fact = rf.buildRouteFact(switchedResult(), {
    env: ENV,
    at: 1,
    bandit: { adapter: 'alpha', pulls: 12, mean: 0.75 },
  });
  assert.deepStrictEqual(fact.bandit, {
    adapter: 'alpha',
    pulls: 12,
    mean: 0.75,
    scope: 'in-process',
  });
  assert.deepStrictEqual(rf._assertCoherent(fact), []);
  assert.ok(JSON.stringify(fact).includes('"scope":"in-process"'), 'JSON 契约只增字段');
});

test('B2-03 有 bandit → notice 带样本量、均值与「重启清零」，且满足动作+目标+进度', () => {
  const fact = rf.buildRouteFact(switchedResult(), {
    env: ENV,
    at: 1,
    bandit: { adapter: 'alpha', pulls: 12, mean: 0.7512 },
  });
  const line = rf.formatBanditNotice(fact);
  assert.ok(line.includes('选路 alpha'), line);
  assert.ok(line.includes('样本 12'), line);
  assert.ok(line.includes('均值 0.751'), line);
  assert.ok(line.includes('进程内统计，重启清零'), line);
  assert.ok(/^⚑ 选路 .+：样本 \d+ · 均值 [\d.]+ · 进程内统计，重启清零$/u.test(line), line);
});

test('B2-04 样本为 0 → 不把「均值 0」伪装成知识', () => {
  const fact = rf.buildRouteFact(switchedResult(), {
    env: ENV,
    at: 1,
    bandit: { adapter: 'alpha', pulls: 0, mean: 0 },
  });
  const line = rf.formatBanditNotice(fact);
  assert.ok(line.includes('样本 0'), line);
  assert.ok(line.includes('未观测'), line);
  assert.ok(line.includes('重启清零'), line);
  assert.strictEqual(rf.formatBanditNotice(fact, { displayName: (k) => `通道:${k}` }).includes('通道:alpha'), true);
});

test('B2-05 畸形 bandit 被忽略（绝不抛、绝不让诊断字段变故障源）', () => {
  for (const bandit of [null, 'x', 42, {}, { adapter: '' }, { adapter: 'a', pulls: -1 }, { adapter: 'a', pulls: 1, mean: NaN }]) {
    const fact = rf.buildRouteFact(switchedResult(), { env: ENV, at: 1, bandit });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(fact, 'bandit'), false, String(bandit));
    assert.deepStrictEqual(rf._assertCoherent(fact), []);
  }
  assert.strictEqual(rf.formatBanditNotice({ bandit: 'x' }), '');
});

test('B2-06 不变式：bandit.scope 非 in-process / pulls 为负 → 报违规', () => {
  const base = { outcome: 'ok', served: { adapter: 'a' }, strictPinned: false, pinnedUnavailable: false };
  const badScope = rf._assertCoherent({ ...base, bandit: { adapter: 'a', pulls: 1, mean: 0.5, scope: 'disk' } });
  assert.ok(badScope.some((p) => p.includes('in-process')), badScope.join(' | '));
  const badPulls = rf._assertCoherent({ ...base, bandit: { adapter: 'a', pulls: -3, mean: 0.5, scope: 'in-process' } });
  assert.ok(badPulls.some((p) => p.includes('pulls')), badPulls.join(' | '));
});

test('B2-07 _applyUcbRouting：读数挂在不可枚举旁路属性，assessment 原样不动', () => {
  const saved = {
    ucb: process.env.KHY_UCB_ROUTING,
    order: process.env.GATEWAY_FAILOVER_ORDER,
  };
  process.env.KHY_UCB_ROUTING = 'true';
  process.env.GATEWAY_FAILOVER_ORDER = 'zzz-unrelated'; // 避开本机文件配置，且不落进候选集
  ucb._reset();
  try {
    ucb.recordOutcome('alpha', { success: true, latencyMs: 1000 });
    ucb.recordOutcome('alpha', { success: true, latencyMs: 1000 });
    ucb.recordOutcome('beta', { success: false });

    const gw = Object.create(AIGatewayRoutingMethods);
    gw._getRecentFastFail = () => null;
    const eligible = [{ adapter: 'beta', score: 1 }, { adapter: 'alpha', score: 2 }];
    const snapshot = JSON.stringify(eligible);

    const ranked = gw._applyUcbRouting(eligible);
    assert.deepStrictEqual(ranked.map((i) => i.adapter), ['alpha', 'beta']);
    assert.strictEqual(JSON.stringify(eligible), snapshot, '不得写回共享 assessment');

    const pick = ranked[UCB_PICK_KEY];
    assert.deepStrictEqual(
      { adapter: pick.adapter, pulls: pick.pulls, mean: pick.mean, scope: pick.scope },
      { adapter: 'alpha', pulls: 2, mean: 1, scope: 'in-process' },
    );
    assert.strictEqual(Object.getOwnPropertyDescriptor(ranked, UCB_PICK_KEY).enumerable, false);
    assert.deepStrictEqual(Object.keys(ranked), ['0', '1']);
    assert.ok(!JSON.stringify(ranked).includes(UCB_PICK_KEY), '旁路读数不得进 JSON');

    // 端到端契约：把读数交给 buildRouteFact，notice 立刻说出样本量
    const fact = rf.buildRouteFact(switchedResult(), { env: ENV, at: 1, bandit: pick });
    assert.ok(rf.formatBanditNotice(fact).includes('样本 2'));
  } finally {
    if (saved.ucb === undefined) delete process.env.KHY_UCB_ROUTING;
    else process.env.KHY_UCB_ROUTING = saved.ucb;
    if (saved.order === undefined) delete process.env.GATEWAY_FAILOVER_ORDER;
    else process.env.GATEWAY_FAILOVER_ORDER = saved.order;
    ucb._reset();
  }
});

test('B2-08 KHY_UCB_ROUTING 关闭 → 原数组原样返回且无读数（默认路径零变化）', () => {
  const saved = process.env.KHY_UCB_ROUTING;
  delete process.env.KHY_UCB_ROUTING;
  try {
    const gw = Object.create(AIGatewayRoutingMethods);
    const eligible = [{ adapter: 'a' }, { adapter: 'b' }];
    assert.strictEqual(gw._applyUcbRouting(eligible), eligible);
    assert.strictEqual(eligible[UCB_PICK_KEY], undefined);
  } finally {
    if (saved !== undefined) process.env.KHY_UCB_ROUTING = saved;
  }
});

test('B2-09 _orderAdaptersByDefaultRoutePreference：读数随排序结果继续传递', () => {
  const gw = Object.create(AIGatewayRoutingMethods);
  const ranking = [{ adapter: 'alpha' }, { adapter: 'beta' }];
  Object.defineProperty(ranking, UCB_PICK_KEY, {
    value: { adapter: 'alpha', pulls: 7, mean: 0.9, scope: 'in-process' },
    enumerable: false,
    configurable: true,
  });
  gw._rankAdaptersForDefaultRoute = () => ({ ranking, assessments: [] });
  gw._getFailoverOrderMap = () => null;

  const out = gw._orderAdaptersByDefaultRoutePreference([{ key: 'beta' }, { key: 'alpha' }], {});
  assert.deepStrictEqual(out.map((e) => e.key), ['alpha', 'beta']);
  assert.strictEqual(out[UCB_PICK_KEY].pulls, 7);
  assert.strictEqual(out[UCB_PICK_KEY].scope, 'in-process');
  assert.deepStrictEqual(Object.keys(out), ['0', '1'], '旁路读数仍不可枚举');
});
