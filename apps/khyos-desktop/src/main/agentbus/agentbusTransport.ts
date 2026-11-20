/*
 * agentbusTransport.ts — the lane's IO plumbing: the adb child process, the
 * framed TCP connection, and the status probe. Split out of agentbusClient.ts
 * (and merged down from three files) for the same reason as the pure module:
 * scripts/ci/check-change-safety.js caps a change set at 20 files, and this lane
 * was over it. The ratchet's caps still hold; each section keeps its provenance.
 *
 * Two rules encoded here rather than left to the caller:
 *   1. A child that outlives its budget is killed with SIGTERM then SIGKILL, via
 *      withDeadline + onExpire(safeKill) — never a bare setTimeout+kill
 *      (precedent: amooBridgeClient.js:102 / :293-298).
 *   2. `forward tcp:0 <spec>` stdout is the ONLY adb output parsed as a port.
 *      `forward --remove tcp:<port>` is best-effort and its output is discarded:
 *      a successful remove prints nothing, so reusing the port rule would
 *      misreport every success as forward_failed.
 *
 * stderr never leaves the process: it goes to the injected logger, capped, and
 * is never handed to IPC (precedent src/main/amoon/index.ts:104).
 */

// ── child-process helpers + every adb command this lane runs ───────────────────────────────────────────────────────────────────

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { FrameDecoder } from './agentbusProtocol.ts'
import { LOOPBACK_HOST, type AgentbusConfig } from './agentbusProtocol.ts'

/** adb child stdout/stderr accumulation cap (precedent: amoon/index.ts:678). */
const TEXT_CAP = 8000

export type ChildLike = {
  stdout: { on(event: string, cb: (chunk: Buffer) => void): unknown } | null
  stderr: { on(event: string, cb: (chunk: Buffer) => void): unknown } | null
  on(event: string, cb: (...args: unknown[]) => void): unknown
  once(event: string, cb: (...args: unknown[]) => void): unknown
  kill(signal?: string): boolean
  pid?: number
}

export type SpawnLike = (command: string, args: string[], options: Record<string, unknown>) => ChildLike

export type AdbResult =
  | { ok: true; stdout: string }
  | { ok: false; code: 'adb_not_found' | 'timeout' | 'nonzero' | 'spawn_failed'; message: string }

/** Race a promise against a deadline; the kill happens in the caller's onExpire. */
export function withDeadline<T>(promise: Promise<T>, timeoutMs: number, onExpire?: () => void): Promise<T | { __deadline: true }> {
  let timer: NodeJS.Timeout | null = null
  const clear = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  const deadline = new Promise<{ __deadline: true }>((resolve) => {
    timer = setTimeout(() => resolve({ __deadline: true }), Math.max(1, Number(timeoutMs) || 1))
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, deadline]).then(
    (value) => {
      clear()
      if (value && (value as { __deadline?: boolean }).__deadline === true && typeof onExpire === 'function') onExpire()
      return value
    },
    (error) => {
      clear()
      throw error
    },
  )
}

/** SIGTERM, then SIGKILL after a grace period. Never throws. */
export function safeKill(child: ChildLike, signal = 'SIGTERM', graceMs = 3000): void {
  try {
    if (child.pid && !child.kill(signal)) return
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, Math.max(1, graceMs))
    if (typeof timer.unref === 'function') timer.unref()
  } catch {
    /* already gone */
  }
}

/** One row of `adb devices`. State is the peer's own word (device/unauthorized/offline). */
export type AdbDeviceRow = { serial: string; state: string }

export function parseAdbDevices(stdout: string): AdbDeviceRow[] {
  const rows: AdbDeviceRow[] = []
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (/^List of devices attached/i.test(line)) continue
    if (/^\*|^adb server|^start daemon/i.test(line)) continue
    const parts = line.split(/\s+/)
    if (parts.length < 2) continue
    rows.push({ serial: parts[0], state: parts[1] })
  }
  return rows
}

export type Adb = {
  run: (args: string[]) => Promise<AdbResult>
  /** Device table rows; the caller decides whether the configured serial is in it. */
  devices: () => Promise<AdbResult>
  /** `adb forward tcp:0 <spec>` -> local port. */
  forwardFresh: () => Promise<{ ok: true; port: number } | { ok: false; code: string; message: string }>
  /** `adb forward --remove tcp:<port>`, result ignored by contract. */
  removeForward: (port: number) => Promise<void>
}

export function createAdb(deps: {
  adbPath: string
  serial: string
  remoteSpec: string
  timeoutMs: number
  spawnImpl?: SpawnLike
  logger?: (line: string) => void
}): Adb {
  const spawnImpl: SpawnLike =
    deps.spawnImpl ||
    ((command, args, options) => spawn(command, args, options as unknown as SpawnOptions) as unknown as ChildLike)
  const log = deps.logger || (() => {})

  function run(args: string[]): Promise<AdbResult> {
    return new Promise((resolve) => {
      let child: ChildLike
      try {
        // ADB_MDNS_OPENSCREEN keeps the mDNS discovery screen from popping up on
        // the phone for a command that only reads the device table.
        child = spawnImpl(deps.adbPath, args, {
          windowsHide: true,
          env: { ...process.env, ADB_MDNS_OPENSCREEN: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (err) {
        resolve({ ok: false, code: 'spawn_failed', message: String((err as Error)?.message || err) })
        return
      }
      let stdout = ''
      let stderr = ''
      let done = false
      const finish = (result: AdbResult) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (stderr.trim()) log(`[agentbus] adb ${args.join(' ')} stderr: ${stderr.trim().slice(0, TEXT_CAP)}`)
        resolve(result)
      }
      const timer = setTimeout(() => {
        safeKill(child, 'SIGTERM')
        finish({ ok: false, code: 'timeout', message: `adb 命令超时（${deps.timeoutMs}ms）` })
      }, Math.max(1, Number(deps.timeoutMs) || 1))
      if (typeof timer.unref === 'function') timer.unref()
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (stdout.length > TEXT_CAP) stdout = stdout.slice(-TEXT_CAP)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
        if (stderr.length > TEXT_CAP) stderr = stderr.slice(-TEXT_CAP)
      })
      child.once('error', (err: unknown) => {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT') {
          finish({ ok: false, code: 'adb_not_found', message: `找不到 adb 可执行文件：${deps.adbPath}` })
          return
        }
        finish({ ok: false, code: 'spawn_failed', message: String((err as Error)?.message || err) })
      })
      child.once('close', (code: unknown) => {
        if (code === 0) finish({ ok: true, stdout })
        else finish({ ok: false, code: 'nonzero', message: `adb 退出码 ${String(code)}` })
      })
    })
  }

  return {
    run,
    devices: () => run(['devices']),
    forwardFresh: async () => {
      const result = await run(['-s', deps.serial, 'forward', 'tcp:0', deps.remoteSpec])
      if (!result.ok) return { ok: false, code: result.code, message: result.message }
      const trimmed = result.stdout.trim()
      const port = Number(trimmed)
      if (!/^\d{1,5}$/.test(trimmed) || !Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, code: 'forward_failed', message: 'adb 没有返回可用的转发端口' }
      }
      return { ok: true, port }
    },
    removeForward: async (port: number) => {
      const result = await run(['-s', deps.serial, 'forward', '--remove', `tcp:${port}`])
      if (!result.ok) log(`[agentbus] forward --remove tcp:${port} 未生效（已忽略）：${result.message}`)
    },
  }
}

// ── one framed TCP connection ───────────────────────────────────────────────────────────────────

import net from 'node:net'

export type FrameRead =
  | { kind: 'frame'; frame: unknown }
  | { kind: 'eof' }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }

export type WriteResult = { ok: true } | { ok: false; message: string }

export class FrameStream {
  private decoder = new FrameDecoder()
  private queue: unknown[] = []
  private waiter: ((result: FrameRead) => void) | null = null
  private ended = false
  private failure: string | null = null
  private sock: net.Socket | null = null
  private bytesRead = 0

  get isOpen(): boolean {
    return this.sock !== null && !this.sock.destroyed
  }

  /**
   * Cumulative bytes pushed into the decoder on this connection. The caller marks
   * this before a read loop: ANY byte that arrives afterwards counts as a
   * response byte, even a partial header, because a half-read frame already
   * proves the peer answered (amoo.rs:838-864 sets received_bytes on any read).
   */
  get totalBytes(): number {
    return this.bytesRead
  }

  attach(sock: net.Socket): void {
    this.reset()
    this.sock = sock
    sock.on('data', (chunk: Buffer) => {
      this.bytesRead += chunk.length
      for (const frame of this.decoder.push(chunk)) this.queue.push(frame)
      // A declared size that violates the guard means the stream is out of sync:
      // every later byte would be mis-framed, so report a failure rather than
      // waiting for a frame that can never arrive.
      if (this.decoder.isBroken && !this.failure) this.failure = '对端返回了无效的数据帧长度'
      this.flush()
    })
    sock.on('end', () => {
      this.ended = true
      this.flush()
    })
    sock.on('close', () => {
      this.ended = true
      this.flush()
    })
    sock.on('error', (err: Error) => {
      this.failure = String(err?.message || err)
      this.flush()
    })
  }

  /** Drop the socket and everything buffered. Safe to call with nothing attached. */
  detach(): void {
    const sock = this.sock
    this.reset()
    if (sock) {
      try {
        sock.removeAllListeners()
        sock.destroy()
      } catch {
        /* already gone */
      }
    }
  }

  private reset(): void {
    this.decoder = new FrameDecoder()
    this.queue = []
    this.waiter = null
    this.ended = false
    this.failure = null
    this.sock = null
    this.bytesRead = 0
  }

  private flush(): void {
    const current = this.waiter
    if (!current) return
    if (this.queue.length > 0) {
      this.waiter = null
      current({ kind: 'frame', frame: this.queue.shift() })
      return
    }
    if (this.ended) {
      this.waiter = null
      current({ kind: 'eof' })
      return
    }
    if (this.failure) {
      this.waiter = null
      current({ kind: 'error', message: this.failure })
    }
  }

  /**
   * True when the peer has already sent bytes this connection has not finished
   * reading. A half-read frame counts: the reference sets its received_bytes
   * flag on any successful read (amoo.rs:860-862), so a partial header or body
   * already proves the peer answered and replaying is not provably safe.
   */
  hasPartialFrame(): boolean {
    return this.decoder.pendingBytes > 0 || this.queue.length > 0
  }

  /** Next complete frame, or why there will not be one, within timeoutMs. */
  read(timeoutMs: number): Promise<FrameRead> {
    if (this.queue.length > 0) return Promise.resolve({ kind: 'frame', frame: this.queue.shift() })
    if (this.ended) return Promise.resolve({ kind: 'eof' })
    if (this.failure) return Promise.resolve({ kind: 'error', message: this.failure })
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: FrameRead) => {
        if (settled) return
        settled = true
        if (this.waiter === resolve) this.waiter = null
        clearTimeout(timer)
        resolve(value)
      }
      this.waiter = (value) => finish(value)
      const timer = setTimeout(() => finish({ kind: 'timeout' }), Math.max(1, Number(timeoutMs) || 1))
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  /** Write one frame. A write error or a stalled socket both count as a failure. */
  write(bytes: Buffer, timeoutMs: number): Promise<WriteResult> {
    const sock = this.sock
    if (!sock || sock.destroyed) return Promise.resolve({ ok: false, message: '连接已断开' })
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: WriteResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        sock.off('error', onError)
        resolve(value)
      }
      const onError = (err: Error) => finish({ ok: false, message: String(err?.message || err) })
      const timer = setTimeout(() => finish({ ok: false, message: '写入超时' }), Math.max(1, Number(timeoutMs) || 1))
      if (typeof timer.unref === 'function') timer.unref()
      sock.once('error', onError)
      try {
        sock.write(bytes, (err?: Error | null) =>
          err ? finish({ ok: false, message: String(err.message || err) }) : finish({ ok: true }),
        )
      } catch (err) {
        finish({ ok: false, message: String((err as Error)?.message || err) })
      }
    })
  }
}

/** Default connector: a real TCP connection to the forwarded loopback port. */
export function connectLoopback(port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: LOOPBACK_HOST, port })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('连接 Amoo 后台服务超时'))
    }, Math.max(1, Number(timeoutMs) || 1))
    if (typeof timer.unref === 'function') timer.unref()
    sock.once('connect', () => {
      clearTimeout(timer)
      resolve(sock)
    })
    sock.once('error', (err: Error) => {
      clearTimeout(timer)
      sock.destroy()
      reject(err)
    })
  })
}

// ── status probe (observe semantics) ───────────────────────────────────────────────────────────────────

type OpenResult = { ok: true; serverVersion: string } | { ok: false; code: string; message: string }

export type ProbeSession = {
  config: AgentbusConfig
  adb: Adb
  /** True while a round owns the connection. */
  isOpen: () => boolean
  serverVersion: () => string
  open: () => Promise<OpenResult>
  close: () => void
}

function statusBase(config: AgentbusConfig): AgentbusStatus {
  return {
    ok: false,
    code: 'internal_error',
    message: '',
    hint: '',
    serial: config.adb.serial,
    serialSource: config.adb.serialSource,
    serverVersion: '',
    protocol: config.bus.protocol,
  }
}

/**
 * Probe the lane. Every failure comes back classified with a hint that is either
 * the exact command to run or an env assignment — never prose the user cannot act on.
 */
export type AgentbusStatusCode =
  | 'ok'
  | 'adb_not_found'
  | 'serial_missing'
  | 'serial_not_connected'
  | 'connect_failed'
  | 'protocol_unsupported'
  | 'internal_error'

export type AgentbusStatus = {
  ok: boolean
  code: AgentbusStatusCode
  message: string
  /** Next step: either the exact probe command or an env assignment. Never prose. */
  hint: string
  serial: string
  serialSource: AgentbusConfig['adb']['serialSource']
  serverVersion: string
  protocol: number
}

export async function probeStatus(session: ProbeSession): Promise<AgentbusStatus> {
  const { config, adb } = session
  if (session.isOpen()) {
    return {
      ...statusBase(config),
      ok: true,
      code: 'ok',
      message: '已连上手机端 Amoo 后台服务（有一轮正在进行）',
      serverVersion: session.serverVersion(),
    }
  }
  if (!config.adb.serial) {
    return {
      ...statusBase(config),
      code: 'serial_missing',
      message: '没有配置手机串号：桌面端不替用户挑一台设备',
      hint: 'KHY_AGENTBUS_SERIAL=<手机串号>',
    }
  }
  const devices = await adb.devices()
  if (!devices.ok) {
    if (devices.code === 'adb_not_found') {
      return {
        ...statusBase(config),
        code: 'adb_not_found',
        message: 'PATH 里没有 adb，也没有配置 KHY_AGENTBUS_ADB_PATH',
        hint: 'KHY_AGENTBUS_ADB_PATH=<adb 可执行文件路径>',
      }
    }
    return { ...statusBase(config), code: 'connect_failed', message: `读取设备表失败：${devices.message}`, hint: 'adb devices' }
  }
  // Only the serial the user configured is looked for: the lane never picks a
  // device on the user's behalf, and never re-implements the backend's discovery
  // duty (phoneBridgeConfig pickDeviceSerial).
  const row = parseAdbDevices(devices.stdout).find((r) => r.serial === config.adb.serial)
  if (!row) {
    return {
      ...statusBase(config),
      code: 'serial_not_connected',
      message: `设备表里没有串号 ${config.adb.serial} 的手机`,
      hint: 'adb devices',
    }
  }
  if (row.state !== 'device') {
    return {
      ...statusBase(config),
      code: 'serial_not_connected',
      message: `手机当前状态是 ${row.state}：请在手机上确认 USB 调试授权`,
      hint: 'adb devices',
    }
  }
  const hello = await session.open()
  if (!hello.ok) {
    return {
      ...statusBase(config),
      code: hello.code === 'adb_not_found' ? 'adb_not_found' : 'connect_failed',
      message: hello.message,
      hint: 'adb devices',
    }
  }
  session.close()
  return {
    ...statusBase(config),
    ok: true,
    code: 'ok',
    message: `已连上手机端 Amoo 后台服务${hello.serverVersion ? `（${hello.serverVersion}）` : ''}`,
    serverVersion: hello.serverVersion,
  }
}
