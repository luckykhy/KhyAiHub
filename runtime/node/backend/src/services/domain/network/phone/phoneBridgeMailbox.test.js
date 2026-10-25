'use strict';

/**
 * phoneBridgeMailbox.test.js — co-located suite for the mailbox fallback channel.
 *
 * IO: fully injected. A fake fs (an in-memory Map) plus a scripted transport
 * drive every path, including the two measured traps:
 *   - a hung exec freezes the single-threaded worker, so the deadline must be
 *     bounded and the failure must read as a failure;
 *   - cmd_ files are deleted after the result is written, INCLUDING on failure,
 *     and even when they fail to parse — so there is no "retry the same id".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mailbox = require('./phoneBridgeMailbox');

function createFakeFs() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    dirs,
    mkdirSync(dir) {
      dirs.add(dir);
    },
    writeFileSync(filePath, content) {
      files.set(filePath, String(content));
    },
    readFileSync(filePath) {
      if (!files.has(filePath)) {
        const err = new Error(`ENOENT: ${filePath}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(filePath);
    },
    unlinkSync(filePath) {
      files.delete(filePath);
    },
  };
}

function createScriptedTransport(script, fsImpl) {
  const calls = [];
  let index = 0;
  return {
    calls,
    push(local, remote) {
      const content = fsImpl ? fsImpl.files.get(local) : undefined;
      calls.push({ kind: 'push', local, remote, content });
      const step = script[index] || {};
      index += 1;
      return Promise.resolve(step.push || { ok: true });
    },
    run(argv, opts) {
      calls.push({ kind: 'run', argv, opts });
      const step = script[index] || {};
      index += 1;
      return Promise.resolve(step.run || { ok: false, code: 1, stdout: '', stderr: '' });
    },
  };
}

const BASE_CONFIG = Object.freeze({
  serial: '192.168.2.46:33743',
  mailboxDir: '/sdcard/bridge-amoobridge',
  mailboxPollMs: 10,
  mailboxTimeoutMs: 200,
});

function createMailbox({ transport, fsImpl, nowValue = 0 } = {}) {
  const fsImplToUse = fsImpl || createFakeFs();
  return {
    instance: mailbox.createPhoneBridgeMailbox({
      config: BASE_CONFIG,
      transport: transport || createScriptedTransport([]),
      fs: fsImplToUse,
      os: { tmpdir: () => 'C:\\tmp' },
      path: require('path'),
      tmpDirFactory: () => 'C:\\tmp',
      now: () => nowValue,
      sleep: () => Promise.resolve(),
      createId: () => 'abc123',
    }),
    fsImpl: fsImplToUse,
  };
}

// ── pure helpers ─────────────────────────────────────────────────────────────

test('文件名前后缀与桥侧 worker 的识别规则一致', () => {
  assert.deepEqual(mailbox.buildMailboxFileNames('abc123'), {
    cmdFileName: 'cmd_abc123.json',
    resultFileName: 'result_abc123.json',
  });
});

test('id 里的非法字符被剥掉——文件名直接参与 adb 参数', () => {
  const names = mailbox.buildMailboxFileNames('a b/../c');
  assert.equal(names.cmdFileName, 'cmd_abc.json');
  assert.equal(names.resultFileName, 'result_abc.json');
});

test('远端路径指向实测信箱目录，不是简报写的 /sdcard/bridge', () => {
  const paths = mailbox.buildMailboxRemotePaths('/sdcard/bridge-amoobridge', 'id1');
  assert.deepEqual(paths, {
    cmdRemotePath: '/sdcard/bridge-amoobridge/cmd_id1.json',
    resultRemotePath: '/sdcard/bridge-amoobridge/result_id1.json',
  });
  assert.equal(paths.cmdRemotePath.includes('/sdcard/bridge/'), false);
});

test('createMailboxId 未给随机串时自行生成且带 khy 前缀', () => {
  const id = mailbox.createMailboxId();
  assert.match(id, /^khy[0-9a-f]+$/);
  assert.equal(mailbox.createMailboxId('fixed'), 'khyfixed');
  assert.match(mailbox.createMailboxId('  '), /^khy/);
  assert.match(mailbox.createMailboxId(undefined), /^khy/);
});

test('载荷带上 id/tool/args 三件套，args 缺省为空对象', () => {
  assert.deepEqual(mailbox.buildMailboxCmdPayload({ id: 'i', tool: 'ping' }), {
    id: 'i',
    tool: 'ping',
    args: {},
  });
  assert.deepEqual(mailbox.buildMailboxCmdPayload({ id: 'i', tool: 'exec', args: { cmd: 'id' } }), {
    id: 'i',
    tool: 'exec',
    args: { cmd: 'id' },
  });
});

test('载荷序列化后 id 与文件名同源——worker 会从文件名反推 id', () => {
  const id = 'abc123';
  const payload = mailbox.serializeMailboxCmdPayload(
    mailbox.buildMailboxCmdPayload({ id, tool: 'ping', args: {} })
  );
  const parsed = JSON.parse(payload);
  assert.equal(parsed.id, id);
  assert.equal(mailbox.buildMailboxFileNames(id).cmdFileName, `cmd_${id}.json`);
});

test('deadline 算法给出整数次轮询，绝不无限等', () => {
  const d = mailbox.computeMailboxDeadline({ startedAtMs: 1000, timeoutMs: 200, pollMs: 10 });
  assert.equal(d.deadlineMs, 1200);
  assert.equal(d.pollMs, 10);
  assert.equal(d.maxAttempts, 20);
  assert.ok(Number.isInteger(d.maxAttempts));
});

test('timeout 短于一个轮询周期时也至少轮一次', () => {
  const d = mailbox.computeMailboxDeadline({ startedAtMs: 0, timeoutMs: 5, pollMs: 500 });
  assert.equal(d.maxAttempts, 1);
});

test('坏 timeout/poll 回退默认而不是抛或产 NaN', () => {
  const d = mailbox.computeMailboxDeadline({ timeoutMs: 'abc', pollMs: -1 });
  assert.equal(d.maxAttempts, 60);
  assert.equal(d.deadlineMs - Date.now() > 29000, true);
  const zero = mailbox.computeMailboxDeadline({ timeoutMs: 0, pollMs: 0 });
  assert.equal(zero.maxAttempts, 60);
});

test('parseMailboxResult：空/坏 JSON/非对象都算失败', () => {
  assert.equal(mailbox.parseMailboxResult('').ok, false);
  assert.equal(mailbox.parseMailboxResult('   ').ok, false);
  assert.equal(mailbox.parseMailboxResult(undefined).ok, false);
  assert.match(mailbox.parseMailboxResult('{oops').error, /不是合法 JSON/);
  assert.match(mailbox.parseMailboxResult('[1,2]').error, /不是一个对象/);
  assert.match(mailbox.parseMailboxResult('"str"').error, /不是一个对象/);
});

test('parseMailboxResult：桥侧 ok:false 原样带出 error', () => {
  const res = mailbox.parseMailboxResult(JSON.stringify({ id: 'i', tool: 'exec', ok: false, error: 'empty cmd' }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'empty cmd');
  assert.equal(res.result.ok, false);
});

test('parseMailboxResult：成功时顶层字段齐了', () => {
  const res = mailbox.parseMailboxResult(JSON.stringify({
    id: 'i', tool: 'ping', ts: 1, ok: true, pong: 2, pid: 3,
  }));
  assert.equal(res.ok, true);
  assert.equal(res.result.pong, 2);
  assert.equal(res.result.pid, 3);
});

// ── IO shell ─────────────────────────────────────────────────────────────────

test('信箱成功路径：写本地 -> push -> 轮询 -> 解析 -> 清理本地文件', async () => {
  const fsImpl = createFakeFs();
  const transport = createScriptedTransport([
    { push: { ok: true } },
    { run: { ok: false, code: 1, stdout: '', stderr: 'no such file' } },
    { run: { ok: true, code: 0, stdout: JSON.stringify({ id: 'abc123', tool: 'ping', ok: true, pong: 99 }) } },
  ], fsImpl);
  const { instance } = createMailbox({ transport, fsImpl });

  const res = await instance.call('ping', {});

  assert.equal(res.ok, true);
  assert.equal(res.channel, 'mailbox');
  assert.equal(res.result.pong, 99);
  assert.equal(res.attempts, 2);

  assert.equal(transport.calls[0].kind, 'push');
  assert.equal(transport.calls[0].remote, '/sdcard/bridge-amoobridge/cmd_abc123.json');
  assert.ok(transport.calls[0].local.endsWith('cmd_abc123.json'));

  // 推送的载荷就是 cmd_<id>.json 的正文（在 push 那一刻抓的，之后本地文件会被清掉）
  assert.deepEqual(JSON.parse(transport.calls[0].content), { id: 'abc123', tool: 'ping', args: {} });

  // 轮询读的是 result_<id>.json，且本地临时文件已被清掉
  assert.equal(transport.calls[1].argv[2], '/sdcard/bridge-amoobridge/result_abc123.json');
  assert.equal(fsImpl.files.size, 0);
});

test('信箱在 deadline 内没结果时报中文超时，且不抛', async () => {
  const transport = createScriptedTransport([
    { push: { ok: true } },
    { run: { ok: false, code: 1, stdout: '', stderr: 'missing' } },
    { run: { ok: false, code: 1, stdout: '', stderr: 'missing' } },
  ]);
  const { instance } = createMailbox({ transport });
  const res = await instance.call('ping', {});
  assert.equal(res.ok, false);
  assert.equal(res.channel, 'mailbox');
  assert.match(res.error, /信箱在 200ms 内没有返回结果/);
  assert.match(res.error, /HTTP 主通道不受此影响/);
});

test('push 失败时不再轮询，直接报错', async () => {
  const transport = createScriptedTransport([{ push: { ok: false, error: 'adb push 失败' } }]);
  const { instance } = createMailbox({ transport });
  const res = await instance.call('ping', {});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'adb push 失败');
  assert.equal(transport.calls.length, 1);
});

test('worker 返回 ok:false 时如实带出桥侧错误', async () => {
  const transport = createScriptedTransport([
    { push: { ok: true } },
    { run: { ok: true, code: 0, stdout: JSON.stringify({ ok: false, error: 'unknown tool: ui_dump' }) } },
  ]);
  const { instance } = createMailbox({ transport });
  const res = await instance.call('ui_dump', {});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unknown tool: ui_dump');
});

test('本地文件清理在每条出口都执行，包括异常路径', async () => {
  const fsImpl = createFakeFs();
  const transport = createScriptedTransport([
    { push: { ok: true } },
    { run: { ok: true, code: 0, stdout: JSON.stringify({ ok: true, pong: 1 }) } },
  ]);
  const { instance } = createMailbox({ transport, fsImpl });
  await instance.call('ping', {});
  assert.equal(fsImpl.files.size, 0);

  // 抛异常的 transport：finally 仍要清
  const throwing = {
    calls: [],
    push() {
      throwing.calls.push('push');
      throw new Error('adb 崩了');
    },
    run() {
      return Promise.resolve({ ok: false });
    },
  };
  const fs2 = createFakeFs();
  const second = mailbox.createPhoneBridgeMailbox({
    config: BASE_CONFIG,
    transport: throwing,
    fs: fs2,
    tmpDirFactory: () => 'C:\\tmp',
    path: require('path'),
    now: () => 0,
    sleep: () => Promise.resolve(),
    createId: () => 'zzz',
  });
  const res = await second.call('ping', {});
  assert.equal(res.ok, false);
  assert.match(res.error, /信箱通道异常：adb 崩了/);
  assert.equal(fs2.files.size, 0);
});

test('payload 超过 512KB 时拒绝走信箱', async () => {
  const fsImpl = createFakeFs();
  const transport = createScriptedTransport([]);
  const { instance } = createMailbox({ transport, fsImpl });
  const res = await instance.call('write', { path: '/sdcard/big.txt', content: 'x'.repeat(600 * 1024) });
  assert.equal(res.ok, false);
  assert.match(res.error, /超过 512KB 上限/);
  assert.equal(transport.calls.length, 0);
  assert.equal(fsImpl.files.size, 0);
});

test('未注入 transport 时诚实报错，不静默成功', async () => {
  const instance = mailbox.createPhoneBridgeMailbox({ config: BASE_CONFIG });
  const res = await instance.call('ping', {});
  assert.equal(res.ok, false);
  assert.match(res.error, /未注入 transport/);
});

test('transport 只给了 run 没给 push 时同样被拒', async () => {
  const instance = mailbox.createPhoneBridgeMailbox({
    config: BASE_CONFIG,
    transport: { run: () => Promise.resolve({ ok: false }) },
    fs: createFakeFs(),
    tmpDirFactory: () => 'C:\\tmp',
    path: require('path'),
  });
  const res = await instance.call('ping', {});
  assert.equal(res.ok, false);
});

test('callOptions.timeoutMs 覆盖配置里的 deadline', async () => {
  const transport = createScriptedTransport([
    { push: { ok: true } },
    { run: { ok: true, code: 0, stdout: JSON.stringify({ ok: true, pong: 7 }) } },
  ]);
  const { instance } = createMailbox({ transport });
  const res = await instance.call('ping', {}, { timeoutMs: 5000 });
  assert.equal(res.ok, true);
  assert.equal(res.result.pong, 7);
});

test('信箱默认不挂起：deadline 由 maxAttempts 封顶，不会无限轮询', async () => {
  let runs = 0;
  const transport = {
    push: () => Promise.resolve({ ok: true }),
    run: () => {
      runs += 1;
      return Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'missing' });
    },
  };
  const { instance } = createMailbox({ transport });
  const res = await instance.call('ping', {});
  assert.equal(res.ok, false);
  // 200ms / 10ms = 20 次，一次不多
  assert.equal(runs, 20);
});
