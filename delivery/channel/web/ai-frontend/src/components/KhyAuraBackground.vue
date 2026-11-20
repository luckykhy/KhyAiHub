<template>
  <canvas ref="canvasEl" class="khy-aura" aria-hidden="true"></canvas>
</template>

<script setup>
// KhyAuraBackground — 克制的 WebGL 氛围背景层（薄封装）。
//
// 接入方式（本组件刻意不接进任何页面，需人工决定落点后手动挂载）：
//   放在一个 position: relative 的容器里、铺满即可；组件自身
//   position:absolute; inset:0; pointer-events:none; aria-hidden，不接收交互、
//   不产生 tab 焦点，只做背景：
//
//     <div class="page-host">            <!-- 需要 position: relative -->
//       <KhyAuraBackground />
//       <main class="page-content">…</main>
//     </div>
//
//   建议容器用 var(--khy-bg-main) 之类的底色，aura 以低 alpha 叠在其上。
//
// 降级：WebGL 不可用 / 模块加载失败 -> 组件静默为透明（controller 为 null）；
// prefers-reduced-motion: reduce -> 模块只画一帧静态图、不跑动画循环；
// 卸载 -> destroy() 释放 GL 资源。模块为框架无关的 ES 模块（零新依赖），
// 这里按需动态 import，避免进主包。
import { onBeforeUnmount, onMounted, ref } from 'vue';

const canvasEl = ref(null);
let controller = null;
let cancelled = false;

onMounted(async () => {
  const el = canvasEl.value;
  if (!el) return;
  try {
    const mod = await import('../webgl/khyAura3d.js');
    if (cancelled) return;
    controller = mod.createKhyAura3d(el, { intensity: 0.5 });
  } catch {
    // WebGL 缺失 / 模块不可达 —— 保持空背景，不抛、不提示。
    controller = null;
  }
});

onBeforeUnmount(() => {
  cancelled = true;
  if (controller) {
    try {
      controller.destroy();
    } catch {
      // 已在卸载路径上，释放失败无补救动作。
    }
    controller = null;
  }
});
</script>

<style scoped>
.khy-aura {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
  z-index: 0;
}
</style>
