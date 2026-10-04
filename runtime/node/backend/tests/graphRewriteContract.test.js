/**
 * graphRewriteContract.test.js — D1 收尾：把方案 §6 的三条铁律做成**真判据**
 * （F4 事务性 + 审计、F5 可重放、F9 零代码执行；`[DESIGN-ARCH-141]` §5-D1）。
 *
 * ## 为什么必须有这一组测试
 *
 * 方案 §6 给 F4 / F5 / F9 都写了**可自动判的判据**，但「现状」列一直是
 * 「待实现（D1）」—— 而头部状态却写着「D1 已全部落地」。这两句不能同时为真：
 * 实测 `graphRevisions` / 重放对照 / 零代码执行断言**在测试里都不存在**。
 * 本文件把三条判据落地，使「已落地」这句话**有据可依**。
 *
 * ## 与 workflowExecutor.graphPatch.test.js 的分工
 *
 * - 那份测**行为契约**：补丁真的生效（新增节点真的被执行）、拦截方向正确。
 * - 本份测**铁律判据**：审计可独立核验、同输入可重放、改写路径不引代码执行。
 *
 * 两份都用 `node:test`（`jest.config.js` 会按 `require('node:test')` 标记忽略它们）。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const executor = require('../src/services/domain/project/workflow/workflowExecutor');
const { applyPatch } = require('../src/services/domain/project/workflow/graphPatch');
const { computeGraphHash } = require('../src/services/domain/project/workflow/flowRegistry');
const { portsFor, NODE_CATALOG } = require('@khy/shared/workflow/nodeCatalog');
// 复用本仓既有的注释剥离器（`archDebtScan.js` 导出，自带状态机边界测试）。
// 复用 > 复制：自造一个「只删 //」的实现会把字符串里的 `//` 当注释，从而**漏掉**真代码。
const { stripComments } = require('../scripts/archDebtScan');

const CAPS = { portsFor, knownTypes: new Set(NODE_CATALOG.map((n) => n.type)) };

function mockPrimitives(over = {}) {
  const seen = [];
  return {
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
    ...over,
  };
}

/** 补丁：插一个 prompt 节点到 gp 与 e 之间（含 addNode / disconnect / connect 三类算子）。 */
function patchOps(promptText = 'hi-{{n}}') {
  return [
    { op: 'addNode', node: { id: 'p1', type: 'prompt', data: { prompt: promptText, outputVar: 'out1' } } },
    { op: 'disconnect', from: 'gp', to: 'e' },
    { op: 'connect', from: 'gp', to: 'p1' },
    { op: 'connect', from: 'p1', to: 'e' },
  ];
}

/** 主图：s → gp → e，gp 的补丁来源是运行期变量 `patch`（走 onVar 的字符串解析路径）。 */
function rewriteGraph() {
  return {
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 'gp', type: 'graphPatch', data: { onVar: 'patch' } },
      { id: 'e', type: 'end', data: {} },
    ],
    connections: [
      { from: 's', fromPort: 'default', to: 'gp', toPort: 'input' },
      { from: 'gp', fromPort: 'default', to: 'e', toPort: 'input' },
    ],
  };
}

async function runOnce(promptText = 'hi-{{n}}', vars = { n: 'A' }) {
  const graph = rewriteGraph();
  const primitives = mockPrimitives();
  const res = await executor.runGraph(graph, {
    primitives,
    vars: { ...vars, patch: JSON.stringify(patchOps(promptText)) },
  });
  return { graph, primitives, res, revisions: res.log.filter((e) => e.revision).map((e) => e.revision) };
}

const HEX64 = /^[0-9a-f]{64}$/;

// ── F4：事务性 + 审计 ───────────────────────────────────────────────────────

test('F4：成功改写时审计带 beforeHash/afterHash，且 beforeHash 等于「改写前图」的独立哈希', async () => {
  const { graph, revisions, res } = await runOnce();

  assert.strictEqual(res.status, 'completed', '先决条件：这一轮必须跑完');
  assert.strictEqual(revisions.length, 1, '应恰好落一条 revision 审计');
  const rev = revisions[0];

  assert.strictEqual(rev.seq, 1, '首个 revision 的 seq 应为 1');
  assert.match(rev.beforeHash, HEX64, 'beforeHash 必须是 sha256 十六进制');
  assert.match(rev.afterHash, HEX64, 'afterHash 必须是 sha256 十六进制');
  assert.notStrictEqual(rev.beforeHash, rev.afterHash, '真改写 ⇒ 前后哈希必须不同');

  // ★ 关键：审计里的 beforeHash 必须能被**独立重算**出来。
  // 否则它只是一个「看起来像哈希的字符串」，审计等于没有可核性。
  assert.strictEqual(
    rev.beforeHash,
    computeGraphHash({ nodes: graph.nodes, connections: graph.connections }),
    'beforeHash 必须等于改写前图的 computeGraphHash（审计可独立核验）'
  );
});

test('F4：被拒的补丁不落审计，且图逐字段不变（事务性的审计侧对照）', async () => {
  const graph = rewriteGraph();
  const snapshot = JSON.stringify(graph);

  // 节点删除仍被拒（裁决 10-Q2 收窄为「禁删节点、允许删边」）。
  const res = await applyPatch(graph, [{ op: 'removeNode', id: 'e' }], CAPS);
  assert.strictEqual(res.ok, false, 'removeNode 必须被拒');
  assert.ok(
    /删除节点默认禁止/.test(res.errors.join(' ')),
    `拒绝理由应指向「删除节点默认禁止」，实际：${res.errors.join(' ')}`
  );

  // 拒绝路径到不了审计写入（执行器在写 revision 之前 throw）⇒ 判据是「抛错 + 图不变」。
  await assert.rejects(
    () =>
      executor.runGraph(rewriteGraph(), {
        primitives: mockPrimitives(),
        vars: { patch: JSON.stringify([{ op: 'removeNode', id: 'e' }]) },
      }),
    /graphPatch refused/,
    '执行器必须把被拒的补丁变成异常（fail-closed），而不是静默跳过'
  );

  assert.strictEqual(JSON.stringify(graph), snapshot, '被拒后原图必须逐字段不变');
});

// ── F5：可重放 ──────────────────────────────────────────────────────────────

test('F5：同一图 + 同一补丁双跑 ⇒ revision 哈希序列与终态 vars 逐字符相等', async () => {
  const a = await runOnce();
  const b = await runOnce();

  const seq = (r) => r.revisions.map((x) => ({ seq: x.seq, before: x.beforeHash, after: x.afterHash }));

  assert.deepStrictEqual(seq(a), seq(b), 'revision 的 seq / before / after 序列必须逐项相等');
  assert.strictEqual(
    JSON.stringify(a.res.vars),
    JSON.stringify(b.res.vars),
    '终态 vars 必须逐字符相等（判据原文）'
  );
  // 双跑真的跑到了新节点 ⇒ 上面的相等不是「两边都空」的恒真断言。
  assert.strictEqual(a.res.vars.out1, 'chat:hi-A', '先决条件：补丁插入的节点必须真的执行过');
});

test('F5 有牙对照：改动补丁 ⇒ 哈希序列与终态 vars 必变（证明上面的相等有分辨力）', async () => {
  const a = await runOnce('hi-{{n}}');
  const b = await runOnce('CHANGED-{{n}}');

  assert.notDeepStrictEqual(
    a.revisions.map((x) => x.afterHash),
    b.revisions.map((x) => x.afterHash),
    '补丁内容变了 ⇒ afterHash 必须变（否则哈希没有分辨力，F5 的相等是恒真断言）'
  );
  assert.notStrictEqual(a.res.vars.out1, b.res.vars.out1, '终态 vars 也必须随之变');
  // 而改写前的图没变 ⇒ beforeHash 必须**相同**（证明变的是补丁，不是基线）。
  assert.strictEqual(
    a.revisions[0].beforeHash,
    b.revisions[0].beforeHash,
    '两次的改写前图相同 ⇒ beforeHash 必须相同'
  );
});

// ── F9：图改写不得引入代码执行 ───────────────────────────────────────────────

// 代码执行原语。`Function(` 单独列，覆盖 `new Function(` 与裸调用两种写法。
const CODE_EXEC = /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(|\bvm\s*\.\s*runIn|\bchild_process\b/;

// 图改写路径的**文件判定面**。它不是随手列的清单 —— 它由 `graphPatch.js` 的**直接依赖**派生，
// 并由下面那条「判定面自校验」测试钉住：往 `graphPatch.js` 里新增一个 require 而不同步登记，
// 那条测试就会变红（这是「白名单式判定面」唯一的自维护手段）。
const REWRITE_ROOT = 'src/services/domain/project/workflow/graphPatch.js';
const REWRITE_PATH_FILES = [
  REWRITE_ROOT,
  // graphPatch 的直接依赖。实测两者都是**叶子**（自身零 require）⇒ 闭包到此为止，
  // 所以「直接依赖闭包」在这里是有限且可机械枚举的。
  'src/services/domain/project/workflow/workflowCliCore.js', // validateGraph —— 改写时被调用
  'src/services/domain/project/workflow/jsonExtract.js',     // extractFirstJson —— 解析 onVar 文本
];

test('F9：图改写路径的源码不含代码执行原语（剥离注释后断言）', () => {
  for (const rel of REWRITE_PATH_FILES) {
    const file = path.resolve(__dirname, '..', rel);
    assert.ok(fs.existsSync(file), `图改写路径的文件必须存在：${rel}`);
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    // 非平凡闸：`stripComments` 是「等长空白替换」。若它哪天把文件剥空（或误判整段为注释），
    // 下面的断言会**静默通过** —— 那是典型的恒真断言。先钉住「剥离后仍有真实代码」。
    assert.ok(
      code.replace(/\s+/g, '').length > 500,
      `${rel} 剥离注释后仅剩 ${code.replace(/\s+/g, '').length} 个非空白字符 —— 剥离器疑似失效，断言会变成恒真`
    );
    assert.ok(code.includes('module.exports'), `${rel} 剥离注释后应仍含 module.exports（非平凡闸）`);
    const hit = CODE_EXEC.exec(code);
    assert.strictEqual(
      hit,
      null,
      `${rel} 的**代码**里出现了代码执行原语 ${hit && hit[0]} —— 图改写只收数据，不得成为执行通道`
    );
  }
});

test('F9 判定面自校验：graphPatch 的直接依赖必须全部登记（新增 require ⇒ 本测试变红）', () => {
  // 「守卫报绿」只等于「判定面内没问题」。手写清单的失效方式是**静默**的：
  // 新增一个依赖而忘了登记，上一条源码断言照样绿 —— 而那个新文件**不在判定面内**。
  // 这条测试把清单与真源钉在一起。
  const rootAbs = path.resolve(__dirname, '..', REWRITE_ROOT);
  const src = fs.readFileSync(rootAbs, 'utf8');
  const deps = [...src.matchAll(/require\(\s*'(\.[^']+)'\s*\)/g)].map((m) => m[1]);

  // 非平凡闸：解析器失效（正则被改坏）会让下面的断言恒真。
  assert.ok(deps.length >= 2, `只解析到 ${deps.length} 个相对依赖 —— 解析器疑似失效，断言会变恒真`);

  const resolved = deps.map((d) =>
    path.posix.join(path.posix.dirname(REWRITE_ROOT), d.endsWith('.js') ? d : `${d}.js`)
  );
  const missing = resolved.filter((r) => !REWRITE_PATH_FILES.includes(r));
  assert.deepStrictEqual(
    missing,
    [],
    `graphPatch.js 的直接依赖未登记进 F9 判定面：${missing.join(', ')} —— 不登记就不在判定面内，守卫会照样报绿`
  );
});

test('F9 有牙对照：注入一行 eval 会让上一条断言变红；仅出现在注释里则不算', () => {
  // ① 仪器有牙：合成源码里的真代码 eval 必须被识别。
  assert.ok(CODE_EXEC.test(stripComments('const x = 1; eval("pwn");')), '仪器必须能识别真代码 eval');
  assert.ok(CODE_EXEC.test(stripComments('const f = new Function("a", "return a");')), '必须能识别 new Function');

  // ② 跳过注释：仅出现在注释里的原语不算违规（本仓判据：新守卫必须跳过注释行，
  //    否则会重演 build_docs_site.js:126 那类「注释/属性被误报」）。
  assert.strictEqual(
    CODE_EXEC.exec(stripComments('// eval("pwn") 只是注释\nconst x = 1;')),
    null,
    '注释里的原语不得被判违规'
  );
  assert.strictEqual(
    CODE_EXEC.exec(stripComments('/* new Function("x") */\nconst y = 2;')),
    null,
    '块注释里的原语不得被判违规'
  );
});

test('F9：补丁载荷一律当数据 —— 代码样文本不执行（哨兵），未知算子被拒', async () => {
  // 把「代码样文本」塞进节点 data，并让它真的被跑到（interpolate 会读它）。
  const payload = 'globalThis.__f9pwned = 1; // {{n}}';
  delete globalThis.__f9pwned;

  const { primitives, res } = await runOnce(payload);

  assert.strictEqual(res.status, 'completed');
  assert.strictEqual(globalThis.__f9pwned, undefined, '补丁载荷绝不能被求值（哨兵必须仍为 undefined）');
  // 载荷被**原样当文本**处理：{{n}} 被插值，其余字符逐字保留。
  assert.deepStrictEqual(primitives.seen, [`globalThis.__f9pwned = 1; // A`], '载荷必须作为文本被插值使用');

  // 算子白名单是封闭的 ⇒ 补丁无法夹带新算子（例如把改写变成执行）。
  const smuggled = await applyPatch(rewriteGraph(), [{ op: 'exec', cmd: 'rm -rf /' }], CAPS);
  assert.strictEqual(smuggled.ok, false, '未知算子必须被拒（封闭白名单）');
  assert.ok(
    /未知算子|不被允许|not allowed/.test(smuggled.errors.join(' ')),
    `拒绝理由应说明算子不被允许，实际：${smuggled.errors.join(' ')}`
  );

  delete globalThis.__f9pwned;
});
