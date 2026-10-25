'use strict';

/**
 * amooBridgeClient.js — thin IO shell: the only file in this unit that spawns a
 * process or opens a socket.
 *
 * Everything above it (config / policy / plan / snapshot) is pure; everything
 * below it (adb, the bridge HTTP port) is hostile — commands hang, sockets
 * stall, tokens rotate. So this shell is deliberately dumb: argv arrays only
 * (never a shell string), a deadline on every child, resolve-to-result instead
 * of throw, and truncation before anything leaves the process.
 *
 * Measured facts this shell is built around:
 *   - `adb pair` is NEVER called: 33743 is the connect port, not a pairing port.
 *   - The bridge listens on 8896 and binds 0.0.0.0; we default to reaching it
 *     through `adb forward` on loopback so no firewall rule is needed, with a
 *     `lan` transport as the opt-in alternative.
 *   - The bridge's HTTP server is thread-per-connection, but `clipboard` is the
 *     one tool observed to wedge it for the whole process lifetime; the client
 *     therefore treats a hung call as "bridge needs revival" and calls the
 *     monkey restart once, then reports honestly.
 *   - A request body MUST be valid UTF-8. Sending mangled bytes (a shell quoting
 *     accident) is what wedged the bridge in the first place, so bodies are
 *     serialised here with Buffer.byteLength and never re-quoted by a shell.
 *
 * Contract: no method throws. Every method returns a result object with `ok`.
 *
 * @module services/domain/network/amoo/amooBridgeClient
 */

const http = require('http');
const { spawn } = require('child_process');
const nodePath = require('path');

const { safeKill, searchExecutable } = require('../../../../tools/platformUtils');
const {
  buildConnectArgv,
  buildDevicesArgv,
  buildForwardArgv,
  buildForwardListArgv,
  buildTokenReadArgv,
  buildRecoverBridgeArgv,
  classifyDeviceList,
  normalizeBridgeToken,
  maskToken,
} = require('./amooBridgePolicy');

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

/**
 * Race a promise against a deadline. The timer expression carries no numeric
 * literal on purpose: this is a scheduler, not a hard kill, and the kill itself
 * happens in the caller's onExpire so the two concerns stay separable.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {Function} [onExpire]
 * @returns {Promise<T|{__deadline:true}>}
 */
function withDeadline(promise, timeoutMs, onExpire) {
  let timer = null;
  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __deadline: true }), Math.max(1, Number(timeoutMs) || 1));
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  });
  return Promise.race([promise, deadline]).then(
    (value) => {
      clear();
      if (value && value.__deadline === true && typeof onExpire === 'function') {
        onExpire();
      }
      return value;
    },
    (error) => {
      clear();
      throw error;
    }
  );
}

class AmooBridgeClient {
  /**
   * @param {object} [opts]
   * @param {object} [opts.config] output of resolveAmooConfig
   * @param {Function} [opts.spawnImpl] injected for tests
   * @param {Function} [opts.sleep] injected for tests
   * @param {Function} [opts.now] injected for tests
   * @param {Function} [opts.resolveAdbPath] injected for tests
   */
  constructor(opts = {}) {
    this.config = opts.config;
    this._spawn = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : spawn;
    this._sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this._resolveAdbPath =
      typeof opts.resolveAdbPath === 'function' ? opts.resolveAdbPath : null;
    this._adbPath = null;
    this._adbPathSource = 'unresolved';
    this._token = null;
    this._tokenFetchedAt = 0;
    this._lastError = null;
    // Raised when a post-clipboard probe fails; the next ensureBridge() then
    // revives instead of trusting a ping that may land on a wedged process.
    this._bridgeSuspect = false;
  }

  /**
   * Resolve the adb executable. Explicit env path wins; PATH lookup is the
   * fallback; nothing is hardcoded, so a machine without adb gets an honest
   * "set KHY_AMOO_ADB_PATH" instead of a bogus absolute path.
   * @returns {{ok:boolean, path:string|null, source:string, message:string}}
   */
  resolveAdbPath() {
    if (this._adbPath) {
      return { ok: true, path: this._adbPath, source: this._adbPathSource, message: '' };
    }
    const configured = this.config && this.config.adb ? this.config.adb.path : null;
    if (configured) {
      this._adbPath = configured;
      this._adbPathSource = 'env';
      return { ok: true, path: configured, source: 'env', message: '' };
    }
    if (this._resolveAdbPath) {
      const injected = this._resolveAdbPath();
      if (injected && injected.path) {
        this._adbPath = injected.path;
        this._adbPathSource = injected.source || 'injected';
        return { ok: true, path: this._adbPath, source: this._adbPathSource, message: '' };
      }
    }
    let found = null;
    try {
      found = searchExecutable('adb');
    } catch {
      found = null;
    }
    if (found) {
      this._adbPath = found;
      this._adbPathSource = 'path';
      return { ok: true, path: found, source: 'path', message: '' };
    }
    return {
      ok: false,
      path: null,
      source: 'unresolved',
      message: '找不到 adb 可执行文件。请设置 KHY_AMOO_ADB_PATH 指向 adb.exe，或把 platform-tools 加入 PATH。',
    };
  }

  /**
   * Run one adb command with a deadline. Never throws.
   * @param {string[]} argv
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string,
   *                    argv:string[], durationMs:number, timedOut:boolean,
   *                    error:string|null}>}
   */
  async runAdb(argv, opts = {}) {
    const resolved = this.resolveAdbPath();
    if (!resolved.ok) {
      return {
        ok: false,
        code: null,
        stdout: '',
        stderr: resolved.message,
        argv: Array.isArray(argv) ? argv.slice() : [],
        durationMs: 0,
        timedOut: false,
        error: 'adb_unresolved',
      };
    }
    const timeoutMs = Number(opts.timeoutMs) || (this.config && this.config.adb ? this.config.adb.timeoutMs : 15000);
    const startedAt = this._now();
    let child = null;
    let timedOut = false;

    const execution = new Promise((resolve) => {
      let out = '';
      let err = '';
      let settled = false;
      const finish = (code) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          ok: code === 0,
          code,
          stdout: out,
          stderr: err,
          argv: Array.isArray(argv) ? argv.slice() : [],
          durationMs: Math.max(0, this._now() - startedAt),
          timedOut,
          error: code === 0 ? null : 'adb_nonzero_exit',
        });
      };
      try {
        child = this._spawn(resolved.path, argv, { windowsHide: true });
      } catch (error) {
        resolve({
          ok: false,
          code: null,
          stdout: '',
          stderr: String((error && error.message) || error),
          argv: Array.isArray(argv) ? argv.slice() : [],
          durationMs: Math.max(0, this._now() - startedAt),
          timedOut: false,
          error: 'adb_spawn_failed',
        });
        return;
      }
      // The listener must be registered unconditionally: nesting it inside the
      // setEncoding guard makes any stream without setEncoding (a test double, a
      // wrapper) look like a command that printed nothing.
      if (child.stdout) {
        if (typeof child.stdout.setEncoding === 'function') {
          child.stdout.setEncoding('utf8');
        }
        child.stdout.on('data', (chunk) => {
          out += String(chunk);
        });
      }
      if (child.stderr) {
        if (typeof child.stderr.setEncoding === 'function') {
          child.stderr.setEncoding('utf8');
        }
        child.stderr.on('data', (chunk) => {
          err += String(chunk);
        });
      }
      child.on('error', (error) => {
        err += String((error && error.message) || error);
        finish(null);
      });
      child.on('close', (code) => {
        finish(code);
      });
    });

    const result = await withDeadline(execution, timeoutMs, () => {
      timedOut = true;
      // Kill lives here, outside the timer expression, so the deadline stays a
      // scheduler and the kill stays an explicit, auditable call.
      try {
        safeKill(child, 'SIGTERM', 3000);
      } catch {
        /* child already gone */
      }
    });

    if (result && result.__deadline === true) {
      return {
        ok: false,
        code: null,
        stdout: '',
        stderr: 'adb 命令超时',
        argv: Array.isArray(argv) ? argv.slice() : [],
        durationMs: Math.max(0, this._now() - startedAt),
        timedOut: true,
        error: 'adb_timeout',
      };
    }
    return result;
  }

  /**
   * Make sure the device is connected. Connects only when the device list does
   * not already contain it — `adb pair` is never issued.
   * @returns {Promise<{ok:boolean, connected:boolean, reason:string|null,
   *                    detail:string}>}
   */
  async ensureDevice() {
    const serial = this.config.adb.serial;
    const listed = await this.runAdb(buildDevicesArgv());
    if (!listed.ok) {
      return {
        ok: false,
        connected: false,
        reason: 'adb_devices_failed',
        detail: (listed.stderr || listed.error || '').trim() || 'adb devices 执行失败',
      };
    }
    const classified = classifyDeviceList(listed.stdout, serial);
    if (classified.connected) {
      return { ok: true, connected: true, reason: null, detail: '设备已连接' };
    }
    const connectHost = this.config.adb.connectHost;
    const connectPort = this.config.adb.connectPort;
    const connect = await this.runAdb(buildConnectArgv(connectHost, connectPort));
    const recheck = await this.runAdb(buildDevicesArgv());
    const reclassified = recheck.ok ? classifyDeviceList(recheck.stdout, serial) : { connected: false };
    if (reclassified.connected) {
      return { ok: true, connected: true, reason: null, detail: '设备已连接（本次执行 connect）' };
    }
    return {
      ok: false,
      connected: false,
      reason: classified.reason || 'device_unreachable',
      detail:
        (connect.stdout || connect.stderr || '').trim() ||
        `connect ${connectHost}:${connectPort} 后仍未出现在设备列表`,
    };
  }

  /**
   * Establish both forwards (real port + alias port). Idempotent.
   * @returns {Promise<{ok:boolean, forwards:string[], detail:string}>}
   */
  async ensureForward() {
    const { serial } = this.config.adb;
    const { port, aliasPort } = this.config.bridge;
    const wanted = [port, aliasPort];
    const forwards = [];
    for (const localPort of wanted) {
      const remotePort = localPort === aliasPort ? port : localPort;
      const applied = await this.runAdb(buildForwardArgv(serial, localPort, remotePort));
      if (!applied.ok) {
        return {
          ok: false,
          forwards,
          detail: (applied.stderr || applied.error || '').trim() || `forward tcp:${localPort} 失败`,
        };
      }
      forwards.push(`tcp:${localPort}`);
    }
    const listed = await this.runAdb(buildForwardListArgv(serial));
    if (!listed.ok) {
      return { ok: true, forwards, detail: 'forward 已建立（列表查询失败，不影响使用）' };
    }
    return { ok: true, forwards, detail: listed.stdout.trim() };
  }

  /**
   * Read the bearer token off the device and cache it. The token is a secret:
   * it is never written to a log, a status line, or a result body.
   * @param {{force?:boolean}} [opts]
   * @returns {Promise<{ok:boolean, token:string|null, masked:string, reason:string|null}>}
   */
  async readToken(opts = {}) {
    const age = this._now() - this._tokenFetchedAt;
    if (this._token && !opts.force && age < TOKEN_TTL_MS) {
      return { ok: true, token: this._token, masked: maskToken(this._token), reason: null };
    }
    const read = await this.runAdb(buildTokenReadArgv(this.config.adb.serial, this.config.bridge.tokenPath));
    if (!read.ok) {
      return {
        ok: false,
        token: null,
        masked: '****',
        reason: (read.stderr || read.error || '').trim() || 'token 读取失败',
      };
    }
    const normalized = normalizeBridgeToken(read.stdout);
    if (!normalized.ok) {
      return { ok: false, token: null, masked: '****', reason: normalized.reason };
    }
    this._token = normalized.token;
    this._tokenFetchedAt = this._now();
    return { ok: true, token: normalized.token, masked: maskToken(normalized.token), reason: null };
  }

  /**
   * POST to the bridge. Resolves to a result; never throws.
   * @param {string} path e.g. '/ping'
   * @param {object|null} body
   * @returns {Promise<{ok:boolean, status:number|null, body:object|null,
   *                    raw:string, error:string|null}>}
   */
  async bridgeRequest(path, body = null) {
    const token = await this.readToken();
    if (!token.ok) {
      return { ok: false, status: null, body: null, raw: '', error: `token 不可用：${token.reason}` };
    }
    const payload = body === null ? '' : JSON.stringify(body);
    const timeoutMs = this.config.bridge.httpTimeoutMs;
    const url = new URL(`${this.config.bridge.baseUrl}${path}`);

    const execution = new Promise((resolve) => {
      let raw = '';
      const req = http.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${token.token}`,
            'Content-Length': Buffer.byteLength(payload, 'utf8'),
          },
        },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            raw += String(chunk);
          });
          res.on('end', () => {
            let parsed = null;
            try {
              parsed = raw ? JSON.parse(raw) : null;
            } catch {
              parsed = null;
            }
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              body: parsed,
              raw,
              error: res.statusCode >= 200 && res.statusCode < 300 ? null : `http_${res.statusCode}`,
            });
          });
        }
      );
      req.on('error', (error) => {
        resolve({
          ok: false,
          status: null,
          body: null,
          raw: '',
          error: String((error && error.message) || error) || 'bridge_unreachable',
        });
      });
      // A socket timeout must destroy the request; without it a stalled bridge
      // holds the promise forever.
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('bridge_request_timeout'));
      });
      if (payload) {
        req.write(payload, 'utf8');
      }
      req.end();
    });

    const result = await withDeadline(execution, timeoutMs + 2000, () => {
      this._lastError = 'bridge_request_timeout';
    });
    if (result && result.__deadline === true) {
      return { ok: false, status: null, body: null, raw: '', error: 'bridge_request_timeout' };
    }
    return result;
  }

  /**
   * Liveness probe.
   * @returns {Promise<{ok:boolean, latencyMs:number, detail:string}>}
   */
  async ping() {
    const startedAt = this._now();
    const res = await this.bridgeRequest('/ping');
    return {
      ok: res.ok && res.body && res.body.ok === true,
      latencyMs: Math.max(0, this._now() - startedAt),
      detail: res.ok && res.body && res.body.ok === true ? '桥服务在线' : res.error || '桥服务无响应',
    };
  }

  /**
   * Status probe.
   * @returns {Promise<{ok:boolean, status:object|null, detail:string}>}
   */
  async status() {
    const res = await this.bridgeRequest('/status');
    return {
      ok: res.ok && res.body && res.body.ok === true,
      status: res.body,
      detail: res.ok && res.body && res.body.ok === true ? '桥服务在线' : res.error || '桥服务无响应',
    };
  }

  /**
   * Post-clipboard liveness probe. `clipboard` is the one bridge tool observed
   * to wedge the whole process for its remaining lifetime (measured live: the
   * status.json heartbeat went stale 132s after a clipboard call and only the
   * monkey restart recovered it), so every clipboard write is followed by a
   * cheap /ping. A failed probe raises the suspect flag, which makes the next
   * ensureBridge() revive rather than trust a ping that happens to land on a
   * still-warm socket.
   * @returns {Promise<{ok:boolean, latencyMs:number, detail:string}>}
   */
  async probeAfterClipboard() {
    const res = await this.ping();
    if (!res.ok) {
      this._bridgeSuspect = true;
    }
    return res;
  }

  /**
   * Revive the bridge. The only command that works on this ROM: `am start -n
   * .../.MainActivity` is swallowed by a stale AMS top-most record and
   * `am start-service` is refused because BridgeService is exported=false.
   * @returns {Promise<{ok:boolean, detail:string}>}
   */
  async recoverBridge() {
    const argv = buildRecoverBridgeArgv(this.config.adb.serial, this.config.bridge.package);
    const run = await this.runAdb(argv, { timeoutMs: 20000 });
    return {
      ok: run.ok,
      detail: run.ok ? '已用 monkey 重新拉起桥服务' : (run.stderr || run.error || '').trim() || '拉起桥服务失败',
    };
  }

  /**
   * Ensure the bridge answers, reviving it once if it does not.
   * @returns {Promise<{ok:boolean, revived:boolean, detail:string}>}
   */
  async ensureBridge() {
    // A raised suspect flag skips the first ping: the observed wedge pattern is
    // "clipboard returned ok, then the process stopped answering", and a ping
    // issued right after it can still succeed on a thread that has not noticed
    // yet. The flag is consumed here either way, so one bad probe costs one
    // revival, not a permanent revive loop.
    const first = this._bridgeSuspect
      ? { ok: false, detail: '上一次剪贴板调用后桥无响应，按观测惯例先重启再探活' }
      : await this.ping();
    this._bridgeSuspect = false;
    if (first.ok) {
      return { ok: true, revived: false, detail: first.detail };
    }
    const revived = await this.recoverBridge();
    await this._sleep(4000);
    const second = await this.ping();
    if (second.ok) {
      return { ok: true, revived: true, detail: '桥服务本无响应，已重新拉起' };
    }
    return {
      ok: false,
      revived: revived.ok,
      detail: `桥服务仍无响应：${second.detail}${revived.ok ? '' : `；拉起也未成功：${revived.detail}`}`,
    };
  }

  /**
   * Local scratch directory for pulled UI dumps. Resolved through the repo's
   * data-home resolver (CLAUDE.md B8) — never `process.cwd()`.
   * @param {Function} getAppDataDir
   * @returns {string}
   */
  scratchDir(getAppDataDir) {
    return getAppDataDir(this.config.local.scratchSubdir);
  }

  /**
   * Join a scratch path.
   * @param {Function} getAppDataDir
   * @param {string} fileName
   * @returns {string}
   */
  scratchFile(getAppDataDir, fileName) {
    return nodePath.join(this.scratchDir(getAppDataDir), fileName);
  }

  /** Drop the cached token (called after a reinstall or a revival). */
  invalidateToken() {
    this._token = null;
    this._tokenFetchedAt = 0;
  }

  /** Masked token for status output only. */
  tokenMask() {
    return maskToken(this._token);
  }

  /** Last transport-level error, for diagnostics. */
  lastError() {
    return this._lastError;
  }
}

module.exports = {
  AmooBridgeClient,
  withDeadline,
  defaultSleep,
  TOKEN_TTL_MS,
};
