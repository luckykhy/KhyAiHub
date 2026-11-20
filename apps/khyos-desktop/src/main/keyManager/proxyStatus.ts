// khy-canary: Khy-20261102-266-H0XXY4Z9
// proxyStatus — khy local proxy (gateway/proxyServer.js) discovery for the
// Key/Endpoint Manager (DESIGN-ARCH-091 §8b.3 Mode B).
//
// Zero hardcoding (repo rule 1): the actual port/host come from
// <dataHome>/proxy_server_runtime.json (written by proxyServer on start); the
// relay credential from <dataHome>/proxy_server_auth.json. A stale runtime
// file with no live listener surfaces as running:false after the /health
// probe, so the UI always shows the truthful state (rule 2).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getDataHome } from './keyStore.ts'
import { PROXY_AUTH_FILE, PROXY_RUNTIME_FILE, VALIDATE_TIMEOUT_MS } from './types.ts'
import { keyFingerprint } from './keyStore.ts'

export interface ProxyRuntimeFile {
  /** 嵌套形态：早期桌面端自己的写法（旧 fixture / 手工放的文件） */
  http?: { enabled?: boolean; port?: number; host?: string; url?: string }
  https?: { enabled?: boolean; port?: number; host?: string; url?: string }
  /** 扁平形态：网关 proxyServer.js writeRuntimeStatus 的真实写法
   *  （proxyServer.js:330-345：{pid,host,port,httpPort,httpsPort,
   *   httpsEnabled,httpsOnly,mode,startedAt,updatedAt}，**没有** http/https
   *   嵌套对象）。只认嵌套会让桌面端对真实运行的网关永远判 running:false。 */
  host?: string
  port?: number | null
  httpPort?: number | null
  httpsPort?: number | null
  httpsEnabled?: boolean
  httpsOnly?: boolean
}

export interface ProxyStatus {
  running: boolean
  endpoint: string
  host: string
  port: number | null
  relayFingerprint: string | null
  detail: string
}

function runtimeFile(): string {
  return path.join(getDataHome(), PROXY_RUNTIME_FILE)
}

function authFile(): string {
  return path.join(getDataHome(), PROXY_AUTH_FILE)
}

// sync read: callers (IPC) run in the main process where a sync JSON read is
// fine; missing file → not running.
//
// 两种 schema 都认（读侧兼容，不迁移已落盘文件）：
//   · 扁平 —— 网关 proxyServer.js:330-345 的真实写法。这是**主路径**。
//   · 嵌套 —— 早期桌面端自己的写法，旧 fixture 与手工文件仍是这个形状。
// 判活口径与网关自己的读方 utils/proxyBaseUrl.js 对齐：http 优先，https-only
// 时取 https；两者都没有可用端口 → not running。
export function readProxyRuntime(): { running: boolean; endpoint: string; host: string; port: number | null } {
  try {
    const raw = readFileSync(runtimeFile(), 'utf-8')
    const rt = JSON.parse(raw) as ProxyRuntimeFile
    const httpPort = pickPort(rt.http?.port, rt.httpPort)
    const httpsPort = pickPort(rt.https?.port, rt.httpsPort)
    // http 可用（嵌套 enabled 或扁平有 httpPort 且非 httpsOnly）→ http
    const httpOk = Boolean(rt.http?.enabled) || (httpPort !== null && !rt.httpsOnly)
    if (httpOk && httpPort !== null) {
      const host = rt.http?.host || rt.host || '127.0.0.1'
      const endpoint = rt.http?.url || `http://${host}:${httpPort}`
      return { running: true, endpoint, host, port: httpPort }
    }
    const httpsOk = Boolean(rt.https?.enabled) || (httpsPort !== null && Boolean(rt.httpsEnabled || rt.httpsOnly))
    if (httpsOk && httpsPort !== null) {
      const host = rt.https?.host || rt.host || '127.0.0.1'
      const endpoint = rt.https?.url || `https://${host}:${httpsPort}`
      return { running: true, endpoint, host, port: httpsPort }
    }
  } catch {
    /* no runtime file yet */
  }
  return { running: false, endpoint: '', host: '', port: null }
}

// 端口字段归一：只收有限正数（网关的 null 占位 / 字符串脏值都算没有）。
function pickPort(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    const n = Number(c)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return null
}

// relay 令牌：env 优先，与网关 resolvePrimaryAuthToken（proxyServer.js:629-644）
// 同序 —— 网关以 PROXY_AUTH_TOKEN 启动时，持久化文件里那份是上一轮的残留，
// 只读文件会让 probe 稳定拿到空令牌 → 401 → 文案把用户引向错误的修复动作。
export function readProxyToken(): string {
  const envToken = String(process.env.PROXY_AUTH_TOKEN || '').trim()
  if (envToken) return envToken
  try {
    const raw = readFileSync(authFile(), 'utf-8')
    const parsed = JSON.parse(raw) as { authToken?: string }
    return parsed.authToken || ''
  } catch {
    return ''
  }
}

export async function proxyStatus(): Promise<ProxyStatus> {
  const rt = readProxyRuntime()
  const token = readProxyToken()
  if (!rt.running) {
    return {
      running: false,
      endpoint: '',
      host: '',
      port: null,
      relayFingerprint: token ? keyFingerprint(token) : null,
      detail: 'khy 代理未运行：启动本地网关后重试（动作: 启动本地网关 目标: 127.0.0.1）'
    }
  }
  // liveness probe (short I/O, 3s — handshake exception class)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS)
  let live = false
  try {
    const res = await fetch(`${rt.endpoint.replace(/\/+$/, '')}/health`, { signal: ctrl.signal })
    live = res.status >= 200 && res.status < 500
  } catch {
    live = false
  }
  clearTimeout(timer)
  if (!live) {
    return {
      running: false,
      endpoint: rt.endpoint,
      host: rt.host,
      port: rt.port,
      relayFingerprint: token ? keyFingerprint(token) : null,
      detail: 'khy 代理运行时文件已过期：端口无响应，请启动本地网关（动作: 重启网关 目标: 127.0.0.1）'
    }
  }
  return {
    running: true,
    endpoint: rt.endpoint,
    host: rt.host,
    port: rt.port,
    relayFingerprint: token ? keyFingerprint(token) : null,
    detail: `khy 代理运行中：${rt.endpoint}（模型/密钥切换为纯 khy 侧操作）`
  }
}

// test seam
export function _proxyFiles(): { runtime: string; auth: string } {
  return { runtime: runtimeFile(), auth: authFile() }
}

// one-click gateway start (spec §5.2: proxy 未运行 → 提供一键启动). Delegates
// to the backend proxyServer module when resolvable; honest fail-soft message
// when the backend is absent (rule 2.2 error template).
export async function startProxy(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const { resolveBackendServicesRoot } = await import('./agentWriters.ts')
  const root = resolveBackendServicesRoot()
  if (!root) {
    return {
      ok: false,
      error: '本地网关启动失败：未找到 backend 服务（env KHY_BACKEND_SERVICES 或仓库内 runtime/node/backend），请改用 khy CLI 启动网关'
    }
  }
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(path.join(root, 'noop.js'))
    const proxyServer = req(path.join(root, 'gateway/proxyServer.js'))
    if (proxyServer.isRunning()) {
      return { ok: true, detail: '本地网关已在运行' }
    }
    await proxyServer.start()
    await new Promise((r) => setTimeout(r, 500))
    const st = await proxyStatus()
    return st.running
      ? { ok: true, detail: `本地网关已启动：${st.endpoint}` }
      : { ok: false, error: '本地网关启动中：500ms 后仍未就绪，请查看网关日志（动作: 检查日志 目标: 本地网关）' }
  } catch (e) {
    return { ok: false, error: `本地网关启动失败：${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` }
  }
}

