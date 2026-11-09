'use strict';

/**
 * Regression lock for the coordinator lane's completion evidence gate (bp-20).
 *
 * Before the fix, `taskBoard.completeTask` wrote status='done' for ANY non-null
 * result: an empty string, an AI self-report, and a canned dispatch receipt all
 * landed as done. The hq lane gates `review → done` on an evidence directory
 * plus machine-checkable criteria (hqStore.reviewDoneBlockers); this lane had
 * no counterpart, and nothing in the repo went red when that judgement
 * regressed — every existing suite either mocks taskBoard (tests/coordinator/*)
 * or injects an in-memory stand-in (tests/orchestrationService.test.js), so the
 * real gate was never executed by a test.
 *
 * This file drives the REAL board and the REAL executor:
 *   A. completionGate's pure judgements;
 *   B. completeTask enforcing the gate (rejected → null, task stays not-done);
 *   C. executeRun booking a gated-out completion as step_failed, not success;
 *   D. the coordinator dispatch receipt (status 'running') counted as failure;
 *   E. workerAgent routing a hallucination hit to failTask instead of done.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const BACKEND = path.resolve(__dirname, '..', '..');
const SRC = path.join(BACKEND, 'src');

// Isolate the data home BEFORE taskBoard resolves it. taskboard.db is
// pre-created as a FILE because getDataDir() mkdirs its last segment — an
// existing file turns that into a no-op, so SQLite opens the real board
// instead of silently degrading to the file fallback.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bp20-gate-'));
fs.mkdirSync(path.join(TMP_HOME, 'T0-authoritative', 'state'), { recursive: true });
fs.writeFileSync(path.join(TMP_HOME, 'T0-authoritative', 'state', 'taskboard.db'), '');
process.env.KHY_DATA_HOME = TMP_HOME;

const test = require('node:test');
const assert = require('node:assert');

const taskBoard = require(path.join(SRC, 'coordinator/taskBoard.js'));
const workerAgent = require(path.join(SRC, 'coordinator/workerAgent.js'));

// A reply that claims a file which does not exist — the phantom-file branch of
// _detectHallucinations resolves it against process.cwd(), and this path is
// absent both from the repo root and from runtime/node/backend, so the hit is
// stable whichever directory the suite is started from.
const PHANTOM = 'src/coordinator/zz-bp20-phantom-file.js';
const PHANTOM_REPLY = [
  'SUMMARY: 复现用：声称改了一个文件。',
  `CHANGES: ${PHANTOM} — 加了一行`,
  'EVIDENCE: 见 CHANGES',
  'RISKS: None.',
  'BLOCKERS: None.',
].join('\n');
const CLEAN_REPLY = [
  'SUMMARY: 只读盘点，没有改动。',
  'CHANGES: None.',
  'EVIDENCE: 无',
  'RISKS: None.',
  'BLOCKERS: None.',
].join('\n');

/** Replace a module in require.cache for the duration of one test. */
function withStubModule(modulePath, exports, fn) {
  const resolved = require.resolve(modulePath);
  const previous = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    children: [],
    paths: [],
    exports,
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous) {
        require.cache[resolved] = previous;
      } else {
        delete require.cache[resolved];
      }
    });
}

/** Wait until the worker leaves the running/pending states. */
async function waitForWorker(workerId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const w = workerAgent.getWorkerStatus(workerId);
    if (w && w.status !== 'running' && w.status !== 'pending') {
      return w;
    }
    if (Date.now() > deadline) {
      throw new Error(`worker ${workerId} still ${w && w.status} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ── A. the gate's pure judgements ────────────────────────────────────────────

test('completionGate rejects an empty or whitespace-only result', () => {
  for (const empty of ['', '   ', '\n\t', null, undefined]) {
    const gate = taskBoard.completionGate(empty);
    assert.strictEqual(gate.ok, false, `expected ${JSON.stringify(empty)} to be rejected`);
    assert.ok(gate.reason.length > 0, 'a rejection must carry a reason');
  }
});

test('completionGate rejects a result carrying hallucination hits', () => {
  const gate = taskBoard.completionGate('SUMMARY: done', {
    hallucinations: [{ type: 'phantom_file', target: PHANTOM, detail: `声称修改了不存在的文件 ${PHANTOM}` }],
  });
  assert.strictEqual(gate.ok, false);
  assert.match(gate.reason, /幻觉检测命中 1 项/);
  assert.ok(gate.reason.includes(PHANTOM), 'the reason must name the phantom target for audit');
});

test('completionGate accepts a non-empty result with zero hallucination hits', () => {
  const gate = taskBoard.completionGate('SUMMARY: 干完了', { hallucinations: [] });
  assert.strictEqual(gate.ok, true);
  assert.strictEqual(gate.reason, '');
});

// ── B. completeTask enforces the gate on the real board ──────────────────────

test('completeTask refuses DONE for an empty result and leaves the task not-done', () => {
  const task = taskBoard.createTask({ description: 'bp20 gate: empty result' });
  assert.strictEqual(taskBoard.claimTask(task.id, 'w-gate'), true);

  const rec = taskBoard.completeTask(task.id, '');

  assert.strictEqual(rec, null, 'a gated completion must return null, not a task record');
  const after = taskBoard.getTask(task.id);
  assert.notStrictEqual(after.status, taskBoard.STATUS.DONE);
});

test('completeTask refuses DONE when hallucination hits are reported', () => {
  const task = taskBoard.createTask({ description: 'bp20 gate: hallucination' });
  taskBoard.claimTask(task.id, 'w-gate');

  const rec = taskBoard.completeTask(task.id, PHANTOM_REPLY, {
    hallucinations: [{ type: 'phantom_file', target: PHANTOM, detail: `声称修改了不存在的文件 ${PHANTOM}` }],
  });

  assert.strictEqual(rec, null);
  assert.notStrictEqual(taskBoard.getTask(task.id).status, taskBoard.STATUS.DONE);
});

test('completeTask still writes DONE for a clean, non-empty result', () => {
  const task = taskBoard.createTask({ description: 'bp20 gate: clean' });
  taskBoard.claimTask(task.id, 'w-gate');

  const rec = taskBoard.completeTask(task.id, CLEAN_REPLY, { hallucinations: [] });

  assert.ok(rec, 'a clean completion must still land');
  assert.strictEqual(rec.status, taskBoard.STATUS.DONE);
  assert.strictEqual(rec.result, CLEAN_REPLY);
});

// ── C/D. the executor never banks a completion that did not pass the gate ────

/** Minimal in-memory board mirroring taskBoard's documented interface. */
function makeBoard({ completeTaskReturns = null } = {}) {
  const STATUS = {
    READY: 'ready', RUNNING: 'running', BLOCKED: 'blocked', DONE: 'done',
  };
  const tasks = new Map();
  let seq = 0;
  const failed = [];
  return {
    STATUS,
    failed,
    createTask(input = {}) {
      seq += 1;
      const id = `t${seq}`;
      const task = {
        id,
        title: input.title || '',
        description: input.description || '',
        parentId: input.parentId || null,
        dependencies: [],
        status: input.status || STATUS.READY,
        maxRetries: Number.isFinite(input.maxRetries) ? input.maxRetries : 1,
        consecutiveFailures: 0,
        claimLock: null,
        result: null,
      };
      tasks.set(id, task);
      return { ...task };
    },
    getTask(id) {
      const t = tasks.get(id);
      return t ? { ...t } : null;
    },
    updateTask(id, updates = {}) {
      const t = tasks.get(id);
      if (!t) return null;
      Object.assign(t, updates);
      return { ...t };
    },
    getChildTasks(parentId) {
      return [...tasks.values()].filter((t) => t.parentId === parentId).map((t) => ({ ...t }));
    },
    claimTask(id) {
      const t = tasks.get(id);
      if (!t || t.status !== STATUS.READY || t.claimLock) return false;
      t.status = STATUS.RUNNING;
      t.claimLock = 'orch-run';
      return true;
    },
    // Stands in for the evidence gate: a rejected completion returns null.
    completeTask() {
      return completeTaskReturns;
    },
    failTask(id, reason) {
      const t = tasks.get(id);
      if (!t) return false;
      t.consecutiveFailures += 1;
      t.result = reason;
      t.claimLock = null;
      t.status = t.consecutiveFailures >= (t.maxRetries || 1) ? STATUS.BLOCKED : STATUS.READY;
      failed.push({ id, reason });
      return true;
    },
  };
}

test('a completion the gate refuses is booked as step_failed, never as success', async () => {
  const svc = require(path.join(SRC, 'services/domain/state/orchestrator/orchestrationService.js'));
  const journal = require(path.join(SRC, 'services/domain/state/orchestrator/orchestrationJournal.js'));
  const board = makeBoard({ completeTaskReturns: null });
  const runner = async () => ({ success: true, output: '' }); // runner "succeeds" with no evidence

  const status = await svc.runOrchestration(
    { mode: 'sequential', steps: [{ prompt: 'no-evidence step' }] },
    { taskBoard: board, agentRunner: runner },
  );

  assert.strictEqual(status.control, 'failed', 'the run must not report done');
  assert.strictEqual(status.progress.done, 0);
  const step = status.steps[0];
  assert.strictEqual(step.status, 'blocked');
  assert.ok(
    board.failed.some((f) => f.reason.includes('完成证据') || f.reason.includes('证据门')),
    `the step failure must name the evidence gate, got: ${JSON.stringify(board.failed)}`,
  );
  const types = journal.readJournal(status.runId, process.env).map((r) => r.type);
  assert.ok(types.includes('step_failed'), `journal must record step_failed, got ${types.join(',')}`);
  assert.ok(!types.includes('step_done'), 'a gated step must never be journaled as step_done');
});

test('a coordinator dispatch receipt (status running) is a failure, not a completion', async () => {
  const svc = require(path.join(SRC, 'services/domain/state/orchestrator/orchestrationService.js'));
  const board = makeBoard({ completeTaskReturns: null });

  // AgentTool in coordinator mode returns before the worker finishes: success
  // with status 'running', no output, and a canned "completed" message.
  await withStubModule(
    path.join(SRC, 'tools/AgentTool'),
    {
      execute: async () => ({
        success: true,
        workerId: 'w-stub',
        status: 'running',
        output: undefined,
        message: 'Worker w-stub completed as general.',
      }),
    },
    async () => {
      const status = await svc.runOrchestration(
        { mode: 'sequential', steps: [{ prompt: 'coordinator dispatch' }] },
        { taskBoard: board }, // no agentRunner → the real _defaultAgentRunner path
      );
      assert.strictEqual(status.control, 'failed');
      assert.strictEqual(status.progress.done, 0);
      assert.ok(
        board.failed.some((f) => f.reason.includes('派发回执')),
        `the failure must say the step only got a dispatch receipt, got: ${JSON.stringify(board.failed)}`,
      );
    },
  );
});

// ── E. workerAgent routes a hallucination hit to failTask, not to done ───────

test('a worker reply with a phantom file fails the task instead of completing it', async () => {
  const task = taskBoard.createTask({ description: 'bp20 worker: phantom file' });

  await withStubModule(
    path.join(SRC, 'cli/ai'),
    { chat: () => new Promise((r) => setTimeout(() => r({ reply: PHANTOM_REPLY }), 60)) },
    async () => {
      const worker = await workerAgent.spawnWorker('声称改了不存在的文件', {
        role: 'general',
        taskId: task.id,
      });
      await waitForWorker(worker.id);

      const after = taskBoard.getTask(task.id);
      assert.notStrictEqual(after.status, taskBoard.STATUS.DONE, 'a hallucination hit must not land done');
      assert.ok(
        String(after.result).includes('幻觉检测命中'),
        `the task result must carry the hallucination list for audit, got: ${JSON.stringify(after.result)}`,
      );
      assert.ok(String(after.result).includes(PHANTOM));
    },
  );
});

test('a clean worker reply still completes the task', async () => {
  const task = taskBoard.createTask({ description: 'bp20 worker: clean reply' });

  await withStubModule(
    path.join(SRC, 'cli/ai'),
    { chat: () => new Promise((r) => setTimeout(() => r({ reply: CLEAN_REPLY }), 60)) },
    async () => {
      const worker = await workerAgent.spawnWorker('只读盘点', { role: 'general', taskId: task.id });
      await waitForWorker(worker.id);

      const after = taskBoard.getTask(task.id);
      assert.strictEqual(after.status, taskBoard.STATUS.DONE, 'a clean reply must still land done');
      assert.ok(String(after.result).includes('SUMMARY'));
    },
  );
});

test.after(() => {
  taskBoard.closeDb();
  try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
