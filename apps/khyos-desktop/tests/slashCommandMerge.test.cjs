'use strict';

// slashCommandMerge.test.cjs — khy 斜杠命令面接入桌面的钉住用例。
//
// 覆盖三层：
//   A. 纯逻辑行为（slashCommandMerge.ts，typescript 正规转译后直接调）——
//      分类（routed/prompt/cc/none）、别名两形态归一、别名→route 的 join 规则、
//      khy 行与 CC/插件行的「既有优先」合并。
//   B. 接线闭环 —— preload 的 invoke 与 main 的 ipcMain.handle 字面量配对
//      （desktopUiContract D6 的 slash:* 子集）；渲染层 '/' 菜单消费 slashList、
//      发送拦截存在。
//   C. 防棘轮 —— 桌面源码零硬编码斜杠命令字面量（清单全部运行时经 slash:list
//      取得）；PTY 兜底不进执行路径（评审结论：92 条 route 为空的命令里 85 条
//      在裸 shell 里敲不成立，桌面诚实降级为不渲染可点项）。
//
// runner 纪律（照 sessionLoadState.test.cjs / compactNumber.test.cjs 的成例）：
// node:test + assert/strict，绝不用裸 describe/test/expect。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const projectRoot = join(__dirname, '..');

function read(p) {
  // 去掉 BOM：部分源文件带 UTF-8 BOM，转译后会成为正文字符
  return readFileSync(p, 'utf-8').replace(/^﻿/, '');
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const ts = require('typescript');
function loadModule(relPath) {
  const js = ts.transpileModule(read(join(projectRoot, relPath)), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', 'require', js)(module.exports, module, require);
  return module.exports;
}

const {
  classifySlashRunnable,
  normalizeAliasEntry,
  aliasTermsForRow,
  mergeSlashMenuRows,
} = loadModule('src/main/slashCommandMerge.ts');

// ── A. 分类：runnable 与执行通道一一对应 ─────────────────────────────────────

test('A1: 带 route 的行 → routed', () => {
  assert.equal(
    classifySlashRunnable({ cmd: '/model', route: 'gateway model', flag: null }),
    'routed'
  );
  assert.equal(
    classifySlashRunnable({ cmd: '/memory', route: 'memory', flag: null }),
    'routed'
  );
});

test('A2: _skillDir / _commandFile 行 → prompt（REPL 同语义：正文拼成一条 AI 消息）', () => {
  assert.equal(
    classifySlashRunnable({ cmd: '/my-skill', route: null, flag: null, _skillDir: 'D:/x/skills/my-skill' }),
    'prompt'
  );
  assert.equal(
    classifySlashRunnable({ cmd: '/review-pr', route: null, flag: null, _commandFile: 'D:/x/.claude/commands/review-pr.md' }),
    'prompt'
  );
});

test('A3: flag-only 与 extras 行 → none（执行体在终端 REPL 闭包里）', () => {
  assert.equal(classifySlashRunnable({ cmd: '/models', route: null, flag: 'models' }), 'none');
  assert.equal(classifySlashRunnable({ cmd: '/thinking', route: null, flag: 'thinking' }), 'none');
  assert.equal(classifySlashRunnable({ cmd: '/new', route: null, flag: null }), 'none');
});

test('A4: 非法行 → none', () => {
  assert.equal(classifySlashRunnable(null), 'none');
  assert.equal(classifySlashRunnable({ cmd: 'model', route: 'gateway model' }), 'none');
  assert.equal(classifySlashRunnable({ cmd: '/x', route: '  ', flag: null }), 'none');
});

// ── A. 别名：两形态归一 + join 规则 ────────────────────────────────────────

test('A5: ALIAS_MAP 对象形态与 commandAutoRegistry 字符串形态都归一', () => {
  assert.deepEqual(normalizeAliasEntry('飞书', { command: 'feishu' }), {
    alias: '飞书', command: 'feishu', subCommand: '',
  });
  assert.deepEqual(normalizeAliasEntry('模型', { command: 'models', subCommand: 'list' }), {
    alias: '模型', command: 'models', subCommand: 'list',
  });
  assert.deepEqual(normalizeAliasEntry('关于', 'about'), {
    alias: '关于', command: 'about', subCommand: '',
  });
  assert.equal(normalizeAliasEntry('', { command: 'x' }), null);
  assert.equal(normalizeAliasEntry('x', { command: '' }), null);
  assert.equal(normalizeAliasEntry('x', null), null);
  assert.equal(normalizeAliasEntry('x', 42), null);
});

test('A6: join 规则 = 动词(+子命令) 对 route，join 不上就不贡献搜索词', () => {
  const aliases = [
    normalizeAliasEntry('飞书', { command: 'feishu' }),
    normalizeAliasEntry('模型', { command: 'models', subCommand: 'list' }),
    normalizeAliasEntry('项目', { command: 'project' }),
    normalizeAliasEntry('proj', 'project'),
  ];
  // 实测数据：飞书→feishu 命中 /feishu（route 'feishu'）；模型→models list 只在
  // route 精确到同一子命令时贡献 —— 斜杠面没有 route 'models list' 的行，所以
  // 「模型」实际匹配不到任何命令（数据如此，不猜）。route 只有动词时，带子命令
  // 的别名不贡献（不能确定用户的意图是哪个子命令）。
  assert.deepEqual(aliasTermsForRow('feishu', aliases), ['飞书']);
  assert.deepEqual(aliasTermsForRow('models list', aliases), ['模型']);
  assert.deepEqual(aliasTermsForRow('models', aliases), []);
  assert.deepEqual(aliasTermsForRow(null, aliases), []);
  assert.deepEqual(aliasTermsForRow('project status', aliases), ['项目', 'proj']);
  assert.deepEqual(aliasTermsForRow('project', aliases), ['项目', 'proj']);
});

test('A7: 别名去重且大小写不敏感', () => {
  const aliases = [
    normalizeAliasEntry('Term', { command: 'Gateway' }),
    normalizeAliasEntry('term', { command: 'gateway' }),
  ];
  assert.deepEqual(aliasTermsForRow('gateway status', aliases), ['Term']);
});

// ── A. 合并：既有优先，插件名参与碰撞 ─────────────────────────────────────

function row(cmd, runnable, source) {
  return { id: `id:${cmd}`, cmd, label: cmd, description: '', runnable, source, aliases: [] };
}

test('A8: primary（khy 注册表）赢碰撞，secondary（CC/插件）只补缺', () => {
  const merged = mergeSlashMenuRows(
    [row('/memory', 'routed', 'khy'), row('/model', 'routed', 'khy')],
    [row('/memory', 'cc', 'claude-code'), row('/my-cc', 'cc', 'claude-code')]
  );
  assert.deepEqual(merged.map((r) => r.cmd), ['/memory', '/model', '/my-cc']);
  assert.equal(merged[0].runnable, 'routed');
});

test('A9: 大小写不同的同名 cmd 只留一份', () => {
  const merged = mergeSlashMenuRows(
    [row('/Memory', 'routed', 'khy')],
    [row('/memory', 'cc', 'claude-code')]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].runnable, 'routed');
});

test('A10: 插件名（无 / 前缀）归一后参与碰撞，不留双份', () => {
  const merged = mergeSlashMenuRows(
    [row('/todo', 'routed', 'khy')],
    [row('todo', 'cc', 'plugin')]
  );
  assert.deepEqual(merged.map((r) => r.cmd), ['/todo']);
});

test('A11: 非法行被合并过滤', () => {
  const merged = mergeSlashMenuRows([row('/a', 'routed', 'khy')], [null, row('  ', 'cc', 'plugin')]);
  assert.deepEqual(merged.map((r) => r.cmd), ['/a']);
});

// ── B. 接线闭环 ────────────────────────────────────────────────────────────

const preloadSrc = read(join(projectRoot, 'src', 'preload', 'index.ts'));
const mainSrc = read(join(projectRoot, 'src', 'main', 'index.ts'));
const composerSrc = read(join(projectRoot, 'src', 'renderer', 'components', 'composer', 'Composer.tsx'));
const commandCenterSrc = read(join(projectRoot, 'src', 'renderer', 'components', 'message', 'CommandCenter.tsx'));
const agentItemStoreSrc = read(join(projectRoot, 'src', 'main', 'agentItemStore.ts'));
const settingsPageSrc = read(join(projectRoot, 'src', 'renderer', 'components', 'settings', 'SettingsPage.tsx'));
const slashSourcesSrc = read(join(projectRoot, 'src', 'main', 'slashCommandSources.ts'));

test('B1: preload 暴露 slashList/slashRun，通道名与 main handle 配对（D6 子集）', () => {
  assert.match(preloadSrc, /slashList: \(\) => ipcRenderer\.invoke\('slash:list'\)/);
  assert.match(preloadSrc, /slashRun: \(cmd: string, args\?: string\) => ipcRenderer\.invoke\('slash:run', cmd, args \|\| ''\)/);
  assert.match(mainSrc, /ipcMain\.handle\('slash:list'/);
  assert.match(mainSrc, /ipcMain\.handle\('slash:run'/);
});

test('B2: 渲染层 / 菜单消费 slashList，发送拦截存在', () => {
  assert.match(composerSrc, /slashList\?\.\(\)/, "Composer '/' 分类必须走 slashList");
  assert.match(composerSrc, /interceptSlashSend/, '发送拦截必须存在');
  assert.match(composerSrc, /runSlashToSession/, 'routed 命令必须经 runSlashToSession 回填会话');
  assert.match(composerSrc, /item\.runnable !== 'none'/, "菜单必须滤掉无通道命令（不渲染假按钮）");
});

test('B3: CommandCenter 增补 khy 命令组，只收 routed 行', () => {
  assert.match(commandCenterSrc, /callSlashList/, 'CommandCenter 必须走 slashList 取清单');
  assert.match(commandCenterSrc, /runnable !== 'routed'/, '只有 routed 行进面板');
  assert.match(commandCenterSrc, /Khy 命令/, '必须有独立分组');
});

test('B4: 设置页「命令」页接入 khy 命令面（只读行，不重复 CC 桥行）', () => {
  assert.match(agentItemStoreSrc, /slashCommandItems/, 'agentItemStore 必须引入 khy 命令面');
  assert.match(agentItemStoreSrc, /kind === 'command'/, '只合并 command kind');
  assert.match(slashSourcesSrc, /export function slashCommandItems/, 'slashCommandSources 必须导出行整形');
  assert.match(slashSourcesSrc, /readOnly: true/, 'khy 行只读（不可启停不可删）');
  assert.match(
    slashSourcesSrc,
    /row\.source !== 'khy' && row\.source !== 'khy-skill'/,
    'CC 桥/插件行不在本路径重复（listCommands 已给那一节）'
  );
  assert.match(settingsPageSrc, /Khy 终端内置命令/, '设置页文案必须与事实一致（不再只说 .claude/commands）');
});

// ── C. 防棘轮 ──────────────────────────────────────────────────────────────

test('C1: 桌面源码零硬编码斜杠命令字面量（清单全部运行时取得）', () => {
  const files = [
    'src/main/index.ts',
    'src/main/slashCommandMerge.ts',
    'src/main/slashCommandSources.ts',
    'src/main/agentItemStore.ts',
    'src/preload/index.ts',
    'src/renderer/utils/slashRun.ts',
    'src/renderer/components/composer/Composer.tsx',
    'src/renderer/components/message/CommandCenter.tsx',
  ];
  const hits = [];
  for (const rel of files) {
    const code = stripComments(read(join(projectRoot, rel)));
    // 形如 '/word' 的引号字符串：命令字面量的唯一形态。'/'、'#'、'$'、'#hash'、
    // namespace:action 通道名都不带斜杠后跟字母，不命中。
    const found = code.match(/['"`]\/[a-z][a-z0-9-]*['"`]/gi) || [];
    for (const h of found) hits.push(`${rel}: ${h}`);
  }
  assert.deepEqual(hits, [], `不得出现硬编码斜杠命令：\n${hits.join('\n')}`);
});

test('C2: PTY 兜底不进执行路径（诚实降级：无通道命令不执行）', () => {
  const sources = stripComments(read(join(projectRoot, 'src', 'main', 'slashCommandSources.ts')));
  assert.doesNotMatch(sources, /ptyWrite|pty:write|ptyHost/);
  assert.match(sources, /no-channel/, '必须有无通道的诚实降级分支');
});

test('C3: slash:run 落审计（渲染层可触发后端命令执行的面必须有台账）', () => {
  const sources = stripComments(read(join(projectRoot, 'src', 'main', 'slashCommandSources.ts')));
  assert.match(sources, /slash_command_audit\.jsonl/);
  assert.match(sources, /argsLen/, '审计只记参数长度，不记参数原文');
});
