'use strict';

/**
 * Tests for the MCP auto-connect leaf (services/domain/messaging/mcp/autoConnect.js)
 * — the runtime trigger that was missing, leaving configured external MCP servers
 * unreachable. All scenarios use a fake manager + injected latch state; no
 * subprocess, no network.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  ensureMcpConnected,
  autoConnectEnabled,
  formatConnectFailure,
  formatConnectFailureSummary,
} = require('../src/services/domain/messaging/mcp/autoConnect');

/** Build a fake MCP manager recording connectAll calls. */
function makeManager({ servers = [], connectResult, connectThrows = false } = {}) {
  const calls = { connectAll: 0, loadConfig: 0, projectDirs: [] };
  return {
    calls,
    loadConfig(projectDir) {
      calls.loadConfig++;
      calls.projectDirs.push(projectDir);
      const mcpServers = {};
      for (const name of servers) mcpServers[name] = { command: 'echo', args: [name] };
      return { mcpServers };
    },
    async connectAll(projectDir) {
      calls.connectAll++;
      if (connectThrows) throw new Error('spawn failed');
      return connectResult || { connected: servers, failed: [] };
    },
  };
}

function freshState() { return { started: false }; }

test('gate ON + configured servers → connectAll invoked, returns connected', async () => {
  const manager = makeManager({ servers: ['fs', 'git'] });
  const res = await ensureMcpConnected({
    manager, env: {}, projectDir: '/proj', state: freshState(),
  });
  assert.strictEqual(manager.calls.connectAll, 1);
  assert.deepStrictEqual(res.connected, ['fs', 'git']);
  assert.deepStrictEqual(manager.calls.projectDirs[0], '/proj');
});

test('gate OFF (KHY_MCP_AUTOCONNECT=false) → connectAll NEVER invoked (legacy)', async () => {
  const manager = makeManager({ servers: ['fs'] });
  const res = await ensureMcpConnected({
    manager, env: { KHY_MCP_AUTOCONNECT: 'false' }, state: freshState(),
  });
  assert.strictEqual(manager.calls.connectAll, 0);
  assert.strictEqual(manager.calls.loadConfig, 0, 'must not even read config when disabled');
  assert.strictEqual(res.skipped, 'disabled');
});

test('gate OFF is case-insensitive (FALSE / False)', async () => {
  for (const v of ['FALSE', 'False', 'false']) {
    const manager = makeManager({ servers: ['fs'] });
    await ensureMcpConnected({ manager, env: { KHY_MCP_AUTOCONNECT: v }, state: freshState() });
    assert.strictEqual(manager.calls.connectAll, 0, `disabled for ${v}`);
  }
});

test('no servers configured → skip without spawning anything', async () => {
  const manager = makeManager({ servers: [] });
  const res = await ensureMcpConnected({ manager, env: {}, state: freshState() });
  assert.strictEqual(manager.calls.connectAll, 0);
  assert.strictEqual(res.skipped, 'no-servers');
});

test('one-shot latch → second call with same state is a no-op', async () => {
  const manager = makeManager({ servers: ['fs'] });
  const state = freshState();
  await ensureMcpConnected({ manager, env: {}, state });
  const res2 = await ensureMcpConnected({ manager, env: {}, state });
  assert.strictEqual(manager.calls.connectAll, 1, 'connectAll runs at most once per state');
  assert.strictEqual(res2.skipped, 'already-started');
});

test('best-effort: connectAll throwing is swallowed, returns error field', async () => {
  const manager = makeManager({ servers: ['fs'], connectThrows: true });
  const res = await ensureMcpConnected({ manager, env: {}, state: freshState() });
  assert.strictEqual(manager.calls.connectAll, 1);
  assert.ok(res.error && /spawn failed/.test(res.error));
});

test('manager without connectAll → graceful skip (unsupported)', async () => {
  const manager = makeManager({ servers: ['fs'] });
  delete manager.connectAll;
  const res = await ensureMcpConnected({ manager, env: {}, state: freshState() });
  assert.strictEqual(res.skipped, 'unsupported');
});

test('autoConnectEnabled default ON when unset', () => {
  assert.strictEqual(autoConnectEnabled({}), true);
  assert.strictEqual(autoConnectEnabled({ KHY_MCP_AUTOCONNECT: 'true' }), true);
  assert.strictEqual(autoConnectEnabled({ KHY_MCP_AUTOCONNECT: 'false' }), false);
});

test('failed connections are surfaced in the result', async () => {
  const manager = makeManager({
    servers: ['fs', 'broken'],
    connectResult: { connected: ['fs'], failed: [{ name: 'broken', error: 'ENOENT' }] },
  });
  const res = await ensureMcpConnected({ manager, env: {}, state: freshState() });
  assert.deepStrictEqual(res.connected, ['fs']);
  assert.strictEqual(res.failed.length, 1);
  assert.strictEqual(res.failed[0].name, 'broken');
});

// --- 用户可见文案（措辞锁定）------------------------------------------------
//
// 这组用例存在的理由不是「函数能跑」，而是**锁死措辞**：MCP server 是可选工具，
// 连不上不影响页面/对话；历史上失败行用 ✗（红色叉）被读成「khy 启动出错」，
// 让一个无害噪声混进了「启动慢」的抱怨。措辞一旦被改回 ✗ 或丢掉「可选」定性，
// 必须有人（或 CI）当场知道 —— 所以这里逐字断言，不做模糊匹配。

test('failed-connect 文案：含未连接事实 + 「可选/不影响使用」定性，且不用 ✗', () => {
  const s = formatConnectFailure({ name: 'deepseek-eyes', error: 'ETIMEDOUT' });
  assert.strictEqual(s, '! deepseek-eyes 未连接（可选工具，不影响使用）: ETIMEDOUT');
  assert.ok(!s.includes('✗'), 'must not use the red-cross glyph (read as "startup error")');
});

test('failed-connect 文案：带进度前缀时保留 [done/total pct%] 形状', () => {
  const s = formatConnectFailure({ name: 'fs', error: 'ENOENT' }, { done: 2, total: 3 });
  assert.strictEqual(s, '[2/3  66.7%] ! fs 未连接（可选工具，不影响使用）: ENOENT');
});

test('failed-connect 文案：缺字段也不抛，降级为 unknown 占位', () => {
  assert.strictEqual(formatConnectFailure(null), '! unknown 未连接（可选工具，不影响使用）: unknown error');
  assert.strictEqual(formatConnectFailure({}), '! unknown 未连接（可选工具，不影响使用）: unknown error');
});

test('failed-connect 文案：进度字段非有限数时不加前缀（不产出 NaN%）', () => {
  const s = formatConnectFailure({ name: 'fs', error: 'x' }, { done: NaN, total: 3 });
  assert.ok(!s.includes('NaN'), 'NaN must never leak into a user-facing line');
  assert.ok(s.startsWith('! fs'));
});

test('整轮汇总文案：计数正确 + 「不影响页面与对话」定性', () => {
  assert.strictEqual(
    formatConnectFailureSummary([{}, {}, {}]),
    '3 个可选工具未连接（不影响页面与对话，需要时可在设置里重连）:'
  );
  assert.strictEqual(
    formatConnectFailureSummary(null),
    '0 个可选工具未连接（不影响页面与对话，需要时可在设置里重连）:'
  );
});
