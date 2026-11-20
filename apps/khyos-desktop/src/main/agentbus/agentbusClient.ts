/*
 * agentbusClient.ts — the lane's session object: handshake, call, event read
 * loop, abort. It owns no spawn and no socket of its own — the child processes,
 * the framed connection and the status probe live in ./agentbusTransport, so the
 * warm/cold state machine below stays the only thing this file decides.
 *
 * Split from the pure modules on purpose: everything that decides what a byte
 * MEANS lives in ./agentbusProtocol; everything that decides what a byte COSTS
 * lives here. A test can therefore pin the protocol against a loopback fake
 * service without a phone, and pin this shell's failure classification against a
 * fake adb.
 *
 * Warm/cold stream rule — read it twice, it is inverted from the intuitive
 * reading and from an earlier draft of this lane. Measured against the
 * reference implementation (D:/Temp/stepx-src/desktop/src/amoo.rs):
 *   perform_handshake ends with `self.has_completed_rpc = false;` (:1125) and
 *   reconnect_stream does the same (:1149); only a NON-connect RPC that returns
 *   successfully sets it true (:1449-1451); the retry gate is
 *   `can_retry_stale_warm_stream = method != "connect" && self.has_completed_rpc`
 *   (:1336). So the stream is COLD right after the handshake: a clean EOF before
 *   any RPC has succeeded is never replayed.
 *   - cold stream, any failure (including a clean EOF): no reconnect, no
 *     resend, report the error.
 *   - warm stream (at least one non-connect RPC already succeeded on THIS
 *     connection) + clean EOF with ZERO response bytes read: one reconnect (new
 *     forward port + new socket + new handshake) and one resend under a new id.
 *   - partial header/body, non-EOF read error, read timeout: never resend.
 *   - write failure: never resend. The reference allows a warm-stream reconnect
 *     here (:1354-1361); this lane is deliberately stricter because chat.send
 *     spends the user's phone quota and produces a user-visible turn, and a
 *     half-written frame cannot be classified as safe to replay (the reference's
 *     own native-capability path refuses it the same way, amoo.rs:1290).
 *
 * Nothing crosses IPC from here except classified results.
 */

import net from 'node:net'
import crypto from 'node:crypto'
import {
  LOOPBACK_HOST,
  encodeFrame,
  resolveAgentbusConfig,
  type AgentbusConfig,
} from './agentbusProtocol.ts'
import {
  chatAbortParams,
  helloParams,
  helloServer,
  matchResponse,
  parseStepclawStatus,
  parseStreamEvent,
  requestEnvelope,
  type StepclawStatus,
  type StreamDelta,
} from './agentbusProtocol.ts'
import { createAdb, safeKill, withDeadline, type Adb, type SpawnLike } from './agentbusTransport.ts'
import { FrameStream, connectLoopback, probeStatus, type AgentbusStatus, type ProbeSession } from './agentbusTransport.ts'

/** chat.abort is best-effort: wait this long, then stop caring about the answer. */
const ABORT_TIMEOUT_MS = 3000

// AgentbusStatus / AgentbusStatusCode now live in ./agentbusTransport next to the
// probe that produces them (the client consumes them, it does not define them).

export type CallResult = { ok: true; payload: Record<string, unknown> } | { ok: false; code: string; message: string }

export type NextEventResult =
  | { kind: 'delta'; delta: StreamDelta }
  | { kind: 'status'; status: StepclawStatus }
  | { kind: 'timeout' }
  | { kind: 'eof' }

export type AgentbusClientDeps = {
  config?: AgentbusConfig
  /** Injected for tests; defaults to node:child_process.spawn. */
  spawnImpl?: SpawnLike
  /** Injected for tests; defaults to a real net.connect to LOOPBACK_HOST. */
  connectImpl?: (port: number, timeoutMs: number) => Promise<net.Socket>
  now?: () => number
  logger?: (line: string) => void
  /** 16 random bytes -> 32 hex chars. Injected so ids are reproducible in tests. */
  randomHex?: (bytes: number) => string
}

export function createAgentbusClient(deps: AgentbusClientDeps = {}) {
  const config = deps.config || resolveAgentbusConfig()
  const connectImpl = deps.connectImpl || ((port: number, timeoutMs: number) => connectLoopback(port, timeoutMs))
  const now = deps.now || (() => Date.now())
  const log = deps.logger || (() => {})
  const randomHex = deps.randomHex || ((bytes: number) => crypto.randomBytes(bytes).toString('hex'))

  const adb: Adb = createAdb({
    adbPath: config.adb.path,
    serial: config.adb.serial,
    remoteSpec: config.bus.remoteSpec,
    timeoutMs: config.adb.timeoutMs,
    spawnImpl: deps.spawnImpl,
    logger: log,
  })

  // Forward-port cache, keyed by adb path + serial + remote spec. The hub holds
  // one client for the process lifetime, so this is effectively process-scoped:
  // round two reuses the tunnel round one already established.
  const portCache = new Map<string, number>()
  const portKey = `${config.adb.path}|${config.adb.serial}|${config.bus.remoteSpec}`

  const stream = new FrameStream()
  let tainted = false
  /** True only after a non-connect RPC succeeded on the CURRENT connection. */
  let hasCompletedRpc = false
  let serverVersion = ''
  let lastStatus: StepclawStatus | null = null
  const pendingEvents: StreamDelta[] = []

  function newId(): string {
    return `${config.bus.idPrefix}${randomHex(16)}`
  }

  function resetRoundState(): void {
    tainted = false
    hasCompletedRpc = false
    lastStatus = null
    pendingEvents.length = 0
  }

  function detach(): void {
    stream.detach()
    resetRoundState()
  }

  /** Cached tunnel first; a stale one is dropped best-effort before a fresh forward. */
  async function openSocket(): Promise<{ ok: true; port: number } | { ok: false; code: string; message: string }> {
    const cached = portCache.get(portKey)
    if (cached !== undefined) {
      const first = await tryConnect(cached)
      if (first.ok) return { ok: true, port: cached }
      await adb.removeForward(cached)
      portCache.delete(portKey)
    }
    const fresh = await adb.forwardFresh()
    if (!fresh.ok) return fresh
    const second = await tryConnect(fresh.port)
    if (!second.ok) {
      await adb.removeForward(fresh.port)
      return second
    }
    return { ok: true, port: fresh.port }
  }

  function tryConnect(port: number): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: { ok: true } | { ok: false; code: string; message: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(
        () => finish({ ok: false, code: 'connect_failed', message: '连接 Amoo 后台服务超时' }),
        Math.max(1, config.bus.handshakeMs),
      )
      if (typeof timer.unref === 'function') timer.unref()
      connectImpl(port, config.bus.handshakeMs).then(
        (sock) => {
          stream.attach(sock)
          finish({ ok: true })
        },
        (err: Error) => finish({ ok: false, code: 'connect_failed', message: String(err?.message || err) }),
      )
    })
  }

  async function performHandshake(): Promise<{ ok: true; serverVersion: string } | { ok: false; code: string; message: string }> {
    const clientId = `${config.bus.clientIdPrefix}${randomHex(8)}`
    const hello = await call(
      'connect',
      helloParams({
        protocol: config.bus.protocol,
        clientId,
        clientVersion: config.bus.clientVersion,
        platform: config.bus.platform,
      }),
      config.bus.handshakeMs,
    )
    if (!hello.ok) return hello
    const server = helloServer(hello.payload, config.bus.protocol)
    if (!server.ok) return { ok: false, code: 'protocol_unsupported', message: server.error }
    // The stream is COLD after a handshake (amoo.rs:1125). call() only ever sets
    // hasCompletedRpc for a non-connect method, so this is belt and braces.
    hasCompletedRpc = false
    serverVersion = server.server.version
    return { ok: true, serverVersion: server.server.version }
  }

  /** New socket (cached port first) + handshake. Resets the warm/cold bookkeeping. */
  async function reconnect(): Promise<boolean> {
    detach()
    const opened = await openSocket()
    if (!opened.ok) return false
    const hello = await performHandshake()
    if (!hello.ok) {
      // A handshake failure means this tunnel talks to something that is not the
      // service we asked for: drop it so the next round takes a fresh one.
      detach()
      await adb.removeForward(opened.port)
      portCache.delete(portKey)
      return false
    }
    portCache.set(portKey, opened.port)
    return true
  }

  async function call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<CallResult> {
    if (!stream.isOpen && method !== 'connect') return { ok: false, code: 'not_open', message: '尚未建立连接' }
    // A tainted stream is reconnected before a non-connect RPC (amoo.rs:1333-1334).
    if (method !== 'connect' && tainted) {
      const reconnected = await reconnect()
      if (!reconnected) return { ok: false, code: 'stream_lost', message: '与手机的连接中断：这一轮的状态无法确认' }
    }
    const canRetryStaleWarmStream = method !== 'connect' && hasCompletedRpc
    let retriedWarmStream = false
    for (;;) {
      // Ids must stay unique across reconnects: the bus multiplexes clients
      // upstream and a replayed id can be matched to the wrong reply.
      const id = newId()
      const encoded = encodeFrame(requestEnvelope(id, method, params))
      if (!encoded.ok) return { ok: false, code: 'frame_too_large', message: '请求帧超过上限' }
      const written = await stream.write(encoded.bytes, Math.min(timeoutMs, config.adb.timeoutMs))
      if (!written.ok) {
        // A partial write is ambiguous: this lane never classifies it as safe to
        // resubmit, so it never resends (stricter than amoo.rs:1354-1361).
        tainted = true
        portCache.delete(portKey)
        return { ok: false, code: 'write_failed', message: '写入手机端失败：这一轮的状态无法确认' }
      }
      const readMark = stream.totalBytes
      const deadlineMs = Math.max(1, Number(timeoutMs) || 1)
      const startedAt = now()
      let resend = false
      for (;;) {
        const read = await stream.read(Math.max(1, deadlineMs - (now() - startedAt)))
        if (read.kind === 'timeout') {
          tainted = true
          return { ok: false, code: 'rpc_timeout', message: '等待手机端响应超时' }
        }
        if (read.kind === 'eof' || read.kind === 'error') {
          tainted = true
          // ANY response byte kills the replay: bytes read during this call, or a
          // half-read frame the peer already delivered. A partial header/body is
          // already proof the peer answered, so replaying is not provably safe
          // (amoo.rs:1400-1402).
          const sawResponseBytes = stream.totalBytes > readMark || stream.hasPartialFrame()
          // Only a clean EOF with zero response bytes on a warm stream earns the
          // single reconnect-and-resend; anything else fails the RPC as-is.
          if (read.kind === 'eof' && !sawResponseBytes && canRetryStaleWarmStream && !retriedWarmStream) {
            retriedWarmStream = true
            resend = await reconnect()
          }
          if (resend) break
          return { ok: false, code: 'stream_lost', message: '与手机的连接中断：这一轮的状态无法确认' }
        }
        const status = parseStepclawStatus(read.frame)
        if (status) lastStatus = status
        const delta = parseStreamEvent(read.frame)
        if (delta) pendingEvents.push(delta)
        const matched = matchResponse(read.frame, id)
        if (matched.kind === 'not_ours') continue
        if (matched.kind === 'error') {
          return { ok: false, code: `server_${matched.code}`, message: `Amoo 后台请求失败（${matched.code}）：${matched.message}` }
        }
        if (matched.kind === 'incomplete') return { ok: false, code: 'incomplete', message: 'Amoo 后台未完成请求' }
        if (matched.kind === 'malformed') return { ok: false, code: 'malformed', message: matched.message }
        if (method !== 'connect') hasCompletedRpc = true
        return { ok: true, payload: matched.payload }
      }
    }
  }

  // ── public surface ─────────────────────────────────────────────────────────

  /** Open a fresh connection for one round: forward (or reuse) + socket + handshake. */
  async function open(): Promise<{ ok: true; serverVersion: string } | { ok: false; code: string; message: string }> {
    detach()
    const opened = await openSocket()
    if (!opened.ok) return opened
    const hello = await performHandshake()
    if (!hello.ok) {
      // A handshake failure means this tunnel is not talking to the service we
      // asked for: drop it so the next round takes a fresh one.
      detach()
      await adb.removeForward(opened.port)
      portCache.delete(portKey)
      return hello
    }
    portCache.set(portKey, opened.port)
    return hello
  }

  /** Drain one event or status within waitMs. 'eof' means the caller must fail the round. */
  async function nextEvent(waitMs: number): Promise<NextEventResult> {
    if (pendingEvents.length > 0) return { kind: 'delta', delta: pendingEvents.shift() as StreamDelta }
    const read = await stream.read(Math.max(1, Number(waitMs) || 1))
    if (read.kind === 'timeout') return { kind: 'timeout' }
    // An EOF or a read error on the event path fails the round: the reference's
    // poll_stream_events also only marks the stream tainted on EOF
    // (amoo.rs:1475-1477) and never replays from there.
    if (read.kind === 'eof' || read.kind === 'error') return { kind: 'eof' }
    const status = parseStepclawStatus(read.frame)
    if (status) {
      lastStatus = status
      return { kind: 'status', status }
    }
    const delta = parseStreamEvent(read.frame)
    if (delta) {
      pendingEvents.push(delta)
      return { kind: 'delta', delta }
    }
    return { kind: 'timeout' }
  }

  /** Best-effort abort: about 3s, result ignored, never rejects. */
  async function abort(sessionKey: string, runId: string): Promise<void> {
    if (!stream.isOpen || tainted) {
      log('[agentbus] abort 跳过：连接已断开，手机侧任务不受影响')
      return
    }
    await withDeadline(call('chat.abort', chatAbortParams(sessionKey, runId), ABORT_TIMEOUT_MS), ABORT_TIMEOUT_MS).catch(
      () => ({ __deadline: true } as const),
    )
  }

  function close(): void {
    detach()
  }

  function newRequestId(): string {
    return newId()
  }

  function lastStepclawStatus(): StepclawStatus | null {
    return lastStatus
  }

  // The probe is a distinct concern (observe semantics: no lease, no task window,
  // never while a round owns the connection) and lives in ./agentbusTransport
  // next to the adb child and the framed connection it needs, so this factory
  // stays a readable state machine. It is NOT in ./agentbusProbe — that file does
  // not exist.
  const probeSession: ProbeSession = {
    config,
    adb,
    isOpen: () => stream.isOpen,
    serverVersion: () => serverVersion,
    open,
    close,
  }

  return {
    config,
    status: () => probeStatus(probeSession),
    open,
    call,
    nextEvent,
    abort,
    close,
    lastStepclawStatus,
    newRequestId,
  }
}

export type AgentbusClient = ReturnType<typeof createAgentbusClient>
