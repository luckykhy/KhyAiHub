<template>
  <div class="khy-page dev-env-page">
    <KhyPageHeader
      subtitle="盘点已装工具链与版本 · 一键安装缺失项 · 清单导出/导入（换电脑一键恢复）"
      title="开发环境"
    >
      <template #actions>
        <el-button :disabled="jobRunning" :loading="scanning" @click="startScan">扫描盘点</el-button>
        <el-button :disabled="jobRunning || exporting" :loading="exporting" @click="exportManifest"
          >导出清单</el-button
        >
        <el-button
          :disabled="jobRunning || importing"
          :loading="importing"
          type="primary"
          @click="pickImportFile"
          >导入清单</el-button
        >
      </template>
    </KhyPageHeader>

    <!-- 导入用文件选择器：由页面触发 click，服务端不接收任何落盘路径 -->
    <input
      ref="fileInput"
      accept=".json,application/json"
      class="import-input"
      type="file"
      @change="onImportFile"
    />

    <LoadErrorBanner :message="catalogLoadError">
      <template #action>
        <el-button :icon="RefreshLeft" size="small" @click="reload">重试</el-button>
      </template>
    </LoadErrorBanner>

    <el-alert
      v-if="wingetMissing"
      class="env-alert"
      :closable="false"
      description="一键安装将退回官方下载器（仅部分工具支持），其余需手动安装。修复：在 Microsoft Store 安装/更新「应用安装程序 (App Installer)」后重试。"
      show-icon
      :title="`winget 不可用：${catalog.winget.detail || '未找到 winget'}`"
      type="warning"
    />

    <el-alert
      v-if="inventoryLoadError"
      class="env-alert"
      :closable="false"
      show-icon
      :title="inventoryLoadError"
      type="warning"
      >可点击「扫描盘点」重新生成盘点结果。</el-alert
    >

    <el-alert v-if="activeJob" class="env-alert" :closable="false" show-icon type="info">
      <template #title>{{ activeJobLabel }}</template>
    </el-alert>

    <div v-if="!catalog && !catalogLoadError" class="state-block">
      <el-skeleton animated :rows="6" />
    </div>

    <div v-else-if="catalogLoadError" class="state-block">
      <KhyEmpty
        description="可能是后端服务尚未就绪。稍等片刻后点下方按钮再试一次。"
        :icon="Warning"
        title="工具链目录加载不出来"
      >
        <template #action>
          <el-button type="primary" @click="reload">重试</el-button>
        </template>
      </KhyEmpty>
    </div>

    <div v-else-if="!hasScanned" class="state-block">
      <KhyEmpty
        description="点击「扫描盘点」检测本机已装的开发工具链与版本（约数秒到十几秒）。终端里 khy devenv scan 与本页同源。"
        title="尚未盘点"
      >
        <template #action>
          <el-button :disabled="jobRunning" :loading="scanning" type="primary" @click="startScan"
            >扫描盘点</el-button
          >
        </template>
      </KhyEmpty>
    </div>

    <el-card v-else v-loading="loading" class="env-card" shadow="never">
      <div class="env-summary">
        共 <strong>{{ rows.length }}</strong> 项工具链 ·
        <span class="sum-ok">已装 {{ counts.installed }}</span> ·
        <span class="sum-missing">缺失 {{ counts.missing }}</span> · 手动 {{ counts.manual }} ·
        信息 {{ counts.info }}
        <span v-if="inventory && inventory.scannedAt" class="sum-time">
          （盘点于 {{ formatTime(inventory.scannedAt) }}）
        </span>
      </div>
      <el-table :data="rows" style="width: 100%">
        <el-table-column label="语言" min-width="150">
          <template #default="{ row }">
            <span class="lang-label">{{ row.label || row.language }}</span>
            <a
              v-if="row.docsUrl"
              class="lang-docs"
              :href="row.docsUrl"
              rel="noreferrer"
              target="_blank"
              >官方页面</a
            >
          </template>
        </el-table-column>
        <el-table-column label="depId" width="130">
          <template #default="{ row }">
            <code class="dep-id">{{ row.depId }}</code>
          </template>
        </el-table-column>
        <el-table-column align="center" label="状态" width="100">
          <template #default="{ row }">
            <el-tag effect="light" size="small" :type="rowState(row).tag">
              {{ rowState(row).text }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="版本" min-width="160">
          <template #default="{ row }">
            <span>{{ row.version || '—' }}</span>
            <div
              v-if="row.versionable && row.versions && row.versions.length"
              class="version-choices"
            >
              可选 {{ row.versions.join(' / ') }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="安装方式" min-width="110">
          <template #default="{ row }">{{ installChannel(row) }}</template>
        </el-table-column>
        <el-table-column align="right" label="操作" width="150">
          <template #default="{ row }">
            <el-button
              v-if="canInstall(row)"
              :disabled="jobRunning"
              text
              type="primary"
              @click="openInstall(row)"
              >一键安装</el-button
            >
            <el-button
              v-else-if="row.kind === 'manual'"
              :disabled="jobRunning"
              text
              @click="copyManualHint(row)"
              >复制安装命令</el-button
            >
            <span v-else class="op-none">—</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 安装确认：版本选择 + UAC 提示。实际命令由后端 curated 表生成，前端不拼接。 -->
    <el-dialog
      v-model="installDialog.visible"
      :title="`安装 ${installDialog.row ? installDialog.row.label || installDialog.row.depId : ''}`"
      width="500px"
    >
      <template v-if="installDialog.row">
        <p class="install-target">
          安装 <strong>{{ installDialog.row.label }}</strong>
          （depId: <code class="dep-id">{{ installDialog.row.depId }}</code
          >）
        </p>
        <el-form
          v-if="installDialog.row.versionable && installDialog.row.versions"
          label-width="80px"
          @submit.prevent
        >
          <el-form-item label="版本">
            <el-select
              v-model="installDialog.version"
              clearable
              placeholder="默认版本"
              style="width: 200px"
            >
              <el-option
                v-for="v in installDialog.row.versions"
                :key="v"
                :label="v"
                :value="v"
              />
            </el-select>
          </el-form-item>
        </el-form>
      </template>
      <el-alert
        :closable="false"
        description="安装过程可能弹出 UAC 提权确认框，请在系统弹框中选择「是」；完成后本页自动复验并刷新状态。"
        show-icon
        title="实际安装命令由后端 curated 表生成，本页不拼接命令。"
        type="warning"
      />
      <template #footer>
        <el-button @click="installDialog.visible = false">取消</el-button>
        <el-button :loading="installing" type="primary" @click="confirmInstall">开始安装</el-button>
      </template>
    </el-dialog>

    <!-- 导入预览：toInstall / skipped / manual / unknown 四段计划 -->
    <el-dialog v-model="importDialog.visible" title="导入开发环境清单" width="680px">
      <div v-if="importDialog.plan" class="import-plan">
        <div class="plan-section">
          <p class="plan-title">将安装 {{ importPlan.toInstall.length }} 项</p>
          <p v-if="!importPlan.toInstall.length" class="plan-none">无</p>
          <ul v-else class="plan-list">
            <li v-for="it in importPlan.toInstall" :key="it.depId">
              <code class="dep-id">{{ it.depId }}</code>
              <span v-if="it.command" class="plan-cmd">{{ it.command }}</span>
              <span v-if="it.note" class="plan-note">{{ it.note }}</span>
            </li>
          </ul>
        </div>
        <div class="plan-section">
          <p class="plan-title">跳过 {{ importPlan.skipped.length }} 项</p>
          <p v-if="!importPlan.skipped.length" class="plan-none">无</p>
          <ul v-else class="plan-list">
            <li v-for="it in importPlan.skipped" :key="it.depId">
              <code class="dep-id">{{ it.depId }}</code>
              <span class="plan-note">{{ it.reason }}</span>
            </li>
          </ul>
        </div>
        <div class="plan-section">
          <p class="plan-title">手动 {{ importPlan.manual.length }} 项（khy 拒绝代跑，请手动执行）</p>
          <p v-if="!importPlan.manual.length" class="plan-none">无</p>
          <ul v-else class="plan-list">
            <li v-for="it in importPlan.manual" :key="it.depId">
              <code class="dep-id">{{ it.depId }}</code>
              <code class="plan-hint">{{ it.installHint }}</code>
            </li>
          </ul>
        </div>
        <div v-if="importPlan.unknown.length" class="plan-section">
          <p class="plan-title">拒绝 {{ importPlan.unknown.length }} 项（depId 未登记）</p>
          <ul class="plan-list">
            <li v-for="it in importPlan.unknown" :key="keyOf(it)">
              <code class="dep-id">{{ keyOf(it) }}</code>
            </li>
          </ul>
          <p class="plan-note">
            登记过的 depId：{{ catalogDepIds }}。请在本机重新「扫描盘点」后重新导出清单。
          </p>
        </div>
      </div>
      <template #footer>
        <el-button @click="importDialog.visible = false">取消</el-button>
        <el-button
          :disabled="!importPlan.toInstall.length"
          :loading="applyingImport"
          type="primary"
          @click="confirmImportApply"
          >开始安装 {{ importPlan.toInstall.length }} 项</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { RefreshLeft, Warning } from '@element-plus/icons-vue';
import { devEnvApi } from '@/api/devEnv';
import { useLoadError, loadInto } from '@/api/loadError';
import { deriveErrorMessage, showError, showSuccess, showWarning } from '@/api/notify';
import { formatTime } from '@/utils/formatTimestamp';
import KhyEmpty from '@/components/KhyEmpty.vue';
import KhyPageHeader from '@/components/KhyPageHeader.vue';
import LoadErrorBanner from '@/components/LoadErrorBanner.vue';

// keep-alive matches on component name (AppShell CACHED_VIEWS convention) —
// this page polls jobs, so it is deliberately NOT cached: a cached poller
// would keep running after the user leaves the page.
defineOptions({ name: 'DevEnvironment' });

const JOB_TERMINAL_STATES = ['succeeded', 'failed', 'partial'];
const POLL_INTERVAL_MS = 2000;
// 轮询连续失败到这个数就诚实停下：比无限轮询好，也比到点硬杀好（RUNTIME-003）。
const POLL_MAX_CONSECUTIVE_FAILURES = 3;

const catalog = ref(null);
const inventory = ref(null);
const loading = ref(false);
const scanning = ref(false);
const exporting = ref(false);
const importing = ref(false);
const installing = ref(false);
const applyingImport = ref(false);
const catalogLoadError = useLoadError();
const inventoryLoadError = useLoadError();
const fileInput = ref(null);

// 长操作任务（scan/install/import 共用一条轮询通道）。
const activeJob = ref(null);
let pollTimer = null;
let pollInFlight = false;
let pollFailures = 0;

const installDialog = reactive({ visible: false, row: null, version: '' });
const importDialog = reactive({ visible: false, manifest: null, plan: null });

const hasScanned = computed(() => Array.isArray(inventory.value && inventory.value.entries));

const rows = computed(() => {
  const toolchains = Array.isArray(catalog.value && catalog.value.toolchains)
    ? catalog.value.toolchains
    : [];
  const snapById = new Map(
    ((inventory.value && inventory.value.entries) || []).map((e) => [e.depId, e])
  );
  return toolchains.map((t) => {
    const snap = snapById.get(t.depId);
    // 快照字段覆盖目录静态元数据：快照是本次实测结果，优先级更高。
    return snap ? { ...t, ...snap } : { ...t, present: null, version: null };
  });
});

const counts = computed(() => {
  const c = { installed: 0, missing: 0, manual: 0, info: 0 };
  for (const row of rows.value) {
    const key = rowState(row).key;
    if (key in c) c[key] += 1;
  }
  return c;
});

const catalogDepIds = computed(() =>
  rows.value
    .map((r) => r.depId)
    .join(', ')
);

const wingetMissing = computed(
  () => !!(catalog.value && catalog.value.winget && catalog.value.winget.present === false)
);

const jobRunning = computed(() => !!activeJob.value);

// 后端 progress 行自带「动作+目标+进度」；未回报前给一句已提交的兜底说明。
const JOB_KIND_FALLBACK = {
  scan: '正在盘点本机开发环境（已提交，等待后端回报进度）',
  install: '正在安装（已提交，等待后端回报进度）',
  import: '正在按清单恢复开发环境（已提交，等待后端回报进度）',
};
const activeJobLabel = computed(() => {
  if (!activeJob.value) return '';
  return activeJob.value.progress || JOB_KIND_FALLBACK[activeJob.value.kind] || '';
});

function rowState(row) {
  if (row.kind === 'informational') return { key: 'info', tag: 'info', text: '无需安装' };
  if (row.kind === 'manual') {
    return row.present === true
      ? { key: 'installed', tag: 'success', text: '已装' }
      : { key: 'manual', tag: 'warning', text: '手动安装' };
  }
  if (row.present === true) return { key: 'installed', tag: 'success', text: '已装' };
  if (row.present === false) return { key: 'missing', tag: 'danger', text: '缺失' };
  return { key: 'unknown', tag: 'info', text: '未盘点' };
}

function installChannel(row) {
  if (row.kind === 'informational') return row.note || '无需安装';
  if (row.kind === 'manual') return '手动安装';
  // 快照 schema 未定义安装方式字段；后端将来若带上（installMethod/manager）则优先展示。
  if (row.installMethod) return row.installMethod;
  if (row.manager) return row.manager;
  return '一键安装';
}

function canInstall(row) {
  return (
    hasScanned.value &&
    row.kind !== 'manual' &&
    row.kind !== 'informational' &&
    row.present === false
  );
}

function keyOf(item) {
  return (item && (item.depId || item.id)) || String(item);
}

// ---------- 加载 ----------

async function loadCatalog() {
  const res = await devEnvApi.catalog();
  catalog.value = (res && res.data) || null;
  return catalog.value;
}

async function loadInventory() {
  try {
    const res = await devEnvApi.inventory();
    inventory.value = (res && res.data) || null;
    inventoryLoadError.value = '';
    return inventory.value;
  } catch (err) {
    // 409 = 尚未盘点，是引导态不是错误：清空快照并让「尚未盘点」空态接管。
    if (err && err.response && err.response.status === 409) {
      inventory.value = null;
      inventoryLoadError.value = '';
      return null;
    }
    throw err;
  }
}

async function refreshInventory() {
  await loadInto('上次盘点结果', inventoryLoadError, loadInventory);
}

async function reload() {
  loading.value = true;
  try {
    await Promise.allSettled([loadInto('工具链目录', catalogLoadError, loadCatalog), refreshInventory()]);
  } finally {
    loading.value = false;
  }
}

// ---------- 任务轮询（scan / install / import 通用） ----------

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollInFlight = false;
}

function startPolling(jobId, kind, onDone) {
  stopPolling();
  activeJob.value = { jobId, kind, state: 'running', progress: '' };
  pollFailures = 0;
  const tick = async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const res = await devEnvApi.job(jobId);
      pollFailures = 0;
      const job = (res && res.data) || {};
      activeJob.value = { ...activeJob.value, ...job, jobId, kind };
      if (JOB_TERMINAL_STATES.includes(job.state)) {
        stopPolling();
        activeJob.value = null;
        onDone(job);
      }
    } catch (err) {
      pollFailures += 1;
      if (err && err.response && err.response.status === 404) {
        // 任务不持久化：后端重启后 jobId 失踪，如实说明而不是无限轮询。
        stopPolling();
        activeJob.value = null;
        showError(`任务 ${jobId} 已不存在 (404)：任务记录随后端重启清空，请重新执行。`);
        return;
      }
      if (pollFailures >= POLL_MAX_CONSECUTIVE_FAILURES) {
        stopPolling();
        activeJob.value = null;
        showError(
          `查询任务进度连续失败 ${pollFailures} 次：后端可能不可达，请确认服务已启动后重试。`
        );
      }
    } finally {
      pollInFlight = false;
    }
  };
  tick();
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

onBeforeUnmount(stopPolling);

// ---------- 扫描 ----------

async function startScan() {
  scanning.value = true;
  try {
    const res = await devEnvApi.scan();
    const jobId = res && res.data && res.data.jobId;
    if (!jobId) throw new Error('后端未返回任务 ID');
    startPolling(jobId, 'scan', async (job) => {
      await refreshInventory();
      if (job.state === 'succeeded') showSuccess(job.progress || '盘点完成');
      else if (job.state === 'partial') showWarning(job.progress || '盘点部分完成，可重新扫描。');
      else showError(job.progress || '盘点失败：请确认后端服务可用后重试。');
    });
  } catch {
    // 非 silent 失败已由 request.js 拦截器统一提示。
  } finally {
    scanning.value = false;
  }
}

// ---------- 安装 ----------

function openInstall(row) {
  installDialog.row = row;
  installDialog.version = '';
  installDialog.visible = true;
}

async function confirmInstall() {
  const row = installDialog.row;
  if (!row) return;
  installing.value = true;
  installDialog.visible = false;
  try {
    const res = await devEnvApi.install(row.depId, installDialog.version || undefined);
    const jobId = res && res.data && res.data.jobId;
    if (!jobId) throw new Error('后端未返回任务 ID');
    startPolling(jobId, 'install', async (job) => {
      await refreshInventory();
      if (job.state === 'succeeded') showSuccess(job.progress || `安装 ${row.label} 完成`);
      else if (job.state === 'partial') showWarning(job.progress || '安装部分完成，请刷新后查看。');
      else showError(job.progress || `安装 ${row.label} 失败：请查看提示后重试。`);
    });
  } catch {
    // 非 silent 失败已由 request.js 拦截器统一提示。
  } finally {
    installing.value = false;
  }
}

async function copyManualHint(row) {
  const hint = row.installHint || '';
  const name = row.label || row.depId;
  if (!hint) {
    showWarning(`${name} 没有预置安装命令，请从上方「官方页面」查看安装方式。`);
    return;
  }
  try {
    await navigator.clipboard.writeText(hint);
    showSuccess(`已复制 ${name} 的安装命令，请到终端手动执行（khy 不代跑）。`);
  } catch {
    ElMessageBox.alert(hint, '手动安装命令（请手动复制执行）', {
      confirmButtonText: '知道了',
    }).catch(() => {});
  }
}

// ---------- 导出 ----------

function manifestFileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `khy-dev-env-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

function downloadJson(manifest, fileName) {
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportManifest() {
  exporting.value = true;
  try {
    const res = await devEnvApi.export();
    const manifest = res && res.data;
    if (!manifest) throw new Error('后端未返回清单数据');
    // 文件名只算一次：下载与提示若各算一次，跨分钟时会说出两个名字。
    const fileName = manifestFileName();
    downloadJson(manifest, fileName);
    showSuccess(`已导出清单文件 ${fileName}：拿到新电脑后用「导入清单」一键恢复。`);
  } catch (err) {
    if (err && err.response && err.response.status === 409) {
      showWarning('尚未盘点：请先点击「扫描盘点」，完成后再导出清单。');
    } else {
      // export 标了 silent，拦截器不弹，这里必须自己给出可读错误。
      showError(deriveErrorMessage(err, { fallback: '导出清单失败，请稍后重试。' }));
    }
  } finally {
    exporting.value = false;
  }
}

// ---------- 导入 ----------

function pickImportFile() {
  if (fileInput.value) fileInput.value.click();
}

function onImportFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = ''; // 允许下次重选同一个文件
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => void previewImport(String(reader.result || ''));
  reader.onerror = () => showError(`读取清单文件 ${file.name} 失败：请重试或换一个文件。`);
  reader.readAsText(file);
}

async function previewImport(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (err) {
    showError(
      `清单文件不是合法 JSON（${(err && err.message) || '解析失败'}）：请选择「导出清单」生成的 JSON 文件。`
    );
    return;
  }
  if (!manifest || manifest.kind !== 'khy-dev-env-manifest') {
    showWarning('这不是 khy 开发环境清单（kind 不匹配）：请选择「导出清单」生成的 JSON 文件。');
    return;
  }
  importing.value = true;
  try {
    const res = await devEnvApi.importPreview(manifest);
    importDialog.manifest = manifest;
    importDialog.plan = (res && res.data) || null;
    importDialog.visible = true;
  } catch {
    // 非 silent 失败已由 request.js 拦截器统一提示。
  } finally {
    importing.value = false;
  }
}

const importPlan = computed(() => {
  const plan = importDialog.plan || {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    toInstall: arr(plan.toInstall),
    skipped: arr(plan.skipped),
    manual: arr(plan.manual),
    unknown: arr(plan.unknown),
  };
});

async function confirmImportApply() {
  const manifest = importDialog.manifest;
  if (!manifest) return;
  applyingImport.value = true;
  importDialog.visible = false;
  try {
    const res = await devEnvApi.importApply(manifest);
    const jobId = res && res.data && res.data.jobId;
    if (!jobId) throw new Error('后端未返回任务 ID');
    startPolling(jobId, 'import', async (job) => {
      await refreshInventory();
      if (job.state === 'succeeded') showSuccess(job.progress || '导入完成：环境已按清单恢复。');
      else if (job.state === 'partial') showWarning(job.progress || '导入部分完成：部分项未装上，请重新扫描核对。');
      else showError(job.progress || '导入失败：请确认清单内容后重试。');
    });
  } catch {
    // 非 silent 失败已由 request.js 拦截器统一提示。
  } finally {
    applyingImport.value = false;
  }
}

onMounted(() => reload());
</script>

<style scoped>
.dev-env-page {
  padding: 16px 20px 40px;
}
.import-input {
  display: none;
}
.env-alert {
  margin-bottom: 14px;
}
.state-block {
  padding: 40px 0;
}
.env-card {
  margin-bottom: 16px;
}
.env-summary {
  margin-bottom: 14px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.env-summary strong {
  color: var(--el-text-color-primary);
}
.sum-ok {
  color: var(--el-color-success);
}
.sum-missing {
  color: var(--el-color-danger);
}
.sum-time {
  margin-left: 4px;
}
.lang-label {
  font-weight: 600;
}
.lang-docs {
  margin-left: 8px;
  font-size: 12px;
  color: var(--el-color-primary);
}
.dep-id {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  color: var(--el-color-primary);
}
.version-choices {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.op-none {
  color: var(--el-text-color-placeholder);
}
.install-target {
  margin: 0 0 12px;
}
.import-plan .plan-section {
  margin-bottom: 14px;
}
.import-plan .plan-title {
  margin: 0 0 6px;
  font-weight: 600;
  font-size: 13px;
  color: var(--el-text-color-primary);
}
.import-plan .plan-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.8;
}
.import-plan .plan-cmd,
.import-plan .plan-hint {
  margin-left: 8px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}
.import-plan .plan-note {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.import-plan .plan-none {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-placeholder);
}
</style>
