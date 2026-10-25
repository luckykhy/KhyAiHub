'use strict';

// RULES-REGISTRY: PROCESS-004

/**
 * delegationTicket.js — G1「用户点名」的**运行时凭据**，单一真源。
 *
 * 为什么需要它（2026-10-15 实测，见 works/data/khy/feedback/delegation-self-first-20261015/）：
 * 委派决策原先从**模型自己写的** prompt 里读 `[委派闸门 G1]`，读到即置
 * `userNamedAgentId = 'claude'` 放行。工具侧看不到用户原文，于是「用户点名」这一
 * 确定性事实的书写权，交给了唯一想绕过它的一方——模型自写一行标记即可伪造 G1。
 *
 * 修法是把证据的来源换成运行时：
 *   签发  toolUseLoopCore 首轮对**真实用户消息**跑 detectExternalAgentRequest() 命中时，
 *         按本轮 turnId 签发该 agent 的票券。
 *   核销  AgentTool 的委派决策读 `_context.traceContext.turnId`（由 loop 下发，
 *         **不在工具的入参 schema 里，模型写不了）+ 目标 agent id 核销。
 * 无票券 ⇒ G1 不成立 ⇒ fail-closed 回自做。prompt 里的闸门标记降级为**透明申报**
 * （§6.2 要求向用户声明闸门），不再是准入凭据。
 *
 * 契约：进程内状态，零 I/O、绝不抛。票券按 turn 归属、不单次消费——同一轮里
 * 用户点名一次、合法委派多次是正常形态。上限 MAX_TURNS 条按插入序淘汰（不用时钟，
 * 避免 RUNTIME-003 的硬超时形态；淘汰只影响陈旧轮次的残留票券）。
 *
 * 门控：无独立开关。它是准入判定的一条证据通道，关掉它等于回到「模型自述即放行」，
 * 故随 PROCESS-004 常驻。上游 detect 的门控（KHY_EXTERNAL_AGENT_NUDGE）关 ⇒ 不签发 ⇒
 * G1 永不成立，与逐字节回退语义一致。
 *
 * @module services/delegationTicket
 */

const MAX_TURNS = 32;

/** turnId -> Set<agentId>（Map 保持插入序，超界淘汰最旧一条） */
const _tickets = new Map();

function _key(turnId, agentId) {
  const t = String(turnId == null ? '' : turnId).trim();
  const a = String(agentId == null ? '' : agentId).trim().toLowerCase();
  if (!t || !a) return null;
  return { t, a };
}

/**
 * 签发一张票：声明「本轮用户确实点名了 agentId」。
 * @returns {boolean} 是否成功签发（参数为空 ⇒ false，不抛）
 */
function issueDelegationTicket(turnId, agentId) {
  try {
    const k = _key(turnId, agentId);
    if (!k) return false;
    if (!_tickets.has(k.t)) {
      _tickets.set(k.t, new Set());
      while (_tickets.size > MAX_TURNS) {
        const oldest = _tickets.keys().next().value;
        if (oldest === undefined) break;
        _tickets.delete(oldest);
      }
    }
    _tickets.get(k.t).add(k.a);
    return true;
  } catch {
    return false;
  }
}

/**
 * 核销一张票：本轮用户是否点名了 agentId。
 * 不消费——同一轮内多次合法委派都要能过。
 * @returns {boolean}
 */
function redeemDelegationTicket(turnId, agentId) {
  try {
    const k = _key(turnId, agentId);
    if (!k) return false;
    const set = _tickets.get(k.t);
    return !!set && set.has(k.a);
  } catch {
    return false;
  }
}

/** 读一张票（不核销），供审计/测试。 */
function peekDelegationTickets(turnId) {
  try {
    const set = _tickets.get(String(turnId == null ? '' : turnId).trim());
    return set ? [...set] : [];
  } catch {
    return [];
  }
}

/** 清空（仅测试用：跨用例隔离进程内状态）。 */
function resetDelegationTickets() {
  try {
    _tickets.clear();
  } catch {
    /* 绝不抛 */
  }
}

module.exports = {
  issueDelegationTicket,
  redeemDelegationTicket,
  peekDelegationTickets,
  resetDelegationTickets,
};
