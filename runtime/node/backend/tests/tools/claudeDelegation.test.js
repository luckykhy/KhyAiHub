'use strict';

/**
 * claudeDelegation 委派决策纯函数特征化测试（node:test）。
 *
 * 守护：
 *   ① 模型显式选外部 agent + **闸门成立** → 委派；不可用 → 干净回退并说明原因（不强求、不中断）。
 *   ② Khy auto 判断 → feature flag 开 + 启发式命中 + **闸门成立** + 可用时才委派。
 *   ③ PROCESS-004 / [DESIGN-PROCESS-001] 委派边界：**启发式命中 ≠ 闸门成立**。auto 路径刻意用
 *      「重构 / 跨文件迁移 / 端到端」这类强启发式信号做反例——它们恰好是 khy 的核心能力，
 *      不构成委派理由。
 *   ④（2026-10-15）**三条可委派面共用一个决策点，且 G1 的凭据不由模型书写**。
 *      旧实现把「用户点名」的证据交给模型：工具侧读 prompt 里的 `[委派闸门 G1]` 即放行。
 *      现在凭据是 `delegationTicket` 按本轮 turn 签发的票券（turnId 经 traceContext 下发，
 *      不在工具入参 schema 里），prompt 里的标记只用于向用户申报。
 * 以及 fail-soft：探测/开关抛错一律降级为「不委派」，绝不让委派逻辑崩。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  decideClaudeDelegation,
  decideExternalDelegation,
  isDelegatableExternalAgent,
  _defaultDelegationTools,
  _looksLikeClaudeCodeTask,
} = require('../../src/tools/AgentTool/claudeDelegation');
const { issueDelegationTicket, resetDelegationTickets } = require('../../src/services/delegationTicket');

// 模型自写闸门标记的 prompt（用户从未点名）——它**不再**构成 G1 证据。
const SELF_CLAIMED = '[委派闸门 G1] 请重构整个支付模块，跨多文件迁移到新的网关抽象层，并保证所有端到端集成测试全部通过';
// 强启发式信号（重构 / 跨文件 / 端到端），但没有任何闸门
const HEAVY = '请重构整个支付模块，跨多文件迁移到新的网关抽象层，并保证所有端到端集成测试全部通过';

const TURN = 'turn-2026-10-15-1';

/** 运行时签发 G1 票券（等价于 loop 首轮对真实用户原文识别命中）。 */
function toolsWithNomination(agentId = 'claude', turnId = TURN, extra = {}) {
  resetDelegationTickets();
  issueDelegationTicket(turnId, agentId);
  return { ..._defaultDelegationTools(), ...extra };
}

/** 准入判定不可用（但注册表在）：fail-closed 的注入形态。 */
const TOOLS_ADMISSION_UNAVAILABLE = {
  externalAgents: [{ id: 'claude', delegatable: true }],
  evaluateAdmission: undefined,
  detectGate: undefined,
  redeemTicket: () => false,
};

// ── explicit 路径（须过闸门） ───────────────────────────────────────────────

test('explicit + 用户点名（运行时票券）+ 可用 → 委派 claude，mode=explicit，gate=G1', () => {
  const d = decideClaudeDelegation(
    { prompt: SELF_CLAIMED, role: 'claude', explicitlyRequested: true, turnId: TURN },
    { detect: () => true, isAutoDelegationEnabled: () => false, tools: toolsWithNomination() }
  );
  assert.strictEqual(d.delegate, true);
  assert.strictEqual(d.adapter, 'claude');
  assert.strictEqual(d.available, true);
  assert.strictEqual(d.mode, 'explicit');
  assert.strictEqual(d.gate, 'G1');
  assert.strictEqual(d.code, 'allowed');
});

test('explicit + 模型自写标记但用户未点名（无票券）→ 不委派，code=no-gate（核心：凭据不由模型书写）', () => {
  const d = decideClaudeDelegation(
    { prompt: SELF_CLAIMED, role: 'claude', explicitlyRequested: true, turnId: TURN },
    {
      detect: () => true,
      isAutoDelegationEnabled: () => false,
      tools: { ..._defaultDelegationTools(), redeemTicket: () => false },
    }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.adapter, null);
  assert.strictEqual(d.code, 'no-gate');
  assert.ok(!d.reason.includes('闸门 G1'), `不得因自写标记报 G1：${d.reason}`);
});

test('explicit + 票券属于别的轮次 → 不委派（票券按 turn 归属，不跨轮复用）', () => {
  const tools = toolsWithNomination('claude', 'turn-other');
  const d = decideClaudeDelegation(
    { prompt: SELF_CLAIMED, role: 'claude', explicitlyRequested: true, turnId: TURN },
    { detect: () => true, isAutoDelegationEnabled: () => false, tools }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.code, 'no-gate');
});

test('explicit + 用户点名 + 不可用 → 不委派、不报错，reason 含「未安装」（核心：不强求）', () => {
  const d = decideClaudeDelegation(
    { prompt: SELF_CLAIMED, role: 'claude', explicitlyRequested: true, turnId: TURN },
    { detect: () => false, isAutoDelegationEnabled: () => true, tools: toolsWithNomination() }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.adapter, null);
  assert.strictEqual(d.available, false);
  assert.strictEqual(d.mode, 'explicit');
  assert.strictEqual(d.gate, 'G1');
  assert.ok(/未安装/.test(d.reason), `reason 应说明未安装: ${d.reason}`);
});

test('explicit + 无闸门标记 → 不委派（默认自做，code=no-gate）', () => {
  const d = decideClaudeDelegation(
    { prompt: HEAVY, role: 'claude', explicitlyRequested: true },
    { detect: () => true, isAutoDelegationEnabled: () => false }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.adapter, null);
  assert.strictEqual(d.mode, 'explicit');
  assert.strictEqual(d.code, 'no-gate');
});

test('explicit + G2 能力缺失（结构化证据）→ 委派，gate=G2', () => {
  const d = decideClaudeDelegation(
    {
      prompt: '把这个仓库的 Rust 侧 benchmark 跑一遍',
      role: 'claude',
      explicitlyRequested: true,
      capabilityGap: ['本地无可用的 cargo bench 工具链'],
      delegationReason: '需要 cargo 工具链产出基准数据',
    },
    { detect: () => true, isAutoDelegationEnabled: () => false }
  );
  assert.strictEqual(d.delegate, true);
  assert.strictEqual(d.gate, 'G2');
});

test('explicit + G2 但理由含糊（更快） → 不委派，code=vague-reason', () => {
  const d = decideClaudeDelegation(
    {
      prompt: '重构支付模块',
      role: 'claude',
      explicitlyRequested: true,
      capabilityGap: ['某种能力'],
      delegationReason: '外部 agent 更快',
    },
    { detect: () => true, isAutoDelegationEnabled: () => false }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.code, 'vague-reason');
});

test('explicit + selfCapable=true → 无条件不委派（§5.2 本地已覆盖）', () => {
  const d = decideClaudeDelegation(
    { prompt: SELF_CLAIMED, role: 'claude', explicitlyRequested: true, selfCapable: true, turnId: TURN },
    { detect: () => true, isAutoDelegationEnabled: () => true, tools: toolsWithNomination() }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.code, 'self-capable');
});

// ── auto 路径（feature flag + 启发式 + 闸门 + 可用，四重门） ────────────────

test('auto + flag 开 + 启发式命中 + 无闸门 → 不委派（启发式不构成委派理由）', () => {
  const d = decideClaudeDelegation(
    { prompt: HEAVY, role: 'general', explicitlyRequested: false },
    { detect: () => true, isAutoDelegationEnabled: () => true }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.adapter, null);
  assert.strictEqual(d.mode, 'none');
  assert.strictEqual(d.code, 'no-gate');
});

test('auto + flag 开 + 启发式命中 + G3 隔离要求 → 委派，mode=auto，gate=G3', () => {
  const d = decideClaudeDelegation(
    {
      // ≥40 字 + 强信号（端到端）以命中启发式；真正的放行依据是 G3 隔离要求，不是启发式
      prompt: '请在干净的独立克隆里复现上游仓库的缺陷，并端到端验证修复效果，给出最小复现步骤与关键日志片段。',
      role: 'general',
      explicitlyRequested: false,
      isolationRequired: true,
      isolationNote: '本地工作区有未提交改动，必须在独立拷贝里复现',
    },
    { detect: () => true, isAutoDelegationEnabled: () => true }
  );
  assert.strictEqual(d.delegate, true);
  assert.strictEqual(d.adapter, 'claude');
  assert.strictEqual(d.mode, 'auto');
  assert.strictEqual(d.gate, 'G3');
});

test('auto + flag 开 + 启发式不命中 → 不委派（由 Khy 自身处理）', () => {
  const d = decideClaudeDelegation(
    { prompt: '改个错别字', role: 'general', explicitlyRequested: false },
    { detect: () => true, isAutoDelegationEnabled: () => true }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.mode, 'none');
});

test('auto + flag 关 → 不委派，即便可用且启发式命中且点名成立', () => {
  const d = decideClaudeDelegation(
    { prompt: SELF_CLAIMED, role: 'general', explicitlyRequested: false, turnId: TURN },
    { detect: () => true, isAutoDelegationEnabled: () => false, tools: toolsWithNomination() }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.mode, 'none');
});

test('auto + flag 开 + 启发式命中 + 用户点名 + 不可用 → 不委派，reason 含「未安装」', () => {
  const d = decideClaudeDelegation(
    { prompt: SELF_CLAIMED, role: 'general', explicitlyRequested: false, turnId: TURN },
    { detect: () => false, isAutoDelegationEnabled: () => true, tools: toolsWithNomination() }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.available, false);
  assert.strictEqual(d.gate, 'G1');
  assert.ok(/未安装/.test(d.reason), `reason 应说明未安装: ${d.reason}`);
});

// ── 三面统一：codex / opencode 也过闸门（2026-10-15 补的洞） ───────────────

test('codex：注册表判定为可委派项', () => {
  const tools = _defaultDelegationTools();
  assert.strictEqual(isDelegatableExternalAgent('codex', tools), true);
  assert.strictEqual(isDelegatableExternalAgent('opencode', tools), true);
  assert.strictEqual(isDelegatableExternalAgent('cursor', tools), false, 'cursor 是仅顶层会话项，不可经 subagent_type 委派');
  assert.strictEqual(isDelegatableExternalAgent('', tools), false);
});

test('codex 无闸门 → 不委派（旧实现直连适配器，正是「活被甩出去」的通路）', () => {
  const d = decideExternalDelegation(
    { agentId: 'codex', prompt: '把测试跑一遍', turnId: TURN },
    { detectFor: () => true, tools: _defaultDelegationTools() }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.adapter, null);
  assert.strictEqual(d.code, 'no-gate');
});

test('codex + 用户点名（票券）→ 委派 codex（不再只认 claude）', () => {
  const d = decideExternalDelegation(
    { agentId: 'codex', prompt: '把测试跑一遍', turnId: TURN },
    { detectFor: () => true, tools: toolsWithNomination('codex') }
  );
  assert.strictEqual(d.delegate, true);
  assert.strictEqual(d.adapter, 'codex');
  assert.strictEqual(d.gate, 'G1');
});

test('opencode + 票券 + CLI 不可用 → 不委派，reason 说明未安装', () => {
  const d = decideExternalDelegation(
    { agentId: 'opencode', prompt: '改这个文件', turnId: TURN },
    { detectFor: () => false, tools: toolsWithNomination('opencode') }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.available, false);
  assert.ok(/未安装/.test(d.reason), `reason 应说明未安装: ${d.reason}`);
});

test('未知外部 agent id → 不委派，code=unknown-agent（不得凭 role 名直连适配器）', () => {
  const d = decideExternalDelegation({ agentId: 'kiro', prompt: 'x' }, { detectFor: () => true });
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.code, 'unknown-agent');
});

// ── fail-soft ───────────────────────────────────────────────────────────────

test('detect 抛错 → 不委派、不抛（探测崩了绝不升级为「放行」）', () => {
  const d = decideClaudeDelegation(
    { prompt: SELF_CLAIMED, role: 'claude', explicitlyRequested: true, turnId: TURN },
    {
      detect: () => {
        throw new Error('spawn boom');
      },
      isAutoDelegationEnabled: () => true,
      tools: toolsWithNomination(),
    }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.available, false);
});

test('isAutoDelegationEnabled 抛错 → 不委派、不抛', () => {
  const d = decideClaudeDelegation(
    { prompt: '请重构整个项目并迁移所有文件', role: 'general', explicitlyRequested: false },
    {
      detect: () => true,
      isAutoDelegationEnabled: () => {
        throw new Error('flag boom');
      },
    }
  );
  assert.strictEqual(d.delegate, false);
});

test('准入判定不可用 → fail-closed 到不委派（绝不因判定缺失而放行）', () => {
  const d = decideClaudeDelegation(
    { prompt: SELF_CLAIMED, role: 'claude', explicitlyRequested: true, turnId: TURN },
    { detect: () => true, isAutoDelegationEnabled: () => true, tools: TOOLS_ADMISSION_UNAVAILABLE }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.code, 'admission-unavailable');
});

// ── 启发式边界 ──────────────────────────────────────────────────────────────

test('_looksLikeClaudeCodeTask：太短 → false（不值得 spawn 重进程）', () => {
  assert.strictEqual(_looksLikeClaudeCodeTask('重构', 'general'), false);
});

test('_looksLikeClaudeCodeTask：强信号（refactor across files）→ true', () => {
  assert.strictEqual(
    _looksLikeClaudeCodeTask('Refactor the auth layer across multiple files and update callers', 'general'),
    true
  );
});

test('_looksLikeClaudeCodeTask：弱信号 + 短描述 → false（保守偏不委派）', () => {
  assert.strictEqual(_looksLikeClaudeCodeTask('implement a helper', 'general'), false);
});
