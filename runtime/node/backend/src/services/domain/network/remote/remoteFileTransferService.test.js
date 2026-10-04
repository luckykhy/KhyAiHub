'use strict';

// Co-located unit test for remoteFileTransferService.js (scp upload).
//
// HARD ISOLATION CONTRACT: upload() reaches spawn('scp', ...) at
// remoteFileTransferService.js:236 with no injection seam, and the module binds
// `spawn` once at require time (:20), so the stub below is installed BEFORE the
// module is loaded. KHY_REMOTE_SSH_ENABLE_EXEC stays 'false' for this whole file and
// cp.spawn throws, so no process and no socket can be created by any case below.

const test = require('node:test').test;
const after = require('node:test').after;
const assert = require('node:assert');
const cp = require('node:child_process');
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
  delete process.env.KHY_REMOTE_SSH_IDLE_TIMEOUT_MS;
  delete process.env.KHY_REMOTE_SSH_CONNECT_TIMEOUT_SEC;
  return root;
}

pinSandbox();

const REAL_SPAWN = cp.spawn;
let spawnAttempts = 0;
cp.spawn = function guardedSpawn(...args) {
  spawnAttempts += 1;
  throw new Error(`test isolation: spawn(${String(args[0])}) is not allowed here`);
};
after(() => { cp.spawn = REAL_SPAWN; });

const mod = require('./remoteFileTransferService');
const { RemoteFileTransferService, createRemoteFileTransferService } = mod;

const SESSION = {
  connectionId: 'c-1',
  hostAlias: 'prod.example.invalid',
  remoteUser: 'deploy',
  remoteWorkspace: '/srv/app',
  traceId: 'tr-1',
};

function harness() {
  const touches = [];
  const connectionManager = {
    getSession: (id) => (id === SESSION.connectionId ? { ...SESSION } : null),
    touch: (id) => { touches.push(id); return true; },
  };
  return { svc: createRemoteFileTransferService({ connectionManager }), touches };
}

test('export surface', () => {
  assert.deepStrictEqual(Object.keys(mod), ['RemoteFileTransferService', 'createRemoteFileTransferService']);
  assert.ok(createRemoteFileTransferService({ connectionManager: {} }) instanceof RemoteFileTransferService);
});

test('the factory cannot be called without its dependency object', () => {
  assert.throws(() => createRemoteFileTransferService(), TypeError);
  assert.throws(() => new RemoteFileTransferService(), TypeError);
});

test('an unknown connection id throws instead of returning a result', async () => {
  const { svc } = harness();
  let seen = null;
  try {
    await svc.upload({ connectionId: 'ghost', localPath: 'a', remotePath: 'b', idempotencyKey: 'k' });
  } catch (error) {
    seen = error;
  }
  assert.ok(seen instanceof Error);
  assert.strictEqual(seen.code, 'session_not_found');
  assert.match(seen.message, /connection_id=ghost/);
});

test('a missing path argument is a structured rejection, not a throw', async () => {
  const { svc } = harness();
  for (const args of [
    { localPath: '', remotePath: 'b.tgz' },
    { localPath: 'a.tgz', remotePath: '' },
    { localPath: '   ', remotePath: 'b.tgz' },
    { localPath: undefined, remotePath: undefined },
  ]) {
    const res = await svc.upload({ connectionId: 'c-1', idempotencyKey: 'k-1', ...args });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'invalid_transfer_request');
    assert.match(res.message, /localPath and remotePath are required/);
  }
});

test('an upload without an idempotency key is refused', async () => {
  const { svc } = harness();
  const res = await svc.upload({ connectionId: 'c-1', localPath: 'a.tgz', remotePath: 'b.tgz' });
  assert.strictEqual(res.status, 'idempotency_key_required');
  assert.strictEqual(res.ok, false);
});

test('with the exec gate off nothing is transferred and nothing is spawned', async () => {
  const { svc, touches } = harness();
  const events = [];
  const res = await svc.upload({
    connectionId: 'c-1', localPath: 'a.tgz', remotePath: 'b.tgz', idempotencyKey: 'k-gate', onEvent: (e) => events.push(e),
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, 'execution_disabled');
  assert.match(res.message, /KHY_REMOTE_SSH_ENABLE_EXEC/);
  assert.strictEqual(res.connection_id, 'c-1');
  assert.strictEqual(res.redaction_applied, true);
  assert.deepStrictEqual(events.map((e) => [e.kind, e.severity]), [['remote_transfer_summary', 'wait']]);
  assert.strictEqual(events[0].trace_id, 'tr-1', 'the trace id falls back to the session trace');
  assert.strictEqual(touches.length, 0);
  assert.strictEqual(spawnAttempts, 0);
});

test('a failed upload is not cached, so a retry really retries', async () => {
  const { svc } = harness();
  svc._idempotentResults.set('c-1::k-fail', {
    createdAtMs: Date.now(),
    result: { ok: false, status: 'upload_failed', exit_code: 1 },
  });
  const again = await svc.upload({ connectionId: 'c-1', localPath: 'a.tgz', remotePath: 'b.tgz', idempotencyKey: 'other' });
  assert.strictEqual(again.status, 'execution_disabled', 'a different key is a fresh request');
});

// B31-R11 (registered, NOT fixed): the replay branch (remoteFileTransferService.js
// :164-177) looks the cache up by `connectionId::idempotencyKey` only. The exec
// service, which this file's own header (:17) claims to "match", additionally
// stores a requestHash and answers `idempotency_conflict` when the same key
// carries a different payload (remoteExecService.js:467-496). Here the payload is
// never compared: an upload of a DIFFERENT bundle under a reused key comes back
// `status:'idempotent_replay'` with `ok:true` and the ORIGINAL paths in it. The
// one real consumer, deployOrchestrator.js:325, tests only `upload.ok` and then
// proceeds to run `tar -xzf <new name>` on a host that never received that file.
test('B31-R11 the replay cache ignores which file was asked for', async () => {
  const { svc } = harness();
  svc._idempotentResults.set('c-1::deploy-bundle', {
    createdAtMs: Date.now(),
    result: { ok: true, status: 'uploaded', local_path: 'first.tgz', remote_path: 'first.tar.gz', exit_code: 0 },
  });
  const res = await svc.upload({
    connectionId: 'c-1',
    localPath: 'SECOND-bundle.tgz',
    remotePath: 'second/second.tar.gz',
    idempotencyKey: 'deploy-bundle',
  });
  assert.strictEqual(res.status, 'idempotent_replay');
  assert.strictEqual(res.ok, true, 'the caller sees "the upload succeeded"');
  assert.strictEqual(res.local_path, 'first.tgz', 'while the payload is the previous file');
  assert.strictEqual(res.remote_path, 'first.tar.gz');
  assert.notStrictEqual(res.remote_path, 'second/second.tar.gz');
  assert.strictEqual(spawnAttempts, 0);
});

test('the replay key is namespaced per connection', async () => {
  const { svc } = harness();
  svc._idempotentResults.set('c-other::shared-key', {
    createdAtMs: Date.now(),
    result: { ok: true, status: 'uploaded' },
  });
  const res = await svc.upload({ connectionId: 'c-1', localPath: 'a.tgz', remotePath: 'b.tgz', idempotencyKey: 'shared-key' });
  assert.notStrictEqual(res.status, 'idempotent_replay');
});

test('an expired replay row is dropped on read', async () => {
  const { svc } = harness();
  svc._idempotentResults.set('c-1::stale', {
    createdAtMs: Date.now() - 7 * 60 * 60 * 1000,
    result: { ok: true, status: 'uploaded' },
  });
  const res = await svc.upload({ connectionId: 'c-1', localPath: 'a.tgz', remotePath: 'b.tgz', idempotencyKey: 'stale' });
  assert.strictEqual(svc._idempotentResults.has('c-1::stale'), false);
  assert.notStrictEqual(res.status, 'idempotent_replay');
});

test('a throwing onEvent subscriber cannot break the upload path', async () => {
  const { svc } = harness();
  const res = await svc.upload({
    connectionId: 'c-1',
    localPath: 'a.tgz',
    remotePath: 'b.tgz',
    idempotencyKey: 'k-throw',
    onEvent: () => { throw new Error('subscriber exploded'); },
  });
  assert.strictEqual(res.status, 'execution_disabled');
});

test('there is no download/list/delete side of this service', () => {
  const proto = Object.getOwnPropertyNames(RemoteFileTransferService.prototype);
  for (const missing of ['download', 'get', 'list', 'remove', 'deleteRemote']) {
    assert.ok(!proto.includes(missing), `${missing} must stay absent until it is implemented`);
  }
  assert.ok(proto.includes('_runScp'), 'upload is the only transport operation');
});

// B31-R17 evidence, and the proof that the isolation above is real rather than
// decorative: the moment KHY_REMOTE_SSH_ENABLE_EXEC is flipped, the next statement in
// upload() is a hard-coded spawn('scp', ...) (remoteFileTransferService.js:236) with no
// injectable transport. The only thing between that call and a live scp is the flag
// plus the stub installed at the top of this file.
test('flipping the gate reaches spawn, which the pre-load stub stops', async () => {
  const { svc } = harness();
  const previous = process.env.KHY_REMOTE_SSH_ENABLE_EXEC;
  process.env.KHY_REMOTE_SSH_ENABLE_EXEC = 'true';
  try {
    await assert.rejects(
      () => svc.upload({ connectionId: 'c-1', localPath: 'a.tgz', remotePath: 'b.tgz', idempotencyKey: 'k-spawn' }),
      /test isolation: spawn\(scp\)/
    );
  } finally {
    process.env.KHY_REMOTE_SSH_ENABLE_EXEC = previous;
  }
  assert.strictEqual(spawnAttempts, 1, 'one attempt, intercepted before a process existed');
  assert.strictEqual(process.env.KHY_REMOTE_SSH_ENABLE_EXEC, 'false', 'the gate is restored');
  spawnAttempts = 0;
});

test('no case above reached the transport', () => {
  assert.strictEqual(spawnAttempts, 0);
});
