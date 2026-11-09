'use strict';

/**
 * ratelimit.js — fixed-window (60s) per-key limiter used by the HTTP server.
 *
 * This is deliberately in-memory: a single daemon owns the loopback port, and
 * a restart resets the window. The mailbox has its own phone_ask quotas.
 */

/**
 * @param {{perMinute?: number, now?: Function}} [options]
 * @returns {{check: Function, snapshot: Function}}
 */
function createRateLimiter(options = {}) {
  const limit = Number.isFinite(options.perMinute) && options.perMinute > 0 ? options.perMinute : 60;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const buckets = new Map();

  function prune(t) {
    if (buckets.size < 1024) return;
    for (const [key, stamps] of buckets) {
      if (stamps.length === 0 || t - stamps[stamps.length - 1] >= 60000) buckets.delete(key);
    }
  }

  function check(key) {
    const t = now();
    prune(t);
    const stamps = (buckets.get(key) || []).filter((stamp) => t - stamp < 60000);
    if (stamps.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((60000 - (t - stamps[0])) / 1000));
      buckets.set(key, stamps);
      return { allowed: false, retryAfter, remaining: 0, limit };
    }
    stamps.push(t);
    buckets.set(key, stamps);
    return { allowed: true, retryAfter: 0, remaining: Math.max(0, limit - stamps.length), limit };
  }

  function snapshot() {
    const t = now();
    let keys = 0;
    let used = 0;
    for (const stamps of buckets.values()) {
      const live = stamps.filter((stamp) => t - stamp < 60000);
      if (live.length) {
        keys += 1;
        used += live.length;
      }
    }
    return { limit, keys, used };
  }

  return { check, snapshot };
}

module.exports = {
  createRateLimiter,
};
