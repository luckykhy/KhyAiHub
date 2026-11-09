'use strict';

/**
 * config.js — the single source of runtime configuration.
 *
 * Rules:
 *   - Pure at require time: nothing is created, read, or spawned until a
 *     function is called.
 *   - State lives per Windows user by default: %LOCALAPPDATA%\khy-amoon-bridge.
 *     KHY_AMOON_HOME may override it, but doctor must warn when that points at
 *     a shared/portable directory.
 *   - Tokens are never returned by describeConfig(); only presence/length.
 *   - No ADB probing here (module B owns discovery); this file only carries the
 *     KHY_ADB / KHY_ADB_ARGS overrides.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require('./contracts');

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/** Extension root (this file is <root>/lib/config.js). */
const EXT_ROOT = path.resolve(__dirname, '..');

/**
 * Default per-user state root.
 *
 * @param {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform}} [options]
 * @returns {string} absolute path
 */
function resolveStateDir(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;

  const override = env[C.ENV.home];
  if (typeof override === 'string' && override.trim()) {
    return path.resolve(override.trim());
  }

  const localAppData = env.LOCALAPPDATA;
  if (typeof localAppData === 'string' && localAppData.trim()) {
    return path.join(path.resolve(localAppData.trim()), C.LOCAL_DIR_NAME);
  }

  if (platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Local', C.LOCAL_DIR_NAME);
  }
  return path.join(os.homedir(), '.local', 'state', C.LOCAL_DIR_NAME);
}

/**
 * All local paths derived from one state directory.
 *
 * @param {string} stateDir absolute
 */
function buildPaths(stateDir) {
  const dirs = {};
  for (const [key, rel] of Object.entries(C.LOCAL_SUBDIRS)) {
    dirs[key] = path.join(stateDir, rel);
  }
  return {
    stateDir,
    runtime: path.join(stateDir, C.STATE_FILES.runtime),
    tokens: path.join(stateDir, C.STATE_FILES.tokens),
    operatorToken: path.join(stateDir, C.STATE_FILES.operatorToken),
    lock: path.join(stateDir, C.STATE_FILES.lock),
    log: path.join(stateDir, C.STATE_FILES.log),
    mailboxIndex: path.join(stateDir, C.STATE_FILES.mailboxIndex),
    capability: path.join(stateDir, C.STATE_FILES.capability),
    dirs,
  };
}

/**
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function parsePort(raw, fallback = C.DEFAULTS.port) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const text = String(raw).trim();
  if (!/^\d{1,5}$/.test(text)) {
    throw new C.BridgeError('invalid_config', `端口必须是整数：${text}`);
  }
  const port = Number(text);
  if (port < 1024 || port > 65535) {
    throw new C.BridgeError('invalid_config', `端口必须在 1024..65535：${port}`);
  }
  return port;
}

/**
 * KHY_ADB_ARGS is a JSON array of extra argv placed before the adb subcommand.
 * The documented use is a fake adb: KHY_ADB=<node.exe> KHY_ADB_ARGS=["test/fake-adb.js"].
 *
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function parseAdbArgs(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new C.BridgeError('invalid_config', 'KHY_ADB_ARGS 必须是 JSON 字符串数组');
  }
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
    throw new C.BridgeError('invalid_config', 'KHY_ADB_ARGS 必须是 JSON 字符串数组');
  }
  return parsed;
}

/**
 * @param {string|undefined} raw
 * @returns {string|null}
 */
function parseSerial(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const serial = String(raw).trim();
  // Device serials are host:port or adb-<serial>-<suffix>; keep the alphabet
  // tight so a value can never be mistaken for an adb flag or a path.
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(serial) || serial.startsWith('-')) {
    throw new C.BridgeError('invalid_config', `KHY_AMOON_SERIAL 含有非法字符：${serial}`);
  }
  return serial;
}

/**
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function parseCwdAllowlist(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [EXT_ROOT];
  return String(raw)
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
}

/**
 * Load and validate the full configuration.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   stateDir?: string,
 *   khyJs?: string,
 * }} [options]
 * @returns {object} plain config (never contains token material)
 */
function loadConfig(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;

  const stateDir = options.stateDir ? path.resolve(options.stateDir) : resolveStateDir({ env, platform });
  const port = parsePort(env[C.ENV.port]);
  const serial = parseSerial(env[C.ENV.serial]);

  const logLevelRaw = env[C.ENV.logLevel] || C.DEFAULTS.logLevel;
  const logLevel = String(logLevelRaw).trim().toLowerCase();
  if (!LOG_LEVELS.has(logLevel)) {
    throw new C.BridgeError('invalid_config', `KHY_AMOON_LOG_LEVEL 只能是 debug/info/warn/error：${logLevelRaw}`);
  }

  const paths = buildPaths(stateDir);

  return {
    version: C.BRIDGE_VERSION,
    protocol: C.PROTOCOL,
    extensionId: C.EXTENSION_ID,
    namespace: C.NAMESPACE,

    host: C.DEFAULTS.host,
    port,
    portScanMax: C.DEFAULTS.portScanMax,

    stateDir,
    paths,
    extRoot: EXT_ROOT,
    // false when KHY_AMOON_HOME overrides the per-user default; doctor warns.
    stateIsDefault: !(env[C.ENV.home] && String(env[C.ENV.home]).trim()),

    serial,
    adb: {
      command: env[C.ENV.adb] || 'adb',
      argsPrefix: parseAdbArgs(env[C.ENV.adbArgs]),
    },
    khy: {
      js: options.khyJs || env[C.ENV.khyJs] || null,
    },
    cwdAllowlist: parseCwdAllowlist(env[C.ENV.cwdAllowlist]),

    enabled: String(env[C.ENV.enabled] || '1') !== '0',
    allowPhoneAsk: String(env[C.ENV.phoneAsk] || '0') === '1',
    allowHighRisk: String(env[C.ENV.allowHighRisk] || '0') === '1',

    log: {
      level: logLevel,
      file: paths.log,
      maxBytes: C.LIMITS.logMaxBytes,
      retainDays: C.LIMITS.logRetainDays,
    },

    // Read-only references, not copies: the contract is shared verbatim.
    remote: {
      root: C.REMOTE_ROOT,
      dirs: C.REMOTE_DIRS,
      files: C.REMOTE_FILES,
    },
    limits: C.LIMITS,
    rateLimits: C.RATE_LIMITS,
  };
}

/**
 * Create state directories (never token files, never daemon files).
 * Idempotent.
 *
 * @param {object} config
 * @returns {string[]} directories ensured
 */
function ensureStateDirs(config) {
  const dirs = [config.stateDir, ...Object.values(config.paths.dirs)];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dirs;
}

/**
 * Read the raw operator token, or null when absent/unreadable.
 * Callers that must fail closed should use requireOperatorToken().
 *
 * @param {object} config
 * @returns {string|null}
 */
function readOperatorToken(config) {
  try {
    const raw = fs.readFileSync(config.paths.operatorToken, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Fail-closed token accessor: missing/corrupt/too-short is auth_unavailable.
 *
 * @param {object} config
 * @returns {string}
 */
function requireOperatorToken(config) {
  const token = readOperatorToken(config);
  if (!token || token.length < C.LIMITS.tokenMinLength) {
    throw new C.BridgeError(
      'auth_unavailable',
      'operator token 缺失或过短；daemon 拒绝服务（fail-closed）。请先运行 token 初始化（模块 A）。'
    );
  }
  return token;
}

/**
 * Token metadata for diagnostics; never the value.
 *
 * @param {object} config
 * @returns {{present:boolean, valid:boolean, length:number}}
 */
function describeToken(config) {
  const token = readOperatorToken(config);
  return {
    present: token !== null,
    valid: token !== null && token.length >= C.LIMITS.tokenMinLength,
    length: token ? token.length : 0,
  };
}

/**
 * Redacted configuration snapshot for status/doctor/logs.
 *
 * @param {object} config
 * @returns {object}
 */
function describeConfig(config) {
  return {
    version: config.version,
    protocol: config.protocol,
    enabled: config.enabled,
    host: config.host,
    port: config.port,
    stateDir: config.stateDir,
    stateDirExists: fs.existsSync(config.stateDir),
    serial: config.serial,
    adb: { command: config.adb.command, argsPrefix: config.adb.argsPrefix },
    khyJs: config.khy.js,
    log: { level: config.log.level, file: config.log.file },
    security: {
      allowPhoneAsk: config.allowPhoneAsk,
      allowHighRisk: config.allowHighRisk,
      operatorToken: describeToken(config),
      stateIsDefaultPerUser: config.stateIsDefault,
    },
  };
}

module.exports = {
  EXT_ROOT,
  LOG_LEVELS,
  resolveStateDir,
  buildPaths,
  parsePort,
  parseAdbArgs,
  parseSerial,
  parseCwdAllowlist,
  loadConfig,
  ensureStateDirs,
  readOperatorToken,
  requireOperatorToken,
  describeToken,
  describeConfig,
};
