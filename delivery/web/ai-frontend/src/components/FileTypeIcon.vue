<template>
  <span class="khy-file-ico" :style="boxStyle" aria-hidden="true">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path v-for="(d, i) in paths" :key="i" :d="d" />
    </svg>
  </span>
</template>

<script setup>
import { computed } from 'vue';

/**
 * FileTypeIcon — 附件 chip 的文件格式字形（Web 端）。
 *
 * 与桌面端 apps/khyos-desktop/.../ui/Icon.tsx 的 file-* 同一套形状：文件轮廓取自
 * lucide File，pdf / word / markdown 三个是「轮廓 + 内部字母」的自绘件（lucide 只有
 * 通用文档形，三横线一铺，pdf 与 txt 就分不出来了）。
 *
 * 为什么不复用 KhyIcon：那套带品牌光晕（drop-shadow），12–14px 的 chip 图标会被
 * 糊成一团；文件图标要的是"一眼认出格式"，不是品牌氛围。
 *
 * 默认 tone='inherit' —— 气泡里的 chip 底色深浅不定，图标必须跟着文字色走；
 * 只有在浅底容器（输入区 pending chip）上才用 tone='semantic' 取语义色。
 */
const props = defineProps({
  format: { type: String, default: 'file' },
  size: { type: Number, default: 14 },
  tone: { type: String, default: 'inherit' },
});

// 文件轮廓（lucide File）+ 折角，三个自绘字形共用。
const SHELL = [
  'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
  'M14 2v5a1 1 0 0 0 1 1h5',
];

const ICONS = {
  image: [
    ...SHELL,
    'M10 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    'm20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22',
  ],
  pdf: [...SHELL, 'M9.5 18.5v-8h3.2a2.4 2.4 0 0 1 0 4.8H9.5'],
  doc: [...SHELL, 'M8.5 12.5l1.5 6 2-4.2 2 4.2 1.5-6'],
  sheet: [...SHELL, 'M8 13h2M14 13h2M8 17h2M14 17h2'],
  slide: ['M2 3h20', 'M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3', 'm7 21 5-5 5 5'],
  video: [...SHELL, 'M15.033 13.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56v-4.704a.645.645 0 0 1 .967-.56z'],
  audio: [
    'M11.65 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v10.35',
    'M14 2v5a1 1 0 0 0 1 1h5',
    'M8 20v-7l3 1.474',
    'M8 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  ],
  archive: [
    'M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5',
    'M14 2v5a1 1 0 0 0 1 1h5',
    'M8 12v-1M8 18v-2M8 7V6',
    'M10 20a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
  ],
  code: [...SHELL, 'M10 12.5 8 15l2 2.5m4-5 2 2.5-2 2.5'],
  md: [
    ...SHELL,
    'M7 18.5v-6l2.3 3.2 2.3-3.2v6',
    'M17 12.5v6',
    'm15.2 16.7 1.8 1.8 1.8-1.8',
  ],
  text: [...SHELL, 'M10 9H8M16 13H8M16 17H8'],
  file: SHELL,
};

// 语义色只给「认格式」有惯用色的几个桶（PDF 红 / 表格绿 / 演示橙 / 图片与
// Markdown 品牌色），其余一律跟随文字色 —— 十几个颜色铺在输入区会盖过正文。
const SEMANTIC_TONE = {
  image: 'var(--khy-primary)',
  pdf: 'var(--khy-danger)',
  sheet: 'var(--khy-success)',
  slide: 'var(--khy-warning)',
  md: 'var(--khy-primary)',
};

const paths = computed(() => ICONS[props.format] || ICONS.file);

const boxStyle = computed(() => {
  const color = props.tone === 'semantic' ? SEMANTIC_TONE[props.format] : '';
  return {
    width: `${props.size}px`,
    height: `${props.size}px`,
    ...(color ? { color } : {}),
  };
});
</script>

<style scoped>
.khy-file-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  vertical-align: -0.125em;
}

.khy-file-ico svg {
  width: 100%;
  height: 100%;
}
</style>
