'use strict';

// sessionListLoad.test.cjs —— 侧栏会话列表加载状态机 + 分组接线契约的钉住用例。
//
// 背景：侧栏此前是「挂载时拉一次，拉不到就摆错误态」—— 一次失败就把整个侧栏
// 变成死画面，既不重试也没有重试入口（用户实测：会话列表总是加载失败）。
// 消息区早就有同款状态机（tests/sessionLoadState.test.cjs），侧栏这次补上同一
// 套形状，本文件把它钉住。
//
// runner 纪律（照 sessionLoadState.test.cjs:11-31 的成例）：用 node:test，
// 放在 tests/ 下安全。绝不用裸 describe/test/expect。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ts = require('typescript');

const projectRoot = join(__dirname, '..');
const listPath = join(projectRoot, 'src', 'renderer', 'components', 'layout', 'sessionListLoad.ts');
const appLayoutPath = join(projectRoot, 'src', 'renderer', 'components', 'layout', 'AppLayout.tsx');
const sidebarPath = join(projectRoot, 'src', 'renderer', 'components', 'layout', 'WorkspaceSidebar.tsx');
const preloadPath = join(projectRoot, 'src', 'preload', 'index.ts');
const mainPath = join(projectRoot, 'src', 'main', 'index.ts');
const hostPath = join(projectRoot, 'src', 'host', 'index.ts');

function read(p) {
  return readFileSync(p, 'utf-8').replace(/^﻿/, '');
}

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

const list = loadCjs(read(listPath));
const {
  resolveSessionListView,
  describeSessionListError,
  describeSessionListEmpty,
  nextRetryDelay,
  resolveSessionTitle,
  SESSION_LIST_RETRY_DELAYS_MS,
  SESSION_LIST_TIMEOUT_MS,
} = list;

const appLayoutSrc = read(appLayoutPath);
const sidebarSrc = read(sidebarPath);
const preloadSrc = read(preloadPath);
const mainSrc = read(mainPath);
const hostSrc = read(hostPath);

// ── A. 视图判定：已有列表 > 加载中 > 错误 > 空态 ────────────────────

test('视图判定：已有列表时优先显示列表（刷新失败不清空已知内容）', () => {
  assert.strictEqual(
    resolveSessionListView({ loading: false, error: '读取失败', taskCount: 12, searching: false }),
    'list',
    '刷新失败时必须保留上一次的好列表'
  );
  assert.strictEqual(
    resolveSessionListView({ loading: true, error: null, taskCount: 3, searching: false }),
    'list',
  );
});

test('视图判定：没有任何列表时按 加载中 > 错误 > 空态 判定', () => {
  assert.strictEqual(
    resolveSessionListView({ loading: true, error: null, taskCount: 0, searching: false }),
    'loading'
  );
  assert.strictEqual(
    resolveSessionListView({ loading: false, error: '读取失败', taskCount: 0, searching: false }),
    'error'
  );
  assert.strictEqual(
    resolveSessionListView({ loading: false, error: null, taskCount: 0, searching: false }),
    'empty'
  );
  assert.strictEqual(
    resolveSessionListView({ loading: false, error: null, taskCount: 0, searching: true }),
    'empty'
  );
});

test('错误态优先于加载态之外的判定（失败必须显式呈现，不能只剩空态）', () => {
  // 旧实现的形状：失败后只显示「还没有任务」空态，用户以为没有会话。
  const view = resolveSessionListView({ loading: false, error: 'host 进程无响应', taskCount: 0, searching: false });
  assert.strictEqual(view, 'error');
});

// ── B. 错误文案 ──────────────────────────────────────────────────────

test('describeSessionListError：无错误 → null', () => {
  assert.strictEqual(describeSessionListError(null), null);
  assert.strictEqual(describeSessionListError(''), null);
});

test('describeSessionListError：普通失败给标题 + 原始原因 + 重试指引', () => {
  const d = describeSessionListError('会话列表读取失败：会话库不可读，请检查数据目录权限');
  assert.ok(d, '应给出错误描述');
  assert.strictEqual(d.title, '会话列表加载失败');
  assert.strictEqual(d.detail, '会话列表读取失败：会话库不可读，请检查数据目录权限', '原始原因不得丢失');
  assert.match(d.hint, /重试/);
});

test('describeSessionListError：超时有独立措辞（不是普通失败）', () => {
  const d = describeSessionListError('会话列表读取超时：host 进程 25 秒无响应');
  assert.ok(d);
  assert.strictEqual(d.title, '会话列表加载超时');
  assert.match(d.hint, /超时|无响应/);
});

// ── C. 重试节奏 ──────────────────────────────────────────────────────

test('重试：退避递增，超过次数就不再自动重试（交给用户点「重试」）', () => {
  const delays = SESSION_LIST_RETRY_DELAYS_MS;
  assert.ok(delays.length >= 2, '至少要自动重试两次');
  for (let i = 1; i < delays.length; i++) {
    assert.ok(delays[i] > delays[i - 1], '重试间隔必须递增（退避）');
  }
  assert.strictEqual(nextRetryDelay(0), delays[0]);
  assert.strictEqual(nextRetryDelay(delays.length - 1), delays[delays.length - 1]);
  assert.strictEqual(nextRetryDelay(delays.length), null, '超过次数必须返回 null');
  assert.strictEqual(nextRetryDelay(-1), null);
});

test('安全网超时不得短于 10 秒（正常加载不该被误杀）', () => {
  assert.ok(SESSION_LIST_TIMEOUT_MS >= 10000, `安全网过短：${SESSION_LIST_TIMEOUT_MS}`);
});

// ── D. 标题兜底 ──────────────────────────────────────────────────────

test('resolveSessionTitle：占位标题用首条用户消息顶上，超长截断加省略号', () => {
  assert.strictEqual(
    resolveSessionTitle({ title: '(untitled)', firstUserMessage: '今天有什么新闻' }),
    '今天有什么新闻'
  );
  const long = 'x'.repeat(60);
  const out = resolveSessionTitle({ title: '(untitled)', firstUserMessage: long });
  assert.strictEqual(out.length, 41, '应截断到 40 字 + 省略号');
  assert.ok(out.endsWith('…'));
});

test('resolveSessionTitle：真实标题优先；两者皆空也要给可读兜底', () => {
  assert.strictEqual(resolveSessionTitle({ title: '真实标题', firstUserMessage: '首条' }), '真实标题');
  assert.strictEqual(resolveSessionTitle({}), '未命名会话');
});

test('resolveSessionTitle：空白的占位标题也要被当成未命名', () => {
  assert.strictEqual(
    resolveSessionTitle({ title: '   ', firstUserMessage: '首条消息' }),
    '首条消息'
  );
});

// ── E. 接线契约（源码级）────────────────────────────────────────────

test('AppLayout：失败后自动重试，且提供手动重试入口', () => {
  assert.match(appLayoutSrc, /nextRetryDelay/, '必须用统一的重试节奏（单一真源）');
  assert.match(appLayoutSrc, /scheduleRetry/, '失败后必须安排自动重试');
  assert.match(appLayoutSrc, /const reloadTasks = useCallback/, '必须有手动重试函数');
  assert.match(appLayoutSrc, /onReloadTasks=\{reloadTasks\}/, '手动重试必须接到侧栏');
});

test('AppLayout：安全网定时器必须在成功与失败两条路径上都被清掉', () => {
  assert.match(appLayoutSrc, /SESSION_LIST_TIMEOUT_MS/, '必须使用统一的安全网常量');
  assert.match(appLayoutSrc, /window\.setTimeout\(/, '安全网必须是一个真实定时器');
  assert.match(appLayoutSrc, /window\.clearTimeout\(safetyTimer\)/, '落地路径必须清掉定时器');
});

test('AppLayout：失败不清空已有会话列表', () => {
  // setTasks 只在拿到会话时调用；失败分支不得调用 setTasks([])。
  assert.doesNotMatch(appLayoutSrc, /setTasks\(\[\]\)/, '失败时不得清空已加载的会话');
});

test('WorkspaceSidebar：失败态必须有「重试」按钮', () => {
  assert.match(sidebarSrc, /onReloadTasks/, '侧栏必须接收重试回调');
  assert.match(sidebarSrc, /重试/, '错误态必须给出重试入口');
  assert.match(sidebarSrc, /describeSessionListError/, '错误文案必须走纯函数映射');
});

test('WorkspaceSidebar：分组数据走后端接口，不再以 localStorage 为真源', () => {
  assert.match(sidebarSrc, /listSessionGroups/, '必须读后端分组接口');
  assert.doesNotMatch(
    sidebarSrc,
    /localStorage\.setItem\(GROUPS_KEY/,
    '不得再把分组写回 localStorage（真源在后端 SQLite）'
  );
  assert.doesNotMatch(
    sidebarSrc,
    /localStorage\.setItem\(TASK_GROUP_KEY/,
    '不得再把会话归属写回 localStorage'
  );
  assert.match(sidebarSrc, /importSessionGroups/, '旧 localStorage 分组要一次性导入后端');
});

test('WorkspaceSidebar：新建分组对话框必须讲清「分组是干什么的」', () => {
  assert.match(sidebarSrc, /新建分组/, '对话框标题');
  assert.match(sidebarSrc, /手动归类/, '必须说明自建分组是手动归类');
  assert.match(sidebarSrc, /拖到分组/, '必须说明怎么往分组里放会话');
});

test('preload：分组 API 必须全部暴露', () => {
  for (const api of [
    'listSessionGroups',
    'createSessionGroup',
    'updateSessionGroup',
    'deleteSessionGroup',
    'moveSessionToGroup',
    'reorderSessionGroups',
    'importSessionGroups',
  ]) {
    assert.match(preloadSrc, new RegExp(api), `preload 缺 ${api}`);
  }
});

test('main：会话列表超时后自动重试一次（一次丢包不该让侧栏永久死掉）', () => {
  assert.match(mainSrc, /SESSION_LIST_TIMEOUT_MS/, '超时必须有统一常量');
  assert.match(mainSrc, /会话列表读取超时/, '超时要有明确文案');
  assert.match(mainSrc, /自动重试一次/, '超时后必须自动重试');
  assert.match(mainSrc, /ipcMain\.handle\('sessionGroup:list'/, '必须有分组列表通道');
});

test('host：分组操作与启动热身都要接线', () => {
  assert.match(hostSrc, /sessionGroup\.request/, 'host 必须处理分组请求');
  assert.match(hostSrc, /sessionGroup\.result/, 'host 必须回分组结果');
  assert.match(hostSrc, /warmUpHostModules/, 'host 必须在启动后热身（首请求不再付冷启动成本）');
  assert.match(hostSrc, /setPendingSessionSource/, 'host 必须给会话打来源标记');
});
