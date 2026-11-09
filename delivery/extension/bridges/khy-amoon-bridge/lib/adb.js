'use strict';

/**
 * adb.js — process-safe ADB transport and parsers.
 *
 * Design rules implemented here:
 *   - Every device-scoped command carries `-s <serial>`. The workstation in the
 *     design has two transports for the same phone, so `adb reverse --list`
 *     without `-s` fails with "more than one device/emulator".
 *   - Spawning is argv-only: `shell: true` is never used, so quoting bugs in a
 *     local path cannot turn into a local command injection.
 *   - Remote shell text is built from fixed tokens plus `shQuote()`-escaped
 *     user values; no tool concatenates raw user input into a phone command.
 *   - Output is bounded in memory (`maxBytes`) and processes are killed on
 *     timeout or when the cap is exceeded.
 *   - `exec-out` returns a Buffer untouched (screencap PNG must never be
 *     decoded/re-encoded; CRLF text conversion would corrupt it).
 *
 * Deliberate omissions (see ModuleReport issues):
 *   - No `reverse --remove-all`, no `kill-server`.
 *   - No arbitrary phone shell tool; `shell()` is an internal transport used by
 *     fixed handler command builders only.
 *
 * This module never throws from a parser; only command entry points throw
 * `BridgeError`, and callers (tool handlers) convert those to `{ok:false,...}`.
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const C = require('./contracts');

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const STDERR_MAX_BYTES = 64 * 1024;
const FORCE_SETTLE_MS = 1500;

/** States printed by `adb devices` line two. */
const DEVICE_STATES = Object.freeze([
  'device',
  'offline',
  'unauthorized',
  'bootloader',
  'recovery',
  'sideload',
  'connecting',
  'authorizing',
  'rescue',
  'fastboot',
  'host',
]);
const DEVICE_STATE_SET = new Set(DEVICE_STATES);

const PROP_KEYS = Object.freeze(['product', 'model', 'device', 'transport_id', 'usb']);

function invalid(code, message, details) {
  return new C.BridgeError(code, message, details);
}

/**
 * Reject values that can never be passed to spawn safely.
 * @param {unknown} command
 * @returns {string}
 */
function assertCommand(command) {
  if (typeof command !== 'string' || !command.trim()) {
    throw invalid('invalid_config', 'ADB 可执行文件路径为空');
  }
  const value = command.trim();
  if (value.includes('\u0000')) {
    throw invalid('invalid_config', 'ADB 路径包含 NUL 字符');
  }
  // On Windows Node 22 refuses to spawn .cmd/.bat without a shell (EINVAL).
  if (/\.(cmd|bat)$/i.test(value)) {
    throw invalid(
      'invalid_config',
      '不能直接 spawn .cmd/.bat（Windows 上会 EINVAL）；请把 KHY_ADB 指向 adb.exe，或用 KHY_ADB=<node.exe> + KHY_ADB_ARGS=["fake-adb.js"] 注入测试替身。',
      { command: value }
    );
  }
  return value;
}

/**
 * Parse KHY_ADB_ARGS. Mirrors lib/config.js but keeps this module standalone.
 * @param {string|undefined|null} raw
 * @returns {string[]}
 */
function parseArgsPrefix(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw invalid('invalid_config', 'KHY_ADB_ARGS 必须是 JSON 字符串数组');
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw invalid('invalid_config', 'KHY_ADB_ARGS 必须是 JSON 字符串数组');
  }
  return parsed;
}

function isFileSync(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the adb executable without spawning anything.
 *
 * Order: KHY_ADB (explicit) -> PATH scan -> common SDK/platform-tools paths ->
 * literal "adb" (let spawn fail with a precise adb_unavailable later).
 *
 * @param {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform}} [options]
 * @returns {{command: string, argsPrefix: string[], source: string}}
 */
function resolveAdb(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const argsPrefix = parseArgsPrefix(env[C.ENV.adbArgs]);

  const explicit = env[C.ENV.adb];
  if (typeof explicit === 'string' && explicit.trim()) {
    return { command: assertCommand(explicit), argsPrefix, source: 'env' };
  }

  const exeName = platform === 'win32' ? 'adb.exe' : 'adb';
  const pathValue = env.PATH || env.Path || '';
  const pathSep = platform === 'win32' ? ';' : ':';
  for (const dir of String(pathValue).split(pathSep)) {
    const trimmed = dir.trim().replace(/^"|"$/g, '');
    if (!trimmed) continue;
    const candidate = path.join(trimmed, exeName);
    if (isFileSync(candidate)) {
      return { command: candidate, argsPrefix, source: 'path' };
    }
  }

  const roots = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    // 便携工具目录由环境变量指路：KHY_ADB_ROOT=<含 platform-tools 的目录>。
    // 原来这里写死了作者机器上的 'D:/Portable/Tools/platform-tools' ——
    // 那条路径对任何别的机器都不成立（守卫 RUNTIME-001 / Rule 1c 判的就是它）。
    env.KHY_ADB_ROOT,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Android', 'Sdk') : null,
  ].filter((value) => typeof value === 'string' && value.trim());

  for (const root of roots) {
    const candidate = path.join(root, 'platform-tools', exeName);
    if (isFileSync(candidate)) {
      return { command: candidate, argsPrefix, source: 'sdk' };
    }
    const direct = path.join(root, exeName);
    if (isFileSync(direct)) {
      return { command: direct, argsPrefix, source: 'sdk' };
    }
  }

  return { command: 'adb', argsPrefix, source: 'lookup' };
}

// ── Quoting / input validation ──────────────────────────────────────────────

/**
 * POSIX single-quote a value for a remote (`adb shell`) command line.
 * The returned token is safe for sh/toybox; empty values become ''.
 *
 * @param {unknown} value
 * @returns {string}
 */
function shQuote(value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (text.includes('\u0000')) {
    throw invalid('invalid_args', '参数包含 NUL 字符');
  }
  if (text === '') return "''";
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * Validate text intended for `input text`: printable ASCII only.
 * Chinese input is rejected because `adb shell input text` throws an NPE for
 * non-ASCII on the measured device; use the file/Intent channel instead.
 *
 * @param {unknown} value
 * @returns {string}
 */
function assertAsciiText(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid('invalid_args', 'text 必须是非空字符串');
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7e) {
      throw invalid('unsupported_non_ascii', '该工具只接受 ASCII 文本；中文请走文件或 Intent 通道');
    }
    if (code < 0x20) {
      throw invalid('invalid_args', 'text 不能包含控制字符');
    }
  }
  return value;
}

/**
 * Validate a mailbox blob file name. Leaf only; no separators, no traversal.
 * @param {unknown} name
 * @returns {string}
 */
function assertSafeRemoteName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
    throw invalid('invalid_args', `非法的远端文件名：${String(name)}`, {
      rule: '只允许字母、数字、点、下划线、连字符（1..128）',
    });
  }
  if (name === '.' || name === '..' || name.includes('..')) {
    throw invalid('invalid_args', `非法的远端文件名：${name}`);
  }
  return name;
}

// ── Low-level process runner ────────────────────────────────────────────────

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {});
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // fall through to the direct kill below
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
}

/**
 * Spawn a process and capture bounded stdout/stderr. Never uses a shell.
 *
 * Resolves with `{exit, stdout:Buffer, stderr, truncated, timedOut, signal}`.
 * Rejects only when the executable cannot be started (ENOENT/EACCES...).
 *
 * @param {string} command
 * @param {string[]} argv
 * @param {{timeoutMs?: number, maxBytes?: number}} [options]
 * @returns {Promise<{exit:number,stdout:Buffer,stderr:string,truncated:boolean,timedOut:boolean,signal:string|null}>}
 */
function runProcess(command, argv, options = {}) {
  const timeoutMs = clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 600000);
  const maxBytes = clampInt(options.maxBytes, DEFAULT_MAX_BYTES, 1, C.LIMITS.responseHardMaxBytes);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(assertCommand(command), argv, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(invalid('adb_unavailable', `无法启动 adb：${command}`, { cause: String(err && err.message) }));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let spawnError = null;
    let forceTimer = null;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // Never leave the caller hanging if a wedged process ignores the kill.
      forceTimer = setTimeout(() => finish(null), FORCE_SETTLE_MS);
      if (forceTimer.unref) forceTimer.unref();
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes >= maxBytes) {
        truncated = true;
        return;
      }
      const remaining = maxBytes - stdoutBytes;
      if (chunk.length > remaining) {
        stdoutChunks.push(Buffer.from(chunk.subarray(0, remaining)));
        stdoutBytes += remaining;
        truncated = true;
        killTree(child);
      } else {
        stdoutChunks.push(Buffer.from(chunk));
        stdoutBytes += chunk.length;
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= STDERR_MAX_BYTES) return;
      const remaining = STDERR_MAX_BYTES - stderrBytes;
      stderrBytes += Math.min(chunk.length, remaining);
      stderrChunks.push(Buffer.from(chunk.subarray(0, remaining)));
    });

    child.on('error', (err) => {
      spawnError = err;
      finish(null);
    });

    child.on('close', (code, signal) => {
      finish(code === null ? -1 : code, signal);
    });

    function finish(code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);

      if (spawnError) {
        reject(
          invalid('adb_unavailable', `无法启动 adb：${command}`, {
            cause: String(spawnError.message || spawnError.code || 'spawn_error'),
          })
        );
        return;
      }

      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      resolve({
        exit: typeof code === 'number' ? code : -1,
        stdout: Buffer.concat(stdoutChunks),
        stderr,
        truncated,
        timedOut,
        signal: signal || null,
      });
    }
  });
}

// ── Parsers (pure) ──────────────────────────────────────────────────────────

/**
 * Parse `adb devices -l`.
 *
 * Serial names for mDNS transports contain spaces and parentheses
 * (`adb-... (2)._adb-tls-connect._tcp`), so the state token is located from the
 * right instead of splitting on the first whitespace.
 *
 * @param {string} text
 * @returns {Array<{serial:string,state:string,product:string|null,model:string|null,device:string|null,transportId:number|null,props:object}>}
 */
function parseDevices(text) {
  const entries = [];
  if (typeof text !== 'string') return entries;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^List of devices/i.test(line)) continue;
    if (/^\*/.test(line)) continue;
    if (/^adb server/i.test(line)) continue;

    const tokens = line.split(/\s+/);
    let stateIndex = -1;
    for (let index = tokens.length - 1; index >= 1; index -= 1) {
      if (DEVICE_STATE_SET.has(tokens[index])) {
        stateIndex = index;
        break;
      }
    }
    if (stateIndex < 0) continue;

    const serial = tokens.slice(0, stateIndex).join(' ');
    if (!serial || serial.startsWith('-')) continue;

    const props = {};
    for (let index = stateIndex + 1; index < tokens.length; index += 1) {
      const match = /^([A-Za-z0-9_]+):(.*)$/.exec(tokens[index]);
      if (!match || !PROP_KEYS.includes(match[1])) continue;
      props[match[1]] = match[2];
    }

    entries.push({
      serial,
      state: tokens[stateIndex],
      product: props.product || null,
      model: props.model || null,
      device: props.device || null,
      transportId: props.transport_id ? Number(props.transport_id) : null,
      props,
    });
  }
  return entries;
}

/**
 * Parse `adb mdns services` lines like:
 *   adb-ZYPZ... (2)    _adb-tls-connect._tcp    192.168.2.46:33743
 * The instance name may contain spaces, parentheses and tabs.
 *
 * @param {string} text
 * @returns {Array<{name:string,service:string,kind:string,host:string,port:number,address:string}>}
 */
function parseMdns(text) {
  const entries = [];
  if (typeof text !== 'string') return entries;
  const lineRe = /^(.*?)[\t ]+(_adb-[A-Za-z0-9-]+\._tcp)[\t ]+(\[[^\]]+\]|[^\s:]+):(\d+)\s*$/;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^List of discovered/i.test(line)) continue;
    const match = lineRe.exec(line);
    if (!match) continue;
    const [, name, service, rawHost, rawPort] = match;
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const host = rawHost.replace(/^\[|\]$/g, '');
    entries.push({
      name: name.trim(),
      service,
      kind: service.includes('pairing') ? 'pairing' : service.includes('connect') ? 'connect' : 'other',
      host,
      port,
      address: `${rawHost}:${port}`,
    });
  }
  return entries;
}

/**
 * Parse `adb reverse --list` lines (`tcp:18765 tcp:18765`, optionally prefixed
 * by a serial/transport name).
 *
 * @param {string} text
 * @returns {Array<{serial:string|null,remotePort:number,localPort:number,raw:string}>}
 */
function parseReverseList(text) {
  const entries = [];
  if (typeof text !== 'string') return entries;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) continue;
    const right = /^tcp:(\d+)$/.exec(tokens[tokens.length - 1]);
    const left = /^tcp:(\d+)$/.exec(tokens[tokens.length - 2]);
    if (!left || !right) continue;
    entries.push({
      serial: tokens.length > 2 ? tokens.slice(0, -2).join(' ') : null,
      remotePort: Number(left[1]),
      localPort: Number(right[1]),
      raw: line,
    });
  }
  return entries;
}

// ── Transport ───────────────────────────────────────────────────────────────

function trimForMessage(text, max = 400) {
  const value = String(text || '')
    .replace(/\r/g, '')
    .trim();
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/**
 * Create the ADB transport used as `ctx.adb`.
 *
 * Additive helpers beyond the frozen Transport (documented in ModuleReport):
 *   setSerial(serial) / getSerial()
 *   host(argv, {serial:false|string, timeoutMs, maxBytes})   // devices/mdns/reverse/connect
 *   setDeviceInfo({model,sdk}) / setReverse({port,mapped,lastOk})
 *
 * @param {{config?: object, logger?: object, serial?: string}} [options]
 * @returns {object} Transport
 */
function selectAdbSource(config) {
  const configured = config && config.adb && typeof config.adb === 'object' ? config.adb : null;
  if (!configured) return resolveAdb({});
  if (configured.command && configured.command !== 'adb') return configured;
  // Default "adb" was not found by `where adb` on the measured host; look in
  // PATH/SDK/platform-tools before giving up. Explicit commands win.
  const discovered = resolveAdb({});
  if (discovered.command !== 'adb') {
    return {
      command: discovered.command,
      argsPrefix:
        Array.isArray(configured.argsPrefix) && configured.argsPrefix.length > 0
          ? configured.argsPrefix
          : discovered.argsPrefix,
    };
  }
  return configured;
}

function createAdbTransport(options = {}) {
  const config = options.config || {};
  const source = selectAdbSource(config);
  const command = assertCommand(source.command || 'adb');
  const argsPrefix = Array.isArray(source.argsPrefix) ? [...source.argsPrefix] : [];
  const logger = options.logger || { debug() {}, info() {}, warn() {}, error() {} };

  let currentSerial = options.serial || config.serial || null;
  let lastError = null;
  let lastSeen = null;
  let deviceInfo = { model: null, sdk: null };
  let reverseInfo = { port: null, mapped: false, lastOk: null };

  function requireSerial() {
    if (!currentSerial) {
      throw invalid(
        'adb_unavailable',
        '尚未解析出设备 serial：请先运行无线发现，或设置 KHY_AMOON_SERIAL。',
        { reason: 'serial_unresolved' }
      );
    }
    return currentSerial;
  }

  function noteResult(result, hostLevel) {
    lastSeen = Date.now();
    if (result.timedOut) {
      lastError = { code: 'timeout', message: 'adb 命令超时', at: new Date(lastSeen).toISOString() };
    } else if (hostLevel && result.exit !== 0) {
      lastError = {
        code: 'adb_exit',
        message: trimForMessage(result.stderr) || `adb 退出码 ${result.exit}`,
        at: new Date(lastSeen).toISOString(),
      };
    } else {
      lastError = null;
    }
  }

  function shape(result) {
    return {
      exit: result.exit,
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr,
      truncated: result.truncated,
      timedOut: result.timedOut,
    };
  }

  /**
   * Run a host-side adb command. `opts.serial === false` skips `-s` (only for
   * devices/mdns/connect/pair); a string pins that serial for this call.
   */
  async function host(argv, opts = {}) {
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((item) => typeof item !== 'string')) {
      throw invalid('invalid_args', 'adb 参数必须是字符串数组');
    }
    if (argv.some((item) => item.includes('\u0000'))) {
      throw invalid('invalid_args', 'adb 参数包含 NUL 字符');
    }
    const prefix = [];
    let serialForCall = null;
    if (opts.serial === false) {
      serialForCall = null;
    } else if (typeof opts.serial === 'string' && opts.serial) {
      serialForCall = opts.serial;
    } else {
      serialForCall = requireSerial();
    }
    if (serialForCall) prefix.push('-s', serialForCall);

    const result = await runProcess(command, [...argsPrefix, ...prefix, ...argv], {
      timeoutMs: opts.timeoutMs,
      maxBytes: opts.maxBytes,
    });
    noteResult(result, true);
    return shape(result);
  }

  async function shell(cmd, opts = {}) {
    if (typeof cmd !== 'string' || !cmd.trim()) {
      throw invalid('invalid_args', 'shell 命令必须是非空字符串');
    }
    if (Buffer.byteLength(cmd, 'utf8') > C.LIMITS.commandBytes) {
      throw invalid('payload_too_large', 'shell 命令超过 256KB');
    }
    const serial = requireSerial();
    const result = await runProcess(
      command,
      [...argsPrefix, '-s', serial, 'shell', cmd],
      { timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes }
    );
    noteResult(result, false);
    return shape(result);
  }

  async function execOut(cmd, opts = {}) {
    if (typeof cmd !== 'string' || !cmd.trim()) {
      throw invalid('invalid_args', 'exec-out 命令必须是非空字符串');
    }
    if (Buffer.byteLength(cmd, 'utf8') > C.LIMITS.commandBytes) {
      throw invalid('payload_too_large', 'exec-out 命令超过 256KB');
    }
    const serial = requireSerial();
    const result = await runProcess(
      command,
      [...argsPrefix, '-s', serial, 'exec-out', cmd],
      { timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes }
    );
    noteResult(result, false);
    return {
      exit: result.exit,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      timedOut: result.timedOut,
    };
  }

  async function push(local, remote, opts = {}) {
    if (typeof local !== 'string' || !local || local.includes('\u0000')) {
      throw invalid('invalid_args', '本地路径不合法');
    }
    if (typeof remote !== 'string' || !remote || remote.startsWith('-') || remote.includes('\u0000')) {
      throw invalid('invalid_args', '远端路径不合法');
    }
    const absoluteLocal = path.resolve(local);
    let stat;
    try {
      stat = fs.statSync(absoluteLocal);
    } catch {
      throw invalid('invalid_args', `本地文件不存在：${absoluteLocal}`);
    }
    if (!stat.isFile()) throw invalid('invalid_args', `本地路径不是文件：${absoluteLocal}`);
    if (stat.size > C.LIMITS.blobBytes) {
      throw invalid('payload_too_large', `文件超过 ${C.LIMITS.blobBytes} 字节上限`);
    }

    const serial = requireSerial();
    const result = await runProcess(
      command,
      [...argsPrefix, '-s', serial, 'push', absoluteLocal, remote],
      { timeoutMs: opts.timeoutMs || 120000, maxBytes: opts.maxBytes || 1024 * 1024 }
    );
    // A push can fail on a bad remote path or permission without adb itself
    // being down; only a timeout marks the transport degraded here.
    noteResult(result, false);
    if (result.timedOut) throw invalid('timeout', `adb push 超时：${remote}`);
    if (result.exit !== 0) {
      throw invalid('internal_error', `adb push 失败：${trimForMessage(result.stderr) || `退出码 ${result.exit}`}`, {
        remote,
      });
    }
    return { bytes: stat.size, remote };
  }

  async function pull(remote, local, opts = {}) {
    if (typeof remote !== 'string' || !remote || remote.startsWith('-') || remote.includes('\u0000')) {
      throw invalid('invalid_args', '远端路径不合法');
    }
    if (typeof local !== 'string' || !local || local.includes('\u0000')) {
      throw invalid('invalid_args', '本地路径不合法');
    }
    const absoluteLocal = path.resolve(local);
    const maxBytes = clampInt(opts.maxBytes, C.LIMITS.responseHardMaxBytes, 1, C.LIMITS.responseHardMaxBytes);
    fs.mkdirSync(path.dirname(absoluteLocal), { recursive: true });

    const serial = requireSerial();
    const result = await runProcess(
      command,
      [...argsPrefix, '-s', serial, 'pull', remote, absoluteLocal],
      { timeoutMs: opts.timeoutMs || 120000, maxBytes: 1024 * 1024 }
    );
    noteResult(result, false);
    if (result.timedOut) throw invalid('timeout', `adb pull 超时：${remote}`);
    if (result.exit !== 0) {
      throw invalid('internal_error', `adb pull 失败：${trimForMessage(result.stderr) || `退出码 ${result.exit}`}`, {
        remote,
      });
    }

    let stat;
    try {
      stat = fs.statSync(absoluteLocal);
    } catch {
      throw invalid('internal_error', `adb pull 未生成文件：${absoluteLocal}`);
    }
    if (stat.size > maxBytes) {
      try {
        fs.unlinkSync(absoluteLocal);
      } catch {
        // best effort
      }
      throw invalid('payload_too_large', `拉取结果超过 ${maxBytes} 字节上限`, { remote });
    }
    return { bytes: stat.size, local: absoluteLocal, sha256: sha256File(absoluteLocal) };
  }

  function setSerial(serial) {
    if (typeof serial !== 'string' || !serial || serial.includes('\u0000')) {
      throw invalid('invalid_args', 'serial 不合法');
    }
    currentSerial = serial;
    logger.info('adb serial set', { serial });
    return currentSerial;
  }

  function getSerial() {
    return currentSerial;
  }

  function setDeviceInfo(info) {
    if (info && typeof info === 'object') {
      if (info.model !== undefined) deviceInfo.model = info.model;
      if (info.sdk !== undefined) deviceInfo.sdk = info.sdk;
    }
    return { ...deviceInfo };
  }

  function setReverse(info) {
    if (info && typeof info === 'object') {
      reverseInfo = {
        port: info.port !== undefined ? info.port : reverseInfo.port,
        mapped: info.mapped !== undefined ? Boolean(info.mapped) : reverseInfo.mapped,
        lastOk: info.lastOk !== undefined ? info.lastOk : reverseInfo.lastOk,
      };
    }
    return { ...reverseInfo };
  }

  function snapshot() {
    let state = 'STOPPED';
    if (lastError) state = C.STATES.DEGRADED_ADB;
    else if (lastSeen) state = C.STATES.HEALTHY;
    return {
      state,
      serial: currentSerial,
      model: deviceInfo.model,
      sdk: deviceInfo.sdk,
      reverse: { ...reverseInfo },
      lastError,
      lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
    };
  }

  return {
    command,
    argsPrefix: [...argsPrefix],
    host,
    shell,
    execOut,
    push,
    pull,
    setSerial,
    getSerial,
    setDeviceInfo,
    setReverse,
    snapshot,
    resolveAdb: () => resolveAdb({}),
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  DEVICE_STATES,
  resolveAdb,
  selectAdbSource,
  parseArgsPrefix,
  assertCommand,
  shQuote,
  assertAsciiText,
  assertSafeRemoteName,
  runProcess,
  parseDevices,
  parseMdns,
  parseReverseList,
  createAdbTransport,
};
