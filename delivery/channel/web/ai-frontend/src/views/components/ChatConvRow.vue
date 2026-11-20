<template>
  <!-- A single conversation row in the sidebar tree. Extracted so the
       two-level foldered sidebar (sub-group items + loose items) can render
       it in two places without duplicating ~50 lines of markup. The parent
       owns drag state and long-press wiring; this row only emits a
       `pressstart` event carrying the native PointerEvent for the parent to
       enter drag mode. -->
  <div
    :class="['chat-conv-item', { active, dragging }]"
    :data-draggable="dragActive ? '1' : null"
    :data-id="conv.id"
    role="button"
    :tabindex="0"
    :aria-label="`打开对话 ${conv.title} · 长按可拖动排序`"
    @click="emit('select', conv.id)"
    @keydown.enter.prevent="emit('select', conv.id)"
    @keydown.space.prevent="emit('select', conv.id)"
    @pointerdown="emit('pressstart', $event)"
  >
    <div class="chat-conv-main">
      <div class="chat-conv-title" :title="conv.title">{{ conv.title }}</div>
      <div class="chat-conv-time">{{ relativeTime(conv.updatedAt) }}</div>
    </div>
    <div class="chat-conv-ops">
      <el-dropdown
        trigger="click"
        @click.stop
        @command="(gid) => emit('move', gid === '' ? null : Number(gid))"
      >
        <button
          type="button"
          class="chat-conv-op-btn chat-conv-move"
          title="移入分组"
          :aria-label="`移动对话 ${conv.title} 到分组`"
          @click.stop
        >
          <el-icon><FolderOpened /></el-icon>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="">移出分组</el-dropdown-item>
            <el-dropdown-item v-if="groups.length" divided disabled>移入分组</el-dropdown-item>
            <el-dropdown-item
              v-for="g in groups"
              :key="g.id"
              :command="String(g.id)"
            >{{ g.name }}</el-dropdown-item>
            <el-dropdown-item v-if="!groups.length" disabled>暂无分组，请先新建</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <button
        type="button"
        class="chat-conv-op-btn"
        title="重命名"
        :aria-label="`重命名对话 ${conv.title}`"
        @click.stop="emit('rename', conv)"
      >
        <el-icon><EditPen /></el-icon>
      </button>
      <button
        type="button"
        class="chat-conv-op-btn chat-conv-op-btn-danger"
        title="删除"
        :aria-label="`删除对话 ${conv.title}`"
        @click.stop="emit('delete', conv)"
      >
        <el-icon><Delete /></el-icon>
      </button>
    </div>
  </div>
</template>

<script setup>
import { FolderOpened, EditPen, Delete } from '@element-plus/icons-vue';

defineProps({
  conv: { type: Object, required: true },
  active: { type: Boolean, default: false },
  dragging: { type: Boolean, default: false },
  dragActive: { type: Boolean, default: false },
  groups: { type: Array, default: () => [] },
  relativeTime: { type: Function, required: true },
});

const emit = defineEmits(['select', 'rename', 'delete', 'move', 'pressstart']);
</script>
