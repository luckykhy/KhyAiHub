'use strict';

// Co-located unit test for amooMailbox.js.
//
// The mailbox is the fallback channel, so the cases pin the two properties that
// decide whether it is usable at all:
//   - a result that never arrives must end in a TIMEOUT with the cmd file cleaned
//     up, not in a hang (the bridge's mailbox worker is single-threaded, so a
//     hung command freezes every later one),
//   - ids are deterministic when seeded and unique when not, so a caller can
//     correlate a pushed command with the pulled result.
// `runAdb` is replaced by a recorder; the filesystem is a real temp dir.

const test = require('node:test').test;
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function pinSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-amoo-mb-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.KHY_DATA_HOME = path.join(root, 'data');
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KHY_AMOO_')) {
      delete process.env[key];
    }
  }
  return root;
}

const sandbox = pinSandbox();

const { resolveAmooConfig } = require('./amooBridgeConfig');
const {
  AmooBridgeMailbox,
  buildMailboxId,
  buildCommandFile,
  parseResultFile,
  shouldUseMailbox,
} = require('./amooMailbox');

function makeClientDouble(handlers = {}) {
  const calls = [];
  return {
    calls,
    async runAdb(argv) {
      calls.push(argv.slice());
      const joined = argv.join(' ');
      for (const [pattern, handler] of Object.entries(handlers)) {
        if (joined.includes(pattern)) {
          return handler(argv);
        }
      }
      return { ok: true, code: 0, stdout: '', stderr: '', argv, error: null };
    },
  };
}

function makeMailbox(overrides = {}) {
  const config = resolveAmooConfig({
    KHY_AMOO_ADB_PATH: 'C:/fake/adb.exe',
    KHY_AMOO_MAILBOX_TIMEOUT_MS: '2000',
    KHY_AMOO_MAILBOX_POLL_MS: '100',
  });
  const client = overrides.client || makeClientDouble();
  return {
    config,
    client,
    mailbox: new AmooBridgeMailbox({
      config,
      client,
      sleep: overrides.sleep || (async () => {}),
      now: overrides.now,
      getAppDataDir: (...segments) => path.join(sandbox, ...segments),
    }),
  };
}

test('buildMailboxId is deterministic when seeded and unique when not', () => {
  assert.equal(buildMailboxId('khy', 'seed1'), 'khy_seed1');
  assert.equal(buildMailboxId('khy', 'seed1'), 'khy_seed1');
  const a = buildMailboxId('khy');
  const b = buildMailboxId('khy');
  assert.notEqual(a, b);
  assert.match(a, /^khy_[a-z0-9]+$/);
  // A hostile seed is sanitised, not trusted.
  assert.equal(buildMailboxId('khy', '../etc/passwd'), 'khy_etcpasswd');
  assert.equal(buildMailboxId('', null).startsWith('khy_'), true);
});

test('buildCommandFile serialises with a ts and never re-quotes through a shell', () => {
  const text = buildCommandFile({ id: 'khy_1', tool: 'clipboard', args: { op: 'set', text: '中文 任务' } });
  const parsed = JSON.parse(text);
  assert.equal(parsed.id, 'khy_1');
  assert.equal(parsed.tool, 'clipboard');
  assert.equal(parsed.args.text, '中文 任务');
  assert.ok(Number.isFinite(parsed.ts));
  // A missing args object becomes {} rather than undefined.
  assert.deepEqual(JSON.parse(buildCommandFile({ id: 'x', tool: 'ping' })).args, {});
});

test('parseResultFile rejects non-JSON instead of guessing', () => {
  assert.equal(parseResultFile('not json').ok, false);
  assert.equal(parseResultFile('').ok, false);
  const ok = parseResultFile('{"id":"khy_1","ok":true,"pong":1}');
  assert.equal(ok.ok, true);
  assert.equal(ok.id, 'khy_1');
  assert.equal(ok.body.pong, 1);
});

test('shouldUseMailbox is a fallback, never the default', () => {
  assert.equal(shouldUseMailbox({ mailboxEnabled: true, httpOk: false, attempt: 1 }), true);
  assert.equal(shouldUseMailbox({ mailboxEnabled: true, httpOk: true, attempt: 1 }), false);
  assert.equal(shouldUseMailbox({ mailboxEnabled: false, httpOk: false, attempt: 1 }), false);
  assert.equal(shouldUseMailbox({ mailboxEnabled: true, httpOk: false, attempt: 0 }), false);
});

test('a successful call pushes the command, pulls the result and cleans up', async () => {
  const client = makeClientDouble({
    pull: (argv) => {
      // Simulate the device having produced the result file.
      const remote = argv[3];
      const local = argv[4];
      const id = remote.match(/result_(.+)\.json$/)[1];
      fs.writeFileSync(local, JSON.stringify({ id, tool: 'clipboard', ok: true, op: 'set' }), 'utf8');
      return { ok: true, code: 0, stdout: '', stderr: '', argv, error: null };
    },
  });
  const { mailbox } = makeMailbox({ client });
  const result = await mailbox.call('clipboard', { op: 'set', text: 'hi' }, { id: 'fixed1' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.id, 'khy_fixed1');
  assert.equal(result.body.ok, true);
  assert.equal(result.error, null);

  const pushed = client.calls.find((argv) => argv[2] === 'push');
  assert.deepEqual(pushed, [
    '-s',
    '192.168.2.46:33743',
    'push',
    path.join(sandbox, 'amoo', 'mailbox', 'cmd_khy_fixed1.json'),
    '/sdcard/bridge-amoobridge/cmd_khy_fixed1.json',
  ]);
  // The remote result is removed so the next call cannot read a stale answer.
  const removed = client.calls.filter((argv) => argv[2] === 'shell' && argv[3] === 'rm');
  assert.equal(removed.length, 1);
  assert.equal(removed[0][5], '/sdcard/bridge-amoobridge/result_khy_fixed1.json');
});

test('a bridge-level failure inside a result is reported, not swallowed', async () => {
  const client = makeClientDouble({
    pull: (argv) => {
      const id = argv[3].match(/result_(.+)\.json$/)[1];
      fs.writeFileSync(
        argv[4],
        JSON.stringify({ id, tool: 'ui_dump', ok: false, error: 'unknown tool: ui_dump' }),
        'utf8'
      );
      return { ok: true, code: 0, stdout: '', stderr: '', argv, error: null };
    },
  });
  const { mailbox } = makeMailbox({ client });
  const result = await mailbox.call('ui_dump', {}, { id: 'f2' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'unknown tool: ui_dump');
});

test('a result that never arrives ends in a timeout and cleans up', async () => {
  const client = makeClientDouble(); // pull always fails: no result ever appears
  const { mailbox, config } = makeMailbox({ client });
  const started = Date.now();
  const result = await mailbox.call('ping', {}, { id: 't1' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'timeout');
  assert.equal(result.error.includes('信箱等待超时'), true);
  assert.match(result.error, /2000ms/);
  // Bounded by the configured deadline, not by the number of polls.
  assert.ok(Date.now() - started < 5000);
  const removed = client.calls.filter((argv) => argv[2] === 'shell' && argv[3] === 'rm');
  assert.equal(removed.length, 2); // both the cmd and the result file
  assert.equal(mailbox.lastError(), 'mailbox_timeout');
  assert.equal(config.mailbox.timeoutMs, 2000);
});

test('a failed push short-circuits without polling', async () => {
  const client = makeClientDouble({
    push: () => ({ ok: false, code: 1, stdout: '', stderr: 'Permission denied', argv: [], error: 'adb_nonzero_exit' }),
  });
  const { mailbox } = makeMailbox({ client });
  const result = await mailbox.call('ping', {}, { id: 'p1' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Permission denied/);
  assert.equal(client.calls.some((argv) => argv[2] === 'pull'), false);
  // The transport error is kept verbatim rather than being flattened to a label.
  assert.equal(mailbox.lastError(), 'adb_nonzero_exit');
});

test('readHeartbeat reads status.json through the shell', async () => {
  const client = makeClientDouble({
    'status.json': () => ({
      ok: true,
      code: 0,
      stdout: '{"running":true,"http_port":8896,"pid":31969}',
      stderr: '',
      argv: [],
      error: null,
    }),
  });
  const { mailbox } = makeMailbox({ client });
  const result = await mailbox.readHeartbeat();
  assert.equal(result.ok, true);
  assert.match(result.raw, /"running":true/);
  // The whole device-side command is ONE argv element — that is what keeps a
  // local shell out of the path.
  assert.deepEqual(client.calls[0], [
    '-s',
    '192.168.2.46:33743',
    'shell',
    'cat /sdcard/bridge-amoobridge/status.json',
  ]);
});
