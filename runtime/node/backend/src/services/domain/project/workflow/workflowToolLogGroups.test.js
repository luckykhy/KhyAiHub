'use strict';

/**
 * Colocated contract test for workflowToolLogGroups.js (producer S4).
 *
 * What is pinned here, and why each pin exists:
 *   ① status mapping — `skipped` / `awaiting_input` are workflow-only states with no member in
 *      the six-state ToolRunStatus vocabulary. Passing them through would make D2 degrade the
 *      whole step to a fallback (family 'other' + status 'error'), i.e. a skipped node would
 *      render as a FAILURE. The mapping is a closed table, and every workflow status the
 *      executor can emit is enumerated against it.
 *   ② node ids are NOT unique in a log — a `loop` node pushes one entry per iteration. Steps
 *      are keyed `<nodeId>#<occurrence>`; deduping by the raw nodeId would silently collapse a
 *      5-iteration loop into one row (a display bug that looks like "the loop ran once").
 *   ③ row order === log order, one row per entry (no merging, no reordering).
 *   ④ the projection is read-only: the caller's log entries are never mutated, and the steps
 *      D2 hands back are decodes of the same data (idempotent re-projection is stable).
 *   ⑤ garbage in → shortest legal projection out, never a throw (display must not be able to
 *      take a run down).
 *   ⑥ the executor wiring is gated: with the gate off the sink is never called, and with the
 *      gate ON the run's own return value is byte-identical to the gate-off run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WORKFLOW_STATUS_MAP,
  mapWorkflowStatus,
  workflowLogToSteps,
  workflowLogToRows,
  workflowLogToGroups,
  projectWorkflowLog,
} = require('./workflowToolLogGroups');
const { runGraph } = require('./workflowExecutor');
const { STATUS_ALIASES, ROW_KIND } = require('../../catalog/toolUseLoop/toolExecutionGroups');

// ── graph fixtures (mirrors tests/workflowExecutor.test.js builders) ─────────

function node(id, type, data = {}, name) {
  return { id, type, name: name || type, position: { x: 0, y: 0 }, data };
}
function edge(id, from, to, fromPort = 'default') {
  return { id, from, to, fromPort };
}
function mockPrimitives(overrides = {}) {
  const base = {
    async chat() { return 'echo'; },
    async executeTool() { return { ok: true }; },
    async executeSkill() { return 'skill'; },
    async runSubAgent() { return 'agent'; },
    async runCode() { return 'ran'; },
    async http() { return { status: 200 }; },
    async loadFlow() { return { nodes: [], connections: [] }; },
  };
  return { ...base, ...overrides };
}

// Gate + fixtures for the wiring tests (⑥). Declared up here, next to the other
// builders, so every helper stays a few lines long.
const GATE = 'KHY_WORKFLOW_TOOL_GROUPS';
const linearGraph = () => ({
  nodes: [
    node('s', 'start'),
    node('p', 'prompt', { prompt: 'hi', outputVar: 'answer' }),
    node('e', 'end'),
  ],
  connections: [edge('e1', 's', 'p'), edge('e2', 'p', 'e')],
});
// One uninterrupted run of the linear graph, serialised for byte comparison.
const readRun = async () => {
  const res = await runGraph(linearGraph(), { primitives: mockPrimitives() });
  return JSON.stringify({ status: res.status, vars: res.vars, log: res.log, pause: res.pause });
};

// ── ① status mapping ────────────────────────────────────────────────────────

test('every status the executor can emit is mapped or deliberately passed through', () => {
  // The exhaustive set of `entry.status` values workflowExecutor.js can push.
  const emitted = ['running', 'succeeded', 'failed', 'skipped', 'awaiting_input'];
  for (const raw of emitted) {
    const mapped = mapWorkflowStatus(raw);
    if (mapped === undefined) continue; // passed through to D2's STATUS_ALIASES
    assert.ok(
      Object.prototype.hasOwnProperty.call(STATUS_ALIASES, mapped.toLowerCase()),
      `mapped ${raw} → ${mapped} must itself be a status D2 knows`
    );
  }
  // The two workflow-only states MUST be mapped (not passed through).
  assert.equal(mapWorkflowStatus('skipped'), 'cancelled');
  assert.equal(mapWorkflowStatus('awaiting_input'), 'pendingApproval');
  assert.equal(mapWorkflowStatus('AWAITING_INPUT'), 'pendingApproval'); // normalization
  assert.equal(mapWorkflowStatus('succeeded'), 'success');
  assert.equal(mapWorkflowStatus('failed'), 'error');
  // Unknown → undefined (D2 decides; this table never guesses a sixth meaning).
  assert.equal(mapWorkflowStatus('quantum-superposed'), undefined);
  assert.equal(mapWorkflowStatus(''), undefined);
  assert.equal(mapWorkflowStatus(null), undefined);
  assert.ok(Object.isFrozen(WORKFLOW_STATUS_MAP));
});

test('a skipped node does not become a failure row', () => {
  const proj = projectWorkflowLog([
    { nodeId: 'a', type: 'askUserQuestion', name: 'ask', status: 'skipped', summary: 'auto' },
  ]);
  assert.equal(proj.rows.length, 1);
  const step = proj.groups[0];
  assert.equal(step.count, 1);
  assert.equal(proj.totals.failed, 0, 'skipped is not a failure');
  assert.equal(proj.totals.succeeded, 0, 'skipped is not a success either');
  // D2 aggregates an all-cancelled group to 'cancelled'.
  assert.equal(proj.groups[0].status, 'cancelled');
});

test('awaiting_input surfaces as unfinished, not as success', () => {
  const proj = projectWorkflowLog([
    { nodeId: 'q', type: 'askUserQuestion', name: 'ask', status: 'awaiting_input' },
  ]);
  assert.equal(proj.totals.unfinished, 1);
  assert.equal(proj.groups[0].status, 'running');
});

// ── ② unique ids across loop iterations ─────────────────────────────────────

test('a loop node appearing N times yields N distinct steps (no id collapse)', () => {
  const log = [];
  for (let i = 1; i <= 5; i += 1) {
    log.push({ nodeId: 'L', type: 'loop', name: 'loop', status: 'succeeded', summary: `迭代 ${i}/5` });
  }
  const steps = workflowLogToSteps(log);
  assert.deepEqual(steps.map((s) => s.id), ['L#1', 'L#2', 'L#3', 'L#4', 'L#5']);
  const proj = projectWorkflowLog(log);
  assert.equal(proj.groups[0].count, 5);
  assert.equal(proj.totals.succeeded, 5);
  assert.equal(proj.rows.length, 5);
});

// ── ③ row order === log order ───────────────────────────────────────────────

test('rows keep the log order, one row per entry', () => {
  const log = [
    { nodeId: 's', type: 'start', status: 'succeeded' },
    { nodeId: 'p', type: 'prompt', status: 'succeeded', summary: 'echo:hi' },
    { nodeId: 'e', type: 'end', status: 'succeeded' },
  ];
  const rows = workflowLogToRows(log);
  assert.deepEqual(rows.map((r) => r.stepId), ['s#1', 'p#1', 'e#1']);
  assert.deepEqual(rows.map((r) => r.kind), ['step', 'step', 'step']);
  assert.ok(ROW_KIND.includes(rows[0].kind));
  assert.deepEqual(rows.map((r) => r.order), [0, 1, 2]);
});

// ── ④ read-only + grouping strategies ───────────────────────────────────────

test('projection never mutates the log it was handed', () => {
  const log = [
    { nodeId: 'a', type: 'prompt', name: 'p', status: 'succeeded', summary: 'x' },
    { nodeId: 'b', type: 'loop', name: 'l', status: 'failed', summary: 'y', error: 'boom' },
  ];
  const before = JSON.stringify(log);
  projectWorkflowLog(log);
  projectWorkflowLog(log, { groupBy: 'type' });
  assert.equal(JSON.stringify(log), before);
});

test('groupBy run (default) is one workflow group; groupBy type splits adjacent same-type runs', () => {
  const log = [
    { nodeId: 'a', type: 'prompt', status: 'succeeded' },
    { nodeId: 'b', type: 'prompt', status: 'succeeded' },
    { nodeId: 'c', type: 'http', status: 'succeeded' },
    { nodeId: 'd', type: 'prompt', status: 'succeeded' },
  ];
  const one = projectWorkflowLog(log);
  assert.equal(one.groups.length, 1);
  assert.equal(one.groups[0].kind, 'workflow');
  assert.equal(one.groups[0].count, 4);

  const split = projectWorkflowLog(log, { groupBy: 'type' });
  assert.equal(split.groups.length, 3, 'prompt×2, http, prompt');
  assert.deepEqual(split.groups.map((g) => g.count), [2, 1, 1]);
  // every step row still resolves to a group (no orphans)
  const ids = new Set(split.groups.flatMap((g) => g.stepIds));
  for (const r of split.rows) assert.ok(ids.has(r.stepId), `row ${r.stepId} lost its group`);
});

test('an injected title lands on the group; the default is empty (D2 must not reach into D1)', () => {
  const log = [{ nodeId: 'a', type: 'prompt', status: 'succeeded' }];
  assert.equal(projectWorkflowLog(log).groups[0].title, '');
  assert.equal(projectWorkflowLog(log, { title: '工作流：抓取行情' }).groups[0].title, '工作流：抓取行情');
  assert.deepEqual(workflowLogToGroups([], 'run', 't')[0].steps, []);
});

// ── ⑤ garbage in ───────────────────────────────────────────────────────────

test('garbage log shapes degrade to a legal projection instead of throwing', () => {
  for (const bad of [null, undefined, 42, 'log', {}, [{}, null, 5, 'x'], [[]]]) {
    const proj = projectWorkflowLog(bad);
    assert.ok(Array.isArray(proj.groups));
    assert.ok(Array.isArray(proj.rows));
    assert.ok(proj.totals && typeof proj.totals === 'object');
  }
  // A status nobody knows degrades that ONE step (D2 fallback), neighbours survive.
  const proj = projectWorkflowLog([
    { nodeId: 'a', type: 'prompt', status: 'succeeded', summary: 'ok' },
    { nodeId: 'b', type: 'http', status: 'teleported' },
    { nodeId: 'c', type: 'end', status: 'succeeded' },
  ]);
  assert.equal(proj.rows.length, 3);
  assert.equal(proj.totals.succeeded, 2);
  assert.equal(proj.totals.failed, 1, 'the unknown-status step degrades, and only it');
});

test('re-projecting an already-projected run is stable (idempotent decode)', () => {
  const log = [
    { nodeId: 'a', type: 'prompt', status: 'succeeded', summary: 'x'.repeat(500) },
    { nodeId: 'b', type: 'end', status: 'succeeded' },
  ];
  const first = projectWorkflowLog(log);
  const second = projectWorkflowLog(log);
  assert.deepEqual(second, first);
  // A >200-byte summary is clipped for display and kept whole in the data model.
  assert.equal(first.groups[0].stepIds.length, 2);
});

// ── ⑥ executor wiring: gated, and byte-identical either way ─────────────────

test('gate OFF (default): the sink is never called and the run is untouched', async () => {
  const prev = process.env[GATE];
  delete process.env[GATE];
  try {
    let called = 0;
    const res = await runGraph(linearGraph(), {
      primitives: mockPrimitives(),
      onLog: () => {},
      onToolGroups: () => { called += 1; },
    });
    assert.equal(called, 0, 'no producer traffic when the gate is off');
    assert.equal(res.status, 'completed');
    assert.equal(res.log.length, 3);
  } finally {
    if (prev === undefined) delete process.env[GATE];
    else process.env[GATE] = prev;
  }
});

test('gate ON: the sink receives a projection and the run result is byte-identical', async () => {
  const prev = process.env[GATE];
  const baseline = await readRun();

  process.env[GATE] = '1';
  try {
    const seen = [];
    const res = await runGraph(linearGraph(), {
      primitives: mockPrimitives(),
      onToolGroups: (proj) => seen.push(proj),
    });
    assert.equal(
      JSON.stringify({ status: res.status, vars: res.vars, log: res.log, pause: res.pause }),
      baseline,
      'the projection producer must not perturb the run it observes'
    );
    assert.ok(seen.length > 0, 'gate on + sink registered ⇒ producer fires');
    const last = seen[seen.length - 1];
    assert.equal(last.groups[0].count, 3, 'start + prompt + end');
    assert.equal(last.totals.succeeded, 3);
    // Without a sink the gate alone changes nothing.
    const quiet = await runGraph(linearGraph(), { primitives: mockPrimitives() });
    assert.equal(
      JSON.stringify({ status: quiet.status, vars: quiet.vars, log: quiet.log, pause: quiet.pause }),
      baseline
    );
  } finally {
    if (prev === undefined) delete process.env[GATE];
    else process.env[GATE] = prev;
  }
});

test('a throwing sink cannot break a run (display-only channel)', async () => {
  const prev = process.env[GATE];
  process.env[GATE] = '1';
  try {
    const res = await runGraph(linearGraph(), {
      primitives: mockPrimitives(),
      onToolGroups: () => { throw new Error('display exploded'); },
    });
    assert.equal(res.status, 'completed');
    assert.equal(res.log.length, 3);
  } finally {
    if (prev === undefined) delete process.env[GATE];
    else process.env[GATE] = prev;
  }
});
