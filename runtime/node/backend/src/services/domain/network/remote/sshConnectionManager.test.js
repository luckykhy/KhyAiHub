'use strict';

// Co-located unit test for sshConnectionManager.js (stateful in-memory registry;
// it performs no IO at all — connect() never opens a socket, which is itself the
// subject of B31-R6 below).

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
  return root;
}

pinSandbox();

const mgr = require('./sshConnectionManager');
const { createSshConnectionManager, SshConnectionManager } = mgr;

const HOST = {
  alias: 'prod',
  host: 'prod.example.invalid',
  port: 2222,
  user: 'deploy',
  identityFile: null,
  remoteWorkspace: '/srv/app',
};

test('export surface and constructor identity', () => {
  assert.deepStrictEqual(Object.keys(mgr), ['SshConnectionManager', 'createSshConnectionManager']);
  assert.strictEqual(typeof SshConnectionManager, 'function');
  assert.ok(createSshConnectionManager() instanceof SshConnectionManager);
});

test('connect records a session and hands back a copy', () => {
  const m = createSshConnectionManager();
  const rec = m.connect({ hostEntry: HOST, purpose: 'deploy', traceId: 'tr-9' });
  assert.ok(rec.connectionId, 'a connection id is issued');
  assert.strictEqual(rec.hostAlias, 'prod');
  assert.strictEqual(rec.host, 'prod.example.invalid');
  assert.strictEqual(rec.port, 2222);
  assert.strictEqual(rec.remoteUser, 'deploy');
  assert.strictEqual(rec.purpose, 'deploy');
  assert.strictEqual(rec.traceId, 'tr-9');
  assert.strictEqual(typeof rec.connectedAt, 'string');
  assert.strictEqual(rec.lastActivityAt, rec.connectedAt);
  rec.hostAlias = 'tampered';
  assert.strictEqual(m.getSession(rec.connectionId).hostAlias, 'prod', 'the stored record is not the returned object');
});

test('purpose defaults to development and workspace falls back to the host entry', () => {
  const m = createSshConnectionManager();
  const a = m.connect({ hostEntry: HOST });
  assert.strictEqual(a.purpose, 'development');
  assert.strictEqual(a.remoteWorkspace, '/srv/app');
  const b = m.connect({ hostEntry: { alias: 'bare' }, workspace: '~' });
  assert.strictEqual(b.remoteWorkspace, '~');
  assert.strictEqual(b.remoteUser, null);
  const c = m.connect({ hostEntry: { alias: 'none' } });
  assert.strictEqual(c.remoteWorkspace, null);
});

test('an entry without an alias is rejected with a machine code', () => {
  const m = createSshConnectionManager();
  try {
    m.connect({ hostEntry: {} });
    assert.fail('expected a throw');
  } catch (error) {
    assert.strictEqual(error.code, 'invalid_host_entry');
  }
});

// B31-R6 (registered, NOT fixed): the guard above is unreachable for the two most
// likely wrong calls. connect({ hostEntry }) destructures its parameter without a
// default (sshConnectionManager.js:10), so connect() / connect(null) die on a raw
// TypeError with no `.code` — callers that branch on error.code (remoteExecService
// .js:104 relies on `session_not_found`, routes rely on coded errors) get an
// unclassified crash instead of `invalid_host_entry`.
test('B31-R6 connect() with no argument bypasses the coded guard', () => {
  const m = createSshConnectionManager();
  for (const call of [() => m.connect(), () => m.connect(null)]) {
    let seen = 'no throw';
    try {
      call();
    } catch (error) {
      seen = `${error.constructor.name}:${error.code || '<no code>'}`;
    }
    assert.strictEqual(seen, 'TypeError:<no code>', 'current behaviour: bare TypeError, not invalid_host_entry');
  }
});

// B31-R6b (registered, NOT fixed): connect() writes `status: 'connected'`
// (sshConnectionManager.js:22) after generating a UUID — nothing in this file
// imports net/ssh/child_process, so the state is asserted, never probed. The
// deploy pipeline then hands that id to scp/ssh as if a session existed
// (deployOrchestrator.js:177 feeds session.connectionId into the ticket).
test('B31-R6b "connected" is a bookkeeping label, not a probe', () => {
  const m = createSshConnectionManager();
  const rec = m.connect({ hostEntry: { alias: 'definitely-unreachable.invalid' } });
  assert.strictEqual(rec.status, 'connected');
  assert.strictEqual(m.getSession(rec.connectionId).status, 'connected');
  assert.ok(!fs.readFileSync(path.join(__dirname, 'sshConnectionManager.js'), 'utf-8').includes('net'));
});

// B31-R6c (registered, NOT fixed): the registry has no cap, no TTL and no
// per-session reaper — only clearAll(). Every deploy dry-run opens one session
// (deployOrchestrator.js:177) and the orchestrator never disconnects it, so a
// long-lived API process accumulates a session per click; getSnapshot()
// (remoteStateSyncService.js:12) then reports them all as active_remote_sessions.
test('B31-R6c the session map only grows', () => {
  const m = createSshConnectionManager();
  for (let i = 0; i < 6; i++) m.connect({ hostEntry: { alias: `h${i}` } });
  assert.strictEqual(m.listSessions().length, 6);
  assert.deepStrictEqual(
    ['close', 'disconnectAll', 'reap', 'prune', 'expire'].filter((n) => typeof m[n] === 'function'),
    [],
    'no per-session release other than disconnect(id)/clearAll()'
  );
  m.disconnect(m.listSessions()[0].connectionId);
  assert.strictEqual(m.listSessions().length, 5);
});

test('disconnect is idempotent and echoes the trace id', () => {
  const m = createSshConnectionManager();
  const rec = m.connect({ hostEntry: HOST, traceId: 'tr-1' });
  const off = m.disconnect(rec.connectionId);
  assert.strictEqual(off.disconnected, true);
  assert.strictEqual(off.status, 'disconnected');
  assert.strictEqual(off.hostAlias, 'prod');
  assert.strictEqual(off.traceId, 'tr-1');
  assert.strictEqual(m.disconnect(rec.connectionId).status, 'not_found');
  assert.strictEqual(m.disconnect('   ').status, 'invalid_connection_id');
  assert.strictEqual(m.disconnect(null).status, 'invalid_connection_id');
  assert.strictEqual(m.disconnect(undefined).status, 'invalid_connection_id');
});

test('getSession / touch normalise the id the same way', () => {
  const m = createSshConnectionManager();
  const rec = m.connect({ hostEntry: HOST });
  assert.strictEqual(m.getSession(`  ${rec.connectionId}  `).connectionId, rec.connectionId);
  assert.strictEqual(m.getSession(''), null);
  assert.strictEqual(m.getSession('missing'), null);
  assert.strictEqual(m.touch(rec.connectionId), true);
  assert.strictEqual(m.touch('missing'), false);
  assert.strictEqual(m.touch('  '), false);
  assert.ok(Date.parse(m.getSession(rec.connectionId).lastActivityAt) >= Date.parse(rec.connectedAt));
});

test('listSessions sorts by connectedAt and clearAll empties the map', () => {
  const m = createSshConnectionManager();
  m.connect({ hostEntry: { alias: 'first' } });
  m.connect({ hostEntry: { alias: 'second' } });
  const listed = m.listSessions();
  assert.strictEqual(listed.length, 2);
  assert.ok(listed[0].connectedAt <= listed[listed.length - 1].connectedAt);
  assert.notStrictEqual(listed[0], m.getSession(listed[0].connectionId));
  m.clearAll();
  assert.deepStrictEqual(m.listSessions(), []);
});
