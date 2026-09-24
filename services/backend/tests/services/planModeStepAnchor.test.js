'use strict';

/**
 * planModeStepAnchor.test.js — 端到端验证「步骤锚点」真的接在**步骤边界**上。
 *
 * 与 stepAnchorStore.test.js 的分工：
 *   - stepAnchorStore.test.js 验**模块自身**（纯逻辑 + 内存 FS 适配器）；
 *   - 本文件验**接线**：跑真实的 executePlanSteps，看它是否在「校验通过」那一刻
 *     落了一份可还原锚点，以及门控关掉时是否**零痕迹 + 行为逐字节不变**。
 *
 * ⚠ 这条测试存在的理由（[IMPL-DOC-001] §12.7）：本仓「能力代码全在、测试全绿、
 *   守卫全绿，但实际从未生效」是已知失效模式。锚点模块单测全绿**不能**证明它被调用，
 *   所以必须有一条走真实调用路径的用例。
 *
 * 用 KHY_STEP_ANCHOR_ROOT 把锚点根指到临时目录 —— 既隔离，也顺带验证了该重定位开关。
 * ⚠ 该环境变量在 **create 与 restore 两处都会被读**，所以必须整段用例都保持设置；
 *   中途还原会让 restore 去找另一个根（这正是本文件第一版踩过的坑）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const planMode = require('../../src/services/planModeService.js');

/** 非 UTF-8 字节：纯文本用例测不出「按 utf8 读写」造成的字节破坏。 */
const ORIGINAL_BYTES = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0a, 0x80, 0x7f, 0x00, 0xc3, 0x28]);

function makeTmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `khy-plananchor-${tag}-`));
}

/**
 * 假的 renderer：只提供 executePlanSteps 真正会碰到的成员。
 * 任何缺失成员都会在这里抛 TypeError（而不是被静默吞掉）。
 */
function makeRenderer() {
  const calls = [];
  class FakeTracker {
    constructor(opts) {
      this.opts = opts;
      this.tasks = [];
    }
    addTask(t) {
      this.tasks.push(t);
    }
    render() {}
    start(i) {
      calls.push(['start', i]);
    }
    complete(i) {
      calls.push(['complete', i]);
    }
    fail(i) {
      calls.push(['fail', i]);
    }
    skip(i) {
      calls.push(['skip', i]);
    }
  }
  return {
    calls,
    TaskPlanTracker: FakeTracker,
    printStepLine: (...a) => calls.push(['line', ...a]),
    printStepDetail: (...a) => calls.push(['detail', ...a]),
  };
}

function makePlan() {
  return {
    steps: [
      {
        id: 1,
        // ⚠ 描述刻意**不含**执行意图关键词（创建/修改/运行/测试/校验…），这样
        // validateStepResult 会短路返回 ok，用例只聚焦「锚点是否被调用」。
        // 同时描述里必须出现文件名，inferStepFileTargets 才推得出目标。
        description: '检查 note.md 的现状',
        status: 'pending',
        stepType: 'general',
      },
    ],
  };
}

/** 跑一次真实的 executePlanSteps（用假 ai/renderer，其余全走真代码）。 */
async function runOnce() {
  const plan = makePlan();
  const renderer = makeRenderer();
  const results = await planMode.executePlanSteps(plan, {
    ai: { chat: async () => ({ reply: '完成', toolSummary: { totalCalls: 1 } }) },
    renderer,
  });
  return { plan, renderer, results };
}

/**
 * 环境隔离 + 清理。**整段用例体**都要包在里面（见文件头说明）。
 */
async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = overrides[k];
    }
  }
  const restore = () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  };
  try {
    return await fn();
  } finally {
    restore();
  }
}

/** 建一个「工作区 + 隔离锚点根」并铺好 note.md。 */
function makeWorkspace(tag) {
  const cwd = makeTmpDir(tag);
  const anchorRoot = path.join(cwd, '..', `${path.basename(cwd)}-anchors`);
  const notePath = path.join(cwd, 'note.md');
  fs.writeFileSync(notePath, ORIGINAL_BYTES);
  return { cwd, anchorRoot, notePath };
}

/** 一组确定的执行环境（关掉人闸门与计划验证段，让用例只测锚点）。 */
function baseEnv(cwd, anchorRoot, anchorGate) {
  return {
    KHYQUANT_CWD: cwd,
    KHY_STEP_ANCHOR: anchorGate,
    KHY_STEP_ANCHOR_ROOT: anchorRoot,
    KHY_HUMAN_GATE: 'off',
    KHY_PLAN_VERIFY: '0',
  };
}

test('门控关（KHY_STEP_ANCHOR=0）→ 零痕迹，且执行结果与门控开时逐字段一致', async () => {
  const { cwd, anchorRoot } = makeWorkspace('off');

  await withEnv(baseEnv(cwd, anchorRoot, '0'), async () => {
    const before = planMode.getLastAnchorRun();

    const off = await runOnce();

    // ① 零痕迹：锚点根根本没被创建（不是「写了再删」）。
    assert.equal(fs.existsSync(anchorRoot), false, '门控关时不应创建锚点根目录');
    // ② 没有记录新的锚点运行（与运行前完全一致）。
    assert.deepEqual(planMode.getLastAnchorRun(), before, '门控关时不应记录锚点运行');
    // ③ 步骤照常完成。
    assert.equal(off.plan.steps[0].status, 'completed');
    assert.equal(off.results.length, 1);
    assert.equal(off.plan.anchorRunId, undefined, '门控关时不应往 plan 上挂 anchorRunId');

    // ④ 门控开跑一次，结果必须逐字段一致（锚点不得改变控制流）。
    process.env.KHY_STEP_ANCHOR = '1';
    const on = await runOnce();
    assert.deepEqual(on.results, off.results, '锚点开关不得改变 executePlanSteps 的返回值');
    assert.equal(on.plan.steps[0].status, off.plan.steps[0].status);
    // 反证：门控开时确实产生了副作用（否则上面的「一致」是空转）。
    assert.ok(fs.existsSync(anchorRoot), '门控开时应创建锚点根目录（反证前一条不空转）');
  });
});

test('门控开 → 步骤完成即在步骤边界落锚点，并登记进 _lastAnchorRun', async () => {
  const { cwd, anchorRoot } = makeWorkspace('on');

  await withEnv(baseEnv(cwd, anchorRoot, '1'), async () => {
    const { plan } = await runOnce();

    const run = planMode.getLastAnchorRun();
    assert.ok(run, '应记录一次锚点运行');
    assert.match(run.runId, /^plan-[0-9a-z]+-[0-9a-z]+$/);
    assert.equal(run.cwd, cwd);
    assert.equal(run.totalSteps, 1);

    assert.equal(run.steps.length, 1, '第 0 步应被锚');
    assert.equal(run.steps[0].stepIndex, 0);
    assert.equal(run.steps[0].ok, true);
    assert.equal(run.steps[0].fileCount, 1);
    assert.equal(run.steps[0].skippedCount, 0);
    assert.equal(run.steps[0].reason, null);

    // runId 落到 plan 上 ⇒ 会被 savePlan/updatePersistedPlan 一并持久化。
    assert.equal(plan.anchorRunId, run.runId);

    // listStepAnchors 能读到同一份（说明磁盘上确实有）。
    const listed = planMode.listStepAnchors();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].stepIndex, 0);
    assert.equal(listed[0].fileCount, 1);

    // 只读面在**真实状态**上必须给出非空摘要（调用方就是无参调用的）。
    const summary = planMode.formatAnchorSummary();
    assert.ok(summary, '跑完一次真实计划后，只读摘要不得为空');
    assert.ok(summary.includes('阶段 S1'), summary);
  });
});

test('还原回第 0 步完成态：内容被改坏后能逐字节还原（sha256 验收为真）', async () => {
  const { cwd, anchorRoot, notePath } = makeWorkspace('restore');

  await withEnv(baseEnv(cwd, anchorRoot, '1'), async () => {
    await runOnce();

    // 「下一步」把文件改坏 —— 这正是用户诉求里「一次很大的改变改坏」的最小复现。
    fs.writeFileSync(notePath, Buffer.from('CORRUPTED-BY-NEXT-STEP', 'utf8'));
    assert.notDeepEqual(fs.readFileSync(notePath), ORIGINAL_BYTES);

    const restored = planMode.restoreToStep(0);
    assert.equal(restored.ok, true, `还原应成功，实际: ${JSON.stringify(restored)}`);
    assert.equal(restored.verified, true, 'sha256 验收应为真');
    assert.deepEqual(restored.mismatches, []);
    assert.deepEqual(restored.restored, ['note.md']);
    // 逐字节相等 —— 不是「看着一样」。
    assert.deepEqual(fs.readFileSync(notePath), ORIGINAL_BYTES);
  });
});

test('dryRun 只算不写：改坏的内容保持改坏', async () => {
  const { cwd, anchorRoot, notePath } = makeWorkspace('dry');

  await withEnv(baseEnv(cwd, anchorRoot, '1'), async () => {
    await runOnce();

    const corrupted = Buffer.from('STILL-CORRUPTED', 'utf8');
    fs.writeFileSync(notePath, corrupted);

    const planned = planMode.restoreToStep(0, { dryRun: true });
    assert.deepEqual(planned.restored, ['note.md']);
    assert.equal(planned.verified, false, 'dryRun 下磁盘仍是被改坏的状态 ⇒ 验收应为假（非恒真）');
    assert.deepEqual(fs.readFileSync(notePath), corrupted, 'dryRun 不得写盘');
  });
});

test('restoreToStep 在无锚点运行时如实返回失败（不静默成功）', async () => {
  await withEnv({}, async () => {
    // 用明确的 run 覆盖，避免依赖模块级状态
    const res = planMode.restoreToStep(0, { run: { runId: 'no-such-run', cwd: os.tmpdir() } });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no-anchor');
    assert.equal(res.verified, false);
  });
});

test('门控开但某步没有任何文件目标 → 不落锚、不报错（零文件不制造噪声）', async () => {
  const cwd = makeTmpDir('nofile');
  const anchorRoot = path.join(cwd, '..', `${path.basename(cwd)}-anchors`);

  await withEnv(baseEnv(cwd, anchorRoot, '1'), async () => {
    const plan = {
      steps: [{ id: 1, description: '检查一下现状', status: 'pending', stepType: 'general' }],
    };
    const results = await planMode.executePlanSteps(plan, {
      ai: { chat: async () => ({ reply: '完成', toolSummary: { totalCalls: 0 } }) },
      renderer: makeRenderer(),
    });

    assert.equal(results.length, 1);
    assert.equal(plan.steps[0].status, 'completed');
    // 运行被记录（说明确实走到了锚点分支），但该步没有条目。
    const run = planMode.getLastAnchorRun();
    assert.ok(run);
    assert.deepEqual(run.steps, []);
    assert.deepEqual(planMode.listStepAnchors(), []);
    // 反证「不落锚」是真的没落，而不是读错了根：运行目录本身也不存在。
    assert.equal(fs.existsSync(path.join(anchorRoot, run.runId)), false);
  });
});

test('文件在 cwd 之外 → 记 skipped，绝不越界快照', async () => {
  const { cwd, anchorRoot } = makeWorkspace('outside');

  await withEnv(baseEnv(cwd, anchorRoot, '1'), async () => {
    // `inferStepFileTargets` 对以 `/` 开头的名字走 `path.resolve(n)` 分支，
    // 会产出**cwd 之外**的目标（Windows 上解析到当前盘根，如 C:\etc\hosts）。
    // 这正是需要被 _normalizeRel 拦下的形态。
    const plan = {
      steps: [
        {
          id: 1,
          description: '检查 note.md 与 /etc/hosts 的现状',
          status: 'pending',
          stepType: 'general',
        },
      ],
    };
    await planMode.executePlanSteps(plan, {
      ai: { chat: async () => ({ reply: '完成', toolSummary: { totalCalls: 1 } }) },
      renderer: makeRenderer(),
    });

    const run = planMode.getLastAnchorRun();
    assert.ok(run);
    assert.equal(run.steps.length, 1);
    assert.equal(run.steps[0].fileCount, 1, 'cwd 内的 note.md 应被锚');
    assert.equal(run.steps[0].skippedCount, 1, 'cwd 外的目标应被记为 skipped（不静默丢）');

    // 还原只动 cwd 内的东西；cwd 之外那份没被快照，也就不会被写回。
    const res = planMode.restoreToStep(0);
    assert.equal(res.verified, true);
    assert.deepEqual(res.restored, ['note.md']);
    assert.equal(res.skipped.length, 0, 'cwd 外目标在建锚时已剔除 ⇒ 还原阶段没有可跳过的动作');
  });
});

test('描述里提到但当时不存在的文件 → 记为 missing，还原时若后来被创建则删除（语义正确）', async () => {
  const { cwd, anchorRoot } = makeWorkspace('phantom');
  const laterPath = path.join(cwd, 'later.md');

  await withEnv(baseEnv(cwd, anchorRoot, '1'), async () => {
    const plan = {
      steps: [
        {
          id: 1,
          // later.md 此刻不存在 ⇒ 锚点应记 missing（「第 1 步完成时它还没有」）。
          description: '检查 note.md 与 later.md 的现状',
          status: 'pending',
          stepType: 'general',
        },
      ],
    };
    await planMode.executePlanSteps(plan, {
      ai: { chat: async () => ({ reply: '完成', toolSummary: { totalCalls: 1 } }) },
      renderer: makeRenderer(),
    });

    const run = planMode.getLastAnchorRun();
    assert.equal(run.steps[0].fileCount, 2, '两个目标都要进锚点（含 missing 的那份）');
    assert.equal(fs.existsSync(laterPath), false);

    // 后续步骤创建了它 —— 退回第 1 步完成态就该把它清掉。
    fs.writeFileSync(laterPath, 'created by a later step');
    const res = planMode.restoreToStep(0);
    assert.equal(res.verified, true);
    assert.deepEqual(res.deleted, ['later.md']);
    assert.equal(fs.existsSync(laterPath), false, '还原到「它还不存在」的那一步 ⇒ 应被删除');
    assert.deepEqual(fs.readFileSync(path.join(cwd, 'note.md')), ORIGINAL_BYTES);
  });
});

// ── 多步计划：把「退回第 N 步完成态」的**真实语义**钉死 ────────────────────
//
// 这条用例存在的理由：单步用例测不出「逐步」这件事。锚点的用途是「一次很大的改变改坏
// 之后退回上一步」，那至少需要 ≥2 步才谈得上。
//
// ⚠ 本用例**曾经**是一条 characterization：它把「第 2 步创建的文件，退回第 1 步时删不掉」
//   这个**已知缺口**写成断言。缺口已按「累积式 manifest」修掉（每步 manifest 覆盖
//   **全计划目标**，而不是本步目标）⇒ 现在钉的是**修复后的语义**：退回第 N 步会同时
//   「写回当时存在的」+「删掉当时还不存在的」。任何回退到按步隔离老语义的漂移都会立刻变红。

/** 3 步计划：每步描述只提到自己的文件，且不含执行意图关键词 ⇒ 校验短路。 */
function makeMultiStepPlan() {
  return {
    steps: [
      { id: 1, description: '检查 a.md 的现状', status: 'pending', stepType: 'general' },
      { id: 2, description: '检查 b.md 的现状', status: 'pending', stepType: 'general' },
      { id: 3, description: '检查 c.md 的现状', status: 'pending', stepType: 'general' },
    ],
  };
}

test('多步计划：每步各锚一份，且还原只动该步目标文件（逐步语义 = 按步隔离，不是全仓回滚）', async () => {
  const cwd = makeTmpDir('multi');
  const anchorRoot = path.join(cwd, '..', path.basename(cwd) + '-anchors');
  const aPath = path.join(cwd, 'a.md');
  const bPath = path.join(cwd, 'b.md');
  const A0 = Buffer.from('A0-original', 'utf8');
  fs.writeFileSync(aPath, A0);
  // b.md 在计划开始前**不存在** —— 由第 2 步「创建」。

  await withEnv(baseEnv(cwd, anchorRoot, '1'), async () => {
    const plan = makeMultiStepPlan();
    // 假 AI：被问到哪个文件就把哪个文件创建出来（模拟「该步写了这个文件」）。
    const ai = {
      chat: async (prompt) => {
        if (prompt.includes('b.md')) fs.writeFileSync(bPath, 'B1-created-at-step-2');
        return { reply: '完成', toolSummary: { totalCalls: 1 } };
      },
    };
    await planMode.executePlanSteps(plan, { ai, renderer: makeRenderer() });

    // ① 三步各锚一份（逐步锚点的基本承诺）。
    const listed = planMode.listStepAnchors();
    assert.deepEqual(
      listed.map((x) => x.stepIndex),
      [0, 1, 2],
      '三步都应各自留下锚点'
    );
    // ⚠ 每份 manifest 覆盖**全计划目标**（a/b/c 三份），而不是「本步目标」——
    //    这正是「退回第 N 步完成态」能名副其实的前提（见 stepAnchorStore.js 文件头）。
    const run = planMode.getLastAnchorRun();
    assert.equal(run.planFileCount, 3, '全计划目标集应在开工时一次算全');
    assert.deepEqual(
      run.steps.map((s) => s.fileCount),
      [3, 3, 3],
      '每步 manifest 都覆盖全计划目标（累积式，不是按步隔离）'
    );
    assert.deepEqual(
      listed.map((x) => x.fileCount),
      [3, 3, 3],
      '磁盘上的 manifest 与内存台账必须一致'
    );

    // ② 第 3 步「把前两步的结果改坏」（用户诉求里的最小复现场景）。
    const aCorrupted = Buffer.from('A0-DESTROYED-BY-STEP-3', 'utf8');
    fs.writeFileSync(aPath, aCorrupted);
    fs.writeFileSync(bPath, 'B1-DESTROYED-BY-STEP-3');

    // ③ 退回第 1 步完成态：a.md 逐字节复原。
    //    同时铺一个**计划外**文件：它不在 manifest 里 ⇒ 还原不得碰它（这不是全仓回滚）。
    const unrelatedPath = path.join(cwd, 'unrelated.md');
    fs.writeFileSync(unrelatedPath, 'not-a-plan-target');

    const r1 = planMode.restoreToStep(0);
    assert.equal(r1.verified, true, `还原应逐字节验收通过，实际: ${JSON.stringify(r1)}`);
    assert.deepEqual(r1.restored, ['a.md']);
    assert.deepEqual(fs.readFileSync(aPath), A0, 'a.md 应逐字节回到第 1 步完成态');

    // ④ 「退回第 1 步完成态」的**完整**语义：当时还不存在的文件必须被删掉。
    //    b.md 由第 2 步创建 ⇒ 第 1 步完成时它不存在 ⇒ 退回第 1 步就该让它消失。
    //    （c.md 从未被创建 ⇒ 删除是幂等的，但它同样应出现在 deleted 里。）
    assert.deepEqual(r1.deleted, ['b.md', 'c.md'], '当时不存在的目标应被删回「不存在」');
    assert.equal(fs.existsSync(bPath), false, 'b.md 由第 2 步创建 ⇒ 退回第 1 步应被删除');
    assert.equal(fs.existsSync(path.join(cwd, 'c.md')), false);

    // ⑤ 还原只动**计划目标**，不做全仓回滚。
    assert.equal(
      fs.readFileSync(unrelatedPath, 'utf8'),
      'not-a-plan-target',
      '计划外文件不在 manifest 里 ⇒ 还原不得碰它'
    );

    // ⑥ 退回第 2 步完成态 → b.md 复原（该步完成时它已存在，内容被存进 blob）。
    const r2 = planMode.restoreToStep(1);
    assert.equal(r2.verified, true);
    assert.equal(fs.readFileSync(bPath, 'utf8'), 'B1-created-at-step-2');

    // ⑦ 台账里应能看到三次建锚 + 两次还原。
    const ledger = fs.readFileSync(path.join(anchorRoot, run.runId, 'ledger.jsonl'), 'utf8');
    assert.equal((ledger.match(/"event":"anchor-created"/g) || []).length, 3, '三次 anchor-created');
    assert.equal((ledger.match(/"event":"restore-applied"/g) || []).length, 2, '两次 restore-applied');

    // ⑧ blob 是**运行级内容寻址**（`blobs/<sha256>.bin`）⇒ 同一内容跨步只落一份。
    //    这是累积式 manifest 能负担得起的前提：否则落盘量是 O(步数 × 文件数)。
    //    本计划里「不同内容」只有两份：A0（a.md）与 'B1-created-at-step-2'（b.md）；
    //    c.md 全程 missing ⇒ 没有 blob。
    const blobs = fs.readdirSync(path.join(anchorRoot, run.runId, 'blobs'));
    assert.equal(blobs.length, 2, `内容寻址应去重（期望 2 份 blob，实测 ${blobs.join(', ')}）`);
    for (const b of blobs) {
      assert.match(b, /^[0-9a-f]{64}\.bin$/, 'blob 名必须是 sha256 内容寻址');
    }
  });
});

// ── 只读面：一行摘要（S1 观察者的用户可见面）───────────────────────────────
//
// 用户诉求里的「够不到」指的是：锚点在磁盘上、但没有**任何地方**能看见它。
// 只读面就是那个「看得见」。它必须同时满足两件事：
//   ① 无可报内容时**不打印**（不制造噪声）；
//   ② 只报**事实**，不承诺能力 —— S1 阶段没有把 restoreToStep 接到任何用户入口，
//      写「可退回」就是一句没有判据的声称（本仓已有这一族失真）。

test('formatAnchorSummary：无可报内容返回 null；有锚点时只给可核对的事实、不声称还原能力', () => {
  // ① 没有任何运行信息 → null。
  assert.equal(planMode.formatAnchorSummary({ run: null, env: {} }), null);

  // ② 有运行但一个锚点都没落（例如计划没有文件目标）→ 仍然 null。
  assert.equal(
    planMode.formatAnchorSummary({ run: { runId: 'r', planFileCount: 0, steps: [] }, env: {} }),
    null
  );
  assert.equal(
    planMode.formatAnchorSummary({
      run: { runId: 'r', planFileCount: 2, steps: [{ stepIndex: 0, ok: false }] },
      env: {},
    }),
    null,
    '建锚失败的步骤不该被算进摘要'
  );

  // ③ 正常情况：一行内给出「几份 / 哪几步 / 覆盖几个文件 / runId / 阶段」。
  const line = planMode.formatAnchorSummary({
    run: {
      runId: 'plan-abc-123',
      planFileCount: 3,
      steps: [
        { stepIndex: 0, ok: true },
        { stepIndex: 1, ok: true },
        { stepIndex: 2, ok: true },
      ],
    },
    env: {},
  });
  assert.ok(line, '有锚点时必须给出摘要');
  assert.ok(line.includes('已保存 3 份'), line);
  // 步号按 **1 基**展示给用户（内部是 0 基，用户看到「第 0 步」会困惑）。
  // ⚠ 用 \u2013 转义而不是直接写连接号：断言里出现裸全角标点容易被工具链改写。
  assert.ok(line.includes('第 1\u20133 步'), line);
  assert.ok(line.includes('覆盖 3 个计划目标文件'), line);
  assert.ok(line.includes('run plan-abc-123'), line);
  assert.ok(line.includes('阶段 S1'), line);
  // ⚠ 反向钉死一个**同名撞车**：本模块另有一个 `getStage()`（三阶段控制，返回
  //    'plan'/'execute'/…），与锚点机制的 S1/S2/S3 毫无关系。混用会让用户看到
  //    「阶段 plan」。这个坑实测踩到过一次，所以在这里显式拦住。
  assert.ok(!line.includes('阶段 plan'), `不得把三阶段控制的 stage 混进来：${line}`);
  assert.ok(
    !/可退回|已回退|已还原|可还原/.test(line),
    `S1 只读面不得声称还原能力（没有任何用户入口能触发它）：${line}`
  );

  // ④ 单步计划不写成「第 1–1 步」。
  const one = planMode.formatAnchorSummary({
    run: { runId: 'r', planFileCount: 1, steps: [{ stepIndex: 0, ok: true }] },
    env: {},
  });
  assert.ok(one.includes('第 1 步'), one);
  assert.ok(!one.includes('第 1\u20131 步'), one);

  // ⑤ 阶段从 env 派生 —— 显式升阶后摘要必须如实反映（否则它就成了装饰）。
  const s2 = planMode.formatAnchorSummary({
    run: { runId: 'r', planFileCount: 1, steps: [{ stepIndex: 0, ok: true }] },
    env: { KHY_STEP_ANCHOR_STAGE: 'S2' },
  });
  assert.ok(s2.includes('阶段 S2'), s2);
});

// ── 只读面的**接线**（判定面 = 源码文本，非运行时行为）──────────────────────
//
// ⚠ 这条断言**弱**，必须如实标注：它只证明「调用点还在」，不证明「运行时真会执行到」。
//   本仓的失效模式恰恰是「能力代码全在、测试全绿、守卫全绿，但实际从未生效」，
//   而那种失效用文本扫描**抓不到**。之所以还是留着它：删掉调用点是最可能发生、
//   也最容易被漏掉的一次回归，而跑通整条 TUI 渲染链的代价远超这一步的收益。
//   ⇒ 真正的行为验收在 §12.7.5「验证状态」里标注为「仅主张（读代码路径）」。

test('只读面接线：TUI 与 readline 两条计划执行路径都必须调用 formatAnchorSummary', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const surfaces = [
    ['TUI（默认路径）', path.join(repoRoot, 'services/backend/src/cli/tui/ink-components/App.js')],
    ['readline REPL', path.join(repoRoot, 'services/backend/src/cli/replSession.js')],
  ];
  for (const [name, file] of surfaces) {
    assert.ok(fs.existsSync(file), `${name} 路径不存在（文件被挪走了？）：${file}`);
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, /formatAnchorSummary\(\)/, `${name} 必须调用只读面投影`);
    assert.match(
      src,
      /if \(anchorLine\)/,
      `${name} 必须对 null 做守卫 —— 无可报内容时**不打印**，否则会往转录里塞空行噪声`
    );
  }
});
