'use strict';

const { createSecurityAudit, jsonSnapshot } = require('./securityAudit');
const { createMatrixStore } = require('./matrixStore');
const { createActionAuthority } = require('./actionAuthority');
const { canonicalPath } = require('./matrixPolicy');

const fail = (code, message) => Object.assign(new Error(message), { code });

function createSecurityKernel({ matrixPath, auditPath, administrator, notify, protectedPaths = [], now = Date.now }) {
  if (!administrator || typeof administrator !== 'object' || typeof notify !== 'function' || typeof now !== 'function') {
    throw new TypeError('核心安全装配需要可信管理员身份、通知通道和时钟');
  }
  const reserved = [matrixPath, `${matrixPath}.lock`, `${matrixPath}.pending`, auditPath, `${auditPath}.lock`].map(canonicalPath);
  if (new Set(reserved).size !== reserved.length) throw new TypeError('配置、审计及其锁文件不能使用相同路径');
  const principals = new Map();
  const bindings = new Map();
  let store;
  let authority;
  let closed = false;
  let closing;
  const running = new Set();
  const audit = createSecurityAudit({ filePath: auditPath, now });

  function ensureOpen() {
    if (closed) throw fail('CORE_SECURITY_CLOSED', '核心安全会话已关闭：请重新连接持锁核心');
  }

  function close() {
    if (closing) return closing;
    closed = true;
    const errors = [];
    try { store?.close(); } catch (error) { errors.push(error); }
    principals.clear();
    bindings.clear();
    closing = Promise.allSettled([...running]).then(() => {
      try { audit.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, '安全会话关闭失败：请核查配置与审计锁');
    });
    return closing;
  }

  try {
    store = createMatrixStore({
      filePath: matrixPath, audit, administrator, protectedPaths,
      invalidateTickets(reason) { authority?.invalidateTickets(reason); },
      async onViolation(principal, event) {
        const terminalId = principals.get(principal);
        if (terminalId) authority.freeze(terminalId, event.reason);
        await notify(Object.freeze({ ...event, terminal_id: terminalId || null }));
      },
    });
    authority = createActionAuthority({
      audit, notify, now,
      authorize(context) {
        ensureOpen();
        const action = bindings.get(context.terminal_id)?.get(context.action);
        if (!action) return { allowed: false, reason: '最终执行器未绑定：请接通终端能力' };
        return store.check(context, action.inspect(context));
      },
    });
    store.load();
  } catch (error) {
    closed = true;
    const errors = [error];
    try { store?.close(); } catch (cleanup) { errors.push(cleanup); }
    try { audit.close(); } catch (cleanup) { errors.push(cleanup); }
    if (errors.length > 1) throw new AggregateError(errors, '安全装配失败且清理未完成');
    throw error;
  }

  async function assertAdministrator(principal, action, evidence) {
    ensureOpen();
    await store.assertAdministrator(principal, action, evidence);
    ensureOpen();
  }

  async function bindTerminal(principal, terminalId, identity, actions) {
    await assertAdministrator(principal, 'terminal.bind', { terminal_id: terminalId });
    if (!identity || typeof identity !== 'object' || identity === administrator || principals.has(identity)) {
      throw new TypeError('终端身份必须独立且不能复用管理员或其他终端身份');
    }
    if (!actions || Object.getPrototypeOf(actions) !== Object.prototype) throw new TypeError('终端动作必须是宿主执行器映射');
    const entries = Object.entries(actions).map(([name, action]) => {
      if (!action || typeof action.inspect !== 'function' || typeof action.execute !== 'function') {
        throw new TypeError('每个终端动作都必须提供最终执行事实检查与执行函数');
      }
      return [name, Object.freeze({ inspect: action.inspect, execute: action.execute })];
    });
    const port = authority.registerTerminal(terminalId, Object.fromEntries(entries.map(([name, action]) => [name, action.execute])));
    bindings.set(terminalId, new Map(entries));
    principals.set(identity, terminalId);
    return Object.freeze({
      async execute(envelope) {
        ensureOpen();
        const execution = port.execute(envelope);
        running.add(execution);
        try { return await execution; } finally { running.delete(execution); }
      },
      queryAudit: (filter) => queryAudit(identity, filter),
    });
  }

  async function issue(principal, context) {
    await assertAdministrator(principal, 'ticket.issue', context);
    return authority.issue(context);
  }

  async function queryAudit(principal, filter = {}) {
    ensureOpen();
    const query = jsonSnapshot(filter);
    if (!query || Array.isArray(query) || typeof query !== 'object'
      || Object.keys(query).some((key) => !['terminal_id', 'task_id', 'limit'].includes(key))) {
      throw new TypeError('审计查询只接受 terminal_id、task_id 与 limit');
    }
    const terminalId = principals.get(principal);
    if (principal !== administrator) {
      if (!terminalId) await assertAdministrator(principal, 'audit.query', query);
      if (typeof query.task_id !== 'string' || !query.task_id.trim()
        || (query.terminal_id !== undefined && query.terminal_id !== terminalId)) {
        audit.append({ subject: terminalId, action: 'audit.query', object: terminalId, decision: 'deny',
          reason: '终端只能查询本终端已派发任务的审计', ticket_id: null, terminal_id: terminalId });
        throw fail('CORE_PERMISSION_DENIED', '请指定本终端的任务，不能查询其他终端或全部审计');
      }
      query.terminal_id = terminalId;
      if (!audit.query({ terminal_id: terminalId, task_id: query.task_id }).some((entry) => entry.action === 'ticket.issue' && entry.decision === 'allow')) {
        throw fail('CORE_PERMISSION_DENIED', '该任务未派发给本终端：拒绝查询审计');
      }
    }
    const result = audit.query(query);
    audit.append({ subject: terminalId || 'administrator', action: 'audit.query', object: terminalId || 'all', decision: 'allow',
      reason: '按可信会话身份返回审计切片', ticket_id: null, ...(terminalId ? { terminal_id: terminalId, task_id: query.task_id } : {}) });
    return result;
  }

  async function endTask(principal, terminalId, taskId) {
    await assertAdministrator(principal, 'task.end', { terminal_id: terminalId, task_id: taskId });
    authority.endTask(terminalId, taskId);
  }

  return Object.freeze({
    get matrix() { ensureOpen(); return store.matrix; },
    get revision() { ensureOpen(); return store.revision; },
    propose: (principal, matrix) => store.propose(principal, matrix),
    confirm: (principal, response) => store.confirm(principal, response),
    bindTerminal, issue, queryAudit, endTask, close,
  });
}

module.exports = { createSecurityKernel };
