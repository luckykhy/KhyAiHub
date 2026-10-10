// Resolve the dev-proxy target for the AI backend.
//
// Why this exists: the backend daemon self-heals its listen port when the
// requested one is occupied (port drift), and records the actual port in
// `ai_manage_runtime.json` (field `apiPort`). A hardcoded `127.0.0.1:9090`
// proxy target means "backend healed, frontend did not follow". This helper
// discovers the real port from the runtime file so the dev proxy tracks the
// backend automatically.
//
// Precedence mirrors the backend's serviceDefaults._discoverAiBackendUrl:
//   1. explicit env override (VITE_AI_PROXY_TARGET / VITE_AI_API_BASE_URL)
//   2. apiPort from ai_manage_runtime.json across known data homes
//   3. env port hints (KHY_DAEMON_PORT / AI_MGMT_PORT)
//   4. last-resort default 127.0.0.1:9090
//
// This is a separate ESM module (frontend is its own package and cannot import
// backend code) and is read-only: it never creates directories or files.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Loopback last-resort default. Frontend is a separate browser package and
// cannot import backend code, so this MIRRORS serviceDefaults.AI_BACKEND_DEFAULT_URL
// (services/backend/src/constants/serviceDefaults.js) — keep the port in lock-step.
// Env-overridable so a non-default daemon port needs no code edit here.
const DEFAULT_BACKEND_PORT = process.env.KHY_DAEMON_PORT || '9090';
export const DEFAULT_BACKEND_TARGET = `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`;

// Web backend (services/backend/server.js) last-resort default — mirrors
// serviceDefaults.BACKEND_PORT (`PORT || 3000`). Only used when no live
// backend_runtime.json exists AND the default port answers.
const DEFAULT_WEB_PORT = process.env.PORT || '3000';
export const DEFAULT_WEB_BACKEND_TARGET = `http://127.0.0.1:${DEFAULT_WEB_PORT}`;

// The web backend (services/backend/server.js) writes `backend_runtime.json`;
// the local AI daemon writes `ai_manage_runtime.json`.
const WEB_RUNTIME_FILENAMES = ['backend_runtime.json'];
// Daemon-target candidates, in try order. The daemon's OWN file must come
// first: both servers run side by side in the standard two-backend setup, and
// a web-first order probed the live 3000 before reaching 9090 — routing the
// daemon-only namespaces (marketplace/workflow/plugins) to the web backend,
// which does not serve them (2026-09-26: /api/marketplace 401'd from the wrong
// server). `backend_runtime.json` stays as a fall-through for setups where the
// daemon's file is dead/absent but the web backend still answers.
const DAEMON_RUNTIME_FILENAMES = ['ai_manage_runtime.json', 'backend_runtime.json'];

// A runtime file outlives an ungraceful kill (SIGKILL / TaskStop does not run
// the exit hook that would clear it), so a stale file can point at a dead port
// forever — that is how the dev proxy once locked onto a dead 3001 while both
// real backends were up. The `pid` field exists precisely to detect this.
function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return true; // not recorded → don't block on it
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but belongs to another user → alive.
    return !!err && err.code === 'EPERM';
  }
}

function portOf(target) {
  const m = String(target || '').match(/:(\d+)(?:\/|$)/);
  return m ? parseInt(m[1], 10) : null;
}

// Cheap liveness probe so the proxy target is a server that is actually up.
// Read-only TCP connect to loopback; `timeoutMs` bounds the wait at config load.
export function isTargetReachable(target, timeoutMs = 400) {
  const port = portOf(target);
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Ports recorded by every valid runtime file in this data home, in filename
// precedence order. Each entry passes the stale-file (dead-pid) guard, but the
// port itself may still be dead (recycled pid) — the caller must probe each
// candidate before trusting it, and keep going when a probe fails. Returning
// ALL candidates (instead of the first one) is what lets a dead
// `backend_runtime.json` fall through to a live `ai_manage_runtime.json`
// sitting in the same directory.
function readApiPortCandidates(dataHome, fsImpl, filenames) {
  if (!dataHome) return [];
  const ports = [];
  for (const filename of filenames) {
    try {
      const file = path.join(dataHome, filename);
      const raw = JSON.parse(fsImpl.readFileSync(file, 'utf-8'));
      // Stale-file guard: a recorded pid that is no longer alive means this
      // entry describes a dead server — skip it and try the next candidate.
      if (raw?.pid && !isPidAlive(raw.pid)) continue;
      const apiPort = parseInt(String(raw?.apiPort ?? ''), 10);
      if (Number.isFinite(apiPort) && apiPort > 0 && apiPort <= 65535) ports.push(apiPort);
    } catch { /* missing/corrupt → try next candidate */ }
  }
  return ports;
}

function readPointerDataHomes(fsImpl, env, homedir) {
  try {
    const pointerFile = env.KHY_LOCATION_FILE
      || path.join(homedir, '.khy', '.location.json');
    const obj = JSON.parse(fsImpl.readFileSync(pointerFile, 'utf-8'));
    if (!obj || typeof obj !== 'object') return [];
    // The backend may pin its data home under the portable/app root and write
    // the pointer as `~PORTABLE~/<rel>` (see services/backend dataHome.js).
    // Resolve that against this package's app root (two levels up from
    // delivery/web/ai-frontend), mirroring the backend's read direction.
    //
    // import.meta.dirname, not __dirname: this module runs both bundled inside
    // the Vite config (esbuild injects a dirname var there) AND imported by
    // plain-ESM consumers (accept-stack.mjs), where bare __dirname is a
    // ReferenceError silently swallowed by the catch below — the portable
    // pointer degraded to "no project data home" and discovery never saw
    // backend_runtime.json. Node >=20.11 and Vite's define map both support
    // import.meta.dirname, so one spelling serves both runtimes.
    const APP_ROOT = path.resolve(import.meta.dirname, '../..');
    const resolvePortable = (value) => {
      if (typeof value !== 'string') return null;
      const PREFIX = '~PORTABLE~/';
      if (value === '~PORTABLE~') return APP_ROOT;
      if (value.startsWith(PREFIX) || value.startsWith('~PORTABLE~\\')) {
        return path.resolve(APP_ROOT, value.slice(PREFIX.length));
      }
      return value;
    };
    const homes = [];
    for (const key of ['projectDataHome', 'dataHome']) {
      const home = resolvePortable(obj[key]);
      if (home) homes.push(home);
    }
    return homes;
  } catch { /* no/corrupt pointer → ignore */ }
  return [];
}

/**
 * Every data home a KHY process may have written into, in the backend's own
 * precedence: env override → pinned pointer (`~/.khy/.location.json`, portable
 * form included) → `~/.khy` → legacy `~/.khyquant`. Exported so other read-only
 * discovery leaves (./frontendRuntime.mjs) share one resolution instead of
 * growing a second copy.
 */
export function resolveDataHomes(env = process.env, opts = {}) {
  const fsImpl = opts.fs || fs;
  const homedir = opts.homedir || os.homedir();
  const homes = [];
  if (env.KHY_DATA_HOME) homes.push(env.KHY_DATA_HOME);
  homes.push(...readPointerDataHomes(fsImpl, env, homedir));
  homes.push(path.join(homedir, '.khy'));
  homes.push(path.join(homedir, '.khyquant'));
  return homes;
}

export async function resolveBackendTarget(env = process.env, opts = {}) {
  // 1. Explicit override always wins (preserves prior behavior).
  const explicit = env.VITE_AI_PROXY_TARGET || env.VITE_AI_API_BASE_URL;
  if (explicit) return explicit;

  const fsImpl = opts.fs || fs;
  const homedir = opts.homedir || os.homedir();
  // Reachability probe, injectable for tests. The pid guard alone cannot be
  // trusted: Windows recycles pids, so a dead backend's runtime file can name
  // a pid that now belongs to an unrelated live process (2026-09-26: pid 46096
  // had become ZCode.exe and the proxy pinned to a port nobody listens on).
  const probe = opts.probe || isTargetReachable;

  // 2. Discover the actual backend apiPort from the runtime file, honoring the
  //    same data-home precedence the backend uses (explicit → pinned pointer →
  //    default ~/.khy → legacy ~/.khyquant). Entries whose recorded pid is dead
  //    are skipped (stale-file guard above), AND every surviving port must
  //    answer a probe before it is trusted.
  const dataHomes = resolveDataHomes(env, { fs: fsImpl, homedir });

  for (const dataHome of dataHomes) {
    for (const port of readApiPortCandidates(dataHome, fsImpl, DAEMON_RUNTIME_FILENAMES)) {
      const target = `http://127.0.0.1:${port}`;
      if (await probe(target)) return target;
      // Unreachable — stale file or recycled pid; try the next candidate.
    }
  }

  // 3. Env port hints (when no runtime file exists yet). Explicit configuration
  //    is trusted without a probe, mirroring the "explicit override wins" rule.
  const envPort = parseInt(String(env.KHY_DAEMON_PORT || env.AI_MGMT_PORT || ''), 10);
  if (Number.isFinite(envPort) && envPort > 0 && envPort <= 65535) {
    return `http://127.0.0.1:${envPort}`;
  }

  // 4. Last-resort default — returned unprobed: it is the documented fallback
  //    of last resort and the caller (dev proxy) reports its own proxy errors.
  return DEFAULT_BACKEND_TARGET;
}

// Resolve the WEB backend (services/backend/server.js) target — the server that
// owns auth, api-keys, the user-scoped ai-gateway/payments route and the
// cross-platform WebSocket. Only `backend_runtime.json` counts here: the
// daemon's `ai_manage_runtime.json` describes a different server that does NOT
// serve those routes.
//
// Precedence: explicit env → live backend_runtime.json → default port (mirrors
// serviceDefaults.BACKEND_PORT) when it answers → daemon (keeps daemon-only
// setups working, matching the documented single-backend fallback).
export async function resolveWebBackendTarget(env = process.env, opts = {}) {
  const explicit = env.VITE_API_TARGET || env.VITE_MONOLITH_TARGET;
  if (explicit) return explicit;

  const fsImpl = opts.fs || fs;
  const homedir = opts.homedir || os.homedir();
  const probe = opts.probe || isTargetReachable;
  const dataHomes = resolveDataHomes(env, { fs: fsImpl, homedir });

  for (const dataHome of dataHomes) {
    for (const port of readApiPortCandidates(dataHome, fsImpl, WEB_RUNTIME_FILENAMES)) {
      const target = `http://127.0.0.1:${port}`;
      if (await probe(target)) return target;
      // Unreachable — stale file or recycled pid; continue the chain.
    }
  }

  if (await probe(DEFAULT_WEB_BACKEND_TARGET)) {
    return DEFAULT_WEB_BACKEND_TARGET;
  }
  return resolveBackendTarget(env, opts);
}
