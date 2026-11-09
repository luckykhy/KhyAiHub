'use strict';

/**
 * logger.js — JSON-line logger used by the daemon, CLI and MCP server.
 *
 * Guarantees:
 *   - stdout is never touched (MCP requires stdout to be protocol-only).
 *   - Token-like strings and message bodies are redacted before serialization.
 *   - A logging failure never throws into the caller.
 *   - File sink rotates at maxBytes and prunes siblings older than retainDays.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

const REDACTED = '[redacted]';

/** Field names whose values are never logged. */
const SENSITIVE_KEYS = new Set([
  'token',
  'access_token',
  'authorization',
  'password',
  'secret',
  'cookie',
  'apikey',
  'api_key',
  'question',
  'text',
  'content',
  'body',
  'raw',
]);

const TOKEN_RE = /\bkhy_[A-Za-z0-9_-]{16,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Scrub credentials embedded in free-form strings.
 * @param {string} value
 * @returns {string}
 */
function redactString(value) {
  return String(value).replace(TOKEN_RE, 'khy_[redacted]').replace(BEARER_RE, 'Bearer [redacted]');
}

/**
 * Deep-ish redaction with a depth and array-length cap.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message || ''),
      code: value.code,
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redact(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(String(key).toLowerCase())) {
        out[key] = REDACTED;
      } else {
        out[key] = redact(item, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

/**
 * Rename the active log to a timestamped sibling and prune old ones.
 * Best effort: any fs error is ignored so logging never breaks the bridge.
 *
 * @param {string} file
 * @param {number} maxBytes
 * @param {number} retainDays
 * @param {number} now epoch ms
 */
function rotateIfNeeded(file, maxBytes, retainDays, now) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.size < maxBytes) return;

  try {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    fs.renameSync(file, `${file}.${stamp}`);
  } catch {
    return; // e.g. file locked by another process; keep appending
  }

  const dir = path.dirname(file);
  const base = path.basename(file);
  const cutoff = now - retainDays * 24 * 60 * 60 * 1000;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === base || !name.startsWith(`${base}.`)) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {
      // ignore
    }
  }
}

/**
 * @param {{
 *   level?: 'debug'|'info'|'warn'|'error',
 *   file?: string|null,
 *   maxBytes?: number,
 *   retainDays?: number,
 *   stderr?: {write: Function}|null,
 *   name?: string,
 *   now?: () => number,
 * }} [options]
 * @returns {{
 *   debug: Function, info: Function, warn: Function, error: Function,
 *   log: Function, child: Function, isEnabled: Function, close: Function,
 *   file: string|null, level: string
 * }}
 */
function createLogger(options = {}) {
  const level = LEVELS[options.level] ? options.level : 'info';
  const threshold = LEVELS[level];
  const file = options.file || null;
  const maxBytes = options.maxBytes || 5 * 1024 * 1024;
  const retainDays = options.retainDays || 14;
  const stderr = options.stderr === undefined ? process.stderr : options.stderr;
  const name = options.name || 'amoon-bridge';
  const now = typeof options.now === 'function' ? options.now : Date.now;

  function appendToFile(line) {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotateIfNeeded(file, maxBytes, retainDays, now());
      fs.appendFileSync(file, line, 'utf8');
    } catch {
      // A logger must not take the bridge down; stderr keeps the record.
      if (stderr && typeof stderr.write === 'function') {
        try {
          stderr.write(`${line.trimEnd()} {"logFileError":true}\n`);
        } catch {
          // give up silently
        }
      }
    }
  }

  function writeToStderr(line) {
    if (!stderr || typeof stderr.write !== 'function') return;
    try {
      stderr.write(line);
    } catch {
      // ignore
    }
  }

  function emit(bindings, levelName, msg, fields) {
    if (LEVELS[levelName] < threshold) return;
    let line;
    try {
      const record = {
        ts: new Date(now()).toISOString(),
        level: levelName,
        name,
        msg: redactString(typeof msg === 'string' ? msg : String(msg)),
      };
      const merged = { ...bindings, ...(fields && typeof fields === 'object' ? fields : {}) };
      const safe = redact(merged);
      if (safe && typeof safe === 'object') Object.assign(record, safe);
      line = `${JSON.stringify(record)}\n`;
    } catch {
      line = `${JSON.stringify({
        ts: new Date().toISOString(),
        level: levelName,
        name,
        msg: '[unserializable log record]',
      })}\n`;
    }
    writeToStderr(line);
    appendToFile(line);
  }

  function make(bindings) {
    const api = {
      file,
      level,
      isEnabled(levelName) {
        return Boolean(LEVELS[levelName]) && LEVELS[levelName] >= threshold;
      },
      log(levelName, msg, fields) {
        if (!LEVELS[levelName]) return;
        emit(bindings, levelName, msg, fields);
      },
      debug(msg, fields) {
        emit(bindings, 'debug', msg, fields);
      },
      info(msg, fields) {
        emit(bindings, 'info', msg, fields);
      },
      warn(msg, fields) {
        emit(bindings, 'warn', msg, fields);
      },
      error(msg, fields) {
        emit(bindings, 'error', msg, fields);
      },
      child(extra) {
        return make({ ...bindings, ...(extra && typeof extra === 'object' ? extra : {}) });
      },
      close() {
        // Synchronous sink; kept for symmetry with future async transports.
      },
    };
    return api;
  }

  return make({});
}

module.exports = {
  LEVELS,
  REDACTED,
  SENSITIVE_KEYS,
  redactString,
  redact,
  rotateIfNeeded,
  createLogger,
};
