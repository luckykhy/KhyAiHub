/**
 * mcpAddSpec.test.js — 钉死 `khy mcp add` 片段的旗标前导消费、校验方向与预设展开。
 *
 * 为什么这支套件必须存在：这个叶子把 CLI 文本折成将落盘 mcp.json 的配置对象，
 * 方向性错误（该校验的放行、该报错的吞掉）会直接写坏用户配置。它的
 * "绝不抛"契约在 buildServerConfig(null) 上失效；transport 'ws' 被拒但
 * types.Transport.WS 明明是受支持枚举；预设展开读的是 process.env 而非注入
 * env——三条都只有测能钉住。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. buildServerConfig(null) 抛 TypeError（`input.name` 在默认参数之后仍炸 null）。
 * 2. normalizeTransport('ws') → null → 报错拒收，与 types.Transport.WS 支持分叉 — 偏差注册。
 * 3. parseEnvPair(' K = V ') → ['K',' V']：key 被 trim、value 保留前导空格（首 '=' 切）。
 * 4. 悬空尾旗标（rest 恰以一个 flag token 结尾）被消费并静默丢弃，command 为 []。
 * 5. 预设命中（如 filesystem/github，门控开）→ 展开为 npx 命令并附 preset 元数据；
 *    requiresEnv 缺失不阻断（github missingEnv 仍 ok:true）。gateEnv 用 process.env，
 *    不可经 opts.env 注入 — 实测钉住。
 * 6. KHY_MCP_PRESETS 关 → 同名退化为手写命令路径（'~/Docs' 直接成 command）。
 * 7. 首 token 是已知 launcher（npx/node/…）→ 视为显式覆盖，跳过预设。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('./mcpAddSpec');

const savedPresets = process.env.KHY_MCP_PRESETS;
function withPresets(value, fn) {
  if (value === undefined) delete process.env.KHY_MCP_PRESETS;
  else process.env.KHY_MCP_PRESETS = value;
  try { return fn(); } finally {
    if (savedPresets === undefined) delete process.env.KHY_MCP_PRESETS;
    else process.env.KHY_MCP_PRESETS = savedPresets;
  }
}
test.after(() => {
  if (savedPresets === undefined) delete process.env.KHY_MCP_PRESETS;
  else process.env.KHY_MCP_PRESETS = savedPresets;
});

test('addSpec: 导出面', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), [
    '_consumePreamble', 'buildServerConfig', 'isMcpAddEnabled', 'isValidServerName',
    'normalizeScope', 'normalizeTransport', 'parseEnvPair', 'parseEnvString',
  ]);
});

test('addSpec: isMcpAddEnabled —— flagRegistry CANON 四词 + 本地回退同四词', () => {
  for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(leaf.isMcpAddEnabled({ KHY_MCP_ADD: off }), false, off);
  }
  for (const on of [undefined, null, '', '1', 'yes']) {
    assert.equal(leaf.isMcpAddEnabled({ KHY_MCP_ADD: on }), true, JSON.stringify(on));
  }
  assert.equal(leaf.isMcpAddEnabled(null), true);
});

test('addSpec: 名称/scope/transport 归一', () => {
  assert.equal(leaf.isValidServerName('a-b_C0'), true);
  assert.equal(leaf.isValidServerName(''), false);
  assert.equal(leaf.isValidServerName('x'.repeat(65)), false);
  assert.equal(leaf.isValidServerName('x'.repeat(64)), true);
  assert.equal(leaf.isValidServerName('中文'), false);
  assert.equal(leaf.isValidServerName(42), false);   // 非字符串一律 false
  assert.equal(leaf.isValidServerName(null), false);
  for (const p of ['project', 'local', 'PROJ', ' proj ']) assert.equal(leaf.normalizeScope(p), 'project', p);
  for (const u of ['user', '', null, undefined, 'bogus', 42]) assert.equal(leaf.normalizeScope(u), 'user', String(u));
  assert.equal(leaf.normalizeTransport(undefined), 'stdio');
  assert.equal(leaf.normalizeTransport('SSE'), 'sse');
  assert.equal(leaf.normalizeTransport('http'), 'http');
  assert.equal(leaf.normalizeTransport('ws'), null); // types.Transport.WS 支持却被拒 — 偏差注册
});

test('addSpec: parseEnvPair/parseEnvString —— 首 = 切、key 正闸、value 不 trim', () => {
  assert.deepEqual(leaf.parseEnvPair('K=V'), ['K', 'V']);
  assert.deepEqual(leaf.parseEnvPair('K=V=W'), ['K', 'V=W']);
  assert.deepEqual(leaf.parseEnvPair(' K = V '), ['K', ' V']); // value 保留前导空格 — 实测钉住
  for (const bad of ['=V', 'K', '', null, undefined, '9K=V', 'K-V=1']) {
    assert.equal(leaf.parseEnvPair(bad), null, String(bad));
  }
  assert.deepEqual(leaf.parseEnvString('K1=V1,K2=V2'), { K1: 'V1', K2: 'V2' });
  assert.deepEqual(leaf.parseEnvString('K=1,=bad,J=2'), { K: '1', J: '2' }); // 坏段静默跳过
  assert.deepEqual(leaf.parseEnvString(''), {});
  assert.deepEqual(leaf.parseEnvString(null), {});
});

test('addSpec: _consumePreamble —— 头部旗标消费、header 首冒号切、悬空旗标丢弃', () => {
  const r = leaf._consumePreamble(['-s', 'user', '-e', 'A=1', '-H', 'X:Y:Z', 'npx', '-y', 'pkg']);
  assert.deepEqual(r, { env: { A: '1' }, headers: { X: 'Y:Z' }, scope: 'user', command: ['npx', '-y', 'pkg'] });
  assert.deepEqual(leaf._consumePreamble(['-s']), { env: {}, headers: {}, command: [] }); // 悬空 -s 消费即弃
  assert.deepEqual(leaf._consumePreamble(['node', '-s', 'x']).command, ['node', '-s', 'x']); // 命令开始即停扫
  assert.deepEqual(leaf._consumePreamble(['-H', ':nope', 'cmd']), { env: {}, headers: {}, command: ['cmd'] }); // idx>0 才收
  assert.deepEqual(leaf._consumePreamble('not-array'), { env: {}, headers: {}, command: [] });
  const long = leaf._consumePreamble(['--transport', 'sse', '--url', 'http://a', '--header', 'A:b']);
  assert.equal(long.transport, 'sse');
  assert.equal(long.url, 'http://a');
  assert.deepEqual(long.headers, { A: 'b' });
});

test('addSpec: buildServerConfig 校验方向 —— null 抛、缺名/坏名报错、坏 transport/缺命令各有专词', () => {
  assert.throws(() => leaf.buildServerConfig(null), TypeError); // 契约"绝不抛"在 null 上失效 — 实测钉住
  assert.deepEqual(leaf.buildServerConfig(), { ok: false, error: '缺少 server 名。用法:khy mcp add <名> [--scope user|project] [--env K=V] -- <命令> [参数…]' });
  assert.equal(leaf.buildServerConfig({ name: 'bad name!' }).ok, false);
  assert.match(leaf.buildServerConfig({ name: 'bad name!' }).error, /^非法 server 名/);
  const ws = leaf.buildServerConfig({ name: 's', rest: [], options: { transport: 'ws' } });
  assert.deepEqual(ws, { ok: false, error: '未知传输类型「ws」(支持 stdio|sse|http)。' });
  const noCmd = leaf.buildServerConfig({ name: 's', rest: ['  ', 'x'], options: {} });
  assert.equal(noCmd.ok, false);
  assert.match(noCmd.error, /^缺少要启动的命令/); // 首 token 空白 → 视同无命令
  const sse = leaf.buildServerConfig({ name: 's', rest: ['-t', 'sse', 'http://a:1/p'], options: {} });
  assert.deepEqual(sse.config, { type: 'sse', url: 'http://a:1/p' });
  assert.equal(sse.scope, 'user');
  const ftp = leaf.buildServerConfig({ name: 's', rest: ['-t', 'sse', '-u', 'ftp://a'], options: {} });
  assert.deepEqual(ftp, { ok: false, error: 'sse 传输需要一个 http(s) URL(--url <地址>)。' });
});

test('addSpec: stdio 手打命令路径 —— env 合并前导覆盖 options 串', () => {
  const r = leaf.buildServerConfig({ name: 's', rest: ['npx', '-y', 'p'], options: { env: 'K=1' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, { type: 'stdio', command: 'npx', args: ['-y', 'p'], env: { K: '1' } });
  const merged = leaf.buildServerConfig({ name: 's2', rest: ['-e', 'K=2', 'node'], options: { env: 'K=1,J=9' } });
  assert.deepEqual(merged.config.env, { K: '2', J: '9' }); // 前导 -e 覆盖同名
  assert.equal('args' in merged.config, false); // 单 token 命令不带 args 键
  const scoped = leaf.buildServerConfig({ name: 's3', rest: ['-s', 'project', 'node', 'x.js'], options: {} });
  assert.equal(scoped.scope, 'project');
});

test('addSpec: 预设展开 —— 命中预设+默认 stdio+非 launcher 首token 才展开；gate 走 process.env', () => {
  withPresets(undefined, () => {
    const fs = leaf.buildServerConfig({ name: 'filesystem', rest: ['~/Docs'], options: {} });
    assert.equal(fs.ok, true);
    assert.equal(fs.config.command, 'npx');
    assert.ok(fs.config.args.includes('@modelcontextprotocol/server-filesystem'));
    assert.ok(fs.config.args.includes('~/Docs')); // 位置参数进 extraArgs
    assert.equal(fs.preset.canonicalName, 'filesystem');
    // requiresEnv 缺失不阻断 —— github 缺 token 仍 ok:true，missingEnv 只是元数据 — 实测钉住
    const gh = leaf.buildServerConfig({ name: 'github', rest: [], options: {} });
    assert.equal(gh.ok, true);
    assert.deepEqual(gh.preset.missingEnv, ['GITHUB_PERSONAL_ACCESS_TOKEN']);
    // 首 token 是已知 launcher → 显式覆盖，不展开预设
    const explicit = leaf.buildServerConfig({ name: 'filesystem', rest: ['npx', '-y', 'custom-pkg'], options: {} });
    assert.equal('preset' in explicit, false);
    assert.equal(explicit.config.command, 'npx');
    assert.deepEqual(explicit.config.args, ['-y', 'custom-pkg']);
  });
  withPresets('0', () => {
    // 门控关 → hasPreset 恒 false → 手写命令路径（首 token '~/Docs' 成 command）
    const off = leaf.buildServerConfig({ name: 'filesystem', rest: ['~/Docs'], options: {} });
    assert.equal('preset' in off, false);
    assert.deepEqual(off.config, { type: 'stdio', command: '~/Docs' });
  });
});
