'use strict';

/**
 * 任务监控聚合：一份「本进程在跑的会话/工具」+「文件真源里的队列任务」的快照。
 *
 * 为什么运行登记只在内存：工具事件只存在于拥有该会话的进程（网页端在守护进程，
 * 桌面端在 host 进程），跨进程汇总需要先把事件落成共享日志（二期，见
 * works/data/khy/feedback/task-monitor-20261108/requirement-5q.md 的边界一节）。
 * 队列/后台任务走 largeTaskRuntimeStore，它本来就是文件真源，所以两个进程读数一致。
 *
 * 只读服务：本模块不做中止/重试，也不写任务状态。快照里的 elapsed 由调用方按
 * startedAt/lastActivityAt 自行计算，轮询即可维持递增。
 */

const MAX_FINISHED_RUNS = 50;
const MAX_TOOLS_PER_RUN = 40;
const TASK_SNAPSHOT_LIMIT = 100;
const PREVIEW_MAX = 240;
const TITLE_MAX = 80;

const RUNNING_TASK_STATUSES = new Set(['claimed', 'running', 'pausing', 'cancelling']);
const QUEUED_TASK_STATUSES = new Set(['queued', 'retry_wait']);
const FAILED_TASK_STATUSES = new Set(['failed', 'dead_letter']);

let _seq = 0;
const _runs = new Map();
const _finished = [];

function _now() {
  return Date.now();
}

function _text(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function _preview(value) {
  const text = _text(value).replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
}

function _title(value, fallback) {
  const text = _text(value)
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!text) return fallback;
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
}

function _normalizeScope(scope) {
  return scope === 'desktop' ? 'desktop' : 'web';
}

function _taskGroup(status) {
  if (RUNNING_TASK_STATUSES.has(status)) return 'running';
  if (QUEUED_TASK_STATUSES.has(status)) return 'queued';
  if (FAILED_TASK_STATUSES.has(status)) return 'failed';
  if (status === 'paused') return 'paused';
  if (status === 'cancelled') return 'cancelled';
  return 'succeeded';
}

function _toolEntry(callId, tool, input) {
  return {
    callId: callId || null,
    tool: String(tool || 'tool'),
    status: 'running',
    inputPreview: _preview(input),
    startedAt: _now(),
    finishedAt: null,
    elapsedMs: 0,
    success: null,
    resultPreview: '',
  };
}

function _findOpenTool(run, { callId, tool }) {
  if (callId) {
    const exact = run.tools.find((item) => item.callId === callId && item.status === 'running');
    if (exact) return exact;
  }
  const name = String(tool || '');
  if (!name) return null;
  for (let i = run.tools.length - 1; i >= 0; i -= 1) {
    const item = run.tools[i];
    if (item.status === 'running' && item.tool === name) return item;
  }
  return null;
}

/**
 * 开始一次会话运行。同一个 key 重复开始按新运行覆盖（例如前端重发同一请求 id）。
 * @param {{scope?: 'web'|'desktop', id: string, title?: string}} input
 * @returns {string} key
 */
function beginRun(input = {}) {
  const scope = _normalizeScope(input.scope);
  const id = String(input.id || `run_${++_seq}`);
  const key = `${scope}:${id}`;
  const now = _now();
  _runs.set(key, {
    key,
    scope,
    id,
    title: _title(input.title, id),
    status: 'running',
    startedAt: now,
    lastActivityAt: now,
    finishedAt: null,
    error: null,
    tools: [],
  });
  return key;
}

function hasRun(key) {
  return _runs.has(key);
}

/** 任何一次工具调用/流式分块都算推进，供界面判断「是不是卡住了」。 */
function touchRun(key) {
  const run = _runs.get(key);
  if (!run) return false;
  run.lastActivityAt = _now();
  return true;
}

function beginToolCall(key, input = {}) {
  const run = _runs.get(key);
  if (!run) return null;
  run.lastActivityAt = _now();
  const entry = _toolEntry(input.callId, input.tool, input.input);
  run.tools.push(entry);
  if (run.tools.length > MAX_TOOLS_PER_RUN) {
    run.tools.splice(0, run.tools.length - MAX_TOOLS_PER_RUN);
  }
  return entry.callId;
}

function endToolCall(key, input = {}) {
  const run = _runs.get(key);
  if (!run) return false;
  const now = _now();
  run.lastActivityAt = now;
  const entry = _findOpenTool(run, input);
  if (!entry) return false;
  entry.status = input.success === false ? 'failed' : 'succeeded';
  entry.success = input.success !== false;
  entry.finishedAt = now;
  entry.elapsedMs =
    Number.isFinite(Number(input.elapsedMs)) && Number(input.elapsedMs) >= 0
      ? Number(input.elapsedMs)
      : now - entry.startedAt;
  entry.resultPreview = _preview(input.result);
  return true;
}

/**
 * 收尾一次运行。成功/失败/取消都进入最近 50 条环形缓冲，界面据此保留刚跑完的条目。
 * @param {string} key
 * @param {{ok?: boolean, status?: string, error?: string}} [input]
 */
function endRun(key, input = {}) {
  const run = _runs.get(key);
  if (!run) return false;
  const now = _now();
  const explicit = String(input.status || '').trim();
  run.status = explicit || (input.ok === false ? 'failed' : 'succeeded');
  run.finishedAt = now;
  run.lastActivityAt = now;
  run.error = input.error ? String(input.error) : null;
  for (const entry of run.tools) {
    if (entry.status !== 'running') continue;
    // 运行结束时仍未回结果的工具：不能再假装成功，也不能丢掉这条线索。
    entry.status = 'failed';
    entry.success = false;
    entry.finishedAt = now;
    entry.elapsedMs = now - entry.startedAt;
    entry.resultPreview = '运行结束前未收到结果';
  }
  _runs.delete(key);
  _finished.unshift(run);
  if (_finished.length > MAX_FINISHED_RUNS) {
    _finished.length = MAX_FINISHED_RUNS;
  }
  return true;
}

function _normalizeRun(run, now) {
  const end = run.finishedAt || now;
  return {
    key: run.key,
    scope: run.scope,
    id: run.id,
    title: run.title,
    status: run.status,
    startedAt: run.startedAt,
    lastActivityAt: run.lastActivityAt,
    finishedAt: run.finishedAt,
    elapsedMs: Math.max(0, end - run.startedAt),
    idleMs: Math.max(0, now - run.lastActivityAt),
    error: run.error,
    toolCount: run.tools.length,
    tools: run.tools.map((entry) => ({
      callId: entry.callId,
      tool: entry.tool,
      status: entry.status,
      success: entry.success,
      inputPreview: entry.inputPreview,
      resultPreview: entry.resultPreview,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      elapsedMs: entry.finishedAt ? entry.elapsedMs : Math.max(0, now - entry.startedAt),
    })),
  };
}

function _normalizeTask(task) {
  const payload = task && task.payload_json ? task.payload_json : {};
  const status = String(task.status || 'queued');
  return {
    id: String(task.id || ''),
    type: task.type ? String(task.type) : null,
    status,
    group: _taskGroup(status),
    source: payload.source ? String(payload.source) : null,
    label: _title(
      payload.label || payload.title || payload.name || payload.prompt || payload.description,
      String(task.id || '')
    ),
    priority: Number(task.priority) || 100,
    progressPct: Number.isFinite(Number(task.progress_pct)) ? Number(task.progress_pct) : null,
    attemptCount: Number(task.attempt_count) || 0,
    maxAttempts: Number(task.max_attempts) || 0,
    createdAt: task.created_at || null,
    updatedAt: task.updated_at || null,
    completedAt: task.completed_at || null,
    leaseOwner: task.lease_owner || null,
    lastError: task.last_error ? _preview(task.last_error) : null,
  };
}

const _GROUP_RANK = { running: 0, queued: 1, paused: 2, failed: 3, cancelled: 4, succeeded: 5 };

function _sortTasks(a, b) {
  const ra = _GROUP_RANK[a.group] ?? 9;
  const rb = _GROUP_RANK[b.group] ?? 9;
  if (ra !== rb) return ra - rb;
  const ta = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
  const tb = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
  return ta - tb;
}

function _loadTasks() {
  // 队列任务来自文件真源；读取失败（文件损坏/被锁）不能连会话监控一起拖垮，
  // 快照照常返回并在 tasksError 里如实报告。
  try {
    const runtime = require('../tasks/largeTaskRuntimeStore');
    const tasks = runtime.listTasks().map(_normalizeTask).sort(_sortTasks);
    const counts = { running: 0, queued: 0, paused: 0, failed: 0, cancelled: 0, succeeded: 0 };
    for (const task of tasks) {
      counts[task.group] = (counts[task.group] || 0) + 1;
    }
    return { tasks: tasks.slice(0, TASK_SNAPSHOT_LIMIT), counts, error: null, total: tasks.length };
  } catch (err) {
    return {
      tasks: [],
      counts: { running: 0, queued: 0, paused: 0, failed: 0, cancelled: 0, succeeded: 0 },
      error: `读取任务台账失败：${String((err && err.message) || err)}，请检查 works/data/khy/tasks/large_task_runtime.json`,
      total: 0,
    };
  }
}

/**
 * @param {{scope?: 'web'|'desktop'}} [options]
 */
function snapshot(options = {}) {
  const now = _now();
  const taskView = _loadTasks();
  const runs = [];
  for (const run of _runs.values()) runs.push(_normalizeRun(run, now));
  runs.sort((a, b) => a.startedAt - b.startedAt);
  for (const run of _finished) runs.push(_normalizeRun(run, now));
  return {
    generatedAt: new Date(now).toISOString(),
    process: {
      pid: process.pid,
      scope: _normalizeScope(options.scope),
      nodeVersion: process.version,
    },
    counts: {
      runsRunning: _runs.size,
      runsFinished: _finished.length,
      tasksRunning: taskView.counts.running,
      tasksQueued: taskView.counts.queued,
      tasksPaused: taskView.counts.paused,
      tasksFailed: taskView.counts.failed,
      tasksTotal: taskView.total,
    },
    runs,
    tasks: taskView.tasks,
    tasksError: taskView.error,
  };
}

function reset() {
  _runs.clear();
  _finished.length = 0;
  _seq = 0;
}

module.exports = {
  MAX_FINISHED_RUNS,
  beginRun,
  hasRun,
  touchRun,
  beginToolCall,
  endToolCall,
  endRun,
  snapshot,
  reset,
};
