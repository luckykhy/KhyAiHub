'use strict';

// Colocated tests for autonomyInspectPlan.js (pure leaf: zero IO, never throws).

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('./autonomyInspectPlan');

test('parseAutonomyArgs：空参/垃圾入参 → status 默认值，绝不抛', () => {
  for (const args of [undefined, null, [], 'status', 42, {}]) {
    const r = svc.parseAutonomyArgs(args);
    assert.equal(r.action, 'status');
    assert.equal(r.deep, false);
    assert.equal(r.limit, svc._DEFAULT_LIMIT);
    assert.equal(r.valid, true);
    assert.equal(r.parseError, null);
  }
});

test('parseAutonomyArgs：help 变体与 status --deep 变体', () => {
  assert.equal(svc.parseAutonomyArgs(['help']).action, 'help');
  assert.equal(svc.parseAutonomyArgs(['-h']).action, 'help');
  assert.equal(svc.parseAutonomyArgs(['--HELP']).action, 'help');
  assert.equal(svc.parseAutonomyArgs(['status']).deep, false);
  assert.equal(svc.parseAutonomyArgs(['status', '--deep']).deep, true);
  assert.equal(svc.parseAutonomyArgs(['STATUS', '-d']).deep, true);
  assert.equal(svc.parseAutonomyArgs(['status', 'x', 'deep']).deep, true);
  assert.equal(svc.parseAutonomyArgs(['status', '--deepx']).deep, false);
});

test('parseAutonomyArgs：runs/flows 的 limit 解析（垃圾回退默认、上限 200）', () => {
  assert.equal(svc.parseAutonomyArgs(['runs', '5']).limit, 5);
  assert.equal(svc.parseAutonomyArgs(['flows', '0']).limit, svc._DEFAULT_LIMIT); // n<=0 → 默认
  assert.equal(svc.parseAutonomyArgs(['runs', 'abc']).limit, svc._DEFAULT_LIMIT);
  assert.equal(svc.parseAutonomyArgs(['runs', '999999']).limit, svc._MAX_LIMIT);
  assert.equal(svc.parseAutonomyArgs(['runs', null]).limit, svc._DEFAULT_LIMIT);
  assert.equal(svc.parseAutonomyArgs(['runs', {}]).limit, svc._DEFAULT_LIMIT); // '[object Object]'
  assert.equal(svc.parseAutonomyArgs(['runs', [1]]).limit, 1); // String([1])='1'
});

test('parseAutonomyArgs：flow 子语法与缺 id 报错', () => {
  assert.deepEqual(
    { ...svc.parseAutonomyArgs(['flow', 'f-1']), flowId: 'f-1' },
    { action: 'flow-view', deep: false, limit: 10, flowId: 'f-1', valid: true, parseError: null }
  );
  assert.equal(svc.parseAutonomyArgs(['flow', 'cancel', 'f-1']).action, 'flow-cancel');
  assert.equal(svc.parseAutonomyArgs(['flow', 'resume', 'f-1']).action, 'flow-resume');
  assert.equal(svc.parseAutonomyArgs(['flow']).valid, false);
  assert.equal(svc.parseAutonomyArgs(['flow']).parseError, 'missing_flow_id');
  assert.equal(svc.parseAutonomyArgs(['flow', 'cancel']).valid, false);
  assert.equal(svc.parseAutonomyArgs(['flow', 'bogus', 'x']).action, 'flow-view');
});

test('parseAutonomyArgs：未知动作与元素清洗', () => {
  const bad = svc.parseAutonomyArgs(['bogus']);
  assert.equal(bad.valid, false);
  assert.equal(bad.parseError, 'unknown_action');
  // 元素 String 化 + trim + 过滤空串
  assert.equal(svc.parseAutonomyArgs([' status ']).action, 'status');
  assert.equal(svc.parseAutonomyArgs([null, '', 'runs', '2']).action, 'runs');
  assert.equal(svc.parseAutonomyArgs([0]).valid, false); // String(0)='0' → 未知动作
});

test('tallyRuns 按 control 分桶，垃圾项跳过，未知 control 入 idle', () => {
  const t = svc.tallyRuns([
    { control: 'running' },
    { control: 'PAUSED' },
    { control: 'done' },
    { control: 'failed' },
    { control: 'cancelled' },
    { control: 'whatever' },
    null,
    42,
    {},
  ]);
  assert.equal(t.total, 7);
  assert.equal(t.running, 1);
  assert.equal(t.paused, 1);
  assert.equal(t.done, 1);
  assert.equal(t.failed, 1);
  assert.equal(t.cancelled, 1);
  assert.equal(t.idle, 2); // whatever + {}
});

test('tallyRuns 垃圾入参返全零', () => {
  assert.equal(svc.tallyRuns(null).total, 0);
  assert.equal(svc.tallyRuns('x').total, 0);
  // 非对象元素（undefined/数字）整体跳过，不进任何桶
  assert.equal(svc.tallyRuns([undefined]).total, 0);
  assert.equal(svc.tallyRuns([undefined]).idle, 0);
});

// KNOWN-DEFECT: tallyTasks 用 task.status 直接作对象键（autonomyInspectPlan.js:157-158），
// status='__proto__' 时成员读取/赋值命中原型槽位——计数不抛但桶丢失；status='constructor'
// 会把原型函数 +1 得到垃圾串并以自有属性覆写回对象。两者都只损一行分桶数字（低危：纯渲染叶子）。
test("KNOWN-DEFECT: status='__proto__'/'constructor' 污染分桶键", () => {
  const t1 = svc.tallyTasks([{ status: '__proto__' }]);
  assert.equal(t1.total, 1);
  // 计数丢失：'__proto__' 未成为自有键（读/写都落在原型槽位上）
  assert.deepEqual(Object.getOwnPropertyNames(t1), ['total']);
  const t2 = svc.tallyTasks([{ status: 'constructor' }]);
  assert.equal(t2.total, 1);
  assert.equal(typeof t2.constructor, 'string'); // 变成垃圾串而非数字
  assert.notEqual(t2.constructor, 1);
});

test('tallyTasks 正常分桶 + 空串 status 归 unknown', () => {
  // 对象元素计数；null 与字符串元素整体跳过
  const t = svc.tallyTasks([{ status: 'open' }, { status: 'OPEN' }, {}, null, 'x']);
  assert.equal(t.total, 3);
  assert.equal(t.open, 2);
  assert.equal(t.unknown, 1);
  assert.equal(svc.tallyTasks(null).total, 0);
});

test('buildOverview：满快照渲染各自治面', () => {
  const out = svc.buildOverview({
    permissionMode: 'auto',
    enabled: true,
    runs: [{ runId: 'r1', control: 'running', progress: { done: 2, total: 5 }, mode: 'auto', label: 'L' }],
    tasks: [{ status: 'open' }],
    cronJobs: [{ id: 'c1', enabled: true, cron: '* * * * *', lastRunAt: 't' }],
    proactiveActive: true,
    remotedev: { state: 'live' },
  });
  assert.ok(out.includes('自治活动总览'));
  assert.ok(out.includes('权限模式: auto'));
  assert.ok(out.includes('编排运行: 共 1'));
  assert.ok(out.includes('最新:r1'));
  assert.ok(out.includes('任务板: 共 1'));
  assert.ok(out.includes('计划任务(cron): 共 1（启用 1）'));
  assert.ok(out.includes('Proactive idle-tick: 活跃'));
  assert.ok(out.includes('远端会话: 存活'));
});

test('buildOverview：null/缺面快照全部降级「不可用」，绝不抛', () => {
  const out = svc.buildOverview(null);
  assert.ok(out.includes('权限模式: (未知)'));
  assert.ok(out.includes('编排运行: 不可用'));
  assert.ok(out.includes('任务板: 不可用'));
  assert.ok(out.includes('计划任务(cron): 不可用'));
  assert.ok(out.includes('Proactive idle-tick: 不可用'));
  assert.ok(out.includes('远端会话: 无'));
  // enabled=false 提示
  assert.ok(svc.buildOverview({ runs: [], enabled: false }).includes('KHY_ORCHESTRATE=0'));
  // remotedev 未知 state 原样透出
  assert.ok(svc.buildOverview({ remotedev: { state: 'weird' } }).includes('weird'));
});

test('buildDeep：概览 + 三段明细', () => {
  const out = svc.buildDeep({
    permissionMode: 'ask',
    runs: [{ runId: 'r1', control: 'done' }],
    cronJobs: [{ id: 'c1', enabled: false, cron: 'daily', lastRunAt: 'yesterday' }],
  });
  assert.ok(out.includes('编排运行明细'));
  assert.ok(out.includes('r1'));
  assert.ok(out.includes('计划任务(cron)明细'));
  assert.ok(out.includes('[禁用]'));
  assert.ok(out.includes('最近运行 yesterday'));
  assert.ok(out.includes('权限模式'));
  assert.ok(svc.buildDeep({}).includes('（无）'));
});

test('buildRunsList / buildFlowsList：limit、空与垃圾入参', () => {
  assert.equal(svc.buildRunsList(null), '编排运行: （无）');
  assert.equal(svc.buildFlowsList([]), '受管 flow: （无）');
  const runs = [1, 2, 3].map((i) => ({ runId: 'r' + i, control: 'done' }));
  const out = svc.buildRunsList(runs, 2);
  assert.ok(out.includes('最多 2 条'));
  assert.ok(out.includes('r3'));
  assert.ok(!out.includes('r1')); // 只取最后 2 条
  // limit 垃圾 → 默认 10
  assert.ok(svc.buildRunsList(runs, 'abc').includes('最多 10 条'));
});

test('buildFlowView：null → 未找到；正常渲染 mode/control/进度/步骤', () => {
  assert.equal(svc.buildFlowView(null), 'flow 未找到。');
  assert.equal(svc.buildFlowView('x'), 'flow 未找到。');
  const out = svc.buildFlowView({
    runId: 'f9',
    mode: 'auto',
    control: 'running',
    progress: { done: 1, total: 3, failed: 1 },
    label: '目标',
    steps: [
      { stepId: 's1', status: 'ok', role: 'boss', result: 'fine' },
      { stepId: 's2', status: 'err', error: 'boom' },
    ],
  });
  assert.ok(out.includes('Flow f9'));
  assert.ok(out.includes('mode=auto'));
  assert.ok(out.includes('1/3 done'));
  assert.ok(out.includes('1 failed'));
  assert.ok(out.includes('目标: 目标'));
  assert.ok(out.includes('s1 [ok] boss fine'));
  assert.ok(out.includes('s2 [err]  ✗ boom'));
});

test('isEnabled：KHY_AUTONOMY 默认开，仅 falsy/off 值关', () => {
  assert.equal(svc.isEnabled(), true);
  assert.equal(svc.isEnabled({}), true);
  assert.equal(svc.isEnabled(null), true);
  for (const v of ['0', 'false', 'off', 'no', '']) {
    assert.equal(svc.isEnabled({ KHY_AUTONOMY: v }), false, v);
  }
  assert.equal(svc.isEnabled({ KHY_AUTONOMY: '1' }), true);
  assert.equal(svc.isEnabled({ KHY_AUTONOMY: null }), false); // null → String('') → off
  assert.equal(svc.isEnabled({ KHY_AUTONOMY: 0 }), false);
  assert.equal(svc.isEnabled({ KHY_AUTONOMY: 'YES' }), true);
});
