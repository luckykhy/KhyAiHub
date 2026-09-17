/**
 * pacedProgress — 进度条「渐进节拍」的桌面端实现（Electron 渲染进程）。
 *
 * 用户目标：khyos 里的进度条都要**渐进加载** —— 「宁愿慢一些，1% 1% 的加载，也不要
 * 出现用户体感长时间等待」。桌面端此前是 `width: X%` + `transition-all duration-500`：
 * 值一变就 0.5 秒滑到新位置，之后**一直不动**，长任务下就是「条冻住了」。
 *
 * 本模块是确定进度车道（分母已知）的最小实现，口径与
 * `platform/packages/ui-shared/src/progress/pacedProgress.js`（浏览器侧）和
 * `services/backend/src/services/progressiveProgress.js`（CLI 侧）**逐值一致**：
 * STEP_MS=160 / EASE_AFTER=70 / SLOW_STEP_MS=1400。四条硬约束同样适用：
 *   · **单调**：显示值只增不减；
 *   · **永不虚报完成**：显示值取 floor(真实值)，真实值没到 100 就绝不出 100；
 *   · **一步 1%**：`advancePaced` 每次调用最多 +1%（`PACED_MAX_STEPS_PER_CALL`），且
 *     **攒下的时间丢弃** —— 迟到的采样不会在恢复后的第一帧里补出几十个百分点。用户看到的
 *     是字面意义的「1% 1% 地加载」，而不是一次跳一大格然后长时间静止；
 *   · **收尾也逐步**：真实值到 100（`done`）时**不**把显示值赋成 100 —— 剩下的距离由同一套
 *     1%/帧 的节拍走过去，只是收尾改走**快速档**（慢档会把最后几格拖成十几秒）。旧实现
 *     「真实值一跳到 100、条同帧满格」正是用户说的「卡在一个地方很久、然后突然加载完成」。
 *
 * 桌面端只有**确定进度**一条车道（调用的地方都拿得到分母），所以没有 CLI/浏览器侧的
 * 「尾巴档」—— 那一档是为「分母未知、只能逼近天花板」的车道准备的。
 *
 * 为什么桌面端没有直接引 `@khy/ui-shared`：那个包是给浏览器 Vue 应用用的共享叶子，
 * 而 `khyos-desktop` 既不在 npm workspace 里、也没有它作依赖，跨包 import 会让
 * electron-vite 的解析多一层不确定。这里保留同一套常量与判定，改动请三处一起改。
 *
 * 纯叶子：零 IO、不写 console、**never throws**。时钟从参数传入（测试确定性）。
 */

/** 快速档：每 1% 的耗时（= 渲染节拍，保证每帧恰好 +1%）。 */
export const PACED_STEP_MS = 160;
/** 过七成后换慢速档。 */
export const PACED_EASE_AFTER = 70;
/** 慢速档每 1% 的耗时（70 → 99 约 40 秒）。 */
export const PACED_SLOW_STEP_MS = 1400;
/** 自己持有时钟的渲染器应当用这个节拍重绘。 */
export const PACED_RENDER_MS = 160;
/**
 * `done` 之后收尾的默认时限（毫秒）。收尾按 1%/帧 走，但从 `cap` 附近的常见落点走完
 * 只需几帧；只有「真实值从很低处一步跳到 100」时才会离得远 —— 那时到点即落在真实值上，
 * 绝不为了「走完」把一段已经结束的操作拖成十几秒的长等待。
 */
export const PACED_SETTLE_MS = 1200;
/**
 * 单次调用最多推进的步数 —— **恒为 1**（与浏览器/CLI 侧同值同义）。
 *
 * 「显示必须逐步走」是硬不变式：任何一帧里显示值最多 +1%，攒下的时间一律丢弃。
 * 迟到的采样（进程被阻塞、窗口被挂起）不会在恢复后的第一帧里把几十个百分点一次性画出来。
 * 代价：采样频率低于 stepMs 时走得更慢 —— 宁可慢，不要跳。
 */
export const PACED_MAX_STEPS_PER_CALL = 1;

export interface PacedPace {
  stepMs: number;
  easeAfter: number;
  slowStepMs: number;
}

export const PACED_DEFAULTS: PacedPace = {
  stepMs: PACED_STEP_MS,
  easeAfter: PACED_EASE_AFTER,
  slowStepMs: PACED_SLOW_STEP_MS,
};

/** 节拍器状态：当前显示值 + 上一次推进的时刻。 */
export interface PacedState {
  shown: number;
  lastStepAt: number;
}

/** `advancePaced` 的额外开关。 */
export interface PacedAdvanceOptions {
  /** 工作已结束（真实值到 100）：收尾改走快速档，别用慢档把最后几格拖十几秒。 */
  done?: boolean;
}

export function clampPercent(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/**
 * 用户是否要求「减少动态效果」。真值时**不叠加节拍**，只报真实值 —— 假动效也是一种欺骗。
 * SSR / 无 matchMedia 环境 → false（fail-soft：拿不准就走默认）。
 */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/**
 * 让显示值向真实值靠拢**一步** —— 每次调用最多 +1%，永不越过 `floor(真实值)`。
 *
 * @param state 当前状态
 * @param realPercent 真实百分比（0..100）
 * @param at 当前时刻（epoch ms）
 * @param pace 节拍参数（默认与浏览器/CLI 侧同一套）
 * @param options `done` → 收尾改走快速档（慢档会把最后几格拖成十几秒的长等待）
 * @returns 新状态（不修改入参）
 */
export function advancePaced(
  state: PacedState,
  realPercent: number,
  at: number,
  pace: PacedPace = PACED_DEFAULTS,
  options: PacedAdvanceOptions = {}
): PacedState {
  const now = Number(at);
  const clock = Number.isFinite(now) ? now : 0;
  const shown = clampPercent(state?.shown);
  const lastStepAt = Number.isFinite(Number(state?.lastStepAt)) ? Number(state.lastStepAt) : clock;
  // 未完成时的天花板 = floor(真实值)：条满不到真实进度之外，真实值没到 100 就绝不出 100。
  const limit = Math.min(100, Math.floor(clampPercent(realPercent)));

  if (shown >= limit) {
    return { shown, lastStepAt: Math.max(lastStepAt, clock) };
  }
  // 收尾（真实值已到 100）走快速档：目标就在眼前，用慢档拖着走完是最坏的观感。
  const rate = options.done
    ? pace.stepMs
    : shown < pace.easeAfter
      ? pace.stepMs
      : pace.slowStepMs;
  // 攒下的时间只保留一步的量 —— 「一下加载百分之几十」的拦口就在这一行。
  const baseline = clock - lastStepAt > rate ? clock - rate : lastStepAt;
  if (clock - baseline < rate) {
    return { shown, lastStepAt: baseline };
  }
  return {
    shown: shown + PACED_MAX_STEPS_PER_CALL,
    lastStepAt: baseline + rate * PACED_MAX_STEPS_PER_CALL,
  };
}