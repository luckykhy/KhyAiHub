<template>
  <div v-if="text" class="load-error-banner">
    <el-alert class="load-error-text" :closable="false" :title="text" type="error" />
    <!-- 失败横幅必须自带一个出口：只报错不给动作，用户除了刷新整页无处可去。 -->
    <slot name="action" />
  </div>
</template>

<script setup>
import { computed } from 'vue';

// Renders a load failure the view can no longer hide. Paired with
// useLoadError() from @/api/loadError.
//
// Accepts either a plain string or a Vue ref, so it can sit next to composable
// state without each view hand-unwrapping it in the template.
const props = defineProps({
  message: {
    type: [String, Object],
    default: '',
  },
});

const text = computed(() => String(props.message?.value ?? props.message ?? ''));
</script>

<style scoped>
.load-error-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.load-error-text {
  flex: 1;
  min-width: 0;
}
</style>
