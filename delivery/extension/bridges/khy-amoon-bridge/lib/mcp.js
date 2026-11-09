'use strict';

/**
 * lib/mcp.js — the MCP stdio front-end and its daemon HTTP client.
 *
 * Contract (frozen in lib/contracts.js, module D):
 *   createStdioServer({config, deps}) -> { handleMessage, handleLine, run, toolList }
 *
 * Transport:
 *   - newline-delimited JSON-RPC 2.0 on stdin/stdout;
 *   - stdout carries protocol frames ONLY — every log/diagnostic goes to stderr;
 *   - zero third-party dependencies.
 *
 * Tool execution:
 *   - tools/list is served from contracts.TOOLS (always available, even when the
 *     daemon is down, so a client can inspect the contract);
 *   - tools/call is forwarded to the local daemon over HTTP 127.0.0.1
 *     (POST /v1/call), exactly like WIRING says: MCP -> http client -> routes ->
 *     registry. This file never touches ADB, the mailbox or tool handlers.
 *
 * Failure policy:
 *   - tools/call failures are returned as an MCP tool result with isError:true
 *     (the ask requires isError, not JSON-RPC errors);
 *   - protocol errors (parse/invalid request/method not found) use JSON-RPC codes;
 *   - a missing daemon is never reported as success and never auto-faked.
 *
 * Runtime file notes:
 *   - bin/mcp-server.js is a thin argv+startup shell; all framing lives here.
 *   - The frozen contract names lib/mcp/stdio.js for createStdioServer. This
 *     build task restricts the file set to lib/mcp.js, so the same export name
 *     is provided here (see the ModuleReport for the deviation).
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const C = require('./contracts');
const { readOperatorToken } = require('./config');
const { createLogger, redactString } = require('./logger');

const SERVER_INFO = Object.freeze({ name: C.NAMESPACE, version: C.BRIDGE_VERSION });

/** MCP revision KhyOS currently requests (mcpServerProtocol.js PROTOCOL_VERSION). */
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

/** Versions this server is willing to echo back. 2024-11-05 is KhyOS's own. */
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
]);

const INSTRUCTIONS =
  'khy-amoon-bridge（命名空间 amoon）Phase 1 暴露 12 个工具：8 个核心工具 + phone_info/phone_app_list/phone_ls/phone_exec 四个受限只读手机工具。' +
  'phone_exec 不是手机 shell，只接受固定诊断 op。' +
  'tools/call 全部转发到本机 daemon（127.0.0.1 + adb reverse）；daemon 未启动时返回 daemon_unavailable，不会假装成功。' +
  'amoon→PC 方向在 Phase 0 三项探测留下证据前一律标为 unverified，不得宣称双向。';

const DEFAULT_TOOL_TIMEOUT_MS = 30000;
const HEALTH_TIMEOUT_MS = 1200;
const AUTOSTART_WAIT_MS = 8000;

const silentLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
  isEnabled() {
    return false;
  },
  child() {
    return silentLogger;
  },
  close() {},
});

// ── Small helpers ───────────────────────────────────────────────────────────

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * @param {unknown} err
 * @returns {import('./contracts').BridgeError}
 */
function asBridgeError(err) {
  if (C.isBridgeError(err)) return err;
  const message = err && err.message ? err.message : String(err);
  if (err && err.code === 'ABORT_ERR') {
    return new C.BridgeError('timeout', `请求已取消：${redactString(message)}`);
  }
  if (err && err.code === 'ETIMEDOUT') {
    return new C.BridgeError('timeout', `请求超时：${redactString(message)}`);
  }
  if (err && err.code === 'ECONNREFUSED') {
    return new C.BridgeError('daemon_unavailable', 'daemon 连接被拒绝。');
  }
  if (err && err.code === 'response_too_large') {
    return new C.BridgeError('payload_too_large', 'daemon 响应超过大小上限。');
  }
  return new C.BridgeError('internal_error', redactString(message));
}

/**
 * @param {number|string|null} id
 * @param {object} value
 * @returns {{jsonrpc: string, id: number|string|null, result: object}}
 */
function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

/**
 * @param {number|string|null} id
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 * @returns {{jsonrpc: string, id: number|string|null, error: object}}
 */
function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/**
 * MCP tool error result. Never includes credentials: logger.redactString strips
 * `khy_...` tokens and Bearer headers from free text.
 *
 * @param {string} code
 * @param {string} text Chinese, user-facing
 * @param {unknown} [details] machine-readable, never secrets
 * @returns {{content: Array<{type:string,text:string}>, isError: true}}
 */
function toolError(code, text, details) {
  let message = `[${code}] ${redactString(String(text || code))}`;
  if (details !== undefined) {
    try {
      message += ` ${redactString(JSON.stringify(details))}`;
    } catch {
      // ignore unserializable details
    }
  }
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Convert a daemon Envelope into an MCP tool result.
 *
 * @param {object} envelope
 * @param {object|null} descriptor
 * @returns {{content: Array<{type:string,text:string}>, isError: boolean}}
 */
function envelopeToToolResult(envelope, descriptor) {
  if (!envelope || typeof envelope !== 'object') {
    return toolError('internal_error', 'daemon 返回了空结果。');
  }
  if (envelope.ok === false) {
    const error = envelope.error && typeof envelope.error === 'object' ? envelope.error : {};
    return toolError(
      typeof error.code === 'string' ? error.code : 'internal_error',
      typeof error.message === 'string' ? error.message : '工具执行失败。',
      error.details
    );
  }
  if (envelope.ok !== true) {
    return toolError('internal_error', 'daemon 响应不是合法 Envelope（缺少 ok 布尔字段）。');
  }

  const data = envelope.data;
  let text = typeof data === 'string' ? data : JSON.stringify(data === undefined ? null : data);
  if (typeof text !== 'string') text = String(text);

  const cap = descriptor && descriptor.responseMaxBytes
    ? descriptor.responseMaxBytes
    : C.LIMITS.responseDefaultBytes;
  if (Buffer.byteLength(text, 'utf8') > cap) {
    const cut = Buffer.from(text, 'utf8').subarray(0, cap).toString('utf8');
    text = `${cut}\n[已截断：响应超过 ${cap} 字节上限]`;
  }
  return { content: [{ type: 'text', text }], isError: false };
}

/**
 * @param {object} params JSON-RPC params of tools/call
 * @returns {{ok:true,name:string,args:object}|{ok:false,result:object}}
 */
function readToolCallParams(params) {
  const name = params && params.name;
  if (typeof name !== 'string' || !name) {
    return { ok: false, result: toolError('invalid_args', 'tools/call 缺少工具名。') };
  }
  const descriptor = C.getTool(name);
  if (!descriptor) {
    return {
      ok: false,
      result: toolError(
        'not_found',
        `未知工具：${name}。Phase 1 只有：${C.listToolNames().join('、')}。`
      ),
    };
  }
  const args = params.arguments === undefined ? {} : params.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, result: toolError('invalid_args', 'tools/call 的 arguments 必须是 JSON 对象。') };
  }
  return { ok: true, name, args, descriptor };
}

// ── Daemon HTTP client ──────────────────────────────────────────────────────

/**
 * Read runtime.json written by the daemon (the single source of the port).
 *
 * @param {object} config
 * @returns {{pid:number|null,port:number,host:string,started_at?:string,serial?:string}|null}
 */
function readRuntimeFile(config) {
  let text;
  try {
    text = fs.readFileSync(config.paths.runtime, 'utf8');
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const port = Number(data.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  const host = data.host === undefined ? '127.0.0.1' : String(data.host);
  if (host !== '127.0.0.1' && host !== 'localhost') return null;
  return {
    pid: Number.isInteger(data.pid) ? data.pid : null,
    port,
    host: '127.0.0.1',
    started_at: typeof data.started_at === 'string' ? data.started_at : undefined,
    serial: typeof data.serial === 'string' ? data.serial : undefined,
  };
}

/**
 * GET /health. /health is unauthenticated by design; it returns only {ok:true}.
 *
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function checkHealth(port, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = http.request(
        { host: '127.0.0.1', port, path: '/health', method: 'GET', agent: false },
        (res) => {
          res.resume();
          res.on('end', () => finish(res.statusCode === 200));
          res.on('error', () => finish(false));
        }
      );
    } catch {
      finish(false);
      return;
    }
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(false);
    });
    req.on('error', () => finish(false));
    req.end();
  });
}

/**
 * One HTTP request with a hard byte cap and an abort signal.
 *
 * @param {{
 *   port: number,
 *   path: string,
 *   method: string,
 *   headers?: object,
 *   body?: string|Buffer|null,
 *   timeoutMs: number,
 *   maxBytes?: number,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{status:number, headers:object, json:unknown, bytes:number}>}
 */
function requestJson(options) {
  const maxBytes = options.maxBytes || C.LIMITS.responseHardMaxBytes;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    let req;
    try {
      req = http.request(
        {
          host: '127.0.0.1',
          port: options.port,
          path: options.path,
          method: options.method,
          headers: options.headers || {},
          agent: false,
        },
        (res) => {
          const chunks = [];
          let bytes = 0;
          let tooLarge = false;
          res.on('data', (chunk) => {
            if (tooLarge) return;
            bytes += chunk.length;
            if (bytes > maxBytes) {
              tooLarge = true;
              const tooLargeError = new Error('response_too_large');
              tooLargeError.code = 'response_too_large';
              req.destroy(tooLargeError);
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (tooLarge) return;
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            if (text.trim()) {
              try {
                json = JSON.parse(text);
              } catch {
                finish(
                  reject,
                  new C.BridgeError('internal_error', 'daemon 返回了非 JSON 响应。', {
                    status: res.statusCode,
                    preview: text.slice(0, 200),
                  })
                );
                return;
              }
            }
            finish(resolve, {
              status: res.statusCode || 0,
              headers: res.headers || {},
              json,
              bytes,
            });
          });
          res.on('error', (err) => finish(reject, err));
        }
      );
    } catch (err) {
      finish(reject, err);
      return;
    }

    const onAbort = () => {
      req.destroy(Object.assign(new Error('request aborted'), { code: 'ABORT_ERR' }));
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('close', () => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    });

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', (err) => finish(reject, err));
    if (options.body !== undefined && options.body !== null) req.write(options.body);
    req.end();
  });
}

/**
 * Map an HTTP error response to a BridgeError without trusting arbitrary fields.
 *
 * @param {number} status
 * @param {unknown} json
 * @returns {import('./contracts').BridgeError}
 */
function errorFromHttp(status, json) {
  const body = json && typeof json === 'object' ? json : {};
  const error = body.error && typeof body.error === 'object' ? body.error : null;
  if (error && typeof error.code === 'string') {
    return new C.BridgeError(error.code, error.message, error.details);
  }
  switch (status) {
    case 400:
      return new C.BridgeError('invalid_request', 'daemon 拒绝了请求（400）。');
    case 401:
      return new C.BridgeError('unauthorized');
    case 403:
      return new C.BridgeError('forbidden_scope');
    case 404:
      return new C.BridgeError('not_found');
    case 409:
      return new C.BridgeError('id_conflict', 'daemon 报告冲突（409）。');
    case 413:
      return new C.BridgeError('payload_too_large');
    case 429:
      return new C.BridgeError('rate_limited');
    case 503:
      return new C.BridgeError('daemon_unavailable');
    case 504:
      return new C.BridgeError('timeout');
    default:
      return new C.BridgeError('internal_error', `daemon 返回 HTTP ${status}。`);
  }
}

/**
 * Spawn `node bin/cli.js start` once. The child is detached and unref'ed so a
 * foreground daemon (if module A chooses to run one) is not killed when the
 * MCP server exits. Output is discarded; the daemon has its own log file.
 *
 * @param {object} config
 * @param {object} logger
 * @returns {Promise<{code:number|null, spawned:boolean}>}
 */
function spawnDaemonStart(config, logger) {
  const cli = path.join(config.extRoot, 'bin', 'cli.js');
  if (!fs.existsSync(cli)) {
    logger.warn('daemon autostart skipped: bin/cli.js not found', { cli });
    return Promise.resolve({ code: null, spawned: false });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [cli, 'start', '--json', '--state-dir', config.stateDir, '--port', String(config.port)], {
        cwd: config.extRoot,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
    } catch (err) {
      logger.warn('daemon autostart spawn failed', { message: err && err.message });
      resolve({ code: null, spawned: false });
      return;
    }
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      logger.debug('daemon autostart child settled', { code });
      resolve({ code, spawned: true });
    };
    child.on('error', (err) => {
      logger.warn('daemon autostart child error', { message: err && err.message });
      done(null);
    });
    child.on('exit', (code) => done(code));
    if (typeof child.unref === 'function') child.unref();
    // Do not wait forever: health polling below is the real readiness check.
    const timer = setTimeout(() => done(null), 6000);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Minimal daemon client used by the MCP front-end.
 *
 * It deliberately duplicates only the tiny HTTP surface module D's
 * lib/http/client.js would provide: POST /v1/call, GET /v1/status, /health,
 * plus token re-read on 401 and optional daemon autostart on ECONNREFUSED.
 *
 * @param {{
 *   config: object,
 *   logger?: object,
 *   autostart?: boolean,
 *   startDaemon?: Function,
 * }} options
 */
function createDaemonClient(options) {
  const config = options.config;
  const logger = options.logger || silentLogger;
  const autostart =
    options.autostart !== undefined
      ? Boolean(options.autostart)
      : String(process.env.KHY_AMOON_MCP_AUTOSTART || '1') !== '0';

  let autostartAttempted = false;

  function currentToken() {
    const token = readOperatorToken(config);
    if (!token || token.length < C.LIMITS.tokenMinLength) return null;
    return token;
  }

  async function ensureRunning(budgetMs) {
    const direct = readRuntimeFile(config);
    if (direct && (await checkHealth(direct.port))) return direct;

    if (!autostart) {
      throw new C.BridgeError(
        'daemon_unavailable',
        `daemon 未启动（${config.host}:${config.port}）。请先运行 scripts/start.ps1 或 node bin/cli.js start。`,
        { runtime: config.paths.runtime }
      );
    }

    if (!autostartAttempted) {
      autostartAttempted = true;
      logger.info('daemon not reachable; attempting one autostart');
      let started = { code: null, spawned: false };
      if (typeof options.startDaemon === 'function') {
        try {
          await options.startDaemon();
        } catch (err) {
          logger.warn('daemon autostart hook failed', { message: err && err.message });
        }
      } else {
        started = await spawnDaemonStart(config, logger);
      }
      if (started && started.code === 3) {
        throw new C.BridgeError(
          'daemon_unavailable',
          'daemon 启动失败（bin/cli.js start 退出码 3）：进程未写出 runtime.json 或 /health 未就绪。'
        );
      }
    }

    const waitMs = Math.max(2000, Math.min(AUTOSTART_WAIT_MS, budgetMs - 1000));
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const runtime = readRuntimeFile(config);
      if (runtime && (await checkHealth(runtime.port, 800))) return runtime;
      await delay(200);
    }
    throw new C.BridgeError(
      'daemon_unavailable',
      `daemon 未启动或不可达（${config.host}:${config.port}）。请先运行 scripts/start.ps1 或 node bin/cli.js start。`,
      { runtime: config.paths.runtime }
    );
  }

  async function postCall(runtime, token, name, args, timeoutMs, signal, maxBytes, callPath) {
    return requestJson({
      port: runtime.port,
      path: callPath || '/v1/call',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
        Connection: 'close',
      },
      body: Buffer.from(
        JSON.stringify({ tool: name, args: args || {}, timeout_ms: timeoutMs }),
        'utf8'
      ),
      timeoutMs,
      maxBytes,
      signal,
    });
  }

  /**
   * Send POST /v1/call. Some in-tree HTTP servers only expose /call (see
   * lib/server.js); an HTTP 404 from the router is safe to retry there because
   * tool-level failures are 200 + ok:false, never 404.
   */
  async function postCallWithFallback(runtime, token, name, args, timeoutMs, signal, maxBytes) {
    const first = await postCall(runtime, token, name, args, timeoutMs, signal, maxBytes, '/v1/call');
    if (first.status !== 404) return first;
    const body = first.json && typeof first.json === 'object' ? first.json : {};
    const error = body.error && typeof body.error === 'object' ? body.error : {};
    if (error.code !== 'not_found' && error.code !== undefined) return first;
    return postCall(runtime, token, name, args, timeoutMs, signal, maxBytes, '/call');
  }

  /**
   * @param {string} name
   * @param {object} args
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [callOptions]
   * @returns {Promise<object>} Envelope
   */
  async function callTool(name, args = {}, callOptions = {}) {
    const descriptor = C.getTool(name);
    const timeoutMs =
      Number.isInteger(callOptions.timeoutMs) && callOptions.timeoutMs > 0
        ? callOptions.timeoutMs
        : descriptor
          ? descriptor.timeoutMs
          : DEFAULT_TOOL_TIMEOUT_MS;

    const runtime = await ensureRunning(timeoutMs);
    const maxBytes = Math.min(
      C.LIMITS.responseHardMaxBytes,
      (descriptor ? descriptor.responseMaxBytes : C.LIMITS.responseDefaultBytes) + 256 * 1024
    );

    let token = currentToken();
    if (!token) {
      throw new C.BridgeError(
        'auth_unavailable',
        'operator token 缺失或过短；daemon 会 fail-closed。请先运行 scripts/install.ps1 生成 token。',
        { tokenFile: config.paths.operatorToken }
      );
    }

    let response;
    try {
      response = await postCallWithFallback(runtime, token, name, args, timeoutMs, callOptions.signal, maxBytes);
    } catch (err) {
      if (err && (err.code === 'ECONNREFUSED' || err.code === 'ENOENT')) {
        throw new C.BridgeError('daemon_unavailable', 'daemon 连接被拒绝（daemon 可能刚退出）。', {
          port: runtime.port,
        });
      }
      if (err && err.code === 'ETIMEDOUT') {
        throw new C.BridgeError('timeout', `工具 ${name} 超时（${timeoutMs}ms）。`);
      }
      if (err && err.code === 'ABORT_ERR') {
        throw new C.BridgeError('timeout', `工具 ${name} 已被取消。`);
      }
      throw asBridgeError(err);
    }

    // 401: re-read the token once (rotation may have happened) and retry once.
    if (response.status === 401) {
      const fresh = currentToken();
      if (fresh && fresh !== token) {
        token = fresh;
        try {
          response = await postCallWithFallback(runtime, token, name, args, timeoutMs, callOptions.signal, maxBytes);
        } catch (err) {
          throw asBridgeError(err);
        }
      }
    }

    if (response.status === 202) {
      const id = response.json && typeof response.json.id === 'string' ? response.json.id : null;
      if (!id) {
        throw new C.BridgeError('internal_error', 'daemon 返回 202 但缺少 job id。');
      }
      return pollJob(runtime, token, id, timeoutMs, callOptions.signal);
    }

    if (response.status !== 200) {
      throw errorFromHttp(response.status, response.json);
    }
    if (!response.json || typeof response.json !== 'object') {
      throw new C.BridgeError('internal_error', 'daemon 返回了空响应。');
    }
    return response.json;
  }

  /**
   * Poll GET /v1/jobs/:id until the job settles or the caller's budget expires.
   *
   * @param {object} runtime
   * @param {string} token
   * @param {string} id
   * @param {number} budgetMs
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>} Envelope
   */
  async function pollJob(runtime, token, id, budgetMs, signal) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (signal && signal.aborted) {
        throw new C.BridgeError('timeout', '任务已取消。', { job: id });
      }
      const response = await requestJson({
        port: runtime.port,
        path: `/v1/jobs/${encodeURIComponent(id)}`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          Connection: 'close',
        },
        timeoutMs: Math.max(1000, Math.min(5000, deadline - Date.now())),
        maxBytes: C.LIMITS.responseHardMaxBytes,
        signal,
      });
      if (response.status === 202) {
        await delay(250);
        continue;
      }
      if (response.status === 404) {
        throw new C.BridgeError('not_found', `任务不存在：${id}`);
      }
      if (response.status !== 200) {
        throw errorFromHttp(response.status, response.json);
      }
      return response.json;
    }
    throw new C.BridgeError('timeout', `任务 ${id} 在 ${budgetMs}ms 内未完成。`, { job: id });
  }

  /**
   * GET /v1/status (authenticated).
   *
   * @param {{timeoutMs?: number}} [statusOptions]
   * @returns {Promise<object>}
   */
  async function getStatus(statusOptions = {}) {
    const timeoutMs = statusOptions.timeoutMs || 10000;
    const runtime = await ensureRunning(timeoutMs);
    const token = currentToken();
    if (!token) throw new C.BridgeError('auth_unavailable');
    let response = await requestJson({
      port: runtime.port,
      path: '/v1/status',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        Connection: 'close',
      },
      timeoutMs,
      maxBytes: C.LIMITS.responseHardMaxBytes,
    });
    if (response.status === 404) {
      response = await requestJson({
        port: runtime.port,
        path: '/status',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          Connection: 'close',
        },
        timeoutMs,
        maxBytes: C.LIMITS.responseHardMaxBytes,
      });
    }
    if (response.status !== 200) throw errorFromHttp(response.status, response.json);
    return response.json;
  }

  return {
    callTool,
    getStatus,
    ensureDaemon: () => ensureRunning(10000),
    readRuntime: () => readRuntimeFile(config),
    health: () => {
      const runtime = readRuntimeFile(config);
      return runtime ? checkHealth(runtime.port) : Promise.resolve(false);
    },
  };
}

// ── MCP context ─────────────────────────────────────────────────────────────

/**
 * Build the per-server context. A context without a daemon client has no
 * execution path; tools/call then returns not_implemented, exactly as the
 * scaffold did, because nothing was wired into *that* context.
 *
 * @param {{
 *   config?: object|null,
 *   configError?: Error|null,
 *   logger?: object,
 *   deps?: object,
 * }} [options]
 */
function createContext(options = {}) {
  const config = options.config || null;
  const logger = options.logger || silentLogger;
  const deps = options.deps && typeof options.deps === 'object' ? options.deps : {};

  let client = deps.client || null;
  let clientError = null;
  if (!client && config) {
    try {
      client = createDaemonClient({
        config,
        logger,
        autostart: deps.autostart,
        startDaemon: deps.startDaemon,
      });
    } catch (err) {
      clientError = err;
    }
  }

  const active = new Map();
  const autostart =
    deps.autostart !== undefined
      ? Boolean(deps.autostart)
      : String(process.env.KHY_AMOON_MCP_AUTOSTART || '1') !== '0';

  const ctx = {
    config,
    configError: options.configError || null,
    clientError,
    logger,
    active,
    autostart,
    toolList: () => C.TOOLS.map((tool) => C.descriptorToMcp(tool)),
    cancel(requestId) {
      if (requestId === undefined || requestId === null) return false;
      const controller = active.get(String(requestId));
      if (!controller) return false;
      controller.abort();
      return true;
    },
    async execute(name, args, callOptions = {}) {
      if (!client) {
        throw clientError
          ? asBridgeError(clientError)
          : new C.BridgeError('daemon_unavailable', '当前上下文没有注入 daemon 客户端。');
      }
      return client.callTool(name, args, callOptions);
    },
    hasExecutor: Boolean(client),
  };
  return ctx;
}

// ── tools/call ──────────────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {object} ctx
 * @param {AbortSignal} [signal]
 * @returns {object|Promise<object>} MCP tool result
 */
function callTool(params, ctx, signal) {
  if (ctx.configError) {
    const err = asBridgeError(ctx.configError);
    return toolError(err.code, `配置加载失败：${err.message}`, err.details);
  }

  const parsed = readToolCallParams(params);
  if (!parsed.ok) return parsed.result;

  if (!ctx.hasExecutor) {
    return toolError(
      'not_implemented',
      '当前 MCP 上下文没有注入 daemon 执行器（createContext 未提供 deps/client）；' +
        '本次调用没有执行任何 ADB/HTTP/信箱操作。真实入口 bin/mcp-server.js 已接线到 daemon HTTP。'
    );
  }

  if (ctx.logger && typeof ctx.logger.debug === 'function') {
    ctx.logger.debug('tools/call forwarding to daemon', {
      tool: parsed.name,
      arg_keys: Object.keys(parsed.args),
    });
  }

  let promise;
  try {
    promise = ctx.execute(parsed.name, parsed.args, { signal });
  } catch (err) {
    const be = asBridgeError(err);
    return toolError(be.code, be.message, be.details);
  }

  if (!promise || typeof promise.then !== 'function') {
    return envelopeToToolResult(promise, parsed.descriptor);
  }

  return promise.then(
    (envelope) => envelopeToToolResult(envelope, parsed.descriptor),
    (err) => {
      const be = asBridgeError(err);
      return toolError(be.code, be.message, be.details);
    }
  );
}

// ── JSON-RPC method dispatch ────────────────────────────────────────────────

/**
 * @param {object} msg parsed JSON-RPC message
 * @param {object} ctx
 * @returns {object|null|Promise<object|null>} response, or null for notifications
 */
function handleMessage(msg, ctx) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return msg.id === undefined ? null : rpcError(msg.id, -32600, 'Invalid Request');
  }

  const isNotification = msg.id === undefined;
  const id = msg.id === undefined ? null : msg.id;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};

  switch (msg.method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
      return result(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    case 'notifications/initialized':
    case 'initialized':
      return null;

    case 'notifications/cancelled': {
      const requestId = params.requestId;
      if (requestId !== undefined && requestId !== null && ctx && typeof ctx.cancel === 'function') {
        ctx.cancel(requestId);
      }
      return null;
    }

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, { tools: ctx.toolList() });

    case 'tools/call': {
      const controller = new AbortController();
      const key = String(id);
      const response = callTool(params, ctx, controller.signal);
      if (!response || typeof response.then !== 'function') return result(id, response);
      if (ctx && ctx.active && ctx.active.set) ctx.active.set(key, controller);
      return response
        .then((value) => result(id, value))
        .catch((err) => {
          const be = asBridgeError(err);
          return result(id, toolError(be.code, be.message, be.details));
        })
        .finally(() => {
          if (ctx && ctx.active && ctx.active.delete) ctx.active.delete(key);
        });
    }

    case 'resources/list':
      return result(id, { resources: [] });

    case 'resources/templates/list':
      return result(id, { resourceTemplates: [] });

    case 'prompts/list':
      return result(id, { prompts: [] });

    case 'logging/setLevel':
      return result(id, {});

    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

/**
 * @param {string} line
 * @param {object} ctx
 * @returns {object|null|Promise<object|null>}
 */
function handleLine(line, ctx) {
  const text = typeof line === 'string' ? line.trim() : '';
  if (!text) return null;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  return handleMessage(msg, ctx);
}

// ── stdio plumbing ──────────────────────────────────────────────────────────

/**
 * Write exactly one protocol frame. Never logs to stdout.
 *
 * @param {{write: Function}} stdout
 * @param {object} frame
 * @param {object} [logger]
 */
function writeFrame(stdout, frame, logger) {
  let line;
  try {
    line = `${JSON.stringify(frame)}\n`;
  } catch (err) {
    if (logger && logger.error) logger.error('failed to serialize MCP frame', err);
    return;
  }
  try {
    stdout.write(line);
  } catch (err) {
    if (logger && logger.error) logger.error('failed to write MCP frame to stdout', err);
  }
}

/**
 * Run the newline-delimited JSON-RPC loop until stdin closes.
 *
 * @param {{
 *   stdin?: object, stdout?: object, stderr?: object,
 *   config?: object|null, configError?: Error|null, logger?: object,
 *   deps?: object, ctx?: object,
 * }} options
 * @returns {Promise<void>}
 */
function runStdio(options = {}) {
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const logger =
    options.logger ||
    createLogger({
      level: options.config ? options.config.log.level : 'info',
      file: null,
      stderr: options.stderr || process.stderr,
    });

  const ctx =
    options.ctx ||
    createContext({
      config: options.config || null,
      configError: options.configError || null,
      logger,
      deps: options.deps,
    });

  logger.info('MCP stdio server started', {
    tools: ctx.toolList().length,
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    executor: Boolean(ctx.hasExecutor),
    autostart: ctx.autostart,
  });

  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  const pending = new Set();
  let settled = false;
  // Pending requests (e.g. a tools/call that is waiting for the daemon) must
  // keep the event loop alive even when the client closes stdin right after
  // sending. Promise continuations alone are not handles.
  let keepAlive = null;
  const refLoop = () => {
    if (!keepAlive) keepAlive = setInterval(() => {}, 1000);
  };
  const releaseLoop = () => {
    if (keepAlive && pending.size === 0) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
  };

  const track = (promise) => {
    pending.add(promise);
    refLoop();
    promise.then(
      () => {
        pending.delete(promise);
        releaseLoop();
      },
      () => {
        pending.delete(promise);
        releaseLoop();
      }
    );
    return promise;
  };

  rl.on('line', (line) => {
    let response;
    try {
      response = handleLine(line, ctx);
    } catch (err) {
      logger.error('unhandled error while parsing a message', err);
      response = rpcError(null, -32603, 'Internal error');
    }
    track(
      Promise.resolve(response)
        .then((frame) => {
          if (frame) writeFrame(stdout, frame, logger);
        })
        .catch((err) => {
          logger.error('MCP message handling failed', err);
          writeFrame(stdout, rpcError(null, -32603, 'Internal error'), logger);
        })
    );
  });

  rl.on('error', (err) => {
    logger.error('stdin read failed', err);
    if (!settled) {
      settled = true;
      Promise.allSettled([...pending]).then(() => {});
    }
  });

  return new Promise((resolve) => {
    rl.on('close', () => {
      settled = true;
      Promise.allSettled([...pending]).then(() => {
        logger.info('MCP stdio server stopped');
        resolve();
      });
    });
  });
}

// ── Server object ───────────────────────────────────────────────────────────

/**
 * Frozen contract export (module D): createStdioServer({config, deps}).
 *
 * @param {{config?: object|null, deps?: object}} [options]
 * @returns {{handleMessage: Function, handleLine: Function, run: Function, toolList: Function, context: object}}
 */
function createStdioServer(options = {}) {
  const config = options.config || null;
  const deps = options.deps && typeof options.deps === 'object' ? options.deps : {};
  const logger = deps.logger || silentLogger;
  const ctx = createContext({
    config,
    configError: deps.configError || null,
    logger,
    deps,
  });

  return {
    handleMessage: (msg) => handleMessage(msg, ctx),
    handleLine: (line) => handleLine(line, ctx),
    run: (streams = {}) =>
      runStdio({
        stdin: streams.stdin,
        stdout: streams.stdout,
        stderr: streams.stderr,
        logger,
        ctx,
      }),
    toolList: () => ctx.toolList(),
    context: ctx,
  };
}

// ── argv / process entry ────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {{root:string|null,stateDir:string|null,khyJs:string|null,autostart:boolean,help:boolean,version:boolean}}
 */
function parseServerArgs(argv) {
  const out = {
    root: null,
    stateDir: null,
    khyJs: null,
    autostart: true,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') out.root = argv[++i] || null;
    else if (arg === '--state-dir') out.stateDir = argv[++i] || null;
    else if (arg === '--khy-js') out.khyJs = argv[++i] || null;
    else if (arg === '--no-autostart') out.autostart = false;
    else if (arg === '--autostart') out.autostart = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--version' || arg === '-v') out.version = true;
    // Unknown args are ignored: KhyOS may append client-specific flags.
  }
  return out;
}

function usage() {
  return [
    'khy-amoon-bridge MCP server (stdio)',
    '',
    '用法: node bin/mcp-server.js [--root <extRoot>] [--state-dir <dir>] [--khy-js <path>] [--no-autostart]',
    '',
    '协议帧走 stdout；日志走 stderr。--help 只写 stderr，避免污染协议流。',
    '环境变量: KHY_AMOON_MCP_AUTOSTART=0 关闭 daemon 自动启动。',
  ].join('\n');
}

/**
 * @param {string[]} [argv]
 * @param {{stdin?:object,stdout?:object,stderr?:object}} [io]
 * @returns {number} process exit code for immediate failures
 */
function startFromProcess(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const parsed = parseServerArgs(argv);

  if (parsed.help) {
    stderr.write(`${usage()}\n`);
    return 0;
  }
  if (parsed.version) {
    stdout.write(`${C.BRIDGE_VERSION}\n`);
    return 0;
  }

  let config = null;
  let configError = null;
  try {
    // loadConfig reads env + stateDir; require it here so --state-dir wins.
    // eslint-disable-next-line global-require
    const { loadConfig } = require('./config');
    config = loadConfig({
      stateDir: parsed.stateDir || undefined,
      khyJs: parsed.khyJs || undefined,
    });
  } catch (err) {
    configError = err;
  }

  const logger = createLogger({
    level: config ? config.log.level : 'info',
    file: null,
    stderr,
  });

  if (configError) {
    logger.error('配置加载失败；tools/list 仍可用，tools/call 将返回 invalid_config', {
      code: configError.code,
      message: configError.message,
    });
  }
  if (parsed.root && config && path.resolve(parsed.root) !== path.resolve(config.extRoot)) {
    logger.warn('--root differs from the resolved extension root', {
      arg: path.resolve(parsed.root),
      resolved: config.extRoot,
    });
  }

  const server = createStdioServer({
    config,
    deps: { logger, configError, autostart: parsed.autostart },
  });

  server
    .run({ stdin: io.stdin || process.stdin, stdout, stderr })
    .catch((err) => {
      logger.error('fatal MCP stdio error', err);
      process.exitCode = 1;
    });

  return 0;
}

module.exports = {
  SERVER_INFO,
  DEFAULT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  INSTRUCTIONS,
  createStdioServer,
  createContext,
  createDaemonClient,
  checkHealth,
  readRuntimeFile,
  envelopeToToolResult,
  toolError,
  callTool,
  handleMessage,
  handleLine,
  runStdio,
  parseServerArgs,
  startFromProcess,
};
