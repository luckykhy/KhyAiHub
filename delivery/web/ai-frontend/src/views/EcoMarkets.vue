<template>
  <div class="khy-page eco-markets-page">
    <KhyPageHeader
      title="生态市场"
      subtitle="终端、桌面端与网页版共用同一份市场快照：静态勘察 + 实时来源 + 已安装状态"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="refreshing" @click="refreshNow">
          {{ refreshing ? refreshLabel() : '刷新实时数据' }}
        </el-button>
      </template>
    </KhyPageHeader>

    <LoadErrorBanner :message="loadError">
      <template #action>
        <el-button :icon="Refresh" size="small" @click="refreshNow">重试</el-button>
      </template>
    </LoadErrorBanner>

    <el-alert v-if="degraded" class="eco-alert" type="warning" :closable="false" show-icon>
      <template #title>生态编目读取降级</template>
      {{ degraded }}
    </el-alert>

    <el-alert v-if="refreshError" class="eco-alert" type="warning" :closable="false" show-icon>
      <template #title>上次实时刷新失败</template>
      {{ refreshError }}（当前展示 {{ fetchedAt ? fmtTime(fetchedAt) : '静态编目' }} 的快照）
    </el-alert>

    <el-alert v-if="warnings.length" class="eco-alert" type="warning" :closable="false" show-icon>
      <template #title>编目装配有 {{ warnings.length }} 条告警</template>
      <ul class="eco-warnings">
        <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
      </ul>
    </el-alert>

    <el-card shadow="never" class="eco-card live-card">
      <div class="live-head">
        <span class="live-dot" :class="{ 'is-busy': refreshing }"></span>
        <span class="live-title">
          {{ refreshing ? '正在拉取实时来源' : fetchedAt ? '实时数据已同步' : '静态编目' }}
        </span>
        <span class="live-time">
          {{ fetchedAt ? `更新于 ${fmtTime(fetchedAt)}` : '首次实时同步进行中' }}
        </span>
      </div>
      <p class="live-summary">
        共 {{ tally('ecosystems') }} 个生态 · {{ tally('entries') }} 条 · 阻塞
        {{ tally('blocked') }} · 已安装 {{ tally('installed') }}
        <span v-if="generatedAt"> · 静态编目生成于 {{ generatedAt }}</span>
      </p>
      <div v-if="sources.length" class="live-sources">
        <el-tag
          v-for="s in sources"
          :key="s.id"
          size="small"
          :type="sourceTag(s).type"
          class="live-source"
          :title="s.message || s.title"
        >
          {{ s.title }} · {{ sourceTag(s).text }}
          <template v-if="s.entries"> {{ s.entries }}</template>
        </el-tag>
      </div>
      <p class="live-note">
        静态勘察编目按日更新；阶跃水产市场、Open VSX、Kimi Code、官方 MCP Registry
        为实时检索，失败时回退到上一次快照并标为「缓存」。本页只读；安装与卸载在桌面端或终端执行，
        写入同一份终端存储，桌面端「技能」「MCP 服务器」页同步出现。
      </p>
    </el-card>

    <el-card shadow="never" class="eco-card">
      <div v-loading="loading" class="eco-body">
        <el-tabs v-if="markets.length" v-model="activeTab">
          <el-tab-pane v-for="m in markets" :key="m.eco" :label="m.title || m.eco" :name="m.eco">
            <p class="eco-summary">
              条目 {{ m.entries.length }} · 阻塞 {{ m.blocked.length }} · 市场源
              {{ m.marketplaces.length }} · 勘察于 {{ m.surveyedAt || '未知' }}
              <el-tag size="small" effect="plain" class="eco-inline-tag" :type="m.live ? 'success' : 'info'">
                {{ m.live ? (m.stale ? '实时（缓存）' : '实时') : '静态' }}
              </el-tag>
              <template v-if="installedIn(m)"> · 已安装 {{ installedIn(m) }}</template>
            </p>
            <p class="eco-summary">
              兼容分布：直连 {{ compatTally(m.entries).direct }} · 需适配
              {{ compatTally(m.entries).adapter }} · 已覆盖 {{ compatTally(m.entries).covered }} · 阻塞
              {{ compatTally(m.entries).blocked }}
            </p>

            <div v-if="m.marketplaces.length" class="eco-block">
              <h4 class="eco-block__title">市场来源</h4>
              <ul class="eco-sources">
                <li v-for="s in m.marketplaces" :key="m.eco + ':' + s.name" class="eco-source">
                  <div class="eco-source__head">
                    <span class="eco-source__name">{{ s.name }}</span>
                    <el-link v-if="s.url" :href="s.url" rel="noopener" target="_blank" type="primary">
                      打开来源
                    </el-link>
                    <el-tag v-if="s.kind" size="small" type="info">{{ s.kind }}</el-tag>
                  </div>
                  <p v-if="s.note" class="eco-source__note">{{ s.note }}</p>
                </li>
              </ul>
            </div>

            <el-table :data="m.entries" class="eco-table">
              <template #empty>
                <!-- el-table's own empty-text would fall back to EP's "no data" on a
                     read failure, putting two opposite conclusions on one screen
                     next to the load-failure banner; KhyEmpty splits the two cases
                     instead. The failure branch carries a title only — the error
                     body is already rendered by LoadErrorBanner above. -->
                <KhyEmpty
                  v-if="loadError"
                  compact
                  :icon-props="{ kind: 'warning' }"
                  title="读取该生态条目失败"
                />
                <KhyEmpty
                  v-else
                  compact
                  :icon="ShoppingBag"
                  title="该生态暂无编目条目"
                  description="勘察未收录可导入条目；可切换到其他生态 tab 查看。"
                />
              </template>
              <el-table-column type="expand" width="40">
                <template #default="{ row }">
                  <dl class="eco-detail">
                    <div v-if="row.categoryLabel">
                      <dt>用途类型</dt>
                      <dd>
                        {{ row.categoryLabel }}
                        {{ row.categorySource === 'upstream' ? '（按上游市场分类）' : '（按名称与描述归类）' }}
                      </dd>
                    </div>
                    <div v-if="row.installed">
                      <dt>安装状态</dt>
                      <dd>已安装{{ row.installedSummary ? `：${row.installedSummary}` : '' }}</dd>
                    </div>
                    <div v-if="row.compatNote">
                      <dt>兼容说明</dt>
                      <dd>{{ row.compatNote }}</dd>
                    </div>
                    <div v-if="row.targetPath">
                      <dt>落点</dt>
                      <dd>{{ row.targetPath }}</dd>
                    </div>
                    <div v-if="row.khyCommand">
                      <dt>导入命令</dt>
                      <dd>{{ row.khyCommand }}</dd>
                    </div>
                    <div v-if="row.relationship">
                      <dt>与上游关系</dt>
                      <dd>{{ row.relationship }}</dd>
                    </div>
                    <div v-if="row.agentScope && row.agentScope.length">
                      <dt>适用生态</dt>
                      <dd>{{ row.agentScope.join('、') }}</dd>
                    </div>
                  </dl>
                </template>
              </el-table-column>
              <el-table-column label="名称" min-width="150">
                <template #default="{ row }">
                  {{ row.name }}
                  <el-tag v-if="row.installed" size="small" type="success" class="eco-inline-tag">
                    已安装
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="用途类型" width="106">
                <template #default="{ row }">
                  <el-tag v-if="row.categoryLabel" size="small" type="info" effect="plain">
                    {{ row.categoryLabel }}
                  </el-tag>
                  <span v-else class="eco-muted">未分类</span>
                </template>
              </el-table-column>
              <el-table-column label="类型（拆包指引）" min-width="110">
                <template #default="{ row }">{{ row.type || '未标注' }}</template>
              </el-table-column>
              <el-table-column label="兼容" width="96">
                <template #default="{ row }">
                  <el-tag size="small" :type="compatTag(row.compat).type">
                    {{ compatTag(row.compat).text }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="许可证" width="100">
                <template #default="{ row }">{{ row.license || '未标注' }}</template>
              </el-table-column>
              <el-table-column label="khyos 路由" width="108">
                <template #default="{ row }">
                  <el-tag size="small" effect="plain" :type="routeTag(row).type">
                    {{ routeTag(row).text }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="what" label="说明" min-width="220" show-overflow-tooltip />
              <el-table-column label="上游" width="104">
                <template #default="{ row }">
                  <el-link
                    v-if="row.upstreamUrl"
                    :href="row.upstreamUrl"
                    rel="noopener"
                    target="_blank"
                    type="primary"
                  >
                    查看上游
                  </el-link>
                  <span v-else class="eco-muted">未给出</span>
                </template>
              </el-table-column>
            </el-table>

            <div v-if="m.blocked.length" class="eco-block">
              <h4 class="eco-block__title">阻塞条目（不路由）</h4>
              <el-table :data="m.blocked" size="small" class="eco-table">
                <el-table-column prop="name" label="名称" min-width="140" />
                <el-table-column label="上游" width="104">
                  <template #default="{ row }">
                    <el-link
                      v-if="row.upstreamUrl"
                      :href="row.upstreamUrl"
                      rel="noopener"
                      target="_blank"
                      type="primary"
                    >
                      查看上游
                    </el-link>
                    <span v-else class="eco-muted">未给出</span>
                  </template>
                </el-table-column>
                <el-table-column prop="reason" label="阻塞原因" min-width="320" />
              </el-table>
            </div>

            <div v-if="m.uncertainties.length" class="eco-block">
              <h4 class="eco-block__title">残留风险</h4>
              <ul class="eco-risks">
                <li v-for="(u, i) in m.uncertainties" :key="i">{{ u }}</li>
              </ul>
            </div>
          </el-tab-pane>
        </el-tabs>

        <KhyEmpty
          v-else-if="!loadError && !loading"
          :icon="ShoppingBag"
          title="生态编目为空"
          description="后端没有返回任何生态编目。若刚接入该页面，请确认守护进程已挂载该接口后重试。"
        />
      </div>
    </el-card>

    <el-card v-if="rules.length" shadow="never" class="eco-card">
      <template #header>
        <span class="eco-block__title">导入路由闸门规则</span>
      </template>
      <ol class="eco-rules">
        <li v-for="(r, i) in rules" :key="i">{{ r }}</li>
      </ol>
      <p v-if="licenseGate" class="eco-rules__license">许可证闸：{{ licenseGate }}</p>
    </el-card>
  </div>
</template>

<script setup>
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { Refresh, ShoppingBag } from '@element-plus/icons-vue';
import { useEcoMarkets } from '@/composables/useEcoMarkets';
import KhyEmpty from '@/components/KhyEmpty.vue';
import KhyPageHeader from '@/components/KhyPageHeader.vue';
import LoadErrorBanner from '@/components/LoadErrorBanner.vue';

// keep-alive matches on component name (see Layout CACHED_VIEWS convention).
defineOptions({ name: 'EcoMarkets' });

const {
  markets,
  rules,
  licenseGate,
  generatedAt,
  fetchedAt,
  refreshing,
  refreshError,
  sources,
  totals,
  degraded,
  warnings,
  loading,
  loadError,
  loadMarkets,
  startAutoRefresh,
  stopAutoRefresh,
} = useEcoMarkets();

const activeTab = ref('');

// The tab list only exists after the first response lands, so a stale selection
// (or the initial '') has to fall back to the first ecosystem instead of
// rendering a blank pane.
watch(
  markets,
  (list) => {
    if (!list.some((m) => m.eco === activeTab.value)) {
      activeTab.value = list.length ? list[0].eco : '';
    }
  },
  { immediate: true }
);

// Counts come from the backend snapshot when present; the fallbacks only cover
// a degraded payload where totals was not assembled.
function tally(field) {
  const t = totals.value;
  if (t && Number.isFinite(t[field])) return t[field];
  if (field === 'ecosystems') return markets.value.length;
  if (field === 'entries') return markets.value.reduce((n, m) => n + m.entries.length, 0);
  if (field === 'blocked') return markets.value.reduce((n, m) => n + m.blocked.length, 0);
  if (field === 'installed') {
    return markets.value.reduce(
      (n, m) => n + m.entries.filter((entry) => entry && entry.installed).length,
      0
    );
  }
  return 0;
}

function installedIn(market) {
  return (market.entries || []).filter((entry) => entry && entry.installed).length;
}

function pendingSources() {
  return sources.value.filter((s) => s && s.status === 'pending').length;
}

// A background pass starts *after* the response, so the snapshot returned by
// the forced refresh still carries the previous source statuses — printing
// "0/5" would claim there is no progress. Fall back to the retention contract.
function refreshLabel() {
  const pending = pendingSources();
  if (pending > 0) return `拉取中 ${pending} / ${sources.value.length}`;
  return `刷新中：${sources.value.length} 个来源（保持当前快照）`;
}

const SOURCE_TAGS = {
  ok: { text: '实时', type: 'success' },
  stale: { text: '缓存', type: 'warning' },
  error: { text: '失败', type: 'danger' },
  pending: { text: '拉取中', type: 'info' },
  off: { text: '已关闭', type: 'info' },
};
function sourceTag(source) {
  // `ok` on the static catalog means "read succeeded", not "live" — labelling it
  // 实时 would claim a freshness the static survey never had.
  if (source && source.kind === 'static') {
    return source.status === 'error'
      ? { text: '读取失败', type: 'danger' }
      : { text: '已载入', type: 'info' };
  }
  return SOURCE_TAGS[source && source.status] || { text: (source && source.status) || '未知', type: 'info' };
}

// Date-only values (catalog generatedAt) stay verbatim; timestamps render in
// local time with seconds so "实时" is actually checkable.
function fmtTime(value) {
  if (!value) return '未知';
  if (String(value).length <= 10) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

async function refreshNow() {
  await loadMarkets(true);
  startAutoRefresh();
}

// Unknown survey values render verbatim: the catalog is data we do not control,
// and a blank tag would read as "not surveyed" rather than "unmapped".
const COMPAT_TAGS = {
  direct: { text: '直连', type: 'success' },
  'adapter-needed': { text: '需适配', type: 'warning' },
  covered: { text: '已覆盖', type: 'primary' },
  blocked: { text: '阻塞', type: 'danger' },
};
const compatTag = (value) => COMPAT_TAGS[value] || { text: value || '未知', type: 'info' };

// 已覆盖条目的 `khyosMarket` 是 none，但「不路由」在这里会被读成"不支持"；
// 它真正的含义是"khyos 已有等效原生能力，不需要导入"。
function compatTally(entries) {
  const tally = { direct: 0, adapter: 0, covered: 0, blocked: 0 };
  for (const entry of entries || []) {
    if (entry.compat === 'adapter-needed') tally.adapter += 1;
    else if (tally[entry.compat] !== undefined) tally[entry.compat] += 1;
  }
  return tally;
}

const ROUTE_TAGS = {
  skill: { text: 'Skill', type: 'success' },
  mcp: { text: 'MCP', type: 'primary' },
  extension: { text: '拓展', type: 'warning' },
  none: { text: '不路由', type: 'info' },
};
function routeTag(row) {
  if (row.compat === 'covered') return { text: '原生', type: 'success' };
  const value = row.khyosMarket;
  return ROUTE_TAGS[value] || { text: value || '未知', type: 'info' };
}

onMounted(loadMarkets);
onMounted(startAutoRefresh);
onActivated(startAutoRefresh);
onDeactivated(stopAutoRefresh);
onBeforeUnmount(stopAutoRefresh);
</script>

<style scoped>
.eco-markets-page {
  padding: 16px 20px 40px;
}
.eco-alert,
.eco-card {
  margin-bottom: var(--khy-space-4);
}
.live-card {
  padding-bottom: 4px;
}
.live-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--khy-space-2);
}
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-color-success);
  box-shadow: 0 0 0 3px var(--el-color-success-light-8);
}
.live-dot.is-busy {
  background: var(--el-color-warning);
  box-shadow: 0 0 0 3px var(--el-color-warning-light-8);
  animation: live-pulse 1.2s ease-in-out infinite;
}
@keyframes live-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
.live-title {
  color: var(--khy-text-strong);
  font-size: var(--khy-text-sm);
  font-weight: 600;
}
.live-time {
  color: var(--khy-text-muted);
  font-size: var(--khy-text-xs);
  font-variant-numeric: tabular-nums;
}
.live-summary {
  margin: var(--khy-space-2) 0 0;
  color: var(--khy-text-secondary);
  font-size: var(--khy-text-sm);
}
.live-sources {
  display: flex;
  flex-wrap: wrap;
  gap: var(--khy-space-2);
  margin-top: var(--khy-space-2);
}
.live-source {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.live-note {
  margin: var(--khy-space-3) 0 0;
  color: var(--khy-text-muted);
  font-size: var(--khy-text-xs);
  line-height: 1.6;
}
.eco-body {
  min-height: 120px;
}
.eco-summary {
  margin: 0 0 var(--khy-space-3);
  color: var(--khy-text-secondary);
  font-size: var(--khy-text-sm);
}
.eco-inline-tag {
  margin-left: 6px;
  vertical-align: middle;
}
.eco-block {
  margin-bottom: var(--khy-space-5);
}
.eco-block__title {
  margin: 0 0 var(--khy-space-2);
  color: var(--khy-text-strong);
  font-size: var(--khy-text-sm);
  font-weight: 600;
}
.eco-sources,
.eco-risks,
.eco-warnings {
  margin: 0;
  padding-left: 18px;
}
.eco-source {
  margin-bottom: var(--khy-space-2);
}
.eco-source__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--khy-space-2);
}
.eco-source__name {
  font-weight: 500;
}
.eco-source__note,
.eco-muted {
  margin: 4px 0 0;
  color: var(--khy-text-muted);
  font-size: var(--khy-text-xs);
}
.eco-table {
  margin-bottom: var(--khy-space-3);
}
.eco-detail {
  margin: 0;
  padding: var(--khy-space-3) var(--khy-space-4);
}
.eco-detail dt {
  color: var(--khy-text-strong);
  font-weight: 600;
}
.eco-detail dd {
  margin: 2px 0 var(--khy-space-2);
  color: var(--khy-text-secondary);
  white-space: pre-wrap;
}
.eco-rules {
  margin: 0;
  padding-left: 20px;
  color: var(--khy-text-secondary);
  font-size: var(--khy-text-sm);
  line-height: 1.7;
}
.eco-rules__license {
  margin: var(--khy-space-3) 0 0;
  color: var(--khy-text-muted);
  font-size: var(--khy-text-xs);
}
</style>
