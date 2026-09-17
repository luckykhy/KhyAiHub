/**
 * pacedProgress —— 桌面端进度条「渐进节拍」的不变式测试。
 *
 * 用户目标：「所有进度条都需要渐进加载，宁愿慢一些，1% 1% 的加载，也不要出现用户
 * 体感长时间等待」+「不要卡在一个地方很久突然加载完成」。故这里锁死五条契约：
 *   ① 一次调用最多 +1%（不是一次跳一大格）；
 *   ② 单调不减（真实值回退也不许显示值缩回去）；
 *   ③ 永不虚报完成（真实值没到 100 就绝不出 100）；
 *   ④ 到点才动：快速档 160ms/1%，过七成后 1400ms/1%；
 *   ⑤ 收尾也逐步：真实值到 100（`done`）时改走快速档一格格走完，**不**同帧满格。
 *
 * (Node 22.6+ type stripping; the .ts module imports cleanly without a build step.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  PACED_STEP_MS,
  PACED_EASE_AFTER,
  PACED_SLOW_STEP_MS,
  PACED_RENDER_MS,
  PACED_SETTLE_MS,
  PACED_MAX_STEPS_PER_CALL,
  advancePaced,
  clampPercent,
  prefersReducedMotion,
} = await import('../src/renderer/components/ui/pacedProgress.ts');

const T0 = 1_700_000_000_000;

/** 模拟「每 160ms 重绘一次」的渲染循环，返回每次重绘后应显示的百分比序列。 */
function runTicks(state, realPercent, ticks, stepMs = PACED_STEP_MS, options = {}) {
  const out = [];
  for (let i = 1; i <= ticks; i += 1) {
    state = advancePaced(state, realPercent, T0 + i * stepMs, undefined, options);
    out.push(state.shown);
  }
  return out;
}

test('节拍常量与浏览器/CLI 侧同一套口径', () => {
  assert.equal(PACED_STEP_MS, 160);
  assert.equal(PACED_EASE_AFTER, 70);
  assert.equal(PACED_SLOW_STEP_MS, 1400);
  assert.equal(PACED_RENDER_MS, PACED_STEP_MS); // 每帧恰好 +1% 的前提
  assert.equal(PACED_SETTLE_MS, 1200); // 收尾时限（消费方可在 options 里覆盖）
  // 恒为 1 —— 「一帧最多 +1%」是硬不变式，不是可调上界（改它就得同时改三处引擎）。
  assert.equal(PACED_MAX_STEPS_PER_CALL, 1);
});

test('一次调用最多 +1%，即便渲染被阻塞很久（绝不一大跳）', () => {
  const state = { shown: 0, lastStepAt: T0 };
  // 一次调用前进了 60 秒 —— 仍然只 +1%。这是「1% 1% 地加载」的硬保证：
  // 攒下的时间不会在一次 setState 里被一次性吐出来（基准被收到「当下」）。
  const next = advancePaced(state, 100, T0 + 60_000);
  assert.equal(next.shown, 1);
  assert.equal(next.lastStepAt, T0 + 60_000);
  // 紧接着的一个正常节拍再走一步 —— 迟到的 60 秒不会被「分期兑换」成连续的大步。
  const after = advancePaced(next, 100, T0 + 60_000 + PACED_STEP_MS);
  assert.equal(after.shown, 2);
});

test('快速档 160ms/1%，过七成后降为 1400ms/1%', () => {
  let state = { shown: 0, lastStepAt: T0 };
  // 前 70 步：每 160ms 恰好 +1。
  const fast = runTicks(state, 100, PACED_EASE_AFTER);
  assert.deepEqual(
    fast,
    Array.from({ length: PACED_EASE_AFTER }, (_, i) => i + 1)
  );
  state = { shown: fast[fast.length - 1], lastStepAt: T0 + PACED_EASE_AFTER * PACED_STEP_MS };
  // 慢速档：同一个 160ms 节拍下不再推进，得等满 1400ms 才 +1。
  const slowTicks = runTicks(state, 100, 8);
  assert.deepEqual(slowTicks, new Array(8).fill(PACED_EASE_AFTER));
  const afterSlow = advancePaced(state, 100, T0 + PACED_EASE_AFTER * PACED_STEP_MS + PACED_SLOW_STEP_MS);
  assert.equal(afterSlow.shown, PACED_EASE_AFTER + 1);
});

test('永不越过真实值：真实值 33 时分母粗也不再一帧到位', () => {
  const state = { shown: 0, lastStepAt: T0 };
  const seq = runTicks(state, 33, 40);
  assert.equal(Math.max(...seq), 33);
  assert.ok(
    seq.every((v) => v <= 33),
    '显示值必须恒 ≤ floor(真实值)'
  );
  assert.equal(seq[0], 1, '第一次推进只走 1%');
});

test('真实值没到 100 就绝不出 100（不虚报完成）', () => {
  let state = { shown: 0, lastStepAt: T0 };
  for (let i = 1; i <= 400; i += 1) {
    state = advancePaced(state, 99, T0 + i * PACED_STEP_MS);
  }
  assert.equal(state.shown, 99);
  // 真实值真的到 100 才允许出 100。
  let done = { shown: 0, lastStepAt: T0 };
  for (let i = 1; i <= 400; i += 1) {
    done = advancePaced(done, 100, T0 + i * PACED_STEP_MS);
  }
  assert.equal(done.shown, 100);
});

test('收尾（done）走快速档：96 → 100 每 160ms 一格，不同帧满格', () => {
  let state = { shown: 96, lastStepAt: T0 };
  const seq = [];
  for (let i = 1; i <= 4; i += 1) {
    state = advancePaced(state, 100, T0 + i * PACED_STEP_MS, undefined, { done: true });
    seq.push(state.shown);
  }
  // 一帧一格 —— 旧的「真实值到 100 就把显示值赋成 100」正是用户说的「突然加载完成」。
  assert.deepEqual(seq, [97, 98, 99, 100]);
});

test('收尾档不是把慢档删掉：未声明 done 时同一位置仍按 1400ms/1 走', () => {
  const state = { shown: 96, lastStepAt: T0 };
  const sameTick = advancePaced(state, 100, T0 + PACED_STEP_MS);
  assert.equal(sameTick.shown, 96); // 慢档下 160ms 还不够一格
  const afterSlow = advancePaced(state, 100, T0 + PACED_SLOW_STEP_MS);
  assert.equal(afterSlow.shown, 97);
});

test('单调不减：真实值回退时显示值不缩回去', () => {
  const state = { shown: 40, lastStepAt: T0 };
  const next = advancePaced(state, 12, T0 + 10_000);
  assert.equal(next.shown, 40);
});

test('不活跃的间隙只把基准推到当下，不攒步数债', () => {
  const state = { shown: 5, lastStepAt: T0 };
  // 真实值已追平（shown >= floor(real)）→ 基准跟到当下。
  const level = advancePaced(state, 5, T0 + 30_000);
  assert.equal(level.shown, 5);
  assert.equal(level.lastStepAt, T0 + 30_000);
  // 真实值随后跳到 20 → 下一次推进仍是 1%，不发散。
  const next = advancePaced(level, 20, T0 + 30_000 + PACED_STEP_MS);
  assert.equal(next.shown, 6);
});

test('输入非法一律收敛，绝不抛异常', () => {
  assert.equal(clampPercent(NaN), 0);
  assert.equal(clampPercent(-5), 0);
  assert.equal(clampPercent(180), 100);
  assert.doesNotThrow(() => advancePaced({ shown: NaN, lastStepAt: NaN }, NaN, NaN));
  const safe = advancePaced({ shown: NaN, lastStepAt: NaN }, NaN, NaN);
  assert.equal(safe.shown, 0);
});

test('无 matchMedia 环境（Node / SSR）不主张减少动效', () => {
  assert.equal(prefersReducedMotion(), false);
});