/*
 * agentbusProtocol.ts — pure leaf (纯叶子:零 IO、可单测、fail-soft).
 *
 * Everything the lane knows about the phone's Amoo background service, in one
 * module: env defaults, wire framing, the JSON-RPC contract, usage counters and
 * inbound-event parsing. It is one file rather than five because
 * scripts/ci/check-change-safety.js caps a change set at 20 files and this lane
 * was over it; the ratchet's real caps (maxFuncLines 300 / lines 2000 SOFT) are
 * still respected, and every section below keeps its own provenance comments.
 *
 * The wire contract is reversed out of the reference implementation
 * (D:/Temp/stepx-src/desktop/src/amoo.rs). The service itself is a system
 * priv-app whose source is not in this repo, so what this module pins is OUR
 * encoder/decoder/state machine against that reading — not a claim about the
 * service.
 *
 * Two terminal sets live here and they are NOT the same set (the single most
 * common way to get this protocol wrong):
 *   - isTerminalStopReason: the history/completion path, verbatim from
 *     amoo.rs:1998-2014 (lowercased comparison).
 *   - isTerminalEventState: the event-level finished path, from the findings'
 *     §5.3 reading of amoo.rs:633-650.
 * They differ in both directions and a test pins every member of each.
 */

// ── env defaults (KHY_AGENTBUS_*) ───────────────────────────────────────────────────────────────────

export type ConfigSource = 'default' | 'env' | 'default-invalid'

export type AgentbusConfig = {
  adb: {
    path: string
    pathSource: ConfigSource
    serial: string
    /** 'agentbus' = KHY_AGENTBUS_SERIAL; 'phone' = KHY_PHONE_BRIDGE_SERIAL fallback */
    serialSource: 'agentbus' | 'phone' | 'default'
    /** wall-clock budget (ms) for one adb child process */
    timeoutMs: number
  }
  bus: {
    remoteSpec: string
    protocol: number
    idPrefix: string
    clientIdPrefix: string
    clientVersion: string
    platform: string
    /** default timeout (ms) for connect + handshake + probe */
    handshakeMs: number
  }
  round: {
    /** per-round wait budget (ms); the UI budget picker derives from it */
    budgetMs: number
    /** desktop input guard in characters; NOT a protocol field */
    promptMaxChars: number
    /** event read-loop tick (ms) */
    pollIntervalMs: number
    /** chat.history page size, same value as the reference (amoo.rs:1606) */
    historyLimit: number
    /**
     * Per-method RPC budget (ms) for chat.send. The reference has ONE timeout for
     * every non-connect call — REQUEST_TIMEOUT = 45s (amoo.rs:20), inherited via
     * call() (amoo.rs:1156). This lane makes it per method so that a phone which
     * never answers chat.send cannot also swallow the chat.history read that would
     * have explained the round. It is NOT the handshake budget (ENV_HANDSHAKE_MS):
     * a handshake is a loopback round trip, a turn is minutes of phone work.
     */
    chatSendMs: number
    /** Per-method RPC budget (ms) for chat.history (amoo.rs:1606 -> 45s). */
    chatHistoryMs: number
    /** Per-method RPC budget (ms) for sessions.reset (amoo.rs:1755 -> 45s). */
    sessionsResetMs: number
  }
  sources: Record<string, ConfigSource>
}

export const ENV_ADB_PATH = 'KHY_AGENTBUS_ADB_PATH'
export const ENV_SERIAL = 'KHY_AGENTBUS_SERIAL'
export const ENV_SERIAL_FALLBACK = 'KHY_PHONE_BRIDGE_SERIAL'
export const ENV_REMOTE_SPEC = 'KHY_AGENTBUS_REMOTE_SPEC'
export const ENV_PROTOCOL = 'KHY_AGENTBUS_PROTOCOL'
export const ENV_ID_PREFIX = 'KHY_AGENTBUS_ID_PREFIX'
export const ENV_CLIENT_ID_PREFIX = 'KHY_AGENTBUS_CLIENT_ID_PREFIX'
export const ENV_CLIENT_VERSION = 'KHY_AGENTBUS_CLIENT_VERSION'
export const ENV_PLATFORM = 'KHY_AGENTBUS_PLATFORM'
export const ENV_BUDGET_MS = 'KHY_AGENTBUS_BUDGET_MS'
export const ENV_ADB_TIMEOUT_MS = 'KHY_AGENTBUS_ADB_TIMEOUT_MS'
export const ENV_HANDSHAKE_MS = 'KHY_AGENTBUS_HANDSHAKE_MS'
export const ENV_SEND_TIMEOUT_MS = 'KHY_AGENTBUS_SEND_TIMEOUT_MS'
export const ENV_HISTORY_TIMEOUT_MS = 'KHY_AGENTBUS_HISTORY_TIMEOUT_MS'
export const ENV_RESET_TIMEOUT_MS = 'KHY_AGENTBUS_RESET_TIMEOUT_MS'
export const ENV_POLL_MS = 'KHY_AGENTBUS_POLL_MS'

/** The exit of `adb forward`: transport, not a configured endpoint (see header). */
export const LOOPBACK_HOST = '127.0.0.1'

/** Budget clamp (ms): below 15s a phone turn cannot finish; past 1800s the user just waits. */
export const BUDGET_MIN_MS = 15000
export const BUDGET_MAX_MS = 1800000
export const BUDGET_DEFAULT_MS = 420000

/**
 * Default per-method RPC budgets (ms). Source: the reference's single
 * REQUEST_TIMEOUT = 45s (amoo.rs:20), which every non-connect call inherits through
 * call() (amoo.rs:1156) — chat.send at amoo.rs:1830-1835, sessions.reset at
 * amoo.rs:1755, chat.history at amoo.rs:1606. The reference additionally caps its
 * child-task history merges at 8s (amoo.rs:1697); this lane has no child-task
 * merge, so no second history value exists here.
 */
export const DEFAULT_SEND_TIMEOUT_MS = 45000
export const DEFAULT_HISTORY_TIMEOUT_MS = 45000
export const DEFAULT_RESET_TIMEOUT_MS = 45000

/** Request id prefix. The reference uses stepx-<32 hex> (amoo.rs:1340); env swaps the prefix only. */
export const DEFAULT_ID_PREFIX = 'stepx-'
export const DEFAULT_CLIENT_ID_PREFIX = 'khyos-agentbus-'

function readString(env: NodeJS.ProcessEnv, name: string, fallback: string): { value: string; source: ConfigSource } {
  const raw = env[name]
  if (typeof raw !== 'string' || !raw.trim()) return { value: fallback, source: 'default' }
  return { value: raw.trim(), source: 'env' }
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  { min = 1, max = 600000 }: { min?: number; max?: number } = {},
): { value: number; source: ConfigSource } {
  const raw = env[name]
  if (raw == null || String(raw).trim() === '') return { value: fallback, source: 'default' }
  const parsed = Number.parseInt(String(raw).trim(), 10)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    // A garbage env value must not take the lane down: fall back and record the
    // source as default-invalid so the status line can say so (same shape as
    // amooBridgeConfig.js:102-113).
    return { value: fallback, source: 'default-invalid' }
  }
  return { value: parsed, source: 'env' }
}

/**
 * Resolve the whole lane configuration. Pure: same env in, same object out; no
 * disk, no child process, no throw.
 * @param env injected env (tests, and any caller resolving for another process)
 */
export function resolveAgentbusConfig(env: NodeJS.ProcessEnv = process.env): AgentbusConfig {
  const adbPath = readString(env, ENV_ADB_PATH, 'adb')
  const explicitSerial = readString(env, ENV_SERIAL, '')
  const fallbackSerial = readString(env, ENV_SERIAL_FALLBACK, '')
  // One phone is one fact under two names: the lane-specific var wins, and the
  // fallback keeps the secretary lane's var working so nobody configures twice.
  const serial = explicitSerial.source === 'env' ? explicitSerial : fallbackSerial
  const serialSource: AgentbusConfig['adb']['serialSource'] =
    explicitSerial.source === 'env' ? 'agentbus' : fallbackSerial.source === 'env' ? 'phone' : 'default'
  const remoteSpec = readString(env, ENV_REMOTE_SPEC, 'localabstract:agentbus')
  const protocol = readInt(env, ENV_PROTOCOL, 3, { min: 1, max: 99 })
  const idPrefix = readString(env, ENV_ID_PREFIX, DEFAULT_ID_PREFIX)
  const clientIdPrefix = readString(env, ENV_CLIENT_ID_PREFIX, DEFAULT_CLIENT_ID_PREFIX)
  const clientVersion = readString(env, ENV_CLIENT_VERSION, '0.1.0')
  const platform = readString(env, ENV_PLATFORM, 'linux')
  const budgetMs = readInt(env, ENV_BUDGET_MS, BUDGET_DEFAULT_MS, { min: BUDGET_MIN_MS, max: BUDGET_MAX_MS })
  const adbTimeoutMs = readInt(env, ENV_ADB_TIMEOUT_MS, 15000, { min: 1000, max: 120000 })
  const handshakeMs = readInt(env, ENV_HANDSHAKE_MS, 3000, { min: 500, max: 60000 })
  const sendTimeoutMs = readInt(env, ENV_SEND_TIMEOUT_MS, DEFAULT_SEND_TIMEOUT_MS, { min: 1000, max: 600000 })
  const historyTimeoutMs = readInt(env, ENV_HISTORY_TIMEOUT_MS, DEFAULT_HISTORY_TIMEOUT_MS, { min: 1000, max: 600000 })
  const resetTimeoutMs = readInt(env, ENV_RESET_TIMEOUT_MS, DEFAULT_RESET_TIMEOUT_MS, { min: 1000, max: 600000 })
  const pollIntervalMs = readInt(env, ENV_POLL_MS, 1000, { min: 200, max: 60000 })

  return {
    adb: {
      path: adbPath.value,
      pathSource: adbPath.source,
      serial: serial.value,
      serialSource,
      timeoutMs: adbTimeoutMs.value,
    },
    bus: {
      remoteSpec: remoteSpec.value,
      protocol: protocol.value,
      idPrefix: idPrefix.value,
      clientIdPrefix: clientIdPrefix.value,
      clientVersion: clientVersion.value,
      platform: platform.value,
      handshakeMs: handshakeMs.value,
    },
    round: {
      budgetMs: budgetMs.value,
      promptMaxChars: 20000,
      pollIntervalMs: pollIntervalMs.value,
      historyLimit: 100,
      chatSendMs: sendTimeoutMs.value,
      chatHistoryMs: historyTimeoutMs.value,
      sessionsResetMs: resetTimeoutMs.value,
    },
    sources: {
      adbPath: adbPath.source,
      serial: serial.source,
      remoteSpec: remoteSpec.source,
      protocol: protocol.source,
      idPrefix: idPrefix.source,
      clientIdPrefix: clientIdPrefix.source,
      clientVersion: clientVersion.source,
      platform: platform.source,
      budgetMs: budgetMs.source,
      chatSendMs: sendTimeoutMs.source,
      chatHistoryMs: historyTimeoutMs.source,
      sessionsResetMs: resetTimeoutMs.source,
    },
  }
}

// ── wire framing ───────────────────────────────────────────────────────────────────

export const MAX_FRAME_BYTES = 16 * 1024 * 1024
export const FRAME_HEADER_BYTES = 4

export type EncodeResult = { ok: true; bytes: Buffer } | { ok: false; error: 'frame_too_large' | 'encode_failed' }
export type HeaderResult =
  | { ok: true; size: number }
  | { ok: false; error: 'short_header' | 'empty_frame' | 'frame_too_large' }

/** Serialize one frame. Refuses an oversized body instead of truncating it. */
export function encodeFrame(payload: unknown): EncodeResult {
  let json: string
  try {
    json = JSON.stringify(payload)
  } catch {
    return { ok: false, error: 'encode_failed' }
  }
  if (typeof json !== 'string') return { ok: false, error: 'encode_failed' }
  const body = Buffer.from(json, 'utf8')
  if (body.length > MAX_FRAME_BYTES) return { ok: false, error: 'frame_too_large' }
  const bytes = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.length)
  bytes.writeUInt32BE(body.length, 0)
  body.copy(bytes, FRAME_HEADER_BYTES)
  return { ok: true, bytes }
}

/** Decode a 4-byte length header. Never trusts the peer's size field blindly. */
export function decodeFrameHeader(header: Buffer | Uint8Array): HeaderResult {
  if (!header || header.length < FRAME_HEADER_BYTES) return { ok: false, error: 'short_header' }
  const view = Buffer.isBuffer(header) ? header : Buffer.from(header)
  const size = view.readUInt32BE(0)
  if (size === 0) return { ok: false, error: 'empty_frame' }
  if (size > MAX_FRAME_BYTES) return { ok: false, error: 'frame_too_large' }
  return { ok: true, size }
}

/**
 * Incremental frame decoder for a byte stream.
 *
 * `push` returns every complete, JSON-parseable body that became available.
 * A frame whose body is not valid JSON is dropped and counted in
 * `skippedFrames` (the reference does the same on the event path,
 * amoo.rs:1986). A declared size that violates the guard marks the decoder
 * `broken`: the stream is out of sync and every later byte would be mis-framed,
 * so the caller must reconnect rather than keep reading.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0)
  private broken = false
  private skipped = 0

  get pendingBytes(): number {
    return this.buf.length
  }

  get isBroken(): boolean {
    return this.broken
  }

  get skippedFrames(): number {
    return this.skipped
  }

  /** Drop everything buffered. Used after a reconnect so a stale tail cannot be re-framed. */
  reset(): void {
    this.buf = Buffer.alloc(0)
    this.broken = false
    this.skipped = 0
  }

  push(chunk: Buffer | Uint8Array): unknown[] {
    if (this.broken) return []
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (incoming.length === 0) return []
    this.buf = this.buf.length === 0 ? incoming : Buffer.concat([this.buf, incoming])
    const out: unknown[] = []
    for (;;) {
      if (this.buf.length < FRAME_HEADER_BYTES) break
      const header = decodeFrameHeader(this.buf.subarray(0, FRAME_HEADER_BYTES))
      if (!header.ok) {
        this.broken = true
        this.buf = Buffer.alloc(0)
        break
      }
      const total = FRAME_HEADER_BYTES + header.size
      if (this.buf.length < total) break
      const body = this.buf.subarray(FRAME_HEADER_BYTES, total)
      this.buf = this.buf.subarray(total)
      try {
        out.push(JSON.parse(body.toString('utf8')))
      } catch {
        this.skipped += 1
      }
    }
    return out
  }
}

// ── usage counters ───────────────────────────────────────────────────────────────────

export type ResponseMsSource = 'server' | 'measured' | null

export type MessageUsage = {
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  /** Input consumed by the LAST inference, not cumulative billed tokens. */
  context_used: number | null
  context_limit: number | null
  /** Service-reported response duration; may include tool execution. */
  response_ms: number | null
  response_ms_source: ResponseMsSource
  /** Output tokens / response duration: average response throughput. */
  tokens_per_second: number | null
  /** Only populated when the service also identifies USD as the currency. */
  cost_usd: number | null
}

export const EMPTY_USAGE: MessageUsage = {
  input_tokens: null,
  output_tokens: null,
  total_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  context_used: null,
  context_limit: null,
  response_ms: null,
  response_ms_source: null,
  tokens_per_second: null,
  cost_usd: null,
}


/** A usage container may arrive as an object or as a JSON string (amoo_usage.rs:39-48). */
function asContainer(value: unknown): Record<string, unknown> | null {
  const rec = asRecord(value)
  if (rec) return rec
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return asRecord(parsed)
  } catch {
    return null
  }
}

/** Non-negative safe integers only. Rejects negatives, fractions, NaN and > 2^53. */
function count(container: Record<string, unknown> | null, keys: string[]): number | null {
  if (!container) return null
  for (const key of keys) {
    const raw = container[key]
    if (typeof raw === 'number') {
      if (Number.isSafeInteger(raw) && raw >= 0) return raw
      continue
    }
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = Number(raw.trim())
      if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
    }
  }
  return null
}

function nonNegativeNumber(container: Record<string, unknown> | null, keys: string[]): number | null {
  if (!container) return null
  for (const key of keys) {
    const raw = container[key]
    let parsed: number | null = null
    if (typeof raw === 'number') parsed = raw
    else if (typeof raw === 'string' && raw.trim()) parsed = Number(raw.trim())
    if (parsed === null || !Number.isFinite(parsed) || parsed < 0) continue
    return parsed
  }
  return null
}

/** Container precedence: usage → tokenUsage → metadata.usage (amoo_usage.rs:56-59). */
function usageContainerOf(message: Record<string, unknown>): Record<string, unknown> {
  const direct = asContainer(message.usage) || asContainer(message.tokenUsage)
  if (direct) return direct
  const metadata = asContainer(message.metadata) || asContainer(message.meta)
  if (metadata) {
    const nested = asContainer(metadata.usage) || asContainer(metadata.tokenUsage)
    if (nested) return nested
  }
  return {}
}

/**
 * Parse the usage record of one message row. Never estimates, never defaults a
 * missing counter to zero.
 */
export function parseMessageUsage(message: unknown): MessageUsage {
  const row = asRecord(message)
  if (!row) return { ...EMPTY_USAGE }
  const metadata = asContainer(row.metadata) || asContainer(row.meta) || {}
  const usage = usageContainerOf(row)

  const input = count(usage, ['input', 'inputTokens', 'input_tokens', 'prompt_tokens'])
  const output = count(usage, ['output', 'outputTokens', 'output_tokens', 'completion_tokens'])
  const declaredTotal = count(usage, ['totalTokens', 'total_tokens'])
  // A total that overflows when input+output are added stays unknown rather
  // than wrapping into a plausible-looking smaller number.
  const summed =
    input !== null && output !== null && Number.isSafeInteger(input + output) ? input + output : null
  const total = declaredTotal !== null ? declaredTotal : summed

  const responseMs =
    count(row, ['durationMs', 'duration_ms', 'responseMs']) ??
    count(metadata, ['durationMs', 'duration_ms', 'responseMs']) ??
    count(usage, ['durationMs', 'duration_ms', 'responseMs'])
  const positiveResponseMs = responseMs !== null && responseMs > 0 ? responseMs : null

  const cost = nonNegativeNumber(row, ['cost_usd']) ?? nonNegativeNumber(metadata, ['cost_usd']) ?? nonNegativeNumber(usage, ['cost_usd'])
  // Only USD is a cost. Any other currency is dropped instead of being read as
  // dollars (amoo_usage.rs:79-86).
  const usdCost =
    cost !== null
      ? cost
      : (usage.cost && asRecord(usage.cost)?.currency === 'USD'
          ? nonNegativeNumber(asRecord(usage.cost), ['total'])
          : null)

  const contextLimit = count(row, ['contextWindow', 'contextLimit']) ?? count(metadata, ['contextWindow', 'contextLimit']) ?? count(usage, ['contextWindow', 'contextLimit', 'context_window'])

  // The OpenAI-shaped nested counter is the last rung of the same ladder: the
  // reference reads usage["prompt_tokens_details"]["cached_tokens"] when the three
  // flat spellings are all absent (amoo_usage.rs:91-95).
  const cacheRead =
    count(usage, ['cacheRead', 'cacheReadTokens', 'cache_read_input_tokens']) ??
    count(asRecord(usage.prompt_tokens_details), ['cached_tokens'])

  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cache_read_tokens: cacheRead,
    cache_write_tokens: count(usage, ['cacheWrite', 'cacheWriteTokens', 'cache_creation_input_tokens']),
    // Degenerate but honest: when the service reports no context figure, the
    // last inference's input IS the context it consumed.
    context_used: count(usage, ['contextTokens', 'context_tokens', 'contextUsed']) ?? input,
    context_limit: contextLimit !== null && contextLimit > 0 ? contextLimit : null,
    response_ms: positiveResponseMs,
    response_ms_source: positiveResponseMs !== null ? 'server' : null,
    tokens_per_second:
      output !== null && positiveResponseMs !== null ? (output * 1000) / positiveResponseMs : null,
    cost_usd: usdCost,
  }
}

export function usageHasTokens(usage: MessageUsage | null | undefined): boolean {
  if (!usage) return false
  return usage.input_tokens !== null || usage.output_tokens !== null || usage.total_tokens !== null
}

/**
 * Fill in a client-measured end-to-end duration when the service reported none.
 * Only allowed while output tokens exist, and only ever labelled as measured —
 * the UI must print「（桌面实测耗时，非服务端上报）」next to any such figure.
 */
export function withObservedResponseMs(usage: MessageUsage, elapsedMs: number): MessageUsage {
  if (usage.response_ms !== null) return usage
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || usage.output_tokens === null) return usage
  return {
    ...usage,
    response_ms: Math.round(elapsedMs),
    response_ms_source: 'measured',
    tokens_per_second: (usage.output_tokens * 1000) / Math.round(elapsedMs),
  }
}

function addInto(target: { value: number | null }, next: number | null): void {
  if (next === null) return
  const base = target.value ?? 0
  target.value = Number.isSafeInteger(base + next) ? base + next : null
}

/**
 * Sum the deduplicated messages of one round. Context and throughput stay those
 * of the latest reported inference — repeated snapshots are never accumulated
 * (amoo_usage.rs:134-136). The caller must disclose a partly loaded history.
 */
export function aggregateUsage(rows: MessageUsage[]): MessageUsage {
  const input = { value: null as number | null }
  const output = { value: null as number | null }
  const total = { value: null as number | null }
  const cacheRead = { value: null as number | null }
  const cacheWrite = { value: null as number | null }
  let cost: number | null = null
  let contextUsed: number | null = null
  let contextLimit: number | null = null
  let responseMs: number | null = null
  let responseMsSource: ResponseMsSource = null
  let tokensPerSecond: number | null = null
  for (const row of rows) {
    addInto(input, row.input_tokens)
    addInto(output, row.output_tokens)
    addInto(total, row.total_tokens)
    addInto(cacheRead, row.cache_read_tokens)
    addInto(cacheWrite, row.cache_write_tokens)
    if (row.cost_usd !== null) cost = (cost ?? 0) + row.cost_usd
    if (row.context_used !== null) {
      contextUsed = row.context_used
      contextLimit = row.context_limit
    }
    if (usageHasTokens(row)) {
      responseMs = row.response_ms
      responseMsSource = row.response_ms_source
      tokensPerSecond = row.tokens_per_second
    }
  }
  return {
    input_tokens: input.value,
    output_tokens: output.value,
    total_tokens: total.value,
    cache_read_tokens: cacheRead.value,
    cache_write_tokens: cacheWrite.value,
    context_used: contextUsed,
    context_limit: contextLimit,
    response_ms: responseMs,
    response_ms_source: responseMsSource,
    tokens_per_second: tokensPerSecond,
    cost_usd: cost,
  }
}

/** The latest usage that actually carries a counter; null when none does. */
export function latestUsageWithTokens(rows: MessageUsage[]): MessageUsage | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (usageHasTokens(rows[i])) return rows[i]
  }
  return null
}

// ── inbound events ───────────────────────────────────────────────────────────────────

export type StreamDelta = {
  sessionKey: string
  runId: string
  deltaText: string
  fullText: string
  toolStatus: string | null
  finished: boolean
}

export type StepclawStatus = {
  chatStatus: string
  chatReason: string
  upstreamStatus: string
  upstreamReason: string
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function str(rec: Record<string, unknown> | null, keys: string[]): string {
  if (!rec) return ''
  for (const key of keys) {
    const raw = rec[key]
    if (typeof raw === 'string' && raw) return raw
  }
  return ''
}

function extractContent(value: unknown): string {
  if (typeof value === 'string' && value) return value
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      const rec = asRecord(item)
      if (!rec) continue
      if (rec.type !== undefined && rec.type !== 'text') continue
      const text = typeof rec.text === 'string' ? rec.text : typeof rec.content === 'string' ? rec.content : ''
      if (text) parts.push(text)
    }
    return parts.join('\n')
  }
  const rec = asRecord(value)
  if (rec) {
    if (typeof rec.text === 'string' && rec.text) return rec.text
    if (typeof rec.content === 'string' && rec.content) return rec.content
  }
  return ''
}

const SUPPORTED_EVENTS = new Set([
  'chat', 'chat.delta', 'chat.message', 'session.message', 'agent', 'agent.event',
  'tool', 'tool.call', 'tool.status', 'run', 'run.delta', 'message', 'message.delta',
])

function eventSupported(event: string): boolean {
  if (SUPPORTED_EVENTS.has(event)) return true
  return (
    event.startsWith('chat.') ||
    event.startsWith('session.message') ||
    event.startsWith('agent.') ||
    event.startsWith('tool.') ||
    event.startsWith('run.') ||
    event.startsWith('message.')
  )
}

/** Parse one inbound frame into a stream delta, or null when it shows nothing. */
export function parseStreamEvent(frame: unknown): StreamDelta | null {
  const rec = asRecord(frame)
  if (!rec) return null
  let event = ''
  let payload: Record<string, unknown> | null = null
  if (rec.type === 'event') {
    event = str(rec, ['event'])
    payload = asRecord(rec.payload) || rec
  } else if (rec.type === 'req' && rec.method === 'node.event') {
    const params = asRecord(rec.params)
    if (!params) return null
    event = str(params, ['event'])
    payload = asRecord(params.payload) || params
  } else {
    return null
  }
  if (!eventSupported(event)) return null

  const role = str(payload, ['role'])
  if (role && role !== 'assistant' && role !== 'tool') return null
  const isToolRole = role === 'tool'
  const metadata = asRecord(payload.metadata)
  const data = asRecord(payload.data)

  const sessionKey =
    str(payload, ['sessionKey', 'session_key', 'sessionId', 'session_id']) ||
    str(metadata, ['sessionKey', 'session_key', 'sessionId', 'session_id']) ||
    str(rec, ['sessionKey', 'session_key', 'sessionId', 'session_id'])
  if (!sessionKey) return null

  const runId =
    str(payload, ['runId', 'run_id', 'id']) ||
    str(metadata, ['runId', 'run_id', 'id']) ||
    str(rec, ['runId', 'run_id'])

  let deltaText = isToolRole ? '' : str(payload, ['delta', 'textDelta', 'contentDelta', 'deltaText'])
  if (!isToolRole && !deltaText) {
    const deltaObj = asRecord(payload.delta)
    if (deltaObj) {
      deltaText = str(deltaObj, ['text', 'content', 'textDelta', 'contentDelta']) || extractContent(deltaObj.content)
    }
  }
  if (!isToolRole && !deltaText && data) deltaText = str(data, ['delta', 'textDelta', 'contentDelta', 'text'])

  const message = asRecord(payload.message)
  const fullText = isToolRole
    ? ''
    : extractContent(payload.text) || extractContent(payload.content) || extractContent(message?.text) || extractContent(message?.content)

  let state = str(payload, ['state', 'status', 'stopReason', 'stop_reason'])
  if (!state && message) state = str(message, ['stopReason', 'stop_reason', 'state', 'status'])
  if (!state && metadata) state = str(metadata, ['lifecyclePhase', 'stopReason', 'stop_reason', 'state', 'status'])
  const stateLower = state.toLowerCase()

  const toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls : []
  const hasToolCalls = toolCalls.length > 0
  const isToolStepState = ['tool_use', 'tool_calls', 'tool', 'calling_tool', 'running', 'streaming'].includes(stateLower)
  // metadata.streaming === false is the phone saying the turn ended; it does not
  // count while a tool call is still the only thing on screen.
  const streamingEndedTurn =
    metadata?.streaming === false &&
    !isToolStepState &&
    !(hasToolCalls && !deltaText && !fullText && stateLower !== 'turn_done')

  const finished =
    !isToolRole &&
    (isTerminalEventState({ done: payload.done, finished: payload.finished, final: payload.final, state: stateLower }) ||
      streamingEndedTurn)

  const isToolEvent =
    isToolRole ||
    event === 'tool' ||
    event.includes('tool') ||
    ['tool_use', 'tool_calls', 'tool', 'calling_tool'].includes(stateLower) ||
    payload.stream === 'tool' ||
    payload.tool !== undefined ||
    payload.toolName !== undefined ||
    payload.tool_name !== undefined ||
    hasToolCalls

  let toolName = str(payload, ['tool', 'toolName', 'tool_name'])
  if (!toolName) {
    const toolObj = asRecord(payload.tool)
    if (toolObj) toolName = str(toolObj, ['name', 'toolName', 'id'])
  }
  if (!toolName && isToolEvent) toolName = str(payload, ['name'])
  if (!toolName && data) toolName = str(data, ['tool', 'toolName', 'tool_name', 'name'])
  if (!toolName && metadata) toolName = str(metadata, ['tool', 'toolName', 'tool_name', 'name'])
  if (!toolName && hasToolCalls) toolName = toolCalls.map((t) => str(asRecord(t), ['name'])).filter(Boolean).join(' · ')

  const toolStatus = toolName ? `正在调用工具：${toolName}` : isToolEvent && !finished ? '正在调用工具' : null
  if (!deltaText && !fullText && !toolStatus && !finished) return null

  return { sessionKey, runId, deltaText, fullText, toolStatus, finished }
}

/** stepclaw.status.change: the phone's own account of whether chat is usable. */
export function parseStepclawStatus(frame: unknown): StepclawStatus | null {
  const rec = asRecord(frame)
  if (!rec) return null
  let payload: Record<string, unknown> | null = null
  if (rec.type === 'req' && rec.method === 'node.event') {
    const params = asRecord(rec.params)
    if (!params || params.event !== 'stepclaw.status.change') return null
    payload = asRecord(params.payload)
  } else if (rec.type === 'event' && rec.event === 'stepclaw.status.change') {
    payload = asRecord(rec.payload)
  }
  if (!payload) return null
  const resources = asRecord(payload.resources)
  if (!resources) return null
  return {
    chatStatus: str(asRecord(resources.chat), ['status']),
    chatReason: str(asRecord(resources.chat), ['reason']),
    upstreamStatus: str(asRecord(resources.upstream), ['status']),
    upstreamReason: str(asRecord(resources.upstream), ['reason']),
  }
}

export function stepclawScreenOff(status: StepclawStatus | null): boolean {
  return !!status && status.upstreamStatus === 'unavailable' && status.upstreamReason === 'screen_off'
}

// ── RPC contract ───────────────────────────────────────────────────────────────────

// ── handshake ────────────────────────────────────────────────────────────────

export type HelloParamsInput = {
  protocol: number
  clientId: string
  clientVersion: string
  platform: string
}

/**
 * The connect request carries exactly four keys (minProtocol / maxProtocol /
 * role / client). No token, no auth, no scopes, no device identifier — the
 * service is reached over an adb-forwarded abstract socket, and a test asserts
 * the encoded bytes contain none of those words.
 */
export function helloParams(input: HelloParamsInput): Record<string, unknown> {
  return {
    minProtocol: input.protocol,
    maxProtocol: input.protocol,
    role: 'channel',
    client: {
      id: input.clientId,
      displayName: 'KhyOS Desktop',
      version: input.clientVersion,
      platform: input.platform,
    },
  }
}

export function requestEnvelope(id: string, method: string, params: Record<string, unknown>): Record<string, unknown> {
  return { type: 'req', id, method, params }
}

export type HelloServer = { version: string; protocol: number }

/** Read the handshake reply. A protocol the lane did not ask for is a refusal, not a downgrade. */
export function helloServer(
  payload: unknown,
  expectedProtocol: number,
): { ok: true; server: HelloServer } | { ok: false; error: string } {
  const rec = asRecord(payload)
  if (!rec) return { ok: false, error: '握手回包不是对象' }
  const server = asRecord(rec.server) || {}
  const protocol = server.protocol
  if (typeof protocol !== 'number' || protocol !== expectedProtocol) {
    return { ok: false, error: `手机端 Amoo 后台协议不受支持（回报 ${String(protocol)}，需要 ${expectedProtocol}）` }
  }
  return { ok: true, server: { version: typeof server.version === 'string' ? server.version : '', protocol } }
}

// ── response matching (amoo.rs:1420-1446) ────────────────────────────────────

export type MatchResult =
  | { kind: 'not_ours' }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'incomplete' }
  | { kind: 'malformed'; message: string }
  | { kind: 'ok'; payload: Record<string, unknown> }

/**
 * Four outcomes for one inbound frame against the id we are waiting for. The
 * caller keeps reading on 'not_ours' (the bus multiplexes other clients) and
 * stops on everything else.
 */
export function matchResponse(frame: unknown, expectedId: string): MatchResult {
  const rec = asRecord(frame)
  if (!rec) return { kind: 'malformed', message: '回包不是对象' }
  if (rec.id !== expectedId) return { kind: 'not_ours' }
  if (rec.ok !== true) {
    const err = asRecord(rec.error) || {}
    return {
      kind: 'error',
      code: typeof err.code === 'string' && err.code ? err.code : 'UNKNOWN',
      message: typeof err.message === 'string' && err.message ? err.message : '请求未被接受',
    }
  }
  const payload = asRecord(rec.payload)
  if (!payload) return { kind: 'malformed', message: '响应缺少 payload' }
  if (payload.ok === false) return { kind: 'incomplete' }
  return { kind: 'ok', payload }
}

// ── method params ────────────────────────────────────────────────────────────

export function sessionsResetParams(sessionKey: string): Record<string, unknown> {
  // Same shape as the reference's create_session (amoo.rs:1752-1760): a fresh
  // key per round, reason 'new', and never a reset of an existing key.
  return { key: sessionKey, reason: 'new' }
}

/**
 * chat.send. Deliberately thinner than the reference (amoo.rs:1815-1835): no
 * stepclaw context and no attachments. The reference always attaches a device
 * context block built from adb probes, and this lane must not collect serial /
 * ASN / CMIIT identifiers just to send one sentence. If the phone side requires
 * the block, its refusal surfaces verbatim instead of being worked around.
 */
export function chatSendParams(input: { sessionId: string; text: string; runId: string }): Record<string, unknown> {
  return {
    sessionId: input.sessionId,
    text: input.text,
    attachments: [],
    idempotencyKey: input.runId,
  }
}

export function chatAbortParams(sessionKey: string, runId: string): Record<string, unknown> {
  // Both spellings on purpose (amoo.rs:1861-1863): the service reads either.
  return { sessionKey, sessionId: sessionKey, runId }
}

export function chatHistoryParams(sessionId: string, limit: number): Record<string, unknown> {
  return { sessionId, limit }
}

export type SendReceipt =
  | { ok: true; runId: string }
  | { ok: false; code: 'not_accepted' | 'no_receipt'; message: string }

/** Strong validation of the chat.send receipt (amoo.rs:1837-1849). */
export function chatSendReceipt(payload: unknown, localRunId: string): SendReceipt {
  const rec = asRecord(payload)
  if (!rec) return { ok: false, code: 'no_receipt', message: 'Amoo 未返回有效的发送回执，请先同步会话确认；输入内容已保留' }
  if (rec.accepted === false) return { ok: false, code: 'not_accepted', message: 'Amoo 未接受此消息，输入内容已保留' }
  const acceptedRun = typeof rec.runId === 'string' ? rec.runId : ''
  if (!acceptedRun && rec.accepted !== true) {
    const status = typeof rec.status === 'string' ? rec.status : ''
    if (status !== 'started' && status !== 'accepted' && status !== 'queued') {
      return { ok: false, code: 'no_receipt', message: 'Amoo 未返回有效的发送回执，请先同步会话确认；输入内容已保留' }
    }
  }
  return { ok: true, runId: acceptedRun || localRunId }
}

// ── terminal sets ────────────────────────────────────────────────────────────

const TERMINAL_STOP_REASONS = new Set([
  'stop',
  'end_turn',
  'error',
  'aborted',
  'cancelled',
  'length',
  'tracking_limit',
  'task_delivered',
  'completed',
  'done',
  'finished',
  'stop_sequence',
])

/** History/completion path. Verbatim set, lowercased comparison (amoo.rs:1998-2014). */
export function isTerminalStopReason(reason: unknown): boolean {
  return typeof reason === 'string' && TERMINAL_STOP_REASONS.has(reason.toLowerCase())
}

const TERMINAL_EVENT_STATES = new Set([
  'done',
  'turn_done',
  'completed',
  'finished',
  'final',
  'error',
  'aborted',
  'stop',
  'end_turn',
  'cancelled',
])

/** Event-level finished path (findings §5.3). A different set from the one above. */
export function isTerminalEventState(input: {
  done?: unknown
  finished?: unknown
  final?: unknown
  state?: unknown
}): boolean {
  if (input.done === true || input.finished === true || input.final === true) return true
  return typeof input.state === 'string' && TERMINAL_EVENT_STATES.has(input.state.toLowerCase())
}

// ── history rows ─────────────────────────────────────────────────────────────

export type HistoryMessage = {
  role: string
  runId: string
  stopReason: string
  text: string
  /** Only ever the row's own flag; never inferred from text length. */
  truncated: boolean
  usage: MessageUsage
}



/** Text of one history row (amoo.rs:2256-2266). */
export function assistantText(row: unknown): string {
  const rec = asRecord(row)
  if (!rec) return ''
  const direct = typeof rec.text === 'string' ? rec.text : typeof rec.content === 'string' ? rec.content : ''
  if (direct) return direct
  return extractContent(rec.content)
}

export function parseHistoryMessages(rows: unknown): HistoryMessage[] {
  if (!Array.isArray(rows)) return []
  const out: HistoryMessage[] = []
  for (const row of rows) {
    const rec = asRecord(row)
    if (!rec) continue
    const role = str(rec, ['role'])
    if (role !== 'user' && role !== 'assistant') continue
    const text = assistantText(rec)
    if (!text && !str(rec, ['stopReason', 'stop_reason']) && !str(rec, ['errorMessage'])) continue
    out.push({
      role,
      runId: str(rec, ['runId', 'run_id']),
      stopReason: str(rec, ['stopReason', 'stop_reason']),
      text,
      truncated: rec.truncated === true,
      usage: parseMessageUsage(rec),
    })
  }
  return out
}

export function historyHasMore(payload: unknown): boolean {
  const page = asRecord(asRecord(payload)?.page)
  return page?.hasMore === true
}

// ── round completion and reply selection ─────────────────────────────────────

export type PendingTurn = { sessionKey: string; runId: string }

export type SessionSlice = { key: string; messages: HistoryMessage[] }

/**
 * Six ordered branches, ported from amoo.rs:1889-1925. Order is the contract:
 * tracking_limit counts as finished, child_running counts as NOT finished, and
 * both are checked before the generic terminal scan.
 */
export function isRoundFinished(pending: PendingTurn, session: SessionSlice): boolean {
  if (session.key !== pending.sessionKey) return false
  const messages = session.messages
  if (messages.some((m) => m.runId === pending.runId && m.stopReason === 'tracking_limit')) return true
  if (messages.some((m) => m.runId === pending.runId && m.stopReason === 'child_running')) return false
  if (messages.some((m) => m.role === 'assistant' && m.runId === pending.runId && isTerminalStopReason(m.stopReason))) {
    return true
  }
  // Fallback for a service that omits runId on the final assistant message:
  // only assistant rows strictly after our user turn, with an empty runId.
  return findAfterUserTurn(messages, pending.runId).some(
    (m) => m.role === 'assistant' && !m.runId && isTerminalStopReason(m.stopReason),
  )
}

/**
 * Which message's text becomes the reply. The findings record finished() only;
 * this selection is this lane's documented choice: the LAST run-matched terminal
 * assistant row, else the FIRST fallback row (after our user turn, no runId,
 * terminal). Neither exists → no reply text and the state stays as it is.
 * The phone's own stop reason for that row comes back with it.
 */
export function selectReplyText(
  pending: PendingTurn,
  session: SessionSlice,
): { text: string; truncated: boolean; stopReason: string } | null {
  const messages = session.messages
  if (session.key !== pending.sessionKey) return null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m.role === 'assistant' && m.runId === pending.runId && isTerminalStopReason(m.stopReason)) {
      return { text: m.text, truncated: m.truncated, stopReason: m.stopReason }
    }
  }
  const afterUser = findAfterUserTurn(messages, pending.runId)
  for (const m of afterUser) {
    if (m.role === 'assistant' && !m.runId && isTerminalStopReason(m.stopReason)) {
      return { text: m.text, truncated: m.truncated, stopReason: m.stopReason }
    }
  }
  return null
}

/** Messages strictly after the LAST user row carrying this round's runId. */
function findAfterUserTurn(messages: HistoryMessage[], runId: string): HistoryMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user' && messages[i].runId === runId) return messages.slice(i + 1)
  }
  return []
}

/** Usage of one round: the latest row that carries a counter (never a sum of snapshots). */
export function roundUsage(messages: HistoryMessage[]): MessageUsage {
  let latest: MessageUsage | null = null
  for (const m of messages) {
    if (m.usage.input_tokens !== null || m.usage.output_tokens !== null || m.usage.total_tokens !== null) {
      latest = m.usage
    }
  }
  return latest || { ...EMPTY_USAGE }
}

