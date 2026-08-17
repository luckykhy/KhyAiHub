'use strict';

/**
 * selfCapabilityVerifier.js — runtime evidence verification for the khyos capability domains.
 *
 * Same three-layer split as the self-audit surface, and deliberately so:
 *   - selfCapabilityRegistry = pure data SSOT (zero IO, deterministic, never throws).
 *     It only DECLARES the domains, their live-derivation markers and their evidence anchors.
 *   - selfEvidenceVerifier = the ONE shared anchor-checking implementation (module
 *     existence + gate state). Both this module and selfAuditVerifier delegate to it, so the
 *     two surfaces can never disagree about what "verified" means.
 *   - selfCapabilityVerifier (this module) = the capability-specific layer: its gate, its
 *     session TTL cache, its public API. It adds no checking logic of its own.
 *
 * Why this exists: a capability claim with no checkable source is exactly the defect that let
 * `Alpine ISO build` sit in the profile — nothing could be red when it stopped being true.
 * Anchors turn an unverifiable assertion into a falsifiable one: delete the module and the
 * badge flips to 核验失败 on the next turn.
 *
 * Contract: synchronous, read-only, never throws (any per-domain failure → that domain
 * verified:false + reason; whole call fail-soft). Session-level TTL cache (default 300000ms,
 * tunable via KHY_CAPABILITY_VERIFY_TTL_MS) so system-prompt rebuilds do not re-stat the disk
 * on every turn. Gate KHY_SELF_CAPABILITY_EVIDENCE (default ON, only explicit 0/false/off/no
 * turns it off; flagRegistry-first with local CANON fallback); OFF → verifyAll returns null and
 * no badge is rendered anywhere (absence of a badge means "not verified", never "passed").
 *
 * @module services/selfCapabilityVerifier
 */

// The single anchor-checking implementation. This module owns the capability gate + TTL
// cache, not the checking.
const _evidence = require('./selfEvidenceVerifier');

const _FALSY = new Set(['0', 'false', 'off', 'no']);
const _DEFAULT_TTL_MS = 300000;

/**
 * Gate check. flagRegistry-first (central priority + dogfood), local CANON fallback when the
 * registry is unavailable. Default ON, only 0/false/off/no OFF. Reads the SAME flag as
 * selfCapabilityRegistry.isEnabled (test-locked, so the two cannot diverge).
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
      return reg.isFlagEnabled('KHY_SELF_CAPABILITY_EVIDENCE', e);
    }
  } catch {
    /* registry unavailable → local fallback */
  }
  const v = e.KHY_SELF_CAPABILITY_EVIDENCE;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * Resolve the cache TTL in ms. flagRegistry numeric resolution first, local parse fallback.
 * Never throws; bad values → default.
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
      return reg.resolveNumeric('KHY_CAPABILITY_VERIFY_TTL_MS', e);
    }
  } catch {
    /* registry unavailable → local fallback */
  }
  const n = Number.parseInt(
    String(e.KHY_CAPABILITY_VERIFY_TTL_MS == null ? '' : e.KHY_CAPABILITY_VERIFY_TTL_MS).trim(),
    10
  );
  return Number.isFinite(n) && n >= 0 ? n : _DEFAULT_TTL_MS;
}

// Session-level TTL cache: repeated system-prompt rebuilds within the TTL reuse the SAME
// object (including the same checkedAt) instead of re-statting disk.
let _cache = null; // { checkedAt, results }
let _cacheAtMs = 0;

/** Reset the TTL cache (test-only escape hatch). */
function _resetCache() {
  _cache = null;
  _cacheAtMs = 0;
}

/**
 * Verify all declared capability domains against their evidence anchors.
 * @param {object} [opts]  {env}
 * @returns {{checkedAt:string, results:object}|null}  null when the gate is OFF or the
 *   registry is unresolvable. results: domainKey → {verified, checks, reason}.
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

    let domains = [];
    try {
      const scr = require('./selfCapabilityRegistry');
      domains = typeof scr.getCapabilityDomains === 'function' ? scr.getCapabilityDomains() : [];
    } catch {
      return null; /* no SSOT → honest null, not fabricated results */
    }
    if (!Array.isArray(domains) || domains.length === 0) {
      return null;
    }

    const results = {};
    for (const d of domains) {
      if (!d || typeof d.key !== 'string') {
        continue;
      }
      results[d.key] = _evidence.verifyAnchors(d.evidenceAnchors, { env: e });
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