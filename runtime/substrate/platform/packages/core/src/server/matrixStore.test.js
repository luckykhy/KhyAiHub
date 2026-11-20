'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMatrixStore, createActionAuthority, createSecurityAudit } = require('@khy/core/server');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-config-'));
  for (const name of ['shared', 'cli']) fs.mkdirSync(path.join(dir, name));
  const filePath = path.join(dir, 'shared', 'khyos_matrix.json');
  const auditPath = path.join(dir, 'shared', 'security.jsonl');
  const administrator = Object.freeze({});
  const events = [];
  const invalidations = [];
  let failAction;
  let failNotify = false;
  let audit = createSecurityAudit({ filePath: auditPath });
  const auditProxy = {
    get filePath() { return audit.filePath; },
    append(input) {
      if (input.action === failAction) throw new Error('injected audit failure');
      return audit.append(input);
    },
    query: () => audit.query(),
  };
  let authority;
  const options = {
    filePath, audit: auditProxy, administrator,
    protectedPaths: [auditPath, `${auditPath}.lock`],
    invalidateTickets(reason) {
      invalidations.push(reason);
      authority?.invalidateTickets(reason);
    },
    onViolation(principal, event) {
      if (failNotify) throw new Error('notification unavailable');
      events.push({ principal, ...event });
    },
  };
  let store = createMatrixStore(options);
  t.after(() => {
    failAction = undefined;
    store.close();
    audit.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const matrix = {
    version: 'v1.3-khyos', revision: 1, shared_scope: [path.join(dir, 'shared')], high_risk_actions: [],
    budget_policy: { unit: 'input_output_tokens', reset: 'UTC' }, app_sources: [],
    terminals: [{ terminal_id: 'cli', role: 'developer', state: 'active', tools: ['Write'], denied_tools: [],
      data_scope: [path.join(dir, 'cli')], allowed_commands: [], max_tokens_per_task: 100, daily_budget: 200, app_capabilities: {} }],
  };
  const context = { terminal_id: 'cli', task_id: 'task-1', action: 'Write', scope: [path.join(dir, 'cli')], payload: {} };
  const facts = { scope_enforced: true, targets: [path.join(dir, 'cli', 'output.txt')], risk: 'normal',
    usage: { task_tokens: 0, day_tokens: 0, reserved_task_tokens: 0, reserved_day_tokens: 0, input_tokens: 10, max_output_tokens: 20 } };
  return {
    dir, filePath, auditPath, matrix, context, facts, options, administrator, events, invalidations,
    get store() { return store; }, get audit() { return audit; },
    failAudit(action) { failAction = action; },
    failNotify() { failNotify = true; },
    async activate(value = matrix) {
      const proposal = await store.propose(administrator, value);
      return store.confirm(administrator, { challenge_id: proposal.challenge_id, digest: proposal.digest, decision: '确认' });
    },
    restart() {
      store.close();
      audit.close();
      audit = createSecurityAudit({ filePath: auditPath });
      store = createMatrixStore(options);
    },
    bind(handler) {
      authority = createActionAuthority({ audit: auditProxy, notify() {}, authorize: (input) => store.check(input, facts) });
      return { authority, terminal: authority.registerTerminal('cli', { Write: handler }) };
    },
  };
}

const response = (proposal) => ({ challenge_id: proposal.challenge_id, digest: proposal.digest, decision: '确认' });

test('missing unauthorized parameters are denied without poisoning configuration', async (t) => {
  const f = fixture(t);
  f.store.load();
  await f.activate();
  await assert.rejects(f.store.confirm({}), { code: 'CORE_ADMIN_REQUIRED' });
  await assert.rejects(f.store.propose({}, { get role() { throw new Error('must not evaluate'); } }), { code: 'CORE_ADMIN_REQUIRED' });
  assert.equal(f.events.length, 2);
  assert.equal(f.audit.poisoned, false);
  assert.equal(f.store.check(f.context, f.facts).allowed, true);
});

test('runtime audit truncation prevents configuration confirmation', async (t) => {
  const f = fixture(t);
  f.store.load();
  const proposal = await f.store.propose(f.administrator, f.matrix);
  fs.truncateSync(f.auditPath, 0);
  await assert.rejects(f.store.confirm(f.administrator, response(proposal)));
  assert.equal(f.store.matrix, null);
  assert.equal(fs.existsSync(f.filePath), false);
});

test('missing configuration stays inactive until exact administrator confirmation', async (t) => {
  const f = fixture(t);
  assert.equal(f.store.load(), null);
  assert.equal(fs.existsSync(f.filePath), false);
  const proposal = await f.store.propose(f.administrator, f.matrix);
  assert.equal(f.store.matrix, null);
  assert.equal(f.store.check(f.context, f.facts).allowed, false);
  assert.equal(fs.existsSync(f.filePath), false);
  assert.deepEqual(proposal.matrix, f.matrix);
  f.matrix.terminals[0].tools.push('unexpected');
  const active = await f.store.confirm(f.administrator, response(proposal));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filePath, 'utf8')), active);
  assert.equal(active.terminals[0].tools.includes('unexpected'), false);
  assert.equal(f.store.check(f.context, f.facts).allowed, true);
  assert.throws(() => active.terminals[0].tools.push('injected'), TypeError);
  assert.deepEqual(f.audit.query().filter((entry) => entry.action.startsWith('khyos.config')).map((entry) => entry.decision),
    ['allow', 'allow', 'need_human', 'missing']);
  assert.deepEqual(f.audit.query()[0].matrix, active);
});

test('restart restores committed configuration without a new confirmation', async (t) => {
  const f = fixture(t);
  f.store.load();
  const active = await f.activate();
  f.restart();
  assert.deepEqual(f.store.load(), active);
  assert.equal(f.store.check(f.context, f.facts).allowed, true);
  assert.equal(f.audit.query().filter((entry) => entry.action === 'khyos.config.propose').length, 1);
});

test('deletion enters bootstrap but cannot reset the monotonic revision', async (t) => {
  const f = fixture(t);
  f.store.load();
  await f.activate();
  fs.unlinkSync(f.filePath);
  f.restart();
  assert.equal(f.store.load(), null);
  await assert.rejects(f.activate(), { code: 'CORE_CONFIG_REVISION' });
  assert.equal((await f.activate({ ...f.matrix, revision: 2 })).revision, 2);
});

test('claimed administrator data and copied identity cannot change the matrix', async (t) => {
  const f = fixture(t);
  f.store.load();
  const intruder = { role: 'admin', approved: true };
  await assert.rejects(f.store.propose(intruder, f.matrix), { code: 'CORE_ADMIN_REQUIRED' });
  assert.equal(f.events[0].event, 'forge_admin');
  assert.equal(f.events[0].principal, intruder);
  assert.deepEqual(f.audit.query().find((entry) => entry.action === 'forge_admin').evidence, f.matrix);
  const proposal = await f.store.propose(f.administrator, f.matrix);
  await assert.rejects(f.store.confirm({ ...f.administrator }, response(proposal)), { code: 'CORE_ADMIN_REQUIRED' });
  assert.equal(fs.existsSync(f.filePath), false);
  assert.equal((await f.store.confirm(f.administrator, response(proposal))).revision, 1);
});

test('failed violation notification reports failure rather than delivered', async (t) => {
  const f = fixture(t);
  f.store.load();
  f.failNotify();
  await assert.rejects(f.store.propose({}, f.matrix), { code: 'CORE_NOTIFICATION_UNAVAILABLE' });
  assert.equal(f.audit.query()[0].decision, 'failed');
  assert.equal(f.store.matrix, null);
});

test('cancellation consumes confirmation and does not create configuration', async (t) => {
  const f = fixture(t);
  f.store.load();
  const proposal = await f.store.propose(f.administrator, f.matrix);
  await assert.rejects(f.store.confirm(f.administrator, { ...response(proposal), decision: '取消' }), { code: 'CORE_CONFIRMATION_REQUIRED' });
  await assert.rejects(f.store.confirm(f.administrator, response(proposal)), { code: 'CORE_CONFIRMATION_INVALID' });
  assert.equal(fs.existsSync(f.filePath), false);
});

test('new drafts invalidate old challenges and reject mismatched digests', async (t) => {
  const f = fixture(t);
  f.store.load();
  const old = await f.store.propose(f.administrator, f.matrix);
  const latest = await f.store.propose(f.administrator, { ...f.matrix, high_risk_actions: ['Write'] });
  await assert.rejects(f.store.confirm(f.administrator, response(old)), { code: 'CORE_CONFIRMATION_INVALID' });
  await assert.rejects(f.store.confirm(f.administrator, { ...response(latest), digest: old.digest }), { code: 'CORE_CONFIRMATION_INVALID' });
  assert.equal(f.store.matrix, null);
  await f.store.confirm(f.administrator, response(latest));
  assert.equal(f.store.check(f.context, f.facts).status, 'need_human');
});

test('concurrent duplicate confirmation commits only once', async (t) => {
  const f = fixture(t);
  f.store.load();
  const proposal = await f.store.propose(f.administrator, f.matrix);
  const outcomes = await Promise.allSettled([
    f.store.confirm(f.administrator, response(proposal)), f.store.confirm(f.administrator, response(proposal)),
  ]);
  assert.deepEqual(outcomes.map((item) => item.status), ['fulfilled', 'rejected']);
  assert.equal(f.audit.query().filter((entry) => entry.action === 'khyos.config.write').length, 1);
});

for (const variant of ['malformed', 'tampered', 'unapproved', 'older']) {
  test(`load refuses ${variant} disk content without overwriting it`, async (t) => {
    const f = fixture(t);
    f.store.load();
    if (variant !== 'unapproved') await f.activate();
    const old = fs.existsSync(f.filePath) ? fs.readFileSync(f.filePath) : null;
    if (variant === 'older') await f.activate({ ...f.matrix, revision: 2 });
    const bytes = variant === 'malformed' ? '{' : variant === 'older' ? old
      : JSON.stringify({ ...f.matrix, high_risk_actions: ['Write'] });
    fs.writeFileSync(f.filePath, bytes);
    f.restart();
    assert.throws(() => f.store.load());
    assert.equal(f.store.matrix, null);
    assert.deepEqual(fs.readFileSync(f.filePath), Buffer.from(bytes));
    await assert.rejects(f.activate(), { code: 'CORE_CONFIG_UNAVAILABLE' });
  });
}

test('external change while awaiting confirmation is never overwritten', async (t) => {
  const f = fixture(t);
  f.store.load();
  const proposal = await f.store.propose(f.administrator, f.matrix);
  fs.writeFileSync(f.filePath, 'external');
  await assert.rejects(f.store.confirm(f.administrator, response(proposal)), /外部修改/);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), 'external');
  assert.equal(f.store.matrix, null);
});

test('audit failure before file creation never activates or writes the matrix', async (t) => {
  const f = fixture(t);
  f.store.load();
  const proposal = await f.store.propose(f.administrator, f.matrix);
  f.failAudit('khyos.config.confirm');
  await assert.rejects(f.store.confirm(f.administrator, response(proposal)), /injected audit failure/);
  assert.equal(fs.existsSync(f.filePath), false);
  assert.equal(f.store.matrix, null);
  assert.throws(() => f.store.check(f.context, f.facts), { code: 'CORE_CONFIG_UNAVAILABLE' });
});

test('renamed file without a committed audit is not activated after restart', async (t) => {
  const f = fixture(t);
  f.store.load();
  const proposal = await f.store.propose(f.administrator, f.matrix);
  f.failAudit('khyos.config.write');
  await assert.rejects(f.store.confirm(f.administrator, response(proposal)), /injected audit failure/);
  assert.equal(fs.existsSync(f.filePath), true);
  assert.equal(f.store.matrix, null);
  f.failAudit(undefined);
  f.restart();
  assert.throws(() => f.store.load(), /审批不一致/);
  assert.equal(fs.existsSync(f.filePath), true);
});

test('pre-existing pending file is retained and blocks configuration replacement', async (t) => {
  const f = fixture(t);
  f.store.load();
  fs.writeFileSync(`${f.filePath}.pending`, 'previous interrupted write');
  await assert.rejects(f.activate(), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(`${f.filePath}.pending`, 'utf8'), 'previous interrupted write');
  assert.equal(fs.existsSync(f.filePath), false);
});

test('a redirected private root cannot acquire new authority after restart', async (t) => {
  const f = fixture(t);
  f.store.load();
  await f.activate();
  const root = f.matrix.terminals[0].data_scope[0];
  fs.renameSync(root, `${root}-original`);
  fs.mkdirSync(path.join(f.dir, 'outside'));
  fs.symlinkSync(path.join(f.dir, 'outside'), root, 'junction');
  f.restart();
  assert.throws(() => f.store.load(), /重定向/);
  assert.equal(f.store.matrix, null);
});

test('redirected roots while awaiting confirmation cannot be committed', async (t) => {
  const f = fixture(t);
  f.store.load();
  const proposal = await f.store.propose(f.administrator, f.matrix);
  const root = f.matrix.terminals[0].data_scope[0];
  fs.renameSync(root, `${root}-original`);
  fs.mkdirSync(path.join(f.dir, 'outside'));
  fs.symlinkSync(path.join(f.dir, 'outside'), root, 'junction');
  await assert.rejects(f.store.confirm(f.administrator, response(proposal)), /重定向/);
  assert.equal(fs.existsSync(f.filePath), false);
});

test('exclusive lock refuses a second writer and close releases only its own lock', (t) => {
  const f = fixture(t);
  assert.throws(() => createMatrixStore(f.options), { code: 'EEXIST' });
  assert.equal(fs.existsSync(`${f.filePath}.lock`), true);
  f.store.close();
  f.store.close();
  assert.equal(fs.existsSync(`${f.filePath}.lock`), false);
  assert.throws(() => f.store.load(), { code: 'CORE_CONFIG_UNAVAILABLE' });
});

test('matrix and audit files are not ordinary writable shared artifacts', async (t) => {
  const f = fixture(t);
  f.store.load();
  await f.activate();
  const context = { ...f.context, scope: f.matrix.shared_scope };
  for (const target of [f.filePath, `${f.filePath}.pending`, `${f.filePath}.lock`, f.auditPath, path.dirname(f.filePath)]) {
    assert.equal(f.store.check(context, { ...f.facts, targets: [target] }).allowed, false, target);
  }
  assert.equal(f.store.check(context, { ...f.facts, targets: [path.join(path.dirname(f.filePath), 'contract.json')] }).allowed, true);
});

test('revoke then grant cannot resurrect a previously issued ticket', async (t) => {
  const f = fixture(t);
  f.store.load();
  await f.activate();
  let calls = 0;
  const { authority, terminal } = f.bind(() => { calls++; });
  const ticket = authority.issue(f.context);
  await f.activate({ ...f.matrix, revision: 2, terminals: [{ ...f.matrix.terminals[0], denied_tools: ['Write'] }] });
  await f.activate({ ...f.matrix, revision: 3 });
  await assert.rejects(terminal.execute({ from: authority.issuer, task_id: f.context.task_id, action: 'Write', payload: {}, ticket }),
    { code: 'CORE_TICKET_INVALID' });
  assert.equal(calls, 0);
  assert.ok(f.audit.query().some((entry) => entry.action === 'ticket.invalidate' && entry.count === 1));
});

test('confirmed configuration authorizes a real artifact before and after restart', async (t) => {
  const f = fixture(t);
  f.store.load();
  await f.activate();
  for (const content of ['first', 'restored']) {
    const { authority, terminal } = f.bind(() => {
      fs.writeFileSync(f.facts.targets[0], content);
      return { task_id: f.context.task_id, status: 'ok', summary: '完成', result_ref: f.facts.targets[0], violations: [] };
    });
    const ticket = authority.issue(f.context);
    const receipt = await terminal.execute({ from: authority.issuer, task_id: f.context.task_id, action: 'Write', payload: {}, ticket });
    assert.equal(receipt.status, 'ok');
    assert.equal(fs.readFileSync(receipt.result_ref, 'utf8'), content);
    f.restart();
    assert.equal(f.store.load().revision, 1);
  }
  assert.equal(f.audit.query().filter((entry) => entry.action === 'task.receipt' && entry.decision === 'ok').length, 2);
});

for (const method of ['writeFileSync', 'fsyncSync', 'renameSync']) {
  test(`configuration ${method} failure preserves the prior file and does not activate`, async (t) => {
    const f = fixture(t);
    f.store.load();
    await f.activate();
    const before = fs.readFileSync(f.filePath);
    const proposal = await f.store.propose(f.administrator, { ...f.matrix, revision: 2 });
    const original = fs[method];
    let faults = 0;
    const mock = t.mock.method(fs, method, (...args) => {
      const targetsPending = typeof args[0] === 'number'
        ? fs.existsSync(`${f.filePath}.pending`) && fs.fstatSync(args[0]).ino === fs.statSync(`${f.filePath}.pending`).ino
        : args[0] === `${f.filePath}.pending`;
      if (targetsPending) { faults++; throw new Error(`injected ${method} failure`); }
      return original(...args);
    });
    try {
      await assert.rejects(f.store.confirm(f.administrator, response(proposal)), new RegExp(`injected ${method} failure`));
    } finally { mock.mock.restore(); }
    assert.equal(faults, 1);
    assert.deepEqual(fs.readFileSync(f.filePath), before);
    assert.equal(f.store.matrix, null);
    assert.equal(f.audit.query().filter((entry) => entry.action === 'khyos.config.write' && entry.decision === 'allow').length, 1);
    f.restart();
    assert.equal(f.store.load().revision, 1);
  });
}

test('configuration changes discard an already-running late success receipt', async (t) => {
  const f = fixture(t);
  f.store.load();
  await f.activate();
  let release;
  const { authority, terminal } = f.bind(() => new Promise((resolve) => { release = resolve; }));
  const ticket = authority.issue(f.context);
  const running = terminal.execute({ from: authority.issuer, task_id: f.context.task_id, action: 'Write', payload: {}, ticket });
  await f.activate({ ...f.matrix, revision: 2 });
  release({ task_id: f.context.task_id, status: 'ok', summary: '完成', result_ref: 'artifact', violations: [] });
  await assert.rejects(running, { code: 'CORE_POLICY_CHANGED' });
  assert.equal(f.audit.query()[0].decision, 'discarded');
});
