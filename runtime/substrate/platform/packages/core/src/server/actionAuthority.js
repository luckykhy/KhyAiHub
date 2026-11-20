'use strict';

const crypto = require('node:crypto');

function jsonSnapshot(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('动作数据必须是无循环的 JSON 值');
  }
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('动作数据必须是普通对象');
  const keys = Reflect.ownKeys(value).filter((key) => !(array && key === 'length'));
  if (array && keys.length !== value.length) throw new TypeError('动作数据不能包含稀疏数组');
  ancestors.add(value);
  const entries = keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
      throw new TypeError('动作数据不能包含访问器或隐藏字段');
    }
    return [key, jsonSnapshot(descriptor.value, ancestors)];
  });
  ancestors.delete(value);
  const result = array ? [] : Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  if (array) for (const [key, item] of entries) result[key] = item;
  return Object.freeze(result);
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} 不能为空`);
  return value;
}

function authorityError(code, message) {
  return Object.assign(new Error(message), { code });
}

function hasInjection(value) {
  if (typeof value === 'string') {
    const text = value.normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
    return /忽略\s*(?:之前|此前|先前|以上|所有)\s*(?:的)?\s*(?:指令|指示|规则)|(?:ignore|disregard|override)\s+(?:(?:all|the)\s+)?(?:previous|prior|system)\s+(?:instructions?|rules?|prompts?)/i.test(text);
  }
  return !!value && typeof value === 'object' && Object.entries(value).some(([key, item]) => hasInjection(key) || hasInjection(item));
}

function validReceipt(receipt, taskId) {
  return receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    && Object.keys(receipt).sort().join(',') === 'result_ref,status,summary,task_id,violations'
    && receipt.task_id === taskId
    && ['ok', 'denied', 'failed', 'need_human', 'need_split'].includes(receipt.status)
    && typeof receipt.summary === 'string' && receipt.summary.trim().length > 0 && [...receipt.summary].length <= 500
    && (typeof receipt.result_ref === 'string' && receipt.result_ref.trim().length > 0 || receipt.status !== 'ok' && receipt.result_ref === null)
    && Array.isArray(receipt.violations) && receipt.violations.length === 0;
}

function createActionAuthority({ audit, authorize, notify, now = Date.now }) {
  if (!audit || typeof audit.append !== 'function' || typeof audit.query !== 'function'
    || typeof authorize !== 'function' || typeof notify !== 'function') {
    throw new TypeError('动作授权需要严格审计、宿主权限判定器与管理员通知通道');
  }
  const issuer = `core-${crypto.randomUUID()}`;
  const terminals = new Map();
  const tickets = new Map();
  const recoveredStates = new Map();
  const endedTasks = new Set();
  for (const entry of audit.query().reverse()) {
    if (entry.action === 'terminal.freeze') recoveredStates.set(entry.object, 'frozen');
    if (entry.action === 'terminal.unregister') recoveredStates.set(entry.object, 'unregistered');
    if (entry.action === 'task.end') endedTasks.add(JSON.stringify([entry.terminal_id, entry.task_id]));
  }
  let poisoned = false;
  let permissionEpoch = {};

  function requireOpenTask(terminalId, taskId) {
    if (endedTasks.has(JSON.stringify([terminalId, taskId]))) {
      throw authorityError('CORE_TASK_ENDED', '任务已结束：请创建新任务，不能复用旧任务票据');
    }
  }

  function ensureHealthy() {
    if (poisoned) throw authorityError('CORE_AUDIT_UNAVAILABLE', '安全审计不可用：停止执行，修复审计存储后重启核心');
  }

  function record(subject, action, object, decision, reason, ticketId = null, extra = {}) {
    ensureHealthy();
    try {
      const result = audit.append({
        subject, action, object, decision, reason, ticket_id: ticketId, ...extra,
      });
      if (!result || !Number.isSafeInteger(result.seq) || typeof result.hash !== 'string') {
        throw new Error('审计没有返回持久化回执');
      }
      return result;
    } catch (error) {
      poisoned = true;
      tickets.clear();
      throw authorityError('CORE_AUDIT_UNAVAILABLE', `安全审计写入失败：${error.message}；停止执行并检查审计存储`);
    }
  }

  function readClock() {
    let value;
    try { value = now(); } catch { value = NaN; }
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 300000) {
      tickets.clear();
      record(issuer, 'ticket.clock', issuer, 'deny', '票据时钟无效，全部未核销票据已作废');
      throw authorityError('CORE_CLOCK_INVALID', '票据时钟无效：未执行动作，请检查核心时钟后重新签发');
    }
    return value;
  }

  function check(context) {
    ensureHealthy();
    let verdict;
    try {
      verdict = authorize(context);
    } catch (error) {
      record(context.terminal_id, 'permission.check', context.action, 'deny', '权限判定器异常', null, { terminal_id: context.terminal_id, task_id: context.task_id });
      throw authorityError('CORE_PERMISSION_DENIED', '权限判定失败：未执行动作，请检查核心权限配置');
    }
    if (!verdict || verdict.allowed !== true || typeof verdict.then === 'function') {
      const reason = typeof verdict?.reason === 'string' ? verdict.reason : '权限未被明确授予';
      record(context.terminal_id, 'permission.check', context.action, 'deny', reason, null, { terminal_id: context.terminal_id, task_id: context.task_id });
      throw authorityError('CORE_PERMISSION_DENIED', reason);
    }
    record(context.terminal_id, 'permission.check', context.action, 'allow', '宿主权限判定明确允许', null,
      { terminal_id: context.terminal_id, task_id: context.task_id });
  }

  function dropTickets(terminalId, taskId) {
    for (const [id, entry] of tickets) {
      if (entry.terminal_id === terminalId && (taskId === undefined || entry.task_id === taskId)) {
        tickets.delete(id);
      }
    }
  }

  function requireTerminal(id) {
    const terminal = terminals.get(id);
    if (!terminal || terminal.state !== 'active') {
      throw authorityError('CORE_TERMINAL_INACTIVE', '终端未激活或已冻结：请由管理员检查终端状态');
    }
    return terminal;
  }

  function freeze(terminalId, reason) {
    const terminal = terminals.get(terminalId);
    if (!terminal) throw authorityError('CORE_TERMINAL_UNKNOWN', '终端不存在：请先注册');
    terminal.state = 'frozen';
    dropTickets(terminalId);
    record(issuer, 'terminal.freeze', terminalId, 'deny', identifier(reason, '冻结原因'), null, { terminal_id: terminalId });
  }

  async function reject(terminalId, evidence, reason, code = 'CORE_TICKET_INVALID', context = {}) {
    freeze(terminalId, reason);
    const extra = { terminal_id: terminalId, evidence };
    if (typeof context.task_id === 'string' && context.task_id.trim()) extra.task_id = context.task_id;
    const event = record(terminalId, 'security.intercept', terminalId, 'deny', reason, context.ticket_id || null, extra);
    try {
      await notify(Object.freeze({
        event: 'security.intercept', terminal_id: terminalId, audit_seq: event.seq, reason,
      }));
    } catch {
      record(issuer, 'security.notify', terminalId, 'failed', '管理员通知发送失败，终端保持冻结；请检查通知通道', null, { terminal_id: terminalId });
      throw authorityError('CORE_NOTIFICATION_UNAVAILABLE', '安全事件已存证且终端已冻结，但管理员通知失败：请检查通知通道');
    }
    record(issuer, 'security.notify', terminalId, 'delivered', '宿主通知通道已返回', null, { terminal_id: terminalId });
    throw authorityError(code, reason);
  }

  function issue(input) {
    ensureHealthy();
    const request = jsonSnapshot(input);
    const terminalId = identifier(request.terminal_id, 'terminal_id');
    const taskId = identifier(request.task_id, 'task_id');
    requireOpenTask(terminalId, taskId);
    const action = identifier(request.action, 'action');
    const terminal = requireTerminal(terminalId);
    if (!terminal.actions.has(action)) {
      record(issuer, 'ticket.issue', action, 'deny', '执行器能力缺失', null, { terminal_id: terminalId, task_id: taskId });
      throw authorityError('CORE_CAPABILITY_UNAVAILABLE', '该动作执行器尚未接通：请实现并注册对应工具');
    }
    const context = jsonSnapshot({
      terminal_id: terminalId, task_id: taskId, action,
      payload: request.payload, scope: request.scope,
    });
    check(context);
    const ticket = jsonSnapshot({
      ticket_id: crypto.randomBytes(32).toString('hex'),
      issuer,
      terminal_id: terminalId,
      task_id: taskId,
      action,
      scope: context.scope,
      payload_digest: digest(context.payload),
      expires_at: readClock() + 5 * 60 * 1000,
    });
    record(issuer, 'ticket.issue', action, 'allow', '宿主权限检查通过', ticket.ticket_id, { terminal_id: terminalId, task_id: taskId });
    tickets.set(ticket.ticket_id, ticket);
    return ticket;
  }

  async function execute(terminalId, rawRequest) {
    ensureHealthy();
    const terminal = requireTerminal(terminalId);
    let request;
    try {
      request = jsonSnapshot(rawRequest);
    } catch {
      return reject(terminalId, { invalid_json: true }, '派发内容不是有效 JSON 数据');
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return reject(terminalId, request, '派发内容必须是 JSON 对象');
    }
    const keys = Object.keys(request).sort().join(',');
    if (keys !== 'action,from,payload,task_id,ticket') {
      return reject(terminalId, request, '派发字段不符合协议');
    }
    const ticket = request.ticket;
    const issued = ticket && tickets.get(ticket.ticket_id);
    if (!issued || request.from !== issuer || digest(ticket) !== digest(issued)
      || issued.terminal_id !== terminalId || issued.task_id !== request.task_id
      || issued.action !== request.action || issued.payload_digest !== digest(request.payload)) {
      return reject(terminalId, request, '票据来源、主体、动作或参数不匹配', 'CORE_TICKET_INVALID',
        issued?.terminal_id === terminalId ? issued : {});
    }
    if (hasInjection(request.payload)) {
      return reject(terminalId, request, '派发内容含注入特征，停止执行并请管理员核查', 'CORE_TICKET_INVALID', issued);
    }
    if (readClock() >= issued.expires_at) {
      tickets.delete(issued.ticket_id);
      record(terminalId, 'ticket.redeem', request.action, 'deny', '票据已过期', issued.ticket_id, { terminal_id: terminalId, task_id: request.task_id });
      throw authorityError('CORE_TICKET_EXPIRED', '票据已过期：由核心重新检查权限并签发');
    }
    const context = jsonSnapshot({
      terminal_id: terminalId, task_id: request.task_id, action: request.action,
      payload: request.payload, scope: issued.scope,
    });
    check(context);
    // Consume synchronously before yielding to an executor or its side effects.
    tickets.delete(issued.ticket_id);
    record(terminalId, 'ticket.redeem', request.action, 'allow', '一次性票据已核销', issued.ticket_id, { terminal_id: terminalId, task_id: request.task_id });
    const handler = terminal.actions.get(request.action);
    const executionEpoch = permissionEpoch;
    let result;
    try {
      result = await handler(context.payload, context);
    } catch (error) {
      record(terminalId, 'task.receipt', request.action, 'failed', '工具执行抛出异常；票据不重用', issued.ticket_id, { terminal_id: terminalId, task_id: request.task_id });
      throw error;
    }
    let evidence;
    let receipt;
    try {
      evidence = jsonSnapshot(result);
      receipt = typeof evidence === 'string' ? jsonSnapshot(JSON.parse(evidence)) : evidence;
    } catch {
      return reject(terminalId, evidence === undefined ? { invalid_json: true } : evidence,
        '回执不是有效 JSON 数据：请检查终端协议实现', 'CORE_RECEIPT_INVALID', issued);
    }
    if (!validReceipt(receipt, request.task_id) || hasInjection(receipt)) {
      return reject(terminalId, evidence, '回执字段、任务绑定、违规声明或注入检测未通过：请管理员核查', 'CORE_RECEIPT_INVALID', issued);
    }
    try {
      if (executionEpoch !== permissionEpoch) {
        throw authorityError('CORE_POLICY_CHANGED', '配置已变更：旧授权下的迟到回执不作为成功结果，请重新检查任务');
      }
      requireOpenTask(terminalId, request.task_id);
      requireTerminal(terminalId);
    } catch (error) {
      record(terminalId, 'task.receipt', request.action, 'discarded', '任务已结束、配置已变更或终端已停用，迟到回执不作为成功结果', issued.ticket_id,
        { terminal_id: terminalId, task_id: request.task_id, evidence });
      throw error;
    }
    record(terminalId, 'task.receipt', request.action, receipt.status, '回执协议校验通过；产物真实性由宿主验收', issued.ticket_id,
      { terminal_id: terminalId, task_id: request.task_id, evidence });
    return receipt;
  }

  function registerTerminal(terminalId, actions) {
    ensureHealthy();
    identifier(terminalId, 'terminal_id');
    if (terminals.has(terminalId)) throw authorityError('CORE_TERMINAL_EXISTS', '终端标识重复：请选择唯一标识');
    if (!actions || Object.getPrototypeOf(actions) !== Object.prototype) throw new TypeError('执行器映射必须是对象');
    const entries = Object.entries(actions);
    if (entries.some(([name, handler]) => !name.trim() || typeof handler !== 'function')) {
      throw new TypeError('执行器必须由宿主明确提供函数');
    }
    record(issuer, 'terminal.bind', terminalId, 'allow', '宿主绑定终端执行器，未替代矩阵审批', null, { terminal_id: terminalId });
    terminals.set(terminalId, { state: recoveredStates.get(terminalId) || 'active', actions: new Map(entries) });
    return Object.freeze({ execute: (request) => execute(terminalId, request) });
  }

  function unregisterTerminal(terminalId) {
    const terminal = terminals.get(terminalId);
    if (!terminal) throw authorityError('CORE_TERMINAL_UNKNOWN', '终端不存在：无法注销');
    terminal.state = 'unregistered';
    dropTickets(terminalId);
    record(issuer, 'terminal.unregister', terminalId, 'allow', '终端已注销，全部票据失效', null, { terminal_id: terminalId });
  }

  function endTask(terminalId, taskId) {
    ensureHealthy();
    identifier(terminalId, 'terminal_id');
    identifier(taskId, 'task_id');
    endedTasks.add(JSON.stringify([terminalId, taskId]));
    dropTickets(terminalId, taskId);
    record(issuer, 'task.end', taskId, 'allow', '任务结束，剩余票据失效', null, { terminal_id: terminalId, task_id: taskId });
  }

  function invalidateTickets(reason) {
    ensureHealthy();
    identifier(reason, '作废原因');
    const count = tickets.size;
    tickets.clear();
    permissionEpoch = {};
    record(issuer, 'ticket.invalidate', issuer, 'allow', reason, null, { count });
  }

  return Object.freeze({ issuer, issue, registerTerminal, unregisterTerminal, freeze, endTask, invalidateTickets });
}

module.exports = { createActionAuthority };
