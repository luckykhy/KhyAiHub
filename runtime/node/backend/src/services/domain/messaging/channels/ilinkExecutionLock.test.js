'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const lock = require('./ilinkExecutionLock');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Let any already-queued microtasks/tail promises settle.
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('ilinkExecutionLock —— 进程内串行执行锁', () => {
  it('导出 runExclusive 与测试探针 _isBusy', () => {
    assert.deepStrictEqual(Object.keys(lock).sort(), ['_isBusy', 'runExclusive']);
  });

  it('空闲时 _isBusy 为 false', async () => {
    assert.equal(lock._isBusy(), false);
  });

  it('串行返回 fn 的同步结果并释放锁', async () => {
    const result = await lock.runExclusive(() => 42);
    assert.equal(result, 42);
    assert.equal(lock._isBusy(), false);
  });

  it('await 异步 fn 的解析值', async () => {
    const result = await lock.runExclusive(async () => {
      await tick();
      return 'ok';
    });
    assert.equal(result, 'ok');
  });

  it('fn 执行期间 _isBusy 为 true，完成后回落 false', async () => {
    const d = deferred();
    let busyDuring = null;
    const running = lock.runExclusive(async () => {
      busyDuring = lock._isBusy();
      await d.promise;
      return 'done';
    });
    await tick();
    d.resolve();
    await running;
    assert.equal(busyDuring, true);
    assert.equal(lock._isBusy(), false);
  });

  it('前一个 fn 未完成时后一个不得并行进入', async () => {
    const first = deferred();
    let secondStarted = false;
    const a = lock.runExclusive(() => first.promise);
    const b = lock.runExclusive(() => {
      secondStarted = true;
      return 'b';
    });
    await tick();
    assert.equal(secondStarted, false);
    first.resolve();
    await Promise.all([a, b]);
    assert.equal(secondStarted, true);
  });

  it('按调用时间 FIFO 排序', async () => {
    const order = [];
    const gates = [deferred(), deferred(), deferred()];
    const tasks = gates.map((g, i) =>
      lock.runExclusive(async () => {
        order.push(i);
        await g.promise;
      })
    );
    await tick();
    assert.deepStrictEqual(order, [0]);
    gates[0].resolve();
    await tick();
    assert.deepStrictEqual(order, [0, 1]);
    gates[1].resolve();
    await tick();
    assert.deepStrictEqual(order, [0, 1, 2]);
    gates[2].resolve();
    await Promise.all(tasks);
  });

  it('fn 抛错时原样传播且锁仍释放', async () => {
    const boom = new Error('boom');
    await assert.rejects(() => lock.runExclusive(() => {
      throw boom;
    }), (err) => err === boom);
    assert.equal(lock._isBusy(), false);
  });

  it('一个调用者失败不毒化队列，后续调用照常执行', async () => {
    await assert.rejects(() => lock.runExclusive(async () => {
      throw new Error('reject-me');
    }), /reject-me/);
    const result = await lock.runExclusive(() => 'survived');
    assert.equal(result, 'survived');
  });

  // Measured: runExclusive has no arity/type guard. A non-function argument makes
  // `fn()` throw a TypeError inside the try block, so it rejects with the native
  // "not a function" message rather than a friendly validation error — but the
  // finally still releases, so the queue survives.
  it('KNOWN-DEFECT: 传入非函数不校验类型，以原生 TypeError 失败（但锁不泄漏）', async () => {
    await assert.rejects(() => lock.runExclusive(null), TypeError);
    await assert.rejects(() => lock.runExclusive(undefined), TypeError);
    await assert.rejects(() => lock.runExclusive('nope'), (err) =>
      /is not a function/.test(err.message));
    assert.equal(lock._isBusy(), false);
    const recovered = await lock.runExclusive(() => 'recovered');
    assert.equal(recovered, 'recovered');
  });
});
