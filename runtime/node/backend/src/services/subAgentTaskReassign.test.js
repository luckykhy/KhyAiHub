'use strict';

/**
 * subAgentTaskReassign.test.js — 再分配纯叶口径锁（A1：容错与任务动态再分配）。
 *
 * 覆盖：
 *   · reassignMaxRetries 门控口径：未设 → 默认 2；0/垃圾 → 关；正整数 → 该值；
 *   · isFailedOutcome：execute 自身 success:false 与执行器软失败都算失败；
 *   · outcomeError：顶层 error → result.error → result.message → 兜底；
 *   · sameScopes：集合语义（顺序无关、成员/长度不同 → false）；
 *   · selectAlternateAgent：跳过已试过/被本 run 占用/非 CREATED/异角色/异 scopes，
 *     取迭代序首个，primary 无 role → null；
 *   · writeReassignAudit：双写两条 Trail（字段对齐 _writeZombieHealAudit）+ fail-soft。
 *
 * node:test。运行：`node --test src/services/subAgentTaskReassign.test.js`。
 */

// 沙箱必须设在**任何**项目 require 之前：writeReassignAudit 的两个写手都经
// dataHome 解析落点，而 dataHome 首次解析后即缓存，之后再改 env 打到的就是
// 真实数据目录。
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, beforeEach, test } = require('node:test');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-subagent-reassign-'));
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
const { AGENT_STATE } = require('./subAgentOrchestrator');
const {
  REASSIGN_MAX_RETRIES_FLAG,
  reassignMaxRetries,
  isFailedOutcome,
  outcomeError,
  sameScopes,
  selectAlternateAgent,
  writeReassignAudit,
} = require('./subAgentTaskReassign');

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
  for (const file of [getHealAuditFilePath(), getHealServiceFilePath()]) {
    fs.rmSync(file, { force: true });
  }
});

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

// utils/healAudit 的写是 fire-and-forget（与 workerAgent 的 _writeZombieHealAudit
// 同型），让出一个宏任务再断言落盘。
function flushAudit() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ── 门控预算 ──────────────────────────────────────────────────────────────

test('reassignMaxRetries：未设 → 默认 2；0/垃圾 → 关；正整数 → 该值', () => {
  assert.strictEqual(reassignMaxRetries({}), 2);
  assert.strictEqual(reassignMaxRetries(), 2); // 进程 env 未设时也是默认 2
  assert.strictEqual(reassignMaxRetries({ [REASSIGN_MAX_RETRIES_FLAG]: '0' }), 0);
  assert.strictEqual(reassignMaxRetries({ [REASSIGN_MAX_RETRIES_FLAG]: 'off' }), 0);
  assert.strictEqual(reassignMaxRetries({ [REASSIGN_MAX_RETRIES_FLAG]: 'abc' }), 0);
  assert.strictEqual(reassignMaxRetries({ [REASSIGN_MAX_RETRIES_FLAG]: '-1' }), 0);
  assert.strictEqual(reassignMaxRetries({ [REASSIGN_MAX_RETRIES_FLAG]: '5' }), 5);
  assert.strictEqual(reassignMaxRetries({ [REASSIGN_MAX_RETRIES_FLAG]: ' 3 ' }), 3);
});

// ── 失败判定 / 错误原因 ───────────────────────────────────────────────────

test('isFailedOutcome：execute 自身 success:false 与执行器软失败都算失败', () => {
  assert.strictEqual(isFailedOutcome({ success: false, error: 'thrown' }), true);
  assert.strictEqual(
    isFailedOutcome({ success: true, result: { success: false, error: 'soft' } }),
    true
  );
  assert.strictEqual(
    isFailedOutcome({ success: true, result: { success: true, text: 'ok' } }),
    false
  );
  assert.strictEqual(isFailedOutcome({ success: true }), false);
  assert.strictEqual(isFailedOutcome({ success: true, result: null }), false);
  assert.strictEqual(isFailedOutcome(undefined), false);
  assert.strictEqual(isFailedOutcome('not-an-outcome'), false);
});

test('outcomeError：顶层 error → result.error → result.message → 兜底', () => {
  assert.strictEqual(outcomeError({ error: 'thrown' }), 'thrown');
  assert.strictEqual(outcomeError({ result: { error: 'soft' } }), 'soft');
  assert.strictEqual(outcomeError({ result: { message: 'soft msg' } }), 'soft msg');
  assert.strictEqual(outcomeError({ result: {} }), 'task failed');
  assert.strictEqual(outcomeError(null), 'task failed');
  assert.strictEqual(outcomeError({ error: 42 }), '42');
});

// ── scopes 集合语义 ───────────────────────────────────────────────────────

test('sameScopes：顺序无关；成员不同/长度不同/非数组 → false', () => {
  assert.strictEqual(sameScopes(['read', 'write'], ['write', 'read']), true);
  assert.strictEqual(sameScopes(['read'], ['read']), true);
  assert.strictEqual(sameScopes([], []), true);
  assert.strictEqual(sameScopes(['read', 'write'], ['read']), false);
  assert.strictEqual(sameScopes(['read', 'write'], ['read', 'execute']), false);
  assert.strictEqual(sameScopes('read', ['read']), false);
  assert.strictEqual(sameScopes(['read'], null), false);
});

// ── 备选选取 ──────────────────────────────────────────────────────────────

function fakeAgent(id, opts = {}) {
  return {
    id,
    name: id,
    state: opts.state || AGENT_STATE.CREATED,
    scopes: opts.scopes || ['read', 'write'],
    executor: 'exe',
    agentContext: opts.agentContext === false ? null : { role: opts.role || 'coder' },
  };
}

test('selectAlternateAgent：跳过已试过/被本 run 占用/非 CREATED/异角色/异 scopes', () => {
  const primary = fakeAgent('primary');
  const candidates = [
    fakeAgent('tried'),
    fakeAgent('claimed'),
    fakeAgent('running', { state: AGENT_STATE.RUNNING }),
    fakeAgent('done', { state: AGENT_STATE.COMPLETED }),
    fakeAgent('other-role', { role: 'reviewer' }),
    fakeAgent('other-scopes', { scopes: ['read', 'execute'] }),
    fakeAgent('no-ctx', { agentContext: false }),
    fakeAgent('good-1'),
    fakeAgent('good-2'),
  ];

  const picked = selectAlternateAgent(
    candidates,
    primary,
    new Set(['tried']),
    new Set(['claimed'])
  );

  assert.strictEqual(picked.id, 'good-1'); // 迭代序首个合格者
  const next = selectAlternateAgent(
    candidates,
    primary,
    new Set(['tried', 'good-1']),
    new Set(['claimed'])
  );
  assert.strictEqual(next.id, 'good-2');
});

test('selectAlternateAgent：primary 无 role / 为 null → null（不猜）', () => {
  assert.strictEqual(
    selectAlternateAgent(
      [fakeAgent('good')],
      fakeAgent('p', { agentContext: false }),
      new Set(),
      new Set()
    ),
    null
  );
  assert.strictEqual(selectAlternateAgent([fakeAgent('good')], null, new Set(), new Set()), null);
});

// ── 审计双写 ──────────────────────────────────────────────────────────────

test('writeReassignAudit：双写两条 Trail，字段对齐 _writeZombieHealAudit', async () => {
  writeReassignAudit({
    action: 'subagent_task_reassigned',
    target: 't1',
    reason: 'task_execution_failed',
    details: { taskId: 't1', attempt: 1 },
    message: '任务 t1 执行失败，第 1/2 次转交备选 agent',
  });
  await flushAudit();

  const utilsEntry = readJsonl(getHealAuditFilePath())[0];
  const serviceEntry = readJsonl(getHealServiceFilePath())[0];
  assert.ok(utilsEntry, 'utils/healAudit 须落一条');
  assert.ok(serviceEntry, 'healAuditService 须落一条');
  assert.strictEqual(utilsEntry.action, 'subagent_task_reassigned');
  assert.strictEqual(utilsEntry.target, 't1');
  assert.strictEqual(utilsEntry.reason, 'task_execution_failed');
  assert.strictEqual(utilsEntry.message, '任务 t1 执行失败，第 1/2 次转交备选 agent');
  assert.strictEqual(utilsEntry.details.attempt, 1);
  assert.strictEqual(serviceEntry.component, 'subAgentOrchestrator');
  assert.strictEqual(serviceEntry.action, 'subagent_task_reassigned');
  assert.strictEqual(serviceEntry.target, 't1');
  assert.strictEqual(serviceEntry.result, 'success');
  assert.strictEqual(serviceEntry.details.message, utilsEntry.message);
});

test('writeReassignAudit：坏 entry 不抛（fail-soft）', async () => {
  assert.doesNotThrow(() => writeReassignAudit({}));
  assert.doesNotThrow(() => writeReassignAudit(null));
  await flushAudit();
});
