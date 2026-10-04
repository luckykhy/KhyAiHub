'use strict';

// Co-located unit test for remoteStateSyncService.js (read-only aggregator over
// the connection manager, the approval bridge and index.js's persistence status).

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

const mod = require('./remoteStateSyncService');
const { RemoteStateSyncService } = mod;
const { createSshConnectionManager } = require('./sshConnectionManager');
const { createRemoteApprovalBridge } = require('./remoteApprovalBridge');

function harness(opts = {}) {
  const cm = createSshConnectionManager();
  const ab = createRemoteApprovalBridge();
  for (const alias of opts.aliases || []) cm.connect({ hostEntry: { alias } });
  for (const cmds of opts.tickets || []) ab.createTicket({ commands: cmds, connectionId: 'c-1' });
  return new RemoteStateSyncService({
    connectionManager: cm,
    approvalBridge: ab,
    getPersistenceStatus: opts.persistence === undefined ? null : opts.persistence,
  });
}

test('export surface', () => {
  assert.deepStrictEqual(Object.keys(mod), ['RemoteStateSyncService']);
});

test('the constructor needs its dependency object', () => {
  // Bare call destructures undefined -> TypeError (remoteStateSyncService.js:4).
  assert.throws(() => new RemoteStateSyncService(), TypeError);
  // Current behaviour: an empty object constructs fine ({} destructures to
  // undefined fields); the missing approvalBridge surfaces on USE, not on
  // construction — which is what the source's own shape promises. The previous
  // assert.throws here contradicted its own message (test-side bug).
  assert.doesNotThrow(() => new RemoteStateSyncService({}));
  assert.throws(() => new RemoteStateSyncService({}).getSnapshot(), TypeError,
    'the missing dependency only detonates when the snapshot is taken');
});

test('an empty unit still produces a complete snapshot', () => {
  const snap = harness().getSnapshot();
  assert.deepStrictEqual(Object.keys(snap), [
    'generated_at', 'active_remote_sessions', 'pending_remote_approvals',
    'persistence', 'last_hydration', 'summary',
  ]);
  assert.ok(!Number.isNaN(Date.parse(snap.generated_at)));
  assert.deepStrictEqual(snap.active_remote_sessions, []);
  assert.deepStrictEqual(snap.pending_remote_approvals, []);
  assert.strictEqual(snap.persistence, null);
  assert.strictEqual(snap.last_hydration, null);
  assert.deepStrictEqual(snap.summary, {
    active_session_count: 0,
    pending_approval_count: 0,
    persistence_enabled: false,
    persistence_alert_count: 0,
  });
});

test('it counts live sessions and pending tickets, and ignores decided ones', () => {
  const cm = createSshConnectionManager();
  const ab = createRemoteApprovalBridge();
  const a = cm.connect({ hostEntry: { alias: 'one' } });
  cm.connect({ hostEntry: { alias: 'two' } });
  cm.disconnect(a.connectionId);
  const pending = ab.createTicket({ commands: ['git push'], connectionId: 'c-1' });
  const approved = ab.createTicket({ commands: ['git push'], connectionId: 'c-1' });
  const rejected = ab.createTicket({ commands: ['rm -rf /var'], connectionId: 'c-1' });
  ab.approveTicket(approved.ticket_id);
  ab.rejectTicket(rejected.ticket_id);
  const svc = new RemoteStateSyncService({ connectionManager: cm, approvalBridge: ab });
  const snap = svc.getSnapshot();
  assert.strictEqual(snap.summary.active_session_count, 1);
  assert.strictEqual(snap.summary.pending_approval_count, 1);
  assert.deepStrictEqual(snap.pending_remote_approvals.map((t) => t.ticket_id), [pending.ticket_id]);
  assert.strictEqual(snap.active_remote_sessions[0].hostAlias, 'two');
});

test('persistence status is passed through and hydration is lifted out of it', () => {
  const status = {
    enabled: true,
    state_path: '/tmp/pinned/ssh_state.json',
    alert_total: 3,
    hydration: { loaded: true, approvals_loaded: 2, streams_loaded: 1 },
  };
  const snap = harness({ persistence: () => status }).getSnapshot();
  assert.strictEqual(snap.persistence.enabled, true);
  assert.strictEqual(snap.last_hydration.loaded, true);
  assert.strictEqual(snap.summary.persistence_enabled, true);
  assert.strictEqual(snap.summary.persistence_alert_count, 3);
});

// B31-R21 (registered, NOT fixed): the summary is the only place a caller learns
// "is my remote state on disk?" and it is built with two different fallback
// behaviours. `persistence_alert_count` guards with Number.isFinite (:27) and
// collapses a missing / NaN / non-numeric reading to 0, i.e. "no alerts" — the
// same number as "everything is fine". `persistence_enabled` uses Boolean() on
// the same absent field and reports false. So a broken status producer reads as a
// healthy disabled unit rather than as an unknown.
test('B31-R21 an absent persistence reading is indistinguishable from "clean"', () => {
  const snap = harness({ persistence: () => ({ alert_total: 'not-a-number' }) }).getSnapshot();
  assert.strictEqual(snap.summary.persistence_alert_count, 0);
  assert.strictEqual(snap.summary.persistence_enabled, false);
  const noTotal = harness({ persistence: () => null }).getSnapshot();
  assert.deepStrictEqual(noTotal.summary, {
    active_session_count: 0,
    pending_approval_count: 0,
    persistence_enabled: false,
    persistence_alert_count: 0,
  });
  assert.strictEqual(noTotal.persistence, null);
  assert.strictEqual(noTotal.last_hydration, null);
});

test('a non-function persistence producer is ignored, not called', () => {
  const svc = new RemoteStateSyncService({
    connectionManager: createSshConnectionManager(),
    approvalBridge: createRemoteApprovalBridge(),
    getPersistenceStatus: 'not-a-function',
  });
  assert.strictEqual(svc.getSnapshot().persistence, null);
});

test('the snapshot is a fresh object every call (it is a polling surface)', () => {
  const svc = harness({ persistence: () => ({ enabled: false }) });
  const one = svc.getSnapshot();
  const two = svc.getSnapshot();
  assert.notStrictEqual(one, two);
  assert.notStrictEqual(one.summary, two.summary);
});
