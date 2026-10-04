/**
 * ocMcpBridge.test.js — 钉死 OpenClaw MCP 资产复用桥的源枚举与 JSON5 容错解析。
 *
 * 为什么这支套件必须存在：这台桥把 <stateHome>/openclaw.json 的 `mcp.servers`
 * 折进 khy 的 loadConfig（最低优先级）。路径解析依赖 openclawHome 叶子的
 * env 覆盖序，JSON5 容错解析有 json5 依赖与自带 strip 回退两条路 —— 哪条路
 * 生效、失败方向是 null 还是抛，全须测钉。全程注入 env/homedir，不读真实家目录。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. ocMcpConfigSources 用注入 env 解析 state home；homedir/env 全空 → stateDir 为 ''
 *    → 返回 []（不猜家目录）。
 * 2. parseConfig('123') → null（数字不是对象），parseConfig('[1]') → 返回数组本体 —
 *    typeof [] === 'object' 闸放行 — 实测钉住。
 * 3. 本机 json5 依赖可用：注释/尾逗号/单引号走 json5 主路；_stripJsonc 回退路只在
 *    json5 缺失或解析抛时抵达 —— 回退路对本机是死码（无法直接驱动，注册）。
 * 4. extractMcpServers 每台 `{...cfg}` 浅拷贝、空名剔除（与 cc 桥同形）。
 * 5. 门控 KHY_OPENCLAW_MCP_BRIDGE 用本地 _FALSY 四词。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('./ocMcpBridge');

test('ocBridge: 导出面', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), ['extractMcpServers', 'isOcMcpBridgeEnabled', 'ocMcpConfigSources', 'parseConfig']);
});

test('ocBridge: 门控 _FALSY 四词，默认 ON', () => {
  for (const off of ['0', 'false', 'off', 'no', 'OFF ']) {
    assert.equal(leaf.isOcMcpBridgeEnabled({ KHY_OPENCLAW_MCP_BRIDGE: off }), false, off);
  }
  for (const on of [undefined, null, '', '1', 'nope']) {
    assert.equal(leaf.isOcMcpBridgeEnabled({ KHY_OPENCLAW_MCP_BRIDGE: on }), true, JSON.stringify(on));
  }
  assert.equal(leaf.isOcMcpBridgeEnabled(), leaf.isOcMcpBridgeEnabled(process.env));
});

test('ocBridge: sources —— env 覆盖注入；空解析 → []；null 入参抛 TypeError', () => {
  const a = leaf.ocMcpConfigSources({ env: { KHY_OPENCLAW_DATA_HOME: 'D:/oc-home' } });
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'openclawJson');
  assert.ok(a[0].path.endsWith(require('path').sep + 'openclaw.json'));
  assert.ok(a[0].path.includes('oc-home'));
  const b = leaf.ocMcpConfigSources({ env: { OPENCLAW_STATE_DIR: 'D:/oc-state' } });
  assert.ok(b[0].path.includes('oc-state'));
  // 无任何覆盖且 homedir 未给 → stateDir '' → []（不猜真实家目录）
  assert.deepEqual(leaf.ocMcpConfigSources({ env: {} }), []);
  assert.deepEqual(leaf.ocMcpConfigSources({}), []);
  assert.throws(() => leaf.ocMcpConfigSources(null), TypeError); // 参数位解构
});

test('ocBridge: parseConfig —— 非字符串/空白 null；JSON5 宽容；数组放行；坏文本 null', () => {
  assert.equal(leaf.parseConfig(undefined), null);
  assert.equal(leaf.parseConfig(''), null);
  assert.equal(leaf.parseConfig('   '), null);
  assert.equal(leaf.parseConfig(42), null);
  assert.equal(leaf.parseConfig('123'), null);
  assert.deepEqual(leaf.parseConfig('[1,2]'), [1, 2]); // 数组通过 typeof-object 闸 — 实测钉住
  const cfg = leaf.parseConfig(`{
    // 行注释
    mcp: { servers: { fs: { command: 'npx', } } }, // JSON5 尾逗号+单引号+裸键
  }`);
  assert.deepEqual(cfg, { mcp: { servers: { fs: { command: 'npx' } } } });
  assert.equal(leaf.parseConfig('{{{ total junk'), null);
});

test('ocBridge: extractMcpServers —— mcp.servers 路径；浅拷贝；脏形全兜 {}', () => {
  const raw = { mcp: { servers: { fs: { command: 'c', env: { K: 'V' } }, '': { command: 'ghost' }, bad: null } } };
  const out = leaf.extractMcpServers(raw);
  assert.deepEqual(Object.keys(out), ['fs']);
  assert.notEqual(out.fs, raw.mcp.servers.fs);
  out.fs.command = 'M';
  assert.equal(raw.mcp.servers.fs.command, 'c');
  assert.equal(out.fs.env.K, 'V');
  assert.deepEqual(leaf.extractMcpServers(null), {});
  assert.deepEqual(leaf.extractMcpServers({}), {});
  assert.deepEqual(leaf.extractMcpServers({ mcp: null }), {});
  assert.deepEqual(leaf.extractMcpServers({ mcp: { servers: 'str' } }), {});
  assert.deepEqual(leaf.extractMcpServers({ mcpServers: { x: { command: 'wrong-key' } } }), {}); // 只认 mcp.servers
  assert.deepEqual(leaf.extractMcpServers([1, 2]), {}); // 数组 raw 无 mcp → {}
});
