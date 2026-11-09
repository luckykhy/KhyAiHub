'use strict';

/**
 * Contract path shim: PC-side spool/index helpers.
 *
 * The poller (lib/mailbox.js) owns the remote mailbox. This module is the
 * local-outbox/replies index used by amoon_send/amoon_inbox, kept separate so
 * other callers do not have to duplicate atomic-write rules.
 */

const fs = require('fs');
const path = require('path');

const C = require('../contracts');

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/**
 * @param {{config: object, logger?: object}} options
 */
function createMailboxStore(options = {}) {
  const config = options.config || {};
  const logger = options.logger || silentLogger();
  const outboxDir = config.paths.dirs.outbox;
  const repliesDir = config.paths.dirs.replies;

  function spoolOutbound(message) {
    if (!message || typeof message.id !== 'string' || !C.isValidId(message.id)) {
      throw new C.BridgeError('invalid_args', '消息 id 不合法');
    }
    return atomicWriteJson(path.join(outboxDir, `msg_${message.id}.json`), message);
  }

  function recordReply(kind, id, payload) {
    if (!['ack', 'reply'].includes(kind)) {
      throw new C.BridgeError('invalid_args', 'kind 只能是 ack 或 reply');
    }
    if (!C.isValidId(id)) throw new C.BridgeError('invalid_args', '消息 id 不合法');
    return atomicWriteJson(path.join(repliesDir, `${kind}_${id}.json`), payload || {});
  }

  function index(filter = {}) {
    const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? Math.min(filter.limit, 100) : 20;
    let names = [];
    try {
      names = fs.readdirSync(repliesDir).filter((name) => name.endsWith('.json'));
    } catch {
      return { messages: [], total: 0 };
    }
    const messages = [];
    for (const name of names) {
      try {
        const body = JSON.parse(fs.readFileSync(path.join(repliesDir, name), 'utf8'));
        const stat = fs.statSync(path.join(repliesDir, name));
        messages.push({
          id: body.id || name.replace(/\.json$/, ''),
          kind: body.kind || (name.startsWith('ack_') ? 'ack' : 'reply'),
          text: typeof body.text === 'string' ? body.text : null,
          ts: body.ts || new Date(stat.mtimeMs).toISOString(),
          status: body.status || 'received',
          unverified: true,
        });
      } catch {
        logger.warn('skipping unreadable reply file', { name });
      }
    }
    messages.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));
    return { messages: messages.slice(0, limit), total: messages.length };
  }

  function gc(gcOptions = {}) {
    const olderThanMs = Number.isFinite(gcOptions.olderThanMs) ? gcOptions.olderThanMs : 7 * 24 * 3600 * 1000;
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const dir of [outboxDir, repliesDir]) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const full = path.join(dir, name);
        try {
          if (fs.statSync(full).mtimeMs < cutoff) {
            fs.rmSync(full, { force: true });
            removed += 1;
          }
        } catch {
          // best effort
        }
      }
    }
    return { removed };
  }

  return { spoolOutbound, recordReply, index, gc, outboxDir, repliesDir };
}

module.exports = { createMailboxStore };
