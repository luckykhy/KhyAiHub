'use strict';

/**
 * openclaw.test.js — 钉死 OpenClaw 适配器的真实行为:状态目录/工作区双层布局、
 * `__proto__` 保留服务器名的三重处理(读跳过、写拒绝、回写经 defineProperty 原样带回)、
 * JSON5 配置拒绝重写、跨工具记忆导入只落 memory/imports/khy-os/ 绝不动用户策展的
 * MEMORY.md、单文件技能升格为目录型。
 *
 * 为什么这支套件必须存在:openclaw.json 是 OpenClaw 的**主配置文件**,写入是整文件
 * 重序列化——解析失败时必须拒写(重写 JSON5 会抹掉注释),保留名处理出错会污染
 * Object.prototype 并静默丢用户条目;MEMORY.md 是用户手工策展的长期事实,导入如果
 * append 进去就是不可预期副作用。这些全是「错了不报错、错了才安静」的路径。
 *
 * 实测更正(与直觉不同处,按真实行为钉死):
 *   · JSON.parse 造的自有 `__proto__` 键:列表侧被跳过;写别的服务器时被摘掉
 *     (Object.assign 走 [[Set]] 会命中原型设置器),再由 _carryReserved 用
 *     defineProperty 重新带回——落盘文件里保留名条目仍在,OpenClaw 不加载但它不该被抹掉。
 *   · agents.defaults.workspace 声明到状态根之外('../' 或绝对越界)→ 静默回落 'workspace'。
 *   · OpenClaw 没有单文件技能形态:跨工具导入的 file:md 技能一律升格为 <dir>/SKILL.md。
 *   · listTools 对 JSON5 的报错文案自带「不重写以免抹掉注释」的理由。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const A = require('./openclaw');
const M = require('../assetModel');

const TMP_DIRS = [];

function makeRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-oclaw-'));
  TMP_DIRS.push(dir);
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function envFor(root, extra) {
  return Object.assign({ KHY_AGENT_ASSETS_OPENCLAW_ROOT: root, HOME: root }, extra || {});
}

function readBack(root, rel) {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}

after(() => {
  for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true });
});

// ── detect ──────────────────────────────────────────────────────────────

test('detect 次序:KHY 覆盖 > OPENCLAW_STATE_DIR > OPENCLAW_CONFIG_PATH 目录 > ~/.openclaw', () => {
  const a = makeRoot({ '.keep': '' });
  const b = makeRoot({ '.keep': '' });
  assert.equal(A.detect({ KHY_AGENT_ASSETS_OPENCLAW_ROOT: a, OPENCLAW_STATE_DIR: b }).root, a);
  assert.equal(A.detect({ OPENCLAW_STATE_DIR: b, HOME: a }).root, b);

  const cfg = makeRoot({ 'openclaw.json': '{}' });
  assert.equal(A.detect({ OPENCLAW_CONFIG_PATH: path.join(cfg, 'openclaw.json'), HOME: a }).root, cfg);

  const home = makeRoot({ '.openclaw/.keep': '' });
  const d = A.detect({ HOME: home });
  assert.equal(d.ok, true);
  assert.equal(d.via, 'default');
  assert.equal(d.root, path.join(home, '.openclaw'));

  const bad = A.detect({ KHY_AGENT_ASSETS_OPENCLAW_ROOT: path.join(a, 'nope'), OPENCLAW_STATE_DIR: b });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /指向的目录不存在/);
});

// ── tool:mcp.servers 与保留名 ──────────────────────────────────────────

test('listTools:__proto__ 自有键被跳过(不污染原型),其余凭据出口抹掉;JSON5 报错带理由', () => {
  const root = makeRoot({
    'openclaw.json': '{"mcp":{"servers":{'
      + '"__proto__":{"url":"ghost"},'
      + '"alpha":{"url":"http://a","headers":{"Authorization":"Bearer zzz1234567890"}}}}}',
  });
  const env = envFor(root);
  const lt = A.listTools(env);
  assert.equal(lt.ok, true);
  assert.deepEqual(lt.assets.map((a) => a.name), ['alpha']);
  assert.equal(lt.assets[0].spec.headers.Authorization, M.REDACTED);
  assert.deepEqual(lt.assets[0].source.redactedFields, ['headers.Authorization']);
  assert.equal(lt.assets[0].source.format, 'json:mcp.servers');
  assert.equal({}.polluted, undefined);

  const json5 = makeRoot({ 'openclaw.json': '{ /* 用户注释 */ "mcp": {}, }' });
  const bad = A.listTools(envFor(json5));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /JSON5/);
});

test('writeAsset(tool):拒绝写 __proto__;写他人时被摘掉的保留名条目原样带回落盘', () => {
  const root = makeRoot({
    'openclaw.json': '{"mcp":{"servers":{'
      + '"__proto__":{"url":"ghost"},'
      + '"alpha":{"url":"http://old","env":{"API_KEY":"sk-keepme12345678"}}}}}',
  });
  const env = envFor(root);

  const rejected = A.writeAsset('tool', { name: '__proto__', kind: 'mcp_server', spec: {} }, undefined, env);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /保留服务器名/);

  const alpha = A.listTools(env).assets[0];
  const wet = A.writeAsset('tool', alpha, { dryRun: false }, env);
  assert.equal(wet.ok, true);
  const back = readBack(root, 'openclaw.json');
  assert.ok(!back.includes(M.REDACTED));
  const doc = JSON.parse(back);
  // Object.assign 摘掉的自有 __proto__ 由 _carryReserved 用 defineProperty 带回
  assert.ok(Object.prototype.hasOwnProperty.call(doc.mcp.servers, '__proto__'));
  assert.equal(doc.mcp.servers.__proto__.url, 'ghost');
  assert.equal(doc.mcp.servers.alpha.env.API_KEY, 'sk-keepme12345678');

  const unsupported = A.writeAsset('tool', { name: 'x', kind: 'builtin', spec: {} }, undefined, env);
  assert.equal(unsupported.unsupported, true);
});

// ── memory:工作区布局与策展文件 ────────────────────────────────────────

test('listMemories:MEMORY.md/USER.md 为 global,memory/*.md 为 project,.dreams 不读', () => {
  const root = makeRoot({
    'workspace/MEMORY.md': '# 长期事实\n策展内容\n',
    'workspace/USER.md': '# 用户\n偏好内容\n',
    'workspace/memory/2026-09-29.md': '---\nname: d1\n---\n日记\n',
    'workspace/memory/.dreams/hidden.md': '不该出现\n',
  });
  const lm = A.listMemories(envFor(root));
  assert.equal(lm.ok, true);
  const ids = lm.assets.map((a) => a.id).sort();
  assert.deepEqual(ids, ['MEMORY', 'USER', 'd1']);
  assert.equal(lm.assets.find((a) => a.id === 'MEMORY').scope, 'global');
  assert.equal(lm.assets.find((a) => a.id === 'd1').scope, 'project');
});

test('workspace 可被配置改写;越界声明静默回落默认 workspace 目录', () => {
  const custom = makeRoot({
    'openclaw.json': JSON.stringify({ agents: { defaults: { workspace: 'ws2' } } }),
    'ws2/MEMORY.md': '自定义工作区\n',
    'workspace/MEMORY.md': '默认工作区\n',
  });
  const env = envFor(custom);
  const lm = A.listMemories(env);
  assert.deepEqual(lm.assets.map((a) => a.source.path), ['ws2/MEMORY.md']);

  const escape = makeRoot({
    'openclaw.json': JSON.stringify({ agents: { defaults: { workspace: '../escape-MARKER' } } }),
    'workspace/MEMORY.md': '回落内容\n',
  });
  fs.mkdirSync(path.join(escape, '..', 'escape-MARKER'), { recursive: true });
  fs.writeFileSync(path.join(escape, '..', 'escape-MARKER', 'MEMORY.md'), '越界 MARKER\n');
  const fell = A.listMemories(envFor(escape));
  assert.equal(fell.assets[0].source.path, 'workspace/MEMORY.md');
  assert.ok(!readBack(escape, 'workspace/MEMORY.md').includes('MARKER'));
});

test('跨工具记忆导入:落 workspace/memory/imports/khy-os/,绝不 append 用户 MEMORY.md', () => {
  const originalCurated = '# 我手工策展的长期事实\n';
  const root = makeRoot({ 'workspace/MEMORY.md': originalCurated });
  const env = envFor(root);
  const imported = {
    kind: 'memory', id: 'x note', scope: 'project', title: 'X', content: 'body\n',
    tags: [], source: { tool: 'claude-code', path: 'projects/p/memory/x.md', format: '' },
  };
  const dry = A.writeAsset('memory', imported, undefined, env);
  assert.deepEqual(dry.plan.map((p) => p.path), ['workspace/memory/imports/khy-os/x-note.md']);
  assert.match(dry.plan[0].reason, /imports\/khy-os/);
  const wet = A.writeAsset('memory', imported, { dryRun: false }, env);
  assert.equal(wet.ok, true);
  assert.equal(readBack(root, 'workspace/MEMORY.md'), originalCurated);
});

// ── skill ───────────────────────────────────────────────────────────────

test('listSkills:工作区优先于状态目录,同名技能只留先见;嵌套 SKILL.md 也发现(6 层)', () => {
  const root = makeRoot({
    'workspace/skills/shared/SKILL.md': '---\nname: shared\n---\nWS 版\n',
    'skills/shared/SKILL.md': '---\nname: shared\n---\nSTATE 版\n',
    'skills/deep/a/b/c/SKILL.md': '---\nname: deep-one\n---\n深层\n',
  });
  const ls = A.listSkills(envFor(root));
  const by = Object.fromEntries(ls.assets.map((a) => [a.name, a]));
  assert.deepEqual(Object.keys(by).sort(), ['deep-one', 'shared']);
  assert.equal(by.shared.source.path, 'workspace/skills/shared');
  assert.equal(by['deep-one'].source.format, 'dir:SKILL.md');
});

test('技能写入:OpenClaw 只认目录型——单文件技能一律升格为 <dir>/SKILL.md(实测)', () => {
  const root = makeRoot({ '.keep': '' });
  const env = envFor(root);
  const loose = {
    kind: 'skill', name: 'Loose Skill', entry: 'loose.md', contents: { 'loose.md': 'l\n', 'x.txt': 'x' },
    source: { tool: 'opencode', path: 'command/loose.md', format: 'file:md' },
  };
  const dry = A.writeAsset('skill', loose, undefined, env);
  assert.deepEqual(dry.plan.map((p) => p.path),
    ['workspace/skills/Loose-Skill/SKILL.md', 'workspace/skills/Loose-Skill/x.txt']);
  const missing = A.writeAsset('skill', { name: 's', entry: 'SKILL.md', contents: {} }, undefined, env);
  assert.match(missing.error, /缺少主文件内容/);
});

// ── removeAsset ─────────────────────────────────────────────────────────

test('removeAsset:tool 摘除服务器且带回保留名;目录技能实删整目录;未知类型 unsupported', () => {
  const root = makeRoot({
    'openclaw.json': '{"mcp":{"servers":{"__proto__":{"url":"g"},"gone":{"url":"x"},"keep":{"url":"k"}}}}',
    'workspace/skills/del/SKILL.md': '---\nname: del\n---\nx\n',
    'workspace/skills/del/res.txt': 'r',
  });
  const env = envFor(root);

  const dry = A.removeAsset('tool', 'gone', undefined, env);
  assert.deepEqual(dry.plan.map((p) => p.path), ['openclaw.json']);
  assert.deepEqual(dry.removed, []);
  const wet = A.removeAsset('tool', 'gone', { dryRun: false }, env);
  assert.equal(wet.ok, true);
  const doc = JSON.parse(readBack(root, 'openclaw.json'));
  assert.deepEqual(Object.keys(doc.mcp.servers).sort(), ['__proto__', 'keep']);

  const rm = A.removeAsset('skill', 'del', { dryRun: false }, env);
  assert.deepEqual(rm.removed, ['workspace/skills/del']);
  assert.equal(fs.existsSync(path.join(root, 'workspace/skills/del')), false);

  const bad = A.readAsset('bogus', 'x', env);
  assert.equal(bad.unsupported, true);
});
