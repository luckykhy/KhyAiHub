'use strict';

/**
 * subAgentOrchestrator.test.js — 任务层容错口径锁（A1：容错与任务动态再分配）。
 *
 * 覆盖（再分配逻辑本体在 ./subAgentTaskReassign，其纯叶口径见
 * subAgentTaskReassign.test.js；本文件钉任务层的接线与端到端行为）：
 *   · happy path：首次执行即成功 → completed、零 agent:reassigned 事件、零审计；
 *   · 软失败（executeFn 回 success:false）与硬失败（executeFn 抛错）都转交备选；
 *   · 转交成功 → 任务 completed 且结果是备选的产出；
 *   · 预算耗尽 → 任务 failed，下游依赖 skip，且不盗用本 run 其它任务的 agent；
 *   · 无备选 → 立即 failed（不再把软失败谎报成 completed），原结果不丢；
 *   · 负向选择：异角色 / 异 scopes 的备选选不中；scopes 顺序无关选得中；
 *   · 并发：同层两个任务同时失败各得一个备选，不互抢、不重复跑；
 *   · 门控关（KHY_SUBAGENT_REASSIGN_MAX_RETRIES=0）→ 逐字节回退旧行为；
 *   · 每次转交/耗尽都双写 heal 审计（utils/healAudit + healAuditService）。
 *
 * node:test。运行：`node --test src/services/subAgentOrchestrator.test.js`。
 */

// 沙箱必须设在**任何**项目 require 之前：两个 heal 审计写手都经 dataHome 解析落点
// （KHY_DATA_HOME / KHY_APP_HOME / KHY_HEAL_LOG_DIR），而 dataHome 首次解析后即
// 缓存，之后再改 env 打到的就是真实数据目录。
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, beforeEach, test } = require('node:test');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-subagent-orch-'));
const _savedEnv = {
  KHY_DATA_HOME: process.env.KHY_DATA_HOME,
  KHY_APP_HOME: process.env.KHY_APP_HOME,
  KHY_HEAL_LOG_DIR: process.env.KHY_HEAL_LOG_DIR,
};
process.env.KHY_DATA_HOME = SANDBOX;
process.env.KHY_APP_HOME = SANDBOX;
process.env.KHY_HEAL_LOG_DIR = path.join(SANDBOX, 'logs');

const { getHealAuditFilePath } = require('../utils/healAudit');

const { getHealAuditFilePath: getHealServiceFilePath } = require('./healAuditService');
const { SubAgentOrchestrator } = require('./subAgentOrchestrator');
const { REASSIGN_MAX_RETRIES_FLAG } = require('./subAgentTaskReassign');

after(() => {
  for (const [key, value] of Object.entries(_savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env[REASSIGN_MAX_RETRIES_FLAG];
  clearAuditFiles();
});

function clearAuditFiles() {
  for (const file of [getHealAuditFilePath(), getHealServiceFilePath()]) {
    fs.rmSync(file, { force: true });
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** 两个审计写手的当前内容（action 维度过滤由各用例自己写）。 */
function auditEntries() {
  return { utils: readJsonl(getHealAuditFilePath()), service: readJsonl(getHealServiceFilePath()) };
}

function byAction(entries, action) {
  return entries.filter((e) => e.action === action);
}

// utils/healAudit 的记录 message 在顶层；healAuditService 的折进 details.message
// （_writeZombieHealAudit 同型），两个口径都认。
function entryMessage(entry) {
  return String(entry.message || (entry.details && entry.details.message) || '');
}

// _writeReassignAudit 对 utils/healAudit 是 fire-and-forget（与 workerAgent 的
// _writeZombieHealAudit 同型），让出一个宏任务再断言落盘，避免偶发竞态。
function flushAudit() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 搭一台 orchestrator：root（RUNNING）+ primary + N 个备选 + M 个给下游任务用的
 * agent。备选不挂任何任务——它们是「备选智能体」池；spec 可覆盖 role/scopes 以测
 * 负向选择。fork 会把 scopes 过滤到 parent 内，所以 root 给足三种 scope。
 */
function makeScenario(executeFn, { standbys = [], dependents = 0 } = {}) {
  const orch = new SubAgentOrchestrator({ executeFn });
  const root = orch.spawnRoot({
    name: 'root',
    task: 'root',
    role: 'coder',
    scopes: ['read', 'write', 'execute'],
  });
  root.state = 'running'; // fork() 要求 parent 处于 RUNNING
  const primary = orch.fork(root.id, {
    name: 'primary',
    task: 'task-1',
    role: 'coder',
    scopes: ['read', 'write'],
  });
  const standbyAgents = standbys.map((spec, i) =>
    orch.fork(root.id, {
      name: spec.name || `standby-${i + 1}`,
      task: 'task-1',
      role: spec.role === undefined ? 'coder' : spec.role,
      scopes: spec.scopes || ['read', 'write'],
    })
  );
  const dependentAgents = [];
  for (let i = 1; i <= dependents; i++) {
    dependentAgents.push(
      orch.fork(root.id, {
        name: `dep-${i}`,
        task: `task-${i + 1}`,
        role: 'coder',
        scopes: ['read', 'write'],
      })
    );
  }
  return { orch, root, primary, standbyAgents, dependentAgents };
}

// ── happy path ────────────────────────────────────────────────────────────

test('首次执行即成功 → completed，零转交事件、零审计', async () => {
  const calls = [];
  const events = [];
  const { orch, primary, standbyAgents } = makeScenario(
    async (agent) => {
      calls.push(agent.id);
      return { success: true, text: 'first try' };
    },
    { standbys: [{}] }
  );
  orch.on('agent:reassigned', (ev) => events.push(ev));

  const results = await orch.executeDependencyAware([{ id: 't1', agentId: primary.id }]);

  assert.strictEqual(results.get('t1').status, 'completed');
  assert.strictEqual(results.get('t1').result.result.text, 'first try');
  assert.deepStrictEqual(calls, [primary.id]);
  assert.strictEqual(standbyAgents[0].state, 'created');
  assert.strictEqual(events.length, 0);
  await flushAudit();
  assert.deepStrictEqual(auditEntries().utils, []);
  assert.deepStrictEqual(auditEntries().service, []);
});

// ── 转交成功 ──────────────────────────────────────────────────────────────

test('软失败 → 转交备选并成功：任务 completed，结果是备选的产出', async () => {
  const calls = [];
  const events = [];
  const { orch, primary, standbyAgents } = makeScenario(
    async (agent) => {
      calls.push(agent.id);
      if (agent.id === primary.id) {
        return { success: false, error: 'primary adapter 500' };
      }
      return { success: true, text: 'standby done' };
    },
    { standbys: [{}] }
  );
  orch.on('agent:reassigned', (ev) => events.push(ev));

  const results = await orch.executeDependencyAware([{ id: 't1', agentId: primary.id }]);

  assert.strictEqual(results.get('t1').status, 'completed');
  assert.strictEqual(results.get('t1').result.result.text, 'standby done');
  assert.deepStrictEqual(calls, [primary.id, standbyAgents[0].id]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].taskId, 't1');
  assert.strictEqual(events[0].fromAgentId, primary.id);
  assert.strictEqual(events[0].agentId, standbyAgents[0].id);
  assert.strictEqual(events[0].attempt, 1);
  assert.strictEqual(events[0].maxReassign, 2);

  await flushAudit();
  const audit = auditEntries();
  for (const entries of [audit.utils, audit.service]) {
    const reassigned = byAction(entries, 'subagent_task_reassigned');
    assert.strictEqual(reassigned.length, 1);
    assert.strictEqual(reassigned[0].target, 't1');
    assert.strictEqual(reassigned[0].details.fromAgentId, primary.id);
    assert.strictEqual(reassigned[0].details.toAgentId, standbyAgents[0].id);
    assert.strictEqual(reassigned[0].details.attempt, 1);
    assert.strictEqual(reassigned[0].details.maxReassign, 2);
    assert.strictEqual(reassigned[0].details.role, 'coder');
    assert.ok(entryMessage(reassigned[0]).includes('t1'), 'message 须带任务号');
    assert.strictEqual(byAction(entries, 'subagent_task_reassign_exhausted').length, 0);
  }
});

test('硬失败（executeFn 抛错）同样转交备选', async () => {
  const calls = [];
  const { orch, primary, standbyAgents } = makeScenario(
    async (agent) => {
      calls.push(agent.id);
      if (agent.id === primary.id) {
        throw new Error('adapter crashed');
      }
      return { success: true, text: 'rescued' };
    },
    { standbys: [{}] }
  );

  const results = await orch.executeDependencyAware([{ id: 't1', agentId: primary.id }]);

  assert.strictEqual(results.get('t1').status, 'completed');
  assert.strictEqual(results.get('t1').result.result.text, 'rescued');
  assert.deepStrictEqual(calls, [primary.id, standbyAgents[0].id]);
  assert.strictEqual(primary.state, 'failed'); // execute() 自身 catch 的终态不动
});

// ── 耗尽 / 无备选 / 负向选择 ──────────────────────────────────────────────

test('默认预算 2 次耗尽 → 任务 failed，下游依赖 skip，不盗用本 run 的 agent', async () => {
  const calls = [];
  const events = [];
  const { orch, primary, standbyAgents, dependentAgents } = makeScenario(
    async (agent) => {
      calls.push(agent.id);
      return { success: false, error: `boom-${agent.name}` };
    },
    { standbys: [{}, {}], dependents: 1 }
  );
  orch.on('agent:reassigned', (ev) => events.push(ev));

  const results = await orch.executeDependencyAware([
    { id: 't1', agentId: primary.id },
    { id: 't2', agentId: dependentAgents[0].id, dependencies: ['t1'] },
  ]);

  assert.strictEqual(results.get('t1').status, 'failed');
  assert.strictEqual(results.get('t1').result.result.error, 'boom-standby-2');
  assert.strictEqual(results.get('t2').status, 'skipped');
  assert.ok(String(results.get('t2').result.reason).includes('t1 failed'));
  // 原 agent + 两个备选各跑一次；t2 的 agent 一次都没被偷跑
  assert.deepStrictEqual(calls, [primary.id, standbyAgents[0].id, standbyAgents[1].id]);
  assert.strictEqual(dependentAgents[0].state, 'created');
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[1].attempt, 2);

  await flushAudit();
  const audit = auditEntries();
  for (const entries of [audit.utils, audit.service]) {
    assert.strictEqual(byAction(entries, 'subagent_task_reassigned').length, 2);
    const exhausted = byAction(entries, 'subagent_task_reassign_exhausted');
    assert.strictEqual(exhausted.length, 1);
    assert.strictEqual(exhausted[0].target, 't1');
    assert.strictEqual(exhausted[0].details.reassignTried, 2);
    assert.strictEqual(exhausted[0].details.maxReassign, 2);
  }
  // reason 只落在 utils/healAudit 记录顶层、result 只落在 healAuditService 记录
  // （logHealEvent 不收 reason、writeHealAudit 不收 result——与
  // _writeZombieHealAudit 的字段不对称一致）
  assert.strictEqual(
    byAction(audit.utils, 'subagent_task_reassign_exhausted')[0].reason,
    'reassign_retries_exhausted'
  );
  assert.strictEqual(
    byAction(audit.service, 'subagent_task_reassign_exhausted')[0].result,
    'failure'
  );
});

test('预算可调：KHY_SUBAGENT_REASSIGN_MAX_RETRIES=1 → 只转交 1 次', async () => {
  process.env[REASSIGN_MAX_RETRIES_FLAG] = '1';
  const calls = [];
  const { orch, primary, standbyAgents } = makeScenario(
    async (agent) => {
      calls.push(agent.id);
      return { success: false, error: `boom-${agent.name}` };
    },
    { standbys: [{}, {}] }
  );

  const results = await orch.executeDependencyAware([{ id: 't1', agentId: primary.id }]);

  assert.strictEqual(results.get('t1').status, 'failed');
  assert.deepStrictEqual(calls, [primary.id, standbyAgents[0].id]);
  await flushAudit();
  const audit = auditEntries();
  assert.strictEqual(byAction(audit.utils, 'subagent_task_reassigned').length, 1);
  assert.strictEqual(byAction(audit.utils, 'subagent_task_reassign_exhausted').length, 1);
});

test('无备选 → 立即 failed（不再把软失败记成 completed），原结果不丢', async () => {
  const events = [];
  const { orch, primary } = makeScenario(async () => ({
    success: false,
    error: 'no backup at all',
  }));
  orch.on('agent:reassigned', (ev) => events.push(ev));

  const results = await orch.executeDependencyAware([{ id: 't1', agentId: primary.id }]);

  assert.strictEqual(results.get('t1').status, 'failed');
  assert.strictEqual(results.get('t1').result.result.error, 'no backup at all');
  assert.strictEqual(events.length, 0);
  await flushAudit();
  const audit = auditEntries();
  for (const entries of [audit.utils, audit.service]) {
    assert.strictEqual(byAction(entries, 'subagent_task_reassigned').length, 0);
    assert.strictEqual(byAction(entries, 'subagent_task_reassign_exhausted').length, 1);
  }
  assert.strictEqual(
    byAction(audit.utils, 'subagent_task_reassign_exhausted')[0].reason,
    'no_alternate_available'
  );
});

test('同角色但 scopes 不同 → 选不中，直接 failed', async () => {
  const calls = [];
  const { orch, primary } = makeScenario(
    async (agent) => {
      calls.push(agent.id);
      return { success: false, error: 'boom' };
    },
    {
      standbys: [{ scopes: ['read', 'execute'] }],
    }
  );

  const results = await orch.executeDependencyAware([{ id: 't1', agentId: primary.id }]);

  assert.strictEqual(results.get('t1').status, 'failed');
  assert.deepStrictEqual(calls, [primary.id]);
  await flushAudit();
  assert.strictEqual(byAction(auditEntries().utils, 'subagent_task_reassigned').length, 0);
  assert.strictEqual(
    byAction(auditEntries().utils, 'subagent_task_reassign_exhausted')[0].reason,
    'no_alternate_available'
  );
});

test('角色不同 → 选不中，直接 failed', async () => {
  const calls = [];
  const { orch, primary } = makeScenario(
    async (agent) => {
      calls.push(agent.id);
      return { success: false, error: 'boom' };
    },
    {
      standbys: [{ role: 'reviewer' }],
    }
  );

  const results = await orch.executeDependencyAware([{ id: 't1', agentId: primary.id }]);

  assert.strictEqual(results.get('t1').status, 'failed');
  assert.deepStrictEqual(calls, [primary.id]);
});

test('scopes 顺序无关 → 选得中并转交成功', async () => {
  const calls = [];
  const { orch, primary, standbyAgents } = makeScenario(
    async (agent) => {
      calls.push(agent.id);
      if (agent.id === primary.id) {
        return { success: false, error: 'boom' };
      }
      return { success: true, text: 'rescued' };
    },
    { standbys: [{ scopes: ['write', 'read'] }] }
  );

  const results = await orch.executeDependencyAware([{ id: 't1', agentId: primary.id }]);

  assert.strictEqual(results.get('t1').status, 'completed');
  assert.strictEqual(results.get('t1').result.result.text, 'rescued');
  assert.deepStrictEqual(calls, [primary.id, standbyAgents[0].id]);
});

// ── 并发 ──────────────────────────────────────────────────────────────────

test('并发：同层两个任务同时失败，各得一个备选，不互抢也不重复跑', async () => {
  const calls = [];
  const events = [];
  const { orch, primary, standbyAgents, dependentAgents } = makeScenario(
    async (agent) => {
      calls.push(agent.name);
      return { success: false, error: `boom-${agent.name}` };
    },
    { standbys: [{}, {}], dependents: 2 }
  );
  orch.on('agent:reassigned', (ev) => events.push(ev));

  const results = await orch.executeDependencyAware([
    { id: 't1', agentId: primary.id },
    { id: 't2', agentId: dependentAgents[0].id },
    { id: 't3', agentId: dependentAgents[1].id },
  ]);

  assert.strictEqual(results.get('t1').status, 'failed');
  assert.strictEqual(results.get('t2').status, 'failed');
  assert.strictEqual(results.get('t3').status, 'failed');
  // 3 个 primary + 2 个备选各一次：备选不会被子任务重复抢跑
  // （选取要求 CREATED，而 execute() 在第一个 await 前就同步置 RUNNING，
  //   选取与启动之间没有让出点，所以后到者看到的是 RUNNING 而非 CREATED）
  assert.strictEqual(calls.length, 5);
  assert.strictEqual(calls.filter((n) => n === 'standby-1').length, 1);
  assert.strictEqual(calls.filter((n) => n === 'standby-2').length, 1);
  assert.deepStrictEqual(
    events.map((e) => e.agentId).sort(),
    [standbyAgents[0].id, standbyAgents[1].id].sort()
  );
});

// ── 门控关 → 逐字节回退 ───────────────────────────────────────────────────

test('门控关（=0）→ 逐字节回退：软失败仍记 completed，备选不跑、零审计、下游不 skip', async () => {
  process.env[REASSIGN_MAX_RETRIES_FLAG] = '0';
  const calls = [];
  const events = [];
  const { orch, primary, standbyAgents, dependentAgents } = makeScenario(
    async (agent) => {
      calls.push(agent.id);
      return { success: false, error: 'soft fail' };
    },
    { standbys: [{}], dependents: 1 }
  );
  orch.on('agent:reassigned', (ev) => events.push(ev));

  const results = await orch.executeDependencyAware([
    { id: 't1', agentId: primary.id },
    { id: 't2', agentId: dependentAgents[0].id, dependencies: ['t1'] },
  ]);

  // 旧语义原样：execute() 的返回值整体进 result，status 记 completed
  // （results 的 value 是 {status, result}，taskId 是 map 的键）
  assert.deepStrictEqual(results.get('t1'), {
    status: 'completed',
    result: { success: true, result: { success: false, error: 'soft fail' } },
  });
  assert.strictEqual(results.get('t2').status, 'completed');
  assert.deepStrictEqual(calls, [primary.id, dependentAgents[0].id]);
  assert.strictEqual(standbyAgents[0].state, 'created');
  assert.strictEqual(events.length, 0);
  await flushAudit();
  assert.deepStrictEqual(auditEntries().utils, []);
  assert.deepStrictEqual(auditEntries().service, []);
});
