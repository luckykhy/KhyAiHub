'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMatrixPolicy, createActionAuthority, createSecurityAudit } = require('@khy/core/server');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-matrix-'));
  for (const child of ['cli', 'web', 'shared']) fs.mkdirSync(path.join(dir, child));
  const cleanup = [];
  t.after(() => {
    for (const close of cleanup) close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const matrix = {
    version: 'v1.3-khyos', revision: 1, shared_scope: [path.join(dir, 'shared')], high_risk_actions: [],
    budget_policy: { unit: 'input_output_tokens', reset: 'UTC' }, app_sources: [],
    terminals: ['cli', 'web'].map((terminal_id) => ({
      terminal_id, role: 'developer', state: 'active', tools: ['Write', 'shell.exec', 'git.push', 'app.install', 'app.list'],
      denied_tools: [], data_scope: [path.join(dir, terminal_id)], allowed_commands: ['git'],
      max_tokens_per_task: 100, daily_budget: 200, app_capabilities: {},
    })),
  };
  const context = { terminal_id: 'cli', task_id: 'task-1', action: 'Write', scope: [path.join(dir, 'cli')], payload: {} };
  const facts = {
    scope_enforced: true, targets: [path.join(dir, 'cli', 'new.txt')], risk: 'normal',
    usage: { task_tokens: 0, day_tokens: 0, reserved_task_tokens: 0, reserved_day_tokens: 0, input_tokens: 10, max_output_tokens: 20 },
  };
  return { dir, matrix, context, facts, cleanup, check: () => createMatrixPolicy(matrix).check(context, facts) };
}

test('absent matrix fails closed without interpreting terminal claims', () => {
  assert.equal(createMatrixPolicy(null).check({ role: 'admin', approved: true }).status, 'need_human');
});

test('policy snapshot is immutable and cannot be widened by its caller', (t) => {
  const f = fixture(t);
  const policy = createMatrixPolicy(f.matrix);
  f.matrix.terminals[0].tools.push('unexpected');
  assert.equal(policy.check(f.context, f.facts).allowed, true);
  assert.equal(policy.check({ ...f.context, action: 'unexpected' }, f.facts).allowed, false);
  assert.throws(() => policy.matrix.terminals[0].tools.push('unexpected'), TypeError);
});

for (const [label, change] of [
  ['duplicate id', (f) => { f.matrix.terminals[1].terminal_id = 'cli'; }],
  ['relative path', (f) => { f.matrix.terminals[0].data_scope = ['relative']; }],
  ['overlapping private roots', (f) => { f.matrix.terminals[0].data_scope = [f.dir]; }],
  ['shared root enclosing private data', (f) => { f.matrix.shared_scope = [f.dir]; }],
  ['missing budget', (f) => { delete f.matrix.terminals[0].daily_budget; }],
  ['unsupported version', (f) => { f.matrix.version = 'v2'; }],
  ['unknown field', (f) => { f.matrix.approved = true; }],
  ['empty capability evidence', (f) => { f.matrix.terminals[0].app_capabilities['app.list'] = { status: 'available', evidence: '' }; }],
]) {
  test(`invalid matrix rejects ${label}`, (t) => {
    const f = fixture(t);
    change(f);
    assert.throws(() => createMatrixPolicy(f.matrix));
  });
}

for (const [label, change] of [
  ['unknown terminal', (f) => { f.context.terminal_id = 'other'; }],
  ['frozen terminal', (f) => { f.matrix.terminals[0].state = 'frozen'; }],
  ['unregistered terminal', (f) => { f.matrix.terminals[0].state = 'unregistered'; }],
  ['missing allow', (f) => { f.matrix.terminals[0].tools = []; }],
  ['explicit deny', (f) => { f.matrix.terminals[0].denied_tools = ['Write']; }],
  ['missing scope enforcement', (f) => { delete f.facts.scope_enforced; }],
  ['scope enforcement disabled', (f) => { f.facts.scope_enforced = false; }],
  ['unknown risk', (f) => { delete f.facts.risk; }],
  ['missing usage', (f) => { delete f.facts.usage; }],
  ['negative usage', (f) => { f.facts.usage.task_tokens = -1; }],
  ['non-finite usage', (f) => { f.facts.usage.task_tokens = Infinity; }],
  ['cross-terminal scope', (f) => { f.context.scope = [path.join(f.dir, 'web')]; }],
  ['cross-terminal target', (f) => { f.facts.targets = [path.join(f.dir, 'web', 'new.txt')]; }],
  ['prefix sibling', (f) => { f.facts.targets = [path.join(f.dir, 'cli-other', 'new.txt')]; }],
  ['traversal', (f) => { f.facts.targets = [path.join(f.dir, 'cli', '..', 'web', 'new.txt')]; }],
  ['empty ticket scope', (f) => { f.context.scope = []; }],
  ['relative target', (f) => { f.facts.targets = ['new.txt']; }],
  ['forged approval', (f) => { f.context.action = 'git.push'; f.context.payload = { approved: true, role: 'admin' }; }],
]) {
  test(`policy denies ${label}`, (t) => {
    const f = fixture(t);
    change(f);
    assert.equal(f.check().allowed, false);
  });
}

test('shared targets require explicit ticket scope', (t) => {
  const f = fixture(t);
  f.facts.targets = [path.join(f.dir, 'shared', 'contract.json')];
  assert.equal(f.check().allowed, false);
  f.context.scope.push(path.join(f.dir, 'shared'));
  assert.equal(f.check().allowed, true);
});

test('junction into another terminal is rejected for a new leaf', (t) => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.dir, 'web'), path.join(f.dir, 'cli', 'linked'), 'junction');
  f.facts.targets = [path.join(f.dir, 'cli', 'linked', 'new.txt')];
  assert.equal(f.check().allowed, false);
});

test('parent traversal is rejected before lexical normalization can hide a junction', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'web', 'nested'));
  fs.symlinkSync(path.join(f.dir, 'web', 'nested'), path.join(f.dir, 'cli', 'linked'), 'junction');
  f.facts.targets = [`${f.dir}${path.sep}cli${path.sep}linked${path.sep}..${path.sep}new.txt`];
  assert.equal(f.check().allowed, false);
});

test('an outside directory entry is denied even when its link target is inside scope', (t) => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.dir, 'cli'), path.join(f.dir, 'web', 'linked'), 'junction');
  f.facts.targets = [path.join(f.dir, 'web', 'linked')];
  assert.equal(f.check().allowed, false);
});

test('path whitespace is not silently removed from executor facts', (t) => {
  const f = fixture(t);
  f.context.scope = [path.join(f.dir, 'cli', 'private')];
  f.facts.targets = [`${f.context.scope[0]}\u00a0`];
  assert.equal(f.check().allowed, false);
  f.context.scope = [...f.facts.targets];
  assert.equal(f.check().allowed, true);
});

test('a matrix root redirected after approval cannot widen scope', (t) => {
  const f = fixture(t);
  const policy = createMatrixPolicy(f.matrix);
  fs.renameSync(path.join(f.dir, 'cli'), path.join(f.dir, 'cli-old'));
  fs.symlinkSync(path.join(f.dir, 'web'), path.join(f.dir, 'cli'), 'junction');
  assert.equal(policy.check(f.context, f.facts).allowed, false);
});

test('budget includes pending reservations and output upper bound', (t) => {
  const f = fixture(t);
  f.facts.usage.task_tokens = 70;
  assert.equal(f.check().allowed, true);
  f.facts.usage.reserved_task_tokens = 1;
  assert.equal(f.check().status, 'need_split');
  f.facts.usage.task_tokens = 0;
  f.facts.usage.reserved_task_tokens = 0;
  f.facts.usage.day_tokens = 170;
  assert.equal(f.check().allowed, true);
  f.facts.usage.reserved_day_tokens = 1;
  assert.equal(f.check().status, 'denied');
  f.context.task_id = 'split-task';
  assert.equal(f.check().status, 'denied');
});

test('shell commands require a structured shell-free allowlisted executable', (t) => {
  const f = fixture(t);
  f.context.action = 'shell.exec';
  assert.equal(f.check().allowed, false);
  f.facts.command = { executable: 'git', argv: ['status'], shell: true };
  assert.equal(f.check().allowed, false);
  f.facts.command.shell = false;
  assert.equal(f.check().allowed, true);
  f.facts.command.executable = 'git status; dangerous';
  assert.equal(f.check().allowed, false);
});

for (const [executable, argv] of [
  ['git', ['push']], ['git', ['-C', 'repo', 'push', '--force']],
  ['git', ['config', 'alias.sync', 'push']], ['node', ['-e', 'code']],
  ['powershell.exe', ['-Command', 'code']], ['taskkill', ['/PID', '123']],
  ['git', ['-c', 'alias.publish=!git push', 'publish']],
  ['git', ['--config-env=alias.publish=PUBLISH_COMMAND', 'publish']],
  ['git', ['publish']],
]) {
  test(`shell.exec cannot hide high-risk ${executable} ${argv[0]}`, (t) => {
    const f = fixture(t);
    f.context.action = 'shell.exec';
    f.matrix.terminals[0].allowed_commands = [executable];
    f.facts.command = { executable, argv, shell: false };
    assert.equal(f.check().status, 'need_human');
  });
}

test('unknown app actions cannot bypass capability checks', (t) => {
  const f = fixture(t);
  f.context.action = 'app.unknown';
  f.matrix.terminals[0].tools.push(f.context.action);
  assert.equal(f.check().status, 'failed');
});

test('built-in and administrator-added high-risk actions require confirmation', (t) => {
  const f = fixture(t);
  f.context.action = 'git.push';
  assert.equal(f.check().status, 'need_human');
  f.context.action = 'Write';
  f.matrix.high_risk_actions = ['Write'];
  assert.equal(f.check().status, 'need_human');
  f.matrix.high_risk_actions = [];
  f.facts.risk = 'high';
  assert.equal(f.check().status, 'need_human');
});

test('app tools require container role, existing capability and exact local package digest', (t) => {
  const f = fixture(t);
  f.context.action = 'app.list';
  assert.equal(f.check().status, 'failed');
  f.matrix.terminals[0].app_capabilities['app.list'] = { status: 'available', evidence: 'test executor' };
  assert.equal(f.check().status, 'failed');
  f.matrix.terminals[0].role = 'container';
  assert.equal(f.check().allowed, true);
  f.matrix.terminals[0].app_capabilities['app.list'].status = 'missing';
  assert.equal(f.check().status, 'failed');
  f.context.action = 'app.install';
  f.matrix.terminals[0].app_capabilities['app.install'] = { status: 'available', evidence: 'test executor' };
  assert.equal(f.check().status, 'denied');
  f.facts.app_source = { path: path.join(f.dir, 'cli', 'local.apk'), sha256: 'a'.repeat(64) };
  f.matrix.app_sources = [{ ...f.facts.app_source }];
  assert.equal(f.check().status, 'need_human');
  f.facts.app_source.sha256 = 'b'.repeat(64);
  assert.equal(f.check().status, 'denied');
});

test('authority checks the matrix at issue and redemption before touching disk', async (t) => {
  const f = fixture(t);
  const audit = createSecurityAudit({ filePath: path.join(f.dir, 'audit.jsonl') });
  f.cleanup.push(() => audit.close());
  let policy = createMatrixPolicy(null);
  const authority = createActionAuthority({ audit, notify() {}, authorize: (context) => policy.check(context, f.facts) });
  const target = f.facts.targets[0];
  const terminal = authority.registerTerminal('cli', { Write: () => {
    fs.writeFileSync(target, 'written');
    return { task_id: 'task-1', status: 'ok', summary: '已写入', result_ref: target, violations: [] };
  } });
  assert.throws(() => authority.issue(f.context), { code: 'CORE_PERMISSION_DENIED' });
  assert.equal(fs.existsSync(target), false);
  policy = createMatrixPolicy(f.matrix);
  const ticket = authority.issue(f.context);
  f.matrix.terminals[0].denied_tools = ['Write'];
  policy = createMatrixPolicy(f.matrix);
  const envelope = { from: authority.issuer, task_id: 'task-1', action: 'Write', payload: {}, ticket };
  await assert.rejects(terminal.execute(envelope), { code: 'CORE_PERMISSION_DENIED' });
  assert.equal(fs.existsSync(target), false);
  f.matrix.terminals[0].denied_tools = [];
  policy = createMatrixPolicy(f.matrix);
  envelope.ticket = authority.issue(f.context);
  assert.equal((await terminal.execute(envelope)).status, 'ok');
  assert.equal(fs.readFileSync(target, 'utf8'), 'written');
});
