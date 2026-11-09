'use strict';
/**
 * pythonCommandResolver.js — resolve a bare MCP stdio `python` launcher to a
 * portable interpreter target.
 *
 * A configured MCP server (e.g. deepseek-eyes) is usually declared with a bare
 * `python` command. On a relocated/portable install the interpreter that has
 * the package installed lives in a venv under the install root (or in
 * VIRTUAL_ENV), NOT on the generic PATH — and a stale absolute path baked in on
 * a previous machine (e.g. `C:\khy-os\tools\deepseek-eyes\.venv\Scripts\
 * python.exe`) ENOENTs here.
 *
 * This leaf is PURE + injectable (fs/PATH-scan are passed in) so it is trivially
 * unit-testable and side-effect free. Resolution order for a bare launcher:
 *   VIRTUAL_ENV → PYTHON_PATH → install-root venv candidates → PATH scan.
 * An explicit (absolute) path is used as-configured but flagged `stale` when it
 * does not exist, so callers can fail fast with an actionable hint instead of a
 * silent ENOENT. A PATH-scan hit is TRUSTED instead: existsSync answers "can the
 * link target be stat'ed", not "is the entry on PATH", and the WindowsApps
 * reparse point throws EACCES on stat — that false negative once surfaced as a
 * bogus `stale` flag for a path `where python` had just returned.
 * describeStubLaunchFailure turns the other half of the same machine shape (the
 * Store alias stub exiting 9009 without a real interpreter behind it) into an
 * actionable diagnosis.
 */

const BARE = new Set(['python', 'python3', 'py', 'python.exe']);

// Windows Store app-execution-alias stubs live under ...\Microsoft\WindowsApps\
// and exit 9009 without ever launching a real interpreter (measured: spawn
// produces no 'error' event, just `exit code 9009`). The segment keeps its
// trailing separator so the directory itself is not mistaken for a stub, and is
// lowercase because PATH echoes each entry in whatever casing it was installed
// with — a case-sensitive match would miss ...\Local\microsoft\windowsapps\.
const STUB_EXIT_CODE = 9009;
const STUB_DIR_SEGMENT = '\\microsoft\\windowsapps\\';

function isBareLauncher(command) {
  const c = String(command || '').trim();
  if (!c) return false;
  // A bare launcher has no path separator (relative name / PATH lookup).
  if (/[\\/]/.test(c)) return false;
  const base = c.replace(/\.exe$/i, '').toLowerCase();
  return BARE.has(base) || base.startsWith('python');
}

function venvPythonVirtualEnv(virtualEnv, platform) {
  const isWin = platform === 'win32';
  return isWin
    ? `${virtualEnv}\\Scripts\\python.exe`
    : `${virtualEnv}/bin/python`;
}

/**
 * @param {string} command - The configured stdio command (bare or a path).
 * @param {object} [ctx]
 * @param {string} [ctx.platform]      process.platform
 * @param {object} [ctx.env]           env source (VIRTUAL_ENV / PYTHON_PATH)
 * @param {(p:string)=>boolean} [ctx.fsExists]  existence probe (injected)
 * @param {(name:string)=>(string|null)} [ctx.pathScan]  PATH lookup (injected)
 * @param {string[]} [ctx.venvCandidates] install-root venv python paths to try
 * @returns {{command:string, source:string, exists:boolean, stale:boolean, portable:boolean}}
 */
function resolveStdioCommand(command, ctx = {}) {
  const env = ctx.env || {};
  const fsExists = typeof ctx.fsExists === 'function' ? ctx.fsExists : () => false;
  const pathScan = typeof ctx.pathScan === 'function' ? ctx.pathScan : () => null;
  const venvCandidates = Array.isArray(ctx.venvCandidates) ? ctx.venvCandidates : [];
  const platform = ctx.platform || 'win32';
  const cmd = String(command || '').trim();

  if (!isBareLauncher(cmd)) {
    // Explicit path: use as configured, but surface staleness for fail-fast.
    const exists = fsExists(cmd);
    return { command: cmd, source: 'as_configured', exists, stale: !exists, portable: false };
  }

  // 1. VIRTUAL_ENV (the active venv's interpreter).
  if (env.VIRTUAL_ENV) {
    const cand = venvPythonVirtualEnv(env.VIRTUAL_ENV, platform);
    if (fsExists(cand)) {
      return { command: cand, source: 'virtualenv', exists: true, stale: false, portable: true };
    }
  }

  // 2. PYTHON_PATH (explicit interpreter override).
  if (env.PYTHON_PATH) {
    const exists = fsExists(env.PYTHON_PATH);
    if (exists) {
      return { command: env.PYTHON_PATH, source: 'python_path', exists: true, stale: false, portable: true };
    }
  }

  // 3. Install-root venv candidates (e.g. tools/deepseek-eyes/.venv).
  for (const cand of venvCandidates) {
    if (cand && fsExists(cand)) {
      return { command: cand, source: 'venv_candidate', exists: true, stale: false, portable: true };
    }
  }

  // 4. PATH scan for the bare launcher.
  const scanned = pathScan(cmd);
  if (scanned) {
    // Trust the scan: a where/which hit is on THIS machine's PATH by definition
    // and does not ENOENT at spawn (the Store stub exits 9009 instead).
    // existsSync here answers the wrong question — it stats the link target, and
    // the WindowsApps reparse point throws EACCES (measured: existsSync → false,
    // statSync → EACCES for a path `where python` had just returned).
    return { command: scanned, source: 'path_scan', exists: true, stale: false, portable: true };
  }

  // Nothing resolvable — keep the bare name (the spawn will surface a clear ENOENT).
  return { command: cmd, source: 'bare_unresolved', exists: false, stale: false, portable: false };
}

/**
 * True when the command points at a Windows Store app-execution-alias stub
 * (e.g. `...\Microsoft\WindowsApps\python.exe`) rather than a real interpreter.
 * Casing-insensitive, both slash spellings accepted.
 */
function isStoreAliasStub(command) {
  const c = String(command || '')
    .replace(/\//g, '\\')
    .toLowerCase();
  return c.includes(STUB_DIR_SEGMENT);
}

/**
 * True when the spawn target is a python interpreter (bare launcher or a path
 * whose basename is one). The stale hint in index.js names python-specific
 * remedies (VIRTUAL_ENV / PYTHON_PATH), so it must not fire for anything else:
 * 'npx' / 'node' / 'uvx' / 'docker' also land in the as_configured branch, and
 * fs.existsSync on a bare name is false by construction (it is a PATH lookup,
 * not a stat) — warning there hands python advice to a non-python server.
 */
function isPythonCommand(command) {
  const c = String(command || '').trim();
  if (!c) return false;
  if (isBareLauncher(c)) return true;
  const base = c.split(/[\\/]/).pop().toLowerCase();
  return /^(?:pythonw?|py)(?:\d+(?:\.\d+)?)?(?:\.exe)?$/.test(base);
}

/**
 * Actionable diagnosis for a startup exit caused by a Store alias stub, or null
 * when the exit is not that shape (not a stub, or a different code). The caller
 * only has command + exit code, and ANY python MCP server — including a
 * user-configured one — can land here, so the wording stays generic: no server
 * name, module name or API key name. The reverse assertion lives in
 * pythonCommandResolver.test.js; reintroducing a specific noun breaks it.
 *
 * The wording must not claim WHERE the path came from: the stub is reachable
 * both from a PATH scan and from an explicit mcp.json entry, and only the
 * caller knows which — asserting "from PATH" would be false for a configured
 * stub and would send the user to fix PATH instead of the config file.
 * @param {string} command - The interpreter that was spawned
 * @param {number|string|null} exitCode - Child exit code (null when signalled)
 * @returns {string|null}
 */
function describeStubLaunchFailure(command, exitCode) {
  if (Number(exitCode) !== STUB_EXIT_CODE) return null;
  if (!isStoreAliasStub(command)) return null;
  return (
    `启动即退出（code ${STUB_EXIT_CODE}）：解释器 ${command} 是 Windows 商店应用执行别名存根，` +
    '没有可用的真 Python 指向。' +
    '修复：未装过 Python 就用 python.org 安装器安装并勾选 Add python.exe to PATH，' +
    '或在微软商店安装 Python 后运行一次激活别名；' +
    '装过仍报错则把真实 python.exe 所在目录加进 PATH，' +
    '或到 设置→应用→应用执行别名 关闭 python/python3，' +
    '或把该 server 的 command 改成真实 python.exe 路径。' +
    '重连前确认该解释器已安装本 MCP server 所需的 Python 包与 API key。'
  );
}

module.exports = {
  resolveStdioCommand,
  isBareLauncher,
  isStoreAliasStub,
  isPythonCommand,
  describeStubLaunchFailure,
};
