'use strict';

describe('toolUseLoop delivery conclusion events', () => {
  let previousAuditDir;

  beforeEach(() => {
    previousAuditDir = process.env.KHY_TRACE_AUDIT_DIR;
  });

  afterEach(() => {
    if (previousAuditDir === undefined) delete process.env.KHY_TRACE_AUDIT_DIR;
    else process.env.KHY_TRACE_AUDIT_DIR = previousAuditDir;
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('emits delivery final event with conclusion signal after tool execution', async () => {
    const logEvent = jest.fn();
    jest.doMock('../src/services/traceAuditService', () => ({
      ensureDiagnosticsBridge: jest.fn(),
      attachTrace: jest.fn(),
      logEvent,
      getContext: () => ({ sessionId: 'sess-1', traceId: 'trace-1', requestId: 'req-1' }),
    }));
    jest.doMock('../src/services/toolCalling', () => ({
      executeTool: jest.fn(async () => ({ success: true, output: 'ok' })),
      setPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest
      .fn()
      .mockResolvedValueOnce({
        reply: '<tool_call>{"name":"shellCommand","params":{"command":"pwd"}}</tool_call>',
        provider: 'mock',
      })
      .mockResolvedValueOnce({
        reply: '已完成检查，最终结论：当前目录已确认。',
        provider: 'mock',
      });

    const result = await toolUseLoop.runToolUseLoop('请检查当前目录并告诉我结果', {
      chat,
      maxIterations: 3,
      sessionId: 'sess-1',
      requestId: 'req-1',
    });

    expect(result.finalResponse).toContain('最终结论');
    expect(logEvent).toHaveBeenCalledWith(
      'agent.delivery.final',
      expect.objectContaining({
        requestId: 'req-1',
        success: true,
        hasConclusion: true,
      }),
      expect.objectContaining({
        sessionId: 'sess-1',
        traceId: expect.any(String),
        requestId: 'req-1',
      })
    );
  });

  test('keeps llm and delivery audit events on the same request trace', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-toolloop-trace-'));
    process.env.KHY_TRACE_AUDIT_DIR = auditDir;
    jest.resetModules();
    jest.unmock('../src/services/traceAuditService');
    jest.unmock('../src/services/toolCalling');

    const traceAudit = require('../src/services/traceAuditService');
    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest.fn(async (_message, opts = {}) => {
      traceAudit.logEvent('llm.request', { ok: true }, {
        sessionId: opts.sessionId,
        traceId: opts._diagTraceId,
        requestId: opts.requestId,
        source: 'mock-chat',
      });
      traceAudit.logEvent('llm.response', { success: true }, {
        sessionId: opts.sessionId,
        traceId: opts._diagTraceId,
        requestId: opts.requestId,
        source: 'mock-chat',
      });
      return {
        reply: '已完成检查，最终结论：当前目录已确认。',
        provider: 'mock',
      };
    });

    await toolUseLoop.runToolUseLoop('请检查当前目录并告诉我结果', {
      chat,
      maxIterations: 1,
      sessionId: 'sess-trace-shared',
      requestId: 'req-trace-shared',
    });

    const summary = traceAudit.getRequestTraceSummary({
      sessionId: 'sess-trace-shared',
      requestId: 'req-trace-shared',
    });

    expect(summary.ok).toBe(true);
    expect(summary.delivery.status).toBe('completed');
    expect(summary.typeCounts['llm.request']).toBe(1);
    expect(summary.typeCounts['llm.response']).toBe(1);
    expect(summary.typeCounts['agent.delivery.final']).toBe(1);
  });
});

describe('unfulfilled-intent negative signal (轻档：只改判定与记账，不改控制流)', () => {
  const helpers = require('../src/services/tool/toolUseLoopHelpers');
  const isUnfulfilled = helpers._looksLikeUnfulfilledIntent;

  // 命中：整句只是一句打算（语料里这类有 90 条长请求被记成 completed）
  test.each([
    '我用 Read 工具读取该文件。',
    '让我读取 package.json',
    '我来执行这条命令',
    '接下来我搜索一下新闻',
    '我将调用 shell 运行 ls',
    '我要修改这两个文件',
  ])('flags bare intent declaration: %s', (text) => {
    expect(isUnfulfilled(text)).toBe(true);
  });

  // 不误伤：给了结果、给了否定结论、或只是长答案里顺带提到工具
  test.each([
    'version 是 1.6.0，已在 package.json 中确认。',
    '我查到了：今天多云，最高 24 度。',
    '已创建 works/data/khy/x.json，共 3 个文件被修改。',
    '我没有找到相关文件，建议确认路径。',
    '这个仓库的架构是分层设计，L0 是启动器。',
    `${'这是正常的长答案句子。'.repeat(40)}我先读一下文件。`,
  ])('does not flag real delivery: %s', (text) => {
    expect(isUnfulfilled(text)).toBe(false);
  });
});
