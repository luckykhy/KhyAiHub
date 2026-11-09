<template>
  <div class="khy-page ai-dashboard-page">
    <KhyPageHeader subtitle="系统健康、关键指标、异常摘要与待处理事项" title="AI 管理总览">
      <template #actions>
        <!-- 四字中文标签塞不进 switch 的胶囊(inline-prompt 是给 1–2 字符的 是/否、ON/OFF),
             改成标签外置在控件左侧;外包 <label> 顺带给 switch 一个可访问名。 -->
        <label class="refresh-switch">
          <span>自动刷新</span>
          <el-switch v-model="autoRefresh" @change="handleAutoRefreshChange" />
        </label>
        <el-button :loading="loading" type="primary" @click="refreshAll">刷新数据</el-button>
      </template>
    </KhyPageHeader>

    <LoadErrorBanner :message="dashboardError">
      <template #action>
        <el-button size="small" @click="refreshAll">重试</el-button>
      </template>
    </LoadErrorBanner>

    <el-row class="stats-row" :gutter="16">
      <el-col v-for="card in keyMetrics" :key="card.label" :lg="4" :md="8" :sm="12" :xs="24">
        <el-card :class="['metric-card', `metric-card--${card.tone}`]" shadow="hover">
          <div class="metric-row">
            <div :class="['metric-icon', `metric-icon--${card.tone}`]">
              <!-- KhyIcon 自带 --khy-icon-color(内联),不吃父级 color;要让字形跟着
                   胶囊/左边框的色相走,必须在调用处显式传 color。 -->
              <KhyIcon :kind="card.icon" size="md" :color="TONE_ICON_COLOR[card.tone]" />
            </div>
            <div class="metric-body">
              <div class="metric-title">{{ card.label }}</div>
              <div class="metric-value">
                {{ card.value
                }}<span v-if="card.unit" class="metric-unit">{{ card.unit }}</span>
              </div>
              <div class="metric-sub">{{ card.sub }}</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row class="section-row" :gutter="16">
      <el-col :lg="10" :xs="24">
        <el-card class="section-card" shadow="hover">
          <template #header>
            <div class="card-header-row">
              <span>系统健康</span>
              <el-tag size="small" :type="unhealthyCount ? 'warning' : 'success'">
                {{ unhealthyCount }} 个通道异常
              </el-tag>
            </div>
          </template>
          <el-table v-if="healthItems.length" :data="healthItems" size="small" stripe>
            <el-table-column label="通道" min-width="140">
              <template #default="{ row }">{{ row.name }}</template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag size="small" :type="row.ok ? 'success' : 'danger'">{{
                  row.label
                }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="时延" width="90">
              <template #default="{ row }">{{ row.latency }}</template>
            </el-table-column>
          </el-table>
          <KhyEmpty
            v-else-if="!healthFailed"
            description="健康广播器尚未就绪"
            title="暂无通道健康数据"
          />
        </el-card>
      </el-col>

      <el-col :lg="14" :xs="24">
        <el-card class="section-card" shadow="hover">
          <template #header>
            <div class="card-header-row">
              <span>Agent 运行</span>
              <el-button :loading="agent.loading" size="small" @click="agent.manualRefresh"
                >刷新</el-button
              >
            </div>
          </template>
          <el-alert v-if="agent.degraded" :closable="false" show-icon type="warning">
            连续 3 次获取 Agent 状态失败，已停止轮询，点「刷新」重试
          </el-alert>
          <div class="agent-stat-grid">
            <div v-for="(item, idx) in agent.statCards" :key="item.label" class="agent-stat">
              <div :class="['agent-stat-value', 'agent-stat-value--' + (idx + 1)]">
                {{ item.value }}
              </div>
              <div class="agent-stat-label">{{ item.label }}</div>
            </div>
          </div>
          <el-table v-if="agent.agents.length" :data="agentAgentsPreview" size="small" stripe>
            <el-table-column label="Agent" min-width="140">
              <template #default="{ row }">{{ row.name || row.id || '-' }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag size="small" :type="agent.statusTagType(row.status)">{{
                  row.status || '-'
                }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="耗时" width="90">
              <template #default="{ row }">{{
                agent.formatMs(row.durationMs ?? row.elapsedMs)
              }}</template>
            </el-table-column>
            <el-table-column label="任务" show-overflow-tooltip>
              <template #default="{ row }">{{ row.task || row.description || '-' }}</template>
            </el-table-column>
          </el-table>
          <KhyEmpty v-else description="暂无运行中的 Agent" title="Agent 空闲" />
          <el-button class="agent-more" link type="primary" @click="go('/admin/agents')"
            >查看全部 →
          </el-button>
        </el-card>
      </el-col>
    </el-row>

    <el-row class="section-row" :gutter="16">
      <el-col :lg="12" :xs="24">
        <el-card class="section-card" shadow="hover">
          <template #header>
            <div class="card-header-row">
              <span>异常摘要</span>
              <span class="card-sub">取自最近 {{ monitorTraces.length }} 条请求</span>
            </div>
          </template>
          <div class="kv-list">
            <div class="kv-row">
              <span class="kv-label">失败请求</span>
              <span class="kv-value">
                <el-tag size="small" :type="failedTraceCount ? 'danger' : 'success'">
                  {{ failedTraceCount }}
                </el-tag>
              </span>
            </div>
            <div class="kv-row">
              <span class="kv-label">失败请求平均时延</span>
              <span class="kv-value">{{ failedTraceLatency }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">通道健康异常</span>
              <span class="kv-value">
                <el-tag size="small" :type="unhealthyCount ? 'warning' : 'success'">
                  {{ unhealthyCount }}
                </el-tag>
              </span>
            </div>
            <div class="kv-row">
              <span class="kv-label">监控缓冲占用</span>
              <span class="kv-value">{{ bufferSize }}</span>
            </div>
          </div>
          <el-button class="agent-more" link type="primary" @click="go('/admin/monitor')"
            >查看监控中心 →
          </el-button>
        </el-card>
      </el-col>

      <el-col :lg="12" :xs="24">
        <el-card class="section-card" shadow="hover">
          <template #header>
            <div class="card-header-row">
              <span>待处理</span>
              <el-tag
                size="small"
                :type="pendingTotal === null ? 'info' : pendingTotal ? 'warning' : 'success'"
              >
                {{ pendingTotal === null ? '—' : pendingTotal }} 项
              </el-tag>
            </div>
          </template>
          <div class="kv-list">
            <div class="kv-row">
              <span class="kv-label">待审核用户</span>
              <span class="kv-value">{{
                pendingUsersFailed ? '—' : pendingUserCount
              }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">待处理充值订单</span>
              <span class="kv-value">
                <el-button link size="small" type="primary" @click="go('/admin/payments')">
                  {{ pendingPaymentsFailed ? '—' : pendingPaymentCount }} 单 →
                </el-button>
              </span>
            </div>
            <div class="kv-row">
              <span class="kv-label">失效渠道凭证</span>
              <span class="kv-value">
                <el-button link size="small" type="primary" @click="go('/admin/bridge')">
                  {{ poolUnknown ? '—' : expiredKeyCount }} 个 →
                </el-button>
              </span>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>快捷跳转</span>
          <span class="card-sub">其余入口在左侧导航</span>
        </div>
      </template>
      <div class="quick-actions">
        <el-button @click="go('/admin/models')"
          ><KhyIcon kind="settings" size="sm" /> 网关管理</el-button
        >
        <el-button @click="go('/admin/channels')"
          ><KhyIcon kind="link" size="sm" /> 渠道注册</el-button
        >
        <el-button @click="go('/admin/bridge')"
          ><KhyIcon kind="compass" size="sm" /> 桥接 Token</el-button
        >
        <el-button @click="go('/admin/accounts')"
          ><KhyIcon kind="user" size="sm" /> 账号池</el-button
        >
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import request from '@/api/request';
import { useGateway } from '@/composables/useGateway';
import { useAIMonitor } from '@/composables/useAIMonitor';
import { useAccountPool } from '@/composables/useAccountPool';
import { useAssetCustomer } from '@/composables/useAssetCustomer';
import { useAgentDashboard } from '@/composables/useAgentDashboard';
import { showError } from '@/api/notify';
import { useLoadError, loadInto } from '@/api/loadError';
import KhyPageHeader from '@/components/KhyPageHeader.vue';
import KhyIcon from '@/components/KhyIcon.vue';
import KhyEmpty from '@/components/KhyEmpty.vue';
import LoadErrorBanner from '@/components/LoadErrorBanner.vue';

const router = useRouter();
const gw = useGateway();
const monitor = useAIMonitor();
const accountPool = useAccountPool();
const asset = useAssetCustomer();
// Shared with /agents so both pages poll the same endpoint with one backoff
// implementation instead of two diverging copies.
// reactive(): the composable returns a plain object of refs, and nested refs do
// NOT auto-unwrap in templates — `agent.statCards` was iterating the computed-ref
// object itself ("reading 'label' of undefined") and `agent.degraded`/`agent.loading`
// were permanently truthy. AgentDashboard.vue destructures at the top level, so the
// wrapper only changes this file's behavior.
const agent = reactive(useAgentDashboard());

const loading = ref(false);
const autoRefresh = ref(true);
let refreshTimer = null;

const health = ref(null);
const pendingUsers = ref([]);
const pendingPayments = ref([]);
const loadError = useLoadError();
// 「读到空」与「没读到」必须能被页面区分：这三个位各自标记一次读取是否失败，
// 供 pendingTotal / 通道健康空态决定是显示 0 还是显示「—」。
const healthFailed = ref(false);
const pendingUsersFailed = ref(false);
const pendingPaymentsFailed = ref(false);
// 密钥池从未成功读到时 pool 仍是 null —— 用它当「未知」信号，避免把读取失败
// 折成「失效凭证 0 个」。
const poolUnknown = computed(() => gw.pool.value == null);
// 本页一次刷新聚合 5 个来源，任何一个挂了都不该显示成「0」。横幅只显示最先
// 命中的那条原因，点「重试」重跑 refreshAll 即可逐个复验。
const dashboardError = computed(
  () => loadError.value || gw.loadError.value || monitor.loadError.value
);

const adapters = computed(() => gw.status.value?.adapters || []);
const adapterTotal = computed(() => adapters.value.length);
const adapterAvailableCount = computed(
  () => adapters.value.filter((item) => item.available).length
);

const keyPoolProviderCount = computed(() => Object.keys(gw.pool.value || {}).length);
const keyPoolCount = computed(() => {
  const pool = gw.pool.value || {};
  return Object.values(pool).reduce(
    (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
    0
  );
});

const accounts = computed(() => accountPool.accounts.value || []);
const totalAccountCount = computed(() => accounts.value.length);
const activeAccountCount = computed(
  () => accounts.value.filter((item) => item.status === 'active' && !item.disabled).length
);

const assetsSummary = computed(() => asset.overview.value?.assets || {});
const customerTotal = computed(() => assetsSummary.value?.customers?.total || 0);
const customerTokenTotal = computed(() => assetsSummary.value?.customers?.tokens || 0);

const requestTotal = computed(() => monitor.stats.value?.total || 0);
const successRate = computed(() => monitor.stats.value?.successRate || '0.0%');
const avgLatency = computed(() => `${monitor.stats.value?.avgLatencyMs || 0}ms`);
const bufferSize = computed(() => {
  const current = monitor.stats.value?.bufferSize || 0;
  const max = monitor.stats.value?.maxBufferSize || 0;
  return `${current}/${max}`;
});

// Channel health snapshot. The broadcaster may not be wired yet, in which case
// the endpoint returns an empty adapter list — rendered as an empty state rather
// than a fabricated "all healthy".
const HEALTHY_PATTERN = /^(ok|healthy|up)$/i;
const healthItems = computed(() => {
  const list = health.value?.adapters || [];
  return list.map((item) => {
    const status = String(item.status || (item.available === false ? 'unavailable' : 'ok'));
    return {
      name: item.name || item.adapter || item.provider || '-',
      ok: item.available !== false && HEALTHY_PATTERN.test(status),
      label: item.available === false ? '不可用' : status,
      latency: item.latencyMs ? `${item.latencyMs}ms` : item.latency ? `${item.latency}` : '-',
    };
  });
});
const unhealthyCount = computed(() => healthItems.value.filter((item) => !item.ok).length);

// 异常摘要 derives from the same trace buffer the monitor page reads, so the two
// surfaces cannot disagree about the failure rate.
const monitorTraces = computed(() => monitor.traces.value || []);
const failedTraces = computed(() =>
  monitorTraces.value.filter((trace) => trace && trace.success === false)
);
const failedTraceCount = computed(() => failedTraces.value.length);
const failedTraceLatency = computed(() => {
  const values = failedTraces.value.map((trace) => trace.latencyMs).filter((value) => value > 0);
  if (!values.length) return '-';
  const avg = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  return `${avg}ms`;
});

const pendingUserCount = computed(
  () => pendingUsers.value.filter((user) => user.status === 'pending').length
);
const pendingPaymentCount = computed(
  () => pendingPayments.value.filter((payment) => payment.status === 'pending').length
);
// Bridge keys that are imported but not currently routable — the reason a channel
// shows no traffic without any visible error.
const expiredKeyCount = computed(() => {
  const pool = gw.pool.value || {};
  return Object.values(pool).reduce((sum, list) => {
    if (!Array.isArray(list)) return sum;
    return sum + list.filter((key) => key.status && key.status !== 'active').length;
  }, 0);
});
const pendingTotal = computed(() => {
  // 任何一项没读到就不能报总数：0 会让「后端挂了」看起来像「今天没人待处理」。
  if (pendingUsersFailed.value || pendingPaymentsFailed.value || poolUnknown.value) return null;
  return pendingUserCount.value + pendingPaymentCount.value + expiredKeyCount.value;
});

const agentAgentsPreview = computed(() => (agent.agents || []).slice(0, 5));

// tone 只喂给卡片的配色变体（.metric-card--* / .metric-icon--*），不影响取数。
// KhyIcon 的字形色不吃父级 color，需按 tone 显式传给它的 color prop。
const TONE_ICON_COLOR = {
  blue: 'var(--khy-primary)',
  green: 'var(--khy-success)',
  amber: 'var(--khy-warning)',
  purple: 'var(--khy-violet)',
  rose: 'var(--khy-rose)',
  cyan: 'var(--khy-cyan-strong)',
};

const keyMetrics = computed(() => [
  {
    label: '适配器状态',
    icon: 'connection',
    tone: 'blue',
    value: adapterAvailableCount.value,
    unit: `/${adapterTotal.value}`,
    sub: '可用 / 总数',
  },
  {
    label: '密钥池',
    icon: 'key',
    tone: 'green',
    value: keyPoolCount.value,
    sub: `${keyPoolProviderCount.value} 个供应商`,
  },
  {
    label: '账号池',
    icon: 'user',
    tone: 'purple',
    value: activeAccountCount.value,
    unit: `/${totalAccountCount.value}`,
    sub: '可用 / 总账号',
  },
  {
    label: '客户与令牌',
    icon: 'coins',
    tone: 'cyan',
    value: customerTotal.value,
    sub: `${customerTokenTotal.value} 个令牌`,
  },
  {
    label: '请求总数',
    icon: 'data',
    tone: 'amber',
    value: requestTotal.value,
    sub: `成功率 ${successRate.value}`,
  },
  {
    label: '平均时延',
    icon: 'refresh',
    tone: 'rose',
    value: avgLatency.value,
    sub: `监控缓冲 ${bufferSize.value}`,
  },
]);

function go(path) {
  router.push(path);
}

async function unwrap(res) {
  return res?.data?.data || res?.data || res;
}

async function fetchHealth() {
  const res = await loadInto('通道健康', loadError, () =>
    request.get('/api/ai-gateway-admin/health', { silent: true })
  );
  healthFailed.value = !res;
  if (res) health.value = await unwrap(res);
}

async function fetchPending() {
  // Two independent fetches: /api/users requires adminMiddleware and
  // /api/ai-gateway/payments is the local order registry. Both are silent so a
  // 403/500 shows up as a banner instead of a global toast — but neither may
  // silently become a zero count.
  const [usersRes, paymentsRes] = await Promise.allSettled([
    loadInto('待审核用户', loadError, () => request.get('/api/users', { silent: true })),
    loadInto('待处理充值订单', loadError, () =>
      request.get('/api/ai-gateway/payments', { silent: true })
    ),
  ]);
  pendingUsersFailed.value = usersRes.status !== 'fulfilled' || usersRes.value == null;
  if (!pendingUsersFailed.value) {
    const data = await unwrap(usersRes.value);
    pendingUsers.value = Array.isArray(data) ? data : [];
  }
  pendingPaymentsFailed.value = paymentsRes.status !== 'fulfilled' || paymentsRes.value == null;
  if (!pendingPaymentsFailed.value) {
    const data = await unwrap(paymentsRes.value);
    pendingPayments.value = Array.isArray(data) ? data : data?.payments || [];
  }
}

async function refreshAll() {
  loading.value = true;
  try {
    // allSettled: one unreachable block must not blank the whole overview.
    await Promise.allSettled([
      gw.fetchStatus(),
      gw.fetchPool(),
      accountPool.fetchAccounts(),
      asset.fetchOverview(),
      monitor.fetchStats(),
      monitor.fetchTraces({ limit: 20 }),
      fetchHealth(),
      fetchPending(),
    ]);
  } catch (err) {
    showError(err?.message || '刷新失败：请检查后端服务是否在线');
  } finally {
    loading.value = false;
  }
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!autoRefresh.value) return;
  refreshTimer = setInterval(() => {
    refreshAll();
  }, 30000);
}

function handleAutoRefreshChange() {
  startAutoRefresh();
}

onMounted(async () => {
  await refreshAll();
  startAutoRefresh();
});

onUnmounted(() => {
  stopAutoRefresh();
});
</script>

<style scoped>
/* 页宽由 .khy-page 的 --khy-page-max 统一,不再本页自写 max-width。 */
.refresh-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--khy-space-2);
  font-size: 13px;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  user-select: none;
}

.stats-row {
  margin-bottom: 16px;
}

.metric-card {
  margin-bottom: 14px;
}

.metric-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.metric-body {
  flex: 1;
  min-width: 0;
}

.metric-title {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  font-weight: 500;
}

/* 字号/字重/色由主题的 .metric-value 统一;此处只留本页的上下间距。 */
.metric-value {
  margin-top: 6px;
}

.metric-unit {
  font-size: 15px;
  font-weight: 500;
  color: var(--el-text-color-secondary);
}

.metric-sub {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.section-row {
  margin-bottom: 16px;
}

.section-card {
  margin-bottom: 14px;
}

.card-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.card-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.agent-stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 12px;
}

.agent-stat {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
  text-align: center;
}

.agent-stat-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
}

/* useAgentDashboard returns the cards in a fixed order (总计 / 运行中 /
   已完成 / 失败); position-based classes avoid a per-card :style binding. */
.agent-stat-value--1 {
  color: var(--khy-primary);
}

.agent-stat-value--2 {
  color: var(--khy-warning);
}

.agent-stat-value--3 {
  color: var(--khy-success);
}

.agent-stat-value--4 {
  color: var(--khy-danger);
}

.agent-stat-label {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.kv-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.kv-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
}

.kv-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.kv-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.quick-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.quick-actions .el-button .el-icon {
  margin-right: 4px;
}

.agent-more {
  margin-top: 10px;
}
</style>
