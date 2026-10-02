/**
 * mcpServer.test.js — 钉死传输无关 server 引擎（假 registry 注入 + 真 registry 缺省路径）。
 *
 * 为什么这支套件必须存在：mcpServer 是 stdio/HTTP 两个传输共用的引擎核心，负责
 * 把协议叶子的错误语义（__mcpCode 自定义码 vs 兜底 -32603）与安全红线
 * （tools/call 只允许当前暴露集内的工具，隐藏工具不泄露）落到回包上。
 * 引擎可注入假 registry，因此全部路径可确定性驱动。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. handleMessage 对"已解析对象"入参走 JSON.stringify 往返，且 stringify 在 try 之外：
 *    循环引用对象 → Promise reject（TypeError），而不是 -32700 错误回包 — 偏差注册。
 * 2. tools/call 不在暴露集 → 主动抛 __mcpCode=-32602 的 invalid-params（而非 -32601），
 *    且不区分"存在但被策略隐藏"与"根本不存在"，回包同样 'tool not exposed: X'。
 * 3. registry.getEnabled() 返回非 Map 非数组（如字符串）→ 静默当空集，不抛。
 * 4. exposedTools 每次调用都先 registry.loadTools()（无缓存，动态 isEnabled 语义）。
 * 5. execute 抛普通错误 → -32603 且 id 用 parsed.id；通知无回包 null。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createServerCore } = require('./mcpServer');

function fakeTool(name, { risk = 'safe', readOnly = true } = {}) {
  return {
    name,
    risk,
    isReadOnly: () => readOnly,
    isDestructive: () => false,
    toFunctionDef: () => ({ name, description: `desc ${name}`, parameters: { type: 'object', properties: {} } }),
  };
}

function makeRegistry(opts = {}) {
  const state = { loadCalls: 0, executes: [] };
  const tools = opts.tools || [fakeTool('alpha'), fakeTool('beta')];
  const reg = {
    loadTools() { state.loadCalls += 1; },
    getEnabled() {
      if (opts.enabledShape === 'array') return tools;
      if (opts.enabledShape === 'garbage') return 'not-a-map';
      if (opts.enabledShape === 'none') return undefined;
      return new Map(tools.map((t) => [t.name, t]));
    },
    async execute(name, args, context) {
      state.executes.push({ name, args, context });
      if (opts.throwCode !== undefined) {
        const e = new Error(opts.throwMsg || 'custom throw');
        e.__mcpCode = opts.throwCode;
        throw e;
      }
      if (opts.throwPlain) throw new Error('kaboom');
      return { success: true, content: { ran: name, args } };
    },
  };
  if (opts.enabledShape === 'noLoad') delete reg.loadTools;
  if (opts.enabledShape === 'noGet') delete reg.getEnabled;
  return { reg, state };
}

const J = (o) => JSON.stringify(o);

test('mcpServer: 导出面只有 createServerCore', () => {
  assert.deepStrictEqual(Object.keys(require('./mcpServer')), ['createServerCore']);
});

test('mcpServer: initialize 协商回显客户端版本，serverInfo 带注入版本', async () => {
  const { reg } = makeRegistry();
  const core = createServerCore({ registry: reg, env: {}, version: '7.7.7' });
  const r = await core.handleMessage(J({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }));
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.deepEqual(r.result.serverInfo, { name: 'khy-os', version: '7.7.7' });
  assert.deepEqual(r.result.capabilities, { tools: {} });
  // 不认识的版本 → 回落 2024-11-05
  const r2 = await core.handleMessage(J({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }));
  assert.equal(r2.result.protocolVersion, '2024-11-05');
});

test('mcpServer: tools/list 每轮重枚举（loadTools 计数递增），假工具被转换', async () => {
  const { reg, state } = makeRegistry();
  const core = createServerCore({ registry: reg, env: {} });
  const r1 = await core.handleMessage(J({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
  assert.deepEqual(r1.result.tools.map((t) => t.name), ['alpha', 'beta']);
  assert.deepEqual(r1.result.tools[0].inputSchema, { type: 'object', properties: {} });
  const before = state.loadCalls;
  await core.handleMessage(J({ jsonrpc: '2.0', id: 4, method: 'tools/list' }));
  assert.ok(state.loadCalls > before, 'loadTools 应每次调用');
  // getEnabled 非 Map 形态
  const arr = makeRegistry({ enabledShape: 'array' });
  assert.equal((await createServerCore({ registry: arr.reg, env: {} }).handleMessage(J({ id: 5, method: 'tools/list' }))).result.tools.length, 2);
  const garbage = makeRegistry({ enabledShape: 'garbage' });
  assert.deepEqual((await createServerCore({ registry: garbage.reg, env: {} }).handleMessage(J({ id: 6, method: 'tools/list' }))).result.tools, []);
  const noGet = makeRegistry({ enabledShape: 'noGet' });
  assert.deepEqual((await createServerCore({ registry: noGet.reg, env: {} }).handleMessage(J({ id: 7, method: 'tools/list' }))).result.tools, []);
});

test('mcpServer: tools/call 走 execute 并透传 context；结果折成 MCP content', async () => {
  const ctxObj = { sessionId: 's1' };
  const { reg, state } = makeRegistry();
  const core = createServerCore({ registry: reg, env: {}, context: ctxObj });
  const r = await core.handleMessage(J({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'alpha', arguments: { k: 1 } } }));
  assert.equal(r.id, 8);
  assert.deepEqual(r.result.content, [{ type: 'text', text: J({ ran: 'alpha', args: { k: 1 } }) }]);
  assert.deepEqual(r.result.structuredContent, { ran: 'alpha', args: { k: 1 } });
  assert.equal(r.result.isError, false);
  assert.equal(state.executes.length, 1);
  assert.equal(state.executes[0].context, ctxObj); // 引用透传
});

test('mcpServer: 策略隐藏的工具调用回 -32602『tool not exposed』，不泄露存在性', async () => {
  const { reg } = makeRegistry({ tools: [fakeTool('safe1'), fakeTool('danger', { risk: 'high', readOnly: false })] });
  const core = createServerCore({ registry: reg, env: { KHY_MCP_SERVE_EXPOSE: 'safe' } });
  const list = await core.handleMessage(J({ id: 9, method: 'tools/list' }));
  assert.deepEqual(list.result.tools.map((t) => t.name), ['safe1']);
  const hidden = await core.handleMessage(J({ id: 10, method: 'tools/call', params: { name: 'danger' } }));
  assert.equal(hidden.error.code, -32602);
  assert.match(hidden.error.message, /tool not exposed: danger/);
  // 完全不存在的名字同款回包
  const ghost = await core.handleMessage(J({ id: 11, method: 'tools/call', params: { name: 'ghost' } }));
  assert.equal(ghost.error.code, -32602);
  // params 缺失 → name '' → 同样 -32602，message 尾随空名
  const noName = await core.handleMessage(J({ id: 12, method: 'tools/call' }));
  assert.equal(noName.error.code, -32602);
  assert.equal(noName.error.message, 'tool not exposed: ');
});

test('mcpServer: execute 抛 __mcpCode 用自定码；普通抛 → -32603 且带 id', async () => {
  const custom = makeRegistry({ throwCode: -32602, throwMsg: '参数不对' });
  const r1 = await createServerCore({ registry: custom.reg, env: {} }).handleMessage(J({ id: 13, method: 'tools/call', params: { name: 'alpha' } }));
  assert.equal(r1.error.code, -32602);
  assert.equal(r1.error.message, '参数不对');
  assert.equal(r1.id, 13);
  const plain = makeRegistry({ throwPlain: true });
  const r2 = await createServerCore({ registry: plain.reg, env: {} }).handleMessage(J({ id: 14, method: 'tools/call', params: { name: 'alpha' } }));
  assert.equal(r2.error.code, -32603);
  assert.equal(r2.error.message, 'kaboom');
});

test('mcpServer: 解析层错误分码 -32700 vs -32600；通知 → null', async () => {
  const { reg } = makeRegistry();
  const core = createServerCore({ registry: reg, env: {} });
  const bad = await core.handleMessage('{not json');
  assert.equal(bad.error.code, -32700);
  assert.equal(bad.id, null);
  const env1 = await core.handleMessage(J({ jsonrpc: '1.0', id: 15, method: 'ping' }));
  assert.equal(env1.error.code, -32600);
  const notif = await core.handleMessage(J({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(notif, null);
  const unknown = await core.handleMessage(J({ id: 16, method: 'shutdown' }));
  assert.equal(unknown.error.code, -32601);
});

test('mcpServer: 对象入参借 JSON 往返归一；循环引用对象 → Promise reject（偏差注册）', async () => {
  const { reg } = makeRegistry();
  const core = createServerCore({ registry: reg, env: {} });
  const r = await core.handleMessage({ jsonrpc: '2.0', id: 17, method: 'ping' });
  assert.deepEqual(r, { jsonrpc: '2.0', id: 17, result: {} });
  const circ = { jsonrpc: '2.0', id: 18, method: 'ping' };
  circ.self = circ;
  await assert.rejects(core.handleMessage(circ), TypeError); // stringify 在 try 外 — HTTP 层若裸调会 500
});

test('mcpServer: 缺省 registry 走真注册表（生产路径能列真工具）', async () => {
  const core = createServerCore({ env: {}, version: 'real-probe' });
  const list = await core.handleMessage(J({ id: 19, method: 'tools/list' }));
  assert.ok(Array.isArray(list.result.tools));
  assert.ok(list.result.tools.length > 0, '真注册表应暴露至少一个工具');
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.every((n) => typeof n === 'string' && n.length > 0));
});
