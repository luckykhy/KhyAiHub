// Locate the running KHY AI management frontend (apps/ai-frontend) before opening it.
//
// Why not just build `http://<host>:8090`: 8090 is only the BASE port. When it is
// already taken the dev server binds a later port, and some other service may own
// 8090 entirely — in both cases a hardcoded URL opens a stranger's page (or nothing),
// which the user experiences as "the page is blank". So we probe the candidate ports
// and only return a URL that answers as OUR app (identity endpoint first, page title
// as the fallback for older dev servers), mirroring
// apps/ai-frontend/frontendRuntime.mjs and services/backend/src/services/aiFrontendLocator.js.
//
// Returns '' when nothing answers — callers must show an honest "not running" message
// instead of opening a guessed port.
import { AI_FRONTEND_BASE_PORT, AI_FRONTEND_SCAN_WINDOW } from '@/constants/serviceDefaults'

const AI_FRONTEND_APP_ID = 'khy-ai-frontend'
const IDENTITY_PATH = '/khy-frontend-identity.json'
const TITLE_MARKER = /KHY/i
const PROBE_TIMEOUT_MS = 900

function candidatePorts() {
  const base = Number(AI_FRONTEND_BASE_PORT)
  if (!Number.isFinite(base) || base <= 0 || base > 65535) {
    return []
  }
  const window = Math.max(1, Number(AI_FRONTEND_SCAN_WINDOW) || 1)
  const ports = []
  for (let p = base; p < base + window && p <= 65535; p += 1) {
    ports.push(p)
  }
  return ports
}

async function fetchText(url, timeoutMs = PROBE_TIMEOUT_MS) {
  if (typeof fetch !== 'function') {
    return null
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetch(url, controller ? { signal: controller.signal } : undefined)
    if (!res.ok) {
      return null
    }
    return await res.text()
  } catch {
    return null // unreachable / CORS-blocked / timeout == "not this port"
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/** True only when the endpoint answers as the KHY AI frontend (identity, else page title). */
export async function isKhyAiFrontend(baseUrl) {
  const identity = await fetchText(`${baseUrl}${IDENTITY_PATH}`)
  if (identity) {
    try {
      if (String(JSON.parse(identity)?.app || '') === AI_FRONTEND_APP_ID) {
        return true
      }
    } catch {
      // malformed identity payload -> fall through to the title check
    }
  }
  const html = await fetchText(baseUrl)
  if (!html) {
    return false
  }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return !!title && TITLE_MARKER.test(title[1])
}

/**
 * Resolve the AI management frontend URL, or '' when no KHY frontend answers.
 * Precedence: explicit build-time URL -> explicit build-time port -> identity probe.
 */
export async function resolveAiFrontendUrl() {
  const explicitUrl = String(import.meta.env.VITE_AI_FRONTEND_URL || '')
    .trim()
    .replace(/\/$/, '')
  if (explicitUrl) {
    return explicitUrl
  }
  if (typeof window === 'undefined') {
    return ''
  }

  const proto = window.location.protocol === 'https:' ? 'https:' : 'http:'
  const host = window.location.hostname
  const explicitPort = Number(import.meta.env.VITE_AI_FRONTEND_PORT)
  const ports = Number.isFinite(explicitPort) && explicitPort > 0
    ? [explicitPort, ...candidatePorts().filter((p) => p !== explicitPort)]
    : candidatePorts()

  for (const port of ports) {
    // eslint-disable-next-line no-await-in-loop
    if (await isKhyAiFrontend(`${proto}//${host}:${port}`)) {
      return `${proto}//${host}:${port}`
    }
  }
  return ''
}