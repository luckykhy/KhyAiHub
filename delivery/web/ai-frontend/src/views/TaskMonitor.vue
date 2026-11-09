<template>
  <div class="khy-page task-monitor-page">
    <KhyPageHeader title="任务监控">
      <template #actions>
        <el-button :loading="loading" @click="load">刷新</el-button>
      </template>
    </KhyPageHeader>

    <el-alert class="scope-note" type="info" :closable="false" show-icon>
      <template #title>只读快照，同一份任务台账</template>
      「会话在跑」只显示本页面所属后端进程里正在执行的会话与工具调用（网页端只看到网页后端）；
      队列/后台任务读的是 <code>large_task_runtime.json</code>，桌面端与网页端读数一致。
      中止、重试、改优先级不在首版范围内。
    </el-alert>

    <div v-if="error" class="state-block">
      <KhyEmpty
        :icon="Warning"
        title="任务快照暂时读不到"
        :description="`后端接口不可达：${error}。确认后端在运行后点「刷新」重试。`"
      >
        <template #action>
          <el-button type="primary" @click="load">重试</el-button>
        </template>
      </KhyEmpty>
    </div>

    <template v-else>
      <div class="counts">
        <span>在跑会话 {{ counts.runsRunning }}</span>
        <span>已结束 {{ counts.runsFinished }}</span>
        <span>任务在跑 {{ counts.tasksRunning }}</span>
        <span>任务排队 {{ counts.tasksQueued }}</span>
        <span>任务失败 {{ counts.tasksFailed }}</span>
        <span>任务总数 {{ counts.tasksTotal }}</span>
        <span v-if="snapshot">pid {{ snapshot.process.pid }}</span>
        <span v-if="snapshot">快照于 {{ formatClock(snapshot.generatedAt) }}</span>
      </div>

      <section class="panel">
        <h3>会话在跑</h3>
        <p v-if="!snapshot" class="empty">读取任务快照…</p>
        <p v-else-if="snapshot.runs.length === 0" class="empty">本进程当前没有在跑的会话</p>
        <ul v-else class="rows">
          <li v-for="run in snapshot.runs" :key="run.key" class="row">
            <button type="button" class="row-head" :aria-expanded="isOpen(`run:${run.key}`)" @click="toggle(`run:${run.key}`)">
              <span class="status" :class="statusTone(run.status)">{{ RUN_STATUS_LABEL[run.status] || run.status }}</span>
              <span class="title" :title="run.title">{{ run.title }}</span>
              <span class="num">{{ formatDuration(run.elapsedMs) }}</span>
            </button>
            <div class="row-sub">
              <span>工具 {{ run.toolCount }} 次</span>
              <span>{{ run.scope === 'desktop' ? '桌面 host' : '网页后端' }}</span>
              <span v-if="run.status === 'running'">空闲 {{ formatDuration(run.idleMs) }}</span>
              <span>{{ isOpen(`run:${run.key}`) ? '收起详情' : '展开详情' }}</span>
            </div>
            <div v-if="isOpen(`run:${run.key}`)" class="detail">
              <div class="pair"><span>运行 id</span><span>{{ run.id }}</span></div>
              <div class="pair"><span>开始时间</span><span>{{ formatClock(new Date(run.startedAt).toISOString()) }}</span></div>
              <div class="pair"><span>最后活动</span><span>{{ formatClock(new Date(run.lastActivityAt).toISOString()) }}</span></div>
              <div v-if="run.error" class="pair"><span>错误</span><span>{{ run.error }}</span></div>
              <p v-if="run.tools.length === 0" class="empty">本轮还没有工具调用</p>
              <div v-for="(tool, index) in run.tools" :key="`${tool.callId || tool.tool}-${index}`" class="tool">
                <div class="tool-head">
                  <span class="status" :class="statusTone(tool.status)">{{ RUN_STATUS_LABEL[tool.status] || tool.status }}</span>
                  <span class="title">{{ tool.tool }}</span>
                  <span class="num">{{ formatDuration(tool.elapsedMs) }}</span>
                </div>
                <div v-if="tool.inputPreview" class="tool-line">参数：{{ tool.inputPreview }}</div>
                <div v-if="tool.resultPreview" class="tool-line">结果：{{ tool.resultPreview }}</div>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section class="panel">
        <h3>队列/后台任务</h3>
        <p v-if="snapshot?.tasksError" class="error">{{ snapshot.tasksError }}</p>
        <p v-else-if="!snapshot" class="empty">读取任务快照…</p>
        <p v-else-if="snapshot.tasks.length === 0" class="empty">任务台账里没有记录</p>
        <ul v-else class="rows">
          <li v-for="task in snapshot.tasks" :key="task.id" class="row">
            <button type="button" class="row-head" :aria-expanded="isOpen(`task:${task.id}`)" @click="toggle(`task:${task.id}`)">
              <span class="status" :class="statusTone(task.status)">{{ TASK_STATUS_LABEL[task.status] || task.status }}</span>
              <span class="title" :title="task.label">{{ task.label }}</span>
              <span class="num">{{ task.progressPct === null ? '' : `${task.progressPct}%` }}</span>
            </button>
            <div class="row-sub">
              <span>{{ task.id }}</span>
              <span v-if="task.source">来源 {{ task.source }}</span>
              <span>更新 {{ formatClock(task.updatedAt) }}</span>
              <span>{{ isOpen(`task:${task.id}`) ? '收起详情' : '展开详情' }}</span>
            </div>
            <div v-if="isOpen(`task:${task.id}`)" class="detail">
              <div class="pair"><span>类型</span><span>{{ task.type || '-' }}</span></div>
              <div class="pair"><span>尝试次数</span><span>{{ task.attemptCount }}/{{ task.maxAttempts || '-' }}</span></div>
              <div class="pair"><span>优先级</span><span>{{ task.priority }}</span></div>
              <div class="pair"><span>创建时间</span><span>{{ formatClock(task.createdAt) }}</span></div>
              <div class="pair"><span>结束时间</span><span>{{ formatClock(task.completedAt) }}</span></div>
              <div v-if="task.leaseOwner" class="pair"><span>领取者</span><span>{{ task.leaseOwner }}</span></div>
              <div v-if="task.lastError" class="pair"><span>错误</span><span>{{ task.lastError }}</span></div>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Warning } from '@element-plus/icons-vue';

import KhyEmpty from '@/components/KhyEmpty.vue';
import KhyPageHeader from '@/components/KhyPageHeader.vue';
import { taskMonitorApi } from '@/api/taskMonitor';

// 1.5s 轮询只刷新只读快照（不是任务截止计时，规则 3 合规）。耗时由快照里的
// startedAt/lastActivityAt 计算，每一轮自然递增。
const POLL_MS = 1500;

const RUN_STATUS_LABEL = {
  running: '在跑',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

const TASK_STATUS_LABEL = {
  queued: '排队',
  claimed: '已领取',
  running: '在跑',
  retry_wait: '等待重试',
  pausing: '暂停中',
  paused: '已暂停',
  cancelling: '取消中',
  cancelled: '已取消',
  succeeded: '成功',
  failed: '失败',
  dead_letter: '死信',
};

const snapshot = ref(null);
const error = ref('');
const loading = ref(false);
const openKeys = ref(new Set());

const counts = computed(
  () =>
    snapshot.value?.counts || {
      runsRunning: 0,
      runsFinished: 0,
      tasksRunning: 0,
      tasksQueued: 0,
      tasksFailed: 0,
      tasksTotal: 0,
    }
);

let timer = null;
let cancelled = false;

async function load() {
  loading.value = true;
  try {
    const res = await taskMonitorApi.snapshot();
    if (cancelled) return;
    if (!res || res.success !== true) {
      error.value = res?.error?.message || '后端返回未成功';
      return;
    }
    error.value = '';
    snapshot.value = res.data;
  } catch (err) {
    if (!cancelled) error.value = String(err?.message || err);
  } finally {
    if (!cancelled) loading.value = false;
  }
}

function toggle(key) {
  const next = new Set(openKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  openKeys.value = next;
}

function isOpen(key) {
  return openKeys.value.has(key);
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m} 分 ${String(s).padStart(2, '0')} 秒`;
  return `${Math.floor(m / 60)} 时 ${String(m % 60).padStart(2, '0')} 分`;
}

function formatClock(iso) {
  if (!iso) return '-';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '-';
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}

function statusTone(status) {
  if (status === 'running' || status === 'claimed') return 'is-running';
  if (status === 'failed' || status === 'dead_letter') return 'is-failed';
  if (status === 'cancelled') return 'is-muted';
  return 'is-done';
}

onMounted(() => {
  load();
  timer = setInterval(load, POLL_MS);
});

onUnmounted(() => {
  cancelled = true;
  if (timer) clearInterval(timer);
});
</script>

<style scoped>
.scope-note {
  margin-bottom: 12px;
}
.counts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 12px;
}
.panel {
  margin-bottom: 16px;
}
.panel h3 {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 8px;
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}
.row {
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.row:last-child {
  border-bottom: none;
}
.row-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
}
.row-head:hover {
  background: var(--el-fill-color-light);
}
.status {
  flex-shrink: 0;
  width: 56px;
  font-size: 12px;
}
.is-running {
  color: var(--el-color-primary);
}
.is-failed {
  color: var(--el-color-danger);
}
.is-muted {
  color: var(--el-text-color-placeholder);
}
.is-done {
  color: var(--el-text-color-secondary);
}
.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.num {
  flex-shrink: 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}
.row-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 0 12px 8px 76px;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
.detail {
  padding: 0 12px 10px 76px;
}
.pair {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 20px;
}
.pair > span:first-child {
  width: 72px;
  flex-shrink: 0;
  color: var(--el-text-color-placeholder);
}
.pair > span:last-child {
  flex: 1;
  min-width: 0;
  word-break: break-all;
  color: var(--el-text-color-regular);
}
.tool {
  margin-top: 6px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  padding: 4px 8px;
}
.tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.tool-line {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  word-break: break-all;
}
.empty {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  margin: 4px 0;
}
.error {
  font-size: 12px;
  color: var(--el-color-danger);
  margin: 4px 0;
}
</style>
