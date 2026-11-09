'use strict';

/**
 * bp-1 回归锁：runToolUseLoop 自陈「没跑完」的终态，AgentTool 必须落
 * success:false 并把终态标志透出。
 *
 * 这条判据曾经是 `success: true` 常量——15 轮触顶 / 绝对超时 / 空闲超时 /
 * token 预算停止 / 循环保护 / 工具连续失败退出在整条链路上被报成「已完成」，
 * 而 a2a executor 对同一批标志落 failed（services/a2a/executor.js:131-141）。
 * 这里两个方向都锁：未完成必须红，已完成与「瞬断后交了答案」不许误判。
 */
describe('AgentTool 富循环终态判定', () => {
  const originalEnv = { ...process.env };

  // execute() 在 coordinator 模式下走 worker 分支，根本不会碰 runToolUseLoop；
  // 宿主 shell 若导出过该 flag，本套件会在一台机器绿、另一台红。
  delete process.env.KHY_COORDINATOR_MODE;

  afterEach(() => {
    process.env = { ...originalEnv };
    delete process.env.KHY_COORDINATOR_MODE;
    jest.resetModules();
    jest.clearAllMocks();
  });

  /** 用给定的循环返回面跑一次同步子代理，顺带收回进度事件。 */
  async function runAgent(loopResult, { loopEnabled = true } = {}) {
    jest.doMock('../../src/services/toolUseLoop', () => ({
      isEnabled: () => loopEnabled,
      runToolUseLoop: jest.fn(async () => loopResult),
    }));
    // 富循环路径的 chat 由 _chatWithFallback 提供、循环本身已被 mock；这里挡住
    // fallback 单发分支，免得它真的打到网关。
    jest.doMock('../../src/cli/ai', () => ({ chat: jest.fn(async () => ({ reply: 'unused' })) }));
    const agentTool = require('../../src/tools/AgentTool');
    const events = [];
    const result = await agentTool.execute(
      { prompt: '实现某功能', subagent_type: 'general-purpose' },
      { traceContext: { onAgentProgress: (e) => events.push(e) } }
    );
    return { result, done: events.filter((e) => e.type === 'done').pop() };
  }

  // [用例名, runToolUseLoop 返回面, 必须透出的终态标志]——返回面逐条抄自
  // toolUseLoopCore 的真实出口（:2426-2441 / :2477-2485 / :2317-2325 /
  // :9658-9667 / :10625-10634 / :10687-10700 / :3429-3444 / :7059-7074）。
  const UNFINISHED_CASES = [
    ['撞最大迭代 15 轮', { finalResponse: '做了一半', iterations: 15, maxIterationsReached: true, truncated: true }, ['maxIterationsReached', 'truncated']],
    ['绝对时间上限', { finalResponse: '跑太久', iterations: 9, timeLimitReached: true, maxIterationsReached: true, truncated: true, absoluteLimit: true }, ['timeLimitReached', 'absoluteLimit']],
    ['空闲超时', { finalResponse: '没进展', iterations: 4, timeLimitReached: true }, ['timeLimitReached']],
    ['token 预算停止', { finalResponse: '预算到了', iterations: 6, budgetStopped: true }, ['budgetStopped']],
    ['循环保护', { finalResponse: '绕圈子', iterations: 8, stopped: true, loopDetected: true }, ['loopDetected', 'stopped']],
    ['工具连续失败退出', { finalResponse: '工具全失败', iterations: 5, consecutiveFailureBailout: true }, ['consecutiveFailureBailout']],
    ['grace 轮没写出答案', { finalResponse: '兜底文案', iterations: 15, graceFallback: true }, ['graceFallback']],
    ['答复被长度截断', { finalResponse: '答复被截断', iterations: 2, truncated: true }, ['truncated']],
    ['工具被审批拒绝后停止', { finalResponse: '权限被拒', iterations: 3, stopped: true }, ['stopped']],
    ['被取消', { finalResponse: '用户取消', iterations: 2, stopped: true, cancelled: true }, ['cancelled']],
  ];

  test.each(UNFINISHED_CASES)(
    '%s → success:false、终态标志透出、done 事件翻面',
    async (_name, loopResult, flags) => {
      const { result, done } = await runAgent(loopResult);
      expect(result.success).toBe(false);
      for (const flag of flags) {
        expect(result[flag]).toBe(true);
      }
      expect(done.success).toBe(false);
      // 曾经这里写的是 "completed in ... with N tool uses."
      expect(result.message).not.toMatch(/completed/);
    }
  );

  test('循环正常收尾（无终态键）→ 仍是 success:true，不误判', async () => {
    const { result, done } = await runAgent({ finalResponse: '做完了', iterations: 3 });
    expect(result.success).toBe(true);
    expect(done.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/completed/);
  });

  test('recoveredFromInterruptedChannel（瞬断后确实交了答案）→ 仍是 success:true', async () => {
    const { result } = await runAgent({
      finalResponse: '瞬断后续接后交了答案',
      iterations: 4,
      stopped: true,
      errorType: 'empty_reply',
      recoveredFromInterruptedChannel: true,
    });
    expect(result.success).toBe(true);
    // 标志照旧透出，只是不据此判失败——与 a2a executor 同一口径。
    expect(result.stopped).toBe(true);
    expect(result.errorType).toBe('empty_reply');
  });

  test('未完成时 error 带上部分成果（父循环 success:false 只呈现 error、不呈现 output）', async () => {
    const { result } = await runAgent({
      finalResponse: 'PARTIAL-SENTINEL：已改 3 个文件，还剩 import 没动',
      iterations: 15,
      maxIterationsReached: true,
      truncated: true,
    });
    expect(result.success).toBe(false);
    // deliveryFormatter.buildToolResultMessage 的 failed 分支只拼 Error:<error>，
    // 部分成果不进 error 父智能体就看不见子代理已经做了什么。
    expect(result.error).toContain('PARTIAL-SENTINEL');
    expect(result.error).toMatch(/迭代上限/);
    expect(result.error).toMatch(/khy gateway status/);
  });

  test('KHY_TOOL_LOOP=false 的单发降级档保持既有语义（toolCalls:0 可辨，不谎报也不改判）', async () => {
    const { result } = await runAgent({}, { loopEnabled: false });
    expect(result.success).toBe(true);
    expect(result.toolCalls).toBe(0);
    expect(result.iterations).toBe(1);
  });

  test('富循环抛错（模型出错/看门狗中止）时 catch 仍返回 success:false，不越界抛 ReferenceError', async () => {
    jest.doMock('../../src/services/toolUseLoop', () => ({
      isEnabled: () => true,
      runToolUseLoop: jest.fn(async () => {
        throw new Error('模拟模型或空闲看门狗抛错');
      }),
    }));
    jest.doMock('../../src/cli/ai', () => ({ chat: jest.fn(async () => ({ reply: 'unused' })) }));
    const agentTool = require('../../src/tools/AgentTool');
    const events = [];
    const result = await agentTool.execute(
      { prompt: '实现某功能', subagent_type: 'general-purpose' },
      { traceContext: { onAgentProgress: (e) => events.push(e) } }
    );
    // _partialText 曾声明在富循环分支块内，catch 读它直接 ReferenceError——
    // 子代理失败会以异常逃出 execute()，而不是落 success:false。
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/模拟模型或空闲看门狗抛错/);
    const done = events.filter((e) => e.type === 'done').pop();
    expect(done.success).toBe(false);
  });

  // ── 纯函数面：逐个 toolUseLoopCore 出口形状钉判据 ──────────────────
  describe('_loopUnfinishedReason', () => {
    const { _loopUnfinishedReason } = require('../../src/tools/AgentTool');

    test.each([
      ['正常收尾', { finalResponse: 'x', iterations: 3 }, null],
      ['空返回面', {}, null],
      ['recoveredFromInterruptedChannel', { stopped: true, errorType: 'empty_reply', recoveredFromInterruptedChannel: true }, null],
      ['撞轮次', { maxIterationsReached: true, truncated: true }, 'max-iterations'],
      ['绝对上限', { maxIterationsReached: true, truncated: true, absoluteLimit: true }, 'time-limit'],
      ['空闲超时', { timeLimitReached: true }, 'idle-timeout'],
      ['预算停止', { budgetStopped: true }, 'token-budget-stop'],
      ['循环保护', { stopped: true, loopDetected: true }, 'loop-guard'],
      ['连续失败', { consecutiveFailureBailout: true }, 'consecutive-tool-failures'],
      ['grace 空回复', { graceFallback: true }, 'no-final-answer'],
      ['AI 出错带 errorType', { errorType: 'empty_reply', stopped: true }, 'empty_reply'],
      ['裸 stopped', { stopped: true }, 'stopped'],
      ['长度截断', { truncated: true }, 'truncated'],
    ])('%s → %s', (_name, loopResult, expected) => {
      expect(_loopUnfinishedReason(loopResult)).toBe(expected);
    });
  });

  describe('_loopTerminalFlags', () => {
    const { _loopTerminalFlags } = require('../../src/tools/AgentTool');

    test('只透出被置位的终态键，不把整个循环返回面泄出来', () => {
      const flags = _loopTerminalFlags({
        finalResponse: 'x',
        toolCallLog: [],
        conversationMessages: [],
        iterations: 15,
        maxIterationsReached: true,
        truncated: true,
        budgetStopped: false,
      });
      expect(flags).toEqual({ maxIterationsReached: true, truncated: true });
    });

    test('正常收尾 → 空对象', () => {
      expect(_loopTerminalFlags({ finalResponse: 'x', iterations: 3 })).toEqual({});
    });
  });
});
