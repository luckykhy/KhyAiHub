'use strict';
// Co-located unit test for ./workflowRunWorker.js — batch B31 (D2 functional-unit conformance).
// The queue-consumer exposes injectable seams: claimNext(WorkflowRun),
// recoverStale(WorkflowRun) and executeRun(run) all take FAKE model / row objects, so
// no database, no sockets and no child processes are touched. executeRun drives
// runGraph over start/end/ifElse/ask graphs ONLY (those node types invoke no
// primitive, so executor.defaultPrimitives' lazy real-channel closures are never
// reached). tick() and start() are deliberately NOT exercised: they call getModel()
// (which boots @khy/shared/models against a real DB) and start() opens a repeating
// setInterval — neither has an injection seam. That un-injectability is registered
// as a defect (B31-W10), not worked around here. No timers are created.
// Pure node:test; async tests await already-resolved fakes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wf-'));
process.env.KHY_APP_HOME = TMP_HOME;
process.env.KHY_DATA_HOME = TMP_HOME;
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;
// Keep STALE_RUN_MS at its 180000 default (do NOT set KHY_WORKFLOW_STALE_MS), and
// leave KHY_WORKFLOW_WORKER unset so isEnabled() defaults true without any polling.

const w = require('./workflowRunWorker.js');

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

// ── surface ───────────────────────────────────────────────────────────────────

test('exported surface is exactly the documented 9 keys', () => {
  assert.deepEqual(Object.keys(w).sort(), [
    'assertGraphNodeTypes',
    'claimNext',
    'executeRun',
    'getStatus',
    'isBusy',
    'recoverStale',
    'start',
    'stop',
    'tick',
  ]);
});

test('isBusy() is false when no tick has been started (worker never armed)', () => {
  assert.equal(w.isBusy(), false);
});

test('getStatus() reports enabled from KHY_WORKFLOW_WORKER without arming the poller', () => {
  assert.equal(withEnv('KHY_WORKFLOW_WORKER', undefined, () => w.getStatus().enabled), true);
  assert.equal(withEnv('KHY_WORKFLOW_WORKER', '0', () => w.getStatus().enabled), false);
  assert.equal(withEnv('KHY_WORKFLOW_WORKER', 'false', () => w.getStatus().enabled), false);
  assert.equal(withEnv('KHY_WORKFLOW_WORKER', 'banana', () => w.getStatus().enabled), true);
  const status = w.getStatus();
  assert.equal(typeof status.ticks, 'number');
  assert.equal(status.started, false); // never start()ed in this process
});

// ── assertGraphNodeTypes ───────────────────────────────────────────────────────

test('assertGraphNodeTypes: accepts catalog types, rejects undeclared ones, tolerates empty', () => {
  assert.doesNotThrow(() => w.assertGraphNodeTypes({ nodes: [{ type: 'start' }, { type: 'end' }], connections: [] }));
  assert.doesNotThrow(() => w.assertGraphNodeTypes(null));
  assert.throws(
    () => w.assertGraphNodeTypes({ nodes: [{ id: 'x', type: 'teleport' }] }),
    /未在 nodeCatalog 声明的节点类型: teleport/
  );
});

// ── claimNext (atomic claim over an injected fake model) ──────────────────────

test('claimNext: returns null when there is no queued candidate', async () => {
  const model = {
    async findOne() {
      return null;
    },
    async update() {
      throw new Error('update should not be called');
    },
  };
  assert.equal(await w.claimNext(model), null);
});

test('claimNext: claims the candidate (FIFO by id when quantum is off) and re-reads it', async () => {
  let findOneArgs = null;
  let updateArgs = null;
  const instance = { id: 7, status: 'running' };
  const model = {
    async findOne(opts) {
      findOneArgs = opts;
      return { id: 7 };
    },
    async update(vals, where) {
      updateArgs = [vals, where];
      return [1]; // one row affected -> claim won
    },
    async findByPk(id) {
      assert.equal(id, 7);
      return instance;
    },
  };
  const claimed = await w.claimNext(model);
  assert.equal(claimed, instance);
  assert.deepEqual(findOneArgs.where, { status: 'queued' });
  assert.deepEqual(findOneArgs.order, [['id', 'ASC']]);
  // atomic guard: update flips queued -> running only for that id while still queued
  assert.equal(updateArgs[0].status, 'running');
  assert.deepEqual(updateArgs[1].where, { id: 7, status: 'queued' });
});

test('claimNext: returns null when the atomic update loses the race (0 affected)', async () => {
  const model = {
    async findOne() {
      return { id: 3 };
    },
    async update() {
      return [0]; // another worker grabbed it first
    },
    async findByPk() {
      throw new Error('findByPk should not run after a lost race');
    },
  };
  assert.equal(await w.claimNext(model), null);
});

test('claimNext: quantum ON switches ready-queue ordering to updatedAt-first (round-robin)', async () => {
  let findOneArgs = null;
  const model = {
    async findOne(opts) {
      findOneArgs = opts;
      return { id: 1 };
    },
    async update() {
      return [1];
    },
    async findByPk() {
      return { id: 1 };
    },
  };
  withEnv('KHY_WORKFLOW_QUANTUM_STEPS', '5', async () => {
    await w.claimNext(model);
  });
  assert.deepEqual(findOneArgs.order, [['updatedAt', 'ASC'], ['id', 'ASC']]);
});

// ── recoverStale (crash recovery over an injected fake model) ──────────────────

test('recoverStale: re-queues stale & never-heartbeat rows, skips live rows', async () => {
  const old = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(); // 10h ago >> 180s
  const recent = new Date().toISOString();
  const rows = [
    { id: 1, updatedAt: old, logJson: [] }, // orphan -> recover
    { id: 2, updatedAt: recent, logJson: [] }, // live heartbeat -> skip
    { id: 3, updatedAt: null, logJson: [] }, // no heartbeat -> recover
  ];
  const updated = [];
  const model = {
    async findAll(opts) {
      assert.deepEqual(opts.where, { status: 'running' });
      return rows;
    },
    async update(vals, where) {
      updated.push([vals, where]);
      return [1];
    },
  };
  const recovered = await w.recoverStale(model);
  assert.equal(recovered, 2);
  // Recovered rows are exactly the orphan (id 1) and the never-heartbeat row (id 3);
  // the live row (id 2) is skipped. Sequelize options nest the guard under `where`.
  const ids = updated.map(([, opts]) => opts.where.id).sort();
  assert.deepEqual(ids, [1, 3]);
  for (const [vals, opts] of updated) {
    assert.equal(vals.status, 'queued');
    assert.equal(vals.startedAt, null);
    assert.equal(opts.where.status, 'running'); // atomic: only while still running
    assert.ok(vals.logJson.some((e) => e.status === 'recovered'));
  }
});

test('recoverStale: returns 0 when there are no running rows', async () => {
  const model = {
    async findAll() {
      return [];
    },
  };
  assert.equal(await w.recoverStale(model), 0);
});

// ── executeRun (drives runGraph with an injected fake row) ─────────────────────

function fakeRun(over = {}) {
  const patches = [];
  return {
    _patches: patches,
    userId: 'user-1',
    graphJson: null,
    varsJson: {},
    pendingJson: null,
    resumeJson: null,
    logJson: [],
    async update(vals) {
      patches.push(vals);
      return this;
    },
    ...over,
  };
}

function linearGraph(types) {
  const nodes = types.map((t, i) => ({ id: 'n' + i, type: t, data: {} }));
  const connections = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    connections.push({ from: 'n' + i, fromPort: 'default', to: 'n' + (i + 1), toPort: 'input' });
  }
  return { nodes, connections };
}

test('executeRun: a completed start->end run writes status succeeded + a per-node log', async () => {
  const run = fakeRun({ graphJson: linearGraph(['start', 'end']) });
  await w.executeRun(run);
  const last = run._patches[run._patches.length - 1];
  assert.equal(last.status, 'succeeded');
  assert.equal(last.error, null);
  assert.ok(Array.isArray(last.logJson));
  assert.equal(last.logJson.length, 2); // start + end
});

test('executeRun: an undeclared node type fails the row (never silently succeeds)', async () => {
  const run = fakeRun({ graphJson: linearGraph(['start', 'teleport', 'end']) });
  await w.executeRun(run);
  const last = run._patches[run._patches.length - 1];
  assert.equal(last.status, 'failed');
  assert.match(last.error, /未在 nodeCatalog 声明|执行失败/);
});

test('executeRun: askUserQuestion parks the run as awaiting_input with a checkpoint', async () => {
  const run = fakeRun({ graphJson: linearGraph(['start', 'askUserQuestion', 'end']) });
  run.graphJson.nodes[1].data = { question: 'ok?', options: ['yes'], answerVar: 'ans' };
  await w.executeRun(run);
  const last = run._patches[run._patches.length - 1];
  assert.equal(last.status, 'awaiting_input');
  assert.equal(last.pendingJson.nodeId, 'n1');
});

test('executeRun: an answer resume injects the saved answer and completes', async () => {
  const run = fakeRun({ graphJson: linearGraph(['start', 'askUserQuestion', 'end']) });
  run.graphJson.nodes[1].data = { question: 'ok?', options: ['yes'], answerVar: 'ans' };
  run.pendingJson = { nodeId: 'n1', answerVar: 'ans', kind: 'awaiting_input' };
  run.resumeJson = { answer: 'yes' };
  run.logJson = [{ nodeId: 'n1', status: 'awaiting_input' }]; // trailing placeholder
  await w.executeRun(run);
  const last = run._patches[run._patches.length - 1];
  assert.equal(last.status, 'succeeded');
  assert.equal(last.varsJson.ans, 'yes');
});

test('executeRun: quantum preemption re-queues the row (no human input) with a checkpoint', async () => {
  const run = fakeRun({ graphJson: linearGraph(['start', 'ifElse', 'ifElse', 'end']) });
  // give the ifElse nodes a resolvable (true) expression + branch wiring
  const g = run.graphJson;
  g.nodes[1].data = { expression: '1 == 1' };
  g.nodes[2].data = { expression: '1 == 1' };
  g.connections = [
    { from: 'n0', fromPort: 'default', to: 'n1', toPort: 'input' },
    { from: 'n1', fromPort: 'branch-true', to: 'n2', toPort: 'input' },
    { from: 'n1', fromPort: 'branch-false', to: 'n3', toPort: 'input' },
    { from: 'n2', fromPort: 'branch-true', to: 'n3', toPort: 'input' },
    { from: 'n2', fromPort: 'branch-false', to: 'n3', toPort: 'input' },
  ];
  await withEnv('KHY_WORKFLOW_QUANTUM_STEPS', '1', () => w.executeRun(run));
  const last = run._patches[run._patches.length - 1];
  assert.equal(last.status, 'queued'); // yielded, not terminal
  assert.equal(last.pendingJson.kind, 'quantum');
  assert.equal(last.pendingJson.nodeId, 'n1'); // paused right after the start node
});
