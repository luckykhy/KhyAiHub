'use strict';

// Co-located contract tests for proactiveCollaboration/delegationPlanner.js.
//
// LIMITS.MAX_SUBTASKS / MIN_SUBTASKS are env-overridable getters, so the tests read
// them from ./constants and build inputs relative to the live values instead of
// hardcoding 5 / 2 — the suite stays correct under ambient CI env.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { planDelegation, inferRole, _cleanTask } = require('./delegationPlanner');
const { LIMITS, DEFAULT_ROLE } = require('./constants');

function mkTasks(n) {
  return Array.from({ length: n }, (_, i) => ({ task: `任务${i}` }));
}

test('inferRole 按桶顺序判定角色', () => {
  assert.equal(inferRole('审计代码找漏洞'), 'audit');
  assert.equal(inferRole('跑测试'), 'verify');
  assert.equal(inferRole('调研依赖'), 'explore');
  assert.equal(inferRole('通读代码文件'), 'reading');
  assert.equal(inferRole('梳理项目结构'), 'map');
  assert.equal(inferRole('分析现有方案'), 'planner');
  assert.equal(inferRole('实现登录页'), 'implement');
});

test('inferRole 桶顺序优先：verify 压过 implement、planner 压过 implement', () => {
  // "编写测试" carries both 编写(implement) and 测试(verify); verify bucket wins.
  assert.equal(inferRole('编写测试用例'), 'verify');
  // "分析并修复" carries 分析(planner) and 修复(implement); planner bucket wins.
  assert.equal(inferRole('分析并修复问题'), 'planner');
});

test('inferRole 无信号命中回退 DEFAULT_ROLE', () => {
  assert.equal(inferRole('随便干点啥'), DEFAULT_ROLE);
  assert.equal(inferRole(''), DEFAULT_ROLE);
});

test('inferRole 对垃圾输入不抛、经 String() 归一', () => {
  for (const junk of [null, undefined, 0, {}, [], () => {}]) {
    assert.equal(inferRole(junk), DEFAULT_ROLE);
  }
  // A truthy non-string object stringifies to "[object Object]" — no role matches it.
  assert.equal(inferRole({ task: 'x' }), DEFAULT_ROLE);
});

test('_cleanTask 折叠空白、trim、按 MAX_SUBTASK_CHARS 截断', () => {
  assert.equal(_cleanTask('  a   b \n c '), 'a b c');
  assert.equal(_cleanTask('x'.repeat(500)).length, LIMITS.MAX_SUBTASK_CHARS);
  assert.equal(_cleanTask(''), '');
});

test('KNOWN-DEFECT: _cleanTask 用 `String(task || \'\')` 把数字 0 当成假值清成空串', () => {
  // Probe: _cleanTask(0) -> '' because 0 is falsy before String(). A legitimate
  // task literally "0" (or any falsy-but-meaningful value) is silently emptied,
  // and planDelegation then drops it as an empty sub-task.
  assert.equal(_cleanTask(0), '');
  assert.equal(_cleanTask(false), '');
});

test('planDelegation 机会不可执行时返回 toolCall:null 全零结构', () => {
  assert.deepEqual(planDelegation(null), { toolCall: null, subtaskCount: 0, dropped: 0, roles: [] });
  assert.deepEqual(planDelegation({ subtasks: [] }), { toolCall: null, subtaskCount: 0, dropped: 0, roles: [] });
  assert.deepEqual(planDelegation({ subtasks: [{ task: '分析 A' }] }), {
    toolCall: null,
    subtaskCount: 0,
    dropped: 0,
    roles: [],
  });
});

test('planDelegation 恰好 MIN 条时成型且 dropped=0', () => {
  const r = planDelegation({ subtasks: mkTasks(LIMITS.MIN_SUBTASKS) });
  assert.equal(r.subtaskCount, LIMITS.MIN_SUBTASKS);
  assert.equal(r.dropped, 0);
  assert.equal(r.toolCall.name, 'agent');
  assert.equal(r.toolCall.params.mode, 'flexible');
  assert.equal(r.roles.length, r.subtaskCount);
  assert.deepEqual(
    r.toolCall.params.subtasks.map((s) => s.task),
    mkTasks(LIMITS.MIN_SUBTASKS).map((s) => s.task),
  );
});

test('planDelegation 超过 MAX 时钳位并把多余计入 dropped', () => {
  const n = LIMITS.MAX_SUBTASKS + 2;
  const r = planDelegation({ subtasks: mkTasks(n) });
  assert.equal(r.subtaskCount, LIMITS.MAX_SUBTASKS);
  assert.equal(r.dropped, 2);
  assert.equal(r.toolCall.params.subtasks.length, LIMITS.MAX_SUBTASKS);
});

test('planDelegation 去重（大小写不敏感）并丢弃空/假任务', () => {
  const extra = Math.max(1, LIMITS.MIN_SUBTASKS - 1); // keep the plan actionable after de-dup
  const subtasks = [
    { task: 'Fix It' },
    { task: 'fix it' }, // same key after lower-case -> deduped
    { task: '   ' }, // cleans to empty -> skipped
    { task: null }, // skipped
    ...mkTasks(extra),
  ];
  const r = planDelegation({ subtasks });
  const kept = r.toolCall.params.subtasks.map((s) => s.task);
  // Only "Fix It" survives the case-insensitive collapse; the blanks never appear.
  assert.deepEqual(kept, ['Fix It'].concat(mkTasks(extra).map((s) => s.task)));
  assert.equal(kept.filter((t) => /fix it/i.test(t)).length, 1);
  assert.equal(r.subtaskCount, 1 + extra);
});

test('planDelegation roles 数组逐条镜像 subtasks 的推断角色', () => {
  const subtasks = [
    { task: '实现 A' },
    { task: '调研 B' },
    { task: '跑测试 C' },
  ].concat(mkTasks(Math.max(0, LIMITS.MIN_SUBTASKS - 3)));
  const r = planDelegation({ subtasks });
  assert.deepEqual(r.roles.slice(0, 3), ['implement', 'explore', 'verify']);
  assert.deepEqual(r.toolCall.params.subtasks.slice(0, 3).map((s) => s.role), r.roles.slice(0, 3));
});

test('planDelegation 有 goal 写具体目标，无 goal 用默认目标行', () => {
  const withGoal = planDelegation({ subtasks: mkTasks(LIMITS.MIN_SUBTASKS) }, { goal: '重构   计费  模块' });
  assert.match(withGoal.toolCall.params.prompt, /Overall goal: 重构 计费 模块/);
  const noGoal = planDelegation({ subtasks: mkTasks(LIMITS.MIN_SUBTASKS) });
  assert.match(noGoal.toolCall.params.prompt, /Overall goal: complete all of the independent sub-tasks below/);
});

test('KNOWN-DEFECT: planDelegation(opp, null) 抛 TypeError，默认参数只兜 undefined 不兜 null', () => {
  // Probe: `opts = null` bypasses the `= {}` default, then `opts.goal` throws
  // "Cannot read properties of null (reading 'goal')". The detector calls this with
  // whatever it holds, so a null opts crashes the planning turn instead of degrading.
  assert.throws(() => planDelegation({ subtasks: mkTasks(LIMITS.MIN_SUBTASKS) }, null), TypeError);
  // undefined opts is fine (default kicks in).
  assert.doesNotThrow(() => planDelegation({ subtasks: mkTasks(LIMITS.MIN_SUBTASKS) }, undefined));
});
