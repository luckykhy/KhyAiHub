'use strict';

/**
 * idempotency.js — durable id-based replay for POST /call.
 *
 * The caller supplies `id` (8..64 chars) in the JSON body. The server keys an
 * entry by principal + id, and stores the tool + args digest with the response:
 *   - same id + same digest  -> replay the stored response, marked replayed
 *   - same id + other digest -> id_conflict (409), never execute
 *   - same id still running  -> id_conflict/in_flight, never execute twice
 *
 * Persistence is one JSON file under <stateDir>/idempotency/store.json, written
 * atomically. Entries expire after LIMITS.idempotencyTtlMs (24h default).
 *
 * A crash between begin() and commit() leaves no durable entry, so a retry
 * re-executes the tool. That is at-least-once, not exactly-once; the mailbox
 * and the tools' own idempotency flags are the durable layer for side effects.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const C = require('./contracts');

/**
 * Deterministic JSON so key order cannot change the digest.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Idempotency digest for a tool call.
 *
 * @param {string} tool
 * @param {object} [args]
 * @returns {string} hex sha256
 */
function digestOf(tool, args) {
  return crypto
    .createHash('sha256')
    .update(stableJson({ tool, args: args || {} }), 'utf8')
    .digest('hex');
}

/**
 * @param {{config?: object, stateDir?: string, dir?: string, ttlMs?: number,
 *          maxEntries?: number, clock?: Function}} [options]
 * @returns {{begin: Function, commit: Function, abort: Function, sweep: Function,
 *            size: Function, dir: string|null}}
 */
function createIdempotency(options = {}) {
  const config = options.config || {};
  const stateDir = options.stateDir || config.stateDir || null;
  const dir = options.dir || (stateDir ? path.join(stateDir, C.LOCAL_SUBDIRS.idempotency) : null);
  const file = dir ? path.join(dir, 'store.json') : null;
  const ttlMs =
    Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : C.LIMITS.idempotencyTtlMs;
  const maxEntries =
    Number.isFinite(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : 1000;
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;

  /** @type {Map<string, {digest:string,response:object,at:number}>} */
  const entries = new Map();
  const inFlight = new Set();

  function load() {
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const source = raw && raw.entries && typeof raw.entries === 'object' ? raw.entries : raw;
      if (!source || typeof source !== 'object') return;
      for (const [key, value] of Object.entries(source)) {
        if (!value || typeof value !== 'object') continue;
        if (typeof value.digest !== 'string' || !Number.isFinite(value.at)) continue;
        entries.set(key, { digest: value.digest, response: value.response, at: value.at });
      }
    } catch {
      // Missing/corrupt store: start empty. Never fail the daemon for this.
    }
  }

  function persist() {
    if (!file) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const data = {};
      for (const [key, value] of entries) data[key] = value;
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, entries: data })}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(tmp, file);
    } catch {
      // Best effort: in-memory replay still works for this process.
    }
  }

  function prune() {
    const cutoff = clock() - ttlMs;
    for (const [key, value] of entries) {
      if (!value || value.at < cutoff) entries.delete(key);
    }
    if (entries.size > maxEntries) {
      const oldest = [...entries.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [key] of oldest.slice(0, entries.size - maxEntries)) entries.delete(key);
    }
  }

  load();
  prune();

  function begin(key, digest) {
    prune();
    const existing = entries.get(key);
    if (existing) {
      if (existing.digest !== digest) return { state: 'conflict', entry: existing };
      return { state: 'replay', entry: existing };
    }
    if (inFlight.has(key)) return { state: 'in_flight' };
    inFlight.add(key);
    return { state: 'new' };
  }

  function commit(key, digest, response) {
    inFlight.delete(key);
    entries.set(key, { digest, response, at: clock() });
    prune();
    persist();
  }

  function abort(key) {
    inFlight.delete(key);
  }

  function sweep() {
    prune();
    persist();
    return entries.size;
  }

  return {
    begin,
    commit,
    abort,
    sweep,
    size: () => entries.size,
    dir,
  };
}

module.exports = {
  createIdempotency,
  digestOf,
  stableJson,
};
