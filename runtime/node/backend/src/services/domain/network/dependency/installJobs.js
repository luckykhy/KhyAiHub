'use strict';

/**
 * dependency/installJobs.js — HTTP 通道的内存任务表（[DESIGN-ARCH-204]）。
 *
 * 盘点/安装/导入是秒级到分钟级的长操作，HTTP 同步等会撞 axios 默认超时，
 * 一律 job 化：POST 返 202 + jobId，前端轮询 GET /jobs/:jobId。
 *
 * 语义红线：
 *   - 同进程内**顺序**执行（全局单队列）：安装是重系统操作，绝不并发互踩。
 *   - 无 wall-clock kill：settle 于子进程退出/结果事件（RUNTIME-003——对活跃
 *     任务硬 kill 是红线；超时语义由 installRunner 自身的隔离执行负责）。
 *   - 不持久化：进程重启 job 即失，UI 如实显示「任务记录随重启清空」；
 *     持久化任务队列留给 v2。
 */

const _jobs = new Map();
let _seq = 0;
// 全局单队列：后续 job 排在前一个 settle 之后（顺序执行，不并发）。
let _tail = Promise.resolve();

/** 供测试清空（内存态，无持久化）。 */
function _reset() {
  _jobs.clear();
  _seq = 0;
  _tail = Promise.resolve();
}

/**
 * 创建并入队一个任务。runner 立即被调度（等队头空出），形如：
 *   async (report) => result
 * report({ progress?, items? }) 更新进度行/明细；runner 返回值存为 job.result，
 * 其带 state:'partial'|'succeeded'|'failed' 时优先采用，否则按 ok 布尔推导。
 *
 * @param {string} kind  'scan' | 'install' | 'import'
 * @param {(report: Function) => Promise<object>} runner
 * @returns {object} job（引用同进程内实时更新，调用方应轮询 getJob）
 */
function createJob(kind, runner) {
  _seq += 1;
  const job = {
    jobId: `envjob_${kind}_${Date.now()}_${_seq}`,
    kind,
    state: 'running',
    progress: '',
    items: [],
    result: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  _jobs.set(job.jobId, job);

  const report = (patch = {}) => {
    if (typeof patch.progress === 'string') {
      job.progress = patch.progress;
    }
    if (Array.isArray(patch.items)) {
      job.items = patch.items;
    }
    job.updatedAt = new Date().toISOString();
  };

  _tail = _tail.then(async () => {
    try {
      const result = await runner(report);
      job.result = result || null;
      job.state =
        result && ['partial', 'succeeded', 'failed'].includes(result.state)
          ? result.state
          : result && result.ok === false
            ? 'failed'
            : 'succeeded';
      // 终态 progress 采纳 result.progress：轮询方只读 job.progress，若停在
      // running 期的文案，web 终态提示会把「正在盘点…」当成功消息显示。
      if (result && typeof result.progress === 'string' && result.progress) {
        job.progress = result.progress;
      }
    } catch (e) {
      job.result = { ok: false, error: (e && e.message) || String(e) };
      job.state = 'failed';
    }
    job.updatedAt = new Date().toISOString();
  });

  return job;
}

/** 按 jobId 取任务；未知返回 null。 */
function getJob(jobId) {
  return _jobs.get(String(jobId || '')) || null;
}

/** HTTP 视图（当前快照拷贝，调用方拿到的对象不会随后续进度变）。 */
function getJobView(job) {
  if (!job) {
    return null;
  }
  return {
    jobId: job.jobId,
    kind: job.kind,
    state: job.state,
    progress: job.progress,
    items: job.items.slice(),
    result: job.result,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

module.exports = { createJob, getJob, getJobView, _reset };
