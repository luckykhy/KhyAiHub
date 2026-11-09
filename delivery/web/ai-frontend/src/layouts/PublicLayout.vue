<template>
  <div class="public-shell">
    <div v-if="branded" class="public-brand">
      <KhyLogo size="sm" />
      <span class="public-name">KHY AI</span>
    </div>
    <div class="public-body">
      <slot />
    </div>
  </div>
</template>

<script setup>
// PublicLayout — the shared container for every page rendered outside
// Layout.vue: /login, /forgot-password and the status pages (/401 /403 /404 /500).
//
// It deliberately does NOT emit <html>/<head>/<body>: index.html owns the
// document shell, and a <title> rendered into #app would never reach the
// browser tab. Document titles are set once, by router.afterEach.
defineOptions({ name: 'PublicLayout' });

// 品牌标走 KhyLogo 单一真源(品牌渐变 + SVG 字形)：此前这里是一个排版的字母「K」,
// 底色取 --khy-bg-card-grad(亮色下近白)、前景却是 --khy-white,亮色主题下白字白底。
import KhyLogo from '@/components/KhyLogo.vue';

defineProps({
  // Status pages carry the compact brand bar. /login and /forgot-password each
  // render their own larger brand inside the card, so both pass
  // :branded="false" to avoid a doubled logo.
  branded: {
    type: Boolean,
    default: true,
  },
});
</script>

<style scoped>
.public-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
  padding: 32px 20px;
}

.public-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.public-name {
  font-size: 16px;
  font-weight: 700;
  color: var(--khy-text-strong);
}

.public-body {
  width: 100%;
  display: flex;
  justify-content: center;
}
</style>
