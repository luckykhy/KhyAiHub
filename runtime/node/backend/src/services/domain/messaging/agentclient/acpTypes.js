'use strict';

/**
 * acpTypes.js — 编辑器 ACP v1 常量与方法面（单一真源 = contracts/agentclient/acp-v1-methods.json）。
 *
 * 常量依官方规范文档自实现（[SOURCING-001]：不复制 Zed/官方 SDK 源码）；
 * 与 acpTransport.js（私有 ACP 方言）零共享——两套协议的边界由 [DESIGN-NAM-002] 锁定。
 *
 * 设计真源：[DESIGN-ARCH-184] §3/§6。
 */

const schema = require('../../../../contracts/agentclient/acp-v1-methods.json');

const PROTOCOL_VERSION = schema.protocolVersion;
const JSONRPC_ERRORS = schema.jsonrpcErrors;
const STOP_REASONS = schema.stopReasons;
const SESSION_UPDATE_VARIANTS = schema.sessionUpdateVariants;
const PERMISSION_KINDS = schema.permissionKinds;
const TOOL_KINDS = schema.toolKinds;

/** JSON-RPC 信封三分类（协议：响应无 method，通知无 id）。 */
function isRequest(msg) {
  return typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null;
}
function isNotification(msg) {
  return typeof msg.method === 'string' && (msg.id === undefined || msg.id === null);
}
function isResponse(msg) {
  return msg.method === undefined && msg.id !== undefined;
}

/** 协议错误回包（通知无 id → id 置 null，JSON-RPC 2.0 口径）。 */
function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined || id === null ? null : id, error: { code, message } };
}

function methodNotFoundResponse(id, method) {
  return errorResponse(id, JSONRPC_ERRORS.methodNotFound, `方法未实现（编辑器 ACP v1 稳定面之外）: ${method}`);
}

function invalidParamsResponse(id, method, why) {
  return errorResponse(id, JSONRPC_ERRORS.invalidParams, `参数不合法（${method}）: ${why}`);
}

/**
 * 把 khy 网关/循环侧的错误归类映射到协议 StopReason（封闭枚举，见 §3）。
 * 取消必须映射为 cancelled（协议 MUST：不得把取消当 error 回给编辑器）。
 * @param {{errorType?: string, message?: string}} err
 * @returns {string} StopReason
 */
function stopReasonFromError(err) {
  const type = String((err && err.errorType) || '').toLowerCase();
  if (type.includes('abort') || type.includes('cancel') || type.includes('interrupt')) {
    return 'cancelled';
  }
  if (type.includes('token') || type.includes('length') || type.includes('truncat')) {
    return 'max_tokens';
  }
  if (type.includes('refus') || type.includes('block') || type.includes('content_filter')) {
    return 'refusal';
  }
  return 'end_turn';
}

/**
 * khy 工具名 → 协议 ToolKind（图标/呈现用提示，纯启发式）。
 * khy 工具面广，未列出的统一 'other'——kind 只是呈现提示，不承载授权（协议口径）。
 */
const _TOOL_KIND_HINTS = [
  [/read|list|search|glob|grep|find|inspect|show|view/i, 'read'],
  [/edit|write|apply|patch|scaffold|create/i, 'edit'],
  [/delete|remove|rm/i, 'delete'],
  [/move|rename/i, 'move'],
  [/shell|bash|exec|run|command|terminal/i, 'execute'],
  [/think|plan|reason/i, 'think'],
  [/fetch|download|web/i, 'fetch'],
];

function toolKindFromName(name) {
  for (const [re, kind] of _TOOL_KIND_HINTS) {
    if (re.test(String(name || ''))) {
      return kind;
    }
  }
  return 'other';
}

module.exports = {
  PROTOCOL_VERSION,
  JSONRPC_ERRORS,
  STOP_REASONS,
  SESSION_UPDATE_VARIANTS,
  PERMISSION_KINDS,
  TOOL_KINDS,
  isRequest,
  isNotification,
  isResponse,
  errorResponse,
  methodNotFoundResponse,
  invalidParamsResponse,
  stopReasonFromError,
  toolKindFromName,
};
