'use strict';

/**
 * Co-located tests for installJobs.js — HTTP 通道内存任务表。
 * 语义红线：顺序执行（全局单队列）、无 wall-clock kill、不持久化。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const installJobs = require('./installJobs');

describe('createJob 基本生命周期', () => {
  test('运行态 → succeeded，result 存档，jobId 带类型与序号', async () => {
    installJobs._reset();
    const job = installJobs.createJob('scan', async (report) => {
      report({ progress: '盘点完成：已装 2 · 缺失 1' });
      return { ok: true, entries: [] };
    });
    assert.match(job.jobId, /^envjob_scan_\d+_1$/);
    assert.strictEqual(job.state, 'running');

    // 等全局队列 settle（轮询到终态，无固定 sleep 依赖）。
    await waitFor(() => installJobs.getJob(job.jobId).state !== 'running');
    const view = installJobs.getJobView(installJobs.getJob(job.jobId));
    assert.strictEqual(view.state, 'succeeded');
    assert.strictEqual(view.progress, '盘点完成：已装 2 · 缺失 1');
    assert.deepStrictEqual(view.result, { ok: true, entries: [] });
  });

  test('runner 抛错 → failed，结果带错误信息（绝不静默）', async () => {
    installJobs._reset();
    const job = installJobs.createJob('install', async () => {
      throw new Error('stub boom');
    });
    await waitFor(() => installJobs.getJob(job.jobId).state !== 'running');
    const view = installJobs.getJobView(installJobs.getJob(job.jobId));
    assert.strictEqual(view.state, 'failed');
    assert.strictEqual(view.result.ok, false);
    assert.strictEqual(view.result.error, 'stub boom');
  });

  test('result.state 优先于 ok 推导（partial 落带）', async () => {
    installJobs._reset();
    const job = installJobs.createJob('import', async () => ({ ok: false, state: 'partial', succeeded: 1, failed: 1 }));
    await waitFor(() => installJobs.getJob(job.jobId).state !== 'running');
    assert.strictEqual(installJobs.getJob(job.jobId).state, 'partial');
  });

  test('ok:false 且无 state → failed', async () => {
    installJobs._reset();
    const job = installJobs.createJob('install', async () => ({ ok: false, error: 'exit-nonzero' }));
    await waitFor(() => installJobs.getJob(job.jobId).state !== 'running');
    assert.strictEqual(installJobs.getJob(job.jobId).state, 'failed');
  });

  test('settle 采纳 result.progress 覆写终态 progress（轮询方不把 running 文案当完成消息）', async () => {
    installJobs._reset();
    const job = installJobs.createJob('scan', async (report) => {
      report({ progress: '正在盘点开发环境（逐项探测与版本采集）' });
      return { ok: true, progress: '盘点完成：共 17 类，已装 4 · 缺失 10 · 手动 1 · 信息 2', result: {} };
    });
    await waitFor(() => installJobs.getJob(job.jobId).state !== 'running');
    const view = installJobs.getJobView(installJobs.getJob(job.jobId));
    assert.strictEqual(view.state, 'succeeded');
    assert.strictEqual(view.progress, '盘点完成：共 17 类，已装 4 · 缺失 10 · 手动 1 · 信息 2');
  });
});

describe('顺序执行（全局单队列）', () => {
  test('第二个 job 等第一个 settle 后才跑，不并发', async () => {
    installJobs._reset();
    const order = [];
    const release = [];
    const a = installJobs.createJob('scan', async () => {
      order.push('a-start');
      await new Promise((r) => release.push(r));
      order.push('a-end');
      return { ok: true };
    });
    const b = installJobs.createJob('scan', async () => {
      order.push('b-start');
      return { ok: true };
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(order, ['a-start'], 'b 不得在 a settle 前启动');
    release[0]();
    await waitFor(() => installJobs.getJob(b.jobId).state !== 'running');
    assert.strictEqual(order[1], 'a-end');
    assert.strictEqual(order[2], 'b-start');
  });
});

describe('getJob / getJobView / 不持久化语义', () => {
  test('未知 jobId 返回 null；getJobView 为快照拷贝', async () => {
    installJobs._reset();
    assert.strictEqual(installJobs.getJob('nope'), null);
    assert.strictEqual(installJobs.getJobView(null), null);

    const job = installJobs.createJob('scan', async (report) => {
      report({ items: [{ depId: 'gcc' }] });
      return { ok: true };
    });
    await waitFor(() => installJobs.getJob(job.jobId).state !== 'running');
    const view = installJobs.getJobView(installJobs.getJob(job.jobId));
    view.items.push({ depId: 'mutated' });
    assert.strictEqual(installJobs.getJob(job.jobId).items.length, 1);
  });

  test('_reset 清空内存表', () => {
    installJobs._reset();
    assert.strictEqual(installJobs.getJob('whatever'), null);
  });
});

/** 轮询到断言条件成立（上限 2s，超时抛错）。 */
async function waitFor(fn) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 2000) {
      throw new Error('waitFor timeout');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
