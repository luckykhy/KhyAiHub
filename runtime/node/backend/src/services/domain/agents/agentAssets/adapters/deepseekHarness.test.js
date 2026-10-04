'use strict';

/**
 * deepseekHarness.test.js — 钉死 dsh 适配器的真实行为:只有 KHY 覆盖变量进 envKeys
 * (DSH_HOME 走候选通道,坏了继续找)、memory 整类显式 unsupported(不是空列表)、
 * tool 可读不可写且 raw 也过脱敏、`!!js` 表达式以字符串前缀原样保留、技能只认单层、
 * 跨工具导入技能名按上游规矩 kebab-case。
 *
 * 为什么这支套件必须存在:本适配器是全组里唯一「三类能力各不相同」的一家
 * (memory 不支持 / tool 只读 / skill 可写),能力位的任何一次漂移都会让编排层把
 * 「这家不存这类资产」读成「装了但一条都没有」;NEVER_READ(.credentials.yaml/.env)
 * 的承诺——凭据文件绝不进任何返回值——只有在这里有断言才成立。
 *
 * 实测更正(与直觉不同处,按真实行为钉死):
 *   · listMemories 恒 ok:false + unsupported:true,即使根探测成功(checked 变形态:
 *     根命中时只报「该根下不存在记忆布局」)。
 *   · `_skillFromDir` 名称取 frontmatter.name,缺省回退目录名;嵌套目录不被发现
 *     (上游刻意排除,walkFiles maxDepth=1 落实)。
 *   · kebab 化:驼峰拆横线 + 全小写 + 非法字符换横线 + 修剪首尾横线,空结果回 'skill'。
 *   · cordis 补丁文件按 PATCH_FILES 顺序取第一个存在的(cordis.patch.yml 优先于 cordis.yml)。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const A = require('./deepseekHarness');
const M = require('../assetModel');

const TMP_DIRS = [];

function makeRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-dsh-'));
  TMP_DIRS.push(dir);
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function readBack(root, rel) {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}

after(() => {
  for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true });
});

// ── detect / capabilities ────────────────────────────────────────────────

test('detect:KHY 覆盖硬失败;DSH_HOME 是候选(坏了指向不存在目录也继续往下找)→ ~/.dsh', () => {
  const good = makeRoot({ '.keep': '' });
  const bad = A.detect({ KHY_AGENT_ASSETS_DSH_ROOT: path.join(good, 'nope'), DSH_HOME: good });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /KHY_AGENT_ASSETS_DSH_ROOT 指向的目录不存在/);

  const viaHome = A.detect({ DSH_HOME: good, HOME: makeRoot({ '.keep': '' }) });
  assert.equal(viaHome.ok, true);
  assert.equal(viaHome.root, good);
  assert.equal(viaHome.via, 'default');

  const home = makeRoot({ '.dsh/.keep': '' });
  const d = A.detect({ HOME: home });
  assert.equal(d.root, path.join(home, '.dsh'));

  const caps = A.capabilities({ HOME: home });
  assert.equal(caps.kinds.memory.read, false);
  assert.equal(caps.kinds.tool.write, false);
  assert.equal(caps.kinds.skill.write, true);
  assert.deepEqual(caps.neverRead, A.NEVER_READ);
  assert.deepEqual(caps.rootEnvKeys, ['KHY_AGENT_ASSETS_DSH_ROOT']);
});

// ── memory:显式不支持 ───────────────────────────────────────────────────

test('listMemories:根存在也回 unsupported(不是空列表),checked 换成「无记忆布局」形态', () => {
  const root = makeRoot({ '.keep': '' });
  const lm = A.listMemories({ KHY_AGENT_ASSETS_DSH_ROOT: root });
  assert.equal(lm.ok, false);
  assert.equal(lm.unsupported, true);
  assert.match(lm.error, /委托给 MCP 服务器/);
  assert.deepEqual(lm.checked, [{ location: root, exists: true, why: '资产根已找到,但该根下不存在记忆布局' }]);

  // readAsset('memory',…) 把 unsupported 原样透传
  const ra = A.readAsset('memory', 'anything', { KHY_AGENT_ASSETS_DSH_ROOT: root });
  assert.equal(ra.unsupported, true);
});

// ── tool:cordis YAML ────────────────────────────────────────────────────

const CORDIS_YAML = [
  'patches:',
  "  - name: '@deepseek-ai/dsh-mcp-client'",
  '    id: mcp-a',
  '    disabled: !!js process.env.DSH_DISABLE',
  '    config:',
  '      serverName: fs-prod',
  '      command: !!js process.env.DSH_MCP_CMD',
  '      API_TOKEN: supersecret123',
  "  - name: '@deepseek-ai/other-plugin'",
  '    config:',
  '      serverName: not-mcp',
  '',
].join('\n');

test('listTools:递归找 MCP 插件行;!!js 表达式保留为前缀字符串;config 与 raw 都过脱敏', () => {
  const root = makeRoot({
    'cordis.patch.yml': CORDIS_YAML,
    '.credentials.yaml': 'LEAKED_SECRET_NEVER_READ\n',
  });
  const env = { KHY_AGENT_ASSETS_DSH_ROOT: root };
  const lt = A.listTools(env);
  assert.equal(lt.ok, true);
  assert.deepEqual(lt.assets.map((a) => a.name), ['fs-prod']);
  const fsProd = lt.assets[0];
  assert.equal(fsProd.toolKind, 'mcp_server');
  assert.equal(fsProd.spec.command, `${A.JS_EXPR_PREFIX}process.env.DSH_MCP_CMD`);
  assert.equal(fsProd.spec.API_TOKEN, M.REDACTED);
  assert.deepEqual(fsProd.source.redactedFields, ['API_TOKEN']);
  assert.equal(fsProd.source.path, 'cordis.patch.yml');
  assert.equal(fsProd.source.format, 'yaml:cordis-plugin');
  assert.equal(fsProd.raw.pluginId, 'mcp-a');
  assert.equal(fsProd.raw.disabled, `${A.JS_EXPR_PREFIX}process.env.DSH_DISABLE`);

  // NEVER_READ 承诺:凭据文件名与内容都不出现在返回值里
  const dump = JSON.stringify(lt);
  assert.ok(!dump.includes('LEAKED_SECRET_NEVER_READ'));
  assert.ok(!dump.includes('.credentials.yaml'));
});

test('listTools:补丁按 PATCH_FILES 顺序取第一个存在;都没有→空;坏 YAML→报错', () => {
  const both = makeRoot({
    'cordis.patch.yml': "patches:\n  - name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: from-patch\n",
    'cordis.yml': "patches:\n  - name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: from-main\n",
  });
  const env = { KHY_AGENT_ASSETS_DSH_ROOT: both };
  const lt = A.listTools(env);
  assert.deepEqual(lt.assets.map((a) => a.name), ['from-patch']);

  const none = A.listTools({ KHY_AGENT_ASSETS_DSH_ROOT: makeRoot({ '.keep': '' }) });
  assert.equal(none.ok, true);
  assert.deepEqual(none.assets, []);

  const broken = makeRoot({ 'cordis.patch.yml': 'a: [unclosed\n' });
  const bad = A.listTools({ KHY_AGENT_ASSETS_DSH_ROOT: broken });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /cordis\.patch\.yml 解析失败/);
});

// ── skill:只认单层 ──────────────────────────────────────────────────────

test('listSkills:目录型与单文件型都收,嵌套目录刻意不收(上游排除嵌套发现)', () => {
  const root = makeRoot({
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n# D\n',
    'skills/loose.md': '---\nname: loose\n---\nl\n',
    // 嵌套在第二层目录里的 SKILL.md:单层扫描既不发现它,demo/ 的 files 也不含它
    'skills/deepwrap/x/y/SKILL.md': '不该被发现\n',
  });
  const env = { KHY_AGENT_ASSETS_DSH_ROOT: root };
  const ls = A.listSkills(env);
  const names = ls.assets.map((a) => a.name).sort();
  assert.deepEqual(names, ['demo', 'loose']);
  const demo = ls.assets.find((a) => a.name === 'demo');
  assert.equal(demo.source.format, 'dir:SKILL.md');
  assert.deepEqual(demo.files, []);
});

test('技能写入:memory/tool 显式 unsupported;跨工具 kebab 化;同工具 file:md 原地回写', () => {
  const root = makeRoot({ 'skills/loose.md': '---\nname: loose\n---\nbody l\n' });
  const env = { KHY_AGENT_ASSETS_DSH_ROOT: root };

  const mem = A.writeAsset('memory', { id: 'm', scope: 'project', content: 'x' }, undefined, env);
  assert.equal(mem.unsupported, true);
  assert.match(mem.error, /委托给 MCP/);

  const tool = A.writeAsset('tool', { name: 't', kind: 'mcp_server', spec: {} }, undefined, env);
  assert.equal(tool.unsupported, true);
  assert.match(tool.error, /cordis\.patch\.yml/);

  const foreign = {
    kind: 'skill', name: 'MyCoolSkill', entry: 'SKILL.md', contents: { 'SKILL.md': 'c\n' },
    source: { tool: 'claude-code', path: 'skills/MyCoolSkill/SKILL.md', format: 'dir:SKILL.md' },
  };
  const dry = A.writeAsset('skill', foreign, undefined, env);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.plan.map((p) => p.path), ['skills/my-cool-skill.md']);

  const withExtras = {
    kind: 'skill', name: 'Pack Two', entry: 'SKILL.md', contents: { 'SKILL.md': 'p\n', 'res/x.txt': 'x' },
    source: { tool: 'claude-code', path: '', format: '' },
  };
  assert.deepEqual(A.writeAsset('skill', withExtras, undefined, env).plan.map((p) => p.path),
    ['skills/pack-two/SKILL.md', 'skills/pack-two/res/x.txt']);

  const same = A.readAsset('skill', 'loose', env).asset;
  assert.equal(same.source.format, 'file:md');
  const wet = A.writeAsset('skill', same, { dryRun: false }, env);
  assert.deepEqual(wet.written, ['skills/loose.md']);
  assert.equal(readBack(root, 'skills/loose.md'), '---\nname: loose\n---\nbody l\n');
});

test('removeAsset:只允许删技能;干跑默认不动盘;实删单文件与目录两形态', () => {
  const root = makeRoot({
    'skills/loose.md': '---\nname: loose\n---\nl\n',
    'skills/dir/SKILL.md': '---\nname: dsk\n---\nd\n',
  });
  const env = { KHY_AGENT_ASSETS_DSH_ROOT: root };

  const rejected = A.removeAsset('tool', 'x', undefined, env);
  assert.equal(rejected.unsupported, true);
  assert.match(rejected.error, /只允许删除技能/);

  const dry = A.removeAsset('skill', 'loose', undefined, env);
  assert.equal(dry.dryRun, true);
  assert.ok(fs.existsSync(path.join(root, 'skills/loose.md')));

  const w1 = A.removeAsset('skill', 'loose', { dryRun: false }, env);
  assert.deepEqual(w1.removed, ['skills/loose.md']);
  assert.equal(fs.existsSync(path.join(root, 'skills/loose.md')), false);

  const w2 = A.removeAsset('skill', 'dsk', { dryRun: false }, env);
  assert.deepEqual(w2.removed, ['skills/dir']);
  assert.equal(fs.existsSync(path.join(root, 'skills/dir')), false);
});
