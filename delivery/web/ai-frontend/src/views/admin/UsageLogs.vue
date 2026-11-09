<template>
  <div class="khy-page usage-logs-page">
    <KhyPageHeader
      subtitle="网关请求计量、计费与明细（CLI 适配器为估算值，标注 estimated）"
      title="用量日志"
    >
      <template #actions>
        <el-button :loading="billing.loading.value" @click="refresh">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
      </template>
    </KhyPageHeader>

    <!-- 接口失败时明确报错，而不是空表格 -->
    <LoadErrorBanner :message="billing.loadError" />

    <!-- Summary metric cards -->
    <div class="metric-row">
      <div class="metric-card metric-card--blue">
        <div class="metric-icon metric-icon--blue">
          <KhyIcon kind="data" size="md" color="var(--khy-primary)" />
        </div>
        <div class="metric-body">
          <div class="metric-label">请求数</div>
          <div class="metric-value">{{ totals.requests || 0 }}</div>
        </div>
      </div>
      <div class="metric-card metric-card--green">
        <div class="metric-icon metric-icon--green">
          <KhyIcon kind="coins" size="md" color="var(--khy-success)" />
        </div>
        <div class="metric-body">
          <div class="metric-label">总 Tokens</div>
          <div class="metric-value">{{ formatNumber(totals.totalTokens || 0) }}</div>
        </div>
      </div>
      <div class="metric-card metric-card--amber">
        <div class="metric-icon metric-icon--amber">
          <KhyIcon kind="wallet" size="md" color="var(--khy-warning)" />
        </div>
        <div class="metric-body">
          <div class="metric-label">计费金额（CNY）</div>
          <div class="metric-value">¥{{ (totals.billedCny || 0).toFixed(4) }}</div>
        </div>
      </div>
      <div class="metric-card metric-card--rose">
        <div class="metric-icon metric-icon--rose">
          <KhyIcon kind="warning" size="md" color="var(--khy-rose)" />
        </div>
        <div class="metric-body">
          <div class="metric-label">错误数</div>
          <div class="metric-value">{{ totals.errors || 0 }}</div>
        </div>
      </div>
    </div>

    <!-- Filters -->
    <el-card class="filter-card" shadow="never">
      <div class="filter-bar">
        <el-input v-model="filters.model" clearable placeholder="模型" style="width: 180px" />
        <el-input
          v-model="filters.customerId"
          clearable
          placeholder="客户 ID"
          style="width: 200px"
        />
        <el-input v-model="filters.tokenId" clearable placeholder="令牌 ID" style="width: 180px" />
        <el-select v-model="filters.status" clearable placeholder="状态" style="width: 130px">
          <el-option label="成功" value="ok" />
          <el-option label="错误" value="error" />
        </el-select>
        <el-date-picker
          v-model="dateRange"
          end-placeholder="结束时间"
          range-separator="至"
          start-placeholder="开始时间"
          style="width: 360px"
          type="datetimerange"
          value-format="YYYY-MM-DDTHH:mm:ss"
        />
        <el-button type="primary" @click="applyFilters">查询</el-button>
        <el-button @click="resetFilters">重置</el-button>
      </div>
    </el-card>

    <!-- Table -->
    <el-card class="table-card" shadow="never">
      <el-table v-loading="billing.loading.value" :data="logs.items" size="small" stripe>
        <template #empty>
          <!-- 与 Marketplace 同款:失败态与真空态分开,不让表格在读取失败时也断「暂无日志」。
               失败态只给标题:错误正文已由页顶的 LoadErrorBanner 承担。 -->
          <KhyEmpty
            v-if="billing.loadError.value"
            compact
            icon-props="{ kind: 'warning' }"
            title="读取用量日志失败"
          />
          <KhyEmpty
            v-else
            compact
            icon-props="{ kind: 'data' }"
            title="暂无日志"
            description="换个时间范围或清掉筛选条件再查一次。"
          />
        </template>
        <el-table-column label="时间" prop="ts" width="180">
          <template #default="{ row }">{{ formatTime(row.ts) }}</template>
        </el-table-column>
        <el-table-column label="客户" min-width="120" prop="customerName">
          <template #default="{ row }">{{ row.customerName || '—' }}</template>
        </el-table-column>
        <el-table-column label="模型" min-width="160" prop="model" show-overflow-tooltip />
        <el-table-column label="分组" prop="group" width="100" />
        <el-table-column align="right" label="输入" width="90">
          <template #default="{ row }">{{ row.inputTokens }}</template>
        </el-table-column>
        <el-table-column align="right" label="输出" width="90">
          <template #default="{ row }">{{ row.outputTokens }}</template>
        </el-table-column>
        <el-table-column align="right" label="计费" width="110">
          <template #default="{ row }">¥{{ Number(row.billedCny || 0).toFixed(5) }}</template>
        </el-table-column>
        <el-table-column align="center" label="计量" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.estimated" size="small" type="warning">估算</el-tag>
            <el-tag v-else size="small" type="success">实际</el-tag>
          </template>
        </el-table-column>
        <el-table-column align="center" label="状态" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'ok' ? 'success' : 'danger'">
              {{ row.status === 'ok' ? row.httpStatus : row.httpStatus || 'err' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column align="right" label="延迟" width="90">
          <template #default="{ row }">{{ row.latencyMs }}ms</template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          :current-page="currentPage"
          layout="total, prev, pager, next, sizes"
          :page-size="pageSize"
          :page-sizes="[20, 50, 100, 200]"
          :total="logs.total"
          @current-change="onPageChange"
          @size-change="onSizeChange"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { useGatewayBilling } from '@/composables/useGatewayBilling';
import KhyPageHeader from '@/components/KhyPageHeader.vue';
import LoadErrorBanner from '@/components/LoadErrorBanner.vue';
import KhyEmpty from '@/components/KhyEmpty.vue';

const billing = useGatewayBilling();
const logs = billing.logs;
const summary = billing.summary;

const filters = reactive({ model: '', customerId: '', tokenId: '', status: '' });
const dateRange = ref(null);
const pageSize = ref(50);
const currentPage = ref(1);

const totals = computed(() => summary.value?.totals || {});

function buildParams() {
  const params = {
    limit: pageSize.value,
    offset: (currentPage.value - 1) * pageSize.value,
  };
  if (filters.model) params.model = filters.model;
  if (filters.customerId) params.customerId = filters.customerId;
  if (filters.tokenId) params.tokenId = filters.tokenId;
  if (filters.status) params.status = filters.status;
  if (Array.isArray(dateRange.value) && dateRange.value.length === 2) {
    params.from = dateRange.value[0];
    params.to = dateRange.value[1];
  }
  return params;
}

async function load() {
  const params = buildParams();
  await Promise.all([
    billing.fetchLogs(params),
    billing.fetchSummary({ groupBy: 'model', from: params.from, to: params.to }),
  ]);
}

function applyFilters() {
  currentPage.value = 1;
  load();
}

function resetFilters() {
  filters.model = '';
  filters.customerId = '';
  filters.tokenId = '';
  filters.status = '';
  dateRange.value = null;
  currentPage.value = 1;
  load();
}

function refresh() {
  load();
}

function onPageChange(page) {
  currentPage.value = page;
  load();
}

function onSizeChange(size) {
  pageSize.value = size;
  currentPage.value = 1;
  load();
}

// NOTE: zh-CN locale + hour12:false + '—' fallback + raw-input catch return;
// NOT equivalent to utils/formatTimestamp.js formatTime ('-' fallback,
// default locale, String(t) catch) — do not merge.
function formatTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return ts;
  }
}

// NOTE: zh-CN locale, integer only; NOT equivalent to Settings.vue formatNumber
// (undefined locale + maximumFractionDigits param) — do not merge.
function formatNumber(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

onMounted(load);
</script>

<style scoped>
.usage-logs-page {
  padding: 4px;
}

.metric-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-bottom: 16px;
}

/* 底 / 左边框 / 图标胶囊 / 数值字号一律来自主题的 .metric-card 与 .metric-icon 体系,
   本页只保留网格密度 —— 原先在此重定义同名 .metric-icon(42px 实色渐变 + 白图标,
   且渐变两端同色)会让同一屏的「指标」和第二张图里的长相不一致。 */
.metric-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 18px;
}

.metric-label {
  font-size: 12px;
  color: var(--khy-text-muted);
}

.metric-value {
  margin-top: 2px;
}

.filter-card {
  margin-bottom: 14px;
  border: 1px solid var(--khy-border);
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.table-card {
  border: 1px solid var(--khy-border);
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

@media (max-width: 1024px) {
  .metric-row {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
