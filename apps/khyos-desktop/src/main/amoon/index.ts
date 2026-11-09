// khy-canary: Khy-20261102-257-DK2Y0Q7G
// amoo（amoon）桥接在主进程的接线层。
//
// 为什么 HTTP 必须在这里：bridge 对任何带 Origin 头的请求直接 403
// （khy-amoon-bridge/lib/server.js:848-859），operator.token 也只能留在主进程
// （lib/config.js:241-265、lib/auth.js:350-358 只对外给 present/valid/length）。
// 渲染层因此永远只拿到「已脱敏的状态」和「工具结果」，不碰 token、不发 fetch。
//
// 本文件刻意不 import electron，可以用 --experimental-strip-types 直接单测。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

// ── 桥接的磁盘契约（与 lib/config.js / lib/contracts.js 对齐）──────────────
const LOCAL_DIR_NAME = 'khy-amoon-bridge' // contracts.js:265
const FILE_RUNTIME = 'runtime.json' // contracts.js:268
const FILE_OPERATOR_TOKEN = 'operator.token' // contracts.js:270
const TOKEN_MIN_LENGTH = 16 // contracts.js:191
const ENV_HOME = 'KHY_AMOON_HOME' // config.js:39
const ENV_BRIDGE_DIR = 'KHY_AMOON_BRIDGE_DIR'
const ENV_KHY_OS_DIR = 'KHY_OS_DIR'

export type AmoonPhase = 'uninstalled' | 'not_running' | 'unhealthy' | 'running'

export type AmoonTokenInfo = { present: boolean; valid: boolean; length: number }

export type AmoonRuntimeInfo = {
  present: boolean
  pid: number | null
  port: number | null
  /** runtime.json 存在但不是合法 JSON / 端口或 pid 不合法 */
  malformed: boolean
}

export type AmoonDaemonInfo = {
  protocol: string | null
  port: number | null
  state: string | null
  adbOk: boolean | null
  lastPoll: string | null
  lastError: string | null
  auth: AmoonTokenInfo | null
  counters: Record<string, number> | null
}

export type AmoonStatus = {
  ok: boolean
  phase: AmoonPhase
  /** 面板首行直接显示这句话，不存在「假的在线」 */
  message: string
  /** 下一步该做什么（不可用时给出可执行命令） */
  hint: string
  stateDir: string
  stateDirExists: boolean
  token: AmoonTokenInfo
  runtime: AmoonRuntimeInfo
  health: boolean
  bridge: { root: string | null; cliFound: boolean }
  daemon: AmoonDaemonInfo | null
  canSend: boolean
  checkedAt: string
  error?: { code: string; message: string }
}

export type AmoonSendInput = { text: string; openChat?: boolean }

export type AmoonSendResult =
  | {
      ok: true
      id: string
      state: 'pushed' | 'sent' | 'queued'
      channel: 'file' | 'intent' | 'both'
      intentSent: boolean
      intentError: string | null
      openChat: boolean | null
      requiresAck: boolean
      /** 桥接永远返回 false：投递 ≠ 送达（bridge-tools.js:491） */
      verified: false
      remotePath: string | null
      pushError: string | null
    }
  | { ok: false; error: { code: string; message: string; details?: unknown }; queued?: { localPath: string | null } }

export type AmoonInboxMessage = {
  id: string
  kind: string
  text: string | null
  ts: string
  status: string
  unverified: true
}

export type AmoonInboxResult =
  | { ok: true; messages: AmoonInboxMessage[]; count: number; total: number; skipped: number; unverified: true }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

export type AmoonActionResult = {
  ok: boolean
  message: string
  /** 启动/停止后重新探测到的状态，面板不必再单独拉一次 */
  status?: AmoonStatus
  /** 注意：只回错误码/状态，不回传 CLI 原始 stdout/stderr（未白名单化的文本通道）。 */
}

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

export type AmoonHubDeps = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  fetchImpl?: FetchLike
  /** 测试注入用；默认 node:child_process.spawn */
  spawnImpl?: typeof spawn
  /** 直接指定桥接仓库目录（否则按 env / 上溯推导） */
  bridgeRoot?: string | null
  logger?: (line: string) => void
}

export type AmoonHub = {
  status: () => Promise<AmoonStatus>
  send: (input: AmoonSendInput) => Promise<AmoonSendResult>
  inbox: (limit?: number) => Promise<AmoonInboxResult>
  start: () => Promise<AmoonActionResult>
  stop: () => Promise<AmoonActionResult>
}

// ── 纯函数：路径与磁盘读取（单测直接覆盖）────────────────────────────────

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env[ENV_HOME]
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim())
  const localAppData = env.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData.trim()) {
    return path.join(path.resolve(localAppData.trim()), LOCAL_DIR_NAME)
  }
  if (platform === 'win32') return path.join(os.homedir(), 'AppData', 'Local', LOCAL_DIR_NAME)
  return path.join(os.homedir(), '.local', 'state', LOCAL_DIR_NAME)
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 与 lib/daemon.js:108-114 同判据：port 1..65535、pid > 0。 */
export function readRuntimeFile(stateDir: string): AmoonRuntimeInfo {
  const file = path.join(stateDir, FILE_RUNTIME)
  if (!fs.existsSync(file)) return { present: false, pid: null, port: null, malformed: false }
  const raw = readJsonFile(file)
  if (!raw || typeof raw !== 'object') return { present: true, pid: null, port: null, malformed: true }
  const rec = raw as Record<string, unknown>
  const port = rec.port
  const pid = rec.pid
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { present: true, pid: null, port: null, malformed: true }
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return { present: true, pid: null, port, malformed: true }
  }
  return { present: true, pid, port, malformed: false }
}

/**
 * 只回 presence/valid/length。token 原文只在 readOperatorTokenValue 里出现，
 * 且该函数只在 HTTP 头构造时被调用一次（lib/auth.js:350-358 的同一约定）。
 */
export function readOperatorTokenInfo(stateDir: string): AmoonTokenInfo {
  const raw = readOperatorTokenValue(stateDir)
  if (raw === null) return { present: false, valid: false, length: 0 }
  return { present: true, valid: raw.length >= TOKEN_MIN_LENGTH, length: raw.length }
}

function readOperatorTokenValue(stateDir: string): string | null {
  try {
    const text = fs.readFileSync(path.join(stateDir, FILE_OPERATOR_TOKEN), 'utf8').trim()
    return text || null
  } catch {
    return null
  }
}

/**
 * 桥接源码目录：env 优先，其次从 startDir（默认进程 cwd）逐级上溯找
 * delivery/extension/bridges/khy-amoon-bridge/bin/cli.js。
 * 开发态 electron-vite 的 cwd 是 apps/khyos-desktop，上溯 2 级即仓库根；
 * 打包后 cwd 是安装目录，通常上溯不到 → 返回 null，UI 给出明确提示而不是伪造状态。
 */
export function resolveBridgeRoot(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = process.cwd(),
): string | null {
  const looksRight = (dir: string) => fs.existsSync(path.join(dir, 'bin', 'cli.js'))

  const explicit = env[ENV_BRIDGE_DIR]
  if (typeof explicit === 'string' && explicit.trim()) {
    const dir = path.resolve(explicit.trim())
    if (looksRight(dir)) return dir
  }
  const khyDir = env[ENV_KHY_OS_DIR]
  if (typeof khyDir === 'string' && khyDir.trim()) {
    const dir = path.join(path.resolve(khyDir.trim()), 'delivery', 'extension', 'bridges', LOCAL_DIR_NAME)
    if (looksRight(dir)) return dir
  }
  let current = path.resolve(startDir)
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(current, 'delivery', 'extension', 'bridges', LOCAL_DIR_NAME)
    if (looksRight(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

// ── HTTP（Node fetch 不带 Origin，恰好满足 server.js:848 的拒绝规则）──────

type Envelope =
  | { ok: true; id?: string; data?: unknown }
  | { ok: false; error?: { code?: string; message?: string; details?: unknown }; id?: string }

function envelopeError(payload: unknown, status: number): { code: string; message: string; details?: unknown } {
  const env = (payload || {}) as Envelope
  if (env && env.ok === false && env.error) {
    return {
      code: String(env.error.code || `http_${status}`),
      message: String(env.error.message || `桥接返回 HTTP ${status}`),
      details: env.error.details,
    }
  }
  return { code: `http_${status}`, message: `桥接返回 HTTP ${status}` }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createAmoonHub(deps: AmoonHubDeps = {}): AmoonHub {
  const env = deps.env || process.env
  const platform = deps.platform || process.platform
  const fetchImpl = (deps.fetchImpl || (globalThis.fetch as unknown as FetchLike)) as FetchLike
  const spawnImpl = deps.spawnImpl || spawn
  const log = deps.logger || (() => {})
  const stateDir = resolveStateDir(env, platform)
  const root = deps.bridgeRoot !== undefined ? deps.bridgeRoot : resolveBridgeRoot(env)

  const base = (port: number) => `http://127.0.0.1:${port}`
  // 面板 hint 里显示可复制执行的命令；找不到源码时才退回占位符。
  const cliPath = root ? path.join(root, 'bin', 'cli.js') : null
  const cliCmd = cliPath ? `node "${cliPath}"` : 'node <khy-amoon-bridge>/bin/cli.js'

  async function getJson(url: string, token: string | null, timeoutMs: number): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const res = await withTimeout(
      fetchImpl(url, { method: 'GET', headers, redirect: 'error' }),
      timeoutMs,
      `GET ${url}`,
    )
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
  }

  async function callTool(tool: string, args: Record<string, unknown>, port: number, token: string, timeoutMs: number) {
    const id = `khyos_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const res = await withTimeout(
      fetchImpl(`${base(port)}/v1/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ id, tool, args }),
        redirect: 'error',
      }),
      timeoutMs,
      `POST /v1/call ${tool}`,
    )
    const body = await res.json().catch(() => null)
    if (!res.ok) return { ok: false as const, error: envelopeError(body, res.status) }
    const envl = (body || {}) as Envelope
    if (envl.ok !== true) return { ok: false as const, error: envelopeError(body, res.status) }
    return { ok: true as const, data: envl.data }
  }

  async function probe(): Promise<AmoonStatus> {
    const stateDirExists = isDirectory(stateDir)
    const token = readOperatorTokenInfo(stateDir)
    const runtime = readRuntimeFile(stateDir)
    const bridge = { root, cliFound: Boolean(root) }
    const checkedAt = new Date().toISOString()
    const baseStatus = {
      ok: true,
      stateDir,
      stateDirExists,
      token,
      runtime,
      bridge,
      checkedAt,
    }

    if (!stateDirExists) {
      return {
        ...baseStatus,
        phase: 'uninstalled',
        message: `未安装 amoo 桥接（${stateDir} 不存在）`,
        hint: `点「启动桥接」会创建状态目录与 operator.token，并启动本机 daemon；也可在终端执行 ${cliCmd} start`,
        health: false,
        daemon: null,
        canSend: false,
      }
    }

    if (!runtime.present) {
      return {
        ...baseStatus,
        phase: 'not_running',
        message: '桥接未运行（状态目录已存在，但没有 runtime.json）',
        hint: `点「启动桥接」启动本机 daemon（也可执行 ${cliCmd} start）；启动是状态变更，只会在你点击时发生。`,
        health: false,
        daemon: null,
        canSend: false,
      }
    }

    if (runtime.malformed || runtime.port === null) {
      return {
        ...baseStatus,
        ok: false,
        phase: 'unhealthy',
        message: 'runtime.json 存在但内容不合法（port/pid 缺失或越界）',
        hint: `在终端执行 ${cliCmd} stop 清理残留后重新启动。`,
        health: false,
        daemon: null,
        canSend: false,
        error: { code: 'runtime_malformed', message: 'runtime.json 不是合法运行时描述' },
      }
    }

    let health = false
    try {
      const r = await getJson(`${base(runtime.port)}/health`, null, 1500)
      health = r.status === 200 && Boolean((r.body as { ok?: boolean } | null)?.ok)
    } catch (err) {
      log(`[amoon] /health 探测失败: ${String((err as Error).message || err)}`)
    }

    if (!health) {
      return {
        ...baseStatus,
        phase: 'unhealthy',
        message: `runtime.json 存在但 /health 不通（端口 ${runtime.port}）`,
        hint: `daemon 可能已退出。先执行 ${cliCmd} stop 清理，再点「启动桥接」；面板的停止按钮也可直接清理。`,
        health: false,
        daemon: null,
        canSend: false,
        error: { code: 'health_unreachable', message: `127.0.0.1:${runtime.port}/health 不可达` },
      }
    }

    if (!token.present || !token.valid) {
      return {
        ...baseStatus,
        ok: false,
        phase: 'running',
        message: `daemon 在运行（端口 ${runtime.port}），但 operator token ${token.present ? '过短/无效' : '缺失'}`,
        hint: `token 缺失时桥接对所有写操作 fail-closed。恢复步骤：${cliCmd} stop → 删除或轮换 operator.token → ${cliCmd} start。注意 daemon 健康时直接执行 start 只会返回 already_running，不会补 token。`,
        health: true,
        daemon: null,
        canSend: false,
        error: { code: 'auth_unavailable', message: 'operator token 缺失或无效' },
      }
    }

    const tokenValue = readOperatorTokenValue(stateDir)
    if (!tokenValue) {
      return {
        ...baseStatus,
        ok: false,
        phase: 'running',
        message: `daemon 在运行（端口 ${runtime.port}），但读取 operator.token 失败`,
        hint: '检查 operator.token 的读权限（桥接用 icacls 收紧到当前用户）；需要重建时先执行 stop，再删除 token 后 start。',
        health: true,
        daemon: null,
        canSend: false,
        error: { code: 'auth_unavailable', message: 'operator.token 不可读' },
      }
    }

    try {
      const r = await getJson(`${base(runtime.port)}/status`, tokenValue, 4000)
      if (r.status === 401 || r.status === 403) {
        return {
          ...baseStatus,
          ok: false,
          phase: 'running',
          message: `daemon 在运行（端口 ${runtime.port}），但 operator token 被拒绝（HTTP ${r.status}）`,
          hint: `token 可能已轮换。恢复步骤：${cliCmd} stop → 删除或轮换 operator.token → ${cliCmd} start（daemon 健康时 start 不会自动换 token）。`,
          health: true,
          daemon: null,
          canSend: false,
          error: envelopeError(r.body, r.status),
        }
      }
      const envl = (r.body || {}) as Envelope
      if (envl.ok !== true) {
        return {
          ...baseStatus,
          ok: false,
          phase: 'running',
          message: `daemon 在运行，但 /status 返回异常（HTTP ${r.status}）`,
          hint: '面板仍可尝试发送；若发送失败请看 daemon.log。',
          health: true,
          daemon: null,
          canSend: true,
          error: envelopeError(r.body, r.status),
        }
      }
      const data = (envl.data || {}) as Record<string, unknown>
      const authRaw = (data.auth || {}) as Record<string, unknown>
      const countersRaw = (data.counters || {}) as Record<string, unknown>
      const counters: Record<string, number> = {}
      for (const [k, v] of Object.entries(countersRaw)) {
        if (typeof v === 'number') counters[k] = v
      }
      const tasks = (data.tasks || {}) as Record<string, unknown>
      const daemon: AmoonDaemonInfo = {
        protocol: typeof data.protocol === 'string' ? data.protocol : null,
        port: runtime.port,
        state: typeof data.state === 'string' ? data.state : typeof tasks.state === 'string' ? tasks.state : null,
        adbOk: typeof data.adb_ok === 'boolean' ? data.adb_ok : null,
        lastPoll: typeof data.last_poll === 'string' ? data.last_poll : null,
        lastError: typeof data.last_error === 'string' ? data.last_error : null,
        auth: {
          present: authRaw.present === true,
          valid: authRaw.valid === true,
          length: typeof authRaw.length === 'number' ? authRaw.length : 0,
        },
        counters: Object.keys(counters).length ? counters : null,
      }
      return {
        ...baseStatus,
        phase: 'running',
        message: `桥接在运行（127.0.0.1:${runtime.port}，pid ${runtime.pid}）`,
        hint: '发送只会把消息投递到手机 outbox 或启动 amoo 分享页；送达与回执都不可验证。',
        health: true,
        daemon,
        canSend: true,
      }
    } catch (err) {
      return {
        ...baseStatus,
        ok: false,
        phase: 'running',
        message: `daemon 在运行（端口 ${runtime.port}），但 /status 请求失败`,
        hint: '检查 daemon.log；面板仍可尝试发送。',
        health: true,
        daemon: null,
        canSend: true,
        error: { code: 'status_failed', message: String((err as Error).message || err) },
      }
    }
  }

  async function currentRuntimeOrError(): Promise<
    { ok: true; port: number; token: string } | { ok: false; error: { code: string; message: string } }
  > {
    const stateDirExists = isDirectory(stateDir)
    if (!stateDirExists) {
      return { ok: false, error: { code: 'uninstalled', message: `未安装 amoo 桥接（${stateDir} 不存在）` } }
    }
    const runtime = readRuntimeFile(stateDir)
    if (!runtime.present || runtime.port === null) {
      return { ok: false, error: { code: 'daemon_unavailable', message: '桥接未运行：请先点「启动桥接」' } }
    }
    const token = readOperatorTokenValue(stateDir)
    if (!token || token.length < TOKEN_MIN_LENGTH) {
      return { ok: false, error: { code: 'auth_unavailable', message: 'operator token 缺失或无效：桥接拒绝写操作' } }
    }
    return { ok: true, port: runtime.port, token }
  }

  return {
    status: probe,

    async send(input) {
      const text = String(input?.text ?? '')
      if (text.trim().length === 0) {
        return { ok: false, error: { code: 'invalid_args', message: '消息不能为空' } }
      }
      if (text.length > 4000) {
        return { ok: false, error: { code: 'invalid_args', message: `消息超过 4000 字（当前 ${text.length}）` } }
      }
      const ready = await currentRuntimeOrError()
      if (!ready.ok) return { ok: false, error: ready.error }

      const res = await callTool(
        'amoon_send',
        { text, mode: 'file', open_chat: input.openChat === true, requires_ack: true },
        ready.port,
        ready.token,
        35000,
      )
      if (!res.ok) {
        // file 模式 push 失败时桥会抛 BridgeError(details={state:'queued',local_path})
        // （lib/bridge-tools.js:441-447）。这不是「发送失败」而是「只留在本机」，
        // 必须把 local_path 交给面板，不能退化成一条错误码。
        const details = (res.error as { details?: unknown }).details
        if (details && typeof details === 'object' && (details as { state?: unknown }).state === 'queued') {
          const localPath = (details as { local_path?: unknown }).local_path
          return {
            ok: false,
            error: res.error,
            queued: { localPath: typeof localPath === 'string' ? localPath : null },
          }
        }
        return { ok: false, error: res.error }
      }
      const d = (res.data || {}) as Record<string, unknown>
      const state = d.state === 'pushed' || d.state === 'sent' || d.state === 'queued' ? d.state : 'queued'
      return {
        ok: true,
        id: typeof d.id === 'string' ? d.id : '',
        state,
        channel: d.channel === 'intent' || d.channel === 'both' ? d.channel : 'file',
        intentSent: d.intent_sent === true,
        intentError: typeof d.intent_error === 'string' ? d.intent_error : null,
        openChat: typeof d.open_chat === 'boolean' ? d.open_chat : null,
        requiresAck: d.requires_ack !== false,
        verified: false,
        remotePath: typeof d.remote_path === 'string' ? d.remote_path : null,
        pushError: typeof d.push_error === 'string' ? d.push_error : null,
      }
    },

    async inbox(limit = 20) {
      const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)))
      const ready = await currentRuntimeOrError()
      if (!ready.ok) return { ok: false, error: ready.error }
      const res = await callTool('amoon_inbox', { limit: safeLimit }, ready.port, ready.token, 15000)
      if (!res.ok) return { ok: false, error: res.error }
      const d = (res.data || {}) as Record<string, unknown>
      const list = Array.isArray(d.messages) ? d.messages : []
      const messages: AmoonInboxMessage[] = []
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue
        const m = raw as Record<string, unknown>
        messages.push({
          id: typeof m.id === 'string' ? m.id : '',
          kind: typeof m.kind === 'string' ? m.kind : 'reply',
          text: typeof m.text === 'string' ? m.text : null,
          ts: typeof m.ts === 'string' ? m.ts : '',
          status: typeof m.status === 'string' ? m.status : 'received',
          unverified: true,
        })
      }
      return {
        ok: true,
        messages,
        count: typeof d.count === 'number' ? d.count : messages.length,
        total: typeof d.total === 'number' ? d.total : messages.length,
        skipped: typeof d.skipped === 'number' ? d.skipped : 0,
        unverified: true,
      }
    },

    async start() {
      if (!root) {
        return {
          ok: false,
          message: '未找到 khy-amoon-bridge 源码目录：请设置 KHY_AMOON_BRIDGE_DIR 或 KHY_OS_DIR 后重启桌面端',
          status: await probe(),
        }
      }
      const cli = path.join(root, 'bin', 'cli.js')
      if (!fs.existsSync(cli)) {
        return { ok: false, message: `桥接 CLI 不存在：${cli}`, status: await probe() }
      }
      const envChild: NodeJS.ProcessEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
      const runCli = async (verb: 'start' | 'stop', timeoutMs: number) => {
        const child = spawnImpl(process.execPath, [cli, verb, '--state-dir', stateDir], {
          cwd: root,
          env: envChild,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }) as unknown as ChildProcess
        const r = await collectProcess(child, timeoutMs)
        log(`[amoon] ${verb} exit=${r.code} ${r.tail}`)
        return r
      }

      const before = await probe()
      // daemon 健康且 token 可用：CLI start 只会回 already_running，直接返回事实。
      if (before.phase === 'running' && before.canSend) {
        return { ok: true, message: `${before.message}（已在运行）`, status: before }
      }
      // runtime.json 残留（不健康/malformed）或 token 不可用：先 stop 清理，避免撞 daemon.lock。
      if (before.runtime.present) {
        await runCli('stop', 12000)
      }
      await runCli('start', 25000)
      const status = await probe()
      return {
        ok: status.phase === 'running' && status.health,
        message: status.ok ? status.message : `启动后仍未就绪：${status.message}`,
        status,
      }
    },

    async stop() {
      if (!root) {
        return { ok: false, message: '未找到 khy-amoon-bridge 源码目录：请设置 KHY_AMOON_BRIDGE_DIR 或 KHY_OS_DIR 后重启桌面端', status: await probe() }
      }
      const cli = path.join(root, 'bin', 'cli.js')
      const child = spawnImpl(process.execPath, [cli, 'stop', '--state-dir', stateDir], {
        cwd: root,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as unknown as ChildProcess
      const output = await collectProcess(child, 12000)
      log(`[amoon] stop exit=${output.code} ${output.tail}`)
      const status = await probe()
      return {
        ok: status.phase !== 'running',
        message: status.phase === 'running' ? `停止命令已执行，但 daemon 仍在运行（${status.message}）` : '已停止 amoo 桥接',
        status,
      }
    },
  }
}

function collectProcess(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve) => {
    let text = ''
    let done = false
    const finish = (code: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, tail: text.trim().slice(-1200) })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 进程可能已退出 */
      }
      finish(null)
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
      if (text.length > 8000) text = text.slice(-8000)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
      if (text.length > 8000) text = text.slice(-8000)
    })
    child.once('error', (err) => {
      text += `\n${String(err)}`
      finish(null)
    })
    child.once('close', (code) => finish(typeof code === 'number' ? code : null))
  })
}
