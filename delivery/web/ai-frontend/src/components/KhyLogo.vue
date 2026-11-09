<template>
  <span
    class="khy-brand-logo"
    :class="`khy-brand-logo--${props.size}`"
    role="img"
    :aria-label="props.ariaLabel || 'Khy OS'"
  >
    <KhyMark aria-hidden="true" />
  </span>
</template>

<script setup>
// KhyLogo — 品牌标志。墨黑圆角底 + 内核环主标(KhyMark)。
//
// 为什么换成主标而不是字母 K：旧的品牌块里排版的是一个字母「K」，
// 五端各画各的（Web 画 K、APK 排版 Text('K')、桌面端一个 ico），
// 是 [DESIGN-ARCH-134] §1.1 B3 登记的「三枚品牌标记并存」病灶。
// 现在五端共用同一枚主标 —— 几何真源 delivery/brand/khy-brand-geometry.js。
//
// 尺寸沿用 .khy-brand-logo--{sm,md,lg} 既有刻度。
import KhyMark from './KhyMark.vue';

const props = defineProps({
  size: { type: String, default: 'sm' },
  ariaLabel: { type: String, default: '' },
});
</script>
