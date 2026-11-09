// Amoo secretary ledger (host process): the only holder of the desktop's
// record of every secretary Q&A round. The lane (amooSecretary.ts) appends one
// entry per terminal state; the renderer only ever sees a read-only slice
// carried on existing probe/result replies — no second writer, no
// renderer-side storage, and no sync to or from the phone.
//
// Why a ledger at all: the lane state is transient (last round only, gone when
// the tab unloads), so when the phone's "latest bubble" turns out not to be
// this ask's answer there is nothing to compare against. The ledger is a
// local observation record — NOT the phone's source of truth — and every
// entry quotes Amoo content, so record() forces unverified to the literal
// true and no call site can omit or flip the badge.
//
// displayName is recorded, not derived: the lane copies the tool contract's
// word for the round's capability, and the ledger neither renames it nor
// invents one. Rows written before the field existed simply have none.
//
// Persistence: append-only JSONL under the project data home, resolved through
// the backend's dataHome.js (same nodeRequire precedent as loadBridgeClient),
// so this file never hand-writes a works/data path. Load keeps the most
// recent max entries in the ring; older lines stay in the file untouched
// (same append-only discipline as correction_phrase_samples.jsonl).

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

export const LEDGER_MAX_ENTRIES = 500
// The slice is what crosses the IPC on every probe/result; full replies stay
// in the ring and the JSONL. 20 rows covers a working session without paying
// full-prompt IPC cost on the 3s poll.
export const LEDGER_SLICE_LIMIT = 20
// Cap the interaction plan fixed for reply excerpts crossing the IPC.
export const LEDGER_REPLY_EXCERPT_MAX = 600

// Registered in docs/10_规范/registry/DATA-LOCATIONS.json seedEntries
// (amoo-secretary-ledger). Kept as data so a test can pin the registration.
export const LEDGER_RELATIVE_SEGMENTS = ['T1-domains', 'desktop', 'amoo-secretary', 'ledger.jsonl']

export type AmooLedgerOutcome = 'done' | 'failed' | 'stopped' | 'budget_exhausted' | 'no_ask_running'

export type AmooLedgerEntry = {
  ts: number
  askId: string
  prompt: string
  startedAt: number
  endedAt: number
  durationMs: number
  rounds: number
  outcome: AmooLedgerOutcome
  stopReason?: string
  reply?: string
  replyTruncated?: boolean
  /** The round's capability name, verbatim from the tool contract (the phone
   * side's word for it). Recorded by the lane; the ledger never renames it and
   * never invents one — rows written before this field existed simply have
   * none. */
  displayName?: string
  error?: { code: string; message: string }
  /** Forced to the literal true by record(): entries quote Amoo content. */
  unverified: true
}

export type AmooLedgerRecordInput = Omit<AmooLedgerEntry, 'ts' | 'unverified'>

export type AmooLedgerSliceEntry = AmooLedgerEntry & { replyExcerpted?: true }

export type AmooLedgerSlice = {
  /** Rows currently viewable; the ring keeps only the most recent ones. */
  total: number
  /** Newest first, capped at the caller's limit, reply excerpts ≤600 chars. */
  entries: AmooLedgerSliceEntry[]
  /** false = the JSONL file could not be resolved or written this run: the
   * ledger is memory-only and the UI must not claim restart survival. */
  persisted: boolean
}

function resolveKhyOsDir(): string {
  if (process.env.KHY_OS_DIR) return path.resolve(process.env.KHY_OS_DIR)
  // Same resolution as amooSecretary.ts loadBridgeClient: the electron-spawned
  // host runs with cwd = apps/khyos-desktop, so two levels up is the repo root.
  return path.resolve(process.cwd(), '..', '..')
}

function resolveLedgerFile(): string | null {
  try {
    const dataHome = nodeRequire(
      path.join(resolveKhyOsDir(), 'runtime', 'node', 'backend', 'src', 'utils', 'dataHome.js'),
    ) as { getProjectDataPath?: (...segments: string[]) => string }
    if (typeof dataHome.getProjectDataPath !== 'function') return null
    const resolved = dataHome.getProjectDataPath(...LEDGER_RELATIVE_SEGMENTS)
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : null
  } catch {
    // Backend tree missing (standalone desktop checkout): the ledger keeps
    // working in memory and persisted:false says so honestly.
    return null
  }
}

export type AmooSecretaryLedger = {
  record: (input: AmooLedgerRecordInput) => void
  slice: (limit?: number) => AmooLedgerSlice
  total: () => number
}

export type AmooSecretaryLedgerDeps = {
  /** Explicit file path. null = memory-only (tests / no-backend runs);
   * undefined = resolve through the backend dataHome resolver. */
  file?: string | null
  now?: () => number
  max?: number
}

export function createAmooSecretaryLedger(deps: AmooSecretaryLedgerDeps = {}): AmooSecretaryLedger {
  const max =
    typeof deps.max === 'number' && Number.isFinite(deps.max) && deps.max > 0
      ? Math.floor(deps.max)
      : LEDGER_MAX_ENTRIES
  const now = deps.now || (() => Date.now())
  // Resolution is deferred to first use: a lane that never reaches a terminal
  // state (most tests, a desktop session with zero asks) must not even create
  // the ledger's directory in the data home.
  let resolvedFile: string | null | undefined
  const ledgerFile = (): string | null => {
    if (resolvedFile === undefined) {
      resolvedFile = deps.file !== undefined ? deps.file : resolveLedgerFile()
    }
    return resolvedFile
  }
  const ring: AmooLedgerEntry[] = []
  let loaded = false
  let writeBroken = false
  // A torn line (process killed mid-append) ends without a newline; the next
  // append must start on a fresh line or it would weld itself onto the torn
  // one and both rows would fail to parse.
  let pendingNewline = false

  function ensureLoaded(): void {
    if (loaded) return
    loaded = true
    const file = ledgerFile()
    if (!file) return
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      return // first run / file not created yet — an empty ledger, not an error
    }
    if (raw.length > 0 && !raw.endsWith('\n')) pendingNewline = true
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (parsed && typeof parsed === 'object') ring.push(parsed as AmooLedgerEntry)
      } catch {
        // Torn or corrupted row: skipped, never fatal, never rewritten —
        // the file is append-only.
      }
    }
    if (ring.length > max) ring.splice(0, ring.length - max)
  }

  function record(input: AmooLedgerRecordInput): void {
    try {
      ensureLoaded()
      const entry: AmooLedgerEntry = { ...input, ts: now(), unverified: true }
      ring.push(entry)
      if (ring.length > max) ring.splice(0, ring.length - max)
      const file = ledgerFile()
      if (!file) return
      try {
        const chunk = `${pendingNewline ? '\n' : ''}${JSON.stringify(entry)}\n`
        fs.appendFileSync(file, chunk, 'utf8')
        pendingNewline = false
        writeBroken = false
      } catch {
        // One failed append must not touch the lane; persisted flips false so
        // the UI stops claiming restart survival.
        writeBroken = true
      }
    } catch {
      // The ledger is an observer: any surprise here costs a history row,
      // never the ask itself.
    }
  }

  function slice(limit = LEDGER_SLICE_LIMIT): AmooLedgerSlice {
    ensureLoaded()
    const count =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : LEDGER_SLICE_LIMIT
    const entries: AmooLedgerSliceEntry[] = ring.slice(-count).reverse().map((entry) => {
      const reply = typeof entry.reply === 'string' ? entry.reply : undefined
      if (reply === undefined || reply.length <= LEDGER_REPLY_EXCERPT_MAX) return { ...entry }
      return { ...entry, reply: reply.slice(0, LEDGER_REPLY_EXCERPT_MAX), replyExcerpted: true }
    })
    return { total: ring.length, entries, persisted: ledgerFile() !== null && !writeBroken }
  }

  function total(): number {
    ensureLoaded()
    return ring.length
  }

  return { record, slice, total }
}
