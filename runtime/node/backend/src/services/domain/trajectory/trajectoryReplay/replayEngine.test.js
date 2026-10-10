'use strict';

/**
 * replayEngine.test.js — 钉死确定性回放引擎的门禁面（防呆②④⑤⑥）：bundle 入参三态解析、
 * 环境闸门 refuse/force、NETWORK_AI 永不重放、SHELL 需预批/确认、前置守卫 satisfied/halt 分流、
 * seq 排序与断点续放、onStep 吞异常，以及 AI 修复桥 _maybeRepair 的 null/declined/repaired/halt
 * 四态（哈希仍是唯一裁判）。
 *
 * 真实执行路径（executeTool 漏斗）与网络/AI 供应商无关，不在本测试面内——引擎被设计为门先行、
 * 漏斗最后，这里钉的全部是门禁决策。env 探针列表被 env 钉为不存在工具，保持零 spawn 确定性。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.KHY_REPLAY_FINGERPRINT_TOOLS = '__engine_test_ghost_tool__';

const mod = require('./replayEngine');
const envFingerprint = require('./envFingerprint');
const artifactHash = require('./artifactHash');
const replayStepPolicy = require('./replayStepPolicy');
const replayArtifactGuards = require('./replayArtifactGuards');

const ENV = envFingerprint.capture();

async function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-engine-'));
  try {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'hello');
    return await fn(dir, file, path.join(dir, 'gone.txt'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('导出恰为 7 个符号且重组边界的函数身份与纯叶子完全一致', () => {
  assert.deepStrictEqual(Object.keys(mod).sort(), [
    'DEFAULT_STEP_TIMEOUT_MS',
    '_maybeRepair',
    '_preconditionCheck',
    '_shellAllowList',
    '_shellPreApproved',
    '_verifyArtifacts',
    'replay',
  ]);
  assert.strictEqual(mod.DEFAULT_STEP_TIMEOUT_MS, replayStepPolicy.DEFAULT_STEP_TIMEOUT_MS);
  assert.strictEqual(mod._shellAllowList, replayStepPolicy._shellAllowList);
  assert.strictEqual(mod._preconditionCheck, replayArtifactGuards._preconditionCheck);
  assert.strictEqual(mod._verifyArtifacts, replayArtifactGuards._verifyArtifacts);
});

test('replay 对 null/空对象入参返回 status=error 的完整报告骨架（unrecognized bundle input）', async () => {
  for (const bad of [null, {}, 42, []]) {
    const r = await mod.replay(bad);
    assert.strictEqual(r.status, 'error');
    assert.strictEqual(r.error, 'unrecognized bundle input');
    assert.deepStrictEqual(r.summary, { replayed: 0, skipped: 0, halted: 0, restored: 0, repaired: 0 });
    assert.deepStrictEqual(r.envDiffs, []);
    assert.strictEqual(r.divergedAt, null);
  }
});

test('replay 对字符串入参按包目录读取，缺 manifest 时错误原文透传', async () => {
  const r = await mod.replay('Z:/definitely/not/a/bundle');
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(r.error, 'manifest.json 不存在');
});

test('replay 接受 readBundle 风格 {manifest,bundleDir} 与裸 manifest 两种对象形态', async () => {
  const a = await mod.replay({ manifest: { steps: [], env: ENV }, bundleDir: null }, { force: true });
  assert.strictEqual(a.status, 'completed');
  const b = await mod.replay({ steps: [], env: ENV }, { force: true });
  assert.strictEqual(b.status, 'completed');
});

test('空 steps 包在同环境环境下 completed 且 envDiffs 为空（同进程 capture 必然吻合）', async () => {
  const r = await mod.replay({ steps: [], env: ENV });
  assert.strictEqual(r.status, 'completed');
  assert.deepStrictEqual(r.envDiffs, []);
  assert.deepStrictEqual(r.steps, []);
});

test('防呆⑤ 环境分歧默认拒绝：status=env-mismatch、diffs 列全、零步执行', async () => {
  const badEnv = JSON.parse(JSON.stringify(ENV));
  badEnv.node = 'v0.0.0-phantom';
  const r = await mod.replay(
    { steps: [{ seq: 0, name: 'WebSearch', tier: 'NETWORK_AI' }], env: badEnv },
  );
  assert.strictEqual(r.status, 'env-mismatch');
  assert.deepStrictEqual(r.envDiffs.map((d) => d.field), ['node']);
  assert.strictEqual(r.steps.length, 0);
  // force 才放行
  const forced = await mod.replay(
    { steps: [{ seq: 0, name: 'WebSearch', tier: 'NETWORK_AI' }], env: badEnv },
    { force: true },
  );
  assert.strictEqual(forced.status, 'completed');
  assert.strictEqual(forced.steps.length, 1);
});

test('防呆② NETWORK_AI 步永不重放：skipped 且理由为不可确定性复现', async () => {
  const r = await mod.replay({ steps: [{ seq: 0, name: 'WebSearch', tier: 'NETWORK_AI' }], env: ENV });
  assert.deepStrictEqual(r.steps[0], {
    seq: 0,
    name: 'WebSearch',
    tier: 'NETWORK_AI',
    action: 'skipped',
    verify: null,
    reason: '不可确定性复现（网络/AI）',
  });
  assert.strictEqual(r.summary.skipped, 1);
});

test('防呆④ SHELL 未预批准跳过；confirm 返回假值或抛错都算未批准', async () => {
  const step = { seq: 0, name: 'ShellCommand', tier: 'SHELL', params: { command: 'rm -rf /' } };
  const plain = await mod.replay({ steps: [step], env: ENV });
  assert.strictEqual(plain.steps[0].action, 'skipped');
  assert.strictEqual(plain.steps[0].reason, 'SHELL 未预批准/未确认');
  const denied = await mod.replay({ steps: [step], env: ENV }, { confirm: () => false });
  assert.strictEqual(denied.steps[0].action, 'skipped');
  const boom = await mod.replay({ steps: [step], env: ENV }, { confirm: () => { throw new Error('nope'); } });
  assert.strictEqual(boom.steps[0].action, 'skipped');
});

test('SHELL 预批准命中后穿透审批门抵达前置守卫（理由变为产物状态而非未批准）', () => {
  return fixture((dir, file) => {
    const step = {
      seq: 0,
      name: 'ShellCommand',
      tier: 'SHELL',
      params: { command: 'npm test' },
      artifacts: [{ path: file, op: 'modify', sha256: artifactHash.hashString('hello') }],
    };
    return mod.replay({ steps: [step], env: ENV }, { force: true, preApprovedShell: ['npm*'] }).then((r) => {
      assert.strictEqual(r.steps[0].action, 'skipped');
      assert.strictEqual(r.steps[0].reason, '产物已是目标状态'); // 证明审批门已通过
    });
  });
});

test('FILE 步目标已在录制终态：前置守卫判 satisfied 产物已是目标状态', () => {
  return fixture((dir, file) => {
    return mod.replay(
      { steps: [{ seq: 0, name: 'WriteFile', tier: 'FILE', artifacts: [{ path: file, op: 'modify', sha256: artifactHash.hashString('hello') }] }], env: ENV },
    ).then((r) => {
      assert.strictEqual(r.steps[0].reason, '产物已是目标状态');
      assert.strictEqual(r.summary.skipped, 1);
    });
  });
});

test('防呆③/⑥ 前置分歧立即 HALT：status=diverged、divergedAt=seq、verify 携 expected/actual', () => {
  return fixture((dir, file) => {
    return mod.replay({
      steps: [{
        seq: 0,
        name: 'WriteFile',
        tier: 'FILE',
        artifacts: [{ path: file, op: 'modify', sha256: 'cc' }],
        writeDiff: { beforeHash: 'aa' },
      }],
      env: ENV,
    }).then((r) => {
      assert.strictEqual(r.status, 'diverged');
      assert.strictEqual(r.divergedAt, 0);
      assert.strictEqual(r.summary.halted, 1);
      assert.strictEqual(r.steps[0].action, 'halted');
      assert.strictEqual(r.steps[0].verify.ok, false);
      assert.strictEqual(r.steps[0].verify.expected, 'aa');
      assert.strictEqual(r.steps[0].verify.actual, artifactHash.hashString('hello'));
    });
  });
});

test('步骤按 seq 升序执行且 resumeFromSeq 之前的步整体跳过', async () => {
  const steps = [
    { seq: 5, name: 'WebSearch', tier: 'NETWORK_AI' },
    { seq: 1, name: 'ShellCommand', tier: 'SHELL' },
  ];
  const all = await mod.replay({ steps, env: ENV }, { force: true });
  assert.deepStrictEqual(all.steps.map((s) => s.seq), [1, 5]);
  const resumed = await mod.replay({ steps, env: ENV }, { force: true, resumeFromSeq: 5 });
  assert.deepStrictEqual(resumed.steps.map((s) => s.seq), [5]);
});

test('步缺 tier 字段时按工具名经 tierRegistry 现判档', async () => {
  const r = await mod.replay({ steps: [{ seq: 0, name: 'WebSearch' }], env: ENV });
  assert.strictEqual(r.steps[0].tier, 'NETWORK_AI');
});

test('onStep 每步恰好回调一次，回调抛错被吞不影响报告', async () => {
  let n = 0;
  const r = await mod.replay(
    { steps: [{ seq: 0, name: 'WebSearch', tier: 'NETWORK_AI' }, { seq: 1, name: 'WebFetch', tier: 'NETWORK_AI' }], env: ENV },
    { onStep: () => { n += 1; } },
  );
  assert.strictEqual(n, 2);
  const boom = await mod.replay(
    { steps: [{ seq: 0, name: 'WebSearch', tier: 'NETWORK_AI' }], env: ENV },
    { onStep: () => { throw new Error('listener kap'); } },
  );
  assert.strictEqual(boom.status, 'completed');
});

test('_maybeRepair 零回归门：无钩子/钩子返回 null/declined 三态都回落纯 048 路径（返回 null）', async () => {
  const step = { artifacts: [] };
  assert.strictEqual(await mod._maybeRepair(step, {}, 'x'), null);
  assert.strictEqual(await mod._maybeRepair(step, { repair: () => null }, 'x'), null);
  assert.strictEqual(await mod._maybeRepair(step, { repair: () => ({ attempted: false }) }, 'x'), null);
});

test('_maybeRepair 钩子抛错转 halt 且 reason 携带 repair error 原文', async () => {
  const r = await mod._maybeRepair({ artifacts: [] }, { repair: () => { throw new Error('kap'); } }, 'x');
  assert.deepStrictEqual(r, { decision: 'halt', reason: 'repair error: kap' });
});

test('_maybeRepair 修复后哈希校验通过判 repaired——sha256 仍是唯一裁判', () => {
  return fixture((dir, file, gone) => {
    // delete 目标不存在 ⇒ _verifyArtifacts 天然 ok
    const step = { artifacts: [{ path: gone, op: 'delete' }] };
    return mod._maybeRepair(step, { repair: () => ({ attempted: true }) }, 'x').then((r) => {
      assert.deepStrictEqual(r, { decision: 'repaired' });
    });
  });
});

test('_maybeRepair 修复后哈希仍不符判 halt：默认中文理由加 verify detail，或透传钩子 reason', () => {
  return fixture((dir, file) => {
    const step = { artifacts: [{ path: file, op: 'modify', sha256: 'bogus' }] };
    return Promise.all([
      mod._maybeRepair(step, { repair: () => ({ attempted: true }) }, 'x'),
      mod._maybeRepair(step, { repair: () => ({ attempted: true, reason: 'R' }) }, 'x'),
    ]).then(([a, b]) => {
      assert.strictEqual(a.decision, 'halt');
      assert.strictEqual(a.reason, '产物哈希分歧（修复后仍不一致）');
      assert.strictEqual(a.detail.expected, 'bogus');
      assert.strictEqual(b.reason, 'R');
      assert.strictEqual(b.detail.actual, artifactHash.hashString('hello'));
    });
  });
});
