/**
 * autoConnect.test.js — 钉死一次性自动连接闸门的关闭词汇与闩式消耗顺序。
 *
 * 为什么这支套件必须存在：ensureMcpConnected 是生产里唯一真正调 connectAll() 的
 * 触发器，契约是"best-effort 绝不抛 + 每进程一次"。两个高价值方向必须测钉：
 * ①门控关闭词汇（文档承诺 "Setting it to false"，实现确实只认 'false'，但和
 * 全仓 CANON 四词族不一致——'0'/'off'/'no' 都关不掉它）；②latch 在门控检查之前
 * 置位，门控关闭的那次调用照样吃掉一次性闩。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. 关词只有字面 'false'（case-insensitive）：'0'/'off'/'no'/数字 0/' false'
 *    （前导空格，无 trim）全部保持 ON — 与 mcpServerStatus/_FALSY 四词族分歧 — 偏差注册。
 * 2. `st.started = true` 发生在门控判定之前：KHY_MCP_AUTOCONNECT=false 的首次调用
 *    返回 {skipped:'disabled'} 但已消耗闩，第二次调用返回 'already-started' — 实测钉住。
 * 3. manager.loadConfig 返回 null/无 mcpServers → skipped:'no-servers'（零成本空转）。
 * 4. connectAll 抛/ reject → {error:消息}，绝不 reject；res 为 null → connected/failed 都补 []。
 * 5. 缺 connectAll 的 manager → skipped:'unsupported'（但同样发生在置闩之后）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 数据家隔离：autoConnect 顶层 require('./index')（会注册 SIGINT/exit 监听、懒读配置）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-autoconn-'));
const savedEnv = {
  KHY_DATA_HOME: process.env.KHY_DATA_HOME,
  KHY_PROJECT_DATA_HOME: process.env.KHY_PROJECT_DATA_HOME,
  KHY_APP_HOME: process.env.KHY_APP_HOME,
  KHY_CC_MCP_BRIDGE: process.env.KHY_CC_MCP_BRIDGE,
  KHY_OPENCLAW_MCP_BRIDGE: process.env.KHY_OPENCLAW_MCP_BRIDGE,
  KHY_MCP_ECOSYSTEM: process.env.KHY_MCP_ECOSYSTEM,
};
process.env.KHY_DATA_HOME = TMP;
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'proj');
process.env.KHY_APP_HOME = path.join(TMP, 'apphome');
process.env.KHY_CC_MCP_BRIDGE = '0';
process.env.KHY_OPENCLAW_MCP_BRIDGE = '0';
process.env.KHY_MCP_ECOSYSTEM = '0';

const { ensureMcpConnected, autoConnectEnabled } = require('./autoConnect');

test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('autoConnect: 导出面', () => {
  assert.deepStrictEqual(Object.keys(require('./autoConnect')).sort(), ['autoConnectEnabled', 'ensureMcpConnected']);
});

test('autoConnect: 关闭词只有字面 false（0/off/no/数字0/带空格全保持 ON）—— 偏差注册', () => {
  assert.equal(autoConnectEnabled({ KHY_MCP_AUTOCONNECT: 'false' }), false);
  assert.equal(autoConnectEnabled({ KHY_MCP_AUTOCONNECT: 'FALSE' }), false);
  for (const keepOn of ['0', 'off', 'no', '', undefined, null, 0, false, ' false', 'False ', '1']) {
    assert.equal(autoConnectEnabled({ KHY_MCP_AUTOCONNECT: keepOn }), true, `关词候选 ${String(keepOn)} 竟然关了`);
  }
  assert.equal(autoConnectEnabled(null), true);
  assert.equal(autoConnectEnabled(), autoConnectEnabled(process.env));
});

test('autoConnect: 闩在门控之前置位 —— disabled 首调消耗一次性闩（实测钉住）', async () => {
  const calls = [];
  const manager = {
    loadConfig() { calls.push('loadConfig'); return { mcpServers: { a: { command: 'x' } } }; },
    async connectAll() { calls.push('connectAll'); return { connected: ['a'], failed: [] }; },
  };
  const state = { started: false };
  const offEnv = { KHY_MCP_AUTOCONNECT: 'false' };
  const r1 = await ensureMcpConnected({ manager, env: offEnv, state });
  assert.deepEqual(r1, { skipped: 'disabled' });
  assert.deepEqual(calls, []); // 门控关 → 完全没碰 manager
  // 闩已被 disabled 调用吃掉：即便门开也不再连接 — 偏差注册
  const r2 = await ensureMcpConnected({ manager, env: {}, state });
  assert.deepEqual(r2, { skipped: 'already-started' });
  assert.deepEqual(calls, []);
});

test('autoConnect: 空配置零成本 / null 配置兜壳 / 缺 connectAll 报 unsupported', async () => {
  const s1 = { started: false };
  const r1 = await ensureMcpConnected({ manager: { loadConfig: () => ({ mcpServers: {} }) }, env: {}, state: s1 });
  assert.deepEqual(r1, { skipped: 'no-servers' });
  const r2 = await ensureMcpConnected({ manager: { loadConfig: () => null }, env: {}, state: { started: false } });
  assert.deepEqual(r2, { skipped: 'no-servers' });
  const r3 = await ensureMcpConnected({ manager: { loadConfig: () => ({ mcpServers: null }) }, env: {}, state: { started: false } });
  assert.deepEqual(r3, { skipped: 'no-servers' });
  const r4 = await ensureMcpConnected({ manager: { loadConfig: () => ({ mcpServers: { a: {} } }) }, env: {}, state: { started: false } });
  assert.deepEqual(r4, { skipped: 'unsupported' });
  // loadConfig 抛 → error 兜住不 reject
  const r5 = await ensureMcpConnected({ manager: { loadConfig() { throw new Error('cfg boom'); } }, env: {}, state: { started: false } });
  assert.deepEqual(r5, { error: 'cfg boom' });
});

test('autoConnect: connectAll 透传 projectDir/onProgress；reject 兜 error；null 结果补空集', async () => {
  let seen = null;
  const onProgress = () => {};
  const okMgr = {
    loadConfig: () => ({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }),
    async connectAll(pd, cb) { seen = { pd, cb }; return { connected: ['a'], failed: [{ name: 'b', error: 'enoent' }] }; },
  };
  const r = await ensureMcpConnected({ manager: okMgr, env: {}, projectDir: '/proj/x', onProgress, state: { started: false } });
  assert.deepEqual(r, { connected: ['a'], failed: [{ name: 'b', error: 'enoent' }] });
  assert.equal(seen.pd, '/proj/x');
  assert.equal(seen.cb, onProgress);
  const rejMgr = { loadConfig: () => ({ mcpServers: { a: {} } }), async connectAll() { throw new Error('connect boom'); } };
  const r2 = await ensureMcpConnected({ manager: rejMgr, env: {}, state: { started: false } });
  assert.deepEqual(r2, { error: 'connect boom' });
  const nullMgr = { loadConfig: () => ({ mcpServers: { a: {} } }), async connectAll() { return null; } };
  const r3 = await ensureMcpConnected({ manager: nullMgr, env: {}, state: { started: false } });
  assert.deepEqual(r3, { connected: [], failed: [] });
  // reject 但 err.message 缺失（throw 字符串）→ String(e)
  const strMgr = { loadConfig: () => ({ mcpServers: { a: {} } }), async connectAll() { throw 'plain string'; } };
  assert.deepEqual(await ensureMcpConnected({ manager: strMgr, env: {}, state: { started: false } }), { error: 'plain string' });
});

test('autoConnect: 缺省 manager 走真 index —— 钉住数据家后 no-servers 空转', async () => {
  // 真 loadConfig：pinned 空数据家 + 三个桥/生态门控关（文件头已钉 env）→ 无服务器
  const state = { started: false };
  const r = await ensureMcpConnected({ env: {}, state, projectDir: path.join(TMP, 'proj') });
  assert.deepEqual(r, { skipped: 'no-servers' }, `真 index 路径意外连上了东西: ${JSON.stringify(r)}`);
});
