'use strict';

/**
 * `khy traffic` duration/token formatters — display-rounded carry (#72/#76 family,
 * base-1000 variant). Pure-local, default-visible (no CC gate).
 *
 * Both branch on the RAW value while rendering with toFixed(1)/Math.round, so a
 * value one hair under a rollover used to print an impossible string:
 *   formatDuration(59960)  → "60.0s"   (should be "1m0s")
 *   formatDuration(119900) → "1m60s"   (should be "2m0s")
 *   formatTokens(999950)   → "1000.0k" (should be "1.0M")
 *
 * Runs under jest or `node --test` via the shim (no jest binary in this checkout).
 */

const traffic = require('../../src/cli/handlers/traffic');

/* ── jest-or-node:test shim ─────────────────────────────────────────────── */
let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = nt.describe;
  _test = nt.test;
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
  });
}

const { formatDuration, formatTokens } = traffic;

_describe('traffic.formatDuration display-rounded carry (base-60)', () => {
  _test('sub-second and mid-range unchanged', () => {
    _expect(formatDuration(999)).toBe('999ms');
    _expect(formatDuration(1000)).toBe('1.0s');
    _expect(formatDuration(1500)).toBe('1.5s');
    _expect(formatDuration(59949)).toBe('59.9s');
  });

  _test('seconds that ROLL UP to 60 carry to the minute (the bug)', () => {
    _expect(formatDuration(59960)).toBe('1m0s'); // old: "60.0s"
    _expect(formatDuration(59999)).toBe('1m0s'); // old: "60.0s"
  });

  _test('minute-branch seconds that round to 60 carry the minute (the bug)', () => {
    _expect(formatDuration(119900)).toBe('2m0s'); // old: "1m60s"
    _expect(formatDuration(60000)).toBe('1m0s');
    _expect(formatDuration(90000)).toBe('1m30s');
    _expect(formatDuration(125000)).toBe('2m5s');
  });
});

_describe('traffic.formatTokens display-rounded carry (base-1000)', () => {
  _test('empty / sub-thousand / mid-range', () => {
    _expect(formatTokens(0)).toBe('—');
    _expect(formatTokens(999)).toBe('999');
    _expect(formatTokens(1000)).toBe('1.0k');
    _expect(formatTokens(1500)).toBe('1.5k');
    _expect(formatTokens(999949)).toBe('999.9k'); // rounds to 999.9, must NOT carry
  });

  _test('k that ROLLS UP to 1000.0 carries to M (the bug)', () => {
    _expect(formatTokens(999950)).toBe('1.0M'); // old: "1000.0k"
    _expect(formatTokens(999999)).toBe('1.0M'); // old: "1000.0k"
  });

  _test('genuine M values unchanged', () => {
    _expect(formatTokens(1000000)).toBe('1.0M');
    _expect(formatTokens(1500000)).toBe('1.5M');
  });
});
