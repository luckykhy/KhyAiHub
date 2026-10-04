'use strict';

// Co-located tests for runners.js. All spawning goes through injected fake
// `cp`/`fs` deps — no real child process is ever created and no real file is
// opened. Assertions focus on what the module DECIDED (argv, wrapping, fds).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { EventEmitter } = require('events');
const runners = require('./runners');

function makeCp(spawnSyncResult = { status: 0, stdout: 'ok-out', stderr: 'ok-err', error: null }) {
  const calls = [];
  const children = [];
  return {
    calls,
    children,
    spawnSync: (exe, args, opts) => { calls.push({ exe, args, opts }); return spawnSyncResult; },
    spawn: (exe, args, opts) => {
      const child = new EventEmitter();
      child.pid = 4242;
      child.unref = () => { child.unrefCalled = true; };
      children.push({ exe, args, opts, child });
      return child;
    },
  };
}

function makeFs() {
  const calls = { mkdir: [], open: [], close: [] };
  return {
    calls,
    mkdirSync: (p, opts) => calls.mkdir.push([p, opts]),
    openSync: (p, flag) => { calls.open.push([p, flag]); return 7; },
    closeSync: (fd) => calls.close.push(fd),
  };
}

const CMD = { exe: 'npm.cmd', args: ['run', 'start'], display: 'npm.cmd run start' };
const PLAIN = { exe: 'node', args: ['server.js'], display: 'node server.js' };

describe('runStep', () => {
  test('退出码 0 → ok:true，output 拼接 stdout+stderr', () => {
    const cp = makeCp();
    const r = runners.runStep(CMD, { cwd: 'C:/target', deps: { cp, fs: makeFs(), platform: 'linux' } });
    assert.deepEqual(r, { ok: true, code: 0, signal: null, output: 'ok-outok-err', command: 'npm.cmd run start' });
  });

  test('非零退出码与信号原样上报', () => {
    const cp = makeCp({ status: 3, stdout: 'a', stderr: 'b', error: null, signal: 'SIGTERM' });
    const r = runners.runStep(CMD, { cwd: 'x', deps: { cp, fs: makeFs(), platform: 'linux' } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 3);
    assert.equal(r.signal, 'SIGTERM');
  });

  test('ENOENT → 命令未找到文案并点名原始 exe', () => {
    const cp = makeCp({ status: null, stdout: null, stderr: null, error: Object.assign(new Error('spawn npm.cmd ENOENT'), { code: 'ENOENT' }) });
    const r = runners.runStep(CMD, { cwd: 'x', deps: { cp, fs: makeFs(), platform: 'linux' } });
    assert.equal(r.ok, false);
    assert.equal(r.code, null);
    assert.equal(r.output, '命令未找到: npm.cmd（请确认其已安装并在 PATH 中）');
  });

  test('其他 spawn error 透传 message', () => {
    const cp = makeCp({ status: null, stdout: '', stderr: '', error: new Error('spawn EPERM') });
    const r = runners.runStep(CMD, { cwd: 'x', deps: { cp, fs: makeFs(), platform: 'linux' } });
    assert.equal(r.output, 'spawn EPERM');
  });

  test('output 超长时保留末尾 MAX_CAPTURE 字符（尾部诊断优先）', () => {
    const huge = 'x'.repeat(5000) + 'TAILMARK';
    const cp = makeCp({ status: 1, stdout: huge, stderr: '', error: null });
    const r = runners.runStep(CMD, { cwd: 'x', deps: { cp, fs: makeFs(), platform: 'linux' } });
    assert.equal(r.output.length, runners.MAX_CAPTURE);
    assert.ok(r.output.endsWith('TAILMARK'));
  });

  test('stdout/stderr 为 null 时拼接安全降级为空串', () => {
    const cp = makeCp({ status: 0, stdout: null, stderr: null, error: null });
    const r = runners.runStep(CMD, { cwd: 'x', deps: { cp, fs: makeFs(), platform: 'linux' } });
    assert.equal(r.output, '');
  });

  test('无 display 的命令用 exe+args 兜底构造 display', () => {
    const cp = makeCp();
    const r = runners.runStep({ exe: 'go', args: ['run', '.'] }, { cwd: 'x', deps: { cp, fs: makeFs(), platform: 'linux' } });
    assert.equal(r.command, 'go run .');
  });

  test('spawnSync 收到 utf8/windowsHide/timeout 透传与 opts.env 覆盖', () => {
    const cp = makeCp();
    runners.runStep(PLAIN, { cwd: 'C:/w', env: { CUSTOM: '1' }, timeoutMs: 5000, deps: { cp, fs: makeFs(), platform: 'linux' } });
    const call = cp.calls[0];
    assert.equal(call.exe, 'node');
    assert.deepEqual(call.args, ['server.js']);
    assert.equal(call.opts.cwd, 'C:/w');
    assert.deepEqual(call.opts.env, { CUSTOM: '1' });
    assert.equal(call.opts.timeout, 5000);
    assert.equal(call.opts.encoding, 'utf8');
    assert.equal(call.opts.windowsHide, true);
  });

  test('默认 timeout 为 0（不硬 kill）且 env 落到 process.env', () => {
    const cp = makeCp();
    runners.runStep(PLAIN, { cwd: 'C:/w', deps: { cp, fs: makeFs(), platform: 'linux' } });
    assert.equal(cp.calls[0].opts.timeout, 0);
    assert.equal(cp.calls[0].opts.env, process.env);
  });

  test('win32 的 .cmd/.bat 走 cmd.exe /d /s /c 显式包装（避开 DEP0190）', () => {
    const cp = makeCp();
    runners.runStep(CMD, { cwd: 'x', deps: { cp, fs: makeFs(), platform: 'win32' } });
    assert.equal(cp.calls[0].exe, process.env.COMSPEC || 'cmd.exe');
    assert.deepEqual(cp.calls[0].args, ['/d', '/s', '/c', 'npm.cmd', 'run', 'start']);
    const cp2 = makeCp();
    runners.runStep({ exe: 'X.BAT', args: [] }, { cwd: 'x', deps: { cp: cp2, fs: makeFs(), platform: 'win32' } });
    assert.deepEqual(cp2.calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
  });

  test('非 win32 或普通 exe 不包装', () => {
    const cp = makeCp();
    runners.runStep(CMD, { cwd: 'x', deps: { cp, fs: makeFs(), platform: 'linux' } });
    assert.equal(cp.calls[0].exe, 'npm.cmd');
    assert.equal(cp.calls[1], undefined);
  });
});

describe('launch', () => {
  const log = '/deploy/target/.khy-deploy/app.log';

  test('win32 不 detached；fd 传给子进程后本方立即 close', () => {
    const cp = makeCp();
    const fs2 = makeFs();
    const r = runners.launch(CMD, { cwd: 'C:/t', logFile: log, deps: { cp, fs: fs2, platform: 'win32' } });
    assert.equal(r.pid, 4242);
    assert.equal(r.logFile, log);
    assert.equal(r.command, 'npm.cmd run start');
    const spawn = cp.children[0];
    assert.equal(spawn.opts.detached, false);
    assert.deepEqual(spawn.opts.stdio, ['ignore', 7, 7]);
    assert.equal(spawn.child.unrefCalled, true);
    assert.deepEqual(fs2.calls.close, [7, 7]);
    assert.equal(fs2.calls.open.length, 2, 'stdout 与 stderr 各 open 一次追加模式');
    assert.equal(fs2.calls.open[0][1], 'a');
  });

  test('非 win32 detached 以独立进程组便于 kill；wrap 仍按平台规则', () => {
    const cp = makeCp();
    runners.launch(PLAIN, { cwd: '/t', logFile: '/t/x.log', deps: { cp, fs: makeFs(), platform: 'linux' } });
    assert.equal(cp.children[0].opts.detached, true);
    assert.equal(cp.children[0].exe, 'node');
  });

  test('spawn 无 pid 时诚实返回 null，不编造', () => {
    const fs2 = makeFs();
    const cp = { spawnSync: () => ({ status: 0 }), spawn: () => ({}) };
    const r = runners.launch(PLAIN, { cwd: '/t', logFile: '/t/x.log', deps: { cp, fs: fs2, platform: 'linux' } });
    assert.equal(r.pid, null);
    assert.equal(r.command, 'node server.js');
  });

  test('日志父目录先递归 mkdir；opts.env 透传', () => {
    const cp = makeCp();
    const fs2 = makeFs();
    runners.launch(PLAIN, { cwd: '/t', logFile: '/deep/nested/dir/x.log', env: { PORT: '8080' }, deps: { cp, fs: fs2, platform: 'linux' } });
    assert.deepEqual(fs2.calls.mkdir[0], ['/deep/nested/dir', { recursive: true }]);
    assert.deepEqual(cp.children[0].opts.env, { PORT: '8080' });
  });

  test('KNOWN-DEFECT: 子进程对象上从未挂 error 监听，spawn 异步失败会炸宿主进程', () => {
    // runners.js:113-125 — child_process.spawn reports ENOENT-style failures
    // asynchronously via an 'error' event on the ChildProcess. launch() never
    // attaches an error listener (it only reads pid and unrefs), so a failed
    // start emits an unhandled 'error' on an EventEmitter — which throws and
    // kills the CLI process, instead of being recorded as status 'failed'.
    const cp = makeCp();
    runners.launch(CMD, { cwd: '/t', logFile: '/t/x.log', deps: { cp, fs: makeFs(), platform: 'linux' } });
    const child = cp.children[0].child;
    assert.ok(child instanceof EventEmitter);
    assert.equal(child.listenerCount('error'), 0, 'no error handler attached anywhere in launch()');
  });

  test('openSync 抛错原样上抛（不静默吞日志失败）', () => {
    const cp = makeCp();
    const fs2 = { mkdirSync: () => {}, openSync: () => { throw new Error('EROFS'); }, closeSync: () => {} };
    assert.throws(() => runners.launch(PLAIN, { cwd: '/t', logFile: '/t/x.log', deps: { cp, fs: fs2, platform: 'linux' } }), /EROFS/);
    assert.equal(cp.children.length, 0);
  });
});

describe('defaultDeps', () => {
  test('返回真实 cp/fs 与当前平台（不触发任何 I/O）', () => {
    const deps = runners.defaultDeps();
    assert.equal(typeof deps.cp.spawnSync, 'function');
    assert.equal(typeof deps.cp.spawn, 'function');
    assert.equal(typeof deps.fs.existsSync, 'function');
    assert.equal(deps.platform, process.platform);
  });
});
