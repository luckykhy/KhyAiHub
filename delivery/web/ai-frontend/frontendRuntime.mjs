// Publish + identity for the AI frontend dev/preview server.
//
// Why this exists: 8090 is only a *base* port. Two failure modes made the page
// look "blank" / point at the wrong service:
//   1. the base port is taken (another service or an older KHY frontend) — a silent
//      drift to 8091 means nobody (CLI entry, browser bookmark, admin page) knows
//      where the app actually is;
//   2. the app is already running and the entry starts a *second* stack on a new
//      port instead of reusing the healthy one.
// So this module (a) probes for a genuinely free port before Vite binds, and
// (b) publishes the real host/port/pid to `ai_frontend_runtime.json` in the data
// home, plus serves `/khy-frontend-identity.json` so a caller can tell *our*
// frontend from a stranger on the same port.
//
// Contract — must stay in lock-step with the consumer
// `services/backend/src/services/aiFrontendLocator.js` (that file is the read side):
//   - runtime filename  `ai_frontend_runtime.json`
//   - identity endpoint `/khy-frontend-identity.json` → { app, port, pid }
//   - the page <title> contains `KHY` (fallback identity for servers without the endpoint)
//
// Zero dependencies beyond node stdlib: the frontend is its own package and cannot
// import backend code, so the data-home discovery is mirrored here (see
// ./backendDiscovery.mjs, which does the same for the backend targets).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { resolveDataHomes } from './backendDiscovery.mjs'

export const FRONTEND_APP_ID = 'khy-ai-frontend'
export const FRONTEND_RUNTIME_FILENAME = 'ai_frontend_runtime.json'
export const FRONTEND_IDENTITY_PATH = '/khy-frontend-identity.json'

// Mirrors serviceDefaults.WEB_FRONTEND_PORT (services/backend/src/constants/serviceDefaults.js,
// `AI_FRONTEND_PORT || 8090`) — same env, same default, kept in lock-step.
const DEFAULT_FRONTEND_PORT = process.env.AI_FRONTEND_PORT || '8090'
const PORT_SCAN = 20

function validPort(value) {
  const n = parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : 0
}

/** True when the port can actually be bound (a plain TCP connect can't tell). */
export function canBindPort(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, host)
  })
}

/**
 * First genuinely free port at/after the base, so this process never silently
 * takes over another service's port and never drifts to a port no consumer reads.
 * Returns the base when the whole window is busy — Vite's `strictPort` then fails
 * loudly instead of drifting.
 */
export async function resolveServePort({
  host = process.env.AI_FRONTEND_HOST || '127.0.0.1',
  basePort = DEFAULT_FRONTEND_PORT,
  scan = PORT_SCAN,
} = {}) {
  const base = validPort(basePort) || validPort(DEFAULT_FRONTEND_PORT)
  // Self-restart guard: Vite re-evaluates this config IN-PROCESS whenever the
  // config file or one of its imports changes, and the old server still holds
  // its port at that moment — a blind bind probe then drifts to base+1 while
  // the daemon's entry URL, the runtime file and the user's bookmark keep
  // pointing at the base port (2026-09-26: one such edit-driven restart left
  // the page orphaned on 8091). The runtime file records the publishing pid;
  // when it is OURS the recorded port is the old server's port, which is
  // released right after config evaluation — reuse it without probing.
  try {
    const file = path.join(primaryDataHome(), FRONTEND_RUNTIME_FILENAME)
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const own = validPort(raw?.port)
    if (
      Number(raw?.pid) === process.pid &&
      String(raw?.host || '') === String(host) &&
      own >= base &&
      own < base + scan
    ) {
      return own
    }
  } catch { /* no/corrupt runtime file → normal probe below */ }
  for (let p = base; p < base + scan && p <= 65535; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await canBindPort(host, p)) return p
  }
  return base
}

/** The data home this process should publish into: env override → pinned pointer → ~/.khy. */
export function primaryDataHome(env = process.env, opts = {}) {
  if (env.KHY_DATA_HOME) return env.KHY_DATA_HOME
  const homes = resolveDataHomes(env, opts)
  if (homes.length > 0) return homes[0]
  return path.join(os.homedir(), '.khy')
}

/**
 * Publish the real listen address so the CLI entry / admin pages open *this* app
 * instead of guessing a literal port. Written to the data home (a genuine
 * directory) — never mkdir a file path (that leaves `*.json` directories behind).
 * Fail-soft: a read-only home must not keep the dev server from serving.
 */
export function publishFrontendRuntime({ host, port, source = 'vite', env = process.env, opts = {} } = {}) {
  const fsImpl = opts.fs || fs
  const record = {
    app: FRONTEND_APP_ID,
    host,
    port,
    pid: process.pid,
    url: `http://${host}:${port}`,
    source,
    updatedAt: new Date().toISOString(),
  }
  try {
    const home = primaryDataHome(env, opts)
    fsImpl.mkdirSync(home, { recursive: true })
    fsImpl.writeFileSync(path.join(home, FRONTEND_RUNTIME_FILENAME), JSON.stringify(record, null, 2), 'utf-8')
    return { ok: true, file: path.join(home, FRONTEND_RUNTIME_FILENAME), record }
  } catch (err) {
    return { ok: false, reason: (err && err.message) || String(err) }
  }
}

/** Remove the runtime file only if it still describes this process (never a peer's). */
export function clearFrontendRuntime({ port, env = process.env, opts = {} } = {}) {
  const fsImpl = opts.fs || fs
  try {
    const file = path.join(primaryDataHome(env, opts), FRONTEND_RUNTIME_FILENAME)
    const raw = JSON.parse(fsImpl.readFileSync(file, 'utf-8'))
    if (Number(raw?.pid) !== process.pid) return { ok: false, reason: 'not-owner' }
    if (port && Number(raw?.port) !== Number(port)) return { ok: false, reason: 'port-changed' }
    fsImpl.unlinkSync(file)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: (err && err.code) || (err && err.message) || 'unknown' }
  }
}

/**
 * Vite plugin: answer the identity probe and keep the runtime file current.
 * Both dev and preview servers get it, so a caller can recognize the app in
 * either mode (the daemon's static-dist fallback is served elsewhere and does not
 * need it — it knows its own port).
 */
export function khyFrontendIdentityPlugin({ host, getPort, source = 'vite' } = {}) {
  const identity = () => JSON.stringify({ app: FRONTEND_APP_ID, host, port: getPort(), pid: process.pid })
  const attach = (server) => {
    server.middlewares.use((req, res, next) => {
      if (!req.url || !req.url.startsWith(FRONTEND_IDENTITY_PATH)) return next()
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(identity())
    })
  }
  return {
    name: 'khy-frontend-identity',
    configureServer(server) {
      attach(server)
      server.httpServer?.once('listening', () => {
        const result = publishFrontendRuntime({ host, port: getPort(), source })
        if (!result.ok) {
          server.config.logger.warn(`[khy] 前端运行态未能落盘（${result.reason}）——入口将退回端口探测`)
        }
      })
      server.httpServer?.once('close', () => clearFrontendRuntime({ port: getPort() }))
    },
    configurePreviewServer(server) {
      attach(server)
    },
  }
}