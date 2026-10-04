'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const oi = require('./overflowInterceptor.js');

const { BUDGET_CEIL_RATIO, ACTIONS, requireBudgetPlan, preflight, isTruncationError, emergencySnapshot } = oi;

// Every persist path is redirected into a throwaway tmp dir: this suite must never
// touch the repo or the real ~/.khy bucket.
const DATA_HOME = require.resolve('../../../../utils/dataHome.js');
let tmpRoot = '';
let savedDataHome = null;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b45e-'));
  savedDataHome = require.cache[DATA_HOME];
  require.cache[DATA_HOME] = {
    id: DATA_HOME,
    filename: DATA_HOME,
    loaded: true,
    exports: { getProjectDataDir: () => tmpRoot },
  };
});

after(() => {
  if (savedDataHome) require.cache[DATA_HOME] = savedDataHome;
  else delete require.cache[DATA_HOME];
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const goodPlan = () => ({ remaining: 400, estimatedStepCost: 100, strategy: 'proceed' });

describe('requireBudgetPlan 防呆⑤', () => {
  test('三字段齐备的规划判为合规，missing 为空数组', () => {
    assert.deepEqual(requireBudgetPlan(goodPlan()), { valid: true, missing: [] });
  });

  test('null / undefined / 非对象 / 数组一律缺全部三字段', () => {
    const all = { valid: false, missing: ['remaining', 'estimatedStepCost', 'strategy'] };
    for (const junk of [null, undefined, 0, -1, NaN, '', 'plan', [], {}, 1e21]) {
      assert.deepEqual(requireBudgetPlan(junk), all, JSON.stringify(junk));
    }
  });

  test('逐字段报缺：remaining 与 estimatedStepCost 只认有限数字，strategy 只认真值', () => {
    assert.deepEqual(requireBudgetPlan({ remaining: 1, estimatedStepCost: 2 }), {
      valid: false,
      missing: ['strategy'],
    });
    assert.deepEqual(requireBudgetPlan({ strategy: 'compress' }), {
      valid: false,
      missing: ['remaining', 'estimatedStepCost'],
    });
    assert.deepEqual(requireBudgetPlan({ remaining: NaN, estimatedStepCost: Infinity, strategy: '' }), {
      valid: false,
      missing: ['remaining', 'estimatedStepCost', 'strategy'],
    });
    // 0 是合法的「剩余为零」，strategy 非空即可
    assert.deepEqual(requireBudgetPlan({ remaining: 0, estimatedStepCost: 0, strategy: 'offload' }), {
      valid: true,
      missing: [],
    });
  });

  test('KNOWN-DEFECT: 字符串数字被 Number.isFinite 拒绝，携带预算却被判完全缺失', () => {
    // overflowInterceptor.js:37-42 uses Number.isFinite(plan.remaining) with no Number()
    // coercion, while preflight (overflowInterceptor.js:61-63) does coerce its numeric
    // inputs. A budget plan deserialized from JSON/env as "400" is therefore reported
    // as having no plan at all and the step gets blocked.
    assert.deepEqual(requireBudgetPlan({ remaining: '400', estimatedStepCost: '100', strategy: 'proceed' }), {
      valid: false,
      missing: ['remaining', 'estimatedStepCost'],
    });
  });

  test('KNOWN-DEFECT: 字段存在性检查走原型链，继承来的预算字段被当作自带', () => {
    // overflowInterceptor.js:37-42 reads plan.remaining directly, so a plan object
    // built with Object.create carries its numbers from the prototype.
    const inherited = Object.create({ remaining: 10, estimatedStepCost: 5, strategy: 'proceed' });
    assert.deepEqual(requireBudgetPlan(inherited), { valid: true, missing: [] });
    assert.deepEqual(Object.keys(inherited), []);
  });

  test('对象带 constructor / __proto__ / toString 键时判定不受影响也不抛', () => {
    const weird = { remaining: 1, estimatedStepCost: 2, strategy: 'x', constructor: 1, toString: 1 };
    assert.deepEqual(requireBudgetPlan(weird), { valid: true, missing: [] });
    assert.deepEqual(requireBudgetPlan(JSON.parse('{"__proto__":{"remaining":1}}')), {
      valid: false,
      missing: ['remaining', 'estimatedStepCost', 'strategy'],
    });
  });
});

describe('preflight 前置熔断', () => {
  test('80% 上限恰好命中仍放行，越一分即阻断转压缩', () => {
    const atCeil = preflight({ usedTokens: 800, estimatedStepTokens: 0, windowTokens: 1000, budgetPlan: goodPlan() });
    assert.equal(atCeil.allow, true);
    assert.equal(atCeil.action, ACTIONS.PROCEED);
    assert.equal(atCeil.ceil, 800);
    assert.equal(atCeil.ratio, 0.8);

    const over = preflight({ usedTokens: 800, estimatedStepTokens: 1, windowTokens: 1000, budgetPlan: goodPlan() });
    assert.equal(over.allow, false);
    assert.equal(over.action, ACTIONS.COMPRESS);
    assert.equal(over.ratio, 0.801);
    assert.match(over.reason, /越过 80% 上限/);
  });

  test('BUDGET_CEIL_RATIO 常量与 reason 文案同源', () => {
    assert.equal(BUDGET_CEIL_RATIO, 0.8);
    const r = preflight({ usedTokens: 900, estimatedStepTokens: 0, windowTokens: 1000, budgetPlan: goodPlan() });
    assert.ok(r.reason.includes(`${BUDGET_CEIL_RATIO * 100}%`));
    assert.ok(r.reason.includes(`${(r.ratio * 100).toFixed(1)}%`));
  });

  test('canCompress=false 时越线改判卸载流', () => {
    const r = preflight({
      usedTokens: 950,
      estimatedStepTokens: 0,
      windowTokens: 1000,
      budgetPlan: goodPlan(),
      canCompress: false,
    });
    assert.equal(r.allow, false);
    assert.equal(r.action, ACTIONS.OFFLOAD);
    assert.match(r.reason, /强制转卸载流/);
  });

  test('缺预算规划直接阻断，且 ratio 只按已用计算（不含预估）', () => {
    const r = preflight({ usedTokens: 100, estimatedStepTokens: 5000, windowTokens: 1000 });
    assert.equal(r.allow, false);
    assert.equal(r.action, ACTIONS.BLOCK);
    assert.equal(r.ratio, 0.1);
    assert.match(r.reason, /missing remaining,estimatedStepCost,strategy/);
    assert.equal('budget' in r, false);
  });

  test('负数与垃圾数值被夹到 0，窗口下限为 1 不除零', () => {
    const r = preflight({ usedTokens: -1e9, estimatedStepTokens: NaN, windowTokens: -5, budgetPlan: goodPlan() });
    assert.equal(r.allow, true);
    assert.equal(r.ceil, 0.8);
    assert.equal(r.ratio, 0);
    assert.equal(r.window, undefined);
  });

  test('超大窗口下比例仍精确，不出现浮点越界误判', () => {
    const r = preflight({
      usedTokens: 1e9,
      estimatedStepTokens: 0,
      windowTokens: 2e9,
      budgetPlan: goodPlan(),
    });
    assert.equal(r.ratio, 0.5);
    assert.equal(r.allow, true);
  });

  test('已知窗口 131072 的实战切分：10 万已用 + 3 万预估越过上限', () => {
    const r = preflight({
      usedTokens: 100000,
      estimatedStepTokens: 31072,
      windowTokens: 131072,
      budgetPlan: goodPlan(),
    });
    assert.equal(r.ceil, 104857.6);
    assert.equal(r.allow, false);
    assert.equal(r.action, ACTIONS.COMPRESS);
  });

  test('KNOWN-DEFECT: canCompress 只排除严格 false，假值 0 / 空串 / null 仍被判「还能压」', () => {
    // overflowInterceptor.js:85 (`args.canCompress !== false`) → a caller passing
    // canCompress: 0 (historical no-compression-space marker) keeps getting COMPRESS,
    // so the engine loops on a compression that can no longer shrink anything.
    for (const falsy of [0, '', null, undefined, NaN]) {
      const r = preflight({
        usedTokens: 999,
        estimatedStepTokens: 10,
        windowTokens: 1000,
        budgetPlan: goodPlan(),
        canCompress: falsy,
      });
      assert.equal(r.action, ACTIONS.COMPRESS, String(falsy));
    }
    const offload = preflight({
      usedTokens: 999,
      estimatedStepTokens: 10,
      windowTokens: 1000,
      budgetPlan: goodPlan(),
      canCompress: false,
    });
    assert.equal(offload.action, ACTIONS.OFFLOAD);
  });

  test('KNOWN-DEFECT: BLOCK 分支的 ratio 用已用而不含预估，与放行分支口径不一致', () => {
    // overflowInterceptor.js:71 vs :79 → the blocked-for-budget path reports used/window
    // while the proceed/compress paths report (used+est)/window. Same field name, two
    // meanings, so an upper layer that logs ratio across branches reads a smaller
    // occupancy exactly when the plan is broken.
    const blocked = preflight({ usedTokens: 900, estimatedStepTokens: 900, windowTokens: 1000, budgetPlan: {} });
    assert.equal(blocked.ratio, 0.9);
    const passed = preflight({ usedTokens: 900, estimatedStepTokens: 900, windowTokens: 1000, budgetPlan: goodPlan() });
    assert.equal(passed.ratio, 1.8);
  });

  test('显式传 null 抛 TypeError（默认参数只兜 undefined）', () => {
    assert.throws(() => preflight(null), TypeError);
  });
});

describe('isTruncationError 截断判定', () => {
  test('命中各网关措辞：字符串、Error、message/error/code 三态字段', () => {
    for (const hit of [
      'context_length_exceeded',
      'maximum context length is 8192',
      'token limit reached',
      'tokens exceeded',
      'output truncated',
      'too many tokens',
      'please reduce the length of the messages',
      '上下文超限',
      '上下文溢出',
      '发生截断',
      'ECONTEXT_OPEN',
      'max_tokens 配置过低',
      { message: 'This model has a maximum context of 4k' },
      { error: 'context length exceeded' },
      { code: 'context_length_exceeded' },
    ]) {
      assert.equal(isTruncationError(hit), true, JSON.stringify(hit));
    }
  });

  test('非截断错误与假值一律 false', () => {
    for (const miss of [
      null,
      undefined,
      '',
      0,
      false,
      NaN,
      {},
      [],
      'ECONNREFUSED',
      'rate limit exceeded, please retry later',
      { message: 'invalid api key' },
      { code: 'ETIMEDOUT' },
    ]) {
      assert.equal(isTruncationError(miss), false, JSON.stringify(miss));
    }
  });

  test('字段优先级 message > error > code', () => {
    assert.equal(isTruncationError({ message: 'plain', error: 'truncated', code: 'max_tokens' }), false);
    assert.equal(isTruncationError({ message: 'truncated here', error: 'ignored' }), true);
  });

  test('KNOWN-DEFECT: (exceed|over).*token 与 token.*(exceed|limit) 过宽，普通限流/覆盖文案被误判为截断', () => {
    // overflowInterceptor.js:101-102 → /(exceed|over).*token/i matches "overwrite the
    // token" and /token.*(exceed|limit)/i matches "token limit for auth is 100".
    // A misclassification routes an unrelated failure into emergencySnapshot (防呆④),
    // writing an EMERGENCY the task never needed.
    assert.equal(isTruncationError('failed to overwrite token cache'), true);
    assert.equal(isTruncationError({ message: 'auth token limit reached, rotate key' }), true);
    assert.equal(isTruncationError('exceeded quota for token bucket'), true);
  });

  test('空 message 的 Error 走 String(undefined) 兜底为 false 而非抛', () => {
    assert.equal(isTruncationError(new Error()), false);
    assert.equal(isTruncationError({ toString: () => 'truncated' }), false);
  });
});

describe('emergencySnapshot 防呆④', () => {
  // Injected deps keep the default path honest and the stubbed path side-effect-free.
  function makeDeps(persistResult) {
    const calls = { build: [], persist: 0 };
    return {
      calls,
      snapshotManager: {
        STATUS: { ACTIVE: 'active', DONE: 'done', EMERGENCY: 'emergency' },
        build: (input) => {
          calls.build.push(input);
          return { ...input };
        },
        persist: () => persistResult,
      },
      compressionEngine: require('./compressionEngine.js'),
    };
  }

  test('注入 deps 时按最严级压缩残存历史并强制 EMERGENCY 状态', () => {
    const deps = makeDeps({ ok: true, file: 'x.json' });
    const r = emergencySnapshot(
      {
        taskId: 't1',
        ultimateGoal: '完成迁移',
        step: 9,
        steps: [{ step: 1, intent: '读', tool: 'read', result: 'ok' }],
        retryCount: 2,
      },
      deps
    );
    assert.deepEqual(r, { ok: true, snapshot: r.snapshot, file: 'x.json' });
    assert.equal(r.snapshot.status, 'emergency');
    assert.equal(r.snapshot.step, 9);
    assert.equal(r.snapshot.retryCount, 2);
    assert.equal(deps.calls.build[0].compressedHistory.length, 1);
    assert.equal(
      deps.calls.build[0].nextInstruction,
      '[紧急熔断] 从最近一步的断点继续推进终极目标。'
    );
    assert.deepEqual(deps.calls.build[0].offloadPointers, []);
  });

  test('落盘失败即原样上报 error，不带 snapshot 字段', () => {
    const deps = makeDeps({ ok: false, error: '磁盘满' });
    const r = emergencySnapshot({ taskId: 't', ultimateGoal: 'g' }, deps);
    assert.deepEqual(r, { ok: false, error: '磁盘满' });
    assert.equal('snapshot' in r, false);
  });

  test('依赖抛错被吞成结构化结果，绝不把异常抛穿（契约：fail-soft）', () => {
    const boom = {
      snapshotManager: {
        STATUS: { EMERGENCY: 'emergency' },
        build: () => {
          throw new Error('build 崩了');
        },
        persist: () => ({ ok: true }),
      },
    };
    assert.deepEqual(emergencySnapshot({ taskId: 't', ultimateGoal: 'g' }, boom), {
      ok: false,
      error: 'build 崩了',
    });
    const noMsg = emergencySnapshot({}, { snapshotManager: { build: () => { throw { a: 1 }; } } });
    assert.equal(noMsg.ok, false);
    assert.equal(typeof noMsg.error, 'string');
  });

  test('residual 缺 steps / 为空时按空历史熔断，仍产出快照', () => {
    const deps = makeDeps({ ok: true, file: 'y.json' });
    const r = emergencySnapshot({ taskId: 't2', ultimateGoal: 'g' }, deps);
    assert.equal(r.ok, true);
    assert.deepEqual(deps.calls.build[0].compressedHistory, []);
    assert.equal(r.snapshot.taskId, 't2');
  });

  test('默认依赖走真实 snapshotManager，落盘被 dataHome 桩引到临时目录', () => {
    const r = emergencySnapshot({
      taskId: 'default-deps-t',
      ultimateGoal: '默认依赖',
      step: 3,
      steps: [{ step: 1, intent: 'a', tool: 'grep', result: 'b'.repeat(60) }],
      nextInstruction: '继续第 4 步',
    });
    assert.equal(r.ok, true, String(r.error));
    assert.ok(r.file.startsWith(tmpRoot), r.file);
    const onDisk = JSON.parse(fs.readFileSync(r.file, 'utf-8'));
    assert.equal(onDisk.status, 'emergency');
    assert.equal(onDisk.nextInstruction, '继续第 4 步');
    assert.equal(onDisk.step, 3);
    // 防呆④：紧急快照必须能经 hotStart 被下一会话接力
    const sm = require('./snapshotManager.js');
    const hs = sm.hotStart('default-deps-t');
    assert.equal(hs.found, true);
    assert.equal(hs.resumable, true);
    assert.match(hs.injectionPrompt, /紧急熔断|继续第 4 步/);
  });

  test('显式传 null 作为 deps 时不回落真实模块，但仍是结构化失败而非抛穿', () => {
    // Default parameter only covers undefined, so `deps.snapshotManager` dereferences
    // null; the outer try/catch keeps the fail-soft contract but the fallback to the
    // subsystem's own modules never happens.
    const r = emergencySnapshot({ taskId: 'null-deps', ultimateGoal: 'g', steps: [] }, null);
    assert.equal(r.ok, false);
    assert.match(r.error, /Cannot read properties of null/);
    const empty = emergencySnapshot({ taskId: 'empty-deps', ultimateGoal: 'g', steps: [] }, {});
    assert.equal(empty.ok, true, String(empty.error));
  });
});
