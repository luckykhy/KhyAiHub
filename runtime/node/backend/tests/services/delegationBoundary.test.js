'use strict';

/**
 * 委派边界（PROCESS-004 / [DESIGN-PROCESS-001]）特征化测试（node:test）。
 *
 * 守护的是「默认自做」这条默认档本身：
 *   - 三闸门 G1/G2/G3 各自的证据要求；
 *   - 缺证据 / 理由含糊 / 本地已覆盖 ⇒ deny；
 *   - 异常 ⇒ fail-closed 到 deny（绝不因为判定崩了就放行委派）；
 *   - 注入文案必须同时教「默认自做 + 三闸门 + 禁止项」，且不得复活开放式授权句式；
 *   - 点名识别不得把「否定 / 征询」判成用户点名，也不得把真的派活漏掉（2026-10-15）；
 *   - G1 的凭据是运行时按 turn 签发的票券（delegationTicket），不是模型自述文本。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  DELEGATION_GATES,
  DELEGATION_GATE_MARKER_RE,
  SELF_FIRST_MARKER,
  getDelegationGate,
  detectDelegationGateInText,
  detectExternalAgentRequest,
  evaluateDelegationAdmission,
  buildExternalAgentDirective,
  buildExternalAgentNudge,
} = require('../../src/services/externalAgentDirective');
const ticket = require('../../src/services/delegationTicket');

const ON = { KHY_WEAK_MODEL_GUIDANCE: '1', KHY_EXTERNAL_AGENT_DIRECTIVE: '1' };

// ── 闸门集合 ────────────────────────────────────────────────────────────────

test('三闸门：G1 用户点名 / G2 能力缺失 / G3 隔离要求，id 与 key 一一对应', () => {
  assert.deepStrictEqual(
    DELEGATION_GATES.map((g) => `${g.id}:${g.key}`),
    ['G1:user-named', 'G2:capability-gap', 'G3:isolation-required']
  );
  for (const g of DELEGATION_GATES) {
    assert.ok(g.label && g.evidence && g.evidence.length > 0, `${g.id} 缺 label/evidence`);
  }
  assert.strictEqual(getDelegationGate('g2').key, 'capability-gap');
  assert.strictEqual(getDelegationGate('G9'), null);
});

// ── 默认档：无闸门即 deny ───────────────────────────────────────────────────

test('空输入 → deny(no-gate)，默认自做', () => {
  const a = evaluateDelegationAdmission({}, ON);
  assert.strictEqual(a.allowed, false);
  assert.strictEqual(a.code, 'no-gate');
});

test('只有启发式信号（重构/多文件）→ 仍然 deny：命中关键词不是闸门', () => {
  const a = evaluateDelegationAdmission(
    { reason: '这个跨多文件重构交给外部 agent 跑更合适' },
    ON
  );
  assert.strictEqual(a.allowed, false);
  assert.strictEqual(a.code, 'no-gate');
});

// ── G1 用户点名 ─────────────────────────────────────────────────────────────

test('G1：用户点名 → allow，无需额外举证', () => {
  const a = evaluateDelegationAdmission({ userNamedAgentId: 'claude' }, ON);
  assert.strictEqual(a.allowed, true);
  assert.strictEqual(a.gate, 'G1');
});

test('G1：userNamed 布尔写法 → allow', () => {
  const a = evaluateDelegationAdmission({ userNamed: true }, ON);
  assert.strictEqual(a.allowed, true);
  assert.strictEqual(a.gate, 'G1');
});

// ── G2 能力缺失 ─────────────────────────────────────────────────────────────

test('G2：能力清单 + 可核验理由 → allow', () => {
  const a = evaluateDelegationAdmission(
    { capabilityGap: ['本地无 cargo 工具链'], reason: '需要 cargo 产出基准数据' },
    ON
  );
  assert.strictEqual(a.allowed, true);
  assert.strictEqual(a.gate, 'G2');
});

test('G2：缺理由 → deny(missing-evidence)', () => {
  const a = evaluateDelegationAdmission({ capabilityGap: ['某能力'] }, ON);
  assert.strictEqual(a.allowed, false);
  assert.strictEqual(a.code, 'missing-evidence');
});

test('G2：理由含糊（更快/更省事）→ deny(vague-reason)', () => {
  const a = evaluateDelegationAdmission(
    { capabilityGap: ['某能力'], reason: '外部 agent 更快、更省事' },
    ON
  );
  assert.strictEqual(a.allowed, false);
  assert.strictEqual(a.code, 'vague-reason');
});

// ── G3 隔离要求 ─────────────────────────────────────────────────────────────

test('G3：隔离要求 + 原因 → allow', () => {
  const a = evaluateDelegationAdmission(
    { isolationRequired: true, isolationNote: '本地工作区有未提交改动，必须在独立拷贝里复现' },
    ON
  );
  assert.strictEqual(a.allowed, true);
  assert.strictEqual(a.gate, 'G3');
});

test('G3：无原因 → deny(missing-evidence)', () => {
  const a = evaluateDelegationAdmission({ isolationRequired: true }, ON);
  assert.strictEqual(a.allowed, false);
  assert.strictEqual(a.code, 'missing-evidence');
});

// ── 硬红线 ──────────────────────────────────────────────────────────────────

test('§5.2 本地已覆盖 → 即便用户点名也 deny(self-capable)', () => {
  const a = evaluateDelegationAdmission({ userNamedAgentId: 'claude', selfCapable: true }, ON);
  assert.strictEqual(a.allowed, false);
  assert.strictEqual(a.code, 'self-capable');
});

test('认知层总闸关 → deny(awareness-off)', () => {
  const a = evaluateDelegationAdmission(
    { userNamedAgentId: 'claude' },
    { KHY_EXTERNAL_AGENT_DIRECTIVE: '0' }
  );
  assert.strictEqual(a.allowed, false);
  assert.strictEqual(a.code, 'awareness-off');
});

test('fail-closed：入参不是对象 / null 也不放行', () => {
  for (const bad of [null, undefined, 'claude', 42]) {
    const a = evaluateDelegationAdmission(bad, ON);
    assert.strictEqual(a.allowed, false, `入参 ${String(bad)} 不应放行`);
  }
});

// ── 闸门标记识别 ────────────────────────────────────────────────────────────

test('detectDelegationGateInText：中英双语标记都能读出闸门 id', () => {
  assert.strictEqual(detectDelegationGateInText('[委派闸门 G1] 去重构'), 'G1');
  assert.strictEqual(detectDelegationGateInText('[delegation-gate G2] xyz'), 'G2');
  assert.strictEqual(detectDelegationGateInText('[委派闸门：G3]'), 'G3');
  assert.strictEqual(detectDelegationGateInText('请把这个重构跑一遍'), null);
  assert.strictEqual(detectDelegationGateInText(''), null);
  assert.strictEqual(detectDelegationGateInText(null), null);
});

// ── 注入文案 ────────────────────────────────────────────────────────────────

test('能力指令：必须同时教「默认自做」+ 三闸门 + 禁止项', () => {
  const text = buildExternalAgentDirective(ON);
  assert.ok(text.includes(SELF_FIRST_MARKER), '缺少默认档标记');
  for (const g of DELEGATION_GATES) {
    assert.ok(text.includes(g.id), `文案缺少闸门 ${g.id}`);
    assert.ok(text.includes(g.label), `文案缺少闸门名 ${g.label}`);
  }
  assert.ok(text.includes('禁止'), '文案缺少禁止项');
});

test('能力指令：不得复活「更适合交给外部 agent」式开放式授权', () => {
  const text = buildExternalAgentDirective(ON);
  for (const bad of ['更适合交给', '更合适交给', '更适合由外部']) {
    assert.ok(!text.includes(bad), `文案出现开放式授权句式：${bad}`);
  }
});

test('点名 nudge：必须带闸门 G1 标记指令（工具侧靠它区分点名与模型自作主张）', () => {
  const nudge = buildExternalAgentNudge('请用 claude code 帮我重构这个模块', ON);
  assert.ok(nudge.includes('G1'), 'nudge 未声明闸门 G1');
  assert.ok(DELEGATION_GATE_MARKER_RE.test(nudge), 'nudge 未给出可粘贴的闸门标记样例');
});

test('只提到不驱动（「claude code 的架构是怎样的」）→ 不产生 nudge', () => {
  assert.strictEqual(buildExternalAgentNudge('claude code 的架构是怎样的', ON), '');
});

// ── 点名识别的假阳性边界（2026-10-15）──────────────────────────────────────
// 旧判据「整条消息里出现驱动动词 + 出现别名」把「用 / 让 / 请 / 叫 / let / have / ask」这类
// 高频字都算驱动动词，于是「这个改动**不要用** claude code」被判成用户点名，
// nudge 反过来命令模型「不要自己内联去做」——默认自做被一条正则假阳性顶掉。

test('点名识别：否定 / 征询 / 无关提及都不算点名', () => {
  const shouldMiss = [
    '这个改动不要用 claude code，你自己做完',
    '别叫 codex 了，我们自己改',
    '你觉得用 claude code 改这个怎么样？',
    'let me explain what claude is',
    '这段逻辑用递归实现，另外 claude 的插件机制是什么',
  ];
  for (const msg of shouldMiss) {
    assert.strictEqual(detectExternalAgentRequest(msg, ON), null, `不应把「${msg}」判成用户点名`);
  }
});

test('点名识别：真的派活仍然命中（收紧不得把真信号一起收掉）', () => {
  const shouldHit = [
    ['用 claude code 帮我重构这个模块', 'claude'],
    ['把这个任务交给 codex 处理', 'codex'],
    ['让 opencode 跑一下测试', 'opencode'],
    ['把问题交给 claude，不要用 opencode', 'claude'],
  ];
  for (const [msg, id] of shouldHit) {
    const hit = detectExternalAgentRequest(msg, ON);
    assert.ok(hit && hit.id === id, `「${msg}」应判成点名 ${id}，实得 ${hit && hit.id}`);
  }
});

test('点名识别：门关 → 不接管（逐字节回退）', () => {
  assert.strictEqual(detectExternalAgentRequest('用 claude code 帮我重构', { KHY_EXTERNAL_AGENT_NUDGE: '0' }), null);
});

// ── G1 凭据：运行时票券 ─────────────────────────────────────────────────────

test('票券：按 turn 签发与核销，跨轮不通用，参数为空不签发', () => {
  ticket.resetDelegationTickets();
  assert.strictEqual(ticket.redeemDelegationTicket('t1', 'claude'), false, '未签发的票不得核销');
  assert.strictEqual(ticket.issueDelegationTicket('t1', 'claude'), true);
  assert.strictEqual(ticket.redeemDelegationTicket('t1', 'claude'), true);
  assert.strictEqual(ticket.redeemDelegationTicket('t1', 'codex'), false, '别的 agent 不共享票');
  assert.strictEqual(ticket.redeemDelegationTicket('t2', 'claude'), false, '别的轮次不共享票');
  assert.deepStrictEqual(ticket.peekDelegationTickets('t1'), ['claude']);
  assert.strictEqual(ticket.issueDelegationTicket('', 'claude'), false);
  assert.strictEqual(ticket.issueDelegationTicket('t1', ''), false);
  ticket.resetDelegationTickets();
});

test('票券：容量上限内淘汰最旧一轮（不用时钟，避免硬超时形态）', () => {
  ticket.resetDelegationTickets();
  assert.strictEqual(ticket.issueDelegationTicket('oldest', 'claude'), true);
  for (let i = 0; i < 40; i += 1) ticket.issueDelegationTicket(`t-${i}`, 'claude');
  assert.strictEqual(ticket.redeemDelegationTicket('oldest', 'claude'), false, '超界后最旧一轮应被淘汰');
  assert.strictEqual(ticket.redeemDelegationTicket('t-39', 'claude'), true, '最近一轮必须仍在');
  ticket.resetDelegationTickets();
});

test('注入文案：必须写明 G1 凭据不由模型书写', () => {
  const text = buildExternalAgentDirective(ON);
  assert.ok(/G1 不由你书写成立|运行时/.test(text), '文案未说明 G1 凭据来自运行时，模型会以为自己写标记就能换放行');
});
