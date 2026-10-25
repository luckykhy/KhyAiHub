'use strict';

/**
 * gitExecutableDetector — IO 层：检测并缓存可用的 git 可执行文件路径。
 *
 * 职责：结合 gitExecutableResolver（纯叶子策略）与实际 IO（fs.existsSync / spawnSync），
 * 检测系统中可用的 git，优先 Git Bash（Windows），回退到系统 PATH。
 *
 * 缓存策略（两层）：
 * 1. 进程内缓存：首次检测后缓存结果（进程生命周期）。
 * 2. 跨进程磁盘缓存：长 TTL（默认 5 分钟）写入 `<dataHome>/cache/git-executable.json`，
 *    key 取 git 二进制自身的 mtime+size（**不按 cwd 分 key**，故任何 cwd 下的冷进程都能
 *    复用）；读后仍做一次 statSync/existsSync 校验，校验失败即回落重新解析。
 *
 * 降级链：
 * 1. Windows: Git Bash 典型路径（含便携根推导）→ PATH 扫描（existsSync，零派生 ~1ms）
 *    → spawn 'git --version' 校验 → null（无可用 git）
 * 2. Unix: PATH 扫描 → 'git --version' 校验 → null
 *
 * PATH 扫描只在「PATH 未命中」时才保留一次 `--version` 派生，用于排除 WindowsApps
 * 式的存根可执行文件。
 *
 * 开关（每个都留 `=0` 回退路径，回到历史行为）：
 * - `KHY_GIT_EXEC_DISK_CACHE=0`   → 关闭跨进程磁盘缓存
 * - `KHY_GIT_EXEC_PATH_SCAN=0`    → 关闭 PATH existsSync 扫描（保留 `--version` 探针）
 * - `KHY_GIT_EXEC_CACHE_TTL_MS=0` → 视为关闭磁盘缓存（读恒 miss、写跳过）
 *
 * 不变量：
 * - 永不抛错（fail-soft）
 * - 返回 null 表示无可用 git（调用方应优雅处理）
 */

const { spawnSync } = require('child_process');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('fs');
const os = require('os');
const path = require('path');

const resolver = require('./gitExecutableResolver');

// 进程级缓存：{ gitPath: string|null, checked: boolean }
let _cache = { gitPath: null, checked: false };

// ── 跨进程磁盘缓存 ──────────────────────────────────────────────────
// 冷进程（`khy status` 等一次性命令每次都是新进程）不再重复解析：读一个文件即可。
const GIT_EXEC_DISK_CACHE_FILE = 'git-executable.json';
const GIT_DISK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟（git 二进制极少变动）
const GIT_DISK_CACHE_TTL_MAX_MS = 10 * 60 * 1000; // 上限 10 分钟

/**
 * Resolve a tri-state env flag ('1'/true/on vs '0'/false/off), fail-soft.
 * @param {*} raw
 * @param {boolean} fallback
 * @returns {boolean}
 */
function _envFlag(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
}

/**
 * Parse the disk-cache TTL (ms). Unset → default; `0`/invalid → 0 (cache off).
 * @param {Object} env
 * @returns {number}
 */
function _diskCacheTtlMs(env) {
  const raw = env && env.KHY_GIT_EXEC_CACHE_TTL_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return GIT_DISK_CACHE_TTL_MS;
  }
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.min(parsed, GIT_DISK_CACHE_TTL_MAX_MS);
}

/**
 * True when the caller injected test doubles (platform/env/fs/spawn) — in that mode
 * the disk cache and the PATH scan are skipped so behaviour stays byte-identical.
 * @param {Object} options
 * @returns {boolean}
 */
function _isInjectedMode(options) {
  const probes = [
    options._existsSync,
    options._spawnSync,
    options._statSync,
    options.env,
    options.platform,
  ];
  return probes.some(Boolean);
}

/**
 * Read-only data-home resolution (mirrors hudRenderer / activeProviderSnapshot):
 * KHY_DATA_HOME → ~/.khy/.location.json (dataHome) → ~/.khy. Never mkdirs, never throws.
 * @param {Object} env
 * @returns {string}
 */
function _diskCacheDir(env) {
  if (env && env.KHY_DATA_HOME) {
    return path.join(String(env.KHY_DATA_HOME), 'cache');
  }
  try {
    const pointer =
      (env && env.KHY_LOCATION_FILE) || path.join(os.homedir(), '.khy', '.location.json');
    const obj = JSON.parse(readFileSync(pointer, 'utf-8'));
    if (obj && typeof obj === 'object' && obj.dataHome) {
      return path.join(String(obj.dataHome), 'cache');
    }
  } catch {
    /* no/corrupt pointer → default home */
  }
  return path.join(os.homedir(), '.khy', 'cache');
}

/**
 * Read the cross-process disk cache. A hit is only honoured when the cached binary
 * still exists AND its mtime+size are unchanged (git was upgraded/replaced → miss).
 * @param {Object} env
 * @param {number} ttlMs
 * @param {Function} _stat
 * @returns {string|null}
 */
function _readDiskCache(env, ttlMs, _stat) {
  if (!ttlMs || ttlMs <= 0) {
    return null;
  }
  try {
    const file = path.join(_diskCacheDir(env), GIT_EXEC_DISK_CACHE_FILE);
    const obj = JSON.parse(readFileSync(file, 'utf-8'));
    if (!obj || typeof obj.gitPath !== 'string' || !obj.gitPath.trim()) {
      return null;
    }
    if (Date.now() - Number(obj.t || 0) >= ttlMs) {
      return null;
    }
    const st = _stat(obj.gitPath);
    if (!st || typeof st.isFile !== 'function' || !st.isFile()) {
      return null;
    }
    if (Math.round(Number(st.mtimeMs)) !== Math.round(Number(obj.mtimeMs))) {
      return null;
    }
    if (Number(st.size) !== Number(obj.size)) {
      return null;
    }
    return obj.gitPath;
  } catch {
    return null;
  }
}

/**
 * Persist a resolved git path keyed by the binary's own mtime+size (not by cwd).
 * Written via tmp + rename so concurrent cold processes never observe a partial file.
 * @param {Object} env
 * @param {number} ttlMs
 * @param {string} gitPath
 * @param {Function} _stat
 * @returns {void}
 */
function _writeDiskCache(env, ttlMs, gitPath, _stat) {
  if (!ttlMs || ttlMs <= 0 || !gitPath || gitPath === 'git') {
    return;
  }
  let tmp = null;
  try {
    const st = _stat(gitPath);
    if (!st || typeof st.isFile !== 'function' || !st.isFile()) {
      return;
    }
    const dir = _diskCacheDir(env);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, GIT_EXEC_DISK_CACHE_FILE);
    tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ t: Date.now(), gitPath, mtimeMs: st.mtimeMs, size: st.size }),
      'utf-8'
    );
    renameSync(tmp, file);
    tmp = null;
  } catch {
    /* best effort */
  } finally {
    if (tmp) {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
    }
  }
}

/**
 * Scan `PATH` for a git executable with existsSync only (zero process spawn, ~1ms).
 * First hit wins; on Windows `git.exe` is preferred over an extension-less `git`.
 * @param {Object} env
 * @param {string} platform
 * @param {Function} _exists
 * @returns {string|null}
 */
function _scanPathForGit(env, platform, _exists) {
  const raw = env && (env.PATH || env.Path || env.path);
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  const names = platform === 'win32' ? ['git.exe', 'git'] : ['git'];
  const dirs = raw
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"+|"+$/g, ''))
    .filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (_existsSafe(candidate, _exists)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * existsSync wrapper that never throws (fail-soft: a bad PATH entry is skipped).
 * @param {string} candidate
 * @param {Function} _exists
 * @returns {boolean}
 */
function _existsSafe(candidate, _exists) {
  try {
    return Boolean(_exists(candidate));
  } catch {
    return false;
  }
}

/**
 * 检测可用的 git 可执行文件路径（带缓存）。
 *
 * 策略：
 * 1. 已缓存 → 直接返回
 * 2. 跨进程磁盘缓存（长 TTL）→ statSync 校验 mtime+size 后返回
 * 3. 遍历候选路径（Windows 优先 Git Bash），逐个检测：
 *    a. 显式路径（非 'git'）→ existsSync 检查
 *    b. 'git'（系统 PATH）→ PATH 扫描（existsSync，零派生）；未命中才 spawn
 *       'git --version' 校验
 * 4. 首个可用路径 → 缓存（进程内 + 磁盘）并返回
 * 5. 全部失败 → 缓存 null
 *
 * @param {Object} [options]
 * @param {boolean} [options.refresh] - 强制刷新缓存
 * @param {string} [options.platform] - 平台（默认 process.platform，测试注入用）
 * @param {Object} [options.env] - 环境变量（默认 process.env，测试注入用）
 * @param {Function} [options._existsSync] - fs.existsSync 注入（测试用）
 * @param {Function} [options._spawnSync] - child_process.spawnSync 注入（测试用）
 * @param {Function} [options._statSync] - fs.statSync 注入（测试用）
 * @param {boolean} [options.diskCache] - 是否允许跨进程磁盘缓存（默认 true）
 * @returns {string|null} git 可执行文件路径，null 表示无可用 git
 */
function detectGitExecutable(options = {}) {
  // 缓存命中（且非强制刷新）
  if (_cache.checked && !options.refresh) {
    return _cache.gitPath;
  }

  const rt = _resolveRuntime(options);

  let resolved = null;
  try {
    // Cross-process cache: a cold process resolves in one statSync instead of a
    // candidate walk + spawn. Skipped on `refresh` and on an explicit
    // KHY_GIT_BASH_PATH override, which must win without waiting out the TTL.
    const overridden =
      typeof rt.env.KHY_GIT_BASH_PATH === 'string' && rt.env.KHY_GIT_BASH_PATH.trim() !== '';
    if (rt.ttlMs > 0 && !rt.refresh && !overridden) {
      resolved = _readDiskCache(rt.env, rt.ttlMs, rt._stat);
    }
    if (!resolved) {
      const candidates = resolver.resolveGitCandidates({
        platform: rt.platform,
        env: rt.env,
      });
      resolved = _resolveFromCandidates(candidates, rt);
    }
  } catch {
    // 任何异常 → fail-soft，返回 null
    resolved = null;
  }

  _cache = { gitPath: resolved, checked: true };
  // 'git' 是裸命令名，没有可 stat 的二进制 → 不写磁盘缓存
  if (resolved && resolved !== 'git') {
    _writeDiskCache(rt.env, rt.ttlMs, resolved, rt._stat);
  }
  return resolved;
}

/**
 * Normalise caller options into the runtime bundle used by the resolvers below.
 * Injected (test) mode keeps the historical code path: disk cache + PATH scan are
 * production-only optimisations and are switched off there.
 * @param {Object} options
 * @returns {Object} runtime bundle
 */
function _resolveRuntime(options) {
  const env = options.env || process.env;
  const injected = _isInjectedMode(options);
  const diskCacheOn =
    !injected && options.diskCache !== false && _envFlag(env.KHY_GIT_EXEC_DISK_CACHE, true);
  return {
    env,
    platform: options.platform,
    refresh: Boolean(options.refresh),
    _exists: options._existsSync || existsSync,
    _spawn: options._spawnSync || spawnSync,
    _stat: options._statSync || statSync,
    ttlMs: diskCacheOn ? _diskCacheTtlMs(env) : 0,
    pathScanOn: !injected && _envFlag(env.KHY_GIT_EXEC_PATH_SCAN, true),
  };
}

/**
 * Walk the ordered candidate list and return the first usable git path.
 * @param {string[]} candidates
 * @param {Object} opts
 * @returns {string|null}
 */
function _resolveFromCandidates(candidates, opts) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === 'git') {
      const systemGit = _resolveSystemGit(opts);
      if (systemGit) {
        return systemGit;
      }
      continue;
    }
    // 显式路径 → existsSync 检查
    if (opts._exists(trimmed)) {
      return trimmed;
    }
  }
  // 全部候选失败 → null（负结果不写磁盘，避免 git 装好后被长期挡住）
  return null;
}

/**
 * Resolve the `'git'` (system PATH) fallback: zero-spawn PATH scan first, then —
 * only when the scan misses — one `git --version` probe.
 * @param {Object} opts
 * @returns {string|null}
 */
function _resolveSystemGit(opts) {
  if (opts.pathScanOn) {
    const scanned = _scanPathForGit(opts.env, opts.platform || process.platform, opts._exists);
    if (scanned) {
      return scanned;
    }
  }
  if (_isGitAvailableInPath(opts._spawn)) {
    return 'git';
  }
  return null;
}

/**
 * 通过 'git --version' 检查 git 是否在系统 PATH 中可用。
 * @param {Function} _spawn - spawnSync 注入（测试用）
 * @returns {boolean}
 */
function _isGitAvailableInPath(_spawn) {
  try {
    const result = _spawn('git', ['--version'], {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return result && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * 清除进程内缓存（测试用，或运行时强制重新检测）。
 *
 * 注意：不清磁盘缓存——磁盘条目自带 mtime+size + TTL 校验，git 被换掉/删掉会自动失效；
 * 要强制完整重解析请用 `detectGitExecutable({ refresh: true })`。
 */
function clearCache() {
  _cache = { gitPath: null, checked: false };
}

/**
 * 获取当前缓存状态（调试/测试用）。
 * @returns {{gitPath: string|null, checked: boolean}}
 */
function getCacheState() {
  return { ..._cache };
}

/**
 * 构建无可用 git 时的友好提示信息。
 * @param {Object} [options]
 * @param {string} [options.platform]
 * @returns {string}
 */
function buildNoGitMessage(options = {}) {
  const platform =
    options.platform || (typeof process !== 'undefined' ? process.platform : 'linux');

  if (platform === 'win32') {
    return [
      '未检测到 git。请安装 Git for Windows 后重试：',
      '  下载：https://git-scm.com/download/win',
      '  或使用包管理器：winget install Git.Git',
      '',
      '如已安装但路径非标准，可设置环境变量：',
      '  set KHY_GIT_BASH_PATH=C:\\your\\path\\to\\git.exe',
    ].join('\n');
  }

  return [
    '未检测到 git。请安装 git 后重试：',
    '  Debian/Ubuntu: sudo apt-get install git',
    '  macOS: brew install git  或  xcode-select --install',
  ].join('\n');
}

module.exports = {
  detectGitExecutable,
  clearCache,
  getCacheState,
  buildNoGitMessage,
  // Long TTL (default 5 min, env-tunable, `=0` disables) for the cross-process
  // git-executable disk cache. Single source of truth for consumers such as
  // gitContextService / hudRenderer so the value is not re-declared per file.
  GIT_DISK_CACHE_TTL_MS,
  GIT_DISK_CACHE_TTL_MAX_MS,
};
