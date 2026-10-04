'use strict';

// Co-located unit test for remoteExecStreamStore.js (in-memory SSE replay buffer;
// no IO, no timers, no sockets).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function pinSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-remote-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.KHY_DATA_HOME = path.join(root, 'data');
  process.env.KHY_PROJECT_DATA_HOME = path.join(root, 'project-data');
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  process.env.KHY_REMOTE_SSH_ENABLE_EXEC = 'false';
  for (const k of [
    'KHY_REMOTE_SSH_STREAM_TTL_MS',
    'KHY_REMOTE_SSH_RUNNING_STREAM_TTL_MS',
    'KHY_REMOTE_SSH_MAX_STREAMS',
    'KHY_REMOTE_SSH_MAX_STREAM_EVENTS',
  ]) delete process.env[k];
  return root;
}

pinSandbox();

const mod = require('./remoteExecStreamStore');
const { createRemoteExecStreamStore, buildRemoteExecStreamRequestFingerprint, RemoteExecStreamStore } = mod;

function fresh(options) {
  return createRemoteExecStreamStore(options);
}

test('export surface', () => {
  assert.deepStrictEqual(Object.keys(mod), ['RemoteExecStreamStore', 'createRemoteExecStreamStore', 'buildRemoteExecStreamRequestFingerprint']);
  assert.ok(fresh() instanceof RemoteExecStreamStore);
});

test('fingerprint is stable for identical requests and differs across payloads', () => {
  const base = {
    connectionId: 'c-1',
    commands: ['ls'],
    dryRun: false,
    idempotencyKey: 'k',
    approvalTicketId: null,
    riskContext: { kind: 'deploy' },
  };
  const a = buildRemoteExecStreamRequestFingerprint(base);
  const b = buildRemoteExecStreamRequestFingerprint({ ...base });
  assert.strictEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(a, buildRemoteExecStreamRequestFingerprint({ ...base, commands: ['pwd'] }));
  assert.notStrictEqual(a, buildRemoteExecStreamRequestFingerprint({ ...base, dryRun: true }));
  assert.notStrictEqual(a, buildRemoteExecStreamRequestFingerprint({ ...base, connectionId: 'c-2' }));
});

test('fingerprint tolerates missing and unserialisable fields', () => {
  assert.doesNotThrow(() => buildRemoteExecStreamRequestFingerprint({}));
  const circular = { kind: 'x' };
  circular.self = circular;
  const withCycle = buildRemoteExecStreamRequestFingerprint({
    connectionId: 'c', commands: ['ls'], dryRun: false, idempotencyKey: 'k', approvalTicketId: null, riskContext: circular,
  });
  assert.match(withCycle, /^[0-9a-f]{64}$/, 'the catch branch keeps hashing instead of throwing');
  assert.notStrictEqual(withCycle, buildRemoteExecStreamRequestFingerprint({
    connectionId: 'c', commands: ['ls'], dryRun: false, idempotencyKey: 'k', approvalTicketId: null, riskContext: null,
  }));
});

// B31-R12 (registered, NOT fixed): the fingerprint hashes
// `JSON.stringify(riskContext)`, i.e. it is key-order sensitive, while every
// producer of riskContext is a JSON body parsed from the wire (routes/remoteSsh.js
// :448). Two retries of the *same* logical request whose client serialised
// `{kind,host_alias}` and `{host_alias,kind}` yield different hashes, and
// ensureSession then answers `stream_payload_conflict` (:221) for a request that
// is byte-identical in meaning — the stream refuses to resume.
test('B31-R12 key order alone changes the fingerprint and blocks a resume', () => {
  const one = buildRemoteExecStreamRequestFingerprint({
    connectionId: 'c-1', commands: ['ls'], dryRun: false, idempotencyKey: 'k',
    approvalTicketId: null, riskContext: { kind: 'deploy', host_alias: 'prod' },
  });
  const two = buildRemoteExecStreamRequestFingerprint({
    connectionId: 'c-1', commands: ['ls'], dryRun: false, idempotencyKey: 'k',
    approvalTicketId: null, riskContext: { host_alias: 'prod', kind: 'deploy' },
  });
  assert.notStrictEqual(one, two, 'current behaviour: not canonical');
  const store = fresh();
  assert.strictEqual(store.ensureSession({ streamId: 's-1', requestFingerprint: one }).ok, true);
  const again = store.ensureSession({ streamId: 's-1', requestFingerprint: two });
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.code, 'stream_payload_conflict');
});

test('ensureSession creates, adopts a late fingerprint and merges context', () => {
  const store = fresh();
  const created = store.ensureSession({ streamId: ' s-2 ', metadata: { a: 1 } });
  assert.strictEqual(created.ok, true);
  assert.strictEqual(created.created, true);
  assert.strictEqual(created.session.stream_id, 's-2', 'the id is trimmed before it becomes the key');
  const merged = store.ensureSession({ streamId: 's-2', requestContext: { commands: ['ls'] }, metadata: { b: 2 } });
  assert.strictEqual(merged.created, false);
  assert.deepStrictEqual(merged.session.request_context, { commands: ['ls'] });
  assert.deepStrictEqual(merged.session.metadata, { a: 1, b: 2 });
  assert.strictEqual(merged.session.request_fingerprint, null);
  const withFp = store.ensureSession({ streamId: 's-2', requestFingerprint: 'ff' });
  assert.strictEqual(withFp.session.request_fingerprint, 'ff', 'a stored stream adopts its fingerprint on first sight');
  assert.strictEqual(store.ensureSession({ streamId: '' }).code, 'stream_id_required');
  assert.strictEqual(store.ensureSession({ streamId: '   ' }).code, 'stream_id_required');
});

test('a stream object is a copy: mutating what you got cannot change the store', () => {
  const store = fresh();
  const res = store.ensureSession({ streamId: 's-3', metadata: { a: 1 }, requestContext: { x: 1 } });
  res.session.done = true;
  res.session.metadata.a = 99;
  res.session.request_context.x = 99;
  const back = store.getSession('s-3');
  assert.strictEqual(back.done, false);
  assert.strictEqual(back.metadata.a, 1);
  assert.strictEqual(back.request_context.x, 1);
});

// B31-R13 (registered, NOT fixed): claimStart (:269) flips `started` to true and
// returns shouldStart — but there is no release/unclaim/rollback method anywhere
// in the class, and routes/remoteSsh.js:562 claims the start *before* it builds
// the execution promise (:582). If that call throws, or the SSE socket dies
// first, the stream is left started-but-never-run: every later subscriber gets
// shouldStart:false (:286) and waits for events that will never arrive, until the
// 12-hour running TTL (DEFAULT_RUNNING_TTL_MS) collects the stream.
test('B31-R13 the start claim is irreversible', () => {
  const store = fresh();
  store.ensureSession({ streamId: 's-4' });
  assert.deepStrictEqual(store.claimStart('s-4'), { ok: true, shouldStart: true });
  assert.deepStrictEqual(store.claimStart('s-4'), { ok: true, shouldStart: false });
  assert.deepStrictEqual(store.claimStart('  '), { ok: false, code: 'stream_id_required' });
  assert.deepStrictEqual(store.claimStart('missing'), { ok: false, code: 'stream_not_found' });
  assert.deepStrictEqual(
    ['releaseStart', 'unclaim', 'resetStart', 'release'].filter((n) => typeof store[n] === 'function'),
    [],
    'no API can undo a claim'
  );
  assert.strictEqual(store.getSession('s-4').started, true);
  assert.strictEqual(store.getSession('s-4').done, false, 'started but not done: the stuck state');
});

test('appendEvent sequences, notifies and reports unknown streams as null', () => {
  const store = fresh();
  store.ensureSession({ streamId: 's-5' });
  const seen = [];
  const off = store.subscribe('s-5', (rec, session) => seen.push([rec.seq, session.last_seq]));
  store.subscribe('s-5', () => { throw new Error('bad subscriber'); });
  const r1 = store.appendEvent('s-5', { event: 'log', data: { msg: 'hi' } });
  assert.strictEqual(r1.seq, 1);
  assert.strictEqual(r1.event, 'log');
  const r2 = store.appendEvent('s-5', { event: 'log' });
  assert.strictEqual(r2.data, null);
  assert.strictEqual(r2.event, 'log');
  assert.strictEqual(store.appendEvent('nobody', { event: 'log' }), null);
  assert.strictEqual(store.appendEvent('  ', { event: 'log' }), null);
  // appendEvent notifies every subscriber per event; two appends happened above,
  // so the good subscriber saw both pairs despite the throwing sibling
  // (remoteExecStreamStore.js:355-362 swallows subscriber errors per listener).
  // The earlier expectation of only [[1, 1]] was a test-side miscount.
  assert.deepStrictEqual(seen, [[1, 1], [2, 2]], 'a throwing subscriber cannot stop the next one');
  off();
  store.appendEvent('s-5', { event: 'log', data: {} });
  assert.strictEqual(seen.length, 2, 'unsubscribe works');
  assert.strictEqual(store.subscribe('nobody', () => {})() , undefined);
  assert.strictEqual(typeof store.subscribe('s-5', 'not-a-function'), 'function');
});

// B31-R14 (registered, NOT fixed): `done` is not terminal. appendEvent (:317) has
// no `if (session.done) return` guard, so events keep being appended after the
// stream announced completion, last_seq keeps advancing, and a second `done`
// rewrites terminal_status (routes/remoteSsh.js:127 pushes events into the store
// from the exec callback, and a retried callback therefore re-opens the verdict).
test('B31-R14 events are accepted after the stream is done', () => {
  const store = fresh();
  store.ensureSession({ streamId: 's-6' });
  store.appendEvent('s-6', { event: 'done', data: { status: 'completed' } });
  assert.strictEqual(store.getSession('s-6').terminal_status, 'completed');
  assert.strictEqual(store.isDone('s-6'), true);
  const extra = store.appendEvent('s-6', { event: 'log', data: { late: true } });
  assert.strictEqual(extra.seq, 2);
  const flipped = store.appendEvent('s-6', { event: 'done', data: { status: 'failed' } });
  assert.ok(flipped);
  const s = store.getSession('s-6');
  assert.strictEqual(s.terminal_status, 'failed', 'current behaviour: the verdict changed after completion');
  assert.strictEqual(s.last_seq, 3);
});

test('a done event without a status payload defaults to completed', () => {
  const store = fresh();
  store.ensureSession({ streamId: 's-7' });
  store.appendEvent('s-7', { event: 'done' });
  assert.strictEqual(store.getSession('s-7').terminal_status, 'completed');
  store.appendEvent('s-7', { event: 'done', data: 'not-an-object' });
  assert.strictEqual(store.getSession('s-7').terminal_status, 'completed');
});

test('getEventsSince replays, reports truncation and returns null for unknown ids', () => {
  const store = fresh();
  store.ensureSession({ streamId: 's-8' });
  for (let i = 1; i <= 3; i++) store.appendEvent('s-8', { event: 'log', data: { i } });
  const all = store.getEventsSince('s-8', 0);
  assert.deepStrictEqual(all.events.map((e) => e.seq), [1, 2, 3]);
  assert.strictEqual(all.truncated, false);
  assert.strictEqual(all.first_available_seq, 1);
  assert.strictEqual(all.last_seq, 3);
  assert.deepStrictEqual(store.getEventsSince('s-8', 2).events.map((e) => e.seq), [3]);
  assert.deepStrictEqual(store.getEventsSince('s-8', 99).events, []);
  assert.strictEqual(store.getEventsSince('nope', 0), null);
  assert.strictEqual(store.getEventsSince('s-8', 'abc').after_seq, 0, 'a garbage cursor falls back to 0');
  assert.strictEqual(store.getEventsSince('s-8', -5).after_seq, 0);
  const empty = fresh();
  empty.ensureSession({ streamId: 's-9' });
  assert.strictEqual(empty.getEventsSince('s-9', 0).first_available_seq, 1);
});

test('the per-stream event window is bounded and reports the gap', () => {
  process.env.KHY_REMOTE_SSH_MAX_STREAM_EVENTS = '2';
  const store = fresh();
  store.ensureSession({ streamId: 'cap' });
  for (let i = 1; i <= 4; i++) store.appendEvent('cap', { event: 'log', data: { i } });
  const replay = store.getEventsSince('cap', 0);
  assert.deepStrictEqual(replay.events.map((e) => e.seq), [3, 4]);
  assert.strictEqual(replay.first_available_seq, 3);
  assert.strictEqual(replay.truncated, true);
  assert.strictEqual(replay.last_seq, 4);
  delete process.env.KHY_REMOTE_SSH_MAX_STREAM_EVENTS;
});

test('ttl and cap knobs are read from env, non-positive values fall back', () => {
  process.env.KHY_REMOTE_SSH_MAX_STREAMS = '2';
  const store = fresh();
  store.ensureSession({ streamId: 'a' });
  store.ensureSession({ streamId: 'b' });
  store.ensureSession({ streamId: 'c' });
  assert.strictEqual(store.exportState().length, 2, 'the oldest streams are evicted');
  assert.strictEqual(store.hasSession('a'), false);
  assert.strictEqual(store.hasSession('c'), true);
  delete process.env.KHY_REMOTE_SSH_MAX_STREAMS;
  const dflt = fresh();
  assert.strictEqual(dflt._maxStreams, 240);
  assert.strictEqual(dflt._completedTtlMs, 30 * 60 * 1000);
  assert.strictEqual(dflt._runningTtlMs, 12 * 60 * 60 * 1000);
  process.env.KHY_REMOTE_SSH_STREAM_TTL_MS = '0';
  assert.strictEqual(fresh()._completedTtlMs, 30 * 60 * 1000, '0 is not "no ttl", it is ignored');
  process.env.KHY_REMOTE_SSH_STREAM_TTL_MS = 'not-a-number';
  assert.strictEqual(fresh()._completedTtlMs, 30 * 60 * 1000);
  delete process.env.KHY_REMOTE_SSH_STREAM_TTL_MS;
});

test('exportState / importState round-trips a live stream', () => {
  const store = fresh();
  store.ensureSession({ streamId: 'r-1', requestFingerprint: 'fp', requestContext: { commands: ['ls'] }, metadata: { k: 'v' } });
  store.appendEvent('r-1', { event: 'log', data: { n: 1 } });
  store.appendEvent('r-1', { event: 'done', data: { status: 'completed' } });
  const dump = store.exportState();
  assert.strictEqual(dump.length, 1);
  assert.strictEqual(dump[0].events.length, 2);
  const back = fresh();
  assert.strictEqual(back.importState(dump), 1);
  const s = back.getSession('r-1');
  assert.strictEqual(s.done, true);
  assert.strictEqual(s.terminal_status, 'completed');
  assert.strictEqual(s.request_fingerprint, 'fp');
  assert.deepStrictEqual(back.getEventsSince('r-1', 0).events.map((e) => e.seq), [1, 2]);
  // a stored stream keeps its own promise slot empty after import
  assert.strictEqual(back.getExecutionPromise('r-1'), null);
  assert.strictEqual(back.setExecutionPromise('r-1', Promise.resolve()), true);
  assert.strictEqual(back.setExecutionPromise('nope', Promise.resolve()), false);
  assert.ok(back.getExecutionPromise('r-1') instanceof Promise);
});

test('importState drops junk, re-sorts events and replaces the table', () => {
  const store = fresh();
  store.ensureSession({ streamId: 'will-be-gone' });
  const n = store.importState([
    { stream_id: 'ok', last_seq: 7, events: [{ seq: 2, event: 'b' }, { seq: 1, event: 'a' }, { event: 'no-seq' }, { seq: -3 }, null] },
    { stream_id: '   ' },
    null,
    'nope',
    { stream_id: 'no-events' },
    { stream_id: 'bad-ts', created_at_ms: 'x', last_activity_ms: 'y', created_at: 'not-a-date', updated_at: 'also-bad' },
  ]);
  assert.strictEqual(n, 3);
  assert.strictEqual(store.getSession('will-be-gone'), null);
  const ok = store.getSession('ok');
  assert.strictEqual(ok.last_seq, 7, 'a stored last_seq larger than the window wins');
  assert.deepStrictEqual(store.getEventsSince('ok', 0).events.map((e) => e.seq), [1, 2], 'events are re-sorted by seq');
  assert.strictEqual(store.getSession('no-events').last_seq, 0);
  assert.doesNotThrow(() => store.getSession('bad-ts'));
  assert.deepStrictEqual(store.importState(undefined), 0);
});

test('an imported stream that is already past its ttl is dropped on arrival', () => {
  const store = fresh();
  const ancient = Date.now() - 60 * 60 * 1000;
  const n = store.importState([
    { stream_id: 'stale-done', done: true, started: true, last_activity_ms: ancient, events: [] },
    { stream_id: 'fresh-done', done: true, started: true, last_activity_ms: Date.now(), events: [] },
  ]);
  assert.strictEqual(n, 1);
  assert.strictEqual(store.hasSession('stale-done'), false);
  assert.strictEqual(store.hasSession('fresh-done'), true);
});

test('clearAll empties and notifies; a non-function onMutate is ignored', () => {
  const seen = [];
  const store = createRemoteExecStreamStore({ onMutate: (m) => seen.push(m.reason) });
  store.ensureSession({ streamId: 'x' });
  store.claimStart('x');
  store.appendEvent('x', { event: 'done', data: { status: 'completed' } });
  const before = store.exportState().length;
  store.clearAll();
  assert.strictEqual(before, 1);
  assert.deepStrictEqual(store.exportState(), []);
  assert.deepStrictEqual(seen, ['create_session', 'start_session', 'append_event', 'clear_all']);
  assert.doesNotThrow(() => createRemoteExecStreamStore({ onMutate: 42 }).ensureSession({ streamId: 'y' }));
});

test('append_event carries the done flag so index.js can force a flush', () => {
  const seen = [];
  // ensureSession also fires onMutate (create_session, payload without `done`,
  // remoteExecStreamStore.js:261), so filter to the append_event mutations this
  // contract is actually about (index.js _isForcePersistMutation reads payload.done).
  const store = createRemoteExecStreamStore({
    onMutate: (m) => {
      if (m.reason === 'append_event') seen.push(m.payload);
    },
  });
  store.ensureSession({ streamId: 'z' });
  store.appendEvent('z', { event: 'log', data: {} });
  store.appendEvent('z', { event: 'done', data: { status: 'completed' } });
  assert.strictEqual(seen.length, 2, 'both appends notified on append_event');
  assert.strictEqual(seen[0].done, false);
  assert.strictEqual(seen[1].done, true);
});
