<template>
  <svg
    class="khy-mark"
    :class="props.size ? 'khy-mark--' + props.size : undefined"
    viewBox="0 0 128 128"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    :aria-label="props.ariaLabel || 'Khy OS'"
  >
    <defs>
      <linearGradient :id="gradId" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="var(--khy-brand-from, #FFC078)" />
        <stop offset="1" stop-color="var(--khy-brand-to, #E2703A)" />
      </linearGradient>
    </defs>
    <g :fill="paint">
      <path v-for="(d, i) in BLADES" :key="`blade-${i}`" :d="d" />
    </g>
    <path :d="CORE" fill-rule="evenodd" :fill="paint" />
  </svg>
</template>

<script setup>
// KhyMark — Khy OS 品牌主标（内核环）。
//
// 形态：四段弧叶围成的光圈（= 四条主张）+ 中心菱形内核（= kernel / runtime），
// 内核上刻一道 K 形负槽（= 品牌字母，可发现但不主导读感）。
//
// 几何真源：delivery/brand/khy-brand-geometry.js —— 本组件里的路径数据是它的**副本**，
// 由 `delivery/web/ai-frontend/tests/khyBrandMark.test.js` 断言两者逐字节一致。
// 改形状请改真源后跑 `node scripts/brand/build-brand-assets.js`，不要手改这里。
//
// 为什么不用 <img src="...svg">：主标要在不同底色上换色（琥珀 / 墨黑 / 纸白），
// 内联才能用 currentColor 与 CSS 变量驱动。
import { computed } from 'vue';

// 唯一实例 id：同页可能出现多个主标，渐变 id 必须互不覆盖。
let seq = 0;
const gradId = `khyMarkGrad${++seq}`;

const BLADES = [
  'M 101.532 69.945 A 38 38 0 0 1 69.945 101.532 L 61.647 90.897 A 27 27 0 0 0 88.854 74.55 Z',
  'M 58.055 101.532 A 38 38 0 0 1 26.468 69.945 L 37.103 61.647 A 27 27 0 0 0 53.45 88.854 Z',
  'M 26.468 58.055 A 38 38 0 0 1 58.055 26.468 L 66.353 37.103 A 27 27 0 0 0 39.146 53.45 Z',
  'M 69.945 26.468 A 38 38 0 0 1 101.532 58.055 L 90.897 66.353 A 27 27 0 0 0 74.55 39.146 Z',
];

// 菱形内核 + K 形负槽（evenodd ⇒ 槽是真洞，不是描边）。
const CORE =
  'M 64 45 L 83 64 L 64 83 L 45 64 Z ' +
  'M 56 74 L 60 74 L 60 54 L 56 54 Z ' +
  'M 60 66.75 L 70 59.5 L 70 54 L 60 61.25 Z ' +
  'M 60 66.75 L 70 74 L 70 68.5 L 60 61.25 Z';

const props = defineProps({
  /** 尺寸档：sm / md / lg。留空则**由父级 CSS 决定尺寸**（品牌块里就是这么用的）。 */
  size: { type: String, default: '' },
  /** 着色：color = 琥珀渐变；ink = 单色墨黑；paper = 单色纸白。 */
  tone: { type: String, default: 'color' },
  ariaLabel: { type: String, default: '' },
});

const paint = computed(() => {
  if (props.tone === 'ink') return 'var(--khy-brand-ink, #14110E)';
  if (props.tone === 'paper') return 'var(--khy-brand-paper, #F6F2EC)';
  return `url(#${gradId})`;
});
</script>

<style scoped>
/* 只声明显式尺寸档；不设 width/height 的默认态由父级 CSS 决定尺寸，
   避免与全局主题表里的 .khy-brand-logo .khy-mark 抢特异性。 */
.khy-mark {
  display: block;
}
.khy-mark--sm {
  width: 18px;
  height: 18px;
}
.khy-mark--md {
  width: 24px;
  height: 24px;
}
.khy-mark--lg {
  width: 30px;
  height: 30px;
}
</style>
