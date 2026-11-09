'use strict';

/**
 * AgentTool × 外部编码 CLI 委派接线集成测试（jest）。
 *
 * 验证两件事在 execute() 端到端落地：
 *   ① 显式 subagent_type:'claude' + **闸门成立** + CLI 可用 → 委派，结果 delegated:true。
 *   ② 显式 claude 但 CLI 不可用 → 不强求、不中断：降级为 Khy 自身 agent 跑完，
 *      结果 delegated:false + delegationReason 说明原因（任务仍成功完成）。
 *   ③（2026-10-15）**无闸门 ⇒ 不委派**：`subagent_type` 指到外部 CLI 不等于准入成立。
 *      G1 的凭据是本轮签发的票券（services/delegationTicket），prompt 里自写标记不算；
 *      codex / opencode 与 claude 走同一条判定（此前 codex/opencode 直连适配器、不过闸门）。
 *
 * toolUseLoop 被 mock，避免触真适配器/网络；探测经 mock claudeAdapter.detect 控制。
 */

describe('AgentTool 外部 CLI 委派接线', () => {
  const originalEnv = { ...process.env };
  const TURN = 'turn-agenttool-1';

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  function mockLoop() {
    const runToolUseLoop = jest.fn(async () => ({ finalResponse: 'done', iterations: 1 }));
    jest.doMock('../../src/services/toolUseLoop', () => ({ isEnabled: () => true, runToolUseLoop }));
    jest.doMock('../../src/cli/ai', () => ({ chat: jest.fn(async () => ({ reply: 'unused' })) }));
    return runToolUseLoop;
  }

  /** 运行时签发 G1 票券（等价于 loop 首轮对用户原文识别命中）。 */
  function nominate(agentId = 'claude', turnId = TURN) {
    require('../../src/services/delegationTicket').issueDelegationTicket(turnId, agentId);
  }

  test('explicit claude + 用户点名（票券）+ 可用 → delegated:true, delegatedTo:claude', async () => {
    mockLoop();
    jest.doMock('../../src/services/gateway/adapters/claudeAdapter', () => ({ detect: () => true }));
    nominate();

    const agentTool = require('../../src/tools/AgentTool');
    const result = await agentTool.execute(
      { prompt: 'Refactor across multiple files', subagent_type: 'claude' },
      { traceContext: { turnId: TURN } }
    );

    expect(result.success).toBe(true);
    expect(result.delegated).toBe(true);
    // 三条可委派面统一用外部 agent id 作标签（此前 claude 面单独用 'claude-code'，
    // 无任何消费方，三面统一后 codex/opencode 也走同一契约）。
    expect(result.delegatedTo).toBe('claude');
    expect(result.role).toBe('claude');
  });

  test('explicit claude + 无票券（用户没点名）→ 不委派，降级 Khy 自身，reason 说明闸门', async () => {
    mockLoop();
    jest.doMock('../../src/services/gateway/adapters/claudeAdapter', () => ({ detect: () => true }));

    const agentTool = require('../../src/tools/AgentTool');
    const result = await agentTool.execute(
      { prompt: 'Refactor across multiple files', subagent_type: 'claude' },
      { traceContext: { turnId: TURN } }
    );

    expect(result.success).toBe(true);
    expect(result.delegated).toBe(false);
    expect(result.delegatedTo).toBeNull();
    expect(result.delegationReason).toMatch(/闸门|自做/);
    expect(result.role).toBe('general');
  });

  test('explicit codex + 无票券 → 不委派（旧实现直连 codex 适配器，不过任何闸门）', async () => {
    mockLoop();

    const agentTool = require('../../src/tools/AgentTool');
    const result = await agentTool.execute(
      { prompt: 'Run the whole test suite', subagent_type: 'codex' },
      { traceContext: { turnId: TURN } }
    );

    expect(result.success).toBe(true);
    expect(result.delegated).toBe(false);
    expect(result.delegationReason).toMatch(/闸门|自做/);
    expect(result.role).toBe('general');
  });

  test('explicit claude + 票券 + 不可用 → 不报错、降级跑完，delegated:false + reason 含「未安装」', async () => {
    mockLoop();
    jest.doMock('../../src/services/gateway/adapters/claudeAdapter', () => ({ detect: () => false }));
    nominate();

    const agentTool = require('../../src/tools/AgentTool');
    const result = await agentTool.execute(
      { prompt: 'Refactor across multiple files', subagent_type: 'claude' },
      { traceContext: { turnId: TURN } }
    );

    // 任务仍成功完成（绝不因 claude 缺失中断）。
    expect(result.success).toBe(true);
    expect(result.delegated).toBe(false);
    expect(result.delegatedTo).toBeNull();
    expect(result.delegationReason).toMatch(/未安装/);
    // 已降级为 Khy 自身 general agent。
    expect(result.role).toBe('general');
  });

  test('显式委派决策经 progressCallback 上报（透明度）', async () => {
    mockLoop();
    jest.doMock('../../src/services/gateway/adapters/claudeAdapter', () => ({ detect: () => false }));
    nominate();

    const agentTool = require('../../src/tools/AgentTool');
    const onAgentProgress = jest.fn();
    await agentTool.execute(
      { prompt: 'Refactor across multiple files', subagent_type: 'claude' },
      { traceContext: { turnId: TURN, onAgentProgress } }
    );

    const delegationEvent = onAgentProgress.mock.calls
      .map(c => c[0])
      .find(e => e && e.type === 'delegation');
    expect(delegationEvent).toBeTruthy();
    expect(delegationEvent.delegated).toBe(false);
    expect(delegationEvent.reason).toMatch(/未安装/);
  });
});
