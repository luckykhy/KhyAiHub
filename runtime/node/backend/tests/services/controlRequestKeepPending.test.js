'use strict';

/**
 * controlRequestKeepPending.test.js — 105 P-04 剩余半边「人工等待不计入执行超时」
 * 的叶子侧单测(node:test)。guardControlRequest 新增的 opts.onSettled 回调在
 * 等待真正 settle 的三条路径(原 promise / abort / 超时)各被调用一次且只一次;
 * 门控关与非等待早退路径不调。toolUseLoopCore 侧用它把人工应答喂给
 * lastActivityTime(人工等待不是 loop 空闲)。不修改既有 controlRequestGuard.test.js
 * 的 90 行基线(本文件是加法式新文件)。
 */

const test = require('node:test');
const assert = require('node:assert');

const g = require('../../src/services/controlRequestGuard');

const ON = {};

test('原 promise resolve → onSettled 恰好 1 次，结果透传原值', async () => {
  let calls = 0;
  const ac = new AbortController(); // never aborted — just a live signal
  const v = await g.guardControlRequest(Promise.resolve('ok'), {
    env: ON,
    signal: ac.signal,
    onSettled: () => {
      calls += 1;
    },
  });
  assert.equal(v, 'ok');
  assert.equal(calls, 1);
});

test('原 promise reject → onSettled 恰好 1 次，归一为 null', async () => {
  let calls = 0;
  const ac = new AbortController(); // never aborted — just a live signal
  const v = await g.guardControlRequest(Promise.reject(new Error('x')), {
    env: ON,
    signal: ac.signal,
    onSettled: () => {
      calls += 1;
    },
  });
  assert.equal(v, null);
  assert.equal(calls, 1);
});

test('abort 先到 → onSettled 恰好 1 次，null', async () => {
  let calls = 0;
  const ac = new AbortController();
  const never = new Promise(() => {});
  const p = g.guardControlRequest(never, {
    env: ON,
    signal: ac.signal,
    onSettled: () => {
      calls += 1;
    },
  });
  ac.abort();
  const v = await p;
  assert.equal(v, null);
  assert.equal(calls, 1);
});

test('超时先到(注入定时器) → onSettled 恰好 1 次，null', async () => {
  let calls = 0;
  const timers = [];
  const fakeSetTimeout = (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  const fakeClearTimeout = () => {};
  const never = new Promise(() => {});
  const p = g.guardControlRequest(never, {
    env: ON,
    timeoutMs: 1000,
    onSettled: () => {
      calls += 1;
    },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000);
  timers[0].fn(); // fire the timeout
  const v = await p;
  assert.equal(v, null);
  assert.equal(calls, 1);
});

test('门控关 → onSettled 不调，返回原 promise 同一引用', async () => {
  let calls = 0;
  const p = Promise.resolve(42);
  const out = g.guardControlRequest(p, {
    env: { KHY_CONTROL_REQUEST_GUARD: '0' },
    onSettled: () => {
      calls += 1;
    },
  });
  assert.equal(out, p);
  await out;
  assert.equal(calls, 0);
});

test('非 thenable → onSettled 不调，透传', () => {
  let calls = 0;
  const input = { then: 'not-a-function' };
  const out = g.guardControlRequest(input, {
    env: ON,
    onSettled: () => {
      calls += 1;
    },
  });
  assert.equal(out, input);
  assert.equal(calls, 0);
});

test('无信号且无超时 → 等价 await 原 promise，onSettled 不调(无可赛跑者)', async () => {
  let calls = 0;
  const p = Promise.resolve('plain');
  const out = g.guardControlRequest(p, {
    env: ON,
    onSettled: () => {
      calls += 1;
    },
  });
  assert.equal(await out, 'plain');
  // Note: with no racers the leaf returns the promise as-is (fast path);
  // the settle path never runs, so no feed happens — same as today.
  assert.equal(calls, 0);
});

test('已中断立即 null → onSettled 不调(无等待发生)', async () => {
  let calls = 0;
  const ac = new AbortController();
  ac.abort();
  const v = await g.guardControlRequest(new Promise(() => {}), {
    env: ON,
    signal: ac.signal,
    onSettled: () => {
      calls += 1;
    },
  });
  assert.equal(v, null);
  assert.equal(calls, 0);
});

test('竞态：原 promise 与超时同时就绪 → onSettled 只调 1 次', async () => {
  let calls = 0;
  const timers = [];
  const fakeSetTimeout = (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  const fakeClearTimeout = () => {};
  const p = g.guardControlRequest(Promise.resolve('raced'), {
    env: ON,
    timeoutMs: 5,
    onSettled: () => {
      calls += 1;
    },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  });
  // Fire the timeout before the microtask queue resolves the promise winner.
  for (const t of timers) t.fn();
  const v = await p;
  assert.ok(v === 'raced' || v === null);
  assert.equal(calls, 1);
});
