'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const acp = require('../../src/services/domain/messaging/agentclient/acpTypes');
const sessionMapping = require('../../src/services/domain/messaging/agentclient/sessionMapping');
const {
  loadAgentRegistry,
  resolveAgentCommand,
} = require('../../src/services/gateway/adapters/acpAgentInvocation');
const {
  mapDecisionToOutcome,
  summarizeUsageUpdates,
} = require('../../src/services/gateway/adapters/acpAgentAdapter');
const { isServeEnabled } = require('../../src/cli/handlers/acp');

describe('acpTypes（编辑器 ACP v1）', () => {
  it('constants load from the contract file', () => {
    assert.equal(acp.PROTOCOL_VERSION, 1);
    assert.ok(acp.SESSION_UPDATE_VARIANTS.includes('agent_message_chunk'));
    assert.ok(acp.STOP_REASONS.includes('cancelled'));
  });

  it('envelope classification', () => {
    assert.equal(acp.isRequest({ method: 'session/new', id: 1 }), true);
    assert.equal(acp.isNotification({ method: 'session/cancel' }), true);
    assert.equal(acp.isResponse({ id: 1, result: {} }), true);
    assert.equal(acp.isNotification({ method: 'm', id: 2 }), false);
  });

  it('stopReasonFromError maps abort/cancel to cancelled（协议 MUST）', () => {
    assert.equal(acp.stopReasonFromError({ errorType: 'aborted' }), 'cancelled');
    assert.equal(acp.stopReasonFromError({ errorType: 'cancelled_by_client' }), 'cancelled');
    assert.equal(acp.stopReasonFromError({ errorType: 'max_token' }), 'max_tokens');
    assert.equal(acp.stopReasonFromError({ errorType: 'content_blocked' }), 'refusal');
    assert.equal(acp.stopReasonFromError({}), 'end_turn');
  });

  it('toolKindFromName heuristic', () => {
    assert.equal(acp.toolKindFromName('read_file'), 'read');
    assert.equal(acp.toolName2Kind === undefined, true); // 不存在异名导出
    assert.equal(acp.toolKindFromName('shellCommand'), 'execute');
    assert.equal(acp.toolKindFromName('mystery_tool'), 'other');
  });
});

describe('sessionMapping', () => {
  it('create/get/delete roundtrip; id prefixed sess_', () => {
    sessionMapping.resetForTest();
    const rec = sessionMapping.createSession('D:/abs/path');
    assert.ok(rec.id.startsWith('sess_'));
    assert.equal(sessionMapping.getSession(rec.id).cwd, 'D:/abs/path');
    assert.equal(sessionMapping.getSession('nope'), null);
    sessionMapping.deleteSession(rec.id);
    assert.equal(sessionMapping.getSession(rec.id), null);
  });
});

describe('acpAgentInvocation（面 B 子进程解析）', () => {
  it('loadAgentRegistry parses key=command pairs, ignores malformed tokens', () => {
    const reg = loadAgentRegistry({ KHY_ACPCLIENT_AGENTS: 'a=npx foo --bar, badtoken, b=C:\\x\\y.exe' });
    assert.equal(reg.a, 'npx foo --bar');
    assert.equal(reg.b, 'C:\\x\\y.exe');
    assert.equal(reg.badtoken, undefined);
  });

  it('resolveAgentCommand: bare command passes through, missing path file → null', () => {
    const resolved = resolveAgentCommand('a', { KHY_ACPCLIENT_AGENTS: 'a=npx @zed-industries/claude-code-acp' });
    assert.deepEqual(resolved, { command: 'npx', args: ['@zed-industries/claude-code-acp'] });
    assert.equal(resolveAgentCommand('a', { KHY_ACPCLIENT_AGENTS: 'a=Z:\\definitely\\missing\\bin.exe' }), null);
    assert.equal(resolveAgentCommand('ghost', { KHY_ACPCLIENT_AGENTS: 'a=npx foo' }), null);
  });
});

describe('acpAgentAdapter pure helpers', () => {
  it('mapDecisionToOutcome: allow/allow-always/reject/unknown all settled, fail-closed', () => {
    const opts = {
      allow: { optionId: 'a1', kind: 'allow_once' },
      allowAlways: { optionId: 'a2', kind: 'allow_always' },
      reject: { optionId: 'r1', kind: 'reject_once' },
    };
    assert.deepEqual(mapDecisionToOutcome(true, opts), { outcome: 'selected', optionId: 'a1' });
    assert.deepEqual(mapDecisionToOutcome('always', opts), { outcome: 'selected', optionId: 'a2' });
    assert.deepEqual(mapDecisionToOutcome(false, opts), { outcome: 'selected', optionId: 'r1' });
    assert.deepEqual(mapDecisionToOutcome(null, opts), { outcome: 'selected', optionId: 'r1' });
    // 无对应选项时一律 cancelled，绝不猜测放行
    assert.deepEqual(mapDecisionToOutcome(true, { allow: null, allowAlways: null, reject: null }), {
      outcome: 'cancelled',
    });
  });

  it('summarizeUsageUpdates: used/size snapshot-max, cost cumulative', () => {
    assert.equal(summarizeUsageUpdates([]), null);
    const out = summarizeUsageUpdates([
      { used: 1000, size: 200000, cost: { amount: 0.01, currency: 'USD' } },
      { used: 2000, size: 200000, cost: { amount: 0.02, currency: 'USD' } },
    ]);
    assert.equal(out.totalTokens, 2000);
    assert.equal(out.costCNY > 0, true);
  });
});

describe('khy acp serve 门控', () => {
  it('default off; explicit 1 on; 0/false/off/no off; truthy junk on（mcp 先例 truthy 语义）', () => {
    assert.equal(isServeEnabled({}), false);
    assert.equal(isServeEnabled({ KHY_ACPCLIENT_SERVE: '1' }), true);
    assert.equal(isServeEnabled({ KHY_ACPCLIENT_SERVE: '0' }), false);
    assert.equal(isServeEnabled({ KHY_ACPCLIENT_SERVE: 'false' }), false);
    assert.equal(isServeEnabled({ KHY_ACPCLIENT_SERVE: 'off' }), false);
    assert.equal(isServeEnabled({ KHY_ACPCLIENT_SERVE: 'banana' }), true);
  });
});
