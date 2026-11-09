'use strict';
/**
 * streamingToolExecutor.announce.test.js — 预执行必须「开跑即播报」。
 *
 * 缺陷现场（三端共同）：流式阶段预执行的工具在跑，主循环的 onToolCall 却要等
 * chat() 结束 + awaitAll() 归零之后才发 —— 也就是工具**已经跑完**才发。
 * 用户看到的是「先空白很久，然后突然一大段答案」，中间没有任何工具过程。
 *
 * 另附一个被同一条路径掩盖的缺陷：预执行结果按 name+params hash 缓存，而流式阶段
 * 拿的是原始名/原始参数（read_file），主循环用的是规范化后的（readFile + 补全 path），
 * 同一个调用算出两个 hash ⇒ 缓存必然查不到 ⇒ 工具白跑一遍再跑一遍。block id 才是身份。
 */
const { StreamingToolExecutor } = require('../../../src/services/domain/query/query/streamingToolExecutor');

function makeExecutor(overrides = {}) {
  return new StreamingToolExecutor({
    executeTools: async () => ({ ok: true }),
    isConcurrencySafe: () => true,
    ...overrides,
  });
}

describe('StreamingToolExecutor — live progress', () => {
  test('announces a tool the moment it starts, not when it finishes', async () => {
    const order = [];
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const exec = makeExecutor({
      executeTools: async () => {
        order.push('execute-start');
        await gate;
        order.push('execute-end');
        return 'body';
      },
      onToolCall: (call) => order.push(`announce:${call.name}`),
    });

    exec.addTool({ name: 'read_file', params: { file_path: 'a.txt' }, id: 'call_1' });
    // Announcement is synchronous with submission of a concurrency-safe tool.
    expect(order).toEqual(['announce:read_file', 'execute-start']);

    release();
    await exec.awaitAll();
    expect(order).toEqual(['announce:read_file', 'execute-start', 'execute-end']);
  });

  test('a throwing display sink never breaks execution', async () => {
    const exec = makeExecutor({
      onToolCall: () => {
        throw new Error('sink exploded');
      },
    });
    exec.addTool({ name: 'read_file', params: { file_path: 'a.txt' }, id: 'call_1' });
    const results = await exec.awaitAll();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('success');
  });

  test('does not announce a queued serial tool before it is drained', async () => {
    const seen = [];
    const exec = makeExecutor({
      isConcurrencySafe: () => false,
      onToolCall: (call) => seen.push(call.id),
    });
    exec.addTool({ name: 'write_file', params: { file_path: 'a.txt' }, id: 'call_9' });
    expect(seen).toEqual([]);
    await exec.awaitAll();
    expect(seen).toEqual(['call_9']);
  });
});

describe('StreamingToolExecutor — result identity', () => {
  test('getResultById survives name/param normalization drift', async () => {
    const exec = makeExecutor();
    exec.addTool({ name: 'read_file', params: { file_path: 'a.txt' }, id: 'call_1' });
    await exec.awaitAll();

    // 主循环看到的是规范化后的调用：名字变了、参数多了一个 path。
    expect(exec.getResultByHash('readFile', { file_path: 'a.txt', path: 'a.txt' })).toBeNull();
    expect(exec.getResultById('call_1')).toMatchObject({ name: 'read_file', status: 'success' });
  });

  test('announcements are addressable by id or by name/params fingerprint', () => {
    const exec = makeExecutor({ onToolCall: () => {} });
    exec.markAnnounced('call_1', 'fp_1');
    expect(exec.wasAnnounced('call_1', '')).toBe(true);
    expect(exec.wasAnnounced(null, 'fp_1')).toBe(true);
    expect(exec.wasAnnounced('call_2', 'fp_2')).toBe(false);
  });
});
