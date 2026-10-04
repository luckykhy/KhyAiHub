/**
 * workflowExecutor.expand.test.js — D1「动态扇出」（`expand`）的行为契约
 * （`[DESIGN-ARCH-141]` §5-D1 / §12.9；规则 `TOOLING-011`）。
 *
 * 用 `node:test` 而非 jest：`services/backend/jest.config.js` 会按
 * `require('node:test')` 标记自动忽略本文件，故它由 `node --test` 运行。
 *
 * ## 为什么必须有这一组测试
 *
 * `expand` 的两类静默失真：
 *  1. **份数不对**：`sourceVar` 是数组，但内联份数与它无关 —— 图照样跑完、报 completed。
 *  2. **元素绑错**：所有副本共享同一个 `vars`；若只在 `expand` 里写一次 `itemVar`，
 *     N 份看到的都会是**最后一个**元素。这同样不会报错。
 *
 * 故核心判据是 **「每一份都真的被执行、且各自看到自己的元素」**，而不是「补丁被接受」。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const executor = require('../src/services/domain/project/workflow/workflowExecutor');
const { copyId, BIND_FIELD } = require('../src/services/domain/project/workflow/expandTemplate');

/** 模板：ts -> tp -> te。tp 把 {{cur}} 插进 prompt ⇒ 用 seen 就能看出每份绑到了什么。 */
function makeTemplate() {
  return {
    nodes: [
      { id: 'ts', type: 'start', data: {} },
      { id: 'tp', type: 'prompt', data: { prompt: 'p-{{cur}}', outputVar: 'last' } },
      { id: 'te', type: 'end', data: {} },
    ],
    connections: [
      { from: 'ts', fromPort: 'default', to: 'tp', toPort: 'input' },
      { from: 'tp', fromPort: 'default', to: 'te', toPort: 'input' },
    ],
  };
}

/** 主图：s -> ex -> e，ex 是 expand 节点。 */
function makeGraph(data = {}) {
  return {
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 'ex', type: 'expand', data },
      { id: 'e', type: 'end', data: {} },
    ],
    connections: [
      { from: 's', fromPort: 'default', to: 'ex', toPort: 'input' },
      { from: 'ex', fromPort: 'default', to: 'e', toPort: 'input' },
    ],
  };
}

function mockPrimitives(over = {}) {
  const seen = [];
  const base = {
    seen,
    async chat(p) {
      seen.push(p);
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
    async loadFlow() {
      return makeTemplate();
    },
  };
  return { ...base, ...over };
}

// ── 核心判据：每一份都真的执行，且各自看到自己的元素 ─────────────────────────

test('★ 3 份副本每一份都真的被执行，且各自看到自己的 itemVar（不能只测「补丁被接受」）', async () => {
  const prim = mockPrimitives();
  const res = await executor.runGraph(makeGraph({ templateId: 'tpl', sourceVar: 'items', itemVar: 'cur' }), {
    primitives: prim,
    vars: { items: ['a', 'b', 'c'] },
  });

  assert.strictEqual(res.status, 'completed');
  // ★ 关键断言：三份的副作用都在，且顺序与内容逐份对应
  assert.deepStrictEqual(
    prim.seen,
    ['p-a', 'p-b', 'p-c'],
    `每份必须看到自己的元素（实得：${JSON.stringify(prim.seen)}）`
  );

  // 三份是**三个不同的节点**（内联而非复用）
  const visited = res.log.map((l) => l.nodeId);
  for (const i of [0, 1, 2]) {
    const id = copyId('ex', i, 'tp');
    assert.ok(visited.includes(id), `副本 ${id} 必须被执行（实到：${visited.join(' -> ')}）`);
  }

  // 审计：expand 节点必须留下 expand 记录
  const exEntry = res.log.find((l) => l.nodeId === 'ex');
  assert.ok(exEntry && exEntry.expand, 'expand 节点必须留下 expand 审计');
  assert.strictEqual(exEntry.expand.instances, 3);
  assert.strictEqual(exEntry.expand.templateId, 'tpl');
  assert.strictEqual(exEntry.expand.sourceVar, 'items');
  assert.notStrictEqual(exEntry.expand.beforeHash, exEntry.expand.afterHash);
});

test('对照：份数真的由 sourceVar 决定（1 份 ⇒ 只跑 1 份）', async () => {
  const prim = mockPrimitives();
  const res = await executor.runGraph(makeGraph({ templateId: 'tpl', sourceVar: 'items', itemVar: 'cur' }), {
    primitives: prim,
    vars: { items: ['only'] },
  });
  assert.strictEqual(res.status, 'completed');
  assert.deepStrictEqual(prim.seen, ['p-only'], '1 份就只应执行 1 份');
  const exEntry = res.log.find((l) => l.nodeId === 'ex');
  assert.strictEqual(exEntry.expand.instances, 1);
});

test('空集合：0 份 ⇒ expand 退场，游标直达原后继，不内联任何节点', async () => {
  const prim = mockPrimitives();
  const res = await executor.runGraph(makeGraph({ templateId: 'tpl', sourceVar: 'items', itemVar: 'cur' }), {
    primitives: prim,
    vars: { items: [] },
  });
  assert.strictEqual(res.status, 'completed', '空集合不是错误，run 应正常收尾');
  assert.deepStrictEqual(prim.seen, [], '0 份不应执行任何副本');
  const exEntry = res.log.find((l) => l.nodeId === 'ex');
  assert.strictEqual(exEntry.expand.instances, 0);
  // 没有任何副本节点
  assert.ok(!res.log.some((l) => String(l.nodeId).startsWith('ex__')), '0 份不应有副本节点');
});

// ── 应拦方向 ────────────────────────────────────────────────────────────────

test('sourceVar 不是数组 ⇒ 拒绝执行（fail-closed）', async () => {
  await assert.rejects(
    () =>
      executor.runGraph(makeGraph({ templateId: 'tpl', sourceVar: 'items', itemVar: 'cur' }), {
        primitives: mockPrimitives(),
        vars: { items: 'not-an-array' },
      }),
    /必须是数组/
  );
  await assert.rejects(
    () =>
      executor.runGraph(makeGraph({ templateId: 'tpl', sourceVar: 'missing', itemVar: 'cur' }), {
        primitives: mockPrimitives(),
        vars: {},
      }),
    /必须是数组/
  );
});

test('缺 sourceVar / 缺 templateId ⇒ 拒绝执行', async () => {
  await assert.rejects(
    () =>
      executor.runGraph(makeGraph({ templateId: 'tpl' }), {
        primitives: mockPrimitives(),
        vars: { items: ['a'] },
      }),
    /需要 sourceVar/
  );
  await assert.rejects(
    () =>
      executor.runGraph(makeGraph({ sourceVar: 'items' }), {
        primitives: mockPrimitives(),
        vars: { items: ['a'] },
      }),
    /需要 templateId/
  );
});

test('模板加载失败 ⇒ 拒绝执行（绝不「少跑几份」）', async () => {
  await assert.rejects(
    () =>
      executor.runGraph(makeGraph({ templateId: 'ghost', sourceVar: 'items', itemVar: 'cur' }), {
        primitives: mockPrimitives({
          async loadFlow() {
            throw new Error("expand 的 templateId 'ghost' 无法加载: 流程不存在");
          },
        }),
        vars: { items: ['a'] },
      }),
    /无法加载/
  );
});

test('模板非单入口 ⇒ 拒绝执行（多入口没有唯一可接的位置）', async () => {
  const multiEntry = {
    nodes: [
      { id: 'ts', type: 'start', data: {} },
      { id: 'a', type: 'prompt', data: {} },
      { id: 'b', type: 'prompt', data: {} },
      { id: 'te', type: 'end', data: {} },
    ],
    connections: [
      { from: 'ts', fromPort: 'default', to: 'a', toPort: 'input' },
      { from: 'ts', fromPort: 'default', to: 'b', toPort: 'input' },
      { from: 'a', fromPort: 'default', to: 'te', toPort: 'input' },
      { from: 'b', fromPort: 'default', to: 'te', toPort: 'input' },
    ],
  };
  await assert.rejects(
    () =>
      executor.runGraph(makeGraph({ templateId: 'tpl', sourceVar: 'items', itemVar: 'cur' }), {
        primitives: mockPrimitives({ async loadFlow() { return multiEntry; } }),
        vars: { items: ['a'] },
      }),
    /单入口/
  );
});

test('模板双出口（两个 end）⇒ 拒绝执行', async () => {
  const twoEnds = {
    nodes: [
      { id: 'ts', type: 'start', data: {} },
      { id: 'a', type: 'prompt', data: {} },
      { id: 'e1', type: 'end', data: {} },
      { id: 'e2', type: 'end', data: {} },
    ],
    connections: [
      { from: 'ts', fromPort: 'default', to: 'a', toPort: 'input' },
      { from: 'a', fromPort: 'default', to: 'e1', toPort: 'input' },
      { from: 'a', fromPort: 'default', to: 'e2', toPort: 'input' },
    ],
  };
  await assert.rejects(
    () =>
      executor.runGraph(makeGraph({ templateId: 'tpl', sourceVar: 'items', itemVar: 'cur' }), {
        primitives: mockPrimitives({ async loadFlow() { return twoEnds; } }),
        vars: { items: ['a'] },
      }),
    /恰好有一个 end|单出口/
  );
});

test('超出节点上限 ⇒ 拒绝执行，且图不被改动（事务性）', async () => {
  const graph = makeGraph({ templateId: 'tpl', sourceVar: 'items', itemVar: 'cur' });
  const snapshot = JSON.stringify(graph);
  const items = new Array(300).fill(0).map((_, i) => i);
  await assert.rejects(
    () =>
      executor.runGraph(graph, {
        primitives: mockPrimitives(),
        vars: { items },
      }),
    /超出上限/
  );
  assert.strictEqual(JSON.stringify(graph), snapshot, '被拒后原图必须逐字段不变');
});

// ── 逐份绑定的机制本身 ──────────────────────────────────────────────────────

test('副本入口节点必须带 __bind 标记（逐份绑定的机制，而非「expand 里写一次」）', async () => {
  const prim = mockPrimitives();
  const res = await executor.runGraph(makeGraph({ templateId: 'tpl', sourceVar: 'items', itemVar: 'cur' }), {
    primitives: prim,
    vars: { items: ['x', 'y'] },
  });
  // 用日志间接验证：两份的 prompt 各不同 ⇒ 绑定确实发生在「进每一份」的时候
  assert.deepStrictEqual(prim.seen, ['p-x', 'p-y']);
  assert.strictEqual(res.vars.cur, 'y', '最后一份的绑定值留在 vars（逐份覆盖，非一次写死）');
  assert.strictEqual(res.vars.last, 'chat:p-y');
});

test('itemVar 默认值为 item', async () => {
  const tpl = makeTemplate();
  tpl.nodes.find((n) => n.id === 'tp').data.prompt = 'q-{{item}}';
  const prim = mockPrimitives({
    async loadFlow() {
      return tpl;
    },
  });
  const res = await executor.runGraph(makeGraph({ templateId: 'tpl', sourceVar: 'items' }), {
    primitives: prim,
    vars: { items: ['m'] },
  });
  assert.strictEqual(res.status, 'completed');
  assert.deepStrictEqual(prim.seen, ['q-m'], 'itemVar 缺省应为 item');
  assert.strictEqual(BIND_FIELD, '__bind');
});
