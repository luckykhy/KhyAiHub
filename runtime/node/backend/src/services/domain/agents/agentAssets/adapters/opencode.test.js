'use strict';

/**
 * opencode.test.js — 钉死 opencode 适配器的真实行为:OPENCODE_CONFIG(指向文件、取目录)
 * 与 XDG 候选的探测次序、opencode.json 只碰 mcp 键的读写、JSON5/坏 JSON 的拒写、
 * command/*.md 与 skill/<name>/SKILL.md 两形态技能、单文件技能带附属资源时
 * 「附属资源平铺进 command/ 目录」这一与直觉不同的落点。
 *
 * 为什么这支套件必须存在:opencode.json 同时是 externalApps/opencodeAdapter 管理的
 * **模型 provider 配置**——本适配器只许碰 `mcp` 一个键。若写入路径退化成像 provider
 * 那样重写整棵树,用户的 provider 配置会连坐损坏;「解析失败拒绝写入」与
 * 「合并保留未知键」两条是共存的唯一安全前提,必须有断言压着。
 *
 * 实测更正(与直觉不同处,按真实行为钉死):
 *   · OPENCODE_CONFIG 走**候选通道**(via:'default',取 dirname),不是 envKeys——
 *     指向不存在目录时静默继续找 XDG,而非硬报错;只有 KHY_ 覆盖变量会硬报错。
 *   · 单文件技能(asFile)带附属资源时,附属资源写进 `path.posix.dirname(rel)`
 *     (即 command/),**不会**因此升格成目录型。
 *   · 配置文件不存在 ≠ 错误:listTools 回空列表;存在但解析失败才 ok:false。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const A = require('./opencode');
const M = require('../assetModel');

const TMP_DIRS = [];

function makeRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-oc-'));
  TMP_DIRS.push(dir);
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function envFor(root, extra) {
  return Object.assign({ KHY_AGENT_ASSETS_OPENCODE_ROOT: root, HOME: root }, extra || {});
}

function readBack(root, rel) {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}

after(() => {
  for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true });
});

// ── detect ──────────────────────────────────────────────────────────────

test('detect:KHY 覆盖硬失败不回落;OPENCODE_CONFIG 是候选,取文件所在目录、坏则继续找 XDG', () => {
  const root = makeRoot({ '.keep': '' });
  const bad = A.detect({ KHY_AGENT_ASSETS_OPENCODE_ROOT: path.join(root, 'nope'), HOME: root });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /指向的目录不存在/);

  // OPENCODE_CONFIG 指向**配置文件**:根取其 dirname,命中仍是候选通道
  const cfgRoot = makeRoot({ 'opencode.json': '{}' });
  const viaCfg = A.detect({
    OPENCODE_CONFIG: path.join(cfgRoot, 'opencode.json'),
    XDG_CONFIG_HOME: path.join(root, 'no-xdg'),
    HOME: root,
  });
  assert.equal(viaCfg.ok, true);
  assert.equal(viaCfg.root, cfgRoot);
  assert.equal(viaCfg.via, 'default');

  // OPENCODE_CONFIG 目录不存在 → 不硬报错,静默继续找 XDG 候选
  const xdg = makeRoot({ 'opencode/.keep': '' });
  const fell = A.detect({
    OPENCODE_CONFIG: path.join(root, 'ghost-dir', 'opencode.json'),
    XDG_CONFIG_HOME: xdg,
    HOME: root,
  });
  assert.equal(fell.ok, true);
  assert.equal(fell.via, 'default');
  assert.equal(fell.root, path.join(xdg, 'opencode'));

  const none = A.detect({ HOME: root });
  assert.equal(none.ok, false);
});

// ── tool:mcp 键 ─────────────────────────────────────────────────────────

test('listTools:只吃 mcp 键、其余顶层键无视;凭据出口抹掉;坏 JSON 报错', () => {
  const root = makeRoot({
    'opencode.json': JSON.stringify({
      provider: { openrouter: { models: {} } },
      mcp: {
        db: { type: 'local', command: ['npx', 'db'], environment: { API_KEY: 'sk-abcdefgh12345' }, enabled: true },
      },
    }),
  });
  const env = envFor(root);
  const lt = A.listTools(env);
  assert.equal(lt.ok, true);
  assert.deepEqual(lt.assets.map((a) => a.name), ['db']);
  const db = lt.assets[0];
  assert.equal(db.toolKind, 'mcp_server');
  assert.equal(db.spec.environment.API_KEY, M.REDACTED);
  assert.deepEqual(db.source.redactedFields, ['environment.API_KEY']);
  assert.equal(db.spec.type, 'local');
  assert.equal(db.source.format, 'json:mcp');

  const broken = makeRoot({ 'opencode.json': '{"mcp": {},}' });
  const bad = A.listTools(envFor(broken));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /opencode\.json 解析失败/);

  const none = A.listTools(envFor(makeRoot({ '.keep': '' })));
  assert.equal(none.ok, true);
  assert.deepEqual(none.assets, []);
});

test('writeAsset(tool):合并保留 provider 等未知顶层键,凭据沿用目标现值;解析失败拒写', () => {
  const secret = 'sk-abcdefgh12345';
  const root = makeRoot({
    'opencode.json': JSON.stringify({
      provider: { keep: true },
      mcp: { db: { type: 'local', command: ['npx'], environment: { API_KEY: secret } } },
    }, null, 2),
  });
  const env = envFor(root);
  const db = A.listTools(env).assets[0];
  const wet = A.writeAsset('tool', db, { dryRun: false }, env);
  assert.equal(wet.ok, true);
  const back = readBack(root, 'opencode.json');
  assert.ok(!back.includes(M.REDACTED));
  const doc = JSON.parse(back);
  assert.deepEqual(doc.provider, { keep: true });
  assert.deepEqual(doc.mcp.db.environment, { API_KEY: secret });

  const brokenEnv = envFor(makeRoot({ 'opencode.json': '{oops' }));
  const refused = A.writeAsset('tool', { name: 'x', kind: 'mcp_server', spec: {} }, undefined, brokenEnv);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /解析失败,拒绝写入/);

  const unsupported = A.writeAsset('tool', { name: 'x', kind: 'local_command', spec: {} }, undefined, env);
  assert.equal(unsupported.unsupported, true);
});

// ── memory ──────────────────────────────────────────────────────────────

test('memory:AGENTS.md 同工具往返逐字节;跨工具导入落 memory/<slug>.md', () => {
  const plain = '# opencode 指令\n\n手写。\n';
  const root = makeRoot({ 'AGENTS.md': plain });
  const env = envFor(root);
  const g = A.listMemories(env).assets[0];
  assert.equal(g.id, 'AGENTS');
  assert.equal(g.scope, 'global');
  A.writeAsset('memory', g, { dryRun: false }, env);
  assert.equal(readBack(root, 'AGENTS.md'), plain);

  const imported = {
    kind: 'memory', id: 'a b/c', scope: 'project', title: 'T', content: 'x\n',
    tags: [], source: { tool: 'claude-code', path: 'CLAUDE.md', format: '' },
  };
  const dry = A.writeAsset('memory', imported, undefined, env);
  assert.deepEqual(dry.plan.map((p) => p.path), ['memory/a-b-c.md']);
  const wet = A.writeAsset('memory', imported, { dryRun: false }, env);
  assert.equal(wet.ok, true);
  assert.equal(readBack(root, 'memory/a-b-c.md'), '---\nname: a b/c\ntitle: T\nscope: project\n---\nx\n');
});

// ── skill ───────────────────────────────────────────────────────────────

test('listSkills:command/*.md 单文件型 + skill/<name>/SKILL.md 目录型', () => {
  const root = makeRoot({
    'command/build.md': '---\nname: build\ndescription: 构建\n---\nbuild steps\n',
    'skill/dw/SKILL.md': '---\nname: dw\n---\n# DW\n',
  });
  const env = envFor(root);
  const ls = A.listSkills(env);
  const by = Object.fromEntries(ls.assets.map((a) => [a.name, a]));
  assert.equal(by.build.entry, 'build.md');
  assert.equal(by.build.source.format, 'file:md');
  assert.equal(by.build.source.path, 'command/build.md');
  assert.equal(by.dw.entry, 'SKILL.md');
  assert.equal(by.dw.source.format, 'dir:SKILL.md');
  assert.equal(by.dw.source.path, 'skill/dw');
});

test('技能写入:跨工具带附属资源→目录型落 skill/;同工具 file:md 带附属资源→平铺 command/(实测)', () => {
  const root = makeRoot({ '.keep': '' });
  const env = envFor(root);
  const foreign = {
    kind: 'skill', name: 'pack', entry: 'pack.md',
    contents: { 'pack.md': 'p\n', 'extra.txt': 'e' },
    source: { tool: 'harness', path: 'skills/pack.md', format: 'file:md' },
  };
  // 跨工具导入不看来处 format,只看有无附属资源:有附属 → 目录型 skill/pack/
  const dry = A.writeAsset('skill', foreign, undefined, env);
  assert.deepEqual(dry.plan.map((p) => p.path), ['skill/pack/SKILL.md', 'skill/pack/extra.txt']);

  // 同工具 file:md 往返带附属资源:主文件写回来处,附属资源平铺进其所在目录(command/)
  const sameFile = {
    kind: 'skill', name: 'pack', entry: 'pack.md',
    contents: { 'pack.md': 'p\n', 'extra.txt': 'e' },
    source: { tool: 'opencode', path: 'command/pack.md', format: 'file:md' },
  };
  assert.deepEqual(A.writeAsset('skill', sameFile, undefined, env).plan.map((p) => p.path),
    ['command/pack.md', 'command/extra.txt']);

  // 同工具目录型往返按来处路径;缺主文件内容报错
  const sameDir = {
    kind: 'skill', name: 'dw', entry: 'SKILL.md', contents: { 'SKILL.md': '# DW\n' },
    source: { tool: 'opencode', path: 'skill/dw', format: 'dir:SKILL.md' },
  };
  assert.deepEqual(A.writeAsset('skill', sameDir, undefined, env).plan.map((p) => p.path), ['skill/dw/SKILL.md']);

  const missing = A.writeAsset('skill', { name: 's', entry: 'SKILL.md', contents: {} }, undefined, env);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /缺少主文件内容/);
});

// ── removeAsset ─────────────────────────────────────────────────────────

test('removeAsset:tool 干跑只给计划、实写摘除 mcp 键保留其余;记忆实删文件', () => {
  const root = makeRoot({
    'opencode.json': JSON.stringify({ provider: { k: 1 }, mcp: { db: { type: 'local' }, keepme: { url: 'u' } } }, null, 2),
    'memory/gone.md': '---\nname: gone\n---\nbye\n',
  });
  const env = envFor(root);

  const dry = A.removeAsset('tool', 'db', undefined, env);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.plan.map((p) => p.path), ['opencode.json']);
  assert.ok(readBack(root, 'opencode.json').includes('"db"'));

  const wet = A.removeAsset('tool', 'db', { dryRun: false }, env);
  assert.equal(wet.ok, true);
  const doc = JSON.parse(readBack(root, 'opencode.json'));
  assert.deepEqual(Object.keys(doc.mcp), ['keepme']);
  assert.deepEqual(doc.provider, { k: 1 });

  const rm = A.removeAsset('memory', 'gone', { dryRun: false }, env);
  assert.deepEqual(rm.removed, ['memory/gone.md']);
  assert.equal(fs.existsSync(path.join(root, 'memory/gone.md')), false);
});
