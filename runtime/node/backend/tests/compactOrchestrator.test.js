'use strict';

/**
 * Tests for the /compact manual-compaction orchestrator (compactOrchestrator).
 *
 * Contract under test:
 *  - no-op honesty: messages ≤ keepRecent+1 → changed:false with a human-readable
 *    noOpReason, and NO model round-trip;
 *  - AI path: gateway reports an available adapter → contextCompressor.compress runs
 *    with force:true (manual compaction must bypass the auto-chain's statistical
 *    gates), the compressed view is written back into _chatState.messages, and the
 *    result carries the compactHistory-compatible field shape;
 *  - local fallback: gateway unavailable → degrades to compactHistory with
 *    degraded:true + degradedReason, and still writes back + persists;
 *  - ui plumbing: onPhase receives the compactionDisplay stages (starting → done).
 *
 * The gateway and compressor seams are jest.mock'ed, so no API key and no network
 * are needed.
 */

jest.mock('../src/services/gateway/aiGateway', () => {
  return {
    __esModule: true,
    getStatus: jest.fn(() => [{ name: 'fake', available: false }]),
  };
});

const chatState = require('../src/cli/aiChatState');
const ops = require('../src/cli/aiConversationOps');
const gateway = require('../src/services/gateway/aiGateway');
const aiSession = require('../src/cli/aiSession');
const hud = require('../src/cli/hudRenderer');

// 编排器收尾通过 aiSession._persistLiveSession() 落盘 —— spy 掉，既断言调用次数，
// 又不让测试碰到真实 JSONL 落盘面（_persistLiveSession 内部读 _chatState 全局单例）。
let persistSpy;
beforeEach(() => {
  persistSpy = jest.spyOn(aiSession, '_persistLiveSession').mockImplementation(() => {});
  // HUD 回写 spy：断言压缩成功后 used 立即反映压缩后占用（用户报告的
  // 「压缩完上下文数字/百分比不变」缺陷的回归锚点）。
  jest.spyOn(hud, 'setContextUsage').mockImplementation(() => {});
});

function makeMessages(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      // Long enough that the compressor has real text to fold.
      content: `测试消息 ${i}：这是一段足够长的对话内容，包含文件路径 /tmp/demo_${i}.js 与决策记录，用于手动压缩测试。`.repeat(4),
    });
  }
  return out;
}

function quietUi(overrides = {}) {
  const lines = [];
  return {
    lines,
    printInfo: (s) => lines.push(['info', s]),
    printSuccess: (s) => lines.push(['ok', s]),
    printWarn: (s) => lines.push(['warn', s]),
    printError: (s) => lines.push(['err', s]),
    onPhase: overrides.onPhase,
  };
}

beforeEach(() => {
  chatState.messages = [];
  jest.clearAllMocks();
  // clearAllMocks wipes the implementations set in the outer beforeEach's
  // spyOn(...).mockImplementation — re-pin them here (spy identity persists).
  persistSpy.mockImplementation(() => {});
  hud.setContextUsage.mockImplementation(() => {});
  // Reset compressor anti-jitter state so cooldown from a prior test never leaks.
  try {
    require('../src/services/contextCompressor').resetAntiJitter();
  } catch {
    /* optional */
  }
  // Compaction notices flow through compactionUiPort only when the CLI renderer
  // registered itself; in tests nothing registered, so nothing prints.
});

describe('compactOrchestrator — 诚实 no-op', () => {
  test('messages ≤ keepRecent+1 → changed:false，不发起模型往返', async () => {
    chatState.messages = makeMessages(10);
    const { compactSession } = require('../src/cli/compactOrchestrator');
    const ui = quietUi();
    const r = await compactSession({ mode: 'auto' }, ui);
    expect(r.success).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.source).toBe('none');
    expect(r.noOpReason).toContain('无历史可折叠');
    expect(chatState.messages.length).toBe(10);
    // No compress attempt happened (gateway was never consulted for a summary).
    expect(persistSpy).not.toHaveBeenCalled();
    // no-op 不回写 HUD —— 占用没变，回写一个假数字反而制造不诚实的显示。
    expect(hud.setContextUsage).not.toHaveBeenCalled();
  });
});

describe('compactOrchestrator — 本地回退（网关不可用）', () => {
  test('degrades to compactHistory，标注 degraded + 原因，写回并持久化', async () => {
    gateway.getStatus.mockReturnValue([{ name: 'fake', available: false }]);
    chatState.messages = makeMessages(40);
    const { compactSession } = require('../src/cli/compactOrchestrator');
    const ui = quietUi();
    const r = await compactSession({ mode: 'auto' }, ui);
    expect(r.success).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.source).toBe('local');
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toContain('AI 网关不可用');
    expect(r.previousCount).toBe(40);
    expect(r.nextCount).toBe(chatState.messages.length);
    expect(r.nextCount).toBeLessThan(40);
    expect(chatState.messages[0].content).toContain('[ContextCompact v2');
    expect(persistSpy).toHaveBeenCalledTimes(1);
    // HUD 回写：压缩后占用立即重估（数字/百分比不再停在压缩前旧值）。
    // 相对断言：新占用必须显著低于压缩前 40 条的估算（同一把 estimateTokens 尺）。
    expect(hud.setContextUsage).toHaveBeenCalledTimes(1);
    const hudUsed = hud.setContextUsage.mock.calls[0][0];
    const hudLimit = hud.setContextUsage.mock.calls[0][1];
    const beforeEstimate = (() => {
      const runtime = require('../src/services/khyUpgradeRuntime');
      return makeMessages(40).reduce((s, m) => s + runtime.estimateTokens(m.content), 0);
    })();
    expect(hudUsed).toBeGreaterThan(0);
    expect(hudUsed).toBeLessThan(beforeEstimate);
    expect(hudLimit).toBe(0); // HUD 无现值时透传 0（保持 HUD 既有 limit）
    expect(ui.lines.some(([, s]) => s.includes('本地折叠'))).toBe(true);
  });

  test('gateway throws → 同样本地回退', async () => {
    gateway.getStatus.mockImplementation(() => {
      throw new Error('boom');
    });
    chatState.messages = makeMessages(40);
    const { compactSession } = require('../src/cli/compactOrchestrator');
    const r = await compactSession({ mode: 'auto' }, quietUi());
    expect(r.source).toBe('local');
    expect(r.degradedReason).toContain('AI 网关不可用');
  });
});

describe('compactOrchestrator — AI 路径', () => {
  // 编排器在 compactSession 内部才 require 压缩器并解构 compress —— 用 spyOn 替换
  // 导出属性即可命中（doMock 对已缓存的模块实例不生效）。
  let compressSpy;

  beforeEach(() => {
    compressSpy = jest.spyOn(require('../src/services/contextCompressor'), 'compress');
  });

  afterEach(() => {
    compressSpy.mockRestore();
  });

  test('compress 成功 → force:true、写回压缩视图、结果字段兼容既有成功行构建器', async () => {
    const phases = [];
    compressSpy.mockImplementation(async (messages, opts) => {
      expect(opts.force).toBe(true);
      expect(typeof opts.callModelFn).toBe('function');
      expect(typeof opts.onPhase).toBe('function');
      phases.push('called');
      opts.onPhase({ stage: 'starting', pct: 5 });
      opts.onPhase({ stage: 'pruning', pct: 15 });
      opts.onPhase({ stage: 'summarizing', pct: 45 });
      return {
        compressed: [
          { role: 'user', content: '<compressed_context>\nAI 摘要内容，足够长。\n</compressed_context>' },
          ...messages.slice(-4),
        ],
        summaryGenerated: true,
        freedTokens: 1234,
        splitIndex: 5,
        strippedImages: 0,
      };
    });

    gateway.getStatus.mockReturnValue([{ name: 'fake', available: true }]);
    chatState.messages = makeMessages(40);
    const ui = quietUi({
      onPhase: (evt) => phases.push(`evt:${evt.stage}:${evt.pct}`),
    });
    const { compactSession } = require('../src/cli/compactOrchestrator');
    const r = await compactSession({ mode: 'balanced' }, ui);

    expect(r.success).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.source).toBe('ai');
    expect(r.mode).toBe('balanced');
    expect(r.previousCount).toBe(40);
    expect(r.nextCount).toBe(chatState.messages.length);
    expect(r.freedTokens).toBe(1234);
    expect(chatState.messages[0].content).toContain('<compressed_context>');
    expect(persistSpy).toHaveBeenCalledTimes(1);
    // HUD 回写：AI 路径同样立即重估占用。
    expect(hud.setContextUsage).toHaveBeenCalledTimes(1);
    expect(hud.setContextUsage.mock.calls[0][0]).toBeGreaterThan(0);
    // onPhase 事件透传到调用方（进度条数据源）。
    expect(phases).toContain('evt:summarizing:45');
    // 成功行是消息条数视角（编排器打印），与 compactionUiPort 的词元行角度不同。
    expect(ui.lines.some(([, s]) => s.includes('AI 摘要（balanced）'))).toBe(true);

    // 字段兼容：既有 buildCompactSuccessLine 可直接消费。
    const crs = require('../src/cli/compactResultSummary');
    expect(crs.buildCompactSuccessLine(r, process.env)).toContain('会话已压缩：40 ->');
  });

  test('compress 抛错 → 降级本地折叠并如实标注原因', async () => {
    compressSpy.mockRejectedValue(new Error('summary exploded'));
    gateway.getStatus.mockReturnValue([{ name: 'fake', available: true }]);
    chatState.messages = makeMessages(40);
    const { compactSession } = require('../src/cli/compactOrchestrator');
    const r = await compactSession({ mode: 'auto' }, quietUi());
    expect(r.source).toBe('local');
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toContain('AI 摘要失败');
    expect(r.degradedReason).toContain('summary exploded');
    expect(r.changed).toBe(true);
    expect(chatState.messages[0].content).toContain('[ContextCompact v2');
  });

  test('强度档映射：MODE_PRESERVE_RATIO 与 compress 收到的 preserveRatioOverride 一致', async () => {
    let seen = null;
    compressSpy.mockImplementation(async (messages, opts) => {
      seen = opts.preserveRatioOverride;
      return {
        compressed: [{ role: 'user', content: '<compressed_context>x</compressed_context>' }, messages[0]],
        summaryGenerated: true,
        freedTokens: 1,
      };
    });
    gateway.getStatus.mockReturnValue([{ name: 'fake', available: true }]);
    chatState.messages = makeMessages(40);
    const { compactSession, MODE_PRESERVE_RATIO } = require('../src/cli/compactOrchestrator');
    await compactSession({ mode: 'aggressive' }, quietUi());
    expect(seen).toBe(MODE_PRESERVE_RATIO.aggressive);
  });
});
