/**
 * toolPool.test.js — 钉死 MCP 工具池重建的闭包派发、披露决策接线与永不抛边界。
 *
 * 为什么这支套件必须存在：toolPool 是把外部 MCP 工具变成"可调用"注册工具的
 * 唯一链路：每次 sync 先清 MCP 分区再重注册（断开的服务器不留残影），execute
 * 闭包携带 ORIGINAL 工具名（不靠 lossy 反解析限定名）。披露决策（deferred/inline）
 * 在这里整分区一次性生效——方向错就把整套 MCP 工具注册成常驻或常驻失效。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. annotateDescription：readOnly 与 destructive 同真时只标 (readOnly)——破坏性
 *    标注被只读吞掉显示层 — 实测钉住；null description → '(readOnly)'（trim 后无前导空格）。
 * 2. buildCallableTool：originalToolName 为 null/undefined 时回落限定名 serialized.name；
 *    execute(params) 默认参数只兜 undefined，传 null 由 `params || {}` 兜住。
 * 3. sync(null) 与 refresh(null) 都抛 TypeError：解构在参数位，refresh 的内部 try
 *    够不着；"NEVER throws"只对体内路径（manager 抛错）成立 — 实测钉住。
 * 4. 披露开关走 process.env（isDisclosureEnabled，注入不到）：本测用 withEnv 显式控制。
 * 5. refresh 空闲路径（无服务器无残影）仍构造 disclosure 对象（toolCount:0, mode inline）。
 * 6. client.listTools 返回 null → 当空集；返回含无名条目的数组 → 无名条目跳过。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-toolpool-'));
const savedEnv = {
  KHY_DATA_HOME: process.env.KHY_DATA_HOME,
  KHY_PROJECT_DATA_HOME: process.env.KHY_PROJECT_DATA_HOME,
  KHY_APP_HOME: process.env.KHY_APP_HOME,
  KHY_MCP_DISCLOSURE: process.env.KHY_MCP_DISCLOSURE,
};
process.env.KHY_DATA_HOME = TMP;
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'proj');
process.env.KHY_APP_HOME = path.join(TMP, 'apphome');

const leaf = require('./toolPool');

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { return fn(); } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('toolPool: 导出面', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), ['annotateDescription', 'buildCallableTool', 'refreshMcpToolPool', 'syncMcpToolsToRegistry']);
});

test('toolPool: annotateDescription —— readOnly 优先，null base trim', () => {
  assert.equal(leaf.annotateDescription('do things', { isReadOnly: true }), 'do things (readOnly)');
  assert.equal(leaf.annotateDescription('do', { isDestructive: true }), 'do (destructive)');
  assert.equal(leaf.annotateDescription('do', { isReadOnly: true, isDestructive: true }), 'do (readOnly)'); // 破坏标注被吃 — 实测钉住
  assert.equal(leaf.annotateDescription('do', {}), 'do');
  assert.equal(leaf.annotateDescription(null, { isReadOnly: true }), '(readOnly)');
  assert.equal(leaf.annotateDescription('', undefined), '');
});

test('toolPool: buildCallableTool —— originalToolName 闭包派发，null params 兜 {}', async () => {
  const calls = [];
  const client = { async callTool(name, params) { calls.push({ name, params }); return { ok: 1 }; } };
  const t = leaf.buildCallableTool({ name: 'mcp__srv__tool_x', originalToolName: 'tool x!', description: 'd', isReadOnly: true }, client);
  assert.equal(t.name, 'mcp__srv__tool_x');
  assert.equal(t.category, 'mcp');
  assert.equal(t.description, 'd (readOnly)');
  assert.equal(t.isReadOnly, true);
  assert.equal(t.isDestructive, false);
  assert.equal('shouldDefer' in t, false);
  assert.equal(t.isEnabled(), true);
  await t.execute({ a: 1 });
  assert.equal(calls[0].name, 'tool x!'); // 用 ORIGINAL 名，不是限定名
  await t.execute();                       // undefined → {}
  assert.deepEqual(calls[1].params, {});
  await t.execute(null);                   // null 由 `params || {}` 兜住
  assert.deepEqual(calls[2].params, {});
  // originalToolName 缺失 → 回落限定名
  const t2 = leaf.buildCallableTool({ name: 'mcp__s__q' }, client);
  assert.deepEqual(t2.inputSchema, { type: 'object', properties: {} });
  await t2.execute({});
  assert.equal(calls[3].name, 'mcp__s__q');
  // shouldDefer 只加真值
  const t3 = leaf.buildCallableTool({ name: 'n' }, client, { shouldDefer: true });
  assert.equal(t3.shouldDefer, true);
});

function makeFakeReg() {
  const reg = {
    registered: [],
    cleared: 0,
    stale: [],
    register(tool, opts) { this.registered.push({ tool, opts }); },
    clearMcpTools() { this.cleared += 1; this.registered = []; },
    getMcpToolNames() { return this.stale; },
  };
  return reg;
}

test('toolPool: sync —— 先清分区、坏 client/坏条目跳过、listTools 抛兜空', () => {
  withEnv('KHY_MCP_DISCLOSURE', undefined, () => {
    const reg = makeFakeReg();
    const goodClient = {
      listTools: () => [
        { name: 'mcp__a__t1', originalToolName: 't1', description: 'd1' },
        null,
        { description: '无名条目' },
      ],
      callTool: async () => ({ done: true }),
    };
    const throwClient = { listTools: () => { throw new Error('boom'); }, callTool: async () => ({}) };
    const manager = {
      getConnectedServers: () => ['a', 'throws', 'missing', 'noCall'],
      getClient: (n) => {
        if (n === 'a') return goodClient;
        if (n === 'throws') return throwClient;
        if (n === 'missing') return null;
        if (n === 'noCall') return { listTools: () => [{ name: 'x' }] }; // 缺 callTool → 整 client 跳
        return undefined;
      },
    };
    const res = leaf.syncMcpToolsToRegistry({ manager, registry: reg });
    assert.equal(reg.cleared, 1);
    assert.deepEqual(res.registered, ['mcp__a__t1']); // 无名/null/坏 client 全跳
    assert.deepEqual(res.servers, ['a', 'throws', 'missing', 'noCall']);
    assert.deepEqual(reg.registered[0].opts, { isMcp: true });
    assert.equal(reg.registered[0].tool.name, 'mcp__a__t1');
    assert.equal(res.disclosure.mode, 'inline'); // 单小工具远不到预算
  });
});

test('toolPool: 整分区 deferred 决策 —— 巨量目录越预算时全量 shouldDefer', () => {
  withEnv('KHY_MCP_DISCLOSURE', undefined, () => {
    const reg = makeFakeReg();
    const big = 'x'.repeat(5000);
    const tools = Array.from({ length: 5 }, (_, i) => ({ name: `mcp__s__t${i}`, description: big }));
    const client = { listTools: () => tools, callTool: async () => ({}) };
    const manager = { getConnectedServers: () => ['s'], getClient: () => client };
    const res = leaf.syncMcpToolsToRegistry({ manager, registry: reg });
    assert.equal(res.disclosure.mode, 'deferred'); // 5×5000 char ≈ 6250 tok > 4800 默认预算
    assert.equal(reg.registered.length, 5);
    assert.ok(reg.registered.every((r) => r.tool.shouldDefer === true)); // 整分区一致 deferred
    // 门控关 → 永远 inline
    withEnv('KHY_MCP_DISCLOSURE', '0', () => {
      const reg2 = makeFakeReg();
      const res2 = leaf.syncMcpToolsToRegistry({ manager, registry: reg2 });
      assert.equal(res2.disclosure.mode, 'inline');
      assert.ok(reg2.registered.every((r) => !('shouldDefer' in r.tool)));
    });
  });
});

test('toolPool: sync(null) 与 refresh(null) 都在参数位抛 TypeError（try 够不着解构）', () => {
  assert.throws(() => leaf.syncMcpToolsToRegistry(null), TypeError);
  assert.throws(() => leaf.refreshMcpToolPool(null), TypeError); // 内部 try 在函数体，解构先炸 — "绝不抛"仅对体内路径成立
});

test('toolPool: refresh —— 空闲 no-op / 残影清理 / 正常委托 / 抛兜底', () => {
  withEnv('KHY_MCP_DISCLOSURE', undefined, () => {
    // 无服务器无残影
    const reg1 = makeFakeReg();
    const m1 = { getConnectedServers: () => [] };
    const r1 = leaf.refreshMcpToolPool({ manager: m1, registry: reg1 });
    assert.deepEqual({ refreshed: r1.refreshed, registered: r1.registered, servers: r1.servers }, { refreshed: false, registered: [], servers: [] });
    assert.equal(r1.disclosure.toolCount, 0);
    assert.equal(reg1.cleared, 0); // 空闲不churn
    // 残影存在 → 清一次
    const reg2 = makeFakeReg();
    reg2.stale = ['mcp__gone__t'];
    const r2 = leaf.refreshMcpToolPool({ manager: m1, registry: reg2 });
    assert.equal(r2.refreshed, true);
    assert.equal(reg2.cleared, 1);
    // 正常委托 sync
    const client = { listTools: () => [{ name: 'mcp__x__t' }], callTool: async () => ({}) };
    const reg3 = makeFakeReg();
    const r3 = leaf.refreshMcpToolPool({ manager: { getConnectedServers: () => ['x'], getClient: () => client }, registry: reg3 });
    assert.equal(r3.refreshed, true);
    assert.deepEqual(r3.registered, ['mcp__x__t']);
    // manager 抛 → 兜底对象（disclosure null 与空闲路径的 disclosure 对象不对称 — 实测钉住）
    const r4 = leaf.refreshMcpToolPool({ manager: { getConnectedServers() { throw new Error('x'); } }, registry: reg3 });
    assert.deepEqual(r4, { refreshed: false, registered: [], servers: [], disclosure: null });
  });
});
