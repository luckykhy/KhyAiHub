/**
 * workflowExecutor.onVar.test.js — D1「运行时自演化」的**运行期补丁来源**契约
 * （`[DESIGN-ARCH-141]` §5-D1 / §10-Q8；规则 `TOOLING-011`）。
 *
 * 用 `node:test` 而非 jest：`services/backend/jest.config.js` 会按
 * `require('node:test')` 标记自动忽略本文件，故它由 `node --test` 运行。
 *
 * ## 这一组测的是什么
 *
 * `graphPatch` 的补丁可以**静态写死**（`ops`），也可以**来自运行期变量**（`onVar`）。
 * 后者才是「运行时自演化」的入口 —— 补丁在跑起来之前并不存在。
 *
 * ## 判据不能是「解析函数返回了 ok」
 *
 * 沿用同目录 `workflowExecutor.graphPatch.test.js` 的立场：G3「图启动即冻结」这类
 * 缺陷**不会报错**。补丁解析成功但没进到执行器，运行照常「成功」，只是新节点
 * **从未被执行**。所以核心判据一律是 **「补丁新增的节点真的跑了」**（看 `visited`）。
 *
 * ## 改动前的行为（本组测试的牙）
 *
 * 改动前执行器只读 `d.ops`，`d.onVar` **被完全忽略** ⇒ 只给 `onVar` 的图会以
 * `graphPatch 既没有 ops 数组，也没有 onVar 变量名` 抛错。故「数组来源生效」与
 * 「字符串来源生效」两条在本组之前必然失败 —— 它们是真回归测试，不是恒真断言。
 *
 * ## 另一条必须钉死的判据：**不回落**
 *
 * `onVar` 一旦声明就**只认它**。若解析失败时回落到 `ops`，那是一次**静默降级**：
 * 作者声明了运行期来源，引擎却跑了一份静态补丁，而日志上（改动前）看不出区别。
 * 测试 4 就是这条的判据 —— 且配了对照（同一 `ops` 在 `onVar` 缺省时能跑通），
 * 证明「抛」不是因为 `ops` 本身有问题。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const executor = require('../src/services/domain/project/workflow/workflowExecutor');
const { resolvePatchOps } = require('../src/services/domain/project/workflow/graphPatch');
const { extractFirstJson } = require('../src/services/domain/project/workflow/jsonExtract');

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

/**
 * `s → gp`，另有一个**游离**的 `e`（gp 尚无出边）。
 *
 * 这一点很关键：`nextNode()` 对每个 `(from, fromPort)` **只认第一条边**，
 * 若 `gp → e` 已存在，补丁补上的 `gp → p1` 永远不会被走到，测试就成了恒真断言。
 * 让 gp 从**没有出边**的状态开始，补丁补的边才是它的第一条。
 */
function patchGraph(data) {
  return {
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 'gp', type: 'graphPatch', data },
      { id: 'e', type: 'end', data: {} },
    ],
    connections: [{ from: 's', fromPort: 'default', to: 'gp', toPort: 'input' }],
  };
}

/** 一段「把 p1 插到 gp 与 e 之间」的补丁算子。 */
function insertP1Ops(id = 'p1', prompt = 'made') {
  return [
    { op: 'addNode', node: { id, type: 'prompt', data: { prompt, outputVar: 'made' } } },
    { op: 'connect', from: 'gp', to: id },
    { op: 'connect', from: id, to: 'e' },
  ];
}

// ── 核心判据 ①：数组来源的补丁必须真的被执行 ──────────────────────────────

test('★ onVar 指向数组：补丁新增的节点必须真的被执行（G3 回归）', async () => {
  const prim = mockPrimitives();
  const res = await executor.runGraph(patchGraph({ onVar: 'patchVar' }), {
    primitives: prim,
    vars: { patchVar: insertP1Ops('p1', 'hello-from-var') },
  });

  assert.strictEqual(res.status, 'completed');
  assert.deepStrictEqual(
    res.log.map((l) => l.nodeId),
    ['s', 'gp', 'p1', 'e'],
    'onVar 补丁新增的 p1 必须真的进入执行序列'
  );
  assert.deepStrictEqual(prim.seen, ['hello-from-var'], 'p1 的 prompt 必须真的跑过');
});

// ── 核心判据 ②：字符串来源（AI 产出形态）也必须真的被执行 ─────────────────

test('★ onVar 指向字符串：容错解析后补丁必须真的被执行（含围栏 + 前后文）', async () => {
  const prim = mockPrimitives();
  // 刻意做成「模型回复」的真实形态：解释文字 + ```json 围栏。
  const reply = '好的，我来加一个节点：\n```json\n' + JSON.stringify(insertP1Ops('p1', 'from-reply')) + '\n```\n以上。';

  const res = await executor.runGraph(patchGraph({ onVar: 'reply' }), {
    primitives: prim,
    vars: { reply },
  });

  assert.strictEqual(res.status, 'completed');
  assert.deepStrictEqual(res.log.map((l) => l.nodeId), ['s', 'gp', 'p1', 'e']);
  assert.deepStrictEqual(prim.seen, ['from-reply']);
});

test('onVar 指向裸 JSON 字符串（无围栏、无前后文）同样生效', async () => {
  const prim = mockPrimitives();
  const res = await executor.runGraph(patchGraph({ onVar: 'p' }), {
    primitives: prim,
    vars: { p: JSON.stringify(insertP1Ops('p1', 'bare')) },
  });
  assert.deepStrictEqual(res.log.map((l) => l.nodeId), ['s', 'gp', 'p1', 'e']);
  assert.deepStrictEqual(prim.seen, ['bare']);
});

// ── 优先级：onVar 与 ops 同时给出 ⇒ 只认 onVar ────────────────────────────

test('onVar 与 ops 同时给出时只认 onVar（不合并、不取并集）', async () => {
  const prim = mockPrimitives();
  const res = await executor.runGraph(
    patchGraph({ onVar: 'v', ops: insertP1Ops('p_ops', 'from-ops') }),
    { primitives: prim, vars: { v: insertP1Ops('p_var', 'from-var') } }
  );

  const visited = res.log.map((l) => l.nodeId);
  assert.ok(visited.includes('p_var'), '必须执行 onVar 引入的节点');
  assert.ok(!visited.includes('p_ops'), 'ops 被 onVar 取代，其节点不得出现');
  assert.deepStrictEqual(prim.seen, ['from-var']);
});

// ── ★ 不回落：解析失败 + ops 可用 ⇒ 必须抛（否则是静默降级）──────────────

test('★ onVar 解析失败时绝不回落到 ops（静默降级的判据）', async () => {
  const ops = insertP1Ops('p_ops', 'from-ops');

  // 对照 A：只有 ops ⇒ 跑得通（证明 ops 本身没问题，下面那次抛不是因为 ops）。
  const okRes = await executor.runGraph(patchGraph({ ops }), { primitives: mockPrimitives() });
  assert.strictEqual(okRes.status, 'completed');

  // 对照 B：同一份 ops 可用，但 onVar 指向一个不存在的变量 ⇒ 必须抛。
  await assert.rejects(
    () =>
      executor.runGraph(patchGraph({ onVar: 'nope', ops }), {
        primitives: mockPrimitives(),
        vars: {},
      }),
    /graphPatch\.onVar 变量 'nope' 不存在/
  );
});

// ── 各类拒绝：错误串必须**可区分**（§12.7 判据二）──────────────────────────

test('onVar 的各类拒绝理由措辞必须两两不同（§12.7 判据二：fail-closed ≠ 错误报对）', async () => {
  // ⚠ 只列**能穿过执行器**的成因：`runGraph` 里 `vars = {...(options.vars || {})}`
  // 至少是 `{}`，所以「没有变量袋」那一支在执行器层**不可达**（它由下面的叶子级
  // 测试覆盖）。把不可达的分支写进这里，只会得到一个永远测不到的分支。
  const cases = [
    ['不存在', { onVar: 'x', vars: {} }, /不存在（变量袋里没有这个名字）/],
    ['不是 JSON', { onVar: 'x', vars: { x: '我想加个节点' } }, /不是合法 JSON/],
    ['解析出对象', { onVar: 'x', vars: { x: '{"op":"connect"}' } }, /解析出的是对象，不是补丁数组/],
    ['解析出数字', { onVar: 'x', vars: { x: '42' } }, /解析出的是数字，不是补丁数组/],
    ['值是数字', { onVar: 'x', vars: { x: 42 } }, /的值是数字，既不是数组也不是 JSON 文本/],
    ['值是对象', { onVar: 'x', vars: { x: { op: 'connect' } } }, /的值是对象/],
    ['值是布尔', { onVar: 'x', vars: { x: true } }, /的值是布尔/],
    ['值是 null', { onVar: 'x', vars: { x: null } }, /的值是null/],
  ];

  const msgs = [];
  for (const [label, data, re] of cases) {
    await assert.rejects(
      () => executor.runGraph(patchGraph(data), { primitives: mockPrimitives(), vars: data.vars }),
      re,
      `${label} 的拒绝理由不匹配`
    );
    msgs.push(String(resolvePatchOps({ onVar: data.onVar, vars: data.vars }).errors[0]));
  }
  assert.strictEqual(new Set(msgs).size, msgs.length, '各类成因的措辞必须两两不同');
});

test('叶子级：没有变量袋 / 变量袋不是对象 ⇒ 独立措辞（执行器层不可达的那一支）', () => {
  const noBag = resolvePatchOps({ onVar: 'x' });
  assert.strictEqual(noBag.ok, false);
  assert.match(noBag.errors[0], /需要 vars 变量袋/);

  const arrBag = resolvePatchOps({ onVar: 'x', vars: [] });
  assert.strictEqual(arrBag.ok, false);
  assert.match(arrBag.errors[0], /需要 vars 变量袋/);

  // 与「变量不存在」必须可区分 —— 否则调用方会去查错方向。
  const missing = resolvePatchOps({ onVar: 'x', vars: {} });
  assert.notStrictEqual(noBag.errors[0], missing.errors[0]);
});

test('onVar 声明畸形（非字符串）被拒 —— 不能静默当成没写', async () => {
  await assert.rejects(
    () => executor.runGraph(patchGraph({ onVar: 42, ops: insertP1Ops() }), { primitives: mockPrimitives() }),
    /onVar 必须是变量名字符串/
  );
});

// ── 未指定：空串 / 空白 / 缺省 ⇒ 回落 ops（沿用本执行器 falsy = 没填 的约定）──

test('onVar 为空串/空白/缺省时回落静态 ops（前端空文本框即空串）', async () => {
  for (const onVar of ['', '   ', undefined, null]) {
    const prim = mockPrimitives();
    const res = await executor.runGraph(
      patchGraph({ onVar, ops: insertP1Ops('p_ops', 'static') }),
      { primitives: prim }
    );
    assert.deepStrictEqual(
      res.log.map((l) => l.nodeId),
      ['s', 'gp', 'p_ops', 'e'],
      `onVar=${JSON.stringify(onVar)} 应回落到 ops`
    );
    assert.deepStrictEqual(prim.seen, ['static']);
  }
});

test('既没有 ops 也没有 onVar ⇒ 拒绝（无法确定补丁来源）', async () => {
  await assert.rejects(
    () => executor.runGraph(patchGraph({}), { primitives: mockPrimitives() }),
    /既没有 ops 数组，也没有 onVar 变量名/
  );
});

// ── 审计：补丁出处必须可区分 ──────────────────────────────────────────────

test('审计记录补丁出处：onVar:<name> 与 ops 必须可区分', async () => {
  const viaVar = await executor.runGraph(patchGraph({ onVar: 'pv' }), {
    primitives: mockPrimitives(),
    vars: { pv: insertP1Ops() },
  });
  const gpVar = viaVar.log.find((l) => l.nodeId === 'gp');
  assert.ok(gpVar && gpVar.revision, 'graphPatch 节点必须留下 revision 审计');
  assert.strictEqual(gpVar.revision.source, 'onVar:pv', '审计必须标明补丁来自哪个变量');

  const viaOps = await executor.runGraph(patchGraph({ ops: insertP1Ops() }), {
    primitives: mockPrimitives(),
  });
  const gpOps = viaOps.log.find((l) => l.nodeId === 'gp');
  assert.strictEqual(gpOps.revision.source, 'ops', '静态补丁的出处必须是 ops');
});

test('onVar 的数组来源也可被审计识别（结构化来源）', async () => {
  const res = await executor.runGraph(patchGraph({ onVar: 'arr' }), {
    primitives: mockPrimitives(),
    vars: { arr: insertP1Ops() },
  });
  const gp = res.log.find((l) => l.nodeId === 'gp');
  assert.strictEqual(gp.revision.source, 'onVar:arr');
  assert.strictEqual(gp.revision.ops.length, 3, '审计必须含全部 3 个算子');
});

// ── 副作用边界：runGraph 不得改动调用方的图对象 ───────────────────────────

test('onVar 改写后，调用方传入的图对象逐字段不变（runGraph 在副本上工作）', async () => {
  const graph = patchGraph({ onVar: 'v' });
  const snapshot = JSON.stringify(graph);
  await executor.runGraph(graph, { primitives: mockPrimitives(), vars: { v: insertP1Ops() } });
  assert.strictEqual(JSON.stringify(graph), snapshot, 'runGraph 不得改写调用方的图');
});

// ── 纯叶子级：extractFirstJson 是 ai-backend 同名的**超集**（数组定界符）────

test('extractFirstJson 能取到外层数组（ai-backend 原版此处会取到内层对象）', () => {
  const reply = '好的，补丁如下：\n[{"op":"connect","from":"a","to":"b"}]\n以上。';
  assert.deepStrictEqual(extractFirstJson(reply), [{ op: 'connect', from: 'a', to: 'b' }]);
  // 差异的成因：`{` 出现在 `[` 之后。只认 `{` 作定界符的实现（ai-backend 的同名函数）
  // 会从那里开始扫，返回**内层对象**而不是外层数组 —— 对 onVar 而言那是错的。
  assert.ok(
    reply.indexOf('{') > reply.indexOf('['),
    '样例里 { 必须出现在 [ 之后，这个差异才有意义'
  );
});

test('extractFirstJson 对畸形输入一律返回 null（绝不抛）', () => {
  for (const bad of [null, undefined, 42, {}, [], '', '   ', 'no json', '[1,2', '```json\n[1,2\n```']) {
    assert.strictEqual(extractFirstJson(bad), null, `应返回 null: ${JSON.stringify(bad)}`);
  }
});
