'use strict';

/**
 * harness.test.js — 钉死通用 harness 约定适配器的真实行为:双覆盖变量的探测优先级、
 * tools.json 两形态(数组/映射)与 kind 映射、tool 类「不可写」的短路时机、
 * AGENTS.md 无 frontmatter 时的逐字节回吐、技能单文件/目录两形态的落点选择。
 *
 * 为什么这支套件必须存在:harness 是对**跨工具共享文件约定**的适配(AGENTS.md +
 * tools.json + skills/),本仓三家适配器都参照它;它的 tool 只读声明是整个适配器
 * 契约里第一个「显式不支持而非抛异常」的能力位——契约退化(比如误把 unsupported 分支
 * 挪到 detect 之后)会让上层在没装 harness 的机器上拿到令人困惑的「未检测到根目录」。
 *
 * 实测更正(与直觉不同处,按真实行为钉死):
 *   · writeAsset('tool') 的 unsupported 短路发生在 **detect 之前**:根目录探测失败
 *     也返回 unsupported,而不是探测错误。removeAsset('tool') 同理短路在 readAsset 之前。
 *   · tools.json 条目的 kind 取 `kind || type` 并**小写**后查映射;未知值一律 local_command。
 *   · 跨工具导入且无附属资源 → 单文件 skills/<slug>.md;有附属资源 → 目录型;
 *     同工具往返时按来处 format 决定(不再自行升格/降级)。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const A = require('./harness');
const M = require('../assetModel');

const TMP_DIRS = [];

function makeRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-hx-'));
  TMP_DIRS.push(dir);
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function envFor(root, extra) {
  return Object.assign({ KHY_AGENT_ASSETS_HARNESS_ROOT: root, HOME: root }, extra || {});
}

function readBack(root, rel) {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}

after(() => {
  for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true });
});

// ── detect / capabilities ────────────────────────────────────────────────

test('detect:KHY 覆盖 > AGENT_HARNESS_HOME;覆盖指向不存在目录硬失败不回退', () => {
  const primary = makeRoot({ '.keep': '' });
  const secondary = makeRoot({ '.keep': '' });
  const d = A.detect({ KHY_AGENT_ASSETS_HARNESS_ROOT: primary, AGENT_HARNESS_HOME: secondary });
  assert.equal(d.via, 'env:KHY_AGENT_ASSETS_HARNESS_ROOT');
  assert.equal(d.root, primary);

  const bad = A.detect({
    KHY_AGENT_ASSETS_HARNESS_ROOT: path.join(primary, 'nope'),
    AGENT_HARNESS_HOME: secondary,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /指向的目录不存在/);

  // AGENT_HARNESS_HOME 与 KHY 变量同列 envKeys(不是候选)——指向不存在目录同样硬失败
  const ghost = path.join(primary, 'nope2');
  const bad2 = A.detect({ AGENT_HARNESS_HOME: ghost, HOME: primary });
  assert.equal(bad2.ok, false);
  assert.match(bad2.error, /AGENT_HARNESS_HOME 指向的目录不存在/);

  // 两个 envKey 都未设置时才走默认候选(XDG / ~/.agent-harness / ~/.agents)
  const home = makeRoot({ '.agent-harness/.keep': '' });
  const fell = A.detect({ HOME: home });
  assert.equal(fell.ok, true);
  assert.equal(fell.root, path.join(home, '.agent-harness'));
});

test('capabilities:tool 声明为可读不可写,并注明原因', () => {
  const root = makeRoot({ '.keep': '' });
  const caps = A.capabilities(envFor(root));
  assert.equal(caps.detected, true);
  assert.equal(caps.kinds.tool.read, true);
  assert.equal(caps.kinds.tool.write, false);
  assert.match(caps.kinds.tool.note, /tools\.json/);
  assert.equal(caps.kinds.memory.write, true);
});

// ── tool(只读)─────────────────────────────────────────────────────────

test('listTools:数组与映射两形态;kind||type 小写查映射,未知归 local_command', () => {
  const arrRoot = makeRoot({
    'tools.json': JSON.stringify([
      { name: 'grep', kind: 'MCP' },
      { name: 'run', type: 'COMMAND' },
      { name: 'weird', kind: 'quantum' },
      { description: '无名字条目会被跳过' },
    ]),
  });
  const arr = A.listTools(envFor(arrRoot));
  assert.equal(arr.ok, true);
  assert.deepEqual(arr.assets.map((a) => a.name), ['grep', 'run', 'weird']);
  assert.deepEqual(arr.assets.map((a) => a.toolKind), ['mcp_server', 'local_command', 'local_command']);
  assert.equal(arr.assets[0].source.format, 'json:array');

  const mapRoot = makeRoot({
    'tools.json': JSON.stringify({ shell: { kind: 'builtin', env: { TOKEN: 'abc' } } }),
  });
  const map = A.listTools(envFor(mapRoot));
  assert.equal(map.assets[0].toolKind, 'builtin');
  assert.equal(map.assets[0].spec.env.TOKEN, M.REDACTED);
  assert.deepEqual(map.assets[0].source.redactedFields, ['env.TOKEN']);
  assert.equal(map.assets[0].source.format, 'json:map');
});

test('listTools:tools.json 缺失 → 空列表;解析失败 → ok:false 带原因', () => {
  const empty = makeRoot({ '.keep': '' });
  const none = A.listTools(envFor(empty));
  assert.equal(none.ok, true);
  assert.deepEqual(none.assets, []);

  const broken = makeRoot({ 'tools.json': '{not json' });
  const bad = A.listTools(envFor(broken));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /tools\.json 解析失败/);
});

test('tool 写/删的 unsupported 短路在 detect 之前(实测):根不存在也回 unsupported', () => {
  const ghostEnv = { KHY_AGENT_ASSETS_HARNESS_ROOT: path.join(makeRoot({ '.keep': '' }), 'nope') };
  const w = A.writeAsset('tool', { name: 'x', kind: 'mcp_server', spec: {} }, undefined, ghostEnv);
  assert.equal(w.ok, false);
  assert.equal(w.unsupported, true);
  assert.match(w.error, /由 harness 自己生成/);

  const r = A.removeAsset('tool', 'x', undefined, ghostEnv);
  assert.equal(r.ok, false);
  assert.equal(r.unsupported, true);
  assert.match(r.error, /不可写/);
});

// ── memory ──────────────────────────────────────────────────────────────

test('AGENTS.md 无 frontmatter:同工具往返正文逐字节回吐;frontmatter 版本原文优先', () => {
  const original = '# 约定\n\n手写全局指令。\n';
  const root = makeRoot({ 'AGENTS.md': original, 'memory/pref.md': '---\nid: pref\ntitle: 偏好\nscope: global\ntags:\n  - style\n---\n正文\n' });
  const env = envFor(root);

  const lm = A.listMemories(env);
  assert.deepEqual(lm.assets.map((a) => a.id), ['AGENTS', 'pref']);
  const g = lm.assets.find((a) => a.id === 'AGENTS');
  assert.equal(g.scope, 'global');
  const p = lm.assets.find((a) => a.id === 'pref');
  assert.equal(p.scope, 'global');
  assert.deepEqual(p.tags, ['style']);

  const gw = A.writeAsset('memory', g, { dryRun: false }, env);
  assert.equal(gw.ok, true);
  assert.equal(readBack(root, 'AGENTS.md'), original);

  const pw = A.writeAsset('memory', p, { dryRun: false }, env);
  assert.equal(readBack(root, 'memory/pref.md'), '---\nid: pref\ntitle: 偏好\nscope: global\ntags:\n  - style\n---\n正文\n');
  assert.equal(pw.written.length, 1);
});

test('跨工具导入记忆:落 memory/<slug>.md 并生成 id/title/scope frontmatter;干跑不落盘', () => {
  const root = makeRoot({ '.keep': '' });
  const env = envFor(root);
  const imported = {
    kind: 'memory', id: 'my note/odd', scope: 'project', title: 'Imported',
    content: 'body\n', tags: ['t1'], source: { tool: 'claude-code', path: 'CLAUDE.md', format: '' },
  };
  const dry = A.writeAsset('memory', imported, undefined, env);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.plan.map((x) => x.path), ['memory/my-note-odd.md']);
  assert.equal(fs.existsSync(path.join(root, 'memory')), false);

  const wet = A.writeAsset('memory', imported, { dryRun: false }, env);
  assert.equal(wet.ok, true);
  const text = readBack(root, 'memory/my-note-odd.md');
  assert.match(text, /^---\nid: my note\/odd\ntitle: Imported\nscope: project\ntags:\n  - t1\n---\nbody\n$/);
});

// ── skill ───────────────────────────────────────────────────────────────

test('listSkills:目录型与单文件型都收;按名字读回', () => {
  const root = makeRoot({
    'skills/dir/SKILL.md': '---\nname: dsk\ndescription: dir skill\n---\n# D\n',
    'skills/loose.md': '---\nname: ls1\n---\nloose body\n',
  });
  const env = envFor(root);
  const ls = A.listSkills(env);
  assert.deepEqual(ls.assets.map((a) => a.name).sort(), ['dsk', 'ls1']);
  const dir = ls.assets.find((a) => a.name === 'dsk');
  assert.equal(dir.source.format, 'dir:SKILL.md');
  const loose = ls.assets.find((a) => a.name === 'ls1');
  assert.equal(loose.entry, 'loose.md');
  assert.equal(loose.source.format, 'file:md');
  assert.equal(A.readAsset('skill', 'dsk', env).ok, true);
});

test('技能写入两形态:跨工具无附属→单文件,有附属→目录;同工具按来处 format', () => {
  const root = makeRoot({ '.keep': '' });
  const env = envFor(root);

  const solo = { kind: 'skill', name: 'Solo One', entry: 'SKILL.md', contents: { 'SKILL.md': 's\n' }, source: { tool: 'claude-code', path: '', format: '' } };
  assert.deepEqual(A.writeAsset('skill', solo, undefined, env).plan.map((p) => p.path), ['skills/Solo-One.md']);

  const withExtras = { kind: 'skill', name: 'pack', entry: 'SKILL.md', contents: { 'SKILL.md': 's\n', 'res/x.txt': 'x' }, source: { tool: 'claude-code', path: '', format: '' } };
  assert.deepEqual(A.writeAsset('skill', withExtras, undefined, env).plan.map((p) => p.path),
    ['skills/pack/SKILL.md', 'skills/pack/res/x.txt']);

  // 同工具 file:md 往返:即便有附属资源也按来处 format 写回单文件(实测)
  const sameFile = {
    kind: 'skill', name: 'ls1', entry: 'loose.md', contents: { 'loose.md': 'loose body\n', 'extra.md': 'e' },
    source: { tool: 'harness', path: 'skills/loose.md', format: 'file:md' },
  };
  assert.deepEqual(A.writeAsset('skill', sameFile, undefined, env).plan.map((p) => p.path), ['skills/loose.md']);
});

// ── 错误面 ──────────────────────────────────────────────────────────────

test('readAsset:未知类型 unsupported;找不到报具体 kind:id', () => {
  const root = makeRoot({ '.keep': '' });
  const env = envFor(root);
  const bad = A.readAsset('whatever', 'x', env);
  assert.equal(bad.ok, false);
  assert.equal(bad.unsupported, true);
  assert.match(bad.error, /不支持的资产类型/);
  const miss = A.readAsset('memory', 'ghost', env);
  assert.equal(miss.ok, false);
  assert.match(miss.error, /未找到 memory:ghost/);
});

test('removeAsset 干跑默认:给计划不动盘;实删记忆文件', () => {
  const root = makeRoot({ 'memory/gone.md': '---\nid: gone\n---\nbye\n' });
  const env = envFor(root);
  const dry = A.removeAsset('memory', 'gone', undefined, env);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.plan.map((p) => p.path), ['memory/gone.md']);
  assert.equal(dry.removed.length, 0);

  const wet = A.removeAsset('memory', 'gone', { dryRun: false }, env);
  assert.equal(wet.ok, true);
  assert.deepEqual(wet.removed, ['memory/gone.md']);
  assert.equal(fs.existsSync(path.join(root, 'memory/gone.md')), false);
});
