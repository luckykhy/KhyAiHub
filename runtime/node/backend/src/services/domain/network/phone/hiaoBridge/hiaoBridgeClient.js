'use strict';

/**
 * hiaoBridgeClient.js — thin IO shell for the hiao (phone-dsh) bridge profile.
 *
 * Outbound, like the phone profile: the PC dials the phone through an adb
 * forward, one HTTP request per call (the bridge answers `Connection: close`
 * and has no keep-alive). The two profiles differ in protocol, not direction:
 * hiao adds a governance pipeline (policy → lease → human approval → audit
 * hash chain), which is exactly why a blocked /call must not be reported as a
 * broken device.
 *
 * Every transport is injectable. With `runAdb` and `httpTransport` injected
 * (the test path) this module spawns nothing, opens no socket, and reads no
 * file. The default branches are argv/socket plumbing only — no protocol logic
 * lives outside this file's policy/config siblings.
 *
 * The pairing token is R2-class: it is read from the device at call time, kept
 * in the context object below, and never appears in a result or a log line.
 * Every failure message goes through the facade's redactSecrets before it is
 * returned.
 *
 * Shape note: the exported factory is deliberately thin and every method is a
 * module-level function taking the shared context. A single closure holding
 * all of them took 344 lines and 8 brace levels — past the file ratchet's caps
 * (maxFuncLines 300 / maxNesting 6), which is a real maintainability signal for
 * a file this IO-heavy.
 */

const http = require('node:http');
const { spawn } = require('child_process');

const facade = require('../index');
const {
  resolveHiaoBridgeConfig,
  HIAO_APPROVAL_CEILING_MS,
} = require('./hiaoBridgeConfig');
const { classifyHiaoCall, planHiaoCall, classifyHiaoFailure } = require('./hiaoBridgePolicy');

// Route literals are protocol constants (phone-dsh docs/AMOO-INTEGRATION.md §1),
// not endpoints: host and port come from config.
const HTTP_PATHS = Object.freeze({
  ping: '/ping',
  status: '/status',
  call: '/call',
  approvals: '/approvals',
  approve: '/approve',
  audit: '/audit',
});

// adb 子进程是短 I/O（forward / cat 一个几十字节的令牌文件）。15s 与 phone
// profile 的 PHONE_BRIDGE_ADB_TIMEOUT_MS 同值；本 profile 的 5 个配置键由契约
// 固定，不为此单开 env 键。
const HIAO_ADB_TIMEOUT_MS = 15000;
const MAX_OUTPUT_CHARS = 64 * 1024;

function _truncate(text) {
  const input = String(text ?? '');
  if (input.length <= MAX_OUTPUT_CHARS) {
    return input;
  }
  return `${input.slice(0, MAX_OUTPUT_CHARS)}\n...[adb 输出已截断]`;
}

// ── adb transport ───────────────────────────────────────────────────────────

/** argv-only adb runner. Array args mean no device path reaches the PC shell. */
function createAdbRunner(options = {}) {
  const cfg = {
    adbExecutable: options.adbExecutable || 'adb',
    defaultTimeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : HIAO_ADB_TIMEOUT_MS,
    spawnImpl: options.spawn || spawn,
    signalFactory:
      typeof options.signalFactory === 'function' ? options.signalFactory : (ms) => AbortSignal.timeout(ms),
  };
  return function run(argv, runOptions = {}) {
    const timeoutMs = Number(runOptions.timeoutMs) > 0 ? Number(runOptions.timeoutMs) : cfg.defaultTimeoutMs;
    const args = Array.isArray(argv) ? argv.map((value) => String(value)) : [];
    return new Promise((resolve) => _spawnOnce(cfg, args, timeoutMs, resolve));
  };
}

/**
 * One spawned child, one resolve. Termination rides on AbortSignal (spawn's
 * own signal option) plus one guard timer, so a transport that ignores the
 * signal still cannot outlive the deadline.
 */
function _spawnOnce(cfg, args, timeoutMs, resolve) {
  let child;
  try {
    child = cfg.spawnImpl(cfg.adbExecutable, args, {
      windowsHide: true,
      signal: cfg.signalFactory(timeoutMs),
    });
  } catch (err) {
    resolve({ ok: false, code: -1, stdout: '', stderr: String((err && err.message) || err) });
    return;
  }
  const out = { stdout: '', stderr: '', aborted: false, settled: false };
  const finish = (code) => {
    if (out.settled) {
      return;
    }
    out.settled = true;
    clearTimeout(guard);
    resolve({
      ok: code === 0 && !out.aborted,
      code: out.aborted ? -1 : code,
      stdout: _truncate(out.stdout),
      stderr: _truncate(out.stderr),
      aborted: out.aborted,
    });
  };
  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      out.stdout += String(chunk);
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      out.stderr += String(chunk);
    });
  }
  child.on('error', (err) => {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      out.aborted = true;
    } else {
      out.stderr += `${(err && err.message) || err}\n`;
    }
    finish(-1);
  });
  child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
  const guard = setTimeout(() => {
    out.aborted = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    finish(-1);
  }, timeoutMs + 500);
}

// ── HTTP transport ──────────────────────────────────────────────────────────

/**
 * One-shot HTTP transport. node:http rather than fetch so the request is
 * unambiguously one socket: no keep-alive agent, explicit Content-Length (the
 * bridge reads bodies by content-length), deadline on AbortSignal. On an abort
 * the caller gets `aborted:true`, which is what lets the policy tell "nobody
 * approved" apart from "the link is down".
 */
function createHttpTransport(options = {}) {
  const cfg = {
    requestImpl: options.request || http.request,
    agent: options.agent || new http.Agent({ keepAlive: false, maxSockets: 1 }),
    signalFactory:
      typeof options.signalFactory === 'function' ? options.signalFactory : (ms) => AbortSignal.timeout(ms),
  };
  return {
    request({ method = 'GET', url, headers = {}, body = '', timeoutMs = 45000 }) {
      const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 45000;
      const payload = typeof body === 'string' ? body : JSON.stringify(body || {});
      return new Promise((resolve) => _dispatch(cfg, { method, url, headers, payload, ms }, resolve));
    },
  };
}

function _dispatch(cfg, spec, resolve) {
  let req;
  try {
    req = cfg.requestImpl(
      spec.url,
      {
        method: spec.method,
        agent: cfg.agent,
        headers: {
          ...spec.headers,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(spec.payload, 'utf8'),
          Connection: 'close',
        },
        signal: cfg.signalFactory(spec.ms),
      },
      (res) => _collectHttpResponse(res, resolve)
    );
  } catch (err) {
    resolve({ status: 0, bodyText: '', ok: false, error: String((err && err.message) || err) });
    return;
  }
  req.on('error', (err) => {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    resolve({
      status: 0,
      bodyText: '',
      ok: false,
      aborted,
      error: aborted ? `请求 ${spec.ms}ms 内未收到手机端回应` : String((err && err.message) || err),
    });
  });
  if (spec.payload) {
    req.write(spec.payload);
  }
  req.end();
}

function _collectHttpResponse(res, resolve) {
  let raw = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    raw += String(chunk);
  });
  res.on('end', () => {
    resolve({ status: res.statusCode || 0, bodyText: raw, ok: (res.statusCode || 0) === 200 });
  });
}

// ── client context ──────────────────────────────────────────────────────────

function _createContext(options = {}) {
  const env = options.env || process.env;
  const config = options.config || resolveHiaoBridgeConfig(env, {
    hasExecutable: options.hasExecutable || facade.defaultExecutableProbe,
    detectedSerial: options.detectedSerial,
  });
  return {
    config,
    runAdb: options.runAdb || createAdbRunner({
      adbExecutable: config.adbExecutable,
      spawn: options.spawn,
      signalFactory: options.signalFactory,
    }),
    httpTransport: options.httpTransport || createHttpTransport({ signalFactory: options.signalFactory }),
    now: typeof options.now === 'function' ? options.now : () => Date.now(),
    // The pairing token lives only here. It is never copied into a result.
    token: '',
    tokenCachedAt: null,
    forwardReady: false,
    forwardPort: null,
    baseUrl: config.baseUrl,
    lastHttpOkAt: null,
    lastHttpError: null,
    totalCalls: 0,
  };
}

function _redact(text) {
  return facade.redactSecrets(text);
}

function _resetContext(ctx) {
  ctx.token = '';
  ctx.tokenCachedAt = null;
  ctx.forwardReady = false;
  ctx.forwardPort = null;
  ctx.baseUrl = ctx.config.baseUrl;
  ctx.lastHttpOkAt = null;
  ctx.lastHttpError = null;
  ctx.totalCalls = 0;
}

/**
 * `adb forward tcp:0 tcp:<devicePort>` — tcp:0 lets adb pick a free local port
 * and print it, so a port already taken on the PC is never a failure (same
 * convention as the desktop agentbus transport). The printed port is the only
 * source of the loopback base URL.
 */
async function ensureForward(ctx) {
  if (ctx.forwardReady) {
    return { ok: true, port: ctx.forwardPort, baseUrl: ctx.baseUrl, reused: true };
  }
  const res = await ctx.runAdb(facade.buildForwardArgv(ctx.config, 0, ctx.config.devicePort));
  if (!res.ok) {
    ctx.lastHttpError = 'forward_failed';
    return {
      success: false,
      ...classifyHiaoFailure({
        source: 'adb',
        error: `adb forward 失败：${_redact(res.stderr || res.stdout || '无输出')}`,
      }),
    };
  }
  const printed = String(res.stdout || '').trim();
  const port = Number(printed);
  if (!/^\d{1,5}$/.test(printed) || !Number.isInteger(port) || port < 1 || port > 65535) {
    ctx.lastHttpError = 'forward_port_invalid';
    return {
      success: false,
      ...classifyHiaoFailure({ source: 'adb', error: 'adb 没有返回可用的转发端口' }),
    };
  }
  ctx.forwardReady = true;
  ctx.forwardPort = port;
  ctx.baseUrl = facade.buildLoopbackBaseUrl(port);
  return { ok: true, port, baseUrl: ctx.baseUrl, reused: false };
}

/** The pairing token, read from the device once and cached in memory. */
async function readToken(ctx, force = false) {
  if (!force && ctx.token) {
    return { ok: true, token: ctx.token, cached: true, readAt: ctx.tokenCachedAt };
  }
  const res = await ctx.runAdb(facade.buildStatusReadArgv(ctx.config, ctx.config.tokenRemotePath));
  if (!res.ok) {
    ctx.token = '';
    return {
      ok: false,
      code: 'hiao_not_paired',
      error: `读不到配对令牌（${_redact(res.stderr || res.stdout || '无输出')}）。`
        + `请先在手机 hiao「设置 → 连接 → 配对令牌」完成配对，令牌默认落在 ${ctx.config.tokenRemotePath}。`,
    };
  }
  const token = String(res.stdout || '').trim();
  if (!token) {
    ctx.token = '';
    return {
      ok: false,
      code: 'hiao_not_paired',
      error: `配对令牌文件是空的（${ctx.config.tokenRemotePath}）：请在手机 hiao 设置页点按复制令牌后重试。`,
    };
  }
  ctx.token = token;
  ctx.tokenCachedAt = new Date(ctx.now()).toISOString();
  return { ok: true, token, cached: false, readAt: ctx.tokenCachedAt };
}

function _shape(ctx, res, { allowEmptyBody = false, approvalWait = false } = {}) {
  if (res.aborted === true) {
    // /call is the only endpoint whose deadline means "the phone is waiting
    // for a human"; a GET deadline is a plain short-I/O timeout. Two different
    // causes, two different codes — the GET wording must not claim 600s of
    // approval waiting it never entered.
    ctx.lastHttpError = approvalWait ? 'approval_timeout' : 'http_timeout';
    return {
      success: false,
      // Same choke point as the non-ok branch below: a transport error is
      // caller-visible text, so it goes through redactSecrets even though the
      // default wording is ours today.
      ...classifyHiaoFailure({ aborted: true, approvalWait, error: _redact(res.error) }),
    };
  }
  if (!res.ok) {
    ctx.lastHttpError = res.error || `HTTP ${res.status}`;
    if (res.status === 0) {
      // The forward may still be registered while the phone-side listener is
      // gone; drop it so the next call re-forwards instead of retrying a dead
      // tunnel.
      ctx.forwardReady = false;
    }
    const mapped = classifyHiaoFailure({
      status: res.status,
      bodyText: res.bodyText,
      error: _redact(res.error),
    });
    if (mapped.code === 'unauthorized') {
      // A 401 means the cached pairing token was rotated or revoked. Keeping it
      // would make the "re-pair and retry" advice a lie: every retry would reuse
      // the same dead token until the process restarted. Drop it so the retry
      // re-reads whatever the device holds now.
      ctx.token = '';
      ctx.tokenCachedAt = null;
    }
    return { success: false, channel: 'http', ...mapped };
  }
  ctx.lastHttpOkAt = new Date(ctx.now()).toISOString();
  ctx.lastHttpError = null;
  let parsed = null;
  try {
    parsed = res.bodyText ? JSON.parse(res.bodyText) : null;
  } catch {
    if (!allowEmptyBody) {
      return { success: false, channel: 'http', code: 'device_fault', error: '手机端返回了无法解析的响应体。' };
    }
    parsed = null;
  }
  return { success: true, channel: 'http', status: res.status, body: parsed };
}

async function _send(ctx, { method, path, body, timeoutMs, withAuth = true, approvalWait = false }) {
  const forward = await ensureForward(ctx);
  if (!forward.ok) {
    return forward;
  }
  const headers = {};
  if (withAuth) {
    const tokenRes = await readToken(ctx);
    if (!tokenRes.ok) {
      return { success: false, code: tokenRes.code, error: tokenRes.error };
    }
    headers.Authorization = `Bearer ${tokenRes.token}`;
  }
  const res = await ctx.httpTransport.request({
    method,
    url: `${ctx.baseUrl}${path}`,
    headers,
    body,
    timeoutMs,
  });
  return _shape(ctx, res, { approvalWait });
}

// ── protocol methods (each a thin wrapper over _send) ───────────────────────

async function ping(ctx) {
  const out = await _send(ctx, {
    method: 'GET',
    path: HTTP_PATHS.ping,
    withAuth: false,
    timeoutMs: ctx.config.httpTimeoutMs,
  });
  if (!out.success) {
    return out;
  }
  // /ping is deliberately unauthenticated: it also answers "the bridge is up
  // but we are not paired yet".
  return { ok: true, channel: 'http', version: (out.body && out.body.version) || null, body: out.body };
}

async function status(ctx) {
  const out = await _send(ctx, { method: 'GET', path: HTTP_PATHS.status, timeoutMs: ctx.config.httpTimeoutMs });
  return out.success ? { ok: true, channel: 'http', status: out.body } : out;
}

/**
 * The tool list. hiao reports it inside /status (`tools`); MCP tools/list is a
 * separate POST /mcp surface this profile does not wire. When /status reports
 * a count instead of names, that is what the caller gets — a count dressed up
 * as names would be a lie.
 */
async function tools(ctx) {
  const out = await _send(ctx, { method: 'GET', path: HTTP_PATHS.status, timeoutMs: ctx.config.httpTimeoutMs });
  if (!out.success) {
    return out;
  }
  const raw = out.body && out.body.tools;
  if (Array.isArray(raw)) {
    const names = raw.map((item) => (typeof item === 'string' ? item : item && item.name)).filter(Boolean);
    return { ok: true, channel: 'http', count: names.length, names };
  }
  if (typeof raw === 'number') {
    return {
      ok: true,
      channel: 'http',
      count: raw,
      names: null,
      note: '/status 只报了工具数；工具名清单需 MCP tools/list（POST /mcp），本 profile 未接。',
    };
  }
  return { ok: true, channel: 'http', count: null, names: null, note: '/status 没有返回 tools 字段。' };
}

/**
 * POST /call. A confirm-level tool blocks on the phone until a human approves
 * (upstream socket 600s, timeout = refusal), so this request runs on
 * config.callTimeoutMs, not on the GET timeout: it is a single request's
 * AbortSignal deadline, not a task kill.
 */
async function call(ctx, tool, args = {}, callOptions = {}) {
  const classified = classifyHiaoCall(tool);
  if (!classified.ok) {
    return { success: false, code: classified.code, error: classified.error };
  }
  if (classified.requiresConfirm && callOptions.confirm !== true) {
    const plan = planHiaoCall({ tool: classified.tool, args, baseUrl: ctx.baseUrl });
    return {
      success: false,
      requiresConfirm: true,
      code: plan.code,
      plan: plan.plan,
      message: plan.message,
    };
  }
  ctx.totalCalls += 1;
  const out = await _send(ctx, {
    method: 'POST',
    path: HTTP_PATHS.call,
    body: { tool: classified.tool, args: args && typeof args === 'object' ? args : {} },
    timeoutMs: ctx.config.callTimeoutMs,
    // Only /call can be sitting in the upstream approval queue when our
    // deadline fires; mark it so a GET timeout never claims 600s of waiting.
    approvalWait: true,
  });
  if (!out.success) {
    return out;
  }
  return _shapeCallBody(ctx, out, classified.tool);
}

function _shapeCallBody(ctx, out, toolName) {
  const body = out.body || {};
  if (!(body.ok === false || body.verdict === 'deny')) {
    return { success: true, channel: 'http', tool: toolName, verdict: body.verdict || null, result: body };
  }
  const mapped = classifyHiaoFailure({ status: out.status, bodyText: JSON.stringify(body) });
  if (mapped.code !== 'device_fault') {
    return { success: false, channel: 'http', ...mapped, result: body };
  }
  // 2xx 且手机端明确说 ok:false，但正文里没有 approval/lease/verdict 标记：这是
  // 手机端拒绝了这次调用（参数或策略），不是设备故障。声称故障会让人去找一个
  // 坏掉的手机，而真正要做的是换参数或改策略。
  return {
    success: false,
    channel: 'http',
    code: 'hiao_deny',
    error: `手机端拒绝了这次调用：${_redact(String(body.error || body.reason || '未给原因'))}`,
    result: body,
  };
}

async function approvals(ctx) {
  const out = await _send(ctx, {
    method: 'GET',
    path: HTTP_PATHS.approvals,
    timeoutMs: ctx.config.httpTimeoutMs,
  });
  if (!out.success) {
    return out;
  }
  const list = out.body && Array.isArray(out.body.approvals) ? out.body.approvals : out.body;
  return { ok: true, channel: 'http', approvals: list };
}

/** POST /approve. Approving from the PC is a state change: same confirm gate. */
async function approve(ctx, id, approveVerdict = true, answer = undefined, callOptions = {}) {
  const requestId = String(id || '').trim();
  if (!requestId) {
    return { success: false, code: 'invalid_args', error: '缺少审批 id：先用 action "approvals" 取待批列表。' };
  }
  const classified = classifyHiaoCall('approve');
  if (classified.requiresConfirm && callOptions.confirm !== true) {
    const plan = planHiaoCall({
      tool: 'approve',
      args: { id: requestId, approve: approveVerdict === true },
      baseUrl: ctx.baseUrl,
    });
    return { success: false, requiresConfirm: true, code: plan.code, plan: plan.plan, message: plan.message };
  }
  const payload = { id: requestId, approve: approveVerdict === true };
  if (answer !== undefined) {
    payload.answer = answer;
  }
  const out = await _send(ctx, {
    method: 'POST',
    path: HTTP_PATHS.approve,
    body: payload,
    timeoutMs: ctx.config.httpTimeoutMs,
  });
  return out.success ? { ok: true, channel: 'http', body: out.body } : out;
}

async function audit(ctx, limit = 50) {
  const n = Number.parseInt(String(limit ?? ''), 10);
  const safeN = Number.isFinite(n) && n > 0 ? n : 50;
  const out = await _send(ctx, {
    method: 'GET',
    path: `${HTTP_PATHS.audit}?n=${safeN}`,
    timeoutMs: ctx.config.httpTimeoutMs,
  });
  if (!out.success) {
    return out;
  }
  const chain = out.body && Array.isArray(out.body.audit) ? out.body.audit : out.body;
  return { ok: true, channel: 'http', audit: chain };
}

function getState(ctx) {
  return {
    forwardReady: ctx.forwardReady,
    forwardPort: ctx.forwardPort,
    baseUrl: ctx.baseUrl,
    tokenCachedAt: ctx.tokenCachedAt,
    lastHttpOkAt: ctx.lastHttpOkAt,
    lastHttpError: ctx.lastHttpError,
    totalCalls: ctx.totalCalls,
    devicePort: ctx.config.devicePort,
    tokenReady: Boolean(ctx.token),
    approvalCeilingMs: HIAO_APPROVAL_CEILING_MS,
    callTimeoutMs: ctx.config.callTimeoutMs,
  };
}

function createHiaoBridgeClient(options = {}) {
  const ctx = _createContext(options);
  return {
    config: ctx.config,
    ensureForward: () => ensureForward(ctx),
    readToken: (force = false) => readToken(ctx, force),
    ping: () => ping(ctx),
    status: () => status(ctx),
    tools: () => tools(ctx),
    call: (tool, args, callOptions) => call(ctx, tool, args, callOptions),
    approvals: () => approvals(ctx),
    approve: (id, approveVerdict, answer, callOptions) => approve(ctx, id, approveVerdict, answer, callOptions),
    audit: (limit) => audit(ctx, limit),
    getState: () => getState(ctx),
    resetForTests: () => _resetContext(ctx),
  };
}

module.exports = {
  createHiaoBridgeClient,
  createAdbRunner,
  createHttpTransport,
  HTTP_PATHS,
};
