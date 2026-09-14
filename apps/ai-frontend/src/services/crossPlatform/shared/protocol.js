/**
 * protocol.js — Cross-platform sync protocol constants and message builders
 * (ESM build for the browser).
 *
 * Why this file exists next to protocol.cjs
 * ----------------------------------------
 * The wire-format SSOT lives at services/backend/src/services/crossPlatform/protocol.js
 * as CommonJS, and protocol.cjs in this directory is its Node-facing copy (the
 * CJS twins wsClientCore.cjs / crossPlatformHub.cjs require() it).
 *
 * The browser cannot consume that copy: Vite's dev server serves a local .cjs
 * file as an ES module with no named exports, so `import { ClientMessageTypes }
 * from './protocol.cjs'` failed at link time with
 *   "does not provide an export named 'ClientMessageTypes'"
 * and — because wsClientCore is pulled in at boot through the crossPlatform
 * store — the whole Vue app never mounted: http://127.0.0.1:8090/ rendered a
 * blank page while the prebuilt dist/ (Rollup transforms CJS) still worked.
 *
 * So protocol.cjs stays the Node-side copy and this file is the ESM copy the
 * browser imports. Both must stay identical: src/services/crossPlatform/shared/
 * wsClientCore.test.js asserts parity between the two, so a change made to one
 * without the other fails that test instead of silently drifting.
 *
 * @module services/crossPlatform/shared/protocol
 */

// ── Message types (Client → Server) ─────────────────────────────────
export const ClientMessageTypes = Object.freeze({
  AUTH: 'auth',
  PING: 'ping',
  SESSION_JOIN: 'session:join',
  SESSION_LEAVE: 'session:leave',
  SESSION_UPDATE: 'session:update',
  MESSAGE_SEND: 'message:send',
  COMMAND_ROUTE: 'command:route',
  DEVICE_LIST: 'device:list',
});

// ── Message types (Server → Client) ─────────────────────────────────
export const ServerMessageTypes = Object.freeze({
  HELLO: 'hello',
  AUTH_OK: 'auth:ok',
  AUTH_ERROR: 'auth:error',
  PONG: 'pong',
  SESSION_UPDATED: 'session:updated',
  SESSION_JOINED: 'session:joined',
  MESSAGE: 'message',
  COMMAND: 'command',
  PRESENCE: 'presence',
  DEVICE_LIST: 'device:list',
  NOTIFICATION: 'notification',
  ERROR: 'error',
});

// ── Platform identifiers ─────────────────────────────────────────────
export const PLATFORMS = Object.freeze({
  TERMINAL: 'terminal',
  WEB: 'web',
  DESKTOP: 'desktop',
  MOBILE: 'mobile',
});

// ── Connection states ────────────────────────────────────────────────
export const ConnectionState = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  AUTHENTICATING: 'authenticating',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
});

// ── Protocol version ────────────────────────────────────────────────
export const PROTOCOL_VERSION = 1;

// ── Envelope builders ────────────────────────────────────────────────

export function authMessage({ token, deviceId, platform, deviceName, userId, capabilities }) {
  return {
    type: ClientMessageTypes.AUTH,
    token,
    deviceId,
    platform,
    deviceName,
    userId,
    capabilities,
    protocol: PROTOCOL_VERSION,
    timestamp: Date.now(),
  };
}

export function pingMessage() {
  return {
    type: ClientMessageTypes.PING,
    timestamp: Date.now(),
  };
}

export function sessionJoinMessage(sessionId) {
  return {
    type: ClientMessageTypes.SESSION_JOIN,
    sessionId,
    timestamp: Date.now(),
  };
}

export function sessionLeaveMessage(sessionId) {
  return {
    type: ClientMessageTypes.SESSION_LEAVE,
    sessionId,
    timestamp: Date.now(),
  };
}

export function sessionUpdateMessage(sessionId, delta) {
  return {
    type: ClientMessageTypes.SESSION_UPDATE,
    sessionId,
    delta,
    timestamp: Date.now(),
  };
}

export function messageSendMessage({ targetDeviceId, targetPlatform, payload }) {
  return {
    type: ClientMessageTypes.MESSAGE_SEND,
    targetDeviceId,
    targetPlatform,
    payload,
    timestamp: Date.now(),
  };
}

export function commandRouteMessage({ targetPlatform, command, payload }) {
  return {
    type: ClientMessageTypes.COMMAND_ROUTE,
    targetPlatform,
    command,
    payload,
    timestamp: Date.now(),
  };
}

export function deviceListMessage() {
  return {
    type: ClientMessageTypes.DEVICE_LIST,
    timestamp: Date.now(),
  };
}

// ── Message parser ──────────────────────────────────────────────────

export function parseMessage(data) {
  let msg;
  try {
    msg = typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    return { type: 'error', error: 'Invalid JSON' };
  }
  if (!msg || !msg.type) {
    return { type: 'error', error: 'Missing message type' };
  }
  return msg;
}

export function isServerMessage(msg) {
  return Object.values(ServerMessageTypes).includes(msg.type);
}

export function isClientMessage(msg) {
  return Object.values(ClientMessageTypes).includes(msg.type);
}
