'use strict';

// Co-located unit test for remoteApprovalBridge.js (pure in-memory risk
// classifier + ticket FSM; no IO, no timers).

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

const mod = require('./remoteApprovalBridge');
const { createRemoteApprovalBridge, RemoteApprovalBridge } = mod;

test('export surface', () => {
  assert.deepStrictEqual(Object.keys(mod), ['RemoteApprovalBridge', 'createRemoteApprovalBridge']);
  assert.ok(createRemoteApprovalBridge() instanceof RemoteApprovalBridge);
});

test('an empty command is classified safe on purpose', () => {
  const b = createRemoteApprovalBridge();
  for (const v of ['', '   ', null, undefined, 0]) {
    const r = b.classifyCommand(v);
    assert.strictEqual(r.risk, 'safe');
    assert.match(r.reason, /Empty command/);
  }
});

test('no pattern hit means safe', () => {
  const b = createRemoteApprovalBridge();
  assert.strictEqual(b.classifyCommand('ls -la').risk, 'safe');
  assert.strictEqual(b.classifyCommand('cat README.md').risk, 'safe');
});

test('moderate / dangerous families are recognised', () => {
  const b = createRemoteApprovalBridge();
  assert.strictEqual(b.classifyCommand('npm install left-pad').risk, 'moderate');
  assert.strictEqual(b.classifyCommand('docker compose up -d').risk, 'moderate');
  assert.strictEqual(b.classifyCommand('git pull --rebase').risk, 'moderate');
  assert.strictEqual(b.classifyCommand('git push origin main').risk, 'dangerous');
  assert.strictEqual(b.classifyCommand('kill -9 4242').risk, 'dangerous');
  assert.strictEqual(b.classifyCommand('chmod -R 777 /srv').risk, 'dangerous');
  assert.strictEqual(b.classifyCommand('systemctl restart nginx').risk, 'dangerous');
});

// B31-R1 (registered, NOT fixed): the critical rule at remoteApprovalBridge.js:16
// is `/\b(rm\s+-rf\s+\/|mkfs\b|dd\s+if=|shutdown\b|reboot\b)\b/i` — the outer
// trailing `\b` demands a WORD character right after whatever the alternative
// matched. Two of the five alternatives end in a non-word character (`/` and `=`),
// so the exact shapes the rule exists to catch are the ones that cannot match:
//   'rm -rf /'            -> dangerous, not critical  (only because rule 2 catches it)
//   'dd if=/dev/...'      -> SAFE, no approval required at all
// while the *same* rule does fire when the next character happens to be a letter
// ('dd if=x' -> critical). requiresApproval is `risk >= dangerous`
// (remoteApprovalBridge.js:129), so a whole-disk overwrite is planned and, with
// KHY_REMOTE_SSH_ENABLE_EXEC=true, executed with nobody approving it.
test('B31-R1 the trailing \\b makes the critical family unreliable', () => {
  const b = createRemoteApprovalBridge();
  assert.strictEqual(b.classifyCommand('rm -rf /').risk, 'dangerous', 'current behaviour: not critical');
  assert.strictEqual(b.classifyCommand('rm -rf / ').risk, 'dangerous');
  assert.strictEqual(b.classifyCommand('rm -rf /etc/passwd').risk, 'critical');
  assert.strictEqual(b.classifyCommand('dd if=x').risk, 'critical');
  assert.strictEqual(b.classifyCommand('dd if=/dev/zero of=/dev/sda bs=1M').risk, 'safe');
  assert.strictEqual(b.evaluateCommands(['dd if=/dev/zero of=/dev/sda bs=1M']).requiresApproval, false);
  assert.strictEqual(b.classifyCommand('mkfs').risk, 'critical');
  assert.strictEqual(b.classifyCommand('shutdown').risk, 'critical');
});

test('evaluateCommands picks the highest risk of the batch', () => {
  const b = createRemoteApprovalBridge();
  const ev = b.evaluateCommands(['ls', 'npm install x', 'git push origin main']);
  assert.strictEqual(ev.highestRisk, 'dangerous');
  assert.strictEqual(ev.requiresApproval, true);
  assert.strictEqual(ev.perCommand.length, 3);
  assert.strictEqual(ev.perCommand[0].command, 'ls');
});

test('evaluateCommands on nothing is safe and needs no approval', () => {
  const b = createRemoteApprovalBridge();
  for (const v of [[], undefined, null, 'not-an-array']) {
    const ev = b.evaluateCommands(v);
    assert.strictEqual(ev.highestRisk, 'safe');
    assert.strictEqual(ev.requiresApproval, false);
  }
  assert.strictEqual(b.evaluateCommands([]).highestReason, 'No commands provided.');
});

test('createTicket issues a pending ticket with a 10 minute expiry', () => {
  const b = createRemoteApprovalBridge();
  const t = b.createTicket({
    traceId: 'tr-1',
    connectionId: 'c-1',
    hostAlias: 'prod',
    commands: ['git push origin main'],
    idempotencyKey: 'idem-1',
    riskContext: { kind: 'deploy' },
  });
  assert.ok(t.ticket_id);
  assert.strictEqual(t.status, 'pending');
  assert.strictEqual(t.risk_level, 'dangerous');
  assert.strictEqual(t.idempotency_key, 'idem-1');
  assert.deepStrictEqual(t.risk_context, { kind: 'deploy' });
  assert.strictEqual(t.commands[0].command, 'git push origin main');
  assert.strictEqual(b.listPendingTickets().length, 1);
  assert.notStrictEqual(b.getTicket(t.ticket_id), t, 'callers get copies');
  const windowMs = Date.parse(t.expires_at) - Date.parse(t.created_at);
  assert.ok(Math.abs(windowMs - 10 * 60 * 1000) < 250, `expiry window is the hard-coded 10 minutes, got ${windowMs}ms`);
});

test('the FSM: approve, reject, consume, and their guards', () => {
  const b = createRemoteApprovalBridge();
  const t = b.createTicket({ commands: ['git push'], idempotencyKey: 'k1' });
  assert.strictEqual(b.approveTicket(''), null);
  assert.strictEqual(b.approveTicket('nope'), null);
  assert.strictEqual(b.approveTicket(t.ticket_id, 'ops').status, 'approved');
  assert.strictEqual(b.approveTicket(t.ticket_id, 'ops').approved_by, 'ops');
  assert.strictEqual(b.consumeApprovedTicket('   ', 'k1').code, 'ticket_id_required');
  assert.strictEqual(b.consumeApprovedTicket('nope', 'k1').code, 'ticket_not_found');
  assert.strictEqual(b.consumeApprovedTicket(t.ticket_id, 'other').code, 'idempotency_key_mismatch');
  assert.strictEqual(b.consumeApprovedTicket(t.ticket_id, 'k1').ok, true);
  assert.strictEqual(b.consumeApprovedTicket(t.ticket_id, 'k1').code, 'ticket_already_consumed');
  const r = b.createTicket({ commands: ['git push'] });
  assert.strictEqual(b.rejectTicket(r.ticket_id, 'sec', 'too risky').status, 'rejected');
  assert.strictEqual(b.rejectTicket(r.ticket_id).rejected_reason, 'rejected_by_reviewer');
  assert.strictEqual(b.consumeApprovedTicket(r.ticket_id).code, 'ticket_not_approved');
  assert.strictEqual(b.rejectTicket(''), null);
  assert.strictEqual(b.rejectTicket('missing'), null);
});

// B31-R2 (registered, NOT fixed): `expires_at` is a real field (created at
// remoteApprovalBridge.js:155, capped at 10 minutes) and importState DOES honour
// it (remoteApprovalBridge.js:270-273 drops an expired pending ticket). But
// approveTicket (:165) and consumeApprovedTicket (:200) never look at it, so the
// "approval window" only exists on the reload path: a ticket left pending for a
// week is still approvable and then consumable. A reviewer believing the 10 minute
// contract has approved a stale plan.
test('B31-R2 expiry is enforced on import but ignored by approve/consume', () => {
  const b = createRemoteApprovalBridge();
  const t = b.createTicket({ commands: ['git push'], idempotencyKey: 'k1' });
  b._tickets.get(t.ticket_id).expires_at = new Date(Date.now() - 60_000).toISOString();
  assert.strictEqual(b.approveTicket(t.ticket_id, 'ops').status, 'approved', 'current behaviour: stale ticket approved');
  assert.strictEqual(b.consumeApprovedTicket(t.ticket_id, 'k1').ok, true, 'current behaviour: stale ticket consumed');
  const dropped = b.importState([
    { ticket_id: 'expired-pending', status: 'pending', expires_at: new Date(Date.now() - 60_000).toISOString(), commands: [] },
  ]);
  assert.strictEqual(dropped, 0, 'the same expiry does drop it on import');
});

test('a consumed ticket can be re-approved but never re-consumed', () => {
  const b = createRemoteApprovalBridge();
  const t = b.createTicket({ commands: ['git push'], idempotencyKey: 'k1' });
  b.approveTicket(t.ticket_id);
  b.consumeApprovedTicket(t.ticket_id, 'k1');
  const again = b.approveTicket(t.ticket_id, 'ops-2');
  assert.strictEqual(again.status, 'approved');
  assert.ok(again.consumed_at, 'the consume marker survives the re-approval');
  assert.strictEqual(b.consumeApprovedTicket(t.ticket_id, 'k1').code, 'ticket_already_consumed');
});

test('exportState / importState round-trip sanitises and drops junk', () => {
  const b = createRemoteApprovalBridge();
  b.createTicket({ commands: ['git push'], idempotencyKey: 'k1', connectionId: 'c-1' });
  const snapshot = b.exportState();
  assert.strictEqual(snapshot.length, 1);
  const c = createRemoteApprovalBridge();
  const n = c.importState([
    ...snapshot,
    null,
    'not-an-object',
    { ticket_id: '   ' },
    { commands: [] },
    { ticket_id: 'kept', status: 'approved', commands: [{ command: 'git push', risk: 'dangerous' }, {}, null] },
  ]);
  assert.strictEqual(n, 2);
  const kept = c.getTicket('kept');
  assert.strictEqual(kept.status, 'approved');
  assert.strictEqual(kept.risk_level, 'safe', 'an absent risk_level defaults to safe');
  assert.deepStrictEqual(kept.commands[1], { command: '', risk: 'safe', reason: '' });
  assert.deepStrictEqual(c.importState(undefined), 0);
  assert.deepStrictEqual(c.importState('nope'), 0);
  // import replaces the whole table rather than merging.
  assert.strictEqual(b.listTickets().length, 1, 'the source bridge is untouched');
});

test('imported approvals keep their internal shape when re-exported', () => {
  const b = createRemoteApprovalBridge();
  b.importState([{ ticket_id: 'x1', status: 'pending', commands: [{ command: 'ls', risk: 'safe', reason: 'r' }] }]);
  const out = b.exportState()[0];
  assert.strictEqual(out.ticket_id, 'x1');
  assert.strictEqual(out.approved_by, null);
  assert.strictEqual(out.risk_context, null);
  assert.strictEqual(out.created_at.length > 0, true);
});

test('onMutate fires for every state change and a throwing listener cannot break the FSM', () => {
  const seen = [];
  const b = createRemoteApprovalBridge({
    onMutate: (m) => {
      seen.push(m.reason);
      throw new Error('subscriber exploded');
    },
  });
  const t = b.createTicket({ commands: ['git push'], idempotencyKey: 'k' });
  b.approveTicket(t.ticket_id);
  b.rejectTicket(t.ticket_id);
  b.importState([]);
  b.clearAll();
  assert.deepStrictEqual(seen, ['create_ticket', 'approve_ticket', 'reject_ticket', 'import_state', 'clear_all']);
  assert.strictEqual(b.listTickets().length, 0);
  const silent = createRemoteApprovalBridge({ onMutate: 'not-a-function' });
  assert.doesNotThrow(() => silent.createTicket({ commands: ['ls'] }));
});

test('mutation payloads carry source and payload but never key material', () => {
  const seen = [];
  const b = createRemoteApprovalBridge({ onMutate: (m) => seen.push(m) });
  const t = b.createTicket({ commands: ['git push'], idempotencyKey: 'k', connectionId: 'c-9' });
  b.approveTicket(t.ticket_id);
  const consumed = b.consumeApprovedTicket(t.ticket_id, 'k');
  assert.strictEqual(consumed.ok, true);
  assert.deepStrictEqual(seen.map((m) => m.source), ['remote_approval_bridge', 'remote_approval_bridge', 'remote_approval_bridge']);
  assert.deepStrictEqual(seen.map((m) => m.reason), ['create_ticket', 'approve_ticket', 'consume_ticket']);
  assert.deepStrictEqual(seen[0].payload, { ticket_id: t.ticket_id });
  assert.ok(!JSON.stringify(seen).includes('PRIVATE KEY'));
});
