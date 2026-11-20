'use strict';

/**
 * DB-03：大任务运行时 claimTask 的守卫。
 *
 * 修复前：claimTask 对任何状态都置 claimed，且不查现有租约 —— TUI 与 Web 后端
 * 是两个进程共享同一份 large_task_runtime.json，后到者会覆盖 lease_owner，
 * 先到者的 startTask 随即抛 "claimed by another worker"。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLargeTaskRuntimeStore } = require('../../src/tasks/largeTaskRuntimeStore');

describe('DB-03 largeTaskRuntimeStore.claimTask 守卫', () => {
  let tempDir;
  let storePath;
  let now;

  function makeStore() {
    now = 1_700_000_000_000;
    return createLargeTaskRuntimeStore({
      storePath,
      nowFn: () => now,
    });
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-claim-guards-'));
    storePath = path.join(tempDir, 'runtime.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('已被他人认领的任务再 claim 返回 null，租约不被抢占', () => {
    const store = makeStore();
    const task = store.createTask({ type: 'demo-task', max_attempts: 2 });

    const first = store.claimTask(task.id, 'worker-A');
    expect(first).toBeTruthy();
    expect(first.lease_owner).toBe('worker-A');

    expect(store.claimTask(task.id, 'worker-B')).toBeNull();
    expect(store.getTask(task.id).lease_owner).toBe('worker-A');
  });

  test('终态任务 claim 返回 null', () => {
    const store = makeStore();
    const task = store.createTask({ type: 'demo-task', max_attempts: 2 });
    store.claimTask(task.id, 'worker-A');
    store.transitionTask(task.id, 'running');
    store.markSucceeded(task.id, 'worker-A', { ok: true });

    expect(store.claimTask(task.id, 'worker-B')).toBeNull();
    expect(store.getTask(task.id).status).toBe('succeeded');
  });

  test('租约过期后可以被另一个 worker 接管', () => {
    const store = makeStore();
    const task = store.createTask({ type: 'demo-task', max_attempts: 2 });
    store.claimTask(task.id, 'worker-A', { leaseMs: 1000 });

    // 未过期：拒绝
    expect(store.claimTask(task.id, 'worker-B')).toBeNull();

    // 过期后由清扫器回收（回到可认领态），随后允许另一个 worker 接管
    now += 5000;
    store.requeueExpiredLeases();
    const takeover = store.claimTask(task.id, 'worker-B');
    expect(takeover).toBeTruthy();
    expect(takeover.lease_owner).toBe('worker-B');
  });
});
