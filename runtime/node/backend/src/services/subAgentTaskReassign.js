'use strict';

/**
 * subAgentTaskReassign.js — task-level fault tolerance for SubAgentOrchestrator.
 *
 * The dependency-aware task layer used to treat a failed task as terminal. Here a
 * task whose execution failed is handed to an alternate agent — same scopes, same
 * role, not claimed by another task of the same run — and only an unrescued task
 * lands 'failed' (which is what skips its dependents).
 *
 * Budget semantics follow the coordinator's zombie reaper (workerAgent.js
 * ZOMBIE_MAX_RETRIES: default 2, env-tunable) — one family of mechanisms keeps one
 * retry budget. Unlike that `parseInt(...) || 2`, 0/invalid means OFF here, because
 * this mechanism must be able to fall back to the legacy failure-is-terminal
 * behaviour byte-for-byte.
 *
 * Every handoff and every terminal verdict is dual-written to both heal-audit
 * trails with the field shape of workerAgent's _writeZombieHealAudit — no second
 * audit format. Writes are fail-soft: audit trouble never reaches the task flow.
 *
 * The orchestrator requires this module at load time, so anything needed back from
 * it (AGENT_STATE) is required lazily inside the functions.
 */

const REASSIGN_MAX_RETRIES_FLAG = 'KHY_SUBAGENT_REASSIGN_MAX_RETRIES';
const REASSIGN_MAX_RETRIES_DEFAULT = 2;

/**
 * Reassignment budget. Pure: reads only the supplied env so tests can pin the gate
 * contract. Unset/empty → default 2; positive int → that value; 0/negative/
 * non-numeric → 0 (off).
 *
 * @param {object} [env=process.env]
 * @returns {number}
 */
function reassignMaxRetries(env = process.env) {
  const raw = env ? env[REASSIGN_MAX_RETRIES_FLAG] : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return REASSIGN_MAX_RETRIES_DEFAULT;
  }
  const n = parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Does an execute() return value mean the task failed? Two shapes count:
 * execute() reporting { success: false } (the executor threw) and an
 * executor-resolved { success: false } payload — the soft failure the old task
 * layer recorded as 'completed' (the status vs success mismatch).
 */
function isFailedOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') {
    return false;
  }
  return outcome.success === false || outcome.result?.success === false;
}

/** Best one-line failure reason from an outcome; soft failures hide it in result. */
function outcomeError(outcome) {
  if (!outcome) {
    return 'task failed';
  }
  const err =
    outcome.error ||
    (outcome.result && outcome.result.error) ||
    (outcome.result && outcome.result.message);
  return err ? String(err) : 'task failed';
}

/** Scope sets compared as sets, so member order does not matter. */
function sameScopes(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  const key = (s) => [...s].sort().join('\u0000');
  return key(a) === key(b);
}

/**
 * Dual-write a reassignment record to both heal-audit trails, field for field like
 * workerAgent's _writeZombieHealAudit (action/target/reason/details/message;
 * reason only reaches writeHealAudit, result only logHealEvent). Fail-soft.
 *
 * @param {{ action: string, target: string, reason: string, details: object,
 *           message: string, result?: string }} entry
 */
function writeReassignAudit(entry) {
  try {
    const { writeHealAudit } = require('../utils/healAudit');
    Promise.resolve(
      writeHealAudit({
        action: entry.action,
        target: entry.target,
        reason: entry.reason,
        details: entry.details,
        message: entry.message,
      })
    ).catch(() => {
      /* audit is best-effort */
    });
  } catch {
    /* audit module unavailable */
  }
  try {
    require('./healAuditService').logHealEvent({
      component: 'subAgentOrchestrator',
      action: entry.action,
      target: entry.target,
      result: entry.result || 'success',
      details: { ...entry.details, message: entry.message },
    });
  } catch {
    /* audit module unavailable */
  }
}

/**
 * Pick the alternate agent: unclaimed by this run's tasks, not already tried,
 * executable (execute() only accepts AGENT_STATE.CREATED), same scopes, same role
 * (agentContext.role). Map iteration order is spawn order, so the pick is stable.
 *
 * @param {Iterable<object>} agents - live agent sessions of the orchestrator
 * @param {object} primary - the agent whose task just failed
 * @param {Set<string>} attempted - agent ids already tried for this task
 * @param {Set<string>} runAgentIds - agent ids bound to a task of this run
 * @returns {object|null}
 */
function selectAlternateAgent(agents, primary, attempted, runAgentIds) {
  if (!primary || !primary.agentContext || !primary.agentContext.role) {
    return null;
  }
  const { AGENT_STATE } = require('./subAgentOrchestrator');
  for (const agent of agents) {
    if (attempted.has(agent.id) || runAgentIds.has(agent.id)) {
      continue;
    }
    if (agent.state !== AGENT_STATE.CREATED) {
      continue;
    }
    if (!agent.agentContext || agent.agentContext.role !== primary.agentContext.role) {
      continue;
    }
    if (!sameScopes(agent.scopes, primary.scopes)) {
      continue;
    }
    return agent;
  }
  return null;
}

/**
 * Task-layer entry point. Gate off (or the outcome is not a failure) → the legacy
 * entry, byte-identical to the pre-mechanism behaviour.
 *
 * @param {SubAgentOrchestrator} host - only host.execute / host.emit / host._agents
 * @param {{id: string, agentId: string}} task
 * @param {object} firstOutcome - execute()'s return value for task.agentId
 * @param {Array<{agentId?: string}>} tasks - the whole run: an agent bound to
 *        another task must never be stolen as an alternate, or that task would
 *        later hit 'Agent already started'
 * @returns {Promise<{taskId: string, status: string, result: any}>}
 */
async function reassignFailedTask(host, task, firstOutcome, tasks) {
  const budget = reassignMaxRetries();
  if (!isFailedOutcome(firstOutcome) || budget <= 0) {
    return { taskId: task.id, status: 'completed', result: firstOutcome };
  }

  const runAgentIds = new Set((tasks || []).map((t) => t.agentId).filter(Boolean));
  const primary = host._agents.get(task.agentId);
  const attempted = new Set([task.agentId]);
  let last = firstOutcome;

  for (let attempt = 1; attempt <= budget; attempt++) {
    const alternate = selectAlternateAgent(host._agents.values(), primary, attempted, runAgentIds);
    if (!alternate) {
      break;
    }
    attempted.add(alternate.id);
    const role = alternate.agentContext.role;
    writeReassignAudit({
      action: 'subagent_task_reassigned',
      target: task.id,
      reason: 'task_execution_failed',
      details: {
        taskId: task.id,
        fromAgentId: task.agentId,
        toAgentId: alternate.id,
        attempt,
        maxReassign: budget,
        role,
        fromExecutor: primary.executor,
        toExecutor: alternate.executor,
        failedError: outcomeError(last),
      },
      message: `任务 ${task.id} 执行失败，第 ${attempt}/${budget} 次转交备选 agent(角色 ${role})`,
    });
    host.emit('agent:reassigned', {
      agentId: alternate.id,
      fromAgentId: task.agentId,
      taskId: task.id,
      name: alternate.name,
      depth: alternate.depth,
      attempt,
      maxReassign: budget,
    });

    let outcome;
    try {
      outcome = await host.execute(alternate.id);
    } catch (err) {
      outcome = { success: false, error: err.message };
    }
    if (!isFailedOutcome(outcome)) {
      return { taskId: task.id, status: 'completed', result: outcome };
    }
    last = outcome;
  }

  const reassignTried = attempted.size - 1;
  writeReassignAudit({
    action: 'subagent_task_reassign_exhausted',
    target: task.id,
    reason: reassignTried > 0 ? 'reassign_retries_exhausted' : 'no_alternate_available',
    result: 'failure',
    details: {
      taskId: task.id,
      reassignTried,
      maxReassign: budget,
      failedError: outcomeError(last),
    },
    message:
      reassignTried > 0
        ? `任务 ${task.id} 连续 ${reassignTried} 次转交备选仍失败，已判 failed`
        : `任务 ${task.id} 执行失败且无同 scopes/角色备选 agent，已判 failed`,
  });
  return { taskId: task.id, status: 'failed', result: last };
}

module.exports = {
  REASSIGN_MAX_RETRIES_FLAG,
  reassignMaxRetries,
  isFailedOutcome,
  outcomeError,
  sameScopes,
  writeReassignAudit,
  selectAlternateAgent,
  reassignFailedTask,
};
