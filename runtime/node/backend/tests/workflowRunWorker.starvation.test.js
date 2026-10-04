'use strict';

/**
 * workflowRunWorker.starvation.test.js — F7 of `[DESIGN-ARCH-141]` §6.
 *
 * F7 (re-stated 2026-09-24, §10.1 Q3 = "不做优先级维度"): the ready queue must
 * NOT have a statically-hardcoded priority dimension, and under CONTINUOUS
 * arrivals every enqueued run's wait must be BOUNDED.
 *
 * The original F7 wording presupposed a `priority` column ("低优 run 的最大等待
 * 上界有限"). There is no priority dimension in the implementation — not in the
 * schema, not in `claimNext` — so that counterexample cannot be constructed at
 * all. Rather than invent a priority mechanism with no consumer, the criterion
 * is restated over what actually exists: FIFO-by-id by default, aging
 * (`updatedAt ASC`) when quantum preemption is on.
 *
 * ⚠ The trap this file must avoid (the doc's own warning): "只测「高优先跑」不测
 * 「低优仍会跑」= 恒真断言". The analogous trap here is asserting only that the
 * NEWEST run runs. Both tests therefore assert the OLDEST run's bounded wait —
 * and `_产物/negctl-f7.js` proves the assertions have teeth by flipping the
 * claim order to `id DESC` (newest-first), which starves the oldest run.
 *
 * Boots a throwaway SQLite DB bound to the shared sequelize singleton BEFORE
 * @khy/shared/models is required, exactly like workflowRunWorker.quantum.test.js.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-workflow-starvation-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.KHY_WORKFLOW_WORKER = '0'; // never auto-start the interval in tests

const { sequelize, User, UserWorkflow, WorkflowRun } = require('@khy/shared/models');
const worker = require('../src/services/domain/project/workflow/workflowRunWorker.js');
const executor = require('../src/services/domain/project/workflow/workflowExecutor.js');

let userId;
let workflowId;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  const u = await User.create({ username: 'f7-alice', email: 'f7-alice@test.local', password: 'pw-123', status: 'active' });
  userId = u.id;
  const wf = await UserWorkflow.create({ userId, name: 'F7', version: 1, graphJson: { nodes: [], connections: [] } });
  workflowId = wf.id;
  jest.spyOn(executor, 'defaultPrimitives').mockReturnValue({
    async chat(prompt) { return `echo:${prompt}`; },
    async executeTool() { return 'tool-ok'; },
    async executeSkill() { return 'skill-ok'; },
    async runSubAgent() { return 'agent-ok'; },
    async runCode() { return 'code-ok'; },
    async http() { return { status: 200, data: 'ok' }; },
  });
});

afterEach(() => { delete process.env.KHY_WORKFLOW_QUANTUM_STEPS; });

afterAll(async () => {
  jest.restoreAllMocks();
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

function n(id, type, data = {}) {
  return { id, type, name: type, position: { x: 0, y: 0 }, data };
}
function e(id, from, to, fromPort = 'default') {
  return { id, from, to, fromPort, toPort: 'input' };
}

/** start -> p1 .. pK -> end  (K+2 nodes; each prompt node is one executor step). */
function linearGraph(k) {
  const nodes = [n('s', 'start')];
  const conns = [];
  let prev = 's';
  for (let i = 1; i <= k; i++) {
    const id = `p${i}`;
    nodes.push(n(id, 'prompt', { prompt: `step ${i} {{ seed }}`, outputVar: `r${i}` }));
    conns.push(e(`c${i}`, prev, id));
    prev = id;
  }
  nodes.push(n('e', 'end'));
  conns.push(e('cend', prev, 'e'));
  return { nodes, connections: conns };
}

async function enqueue(graph, vars = {}) {
  const row = await WorkflowRun.create({
    userId, workflowId, status: 'queued', graphJson: graph, varsJson: vars, logJson: [],
  });
  return row.id;
}

describe('F7 — 无静态优先级维度，持续入队下等待上界有限', () => {
  test('默认配置（FIFO-by-id）：持续入队 5 轮，最老 run 仍在第 1 个 tick 内被认领', async () => {
    await WorkflowRun.destroy({ where: {} }); // isolate from prior tests' rows
    delete process.env.KHY_WORKFLOW_QUANTUM_STEPS;

    const oldestId = await enqueue(linearGraph(1), { seed: 'oldest' });
    const ROUNDS = 5;
    let claimedAt = null;

    for (let round = 1; round <= ROUNDS; round++) {
      // 持续入队：每轮新增一个 run，制造「总有更新的 run 排在后面」的压力。
      // eslint-disable-next-line no-await-in-loop
      await enqueue(linearGraph(1), { seed: `new${round}` });
      // eslint-disable-next-line no-await-in-loop
      await worker.tick();
      if (claimedAt === null) {
        // eslint-disable-next-line no-await-in-loop
        const row = await WorkflowRun.findByPk(oldestId);
        if (row.status !== 'queued') {
          claimedAt = round;
        }
      }
    }

    // ★ 上界 = 1：最低 id 先被认领。持续入队**不**改变这一点。
    // 反向对照（id DESC）下 claimedAt 恒为 null ⇒ 此断言必红。
    expect(claimedAt).toBe(1);

    // 且无饿死：再 tick 足够多次后，没有任何 run 留在 queued。
    for (let i = 0; i < ROUNDS + 2; i++) {
      // eslint-disable-next-line no-await-in-loop
      await worker.tick();
    }
    const stillQueued = await WorkflowRun.count({ where: { status: 'queued' } });
    expect(stillQueued).toBe(0);
    const succeeded = await WorkflowRun.count({ where: { status: 'succeeded' } });
    expect(succeeded).toBe(ROUNDS + 1); // oldest + 5 new
  });

  test('quantum 开（老化路径）：持续入队时 yield 的长 run 相邻两次被认领间隔有界', async () => {
    await WorkflowRun.destroy({ where: {} }); // isolate from prior tests' rows
    process.env.KHY_WORKFLOW_QUANTUM_STEPS = '1';

    // 长 run：6 个节点 ⇒ 在 quantum=1 下会多次 yield 并让出回合。
    const longId = await enqueue(linearGraph(4), { seed: 'long' });

    const claimedRounds = [];
    const ROUNDS = 6;
    for (let round = 1; round <= ROUNDS; round++) {
      // eslint-disable-next-line no-await-in-loop
      await enqueue(linearGraph(0), { seed: `s${round}` }); // 持续入队短 run
      // eslint-disable-next-line no-await-in-loop
      const before = (await WorkflowRun.findByPk(longId)).logJson.length;
      // eslint-disable-next-line no-await-in-loop
      await worker.tick();
      // eslint-disable-next-line no-await-in-loop
      const after = (await WorkflowRun.findByPk(longId)).logJson.length;
      // 「被认领」以**执行了一个节点**为准（yield 后 status 回到 queued，看状态认不出）。
      if (after > before) {
        claimedRounds.push(round);
      }
    }

    // ★ 长 run 必须被周期性认领 —— 而不是被持续到达的短 run 无限推后。
    expect(claimedRounds.length).toBeGreaterThanOrEqual(2);
    expect(claimedRounds[0]).toBeLessThanOrEqual(2); // 第一轮或第二轮内即被认领
    for (let i = 1; i < claimedRounds.length; i++) {
      expect(claimedRounds[i] - claimedRounds[i - 1]).toBeLessThanOrEqual(2); // 间隔有界
    }

    // 且无饿死：所有 run（含长 run）最终都跑到终态。
    let guard = 0;
    while ((await WorkflowRun.count({ where: { status: 'queued' } })) > 0 && guard < 80) {
      // eslint-disable-next-line no-await-in-loop
      await worker.tick();
      guard += 1;
    }
    expect(guard).toBeLessThan(80); // 真的收敛了，不是撞上护栏
    const long = await WorkflowRun.findByPk(longId);
    expect(long.status).toBe('succeeded');
    expect(long.pendingJson).toBeNull();
    expect(long.logJson.map((l) => l.nodeId)).toEqual(['s', 'p1', 'p2', 'p3', 'p4', 'e']);
  });

  test('F7 前提自检：调度器确实不含静态优先级维度（无 priority 排序键）', async () => {
    // 这条是「不得静态写死」的可判定形式：源码里不得出现按 priority 排序。
    // 它同时是 F7 重述的前提 —— 若有人日后引入优先级，这条会红，强制其回来重述判据。
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'domain', 'project', 'workflow', 'workflowRunWorker.js'),
      'utf8'
    );
    expect(src).not.toMatch(/priority/i);
    // 反向：默认排序键必须是 id ASC（FIFO），quantum 开时是 updatedAt ASC（老化）。
    expect(src).toContain(": [['id', 'ASC']]");
    expect(src).toContain("['updatedAt', 'ASC']");
  });
});
