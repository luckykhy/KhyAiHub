<template>
  <div class="khy-page downloads-page">
    <KhyPageHeader title="下载客户端">
      <template #actions>
        <el-button :loading="loading" @click="reload">刷新</el-button>
      </template>
    </KhyPageHeader>

    <el-alert class="honest-note" type="info" :closable="false" show-icon>
      <template #title>四端同源：网页、桌面、安卓、终端</template>
      安装包由后端从构建产物目录直接读取（<code>/api/downloads</code>），不是另一个下载站。
      没有产物时这里会如实说「没有」，并给出发布页或构建方式，不会放一个点了没反应的按钮。
    </el-alert>

    <div v-if="error" class="state-block">
      <KhyEmpty
        :icon="Warning"
        title="安装包清单暂时读不到"
        :description="`后端接口不可达：${error}。确认后端在运行后点「刷新」重试。`"
      >
        <template #action>
          <el-button type="primary" @click="reload">重试</el-button>
        </template>
      </KhyEmpty>
    </div>

    <el-skeleton v-else-if="loading && !loaded" :rows="5" animated />

    <div v-else class="download-cards">
      <div v-for="card in cards" :key="card.key" class="download-card">
        <div class="download-card__head">
          <el-icon class="download-card__icon"><component :is="card.icon" /></el-icon>
          <div>
            <div class="download-card__title">{{ card.title }}</div>
            <div class="download-card__desc">{{ card.desc }}</div>
          </div>
        </div>

        <div v-if="card.artifact" class="download-card__meta">
          <span class="download-card__name">{{ card.artifact.fileName }}</span>
          <span>{{ formatSize(card.artifact.size) }}</span>
          <span>更新于 {{ formatTime(card.artifact.updatedAt) }}</span>
        </div>
        <div v-else class="download-card__meta download-card__meta--missing">
          {{ missingText(card) }}
        </div>

        <div class="download-card__actions">
          <a
            v-if="card.artifact"
            class="el-button el-button--primary el-button--small"
            :href="card.artifact.url"
            :download="card.artifact.fileName"
          >
            下载 {{ card.platformLabel }}
          </a>
          <a
            v-else-if="releasePage"
            class="el-button el-button--small"
            :href="releasePage"
            target="_blank"
            rel="noopener"
          >
            打开发布页
          </a>
          <el-button v-else size="small" disabled>暂无可下载的产物</el-button>
        </div>
      </div>
    </div>

    <p class="downloads-note">
      桌面安装包在 Windows 上需信任开发者签名提示；安卓安装包需要在手机上允许「安装未知来源应用」。
      APK 与桌面端版本号互相独立，按需各自升级。
    </p>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import KhyEmpty from '@/components/KhyEmpty.vue';
import KhyPageHeader from '@/components/KhyPageHeader.vue';
import { downloadsApi } from '@/api/downloads';
import { Monitor, Iphone, Warning } from '@element-plus/icons-vue';

const loading = ref(false);
const loaded = ref(false);
const error = ref('');
const data = ref(null);

const releasePage = computed(() => data.value?.fallback?.releasePage || '');

const cards = computed(() => [
  {
    key: 'desktop',
    icon: Monitor,
    title: 'Windows 桌面版',
    desc: '独立窗口、内置终端与文件编辑，支持随时切到网页版。',
    platformLabel: '桌面版',
    artifact: data.value?.windows || null,
  },
  {
    key: 'android',
    icon: Iphone,
    title: 'Android 版（APK）',
    desc: '手机上连接同一后端，查看任务与对话，随时接管。',
    platformLabel: '安卓版',
    artifact: data.value?.android || null,
  },
]);

function missingText(card) {
  if (releasePage.value) return '本机后端没有该产物：可到发布页获取最新版本。';
  return card.key === 'android'
    ? '本机后端没有 APK：先构建安卓端（产物 dist/android/app-release.apk），或配置 KHY_DOWNLOAD_ANDROID_DIR。'
    : '本机后端没有桌面安装包：先在 apps/khyos-desktop 执行打包（产物 dist-electron），或配置 KHY_DOWNLOAD_DESKTOP_DIR。';
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '大小未知';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

function formatTime(iso) {
  if (!iso) return '未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未知';
  return d.toLocaleString();
}

async function reload() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await downloadsApi.list();
    loaded.value = true;
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(reload);
</script>

<style scoped>
.downloads-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.download-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}
.download-card {
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  padding: 16px;
  background: var(--el-bg-color);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.download-card__head {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.download-card__icon {
  font-size: 26px;
  color: var(--el-color-primary);
}
.download-card__title {
  font-size: 15px;
  font-weight: 600;
}
.download-card__desc {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
}
.download-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.download-card__meta--missing {
  color: var(--el-color-warning);
}
.download-card__name {
  font-family: var(--el-font-family-mono, monospace);
  color: var(--el-text-color-primary);
}
.download-card__actions {
  margin-top: auto;
}
.downloads-note {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.7;
}
</style>
