'use strict';

/**
 * claudeCode.test.js — 钉死 Claude Code 适配器的真实行为:根探测的覆盖优先级、
 * 项目 slug「逐字符换横线、不合并」规则、跨工具导入只落托管目录绝不动 CLAUDE.md、
 * MEMORY.md 索引幂等、凭据出口抹掉/回写用目标现值填回、dryRun 默认为真。
 *
 * 为什么这支套件必须存在:本适配器是三家外部工具里唯一「往别人配置文件里合并」的一家
 * (settings.json 的 mcpServers),写坏一次就毁掉用户的 Claude Code 配置。凭据的
 * 抹掉/填回链路(redactCredentials → IR → restoreRedacted)只要有一环退化,要么密钥
 * 进 IR 外流,要么占位符覆盖掉用户真实密钥——两头都是事故,只能靠断言锁死。
 *
 * 实测更正(与直觉不同处,按真实行为钉死):
 *   · probeRoot 的覆盖变量指向不存在目录 → 硬报错,**不**静默回退 CLAUDE_CONFIG_DIR / ~/.claude。
 *   · slug 把每个非字母数字字符各换成一条横线且**不合并连续**: 'C:\\khy-os' → 'C--khy-os';
 *     POSIX 路径首字符也是横线: '/home/u/p' → '-home-u-p'。
 *   · 同工具往返且来处本无 frontmatter → 正文逐字节回吐,**不**替用户插 frontmatter。
 *   · 索引行只在 MEMORY.md 不含 "(<file>.md)" 时才补;重复导入不重复登记。
 *   · 跨工具导入的技能目录名 sanitize 不修剪首尾横线('weird name!' → 'weird-name-')。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const A = require('./claudeCode');
const M = require('../assetModel');

// ── 工具:临时资产根 + 受控 env(绝不触碰 process.env 与真实主目录)──────────

const TMP_DIRS = [];

function makeRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cc-'));
  TMP_DIRS.push(dir);
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function envFor(root, extra) {
  return Object.assign({ KHY_AGENT_ASSETS_CLAUDE_CODE_ROOT: root, HOME: root }, extra || {});
}

function readBack(root, rel) {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}

after(() => {
  for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true });
});

// ── detect / capabilities ────────────────────────────────────────────────

test('detect:khy 专用覆盖变量优先于 CLAUDE_CONFIG_DIR;覆盖指向不存在目录时硬失败不回退', () => {
  const primary = makeRoot({ '.keep': '' });
  const fallback = makeRoot({ '.keep': '' });
  const d = A.detect({ KHY_AGENT_ASSETS_CLAUDE_CODE_ROOT: primary, CLAUDE_CONFIG_DIR: fallback });
  assert.equal(d.ok, true);
  assert.equal(d.root, primary);
  assert.equal(d.via, 'env:KHY_AGENT_ASSETS_CLAUDE_CODE_ROOT');

  const ghost = path.join(primary, 'nope');
  const bad = A.detect({ KHY_AGENT_ASSETS_CLAUDE_CODE_ROOT: ghost, CLAUDE_CONFIG_DIR: fallback });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /KHY_AGENT_ASSETS_CLAUDE_CODE_ROOT 指向的目录不存在/);
  // 钉死:显式覆盖失败后不再尝试任何后续候选(用户指定过位置,悄悄换地方比报错更糟)
  assert.ok(!bad.checked.some((c) => c.location === fallback));
});

test('detect:无覆盖时回退 ~/.claude 默认候选;capabilities 未探测到如实声明', () => {
  const home = makeRoot({ '.claude/.keep': '' });
  const d = A.detect({ HOME: home });
  assert.equal(d.ok, true);
  assert.equal(d.via, 'default');
  assert.equal(d.root, path.join(home, '.claude'));

  const ghostHome = makeRoot({ '.keep': '' });
  const caps = A.capabilities({ HOME: ghostHome });
  assert.equal(caps.detected, false);
  assert.equal(caps.root, '');
  assert.deepEqual(caps.rootEnvKeys, A.ROOT_ENV_KEYS);
  assert.deepEqual(Object.keys(caps.kinds).sort(), ['memory', 'skill', 'tool']);
  assert.equal(caps.kinds.tool.write, true);
});

// ── 项目 slug ────────────────────────────────────────────────────────────

test('slug:逐字符换横线不合并(Windows 冒号+反斜杠各算一条),POSIX 首字符也是横线', () => {
  const root = makeRoot({
    'projects/C--khy-os/memory/win-note.md':
      '---\nname: win-note\ndescription: Win note\nmetadata:\n  scope: project\n  type: insight\n---\nwin body\n',
    'projects/-home-u-p/memory/posix-note.md': '---\nname: posix-note\n---\nposix body\n',
  });

  const win = A.listMemories(envFor(root, { KHYQUANT_CWD: 'C:\\khy-os' }));
  assert.equal(win.ok, true);
  assert.deepEqual(win.assets.map((a) => a.id), ['win-note']);
  const w = win.assets[0];
  assert.equal(w.source.path, 'projects/C--khy-os/memory/win-note.md');
  // description → title、metadata.type → tags、metadata.scope 合法则采纳
  assert.equal(w.title, 'Win note');
  assert.deepEqual(w.tags, ['insight']);
  assert.equal(w.scope, 'project');

  const posix = A.listMemories(envFor(root, { KHYQUANT_CWD: '/home/u/p/' }));
  assert.deepEqual(posix.assets.map((a) => a.id), ['posix-note']);

  // 显式项目覆盖变量优先于 KHYQUANT_CWD 推算
  const forced = A.listMemories(envFor(root, {
    KHY_AGENT_ASSETS_CLAUDE_PROJECT: 'C--khy-os',
    KHYQUANT_CWD: '/home/u/p',
  }));
  assert.deepEqual(forced.assets.map((a) => a.id), ['win-note']);
});

// ── memory 读取与往返 ────────────────────────────────────────────────────

test('CLAUDE.md:scope=global,同工具往返正文逐字节回吐、不插 frontmatter', () => {
  const original = '# 全局规则\n\n手写正文,没有 frontmatter。\n';
  const root = makeRoot({ 'CLAUDE.md': original });
  const env = envFor(root);
  const lm = A.listMemories(env);
  assert.deepEqual(lm.assets.map((a) => a.id), ['CLAUDE']);
  const g = lm.assets[0];
  assert.equal(g.scope, 'global');
  assert.equal(g.content, original);
  assert.equal(g.raw.frontmatterText, '');

  const dry = A.writeAsset('memory', g, undefined, env);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.plan.length, 1);
  assert.equal(dry.plan[0].path, 'CLAUDE.md');

  const wet = A.writeAsset('memory', g, { dryRun: false }, env);
  assert.equal(wet.ok, true);
  assert.deepEqual(wet.written, ['CLAUDE.md']);
  assert.equal(readBack(root, 'CLAUDE.md'), original);
});

test('frontmatter 记忆:原文优先回吐 → native → IR → native 逐字节等价', () => {
  const original = '---\nname: pref\ndescription: 偏好\nmetadata:\n  scope: project\n---\n正文一行\n';
  const root = makeRoot({ 'projects/p/memory/pref.md': original });
  const env = envFor(root, { KHY_AGENT_ASSETS_CLAUDE_PROJECT: 'p' });
  const asset = A.readAsset('memory', 'pref', env).asset;
  assert.ok(asset);
  const wet = A.writeAsset('memory', asset, { dryRun: false }, env);
  assert.equal(wet.ok, true);
  assert.equal(readBack(root, 'projects/p/memory/pref.md'), original);
});

// ── 跨工具导入:落点 + 索引 ─────────────────────────────────────────────

test('跨工具导入:一律落 projects/<slug>/memory/ 并登记 MEMORY.md,重复导入索引幂等', () => {
  const root = makeRoot({ '.keep': '' });
  const env = envFor(root, { KHY_AGENT_ASSETS_CLAUDE_PROJECT: 'proj' });
  const imported = {
    kind: 'memory', id: 'imported', scope: 'project', title: 'Imported',
    content: 'hello world\nsecond line\n', tags: [],
    source: { tool: 'opencode', path: 'memory/imported.md', format: 'markdown+frontmatter' },
  };

  const dry = A.writeAsset('memory', imported, undefined, env);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.plan.map((p) => p.path), [
    'projects/proj/memory/imported.md',
    'projects/proj/memory/MEMORY.md',
  ]);
  assert.equal(dry.written.length, 0);
  assert.equal(fs.existsSync(path.join(root, 'projects')), false);

  const wet = A.writeAsset('memory', imported, { dryRun: false }, env);
  assert.equal(wet.ok, true);
  const body = readBack(root, 'projects/proj/memory/imported.md');
  assert.equal(
    body,
    '---\nname: imported\ndescription: Imported\nmetadata:\n  scope: project\n---\nhello world\nsecond line\n'
  );
  assert.equal(readBack(root, 'projects/proj/memory/MEMORY.md'),
    '# Memory Index\n\n- [Imported](imported.md) — hello world\n');

  // 第二次导入:索引已含 (imported.md) → 不再追加,plan 只剩正文一项
  const wet2 = A.writeAsset('memory', imported, { dryRun: false }, env);
  assert.equal(wet2.plan.length, 1);
  assert.equal(readBack(root, 'projects/proj/memory/MEMORY.md'),
    '# Memory Index\n\n- [Imported](imported.md) — hello world\n');

  // 导入绝不写用户的 CLAUDE.md
  assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md')), false);
});

// ── tool:mcpServers + 凭据链路 ──────────────────────────────────────────

test('listTools:凭据在出口抹掉;回写用目标现值填回,REDACTED 绝不落盘', () => {
  const secret = 'sk-real-secret-value';
  const root = makeRoot({
    'settings.json': JSON.stringify({
      mcpServers: { demo: { command: 'npx', env: { API_KEY: secret } } },
    }, null, 2),
  });
  const env = envFor(root);
  const lt = A.listTools(env);
  assert.equal(lt.ok, true);
  const demo = lt.assets.find((a) => a.name === 'demo');
  assert.equal(demo.spec.env.API_KEY, M.REDACTED);
  assert.deepEqual(demo.source.redactedFields, ['env.API_KEY']);
  assert.equal(demo.source.path, 'settings.json');
  assert.equal(demo.toolKind, 'mcp_server');

  const wet = A.writeAsset('tool', demo, { dryRun: false }, env);
  assert.equal(wet.ok, true);
  const back = readBack(root, 'settings.json');
  assert.ok(!back.includes(M.REDACTED));
  assert.deepEqual(JSON.parse(back).mcpServers.demo, { command: 'npx', env: { API_KEY: secret } });
});

test('tool 写入:目标文件取第一个带 mcpServers 的设置;非 mcp_server 显式 unsupported', () => {
  const root = makeRoot({
    'settings.json': JSON.stringify({ theme: 'dark' }),
    'settings.local.json': JSON.stringify({ mcpServers: { local: { command: 'x' } } }),
  });
  const env = envFor(root);
  const asset = A.listTools(env).assets.find((a) => a.name === 'local');
  const dry = A.writeAsset('tool', asset, undefined, env);
  assert.equal(dry.plan[0].path, 'settings.local.json');

  const bad = A.writeAsset('tool', { name: 'run', kind: 'local_command', spec: { cmd: 'ls' } }, undefined, env);
  assert.equal(bad.ok, false);
  assert.equal(bad.unsupported, true);
  assert.match(bad.error, /只能承载 mcp_server/);
  assert.match(bad.error, /未写入任何文件/);
});

// ── skill ───────────────────────────────────────────────────────────────

test('listSkills:skills/<name>/SKILL.md 目录型,附属文本内联进 contents', () => {
  const root = makeRoot({
    'skills/dw/SKILL.md': '---\nname: dw\ndescription: deep work\n---\n# DW\n',
    'skills/dw/assets/ref.txt': 'ref content',
  });
  const ls = A.listSkills(envFor(root));
  assert.equal(ls.ok, true);
  const dw = ls.assets.find((a) => a.name === 'dw');
  assert.equal(dw.entry, 'SKILL.md');
  assert.deepEqual(dw.files, ['assets/ref.txt']);
  assert.equal(dw.contents['assets/ref.txt'], 'ref content');
  assert.equal(dw.source.format, 'dir:SKILL.md');
});

test('skill 写入:缺主文件内容报错;跨工具导入 sanitize 不修剪首尾横线(实测)', () => {
  const root = makeRoot({ '.keep': '' });
  const env = envFor(root);
  const missing = A.writeAsset('skill', { name: 's', entry: 'SKILL.md', contents: {} }, undefined, env);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /缺少主文件内容/);

  const foreign = {
    kind: 'skill', name: 'weird name!', entry: 'SKILL.md',
    contents: { 'SKILL.md': 'body\n' },
    source: { tool: 'harness', path: 'skills/weird name!', format: 'dir:SKILL.md' },
  };
  const dry = A.writeAsset('skill', foreign, undefined, env);
  assert.equal(dry.plan[0].path, 'skills/weird-name-/SKILL.md');
});

// ── removeAsset / readAsset 错误面 ──────────────────────────────────────

test('readAsset/removeAsset:未知类型 unsupported,找不到报错,删除默认干跑', () => {
  const root = makeRoot({
    'settings.json': JSON.stringify({ mcpServers: { demo: { command: 'npx' } } }),
    'projects/p/memory/drop.md': '---\nname: drop\n---\nbye\n',
  });
  const env = envFor(root, { KHY_AGENT_ASSETS_CLAUDE_PROJECT: 'p' });

  const unsupported = A.readAsset('model', 'x', env);
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.unsupported, true);
  const miss = A.readAsset('memory', 'ghost', env);
  assert.equal(miss.ok, false);
  assert.match(miss.error, /未找到 memory:ghost/);

  const toolDry = A.removeAsset('tool', 'demo', undefined, env);
  assert.equal(toolDry.dryRun, true);
  assert.deepEqual(toolDry.plan.map((p) => p.path), ['settings.json']);
  assert.deepEqual(toolDry.removed, []);
  assert.ok(readBack(root, 'settings.json').includes('demo'));

  const wet = A.removeAsset('memory', 'drop', { dryRun: false }, env);
  assert.equal(wet.ok, true);
  assert.deepEqual(wet.removed, ['projects/p/memory/drop.md']);
  assert.equal(fs.existsSync(path.join(root, 'projects/p/memory/drop.md')), false);
});
