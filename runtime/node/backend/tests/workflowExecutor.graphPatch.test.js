/**
 * workflowExecutor.graphPatch.test.js — D1「运行时自演化」的行为契约
 * （`[DESIGN-ARCH-141]` §5-D1；规则 `TOOLING-011`）。
 *
 * 用 `node:test` 而非 jest：`services/backend/jest.config.js` 会按
 * `require('node:test')` 标记自动忽略本文件，故它由 `node --test` 运行。
 *
 * ## 为什么必须有这一组测试
 *
 * 方案 §1.2 的 **G3「图启动即冻结」** 是这样一类缺陷：`runGraph` 在启动时把
 * `nodes` / `connections` 建成两个 `Map`，之后闭包只读。它**不会报错**、不会让任何
 * 守卫变红 —— 你注入一个新节点，运行照常「成功」，只是那个节点**从未被执行**。
 *
 * 所以判据不能是「补丁被接受了」，必须是 **「补丁新增的节点真的跑了」**。
 * 同时必须配「应拦」+「应放行」双向对照：只测拦截方向，等于把判据改成无脑拒绝
 * 也能全绿（恒真断言）。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const executor = require('../src/services/domain/project/workflow/workflowExecutor');
const { applyPatch, MAX_REVISIONS } = require('../src/services/domain/project/workflow/graphPatch');

// The leaf takes catalog capabilities by INJECTION (it never requires nodeCatalog).
const { portsFor, NODE_CATALOG } = require('@khy/shared/workflow/nodeCatalog');
const CAPS = { portsFor, knownTypes: new Set(NODE_CATALOG.map((n) => n.type)) };

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
  };
  return { ...base, ...over };
}

// ── 核心判据：新增的节点必须真的被执行（G3 回归）────────────────────────────

test('graphPatch 新增的节点必须被真的执行，而不是「成功但没跑」（G3 回归）', async () => {
  // 初始图：start → gp，另有游离的 end。gp 尚无出边 ⇒ 补丁补上的边是它的第一条，
  // 于是游标会真的走进新节点（`nextNode` 每个 (from, port) 只认第一条边）。
  const graph = {
    nodes: [
      { id: 's', type: 'start', data: {} },
      {
        id: 'gp',
        type: 'graphPatch',
        data: {
          ops: [
            {
              op: 'addNode',
              node: { id: 'p1', type: 'prompt', data: { prompt: 'hello', outputVar: 'made' } },
            },
            { op: 'connect', from: 'gp', to: 'p1' },
            { op: 'connect', from: 'p1', to: 'e' },
          ],
        },
      },
      { id: 'e', type: 'end', data: {} },
    ],
    connections: [{ from: 's', fromPort: 'default', to: 'gp', toPort: 'input' }],
  };

  const primitives = mockPrimitives();
  const res = await executor.runGraph(graph, { primitives, vars: {} });

  assert.strictEqual(res.status, 'completed');
  // ★ 关键断言：新节点 p1 出现在 log 里，且它的副作用真的发生了
  const visited = res.log.map((l) => l.nodeId);
  assert.ok(visited.includes('p1'), `新增节点 p1 必须被执行（实到：${visited.join(',')}）`);
  assert.strictEqual(res.vars.made, 'chat:hello', '新增 prompt 节点的副作用必须落到 vars');
  assert.deepStrictEqual(primitives.seen, ['hello']);
});

test('空 ops 在执行器层也 fail-closed（不得「成功但什么都没做」）', async () => {
  const graph = {
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 'gp', type: 'graphPatch', data: {} },
      { id: 'e', type: 'end', data: {} },
    ],
    connections: [
      { from: 's', fromPort: 'default', to: 'gp', toPort: 'input' },
      { from: 'gp', fromPort: 'default', to: 'e', toPort: 'input' },
    ],
  };
  await assert.rejects(() => executor.runGraph(graph, { primitives: mockPrimitives() }), /graphPatch refused/);
});

test('graphPatch 节点自身的审计记录落在 log 上（可持久化，零 schema 变更）', async () => {
  const graph = {
    nodes: [
      { id: 's', type: 'start', data: {} },
      {
        id: 'gp',
        type: 'graphPatch',
        data: { ops: [{ op: 'addNode', node: { id: 'free1', type: 'prompt', data: {} } }] },
      },
      { id: 'e', type: 'end', data: {} },
    ],
    connections: [
      { from: 's', fromPort: 'default', to: 'gp', toPort: 'input' },
      { from: 'gp', fromPort: 'default', to: 'e', toPort: 'input' },
    ],
  };

  const res = await executor.runGraph(graph, { primitives: mockPrimitives() });
  assert.strictEqual(res.status, 'completed');

  const gp = res.log.find((l) => l.nodeId === 'gp');
  assert.ok(gp.revision, 'graphPatch 节点必须留下 revision 审计');
  assert.strictEqual(gp.revision.seq, 1);
  assert.strictEqual(gp.revision.ops.length, 1);
  assert.match(gp.revision.beforeHash, /^[0-9a-f]{64}$/);
  assert.match(gp.revision.afterHash, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(gp.revision.beforeHash, gp.revision.afterHash, '改写了图，哈希必须变');
});

// ── 应拦方向 ────────────────────────────────────────────────────────────────

function singlePatchGraph(ops) {
  return {
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 'gp', type: 'graphPatch', data: { ops } },
      { id: 'e', type: 'end', data: {} },
    ],
    connections: [
      { from: 's', fromPort: 'default', to: 'gp', toPort: 'input' },
      { from: 'gp', fromPort: 'default', to: 'e', toPort: 'input' },
    ],
  };
}

test('删节点仍被拒，但边级 disconnect 已放开（方案 §10-Q2 收窄裁决）', async () => {
  // 节点级删除：仍一律拒绝（pending_json.loopState 可能指向已删节点）。
  await assert.rejects(
    () => executor.runGraph(singlePatchGraph([{ op: 'removeNode', id: 'e' }]), { primitives: mockPrimitives() }),
    /10-Q2/
  );
  await assert.rejects(
    () => executor.runGraph(singlePatchGraph([{ op: 'deleteNode', id: 'e' }]), { primitives: mockPrimitives() }),
    /10-Q2/
  );

  // 边级删除：已放开 —— 删一条**存在**的边应当成功（gp -> e 被摘掉，run 正常收尾）。
  const ok = await executor.runGraph(
    singlePatchGraph([{ op: 'disconnect', from: 'gp', to: 'e' }]),
    { primitives: mockPrimitives() }
  );
  assert.strictEqual(ok.status, 'completed');
  const gpEntry = ok.log.find((l) => l.nodeId === 'gp');
  assert.ok(gpEntry && gpEntry.revision, 'graphPatch 节点必须留下 revision 审计');
  assert.ok(gpEntry.revision.ops.some((o) => o.op === 'disconnect'), '审计必须含 disconnect');

  // 但删一条**不存在**的边仍 fail-closed —— 放开的是「删边」，不是「随便删」。
  await assert.rejects(
    () => executor.runGraph(singlePatchGraph([{ op: 'disconnect', from: 's', to: 'ghost' }]), { primitives: mockPrimitives() }),
    /找不到匹配的边/
  );
});

test('未知算子被拒（补丁 DSL 是白名单，不是 eval）', async () => {
  await assert.rejects(
    () => executor.runGraph(singlePatchGraph([{ op: 'evalCode', src: 'process.exit(1)' }]), {
      primitives: mockPrimitives(),
    }),
    /未知算子/
  );
});

test('非法源端口被拒', async () => {
  await assert.rejects(
    () =>
      executor.runGraph(
        singlePatchGraph([
          { op: 'addNode', node: { id: 'p9', type: 'prompt', data: {} } },
          { op: 'connect', from: 's', fromPort: 'branch-true', to: 'p9' },
        ]),
        { primitives: mockPrimitives() }
      ),
    /非法源端口/
  );
});

test('未在 nodeCatalog 声明的节点类型被拒', async () => {
  await assert.rejects(
    () =>
      executor.runGraph(singlePatchGraph([{ op: 'addNode', node: { id: 'zz', type: 'noSuchType' } }]), {
        primitives: mockPrimitives(),
      }),
    /未知节点类型/
  );
});

test('超出 MAX_REVISIONS 抛错', async () => {
  const graph = {
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 'gp1', type: 'graphPatch', data: { ops: [{ op: 'addNode', node: { id: 'f1', type: 'prompt', data: {} } }] } },
      { id: 'gp2', type: 'graphPatch', data: { ops: [{ op: 'addNode', node: { id: 'f2', type: 'prompt', data: {} } }] } },
      { id: 'e', type: 'end', data: {} },
    ],
    connections: [
      { from: 's', fromPort: 'default', to: 'gp1', toPort: 'input' },
      { from: 'gp1', fromPort: 'default', to: 'gp2', toPort: 'input' },
      { from: 'gp2', fromPort: 'default', to: 'e', toPort: 'input' },
    ],
  };

  await assert.rejects(
    () => executor.runGraph(graph, { primitives: mockPrimitives(), maxRevisions: 1 }),
    new RegExp(`MAX_REVISIONS 1`)
  );
  // 上界是常量而非魔法数：默认值必须 ≥ 1，否则本机制无法启用
  assert.ok(MAX_REVISIONS >= 1);
});

// ── 纯叶子：事务性与「不替原图背锅」────────────────────────────────────────

test('被拒时原图逐字段不变（事务性）', () => {
  const base = {
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 'e', type: 'end', data: {} },
    ],
    connections: [{ from: 's', fromPort: 'default', to: 'e', toPort: 'input' }],
  };
  const snapshot = JSON.stringify(base);

  const bad = applyPatch(
    base,
    [
      { op: 'addNode', node: { id: 'p', type: 'prompt', data: {} } },
      { op: 'connect', from: 'p', fromPort: 'branch-true', to: 'e' }, // 非法端口
    ],
    CAPS
  );
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(JSON.stringify(base), snapshot, '被拒后原图必须逐字段不变');
});

test('只对「补丁新引入」的校验错误判失败（不替原图的历史瑕疵背锅）', () => {
  // 原图自带历史瑕疵：end 节点带出边（strict 会报，但与本次补丁无关）
  const legacy = {
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 'e', type: 'end', data: {} },
      { id: 'ghost', type: 'prompt', data: {} },
    ],
    connections: [
      { from: 's', fromPort: 'default', to: 'e', toPort: 'input' },
      { from: 'e', fromPort: 'default', to: 'ghost', toPort: 'input' },
    ],
  };
  const pre = applyPatch(legacy, [{ op: 'addNode', node: { id: 'extra', type: 'prompt', data: {} } }], CAPS);
  assert.strictEqual(pre.ok, true, '补丁本身合法，不应因原图历史瑕疵被拒');
  assert.strictEqual(pre.graph.nodes.length, 4);

  // 反向对照：补丁**自己**引入的错误必须被拦
  const introduced = applyPatch(legacy, [{ op: 'addNode', node: { id: 's2', type: 'start', data: {} } }], CAPS);
  assert.strictEqual(introduced.ok, false);
  assert.ok(
    introduced.errors.some((e) => /start 节点/.test(e)),
    `应报「第二个 start」，实得：${introduced.errors.join(' | ')}`
  );
});

test('空 ops 被拒（fail-closed：不接受「什么都没做」的补丁）', () => {
  const g = { nodes: [{ id: 's', type: 'start' }, { id: 'e', type: 'end' }], connections: [] };
  assert.strictEqual(applyPatch(g, [], CAPS).ok, false);
  assert.strictEqual(applyPatch(g, null, CAPS).ok, false);
  assert.strictEqual(applyPatch(g, 'addNode', CAPS).ok, false);
});

test('注入闸 fail-closed：拿不到 portsFor / knownTypes 一律拒绝（绝不 fail-open）', () => {
  // 本叶子不自己 require nodeCatalog —— 端口词汇与已知类型由调用方注入
  // （沿用 workflowCliCore.validateGraph 的既有约定）。
  const g = {
    nodes: [{ id: 's', type: 'start', data: {} }, { id: 'e', type: 'end', data: {} }],
    connections: [{ from: 's', fromPort: 'default', to: 'e', toPort: 'input' }],
  };
  const ops = [{ op: 'addNode', node: { id: 'p', type: 'prompt', data: {} } }];

  // 1 完全不注入 ⇒ 拒绝
  const none = applyPatch(g, ops);
  assert.strictEqual(none.ok, false, '无注入必须被拒');
  assert.ok(/注入/.test(none.errors[0]), `理由应指向缺失注入，实得：${none.errors[0]}`);

  // 2 只注入一半（缺 knownTypes）⇒ 仍拒绝
  const half = applyPatch(g, ops, { portsFor: CAPS.portsFor });
  assert.strictEqual(half.ok, false, '缺 knownTypes 必须被拒');

  // 3 只注入一半（缺 portsFor）⇒ 仍拒绝
  const half2 = applyPatch(g, ops, { knownTypes: CAPS.knownTypes });
  assert.strictEqual(half2.ok, false, '缺 portsFor 必须被拒');

  // 4 端口函数传成非函数 ⇒ 视为未注入，拒绝
  const bad = applyPatch(g, ops, { portsFor: 'portsFor', knownTypes: CAPS.knownTypes });
  assert.strictEqual(bad.ok, false, '非函数的 portsFor 必须被拒');

  // 5 对照：注入齐全则放行（证明不是无脑拦）
  const ok = applyPatch(g, ops, CAPS);
  assert.strictEqual(ok.ok, true, '注入齐全必须放行');
});

test('注入的能力坏掉时必须 fail-closed，且错误可区分于「端口真的非法」', () => {
  // portsFor 由调用方注入，叶子不能假设它一定不抛。契约是「绝不抛」；
  // 但「能力异常」与「端口非法」是两回事 —— 报错必须能区分，
  // 否则调试者会被指向补丁，而真因在注入。
  const g = {
    nodes: [{ id: 's', type: 'start', data: {} }, { id: 'e', type: 'end', data: {} }],
    connections: [],
  };
  const ops = [{ op: 'connect', from: 's', to: 'e' }];

  // 1 注入的 portsFor 会抛 ⇒ 不抛穿调用方，且拒绝
  const throwing = applyPatch(g, ops, { portsFor: () => { throw new Error('boom'); }, knownTypes: CAPS.knownTypes });
  assert.strictEqual(throwing.ok, false, '能力抛异常必须被拒（不得放行）');
  assert.ok(
    /不可用|能力异常/.test(throwing.errors.join(' ')),
    `应报「能力异常」而非端口非法，实得：${throwing.errors.join(' | ')}`
  );

  // 2 注入的 portsFor 返回非法值 ⇒ 同样拒绝且同一类错误
  const bad = applyPatch(g, ops, { portsFor: () => null, knownTypes: CAPS.knownTypes });
  assert.strictEqual(bad.ok, false, '返回 null 必须被拒');
  assert.ok(/不可用|能力异常/.test(bad.errors.join(' ')), '应报能力异常');

  // 3 对照：能力正常但端口真的非法 ⇒ 报的是「非法端口」（两类错误可区分）
  const illegalPort = applyPatch(
    g,
    [{ op: 'connect', from: 's', fromPort: 'branch-true', to: 'e' }],
    CAPS
  );
  assert.strictEqual(illegalPort.ok, false);
  assert.ok(
    /非法源端口/.test(illegalPort.errors.join(' ')),
    `端口非法应报「非法源端口」，实得：${illegalPort.errors.join(' | ')}`
  );
  assert.ok(
    !/不可用|能力异常/.test(illegalPort.errors.join(' ')),
    '端口非法不得被误报成能力异常'
  );

  // 4 对照：能力正常 + 端口合法 ⇒ 放行（证明不是无脑拦）
  assert.strictEqual(applyPatch(g, ops, CAPS).ok, true, '能力正常时合法补丁必须放行');
});

// ── 边级 disconnect（Q2 收窄裁决：禁删节点、允许删边）──────────────────────

test('disconnect 删掉一条存在的边', () => {
  const g = {
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 'p', type: 'prompt', data: {} },
      { id: 'e', type: 'end', data: {} },
    ],
    connections: [
      { from: 's', fromPort: 'default', to: 'p', toPort: 'input' },
      { from: 'p', fromPort: 'default', to: 'e', toPort: 'input' },
    ],
  };
  const r = applyPatch(g, [{ op: 'disconnect', from: 's', to: 'p' }], CAPS);
  assert.strictEqual(r.ok, true, `应放行，实得：${r.errors.join(' | ')}`);
  assert.strictEqual(r.graph.connections.length, 1);
  assert.strictEqual(r.applied[0].removed, 1);
});

test('disconnect 删一条不存在的边必须被拒（fail-closed：作者心智模型与实际图不符）', () => {
  const g = {
    nodes: [{ id: 's', type: 'start', data: {} }, { id: 'e', type: 'end', data: {} }],
    connections: [{ from: 's', fromPort: 'default', to: 'e', toPort: 'input' }],
  };
  const r = applyPatch(g, [{ op: 'disconnect', from: 's', to: 'nope' }], CAPS);
  assert.strictEqual(r.ok, false);
  assert.ok(/找不到匹配的边/.test(r.errors.join(' ')), '应报找不到匹配的边');
});

test('removeNode 仍被拒，且错误串提示改用 disconnect', () => {
  const g = {
    nodes: [{ id: 's', type: 'start', data: {} }, { id: 'e', type: 'end', data: {} }],
    connections: [],
  };
  const r = applyPatch(g, [{ op: 'removeNode', id: 'e' }], CAPS);
  assert.strictEqual(r.ok, false, '删节点必须仍被拒（Q2 只收窄了边）');
  assert.ok(/删除节点默认禁止/.test(r.errors.join(' ')), '理由应指向「删除节点」');
  assert.ok(/disconnect/.test(r.errors.join(' ')), '理由应提示删边改用 disconnect');
});

test('★ 硬限制解除：把新节点插入一条「已存在」的边，新节点必须真的被执行（执行器级）', async () => {
  // §12.7 记录的硬限制：nextNode() 对每个 (from, fromPort) 只认第一条边，
  // 所以加法-only 的补丁无法把节点插入已存在的边（新边被遮蔽，游标仍走老路）。
  // disconnect 是解开它的唯一手段 —— 本测试就是该限制的解除判据。
  const graph = {
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 'gp', type: 'graphPatch', data: {} },
      { id: 'p', type: 'prompt', data: { prompt: 'outer', outputVar: 'outer' } },
      { id: 'e', type: 'end', data: {} },
    ],
    connections: [
      { from: 's', fromPort: 'default', to: 'gp', toPort: 'input' },
      { from: 'gp', fromPort: 'default', to: 'p', toPort: 'input' },
      { from: 'p', fromPort: 'default', to: 'e', toPort: 'input' },
    ],
  };
  graph.nodes.find((n) => n.id === 'gp').data = {
    ops: [
      { op: 'addNode', node: { id: 'mid', type: 'prompt', data: { prompt: 'inner', outputVar: 'inner' } } },
      { op: 'disconnect', from: 'p', to: 'e' }, // ★ 先摘掉旧边
      { op: 'connect', from: 'p', to: 'mid' },
      { op: 'connect', from: 'mid', to: 'e' },
    ],
  };

  const prim = mockPrimitives();
  const res = await executor.runGraph(graph, { primitives: prim, vars: {} });

  assert.strictEqual(res.status, 'completed');
  const visited = res.log.map((l) => l.nodeId);
  assert.ok(visited.includes('mid'), `插入已存在边的新节点必须被执行（实到：${visited.join(' -> ')}）`);
  assert.strictEqual(res.vars.inner, 'chat:inner', '新节点的副作用必须落到 vars');
  assert.deepStrictEqual(prim.seen, ['outer', 'inner'], '执行顺序应为 outer -> inner');

  // 审计：该 graphPatch 节点的 log entry 必须记下这次含 disconnect 的改写
  const gpEntry = res.log.find((l) => l.nodeId === 'gp');
  assert.ok(gpEntry && gpEntry.revision, 'graphPatch 节点必须留下 revision 审计');
  assert.strictEqual(gpEntry.revision.ops.length, 4);
  assert.ok(gpEntry.revision.ops.some((o) => o.op === 'disconnect'), '审计里必须含 disconnect');
  assert.notStrictEqual(gpEntry.revision.beforeHash, gpEntry.revision.afterHash);
});

test('对照：不做 disconnect 时，同一补丁的新节点会被既有第一条边遮蔽（证明 disconnect 承重）', async () => {
  // 与上一条的唯一差别：**去掉 disconnect**。若这一条也能让 mid 跑起来，
  // 上一条就是恒真断言。实测：mid 被 p→e 遮蔽，从未执行。
  const graph = {
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 'gp', type: 'graphPatch', data: {} },
      { id: 'p', type: 'prompt', data: { prompt: 'outer', outputVar: 'outer' } },
      { id: 'e', type: 'end', data: {} },
    ],
    connections: [
      { from: 's', fromPort: 'default', to: 'gp', toPort: 'input' },
      { from: 'gp', fromPort: 'default', to: 'p', toPort: 'input' },
      { from: 'p', fromPort: 'default', to: 'e', toPort: 'input' },
    ],
  };
  graph.nodes.find((n) => n.id === 'gp').data = {
    ops: [
      { op: 'addNode', node: { id: 'mid', type: 'prompt', data: { prompt: 'inner', outputVar: 'inner' } } },
      { op: 'connect', from: 'p', to: 'mid' }, // 无 disconnect
      { op: 'connect', from: 'mid', to: 'e' },
    ],
  };

  const prim = mockPrimitives();
  const res = await executor.runGraph(graph, { primitives: prim, vars: {} });

  assert.strictEqual(res.status, 'completed', '补丁本身合法，run 仍应完成');
  const visited = res.log.map((l) => l.nodeId);
  assert.ok(!visited.includes('mid'), `无 disconnect 时 mid 不应被执行（实到：${visited.join(' -> ')}）`);
  assert.strictEqual(res.vars.inner, undefined);
  assert.deepStrictEqual(prim.seen, ['outer'], '只应执行 outer');
});
