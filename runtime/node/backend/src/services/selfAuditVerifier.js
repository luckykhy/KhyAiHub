'use strict';

/**
 * selfAuditVerifier.js — runtime evidence verification for the khyos self-audit report.
 *
 * Division of labor (keeps the leaf contract intact):
 *   - selfAuditRegistry = pure data SSOT (zero IO, deterministic, never throws).
 *     It only DECLARES evidence anchors (evidenceAnchors: module basenames + env gates).
 *   - selfEvidenceVerifier = the ONE shared anchor-checking implementation. The same
 *     "declarative anchors + live verification" pattern is now also used by the
 *     capability registry, so the checking logic lives in a single leaf and both
 *     verifiers delegate to it (two divergent copies of one concept is what
 *     RUNTIME-010 A2-5 forbids). Anchor-name resolution semantics are unchanged.
 *   - selfAuditVerifier (this module) = the self-audit-specific layer: its gate,
 *     its session TTL cache, its public API. It adds no checking logic of its own.
 *
 * Contract: synchronous, read-only, never throws (any per-item failure → that item
 * verified:false + reason; whole call fail-soft). Session-level TTL cache (default
 * 300000ms, tunable via KHY_AUDIT_VERIFY_TTL_MS) so system-prompt rebuilds do not
 * re-stat the disk on every turn. Gate KHY_AUDIT_DYNAMIC_VERIFY (default ON, only
 * explicit 0/false/off/no turns it off — same semantics as KHY_SELF_AUDIT_AWARENESS,
 * flagRegistry-first with local CANON fallback); OFF → verifyAll returns null.
 *
 * @module services/selfAuditVerifier
 */

// The single anchor-checking implementation. `fs`/`path` are no longer needed here:
// this module owns the self-audit gate + TTL cache, not the checking.
const _evidence = require('./selfEvidenceVerifier');

const _FALSY = new Set(['0', 'false', 'off', 'no']);
const _DEFAULT_TTL_MS = 300000;

/**
 * Gate check. flagRegistry-first (central priority + dogfood), local CANON
 * fallback when the registry is unavailable. Default ON, only 0/false/off/no OFF.
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_AUDIT_DYNAMIC_VERIFY', e);
    }
  } catch {
    /* registry unavailable → local fallback */
  }
  const v = e.KHY_AUDIT_DYNAMIC_VERIFY;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * Resolve the cache TTL in ms. flagRegistry numeric resolution first, local
 * parse fallback. Never throws; bad values → default.
 * @param {object} [env]
 * @returns {number}
 */
function _resolveTtlMs(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.resolveNumeric === 'function'
    ) {
      return reg.resolveNumeric('KHY_AUDIT_VERIFY_TTL_MS', e);
    }
  } catch {
    /* registry unavailable → local fallback */
  }
  const n = Number.parseInt(
    String(e.KHY_AUDIT_VERIFY_TTL_MS == null ? '' : e.KHY_AUDIT_VERIFY_TTL_MS).trim(),
    10
  );
  return Number.isFinite(n) && n >= 0 ? n : _DEFAULT_TTL_MS;
}

/**
 * Check whether an env gate flag is effectively ON. Delegates to the shared leaf so
 * the self-audit and capability surfaces can never disagree about gate semantics.
 * @param {string} gate
 * @param {object} e
 * @returns {boolean}
 */
function _gateEnabled(gate, e) {
  return _evidence.gateEnabled(gate, e);
}

/**
 * Verify one audit item's declared evidence anchors. Never throws.
 * Delegates to selfEvidenceVerifier.verifyAnchors — the single checking
 * implementation; anchor-name resolution semantics are unchanged.
 * @param {object} item  frozen item from selfAuditRegistry (may carry evidenceAnchors)
 * @param {object} e     env
 * @returns {{verified:boolean, checks:Array, reason:string}}
 */
function _verifyItem(item, e) {
  return _evidence.verifyAnchors(item && item.evidenceAnchors, { env: e });
}

// Session-level TTL cache: repeated system-prompt rebuilds within the TTL reuse
// the SAME object (including the same checkedAt) instead of re-statting disk.
let _cache = null; // { checkedAt, results }
let _cacheAtMs = 0;

/** Reset the TTL cache (test-only escape hatch). */
function _resetCache() {
  _cache = null;
  _cacheAtMs = 0;
}

/**
 * Verify all self-audit items against their declared evidence anchors.
 * @param {object} [opts]  {env}
 * @returns {{checkedAt:string, results:object}|null}  null when the gate is OFF
 *   or the registry is unresolvable. results: id → {verified, checks, reason}.
 */
function verifyAll(opts = {}) {
  try {
    const o = opts || {};
    const e = o.env || process.env || {};
    if (!isEnabled(e)) {
      return null;
    }

    const ttl = _resolveTtlMs(e);
    const now = Date.now();
    if (_cache && now - _cacheAtMs < ttl) {
      return _cache;
    }

    let items = [];
    try {
      const sar = require('./selfAuditRegistry');
      items = typeof sar.getSelfAuditItems === 'function' ? sar.getSelfAuditItems() : [];
    } catch {
      return null; /* no SSOT → honest null, not fabricated results */
    }
    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }

    const results = {};
    for (const it of items) {
      if (!it || typeof it.id !== 'string') {
        continue;
      }
      results[it.id] = _verifyItem(it, e);
    }

    _cache = { checkedAt: new Date(now).toISOString(), results };
    _cacheAtMs = now;
    return _cache;
  } catch {
    return null; /* fail-soft: verification must never break callers */
  }
}

module.exports = {
  isEnabled,
  verifyAll,
  _resetCache,
};
