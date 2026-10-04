'use strict';

/**
 * 网络检索「无可用数据」→ 强制兜底决策(goal「失败即触发主代理决策」)。
 *
 * 这里专门锁**旧守卫漏掉的那一类**:检索工具**成功**（success:true）却零条结果 ——
 * 既有的 allFailed 分支要求「本轮每个工具都失败」,对 200 OK + 空结果完全不触发,
 * 于是模型只收到一句「没搜到」就继续往下走。
 *
 * 断言两件事:
 *   1) 门控开(默认) → 下一轮提示里出现强制兜底决策指令(且原生模型吃到的结构化块里也有);
 *   2) 门控关(KHY_SEARCH_FAILURE_SIGNAL=0) → 该指令消失,逐字节回退既有行为。
 */

describe('toolUseLoop web-no-usable-data forced fallback decision', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.KHY_MCP_AUTOCONNECT = 'false';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  function runEmptySearchLoop() {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';

    const executeTool = jest.fn(async (name) => {
      if (/^web_?search$/i.test(name)) {
        // 关键:success === true,但零条结果 —— 旧守卫看不见的形态。
        return { success: true, results: [], formatted: 'No results found.' };
      }
      return { success: false, error: `unexpected tool: ${name}` };
    });

    jest.doMock('../src/services/tool/toolCalling', () => ({
      executeTool,
      clearPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest
      .fn()
      .mockResolvedValue({ reply: 'done' })
      .mockResolvedValueOnce({
        reply:
          '搜一下。<tool_call>{"name":"web_search","params":{"query":"latest ai news"}}</tool_call>',
      })
      .mockResolvedValueOnce({ reply: 'done' });

    return toolUseLoop
      .runToolUseLoop('帮我搜索今天 AI 领域最新动态', { chat, maxIterations: 4 })
      .then((result) => ({ result, chat, executeTool }));
  }

  test('门控开:成功但零结果也触发强制兜底决策,并镜像进结构化块', async () => {
    delete process.env.KHY_SEARCH_FAILURE_SIGNAL;

    const { result, chat, executeTool } = await runEmptySearchLoop();

    // 检索确实被执行了(否则本测试没有意义)
    expect(
      executeTool.mock.calls.filter(([n]) => /^web_?search$/i.test(n)).length
    ).toBeGreaterThan(0);

    const followUps = chat.mock.calls.slice(1).map((call) => String(call[0] || ''));
    const hit = followUps.filter((p) => p.includes('produced no usable data'));
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0]).toContain('produced no usable data');

    // 原生模型只吃结构化 blocks —— 指令必须同时在里面(否则等于没注入)
    const followUpOpts = chat.mock.calls.slice(1).map((call) => call[1] || {});
    const mirrored = followUpOpts.some((opts) => {
      const blocks = opts._structuredToolResultBlocks;
      return (
        Array.isArray(blocks) &&
        blocks.some((b) => b && b.type === 'text' && String(b.text).includes('produced no usable data'))
      );
    });
    expect(mirrored).toBe(true);

    expect(result.finalResponse).toBeTruthy();
  });

  test('门控关:不发强制兜底决策,逐字节回退', async () => {
    process.env.KHY_SEARCH_FAILURE_SIGNAL = '0';

    const { chat } = await runEmptySearchLoop();

    const followUps = chat.mock.calls.slice(1).map((call) => String(call[0] || ''));
    expect(followUps.some((p) => p.includes('produced no usable data'))).toBe(false);
  });
});
