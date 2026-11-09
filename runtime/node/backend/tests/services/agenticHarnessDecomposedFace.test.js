'use strict';

/**
 * agenticHarnessDecomposedFace.test.js — 「循环自陈没跑完 ≠ 成功」回归锁（bp-2 消费侧）。
 *
 * 断点：harness 的自动分解路径把子编排结果包装成 loopResult 返回面，交给交付门
 * （buildHarnessDeliveryVerdict 的 runtime 门）与验证门。子代理撞轮次上限时
 * runToolUseLoop 是带终态标志的 resolve，软失败曾被汇总成 successCount:N /
 * failCount:0——交付门因此整条放行。本文件钉这条返回面的四条判据，任一条回退都会红：
 *
 *   1. subtaskResults[].result.success === false → errorType 'subtask_failed'
 *      （runtime 门读 errorType 判 fail，这是它在这条路径上唯一能读到的失败信号）；
 *   2. failCount > 0 单独也判失败（OR 的另一半， orchestrator 汇总数与逐条结果
 *      可能不一致，任一边诚实就必须红）；
 *   3. 子任务终态标志 OR 折叠到返回面（TERMINAL_FLAG_KEYS 四键全覆盖）——否则
 *      runtime 门的未完成信号面在这条路径上读不到任何东西；
 *   4. filesModified 桥接成 { tool:'editFile', params:{ path } } 工具日志——否则
 *      交付门每个文件侧判据都零证据。
 *
 * 干净完成的正对照同锁：不误添 errorType、不误透任何终态键。
 *
 * 生产入口今天不走这里（:1648 的 decompose 是 async，plan 恒为 Promise →
 * plan.shouldDecompose 恒 undefined → 恒 return null），所以这条返回面只能经
 * _internals._tryAutoDecompose 逃生阀整体驱动——该导出就是为这条契约留的
 * （见 module.exports 处注释），本文件是它的第一个消费者。
 */

const mockHolder = { waveResult: null };

jest.mock('../../src/services/toolUseLoop', () => ({
  // runToolUseLoop 保持存在：harness 模块加载期会解构它，缺了只是 undefined 也行，
  // 但带上更接近真实形状。
  runToolUseLoop: jest.fn(),
  _isComplexTask: jest.fn(() => ({ isComplex: true, reason: 'mocked complex' })),
  _shouldAutoDecompose: jest.fn(() => true),
}));

jest.mock('../../src/services/taskDecomposer', () => ({
  decompose: jest.fn(() => ({
    shouldDecompose: true,
    reason: 'mocked plan',
    subtasks: [
      { role: 'explore', prompt: '子任务一' },
      { role: 'implement', prompt: '子任务二' },
    ],
  })),
  mergeResults: jest.fn(() => 'MERGED-OUTPUT'),
}));

// 波次调度返回 null → 单波路径（waves = [plan.subtasks]），把测试聚焦在返回面契约上；
// 多波/故障停止/上下文注入由 dependencyWaveScheduler 与 orchestrated 兄弟套件覆盖。
jest.mock('../../src/services/domain/state/orchestrator/dependencyWaveScheduler', () => ({
  planWaves: jest.fn(() => null),
}));

jest.mock('../../src/tools/AgentTool', () => ({
  _runOrchestrated: jest.fn(async () => mockHolder.waveResult),
}));

const { _internals } = require('../../src/services/agenticHarnessService');

describe('agenticHarness 自动分解返回面（_tryAutoDecompose）', () => {
  const originalAutoDecompose = process.env.KHY_AUTO_DECOMPOSE;

  beforeEach(() => {
    process.env.KHY_AUTO_DECOMPOSE = '1';
    mockHolder.waveResult = null;
  });

  afterAll(() => {
    if (originalAutoDecompose === undefined) {
      delete process.env.KHY_AUTO_DECOMPOSE;
    } else {
      process.env.KHY_AUTO_DECOMPOSE = originalAutoDecompose;
    }
  });

  test('未完成子任务 → subtask_failed + 终态键 OR 折叠 + filesModified 桥接成工具日志', async () => {
    mockHolder.waveResult = {
      subtaskResults: [
        {
          name: 'subtask-1',
          result: {
            success: false,
            maxIterationsReached: true,
            truncated: true,
            filesModified: ['/virtual/explored.js'],
            text: '做了一半',
          },
        },
        {
          name: 'subtask-2',
          result: { success: true, filesModified: ['/virtual/impl.js'], text: '做完了' },
        },
      ],
      subtaskCount: 2,
      successCount: 1,
      failCount: 1,
    };
    const events = [];
    const face = await _internals._tryAutoDecompose('把整个仓库重构成分层架构', {
      onEvent: (e) => events.push(e),
    });

    expect(face).not.toBeNull();
    // 1. 软失败必须映到 errorType——runtime 门只认这一个键。
    expect(face.errorType).toBe('subtask_failed');
    // 3. 终态键 OR 折叠（两个子任务里只有 sub-task-1 带键）。
    expect(face.maxIterationsReached).toBe(true);
    expect(face.truncated).toBe(true);
    // 4. filesModified → { tool:'editFile', params:{ path } }，交付门文件侧判据的证据源。
    expect(face.toolCallLog).toEqual([
      { tool: 'editFile', params: { path: '/virtual/explored.js' } },
      { tool: 'editFile', params: { path: '/virtual/impl.js' } },
    ]);
    // loopResult 兼容面的其余契约不变。
    expect(face.decomposed).toBe(true);
    expect(face.iterations).toBe(2);
    expect(face.successCount).toBe(1);
    expect(face.failCount).toBe(1);
    expect(face.finalResponse).toBe('MERGED-OUTPUT');
    // 汇总事件诚实（harness auto_decompose_done 同源累加这两个数）。
    const done = events.filter((e) => e.type === 'auto_decompose_done').pop();
    expect(done).toMatchObject({ successCount: 1, failCount: 1, subtaskCount: 2 });
  });

  test('TERMINAL_FLAG_KEYS 四键逐键折叠（stopped/timeLimitReached 也有一席之地）', async () => {
    for (const key of ['stopped', 'maxIterationsReached', 'truncated', 'timeLimitReached']) {
      mockHolder.waveResult = {
        subtaskResults: [
          { name: 'subtask-1', result: { success: false, [key]: true, filesModified: [] } },
        ],
        subtaskCount: 1,
        successCount: 0,
        failCount: 1,
      };
      const face = await _internals._tryAutoDecompose('重写网关层', { onEvent: () => {} });
      expect(face.errorType).toBe('subtask_failed');
      expect(face[key]).toBe(true);
    }
  });

  test('failCount>0 但逐条 result.success 不为 false → 仍判 subtask_failed（OR 的另一半）', async () => {
    mockHolder.waveResult = {
      subtaskResults: [{ name: 'subtask-1', result: { success: true, filesModified: [] } }],
      subtaskCount: 1,
      successCount: 0,
      failCount: 1,
    };
    const face = await _internals._tryAutoDecompose('拆分单体', { onEvent: () => {} });
    expect(face.errorType).toBe('subtask_failed');
  });

  test('干净完成 → 不误添 errorType、不误透任何终态键（正对照）', async () => {
    mockHolder.waveResult = {
      subtaskResults: [
        { name: 'subtask-1', result: { success: true, filesModified: ['/virtual/a.js'] } },
        { name: 'subtask-2', result: { success: true, filesModified: [] } },
      ],
      subtaskCount: 2,
      successCount: 2,
      failCount: 0,
    };
    const face = await _internals._tryAutoDecompose('拆两个独立模块', { onEvent: () => {} });

    expect(face.errorType).toBeUndefined();
    for (const key of ['stopped', 'maxIterationsReached', 'truncated', 'timeLimitReached']) {
      expect(face[key]).toBeUndefined();
    }
    // 成果桥接不受影响：干净完成同样要把 filesModified 带给交付门。
    expect(face.toolCallLog).toEqual([{ tool: 'editFile', params: { path: '/virtual/a.js' } }]);
    expect(face.successCount).toBe(2);
    expect(face.failCount).toBe(0);
  });
});
