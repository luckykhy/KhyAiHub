// 移动端远程控制（Web Remote Control）在主进程的接线层。
//
// 分工：协议/HTTP/WS/配对全在后端 `runtime/node/backend/src/webRemoteControl/`
// （那里不认识 Electron）；本文件只做三件事——
//   1. 按路径 require 后端模块（CH-2 服务直调，与 host 桥 aiGateway 同一手法）；
//   2. 把后端的六个动作（列工作区/列任务/读会话/发消息/中止/转达审批）落到
//      既有的 main↔host fork IPC 通道上，不新造第二条会话通路；
//   3. 把 host 的 ai.* 流事件抄一份灌给手机（consume()，在主 handleHostMessage 顶部）。
//
// 工具执行权限不在这里判定：ai.controlRequest 只是被转达，批准与否由桌面端
// 自己的审批 UI 和 host 的 desktopGate 决定，手机与桌面同时应答时以先到者为准。

import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

type HostMessage = { type?: string; id?: string; [k: string]: unknown }

export type RemoteHub = {
  start: (opts?: { lanEnabled?: boolean }) => Promise<Record<string, unknown>>
  stop: () => Promise<Record<string, unknown>>
  status: () => Record<string, unknown>
  refreshQr: () => Promise<Record<string, unknown>>
  approve: (pairingId: string, role: string) => Promise<Record<string, unknown>>
  reject: (pairingId: string) => Promise<Record<string, unknown>>
  revoke: (deviceId: string) => Promise<Record<string, unknown>>
  consume: (m: HostMessage) => boolean
  running: () => boolean
  probeBridge: () => Promise<Record<string, unknown>>
}

type Deps = {
  sendToHost: (m: Record<string, unknown>) => void
  hostAlive: () => boolean
  getWorkspaceRoot: () => Promise<string>
  // 面板的事件出口：status 变化与待确认配对推给渲染进程。
  onEvent: (payload: Record<string, unknown>) => void
  logger?: (line: string) => void
}

// 后端根目录：env 优先，否则从 out/main 上溯 4 级到仓库根
// （out/main → out → khyos-desktop → apps → <repo>），与 app:brandingLinks 同一基准。
function resolveBackendSrc(): string {
  const root = process.env.KHY_OS_DIR
    ? path.resolve(process.env.KHY_OS_DIR)
    : path.resolve(__dirname, '..', '..', '..', '..')
  const src = path.join(root, 'runtime', 'node', 'backend', 'src')
  if (!fs.existsSync(path.join(src, 'webRemoteControl', 'index.js'))) {
    throw new Error(
      `未找到远程控制模块（${path.join(src, 'webRemoteControl')}）：请设置 KHY_OS_DIR 指向 khy-os 仓库根后重启`,
    )
  }
  return src
}

// 局域网 IPv4 探测复用后端真源 src/cli/handlers/mobile.js 的 getLanIPv4（含虚拟网卡
// 降权排序），不在桌面端复制第二份网卡启发式。
function lanIPv4(): string {
  try {
    const src = resolveBackendSrc()
    const mobile = nodeRequire(path.join(src, 'cli', 'handlers', 'mobile.js'))
    return mobile.getLanIPv4().best || '127.0.0.1'
  } catch {
    return '127.0.0.1'
  }
}

let rpcSeq = 0
function nextId(prefix: string): string {
  rpcSeq += 1
  return `${prefix}_${Date.now().toString(36)}_${rpcSeq}`
}

export function createRemoteHub(deps: Deps): RemoteHub {
  const pending = new Map<string, (m: HostMessage) => void>()
  let server: any = null
  let lanEnabled = false
  let activeGeneration: string | null = null

  function askHost(type: string, fields: Record<string, unknown>, timeoutMs: number): Promise<HostMessage> {
    return new Promise((resolve) => {
      if (!deps.hostAlive()) {
        resolve({ ok: false, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' })
        return
      }
      const id = nextId('remote')
      // 仅 reject/resolve 的 RPC 超时，不 kill 任何在途任务（RUNTIME-003 合法例外：
      // 只 reject 的 Promise 超时）。到点只报告「没回音」，host 侧该跑完还跑完。
      const timer = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        resolve({ ok: false, error: `${type} 无响应（${Math.round(timeoutMs / 1000)}s）：host 仍在处理，可在桌面端继续查看` })
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, (m) => {
        clearTimeout(timer)
        pending.delete(id)
        resolve(m)
      })
      deps.sendToHost({ type, id, ...fields })
    })
  }

  function ensureServer() {
    if (server) return server
    const src = resolveBackendSrc()
    const mod = nodeRequire(path.join(src, 'webRemoteControl', 'index.js'))
    const { REMOTE_DEFAULT_PORT } = nodeRequire(path.join(src, 'constants', 'serviceDefaults.js'))
    server = mod.createRemoteControl({
      port: REMOTE_DEFAULT_PORT,
      isLanEnabled: () => lanEnabled,
      logger: {
        info: (line: string) => deps.logger?.(line),
        warn: (line: string) => deps.logger?.(line),
      },
      onStatus: (s: Record<string, unknown>) => deps.onEvent({ kind: 'status', ...s }),
      onPairRequest: (r: Record<string, unknown>) => deps.onEvent({ kind: 'pairRequest', ...r }),
      capabilities: {
        async listWorkspaces() {
          const root = await deps.getWorkspaceRoot()
          return [{ path: root, name: path.basename(root) }]
        },
        async listTasks() {
          const r = await askHost('session.list', { limit: 50 }, 15000)
          if (!r.ok) return []
          return (r.sessions as unknown[]) || []
        },
        async loadSession({ sessionId }: { sessionId: string }) {
          return askHost('session.messages', { sessionId }, 30000)
        },
        async sendMessage({ text }: { text: string }) {
          if (!deps.hostAlive()) throw new Error('host 进程未启动：请重启 KhyOS Desktop 后重试')
          const id = nextId('remote_gen')
          activeGeneration = id
          deps.sendToHost({ type: 'ai.generate', id, prompt: text, options: { cwd: await deps.getWorkspaceRoot() } })
          return { ok: true, generationId: id }
        },
        async abort() {
          if (!activeGeneration) return { ok: false, error: '当前没有在途任务：无需中止' }
          deps.sendToHost({ type: 'ai.abort', id: activeGeneration })
          return { ok: true }
        },
        async respondControl({ requestId, response }: { requestId: string; response: unknown }) {
          deps.sendToHost({ type: 'ai.controlResponse', id: nextId('remote_ctl'), requestId, response })
          return { ok: true }
        },
        async gateState() {
          const r = await askHost('desktopGate.get', {}, 8000)
          return r.gate ?? null
        },
      },
    })
    return server
  }

  return {
    async start(opts) {
      if (typeof opts?.lanEnabled === 'boolean') lanEnabled = opts.lanEnabled
      if (server && server.getStatus().status !== 'idle') {
        await server.stop()
      }
      const s = ensureServer()
      try {
        return await s.start()
      } catch (err) {
        throw new Error(String((err as Error).message || err))
      }
    },
    async stop() {
      if (!server) return { ok: true }
      await server.stop()
      return { ok: true }
    },
    status() {
      if (!server) {
        return { status: 'idle', detail: '等待连接。', lanEnabled, devices: [], pending: [] }
      }
      return { ...server.getStatus(), lanEnabled }
    },
    async refreshQr() {
      if (!server) throw new Error('远程控制未开启：请先点「开启」再生成二维码')
      return server.refreshQr()
    },
    async approve(pairingId, role) {
      if (!server) throw new Error('远程控制未开启：没有待确认的配对')
      return server.approvePairing(pairingId, role)
    },
    async reject(pairingId) {
      if (!server) return { ok: false }
      return server.rejectPairing(pairingId)
    },
    async revoke(deviceId) {
      if (!server) return { ok: false }
      return server.revokeDevice(deviceId)
    },
    // 控制对象 = 后端 CLI 会话：bridge 服务器活在 CLI 进程里，桌面端既不代它启动，
    // 也拿不到它打印的 PIN —— 探测到就出地址二维码，探测不到就如实说。
    async probeBridge() {
      let base = 0
      try {
        const src = resolveBackendSrc()
        base = nodeRequire(path.join(src, 'constants', 'serviceDefaults.js')).BRIDGE_DEFAULT_PORT
      } catch (err) {
        return { found: false, error: `未读取到 bridge 默认端口：${String((err as Error).message || err)}` }
      }
      for (let i = 0; i <= 3; i += 1) {
        const port = base + i
        try {
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 1200)
          timer.unref?.()
          const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal })
          clearTimeout(timer)
          if (res.ok || res.status === 401) {
            return { found: true, port, url: `http://${lanIPv4()}:${port}` }
          }
        } catch {
          /* 该端口没在监听，试下一个 */
        }
      }
      return {
        found: false,
        port: base,
        error: `未发现运行中的 CLI 会话（探测端口 ${base}-${base + 3}）：请先在终端执行 khy bridge start 后重新探测`,
      }
    },
    running() {
      return Boolean(server && server.getStatus().status !== 'idle')
    },
    // 主 handleHostMessage 顶部的抄送口：先结算自己发的 RPC（id 前缀 remote_），
    // 再把远程控制发起的生成事件转给手机。
    consume(m) {
      if (!m?.id) return false
      const waiter = pending.get(String(m.id))
      if (waiter) {
        waiter(m)
        return true
      }
      if (!server || !String(m.id).startsWith('remote_gen')) return false
      if (m.type === 'ai.chunk') {
        const raw = m.chunk
        const text = typeof raw === 'string' ? raw : ((raw as any)?.text ?? (raw as any)?.content ?? '')
        server.broadcastStream({ kind: 'chunk', text: String(text ?? '') })
        return false // 不吞：桌面端窗口同样要看流
      }
      if (m.type === 'ai.toolCall') {
        server.broadcastStream({ kind: 'tool_call', tool: String(m.tool || '') })
        return false
      }
      if (m.type === 'ai.toolResult') {
        server.broadcastStream({ kind: 'tool_result', tool: String(m.tool || ''), ok: m.ok !== false })
        return false
      }
      if (m.type === 'ai.controlRequest') {
        server.broadcastControl({ requestId: String(m.requestId || ''), request: m.request })
        return false
      }
      if (m.type === 'ai.result') {
        activeGeneration = null
        server.broadcastStream({
          kind: 'end',
          ok: m.ok !== false,
          text: typeof m.text === 'string' ? m.text : '',
          error: typeof m.error === 'string' ? m.error : undefined,
        })
        return false
      }
      return false
    },
  }
}
