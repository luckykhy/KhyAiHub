'use strict';

// Colocated tests for agentFsService.js (AgentFS: file-driven per-agent store).
// child_process, utils/dataHome and personaService are stubbed via require.cache
// BEFORE the target require; all writes land in os.tmpdir().

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-agentfs-'));

const cpKey = require.resolve('child_process');
const cpReal = require.cache[cpKey];
const dataHomeKey = require.resolve('../../../../utils/dataHome');
const dataHomeReal = require.cache[dataHomeKey];
const personaKey = require.resolve('../../../personaService');
const personaReal = require.cache[personaKey];

// git behavior: default gitless (ENOENT), per-test overrides below.
let gitMode = 'gitless'; // 'gitless' | 'ok' | 'fail'
let gitLog = [];
const gitErr = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });

const fakeCp = {
  execFileSync(cmd, args, opts) {
    gitLog.push({ cmd, args });
    if (gitMode === 'gitless') throw gitErr;
    if (gitMode === 'fail') throw new Error('git exploded');
    const a = args.filter((x) => !String(x).startsWith('-c')).join(' ');
    if (a.startsWith('rev-parse')) return 'true\n';
    if (a.startsWith('log')) return 'abc1234\tfirst commit\ndef5678 second';
    return '';
  },
};

require.cache[cpKey] = { id: cpKey, filename: cpKey, loaded: true, exports: fakeCp };
require.cache[dataHomeKey] = {
  id: dataHomeKey,
  filename: dataHomeKey,
  loaded: true,
  exports: { getDataHome: () => TMP, getAppDataDir: (sub) => path.join(TMP, sub) },
};
require.cache[personaKey] = {
  id: personaKey,
  filename: personaKey,
  loaded: true,
  exports: { defaultTemplate: () => '# Persona\nseed line\n\n## Answer Strategy\n- b\n' },
};

const svc = require('./agentFsService');

test.after(() => {
  if (cpReal) require.cache[cpKey] = cpReal;
  else delete require.cache[cpKey];
  if (dataHomeReal) require.cache[dataHomeKey] = dataHomeReal;
  else delete require.cache[dataHomeKey];
  if (personaReal) require.cache[personaKey] = personaReal;
  else delete require.cache[personaKey];
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('getAgentsRoot 指向桩定的 dataHome/agents', () => {
  assert.equal(svc.getAgentsRoot(), path.join(TMP, 'agents'));
});

test('_agentDir：非法 id 抛错、垃圾类型拒绝、64 位边界', () => {
  for (const bad of ['', 'ABC', '-a', '_a', '.a', 'a b', '中文名', null, undefined, 0, 42, {}, [], true, 'a'.repeat(65)]) {
    assert.throws(() => svc._agentDir(bad), /非法的 agent id/, String(bad));
  }
  assert.equal(svc._agentDir('a'.repeat(64)), path.join(svc.getAgentsRoot(), 'a'.repeat(64)));
  assert.equal(svc._agentDir('ok-id_1'), path.join(svc.getAgentsRoot(), 'ok-id_1'));
});

test('slugify：ASCII 归一、非 ASCII 塌缩为空、垃圾入参返空', () => {
  assert.equal(svc.slugify('Hello World!'), 'hello-world');
  assert.equal(svc.slugify('  --A__B--  '), 'a-b'); // _ 也归一为 -
  assert.equal(svc.slugify('中文名'), '');
  assert.equal(svc.slugify(''), '');
  assert.equal(svc.slugify(null), '');
  assert.equal(svc.slugify(undefined), '');
  assert.equal(svc.slugify(0), '');
  assert.equal(svc.slugify({}), 'object-object');
  assert.equal(svc.slugify('a'.repeat(100)), 'a'.repeat(64));
});

test('createAgent：脚手架六资产五目录齐全、manifest 落账、gitless 时 versioned=false', () => {
  gitMode = 'gitless';
  const r = svc.createAgent({ name: 'Test Agent', description: 'd', model: 'm1', createdAt: '2026-01-01T00:00:00Z' });
  assert.equal(r.id, 'test-agent');
  assert.equal(r.dir, path.join(TMP, 'agents', 'test-agent'));
  assert.equal(r.versioned, false);
  assert.deepEqual(r.manifest, {
    id: 'test-agent',
    name: 'Test Agent',
    description: 'd',
    model: 'm1',
    schema: 'agentfs',
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
  });
  for (const rel of Object.values(svc.ASSET_FILES)) {
    assert.equal(fs.existsSync(path.join(r.dir, rel)), true, rel);
  }
  for (const sub of ['memory', 'skills', 'workflows', 'tools', 'heartbeat']) {
    assert.ok(fs.statSync(path.join(r.dir, sub)).isDirectory(), sub);
  }
  // persona 种子来自桩定的 personaService
  assert.ok(fs.readFileSync(path.join(r.dir, 'persona.md'), 'utf-8').includes('seed line'));
  // 重复创建 → 抛错
  assert.throws(() => svc.createAgent({ name: 'Test Agent', id: 'test-agent' }), /agent 已存在/);
});

test('createAgent 垃圾入参：null 抛 TypeError、缺 name / 非 ASCII 且无显式 id → 友好抛错', () => {
  assert.throws(() => svc.createAgent(null), TypeError); // 默认参数只对 undefined 生效
  for (const opts of [undefined, {}, { name: '' }, { name: '   ' }, { name: 0 }]) {
    assert.throws(() => svc.createAgent(opts), /name 必填/, String(opts));
  }
  assert.throws(() => svc.createAgent({ name: '纯中文' }), /--id/);
  const r = svc.createAgent({ name: '纯中文', id: 'zh-agent' });
  assert.equal(r.id, 'zh-agent');
});

test('listAgents：仅含合法 id + manifest 的目录，按 id 排序；垃圾目录/坏 JSON 跳过', () => {
  fs.mkdirSync(path.join(TMP, 'agents', 'b-agent'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'agents', 'b-agent', 'agent.json'), '{"id":"b-agent","name":"B"}');
  fs.mkdirSync(path.join(TMP, 'agents', 'a-agent'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'agents', 'a-agent', 'agent.json'), '{"id":"a-agent","name":"A"}');
  fs.mkdirSync(path.join(TMP, 'agents', 'Bad-ID'), { recursive: true }); // 非法 id 忽略
  fs.mkdirSync(path.join(TMP, 'agents', 'c-no-manifest'), { recursive: true }); // 无 manifest 忽略
  fs.mkdirSync(path.join(TMP, 'agents', 'd-corrupt'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'agents', 'd-corrupt', 'agent.json'), '{oops'); // 坏 JSON 忽略
  fs.writeFileSync(path.join(TMP, 'agents', 'stray-file.txt'), 'x'); // 文件忽略
  const list = svc.listAgents();
  assert.deepEqual(list.map((m) => m.id), ['a-agent', 'b-agent', 'test-agent', 'zh-agent']);
});

test('getAgent：存在/缺失/非法 id', () => {
  const g = svc.getAgent('test-agent');
  assert.equal(g.id, 'test-agent');
  assert.equal(g.manifest.name, 'Test Agent');
  assert.equal(svc.getAgent('nope-agent'), null);
  assert.throws(() => svc.getAgent('BAD'));
});

test('writeAsset / readAsset：写读回、非字符串内容 String()、缺失与穿越', () => {
  assert.equal(svc.readAsset('test-agent', 'persona.md').includes('seed line'), true);
  const r = svc.writeAsset('test-agent', 'memory/note.md', 42);
  assert.equal(r.versioned, false); // gitless
  assert.equal(svc.readAsset('test-agent', 'memory/note.md'), '42');
  assert.equal(svc.readAsset('test-agent', 'memory/missing.md'), null);
  assert.throws(() => svc.writeAsset('nope-agent', 'x.md', 'y'), /agent 不存在/);
  assert.throws(() => svc.writeAsset('test-agent', '../escape.md', 'y'), /穿越被拒绝/);
  assert.throws(() => svc.readAsset('test-agent', '../escape.md'), /穿越被拒绝/);
  assert.throws(() => svc.writeAsset('test-agent', '', 'y'), /asset 相对路径必填/);
  assert.throws(() => svc.readAsset(null, 'x.md'), /非法的 agent id/);
});

// KNOWN-DEFECT: _assetPath 对 rel='.' 的守卫放行（resolved === dir 被视为合法，
// agentFsService.js:390），后续 readFileSync/writeFileSync 落到目录本身 → 裸 EISDIR/EPERM
// 系统错误而非友好校验信息（低危：readAsset 有 catch 返 null，writeAsset 会把裸错误抛给调用方）。
test("KNOWN-DEFECT: rel='.'（即 agent 目录自身）穿透 asset 路径守卫", () => {
  assert.equal(svc.readAsset('test-agent', '.'), null); // 读目录 → EISDIR 被 catch 成 null
  assert.throws(
    () => svc.writeAsset('test-agent', '.', 'x'),
    (err) => err && (err.code === 'EISDIR' || err.code === 'EPERM')
  ); // 写目录 → 裸系统错误
});

test('loadLayered：L0 身份块、L1 摘要、L2 全量，垃圾 level 回退 L0', () => {
  svc.writeAsset('test-agent', 'memory/mem-a.md', '# 记忆A\n内容A');
  svc.writeAsset('test-agent', 'memory/mem-b.md', '内容B');
  fs.mkdirSync(path.join(TMP, 'agents', 'test-agent', 'skills', 'sk1'), { recursive: true });
  fs.writeFileSync(
    path.join(TMP, 'agents', 'test-agent', 'skills', 'sk1', 'manifest.json'),
    JSON.stringify({ description: '技能一' })
  );
  fs.writeFileSync(path.join(TMP, 'agents', 'test-agent', 'skills', 'sk1', 'prompt.md'), 'PROMPT1');
  fs.writeFileSync(path.join(TMP, 'agents', 'test-agent', 'workflows', 'wf.md'), '步骤 1');

  const l0 = svc.loadLayered('test-agent', 'L0');
  assert.equal(l0.level, 'L0');
  assert.ok(l0.text.includes('# Agent: Test Agent (test-agent)'));
  assert.ok(l0.text.includes('seed line')); // persona 首个 heading 块
  assert.ok(!l0.text.includes('Answer Strategy')); // 只取第一块
  assert.ok(l0.text.includes('## Principles (red lines)'));
  assert.ok(!l0.text.includes('Memory index'));
  assert.ok(l0.bytes === Buffer.byteLength(l0.text, 'utf-8'));

  const l1 = svc.loadLayered('test-agent', 'L1');
  assert.ok(l1.text.includes('## Memory index'));
  assert.ok(l1.text.includes('- sk1 — 技能一'));
  assert.ok(l1.text.includes('## Heartbeat'));
  // 种子 heartbeat 的引用行（> 开头）被「非注释行」判据判为 active——种子模板自带一行活动态
  assert.ok(l1.text.includes('active'));
  assert.ok(!l1.text.includes('内容A'));

  const l2 = svc.loadLayered('test-agent', 'L2');
  assert.ok(l2.text.includes('## Persona (full)'));
  assert.ok(l2.text.includes('Answer Strategy')); // 全量 persona
  assert.ok(l2.text.includes('## Memory (full)'));
  assert.ok(l2.text.includes('### mem-a.md'));
  assert.ok(l2.text.includes('内容A'));
  assert.ok(!l2.text.includes('### MEMORY.md')); // 索引自身不进全量
  assert.ok(l2.text.includes('## Skill prompts (full)'));
  assert.ok(l2.text.includes('PROMPT1'));
  assert.ok(l2.text.includes('## Workflows'));
  assert.ok(l2.text.includes('步骤 1'));

  assert.equal(svc.loadLayered('test-agent', 'bogus').level, 'L0');
  assert.equal(svc.loadLayered('test-agent', null).level, 'L0');
  assert.throws(() => svc.loadLayered('nope-agent', 'L0'), /agent 不存在/);
});

test('loadLayered：heartbeat 仅注释/空行 → idle；persona 缺失仍可渲染', () => {
  fs.writeFileSync(path.join(TMP, 'agents', 'test-agent', 'heartbeat', 'HEARTBEAT.md'), '# 心跳\n\n# 只是注释\n\n');
  assert.ok(svc.loadLayered('test-agent', 'L1').text.includes('idle (no active checks)'));
  // 恢复种子，persona 移除后再渲染
  fs.writeFileSync(path.join(TMP, 'agents', 'test-agent', 'heartbeat', 'HEARTBEAT.md'), '# 心跳\n\n检查邮箱\n');
  assert.ok(svc.loadLayered('test-agent', 'L1').text.includes('active'));
  fs.rmSync(path.join(TMP, 'agents', 'test-agent', 'persona.md'));
  const l0 = svc.loadLayered('test-agent');
  assert.ok(!l0.text.includes('## Persona'));
  // 恢复
  fs.writeFileSync(path.join(TMP, 'agents', 'test-agent', 'persona.md'), '# Persona\nseed line\n');
});

test('describeAssets：五资产视图 + receipts 外部注入（含注入器抛错兜底）', () => {
  const assets = svc.describeAssets('test-agent');
  assert.deepEqual(
    assets.map((a) => a.key),
    ['persona', 'playbook', 'memory', 'toolBody', 'receipts']
  );
  const persona = assets.find((a) => a.key === 'persona');
  assert.equal(persona.present, true);
  assert.ok(persona.files.some((f) => f.rel === 'persona.md'));
  assert.ok(persona.bytes > 0);
  assert.ok(persona.summary.includes('个文件'));
  const receipts = assets.find((a) => a.key === 'receipts');
  assert.equal(receipts.external, 'receipts');
  assert.equal(receipts.present, false);
  assert.equal(receipts.count, 0);

  const withCount = svc.describeAssets('test-agent', { countReceipts: () => 3 });
  assert.equal(withCount.find((a) => a.key === 'receipts').count, 3);
  assert.equal(withCount.find((a) => a.key === 'receipts').present, true);
  assert.ok(withCount.find((a) => a.key === 'receipts').summary.includes('3 条回执'));

  const throwing = svc.describeAssets('test-agent', { countReceipts: () => { throw new Error('boom'); } });
  assert.equal(throwing.find((a) => a.key === 'receipts').count, 0);

  assert.throws(() => svc.describeAssets('nope-agent'), /agent 不存在/);
});

// KNOWN-DEFECT: _listDirFiles 注释声称「one level deep」，实现却对子目录整树递归
// （agentFsService.js:550-579 walk 无深度界），describeAssets 的 toolBody 资产会把
// skills 下任意深层文件全部计入——与注释语义不符（低危：只影响资产清单的文件数/字节数口径）。
test('KNOWN-DEFECT: skills 深层文件被整树收集（注释说只列一层）', () => {
  fs.mkdirSync(path.join(TMP, 'agents', 'test-agent', 'skills', 'sk1', 'sub', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'agents', 'test-agent', 'skills', 'sk1', 'sub', 'deeper', 'n.txt'), 'deep');
  const toolBody = svc.describeAssets('test-agent').find((a) => a.key === 'toolBody');
  assert.ok(toolBody.files.some((f) => f.rel.includes('sub') && f.rel.includes('deeper')));
});

test('history：gitless 返空、limit 钳制、tab 解析与无 tab 兜底', () => {
  gitMode = 'gitless';
  assert.deepEqual(svc.history('test-agent'), []);
  gitMode = 'ok';
  gitLog = [];
  const list = svc.history('test-agent');
  assert.deepEqual(list, [
    { hash: 'abc1234', subject: 'first commit' },
    { hash: 'def5678 second', subject: '' }, // 无 tab → 整行进 hash、subject 空
  ]);
  assert.equal(gitLog[0].args.some((a) => a === '-n50'), true); // 默认 limit 50
  svc.history('test-agent', { limit: 3 });
  assert.equal(gitLog[1].args.some((a) => a === '-n3'), true);
  // 有限数钳到 ≥1；非有限数（NaN/'x'）回退默认 50
  for (const [bad, expected] of [[0, 1], [-5, 1], [1.9, 1], [NaN, 50], ['x', 50]]) {
    svc.history('test-agent', { limit: bad });
    const last = gitLog[gitLog.length - 1];
    assert.equal(last.args.some((a) => a === '-n' + expected), true, String(bad));
  }
  gitMode = 'fail';
  assert.deepEqual(svc.history('test-agent'), []);
  gitMode = 'gitless';
  assert.throws(() => svc.history('nope-agent'), /agent 不存在/);
});

test('revertTo：非法 commit 抛错；gitless → 不回退；ok → 回退并提交', () => {
  for (const bad of [null, undefined, '', 'xyz', 'abc', 123, 'a'.repeat(41)]) {
    assert.throws(() => svc.revertTo('test-agent', bad), /非法 commit/, String(bad));
  }
  gitMode = 'gitless';
  assert.deepEqual(svc.revertTo('test-agent', 'abc12345'), { reverted: false, versioned: false });
  gitMode = 'ok';
  gitLog = [];
  const r = svc.revertTo('test-agent', 'abc12345');
  assert.deepEqual(r, { reverted: true, versioned: true });
  assert.ok(gitLog.some((c) => c.args.join(' ').includes('restore --source abc12345')));
  gitMode = 'fail';
  assert.throws(() => svc.revertTo('test-agent', 'abc12345'), /revert 失败/);
  gitMode = 'gitless';
  assert.throws(() => svc.revertTo('nope-agent', 'abc12345'), /agent 不存在/);
});

test('active 指针：set/get/clear 幂等、指针损坏或指向缺失 agent → null', () => {
  gitMode = 'gitless';
  assert.equal(svc.getActiveAgentId(), null);
  assert.deepEqual(svc.clearActiveAgent(), { cleared: true }); // 无文件也幂等
  assert.throws(() => svc.setActiveAgent('nope-agent'), /agent 不存在/);
  assert.deepEqual(svc.setActiveAgent('test-agent'), { id: 'test-agent' });
  assert.equal(svc.getActiveAgentId(), 'test-agent');

  const pointer = path.join(TMP, 'agents', '.active.json');
  fs.writeFileSync(pointer, '{"id":"nope-agent"}');
  assert.equal(svc.getActiveAgentId(), null); // 指向不存在的 agent
  fs.writeFileSync(pointer, 'not-json');
  assert.equal(svc.getActiveAgentId(), null);
  fs.writeFileSync(pointer, '{"id":"BAD-ID"}');
  assert.equal(svc.getActiveAgentId(), null);

  assert.deepEqual(svc.clearActiveAgent(), { cleared: true });
  assert.equal(svc.getActiveAgentId(), null);
  assert.deepEqual(svc.clearActiveAgent(), { cleared: true });
});

test('activeStamp / companionPromptSection：无激活 → none/null；有激活 → 印戳含 id 与 mtime', () => {
  assert.equal(svc.activeStamp(), 'none');
  assert.equal(svc.companionPromptSection(), null);
  svc.setActiveAgent('test-agent');
  const stamp = svc.activeStamp('L2');
  assert.ok(stamp.startsWith('test-agent|L2|'));
  assert.ok(stamp.split('|').length >= 6); // id + level + 4 个文件印
  const section = svc.companionPromptSection({ level: 'L0' });
  assert.ok(section.startsWith('# Active Companion'));
  assert.ok(section.includes('# Agent: Test Agent'));
  assert.equal(svc.companionPromptSection({ level: 'bogus' }).includes('# Agent:'), true);
  svc.clearActiveAgent();
  // 指针指向缺失 agent → null（loadLayered 抛错被吞）
  fs.writeFileSync(path.join(TMP, 'agents', '.active.json'), '{"id":"test-agent"}');
  fs.rmSync(path.join(TMP, 'agents', 'test-agent'), { recursive: true, force: true });
  assert.equal(svc.companionPromptSection(), null);
});
