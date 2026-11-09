'use strict';

/**
 * daemon.js — single-instance assembly for the bridge.
 *
 * Startup order:
 *   1. state dir + operator token (fail-closed provisioning)
 *   2. logger / audit / ADB transport / wireless lifecycle
 *   3. local-tools + phone-tools + registry (12 wire tools; local tools are internal only)
 *   4. HTTP server on 127.0.0.1 (port scan 18765..18774), runtime.json
 *   5. task queue, mailbox poller (polling starts only when ADB is usable)
 *   6. wireless.start() in the background; failures degrade, never crash
 *
 * Shutdown removes its own adb reverse mapping, clears every timer, stops the
 * mailbox/tasks queues, closes HTTP, deletes runtime.json and the lock.
 *
 * This module never calls a real model. `khy_ask` is only executed when a client
 * actually invokes it; the daemon itself just wires the runner.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const C = require('./contracts');
const { loadConfig, ensureStateDirs, requireOperatorToken } = require('./config');
const { createLogger } = require('./logger');
const { createAudit } = require('./audit');
const { ensureTokenFile, createCompositeAuth, hardenDirectory } = require('./auth');
const { createAdbTransport, parseReverseList, shQuote } = require('./adb');
const { createWireless } = require('./wireless');
const { createPhoneTools } = require('./phone-tools');
const { createLocalTools } = require('./local-tools');
const { createMailbox } = require('./mailbox');
const { createTaskQueue } = require('./tasks');
const { createRegistry } = require('./registry');
const { createServer } = require('./server');
const { findKhyOsInstallation } = require('./khy-tools');

const LOCK_RETRY_MS = 12000;
const TERM_WAIT_MS = 6000;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function readJsonFile(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Loopback /health probe without loading the MCP client module. */
function healthCheck(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: timeoutMs },
      (res) => {
        res.resume();
        done(res.statusCode === 200);
      }
    );
    req.on('error', () => done(false));
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
  });
}

/**
 * @param {object} config
 * @returns {object|null} runtime.json contents
 */
function readRuntime(config) {
  const runtime = readJsonFile(config.paths.runtime);
  if (!runtime) return null;
  if (!Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535) return null;
  if (!Number.isInteger(runtime.pid) || runtime.pid <= 0) return null;
  return runtime;
}

function writeRuntime(config, info) {
  writeJsonAtomic(config.paths.runtime, info);
}

function removeRuntimeIfOurs(config, pid = process.pid) {
  const runtime = readRuntime(config);
  if (runtime && runtime.pid !== pid) return false;
  try {
    fs.rmSync(config.paths.runtime, { force: true });
    return true;
  } catch {
    return false;
  }
}

function readLock(config) {
  return readJsonFile(config.paths.lock);
}

function acquireLock(config, logger) {
  const payload = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    exe_path: process.execPath,
    cmdline: process.argv.join(' '),
    cmdline_hash: sha256(process.argv.join(' ')),
    state_dir: config.stateDir,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(config.paths.lock, 'wx');
      try {
        fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return {
        file: config.paths.lock,
        release() {
          const current = readLock(config);
          if (current && current.pid === process.pid) {
            try {
              fs.rmSync(config.paths.lock, { force: true });
            } catch {
              // best effort
            }
          }
        },
      };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        throw new C.BridgeError('invalid_config', `无法创建 daemon.lock：${err && err.message}`);
      }
      const existing = readLock(config);
      if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) {
        throw new C.BridgeError('invalid_config', `daemon 已在运行（pid=${existing.pid}）`, {
          lock: config.paths.lock,
        });
      }
      logger.warn('removing stale daemon.lock', { pid: existing && existing.pid });
      try {
        fs.rmSync(config.paths.lock, { force: true });
      } catch {
        // retry
      }
    }
  }
  throw new C.BridgeError('invalid_config', '无法获取 daemon.lock（重试 3 次失败）');
}

/**
 * Identify a PID through WMI on Windows or /proc elsewhere. Used by stop so a
 * recycled PID is never killed by mistake.
 *
 * @param {number} pid
 * @returns {{pid:number, exePath:string|null, commandLine:string|null, creationDate:string|null}|null}
 */
function getProcessIdentity(pid) {
  if (!isPidAlive(pid)) return null;
  if (process.platform === 'win32') {
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue`,
      'if ($p) { $p | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress }',
    ].join('; ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) return null;
    try {
      const parsed = JSON.parse(result.stdout.trim());
      const row = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!row) return null;
      return {
        pid: Number(row.ProcessId),
        exePath: row.ExecutablePath || null,
        commandLine: row.CommandLine || null,
        creationDate: row.CreationDate ? String(row.CreationDate) : null,
      };
    } catch {
      return null;
    }
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\u0000').filter(Boolean).join(' ');
    let exePath = null;
    try {
      exePath = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      // permission denied is fine
    }
    return { pid, exePath, commandLine: cmdline, creationDate: null };
  } catch {
    return null;
  }
}

function sameIdentity(runtime, identity) {
  if (!identity) return false;
  const cmd = String(identity.commandLine || '').replace(/\\/g, '/');
  // Accept the detached daemon entry or the --foreground CLI entry. Matching
  // only the node.exe path would also match every other Node process.
  const isDetached = cmd.includes('bin/daemon.js');
  const isForeground = cmd.includes('bin/cli.js') && cmd.includes('--foreground');
  if (!isDetached && !isForeground) return false;
  if (runtime.exe_path && identity.exePath) {
    return path.resolve(runtime.exe_path).toLowerCase() === path.resolve(identity.exePath).toLowerCase();
  }
  return true;
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

/**
 * Stop the daemon recorded in runtime.json after checking process identity.
 *
 * @param {{config: object, force?: boolean, logger?: object}} options
 * @returns {Promise<{stopped:boolean, pid?:number, port?:number, reason?:string, forced?:boolean}>}
 */
async function stopDaemon(options = {}) {
  const config = options.config;
  const logger = options.logger || { debug() {}, info() {}, warn() {}, error() {} };
  const runtime = readRuntime(config);
  if (!runtime) {
    return { stopped: false, reason: 'not_running' };
  }
  const pid = runtime.pid;
  if (!isPidAlive(pid)) {
    removeRuntimeIfOurs(config, pid);
    const lock = readLock(config);
    if (lock && lock.pid === pid) {
      try {
        fs.rmSync(config.paths.lock, { force: true });
      } catch {
        // best effort
      }
    }
    return { stopped: false, pid, reason: 'already_dead', cleaned: true };
  }

  if (options.force !== true) {
    const identity = getProcessIdentity(pid);
    if (!identity || !sameIdentity(runtime, identity)) {
      throw new C.BridgeError(
        'invalid_config',
        `PID ${pid} 的身份与 runtime.json 不符，拒绝停止（防止误杀）。确认后可用 --force。`,
        {
          pid,
          expected_exe: runtime.exe_path || null,
          actual_exe: identity ? identity.exePath : null,
        }
      );
    }
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    logger.warn('SIGTERM failed; will try force kill', { pid, error: err && err.message });
  }

  let exited = await waitForExit(pid, TERM_WAIT_MS);
  let forced = false;
  if (!exited) {
    forced = true;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    exited = await waitForExit(pid, 3000);
  }

  // Best-effort: remove only our reverse port, never --remove-all, then assert
  // it is gone. A failure is reported rather than silently leaving the port.
  const serial = runtime.serial || config.serial;
  let reverseRemoved = null;
  let reverseError = null;
  if (serial) {
    try {
      const transport = createAdbTransport({ config, logger, serial });
      await transport.host(['reverse', '--remove', `tcp:${runtime.port}`], {
        serial,
        timeoutMs: 5000,
      });
      const listed = await transport.host(['reverse', '--list'], { serial, timeoutMs: 5000 });
      const entries = parseReverseList(listed.stdout || '');
      reverseRemoved = !entries.some(
        (entry) => entry.remotePort === runtime.port || entry.localPort === runtime.port
      );
      if (!reverseRemoved) {
        reverseError = `reverse tcp:${runtime.port} 仍存在`;
        logger.warn('reverse still present after stop', { port: runtime.port });
      }
    } catch (err) {
      reverseRemoved = false;
      reverseError = err && err.message ? err.message : String(err);
      logger.warn('reverse cleanup after stop failed', { error: reverseError });
    }
  }

  removeRuntimeIfOurs(config, pid);
  const lock = readLock(config);
  if (lock && lock.pid === pid) {
    try {
      fs.rmSync(config.paths.lock, { force: true });
    } catch {
      // best effort
    }
  }

  return { stopped: true, pid, port: runtime.port, forced, exited, reverse_removed: reverseRemoved, reverse_error: reverseError };
}

/**
 * Build a server auth adapter that accepts the operator token file AND
 * phone-scope tokens issued by TokenStore. The server still fails closed when
 * the operator token file is missing.
 */
function createServerAuth(config, logger) {
  return createCompositeAuth({ config, logger });
}

/**
 * Publish the actual listening port to the phone (config.json + port.txt) so
 * kb does not keep using a stale install-time port after a daemon restart.
 */
async function publishPhoneConfig(config, adb, port, logger) {
  const root = (config.remote && config.remote.root) || C.REMOTE_ROOT;
  // A unique staging directory per call: stateChange and the startup settle
  // can publish concurrently, and a shared directory let one call's finally
  // delete the other call's staged file (observed as "mv config.json failed"
  // followed by "port.txt does not exist").
  const tmpDir = fs.mkdtempSync(path.join(config.stateDir, 'phone-publish-'));
  const tmpTag = path.basename(tmpDir);
  const configLocal = path.join(tmpDir, 'config.json');
  const portLocal = path.join(tmpDir, 'port.txt');
  const payload = {
    v: 1,
    protocol: C.PROTOCOL,
    port,
    base_url: `http://127.0.0.1:${port}`,
    token_file: `${root}/token`,
    mailbox: root,
  };
  fs.writeFileSync(configLocal, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(portLocal, `${port}\n`, { encoding: 'utf8', mode: 0o600 });

  try {
    const made = await adb.shell(`mkdir -p ${shQuote(`${root}/tmp`)}`, {
      timeoutMs: 10000,
      maxBytes: 16 * 1024,
    });
    if (made.exit !== 0) {
      throw new Error(`mkdir ${root}/tmp failed: ${String(made.stderr || '').trim().slice(0, 200)}`);
    }
    for (const [local, name] of [
      [configLocal, 'config.json'],
      [portLocal, 'port.txt'],
    ]) {
      const remoteTmp = `${root}/tmp/${name}.${tmpTag}.tmp`;
      const remoteFinal = `${root}/${name}`;
      await adb.push(local, remoteTmp, { timeoutMs: 30000 });
      const moved = await adb.shell(`mv -f ${shQuote(remoteTmp)} ${shQuote(remoteFinal)}`, {
        timeoutMs: 10000,
        maxBytes: 16 * 1024,
      });
      if (moved.exit !== 0) {
        throw new Error(`mv ${name} failed: ${String(moved.stderr || '').trim().slice(0, 200)}`);
      }
    }
    logger.info('phone config published', { port });
    return true;
  } catch (err) {
    logger.warn('phone config publish failed', { error: err && err.message });
    return false;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Start the daemon in the current process.
 *
 * @param {{config?: object, logger?: object}} [options]
 * @returns {Promise<object>} handle
 */
async function startDaemon(options = {}) {
  const config = options.config || loadConfig();
  ensureStateDirs(config);

  const logger =
    options.logger ||
    createLogger({
      level: config.log.level,
      file: config.log.file,
      maxBytes: config.log.maxBytes,
      retainDays: config.log.retainDays,
    });

  for (const dir of [config.stateDir, ...Object.values(config.paths.dirs)]) {
    if (dir && !hardenDirectory(dir, logger)) {
      throw new C.BridgeError('auth_unavailable', `状态目录 ACL 无法收紧，拒绝启动：${dir}`);
    }
  }

  ensureTokenFile({ config, logger });
  const lock = acquireLock(config, logger);

  const audit = createAudit({ config, logger });
  const clock = Date.now;
  const transport = createAdbTransport({ config, logger });

  // khy_ask needs an explicit khy.js; discover the portable install when the
  // environment did not provide one. Discovery is file-existence only.
  let khyJs = config.khy && config.khy.js ? config.khy.js : null;
  if (!khyJs) {
    const found = findKhyOsInstallation({ env: process.env, extRoot: config.extRoot });
    khyJs = found ? found.khyJs : null;
  }
  config.khy.js = khyJs;

  const localTools = createLocalTools({
    stateDir: config.stateDir,
    writeRoots: [config.stateDir, os.homedir()],
    readRoots: null,
    cwdAllowlist: config.cwdAllowlist,
    khyJs,
    logger,
    clock,
  });

  const phoneTools = createPhoneTools({ config, adb: transport, logger, clock });

  let mailbox = null;
  let tasks = null;
  let registry = null;
  let stateHook = null;
  const runtimeInfo = {
    pid: process.pid,
    port: null,
    host: config.host,
    version: C.BRIDGE_VERSION,
    protocol: C.PROTOCOL,
    started_at: new Date(clock()).toISOString(),
    state_dir: config.stateDir,
    exe_path: process.execPath,
    cmdline: process.argv.join(' '),
    cmdline_hash: sha256(process.argv.join(' ')),
    serial: config.serial || null,
    node: process.version,
  };

  const wireless = createWireless({
    config,
    transport,
    logger,
    onState(state, meta) {
      try {
        audit.write({ event: 'adb_state', state, ...meta });
      } catch {
        // audit failure must not break the lifecycle
      }
      if (stateHook) {
        try {
          stateHook(state, meta);
        } catch {
          // ignore hook failure
        }
      }
    },
  });

  registry = createRegistry({
    config,
    deps: {
      adb: transport,
      localTools,
      phoneTools,
      getMailbox: () => mailbox,
      getWireless: () => wireless,
      getTasks: () => tasks,
      getRuntime: () => runtimeInfo,
      logger,
      clock,
    },
  });

  const serverConfig = {
    ...config,
    bodyLimit: C.LIMITS.requestBodyBytes,
    rateLimitPerMinute: config.rateLimits ? config.rateLimits.operator.perMinute : 60,
    local: { tokenFile: config.paths.operatorToken },
    writeRoots: [config.stateDir, os.homedir()],
    readRoots: null,
    cwdAllowlist: config.cwdAllowlist,
    khyJs,
    readOnly: false,
    allowExec: true,
  };

  const server = createServer({
    config: serverConfig,
    tools: registry,
    audit,
    logger,
    clock,
    auth: createServerAuth(config, logger),
  });

  // Bind. EADDRINUSE walks the configured port range; anything else aborts.
  let port = config.port;
  let bound = null;
  // A caller-supplied port above the default scan window still gets a few
  // neighbours to try; otherwise `port > portScanMax` would bind zero times.
  const maxPort =
    port === 0
      ? 0
      : Math.max(config.portScanMax || C.DEFAULTS.portScanMax, port + 10);
  for (; port <= maxPort; port += 1) {
    try {
      bound = await server.listen({ port });
      break;
    } catch (err) {
      const message = err && err.message ? err.message : '';
      if (message.includes('EADDRINUSE') && port < maxPort) {
        logger.warn('port in use; trying next', { port });
        continue;
      }
      lock.release();
      throw err;
    }
  }
  if (!bound) {
    lock.release();
    throw new C.BridgeError('invalid_config', `端口 ${config.port}..${maxPort} 全部被占用`);
  }
  runtimeInfo.port = bound.port;
  writeRuntime(config, runtimeInfo);

  tasks = createTaskQueue({
    config,
    logger,
    stateDir: config.stateDir,
    concurrency: Number(process.env.KHY_AMOON_TASK_CONCURRENCY || 1),
    runner: async (task) => {
      const result = await registry.call(task.tool, task.args, {
        principal: { kind: 'operator', scope: 'operator', source: 'tasks' },
        requestId: task.id,
        source: 'tasks',
      });
      return result.data;
    },
  });
  tasks.start();

  mailbox = createMailbox({
    config,
    adb: transport,
    registry,
    logger,
    audit,
    localTempDir: path.join(config.stateDir, 'mailbox-tmp'),
  });

  stateHook = (state) => {
    if (!mailbox) return;
    if (state === C.STATES.HEALTHY || state === C.STATES.DEGRADED_REVERSE) {
      if (!mailbox.status().running) mailbox.start();
      publishPhoneConfig(config, transport, bound.port, logger).catch((err) => {
        logger.warn('phone config publish failed', { error: err && err.message });
      });
      if (registry && typeof registry.flushSpool === 'function') {
        registry.flushSpool().catch((err) => {
          logger.warn('spool re-delivery failed', { error: err && err.message });
        });
      }
    } else if (
      state === C.STATES.DEGRADED_ADB ||
      state === C.STATES.DISABLED ||
      state === C.STATES.STOPPED
    ) {
      if (mailbox.status().running) mailbox.stop();
    }
  };

  // Wireless discovery/keepalive is background work: HTTP /health is available
  // immediately even when the phone is offline.
  wireless
    .start({ port: bound.port, probe: true })
    .then((snapshot) => {
      if (snapshot && snapshot.serial) {
        runtimeInfo.serial = snapshot.serial;
        writeRuntime(config, runtimeInfo);
      }
      if (snapshot && (snapshot.state === C.STATES.HEALTHY || snapshot.state === C.STATES.DEGRADED_REVERSE)) {
        mailbox.start();
        publishPhoneConfig(config, transport, bound.port, logger).catch(() => {});
      }
      logger.info('wireless startup settled', { state: snapshot && snapshot.state });
      return null;
    })
    .catch((err) => {
      logger.warn('wireless startup failed; daemon stays up in degraded mode', {
        error: err && err.message,
      });
    });

  let shuttingDown = null;
  async function shutdown(reason = 'manual') {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      logger.info('daemon shutting down', { reason });
      try {
        if (mailbox) mailbox.dispose();
      } catch (err) {
        logger.warn('mailbox dispose failed', { error: err && err.message });
      }
      try {
        if (tasks) tasks.stop();
      } catch (err) {
        logger.warn('tasks stop failed', { error: err && err.message });
      }
      try {
        wireless.stop();
        await wireless.removeReverse(bound.port);
      } catch (err) {
        logger.warn('wireless stop/reverse cleanup failed', { error: err && err.message });
      }
      try {
        await server.close();
      } catch (err) {
        logger.warn('server close failed', { error: err && err.message });
      }
      removeRuntimeIfOurs(config, process.pid);
      lock.release();
      logger.info('daemon stopped');
    })();
    return shuttingDown;
  }

  return {
    config,
    logger,
    server,
    registry,
    localTools,
    phoneTools,
    wireless,
    mailbox,
    tasks,
    transport,
    audit,
    port: bound.port,
    pid: process.pid,
    runtime: runtimeInfo,
    shutdown,
    snapshot() {
      return {
        pid: process.pid,
        port: bound.port,
        state: wireless.snapshot().state,
        serial: runtimeInfo.serial,
        mailbox: mailbox.status(),
        tasks: tasks.status(),
      };
    },
  };
}

/**
 * Frozen contract helper: return a live daemon's port/token, starting the
 * detached daemon through bin/cli.js when it is not running.
 *
 * @param {{config: object, timeoutMs?: number, startIfMissing?: boolean}} options
 * @returns {Promise<{port:number, token:string, started:boolean, pid?:number}>}
 */
async function ensureDaemon(options = {}) {
  const config = options.config;
  if (!config) throw new C.BridgeError('invalid_config', 'ensureDaemon 需要 config');

  const runtime = readRuntime(config);
  if (runtime && (await healthCheck(runtime.port, 800))) {
    return { port: runtime.port, token: requireOperatorToken(config), started: false, pid: runtime.pid };
  }
  if (options.startIfMissing === false) {
    throw new C.BridgeError('daemon_unavailable', 'daemon 未启动（ensureDaemon startIfMissing=false）', {
      runtime: config.paths.runtime,
    });
  }

  const cli = path.join(config.extRoot || path.resolve(__dirname, '..'), 'bin', 'cli.js');
  if (!fs.existsSync(cli)) {
    throw new C.BridgeError('invalid_config', `找不到 CLI 入口：${cli}`);
  }
  const env = { ...process.env, [C.ENV.home]: config.stateDir, [C.ENV.port]: String(config.port) };
  if (config.serial) env[C.ENV.serial] = config.serial;
  const child = spawn(
    process.execPath,
    [cli, 'start', '--json', '--state-dir', config.stateDir, '--port', String(config.port)],
    { detached: true, stdio: 'ignore', windowsHide: true, env }
  );
  child.unref();

  const deadline = Date.now() + (options.timeoutMs || 15000);
  while (Date.now() < deadline) {
    const rt = readRuntime(config);
    if (rt && (await healthCheck(rt.port, 300))) {
      return { port: rt.port, token: requireOperatorToken(config), started: true, pid: rt.pid };
    }
    await sleep(100);
  }
  throw new C.BridgeError('daemon_unavailable', 'daemon 在等待窗口内未就绪', {
    runtime: config.paths.runtime,
  });
}

/**
 * Process entry used by bin/daemon.js. Installs signal handlers and keeps the
 * process alive through the HTTP listener.
 */
async function runDaemonProcess(argv = process.argv.slice(2)) {
  let stateDir;
  let port;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--state-dir') stateDir = argv[++i] || undefined;
    else if (argv[i] === '--port') port = Number(argv[++i]);
  }

  const config = loadConfig({ env: process.env, stateDir });
  if (Number.isInteger(port) && port >= 1 && port <= 65535) {
    config.port = port;
    config.portScanMax = Math.max(config.portScanMax || 0, port + 10);
  }

  const logger = createLogger({
    level: config.log.level,
    file: config.log.file,
    maxBytes: config.log.maxBytes,
    retainDays: config.log.retainDays,
  });

  let handle;
  try {
    handle = await startDaemon({ config, logger });
  } catch (err) {
    logger.error('daemon startup failed', err);
    process.exitCode = 3;
    return null;
  }

  let closing = false;
  async function close(reason, code) {
    if (closing) return;
    closing = true;
    try {
      await handle.shutdown(reason);
    } finally {
      process.exit(code);
    }
  }

  process.on('SIGTERM', () => {
    close('SIGTERM', 0);
  });
  process.on('SIGINT', () => {
    close('SIGINT', 0);
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', err);
    close('uncaughtException', 1);
  });
  process.on('unhandledRejection', (err) => {
    logger.error('unhandled rejection', err);
    close('unhandledRejection', 1);
  });

  logger.info('daemon ready', {
    pid: process.pid,
    port: handle.port,
    state_dir: config.stateDir,
  });
  return handle;
}

module.exports = {
  readRuntime,
  writeRuntime,
  removeRuntimeIfOurs,
  acquireLock,
  getProcessIdentity,
  isPidAlive,
  startDaemon,
  stopDaemon,
  ensureDaemon,
  healthCheck,
  runDaemonProcess,
  createServerAuth,
  sameIdentity,
  LOCK_RETRY_MS,
};
