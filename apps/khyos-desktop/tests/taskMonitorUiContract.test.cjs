'use strict';

// taskMonitorUiContract.test.js — 「任务监控」桌面端的接线契约。
//
// 这条链路有四段，任何一段断了界面上只会看到空面板或错误提示，却没有编译错误：
//   preload.taskMonitorSnapshot → main ipcMain.handle('taskMonitor:snapshot')
//   → host 进程 {type:'taskMonitor.snapshot'} → 后端 taskMonitorService.snapshot()
//
// 另外钉住窗口菜单入口（与「进程监视器」并列）、只读轮询（1s）与 ESC 关闭——
// 这些都是需求五问里「菜单/导航页入口 + 只读 + 展开详情」的直接落点。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const read = (rel) => {
  const file = join(root, 'src', rel);
  assert.ok(existsSync(file), `missing ${rel}`);
  return readFileSync(file, 'utf-8');
};

const preloadSrc = read('preload/index.ts');
const mainSrc = read('main/index.ts');
const hostSrc = read('host/index.ts');
const titleBarSrc = read('renderer/components/layout/TitleBar.tsx');
const dialogSrc = read('renderer/components/layout/TaskMonitorDialog.tsx');

test('preload 暴露 taskMonitorSnapshot，走既有的 namespace:action 通道', () => {
  assert.match(
    preloadSrc,
    /taskMonitorSnapshot:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('taskMonitor:snapshot'\)/
  );
});

test('main 侧把请求转给 host 进程，并在超时/断连时给出可操作的错误', () => {
  const start = mainSrc.indexOf("ipcMain.handle('taskMonitor:snapshot'");
  assert.ok(start > 0, 'main 必须注册 taskMonitor:snapshot');
  const body = mainSrc.slice(start, start + 1400);
  assert.match(body, /hostProcess!\.send\(\{ type: 'taskMonitor\.snapshot', id \}\)/);
  assert.match(body, /pendingTaskMonitor\.set\(id/);
  assert.match(body, /任务监控快照读取超时：/, '超时提示必须说明看哪里（导出日志/host 状态）');
  assert.match(body, /host 进程未启动/, '断连提示必须说明怎么恢复');
  // snapshotResult 回来时要认领并清理挂起项，否则每次轮询都泄漏一个条目。
  assert.match(
    mainSrc,
    /m\.type === 'taskMonitor\.snapshotResult'[\s\S]{0,220}pendingTaskMonitor\.delete\(m\.id\)/
  );
});

test('host 认领 taskMonitor.snapshot，并用桌面端 scope 返回快照', () => {
  assert.match(hostSrc, /msg\.type === 'taskMonitor\.snapshot' && msg\.id/);
  assert.match(hostSrc, /type: 'taskMonitor\.snapshotResult',\s*\n?\s*id: msg\.id/);
  assert.match(hostSrc, /snapshot: monitor\.snapshot\(\{ scope: 'desktop' \}\)/);
  // 后端服务按仓库根目录惰性加载；加载失败降级为「监控不可用」，不能拖垮 host。
  assert.match(hostSrc, /loadTaskMonitor\(\)/);
  assert.match(hostSrc, /'runtime', 'node', 'backend', 'src', 'services', 'taskMonitorService\.js'/);
});

test('host 在会话生命周期里登记运行与工具，收尾时无论成功失败都销账', () => {
  assert.match(hostSrc, /monitor\.beginRun\(\{ scope: 'desktop', id, title: prompt \}\)/);
  assert.match(hostSrc, /monitor\.touchRun\(monitorKey\)/, '流式分块要算活动，用于判断卡住');
  assert.match(hostSrc, /monitor\.beginToolCall\(monitorKey/);
  assert.match(hostSrc, /monitor\.endToolCall\(/);
  assert.match(hostSrc, /monitor\.endRun\(/, '必须在 finally 里收尾，否则运行永远显示在跑');
  assert.match(hostSrc, /controller\.signal\.aborted \? \{ status: 'cancelled'/, '用户停止要如实记为取消');
});

test('窗口菜单有「任务监控」入口，紧跟在「进程监视器」之后', () => {
  const pid = titleBarSrc.indexOf("label: '进程监视器'");
  const monitor = titleBarSrc.indexOf("label: '任务监控'");
  assert.ok(pid > 0 && monitor > pid, '「任务监控」必须排在「进程监视器」之后');
  const between = titleBarSrc.slice(pid, monitor);
  assert.ok(
    (between.match(/\{ kind:/g) || []).length === 1,
    '两个入口应相邻，中间不得插进其它菜单项'
  );
  assert.match(titleBarSrc, /taskMonitorOpen && \(/, '菜单动作必须真的渲染对话框');
  assert.match(titleBarSrc, /<TaskMonitorDialog onClose=\{\(\) => setTaskMonitorOpen\(false\)\} \/>/);
});

test('对话框是只读轮询（1s）：只读快照、可展开、ESC 关闭，且没有中止/重试通道', () => {
  assert.match(dialogSrc, /__KHYOS__\?:\s*\{\s*taskMonitorSnapshot\?/, '必须经 preload 注入的 API 读快照');
  assert.match(dialogSrc, /setInterval\(load, 1000\)/, '刷新间隔 1s：耗时/进度靠轮询递增');
  assert.match(dialogSrc, /e\.key === 'Escape'\) onClose\(\)/);
  assert.doesNotMatch(dialogSrc, /ipcRenderer|invoke\(/, '渲染进程只能经 preload 暴露的 API，不得直接碰 IPC');
  assert.doesNotMatch(dialogSrc, /abort|cancelRun|retryRun|\.post\(|\.delete\(/, '首版不提供中止/重试');
});
