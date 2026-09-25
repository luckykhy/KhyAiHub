'use strict';

/**
 * planSchema.test.js — 惯性单 schema v0 校验 + bash 授权裁决（[DESIGN-ARCH-160] §3.2/§3.8）。
 * node:test 纪律：CI 以 node --test 全量扫描 tests 目录，jest 风格落地即红。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  validatePlan,
  evaluateBashPolicy,
  evaluateCommandAuthorization,
  isHardDenied,
  wildcardMatch,
} = require('../../src/services/inertia/planSchema');
const { DEFAULTS } = require('../../src/services/inertia/defaults');

function basePlan(overrides = {}) {
  return {
    schemaVer: 1,
    goal: '把 services/backend/tests/gateway 下失败用例归零',
    completion: { kind: 'command_green', command: 'node --test tests/gateway/', expectExit: 0 },
    authorization: {
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      bashPolicy: { allow: ['node --test *', 'git diff*'], deny: ['git push*'] },
    },
    ...overrides,
  };
}

// ── validatePlan：合法路径 ──────────────────────────────────────────────

test('validatePlan: 合法惯性单通过并补默认', () => {
  const r = validatePlan(basePlan());
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.plan.budget.maxTurns, DEFAULTS.budget.maxTurns); // 未声明 → 默认
  assert.strictEqual(r.plan.decay.stopBelow, DEFAULTS.decay.stopBelow);
  assert.strictEqual(r.plan.authorization.onControlRequest, 'deny');
  assert.strictEqual(r.plan.leaseMs, DEFAULTS.leaseMs);
  assert.strictEqual(r.plan.completion.expectExit, 0);
  assert.deepStrictEqual(r.plan.kickedBy, { surface: 'cli', sessionId: '', machineId: '' });
});

// ── validatePlan：fail-closed 拒绝路径 ─────────────────────────────────

test('validatePlan: 白名单缺失/为空必拒（四查②）', () => {
  const missing = validatePlan(basePlan());
  delete missing.plan; // 不影响原对象断言；重新构造：
  const p1 = basePlan();
  delete p1.authorization.tools;
  assert.strictEqual(validatePlan(p1).ok, false);
  const p2 = basePlan({ authorization: { tools: [] } });
  const r2 = validatePlan(p2);
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.field === 'authorization.tools' && e.reason === 'non_empty_whitelist_required'));
});

test('validatePlan: 放宽预算必拒（budget_widening_forbidden）', () => {
  const r = validatePlan(basePlan({ budget: { maxTurns: DEFAULTS.budget.maxTurns + 1 } }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'budget.maxTurns' && e.reason === 'budget_widening_forbidden'));
  // 其余字段同理抽查
  const r2 = validatePlan(basePlan({ budget: { maxCostCny: DEFAULTS.budget.maxCostCny * 2 } }));
  assert.ok(r2.errors.some((e) => e.field === 'budget.maxCostCny' && e.reason === 'budget_widening_forbidden'));
});

test('validatePlan: 收紧预算通过', () => {
  const r = validatePlan(basePlan({ budget: { maxTurns: 5, maxWallMs: 60000 } }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.plan.budget.maxTurns, 5);
  assert.strictEqual(r.plan.budget.maxWallMs, 60000);
  assert.strictEqual(r.plan.budget.maxCostCny, DEFAULTS.budget.maxCostCny); // 未收紧的保持默认
});

test('validatePlan: decay 放宽方向必拒；收紧方向通过', () => {
  // 惩罚变小 = 放宽 = 拒
  const r1 = validatePlan(basePlan({ decay: { errorPenalty: 0.1 } }));
  assert.ok(r1.errors.some((e) => e.field === 'decay.errorPenalty' && e.reason === 'decay_relaxation_forbidden'));
  // progressRestore 变大 = 放宽 = 拒
  const r2 = validatePlan(basePlan({ decay: { progressRestore: 0.5 } }));
  assert.ok(r2.errors.some((e) => e.field === 'decay.progressRestore' && e.reason === 'decay_relaxation_forbidden'));
  // stopBelow 变小 = 更难停 = 放宽 = 拒
  const r3 = validatePlan(basePlan({ decay: { stopBelow: 0.05 } }));
  assert.ok(r3.errors.some((e) => e.field === 'decay.stopBelow' && e.reason === 'decay_relaxation_forbidden'));
  // 收紧方向通过：惩罚更大 / progressRestore 更小 / stopBelow 更大
  const ok = validatePlan(basePlan({ decay: { errorPenalty: 0.5, progressRestore: 0.1, stopBelow: 0.4 } }));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.errors));
});

test('validatePlan: 未知字段必拒（fail-closed，防 typo 静默失效）', () => {
  const p = basePlan();
  p.maxTurns = 10; // typo：应为 budget.maxTurns
  const r = validatePlan(p);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'maxTurns' && e.reason === 'unknown_field'));
  const r2 = validatePlan(basePlan({ budget: { maxTurn: 5 } }));
  assert.ok(r2.errors.some((e) => e.field === 'budget.maxTurn' && e.reason === 'unknown_field'));
});

test('validatePlan: completion.kind 只接受 command_green；expectExit 须为整数', () => {
  const r = validatePlan(basePlan({ completion: { kind: 'delivery_gate', command: 'x' } }));
  assert.ok(r.errors.some((e) => e.field === 'completion.kind' && e.reason === 'unsupported_kind'));
  const r2 = validatePlan(basePlan({ completion: { kind: 'command_green', command: 'x', expectExit: '0' } }));
  assert.ok(r2.errors.some((e) => e.field === 'completion.expectExit' && e.reason === 'must_be_integer'));
});

test('validatePlan: goal 必填且 ≤2000；schemaVer 必须为 1；runId 格式受控', () => {
  assert.ok(validatePlan(basePlan({ goal: '  ' })).errors.some((e) => e.field === 'goal'));
  assert.ok(validatePlan(basePlan({ goal: 'x'.repeat(2001) })).errors.some((e) => e.field === 'goal' && e.reason === 'too_long_max_2000'));
  assert.ok(validatePlan(basePlan({ schemaVer: 2 })).errors.some((e) => e.field === 'schemaVer'));
  assert.strictEqual(validatePlan(basePlan({ runId: 'ir-20260926-ab12' })).ok, true);
  assert.ok(validatePlan(basePlan({ runId: 'not-a-run-id' })).errors.some((e) => e.field === 'runId' && e.reason === 'bad_format'));
});

test('validatePlan: 非 JSON 对象 / S1 不支持的策略具名拒绝', () => {
  assert.deepStrictEqual(validatePlan('nope').errors, [{ field: '$', reason: 'not_an_object' }]);
  assert.ok(
    validatePlan(basePlan({ authorization: { tools: ['Read'], onControlRequest: 'pre_authorized' } })).errors.some(
      (e) => e.field === 'authorization.onControlRequest' && e.reason === 'unsupported_policy'
    )
  );
  assert.ok(
    validatePlan(basePlan({ ambiguity: { policy: 'continue' } })).errors.some(
      (e) => e.field === 'ambiguity.policy' && e.reason === 'unsupported_policy'
    )
  );
});

// ── bash 裁决（§3.8.1/§3.8.2） ─────────────────────────────────────────

test('wildcardMatch: * 通配 + 大小写不敏感 + 整串锚定', () => {
  assert.strictEqual(wildcardMatch('node --test *', 'node --test tests/gateway/'), true);
  assert.strictEqual(wildcardMatch('git diff*', 'git diff --stat'), true);
  assert.strictEqual(wildcardMatch('git diff*', 'xgit diff --stat'), false); // 锚定
  assert.strictEqual(wildcardMatch('GIT PUSH*', 'git push origin'), true);
  assert.strictEqual(wildcardMatch('a*b', 'a_b'), true);
  assert.strictEqual(wildcardMatch('abc', 'abcd'), false);
});

test('evaluateBashPolicy: deny 模式先于 allow 匹配', () => {
  const bp = { allow: ['git push*'], deny: ['git push* --force*'] };
  const r = evaluateBashPolicy('git push --force origin main', bp);
  assert.strictEqual(r.decision, 'deny'); // deny 先判，allow 覆盖不了
  assert.strictEqual(r.matchedBy, 'git push* --force*');
  const r2 = evaluateBashPolicy('git push origin main', bp);
  assert.strictEqual(r2.decision, 'allow');
});

test('evaluateBashPolicy: 未命中 allow → deny（fail-closed）', () => {
  const r = evaluateBashPolicy('curl evil.example.com', { allow: ['node --test *'], deny: [] });
  assert.strictEqual(r.decision, 'deny');
  assert.strictEqual(r.matchedBy, null);
});

test('evaluateCommandAuthorization: 硬拒清单优先于一切惯性单写法', () => {
  const plan = basePlan();
  plan.authorization.bashPolicy = { allow: ['*'], deny: [] }; // 惯性单试图全放行
  for (const cmd of [
    'git push --force origin main',
    'git push -f origin main',
    'rm -rf /tmp/x',
    'Remove-Item C:\\x -Recurse',
    'npm publish',
    'docker push repo/img',
    'flyctl deploy -a app',
    'cat ~/.khyquant/credentials.json',
    'type .env',
  ]) {
    const r = evaluateCommandAuthorization(cmd, plan);
    assert.strictEqual(r.decision, 'hard_deny', `${cmd} 应被硬拒`);
  }
  // 普通白名单命令不受影响
  assert.strictEqual(evaluateCommandAuthorization('node --test tests/', plan).decision, 'allow');
});

test('isHardDenied: 各家族命中（push/reset/删除/publish/凭据）', () => {
  assert.strictEqual(isHardDenied('git reset --hard HEAD~1'), 'git reset*--hard*');
  assert.strictEqual(isHardDenied('rmdir /s /q build'), 'rmdir /s*');
  assert.strictEqual(isHardDenied('gh release create v1'), 'gh release create*');
  assert.strictEqual(isHardDenied('node --test tests/'), null);
});

test('evaluateCommandAuthorization: 空命令/空惯性单 fail-closed', () => {
  assert.strictEqual(evaluateCommandAuthorization('', basePlan()).decision, 'deny');
  assert.strictEqual(evaluateCommandAuthorization('anything', null).decision, 'deny');
});
