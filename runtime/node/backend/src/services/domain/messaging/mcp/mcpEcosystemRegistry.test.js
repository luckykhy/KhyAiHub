/**
 * mcpEcosystemRegistry.test.js — 钉死 14 家生态声明表的门控链、source 枚举与配置归一向量。
 *
 * 为什么这支套件必须存在：这张表把"蹭生态"从每接一家复制一段壳逻辑收敛成
 * 一行表项，normalizeServerConfig 决定外部条目能不能变成 khy 可连的配置——
 * 每个 return null 都是"跳过一台可能可连的 server"，每个误放行都是"连上畸形
 * 配置炸 spawn"。方向必须逐条测钉，且全程零真实 fs（homedir/platform/env 注入）。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. EXCLUDED 表把 'opencode' 列为"刻意不登记"，但 ECOSYSTEMS 第 14 行就是
 *    opencode —— EXCLUDED 的理由文案自指（"已登记在 ECOSYSTEMS 表"），文档
 *    一致性偏差注册（实测钉住）。
 * 2. 门控链：总闸关 → getEcosystems [] / mcpEcosystemSources []；每家
 *    KHY_MCP_ECO_* 四词 {0,false,off,no} 关，未知 id → false。
 * 3. disabled:true / enabled:false 严格布尔才禁；'true'/1 字符串照连 — 实测钉住。
 * 4. 占位符闸扫全对象（string/array/嵌套），命中 ${input:|${command:|${env:|
 *    ${userHome:|${workspaceFolder} → null；未知形态 ${FOO} 不误伤。
 * 5. env/headers 清洗只留 string|number|boolean 并 String 化；嵌套对象值丢弃。
 * 6. command 数组扁平化：首项成 command，余项并入 args 前段。缺陷注册：扁平用
 *    String(x)（mcpEcosystemRegistry.js:628），null→'null' 逃过 filter(Boolean)，
 *    故 {command:[null,'']} 得假命令 'null' 而非 null（实测钉住）。
 * 7. zed 形状：command 对象取 path；无 command 且 source≠'custom' → null；
 *    source:'custom' 但无 command 也 null（走 url 检查落空）。
 * 8. 裸 url 的类型由 remoteDefault 决定（gemini/qwen/cline/roo=sse，其余=http）；
 *    httpUrl 键出现即强制 http；非 http(s) url → null。
 * 9. declared type 为 sse/http 时 command 被无视（同一条目双字段时远端赢）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const leaf = require('./mcpEcosystemRegistry');

test('eco: 导出面与表规模合同（14 家）', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), [
    'ECOSYSTEMS', 'EXCLUDED', 'extractEcosystemServers', 'getEcosystems', 'isEcosystemEnabled',
    'isMcpEcosystemEnabled', 'mcpEcosystemSources', 'normalizeServerConfig', 'parseEcosystemConfig',
    'resolveBase', 'userAppConfigDir',
  ]);
  assert.equal(leaf.ECOSYSTEMS.length, 14);
  assert.ok(Object.isFrozen(leaf.ECOSYSTEMS));
  const ids = leaf.ECOSYSTEMS.map((e) => e.id);
  assert.deepEqual(ids, ['claude-desktop', 'cursor', 'vscode', 'codex', 'gemini', 'qwen', 'kiro', 'amazonq', 'copilot-cli', 'continue', 'zed', 'cline', 'roo', 'opencode']);
  // 偏差注册：opencode 同时在 ECOSYSTEMS 与 EXCLUDED 里出现（EXCLUDED 理由自指）
  assert.ok('opencode' in leaf.EXCLUDED);
  assert.ok(ids.includes('opencode'));
  assert.ok('claude-code' in leaf.EXCLUDED && 'openclaw' in leaf.EXCLUDED && 'warp' in leaf.EXCLUDED);
});

test('eco: 门控链 —— 总闸四词 + 每家门控 + 未知 id false', () => {
  for (const off of ['0', 'false', 'off', 'no', ' OFF']) {
    assert.equal(leaf.isMcpEcosystemEnabled({ KHY_MCP_ECOSYSTEM: off }), false, off);
  }
  assert.equal(leaf.isMcpEcosystemEnabled({}), true);
  assert.equal(leaf.isMcpEcosystemEnabled(null), true);
  assert.equal(leaf.isEcosystemEnabled('cursor', {}), true);
  assert.equal(leaf.isEcosystemEnabled('cursor', { KHY_MCP_ECO_CURSOR: 'off' }), false);
  assert.equal(leaf.isEcosystemEnabled('bogus-id', {}), false);
  assert.equal(leaf.isEcosystemEnabled('cursor', { KHY_MCP_ECOSYSTEM: '0' }), false); // 父闸压制
  assert.equal(leaf.getEcosystems({}).length, 14);
  assert.deepEqual(leaf.getEcosystems({ KHY_MCP_ECOSYSTEM: 'no' }), []);
  assert.equal(leaf.getEcosystems({ KHY_MCP_ECO_ZED: '0' }).length, 13);
});

test('eco: userAppConfigDir/resolveBase —— 平台三分支与空段守卫', () => {
  assert.equal(leaf.userAppConfigDir({ platform: 'win32', env: { APPDATA: 'A:' } }), 'A:');
  assert.equal(leaf.userAppConfigDir({ platform: 'win32', homedir: '/h', env: {} }), path.join('/h', 'AppData', 'Roaming'));
  assert.equal(leaf.userAppConfigDir({ platform: 'darwin', homedir: '/h', env: {} }), path.join('/h', 'Library', 'Application Support'));
  assert.equal(leaf.userAppConfigDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' } }), '/xdg');
  assert.equal(leaf.userAppConfigDir({ platform: 'linux', homedir: '/h', env: {} }), path.join('/h', '.config'));
  assert.equal(leaf.userAppConfigDir({}), '');
  assert.equal(leaf.resolveBase('home', { homedir: '/h' }), '/h');
  assert.equal(leaf.resolveBase('home', {}), '');
  assert.equal(leaf.resolveBase('project', { projectDir: '/p' }), '/p');
  assert.equal(leaf.resolveBase('unknown-base', { homedir: '/h' }), '');
});

test('eco: mcpEcosystemSources —— 顺序=表序、平台过滤、坏输入跳过', () => {
  assert.deepEqual(leaf.mcpEcosystemSources({ homedir: '/h', projectDir: '/p', platform: 'linux', env: { KHY_MCP_ECOSYSTEM: '0' } }), []);
  const srcs = leaf.mcpEcosystemSources({ homedir: '/h', projectDir: '/p', platform: 'linux', env: {} });
  assert.ok(srcs.length > 15); // 非空防呆
  assert.equal(srcs[0].ecosystem, 'claude-desktop');
  assert.equal(srcs[0].path, path.join(leaf.userAppConfigDir({ homedir: '/h', platform: 'linux', env: {} }), 'Claude', 'claude_desktop_config.json'));
  // zed 的 win-only source 在非 win32 被平台过滤剔除
  assert.equal(srcs.filter((s) => s.ecosystem === 'zed' && s.kind === 'user-win').length, 0);
  const win = leaf.mcpEcosystemSources({ homedir: '/h', platform: 'win32', env: { APPDATA: 'A:' } });
  assert.ok(win.some((s) => s.ecosystem === 'zed' && s.kind === 'user-win'));
  // 无 homedir → 所有 home base 源消失，project 源还在
  const noHome = leaf.mcpEcosystemSources({ projectDir: '/p', platform: 'linux', env: {} });
  assert.ok(noHome.length > 0);
  assert.equal(noHome.some((s) => s.path.startsWith(path.join('/h'))), false);
  // 空 homedir+projectDir → []
  assert.deepEqual(leaf.mcpEcosystemSources({ platform: 'linux', env: {} }), []);
  // 每家条目携带合并所需元数据
  const gem = srcs.find((s) => s.ecosystem === 'gemini');
  assert.equal(gem.remoteDefault, 'sse');
  assert.equal(gem.format, 'json');
  const codex = srcs.find((s) => s.ecosystem === 'codex');
  assert.equal(codex.format, 'toml');
  assert.equal(codex.extract, 'mcp_servers');
});

test('eco: parseEcosystemConfig —— json/json5/toml 三格式与注释回退', () => {
  assert.deepEqual(leaf.parseEcosystemConfig('{"mcpServers":{}}', 'json'), { mcpServers: {} });
  // json 格式带注释 → 严格 parse 失败 → 自动退 JSON5 再试（注释容忍）— 实测钉住
  assert.deepEqual(leaf.parseEcosystemConfig('{ // c\n "mcpServers": {} }', 'json'), { mcpServers: {} });
  assert.deepEqual(leaf.parseEcosystemConfig("{ mcp: { s: { command: 'x', }, }, }", 'json5'), { mcp: { s: { command: 'x' } } });
  const toml = leaf.parseEcosystemConfig('[mcp_servers.fs]\ncommand = "npx"\n', 'toml');
  assert.equal(toml.mcp_servers.fs.command, 'npx');
  assert.equal(leaf.parseEcosystemConfig('totally(!garbage', 'json'), null);
  assert.equal(leaf.parseEcosystemConfig('', 'json5'), null);
  assert.equal(leaf.parseEcosystemConfig(null, 'json'), null);
  assert.equal(leaf.parseEcosystemConfig(42, 'toml'), null);
});

test('eco: normalizeServerConfig —— stdio 归一、数组扁平、env 清洗、cwd 透传', () => {
  const base = leaf.normalizeServerConfig({ command: 'npx', args: ['-y', 'pkg'], env: { A: 1, B: 'x', C: true, D: { nested: 1 }, '': 'drop' } });
  assert.deepEqual(base, { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { A: '1', B: 'x', C: 'true' } }); // number/bool String 化，对象与空键丢弃
  const flat = leaf.normalizeServerConfig({ command: ['npx', '-y', 'pkg'], args: ['extra'] });
  assert.deepEqual(flat, { type: 'stdio', command: 'npx', args: ['-y', 'pkg', 'extra'] }); // 数组扁平：余项并入 args 前段
  const cwd = leaf.normalizeServerConfig({ command: 'c', cwd: '/work' });
  assert.equal(cwd.cwd, '/work');
  const noArgs = leaf.normalizeServerConfig({ command: 'c', args: [] });
  assert.equal('args' in noArgs, false);
  // 缺陷钉住：数组扁平用 String(x) 而非判空，null→'null' 逃过 filter(Boolean)（mcpEcosystemRegistry.js:628），
  // 反预测「全假数组 → null」→ 实测得 {command:'null'} 假命令。
  assert.deepEqual(leaf.normalizeServerConfig({ command: [null, ''] }), { type: 'stdio', command: 'null' });
  assert.deepEqual(leaf.normalizeServerConfig({ command: ['', ''] }), null); // 真空串数组才判未定义
  // 禁用标记严格布尔
  assert.equal(leaf.normalizeServerConfig({ command: 'c', disabled: true }), null);
  assert.equal(leaf.normalizeServerConfig({ command: 'c', enabled: false }), null);
  assert.ok(leaf.normalizeServerConfig({ command: 'c', disabled: 'yes' })); // 字符串不禁 — 实测钉住
  // 占位符闸（string/数组/嵌套全扫）
  for (const ph of ['${input:x}', '${env:K}', '${userHome}', '${workspaceFolder}/p', '${command:y}']) {
    assert.equal(leaf.normalizeServerConfig({ command: ph }), null, ph);
  }
  assert.equal(leaf.normalizeServerConfig({ command: 'npx', args: ['ok', '${input:z}'] }), null); // 嵌套数组扫出
  assert.ok(leaf.normalizeServerConfig({ command: 'npx', args: ['${FOO}'] })); // 未知 ${...} 不误伤
});

test('eco: normalizeServerConfig —— 远端类型判定与 zed/vscode 形状', () => {
  assert.deepEqual(leaf.normalizeServerConfig({ url: 'http://a/mcp' }), { type: 'http', url: 'http://a/mcp' }); // 缺省 remote http
  assert.deepEqual(leaf.normalizeServerConfig({ url: 'http://a' }, { remoteDefault: 'sse' }), { type: 'sse', url: 'http://a' });
  assert.deepEqual(leaf.normalizeServerConfig({ httpUrl: 'http://a' }, { remoteDefault: 'sse' }), { type: 'http', url: 'http://a' }); // httpUrl 强制 http
  assert.deepEqual(leaf.normalizeServerConfig({ type: 'streamable-http', url: 'https://a' }), { type: 'http', url: 'https://a' });
  // declared sse/http 时 command 被无视（远端赢）— 实测钉住
  assert.deepEqual(leaf.normalizeServerConfig({ command: 'c', type: 'sse', url: 'http://a' }), { type: 'sse', url: 'http://a' });
  assert.equal(leaf.normalizeServerConfig({ url: 'ws://a' }), null);   // 非 http(s)
  assert.equal(leaf.normalizeServerConfig({ url: 42 }), null);
  const hdr = leaf.normalizeServerConfig({ url: 'http://a', headers: { A: '1', B: 2, C: { x: 1 } } });
  assert.deepEqual(hdr.headers, { A: '1', B: '2' });
  // zed：command 对象形态
  const zed = leaf.normalizeServerConfig({ command: { path: '/bin/x', args: ['a'], env: { K: 'V' } } }, { shape: 'zed' });
  assert.deepEqual(zed, { type: 'stdio', command: '/bin/x', args: ['a'], env: { K: 'V' } });
  assert.equal(leaf.normalizeServerConfig({ source: 'extension' }, { shape: 'zed' }), null); // extension 自拉起→跳
  assert.equal(leaf.normalizeServerConfig({ source: 'custom' }, { shape: 'zed' }), null);    // custom 无 command 也 null
  // vscode 形状在归一层与 standard 同路（无特殊分支）— 实测钉住
  assert.deepEqual(leaf.normalizeServerConfig({ type: 'stdio', command: 'c' }, { shape: 'vscode' }).type, 'stdio');
});

test('eco: extractEcosystemServers —— 点号路径抽取与逐条归一', () => {
  const parsed = { mcp: { servers: { fs: { command: 'npx', args: ['-y', 'p'] }, bad: { disabled: true }, '': { command: 'x' }, arr: [1] } } };
  const out = leaf.extractEcosystemServers(parsed, { extract: 'mcp.servers' });
  assert.deepEqual(Object.keys(out), ['fs']);
  assert.equal(out.fs.command, 'npx');
  assert.deepEqual(leaf.extractEcosystemServers(null, { extract: 'mcpServers' }), {});
  assert.deepEqual(leaf.extractEcosystemServers({ mcpServers: [1] }, { extract: 'mcpServers' }), {}); // 数组 map → {}
  assert.deepEqual(leaf.extractEcosystemServers({ x: 1 }, { extract: 'missing.path' }), {});
  assert.deepEqual(leaf.extractEcosystemServers({}, {}), {});
});
