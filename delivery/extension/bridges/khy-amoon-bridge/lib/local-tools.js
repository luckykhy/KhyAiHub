'use strict';

/**
 * local-tools.js — the tool table executed by lib/server.js.
 *
 * Design decisions that matter for security:
 *
 *   - Every path argument is resolved through realpath (symlinks included) and
 *     checked against a configured root list. Writes default to the state
 *     directory + the user home; reads additionally allow cwd and tmp. `*` in a
 *     root list disables the check and is auditable configuration, not a
 *     default.
 *   - exec NEVER joins user input into a command line. `mode:"direct"` spawns
 *     an executable with an argv array and shell:false. `mode:"powershell"` /
 *     `mode:"sh"` spawn the interpreter with a fixed argv and send the script
 *     over stdin, so a `;` in a path or argument cannot become a second command.
 *   - khy.ask runs the KhyOS one-shot CLI in a background job (HTTP returns
 *     202 + job id). It uses the sentinel allowlist, a fixed system prompt,
 *     an empty cwd by default, max-turns clamp, and a timeout. No test in this
 *     repository calls the real model; tests inject a fake khy.js.
 *   - read-only mode (KHY_LOCAL_READONLY=1) rejects every mutating tool while
 *     keeping inspection tools usable.
 *
 * Comments are English; tool titles/messages are Chinese.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const C = require('./contracts');

const LOCAL_VERSION = '0.1.0';
const DEFAULT_EXEC_TIMEOUT_MS = 30000;
const MAX_EXEC_TIMEOUT_MS = 120000;
const DEFAULT_READ_LIMIT = 1024 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_WRITE_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_JOB_RESULT_BYTES = 2 * 1024 * 1024;
const DEFAULT_JOB_TTL_MS = 60 * 60 * 1000;
const DEFAULT_JOB_LIMIT = 100;
const TERMINAL_STATES = new Set(['done', 'failed', 'cancelled']);

/** khy.ask may only pass these tools to KhyOS; MCP/arbitrary names are rejected. */
const DEFAULT_KHY_TOOL_ALLOWLIST = Object.freeze(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch']);

function resolveKhyToolAllowlist(env, override) {
  const set = new Set();
  if (Array.isArray(override) && override.length) {
    for (const name of override) set.add(name);
  } else {
    const raw = env && env.KHY_AMOON_KHY_TOOL_ALLOWLIST;
    const list =
      typeof raw === 'string' && raw.trim()
        ? raw.split(',').map((name) => name.trim()).filter(Boolean)
        : DEFAULT_KHY_TOOL_ALLOWLIST;
    for (const name of list) set.add(name);
  }
  set.add(C.TOOL_POLICY.sentinelTool);
  return set;
}

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

function schema(properties, required) {
  const out = { type: 'object', properties, additionalProperties: false };
  if (required && required.length) out.required = required;
  return out;
}

// ── Small validation helpers ────────────────────────────────────────────────

function fail(code, message, details) {
  throw new C.BridgeError(code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeArgs(args) {
  if (args === undefined || args === null) return {};
  if (!isPlainObject(args)) fail('invalid_args', '工具参数必须是 JSON 对象');
  return args;
}

function assertKeys(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      fail('invalid_args', `不支持的参数：${key}`, { allowed });
    }
  }
}

function optString(args, key, opts = {}) {
  const value = args[key];
  if (value === undefined || value === null) {
    if (opts.required) fail('invalid_args', `缺少参数：${key}`);
    return opts.def;
  }
  if (typeof value !== 'string') fail('invalid_args', `参数 ${key} 必须是字符串`);
  if (value.length < (opts.min === undefined ? 0 : opts.min)) {
    fail('invalid_args', `参数 ${key} 过短`, { min: opts.min });
  }
  if (value.length > (opts.max === undefined ? 1000000 : opts.max)) {
    fail('invalid_args', `参数 ${key} 过长`, { max: opts.max });
  }
  return value;
}

function optInt(args, key, opts = {}) {
  const value = args[key];
  if (value === undefined || value === null) {
    if (opts.required) fail('invalid_args', `缺少参数：${key}`);
    return opts.def;
  }
  if (!Number.isInteger(value)) fail('invalid_args', `参数 ${key} 必须是整数`);
  const min = opts.min === undefined ? Number.MIN_SAFE_INTEGER : opts.min;
  const max = opts.max === undefined ? Number.MAX_SAFE_INTEGER : opts.max;
  if (value < min || value > max) fail('invalid_args', `参数 ${key} 超出范围`, { min, max });
  return value;
}

function optBool(args, key, def) {
  const value = args[key];
  if (value === undefined || value === null) return def;
  if (typeof value !== 'boolean') fail('invalid_args', `参数 ${key} 必须是布尔值`);
  return value;
}

function optStringArray(args, key, opts = {}) {
  const value = args[key];
  if (value === undefined || value === null) return opts.def === undefined ? [] : opts.def;
  if (!Array.isArray(value)) fail('invalid_args', `参数 ${key} 必须是字符串数组`);
  if (value.length > (opts.maxItems === undefined ? 64 : opts.maxItems)) {
    fail('invalid_args', `参数 ${key} 元素过多`);
  }
  return value.map((item) => {
    if (typeof item !== 'string') fail('invalid_args', `参数 ${key} 只能包含字符串`);
    if (item.length > (opts.maxLength === undefined ? 4096 : opts.maxLength)) {
      fail('invalid_args', `参数 ${key} 的单个元素过长`);
    }
    return item;
  });
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Strict base64 decode: Buffer.from() silently skips invalid characters. */
function decodeBase64Strict(text) {
  const compact = String(text).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    fail('invalid_args', 'content 不是合法的 base64（需要标准 base64 与 = 填充）');
  }
  return Buffer.from(compact, 'base64');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

// ── Path safety ─────────────────────────────────────────────────────────────

function normalizeRoots(value, fallback) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(path.delimiter)
      : [];
  const cleaned = list.map((item) => String(item).trim()).filter(Boolean);
  const source = cleaned.length ? cleaned : fallback || [];
  if (source.includes('*')) return ['*'];
  const resolved = source.map((item) => path.resolve(item));
  return [...new Set(resolved)];
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInsideRoot(candidate, root) {
  if (root === '*') return true;
  const rel = path.relative(comparablePath(root), comparablePath(candidate));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Resolve a path while following existing symlinks. Missing trailing components
 * are kept and the closest existing ancestor is realpath'd, so a write cannot
 * escape through a symlinked parent directory.
 */
function realpathLoose(target) {
  let current = path.resolve(target);
  const missing = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return missing.length ? path.join(real, ...missing) : real;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * @param {unknown} raw
 * @param {string[]} roots
 * @param {{mustExist?:boolean,wantFile?:boolean,wantDir?:boolean,follow?:boolean}} [opts]
 * @returns {string} absolute, realpath-resolved path inside `roots`
 */
function resolvePath(raw, roots, opts = {}) {
  if (typeof raw !== 'string' || !raw.trim()) fail('invalid_args', '路径不能为空');
  if (CONTROL_RE.test(raw)) fail('invalid_args', '路径包含控制字符');
  const abs = path.resolve(raw);
  let resolved;
  if (opts.follow === false) {
    const parent = realpathLoose(path.dirname(abs));
    resolved = path.join(parent, path.basename(abs));
  } else {
    resolved = realpathLoose(abs);
  }
  // Check confinement before existence: an out-of-root path should not reveal
  // whether it exists, and a symlinked parent must be rejected consistently.
  if (!roots.some((root) => isInsideRoot(resolved, root))) {
    fail('forbidden_scope', `路径不在允许的根目录内：${raw}`, {
      roots: roots.map((root) => (root === '*' ? '*' : root)),
    });
  }
  if (opts.mustExist && !fs.existsSync(resolved)) {
    fail('not_found', `路径不存在：${raw}`);
  }
  if (opts.wantFile) {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) fail('invalid_args', `不是文件：${raw}`);
  }
  if (opts.wantDir) {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) fail('invalid_args', `不是目录：${raw}`);
  }
  return resolved;
}

function isRootOrAncestor(target, roots) {
  if (roots.includes('*')) {
    return comparablePath(target) === comparablePath(path.parse(path.resolve(target)).root);
  }
  return roots.some((root) => comparablePath(target) === comparablePath(root) || isInsideRoot(root, target));
}

function atomicWriteFile(file, data, opts = {}) {
  const dir = path.dirname(file);
  if (opts.mkdirs !== false) fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    let offset = 0;
    while (offset < data.length) {
      offset += fs.writeSync(fd, data, offset, data.length - offset);
    }
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') return null;
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// ── Process execution ───────────────────────────────────────────────────────

/**
 * Spawn without a shell and collect capped stdout/stderr. The process tree is
 * killed on timeout, abort, or output overflow.
 *
 * @returns {Promise<{exitCode:number|null,stdout:string,stderr:string,truncated:boolean,timedOut:boolean,aborted:boolean,durationMs:number}>}
 */
function runProcess(options) {
  const {
    file,
    argv = [],
    input,
    cwd,
    env,
    timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
    maxBytes = MAX_OUTPUT_BYTES,
    signal,
  } = options;

  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(file, argv, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new C.BridgeError('invalid_args', `无法启动命令 ${file}：${err.message}`));
      return;
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let truncated = false;
    let outBytes = 0;
    let errBytes = 0;
    const out = [];
    const err = [];
    let onAbort = null;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        aborted = true;
        killTree(child);
      } else {
        onAbort = () => {
          aborted = true;
          killTree(child);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    function cleanup() {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    }

    child.on('error', (error) => {
      const code = error && error.code === 'ENOENT' ? 'invalid_args' : 'internal_error';
      settle(reject, new C.BridgeError(code, `无法启动命令 ${file}：${error.message}`));
    });

    child.on('close', (code) => {
      settle(resolve, {
        exitCode: code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
      });
    });

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > maxBytes) {
        truncated = true;
        killTree(child);
        return;
      }
      out.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      errBytes += chunk.length;
      if (errBytes > maxBytes) {
        truncated = true;
        killTree(child);
        return;
      }
      err.push(chunk);
    });

    // A killed child can make stdin emit EPIPE; an unhandled stream error
    // would take the whole server down.
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    try {
      if (input !== undefined && input !== null) child.stdin.end(String(input));
      else child.stdin.end();
    } catch {
      // stdin may already be closed; the exit handler reports the result.
    }
  });
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // The child may have exited between the check and the kill.
  }
}

const PS_PREAMBLE = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '$OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  "$ProgressPreference = 'SilentlyContinue'",
].join('\n');

/** Wrap a script with UTF-8 output settings and a terminating error handler. */
function psScript(body) {
  return [
    PS_PREAMBLE,
    'try {',
    body,
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n');
}

// Command-line length on Windows is 32767 characters; base64(UTF-16LE) is
// ~2.67 chars per script character, so 10000 keeps us safely below the limit.
const MAX_PS_SCRIPT_CHARS = 10000;

/**
 * PowerShell writes stderr as plain text plus a CLIXML progress document.
 * Keep real error text and drop the progress noise.
 */
function cleanPowerShellStderr(text) {
  if (!text || !text.includes('#< CLIXML')) return text || '';
  const decoded = [];
  const re = /<S S="Error">([\s\S]*?)<\/S>/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    decoded.push(
      match[1]
        .replace(/_x000D__x000A_/g, '\n')
        .replace(/_x000D_/g, '\r')
        .replace(/_x000A_/g, '\n')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
    );
  }
  if (decoded.length) return decoded.join('\n').trim();
  return text
    .split(/\r?\n/)
    .filter((line) => !/^#< CLIXML/.test(line) && !/^<\/?Objs/.test(line))
    .join('\n')
    .trim();
}

function runPowerShell(script, options = {}) {
  if (String(script).length > MAX_PS_SCRIPT_CHARS) {
    return Promise.reject(
      new C.BridgeError('payload_too_large', `PowerShell 脚本超过 ${MAX_PS_SCRIPT_CHARS} 字符上限`)
    );
  }
  // -EncodedCommand (base64 of UTF-16LE) is used instead of `-Command -`
  // because PowerShell 5.1 executes stdin line-by-line and silently drops
  // multi-line try/catch blocks. The argv shape is fixed; the user script is
  // a base64 data argument, never concatenated into a shell command line.
  const encoded = Buffer.from(psScript(script), 'utf16le').toString('base64');
  return runProcess({
    file: 'powershell.exe',
    argv: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs === undefined ? 15000 : options.timeoutMs,
    maxBytes: options.maxBytes === undefined ? MAX_OUTPUT_BYTES : options.maxBytes,
    signal: options.signal,
  }).then((result) => ({ ...result, stderr: cleanPowerShellStderr(result.stderr) }));
}

function runPosixShell(script, options = {}) {
  return runProcess({
    file: '/bin/sh',
    argv: [],
    input: `${script}\n`,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs === undefined ? 15000 : options.timeoutMs,
    maxBytes: options.maxBytes === undefined ? MAX_OUTPUT_BYTES : options.maxBytes,
    signal: options.signal,
  });
}

function requireSuccess(result, what) {
  if (result.timedOut) fail('timeout', `${what}超时`);
  if (result.aborted) fail('timeout', `${what}已被取消`);
  if (result.exitCode !== 0) {
    fail('internal_error', `${what}失败（退出码 ${result.exitCode}）`, {
      stderr: result.stderr.slice(0, 4000),
    });
  }
  return result;
}

function base64Utf8(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

// ── Tool implementation ─────────────────────────────────────────────────────

/**
 * @param {{
 *   stateDir: string,
 *   writeRoots?: string[]|string,
 *   readRoots?: string[]|string,
 *   cwdAllowlist?: string[]|string,
 *   khyJs?: string|null,
 *   readOnly?: boolean,
 *   allowExec?: boolean,
 *   jobTtlMs?: number,
 *   jobLimit?: number,
 *   maxConcurrentJobs?: number,
 *   clock?: Function|{now:Function},
 *   logger?: object|null,
 * }} options
 */
function createLocalTools(options = {}) {
  if (!options || typeof options !== 'object') {
    throw new C.BridgeError('invalid_config', 'createLocalTools 需要 options');
  }
  const stateDir = path.resolve(options.stateDir || path.join(os.tmpdir(), 'khy-local-tools'));
  fs.mkdirSync(stateDir, { recursive: true });

  const clockOption = options.clock;
  const clock =
    typeof clockOption === 'function'
      ? clockOption
      : clockOption && typeof clockOption.now === 'function'
        ? clockOption.now.bind(clockOption)
        : Date.now;
  const nowIso = () => new Date(clock()).toISOString();
  const logger = options.logger || null;
  const khyToolAllowlist = resolveKhyToolAllowlist(options.env || process.env, options.khyToolAllowlist);

  const writeRoots = normalizeRoots(options.writeRoots, [stateDir]);
  const readRoots = normalizeRoots(
    options.readRoots,
    writeRoots.includes('*') ? ['*'] : [...writeRoots, process.cwd(), os.tmpdir()]
  );
  const cwdAllowlist = normalizeRoots(options.cwdAllowlist, [
    ...readRoots.filter((r) => r !== '*'),
    stateDir,
  ]);
  const readOnly = options.readOnly === true;
  const allowExec = options.allowExec !== false;
  const khyJs = options.khyJs ? path.resolve(options.khyJs) : null;
  const emptyCwd = path.join(stateDir, 'khy-cwd');
  fs.mkdirSync(emptyCwd, { recursive: true });

  const startedAt = clock();
  const stats = { calls: 0, ok: 0, errors: 0 };

  // ── Background jobs ──────────────────────────────────────────────────────

  const jobsDir = path.join(stateDir, 'jobs');
  const jobs = new Map();
  const jobTtlMs = Number.isFinite(options.jobTtlMs) && options.jobTtlMs > 0 ? options.jobTtlMs : DEFAULT_JOB_TTL_MS;
  const jobLimit = Number.isFinite(options.jobLimit) && options.jobLimit > 0 ? options.jobLimit : DEFAULT_JOB_LIMIT;
  const maxConcurrentJobs =
    Number.isFinite(options.maxConcurrentJobs) && options.maxConcurrentJobs > 0
      ? options.maxConcurrentJobs
      : 2;
  let runningJobs = 0;

  function jobPublic(job) {
    const out = {
      id: job.id,
      tool: job.tool,
      state: job.state,
      created_at: job.created_at,
      started_at: job.started_at || null,
      finished_at: job.finished_at || null,
      duration_ms: job.duration_ms === undefined ? null : job.duration_ms,
      args_sha256: job.args_sha256,
      args_bytes: job.args_bytes,
      request_id: job.request_id || null,
      source: job.source || null,
      timed_out: job.timed_out === true,
    };
    if (job.result !== undefined) out.result = job.result;
    if (job.error !== undefined) out.error = job.error;
    if (job.result_omitted) out.result_omitted = true;
    return out;
  }

  function jobFile(id) {
    return path.join(jobsDir, `${id}.json`);
  }

  function persistJob(job) {
    try {
      fs.mkdirSync(jobsDir, { recursive: true });
      const data = jobPublic(job);
      let text = JSON.stringify(data);
      if (Buffer.byteLength(text, 'utf8') > MAX_JOB_RESULT_BYTES) {
        delete data.result;
        data.result_omitted = true;
        text = JSON.stringify(data);
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_JOB_RESULT_BYTES) {
        // Still too large (e.g. huge error details): persist metadata only.
        return;
      }
      const tmp = `${jobFile(job.id)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, jobFile(job.id));
    } catch (err) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('failed to persist job', { job_id: job.id, error: err.message });
      }
    }
  }

  function loadJobs() {
    let names;
    try {
      names = fs.readdirSync(jobsDir).filter((name) => name.endsWith('.json'));
    } catch {
      return;
    }
    const loaded = [];
    for (const name of names) {
      if (loaded.length >= jobLimit) break;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(jobsDir, name), 'utf8'));
        if (!data || typeof data.id !== 'string') continue;
        if (!TERMINAL_STATES.has(data.state)) {
          data.state = 'failed';
          data.error = { code: 'daemon_restart', message: '工具进程已重启，未完成的任务被终止' };
          data.finished_at = nowIso();
        }
        loaded.push(data);
      } catch {
        // ignore corrupt job files
      }
    }
    for (const data of loaded) {
      jobs.set(data.id, { ...data, runner: null, controller: null, waiters: new Set() });
      persistJob(data);
    }
  }

  function sweepJobs(force = false) {
    const cutoff = clock() - jobTtlMs;
    for (const [id, job] of jobs) {
      if (!TERMINAL_STATES.has(job.state)) continue;
      const finished = job.finished_at ? Date.parse(job.finished_at) : 0;
      if (force || (finished && finished < cutoff)) {
        jobs.delete(id);
        try {
          fs.unlinkSync(jobFile(id));
        } catch {
          // ignore missing file
        }
      }
    }
  }

  function notifyWaiters(job) {
    if (!job.waiters) return;
    for (const waiter of [...job.waiters]) {
      job.waiters.delete(waiter);
      try {
        waiter();
      } catch {
        // ignore
      }
    }
  }

  function pumpJobs() {
    if (runningJobs >= maxConcurrentJobs) return;
    for (const job of jobs.values()) {
      if (runningJobs >= maxConcurrentJobs) break;
      if (job.state === 'queued' && job.runner) startJob(job);
    }
  }

  function startJob(job) {
    job.state = 'running';
    job.started_at = nowIso();
    runningJobs += 1;
    persistJob(job);

    const started = Date.now();
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        job.timed_out = true;
        job.controller.abort();
        reject(new C.BridgeError('timeout', `任务超时（${job.timeout_ms}ms）`));
      }, job.timeout_ms);
    });
    const cancelPromise = new Promise((_, reject) => {
      job.controller.signal.addEventListener(
        'abort',
        () => reject(new C.BridgeError('timeout', '任务已取消')),
        { once: true }
      );
    });

    const runnerPromise = Promise.resolve().then(() => job.runner({ signal: job.controller.signal }));
    // If the race rejects first (timeout/cancel), the runner may keep running
    // until it observes the abort; swallow its late rejection.
    runnerPromise.catch(() => {});

    Promise.race([runnerPromise, timeoutPromise, cancelPromise])
      .then(
        (data) => {
          if (job.state === 'cancelled') return;
          job.state = 'done';
          job.result = data;
        },
        (err) => {
          if (job.state === 'cancelled') return;
          job.state = 'failed';
          job.error = {
            code: err && err.code ? err.code : 'internal_error',
            message: err && err.message ? err.message : String(err),
          };
          if (err && err.details) job.error.details = err.details;
        }
      )
      .finally(() => {
        clearTimeout(timeoutId);
        job.duration_ms = Date.now() - started;
        job.finished_at = nowIso();
        if (job.state === 'running') job.state = 'failed';
        delete job.runner;
        delete job.controller;
        runningJobs = Math.max(0, runningJobs - 1);
        persistJob(job);
        notifyWaiters(job);
        pumpJobs();
      });
  }

  function enqueueJob(spec) {
    sweepJobs(false);
    if (jobs.size >= jobLimit) sweepJobs(true);
    if (jobs.size >= jobLimit) {
      fail('rate_limited', '后台任务数量已达上限，请稍后再试', { limit: jobLimit });
    }
    const id = `job-${crypto.randomUUID()}`;
    const serialized = stableStringify(spec.args || {});
    const job = {
      id,
      tool: spec.tool,
      state: 'queued',
      created_at: nowIso(),
      started_at: null,
      finished_at: null,
      duration_ms: undefined,
      args_sha256: sha256(serialized),
      args_bytes: Buffer.byteLength(serialized, 'utf8'),
      request_id: spec.requestId || null,
      source: spec.source || null,
      timeout_ms: spec.timeoutMs,
      runner: spec.runner,
      controller: new AbortController(),
      waiters: new Set(),
      timed_out: false,
    };
    jobs.set(id, job);
    persistJob(job);
    pumpJobs();
    return job;
  }

  function getJob(id) {
    const job = jobs.get(id);
    if (!job) fail('not_found', `任务不存在：${String(id)}`);
    return job;
  }

  /**
   * Wait for a job to reach a terminal state (or the wait budget to expire).
   * Used by POST /call's optional wait_ms; the HTTP thread is never blocked
   * beyond that bounded budget.
   */
  function waitForJob(id, timeoutMs, signal) {
    const job = getJob(id);
    if (TERMINAL_STATES.has(job.state)) return Promise.resolve(jobPublic(job));
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (job.waiters) job.waiters.delete(finish);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        resolve(jobPublic(job));
      };
      const onAbort = () => finish();
      if (job.waiters) job.waiters.add(finish);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(finish, Math.max(0, Number(timeoutMs) || 0));
      timer.unref();
    });
  }

  function cancelJob(id) {
    const job = getJob(id);
    if (job.state === 'queued') {
      job.state = 'cancelled';
      job.finished_at = nowIso();
      persistJob(job);
      notifyWaiters(job);
      pumpJobs();
      return jobPublic(job);
    }
    if (job.state === 'running') {
      job.state = 'cancelled';
      try {
        job.controller.abort();
      } catch {
        // ignore
      }
      return jobPublic(job);
    }
    fail('invalid_args', `任务已结束（${job.state}），无法取消`);
  }

  function jobStats() {
    const counts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const job of jobs.values()) {
      if (counts[job.state] !== undefined) counts[job.state] += 1;
    }
    return {
      total: jobs.size,
      ...counts,
      max_concurrent: maxConcurrentJobs,
      limit: jobLimit,
      ttl_ms: jobTtlMs,
    };
  }

  function listJobs(limit) {
    const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
    return [...jobs.values()]
      .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))
      .slice(0, max)
      .map((job) => {
        // Listings are summaries: results can be megabytes and belong to
        // task.get, not to a list response.
        const summary = jobPublic(job);
        delete summary.result;
        if (summary.error) summary.error = { code: summary.error.code, message: summary.error.message };
        return summary;
      });
  }

  // ── khy.ask ──────────────────────────────────────────────────────────────

  function resolveAskCwd(raw) {
    if (raw === undefined || raw === null || raw === '') return emptyCwd;
    return resolvePath(raw, cwdAllowlist, { mustExist: true, wantDir: true });
  }

  function checkedAllowedTools(raw) {
    const allowed = optStringArray({ allowed_tools: raw }, 'allowed_tools', {
      def: [],
      maxItems: 32,
      maxLength: 64,
    }).filter((name) => /^[A-Za-z0-9_.:-]{1,64}$/.test(name));
    const disallowed = allowed.filter((name) => !khyToolAllowlist.has(name));
    if (disallowed.length > 0) {
      fail('forbidden_scope', `allowed_tools 包含不允许的工具：${disallowed.join(', ')}`, {
        allowed: [...khyToolAllowlist],
      });
    }
    return allowed;
  }

  async function runKhyAsk(args, ctx) {
    if (!khyJs) {
      fail('invalid_config', '未配置 KhyOS CLI 路径（KHY_JS 或 options.khyJs），khy.ask 不可用');
    }
    if (!fs.existsSync(khyJs)) {
      fail('invalid_config', `KhyOS CLI 不存在：${khyJs}`);
    }
    const question = optString(args, 'question', { required: true, min: 1, max: 8000 });
    const maxTurns = optInt(args, 'max_turns', { def: 4, min: 1, max: 8 });
    const timeoutMs = optInt(args, 'timeout_ms', { def: 45000, min: 1000, max: 120000 });
    const cwd = resolveAskCwd(args.cwd);
    const allowed = checkedAllowedTools(args.allowed_tools);
    // An empty user allowlist must not become "no tools" via _normSet's null
    // return; the sentinel keeps the gateway active and filters every real tool.
    const allowList = allowed.length ? allowed.join(',') : C.TOOL_POLICY.sentinelTool;

    const argv = [
      khyJs,
      '-p',
      question,
      '--output-format',
      'json',
      '--max-turns',
      String(maxTurns),
      '--allowedTools',
      allowList,
      '--system-prompt',
      C.TOOL_POLICY.systemPrompt,
    ];

    const started = Date.now();
    const result = await runProcess({
      file: process.execPath,
      argv,
      cwd,
      timeoutMs,
      maxBytes: 2 * 1024 * 1024,
      signal: ctx && ctx.signal,
      env: {
        KHY_MCP_AUTOCONNECT: 'false',
        KHY_AMOON_DEPTH: '1',
        NO_COLOR: '1',
      },
    });
    if (result.timedOut) fail('timeout', `khy.ask 超时（${timeoutMs}ms）`);
    if (result.aborted) fail('timeout', 'khy.ask 已取消');
    if (result.exitCode !== 0) {
      fail('internal_error', `KhyOS 退出码 ${result.exitCode}`, {
        stderr: result.stderr.slice(-4000),
      });
    }

    let parsed = null;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = null;
    }
    let answer = '';
    if (parsed && typeof parsed === 'object') {
      const candidate =
        parsed.result !== undefined
          ? parsed.result
          : parsed.answer !== undefined
            ? parsed.answer
            : parsed.text !== undefined
              ? parsed.text
              : parsed.message && parsed.message.content !== undefined
                ? parsed.message.content
                : '';
      answer = typeof candidate === 'string' ? candidate : stableStringify(candidate);
    } else {
      answer = result.stdout.trim();
    }

    return {
      answer: answer.slice(0, 200000),
      stdout: result.stdout.slice(0, 1000000),
      stderr_tail: result.stderr.slice(-4000),
      exit_code: result.exitCode,
      duration_ms: Date.now() - started,
      truncated: result.truncated || answer.length > 200000,
      max_turns: maxTurns,
      cwd,
      allowed_tools: allowed,
    };
  }

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function pingHandler(args) {
    assertKeys(args, []);
    return { pong: true, ts: nowIso(), pid: process.pid, version: LOCAL_VERSION };
  }

  async function infoHandler(args) {
    assertKeys(args, []);
    return {
      name: 'khy-local-tools',
      version: LOCAL_VERSION,
      protocol: 'khy-local-tools/1',
      pid: process.pid,
      started_at: new Date(startedAt).toISOString(),
      uptime_s: Math.max(0, Math.round((clock() - startedAt) / 1000)),
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      state_dir: stateDir,
      read_only: readOnly,
      exec_enabled: allowExec && !readOnly,
      write_roots: writeRoots,
      read_roots: readRoots,
      tool_count: DEFS.length,
    };
  }

  async function statusHandler(args) {
    assertKeys(args, []);
    return {
      ok: true,
      version: LOCAL_VERSION,
      pid: process.pid,
      started_at: new Date(startedAt).toISOString(),
      uptime_s: Math.max(0, Math.round((clock() - startedAt) / 1000)),
      state_dir: stateDir,
      read_only: readOnly,
      exec_enabled: allowExec && !readOnly,
      tools: DEFS.map((def) => def.name),
      counters: { ...stats },
      tasks: jobStats(),
    };
  }

  async function execHandler(args, ctx) {
    assertKeys(args, ['command', 'args', 'mode', 'cwd', 'timeout_ms', 'stdin', 'max_bytes']);
    if (!allowExec) fail('forbidden_scope', 'exec 已被 KHY_LOCAL_ALLOW_EXEC=0 禁用');
    if (readOnly) fail('forbidden_scope', '只读模式已启用，禁止调用 exec');

    const command = optString(args, 'command', { required: true, min: 1, max: 65536 });
    const mode = optString(args, 'mode', {
      def: process.platform === 'win32' ? 'powershell' : 'sh',
      max: 16,
    });
    if (!['direct', 'powershell', 'sh'].includes(mode)) {
      fail('invalid_args', 'mode 只能是 direct/powershell/sh');
    }
    const argv = optStringArray(args, 'args', { def: [], maxItems: 64, maxLength: 4096 });
    const timeoutMs = optInt(args, 'timeout_ms', {
      def: DEFAULT_EXEC_TIMEOUT_MS,
      min: 500,
      max: MAX_EXEC_TIMEOUT_MS,
    });
    const maxBytes = optInt(args, 'max_bytes', { def: MAX_OUTPUT_BYTES, min: 256, max: 4 * 1024 * 1024 });
    const cwd = args.cwd
      ? resolvePath(args.cwd, readRoots, { mustExist: true, wantDir: true })
      : stateDir;
    const stdin = optString(args, 'stdin', { def: undefined, max: 65536 });

    let result;
    if (mode === 'direct') {
      result = await runProcess({
        file: command,
        argv,
        input: stdin,
        cwd,
        timeoutMs,
        maxBytes,
        signal: ctx && ctx.signal,
      });
    } else {
      if (argv.length > 0) {
        fail('invalid_args', '脚本模式下 args 必须为空；请把参数直接写进 command 脚本');
      }
      if (stdin !== undefined) {
        fail('invalid_args', '脚本模式的 stdin 保留给脚本本身，不能同时传 stdin');
      }
      if (mode === 'powershell' && process.platform !== 'win32') {
        fail('invalid_args', 'powershell 模式只在 Windows 可用');
      }
      if (mode === 'sh' && process.platform === 'win32') {
        fail('invalid_args', 'sh 模式只在类 Unix 可用；Windows 请用 powershell 或 direct');
      }
      if (command.length > 10000) {
        fail('payload_too_large', '脚本超过 10000 字符上限（base64 后必须放得进 Windows 命令行）');
      }
      result =
        mode === 'powershell'
          ? await runPowerShell(command, { cwd, timeoutMs, maxBytes, signal: ctx && ctx.signal })
          : await runPosixShell(command, { cwd, timeoutMs, maxBytes, signal: ctx && ctx.signal });
    }

    if (result.timedOut) fail('timeout', `命令超时（${timeoutMs}ms）`);
    if (result.aborted) fail('timeout', '命令已被取消');
    return {
      mode,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      duration_ms: result.durationMs,
      cwd,
    };
  }

  async function lsHandler(args) {
    assertKeys(args, ['path', 'all', 'long']);
    const raw = optString(args, 'path', { min: 1, max: 4096 }) || stateDir;
    const full = resolvePath(raw, readRoots, { mustExist: true, wantDir: true });
    const all = optBool(args, 'all', true);
    const long = optBool(args, 'long', true);
    const entries = [];
    let truncated = false;
    for (const dirent of fs.readdirSync(full, { withFileTypes: true })) {
      if (!all && dirent.name.startsWith('.')) continue;
      if (entries.length >= 1000) {
        truncated = true;
        break;
      }
      const child = path.join(full, dirent.name);
      let stat;
      try {
        stat = fs.lstatSync(child);
      } catch {
        continue;
      }
      const entry = {
        name: dirent.name,
        type: dirent.isDirectory() ? 'dir' : dirent.isSymbolicLink() ? 'symlink' : dirent.isFile() ? 'file' : 'other',
      };
      if (long) {
        entry.size = stat.size;
        entry.mtime_ms = stat.mtimeMs;
      }
      entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { path: full, entries, truncated };
  }

  async function readHandler(args) {
    assertKeys(args, ['path', 'offset', 'limit', 'encoding']);
    const raw = optString(args, 'path', { required: true, min: 1, max: 4096 });
    const full = resolvePath(raw, readRoots, { mustExist: true, wantFile: true });
    const encoding = optString(args, 'encoding', { def: 'utf8', max: 16 });
    if (!['utf8', 'base64'].includes(encoding)) fail('invalid_args', 'encoding 只能是 utf8 或 base64');
    const offset = optInt(args, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
    const limit = optInt(args, 'limit', { def: DEFAULT_READ_LIMIT, min: 1, max: MAX_READ_BYTES });
    const stat = fs.statSync(full);

    if (stat.size === 0 || offset >= stat.size) {
      return {
        path: full,
        size: stat.size,
        offset,
        returned_bytes: 0,
        truncated: offset < stat.size,
        encoding,
        content: '',
      };
    }

    const toRead = Math.min(limit, stat.size - offset);
    const buffer = Buffer.alloc(toRead);
    const fd = fs.openSync(full, 'r');
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buffer, 0, toRead, offset);
    } finally {
      fs.closeSync(fd);
    }
    const slice = buffer.subarray(0, bytesRead);
    return {
      path: full,
      size: stat.size,
      offset,
      returned_bytes: bytesRead,
      truncated: offset + bytesRead < stat.size,
      encoding,
      content: slice.toString(encoding),
    };
  }

  async function writeHandler(args) {
    assertKeys(args, ['path', 'content', 'encoding', 'mode', 'mkdirs']);
    const raw = optString(args, 'path', { required: true, min: 1, max: 4096 });
    const content = optString(args, 'content', { required: true, max: MAX_WRITE_BYTES });
    const encoding = optString(args, 'encoding', { def: 'utf8', max: 16 });
    if (!['utf8', 'base64'].includes(encoding)) fail('invalid_args', 'encoding 只能是 utf8 或 base64');
    const mode = optString(args, 'mode', { def: 'overwrite', max: 16 });
    if (!['overwrite', 'append', 'create'].includes(mode)) {
      fail('invalid_args', 'mode 只能是 overwrite/append/create');
    }
    const mkdirs = optBool(args, 'mkdirs', true);
    const full = resolvePath(raw, writeRoots, {});
    if (isRootOrAncestor(full, writeRoots)) {
      fail('invalid_args', '不能把文件写到允许根目录本身');
    }
    const data = encoding === 'base64' ? decodeBase64Strict(content) : Buffer.from(content, 'utf8');
    if (data.length > MAX_WRITE_BYTES) {
      fail('payload_too_large', `写入内容超过 ${MAX_WRITE_BYTES} 字节`);
    }
    const existed = fs.existsSync(full);
    if (mode === 'create' && existed) fail('id_conflict', `文件已存在：${raw}`);
    if (mkdirs) fs.mkdirSync(path.dirname(full), { recursive: true });

    if (mode === 'append') {
      fs.appendFileSync(full, data);
    } else if (mode === 'create') {
      fs.writeFileSync(full, data, { flag: 'wx', mode: 0o600 });
    } else {
      atomicWriteFile(full, data, { mkdirs });
    }

    return {
      path: full,
      bytes: data.length,
      sha256: sha256(data),
      mode,
      created: !existed,
    };
  }

  async function mkdirHandler(args) {
    assertKeys(args, ['path', 'recursive']);
    const raw = optString(args, 'path', { required: true, min: 1, max: 4096 });
    const full = resolvePath(raw, writeRoots, {});
    const recursive = optBool(args, 'recursive', true);
    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch {
      stat = null;
    }
    if (stat) {
      if (!stat.isDirectory()) fail('invalid_args', `路径已存在且不是目录：${raw}`);
      return { path: full, created: false };
    }
    fs.mkdirSync(full, { recursive });
    return { path: full, created: true };
  }

  async function rmHandler(args) {
    assertKeys(args, ['path', 'recursive', 'confirm', 'force']);
    const raw = optString(args, 'path', { required: true, min: 1, max: 4096 });
    const recursive = optBool(args, 'recursive', false);
    const confirm = optBool(args, 'confirm', false);
    const force = optBool(args, 'force', false);
    const full = resolvePath(raw, writeRoots, {});
    if (isRootOrAncestor(full, writeRoots)) {
      fail('forbidden_scope', '拒绝删除允许根目录或其祖先目录');
    }
    if (!fs.existsSync(full)) {
      if (force) return { path: full, removed: false };
      fail('not_found', `路径不存在：${raw}`);
    }
    const stat = fs.lstatSync(full);
    if (stat.isDirectory() && !recursive) {
      fail('invalid_args', '删除目录需要 recursive=true');
    }
    if (stat.isDirectory() && recursive && !confirm) {
      fail('invalid_args', '递归删除需要 confirm=true 作为二次确认');
    }
    fs.rmSync(full, { recursive, force: false });
    return { path: full, removed: true, type: stat.isDirectory() ? 'dir' : 'file' };
  }

  async function mvHandler(args) {
    assertKeys(args, ['from', 'to', 'overwrite', 'mkdirs']);
    const fromRaw = optString(args, 'from', { required: true, min: 1, max: 4096 });
    const toRaw = optString(args, 'to', { required: true, min: 1, max: 4096 });
    const overwrite = optBool(args, 'overwrite', false);
    const mkdirs = optBool(args, 'mkdirs', true);
    const from = resolvePath(fromRaw, writeRoots, { mustExist: true });
    const to = resolvePath(toRaw, writeRoots, {});
    if (from === to) fail('invalid_args', '源路径与目标路径相同');
    if (isRootOrAncestor(to, writeRoots)) fail('forbidden_scope', '不能把路径移动到允许根目录本身');
    if (fs.existsSync(to) && !overwrite) fail('id_conflict', `目标已存在：${toRaw}`);
    if (mkdirs) fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.cpSync(from, to, { recursive: true, force: overwrite, errorOnExist: !overwrite });
      fs.rmSync(from, { recursive: true, force: true });
    }
    return { from, to, overwritten: overwrite && fs.existsSync(to) };
  }

  async function cpHandler(args) {
    assertKeys(args, ['from', 'to', 'recursive', 'overwrite']);
    const fromRaw = optString(args, 'from', { required: true, min: 1, max: 4096 });
    const toRaw = optString(args, 'to', { required: true, min: 1, max: 4096 });
    const recursive = optBool(args, 'recursive', false);
    const overwrite = optBool(args, 'overwrite', false);
    // Copy reads from a read root and writes into a write root; a move removes
    // the source, so both ends must be writable.
    const from = resolvePath(fromRaw, readRoots, { mustExist: true });
    const to = resolvePath(toRaw, writeRoots, {});
    const stat = fs.statSync(from);
    if (stat.isDirectory() && !recursive) fail('invalid_args', '复制目录需要 recursive=true');
    if (isRootOrAncestor(to, writeRoots)) fail('forbidden_scope', '不能把内容复制到允许根目录本身');
    if (fs.existsSync(to) && !overwrite) fail('id_conflict', `目标已存在：${toRaw}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, {
      recursive: stat.isDirectory(),
      force: overwrite,
      errorOnExist: !overwrite,
      preserveTimestamps: true,
    });
    return { from, to, type: stat.isDirectory() ? 'dir' : 'file' };
  }

  async function statHandler(args) {
    assertKeys(args, ['path', 'follow']);
    const raw = optString(args, 'path', { required: true, min: 1, max: 4096 });
    const follow = optBool(args, 'follow', true);
    const full = resolvePath(raw, readRoots, { mustExist: true, follow });
    const stat = follow ? fs.statSync(full) : fs.lstatSync(full);
    const out = {
      path: full,
      type: stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other',
      size: stat.size,
      mtime_ms: stat.mtimeMs,
      ctime_ms: stat.ctimeMs,
      mode: stat.mode,
      uid: stat.uid,
      gid: stat.gid,
      is_symlink: stat.isSymbolicLink(),
    };
    if (stat.isSymbolicLink()) {
      try {
        out.target = fs.readlinkSync(full);
      } catch {
        // dangling link
      }
    }
    return out;
  }

  async function khyAskHandler(args, ctx) {
    assertKeys(args, ['question', 'cwd', 'max_turns', 'timeout_ms', 'allowed_tools']);
    // Validate before queueing so the client gets a 400 immediately.
    if (!khyJs) {
      fail('invalid_config', '未配置 KhyOS CLI 路径（KHY_JS 或 options.khyJs），khy.ask 不可用');
    }
    if (!fs.existsSync(khyJs)) {
      fail('invalid_config', `KhyOS CLI 不存在：${khyJs}`);
    }
    optString(args, 'question', { required: true, min: 1, max: 8000 });
    optInt(args, 'max_turns', { def: 4, min: 1, max: 8 });
    const timeoutMs = optInt(args, 'timeout_ms', { def: 45000, min: 1000, max: 120000 });
    optString(args, 'cwd', { max: 512 });
    checkedAllowedTools(args.allowed_tools);
    resolveAskCwd(args.cwd);

    const job = enqueueJob({
      tool: 'khy.ask',
      args,
      timeoutMs: timeoutMs + 5000,
      requestId: ctx && ctx.requestId,
      source: ctx && ctx.source,
      runner: (jobCtx) => runKhyAsk(args, jobCtx),
    });
    return { pending: true, job_id: job.id, state: job.state, tool: 'khy.ask' };
  }

  async function taskSubmitHandler(args, ctx) {
    assertKeys(args, ['tool', 'args', 'timeout_ms']);
    const tool = optString(args, 'tool', { required: true, min: 1, max: 64 });
    if (tool.startsWith('task.') || tool === 'khy.ask') {
      fail('invalid_args', 'task.submit 不能提交 task.* 或 khy.ask；khy.ask 自带异步队列');
    }
    const inner = args.args === undefined ? {} : args.args;
    if (!isPlainObject(inner)) fail('invalid_args', 'args 必须是 JSON 对象');
    const def = defsByName.get(tool);
    if (!def) fail('not_found', `未知工具：${tool}`);
    if (readOnly && !def.readOnly) fail('forbidden_scope', `只读模式已启用，禁止调用 ${tool}`);
    if (tool === 'exec' && !allowExec) fail('forbidden_scope', 'exec 已被 KHY_LOCAL_ALLOW_EXEC=0 禁用');
    const timeoutMs = optInt(args, 'timeout_ms', { def: 120000, min: 1000, max: 600000 });

    const job = enqueueJob({
      tool,
      args: inner,
      timeoutMs,
      requestId: ctx && ctx.requestId,
      source: ctx && ctx.source,
      runner: (jobCtx) => executeTool(tool, inner, jobCtx),
    });
    return { pending: true, job_id: job.id, state: job.state, tool };
  }

  async function taskGetHandler(args) {
    assertKeys(args, ['id']);
    const id = optString(args, 'id', { required: true, min: 8, max: 64 });
    return jobPublic(getJob(id));
  }

  async function taskListHandler(args) {
    assertKeys(args, ['limit']);
    const limit = optInt(args, 'limit', { def: 20, min: 1, max: 100 });
    sweepJobs(false);
    return { tasks: listJobs(limit), stats: jobStats() };
  }

  async function taskCancelHandler(args) {
    assertKeys(args, ['id']);
    const id = optString(args, 'id', { required: true, min: 8, max: 64 });
    return cancelJob(id);
  }

  async function notifyHandler(args, ctx) {
    assertKeys(args, ['title', 'message', 'level']);
    const title = optString(args, 'title', { def: 'Khy 本地工具', max: 200 });
    const message = optString(args, 'message', { required: true, min: 1, max: 4000 });
    const level = optString(args, 'level', { def: 'info', max: 16 });
    if (!['info', 'warn', 'error'].includes(level)) fail('invalid_args', 'level 只能是 info/warn/error');

    const record = {
      ts: nowIso(),
      level,
      title,
      message,
      request_id: (ctx && ctx.requestId) || null,
    };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, 'notifications.jsonl'), `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });

    let osNotification = false;
    let reason = null;
    if (process.platform === 'win32') {
      try {
        const result = await runPowerShell(
          [
            "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
            '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
            '$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:KHY_NOTIFY_TITLE))',
            '$message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:KHY_NOTIFY_MESSAGE))',
            "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
            "$xml.LoadXml(\"<toast><visual><binding template='ToastGeneric'><text></text><text></text></binding></visual></toast>\")",
            "$nodes = $xml.GetElementsByTagName('text')",
            '$nodes.Item(0).AppendChild($xml.CreateTextNode($title)) | Out-Null',
            '$nodes.Item(1).AppendChild($xml.CreateTextNode($message)) | Out-Null',
            '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
            "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Khy Local Tools').Show($toast)",
          ].join('\n'),
          {
            timeoutMs: 8000,
            maxBytes: 65536,
            signal: ctx && ctx.signal,
            env: {
              KHY_NOTIFY_TITLE: base64Utf8(title),
              KHY_NOTIFY_MESSAGE: base64Utf8(message),
            },
          }
        );
        osNotification = result.exitCode === 0 && !result.timedOut;
        if (!osNotification) reason = result.stderr.slice(0, 500) || 'toast failed';
      } catch (err) {
        reason = err.message;
      }
    } else {
      reason = '当前平台未实现系统通知，仅记录到 notifications.jsonl';
    }

    return { recorded: true, os_notification: osNotification, reason, ts: record.ts };
  }

  async function clipboardGetHandler(args) {
    assertKeys(args, []);
    let result;
    let source;
    if (process.platform === 'win32') {
      source = 'powershell';
      result = await runPowerShell('$text = Get-Clipboard -Raw\n[Console]::Out.Write($text)', {
        timeoutMs: 8000,
        maxBytes: 1024 * 1024,
      });
    } else if (process.platform === 'darwin') {
      source = 'pbpaste';
      result = await runProcess({ file: 'pbpaste', argv: [], timeoutMs: 8000, maxBytes: 1024 * 1024 });
    } else {
      try {
        source = 'xclip';
        result = await runProcess({
          file: 'xclip',
          argv: ['-selection', 'clipboard', '-o'],
          timeoutMs: 8000,
          maxBytes: 1024 * 1024,
        });
      } catch {
        try {
          source = 'xsel';
          result = await runProcess({
            file: 'xsel',
            argv: ['--clipboard', '--output'],
            timeoutMs: 8000,
            maxBytes: 1024 * 1024,
          });
        } catch {
          fail('not_implemented', '当前平台找不到剪贴板命令（xclip/xsel）');
        }
      }
    }
    requireSuccess(result, '读取剪贴板');
    return {
      text: result.stdout,
      bytes: Buffer.byteLength(result.stdout, 'utf8'),
      truncated: result.truncated,
      source,
    };
  }

  async function clipboardSetHandler(args) {
    assertKeys(args, ['text']);
    const text = optString(args, 'text', { required: true, max: 1024 * 1024 });
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) fail('payload_too_large', '剪贴板内容超过 1MB');

    let result;
    if (process.platform === 'win32') {
      result = await runPowerShell(
        [
          '$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:KHY_CLIP_B64))',
          'Set-Clipboard -Value $text',
          // Set-Clipboard uses delayed rendering; without a short delay the
          // content can disappear when this process exits.
          'Start-Sleep -Milliseconds 500',
        ].join('\n'),
        { timeoutMs: 8000, maxBytes: 65536, env: { KHY_CLIP_B64: base64Utf8(text) } }
      );
    } else if (process.platform === 'darwin') {
      result = await runProcess({ file: 'pbcopy', argv: [], input: text, timeoutMs: 8000, maxBytes: 65536 });
    } else {
      try {
        result = await runProcess({
          file: 'xclip',
          argv: ['-selection', 'clipboard', '-i'],
          input: text,
          timeoutMs: 8000,
          maxBytes: 65536,
        });
      } catch {
        try {
          result = await runProcess({
            file: 'xsel',
            argv: ['--clipboard', '--input'],
            input: text,
            timeoutMs: 8000,
            maxBytes: 65536,
          });
        } catch {
          fail('not_implemented', '当前平台找不到剪贴板命令（xclip/xsel）');
        }
      }
    }
    requireSuccess(result, '写入剪贴板');
    return { set: true, bytes: Buffer.byteLength(text, 'utf8') };
  }

  async function openHandler(args) {
    assertKeys(args, ['target']);
    const target = optString(args, 'target', { required: true, min: 1, max: 4096 });
    if (CONTROL_RE.test(target)) fail('invalid_args', 'target 包含控制字符');
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(target);
    if (scheme && !/^https?$/i.test(scheme[1])) {
      fail('invalid_args', 'open 只接受 http(s) URL 或本地路径（拒绝 file:// 等其他协议）');
    }
    const isUrl = Boolean(scheme && /^https?$/i.test(scheme[1]));
    let resolved = null;
    if (isUrl) {
      if (/\s/.test(target)) fail('invalid_args', 'URL 不能包含空白字符');
    } else {
      resolved = resolvePath(target, readRoots, { mustExist: true });
    }
    const value = resolved || target;

    let result;
    if (process.platform === 'win32') {
      result = await runPowerShell('Start-Process -FilePath $env:KHY_OPEN_TARGET', {
        timeoutMs: 10000,
        maxBytes: 65536,
        env: { KHY_OPEN_TARGET: value },
      });
    } else if (process.platform === 'darwin') {
      result = await runProcess({ file: 'open', argv: [value], timeoutMs: 10000, maxBytes: 65536 });
    } else {
      result = await runProcess({ file: 'xdg-open', argv: [value], timeoutMs: 10000, maxBytes: 65536 });
    }
    requireSuccess(result, '打开目标');
    return { opened: true, target: value, url: isUrl };
  }

  async function sysInfoHandler(args) {
    assertKeys(args, []);
    const cpus = os.cpus() || [];
    return {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      hostname: os.hostname(),
      username: os.userInfo().username,
      node: process.versions.node,
      cpus: { count: cpus.length, model: cpus.length ? cpus[0].model : null },
      memory: { total_bytes: os.totalmem(), free_bytes: os.freemem() },
      uptime_s: Math.round(os.uptime()),
      homedir: os.homedir(),
      tmpdir: os.tmpdir(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  async function khyStatusHandler(args) {
    assertKeys(args, []);
    let exists = false;
    if (khyJs) {
      try {
        exists = fs.statSync(khyJs).isFile();
      } catch {
        exists = false;
      }
    }
    return {
      khy_js: khyJs,
      configured: Boolean(khyJs),
      exists,
      node: process.execPath,
      tasks: jobStats(),
      recent: listJobs(5),
      env: { KHY_MCP_AUTOCONNECT: 'false', KHY_AMOON_DEPTH: '1' },
    };
  }

  async function screenShotHandler(args, ctx) {
    assertKeys(args, ['path', 'format']);
    const format = optString(args, 'format', { def: 'png', max: 8 });
    if (format !== 'png') fail('invalid_args', '目前只支持 png');
    let target;
    if (args.path !== undefined && args.path !== null) {
      target = resolvePath(args.path, writeRoots, {});
    } else {
      const stamp = new Date(clock()).toISOString().replace(/[:.]/g, '-');
      target = path.join(stateDir, 'screenshots', `shot-${stamp}.png`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });

    let result;
    if (process.platform === 'win32') {
      result = await runPowerShell(
        [
          'Add-Type -AssemblyName System.Windows.Forms',
          'Add-Type -AssemblyName System.Drawing',
          '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
          '$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
          '$g = [System.Drawing.Graphics]::FromImage($bmp)',
          'try {',
          '  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
          '  $bmp.Save($env:KHY_SHOT_PATH, [System.Drawing.Imaging.ImageFormat]::Png)',
          '} finally {',
          '  $g.Dispose()',
          '  $bmp.Dispose()',
          '}',
        ].join('\n'),
        {
          timeoutMs: 20000,
          maxBytes: 65536,
          signal: ctx && ctx.signal,
          env: { KHY_SHOT_PATH: target },
        }
      );
    } else if (process.platform === 'darwin') {
      result = await runProcess({ file: 'screencapture', argv: ['-x', target], timeoutMs: 20000, maxBytes: 65536 });
    } else {
      const candidates = [
        { file: 'scrot', argv: [target] },
        { file: 'gnome-screenshot', argv: ['-f', target] },
        { file: 'import', argv: ['-window', 'root', target] },
      ];
      result = null;
      for (const candidate of candidates) {
        try {
          result = await runProcess({ ...candidate, timeoutMs: 20000, maxBytes: 65536 });
          break;
        } catch (err) {
          if (err.code !== 'invalid_args') throw err;
        }
      }
      if (!result) fail('not_implemented', '当前平台找不到截图命令（scrot/gnome-screenshot/import）');
    }
    requireSuccess(result, '屏幕截图');

    const stat = fs.statSync(target);
    const header = Buffer.alloc(24);
    const fd = fs.openSync(target, 'r');
    try {
      fs.readSync(fd, header, 0, 24, 0);
    } finally {
      fs.closeSync(fd);
    }
    const size = format === 'png' ? pngSize(header) : null;
    let contentHash = null;
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(target);
    await new Promise((resolve, reject) => {
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    contentHash = hash.digest('hex');
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // best effort on Windows
    }
    return {
      path: target,
      bytes: stat.size,
      sha256: contentHash,
      width: size ? size.width : null,
      height: size ? size.height : null,
      format,
    };
  }

  // ── Definitions / registry ───────────────────────────────────────────────

  const DEFS = [
    {
      name: 'ping',
      title: '连通性探测',
      description: '最小连通性检查：返回 pong/时间/pid。不访问网络，不执行命令。',
      risk: 'low',
      readOnly: true,
      timeoutMs: 5000,
      responseMaxBytes: 64 * 1024,
      inputSchema: EMPTY_SCHEMA,
      handler: pingHandler,
    },
    {
      name: 'info',
      title: '本机工具信息',
      description: '返回本服务的版本、进程、平台、状态目录与允许根目录。',
      risk: 'low',
      readOnly: true,
      timeoutMs: 5000,
      responseMaxBytes: 64 * 1024,
      inputSchema: EMPTY_SCHEMA,
      handler: infoHandler,
    },
    {
      name: 'status',
      title: '运行状态',
      description: '返回运行时间、计数器、工具列表与后台任务统计。',
      risk: 'low',
      readOnly: true,
      timeoutMs: 5000,
      responseMaxBytes: 64 * 1024,
      inputSchema: EMPTY_SCHEMA,
      handler: statusHandler,
    },
    {
      name: 'exec',
      title: '执行命令',
      description:
        '执行命令：默认在 Windows 用 PowerShell、在类 Unix 用 /bin/sh，脚本经 stdin 传入；mode=direct 用 argv 直接 spawn，绝不把参数拼进命令行。',
      risk: 'high',
      readOnly: false,
      timeoutMs: 120000,
      responseMaxBytes: 2 * 1024 * 1024,
      inputSchema: schema(
        {
          command: { type: 'string', minLength: 1, maxLength: 10000 },
          args: { type: 'array', items: { type: 'string' }, maxItems: 64 },
          mode: { type: 'string', enum: ['direct', 'powershell', 'sh'] },
          cwd: { type: 'string' },
          timeout_ms: { type: 'integer', minimum: 500, maximum: 120000 },
          stdin: { type: 'string', maxLength: 65536 },
          max_bytes: { type: 'integer', minimum: 256, maximum: 4194304 },
        },
        ['command']
      ),
      handler: execHandler,
    },
    {
      name: 'ls',
      title: '列目录',
      description: '列出允许根目录内的目录项。最多 1000 条。',
      risk: 'low',
      readOnly: true,
      timeoutMs: 10000,
      responseMaxBytes: 1024 * 1024,
      inputSchema: schema({
        path: { type: 'string' },
        all: { type: 'boolean', default: true },
        long: { type: 'boolean', default: true },
      }),
      handler: lsHandler,
    },
    {
      name: 'read',
      title: '读文件',
      description: '读取允许根目录内的文件（utf8 或 base64），单次最多 4MB，可分段。',
      risk: 'medium',
      readOnly: true,
      timeoutMs: 15000,
      responseMaxBytes: 8 * 1024 * 1024,
      inputSchema: schema(
        {
          path: { type: 'string', minLength: 1 },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES },
          encoding: { type: 'string', enum: ['utf8', 'base64'] },
        },
        ['path']
      ),
      handler: readHandler,
    },
    {
      name: 'write',
      title: '写文件',
      description: '在允许的写根目录内原子写文件（overwrite/append/create），单次最多 16MB。',
      risk: 'high',
      readOnly: false,
      timeoutMs: 30000,
      responseMaxBytes: 64 * 1024,
      inputSchema: schema(
        {
          path: { type: 'string', minLength: 1 },
          content: { type: 'string' },
          encoding: { type: 'string', enum: ['utf8', 'base64'] },
          mode: { type: 'string', enum: ['overwrite', 'append', 'create'] },
          mkdirs: { type: 'boolean', default: true },
        },
        ['path', 'content']
      ),
      handler: writeHandler,
    },
    {
      name: 'mkdir',
      title: '创建目录',
      description: '在允许的写根目录内创建目录。',
      risk: 'medium',
      readOnly: false,
      timeoutMs: 15000,
      responseMaxBytes: 64 * 1024,
      inputSchema: schema(
        { path: { type: 'string', minLength: 1 }, recursive: { type: 'boolean', default: true } },
        ['path']
      ),
      handler: mkdirHandler,
    },
    {
      name: 'rm',
      title: '删除文件/目录',
      description: '删除允许写根目录内的路径；递归删除需要 recursive=true 且 confirm=true。',
      risk: 'high',
      readOnly: false,
      timeoutMs: 30000,
      responseMaxBytes: 64 * 1024,
      inputSchema: schema(
        {
          path: { type: 'string', minLength: 1 },
          recursive: { type: 'boolean', default: false },
          confirm: { type: 'boolean', default: false },
          force: { type: 'boolean', default: false },
        },
        ['path']
      ),
      handler: rmHandler,
    },
    {
      name: 'mv',
      title: '移动/重命名',
      description: '在允许写根目录内移动或重命名路径。',
      risk: 'medium',
      readOnly: false,
      timeoutMs: 30000,
      responseMaxBytes: 64 * 1024,
      inputSchema: schema(
        {
          from: { type: 'string', minLength: 1 },
          to: { type: 'string', minLength: 1 },
          overwrite: { type: 'boolean', default: false },
          mkdirs: { type: 'boolean', default: true },
        },
        ['from', 'to']
      ),
      handler: mvHandler,
    },
    {
      name: 'cp',
      title: '复制',
      description: '在允许写根目录内复制文件或目录。',
      risk: 'medium',
      readOnly: false,
      timeoutMs: 30000,
      responseMaxBytes: 64 * 1024,
      inputSchema: schema(
        {
          from: { type: 'string', minLength: 1 },
          to: { type: 'string', minLength: 1 },
          recursive: { type: 'boolean', default: false },
          overwrite: { type: 'boolean', default: false },
        },
        ['from', 'to']
      ),
      handler: cpHandler,
    },
    {
      name: 'stat',
      title: '路径信息',
      description: '返回文件/目录/符号链接的类型、大小、时间与权限位。',
      risk: 'low',
      readOnly: true,
      timeoutMs: 10000,
      responseMaxBytes: 64 * 1024,
      inputSchema: schema(
        { path: { type: 'string', minLength: 1 }, follow: { type: 'boolean', default: true } },
        ['path']
      ),
      handler: statHandler,
    },
    {
      name: 'khy.ask',
      title: '一次性提问 KhyOS',
      description:
        '后台启动 KhyOS 一次性 CLI（-p + --output-format json）回答一个问题，立即返回 202/job id。默认哨兵 allowlist、固定 system prompt、空 cwd、max_turns=1..8。',
      risk: 'medium',
      readOnly: false,
      timeoutMs: 5000,
      responseMaxBytes: 64 * 1024,
      inputSchema: schema(
        {
          question: { type: 'string', minLength: 1, maxLength: 8000 },
          cwd: { type: 'string', maxLength: 512 },
          max_turns: { type: 'integer', minimum: 1, maximum: 8, default: 4 },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000, default: 45000 },
          allowed_tools: { type: 'array', items: { type: 'string' }, maxItems: 32 },
        },
        ['question']
      ),
      handler: khyAskHandler,
    },
    {
      name: 'task.submit',
      title: '提交后台任务',
      description: '把任意本地工具（除 task.* 与 khy.ask）放进后台队列，立即返回 job id。',
      risk: 'medium',
      readOnly: false,
      timeoutMs: 5000,
      responseMaxBytes: 64 * 1024,
      inputSchema: schema(
        {
          tool: { type: 'string', minLength: 1 },
          args: { type: 'object' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 },
        },
        ['tool']
      ),
      handler: taskSubmitHandler,
    },
    {
      name: 'task.get',
      title: '查询任务',
      description: '按 id 返回后台任务的状态、结果或错误。',
      risk: 'low',
      readOnly: true,
      timeoutMs: 5000,
      responseMaxBytes: 2 * 1024 * 1024,
      inputSchema: schema({ id: { type: 'string', minLength: 8, maxLength: 64 } }, ['id']),
      handler: taskGetHandler,
    },
    {
      name: 'task.list',
      title: '任务列表',
      description: '列出最近的后台任务（默认 20 条）。',
      risk: 'low',
      readOnly: true,
      timeoutMs: 5000,
      responseMaxBytes: 512 * 1024,
      inputSchema: schema({ limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }),
      handler: taskListHandler,
    },
    {
      name: 'task.cancel',
      title: '取消任务',
      description: '取消排队中或运行中的后台任务。',
      risk: 'medium',
      readOnly: false,
      timeoutMs: 5000,
      responseMaxBytes: 64 * 1024,
      inputSchema: schema({ id: { type: 'string', minLength: 8, maxLength: 64 } }, ['id']),
      handler: taskCancelHandler,
    },
    {
      name: 'notify',
      title: '系统通知',
      description: '记录一条通知，并在 Windows 上尽力弹出 Toast；记录始终写入 notifications.jsonl。',
      risk: 'low',
      readOnly: false,
      timeoutMs: 15000,
      responseMaxBytes: 64 * 1024,
      inputSchema: schema(
        {
          title: { type: 'string', maxLength: 200 },
          message: { type: 'string', minLength: 1, maxLength: 4000 },
          level: { type: 'string', enum: ['info', 'warn', 'error'] },
        },
        ['message']
      ),
      handler: notifyHandler,
    },
    {
      name: 'clipboard.get',
      title: '读剪贴板',
      description: '读取系统剪贴板文本（Windows: PowerShell）。',
      risk: 'medium',
      readOnly: true,
      timeoutMs: 10000,
      responseMaxBytes: 2 * 1024 * 1024,
      inputSchema: EMPTY_SCHEMA,
      handler: clipboardGetHandler,
    },
    {
      name: 'clipboard.set',
      title: '写剪贴板',
      description: '把文本写入系统剪贴板（内容经 base64 环境变量传入，不拼命令行）。',
      risk: 'medium',
      readOnly: false,
      timeoutMs: 10000,
      responseMaxBytes: 64 * 1024,
      inputSchema: schema({ text: { type: 'string', maxLength: 1048576 } }, ['text']),
      handler: clipboardSetHandler,
    },
    {
      name: 'open',
      title: '打开文件/URL',
      description: '用系统默认程序打开允许根目录内的文件，或 http(s) URL。',
      risk: 'high',
      readOnly: false,
      timeoutMs: 15000,
      responseMaxBytes: 64 * 1024,
      inputSchema: schema({ target: { type: 'string', minLength: 1, maxLength: 4096 } }, ['target']),
      handler: openHandler,
    },
    {
      name: 'sys.info',
      title: '系统信息',
      description: '返回操作系统、CPU、内存、主机名、时区等只读信息。',
      risk: 'low',
      readOnly: true,
      timeoutMs: 5000,
      responseMaxBytes: 64 * 1024,
      inputSchema: EMPTY_SCHEMA,
      handler: sysInfoHandler,
    },
    {
      name: 'khy.status',
      title: 'KhyOS 状态',
      description: '返回 khy.js 路径是否可用、后台任务统计与最近任务。',
      risk: 'low',
      readOnly: true,
      timeoutMs: 5000,
      responseMaxBytes: 256 * 1024,
      inputSchema: EMPTY_SCHEMA,
      handler: khyStatusHandler,
    },
    {
      name: 'screen.shot',
      title: '本地截图',
      description: '截取本机主屏并保存为 PNG，返回路径/大小/sha256/尺寸（Windows 用 .NET，macOS 用 screencapture）。',
      risk: 'high',
      readOnly: false,
      timeoutMs: 30000,
      responseMaxBytes: 64 * 1024,
      inputSchema: schema({
        path: { type: 'string' },
        format: { type: 'string', enum: ['png'], default: 'png' },
      }),
      handler: screenShotHandler,
    },
  ];

  const defsByName = new Map(DEFS.map((def) => [def.name, def]));

  function descriptorOf(def) {
    return Object.freeze({
      name: def.name,
      title: def.title,
      description: def.description,
      risk: def.risk,
      readOnly: def.readOnly,
      timeoutMs: def.timeoutMs,
      responseMaxBytes: def.responseMaxBytes,
      inputSchema: def.inputSchema,
    });
  }

  const descriptors = DEFS.map(descriptorOf);

  /**
   * Execute one tool without the HTTP envelope. Throws BridgeError on failure.
   *
   * @param {string} name
   * @param {object} rawArgs
   * @param {{signal?: AbortSignal, requestId?: string, source?: string}} [ctx]
   * @returns {Promise<object>} tool data
   */
  async function executeTool(name, rawArgs, ctx = {}) {
    const def = defsByName.get(name);
    if (!def) fail('not_found', `未知工具：${String(name)}`);
    if (readOnly && !def.readOnly) {
      fail('forbidden_scope', `只读模式已启用，禁止调用 ${name}`);
    }
    if (ctx && ctx.signal && ctx.signal.aborted) {
      fail('timeout', '请求已取消');
    }
    const args = normalizeArgs(rawArgs);
    return def.handler(args, ctx || {});
  }

  /**
   * @param {string} name
   * @param {object} rawArgs
   * @param {{signal?:AbortSignal,requestId?:string,source?:string}} [ctx]
   * @returns {Promise<{ok:boolean,data:object}>}
   */
  async function call(name, rawArgs, ctx = {}) {
    stats.calls += 1;
    try {
      const data = await executeTool(name, rawArgs, ctx);
      stats.ok += 1;
      return { ok: true, data };
    } catch (err) {
      stats.errors += 1;
      throw err;
    }
  }

  function get(name) {
    const def = defsByName.get(name);
    return def ? descriptorOf(def) : null;
  }

  function list() {
    return descriptors.slice();
  }

  function status() {
    return {
      ok: true,
      version: LOCAL_VERSION,
      pid: process.pid,
      started_at: new Date(startedAt).toISOString(),
      uptime_s: Math.max(0, Math.round((clock() - startedAt) / 1000)),
      state_dir: stateDir,
      read_only: readOnly,
      exec_enabled: allowExec && !readOnly,
      tools: DEFS.map((def) => def.name),
      counters: { ...stats },
      tasks: jobStats(),
      roots: { write: writeRoots, read: readRoots },
      limits: {
        read_bytes: MAX_READ_BYTES,
        write_bytes: MAX_WRITE_BYTES,
        exec_timeout_ms: MAX_EXEC_TIMEOUT_MS,
      },
    };
  }

  function close() {
    for (const job of jobs.values()) {
      if (job.state === 'queued' || job.state === 'running') {
        job.state = 'cancelled';
        job.finished_at = nowIso();
        if (job.controller) {
          try {
            job.controller.abort();
          } catch {
            // ignore
          }
        }
        persistJob(job);
        notifyWaiters(job);
      }
    }
    return Promise.resolve();
  }

  function listNames() {
    return DEFS.map((def) => def.name);
  }

  loadJobs();

  return {
    call,
    executeTool,
    list,
    get,
    names: listNames,
    status,
    waitForJob,
    cancelJob,
    listJobs,
    jobStats,
    close,
    stateDir,
    writeRoots,
    readRoots,
    readOnly,
    allowExec,
    khyJs,
  };
}

module.exports = {
  LOCAL_VERSION,
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  DEFAULT_READ_LIMIT,
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
  MAX_OUTPUT_BYTES,
  createLocalTools,
  resolvePath,
  isInsideRoot,
  realpathLoose,
  runProcess,
};
