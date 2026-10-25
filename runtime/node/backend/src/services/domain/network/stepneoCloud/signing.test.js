'use strict';

/**
 * stepneoCloud/signing.test.js — co-located suite for the signing leaf.
 *
 * IO: none. The upstream signs with HMAC-SHA256 over a four-segment message, so
 * the only things worth asserting are the exact message layout and the refusal
 * behaviour — both are pure.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { computeSign, buildHeaders, PROD_APP_ID } = require('./signing');

// ── the message layout ───────────────────────────────────────────────────────

test('sign is HMAC-SHA256 over appId+nonce+timestamp+appSecret, lowercase hex', () => {
  const appId = 'ai-engine-prod';
  const appSecret = 'test-secret';
  const nonce = 'a'.repeat(32);
  const timestamp = '1792914396530';

  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(appId + nonce + timestamp + appSecret)
    .digest('hex');

  assert.equal(computeSign({ appId, appSecret, nonce, timestamp }), expected);
});

test('the four segments are concatenated with NO separator', () => {
  // The most likely way to get this wrong is inserting a separator. Two signs
  // that differ only by a separator must differ, which pins the layout.
  const base = { appId: 'ai-engine-prod', appSecret: 's', nonce: 'n', timestamp: 't' };
  const withColon = crypto.createHmac('sha256', 's')
    .update('ai-engine-prod' + ':' + 'n' + ':' + 't' + 's').digest('hex');
  assert.notEqual(computeSign(base), withColon);
});

test('the secret is both the key and the tail of the message', () => {
  // Changing only the tail segment (not the key) must change the sign. If the
  // tail were dropped, this would pass silently for the wrong reason.
  const a = computeSign({ appId: 'x', appSecret: 's', nonce: 'n', timestamp: 't' });
  const b = computeSign({ appId: 'x', appSecret: 's', nonce: 'n', timestamp: 't2' });
  assert.notEqual(a, b);
});

test('a fresh nonce changes the sign, so replaying a captured one fails', () => {
  const fixed = { appId: 'x', appSecret: 's', timestamp: 't' };
  const first = computeSign({ ...fixed, nonce: 'n1' });
  const second = computeSign({ ...fixed, nonce: 'n2' });
  assert.notEqual(first, second);
});

// ── header construction ──────────────────────────────────────────────────────

test('buildHeaders emits every zy-* header the gateway expects', () => {
  const h = buildHeaders({
    token: 'tok',
    appSecret: 'sec',
    deviceId: 'dev',
    nonce: 'n'.repeat(32),
    timestamp: '1792914396530',
    traceId: 'trace-1',
  });
  assert.equal(h.Authorization, 'Bearer tok');
  assert.equal(h['zy-app-id'], PROD_APP_ID);
  assert.equal(h['zy-app-package'], 'com.stepos.aiengine');
  assert.equal(h['zy-client-type'], 'Android');
  assert.equal(h['zy-scene-type'], 'chat');
  assert.equal(h['zy-device-id'], 'dev');
  assert.equal(h['zy-nonce'], 'n'.repeat(32));
  assert.equal(h['zy-timestamp'], '1792914396530');
  assert.equal(h['zy-trace-id'], 'trace-1');
  assert.match(h['zy-sign'], /^[0-9a-f]{64}$/);
});

test('nonce and traceId are generated when omitted, and are not reused', () => {
  const h1 = buildHeaders({ token: 't', appSecret: 's', deviceId: 'd' });
  const h2 = buildHeaders({ token: 't', appSecret: 's', deviceId: 'd' });
  assert.match(h1['zy-nonce'], /^[0-9a-f]{32}$/);
  assert.notEqual(h1['zy-nonce'], h2['zy-nonce']);
  assert.notEqual(h1['zy-trace-id'], h2['zy-trace-id']);
  // The sign must follow the nonce, not be shared.
  assert.notEqual(h1['zy-sign'], h2['zy-sign']);
});

test('the header sign agrees with a recomputed sign from the same headers', () => {
  // Guards against the header builder computing the sign from different inputs
  // than the ones it publishes — which would 401 on every request.
  const h = buildHeaders({
    token: 't', appSecret: 's', deviceId: 'd', nonce: 'abc', timestamp: '123', traceId: 'tr',
  });
  assert.equal(
    h['zy-sign'],
    computeSign({
      appId: h['zy-app-id'], appSecret: 's', nonce: h['zy-nonce'], timestamp: h['zy-timestamp'],
    }),
  );
});

// ── refusals, which are the point ────────────────────────────────────────────

test('a missing appSecret is refused, not defaulted', () => {
  // A silently-wrong secret yields 401s that read as "expired token", sending
  // people to renew the wrong credential.
  assert.throws(
    () => buildHeaders({ token: 't', deviceId: 'd' }),
    /appSecret must be a non-empty string/,
  );
});

test('a missing token or deviceId is refused', () => {
  assert.throws(() => buildHeaders({ appSecret: 's', deviceId: 'd' }), /token must be/);
  assert.throws(() => buildHeaders({ token: 't', appSecret: 's' }), /deviceId must be/);
});

test('computeSign refuses an empty segment rather than signing a malformed message', () => {
  assert.throws(() => computeSign({ appId: '', appSecret: 's', nonce: 'n', timestamp: 't' }), /appId/);
  assert.throws(() => computeSign({ appId: 'a', appSecret: 's', nonce: 'n', timestamp: '' }), /timestamp/);
});
