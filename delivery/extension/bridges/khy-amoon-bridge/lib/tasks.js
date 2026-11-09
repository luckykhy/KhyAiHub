'use strict';

/**
 * lib/tasks.js — durable asynchronous task queue.
 *
 * Purpose: long-running work (khy.ask, slow ADB operations, future Phase 2
 * automation) must not hold an HTTP request open or lose its result when the
 * process restarts.
 *
 * Guarantees:
 *   - States: pending -> running -> done | failed, and cancelled from
 *     pending/running. Terminal states are final.
 *   - Every transition is persisted to <stateDir>/tasks/task_<id>.json with an
 *     atomic write (tmp + rename), so a crash never leaves a half-written task.
 *   - submit()/get()/list()/cancel() are synchronous decisions over the
 *     persisted record; the runner executes asynchronously.
 *   - Recovery on start(): pending tasks are resumed, tasks that were running
 *     when the process died are marked failed/abandoned (their outcome is
 *     unknown, and re-running could repeat a side effect).
 *   - Concurrency is configurable (default 1 = single worker).
 *   - Results larger than maxResultBytes are replaced by a truncation marker.
 *
 * This module owns no ADB, HTTP, or tool logic: the runner is injected.
 * Comments are English; all user-facing messages are Chinese.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require('./contracts');

/** Task states (frozen strings; used by CLI/HTTP callers). */
const TASK_STATES = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const TERMINAL_STATES = new Set([
  TASK_STATES.DONE,
  TASK_STATES.FAILED,
  TASK_STATES.CANCELLED,
]);

const TASK_FILE_RE = /^task_([A-Za-z0-9_-]{8,64})\.json$/;
const TASK_TOOL_RE = /^[A-Za-z0-9_.:-]{1,96}$/;

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_RETAIN_MS = 24 * 60 * 60 * 1000; // terminal tasks kept for 24h
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 120 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function toNonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function normalizeError(err) {
  if (C.isBridgeError(err)) return err.toJSON();
  if (err && typeof err === 'object') {
    return {
      code: typeof err.code === 'string' && err.code ? err.code : 'internal_error',
      message: typeof err.message === 'string' && err.message ? err.message : String(err),
    };
  }
  return { code: 'internal_error', message: String(err === undefined ? 'unknown error' : err) };
}

function iso(clock) {
  return new Date(clock.now()).toISOString();
}

/** Task ids are lowercase alphanumerics, compatible with contracts' ID_RE. */
function newTaskId() {
  return `t${Date.now().toString(36)}${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * @param {string|undefined} raw
 * @returns {number|null}
 */
function envInt(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Serialize and cap a runner result.
 *
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {unknown}
 */
function sanitizeResult(value, maxBytes) {
  const normalized = value === undefined ? null : value;
  let text;
  try {
    text = JSON.stringify(normalized);
  } catch {
    return { truncated: true, note: '结果无法序列化，已丢弃' };
  }
  if (text === undefined) return null;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    return {
      truncated: true,
      bytes,
      note: `结果 ${bytes} 字节超过上限 ${maxBytes}，已丢弃；请改用更小的查询`,
    };
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Create the durable task queue.
 *
 * @param {{
 *   config?: object,
 *   logger?: object,
 *   runner?: (task:object, ctx:{signal:AbortSignal,timeoutMs:number}) => Promise<unknown>,
 *   stateDir?: string,
 *   concurrency?: number,
 *   retainMs?: number,
 *   maxResultBytes?: number,
 *   timeoutMs?: number,
 *   clock?: {now:()=>number},
 *   env?: object,
 * }} [options]
 * @returns {object} queue
 */
function createTaskQueue(options = {}) {
  if (!options || typeof options !== 'object') {
    throw new C.BridgeError('invalid_config', 'createTaskQueue 需要 options 对象');
  }
  const config = options.config || {};
  const logger = options.logger || { debug() {}, info() {}, warn() {}, error() {} };
  const clock = options.clock && typeof options.clock.now === 'function' ? options.clock : { now: Date.now };
  const env = options.env || process.env;

  const baseDir = options.stateDir || config.stateDir || path.join(os.tmpdir(), 'khy-amoon-bridge');
  const dir = path.join(baseDir, 'tasks');
  const concurrency = toPositiveInt(
    options.concurrency !== undefined ? options.concurrency : envInt(env.KHY_AMOON_TASK_CONCURRENCY),
    DEFAULT_CONCURRENCY
  );
  const retainMs = toNonNegativeInt(options.retainMs, DEFAULT_RETAIN_MS);
  const maxResultBytes = toPositiveInt(options.maxResultBytes, DEFAULT_MAX_RESULT_BYTES);
  const defaultTimeoutMs = toPositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);

  const runner =
    typeof options.runner === 'function'
      ? options.runner
      : async () => {
          throw new C.BridgeError(
            'not_implemented',
            '任务执行器未接线：daemon 需注入 runner（khy_ask / 长命令）'
          );
        };

  /** @type {Map<string, object>} persisted records (mutable) */
  const tasks = new Map();
  /** @type {Map<string, AbortController>} */
  const controllers = new Map();
  /** @type {string[]} FIFO of pending ids */
  const queue = [];
  let stopped = false;
  let started = false;
  let lastPruneAt = 0;

  function taskFile(id) {
    return path.join(dir, `task_${id}.json`);
  }

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Atomic JSON write (tmp + rename). The tmp name includes the pid so two
   * processes cannot trample each other's partial file.
   *
   * @param {object} record
   */
  function persist(record) {
    ensureDir();
    const target = taskFile(record.id);
    const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const text = `${JSON.stringify(record)}\n`;
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      fs.renameSync(tmp, target);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw new C.BridgeError('internal_error', `任务状态落盘失败：${err.message}`);
    }
  }

  function snapshot(record) {
    if (!record) return null;
    // JSON copy: callers must not mutate queue internals.
    return JSON.parse(JSON.stringify(record));
  }

  function countByState() {
    const counts = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      total: tasks.size,
    };
    for (const record of tasks.values()) {
      if (counts[record.state] === undefined) continue;
      counts[record.state] += 1;
    }
    return counts;
  }

  function prune(force = false) {
    if (retainMs <= 0) return 0;
    const now = clock.now();
    if (!force && now - lastPruneAt < 60 * 1000) return 0;
    lastPruneAt = now;
    let removed = 0;
    for (const [id, record] of tasks) {
      if (!TERMINAL_STATES.has(record.state)) continue;
      const finished = Date.parse(record.finished_at || record.updated_at || record.created_at);
      if (!Number.isFinite(finished)) continue;
      if (now - finished <= retainMs) continue;
      try {
        fs.rmSync(taskFile(id), { force: true });
      } catch {
        continue;
      }
      tasks.delete(id);
      removed += 1;
    }
    return removed;
  }

  function pickNext() {
    while (queue.length > 0) {
      const id = queue.shift();
      const record = tasks.get(id);
      if (record && record.state === TASK_STATES.PENDING) return record;
    }
    return null;
  }

  function pump() {
    if (stopped) return;
    let running = controllers.size;
    while (running < concurrency) {
      const record = pickNext();
      if (!record) break;
      void runTask(record);
      running += 1;
    }
  }

  /**
   * @param {object} record
   */
  async function runTask(record) {
    if (record.state !== TASK_STATES.PENDING) return;
    record.state = TASK_STATES.RUNNING;
    record.started_at = iso(clock);
    record.updated_at = record.started_at;
    record.attempts = (record.attempts || 0) + 1;
    try {
      persist(record);
    } catch (err) {
      record.state = TASK_STATES.FAILED;
      record.error = normalizeError(err);
      record.finished_at = iso(clock);
      record.updated_at = record.finished_at;
      logger.error('task persist failed before run', { id: record.id, error: record.error.message });
      setImmediate(() => pump());
      return;
    }

    const controller = new AbortController();
    controllers.set(record.id, controller);
    const timeoutMs = toPositiveInt(record.timeout_ms, defaultTimeoutMs);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new C.BridgeError('timeout', `任务超过 ${timeoutMs}ms`));
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    try {
      const result = await runner(snapshot(record), { signal: controller.signal, timeoutMs });
      if (record._settled) return; // stop() already finalized this record
      if (record.cancel_requested) {
        record.state = TASK_STATES.CANCELLED;
        record.error = { code: 'cancelled', message: '任务已取消' };
      } else {
        record.state = TASK_STATES.DONE;
        record.result = sanitizeResult(result, maxResultBytes);
        record.error = null;
      }
    } catch (err) {
      if (record._settled) return;
      if (record.cancel_requested) {
        record.state = TASK_STATES.CANCELLED;
        record.error = { code: 'cancelled', message: '任务已取消' };
      } else {
        record.state = TASK_STATES.FAILED;
        record.error = timedOut
          ? { code: 'timeout', message: `任务超过 ${timeoutMs}ms` }
          : normalizeError(err);
      }
    } finally {
      clearTimeout(timer);
      controllers.delete(record.id);
      if (!record._settled) {
        record.finished_at = iso(clock);
        record.updated_at = record.finished_at;
        try {
          persist(record);
        } catch (err) {
          logger.error('task persist failed', { id: record.id, error: normalizeError(err).message });
        }
      }
      prune(false);
      pump();
    }
  }

  /**
   * Load persisted tasks from disk. Corrupt files are renamed, not deleted.
   * @returns {{loaded:number,resumed:number,abandoned:number,corrupt:number,pruned:number}}
   */
  function recover() {
    const report = { loaded: 0, resumed: 0, abandoned: 0, corrupt: 0, pruned: 0 };
    if (!fs.existsSync(dir)) return report;

    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      logger.error('task dir unreadable', { dir, error: normalizeError(err).message });
      return report;
    }

    for (const name of names) {
      const match = TASK_FILE_RE.exec(name);
      if (!match) continue;
      const file = path.join(dir, name);
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        report.corrupt += 1;
        try {
          fs.renameSync(file, `${file}.corrupt`);
        } catch {
          // ignore
        }
        continue;
      }
      if (!raw || typeof raw !== 'object' || raw.v !== 1 || raw.id !== match[1]) {
        report.corrupt += 1;
        continue;
      }
      // A task submitted before start() is already live in this process; do
      // not treat its persisted "running" record as abandoned.
      if (tasks.has(raw.id)) continue;
      report.loaded += 1;

      if (raw.state === TASK_STATES.RUNNING) {
        // The previous process died mid-task. Its outcome is unknown, so a
        // retry could duplicate a side effect. Fail closed with a terminal
        // state the caller can observe.
        raw.state = TASK_STATES.FAILED;
        raw.error = {
          code: 'abandoned',
          message: '进程重启时任务仍在运行，结果未知；为避免重复副作用不自动重试',
        };
        raw.finished_at = iso(clock);
        raw.updated_at = raw.finished_at;
        tasks.set(raw.id, raw);
        try {
          persist(raw);
        } catch {
          // keep the in-memory record; next persist will retry
        }
        report.abandoned += 1;
        continue;
      }

      tasks.set(raw.id, raw);
      if (raw.state === TASK_STATES.PENDING) {
        queue.push(raw.id);
        report.resumed += 1;
      }
    }

    // FIFO by creation time, then id, regardless of readdir order.
    queue.sort((a, b) => {
      const ra = tasks.get(a);
      const rb = tasks.get(b);
      return String(ra.created_at).localeCompare(String(rb.created_at)) || a.localeCompare(b);
    });

    report.pruned = prune(true);
    return report;
  }

  /**
   * Reject invalid tool names early; the runner decides what a tool means.
   * @param {unknown} tool
   * @returns {string}
   */
  function assertTool(tool) {
    if (typeof tool !== 'string' || !TASK_TOOL_RE.test(tool)) {
      throw new C.BridgeError('invalid_args', `非法任务工具名：${String(tool)}`);
    }
    return tool;
  }

  /**
   * Enqueue a task.
   *
   * @param {{tool:string,args?:object,principal?:object,timeoutMs?:number,meta?:object}} input
   * @returns {object} task snapshot
   */
  function submit(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new C.BridgeError('invalid_args', 'submit 需要对象参数');
    }
    if (stopped) {
      throw new C.BridgeError('internal_error', '任务队列已停止，拒绝新任务');
    }
    const tool = assertTool(input.tool);
    const args = input.args === undefined ? {} : input.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new C.BridgeError('invalid_args', '任务 args 必须是 JSON 对象');
    }
    const id = newTaskId();
    const now = iso(clock);
    const record = {
      v: 1,
      id,
      tool,
      args,
      state: TASK_STATES.PENDING,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
      attempts: 0,
      timeout_ms: toPositiveInt(input.timeoutMs, defaultTimeoutMs),
      principal: input.principal && typeof input.principal === 'object' ? input.principal : null,
      meta: input.meta && typeof input.meta === 'object' ? input.meta : null,
      result: null,
      error: null,
    };
    tasks.set(id, record);
    persist(record);
    queue.push(id);
    pump();
    return snapshot(record);
  }

  /**
   * @param {string} id
   * @returns {object|null}
   */
  function get(id) {
    if (typeof id !== 'string' || !C.isValidId(id)) return null;
    return snapshot(tasks.get(id));
  }

  /**
   * @param {{state?:string,limit?:number,offset?:number,tool?:string}} [filter]
   * @returns {{tasks:object[],total:number,counts:object}}
   */
  function list(filter = {}) {
    const state = filter && filter.state;
    if (state !== undefined && !Object.values(TASK_STATES).includes(state)) {
      throw new C.BridgeError('invalid_args', `未知任务状态：${String(state)}`);
    }
    let records = Array.from(tasks.values());
    if (state) records = records.filter((r) => r.state === state);
    if (filter && typeof filter.tool === 'string') {
      records = records.filter((r) => r.tool === filter.tool);
    }
    records.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id));
    const total = records.length;
    const offset = Math.max(0, toNonNegativeInt(filter && filter.offset, 0));
    const limit = Math.max(0, Math.min(500, toPositiveInt(filter && filter.limit, 50)));
    const page = records.slice(offset, offset + limit).map(snapshot);
    return { tasks: page, total, counts: countByState() };
  }

  /**
   * Cancel a pending or running task.
   *
   * @param {string} id
   * @returns {{cancelled:boolean,state?:string,task?:object,reason?:string}}
   */
  function cancel(id) {
    if (typeof id !== 'string' || !C.isValidId(id)) {
      return { cancelled: false, reason: 'not_found' };
    }
    const record = tasks.get(id);
    if (!record) return { cancelled: false, reason: 'not_found' };
    if (TERMINAL_STATES.has(record.state)) {
      return { cancelled: false, reason: 'already_terminal', state: record.state, task: snapshot(record) };
    }

    record.cancel_requested = true;
    record.updated_at = iso(clock);

    if (record.state === TASK_STATES.PENDING) {
      record.state = TASK_STATES.CANCELLED;
      record.finished_at = record.updated_at;
      record.error = { code: 'cancelled', message: '任务已取消（尚未开始）' };
      try {
        persist(record);
      } catch (err) {
        logger.error('cancel persist failed', { id, error: normalizeError(err).message });
      }
      return { cancelled: true, state: record.state, task: snapshot(record) };
    }

    // running
    const controller = controllers.get(id);
    if (controller) controller.abort(new C.BridgeError('cancelled', '任务已取消'));
    try {
      persist(record);
    } catch {
      // in-memory flag still applies
    }
    return { cancelled: true, state: record.state, task: snapshot(record) };
  }

  /**
   * Stop accepting work. Running tasks are finalized as failed/abandoned so a
   * restart never sees a stale running record (and never re-runs it).
   */
  function stop() {
    stopped = true;
    for (const [id, controller] of controllers) {
      const record = tasks.get(id);
      if (record) {
        record._settled = true;
        record.state = TASK_STATES.FAILED;
        record.error = { code: 'abandoned', message: '任务队列已停止，结果未知' };
        record.finished_at = iso(clock);
        record.updated_at = record.finished_at;
        try {
          persist(record);
        } catch {
          // ignore
        }
      }
      controller.abort(new C.BridgeError('abandoned', '任务队列已停止'));
    }
    controllers.clear();
    queue.length = 0;
    return status();
  }

  /**
   * Start processing: recover from disk once, then pump.
   * @returns {object} status
   */
  function start() {
    if (started) return status();
    stopped = false;
    started = true;
    const report = recover();
    if (report.loaded || report.abandoned || report.corrupt) {
      logger.info('task queue recovered', report);
    }
    pump();
    return { ...status(), recovered: report };
  }

  function status() {
    return {
      state_dir: dir,
      concurrency,
      started,
      stopped,
      counts: countByState(),
      queued: queue.length,
      running: controllers.size,
      retain_ms: retainMs,
      max_result_bytes: maxResultBytes,
    };
  }

  /**
   * Wait until no pending/running tasks remain (tests, CLI drain).
   * @param {{timeoutMs?:number,pollMs?:number}} [opts]
   * @returns {Promise<boolean>} true when idle, false on timeout
   */
  async function whenIdle(opts = {}) {
    const timeoutMs = toPositiveInt(opts.timeoutMs, 30000);
    const pollMs = toPositiveInt(opts.pollMs, 10);
    const deadline = clock.now() + timeoutMs;
    for (;;) {
      const counts = countByState();
      if (counts.pending === 0 && counts.running === 0) return true;
      if (clock.now() >= deadline) return false;
      await sleep(pollMs);
    }
  }

  return {
    start,
    stop,
    submit,
    get,
    list,
    cancel,
    status,
    recover,
    whenIdle,
    // exposed for tests and CLI wiring
    dir,
    states: TASK_STATES,
  };
}

module.exports = {
  createTaskQueue,
  TASK_STATES,
  TERMINAL_STATES,
  TASK_FILE_RE,
  newTaskId,
  sanitizeResult,
};
