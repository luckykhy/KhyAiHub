/**
 * usePacedProgress — 把 pacedProgress 的节拍器接进 Vue 的响应式系统。
 *
 * 用法（不确定进度：条自己 1% 1% 地走）：
 *   const { percent, bar } = usePacedProgress();
 *   // 完成后调用 finish() 让它到 100 并停表
 *
 * 用法（确定进度：条 1% 1% 地追赶真实值，永不越过）：
 *   const { percent } = usePacedProgress({
 *     determinate: true,
 *     startPercent: Number(props.card.progressPct) || 0,  // 中途挂载时先落在真实值上，不从 0 重来
 *     source: () => Number(props.card.progressPct) || 0, // 真实值一变就 1% 1% 地追上去
 *   });
 *   // source 每变一次都会被 observe() 一次
 *
 * 行为契约（与后端 progressiveProgress 一致）：
 *   · 每 RENDER_MS 重画一次，**每次采样最多 +1%**（攒下的时间由引擎丢弃，所以事件稀疏时
 *     也不会一跳几十个百分点）；用户看到的是「1% 1% 地加载」；
 *   · 单调不减；不确定进度在 `TAIL_CAP`（99）之前一直在动 —— `cap`（96）只是换档点，
 *     过它转尾巴档继续爬，长任务不会冻在一个数上；
 *   · 到 100 的唯一入口是 `finish()`（或确定进度下真实值真的到 100）；**两者都不跳 100** ——
 *     收尾由同一套 1%/帧的节拍走过去（`settleMs` 是收尾的总时限，到点就停表，条停在原地）；
 *   · 组件卸载即停表（`onBeforeUnmount`），不留空转定时器；已静止（`pacer.settled()`）也停表。
 *   · `prefers-reduced-motion: reduce` → 不叠加节拍，只报真实值。
 */
import { computed, getCurrentInstance, onBeforeUnmount, ref, watch } from 'vue';
import { CAP, RENDER_MS, createPacer, prefersReducedMotion, renderBar } from './pacedProgress.js';

/**
 * @param {object} [options]
 * @param {boolean} [options.determinate=false] 真实分母是否已知（决定追赶真实值还是逼近天花板）
 * @param {() => number} [options.source] 真实百分比来源（0..100）；给了它就会被持续 observe
 * @param {number} [options.startPercent=0] 起始百分比
 * @param {boolean|import('vue').Ref<boolean>|(() => boolean)} [options.active=true]
 *   是否正在等待。**给它 getter 或 ref**（如 `() => isLoading.value`）才能跟随状态变 ——
 *   传一个静态布尔值等于「永远不改」，节拍不会启动。
 * @param {number} [options.settleMs=1200] 收尾时限：`finish()` 之后条还要 1% 1% 地走完剩下的
 *   距离，但最多走这么久（到点即停表，条停在原地由调用方收起）。`cap:96` 起步只需 4 帧
 *   （约 0.6 秒），所以默认值只对「离 100 还很远就宣告结束」的情形生效 —— 那种情况本就不该
 *   拖着条走十几秒。
 * @param {number} [options.stepMs] / [options.slowStepMs] / [options.easeAfter] / [options.cap]
 * @returns {{ percent: import('vue').Ref<number>, bar: import('vue').ComputedRef<string>,
 *            isDone: import('vue').Ref<boolean>, isFinished: import('vue').Ref<boolean>,
 *            finish: () => void, observe: (v: number) => void, reset: () => void }}
 */
export function usePacedProgress(options = {}) {
  const {
    determinate = false,
    source = null,
    startPercent = 0,
    active = true,
    settleMs = 1200,
    stepMs,
    slowStepMs,
    easeAfter,
    cap,
    barWidth = 20,
  } = options;

  // active 允许三种形态：静态布尔 / ref / getter。用 getter 读它，watch 才能跟踪其
  // 内部的响应式依赖（静态布尔读出来恒定，watch 永不触发 —— 那是「条不动」的静默 bug）。
  const readActive = () => {
    if (typeof active === 'function') return !!active();
    if (active && typeof active === 'object' && 'value' in active) return !!active.value;
    return active === undefined ? true : !!active;
  };

  const staticMode = prefersReducedMotion();
  const pacer = createPacer({
    determinate,
    static: staticMode,
    startPercent,
    pace: { stepMs, slowStepMs, easeAfter, cap },
  });

  const percent = ref(pacer.percent());
  const isDone = ref(pacer.isDone());
  const isFinished = ref(pacer.isFinished());
  let timer = null;
  // 收尾时限（仅 finish() 会设）：到点即停表，条停在当下的位置 —— 绝不为了「走完」而
  // 把收尾拉成一个长等待（那正是用户否掉的另一种观感）。
  let finishDeadline = 0;

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function readSource() {
    if (typeof source !== 'function') return;
    try {
      pacer.observe(source());
    } catch {
      /* 来源抛异常绝不拖垮进度显示 */
    }
  }

  /**
   * 停表判据：没有任何东西可动了就不该留着定时器空转。
   *   · 减少动效档 / 确定进度追平 `floor(真实值)` / 不确定进度走到 `TAIL_CAP`（99）→ 引擎
   *     自己会给出「已静止」（`pacer.settled()`）。
   *   · `finish()` 之后的收尾：条还要 1% 1% 地走，但**最多走到收尾时限**。
   * 最后一条很要紧：看板上几十张卡片的确定进度追平后各自停表，否则每张卡都挂着定时器。
   */
  function settled(shown) {
    if (pacer.settled()) return true;
    if (finishDeadline && Date.now() >= finishDeadline) return true;
    // 兜底：确定进度追平真实值后没有东西可动（`pacer.settled()` 已覆盖，这里防引擎旧口径）。
    if (determinate && shown >= Math.floor(pacer.real())) return true;
    return false;
  }

  function sample() {
    readSource();
    const next = pacer.percent();
    // 只在真的变了才写 ref —— 同一个数反复赋值会让 Vue 的 watcher 空转。
    if (next !== percent.value) percent.value = next;
    isDone.value = pacer.isDone();
    isFinished.value = pacer.isFinished();
    if (settled(next)) stopTimer();
  }

  function startTimer() {
    if (timer || staticMode) return;
    timer = setInterval(sample, RENDER_MS);
    // Node（SSR / 组合式函数单测）下别让定时器吊住事件循环。
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  watch(
    readActive,
    (isActive) => {
      if (!isActive) {
        stopTimer();
        return;
      }
      // 节拍基准收到此刻 —— 让激活后的第一步落在整整一个 rate 之后，而不是立刻走一格。
      // （引擎自己已经会丢弃迟到的时间债，「不跳」不靠这一行兜底；这里只是把启动时序对齐。）
      // 只收基准、**不动显示值**：确定进度在激活时回退会破坏「单调不减」。
      // 需要整段重来的消费方自己调 `reset()`（见 GlobalProgressBar 的新一轮请求）。
      pacer.rebase();
      sample();
      startTimer();
    },
    { immediate: true }
  );

  // 真实值随时可能变（HTTP 完成数、已加载分片数）→ 立刻采一次，别等下一个 160ms。
  // 注意：source 是一个 getter，watch(getter) 会跟踪它读到的响应式依赖，所以
  // 「已加载 3/10 个分片」这类状态一变就会重采 —— 无需调用方再手动 observe()。
  if (typeof source === 'function') {
    watch(source, () => {
      // 「目标变了」：把基准收到此刻，让这次追赶从当下起算（同样是时序对齐，不是防跳 ——
      // 引擎已负责「一次采样最多 +1%」，所以 33% 的卡涨到 67% 也是 34 帧走上去的）。
      pacer.rebase();
      sample();
      if (readActive() && !settled(pacer.percent())) startTimer();
    });
  }

  // 组件内才有生命周期钩子；在组件外（组合式函数单测 / 非组件上下文）调用时不能依赖它，
// 否则 Vue 会打一条「onBeforeUnmount is called when there is no active component instance」。
  if (getCurrentInstance()) {
    onBeforeUnmount(stopTimer);
  }

  return {
    percent,
    // 条由 percent 派生 —— computed 必须真的依赖响应式源，否则永远不重算。
    bar: computed(() => renderBar(percent.value, barWidth)),
    isDone,
    isFinished,
    /**
     * 声明「工作结束」。**不再**把显示值直接赋成 100 —— 那一跳就是用户说的
     * 「卡在一个地方很久、然后突然加载完成」。现在它只把目标设成终态，剩下的一点点距离
     * 由同一套 1%/帧的节拍走过去（96 → 100 四帧），并以 `settleMs` 为总时限：离 100 还很远
     * 就宣告结束时，到点即停表，条停在原地（调用方自己收起，观感上也不跳）。
     */
    finish() {
      pacer.finish();
      finishDeadline = Date.now() + Math.max(0, Number(settleMs) || 0);
      percent.value = pacer.percent();
      isDone.value = pacer.isDone();
      isFinished.value = pacer.isFinished();
      // 收尾期仍要重画（只有真静止 / 不活跃才不挂表）。
      if (readActive() && !pacer.settled()) startTimer();
      else stopTimer();
    },
    observe(v) {
      pacer.observe(v);
      sample();
    },
    reset() {
      stopTimer();
      finishDeadline = 0;
      pacer.reset();
      percent.value = pacer.percent();
      isDone.value = pacer.isDone();
      isFinished.value = pacer.isFinished();
      // 复位也要把节拍**接回来**：调用方常在「仍在等待」时开新一段（例如收尾窗口内又来了
      // 一个请求 —— 那时 active 一直是 true，`watch(readActive)` 不会触发），只停不启就会
      // 让新一段等待冻在 startPercent 上。这正是本模块要消灭的观感。
      if (readActive() && !pacer.settled()) startTimer();
    },
    /** 供测试/覆盖率观察（天花板口径）。 */
    cap: CAP,
  };
}

export default usePacedProgress;