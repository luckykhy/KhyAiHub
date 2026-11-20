'use strict';

/**
 * hiaoBridgePolicy.test.js — co-located suite for the hiao bridge policy leaf.
 *
 * IO: none at all. Everything here is a pure function of its inputs, which is
 * the point: the risk contract (what needs confirmation, what counts as a
 * refusal) must be assertable with no phone, no adb, no socket.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const policy = require('./hiaoBridgePolicy');

test('只读白名单里的三个工具不需要确认', () => {
  for (const name of ['info', 'status', 'agent_status']) {
    const out = policy.classifyHiaoCall(name);
    assert.equal(out.ok, true);
    assert.equal(out.tier, 'read');
    assert.equal(out.requiresConfirm, false);
  }
});

test('已知写工具按写操作分档并要求确认', () => {
  for (const name of ['exec', 'ui_tap', 'clipboard', 'agent_task']) {
    const out = policy.classifyHiaoCall(name);
    assert.equal(out.ok, true);
    assert.equal(out.tier, 'write');
    assert.equal(out.requiresConfirm, true);
  }
});

test('没见过的工具名一律按写操作走确认（fail-closed）', () => {
  const out = policy.classifyHiaoCall('some_tool_added_in_hiao_3_0');
  assert.equal(out.ok, true);
  assert.equal(out.requiresConfirm, true);
  assert.equal(out.known, false);
});

test('缺 tool 时给下一步（先用 tools 查表），不是一句泛泛的报错', () => {
  for (const empty of [undefined, null, '', '   ', 42]) {
    const out = policy.classifyHiaoCall(empty);
    assert.equal(out.ok, false);
    assert.equal(out.code, 'invalid_tool');
    assert.match(out.error, /tools/);
  }
});

test('只读调用没有计划：requiresConfirm=false', () => {
  const plan = policy.planHiaoCall({ tool: 'status', args: {}, baseUrl: 'http://127.0.0.1:18998' });
  assert.equal(plan.success, true);
  assert.equal(plan.requiresConfirm, false);
});

test('写调用不带 confirm 只回计划，文案写明 600s 审批截止与 confirm:true', () => {
  const plan = policy.planHiaoCall({
    tool: 'exec',
    args: { cmd: 'id' },
    baseUrl: 'http://127.0.0.1:18998',
  });
  assert.equal(plan.success, true);
  assert.equal(plan.requiresConfirm, true);
  assert.equal(plan.code, 'requires_confirm');
  assert.equal(plan.plan.tool, 'exec');
  assert.deepEqual(plan.plan.args, { cmd: 'id' });
  assert.equal(plan.plan.endpoint, 'http://127.0.0.1:18998/call');
  assert.match(plan.message, /600s/);
  assert.match(plan.message, /confirm:true/);
  // 计划本身不携带任何「已发送」的说法：这条路径一个字节都还没发。
  assert.equal(plan.sent, undefined);
});

test('失败码集合是封闭的六种，没有第七种', () => {
  assert.deepEqual(Object.keys(policy.HIAO_FAILURE_MESSAGES).sort(), [
    'approval_timeout', 'device_fault', 'hiao_deny', 'lease_missing', 'unauthorized', 'unreachable',
  ]);
});

test('审批超时、GET 超时与设备故障是三个 code，文案不互借', () => {
  const timeout = policy.classifyHiaoFailure({ aborted: true, approvalWait: true });
  const getTimeout = policy.classifyHiaoFailure({ aborted: true });
  const fault = policy.classifyHiaoFailure({ status: 500 });
  assert.equal(timeout.code, 'approval_timeout');
  // 只有阻塞等审批的 /call 才允许报审批超时；GET 面的截止就是链路不可达。
  assert.equal(getTimeout.code, 'unreachable');
  assert.equal(fault.code, 'device_fault');
  // 审批超时的文案只说「没人放行」这件治理事实，不能出现设备故障的措辞。
  assert.match(timeout.error, /放行/);
  assert.match(timeout.error, /600s/);
  assert.doesNotMatch(timeout.error, /设备侧故障|device_fault/);
  // GET 超时不许冒充审批治理。
  assert.doesNotMatch(getTimeout.error, /600s|放行/);
  // 设备故障的文案不能把审批/租约当成解释。
  assert.match(fault.error, /设备侧故障/);
  assert.doesNotMatch(fault.error, /审批|放行|600s|approval/);
});

test('手机端自报的 approval timeout 归 approval_timeout，不因非 2xx 落到设备故障', () => {
  const out = policy.classifyHiaoFailure({
    status: 504,
    bodyText: '{"ok":false,"error":"approval timeout waiting for human decision"}',
  });
  assert.equal(out.code, 'approval_timeout');
});

test('审批超时的三种拼写都归 approval_timeout：空格、下划线（机器码）、中文', () => {
  // hiao 自己的机器码是 approval_timeout（下划线），文案可能是中文「审批超时」。
  // 词边界修复曾把这两种拼到 device_fault / hiao_deny——治理拒绝报成设备故障，
  // 正是本单元要消灭的归因错误，所以三种形态都要钉住。
  for (const bodyText of [
    '{"ok":false,"code":"approval_timeout"}',
    '{"error":"approval_timeout"}',
    '{"error":"审批超时，已拒绝"}',
    '{"ok":false,"error":"approval timeout waiting for human decision"}',
  ]) {
    assert.equal(policy.classifyHiaoFailure({ bodyText }).code, 'approval_timeout', bodyText);
    assert.equal(
      policy.classifyHiaoFailure({ status: 504, bodyText }).code,
      'approval_timeout',
      bodyText
    );
  }
  // 提到审批但没有超时语义的，不算审批超时（归 deny/后续分支）。
  assert.notEqual(policy.classifyHiaoFailure({ bodyText: '{"error":"approval denied by policy"}' }).code, 'approval_timeout');
});

test('租约探测同样认中文与下划线形', () => {
  for (const bodyText of [
    '{"error":"lease_missing"}',
    '{"error":"缺少有效租约"}',
  ]) {
    assert.equal(policy.classifyHiaoFailure({ bodyText }).code, 'lease_missing', bodyText);
  }
});

test('缺租约、verdict deny、401/403、不可达各自归位', () => {
  assert.equal(policy.classifyHiaoFailure({ bodyText: '{"error":"no valid lease"}' }).code, 'lease_missing');
  assert.equal(policy.classifyHiaoFailure({ bodyText: '{"ok":false,"verdict":"deny"}' }).code, 'hiao_deny');
  assert.equal(policy.classifyHiaoFailure({ status: 401 }).code, 'unauthorized');
  assert.equal(policy.classifyHiaoFailure({ status: 403 }).code, 'unauthorized');
  assert.equal(policy.classifyHiaoFailure({ status: 0, error: 'ECONNREFUSED' }).code, 'unreachable');
  assert.equal(policy.classifyHiaoFailure({ source: 'adb', error: 'more than one device' }).code, 'device_fault');
});

test('hiao_deny 的文案不写成设备故障', () => {
  const out = policy.classifyHiaoFailure({ bodyText: '{"verdict":"deny"}' });
  assert.equal(out.code, 'hiao_deny');
  assert.match(out.error, /拒绝/);
  assert.doesNotMatch(out.error, /设备侧故障|device_fault/);
});

test('未知 HTTP 4xx 归设备侧故障并带上状态码，不静默吞掉', () => {
  const out = policy.classifyHiaoFailure({ status: 404 });
  assert.equal(out.code, 'device_fault');
  assert.match(out.error, /404/);
});

test('lease 匹配带词边界：please / released 一类词不冒充缺租约', () => {
  for (const text of [
    'server busy, please retry later',
    'device released',
    '{"error":"internal error while releasing resources"}',
  ]) {
    const out = policy.classifyHiaoFailure({ status: 500, bodyText: text });
    assert.equal(out.code, 'device_fault', text);
    assert.notEqual(out.code, 'lease_missing');
  }
  // 真的报租约时仍然归位（lease / leases / lease_missing 都算）。
  for (const text of [
    '{"error":"no valid lease"}',
    '{"error":"lease missing for capability exec"}',
    '{"error":"requires an active lease"}',
  ]) {
    assert.equal(policy.classifyHiaoFailure({ bodyText: text }).code, 'lease_missing', text);
  }
});
