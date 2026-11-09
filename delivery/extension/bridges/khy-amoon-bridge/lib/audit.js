'use strict';

/**
 * audit.js — append-only JSONL audit log with a per-file hash chain.
 *
 * Layout:
 *   <stateDir>/audit/YYYY-MM-DD.jsonl
 *   <stateDir>/audit/YYYY-MM-DD.jsonl.<rotation-stamp>   (after 5 MB)
 *
 * Every record is written as one JSON line:
 *   { ts, seq, prev, ...record }
 * where `seq` starts at 0 in each physical file and `prev` is the SHA-256 of
 * the previous raw line ("0"*64 for the first line). verify() recomputes the
 * chain and reports the first broken record.
 *
 * Honest limitation (from the design): a hash chain only makes tampering
 * visible to someone who checks it; it does not prevent a local administrator
 * from rewriting the file and the chain together. Never describe it as
 * tamper-proof.
 *
 * Redaction: records pass through logger.redact(), which replaces known
 * sensitive field names and khy_/Bearer credentials. Callers should still
 * store digests rather than raw question/message bodies.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const C = require('./contracts');
const { redact } = require('./logger');

const GENESIS = '0'.repeat(64);
const DAY_RE = /^\d{4}-\d{2}-\d{2}/;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function isoDay(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * @param {{
 *   config?: object,
 *   logger?: object,
 *   clock?: Function|{now:Function},
 *   dir?: string,
 *   maxBytes?: number,
 *   retainDays?: number,
 * }} [options]
 * @returns {{dir:string, write:Function, tail:Function, verify:Function, currentFile:Function}}
 */
function createAudit(options = {}) {
  const { config, logger } = options;
  const clockOption = options.clock;
  const now =
    typeof clockOption === 'function'
      ? clockOption
      : clockOption && typeof clockOption.now === 'function'
        ? clockOption.now.bind(clockOption)
        : Date.now;

  const dir =
    options.dir ||
    (config && config.paths && config.paths.dirs && config.paths.dirs.audit) ||
    (config && config.stateDir ? path.join(config.stateDir, C.LOCAL_SUBDIRS.audit) : path.join(process.cwd(), 'audit'));

  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : C.LIMITS.auditMaxBytes;
  const retainDays = Number.isFinite(options.retainDays) && options.retainDays > 0
    ? options.retainDays
    : C.LIMITS.auditRetainDays;

  /** Current physical file state. */
  let state = null;

  function fileFor(day) {
    return path.join(dir, `${day}.jsonl`);
  }

  function loadState(file) {
    state = { file, seq: 0, prev: GENESIS, size: 0 };
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    state.size = Buffer.byteLength(text, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    if (lines.length === 0) return;
    const last = lines[lines.length - 1];
    try {
      const record = JSON.parse(last);
      if (Number.isInteger(record.seq) && record.seq >= 0) {
        state.seq = record.seq + 1;
        state.prev = sha256Hex(last);
      }
    } catch {
      // A unreadable tail means the chain cannot be extended safely; start a
      // fresh chain after rotating the damaged file away.
      rotateCurrent();
    }
  }

  function ensureFile(day) {
    const file = fileFor(day);
    if (!state || state.file !== file) loadState(file);
    return file;
  }

  function rotateCurrent() {
    if (!state || !state.file) return false;
    if (!fs.existsSync(state.file)) {
      state = { ...state, seq: 0, prev: GENESIS, size: 0 };
      return false;
    }
    const stamp = `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
    const rotated = `${state.file}.${stamp}`;
    try {
      fs.renameSync(state.file, rotated);
    } catch {
      return false;
    }
    state = { ...state, seq: 0, prev: GENESIS, size: 0 };
    return true;
  }

  function prune(epochMs) {
    const cutoff = epochMs - retainDays * 24 * 60 * 60 * 1000;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!DAY_RE.test(name)) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Append one audit record.
   *
   * @param {object} record
   * @returns {object} the record as written (including ts/seq/prev)
   */
  function write(record) {
    const ts = now();
    const day = isoDay(ts);
    const file = ensureFile(day);
    fs.mkdirSync(dir, { recursive: true });

    const safe = redact(record && typeof record === 'object' ? record : {});
    const tsIso = new Date(ts).toISOString();

    // Estimate with the current chain state, rotate if needed, and only then
    // serialize: rotation resets seq/prev, so building the entry before the
    // check would write the old sequence into the new physical file.
    const probe = JSON.stringify({ ...(safe && typeof safe === 'object' ? safe : {}), ts: tsIso, seq: state.seq, prev: state.prev });
    const probeBytes = Buffer.byteLength(probe, 'utf8') + 1;
    if (probeBytes > maxBytes) {
      throw new C.BridgeError('payload_too_large', '审计记录超过单条大小上限', {
        bytes: probeBytes,
        max: maxBytes,
      });
    }
    if (state.size > 0 && state.size + probeBytes > maxBytes) {
      rotateCurrent();
    }

    // Ours are authoritative even if a caller tried to supply them.
    const entry = {
      ...(safe && typeof safe === 'object' ? safe : {}),
      ts: tsIso,
      seq: state.seq,
      prev: state.prev,
    };
    const line = JSON.stringify(entry);
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (lineBytes > maxBytes) {
      throw new C.BridgeError('payload_too_large', '审计记录超过单条大小上限', {
        bytes: lineBytes,
        max: maxBytes,
      });
    }

    fs.appendFileSync(file, `${line}\n`, 'utf8');
    state.seq += 1;
    state.prev = sha256Hex(line);
    state.size += lineBytes;
    prune(ts);
    return entry;
  }

  function listFiles() {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const files = [];
    for (const name of names) {
      if (!DAY_RE.test(name) || !name.includes('.jsonl')) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile()) files.push({ file: full, mtimeMs: stat.mtimeMs, name });
      } catch {
        // ignore
      }
    }
    files.sort((a, b) => (a.mtimeMs - b.mtimeMs) || a.name.localeCompare(b.name));
    return files.map((f) => f.file);
  }

  /**
   * Return the last `n` parsed records, oldest first.
   *
   * @param {number} [n]
   * @returns {object[]}
   */
  function tail(n = 100) {
    const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 100;
    const out = [];
    const files = listFiles();
    for (let i = files.length - 1; i >= 0 && out.length < limit; i -= 1) {
      let text;
      try {
        text = fs.readFileSync(files[i], 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n').filter(Boolean);
      for (let j = lines.length - 1; j >= 0 && out.length < limit; j -= 1) {
        try {
          out.push(JSON.parse(lines[j]));
        } catch {
          // A single damaged line must not hide the rest.
        }
      }
    }
    return out.reverse();
  }

  /**
   * Verify the hash chain of every file whose name starts with `day`.
   *
   * @param {string} [day] YYYY-MM-DD, defaults to today
   * @returns {{ok:boolean, day:string, files:Array<{file:string,records:number,ok:boolean,errors:string[]}>}}
   */
  function verify(day) {
    const prefix = typeof day === 'string' && DAY_RE.test(day) ? day : isoDay(now());
    const files = listFiles().filter((file) => path.basename(file).startsWith(prefix));
    const details = [];
    let allOk = true;

    for (const file of files) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        details.push({ file, records: 0, ok: false, errors: [`read failed: ${err.message}`] });
        allOk = false;
        continue;
      }
      const lines = text.split('\n').filter(Boolean);
      const errors = [];
      let prev = GENESIS;
      let expectedSeq = 0;
      for (let i = 0; i < lines.length; i += 1) {
        let record;
        try {
          record = JSON.parse(lines[i]);
        } catch {
          errors.push(`line ${i + 1}: invalid JSON`);
          break;
        }
        if (record.seq !== expectedSeq) {
          errors.push(`line ${i + 1}: seq ${record.seq} != ${expectedSeq}`);
          break;
        }
        if (record.prev !== prev) {
          errors.push(`line ${i + 1}: prev hash mismatch`);
          break;
        }
        prev = sha256Hex(lines[i]);
        expectedSeq += 1;
      }
      if (errors.length) allOk = false;
      details.push({ file, records: lines.length, ok: errors.length === 0, errors });
    }

    if (details.length === 0) allOk = false;
    return { ok: allOk, day: prefix, files: details };
  }

  function currentFile() {
    const file = fileFor(isoDay(now()));
    return { file, exists: fs.existsSync(file) };
  }

  // Best-effort log of our own failures; never throws into the caller.
  const wrappedWrite = (record) => {
    try {
      return write(record);
    } catch (err) {
      if (logger && typeof logger.error === 'function') {
        logger.error('audit write failed', { error: err.message, code: err.code });
      }
      return null;
    }
  };

  return { dir, write: wrappedWrite, writeStrict: write, tail, verify, currentFile };
}

module.exports = {
  GENESIS,
  sha256Hex,
  isoDay,
  createAudit,
};
