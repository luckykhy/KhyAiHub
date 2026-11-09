'use strict';

// sessionLoadState.test.cjs — 会话加载状态机（骨架屏失败路径）的钉住用例。
//
// 背景：本仓库是 Electron 应用，没有 jsdom / testing-library，React hook 渲染
// 不可测（没有 DOM 测试环境，也不允许新增依赖）。因此可测部分下沉为**纯逻辑**：
//   · messageSlice 的 reducer（发起 / 成功 / 失败 三态转移）
//   · sessionLoad.ts 的视图判定 resolveMessageAreaView（消息区该渲染什么）
//   · sessionLoad.ts 的错误文案 describeSessionLoadError（失败怎么呈现）
//   · App.tsx / MessageBubble.tsx 的接线契约（源码级断言，见文末 D 段）
// 没测的：骨架泡在真实 DOM 里的渲染、React 组件的实际重渲染时序、IPC 真实往返。
//
// runner 纪律（照 sidebarProjectClassify.test.cjs:11-31 的成例）：本文件用
// node:test 写、放在 tests/ 下安全。绝不用裸 describe/test/expect —— 那是
// jest 风格，会被 node --test 扫走并炸在「describe is not defined」。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ts = require('typescript');

const projectRoot = join(__dirname, '..');
const slicePath = join(projectRoot, 'src', 'renderer', 'state', 'messageSlice.ts');
const signalPath = join(projectRoot, 'src', 'renderer', 'components', 'message', 'sessionLoad.ts');
const appPath = join(projectRoot, 'src', 'renderer', 'App.tsx');
const listPath = join(projectRoot, 'src', 'renderer', 'components', 'message', 'MessageBubble.tsx');

function read(p) {
  // 去掉 BOM：部分源文件带 UTF-8 BOM，转译后会成为正文字符
  return readFileSync(p, 'utf-8').replace(/^﻿/, '');
}

// 只留代码、去掉注释：有些断言是「旧实现不得残留」，而旧实现的**说明文字**
// 仍留在注释里（那是刻意保留的设计沿革）。对注释做 doesNotMatch 会误报。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

// 用仓里现成的 TypeScript 5.9.3 做正规转译求值 —— 不要用正则剥类型注解，那是猜。
function transpile(src) {
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function loadCjs(src, stubs) {
  const js = transpile(src);
  const module = { exports: {} };
  const req = (id) => (stubs && Object.prototype.hasOwnProperty.call(stubs, id) ? stubs[id] : require(id));
  new Function('exports', 'module', 'require', js)(module.exports, module, req);
  return module.exports;
}

// ── 被测模块 ────────────────────────────────────────────────────

// messageSlice 只依赖 @reduxjs/toolkit（真实 require，Node 侧可用）
const slice = loadCjs(read(slicePath));
const reducer = slice.default;
const {
  sessionLoadStarted, sessionLoadSucceeded, sessionLoadFailed,
  setMessages, setCurrentSession, clearMessages,
} = slice;

// sessionLoad.ts 只依赖 store 的 useAppSelector（React 绑定）——纯函数部分
// 与 React 无关，桩掉这个绑定即可在不装 DOM 环境的前提下求值。
const signal = loadCjs(read(signalPath), {
  '../../state/store': { useAppSelector: () => undefined },
});
const { resolveMessageAreaView, shouldKeepMessagesOnFailure, describeSessionLoadError, SESSION_LOAD_TIMEOUT_MS } = signal;

const appSrc = read(appPath);
const listSrc = read(listPath);

const initial = () => reducer(undefined, { type: '@@INIT' });

// ── A. 状态机：发起 → 成功 ──────────────────────────────────────

test('发起加载：isLoadingSession 置位，错误位清空', () => {
  const s = reducer(initial(), sessionLoadStarted());
  assert.strictEqual(s.isLoadingSession, true, '发起后必须处于加载中');
  assert.strictEqual(s.sessionLoadError, null, '发起时不应残留旧错误');
});

test('发起 → 成功：加载位复位，消息数组换新，错误位为空', () => {
  let s = reducer(initial(), sessionLoadStarted());
  s = reducer(s, setMessages({
    sessionId: 's1',
    messages: [{ id: 'h_s1_0', role: 'user', content: '你好', timestamp: 1, status: 'complete' }],
  }));
  s = reducer(s, sessionLoadSucceeded());
  assert.strictEqual(s.isLoadingSession, false, '成功后必须复位加载位（否则骨架悬空）');
  assert.strictEqual(s.sessionLoadError, null);
  assert.strictEqual(s.messages.length, 1);
  assert.strictEqual(s.messages[0].content, '你好');
  assert.strictEqual(s.messagesSessionId, 's1', '内容归属会话必须被记录（失败态据此决定保留/隐藏）');
  // 视图判定：成功落地 → 消息列表
  assert.strictEqual(
    resolveMessageAreaView({ isLoading: s.isLoadingSession, error: s.sessionLoadError, messageCount: s.messages.length }),
    'list',
  );
});

test('发起 → 成功（会话本身为空）：仍然复位加载位，落到空态而非骨架', () => {
  let s = reducer(initial(), sessionLoadStarted());
  s = reducer(s, setMessages({ sessionId: 's1', messages: [] }));
  s = reducer(s, sessionLoadSucceeded());
  assert.strictEqual(s.isLoadingSession, false);
  assert.strictEqual(
    resolveMessageAreaView({ isLoading: s.isLoadingSession, error: s.sessionLoadError, messageCount: s.messages.length }),
    'empty',
  );
});

// ── B. 状态机：发起 → 失败 ──────────────────────────────────────

test('发起 → 失败：加载位复位，失败信息落到 sessionLoadError（用户可见）', () => {
  let s = reducer(initial(), sessionLoadStarted());
  assert.strictEqual(s.isLoadingSession, true);
  s = reducer(s, sessionLoadFailed({ sessionId: 's1', reason: '会话内容读取失败：host 进程无响应，请重启应用' }));
  assert.strictEqual(s.isLoadingSession, false, '失败也必须复位加载位');
  assert.ok(s.sessionLoadError, '失败信息必须存在');
  assert.strictEqual(s.sessionLoadError.sessionId, 's1');
  assert.strictEqual(s.sessionLoadError.reason, '会话内容读取失败：host 进程无响应，请重启应用');
  // 失败不能只剩空态：视图判定必须落在 error 分支
  assert.strictEqual(
    resolveMessageAreaView({ isLoading: s.isLoadingSession, error: s.sessionLoadError, messageCount: s.messages.length }),
    'error',
  );
});

test('失败原因不能为空串（空错误会渲染成没有原因的失败态）', () => {
  const s = reducer(initial(), sessionLoadFailed({ sessionId: 's1', reason: '' }));
  assert.strictEqual(s.isLoadingSession, false);
  assert.ok(s.sessionLoadError.reason.length > 0, '空原因必须被兜底成可读文本');
});

test('失败 → 重新发起：上轮错误被清掉（新骨架不再叠加旧错误）', () => {
  let s = reducer(initial(), sessionLoadFailed({ sessionId: 's1', reason: '上一次失败' }));
  s = reducer(s, sessionLoadStarted());
  assert.strictEqual(s.isLoadingSession, true);
  assert.strictEqual(s.sessionLoadError, null);
  assert.strictEqual(
    resolveMessageAreaView({ isLoading: s.isLoadingSession, error: s.sessionLoadError, messageCount: 0 }),
    'loading',
  );
});

test('新建任务（clearMessages）复位加载位与错误位', () => {
  let s = reducer(initial(), sessionLoadStarted());
  s = reducer(s, sessionLoadFailed({ sessionId: 's1', reason: '失败' }));
  s = reducer(s, clearMessages());
  assert.strictEqual(s.isLoadingSession, false);
  assert.strictEqual(s.sessionLoadError, null);
  assert.strictEqual(s.messagesSessionId, null);
  assert.strictEqual(s.messages.length, 0);
});

// ── C. 启动自动选中不产生骨架 ───────────────────────────────────

test('启动自动选中（只有 setCurrentSession，没有发起加载）→ 不进入加载态', () => {
  // AppLayout 启动时拉到任务列表后 dispatch(setCurrentSession(id))，不伴随
  // 内容加载（没有 sessionLoadStarted）——此时不得亮骨架。
  const s = reducer(initial(), setCurrentSession('sess_startup'));
  assert.strictEqual(s.currentSessionId, 'sess_startup');
  assert.strictEqual(s.isLoadingSession, false, '仅选中会话不构成加载');
  assert.strictEqual(
    resolveMessageAreaView({ isLoading: s.isLoadingSession, error: s.sessionLoadError, messageCount: s.messages.length }),
    'empty',
  );
});

// ── D. 视图判定优先级 ───────────────────────────────────────────

test('视图判定优先级：loading > error > empty/list', () => {
  const err = { sessionId: 's1', reason: '挂了' };
  assert.strictEqual(resolveMessageAreaView({ isLoading: true, error: err, messageCount: 3 }), 'loading');
  assert.strictEqual(resolveMessageAreaView({ isLoading: false, error: err, messageCount: 0 }), 'error');
  assert.strictEqual(resolveMessageAreaView({ isLoading: false, error: err, messageCount: 3 }), 'error');
  assert.strictEqual(resolveMessageAreaView({ isLoading: false, error: null, messageCount: 0 }), 'empty');
  assert.strictEqual(resolveMessageAreaView({ isLoading: false, error: null, messageCount: 2 }), 'list');
});

test('失败时内容去留：重载本会话失败 → 保留；切换会话失败 → 隐藏陈旧内容', () => {
  // 重载 s1 失败：屏幕上的内容属于 s1（最后一份已知良好内容）→ 保留
  assert.strictEqual(
    shouldKeepMessagesOnFailure({ sessionId: 's1', reason: 'x' }, 's1'),
    true,
  );
  // 切到 s2 失败：屏幕上是 s1 的陈旧内容 → 隐藏
  assert.strictEqual(
    shouldKeepMessagesOnFailure({ sessionId: 's2', reason: 'x' }, 's1'),
    false,
  );
  // 没有会话内容（首页）→ 无内容可保留
  assert.strictEqual(shouldKeepMessagesOnFailure({ sessionId: 's1', reason: 'x' }, null), false);
  // 没有失败 → 不适用
  assert.strictEqual(shouldKeepMessagesOnFailure(null, 's1'), false);
});

// ── E. 失败文案（错误怎么呈现）──────────────────────────────────

test('describeSessionLoadError：无错误 → null（不渲染错误面板）', () => {
  assert.strictEqual(describeSessionLoadError(null), null);
  assert.strictEqual(describeSessionLoadError(''), null);
});

test('describeSessionLoadError：普通失败给出标题 + 原始原因 + 修复指引', () => {
  const d = describeSessionLoadError('会话内容读取失败：host 进程无响应，请重启应用');
  assert.ok(d, '应给出错误描述');
  assert.strictEqual(d.title, '会话内容加载失败');
  assert.strictEqual(d.detail, '会话内容读取失败：host 进程无响应，请重启应用', '原始原因不得丢失');
  assert.match(d.hint, /重试/);
});

test('describeSessionLoadError：超时有独立措辞（不是普通失败）', () => {
  const d = describeSessionLoadError('会话内容加载超时（15 秒无响应）');
  assert.ok(d);
  assert.strictEqual(d.title, '会话内容加载超时');
  assert.match(d.hint, /超时/);
});

// ── F. 接线契约（源码级）────────────────────────────────────────

test('App.tsx：发起时置位，成功与失败都复位（唯一真源在 messageSlice）', () => {
  assert.match(appSrc, /store\.dispatch\(sessionLoadStarted\(\)\)/, '发起加载必须 dispatch(sessionLoadStarted())');
  assert.match(appSrc, /store\.dispatch\(sessionLoadSucceeded\(\)\)/, '成功路径必须 dispatch(sessionLoadSucceeded())');
  assert.match(appSrc, /store\.dispatch\(sessionLoadFailed\(/, '失败路径必须 dispatch(sessionLoadFailed(...))');
  // 置位必须早于真正的加载调用
  const startedAt = appSrc.indexOf('sessionLoadStarted()');
  const callAt = appSrc.indexOf('api.loadSession(sessionId)');
  assert.ok(startedAt > -1 && callAt > -1 && startedAt < callAt, '必须先置位再发起加载');
});

test('App.tsx：两条失败分支（!ok 早退 与 catch）都走同一条失败收尾', () => {
  const notOk = appSrc.match(/if \(!res\?\.ok\) \{[\s\S]*?\n {6}\}/);
  assert.ok(notOk, '应能定位 !res.ok 分支');
  assert.match(notOk[0], /fail\(/, '!res.ok 分支必须调用 fail()（置错误位 + 提示）');
  const catchBlock = appSrc.match(/\}\)\.catch\(\(err: unknown\) => \{[\s\S]*?\n {4}\}\)/);
  assert.ok(catchBlock, '应能定位 catch 分支');
  assert.match(catchBlock[0], /fail\(/, 'catch 分支必须调用 fail()');
  // fail() 本体必须真的写错误位
  const failDef = appSrc.match(/const fail = \(reason: string\) => \{[\s\S]*?\n {4}\}/);
  assert.ok(failDef, '应能定位 fail() 定义');
  assert.match(failDef[0], /sessionLoadFailed\(\{ sessionId, reason \}\)/, 'fail() 必须 dispatch(sessionLoadFailed({ sessionId, reason }))');
});

test('App.tsx：超时安全网存在且正常路径会清掉（clearTimeout），不是靠它收摊', () => {
  assert.match(appSrc, /SESSION_LOAD_TIMEOUT_MS/, 'App 必须使用统一的安全网常量');
  assert.match(appSrc, /window\.setTimeout\(/, '安全网必须是一个真实定时器');
  assert.match(appSrc, /window\.clearTimeout\(timer\)/, '落地路径必须清掉定时器（正常路径不依赖它）');
  assert.ok(SESSION_LOAD_TIMEOUT_MS >= 10000, '安全网不应短于 10 秒（正常加载不应被误杀）');
});

test('sessionLoad.ts：指针时间戳启发式与 5 秒兜底已删除（不再有第二个真源）', () => {
  const src = read(signalPath);
  const code = stripComments(src);
  assert.doesNotMatch(code, /pointerdown/, '不得再用指针交互时间戳推断加载态');
  assert.doesNotMatch(code, /lastPointerAt/, '不得再用指针交互时间戳推断加载态');
  assert.doesNotMatch(code, /USER_INTENT_WINDOW_MS/, '不得保留用户意图时间窗启发式');
  assert.doesNotMatch(code, /LOADING_TIMEOUT_MS/, '不得保留旧的 5 秒兜底常量');
  assert.doesNotMatch(code, /setTimeout/, 'sessionLoad.ts 不应自己计时（复位由发起方负责）');
  assert.match(src, /isLoadingSession/, '必须直读 messageSlice 的加载位');
  assert.match(src, /sessionLoadError/, '必须直读 messageSlice 的失败位');
});

test('MessageBubble.tsx：消息区消费真源并渲染显式错误态（不只剩空态）', () => {
  assert.match(listSrc, /useSessionLoadSignal/, '必须消费加载信号');
  assert.match(listSrc, /useSessionLoadError/, '必须消费失败原因');
  assert.match(listSrc, /resolveMessageAreaView/, '分支判定必须走纯函数（可测）');
  assert.match(listSrc, /view === 'error'/, '必须有 error 分支');
  assert.match(listSrc, /重试/, '错误态必须给出重试入口');
  assert.match(listSrc, /describeSessionLoadError/, '错误文案必须走纯函数映射');
  assert.match(listSrc, /shouldKeepMessagesOnFailure/, '内容去留必须走纯函数（可测）');
  assert.match(listSrc, /useMessagesSessionId/, '必须读内容归属会话（判断陈旧内容）');
});
