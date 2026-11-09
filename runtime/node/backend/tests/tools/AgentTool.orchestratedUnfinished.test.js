'use strict';

/**
 * AgentTool.orchestratedUnfinished.test.js — 「循环自陈没跑完 ≠ 成功」回归锁（bp-2）。
 *
 * 断点：柔性编排链曾把「子执行器不抛错」当成功——子代理工具循环撞轮次上限时
 * runToolUseLoop 是带 maxIterationsReached/truncated 的 resolve，整条链却记
 * successCount:N / failCount:0（a2a executor 对同一终态判 failed，
 * src/services/a2a/executor.js）。本文件钉三条判据，任一条回退都会红：
 *
 *   1. 终态信号面：循环自陈未完成（撞轮次 / 绝对·空闲超时 / token 预算 / 循环保护 /
 *      工具连续失败 / grace 轮空回复 / 答复截断）→ _runStandaloneAgent 必须落
 *      success:false、带错误原因、透出终态标志；自然收尾与瞬断恢复
 *      （recoveredFromInterruptedChannel）不算失败。
 *   2. 编排链（bp-2 主修复）：子任务撞上限 → _runOrchestrated 记 0 成功 N 失败、
 *      orchestrated_done 事件诚实、subtaskResults 带 success:false + 终态标志
 *      （harness fault-stop 读它，agenticHarnessService.js），且已产出的部分成果
 *      不许被「无可用模型」本地兜底替换。
 *   3. SubAgentOrchestrator.execute：executeFn resolve 一个 success:false（软失败）
 *      必须记 FAILED 并发 agent:failed——否则 summarize()/编排回执把它记成功；
 *      execute() 返回值仍按旧契约 { success: true, result }（任务层双口径由
 *      subAgentTaskReassign.isFailedOutcome 承接）。
 *
 * 手法与兄弟套件一致（AgentTool.controlRequest.test.js）：jest.doMock 把
 * runToolUseLoop 换成内存态终态对象，再走生产入口 execute()。
 */

describe('AgentTool 循环终态 → success 判定（bp-2 回归锁）', () => {
  const originalEnv = { ...process.env };

  // execute() 在 KHY_COORDINATOR_MODE 下走 coordinator/worker 分支，永远不调
  // runToolUseLoop——本套件只测 standalone/orchestrated 两条路，钉死模式关闭。
  delete process.env.KHY_COORDINATOR_MODE;

  afterEach(() => {
    process.env = { ...originalEnv };
    delete process.env.KHY_COORDINATOR_MODE;
    jest.resetModules();
    jest.clearAllMocks();
  });

  /**
   * 注册内存态 runToolUseLoop 并加载 AgentTool。holder.result 逐个用例改写，
   * 无需为每个信号重新加载模块图（resetModules 后 doMock 仍然生效）。
   */
  function loadTool() {
    jest.resetModules();
    const holder = { result: null, calls: [], agentTool: null };
    jest.doMock('../../src/services/toolUseLoop', () => ({
      isEnabled: () => true,
      runToolUseLoop: async (...args) => {
        holder.calls.push(args);
        return holder.result;
      },
    }));
    // 避开真实适配器栈；循环被 mock 后 chat 永不被调用。
    jest.doMock('../../src/cli/ai', () => ({ chat: jest.fn(async () => ({ reply: 'unused' })) }));
    holder.agentTool = require('../../src/tools/AgentTool');
    return holder;
  }

  // 终态信号表：读 toolUseLoopCore 各 return 归纳（与 _loopUnfinishedReason 同源）。
  // 每条给出循环自陈面与期望的 success 判定。
  const UNFINISHED_CASES = [
    ['撞轮次上限', { finalResponse: '半截答复', iterations: 15, maxIterationsReached: true, truncated: true }],
    ['绝对时间上限', { timeLimitReached: true, maxIterationsReached: true, absoluteLimit: true }],
    ['空闲超时', { timeLimitReached: true }],
    ['token 预算用尽', { budgetStopped: true }],
    ['循环保护', { loopDetected: true, stopped: true }],
    ['工具连续失败退出', { consecutiveFailureBailout: true }],
    ['grace 轮没写出答案', { graceFallback: true }],
    ['答复被长度截断', { truncated: true }],
  ];

  test('终态信号表：循环自陈没跑完 → success:false + 错误原因 + 标志透出', async () => {
    const holder = loadTool();
    for (const [name, loopResult] of UNFINISHED_CASES) {
      holder.result = loopResult;
      const r = await holder.agentTool.execute({ prompt: '实现某功能', subagent_type: 'general-purpose' }, {});
      expect(r.success).toBe(false);
      // 未完成必须带「原因+进度」的错误面，父循环只呈现 error 不渲染 output
      expect(typeof r.error).toBe('string');
      expect(r.error.length).toBeGreaterThan(0);
    }
    // 撞轮次上限那一例的终态标志必须原样透出（编排层与遥测都读它）
    holder.result = UNFINISHED_CASES[0][1];
    const capped = await holder.agentTool.execute({ prompt: '实现某功能', subagent_type: 'general-purpose' }, {});
    expect(capped.maxIterationsReached).toBe(true);
    expect(capped.truncated).toBe(true);
  });

  test('自然收尾与瞬断恢复不算失败（正对照，防判据一刀切）', async () => {
    const holder = loadTool();
    holder.result = { finalResponse: '做完了', toolCallLog: [], iterations: 3 };
    const clean = await holder.agentTool.execute({ prompt: '实现某功能', subagent_type: 'general-purpose' }, {});
    expect(clean.success).toBe(true);
    expect(clean.error).toBeUndefined();

    holder.result = { finalResponse: '恢复后交了答案', recoveredFromInterruptedChannel: true };
    const recovered = await holder.agentTool.execute({ prompt: '实现某功能', subagent_type: 'general-purpose' }, {});
    expect(recovered.success).toBe(true);
  });

  test('编排链：两个子任务都撞轮次上限 → 0 成功 2 失败，标志透传且不丢已产出的成果', async () => {
    const holder = loadTool();
    holder.result = {
      finalResponse: '已做一半的答复',
      toolCallLog: [],
      iterations: 15,
      maxIterationsReached: true,
      maxIterations: 15,
      truncated: true,
    };
    const events = [];
    const r = await holder.agentTool.execute(
      {
        prompt: '父任务',
        subtasks: [
          { prompt: '子1', role: 'implement' },
          { prompt: '子2', role: 'implement' },
        ],
      },
      { traceContext: { onAgentProgress: (e) => events.push(e) } }
    );

    // 主修复：汇总计数诚实
    expect(r.success).toBe(false);
    expect(r.successCount).toBe(0);
    expect(r.failCount).toBe(2);
    expect(r.subtaskCount).toBe(2);

    // harness fault-stop 消费面（agenticHarnessService.js 读 subtaskResults[*].result.success）
    expect(r.subtaskResults.map((a) => a.name)).toEqual(['subtask-1', 'subtask-2']);
    expect(r.subtaskResults.map((a) => a.result.success)).toEqual([false, false]);
    // bp-2 主修复：终态标志必须透传到编排聚合层
    expect(r.subtaskResults.map((a) => a.result.truncated)).toEqual([true, true]);
    expect(r.subtaskResults.map((a) => a.result.maxIterationsReached)).toEqual([true, true]);
    // 已产出的部分成果不许被「无可用模型」本地兜底替换（implement 角色的兜底文案）
    expect(r.subtaskResults.map((a) => a.result.text)).toEqual(['已做一半的答复', '已做一半的答复']);
    expect(r.subtaskResults.every((a) => !/无可用模型/.test(a.result.text))).toBe(true);

    // orchestrated_done 事件诚实（harness auto_decompose_done 同源累加这两个数）
    const done = events.filter((e) => e.type === 'orchestrated_done');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ success: false, subtaskCount: 2, successCount: 0, failCount: 2 });

    // 聚合文本把两个子任务都标成 Failed，没有一个 Completed
    expect(r.output).toContain('Failed');
    expect(r.output).not.toContain('Completed');
  });

  test('编排链正对照：子任务干净完成 → 2 成功 0 失败（防判据反向失真）', async () => {
    const holder = loadTool();
    holder.result = { finalResponse: '做完了', toolCallLog: [], iterations: 3 };
    const events = [];
    const r = await holder.agentTool.execute(
      {
        prompt: '父任务',
        subtasks: [
          { prompt: '子1', role: 'implement' },
          { prompt: '子2', role: 'implement' },
        ],
      },
      { traceContext: { onAgentProgress: (e) => events.push(e) } }
    );

    expect(r.success).toBe(true);
    expect(r.successCount).toBe(2);
    expect(r.failCount).toBe(0);
    expect(r.subtaskResults.map((a) => a.result.success)).toEqual([true, true]);
    expect(r.subtaskResults.map((a) => a.result.truncated)).toEqual([undefined, undefined]);
    const done = events.filter((e) => e.type === 'orchestrated_done');
    expect(done[0]).toMatchObject({ success: true, successCount: 2, failCount: 0 });
    expect(r.output).toContain('Completed');
  });

  test('orchestrator.execute：软失败记 FAILED 并发 agent:failed，summarize 记失败；返回值契约不变', async () => {
    const { SubAgentOrchestrator } = require('../../src/services/subAgentOrchestrator');
    const events = [];
    const orch = new SubAgentOrchestrator({
      executeFn: async () => ({ success: false, error: 'adapter 500' }),
    });
    orch.on('agent:failed', (ev) => events.push(ev));
    orch.on('agent:completed', (ev) => events.push(ev));
    const root = orch.spawnRoot({ name: 'task-coordinator', task: '父任务', role: 'general' });
    root.state = 'running';
    const child = orch.fork(root.id, { name: 'subtask-1', task: '子1', role: 'general' });

    const outcome = await orch.execute(child.id);

    // 返回值形状不变——任务层字节回退契约（subAgentOrchestrator.test.js 门控关用例）
    expect(outcome.success).toBe(true);
    expect(outcome.result).toEqual({ success: false, error: 'adapter 500' });
    // 但终态、事件与回执口径必须诚实
    expect(child.state).toBe('failed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agentId: child.id, name: 'subtask-1', error: 'adapter 500' });
    const sum = orch.summarize(root.id);
    expect(sum.successCount).toBe(0);
    expect(sum.failCount).toBe(1);
    expect(sum.subtasks[0].status).toBe('failed');
  });

  test('orchestrator.execute：干净完成仍记 COMPLETED 并发 agent:completed', async () => {
    const { SubAgentOrchestrator } = require('../../src/services/subAgentOrchestrator');
    const events = [];
    const orch = new SubAgentOrchestrator({
      executeFn: async () => ({ success: true, text: 'done' }),
    });
    orch.on('agent:failed', (ev) => events.push(ev));
    orch.on('agent:completed', (ev) => events.push(ev));
    const root = orch.spawnRoot({ name: 'task-coordinator', task: '父任务', role: 'general' });
    root.state = 'running';
    const child = orch.fork(root.id, { name: 'subtask-1', task: '子1', role: 'general' });

    await orch.execute(child.id);

    expect(child.state).toBe('completed');
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('subtask-1');
    const sum = orch.summarize(root.id);
    expect(sum.successCount).toBe(1);
    expect(sum.failCount).toBe(0);
  });
});
