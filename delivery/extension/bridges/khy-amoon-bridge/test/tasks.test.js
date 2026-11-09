'use strict';

/**
 * tasks.test.js — durable async task queue, no ADB and no device.
 *
 * Covered:
 *   - submit -> running -> done, result persisted to disk
 *   - failure carries a code/message
 *   - cancel pending and cancel running (AbortSignal)
 *   - restart recovery: pending resumes, running becomes failed/abandoned
 *   - concurrency is configurable (default 1)
 *   - oversized results are replaced by a truncation marker
 *   - stop() finalizes running tasks so a restart never re-runs them
 *   - list/get filters and atomic persistence (no .tmp leftovers)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTaskQueue, TASK_STATES } = require('../lib/tasks');
const C = require('../lib/contracts');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoon-tasks-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(predicate, { timeoutMs = 2000, pollMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('submit runs to done and persists the result', async (t) => {
  const dir = tempDir(t);
  const q = createTaskQueue({
    stateDir: dir,
    runner: async (task) => ({ answer: 42, tool: task.tool }),
  });

  const task = q.submit({ tool: 'khy.ask', args: { question: 'hi' } });
  assert.ok(C.isValidId(task.id));
  assert.ok([TASK_STATES.PENDING, TASK_STATES.RUNNING].includes(task.state));

  assert.equal(await q.whenIdle(), true);
  const done = q.get(task.id);
  assert.equal(done.state, TASK_STATES.DONE);
  assert.deepEqual(done.result, { answer: 42, tool: 'khy.ask' });
  assert.equal(done.error, null);
  assert.ok(done.started_at);
  assert.ok(done.finished_at);

  const file = path.join(dir, 'tasks', `task_${task.id}.json`);
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted.state, 'done');
  assert.deepEqual(persisted.result, { answer: 42, tool: 'khy.ask' });

  const leftovers = fs.readdirSync(path.join(dir, 'tasks')).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'atomic writes must not leave .tmp files');
});

test('runner failure becomes failed with a code and message', async (t) => {
  const dir = tempDir(t);
  const q = createTaskQueue({
    stateDir: dir,
    runner: async () => {
      throw new C.BridgeError('timeout', '模型超时');
    },
  });

  const task = q.submit({ tool: 'khy.ask', args: { question: 'slow' } });
  await q.whenIdle();

  const failed = q.get(task.id);
  assert.equal(failed.state, TASK_STATES.FAILED);
  assert.equal(failed.error.code, 'timeout');
  assert.equal(failed.error.message, '模型超时');
});

test('cancel stops a pending task without running it', async (t) => {
  const dir = tempDir(t);
  const g = gate();
  let runs = 0;
  const q = createTaskQueue({
    stateDir: dir,
    concurrency: 1,
    runner: async () => {
      runs += 1;
      await g.promise;
      return { ok: true };
    },
  });

  const first = q.submit({ tool: 'khy.ask', args: { n: 1 } });
  assert.equal(await waitFor(() => q.get(first.id).state === TASK_STATES.RUNNING), true);
  const second = q.submit({ tool: 'khy.ask', args: { n: 2 } });
  assert.equal(q.get(second.id).state, TASK_STATES.PENDING);

  const cancelled = q.cancel(second.id);
  assert.equal(cancelled.cancelled, true);
  assert.equal(q.get(second.id).state, TASK_STATES.CANCELLED);
  assert.equal(q.get(second.id).error.code, 'cancelled');

  g.release();
  await q.whenIdle();
  assert.equal(runs, 1, 'the cancelled task must never reach the runner');
  assert.equal(q.get(first.id).state, TASK_STATES.DONE);

  assert.deepEqual(q.cancel(second.id), {
    cancelled: false,
    reason: 'already_terminal',
    state: 'cancelled',
    task: q.get(second.id),
  });
  assert.equal(q.cancel('doesnotexist').cancelled, false);
});

test('cancel aborts a running task and it ends cancelled', async (t) => {
  const dir = tempDir(t);
  const q = createTaskQueue({
    stateDir: dir,
    runner: (task, { signal }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ late: true }), 5000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason || new Error('aborted'));
          },
          { once: true }
        );
      }),
  });

  const task = q.submit({ tool: 'khy.ask', args: { question: 'long' } });
  assert.equal(await waitFor(() => q.get(task.id).state === TASK_STATES.RUNNING), true);

  const result = q.cancel(task.id);
  assert.equal(result.cancelled, true);
  assert.equal(await q.whenIdle(), true);
  const record = q.get(task.id);
  assert.equal(record.state, TASK_STATES.CANCELLED);
  assert.equal(record.error.code, 'cancelled');
});

test('restart recovery resumes pending tasks and abandons running ones', async (t) => {
  const dir = tempDir(t);
  const tasksDir = path.join(dir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const base = {
    v: 1,
    tool: 'khy.ask',
    args: { question: 'x' },
    created_at: new Date(Date.now() - 1000).toISOString(),
    updated_at: new Date(Date.now() - 1000).toISOString(),
    started_at: null,
    finished_at: null,
    attempts: 0,
    timeout_ms: 10000,
    principal: null,
    meta: null,
    result: null,
    error: null,
  };
  fs.writeFileSync(
    path.join(tasksDir, 'task_pending0001.json'),
    `${JSON.stringify({ ...base, id: 'pending0001', state: 'pending' })}\n`
  );
  fs.writeFileSync(
    path.join(tasksDir, 'task_running0001.json'),
    `${JSON.stringify({ ...base, id: 'running0001', state: 'running', started_at: base.created_at })}\n`
  );

  const ran = [];
  const q = createTaskQueue({
    stateDir: dir,
    runner: async (task) => {
      ran.push(task.id);
      return { resumed: true };
    },
  });
  const started = q.start();
  assert.equal(started.recovered.resumed, 1);
  assert.equal(started.recovered.abandoned, 1);

  await q.whenIdle();
  assert.deepEqual(ran, ['pending0001']);
  assert.equal(q.get('pending0001').state, TASK_STATES.DONE);
  const abandoned = q.get('running0001');
  assert.equal(abandoned.state, TASK_STATES.FAILED);
  assert.equal(abandoned.error.code, 'abandoned');
});

test('concurrency is configurable and default is one worker', async (t) => {
  const dir = tempDir(t);
  let active = 0;
  let maxActive = 0;
  const q = createTaskQueue({
    stateDir: dir,
    concurrency: 2,
    runner: async (task) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { n: task.args.n };
    },
  });
  for (let i = 0; i < 5; i += 1) q.submit({ tool: 'job', args: { n: i } });
  await q.whenIdle();
  assert.equal(maxActive, 2);
  assert.equal(q.status().counts.done, 5);

  const dir2 = path.join(dir, 'single');
  let active2 = 0;
  let max2 = 0;
  const q2 = createTaskQueue({
    stateDir: dir2,
    runner: async () => {
      active2 += 1;
      max2 = Math.max(max2, active2);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active2 -= 1;
      return true;
    },
  });
  for (let i = 0; i < 3; i += 1) q2.submit({ tool: 'job', args: {} });
  await q2.whenIdle();
  assert.equal(max2, 1, 'default concurrency is 1');
});

test('oversized results are replaced by a truncation marker', async (t) => {
  const dir = tempDir(t);
  const q = createTaskQueue({
    stateDir: dir,
    maxResultBytes: 100,
    runner: async () => ({ blob: 'x'.repeat(5000) }),
  });
  const task = q.submit({ tool: 'job', args: {} });
  await q.whenIdle();
  const record = q.get(task.id);
  assert.equal(record.state, TASK_STATES.DONE);
  assert.equal(record.result.truncated, true);
  assert.ok(record.result.bytes > 100);
});

test('stop finalizes running tasks so a restart does not re-run them', async (t) => {
  const dir = tempDir(t);
  const q = createTaskQueue({
    stateDir: dir,
    runner: () => new Promise(() => {}),
  });
  const task = q.submit({ tool: 'job', args: {} });
  assert.equal(await waitFor(() => q.get(task.id).state === TASK_STATES.RUNNING), true);

  q.stop();
  const stopped = q.get(task.id);
  assert.equal(stopped.state, TASK_STATES.FAILED);
  assert.equal(stopped.error.code, 'abandoned');

  let reran = false;
  const q2 = createTaskQueue({
    stateDir: dir,
    runner: async () => {
      reran = true;
      return true;
    },
  });
  q2.start();
  await q2.whenIdle();
  assert.equal(reran, false);
  assert.equal(q2.get(task.id).state, TASK_STATES.FAILED);
});

test('list/get filters, counts, and invalid inputs', async (t) => {
  const dir = tempDir(t);
  const q = createTaskQueue({
    stateDir: dir,
    runner: async (task) => ({ tool: task.tool }),
  });
  const a = q.submit({ tool: 'khy.ask', args: {} });
  const b = q.submit({ tool: 'job', args: {} });
  const c = q.submit({ tool: 'khy.ask', args: {} });
  await q.whenIdle();

  const all = q.list({});
  assert.equal(all.total, 3);
  assert.equal(all.counts.done, 3);
  assert.equal(all.tasks.length, 3);

  const asks = q.list({ tool: 'khy.ask' });
  assert.equal(asks.total, 2);
  assert.deepEqual(new Set(asks.tasks.map((x) => x.id)), new Set([a.id, c.id]));

  const page = q.list({ limit: 2 });
  assert.equal(page.tasks.length, 2);
  assert.equal(page.total, 3);

  assert.equal(q.get('bad id!'), null);
  assert.equal(q.get('doesnotexist'), null);
  assert.throws(() => q.list({ state: 'nope' }), /未知任务状态/);
  assert.throws(() => q.submit({ tool: 'bad tool!' }), /工具名/);
  assert.throws(() => q.submit({ tool: 'job', args: [] }), /args/);

  const cancelled = q.cancel(b.id);
  assert.equal(cancelled.cancelled, false);
  assert.equal(cancelled.reason, 'already_terminal');
});

test('a queue without a runner fails tasks with not_implemented', async (t) => {
  const dir = tempDir(t);
  const q = createTaskQueue({ stateDir: dir });
  const task = q.submit({ tool: 'khy.ask', args: {} });
  await q.whenIdle();
  const record = q.get(task.id);
  assert.equal(record.state, TASK_STATES.FAILED);
  assert.equal(record.error.code, 'not_implemented');
});
