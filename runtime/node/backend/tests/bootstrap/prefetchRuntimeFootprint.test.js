'use strict';

/**
 * prefetchRuntimeFootprint.test.js — 轻量模式(khy)体积自检的调用面。
 *
 * 为什么单列一条:.khy 只增不减是同一处缺口的两批 —— 第一批(日志/审计滚动)已修,
 * 第二批(training 与训练隔离区)2026-09-29 才补。两条裁剪原先只挂在完整模式的
 * runCleanup 里,而最主要的分发入口走 `khy` 轻量模式,于是从来没跑过:
 * 实测 interaction_quarantine.jsonl 547.8 MB(超自身上限 20 MB 的 27 倍)。
 * 这里锁的是「轻量模式确实调了」,而不是「函数存在」。
 *
 * RUNNERS 不导出 ⇒ 用 require.cache 受控替换 cleanupService 为计数 spy(测后逐字节
 * 还原),并把 global.setTimeout 换成收集器,只手动触发 +3500ms 那条,避免真等 3.5 秒。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const prefetch = require('../../src/bootstrap/prefetch');

const CLEANUP_PATH = require.resolve('../../src/services/cleanupService');
const HW_PATH = require.resolve('../../src/services/hardwareProfileService');

// 体积自检那条排程的延迟。真源是 serviceLifecyclePolicy 的 cli-startup/khy 条目,
// 这里只作定位用;数值漂了会由下面的「排程形状」用例先报出来。
const FOOTPRINT_DELAY_MS = 3500;

// 门控驱动的排程形状(真源:serviceLifecyclePolicy 的 cli-startup/khy 条目)。
const KHY_GATE_DELAYS = [300, 3500, 5000];

// [DESIGN-ARCH-180] 结算 timer:固定落在门控表最大 delay + 1s 缓冲,用于等所有一次性
// 启动 timer 销毁之后再采样驻留资源 —— 在启动窗口内采样会把尚未 firing 的 timer 误报成
// 超预算(2026-10-04 实测 26/20 即此)。它不是门控条目,故不参与门控形状比对。
const SETTLE_SLACK_MS = 1000;
const SETTLE_DELAY_MS = Math.max(...KHY_GATE_DELAYS) + SETTLE_SLACK_MS;

function mkCleanupSpy() {
  const calls = [];
  const rec = (name) => () => {
    calls.push(name);
  };
  return {
    calls,
    cleanRuntimeLogs: rec('cleanRuntimeLogs'),
    cleanTraceAudit: rec('cleanTraceAudit'),
    trimTrainingData: rec('trimTrainingData'),
    trimQuarantine: rec('trimQuarantine'),
    runCleanup: rec('runCleanup'),
    startPeriodicCleanup: rec('startPeriodicCleanup'),
    assessRuntimeFootprint: () => {
      calls.push('assessRuntimeFootprint');
      return { notice: null }; // 不触发 emit,免得依赖 chalk
    },
  };
}

/**
 * 跑一次 khy 模式的排程,只触发体积自检那条。
 * @returns {{ calls: string[], scheduled: Array<{delay:number}>, timers: unknown[] }}
 */
function runKhyFootprint() {
  const spy = mkCleanupSpy();
  const prevCleanup = require.cache[CLEANUP_PATH];
  const prevHw = require.cache[HW_PATH];
  const realSetTimeout = global.setTimeout;
  const scheduled = [];

  // applyLimits 会按硬件改 process.env;本用例只关心调用面,替成空实现保持密闭。
  require.cache[CLEANUP_PATH] = { id: CLEANUP_PATH, filename: CLEANUP_PATH, loaded: true, exports: spy };
  require.cache[HW_PATH] = {
    id: HW_PATH,
    filename: HW_PATH,
    loaded: true,
    exports: { applyLimits: () => {} },
  };
  global.setTimeout = (fn, delay) => {
    scheduled.push({ fn, delay });
    return { __fakeTimer: true };
  };

  let timers;
  try {
    timers = prefetch.deferredPrefetch({ mode: 'khy', onOutput: () => {}, isBusy: () => false });
    const target = scheduled.find((s) => s.delay === FOOTPRINT_DELAY_MS);
    assert.ok(target, `khy 模式应有 +${FOOTPRINT_DELAY_MS}ms 的体积自检排程`);
    target.fn();
  } finally {
    global.setTimeout = realSetTimeout;
    if (prevCleanup === undefined) delete require.cache[CLEANUP_PATH];
    else require.cache[CLEANUP_PATH] = prevCleanup;
    if (prevHw === undefined) delete require.cache[HW_PATH];
    else require.cache[HW_PATH] = prevHw;
  }

  return { calls: spy.calls, scheduled, timers };
}

const countOf = (calls, name) => calls.filter((n) => n === name).length;

describe('prefetch / khy 轻量模式体积自检', () => {
  test('轻量模式裁 training 与训练隔离区(第二批缺口)', () => {
    const { calls } = runKhyFootprint();
    // 这两条就是 2026-09-29 补的接线;拆掉它们必须让本用例变红。
    assert.ok(countOf(calls, 'trimTrainingData') > 0, 'khy 模式必须裁 training');
    assert.ok(countOf(calls, 'trimQuarantine') > 0, 'khy 模式必须裁训练隔离区');
  });

  test('第一批(日志/审计滚动)不被第二批挤掉,且自检仍报一次', () => {
    const { calls } = runKhyFootprint();
    assert.ok(countOf(calls, 'cleanRuntimeLogs') > 0);
    assert.ok(countOf(calls, 'cleanTraceAudit') > 0);
    assert.equal(countOf(calls, 'assessRuntimeFootprint'), 1);
  });

  test('轻量模式该轻的地方仍然轻:不起完整 runCleanup / 周期清理', () => {
    const { calls } = runKhyFootprint();
    assert.equal(countOf(calls, 'runCleanup'), 0, 'khy 模式不得跑完整 runCleanup');
    assert.equal(countOf(calls, 'startPeriodicCleanup'), 0, 'khy 模式不得起周期 timer');
  });

  test('khy 启动排程形状锁定(零新增门控)', () => {
    // TUI 门控已顶格,零余量 ⇒ 这批改动不许新增任何 KHY_* 排程条目。
    // 形状变了就先在这里报,而不是等 check-tui-gates 在别处变红。
    // 结算 timer(见文件头 SETTLE_DELAY_MS)不收门,从形状里剔除后单独断言其存在。
    const { scheduled } = runKhyFootprint();
    assert.deepEqual(
      scheduled.map((s) => s.delay).filter((d) => d !== SETTLE_DELAY_MS),
      KHY_GATE_DELAYS,
      '门控驱动的排程形状不得变'
    );
    assert.ok(
      scheduled.some((s) => s.delay === SETTLE_DELAY_MS),
      `结算 timer 必须以 ${SETTLE_DELAY_MS}ms 注册 —— khy 就是 TUI 会话,驻留资源读数靠它`
    );
  });
});
