'use strict';

/**
 * local-tools.test.js — tool table, path confinement, exec without a shell,
 * background jobs, fake khy.ask, and the Windows-only clipboard/screenshot
 * paths. Everything runs in a temp state/root directory; no default port.
 *
 * khy.ask is always pointed at a fake khy.js script: no test calls a real
 * model.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createLocalTools,
  MAX_READ_BYTES,
} = require('../lib/local-tools');

const EXPECTED_TOOLS = [
  'ping',
  'info',
  'status',
  'exec',
  'ls',
  'read',
  'write',
  'mkdir',
  'rm',
  'mv',
  'cp',
  'stat',
  'khy.ask',
  'task.submit',
  'task.get',
  'task.list',
  'task.cancel',
  'notify',
  'clipboard.get',
  'clipboard.set',
  'open',
  'sys.info',
  'khy.status',
  'screen.shot',
];

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoon-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t, extra = {}) {
  const root = tempDir(t);
  const state = path.join(root, 'state');
  const tools = createLocalTools({
    stateDir: state,
    writeRoots: [root],
    readRoots: [root],
    cwdAllowlist: [root],
    ...extra,
  });
  t.after(() => tools.close());
  return { root, state, tools };
}

function fakeKhy(root, body) {
  const file = path.join(root, 'fake-khy.js');
  fs.writeFileSync(
    file,
    [
      "'use strict';",
      'const args = process.argv.slice(2);',
      "const pi = args.indexOf('-p');",
      "const question = pi >= 0 ? args[pi + 1] : '';",
      body,
    ].join('\n'),
    'utf8'
  );
  return file;
}

async function callData(tools, name, args) {
  const result = await tools.call(name, args);
  assert.equal(result.ok, true, `${name} should succeed`);
  return result.data;
}

async function callError(tools, name, args, code) {
  await assert.rejects(tools.call(name, args), (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
}

// Every clipboard call spawns a powershell process, and on a loaded desktop one
// spawn can exceed the tool's own 8s budget (observed: a restore timed out
// while the round-trip itself passed). Only setup and cleanup go through here —
// the measured round-trip keeps failing on the first miss.
async function callClipboard(tools, name, args) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await callData(tools, name, args);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

test('tool table exposes exactly the 24 requested tools with descriptors', (t) => {
  const { tools } = setup(t);
  assert.deepEqual([...tools.names()].sort(), [...EXPECTED_TOOLS].sort());
  assert.equal(tools.list().length, 24);

  for (const descriptor of tools.list()) {
    assert.equal(descriptor.inputSchema.type, 'object');
    assert.ok(['low', 'medium', 'high'].includes(descriptor.risk));
    assert.ok(descriptor.timeoutMs > 0);
    assert.ok(descriptor.responseMaxBytes > 0);
    assert.equal(typeof descriptor.title, 'string');
    assert.equal(typeof descriptor.description, 'string');
    assert.equal(typeof descriptor.readOnly, 'boolean');
  }
  assert.equal(tools.get('phone_shell'), null);
  assert.equal(tools.get('khy_ask'), null, 'wire names keep the dot form from the ask');
});

test('ping/info/status/sys.info/khy.status return useful read-only data', async (t) => {
  const { root, state, tools } = setup(t);

  const ping = await callData(tools, 'ping', {});
  assert.equal(ping.pong, true);
  assert.equal(ping.pid, process.pid);
  assert.ok(!Number.isNaN(Date.parse(ping.ts)));

  const info = await callData(tools, 'info', {});
  assert.equal(info.name, 'khy-local-tools');
  assert.equal(info.state_dir, state);
  assert.ok(info.write_roots.includes(root));
  assert.equal(info.tool_count, 24);

  const status = await callData(tools, 'status', {});
  assert.equal(status.ok, true);
  assert.equal(status.tools.length, 24);
  assert.ok(status.counters.calls >= 3);
  assert.equal(status.tasks.total, 0);

  const sys = await callData(tools, 'sys.info', {});
  assert.equal(sys.platform, process.platform);
  assert.equal(typeof sys.cpus.count, 'number');
  assert.ok(sys.memory.total_bytes > 0);

  const khy = await callData(tools, 'khy.status', {});
  assert.equal(khy.configured, false);
  assert.equal(khy.exists, false);
});

test('write/read/stat/ls/cp/mv/rm/mkdir round-trip inside the root', async (t) => {
  const { root, tools } = setup(t);
  const nested = path.join(root, 'a', 'b.txt');

  const written = await callData(tools, 'write', { path: nested, content: 'hello 世界' });
  assert.equal(written.bytes, Buffer.byteLength('hello 世界'));
  assert.equal(written.created, true);
  assert.match(written.sha256, /^[0-9a-f]{64}$/);

  const read = await callData(tools, 'read', { path: nested });
  assert.equal(read.content, 'hello 世界');
  assert.equal(read.size, Buffer.byteLength('hello 世界'));
  assert.equal(read.truncated, false);

  const sliced = await callData(tools, 'read', { path: nested, offset: 2, limit: 3 });
  assert.equal(sliced.returned_bytes, 3);
  assert.equal(sliced.truncated, true);

  const stat = await callData(tools, 'stat', { path: nested });
  assert.equal(stat.type, 'file');
  assert.equal(stat.size, Buffer.byteLength('hello 世界'));

  const ls = await callData(tools, 'ls', { path: path.join(root, 'a') });
  assert.equal(ls.entries.length, 1);
  assert.equal(ls.entries[0].name, 'b.txt');

  fs.writeFileSync(path.join(root, 'a', '.hidden'), 'h');
  const lsNoHidden = await callData(tools, 'ls', { path: path.join(root, 'a'), all: false });
  assert.deepEqual(lsNoHidden.entries.map((e) => e.name), ['b.txt']);

  const copy = await callData(tools, 'cp', { from: nested, to: path.join(root, 'c.txt') });
  assert.equal(copy.type, 'file');
  assert.equal(fs.readFileSync(path.join(root, 'c.txt'), 'utf8'), 'hello 世界');

  const moved = await callData(tools, 'mv', { from: path.join(root, 'c.txt'), to: path.join(root, 'd.txt') });
  assert.equal(moved.to, path.join(root, 'd.txt'));
  assert.ok(fs.existsSync(path.join(root, 'd.txt')));

  await callData(tools, 'mkdir', { path: path.join(root, 'nested', 'dir') });
  assert.ok(fs.statSync(path.join(root, 'nested', 'dir')).isDirectory());
  const again = await callData(tools, 'mkdir', { path: path.join(root, 'nested', 'dir') });
  assert.equal(again.created, false);

  const removed = await callData(tools, 'rm', { path: path.join(root, 'd.txt') });
  assert.equal(removed.removed, true);

  // Directory deletion requires recursive + confirm.
  await callError(tools, 'rm', { path: path.join(root, 'nested') }, 'invalid_args');
  await callError(tools, 'rm', { path: path.join(root, 'nested'), recursive: true }, 'invalid_args');
  const removedDir = await callData(tools, 'rm', {
    path: path.join(root, 'nested'),
    recursive: true,
    confirm: true,
  });
  assert.equal(removedDir.type, 'dir');
  assert.ok(!fs.existsSync(path.join(root, 'nested')));
});

test('write refuses to overwrite in create mode and accepts base64', async (t) => {
  const { root, tools } = setup(t);
  const file = path.join(root, 'b64.bin');
  await callData(tools, 'write', { path: file, content: 'aGVsbG8=', encoding: 'base64', mode: 'create' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
  await callError(tools, 'write', { path: file, content: 'x', mode: 'create' }, 'id_conflict');

  const read = await callData(tools, 'read', { path: file, encoding: 'base64' });
  assert.equal(read.content, 'aGVsbG8=');

  await callError(tools, 'write', { path: path.join(root, 'bad.bin'), content: '!!not-base64!!', encoding: 'base64' }, 'invalid_args');
  assert.ok(!fs.existsSync(path.join(root, 'bad.bin')));
});

test('path traversal and writes outside the roots are rejected', async (t) => {
  const { root, tools } = setup(t);
  const outside = path.join(path.dirname(root), `amoon-outside-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'outside');
  t.after(() => {
    try {
      fs.unlinkSync(outside);
    } catch {
      // ignore
    }
  });

  await callError(tools, 'read', { path: outside }, 'forbidden_scope');
  await callError(tools, 'write', { path: outside, content: 'x' }, 'forbidden_scope');
  await callError(tools, 'read', { path: path.join(root, '..', path.basename(outside)) }, 'forbidden_scope');
  await callError(tools, 'read', { path: path.join(root, 'missing.txt') }, 'not_found');
  await callError(tools, 'write', { path: path.join(root, 'bad\u0000name'), content: 'x' }, 'invalid_args');
  await callError(tools, 'ls', { path: path.join(root, 'missing-dir') }, 'not_found');

  // A symlink/junction inside the root must not become an escape hatch.
  const outsideDir = path.join(path.dirname(root), `amoon-outside-dir-${process.pid}-${Date.now()}`);
  fs.mkdirSync(outsideDir);
  const link = path.join(root, 'escape-link');
  let linked = true;
  try {
    fs.symlinkSync(outsideDir, link, 'junction');
  } catch {
    linked = false;
  }
  t.after(() => {
    try {
      fs.unlinkSync(link);
    } catch {
      // ignore
    }
    try {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
  if (linked) {
    await callError(tools, 'write', { path: path.join(link, 'escape.txt'), content: 'x' }, 'forbidden_scope');
    await callError(tools, 'read', { path: path.join(link, 'escape.txt') }, 'forbidden_scope');
  }
});

test('exec direct mode preserves arguments literally (no shell interpretation)', async (t) => {
  const { tools } = setup(t);
  const result = await callData(tools, 'exec', {
    mode: 'direct',
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.argv[1])', 'a;b && echo pwned'],
  });
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, 'a;b && echo pwned');
  assert.equal(result.stderr, '');
});

test('exec script mode uses PowerShell on Windows and /bin/sh elsewhere', async (t) => {
  const { tools } = setup(t);
  if (process.platform === 'win32') {
    const result = await callData(tools, 'exec', { command: "Write-Output 'ps-ok'" });
    assert.equal(result.mode, 'powershell');
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, /ps-ok/);
    assert.doesNotMatch(result.stderr, /CLIXML/);
  } else {
    const result = await callData(tools, 'exec', { command: "printf 'sh-ok'" });
    assert.equal(result.mode, 'sh');
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, 'sh-ok');
  }
});

test('exec timeout kills the process and reports timeout', async (t) => {
  const { tools } = setup(t);
  const started = Date.now();
  await callError(
    tools,
    'exec',
    {
      mode: 'direct',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      timeout_ms: 500,
    },
    'timeout'
  );
  assert.ok(Date.now() - started < 5000, 'timeout must return before the child would finish');
});

test('exec output cap marks the result truncated', async (t) => {
  const { tools } = setup(t);
  const result = await callData(tools, 'exec', {
    mode: 'direct',
    command: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(20000))"],
    max_bytes: 256,
  });
  assert.equal(result.truncated, true);
});

test('read-only and exec-disabled configurations are enforced', async (t) => {
  const root = tempDir(t);
  const readOnly = createLocalTools({
    stateDir: path.join(root, 'ro-state'),
    writeRoots: [root],
    readRoots: [root],
    readOnly: true,
  });
  t.after(() => readOnly.close());
  assert.equal((await callData(readOnly, 'ping', {})).pong, true);
  await callError(readOnly, 'write', { path: path.join(root, 'x.txt'), content: 'x' }, 'forbidden_scope');
  await callError(readOnly, 'exec', { command: 'echo hi' }, 'forbidden_scope');

  const noExec = createLocalTools({
    stateDir: path.join(root, 'noexec-state'),
    writeRoots: [root],
    readRoots: [root],
    allowExec: false,
  });
  t.after(() => noExec.close());
  await callError(noExec, 'exec', { command: 'echo hi' }, 'forbidden_scope');
});

test('unknown tools and bad argument shapes are rejected', async (t) => {
  const { tools } = setup(t);
  await callError(tools, 'nope', {}, 'not_found');
  await callError(tools, 'ping', { extra: true }, 'invalid_args');
  await callError(tools, 'write', { path: path.join(tools.stateDir, 'x') }, 'invalid_args');
  await callError(tools, 'read', { path: 42 }, 'invalid_args');
  await callError(tools, 'task.get', { id: 'short' }, 'invalid_args');
});

test('khy.ask queues a fake KhyOS CLI with sentinel tools and system prompt', async (t) => {
  const { root, tools } = setup(t);
  const fake = fakeKhy(root, "console.log(JSON.stringify({ result: 'fake answer: ' + question, argv: args }));");
  const configured = createLocalTools({
    stateDir: path.join(root, 'state-ask'),
    writeRoots: [root],
    readRoots: [root],
    cwdAllowlist: [root],
    khyJs: fake,
  });
  t.after(() => configured.close());

  const accepted = await configured.call('khy.ask', { question: 'hello?' });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.data.pending, true);
  assert.match(accepted.data.job_id, /^job-/);

  const job = await configured.waitForJob(accepted.data.job_id, 15000);
  assert.equal(job.state, 'done');
  assert.ok(job.result.answer.startsWith('fake answer: hello?'));
  assert.match(job.result.stdout, /__khy_amoon_no_tools__/);
  assert.match(job.result.stdout, /--system-prompt/);
  assert.match(job.result.stdout, /--max-turns/);
  assert.match(job.result.stdout, /--output-format/);
  assert.equal(job.result.exit_code, 0);
  assert.equal(job.result.max_turns, 4);
  assert.deepEqual(job.result.allowed_tools, []);
  assert.ok(job.result.cwd.endsWith(path.join('state-ask', 'khy-cwd')));

  // Explicit allowlists must stay inside the operator allowlist; MCP names are
  // rejected instead of being forwarded to khy.js.
  const withTools = await configured.call('khy.ask', {
    question: 'with tools',
    allowed_tools: ['Read'],
    max_turns: 2,
  });
  const toolJob = await configured.waitForJob(withTools.data.job_id, 15000);
  assert.equal(toolJob.state, 'done');
  assert.match(toolJob.result.stdout, /Read/);
  assert.doesNotMatch(toolJob.result.stdout, /__khy_amoon_no_tools__/);
  assert.equal(toolJob.result.max_turns, 2);

  await callError(configured, 'khy.ask', { question: 'x', allowed_tools: ['mcp__demo__ping'] }, 'forbidden_scope');
  await callError(configured, 'khy.ask', { question: 'x', allowed_tools: ['Bash'] }, 'forbidden_scope');

  // faked tools object exists only for this test; use the fake directly.
  void tools;
});

test('khy.ask fails fast when no KhyOS CLI is configured', async (t) => {
  const { tools } = setup(t);
  await callError(tools, 'khy.ask', { question: 'hello?' }, 'invalid_config');
});

test('task.submit / task.get / task.list / task.cancel work', async (t) => {
  const { root, tools } = setup(t);
  const submitted = await callData(tools, 'task.submit', { tool: 'sys.info', args: {} });
  assert.equal(submitted.pending, true);
  assert.equal(submitted.tool, 'sys.info');

  const done = await tools.waitForJob(submitted.job_id, 15000);
  assert.equal(done.state, 'done');
  assert.equal(done.result.platform, process.platform);

  const fetched = await callData(tools, 'task.get', { id: submitted.job_id });
  assert.equal(fetched.state, 'done');
  assert.equal(fetched.result.platform, process.platform);

  const listed = await callData(tools, 'task.list', {});
  assert.ok(listed.tasks.some((job) => job.id === submitted.job_id));
  const summary = listed.tasks.find((job) => job.id === submitted.job_id);
  assert.equal(summary.result, undefined, 'list must not return full results');
  assert.ok(listed.stats.done >= 1);

  await callError(tools, 'task.get', { id: 'job-does-not-exist' }, 'not_found');
  await callError(tools, 'task.submit', { tool: 'khy.ask', args: {} }, 'invalid_args');
  await callError(tools, 'task.submit', { tool: 'task.get', args: {} }, 'invalid_args');
  await callError(tools, 'task.submit', { tool: 'nope' }, 'not_found');
  await callError(tools, 'task.cancel', { id: 'job-does-not-exist' }, 'not_found');

  const fake = fakeKhy(root, 'setTimeout(() => console.log(JSON.stringify({ result: "late" })), 10000);');
  const slow = createLocalTools({
    stateDir: path.join(root, 'state-cancel'),
    writeRoots: [root],
    readRoots: [root],
    cwdAllowlist: [root],
    khyJs: fake,
  });
  t.after(() => slow.close());
  const ask = await slow.call('khy.ask', { question: 'cancel me' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const cancelled = await callData(slow, 'task.cancel', { id: ask.data.job_id });
  assert.equal(cancelled.state, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const after = await callData(slow, 'task.get', { id: ask.data.job_id });
  assert.equal(after.state, 'cancelled');
});

test('job-level timeout aborts a long task and reports failure', async (t) => {
  const { tools } = setup(t);
  const submitted = await callData(tools, 'task.submit', {
    tool: 'exec',
    args: {
      mode: 'direct',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
    },
    timeout_ms: 1000,
  });
  const job = await tools.waitForJob(submitted.job_id, 8000);
  assert.equal(job.state, 'failed');
  assert.equal(job.error.code, 'timeout');
});

test('notify records to notifications.jsonl', async (t) => {
  const { state, tools } = setup(t);
  const result = await callData(tools, 'notify', {
    title: '测试',
    message: 'hello notify',
    level: 'info',
  });
  assert.equal(result.recorded, true);
  assert.equal(typeof result.os_notification, 'boolean');

  const lines = fs
    .readFileSync(path.join(state, 'notifications.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean);
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.title, '测试');
  assert.equal(record.message, 'hello notify');
  assert.equal(record.level, 'info');
});

test('clipboard.set/get round-trips on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const { tools } = setup(t);

  // The Windows clipboard is one global object shared with the user's desktop
  // session: save what is in it and put it back, or this test destroys real
  // data on every run. Measured 2026-10-30 (works/data/khy/feedback/
  // clipboard-test-isolation-20261030): the payload survives the setter
  // process exiting — runProcess resolves on 'close', so every read below
  // happens after powershell is already gone — while a desktop installer was
  // caught writing the clipboard mid-run. A foreign read is therefore an
  // outsider's write; only a read equal to the pre-test content would mean
  // our payload was lost.
  const before = await callClipboard(tools, 'clipboard.get', {});
  const text = `khy-clip-${process.pid}-${Date.now()}`;
  let bodyError = null;
  try {
    const set = await callData(tools, 'clipboard.set', { text });
    assert.equal(set.set, true);

    // The OS clipboard is a global, asynchronously published resource; poll
    // briefly instead of assuming the first read lands after the publish.
    let got = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      got = await callData(tools, 'clipboard.get', {});
      if (got.text === text) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (got.text !== text) {
      // Two causes land here and they need different owners: the payload did
      // not survive the setter process exiting (a tool bug), or another
      // process in this desktop session overwrote the clipboard while we
      // polled (test isolation). The saved pre-test content separates them —
      // reverting to it, or to empty, means our set was lost.
      const lost = got.text === before.text || got.text === '';
      const cause = lost
        ? 'the payload did not survive clipboard.set — the clipboard holds the pre-test content or is empty'
        : 'an external process overwrote the clipboard during the poll window';
      assert.fail(
        `clipboard round-trip lost the payload: ${cause} (read ${JSON.stringify(got.text.slice(0, 80))})`
      );
    }
  } catch (err) {
    bodyError = err;
  }

  // Restoring spawns powershell again, and on a loaded desktop that spawn can
  // exceed the tool's own 8s budget — observed once while the round-trip
  // itself passed. Retry rather than leave the user's clipboard holding our
  // sentinel, and never fail silently.
  try {
    await callClipboard(tools, 'clipboard.set', { text: before.text });
  } catch (err) {
    assert.fail(
      `could not restore the pre-test clipboard after 3 attempts (${err.code}: ${err.message}); the user's clipboard still holds the test sentinel`
      + (bodyError ? `; the round-trip itself also failed: ${bodyError.message}` : '')
    );
  }
  if (bodyError) throw bodyError;
});

test('screen.shot writes a PNG on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const { tools } = setup(t);
  const shot = await callData(tools, 'screen.shot', {});
  assert.ok(fs.existsSync(shot.path));
  assert.ok(shot.bytes > 0);
  assert.match(shot.sha256, /^[0-9a-f]{64}$/);
  assert.ok(shot.width > 0);
  assert.ok(shot.height > 0);
  const header = fs.readFileSync(shot.path).subarray(0, 8).toString('hex');
  assert.equal(header, '89504e470d0a1a0a');
});

test('open rejects missing paths and control characters without launching anything', async (t) => {
  const { root, tools } = setup(t);
  await callError(tools, 'open', { target: path.join(root, 'missing.txt') }, 'not_found');
  await callError(tools, 'open', { target: 'https://example.com/\u0000bad' }, 'invalid_args');
  await callError(tools, 'open', { target: 'file:///C:/Windows/win.ini' }, 'invalid_args');
});

test('read limit is bounded by MAX_READ_BYTES', async (t) => {
  const { root, tools } = setup(t);
  const file = path.join(root, 'big.txt');
  fs.writeFileSync(file, 'a'.repeat(100));
  await callError(tools, 'read', { path: file, limit: MAX_READ_BYTES + 1 }, 'invalid_args');
});
