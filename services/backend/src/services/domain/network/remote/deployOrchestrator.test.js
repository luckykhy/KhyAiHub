'use strict';

// Co-located unit test for deployOrchestrator.js.
//
// HARD ISOLATION CONTRACT: the orchestrator owns no transport of its own — every
// side effect goes through the seven constructor dependencies (`connectionManager`,
// `approvalBridge`, `execService`, `fileTransferService`, `sshConfigService`,
// `sshCredentialGuard`, `workspaceResolver`, `buildDockerBundle`). All of them are
// injected here with fakes or with in-memory siblings, so no ssh/scp child process
// and no socket is ever created. `child_process.spawn` is additionally replaced by a
// throwing tripwire and every case ends with `spawnAttempts === 0`.
//
// Registered defects asserted as CURRENT behaviour (NOT fixed, see khy.module.json):
// B31-R7  pending-deploy map leak + permanently consumed ticket after a failed upload
// B31-R7b `mode` label is derived from truthiness while the gate is `=== true`
// B31-R7c injected dependency return values are trusted, never validated
// B31-R8  every dry-run leaks a "connected" session; apply never disconnects
// B31-R9  a bundle without `bundleName` collapses into the shared `deploy-undefined`

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
  process.env.KHY_REMOTE_SSH_CONFIG_PATH = path.join(root, 'ssh_config');
  process.env.KHY_REMOTE_SSH_ENABLE_EXEC = 'false';
  return root;
}

const SANDBOX = pinSandbox();

// Tripwire installed BEFORE any subsystem module is required: remoteFileTransferService
// and remoteExecService destructure `spawn` out of require('child_process') at their own
// load time, so patching afterwards would not bind. See B31-R17 and the instrument notes.
const REAL_SPAWN = cp.spawn;
let spawnAttempts = 0;
cp.spawn = function guardedSpawn(...args) {
  spawnAttempts += 1;
  throw new Error(`test isolation: spawn(${String(args[0])}) is not allowed here`);
};
after(() => {
  cp.spawn = REAL_SPAWN;
});

const mod = require('./deployOrchestrator');
const { DeployOrchestrator, createDeployOrchestrator } = mod;
const { createSshConnectionManager } = require('./sshConnectionManager');
const { createRemoteApprovalBridge } = require('./remoteApprovalBridge');
const { RemoteExecService } = require('./remoteExecService');
const { createRemoteFileTransferService } = require('./remoteFileTransferService');
const fsTransferSource = fs.readFileSync(require.resolve('./remoteFileTransferService'), 'utf-8');

const HOST = {
  alias: 'prod',
  host: 'prod.example.invalid',
  user: 'deploy',
  port: 22,
  identityFile: null,
  remoteWorkspace: null,
};

function withExecEnv(value, body) {
  const previous = process.env.KHY_REMOTE_SSH_ENABLE_EXEC;
  process.env.KHY_REMOTE_SSH_ENABLE_EXEC = value;
  return Promise.resolve()
    .then(body)
    .finally(() => {
      process.env.KHY_REMOTE_SSH_ENABLE_EXEC = previous;
    });
}

function makeHarness(opts = {}) {
  const connectionManager = createSshConnectionManager();
  const approvalBridge = createRemoteApprovalBridge();
  const calls = { uploads: [], executions: [], disconnects: [], events: [] };

  // Real risk planning (pure, no IO) so the plan under test is the shipped one.
  const realExec = new RemoteExecService({ connectionManager, approvalBridge });
  const execService = {
    planDryRun: (payload) => realExec.planDryRun(payload),
    requestExecution: async (payload) => {
      calls.executions.push(payload);
      if (opts.execThrows) {
        throw new Error('remote execution exploded');
      }
      const value = typeof opts.execResult === 'function' ? opts.execResult(payload) : opts.execResult;
      return value === undefined ? { status: 'completed' } : value;
    },
  };

  const fileTransferService = opts.realTransfer
    ? createRemoteFileTransferService({ connectionManager })
    : {
        upload: async (payload) => {
          calls.uploads.push(payload);
          if (opts.uploadThrows) {
            throw new Error('scp vanished');
          }
          const value = typeof opts.uploadResult === 'function' ? opts.uploadResult(payload) : opts.uploadResult;
          return value === undefined ? { ok: true, status: 'uploaded' } : value;
        },
      };

  const sshConfigService = {
    listHosts: () => ({
      configPath: Object.prototype.hasOwnProperty.call(opts, 'configPath') ? opts.configPath : path.join(SANDBOX, 'ssh_config'),
      hosts: Object.prototype.hasOwnProperty.call(opts, 'hosts') ? opts.hosts : [HOST],
    }),
  };

  const sshCredentialGuard = {
    validateHostCredentials: () =>
      opts.credential === undefined ? { ok: true, code: 'identity_file_valid' } : opts.credential,
  };

  const workspaceResolver = {
    resolveWorkspace: (request) => {
      calls.events.push({ kind: 'resolve_workspace', request });
      if (opts.workspaceThrows) {
        const error = new Error(opts.workspaceMessage || 'remote workspace is outside the allowlist');
        if (opts.workspaceCode) {
          error.code = opts.workspaceCode;
        }
        throw error;
      }
      return opts.workspaceDir === undefined ? '/srv/app' : opts.workspaceDir;
    },
  };

  const buildDockerBundle = (projectRoot) => {
    calls.events.push({ kind: 'build_bundle', projectRoot });
    if (Object.prototype.hasOwnProperty.call(opts, 'bundleThrows')) {
      throw opts.bundleThrows;
    }
    return Object.prototype.hasOwnProperty.call(opts, 'bundle')
      ? opts.bundle
      : { archivePath: path.join(SANDBOX, 'bundle.tar.gz'), bundleName: 'bundle' };
  };

  const orchestrator = createDeployOrchestrator({
    connectionManager,
    approvalBridge,
    execService,
    fileTransferService,
    sshConfigService,
    sshCredentialGuard,
    workspaceResolver,
    buildDockerBundle,
  });

  const realDisconnect = connectionManager.disconnect.bind(connectionManager);
  connectionManager.disconnect = (connectionId) => {
    calls.disconnects.push(connectionId);
    return realDisconnect(connectionId);
  };

  return { orchestrator, connectionManager, approvalBridge, calls, realExec };
}

async function plannedTicket(harness, params = {}) {
  const dry = await harness.orchestrator.deploy({ hostAlias: 'prod', ...params });
  assert.strictEqual(dry.status, 'awaiting_approval', `dry run failed: ${JSON.stringify(dry)}`);
  harness.approvalBridge.approveTicket(dry.ticketId, 'reviewer');
  return dry;
}

test('the module exports the class and one factory', () => {
  assert.deepStrictEqual(Object.keys(mod), ['DeployOrchestrator', 'createDeployOrchestrator']);
  const made = createDeployOrchestrator({});
  assert.ok(made instanceof DeployOrchestrator);
  assert.strictEqual(made._pendingDeploys.size, 0);
});

test('dry-run plans the shipped three-step pipeline and forces an approval ticket', async () => {
  const { orchestrator, approvalBridge, connectionManager, calls } = makeHarness();
  const events = [];
  const result = await orchestrator.deploy({ hostAlias: ' prod ', traceId: 'tr-deploy', onEvent: (e) => events.push(e) });

  assert.deepStrictEqual(Object.keys(result), [
    'success', 'mode', 'status', 'hostAlias', 'archivePath', 'bundleName', 'deployDir',
    'remoteTarPath', 'plannedCommands', 'risk', 'ticketId', 'connectionId', 'execEnabled', 'hint',
  ]);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.mode, 'dry-run');
  assert.strictEqual(result.status, 'awaiting_approval');
  assert.strictEqual(result.hostAlias, 'prod', 'the alias is trimmed before lookup');
  assert.strictEqual(result.execEnabled, false);
  assert.strictEqual(result.remoteTarPath, 'bundle.tar.gz');
  assert.deepStrictEqual(result.plannedCommands, [
    "mkdir -p '/srv/app'",
    "tar -xzf 'bundle.tar.gz' -C '/srv/app'",
    "cd '/srv/app/bundle' && docker compose up -d --build",
  ]);
  assert.deepStrictEqual(result.risk, {
    highest_risk: 'moderate',
    reason: 'Command changes dependency/runtime state and should be reviewed.',
    approval_required: false,
  });

  // The forced-approval contract: `docker compose up` is only moderate, so the exec
  // service would run it unapproved; the orchestrator still gates apply on a ticket.
  const ticket = approvalBridge.getTicket(result.ticketId);
  assert.strictEqual(ticket.status, 'pending');
  assert.strictEqual(ticket.risk_level, 'moderate');
  assert.strictEqual(ticket.idempotency_key, 'deploy-bundle');
  assert.strictEqual(ticket.host_alias, 'prod');
  assert.strictEqual(ticket.trace_id, 'tr-deploy');
  assert.strictEqual(ticket.commands.length, 3);

  const session = connectionManager.getSession(result.connectionId);
  assert.strictEqual(session.remoteWorkspace, '~', 'the session opens at home so `cd` succeeds');
  assert.strictEqual(session.purpose, 'deploy');
  assert.strictEqual(session.hostAlias, 'prod');

  assert.deepStrictEqual(events, [{ kind: 'deploy_planned', host_alias: 'prod', ticket_id: result.ticketId }]);
  assert.strictEqual(calls.uploads.length, 0);
  assert.strictEqual(calls.executions.length, 0);
  assert.ok(result.hint.includes(result.ticketId));
  assert.ok(result.hint.includes('KHY_REMOTE_SSH_ENABLE_EXEC=true'), 'the hint states the missing gate');
  assert.strictEqual(orchestrator._pendingDeploys.get(result.ticketId).idempotencyKey, 'deploy-bundle');
});

test('a throwing onEvent callback does not fail the plan', async () => {
  const { orchestrator } = makeHarness();
  const result = await orchestrator.deploy({
    hostAlias: 'prod',
    onEvent: () => {
      throw new Error('subscriber died');
    },
  });
  assert.strictEqual(result.status, 'awaiting_approval');
});

test('a deploy directory with a quote is single-quoted, not interpolated raw', async () => {
  const { orchestrator } = makeHarness({ workspaceDir: "/srv/ap p's" });
  const result = await orchestrator.deploy({ hostAlias: 'prod' });
  assert.deepStrictEqual(result.plannedCommands[0], `mkdir -p '/srv/ap p'\\''s'`);
  assert.ok(!result.plannedCommands.some((c) => c.includes("/srv/ap p's ")), 'no unquoted path leaks');
});

test('dry-run stops at the first failing stage and reports execEnabled', async () => {
  const missingHost = makeHarness({ hosts: [] });
  const noHost = await missingHost.orchestrator.deploy({ hostAlias: 'prod' });
  assert.strictEqual(noHost.status, 'host_not_found');
  assert.strictEqual(noHost.mode, 'dry-run');
  assert.strictEqual(noHost.success, false);
  assert.strictEqual(noHost.execEnabled, false);
  assert.ok(noHost.error.includes('No host alias "prod" found in SSH config'));
  assert.strictEqual(missingHost.connectionManager.listSessions().length, 0, 'no session before the host check');
  assert.strictEqual(missingHost.approvalBridge.listTickets().length, 0, 'no ticket before the host check');

  // The fallback in the message is a literal, not a path read from the service.
  const noConfigPath = makeHarness({ hosts: [], configPath: null });
  const fallbackText = await noConfigPath.orchestrator.deploy({ hostAlias: 'ghost' });
  assert.ok(fallbackText.error.endsWith('(~/.ssh/config).'), fallbackText.error);

  const badCred = makeHarness({
    credential: { ok: false, code: 'identity_file_permissions', message: 'key is world readable' },
  });
  const cred = await badCred.orchestrator.deploy({ hostAlias: 'prod' });
  assert.strictEqual(cred.status, 'credential_invalid');
  assert.strictEqual(cred.code, 'identity_file_permissions');
  assert.strictEqual(cred.error, 'key is world readable');
  assert.strictEqual(badCred.connectionManager.listSessions().length, 0);

  const rejected = makeHarness({ workspaceThrows: true, workspaceCode: 'workspace_not_allowed' });
  const ws = await rejected.orchestrator.deploy({ hostAlias: 'prod', remoteWorkspace: '/etc' });
  assert.strictEqual(ws.status, 'workspace_rejected');
  assert.strictEqual(ws.code, 'workspace_not_allowed');
  assert.strictEqual(ws.error, 'remote workspace is outside the allowlist');

  const rejectedNoCode = makeHarness({ workspaceThrows: true });
  assert.strictEqual((await rejectedNoCode.orchestrator.deploy({ hostAlias: 'prod' })).code, 'workspace_rejected');

  const bundleBad = makeHarness({ bundleThrows: new Error('docker build exploded') });
  const bad = await bundleBad.orchestrator.deploy({ hostAlias: 'prod' });
  assert.strictEqual(bad.status, 'bundle_failed');
  assert.strictEqual(bad.error, 'docker build exploded');
  assert.strictEqual(bad.execEnabled, false);

  const bundleStringThrow = makeHarness({ bundleThrows: 'boom' });
  assert.strictEqual((await bundleStringThrow.orchestrator.deploy({ hostAlias: 'prod' })).error, 'boom');
});

test('host_alias_required is returned before any dependency is touched', async () => {
  const { orchestrator, calls } = makeHarness();
  assert.deepStrictEqual(await orchestrator.deploy(), {
    success: false,
    mode: 'dry-run',
    status: 'host_alias_required',
    error: 'A target host alias is required.',
  });
  const blank = await orchestrator.deploy({ hostAlias: '   ', confirm: true, approvalTicketId: 't-1' });
  assert.strictEqual(blank.status, 'host_alias_required');
  assert.strictEqual(calls.events.length, 0, 'no host resolution, no bundle build');
});

// B31-R7b (registered, NOT fixed): `deploy()` routes to `_apply` only on the strict
// test `params.confirm === true` (:92), but the `host_alias_required` early return
// labels itself with the loose ternary `params.confirm ? 'apply' : 'dry-run'` (:87).
// So a truthy-but-not-true `confirm` (a query string 'yes', a 1, an object) reports
// `mode:'apply'` while the code only ever ran the read-only path, and the same value
// on a valid host silently plans instead of deploying.
test('B31-R7b the mode label uses truthiness while the gate uses === true', async () => {
  const { orchestrator } = makeHarness();
  const mislabelled = await orchestrator.deploy({ hostAlias: '', confirm: 'yes' });
  assert.strictEqual(mislabelled.mode, 'apply');
  assert.strictEqual(mislabelled.status, 'host_alias_required');

  const silentlyPlanned = await orchestrator.deploy({ hostAlias: 'prod', confirm: 'yes' });
  assert.strictEqual(silentlyPlanned.mode, 'dry-run');
  assert.strictEqual(silentlyPlanned.status, 'awaiting_approval', 'a truthy confirm never applies');

  const one = await orchestrator.deploy({ hostAlias: 'prod', confirm: 1 });
  assert.strictEqual(one.status, 'awaiting_approval');
});

// B31-R7c (registered, NOT fixed): every injected return value is consumed without
// validation. The bundle destructure (:171) throws a raw TypeError when the builder
// returns nothing, and a resolver that answers `''` or null is accepted and stringified
// straight into the remote command (`mkdir -p ''`, or a real directory named `null`).
test('B31-R7c dependency return values are trusted, and failures leak as TypeErrors', async () => {
  const emptyBundle = makeHarness({ bundle: undefined });
  await assert.rejects(
    () => emptyBundle.orchestrator.deploy({ hostAlias: 'prod' }),
    (error) => error instanceof TypeError,
    'a builder that returns nothing crashes the pipeline instead of reporting bundle_failed'
  );

  const noDeps = createDeployOrchestrator();
  await assert.rejects(
    () => noDeps.deploy({ hostAlias: 'prod' }),
    (error) => error instanceof TypeError && error.message.includes('listHosts'),
    'constructor deps are never validated'
  );

  const nullWorkspace = makeHarness({ workspaceDir: null });
  const result = await nullWorkspace.orchestrator.deploy({ hostAlias: 'prod' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.deployDir, null);
  assert.deepStrictEqual(result.plannedCommands, [
    "mkdir -p 'null'",
    "tar -xzf 'bundle.tar.gz' -C 'null'",
    "cd 'null/bundle' && docker compose up -d --build",
  ], 'a null deploy dir becomes the literal remote directory named "null"');

  const emptyWorkspace = makeHarness({ workspaceDir: '' });
  const empty = await emptyWorkspace.orchestrator.deploy({ hostAlias: 'prod' });
  assert.strictEqual(empty.success, true);
  assert.deepStrictEqual(empty.plannedCommands, [
    "mkdir -p ''",
    "tar -xzf 'bundle.tar.gz' -C ''",
    "cd '/bundle' && docker compose up -d --build",
  ]);
});

// B31-R9 (registered, NOT fixed): `bundleName` is read off the builder result (:171)
// and then used to form both the remote path and the idempotency key (:185). A bundle
// without a name collapses every distinct artifact onto `deploy-undefined` /
// `undefined.tar.gz`, so two different broken builds claim the same idempotency key
// and, once one is applied, the transfer/exec replay caches answer for the other.
test('B31-R9 a bundle without a name collapses onto the deploy-undefined key', async () => {
  const { orchestrator, approvalBridge } = makeHarness({
    bundle: { archivePath: path.join(SANDBOX, 'first.tar.gz') },
  });
  const first = await orchestrator.deploy({ hostAlias: 'prod' });
  assert.strictEqual(first.bundleName, undefined);
  assert.strictEqual(first.remoteTarPath, 'undefined.tar.gz');
  assert.strictEqual(first.plannedCommands[1], "tar -xzf 'undefined.tar.gz' -C '/srv/app'");
  assert.strictEqual(approvalBridge.getTicket(first.ticketId).idempotency_key, 'deploy-undefined');

  const second = await orchestrator.deploy({ hostAlias: 'prod' });
  assert.notStrictEqual(second.ticketId, first.ticketId);
  assert.strictEqual(
    approvalBridge.getTicket(second.ticketId).idempotency_key,
    approvalBridge.getTicket(first.ticketId).idempotency_key,
    'two distinct artifacts share one idempotency key'
  );
});

test('apply refuses for every reason the ticket is not usable, and never spends it', async () => {
  const h = makeHarness();
  const noTicket = await h.orchestrator.deploy({ hostAlias: 'prod', confirm: true });
  assert.strictEqual(noTicket.status, 'approval_ticket_required');
  assert.strictEqual(noTicket.mode, 'apply');
  assert.strictEqual(noTicket.error, 'confirm:true requires an approvalTicketId from a prior dry-run.');

  const unknown = await h.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: ' t-unknown ' });
  assert.strictEqual(unknown.status, 'unknown_deploy_ticket');
  assert.strictEqual(unknown.error, 'No pending deploy for this ticket; run a dry-run first (deploy without confirm).');

  const dry = await h.orchestrator.deploy({ hostAlias: 'prod' });
  const pending = await h.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dry.ticketId });
  assert.strictEqual(pending.status, 'ticket_not_approved');
  assert.strictEqual(pending.error, 'Approval ticket status is "pending"; it must be approved before applying.');

  const rejected = h.approvalBridge.rejectTicket(dry.ticketId, 'ops', 'not today');
  assert.strictEqual(rejected.status, 'rejected');
  const afterReject = await h.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dry.ticketId });
  assert.strictEqual(afterReject.status, 'ticket_not_approved');
  assert.strictEqual(afterReject.ticketId, dry.ticketId);

  // Gate stays in front of consumption, exactly as the comment at :287 promises.
  h.approvalBridge.approveTicket(dry.ticketId, 'ops-again');
  const disabled = await h.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dry.ticketId });
  assert.strictEqual(disabled.status, 'execution_disabled');
  assert.strictEqual(disabled.hostAlias, 'prod');
  assert.ok(disabled.error.includes('KHY_REMOTE_SSH_ENABLE_EXEC=true'));
  assert.strictEqual(h.approvalBridge.getTicket(dry.ticketId).consumed_at, null);

  // A ticket the bridge no longer knows about (expired import, clearAll) is a distinct code.
  h.approvalBridge.clearAll();
  const gone = await h.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dry.ticketId });
  assert.strictEqual(gone.status, 'ticket_not_found');
  assert.strictEqual(gone.error, 'Approval ticket not found or expired.');
  assert.strictEqual(h.calls.uploads.length, 0, 'no stage ran');
  assert.strictEqual(h.calls.executions.length, 0);
});

test('apply consumes the ticket and forwards the plan to upload then exec', async () => {
  const h = makeHarness();
  const dry = await plannedTicket(h);
  const onEvent = () => {};
  const applied = await withExecEnv('true', () =>
    h.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dry.ticketId, traceId: 'tr-9', onEvent })
  );

  assert.strictEqual(applied.success, true);
  assert.strictEqual(applied.status, 'completed');
  assert.strictEqual(applied.mode, 'apply');
  assert.strictEqual(applied.execEnabled, true);
  assert.strictEqual(applied.hostAlias, 'prod');
  assert.strictEqual(applied.deployDir, '/srv/app');
  assert.strictEqual(applied.bundleName, 'bundle');
  assert.deepStrictEqual(applied.execResult, { status: 'completed' });
  assert.strictEqual(applied.uploaded.ok, true);

  assert.strictEqual(h.calls.uploads.length, 1);
  assert.deepStrictEqual(h.calls.uploads[0], {
    connectionId: dry.connectionId,
    localPath: path.join(SANDBOX, 'bundle.tar.gz'),
    remotePath: 'bundle.tar.gz',
    idempotencyKey: 'deploy-bundle:scp',
    traceId: 'tr-9',
    onEvent,
  });
  assert.strictEqual(h.calls.executions.length, 1);
  assert.strictEqual(h.calls.executions[0].approvalTicketId, dry.ticketId);
  assert.strictEqual(h.calls.executions[0].idempotencyKey, 'deploy-bundle');
  assert.deepStrictEqual(h.calls.executions[0].commands, dry.plannedCommands);
  assert.deepStrictEqual(h.calls.executions[0].riskContext, { kind: 'deploy', host_alias: 'prod' });
  assert.strictEqual(h.calls.executions[0].onEvent, onEvent);

  const ticket = h.approvalBridge.getTicket(dry.ticketId);
  assert.strictEqual(ticket.consumed_at !== null, true);
  assert.strictEqual(ticket.consumed_by_idempotency_key, 'deploy-bundle');
  assert.strictEqual(h.orchestrator._pendingDeploys.size, 0, 'a finished deploy leaves no state');
  assert.strictEqual(process.env.KHY_REMOTE_SSH_ENABLE_EXEC, 'false', 'the gate is restored');
});

// B31-R7 (registered, NOT fixed): apply consumes the approval BEFORE the upload
// (:303 then :317) and only deletes the pending entry after the exec stage (:349).
// So one failed scp burns the human approval *and* keeps the plan: the entry stays in
// `_pendingDeploys` forever and every retry is refused with `ticket_already_consumed`.
// The ticket the reviewer approved can never be used again, and the plan it points at
// is still queued.
test('B31-R7 a failed upload burns the approval and wedges the pending plan', async () => {
  const h = makeHarness({
    uploadResult: { ok: false, status: 'upload_failed', error: 'scp exited 1: permission denied' },
  });
  const dry = await plannedTicket(h);
  const first = await withExecEnv('true', () =>
    h.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dry.ticketId })
  );
  assert.strictEqual(first.success, false);
  assert.strictEqual(first.status, 'upload_failed');
  assert.strictEqual(first.mode, 'apply');
  assert.strictEqual(first.error, 'scp exited 1: permission denied');
  assert.strictEqual(first.hostAlias, 'prod');
  assert.strictEqual(first.execEnabled, true);
  assert.strictEqual(h.calls.executions.length, 0, 'the remote run never started');

  assert.strictEqual(h.orchestrator._pendingDeploys.has(dry.ticketId), true, 'the plan is still queued');
  assert.strictEqual(h.orchestrator._pendingDeploys.size, 1);
  assert.strictEqual(h.approvalBridge.getTicket(dry.ticketId).consumed_at !== null, true);

  const retry = await withExecEnv('true', () =>
    h.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dry.ticketId })
  );
  assert.strictEqual(retry.status, 'approval_consume_failed');
  assert.strictEqual(retry.code, 'ticket_already_consumed');
  assert.strictEqual(retry.error, 'approval ticket has already been consumed.');

  const third = await withExecEnv('true', () =>
    h.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dry.ticketId })
  );
  assert.strictEqual(third.status, 'approval_consume_failed', 'the deadlock is permanent');
  assert.strictEqual(h.orchestrator._pendingDeploys.size, 1, 'and the entry never leaves');
});

test('apply reports upload shape surprises as upload_failed', async () => {
  const nullish = makeHarness({ uploadResult: null });
  const dryNull = await plannedTicket(nullish);
  const asNull = await withExecEnv('true', () =>
    nullish.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dryNull.ticketId })
  );
  assert.strictEqual(asNull.status, 'upload_failed');
  assert.strictEqual(asNull.uploaded, null);
  assert.strictEqual(asNull.error, 'Bundle upload failed.');

  const keepStatus = makeHarness({ uploadResult: { ok: false, status: 'upload_error', message: 'idle timeout' } });
  const dryKeep = await plannedTicket(keepStatus);
  const asError = await withExecEnv('true', () =>
    keepStatus.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dryKeep.ticketId })
  );
  assert.strictEqual(asError.status, 'upload_error', "the transfer service's own status wins");
  assert.strictEqual(asError.error, 'idle timeout');
  assert.deepStrictEqual(asError.uploaded, { ok: false, status: 'upload_error', message: 'idle timeout' });

  const okButFalsey = makeHarness({ uploadResult: { ok: true } });
  const dryOk = await plannedTicket(okButFalsey);
  const applied = await withExecEnv('true', () =>
    okButFalsey.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dryOk.ticketId })
  );
  assert.strictEqual(applied.success, true);
});

test('a rejected approval or a throwing stage surfaces instead of a structured result', async () => {
  const consumedExternally = makeHarness();
  const dry = await plannedTicket(consumedExternally);
  const consume = consumedExternally.approvalBridge.consumeApprovedTicket(dry.ticketId, 'deploy-bundle');
  assert.strictEqual(consume.ok, true, 'someone else spent the ticket first');
  const applied = await withExecEnv('true', () =>
    consumedExternally.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dry.ticketId })
  );
  assert.strictEqual(applied.status, 'approval_consume_failed');
  assert.strictEqual(applied.code, 'ticket_already_consumed');

  const mismatch = makeHarness();
  const dryKey = await plannedTicket(mismatch);
  mismatch.approvalBridge.clearAll();
  const repinned = mismatch.approvalBridge.createTicket({
    connectionId: dryKey.connectionId,
    hostAlias: 'prod',
    commands: mismatch.orchestrator._pendingDeploys.get(dryKey.ticketId).commands,
    idempotencyKey: 'a-different-key',
  });
  mismatch.approvalBridge.approveTicket(repinned.ticket_id);
  const rejectedByKey = await withExecEnv('true', () =>
    mismatch.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dryKey.ticketId })
  );
  assert.strictEqual(rejectedByKey.status, 'ticket_not_found', 'the pending plan outlives the ticket it points at');
  assert.strictEqual(
    mismatch.approvalBridge.consumeApprovedTicket(repinned.ticket_id, 'deploy-bundle').code,
    'idempotency_key_mismatch'
  );

  const throwingUpload = makeHarness({ uploadThrows: true });
  const dryThrow = await plannedTicket(throwingUpload);
  await assert.rejects(
    () => withExecEnv('true', () =>
      throwingUpload.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dryThrow.ticketId })
    ),
    /scp vanished/,
    'a dependency that throws escapes the pipeline; the approval is already consumed'
  );
  assert.strictEqual(throwingUpload.orchestrator._pendingDeploys.has(dryThrow.ticketId), true);
});

test('a failed remote run still drops the plan, so no retry is possible', async () => {
  const h = makeHarness({ execResult: { status: 'failed', summary: { failed_steps: 1 } } });
  const dry = await plannedTicket(h);
  const applied = await withExecEnv('true', () =>
    h.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dry.ticketId })
  );
  assert.strictEqual(applied.success, false);
  assert.strictEqual(applied.status, 'failed');
  assert.strictEqual(applied.uploaded.ok, true, 'the bundle did ship');
  assert.strictEqual(h.orchestrator._pendingDeploys.size, 0, 'and the plan is gone');
  const retry = await withExecEnv('true', () =>
    h.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dry.ticketId })
  );
  assert.strictEqual(retry.status, 'unknown_deploy_ticket');

  const emptyExec = makeHarness({ execResult: {} });
  const dryEmpty = await plannedTicket(emptyExec);
  const noStatus = await withExecEnv('true', () =>
    emptyExec.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dryEmpty.ticketId })
  );
  assert.strictEqual(noStatus.status, undefined);
  assert.strictEqual(noStatus.success, false);
});

test('an exec result that is absent reports execution_error', async () => {
  const { orchestrator, approvalBridge } = makeHarness({ execResult: null });
  const dry = await orchestrator.deploy({ hostAlias: 'prod' });
  approvalBridge.approveTicket(dry.ticketId);
  const applied = await withExecEnv('true', () =>
    orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dry.ticketId })
  );
  assert.strictEqual(applied.status, 'execution_error');
  assert.strictEqual(applied.success, false);
  assert.strictEqual(applied.execResult, null);
});

// B31-R8 (registered, NOT fixed): `_dryRun` opens a session on every call (:177) and
// neither `_dryRun` nor `_apply` ever closes it, so the connection manager accumulates
// one `status:'connected'` record per planned deploy (see B31-R6c: the map is unbounded
// and nothing probes the host). Abandoned dry-runs also leave pending tickets behind.
test('B31-R8 every dry-run leaks a connected session and nothing disconnects', async () => {
  const h = makeHarness();
  const connectionIds = [];
  const tickets = [];
  for (let i = 0; i < 3; i += 1) {
    const dry = await h.orchestrator.deploy({ hostAlias: 'prod' });
    connectionIds.push(dry.connectionId);
    tickets.push(dry.ticketId);
  }
  assert.strictEqual(new Set(connectionIds).size, 3, 'each plan gets a brand new session');
  assert.strictEqual(h.connectionManager.listSessions().length, 3);
  assert.deepStrictEqual(h.connectionManager.listSessions().map((s) => s.status), ['connected', 'connected', 'connected']);
  assert.strictEqual(h.approvalBridge.listPendingTickets().length, 3, 'and a ticket each, none decided');

  // Even a fully successful apply leaves all three sessions registered.
  h.approvalBridge.approveTicket(tickets[0], 'reviewer');
  const applied = await withExecEnv('true', () =>
    h.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: tickets[0] })
  );
  assert.strictEqual(applied.success, true);
  assert.strictEqual(h.calls.disconnects.length, 0, 'the orchestrator never calls disconnect()');
  assert.strictEqual(h.connectionManager.listSessions().length, 3);
  assert.strictEqual(h.connectionManager.getSession(connectionIds[2]).status, 'connected');
  assert.strictEqual(h.approvalBridge.listPendingTickets().length, 2, 'the two abandoned plans stay pending');
});

test('projectRoot and remoteWorkspace are forwarded to the injected stages', async () => {
  const h = makeHarness();
  const dry = await h.orchestrator.deploy({
    hostAlias: 'prod',
    projectRoot: path.join(SANDBOX, 'project'),
    remoteWorkspace: '/srv/app',
  });
  assert.strictEqual(dry.status, 'awaiting_approval');
  const build = h.calls.events.find((e) => e.kind === 'build_bundle');
  assert.strictEqual(build.projectRoot, path.join(SANDBOX, 'project'));
  const resolve = h.calls.events.find((e) => e.kind === 'resolve_workspace');
  assert.deepStrictEqual(resolve.request, {
    requestedWorkspace: '/srv/app',
    hostEntry: { ...HOST },
  });
});

test('apply with the real transfer service reaches spawn: only the env gate is in front', async () => {
  const h = makeHarness({ realTransfer: true });
  const dry = await plannedTicket(h);
  await assert.rejects(
    () => withExecEnv('true', () =>
      h.orchestrator.deploy({ hostAlias: 'prod', confirm: true, approvalTicketId: dry.ticketId })
    ),
    /test isolation: spawn\(scp\)/,
    'with KHY_REMOTE_SSH_ENABLE_EXEC=true the pipeline would exec a real scp'
  );
  assert.strictEqual(spawnAttempts, 1, 'the tripwire caught exactly one attempt');
  assert.strictEqual(h.approvalBridge.getTicket(dry.ticketId).consumed_at !== null, true, 'and it was already burned');
  spawnAttempts = 0;
});

test('nothing in this file spawned a process or opened a socket', () => {
  assert.strictEqual(spawnAttempts, 0);
  assert.strictEqual(fs.existsSync(path.join(SANDBOX, 'ssh_config')), false);
  assert.strictEqual(fs.existsSync(path.join(SANDBOX, '.ssh')), false, 'the real ~/.ssh tree is never touched');
  assert.deepStrictEqual(Object.keys(require('./deployOrchestrator')), ['DeployOrchestrator', 'createDeployOrchestrator']);
  // Why the tripwire has to be installed before the requires: the scp module binds
  // `spawn` once, at load (remoteFileTransferService.js:20), so a later patch of
  // child_process.spawn would silently miss it.
  assert.ok(
    /const \{ spawn \} = require\('child_process'\);/.test(fsTransferSource),
    'remoteFileTransferService binds spawn at require time'
  );
});
