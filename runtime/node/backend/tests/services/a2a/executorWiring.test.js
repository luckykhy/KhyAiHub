'use strict';

/**
 * executorWiring — A2A 入站 executor 接线的回归锁（P0-2）。
 *
 * 锁三件事：
 *   1. 注入点生效：routes/a2a.js 的 setServerMethods 能把带 executor 的方法组装进路由，
 *      HTTP 级可见（message/send → tasks/get 拿到注入 executor 的产物，而不是回显）。
 *   2. 门控默认关：KHY_A2A_EXECUTOR 未设时走默认回显 executor（逐字节旧行为）。
 *   3. 真身不绕后门：agent executor 把文本交给 runToolUseLoop（审批 / shell 安全 /
 *      循环检测都在循环里），且**不接** onControlRequest —— 无交互面时权限闸门
 *      fail-closed，绝不把"没人应答"解释成放行。
 *
 * 全部用 stub 循环，不真调模型。
 */

const express = require('express');
const request = require('supertest');

// 真 toolUseLoop 是 11k 行的模块，测试里一律不加载：注入 stub 的用例走注入路径，
// 这个 mock 只服务「运行时不可用」那条（isEnabled() 为假 → resolveToolLoop 返回 null）。
jest.mock('../../../src/services/tool/toolUseLoop', () => ({
  isEnabled: () => false,
  runToolUseLoop: async () => ({ finalResponse: '' }),
}));

const executorMod = require('../../../src/services/a2a/executor');
const { createServerMethods } = require('../../../src/services/a2a/serverMethods');
const a2aRoute = require('../../../src/routes/a2a');

/** 造一条入站 message/send 入参（规范 Message 形状）。 */
function sendParams(text) {
  return {
    message: {
      messageId: 'msg_test_1',
      role: 'user',
      parts: [{ kind: 'text', text }],
    },
  };
}

/** stub 工具循环：记录入参，可选地在跑动中报一次迭代进度，返回给定结果。 */
function makeStubLoop(result, hooks = {}) {
  const seen = { calls: 0, text: null, options: null };
  return {
    seen,
    isEnabled: () => true,
    runToolUseLoop: async (text, options) => {
      seen.calls += 1;
      seen.text = text;
      seen.options = options;
      if (typeof hooks.beforeReturn === 'function') hooks.beforeReturn(options);
      return result;
    },
  };
}

describe('a2a executor — 门控', () => {
  const prev = process.env.KHY_A2A_EXECUTOR;

  afterEach(() => {
    if (prev === undefined) delete process.env.KHY_A2A_EXECUTOR;
    else process.env.KHY_A2A_EXECUTOR = prev;
  });

  test('默认关：未设 KHY_A2A_EXECUTOR 时 isExecutorEnabled() 为 false', () => {
    delete process.env.KHY_A2A_EXECUTOR;
    expect(executorMod.isExecutorEnabled()).toBe(false);
  });

  test('显式真值才开；含糊值（如 maybe）一律关', () => {
    process.env.KHY_A2A_EXECUTOR = '1';
    expect(executorMod.isExecutorEnabled()).toBe(true);
    process.env.KHY_A2A_EXECUTOR = 'maybe';
    expect(executorMod.isExecutorEnabled()).toBe(false);
  });

  test('门控关时 installServerExecutor 不碰路由（默认回显保持生效）', () => {
    delete process.env.KHY_A2A_EXECUTOR;
    const before = a2aRoute.setServerMethods(createServerMethods());
    const out = executorMod.installServerExecutor({ route: a2aRoute });
    expect(out.installed).toBe(false);
    expect(a2aRoute.methods).toBe(before);
  });
});

describe('a2a executor — agent 执行器（stub 循环）', () => {
  test('message/send 的文本被转成一次 runToolUseLoop，completed 带回最终文本', async () => {
    const stub = makeStubLoop({ finalResponse: 'stub 最终答复', iterations: 2, toolCallLog: [] });
    const executor = executorMod.createAgentExecutor({ runLoop: stub, chat: async () => ({ reply: '' }) });

    const result = await executor({ id: 'task_stub_1' }, sendParams('帮我看看桌面'));

    expect(stub.seen.calls).toBe(1);
    expect(stub.seen.text).toBe('帮我看看桌面');
    expect(result.state).toBe('completed');
    expect(result.text).toBe('stub 最终答复');
    expect(result.artifacts[0].parts[0]).toEqual({ kind: 'text', text: 'stub 最终答复' });
  });

  test('不接 onControlRequest：无交互面 → 权限闸门 fail-closed，不开绕开后门', async () => {
    const stub = makeStubLoop({ finalResponse: 'ok' });
    const executor = executorMod.createAgentExecutor({ runLoop: stub, chat: async () => ({ reply: '' }) });
    await executor({ id: 'task_stub_2' }, sendParams('rm -rf /'));

    expect(stub.seen.options.onControlRequest).toBeUndefined();
    // chat / chatOpts 仍按契约交给循环（审批与 shell 安全都在循环内执行）
    expect(typeof stub.seen.options.chat).toBe('function');
    expect(stub.seen.options.chatOpts.turnSource).toBe('a2a');
    expect(stub.seen.options.chatOpts.sessionId).toBe('a2a:task_stub_2');
  });

  test('迭代进度经 onProgress 映射为 working 态（tasks/get 轮询看得到）', async () => {
    const events = [];
    const stub = makeStubLoop({ finalResponse: 'done' }, {
      beforeReturn: (options) => {
        if (typeof options.onIteration === 'function') options.onIteration(3, 2);
      },
    });
    const executor = executorMod.createAgentExecutor({ runLoop: stub, chat: async () => ({ reply: '' }) });

    await executor({ id: 'task_stub_3' }, sendParams('长任务'), {
      onProgress: (state, detail) => events.push([state, detail && detail.message]),
    });

    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe('working');
    expect(events[0][1]).toContain('第 3 次迭代');
    expect(events[0][1]).toContain('工具调用 2 次');
  });

  test('撞迭代预算/时间上限（truncated）→ failed，且保留循环的诚实收尾', async () => {
    const stub = makeStubLoop({
      finalResponse: '已完成 3 轮，剩余步骤未执行',
      maxIterationsReached: true,
      truncated: true,
    });
    const executor = executorMod.createAgentExecutor({ runLoop: stub, chat: async () => ({ reply: '' }) });

    const result = await executor({ id: 'task_stub_4' }, sendParams('大任务'));

    expect(result.state).toBe('failed');
    expect(result.text).toContain('已完成 3 轮，剩余步骤未执行');
    expect(result.text).toContain('KHY_A2A_MAX_ITERATIONS');
  });

  test('循环带 errorType/stopped（通道穷尽、审批拒绝、循环检测）→ failed，不谎报 completed', async () => {
    const cases = [
      { finalResponse: '所有 AI 通道均不可用', errorType: 'channel_exhausted', stopped: true },
      { finalResponse: '工具被拒绝', stopped: true },
      { finalResponse: '循环保护停止', stopped: true, loopDetected: true },
      { finalResponse: '工具连续失败', consecutiveFailureBailout: true },
    ];
    for (const [i, loopResult] of cases.entries()) {
      const stub = makeStubLoop(loopResult);
      const executor = executorMod.createAgentExecutor({ runLoop: stub, chat: async () => ({ reply: '' }) });
      const result = await executor({ id: `task_err_${i}` }, sendParams('x'));
      expect(result.state).toBe('failed');
      expect(result.text).toContain(loopResult.finalResponse);
    }
  });

  test('恢复路径（recoveredFromInterruptedChannel）确实交了答案 → completed', async () => {
    const stub = makeStubLoop({
      finalResponse: '已恢复并完成',
      errorType: 'interrupted',
      stopped: true,
      recoveredFromInterruptedChannel: true,
    });
    const executor = executorMod.createAgentExecutor({ runLoop: stub, chat: async () => ({ reply: '' }) });
    const result = await executor({ id: 'task_recovered' }, sendParams('x'));
    expect(result.state).toBe('completed');
  });

  test('循环自陈 cancelled/interrupted → canceled 终态', async () => {
    const stub = makeStubLoop({ finalResponse: '请求已取消。', stopped: true, cancelled: true });
    const executor = executorMod.createAgentExecutor({ runLoop: stub, chat: async () => ({ reply: '' }) });
    const result = await executor({ id: 'task_cancelled' }, sendParams('x'));
    expect(result.state).toBe('canceled');
  });

  test('循环无最终文本 → failed（不伪装 completed）', async () => {
    const stub = makeStubLoop({ finalResponse: '   ', iterations: 1 });
    const executor = executorMod.createAgentExecutor({ runLoop: stub, chat: async () => ({ reply: '' }) });

    const result = await executor({ id: 'task_stub_5' }, sendParams('空转'));
    expect(result.state).toBe('failed');
    expect(result.text).toContain('khy gateway status');
  });

  test('缺 text part → 抛错（任务不会空跑）', async () => {
    const stub = makeStubLoop({ finalResponse: 'never' });
    const executor = executorMod.createAgentExecutor({ runLoop: stub, chat: async () => ({ reply: '' }) });

    await expect(executor({ id: 'task_stub_6' }, { message: { parts: [] } })).rejects.toThrow(/text part/);
    expect(stub.seen.calls).toBe(0);
  });

  test('agent 运行时不可用 → 抛错并给出可执行建议（绝不变回显）', async () => {
    const executor = executorMod.createAgentExecutor({ runLoop: null, chat: async () => ({ reply: '' }) });
    await expect(executor({ id: 'task_stub_7' }, sendParams('x'))).rejects.toThrow(/toolUseLoop/);
  });
});

describe('a2a executor — 经 serverMethods 的任务态闭环', () => {
  test('working 进度进 history，终态 completed；executor 抛错 → failed 终态', async () => {
    const stub = makeStubLoop({ finalResponse: '最终答复' }, {
      beforeReturn: (options) => options.onIteration(1, 0),
    });
    const agentExecutor = executorMod.createAgentExecutor({ runLoop: stub, chat: async () => ({ reply: '' }) });
    const methods = createServerMethods({ executor: agentExecutor });

    const task = await methods.messageSend(sendParams('跑一遍'));
    expect(task.status.state).toBe('completed');
    const states = task.history.map((s) => s.state);
    expect(states).toContain('working');
    expect(states[states.length - 1]).toBe('completed');
    const working = task.history.find((s) => s.state === 'working');
    expect(working.message.parts[0].text).toContain('第 1 次迭代');

    const failing = createServerMethods({
      executor: async () => {
        throw new Error('上游 401：API key 无效');
      },
    });
    const failedTask = await failing.messageSend(sendParams('再跑'));
    expect(failedTask.status.state).toBe('failed');
    expect(failedTask.status.message.parts[0].text).toContain('上游 401');
  });

  test('默认 executor 仍逐字节回显（注入点未启用时的旧行为）', async () => {
    const methods = createServerMethods();
    const task = await methods.messageSend(sendParams('hello'));
    expect(task.status.state).toBe('completed');
    expect(task.status.message.parts[0].text).toBe('received: hello');
  });
});

describe('a2a executor — 路由注入点（HTTP 级）', () => {
  const prevKey = process.env.KHY_A2A_API_KEY;
  const prevEnabled = process.env.KHY_A2A_ENABLED;
  const prevExec = process.env.KHY_A2A_EXECUTOR;

  beforeEach(() => {
    delete process.env.KHY_A2A_API_KEY;
    delete process.env.KHY_A2A_ENABLED;
    delete process.env.KHY_A2A_EXECUTOR;
    a2aRoute.setServerMethods(createServerMethods());
  });

  afterAll(() => {
    a2aRoute.setServerMethods(createServerMethods());
    if (prevKey === undefined) delete process.env.KHY_A2A_API_KEY;
    else process.env.KHY_A2A_API_KEY = prevKey;
    if (prevEnabled === undefined) delete process.env.KHY_A2A_ENABLED;
    else process.env.KHY_A2A_ENABLED = prevEnabled;
    if (prevExec === undefined) delete process.env.KHY_A2A_EXECUTOR;
    else process.env.KHY_A2A_EXECUTOR = prevExec;
  });

  function appWith(route) {
    const app = express();
    app.use(express.json());
    app.use('/v1', route);
    return app;
  }

  test('未注入时 message/send 走默认回显', async () => {
    const res = await request(appWith(a2aRoute)).post('/v1/message:send').send(sendParams('hi'));
    expect(res.status).toBe(200);
    expect(res.body.status.state).toBe('completed');
    expect(res.body.status.message.parts[0].text).toBe('received: hi');
  });

  test('注入后 message/send 驱动注入的 executor，tasks/get 取回同一任务', async () => {
    const stub = makeStubLoop({ finalResponse: '注入后的答复' });
    const agentExecutor = executorMod.createAgentExecutor({ runLoop: stub, chat: async () => ({ reply: '' }) });
    a2aRoute.setServerMethods(createServerMethods({ executor: agentExecutor }));

    const sent = await request(appWith(a2aRoute)).post('/v1/message:send').send(sendParams('外部任务'));
    expect(sent.status).toBe(200);
    expect(sent.body.status.state).toBe('completed');
    expect(sent.body.status.message.parts[0].text).toBe('注入后的答复');
    expect(stub.seen.text).toBe('外部任务');

    const got = await request(appWith(a2aRoute)).get(`/v1/tasks/${sent.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(sent.body.id);
    expect(got.body.status.state).toBe('completed');
    expect(got.body.artifacts[0].parts[0].text).toBe('注入后的答复');
  });

  test('installServerExecutor 在门控开时把 executor 装进路由（deps 注入 stub 循环，不真调模型）', async () => {
    process.env.KHY_A2A_EXECUTOR = '1';
    const stub = makeStubLoop({ finalResponse: '门控开的答复' });
    const out = executorMod.installServerExecutor({
      route: a2aRoute,
      deps: { runLoop: stub, chat: async () => ({ reply: '' }) },
    });
    expect(out.installed).toBe(true);

    const res = await request(appWith(a2aRoute)).post('/v1/message:send').send(sendParams('门控开'));
    expect(res.status).toBe(200);
    expect(res.body.status.state).toBe('completed');
    expect(res.body.status.message.parts[0].text).toBe('门控开的答复');
    expect(stub.seen.text).toBe('门控开');
  });
});
