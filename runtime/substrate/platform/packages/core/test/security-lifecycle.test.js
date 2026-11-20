'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { obtainCoreNode } = require('@khy/core/locator-host');
const { createCoreServer, createSecurityAudit } = require('@khy/core/server');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-security-life-'));
  for (const dir of ['shared', 'cli', 'web']) fs.mkdirSync(path.join(home, dir));
  const administrator = Object.freeze({});
  const notifications = [];
  const handles = [];
  const security = {
    matrixPath: path.join(home, 'shared', 'khyos_matrix.json'),
    auditPath: path.join(home, 'shared', 'security.jsonl'),
    administrator, notify: (event) => { notifications.push(event); },
  };
  const matrix = {
    version: 'v1.3-khyos', revision: 1, shared_scope: [path.join(home, 'shared')], high_risk_actions: [],
    budget_policy: { unit: 'input_output_tokens', reset: 'UTC' }, app_sources: [],
    terminals: ['cli', 'web'].map((id) => ({ terminal_id: id, role: 'developer', state: 'active', tools: ['Write'],
      denied_tools: [], data_scope: [path.join(home, id)], allowed_commands: [], max_tokens_per_task: 100,
      daily_budget: 200, app_capabilities: {} })),
  };
  let kernel;
  t.after(async () => {
    try { for (const handle of handles) await handle.close(); }
    finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
  const options = {
    terminalId: 'host', clientVersion: '0.1.0', mode: 'embedded', entry: require('@khy/core/server'),
    paths: { dataHome: home }, security, onSecurity(value) { kernel = value; },
  };
  return {
    home, administrator, notifications, security, options, matrix,
    get kernel() { return kernel; },
    async boot(extra = {}) {
      const handle = await obtainCoreNode({ ...options, ...extra });
      handles.push(handle);
      return handle;
    },
    async activate() {
      const proposal = await kernel.propose(administrator, matrix);
      return kernel.confirm(administrator, { challenge_id: proposal.challenge_id, digest: proposal.digest, decision: '确认' });
    },
    async bind(id = 'cli', execute) {
      const identity = Object.freeze({});
      const context = { terminal_id: id, task_id: `${id}-task`, action: 'Write', scope: [path.join(home, id)], payload: { content: id } };
      let target = path.join(home, id, 'output.txt');
      let inspected = 0;
      let calls = 0;
      const actions = { Write: {
        inspect() {
          inspected++;
          return { scope_enforced: true, targets: [target], risk: 'normal', usage: {
            task_tokens: 0, day_tokens: 0, reserved_task_tokens: 0, reserved_day_tokens: 0, input_tokens: 1, max_output_tokens: 2,
          } };
        },
        execute: execute || ((payload, input) => {
          calls++;
          fs.writeFileSync(target, payload.content);
          return { task_id: input.task_id, status: 'ok', summary: '完成', result_ref: target, violations: [] };
        }),
      } };
      const port = await kernel.bindTerminal(administrator, id, identity, actions);
      return {
        identity, context, port, actions,
        get calls() { return calls; }, get inspected() { return inspected; },
        redirect(value) { target = value; },
        async envelope() {
          const ticket = await kernel.issue(administrator, context);
          return { from: ticket.issuer, task_id: context.task_id, action: context.action, payload: context.payload, ticket };
        },
      };
    },
  };
}

test('locator boots an inactive kernel; confirmed matrix executes and restores through the real server', async (t) => {
  const f = fixture(t);
  const first = await f.boot();
  assert.equal(f.kernel.matrix, null);
  assert.equal(fs.existsSync(f.security.matrixPath), false);
  const cli = await f.bind();
  await assert.rejects(cli.envelope(), { code: 'CORE_PERMISSION_DENIED' });
  await f.activate();
  const receipt = await cli.port.execute(await cli.envelope());
  assert.equal(fs.readFileSync(receipt.result_ref, 'utf8'), 'cli');
  assert.equal(cli.calls, 1);
  assert.ok(cli.inspected >= 3);
  const oldKernel = f.kernel;
  await first.close();
  assert.throws(() => oldKernel.matrix, { code: 'CORE_SECURITY_CLOSED' });
  await f.boot();
  assert.equal(f.kernel.matrix.revision, 1);
  const restored = await f.bind();
  await restored.port.execute(await restored.envelope());
  const audit = await f.kernel.queryAudit(f.administrator);
  assert.equal(audit.filter((event) => event.action === 'khyos.config.propose').length, 1);
  assert.equal(audit.filter((event) => event.action === 'task.receipt' && event.decision === 'ok').length, 2);
});

test('attached clients cannot bootstrap an independent authority or access the host-only kernel', async (t) => {
  const f = fixture(t);
  const first = await f.boot();
  const owner = f.kernel;
  let callbacks = 0;
  const second = await f.boot({ security: { invalid: true }, onSecurity() { callbacks++; } });
  assert.equal(second.mode, 'attached');
  assert.equal(second.coreId, first.coreId);
  assert.equal(callbacks, 0);
  assert.equal(f.kernel, owner);
  assert.equal(second.security, undefined);
  const locator = JSON.parse(fs.readFileSync(path.join(f.home, 'core', 'locator.json')));
  const response = await fetch(`${locator.endpoint}/core/security`, { method: 'POST', body: '{"role":"admin"}' });
  assert.equal(response.status, 404);
});

test('terminal elevation freezes its bound identity, invalidates its tickets and notifies the administrator', async (t) => {
  const f = fixture(t);
  await f.boot();
  await f.activate();
  const cli = await f.bind();
  const envelope = await cli.envelope();
  await assert.rejects(f.kernel.propose(cli.identity, f.matrix), { code: 'CORE_ADMIN_REQUIRED' });
  assert.equal(f.notifications[0].event, 'forge_admin');
  assert.equal(f.notifications[0].terminal_id, 'cli');
  await assert.rejects(cli.port.execute(envelope), { code: 'CORE_TERMINAL_INACTIVE' });
  assert.equal(cli.calls, 0);
  assert.ok((await f.kernel.queryAudit(f.administrator)).some((event) => event.action === 'terminal.freeze'));
});

test('terminal audit view is restricted to its own issued tasks, not claimed identity or another terminal', async (t) => {
  const f = fixture(t);
  await f.boot();
  await f.activate();
  const cli = await f.bind();
  const web = await f.bind('web');
  await cli.port.execute(await cli.envelope());
  await web.port.execute(await web.envelope());
  const rows = await cli.port.queryAudit({ task_id: cli.context.task_id });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.terminal_id === 'cli' && row.task_id === cli.context.task_id));
  await assert.rejects(cli.port.queryAudit({ terminal_id: 'web', task_id: web.context.task_id }), { code: 'CORE_PERMISSION_DENIED' });
  await assert.rejects(cli.port.queryAudit({}), { code: 'CORE_PERMISSION_DENIED' });
  await assert.rejects(cli.port.queryAudit({ task_id: 'never-issued' }), { code: 'CORE_PERMISSION_DENIED' });
  await assert.rejects(f.kernel.queryAudit({ role: 'administrator' }), { code: 'CORE_ADMIN_REQUIRED' });
});

test('final executor facts are checked again at redemption; changed targets cannot escape their scope', async (t) => {
  const f = fixture(t);
  await f.boot();
  await f.activate();
  const cli = await f.bind();
  const envelope = await cli.envelope();
  cli.redirect(path.join(f.home, 'web', 'escape.txt'));
  await assert.rejects(cli.port.execute(envelope), { code: 'CORE_PERMISSION_DENIED' });
  assert.equal(cli.calls, 0);
  assert.equal(fs.existsSync(path.join(f.home, 'web', 'escape.txt')), false);
});

test('shutdown rejects new work immediately and retains audit until an in-flight receipt is discarded', async (t) => {
  const f = fixture(t);
  const handle = await f.boot();
  await f.activate();
  let release;
  const cli = await f.bind('cli', (_payload, context) => new Promise((resolve) => {
    release = () => resolve({ task_id: context.task_id, status: 'ok', summary: '完成', result_ref: 'artifact', violations: [] });
  }));
  const execution = cli.port.execute(await cli.envelope());
  const rejected = assert.rejects(execution, { code: 'CORE_POLICY_CHANGED' });
  let stopped = false;
  const closing = handle.close().then(() => { stopped = true; });
  await assert.rejects(cli.envelope(), { code: 'CORE_SECURITY_CLOSED' });
  assert.equal(stopped, false);
  assert.equal(fs.existsSync(`${f.security.auditPath}.lock`), true);
  release();
  await rejected;
  await closing;
  const audit = createSecurityAudit({ filePath: f.security.auditPath });
  try { assert.ok(audit.query().some((event) => event.action === 'task.receipt' && event.decision === 'discarded')); }
  finally { audit.close(); }
});

for (const stage of ['matrix', 'listen', 'callback', 'locator']) {
  test(`startup failure at ${stage} releases owned locks and never activates configuration`, async (t) => {
    const f = fixture(t);
    if (stage === 'matrix') fs.writeFileSync(f.security.matrixPath, '{broken');
    if (stage === 'listen') t.mock.method(http.Server.prototype, 'listen', function () {
      queueMicrotask(() => this.emit('error', new Error('injected listen failure')));
      return this;
    });
    if (stage === 'locator') {
      fs.mkdirSync(path.join(f.home, 'core'));
      fs.mkdirSync(path.join(f.home, 'core', 'locator.json.tmp'));
    }
    const extra = stage === 'callback' ? { onSecurity() { throw new Error('injected callback failure'); } } : {};
    await assert.rejects(f.boot(extra));
    assert.equal(fs.existsSync(path.join(f.home, 'core', 'core.lock')), false);
    assert.equal(fs.existsSync(`${f.security.matrixPath}.lock`), false);
    assert.equal(fs.existsSync(`${f.security.auditPath}.lock`), false);
    assert.equal(fs.existsSync(f.security.matrixPath), stage === 'matrix');
  });
}

test('direct server cannot start twice or restart a closed security instance', async (t) => {
  const f = fixture(t);
  const server = createCoreServer({ dataHome: f.home, security: f.security });
  await server.start();
  try { await assert.rejects(server.start(), { code: 'CORE_INVALID_ARGUMENT' }); }
  finally { await server.close(); }
  await assert.rejects(server.start(), { code: 'CORE_INVALID_ARGUMENT' });
});
