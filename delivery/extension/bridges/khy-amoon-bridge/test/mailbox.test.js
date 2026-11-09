'use strict';

/**
 * mailbox.test.js — file mailbox and phone bootstrap, with a fake ADB.
 *
 * The fake implements the frozen AdbTransport surface (shell/push/pull) against
 * a temp directory that stands in for /sdcard. No device is touched.
 *
 * Covered:
 *   - happy path: cmd -> executor -> res_<id>.json, cmd removed
 *   - atomic write (push to tmp, mv to final) and atomic read (pull, never cat)
 *   - idempotency: existing res -> skip execution, cmd moved to done/
 *   - half-written JSON: parse retry inside one tick
 *   - permanently broken JSON -> failed/ + error result
 *   - file scope rejection (khy_ask), expired command
 *   - bounded concurrency
 *   - result retention (newest N)
 *   - invalid command filenames
 *   - bootstrap: asset push, LF normalization, chmod, idempotent second run,
 *     token.txt only when a phone token is supplied
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('../lib/contracts');
const M = require('../lib/mailbox');
const { createBootstrap } = require('../lib/bootstrap');

// ── Fake ADB (transport-level) ──────────────────────────────────────────────

/**
 * Split a shell command into argv, honouring single/double quotes and
 * backslash escapes outside quotes (enough for the commands this module emits).
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitArgs(text) {
  const args = [];
  let current = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      if (current === null) current = '';
      current += text[i + 1] === undefined ? '' : text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      if (current === null) current = '';
      while (i < text.length && text[i] !== quote) {
        current += text[i];
        i += 1;
      }
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== null) {
        args.push(current);
        current = null;
      }
      i += 1;
      continue;
    }
    if (current === null) current = '';
    current += ch;
    i += 1;
  }
  if (current !== null) args.push(current);
  return args;
}

class FakePhone {
  /**
   * @param {string} root remote root, e.g. '/phone'
   * @param {string} baseDir local directory standing in for /sdcard
   */
  constructor(root, baseDir) {
    this.root = root;
    this.baseDir = baseDir;
    this.commands = [];
    this.pushes = [];
    this.pulls = [];
    /** @type {null|((remote:string,local:string,src:string)=>{truncateTo?:number}|void)} */
    this.pullHook = null;
    this.failNextPushes = 0;
    this.chmods = [];
  }

  toLocal(remote) {
    const value = String(remote);
    if (value !== this.root && !value.startsWith(`${this.root}/`)) {
      throw Object.assign(new Error(`path escapes fake phone root: ${value}`), { fakeExit: 1 });
    }
    const rel = value.slice(this.root.length).replace(/^\/+/, '');
    const parts = rel.split('/').filter(Boolean);
    if (parts.some((part) => part === '..' || part === '.')) {
      throw Object.assign(new Error(`path traversal: ${value}`), { fakeExit: 1 });
    }
    return path.join(this.baseDir, ...parts);
  }

  interpret(raw) {
    let cmd = String(raw).trim();
    const redirect = cmd.indexOf(' 2>/dev/null');
    if (redirect >= 0) cmd = cmd.slice(0, redirect).trim();

    if (cmd.startsWith('mkdir -p ')) {
      for (const dir of splitArgs(cmd.slice('mkdir -p '.length))) {
        fs.mkdirSync(this.toLocal(dir), { recursive: true });
      }
      return '';
    }
    if (cmd.startsWith('ls -1t ')) {
      return this.list(cmd.slice('ls -1t '.length), true);
    }
    if (cmd.startsWith('ls -1 ')) {
      return this.list(cmd.slice('ls -1 '.length), false);
    }
    if (cmd.startsWith('wc -c < ')) {
      const target = splitArgs(cmd.slice('wc -c < '.length))[0];
      const file = this.toLocal(target);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw Object.assign(new Error(`wc: ${target}: No such file`), { fakeExit: 1 });
      }
      return `${fs.statSync(file).size}\n`;
    }
    if (cmd.startsWith('mv -f ')) {
      const argv = splitArgs(cmd.slice('mv -f '.length));
      const from = this.toLocal(argv[0]);
      const to = this.toLocal(argv[1]);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return '';
    }
    if (cmd.startsWith('rm -f ')) {
      for (const target of splitArgs(cmd.slice('rm -f '.length))) {
        fs.rmSync(this.toLocal(target), { force: true });
      }
      return '';
    }
    if (cmd.startsWith('chmod ')) {
      const argv = splitArgs(cmd.slice('chmod '.length));
      this.chmods.push({ mode: argv[0], remote: argv[1] });
      const file = this.toLocal(argv[1]);
      if (!fs.existsSync(file)) {
        throw Object.assign(new Error(`chmod: ${argv[1]}: No such file`), { fakeExit: 1 });
      }
      return '';
    }
    const testMatch = /^test -f (.+) && echo 1 \|\| echo 0$/.exec(cmd);
    if (testMatch) {
      const file = this.toLocal(splitArgs(testMatch[1])[0]);
      return fs.existsSync(file) && fs.statSync(file).isFile() ? '1\n' : '0\n';
    }
    if (cmd === 'echo ok') return 'ok\n';
    throw Object.assign(new Error(`fake adb: unsupported command: ${cmd}`), { fakeExit: 127 });
  }

  list(dirRaw, newestFirst) {
    const dir = this.toLocal(splitArgs(dirRaw)[0]);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw Object.assign(new Error(`ls: ${dirRaw}: No such directory`), { fakeExit: 1 });
    }
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const full = path.join(dir, entry.name);
        return { name: entry.name, mtime: fs.statSync(full).mtimeMs };
      });
    entries.sort((a, b) => (newestFirst ? b.mtime - a.mtime || b.name.localeCompare(a.name) : a.name.localeCompare(b.name)));
    return entries.map((entry) => `${entry.name}\n`).join('');
  }

  async shell(cmd) {
    this.commands.push(cmd);
    try {
      return { exit: 0, stdout: this.interpret(cmd), stderr: '', truncated: false };
    } catch (err) {
      return { exit: err.fakeExit || 1, stdout: '', stderr: err.message, truncated: false };
    }
  }

  async push(local, remote) {
    this.pushes.push({ local, remote });
    if (this.failNextPushes > 0) {
      this.failNextPushes -= 1;
      throw new Error('injected push failure');
    }
    const dest = this.toLocal(remote);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(local, dest);
    return { bytes: fs.statSync(dest).size, remote };
  }

  async pull(remote, local) {
    this.pulls.push({ remote, local });
    const src = this.toLocal(remote);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      throw Object.assign(new Error(`pull: ${remote}: No such file`), { code: 'ENOENT' });
    }
    fs.mkdirSync(path.dirname(local), { recursive: true });
    const action = this.pullHook ? this.pullHook(remote, local, src) : null;
    if (action && typeof action.truncateTo === 'number') {
      fs.writeFileSync(local, fs.readFileSync(src).subarray(0, action.truncateTo));
    } else {
      fs.copyFileSync(src, local);
    }
    return { bytes: fs.statSync(local).size, local };
  }
}

// ── Test helpers ────────────────────────────────────────────────────────────

const ROOT = '/phone';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoon-mailbox-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t, overrides = {}) {
  const tmp = tempDir(t);
  const phoneDir = path.join(tmp, 'phone');
  fs.mkdirSync(phoneDir, { recursive: true });
  const fake = new FakePhone(ROOT, phoneDir);
  const calls = [];
  const mailbox = M.createMailbox({
    adb: fake,
    root: ROOT,
    localTempDir: path.join(tmp, 'local'),
    claimStableMs: 0,
    retryDelayMs: 1,
    ...overrides,
    executor:
      overrides.executor ||
      (async (command) => {
        calls.push(command);
        return { ok: true, data: { pong: true, tool: command.tool } };
      }),
  });
  t.after(() => mailbox.dispose());
  return { tmp, phoneDir, fake, mailbox, calls };
}

function writeCmd(phoneDir, id, tool, args = {}, extra = {}) {
  fs.mkdirSync(path.join(phoneDir, 'inbox'), { recursive: true });
  const name = `cmd_${id}.json`;
  fs.writeFileSync(
    path.join(phoneDir, 'inbox', name),
    `${JSON.stringify({ v: 1, id, tool, args, ...extra })}\n`,
    'utf8'
  );
  return name;
}

/** claimStableMs=0 still needs one sighting before the claim. */
async function pollTwice(mailbox) {
  const first = await mailbox.tick();
  const second = await mailbox.tick();
  return { first, second };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── Protocol ────────────────────────────────────────────────────────────────

test('parseCommand/buildCommand round-trip and reject malformed envelopes', () => {
  const built = M.buildCommand({
    id: 'abcd1234',
    tool: 'ping',
    args: {},
    expiresAt: 1700000000,
  });
  assert.equal(built.v, 1);
  assert.equal(built.id, 'abcd1234');
  assert.equal(built.tool, 'ping');
  assert.match(built.expires_at, /^\d{4}-\d{2}-\d{2}T/);

  const parsed = M.parseCommand(JSON.stringify(built));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.id, 'abcd1234');
  assert.equal(parsed.value.expiresAt, 1700000000000);

  assert.equal(M.parseCommand('{').ok, false);
  assert.equal(M.parseCommand(JSON.stringify({ v: 2, id: 'abcd1234', tool: 'ping' })).ok, false);
  assert.equal(M.parseCommand(JSON.stringify({ v: 1, id: 'x', tool: 'ping' })).ok, false);
  assert.equal(M.parseCommand(JSON.stringify({ v: 1, id: 'abcd1234', tool: 'PING' })).ok, false);
  assert.equal(M.parseCommand(JSON.stringify({ v: 1, id: 'abcd1234', tool: 'ping', args: [] })).ok, false);
  assert.throws(() => M.buildCommand({ id: 'short', tool: 'ping' }), /id/);
  assert.throws(() => M.buildCommand({ id: 'abcd1234', tool: 'Bad Tool' }), /工具名/);
});

test('buildResult keeps the frozen envelope fields', () => {
  const ok = M.buildResult({ id: 'abcd1234', tool: 'ping', ok: true, data: { pong: true }, durationMs: 3 });
  assert.equal(ok.v, 1);
  assert.equal(ok.ok, true);
  assert.equal(ok.duration_ms, 3);
  assert.deepEqual(ok.data, { pong: true });
  assert.equal(ok.error, undefined);

  const bad = M.buildResult({
    id: 'abcd1234',
    tool: 'ping',
    ok: false,
    error: { code: 'forbidden_scope', message: 'no' },
    durationMs: 1,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'forbidden_scope');
});

// ── Mailbox ─────────────────────────────────────────────────────────────────

test('cmd -> executor -> res_<id>.json, atomically, then the command is removed', async (t) => {
  const { phoneDir, fake, mailbox, calls } = setup(t);
  writeCmd(phoneDir, 'cmd00001', 'ping', {});

  const { second } = await pollTwice(mailbox);
  assert.equal(second.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'ping');

  const resFile = path.join(phoneDir, 'outbox', 'res_cmd00001.json');
  assert.ok(fs.existsSync(resFile), 'result must exist in outbox');
  const result = readJson(resFile);
  assert.equal(result.id, 'cmd00001');
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { pong: true, tool: 'ping' });

  assert.ok(!fs.existsSync(path.join(phoneDir, 'inbox', 'cmd_cmd00001.json')));
  assert.ok(!fs.existsSync(path.join(phoneDir, 'working', 'cmd_cmd00001.json')));

  // Atomic write: push went to tmp/, then mv to outbox. Never a direct push.
  const resultPush = fake.pushes.find((p) => p.remote.includes('res_cmd00001.json'));
  assert.ok(resultPush, 'result must be pushed');
  assert.match(resultPush.remote, /\/tmp\/res_cmd00001\.json\.tmp-/);
  assert.ok(
    fake.commands.some((c) => /^mv -f '\/phone\/tmp\/res_cmd00001\.json\.tmp-[^']*' '\/phone\/outbox\/res_cmd00001\.json'$/.test(c)),
    'tmp -> final mv must be issued'
  );

  // Atomic read: the command is pulled, never cat'ed in place.
  assert.ok(fake.pulls.some((p) => p.remote.endsWith('/working/cmd_cmd00001.json')));
  assert.ok(!fake.commands.some((c) => c.startsWith('cat ')), 'must not cat remote files');
});

test('ack_/reply_ files are copied to the local replies index and moved to done/', async (t) => {
  const repliesDir = path.join(tempDir(t), 'replies');
  const { phoneDir, mailbox } = setup(t, { repliesDir });
  fs.mkdirSync(path.join(phoneDir, 'inbox'), { recursive: true });
  fs.writeFileSync(
    path.join(phoneDir, 'inbox', 'ack_ack00001.json'),
    `${JSON.stringify({ v: 1, id: 'msg00001', kind: 'ack', ts: new Date().toISOString() })}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(phoneDir, 'inbox', 'reply_reply0001.json'),
    `${JSON.stringify({ v: 1, id: 'msg00002', kind: 'reply', text: 'hello', ts: new Date().toISOString() })}\n`,
    'utf8'
  );

  await mailbox.tick();

  assert.ok(fs.existsSync(path.join(phoneDir, 'done', 'ack_ack00001.json')));
  assert.ok(fs.existsSync(path.join(phoneDir, 'done', 'reply_reply0001.json')));
  assert.ok(!fs.existsSync(path.join(phoneDir, 'inbox', 'ack_ack00001.json')));
  assert.ok(!fs.existsSync(path.join(phoneDir, 'inbox', 'reply_reply0001.json')));
  assert.equal(mailbox.status().counters.replies, 2);

  const ack = readJson(path.join(repliesDir, 'ack_ack00001.json'));
  assert.equal(ack.kind, 'ack');
  assert.equal(ack.unverified, true);
  const reply = readJson(path.join(repliesDir, 'reply_reply0001.json'));
  assert.equal(reply.kind, 'reply');
  assert.equal(reply.text, 'hello');
  assert.equal(reply.unverified, true);

  // A malformed reply must not stay in the inbox forever.
  fs.writeFileSync(path.join(phoneDir, 'inbox', 'reply_badreply1.json'), '{not json', 'utf8');
  await mailbox.tick();
  assert.ok(fs.existsSync(path.join(phoneDir, 'failed', 'reply_badreply1.json')));
});

test('existing result means the command is not executed again (idempotent skip)', async (t) => {
  const { phoneDir, mailbox, calls } = setup(t);
  fs.mkdirSync(path.join(phoneDir, 'outbox'), { recursive: true });
  fs.writeFileSync(
    path.join(phoneDir, 'outbox', 'res_cmd00002.json'),
    `${JSON.stringify({ v: 1, id: 'cmd00002', tool: 'ping', ok: true, ts: new Date().toISOString(), duration_ms: 0, data: { pong: true } })}\n`
  );
  writeCmd(phoneDir, 'cmd00002', 'ping', {});

  await mailbox.tick();

  assert.equal(calls.length, 0);
  assert.ok(fs.existsSync(path.join(phoneDir, 'done', 'cmd_cmd00002.json')));
  assert.ok(!fs.existsSync(path.join(phoneDir, 'inbox', 'cmd_cmd00002.json')));
  assert.equal(mailbox.status().counters.skippedExistingResult, 1);
  // current depth is 0 after the command moved to done/, even though the
  // cumulative scan counter is 1 (the bug mailbox_status used to report).
  assert.equal(mailbox.status().counts.inbox, 0);
  assert.equal(mailbox.status().counters.scanned, 1);
});

test('duplicate id with the same args is marked replayed', async (t) => {
  const { phoneDir, mailbox, calls } = setup(t);
  writeCmd(phoneDir, 'dup00001', 'ping', { a: 1, b: 2 });
  await pollTwice(mailbox);
  assert.equal(calls.length, 1);
  const first = readJson(path.join(phoneDir, 'outbox', 'res_dup00001.json'));
  assert.equal(typeof first.args_digest, 'string');

  // Same args, different key order: the digest must still match.
  writeCmd(phoneDir, 'dup00001', 'ping', { b: 2, a: 1 });
  await mailbox.tick();
  assert.equal(calls.length, 1, 'same args must not execute again');
  const replayed = readJson(path.join(phoneDir, 'outbox', 'res_dup00001.json'));
  assert.equal(replayed.replayed, true);
  assert.ok(fs.existsSync(path.join(phoneDir, 'done', 'cmd_dup00001.json')));
  assert.equal(mailbox.status().counters.replayed, 1);
});

test('duplicate id with different args writes id_conflict and archives the first result', async (t) => {
  const { phoneDir, mailbox, calls } = setup(t);
  writeCmd(phoneDir, 'dup00002', 'ping', { a: 1 });
  await pollTwice(mailbox);
  assert.equal(calls.length, 1);

  writeCmd(phoneDir, 'dup00002', 'ping', { a: 2 });
  await mailbox.tick();
  assert.equal(calls.length, 1, 'conflicting args must not execute');
  const conflict = readJson(path.join(phoneDir, 'outbox', 'res_dup00002.json'));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'id_conflict');
  assert.ok(fs.existsSync(path.join(phoneDir, 'failed', 'cmd_dup00002.json')));
  const archived = fs
    .readdirSync(path.join(phoneDir, 'outbox'))
    .filter((name) => name.startsWith('res_dup00002.conflict_'));
  assert.equal(archived.length, 1);
  assert.equal(mailbox.status().counters.idConflict, 1);
});

test('half-written JSON is retried inside the tick and then executed', async (t) => {
  let pulls = 0;
  const { phoneDir, fake, mailbox, calls } = setup(t);
  fake.pullHook = (remote, local, src) => {
    if (!remote.endsWith('/working/cmd_cmd00003.json')) return null;
    pulls += 1;
    if (pulls === 1) {
      // Simulate the reader seeing a partially written file.
      return { truncateTo: 12 };
    }
    return null;
  };
  writeCmd(phoneDir, 'cmd00003', 'ping', { verbose: true });

  await pollTwice(mailbox);

  assert.ok(pulls >= 2, 'the command must be re-pulled after a parse failure');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.verbose, true);
  const result = readJson(path.join(phoneDir, 'outbox', 'res_cmd00003.json'));
  assert.equal(result.ok, true);
});

test('permanently broken JSON becomes a failed command with an error result', async (t) => {
  const { phoneDir, mailbox, calls } = setup(t, { parseRetries: 2 });
  fs.mkdirSync(path.join(phoneDir, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(phoneDir, 'inbox', 'cmd_cmd00004.json'), '{"v":1,"id":"cmd00004","tool":');

  await pollTwice(mailbox);

  assert.equal(calls.length, 0);
  const result = readJson(path.join(phoneDir, 'outbox', 'res_cmd00004.json'));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_request');
  assert.ok(fs.existsSync(path.join(phoneDir, 'failed', 'cmd_cmd00004.json')));
});

test('file scope rejects khy_ask without calling the executor', async (t) => {
  const { phoneDir, mailbox, calls } = setup(t);
  writeCmd(phoneDir, 'cmd00005', 'khy_ask', { question: 'hi' });

  await pollTwice(mailbox);

  assert.equal(calls.length, 0);
  const result = readJson(path.join(phoneDir, 'outbox', 'res_cmd00005.json'));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'forbidden_scope');
  assert.ok(fs.existsSync(path.join(phoneDir, 'failed', 'cmd_cmd00005.json')));
});

test('an expired command is rejected before execution', async (t) => {
  const { phoneDir, mailbox, calls } = setup(t);
  const past = Math.floor(Date.now() / 1000) - 60;
  writeCmd(phoneDir, 'cmd00006', 'ping', {}, { expires_at: past });

  await pollTwice(mailbox);

  assert.equal(calls.length, 0);
  const result = readJson(path.join(phoneDir, 'outbox', 'res_cmd00006.json'));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_request');
  assert.match(result.error.message, /过期/);
});

test('concurrency is bounded by maxConcurrency', async (t) => {
  let active = 0;
  let maxActive = 0;
  const { phoneDir, mailbox } = setup(t, {
    maxConcurrency: 2,
    executor: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { ok: true, data: { ok: true } };
    },
  });
  for (let i = 0; i < 6; i += 1) {
    writeCmd(phoneDir, `conc000${i}`, 'ping', { i });
  }

  await pollTwice(mailbox);

  assert.equal(mailbox.status().counters.executed, 6);
  assert.ok(maxActive <= 2, `expected at most 2 concurrent, saw ${maxActive}`);
  assert.equal(maxActive, 2);
});

test('result retention keeps only the newest N results', async (t) => {
  const { phoneDir, mailbox } = setup(t, { resultRetain: 3 });
  const outbox = path.join(phoneDir, 'outbox');
  fs.mkdirSync(outbox, { recursive: true });
  const base = Date.now() / 1000 - 1000;
  for (let i = 0; i < 6; i += 1) {
    const file = path.join(outbox, `res_old0000${i}.json`);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ v: 1, id: `old0000${i}`, tool: 'ping', ok: true, ts: new Date().toISOString(), duration_ms: 0 })}\n`
    );
    fs.utimesSync(file, base + i * 10, base + i * 10);
  }

  await mailbox.tick();

  const left = fs
    .readdirSync(outbox)
    .filter((name) => /^res_.*\.json$/.test(name))
    .sort();
  assert.deepEqual(left, ['res_old00003.json', 'res_old00004.json', 'res_old00005.json']);
  assert.equal(mailbox.status().counters.resultsPruned, 3);
});

test('startup recovery cleans finished working files and requeues unknown ones', async (t) => {
  const { phoneDir, mailbox, calls } = setup(t);
  fs.mkdirSync(path.join(phoneDir, 'working'), { recursive: true });
  fs.mkdirSync(path.join(phoneDir, 'outbox'), { recursive: true });
  fs.mkdirSync(path.join(phoneDir, 'failed'), { recursive: true });

  // A result already exists: the previous run finished; just clean up.
  fs.writeFileSync(
    path.join(phoneDir, 'working', 'cmd_done0001.json'),
    `${JSON.stringify({ v: 1, id: 'done0001', tool: 'ping', args: {} })}\n`
  );
  fs.writeFileSync(
    path.join(phoneDir, 'outbox', 'res_done0001.json'),
    `${JSON.stringify({ v: 1, id: 'done0001', tool: 'ping', ok: true, ts: new Date().toISOString(), duration_ms: 0 })}\n`
  );

  // No result: the command was interrupted. The file-scope surface is
  // idempotent, so recovery puts it back in inbox for the next tick.
  fs.writeFileSync(
    path.join(phoneDir, 'working', 'cmd_lost0001.json'),
    `${JSON.stringify({ v: 1, id: 'lost0001', tool: 'ping', args: {} })}\n`
  );

  const report = await mailbox.recover();
  assert.equal(report.cleaned, 1);
  assert.equal(report.retried, 1);
  assert.equal(report.abandoned, 0);
  assert.equal(calls.length, 0, 'recovery itself must not execute');
  assert.ok(!fs.existsSync(path.join(phoneDir, 'working', 'cmd_done0001.json')));
  assert.ok(fs.existsSync(path.join(phoneDir, 'inbox', 'cmd_lost0001.json')));
  assert.ok(!fs.existsSync(path.join(phoneDir, 'failed', 'cmd_lost0001.json')));

  // The next two ticks execute the requeued command exactly once (the first
  // tick records its stable size).
  await pollTwice(mailbox);
  assert.equal(calls.length, 1);
  const result = readJson(path.join(phoneDir, 'outbox', 'res_lost0001.json'));
  assert.equal(result.ok, true);
  assert.equal(typeof result.args_digest, 'string');
});

test('invalid command names are moved to failed/ and unknown files are ignored', async (t) => {
  const { phoneDir, mailbox, calls } = setup(t);
  fs.mkdirSync(path.join(phoneDir, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(phoneDir, 'inbox', 'cmd_short.json'), '{"v":1}\n');
  fs.writeFileSync(path.join(phoneDir, 'inbox', 'notes.txt'), 'ignore me\n');

  await mailbox.tick();

  assert.equal(calls.length, 0);
  assert.ok(fs.existsSync(path.join(phoneDir, 'failed', 'cmd_short.json')));
  assert.ok(fs.existsSync(path.join(phoneDir, 'inbox', 'notes.txt')), 'non-cmd files stay put');
});

// ── Bootstrap (phone onboarding) ────────────────────────────────────────────

function writeAssets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# amoon\r\nline two\r\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'tools.json'),
    `${JSON.stringify({ v: 1, protocol: 'khy-amoon/1', tools: [{ name: 'ping' }] }, null, 2)}\n`,
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'kb'), '#!/system/bin/sh\r\necho ok\r\n', 'utf8');
  return dir;
}

test('bootstrap pushes assets, normalizes LF, chmods kb and is idempotent', async (t) => {
  const tmp = tempDir(t);
  const phoneDir = path.join(tmp, 'phone');
  const assetsDir = writeAssets(path.join(tmp, 'assets'));
  const fake = new FakePhone(ROOT, phoneDir);
  const bootstrap = createBootstrap({ adb: fake, root: ROOT, assetsDir });
  t.after(() => bootstrap.dispose());

  const first = await bootstrap.run({ token: `khy_${'A'.repeat(32)}`, port: 18765 });
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.equal(first.files.length, 5); // README, tools, kb, port.txt, token.txt

  const readme = fs.readFileSync(path.join(phoneDir, 'README.md'), 'utf8');
  assert.ok(!readme.includes('\r'), 'CRLF must be normalized to LF');
  assert.ok(readme.endsWith('\n'));
  assert.equal(fs.readFileSync(path.join(phoneDir, 'kb'), 'utf8'), '#!/system/bin/sh\necho ok\n');
  assert.equal(fs.readFileSync(path.join(phoneDir, 'port.txt'), 'utf8'), '18765\n');
  assert.equal(fs.readFileSync(path.join(phoneDir, 'token.txt'), 'utf8'), `khy_${'A'.repeat(32)}\n`);

  assert.ok(fake.chmods.some((c) => c.mode === '755' && c.remote === `${ROOT}/kb`));
  assert.ok(fake.chmods.some((c) => c.mode === '600' && c.remote === `${ROOT}/token.txt`));

  for (const dir of ['inbox', 'outbox', 'working', 'done', 'failed', 'tmp', 'blobs', 'examples']) {
    assert.ok(fs.statSync(path.join(phoneDir, dir)).isDirectory(), `${dir} must exist`);
  }

  const pushesAfterFirst = fake.pushes.length;
  const second = await bootstrap.run({ token: `khy_${'A'.repeat(32)}`, port: 18765 });
  assert.equal(second.ok, true);
  assert.equal(second.files.filter((f) => f.changed).length, 0, 'second run must not re-push');
  assert.equal(fake.pushes.length, pushesAfterFirst, 'no pushes on an unchanged second run');
});

test('bootstrap never invents a token: no token arg means no token.txt', async (t) => {
  const tmp = tempDir(t);
  const phoneDir = path.join(tmp, 'phone');
  const assetsDir = writeAssets(path.join(tmp, 'assets'));
  const fake = new FakePhone(ROOT, phoneDir);
  const bootstrap = createBootstrap({ adb: fake, root: ROOT, assetsDir });
  t.after(() => bootstrap.dispose());

  const report = await bootstrap.run({ port: 18771 });
  assert.equal(report.ok, true);
  assert.equal(report.token.provided, false);
  assert.equal(report.token.pushed, false);
  assert.ok(report.warnings.some((w) => w.includes('token')));
  assert.ok(!fs.existsSync(path.join(phoneDir, 'token.txt')), 'operator token must never be pushed by default');
  assert.equal(fs.readFileSync(path.join(phoneDir, 'port.txt'), 'utf8'), '18771\n');
});

test('bootstrap reports a missing asset instead of silently skipping it', async (t) => {
  const tmp = tempDir(t);
  const phoneDir = path.join(tmp, 'phone');
  const assetsDir = path.join(tmp, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'README.md'), '# x\n');
  // tools.json and kb are missing on purpose.
  const fake = new FakePhone(ROOT, phoneDir);
  const bootstrap = createBootstrap({ adb: fake, root: ROOT, assetsDir });
  t.after(() => bootstrap.dispose());

  const report = await bootstrap.run({});
  assert.equal(report.ok, false);
  assert.equal(report.errors.filter((e) => e.code === 'invalid_config').length, 2);
});

test('bootstrap keeps the frozen contract paths in plan()', () => {
  const bootstrap = createBootstrap({
    adb: new FakePhone(ROOT, os.tmpdir()),
    root: ROOT,
    assetsDir: path.join(os.tmpdir(), 'no-such-assets'),
  });
  const plan = bootstrap.plan();
  assert.deepEqual(
    plan.assets.map((a) => a.remote),
    [`${ROOT}/README.md`, `${ROOT}/tools.json`, `${ROOT}/kb`, `${ROOT}/port.txt`, `${ROOT}/token.txt`]
  );
  assert.deepEqual(C.REMOTE_DIR_NAMES, ['inbox', 'outbox', 'working', 'done', 'failed', 'tmp', 'blobs', 'examples']);
  bootstrap.dispose();
});
