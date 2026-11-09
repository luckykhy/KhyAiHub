'use strict';

/**
 * server.js — loopback-only HTTP front-end for lib/local-tools.js.
 *
 * Endpoints (the contract paths are the same under /v1/*):
 *   GET  /health        no auth, returns exactly {"ok":true}
 *   GET  /status        Bearer, runtime/tool/task snapshot
 *   POST /call          Bearer, {tool,args?,id?,wait_ms?} -> envelope
 *   GET  /tools         Bearer, registered tool descriptors
 *   GET  /jobs/<id>     Bearer (operator), async job status/result
 *   POST /rotate[/commit] Bearer (operator), two-phase phone-token rotation
 *   GET  /audit/tail    Bearer (operator), recent audit records
 *
 * Status semantics:
 *   200 tool result (ok:true) or tool-domain failure (ok:false)
 *   202 async job accepted (khy.ask / task.submit), body has job_id
 *   400 malformed JSON, bad params, wrong Content-Type
 *   401 missing/wrong Bearer
 *   403 browser Origin, bad Host, read-only/scope refusal
 *   404 unknown route or tool
 *   405 known route, wrong method (Allow header)
 *   413 request body or response payload too large
 *   429 rate limited (Retry-After)
 *   500 unexpected handler error (message is not leaked)
 *   503 operator token file missing/short (fail-closed)
 *   504 tool timeout
 *
 * Security posture:
 *   - The listener is always 127.0.0.1; host is not configurable.
 *   - Host must be 127.0.0.1:<actual-port> or localhost:<actual-port>.
 *   - Any Origin header is rejected; there is no CORS support.
 *   - Tokens are compared in constant time (lib/auth.js).
 *   - Every /call attempt is audited; args are stored as digest/keys/length,
 *     never raw.
 */

const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');

const C = require('./contracts');
const { createAuth, parseBearer, createTokenStore, createCompositeAuth } = require('./auth');
const { createAudit } = require('./audit');
const { createRateLimiter } = require('./ratelimit');
const { createIdempotency, digestOf } = require('./idempotency');
const { createLocalTools, LOCAL_VERSION } = require('./local-tools');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 17901;
const LOCAL_PROTOCOL = 'khy-local-tools/1';
const MAX_WAIT_MS = 30000;

// ── Config ──────────────────────────────────────────────────────────────────

function defaultStateDir(env) {
  if (typeof env.KHY_LOCAL_HOME === 'string' && env.KHY_LOCAL_HOME.trim()) {
    return path.resolve(env.KHY_LOCAL_HOME.trim());
  }
  if (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim()) {
    return path.join(path.resolve(env.LOCALAPPDATA.trim()), 'khy-local-tools');
  }
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Local', 'khy-local-tools');
  }
  return path.join(os.homedir(), '.local', 'state', 'khy-local-tools');
}

function parseRootList(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.trim() === '*') return ['*'];
  const parts = value.split(path.delimiter).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

function parsePort(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const text = String(raw).trim();
  if (!/^\d{1,5}$/.test(text)) {
    throw new C.BridgeError('invalid_config', `KHY_LOCAL_PORT 必须是整数：${text}`);
  }
  const port = Number(text);
  if (port < 0 || port > 65535) {
    throw new C.BridgeError('invalid_config', `KHY_LOCAL_PORT 必须在 0..65535：${port}`);
  }
  return port;
}

/**
 * Build the local server config. Explicit options win over KHY_LOCAL_* env vars.
 *
 * @param {{
 *   env?: object, stateDir?: string, port?: number, tokenFile?: string,
 *   writeRoots?: string[]|string, readRoots?: string[]|string,
 *   cwdAllowlist?: string[]|string, khyJs?: string|null,
 *   readOnly?: boolean, allowExec?: boolean,
 *   rateLimitPerMinute?: number, bodyLimit?: number,
 * }} [options]
 */
function resolveConfig(options = {}) {
  const env = options.env || process.env;
  const stateDir = options.stateDir ? path.resolve(options.stateDir) : defaultStateDir(env);
  const port = options.port === undefined ? parsePort(env.KHY_LOCAL_PORT, DEFAULT_PORT) : options.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new C.BridgeError('invalid_config', `端口不合法：${port}`);
  }
  const tokenFile = options.tokenFile
    ? path.resolve(options.tokenFile)
    : typeof env.KHY_LOCAL_TOKEN_FILE === 'string' && env.KHY_LOCAL_TOKEN_FILE.trim()
      ? path.resolve(env.KHY_LOCAL_TOKEN_FILE.trim())
      : path.join(stateDir, C.STATE_FILES.operatorToken);

  const writeRoots = options.writeRoots || parseRootList(env.KHY_LOCAL_ROOTS) || [stateDir, os.homedir()];
  const readRoots = options.readRoots || parseRootList(env.KHY_LOCAL_READ_ROOTS) || null;
  const cwdAllowlist = options.cwdAllowlist || parseRootList(env.KHY_LOCAL_CWD_ALLOWLIST) || [process.cwd(), stateDir];
  const rateLimitPerMinute = Number.isFinite(options.rateLimitPerMinute)
    ? options.rateLimitPerMinute
    : Number(env.KHY_LOCAL_RATE_PER_MIN || 60);

  return {
    version: LOCAL_VERSION,
    protocol: LOCAL_PROTOCOL,
    host: DEFAULT_HOST,
    port,
    stateDir,
    local: { tokenFile },
    paths: {
      stateDir,
      operatorToken: tokenFile,
      tokens: path.join(stateDir, C.STATE_FILES.tokens),
      runtime: path.join(stateDir, C.STATE_FILES.runtime),
      log: path.join(stateDir, C.STATE_FILES.log),
      dirs: { audit: path.join(stateDir, C.LOCAL_SUBDIRS.audit) },
    },
    writeRoots,
    readRoots,
    cwdAllowlist,
    khyJs: options.khyJs !== undefined ? options.khyJs : env.KHY_JS || null,
    readOnly: options.readOnly !== undefined ? options.readOnly : env.KHY_LOCAL_READONLY === '1',
    allowExec: options.allowExec !== undefined ? options.allowExec : env.KHY_LOCAL_ALLOW_EXEC !== '0',
    rateLimitPerMinute: Number.isFinite(rateLimitPerMinute) && rateLimitPerMinute > 0 ? rateLimitPerMinute : 60,
    bodyLimit: Number.isFinite(options.bodyLimit) && options.bodyLimit > 0 ? options.bodyLimit : C.LIMITS.requestBodyBytes,
  };
}

// ── Small helpers ───────────────────────────────────────────────────────────

function nowMs(clock) {
  return clock();
}

function normalizeClock(value) {
  if (typeof value === 'function') return value;
  if (value && typeof value.now === 'function') return value.now.bind(value);
  return Date.now;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function safeStringify(value) {
  try {
    return JSON.stringify(value === undefined ? {} : value);
  } catch {
    return '"[unserializable]"';
  }
}

function summarizeArgs(args) {
  const object = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const text = safeStringify(object);
  return {
    args_sha256: sha256(text),
    args_bytes: Buffer.byteLength(text, 'utf8'),
    args_keys: Object.keys(object).sort().slice(0, 32),
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function remoteOf(req) {
  return (req.socket && (req.socket.remoteAddress || '')) || null;
}

function pickRequestId(req) {
  const raw = req.headers['x-request-id'];
  if (typeof raw === 'string' && C.isValidId(raw)) return raw;
  return crypto.randomUUID();
}

function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded || res.headersSent) return;
  let body;
  try {
    body = Buffer.from(JSON.stringify(payload), 'utf8');
  } catch {
    // A handler must not be able to crash the response path with a value
    // JSON.stringify cannot represent (BigInt, cycles).
    status = 500;
    body = Buffer.from(
      JSON.stringify({ ok: false, error: { code: 'internal_error', message: '内部错误' } }),
      'utf8'
    );
  }
  const base = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    Connection: 'close',
    ...headers,
  };
  res.writeHead(status, base);
  res.end(body);
}

// ── Server ──────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   config?: object,
 *   env?: object,
 *   stateDir?: string,
 *   port?: number,
 *   auth?: object,
 *   audit?: object,
 *   tools?: object,
 *   rateLimiter?: object,
 *   logger?: object,
 *   clock?: Function|{now:Function},
 *   writeRoots?: string[]|string,
 *   readRoots?: string[]|string,
 *   cwdAllowlist?: string[]|string,
 *   khyJs?: string|null,
 *   readOnly?: boolean,
 *   allowExec?: boolean,
 *   rateLimitPerMinute?: number,
 *   bodyLimit?: number,
 * }} [options]
 */
function createServer(options = {}) {
  const baseConfig = options.config || resolveConfig(options);
  // Fill the safety-relevant defaults even when a caller supplies its own
  // config object: an absent bodyLimit would silently remove the request cap.
  const config = {
    ...baseConfig,
    host: DEFAULT_HOST,
    port: options.port === undefined ? baseConfig.port : options.port,
    bodyLimit:
      Number.isFinite(baseConfig.bodyLimit) && baseConfig.bodyLimit > 0
        ? baseConfig.bodyLimit
        : C.LIMITS.requestBodyBytes,
    rateLimitPerMinute:
      Number.isFinite(baseConfig.rateLimitPerMinute) && baseConfig.rateLimitPerMinute > 0
        ? baseConfig.rateLimitPerMinute
        : 60,
  };
  const clock = normalizeClock(options.clock);
  const logger = options.logger || null;

  let tokenStore = options.tokenStore || null;
  if (!tokenStore) {
    try {
      tokenStore = createTokenStore({ config, logger });
    } catch {
      tokenStore = null;
    }
  }

  // Default auth accepts operator.token AND issued phone tokens. The daemon
  // may still inject a custom adapter.
  const auth = options.auth || createCompositeAuth({ config, logger, tokenStore });
  const audit = options.audit || createAudit({ config, logger, clock });
  const idempotency = options.idempotency || createIdempotency({ config, clock });
  const tools =
    options.tools ||
    createLocalTools({
      stateDir: config.stateDir,
      writeRoots: config.writeRoots,
      readRoots: config.readRoots,
      cwdAllowlist: config.cwdAllowlist,
      khyJs: config.khyJs,
      readOnly: config.readOnly,
      allowExec: config.allowExec,
      logger,
      clock,
    });
  const limiter = options.rateLimiter || createRateLimiter({ perMinute: config.rateLimitPerMinute, now: clock });
  // Per-scope limiters (operator 60/min, phone 30/min, file 30/min by default).
  const scopeLimits = config.rateLimits || {};
  const limiters = options.rateLimiter
    ? { operator: options.rateLimiter, phone: options.rateLimiter, file: options.rateLimiter }
    : {
        operator: createRateLimiter({
          perMinute: (scopeLimits.operator && scopeLimits.operator.perMinute) || config.rateLimitPerMinute,
          now: clock,
        }),
        phone: createRateLimiter({
          perMinute: (scopeLimits.phone && scopeLimits.phone.perMinute) || 30,
          now: clock,
        }),
        file: createRateLimiter({
          perMinute: (scopeLimits.file && scopeLimits.file.perMinute) || 30,
          now: clock,
        }),
      };

  function limiterFor(scope) {
    return limiters[scope] || limiters.file;
  }

  const counters = { requests: 0, authorized: 0, rejected: 0, tool_calls: 0, errors: 0, rate_limited: 0 };
  let actualPort = config.port;

  function auditCall(entry) {
    const principal = entry.principal && typeof entry.principal === 'object' ? entry.principal : null;
    const principalLabel = principal && typeof principal.scope === 'string'
      ? `${principal.scope}${principal.tokenId ? `:${principal.tokenId}` : ''}`
      : 'anonymous';
    try {
      audit.write({
        event: 'tool_call',
        source: 'http',
        principal: principalLabel,
        ...summarizeArgs(entry.args),
        request_id: entry.requestId || null,
        tool: entry.tool || null,
        ok: entry.ok === true,
        replayed: entry.replayed === true,
        error_code: entry.errorCode || null,
        duration_ms: entry.durationMs,

        status: entry.status,
        remote: entry.remote || null,
      });
    } catch (err) {
      if (logger && typeof logger.error === 'function') {
        logger.error('audit append failed', { error: err.message });
      }
    }
  }

  function hostAllowed(req) {
    const host = String(req.headers.host || '').toLowerCase();
    return host === `127.0.0.1:${actualPort}` || host === `localhost:${actualPort}`;
  }

  function envelopeError(requestId, tool, started, err, status) {
    const bridgeError = C.isBridgeError(err)
      ? err
      : new C.BridgeError('internal_error', '内部错误');
    return {
      status,
      payload: {
        ok: false,
        id: requestId,
        tool: tool || null,
        ts: new Date(clock()).toISOString(),
        duration_ms: Math.max(0, clock() - started),
        error: bridgeError.toJSON(),
      },
    };
  }

  function authenticate(req) {
    const token = parseBearer(req.headers.authorization);
    if (!token) {
      return { ok: false, status: 401, error: new C.BridgeError('unauthorized', '缺少 Bearer token') };
    }
    const availability = typeof auth.available === 'function' ? auth.available() : true;
    if (!availability) {
      return {
        ok: false,
        status: 503,
        error: new C.BridgeError('auth_unavailable', 'operator token 文件缺失或过短，拒绝服务（fail-closed）'),
      };
    }
    const detail = typeof auth.verifyDetailed === 'function' ? auth.verifyDetailed(token) : { ok: auth.verify(token), reason: 'ok' };
    if (!detail.ok) {
      if (detail.reason === 'token_file_missing_or_short') {
        return {
          ok: false,
          status: 503,
          error: new C.BridgeError('auth_unavailable', 'operator token 文件缺失或过短，拒绝服务（fail-closed）'),
        };
      }
      return { ok: false, status: 401, error: new C.BridgeError('unauthorized', 'Bearer token 无效') };
    }
    return {
      ok: true,
      principal:
        detail.principal && typeof detail.principal === 'object' && Object.values(C.SCOPES).includes(detail.principal.scope)
          ? {
              kind: detail.principal.kind || detail.principal.scope,
              scope: detail.principal.scope,
              tokenId: detail.principal.tokenId || null,
              source: 'http',
            }
          : { kind: 'operator', scope: 'operator', tokenId: 'operator', source: 'http' },
    };
  }

  /**
   * Authenticate a non-/call route. `operatorOnly` protects admin endpoints
   * (rotate, audit tail, jobs) even when a phone token is otherwise valid.
   */
  function authorizeRoute(req, operatorOnly = false) {
    const result = authenticate(req);
    if (!result.ok) return result;
    if (operatorOnly && result.principal.scope !== C.SCOPES.OPERATOR) {
      return {
        ok: false,
        status: 403,
        error: new C.BridgeError('forbidden_scope', '该端点只允许 operator token'),
      };
    }
    return result;
  }

  function rejectAuth(res, requestId, started, authResult) {
    counters.rejected += 1;
    const out = envelopeError(requestId, null, started, authResult.error, authResult.status);
    sendJson(res, authResult.status, out.payload, { 'X-Request-Id': requestId });
  }

  /**
   * Read a JSON object body with a hard byte cap. On overflow the promise
   * rejects immediately and the rest of the request is drained.
   */
  function readJsonBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      let overflow = false;
      const chunks = [];
      req.on('data', (chunk) => {
        if (overflow) return;
        size += chunk.length;
        if (size > limit) {
          overflow = true;
          chunks.length = 0;
          reject(new C.BridgeError('payload_too_large', `请求体超过 ${limit} 字节上限`, { limit }));
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (overflow) return;
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) {
          resolve({});
          return;
        }
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          reject(new C.BridgeError('invalid_request', '请求体不是合法 JSON'));
          return;
        }
        if (!isPlainObject(value)) {
          reject(new C.BridgeError('invalid_request', '请求体必须是 JSON 对象'));
          return;
        }
        resolve(value);
      });
      req.on('error', (err) => {
        if (!overflow) reject(new C.BridgeError('invalid_request', `读取请求体失败：${err.message}`));
      });
    });
  }

  async function handleCall(req, res, ctx) {
    const { requestId: initialId, started } = ctx;
    let requestId = initialId;
    let tool = null;
    let args = null;

    const authResult = authenticate(req);
    if (!authResult.ok) {
      counters.rejected += 1;
      auditCall({
        requestId,
        tool: null,
        args: null,
        ok: false,
        errorCode: authResult.error.code,
        durationMs: clock() - started,
        status: authResult.status,
        remote: remoteOf(req),
      });
      const out = envelopeError(requestId, null, started, authResult.error, authResult.status);
      sendJson(res, authResult.status, out.payload, { 'X-Request-Id': requestId });
      return;
    }
    counters.authorized += 1;

    const limit = limiterFor(authResult.principal.scope).check(authResult.principal.tokenId);
    if (!limit.allowed) {
      counters.rate_limited += 1;
      counters.rejected += 1;
      auditCall({
        requestId,
        principal: authResult.principal,
        tool: null,
        args: null,
        ok: false,
        errorCode: 'rate_limited',
        durationMs: clock() - started,
        status: 429,
        remote: remoteOf(req),
      });
      const out = envelopeError(requestId, null, started, new C.BridgeError('rate_limited'), 429);
      sendJson(res, 429, out.payload, {
        'X-Request-Id': requestId,
        'Retry-After': String(limit.retryAfter),
      });
      return;
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (contentType && !contentType.startsWith('application/json')) {
      counters.rejected += 1;
      const out = envelopeError(
        requestId,
        null,
        started,
        new C.BridgeError('invalid_request', 'Content-Type 必须是 application/json'),
        400
      );
      sendJson(res, 400, out.payload, { 'X-Request-Id': requestId });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req, config.bodyLimit);
    } catch (err) {
      counters.rejected += 1;
      const status = C.isBridgeError(err) ? err.http : 400;
      const out = envelopeError(requestId, null, started, err, status);
      auditCall({
        requestId,
        principal: authResult.principal,
        tool: null,
        args: null,
        ok: false,
        errorCode: out.payload.error.code,
        durationMs: clock() - started,
        status,
        remote: remoteOf(req),
      });
      sendJson(res, status, out.payload, { 'X-Request-Id': requestId });
      return;
    }

    if (typeof body.tool !== 'string' || !body.tool) {
      counters.rejected += 1;
      const out = envelopeError(
        requestId,
        null,
        started,
        new C.BridgeError('invalid_request', '缺少 tool 字段'),
        400
      );
      sendJson(res, 400, out.payload, { 'X-Request-Id': requestId });
      return;
    }
    tool = body.tool;
    args = body.args === undefined || body.args === null ? {} : body.args;

    if (!isPlainObject(args)) {
      counters.rejected += 1;
      const out = envelopeError(requestId, tool, started, new C.BridgeError('invalid_args', 'args 必须是 JSON 对象'), 400);
      sendJson(res, 400, out.payload, { 'X-Request-Id': requestId });
      return;
    }

    if (body.id !== undefined) {
      if (!C.isValidId(body.id)) {
        counters.rejected += 1;
        const out = envelopeError(
          requestId,
          tool,
          started,
          new C.BridgeError('invalid_args', 'id 必须是 8..64 位 [A-Za-z0-9_-]'),
          400
        );
        sendJson(res, 400, out.payload, { 'X-Request-Id': requestId });
        return;
      }
      if (!req.headers['x-request-id']) requestId = body.id;
    }

    let waitMs = 0;
    if (body.wait_ms !== undefined && body.wait_ms !== null) {
      if (!Number.isInteger(body.wait_ms) || body.wait_ms < 0 || body.wait_ms > MAX_WAIT_MS) {
        counters.rejected += 1;
        const out = envelopeError(
          requestId,
          tool,
          started,
          new C.BridgeError('invalid_args', `wait_ms 必须是 0..${MAX_WAIT_MS} 的整数`),
          400
        );
        sendJson(res, 400, out.payload, { 'X-Request-Id': requestId });
        return;
      }
      waitMs = body.wait_ms;
    }

    const descriptor = typeof tools.get === 'function' ? tools.get(tool) : null;
    if (!descriptor) {
      counters.rejected += 1;
      auditCall({
        requestId,
        principal: authResult.principal,
        tool,
        args,
        ok: false,
        errorCode: 'not_found',
        durationMs: clock() - started,
        status: 404,
        remote: remoteOf(req),
      });
      const out = envelopeError(requestId, tool, started, new C.BridgeError('not_found', `未知工具：${tool}`), 404);
      sendJson(res, 404, out.payload, { 'X-Request-Id': requestId });
      return;
    }

    counters.tool_calls += 1;

    // Idempotency: body.id + principal is the key; tool+args is the digest.
    // A replay returns the stored status/payload with replayed:true. A
    // different digest, or a concurrent duplicate, is id_conflict and never
    // executes the tool a second time.
    let idem = null;
    if (body.id !== undefined) {
      const key = `${authResult.principal.scope}:${authResult.principal.tokenId || ''}:${body.id}`;
      const digest = digestOf(tool, args);
      const begun = idempotency.begin(key, digest);
      if (begun.state === 'replay') {
        const replayStatus = begun.entry.response.status;
        const replayPayload = { ...begun.entry.response.payload, replayed: true };
        auditCall({
          requestId,
          principal: authResult.principal,
          tool,
          args,
          ok: replayPayload.ok === true,
          errorCode: replayPayload.error && replayPayload.error.code ? replayPayload.error.code : null,
          durationMs: 0,
          status: replayStatus,
          remote: remoteOf(req),
          replayed: true,
        });
        sendJson(res, replayStatus, replayPayload, {
          'X-Request-Id': requestId,
          'X-Idempotent-Replay': '1',
        });
        return;
      }
      if (begun.state === 'conflict' || begun.state === 'in_flight') {
        counters.rejected += 1;
        const message =
          begun.state === 'in_flight'
            ? '同一 id 正在执行，拒绝并发重复执行'
            : '同一 id 已用于不同的工具参数（id_conflict）';
        const out = envelopeError(requestId, tool, started, new C.BridgeError('id_conflict', message), 409);
        sendJson(res, 409, out.payload, { 'X-Request-Id': requestId });
        return;
      }
      idem = { key, digest };
    }

    function finishCall(status, payload, headers = {}, opts = {}) {
      if (idem) {
        if (opts.commit === false) idempotency.abort(idem.key);
        else idempotency.commit(idem.key, idem.digest, { status, payload });
      }
      sendJson(res, status, payload, { 'X-Request-Id': requestId, ...headers });
    }

    const controller = new AbortController();
    const toolTimeoutMs = Math.min(Math.max(descriptor.timeoutMs || 30000, 1000) + 5000, 120000);
    const killTimer = setTimeout(() => controller.abort(), toolTimeoutMs);
    let status = 200;
    let payload = null;
    let errorCode = null;

    try {
      const result = await tools.call(tool, args, {
        requestId,
        source: 'http',
        signal: controller.signal,
        principal: authResult.principal,
      });
      let data = result.data;

      if (data && data.pending === true && typeof data.job_id === 'string') {
        if (waitMs > 0 && typeof tools.waitForJob === 'function') {
          const job = await tools.waitForJob(data.job_id, waitMs, controller.signal);
          if (job.state === 'done') {
            data = job.result;
            status = 200;
          } else if (job.state === 'failed' || job.state === 'cancelled') {
            const code = job.error && typeof job.error.code === 'string' ? job.error.code : 'timeout';
            const message =
              job.state === 'cancelled'
                ? '任务已取消'
                : (job.error && job.error.message) || '后台任务失败';
            const bridgeError = new C.BridgeError(code, message, { job_id: data.job_id });
            errorCode = bridgeError.code;
            status = 200;
            payload = {
              ok: false,
              id: requestId,
              tool,
              ts: new Date(clock()).toISOString(),
              duration_ms: Math.max(0, clock() - started),
              error: bridgeError.toJSON(),
              job_id: data.job_id,
            };
          } else {
            status = 202;
            data = null;
          }
        } else {
          status = 202;
        }

        if (status === 202) {
          payload = {
            ok: true,
            id: requestId,
            tool,
            ts: new Date(clock()).toISOString(),
            duration_ms: Math.max(0, clock() - started),
            pending: true,
            job_id: data.job_id,
            state: data.state || 'queued',
          };
        }
      }

      if (!payload) {
        payload = {
          ok: true,
          id: requestId,
          tool,
          ts: new Date(clock()).toISOString(),
          duration_ms: Math.max(0, clock() - started),
          data,
        };
      }
    } catch (err) {
      counters.errors += 1;
      const bridgeError = C.isBridgeError(err) ? err : new C.BridgeError('internal_error', '内部错误');
      errorCode = bridgeError.code;
      status = bridgeError.http || 500;
      payload = {
        ok: false,
        id: requestId,
        tool,
        ts: new Date(clock()).toISOString(),
        duration_ms: Math.max(0, clock() - started),
        error: bridgeError.toJSON(),
      };
      if (!C.isBridgeError(err) && logger && typeof logger.error === 'function') {
        logger.error('tool handler failed', { tool, error: err && err.message, stack: err && err.stack });
      }
    } finally {
      clearTimeout(killTimer);
    }

    // Per-descriptor response cap: never let a tool smuggle an unbounded body
    // through the HTTP layer.
    const cap = descriptor.responseMaxBytes || C.LIMITS.responseDefaultBytes;
    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      serialized = null;
    }
    if (serialized === null) {
      status = 500;
      errorCode = 'internal_error';
      payload = {
        ok: false,
        id: requestId,
        tool,
        ts: new Date(clock()).toISOString(),
        duration_ms: Math.max(0, clock() - started),
        error: new C.BridgeError('internal_error', '内部错误').toJSON(),
      };
    } else if (Buffer.byteLength(serialized, 'utf8') > cap) {
      status = 413;
      errorCode = 'payload_too_large';
      payload = {
        ok: false,
        id: requestId,
        tool,
        ts: new Date(clock()).toISOString(),
        duration_ms: Math.max(0, clock() - started),
        error: new C.BridgeError('payload_too_large', `响应超过工具上限 ${cap} 字节`).toJSON(),
      };
    }

    auditCall({
      requestId,
      principal: authResult.principal,
      tool,
      args,
      ok: status < 400 && payload.ok === true,
      errorCode,
      durationMs: clock() - started,
      status,
      remote: remoteOf(req),
    });
    // Do not freeze transient infrastructure failures into the replay store;
    // a retry with the same id should be allowed to run again.
    const retryable = status === 500 || status === 503 || status === 504;
    finishCall(status, payload, {}, { commit: !retryable });
  }

  async function handle(req, res) {
    const started = nowMs(clock);
    let requestId = pickRequestId(req);
    counters.requests += 1;

    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', `http://${DEFAULT_HOST}`).pathname;
    } catch {
      const out = envelopeError(requestId, null, started, new C.BridgeError('invalid_request', '非法请求路径'), 400);
      sendJson(res, 400, out.payload, { 'X-Request-Id': requestId });
      return;
    }

    // Contract paths are /v1/*; the in-tree shorthand /health,/status,/call is
    // kept for existing tests and tools. Map one to the other once, here.
    if (pathname === '/v1') pathname = '/';
    else if (pathname.startsWith('/v1/')) pathname = pathname.slice(3);

    if (req.headers.origin) {
      counters.rejected += 1;
      const out = envelopeError(
        requestId,
        null,
        started,
        new C.BridgeError('forbidden_scope', '不接受浏览器 Origin 请求（本服务不启用 CORS）'),
        403
      );
      sendJson(res, 403, out.payload, { 'X-Request-Id': requestId });
      return;
    }

    if (!hostAllowed(req)) {
      counters.rejected += 1;
      const out = envelopeError(
        requestId,
        null,
        started,
        new C.BridgeError('forbidden_scope', 'Host 头必须是 127.0.0.1 或 localhost 且端口匹配'),
        403
      );
      sendJson(res, 403, out.payload, { 'X-Request-Id': requestId });
      return;
    }

    if (pathname === '/health') {
      if (req.method !== 'GET') {
        sendJson(
          res,
          405,
          {
            ok: false,
            id: requestId,
            ts: new Date(clock()).toISOString(),
            duration_ms: Math.max(0, clock() - started),
            error: { code: 'invalid_request', message: '只允许 GET' },
          },
          { Allow: 'GET', 'X-Request-Id': requestId }
        );
        return;
      }
      // Minimal on purpose: no pid/version/serial/tool list on an
      // unauthenticated endpoint reachable through adb reverse.
      sendJson(res, 200, { ok: true }, { 'X-Request-Id': requestId });
      return;
    }

    if (pathname === '/status') {
      if (req.method !== 'GET') {
        sendJson(
          res,
          405,
          {
            ok: false,
            id: requestId,
            ts: new Date(clock()).toISOString(),
            duration_ms: Math.max(0, clock() - started),
            error: { code: 'invalid_request', message: '只允许 GET' },
          },
          { Allow: 'GET', 'X-Request-Id': requestId }
        );
        return;
      }
      const authResult = authenticate(req);
      if (!authResult.ok) {
        counters.rejected += 1;
        const out = envelopeError(requestId, null, started, authResult.error, authResult.status);
        sendJson(res, authResult.status, out.payload, { 'X-Request-Id': requestId });
        return;
      }
      counters.authorized += 1;
      const statusLimit = limiterFor(authResult.principal.scope).check(
        `status:${authResult.principal.tokenId}`
      );
      if (!statusLimit.allowed) {
        counters.rate_limited += 1;
        counters.rejected += 1;
        const out = envelopeError(requestId, null, started, new C.BridgeError('rate_limited'), 429);
        sendJson(res, 429, out.payload, {
          'X-Request-Id': requestId,
          'Retry-After': String(statusLimit.retryAfter),
        });
        return;
      }
      const toolStatus =
        typeof tools.status === 'function' ? tools.status(authResult.principal.scope) : {};
      const authInfo = typeof auth.describe === 'function' ? auth.describe() : { present: true, valid: true };
      const payload = {
        ok: true,
        id: requestId,
        ts: new Date(clock()).toISOString(),
        duration_ms: Math.max(0, clock() - started),
        data: {
          ...toolStatus,
          protocol: LOCAL_PROTOCOL,
          host: DEFAULT_HOST,
          port: actualPort,
          auth: { present: authInfo.present, valid: authInfo.valid, length: authInfo.length },
          security: {
            loopback_only: true,
            host_check: true,
            origin_rejected: true,
            token_constant_time: true,
            body_limit_bytes: config.bodyLimit,
            response_hard_max_bytes: C.LIMITS.responseHardMaxBytes,
          },
          counters: { ...counters },
          rate_limit: limiterFor(authResult.principal.scope).snapshot(),
        },
      };
      sendJson(res, 200, payload, { 'X-Request-Id': requestId });
      return;
    }

    if (pathname === '/tools') {
      if (req.method !== 'GET') {
        sendJson(
          res,
          405,
          {
            ok: false,
            id: requestId,
            ts: new Date(clock()).toISOString(),
            duration_ms: Math.max(0, clock() - started),
            error: { code: 'invalid_request', message: '只允许 GET' },
          },
          { Allow: 'GET', 'X-Request-Id': requestId }
        );
        return;
      }
      const authResult = authorizeRoute(req, false);
      if (!authResult.ok) {
        rejectAuth(res, requestId, started, authResult);
        return;
      }
      counters.authorized += 1;
      const list = typeof tools.list === 'function' ? tools.list(authResult.principal.scope) : [];
      sendJson(res, 200, {
        ok: true,
        id: requestId,
        ts: new Date(clock()).toISOString(),
        duration_ms: Math.max(0, clock() - started),
        data: {
          protocol: config.protocol || LOCAL_PROTOCOL,
          tools: list.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            risk: tool.risk,
            scopes: tool.scopes,
            phase: tool.phase,
            idempotent: tool.idempotent,
            responseMaxBytes: tool.responseMaxBytes,
          })),
        },
      }, { 'X-Request-Id': requestId });
      return;
    }

    if (pathname.startsWith('/jobs/')) {
      if (req.method !== 'GET') {
        sendJson(
          res,
          405,
          {
            ok: false,
            id: requestId,
            ts: new Date(clock()).toISOString(),
            duration_ms: Math.max(0, clock() - started),
            error: { code: 'invalid_request', message: '只允许 GET' },
          },
          { Allow: 'GET', 'X-Request-Id': requestId }
        );
        return;
      }
      const authResult = authorizeRoute(req, true);
      if (!authResult.ok) {
        rejectAuth(res, requestId, started, authResult);
        return;
      }
      counters.authorized += 1;
      const id = decodeURIComponent(pathname.slice('/jobs/'.length));
      if (!C.isValidId(id)) {
        sendJson(res, 400, envelopeError(requestId, null, started, new C.BridgeError('invalid_args', 'job id 不合法'), 400).payload, {
          'X-Request-Id': requestId,
        });
        return;
      }
      if (typeof tools.waitForJob !== 'function') {
        sendJson(res, 501, envelopeError(requestId, null, started, new C.BridgeError('not_implemented', '该 daemon 没有 job 存储'), 501).payload, {
          'X-Request-Id': requestId,
        });
        return;
      }
      let job;
      try {
        job = await tools.waitForJob(id, 0);
      } catch {
        job = null;
      }
      if (!job) {
        sendJson(res, 404, envelopeError(requestId, null, started, new C.BridgeError('not_found', `job 不存在：${id}`), 404).payload, {
          'X-Request-Id': requestId,
        });
        return;
      }
      const terminal = job.state === 'done' || job.state === 'failed' || job.state === 'cancelled';
      sendJson(
        res,
        terminal ? 200 : 202,
        terminal
          ? {
              ok: true,
              id: requestId,
              ts: new Date(clock()).toISOString(),
              duration_ms: Math.max(0, clock() - started),
              data: job,
            }
          : {
              ok: true,
              id: requestId,
              ts: new Date(clock()).toISOString(),
              duration_ms: Math.max(0, clock() - started),
              pending: true,
              job_id: id,
              state: job.state,
            },
        { 'X-Request-Id': requestId }
      );
      return;
    }

    if (pathname === '/rotate' || pathname === '/rotate/commit') {
      if (req.method !== 'POST') {
        sendJson(
          res,
          405,
          {
            ok: false,
            id: requestId,
            ts: new Date(clock()).toISOString(),
            duration_ms: Math.max(0, clock() - started),
            error: { code: 'invalid_request', message: '只允许 POST' },
          },
          { Allow: 'POST', 'X-Request-Id': requestId }
        );
        return;
      }
      const authResult = authorizeRoute(req, true);
      if (!authResult.ok) {
        rejectAuth(res, requestId, started, authResult);
        return;
      }
      counters.authorized += 1;
      if (!tokenStore || typeof tokenStore.issuePhone !== 'function') {
        sendJson(res, 503, envelopeError(requestId, null, started, new C.BridgeError('auth_unavailable', 'TokenStore 不可用'), 503).payload, {
          'X-Request-Id': requestId,
        });
        return;
      }
      if (pathname === '/rotate') {
        // Two-phase rotation: the old phone token stays valid until the caller
        // has pushed the new one and calls /v1/rotate/commit.
        const issued = tokenStore.issuePhone();
        sendJson(res, 200, {
          ok: true,
          id: requestId,
          ts: new Date(clock()).toISOString(),
          duration_ms: Math.max(0, clock() - started),
          data: {
            token: issued.token,
            record_id: issued.record.id,
            expires_at: issued.expiresAt,
            note: '先把 token 推送到手机，成功后 POST /v1/rotate/commit {record_id} 使旧 phone token 失效。',
          },
        }, { 'X-Request-Id': requestId });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req, config.bodyLimit);
      } catch (err) {
        const be = C.isBridgeError(err) ? err : new C.BridgeError('invalid_request', '请求体不合法');
        sendJson(res, be.http || 400, envelopeError(requestId, null, started, be, be.http || 400).payload, {
          'X-Request-Id': requestId,
        });
        return;
      }
      try {
        const result = tokenStore.commitPhoneRotation(body && body.record_id);
        sendJson(res, 200, {
          ok: true,
          id: requestId,
          ts: new Date(clock()).toISOString(),
          duration_ms: Math.max(0, clock() - started),
          data: result,
        }, { 'X-Request-Id': requestId });
      } catch (err) {
        const be = C.isBridgeError(err) ? err : new C.BridgeError('internal_error', 'rotation commit 失败');
        sendJson(res, be.http || 500, envelopeError(requestId, null, started, be, be.http || 500).payload, {
          'X-Request-Id': requestId,
        });
      }
      return;
    }

    if (pathname === '/audit/tail') {
      if (req.method !== 'GET') {
        sendJson(
          res,
          405,
          {
            ok: false,
            id: requestId,
            ts: new Date(clock()).toISOString(),
            duration_ms: Math.max(0, clock() - started),
            error: { code: 'invalid_request', message: '只允许 GET' },
          },
          { Allow: 'GET', 'X-Request-Id': requestId }
        );
        return;
      }
      const authResult = authorizeRoute(req, true);
      if (!authResult.ok) {
        rejectAuth(res, requestId, started, authResult);
        return;
      }
      counters.authorized += 1;
      const rawN = new URL(req.url || '/', `http://${DEFAULT_HOST}`).searchParams.get('n');
      const n = Math.min(Math.max(Number(rawN) || 100, 1), 1000);
      let records = [];
      try {
        records = audit.tail(n);
      } catch {
        records = [];
      }
      sendJson(res, 200, {
        ok: true,
        id: requestId,
        ts: new Date(clock()).toISOString(),
        duration_ms: Math.max(0, clock() - started),
        data: { records },
      }, { 'X-Request-Id': requestId });
      return;
    }

    if (pathname === '/call') {
      if (req.method !== 'POST') {
        counters.rejected += 1;
        sendJson(
          res,
          405,
          {
            ok: false,
            id: requestId,
            ts: new Date(clock()).toISOString(),
            duration_ms: Math.max(0, clock() - started),
            error: { code: 'invalid_request', message: '只允许 POST' },
          },
          { Allow: 'POST', 'X-Request-Id': requestId }
        );
        return;
      }
      await handleCall(req, res, { requestId, started });
      return;
    }

    sendJson(
      res,
      404,
      {
        ok: false,
        id: requestId,
        ts: new Date(clock()).toISOString(),
        duration_ms: Math.max(0, clock() - started),
        error: { code: 'not_found', message: `未知路径：${pathname}` },
      },
      { 'X-Request-Id': requestId }
    );
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      counters.errors += 1;
      if (logger && typeof logger.error === 'function') {
        logger.error('unhandled request error', { error: err && err.message, stack: err && err.stack });
      }
      if (!res.headersSent) {
        const started = clock();
        const out = envelopeError(crypto.randomUUID(), null, started, new C.BridgeError('internal_error'), 500);
        sendJson(res, 500, out.payload);
      } else {
        try {
          res.destroy();
        } catch {
          // ignore
        }
      }
    });
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 120000;
  server.maxConnections = C.LIMITS.maxConnections;

  /**
   * @param {{port?: number, host?: string}} [listenOptions]
   * @returns {Promise<{port:number, host:string}>}
   */
  function listen(listenOptions = {}) {
    const port = listenOptions.port === undefined ? config.port : listenOptions.port;
    const host = listenOptions.host || DEFAULT_HOST;
    if (host !== DEFAULT_HOST) {
      return Promise.reject(
        new C.BridgeError('invalid_config', '本服务只允许绑定 127.0.0.1，不能监听其他地址')
      );
    }
    return new Promise((resolve, reject) => {
      function onError(err) {
        server.removeListener('listening', onListening);
        reject(
          new C.BridgeError(
            err && err.code === 'EADDRINUSE' ? 'invalid_config' : 'internal_error',
            `监听 ${host}:${port} 失败：${err.message}`
          )
        );
      }
      function onListening() {
        server.removeListener('error', onError);
        const address = server.address();
        actualPort = address && typeof address === 'object' ? address.port : port;
        resolve({ port: actualPort, host: DEFAULT_HOST });
      }
      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen(port, DEFAULT_HOST);
      } catch (err) {
        server.removeListener('error', onError);
        server.removeListener('listening', onListening);
        reject(new C.BridgeError('internal_error', `监听失败：${err.message}`));
      }
    });
  }

  function close() {
    return new Promise((resolve) => {
      const done = () => {
        const toolClose = tools && typeof tools.close === 'function' ? tools.close() : null;
        Promise.resolve(toolClose).catch(() => {}).then(() => resolve());
      };
      if (!server.listening) {
        done();
        return;
      }
      const force = setTimeout(() => {
        try {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        } catch {
          // ignore
        }
        done();
      }, 2000);
      force.unref();
      server.close(() => {
        clearTimeout(force);
        done();
      });
    });
  }

  return {
    server,
    config,
    auth,
    audit,
    idempotency,
    tools,
    tokenStore,
    listen,
    close,
    get port() {
      return actualPort;
    },
    address() {
      return server.address();
    },
  };
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  LOCAL_PROTOCOL,
  LOCAL_VERSION,
  createRateLimiter,
  resolveConfig,
  createServer,
};
