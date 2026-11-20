'use strict';

/**
 * hiaoBridgeConfig.js — pure leaf (zero IO, deterministic, never throws).
 *
 * Resolves the hiao (phone-dsh) bridge profile knobs: which adb to spawn, which
 * device serial, which port the bridge listens on the phone, which local port
 * the forward defaults to, where the pairing token lives, and how long each
 * request may take. Every default is imported from constants/serviceDefaults.js
 * so no host/port/path literal lives in product code; every value is
 * env-overridable through KHY_HIAO_BRIDGE_*.
 *
 * adb resolution, serial resolution and every argv builder come from the phone
 * facade (`../index.js`) — the phone unit is the single owner of adb plumbing,
 * and a second copy here is how two profiles drift apart. The probe is
 * injectable: with one injected there is no filesystem access at all; without
 * one, resolveAdbExecutableProbed applies the default fs probe (same contract
 * as phoneBridgeConfig.resolveAdbExecutableProbed).
 *
 * Protocol facts this file encodes (source: phone-dsh docs/AMOO-INTEGRATION.md,
 * measured on the real device):
 *   - the bridge listens on the phone at 8898, bound to loopback only;
 *   - the PC reaches it through `adb forward tcp:<local> tcp:8898`;
 *   - /call with a confirm-level tool blocks waiting for a human approval on
 *     the phone, upstream socket ceiling 600s, timeout counts as a refusal.
 *
 * There is deliberately NO on/off switch for this profile: capability is gated
 * structurally by the pairing token (no token → hiao_not_paired, nothing is
 * sent). An on/off flag would need a flagRegistry row, and that file belongs to
 * another batch — one switch must not have two truth sources.
 */

const facade = require('../index');

const {
  HIAO_BRIDGE_DEFAULT_DEVICE_PORT,
  HIAO_BRIDGE_DEFAULT_FORWARD_PORT,
  HIAO_BRIDGE_HTTP_TIMEOUT_MS,
  HIAO_BRIDGE_CALL_TIMEOUT_MS,
  HIAO_BRIDGE_TOKEN_REMOTE_PATH,
} = require('../../../../../constants/serviceDefaults');

/**
 * Upstream approval ceiling, in ms. This is a property of the hiao protocol
 * (the phone-side socket dies at 600s and the verdict becomes a refusal), not
 * a preference of ours — it is the reason the /call timeout must never be
 * configured below it. Not an endpoint/port/path, so it does not belong in
 * serviceDefaults; it is the invariant the call timeout is clamped against.
 */
const HIAO_APPROVAL_CEILING_MS = 600000;

function _readString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function _readPort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function _readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolveDevicePort(env = process.env) {
  return _readPort(env.KHY_HIAO_BRIDGE_DEVICE_PORT, HIAO_BRIDGE_DEFAULT_DEVICE_PORT);
}

function resolveForwardPort(env = process.env) {
  return _readPort(env.KHY_HIAO_BRIDGE_FORWARD_PORT, HIAO_BRIDGE_DEFAULT_FORWARD_PORT);
}

function resolveHttpTimeoutMs(env = process.env) {
  return _readPositiveInt(env.KHY_HIAO_BRIDGE_HTTP_TIMEOUT_MS, HIAO_BRIDGE_HTTP_TIMEOUT_MS);
}

/**
 * /call 的单次请求超时。语义见 serviceDefaults 里 HIAO_BRIDGE_CALL_TIMEOUT_MS 的
 * 注释：上游审批截止 600s + 60s 余量，是单次请求的 AbortSignal 中止，不是任务
 * kill。显式配置的值低于审批上限时向上夹到上限——一个比 600s 短的 /call 超时
 * 不可能等到任何审批决定（上游 600s 才判拒），它只会把每一次「等人批」都提前
 * 砍成超时，正是 RESEARCH-029 §5 禁的「把审批超时误报成设备故障」。
 */
function resolveCallTimeoutMs(env = process.env) {
  const parsed = _readPositiveInt(env.KHY_HIAO_BRIDGE_CALL_TIMEOUT_MS, HIAO_BRIDGE_CALL_TIMEOUT_MS);
  return Math.max(HIAO_APPROVAL_CEILING_MS, parsed);
}

function resolveTokenRemotePath(env = process.env) {
  return _readString(env.KHY_HIAO_BRIDGE_TOKEN_PATH) || HIAO_BRIDGE_TOKEN_REMOTE_PATH;
}

/**
 * The full resolved picture. `baseUrl` is the CONFIGURED forward port; the
 * client rebuilds it from the port adb actually assigns (tcp:0) in
 * ensureForward(). Built by interpolation through the phone facade — never a
 * pinned literal — and deliberately not routed through services/urlSafety.js
 * assertPublicHttpUrlResolved: that guard rejects loopback literals because it
 * protects outbound calls to public hosts, and this is a tunnel to the user's
 * own device (same exception as phoneBridgeConfig.buildLoopbackBaseUrl).
 */
function resolveHiaoBridgeConfig(env = process.env, options = {}) {
  const forwardPort = resolveForwardPort(env);
  return {
    adbExecutable: facade.resolveAdbExecutableProbed(env, options),
    serial: facade.resolveDeviceSerial(env, options),
    devicePort: resolveDevicePort(env),
    forwardPort,
    baseUrl: facade.buildLoopbackBaseUrl(forwardPort),
    tokenRemotePath: resolveTokenRemotePath(env),
    httpTimeoutMs: resolveHttpTimeoutMs(env),
    callTimeoutMs: resolveCallTimeoutMs(env),
  };
}

module.exports = {
  HIAO_APPROVAL_CEILING_MS,
  resolveDevicePort,
  resolveForwardPort,
  resolveHttpTimeoutMs,
  resolveCallTimeoutMs,
  resolveTokenRemotePath,
  resolveHiaoBridgeConfig,
};
