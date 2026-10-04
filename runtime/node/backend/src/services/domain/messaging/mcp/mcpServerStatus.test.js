/**
 * mcpServerStatus.test.js — 钉死逐台 MCP 状态解析的门控词汇与状态机兜底。
 *
 * 为什么这支套件必须存在：这是 /mcp 面板逐台状态（connected/reconnecting(n/m)/
 * failed+原因/disabled）的纯决策层，宣称"绝不抛"且有 catch 兜底——兜底路径
 * 本身是什么口径、disabled 与 connected 的优先级、错误裁剪长度，全是显示层
 * 契约，只能测钉。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. 门控关闭词集是本地 _FALSY 四词 {0,false,off,no}（trim+lower 宽容），
 *    与 autoConnect（只认 'false'）、mcpDisclosurePlan（只认 '0'）互不相同 — 全仓三套词汇并存。
 * 2. resolveMcpServerState(null) 不抛（内部 `info &&` 全防御），返回
 *    {state:'pending', detail:''} —— 与多数同目录叶子的 null-throwing 形成对照。
 * 3. disabled 即使 connected:true 也优先返回 'disabled'。
 * 4. reconnecting 的 (n/m) 仅当 attempt/max 都是有限正数；0/NaN/缺失 → 空 detail。
 * 5. failed 的 error 非字符串（如 Error 实例/数字）→ _clip 返回 ''，原因丢失 — 偏差注册。
 * 6. 裁剪规则：>60 字符 → 前 59 + '…'（共 60）；恰 60 不动。
 * 7. 信息对象属性 getter 抛异常 → 走 catch 的 legacy 布尔口径 {state:'no'}，
 *    即便门控开着 — 兜底口径与门控关一致，实测钉住。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { mcpServerStatusEnabled, resolveMcpServerState } = require('./mcpServerStatus');

test('serverStatus: 门控 _FALSY 四词，大小写/空白宽容，默认 ON', () => {
  for (const off of ['0', 'false', 'off', 'no', ' OFF ', 'False']) {
    assert.equal(mcpServerStatusEnabled({ KHY_MCP_SERVER_STATUS: off }), false, off);
  }
  for (const on of [undefined, null, '', '1', 'true', 'yes', '0x']) {
    assert.equal(mcpServerStatusEnabled({ KHY_MCP_SERVER_STATUS: on }), true, String(on));
  }
  assert.equal(mcpServerStatusEnabled(null), true);   // env 对象为 null → undefined → 'true'
  assert.equal(mcpServerStatusEnabled(), mcpServerStatusEnabled(process.env)); // 默认参数读 process.env
});

test('serverStatus: null/undefined/{} 入参都不抛，统一 pending', () => {
  assert.deepEqual(resolveMcpServerState(null, {}), { state: 'pending', detail: '' });
  assert.deepEqual(resolveMcpServerState(undefined, {}), { state: 'pending', detail: '' });
  assert.deepEqual(resolveMcpServerState({}, {}), { state: 'pending', detail: '' });
});

test('serverStatus: disabled 优先于 connected；type 标签映射', () => {
  assert.deepEqual(resolveMcpServerState({ disabled: true, connected: true, type: 'connected' }, {}),
    { state: 'disabled', detail: '' });
  assert.deepEqual(resolveMcpServerState({ type: 'connected' }, {}), { state: 'connected', detail: '' });
  assert.deepEqual(resolveMcpServerState({ type: 'CONNECTING ' }, {}), { state: 'connecting', detail: '' }); // trim+lower
  assert.deepEqual(resolveMcpServerState({ type: 'bogus', connected: true }, {}), { state: 'connected', detail: '' });
  assert.deepEqual(resolveMcpServerState({ type: 'bogus', connected: false }, {}), { state: 'pending', detail: '' });
});

test('serverStatus: reconnecting 的 n/m 只在两个正有限数时给出', () => {
  assert.deepEqual(resolveMcpServerState({ type: 'pending', reconnectAttempt: 2, maxReconnectAttempts: 5 }, {}),
    { state: 'reconnecting', detail: '2/5' });
  for (const bad of [undefined, 0, -1, NaN, 'x', Infinity]) {
    const r = resolveMcpServerState({ type: 'pending', reconnectAttempt: bad, maxReconnectAttempts: 5 }, {});
    assert.equal(r.detail, '', `attempt=${String(bad)} 竟然出了 detail`);
  }
});

test('serverStatus: failed 展示 error，61 字符裁成 59+… ，非字符串吞掉', () => {
  const s60 = 'x'.repeat(60);
  assert.equal(resolveMcpServerState({ type: 'failed', error: s60 }, {}).detail, s60);
  const d = resolveMcpServerState({ type: 'failed', error: 'y'.repeat(61) }, {}).detail;
  assert.equal(d.length, 60);
  assert.ok(d.endsWith('…'));
  assert.equal(resolveMcpServerState({ type: 'failed', error: new Error('boom') }, {}).detail, ''); // Error 对象→'' — 偏差注册
  assert.equal(resolveMcpServerState({ type: 'failed' }, {}).detail, '');
  assert.equal(resolveMcpServerState({ type: 'failed', error: '  spaced  ' }, {}).detail, 'spaced'); // trim
});

test('serverStatus: 门控关 → legacy yes/no 布尔口径，disabled 不再优先', () => {
  assert.deepEqual(resolveMcpServerState({ connected: true, disabled: true, type: 'failed' }, { KHY_MCP_SERVER_STATUS: 'off' }),
    { state: 'yes', detail: '' });
  assert.deepEqual(resolveMcpServerState({ connected: false }, { KHY_MCP_SERVER_STATUS: '0' }), { state: 'no', detail: '' });
});

test('serverStatus: 属性 getter 抛 → catch 回落 yes/no 口径（门控开也照样）', () => {
  const evil = {};
  Object.defineProperty(evil, 'disabled', { get() { throw new Error('boom'); }, enumerable: true });
  assert.deepEqual(resolveMcpServerState(evil, {}), { state: 'no', detail: '' });
  Object.defineProperty(evil, 'connected', { get() { return true; }, enumerable: true });
  assert.deepEqual(resolveMcpServerState(evil, {}), { state: 'yes', detail: '' });
});
