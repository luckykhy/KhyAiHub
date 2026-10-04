<template>
  <el-image
    v-if="state === 'ready'"
    class="chat-attachment-thumb"
    :src="blobUrl"
    :preview-src-list="[blobUrl]"
    preview-teleported
    fit="cover"
    :alt="att.name"
  />
  <span
    v-else-if="state === 'error'"
    class="chat-attachment-chip chat-attachment-expired"
    :title="`附件已不可用：${att.name}`"
  >
    <el-icon class="chat-attachment-ico"><component :is="iconFor(att.kind)" /></el-icon>
    <span class="chat-attachment-name">{{ att.name }}</span>
    <span class="chat-attachment-badge">附件已不可用</span>
  </span>
  <button
    v-else
    type="button"
    class="chat-attachment-chip"
    :title="att.name"
    @click="onChipClick"
  >
    <el-icon class="chat-attachment-ico"><component :is="iconFor(att.kind)" /></el-icon>
    <span class="chat-attachment-name">{{ att.name }}</span>
  </button>
</template>

<script setup>
// MessageAttachment — [DESIGN-ARCH-163] D9 输出区附件回显子组件。
// 关键约束（P4）：/api/ai/upload/:id 只认 Bearer/X-API-Key 头，裸 <img src> /
// <a href> 导航必然 401（实测见设计文档 D9 节）——所以缩略图与下载一律走
// authedFetch → blob → objectURL。blob 地址按附件 url 模块级缓存，同回合
// 多处引用只取一次；超过上限按插入序回收最早的 objectURL。
import { ref, onMounted } from 'vue';
import { Picture, VideoCamera, Headset, Document, Files, Folder } from '@element-plus/icons-vue';
import request from '@/api/request';
import { authedFetch } from '@/api/authedFetch';
import { isImageAttachment, downloadFileName } from '@/utils/attachmentView';

const props = defineProps({
  att: { type: Object, required: true },
});

const ICONS = {
  image: Picture,
  video: VideoCamera,
  audio: Headset,
  document: Document,
  text: Document,
  code: Document,
  archive: Folder,
  other: Files,
};
function iconFor(kind) {
  return ICONS[kind] || Files;
}

function resolveApiUrl(path) {
  const base = String(request.defaults.baseURL || '').trim();
  if (!base) return path;
  return `${base.replace(/\/+$/, '')}${path}`;
}

// ── 认证 blob 通道（模块级共享缓存）────────────────────────────────────────
const MAX_CACHED = 64;
const _blobCache = new Map(); // attachment url -> Promise<string|null>
const _order = []; // 插入序 { key, objectUrl }，用于封顶回收

function _remember(key, objectUrl) {
  _order.push({ key, objectUrl });
  while (_order.length > MAX_CACHED) {
    const dead = _order.shift();
    _blobCache.delete(dead.key);
    try {
      URL.revokeObjectURL(dead.objectUrl);
    } catch {
      /* noop */
    }
  }
}

function attachmentBlobUrl(att) {
  const key = att.url;
  if (!_blobCache.has(key)) {
    const p = (async () => {
      try {
        // silent：附件取不到不应触发整页登出跳转；401/404 都收敛为「不可用」。
        const res = await authedFetch(resolveApiUrl(key), { silent: true });
        if (!res.ok) return null;
        const objectUrl = URL.createObjectURL(await res.blob());
        _remember(key, objectUrl);
        return objectUrl;
      } catch {
        return null;
      }
    })().then((u) => {
      if (!u) _blobCache.delete(key); // 失败不缓存，下次点击可重试
      return u;
    });
    _blobCache.set(key, p);
  }
  return _blobCache.get(key);
}

// ── 组件态机：idle（chip）→ loading → ready（图）/ error（灰置不可用）────────
const isImage = isImageAttachment(props.att);
const state = ref(isImage ? 'loading' : 'idle');
const blobUrl = ref('');

onMounted(() => {
  if (isImage) {
    ensureBlob().then((u) => {
      if (u) {
        blobUrl.value = u;
        state.value = 'ready';
      } else {
        state.value = 'error';
      }
    });
  }
});

async function ensureBlob() {
  return attachmentBlobUrl(props.att);
}

async function onChipClick() {
  const u = await ensureBlob();
  if (!u) {
    state.value = 'error';
    return;
  }
  const a = document.createElement('a');
  a.href = u;
  a.download = downloadFileName(props.att);
  document.body.appendChild(a);
  a.click();
  a.remove();
}
</script>

<style scoped>
/* 与 AIChat.vue 气泡 chip 同款视觉（那边 style 是 scoped，组件内自带一份）。 */
.chat-attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 200px;
  padding: 3px 8px;
  border-radius: 12px;
  border: none;
  background: rgba(255, 255, 255, 0.18);
  font-size: 12px;
  font-family: inherit;
  color: inherit;
  cursor: pointer;
}

.chat-attachment-chip:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
}

.chat-attachment-ico {
  flex: 0 0 auto;
}

.chat-attachment-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-attachment-badge {
  flex: 0 0 auto;
  color: var(--el-text-color-secondary, var(--khy-gray-400));
}

.chat-attachment-expired {
  cursor: default;
  opacity: 0.6;
}

.chat-attachment-thumb {
  width: 72px;
  height: 72px;
  border-radius: 8px;
  cursor: zoom-in;
  overflow: hidden;
}
</style>
