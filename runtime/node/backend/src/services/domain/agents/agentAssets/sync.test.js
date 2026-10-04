'use strict';

/**
 * sync.test.js — 钉死外部 agent 资产搬运的编排层：探测聚合、单向计划、干跑优先、冲突
 * keep-both/skip、活动感知超时、三个入口的参数强制与双向合并回报。
 *
 * 为什么这支套件必须存在：sync.js 是**唯一会往用户磁盘写第二份资产**的一层，也是文件头
 * 自己列了四条「不可协商的行为」的一层（干跑优先 / 绝不静默覆盖 / 状态透明 / 活动感知超时）。
 * 这四条只要有一条悄悄退化，用户看到的就是「同步一次多出十个文件」或「慢但在动却被硬杀」。
 * 另外 assetAssets/sync.js:30-38 记录过一次真实事故：require 曾指向 CLI 命令注册表，
 * resolveAdapter 根本不存在，而这条链路从来没有测试覆盖过。本套件用 require.cache 桩掉
 * ./registry，把「编排层只经由注册表的 resolveAdapter / listSourceIds 两个出口」钉成断言，
 * 走错注册表当场就红。
 *
 * 实测更正（与注释/直觉不同处，按真实语义钉死）：
 *   · transfer 失败（计划不通过）时**直接回吐 plan 的形状** {ok:false,error}，没有 dryRun /
 *     applied / conflicts 字段——调用方不能无条件读 res.applied.length。
 *   · 超时中止时的 summary 只有 _summarize(planned.items)（total/create/...），刻意不带
 *     appliedCount / conflictCount / failureCount，与正常返回的 summary 形状不同。
 *   · 中止判定在**每项开头**用 Date.now() - lastActivity 比较，而上一项完成时（成功
 *     sync.js:470 / 失败 :460）**都会刷新 lastActivity** ⇒ 同步适配器下两次检查的间隙 ≈0，
 *     **正超时阈值实际不可能触发中止**：慢写入不被硬杀（好），真卡死的同步写入会阻塞整条
 *     循环、检查没有机会运行（结构缺陷，登记不修）。可达的中止路径只有 idleTimeoutMs ≤ 0。
 *   · 「卡在哪一步」报的是上一个完成项的步骤（lastStep 在写入前赋值、检查时未更新），
 *     不是卡住项的步骤。
 *   · 「源侧资产在计划后消失」这一类失败 continue 时不刷新 lastActivity（sync.js:414-417），
 *     与写入失败分支（sync.js:460）不一致——连续消失多项会累积成空闲时间。
 *   · 计划里 action==='noop'/'in-sync' 都不进 todo；todo 只含 create 与 conflict。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const M = require('./assetModel');

const REG_PATH = require.resolve('./registry');
const ORIGINAL_REGISTRY = require.cache[REG_PATH];

// ── 假注册表 / 假适配器 ──────────────────────────────────────────────────

const TOOLS = new Map();
const registryCalls = { resolve: [], listSourceIds: [] };

function bareMemory(id, content, extra) {
  return Object.assign({
    kind: 'memory',
    id,
    scope: 'project',
    title: id,
    content,
    tags: [],
    source: { tool: '', path: `memory/${id}.md`, format: '', redactedFields: [] },
    updatedAt: '',
    raw: { frontmatterText: '---\nraw\n---' },
  }, extra || {});
}

function bareTool(name, toolKind, extra) {
  return Object.assign({
    kind: 'tool',
    name,
    toolKind,
    description: '',
    spec: { command: 'x' },
    source: { tool: '', path: `tools/${name}.json`, format: '', redactedFields: [] },
    updatedAt: '',
    raw: {},
  }, extra || {});
}

function bareSkill(name, extra) {
  return Object.assign({
    kind: 'skill',
    name,
    description: '',
    entry: 'SKILL.md',
    files: ['SKILL.md'],
    contents: { 'SKILL.md': `# ${name}` },
    metadata: {},
    source: { tool: '', path: `skills/${name}/SKILL.md`, format: '', redactedFields: [] },
    updatedAt: '',
    raw: {},
  }, extra || {});
}

function makeTool(id, label, data, overrides) {
  const d = Object.assign({ memory: [], tool: [], skill: [] }, data || {});
  const state = { writes: [], detects: 0, listCalls: 0, removeCalls: [] };
  const adapter = {
    TOOL_ID: id,
    LABEL: label,
    detect: () => {
      state.detects += 1;
      return { ok: true, root: `/root/${id}`, via: 'test', established: true, checked: [] };
    },
    capabilities: () => ({ id, label, detected: true, root: `/root/${id}`, kinds: {}, rootEnvKeys: [] }),
    listMemories: () => { state.listCalls += 1; return { ok: true, assets: d.memory.slice() }; },
    listTools: () => { state.listCalls += 1; return { ok: true, assets: d.tool.slice() }; },
    listSkills: () => { state.listCalls += 1; return { ok: true, assets: d.skill.slice() }; },
    readAsset: () => null,
    writeAsset: (kind, asset, opts) => ({
      ok: true,
      plan: [{ rel: `${kind}/${asset.id || asset.name}` }],
      written: opts && opts.dryRun === false ? [{ rel: `${kind}/${asset.id || asset.name}` }] : [],
    }),
    removeAsset: (kind, id2) => { state.removeCalls.push({ kind, id: id2 }); return { ok: true }; },
  };
  // 覆盖可能替换掉 writeAsset，所以先合并再统一包一层记录器：断言永远看得到每一次写入调用。
  Object.assign(adapter, overrides || {});
  const inner = adapter.writeAsset;
  adapter.writeAsset = (kind, asset, opts, env) => {
    state.writes.push({ kind, asset, opts, env });
    return inner(kind, asset, opts, env);
  };
  TOOLS.set(id, { id, label, adapter, state, data: d });
  return TOOLS.get(id);
}

function resetTools() {
  TOOLS.clear();
  registryCalls.resolve = [];
  registryCalls.listSourceIds = [];
}

const fakeRegistry = {
  AGENT_ASSET_SOURCES: [],
  listSourceIds: () => {
    registryCalls.listSourceIds.push(1);
    return [...TOOLS.keys()];
  },
  getSource: (id) => {
    const hit = TOOLS.get(String(id || ''));
    return hit ? { id: hit.id, label: hit.label, module: hit.id } : null;
  },
  resolveAdapter: (id, env) => {
    registryCalls.resolve.push({ id, env });
    const key = String(id || '').trim().toLowerCase();
    const hit = TOOLS.get(key);
    if (!hit) {
      return { ok: false, error: `未注册的外部 agent 工具:${key || '(空)'}` };
    }
    return { ok: true, adapter: hit.adapter, source: { id: hit.id, label: hit.label, module: hit.id } };
  },
  describeSources: () => ({ ok: true, sources: [] }),
  _resetAdapterCache: () => {},
};

require.cache[REG_PATH] = {
  id: REG_PATH,
  filename: REG_PATH,
  loaded: true,
  exports: fakeRegistry,
  children: [],
  paths: [],
};

const S = require('./sync');

after(() => {
  if (ORIGINAL_REGISTRY) {
    require.cache[REG_PATH] = ORIGINAL_REGISTRY;
  } else {
    delete require.cache[REG_PATH];
  }
  resetTools();
});

const ENV = { KHY_AGENT_ASSETS: '1' };

// 只动本套件用到的那几个键，跑完原样还原（未设置过的恢复成未设置）。
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function busy(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* keep the event loop honest without timers */ }
}

// ── 导出面与注册表接线 ──────────────────────────────────────────────────

test('sync 恰导出 9 个符号（唯一常量 + 计划内核 + 三个入口）', () => {
  assert.deepStrictEqual(Object.keys(S).sort(), [
    'DEFAULT_IDLE_TIMEOUT_MS',
    'discover',
    'exportAssets',
    'formatProgress',
    'importAssets',
    'listTool',
    'plan',
    'syncAssets',
    'transfer',
  ]);
  assert.strictEqual(S.DEFAULT_IDLE_TIMEOUT_MS, 60000);
});

test('编排层只经 resolveAdapter / listSourceIds 两个出口够到注册表（防回归到 CLI 命令注册表）', () => {
  resetTools();
  makeTool('opencode', 'opencode', { memory: [bareMemory('a', 'x')] });
  S.discover({ env: ENV });
  assert.strictEqual(registryCalls.listSourceIds.length, 1, 'discover 必须问 listSourceIds');
  assert.strictEqual(registryCalls.resolve.length >= 1, true, '列一家就必须 resolveAdapter 一次');
  assert.strictEqual(registryCalls.resolve[0].id, 'opencode');
  assert.deepStrictEqual(registryCalls.resolve[0].env, ENV, 'env 必须一路透传给适配器');
});

// ── formatProgress ───────────────────────────────────────────────────────

test('formatProgress 逐字回「正在<动作> <工具> <类型> i/total:名字」，三类中文标签封闭', () => {
  assert.strictEqual(S.formatProgress('导入', 'opencode', 'memory', 3, 17, '项目约定'),
    '正在导入 opencode 记忆 3/17:项目约定');
  assert.strictEqual(S.formatProgress('导出', 'Claude Code', 'tool', 1, 1, 'fs'),
    '正在导出 Claude Code 工具 1/1:fs');
  assert.strictEqual(S.formatProgress('同步', 'harness', 'skill', 2, 5, 'pdf'),
    '正在同步 harness 技能 2/5:pdf');
  assert.strictEqual(S.formatProgress('同步', 'harness', 'skill', 2, 5, ''),
    '正在同步 harness 技能 2/5', '无名时不留孤立冒号');
  assert.strictEqual(S.formatProgress('同步', 'harness', 'unknown-kind', 1, 1, 'x'),
    '正在同步 harness unknown-kind 1/1:x', '未知类型回落原样，不编造标签');
  assert.strictEqual(S.formatProgress('', '', '', 0, 0, ''), '正在   0/0',
    '模板无条件带「正在」前缀，空动作词也留着那个空格');
});

// ── listTool ─────────────────────────────────────────────────────────────

test('listTool 解析失败时回一整套空结构并把注册表错误原样带出，detected=false', () => {
  resetTools();
  const res = S.listTool('cursor', { env: ENV });
  assert.deepStrictEqual(res, {
    ok: false,
    tool: 'cursor',
    label: '',
    detected: false,
    assets: [],
    byKind: {},
    error: '未注册的外部 agent 工具:cursor',
  });
  assert.strictEqual(S.listTool(undefined, { env: ENV }).tool, '', 'falsy id 经 String 归空串');
});

test('listTool 对 detect 的三种坏返回值都不让链路失败：无返回 / 抛 / 未报错', () => {
  resetTools();
  makeTool('t1', 'T1', {}, { detect: () => undefined });
  assert.deepStrictEqual(S.listTool('t1', { env: ENV }), {
    ok: true, tool: 't1', label: 'T1', detected: false, assets: [], byKind: {},
    error: 'detect() 无返回值', checked: [],
  });

  resetTools();
  makeTool('t2', 'T2', {}, { detect: () => { throw new Error('disk gone'); } });
  const thrown = S.listTool('t2', { env: ENV });
  assert.strictEqual(thrown.detected, false);
  assert.strictEqual(thrown.error, 'detect 异常:disk gone');

  resetTools();
  makeTool('t3', 'T3', {}, { detect: () => ({ ok: false }) });
  const silent = S.listTool('t3', { env: ENV });
  assert.strictEqual(silent.error, '未检测到该工具');
  assert.deepStrictEqual(silent.checked, []);

  resetTools();
  makeTool('t4', 'T4', {}, { detect: () => ({ ok: false, error: '没装', checked: [{ location: '$X', exists: false }] }) });
  const withChecked = S.listTool('t4', { env: ENV });
  assert.deepStrictEqual(withChecked.checked, [{ location: '$X', exists: false }], '查过的位置必须透传给用户');
});

test('listTool 三类汇总进 assets 并按类型分组，root 来自 detect，逐项回报 onProgress', () => {
  resetTools();
  makeTool('src', 'Src', {
    memory: [bareMemory('m1', 'a'), bareMemory('m2', 'b')],
    tool: [bareTool('t1', 'mcp_server')],
    skill: [],
  });
  const seen = [];
  const res = S.listTool('src', { env: ENV, onProgress: (p) => seen.push(p) });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.detected, true);
  assert.strictEqual(res.root, '/root/src');
  assert.strictEqual(res.error, '');
  assert.strictEqual(res.assets.length, 3);
  assert.deepStrictEqual(res.byKind.memory.map((a) => a.id), ['m1', 'm2']);
  assert.deepStrictEqual(res.byKind.tool.map((a) => a.name), ['t1']);
  assert.deepStrictEqual(res.byKind.skill, []);
  assert.deepStrictEqual(seen.map((p) => p.message), [
    '已读取 Src 记忆 2/2 项',
    '已读取 Src 工具 1/1 项',
    '已读取 Src 技能 0/0 项',
  ]);
  assert.deepStrictEqual(seen.map((p) => p.phase), ['list', 'list', 'list']);
  assert.strictEqual(seen[0].tool, 'src');
});

test('listTool 把某一类的读取异常收进 error 串而不抛出，该类分组回空数组', () => {
  resetTools();
  makeTool('bad', 'Bad', { memory: [bareMemory('m1', 'a')] }, {
    listTools: () => { throw new Error('tools.json 是半截 JSON'); },
    listSkills: () => ({ ok: false, error: '技能目录不可读' }),
  });
  const res = S.listTool('bad', { env: ENV });
  assert.strictEqual(res.ok, true, '一家里一类坏了不影响其余类');
  assert.strictEqual(res.error, '工具:listTools 异常:tools.json 是半截 JSON；技能:技能目录不可读');
  assert.deepStrictEqual(res.byKind.tool, []);
  assert.deepStrictEqual(res.byKind.skill, []);
  assert.strictEqual(res.assets.length, 1);
});

test('listTool 对 lister 回 undefined / assets 非数组 / 方法名缺失都回空组，不抛不崩', () => {
  resetTools();
  makeTool('weird', 'Weird', {}, {
    listMemories: () => undefined,
    listTools: () => ({ ok: true }),
    listSkills: () => ({ ok: true, assets: 'not-a-list' }),
  });
  const res = S.listTool('weird', { env: ENV });
  assert.deepStrictEqual(res.byKind, { memory: [], tool: [], skill: [] });
  assert.deepStrictEqual(res.assets, []);
  assert.strictEqual(res.error, '记忆:读取失败', 'res 缺失时给兜底文案');
  assert.strictEqual(res.detected, true);
});

test('listTool 的 kinds 只认三类、去重、保序；空数组与非数组都等于「三类全要」', () => {
  resetTools();
  makeTool('k', 'K', { memory: [bareMemory('m1', 'a')], tool: [bareTool('t1', 'builtin')] });
  assert.deepStrictEqual(Object.keys(S.listTool('k', { env: ENV, kinds: ['tool', 'tool', 'bogus', ''] }).byKind), ['tool']);
  assert.deepStrictEqual(Object.keys(S.listTool('k', { env: ENV, kinds: ['skill', 'memory'] }).byKind), ['skill', 'memory']);
  assert.deepStrictEqual(Object.keys(S.listTool('k', { env: ENV, kinds: [] }).byKind), ['memory', 'tool', 'skill']);
  assert.deepStrictEqual(Object.keys(S.listTool('k', { env: ENV, kinds: 'memory' }).byKind), ['memory', 'tool', 'skill']);
  assert.deepStrictEqual(Object.keys(S.listTool('k', { env: ENV, kinds: [null, 0, ' memory '] }).byKind), ['memory'],
    '未知 kinds 元素被丢掉，剩下的仍按调用方给的顺序，不重新排序');
});

// ── discover ─────────────────────────────────────────────────────────────

test('discover 关门时明确拒绝且带空 tools 数组，一次适配器都不碰', () => {
  resetTools();
  const t = makeTool('opencode', 'opencode');
  registryCalls.resolve = [];
  const res = S.discover({ env: { KHY_AGENT_ASSETS: 'off' } });
  assert.deepStrictEqual(res, {
    ok: false,
    error: '外部 agent 资产层已被门控关闭(KHY_AGENT_ASSETS=off)',
    tools: [],
  });
  assert.strictEqual(registryCalls.resolve.length, 0);
  assert.strictEqual(t.state.detects, 0);
});

test('discover 未安装的家各占一行并带回查过的位置，总数只算读到的资产', () => {
  resetTools();
  makeTool('good', 'Good', { memory: [bareMemory('m1', 'a')], skill: [bareSkill('s1')] });
  makeTool('missing', 'Missing', {}, { detect: () => ({ ok: false, error: '本机未装', checked: [{ location: '$P', exists: false }] }) });
  const res = S.discover({ env: ENV });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.totalAssets, 2);
  assert.deepStrictEqual(res.tools.map((t) => t.tool), ['good', 'missing']);
  assert.deepStrictEqual(res.tools[0].counts, { memory: 1, tool: 0, skill: 1 });
  assert.strictEqual(res.tools[0].total, 2);
  assert.strictEqual(res.tools[0].root, '/root/good');
  assert.strictEqual(res.tools[0].error, '');
  assert.deepStrictEqual(res.tools[1], {
    tool: 'missing', label: 'Missing', detected: false, root: '',
    counts: {}, total: 0, error: '本机未装', checked: [{ location: '$P', exists: false }],
  });
});

test('discover 的 tools 参数直接决定跑哪几家，未注册 id 也照实占一行', () => {
  resetTools();
  makeTool('a', 'A', { memory: [bareMemory('m1', 'a')] });
  makeTool('b', 'B', { tool: [bareTool('t1', 'builtin')] });
  registryCalls.resolve = [];
  const subset = S.discover({ env: ENV, tools: ['b'] });
  assert.deepStrictEqual(subset.tools.map((t) => t.tool), ['b']);
  assert.strictEqual(subset.totalAssets, 1);
  assert.deepStrictEqual(registryCalls.resolve.map((c) => c.id), ['b']);

  const junk = S.discover({ env: ENV, tools: ['ghost'] });
  assert.strictEqual(junk.ok, true);
  assert.deepStrictEqual(junk.tools[0], {
    tool: 'ghost', label: '', detected: false, root: '', counts: {}, total: 0,
    error: '未注册的外部 agent 工具:ghost', checked: [],
  });
  assert.deepStrictEqual(S.discover({ env: ENV, tools: [] }).tools.map((t) => t.tool), ['a', 'b'],
    '空数组等于不指定，回全量六家逻辑（此处是注册的全部家）');
});

// ── plan ─────────────────────────────────────────────────────────────────

test('plan 逐身份判 create / in-sync / conflict，并给出四类计数摘要', () => {
  resetTools();
  makeTool('from', 'From', {
    memory: [bareMemory('new', 'only-source'), bareMemory('same', 'both'), bareMemory('div', 'source-side')],
    tool: [bareTool('onlytool', 'mcp_server')],
    skill: [],
  });
  makeTool('to', 'To', {
    memory: [bareMemory('same', 'both'), bareMemory('div', 'target-side'), bareMemory('target-only', 't')],
  });
  const res = S.plan({ from: 'from', to: 'to', env: ENV });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.skipped, false);
  assert.deepStrictEqual([res.from, res.to, res.fromLabel, res.toLabel], ['from', 'to', 'From', 'To']);
  assert.deepStrictEqual(res.items.map((i) => [i.kind, i.identity, i.action]), [
    ['memory', 'project:new', 'create'],
    ['memory', 'project:same', 'in-sync'],
    ['memory', 'project:div', 'conflict'],
    ['tool', 'onlytool', 'create'],
  ], '仅目标侧存在的资产不进计划');
  assert.deepStrictEqual(res.summary, { total: 4, create: 2, 'in-sync': 1, conflict: 1, noop: 0 });
  assert.strictEqual(res.items[0].reason, '目标侧不存在,可直接新建');
  assert.strictEqual(res.items[0].newer, 'source');
  assert.strictEqual(res.items[2].reason, '同名但内容哈希不同(两侧时间戳无法比较)——保留双方,生成冲突副本');
  assert.strictEqual(res.items[2].sourceHash, M.contentHash(bareMemory('div', 'source-side')));
  assert.strictEqual(res.items[2].targetHash, M.contentHash(bareMemory('div', 'target-side')));
  assert.strictEqual(res.items[1].sourceHash, res.items[1].targetHash);
});

test('plan 的 name 取 title→name→id→identity 逐级回落，时间戳让 newer 变成 source/target', () => {
  resetTools();
  makeTool('f2', 'F2', {
    memory: [bareMemory('m1', 'a', { title: '', updatedAt: '2026-01-02T00:00:00.000Z' })],
    tool: [bareTool('tool-x', 'builtin')],
    skill: [bareSkill('skill-x')],
  });
  makeTool('t2', 'T2', {
    memory: [bareMemory('m1', 'b', { title: '', updatedAt: '2026-01-01T00:00:00.000Z' })],
    skill: [bareSkill('skill-x', { contents: { 'SKILL.md': '# other' } })],
  });
  const res = S.plan({ from: 'f2', to: 't2', env: ENV });
  assert.deepStrictEqual(res.items.map((i) => i.name), ['m1', 'tool-x', 'skill-x']);
  assert.strictEqual(res.items[0].newer, 'source');
  assert.strictEqual(res.items[0].reason, '同名但内容哈希不同(源侧更新时间较晚)——保留双方,生成冲突副本');
  assert.strictEqual(res.items[2].newer, 'unknown');
});

test('plan 在源/目标任一家未检测到时回 skipped 并给 reason，绝不给空计划冒充「无差异」', () => {
  resetTools();
  makeTool('live', 'Live', { memory: [bareMemory('m1', 'a')] });
  makeTool('gone', 'Gone', {}, { detect: () => ({ ok: false, error: '本机未装' }) });

  const noSrc = S.plan({ from: 'gone', to: 'live', env: ENV });
  assert.deepStrictEqual(noSrc, {
    ok: true, from: 'gone', to: 'live', skipped: true,
    reason: '未检测到源工具 Gone:本机未装', items: [],
  });

  const noDst = S.plan({ from: 'live', to: 'gone', env: ENV });
  assert.strictEqual(noDst.skipped, true);
  assert.strictEqual(noDst.reason, '未检测到目标工具 Gone:本机未装');

  const badTo = S.plan({ from: 'live', to: 'ghost', env: ENV });
  assert.deepStrictEqual(badTo, { ok: false, error: '未注册的外部 agent 工具:ghost' },
    '目标未注册不是「没装」，是硬错误');
});

test('plan 对缺失入参与垃圾 env 都如实拒绝，不猜默认工具', () => {
  resetTools();
  makeTool('only', 'Only', { memory: [bareMemory('m1', 'a')] });
  assert.deepStrictEqual(S.plan({ env: ENV }), { ok: false, error: '未注册的外部 agent 工具:(空)' });
  const self = S.plan({ from: 'only', to: 'only', env: ENV });
  assert.strictEqual(self.ok, true);
  assert.deepStrictEqual(self.summary, { total: 1, create: 0, 'in-sync': 1, conflict: 0, noop: 0 },
    'from=to 不设防:同家自计划是合法计划,两侧读到同一份数据,全部 in-sync');
  // env 缺省时读进程环境，用 withEnv 把两种门控状态都钉下来（不留机器相关性）。
  assert.deepStrictEqual(withEnv({ KHY_AGENT_ASSETS: undefined }, () => S.plan(null)),
    { ok: false, error: '未注册的外部 agent 工具:(空)' }, '未设置该变量 = 门开，于是走「工具未注册」分支');
  assert.deepStrictEqual(withEnv({ KHY_AGENT_ASSETS: 'off' }, () => S.plan(null)),
    { ok: false, error: '外部 agent 资产层已被门控关闭(KHY_AGENT_ASSETS=off)' });
  assert.deepStrictEqual(withEnv({ KHY_AGENT_ASSETS: 'off' }, () => S.transfer({ from: 'only', to: 'only' })),
    { ok: false, error: '外部 agent 资产层已被门控关闭(KHY_AGENT_ASSETS=off)' },
    '关门时 transfer 不做任何搬运，也不碰适配器');
});

// ── transfer ─────────────────────────────────────────────────────────────

test('transfer 的 dryRun 默认为真：writeAsset 收到 {dryRun:true}，落盘条目为空', () => {
  resetTools();
  const from = makeTool('f', 'F', { memory: [bareMemory('m1', 'a')] });
  const to = makeTool('t', 'T', {});
  const res = S.transfer({ from: 'f', to: 't', env: ENV });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.dryRun, true);
  assert.strictEqual(to.state.writes.length, 1);
  assert.deepStrictEqual(to.state.writes[0].opts, { dryRun: true });
  assert.deepStrictEqual(res.applied, [{
    kind: 'memory',
    identity: 'project:m1',
    action: 'create',
    plan: [{ rel: 'memory/m1' }],
    written: [],
  }]);
  assert.strictEqual(res.applied[0].plan === to.state.writes[0].plan, false, 'plan 为空时该回 []，不共享 undefined');
  assert.deepStrictEqual(res.conflicts, []);
  assert.deepStrictEqual(res.failures, []);
  assert.strictEqual(from.state.writes.length, 0, '源侧适配器不得被写入');
  const dry = S.transfer({ from: 'f', to: 't', dryRun: false, env: ENV });
  assert.strictEqual(dry.dryRun, false);
  assert.deepStrictEqual(dry.applied[0].written, [{ rel: 'memory/m1' }]);
  assert.deepStrictEqual(to.state.writes[1].opts, { dryRun: false });
});

test('transfer 只搬 create 与 conflict，in-sync 项连 writeAsset 都不叫', () => {
  resetTools();
  makeTool('f', 'F', { memory: [bareMemory('same', 'x'), bareMemory('fresh', 'y')] });
  const to = makeTool('t', 'T', { memory: [bareMemory('same', 'x')] });
  const res = S.transfer({ from: 'f', to: 't', env: ENV });
  assert.strictEqual(res.summary.total, 2);
  assert.strictEqual(res.summary['in-sync'], 1);
  assert.strictEqual(res.summary.appliedCount, 1);
  assert.strictEqual(to.state.writes.length, 1);
  assert.strictEqual(to.state.writes[0].asset.id, 'fresh');
});

test('transfer 冲突默认 keep-both：原资产不动，副本改名换落点，conflicts 逐条列', () => {
  resetTools();
  makeTool('f', 'F', { memory: [bareMemory('div', 'source-side')] });
  const to = makeTool('t', 'T', { memory: [bareMemory('div', 'target-side')] });
  const res = S.transfer({ from: 'f', to: 't', env: ENV });
  assert.strictEqual(res.summary.conflict, 1);
  assert.strictEqual(to.state.writes.length, 1);
  const copy = to.state.writes[0].asset;
  const hash = M.contentHash(bareMemory('div', 'source-side'));
  assert.strictEqual(copy.id, M.conflictCopyName('div', 'f', hash));
  assert.strictEqual(copy.title, 'div（来自 f 的冲突副本）');
  assert.strictEqual(copy.content, 'source-side', '副本承载来侧内容，目标原资产一字不动');
  assert.strictEqual(res.conflicts[0].copyIdentity, M.assetIdentity(copy),
    'copyIdentity 是带 scope 前缀的全身份(sync.js:440),与 conflicts[].identity 同一口径');
  assert.strictEqual(res.conflicts[0].resolution, 'keep-both');
  assert.strictEqual(res.applied[0].action, 'conflict');
  assert.strictEqual(M.assetIdentity(bareMemory('div', 'source-side')), 'project:div',
    '原身份仍在 conflicts.identity 上，供用户对照');
});

test('transfer 的 onConflict=skip 完全不写冲突项，副本命名与落点都不产生', () => {
  resetTools();
  makeTool('f', 'F', { memory: [bareMemory('div', 'src')], tool: [bareTool('shared', 'builtin')] });
  const to = makeTool('t', 'T', {
    memory: [bareMemory('div', 'dst')],
    tool: [bareTool('shared', 'local_command', { spec: { command: 'other' } })],
  });
  const res = S.transfer({ from: 'f', to: 't', onConflict: 'skip', env: ENV });
  assert.strictEqual(to.state.writes.length, 0);
  assert.deepStrictEqual(res.applied, []);
  assert.strictEqual(res.conflicts.length, 2);
  assert.deepStrictEqual(res.conflicts.map((c) => c.resolution), ['skip', 'skip']);
  assert.strictEqual(res.conflicts[0].newer, 'unknown');
  assert.strictEqual(res.conflicts[1].identity, 'shared');
  assert.strictEqual(res.summary.appliedCount, 0);
  assert.strictEqual(S.transfer({ from: 'f', to: 't', onConflict: 'bogus', env: ENV })
    .conflicts[0].resolution, 'keep-both', '未知策略回落 keep-both，绝不因拼错而覆盖');
});

test('transfer 把写入失败收进 failures，unsupported 标志如实带出，整体仍算 ok', () => {
  resetTools();
  makeTool('f', 'F', { memory: [bareMemory('m1', 'a')], tool: [bareTool('t1', 'builtin')] });
  const to = makeTool('t', 'T', {}, {
    writeAsset: (kind, asset, opts) => {
      if (kind === 'tool') return { ok: false, unsupported: true, error: '该家不支持写工具' };
      throw new Error('disk full');
    },
  });
  const res = S.transfer({ from: 'f', to: 't', dryRun: false, env: ENV });
  assert.strictEqual(res.ok, true, '一项写失败不等于整条链路失败');
  assert.deepStrictEqual(res.applied, []);
  assert.strictEqual(res.failures.length, 2);
  assert.deepStrictEqual(res.failures[0], { kind: 'memory', identity: 'project:m1', error: 'writeAsset 异常:disk full', unsupported: false });
  assert.deepStrictEqual(res.failures[1], { kind: 'tool', identity: 't1', error: '该家不支持写工具', unsupported: true });
  assert.strictEqual(res.summary.failureCount, 2);
  assert.strictEqual(res.summary.appliedCount, 0);
});

test('transfer 在源侧资产于计划后消失时记失败并继续，不带 index 漂移', () => {
  resetTools();
  let first = true;
  makeTool('f', 'F', {}, {
    listMemories: () => {
      const assets = first ? [bareMemory('m1', 'a'), bareMemory('m2', 'b')] : [bareMemory('m2', 'b')];
      first = false;
      return { ok: true, assets };
    },
  });
  const to = makeTool('t', 'T', {});
  const res = S.transfer({ from: 'f', to: 't', env: ENV });
  assert.deepStrictEqual(res.failures, [{ kind: 'memory', identity: 'project:m1', error: '源侧资产在计划后消失' }]);
  assert.strictEqual(res.applied.length, 1);
  assert.strictEqual(to.state.writes.length, 1);
});

test('transfer 走计划失败路径时原样回吐 plan 的形状（没有 dryRun/applied/conflicts 字段）', () => {
  resetTools();
  makeTool('f', 'F', { memory: [bareMemory('m1', 'a')] });
  const res = S.transfer({ from: 'f', to: 'ghost', env: ENV });
  assert.deepStrictEqual(res, { ok: false, error: '未注册的外部 agent 工具:ghost' });
  assert.strictEqual('applied' in res, false);
  // skipped 路径要求目标「注册了但没检测到」:to:'f' 是已检测的家,根本走不到这条分支
  // (首版就是栽在这里,actual 是 11 键的全量成功形状)。夹具换成未检测的 gone。
  makeTool('gone', 'Gone', {}, { detect: () => ({ ok: false, error: '本机未装' }) });
  const skipped = S.transfer({ from: 'f', to: 'gone', env: ENV, kinds: ['memory'] });
  assert.strictEqual(skipped.ok, true);
  assert.deepStrictEqual(Object.keys(skipped).sort(),
    ['applied', 'conflicts', 'dryRun', 'from', 'ok', 'reason', 'skipped', 'summary', 'to']);
  assert.deepStrictEqual(skipped.summary, { total: 0 });
});

test('transfer 的进度回调逐字带「正在同步/导入/导出」文案，回调自己炸掉不影响搬运', () => {
  resetTools();
  makeTool('f', 'F', { memory: [bareMemory('m1', 'a'), bareMemory('m2', 'b')] });
  const to = makeTool('t', 'T', {});
  const seen = [];
  const res = S.transfer({ from: 'f', to: 't', env: ENV, action: '导入', onProgress: (p) => seen.push(p) });
  assert.deepStrictEqual(seen.map((p) => p.message), [
    '正在导入 F 记忆 1/2:m1',
    '正在导入 F 记忆 2/2:m2',
  ]);
  assert.deepStrictEqual(seen.map((p) => p.index), [1, 2]);
  assert.strictEqual(seen[0].tool, 't', '进度里的 tool 是目标，动作发生在往哪写');
  assert.strictEqual(seen[0].phase, 'transfer');
  assert.strictEqual(res.applied.length, 2);

  const boom = S.transfer({
    from: 'f', to: 't', env: ENV,
    onProgress: () => { throw new Error('观测通道炸了'); },
  });
  assert.strictEqual(boom.ok, true, 'onProgress 是观测通道，它失败不得影响搬运');
});

test('transfer 的空闲超时是活动感知的：每项刷新 lastActivity，慢但在动不被硬杀', () => {
  resetTools();
  makeTool('f', 'F', { memory: [bareMemory('m1', 'a'), bareMemory('m2', 'b'), bareMemory('m3', 'c')] });
  let n = 0;
  const to = makeTool('t', 'T', {}, {
    writeAsset: (kind, asset) => {
      n += 1;
      busy(25);
      return { ok: true, plan: [], written: [], seq: n };
    },
  });
  const res = S.transfer({ from: 'f', to: 't', env: ENV, idleTimeoutMs: 40, dryRun: false });
  assert.strictEqual(res.ok, true, '总计 75ms > 40ms，但每 25ms 就有一项进展，不该中止');
  assert.strictEqual(to.state.writes.length, 3);
});

test('transfer 中止回报「第几项+哪一步」与五键 summary;慢写入不触发中止(每项完成即刷新活动)', () => {
  resetTools();
  makeTool('f', 'F', { memory: [bareMemory('m1', 'a'), bareMemory('m2', 'b')] });
  let n = 0;
  const to = makeTool('t', 'T', {}, {
    writeAsset: () => {
      n += 1;
      if (n === 1) {
        busy(80);
      }
      return { ok: true, plan: [], written: [] };
    },
  });
  // 实测钉死:首项写 80ms 远超 idleTimeoutMs=20,但中止判定只在「每项开头」做,
  // 而上一项完成时(成功 sync.js:470 / 失败 :460)都会刷新 lastActivity ⇒ 正超时下
  // 两次检查的间隙永远 ≈0,慢写入不可能触发中止。这正是「慢但在动不被硬杀」的兑现形态;
  // 代价是真卡死的同步写入会阻塞整条循环、检查没有机会运行 —— 结构缺陷,登记不修。
  const slow = S.transfer({ from: 'f', to: 't', env: ENV, idleTimeoutMs: 20, dryRun: false });
  assert.strictEqual(slow.ok, true, '80ms 首写 > 20ms 阈值,仍不被硬杀');
  assert.strictEqual(n, 2, '两项都写完');

  // 可达的中止路径只有「首项检查前就已超时」:idleTimeoutMs ≤ 0 ⇒ 卡在第 1/2 的「开始搬运」。
  const never = S.transfer({ from: 'f', to: 't', env: ENV, idleTimeoutMs: -1 });
  assert.strictEqual(never.ok, false);
  assert.match(never.error, /^连续 \d+ 秒无进展,已中止。卡在第 1\/2 项\(记忆「m1」\)的「开始搬运」步骤$/,
    '首项之前也算无进展；lastStep 的初值就是「开始搬运」');
  assert.strictEqual(never.dryRun, true);
  assert.deepStrictEqual(never.applied, []);
  assert.deepStrictEqual(never.conflicts, []);
  assert.deepStrictEqual(Object.keys(never.summary).sort(), ['conflict', 'create', 'in-sync', 'noop', 'total'],
    '中止路径的 summary 少了 appliedCount 三件套（与正常返回不同形状）');
  assert.strictEqual(to.state.writes.length, 2, '中止发生在首项写入之前,never 未新增写入(slow 已写 2 条)');
});

test('transfer 的 idleTimeoutMs 只认有限数：NaN / Infinity / 字符串 / 缺省都回 60 秒默认', () => {
  resetTools();
  makeTool('f', 'F', { memory: [bareMemory('m1', 'a')] });
  const to = makeTool('t', 'T', {});
  for (const junk of [NaN, Infinity, -Infinity, '20', null, undefined, {}]) {
    const res = S.transfer({ from: 'f', to: 't', env: ENV, idleTimeoutMs: junk });
    assert.strictEqual(res.ok, true, `${String(junk)} 不该被当成超时阈值`);
  }
  assert.strictEqual(to.state.writes.length, 7);
});

// ── 三个入口 ─────────────────────────────────────────────────────────────

test('KNOWN-DEFECT: sync.js:435 conflicts 在 writeAsset 之前入列，写入失败也报出从未落地的冲突副本', () => {
  // File: sync.js:434-443 — `payload = _asConflictCopy(...)` then `conflicts.push({...
  // copyIdentity})` happen *before* sync.js:449 calls writeAsset. If that write fails (target
  // declares the kind unwritable, e.g. harness's tools or deepseek-harness's memory, or the disk
  // rejects), the failure lands in `failures` (sync.js:453-461) but the conflict entry is never
  // retracted. Callers that render only `conflicts[]` (AgentAssetsTool's report) therefore tell
  // the user "已另存冲突副本 <copyIdentity>" for a file that does not exist on disk — a wrong
  // result leaving the process.
  resetTools();
  makeTool('f', 'F', { tool: [bareTool('shared', 'mcp_server')] });
  const to = makeTool('t', 'T', { tool: [bareTool('shared', 'local_command', { spec: { command: 'other' } })] }, {
    writeAsset: () => ({ ok: false, unsupported: true, error: 'tools.json 由 harness 自己生成,不可写' }),
  });
  const res = S.transfer({ from: 'f', to: 't', dryRun: false, env: ENV });
  assert.strictEqual(res.conflicts.length, 1, '副本压根没写成，conflicts 仍报一条');
  assert.strictEqual(typeof res.conflicts[0].copyIdentity, 'string');
  assert.deepStrictEqual(res.applied, [], 'applied 才是真发生的事');
  assert.strictEqual(res.summary.conflictCount, 1);
  assert.strictEqual(res.summary.failureCount, 1);
  assert.strictEqual(to.state.writes.length, 1);
});

test('KNOWN-DEFECT: sync.js:317 _asConflictCopy 的注释承诺清掉 source.tool，代码只改 path', () => {
  // File: sync.js:315-316 comment says "把 tool 置成目标侧未知值,迫使适配器走「跨工具导入」
  // 的托管落点", but sync.js:317-321 only overwrites `path` via Object.assign and leaves
  // `source.tool` as the *source* tool id. Adapters branch on
  // `asset.source.tool === TOOL_ID && asset.source.path` (e.g. khyOs.js:342) to decide whether
  // to honour the incoming path, so a conflict copy produced by a same-tool transfer
  // (importAssets({from:'khy-os'}) / syncAssets({a,b}) 往返同一 id) is written straight back
  // into the source tool's own layout instead of the managed import landing spot.
  resetTools();
  makeTool('f', 'F', { memory: [bareMemory('div', 'src')] });
  const to = makeTool('t', 'T', { memory: [bareMemory('div', 'dst')] });
  S.transfer({ from: 'f', to: 't', env: ENV });
  const copy = to.state.writes[0].asset;
  // 夹具入参的 source.tool 是 ''(bareMemory 默认),「原样保留」保留的就是这个空串;
  // 「注释承诺清掉、代码没清」的钉子在下面 dup→dup 的同工具用例上(那里保留的是 'dup')。
  assert.strictEqual(copy.source.tool, '');
  assert.strictEqual(copy.source.path, M.conflictCopyPath('memory/div.md', 'f', M.contentHash(bareMemory('div', 'src'))));
  assert.strictEqual(copy.raw.frontmatterText, '', '原始 frontmatter 文本必须清空，否则副本带旧头');
  assert.strictEqual(copy.raw.conflictOf, 'project:div');
  assert.deepStrictEqual(bareMemory('div', 'src').source, { tool: '', path: 'memory/div.md', format: '', redactedFields: [] },
    '入参资产不被改写：深拷贝确实生效');

  // 同工具搬运要产出冲突副本,静态同数据做不到(两次读取同内容 = 全部 in-sync,无写入),
  // 故让 listMemories 两次返回不同内容:plan 的源读 / 目标读撞出 conflict,transfer 的源读
  // (第三次)与计划里的源侧一致,writeAsset 收到的就是带本家工具戳的冲突副本。
  let flip = false;
  const same = makeTool('dup', 'Dup', {}, {
    listMemories: () => {
      flip = !flip;
      return {
        ok: true,
        assets: [bareMemory('x', flip ? 'second' : 'first', { source: { tool: 'dup', path: 'memory/x.md', format: '', redactedFields: [] } })],
      };
    },
  });
  S.transfer({ from: 'dup', to: 'dup', env: ENV });
  assert.strictEqual(same.state.writes[0].asset.source.tool, 'dup',
    '同工具搬运时 source.tool 仍是本家 → 适配器认得这个路径，副本落回原目录体系');
});

test('importAssets 强制 to=khy-os 与动作词「导入」，exportAssets 强制 from=khy-os 与「导出」', () => {
  resetTools();
  makeTool('khy-os', 'khy-os 本地资产库', { memory: [bareMemory('mine', 'k')] });
  makeTool('opencode', 'opencode', { memory: [bareMemory('theirs', 'o')] });

  const imp = S.importAssets({ from: 'opencode', env: ENV });
  assert.strictEqual(imp.from, 'opencode');
  assert.strictEqual(imp.to, 'khy-os');
  assert.strictEqual(imp.fromLabel, 'opencode');
  assert.strictEqual(imp.summary.appliedCount, 1);

  // 调用方塞 to/from 也没用：两个入口把方向钉死。
  assert.strictEqual(S.importAssets({ from: 'opencode', to: 'opencode', env: ENV }).to, 'khy-os');
  assert.strictEqual(S.exportAssets({ to: 'khy-os', from: 'khy-os', env: ENV }).from, 'khy-os');
  assert.strictEqual(S.exportAssets({ to: 'opencode', env: ENV }).to, 'opencode');
});

test('import/export 的动作词只改文案不改行为，且干跑默认仍生效', () => {
  resetTools();
  makeTool('khy-os', 'khy-os 本地资产库', { memory: [bareMemory('mine', 'k')] });
  makeTool('opencode', 'opencode', {});
  const impMsg = [];
  const expMsg = [];
  const imp = S.importAssets({ from: 'opencode', env: ENV, onProgress: (p) => impMsg.push(p.message) });
  const exp = S.exportAssets({ to: 'opencode', env: ENV, onProgress: (p) => expMsg.push(p.message) });
  assert.strictEqual(imp.dryRun, true);
  assert.strictEqual(exp.dryRun, true);
  assert.deepStrictEqual(expMsg, ['正在导出 khy-os 本地资产库 记忆 1/1:mine']);
  assert.deepStrictEqual(impMsg, [], 'opencode 侧无资产时不该有进度行');
});

test('syncAssets 缺 a 直接拒绝；b 默认 khy-os；两个方向的动作词分别是同步与回流同步', () => {
  resetTools();
  makeTool('khy-os', 'khy-os 本地资产库', { memory: [bareMemory('mine', 'k')] });
  makeTool('opencode', 'opencode', { memory: [bareMemory('theirs', 'o')] });

  assert.deepStrictEqual(S.syncAssets({ env: ENV }), { ok: false, error: '缺少同步的一侧工具 id(参数 a)' });
  assert.deepStrictEqual(S.syncAssets(null), { ok: false, error: '缺少同步的一侧工具 id(参数 a)' });
  assert.deepStrictEqual(S.syncAssets({ a: '   ', env: ENV }), { ok: false, error: '缺少同步的一侧工具 id(参数 a)' });

  const res = S.syncAssets({ a: 'opencode', env: ENV });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual([res.a, res.b], ['opencode', 'khy-os']);
  assert.strictEqual(res.dryRun, true, '干跑默认值由 forward 方向决定');
  assert.strictEqual(res.directions.length, 2);
  assert.strictEqual(res.directions[0].from, 'opencode');
  assert.strictEqual(res.directions[1].from, 'khy-os');
});

test('syncAssets 合并两方向的 conflicts 与三个计数，方向里的 applied 各自保留', () => {
  resetTools();
  makeTool('a', 'A', { memory: [bareMemory('div', 'from-a'), bareMemory('only-a', 'x')] });
  makeTool('b', 'B', { memory: [bareMemory('div', 'from-b')] });
  const res = S.syncAssets({ a: 'a', b: 'b', env: ENV });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.conflicts.length, 2, '两个方向各撞一次同名不同内容');
  assert.deepStrictEqual(res.conflicts.map((c) => c.identity), ['project:div', 'project:div']);
  assert.deepStrictEqual(res.summary, { appliedCount: 3, conflictCount: 2, failureCount: 0 },
    'dryRun 下 conflict 副本与 create 一样进 applied(与 transfer 单向用例 :534 同一口径):前向 2 + 回向 1');
  assert.strictEqual(res.directions[0].applied.length, 2);
  assert.strictEqual(res.directions[1].applied.length, 1, '回向的 div 冲突同样产出一份副本 applied');
});

test('syncAssets 前任方向硬失败就短路，后任方向一次都不跑；后任失败时两方向都在 directions 里', () => {
  resetTools();
  makeTool('a', 'A', { memory: [bareMemory('m1', 'x')] });
  const res = S.syncAssets({ a: 'a', b: 'ghost', env: ENV });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, '未注册的外部 agent 工具:ghost');
  assert.strictEqual(res.directions.length, 1);
  assert.deepStrictEqual(res.directions[0], { ok: false, error: '未注册的外部 agent 工具:ghost' });

  resetTools();
  makeTool('p', 'P', { tool: [bareTool('only-p', 'builtin')] });
  makeTool('q', 'Q', {}, {
    writeAsset: (kind) => (kind === 'tool' ? { ok: false, unsupported: true, error: 'Q 不写工具' } : { ok: true }),
  });
  const back = S.syncAssets({ a: 'p', b: 'q', env: ENV });
  assert.strictEqual(back.ok, true, '写入失败不是方向失败');
  assert.strictEqual(back.summary.failureCount, 1);
});
