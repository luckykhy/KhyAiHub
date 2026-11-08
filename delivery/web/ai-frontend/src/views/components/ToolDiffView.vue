<template>
  <!--
    ToolDiffView — 红绿 ± 行视图。
    行模型由后端 cli/writeDiffRows.buildWriteDiffRows 产出（与桌面端、终端同一真源），
    这里只负责画：kind = add/del/ctx/gap/meta/more。
  -->
  <div :class="['tool-diff', { 'is-embedded': embedded }]">
    <div class="tool-diff-head">
      <el-icon class="tool-diff-ico"><Document /></el-icon>
      <span class="tool-diff-path" :title="diff.filePath">{{ diff.filePath || '改动' }}</span>
      <span v-if="diff.added > 0" class="tool-diff-added">+{{ diff.added }}</span>
      <span v-if="diff.removed > 0" class="tool-diff-removed">-{{ diff.removed }}</span>
      <button
        v-if="hidden > 0"
        type="button"
        class="tool-diff-toggle"
        @click="showAll = true"
      >
        还有 {{ hidden }} 行未显示
      </button>
    </div>
    <div class="tool-diff-body">
      <div v-for="(row, ri) in shown" :key="ri" :class="['tool-diff-row', `is-${row.kind}`]">
        <template v-if="row.kind === 'add' || row.kind === 'del' || row.kind === 'ctx'">
          <span class="tool-diff-num">{{ row.kind === 'add' ? row.numNew ?? row.num ?? '' : row.num ?? '' }}</span>
          <span class="tool-diff-sign">{{ row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ' }}</span>
          <span class="tool-diff-text">{{ row.text || ' ' }}</span>
        </template>
        <span v-else class="tool-diff-plain">{{ row.text }}</span>
      </div>
      <div v-if="diff.truncated" class="tool-diff-note">
        改动过大，仅传输前 {{ diff.rows.length }} 行（其余未显示）
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { Document } from '@element-plus/icons-vue';

const props = defineProps({
  diff: {
    type: Object,
    required: true,
  },
  /** 嵌在工具卡里时去掉外框，避免卡片套卡片。 */
  embedded: {
    type: Boolean,
    default: false,
  },
});

const COLLAPSED_ROWS = 40;
const showAll = ref(false);

const rows = computed(() => (Array.isArray(props.diff.rows) ? props.diff.rows : []));
const shown = computed(() => (showAll.value ? rows.value : rows.value.slice(0, COLLAPSED_ROWS)));
const hidden = computed(() => rows.value.length - shown.value.length);
</script>

<style scoped>
.tool-diff {
  margin: 6px 0;
  border: 1px solid var(--el-border-color-lighter, var(--khy-border));
  border-radius: 8px;
  overflow: hidden;
  background: var(--khy-card-bg, var(--el-bg-color));
}
.tool-diff.is-embedded {
  margin: 4px 0 0;
}

.tool-diff-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  background: var(--el-fill-color-light, var(--khy-bg-soft));
  border-bottom: 1px solid var(--el-border-color-lighter, var(--khy-border));
  font-size: 12px;
}
.tool-diff-ico {
  color: var(--khy-text-secondary, var(--el-text-color-secondary));
  font-size: 13px;
}
.tool-diff-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--khy-font-mono, monospace);
}
.tool-diff-added {
  color: var(--khy-success, #059669);
  font-family: var(--khy-font-mono, monospace);
  font-size: 11px;
  font-weight: 600;
}
.tool-diff-removed {
  color: var(--khy-danger, #dc2626);
  font-family: var(--khy-font-mono, monospace);
  font-size: 11px;
  font-weight: 600;
}
.tool-diff-toggle {
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font-size: 11px;
  color: var(--khy-primary, var(--el-color-primary));
}
.tool-diff-toggle:hover {
  text-decoration: underline;
}

.tool-diff-body {
  overflow-x: auto;
  padding: 2px 0;
  font-family: var(--khy-font-mono, monospace);
  font-size: 11px;
  line-height: 1.55;
}
.tool-diff-row {
  display: flex;
  min-width: max-content;
  padding-right: 8px;
  white-space: pre;
}
.tool-diff-row.is-add {
  background: var(--khy-success-soft, #ecfdf5);
}
.tool-diff-row.is-del {
  background: var(--khy-danger-soft, #fef2f2);
}
.tool-diff-num {
  flex: 0 0 40px;
  padding: 0 6px;
  text-align: right;
  color: var(--el-text-color-secondary, var(--khy-text-secondary));
  user-select: none;
}
.tool-diff-sign {
  flex: 0 0 14px;
  text-align: center;
  user-select: none;
  color: var(--el-text-color-secondary, var(--khy-text-secondary));
}
.tool-diff-row.is-add .tool-diff-sign {
  color: var(--khy-success, #059669);
}
.tool-diff-row.is-del .tool-diff-sign {
  color: var(--khy-danger, #dc2626);
}
.tool-diff-text {
  flex: 1 1 auto;
}
.tool-diff-plain {
  padding: 0 8px;
  color: var(--el-text-color-secondary, var(--khy-text-secondary));
  user-select: none;
}
.tool-diff-row.is-more .tool-diff-plain {
  color: var(--khy-primary, var(--el-color-primary));
}
.tool-diff-row.is-meta .tool-diff-plain {
  font-weight: 600;
}
.tool-diff-note {
  padding: 2px 8px;
  color: var(--el-color-warning, #d97706);
}
</style>
