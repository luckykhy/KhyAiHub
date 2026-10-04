'use strict';

/**
 * khyOs.test.js — 钉死 khy-os 本地资产库适配器的真实行为:detect 恒 ok(自己的数据家,
 * 不存在也算可用)、list* 在未建立的库上回空列表而非错误、写入按需建目录、
 * tools.json 映射形态的 kind 缺省与「提升字段物化」、凭据回写沿用目标现值。
 *
 * 为什么这支套件必须存在:khy-os 是 import/export/sync 三个动作的公共对端,它走
 * **同一套适配器契约**是编排层厂商无关的前提。它与外部适配器行为差异最大的两处
 * (detect 不判存在、list* 不报错)如果哪天被「对齐」成外部行为,所有「库还没建
 * 就先列一下」的上层调用会当场从空列表变错误;tools.json 的 kind/description 物化
 * 更是 contentHash 判等刻意要剥掉的「双份」来源,写歪一次就永远判冲突。
 *
 * 实测更正(与直觉不同处,按真实行为钉死):
 *   · detect 恒 {ok:true},用 established 字段区分「库是否已建立」——与外部适配器的
 *     {ok:false} 收敛路径完全不同。
 *   · 工具条目 kind 取 spec.kind,不在 TOOL_KINDS 里的**静默回落 mcp_server**(不报错)。
 *   · writeAsset('tool') 把 toolKind/description 物化回 spec(映射形态仓库要自描述),
 *     与 listTools 的读取方向形成「提升-下沉」闭环。
 *   · 未设 KHY_AGENT_ASSETS_LOCAL_ROOT 时 _rootPath 会 require utils/dataHome 并可能
 *     触到真实用户数据目录——本套件因此**只测覆盖变量路径**,回退分支不在断言面内。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const A = require('./khyOs');
const M = require('../assetModel');

const TMP_DIRS = [];

function makeRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-kx-'));
  TMP_DIRS.push(dir);
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function envFor(root, extra) {
  return Object.assign({ KHY_AGENT_ASSETS_LOCAL_ROOT: root }, extra || {});
}

function readBack(root, rel) {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}

after(() => {
  for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true });
});

// ── detect / capabilities / 空库 ─────────────────────────────────────────

test('detect 恒 ok:库未建立也「可用」,established 如实区分;list* 回空列表不是错误', () => {
  const fresh = path.join(makeRoot({ '.keep': '' }), 'not-built-yet');
  const env = envFor(fresh);
  const d = A.detect(env);
  assert.equal(d.ok, true);
  assert.equal(d.root, fresh);
  assert.equal(d.established, false);
  assert.equal(d.via, 'env:KHY_AGENT_ASSETS_LOCAL_ROOT');

  // 与外部适配器的关键差异:根不存在时 list* 不返回 ok:false
  assert.deepEqual(A.listMemories(env), { ok: true, assets: [], root: fresh });
  assert.deepEqual(A.listTools(env), { ok: true, assets: [], root: fresh });
  assert.deepEqual(A.listSkills(env), { ok: true, assets: [], root: fresh });

  const caps = A.capabilities(env);
  assert.equal(caps.detected, true);
  assert.equal(caps.root, fresh);
});

test('写入按需建目录:dryRun 默认不建,显式 dryRun:false 才落盘', () => {
  const fresh = path.join(makeRoot({ '.keep': '' }), 'agent-assets');
  const env = envFor(fresh);
  const imported = {
    kind: 'memory', id: 'm1', scope: 'project', title: 'M1', content: 'body\n',
    tags: [], source: { tool: 'harness', path: 'memory/m1.md', format: '' },
  };
  const dry = A.writeAsset('memory', imported, undefined, env);
  assert.equal(dry.dryRun, true);
  assert.equal(fs.existsSync(fresh), false);

  const wet = A.writeAsset('memory', imported, { dryRun: false }, env);
  assert.equal(wet.ok, true);
  assert.deepEqual(wet.written, ['memory/m1.md']);
  assert.equal(readBack(fresh, 'memory/m1.md'), '---\nid: m1\ntitle: M1\nscope: project\n---\nbody\n');
  assert.equal(A.detect(env).established, true);
});

// ── memory 往返 ─────────────────────────────────────────────────────────

test('记忆往返:frontmatter 原文优先回吐;同工具无 frontmatter 逐字节回吐', () => {
  const withFm = '---\nid: pref\ntitle: 偏好\nscope: global\ntags:\n  - style\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n正文\n';
  const plain = '# 手写指令\n\n无 frontmatter。\n';
  const root = makeRoot({ 'AGENTS.md': plain, 'memory/pref.md': withFm });
  const env = envFor(root);
  const lm = A.listMemories(env);
  assert.deepEqual(lm.assets.map((a) => a.id).sort(), ['AGENTS', 'pref']);

  const g = lm.assets.find((a) => a.id === 'AGENTS');
  assert.equal(g.scope, 'global');
  assert.equal(A.writeAsset('memory', g, { dryRun: false }, env).ok, true);
  assert.equal(readBack(root, 'AGENTS.md'), plain);

  const p = lm.assets.find((a) => a.id === 'pref');
  // updatedAt 取 frontmatter 现值而非 mtime(外部适配器只有 mtime 一个来源)
  assert.equal(p.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(A.writeAsset('memory', p, { dryRun: false }, env).ok, true);
  assert.equal(readBack(root, 'memory/pref.md'), withFm);
});

// ── tool:tools.json 映射形态 ────────────────────────────────────────────

test('listTools:kind 缺省/非法回落 mcp_server;凭据出口抹掉;解析失败报错', () => {
  const root = makeRoot({
    'tools.json': JSON.stringify({
      alpha: { kind: 'local_command', description: '跑命令', cmd: 'ls' },
      beta: { url: 'http://x', Authorization: 'Bearer topsecret1' },
      gamma: { kind: 'quantum', cmd: 'who' },
    }),
  });
  const env = envFor(root);
  const lt = A.listTools(env);
  assert.equal(lt.ok, true);
  const by = Object.fromEntries(lt.assets.map((a) => [a.name, a]));
  assert.equal(by.alpha.toolKind, 'local_command');
  assert.equal(by.alpha.description, '跑命令');
  assert.equal(by.beta.toolKind, 'mcp_server');
  assert.equal(by.gamma.toolKind, 'mcp_server');
  assert.equal(by.beta.spec.Authorization, M.REDACTED);
  assert.deepEqual(by.beta.source.redactedFields, ['Authorization']);

  const broken = makeRoot({ 'tools.json': '{oops' });
  const bad = A.listTools(envFor(broken));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /tools\.json 解析失败/);
});

test('writeAsset(tool):kind/description 物化回 spec,凭据用目标现值填回', () => {
  const secret = 'Bearer topsecret1';
  const root = makeRoot({
    'tools.json': JSON.stringify({
      alpha: { kind: 'local_command', description: '跑命令', cmd: 'ls' },
      beta: { url: 'http://x', Authorization: secret },
    }),
  });
  const env = envFor(root);
  const beta = A.listTools(env).assets.find((a) => a.name === 'beta');
  const wet = A.writeAsset('tool', beta, { dryRun: false }, env);
  assert.equal(wet.ok, true);
  assert.deepEqual(wet.written, ['tools.json']);

  const back = readBack(root, 'tools.json');
  assert.ok(!back.includes(M.REDACTED));
  const doc = JSON.parse(back);
  // 物化的提升字段 + 真凭据原样保留,其余字段无损
  assert.deepEqual(doc.beta, { url: 'http://x', Authorization: secret, kind: 'mcp_server', description: '' });
  assert.deepEqual(doc.alpha, { kind: 'local_command', description: '跑命令', cmd: 'ls' });
});

test('removeAsset(tool):从 tools.json 摘键,其余条目不动', () => {
  const root = makeRoot({ 'tools.json': JSON.stringify({ alpha: { cmd: 'ls' }, beta: { url: 'u' } }) });
  const env = envFor(root);
  const dry = A.removeAsset('tool', 'alpha', undefined, env);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.plan.map((p) => p.path), ['tools.json']);
  assert.ok(readBack(root, 'tools.json').includes('alpha'));

  const wet = A.removeAsset('tool', 'alpha', { dryRun: false }, env);
  assert.equal(wet.ok, true);
  const doc = JSON.parse(readBack(root, 'tools.json'));
  assert.deepEqual(Object.keys(doc), ['beta']);
});

// ── skill ───────────────────────────────────────────────────────────────

test('技能两形态读取与往返:dir:SKILL.md 与 file:md 各按来处落回', () => {
  const dirText = '---\nname: dsk\ndescription: dir\n---\n# D\n';
  const fileText = '---\nname: fsk\n---\nloose\n';
  const root = makeRoot({
    'skills/dsk/SKILL.md': dirText,
    'skills/dsk/res/x.txt': 'x',
    'skills/fsk.md': fileText,
  });
  const env = envFor(root);
  const ls = A.listSkills(env);
  const by = Object.fromEntries(ls.assets.map((a) => [a.name, a]));
  assert.equal(by.dsk.source.format, 'dir:SKILL.md');
  assert.deepEqual(by.dsk.files, ['res/x.txt']);
  assert.equal(by.fsk.entry, 'fsk.md');

  const wd = A.writeAsset('skill', by.dsk, { dryRun: false }, env);
  assert.equal(wd.ok, true);
  assert.equal(readBack(root, 'skills/dsk/SKILL.md'), dirText);

  const wf = A.writeAsset('skill', by.fsk, { dryRun: false }, env);
  assert.deepEqual(wf.written, ['skills/fsk.md']);
  assert.equal(readBack(root, 'skills/fsk.md'), fileText);

  // 跨工具导入无附属资源 → 单文件;名含非法字符被 _slug 换横线
  const foreign = { kind: 'skill', name: 'We/ird Name', entry: 'SKILL.md', contents: { 'SKILL.md': 'f\n' }, source: { tool: 'claude-code', path: 'skills/We-ird Name/SKILL.md', format: 'dir:SKILL.md' } };
  assert.deepEqual(A.writeAsset('skill', foreign, undefined, env).plan.map((p) => p.path), ['skills/We-ird-Name.md']);
});

// ── readAsset / 错误面 ──────────────────────────────────────────────────

test('readAsset 三种命中方式(身份/id/name)与未找到、未知类型报错', () => {
  const root = makeRoot({ 'memory/m1.md': '---\nid: m1\nscope: project\n---\nb\n' });
  const env = envFor(root);
  assert.equal(A.readAsset('memory', 'project:m1', env).ok, true);
  assert.equal(A.readAsset('memory', 'm1', env).ok, true);
  const miss = A.readAsset('memory', 'nope', env);
  assert.equal(miss.ok, false);
  assert.match(miss.error, /未找到 memory:nope/);
  const bad = A.readAsset('zzz', 'x', env);
  assert.equal(bad.unsupported, true);

  const rmMiss = A.removeAsset('memory', 'nope', undefined, env);
  assert.equal(rmMiss.ok, false);
});
