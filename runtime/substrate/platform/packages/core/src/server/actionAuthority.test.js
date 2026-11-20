'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createActionAuthority, createSecurityAudit } = require('@khy/core/server');

function receipt() {
  return { task_id: 'task-1', status: 'ok', summary: '已写入', result_ref: 'artifact:result.txt', violations: [] };
}

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-action-authority-'));
  const audit = createSecurityAudit({ filePath: path.join(dir, 'audit.jsonl') });
  t.after(() => { audit.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let clock = 1000;
  let calls = 0;
  const notifications = [];
  const authority = createActionAuthority({ audit, authorize: () => ({ allowed: true }), notify: (event) => { notifications.push(event); }, now: () => clock, ...options });
  const terminal = authority.registerTerminal('cli', {
    Write: options.handler || ((payload) => {
      const rows = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(rows.at(-1).action, 'ticket.redeem');
      assert.equal(rows.at(-1).decision, 'allow');
      calls++;
      fs.writeFileSync(path.join(dir, 'result.txt'), payload.content);
      return receipt();
    }),
  });
  function input(overrides = {}) {
    return { terminal_id: 'cli', task_id: 'task-1', action: 'Write', scope: [dir], payload: { content: 'original' }, ...overrides };
  }
  function envelope(overrides = {}) {
    const request = input(overrides);
    return { from: authority.issuer, task_id: request.task_id, action: request.action, payload: request.payload, ticket: authority.issue(request) };
  }
  return { dir, audit, authority, terminal, input, envelope, advance: (ms) => { clock += ms; }, calls: () => calls };
}

test('a host-issued ticket executes once and persists the redemption before the side effect', async (t) => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(f.terminal), ['execute']);
  const request = f.envelope();
  assert.equal(request.ticket.expires_at, 301000);
  assert.equal(request.ticket.terminal_id, 'cli');
  assert.equal(request.ticket.action, 'Write');
  assert.deepEqual(await f.terminal.execute(request), receipt());
  assert.equal(fs.readFileSync(path.join(f.dir, 'result.txt'), 'utf8'), 'original');
  assert.equal(f.calls(), 1);
  const entries = f.audit.query().reverse();
  assert.deepEqual(entries.map((row) => row.action), ['terminal.bind', 'permission.check', 'ticket.issue', 'permission.check', 'ticket.redeem', 'task.receipt']);
  assert.equal(entries[4].ticket_id, request.ticket.ticket_id);
  await assert.rejects(f.terminal.execute(request), { code: 'CORE_TICKET_INVALID' });
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.audit.query().find((row) => row.action === 'security.intercept').evidence, request);
  assert.throws(() => f.envelope(), { code: 'CORE_TERMINAL_INACTIVE' });
});

const mutations = {
  from: (r) => { r.from = 'administrator'; },
  task: (r) => { r.task_id = 'task-2'; },
  action: (r) => { r.action = 'shell.exec'; },
  payload: (r) => { r.payload.content = 'changed'; },
  issuer: (r) => { r.ticket.issuer = 'terminal'; },
  subject: (r) => { r.ticket.terminal_id = 'web'; },
  scope: (r) => { r.ticket.scope = ['outside']; },
  expiry: (r) => { r.ticket.expires_at += 1; },
  id: (r) => { r.ticket.ticket_id = 'self-issued'; },
  field: (r) => { r.approved = true; },
  missing: (r) => { delete r.ticket; },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`rejects ${name} tampering and freezes only the submitting terminal`, async (t) => {
    const f = fixture(t);
    const request = JSON.parse(JSON.stringify(f.envelope()));
    mutate(request);
    await assert.rejects(f.terminal.execute(request), { code: 'CORE_TICKET_INVALID' });
    assert.equal(f.calls(), 0);
    assert.equal(fs.existsSync(path.join(f.dir, 'result.txt')), false);
    assert.deepEqual(f.audit.query().find((row) => row.action === 'security.intercept').evidence, request);
    assert.throws(() => f.envelope(), { code: 'CORE_TERMINAL_INACTIVE' });
  });
}

test('a different terminal cannot redeem a genuine ticket', async (t) => {
  const f = fixture(t);
  const web = f.authority.registerTerminal('web', { Write: () => assert.fail('must not execute') });
  const request = f.envelope();
  await assert.rejects(web.execute(request), { code: 'CORE_TICKET_INVALID' });
  assert.deepEqual(await f.terminal.execute(request), receipt());
});

test('expiry is inclusive and does not freeze an otherwise authorized terminal', async (t) => {
  const f = fixture(t);
  const request = f.envelope();
  f.advance(300000);
  await assert.rejects(f.terminal.execute(request), { code: 'CORE_TICKET_EXPIRED' });
  assert.equal(f.calls(), 0);
  assert.deepEqual(await f.terminal.execute(f.envelope()), receipt());
});

test('parallel redemption enters the executor only once', async (t) => {
  let calls = 0;
  let finish;
  const f = fixture(t, { handler: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } });
  const request = f.envelope();
  const first = f.terminal.execute(request);
  await assert.rejects(f.terminal.execute(request), { code: 'CORE_TICKET_INVALID' });
  assert.equal(calls, 1);
  finish(receipt());
  await assert.rejects(first, { code: 'CORE_TERMINAL_INACTIVE' });
  assert.equal(f.audit.query()[0].decision, 'discarded');
});

test('revoked permissions are rechecked on redemption without executing', async (t) => {
  let allowed = true;
  const f = fixture(t, { authorize: () => ({ allowed, reason: 'revoked' }) });
  const request = f.envelope();
  allowed = false;
  await assert.rejects(f.terminal.execute(request), { code: 'CORE_PERMISSION_DENIED' });
  assert.equal(f.calls(), 0);
});

for (const authorize of [() => null, () => ({}), () => ({ allowed: 'true' }), () => { throw new Error('policy broken'); }]) {
  test('missing or broken permission decisions cannot issue tickets', (t) => {
    const f = fixture(t, { authorize });
    assert.throws(() => f.envelope(), { code: 'CORE_PERMISSION_DENIED' });
    assert.equal(f.calls(), 0);
  });
}

test('audit fsync failure prevents the executor and poisons the authority', async (t) => {
  const f = fixture(t);
  const request = f.envelope();
  const original = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw new Error('disk unavailable'); };
    await assert.rejects(f.terminal.execute(request), { code: 'CORE_AUDIT_UNAVAILABLE' });
  } finally {
    fs.fsyncSync = original;
  }
  assert.equal(f.calls(), 0);
  assert.throws(() => f.envelope(), { code: 'CORE_AUDIT_UNAVAILABLE' });
});

test('executor failure consumes the ticket and is not reported as success', async (t) => {
  const f = fixture(t, { handler: () => { throw new Error('execution failed'); } });
  const request = f.envelope();
  await assert.rejects(f.terminal.execute(request), /execution failed/);
  assert.equal(f.audit.query()[0].decision, 'failed');
  await assert.rejects(f.terminal.execute(request), { code: 'CORE_TICKET_INVALID' });
});

test('task end invalidates outstanding tickets and prevents reissuing for that task', async (t) => {
  const f = fixture(t);
  const request = f.envelope();
  f.authority.endTask('cli', 'task-1');
  assert.throws(() => f.envelope(), { code: 'CORE_TASK_ENDED' });
  await assert.rejects(f.terminal.execute(request));
  assert.equal(f.calls(), 0);
});

test('unregister invalidates tickets and the executor facade', async (t) => {
  const f = fixture(t);
  const request = f.envelope();
  f.authority.unregisterTerminal('cli');
  await assert.rejects(f.terminal.execute(request), { code: 'CORE_TERMINAL_INACTIVE' });
  assert.throws(() => f.envelope(), { code: 'CORE_TERMINAL_INACTIVE' });
  assert.equal(f.calls(), 0);
});

test('missing capabilities never issue a ticket', (t) => {
  const f = fixture(t);
  assert.throws(() => f.envelope({ action: 'app.install' }), { code: 'CORE_CAPABILITY_UNAVAILABLE' });
});

test('caller mutation and property ordering cannot change the issued payload', async (t) => {
  const f = fixture(t);
  const request = f.envelope({ payload: { content: 'original', details: { b: 2, a: 1 } } });
  assert.ok(Object.isFrozen(request.ticket.scope));
  request.payload = { details: { a: 1, b: 2 }, content: 'original' };
  assert.deepEqual(await f.terminal.execute(request), receipt());
});

test('terminal-filtered audit includes the entire successful authorization chain', async (t) => {
  const f = fixture(t);
  await f.terminal.execute(f.envelope());
  const rows = f.audit.query({ terminal_id: 'cli', task_id: 'task-1' }).reverse();
  assert.deepEqual(rows.map((row) => row.action), [
    'permission.check', 'ticket.issue', 'permission.check', 'ticket.redeem', 'task.receipt',
  ]);
  assert.ok(rows.every((row) => row.terminal_id === 'cli' && row.task_id === 'task-1'));
});

test('terminal-filtered audit retains permission denials and executor failures', async (t) => {
  const denied = fixture(t, { authorize: () => ({ allowed: false, reason: 'revoked' }) });
  assert.throws(() => denied.envelope(), { code: 'CORE_PERMISSION_DENIED' });
  assert.equal(denied.audit.query({ terminal_id: 'cli', task_id: 'task-1' })[0]?.action, 'permission.check');
  const failed = fixture(t, { handler: () => { throw new Error('executor failed'); } });
  await assert.rejects(failed.terminal.execute(failed.envelope()), /executor failed/);
  assert.equal(failed.audit.query({ terminal_id: 'cli', task_id: 'task-1' })[0]?.decision, 'failed');
});

test('tampered task identifiers cannot redirect security evidence to a different task', async (t) => {
  const f = fixture(t);
  const request = { ...f.envelope(), task_id: 'forged-task' };
  await assert.rejects(f.terminal.execute(request), { code: 'CORE_TICKET_INVALID' });
  const row = f.audit.query({ terminal_id: 'cli', task_id: 'task-1' }).find((entry) => entry.action === 'security.intercept');
  assert.ok(row);
  assert.equal(row.ticket_id, request.ticket.ticket_id);
  assert.deepEqual(row.evidence, request);
});

test('terminal lifecycle records remain visible through terminal filters', (t) => {
  const f = fixture(t);
  f.authority.freeze('cli', 'review');
  f.authority.unregisterTerminal('cli');
  assert.deepEqual(f.audit.query({ terminal_id: 'cli' }).reverse().map((row) => row.action), [
    'terminal.bind', 'terminal.freeze', 'terminal.unregister',
  ]);
});

test('array accessors are rejected without invoking them', (t) => {
  const f = fixture(t);
  let invoked = false;
  const payload = [];
  Object.defineProperty(payload, '0', { enumerable: true, get() { invoked = true; return 'injected'; } });
  assert.throws(() => f.envelope({ payload }), TypeError);
  assert.equal(invoked, false);
});

test('restart preserves freezes and ended tasks but never revives old tickets', async (t) => {
  const f = fixture(t);
  f.authority.registerTerminal('web', { Write: () => (receipt()) });
  const request = f.envelope();
  f.authority.freeze('web', 'violation');
  f.authority.registerTerminal('desktop', { Write: () => assert.fail('unregistered') });
  f.authority.unregisterTerminal('desktop');
  f.authority.endTask('cli', 'ended');
  f.audit.close();
  const reopened = createSecurityAudit({ filePath: path.join(f.dir, 'audit.jsonl') });
  try {
    const notifications = [];
    const next = createActionAuthority({ audit: reopened, authorize: () => ({ allowed: true }), notify: (event) => { notifications.push(event); } });
    next.registerTerminal('desktop', { Write: () => assert.fail('unregistered') });
    assert.throws(() => next.issue(f.input({ terminal_id: 'desktop' })), { code: 'CORE_TERMINAL_INACTIVE' });
    next.registerTerminal('web', { Write: () => assert.fail('frozen') });
    const cli = next.registerTerminal('cli', { Write: () => assert.fail('stale ticket') });
    assert.throws(() => next.issue(f.input({ terminal_id: 'web' })), { code: 'CORE_TERMINAL_INACTIVE' });
    assert.throws(() => next.issue(f.input({ task_id: 'ended' })), { code: 'CORE_TASK_ENDED' });
    await assert.rejects(cli.execute(request), { code: 'CORE_TICKET_INVALID' });
  } finally {
    reopened.close();
  }
});

for (const value of [NaN, Infinity, -1, 1.5, '1000']) {
  test(`invalid clock ${String(value)} cannot bypass expiry at redemption`, async (t) => {
    let clock = 1000;
    const f = fixture(t, { now: () => clock });
    const request = f.envelope();
    clock = value;
    await assert.rejects(f.terminal.execute(request), { code: 'CORE_CLOCK_INVALID' });
    assert.equal(f.calls(), 0);
    assert.equal(f.audit.query()[0].action, 'ticket.clock');
    assert.equal(f.audit.query()[0].decision, 'deny');
  });
}

