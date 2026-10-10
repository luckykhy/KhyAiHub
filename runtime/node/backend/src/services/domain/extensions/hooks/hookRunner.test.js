'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const path = require('path');

// Stub child_process BEFORE requiring hookRunner: the runner must never really
// spawn a shell in tests. Restored in after() so sibling suites are unaffected.
const cpKey = require.resolve('child_process');
const realChildProcess = require('child_process');
let spawned = [];
let lastChild = null;
let puStub = null;

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = (s) => {
    child.stdinWrites.push(s);
  };
  child.stdin.end = () => {};
  child.kill = (sig) => {
    child.killed.push(sig);
  };
  child.stdinWrites = [];
  child.killed = [];
  return child;
}

function installSpawnStub() {
  spawned = [];
  lastChild = null;
  const stub = {
    ...realChildProcess,
    spawn(cmd, args, opts) {
      const child = makeFakeChild();
      child.pid = 424242;
      child.argv = { cmd, args, opts };
      spawned.push(child);
      lastChild = child;
      return child;
    },
  };
  require.cache[cpKey] = { id: cpKey, filename: cpKey, loaded: true, exports: stub };

  // platformUtils.safeKill would shell out to taskkill on Windows, so the shell
  // helper is stubbed too: the test asserts what the runner *decided* (kill with
  // SIGKILL), never that a real process was signalled.
  const puPath = require.resolve(path.join(__dirname, '../../../../tools/platformUtils'));
  const realPlatformUtils = require(puPath);
  require.cache[puPath] = {
    id: puPath,
    filename: puPath,
    loaded: true,
    exports: {
      ...realPlatformUtils,
      platformShell: (command) => ({ cmd: 'fake-shell', args: [command] }),
      safeKill: (child, signal) => {
        if (child && Array.isArray(child.killed)) {
          child.killed.push(signal);
        }
      },
    },
  };
  puStub = { path: puPath, real: realPlatformUtils };
}

function restoreSpawnStub() {
  require.cache[cpKey] = { id: cpKey, filename: cpKey, loaded: true, exports: realChildProcess };
  if (puStub) {
    require.cache[puStub.path] = { id: puStub.path, filename: puStub.path, loaded: true, exports: puStub.real };
  }
}

installSpawnStub();
const R = require('./hookRunner.js');
const { runHook, safeRunHook, runHooks, getHookMetrics, filterCommandOutput, CMD_HOOK_ALLOWED_FIELDS } = R;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drain = () => sleep(5);

after(() => {
  restoreSpawnStub();
});

describe('filterCommandOutput — command hook 输出白名单', () => {
  test('每个 HOOK_EVENTS 事件都有白名单条目（缺条目等于完全不过滤）', () => {
    const { HOOK_EVENTS } = require('./hookRegistry.js');
    for (const ev of HOOK_EVENTS) {
      assert.ok(Array.isArray(CMD_HOOK_ALLOWED_FIELDS[ev]), `${ev} 缺白名单条目`);
    }
    assert.deepEqual(CMD_HOOK_ALLOWED_FIELDS.ToolPermission, ['decision']);
    assert.deepEqual(CMD_HOOK_ALLOWED_FIELDS.PromptSection, ['sections', 'section']);
    assert.deepEqual(CMD_HOOK_ALLOWED_FIELDS.PreToolUse, ['params']);
    assert.deepEqual(CMD_HOOK_ALLOWED_FIELDS.SubAgentStart, []);
  });

  test('非白名单字段被剔除并记进 dropped，白名单字段原样保留', () => {
    const res = filterCommandOutput('PreToolUse', { params: { a: 1 }, iteration: 999, toolName: 'x' });
    assert.deepEqual(res.filtered, { params: { a: 1 } });
    assert.deepEqual(res.dropped, ['iteration', 'toolName']);
    const tp = filterCommandOutput('ToolPermission', { decision: 'deny', params: { b: 2 }, prompt: 'p' });
    assert.deepEqual(tp.filtered, { decision: 'deny' });
    assert.deepEqual(tp.dropped, ['params', 'prompt']);
  });

  test('null/undefined/字符串/数字原样返回；数组按对象过滤（逐下标键全被剔除）', () => {
    for (const v of [null, undefined, 0, '', 'text', 12]) {
      const res = filterCommandOutput('PreToolUse', v);
      assert.deepEqual(res.filtered, v);
      assert.deepEqual(res.dropped, []);
    }
    const arr = filterCommandOutput('PreToolUse', ['a']);
    assert.deepEqual(arr.filtered, {});
    assert.deepEqual(arr.dropped, ['0']);
  });

  test('未知事件名（不在白名单表里）原样透传 —— 文档承认的兜底分支', () => {
    const res = filterCommandOutput('NotAnEvent', { iteration: 999, params: {} });
    assert.deepEqual(res.filtered, { iteration: 999, params: {} });
    assert.deepEqual(res.dropped, []);
  });

  test('KNOWN-DEFECT: 事件名命中 Object.prototype 时抛 TypeError（hookRunner.js:59-67）', () => {
    // `CMD_HOOK_ALLOWED_FIELDS[event]` is an unguarded plain-object lookup: for
    // 'constructor'/'toString'/'__proto__' it returns a prototype member (truthy, so
    // the `!allowed` fallback is skipped) and `allowed.includes` does not exist.
    // The documented "unknown event → pass through untouched" branch never runs.
    for (const ev of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      assert.throws(
        () => filterCommandOutput(ev, { params: { x: 1 } }),
        (err) => err instanceof TypeError && /allowed\.includes is not a function/.test(err.message),
        `${ev} 应当抛 TypeError`
      );
    }
  });
});

describe('runHook — 函数型 hook', () => {
  test('返回 block 时保留 approvable / source，reason 落到 error 字段', async () => {
    const hook = { type: 'function', event: 'PreToolUse', source: 'guard', timeout: 1000, handler: () => ({ action: 'block', reason: '太危险', approvable: true, source: 'guard' }) };
    const res = await runHook(hook, {});
    assert.deepEqual(res, { action: 'block', error: '太危险', approvable: true, source: 'guard' });
    const hard = await runHook({ ...hook, handler: () => ({ action: 'block' }) }, {});
    assert.equal(hard.error, 'Blocked by function hook');
    assert.equal(hard.approvable, false);
  });

  test('返回 modify 时把除 action 以外的字段整体作为 output', async () => {
    const res = await runHook({ type: 'function', event: 'PrePrompt', handler: () => ({ action: 'modify', additionalContext: 'note', prompt: 'p2' }) }, {});
    assert.equal(res.action, 'modify');
    assert.deepEqual(res.output, { additionalContext: 'note', prompt: 'p2' });
    assert.equal('action' in res.output, false);
  });

  test('返回非对象/数组/null 视为放行；带自定义 action 的透传 output', async () => {
    for (const v of [null, undefined, 0, '', 'str', true]) {
      assert.deepEqual(await runHook({ type: 'function', handler: () => v }, {}), { action: 'allow' });
    }
    const odd = await runHook({ type: 'function', handler: () => ({ action: 'noop', foo: 1 }) }, {});
    assert.equal(odd.action, 'noop');
    assert.deepEqual(odd.output, { action: 'noop', foo: 1 });
  });

  test('handler 抛错 → action allow + error（守卫崩了就等于放行）', async () => {
    const res = await safeRunHook({ type: 'function', event: 'PreToolUse', source: 'guard', handler: () => { throw new Error('guard crashed'); } }, {});
    assert.equal(res.action, 'allow');
    assert.equal(res.error, 'guard crashed');
    const rejected = await safeRunHook({ type: 'function', handler: () => Promise.reject(new Error('nope')) }, {});
    assert.equal(rejected.action, 'allow');
    assert.equal(rejected.error, 'nope');
  });

  test('handler 挂死 → 固定 timeout 后报 allow，但 handler 继续跑完且结果被丢弃', async () => {
    let completed = 0;
    const hook = {
      type: 'function',
      event: 'PreToolUse',
      source: 'slow-guard',
      timeout: 20,
      handler: () => new Promise((resolve) => {
        setTimeout(() => {
          completed += 1;
          resolve({ action: 'block', reason: '其实想拦' });
        }, 60);
      }),
    };
    // The runner's timers are unref()'d, so a ref'd timer must hold the loop open
    // or the timeout would never fire.
    const keepAlive = sleep(200);
    const res = await safeRunHook(hook, {});
    assert.equal(res.action, 'allow');
    assert.equal(res.error, 'Hook function timed out');
    assert.equal(completed, 0, '超时只是放弃等待，handler 并未被取消');
    await keepAlive;
    assert.equal(completed, 1, 'handler 在后台跑完了');
    // 它最终判出的 block 无人认领：runner 早已返回 allow，调用方也收不到任何回执。
    assert.equal(res.action, 'allow');
  });

  test('声明为 function 但 handler 不可调用 → 明确报错且不起子进程', async () => {
    const before = spawned.length;
    for (const bad of [undefined, null, 'string', {}, 0]) {
      const res = await runHook({ type: 'function', event: 'PreToolUse', handler: bad }, {});
      assert.equal(res.action, 'allow');
      assert.equal(res.error, 'Function hook has no callable handler');
    }
    assert.equal(spawned.length, before, '不得伪装成 command hook 去 spawn shell');
  });

  test('KNOWN-DEFECT: handler 抛错/超时的 hook 结果与「没有注册任何 hook」逐字节相同，崩掉的守卫静默转为放行（hookRunner.js:146 / 194）', async () => {
    // Both the crashed guard and the healthy "allow" guard produce action:'allow';
    // only `runHooks` looks at action, so the error string is dropped on the way out
    // and the caller cannot distinguish "guard approved" from "guard exploded".
    const crashed = await runHooks(
      [{ type: 'function', event: 'PreToolUse', source: 'guard', handler: () => { throw new Error('boom'); } }],
      { toolName: 'Bash' }
    );
    const healthy = await runHooks(
      [{ type: 'function', event: 'PreToolUse', source: 'guard', handler: async () => ({ action: 'allow' }) }],
      { toolName: 'Bash' }
    );
    assert.equal(crashed.blocked, false);
    assert.deepEqual(crashed, healthy);
    assert.equal('error' in crashed, false, '失败原因没有任何出口');
  });
});

describe('runHook — command hook（桩掉 child_process）', () => {
  before(() => {
    installSpawnStub();
  });

  test('缺 command / 纯空白 command 不起 shell', async () => {
    const before = spawned.length;
    for (const cmd of [undefined, null, '', '   ', '\t\n', 0]) {
      const res = await runHook({ type: 'command', event: 'PreToolUse', command: cmd, timeout: 50 }, {});
      assert.equal(res.action, 'allow');
      assert.equal(res.error, 'Command hook has no command');
    }
    assert.equal(spawned.length, before);
  });

  test('context 以 JSON 写入 stdin，env 带 HOOK_EVENT', async () => {
    const p = runHook({ type: 'command', event: 'PostToolUse', command: 'my-hook', timeout: 500 }, { toolName: 'Bash', n: 1 });
    await drain();
    assert.equal(lastChild.stdinWrites.length, 1);
    assert.deepEqual(JSON.parse(lastChild.stdinWrites[0]), { toolName: 'Bash', n: 1 });
    assert.equal(lastChild.argv.opts.env.HOOK_EVENT, 'PostToolUse');
    lastChild.emit('close', 0);
    assert.equal((await p).action, 'allow');
  });

  test('退出码 2 → block，stderr 作为 reason；空 stderr 用兜底文案', async () => {
    const p = runHook({ type: 'command', event: 'PreToolUse', command: 'h', timeout: 500 }, {});
    await drain();
    lastChild.stderr.emit('data', '策略禁止');
    lastChild.emit('close', 2);
    const res = await p;
    assert.deepEqual(res, { action: 'block', error: '策略禁止' });

    const p2 = runHook({ type: 'command', event: 'PreToolUse', command: 'h', timeout: 500 }, {});
    await drain();
    lastChild.emit('close', 2);
    assert.equal((await p2).error, 'Blocked by hook');
  });

  test('退出码 0 + JSON stdout → modify，且只带白名单字段', async () => {
    const p = runHook({ type: 'command', event: 'PreToolUse', command: 'h', timeout: 500 }, {});
    await drain();
    lastChild.stdout.emit('data', '{"params":{"a":1},"iteration":999}');
    lastChild.emit('close', 0);
    const res = await p;
    assert.equal(res.action, 'modify');
    assert.deepEqual(res.output, { params: { a: 1 } });
  });

  test('stdout 不是 JSON / 空 stdout → allow 且不报错', async () => {
    const p = runHook({ type: 'command', event: 'PreToolUse', command: 'h', timeout: 500 }, {});
    await drain();
    lastChild.stdout.emit('data', 'plain text');
    lastChild.emit('close', 0);
    const res = await p;
    assert.equal(res.action, 'allow');
    assert.equal(res.output, undefined);
    assert.equal(res.error, undefined);
  });

  test('spawn 报 error 事件 → allow + error 文本', async () => {
    const p = runHook({ type: 'command', event: 'PreToolUse', command: 'h', timeout: 500 }, {});
    await drain();
    lastChild.emit('error', new Error('ENOENT'));
    const res = await p;
    assert.equal(res.action, 'allow');
    assert.equal(res.error, 'ENOENT');
  });

  test('超时会 kill 子进程并如实报 allow + 超时文本', async () => {
    const keepAlive = sleep(200);
    const p = safeRunHook({ type: 'command', event: 'PreToolUse', command: 'h', timeout: 20 }, {});
    const res = await p;
    assert.equal(res.action, 'allow');
    assert.match(res.error, /Hook timed out after 20ms/);
    assert.ok(lastChild.killed.length >= 1, '必须真的下 kill 信号');
    await keepAlive;
  });

  test('stdin 写失败（EPIPE）不影响结果，也不炸进程', async () => {
    const p = safeRunHook({ type: 'command', event: 'PreToolUse', command: 'h', timeout: 500 }, {});
    await drain();
    lastChild.stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
    lastChild.emit('close', 0);
    assert.equal((await p).action, 'allow');
  });

  test('KNOWN-DEFECT: 非零退出的 command hook 只要吐出白名单 JSON，改动仍然生效（hookRunner.js:213-244）', async () => {
    // Only exit code 2 blocks. A hook that crashes with code 7 while having printed
    // JSON still returns action 'modify', and runHooks merges it — a failed hook
    // rewrites the loop context on its way out.
    const p = runHook({ type: 'command', event: 'PostToolUse', command: 'h', timeout: 500 }, {});
    await drain();
    lastChild.stdout.emit('data', '{"result":"MUTATED"}');
    lastChild.stderr.emit('data', 'hook blew up');
    lastChild.emit('close', 7);
    const res = await p;
    assert.equal(res.action, 'modify');
    assert.deepEqual(res.output, { result: 'MUTATED' });
    assert.equal(res.error, 'hook blew up');
    const keepRunning = runHooks(
      [{ type: 'command', event: 'PostToolUse', command: 'h', timeout: 500 }],
      { result: 'orig' }
    );
    await drain();
    lastChild.stdout.emit('data', '{"result":"MUTATED-BY-FAILED-HOOK"}');
    lastChild.stderr.emit('data', 'boom');
    lastChild.emit('close', 7);
    const merged = await keepRunning;
    assert.equal(merged.blocked, false);
    assert.equal(merged.context.result, 'MUTATED-BY-FAILED-HOOK', '失败 hook 的改动仍然合进了循环上下文');
  });
});

describe('runHooks / safeRunHook — 编排与容错', () => {
  test('顺序执行：前一个 modify 的结果是后一个的入参 context', async () => {
    const seen = [];
    const hooks = [
      { type: 'function', event: 'PrePrompt', handler: (c) => { seen.push(c.prompt); return { action: 'modify', prompt: 'mid' }; } },
      { type: 'function', event: 'PrePrompt', handler: (c) => { seen.push(c.prompt); return { action: 'modify', prompt: 'last' }; } },
    ];
    const res = await runHooks(hooks, { prompt: 'start' });
    assert.deepEqual(seen, ['start', 'mid']);
    assert.equal(res.context.prompt, 'last');
    assert.equal(res.blocked, false);
  });

  test('block 立即短路，后续 hook 不再执行，并把 reason/approvable/source 交回调用方', async () => {
    let ran = 0;
    const res = await runHooks([
      { type: 'function', event: 'PreToolUse', handler: () => ({ action: 'block', reason: 'nope', approvable: true, source: 'g1' }) },
      { type: 'function', event: 'PreToolUse', handler: () => { ran += 1; return { action: 'allow' }; } },
    ], { toolName: 'Bash' });
    assert.equal(ran, 0);
    assert.deepEqual(res, { blocked: true, reason: 'nope', approvable: true, source: 'g1', context: { toolName: 'Bash' } });
  });

  test('传入的 context 不被就地改写顶层字段，但浅拷贝共享嵌套对象', async () => {
    const orig = { params: { k: 1 } };
    const res = await runHooks([{ type: 'function', handler: () => ({ action: 'modify', params: { k: 2 } }) }], orig);
    assert.deepEqual(orig.params, { k: 1 });
    assert.deepEqual(res.context.params, { k: 2 });
    // Shallow spread: the nested object identity is handed to the handler, so a
    // function hook that mutates it in place writes through to the caller's object.
    const nested = { deep: 'orig' };
    await runHooks([{ type: 'function', handler: (c) => { c.nested.deep = 'written'; return { action: 'allow' }; } }], { nested });
    assert.equal(nested.deep, 'written');
  });

  test('空 hooks 数组与垃圾入参', async () => {
    assert.deepEqual(await runHooks([], { a: 1 }), { blocked: false, context: { a: 1 } });
    assert.equal((await runHooks([], {})).blocked, false);
  });

  test('safeRunHook 把非字符串 action 的结果归一为 allow', async () => {
    const res = await safeRunHook({ type: 'function', event: 'Stop', handler: () => ({ action: 42 }) }, {});
    assert.equal(res.action, 'allow');
    assert.equal(res.error, 'Hook returned invalid result');
    const arr = await safeRunHook({ type: 'function', event: 'Stop', handler: () => [] }, {});
    // An array is truthy and typeof 'object', so it leaks through as `output` with
    // action 'allow' — the runner never validates the shape of a non-action result.
    assert.deepEqual(arr, { action: 'allow', output: [] });
  });

  test('KNOWN-DEFECT: safeRunHook(null) 自己抛 TypeError，违背「No thrown error propagates」契约（hookRunner.js:286 / 301）', async () => {
    // The catch block dereferences `hook.source` before it can normalize anything,
    // so a null/undefined hook escapes as an exception instead of the promised
    // { action: 'allow', error } result.
    await assert.rejects(() => safeRunHook(null, {}), TypeError);
    await assert.rejects(() => safeRunHook(undefined, {}), TypeError);
    const res = await safeRunHook({ type: 'command' }, {});
    assert.equal(res.action, 'allow');
  });

  test('getHookMetrics 交副本，导出的 _hookMetrics 是活数组本体', async () => {
    await safeRunHook({ type: 'function', event: 'Stop', source: 'm1', handler: () => ({ action: 'allow' }) }, {});
    const snap = getHookMetrics();
    assert.ok(snap.length >= 1);
    const last = snap[snap.length - 1];
    assert.equal(last.hookSource, 'm1');
    assert.equal(last.event, 'Stop');
    assert.equal(typeof last.durationMs, 'number');
    assert.notEqual(snap, R._hookMetrics, 'getHookMetrics 必须交副本');
    // 但 module.exports._hookMetrics 就是真源本体：调用方 push 即污染遥测。
    const n = R._hookMetrics.length;
    R._hookMetrics.push({ hookSource: 'injected', event: 'X' });
    assert.equal(getHookMetrics().length, n + 1);
    R._hookMetrics.length = n;
  });
});
