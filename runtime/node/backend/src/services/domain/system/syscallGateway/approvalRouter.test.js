'use strict';

/**
 * approvalRouter.test.js — 三级审批路由的纯决策契约（零副作用、可注入交互器）。
 *
 * fail 方向：**fail-closed**。L1/L2 缺交互器、交互器抛错、确认串不匹配 —— 一律 DENY。
 * L2 永不因权限模式 autoApproveL1 放行（红线不可越）；L2 会话免审受 KHY_L2_SESSION_ALLOW 门控
 * （默认开；关则逐字节恢复「L2 不可会话免审」铁律）。DENY 附结构化 cause 供熔断区分性质。
 * 交互器为注入的假对象，无真实 IO；涉及 L2 会话免审时保存/恢复 process.env.KHY_L2_SESSION_ALLOW。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { route, DECISIONS, DEFAULT_L2_CONFIRM, DENY_CAUSES } = require('./approvalRouter');
const { PermissionCache } = require('./permissionCache');

test('DECISIONS 与 DENY_CAUSES 导出非空', () => {
  assert.ok(Object.values(DECISIONS).length > 0);
  assert.strictEqual(DEFAULT_L2_CONFIRM, 'YES');
  assert.ok(Object.values(DENY_CAUSES).length >= 4);
});

test('L0 绿灯自动放行，不打断', async () => {
  const r = await route({ intent: { action: 'read', scope: 'project' }, level: 'L0', cache: new PermissionCache() });
  assert.strictEqual(r.decision, DECISIONS.AUTO_ALLOW);
  assert.strictEqual(r.cause, undefined);
});

test('L1 无交互器 fail-closed 拒绝，cause=no-interactive-channel', async () => {
  const r = await route({ intent: { action: 'write', scope: 'project' }, level: 'L1', cache: new PermissionCache() });
  assert.strictEqual(r.decision, DECISIONS.DENY);
  assert.strictEqual(r.cause, DENY_CAUSES.NO_INTERACTIVE_CHANNEL);
});

test('L1 权限模式 autoApproveL1 预授权放行', async () => {
  const r = await route({
    intent: { action: 'write', scope: 'project' },
    level: 'L1',
    cache: new PermissionCache(),
    autoApproveL1: true,
  });
  assert.strictEqual(r.decision, DECISIONS.AUTO_ALLOW);
});

test('L1 命中预审批清单自动放行', async () => {
  const cache = new PermissionCache();
  cache.submitManifest([{ action: 'write', scope: 'project', level: 'L1' }]);
  const r = await route({ intent: { action: 'write', scope: 'project' }, level: 'L1', cache });
  assert.strictEqual(r.decision, DECISIONS.AUTO_ALLOW);
});

test('L1 交互器返回 once → 用户授权本次', async () => {
  const r = await route({
    intent: { action: 'write', scope: 'project' },
    level: 'L1',
    cache: new PermissionCache(),
    prompter: { askL1: async () => 'once' },
  });
  assert.strictEqual(r.decision, DECISIONS.USER_ALLOW);
});

test('L1 交互器返回 session → 授予会话免审，后续无交互器亦放行', async () => {
  const cache = new PermissionCache();
  const intent = { action: 'write', scope: 'project' };
  const r1 = await route({ intent, level: 'L1', cache, prompter: { askL1: async () => 'session' } });
  assert.strictEqual(r1.decision, DECISIONS.USER_ALLOW);
  const r2 = await route({ intent, level: 'L1', cache });
  assert.strictEqual(r2.decision, DECISIONS.AUTO_ALLOW);
});

test('L1 用户主动拒绝 → cause=user-declined', async () => {
  const r = await route({
    intent: { action: 'write', scope: 'project' },
    level: 'L1',
    cache: new PermissionCache(),
    prompter: { askL1: async () => 'deny' },
  });
  assert.strictEqual(r.decision, DECISIONS.DENY);
  assert.strictEqual(r.cause, DENY_CAUSES.USER_DECLINED);
});

test('L1 交互器抛错 → cause=interaction-error fail-closed', async () => {
  const r = await route({
    intent: { action: 'write', scope: 'project' },
    level: 'L1',
    cache: new PermissionCache(),
    prompter: { askL1: async () => { throw new Error('x'); } },
  });
  assert.strictEqual(r.decision, DECISIONS.DENY);
  assert.strictEqual(r.cause, DENY_CAUSES.INTERACTION_ERROR);
});

test('L2 无交互器 fail-closed 拒绝', async () => {
  const r = await route({ intent: { action: 'delete', scope: 'project' }, level: 'L2', cache: new PermissionCache() });
  assert.strictEqual(r.decision, DECISIONS.DENY);
  assert.strictEqual(r.cause, DENY_CAUSES.NO_INTERACTIVE_CHANNEL);
});

test('L2 autoApproveL1 不影响红线，仍拒绝', async () => {
  const r = await route({
    intent: { action: 'delete', scope: 'project' },
    level: 'L2',
    cache: new PermissionCache(),
    autoApproveL1: true,
  });
  assert.strictEqual(r.decision, DECISIONS.DENY);
});

test('L2 空串确认不通过（防呆③差异化）', async () => {
  const r = await route({
    intent: { action: 'delete', scope: 'project' },
    level: 'L2',
    cache: new PermissionCache(),
    prompter: { confirmL2: async () => '' },
  });
  assert.strictEqual(r.decision, DECISIONS.DENY);
  assert.strictEqual(r.cause, DENY_CAUSES.CONFIRM_MISMATCH);
});

test('L2 小写 yes 不通过（区分大小写）', async () => {
  const r = await route({
    intent: { action: 'delete', scope: 'project' },
    level: 'L2',
    cache: new PermissionCache(),
    prompter: { confirmL2: async () => 'yes' },
  });
  assert.strictEqual(r.decision, DECISIONS.DENY);
});

test('L2 键入带首尾空白的 YES 去空白后放行', async () => {
  const r = await route({
    intent: { action: 'delete', scope: 'project' },
    level: 'L2',
    cache: new PermissionCache(),
    prompter: { confirmL2: async () => '  YES  ' },
  });
  assert.strictEqual(r.decision, DECISIONS.USER_ALLOW);
});

test('L2 自定义确认串精确匹配放行', async () => {
  const r = await route({
    intent: { action: 'delete', scope: 'project' },
    level: 'L2',
    cache: new PermissionCache(),
    l2ConfirmWord: 'confirm-delete',
    prompter: { confirmL2: async () => 'confirm-delete' },
  });
  assert.strictEqual(r.decision, DECISIONS.USER_ALLOW);
});

test('L2 确认交互抛错 → cause=interaction-error', async () => {
  const r = await route({
    intent: { action: 'delete', scope: 'project' },
    level: 'L2',
    cache: new PermissionCache(),
    prompter: { confirmL2: async () => { throw new Error('boom'); } },
  });
  assert.strictEqual(r.decision, DECISIONS.DENY);
  assert.strictEqual(r.cause, DENY_CAUSES.INTERACTION_ERROR);
});

test('L2 会话免审门控开：键入 YES+session 后同类免审', async () => {
  const saved = process.env.KHY_L2_SESSION_ALLOW;
  delete process.env.KHY_L2_SESSION_ALLOW;
  try {
    const cache = new PermissionCache();
    const intent = { action: 'delete', scope: 'project' };
    const r1 = await route({
      intent,
      level: 'L2',
      cache,
      prompter: { confirmL2: async () => ({ typed: 'YES', session: true }) },
    });
    assert.strictEqual(r1.decision, DECISIONS.USER_ALLOW);
    const r2 = await route({ intent, level: 'L2', cache });
    assert.strictEqual(r2.decision, DECISIONS.AUTO_ALLOW);
  } finally {
    if (saved === undefined) delete process.env.KHY_L2_SESSION_ALLOW;
    else process.env.KHY_L2_SESSION_ALLOW = saved;
  }
});

test('L2 会话免审门控关：session 请求不留免审，下次无交互器仍拒', async () => {
  const saved = process.env.KHY_L2_SESSION_ALLOW;
  process.env.KHY_L2_SESSION_ALLOW = 'off';
  try {
    const cache = new PermissionCache();
    const intent = { action: 'delete', scope: 'project' };
    const r1 = await route({
      intent,
      level: 'L2',
      cache,
      prompter: { confirmL2: async () => ({ typed: 'YES', session: true }) },
    });
    assert.strictEqual(r1.decision, DECISIONS.USER_ALLOW, '本次仍放行');
    const r2 = await route({ intent, level: 'L2', cache });
    assert.strictEqual(r2.decision, DECISIONS.DENY, '红线铁律恢复：无免审、无交互器 → 拒');
  } finally {
    if (saved === undefined) delete process.env.KHY_L2_SESSION_ALLOW;
    else process.env.KHY_L2_SESSION_ALLOW = saved;
  }
});
