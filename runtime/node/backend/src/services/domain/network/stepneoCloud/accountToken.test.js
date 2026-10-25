'use strict';

/**
 * stepneoCloud/accountToken.test.js — co-located suite for the logcat parser.
 *
 * IO: none. The parser is pure and the device read takes an injected `exec`, so
 * the whole credential path is assertable with no phone and no real token.
 *
 * The fixtures below are shaped like real logcat output, including the parts
 * that make naive matching wrong: a token issued for a package we do not care
 * about, and a full-account credential in the same log.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAccountToken, decodeToken, readAccountTokenFromDevice, TOKEN_PACKAGES,
} = require('./accountToken');

const AIENGINE_THREAD = '10626:23823';
const OTHER_THREAD = '10626:99999';

/**
 * A real threadtime line: `date time PID TID LEVEL TAG: rest`.
 *
 * The PID and TID are SEPARATE whitespace-delimited fields — writing them as
 * `10626:23823` in one field (the first draft of this fixture) makes the prefix
 * regex fail and every test below silently assert on `null`.
 */
function logLine(pid, tid, level, rest) {
  return `10-25 16:16:04.087  ${pid}  ${tid} ${level} [Cloud]Account: ${rest}`;
}

function getAuthTokenLine(pid, tid, pkg, { basic = true } = {}) {
  const kind = basic ? 'basic' : 'fullAuth';
  return logLine(pid, tid, 'I',
    `[binder:10626_5-861][Authenticator] [getAuthToken] Account {name=10003151, `
    + `type=com.stepos.account}, ${kind}, uid = 1000, package = ${pkg}`);
}

function tokenLine(pid, tid, value) {
  return `10-25 16:16:04.088  ${pid}  ${tid} I [Cloud]Account: `
    + `[binder:10626_5-861][Authenticator] local db token: ${value}`;
}

// ── the two-step correlation ─────────────────────────────────────────────────

test('a basic token for aiengine in the same thread is picked up', () => {
  const stdout = [
    getAuthTokenLine(10626, 23823, 'com.stepos.aiengine'),
    tokenLine(10626, 23823, 'TOKENVALUE'),
  ].join('\n');
  const found = parseAccountToken(stdout);
  assert.equal(found.sourcePackage, 'com.stepos.aiengine');
  assert.equal(found.token, 'TOKENVALUE');
  assert.equal(found.observedAt, '10-25 16:16:04.088');
});

test('aiengine wins over ability when both are present', () => {
  // Preference order is TOKEN_PACKAGES, not log order. Reversing the log must
  // not change the answer, or the winner depends on timing.
  const stdout = [
    getAuthTokenLine(10626, 99999, 'com.stepos.ability'),
    tokenLine(10626, 99999, 'ABILITY_TOKEN'),
    getAuthTokenLine(10626, 23823, 'com.stepos.aiengine'),
    tokenLine(10626, 23823, 'AIENGINE_TOKEN'),
  ].join('\n');
  assert.equal(parseAccountToken(stdout).token, 'AIENGINE_TOKEN');
});

test('ability alone is still accepted', () => {
  const stdout = [
    getAuthTokenLine(10626, 99999, 'com.stepos.ability'),
    tokenLine(10626, 99999, 'ABILITY_TOKEN'),
  ].join('\n');
  assert.equal(parseAccountToken(stdout).token, 'ABILITY_TOKEN');
});

test('a token for a package outside the allowlist is ignored', () => {
  // The value alone is not authority. Without the package check, any app that
  // triggered getAuthToken would hand us its token.
  const stdout = [
    getAuthTokenLine(10626, 99999, 'com.example.rogue'),
    tokenLine(10626, 99999, 'ROGUE_TOKEN'),
  ].join('\n');
  assert.equal(parseAccountToken(stdout), null);
});

test('a full-account credential is ignored even for an allowed package', () => {
  // This is the line that must not be crossed: the service has no business
  // holding the full account credential, only the basic one its own apps use.
  const stdout = [
    getAuthTokenLine(10626, 23823, 'com.stepos.aiengine', { basic: false }),
    tokenLine(10626, 23823, 'FULL_AUTH_TOKEN'),
  ].join('\n');
  assert.equal(parseAccountToken(stdout), null);
});

test('the token must come from the SAME thread as the getAuthToken marker', () => {
  // Thread correlation is what ties the value to the entitlement. Dropping it
  // would accept a basic marker in one thread and a value from another.
  const stdout = [
    getAuthTokenLine(10626, 23823, 'com.stepos.aiengine'),
    tokenLine(10626, 99999, 'CROSS_THREAD_TOKEN'),
  ].join('\n');
  assert.equal(parseAccountToken(stdout), null);
});

test('a literal null token is not treated as a token', () => {
  const stdout = [
    getAuthTokenLine(10626, 23823, 'com.stepos.aiengine'),
    tokenLine(10626, 23823, 'null'),
  ].join('\n');
  assert.equal(parseAccountToken(stdout), null);
});

test('empty or missing input yields null rather than throwing', () => {
  assert.equal(parseAccountToken(''), null);
  assert.equal(parseAccountToken(undefined), null);
  assert.equal(parseAccountToken('unrelated log noise\nmore noise'), null);
});

test('a malformed threadtime prefix is skipped, not crashed on', () => {
  const stdout = 'garbage line with no prefix local db token: X\n';
  assert.equal(parseAccountToken(stdout), null);
});

// ── token decoding ───────────────────────────────────────────────────────────

test('decodeToken reads the device id and the issue time, and reports no expiry', () => {
  const payload = {
    a: 'DFDD362A2774801D87EF9BDF5E06D667', r: 'x', s: 'wg', c: '331',
    t: Date.now() - 3600000, u: '10006878', v: 3, g: false, l: 'abc',
  };
  const token = Buffer.from(JSON.stringify(payload)).toString('base64');
  const decoded = decodeToken(token);
  assert.equal(decoded.deviceId, payload.a);
  assert.equal(decoded.fields.length, 9);
  assert.equal(decoded.hasExpiryField, false);
  assert.ok(decoded.ageHours > 0.99 && decoded.ageHours < 1.01);
});

test('decodeToken refuses anything that is not decodable JSON', () => {
  assert.equal(decodeToken('not-base64-json'), null);
  assert.equal(decodeToken(''), null);
  assert.equal(decodeToken(Buffer.from('[1,2,3]').toString('base64')), null);
});

// ── the device read, with an injected exec ───────────────────────────────────

test('readAccountTokenFromDevice returns the decoded token on success', async () => {
  const payload = { a: 'DEVICEID', t: Date.now(), u: '10006878' };
  const token = Buffer.from(JSON.stringify(payload)).toString('base64');
  const stdout = [
    getAuthTokenLine(10626, 23823, 'com.stepos.aiengine'),
    tokenLine(10626, 23823, token),
  ].join('\n');

  const result = await readAccountTokenFromDevice({
    serial: 'SERIAL1',
    exec: async () => ({ stdout }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.deviceId, 'DEVICEID');
  assert.equal(result.token, token);
  assert.equal(result.sourcePackage, 'com.stepos.aiengine');
});

test('a missing adb is reported as its own code, not as a missing token', () => {
  // Conflating these sends people to re-login on the phone when the real problem
  // is that adb is not on PATH.
  return readAccountTokenFromDevice({
    serial: 'S',
    exec: async () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; },
  }).then((r) => {
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ADB_MISSING');
  });
});

test('a failed adb invocation is reported separately from a missing token', async () => {
  const result = await readAccountTokenFromDevice({
    serial: 'S',
    exec: async () => { throw new Error('device unauthorized'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ADB_FAILED');
});

test('a log with no token reports TOKEN_NOT_FOUND with an actionable message', async () => {
  const result = await readAccountTokenFromDevice({
    serial: 'S', exec: async () => ({ stdout: 'nothing useful here\n' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOKEN_NOT_FOUND');
  assert.match(result.error, /原生助手/);
});

test('the logcat command is built with the serial and the account tag', async () => {
  // The tag is what scopes the dump; a wrong tag means a 64MB buffer of noise
  // and a parse that finds nothing.
  let seen = null;
  await readAccountTokenFromDevice({
    serial: 'SERIAL9',
    exec: async (bin, args) => { seen = { bin, args }; return { stdout: '' }; },
  });
  assert.deepEqual(seen.args.slice(0, 4), ['-s', 'SERIAL9', 'logcat', '-d']);
  assert.equal(seen.args[seen.args.length - 1], '[Cloud]Account:V');
});

test('every allowlisted package is a stepos package', () => {
  // A guard on the allowlist itself: if someone adds a third-party package here,
  // the "not a credential theft path" claim in the header stops being true.
  for (const pkg of TOKEN_PACKAGES) {
    assert.match(pkg, /^com\.stepos\./);
  }
});
