'use strict';

/**
 * lib/mailbox.js — durable phone file mailbox over ADB.
 *
 * Scope of this implementation track (see the ask):
 *   - Poll <root>/inbox for cmd_<id>.json.
 *   - Read atomically: pull to a local temp file, then parse. Never cat the
 *     remote file directly, so a half-written file is never parsed in place.
 *   - Half-written tolerance: a command file must keep the same size across two
 *     polls (claimStableMs) before it is claimed; a JSON parse failure after the
 *     claim is retried (re-pulled) parseRetries times before the command fails.
 *   - Idempotent: if outbox/res_<id>.json already exists the command is NOT
 *     executed again. The result carries an args_digest: same args are marked
 *     replayed and moved to done/; different args write id_conflict and move
 *     to failed/ after archiving the first result. Duplicate in-flight ids are
 *     skipped. Startup recovery requeues working/ commands (file scope is
 *     idempotent); only a failed requeue becomes `abandoned`.
 *   - Execute through an injected executor or a registry under the file scope.
 *   - Write outbox/res_<id>.json atomically (push to tmp/, then mv -f) and only
 *     then remove the working command.
 *   - Keep the newest N results (resultRetain) and prune older ones.
 *   - Bounded concurrency (default 2 workers).
 *
 * The frozen contract (lib/contracts.js MODULES.C) plans
 * lib/mailbox/{protocol,store,poller}.js. This track delivers one
 * lib/mailbox.js; createMailboxPoller is exported as an alias so the daemon can
 * use the frozen name without a second file. Additive exports only — nothing
 * here renames or replaces a contracts export.
 *
 * Comments are English; every user-facing message is Chinese.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require('./contracts');

// ── File naming / protocol ──────────────────────────────────────────────────

/** cmd_<id>.json — ids are contracts' [A-Za-z0-9_-]{8,64}. */
const COMMAND_FILE_RE = /^cmd_([A-Za-z0-9_-]{8,64})\.json$/;
/** res_<id>.json */
const RESULT_FILE_RE = /^res_([A-Za-z0-9_-]{8,64})\.json$/;
/** ack_<id>.json — amoon acknowledges a msg_<id> file. */
const ACK_FILE_RE = /^ack_([A-Za-z0-9_-]{8,64})\.json$/;
/** reply_<id>.json — amoon replies to a message. */
const REPLY_FILE_RE = /^reply_([A-Za-z0-9_-]{8,64})\.json$/;

/** Defense in depth: the mailbox is the unauthenticated file channel. */
const FILE_SCOPE_TOOLS = new Set(C.TOOL_POLICY.fileScope.tools);

/** The principal every mailbox command is executed under. */
const FILE_PRINCIPAL = Object.freeze({
  kind: C.PRINCIPAL_KINDS.FILE,
  scope: C.SCOPES.FILE,
  source: 'mailbox',
});

const LOCAL_TMP_PREFIX = 'khy-amoon-mailbox-';

// ── Small helpers ───────────────────────────────────────────────────────────

/**
 * POSIX single-quote quoting. Used only for paths this module built from a
 * validated root and a validated leaf name; values containing control bytes are
 * rejected by safeLeaf()/normalizeRoot() before they reach here.
 *
 * Module B owns the frozen shQuote(); we use it when it exists and fall back to
 * this identical implementation while B is still being built.
 *
 * @param {string} value
 * @returns {string}
 */
function fallbackShQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

let shQuoteImpl = fallbackShQuote;
for (const specifier of ['./adb/shellQuote', './adb']) {
  try {
    // Module B's frozen export. The parallel adb track ships lib/adb.js, the
    // design names lib/adb/shellQuote.js; accept either, fall back otherwise.
    const b = require(specifier);
    if (b && typeof b.shQuote === 'function') {
      shQuoteImpl = b.shQuote;
      break;
    }
  } catch {
    // module B not installed yet — try the next path / keep the fallback
  }
}

function q(value) {
  return shQuoteImpl(value);
}

/**
 * Validate a mailbox leaf name (no traversal, no separators, no control bytes).
 * @param {string} name
 * @returns {string}
 */
function safeLeaf(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > 128 ||
    name === '.' ||
    name === '..' ||
    name.includes('..') ||
    /[\/\\\u0000-\u001f]/.test(name)
  ) {
    throw new C.BridgeError('invalid_args', `非法的信箱文件名：${String(name)}`);
  }
  return name;
}

/**
 * Normalize and validate the phone mailbox root.
 * @param {string} root
 * @returns {string} without trailing slash
 */
function normalizeRoot(root) {
  if (typeof root !== 'string' || !root.startsWith('/')) {
    throw new C.BridgeError('invalid_config', `信箱根目录必须是绝对 POSIX 路径：${String(root)}`);
  }
  if (root.includes('..') || /[\u0000-\u001f\\]/.test(root)) {
    throw new C.BridgeError('invalid_config', `信箱根目录含有非法字符：${root}`);
  }
  return root.replace(/\/+$/, '') || '/';
}

function joinRemote(dir, name) {
  return `${dir}/${safeLeaf(name)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function toNonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function iso(clock) {
  return new Date(clock.now()).toISOString();
}

/**
 * Normalize an arbitrary throwable into a plain {code,message,details?} object.
 * @param {unknown} err
 * @returns {{code:string,message:string,details?:object}}
 */
function normalizeError(err) {
  if (C.isBridgeError(err)) return err.toJSON();
  if (err && typeof err === 'object') {
    const code = typeof err.code === 'string' && err.code ? err.code : 'internal_error';
    const message = typeof err.message === 'string' && err.message ? err.message : String(err);
    return { code, message };
  }
  return { code: 'internal_error', message: String(err === undefined ? 'unknown error' : err) };
}

/**
 * Convert a numeric/ISO expiry into epoch ms, or null when absent.
 * Numbers below 1e12 are treated as epoch seconds (shell `date +%s`).
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function parseExpiry(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.trunc(value) : Math.trunc(value * 1000);
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

// ── Envelope helpers (also used by tests and, later, by the phone docs) ─────

/**
 * @param {{id:string,tool:string,args?:object,ts?:string|number,expiresAt?:string|number,
 *          replyTo?:string|null,nonce?:string|null,timeoutMs?:number}} input
 * @returns {object} cmd_<id>.json body
 */
function buildCommand(input = {}) {
  const id = input.id;
  if (!C.isValidId(id)) throw new C.BridgeError('invalid_args', `非法命令 id：${String(id)}`);
  const tool = input.tool;
  if (typeof tool !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(tool)) {
    throw new C.BridgeError('invalid_args', `非法工具名：${String(tool)}`);
  }
  const args = input.args === undefined ? {} : input.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new C.BridgeError('invalid_args', '命令 args 必须是 JSON 对象');
  }
  const out = { v: 1, id, tool, args };
  if (input.ts !== undefined) out.ts = input.ts;
  const expiry = parseExpiry(input.expiresAt);
  if (expiry !== null) out.expires_at = new Date(expiry).toISOString();
  if (input.replyTo !== undefined && input.replyTo !== null) out.reply_to = String(input.replyTo);
  if (input.nonce !== undefined && input.nonce !== null) out.nonce = String(input.nonce);
  if (input.timeoutMs !== undefined) out.timeout_ms = toPositiveInt(input.timeoutMs, 20000);
  return out;
}

/**
 * Parse and validate a cmd_<id>.json body.
 *
 * @param {string} text
 * @returns {{ok:true,value:object}|{ok:false,error:{code:string,message:string}}}
 */
function parseCommand(text) {
  if (typeof text !== 'string') {
    return { ok: false, error: { code: 'invalid_request', message: '命令内容不是文本' } };
  }
  if (Buffer.byteLength(text, 'utf8') > C.LIMITS.commandBytes) {
    return {
      ok: false,
      error: {
        code: 'payload_too_large',
        message: `命令超过 ${C.LIMITS.commandBytes} 字节上限`,
      },
    };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      error: { code: 'invalid_request', message: `命令 JSON 解析失败：${err.message}` },
    };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: { code: 'invalid_request', message: '命令必须是 JSON 对象' } };
  }
  if (raw.v !== 1) {
    return { ok: false, error: { code: 'invalid_request', message: `不支持的命令版本 v=${String(raw.v)}` } };
  }
  if (!C.isValidId(raw.id)) {
    return { ok: false, error: { code: 'invalid_request', message: `命令 id 不合法：${String(raw.id)}` } };
  }
  if (typeof raw.tool !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(raw.tool)) {
    return { ok: false, error: { code: 'invalid_request', message: `命令 tool 不合法：${String(raw.tool)}` } };
  }
  const args = raw.args === undefined ? {} : raw.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: { code: 'invalid_request', message: '命令 args 必须是 JSON 对象' } };
  }
  let expiresAt = null;
  if (raw.expires_at !== undefined && raw.expires_at !== null && raw.expires_at !== '') {
    expiresAt = parseExpiry(raw.expires_at);
    if (expiresAt === null) {
      return { ok: false, error: { code: 'invalid_request', message: 'expires_at 不是合法时间' } };
    }
  }
  let timeoutMs = null;
  if (raw.timeout_ms !== undefined) {
    timeoutMs = toPositiveInt(raw.timeout_ms, 0) || null;
  }
  return {
    ok: true,
    value: {
      v: 1,
      id: raw.id,
      tool: raw.tool,
      args,
      ts: raw.ts === undefined ? null : raw.ts,
      expiresAt,
      replyTo: raw.reply_to === undefined ? null : raw.reply_to,
      nonce: raw.nonce === undefined ? null : raw.nonce,
      timeoutMs,
    },
  };
}

/**
 * Deterministic JSON for an argument digest: key order must not change the
 * idempotency identity of the same command.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Idempotency identity of a mailbox command: tool + args, independent of key
 * order. Results carry this digest so a duplicate id with different args can
 * be rejected instead of silently returning the first command's result.
 *
 * @param {{tool:string,args:object}} command
 * @returns {string} hex sha256
 */
function commandDigest(command) {
  return crypto
    .createHash('sha256')
    .update(stableJson({ tool: command.tool, args: command.args || {} }), 'utf8')
    .digest('hex');
}

/**
 * @param {{id:string,tool:string,ok:boolean,data?:unknown,error?:object|null,
 *          durationMs?:number,ts?:number,replayed?:boolean}} input
 * @returns {object} res_<id>.json body
 */
function buildResult(input = {}) {
  const result = {
    v: 1,
    id: input.id,
    tool: input.tool,
    ok: input.ok === true,
    ts: new Date(Number.isFinite(input.ts) ? input.ts : Date.now()).toISOString(),
    duration_ms: Number.isFinite(input.durationMs) ? Math.max(0, Math.trunc(input.durationMs)) : 0,
  };
  if (input.ok === true && input.data !== undefined) result.data = input.data;
  if (input.ok !== true) {
    const error = input.error && typeof input.error === 'object' ? input.error : {};
    result.error = {
      code: typeof error.code === 'string' && error.code ? error.code : 'internal_error',
      message:
        typeof error.message === 'string' && error.message ? error.message : '命令执行失败（未提供错误信息）',
    };
    if (error.details && typeof error.details === 'object') result.error.details = error.details;
  }
  if (input.replayed === true) result.replayed = true;
  return result;
}

/**
 * Run a promise with a hard timeout and an AbortSignal.
 * @param {(signal:AbortSignal)=>Promise<any>} fn
 * @param {number} timeoutMs
 * @param {string} what
 * @returns {Promise<any>}
 */
function runWithTimeout(fn, timeoutMs, what) {
  const controller = new AbortController();
  let timer = null;
  const work = Promise.resolve().then(() => fn(controller.signal));
  work.catch(() => {
    // The loser of Promise.race() must not surface as an unhandled rejection.
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new C.BridgeError('timeout', `${what} 超过 ${timeoutMs}ms`);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Execute a fixed-size worker pool over items, preserving order.
 * @template T,U
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T,index:number)=>Promise<U>} fn
 * @returns {Promise<U[]>}
 */
async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

// ── createMailbox ───────────────────────────────────────────────────────────

/**
 * Create the mailbox poller.
 *
 * @param {{
 *   config?: object,
 *   adb: {shell:Function,push:Function,pull:Function},
 *   executor?: (command:object, ctx:{signal:AbortSignal,principal:object,requestId:string}) => Promise<any>,
 *   registry?: {call:Function},
 *   logger?: object,
 *   audit?: object,
 *   root?: string,
 *   localTempDir?: string,
 *   maxConcurrency?: number,
 *   resultRetain?: number,
 *   pollIntervalMs?: number,
 *   commandTimeoutMs?: number,
 *   maxCommandTimeoutMs?: number,
 *   claimStableMs?: number,
 *   parseRetries?: number,
 *   retryDelayMs?: number,
 *   clock?: {now:()=>number},
 * }} options
 * @returns {object} poller
 */
function createMailbox(options = {}) {
  if (!options || typeof options !== 'object') {
    throw new C.BridgeError('invalid_config', 'createMailbox 需要 options 对象');
  }
  const config = options.config || {};
  const logger = options.logger || silentLogger();
  const clock = options.clock && typeof options.clock.now === 'function' ? options.clock : { now: Date.now };
  const adb = options.adb;
  if (!adb || typeof adb.shell !== 'function' || typeof adb.push !== 'function' || typeof adb.pull !== 'function') {
    throw new C.BridgeError('invalid_config', 'mailbox 需要 AdbTransport（shell/push/pull）');
  }

  const root = normalizeRoot(options.root || (config.remote && config.remote.root) || C.REMOTE_ROOT);
  const repliesDir =
    options.repliesDir ||
    (config.paths && config.paths.dirs && config.paths.dirs.replies) ||
    null;
  const dirs = {
    root,
    inbox: `${root}/inbox`,
    outbox: `${root}/outbox`,
    working: `${root}/working`,
    done: `${root}/done`,
    failed: `${root}/failed`,
    tmp: `${root}/tmp`,
  };

  const limits = (config && config.limits) || C.LIMITS;
  const maxConcurrency = toPositiveInt(options.maxConcurrency, limits.pollWorkers || 2);
  const resultRetain = toNonNegativeInt(options.resultRetain, 200);
  const pollIntervalMs = toPositiveInt(options.pollIntervalMs, limits.pollIntervalMs || 800);
  const commandTimeoutMs = toPositiveInt(options.commandTimeoutMs, 20000);
  const maxCommandTimeoutMs = toPositiveInt(options.maxCommandTimeoutMs, 120000);
  const claimStableMs = toNonNegativeInt(options.claimStableMs, limits.claimStableMs || 0);
  const parseRetries = toNonNegativeInt(options.parseRetries, 3);
  const retryDelayMs = toNonNegativeInt(options.retryDelayMs, 250);
  const shellTimeoutMs = toPositiveInt(options.shellTimeoutMs, 15000);

  const executor = resolveExecutor();
  const principal = FILE_PRINCIPAL;

  // Mutable state.
  const knownSizes = new Map(); // file name -> {size, at}
  const inflight = new Set(); // ids currently being processed by this process
  const counters = {
    ticks: 0,
    scanned: 0,
    executed: 0,
    replies: 0,
    skippedExistingResult: 0,
    replayed: 0,
    idConflict: 0,
    rejected: 0,
    failed: 0,
    resultsPruned: 0,
  };
  // Last observed inbox depth; other directories are not counted every tick
  // (that would add 4 adb calls per poll), so they stay null until measured.
  const lastCounts = { inbox: null, working: 0, outbox: null, done: null, failed: null, ack: null };
  let dirsReady = false;
  let ticking = false;
  let timer = null;
  let running = false;
  let lastPollAt = null;
  let lastError = null;
  let lastErrorAt = null;
  let recovered = false;
  let recoverPromise = null;
  let localDirPath = null;

  function resolveExecutor() {
    if (typeof options.executor === 'function') {
      return (command, ctx) => options.executor(command, ctx);
    }
    if (options.registry && typeof options.registry.call === 'function') {
      return (command, ctx) =>
        options.registry.call(command.tool, command.args, {
          principal,
          requestId: command.id,
          id: command.id,
          source: 'mailbox',
          signal: ctx.signal,
        });
    }
    return async () => {
      throw new C.BridgeError(
        'not_implemented',
        '信箱执行器未接线：daemon 需注入 registry 或 executor（模块 A / daemon.js）'
      );
    };
  }

  function getLocalDir() {
    if (!localDirPath) {
      const base = options.localTempDir || fs.mkdtempSync(path.join(os.tmpdir(), LOCAL_TMP_PREFIX));
      fs.mkdirSync(base, { recursive: true });
      localDirPath = base;
    }
    return localDirPath;
  }

  function noteError(err, where) {
    lastError = normalizeError(err);
    lastErrorAt = iso(clock);
    try {
      logger.warn('mailbox error', { where, code: lastError.code, error: lastError.message });
    } catch {
      // logging must never break the poller
    }
  }

  async function shell(cmd, timeoutMs = shellTimeoutMs) {
    return adb.shell(cmd, { timeoutMs, maxBytes: C.LIMITS.commandBytes });
  }

  async function ensureRemoteDirs() {
    if (dirsReady) return;
    for (const dir of [root, dirs.inbox, dirs.outbox, dirs.working, dirs.done, dirs.failed, dirs.tmp]) {
      const res = await shell(`mkdir -p ${q(dir)}`);
      if (!res || res.exit !== 0) {
        throw new C.BridgeError('adb_unavailable', `无法创建手机信箱目录：${dir}`);
      }
    }
    dirsReady = true;
  }

  async function listNames(dir) {
    const res = await shell(`ls -1 ${q(dir)} 2>/dev/null`);
    if (!res || res.exit !== 0) return [];
    return String(res.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => name && !name.includes('/') && name !== '.' && name !== '..');
  }

  async function remoteSize(file) {
    const res = await shell(`wc -c < ${q(file)} 2>/dev/null`);
    if (!res || res.exit !== 0) return null;
    const text = String(res.stdout || '').trim();
    if (!/^\d+$/.test(text)) return null;
    return Number(text);
  }

  async function remoteExists(file) {
    const res = await shell(`test -f ${q(file)} && echo 1 || echo 0`);
    return Boolean(res && res.exit === 0 && String(res.stdout || '').trim() === '1');
  }

  async function moveRemote(src, dst) {
    const res = await shell(`mv -f ${q(src)} ${q(dst)}`);
    return Boolean(res && res.exit === 0);
  }

  async function removeRemote(file) {
    const res = await shell(`rm -f ${q(file)}`);
    return Boolean(res && res.exit === 0);
  }

  async function resultExists(id) {
    return remoteExists(`${dirs.outbox}/res_${id}.json`);
  }

  /**
   * Push a local file to a remote path atomically: push to tmp/, then mv.
   * Retries once on a failed push (ADB hiccup).
   *
   * @param {string} local
   * @param {string} remoteFinal
   * @returns {Promise<{bytes:number,remote:string}>}
   */
  async function pushAtomic(local, remoteFinal) {
    const name = safeLeaf(path.posix.basename(remoteFinal));
    const remoteTmp = `${dirs.tmp}/${name}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    let lastPushError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const pushed = await adb.push(local, remoteTmp, { timeoutMs: 30000 });
        if (!pushed || (typeof pushed.bytes === 'number' && pushed.bytes === 0)) {
          const stat = fs.statSync(local);
          if (stat.size > 0) throw new Error('push returned 0 bytes');
        }
        lastPushError = null;
        break;
      } catch (err) {
        lastPushError = err;
        await sleep(retryDelayMs);
      }
    }
    if (lastPushError) {
      throw new C.BridgeError('adb_unavailable', `写入手机信箱失败：${normalizeError(lastPushError).message}`);
    }
    if (!(await moveRemote(remoteTmp, remoteFinal))) {
      await removeRemote(remoteTmp);
      throw new C.BridgeError('adb_unavailable', `无法将临时文件移动到 ${remoteFinal}`);
    }
    const stat = fs.statSync(local);
    return { bytes: stat.size, remote: remoteFinal };
  }

  /**
   * Pull a remote file into a local temp path.
   * @param {string} remote
   * @param {string} local
   * @returns {Promise<boolean>}
   */
  async function pullTo(remote, local) {
    fs.rmSync(local, { force: true });
    try {
      await adb.pull(remote, local, { timeoutMs: shellTimeoutMs, maxBytes: C.LIMITS.commandBytes });
    } catch (err) {
      noteError(err, 'pull');
      return false;
    }
    try {
      return fs.statSync(local).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Ingest an ack_/reply_ file written by amoon: pull it, validate JSON, store
   * a local copy under replies/ (for amoon_inbox), then move it to done/.
   * Such files are untrusted; `unverified:true` is stamped locally.
   */
  async function ingestReply(name, kind, id) {
    const remote = `${dirs.inbox}/${name}`;
    const local = path.join(getLocalDir(), `${kind}_${id}_${process.pid}.json`);
    try {
      if (!(await pullTo(remote, local))) return { ok: false, transient: true };
      let stat;
      try {
        stat = fs.statSync(local);
      } catch {
        return { ok: false, transient: true };
      }
      if (stat.size > C.LIMITS.resultBytes) {
        await moveRemote(remote, `${dirs.failed}/${name}`);
        return { ok: false, reason: 'too_large' };
      }
      let body;
      try {
        body = JSON.parse(fs.readFileSync(local, 'utf8'));
      } catch {
        await moveRemote(remote, `${dirs.failed}/${name}`);
        return { ok: false, reason: 'bad_json' };
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        await moveRemote(remote, `${dirs.failed}/${name}`);
        return { ok: false, reason: 'bad_envelope' };
      }
      if (repliesDir) {
        fs.mkdirSync(repliesDir, { recursive: true });
        const record = {
          ...body,
          id: typeof body.id === 'string' && C.isValidId(body.id) ? body.id : id,
          kind: typeof body.kind === 'string' && body.kind ? body.kind : kind,
          unverified: true,
          received_at: iso(clock),
        };
        const dest = path.join(repliesDir, `${kind}_${id}.json`);
        const tmp = `${dest}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, dest);
      }
      if (!(await moveRemote(remote, `${dirs.done}/${name}`))) return { ok: false, transient: true };
      return { ok: true };
    } finally {
      fs.rmSync(local, { force: true });
    }
  }

  function buildErrorResult(id, tool, code, message, startedAt) {    return buildResult({
      id,
      tool: typeof tool === 'string' && tool ? tool : 'unknown',
      ok: false,
      error: { code, message },
      durationMs: clock.now() - startedAt,
      ts: clock.now(),
    });
  }

  /**
   * Pull a JSON object from the phone. Returns null for missing or malformed
   * files so the caller can keep the command queued.
   */
  async function readRemoteJson(remotePath, localName) {
    const local = path.join(getLocalDir(), localName);
    try {
      const pulled = await pullTo(remotePath, local);
      if (!pulled) return null;
      const parsed = JSON.parse(fs.readFileSync(local, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    } finally {
      fs.rmSync(local, { force: true });
    }
  }

  /** Pull + parse a duplicate inbox command; null means half-written/invalid. */
  async function readInboxCommand(id, name) {
    const raw = await readRemoteJson(`${dirs.inbox}/${name}`, `dup_cmd_${id}.json`);
    if (!raw) return null;
    const check = parseCommand(JSON.stringify(raw));
    if (!check.ok || check.value.id !== id) return null;
    return check.value;
  }

  /** Preserve the first command's result when a conflicting duplicate arrives. */
  async function archiveResult(id, payload) {
    const name = `res_${id}.conflict_${clock.now()}.json`;
    const local = path.join(getLocalDir(), name);
    fs.writeFileSync(local, `${JSON.stringify(payload)}\n`, 'utf8');
    try {
      await pushAtomic(local, `${dirs.outbox}/${name}`);
    } finally {
      fs.rmSync(local, { force: true });
    }
  }

  /**
   * A durable res_<id>.json means this id already ran. Compare the command's
   * args digest with the stored one:
   *   - same/legacy -> mark the stored result replayed and move to done/
   *   - different   -> archive the old result, write id_conflict, move to failed/
   */
  async function handleExistingResult(id, name) {
    const existing = await readRemoteJson(
      `${dirs.outbox}/res_${id}.json`,
      `existing_res_${id}.json`
    );
    const command = await readInboxCommand(id, name);

    if (existing && command) {
      const digest = commandDigest(command);
      if (typeof existing.args_digest === 'string' && existing.args_digest !== digest) {
        await archiveResult(id, existing);
        const conflict = buildErrorResult(
          id,
          command.tool,
          'id_conflict',
          '同一 id 已被另一条参数不同的命令使用；原结果已归档到 res_<id>.conflict_*.json',
          clock.now()
        );
        await writeResult(id, conflict);
        const moved = await moveRemote(`${dirs.inbox}/${name}`, `${dirs.failed}/${name}`);
        if (!moved) await removeRemote(`${dirs.inbox}/${name}`);
        counters.idConflict += 1;
        return { status: 'conflict' };
      }
      if (existing.replayed !== true) {
        existing.replayed = true;
        await writeResult(id, existing);
        counters.replayed += 1;
      }
    }

    if (await moveRemote(`${dirs.inbox}/${name}`, `${dirs.done}/${name}`)) {
      counters.skippedExistingResult += 1;
      return { status: 'done' };
    }
    return { status: 'deferred' };
  }

  /**
   * Persist a result to outbox/res_<id>.json atomically.
   * @param {string} id
   * @param {object} result
   */
  async function writeResult(id, result) {
    let payload = result;
    let text = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(text, 'utf8') > C.LIMITS.resultBytes) {
      payload = buildErrorResult(
        id,
        result.tool,
        'payload_too_large',
        `结果超过 ${C.LIMITS.resultBytes} 字节上限，未写入`,
        clock.now()
      );
      text = `${JSON.stringify(payload)}\n`;
    }
    const local = path.join(getLocalDir(), `res_${id}.json`);
    fs.writeFileSync(local, text, 'utf8');
    try {
      await pushAtomic(local, `${dirs.outbox}/res_${id}.json`);
    } finally {
      fs.rmSync(local, { force: true });
    }
    return payload;
  }

  /**
   * Normalize a registry Envelope or a bare {ok,data,error} into a result body.
   */
  function normalizeEnvelope(value, command, startedAt) {
    if (!value || typeof value !== 'object') {
      return buildErrorResult(command.id, command.tool, 'internal_error', '执行器没有返回结果', startedAt);
    }
    if (value.ok === true) {
      return buildResult({
        id: command.id,
        tool: command.tool,
        ok: true,
        data: value.data,
        durationMs: clock.now() - startedAt,
        ts: clock.now(),
        replayed: value.replayed === true,
      });
    }
    const error =
      value.error && typeof value.error === 'object'
        ? {
            code: typeof value.error.code === 'string' && value.error.code ? value.error.code : 'internal_error',
            message:
              typeof value.error.message === 'string' && value.error.message
                ? value.error.message
                : '工具返回失败（未提供错误信息）',
          }
        : { code: 'internal_error', message: '工具返回失败（未提供错误信息）' };
    return buildResult({
      id: command.id,
      tool: command.tool,
      ok: false,
      error,
      durationMs: clock.now() - startedAt,
      ts: clock.now(),
      replayed: value.replayed === true,
    });
  }

  /**
   * Validate a parsed command against phase/scope/expiry and run it.
   * @param {object} command parseCommand().value
   * @returns {Promise<object>} result body
   */
  async function executeCommand(command) {
    const startedAt = clock.now();

    // Defense in depth: the registry enforces scopes too, but the mailbox must
    // never hand a model/phone-control tool to the unauthenticated file channel.
    const descriptor = C.getTool(command.tool);
    if (!descriptor) {
      return buildErrorResult(
        command.id,
        command.tool,
        'not_found',
        `未知工具：${command.tool}`,
        startedAt
      );
    }
    if (descriptor.phase !== C.PHASES.ONE) {
      return buildErrorResult(
        command.id,
        command.tool,
        'not_found',
        `工具 ${command.tool} 不在 Phase 1`,
        startedAt
      );
    }
    if (!FILE_SCOPE_TOOLS.has(command.tool)) {
      return buildErrorResult(
        command.id,
        command.tool,
        'forbidden_scope',
        `file scope 不允许调用 ${command.tool}；允许：${Array.from(FILE_SCOPE_TOOLS).join(', ')}`,
        startedAt
      );
    }
    if (command.expiresAt !== null && clock.now() > command.expiresAt) {
      return buildErrorResult(
        command.id,
        command.tool,
        'invalid_request',
        `命令已过期（expires_at=${new Date(command.expiresAt).toISOString()}）`,
        startedAt
      );
    }

    const timeoutMs = Math.min(
      toPositiveInt(command.timeoutMs, commandTimeoutMs),
      maxCommandTimeoutMs,
      120000
    );

    try {
      const out = await runWithTimeout(
        (signal) => executor(command, { signal, principal, requestId: command.id }),
        timeoutMs,
        `工具 ${command.tool}`
      );
      return normalizeEnvelope(out, command, startedAt);
    } catch (err) {
      const normalized = normalizeError(err);
      return buildErrorResult(command.id, command.tool, normalized.code, normalized.message, startedAt);
    }
  }

  /**
   * Process one claimed command (already moved to working/).
   * @param {{name:string,id:string}} item
   */
  async function processOne(item) {
    const { name, id } = item;
    const workingPath = `${dirs.working}/${name}`;
    const local = path.join(getLocalDir(), `cmd_${id}.json`);
    let result = null;
    let toolName = 'unknown';

    try {
      // Pull + parse with retries for half-written JSON.
      let parsed = null;
      for (let attempt = 0; attempt <= parseRetries; attempt += 1) {
        if (attempt > 0) await sleep(retryDelayMs);
        const pulled = await pullTo(workingPath, local);
        if (!pulled) {
          // The file vanished from working/ (external cleanup): nothing to do.
          return { id, status: 'vanished' };
        }
        let text;
        try {
          text = fs.readFileSync(local, 'utf8');
        } catch (err) {
          noteError(err, 'read-pulled-command');
          continue;
        }
        const check = parseCommand(text);
        if (check.ok) {
          parsed = check.value;
          break;
        }
        // Keep the last parse error for the final result.
        result = buildErrorResult(
          id,
          toolName,
          check.error.code,
          check.error.message,
          clock.now()
        );
        // A size change means the writer is still writing: retry.
        const size = await remoteSize(workingPath);
        if (size !== null && item.size !== undefined && size !== item.size) {
          item.size = size;
          continue;
        }
      }

      if (!parsed) {
        // Persist the parse failure, then move to failed/.
        if (parsed === null && result === null) {
          result = buildErrorResult(id, toolName, 'invalid_request', '无法读取命令文件', clock.now());
        }
        await writeResult(id, result);
        await moveRemote(workingPath, `${dirs.failed}/${name}`);
        counters.failed += 1;
        return { id, status: 'failed' };
      }

      if (parsed.id !== id) {
        result = buildErrorResult(
          id,
          parsed.tool,
          'invalid_args',
          `命令 id 与文件名不一致（文件名 ${id}，内容 ${parsed.id}）`,
          clock.now()
        );
        await writeResult(id, result);
        await moveRemote(workingPath, `${dirs.failed}/${name}`);
        counters.failed += 1;
        return { id, status: 'failed' };
      }

      result = await executeCommand(parsed);
      result.args_digest = commandDigest(parsed);
      toolName = parsed.tool;

      await writeResult(id, result);
      // Result is durable before the command leaves working/ (BridgeService
      // order). Success removes the command; a tool-level failure keeps an
      // audit trail in failed/.
      if (result.ok === true) {
        await removeRemote(workingPath);
      } else {
        await moveRemote(workingPath, `${dirs.failed}/${name}`);
        counters.failed += 1;
      }
      counters.executed += 1;
      try {
        if (options.audit && typeof options.audit.write === 'function') {
          options.audit.write({
            ts: iso(clock),
            kind: 'mailbox',
            id,
            tool: parsed.tool,
            ok: result.ok === true,
            error_code: result.ok === true ? null : result.error && result.error.code,
            duration_ms: result.duration_ms,
            source: 'mailbox',
          });
        }
      } catch {
        // auditing must never break execution
      }
      return { id, status: result.ok ? 'done' : 'error', tool: parsed.tool };
    } catch (err) {
      noteError(err, 'process-one');
      counters.failed += 1;
      // Leave the command in working/: recovery on the next start decides
      // between abandoned/cleanup. Never delete it without a durable result.
      return { id, status: 'deferred', error: normalizeError(err) };
    } finally {
      fs.rmSync(local, { force: true });
    }
  }

  /**
   * Claim an inbox file and run it. Claim = rename inbox -> working (atomic on
   * the same FUSE volume), so two pollers cannot process the same command.
   * @param {{name:string,id:string,size:number}} item
   */
  async function claimAndProcess(item) {
    if (inflight.has(item.id)) return { id: item.id, status: 'inflight' };
    inflight.add(item.id);
    try {
      const from = `${dirs.inbox}/${item.name}`;
      const to = `${dirs.working}/${item.name}`;
      if (!(await moveRemote(from, to))) {
        return { id: item.id, status: 'gone' };
      }
      return await processOne(item);
    } finally {
      inflight.delete(item.id);
    }
  }

  /**
   * Keep the newest `resultRetain` result files; delete the rest.
   */
  async function gcResults() {
    if (resultRetain <= 0) return 0;
    const res = await shell(`ls -1t ${q(dirs.outbox)} 2>/dev/null`);
    if (!res || res.exit !== 0) return 0;
    const names = String(res.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => RESULT_FILE_RE.test(name));
    const excess = names.slice(resultRetain).filter((name) => {
      const m = RESULT_FILE_RE.exec(name);
      return !m || !inflight.has(m[1]);
    });
    for (const name of excess) {
      await removeRemote(joinRemote(dirs.outbox, name));
    }
    counters.resultsPruned += excess.length;
    return excess.length;
  }

  /**
   * Move a non-command / invalid command file out of the inbox so it cannot
   * wedge the poller, and leave a result when an id can be recovered.
   */
  async function rejectFile(name, id, code, message) {
    const source = `${dirs.inbox}/${name}`;
    if (id && C.isValidId(id)) {
      await writeResult(id, buildErrorResult(id, 'unknown', code, message, clock.now()));
    }
    await moveRemote(source, `${dirs.failed}/${name}`);
    counters.rejected += 1;
  }

  /**
   * One full poll cycle. Never throws: failures are recorded in status().
   *
   * @returns {Promise<{ok:boolean,scanned:number,executed:number,skipped:number,failed:number,
   *                    durationMs:number,error?:object}>}
   */
  async function tick() {
    const startedAt = clock.now();
    if (ticking) {
      return { ok: true, skippedTick: true, scanned: 0, executed: 0, skipped: 0, failed: 0, durationMs: 0 };
    }
    ticking = true;
    const stats = { ok: true, scanned: 0, executed: 0, replies: 0, skipped: 0, failed: 0, durationMs: 0 };
    try {
      await ensureRemoteDirs();
      await ensureRecovered();

      const names = await listNames(dirs.inbox);
      stats.scanned = names.length;
      lastCounts.inbox = names.length;

      // ack_<id>.json / reply_<id>.json come from amoon. They are not
      // commands: copy them into the local replies index for amoon_inbox,
      // mark them unverified, then move them to done/.
      const replyFiles = [];
      for (const name of names) {
        const ack = ACK_FILE_RE.exec(name);
        const rep = REPLY_FILE_RE.exec(name);
        if (ack) replyFiles.push({ name, kind: 'ack', id: ack[1] });
        else if (rep) replyFiles.push({ name, kind: 'reply', id: rep[1] });
      }
      for (const item of replyFiles) {
        const ingested = await ingestReply(item.name, item.kind, item.id);
        if (ingested.ok) {
          counters.replies += 1;
          stats.replies += 1;
        } else if (!ingested.transient) {
          counters.failed += 1;
          stats.failed += 1;
        }
      }
      const now = clock.now();
      const ready = [];

      for (const name of names) {
        const match = COMMAND_FILE_RE.exec(name);
        if (!match) {
          if (name.startsWith('cmd_')) {
            await rejectFile(name, null, 'invalid_args', `命令文件名不合法：${name}`);
            stats.failed += 1;
          }
          continue;
        }
        const id = match[1];
        if (inflight.has(id)) {
          stats.skipped += 1;
          continue;
        }

        // Idempotency: a durable result means this id already ran. Same args
        // are replayed; a different args digest is an id_conflict.
        if (await resultExists(id)) {
          const dup = await handleExistingResult(id, name);
          if (dup.status === 'conflict') {
            stats.failed += 1;
          } else if (dup.status === 'done') {
            stats.skipped += 1;
          }
          knownSizes.delete(name);
          continue;
        }

        const size = await remoteSize(`${dirs.inbox}/${name}`);
        if (size === null) {
          // Missing or unreadable between list and stat: retry next tick.
          stats.skipped += 1;
          continue;
        }
        const previous = knownSizes.get(name);
        if (!previous || previous.size !== size) {
          knownSizes.set(name, { size, at: now });
          stats.skipped += 1;
          continue;
        }
        if (claimStableMs > 0 && now - previous.at < claimStableMs) {
          stats.skipped += 1;
          continue;
        }
        knownSizes.delete(name);
        ready.push({ name, id, size });
      }

      if (ready.length > 0) {
        const results = await runPool(ready, maxConcurrency, claimAndProcess);
        for (const item of results) {
          if (!item) continue;
          if (item.status === 'done' || item.status === 'error') stats.executed += 1;
          else if (item.status === 'failed') stats.failed += 1;
          else stats.skipped += 1;
        }
      }

      await gcResults();
      // Re-measure the inbox only when the tick actually saw files: the
      // status must report the post-tick depth, not the pre-claim depth.
      if (stats.scanned > 0) {
        try {
          lastCounts.inbox = (await listNames(dirs.inbox)).length;
        } catch {
          lastCounts.inbox = null;
        }
      }
      counters.ticks += 1;
      counters.scanned += stats.scanned;
      lastPollAt = iso(clock);
      if (stats.failed === 0) {
        lastError = null;
        lastErrorAt = null;
      }
    } catch (err) {
      stats.ok = false;
      stats.error = normalizeError(err);
      noteError(err, 'tick');
    } finally {
      ticking = false;
      lastCounts.working = inflight.size;
      stats.durationMs = clock.now() - startedAt;
    }
    return stats;
  }

  /**
   * Startup recovery for working/:
   *   - result already exists -> the previous run finished; just clean up.
   *   - no result             -> move the command back to inbox so the next
   *     tick retries it. The file-scope surface is idempotent by contract, and
   *     executeCommand re-checks the scope before any side effect. Only if the
   *     move back fails do we fall back to an `abandoned` result.
   *
   * @param {{silent?:boolean}} [opts]
   */
  async function recoverInternal(opts = {}) {
    await ensureRemoteDirs();
    const names = await listNames(dirs.working);
    const report = { scanned: names.length, cleaned: 0, abandoned: 0, retried: 0 };
    for (const name of names) {
      const match = COMMAND_FILE_RE.exec(name);
      if (!match) continue;
      const id = match[1];
      const workingPath = `${dirs.working}/${name}`;
      if (await resultExists(id)) {
        await removeRemote(workingPath);
        report.cleaned += 1;
        continue;
      }
      try {
        if (await moveRemote(workingPath, `${dirs.inbox}/${name}`)) {
          report.retried += 1;
          continue;
        }
        // Move failed: keep the conservative unknown-outcome result.
        const result = buildErrorResult(
          id,
          'unknown',
          'abandoned',
          'daemon 重启时命令仍停留在 working，且无法放回 inbox；执行结果未知',
          clock.now()
        );
        await writeResult(id, result);
        await moveRemote(workingPath, `${dirs.failed}/${name}`);
        report.abandoned += 1;
      } catch (err) {
        noteError(err, 'recover-working');
        if (!opts.silent) throw err;
      }
    }
    return report;
  }

  /**
   * Run recovery at most once; concurrent callers share the same promise so a
   * start() and the first tick() cannot both rewrite abandoned results.
   *
   * @returns {Promise<{scanned:number,cleaned:number,abandoned:number,retried:number}|null>}
   */
  function ensureRecovered() {
    if (recovered) return Promise.resolve(null);
    if (!recoverPromise) {
      recoverPromise = recoverInternal({ silent: true })
        .then((report) => {
          recovered = true;
          return report;
        })
        .catch((err) => {
          recoverPromise = null;
          throw err;
        });
    }
    return recoverPromise;
  }

  /**
   * Public recovery entry point (also invoked once by the first tick).
   * @returns {Promise<{scanned:number,cleaned:number,abandoned:number,retried:number}>}
   */
  async function recover() {
    try {
      const report = await ensureRecovered();
      return report || { scanned: 0, cleaned: 0, abandoned: 0, retried: 0 };
    } catch (err) {
      noteError(err, 'recover');
      return { scanned: 0, cleaned: 0, abandoned: 0, retried: 0, error: normalizeError(err) };
    }
  }

  function start() {
    if (timer) return status();
    running = true;
    recover().catch(() => {});
    timer = setInterval(() => {
      tick().catch((err) => noteError(err, 'interval'));
    }, pollIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    logger.info('mailbox poller started', {
      root,
      intervalMs: pollIntervalMs,
      workers: maxConcurrency,
      resultRetain,
    });
    return status();
  }

  function stop() {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    knownSizes.clear();
    logger.info('mailbox poller stopped', { root });
    return status();
  }

  function dispose() {
    stop();
    if (localDirPath) {
      try {
        fs.rmSync(localDirPath, { recursive: true, force: true });
      } catch {
        // best effort
      }
      localDirPath = null;
    }
  }

  function status() {
    return {
      root,
      dirs: { ...dirs },
      running,
      interval_ms: pollIntervalMs,
      workers: maxConcurrency,
      result_retain: resultRetain,
      inflight: inflight.size,
      pending_size_tracking: knownSizes.size,
      last_poll_at: lastPollAt,
      last_error: lastError,
      last_error_at: lastErrorAt,
      counts: { ...lastCounts },
      counters: { ...counters },
    };
  }

  return {
    // lifecycle
    start,
    stop,
    tick,
    recover,
    dispose,
    status,
    // introspection
    root,
    dirs,
    principal,
    // protocol helpers (same module so the phone docs and poller cannot drift)
    buildCommand,
    parseCommand,
    buildResult,
  };
}

module.exports = {
  // frozen-name alias (contracts.MODULES.C) + this track's name
  createMailbox,
  createMailboxPoller: createMailbox,
  // protocol helpers
  buildCommand,
  parseCommand,
  buildResult,
  parseExpiry,
  // constants useful to the daemon/tests
  COMMAND_FILE_RE,
  RESULT_FILE_RE,
  FILE_PRINCIPAL,
  FILE_SCOPE_TOOLS,
  // helpers
  fallbackShQuote,
  runPool,
  runWithTimeout,
};
