'use strict';

/**
 * Co-located tests for healingLoop.js — the dependency self-heal orchestration.
 * Every external collaborator (resolver, runInstall, env) is injected via args.deps,
 * so no real probe/install runs. Session isolation uses distinct sessionIds that are
 * reset in after().
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const hl = require('./healingLoop');
const { isEnabled, heal, summarizeForAgent, createSession, resetSession, _internal } = hl;
const { _decodeDecision } = _internal;

// ── isEnabled reads process.env.KHY_DEP_HEALING ────────────────────────────
describe('isEnabled', () => {
  const original = process.env.KHY_DEP_HEALING;
  after(() => {
    if (original === undefined) delete process.env.KHY_DEP_HEALING;
    else process.env.KHY_DEP_HEALING = original;
  });

  test('默认开，仅显式 off 关闭', () => {
    delete process.env.KHY_DEP_HEALING;
    assert.strictEqual(isEnabled(), true);
    process.env.KHY_DEP_HEALING = 'off';
    assert.strictEqual(isEnabled(), false);
    process.env.KHY_DEP_HEALING = 'anything';
    assert.strictEqual(isEnabled(), true);
  });
});

// ── createSession ──────────────────────────────────────────────────────────
describe('createSession', () => {
  test('每份会话自带独立的 attempted / alwaysAllow 集合', () => {
    const a = createSession();
    const b = createSession();
    assert.ok(a.attempted instanceof Set);
    assert.ok(a.alwaysAllow instanceof Set);
    assert.notStrictEqual(a.attempted, b.attempted);
    a.attempted.add('x');
    assert.strictEqual(b.attempted.has('x'), false);
  });
});

// ── _decodeDecision ────────────────────────────────────────────────────────
describe('_decodeDecision', () => {
  test('布尔/字符串直映射', () => {
    assert.strictEqual(_decodeDecision(true), 'install');
    assert.strictEqual(_decodeDecision('always'), 'always');
    assert.strictEqual(_decodeDecision('allow-always'), 'always');
    assert.strictEqual(_decodeDecision('discuss'), 'discuss');
    assert.strictEqual(_decodeDecision('discuss-first'), 'discuss');
    assert.strictEqual(_decodeDecision(false), 'skip');
    assert.strictEqual(_decodeDecision(null), 'skip');
    assert.strictEqual(_decodeDecision(undefined), 'skip');
  });

  test('结构化 behavior/action/scope 映射', () => {
    assert.strictEqual(_decodeDecision({ behavior: 'Allow' }), 'install');
    assert.strictEqual(_decodeDecision({ behavior: 'allow-always' }), 'always');
    assert.strictEqual(_decodeDecision({ scope: 'session' }), 'always');
    assert.strictEqual(_decodeDecision({ action: 'discuss' }), 'discuss');
    assert.strictEqual(_decodeDecision({ response: { behavior: 'allow' } }), 'install');
  });

  test('非对象/未知形态 → skip（保守拒绝）', () => {
    assert.strictEqual(_decodeDecision('weird'), 'skip');
    assert.strictEqual(_decodeDecision(42), 'skip');
    assert.strictEqual(_decodeDecision({ behavior: 'unknown' }), 'skip');
  });
});

// ── heal 编排 ──────────────────────────────────────────────────────────────
function fakeDeps({ det, before, plan, after: afterState, installOk = true, installResult }) {
  let probeN = 0;
  const resolver = {
    detectFromError: () => det,
    probe: () => {
      probeN += 1;
      const present = probeN === 1 ? before : afterState;
      return { present };
    },
    buildInstallPlan: () => plan,
    defaultEnv: () => ({ cwd: '/inject' }),
  };
  const runInstall = async () =>
    installResult || (installOk
      ? { ok: true, steps: [], command: 'x' }
      : { ok: false, steps: [], command: 'x', error: 'exit-nonzero' });
  return { resolver, runInstall, env: { cwd: '/inject' } };
}

const PLAN = { depId: 'ffmpeg', label: 'FFmpeg', displayCommand: 'apt-get install -y ffmpeg', manager: 'os' };

describe('heal', () => {
  after(() => {
    for (const id of SESSIONS) resetSession(id);
  });
  const SESSIONS = [];
  function sid() {
    const s = `t-${SESSIONS.length}-${Math.random().toString(36).slice(2)}`;
    SESSIONS.push(s);
    return s;
  }

  test('非依赖问题（detect 返 null）→ 不接管，返回 null', async () => {
    const out = await heal({ deps: fakeDeps({ det: null }), sessionId: sid() });
    assert.strictEqual(out, null);
  });

  test('re-probe 去伪：其实已就绪 → null（误报自负）', async () => {
    const out = await heal({ deps: fakeDeps({ det: { depId: 'ffmpeg' }, before: true }), sessionId: sid() });
    assert.strictEqual(out, null);
  });

  test('无安装计划 → degraded no-install-plan', async () => {
    const out = await heal({
      deps: fakeDeps({ det: { depId: 'ffmpeg' }, before: false, plan: null }),
      sessionId: sid(),
    });
    assert.strictEqual(out.healed, false);
    assert.strictEqual(out.degraded, true);
    assert.strictEqual(out.reason, 'no-install-plan');
  });

  test('无交互通道 → degraded no-control-channel', async () => {
    const out = await heal({
      deps: fakeDeps({ det: { depId: 'ffmpeg' }, before: false, plan: PLAN }),
      // control 缺失
      sessionId: sid(),
    });
    assert.strictEqual(out.degraded, true);
    assert.strictEqual(out.reason, 'no-control-channel');
  });

  test('用户跳过 → declined', async () => {
    const control = async () => false;
    const out = await heal({
      deps: fakeDeps({ det: { depId: 'ffmpeg' }, before: false, plan: PLAN }),
      control, sessionId: sid(),
    });
    assert.strictEqual(out.declined, true);
    assert.strictEqual(out.healed, false);
  });

  test('用户选择讨论 → discuss:true，不安装也不标 attempted', async () => {
    const control = async () => 'discuss';
    const s = sid();
    const out = await heal({
      deps: fakeDeps({ det: { depId: 'ffmpeg' }, before: false, plan: PLAN }),
      control, sessionId: s,
    });
    assert.strictEqual(out.discuss, true);
    // 刻意不标 attempted → 下一轮仍可再问（不装不降级）
    const again = await heal({
      deps: fakeDeps({ det: { depId: 'ffmpeg' }, before: false, plan: PLAN, after: false }),
      control: async () => 'discuss', sessionId: s,
    });
    assert.strictEqual(again.discuss, true);
  });

  test('安装成功 + re-probe 就绪 + retry → healed:true，重试恰一次', async () => {
    let retries = 0;
    const out = await heal({
      deps: fakeDeps({ det: { depId: 'ffmpeg' }, before: false, plan: PLAN, after: true }),
      control: async () => true,
      retry: async () => { retries += 1; return '工具结果'; },
      sessionId: sid(),
    });
    assert.strictEqual(out.healed, true);
    assert.strictEqual(out.result, '工具结果');
    assert.strictEqual(retries, 1);
  });

  test('安装失败 → installFailed', async () => {
    const out = await heal({
      deps: fakeDeps({ det: { depId: 'ffmpeg' }, before: false, plan: PLAN, installOk: false }),
      control: async () => true,
      retry: async () => 'x',
      sessionId: sid(),
    });
    assert.strictEqual(out.installFailed, true);
    assert.strictEqual(out.healed, false);
  });

  test('装成功但校验仍缺失 → installVerifyFailed', async () => {
    const out = await heal({
      deps: fakeDeps({ det: { depId: 'ffmpeg' }, before: false, plan: PLAN, after: false }),
      control: async () => true,
      retry: async () => 'x',
      sessionId: sid(),
    });
    assert.strictEqual(out.installVerifyFailed, true);
  });

  test('装好且就绪但无 retry 回调 → no-retry-callback', async () => {
    const out = await heal({
      deps: fakeDeps({ det: { depId: 'ffmpeg' }, before: false, plan: PLAN, after: true }),
      control: async () => true,
      // retry 省略
      sessionId: sid(),
    });
    assert.strictEqual(out.healed, false);
    assert.strictEqual(out.reason, 'no-retry-callback');
  });

  test('同会话已尝试过 → alreadyAttempted（防死循环）', async () => {
    const s = sid();
    const deps1 = fakeDeps({ det: { depId: 'ffmpeg' }, before: false, plan: PLAN, after: true });
    await heal({ deps: deps1, control: async () => true, retry: async () => 'x', sessionId: s });
    const second = await heal({
      deps: fakeDeps({ det: { depId: 'ffmpeg' }, before: false, plan: PLAN }),
      control: async () => true, sessionId: s,
    });
    assert.strictEqual(second.alreadyAttempted, true);
  });

  test('用户选 always → 首次照常自愈成功', async () => {
    const s = sid();
    const out = await heal({
      deps: fakeDeps({ det: { depId: 'ffmpeg' }, before: false, plan: PLAN, after: true }),
      control: async () => 'always',
      retry: async () => 'x',
      sessionId: s,
    });
    assert.strictEqual(out.healed, true);
    assert.strictEqual(out.result, 'x');
  });

  test('KNOWN-DEFECT: always 授权是惰性状态——同会话后续调用命中 attempted，「总是允许」与一次性 install 无可观测差异', async () => {
    // healingLoop.js:208-214：decision==='always' 时 alwaysAllow.add(depId)，随后 step6
    // attempted.add(depId)。而 step3 的 attempted 检查先于 step5 的 alwaysAllow 检查，故
    // alwaysAllow 永不被独立消费——用户选「总是允许」后，同会话再来同一依赖直接走 alreadyAttempted，
    // 既不重问也**不再自愈/重试**，与选「只装一次」的 install 结果完全相同。授权承诺落空。
    const s = sid();
    await heal({
      deps: fakeDeps({ det: { depId: 'ffmpeg' }, before: false, plan: PLAN, after: true }),
      control: async () => 'always',
      retry: async () => 'x',
      sessionId: s,
    });
    // 第二次：即便无 control，也期望「always 已授权→免问→自动装」，实测却短路成 alreadyAttempted。
    const second = await heal({
      deps: fakeDeps({ det: { depId: 'ffmpeg' }, before: false, plan: PLAN, after: true }),
      retry: async () => 'y',
      sessionId: s,
    });
    assert.strictEqual(second.alreadyAttempted, true);
    assert.strictEqual(second.healed, false); // 「总是允许」并未带来后续自动装
  });

  test('编排层任何异常都 fail-safe → 返回 null，绝不放大故障', async () => {
    const boom = {
      resolver: { detectFromError: () => { throw new Error('内部炸'); }, probe: () => ({ present: false }), buildInstallPlan: () => PLAN, defaultEnv: () => ({}) },
      runInstall: async () => ({ ok: true }),
      env: { cwd: '/x' },
    };
    const out = await heal({ deps: boom, sessionId: sid() });
    assert.strictEqual(out, null);
  });

  test('args 省略全部（含 deps）也不抛，回退真实 resolver 时对非依赖信号返回 null', async () => {
    // 不注入 deps：heal 走真实 resolver，但 failure 为普通字符串非依赖 → detectFromError 返 null。
    const out = await heal({ failure: 'just a normal error', sessionId: sid() });
    assert.strictEqual(out, null);
  });
});

// ── summarizeForAgent ──────────────────────────────────────────────────────
describe('summarizeForAgent', () => {
  test('null 或已自愈 → null', () => {
    assert.strictEqual(summarizeForAgent(null), null);
    assert.strictEqual(summarizeForAgent({ healed: true }), null);
  });

  test('discuss / declined / degraded 各给专属状态与文案', () => {
    assert.strictEqual(summarizeForAgent({ discuss: true, depId: 'x', plan: PLAN }).status, 'discuss-requested');
    assert.strictEqual(summarizeForAgent({ declined: true, depId: 'x', plan: PLAN }).status, 'user-declined');
    assert.strictEqual(summarizeForAgent({ degraded: true, depId: 'x', plan: PLAN }).status, 'manual-required');
  });

  test('installFailed + manager-not-found → 透传精准归因 hint', () => {
    const out = summarizeForAgent({
      installFailed: true, depId: 'ffmpeg', plan: PLAN,
      install: { error: 'manager-not-found', hint: '请先安装 Node.js' },
    });
    assert.strictEqual(out.status, 'manager-not-found');
    assert.strictEqual(out.message, '请先安装 Node.js');
  });

  test('installFailed（无 hint）→ 默认归因文案', () => {
    const out = summarizeForAgent({ installFailed: true, depId: 'x', plan: PLAN, install: { error: 'manager-not-found' } });
    assert.strictEqual(out.status, 'manager-not-found');
    assert.ok(out.message.length > 0);
  });

  test('installVerifyFailed / alreadyAttempted / 未知 分别映射', () => {
    assert.strictEqual(summarizeForAgent({ installVerifyFailed: true, depId: 'x', plan: PLAN }).status, 'install-unverified');
    assert.strictEqual(summarizeForAgent({ alreadyAttempted: true, depId: 'x', plan: PLAN }).status, 'already-attempted');
    assert.strictEqual(summarizeForAgent({ depId: 'x', plan: PLAN }).status, 'unhealed');
  });

  test('plan 缺失时 base 字段为 null，不抛', () => {
    const out = summarizeForAgent({ declined: true, depId: 'x', plan: null });
    assert.strictEqual(out.installCommand, null);
    assert.strictEqual(out.docsUrl, null);
    assert.strictEqual(out.missingDependency, 'x');
  });
});
