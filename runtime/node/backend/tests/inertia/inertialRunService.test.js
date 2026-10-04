'use strict';

/**
 * inertialRunService.test.js — 外置控制器集成冒烟（依赖注入，不真调 AI/内核）。
 * [DESIGN-ARCH-160] §7：启动四查 / 续推循环 / 七类停机可判 / 落盘三件套 / 信封形状。
 * node:test 纪律：CI 以 node --test 全量扫描 tests 目录，jest 风格落地即红。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runInertialPlan, planHashOf } = require('../../src/services/inertia/inertialRunService');
const { validatePlan } = require('../../src/services/inertia/planSchema');
const { DEFAULTS } = require('../../src/services/inertia/defaults');

function basePlan(overrides = {}) {
  return {
    schemaVer: 1,
    goal: '把失败用例归零（测试惯性单）',
    completion: { kind: 'command_green', command: 'node --test tests/gateway/', expectExit: 0 },
    authorization: {
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      bashPolicy: { allow: ['node --test *'], deny: [] },
    },
    ...overrides,
  };
}

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inertia-run-test-'));
}

/** 组装依赖注入 opts：fake chat/loop/探针 + 临时目录。 */
function makeDeps(t, { probe, loopFn, boulder, cwd } = {}) {
  const inertiaDir = makeTmp();
  const workCwd = cwd || makeTmp();
  const opts = {
    inertiaDir,
    cwd: workCwd,
    out: null,
    chat: async () => ({ reply: 'ok' }),
    runProbe: probe || (() => ({ ok: false, exit: 1 })),
    boulder: boulder || { listResumableTasks: () => [], saveBoulderState: () => {} },
  };
  if (loopFn) opts.loopFn = loopFn;
  return { opts, inertiaDir, workCwd };
}

function writePlan(dir, plan) {
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan), 'utf-8');
  return file;
}

function readLedger(runDir) {
  return fs
    .readFileSync(path.join(runDir, 'ledger.jsonl'), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('planHashOf: 键序无关（规范化指纹）', () => {
  assert.strictEqual(planHashOf({ a: 1, b: [1, { c: 2 }] }), planHashOf({ b: [1, { c: 2 }], a: 1 }));
});

test('拒绝启动：schema 非法 fail-closed 且不留半态目录', () => {
  const dir = makeTmp();
  const bad = basePlan();
  delete bad.authorization.tools; // 白名单缺失
  const file = writePlan(dir, bad);
  const { opts, inertiaDir } = makeOptsOnly(dir);
  return runInertialPlan(file, opts).then((env) => {
    assert.strictEqual(env.status, 'rejected');
    assert.strictEqual(env.statusReason, 'plan_schema_invalid');
    assert.ok(env.errors.some((e) => e.field === 'authorization.tools'));
    assert.strictEqual(fs.readdirSync(inertiaDir).length, 0); // 未建 runId 目录
  });

  function makeOptsOnly(d) {
    const o = {
      inertiaDir: makeTmp(),
      cwd: d,
      out: null,
      chat: async () => ({ reply: 'ok' }),
      boulder: { listResumableTasks: () => [], saveBoulderState: () => {} },
    };
    return { opts: o, inertiaDir: o.inertiaDir };
  }
});

test('拒绝启动：同 cwd 已有活跃 ir- run（boulderState task_id 路线）', async () => {
  const dir = makeTmp();
  const file = writePlan(dir, basePlan());
  const calls = [];
  const { opts } = makeDeps(dir, {
    boulder: {
      listResumableTasks: () => [{ taskId: 'ir-20260926-aaaa', cwd: optsCwd, status: 'in_progress' }],
      saveBoulderState: (...a) => calls.push(a),
    },
  });
  const optsCwd = opts.cwd;
  const env = await runInertialPlan(file, opts);
  assert.strictEqual(env.status, 'rejected');
  assert.strictEqual(env.statusReason, 'active_run_exists');
  assert.strictEqual(calls.length, 0); // 拒绝启动 = 不写检查点
});

test('拒绝启动：租约被持有（lease_held）', async () => {
  const dir = makeTmp();
  const { opts, inertiaDir } = makeDeps(dir, { probe: () => ({ ok: true, exit: 0 }) });
  const runId = 'ir-20260926-test01';
  const plan = basePlan({ runId });
  const v = validatePlan(plan);
  assert.strictEqual(v.ok, true);
  const runDir = path.join(inertiaDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'lease.json'),
    JSON.stringify({ runId, expiresAt: Date.now() + 600000 })
  );
  const file = writePlan(dir, plan);
  const env = await runInertialPlan(file, opts);
  assert.strictEqual(env.status, 'rejected');
  assert.strictEqual(env.statusReason, 'lease_held');
});

test('completed：探针命中 → 真停 + 落盘三件套 + 首行 kick 含 planHash', async () => {
  const dir = makeTmp();
  const file = writePlan(dir, basePlan());
  const { opts, inertiaDir } = makeDeps(dir, { probe: () => ({ ok: true, exit: 0 }) });
  const env = await runInertialPlan(file, opts);
  assert.strictEqual(env.status, 'completed');
  assert.strictEqual(env.ok, true);
  assert.strictEqual(env.statusReason, 'completion_probe_green');
  assert.strictEqual(env.outcome.green, true);

  const runDir = path.join(inertiaDir, env.runId);
  // 三件套
  const planOnDisk = JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf-8'));
  const { planHash: _onDiskHash, ...planBody } = planOnDisk;
  assert.strictEqual(planOnDisk.planHash, planHashOf(planBody)); // hash 绑定「去掉 hash 字段后的正文」
  assert.strictEqual(planOnDisk.planHash, env.planHash);
  assert.ok(fs.existsSync(path.join(runDir, 'ledger.jsonl')));
  assert.ok(fs.existsSync(path.join(runDir, 'result.json')));
  // 首行 kick
  const ledger = readLedger(runDir);
  assert.strictEqual(ledger[0].kind, 'kick');
  assert.strictEqual(ledger[0].planHash, env.planHash);
  // 租约释放
  assert.strictEqual(fs.existsSync(path.join(runDir, 'lease.json')), false);
  // 信封形状（§3.7 关键字段）
  assert.strictEqual(env.resume.checkpointTaskId, env.runId);
  assert.ok(typeof env.resume.contextDigest === 'string' && env.resume.contextDigest.length <= 2000);
  assert.ok(env.resume.contextDigest.indexOf('目标：') === 0);
  assert.ok(Array.isArray(env.disclosures));
});

test('budget：探针不绿 + maxTurns 耗尽 → budget(turns)；续推继承 executedCallKeys', async () => {
  const dir = makeTmp();
  const file = writePlan(dir, basePlan({ budget: { maxTurns: 2 } }));
  const seenOpts = [];
  const dedupMap = new Map([['k1', true]]);
  const { opts } = makeDeps(dir, {
    probe: () => ({ ok: false, exit: 1 }),
    loopFn: async (msg, o) => {
      seenOpts.push(o);
      return { finalResponse: 'seg', toolCallLog: [], iterations: 1, tokenUsage: {}, executedCallKeys: dedupMap };
    },
  });
  const env = await runInertialPlan(file, opts);
  assert.strictEqual(env.status, 'budget');
  assert.strictEqual(env.statusReason, 'turns');
  assert.strictEqual(env.stats.turns, 2);
  assert.strictEqual(seenOpts.length, 2); // 两段续推
  assert.strictEqual(seenOpts[0].maxIterations, 2);
  assert.strictEqual(seenOpts[1].inheritedDedupKeys, dedupMap); // Ralph Loop 同源继承
  assert.ok(seenOpts[1] && typeof seenOpts[0].chat === 'function');
  assert.strictEqual(seenOpts[0].chatOpts.cwd, opts.cwd); // cwd 必在 chatOpts（两层入口接线纪律）
  // canResume：探针未绿且剩余预算 0 → false
  assert.strictEqual(env.resume.canResume, false);
  assert.strictEqual(env.resume.remainingBudget.turns, 0);
});

test('decay 影子：收紧 decay 常数后，S1 记录「S2 会在哪停」而不真停', async () => {
  const dir = makeTmp();
  const tightDecay = { noProgressPenalty: 0.5, repeatPenalty: 0.5, denyPenalty: 0.5, errorPenalty: 0.5, progressRestore: 0, stopBelow: 0.5 };
  const file = writePlan(dir, basePlan({ budget: { maxTurns: 3 }, decay: tightDecay }));
  const { opts } = makeDeps(dir, {
    probe: () => ({ ok: false, exit: 1 }), // 探针恒不绿、结果恒不变 → 每段 no_progress（首段除外）
    loopFn: async () => ({ finalResponse: 'seg', toolCallLog: [], iterations: 1, tokenUsage: {} }),
  });
  const env = await runInertialPlan(file, opts);
  // S1 真停仍是 budget（影子不阻断）
  assert.strictEqual(env.status, 'budget');
  assert.strictEqual(env.statusReason, 'turns');
  assert.ok(env.shadow.firstDecayStopSeq !== null, '影子 decay 停机点必须被记录');
  assert.ok(env.shadow.firstDecayMomentum < tightDecay.stopBelow);
  assert.ok(env.disclosures.some((d) => d.indexOf('影子') !== -1));
});

test('ambiguity：AskUserQuestion 观测 → 刹车 + 真停 ambiguity（policy=stop）', async () => {
  const dir = makeTmp();
  const file = writePlan(dir, basePlan({ budget: { maxTurns: 5 } }));
  const { opts } = makeDeps(dir, {
    probe: () => ({ ok: false, exit: 1 }),
    loopFn: async (msg, o) => {
      if (o.onToolCall) o.onToolCall('AskUserQuestion', { questions: [{ question: '选 A 还是 B？' }] });
      return { finalResponse: '', toolCallLog: [], iterations: 1, tokenUsage: {} };
    },
  });
  const env = await runInertialPlan(file, opts);
  assert.strictEqual(env.status, 'ambiguity');
  assert.strictEqual(env.statusReason, 'model_decision_request');
});

test('privilege：硬拒清单命中 → 刹车 + 真停 + 竞态诚实披露', async () => {
  const dir = makeTmp();
  const file = writePlan(dir, basePlan({ budget: { maxTurns: 5 } }));
  const { opts } = makeDeps(dir, {
    probe: () => ({ ok: false, exit: 1 }),
    loopFn: async (msg, o) => {
      if (o.onToolCall) o.onToolCall('Bash', { command: 'git push --force origin main' });
      return { finalResponse: '', toolCallLog: [], iterations: 1, tokenUsage: {} };
    },
  });
  const env = await runInertialPlan(file, opts);
  assert.strictEqual(env.status, 'privilege');
  assert.strictEqual(env.statusReason.indexOf('hard_deny:'), 0);
  assert.ok(env.disclosures.some((d) => d.indexOf('可能已执行一次') !== -1));
});

test('privilege：bash 越权累积达 maxDenies → 真停', async () => {
  const dir = makeTmp();
  const file = writePlan(dir, basePlan({ budget: { maxTurns: 9, maxDenies: 2 } }));
  const { opts } = makeDeps(dir, {
    probe: () => ({ ok: false, exit: 1 }),
    loopFn: async (msg, o) => {
      if (o.onToolCall) o.onToolCall('Bash', { command: 'curl http://x.example' }); // 未命中 allow 白名单（非硬拒）
      return { finalResponse: 'tried', toolCallLog: [], iterations: 1, tokenUsage: {} };
    },
  });
  const env = await runInertialPlan(file, opts);
  assert.strictEqual(env.status, 'privilege');
  assert.strictEqual(env.statusReason, 'deny_budget_exhausted');
  assert.ok(env.disclosures.some((d) => d.indexOf('bash 越权') !== -1));
});

test('error：连续工具错误达阈值 → 真停 error', async () => {
  const dir = makeTmp();
  const file = writePlan(dir, basePlan({ budget: { maxTurns: 9 } }));
  const { opts } = makeDeps(dir, {
    probe: () => ({ ok: false, exit: 1 }),
    loopFn: async (msg, o) => {
      for (let i = 0; i < DEFAULTS.consecutiveErrorsForStop; i++) {
        if (o.onToolCall) o.onToolCall('Read', { file_path: 'x.js' });
        if (o.onToolResult) o.onToolResult('Read', { file_path: 'x.js' }, { success: false, output: 'boom' });
      }
      return { finalResponse: '', toolCallLog: [], iterations: 1, tokenUsage: {} };
    },
  });
  const env = await runInertialPlan(file, opts);
  assert.strictEqual(env.status, 'error');
  assert.strictEqual(env.statusReason.indexOf('consecutive_errors'), 0);
});

test('repeat：同签名重复调用 → repeat 事件进账本（防绕圈子证据）', async () => {
  const dir = makeTmp();
  const file = writePlan(dir, basePlan({ budget: { maxTurns: 1 } }));
  const { opts } = makeDeps(dir, {
    probe: () => ({ ok: false, exit: 1 }),
    loopFn: async (msg, o) => {
      if (o.onToolCall) o.onToolCall('Grep', { pattern: 'foo' });
      if (o.onToolResult) o.onToolResult('Grep', { pattern: 'foo' }, { output: 'aa' });
      if (o.onToolCall) o.onToolCall('Grep', { pattern: 'foo' });
      if (o.onToolResult) o.onToolResult('Grep', { pattern: 'foo' }, { output: 'aa' });
      return { finalResponse: '', toolCallLog: [], iterations: 1, tokenUsage: {} };
    },
  });
  const env = await runInertialPlan(file, opts);
  assert.strictEqual(env.status, 'budget');
  const ledger = readLedger(path.join(opts.inertiaDir, env.runId));
  const momentumEntry = ledger.find((l) => l.kind === 'momentum');
  assert.ok(momentumEntry.events.indexOf('repeat') !== -1, 'repeat 事件应出现在动量账本');
});

test('检查点与 cost：boulder 收到 in_progress/终态两段写入；cost 未知时披露 turns 主闸', async () => {
  const dir = makeTmp();
  const file = writePlan(dir, basePlan({ budget: { maxTurns: 1 } }));
  const saves = [];
  const { opts } = makeDeps(dir, {
    probe: () => ({ ok: false, exit: 1 }),
    loopFn: async () => ({ finalResponse: 'seg', toolCallLog: [{ tool: 'Read' }], iterations: 1, tokenUsage: {} }),
    boulder: {
      listResumableTasks: () => [],
      saveBoulderState: (cwdArg, state) => saves.push({ cwdArg, state }),
    },
  });
  const env = await runInertialPlan(file, opts);
  assert.strictEqual(env.status, 'budget');
  assert.strictEqual(saves.length, 2); // 段末 in_progress + 终态
  assert.strictEqual(saves[0].state.taskId, env.runId);
  assert.strictEqual(saves[0].state.status, 'in_progress');
  assert.ok(['completed', 'interrupted', 'failed'].indexOf(saves[1].state.status) !== -1);
  assert.ok(env.disclosures.some((d) => d.indexOf('cost 未知') !== -1));
});

test('external：租约到期 → external 停', async () => {
  const dir = makeTmp();
  const file = writePlan(dir, basePlan({ leaseMs: 1 }));
  const { opts } = makeDeps(dir, {
    probe: () => ({ ok: false, exit: 1 }),
    loopFn: async () => {
      // 模拟耗时越过租约（leaseMs=1ms）
      return new Promise((resolve) =>
        setTimeout(() => resolve({ finalResponse: '', toolCallLog: [], iterations: 1, tokenUsage: {} }), 15)
      );
    },
  });
  const env = await runInertialPlan(file, opts);
  assert.strictEqual(env.status, 'external');
  assert.strictEqual(env.statusReason, 'lease_expired');
});
