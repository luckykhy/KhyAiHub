<template>
  <span
    class="khy-avatar"
    :style="{ width: `${props.size}px`, height: `${props.size}px` }"
    role="img"
    :aria-label="props.label || '用户'"
  >
    <KhyIcon kind="user" color="var(--khy-white, #fff)" :glow="false" />
  </span>
</template>

<script setup>
// KhyAvatar — 用户头像。渐变圆形底 + SVG 人形轮廓,取代首字母头像:
// 用户名首字母会随账号变化、观感廉价,几何人形在任意账号名下保持一致。
// 字号语义由 label 保留(无障碍朗读),视觉不再依赖文字。
import KhyIcon from './KhyIcon.vue';

const props = defineProps({
  size: { type: Number, default: 30 },
  label: { type: String, default: '' },
});
</script>
