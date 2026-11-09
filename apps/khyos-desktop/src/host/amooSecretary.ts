// Amoo secretary lane (host process): ask Amoo one question from the desktop,
// then abort it, and read/write the shared memory both sides keep on the
// phone. Channel choice (AGENTS.md five-channel matrix): host and
// backend are both Node processes, so this is CH-2 direct service call — the
// same precedent the rest of this file's siblings already follow (aiGateway,
// cli/ai, toolUseLoop, sessionPersistence are all nodeRequire'd here). No new
// process, no HTTP server, and no adb or token handling of our own:
// phoneBridgeClient owns those and is required through its factory.
//
// Why the polling events are ownerless: `ask` is a one-shot RPC whose pending
// entry is deleted the moment it returns, while the poll outlives the RPC.
// Routing events through the pendingAi-style stream branch would look up
// undefined and drop every single byte (symptom: the ask is accepted, the
// progress bar never leaves round 0, and the underlying link is fine). So this
// lane only pushes ownerless events over process.send; main broadcasts them
// (precedent: the theme:changed getAllWindows loop) and the renderer re-reads
// the lane state on each event.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import {
  createAmooSecretaryLedger,
  LEDGER_SLICE_LIMIT,
  type AmooLedgerOutcome,
  type AmooLedgerSlice,
  type AmooSecretaryLedger,
} from './amooSecretaryLedger.ts'

const nodeRequire = createRequire(import.meta.url)

// phoneBridgeCatalog amoo_ask: prompt maxLength 20000, timeout_ms 15000..1800000
// (default 420000). The phone side clamps; classifyBridgeCall on this side
// rejects. So the desktop pre-check only refuses out-of-range input with the
// legal range spelled out — it never silently rewrites what the user typed.
const MAX_PROMPT_CHARS = 20000
const MIN_BUDGET_MS = 15000
const MAX_BUDGET_MS = 1800000
const DEFAULT_BUDGET_MS = 420000
const POLL_INTERVAL_MS = 5000

// Every desktop write records its source here — fixed, not user-editable, so
// the badge rule below (and Amoo's injection) can always tell a manual desktop
// entry apart from one the phone verified itself.
const DESKTOP_PROVENANCE = 'desktop'

// The capability a secretary round runs on. Its display name is the one the
// phone side uses (Move 1's tool contract), so the desktop's receipt and the
// phone's say the same thing about the same round.
const ROUND_TOOL = 'amoo_ask'

export type AmooEventPhase = 'polling' | 'done' | 'failed' | 'budget_exhausted' | 'idle' | 'stopped'

// Lane states as the secretary pane reads them. 'asking' = the ask was accepted
// but no poll round has landed yet; '' is the bridge's verbatim empty state
// (AmooLoop.ASK_IDLE), kept distinct from the lane's own no_ask_running.
// 'read_failed' = this round could not read the phone's state at all
// (connection / bridge problem) — nobody said the ask failed, so it must not
// wear the 'failed' title; the pane titles the two tiers differently. It is
// deliberately absent from TERMINAL_OUTCOMES: a failed read is not a job
// outcome, and recording it as one would invent a turn the ledger never saw.
export type AmooLaneState =
  | 'asking'
  | 'polling'
  | 'done'
  | 'failed'
  | 'read_failed'
  | 'stopped'
  | 'budget_exhausted'
  | 'no_ask_running'
  | ''

export type AmooSecretaryEvent = {
  type: 'amooSecretary.event'
  /** Same handle the ask reply calls askId; the pane re-reads the lane state on
   * every event instead of trusting this payload. */
  jobId: string
  phase: AmooEventPhase
  round: number
  elapsedMs: number
  budgetMs: number
  message: string
  reply?: string
  code?: string
  unverified?: true
  /** The round's capability name, verbatim from the tool contract. */
  displayName?: string
}

export type AmooProbeReply = {
  ok: boolean
  /** null = the bridge did not report it. Kept distinct from false on purpose:
   * "unknown" must not be rendered as "not installed". */
  assistantAvailable?: boolean | null
  message?: string
  hint?: string
  relayWithheld?: string[]
  uiAvailable?: boolean
  /** amoo_memory's caps, derived from phoneBridgeCatalog (loadMemoryLimits).
   * Absent = the catalog could not be read this session; the pane must then
   * disable writes and say so — no hardcoded fallback exists to fall back to. */
  memoryLimits?: AmooMemoryLimits
  /** Read-only ledger slice. Rides on failed probes too: it is local
   * observation data, and Amoo's absence must not hide the desktop's own
   * record (no dedicated history op exists — probe/result are the two reads
   * the pane already makes). */
  history?: AmooLedgerSlice
  error?: { code: string; message: string }
}

export type AmooAskReply = {
  ok: boolean
  askId?: string
  budgetMs?: number
  state?: 'running'
  unverified?: true
  error?: { code: string; message: string }
}

export type AmooResultReply = {
  state: AmooLaneState
  round?: number
  waitedMs?: number
  budgetMs?: number
  ms?: number
  reply?: string
  replyTruncated?: boolean
  /** The bridge's own wording for why a job ended, passed through verbatim. */
  stopReason?: string
  /** Read-only ledger slice; on a terminal state it already contains the row
   * that was just recorded, so the pane's history area updates in step. */
  history?: AmooLedgerSlice
  unverified: true
  /** The round's capability name, verbatim from the tool contract (the phone
   * side's word for it). Absent only if the contract could not be read and the
   * wire name is used instead. */
  displayName?: string
  error?: { code: string; message: string }
}

export type AmooStopReply = { ok: boolean; message?: string; error?: { code: string; message: string } }

/** One shared-memory fact, copied verbatim from the phone's document. */
export type AmooMemoryEntry = {
  id: string
  text: string
  /** 'verified' = the phone wrote it after a command it executed verified the
   * fact; anything else = somebody asserted it. Never re-labelled here. */
  confidence: string
  provenance: string
}

export type AmooMemoryReply = {
  ok: boolean
  op?: 'get' | 'set'
  /** get: every entry in the phone's document, in the phone's order. */
  entries?: AmooMemoryEntry[]
  /** Bridge receipt: entries in the document (after a set) / total (on a get). */
  entryCount?: number
  /** Bridge receipt: entries the phone counts as verified. */
  verifiedCount?: number
  /** get: entries the phone counts as unverified. */
  unverifiedCount?: number
  /** get: the document was truncated or unparseable — entries is NOT the whole
   * memory, and the pane must say so instead of showing a partial list as
   * complete. */
  partial?: boolean
  code?: string
  message?: string
}

export type AmooLoopStatusReply = {
  ok: boolean
  /** The phone's own verdict on its local exec loop. null = the bridge did not
   * report the field at all; unknown must not be rendered as "not running". */
  running?: boolean | null
  /** The phone's gate-mode enum name, verbatim (bypass/plan/edit/default
   * today; anything new passes through as-is rather than being re-labelled). */
  mode?: string
  /** Latest progress note the phone's loop wrote. Wire field is `report` —
   * Tools.java puts AmooLoop.lastReport() under that key. Amoo-side text: the
   * pane must never present it as a reply to a question asked here, and the
   * ledger must never record it (the ledger only holds Q&A rounds). */
  report?: string
  reportTruncated?: boolean
  /** Phone self-report; the desktop made no measurement of its own. */
  unverified?: true
  error?: { code: string; message: string }
}

export type AmooSecretaryClient = {
  probe: () => Promise<Record<string, unknown>>
  call: (tool: string, args: Record<string, unknown>, options?: Record<string, unknown>) => Promise<Record<string, unknown>>
}

type TimerHandle = { unref?: () => void }

export type AmooSecretaryDeps = {
  /** Test injection; the real lane builds the backend singleton lazily. */
  client?: AmooSecretaryClient
  send?: (msg: unknown) => void
  now?: () => number
  pollIntervalMs?: number
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  /** Test injection; null disables the ledger outright. The real lane builds
   * one lazily on its own — the ledger's holder is the host process and its
   * wiring must not leak into host/main/preload shared files. */
  ledger?: AmooSecretaryLedger | null
  /** Test injection; the real lane reads the catalog lazily (loadMemoryLimits).
   * null = the catalog is unreadable: probe omits memoryLimits and the length
   * pre-checks stand down — the backend policy remains the enforcer. */
  memoryLimits?: AmooMemoryLimits | null
}

export type AmooSecretary = {
  probe: () => Promise<AmooProbeReply>
  ask: (input: { prompt?: string; timeoutMs?: number }) => Promise<AmooAskReply>
  result: () => Promise<AmooResultReply>
  stop: () => Promise<AmooStopReply>
  memory: (
    op: 'get' | 'set',
    id?: string,
    text?: string,
    verified?: boolean,
    provenance?: string,
  ) => Promise<AmooMemoryReply>
  loopStatus: () => Promise<AmooLoopStatusReply>
  release: () => void
}

type AmooJob = {
  askId: string
  budgetMs: number
  startedAt: number
  round: number
  done: boolean
  /** The question verbatim: the ledger records what was actually asked, so a
   * later "was this bubble the answer to THAT?" has the original to compare. */
  prompt: string
}

// The lane's own last word on the current job, in the shape result() hands the
// pane. It outranks the bridge's running / aborted echo: a user stop must not
// flip back to "failed: aborted", and a spent budget must not resurrect
// progress. Cleared by the next ask.
type LaneTerminal = {
  state: AmooLaneState
  reply?: string
  replyTruncated?: boolean
  stopReason?: string
  /** Which poll round the lane was on when the round ended — the receipt's
   * round number. Kept here because the job itself is dropped at the end. */
  round?: number
  error?: { code: string; message: string }
}

// Everything the lane's verbs share, in one object so the verbs can live at
// module scope: one 400-line factory closure was both unreadable and over the
// file ratchet's per-block line cap.
type LaneState = {
  send: (msg: unknown) => void
  now: () => number
  pollIntervalMs: number
  setTimer: (fn: () => void, ms: number) => TimerHandle
  clearTimer: (handle: TimerHandle) => void
  client: AmooSecretaryClient | null
  currentJob: AmooJob | null
  terminal: LaneTerminal | null
  pollTimer: TimerHandle | null
  ledger: AmooSecretaryLedger | null
  /** Catalog-derived amoo_memory caps: undefined = not read yet, null = the
   * catalog is unreadable (no fallback copy exists — see loadMemoryLimits). */
  memoryLimits: AmooMemoryLimits | null | undefined
  /** Tool-contract display names: undefined = not read yet, null = the
   * contract is unreadable (the receipt falls back to the wire name). */
  displayNames: Record<string, string> | null | undefined
}

function resolveKhyOsDir(): string {
  if (process.env.KHY_OS_DIR) return path.resolve(process.env.KHY_OS_DIR)
  // Same resolution as loadGateway in ./index: the electron-spawned host runs
  // with cwd = apps/khyos-desktop, so two levels up is the repo root.
  return path.resolve(process.cwd(), '..', '..')
}

function loadBridgeClient(): AmooSecretaryClient {
  const clientPath = path.join(
    resolveKhyOsDir(),
    'runtime', 'node', 'backend', 'src', 'services', 'domain', 'network', 'phone', 'phoneBridgeClient.js',
  )
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = nodeRequire(clientPath) as { createPhoneBridgeClient: () => AmooSecretaryClient }
  return mod.createPhoneBridgeClient()
}

/** amoo_memory's per-argument caps, derived from phoneBridgeCatalog — never a
 * second copy of the numbers. */
export type AmooMemoryLimits = { id: number; text: number; provenance: number }

// The amoo_memory caps live only in the backend catalog's arg spec
// (phoneBridgeCatalog.js amoo_memory). Reading them here keeps one holder: the
// catalog is the spec's single source, the backend policy's _validateStringArg
// (phoneBridgePolicy.js) is what actually rejects out-of-range values on every
// call, and this lane's pre-check is just the first gate on the desktop path —
// it spells out the legal range instead of silently trimming, but it must not
// carry its own copy of the numbers (a third copy drifted silently the moment
// the catalog changed). When the catalog cannot be read there is NO fallback:
// the caps stay null, the length pre-checks stand down (the policy still
// answers), and the probe reply omits memoryLimits so the pane disables
// writes and says so instead of guessing a limit.
function loadMemoryLimits(): AmooMemoryLimits | null {
  try {
    const catalogPath = path.join(
      resolveKhyOsDir(),
      'runtime', 'node', 'backend', 'src', 'services', 'domain', 'network', 'phone', 'phoneBridgeCatalog.js',
    )
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = nodeRequire(catalogPath) as {
      findPhoneBridgeTool: (name: string) => { args: Record<string, { maxLength?: number }> } | null
    }
    const spec = mod.findPhoneBridgeTool('amoo_memory')?.args
    if (!spec) return null
    const capOf = (arg: string): number | null => {
      const max = spec[arg]?.maxLength
      return typeof max === 'number' && Number.isFinite(max) && max > 0 ? Math.floor(max) : null
    }
    const id = capOf('id')
    const text = capOf('text')
    const provenance = capOf('provenance')
    return id !== null && text !== null && provenance !== null ? { id, text, provenance } : null
  } catch {
    return null
  }
}

// undefined = not read yet (lazy, same reason the client is); null = the
// catalog is unreadable — no limits, no pre-check, no probe field.
function memoryLimitsOf(st: LaneState): AmooMemoryLimits | null {
  if (st.memoryLimits === undefined) st.memoryLimits = loadMemoryLimits()
  return st.memoryLimits
}

/**
 * The tool contract's display names — the one vocabulary the phone side and
 * the desktop share for the same capability (Move 1's amooToolContract.json).
 *
 * WHY this file and not the amoo unit's status sources: the contract is a pure
 * data projection (口径 D1-1 部分, it drives no runtime behaviour); the amoo
 * unit's status provider and panel view model report the OTHER lane's health
 * (adb / bridge / mailbox of the amoo lane), and painting that next to this
 * lane's reply would be a status-source mismatch. So: names only, no status,
 * no policy, no new capability — the contract is not in any allowlist and
 * stays that way.
 *
 * Read lazily (like the catalog) and cached on the lane state. Unreadable
 * contract → no display name → the receipt falls back to the wire name, which
 * is still a fact; inventing a display name would not be.
 */
function loadToolDisplayNames(): Record<string, string> | null {
  try {
    const file = path.join(
      resolveKhyOsDir(),
      'runtime', 'node', 'backend', 'src', 'services', 'domain', 'network', 'amoo', 'amooToolContract.json',
    )
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { tools?: unknown }
    if (!Array.isArray(parsed?.tools)) return null
    const names: Record<string, string> = {}
    for (const item of parsed.tools) {
      const rec = asRecord(item)
      const wire = String(rec?.wireName ?? '')
      const display = String(rec?.displayName ?? '')
      if (wire && display) names[wire] = display
    }
    return Object.keys(names).length > 0 ? names : null
  } catch {
    return null
  }
}

// The round's capability name, as the phone side calls it. Falls back to the
// wire name when the contract is unreadable — a wire name is a fact, a made-up
// display name would be a lie.
function roundDisplayName(st: LaneState): string {
  if (st.displayNames === undefined) st.displayNames = loadToolDisplayNames()
  return st.displayNames?.[ROUND_TOOL] ?? ROUND_TOOL
}

function defaultSend(msg: unknown): void {
  if (process.send) process.send(msg)
  else console.log('[host]', JSON.stringify(msg))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`
}

function errorText(error: unknown): string {
  return String((error as Error)?.message || error || '未知错误')
}

// The backend module lives outside apps/; a wrong KHY_OS_DIR and an outdated
// backend need opposite fixes, so the two are not merged into one sentence.
function clientLoadError(error: unknown): string {
  const raw = errorText(error)
  if (raw.includes('Cannot find module')) {
    return `后端手机桥模块未找到（${raw}）：请确认 KHY_OS_DIR 指向仓库根目录后重启桌面端`
  }
  return raw
}

/**
 * The four failure codes the phone can answer with, each mapped to its own
 * copy. The code lives in the nested `result`: phoneBridgeClient rewrites the
 * top-level code to 'bridge_error' for every bridge-level refusal, so reading
 * the top level would bucket all four together. The poll path carries no code
 * at all — only AmooLoop.askError verbatim — so the prefix match mirrors what
 * Tools.java does on the phone.
 */
function classifyAmooFailure(res: unknown): { code: string; message: string } {
  const shaped = asRecord(res)
  const nested = asRecord(shaped?.result)
  const code = String(nested?.code ?? '')
  const raw = String(nested?.error ?? shaped?.error ?? '')
  if (code === 'requires_confirm') {
    return { code: 'requires_confirm', message: '桥接要求确认而未获批准：这不应发生（桌面侧已随调用带上确认），请重启桌面端后重试' }
  }
  if (code === 'amoo_not_foreground' || raw === 'amoo_not_foreground') {
    return { code: 'amoo_not_foreground', message: 'Amoo 不在前台，提问没有发出。先打开 amoo 的聊天页再重试。' }
  }
  if (code === 'orphaned_ask' || raw.startsWith('orphaned_ask')) {
    return {
      code: 'orphaned_ask',
      message: raw ? `上一笔卡死的提问已释放：${raw}。可重试。` : '上一笔卡死的提问已释放，可重试。',
    }
  }
  if (code === 'single_flight') {
    return { code: 'single_flight', message: 'Amoo 正忙（已有一问在跑）：等结果或先中止' }
  }
  if (code === 'refused' || nested?.ok === false) {
    return { code: 'refused', message: raw || '手机侧拒绝了这次提问（未给出原因）' }
  }
  return {
    code: 'unknown',
    message: `提问失败：${raw || code || '桥接未返回原因'}。请检查手机连接（adb）与 KhyOS 桥后重试`,
  }
}

function newJobId(): string {
  return `amoo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function budgetExhaustedMessage(budgetMs: number, elapsedMs: number): string {
  return `已等 ${seconds(elapsedMs)}，达到本次提问上限 ${seconds(budgetMs)}，Amoo 仍未回复：可继续等（再查一次手机状态）或中止。手机侧任务不会被强行中止。`
}

function countField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/**
 * The phone's memory document (AmooMemory.toJson): { version, entries:
 * [{ id, text, confidence, provenance }] }. Entries are copied field by field
 * and never re-labelled — confidence is the phone's own verdict, and
 * downgrading or upgrading it here would invent a second opinion the bridge
 * never gave. A truncated or unparseable document reports partial instead of
 * pretending the list is complete.
 */
function parseMemoryDocument(json: unknown): { entries: AmooMemoryEntry[]; partial: boolean } {
  if (typeof json !== 'string' || json.trim().length === 0) return { entries: [], partial: true }
  let doc: Record<string, unknown>
  try {
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== 'object') return { entries: [], partial: true }
    doc = parsed as Record<string, unknown>
  } catch {
    return { entries: [], partial: true }
  }
  const entries: AmooMemoryEntry[] = []
  for (const item of Array.isArray(doc.entries) ? doc.entries : []) {
    const rec = asRecord(item)
    if (!rec) continue
    const id = String(rec.id ?? '')
    const text = String(rec.text ?? '')
    if (!id || !text) continue
    entries.push({
      id,
      text,
      confidence: String(rec.confidence ?? 'unverified'),
      provenance: String(rec.provenance ?? ''),
    })
  }
  return { entries, partial: false }
}

// Bridge-level refusals land in the nested result (phoneBridgeClient rewrites
// the top-level code to 'bridge_error' for all of them), so the phone's own
// wording is read from there and passed on verbatim.
function memoryRefusalText(res: Record<string, unknown> | null): string {
  const nested = asRecord(res?.result)
  return String(nested?.error ?? res?.error ?? '')
}

function ensureClient(st: LaneState): AmooSecretaryClient {
  if (st.client) return st.client
  st.client = loadBridgeClient()
  return st.client
}

function emitEvent(st: LaneState, event: Omit<AmooSecretaryEvent, 'type'>): void {
  st.send({ type: 'amooSecretary.event', displayName: roundDisplayName(st), ...event })
}

function stopPollTimer(st: LaneState): void {
  if (st.pollTimer === null) return
  st.clearTimer(st.pollTimer)
  st.pollTimer = null
}

// The ledger only ever sees terminal states; the explicit guard keeps a
// future non-terminal finishJob caller from writing a mid-flight row. The
// outcome is the lane's terminal state verbatim — budget_exhausted / failed /
// stopped / no_ask_running must never be recorded as (or reshaped into) a
// success, and the ledger forces unverified:true on every row it stores.
const TERMINAL_OUTCOMES: ReadonlySet<string> = new Set(['done', 'failed', 'stopped', 'budget_exhausted', 'no_ask_running'])

function recordTerminal(st: LaneState, job: AmooJob, next: LaneTerminal): void {
  if (!st.ledger || !TERMINAL_OUTCOMES.has(next.state)) return
  const endedAt = st.now()
  st.ledger.record({
    askId: job.askId,
    prompt: job.prompt,
    startedAt: job.startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - job.startedAt),
    rounds: job.round,
    outcome: next.state as AmooLedgerOutcome,
    // The round's capability name, so a history row says which capability
    // produced it without the pane keeping a second naming table.
    displayName: roundDisplayName(st),
    ...(next.stopReason !== undefined ? { stopReason: next.stopReason } : {}),
    ...(next.reply !== undefined ? { reply: next.reply, replyTruncated: next.replyTruncated === true } : {}),
    ...(next.error !== undefined ? { error: { code: next.error.code, message: next.error.message } } : {}),
  })
}

// Read-only slice for probe/result replies. The ledger has no IPC op of its
// own: probe and result are the two reads the pane already makes, and adding
// a dedicated verb would mean new wiring lines in the three shared files.
function ledgerSliceOf(st: LaneState): AmooLedgerSlice {
  return st.ledger ? st.ledger.slice(LEDGER_SLICE_LIMIT) : { total: 0, entries: [], persisted: false }
}

function finishJob(st: LaneState, job: AmooJob, next: LaneTerminal, phase: AmooEventPhase, message: string): void {
  job.done = true
  stopPollTimer(st)
  if (st.currentJob === job) st.currentJob = null
  // The round number belongs to the terminal: the job is dropped here, and the
  // receipt must still say which poll round ended it.
  st.terminal = { ...next, round: job.round }
  recordTerminal(st, job, st.terminal)
  emitEvent(st, {
    jobId: job.askId,
    phase,
    round: job.round,
    elapsedMs: Math.max(0, st.now() - job.startedAt),
    budgetMs: job.budgetMs,
    message,
    ...(next.reply !== undefined ? { reply: next.reply, unverified: true as const } : {}),
    ...(next.error !== undefined ? { code: next.error.code } : {}),
  })
}

function schedulePoll(st: LaneState, job: AmooJob): void {
  if (job.done) return
  const timer = st.setTimer(() => {
    st.pollTimer = null
    void pollOnce(st, job)
  }, st.pollIntervalMs)
  st.pollTimer = timer
  // A poll must never hold the host process open (main unrefs the host's
  // sockets for the same reason).
  timer.unref?.()
}

async function pollOnce(st: LaneState, job: AmooJob): Promise<void> {
  if (job.done || st.currentJob !== job) return
  job.round += 1
  const elapsedMs = Math.max(0, st.now() - job.startedAt)
  let res: Record<string, unknown> | null = null
  let readError = ''
  try {
    res = await ensureClient(st).call('amoo_result', {})
  } catch (error) {
    readError = clientLoadError(error)
  }
  if (res && res.success === true) {
    const state = String(res.state ?? '')
    if (state === 'done') {
      finishJob(st, job, {
        state: 'done',
        reply: String(res.reply ?? ''),
        replyTruncated: res.truncated === true,
      }, 'done', 'Amoo 已回复：以下是手机气泡原文（未解析、未校验）')
      return
    }
    if (state === 'failed') {
      const failure = classifyAmooFailure({ error: res.error })
      finishJob(st, job, {
        state: 'failed',
        stopReason: String(res.error ?? ''),
        error: { code: failure.code, message: failure.message },
      }, 'failed', failure.message)
      return
    }
    if (state === '') {
      // AmooLoop.ASK_IDLE: never asked, or the phone process restarted. That
      // is neither a failure nor a success, so it is said exactly as is.
      finishJob(st, job, {
        state: 'no_ask_running',
      }, 'idle', '手机上没有进行中的提问（从未提问或手机进程重启过）：请重新提问')
      return
    }
  }
  // Still running — or this round's read failed. A stuttering bridge is not a
  // failed ask, so polling continues until the budget says stop.
  const readFailed = readError !== '' || (res !== null && res.success !== true)
  const readNote = readFailed
    ? `（本轮读取失败：${readError || String(asRecord(res)?.error ?? asRecord(res)?.code ?? '桥接无响应')}）`
    : ''
  emitEvent(st, {
    jobId: job.askId,
    phase: 'polling',
    round: job.round,
    elapsedMs,
    budgetMs: job.budgetMs,
    message: `等待 Amoo 回复 · 第 ${job.round} 轮 · 已等 ${seconds(elapsedMs)} / 上限 ${seconds(job.budgetMs)}${readNote}`,
  })
  if (elapsedMs >= job.budgetMs) {
    finishJob(st, job, { state: 'budget_exhausted' }, 'budget_exhausted', budgetExhaustedMessage(job.budgetMs, elapsedMs))
    return
  }
  schedulePoll(st, job)
}

function releaseJob(st: LaneState): void {
  // Panel unload / tab switch / last window closed: the timer goes and the
  // job stops being pushed. The phone-side ask is NOT aborted here — that is
  // what stop() is for, and guessing would lie about the phone's state.
  stopPollTimer(st)
  if (st.currentJob) st.currentJob.done = true
  st.currentJob = null
}

// History rides on both ok and failed probes (constraint ①: usable with Amoo
// absent — the local record must stay viewable when the bridge is not).
// memoryLimits rides here too, so the pane's write form reads the caps from
// this reply instead of keeping its own copy; a null derivation spreads
// nothing, which is the pane's signal to disable writes.
async function probeBridge(st: LaneState): Promise<AmooProbeReply> {
  const reply = await probeBridgeOnce(st)
  const limits = memoryLimitsOf(st)
  return {
    ...reply,
    history: ledgerSliceOf(st),
    ...(limits ? { memoryLimits: limits } : {}),
  }
}

async function probeBridgeOnce(st: LaneState): Promise<AmooProbeReply> {
  let raw: Record<string, unknown> | null = null
  try {
    raw = await ensureClient(st).probe()
  } catch (error) {
    return {
      ok: false,
      error: { code: 'probe_failed', message: `探测手机桥接失败：${clientLoadError(error)}。请确认手机已连接、adb 可用后重试` },
    }
  }
  if (raw?.ok !== true) {
    return {
      ok: false,
      error: { code: String(raw?.code ?? 'probe_failed'), message: String(raw?.error ?? '手机桥接未就绪') },
    }
  }
  // Whitelisted projection only: probe's full payload carries status.json
  // and token-adjacent fields, none of which the UI has any business seeing,
  // and every reply below is built field by field for the same reason —
  // nothing from the bridge is ever spread through.
  const assistantAvailable = typeof raw.assistantAvailable === 'boolean' ? raw.assistantAvailable : null
  const base = {
    ok: true,
    assistantAvailable,
    relayWithheld: Array.isArray(raw.relayWithheld) ? raw.relayWithheld.map((x) => String(x)) : [],
    uiAvailable: raw.uiAvailable === true,
  }
  if (assistantAvailable === false) {
    return {
      ...base,
      message: '手机桥在线，但未报到助手协同能力（amoo 提问 / 等回答 / 中止）。',
      hint: '这一组能力整组随 Amoo 安装态关闭；装好后用 khy phone tools 复查能力清单。',
    }
  }
  if (assistantAvailable === null) {
    return {
      ...base,
      message: '手机桥在线，但桥没有回答助手协同能力是否可用。',
      hint: '没报到不等于没有，先按不可用处理；用 khy phone tools 复查能力清单。',
    }
  }
  return {
    ...base,
    message: '手机桥在线，助手协同能力可用。',
    hint: '问题会原样写进 Amoo 的输入框并发送；回复由轮询取回，未经校验。',
  }
}

async function askAmoo(st: LaneState, input: { prompt?: string; timeoutMs?: number }): Promise<AmooAskReply> {
  const prompt = String(input?.prompt ?? '')
  const budgetMs = typeof input?.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
    ? Math.floor(input.timeoutMs)
    : DEFAULT_BUDGET_MS
  if (prompt.trim().length === 0) {
    return { ok: false, error: { code: 'invalid_prompt', message: '提问不能为空：请输入要问 Amoo 的问题' } }
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      error: { code: 'invalid_prompt', message: `提问超过 ${MAX_PROMPT_CHARS} 字（当前 ${prompt.length}）：请缩短后重试` },
    }
  }
  if (budgetMs < MIN_BUDGET_MS || budgetMs > MAX_BUDGET_MS) {
    return {
      ok: false,
      error: {
        code: 'invalid_timeout',
        message: `等待上限需在 ${MIN_BUDGET_MS}..${MAX_BUDGET_MS} 毫秒之间（当前 ${budgetMs}）：手机侧拒绝越界值而不自动钳位，请调整后重试`,
      },
    }
  }
  // No desktop-side single-flight lock or queue: that decision belongs to the
  // phone, and single_flight is presented verbatim instead of being prevented.
  // The previous job's polling is only recycled once this ask is accepted —
  // a refused second ask must not silence the progress of the one still running.
  const startedAt = st.now()
  let res: Record<string, unknown> | null = null
  try {
    // confirm is mandatory: amoo_ask is ACCESS_ACTUATE, so without it the
    // client's confirm gate sends nothing and answers requires_confirm.
    res = await ensureClient(st).call('amoo_ask', { prompt, timeout_ms: budgetMs }, { confirm: true })
  } catch (error) {
    return {
      ok: false,
      error: { code: 'unknown', message: `提问失败：${clientLoadError(error)}。请检查手机连接（adb）与 KhyOS 桥后重试` },
    }
  }
  if (!res || res.success !== true) {
    const failure = classifyAmooFailure(res)
    return { ok: false, error: { code: failure.code, message: failure.message } }
  }
  stopPollTimer(st)
  if (st.currentJob) st.currentJob.done = true
  st.terminal = null
  const job: AmooJob = { askId: newJobId(), budgetMs, startedAt, round: 0, done: false, prompt }
  st.currentJob = job
  schedulePoll(st, job)
  return { ok: true, askId: job.askId, budgetMs, state: 'running', unverified: true }
}

// Same slice as probe: a terminal event lands in the ledger before the pane
// re-pulls, so the history area shows the new row without any dedicated verb.
// The round's capability name travels with every result: the receipt says
// which capability produced it, in the phone side's word for it.
async function readResult(st: LaneState): Promise<AmooResultReply> {
  const reply = await readResultOnce(st)
  return { ...reply, displayName: roundDisplayName(st), history: ledgerSliceOf(st) }
}

// The two read-failure returns below carry state 'read_failed', not 'failed':
// 'failed' is reserved for the bridge saying the ask itself failed. Mapping a
// dead connection onto 'failed' made the pane title an offline phone
// 「提问失败 · 桥报了失败」 — a lie in both halves.
async function readResultOnce(st: LaneState): Promise<AmooResultReply> {
  let res: Record<string, unknown> | null = null
  try {
    res = await ensureClient(st).call('amoo_result', {})
  } catch (error) {
    const reason = clientLoadError(error)
    return {
      state: 'read_failed',
      unverified: true,
      stopReason: reason,
      error: { code: 'unknown', message: `读取 Amoo 提问状态失败：${reason}。请检查手机连接（adb）与 KhyOS 桥后重试` },
    }
  }
  if (!res || res.success !== true) {
    const failure = classifyAmooFailure(res)
    return {
      state: 'read_failed',
      unverified: true,
      stopReason: String(asRecord(res)?.error ?? ''),
      error: { code: failure.code, message: `读取 Amoo 提问状态失败：${failure.message}` },
    }
  }
  const state = String(res.state ?? '')
  const ms = typeof res.ms === 'number' && Number.isFinite(res.ms) ? Math.max(0, Math.floor(res.ms)) : 0
  if (state === 'done') {
    // A real answer outranks everything the lane concluded earlier.
    return {
      state: 'done',
      ms,
      reply: String(res.reply ?? ''),
      replyTruncated: res.truncated === true,
      // The round number the lane saw when the answer landed. Only known if
      // this process ran the round (the terminal carries it) — after a host
      // restart the lane saw no round and says so instead of inventing one.
      ...(st.terminal?.round !== undefined ? { round: st.terminal.round } : {}),
      unverified: true,
    }
  }
  if (st.terminal) {
    // The lane's own last word (stopped / budget_exhausted / failed /
    // no_ask_running) stands until the next ask; the bridge's running or
    // aborted echo must not resurrect progress the user already ended.
    return { ...st.terminal, unverified: true }
  }
  if (state === 'failed') {
    const failure = classifyAmooFailure({ error: res.error })
    return {
      state: 'failed',
      ms,
      unverified: true,
      stopReason: String(res.error ?? ''),
      error: { code: failure.code, message: failure.message },
    }
  }
  if (state === '') {
    // Verbatim empty state from the bridge (AmooLoop.ASK_IDLE): never asked,
    // or the phone process restarted. Distinct from no_ask_running, which is
    // the lane reporting that an ask it started is no longer on the phone.
    return { state: '', ms, unverified: true }
  }
  const job = st.currentJob
  if (job) {
    return {
      state: job.round === 0 ? 'asking' : 'polling',
      round: job.round,
      waitedMs: Math.max(0, st.now() - job.startedAt),
      budgetMs: job.budgetMs,
      ms,
      unverified: true,
    }
  }
  // Running on the phone with no lane job (host restarted, or the pane came
  // back after release): report the phone's own elapsed time, never a round
  // count this process did not see.
  return { state: 'polling', waitedMs: ms, ms, unverified: true }
}

async function stopAsk(st: LaneState): Promise<AmooStopReply> {
  let res: Record<string, unknown> | null = null
  try {
    res = await ensureClient(st).call('amoo_stop', {}, { confirm: true })
  } catch (error) {
    // Polling continues: the phone may still answer even though the abort
    // call never made it. Claiming a stop we did not perform would be a lie.
    return {
      ok: false,
      error: { code: 'unknown', message: `中止请求发送失败：${clientLoadError(error)}。手机侧的提问可能仍在进行，请重试中止` },
    }
  }
  if (!res || res.success !== true) {
    const failure = classifyAmooFailure(res)
    return { ok: false, error: { code: failure.code, message: `中止未被桥接受：${failure.message}` } }
  }
  const job = st.currentJob
  releaseJob(st)
  if (job) {
    st.terminal = { state: 'stopped', round: job.round }
    recordTerminal(st, job, st.terminal)
    emitEvent(st, {
      jobId: job.askId,
      phase: 'stopped',
      round: job.round,
      elapsedMs: Math.max(0, st.now() - job.startedAt),
      budgetMs: job.budgetMs,
      message: '已按你的要求中止：手机侧这一问已停止（未产生的回复不会补送）',
    })
  }
  if (res.ask_running === true) {
    return { ok: true, message: '中止已送达，但手机侧自报提问仍在收尾：可再点一次中止' }
  }
  return { ok: true, message: '已中止：手机侧这一问已停止（未产生的回复不会补送）' }
}

/**
 * The shared memory lives only on the phone (/sdcard/bridge-amoobridge/
 * amoo_memory.json); the desktop calls amoo_memory and never keeps a second
 * copy. get returns the phone's document verbatim; set writes one entry with
 * verified defaulted to false — a manual set must not pass itself off as a
 * measured result (phoneBridgeCatalog.js amoo_memory args).
 */
async function runMemory(
  st: LaneState,
  op: 'get' | 'set',
  id?: string,
  text?: string,
  verified?: boolean,
  provenance?: string,
): Promise<AmooMemoryReply> {
  const action = op === 'set' ? '写入' : '读取'
  if (op !== 'get' && op !== 'set') {
    return { ok: false, code: 'invalid_op', message: 'op 只能是 get / set：get 读共享记忆，set 写一条' }
  }
  const args: Record<string, unknown> = { op }
  if (op === 'set') {
    const key = String(id ?? '').trim()
    const body = String(text ?? '')
    if (!key) {
      return { ok: false, code: 'invalid_args', message: '写入需要 id（稳定键，同 id 覆盖）：请填写后重试' }
    }
    if (body.trim().length === 0) {
      return { ok: false, code: 'invalid_args', message: '写入需要 text（内容，一行）：请填写后重试' }
    }
    // Caps come from the catalog (memoryLimitsOf); when it could not be read
    // they are null and these checks stand down — the backend policy still
    // enforces the spec on the call itself, and the pane has already disabled
    // its write form in that state.
    const limits = memoryLimitsOf(st)
    if (limits) {
      if (key.length > limits.id) {
        return {
          ok: false,
          code: 'invalid_args',
          message: `id 超过 ${limits.id} 字符（当前 ${key.length}）：请缩短后重试`,
        }
      }
      if (body.length > limits.text) {
        return {
          ok: false,
          code: 'invalid_args',
          message: `内容超过 ${limits.text} 字（当前 ${body.length}）：请缩短后重试`,
        }
      }
    }
    const source = String(provenance ?? '').trim() || DESKTOP_PROVENANCE
    if (limits && source.length > limits.provenance) {
      return {
        ok: false,
        code: 'invalid_args',
        message: `来源超过 ${limits.provenance} 字符（当前 ${source.length}）：请缩短后重试`,
      }
    }
    args.id = key
    args.text = body
    args.verified = verified === true
    args.provenance = source
  }
  let res: Record<string, unknown> | null = null
  try {
    // No confirm on purpose: classifyBridgeCall('amoo_memory', …) answers
    // requiresConfirm=false for both ops — the op-dependent branch only
    // special-cases clipboard (phoneBridgePolicy.js:323-328). Passing one
    // anyway would be harmless at runtime but would tell the next reader
    // this is a write that needed approving.
    res = await ensureClient(st).call('amoo_memory', args)
  } catch (error) {
    return {
      ok: false,
      code: 'unknown',
      message: `共享记忆${action}失败：${clientLoadError(error)}。请检查手机连接（adb）与 KhyOS 桥后重试`,
    }
  }
  if (!res || res.success !== true) {
    const raw = memoryRefusalText(res)
    return {
      ok: false,
      code: String(asRecord(res)?.code ?? 'bridge_error'),
      message: `共享记忆${action}失败：${raw || '桥接未返回原因'}。请检查手机连接（adb）与 KhyOS 桥后重试`,
    }
  }
  if (op === 'set') {
    const entryCount = countField(res.entries)
    const verifiedCount = countField(res.verified)
    return {
      ok: true,
      entryCount,
      verifiedCount,
      // The bridge accepted the write, but the phone saves the file on a
      // path whose failures are silently ignored by design (it falls back to
      // process memory), so this is a receipt, not proof of persistence.
      message: `桥上已接受这次写入（当前共 ${entryCount} 条 · 已核实 ${verifiedCount} 条）。手机侧落盘失败会被静默忽略——重新读取可确认。`,
    }
  }
  const document = parseMemoryDocument(res.json)
  const partial = document.partial || res.truncated === true
  return {
    ok: true,
    entries: document.entries,
    entryCount: countField(res.entries),
    verifiedCount: countField(res.verified),
    unverifiedCount: countField(res.unverified),
    ...(partial
      ? {
          partial: true,
          message:
            '记忆文档被桥截断或无法解析：下面不是完整记忆（真源在手机 /sdcard/bridge-amoobridge/amoo_memory.json，上限 60 条）',
        }
      : {}),
  }
}

/**
 * Read-only mirror of the phone's own exec loop (bridge-local `loop_status`,
 * OPTIONAL_TOOLS tier: it answers even when Amoo is absent — a loop that was
 * never started simply reports running:false). ACCESS_READ, so no confirm;
 * same tier as the amoo_result/amoo_memory reads. The desktop keeps no loop
 * state of its own, starts or stops nothing (loop_start/loop_stop are the
 * phone's own surface, [DESIGN-ARCH-193] Q5), and never polls on its own —
 * the pane pulls a snapshot. Fields are projected one by one: nothing from
 * the bridge is ever spread through.
 */
async function readLoopStatus(st: LaneState): Promise<AmooLoopStatusReply> {
  let res: Record<string, unknown> | null = null
  try {
    res = await ensureClient(st).call('loop_status', {})
  } catch (error) {
    return {
      ok: false,
      error: { code: 'unknown', message: `读取循环状态失败：${clientLoadError(error)}。请检查手机连接（adb）与 KhyOS 桥后重试` },
    }
  }
  if (!res || res.success !== true) {
    const raw = memoryRefusalText(res)
    return {
      ok: false,
      error: {
        code: String(asRecord(res)?.code ?? 'bridge_error'),
        message: `读取循环状态失败：${raw || '桥接未返回原因'}。请检查手机连接（adb）与 KhyOS 桥后重试`,
      },
    }
  }
  return {
    ok: true,
    // Unknown ≠ stopped: a bridge that omits the field must not be rendered
    // as a loop that is not running.
    running: res.running === true ? true : res.running === false ? false : null,
    mode: typeof res.mode === 'string' ? res.mode : '',
    report: String(res.report ?? ''),
    ...(res.truncated === true ? { reportTruncated: true } : {}),
    unverified: true,
  }
}

export function createAmooSecretary(deps: AmooSecretaryDeps = {}): AmooSecretary {
  const st: LaneState = {
    send: deps.send || defaultSend,
    now: deps.now || (() => Date.now()),
    pollIntervalMs: deps.pollIntervalMs ?? POLL_INTERVAL_MS,
    setTimer: deps.setTimer || ((fn: () => void, ms: number): TimerHandle => setTimeout(fn, ms)),
    clearTimer: deps.clearTimer || ((handle: TimerHandle) => {
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
    }),
    client: deps.client || null,
    currentJob: null,
    terminal: null,
    pollTimer: null,
    ledger: deps.ledger !== undefined ? deps.ledger : createAmooSecretaryLedger(),
    memoryLimits: deps.memoryLimits,
    displayNames: undefined,
  }
  return {
    probe: () => probeBridge(st),
    ask: (input) => askAmoo(st, input),
    result: () => readResult(st),
    stop: () => stopAsk(st),
    memory: (op, id, text, verified, provenance) => runMemory(st, op, id, text, verified, provenance),
    loopStatus: () => readLoopStatus(st),
    release: () => releaseJob(st),
  }
}
