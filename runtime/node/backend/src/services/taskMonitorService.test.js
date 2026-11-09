'use strict';

/**
 * taskMonitorService 的回归测试。
 *
 * 这个文件钉住的是「监控读数与真实状态对得上」，每条都写成实现退回旧行为就红：
 *
 * 1. 运行登记：开始 → 工具进 → 工具出 → 收尾，四个阶段快照都要如实反映。
 * 2. 收尾时仍在跑的工具必须标失败 —— 不能既从快照消失、又不留线索。
 * 3. 最近完成项按 50 条环形缓冲截断，且新的在前（界面据此展示「刚跑完」）。
 * 4. 队列/后台任务计数必须与 largeTaskRuntimeStore.listTasks() 的分组结果一致 ——
 *    这是「两端读数一致」的机器判据，也是需求五问里的验收标准。
 * 5. 任务台账读坏时快照照常返回，错误进 tasksError，而不是把会话监控一起拖垮。
 *
 * 跑法：node --test src/services/taskMonitorService.test.js
 */

const assert = require('node:assert');
const test = require('node:test');

const svc = require('./taskMonitorService');

const RUNNING = new Set(['claimed', 'running', 'pausing', 'cancelling']);
const QUEUED = new Set(['queued', 'retry_wait']);
const FAILED = new Set(['failed', 'dead_letter']);

function groupOf(status) {
  if (RUNNING.has(status)) return 'running';
  if (QUEUED.has(status)) return 'queued';
  if (FAILED.has(status)) return 'failed';
  if (status === 'paused') return 'paused';
  if (status === 'cancelled') return 'cancelled';
  return 'succeeded';
}

test.beforeEach(() => {
  svc.reset();
});

test('运行从登记到收尾，每个阶段都能在快照里读到', () => {
  const key = svc.beginRun({ scope: 'web', id: 's1', title: '帮我看看这个报错' });
  assert.strictEqual(key, 'web:s1');
  assert.strictEqual(svc.hasRun(key), true);

  let snap = svc.snapshot({ scope: 'web' });
  assert.strictEqual(snap.counts.runsRunning, 1);
  assert.strictEqual(snap.counts.runsFinished, 0);
  assert.strictEqual(snap.process.scope, 'web');
  assert.strictEqual(snap.runs.length, 1);
  assert.strictEqual(snap.runs[0].id, 's1');
  assert.strictEqual(snap.runs[0].title, '帮我看看这个报错');
  assert.strictEqual(snap.runs[0].status, 'running');
  assert.deepStrictEqual(snap.runs[0].tools, []);

  const callId = svc.beginToolCall(key, { callId: 'call_1', tool: 'read', input: { path: 'a.js\nb.js' } });
  assert.strictEqual(callId, 'call_1');
  snap = svc.snapshot();
  assert.strictEqual(snap.runs[0].toolCount, 1);
  assert.strictEqual(snap.runs[0].tools[0].tool, 'read');
  assert.strictEqual(snap.runs[0].tools[0].status, 'running');
  // 非字符串输入走 JSON.stringify，换行被转义成字面 `\n`，预览仍是单行。
  assert.strictEqual(snap.runs[0].tools[0].inputPreview, '{"path":"a.js\\nb.js"}');

  assert.strictEqual(
    svc.endToolCall(key, { callId: 'call_1', tool: 'read', success: true, elapsedMs: 1234, result: 'ok' }),
    true
  );
  snap = svc.snapshot();
  assert.strictEqual(snap.runs[0].tools[0].status, 'succeeded');
  assert.strictEqual(snap.runs[0].tools[0].success, true);
  assert.strictEqual(snap.runs[0].tools[0].elapsedMs, 1234);
  assert.strictEqual(snap.runs[0].tools[0].resultPreview, 'ok');

  assert.strictEqual(svc.endRun(key, { ok: true }), true);
  assert.strictEqual(svc.hasRun(key), false);
  snap = svc.snapshot();
  assert.strictEqual(snap.counts.runsRunning, 0);
  assert.strictEqual(snap.counts.runsFinished, 1);
  assert.strictEqual(snap.runs[0].status, 'succeeded');
  assert.ok(snap.runs[0].finishedAt > 0, 'finishedAt 必须落时间戳，界面据此显示结束时刻');
});

test('收尾时仍未回结果的工具标失败并留下原因，不静默丢线索', () => {
  const key = svc.beginRun({ scope: 'desktop', id: 'd1' });
  svc.beginToolCall(key, { callId: 'call_x', tool: 'bash', input: 'npm test' });
  svc.endRun(key, { ok: false, error: '模型无输出' });

  const run = svc.snapshot().runs[0];
  assert.strictEqual(run.status, 'failed');
  assert.strictEqual(run.error, '模型无输出');
  assert.strictEqual(run.tools.length, 1);
  assert.strictEqual(run.tools[0].status, 'failed');
  assert.strictEqual(run.tools[0].success, false);
  assert.strictEqual(run.tools[0].resultPreview, '运行结束前未收到结果');
});

test('显式 status 压过 ok（用户停止/连接断开不能被写成成功）', () => {
  const key = svc.beginRun({ id: 'stop' });
  svc.endRun(key, { status: 'cancelled', error: '用户停止生成' });
  const run = svc.snapshot().runs[0];
  assert.strictEqual(run.status, 'cancelled');
  assert.strictEqual(run.error, '用户停止生成');
});

test('最近完成项是 50 条环形缓冲，新的在前', () => {
  for (let i = 0; i < svc.MAX_FINISHED_RUNS + 5; i += 1) {
    const key = svc.beginRun({ id: `r${i}` });
    svc.endRun(key, { ok: true });
  }
  const snap = svc.snapshot();
  assert.strictEqual(snap.counts.runsFinished, svc.MAX_FINISHED_RUNS);
  assert.strictEqual(snap.runs.length, svc.MAX_FINISHED_RUNS);
  assert.strictEqual(snap.runs[0].id, `r${svc.MAX_FINISHED_RUNS + 4}`);
  assert.strictEqual(snap.runs[snap.runs.length - 1].id, 'r5');
});

test('同一个 key 重复开始按新运行覆盖，不重复计数', () => {
  svc.beginRun({ id: 'dup' });
  svc.beginRun({ id: 'dup' });
  const snap = svc.snapshot();
  assert.strictEqual(snap.counts.runsRunning, 1);
  assert.strictEqual(snap.runs.length, 1);
});

test('touchRun 刷新活动时间，idleMs 从头算', async () => {
  const key = svc.beginRun({ id: 'idle' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const before = svc.snapshot().runs[0].idleMs;
  assert.ok(before >= 25, `未刷新时 idleMs 应随时间增长，实际 ${before}`);
  svc.touchRun(key);
  const after = svc.snapshot().runs[0].idleMs;
  assert.ok(after < before, `刷新后 idleMs 应回落，before=${before} after=${after}`);
});

test('任务计数与 largeTaskRuntimeStore.listTasks() 的分组完全一致', () => {
  const store = require('../tasks/largeTaskRuntimeStore');
  const tasks = store.listTasks();
  const expected = { running: 0, queued: 0, paused: 0, failed: 0, cancelled: 0, succeeded: 0 };
  for (const task of tasks) expected[groupOf(String(task.status || 'queued'))] += 1;

  const snap = svc.snapshot();
  assert.strictEqual(snap.tasksError, null);
  assert.strictEqual(snap.counts.tasksRunning, expected.running, '在跑任务数必须与台账一致');
  assert.strictEqual(snap.counts.tasksQueued, expected.queued, '排队任务数必须与台账一致');
  assert.strictEqual(snap.counts.tasksFailed, expected.failed);
  assert.strictEqual(snap.counts.tasksPaused, expected.paused);
  assert.strictEqual(snap.counts.tasksTotal, tasks.length);
  assert.strictEqual(snap.tasks.length, Math.min(tasks.length, 100));
});

test('任务台账读坏时快照仍返回，错误进 tasksError', () => {
  const resolved = require.resolve('../tasks/largeTaskRuntimeStore');
  const original = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {
      listTasks() {
        throw new Error('台账文件损坏');
      },
    },
  };
  try {
    const snap = svc.snapshot();
    assert.match(snap.tasksError, /台账文件损坏/);
    assert.deepStrictEqual(snap.tasks, []);
    assert.strictEqual(snap.counts.tasksTotal, 0);
    // 会话侧不受牵连：读任务失败不该把在跑的会话也藏起来。
    svc.beginRun({ id: 'alive' });
    const again = svc.snapshot();
    assert.strictEqual(again.counts.runsRunning, 1);
    assert.strictEqual(again.runs[0].id, 'alive');
  } finally {
    if (original) require.cache[resolved] = original;
    else delete require.cache[resolved];
  }
});
