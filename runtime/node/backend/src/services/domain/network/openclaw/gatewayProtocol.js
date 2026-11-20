'use strict';

/**
 * gatewayProtocol.js — pure leaf (zero IO, deterministic, never throws).
 *
 * The OpenClaw gateway speaks a length-agnostic JSON frame protocol over WS:
 *
 *   server → client  {"type":"event","event":"connect.challenge",
 *                     "payload":{"nonce":"<uuid>","ts":<ms>}}
 *   client → server  {"type":"req","id":"connect-1","method":"connect","params":{...}}
 *   server → client  {"type":"res","id":"connect-1","ok":true,
 *                     "payload":{"type":"hello-ok","protocol":3,...}}
 *
 * Everything here is a pure transform of those shapes. The IO that moves them
 * lives in gatewayClient.js; keeping them apart is what makes the handshake
 * assertable without a phone, a server, or a tunnel.
 *
 * The device-signature payload string is versioned and field-order sensitive
 * (v3 measured against the live gateway; v2 exists in the same source file and
 * is kept only so a v2 fallback can be written against a real capture).
 */

const PROTOCOL_VERSION = 3;
const CONNECT_METHOD = 'connect';

/** Error codes the gateway itself returns on a rejected connect. */
const CONNECT_ERROR_CODES = Object.freeze({
  TOKEN_MISSING: 'AUTH_TOKEN_MISSING',
  TOKEN_MISMATCH: 'AUTH_TOKEN_MISMATCH',
  UNAUTHORIZED: 'AUTH_UNAUTHORIZED',
  DEVICE_SIGNATURE_INVALID: 'DEVICE_AUTH_SIGNATURE_INVALID',
  DEVICE_ID_MISMATCH: 'DEVICE_AUTH_DEVICE_ID_MISMATCH',
});

const DEVICE_ID_DERIVATION = 'sha256(rawPublicKeyBytes)';

/**
 * The exact string that gets signed. Field order is part of the contract:
 * changing it produces a valid-looking signature the gateway rejects with
 * DEVICE_AUTH_SIGNATURE_INVALID, which reads as "wrong key" and sends you
 * hunting the wrong problem.
 */
function buildDeviceAuthPayloadV3(fields) {
  const parts = [
    'v3',
    fields.deviceId,
    fields.clientId,
    fields.clientMode,
    fields.role,
    (fields.scopes || []).join(','),
    String(fields.signedAt),
    fields.token || '',
    fields.nonce,
    fields.platform || '',
    fields.deviceFamily || '',
  ];
  return parts.join('|');
}

function buildConnectParams(input) {
  const device = input.device || {};
  const auth = input.auth || {};
  const params = {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: input.clientId,
      version: input.clientVersion || '0.0.0',
      platform: input.platform || '',
      mode: input.clientMode,
    },
    role: input.role || 'operator',
    scopes: (input.scopes || []).slice(),
  };
  // auth carries whichever credential the caller actually has. An empty object
  // is legal — the gateway answers AUTH_TOKEN_MISSING rather than hanging.
  if (auth.token) params.auth = { ...params.auth, token: auth.token };
  if (auth.deviceToken) params.auth = { ...params.auth, deviceToken: auth.deviceToken };
  if (!params.auth) params.auth = {};
  if (device.id) {
    params.device = {
      id: device.id,
      publicKey: device.publicKey,
      signature: device.signature,
      signedAt: device.signedAt,
      nonce: device.nonce,
    };
  }
  return params;
}

function buildConnectFrame(input) {
  return {
    type: 'req',
    id: input.id || 'connect-1',
    method: CONNECT_METHOD,
    params: buildConnectParams(input),
  };
}

function buildRequestFrame(id, method, params) {
  return { type: 'req', id, method, params: params || {} };
}

/**
 * Classify one inbound frame. Unknown shapes come back as kind 'unknown'
 * rather than throwing — a gateway that adds an event type must not crash a
 * long-lived client.
 */
function classifyFrame(raw) {
  let frame;
  try {
    frame = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { kind: 'unknown', reason: 'not-json' };
  }
  if (!frame || typeof frame !== 'object') return { kind: 'unknown', reason: 'not-object' };
  if (frame.type === 'res') {
    return {
      kind: 'res',
      id: frame.id,
      ok: frame.ok === true,
      payload: frame.payload,
      error: frame.error || null,
    };
  }
  if (frame.type === 'event') {
    return {
      kind: 'event',
      event: frame.event,
      payload: frame.payload,
    };
  }
  return { kind: 'unknown', reason: 'unrecognised-type' };
}

/** Pull the fields khyos actually branches on out of a hello-ok payload. */
function parseHelloOk(payload) {
  const p = payload || {};
  const features = p.features || {};
  const auth = p.auth || {};
  const snapshot = p.snapshot || {};
  const sessionDefaults = snapshot.sessionDefaults || {};
  return {
    protocol: typeof p.protocol === 'number' ? p.protocol : null,
    serverVersion: (p.server && p.server.version) || null,
    connId: (p.server && p.server.connId) || null,
    methodCount: Array.isArray(features.methods) ? features.methods.length : 0,
    eventCount: Array.isArray(features.events) ? features.events.length : 0,
    role: auth.role || null,
    scopes: Array.isArray(auth.scopes) ? auth.scopes.slice() : [],
    hasDeviceToken: auth.hasDeviceToken === true,
    defaultAgentId: sessionDefaults.defaultAgentId || null,
    mainSessionKey: sessionDefaults.mainSessionKey || null,
    policy: p.policy || null,
  };
}

/**
 * A hello with no scopes is the failure mode that looks like success: the
 * handshake returns ok, every later call answers "missing scope". Callers must
 * treat empty scopes as not-usable rather than connected.
 */
function helloIsUsable(hello) {
  return Boolean(hello && hello.scopes && hello.scopes.length > 0);
}

function extractConnectError(resFrame) {
  const err = (resFrame && resFrame.error) || {};
  const details = err.details || {};
  return {
    code: details.code || err.code || null,
    message: err.message || '',
    retryable: err.retryable === true,
  };
}

module.exports = {
  PROTOCOL_VERSION,
  CONNECT_METHOD,
  CONNECT_ERROR_CODES,
  DEVICE_ID_DERIVATION,
  buildDeviceAuthPayloadV3,
  buildConnectParams,
  buildConnectFrame,
  buildRequestFrame,
  classifyFrame,
  parseHelloOk,
  helloIsUsable,
  extractConnectError,
};
