'use strict';

// Co-located unit test for index.js - the stateful body of the remote unit: it wires
// the primitives into module-load singletons, owns the persist debouncer and the
// persistence-alert ring, and hydrates from the state file at require time.
//
// HARD ISOLATION CONTRACT:
//   * HOME / USERPROFILE / KHY_DATA_HOME / KHY_PROJECT_DATA_HOME / XDG_CONFIG_HOME are
//     pinned inside a fresh mkdtemp directory BEFORE anything is required, so the state
//     file and the SSH config lookup can only ever resolve under that sandbox.
//   * KHY_REMOTE_SSH_CONFIG_PATH points at a path that is never created, so
//     ~/.ssh/config is not opened.
//   * KHY_REMOTE_SSH_ENABLE_EXEC stays 'false' and child_process.spawn is stubbed to
//     throw BEFORE ./index is required (the exec and transfer modules bind `spawn` at
//     their own load time, so a later patch would not bind - see B31-R17).
//   * Every stateful case gets a freshly required instance with its own state file in
//     its own subdirectory, so no case depends on another case's order.
//
// Registered defects asserted as CURRENT behaviour (NOT fixed, see khy.module.json):
// B31-R16  the exported hydration record is written once, at module load
// B31-R16b a failed save never arms the debounce, so every later mutation hits the disk
// B31-R16c resetRemoteStateForTests() re-creates the alerts and saves it just cleared

const test = require('node:test').test;
const after = require('node:test').after;
const assert = require('node:assert');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-remote-'));
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.KHY_DATA_HOME = path.join(SANDBOX, 'data');
process.env.KHY_PROJECT_DATA_HOME = path.join(SANDBOX, 'project-data');
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, 'config');
process.env.KHY_REMOTE_SSH_CONFIG_PATH = path.join(SANDBOX, 'ssh_config');
process.env.KHY_REMOTE_SSH_ENABLE_EXEC = 'false';
for (const key of [
  'KHY_REMOTE_SSH_PERSIST_STATE',
  'KHY_REMOTE_SSH_STATE_PATH',
  'KHY_REMOTE_SSH_PERSIST_DEBOUNCE_MS',
  'KHY_REMOTE_SSH_PERSIST_ALERT_MAX',
  'KHY_REMOTE_SSH_PERSIST_ALERT_RETENTION_MS',
]) {
  delete process.env[key];
}

const REAL_SPAWN = cp.spawn;
let spawnAttempts = 0;
cp.spawn = function guardedSpawn(...args) {
  spawnAttempts += 1;
  throw new Error(`test isolation: spawn(${String(args[0])}) is not allowed here`);
};
after(() => {
  cp.spawn = REAL_SPAWN;
});

const mod = require('./index');
const INDEX_PATH = require.resolve('./index');
const storeMod = require('./remoteExecStreamStore');
const { RemoteExecService } = require('./remoteExecService');
const { DeployOrchestrator } = require('./deployOrchestrator');
const { RemoteStateSyncService } = require('./remoteStateSyncService');
const { SshConnectionManager } = require('./sshConnectionManager');
const { RemoteApprovalBridge } = require('./remoteApprovalBridge');
const { RemoteStatePersistence } = require('./remoteStatePersistence');
const { getDataHome } = require('../../../../utils/dataHome');

const PERSIST_KEYS = [
  'KHY_REMOTE_SSH_PERSIST_STATE',
  'KHY_REMOTE_SSH_STATE_PATH',
  'KHY_REMOTE_SSH_PERSIST_DEBOUNCE_MS',
  'KHY_REMOTE_SSH_PERSIST_ALERT_MAX',
  'KHY_REMOTE_SSH_PERSIST_ALERT_RETENTION_MS',
];

let caseCounter = 0;

// Requires a pristine copy of the unit with `env` applied over the healthy defaults
// (persistence on, 120ms debounce, state file in a private subdirectory). `prep` runs
// before the require so a case can lay out its own disk. Env is restored immediately
// after the require: the singletons capture it at load.
function openIndex(env, prep) {
  const root = path.join(SANDBOX, `case-${++caseCounter}`);
  fs.mkdirSync(root, { recursive: true });
  const merged = Object.assign(
    {
      KHY_REMOTE_SSH_PERSIST_STATE: '1',
      KHY_REMOTE_SSH_PERSIST_DEBOUNCE_MS: '120',
      KHY_REMOTE_SSH_STATE_PATH: path.join(root, 'state', 'ssh_state.json'),
    },
    env || {}
  );
  if (typeof prep === 'function') {
    prep(root, merged.KHY_REMOTE_SSH_STATE_PATH);
  }
  const previous = {};
  for (const key of PERSIST_KEYS) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null;
  }
  for (const key of PERSIST_KEYS) {
    if (merged[key] === null || merged[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(merged[key]);
    }
  }
  delete require.cache[INDEX_PATH];
  let inst = null;
  try {
    inst = require(INDEX_PATH);
  } finally {
    for (const key of PERSIST_KEYS) {
      if (previous[key] === null) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
  return {
    inst,
    root,
    statePath: merged.KHY_REMOTE_SSH_STATE_PATH,
    status: () => inst.remoteStateSyncService.getSnapshot().persistence,
  };
}

function brokenDiskRoot(root) {
  // A regular file where the state directory has to be: every save fails.
  fs.writeFileSync(path.join(root, 'state'), 'not a directory', 'utf-8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('the unit barrel exports exactly the wired surface', () => {
  assert.deepStrictEqual(Object.keys(mod), [
    'sshConfigService',
    'sshCredentialGuard',
    'sshConnectionManager',
    'remoteWorkspaceResolver',
    'remoteExecService',
    'remoteFileTransferService',
    'deployOrchestrator',
    'remoteApprovalBridge',
    'remoteStateSyncService',
    'remoteExecStreamStore',
    'remoteStatePersistence',
    'remoteStateHydration',
    'buildRemoteExecStreamRequestFingerprint',
    'persistRemoteState',
    'listPersistenceAlerts',
    'subscribePersistenceAlerts',
    'markPersistenceAlertsAcknowledged',
    'hydrateRemoteStateFromDisk',
    'resetRemoteStateForTests',
  ]);
  for (const fn of [
    'persistRemoteState',
    'listPersistenceAlerts',
    'subscribePersistenceAlerts',
    'markPersistenceAlertsAcknowledged',
    'hydrateRemoteStateFromDisk',
    'resetRemoteStateForTests',
  ]) {
    assert.strictEqual(typeof mod[fn], 'function', `${fn} must stay callable`);
  }
});

test('the singletons are the real wired graph and the re-exports are identities', () => {
  assert.strictEqual(mod.buildRemoteExecStreamRequestFingerprint, storeMod.buildRemoteExecStreamRequestFingerprint);
  assert.strictEqual(mod.sshConfigService, require('./sshConfigService'));
  assert.strictEqual(mod.sshCredentialGuard, require('./sshCredentialGuard'));
  assert.strictEqual(mod.remoteWorkspaceResolver, require('./remoteWorkspaceResolver'));
  assert.ok(mod.sshConnectionManager instanceof SshConnectionManager);
  assert.ok(mod.remoteApprovalBridge instanceof RemoteApprovalBridge);
  assert.ok(mod.remoteExecService instanceof RemoteExecService);
  assert.ok(mod.deployOrchestrator instanceof DeployOrchestrator);
  assert.ok(mod.remoteStateSyncService instanceof RemoteStateSyncService);
  assert.ok(mod.remoteStatePersistence instanceof RemoteStatePersistence);
  assert.strictEqual(mod.deployOrchestrator._execService, mod.remoteExecService);
  assert.strictEqual(mod.deployOrchestrator._fileTransferService, mod.remoteFileTransferService);
  assert.strictEqual(mod.deployOrchestrator._approvalBridge, mod.remoteApprovalBridge);
  assert.strictEqual(mod.remoteExecService._connectionManager, mod.sshConnectionManager);
  assert.strictEqual(mod.remoteStateSyncService._approvalBridge, mod.remoteApprovalBridge);
  assert.strictEqual(mod.deployOrchestrator._sshConfigService, mod.sshConfigService);
});

test('persistence is off by default and its path is derived, never hardcoded', () => {
  assert.strictEqual(mod.remoteStatePersistence.isEnabled(), false);
  assert.strictEqual(
    mod.remoteStatePersistence.getStatePath(),
    path.join(getDataHome(), 'remote', 'ssh_state.json')
  );
  assert.ok(mod.remoteStatePersistence.getStatePath().startsWith(SANDBOX));
});

test('module load hydrates once and reports why it loaded nothing', () => {
  // The record a load writes is the shape of `finalize()` (index.js:458), not of the
  // literal at :46 - the literal only exists until line 508 runs.
  assert.deepStrictEqual(Object.keys(mod.remoteStateHydration), [
    'attempted_at', 'started_at', 'completed_at', 'duration_ms', 'approvals_loaded',
    'streams_loaded', 'path', 'loaded', 'reason_code', 'reason',
  ]);
  assert.strictEqual(mod.remoteStateHydration.loaded, false);
  assert.strictEqual(mod.remoteStateHydration.reason_code, 'persistence_disabled');
  assert.strictEqual(mod.remoteStateHydration.approvals_loaded, 0);
  assert.strictEqual(mod.remoteStateHydration.streams_loaded, 0);
  assert.strictEqual(typeof mod.remoteStateHydration.duration_ms, 'number');
  assert.strictEqual(mod.remoteStateHydration.path, mod.remoteStatePersistence.getStatePath());
  assert.ok(!Number.isNaN(Date.parse(mod.remoteStateHydration.attempted_at)));
  assert.deepStrictEqual(mod.listPersistenceAlerts(), []);
  assert.strictEqual(mod.remoteStateSyncService.getSnapshot().persistence.alert_total, 0);
});

test('with persistence off nothing is written and nothing is scheduled', () => {
  assert.strictEqual(mod.persistRemoteState(), undefined);
  const status = mod.remoteStateSyncService.getSnapshot().persistence;
  assert.deepStrictEqual(Object.keys(status), [
    'enabled', 'state_path', 'debounce_ms', 'total_save_count', 'last_save_at',
    'last_save_status', 'last_saved_approvals', 'last_saved_streams', 'last_error',
    'last_trigger_source', 'last_trigger_reason', 'pending_flush', 'timer_active',
    'alert_total', 'alert_subscriber_total', 'unacked_alert_total', 'latest_alert',
    'latest_unacked_alert', 'hydration',
  ]);
  assert.strictEqual(status.enabled, false);
  assert.strictEqual(status.total_save_count, 0);
  assert.strictEqual(status.last_save_status, 'never');
  assert.strictEqual(status.debounce_ms, 200, 'the default debounce window is 200ms');
  assert.strictEqual(status.pending_flush, false);
  assert.strictEqual(status.timer_active, false);
  assert.strictEqual(fs.existsSync(status.state_path), false);
  assert.strictEqual(mod.hydrateRemoteStateFromDisk().reason_code, 'persistence_disabled');
  assert.deepStrictEqual(mod.listPersistenceAlerts({ limit: 5 }), []);
});

test('a load with persistence on but no state file reports it, and writes nothing', () => {
  const { inst, statePath, status } = openIndex();
  assert.strictEqual(status().enabled, true);
  assert.strictEqual(status().debounce_ms, 120);
  assert.strictEqual(status().state_path, statePath);
  assert.strictEqual(status().last_save_status, 'never');
  assert.strictEqual(status().total_save_count, 0);
  assert.strictEqual(inst.remoteStateHydration.loaded, false);
  assert.strictEqual(inst.remoteStateHydration.reason_code, 'state_file_missing_or_invalid');
  assert.strictEqual(inst.remoteStateHydration.reason, 'State file is missing or invalid.');
  assert.ok(inst.remoteStateHydration.path.startsWith(statePath));
  assert.strictEqual(fs.existsSync(statePath), false, 'hydration is read-only');
});

test('the first mutation is written immediately, later ones are debounced', () => {
  const { inst, statePath, status } = openIndex();
  const ticket = inst.remoteApprovalBridge.createTicket({
    connectionId: 'c-idx',
    hostAlias: 'prod.example.invalid',
    commands: ['git push origin main'],
    idempotencyKey: 'idx-1',
  });
  assert.strictEqual(status().total_save_count, 1, 'lastSavedAtMs starts at 0, so the first mutation is a save');
  assert.strictEqual(status().last_trigger_source, 'remote_approval_bridge');
  assert.strictEqual(status().last_trigger_reason, 'create_ticket');
  assert.strictEqual(status().last_saved_approvals, 1);
  assert.strictEqual(status().alert_total, 0);
  assert.strictEqual(status().timer_active, false);

  const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  assert.strictEqual(raw.version, 1);
  assert.deepStrictEqual(raw.streams, []);
  assert.strictEqual(raw.approvals.length, 1);
  assert.strictEqual(raw.approvals[0].idempotency_key, 'idx-1');
  assert.ok(!Number.isNaN(Date.parse(raw.saved_at)));
  assert.strictEqual(fs.existsSync(`${statePath}.tmp`), false, 'the temp file is renamed away');

  const beforeFlush = status().total_save_count;
  inst.persistRemoteState();
  assert.strictEqual(status().total_save_count, beforeFlush + 1);
  assert.strictEqual(status().last_trigger_source, 'manual');
  assert.strictEqual(status().last_trigger_reason, 'manual_flush');
  assert.strictEqual(status().timer_active, false);

  inst.remoteApprovalBridge.approveTicket(ticket.ticket_id, 'reviewer');
  assert.strictEqual(status().total_save_count, beforeFlush + 1, 'approve_ticket now falls in the window');
  assert.strictEqual(status().pending_flush, true);
  assert.strictEqual(status().timer_active, true);
});

test('the debounce timer flushes by itself and lands the approved ticket', async () => {
  const { inst, statePath, status } = openIndex();
  inst.persistRemoteState();
  const ticket = inst.remoteApprovalBridge.createTicket({
    connectionId: 'c-idx',
    commands: ['git push origin main'],
    idempotencyKey: 'idx-t',
  });
  inst.remoteApprovalBridge.approveTicket(ticket.ticket_id, 'ops');
  const before = status().total_save_count;
  assert.strictEqual(status().pending_flush, true);
  await sleep(260);
  assert.strictEqual(status().total_save_count, before + 1, 'the deferred flush fired');
  assert.strictEqual(status().last_trigger_reason, 'debounce_flush');
  assert.strictEqual(status().pending_flush, false);
  assert.strictEqual(status().timer_active, false);
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  assert.strictEqual(raw.approvals[0].status, 'approved');
});

test('approval state survives into a freshly loaded instance', () => {
  const first = openIndex();
  const ticket = first.inst.remoteApprovalBridge.createTicket({
    connectionId: 'c-idx',
    hostAlias: 'prod.example.invalid',
    commands: ['systemctl restart nginx'],
    idempotencyKey: 'idx-2',
  });
  first.inst.remoteApprovalBridge.approveTicket(ticket.ticket_id, 'reviewer');
  first.inst.remoteExecStreamStore.ensureSession({ streamId: 's-idx' });
  first.inst.remoteExecStreamStore.appendEvent('s-idx', { event: 'log', data: { line: 'one' } });
  first.inst.persistRemoteState();

  const second = openIndex({ KHY_REMOTE_SSH_STATE_PATH: first.statePath });
  assert.strictEqual(second.inst.remoteStateHydration.loaded, true);
  assert.strictEqual(second.inst.remoteStateHydration.approvals_loaded, 1);
  assert.strictEqual(second.inst.remoteStateHydration.streams_loaded, 1);
  assert.strictEqual(second.inst.remoteStateHydration.reason_code, null);
  assert.strictEqual(second.inst.remoteStateHydration.reason, null);
  assert.strictEqual(second.inst.remoteStateHydration.version, 1);
  const restored = second.inst.remoteApprovalBridge.getTicket(ticket.ticket_id);
  assert.strictEqual(restored.status, 'approved');
  assert.strictEqual(restored.approved_by, 'reviewer');
  // getSession hands out the _cloneSession shape (remoteExecStreamStore.js:138-154),
  // which carries no `events` array by design; the event replay surface is
  // getEventsSince (:367-394). The original assertion probed an API shape that
  // never existed (test-side bug, not a source defect).
  const replay = second.inst.remoteExecStreamStore.getEventsSince('s-idx', 0);
  assert.ok(replay, 'the restored stream answers on its real replay API');
  assert.strictEqual(replay.events.length, 1);
  assert.strictEqual(
    second.status().total_save_count,
    0,
    'the load-time import is swallowed by the hydration guard, not re-saved'
  );
  assert.strictEqual(second.status().last_save_status, 'never');
  assert.strictEqual(second.status().hydration, second.inst.remoteStateHydration);
});

test('a terminal stream event is force-persisted, a plain one is debounced', () => {
  const { inst, status } = openIndex();
  inst.persistRemoteState();
  const before = status().total_save_count;
  inst.remoteExecStreamStore.ensureSession({ streamId: 's-idx' });
  assert.strictEqual(status().total_save_count, before, 'create_session is debounced');
  assert.strictEqual(status().last_trigger_reason, 'manual_flush');

  inst.remoteExecStreamStore.appendEvent('s-idx', { event: 'log', data: { line: 'step 1' } });
  assert.strictEqual(status().last_trigger_reason, 'manual_flush', 'append_event without done is debounced');

  inst.remoteExecStreamStore.appendEvent('s-idx', { event: 'done', data: { status: 'completed' } });
  assert.strictEqual(status().total_save_count, before + 1, 'done is durable immediately');
  assert.strictEqual(status().last_trigger_reason, 'append_event');
  assert.strictEqual(status().last_trigger_source, 'remote_exec_stream_store');
  assert.strictEqual(status().last_saved_streams, 1);
  assert.strictEqual(status().timer_active, false, 'the forced flush cancels the pending timer');
});

test('import_state and clear_all are forced', () => {
  const { inst, status } = openIndex();
  inst.remoteApprovalBridge.importState([
    { ticket_id: 't-import', status: 'pending', commands: [{ command: 'git push' }] },
  ]);
  assert.strictEqual(status().last_trigger_reason, 'import_state');
  assert.strictEqual(status().last_trigger_source, 'remote_approval_bridge');
  assert.strictEqual(status().last_saved_approvals, 1);

  inst.remoteApprovalBridge.clearAll();
  assert.strictEqual(status().last_trigger_reason, 'clear_all');
  assert.strictEqual(status().last_saved_approvals, 0);
  assert.strictEqual(status().alert_total, 0);
  assert.strictEqual(status().timer_active, false);
});

// B31-R16b (registered, NOT fixed): `lastSavedAtMs` is only advanced on a successful
// save (:278) while the throttle test (:337) treats `lastSavedAtMs === 0` as "never
// saved". A unit whose disk is unavailable therefore re-enters `_saveRemoteStateNow`
// synchronously on EVERY mutation: no debounce, no backoff, one failed write plus one
// alert per event.
test('B31-R16b a failing disk defeats the debounce entirely', () => {
  const { inst, status } = openIndex();
  const broken = openIndex({}, brokenDiskRoot);
  assert.strictEqual(status().enabled, true, 'the healthy instance is untouched by the broken one');
  for (let i = 0; i < 3; i += 1) {
    broken.inst.persistRemoteState({ source: 'test', reason: `mutate_${i}`, payload: {} });
  }
  const after = broken.status();
  assert.strictEqual(after.total_save_count, 0);
  assert.strictEqual(after.last_save_status, 'failed');
  assert.strictEqual(after.alert_total, 3, 'three synchronous attempts, not one plus a timer');
  assert.strictEqual(after.timer_active, false);
  assert.strictEqual(after.pending_flush, false);
  assert.match(after.last_error, /EPERM|ENOTDIR|EEXIST|EISDIR|EINVAL/);
  const alerts = broken.inst.listPersistenceAlerts({ limit: 5 });
  assert.deepStrictEqual(alerts.map((a) => a.trigger_reason), ['mutate_0', 'mutate_1', 'mutate_2']);
  assert.deepStrictEqual(alerts.map((a) => a.alert_id), [1, 2, 3]);
  assert.strictEqual(alerts[0].code, 'persist_save_failed');
  assert.strictEqual(alerts[0].severity, 'error');
  assert.strictEqual(alerts[0].acked, false);
  assert.strictEqual(alerts[0].trigger_source, 'test');
  assert.ok(alerts[0].details.state_path.endsWith(path.join('state', 'ssh_state.json')));
  assert.match(alerts[0].details.error, /EPERM|ENOTDIR|EEXIST|EISDIR|EINVAL/);
  assert.strictEqual(after.latest_alert.alert_id, 3);
  assert.strictEqual(after.latest_unacked_alert.alert_id, 3);
  void inst;
});

test('a recovered save appends an info alert and clears the error', () => {
  const broken = openIndex({}, brokenDiskRoot);
  broken.inst.persistRemoteState({ source: 'test', reason: 'one', payload: {} });
  assert.strictEqual(broken.status().alert_total, 1);
  fs.unlinkSync(path.join(broken.root, 'state'));
  broken.inst.persistRemoteState({ source: 'test', reason: 'two', payload: {} });
  const after = broken.status();
  assert.strictEqual(after.last_save_status, 'saved');
  assert.strictEqual(after.total_save_count, 1);
  assert.strictEqual(after.last_error, null);
  assert.strictEqual(after.alert_total, 2);
  const alerts = broken.inst.listPersistenceAlerts({ limit: 5 });
  assert.deepStrictEqual(alerts.map((a) => a.code), ['persist_save_failed', 'persist_save_recovered']);
  assert.strictEqual(alerts[1].severity, 'info');
  assert.strictEqual(alerts[1].details.approvals, 0);
  assert.strictEqual(alerts[1].details.streams, 0);
  assert.ok(alerts[1].details.state_path);
});

test('the alert ring is bounded, newest last, and hands out clones', () => {
  const capped = openIndex({ KHY_REMOTE_SSH_PERSIST_ALERT_MAX: '2' }, brokenDiskRoot);
  for (let i = 0; i < 5; i += 1) {
    capped.inst.persistRemoteState({ source: 'test', reason: `r${i}`, payload: {} });
  }
  const listed = capped.inst.listPersistenceAlerts({ limit: 10 });
  assert.strictEqual(listed.length, 2, 'ALERT_MAX=2 keeps only the newest two');
  assert.deepStrictEqual(listed.map((a) => a.trigger_reason), ['r3', 'r4']);
  assert.deepStrictEqual(listed.map((a) => a.alert_id), [4, 5], 'the sequence counter is not reset by trimming');
  assert.strictEqual(capped.inst.listPersistenceAlerts({ limit: 1 })[0].alert_id, 5, 'the tail is kept');
  assert.strictEqual(capped.inst.listPersistenceAlerts({ limit: 0 }).length, 2, 'limit 0 falls back to 20');
  assert.strictEqual(capped.inst.listPersistenceAlerts({ limit: 'junk' }).length, 2);
  assert.strictEqual(capped.inst.listPersistenceAlerts({ limit: 500 }).length, 2, 'the limit itself is clamped to 200');
  assert.strictEqual(capped.inst.listPersistenceAlerts({ afterId: '4' }).length, 1);
  assert.strictEqual(capped.inst.listPersistenceAlerts({ afterId: 'nope' }).length, 2);
  assert.strictEqual(capped.inst.listPersistenceAlerts({ afterId: -1 }).length, 2);
  assert.strictEqual(capped.status().alert_total, 2);
  listed[0].message = 'caller mutation';
  assert.notStrictEqual(capped.inst.listPersistenceAlerts({ limit: 10 })[0].message, 'caller mutation');
});

test('an expired alert is pruned on the next append', async () => {
  const shortLived = openIndex({ KHY_REMOTE_SSH_PERSIST_ALERT_RETENTION_MS: '10' }, brokenDiskRoot);
  shortLived.inst.persistRemoteState({ source: 'test', reason: 'old', payload: {} });
  assert.strictEqual(shortLived.inst.listPersistenceAlerts({ limit: 5 }).length, 1);
  await sleep(40);
  shortLived.inst.persistRemoteState({ source: 'test', reason: 'new', payload: {} });
  assert.deepStrictEqual(shortLived.inst.listPersistenceAlerts({ limit: 5 }).map((a) => a.trigger_reason), ['new']);
  assert.strictEqual(shortLived.status().alert_total, 1);
  assert.strictEqual(shortLived.status().unacked_alert_total, 1);
});

test('alerts are acknowledged by id or watermark, once only', () => {
  const broken = openIndex({}, brokenDiskRoot);
  for (let i = 1; i <= 3; i += 1) {
    broken.inst.persistRemoteState({ source: 'test', reason: `m${i}`, payload: {} });
  }
  assert.strictEqual(broken.status().unacked_alert_total, 3);
  assert.deepStrictEqual(broken.inst.markPersistenceAlertsAcknowledged({}), {
    ok: false,
    code: 'ack_target_required',
    acked_count: 0,
    alerts: [],
  });
  const one = broken.inst.markPersistenceAlertsAcknowledged({ alertId: '2', reviewer: '  ops  ' });
  assert.strictEqual(one.ok, true);
  assert.strictEqual(one.code, 'ack_completed');
  assert.strictEqual(one.acked_count, 1);
  assert.strictEqual(one.alerts[0].acked_by, 'ops', 'the reviewer name is trimmed');
  assert.ok(!Number.isNaN(Date.parse(one.alerts[0].acked_at)));
  assert.strictEqual(broken.inst.markPersistenceAlertsAcknowledged({ alertId: 2 }).acked_count, 0, 'no double ack');
  const upTo = broken.inst.markPersistenceAlertsAcknowledged({ upToId: 99, reviewer: '   ' });
  assert.strictEqual(upTo.acked_count, 2);
  assert.strictEqual(upTo.alerts[0].acked_by, null, 'a blank reviewer becomes null');
  const status = broken.status();
  assert.strictEqual(status.unacked_alert_total, 0);
  assert.strictEqual(status.latest_unacked_alert, null);
  assert.strictEqual(status.latest_alert.acked, true);
  assert.strictEqual(status.alert_total, 3);
  assert.deepStrictEqual(broken.inst.listPersistenceAlerts({ onlyUnacked: true }), []);
});

test('alert subscribers get clones and a throwing listener cannot starve the rest', () => {
  const healthy = openIndex();
  const seen = [];
  const unsubscribe = healthy.inst.subscribePersistenceAlerts((alert) => seen.push(alert));
  assert.strictEqual(typeof unsubscribe, 'function');
  assert.strictEqual(healthy.status().alert_subscriber_total, 1);
  assert.strictEqual(typeof healthy.inst.subscribePersistenceAlerts('not a function'), 'function');
  assert.strictEqual(healthy.status().alert_subscriber_total, 1, 'a non-function never registers');
  unsubscribe();
  assert.strictEqual(healthy.status().alert_subscriber_total, 0);

  const broken = openIndex({}, brokenDiskRoot);
  const good = [];
  broken.inst.subscribePersistenceAlerts(() => {
    throw new Error('subscriber died');
  });
  const off = broken.inst.subscribePersistenceAlerts((alert) => good.push(alert));
  // Current behaviour: subscribePersistenceAlerts (index.js:179-187) registers every
  // function listener, throwing ones included, so two distinct closures occupy two
  // slots of the module-level Set; alert_subscriber_total is its size (index.js:402).
  // The earlier expectation of 1 was a test-side miscount, not a source defect.
  assert.strictEqual(broken.status().alert_subscriber_total, 2);
  broken.inst.persistRemoteState({ source: 'test', reason: 'boom', payload: {} });
  assert.strictEqual(good.length, 1);
  assert.strictEqual(good[0].trigger_reason, 'boom');
  assert.strictEqual(seen.length, 0, 'an instance never broadcasts to another instance');
  off();
  broken.inst.persistRemoteState({ source: 'test', reason: 'boom2', payload: {} });
  assert.strictEqual(good.length, 1, 'the unsubscribe detached');
  assert.strictEqual(healthy.status().alert_total, 0, 'the healthy disk recorded no alerts');
});

// B31-R16 (registered, NOT fixed): the barrel exports `remoteStateHydration` by value
// (:555) and that variable is assigned only once, at module load (:508);
// `hydrateRemoteStateFromDisk()` returns its record but never writes it back
// (:455-506). So the exported field is a load-time fossil: after a re-hydration or a
// reset, the export and the live reading inside the unit disagree, and a dashboard
// polling the export keeps showing the startup answer forever.
test('B31-R16 the exported hydration record is a load-time fossil', () => {
  const { inst, status } = openIndex();
  const exportedAtLoad = inst.remoteStateHydration;
  assert.strictEqual(exportedAtLoad.reason_code, 'state_file_missing_or_invalid');
  assert.strictEqual(status().hydration, exportedAtLoad);

  inst.remoteApprovalBridge.importState([
    { ticket_id: 't-fossil', status: 'pending', commands: [{ command: 'git push' }] },
  ]);
  const rerun = inst.hydrateRemoteStateFromDisk();
  assert.strictEqual(rerun.loaded, true);
  assert.strictEqual(rerun.approvals_loaded, 1);
  assert.notStrictEqual(rerun, inst.remoteStateHydration, 'a re-hydration is never published');
  assert.strictEqual(inst.remoteStateHydration.reason_code, 'state_file_missing_or_invalid');
  assert.strictEqual(
    status().hydration.reason_code,
    'state_file_missing_or_invalid',
    'not even the live snapshot sees the rerun'
  );

  inst.resetRemoteStateForTests();
  assert.strictEqual(inst.remoteStateHydration.reason_code, 'state_file_missing_or_invalid', 'the export is stale');
  assert.strictEqual(
    status().hydration.reason_code,
    'reset',
    'while the live record says reset: two readers, two answers'
  );
});

// B31-R16c (registered, NOT fixed): `resetRemoteStateForTests()` (:510) empties the
// alert ring, zeroes the save counters and stamps the status 'reset' - then calls
// clearAll() on the bridge and the stream store (:538-539), both force-persist
// mutations. So the reset writes (or fails to) after clearing, and returns with
// non-zero counters: resetting to a clean slate never yields a clean slate.
test('B31-R16c reset re-runs two forced saves after emptying the ring', () => {
  const { inst, status } = openIndex();
  inst.remoteApprovalBridge.createTicket({ connectionId: 'c-idx', commands: ['git push'], idempotencyKey: 'idx-r' });
  inst.remoteExecStreamStore.ensureSession({ streamId: 's-idx' });
  inst.persistRemoteState();
  assert.ok(status().total_save_count >= 1);
  assert.strictEqual(status().alert_total, 0);

  inst.resetRemoteStateForTests();
  const after = status();
  assert.strictEqual(inst.sshConnectionManager.listSessions().length, 0);
  assert.strictEqual(inst.remoteApprovalBridge.listTickets().length, 0);
  assert.strictEqual(after.total_save_count, 2, 'reset zeroes the count, then clearAll x2 lands on disk');
  assert.strictEqual(after.last_trigger_reason, 'clear_all');
  assert.strictEqual(after.last_save_status, 'saved', 'the status stamped by reset is overwritten at once');
  assert.strictEqual(after.alert_total, 0, 'a healthy disk at least keeps the ring empty');
  inst.persistRemoteState();
  assert.strictEqual(status().total_save_count, 3, 'and the unit is still writable after the reset');
});

test('B31-R16c on a failing disk the reset starts the next case with two alerts', () => {
  const broken = openIndex({}, brokenDiskRoot);
  broken.inst.persistRemoteState({ source: 'test', reason: 'first', payload: {} });
  assert.strictEqual(broken.status().alert_total, 1);
  broken.inst.resetRemoteStateForTests();
  const after = broken.status();
  assert.strictEqual(after.alert_total, 2, 'clearAll x2 failed again right after the ring was emptied');
  assert.deepStrictEqual(
    broken.inst.listPersistenceAlerts({ limit: 5 }).map((a) => a.trigger_reason),
    ['clear_all', 'clear_all']
  );
  assert.strictEqual(after.total_save_count, 0);
  assert.strictEqual(after.last_save_status, 'failed');
  assert.strictEqual(after.unacked_alert_total, 2, 'and they arrive unacknowledged');
  assert.strictEqual(broken.inst.sshConnectionManager.listSessions().length, 0);
});

test('junk env numbers fall back to the documented defaults', () => {
  const junk = openIndex({
    KHY_REMOTE_SSH_PERSIST_DEBOUNCE_MS: '0',
    KHY_REMOTE_SSH_PERSIST_ALERT_MAX: '-4',
    KHY_REMOTE_SSH_PERSIST_ALERT_RETENTION_MS: 'not-a-number',
  });
  assert.strictEqual(junk.status().debounce_ms, 200);
  assert.strictEqual(junk.status().enabled, true);
  junk.inst.persistRemoteState({ source: 'test', reason: 'x', payload: {} });
  assert.strictEqual(junk.status().alert_total, 0, 'the disk is fine, so no alert at all');
});

test('nothing in this file spawned a process, dialled a host or wrote outside the sandbox', () => {
  assert.strictEqual(spawnAttempts, 0);
  assert.strictEqual(fs.existsSync(path.join(SANDBOX, '.ssh')), false, 'the real ~/.ssh tree was not created');
  assert.strictEqual(fs.existsSync(path.join(SANDBOX, 'ssh_config')), false, 'no SSH config was read or written');
  const status = mod.remoteStateSyncService.getSnapshot().persistence;
  assert.strictEqual(status.timer_active, false);
  assert.strictEqual(status.pending_flush, false);
  assert.ok(status.state_path.startsWith(SANDBOX), status.state_path);
  assert.ok(process.env.HOME.startsWith(SANDBOX));
  for (const entry of fs.readdirSync(SANDBOX)) {
    assert.ok(
      ['case-1', 'case-2', 'case-3', 'case-4', 'case-5', 'case-6', 'case-7', 'case-8', 'case-9', 'data'].includes(entry)
        || /^case-\d+$/.test(entry),
      `unexpected sandbox entry ${entry}`
    );
  }
});
