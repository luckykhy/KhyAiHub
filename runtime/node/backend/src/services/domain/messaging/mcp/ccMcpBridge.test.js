/**
 * ccMcpBridge.test.js — 钉死 Claude Code MCP 资产复用的枚举序与浅拷贝防污染。
 *
 * 为什么这支套件必须存在：这台桥让 khy 直接复用 ~/.claude.json / <project>/.mcp.json
 * 里已配置的 MCP server ——本机 ~/.claude.json 真实存在，桥的提取语义（浅拷贝、
 * 空名剔除、projects 键归一化容忍度）会直接决定 khy 读到什么。纯叶子、壳注入
 * 已解析 JSON，可完全离线驱动。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. 门控 KHY_CC_MCP_BRIDGE 用本地 _FALSY 四词（trim+lower），不是 flagRegistry。
 * 2. ccMcpConfigSources(null) 抛 TypeError：解构在参数位，函数体内 try/catch 够不着 —
 *    "绝不抛"契约在参数绑定层失效 — 实测钉住。
 * 3. 同名 claudeJson-user/claudeJson-project 指向同一个文件，去重是壳的事。
 * 4. claudeJson-project 容忍度只做 path.resolve(projectDir) 精确键匹配：
 *    斜杠风格不同（'C:/x' vs 'C:\\x'）不命中 → {}。
 * 5. extractMcpServers 每台 server `{...cfg}` 浅拷贝——顶层解耦，嵌套 env 对象仍共享引用。
 * 6. 空串名 / null cfg / 字符串 cfg 全部剔除；kind 不认识 → {}（不抛）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const leaf = require('./ccMcpBridge');

test('ccBridge: 导出面', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), ['ccMcpConfigSources', 'extractMcpServers', 'isCcMcpBridgeEnabled']);
});

test('ccBridge: 门控 _FALSY 四词，默认 ON', () => {
  for (const off of ['0', 'false', 'off', 'no', ' OFF', 'No ']) {
    assert.equal(leaf.isCcMcpBridgeEnabled({ KHY_CC_MCP_BRIDGE: off }), false, off);
  }
  for (const on of [undefined, null, '', '1', 'true', 'yes', 'disable']) {
    assert.equal(leaf.isCcMcpBridgeEnabled({ KHY_CC_MCP_BRIDGE: on }), true, JSON.stringify(on));
  }
  assert.equal(leaf.isCcMcpBridgeEnabled(null), true);
});

test('ccBridge: sources 枚举序 user→project→mcpJson；缺段跳过；null 入参抛（契约失效注册）', () => {
  const both = leaf.ccMcpConfigSources({ homedir: '/h', projectDir: '/p' });
  assert.deepEqual(both.map((s) => s.kind), ['claudeJson-user', 'claudeJson-project', 'mcpJson']);
  assert.equal(both[0].path, leaf.ccMcpConfigSources({ homedir: '/h' })[0].path); // user 单源
  assert.deepEqual(leaf.ccMcpConfigSources({ homedir: '/h' }).map((s) => s.kind), ['claudeJson-user']);
  assert.deepEqual(leaf.ccMcpConfigSources({ projectDir: '/p' }).map((s) => s.kind), ['mcpJson']);
  assert.deepEqual(leaf.ccMcpConfigSources({}), []);
  assert.deepEqual(leaf.ccMcpConfigSources(), []);
  assert.equal(leaf.ccMcpConfigSources({ homedir: '/h', projectDir: '/p' })[2].path, path.join('/p', '.mcp.json'));
  assert.throws(() => leaf.ccMcpConfigSources(null), TypeError); // 参数位解构，body try 够不着
});

test('ccBridge: extract —— user/mcpJson 拿顶层，project 拿 projects 表', () => {
  const raw = {
    mcpServers: { fs: { command: 'npx', args: ['-y', 'fs'] } },
    projects: {
      '/proj/a': { mcpServers: { db: { type: 'sse', url: 'http://x' } } },
    },
  };
  assert.deepEqual(leaf.extractMcpServers(raw, 'claudeJson-user'), { fs: { command: 'npx', args: ['-y', 'fs'] } });
  assert.deepEqual(leaf.extractMcpServers(raw, 'mcpJson'), { fs: { command: 'npx', args: ['-y', 'fs'] } });
  assert.deepEqual(leaf.extractMcpServers(raw, 'claudeJson-project', '/proj/a'), { db: { type: 'sse', url: 'http://x' } });
  // 项目键不存在 / 缺 projectDir → {}
  assert.deepEqual(leaf.extractMcpServers(raw, 'claudeJson-project', '/nope'), {});
  assert.deepEqual(leaf.extractMcpServers(raw, 'claudeJson-project'), {});
  // 斜杠风格不同不宽容（resolve 后仍不匹配）— 实测钉住
  const winRaw = { projects: { 'C:/x': { mcpServers: { a: { command: 'c' } } } } };
  assert.deepEqual(leaf.extractMcpServers(winRaw, 'claudeJson-project', 'C:\\x'), {});
  // path.resolve 归一命中：相对键 vs 绝对 projectDir 场景用 resolve 后精确键
  const absDir = path.resolve('cc-bridge-probe');
  const resRaw = { projects: { [absDir]: { mcpServers: { hit: { command: 'H' } } } } };
  assert.deepEqual(leaf.extractMcpServers(resRaw, 'claudeJson-project', 'cc-bridge-probe'), { hit: { command: 'H' } });
  // 未知 kind / 脏输入 → {} 不抛
  assert.deepEqual(leaf.extractMcpServers(raw, 'weird'), {});
  assert.deepEqual(leaf.extractMcpServers(null, 'claudeJson-user'), {});
  assert.deepEqual(leaf.extractMcpServers(123, 'claudeJson-user'), {});
  assert.deepEqual(leaf.extractMcpServers({ mcpServers: 'str' }, 'mcpJson'), {});
});

test('ccBridge: 浅拷贝隔离顶层但共享嵌套引用；空名/非对象 cfg 剔除', () => {
  const raw = { mcpServers: { s: { command: 'c', env: { K: 'V' } }, '': { command: 'ghost' }, bad: null, str: 'x' } };
  const out = leaf.extractMcpServers(raw, 'claudeJson-user');
  assert.deepEqual(Object.keys(out), ['s']); // 空名/null/字符串 cfg 全剔
  assert.notEqual(out.s, raw.mcpServers.s);           // 顶层是拷贝
  assert.equal(out.s.env, raw.mcpServers.s.env);      // 嵌套仍共享 — 变异泄漏注册
  out.s.command = 'MUTATED';
  assert.equal(raw.mcpServers.s.command, 'c');        // 顶层改动不回写
  out.s.env.K = 'LEAKED';
  assert.equal(raw.mcpServers.s.env.K, 'LEAKED');     // 嵌套改动回写原 raw — 实测钉住
  raw.mcpServers.s.url = 'late';
  assert.equal('url' in out.s, false);                // raw 后续加字段不影响已拷贝
});
