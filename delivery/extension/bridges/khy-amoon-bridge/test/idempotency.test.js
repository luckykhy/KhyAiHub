'use strict';

/**
 * idempotency.test.js — in-memory + persisted id replay, conflict, in-flight
 * and TTL behavior. No HTTP, no device.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createIdempotency, digestOf } = require('../lib/idempotency');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoon-idem-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('same key + same digest replays; a different digest conflicts', (t) => {
  const dir = tempDir(t);
  let now = 1000;
  const store = createIdempotency({ stateDir: dir, ttlMs: 5000, clock: () => now });
  const digest = digestOf('ping', { a: 1 });

  assert.equal(store.begin('k1', digest).state, 'new');
  assert.equal(store.begin('k1', digest).state, 'in_flight');
  store.commit('k1', digest, { status: 200, payload: { ok: true, data: { pong: true } } });

  const replay = store.begin('k1', digest);
  assert.equal(replay.state, 'replay');
  assert.equal(replay.entry.response.status, 200);
  assert.equal(replay.entry.response.payload.data.pong, true);

  assert.equal(store.begin('k1', digestOf('ping', { a: 2 })).state, 'conflict');

  now += 6000;
  assert.equal(store.begin('k1', digest).state, 'new', 'expired entry must not replay');
});

test('key order does not change the digest', () => {
  assert.equal(digestOf('ping', { a: 1, b: 2 }), digestOf('ping', { b: 2, a: 1 }));
  assert.notEqual(digestOf('ping', { a: 1 }), digestOf('ping', { a: 2 }));
});

test('entries survive a restart and an abort clears only the in-flight marker', (t) => {
  const dir = tempDir(t);
  let now = 1000;
  const first = createIdempotency({ stateDir: dir, ttlMs: 5000, clock: () => now });
  const digest = digestOf('bridge_status', {});
  assert.equal(first.begin('restart', digest).state, 'new');
  first.commit('restart', digest, { status: 200, payload: { ok: true, data: {} } });

  const second = createIdempotency({ stateDir: dir, ttlMs: 5000, clock: () => now });
  assert.equal(second.begin('restart', digest).state, 'replay');

  assert.equal(second.begin('abortme', digest).state, 'new');
  second.abort('abortme');
  assert.equal(second.begin('abortme', digest).state, 'new', 'abort must allow a retry');
});
