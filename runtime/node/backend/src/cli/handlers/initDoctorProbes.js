'use strict';

/**
 * initDoctorProbes.js — `khy doctor` 的探测底座（从 handlers/init.js 拆出）
 *
 * 本模块承载四件事，全部是「doctor 能不能在可接受时间内给出可信结论」的基础设施：
 *   1. 工具链可用性缓存（P0-6）：内存 + 磁盘两级缓存，带环境指纹与 TTL；
 *   2. 进程内异步探针（P0-6）：loopback 监听与 Ollama /api/tags，替代 `node -e` 子进程；
 *   3. 修复命令守卫（P1-6a）：doctor 打印的 `khy <cmd>` 必须真实注册过；
 *   4. AI key pool 探测（P1-6a）：以 apiKeyPool 真源为准，而不是 grep 六个 env 名。
 *
 * 拆分约束（CLAUDE.md §二 B3 外科手术式改动 / §一 R4 上帝文件门）：函数体**逐字节搬迁**，
 * 一行逻辑都不改。跨模块的只有两个可变槽位（`_activeToolchainCache` 与
 * `_doctorAsyncProbeCache`）——它们以 get/set 访问器暴露，调用点语义与拆分前一致。
 *
 * @module handlers/initDoctorProbes
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Doctor probe modes & toolchain availability cache (P0-6) ────────────────
// Measured 2026-10-12: `khy doctor` paid 21 SERIAL synchronous spawns inside
// runDoctorChecks() — 3x `reg query ...\Uninstall /s /v InstallLocation` (up to
// 5s each under load, from traeAdapter.detectInstallation), `opencode --version`
// (2.7-5.3s), `claude/codex --version`, `where pwsh|powershell|aider|codex`,
// `python3|python`, `git --version`, plus 4 `node -e` probes that re-load the
// whole module graph in a child. Worst observed total: 26s of pure spawn wait.
//
// Two fixes, both with a `=0` legacy path:
//   1. the `node -e` probes become in-process (`require.resolve` / `net` /
//      `http`) — no child process, no module-graph reload;
//   2. the toolchain availability group (Python/Git/Redis + the default-route
//      recommendation, which is what drags every gateway adapter's detect()
//      into the report) is cached in-process AND on disk under dataHome with a
//      15-minute TTL. The cache entry carries an environment signature
//      (PATH + install-marker directory mtimes + platform/arch) so a freshly
//      installed IDE invalidates it; `--full` and
//      KHY_DOCTOR_TOOLCHAIN_CACHE_MS=0 bypass it entirely.
//   3. `--quick` skips the whole group without probing at all.

const TOOLCHAIN_CACHE_VERSION = 1;
const TOOLCHAIN_CACHE_TTL_ENV = 'KHY_DOCTOR_TOOLCHAIN_CACHE_MS';
const TOOLCHAIN_CACHE_TTL_DEFAULT_MS = 15 * 60 * 1000;
const DOCTOR_LOOPBACK_TIMEOUT_MS = 1200;
const DOCTOR_OLLAMA_TIMEOUT_MS = 1500;

// Byte-identical to the previous child-process probe scripts, kept so the
// no-prefetch fallback path (direct runDoctorChecks() callers) behaves exactly
// as before.
const DOCTOR_LOOPBACK_PROBE_SCRIPT =
  'const n=require("net");const s=n.createServer();s.once("error",e=>{console.log("ERR:"+((e&&e.message)||e));process.exit(2)});s.listen(0,"127.0.0.1",()=>{s.close(()=>{console.log("OK");process.exit(0)})});setTimeout(()=>{console.log("ERR:loopback listen probe timed out (1.2s)");process.exit(3)},1200)';

// cmd -> probe result, per process.
const _toolchainProbeCache = new Map();

function _flagEnabled(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (value === true) {
    return true;
  }
  const raw = String(value).trim().toLowerCase();
  if (!raw) {
    return false;
  }
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * Resolve the doctor probe mode.
 *
 *   quick — skip the toolchain availability probe group entirely (no spawn at
 *           all). `--quick` / KHY_DOCTOR_QUICK=1. Composes with `--fast` (local
 *           only) and with the full path.
 *   full  — ignore the probe cache and re-probe everything (legacy path).
 *           `--no-cache` / KHY_DOCTOR_TOOLCHAIN_CACHE_MS=0.
 *
 *   Why not `--full` on the command line: `--full` is ALREADY a global launcher
 *   mode flag (`bin/khy.js:1753` strips it from argv before routing, so doctor
 *   never sees it — measured: `khy doctor --deep --full` arrived here as
 *   `{"deep":true}`). Reusing it would have been exactly the "printed command
 *   that does nothing" failure this guard exists for, so the CLI spelling is
 *   `--no-cache`. `options.full` is still honoured for programmatic callers.
 *
 * `--no-cache` wins over `--quick`.
 * @param {object} [options]
 * @param {string[]} [args]
 * @returns {{ quick: boolean, full: boolean }}
 */
function _resolveDoctorProbeMode(options = {}, args = []) {
  const argv = Array.isArray(args)
    ? args.map((a) =>
        String(a || '')
          .trim()
          .toLowerCase()
      )
    : [];
  const opts = options || {};
  const full =
    _flagEnabled(opts.full) ||
    _flagEnabled(opts['no-cache']) ||
    _flagEnabled(opts.noCache) ||
    _flagEnabled(process.env.KHY_DOCTOR_FULL) ||
    argv.includes('no-cache') ||
    argv.includes('nocache');
  const quick =
    !full &&
    (_flagEnabled(opts.quick) ||
      _flagEnabled(process.env.KHY_DOCTOR_QUICK) ||
      argv.includes('quick'));
  return { quick, full };
}

function _toolchainCacheTtlMs() {
  const parsed = Number.parseInt(String(process.env[TOOLCHAIN_CACHE_TTL_ENV] ?? ''), 10);
  // 0 disables caching (always re-probe); negative/NaN → default.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : TOOLCHAIN_CACHE_TTL_DEFAULT_MS;
}

/**
 * dataHome-derived cache path. Never hardcodes a drive: dataHome resolves
 * KHY_DATA_HOME / KHY_PROJECT_DATA_HOME / the portable pointer itself.
 * @returns {string} '' when dataHome is unavailable (cache simply off).
 */
function _toolchainCacheFilePath() {
  try {
    const { getDataHome } = require('../../utils/dataHome');
    return path.join(getDataHome(), 'cache', 'doctor-toolchain.json');
  } catch {
    return '';
  }
}

/**
 * Cheap environment fingerprint. A newly installed IDE either lands on PATH or
 * creates a directory under one of these roots, both of which change the
 * signature and invalidate the cache. It is a heuristic on purpose: the exact
 * install-marker set lives in the gateway adapters (not owned here), so
 * `--full` / `KHY_DOCTOR_TOOLCHAIN_CACHE_MS=0` remain the authoritative
 * bypass.
 * @returns {object}
 */
function _toolchainSignature() {
  const markers = {};
  const roots = [];
  const localAppData = String(process.env.LOCALAPPDATA || '').trim();
  const appData = String(process.env.APPDATA || '').trim();
  if (localAppData) {
    roots.push(path.join(localAppData, 'Programs'), localAppData);
  }
  if (appData) {
    roots.push(appData);
  }
  try {
    const home = os.homedir();
    if (home) {
      roots.push(home);
    }
  } catch {
    /* homedir is optional for the signature */
  }
  for (const dir of roots) {
    try {
      markers[dir] = fs.statSync(dir).mtimeMs;
    } catch {
      markers[dir] = 0;
    }
  }
  return {
    platform: process.platform,
    arch: process.arch,
    pathEnv: String(process.env.PATH || process.env.Path || ''),
    markers,
  };
}

function _readToolchainCache(signature, ttlMs) {
  if (ttlMs <= 0) {
    return null;
  }
  const file = _toolchainCacheFilePath();
  if (!file) {
    return null;
  }
  try {
    if (!fs.existsSync(file)) {
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || raw.version !== TOOLCHAIN_CACHE_VERSION) {
      return null;
    }
    const at = Number(raw.at || 0);
    if (!Number.isFinite(at) || Date.now() - at >= ttlMs) {
      return null;
    }
    if (JSON.stringify(raw.signature) !== JSON.stringify(signature)) {
      return null;
    }
    if (!raw.entries || typeof raw.entries !== 'object') {
      return null;
    }
    return raw.entries;
  } catch {
    return null;
  }
}

function _writeToolchainCache(entries, signature) {
  const file = _toolchainCacheFilePath();
  if (!file) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        version: TOOLCHAIN_CACHE_VERSION,
        at: Date.now(),
        signature,
        entries,
      }),
      'utf-8'
    );
    fs.renameSync(tmp, file);
  } catch {
    /* cache write is best-effort — a read-only dataHome must never fail doctor */
  }
}

/**
 * Is this process running under a test runner? The disk cache is bypassed there:
 * a suite that mocks `execFileSync` would otherwise persist mocked probe results
 * into the real dataHome and leak them into the next (non-mocked) run.
 * @returns {boolean}
 */
function _isTestRunnerProcess() {
  if (process.env.JEST_WORKER_ID !== undefined) {
    return true;
  }
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  return nodeEnv === 'test';
}

/**
 * Per-run cache context. Loads the disk entries once and flushes once, so a
 * doctor run pays at most one small read + one small write.
 * @param {{ quick?: boolean, full?: boolean }} [mode]
 */
function _createToolchainCacheContext(mode = {}) {
  const quick = !!mode.quick;
  const full = !!mode.full;
  const ttlMs = _toolchainCacheTtlMs();
  const diskEnabled = !quick && !full && ttlMs > 0 && !_isTestRunnerProcess();
  const signature = diskEnabled ? _toolchainSignature() : null;
  const entries = diskEnabled ? _readToolchainCache(signature, ttlMs) || {} : {};
  let dirty = false;
  // full = 「忽略缓存、重新探测」（--no-cache / options.full）。磁盘缓存靠 diskEnabled
  // 关掉了，但**进程内**记忆（_toolchainProbeCache）先于磁盘缓存被查，且从不失效——
  // 于是同一进程里的第二次 --no-cache 仍会拿上一轮的探测结果，doctor 报的是过期可用性。
  // 这里把记忆一并清掉，--no-cache 才是它自己文档里写的「bypass it entirely」。
  if (full) {
    _toolchainProbeCache.clear();
  }
  return {
    quick,
    /**
     * @param {string} key
     * @param {() => any} probe
     * @returns {any} probe result, or undefined in quick mode
     */
    get(key, probe) {
      if (quick) {
        return undefined;
      }
      const mem = _toolchainProbeCache.get(key);
      if (mem !== undefined) {
        return mem;
      }
      if (Object.prototype.hasOwnProperty.call(entries, key)) {
        _toolchainProbeCache.set(key, entries[key]);
        return entries[key];
      }
      const result = probe();
      let serializable = result;
      try {
        JSON.stringify(result);
      } catch {
        serializable = undefined;
      }
      if (serializable !== undefined) {
        entries[key] = serializable;
        _toolchainProbeCache.set(key, serializable);
        dirty = true;
      } else {
        _toolchainProbeCache.set(key, result);
      }
      return result;
    },
    flush() {
      if (!diskEnabled || !dirty) {
        return;
      }
      _writeToolchainCache(entries, signature);
      dirty = false;
    },
  };
}

// The context of the doctor run currently in progress. A module-level slot (not
// a parameter) keeps `_runLocalFastChecks()` and the rest of runDoctorChecks()
// readable while still letting a direct `runDoctorChecks()` call behave exactly
// as before: with no active context, `_cachedProbe()` just runs the probe.
let _activeToolchainCache = null;

/**
 * Probe through the active toolchain cache (no-op passthrough when none).
 * @param {string} key
 * @param {() => any} probe
 * @returns {any}
 */
function _cachedProbe(key, probe) {
  const ctx = _activeToolchainCache;
  if (!ctx) {
    return probe();
  }
  return ctx.get(key, probe);
}

// ── In-process async doctor probes (P0-6) ──────────────────────────────────
// `runDoctorChecks()` must stay synchronous (direct callers exist, including
// tests), so the two inherently-async probes are pre-fetched here — in THIS
// process, with no child spawning — and consumed synchronously afterwards.
// With no pre-fetch (a direct `runDoctorChecks()` call) the original
// `node -e` subprocess path is used, byte-for-byte.

let _doctorAsyncProbePromise = null;
let _doctorAsyncProbeCache = null;

function _probeLoopbackListenInProcess(timeoutMs = DOCTOR_LOOPBACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: 'timeout', message: 'loopback listen probe timed out' }),
      timeoutMs
    );
    if (timer.unref) {
      timer.unref();
    }
    try {
      const net = require('net');
      const server = net.createServer();
      server.once('error', (err) => {
        const code = String((err && err.code) || '');
        const reason = code === 'EACCES' || code === 'EPERM' ? 'blocked' : 'error';
        finish({ ok: false, reason, message: String((err && err.message) || err) });
      });
      server.listen(0, '127.0.0.1', () => {
        server.close(() => finish({ ok: true, output: 'OK' }));
      });
    } catch (err) {
      finish({ ok: false, reason: 'error', message: String((err && err.message) || err) });
    }
  });
}

function _probeOllamaTagsInProcess(host, timeoutMs = DOCTOR_OLLAMA_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', tags: [] }), timeoutMs);
    if (timer.unref) {
      timer.unref();
    }
    try {
      const http = require('http');
      const url = new URL(`${String(host || '').replace(/\/+$/, '')}/api/tags`);
      const req = http.get(
        url,
        { timeout: timeoutMs },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              const names = (parsed.models || []).map((m) => m && m.name).filter(Boolean);
              finish({ ok: true, output: `TAGS:${JSON.stringify(names)}`, tags: names });
            } catch (err) {
              finish({
                ok: false,
                reason: 'error',
                tags: [],
                message: String((err && err.message) || err),
              });
            }
          });
        }
      );
      req.on('error', (err) =>
        finish({ ok: false, reason: 'error', tags: [], message: String((err && err.message) || err) })
      );
      req.on('timeout', () => {
        req.destroy();
        finish({ ok: false, reason: 'timeout', tags: [] });
      });
    } catch (err) {
      finish({ ok: false, reason: 'error', tags: [], message: String((err && err.message) || err) });
    }
  });
}

/**
 * Kick off (once) the in-process async probes. Memoized: calling it twice
 * returns the same promise, and the resolved value lands in
 * `_doctorAsyncProbeCache` for the synchronous runDoctorChecks() to read.
 * @returns {Promise<{ loopback: object, ollama: object }>}
 */
function _prefetchDoctorAsyncProbes() {
  if (_doctorAsyncProbePromise) {
    return _doctorAsyncProbePromise;
  }
  _doctorAsyncProbePromise = (async () => {
    let ollamaHost = '';
    try {
      const { OLLAMA_HOST } = require('../../constants/serviceDefaults');
      ollamaHost = OLLAMA_HOST;
    } catch {
      /* fall back to an empty host — the probe just reports offline */
    }
    const [loopback, ollama] = await Promise.all([
      _probeLoopbackListenInProcess().catch(() => ({ ok: false, reason: 'error' })),
      _probeOllamaTagsInProcess(ollamaHost).catch(() => ({ ok: false, reason: 'error', tags: [] })),
    ]);
    _doctorAsyncProbeCache = { loopback, ollama };
    return _doctorAsyncProbeCache;
  })();
  return _doctorAsyncProbePromise;
}

// ── Fix-command guard (P1-6a) ───────────────────────────────────────────────
// `khy ai config` was printed as the fix for "no AI key configured" while
// refusing to serve in non-interactive mode — the user followed the printed
// instruction and got a second error. Every fix string doctor emits is now
// checked against the real command registry; a miss is reported locally and
// NEVER blocks the run.

/**
 * Extract the leading `khy <command>` token from a fix string.
 * @param {string} fix
 * @returns {string} '' when the fix carries no khy command
 */
function _extractKhyCommand(fix) {
  const text = String(fix || '');
  const match = text.match(/\bkhy\s+([a-z][a-z0-9-]*)/i);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Is `khy <cmd>` a registered command? Two sources, because neither alone is
 * complete (measured: `khy db` and `khy server` are real router cases but absent
 * from `cli/commands/registry.js`, which would make the guard cry wolf):
 *   • `constants/commandSchema.getRouterCommandNames()` — the router's own verb
 *     table (260 entries, a leaf with no circular-require risk);
 *   • `cli/commands/registry` — the metadata registry, for verbs that only live
 *     there.
 * Fail-open: an unavailable source means "cannot tell", which must not block.
 * @param {string} cmd
 * @returns {boolean}
 */
function _isRegisteredKhyCommand(cmd) {
  const name = String(cmd || '').trim().toLowerCase();
  if (!name) {
    return true;
  }
  try {
    const schema = require('../../constants/commandSchema');
    if (schema && typeof schema.getRouterCommandNames === 'function') {
      if (schema.getRouterCommandNames().includes(name)) {
        return true;
      }
    }
  } catch {
    /* fail-open */
  }
  try {
    const registry = require('../commands/registry');
    if (registry && typeof registry.getCommandNames === 'function') {
      return registry.getCommandNames().includes(name);
    }
    if (registry && typeof registry.hasHandler === 'function') {
      return registry.hasHandler(name);
    }
  } catch {
    /* fail-open */
  }
  return true;
}

/**
 * Collect fix strings whose `khy <command>` is not registered. Local check only.
 * @param {Array<object>} checks decorated check items
 * @returns {Array<{ label: string, fix: string, command: string }>}
 */
function _collectUnregisteredFixCommands(checks) {
  const out = [];
  for (const item of checks || []) {
    const fix = item && typeof item.fix === 'string' ? item.fix : '';
    if (!fix) {
      continue;
    }
    const command = _extractKhyCommand(fix);
    if (command && !_isRegisteredKhyCommand(command)) {
      out.push({ label: String(item.label || ''), fix, command });
    }
  }
  return out;
}

// ── AI key pool (P1-6a) ─────────────────────────────────────────────────────
// `hasAiKey` used to grep 6 hardcoded env names out of backend/.env and never
// looked at the apiKeyPool — whose real source is `<dataHome>/api_keys.json`
// (the file `khy gateway status` points at, and where the built-in OpenCode Zen
// free key lives). Result: one report line said "no AI key configured" while
// another said the gateway was ready on opencode-zen.

/**
 * Resolve the apiKeyPool file path without hardcoding anything: the owning
 * service is asked first, dataHome (KHY_DATA_HOME / KHY_PROJECT_DATA_HOME
 * derived) second.
 * @returns {string}
 */
function _resolveApiKeyPoolPath() {
  try {
    const pool = require('../../services/apiKeyPool');
    if (pool && typeof pool.getPoolFilePath === 'function') {
      const resolved = String(pool.getPoolFilePath() || '');
      if (resolved) {
        return resolved;
      }
    }
  } catch {
    /* fall through to the dataHome derivation */
  }
  try {
    const { getDataHome } = require('../../utils/dataHome');
    return path.join(getDataHome(), 'api_keys.json');
  } catch {
    return '';
  }
}

/**
 * Does the apiKeyPool hold at least one usable (non-placeholder) key?
 * @returns {{ ok: boolean, providers: string[] }}
 */
function _apiKeyPoolHasKeys() {
  const poolPath = _resolveApiKeyPoolPath();
  if (!poolPath) {
    return { ok: false, providers: [] };
  }
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
  } catch {
    return { ok: false, providers: [] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, providers: [] };
  }
  const providers = [];
  for (const [name, entries] of Object.entries(data)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    const usable = entries.filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        !entry.placeholder &&
        String(entry.key || '').trim().length > 0
    );
    if (usable.length > 0) {
      providers.push(String(name));
    }
  }
  return { ok: providers.length > 0, providers };
}

/**
 * Fix text for a missing AI key. TTY gets the interactive configurator; a
 * non-interactive shell (CI, piped output) gets the guide, which cannot refuse
 * to serve the way `khy ai config` does.
 * @returns {string}
 */
function _buildAiKeyFixText() {
  const interactive = !!(process.stdout && process.stdout.isTTY) && !!(process.stdin && process.stdin.isTTY);
  return interactive
    ? '运行 khy gateway config 配置密钥（或 khy gateway guide 查看指引）'
    : '运行 khy gateway guide 查看配置指引（非交互环境无法运行 khy gateway config）';
}

// ── 跨模块可变槽位访问器 ────────────────────────────────────────────────
// 这两个槽位原本是 init.js 的模块级变量。拆分后它们住在这里，init.js 通过
// 访问器读写，语义与拆分前逐字节一致。

/**
 * @returns {object|null} 当前生效的工具链缓存上下文（无则为 null）
 */
function getActiveToolchainCache() {
  return _activeToolchainCache;
}

/**
 * @param {object|null} ctx 新的工具链缓存上下文
 */
function setActiveToolchainCache(ctx) {
  _activeToolchainCache = ctx;
}

/**
 * @returns {object|null} 进程内异步探针的结果缓存（未预取时为 null）
 */
function getDoctorAsyncProbeCache() {
  return _doctorAsyncProbeCache;
}

module.exports = {
  DOCTOR_LOOPBACK_PROBE_SCRIPT,
  _flagEnabled,
  _resolveDoctorProbeMode,
  _toolchainCacheTtlMs,
  _toolchainCacheFilePath,
  _toolchainSignature,
  _readToolchainCache,
  _writeToolchainCache,
  _isTestRunnerProcess,
  _createToolchainCacheContext,
  _cachedProbe,
  _probeLoopbackListenInProcess,
  _probeOllamaTagsInProcess,
  _prefetchDoctorAsyncProbes,
  _extractKhyCommand,
  _isRegisteredKhyCommand,
  _collectUnregisteredFixCommands,
  _resolveApiKeyPoolPath,
  _apiKeyPoolHasKeys,
  _buildAiKeyFixText,
  getActiveToolchainCache,
  setActiveToolchainCache,
  getDoctorAsyncProbeCache,
};
