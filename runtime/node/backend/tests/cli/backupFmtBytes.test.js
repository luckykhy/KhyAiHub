'use strict';

/**
 * `khy backup` byte formatter — numeric carry regression (#72 family).
 *
 * _fmtBytes branches its carry on the value it will actually DISPLAY. KB/MB/GB
 * render via toFixed(1), so a raw value like 1048574 B (= 1023.998 KB) rounds up
 * to "1024.0" and MUST roll over to "1.0 MB" — the pre-fix `v >= 1024` test let
 * it print the nonsense "1024.0 KB". Conversely 1048000 B (= 1023.4375 KB) shows
 * "1023.4" (< 1024) and must NOT over-carry.
 *
 * Runs under jest or `node --test` via the shim (no jest binary in this checkout).
 */

const backup = require('../../src/cli/handlers/backup');

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

const _fmtBytes = backup._fmtBytes;

_describe('backup._fmtBytes display-rounded carry', () => {
  _test('base bytes unit renders raw integer, no decimals', () => {
    _expect(_fmtBytes(0)).toBe('0 B');
    _expect(_fmtBytes(512)).toBe('512 B');
    _expect(_fmtBytes(1023)).toBe('1023 B');
  });

  _test('exact 1024 boundary carries to KB', () => {
    _expect(_fmtBytes(1024)).toBe('1.0 KB');
  });

  _test('value that ROUNDS to 1024.0 at its unit must carry up (the bug)', () => {
    // 1023.998 KB → displays "1024.0" → pre-fix printed "1024.0 KB".
    _expect(_fmtBytes(1048574)).toBe('1.0 MB');
    // 1023.999 MB → displays "1024.0" → pre-fix printed "1024.0 MB".
    _expect(_fmtBytes(1073741000)).toBe('1.0 GB');
  });

  _test('value that displays < 1024 must NOT over-carry', () => {
    // 1023.4375 KB → "1023.4" stays KB.
    _expect(_fmtBytes(1048000)).toBe('1023.4 KB');
    // 1023.0 KB exact → stays KB.
    _expect(_fmtBytes(1047552)).toBe('1023.0 KB');
  });

  _test('just past the round-up threshold still carries', () => {
    // 1024.000976... KB → "1024.0" → MB.
    _expect(_fmtBytes(1048575)).toBe('1.0 MB');
    // 1024.414 KB → "1024.4" → MB.
    _expect(_fmtBytes(1049000)).toBe('1.0 MB');
  });

  _test('non-numeric / null degrades to 0 B', () => {
    _expect(_fmtBytes(undefined)).toBe('0 B');
    _expect(_fmtBytes(null)).toBe('0 B');
    _expect(_fmtBytes('abc')).toBe('0 B');
  });
});
