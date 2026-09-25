/**
 * workflowExecutor.failClosed.test.js — 未知节点类型必须 fail-closed
 * （规则 `TOOLING-011` / `[DESIGN-ARCH-141]` §6 F2 + F3）。
 *
 * 用 `node:test` 而非 jest：`services/backend/jest.config.js` 会按
 * `require('node:test')` 标记自动忽略本文件，故它由 `npm run test:node`
 * 运行，两个 runner 保持分离。
 *
 * 为什么这条必须有独立测试：旧行为是**静默跳过**未知节点类型并让整图报
 * `completed` —— 没有测试断言它，所以它能长期潜伏。fail-closed 是行为契约，
 * 必须双向钉住：未知类型**必须抛**、已知类型**必须放行**。
 */
// ⚠ 本文件用 zzUndeclaredProbeType 作为「未在 nodeCatalog 声明」的替身。
// 它必须**永不与真实目录撞名** —— 2026-09-24 实测踩过：原先用的是 expand，
// 真实目录声明 expand 后，这两条测试的「未知类型」前提失效、直接变红。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const executor = require('../src/services/domain/project/workflow/workflowExecutor');
const worker = require('../src/services/domain/project/workflow/workflowRunWorker');

function mockPrimitives(over = {}) {
  return {
    async chat(p) {
      return `chat:${p}`;
    },
    async executeTool() {
      return 'tool-ok';
    },
    async executeSkill() {
      return 'skill-ok';
    },
    async runSubAgent() {
      return 'subagent-ok';
    },
    async runCode() {
      return 'code-ok';
    },
    async http() {
      return { status: 200, data: 'http-ok' };
    },
    ...over,
  };
}

// ── F2：未知节点类型 fail-closed ────────────────────────────────────────────

test('未知节点类型抛错，而不是静默跳过并报成功', async () => {
  const graph = {
    nodes: [
      { id: 's', type: 'start' },
      { id: 'x', type: 'zzUndeclaredProbeType', data: {} },
      { id: 'e', type: 'end' },
    ],
    connections: [
      { from: 's', fromPort: 'default', to: 'x', toPort: 'input' },
      { from: 'x', fromPort: 'default', to: 'e', toPort: 'input' },
    ],
  };

  await assert.rejects(
    () => executor.runGraph(graph, { primitives: mockPrimitives() }),
    (err) => {
      assert.match(err.message, /未知节点类型/);
      assert.match(err.message, /zzUndeclaredProbeType/);
      // 失败节点必须落进 log 并标 failed —— 不是 skipped
      const failed = (err.log || []).find((l) => l.nodeId === 'x');
      assert.ok(failed, '失败节点应出现在 log 里');
      assert.strictEqual(failed.status, 'failed');
      assert.notStrictEqual(failed.status, 'skipped');
      return true;
    }
  );
});

// 放行方向对照：只测「会拦」不测「会放行」，等于把判据改成无脑拦也能全绿。
test('全部 12 种已声明节点类型可正常执行（不得被 fail-closed 误伤）', async () => {
  const graph = {
    nodes: [
      { id: 's', type: 'start' },
      { id: 'p', type: 'prompt', data: { prompt: 'P', outputVar: 'p' } },
      { id: 'sa', type: 'subAgent', data: { agentName: 'a', instructions: 'i' } },
      { id: 'sk', type: 'skill', data: { skillName: 'k', args: {} } },
      { id: 'tc', type: 'toolCall', data: { tool: 'T', args: {} } },
      { id: 'cd', type: 'code', data: { language: 'bash', source: 'echo hi' } },
      { id: 'ht', type: 'http', data: { method: 'GET', url: 'http://x' } },
      // graphPatch：只做「加法」——新增一个游离节点，不接线，链路照常往下走。
      // 这样既覆盖了第 12 种类型的放行方向，也钉住「图改写不得打断既有游标」。
      {
        id: 'gp',
        type: 'graphPatch',
        data: { ops: [{ op: 'addNode', node: { id: 'freeX', type: 'prompt', data: {} } }] },
      },
      { id: 'ie', type: 'ifElse', data: { expression: '1 == 1' } },
      { id: 'lp', type: 'loop', data: { mode: 'count', count: 1 } },
      { id: 'tcb', type: 'toolCall', data: { tool: 'T2', args: {} } },
      { id: 'aq', type: 'askUserQuestion', data: { question: 'q', options: ['yes'] } },
      { id: 'e', type: 'end' },
    ],
    connections: [
      { from: 's', fromPort: 'default', to: 'p', toPort: 'input' },
      { from: 'p', fromPort: 'default', to: 'sa', toPort: 'input' },
      { from: 'sa', fromPort: 'default', to: 'sk', toPort: 'input' },
      { from: 'sk', fromPort: 'default', to: 'tc', toPort: 'input' },
      { from: 'tc', fromPort: 'default', to: 'cd', toPort: 'input' },
      { from: 'cd', fromPort: 'default', to: 'ht', toPort: 'input' },
      { from: 'ht', fromPort: 'default', to: 'gp', toPort: 'input' },
      { from: 'gp', fromPort: 'default', to: 'ie', toPort: 'input' },
      { from: 'ie', fromPort: 'branch-true', to: 'lp', toPort: 'input' },
      { from: 'lp', fromPort: 'loop-body', to: 'tcb', toPort: 'input' },
      { from: 'tcb', fromPort: 'default', to: 'lp', toPort: 'input' },
      { from: 'lp', fromPort: 'loop-done', to: 'aq', toPort: 'input' },
      { from: 'aq', fromPort: 'default', to: 'e', toPort: 'input' },
    ],
  };

  const res = await executor.runGraph(graph, { primitives: mockPrimitives() });
  assert.strictEqual(res.status, 'completed');

  const visited = new Set(res.log.map((l) => l.nodeId));
  for (const id of ['s', 'p', 'sa', 'sk', 'tc', 'cd', 'ht', 'gp', 'ie', 'lp', 'tcb', 'aq', 'e']) {
    assert.ok(visited.has(id), `节点 ${id} 应被访问`);
  }
  // 回归：askUserQuestion 的「占位自动答」仍标 skipped —— fail-closed 不得误伤它
  const aq = res.log.find((l) => l.nodeId === 'aq');
  assert.strictEqual(aq.status, 'skipped');
  // 没有任何节点标 failed
  assert.ok(!res.log.some((l) => l.status === 'failed'), '不应有失败节点');
});

// ── F3：worker 侧前置校验 ───────────────────────────────────────────────────

test('worker 前置校验拒绝未声明的节点类型', () => {
  assert.throws(
    () => worker.assertGraphNodeTypes({ nodes: [{ id: 'x', type: 'zzUndeclaredProbeType' }] }),
    /未在 nodeCatalog 声明/
  );
});

test('worker 前置校验放行已声明的节点类型（放行方向对照）', () => {
  assert.doesNotThrow(() =>
    worker.assertGraphNodeTypes({
      nodes: [
        { id: 's', type: 'start' },
        { id: 'e', type: 'end' },
      ],
    })
  );
});

test('worker 前置校验对空图 / 缺 nodes 不抛（不得因形状问题阻断）', () => {
  assert.doesNotThrow(() => worker.assertGraphNodeTypes({}));
  assert.doesNotThrow(() => worker.assertGraphNodeTypes(null));
  assert.doesNotThrow(() => worker.assertGraphNodeTypes({ nodes: [] }));
});
