/**
 * mcpGovernance.test.js — 钉死治理视图的优先级描述、严格布尔闸与孤儿工具计数。
 *
 * 为什么这支套件必须存在：这个叶子是 `/mcp` 治理呈现的单一真源——它把
 * "project 覆盖 user 覆盖 legacy"的加载序、注解→审批层的映射（destructive >
 * readOnly > standard 的优先级）固化为可渲染数据。映射方向错一位就会把
 * 破坏性工具呈现成可自动批准，必须测钉。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. _disabled / isReadOnly / isDestructive 全部严格 === true：1/'true' 等 truthy
 *    值被归入 standard/非禁用 — 方向保守，实测钉住。
 * 2. describeConfigPrecedence 的 project 路径拼接用字面 '/'（非 path.join）：
 *    win32 反斜杠 projectDir 会得到混分隔 'C:\\p/.khy/mcp.json'；结尾 '/' 去重分隔。
 * 3. buildGovernanceView 无 serverName 的孤儿工具：计入 counts.tools 与 approval
 *    分布，但任何 server 行的 toolCount 都不含它；toolsByServer 键可为 undefined。
 * 4. buildGovernanceView(null) 抛 TypeError（默认参数只兜 undefined），而
 *    describeConfigPrecedence(null)/resolveApprovalPolicy(null) 被函数体内
 *    typeof 闸兜住不抛 — 同文件内总性不一致 — 实测钉住。
 * 5. destructive+readOnly 同时为 true → destructive 赢（人闸门优先）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('./mcpGovernance');
const { ConfigScope } = require('./types');

test('governance: 导出面', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), [
    'buildGovernanceView', 'classifyServerScope', 'describeConfigPrecedence',
    'resolveApprovalPolicy', 'summarizeGovernance',
  ]);
});

test('governance: describeConfigPrecedence —— 低→高序、null 兜住、混分隔拼接', () => {
  const base = leaf.describeConfigPrecedence();
  assert.equal(base.length, 2);
  assert.deepEqual(base.map((r) => r.order), [0, 1]);
  assert.deepEqual(base.map((r) => r.label), ['用户级', '用户级(legacy)']);
  assert.equal(base[0].path, null);
  assert.equal(base[1].overrides, '用户级');
  assert.equal(leaf.describeConfigPrecedence(null).length, 2); // 函数体 typeof 闸兜 null
  const four = leaf.describeConfigPrecedence({ projectDir: 'C:\\p', userPath: 'U', legacyPath: 'L' });
  assert.equal(four.length, 4);
  assert.equal(four[2].path, 'C:\\p/.khy/mcp.json');  // 字面 '/' 拼接，win32 混分隔 — 实测钉住
  assert.equal(four[3].path, 'C:\\p/.khyquant/mcp.json');
  assert.equal(four[2].overrides, '用户级');
  assert.equal(four[3].overrides, '项目级');
  assert.equal(four[2].scope, ConfigScope.LOCAL);
  assert.deepEqual(four.map((r) => r.order), [0, 1, 2, 3]);
  // 尾 '/' 去重分隔
  assert.equal(leaf.describeConfigPrecedence({ projectDir: '/x/' })[2].path, '/x/.khy/mcp.json');
});

test('governance: classifyServerScope —— 默认 user/stdio，_disabled 严格 true', () => {
  assert.deepEqual(leaf.classifyServerScope({}), { scope: 'user', scopeLabel: '用户级', disabled: false, configPath: null, transport: 'stdio' });
  assert.deepEqual(leaf.classifyServerScope(null), { scope: 'user', scopeLabel: '用户级', disabled: false, configPath: null, transport: 'stdio' });
  const c = leaf.classifyServerScope({ _scope: 'local', _disabled: true, _configPath: '/p/mcp.json', type: 'sse' });
  assert.deepEqual(c, { scope: 'local', scopeLabel: '项目级', disabled: true, configPath: '/p/mcp.json', transport: 'sse' });
  assert.equal(leaf.classifyServerScope({ _disabled: 1 }).disabled, false);   // 严格 === true — 实测钉住
  assert.equal(leaf.classifyServerScope({ _disabled: 'true' }).disabled, false);
  const dyn = leaf.classifyServerScope({ _scope: 'dynamic' });
  assert.equal(dyn.scopeLabel, '运行时');
  assert.equal(leaf.classifyServerScope({ _scope: 'weird' }).scopeLabel, 'weird'); // 未知 scope 原样当 label
  assert.equal(leaf.classifyServerScope({ type: '  ' }).transport, 'stdio'); // 空白 type → stdio
  assert.equal(leaf.classifyServerScope({ _configPath: 42 }).configPath, null);
});

test('governance: resolveApprovalPolicy —— destructive>readOnly>standard；truthy 非 true 落 standard', () => {
  assert.equal(leaf.resolveApprovalPolicy({ isDestructive: true }).level, 'destructive');
  assert.equal(leaf.resolveApprovalPolicy({ isDestructive: true, isReadOnly: true }).level, 'destructive'); // destructive 赢
  assert.equal(leaf.resolveApprovalPolicy({ isDestructive: true }).humanGate, true);
  assert.equal(leaf.resolveApprovalPolicy({ isDestructive: true }).planModeAllowed, false);
  const ro = leaf.resolveApprovalPolicy({ isReadOnly: true });
  assert.deepEqual({ level: ro.level, humanGate: ro.humanGate, planModeAllowed: ro.planModeAllowed, autoApprovable: ro.autoApprovable },
    { level: 'read-only', humanGate: false, planModeAllowed: true, autoApprovable: true });
  assert.equal(leaf.resolveApprovalPolicy({}).level, 'standard');
  assert.equal(leaf.resolveApprovalPolicy(null).level, 'standard');
  assert.equal(leaf.resolveApprovalPolicy(123).level, 'standard');
  assert.equal(leaf.resolveApprovalPolicy({ isReadOnly: 1 }).level, 'standard'); // 非严格 true — 实测钉住
  assert.match(leaf.resolveApprovalPolicy({ isDestructive: true }).reason, /人闸门/);
});

test('governance: buildGovernanceView —— 行展开、连接集、孤儿工具计数方向', () => {
  const view = leaf.buildGovernanceView({
    mcpServers: {
      a: { _scope: 'local', type: 'http' },
      b: { _disabled: true },
    },
    connected: ['a', 'ghost'],
    tools: [
      { serverName: 'a', isReadOnly: true },
      { serverName: 'a', isDestructive: true },
      { normalizedServerName: 'b' },          // 无 serverName 走 normalized 兜底
      {},                                     // 孤儿：两个键都无 → undefined 键
      null,                                   // null 元素也是孤儿
    ],
  });
  assert.ok(view.servers.length >= 2);
  const a = view.servers.find((s) => s.name === 'a');
  assert.deepEqual({ scope: a.scope, transport: a.transport, connected: a.connected, toolCount: a.toolCount },
    { scope: 'local', transport: 'http', connected: true, toolCount: 2 });
  const b = view.servers.find((s) => s.name === 'b');
  assert.deepEqual({ disabled: b.disabled, connected: b.connected, toolCount: b.toolCount }, { disabled: true, connected: false, toolCount: 1 });
  assert.deepEqual(view.approval, { destructive: 1, readOnly: 1, standard: 3 }); // 孤儿 {}+null 都进 standard
  assert.deepEqual(view.counts, { configured: 2, connected: 1, disabled: 1, tools: 5 }); // connected 名单里的 ghost 不计
  assert.equal(view.precedence.length, 2); // paths 未给
  // 脏输入形状
  const v2 = leaf.buildGovernanceView({ mcpServers: 'str', connected: 'not-array', tools: 'no' });
  assert.deepEqual(v2.servers, []);
  assert.deepEqual(v2.counts, { configured: 0, connected: 0, disabled: 0, tools: 0 });
  assert.throws(() => leaf.buildGovernanceView(null), TypeError); // 与同文件其他函数的 null 兜底不一致 — 实测钉住
});

test('governance: summarizeGovernance —— 缺字段 0 填充，三行结构', () => {
  const lines = leaf.summarizeGovernance();
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^MCP 治理:配置 0 · 已连接 0 · 禁用 0 · 工具 0$/);
  assert.match(lines[1], /^审批分布:破坏性 0\(人闸门\) · 只读 0\(plan 可放行\) · 标准 0\(需批准\)$/);
  assert.match(lines[2], /项目级 > 用户级 > legacy/);
  const full = leaf.summarizeGovernance({ counts: { configured: 2, connected: 1, disabled: 1, tools: 5 }, approval: { destructive: 1, readOnly: 1, standard: 3 } });
  assert.match(full[0], /配置 2 · 已连接 1 · 禁用 1 · 工具 5/);
  assert.match(full[1], /破坏性 1\(人闸门\) · 只读 1\(plan 可放行\) · 标准 3\(需批准\)/);
  assert.equal(leaf.summarizeGovernance(null).length, 3);
});
