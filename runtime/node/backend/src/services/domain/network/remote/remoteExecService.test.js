'use strict';

// Co-located unit test for remoteExecService.js.
//
// HARD ISOLATION CONTRACT: this module calls spawn('ssh', ...) directly
// (remoteExecService.js:195) with no injection seam — see B31-R17. Every case
// below therefore stops at the KHY_REMOTE_SSH_ENABLE_EXEC gate, which stays
// 'false' for the whole file, so no child process and no socket is ever created.

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

// Tripwire: if any future edit lets a case reach the spawn call, fail loudly
// instead of dialling a host. It is installed BEFORE the module is required because
// remoteExecService.js:3 binds `spawn` once at load time; a later patch of
// child_process.spawn would silently miss it. Restored at the end of the file.
const REAL_SPAWN = cp.spawn;
let spawnAttempts = 0;
cp.spawn = function guardedSpawn(...args) {
  spawnAttempts += 1;
  throw new Error(`test isolation: spawn(${String(args[0])}) is not allowed here`);
};
after(() => { cp.spawn = REAL_SPAWN; });

const mod = require('./remoteExecService');
const { RemoteExecService } = mod;
const { createRemoteApprovalBridge } = require('./remoteApprovalBridge');

const SESSION = {
  connectionId: 'c-1',
  hostAlias: 'prod.example.invalid',
  remoteUser: 'deploy',
  remoteWorkspace: '/srv/app',
  traceId: 'tr-1',
};

function harness(overrides = {}) {
  const sessions = new Map(overrides.sessions === null ? [] : [[SESSION.connectionId, SESSION]]);
  const touches = [];
  const connectionManager = {
    getSession: (id) => (sessions.get(id) ? { ...sessions.get(id) } : null),
    touch: (id) => { touches.push(id); return sessions.has(id); },
    listSessions: () => [...sessions.values()],
    clearAll: () => sessions.clear(),
  };
  const approvalBridge = createRemoteApprovalBridge();
  const svc = new RemoteExecService({ connectionManager, approvalBridge });
  return { svc, approvalBridge, connectionManager, touches, sessions };
}

test('the module exports only the class - no factory, no seam', () => {
  assert.deepStrictEqual(Object.keys(mod), ['RemoteExecService']);
  const proto = Object.getOwnPropertyNames(RemoteExecService.prototype);
  for (const injected of ['spawn', 'execFile', 'runCommand', 'transport']) {
    assert.ok(!proto.includes(injected), `${injected} would be a seam; there is none`);
  }
});

test('constructing without a connection manager does not fail until it is used', () => {
  assert.throws(() => new RemoteExecService(), TypeError);
  const bare = new RemoteExecService({});
  assert.throws(() => bare.planDryRun({ connectionId: 'c-1', commands: ['ls'] }), TypeError);
});

test('planDryRun reports risk without executing anything', () => {
  const { svc } = harness();
  const plan = svc.planDryRun({
    connectionId: 'c-1',
    commands: ['ls -la', 'git push origin main'],
    traceId: 'tr-9',
    riskContext: { kind: 'deploy' },
  });
  assert.strictEqual(plan.status, 'dry_run');
  assert.strictEqual(plan.dry_run, true);
  assert.strictEqual(plan.trace_id, 'tr-9');
  assert.strictEqual(plan.connection_id, 'c-1');
  assert.strictEqual(plan.host_alias, 'prod.example.invalid');
  assert.strictEqual(plan.remote_workspace, '/srv/app');
  assert.strictEqual(plan.risk_summary.highest_risk, 'dangerous');
  assert.strictEqual(plan.risk_summary.approval_required, true);
  assert.deepStrictEqual(plan.steps.map((s) => s.step), [1, 2]);
  assert.ok(plan.steps.every((s) => s.will_execute === false));
  assert.deepStrictEqual(plan.risk_context, { kind: 'deploy' });
  assert.strictEqual(plan.redaction_applied, true);
  assert.strictEqual(spawnAttempts, 0);
});

test('an unknown connection id throws a coded error', () => {
  const { svc } = harness();
  try {
    svc.planDryRun({ connectionId: 'nope', commands: ['ls'] });
    assert.fail('expected a throw');
  } catch (error) {
    assert.strictEqual(error.code, 'session_not_found');
    assert.match(error.message, /connection_id=nope/);
  }
});

// B31-R18 (registered, NOT fixed): _normalizeCommands (:114) does
// `String(command || '').trim()` and only then `filter(Boolean)`. Stringification
// happens BEFORE the filter, so anything that stringifies to a non-empty word
// survives as a "command": {} -> '[object Object]', ['a','b'] -> 'a,b', 42 -> '42'
// (measured below via planDryRun, which is the same normalisation the executing
// path uses at :431). Those strings are later interpolated into
// `cd '<ws>' && <command>` and handed to `bash -lc` on the remote host
// (:147-162) - a type error in the request body becomes a shell word, and the
// risk classifier never sees the object it could have rejected.
test('B31-R18 String-before-filter turns junk into shell words', () => {
  const { svc } = harness();
  const plan = svc.planDryRun({
    connectionId: 'c-1',
    commands: [null, undefined, '', '   ', {}, ['a', 'b'], 42, true],
  });
  const got = plan.steps.map((s) => s.command);
  assert.deepStrictEqual(got, ['[object Object]', 'a,b', '42', 'true']);
  assert.strictEqual(plan.risk_summary.highest_risk, 'safe');
});

test('a non-array command list normalises to nothing and is rejected', async () => {
  const { svc } = harness();
  for (const bad of [undefined, null, 'not-an-array', 42, {}]) {
    assert.deepStrictEqual(svc.planDryRun({ connectionId: 'c-1', commands: bad }).steps, []);
  }
  const res = await svc.requestExecution({ connectionId: 'c-1', commands: ['   '], idempotencyKey: 'k' });
  assert.strictEqual(res.status, 'invalid_commands');
});

test('requestExecution requires an idempotency key for any side effect', async () => {
  const { svc } = harness();
  const missing = await svc.requestExecution({ connectionId: 'c-1', commands: ['ls'] });
  assert.strictEqual(missing.status, 'idempotency_key_required');
  const emptyKey = await svc.requestExecution({ connectionId: 'c-1', commands: ['ls'], idempotencyKey: '' });
  assert.strictEqual(emptyKey.status, 'idempotency_key_required');
});

test('a safe command degrades to execution_disabled, and the event stream says so', async () => {
  const { svc, touches } = harness();
  const events = [];
  const res = await svc.requestExecution({
    connectionId: 'c-1', commands: ['ls -la'], idempotencyKey: 'k-safe', onEvent: (e) => events.push(e),
  });
  assert.strictEqual(res.status, 'execution_disabled');
  assert.strictEqual(res.dry_run, false);
  assert.strictEqual(res.idempotency_key, 'k-safe');
  assert.strictEqual(res.risk_summary.highest_risk, 'safe');
  assert.match(res.message, /KHY_REMOTE_SSH_ENABLE_EXEC/);
  assert.deepStrictEqual(events.map((e) => [e.kind, e.severity]), [['remote_exec_summary', 'wait']]);
  assert.strictEqual(events[0].connection_id, 'c-1');
  assert.strictEqual(touches.length, 0, 'a blocked execution must not refresh the session');
  assert.strictEqual(spawnAttempts, 0);
});

test('a dangerous command asks for approval instead of running', async () => {
  const { svc, approvalBridge } = harness();
  const kinds = [];
  const res = await svc.requestExecution({
    connectionId: 'c-1', commands: ['git push origin main'], idempotencyKey: 'k-ask', onEvent: (e) => kinds.push([e.kind, e.severity]),
  });
  assert.strictEqual(res.status, 'approval_required');
  assert.ok(res.approval_ticket.ticket_id);
  assert.strictEqual(res.approval_ticket.status, 'pending');
  assert.strictEqual(res.approval_ticket.risk_level, 'dangerous');
  assert.strictEqual(res.approval_ticket.connection_id, 'c-1');
  assert.deepStrictEqual(kinds, [['remote_approval_required', 'warn']]);
  assert.strictEqual(approvalBridge.listTickets().length, 1);
});

// B31-R19 (registered, NOT fixed): every call that needs approval mints a NEW
// ticket (remoteExecService.js:528) - there is no lookup for "already pending for
// this connection + idempotency_key". A client that retries on a lost response
// (the SSE/replay pattern in routes/remoteSsh.js) grows the ticket table one row
// per attempt; tickets are never TTL-pruned in memory (only importState drops
// expired rows, remoteApprovalBridge.js:271), and every row is persisted by
// index.js's force-persist on 'create_ticket'. Measured: three identical requests
// produce three pending tickets.
test('B31-R19 retries mint a fresh ticket every time', async () => {
  const { svc, approvalBridge } = harness();
  for (let i = 0; i < 3; i++) {
    const res = await svc.requestExecution({
      connectionId: 'c-1', commands: ['systemctl restart nginx'], idempotencyKey: 'idem-same',
    });
    assert.strictEqual(res.status, 'approval_required');
  }
  assert.strictEqual(approvalBridge.listTickets().length, 3);
  assert.strictEqual(approvalBridge.listPendingTickets().length, 3);
  const ids = new Set(approvalBridge.listTickets().map((t) => t.ticket_id));
  assert.strictEqual(ids.size, 3, 'no dedupe by idempotency_key');
});

test('idempotency replay and conflict are keyed on the payload hash', async () => {
  const { svc } = harness();
  svc._idempotentResults.set('c-1::k-replay', {
    createdAtMs: Date.now(),
    requestHash: require('node:crypto').createHash('sha256').update('c-1\n').update(JSON.stringify(['ls'])).digest('hex'),
    result: { status: 'completed', steps: [] },
  });
  const replay = await svc.requestExecution({ connectionId: 'c-1', commands: ['ls'], idempotencyKey: 'k-replay' });
  assert.strictEqual(replay.status, 'idempotent_replay');
  assert.strictEqual(replay.result.status, 'completed');
  const conflict = await svc.requestExecution({ connectionId: 'c-1', commands: ['pwd'], idempotencyKey: 'k-replay' });
  assert.strictEqual(conflict.status, 'idempotency_conflict');
  svc._idempotentResults.set('c-1::k-stale', { createdAtMs: Date.now() - 7 * 60 * 60 * 1000, requestHash: 'x', result: {} });
  const after = await svc.requestExecution({ connectionId: 'c-1', commands: ['ls'], idempotencyKey: 'k-stale' });
  assert.strictEqual(after.status, 'execution_disabled', 'a TTL-expired row is no longer replayed');
  assert.strictEqual(svc._idempotentResults.has('c-1::k-stale'), false);
});

test('a concurrent request on the same key is told to wait', async () => {
  const { svc } = harness();
  svc._idempotentRunning.set('c-1::k-busy', Promise.resolve());
  const kinds = [];
  const res = await svc.requestExecution({
    connectionId: 'c-1', commands: ['ls'], idempotencyKey: 'k-busy', onEvent: (e) => kinds.push(e.severity),
  });
  assert.strictEqual(res.status, 'idempotency_in_progress');
  assert.deepStrictEqual(kinds, ['wait']);
});

// B31-R20 (registered, NOT fixed): an approved ticket authorises the *payload it
// was never shown*. The approval gate (remoteExecService.js:513-542) checks only
// ticket status + ticket.connection_id + ticket.idempotency_key. It never compares
// ticket.commands against the commands being requested, and when the ticket has
// no idempotency_key (createTicket defaults it to null, remoteApprovalBridge.js:151)
// even the key check is skipped by the `&&` at :544. Measured below: a ticket
// approved for `git push origin main` clears the gate for `rm -rf /var/lib/docker`
// - the request comes back as execution_disabled (the env gate), NOT as
// approval_required, which is the proof that it passed the approval stage with a
// payload nobody approved. The same holds for a critical `dd if=/dev/...` write
// (see B31-R1: that one is not even classified as risky).
test('B31-R20 approval is bound to a ticket id, not to the command payload', async () => {
  const { svc, approvalBridge } = harness();
  const t = approvalBridge.createTicket({
    connectionId: 'c-1', commands: ['git push origin main'], idempotencyKey: 'idem-1',
  });
  approvalBridge.approveTicket(t.ticket_id, 'reviewer');
  const res = await svc.requestExecution({
    connectionId: 'c-1',
    commands: ['rm -rf /var/lib/docker'],
    idempotencyKey: 'idem-1',
    approvalTicketId: t.ticket_id,
  });
  assert.notStrictEqual(res.status, 'approval_required');
  assert.strictEqual(res.status, 'execution_disabled');
  assert.strictEqual(res.risk_summary.highest_risk, 'critical');
  assert.deepStrictEqual(t.commands.map((c) => c.command), ['git push origin main']);

  const keyless = approvalBridge.createTicket({ connectionId: 'c-1', commands: ['git push'] });
  approvalBridge.approveTicket(keyless.ticket_id, 'reviewer');
  const anyKey = await svc.requestExecution({
    connectionId: 'c-1', commands: ['chmod -R 777 /'], idempotencyKey: 'whatever-the-caller-picks',
    approvalTicketId: keyless.ticket_id,
  });
  assert.strictEqual(anyKey.status, 'execution_disabled', 'a ticket without an idempotency key matches any key');
});

test('the ticket checks that do fail: wrong connection, other key, consumed, unknown', async () => {
  const { svc, approvalBridge } = harness();
  const t = approvalBridge.createTicket({ connectionId: 'c-1', commands: ['git push'], idempotencyKey: 'idem-a' });
  approvalBridge.approveTicket(t.ticket_id);
  const mismatch = await svc.requestExecution({
    connectionId: 'c-1', commands: ['git push'], idempotencyKey: 'idem-b', approvalTicketId: t.ticket_id,
  });
  assert.strictEqual(mismatch.status, 'approval_idempotency_mismatch');
  approvalBridge.consumeApprovedTicket(t.ticket_id, 'idem-a');
  const consumed = await svc.requestExecution({
    connectionId: 'c-1', commands: ['git push'], idempotencyKey: 'idem-a', approvalTicketId: t.ticket_id,
  });
  assert.strictEqual(consumed.status, 'approval_ticket_consumed');
  const unknown = await svc.requestExecution({
    connectionId: 'c-1', commands: ['git push'], idempotencyKey: 'idem-a', approvalTicketId: 'ghost',
  });
  assert.strictEqual(unknown.status, 'approval_required', 'an unknown ticket id falls back to "ask for approval"');
  const otherHost = await svc.requestExecution({
    connectionId: 'c-1', commands: ['git push'], idempotencyKey: 'idem-a', approvalTicketId: approvalBridge
      .createTicket({ connectionId: 'c-2', commands: ['git push'], idempotencyKey: 'idem-a' }).ticket_id,
  });
  assert.strictEqual(otherHost.status, 'approval_required', 'a ticket minted for another connection cannot authorise this one');
});

test('an onEvent callback that throws cannot break the execution path', async () => {
  const { svc } = harness();
  const res = await svc.requestExecution({
    connectionId: 'c-1',
    commands: ['ls'],
    idempotencyKey: 'k-throw',
    onEvent: () => { throw new Error('subscriber exploded'); },
  });
  assert.strictEqual(res.status, 'execution_disabled');
  const nonFn = await svc.requestExecution({
    connectionId: 'c-1', commands: ['ls'], idempotencyKey: 'k-nofn', onEvent: 'not-a-function',
  });
  assert.strictEqual(nonFn.status, 'execution_disabled');
});

test('the idle/connect timeouts are read per call and fall back on junk', () => {
  const src = fs.readFileSync(path.join(__dirname, 'remoteExecService.js'), 'utf-8');
  assert.match(src, /KHY_REMOTE_SSH_IDLE_TIMEOUT_MS/);
  assert.match(src, /KHY_REMOTE_SSH_CONNECT_TIMEOUT_SEC/);
  // Both readers are module-internal and only feed _runSingleRemoteCommand, which
  // is reachable only through the pre-load spawn stub (B31-R17), so the documented
  // defaults are pinned by text:
  // a silent change of a constant has to touch this line on purpose.
  assert.match(src, /DEFAULT_IDLE_TIMEOUT_MS = 60_000/);
  assert.match(src, /DEFAULT_CONNECT_TIMEOUT_SEC = 8/);
  process.env.KHY_REMOTE_SSH_IDLE_TIMEOUT_MS = '0';
  process.env.KHY_REMOTE_SSH_CONNECT_TIMEOUT_SEC = '-5';
  const { svc } = harness();
  assert.strictEqual(svc._buildRemoteShellCommand('/srv/app', 'ls'), "cd '/srv/app' && ls");
  delete process.env.KHY_REMOTE_SSH_IDLE_TIMEOUT_MS;
  delete process.env.KHY_REMOTE_SSH_CONNECT_TIMEOUT_SEC;
});

test('single quoting neutralises a quote in the workspace name', () => {
  const { svc } = harness();
  const cmd = svc._buildRemoteShellCommand("/srv/ap'" + "p", "echo hi");
  assert.ok(cmd.startsWith("cd '/srv/ap'\\''"), `unexpected quoting: ${cmd}`);
  assert.ok(cmd.endsWith("&& echo hi"));
});

// B31-R17 evidence, and the proof that the isolation above is real rather than
// decorative: flip KHY_REMOTE_SSH_ENABLE_EXEC and the next statement is a hard-coded
// spawn('ssh', ...) (remoteExecService.js:195) with no injectable transport. The throw
// is swallowed by requestExecution's catch, so a failed spawn surfaces as
// execution_error - the stub installed before this module was required is what kept a
// process from existing at all.
test('flipping the gate reaches spawn, which the pre-load stub stops', async () => {
  const { svc } = harness();
  const previous = process.env.KHY_REMOTE_SSH_ENABLE_EXEC;
  process.env.KHY_REMOTE_SSH_ENABLE_EXEC = 'true';
  let res = null;
  try {
    res = await svc.requestExecution({ connectionId: 'c-1', commands: ['ls'], idempotencyKey: 'k-spawn' });
  } finally {
    process.env.KHY_REMOTE_SSH_ENABLE_EXEC = previous;
  }
  assert.strictEqual(spawnAttempts, 1, 'one attempt, intercepted before a process existed');
  assert.strictEqual(res.status, 'execution_error');
  assert.match(res.message, /test isolation: spawn\(ssh\)/);
  assert.strictEqual(svc._idempotentResults.size, 0, 'a transport error is not cached as a result');
  assert.strictEqual(svc._idempotentRunning.size, 0, 'and the in-flight marker is released');
  assert.strictEqual(process.env.KHY_REMOTE_SSH_ENABLE_EXEC, 'false', 'the gate is restored');
  spawnAttempts = 0;
});

test('no case above reached the transport', () => {
  assert.strictEqual(spawnAttempts, 0);
});
