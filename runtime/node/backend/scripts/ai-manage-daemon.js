#!/usr/bin/env node
/**
 * @pattern Command
 */

/**
 * Detached runner for AI management stack.
 * - Starts AI management backend server
 * - Optionally starts ai-frontend dev server on an available port
 * - Exposes a tiny control API for page lifecycle heartbeat
 * - Auto-shuts down on idle to release occupied ports
 */

// Windows: hide the console window of every child process this daemon (and its
// large dependency tree) spawns — otherwise each git/node/port-probe spawn pops
// and destroys a console window, causing the "black box flicker" on `khychat`
// startup. Must run BEFORE any `require('child_process')` below (and before the
// aiManagementServer require, whose tree captures child_process). Reuses the
// central patch installed at bin/khy.js — win32-only, gated KHY_WINDOWS_SPAWN_HIDE
// (default-on), idempotent, fail-soft.
try {
  require('../src/bootstrap/windowsSpawnHardening').installWindowsSpawnHardening();
} catch {
  /* best effort */
}

// Make the sibling ai-backend tree resolve its bare npm deps (+ @khy/shared) in
// a bundled pip install by adding services/backend/node_modules as a NODE_PATH
// fallback. Must run BEFORE the aiManagementServer / workflowRunWorker requires
// below (their subtrees cross-require ../../../ai-backend/src/...). Fallback-only
// + idempotent + fail-soft — a no-op in dev where hoisting already resolves.
try {
  require('../src/bootstrap/aiBackendModuleResolve').ensureAiBackendResolvable();
} catch {
  /* best effort */
}

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const aiManagementServer = require('../src/services/aiManagementServer');
// Workflow run worker: this daemon is the long-lived serving process that also
// enqueues `workflow_runs` (via ai-backend's router mounted in the management
// server). Without a worker in-process nothing claims those rows, so runs sit
// in `queued` forever. The atomic claim makes co-running with server.js safe.
// Fail-soft: a broken workflow module must not crash the daemon at require time
// (before main() can run) — degrade to no-worker and let the management stack
// (API + frontend) still come up. Downstream users null-check workflowRunWorker.
let workflowRunWorker = null;
try {
  ({ workflowRunWorker } = require('../src/services/workflow'));
} catch (err) {
  _log(
    `[ai-manage-daemon] workflow 模块加载失败，已降级为无 worker 模式（API/前端照常启动）: ${err && err.message ? err.message : String(err)}`
  );
}
const { getDataHome, getLegacyDataHome, isPortableDeployment } = require('../src/utils/dataHome');
// 复用优先的前端发现：认到已在运行的 KHY 前端就接上，不再起第二个（见该模块头部契约）。
const { discoverKhyFrontend, describePortOwner } = require('../src/services/aiFrontendLocator');

// [DESIGN-ARCH-169] P3: every daemon log line carries a wall-clock stamp — the
// multi-run timeline in ai_manage_daemon.log used to be unreconstructible (病灶 5).
// All daemon output funnels through these three wrappers; message bodies keep the
// `[ai-manage-daemon]` prefix for grep compatibility. Function declarations hoist,
// so the module-load failure path above can already use them.
function _stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function _log(msg, ...rest) {
  // eslint-disable-next-line no-console
  console.log(`[${_stamp()}] ${msg}`, ...rest);
}

function _logWarn(msg, ...rest) {
  // eslint-disable-next-line no-console
  console.warn(`[${_stamp()}] ${msg}`, ...rest);
}

function _logError(msg, ...rest) {
  // eslint-disable-next-line no-console
  console.error(`[${_stamp()}] ${msg}`, ...rest);
}

const KHY_DIR = getDataHome();
const RUNTIME_FILE = path.join(KHY_DIR, 'ai_manage_runtime.json');
const LEGACY_RUNTIME_FILE = path.join(getLegacyDataHome(), 'ai_manage_runtime.json');
const LOG_DIR = path.join(KHY_DIR, 'logs');

// Portable installs keep ALL state under the install root (getDataHome()), so
// we must NOT also write the runtime file to the legacy system-drive home
// (~/.khyquant on C:) — that leaked state to C: on every GC tick.
function _runtimeFiles() {
  if (isPortableDeployment()) return [RUNTIME_FILE];
  return [RUNTIME_FILE, LEGACY_RUNTIME_FILE];
}

const DEFAULT_API_PORT = 9090;
// 单一真源：serviceDefaults.WEB_FRONTEND_PORT（同一 env AI_FRONTEND_PORT、同一默认值）。
// 它是**基准端口**，不是「前端一定在这个端口」——实际端口由「复用探测」或「空闲探测」决定，
// 并随 ai_manage_runtime.json 广播给所有消费者。
const DEFAULT_FRONTEND_PORT = require('../src/constants/serviceDefaults').WEB_FRONTEND_PORT;
// Web 后端的基准端口，单一真源同上（server.js 的 PORT 语义，漂移由 runtime 文件兜底）。
const DEFAULT_WEB_BACKEND_PORT = require('../src/constants/serviceDefaults').BACKEND_PORT;
const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_SESSION_TTL_MS = 35_000;
const DEFAULT_STARTUP_GRACE_MS = 10 * 60_000;
// 前端端口等待预算。[快速启动] web 后端与 vite 现已**并行**冷启（见 main 的
// provisionWebBackend/resolveFrontend 重叠），首次启动时 vite 的 predev + 依赖预打包会和
// server.js 的 require 树抢 CPU/IO，端口绑定可能慢于串行时代。waitPortOpen 一到就返回
// （快时无成本），故把上限从 30s 放宽到 90s，避免并行争用把 vite 误判失败退回静态站。
const DEFAULT_FRONTEND_WAIT_MS = 90_000;
const GC_TICK_MS = 5000;

let controlServer = null;
let controlPort = 0;
const controlToken = crypto.randomBytes(18).toString('hex');

let apiPort = 0;
let frontendPort = 0;
let frontendHost = '127.0.0.1';
let frontendUrl = '';
let frontendAvailable = false;
let frontendManaged = false;
let frontendProc = null;
// Web 后端（services/backend/server.js）：管理台的 auth / api-keys / 用户管理 /
// /ws/cross-platform 都在它身上。managed=true 表示是本会话拉起的，stop 时回收；
// 复用来的（本来就在跑）不动、也不回收。
let webBackendPort = 0;
let webBackendManaged = false;
let webBackendProc = null;

const sessions = new Map(); // sid -> lastSeenAt
let startupAt = Date.now();
let lastActiveAt = Date.now();
let seenAnySession = false;
// Wall-clock of the most recent HTTP request the API server answered, refreshed
// by the request hook wired in start(). Serving traffic is productive work, so
// it refreshes the idle clock independently of the browser-side session bridge —
// otherwise a tab whose /open /ping never reaches the control port (sandboxed or
// cross-origin-restricted guests, offline networks) lets a fully serving daemon
// classify itself as idle and self-terminate with ERR_CONNECTION_REFUSED.
let lastRequestAt = 0;
let gcTimer = null;
let shuttingDown = false;

// [DESIGN-ARCH-169] P1a: startup phase state. Single in-process source of truth —
// broadcast to consumers via writeRuntime() (file) and buildStatusPayload() (/status).
// The CLI reads it to show stage progress instead of a silent 180s black box.
const PHASE_STARTING = 'starting';
const PHASE_READY = 'ready';
const DEFAULT_STARTUP_WATCHDOG_MS = 300_000;
let startupPhase = PHASE_STARTING;
let phaseDetail = '';
let phaseSince = Date.now();
let startupWatchdogTimer = null;

// Liveness probes: zero-arg functions returning truthy when the daemon is doing
// work that must NOT be reaped as idle (e.g. the workflow worker is mid-run).
// A truthy probe counts as activity in the GC loop — it refreshes lastActiveAt
// so a long-running headless task is never killed mid-flight.
const activityProbes = [];

function addActivityProbe(fn) {
  if (typeof fn === 'function') activityProbes.push(fn);
}

function anyProbeActive() {
  for (const probe of activityProbes) {
    try {
      if (probe()) return true;
    } catch {
      /* a broken probe must never block the GC loop */
    }
  }
  return false;
}

/**
 * Mark an answered API request as daemon activity.
 *
 * Called from the API server's request hook. Deliberately does NOT touch
 * `seenAnySession` or the session map: those mean "a browser tab registered
 * itself", which stays the source of the reason label (`idle` vs
 * `startup-timeout`). Request activity only widens what counts as "not idle".
 */
function noteRequestActivity() {
  lastRequestAt = Date.now();
}

function getState() {
  return {
    sessions: new Map(sessions),
    seenAnySession,
    lastActiveAt,
    lastRequestAt,
    shuttingDown,
    controlPort,
    apiPort,
    frontendPort,
  };
}

// Test seam: reset the module-level reaping state without touching servers.
function _resetForTests() {
  sessions.clear();
  seenAnySession = false;
  shuttingDown = false;
  activityProbes.length = 0;
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
  }
  stopStartupWatchdog();
  startupPhase = PHASE_STARTING;
  phaseDetail = '';
  phaseSince = Date.now();
  if (controlServer) {
    try {
      controlServer.close();
    } catch {
      /* best effort */
    }
    controlServer = null;
    controlPort = 0;
  }
  startupAt = Date.now();
  lastActiveAt = Date.now();
  lastRequestAt = 0;
}

// [DESIGN-ARCH-169] P1a: phase transition + independent startup watchdog.
// Why independent: the GC self-termination loop only starts at the very END of
// the serial startup chain — a daemon wedged before that point would live
// forever, squatting on 9090/3000 and poisoning every subsequent `khy chat` run.
// The watchdog is armed before the chain and covers exactly that window
// (default 300s > the ~206s worst-case serial chain, §1.3 对账).
function _setStartupPhase(phase, detail) {
  if (phase !== startupPhase || detail !== phaseDetail) {
    phaseSince = Date.now();
  }
  startupPhase = phase;
  phaseDetail = detail || '';
  writeRuntime();
}

function getStartupPhaseState() {
  return { phase: startupPhase, phaseDetail, phaseSince };
}

function _resolveStartupWatchdogMs() {
  const n = parseInt(process.env.AI_MANAGE_STARTUP_WATCHDOG_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STARTUP_WATCHDOG_MS;
}

// Pure decision core (unit seam, 提案 §7 断言 2/3): does the startup watchdog
// fire for this phase/elapsed? Returns the shutdown reason key or null.
function _evalStartupWatchdog(_nowMs, phase, elapsedMs, watchdogMs) {
  if (phase === PHASE_READY) return null;
  return elapsedMs >= watchdogMs ? 'startup-watchdog' : null;
}

function startStartupWatchdog({ watchdogMs = _resolveStartupWatchdogMs() } = {}) {
  if (startupWatchdogTimer) return;
  const armedAt = Date.now();
  const tickMs = Math.max(50, Math.min(5000, Math.floor(watchdogMs / 4)));
  startupWatchdogTimer = setInterval(() => {
    if (shuttingDown) return;
    if (startupPhase === PHASE_READY) {
      // Startup completed — the watchdog retires; the GC loop owns the daemon now.
      clearInterval(startupWatchdogTimer);
      startupWatchdogTimer = null;
      return;
    }
    const reason = _evalStartupWatchdog(
      Date.now(),
      startupPhase,
      Date.now() - armedAt,
      watchdogMs
    );
    if (reason) {
      clearInterval(startupWatchdogTimer);
      startupWatchdogTimer = null;
      _log(
        `[ai-manage-daemon] 启动看门狗触发: ${watchdogMs}ms 内未进入 ready 阶段（最后状态 ${phaseDetail || startupPhase}），自杀释放端口`
      );
      shutdown(reason).catch(() => process.exit(1));
    }
  }, tickMs);
  startupWatchdogTimer.unref();
}

function stopStartupWatchdog() {
  if (startupWatchdogTimer) {
    clearInterval(startupWatchdogTimer);
    startupWatchdogTimer = null;
  }
}

// The t≈0 sequence main() runs before the serial chain. Exported so tests can
// prove "runtime file exists with phase='starting' within 1s" (§7 断言 1)
// without spawning the real management stack.
async function beginStartupPhase() {
  createControlServer();
  await listenControlServer();
  startStartupWatchdog();
  _setStartupPhase(PHASE_STARTING, 'web-backend');
}

// Bootstrap auth pushed by the CLI (`khy chat` → POST /auth/bootstrap) and
// fetched by the manage page (`main.js` → GET /auth/bootstrap) to auto-login
// the browser tab. The control token alone only proves the tab was opened by
// the launcher; this payload carries the actual API session token.
let authBootstrap = null;

function parseIntArg(argv, name, fallback) {
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  const raw = argv[idx + 1];
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function parsePortArg(argv, name, fallback) {
  const n = parseIntArg(argv, name, fallback);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return fallback;
  return n;
}

function parseStringArg(argv, name, fallback = '') {
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  const raw = argv[idx + 1];
  if (!raw || raw.startsWith('--')) return fallback;
  return String(raw).trim() || fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeRuntime(extra = {}) {
  const payload = {
    pid: process.pid,
    controlPort,
    controlToken,
    apiPort,
    frontendPort,
    frontendHost,
    frontendUrl,
    frontendAvailable,
    frontendManaged,
    frontendPid: frontendProc && frontendProc.pid ? frontendProc.pid : null,
    webBackendPort,
    webBackendManaged,
    webBackendPid: webBackendProc && webBackendProc.pid ? webBackendProc.pid : null,
    sessions: sessions.size,
    startupAt,
    updatedAt: Date.now(),
    // [DESIGN-ARCH-169] P1a: phase rides with EVERY write (GC tick included) so
    // consumers never see a runtime file without it — one in-process source, no
    // per-callsite bookkeeping (§6 反模式: phase 只活一个真源).
    phase: startupPhase,
    phaseDetail,
    phaseSince,
    ...extra,
  };
  const json = JSON.stringify(payload, null, 2);
  for (const filePath of _runtimeFiles()) {
    try {
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath, json, 'utf-8');
    } catch {
      // best effort
    }
  }
}

function clearRuntime() {
  for (const filePath of _runtimeFiles()) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // best effort
    }
  }
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // On Windows, process.kill(pid, 0) throws EPERM when the caller has a
    // different integrity level (e.g. elevated vs non-elevated). Treat EPERM
    // as "alive" to avoid false negatives.
    if (e && e.code === 'EPERM') return true;
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 5000) {
  const started = Date.now();
  let attempts = 0;
  const maxAttempts = 20;
  while (Date.now() - started < timeoutMs && attempts < maxAttempts) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 250));
    attempts++;
  }
  return !isPidAlive(pid);
}

async function terminatePid(pid) {
  if (!isPidAlive(pid)) return;
  // Reuse the shared cross-platform tree-kill primitive (taskkill /T /F on Windows,
  // process-group signal + SIGKILL escalation on Unix) so this daemon and the CLI
  // reaper share one behavior; keep the local wait-for-exit semantics on top.
  const { safeKill } = require('../src/tools/platformUtils');
  try {
    safeKill(pid, 'SIGTERM', 3000);
  } catch {
    /* best effort */
  }
  const exited = await waitForExit(pid, 4000);
  if (!exited) {
    try {
      safeKill(pid, 'SIGKILL', 0);
    } catch {
      /* best effort */
    }
    await waitForExit(pid, 1500);
  }
}

function canBindPort(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function isPortOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(900);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function findAvailablePort(host, startPort, maxScan = 60) {
  for (let p = startPort; p < startPort + maxScan; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await canBindPort(host, p)) return p;
  }
  return null;
}

async function waitPortOpen(host, port, timeoutMs = DEFAULT_FRONTEND_WAIT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortOpen(host, port)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function sendJson(res, code, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Khy-Token',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString();
    });
    req.on('end', () => resolve(raw));
    req.on('error', () => resolve(''));
  });
}

function readAuthToken(req, urlObj) {
  // Accept the control token from either header spelling. The daemon's own API
  // historically used `x-khy-token`; the lifecycle module's `requestShutdown`
  // sends `X-Control-Token`. Supporting both avoids a silent 401 that makes a
  // lifecycle-initiated shutdown appear to succeed while the daemon keeps running.
  const headerToken = String(
    req.headers['x-khy-token'] || req.headers['x-control-token'] || ''
  ).trim();
  if (headerToken) return headerToken;
  return String(urlObj.searchParams.get('token') || '').trim();
}

// Quote a token for cmd.exe when spawning with shell:true on Windows. Tokens that are empty
// or contain whitespace / cmd metacharacters are wrapped in double quotes (inner quotes
// escaped); simple tokens are passed through to keep the command line readable.
function quoteForCmd(token) {
  const s = String(token);
  if (s !== '' && !/[\s"&|<>^()%!]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

// The dev server is spawned through cmd.exe on Windows. cmd's own diagnostic
// messages (e.g. "'npm.cmd' is not recognized") are emitted in the OEM codepage
// (cp936 on zh-CN) while Vite's stream is UTF-8; redirecting that mixed byte
// stream straight to a file yields invalid UTF-8. So capture the child's pipes
// and normalize per line: strict UTF-8 when valid, otherwise decoded from the
// OEM codepage — guaranteeing a UTF-8-clean log. Newline-splitting is safe for
// both UTF-8 and GBK (0x0a never appears inside their multi-byte sequences).
function _decodeConsoleLine(lineBuf) {
  try {
    return new TextDecoder('utf8', { fatal: true }).decode(lineBuf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(lineBuf);
    } catch {
      return lineBuf.toString('utf8');
    }
  }
}

function _pipeConsoleToUtf8Log(stream, outStream) {
  if (!stream) return;
  let pending = Buffer.alloc(0);
  const flushLine = (buf) => outStream.write(_decodeConsoleLine(buf) + '\n');
  stream.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    let nl;
    while ((nl = pending.indexOf(0x0a)) !== -1) {
      flushLine(pending.subarray(0, nl));
      pending = pending.subarray(nl + 1);
    }
  });
  stream.on('end', () => {
    if (pending.length) flushLine(pending);
    pending = Buffer.alloc(0);
  });
}

// Resolve `bin` (already carrying its extension) against PATH, Windows included.
// Returns '' when absent — PATH is the only place npm can come from, and a
// portable install may not have one at all (see startFrontendProcess).
function findOnPath(bin) {
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')]
    : [''];
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        const full = path.join(dir, bin + ext);
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* not in this PATH entry */
      }
    }
  }
  return '';
}

// 工作区依赖会提升到仓库根 node_modules，所以从前端目录逐级向上找。
function findViteBin(frontendDir) {
  let dir = path.resolve(frontendDir);
  for (let depth = 0; depth <= 6; depth += 1) {
    const candidate = path.join(dir, 'node_modules', 'vite', 'bin', 'vite.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

// npm runs `predev` (sync-md-vendor) before `dev`; the npm-free path owes that one step.
// The hook is fail-soft by design, so a sync problem must not gate the dev server.
function runPredev(frontendDir) {
  const script = path.join(frontendDir, 'scripts', 'sync-md-vendor.mjs');
  if (!fs.existsSync(script)) return;
  try {
    execFileSync(process.execPath, [script], { cwd: frontendDir, stdio: 'ignore', timeout: 60000 });
  } catch {
    /* vite serves whatever public/vendor already holds */
  }
}

async function startFrontendProcess({ host, basePort, frontendDir, apiPort: backendPort, webBackendPort }) {
  const pkgPath = path.join(frontendDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { ok: false, reason: `未找到 package.json: ${pkgPath}` };
  }

  const port = await findAvailablePort(host, basePort);
  if (!port) {
    return { ok: false, reason: `未找到可用端口 (起始 ${basePort})` };
  }

  const isWin = process.platform === 'win32';
  // npm is only a *runner* here — the dev server itself is node_modules/vite. A portable
  // install can ship a bare node.exe with no npm anywhere on PATH, and then this whole
  // management stack used to lose its frontend to `'npm.cmd' 不是内部或外部命令` while the
  // deps were in fact already installed. So: use npm when it exists (it also runs the
  // package's predev hook), otherwise drive the vite binary directly.
  const npmBin = findOnPath(isWin ? 'npm.cmd' : 'npm');
  const viteBin = npmBin ? '' : findViteBin(frontendDir);
  if (!npmBin && !viteBin) {
    return {
      ok: false,
      reason: `启动前端 dev server (端口 ${port}) 失败: PATH 上没有 npm，且 ${frontendDir} 向上找不到 node_modules/vite`,
    };
  }

  const args = [
    '--prefix',
    frontendDir,
    'run',
    'dev',
    '--',
    '--host',
    host,
    '--port',
    String(port),
  ];

  ensureDir(LOG_DIR);
  const logFile = path.join(LOG_DIR, 'ai_frontend_dev.log');
  // Capture via a WriteStream so we can transcode the child's mixed OEM/UTF-8
  // byte stream into UTF-8-clean lines before it hits disk (see helpers above).
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  // Node hardening (CVE-2024-27980) makes spawning a .cmd/.bat shim such as npm.cmd without a
  // shell throw `spawn EINVAL` on Windows. Run through a shell on Windows and quote each token
  // defensively — the frontend dir may contain spaces (e.g. C:\Users\Some Name\...).
  // The vite path spawns a real .exe with an argv array, so it needs no shell at all.
  const useShell = isWin && Boolean(npmBin);
  const command = useShell
    ? ['npm.cmd', ...args].map(quoteForCmd).join(' ')
    : (npmBin ? 'npm' : process.execPath);
  const spawnArgs = useShell ? [] : (npmBin ? args : [viteBin, '--host', host, '--port', String(port)]);
  const spawnCwd = npmBin ? path.resolve(frontendDir, '..') : frontendDir;
  if (!npmBin) runPredev(frontendDir);

  let child;
  try {
    child = spawn(command, spawnArgs, {
      cwd: spawnCwd,
      detached: !isWin,
      shell: useShell,
      env: {
        ...process.env,
        AI_FRONTEND_PORT: String(port),
        VITE_AI_API_BASE_URL: '',
        // Browser should call same-origin "/api" to avoid CORS when host is not localhost.
        // Vite dev server proxies these paths to the management backend target.
        VITE_AI_PROXY_TARGET: `http://127.0.0.1:${backendPort}`,
        // [快速启动] 并行化：显式把 web 后端目标钉成守护进程为其**严格选定**的端口
        // (见 provisionWebBackend 的 PORT_AUTO_RETRY=1)。backendDiscovery 第 1 优先级即
        // 命中 VITE_API_TARGET、不再读 backend_runtime.json 也不再探测，于是 vite 无需
        // 等 web 后端 listen 就能启动——/api 与 daemon 命名空间各自钉到确定端口，
        // 页面早期打来的 /api 请求在 server.js 就绪前短暂失败后即自愈(启动期页面本就在加载)。
        ...(webBackendPort
          ? { VITE_API_TARGET: `http://127.0.0.1:${webBackendPort}` }
          : {}),
        BROWSER: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // A dev-server spawn failure must never crash the daemon — degrade to static dist upstream.
    logStream.destroy();
    return {
      ok: false,
      reason: `启动前端 dev server (端口 ${port}) 失败: ${describeSystemError(err)}`,
      logFile,
    };
  }
  _pipeConsoleToUtf8Log(child.stdout, logStream);
  _pipeConsoleToUtf8Log(child.stderr, logStream);
  // Async spawn errors are emitted, not thrown; absorb them so they don't become an
  // uncaughtException. The port-wait below turns a dead child into a clean fallback.
  child.on('error', () => {
    /* surfaced via port-wait timeout + ai_frontend_dev.log */
  });
  child.on('close', () => logStream.end());

  const ready = await waitPortOpen(host, port);
  if (!ready) {
    if (child.pid) await terminatePid(child.pid);
    return { ok: false, reason: `前端端口 ${port} 启动超时`, logFile };
  }

  return { ok: true, child, port, logFile };
}

// ── Web 后端（services/backend/server.js）随栈保障 ─────────────────────────
// 管理台同时吃两个后端：本守护进程（工作流/市场等守护端接口）与 web 后端
// （auth / api-keys / 用户管理 / /ws/cross-platform）。web 后端不在跑时，浏览器侧
// 表现为 /api/users 等批量失败、/ws/cross-platform 反复握手失败。所以栈启动时先
// 保障它：健康探测命中 → 复用（绝不动别人的进程）；基准端口被非 KHY 服务占用 →
// 自动换下一个空闲端口再启动。真实端口由 server.js 自己落盘 backend_runtime.json，
// 前端代理发现自动跟随漂移。
// 冷启动实测从 2.6s 到 45s+ 都有（杀毒/冷缓存/Python 解析都在启动链上），
// 上限放宽到 120s；到点仍未就绪才停止并优雅回退 —— 绝不硬杀仍在推进的启动。
const WEB_BACKEND_WAIT_MS = 120_000;
// 冷启动时 server.js 的后台初始化可能短暂拖慢响应（实测一次就绪后仍拖了 20s+），
// 单次探测给 3s 余量，总时长 45s 不变 —— 超时也只是回退，绝不硬杀正在推进的工作。
const WEB_BACKEND_HEALTH_TIMEOUT_MS = 3000;

// 探**存活探针** /healthz，而不是 /api/health。
//
// 为什么换：/api/health 是**就绪（readiness）**语义 —— 它内部 await
// sequelize.authenticate()，DB 未就绪时返 503；而 server.js 的后台初始化
// （DB 连接/迁移/种子/AKShare 标的同步）又串在 listen 之后。于是「server.js
// 已能接连接」与「/api/health 返 200」之间隔了几十秒，本函数一直在等后者，
// 把这段后台初始化时间变成了 daemon 串行链上的**纯等待**（实测 92s）。
//
// /healthz 只回答「这个进程还能不能接连接」（server.js:683），永远 200、不查
// 任何后端依赖 —— 它才是「web 后端可用」的正确判据。业务就绪由 /api/ready
// 单独反映，不在这里阻塞启动链。
const WEB_BACKEND_PROBE_PATH = '/healthz';

function probeWebBackendHealth(port, timeoutMs = WEB_BACKEND_HEALTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let req;
    try {
      req = http.get(`http://127.0.0.1:${port}${WEB_BACKEND_PROBE_PATH}`, { timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 500));
      });
    } catch {
      resolve(false);
      return;
    }
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitWebBackendHealthy(port, timeoutMs = WEB_BACKEND_WAIT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    if (await probeWebBackendHealth(port)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * 保障管理台依赖的 web 后端可用：健康就复用，不在就启动（端口被占则漂移）。
 * 只回收自己拉起的进程（managed=true）；复用的实例归它的原启动方所有。
 *
 * [快速启动] 返回 `{ port, managed, child, ready }`：`port`/`child` 在**决定端口并
 * spawn 之后立即**给出（复用探测 + canBindPort 都是毫秒级），`ready` 是 web 后端健康
 * 等待的 Promise。调用方据此可让 vite 与 server.js 并行启动——不必等 `ready`。
 * spawn 时钉 `PORT_AUTO_RETRY=1`：让 server.js 严格绑定我们选定的端口、绝不自动顺延，
 * 于是「我们告诉 vite 的端口」== 「server.js 实际监听的端口」，显式 VITE_API_TARGET
 * 才不会有漂移错钉（否则 server.js 顺延后 vite 加载期已冻结 /api 目标，无法自愈）。
 */
async function provisionWebBackend({ requestedPort }) {
  const backendRoot = path.resolve(__dirname, '..');
  const serverScript = path.join(backendRoot, 'server.js');
  if (!fs.existsSync(serverScript)) {
    _log(
      '[ai-manage-daemon] 未找到 web 后端 (server.js)：管理台的用户/渠道/跨平台同步接口将不可用'
    );
    return { port: 0, managed: false, child: null, ready: Promise.resolve(false) };
  }

  // 先问基准端口：健康的 web 后端直接复用（可能是 REPL / 手动 npm start 起的）。
  if (await probeWebBackendHealth(requestedPort)) {
    _log(
      `[ai-manage-daemon] Web 后端已在运行: http://127.0.0.1:${requestedPort} —— 复用现有实例，未新起进程`
    );
    return { port: requestedPort, managed: false, child: null, ready: Promise.resolve(true) };
  }

  // 基准端口被别的进程占着（不健康但绑不上）→ 漂移；空闲 → 用基准端口。
  let port = requestedPort;
  if (!(await canBindPort('127.0.0.1', requestedPort))) {
    let owner = '';
    try {
      owner = await describePortOwner(requestedPort);
    } catch {
      owner = '';
    }
    const drifted = await findAvailablePort('127.0.0.1', requestedPort + 1);
    if (!drifted) {
      _log(
        owner
          ? `[ai-manage-daemon] ${owner}，且其后无空闲端口：Web 后端未启动，用户/渠道/跨平台同步接口暂不可用`
          : `[ai-manage-daemon] 端口 ${requestedPort} 起无空闲端口：Web 后端未启动，用户/渠道/跨平台同步接口暂不可用`
      );
      return { port: 0, managed: false, child: null, ready: Promise.resolve(false) };
    }
    _log(
      owner
        ? `[ai-manage-daemon] ${owner}：Web 后端改用端口 ${drifted} 启动`
        : `[ai-manage-daemon] 端口 ${requestedPort} 被未知进程占用：Web 后端改用端口 ${drifted} 启动`
    );
    port = drifted;
  }

  _log(`[ai-manage-daemon] 启动 Web 后端 (server.js)：端口 ${port}，等待 /healthz 就绪…`);
  ensureDir(LOG_DIR);
  const logFile = path.join(LOG_DIR, 'web_backend.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  let child;
  try {
    child = spawn(process.execPath, [serverScript], {
      cwd: backendRoot,
      env: {
        ...process.env,
        PORT: String(port),
        // 严格单绑：守护进程已确认该端口空闲并把它钉给 vite，禁止 server.js 顺延，
        // 否则 vite 加载期冻结的 /api 目标会指不到实际监听端口（跨平台同步等批量失败）。
        PORT_AUTO_RETRY: '1',
        // 管理会话自己负责 web 后端的生命周期（本会话空闲回收 / manage stop 回收）。
        // 若不加这个开关，server.js 会在「60 秒无前端客户端」时自作主张退出，把
        // 打开中的管理页重新打回 /api 500 —— 两个空闲回收器互相打架。
        IDLE_SHUTDOWN: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    logStream.destroy();
    _log(`[ai-manage-daemon] Web 后端启动失败 (端口 ${port}): ${describeSystemError(err)}`);
    return { port: 0, managed: false, child: null, ready: Promise.resolve(false) };
  }
  _pipeConsoleToUtf8Log(child.stdout, logStream);
  _pipeConsoleToUtf8Log(child.stderr, logStream);
  child.on('error', () => {
    /* 经由下面的健康等待暴露为超时/回退，不让它变成 uncaughtException */
  });

  // 健康等待不阻塞调用方——交给 main 与前端启动并行，flip ready 前再 await。
  const ready = (async () => {
    const ok = await waitWebBackendHealthy(port);
    if (!ok) {
      if (child.pid) await terminatePid(child.pid);
      _log(
        `[ai-manage-daemon] Web 后端启动超时 (${Math.round(WEB_BACKEND_WAIT_MS / 1000)}s)，已停止本次进程；` +
          '管理台回退由守护进程单独服务（跨平台同步暂不可用），详见 web_backend.log'
      );
      return false;
    }
    _log(
      `[ai-manage-daemon] Web 后端已就绪: http://127.0.0.1:${port} (auth/api-keys/用户管理 + /ws/cross-platform)`
    );
    return true;
  })();

  return { port, managed: true, child, ready };
}

async function resolveFrontend({
  host,
  requestedPort,
  autoFrontend,
  noFrontend,
  frontendDir,
  apiPort: backendPort,
  webBackendPort,
}) {
  if (noFrontend) {
    return { available: false, managed: false, port: requestedPort, reason: 'disabled' };
  }

  // 复用优先：KHY 前端已经在跑（手工 `npm run dev`、上一个会话留下的 dev server、
  // 或别的端口上的同一应用）就接上它，**不再起第二个**——否则同一台机器上会多出
  // 一个端口，而入口/运行时文件仍指向基准端口，用户打开的可能不是这个应用。
  // 复用来的前端不属于本进程（managed:false），所以本进程退出/被回收时不会去杀它。
  const reusable = await discoverKhyFrontend({ host, basePort: requestedPort });
  if (reusable) {
    return {
      available: true,
      managed: false,
      port: reusable.port,
      host: reusable.host,
      reason: reusable.source === 'runtime-file' ? 'reused-runtime' : 'reused',
    };
  }

  // 基准端口被占：先告诉用户是**谁**占的（只读查询，不杀进程），再决定走哪条路。
  // 无法绑定 = 有东西在监听（或权限不足），此时「漂移」前必须留下一句可行动的解释。
  const baseBusy = !(await canBindPort(host, requestedPort));
  if (baseBusy) {
    let owner = '';
    try {
      owner = await describePortOwner(requestedPort, { host });
    } catch {
      owner = '';
    }
    _log(
      owner
        ? `[ai-manage-daemon] 基准端口 ${owner}，前端将改用下一个空闲端口（可用 --frontend-port 指定别的基准）`
        : `[ai-manage-daemon] 基准端口 ${requestedPort} 被未知进程占用，前端将改用下一个空闲端口（可用 --frontend-port 指定别的基准）`
    );
  }

  // Prefer managed frontend with auto port fallback.
  if (autoFrontend && frontendDir) {
    const started = await startFrontendProcess({
      host,
      basePort: requestedPort,
      frontendDir,
      apiPort: backendPort,
      webBackendPort,
    });
    if (started.ok) {
      return {
        available: true,
        managed: true,
        port: started.port,
        child: started.child,
        logFile: started.logFile,
      };
    }
    // Fall through to external frontend probe.
  }

  const externalOpen = await isPortOpen(host, requestedPort);
  if (externalOpen) {
    return { available: true, managed: false, port: requestedPort, reason: 'external' };
  }

  return {
    available: false,
    managed: false,
    port: requestedPort,
    reason: 'unavailable',
  };
}

function buildStatusPayload() {
  return {
    ok: true,
    runtime: {
      pid: process.pid,
      apiPort,
      frontendPort,
      frontendHost,
      frontendUrl,
      frontendAvailable,
      frontendManaged,
      frontendPid: frontendProc && frontendProc.pid ? frontendProc.pid : null,
      webBackendPort,
      webBackendManaged,
      webBackendPid: webBackendProc && webBackendProc.pid ? webBackendProc.pid : null,
      controlPort,
      sessions: sessions.size,
      seenAnySession,
      startupAt,
      lastActiveAt,
      lastRequestAt,
      // [DESIGN-ARCH-169] P1a: same in-process source the runtime file publishes
      // — no second store, no drift (§6 反模式).
      phase: startupPhase,
      phaseDetail,
      phaseSince,
    },
  };
}

function upsertSession(sid) {
  if (!sid) return;
  sessions.set(sid, Date.now());
  lastActiveAt = Date.now();
  seenAnySession = true;
}

function removeSession(sid) {
  if (!sid) return;
  sessions.delete(sid);
}

async function shutdown(reason = 'unknown') {
  if (shuttingDown) return;
  shuttingDown = true;

  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
  }

  try {
    if (controlServer) {
      await new Promise((resolve) => controlServer.close(() => resolve()));
      controlServer = null;
    }
  } catch {
    // best effort
  }

  try {
    await aiManagementServer.stop();
  } catch {
    // best effort
  }

  try {
    if (workflowRunWorker) workflowRunWorker.stop();
  } catch {
    // best effort
  }

  if (frontendManaged && frontendProc && frontendProc.pid) {
    await terminatePid(frontendProc.pid);
  }

  // 只回收本会话拉起的 web 后端；复用的实例归它的原启动方所有。
  if (webBackendManaged && webBackendProc && webBackendProc.pid) {
    try {
      await terminatePid(webBackendProc.pid);
    } catch {
      /* best effort */
    }
  }

  clearRuntime();

  _log(`[ai-manage-daemon] shutdown: ${reason}`);
  process.exit(0);
}

function startGcLoop({ idleMs, sessionTtlMs, startupGraceMs, tickMs = GC_TICK_MS }) {
  gcTimer = setInterval(() => {
    const now = Date.now();

    for (const [sid, lastSeen] of sessions) {
      if (now - lastSeen > sessionTtlMs) sessions.delete(sid);
    }

    writeRuntime({ sessions: sessions.size });

    if (sessions.size > 0 || anyProbeActive()) {
      lastActiveAt = now;
      return;
    }

    // Serve-side activity counts as liveness too: a request answered by the API
    // server means the daemon is doing real work, whatever the browser-side
    // session bridge is doing. See lastRequestAt.
    const limit = seenAnySession ? idleMs : startupGraceMs;
    const inactiveMs = now - Math.max(lastActiveAt, lastRequestAt);
    if (inactiveMs >= limit) {
      const reason = seenAnySession ? 'idle' : 'startup-timeout';
      // Diagnostic context for restart analysis: which reaper fired (idle vs
      // startup grace), how long we were inactive vs the threshold, and whether
      // any session was ever opened during this daemon lifetime.
      // [DESIGN-ARCH-169] P3: the parenthetical states what the key actually
      // means ("startup-timeout" was a misnomer for "startup grace with zero
      // sessions"); the machine reason key stays untouched — log greps and the
      // jest-era tests match on it.
      //
      // 措辞纪律：用户是在 `khy chat` 的失败尾巴里读到这一行的，最容易被
      // 「startup-timeout / 启动」误读成**启动失败**。实际上这只与「有没有人
      // 打开过页面」有关 —— 启动早已成功。所以人类可读段必须点明：
      //   · 已 ready ⇒ 明确写「启动已成功」
      //   · 未 ready ⇒ 才可能是真的启动问题（但那由独立看门狗负责，见 :259）
      const _phaseNote =
        startupPhase === PHASE_READY
          ? `启动早已成功（phase=ready），此处仅因 ${Math.round(
              startupGraceMs / 1000
            )}s 内没有任何会话接入而回收空闲进程`
          : `启动宽限 ${Math.round(startupGraceMs / 1000)}s 内无任何会话接入（phase=${
              phaseDetail || startupPhase
            }）`;
      _log(
        `[ai-manage-daemon] 正在关闭守护进程: 原因=${reason}（${
          seenAnySession ? `空闲 ${Math.round(idleMs / 1000)}s 内无活动` : _phaseNote
        }） 无活动=${inactiveMs}ms 阈值=${limit}ms 曾见会话=${seenAnySession}`
      );
      shutdown(reason).catch(() => process.exit(1));
    }
  }, tickMs);
  gcTimer.unref();
}

function createControlServer() {
  controlServer = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      return sendJson(res, 204, {});
    }

    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const pathname = urlObj.pathname;
    const token = readAuthToken(req, urlObj);
    if (token !== controlToken) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }

    if (req.method === 'GET' && pathname === '/status') {
      return sendJson(res, 200, buildStatusPayload());
    }

    if (req.method === 'POST' && pathname === '/shutdown') {
      sendJson(res, 200, { ok: true });
      shutdown('requested').catch(() => process.exit(1));
      return;
    }

    // CLI pushes the current session auth token here at manage startup
    // (gatewayManageDaemon._syncManageAuthBootstrapFromCli), so the page opened
    // afterwards can auto-login without the user typing credentials.
    if (req.method === 'POST' && pathname === '/auth/bootstrap') {
      const bodyRaw = await readBody(req);
      const body = safeJsonParse(bodyRaw || '{}');
      const bootstrapToken = String(body.token || '').trim();
      const ttlMs = Math.max(30_000, parseInt(body.ttlMs, 10) || 30 * 60_000);
      authBootstrap = {
        enabled: body.enabled === true && !!bootstrapToken,
        token: bootstrapToken,
        username: String(body.username || '').trim(),
        role: String(body.role || 'user').trim() || 'user',
        expiresAt: Date.now() + ttlMs,
      };
      return sendJson(res, 200, { ok: true, enabled: authBootstrap.enabled });
    }

    // Manage page fetches the bootstrap payload (expects { data: { token } });
    // an absent/expired bootstrap answers ok with a null data instead of an
    // error so the page just falls back to the normal login form.
    if (req.method === 'GET' && pathname === '/auth/bootstrap') {
      const valid =
        authBootstrap &&
        authBootstrap.enabled &&
        authBootstrap.token &&
        Date.now() < authBootstrap.expiresAt;
      return sendJson(
        res,
        200,
        valid
          ? {
              ok: true,
              data: {
                token: authBootstrap.token,
                username: authBootstrap.username,
                role: authBootstrap.role,
              },
            }
          : { ok: true, data: null }
      );
    }

    if (
      req.method === 'POST' &&
      (pathname === '/open' || pathname === '/ping' || pathname === '/close')
    ) {
      const bodyRaw = await readBody(req);
      const body = safeJsonParse(bodyRaw || '{}');
      const sid = String(body.sid || '').trim();
      if (!sid) return sendJson(res, 400, { ok: false, error: 'missing sid' });

      if (pathname === '/close') {
        removeSession(sid);
      } else {
        upsertSession(sid);
      }
      return sendJson(res, 200, { ok: true, sessions: sessions.size });
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  });
}

async function listenControlServer() {
  await new Promise((resolve, reject) => {
    controlServer.once('error', reject);
    controlServer.listen(0, '127.0.0.1', () => {
      const addr = controlServer.address();
      controlPort = addr && typeof addr === 'object' ? addr.port : 0;
      resolve();
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const requestedApiPort = parsePortArg(argv, '--api-port', DEFAULT_API_PORT);
  const requestedFrontendPort = parsePortArg(argv, '--frontend-port', DEFAULT_FRONTEND_PORT);
  const idleMs = Math.max(10_000, parseIntArg(argv, '--idle-ms', DEFAULT_IDLE_MS));
  const sessionTtlMs = Math.max(
    10_000,
    parseIntArg(argv, '--session-ttl-ms', DEFAULT_SESSION_TTL_MS)
  );
  const startupGraceMs = Math.max(
    20_000,
    parseIntArg(argv, '--startup-grace-ms', DEFAULT_STARTUP_GRACE_MS)
  );
  const autoFrontend = !hasFlag(argv, '--no-auto-frontend');
  const noFrontend = hasFlag(argv, '--no-frontend');
  const noWebBackend = hasFlag(argv, '--no-web-backend') || process.env.KHY_MANAGE_NO_WEB_BACKEND === '1';
  const frontendDir = parseStringArg(argv, '--frontend-dir', '');
  const frontendDistDir = parseStringArg(argv, '--frontend-dist-dir', '');
  frontendHost = parseStringArg(argv, '--frontend-host', '127.0.0.1');

  // [DESIGN-ARCH-169] P1a: control plane + runtime file exist from t≈0. Binding
  // on port 0 here has no side effects (the old late bind at the end of main()
  // is retired); the CLI can poll real stage progress instead of staring at a
  // silent terminal, and a daemon wedged mid-chain is now visible AND bounded
  // by the startup watchdog.
  await beginStartupPhase();

  // [快速启动] 并行化：web 后端(严格绑端口)与守护 API 并发拉起。顺序约束仍在——vite
  // 需要的是 web 后端的**端口号**(provision 毫秒级即得)，而非其**就绪状态**；健康等待
  // 交给 webBackendProvision.ready，在下方 vite 启动之后才 await，使 server.js 冷启与
  // vite 冷启重叠，而非串行叠加。
  let webBackendProvision = {
    port: 0,
    managed: false,
    child: null,
    ready: Promise.resolve(false),
  };
  if (noWebBackend) {
    _log('[ai-manage-daemon] 已按 --no-web-backend 跳过 web 后端保障');
  } else {
    webBackendProvision = await provisionWebBackend({
      requestedPort: DEFAULT_WEB_BACKEND_PORT,
    });
    webBackendPort = webBackendProvision.port;
    webBackendManaged = !!webBackendProvision.managed;
    webBackendProc = webBackendProvision.child || null;
    if (webBackendProc) {
      webBackendProc.on('exit', () => {
        webBackendProc = null;
        if (webBackendManaged) {
          writeRuntime({ webBackendPid: null });
        }
      });
    }
  }

  // [DESIGN-ARCH-169] P1a: stage labels advance as the serial chain progresses —
  // each one lands in the runtime file + /status so the CLI can print progress.
  _setStartupPhase(PHASE_STARTING, 'api');

  apiPort = await aiManagementServer.start(requestedApiPort, {
    onRequest: noteRequestActivity,
  });

  _setStartupPhase(PHASE_STARTING, 'frontend');

  // Claim/execute queued workflow runs in this serving process (see require note).
  // Skipped entirely when the workflow module failed to load (fail-soft above).
  if (workflowRunWorker) {
    try {
      workflowRunWorker.start();
    } catch (err) {
      // A worker failure must never prevent the management stack from serving.
      _logError(
        '[ai-manage-daemon] workflow worker start failed:',
        err && err.message ? err.message : String(err)
      );
    }
  }

  // Liveness: a workflow run in flight must not be reaped as idle. The GC loop
  // treats a busy worker as activity so a long headless task is never killed
  // mid-run (which would re-queue it and flap the daemon).
  addActivityProbe(() => {
    try {
      return !!(workflowRunWorker && workflowRunWorker.isBusy());
    } catch {
      return false;
    }
  });

  const frontend = await resolveFrontend({
    host: frontendHost,
    requestedPort: requestedFrontendPort,
    autoFrontend,
    noFrontend,
    frontendDir,
    apiPort,
    // vite 与 server.js 并行：把已严格选定的 web 端口显式钉给 vite（>0 才钉；无 web
    // 后端时留空，backendDiscovery 回退到守护进程，行为同旧「纯 API」模式）。
    webBackendPort: webBackendPort > 0 ? webBackendPort : undefined,
  });

  // 回退：dev server 不可用时，用 API 端口托管预构建 dist/。
  // 显式 --no-frontend 时必须保持无前端，不得被预构建 dist 复活。
  if (!noFrontend && !frontend.available && frontendDistDir) {
    const staticResult = aiManagementServer.configureFrontendStatic({
      distDir: frontendDistDir,
    });
    if (staticResult.enabled) {
      frontend.available = true;
      frontend.managed = true;
      frontend.port = apiPort;
      frontend.reason = 'static-dist';
    }
  }

  frontendPort = frontend.port;
  frontendAvailable = !!frontend.available;
  frontendManaged = !!frontend.managed;
  // A reused frontend may live on another loopback host than the requested one —
  // build the URL from where it actually answers, not from the request.
  if (frontend.host) {
    frontendHost = frontend.host;
  }
  frontendUrl = `http://${frontendHost}:${frontendPort}`;
  if (frontend.reason === 'reused' || frontend.reason === 'reused-runtime') {
    _log(
      `[ai-manage-daemon] 复用已在运行的 KHY 前端（${frontendUrl}，来源 ${frontend.reason}）——未新起前端进程`
    );
  }
  if (frontend.child) {
    frontendProc = frontend.child;
    frontendProc.on('exit', () => {
      frontendProc = null;
      if (frontendManaged) {
        frontendAvailable = false;
        writeRuntime({ frontendAvailable: false, frontendPid: null });
      }
    });
  }

  // [快速启动] vite 已启动，此刻才收敛 web 后端健康等待——server.js 冷启与 vite 冷启
  // 已在上面并行发生。健康失败则把 web 端口归零（本次进程已由 provisionWebBackend 的
  // ready 分支停掉），管理台回退为守护进程单独服务。
  if (!noWebBackend) {
    const webOk = await webBackendProvision.ready;
    if (!webOk && webBackendManaged) {
      webBackendPort = 0;
    }
  }

  // [DESIGN-ARCH-169] P1a: the control plane was bound at main() entry (the old
  // late bind here is retired). Flip to ready BEFORE the canonical runtime write
  // so the file lands with phase='ready' in one write — the CLI sees "ready" the
  // moment the stack is actually up.
  _setStartupPhase(PHASE_READY, 'ready');
  startupAt = Date.now();
  lastActiveAt = Date.now();

  writeRuntime({
    idleMs,
    sessionTtlMs,
    startupGraceMs,
    frontendLogFile: frontend.logFile || null,
    frontendReason: frontend.reason || '',
  });

  // Explicit watchdog retire (its tick also self-retires on phase==='ready');
  // the GC loop owns liveness from here on.
  stopStartupWatchdog();
  startGcLoop({ idleMs, sessionTtlMs, startupGraceMs });
}

// Map common OS-level failure codes to actionable Chinese advice so a resource
// crash (e.g. spawn ENOMEM in a constrained environment) never surfaces as a
// vague message. Returns "message [CODE] — advice" or the plain message.
function describeSystemError(err) {
  const code = err && err.code ? String(err.code) : '';
  const advice = {
    ENOMEM: '系统内存不足，请关闭占用内存较多的程序后重试',
    EACCES: '权限不足，请检查当前用户对相关文件/端口的访问权限',
    EPERM: '操作被系统拒绝，请检查权限或安全软件拦截',
    EMFILE: '进程可打开的文件句柄已耗尽，请关闭部分程序后重试',
    ENFILE: '系统文件句柄已耗尽，请关闭部分程序后重试',
    EAGAIN: '系统资源暂时不足（无法创建进程），请稍后重试',
  }[code];
  const msg = err && err.message ? err.message : String(err);
  return advice ? `${msg} [${code}] — ${advice}` : msg;
}

function handleSigterm() {
  shutdown('sigterm').catch(() => process.exit(1));
}

function handleSigint() {
  shutdown('sigint').catch(() => process.exit(1));
}

const {
  isTransientError,
  isAbortError,
  isBenignUncaughtException,
} = require('../src/services/crashRecovery');

// A single transient fault (a reset socket, a busy SQLite row, a missing
// interpreter from a stale config) must NOT take the whole management stack
// down. Only fatal / unknown faults do. This is what stops the "any
// unhandled rejection → exit → respawn" flapping loop.
function isSurvivableProcessError(err) {
  if (isAbortError(err)) return true;
  if (isBenignUncaughtException(err)) return true;
  if (isTransientError(err)) return true;
  return false;
}

function handleUncaughtException(err) {
  if (isSurvivableProcessError(err)) {
    _logWarn(
      '[ai-manage-daemon] uncaughtException transient, continuing:',
      describeSystemError(err)
    );
    return;
  }
  _logError(
    '[ai-manage-daemon] uncaughtException fatal/unknown: closing AI management session:',
    describeSystemError(err)
  );
  shutdown('uncaught-exception').catch(() => process.exit(1));
}

function handleUnhandledRejection(err) {
  if (isSurvivableProcessError(err)) {
    _logWarn(
      '[ai-manage-daemon] unhandledRejection transient, continuing:',
      describeSystemError(err)
    );
    return;
  }
  _logError(
    '[ai-manage-daemon] unhandledRejection fatal/unknown: closing AI management session:',
    describeSystemError(err)
  );
  shutdown('unhandled-rejection').catch(() => process.exit(1));
}

// Install the process-level handlers. Kept separate from module load so the
// script can be required by unit tests without hijacking the host process's
// crash reporting.
function installProcessHandlers() {
  process.on('SIGTERM', handleSigterm);
  process.on('SIGINT', handleSigint);
  process.on('uncaughtException', handleUncaughtException);
  process.on('unhandledRejection', handleUnhandledRejection);
}

if (require.main === module) {
  // Self-provision the JWT signing secret only when running as the detached
  // script — a unit test that imports this module must not write .env files.
  try {
    require('../src/bootstrap/ensureAuthSecret').ensureJwtSecret({
      log: (m) => {
        try {
          process.stdout.write(`[daemon] ${m}\n`);
        } catch {
          /* ignore */
        }
      },
    });
  } catch {
    /* helper unavailable — login will surface a clear error itself */
  }

  installProcessHandlers();

  main().catch((err) => {
    _logError(
      '[ai-manage-daemon] start failed: 启动 AI 管理守护进程失败:',
      describeSystemError(err)
    );
    clearRuntime();
    process.exit(1);
  });
}

module.exports = {
  // Reaping / lifecycle
  startGcLoop,
  addActivityProbe,
  noteRequestActivity,
  shutdown,
  clearRuntime,
  writeRuntime,
  upsertSession,
  removeSession,
  // Control surface (exported so tests can build the real control server)
  createControlServer,
  listenControlServer,
  readAuthToken,
  // Process-level fault handlers (exported so tests can drive them directly)
  handleUncaughtException,
  handleUnhandledRejection,
  installProcessHandlers,
  // Helpers reused by tests
  isPidAlive,
  findAvailablePort,
  resolveFrontend,
  getState,
  _resetForTests,
  // Console transcode helpers (exported so tests can drive the real UTF-8 path)
  _decodeConsoleLine,
  _pipeConsoleToUtf8Log,
  // [DESIGN-ARCH-169] P1a test seams: early readiness + phase + watchdog decision
  beginStartupPhase,
  _setStartupPhase,
  getStartupPhaseState,
  startStartupWatchdog,
  stopStartupWatchdog,
  _evalStartupWatchdog,
};
