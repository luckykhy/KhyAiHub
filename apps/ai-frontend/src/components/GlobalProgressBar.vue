<!--
  GlobalProgressBar.vue — 视口顶部那条细进度条：只要有请求在飞、或路由在切换
  （含首次访问的懒加载分块下载），它就出现，让界面永远不像卡住。

  行为：由 @khy/ui-shared 的渐进节拍器（usePacedProgress）驱动。它并不知道任意请求的
  真实百分比，所以**以 1% 的步长、每 160ms 一格**向前走（「宁可慢一些，1% 1% 地加载」），
  过七成后换慢档、到 96% 再换尾巴档继续爬，长窗口下它**一直在动**，既不会撞在一个数上
  静止，也不会一跳几十个百分点。
  加载结束（`finish()`）**不虚报完成、也不跳 100**：条在收尾窗口里继续 1% 1% 地走几格
  再淡出。到 100 的唯一入口是 `finish()` 加真正走完 —— 而这条细条从不等那几秒，因为
  它的职责是「有活在干」，不是「精确报数」。

  历史实现是「指数逼近 90%」（`width += (90 - width) * 0.12`，每 280ms）：起步几跳很大
  （10 → 20 → 29 …）随后越爬越慢、无限逼近 90 却几乎不动，观感就是「卡在 88%」。改成
  固定 1% 步长后，用户能数出进度在走 —— 这正是本次要的观感。
-->
<template>
  <div
    class="global-progress"
    :class="{ 'is-visible': visible }"
    role="progressbar"
    aria-label="加载进度"
    :aria-valuenow="Math.round(width)"
    aria-valuemin="0"
    aria-valuemax="100"
  >
    <div class="global-progress__bar" :style="{ width: `${width}%` }"></div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useGlobalLoading } from '@/composables/useGlobalLoading';
import { usePacedProgress } from '@khy/ui-shared/progress';

// 从 3% 起步：细条从 0 开始看不出「已经开始了」，而这条本身代表「有活在进行」。
// 刻意**只**给这么小的一截 —— 起步值不来自任何真实数据，给到两位数就成了「一下加载
// 百分之几十」的假进度。此后每 160ms 恰好 +1%，由节拍器负责。
const START_PERCENT = 3;
// 收尾窗口：加载结束后条**不跳到 100**，而是在这段时间里继续 1% 1% 地走（约 4 格）再淡出。
// 窗口刻意给得短 —— 这条不代表真实进度，拉长只会让一段**已经结束**的等待看起来还没结束。
// （旧实现是 loading 一转 false 就把宽度赋成 100：从哪个数都直接跳满，正是用户说的
// 「卡在一个地方很久，然后突然加载完成」。）
const SETTLE_MS = 600;

const { isLoading } = useGlobalLoading();

const visible = ref(false);
const settling = ref(false);
let doneTimer = null;

// active 必须传 getter（不是静态布尔）：只有 getter 才能让节拍器跟随状态启停。
// 收尾窗口里同样算「活跃」—— 否则节拍一停，条就冻在最后一个数上，又回到老毛病。
const paced = usePacedProgress({
  active: () => isLoading.value || settling.value,
  startPercent: START_PERCENT,
  settleMs: SETTLE_MS,
});

// 条与读数同源：都由节拍器出（它 1% 1% 地走，收尾那几格也不跳）。
const width = computed(() => (isLoading.value || settling.value ? paced.percent.value : 0));

function clearDoneTimer() {
  if (doneTimer) {
    clearTimeout(doneTimer);
    doneTimer = null;
  }
}

watch(
  isLoading,
  (loading) => {
    clearDoneTimer();
    if (loading) {
      settling.value = false;
      visible.value = true;
      // 新一段加载从 startPercent 重新走 —— 否则会带着上一段的 99% 继续。
      // （`reset()` 自己会把节拍接回来：收尾窗口内又来一个请求时 active 一直是 true，
      // 靠 `watch(active)` 是叫不醒的。）
      paced.reset();
      return;
    }
    if (!visible.value) return;
    // 加载结束：**不**把宽度赋成 100 —— 让条在收尾窗口里继续 1% 1% 地走几格，到点淡出。
    // `finish()` 只设终态目标并记下收尾时限（与这里同一个 SETTLE_MS），不虚报完成。
    settling.value = true;
    paced.finish();
    doneTimer = setTimeout(() => {
      visible.value = false;
      // 这一刻 getter 转 false：节拍器随之停表，不留空转定时器。
      settling.value = false;
    }, SETTLE_MS);
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  clearDoneTimer();
  paced.finish(); // 卸载即停表，不留空转定时器
});
</script>

<style scoped>
.global-progress {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  z-index: 3000;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.32s ease;
}

.global-progress.is-visible {
  opacity: 1;
}

.global-progress__bar {
  height: 100%;
  width: 0;
  background: var(--el-color-primary, var(--khy-primary));
  /* 160ms 线性 = 与节拍器同拍：每一格都看得见，又不显得跳。 */
  transition: width 0.16s linear;
}
</style>