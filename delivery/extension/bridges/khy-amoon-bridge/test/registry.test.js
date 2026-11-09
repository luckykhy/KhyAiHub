'use strict';

/**
 * registry.test.js — the scope/kill-switch/capability gates of the single tool
 * exit. Uses stubs: no ADB, no HTTP, no model.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('../lib/contracts');
const { createRegistry } = require('../lib/registry');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoon-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stubPhoneTools() {
  const out = {};
  for (const name of [
    'phone_screenshot',
    'phone_ui_dump',
    'phone_info',
    'phone_app_list',
    'phone_ls',
    'phone_exec',
  ]) {
    out[name] = async () => ({ ok: true, tool: name });
  }
  return out;
}

function makeRegistry(t, configOverride = {}) {
  const dir = tempDir(t);
  const captured = { args: null };
  const config = {
    enabled: true,
    allowPhoneAsk: false,
    stateDir: dir,
    paths: { capability: path.join(dir, 'capability.json') },
    ...configOverride,
  };
  const localTools = {
    call: async (name, args) => {
      captured.args = args;
      if (name === 'khy.ask') return { ok: true, data: { pending: true, job_id: 'job-abcdefgh' } };
      return { ok: true, data: { tool: name } };
    },
    waitForJob: async () => ({ state: 'done', id: 'job-abcdefgh', result: { answer: 'stub' } }),
    status: () => ({ counters: {}, tools: ['khy.ask'] }),
    close: async () => {},
    stateDir: dir,
  };
  const tasks = {
    status: () => ({ started: true, state_dir: path.join(dir, 'tasks'), counts: { pending: 0 } }),
  };
  const registry = createRegistry({
    config,
    deps: {
      adb: { shell: async () => ({ exit: 0 }), push: async () => ({}), pull: async () => ({}) },
      localTools,
      phoneTools: stubPhoneTools(),
      getMailbox: () => null,
      getWireless: () => null,
      getTasks: () => tasks,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    },
  });
  return { registry, config, captured, dir };
}

const OPERATOR = { kind: 'operator', scope: 'operator', tokenId: 'op', source: 'test' };

test('registry exposes exactly the 12 wire tools and no local PC tools', async (t) => {
  const { registry } = makeRegistry(t);
  assert.equal(registry.names().length, 12);
  for (const name of ['exec', 'read', 'write', 'rm', 'open', 'screen.shot', 'khy.ask', 'task.submit']) {
    assert.equal(registry.get(name), null, `${name} must not be registered`);
    await assert.rejects(
      () => registry.call(name, {}, { principal: OPERATOR }),
      (err) => err.code === 'not_found'
    );
  }
});

test('dotted phone shorthand resolves to the wire tools', (t) => {
  const { registry } = makeRegistry(t);
  assert.equal(registry.get('phone.info').name, 'phone_info');
  assert.equal(registry.get('phone.exec').name, 'phone_exec');
  assert.equal(registry.get('phone.ls').name, 'phone_ls');
  assert.equal(registry.get('phone.app.list').name, 'phone_app_list');
  assert.equal(registry.get('phone.shot').name, 'phone_screenshot');
  assert.equal(registry.get('phone.shell'), null);
  assert.equal(registry.get('khy.ask'), null);
});

test('dotted phone shorthand reaches the same handler', async (t) => {
  const { registry } = makeRegistry(t);
  const dotted = await registry.call('phone.info', {}, { principal: OPERATOR });
  const wire = await registry.call('phone_info', {}, { principal: OPERATOR });
  assert.equal(dotted.ok, true);
  assert.equal(dotted.data.tool, 'phone_info');
  assert.deepEqual(dotted.data, wire.data);
});

test('a missing principal is forbidden instead of defaulting to operator', async (t) => {
  const { registry } = makeRegistry(t);
  await assert.rejects(() => registry.call('ping', {}, {}), (err) => err.code === 'forbidden_scope');
  await assert.rejects(() => registry.call('ping', {}, undefined), (err) => err.code === 'forbidden_scope');
});

test('KHY_AMOON_ENABLED=0 blocks every non-diagnostic tool', async (t) => {
  const { registry } = makeRegistry(t, { enabled: false });
  for (const name of ['phone_info', 'phone_exec', 'phone_screenshot', 'khy_ask', 'amoon_send']) {
    await assert.rejects(
      () => registry.call(name, {}, { principal: OPERATOR }),
      (err) => err.code === 'bridge_disabled',
      `${name} must be blocked by the kill switch`
    );
  }
  const ping = await registry.call('ping', {}, { principal: OPERATOR });
  assert.equal(ping.ok, true);
});

test('file scope never reaches khy_ask or phone tools', async (t) => {
  const { registry } = makeRegistry(t);
  const file = { kind: 'file', scope: 'file', source: 'mailbox' };
  for (const name of ['khy_ask', 'phone_info', 'phone_exec', 'amoon_send']) {
    await assert.rejects(() => registry.call(name, {}, { principal: file }), (err) => err.code === 'forbidden_scope');
  }
  const ping = await registry.call('ping', {}, { principal: file });
  assert.equal(ping.ok, true);
});

test('phone khy_ask needs both the env flag and capability.http=true', async (t) => {
  const { registry, config, captured, dir } = makeRegistry(t);
  const phone = { kind: 'phone', scope: 'phone', tokenId: 'phone-1', source: 'http' };

  await assert.rejects(
    () => registry.call('khy_ask', { question: 'x' }, { principal: phone }),
    (err) => err.code === 'phone_ask_disabled'
  );

  config.allowPhoneAsk = true;
  await assert.rejects(
    () => registry.call('khy_ask', { question: 'x' }, { principal: phone }),
    (err) => err.code === 'phone_ask_disabled',
    'allow flag alone is not enough without capability.http'
  );

  fs.writeFileSync(
    path.join(dir, 'capability.json'),
    JSON.stringify({ status: 'verified', http: false, shell: true })
  );
  await assert.rejects(
    () => registry.call('khy_ask', { question: 'x' }, { principal: phone }),
    (err) => err.code === 'phone_ask_disabled',
    'verified status must not imply http'
  );

  fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify({ status: 'verified', http: true }));
  const result = await registry.call('khy_ask', { question: 'x' }, { principal: phone });
  assert.equal(result.ok, true);
  assert.equal(captured.args.max_turns, 1);
  assert.equal(captured.args.cwd, '');
  assert.deepEqual(captured.args.allowed_tools, [C.TOOL_POLICY.sentinelTool]);

  // phone ask is limited to 3/min; the first call above plus two more hit it.
  await registry.call('khy_ask', { question: 'y' }, { principal: phone });
  await registry.call('khy_ask', { question: 'z' }, { principal: phone });
  await assert.rejects(
    () => registry.call('khy_ask', { question: 'over' }, { principal: phone }),
    (err) => err.code === 'rate_limited'
  );
});

test('status filters tools by scope and hides task state paths from phone/file', async (t) => {
  const { registry } = makeRegistry(t);
  const operator = registry.status('operator');
  assert.equal(operator.tool_count, 12);
  assert.ok(operator.tasks.state_dir);

  const phone = registry.status('phone');
  assert.deepEqual(phone.tools.sort(), ['bridge_status', 'khy_ask', 'mailbox_status', 'ping']);
  assert.equal(phone.tasks.state_dir, undefined);

  const file = registry.status('file');
  assert.deepEqual(file.tools.sort(), ['bridge_status', 'mailbox_status', 'ping']);
  assert.equal(file.tasks.state_dir, undefined);

  const defaulted = registry.status();
  assert.equal(defaulted.tool_count, 3, 'unknown scope must fail closed to file');
});
