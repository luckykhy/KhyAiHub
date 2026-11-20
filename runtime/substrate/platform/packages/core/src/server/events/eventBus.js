'use strict';

const EventEmitter = require('events');

// eventBus.js — in-process publish/subscribe over Node's EventEmitter.
// Moved verbatim from runtime/node/backend/src/observability/eventBus.js (B4,
// [DESIGN-ARCH-219] §10). Zero external dependencies (leaf module — safe to
// require from anywhere); the bus is the real-time companion to eventLog.js:
// eventLog.append() emits every event here synchronously so coordinator /
// daemon / dashboard can react live without polling the JSONL files on disk.
//
// Design constraints (see task #2):
//   - Zero external dependencies (leaf module — safe to require from anywhere).
//   - Fail-soft: publishing never throws, a throwing subscriber never breaks
//     the producer nor sibling subscribers.
//   - High listener cap: many independent consumers may subscribe.

// Channel names. Subscribers may listen on ALL (every event) or on a specific
// event `type` string (e.g. 'usage.record', 'task.created', 'snapshot').
const CHANNEL = Object.freeze({
  ALL: 'event', // fires for every published event
});

class EventBus extends EventEmitter {}

function createEventBus() {
  const bus = new EventBus();
  // Coordinator + daemon + dashboard + cost meter may each attach several
  // listeners; keep well clear of the default 10-listener warning threshold.
  bus.setMaxListeners(500);
  return bus;
}

const bus = createEventBus();

/**
 * Publish an event to the in-process bus. Fail-soft: never throws.
 *
 * Emits twice: once on the generic ALL channel (fan-out to catch-all
 * subscribers) and once on a channel named after the event's `type` (so a
 * subscriber can listen to just 'usage.record' or 'snapshot', etc.).
 *
 * @param {object} event - Normalized event entry (see eventLog.append()).
 * @returns {object} the same event (for chaining).
 */
function publish(event) {
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

/**
 * Subscribe to a channel.
 *
 * @param {string} channel - CHANNEL.ALL or an event `type` string.
 * @param {(event: object) => void} handler
 * @returns {() => void} unsubscribe function.
 */
function subscribe(channel, handler) {
  if (typeof handler !== 'function') {
    return () => {};
  }
  const ch = String(channel || CHANNEL.ALL);
  // Wrap so a throwing handler can never bubble into the emitter internals.
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

/**
 * Convenience: subscribe to every event (CHANNEL.ALL).
 * @param {(event: object) => void} handler
 * @returns {() => void} unsubscribe function.
 */
function subscribeAll(handler) {
  return subscribe(CHANNEL.ALL, handler);
}

module.exports = {
  bus,
  CHANNEL,
  createEventBus,
  publish,
  subscribe,
  subscribeAll,
};
