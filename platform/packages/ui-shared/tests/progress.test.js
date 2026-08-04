/**
 * pacedProgress / usePacedProgress —— 浏览器侧「渐进节拍」的不变式测试。
 *
 * 用户目标：「khyos 中的所有进度条都需要渐进加载，宁愿慢一些，1% 1% 的加载，
 * 也不要出现用户体感长时间等待，要让用户知道 khyos 在干活」+「包括显示必须逐步渐进显示，
 * 不要一下就加载百分之几十的进度」+「不要卡在一个地方很久突然加载完成」。所以这里锁死的
 * 是五条**观感契约**：
 *   ① **一帧最多 +1%**：一次采样最多涨 1%，攒下的时间一律丢弃（迟到 60 秒也只走一步）；
 *   ② 单调不减；
 *   ③ 永不虚报完成（到 100 的唯一入口是 finish()，或确定进度下真实值真的到 100）；
 *   ④ 不静止（不确定进度在 TAIL_CAP(99) 之前一定在动，cap(96) 只是换档点），
 *      且减少动效档不逐步爬（只直接报真实值）；
 *   ⑤ 收尾也逐步（finish() / 真实值到 100 都不跳 100，仍 1%/帧 走完）。
 *
 * 外加确定进度车道的**诚实**：显示值永不越过真实值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STEP_MS,
  EASE_AFTER,
  SLOW_STEP_MS,
  CAP,
  TAIL_STEP_MS,
  TAIL_CAP,
  RENDER_MS,
  DEFAULTS,
  normalizeOptions,
  pacedPercent,
  filledCells,
  renderBar,
  createPacer,
  prefersReducedMotion,
} from '../src/progress/pacedProgress.js';
import { usePacedProgress } from '../src/progress/usePacedProgress.js';

const T0 = 1_700_000_000_000;
const clock = (ms) => T0 + ms;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('节拍常量与后端（services/progressiveProgress.js）逐值一致', () => {
  assert.equal(STEP_MS, 160);
  assert.equal(EASE_AFTER, 70);
  assert.equal(SLOW_STEP_MS, 1400);
  assert.equal(CAP, 96);
  assert.equal(TAIL_STEP_MS, 4000);
  assert.equal(TAIL_CAP, 99);
  assert.equal(RENDER_MS, STEP_MS); // 每帧恰好 +1% 的前提
  assert.deepEqual(DEFAULTS, {
    stepMs: 160,
    easeAfter: 70,
    slowStepMs: 1400,
    tailStepMs: 4000,
    cap: 96,
  });
});

test('pacedPercent 曲线：三档递慢（160 → 1400 → 4000ms/1），恒不超 TAIL_CAP', () => {
  assert.equal(pacedPercent(0), 0);
  assert.equal(pacedPercent(-1), 0);
  assert.equal(pacedPercent(NaN), 0);
  assert.equal(pacedPercent(160), 1);
  assert.equal(pacedPercent(1600), 10);
  assert.equal(pacedPercent(70 * 160), 70);
  assert.equal(pacedPercent(70 * 160 + 1399), 70);
  assert.equal(pacedPercent(70 * 160 + 1400), 71);
  assert.equal(pacedPercent(16_000), 73);
  // cap(96) 是换档点：过它转尾巴档，每 4000ms +1，到 99 才停。
  const reachCapAt = 70 * 160 + 26 * 1400;
  assert.equal(pacedPercent(reachCapAt), CAP);
  assert.equal(pacedPercent(reachCapAt + TAIL_STEP_MS), 97);
  assert.equal(pacedPercent(reachCapAt + 2 * TAIL_STEP_MS), 98);
  assert.equal(pacedPercent(reachCapAt + 3 * TAIL_STEP_MS), 99);
  assert.equal(pacedPercent(6_000_000), TAIL_CAP);

  let prev = -1;
  for (let t = 0; t <= 200_000; t += 211) {
    const v = pacedPercent(t);
    assert.ok(v >= prev, '单调不减');
    assert.ok(v <= TAIL_CAP, '不超过 TAIL_CAP');
    prev = v;
  }
});

test('normalizeOptions / filledCells / renderBar：非法输入收敛，绝不抛异常', () => {
  assert.deepEqual(normalizeOptions(null), DEFAULTS);
  assert.deepEqual(normalizeOptions({ stepMs: 0, cap: -3 }), DEFAULTS);
  assert.equal(normalizeOptions({ stepMs: 100 }).stepMs, 100);
  assert.equal(normalizeOptions({ tailStepMs: 1000 }).tailStepMs, 1000);
  // cap 上限钉在 99：未完成时绝不出 100（cap:100 会让条爬到 100% 停住 = 虚报完成）。
  assert.equal(normalizeOptions({ cap: 100 }).cap, 99);
  assert.equal(pacedPercent(600_000, { cap: 100 }), TAIL_CAP);
  // cap 非正数 → 回退默认（照收就是「条永远不动」）；兜底成 96 后仍会爬到 99。
  assert.equal(normalizeOptions({ cap: 0 }).cap, CAP);
  assert.equal(pacedPercent(600_000, { cap: 0 }), TAIL_CAP);

  assert.equal(filledCells(50, 20), 10);
  assert.equal(filledCells(42, 20), 8);
  assert.equal(filledCells(-1, 20), 0);
  assert.equal(filledCells(101, 20), 20);
  assert.equal(filledCells(50, 0), 10); // width 非法 → 默认 20
  assert.equal(filledCells(50, 3), 2);

  assert.equal([...renderBar(42, 20)].length, 20);
  assert.equal(renderBar(50, 4, { filled: '#', empty: '-' }), '##--');
});

test('不确定进度：按渲染节拍每次 +1%；收尾由同一节拍走到 100（不跳）', () => {
  let nowMs = 0;
  const p = createPacer({ now: () => clock(nowMs) });
  const seq = [];
  for (let i = 0; i <= 40; i += 1) {
    nowMs = i * RENDER_MS;
    seq.push(p.percent(clock(nowMs)));
  }
  assert.deepEqual(seq, Array.from({ length: 41 }, (_, i) => i));
  nowMs = 60_000;
  assert.equal(p.percent(clock(nowMs)), 41); // 迟到的一次采样只走一步
  assert.equal(p.isFinished(), false);
  assert.equal(p.finish(), 41); // finish() 只设终态目标，不赋 100
  assert.equal(p.isDone(), true);
  assert.equal(p.isFinished(), false);
  for (let i = 0; i < 59; i += 1) {
    nowMs += RENDER_MS;
    p.percent(clock(nowMs));
  }
  assert.equal(p.percent(clock(nowMs)), 100); // 59 帧收尾（41 → 100），每帧 1%
  assert.equal(p.isFinished(), true);
  assert.equal(p.settled(), true);
});

test('不确定进度：不静止 —— 到 cap(96) 后转尾巴档继续爬，绝不冻在一个数上', () => {
  let nowMs = 0;
  const p = createPacer({ now: () => clock(nowMs) });
  for (let i = 0; i < 70; i += 1) {
    nowMs += STEP_MS;
    p.percent(clock(nowMs));
  }
  for (let i = 0; i < 26; i += 1) {
    nowMs += SLOW_STEP_MS;
    p.percent(clock(nowMs));
  }
  assert.equal(p.percent(clock(nowMs)), CAP);
  assert.equal(p.settled(), false); // 旧的 cap 语义在这里就停了
  nowMs += TAIL_STEP_MS;
  assert.equal(p.percent(clock(nowMs)), 97);
  nowMs += TAIL_STEP_MS;
  assert.equal(p.percent(clock(nowMs)), 98);
  nowMs += TAIL_STEP_MS;
  assert.equal(p.percent(clock(nowMs)), 99);
  assert.equal(p.settled(), true);
  assert.equal(p.isDone(), false);
  assert.equal(p.isFinished(), false);
});

test('不确定进度：一帧最多 +1% —— 迟到 60 秒后的第一次采样也只走一步', () => {
  const p = createPacer({ now: () => clock(0) });
  assert.equal(p.percent(clock(0)), 0);
  assert.equal(p.percent(clock(60_000)), 1); // 60 秒的债 → 只兑一步
  assert.equal(p.percent(clock(60_000 + RENDER_MS)), 2);
});

test('不确定进度：startPercent 让中途挂载的条不从 0 重来', () => {
  const p = createPacer({ now: () => clock(0), startPercent: 42 });
  assert.equal(p.percent(clock(0)), 42);
  assert.equal(p.percent(clock(RENDER_MS)), 43);
});

test('startedAt 只用于起点播种：中途挂载从曲线位置起步，此后照旧 1% 1%', () => {
  const p = createPacer({ now: () => clock(0), startedAt: clock(-3200) });
  assert.equal(p.percent(clock(0)), 20); // 3200 / 160 —— 起点是既成事实
  assert.equal(p.elapsed(), 3200);
  assert.equal(p.percent(clock(RENDER_MS)), 21);
});

test('确定进度：永不越过真实值，分母粗也被摊成 1% 1% 的曲线', () => {
  const p = createPacer({ now: () => clock(0), determinate: true });
  p.observe(33);
  const seq = [];
  for (let i = 0; i <= 40; i += 1) seq.push(p.percent(clock(i * RENDER_MS)));
  assert.equal(Math.max(...seq), 33);
  assert.ok(seq.every((v) => v <= 33));
  assert.equal(seq[1], 1); // 一次只走 1%
});

test('确定进度：一帧最多 +1% —— 真实值 67% 也不会在第一帧画出来', () => {
  const p = createPacer({ now: () => clock(0), determinate: true });
  p.observe(67);
  assert.equal(p.percent(clock(60_000)), 1);
  assert.equal(p.percent(clock(60_000 + RENDER_MS)), 2);
});

test('确定进度：真实值 99.6 出 99（未完成不出 100），真实值 98 也画得到 98', () => {
  const p = createPacer({ now: () => clock(0), determinate: true });
  p.observe(99.6);
  let t = 0;
  for (let i = 0; i < 70; i += 1) {
    t += STEP_MS;
    p.percent(clock(t));
  }
  for (let i = 0; i < 29; i += 1) {
    t += SLOW_STEP_MS;
    p.percent(clock(t));
  }
  assert.equal(p.percent(clock(t)), 99);
  assert.equal(p.percent(clock(600_000)), 99); // 停在 99，绝不出 100
  assert.equal(p.isFinished(), false);

  // 爬到 98 需 70×160 + 28×1400 = 50400ms —— 确定进度车道不该被 cap(96) 压住。
  const q = createPacer({ now: () => clock(0), determinate: true });
  q.observe(98);
  let u = 0;
  for (let i = 0; i < 70; i += 1) {
    u += STEP_MS;
    q.percent(clock(u));
  }
  for (let i = 0; i < 28; i += 1) {
    u += SLOW_STEP_MS;
    q.percent(clock(u));
  }
  assert.equal(q.percent(clock(u)), 98);
  assert.equal(q.percent(clock(120_000)), 98);
});

test('确定进度：真实值回退时显示值不缩回去（单调）', () => {
  const p = createPacer({ now: () => clock(0), determinate: true });
  p.observe(50);
  for (let i = 1; i <= 50; i += 1) p.percent(clock(i * STEP_MS));
  assert.equal(p.percent(clock(50 * STEP_MS)), 50);
  p.observe(10);
  assert.equal(p.percent(clock(60 * STEP_MS)), 50);
});

test('observe() 单调：真实值回退被忽略；真实值到 100 只设终态，显示仍 1% 1% 走完', () => {
  let nowMs = 0;
  const p = createPacer({ now: () => clock(nowMs) });
  p.observe(30);
  assert.equal(p.real(), 30);
  p.observe(12);
  assert.equal(p.real(), 30);
  p.observe(100);
  // 工作结束（isDone）与显示已满（isFinished）分开记：真实值到 100 也不许一瞬间满格。
  assert.equal(p.isDone(), true);
  assert.equal(p.isFinished(), false);
  assert.equal(p.percent(clock(nowMs)), 0); // 同一瞬间仍停在原处
  assert.equal(p.settled(), false);
  for (let i = 1; i <= 100; i += 1) {
    nowMs += RENDER_MS;
    p.percent(clock(nowMs));
  }
  assert.equal(p.percent(clock(nowMs)), 100); // 100 帧、每帧 1% 走完
  assert.equal(p.isFinished(), true);
  assert.equal(p.settled(), true);
});

test('减少动效档（static）：只直接报真实值 —— 不叠加节拍、也不逐步爬', () => {
  const p = createPacer({ now: () => clock(0), static: true, startPercent: 12 });
  // 没人喂真实值 → 停在 startPercent 的落点（不是 0，也不是爬行）。
  assert.equal(p.percent(clock(60_000)), 12);
  p.observe(40);
  assert.equal(p.percent(clock(60_000)), 40); // 立刻到，不爬
  p.observe(99.6);
  assert.equal(p.percent(clock(60_000)), 99); // 未完成仍不出 100
});

test('rebase() 只收基准不动显示值；reset() 回到新建态', () => {
  const p = createPacer({ now: () => clock(0), startPercent: 30 });
  for (let i = 1; i <= 5; i += 1) p.percent(clock(i * RENDER_MS));
  assert.equal(p.percent(clock(5 * RENDER_MS)), 35);
  p.reset();
  assert.equal(p.percent(clock(0)), 30);
  assert.equal(p.percent(clock(RENDER_MS)), 31);

  const q = createPacer({ now: () => clock(0), startPercent: 30 });
  for (let i = 1; i <= 5; i += 1) q.percent(clock(i * RENDER_MS));
  assert.equal(q.percent(clock(5 * RENDER_MS)), 35);
  q.rebase(clock(5 * RENDER_MS));
  assert.equal(q.percent(clock(5 * RENDER_MS)), 35); // 显示值不回退
  assert.equal(q.percent(clock(6 * RENDER_MS)), 36); // 基准收到此刻，下一步从此刻起算
});

test('输入非法一律收敛，绝不抛异常', () => {
  const p = createPacer({ startedAt: NaN, startPercent: NaN, pace: null });
  assert.doesNotThrow(() => p.percent(NaN));
  assert.ok(Number.isFinite(p.percent(NaN)));
  assert.doesNotThrow(() => p.observe('abc'));
  assert.equal(p.real(), 0);
  assert.equal(typeof p.bar(NaN, null), 'string');
  assert.doesNotThrow(() => createPacer());
});

test('prefersReducedMotion：无 matchMedia 环境（Node/SSR）→ false', () => {
  assert.equal(prefersReducedMotion(), false);
});

test('usePacedProgress：初始落在 startPercent；finish 只设终态目标（不跳 100），reset 回到起点', () => {
  const api = usePacedProgress({ startPercent: 12, active: false });
  assert.equal(api.percent.value, 12);
  assert.equal(api.isDone.value, false);
  assert.equal(api.isFinished.value, false);
  api.finish();
  // 「卡在一个地方很久、然后突然加载完成」的病灶就在这里：旧实现 finish() 直接赋 100。
  assert.equal(api.isDone.value, true); // 工作结束
  assert.equal(api.isFinished.value, false); // 但显示还没走到 100
  assert.equal(api.percent.value, 12); // 同一瞬间不跳
  api.reset();
  assert.equal(api.percent.value, 12);
  assert.equal(api.isDone.value, false);
  assert.equal(api.isFinished.value, false);
});

test('usePacedProgress：finish 后仍逐帧收尾（active 时），到 settleMs 停表不拖长等待', async () => {
  const api = usePacedProgress({ startPercent: 0, active: () => true, settleMs: 200 });
  await sleep(RENDER_MS * 3);
  const before = api.percent.value;
  assert.ok(before >= 1, '节拍在推进');
  api.finish();
  assert.equal(api.isDone.value, true);
  assert.equal(api.isFinished.value, false); // 不跳 100
  const atFinish = api.percent.value;
  await sleep(RENDER_MS * 3);
  assert.ok(api.percent.value > atFinish, '收尾段仍在动');
  assert.ok(api.percent.value - atFinish <= 4, '仍是 1%/帧，不跳');
  // settleMs 到点即停表：不再为「走完」把收尾拉成十几秒的长等待。
  await sleep(300);
  const atRest = api.percent.value;
  await sleep(RENDER_MS * 3);
  assert.equal(api.percent.value, atRest);
});

test('usePacedProgress：active 传 getter 才启停；真实值一变就 1% 1% 地追上去', async () => {
  const real = { value: 40 };
  const api = usePacedProgress({
    determinate: true,
    startPercent: 0,
    source: () => real.value,
    // 必须传 getter：静态布尔读出来恒定，watch 永不触发 —— 那是「条不动」的静默 bug。
    active: () => true,
  });

  // 挂载即采一次：此刻还没到下一个渲染节拍 → 仍是 0（不是一帧跳到 40）。
  assert.equal(api.percent.value, 0);
  await sleep(RENDER_MS * 3);
  assert.ok(api.percent.value >= 1, '节拍在推进');
  assert.ok(api.percent.value <= 40, '永不越过真实值');

  const before = api.percent.value;
  real.value = 100;
  await sleep(RENDER_MS * 3);
  assert.equal(api.isDone.value, true); // 真实值到 100 = 工作结束
  assert.equal(api.isFinished.value, false); // 但显示不虚报：没走到 100 就不说 100
  assert.ok(api.percent.value >= before, '单调不减');
  assert.ok(api.percent.value - before <= 4, '终态段仍是 1%/帧，不跳');
  assert.ok(api.percent.value < 100, '尚未走到 100');
});

test('reset() 在 active 时把节拍接回来（否则新一段等待会冻在起始值上）', async () => {
  const api = usePacedProgress({ startPercent: 3, active: () => true });
  await sleep(RENDER_MS * 3);
  assert.ok(api.percent.value >= 4, '节拍在推进');

  // 收尾窗口内又来一个请求时 active 一直是 true → `watch(active)` 不会触发，
  // reset() 只停不启就会让新一段等待冻在 3% —— 正是要消灭的观感。
  api.reset();
  assert.equal(api.percent.value, 3);
  await sleep(RENDER_MS * 3);
  assert.ok(api.percent.value >= 4, 'reset() 之后节拍仍在走');
});

test('usePacedProgress：组件外调用不依赖生命周期钩子（不抛异常）', () => {
  assert.doesNotThrow(() => {
    const api = usePacedProgress({ active: false });
    api.finish();
  });
});

test('usePacedProgress：active=false 时不挂定时器，percent 停在起始值', async () => {
  const api = usePacedProgress({ startPercent: 5, active: false });
  await sleep(RENDER_MS * 2);
  assert.equal(api.percent.value, 5);
  assert.equal(api.cap, CAP);
});