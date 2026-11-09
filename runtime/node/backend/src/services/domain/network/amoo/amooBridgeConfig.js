'use strict';

/**
 * amooBridgeConfig.js — pure leaf: every default the Amoo bridge needs, resolved
 * from `KHY_AMOO_*` env vars with no IO and no throwing.
 *
 * WHY a leaf: the runner, the client and the CLI all need the same numbers, and
 * a drifted copy of "port 8896" between them is exactly the failure this repo
 * bans (`no-hardcoded-endpoint`). One resolver, one set of defaults, one
 * provenance record so a status line can say WHERE a value came from.
 *
 * Measured on the target device (StepX PZ261A, Android 16 / SDK 36):
 *   - StepBridge (now inside the khy-os app, com.khyos.khy_os_client) listens
 *     on 8896, NOT 8898. 8898 is kept
 *     as a forward alias so scripts written against the brief still work.
 *   - Token + mailbox live in /sdcard/bridge-amoobridge, not /sdcard/bridge.
 *   - Amoo's chat screen is com.stepos.ailauncher/.chat.activity.ChatMainActivity
 *     and has no LAUNCHER category, so it must be started by component+action.
 *
 * Contract: deterministic, never throws, does not touch fs/spawn/net. Reads
 * `process.env` by name (the `envFlagByName` idiom) — pass `env` in to test.
 *
 * @module services/domain/network/amoo/amooBridgeConfig
 */
const envFlagByName = require('../../../../utils/envFlagByName');

// The on-set is copied verbatim from utils/envFlagByName, which is the single
// truth for reading process.env by name — but that helper reads process.env
// directly and takes no env object, so a leaf that must honour an INJECTED env
// (tests, and any caller that resolves a config for another process) cannot use
// it as-is. Semantics stay identical on purpose: unknown values are false, only
// null/empty falls back.
const FLAG_ON_VALUES = ['1', 'true', 'yes', 'on', 'enabled'];

function _readFlag(env, name, fallback) {
  const raw = env[name];
  if (raw == null) {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return FLAG_ON_VALUES.includes(normalized);
}

const LOOPBACK_HOST = '127.0.0.1';

// 桥接端口真源在 constants/serviceDefaults.js（LAYOUT-008）：8896 这个数字在
// serviceDefaults 与本文件各写一份时，改一边就等于让手机连不上。此处取真源。
const { PHONE_BRIDGE_DEFAULT_PORT } = require('../../../../constants/serviceDefaults');

const DEFAULTS = Object.freeze({
  ADB_TIMEOUT_MS: 15000,
  BRIDGE_HTTP_TIMEOUT_MS: 10000,
  BRIDGE_PORT: PHONE_BRIDGE_DEFAULT_PORT,
  BRIDGE_ALIAS_PORT: 8898,
  CONNECT_PORT: 33743,
  // 无默认：未设 env 时强制走自动探测（见 amooBridgeClient.ensureDevice）。这里
  // 原先钉着一台开发机的无线调试地址，手机换网后必失败；改成空串后由 IO 层发现。
  DEVICE_SERIAL: '',
  LAUNCH_WAIT_MS: 2500,
  INPUT_WAIT_MS: 1200,
  SEND_WAIT_MS: 1500,
  POLL_INTERVAL_MS: 3000,
  POLL_MAX_INTERVAL_MS: 8000,
  POLL_MAX_ROUNDS: 40,
  REPLY_STABLE_ROUNDS: 3,
  MAILBOX_TIMEOUT_MS: 90000,
  MAILBOX_POLL_MS: 2000,
  MAX_RESULT_CHARS: 20000,
  SCRATCH_SUBDIR: 'amoo',
  UI_DUMP_REMOTE_PATH: '/sdcard/khy_amoo_ui.xml',
});

// 桥的宿主：2026-10-22 起并入 khy-os 手机端（原独立 APK 退役）。
const BRIDGE_PACKAGE = 'com.khyos.khy_os_client';
const AMOO_PACKAGE = 'com.stepos.ailauncher';
const AMOO_ACTIVITY = '.chat.activity.ChatMainActivity';
const AMOO_LAUNCH_ACTION = 'com.stepos.ailauncher.action.OPEN_CHAT';
const AMOO_INPUT_ID = 'com.stepos.ailauncher:id/et_input_bar';
const AMOO_SEND_ID = 'com.stepos.ailauncher:id/btn_text_send';
const AMOO_CHAT_LIST_ID = 'com.stepos.ailauncher:id/chat_list';
const BRIDGE_DIR = '/sdcard/bridge-amoobridge';
// Amoo's EditText reports its HINT as `text` when empty, and the hint differs
// between the idle and the focused state. Both are pinned here so "is the box
// empty?" is answerable without guessing.
const AMOO_INPUT_HINTS = Object.freeze(['发消息或按住说话', '发消息']);

function _readString(env, name, fallback) {
  const raw = env[name];
  if (typeof raw !== 'string') {
    return { value: fallback, source: 'default' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { value: fallback, source: 'default' };
  }
  return { value: trimmed, source: 'env' };
}

function _readInt(env, name, fallback, { min = 1, max = 600000 } = {}) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') {
    return { value: fallback, source: 'default' };
  }
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    // Garbage env value must not crash the layer; fall back and say so.
    return { value: fallback, source: 'default-invalid' };
  }
  return { value: parsed, source: 'env' };
}

function _readPort(env, name, fallback) {
  const parsed = _readInt(env, name, fallback, { min: 1, max: 65535 });
  return { value: parsed.value, source: parsed.source };
}

/**
 * Build the loopback base URL from parts. The literal is assembled at runtime so
 * no `host:port` string is pinned in this file (guard: no-hardcoded-endpoint).
 * @param {string} host
 * @param {number|string} port
 * @returns {string}
 */
function buildLoopbackUrl(host, port) {
  return `http://${host}:${port}`;
}

/**
 * Resolve the whole Amoo bridge configuration.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object} frozen-ish config with a `sources` provenance map
 */
function resolveAmooConfig(env = process.env) {
  const adbPath = _readString(env, 'KHY_AMOO_ADB_PATH', null);
  const serial = _readString(env, 'KHY_AMOO_DEVICE_SERIAL', DEFAULTS.DEVICE_SERIAL);
  const connectPort = _readPort(env, 'KHY_AMOO_CONNECT_PORT', DEFAULTS.CONNECT_PORT);
  const transport = _readString(env, 'KHY_AMOO_BRIDGE_TRANSPORT', 'forward');
  const bridgeHost = _readString(env, 'KHY_AMOO_BRIDGE_HOST', LOOPBACK_HOST);
  const bridgePort = _readPort(env, 'KHY_AMOO_BRIDGE_PORT', DEFAULTS.BRIDGE_PORT);
  const aliasPort = _readPort(env, 'KHY_AMOO_BRIDGE_ALIAS_PORT', DEFAULTS.BRIDGE_ALIAS_PORT);
  const bridgePackage = _readString(env, 'KHY_AMOO_BRIDGE_PACKAGE', BRIDGE_PACKAGE);
  const bridgeDir = _readString(env, 'KHY_AMOO_BRIDGE_DIR', BRIDGE_DIR);
  const amooPackage = _readString(env, 'KHY_AMOO_AMOO_PACKAGE', AMOO_PACKAGE);
  const amooActivity = _readString(env, 'KHY_AMOO_AMOO_ACTIVITY', AMOO_ACTIVITY);
  const launchAction = _readString(env, 'KHY_AMOO_AMOO_LAUNCH_ACTION', AMOO_LAUNCH_ACTION);
  const inputId = _readString(env, 'KHY_AMOO_INPUT_ID', AMOO_INPUT_ID);
  const sendId = _readString(env, 'KHY_AMOO_SEND_ID', AMOO_SEND_ID);
  const chatListId = _readString(env, 'KHY_AMOO_CHAT_LIST_ID', AMOO_CHAT_LIST_ID);
  const uiDumpPath = _readString(env, 'KHY_AMOO_UI_DUMP_PATH', DEFAULTS.UI_DUMP_REMOTE_PATH);
  const inputHints = _readString(env, 'KHY_AMOO_INPUT_HINTS', AMOO_INPUT_HINTS.join(','));

  const adbTimeoutMs = _readInt(env, 'KHY_AMOO_ADB_TIMEOUT_MS', DEFAULTS.ADB_TIMEOUT_MS, {
    min: 1000,
    max: 120000,
  });
  const httpTimeoutMs = _readInt(
    env,
    'KHY_AMOO_BRIDGE_HTTP_TIMEOUT_MS',
    DEFAULTS.BRIDGE_HTTP_TIMEOUT_MS,
    { min: 1000, max: 60000 }
  );
  const launchWaitMs = _readInt(env, 'KHY_AMOO_LAUNCH_WAIT_MS', DEFAULTS.LAUNCH_WAIT_MS, {
    min: 0,
    max: 30000,
  });
  const inputWaitMs = _readInt(env, 'KHY_AMOO_INPUT_WAIT_MS', DEFAULTS.INPUT_WAIT_MS, {
    min: 0,
    max: 30000,
  });
  const sendWaitMs = _readInt(env, 'KHY_AMOO_SEND_WAIT_MS', DEFAULTS.SEND_WAIT_MS, {
    min: 0,
    max: 30000,
  });
  const pollIntervalMs = _readInt(env, 'KHY_AMOO_POLL_INTERVAL_MS', DEFAULTS.POLL_INTERVAL_MS, {
    min: 250,
    max: 60000,
  });
  const pollMaxIntervalMs = _readInt(
    env,
    'KHY_AMOO_POLL_MAX_INTERVAL_MS',
    DEFAULTS.POLL_MAX_INTERVAL_MS,
    { min: 250, max: 60000 }
  );
  const pollMaxRounds = _readInt(env, 'KHY_AMOO_POLL_MAX_ROUNDS', DEFAULTS.POLL_MAX_ROUNDS, {
    min: 1,
    max: 500,
  });
  const replyStableRounds = _readInt(
    env,
    'KHY_AMOO_REPLY_STABLE_ROUNDS',
    DEFAULTS.REPLY_STABLE_ROUNDS,
    { min: 1, max: 20 }
  );
  const mailboxTimeoutMs = _readInt(
    env,
    'KHY_AMOO_MAILBOX_TIMEOUT_MS',
    DEFAULTS.MAILBOX_TIMEOUT_MS,
    { min: 2000, max: 600000 }
  );
  const mailboxPollMs = _readInt(env, 'KHY_AMOO_MAILBOX_POLL_MS', DEFAULTS.MAILBOX_POLL_MS, {
    min: 250,
    max: 60000,
  });
  const maxResultChars = _readInt(
    env,
    'KHY_AMOO_MAX_RESULT_CHARS',
    DEFAULTS.MAX_RESULT_CHARS,
    { min: 500, max: 500000 }
  );

  const useForward = transport.value !== 'lan';
  // lan 传输要用设备 host 拼 baseUrl；serial 为空（未探测到设备）时留空串，
  // 而不是拼出 `http://:8896` 这种连不起来的坏 URL——空串让调用方看出「还没地址」。
  const lanHost = serial.value ? serial.value.split(':')[0] : '';
  const baseUrl = useForward
    ? buildLoopbackUrl(bridgeHost.value, bridgePort.value)
    : (lanHost ? buildLoopbackUrl(lanHost, bridgePort.value) : '');

  return {
    adb: {
      path: adbPath.value,
      pathSource: adbPath.source,
      serial: serial.value,
      // serial 来源，供 IO 层决定要不要走自动档（default → 探测并写回；env → 显式
      // 指定永远赢，不重探）。空默认也算 default，自动档逻辑照常触发。
      serialSource: serial.source === 'env' ? 'env' : 'default',
      connectHost: serial.value ? serial.value.split(':')[0] : '',
      connectPort: connectPort.value,
      timeoutMs: adbTimeoutMs.value,
    },
    bridge: {
      package: bridgePackage.value,
      host: bridgeHost.value,
      port: bridgePort.value,
      aliasPort: aliasPort.value,
      transport: useForward ? 'forward' : 'lan',
      baseUrl,
      tokenPath: `${bridgeDir.value}/token.txt`,
      dir: bridgeDir.value,
      httpTimeoutMs: httpTimeoutMs.value,
    },
    amoo: {
      package: amooPackage.value,
      activity: amooActivity.value,
      launchAction: launchAction.value,
      component: `${amooPackage.value}/${amooActivity.value}`,
      inputId: inputId.value,
      sendId: sendId.value,
      chatListId: chatListId.value,
      inputHints: inputHints.value
        .split(',')
        .map((hint) => hint.trim())
        .filter(Boolean),
    },
    dispatch: {
      launchWaitMs: launchWaitMs.value,
      inputWaitMs: inputWaitMs.value,
      sendWaitMs: sendWaitMs.value,
      pollIntervalMs: pollIntervalMs.value,
      pollMaxIntervalMs: Math.max(pollMaxIntervalMs.value, pollIntervalMs.value),
      pollMaxRounds: pollMaxRounds.value,
      replyStableRounds: replyStableRounds.value,
      uiDumpRemotePath: uiDumpPath.value,
      maxResultChars: maxResultChars.value,
    },
    mailbox: {
      dir: bridgeDir.value,
      timeoutMs: mailboxTimeoutMs.value,
      pollMs: mailboxPollMs.value,
    },
    local: {
      scratchSubdir: DEFAULTS.SCRATCH_SUBDIR,
    },
    gates: {
      enabled: _readFlag(env, 'KHY_AMOO_BRIDGE_ENABLED', true),
      mailboxEnabled: _readFlag(env, 'KHY_AMOO_MAILBOX_ENABLED', true),
    },
    sources: {
      adbPath: adbPath.source,
      serial: serial.source,
      bridgePort: bridgePort.source,
      bridgeTransport: transport.source,
      adbTimeoutMs: adbTimeoutMs.source,
      httpTimeoutMs: httpTimeoutMs.source,
      pollIntervalMs: pollIntervalMs.source,
      pollMaxRounds: pollMaxRounds.source,
      mailboxTimeoutMs: mailboxTimeoutMs.source,
    },
  };
}

module.exports = {
  DEFAULTS,
  LOOPBACK_HOST,
  BRIDGE_PACKAGE,
  AMOO_PACKAGE,
  AMOO_ACTIVITY,
  AMOO_LAUNCH_ACTION,
  AMOO_INPUT_ID,
  AMOO_SEND_ID,
  AMOO_CHAT_LIST_ID,
  BRIDGE_DIR,
  AMOO_INPUT_HINTS,
  resolveAmooConfig,
  buildLoopbackUrl,
};
