/**
 * index.test.js — 钉死 MCP 客户端壳（index.js）的纯同步面、配置合并语义与失败路径。
 *
 * 为什么这支套件必须存在：index.js 是 MCP 客户端的总线——1841 行，对外 24 个导出，
 * 既管配置读写（loadConfig/saveConfig + mtime 缓存），又管连接登记（_connections 单例）
 * 与工具/资源/提示词派发。此前它**没有任何共置测试**：同目录 20 个叶子都有 .test.js，
 * 唯独这根总线是裸的。它的失败路径全部 fail-soft（坏配置吞、损坏 JSON 跳过、死传输吞），
 * 没有测试就没有人能证明"它吞的是错的那一个"。本套件只测无需真实连接即可达的语义：
 * 构造默认、能力协商校验、服务端请求派发表、配置 precedence/缓存失效、
 * 以及 connectMCPServer/connectAll 的报错归类——绝不 spawn 进程、绝不打真实端口。
 *
 * 实测更正（与源码注释/直觉不同处，按真实行为钉死，缺陷只注册不修）：
 * 1. CLIENT_CAPABILITIES 只有 roots（B 注释自陈 sampling/elicitation 未实现）——
 *    与"tools/resources/prompts"的内联旧形态完全不同，能力虚报已修但必须钉住不回退。
 * 2. saveConfig 只剥 `_scope/_configPath/_disabled` 三个内部字段，`_ccBridged`
 *    等桥接标记【原样落盘】并会在下次 loadConfig 被重新折进 _scope/_configPath — 缺陷 B30-1。
 * 3. connectAll 对 disabled 服务器把 onProgress 报成 type:'connected'
 *    （index.js:1427），尽管它既不进 result.connected 也不进 result.failed — 缺陷 B30-2。
 * 4. connectMCPServer 先 set 进 _connections 再 await connect（index.js:1382-1384），
 *    connect 抛错时客户端【滞留在单例 Map】里（state=failed），只能靠后续
 *    disconnectMCPServer/disconnectAll 清掉 — 缺陷 B30-3。
 * 5. loadConfig 对损坏 JSON fail-soft 返回 {mcpServers:{}} 且 console.warn，绝不抛 — 实测钉住。
 * 6. WS 传输通过 validateServerConfig（types.js 承认 ws），但 connect() 在分支里
 *    直接抛 "Transport \"ws\" is not yet supported" — 校验与实现分叉，实测钉住。
 * 7. _checkProtocolVersion 版本不匹配时把 this.protocolVersion 记成【服务端给的版本】
 *    （而非请求版本），返回 false 但不断开 — 实测钉住。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 数据主目录隔离：必须在 require 总线（及其牵出的 oauthTokenStore / dataHome / 日志器）之前钉住 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mcp-index-'));
const DATA = path.join(TMP, 'datahome');
const SAVED_ENV = {
  KHY_DATA_HOME: process.env.KHY_DATA_HOME,
  KHY_PROJECT_DATA_HOME: process.env.KHY_PROJECT_DATA_HOME,
  KHY_APP_HOME: process.env.KHY_APP_HOME,
  KHY_CC_MCP_BRIDGE: process.env.KHY_CC_MCP_BRIDGE,
  KHY_OPENCLAW_MCP_BRIDGE: process.env.KHY_OPENCLAW_MCP_BRIDGE,
  KHY_MCP_ECOSYSTEM: process.env.KHY_MCP_ECOSYSTEM,
};
process.env.KHY_DATA_HOME = DATA;
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'projhome');
process.env.KHY_APP_HOME = path.join(TMP, 'apphome');
// 关掉三条外部桥接，否则 loadConfig 会去读真实 ~/.claude.json 等，污染断言。
process.env.KHY_CC_MCP_BRIDGE = '0';
process.env.KHY_OPENCLAW_MCP_BRIDGE = '0';
process.env.KHY_MCP_ECOSYSTEM = '0';

const mod = require('./index');

const USER_CONFIG = path.join(DATA, 'mcp.json'); // CONFIG_PATHS.user 解析到 KHY_DATA_HOME/mcp.json
fs.mkdirSync(DATA, { recursive: true });

// 用户档写入 + 强制 mtime 前移（避免同一毫秒内 writeFileSync 不改 mtime 令缓存命中）。
function writeUserConfig(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  fs.writeFileSync(USER_CONFIG, text, 'utf-8');
  const st = fs.statSync(USER_CONFIG);
  fs.utimesSync(USER_CONFIG, st.atime, new Date(st.mtime.getTime() + 60_000));
}
function rmUserConfig() {
  try { fs.unlinkSync(USER_CONFIG); } catch { /* 不存在即可 */ }
}
// 每次改动 _connections 后清干净，防跨用例串味。
async function drainConnections() {
  await mod.disconnectAll();
}

test.after(async () => {
  await mod.disconnectAll().catch(() => {});
  rmUserConfig();
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // 故意不 rmSync(TMP)：authenticate() 会让 oauthTokenStore 惰性装一个滚动日志器，
  // 其 WriteStream 指向 KHY_DATA_HOME/logs/active/*.log。测试结束后仍有一次异步落盘，
  // 若此时删目录会得到假红 ENOENT uncaughtException。TMP 落在 os.tmpdir（仓外），
  // 不影响 git status，交由系统回收。
});

// ────────────────────────────────────────────────────────────────────────────

test('导出面：24 个键逐字钉死', () => {
  assert.deepStrictEqual(Object.keys(mod).sort(), [
    'CLIENT_CAPABILITIES', 'ConfigScope', 'ConnectionState', 'MCPClient', 'PROTOCOL_VERSION', 'Transport',
    'authenticate', 'callMCPTool', 'callTool', 'connectAll', 'connectMCPServer', 'disconnectAll',
    'disconnectMCPServer', 'getClient', 'getConnectedServers', 'getMCPInstructions', 'getPrompt',
    'getState', 'listMCPTools', 'listPrompts', 'listResources', 'loadConfig', 'readResource', 'saveConfig',
  ]);
  assert.equal(Object.keys(mod).length, 24);
});

test('协议常量：PROTOCOL_VERSION 单一真源 + CLIENT_CAPABILITIES 只声明 roots 且 frozen', () => {
  assert.equal(mod.PROTOCOL_VERSION, '2024-11-05');
  assert.ok(Object.isFrozen(mod.CLIENT_CAPABILITIES));
  // 实测更正①：客户端能力只有 roots，sampling/elicitation/tools 一律不声明。
  assert.deepStrictEqual({ ...mod.CLIENT_CAPABILITIES }, { roots: {} });
  deepEqualEnums();
});
function deepEqualEnums() {
  assert.deepStrictEqual({ ...mod.Transport }, { STDIO: 'stdio', SSE: 'sse', HTTP: 'http', WS: 'ws' });
  assert.deepStrictEqual({ ...mod.ConnectionState }, {
    CONNECTED: 'connected', CONNECTING: 'connecting', FAILED: 'failed', PENDING: 'pending', DISABLED: 'disabled',
  });
  assert.deepStrictEqual({ ...mod.ConfigScope }, { LOCAL: 'local', USER: 'user', DYNAMIC: 'dynamic' });
}

test('MCPClient 构造默认：transport 缺省 stdio、超时 30s/60s、state=pending、集合全空', () => {
  const c = new mod.MCPClient('srv', {});
  assert.equal(c.name, 'srv');
  assert.equal(c.transportType, mod.Transport.STDIO);
  assert.equal(c.state, mod.ConnectionState.PENDING);
  assert.equal(c.connectTimeout, 30_000);
  assert.equal(c.requestTimeout, 60_000);
  assert.equal(c.instructions, null);
  assert.equal(c.protocolVersion, null);
  assert.equal(c.serverInfo, null);
  assert.equal(c._lastError, null);
  assert.equal(c._reconnectAttempt, 0);
  assert.deepStrictEqual(c._tools, []);
  assert.deepStrictEqual(c._resources, []);
  assert.deepStrictEqual(c._prompts, []);
  assert.equal(c._process, null);
  assert.equal(c._sessionId, null);
});

test('MCPClient options 覆盖：connectTimeout/requestTimeout 走 options，缺省走常量', () => {
  const c = new mod.MCPClient('s', { type: 'sse', url: 'http://x' }, { connectTimeout: 100, requestTimeout: 200 });
  assert.equal(c.transportType, 'sse');
  assert.equal(c.connectTimeout, 100);
  assert.equal(c.requestTimeout, 200);
  // options 传 0 被 || 吞回落默认（falsy），实测钉住。
  const z = new mod.MCPClient('s', {}, { connectTimeout: 0, requestTimeout: 0 });
  assert.equal(z.connectTimeout, 30_000);
  assert.equal(z.requestTimeout, 60_000);
});

test('空客户端只读快照：listTools/Resources/Prompts/getInstructions 与 toConnectionObject 字段', () => {
  const c = new mod.MCPClient('srv', { command: 'npx' });
  assert.deepStrictEqual(c.listTools(), []); // _tools 空 → serializeTool 不触发
  assert.deepStrictEqual(c.listResources(), []);
  assert.deepStrictEqual(c.listPrompts(), []);
  assert.equal(c.getInstructions(), null);
  assert.deepStrictEqual(c.tools, []);
  assert.deepStrictEqual(c.prompts, []);
  const snap = c.toConnectionObject();
  assert.equal(snap.name, 'srv');
  assert.equal(snap.type, 'pending'); // state 改名 type
  assert.equal(snap.maxReconnectAttempts, 3);
  assert.equal(snap.reconnectAttempt, 0);
  assert.deepStrictEqual(snap.tools, []);
  assert.deepStrictEqual(snap.resources, []);
  assert.equal(snap.error, null);
  assert.deepStrictEqual(snap.config, { command: 'npx' });
});

test('_checkProtocolVersion：匹配→true 记请求版本；不匹配→false 记服务端版本+emit；缺省→true 回落', () => {
  const ok = new mod.MCPClient('a', {});
  assert.equal(ok._checkProtocolVersion({ protocolVersion: mod.PROTOCOL_VERSION }), true);
  assert.equal(ok.protocolVersion, mod.PROTOCOL_VERSION);

  // 实测更正⑦：不匹配时 protocolVersion 记的是【服务端给的】版本，返回 false，且不断开。
  const bad = new mod.MCPClient('a', {});
  let evt = null;
  bad.on('protocolVersionMismatch', (e) => { evt = e; });
  assert.equal(bad._checkProtocolVersion({ protocolVersion: '9999-99-99' }), false);
  assert.equal(bad.protocolVersion, '9999-99-99');
  assert.match(bad._lastError, /protocol version mismatch: requested 2024-11-05, server offered 9999-99-99/);
  assert.deepEqual(evt, { requested: mod.PROTOCOL_VERSION, server: '9999-99-99', serverName: 'a' });

  const none = new mod.MCPClient('a', {});
  assert.equal(none._checkProtocolVersion({}), true);
  assert.equal(none.protocolVersion, mod.PROTOCOL_VERSION); // 缺省回落到请求版本
});

test('_dispatchServerRequest 派发表：ping→{}、roots/list→cwd 根、未支持方法抛 __rpcCode=-32601', async () => {
  const c = new mod.MCPClient('a', {});
  assert.deepStrictEqual(await c._dispatchServerRequest('ping', {}), {});
  const r = await c._dispatchServerRequest('roots/list', {});
  assert.equal(r.roots.length, 1);
  assert.equal(r.roots[0].name, 'cwd');
  assert.match(r.roots[0].uri, /^file:\/\//);
  // 只实现已声明的能力：其余方法回 -32601 而非静默丢弃。
  await assert.rejects(c._dispatchServerRequest('sampling/createMessage', {}), (err) => {
    assert.equal(err.__rpcCode, -32601);
    assert.match(err.message, /method not supported by this client: sampling\/createMessage/);
    return true;
  });
  assert.equal(c._serverRoots()[0].name, 'cwd');
});

test('_ensureConnected：pending 客户端的 callTool/readResource/getPrompt 全部报同一句 state 文案', async () => {
  const c = new mod.MCPClient('srv', {});
  const msg = 'MCP server "srv" is not connected (state: pending)';
  await assert.rejects(c.callTool('x'), (e) => (assert.equal(e.message, msg), true));
  await assert.rejects(c.readResource('u://r'), (e) => (assert.equal(e.message, msg), true));
  await assert.rejects(c.getPrompt('p'), (e) => (assert.equal(e.message, msg), true));
});

test('_sendNotification 对死传输 fail-soft：stdio 无进程时吞掉不抛', () => {
  const c = new mod.MCPClient('srv', {});
  // _writeRaw 对 stdio 无 process 会 throw，但 _sendNotification 必须吞掉（通知尽力而为）。
  assert.doesNotThrow(() => c._sendNotification('notifications/initialized', {}));
});

test('loadConfig: 无文件 → {mcpServers:{}} 且不抛', () => {
  rmUserConfig();
  assert.deepStrictEqual(mod.loadConfig(), { mcpServers: {} });
});

test('loadConfig: 损坏 JSON fail-soft → 跳过返回空、console.warn，绝不抛（实测更正⑤）', () => {
  rmUserConfig();
  writeUserConfig('{ this is not json');
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let out;
  try { out = mod.loadConfig(); } finally { console.warn = orig; }
  assert.deepStrictEqual(out, { mcpServers: {} });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /配置文件解析失败/);
  rmUserConfig();
});

test('loadConfig: 项目级覆盖用户级 —— precedence 与 _scope 标记（实测更正：project>user>legacy）', () => {
  rmUserConfig();
  writeUserConfig({ mcpServers: { shared: { command: 'user-val' }, onlyUser: { command: 'u' } } });
  const proj = path.join(TMP, 'proj');
  fs.mkdirSync(path.join(proj, 'works', 'data', 'khy'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'works', 'data', 'khy', 'mcp.json'), JSON.stringify({
    mcpServers: { shared: { command: 'proj-val' }, onlyProj: { command: 'p' } },
  }), 'utf-8');
  const m = mod.loadConfig(proj);
  assert.equal(m.mcpServers.shared.command, 'proj-val'); // 项目同名覆盖用户
  assert.equal(m.mcpServers.shared._scope, mod.ConfigScope.LOCAL);
  assert.equal(m.mcpServers.onlyUser.command, 'u');
  assert.equal(m.mcpServers.onlyUser._scope, mod.ConfigScope.USER);
  assert.equal(m.mcpServers.onlyProj._scope, mod.ConfigScope.LOCAL);
  rmUserConfig();
});

test('loadConfig: 旧格式 {servers:[...]} → 名字建 Map、enabled:false 折成 _disabled、无名项跳过', () => {
  rmUserConfig();
  writeUserConfig({ servers: [
    { name: 'a', command: 'x', enabled: false },
    { name: 'b', command: 'y' },
    { command: 'noname' }, // 无 name → continue 跳过
  ] });
  const m = mod.loadConfig();
  assert.deepStrictEqual(Object.keys(m.mcpServers), ['a', 'b']);
  assert.equal(m.mcpServers.a._disabled, true);
  assert.equal('enabled' in m.mcpServers.a, false); // enabled 被解构剥离
  assert.equal(m.mcpServers.b._disabled, undefined); // enabled 非 false → 不打 _disabled
});

test('loadConfig: 新格式 disabled:true 折成 _disabled 标记', () => {
  rmUserConfig();
  writeUserConfig({ mcpServers: { s: { command: 'c', disabled: true } } });
  const m = mod.loadConfig();
  assert.equal(m.mcpServers.s._disabled, true);
  rmUserConfig();
});

test('mtime 缓存失效：改动文件+mtime 前移 → 重新读盘反映新内容', () => {
  rmUserConfig();
  writeUserConfig({ mcpServers: { v: { command: 'first' } } });
  assert.equal(mod.loadConfig().mcpServers.v.command, 'first');
  writeUserConfig({ mcpServers: { v: { command: 'second' } } });
  assert.equal(mod.loadConfig().mcpServers.v.command, 'second'); // mtime 变了 → 缓存失效重读
  rmUserConfig();
});

test('saveConfig: 落用户档 + 内部字段剥离（_scope/_configPath/_disabled 剥，_ccBridged 泄漏——缺陷 B30-1）', () => {
  rmUserConfig();
  mod.saveConfig({ mcpServers: {
    s: { command: 'c', env: { K: '1' }, _scope: 'user', _configPath: 'X', _disabled: true, _ccBridged: true },
  } });
  const raw = JSON.parse(fs.readFileSync(USER_CONFIG, 'utf-8'));
  assert.deepStrictEqual(Object.keys(raw), ['mcpServers']);
  // 剥掉的三个内部字段不见了；但 _ccBridged 原样落盘 = 缺陷 B30-1。
  assert.equal('_scope' in raw.mcpServers.s, false);
  assert.equal('_configPath' in raw.mcpServers.s, false);
  assert.equal('_disabled' in raw.mcpServers.s, false);
  assert.equal(raw.mcpServers.s._ccBridged, true); // 泄漏 — 实测钉住缺陷
  assert.deepStrictEqual(raw.mcpServers.s.env, { K: '1' });
  // _disabled 被剥离 → 重载后 _disabled 变 false（禁用状态无法经 saveConfig 持久化）。
  const reloaded = mod.loadConfig();
  assert.equal(reloaded.mcpServers.s._disabled, false);
  assert.equal(reloaded.mcpServers.s._ccBridged, true); // 泄漏项经重载仍在
  rmUserConfig();
});

test('saveConfig: 无 mcpServers 键 → 写出 {mcpServers:{}}（config.mcpServers||{} 兜住）', () => {
  rmUserConfig();
  mod.saveConfig({});
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(USER_CONFIG, 'utf-8')), { mcpServers: {} });
  rmUserConfig();
});

test('callMCPTool: 非限定名/未知服务器 → 各自的报错形状', async () => {
  await assert.rejects(mod.callMCPTool('not-qualified'), (e) => {
    assert.match(e.message, /^Invalid MCP tool name: not-qualified\. Expected format: mcp__serverName__toolName$/);
    return true;
  });
  // parts[0]==='mcp' 但只有两段（长度 <3）也判非法。
  await assert.rejects(mod.callMCPTool('mcp__srv'), (e) => /Invalid MCP tool name/.test(e.message));
  // 合法限定名但服务器未注册 → not found（用归一化后的段）。
  await assert.rejects(mod.callMCPTool('mcp__ghost__tool'), (e) => {
    assert.equal(e.message, 'MCP server "ghost" not found');
    return true;
  });
});

test('callTool/readResource/getPrompt: 未知服务器一律 not found', async () => {
  await assert.rejects(mod.callTool('nope', 't'), (e) => (assert.equal(e.message, 'MCP server "nope" not found'), true));
  await assert.rejects(mod.readResource('nope', 'u://r'), (e) => (assert.equal(e.message, 'MCP server "nope" not found'), true));
  await assert.rejects(mod.getPrompt('nope', 'p'), (e) => (assert.equal(e.message, 'MCP server "nope" not found'), true));
  // listResources/listPrompts 对未知服务器静默返回空数组（不抛）。
  assert.deepStrictEqual(mod.listResources('nope'), []);
  assert.deepStrictEqual(mod.listPrompts('nope'), []);
});

test('空注册表只读面：listMCPTools/listResources/listPrompts/getConnectedServers/getState/getMCPInstructions', async () => {
  await drainConnections(); // 确保干净
  assert.deepStrictEqual(mod.listMCPTools(), []);
  assert.deepStrictEqual(mod.listResources(), []);
  assert.deepStrictEqual(mod.listPrompts(), []);
  assert.deepStrictEqual(mod.getConnectedServers(), []);
  assert.deepStrictEqual(mod.getMCPInstructions(), []);
  assert.deepStrictEqual(mod.getState(), { clients: [], configs: {}, tools: [], resources: {} });
});

test('getClient 未知→undefined；disconnectMCPServer 未知→静默 resolve', async () => {
  await drainConnections();
  assert.equal(mod.getClient('no-such'), undefined);
  await mod.disconnectMCPServer('no-such'); // 不抛、不建条目
});

test('connectMCPServer 失败后客户端滞留 _connections —— 缺陷 B30-3（state=failed，listMCPTools 仍 0）', async () => {
  await drainConnections();
  try {
    await assert.rejects(mod.connectMCPServer('bad', {}), (e) => {
      assert.match(e.message, /^Invalid config: command is required/);
      return true;
    });
    // 实测④：connect 抛错后客户端仍在单例 Map 里，state=failed。
    const stuck = mod.getClient('bad');
    assert.ok(stuck, 'failed 客户端应滞留 _connections（注册缺陷）');
    assert.equal(stuck.state, mod.ConnectionState.FAILED);
    // failed 非 connected → 工具快照仍空。
    assert.deepStrictEqual(mod.listMCPTools(), []);
    assert.equal(mod.getState().clients.length, 1); // buildCliState 仍列出 failed 客户端
  } finally {
    await drainConnections();
  }
});

test('connectMCPServer: WS 通过校验却报 "not yet supported" —— 校验/实现分叉（实测更正⑥）', async () => {
  await drainConnections();
  try {
    await assert.rejects(mod.connectMCPServer('ws', { type: 'ws', url: 'ws://x' }), (e) => {
      assert.equal(e.message, 'Transport "ws" is not yet supported');
      return true;
    });
    const c = mod.getClient('ws');
    assert.equal(c && c.state, mod.ConnectionState.FAILED); // 同样滞留（B30-3）
  } finally {
    await drainConnections();
  }
});

test('connectAll: 空配置返回 {connected:[],failed:[]}；disabled 谎报 progress type=connected —— 缺陷 B30-2', async () => {
  await drainConnections();
  rmUserConfig();
  assert.deepStrictEqual(await mod.connectAll(), { connected: [], failed: [] });

  writeUserConfig({ mcpServers: { d: { command: 'x', disabled: true }, bad: { command: '' } } });
  const events = [];
  const res = await mod.connectAll(undefined, (e) => events.push(e));
  // disabled 不进 connected 也不进 failed（归类正确）……
  assert.deepStrictEqual(res.connected, []);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].name, 'bad');
  // ……但 onProgress 对 disabled 报了 type:'connected'（缺陷 B30-2）。
  const dEvents = events.filter((e) => e.name === 'd');
  assert.equal(dEvents.length, 1);
  assert.equal(dEvents[0].type, 'connected'); // 应为 disabled，实测钉住谎报
  assert.equal(dEvents[0].done, 1);
  assert.equal(dEvents[0].total, 2);
  await drainConnections();
  rmUserConfig();
});

test('authenticate: api_key/token 缺凭据抛专词（store 只在缺 token 前被构造）', async () => {
  await assert.rejects(mod.authenticate('x', { method: 'api_key' }), (e) => {
    assert.equal(e.message, 'authenticate(x): a token/api_key credential is required');
    return true;
  });
  await assert.rejects(mod.authenticate('y', { method: 'token', credentials: {} }), (e) => {
    assert.match(e.message, /a token\/api_key credential is required/);
    return true;
  });
});
