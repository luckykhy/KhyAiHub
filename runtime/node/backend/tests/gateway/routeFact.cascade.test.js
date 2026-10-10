'use strict';

/**
 * routeFact.cascade.test.js — [DESIGN-ARCH-181] 一期 D3-1/D3-2 的验收用例。
 *
 * 覆盖 routeFact 在 2026-10-04 追加的披露字段（cascade / switchedFrom / switchReason /
 * environmental）与 `formatCascadeNotice` 文案函数，外加两条新不变式：
 *   - environmental===true → cascade 中**远端**条目 decision 全为 skip/failed；
 *   - outcome==='ok' && cascade.length>0 → switchedFrom 非空。
 *
 * 既有 jest 套件（tests/gateway/routeFact.test.js，裸 describe）仍负责原始字段语义；
 * 本文件按影子跑纪律**不追加进它**，走 node:test（jest.config.js 按 `require('node:test')`
 * 标记自动忽略本文件；test:node 全量 glob 会跑它 ⇒ 落地即须绿）。
 */

const test = require('node:test');
const assert = require('node:assert');

const rf = require('../../src/services/gateway/routeFact');

const ENV = { GATEWAY_PREFERRED_ADAPTER: 'auto' };

/** 失败尝试记录（形状与 aiGateway 的 allAttempts 一致）。 */
const fail = (adapter, errorType, error = '') => ({ adapter, success: false, errorType, error });

test('R-01 失败后切换成功 → cascade 两跳 + switchedFrom/switchReason 可归因', () => {
  const fact = rf.buildRouteFact(
    {
      success: true,
      actualAdapter: 'relay_api',
      model: 'm',
      attempts: [fail('api', 'server_error', '502 bad gateway'), { adapter: 'relay_api', success: true }],
    },
    { env: ENV },
  );
  assert.strictEqual(fact.cascade.length, 2);
  assert.deepStrictEqual(fact.cascade[0], { adapter: 'api', errorType: 'server_error', cause: '', decision: 'failed' });
  assert.deepStrictEqual(fact.cascade[1], { adapter: 'relay_api', errorType: '', cause: '', decision: 'fallback' });
  assert.strictEqual(fact.switchedFrom, 'api');
  assert.strictEqual(fact.switchReason, 'server_error');
  assert.strictEqual(fact.environmental, false);
  assert.deepStrictEqual(rf._assertCoherent(fact), []);
});

test('R-02 首跳即成功 → 无切换,cascade 为空且不变式自洽', () => {
  const fact = rf.buildRouteFact(
    { success: true, actualAdapter: 'api', model: 'm', attempts: [{ adapter: 'api', success: true }] },
    { env: ENV },
  );
  assert.deepStrictEqual(fact.cascade, []);
  assert.strictEqual(fact.switchedFrom, '');
  assert.strictEqual(fact.switchReason, '');
  assert.deepStrictEqual(rf._assertCoherent(fact), []);
});

test('R-03 全远端失败(两不同通道 network) → environmental 透出,无 switchedFrom', () => {
  const fact = rf.buildRouteFact(
    {
      success: false,
      actualAdapter: 'api',
      errorType: 'network',
      attempts: [fail('api', 'network', 'ECONNRESET'), fail('relay_api', 'network', 'ECONNRESET')],
    },
    { env: ENV },
  );
  assert.strictEqual(fact.outcome, 'failed');
  assert.strictEqual(fact.environmental, true);
  assert.strictEqual(fact.cascade.length, 2);
  assert.strictEqual(fact.switchedFrom, '', '失败路径不产生切换来源');
  assert.deepStrictEqual(rf._assertCoherent(fact), []);
});

test('R-04 环境级但本地通道兜底成功 → environmental 保持 true,本地落点不算违规', () => {
  const fact = rf.buildRouteFact(
    {
      success: true,
      actualAdapter: 'ollama',
      model: 'local',
      attempts: [fail('api', 'network'), fail('relay_api', 'network'), { adapter: 'ollama', success: true }],
    },
    { env: ENV },
  );
  assert.strictEqual(fact.environmental, true);
  assert.strictEqual(fact.switchedFrom, 'api');
  assert.strictEqual(fact.switchReason, 'network');
  assert.deepStrictEqual(rf._assertCoherent(fact), [], '本地 fallback 落点允许');
});

test('R-05 virtualSkip 留痕 → decision=skip 且 cause 标 virtualSkip', () => {
  const fact = rf.buildRouteFact(
    {
      success: true,
      actualAdapter: 'ollama',
      model: 'm',
      attempts: [
        fail('api', 'network'),
        { adapter: 'relay_api', virtualSkip: true, errorType: 'env_outage_skip' },
        { adapter: 'ollama', success: true },
      ],
    },
    { env: ENV },
  );
  assert.deepStrictEqual(fact.cascade[1], {
    adapter: 'relay_api',
    errorType: 'env_outage_skip',
    cause: 'virtualSkip',
    decision: 'skip',
  });
  assert.strictEqual(fact.switchedFrom, 'api', '切换来源取第一条不同条目(不是 skip 那条)');
  assert.deepStrictEqual(rf._assertCoherent(fact), []);
});

test('R-06 attempts 缺失/非数组 → 空链与保守缺省', () => {
  for (const attempts of [undefined, null, 'x', 42, {}, [null, 1, 'y', {}]]) {
    const fact = rf.buildRouteFact({ success: false, attempts }, { env: ENV });
    assert.deepStrictEqual(fact.cascade, [], String(attempts));
    assert.strictEqual(fact.environmental, false);
    assert.strictEqual(fact.switchedFrom, '');
  }
});

test('R-07 attempts 兼容 provider/adapter 字段名,无 key 记录被跳过', () => {
  const fact = rf.buildRouteFact(
    {
      success: false,
      attempts: [
        { provider: 'api', success: false, errorType: 'network' },
        { adapter: 'relay_api', success: false, errorType: 'network' },
        { success: false, errorType: 'network' },
      ],
    },
    { env: ENV },
  );
  assert.deepStrictEqual(
    fact.cascade.map((h) => h.adapter),
    ['api', 'relay_api'],
  );
  assert.strictEqual(fact.environmental, true, '无权重的第三条不参与证据');
});

test('R-08 buildRouteFact 不改动 result.attempts(只读派生)', () => {
  const result = {
    success: true,
    actualAdapter: 'api',
    attempts: [fail('api', 'timeout'), { adapter: 'api', success: true }],
  };
  const snapshot = JSON.stringify(result);
  rf.buildRouteFact(result, { env: ENV });
  assert.strictEqual(JSON.stringify(result), snapshot);
});

test('R-09 createEmptyRouteFact 的 4 个披露字段有保守缺省', () => {
  const fact = rf.createEmptyRouteFact({});
  assert.deepStrictEqual(fact.cascade, []);
  assert.strictEqual(fact.switchedFrom, '');
  assert.strictEqual(fact.switchReason, '');
  assert.strictEqual(fact.environmental, false);
  assert.deepStrictEqual(rf._assertCoherent(fact), []);
});

test('R-10 不变式:environmental=true 且远端 fallback 落点 → 报违规', () => {
  const problems = rf._assertCoherent({
    outcome: 'ok',
    served: { adapter: 'api', model: 'm' },
    strictPinned: false,
    pinnedUnavailable: false,
    environmental: true,
    switchedFrom: 'api',
    cascade: [{ adapter: 'api', errorType: '', cause: '', decision: 'fallback' }],
  });
  assert.ok(problems.some((p) => p.includes('远端') && p.includes('fallback')), problems.join(' | '));
});

test('R-11 不变式:ok + cascade 非空但 switchedFrom 为空 → 报违规', () => {
  const problems = rf._assertCoherent({
    outcome: 'ok',
    served: { adapter: 'api', model: 'm' },
    strictPinned: false,
    pinnedUnavailable: false,
    environmental: false,
    switchedFrom: '',
    cascade: [{ adapter: 'relay_api', errorType: '', cause: '', decision: 'fallback' }],
  });
  assert.ok(problems.some((p) => p.includes('switchedFrom')), problems.join(' | '));
});

test('R-12 _assertCoherent 对畸形 cascade 不抛且不误报', () => {
  for (const cascade of ['x', 42, [null, 1, 'y'], [{}], null]) {
    assert.doesNotThrow(() => rf._assertCoherent({ outcome: 'failed', cascade, environmental: false }));
  }
  assert.deepStrictEqual(
    rf._assertCoherent({ outcome: 'failed', cascade: 'x', environmental: true, switchedFrom: '' }),
    [],
  );
});

test('R-13 formatCascadeNotice:成功+切换 → 完整一行,displayName 注入生效', () => {
  const fact = rf.buildRouteFact(
    { success: true, actualAdapter: 'relay_api', model: 'm', attempts: [fail('api', 'network'), { adapter: 'relay_api', success: true }] },
    { env: ENV },
  );
  const line = rf.formatCascadeNotice(fact, { displayName: (k) => (k === 'api' ? 'API 通道' : k) });
  assert.strictEqual(
    line,
    '⚑ 本次由 relay_api 完成（首选 API 通道 因网络异常，已自动兜底）。如需固定通道：khy provider use',
  );
  assert.ok(rf.formatCascadeNotice(fact).includes('因网络异常'));
});

test('R-14 formatCascadeNotice:失败/未切换/畸形输入 → 空串(调用方免渲染)', () => {
  assert.strictEqual(rf.formatCascadeNotice(null), '');
  assert.strictEqual(rf.formatCascadeNotice({}), '');
  assert.strictEqual(
    rf.formatCascadeNotice({ outcome: 'failed', served: null, switchedFrom: 'api', switchReason: 'network' }),
    '',
  );
  assert.strictEqual(
    rf.formatCascadeNotice({ outcome: 'ok', served: { adapter: 'api' }, switchedFrom: '', switchReason: '' }),
    '',
  );
  assert.strictEqual(
    rf.formatCascadeNotice({ outcome: 'ok', served: { adapter: 'api' }, switchedFrom: 'api' }),
    '',
    'served 与 switchedFrom 相同 → 不是切换',
  );
  assert.strictEqual(
    rf.formatCascadeNotice(
      { outcome: 'ok', served: { adapter: 'api' }, switchedFrom: 'trae', switchReason: 'weird' },
      { displayName: () => { throw new Error('boom'); } },
    ),
    '⚑ 本次由 api 完成（首选 trae 因weird，已自动兜底）。如需固定通道：khy provider use',
    'displayName 抛错 → 回落 key 原文',
  );
});

test('R-15 formatCascadeNotice:reason 中文映射与未知回退', () => {
  const base = { outcome: 'ok', served: { adapter: 'api' }, switchedFrom: 'trae' };
  assert.ok(rf.formatCascadeNotice({ ...base, switchReason: 'timeout' }).includes('因超时'));
  assert.ok(rf.formatCascadeNotice({ ...base, switchReason: 'process' }).includes('因进程异常'));
  assert.ok(rf.formatCascadeNotice({ ...base, switchReason: 'NETWORK' }).includes('因网络异常'), '大小写不敏感');
  assert.ok(rf.formatCascadeNotice({ ...base, switchReason: '' }).includes('因异常'));
});
