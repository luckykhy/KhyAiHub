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
const nodeFs = require('fs');
const nodePath = require('path');

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

// ── 消费方清理器（读后即删 + sweep） ─────────────────────────────────────────

/**
 * Stateful fake of the phone side: a remote path -> content map that answers
 * `ls -1 <dir>`, `cat <path>` and `rm -f <paths...>` the way toybox does, and
 * records every argv so the tests can assert what the cleaner actually ran.
 */
function createVirtualDeviceTransport(files = {}) {
  const calls = [];
  const store = new Map(Object.entries(files));
  function listDir(dir) {
    const prefix = `${dir}/`;
    return [...store.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .sort();
  }
  return {
    calls,
    store,
    push(local, remote) {
      calls.push({ kind: 'push', local, remote });
      return Promise.resolve({ ok: true });
    },
    run(argv) {
      calls.push({ kind: 'run', argv: [...argv] });
      const [, sub, ...rest] = argv;
      if (sub === 'ls') {
        // `ls -1 <dir>` — the directory is the last argument, the flag is not.
        return Promise.resolve({ ok: true, code: 0, stdout: listDir(rest[rest.length - 1]).join('\n') });
      }
      if (sub === 'cat') {
        const value = store.get(rest[0]);
        if (value === undefined) {
          return Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'no such file' });
        }
        return Promise.resolve({ ok: true, code: 0, stdout: value });
      }
      if (sub === 'rm') {
        for (const path of rest.slice(1)) store.delete(path);
        return Promise.resolve({ ok: true, code: 0, stdout: '' });
      }
      return Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'unsupported' });
    },
  };
}

function rmCalls(transport) {
  return transport.calls.filter((c) => c.kind === 'run' && c.argv[1] === 'rm');
}

test('读到并核对回执后立即删除 result_，同 id 的 cmd_/processing_ 残留一并清', async () => {
  const transport = createScriptedTransport([
    { push: { ok: true } },
    { run: { ok: true, code: 0, stdout: JSON.stringify({ id: 'abc123', tool: 'ping', ok: true, pong: 99 }) } },
    { run: { ok: true, code: 0, stdout: '' } },
  ]);
  const { instance } = createMailbox({ transport });

  const res = await instance.call('ping', {});

  assert.equal(res.ok, true);
  const removals = rmCalls(transport);
  assert.equal(removals.length, 1);
  assert.deepEqual(removals[0].argv, [
    'shell', 'rm', '-f',
    '/sdcard/bridge-amoobridge/result_abc123.json',
    '/sdcard/bridge-amoobridge/processing_abc123.json',
    '/sdcard/bridge-amoobridge/cmd_abc123.json',
  ]);
});

test('桥侧 ok:false 的回执也是「已读到的回执」，同样删', async () => {
  const transport = createScriptedTransport([
    { push: { ok: true } },
    { run: { ok: true, code: 0, stdout: JSON.stringify({ ok: false, error: 'unknown tool: ui_dump' }) } },
    { run: { ok: true, code: 0, stdout: '' } },
  ]);
  const { instance } = createMailbox({ transport });

  const res = await instance.call('ui_dump', {});

  assert.equal(res.ok, false);
  assert.equal(rmCalls(transport).length, 1);
});

test('回执不是合法 JSON 时不算核对过：不删，且如实带回执错误', async () => {
  const transport = createScriptedTransport([
    { push: { ok: true } },
    { run: { ok: true, code: 0, stdout: 'half-written {not json' } },
  ]);
  const { instance } = createMailbox({ transport });

  const res = await instance.call('ping', {});

  assert.equal(res.ok, false);
  assert.match(res.error, /不是合法 JSON/);
  assert.equal(rmCalls(transport).length, 0);
});

test('超时什么都没读到，不删设备上任何文件', async () => {
  const transport = createScriptedTransport([
    { push: { ok: true } },
    { run: { ok: false, code: 1, stdout: '', stderr: 'missing' } },
  ]);
  const { instance } = createMailbox({ transport });
  const res = await instance.call('ping', {});
  assert.equal(res.ok, false);
  assert.equal(rmCalls(transport).length, 0);
});

test('删除失败不把已到手的回执说成失败', async () => {
  const transport = createScriptedTransport([
    { push: { ok: true } },
    { run: { ok: true, code: 0, stdout: JSON.stringify({ id: 'abc123', tool: 'ping', ok: true, pong: 5 }) } },
    { run: { ok: false, code: 1, stdout: '', stderr: 'rm: permission denied' } },
  ]);
  const { instance } = createMailbox({ transport });

  const res = await instance.call('ping', {});

  assert.equal(res.ok, true);
  assert.equal(res.result.pong, 5);
  assert.equal(rmCalls(transport).length, 1);
});

test('sweep：核对过的 result 连同残留一起删，未确认的 processing 与未处理的 cmd 保留', async () => {
  const dir = '/sdcard/bridge-amoobridge';
  const transport = createVirtualDeviceTransport({
    [`${dir}/result_a.json`]: JSON.stringify({ id: 'a', tool: 'ping', ok: true }),
    [`${dir}/processing_a.json`]: JSON.stringify({ id: 'a', tool: 'ping' }),
    [`${dir}/cmd_a.json`]: JSON.stringify({ id: 'a', tool: 'ping' }),
    [`${dir}/result_bad.json`]: JSON.stringify({ id: 'someone-else', tool: 'ping', ok: true }),
    [`${dir}/result_raw.json`]: 'not json at all',
    [`${dir}/processing_ghost.json`]: JSON.stringify({ id: 'ghost', tool: 'exec', args: { cmd: 'sleep 1' } }),
    [`${dir}/cmd_late.json`]: JSON.stringify({ id: 'late', tool: 'ping' }),
    [`${dir}/status.json`]: '{"running":true}',
  });
  const { instance } = createMailbox({ transport });

  const report = await instance.sweep();

  assert.equal(report.ok, true);
  assert.equal(report.scanned, 8);
  assert.deepEqual(report.deleted, ['result_a.json', 'processing_a.json', 'cmd_a.json']);
  assert.deepEqual(
    report.kept.map((k) => `${k.name}:${k.reason}`).sort(),
    [
      'cmd_late.json:cmd_unprocessed',
      'processing_ghost.json:processing_leftover_unconfirmed',
      'result_bad.json:result_id_mismatch',
      'result_raw.json:result_not_json_object',
    ].sort()
  );
  // status.json 不在信箱三态里，动都没动
  assert.equal(transport.store.has(`${dir}/status.json`), true);
});

test('sweep 可重复执行且幂等：第二跑什么都不删', async () => {
  const dir = '/sdcard/bridge-amoobridge';
  const transport = createVirtualDeviceTransport({
    [`${dir}/result_a.json`]: JSON.stringify({ id: 'a', tool: 'ping', ok: true }),
  });
  const { instance } = createMailbox({ transport });

  const first = await instance.sweep();
  assert.deepEqual(first.deleted, ['result_a.json']);
  const second = await instance.sweep();
  assert.equal(second.ok, true);
  assert.deepEqual(second.deleted, []);
  assert.equal(second.scanned, 0);
});

test('sweep：人工核对过的 processing 才删（confirmedProcessingIds 闸门）', async () => {
  const dir = '/sdcard/bridge-amoobridge';
  const transport = createVirtualDeviceTransport({
    [`${dir}/processing_b8a1.json`]: JSON.stringify({ id: 'b8a1', tool: 'exec', args: { cmd: 'sleep 100' } }),
    [`${dir}/processing_other.json`]: JSON.stringify({ id: 'other', tool: 'exec', args: {} }),
  });
  const { instance } = createMailbox({ transport });

  const report = await instance.sweep({ confirmedProcessingIds: ['b8a1'] });

  assert.deepEqual(report.deleted, ['processing_b8a1.json']);
  assert.deepEqual(report.kept, [{ name: 'processing_other.json', reason: 'processing_leftover_unconfirmed' }]);
  assert.equal(transport.store.has(`${dir}/processing_b8a1.json`), false);
});

test('sweep：列举失败如实报错，不猜、不删', async () => {
  const transport = {
    calls: [],
    push: () => Promise.resolve({ ok: true }),
    run: () => Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'device offline' }),
  };
  const { instance } = createMailbox({ transport });

  const report = await instance.sweep();

  assert.equal(report.ok, false);
  assert.match(report.error, /device offline/);
  assert.deepEqual(report.deleted, []);
});

test('sweep：读单个 result 时 transport 抛异常也只记 kept，不炸整轮', async () => {
  const dir = '/sdcard/bridge-amoobridge';
  const transport = createVirtualDeviceTransport({
    [`${dir}/result_a.json`]: JSON.stringify({ id: 'a', tool: 'ping', ok: true }),
    [`${dir}/result_b.json`]: JSON.stringify({ id: 'b', tool: 'ping', ok: true }),
  });
  const originalRun = transport.run.bind(transport);
  transport.run = (argv) => {
    if (argv[1] === 'cat' && argv[2] === `${dir}/result_a.json`) {
      return Promise.reject(new Error('adb 连接断了'));
    }
    return originalRun(argv);
  };
  const { instance } = createMailbox({ transport });

  const report = await instance.sweep();

  assert.equal(report.ok, true);
  assert.deepEqual(report.deleted, ['result_b.json']);
  assert.equal(report.kept[0].name, 'result_a.json');
  assert.match(report.kept[0].reason, /result_read_error/);
});


// ── S1：result 的唯一消费方 = 本模块的 call()/sweep()；消费 = 读到内容并报告 ──
// 「禁止用清空目录冒充消费」在这里落成两条：每条被删的 result 必须先被读出、
// 解析并出现在 harvested 里；dryRun 只报计划、一个字节都不删。

test('sweep 把回执内容收进 harvested（id/tool/ok/state/ms/preview），然后再删文件', async () => {
  const dir = '/sdcard/bridge-amoobridge';
  const transport = createVirtualDeviceTransport({
    [`${dir}/result_a.json`]: JSON.stringify({
      id: 'a', tool: 'exec', ok: true, state: 'done', ms: 42, out: 'hello world',
    }),
  });
  const { instance } = createMailbox({ transport });

  const report = await instance.sweep();

  assert.equal(report.harvested.length, 1);
  const h = report.harvested[0];
  assert.equal(h.id, 'a');
  assert.equal(h.tool, 'exec');
  assert.equal(h.ok, true);
  assert.equal(h.state, 'done');
  assert.equal(h.ms, 42);
  assert.match(h.preview, /hello world/);
  assert.deepEqual(report.deleted, ['result_a.json']);
  assert.equal(transport.store.has(`${dir}/result_a.json`), false);
});

test('sweep dryRun：只读内容并报计划，不删任何文件（清空目录不算消费）', async () => {
  const dir = '/sdcard/bridge-amoobridge';
  const transport = createVirtualDeviceTransport({
    [`${dir}/result_a.json`]: JSON.stringify({ id: 'a', tool: 'ping', ok: true }),
    [`${dir}/result_b.json`]: JSON.stringify({ id: 'b', tool: 'ping', ok: true }),
  });
  const { instance } = createMailbox({ transport });

  const report = await instance.sweep({ dryRun: true });

  assert.equal(report.harvested.length, 2);
  assert.equal(report.deleted.length, 0);
  assert.deepEqual(
    report.kept.map((k) => `${k.name}:${k.reason}`).sort(),
    ['result_a.json:dry_run_would_delete', 'result_b.json:dry_run_would_delete'],
  );
  assert.equal(rmCalls(transport).length, 0);
  assert.equal(transport.store.has(`${dir}/result_a.json`), true);
  assert.equal(transport.store.has(`${dir}/result_b.json`), true);
});

test('harvested.preview 截断 ≤120 字且过 redactSecrets：正文不外传', async () => {
  const dir = '/sdcard/bridge-amoobridge';
  const token = '5500fae8db41cd054f45ea8834198d30';
  const transport = createVirtualDeviceTransport({
    [`${dir}/result_secret.json`]: JSON.stringify({
      id: 'secret', tool: 'exec', ok: true,
      out: `Authorization: Bearer ${token} ${'x'.repeat(400)}`,
    }),
  });
  const { instance } = createMailbox({ transport });

  const report = await instance.sweep();

  assert.equal(report.harvested.length, 1);
  assert.ok(report.harvested[0].preview.length <= 120, `preview 长度 ${report.harvested[0].preview.length}`);
  assert.equal(report.harvested[0].preview.includes(token), false);
});

test('删掉的文件数必须等于读出来并报告过的回执数：读不出的只 kept、文件还在', async () => {
  const dir = '/sdcard/bridge-amoobridge';
  const transport = createVirtualDeviceTransport({
    [`${dir}/result_good.json`]: JSON.stringify({ id: 'good', tool: 'ping', ok: true }),
    [`${dir}/result_raw.json`]: 'not json at all',
  });
  const { instance } = createMailbox({ transport });

  const report = await instance.sweep();

  assert.deepEqual(report.deleted, ['result_good.json']);
  assert.equal(report.harvested.length, 1);
  assert.equal(report.harvested[0].id, 'good');
  assert.equal(transport.store.has(`${dir}/result_raw.json`), true);
  assert.ok(report.kept.some((k) => k.name === 'result_raw.json' && k.reason === 'result_not_json_object'));
});

// S1 的「唯一消费方」= **发起该 id 的那个信箱客户端**（issuer-consumer）：
//   · phone 通道：本模块（call()/sweep()）；
//   · amoo 通道：amooMailbox.js（amooDispatchRunner 的 clipboard 回退自己发、
//     自己读、自己删，不替别人消费）。
// 任何第三方（状态面/巡检/GC/新加的清理器）都不得打开 result 文件：
// 它们只允许读 status.mailbox 的计数与 oldest_result_age_ms/dropped。
// 这条测试用源码扫描把「第三类读者」钉死——加一个就会红。
test('唯一消费方：result_*.json 只由「发起方」信箱客户端读/删，状态面不得打开它', () => {
  const srcRoot = nodePath.resolve(__dirname, '..', '..', '..', '..');
  const allowedConsumers = new Set(['phoneBridgeMailbox.js', 'amooMailbox.js']);
  const scanTargets = [];
  const walk = (dir) => {
    for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
        scanTargets.push(full);
      }
    }
  };
  walk(nodePath.join(srcRoot, 'services', 'domain', 'network', 'phone'));
  walk(nodePath.join(srcRoot, 'services', 'domain', 'network', 'amoo'));
  scanTargets.push(nodePath.join(srcRoot, 'cli', 'handlers', 'phone.js'));

  // 真正的「读/删 result 文件」形状；oldest_result_age_ms 这类状态字段不算。
  const readsResultFile = /result_\$\{|result_[A-Za-z0-9_-]+\.json/;
  const offenders = [];
  for (const file of scanTargets) {
    const name = nodePath.basename(file);
    if (allowedConsumers.has(name)) continue;
    if (readsResultFile.test(nodeFs.readFileSync(file, 'utf8'))) {
      offenders.push(nodePath.relative(srcRoot, file));
    }
  }
  assert.deepEqual(offenders, [], 'result_*.json 只允许发起方信箱客户端读/删，发现第三类读者：' + offenders.join(', '));
});
