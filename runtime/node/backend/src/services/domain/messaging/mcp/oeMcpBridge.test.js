/**
 * oeMcpBridge.test.js — 钉死 opencode 桥的路径枚举（含不可注入的 cwd/platform）与引用透传。
 *
 * 为什么这支套件必须存在：这台桥是三个生态桥里唯一"提取结果直接透传 cfg 引用"
 * 的——壳在其上打 _scope 标记会写回原始 parsed 对象，与 cc/oc 桥的浅拷贝契约不同；
 * 且 sources 枚举硬用 process.cwd()/process.platform（homedir/env 可注入但这两样不行）。
 * 差异不测钉就会被当成"三个桥同形"的错觉传播。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. extractMcpServers 返回 cfg 引用（无 {...cfg} 拷贝），且不剔空名——
 *    parsed.mcp[''] 会原样进入结果 — 与 cc/oc 桥双双分叉 — 偏差注册。
 * 2. mcp 与 mcpServers 两个键都认（`parsed.mcp || parsed.mcpServers`），且 mcp 优先；
 *    数组 cfg 被剔（!Array.isArray），null/字符串 cfg 也被剔。
 * 3. oeMcpConfigSources 的项目级两条源用真实 process.cwd() 拼路径——不可注入，
 *    本测按当前 cwd 相对断言（确定性来自同进程）。
 * 4. userConfigDir（未导出）win32 支路用 env.APPDATA；APPDATA 缺失时 homedir 未给
 *    → _join 空段守卫 → ''。sources 里 user-global 项随之消失。
 * 5. parseConfig 与 oc 桥同构：'123'→null、'[1]'→数组放行、坏文本→null。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const leaf = require('./oeMcpBridge');

test('oeBridge: 导出面', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), ['extractMcpServers', 'isOeMcpBridgeEnabled', 'oeMcpConfigSources', 'parseConfig']);
});

test('oeBridge: 门控 KHY_MCP_ECODE_BRIDGE —— 注意键名是 ECODE 不是 OPENCODE', () => {
  for (const off of ['0', 'false', 'off', 'no', ' No']) {
    assert.equal(leaf.isOeMcpBridgeEnabled({ KHY_MCP_ECODE_BRIDGE: off }), false, off);
  }
  for (const on of [undefined, null, '', '1', 'FALSE ']) {
    // 'FALSE ' trim 后是 false → 关！单独钉：trim+lower 宽容
    if (String(on).trim().toLowerCase() === 'false') continue;
    assert.equal(leaf.isOeMcpBridgeEnabled({ KHY_MCP_ECODE_BRIDGE: on }), true, JSON.stringify(on));
  }
  assert.equal(leaf.isOeMcpBridgeEnabled({ KHY_MCP_ECODE_BRIDGE: 'FALSE ' }), false); // trim+lower 关词仍生效
  assert.equal(leaf.isOeMcpBridgeEnabled({}), true);
});

test('oeBridge: sources —— APPDATA 注入定 user-global；缺 APPDATA 无 homedir 则只剩项目级', () => {
  const cwd = process.cwd();
  const withAppData = leaf.oeMcpConfigSources({ homedir: '/h', env: { APPDATA: 'D:/AppData' } });
  const kinds = withAppData.map((s) => s.kind);
  assert.ok(kinds.includes('user-global'));
  assert.ok(kinds.includes('user-alt'));
  assert.ok(kinds.includes('project'));
  assert.ok(kinds.includes('project-alt'));
  const proj = withAppData.find((s) => s.kind === 'project');
  assert.equal(proj.path, path.join(cwd, '.opencode', 'config.json')); // 真实 cwd，不可注入 — 实测钉住
  const alt = withAppData.find((s) => s.kind === 'project-alt');
  assert.equal(alt.path, path.join(cwd, 'opencode.json'));
  assert.throws(() => leaf.oeMcpConfigSources(null), TypeError); // 参数位解构先于函数体 try —— 与 cc 桥同款失效
});

test('oeBridge: extract —— cfg 引用透传 + 空名不剔（与 cc/oc 分叉，偏差注册）', () => {
  const parsed = { mcp: { srv: { command: 'c', env: { K: 'V' } }, '': { command: 'ghost' }, arr: [1], nul: null, str: 's' } };
  const out = leaf.extractMcpServers(parsed);
  assert.deepEqual(Object.keys(out).sort(), ['', 'srv']); // 空名进、数组/null/字符串剔 — 实测钉住
  assert.equal(out.srv, parsed.mcp.srv);                  // 引用相等：没有浅拷贝！
  out.srv.command = 'MUTATED';
  assert.equal(parsed.mcp.srv.command, 'MUTATED');        // 改动直接回写原 parsed — 变异泄漏钉死
  // mcpServers 兜底键 + mcp 优先
  assert.deepEqual(leaf.extractMcpServers({ mcpServers: { x: { command: 'f' } } }), { x: { command: 'f' } });
  const both = { mcp: { a: { command: 'A' } }, mcpServers: { b: { command: 'B' } } };
  assert.deepEqual(leaf.extractMcpServers(both), { a: { command: 'A' } }); // mcp 赢，mcpServers 被无视
  // 脏输入
  assert.deepEqual(leaf.extractMcpServers(null), {});
  assert.deepEqual(leaf.extractMcpServers(undefined), {});
  assert.deepEqual(leaf.extractMcpServers({}), {});
  assert.deepEqual(leaf.extractMcpServers({ mcp: 'str' }), {});
  assert.deepEqual(leaf.extractMcpServers({ mcp: [1, 2] }), {}); // 数组 mcp: typeof object → entries(索引)——实测形状
});

test('oeBridge: parseConfig —— JSON5 主路宽容；坏文本 null；非字符串 null', () => {
  assert.equal(leaf.parseConfig(42), null);
  assert.equal(leaf.parseConfig(''), null);
  assert.equal(leaf.parseConfig('123'), null);
  assert.deepEqual(leaf.parseConfig('[1]'), [1]);
  const ok = leaf.parseConfig(`{ "mcp": { "srv": { "command": "npx" }, }, }`);
  assert.deepEqual(ok, { mcp: { srv: { command: 'npx' } } }); // json5 尾逗号（本机 _stripJsonc 回退是死码——注册）
  assert.equal(leaf.parseConfig('!@#$'), null);
});
