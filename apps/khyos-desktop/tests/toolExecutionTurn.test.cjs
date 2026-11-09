'use strict';

// toolExecutionTurn.test.cjs — 工具执行过程「归属到本轮提问」的契约。
//
// 用户报障：工具执行块显示在提问的上方，并且切换会话后仍跟着显示。根因是
// 这块 UI 与数据都是全局的 —— 面板挂在消息列表上方，executions 是一条扁平
// 数组，只在「下一条发送」时清空，切换会话不清空。
//
// 本文件钉住修复后的契约：
//   (a) 每轮提问开局登记归属（beginToolTurn），执行统一盖章 messageId；
//   (b) 过程按会话累积：换轮不清历史，只清「本轮文件改动」；没收敛的执行标取消；
//   (c) 没有归属的执行（messageId 为空）任何消息都不认领；
//   (d) 切换会话 / 新建任务清空执行与文件改动；
//   (e) 面板按 messageId 过滤，渲染在对应消息内部，不再是全局块。
//
// 风格照 sessionLoadState.test.cjs：用仓里的 typescript 转译求值 reducer，
// 组件接线用源码级断言（本仓无 jsdom，也不为此新增依赖）。
// runner 纪律：node:test；绝不用裸 describe/test/expect（会被 node --test 扫走）。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

const projectRoot = join(__dirname, '..');
const slicePath = join(projectRoot, 'src', 'renderer', 'state', 'toolExecutionSlice.ts');
const panelPath = join(projectRoot, 'src', 'renderer', 'components', 'message', 'ToolExecutionPanel.tsx');
const bubblePath = join(projectRoot, 'src', 'renderer', 'components', 'message', 'MessageBubble.tsx');
const appPath = join(projectRoot, 'src', 'renderer', 'App.tsx');
const composerPath = join(projectRoot, 'src', 'renderer', 'components', 'composer', 'Composer.tsx');

function read(p) {
  // 去掉 BOM：部分源文件带 UTF-8 BOM，转译后会成为正文字符
  return readFileSync(p, 'utf-8').replace(/^﻿/, '');
}

// 只留代码、去掉注释：断言里有「旧实现不得残留」，而旧实现的说明文字仍留在
// 注释里（那是刻意保留的设计沿革），对注释断言会误报。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

// 用仓里现成的 TypeScript 做正规转译求值 —— 不要用正则剥类型注解，那是猜。
function loadCjs(src) {
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', 'require', js)(module.exports, module, require);
  return module.exports;
}

// ── 被测模块：toolExecutionSlice 只依赖 @reduxjs/toolkit（Node 侧可真实 require）──
const slice = loadCjs(read(slicePath));
const reducer = slice.default;
const {
  beginToolTurn,
  startToolExecution,
  updateToolExecution,
  cancelToolExecution,
  recordAffectedFiles,
  clearExecutions,
  hydrateToolExecutions,
} = slice;

const initial = () => reducer(undefined, { type: '@@INIT' });
const call = (id, name = 'webSearch') => ({ id, name, input: { q: 'news' }, requiresConfirmation: false });

// ── A. 归属：执行要挂在「产生它的那一轮提问」下 ──────────────────

test('开局登记归属：beginToolTurn 记下本轮消息 id，清本轮文件改动，保留历史过程', () => {
  let s = reducer(initial(), beginToolTurn({ messageId: 'a_1' }));
  s = reducer(s, startToolExecution(call('c1')));
  s = reducer(s, recordAffectedFiles(['a.ts']));

  assert.strictEqual(s.executions.length, 1);
  assert.strictEqual(s.executions[0].messageId, 'a_1', '执行必须盖章本轮消息 id');
  assert.deepStrictEqual(s.affectedFiles, ['a.ts']);

  s = reducer(s, beginToolTurn({ messageId: 'a_2' }));
  assert.strictEqual(s.executions.length, 1, '新一轮提问不得抹掉上一轮的过程（它要留在上一条提问下面）');
  assert.strictEqual(s.executions[0].messageId, 'a_1', '上一轮的执行仍归属上一轮');
  assert.deepStrictEqual(s.affectedFiles, [], '「本轮文件改动」只算本轮，换轮即清');
  assert.strictEqual(s.turnMessageId, 'a_2');

  s = reducer(s, startToolExecution(call('c2')));
  assert.deepStrictEqual(s.executions.map((e) => e.messageId), ['a_1', 'a_2'], '两轮各自归属，互不覆盖');
});

test('上一轮没收尾的执行在换轮时标成已取消，不留「正在执行」假象', () => {
  let s = reducer(initial(), beginToolTurn({ messageId: 'a_1' }));
  s = reducer(s, startToolExecution(call('c1')));
  assert.deepStrictEqual(s.activeIds, ['c1']);

  s = reducer(s, beginToolTurn({ messageId: 'a_2' }));
  assert.deepStrictEqual(s.activeIds, [], 'activeIds 必须清空，否则旧卡片一直转圈');
  assert.strictEqual(s.executions[0].status, 'cancelled');
  assert.strictEqual(s.executions[0].completedAt > 0, true);
});

test('没有登记归属的执行盖章空串，任何消息都不认领', () => {
  const s = reducer(initial(), startToolExecution(call('c1')));
  assert.strictEqual(
    s.executions[0].messageId,
    '',
    '无归属的执行必须能被渲染层排除，不能默认挂到某条消息（那正是跨会话显示的成因）'
  );
});

test('同一轮内多条执行共享归属：结果/取消不改变归属', () => {
  let s = reducer(initial(), beginToolTurn({ messageId: 'a_1' }));
  s = reducer(s, startToolExecution(call('c1')));
  s = reducer(s, startToolExecution(call('c2', 'read_file')));
  s = reducer(s, updateToolExecution({ id: 'c1', status: 'success', result: 'ok' }));
  s = reducer(s, cancelToolExecution('c2'));

  assert.deepStrictEqual(s.executions.map((e) => e.messageId), ['a_1', 'a_1']);
  assert.strictEqual(s.executions[0].status, 'success');
  assert.strictEqual(s.executions[1].status, 'cancelled');
  assert.strictEqual(s.activeIds.length, 0);
  assert.strictEqual(s.executions[1].completedAt > 0, true);
});

test('切换会话 / 新建任务（clearExecutions）连归属一起清掉', () => {
  let s = reducer(initial(), beginToolTurn({ messageId: 'a_1' }));
  s = reducer(s, startToolExecution(call('c1')));
  s = reducer(s, beginToolTurn({ messageId: 'a_2' }));
  s = reducer(s, startToolExecution(call('c2')));
  s = reducer(s, clearExecutions());

  assert.strictEqual(s.executions.length, 0);
  assert.strictEqual(s.activeIds.length, 0);
  assert.deepStrictEqual(s.affectedFiles, []);
  assert.strictEqual(s.turnMessageId, null, '归属不得残留：残留会把迟到事件盖到已消失的会话上');
});

// ── B. 重开旧会话：存档里的过程按归属灌回 ─────────────────────

const persistedCall = (id, messageId, extra = {}) => ({
  id,
  name: 'webSearch',
  input: { query: 'x' },
  status: 'success',
  result: 'ok',
  startedAt: 1700000000000,
  requiresConfirmation: false,
  messageId,
  ...extra,
});

test('hydrate 用存档里的过程替换执行列表，归属与状态原样保留', () => {
  let s = reducer(initial(), beginToolTurn({ messageId: 'a_1' }));
  s = reducer(s, startToolExecution(call('c_live')));
  s = reducer(s, recordAffectedFiles(['a.ts']));

  s = reducer(s, hydrateToolExecutions([
    persistedCall('h_s1_1_tool_0', 'h_s1_1'),
    persistedCall('h_s1_3_tool_0', 'h_s1_3', { name: 'bash', status: 'cancelled', result: undefined }),
  ]));

  assert.deepStrictEqual(
    s.executions.map((e) => e.id),
    ['h_s1_1_tool_0', 'h_s1_3_tool_0'],
    '加载会话后只剩存档里的过程，不留内存里的旧执行'
  );
  assert.deepStrictEqual(s.executions.map((e) => e.messageId), ['h_s1_1', 'h_s1_3']);
  assert.strictEqual(s.executions[1].status, 'cancelled');
  assert.deepStrictEqual(s.activeIds, [], '历史调用没有「进行中」');
  assert.strictEqual(s.turnMessageId, null);
  assert.deepStrictEqual(s.affectedFiles, [], '文件改动是「本轮」的东西，不随历史灌回');
});

test('hydrate 之后继续提问：新执行追加在历史之后，旧过程不被覆盖', () => {
  let s = reducer(initial(), hydrateToolExecutions([persistedCall('h_s1_1_tool_0', 'h_s1_1')]));
  s = reducer(s, beginToolTurn({ messageId: 'a_9' }));
  s = reducer(s, startToolExecution(call('c_new')));

  assert.deepStrictEqual(
    s.executions.map((e) => e.id),
    ['h_s1_1_tool_0', 'c_new'],
    '历史过程要留在它自己的提问下面，新一轮只能追加'
  );
  assert.strictEqual(s.executions[1].messageId, 'a_9');
});

test('hydrate 也守 MAX_EXECUTIONS：老会话的调用再多，状态也只留最近 300 条', () => {
  const many = Array.from({ length: 305 }, (_, i) => persistedCall(`h_tool_${i}`, `h_m_${i}`));
  const s = reducer(initial(), hydrateToolExecutions(many));

  assert.strictEqual(s.executions.length, 300, '在线累积有上限，历史灌回不能绕过它');
  assert.strictEqual(s.executions[0].id, 'h_tool_5', '超限时丢最早的，保留最近的过程');
  assert.strictEqual(s.executions.at(-1).id, 'h_tool_304');
});

// ── C. 接线：面板在消息内部、按归属过滤、会话切换清零 ────────────

const panelCode = stripComments(read(panelPath));
const bubbleCode = stripComments(read(bubblePath));
const appCode = stripComments(read(appPath));
const composerCode = stripComments(read(composerPath));

test('面板不再是全局块：App 里既无全局挂载，也无顶层 lazy 定义', () => {
  assert.doesNotMatch(appCode, /<ToolExecutionPanel\s*\/>/, '全局挂载会让过程停在消息列表上方、与提问不对应');
  assert.doesNotMatch(appCode, /const ToolExecutionPanel = lazy/, '面板已随 MessageBubble 动态加载');
});

test('面板按 messageId 过滤，且只认领非空归属', () => {
  assert.match(panelCode, /function ToolExecutionPanel\(\{ messageId \}/, '面板必须接收归属消息 id');
  assert.match(panelCode, /e\.messageId === messageId/, '只渲染属于本条消息的执行');
});

test('消息气泡内渲染工具过程，并以 messageId 作为门控', () => {
  assert.match(bubbleCode, /<ToolExecutionPanel messageId=\{message\.id\} \/>/, '过程必须渲染在对应消息内部');
  assert.match(bubbleCode, /e\.messageId === message\.id/, '没有本条消息的执行时不渲染空壳');
});

test('发送时登记本轮归属；会话加载与新建任务清空执行', () => {
  assert.match(composerCode, /beginToolTurn\(\{ messageId: assistantId \}\)/, '发送时必须登记本轮的助手消息 id');
  assert.doesNotMatch(composerCode, /clearExecutions/, '清空不应发生在发送路径的旧接线上');

  const clears = appCode.match(/store\.dispatch\(clearExecutions\(\)\)/g) || [];
  assert.ok(clears.length >= 2, `会话加载与新建任务都必须清空执行（实测 ${clears.length} 处）`);
});

test('会话加载完成后把存档里的过程灌回面板，归属指向恢复出的助手消息', () => {
  assert.match(appCode, /store\.dispatch\(hydrateToolExecutions\(restoredTools\)\)/, '加载成功后必须灌回执行');
  assert.ok(
    appCode.includes('messageId: `h_${sessionId}_${i}`'),
    '归属必须指向恢复消息的 id，否则面板认领不到'
  );
  assert.match(appCode, /m\.tools \|\| \[\]/, '存档消息的工具过程来自 host 的 tools 字段');
});
