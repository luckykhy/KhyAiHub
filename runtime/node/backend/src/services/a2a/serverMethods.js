'use strict';

/**
 * serverMethods.js — A2A 服务端方法派发（S3 的任务面语义层）。
 *
 * 把标准 A2A 服务端三方法收敛成纯逻辑：
 *   - `message/send`   → 建任务(submitted) → 调 executor 跑业务 → 落终态(completed/failed)，返回 Task
 *   - `tasks/get`      → 按 id 取任务（无 → 抛 A2aNotFoundError）
 *   - `tasks/cancel`   → 任务转 canceled 终态
 *
 * 设计要点：
 *   1. **存储与语义解耦**：本层只认 `TaskStore` 接口（`createTask/getTask/appendStatus/cancelTask`），
 *      默认实现是 `taskStore.js` 的内存版；将来要换持久化（SQLite/Redis）只换实现，不动语义。
 *   2. **executor 是唯一的业务接缝**：真正"跑 agent"的逻辑由调用方注入
 *      （`createServerMethods({ executor })`）。默认 executor 只回显 ack（诚实占位，
 *      不假装跑了 LLM）。真身是 `executor.js` 的 agent 执行器（一次 runToolUseLoop），
 *      由启动代码在门控 KHY_A2A_EXECUTOR 下经 `routes/a2a.js` 的 setServerMethods 注入。
 *      executor 可收第三个参数 ctx（`{ task, onProgress }）` 把中间态写回任务态。
 *   3. **绝不抛不可预期的错**：语义错误（任务不存在）用显式 `A2aNotFoundError` 表达，
 *      由 `routes/a2a.js` 翻译成 404；executor 抛的错 → 任务落 failed 终态，不炸服务。
 *
 * @module services/a2a/serverMethods
 */

const { TaskStore } = require('./taskStore');

/** 任务不存在时抛出，路由层据此回 404。 */
class A2aNotFoundError extends Error {
  constructor(id) {
    super(`task not found: ${id}`);
    this.name = 'A2aNotFoundError';
    this.taskId = id;
  }
}

/**
 * 从 message/send 入参抽出首段文本（text part 以空格相接）。
 * 默认 executor 与 agent executor（`executor.js`）共用它 —— 两边对"用户说了什么"
 * 的解读必须一致，否则注入真身后任务输入会悄悄变样。
 * @param {object} params message/send 的入参（message / configuration / metadata）
 * @returns {string}
 */
function extractMessageText(params) {
  const msgParts =
    params && params.message && Array.isArray(params.message.parts) ? params.message.parts : [];
  return msgParts
    .filter((p) => p && p.kind === 'text')
    .map((p) => p.text)
    .join(' ');
}

/**
 * 默认 executor：诚实占位。把收到的首段文本回显为一个 text artifact，任务落 completed。
 * 不假装调用 LLM —— 真接入 agent 运行时由注入的 executor（`executor.js`）完成。
 * @param {object} task   刚建好的 submitted 任务
 * @param {object} params message/send 的入参（message / configuration / metadata）
 * @returns {Promise<{ state: string, text?: string, artifacts?: object[] }>}
 */
async function defaultExecutor(task, params) {
  const text = extractMessageText(params);
  return {
    state: 'completed',
    text: text ? `received: ${text}` : 'received',
    artifacts: text
      ? [{ artifactId: `art_${task.id}`, name: 'echo', parts: [{ kind: 'text', text }] }]
      : [],
  };
}

/**
 * 构造一组 A2A 服务端方法。
 * @param {object} [opts]
 * @param {object} [opts.store]    TaskStore 实例（默认新建内存版）
 * @param {Function} [opts.executor] 业务执行器（默认 defaultExecutor）；签名
 *   `(task, params, ctx)`，ctx 为 `{ task, onProgress(state, detail) }`（可忽略）
 * @returns {{ store: object, messageSend: Function, tasksGet: Function, tasksCancel: Function }}
 */
function createServerMethods(opts = {}) {
  const store = opts.store || new TaskStore();
  const executor = typeof opts.executor === 'function' ? opts.executor : defaultExecutor;

  /**
   * message/send —— 受理一条入站消息，建任务并跑 executor。
   * @param {object} params
   * @param {object} params.message  规范 Message（含 messageId / role / parts / contextId? / taskId?）
   * @param {object} [params.configuration]
   * @param {object} [params.metadata]
   * @returns {Promise<object>} 完整 Task
   */
  async function messageSend(params = {}) {
    const msg = params.message && typeof params.message === 'object' ? params.message : {};
    // taskId 已存在 → 视为对既有任务的续写（复用其 contextId）。
    let task = msg.taskId ? store.getTask(msg.taskId) : null;
    if (!task) {
      task = store.createTask({
        contextId: msg.contextId,
        message: msg,
        metadata: params.metadata,
      });
    } else {
      // 续写：先记一条 submitted 进度（若当前已是终态则跳过，避免破坏终态不变式）。
      store.appendStatus(task.id, 'submitted', { message: msg });
      task = store.getTask(task.id);
    }

    let result;
    try {
      // ctx.onProgress：长任务（agent 循环）在跑动期间把中间态写回任务，使 tasks/get
      // 轮询能看到 working + 迭代进度，而不是只能等终态。默认 executor 忽略第三个
      // 参数，行为与加它之前逐字节一致。
      let progressSeq = 0;
      const onProgress = (state, detail) => {
        const message = detail && typeof detail.message === 'string' ? detail.message : '';
        if (!message) return;
        progressSeq += 1;
        store.appendStatus(task.id, state, {
          message: {
            kind: 'message',
            role: 'agent',
            messageId: `p_${task.id}_${progressSeq}`,
            parts: [{ kind: 'text', text: message }],
          },
        });
      };
      result = await executor(task, params, { task, onProgress });
    } catch (err) {
      store.appendStatus(task.id, 'failed', {
        message: { kind: 'message', role: 'agent', messageId: `err_${task.id}`, parts: [{ kind: 'text', text: err && err.message ? err.message : 'executor failed' }] },
      });
      return store.getTask(task.id);
    }

    const next = result && result.state ? result.state : 'completed';
    store.appendStatus(task.id, next, {
      message: result && result.text ? { kind: 'message', role: 'agent', messageId: `r_${task.id}`, parts: [{ kind: 'text', text: result.text }] } : undefined,
      artifact: result && Array.isArray(result.artifacts) && result.artifacts[0] ? result.artifacts[0] : undefined,
    });
    return store.getTask(task.id);
  }

  /**
   * tasks/get —— 按 id 取任务。
   * @param {object} params
   * @param {string} params.id
   * @returns {object} Task（不存在 → 抛 A2aNotFoundError）
   */
  function tasksGet(params = {}) {
    const task = store.getTask(params.id);
    if (!task) throw new A2aNotFoundError(params.id);
    return task;
  }

  /**
   * tasks/cancel —— 撤销任务（→ canceled 终态）。
   * @param {object} params
   * @param {string} params.id
   * @returns {object} Task（不存在 → 抛 A2aNotFoundError）
   */
  function tasksCancel(params = {}) {
    const task = store.getTask(params.id);
    if (!task) throw new A2aNotFoundError(params.id);
    const canceled = store.cancelTask(params.id);
    if (!canceled) {
      // 已是终态、无法再迁 → 直接返回当前任务（带 canceled 之前的状态）。
      return task;
    }
    return canceled;
  }

  return { store, messageSend, tasksGet, tasksCancel };
}

module.exports = { createServerMethods, A2aNotFoundError, defaultExecutor, extractMessageText };
