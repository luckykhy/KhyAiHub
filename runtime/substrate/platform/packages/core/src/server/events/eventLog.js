'use strict';

const fs = require('fs');
const path = require('path');

const { bus: defaultBus, CHANNEL } = require('./eventBus');

// eventLog.js — append-only event log (JSONL) with in-process fan-out.
// Moved from runtime/node/backend/src/observability/eventLog.js (B4,
// [DESIGN-ARCH-219] §10)。与 backend 版的唯一差异：落盘目录不再 require 后端的
// dataHome.js（core 不得回引 backend，判据 #1），改由宿主经 options.getEventsDir
// 下发——「路径解析由 core 统筹、宿主下发」正是 CorePaths 契约的同一条原则。
//
// The observable/recoverable foundation for /dream daemon checkpoints,
// coordinator observability, and the cost meter. Every event is:
//   1. normalized to a stable shape,
//   2. published to the in-process eventBus synchronously (real-time), and
//   3. appended to a JSONL shard (durable/replayable).
//
// Reuses the JSONL + fail-soft style of telemetryService.recordAuditEvent() and
// sessionPersistence: writes are best-effort — a write failure only warns, it
// never throws and never blocks the caller's main flow.
//
// Configuration is intentionally minimal (a few env vars + sane defaults):
//   - KHY_EVENTLOG_ENABLED  (default on)  — {0,false,off,no} disables disk writes
//                                           (bus fan-out still happens).
//   - KHY_EVENTLOG_SHARD    (default date) — 'date' → events-YYYY-MM-DD.jsonl,
//                                           'trace' → trace-<traceId>.jsonl.
//   - KHY_EVENTLOG_DIR      (optional)    — override the events directory.
//
// Event shape (as persisted and published):
//   { ts, seq, type, source, traceId, payload }
// `type` is contract-checked against TYPE_PREFIXES + EXACT_TYPES (see
// _acceptedType): out-of-contract types normalize to 'unknown' rather than
// being rejected, keeping append() fail-soft.

let _warned = false;

function _flag(raw, defaultOn = true) {
  if (raw == null) {
    return defaultOn;
  }
  const v = String(raw).trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') {
    return false;
  }
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') {
    return true;
  }
  return defaultOn;
}

function _enabled() {
  return _flag(process.env.KHY_EVENTLOG_ENABLED, true);
}

function _shardMode() {
  const v = String(process.env.KHY_EVENTLOG_SHARD || 'date')
    .trim()
    .toLowerCase();
  return v === 'trace' ? 'trace' : 'date';
}

function _sanitize(s) {
  return (
    String(s == null ? '' : s)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 120) || 'unknown'
  );
}

/** Pick the shard file for an entry (date-based by default, trace-based opt-in). */
function _shardFile(dir, entry) {
  if (_shardMode() === 'trace' && entry.traceId) {
    return path.join(dir, `trace-${_sanitize(entry.traceId)}.jsonl`);
  }
  const day = (typeof entry.ts === 'string' ? entry.ts : new Date().toISOString()).slice(0, 10);
  return path.join(dir, `events-${day}.jsonl`);
}

function _toMs(ts) {
  if (ts == null) {
    return NaN;
  }
  if (typeof ts === 'number') {
    return ts;
  }
  const t = Date.parse(ts);
  return Number.isNaN(t) ? NaN : t;
}

function _warnOnce(err) {
  if (_warned) {
    return;
  }
  _warned = true;
  try {
    console.warn(
      '[eventLog] append failed (fail-soft; further warnings suppressed):',
      err && err.message ? err.message : err
    );
  } catch {
    /* ignore */
  }
}

// 事件类型契约:族前缀 + 精确表。append() 的调用方历史上只有 8 个内部模块,
// 类型散在 agent.* / perf.* / usage.record / snapshot / task.*;A5 前端埋点
// (user.behavior.*)进来后不收敛就会长出无限长尾——拼错一个字母就是一个新
// type,read({type}) 与 eventBus 的按类型订阅全部静默失配。表外类型归一为
// 'unknown' 而不是拒绝:本模块的契约是 fail-soft,生产者不该因类型拼写被抛。
// 新族登记在这里,不要在各调用点各自放宽。
const TYPE_PREFIXES = ['agent.', 'perf.', 'task.', 'user.behavior.'];
const EXACT_TYPES = new Set(['usage.record', 'snapshot', 'unknown']);

function _acceptedType(raw) {
  const type = String(raw == null ? '' : raw).trim();
  if (!type) {
    return 'unknown';
  }
  if (EXACT_TYPES.has(type)) {
    return type;
  }
  // 前缀至少要跟一个字符:'user.behavior.' 本身不是类型。
  return TYPE_PREFIXES.some((p) => type.length > p.length && type.startsWith(p))
    ? type
    : 'unknown';
}

/**
 * Create an event log bound to one bus + one events directory resolver.
 *
 * @param {object} [options]
 * @param {object} [options.bus]      - bus to fan out on (defaults to the module bus).
 * @param {() => string} [options.getEventsDir] - host-provided events dir (CorePaths 下发);
 *        without it the log degrades to bus-only + a single warning (no silent disk write).
 */
function createEventLog(options = {}) {
  const bus = options.bus || defaultBus;
  const resolveDir = typeof options.getEventsDir === 'function' ? options.getEventsDir : null;
  // Monotonic per-process sequence — stable ordering when timestamps collide.
  // NOTE: seq 核心级持久化（跨重启单调）是 B4 的后续项，当前保持迁入前的
  // 进程内语义——先把本体搬进 core，再谈持久化，避免一步跨两个语义。
  let _seq = 0;

  function _eventsDir() {
    // 优先级与迁入前的 backend 版一致：env 显式覆盖 > 宿主下发 > 无（退化）。
    // 曾把宿主下发放到 env 之前，结果 KHY_EVENTLOG_DIR 被静默绕过（测试临时目录失效）。
    if (process.env.KHY_EVENTLOG_DIR) {
      const dir = path.resolve(process.env.KHY_EVENTLOG_DIR);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        /* ignore */
      }
      return dir;
    }
    if (resolveDir) {
      return resolveDir();
    }
    // 无宿主注入也无 env：不猜路径、不静默落盘，总线照常 fan-out。
    _warnOnce(new Error('events 目录未下发（宿主应经 getEventsDir 注入，或设 KHY_EVENTLOG_DIR）；本次仅总线 fan-out，不落盘'));
    return null;
  }

  function _normalize(event) {
    const ev = event || {};
    let ts;
    if (typeof ev.ts === 'string') {
      ts = ev.ts;
    } else if (Number.isFinite(ev.ts)) {
      ts = new Date(ev.ts).toISOString();
    } else {
      ts = new Date().toISOString();
    }

    return {
      ts,
      seq: ++_seq,
      type: _acceptedType(ev.type),
      source: ev.source != null ? String(ev.source) : 'unknown',
      traceId: ev.traceId != null ? String(ev.traceId) : null,
      payload: ev.payload !== undefined ? ev.payload : {},
    };
  }

  /**
   * Append an event. ALWAYS fail-soft — never throws, never blocks the caller.
   *
   * The bus fan-out happens first (and unconditionally, even if disk writes are
   * disabled) so real-time subscribers never depend on disk state.
   */
  function append(event = {}) {
    const entry = _normalize(event);

    // 1. Real-time fan-out (synchronous, fail-soft inside publish()).
    publishTo(bus, entry);

    // 2. Durable append-only persistence (best-effort).
    if (_enabled()) {
      try {
        const dir = _eventsDir();
        if (dir) {
          const file = _shardFile(dir, entry);
          fs.appendFileSync(file, JSON.stringify(entry) + '\n');
        }
      } catch (err) {
        _warnOnce(err);
      }
    }

    return entry;
  }

  function _sorted(list) {
    return list.sort((a, b) => {
      const ta = _toMs(a.ts);
      const tb = _toMs(b.ts);
      if (ta !== tb) {
        return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
      }
      return (a.seq || 0) - (b.seq || 0);
    });
  }

  /**
   * Read events from disk with optional filtering. Fail-soft: returns [] on any error.
   */
  function read(filter = {}) {
    const results = [];
    let dir;
    let files;
    try {
      dir = _eventsDir();
      if (!dir) return results;
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return results;
    }

    // Fast path: trace-sharded file exists for the requested traceId.
    if (filter.traceId) {
      const tf = `trace-${_sanitize(filter.traceId)}.jsonl`;
      if (files.includes(tf)) {
        files = [tf];
      }
    }
    files.sort();

    const sinceMs = filter.since != null ? _toMs(filter.since) : null;
    const untilMs = filter.until != null ? _toMs(filter.until) : null;
    const limit = Number.isFinite(filter.limit) ? filter.limit : Infinity;

    for (const f of files) {
      let content;
      try {
        content = fs.readFileSync(path.join(dir, f), 'utf-8');
      } catch {
        continue;
      }
      for (const line of content.split(/\r?\n/)) {
        if (!line) {
          continue;
        }
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (filter.traceId != null && entry.traceId !== String(filter.traceId)) {
          continue;
        }
        if (filter.type != null && entry.type !== String(filter.type)) {
          continue;
        }
        if (filter.source != null && entry.source !== String(filter.source)) {
          continue;
        }
        if (sinceMs != null || untilMs != null) {
          const t = _toMs(entry.ts);
          if (sinceMs != null && !(t >= sinceMs)) continue;
          if (untilMs != null && !(t <= untilMs)) continue;
        }
        results.push(entry);
      }
    }

    const sorted = _sorted(results);
    return Number.isFinite(limit) && sorted.length > limit ? sorted.slice(0, limit) : sorted;
  }

  /**
   * Replay events (by traceId and/or time range), optionally invoking a callback
   * per event in chronological order. Returns the ordered event array either way.
   * Fail-soft: a throwing callback never aborts the replay.
   */
  function replay(filter = {}, onEvent) {
    const events = read(filter);
    if (typeof onEvent === 'function') {
      for (const e of events) {
        try {
          onEvent(e);
        } catch {
          /* fail-soft */
        }
      }
    }
    return events;
  }

  /**
   * Append a snapshot event capturing full task/runtime state for later
   * replay/recovery. Fail-soft.
   */
  function snapshot(taskId, fullState, opts = {}) {
    return append({
      type: 'snapshot',
      source: opts.source || 'snapshot',
      traceId: opts.traceId != null ? opts.traceId : taskId != null ? String(taskId) : null,
      payload: { taskId: taskId != null ? String(taskId) : null, state: fullState },
    });
  }

  /** Resolve the current events directory (created). Exposed for tooling/tests. */
  function getEventsDir() {
    return _eventsDir();
  }

  return {
    append,
    read,
    replay,
    snapshot,
    getEventsDir,
    bus,
    CHANNEL,
    subscribe: (channel, handler) => subscribeOn(bus, channel, handler),
    subscribeAll: (handler) => subscribeOn(bus, CHANNEL.ALL, handler),
    publish: (event) => publishTo(bus, event),
  };
}

// bus 的 publish/subscribe 原样透出（迁入前 eventLog 直接 re-export bus 的同名函数）。
function publishTo(bus, event) {
  try {
    bus.emit(CHANNEL.ALL, event);
    if (event && event.type) {
      bus.emit(String(event.type), event);
    }
  } catch {
    /* fail-soft: a bad subscriber must never break the producer */
  }
  return event;
}

function subscribeOn(bus, channel, handler) {
  if (typeof handler !== 'function') {
    return () => {};
  }
  const ch = String(channel || CHANNEL.ALL);
  const safe = (event) => {
    try {
      handler(event);
    } catch {
      /* fail-soft */
    }
  };
  bus.on(ch, safe);
  return () => {
    try {
      bus.off(ch, safe);
    } catch {
      /* ignore */
    }
  };
}

// 默认实例：无宿主注入时退化为「仅总线 + 单次告警」，落盘目录由宿主下发。
const eventLog = createEventLog();

module.exports = {
  createEventLog,
  eventLog,
  bus: defaultBus,
  CHANNEL,
  publish: (event) => publishTo(defaultBus, event),
  subscribe: (channel, handler) => subscribeOn(defaultBus, channel, handler),
  subscribeAll: (handler) => subscribeOn(defaultBus, CHANNEL.ALL, handler),
};
