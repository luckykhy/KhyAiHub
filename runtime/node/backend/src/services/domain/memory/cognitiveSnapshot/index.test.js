'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CognitiveContextEngine, snapshotManager, compressionEngine, workbench } = require('./index.js');

const DATA_HOME = require.resolve('../../../../utils/dataHome.js');
let tmpRoot = '';
let savedDataHome = null;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b45e-'));
  savedDataHome = require.cache[DATA_HOME];
  // Both snapshotManager and offloadStore resolve their bucket through dataHome at
  // call time, so one stub keeps every write inside the tmp dir.
  require.cache[DATA_HOME] = {
    id: DATA_HOME,
    filename: DATA_HOME,
    loaded: true,
    exports: { getProjectDataDir: (...segs) => path.join(tmpRoot, ...segs) },
  };
});

after(() => {
  if (savedDataHome) require.cache[DATA_HOME] = savedDataHome;
  else delete require.cache[DATA_HOME];
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const est = (t) => Math.ceil(String(t || '').length / 4);
let seq = 0;
const freshId = () => `eng-${Date.now()}-${seq++}`;

function makeEngine(over = {}) {
  return new CognitiveContextEngine({
    taskId: freshId(),
    ultimateGoal: '把长链路任务跑完',
    estimateTokensFn: est,
    ...over,
  });
}

const stepsOf = (n) =>
  Array.from({ length: n }, (_, i) => ({
    step: i + 1,
    intent: `第 ${i + 1} 步`,
    tool: 'read',
    params: { p: i },
    result: `结果 ${i}`.repeat(6),
  }));

describe('构造与状态初始化', () => {
  test('缺 taskId 或 ultimateGoal 直接抛——指南针不可空', () => {
    assert.throws(() => new CognitiveContextEngine(), /taskId 必填/);
    assert.throws(() => new CognitiveContextEngine({ taskId: 't' }), /ultimateGoal 必填/);
    assert.throws(() => new CognitiveContextEngine({ ultimateGoal: 'g' }), /taskId 必填/);
    assert.throws(() => new CognitiveContextEngine(null), TypeError);
  });

  test('零值 taskId / ultimateGoal 被 falsy 判定拒掉，字符串化后本可用', () => {
    assert.throws(() => new CognitiveContextEngine({ taskId: 0, ultimateGoal: 'g' }), /taskId 必填/);
    assert.equal(new CognitiveContextEngine({ taskId: '0', ultimateGoal: '0' }).taskId, '0');
  });

  test('初始状态：step 0 / retryCount 0 / 空指针集，taskId 与 goal 被字符串化', () => {
    const e = makeEngine({ taskId: 42, ultimateGoal: 7 });
    assert.equal(e.taskId, '42');
    assert.equal(e.ultimateGoal, '7');
    assert.equal(e.step, 0);
    assert.equal(e.retryCount, 0);
    assert.deepEqual(e.offloadPointers, []);
    assert.equal(e.model, undefined);
    assert.equal(e.workspace, undefined);
  });

  test('窗口取注入值并夹到下限 1，缺省回落到 131072 的默认窗', () => {
    assert.equal(makeEngine({ contextWindowTokens: 8000 }).window, 8000);
    assert.equal(makeEngine({ contextWindowTokens: 0 }).window, 131072);
    assert.equal(makeEngine({ contextWindowTokens: -5 }).window, 1);
    assert.equal(makeEngine({ contextWindowTokens: 'abc' }).window, 131072);
    assert.equal(makeEngine({ contextWindowTokens: '4096' }).window, 4096);
    assert.equal(makeEngine({ contextWindowTokens: 0.4 }).window, 1);
  });

  test('缺省估算器来自 contextWasm 真源，注入估算器优先', () => {
    const e = new CognitiveContextEngine({ taskId: 't', ultimateGoal: 'g' });
    assert.equal(e.estimate('hello world'), require('../../../contextWasm').estimateTokens('hello world'));
    assert.equal(makeEngine().estimate('hello world'), 3);
  });

  test('门面对象同时导出四个协作模块与 workbench', () => {
    const mod = require('./index.js');
    assert.equal(mod.snapshotManager, snapshotManager);
    assert.equal(mod.compressionEngine, compressionEngine);
    assert.equal(mod.workbench, workbench);
    assert.equal(typeof mod.offloadStore.offload, 'function');
    assert.equal(typeof mod.overflowInterceptor.preflight, 'function');
  });
});

describe('usageRatio / planStep', () => {
  test('占用率按窗口折算，负值与垃圾输入夹到 0', () => {
    const e = makeEngine({ contextWindowTokens: 1000 });
    assert.equal(e.usageRatio(500), 0.5);
    assert.equal(e.usageRatio(2000), 2);
    assert.equal(e.usageRatio(-100), 0);
    assert.equal(e.usageRatio('250'), 0.25);
    for (const junk of [null, undefined, NaN, 'abc', {}, []]) {
      assert.equal(e.usageRatio(junk), 0, JSON.stringify(junk));
    }
  });

  test('planStep 按占用率选策略：L0 proceed，L1/L2 compress，L3 offload', () => {
    const e = makeEngine({ contextWindowTokens: 1000 });
    assert.deepEqual(e.planStep({ usedTokens: 100 }), {
      remaining: 900,
      estimatedStepCost: 0,
      strategy: 'proceed',
      ratio: 0.1,
      level: 'L0',
    });
    assert.equal(e.planStep({ usedTokens: 600 }).strategy, 'compress');
    assert.equal(e.planStep({ usedTokens: 800 }).strategy, 'compress');
    assert.equal(e.planStep({ usedTokens: 950 }).strategy, 'offload');
    assert.equal(e.planStep({ usedTokens: 950 }).level, 'L3');
  });

  test('planStep 缺省入参给全窗口预算，超用被夹到 0 剩余', () => {
    const e = makeEngine({ contextWindowTokens: 1000 });
    assert.equal(e.planStep().remaining, 1000);
    assert.equal(e.planStep().level, 'L0');
    assert.equal(e.planStep({ usedTokens: 5000 }).remaining, 0);
    assert.equal(e.planStep({ usedTokens: 5000 }).ratio, 5);
  });

  test('KNOWN-DEFECT: planStep 原样透传未折算的预估串，自产的预算规划反被防呆⑤ 阻断', () => {
    // index.js:77 coerces usedTokens through subtraction and :78 through usageRatio,
    // but :86 stores `estimatedStepTokens` verbatim. requireBudgetPlan
    // (overflowInterceptor.js:40) demands Number.isFinite(plan.estimatedStepCost), so a
    // caller that passes "50" — the shape that arrives from env/JSON/CLI — gets its own
    // default plan rejected while remaining/ratio are perfectly usable numbers.
    const e = makeEngine({ contextWindowTokens: 1000 });
    const p = e.planStep({ usedTokens: '400', estimatedStepTokens: '50' });
    assert.equal(p.ratio, 0.4);
    assert.equal(p.remaining, 600);
    assert.equal(p.estimatedStepCost, '50');
    const gate = e.beforeStep({ usedTokens: '400', estimatedStepTokens: '50' });
    assert.equal(gate.allow, false);
    assert.equal(gate.action, 'block');
    assert.match(gate.reason, /missing estimatedStepCost/);
  });
});

describe('beforeStep 前置闸门', () => {
  test('预算充足放行，越 80% 上限阻断并给出动作', () => {
    const e = makeEngine({ contextWindowTokens: 1000 });
    const ok = e.beforeStep({ usedTokens: 300, estimatedStepTokens: 100 });
    assert.equal(ok.allow, true);
    assert.equal(ok.action, 'proceed');
    const over = e.beforeStep({ usedTokens: 700, estimatedStepTokens: 300 });
    assert.equal(over.allow, false);
    assert.equal(over.action, 'compress');
    const noRoom = e.beforeStep({ usedTokens: 700, estimatedStepTokens: 300, canCompress: false });
    assert.equal(noRoom.action, 'offload');
  });

  test('自带 budgetPlan 覆盖默认规划，缺字段的自带规划照样被阻断', () => {
    const e = makeEngine({ contextWindowTokens: 1000 });
    const custom = e.beforeStep({ usedTokens: 300, budgetPlan: { remaining: 100, estimatedStepCost: 1, strategy: 'proceed' } });
    assert.equal(custom.allow, true);
    assert.equal(custom.ratio, 0.3);
    const overridden = e.beforeStep({ usedTokens: 900, budgetPlan: { remaining: 100, estimatedStepCost: 5000, strategy: 'proceed' } });
    assert.equal(overridden.allow, false);
    assert.equal(overridden.ratio, 0.9);
    const broken = e.beforeStep({ usedTokens: 100, budgetPlan: { remaining: 1 } });
    assert.equal(broken.action, 'block');
    assert.match(broken.reason, /防呆⑤/);
  });
});

describe('commitStep 一步闭环', () => {
  test('低占用步：L0 级别、快照落盘、valid=true、无卸载', () => {
    const e = makeEngine({ contextWindowTokens: 1000 });
    const r = e.commitStep({ steps: stepsOf(2), usedTokens: 100, nextInstruction: '继续第 3 步' });
    assert.equal(r.valid, true, String(r.error));
    assert.equal(r.level, 'L0');
    assert.equal(r.offloaded, 0);
    assert.equal(r.snapshot.taskId, e.taskId);
    assert.equal(r.snapshot.step, 2);
    assert.equal(r.snapshot.nextInstruction, '继续第 3 步');
    assert.equal(r.snapshot.ultimateGoal, '把长链路任务跑完');
    const onDisk = snapshotManager.load(e.taskId);
    assert.equal(onDisk.step, 2);
    assert.equal(onDisk.status, 'active');
    assert.equal(fs.existsSync(path.join(tmpRoot, 'cognitive_snapshots', `${e.taskId}.json`)), true);
  });

  test('步号推进：无步骤记录时自增，有记录时取末条 step', () => {
    const e = makeEngine();
    assert.equal(e.commitStep({}).snapshot.step, 1);
    assert.equal(e.commitStep({ steps: [{ step: 5 }, { step: 9 }] }).snapshot.step, 9);
    assert.equal(e.commitStep({ steps: [{ step: 0 }] }).snapshot.step, 0);
    assert.equal(e.step, 0);
    assert.equal(e.commitStep({ steps: [{}] }).snapshot.step, 1);
  });

  test('L3 时冷数据真落盘，指针回填进 history 槽位并计入 offloadPointers', () => {
    const e = makeEngine({ contextWindowTokens: 1000 });
    const r = e.commitStep({ steps: stepsOf(6), usedTokens: 950, nextInstruction: 'x' });
    assert.equal(r.level, 'L3');
    assert.equal(r.offloaded, 2);
    assert.equal(e.offloadPointers.length, 2);
    const slots = r.snapshot.compressedHistory.filter((h) => h.offloaded);
    assert.equal(slots.length, 2);
    assert.equal(slots.every((s) => typeof s.ref === 'string' && s.ref.startsWith('<offloaded ref=')), true);
    const coldFiles = fs.readdirSync(path.join(tmpRoot, 'cognitive_snapshots', 'offload', e.taskId));
    assert.equal(coldFiles.length, 2);
    // 指针可回读：卸载出去的折叠记录确实还在盘上
    const back = require('./offloadStore.js').load(slots[0].ref);
    assert.equal(back.level, 'L1');
  });

  test('offloadCold=false 时只留空占位，不落盘也不推指针', () => {
    const e = makeEngine({ contextWindowTokens: 1000 });
    const r = e.commitStep({ steps: stepsOf(6), usedTokens: 950, offloadCold: false });
    assert.equal(r.offloaded, 0);
    assert.deepEqual(e.offloadPointers, []);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'cognitive_snapshots', 'offload', e.taskId)), false);
    assert.equal(
      r.snapshot.compressedHistory.filter((h) => h.offloaded).every((h) => h.ref === null),
      true
    );
  });

  test('retryCount / model / workspace 随快照入库', () => {
    const e = makeEngine({ model: 'glm-4.6', workspace: 'D:/proj' });
    e.bumpRetry();
    e.bumpRetry();
    const r = e.commitStep({ steps: stepsOf(1), usedTokens: 0 });
    assert.equal(r.snapshot.retryCount, 2);
    assert.equal(r.snapshot.constraints.model, 'glm-4.6');
    assert.equal(r.snapshot.constraints.workspace, 'D:/proj');
  });

  test('非数组 steps 当空历史处理，不抛', () => {
    const e = makeEngine();
    for (const junk of [null, 'x', {}, 0, NaN]) {
      const r = e.commitStep({ steps: junk, usedTokens: 10 });
      assert.equal(r.valid, true, String(r.error));
      assert.deepEqual(r.snapshot.compressedHistory, []);
    }
  });

  test('防呆②：落盘失败即 valid=false 且不带 snapshot，error 上报', () => {
    const e = makeEngine({ contextWindowTokens: 1000 });
    fs.mkdirSync(path.join(tmpRoot, 'cognitive_snapshots'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'cognitive_snapshots', `${e.taskId}.json`), { recursive: true });
    const r = e.commitStep({ steps: stepsOf(1), usedTokens: 0 });
    assert.equal(r.valid, false);
    assert.equal(r.snapshot, undefined);
    assert.equal(typeof r.error, 'string');
    assert.equal(r.level, 'L0');
    assert.equal(r.retainedRatio > 0, true);
  });

  test('KNOWN-DEFECT: 快照与引擎共享同一个 offloadPointers 数组，消费方改写写穿真源', () => {
    // index.js:145 hands `this.offloadPointers` straight into snapshotManager.build,
    // which keeps the reference (snapshotManager.js:76). A caller that trims or pushes
    // on the returned snapshot mutates the live engine state, so the pointers written
    // to disk on the next commit are no longer what the engine actually offloaded.
    const e = makeEngine({ contextWindowTokens: 1000 });
    const r = e.commitStep({ steps: stepsOf(6), usedTokens: 950 });
    assert.equal(r.snapshot.offloadPointers === e.offloadPointers, true);
    r.snapshot.offloadPointers.length = 0;
    assert.equal(e.offloadPointers.length, 0);
    const next = e.commitStep({ steps: stepsOf(6), usedTokens: 950 });
    assert.equal(next.snapshot.offloadPointers.length, 2);
    assert.equal(snapshotManager.load(e.taskId).offloadPointers.length, 2);
  });

  test('KNOWN-DEFECT: 重复 step 号时第二条卸载指针永远回不来（槽位被 find 复用）', () => {
    // index.js:132 finds the slot with `h.offloaded && h.step === cand.step`, so two
    // cold candidates sharing a step number both resolve to the first slot: the second
    // pointer overwrites the first one there, the sibling slot keeps ref=null, and one
    // already-evicted record has no reachable address in the snapshot at all.
    const dup = Array.from({ length: 6 }, (_, i) => ({
      step: 1,
      intent: `重复 ${i}`,
      tool: 'read',
      result: String.fromCharCode(65 + i).repeat(30),
    }));
    const e = makeEngine({ contextWindowTokens: 1000 });
    const r = e.commitStep({ steps: dup, usedTokens: 950 });
    assert.equal(r.offloaded, 2);
    const slots = r.snapshot.compressedHistory.filter((h) => h.offloaded);
    assert.equal(slots.filter((s) => s.ref === null).length, 1);
    assert.equal(new Set(slots.map((s) => s.ref)).size, 2);
    const written = fs.readdirSync(path.join(tmpRoot, 'cognitive_snapshots', 'offload', e.taskId));
    assert.equal(written.length, 2);
  });

  test('KNOWN-DEFECT: 步号取自末条记录的 step 字段，与压缩级别解耦，乱序历史会倒退步号', () => {
    // index.js:117 `steps[steps.length - 1].step ?? steps.length` trusts the caller's
    // ordering, so an out-of-order history rewinds the snapshot's authoritative step
    // (and hotStart resumes from an earlier point than actually completed).
    const e = makeEngine({ contextWindowTokens: 1000 });
    e.commitStep({ steps: [{ step: 9, intent: 'a', result: 'b' }] });
    const back = e.commitStep({ steps: [{ step: 9 }, { step: 2 }] });
    assert.equal(back.snapshot.step, 2);
    assert.equal(e.step, 2);
  });
});

describe('热启与完成标记', () => {
  test('complete 后 hotStart 不再接力，markComplete 刷新盘上状态', () => {
    const e = makeEngine({ contextWindowTokens: 1000 });
    e.commitStep({ steps: stepsOf(1), usedTokens: 0, nextInstruction: '下一步' });
    const done = e.complete();
    assert.equal(done.ok, true, String(done.error));
    const hs = e.hotStart();
    assert.equal(hs.found, true);
    assert.equal(hs.resumable, false);
    assert.equal(hs.reason, 'task already done');
    assert.equal(snapshotManager.load(e.taskId).status, 'done');
  });

  test('未完成时 hotStart 给出注入提示，静态入口同样可用', () => {
    const e = makeEngine({ contextWindowTokens: 1000 });
    e.commitStep({ steps: stepsOf(3), usedTokens: 0, nextInstruction: '接着做第 4 步' });
    const hs = e.hotStart();
    assert.equal(hs.resumable, true);
    assert.match(hs.injectionPrompt, /接着做第 4 步/);
    assert.equal(CognitiveContextEngine.hotStart(e.taskId).snapshot.step, 3);
    assert.deepEqual(CognitiveContextEngine.hotStart('no-such-task'), {
      found: false,
      resumable: false,
      reason: 'no snapshot',
    });
  });

  test('complete 在没有快照时结构化失败', () => {
    const e = makeEngine({ taskId: 'never-committed' });
    assert.deepEqual(e.complete(), { ok: false, error: 'not found' });
  });

  test('onTruncation 产出 EMERGENCY 快照并落盘', () => {
    const e = makeEngine({ contextWindowTokens: 1000 });
    e.bumpRetry();
    const r = e.onTruncation(stepsOf(4), '从截断处恢复');
    assert.equal(r.ok, true, String(r.error));
    assert.equal(r.snapshot.status, 'emergency');
    assert.equal(r.snapshot.retryCount, 1);
    assert.match(r.snapshot.nextInstruction, /从截断处恢复/);
    assert.equal(fs.existsSync(r.file), true);
    const empty = makeEngine().onTruncation();
    assert.equal(empty.ok, true, String(empty.error));
    assert.deepEqual(empty.snapshot.compressedHistory, []);
  });

  test('onTruncation 也共享引擎的指针集，写穿到紧急快照', () => {
    // index.js:179 passes this.offloadPointers by reference into the emergency path too.
    const e = makeEngine({ contextWindowTokens: 1000 });
    e.commitStep({ steps: stepsOf(6), usedTokens: 950 });
    const r = e.onTruncation(stepsOf(6), '熔断继续');
    assert.equal(r.snapshot.offloadPointers === e.offloadPointers, true);
    assert.equal(r.snapshot.offloadPointers.length, 2);
  });
});
