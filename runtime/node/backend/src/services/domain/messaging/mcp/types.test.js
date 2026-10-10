/**
 * types.test.js — 钉死 MCP 类型层（枚举冻结 / 校验器 / 名字归一化 / 序列化）的真实语义。
 *
 * 为什么这支套件必须存在：types.js 是 mcp 功能单元的叶子——index.js、toolPool、
 * mcpServerProtocol 全部经由它拿到 Transport/ConnectionState 与 serializeTool。
 * 它没有任何共置测试，而它的校验器是"半总函数"：validateServerConfig 对 null 返回
 * {valid:false}，但 validateStdioConfig/validateUrlConfig/serializeTool 对 null 直接
 * TypeError。没有测试钉住这一差异，任何"调用方会兜住"的直觉都会在子函数被单独调用时破裂。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. validateStdioConfig(null) / validateUrlConfig(null) / serializeTool(s, null) 抛
 *    TypeError（属性访问在 null 上），只有总线 validateServerConfig 是总函数 — 实测钉住。
 * 2. env: [] / headers: [] 能通过校验（typeof [] === 'object'），"must be an object"
 *    的报错文案对数组型脏输入不生效 — 实测钉住（已注册偏差：校验器接受数组 env）。
 * 3. normalizeMcpName(null) → ''（String 短路在 null 检查后），不是 'null'。
 * 4. serializeTool 的 annotations 取自 `(mcpTool && mcpTool.annotations) || {}`，
 *    但 mcpTool.name 的读取发生在其后 — null 工具仍抛，防御顺序自相矛盾 — 实测钉住。
 * 5. buildCliState 接受任何可迭代的 [name, conn] 条目（Map 或 entries 数组），
 *    传普通对象/ null 抛 TypeError；disabled/pending 连接的 tools 不进入顶层 tools。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('./types');

test('types: 导出面逐字钉死', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), [
    'ConfigScope',
    'ConnectionState',
    'Transport',
    'buildCliState',
    'normalizeMcpName',
    'serializeClient',
    'serializeTool',
    'validateServerConfig',
    'validateStdioConfig',
    'validateUrlConfig',
  ].sort());
});

test('types: 三个枚举 frozen 且字面量准确', () => {
  assert.ok(Object.isFrozen(leaf.Transport));
  assert.ok(Object.isFrozen(leaf.ConnectionState));
  assert.ok(Object.isFrozen(leaf.ConfigScope));
  assert.deepStrictEqual({ ...leaf.Transport }, { STDIO: 'stdio', SSE: 'sse', HTTP: 'http', WS: 'ws' });
  assert.deepStrictEqual({ ...leaf.ConnectionState }, {
    CONNECTED: 'connected', CONNECTING: 'connecting', FAILED: 'failed', PENDING: 'pending', DISABLED: 'disabled',
  });
  assert.deepStrictEqual({ ...leaf.ConfigScope }, { LOCAL: 'local', USER: 'user', DYNAMIC: 'dynamic' });
});

test('types: validateStdioConfig 空串 command 判不合法，数组 env 却放行（实测钉住偏差）', () => {
  const r = leaf.validateStdioConfig({ command: 'npx', args: ['-y', 'srv'], env: { A: '1' } });
  assert.ok(r.valid);
  assert.deepStrictEqual(r.errors, []);
  assert.deepEqual(leaf.validateStdioConfig({ command: '' }).errors, ['command is required and must be a non-empty string']);
  assert.deepEqual(leaf.validateStdioConfig({ command: 123 }).errors, ['command is required and must be a non-empty string']);
  // 数组 env：typeof [] === 'object' → 放行
  assert.ok(leaf.validateStdioConfig({ command: 'x', env: [] }).valid);
  // args 为字符串 → 报错
  assert.deepEqual(leaf.validateStdioConfig({ command: 'x', args: 'a b' }).errors, ['args must be an array of strings']);
  // env 为字符串 → 报错
  assert.deepEqual(leaf.validateStdioConfig({ command: 'x', env: 'A=1' }).errors,
    ['env must be an object mapping string keys to string values']);
});

test('types: validateStdioConfig(null) 抛 TypeError —— 半总函数注册', () => {
  assert.throws(() => leaf.validateStdioConfig(null), TypeError);
  assert.throws(() => leaf.validateStdioConfig(undefined), TypeError);
  assert.throws(() => leaf.validateUrlConfig(null), TypeError);
});

test('types: validateUrlConfig 空/数字 url 报错，数组 headers 放行（实测钉住）', () => {
  assert.ok(leaf.validateUrlConfig({ url: 'http://127.0.0.1:3737/mcp' }).valid);
  assert.deepEqual(leaf.validateUrlConfig({ url: '' }).errors, ['url is required and must be a non-empty string']);
  assert.deepEqual(leaf.validateUrlConfig({ url: 8080 }).errors, ['url is required and must be a non-empty string']);
  assert.ok(leaf.validateUrlConfig({ url: 'http://a', headers: [] }).valid);
  assert.deepEqual(leaf.validateUrlConfig({ url: 'http://a', headers: 'h' }).errors,
    ['headers must be an object mapping string keys to string values']);
});

test('types: validateServerConfig 是总函数：null 返回 invalid 而不抛', () => {
  assert.deepEqual(leaf.validateServerConfig(null), { valid: false, errors: ['config must be a non-null object'] });
  assert.deepEqual(leaf.validateServerConfig('stdio'), { valid: false, errors: ['config must be a non-null object'] });
  // type 缺省走 STDIO 分支
  assert.ok(leaf.validateServerConfig({ command: 'node' }).valid);
  // sse/http/ws 走 url 分支
  assert.ok(leaf.validateServerConfig({ type: 'sse', url: 'http://x' }).valid);
  assert.ok(leaf.validateServerConfig({ type: 'http', url: 'http://x' }).valid);
  assert.ok(leaf.validateServerConfig({ type: 'ws', url: 'ws://x' }).valid);
  // 未知 transport → 明确报 unknown
  assert.deepEqual(leaf.validateServerConfig({ type: 'grpc', command: 'x' }), { valid: false, errors: ['unknown transport type: grpc'] });
});

test('types: normalizeMcpName —— null→空串，非 [A-Za-z0-9_-] 全替换为下划线', () => {
  assert.equal(leaf.normalizeMcpName(null), '');
  assert.equal(leaf.normalizeMcpName(undefined), '');
  assert.equal(leaf.normalizeMcpName(''), '');
  assert.equal(leaf.normalizeMcpName('a-b_C0 9'), 'a-b_C0_9');
  assert.equal(leaf.normalizeMcpName('srv__tool'), 'srv__tool'); // 双下划线本身合法，不折叠
  assert.equal(leaf.normalizeMcpName('中文name'), '__name');
  assert.equal(leaf.normalizeMcpName(123), '123'); // 数字被 String() 收编
});

test('types: serializeTool 限定名用归一化段，originalToolName 保留原文', () => {
  const t = leaf.serializeTool('my srv!', { name: 'do it', description: 'd', inputSchema: { type: 'object' } });
  assert.equal(t.name, 'mcp__my_srv___do_it');
  assert.equal(t.originalToolName, 'do it');
  assert.equal(t.serverName, 'my srv!'); // 原文保留
  assert.equal(t.normalizedServerName, 'my_srv_');
  assert.equal(t.isMcp, true);
  assert.equal(t.isReadOnly, false);
  assert.equal(t.isDestructive, false);
  assert.deepStrictEqual(t.annotations, {});
  // 无 description → ''；无 inputSchema → 默认 object 壳
  const t2 = leaf.serializeTool('s', { name: 'x' });
  assert.equal(t2.description, '');
  assert.deepStrictEqual(t2.inputJSONSchema, { type: 'object', properties: {} });
  // 注释显式 true 才置位
  const t3 = leaf.serializeTool('s', { name: 'x', annotations: { readOnlyHint: true, destructiveHint: 'yes' } });
  assert.equal(t3.isReadOnly, true);
  assert.equal(t3.isDestructive, false); // 严格 === true，'yes' 不算
});

test('types: serializeTool(s, null) 抛 TypeError —— 防御顺序矛盾注册', () => {
  assert.throws(() => leaf.serializeTool('s', null), TypeError);
  assert.throws(() => leaf.serializeTool('s', undefined), TypeError);
});

test('types: serializeClient 字段映射与 undefined 折叠', () => {
  const c = leaf.serializeClient({
    name: 'srv', state: 'connected', tools: [{ name: 't' }],
    _lastError: 'boom',
  });
  assert.equal(c.name, 'srv');
  assert.equal(c.type, 'connected'); // state 被改名 type
  assert.equal(c.error, 'boom');
  assert.equal(c.capabilities, undefined);
  assert.equal(c.tools.length, 1);
  assert.equal(c.tools[0].name, 'mcp__srv__t');
  // error 回退 connection.error；_lastError 优先
  const c2 = leaf.serializeClient({ name: 'a', state: 'failed', error: 'e2', _lastError: 'e1' });
  assert.equal(c2.error, 'e1');
  const c3 = leaf.serializeClient({ name: 'a', state: 'failed', error: 'e2' });
  assert.equal(c3.error, 'e2');
  assert.throws(() => leaf.serializeClient(null), TypeError);
});

test('types: buildCliState —— 仅 connected 的 tools 上浮；resources 打 server 标', () => {
  const conns = new Map([
    ['good', { name: 'good', state: 'connected', config: { command: 'n' }, tools: [{ name: 't1' }], resources: [{ uri: 'r1' }] }],
    ['disabled', { name: 'disabled', state: 'disabled', tools: [{ name: 't2' }] }],
  ]);
  const s = leaf.buildCliState(conns);
  assert.equal(s.clients.length, 2);
  assert.equal(s.tools.length, 1); // disabled 的 t2 不上浮
  assert.equal(s.tools[0].name, 'mcp__good__t1');
  assert.deepStrictEqual(s.configs.good, { command: 'n' });
  assert.deepStrictEqual(s.configs.disabled, {}); // 无 config → {}
  assert.deepStrictEqual(s.resources.good, [{ uri: 'r1', server: 'good' }]);
  // entries 数组同样可迭代（非 Map 专属）
  const s2 = leaf.buildCliState([['x', { name: 'x', state: 'connected', tools: [] }]]);
  assert.deepEqual(Object.keys(s2.configs), ['x']);
  assert.throws(() => leaf.buildCliState(null), TypeError);
  assert.throws(() => leaf.buildCliState({}), TypeError);
});
