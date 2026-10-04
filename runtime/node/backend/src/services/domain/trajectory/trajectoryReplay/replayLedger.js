'use strict';

/**
 * replayLedger.js — full-fidelity replay ledger (DESIGN-ARCH-048 PHASE 1).
 *
 * The recording-side source of truth for deterministic replay. The JSONL
 * transcript is insufficient: auto-injected tools persist `input:{}`, the NL/text
 * tool loop persists only prose, and receipts/audit truncate params to 200 chars.
 * This ledger records EVERY tool turn with its COMPLETE, untruncated params plus
 * result/artifact hashes, so a trajectory can later be re-executed without an AI.
 *
 * Layout — a JSONL sidecar co-located with the session transcript (mirroring
 * trajectoryProvenance/traceChain.js path derivation), append-only so high
 * frequency turns never rewrite the whole file on the hot path:
 *     <dir>/<base>.replay-ledger.jsonl
 *
 * The ledger stores only HASHES (cheap, hot-path-safe). The actual bytes needed
 * to reproduce a deleted file are written, best-effort, to a session-scoped
 * content store (content-addressed by sha256) so a file deleted *before* export
 * is still reproducible. Gated by KHY_REPLAY_CAPTURE_CONTENT (default on).
 *
 * 防呆 (red line 1): every write here is best-effort and wrapped in try/catch.
 * A ledger failure must NEVER fail a tool call or a message write, and this
 * module never mutates the caller's result or any model-visible content.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const artifactHash = require('./artifactHash');
const tierRegistry = require('./tierRegistry');

const LEDGER_VERSION = 1;
const LEDGER_EXT = '.replay-ledger.jsonl';

// In-memory monotonic seq counter per session (lazily seeded from ledger length).
const _seqCounters = new Map();

// ── Deferred-write state (DESIGN-ARCH-161 P0-2) ──
// Hot-path disk I/O (mkdirSync/appendFileSync per tool turn) serialized parallel
// tool batches. Ledger lines are queued per path and flushed on a debounce;
// read() merges the queue so "record then read" stays immediately consistent.
// The content store (write-diff blobs only) stays synchronous — see _storeContent.
const _pendingLines = new Map(); // ledgerPath -> string[] (JSONL lines, '\n'-terminated)
let _flushChain = Promise.resolve();
let _flushTimer = null;

function _flushDebounceMs() {
  const v = parseInt(process.env.KHY_REPLAY_LEDGER_FLUSH_MS || '150', 10);
  return Number.isFinite(v) ? Math.max(0, v) : 150;
}

const FLUSH_BATCH_LINES = 32;

function _ledgerSyncForced() {
  const v = String(process.env.KHY_REPLAY_LEDGER_SYNC || '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true' || v === 'yes';
}

function _enqueueLine(ledgerPath, line) {
  let arr = _pendingLines.get(ledgerPath);
  if (!arr) {
    arr = [];
    _pendingLines.set(ledgerPath, arr);
  }
  arr.push(line);
  if (arr.length >= FLUSH_BATCH_LINES) {
    _scheduleFlush(0);
  } else {
    _scheduleFlush(_flushDebounceMs());
  }
}

function _scheduleFlush(delayMs) {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
  }
  const t = setTimeout(() => {
    _flushTimer = null;
    flush().catch(() => {
      /* best-effort — a failed flush must never crash the tool loop */
    });
  }, delayMs);
  if (t.unref) {
    t.unref();
  }
  _flushTimer = t;
}

/** Drain the line queue to disk asynchronously, serialized per path via _flushChain. */
function flush() {
  const task = _flushChain.then(_drainAsync).catch(() => {});
  _flushChain = task;
  return task;
}

async function _drainAsync() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  const linesSnapshot = [..._pendingLines.entries()];
  for (const [ledgerPath] of linesSnapshot) {
    _pendingLines.delete(ledgerPath);
  }
  for (const [ledgerPath, lines] of linesSnapshot) {
    try {
      await fs.promises.mkdir(path.dirname(ledgerPath), { recursive: true });
      await fs.promises.appendFile(ledgerPath, lines.join(''));
    } catch {
      /* best-effort — ledger failure must never fail a tool call */
    }
  }
}

/** Synchronous drain for process exit, export, and forced-sync consumers. */
function _drainSync() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  for (const [ledgerPath, lines] of _pendingLines) {
    try {
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      fs.appendFileSync(ledgerPath, lines.join(''));
    } catch {
      /* best-effort */
    }
  }
  _pendingLines.clear();
}

let _exitHookRegistered = false;
function _ensureExitHook() {
  if (_exitHookRegistered) {
    return;
  }
  _exitHookRegistered = true;
  process.on('exit', _drainSync);
}

/** Number of queued-but-unflushed ledger lines (observability/testing). */
function pendingCount() {
  let n = 0;
  for (const arr of _pendingLines.values()) {
    n += arr.length;
  }
  return n;
}

function _captureContentEnabled() {
  const v = String(process.env.KHY_REPLAY_CAPTURE_CONTENT || 'on').toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/** Derive the ledger sidecar path from a session's JSONL transcript path. */
function ledgerPathFor(jsonlPath) {
  const dir = path.dirname(jsonlPath);
  const base = path.basename(jsonlPath).replace(/\.jsonl$/i, '');
  return path.join(dir, `${base}${LEDGER_EXT}`);
}

/** Resolve the ledger path for a sessionId via sessionPersistence's path SSOT. */
function _ledgerPathForSession(sessionId) {
  // Late require to avoid a load cycle (sessionPersistence requires nothing here).
  const sp = require('../../../sessionPersistence');
  return ledgerPathFor(sp.jsonlPathFor(sessionId));
}

/** Session-scoped content store directory (content-addressed by sha256). */
function _contentStoreDir(sessionId) {
  const { getProjectDataDir } = require('../../../../utils/dataHome');
  return getProjectDataDir('trajectory_replay', String(sessionId), 'content');
}

/** Persist after-bytes to the content store, keyed by sha256. Best-effort.
 * Kept synchronous on purpose: callers (exportBundle, reproduction of deleted
 * files) assume the blob is on disk the moment recordToolTurn returns. */
function _storeContent(sessionId, sha, content) {
  try {
    if (!sha || content == null) {
      return;
    }
    const dir = _contentStoreDir(sessionId);
    const blob = path.join(dir, sha);
    if (fs.existsSync(blob)) {
      return;
    } // content-addressed → already stored
    const tmp = path.join(
      dir,
      `.${sha}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    );
    fs.writeFileSync(tmp, Buffer.from(content, 'utf-8'), { mode: 0o600 });
    fs.renameSync(tmp, blob);
  } catch {
    /* best-effort — content store is an optional reproduction aid */
  }
}

/** Read entries (JSONL) from a ledger file, including queued-unflushed entries. */
function read(ledgerPath) {
  const rawLines = [];
  try {
    if (fs.existsSync(ledgerPath)) {
      rawLines.push(...fs.readFileSync(ledgerPath, 'utf-8').split('\n'));
    }
  } catch {
    /* fall through — pending queue is still authoritative for this call */
  }
  const pending = _pendingLines.get(ledgerPath);
  if (pending && pending.length > 0) {
    rawLines.push(...pending.join('').split('\n'));
  }
  return rawLines
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Next monotonic seq for a session (seeded once from on-disk ledger length). */
function nextSeq(sessionId) {
  const key = String(sessionId);
  if (!_seqCounters.has(key)) {
    let seed = 0;
    try {
      seed = read(_ledgerPathForSession(sessionId)).length;
    } catch {
      seed = 0;
    }
    _seqCounters.set(key, seed);
  }
  const v = _seqCounters.get(key);
  _seqCounters.set(key, v + 1);
  return v;
}

/**
 * Derive the artifact list + writeDiff-hash summary from a finalized _khyWriteDiff
 * ({ filePath, beforeContent, afterContent }). Empty beforeContent ⇒ create;
 * empty afterContent ⇒ delete; otherwise modify.
 */
function _artifactsFromWriteDiff(sessionId, writeDiff) {
  if (!writeDiff || typeof writeDiff.filePath !== 'string') {
    return { writeDiffHashes: null, artifacts: [] };
  }
  const before = typeof writeDiff.beforeContent === 'string' ? writeDiff.beforeContent : '';
  const after = typeof writeDiff.afterContent === 'string' ? writeDiff.afterContent : '';
  const beforeHash = before === '' ? null : artifactHash.hashString(before);
  const afterHash = after === '' ? null : artifactHash.hashString(after);
  const op = before === '' ? 'create' : after === '' ? 'delete' : 'modify';

  // Persist the after-bytes so a later-deleted file can still be reproduced.
  if (afterHash && _captureContentEnabled()) {
    _storeContent(sessionId, afterHash, after);
  }

  return {
    writeDiffHashes: { filePath: writeDiff.filePath, beforeHash, afterHash },
    artifacts: [{ path: writeDiff.filePath, sha256: afterHash, op }],
  };
}

/** Summarize a structured tool result into a small, hashable shape. */
function _summarizeResult(result) {
  if (!result || typeof result !== 'object') {
    return { success: undefined, exitCode: undefined, outputHash: null, denied: false };
  }
  const output =
    result.output != null
      ? result.output
      : result.content != null
        ? result.content
        : result.stdout != null
          ? result.stdout
          : null;
  return {
    success: result.success === true,
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : undefined,
    outputHash: output == null ? null : artifactHash.hashCanonical(output),
    denied: result.denied === true,
  };
}

/**
 * Record one tool turn into the ledger. Best-effort; never throws out.
 * @param {object} arg
 * @param {string} arg.sessionId
 * @param {string} arg.name        raw tool name as called
 * @param {object} arg.params      COMPLETE untruncated params
 * @param {object} arg.result      structured tool result
 * @param {object|null} arg.writeDiff  result._khyWriteDiff (or null)
 * @param {number} [arg.seq]       explicit seq (else auto monotonic)
 * @returns {{ok:boolean, seq?:number, error?:string}}
 */
function recordToolTurn({ sessionId, name, params, result, writeDiff, seq } = {}) {
  try {
    if (sessionId == null || name == null) {
      return { ok: false, error: 'missing sessionId/name' };
    }
    const normName = tierRegistry.normalize(name);
    const tier = tierRegistry.effectiveTier(name);
    const { writeDiffHashes, artifacts } = _artifactsFromWriteDiff(sessionId, writeDiff);
    const entry = {
      v: LEDGER_VERSION,
      seq: typeof seq === 'number' ? seq : nextSeq(sessionId),
      at: Date.now(),
      name: String(name),
      normName,
      tier,
      params: params == null ? {} : params,
      paramsHash: artifactHash.hashCanonical(params == null ? {} : params),
      result: _summarizeResult(result),
      writeDiff: writeDiffHashes,
      artifacts,
    };
    const ledgerPath = _ledgerPathForSession(sessionId);
    const line = JSON.stringify(entry) + '\n';
    if (_ledgerSyncForced()) {
      const dir = path.dirname(ledgerPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(ledgerPath, line);
    } else {
      _ensureExitHook();
      _enqueueLine(ledgerPath, line);
    }
    return { ok: true, seq: entry.seq };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Verify ledger structural integrity: seq is contiguous from 0 and each entry
 * carries the required shape. Returns the first bad index.
 * @returns {{ok:boolean, length:number, badAt:number|null, reason:string|null}}
 */
function verifyLedger(ledgerPath) {
  const entries = read(ledgerPath);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i) {
      return {
        ok: false,
        length: entries.length,
        badAt: i,
        reason: `seq 不连续：期望 ${i} 实为 ${e.seq}`,
      };
    }
    if (typeof e.name !== 'string' || !e.tier) {
      return { ok: false, length: entries.length, badAt: i, reason: `条目 #${i} 缺 name/tier` };
    }
  }
  return { ok: true, length: entries.length, badAt: null, reason: null };
}

/** Test/maintenance helper: drain queues, then reset the in-memory seq counter. */
function _resetSeq(sessionId) {
  _drainSync();
  if (sessionId == null) {
    _seqCounters.clear();
  } else {
    _seqCounters.delete(String(sessionId));
  }
}

module.exports = {
  LEDGER_VERSION,
  LEDGER_EXT,
  ledgerPathFor,
  recordToolTurn,
  read,
  nextSeq,
  verifyLedger,
  flush,
  drainSync: _drainSync,
  pendingCount,
  _contentStoreDir,
  _resetSeq,
};
