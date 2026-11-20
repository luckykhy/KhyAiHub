'use strict';

// slashCommandGroups.test.cjs — 命令页分组「后端 category → 桌面 groupKey → 组目录」
// 三层字段流转的主进程侧行为钉住。源码正则那半在 slashCommandMerge.test.cjs 的
// B5/B6（组键映射唯一口径、groups 下发、返回类型加宽），这里钉运行时行为，不重复。
//
// 覆盖：
//   G1 slashCommandItems() 的归组输出：用户技能行恒归 skill（它们的 category 全是
//      register() 的 'system' 兜底，跟着走会涌进「系统」组当杂物抽屉）、其余按
//      后端 category、无值归 other；CC 桥行（_commandFile）不在本路径重复。
//   G2 listSlashCommands() 的载荷形状：mergeSlashMenuRows 按引用透传整行（A12 钉住
//      这个事实），所以这里必须显式剥离 category；同时随响应下发 groups、随行下发
//      groupKey（渲染层不自己编中文组名）。
//   G3 slashCommandGroups() 目录：前段取后端 CATEGORIES 运行时键序与中文标签
//      （组名真源是后端，桌面复制一份就是影子副本；键数随后端变，analysis 于
//      2026-11-12 收编后真源今日 7 键，本文件默认夹具仍只放 6 键），后 4 组桌面
//      补丁；后端收录 analysis 时补丁键自动去重、标签改用后端值。桌面侧的
//      analysis 私标签副本从未存在过（它一直在后端 commandCatalogUi.js 的
//      _EXTRA_CATEGORY_LABELS，2026-11-12 已删该键），G3a 两条负向断言分别守
//      桌面「不许再抄」与后端「副本真的没了」。
//   G4 降级：拉不到命令源时三个出口全部诚实降级 —— 命令页 groups=[] 且 khy 行缺席，
//      渲染层因此回落平铺（与今日行为一致）。
//   G5 agentItemStore.listItems 的接线：command kind 合并终端行与 khy 行、随响应下发
//      groups、排序口径仍是 name.localeCompare；其余 kind 不下发 groups。
//   G6 source 透传后的桌面侧四路映射：技能/CC 桥（同为后端 source 'user'）靠文件字段
//      分开、plugin/mcp 合并成 'plugin'、tool 与 builtin 归 'khy'；行标签不被改坏。
//   G6b slash:list 载荷里的 CC 桥行组键必须是 'claude-code' —— 少这一支它们会顶着
//      groupKey 'khy' 涌进「Khy 内置」组，与设置页自己的 claude-code 组矛盾。
//   G7 ARCH-209 绊线：直接读真源 CATEGORIES，12 个新类目键一进注册表即红，强制回来
//      重裁 slashCommandSources.ts 的映射注记（不靠人记得）。
//
// 加载手法（生产代码零改动，不「为测试重构」）：slashCommandSources.ts 带
// ./keyManager/keyStore、./terminalSources 两个相对 import，slashCommandMerge.test.cjs
// 的 loadModule 只够加载零相对 import 的叶子（裸 require 会按 tests/ 解析错路径）。
// 这里按说明符拦一层 require：两个 IO 叶子换成桩，真叶子 ./slashCommandMerge 照常
// 转译加载，node: 内建透传。后端注册表/extras/aliases 用落在临时目录的假模块，字段
// 形状逐字对齐 runtime/node/backend/src/cli/ 的真实出口（register():119-153、
// toSlashCommands():272-288、mergeExtraCommands():61-72）—— 不依赖本机技能集
// （38 这个数随机器变，不是仓内恒定值，方案 risk 6）。
//
// esModuleInterop 必须开：slashCommandSources.ts 有 `import path from 'node:path'`
// 默认导入，不开时转译产出 node_path_1.default，而 node:path 没有 .default，
// cli() 里第一个 path.join 就是 undefined。
//
// runner 纪律（照 sessionLoadState.test.cjs / compactNumber.test.cjs 的成例）：
// node:test + assert/strict，绝不用裸 describe/test/expect。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const projectRoot = path.join(__dirname, '..');

function readSrc(rel) {
  // 去掉 BOM：部分源文件带 UTF-8 BOM，转译后会成为正文字符
  return fs.readFileSync(path.join(projectRoot, rel), 'utf-8').replace(/^﻿/, '');
}

function transpile(src) {
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
}

function evalCjs(js, requireFn) {
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', js)(mod.exports, mod, requireFn);
  return mod.exports;
}

// ── 假后端（临时目录，不碰真实 backend，不扫真盘）──────────────────────────

// 键序与标签 = commandRegistry.js:25-32 的真源（终端 / 菜单同一份）。analysis 已由
// 后端收编进真源，但夹具仍只放 6 键：桌面侧的「后端有 analysis」行为由 G3b 单独钉，
// 混进默认夹具会让 G1/G2 的期望同时多一项，看不清单条口径。
const BACKEND_CATEGORIES = {
  model: 'AI 模型',
  data: '数据管理',
  security: '安全',
  dev: '开发工具',
  workflow: '工作流',
  system: '系统',
};

// 行形状 = toSlashCommands() 出口：cmd/label/desc/route/flag/category/source + 可选
// _skillDir/_commandFile（register():123-144 保证 category 恒有值，source 按入册来源）。
// 这一份覆盖归组口径的每一种输入：
//   /model     内置行 source=builtin category=model      → 'model'
//   /memory    内置行 source=builtin category=workflow   → 'workflow'
//   /commit    用户技能行（_skillDir，source=user）cat=dev → 'skill'（不跟 category）
//   /review-pr CC 桥行（_commandFile，source=user）        → slashCommandItems 过滤掉
//   /debug     none 行（无 route 无文件）category=dev     → 仍归 'dev'（分组不看 runnable）
//   /push      注册表版（category=dev）+ extras 版撞名     → 既有优先，落 'dev' 不是 other
const REGISTRY_ROWS = [
  { cmd: '/model', label: 'model', desc: '模型管理', route: 'gateway model', flag: null, category: 'model', source: 'builtin' },
  { cmd: '/memory', label: 'memory', desc: '记忆管理', route: 'memory', flag: null, category: 'workflow', source: 'builtin' },
  { cmd: '/commit', label: 'commit', desc: '生成提交信息', route: null, flag: null, category: 'dev', source: 'user', _skillDir: 'D:/skills/commit' },
  { cmd: '/review-pr', label: 'review-pr', desc: '评审 PR', route: null, flag: null, category: 'system', source: 'user', _commandFile: 'D:/cc/review-pr.md' },
  { cmd: '/debug', label: 'debug', desc: '调试模式', route: null, flag: null, category: 'dev', source: 'builtin' },
  { cmd: '/push', label: '发布到远程', desc: '推送到远程仓库', route: 'repo publish', flag: null, category: 'dev', source: 'builtin' },
];

// extras 假行：不在注册表、无 category 无 source（对齐 slashExtraCommands.js:33-55 的
// 真实形态；/push 与注册表撞名，验「既有优先」让它以内置身份落 dev 组）。
const EXTRA_ROWS = [
  { cmd: '/study', label: '学习模式', desc: '学习模式开关' },
  { cmd: '/push', label: '推送备份', desc: '推送项目到 GitHub/Gitee 私人仓库备份' },
];

function writeFakeBackend(dir, { categories, rows, extras }) {
  const write = (rel, body) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf-8');
  };
  write(
    'cli/commandRegistry.js',
    [
      `const CATEGORIES = ${JSON.stringify(categories)};`,
      `const ROWS = ${JSON.stringify(rows)};`,
      'module.exports = {',
      '  CATEGORIES,',
      '  toSlashCommands: () => ROWS.map((r) => ({ ...r })),',
      '  registerUserSkills: () => {},',
      '  registerCcCommands: () => {},',
      '};',
    ].join('\n')
  );
  // mergeExtraCommands 的「既有优先」语义逐字对齐真源 :61-72（同名 cmd 已在 base 则跳过）
  write(
    'cli/slashExtraCommands.js',
    [
      `const EXTRAS = ${JSON.stringify(extras)};`,
      'function mergeExtraCommands(base) {',
      '  const out = Array.isArray(base) ? base.slice() : [];',
      '  const seen = new Set(out.map((r) => r && r.cmd));',
      '  for (const ex of EXTRAS) {',
      '    if (!seen.has(ex.cmd)) { out.push(ex); seen.add(ex.cmd); }',
      '  }',
      '  return out;',
      '}',
      'module.exports = { SLASH_EXTRA_COMMANDS: EXTRAS, mergeExtraCommands };',
    ].join('\n')
  );
  write('cli/aliases.js', 'module.exports = { ALIAS_MAP: {} };');
  write('cli/commandAutoRegistry.js', 'module.exports = { getAliases: () => ({}) };');
  write('cli/repl/userSkillCommands.js', "module.exports = { loadUserSkillPrompt: () => '' };");
  write('cli/repl/ccUserCommands.js', "module.exports = { loadCcCommandBody: () => '', renderCcCommandBody: (b) => b };");
  write('utils/stripAnsi.js', 'module.exports = (s) => s;');
}

const _tmpDirs = [];
function freshBackend(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-slash-groups-'));
  writeFakeBackend(dir, {
    categories: opts.categories || BACKEND_CATEGORIES,
    rows: opts.rows || REGISTRY_ROWS,
    extras: opts.extras || EXTRA_ROWS,
  });
  _tmpDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of _tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  _tmpDirs.length = 0;
});

// srcRoot 传 null = 模拟 resolveBackendSrcRoot 找不到 backend/src 的降级路径；
// terminalItems = 假 CC/插件行（真值由 terminalSources.listCommands() 打 groupKey）。
function makeRequire(srcRoot, terminalItems = []) {
  const stubs = {
    './keyManager/keyStore': { getDataHome: () => path.join(srcRoot || os.tmpdir(), 'khy-data') },
    './terminalSources': {
      resolveBackendSrcRoot: () => srcRoot || null,
      terminalProjectRoot: () => srcRoot,
      listTerminalItems: async () => terminalItems,
      createTerminalItem: async () => {
        throw new Error('harness：本测试不走写路径');
      },
      setTerminalItemEnabled: async () => {
        throw new Error('harness：本测试不走写路径');
      },
      deleteTerminalItem: async () => {
        throw new Error('harness：本测试不走写路径');
      },
      importTerminalItems: async () => {
        throw new Error('harness：本测试不走写路径');
      },
    },
  };
  const leafCache = new Map();
  const req = (spec) => {
    if (stubs[spec]) return stubs[spec];
    if (spec === './slashCommandMerge' || spec === './slashCommandSources') {
      if (!leafCache.has(spec)) {
        const rel = spec === './slashCommandMerge' ? 'src/main/slashCommandMerge.ts' : 'src/main/slashCommandSources.ts';
        leafCache.set(spec, evalCjs(transpile(readSrc(rel)), req));
      }
      return leafCache.get(spec);
    }
    return require(spec);
  };
  return req;
}

function loadSlashCommandSources(srcRoot, terminalItems = []) {
  return evalCjs(transpile(readSrc('src/main/slashCommandSources.ts')), makeRequire(srcRoot, terminalItems));
}

function loadAgentItemStore(srcRoot, terminalItems) {
  return evalCjs(transpile(readSrc('src/main/agentItemStore.ts')), makeRequire(srcRoot, terminalItems));
}

// 假 CC/插件行：形状 = terminalSources 的 TerminalItem（含 listCommands() 打的 groupKey，
// 见 terminalSources.ts CC 分支 'claude-code' / 插件分支 'plugin'）。
const CC_ROWS = [
  {
    id: 'cc:my-cc', kind: 'command', name: '/my-cc', description: 'Claude Code · 插入输入框', content: '',
    enabled: true, source: 'claude-code', sourceLabel: 'Claude Code', createdAt: 0, updatedAt: 0,
    readOnly: true, toggleable: false, deletable: false, groupKey: 'claude-code',
  },
  {
    id: 'plugin:todo', kind: 'command', name: 'todo', description: '命令插件 · 插入输入框', content: '',
    enabled: true, source: 'user', sourceLabel: '命令插件', createdAt: 0, updatedAt: 0,
    readOnly: true, toggleable: false, deletable: false, groupKey: 'plugin',
  },
];

// ── G1: slashCommandItems 的归组输出 ───────────────────────────────────────

test('G1: 归组输出 —— 技能行恒 skill、其余跟后端 category、无值归 other、CC 桥行不重复', () => {
  const mod = loadSlashCommandSources(freshBackend());
  const items = mod.slashCommandItems();
  assert.deepEqual(
    items.map((it) => [it.name, it.groupKey]),
    [
      ['/model', 'model'],
      ['/memory', 'workflow'],
      ['/commit', 'skill'],
      ['/debug', 'dev'],
      ['/push', 'dev'],
      ['/study', 'other'],
    ],
    '组键口径：技能 → skill，其余按后端 category，空 → other'
  );
  for (const it of items) {
    assert.equal(typeof it.groupKey, 'string', `${it.name} 必须带组键`);
    assert.ok(it.groupKey.length > 0, `${it.name} 的组键不得为空`);
    assert.equal(it.kind, 'command');
  }
  // /commit 的 category 是 'dev'（技能注册时不带分类，register():129 兜底），但它必须
  // 落「技能命令」而不是「开发工具」—— 这是整张归组表里唯一反 category 的一行。
  assert.equal(items.find((it) => it.name === '/commit').groupKey, 'skill');
  // /push 靠 mergeExtraCommands 的「既有优先」以内置身份存活 → 落 dev 组且可 routed
  assert.equal(items.find((it) => it.name === '/push').groupKey, 'dev');
  // CC 桥行由 terminalSources.listCommands 那一节给，本路径不重复出双份
  assert.ok(!items.some((it) => it.name === '/review-pr'), 'CC 桥行不得在本路径出现');
});

// ── G2: listSlashCommands 的载荷形状 ───────────────────────────────────────

test('G2: slash:list 载荷显式剥离 category，随响应下发 groups、随行下发 groupKey', async () => {
  const mod = loadSlashCommandSources(freshBackend());
  const res = await mod.listSlashCommands();
  assert.equal(res.ok, true, res.error || '');
  assert.ok(Array.isArray(res.commands));
  // 组目录随响应下发：渲染层不自己编中文组名（真源是后端，见 slashCommandGroups）
  assert.ok(Array.isArray(res.groups) && res.groups.length > 0, '载荷必须带组目录');
  // A12 钉住 merge 按引用透传整行 —— 所以这里必须自己剥，不靠「消费方恰好不读」。
  for (const row of res.commands) {
    assert.equal('category' in row, false, `slash:list 载荷不得带 category（${row.cmd}）`);
    assert.equal(typeof row.groupKey, 'string', `${row.cmd} 必须带组键`);
    assert.ok(row.groupKey.length > 0, `${row.cmd} 的组键不得为空`);
  }
  // 剥离不丢行：registry 全量 + 未撞名的 extras（/review-pr 在 slash:list 里本来就在，
  // source 过滤只作用于设置页那条路径）
  assert.deepEqual(
    res.commands.map((r) => r.cmd),
    ['/model', '/memory', '/commit', '/review-pr', '/debug', '/push', '/study']
  );
  // 组键与设置页同口径：技能行不跟它自己的 category
  assert.equal(res.commands.find((r) => r.cmd === '/commit').groupKey, 'skill');
  assert.equal(res.commands.find((r) => r.cmd === '/model').groupKey, 'model');
});

// ── G3: 组目录（展示序由 main 生成，渲染层只按它归堆）─────────────────────

test('G3a: 前段取后端 CATEGORIES 运行时键序与中文标签，后 4 组桌面补丁', () => {
  const mod = loadSlashCommandSources(freshBackend());
  const groups = mod.slashCommandGroups();
  assert.deepEqual(
    groups.map((g) => g.key),
    ['model', 'data', 'security', 'dev', 'workflow', 'system', 'skill', 'claude-code', 'plugin', 'other']
  );
  // 中文组名真源是后端（终端 / 菜单同一份），桌面不复制第二份
  assert.deepEqual(
    groups.slice(0, 6).map((g) => g.label),
    ['AI 模型', '数据管理', '安全', '开发工具', '工作流', '系统']
  );
  // 后 4 组是后端没有出口概念的补丁
  assert.deepEqual(
    groups.slice(6).map((g) => g.label),
    ['技能命令', 'Claude Code 命令', '命令插件', '其它']
  );
  // 桌面侧守卫：本文件不得再出现 analysis 私标签（它从未在这里存在过，守的是
  // 「不许再抄一份回来」，不是守一次发生过的删除）。
  const src = readSrc('src/main/slashCommandSources.ts');
  assert.doesNotMatch(src, /analysis:\s*'分析'/, 'analysis 标签已归后端 CATEGORIES，桌面不得再留副本');
  // 真副本一直在后端 commandCatalogUi.js 的 _EXTRA_CATEGORY_LABELS（全史只存在于
  // 那里，HEAD 版 slashCommandSources.ts 根本没有标签表）。2026-11-12 删的是那个
  // 键 —— 这条才守着那次真实发生的删除，删回去即红。
  const catalogUi = readSrc(path.join('..', '..', 'runtime', 'node', 'backend', 'src', 'cli', 'commandCatalogUi.js'));
  const extra = /const _EXTRA_CATEGORY_LABELS = \{([\s\S]*?)\};/.exec(catalogUi);
  assert.ok(extra, 'commandCatalogUi.js 必须能解析出 _EXTRA_CATEGORY_LABELS 字面量');
  assert.ok(
    !/^\s*analysis\s*:/m.test(extra[1]),
    'analysis 已收编进 commandRegistry.CATEGORIES，_EXTRA_CATEGORY_LABELS 不得再留副本'
  );
});

test('G3b: 后端收录 analysis 时补丁键自动去重、标签改用后端值', () => {
  const mod = loadSlashCommandSources(
    freshBackend({ categories: { ...BACKEND_CATEGORIES, analysis: '后端分析' } })
  );
  const groups = mod.slashCommandGroups();
  const keys = groups.map((g) => g.key);
  assert.equal(keys.filter((k) => k === 'analysis').length, 1, 'analysis 只出现一次（不得双份）');
  assert.equal(groups.find((g) => g.key === 'analysis').label, '后端分析', '后端有标签时不用桌面补丁');
  assert.deepEqual(
    keys,
    ['model', 'data', 'security', 'dev', 'workflow', 'system', 'analysis', 'skill', 'claude-code', 'plugin', 'other']
  );
});

// ── G4: 降级（命令页回落平铺的同一条路径）────────────────────────────────

test('G4: 拉不到命令源时三出口全部诚实降级，渲染层因此回落平铺', async () => {
  const mod = loadSlashCommandSources(null);
  assert.deepEqual(mod.slashCommandItems(), [], 'khy 行缺席 = 与今日一致的降级，不抛');
  assert.deepEqual(mod.slashCommandGroups(), [], '目录空 → 渲染层分组门不开');
  const res = await mod.listSlashCommands();
  assert.equal(res.ok, false);
  assert.match(res.error || '', /未找到 runtime\/node\/backend\/src/, '错误必须说清缺什么');
});

// ── G5: agentItemStore.listItems 的接线（B6 正则的行为面对应） ─────────────

test('G5: listItems(command) 合并终端行与 khy 行、下发 groups；其余 kind 不带 groups', async () => {
  const mod = loadAgentItemStore(freshBackend(), CC_ROWS);
  const res = await mod.listItems('command');
  assert.equal(res.ok, true, res.error || '');
  assert.equal(res.groups?.length, 10, '夹具 6 后端键 + 4 桌面补丁；真实后端今日 7 键 → 11 组（G3b 钉 analysis 那一支）');
  const byName = new Map(res.items.map((it) => [it.name, it]));
  // khy 行带组键（归组口径同 G1）；CC/插件行带 terminalSources 侧置的键
  assert.equal(byName.get('/model').groupKey, 'model');
  assert.equal(byName.get('/commit').groupKey, 'skill');
  assert.equal(byName.get('/my-cc').groupKey, 'claude-code');
  assert.equal(byName.get('todo').groupKey, 'plugin');
  // 排序口径未动：仍按 name.localeCompare（分组只归堆、不重排）
  const names = res.items.map((it) => it.name);
  assert.deepEqual(names, [...names].sort((a, z) => a.localeCompare(z)));
  // 其余 kind 的响应里 groups 是 undefined —— 渲染层因此走与今日逐字节相同的平铺分支
  const hook = await mod.listItems('hook');
  assert.equal(hook.ok, true);
  assert.equal('groups' in hook, false, '非 command kind 不得下发 groups');
  // 未知 kind 诚实报错，不静默返空列表
  const bad = await mod.listItems('nope');
  assert.equal(bad.ok, false);
  assert.match(bad.error || '', /未知的条目类型/);
});

// ── G6: source 透传后的桌面侧四路映射 ─────────────────────────────────────

test('G6: source 四路映射 —— 插件归 plugin 组、tool 归 khy、技能/CC 桥标签不被改坏', () => {
  // 在默认夹具上补两类真源今日存在、默认夹具没覆盖的行：
  //   插件行：source 'plugin'，category 是插件命名空间 'todo'（contextFactory.js:69
  //            `category: def.category || ns`）—— 跟着 category 走会顶英文组头；
  //   工具行：source 'tool'（tools/index.js:263 的平台内置工具命令，今日 0 行）。
  // **已申报的用户可见变化**：插件行在 source 透传前被旧派生一律映成 'khy'，设置页
  // 顶「Khy 内置」、组键走插件命名空间 category；现在标签「命令插件」+ 归 'plugin' 组。
  // 下面两条断言（等值 + 不等值）把这次变化钉住，退回旧派生即红。
  // 插件行的 route 必须是 null —— contextFactory.js:67 就是这样注册的（handler 挂在
  // _pluginHandler 上，route 恒空）。早期夹具给了它 'todo'，于是 classifySlashRunnable
  // 落 routed、行内文案走「在输入框敲」那支，真实插件行的 none 分支从没被测到。
  const rows = [
    ...REGISTRY_ROWS,
    { cmd: '/todo', label: 'todo', desc: '待办插件命令', route: null, flag: null, category: 'todo', source: 'plugin' },
    { cmd: '/tool-x', label: 'tool-x', desc: '平台工具命令', route: 'tool x', flag: null, category: 'dev', source: 'tool' },
  ];
  const mod = loadSlashCommandSources(freshBackend({ rows }));
  const byName = new Map(mod.slashCommandItems().map((it) => [it.name, it]));

  const plugin = byName.get('/todo');
  assert.ok(plugin, '插件行必须进设置页（terminalSources 已给用户命令插件那一节）');
  assert.equal(plugin.groupKey, 'plugin', '插件行归「命令插件」组，不跟插件命名空间 category');
  assert.equal(plugin.sourceLabel, '命令插件');
  assert.notEqual(plugin.sourceLabel, 'Khy 内置', '插件行不许被标成「Khy 内置」');
  // 插件行 runnable='none'（contextFactory.js:67 route 恒 null，classifySlashRunnable 落
  // none）→ 行内说明走 none 分支，但不能顶「会话状态/交互面板」那句：插件命令是普通
  // 终端命令（_pluginHandler 经 router.js:3182 派发），把那句文案安它头上就是误分类。
  assert.match(plugin.content, /命令插件：桌面端不代执行/, '插件行的行内说明必须说明插件命令自己的形态');
  assert.doesNotMatch(plugin.content, /会话状态/, '插件命令不是会话状态/交互面板类，不得顶那句文案');

  const tool = byName.get('/tool-x');
  assert.equal(tool.groupKey, 'dev', 'tool 来源归 khy，组键随后端 category');
  assert.equal(tool.sourceLabel, 'Khy 内置');

  // builtin / tool / 未透传 source 的旧后端行一律「Khy 内置」
  assert.equal(byName.get('/model').sourceLabel, 'Khy 内置');
  // 技能行：source 'user' 与 CC 桥同源，靠 _skillDir 分开，标签一字不变
  const skill = byName.get('/commit');
  assert.equal(skill.sourceLabel, 'Khy · 技能');
  assert.equal(skill.groupKey, 'skill');
  // CC 桥行（_commandFile）仍不进设置页本路径
  assert.ok(!byName.has('/review-pr'), 'CC 桥行不得出现在设置页 khy 命令节');
});

test('G6b: slash:list 载荷里的 CC 桥行组键是 claude-code，不得落 khy 桶', async () => {
  const mod = loadSlashCommandSources(freshBackend(), CC_ROWS);
  const res = await mod.listSlashCommands();
  assert.equal(res.ok, true, res.error || '');
  const byCmd = new Map(res.commands.map((r) => [r.cmd, r]));
  // 注册表里的 CC 桥行（_commandFile → source 'claude-code'）
  assert.equal(byCmd.get('/review-pr').groupKey, 'claude-code');
  // 载荷里来自 terminalItems 的 CC 行与插件行（ccRowsFromTerminalItems 打的 source）
  assert.equal(byCmd.get('/my-cc').groupKey, 'claude-code');
  assert.equal(byCmd.get('todo').groupKey, 'plugin');
  // 对面也要钉：khy 内置行仍随后端 category，没被 source 分支抢成补丁组
  assert.equal(byCmd.get('/model').groupKey, 'model', 'khy 行的组键随后端 category，不归补丁组');
  assert.equal(byCmd.get('/study').groupKey, 'other', 'extras 行（无 category）归其它');
});

// ── G7: ARCH-209 绊线（读真源，不读夹具）──────────────────────────────────

test('G7: ARCH-209 的 12 类目键一进真源 CATEGORIES 即红，强制重裁桌面映射注记', () => {
  const realSrc = readSrc(path.join(
    '..', '..', 'runtime', 'node', 'backend', 'src', 'cli', 'commandRegistry.js'
  ));
  const literal = /const CATEGORIES = \{([\s\S]*?)\};/.exec(realSrc);
  assert.ok(literal, '真源里必须能解析出 CATEGORIES 字面量（文件被移动/改名时本绊线失效）');
  const realKeys = [...literal[1].matchAll(/^\s*([a-z-]+)\s*:/gm)].map((m) => m[1]);
  // 防空转：解析不出键时绊线等于不存在（夹具版正是这么失效的）
  assert.ok(realKeys.length >= 6, `真源 CATEGORIES 至少 6 键，实解析出 ${realKeys.length} 个`);
  const arch209 = ['dm', 'am', 'cs', 'mk', 'st', 'cv', 'rh', 'sa', 'ao', 'pl', 'ui', 'hs'];
  assert.deepEqual(
    realKeys.filter((k) => arch209.includes(k)),
    [],
    'ARCH-209 的 12 键进入 CATEGORIES 时必须重裁 slashCommandSources.ts 的映射注记'
  );
});
