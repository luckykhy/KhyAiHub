'use strict';

/**
 * protocol.js — Web 远程控制的消息面与状态机（纯数据 + 校验，无 IO）。
 *
 * 形态照 ZCode 真源反解结果（apps/khyos-desktop/zcode-analysis/unpacked/out/main/index.js
 * 的 WebRemoteControlDeviceTransport / q2 消息分派），命名换成 khy_，因为本件不与
 * 智谱云 relay 互通；状态枚举与面向用户的语义保持逐词对齐，便于面板文案直接复用
 * i18n 键 webRemoteControl.*。
 */

const STATUS = {
  IDLE: 'idle',
  STARTING: 'starting',
  RUNNING: 'running', // 服务已监听，等待手机连接（ZCode: waiting）
  ACTIVE: 'active', // 手机已连接
  ERROR: 'error',
};

const ROLE = { VIEWER: 'viewer', OPERATOR: 'operator' };

// 手机 → 桌面
const INBOUND = {
  BOOTSTRAP: 'khy_bootstrap_request',
  AUTH: 'khy_auth',
  WORKSPACE_LIST: 'khy_workspace_list_request',
  TASK_LIST: 'khy_task_list_request',
  SESSION_MESSAGES: 'khy_session_messages_request',
  SESSION_SEND: 'khy_session_send_request',
  SESSION_ABORT: 'khy_session_abort_request',
  CONTROL_RESPONSE: 'khy_control_response',
  HEARTBEAT: 'khy_heartbeat',
};

// 桌面 → 手机
const OUTBOUND = {
  PAIR_PENDING: 'khy_pair_pending',
  BOOTSTRAP: 'khy_bootstrap_response',
  STATUS: 'khy_status',
  WORKSPACE_LIST: 'khy_workspace_list_response',
  TASK_LIST: 'khy_task_list_response',
  SESSION_MESSAGES: 'khy_session_messages_response',
  SESSION_SEND: 'khy_session_send_response',
  STREAM: 'khy_stream',
  CONTROL_REQUEST: 'khy_control_request',
  ERROR: 'khy_error',
  HEARTBEAT: 'khy_heartbeat_ack',
};

// 错误码：与 i18n webRemoteControl.failure.* 一一对应，手机页据此选文案。
const ERROR_CODE = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  EXPIRED: 'SESSION_EXPIRED',
  NOT_FOUND: 'SESSION_NOT_FOUND',
  CONFLICT: 'SESSION_CONFLICT',
  KICKED: 'KICKED',
  FORBIDDEN: 'FORBIDDEN',
  UNSUPPORTED_ACTION: 'UNSUPPORTED_ACTION',
  HOST_UNAVAILABLE: 'DESKTOP_DISCONNECTED',
  RELAY_UNAVAILABLE: 'RELAY_UNAVAILABLE',
};

const INBOUND_TYPES = new Set(Object.values(INBOUND));

// viewer 只允许这些；其余消息要求 operator。
const VIEWER_ALLOWED = new Set([
  INBOUND.BOOTSTRAP,
  INBOUND.AUTH,
  INBOUND.WORKSPACE_LIST,
  INBOUND.TASK_LIST,
  INBOUND.SESSION_MESSAGES,
  INBOUND.HEARTBEAT,
]);

const PAIR_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const PAIR_CODE_LENGTH = 8;
// 配对码有效期：与 devicePairing.PAIRING_REQUEST_TTL_MS 同值，这里只用于展示。
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
// 手机页心跳间隔与桌面侧空闲判定：4.5 个心跳周期无消息即视为页面已关闭。
const HEARTBEAT_INTERVAL_MS = 10 * 1000;
const SOCKET_IDLE_LIMIT_MS = 45 * 1000;
const MAX_FRAME_BYTES = 256 * 1024;

function makeError(code, message) {
  return { type: OUTBOUND.ERROR, code, message };
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 解析并校验一帧入站消息。返回 { ok, message } 或 { ok:false, code, reason }。
 * 只做形状与鉴权前置字段的检查，业务字段由各 handler 自查。
 */
function parseFrame(raw) {
  let data = raw;
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) {
      return { ok: false, code: ERROR_CODE.UNSUPPORTED_ACTION, reason: 'frame too large' };
    }
    try {
      data = JSON.parse(String(raw));
    } catch {
      return { ok: false, code: ERROR_CODE.UNSUPPORTED_ACTION, reason: 'invalid json' };
    }
  }
  if (!isPlainObject(data) || typeof data.khy_type !== 'string') {
    return { ok: false, code: ERROR_CODE.UNSUPPORTED_ACTION, reason: 'missing khy_type' };
  }
  if (!INBOUND_TYPES.has(data.khy_type)) {
    return { ok: false, code: ERROR_CODE.UNSUPPORTED_ACTION, reason: `unknown khy_type: ${data.khy_type}` };
  }
  return { ok: true, message: data };
}

function scopeAllows(role, type) {
  if (role === ROLE.OPERATOR) return true;
  if (role === ROLE.VIEWER) return VIEWER_ALLOWED.has(type);
  return false;
}

module.exports = {
  STATUS,
  ROLE,
  INBOUND,
  OUTBOUND,
  ERROR_CODE,
  PAIR_CODE_ALPHABET,
  PAIR_CODE_LENGTH,
  PAIR_CODE_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  SOCKET_IDLE_LIMIT_MS,
  MAX_FRAME_BYTES,
  makeError,
  parseFrame,
  scopeAllows,
  isPlainObject,
};
