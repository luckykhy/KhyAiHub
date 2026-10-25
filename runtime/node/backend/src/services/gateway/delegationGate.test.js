'use strict';

/**
 * delegationGate.test.js — 外部智能体委派审批闸的纯决策契约（零副作用、可注入交互器）。
 *
 * fail 方向：**fail-closed**。策略非法值、无交互器、交互器抛错、应答非法 —— 一律拒绝，
 * 且拒绝必须带结构化 cause。humanPin 只认 'user-command' 字面单值（终审防呆：env 钉选
 * 不构成人类批准，任何其他标记值一律视为未批准并走询问）。env 一律注入参数，
 * 不触碰 process.env（observeDelegationSample 用 KHY_DELEGATION_GATE_OBSERVE_FILE 指到临时文件）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EXTERNAL_DELEGATION_ADAPTER_KEYS,
  HUMAN_PIN_APPROVED,
  POLICY,
  DENY_CAUSES,
  isExternalDelegationAdapter,
  resolveDelegationPolicy,
  normalizeDelegationAnswer,
  createSessionApprovalStore,
  decideExternalDelegation,
  buildDelegationDeniedResult,
  observeDelegationSample,
} = require('./delegationGate');

test('导出面：外部 key 集合、human-pin 字面单值、策略与 cause 枚举非空', () => {
  assert.deepStrictEqual(EXTERNAL_DELEGATION_ADAPTER_KEYS, [
    'claude',
    'codex',
    'opencode',
    'openclaw',
    'acp',
    'commandcode',
    'cli',
  ]);
  assert.strictEqual(HUMAN_PIN_APPROVED, 'user-command');
  assert.deepStrictEqual(Object.values(POLICY).sort(), ['allow', 'ask', 'deny']);
  assert.ok(Object.values(DENY_CAUSES).length >= 5);
});

test('isExternalDelegationAdapter：七个外部 key 真', () => {
  for (const key of EXTERNAL_DELEGATION_ADAPTER_KEYS) {
    assert.strictEqual(isExternalDelegationAdapter(key), true, key);
  }
  assert.strictEqual(isExternalDelegationAdapter('CLAUDE'), true, '大小写不敏感');
});

test('isExternalDelegationAdapter：khyos 原生/IDE 桥/relay 类 key 全假', () => {
  const notExternal = [
    'api',
    'ollama',
    'kiro',
    'cursor',
    'trae',
    'vscode',
    'warp',
    'cursor2api',
    'relay_api',
    'relay',
    'clipboard',
    'localLLM',
    '',
    null,
    undefined,
  ];
  for (const key of notExternal) {
    assert.strictEqual(isExternalDelegationAdapter(key), false, String(key));
  }
  // 前缀包含不算：'clipboard' ≠ 'cli'
  assert.strictEqual(isExternalDelegationAdapter('clipboard'), false);
});

test('resolveDelegationPolicy：未设=ask，allow/deny 三态，非法值一律 deny（禁 fail-open）', () => {
  assert.strictEqual(resolveDelegationPolicy({}), POLICY.ASK);
  assert.strictEqual(resolveDelegationPolicy({ KHY_DELEGATION_APPROVAL: '' }), POLICY.ASK);
  assert.strictEqual(resolveDelegationPolicy({ KHY_DELEGATION_APPROVAL: 'ask' }), POLICY.ASK);
  assert.strictEqual(resolveDelegationPolicy({ KHY_DELEGATION_APPROVAL: 'allow' }), POLICY.ALLOW);
  assert.strictEqual(resolveDelegationPolicy({ KHY_DELEGATION_APPROVAL: 'ALLOW' }), POLICY.ALLOW);
  assert.strictEqual(resolveDelegationPolicy({ KHY_DELEGATION_APPROVAL: 'deny' }), POLICY.DENY);
  for (const bad of ['yes', '1', 'true', 'on', 'off', 'bogus']) {
    assert.strictEqual(
      resolveDelegationPolicy({ KHY_DELEGATION_APPROVAL: bad }),
      POLICY.DENY,
      bad
    );
  }
  assert.strictEqual(resolveDelegationPolicy(undefined), POLICY.ASK);
});

test('策略 deny 压过 humanPin：deny 是人的常设意志', async () => {
  const v = await decideExternalDelegation({
    adapterKey: 'claude',
    adapterName: 'Claude Code',
    policy: POLICY.DENY,
    humanPin: 'user-command',
    sessionStore: createSessionApprovalStore(),
    ask: async () => {
      throw new Error('must not ask');
    },
  });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.cause, DENY_CAUSES.POLICY_DENY);
  assert.ok(v.reason.includes('KHY_DELEGATION_APPROVAL=deny'));
});

test('策略 allow：放行不调 ask', async () => {
  let asked = 0;
  const v = await decideExternalDelegation({
    adapterKey: 'opencode',
    adapterName: 'OpenCode CLI',
    policy: POLICY.ALLOW,
    ask: async () => {
      asked += 1;
      return true;
    },
  });
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(asked, 0);
});

test("humanPin='user-command' 放行不调 ask（用户亲手敲 khy <agent> 即批准）", async () => {
  let asked = 0;
  const v = await decideExternalDelegation({
    adapterKey: 'claude',
    policy: POLICY.ASK,
    humanPin: 'user-command',
    ask: async () => {
      asked += 1;
      return true;
    },
  });
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.cause, 'user-command');
  assert.strictEqual(asked, 0);
});

test('终审①防呆：humanPin 为任何非 user-command 值都不放行、走 ask', async () => {
  for (const pin of ['env-pin', true, false, 'allow', 'user_command', 'USER-COMMAND', '']) {
    let asked = 0;
    const v = await decideExternalDelegation({
      adapterKey: 'codex',
      policy: POLICY.ASK,
      humanPin: pin,
      ask: async () => {
        asked += 1;
        return false;
      },
    });
    assert.strictEqual(v.allowed, false, String(pin));
    assert.strictEqual(asked, 1, `非 user-command 标记必须走询问: ${String(pin)}`);
    assert.strictEqual(v.cause, DENY_CAUSES.USER_DECLINED);
  }
});

test('sessionApproved 放行不调 ask（会话记忆命中）', async () => {
  let asked = 0;
  const v = await decideExternalDelegation({
    adapterKey: 'opencode',
    policy: POLICY.ASK,
    sessionApproved: true,
    ask: async () => {
      asked += 1;
      return true;
    },
  });
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.cause, 'session-approved');
  assert.strictEqual(asked, 0);
});

test("ask 返回 true → 放行且不记忆（仅本次）", async () => {
  const store = createSessionApprovalStore();
  const v = await decideExternalDelegation({
    adapterKey: 'claude',
    adapterName: 'Claude Code',
    policy: POLICY.ASK,
    sessionStore: store,
    ask: async () => true,
  });
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.cause, 'user-allow-once');
  assert.strictEqual(store.has('claude'), false);
});

test("ask 返回 'always' → 放行且记忆；第二次（会话记忆命中）不再问", async () => {
  const store = createSessionApprovalStore();
  let asked = 0;
  const v1 = await decideExternalDelegation({
    adapterKey: 'opencode',
    policy: POLICY.ASK,
    sessionStore: store,
    sessionApproved: store.has('opencode'),
    ask: async () => 'always',
  });
  assert.strictEqual(v1.allowed, true);
  assert.strictEqual(v1.cause, 'user-allow-always');
  assert.strictEqual(store.has('opencode'), true);
  const v2 = await decideExternalDelegation({
    adapterKey: 'opencode',
    policy: POLICY.ASK,
    sessionStore: store,
    sessionApproved: store.has('opencode'),
    ask: async () => {
      asked += 1;
      return true;
    },
  });
  assert.strictEqual(v2.allowed, true);
  assert.strictEqual(v2.cause, 'session-approved');
  assert.strictEqual(asked, 0, '同会话同渠道第二次不得再问');
});

test('询问 input 携带宿主渲染字段：TUI classic 卡读 description/command，经典 REPL 读 explanation.text', async () => {
  let seen = null;
  await decideExternalDelegation({
    adapterKey: 'opencode',
    adapterName: 'OpenCode CLI',
    policy: POLICY.ASK,
    ask: async (ctx) => {
      seen = ctx.input;
      return false;
    },
  });
  assert.ok(seen, 'ask 被调用且拿到 input');
  // TUI 非 level 卡（permissionNotice.cardRows:248-251）只消费这两样
  assert.ok(
    String(seen.description).includes('OpenCode'),
    'description 必须点名渠道（TUI「说明」行）'
  );
  assert.ok(String(seen.command).includes('OpenCode'), 'command 必须携带渠道（TUI「命令」行）');
  // 经典 REPL（replSession.js:8683-8693）只打印 explanation.text
  assert.ok(
    seen.explanation &&
      typeof seen.explanation.text === 'string' &&
      seen.explanation.text.includes('OpenCode') &&
      seen.explanation.text.includes('费用'),
    'explanation.text 必须含渠道名与费用警示（经典 REPL 说明行）'
  );
  // 原有结构化字段保留（LAN 桥/转录可读）
  assert.strictEqual(seen.adapter, 'opencode');
  assert.strictEqual(seen.adapterName, 'OpenCode CLI');
});

test('ask 返回 false / null / 42 / {behavior:"bogus"} → 拒绝（fail-closed）', async () => {
  for (const bad of [false, null, undefined, 42, 'bogus', { behavior: 'bogus' }, {}]) {
    const v = await decideExternalDelegation({
      adapterKey: 'claude',
      policy: POLICY.ASK,
      ask: async () => bad,
    });
    assert.strictEqual(v.allowed, false, JSON.stringify(bad));
    assert.strictEqual(v.cause, DENY_CAUSES.USER_DECLINED, JSON.stringify(bad));
    assert.ok(v.reason && v.reason.length > 0, '拒绝必须带面向用户的具体原因');
  }
});

test('ask 抛异常 → 拒绝 cause=prompt-error（A2-7：判定失败留痕不放行）', async () => {
  const v = await decideExternalDelegation({
    adapterKey: 'cli',
    policy: POLICY.ASK,
    ask: async () => {
      throw new Error('channel gone');
    },
  });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.cause, DENY_CAUSES.PROMPT_ERROR);
  assert.ok(v.reason.includes('审批询问通道异常'));
});

test('ask 缺失（headless）→ 拒绝 cause=no-interactive-channel', async () => {
  const v = await decideExternalDelegation({
    adapterKey: 'claude',
    policy: POLICY.ASK,
    ask: null,
  });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.cause, DENY_CAUSES.NO_INTERACTIVE_CHANNEL);
  assert.ok(v.reason.includes('无交互审批通道'));
});

test('normalizeDelegationAnswer 全枚举（对齐 syscallGateway decode 容忍面）', () => {
  // 本次放行
  assert.deepStrictEqual(normalizeDelegationAnswer(true), { answer: 'allow', remember: false });
  assert.deepStrictEqual(normalizeDelegationAnswer('allow'), { answer: 'allow', remember: false });
  assert.deepStrictEqual(normalizeDelegationAnswer({ behavior: 'allow' }), {
    answer: 'allow',
    remember: false,
  });
  assert.deepStrictEqual(
    normalizeDelegationAnswer({ type: 'control_response', response: { behavior: 'allow' } }),
    { answer: 'allow', remember: false }
  );
  // 会话记忆
  assert.deepStrictEqual(normalizeDelegationAnswer('always'), { answer: 'allow', remember: true });
  assert.deepStrictEqual(normalizeDelegationAnswer('allow-always'), {
    answer: 'allow',
    remember: true,
  });
  assert.deepStrictEqual(normalizeDelegationAnswer({ behavior: 'allow-always' }), {
    answer: 'allow',
    remember: true,
  });
  assert.deepStrictEqual(normalizeDelegationAnswer({ behavior: 'allow', scope: 'session' }), {
    answer: 'allow',
    remember: true,
  });
  // 拒绝
  for (const bad of [false, null, undefined, '', 0, 42, 'deny', 'bogus', { behavior: 'bogus' }]) {
    const a = normalizeDelegationAnswer(bad);
    assert.strictEqual(a.answer, 'deny', JSON.stringify(bad));
    assert.strictEqual(a.remember, false, JSON.stringify(bad));
  }
});

test('buildDelegationDeniedResult：与 beforeRun-skip 同型的拒绝信封', () => {
  const entry = {
    key: 'opencode',
    adapter: { getStatus: () => ({ name: 'OpenCode CLI', available: true }) },
  };
  const r = buildDelegationDeniedResult(entry, '外部智能体 OpenCode CLI 委派未获批准：测试');
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.errorType, 'delegation_denied');
  assert.strictEqual(r.statusCode, 0);
  assert.strictEqual(r.gatewaySkipFastFail, true);
  assert.deepStrictEqual(r.attempts, []);
  assert.strictEqual(r.provider, 'OpenCode CLI');
  assert.strictEqual(r.adapter, 'opencode');
  assert.ok(r.error.includes('未获批准'));
});

test('buildDelegationDeniedResult：getStatus 抛异常时回落 key，entry 缺失不抛', () => {
  const r1 = buildDelegationDeniedResult(
    { key: 'claude', adapter: { getStatus: () => { throw new Error('x'); } } },
    'reason'
  );
  assert.strictEqual(r1.provider, 'claude');
  const r2 = buildDelegationDeniedResult(null, 'reason');
  assert.strictEqual(r2.success, false);
  assert.strictEqual(r2.errorType, 'delegation_denied');
  assert.strictEqual(r2.adapter, 'external');
});

test('observeDelegationSample：env 覆盖落点、jsonl 追加、fail-soft 不抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-gate-test-'));
  const file = path.join(dir, 'observe.jsonl');
  observeDelegationSample({ adapterKey: 'claude', decision: 'deny' }, {
    KHY_DELEGATION_GATE_OBSERVE_FILE: file,
  });
  observeDelegationSample({ adapterKey: 'cli', decision: 'allow' }, {
    KHY_DELEGATION_GATE_OBSERVE_FILE: file,
  });
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.strictEqual(first.ev, 'delegation');
  assert.strictEqual(first.adapterKey, 'claude');
  // 垃圾入参不抛（env 一并注入临时落点，不污染真实台账）
  observeDelegationSample(undefined, { KHY_DELEGATION_GATE_OBSERVE_FILE: file });
  // 非法落点（目录不存在且无法创建）也不抛
  observeDelegationSample({}, { KHY_DELEGATION_GATE_OBSERVE_FILE: path.join(dir, 'no', 'such', 'x.jsonl') });
  fs.rmSync(dir, { recursive: true, force: true });
});
