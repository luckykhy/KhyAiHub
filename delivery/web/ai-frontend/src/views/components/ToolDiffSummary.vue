<template>
  <!-- 本轮文件改动汇总：把一条消息里所有红绿 diff 收在一处，避免用户逐张工具卡翻。 -->
  <div class="tool-diff-summary">
    <button
      type="button"
      class="tool-diff-summary-head"
      :aria-expanded="expanded ? 'true' : 'false'"
      @click="expanded = !expanded"
    >
      <el-icon class="tool-diff-summary-caret" :class="{ 'is-open': expanded }">
        <CaretRight />
      </el-icon>
      <span class="tool-diff-summary-title">本轮文件改动</span>
      <span class="tool-diff-summary-count">{{ files.length }} 个文件</span>
      <span v-if="totalAdded > 0" class="tool-diff-summary-added">+{{ totalAdded }}</span>
      <span v-if="totalRemoved > 0" class="tool-diff-summary-removed">-{{ totalRemoved }}</span>
    </button>
    <div v-if="expanded" class="tool-diff-summary-body">
      <div v-for="file in files" :key="file.filePath" class="tool-diff-summary-file">
        <button
          type="button"
          class="tool-diff-summary-file-head"
          :aria-expanded="openPath === file.filePath ? 'true' : 'false'"
          @click="openPath = openPath === file.filePath ? null : file.filePath"
        >
          <span class="tool-diff-summary-file-path" :title="file.filePath">{{ file.filePath }}</span>
          <span v-if="file.added > 0" class="tool-diff-summary-added">+{{ file.added }}</span>
          <span v-if="file.removed > 0" class="tool-diff-summary-removed">-{{ file.removed }}</span>
          <span class="tool-diff-summary-action">{{
            openPath === file.filePath ? '收起改动' : '查看改动'
          }}</span>
        </button>
        <ToolDiffView v-if="openPath === file.filePath" :diff="file.diff" embedded />
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { CaretRight } from '@element-plus/icons-vue';
import ToolDiffView from './ToolDiffView.vue';

const props = defineProps({
  files: {
    type: Array,
    default: () => [],
  },
});

const expanded = ref(true);
const openPath = ref(null);

const totalAdded = computed(() => props.files.reduce((sum, f) => sum + (f.added || 0), 0));
const totalRemoved = computed(() => props.files.reduce((sum, f) => sum + (f.removed || 0), 0));
</script>

<style scoped>
.tool-diff-summary {
  margin: 6px 0;
  border: 1px solid var(--el-border-color-lighter, var(--khy-border));
  border-radius: 8px;
  overflow: hidden;
}
.tool-diff-summary-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: var(--el-fill-color-lighter, var(--khy-bg-soft));
  cursor: pointer;
  font-size: 12px;
  text-align: left;
}
.tool-diff-summary-caret {
  font-size: 11px;
  transition: transform 0.15s;
}
.tool-diff-summary-caret.is-open {
  transform: rotate(90deg);
}
.tool-diff-summary-title {
  font-weight: 600;
}
.tool-diff-summary-count {
  color: var(--el-text-color-secondary, var(--khy-text-secondary));
}
.tool-diff-summary-added {
  color: var(--khy-success, #059669);
  font-family: var(--khy-font-mono, monospace);
  font-size: 11px;
}
.tool-diff-summary-removed {
  color: var(--khy-danger, #dc2626);
  font-family: var(--khy-font-mono, monospace);
  font-size: 11px;
}
.tool-diff-summary-body {
  padding: 2px 0;
}
.tool-diff-summary-file + .tool-diff-summary-file {
  border-top: 1px solid var(--el-border-color-lighter, var(--khy-border));
}
.tool-diff-summary-file-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 10px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 12px;
  text-align: left;
}
.tool-diff-summary-file-head:hover {
  background: var(--el-fill-color-lighter, var(--khy-bg-soft));
}
.tool-diff-summary-file-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--khy-font-mono, monospace);
}
.tool-diff-summary-action {
  color: var(--khy-primary, var(--el-color-primary));
  font-size: 11px;
}
</style>
