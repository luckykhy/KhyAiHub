<template>
  <span
    class="khy-brand-logo"
    :class="`khy-brand-logo--${props.size}`"
    role="img"
    :aria-label="props.ariaLabel || 'KHY'"
  >
    <KhyIcon kind="logo" color="var(--khy-white, #fff)" :glow="false" />
  </span>
</template>

<script setup>
// KhyLogo — 品牌标志。渐变圆角底 + SVG 绘制的 K 单标(KhyIcon kind="logo"),
// 取代此前直接排版的字母 "K":字形是画出来的几何笔画,不随字体渲染变化,
// 亮暗主题下都由 CSS 变量取白。尺寸沿用 .khy-brand-logo--{sm,md,lg} 既有刻度。
import KhyIcon from './KhyIcon.vue';

const props = defineProps({
  size: { type: String, default: 'sm' },
  ariaLabel: { type: String, default: '' },
});
</script>
