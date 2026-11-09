<template>
  <div class="my-gateway" v-loading="gw.loading.value">
    <div class="mg-intro">
      <h2 class="mg-title">我的网关</h2>
      <p class="mg-sub">
        配置你自己的上游中转、密钥池与 Claude Code 接入。一切都与其他用户隔离，仅你可见。
      </p>
    </div>

    <GatewayOnboarding
      scope="user"
      :presets="gw.providerPresets.value"
      :configured="isConfigured"
    />

    <!-- 目录读取失败时，「暂无可用模型」与「后端挂了」在页面上长得一模一样。 -->
    <LoadErrorBanner :message="gw.loadError.value">
      <template #action>
        <el-button size="small" @click="gw.fetchAll()">重试</el-button>
      </template>
    </LoadErrorBanner>

    <!-- 按功能领域聚合:接入配置 / 密钥与供应商 / 模型管理 / 令牌接入。
         所有 pane 默认非 lazy 常驻 DOM,切页不卸载,数据与引用不受影响。 -->
    <el-tabs v-model="activeTab" class="mg-tabs">
      <el-tab-pane label="接入配置" name="access">
        <RelayConfigCard
          scope="user"
          :config="gw.relayConfig.value"
          :saving="gw.saving.value"
          :presets="gw.providerPresets.value"
          @save="onSaveRelay"
        />
      </el-tab-pane>

      <el-tab-pane label="密钥与供应商" name="keys">
        <CustomProviderCard
          id="mg-provider-card"
          scope="user"
          :providers="gw.providers.value"
          :models="gw.models.value"
          :busy="providerBusy"
          :progress="providerProgress"
          :presets="gw.providerPresets.value"
          @add="onAddProvider"
          @add-model="onAddProviderModel"
          @remove-entry="onRemoveEntry"
          @remove-provider="onRemoveProvider"
          @replace-entry="onReplaceEntry"
          @remove-model="onRemoveModel"
          @open-config="onOpenConfig"
        />
      </el-tab-pane>

      <el-tab-pane label="模型管理" name="models">
        <div class="mg-grid">
          <MyModelsCard
            :models="gw.models.value"
            :presets="gw.providerPresets.value"
            :busy="modelBusy"
            @add="onAddModel"
            @update="onUpdateModel"
            @remove="onRemoveModel"
          />

          <ImageModelCard
            :current="imageCurrent"
            :options="imageOptions"
            :busy="gw.loading.value"
            @update="onUpdateImageConfig"
          />
        </div>

        <!-- Multi-pivot view over my own providers / keys / relay model. Same data,
         grouped by different axes — identical client-side pivot as the global
         plane (composables/useModelPivots.js). -->
        <el-card class="mg-catalog-card" shadow="never">
          <template #header>
            <div class="mg-catalog-head">
              <span class="mg-catalog-title">模型总览 · 多视角</span>
              <div class="mg-catalog-controls">
                <el-radio-group v-model="viewMode" size="small">
                  <el-radio-button v-for="v in pivotViews" :key="v.value" :value="v.value">{{
                    v.label
                  }}</el-radio-button>
                </el-radio-group>
                <el-input
                  v-model="search"
                  size="small"
                  clearable
                  placeholder="搜索模型 / 供应商"
                  class="mg-catalog-search"
                />
                <el-button
                  size="small"
                  type="primary"
                  plain
                  :loading="gw.detecting.value"
                  @click="onDetect"
                  >检测 / 刷新</el-button
                >
              </div>
            </div>
          </template>

          <!-- State transparency: report what each detector saw on the last detect. -->
          <div
            v-if="detectionLine || detectionErrors.length || detectionSkipped.length"
            class="mg-detect-summary"
          >
            <span v-if="detectionLine" class="mg-detect-text">{{ detectionLine }}</span>
            <el-tag
              v-for="(e, i) in detectionErrors"
              :key="i"
              size="small"
              type="danger"
              effect="plain"
              >{{ e }}</el-tag
            >
            <span v-if="detectionSkipped.length" class="mg-detect-skip">
              {{ detectionSkipped.join('、') }} 无 /models 接口，已跳过自动发现（可手动添加模型）
            </span>
          </div>

          <KhyEmpty
            v-if="!pivotedGroups.length && !gw.loadError.value"
            compact
            icon-props="{ kind: search.trim() ? 'search' : 'link' }"
            :title="search.trim() ? '没有匹配的项' : '暂无可用模型'"
            :description="
              search.trim()
                ? '换个关键字,或清空搜索查看全部。'
                : '先配置上游供应商或添加 Key,模型会自动出现在这里。'
            "
          />
          <div v-else-if="pivotedGroups.length" class="mg-pivot-list" v-loading="modelBusy">
            <div v-for="group in pivotedGroups" :key="group.groupKey" class="mg-pivot-group">
              <div class="mg-pivot-group-head">
                <span class="mg-pivot-group-name">{{ groupHeadName(group) }}</span>
                <!-- Own-key group: show YOUR key as a masked preview (sk-…xxxx) + its
                 label, so "where is my key" is answered inline. Only the user's
                 own keys reach here (join by row id); system keys stay read-only
                 in the bucket below and never surface a value. -->
                <template v-if="keyGroupKind(group) === 'own-key' && ownKeyInfo(group)">
                  <el-tag size="small" type="success" effect="plain" class="mg-key-mask">{{
                    ownKeyInfo(group).keyMasked || '已配置 Key'
                  }}</el-tag>
                  <span v-if="ownKeyInfo(group).label" class="mg-pivot-group-hint">{{
                    ownKeyInfo(group).label
                  }}</span>
                </template>
                <!-- System-key bucket: spell out WHY it's read-only + what it covers,
                 instead of a bare "(系统密钥)" label. Managing system keys is the
                 admin "AI 网关 → API 密钥池" job; never editable on the user plane. -->
                <template v-if="keyGroupKind(group) === 'system'">
                  <el-tag size="small" type="info" effect="plain">系统统管 · 只读</el-tag>
                  <span class="mg-pivot-group-hint">{{ systemBucketSummary(group) }}</span>
                </template>
                <span class="mg-pivot-group-count">{{ group.edges.length }} 个</span>
                <!-- Own-key group: route to the provider/key editor (replace stays
                 single-source in CustomProviderCard — the pivot only navigates). -->
                <el-button
                  v-if="keyGroupKind(group) === 'own-key' && ownKeyGroupProvider(group)"
                  link
                  size="small"
                  @click="scrollToProviderEditor(ownKeyGroupProvider(group))"
                  >编辑/替换此 Key</el-button
                >
                <!-- Add model: by-provider groups, and own-key groups resolvable to a
                 single provider. System / no-key buckets get no add affordance. -->
                <el-button
                  v-if="addModelProvider(group)"
                  link
                  size="small"
                  type="primary"
                  @click="onAddModelToGroup(group)"
                  >+ 添加模型</el-button
                >
              </div>
              <div class="mg-pivot-rows">
                <div
                  v-for="edge in group.edges"
                  :key="`${edge.provider}:${edge.model}:${edge.keyIds.join(',')}:${group.groupKey}`"
                  class="mg-pivot-row"
                >
                  <span class="mg-pivot-model">{{ edge.model || '—' }}</span>
                  <el-tag size="small" type="info" effect="plain">{{
                    edge.providerLabel || edge.provider
                  }}</el-tag>
                  <el-tag v-if="edge.isDefault" size="small" type="warning" effect="plain"
                    >默认</el-tag
                  >
                  <el-tag v-if="edge.tier" size="small" effect="plain">{{ edge.tier }}</el-tag>
                  <!-- Editable rows expose capability via the el-select below; read-only
                   rows still show it as a tag so no info is lost. -->
                  <el-tag
                    v-if="!userEdgeEditable(edge, gw.models.value)"
                    size="small"
                    effect="plain"
                    >{{ capabilityLabel(edge.capability) }}</el-tag
                  >
                  <el-tag size="small" :type="statusTagType(edge.status)" effect="plain">{{
                    statusLabel(edge.status)
                  }}</el-tag>
                  <el-tag size="small" type="info" effect="plain">{{
                    connectionLabel(edge.connectionMode)
                  }}</el-tag>
                  <el-tag
                    v-if="edge.source"
                    size="small"
                    :type="sourceTagType(edge.source)"
                    effect="light"
                    >{{ sourceLabel(edge.source) }}</el-tag
                  >

                  <!-- Inline edit on a user-owned, row-backed edge: capability / active /
                   delete drive the SAME mutations as MyModelsCard. system / local /
                   rowless edges stay read-only (tenant isolation + state transparency). -->
                  <template v-if="userEdgeEditable(edge, gw.models.value)">
                    <el-select
                      :model-value="edge.capability"
                      size="small"
                      class="mg-pivot-cap"
                      @change="(v) => onPivotChangeCapability(edge, v)"
                    >
                      <el-option
                        v-for="c in CAPABILITIES"
                        :key="c.value"
                        :label="c.label"
                        :value="c.value"
                      />
                    </el-select>
                    <el-switch
                      :model-value="userEdgeRow(edge)?.isActive !== false"
                      size="small"
                      inline-prompt
                      active-text="启"
                      inactive-text="停"
                      @change="(v) => onPivotToggleActive(edge, v)"
                    />
                    <el-button link type="danger" size="small" @click="onPivotRemove(edge)"
                      >删除</el-button
                    >
                  </template>
                  <el-tag v-else size="small" type="info" effect="plain">{{
                    userEdgeReadonlyTag(edge)
                  }}</el-tag>
                </div>
              </div>
            </div>
          </div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="令牌接入" name="tokens">
        <CcAccessCard
          scope="user"
          :endpoint="gw.ccEndpoint.value"
          :tokens="gw.ccTokens.value"
          :busy="ccBusy"
          :just-issued="justIssued"
          @issue="onIssueToken"
          @revoke="onRevokeToken"
        />
      </el-tab-pane>

      <!-- 客户端应用（[DESIGN-ARCH-189] S1 只读）。
           S1 纪律：只读由「后端不挂写路由」保证（RUNTIME-010），不靠按钮置灰，
           所以「一键配置」是常驻不可用状态而不是 loading 态。
           模型下拉同样禁用——per-app 绑定表（裁决 D6）尚未落地，没有数据可绑；
           若显示一个能选但选了不生效的下拉，就是 fail-open。 -->
      <el-tab-pane label="客户端应用" name="clientApps">
        <LoadErrorBanner v-if="caError" :message="caError">
          <template #action>
            <el-button size="small" @click="caFetchAll">重试</el-button>
          </template>
        </LoadErrorBanner>

        <div class="mg-clientapps">
          <div class="mg-clientapps-head">
            <div class="mg-clientapps-title">
              本机 AI 客户端
              <span class="mg-clientapps-count">{{ caApps.length }} 个在册</span>
            </div>
            <el-button size="small" :loading="caBusy" @click="caRescan">扫描应用</el-button>
          </div>

          <div class="mg-clientapps-filters">
            <el-input
              v-model="caSearch"
              size="small"
              clearable
              placeholder="搜索名称或包名"
              class="mg-clientapps-search"
            />
            <el-radio-group v-model="caCategory" size="small">
              <!-- value 承载选项值（caCategory 的取值），展示文案交给插槽内容：
                   Element Plus 3.0 起 label 不再兼任 value，契约见
                   src/__tests__/elementPlusCompat.contract.test.js。 -->
              <el-radio-button value="all">全部</el-radio-button>
              <el-radio-button value="cli">CLI</el-radio-button>
              <el-radio-button value="desktop">桌面端</el-radio-button>
            </el-radio-group>
          </div>

          <div v-loading="caBusy">
            <KhyEmpty
              v-if="!caFiltered.length && !caBusy"
              compact
              icon-props="{ kind: 'search' }"
              :title="caSearch.trim() ? '没有匹配的应用' : '暂无在册应用'"
              desc="登记表由 catalog.json 提供；扫描只反映本机探测结果。"
            />

            <div v-else class="mg-clientapps-grid">
              <div
                v-for="app in caFiltered"
                :key="app.appId"
                class="mg-clientapps-card"
                :data-installed="app.installed ? '1' : '0'"
              >
                <div class="mg-clientapps-card-head">
                  <span class="mg-clientapps-card-name">{{ app.name }}</span>
                  <el-tag
                    size="small"
                    :type="app.installed ? 'success' : 'info'"
                    effect="plain"
                  >{{ app.installed ? '已安装' : '未安装' }}</el-tag>
                </div>
                <div class="mg-clientapps-card-desc">{{ app.desc }}</div>
                <div class="mg-clientapps-card-meta">
                  <span class="mg-clientapps-pkg">{{ app.pkgName }}</span>
                  <el-tag
                    v-if="app.badge"
                    size="small"
                    :type="caBadgeType(app.badge)"
                    effect="plain"
                  >{{ app.badge }}</el-tag>
                </div>
                <div class="mg-clientapps-card-actions">
                  <!-- S2 起开写。三态而非两态：能写 / 本期不接（后端给理由）/
                       未安装。第三种不能置灰了事——用户需要知道为什么。 -->
                  <el-button
                    v-if="app.writeState === 'ready'"
                    size="small"
                    type="primary"
                    :loading="caBusy"
                    @click="caConfigure(app)"
                  >一键配置</el-button>
                  <el-tooltip
                    v-else-if="app.writeState === 'blocked'"
                    :content="app.writeBlockedReason || '本期不接'"
                    placement="top"
                  >
                    <span class="mg-clientapps-model-disabled">{{ app.writeBlockedShort || '未开放' }}</span>
                  </el-tooltip>
                  <el-tooltip
                    content="per-app 模型绑定（裁决 D6）尚未落地，无可绑数据"
                    placement="top"
                  >
                    <span class="mg-clientapps-model-disabled">模型绑定：未开放</span>
                  </el-tooltip>
                </div>
                <div v-if="app.detail && app.detail.note" class="mg-clientapps-card-note">
                  {{ app.detail.note }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- Interactive provider/key wizard: configure a provider + key + models,
         dry-run "测试连接" to verify and import discovered models, or edit an
         existing entry (rotate key / rename provider / sync models). Hosted here
         so it overlays the whole page; CustomProviderCard only requests it. -->
    <ProviderConfigDialog
      v-model:visible="configVisible"
      :mode="configMode"
      :entry="configEntry"
      :initial-models="configInitialModels"
      :presets="gw.providerPresets.value"
      :tester="gw.testProviderConfig"
      :busy="configBusy"
      @submit="onConfigSubmit"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useUserGateway } from '@/composables/useUserGateway';
import { safeSet } from '@/utils/safeStorage';
import {
  VIEWS as pivotViews,
  pivotEdges,
  capabilityLabel,
  statusLabel,
  connectionLabel,
  statusTagType,
  sourceLabel,
  sourceTagType,
  SYSTEM_KEY_BUCKET,
  NO_KEY_BUCKET,
} from '@/composables/useModelPivots';
import {
  userEdgeRowId,
  userEdgeEditable,
  userEdgeReadonlyTag,
  ownKeyRowForGroup,
} from '@/composables/gatewayInlineEdit';
import RelayConfigCard from '@/components/gateway/RelayConfigCard.vue';
import CustomProviderCard from '@/components/gateway/CustomProviderCard.vue';
import ProviderConfigDialog from '@/components/gateway/ProviderConfigDialog.vue';
import MyModelsCard from '@/components/gateway/MyModelsCard.vue';
import CcAccessCard from '@/components/gateway/CcAccessCard.vue';
import ImageModelCard from '@/components/gateway/ImageModelCard.vue';
import GatewayOnboarding from '@/components/gateway/GatewayOnboarding.vue';
import KhyEmpty from '@/components/KhyEmpty.vue';
import LoadErrorBanner from '@/components/LoadErrorBanner.vue';

import { showSuccess, showError, showWarning, showInfo } from '@/api/notify';
import { clientAppsApi } from '@/api/clientApps';
import { ccSwitchApi } from '@/api/ccSwitch';
const gw = useUserGateway();
const providerBusy = ref(false);
// 多条目模型播种循环的实时进度（RUNTIME-002：动作+目标+进度），展示在 CustomProviderCard 按钮旁。
const providerProgress = ref('');
const modelBusy = ref(false);
const ccBusy = ref(false);
const justIssued = ref('');

// 分类标签页:按功能领域聚合(接入 / 密钥 / 模型 / 令牌),选中项记忆到 localStorage。
// 读失败(隐私模式等)或值非法时回落到「接入配置」。
const TAB_STORAGE_KEY = 'khy_my_gateway_tab';
const VALID_TABS = ['access', 'keys', 'models', 'tokens', 'clientApps'];
function readGatewayTab() {
  try {
    const v = localStorage.getItem(TAB_STORAGE_KEY);
    return VALID_TABS.includes(v) ? v : 'access';
  } catch {
    return 'access';
  }
}
const activeTab = ref(readGatewayTab());
watch(activeTab, (v) => {
  safeSet(TAB_STORAGE_KEY, v);
});

// ---- 客户端应用（[DESIGN-ARCH-189] S1 只读）--------------------------------
// 两份数据：catalog（登记表，静态）与 scan（本机探测，动态）。卡片把两者按
// appId 合并——登记表给 name/desc/pkgName/category，扫描给 installed/badge。
// 扫描失败不清空登记表：用户至少还能看到「有哪些客户端、该配什么」。
const caCatalog = ref(null);
const caScanData = ref(null);
const caWritePosture = ref({});
const caBusy = ref(false);
const caError = ref('');
const caSearch = ref('');
const caCategory = ref('all');

const BADGE_TYPES = {
  已配置: 'success',
  配置未完成: 'warning',
  未配置: 'info',
  未接入: 'info',
  未安装: 'info',
  探测失败: 'danger',
};
function caBadgeType(badge) {
  return BADGE_TYPES[badge] || 'info';
}

const caApps = computed(() => {
  const apps = (caCatalog.value && caCatalog.value.apps) || [];
  const scanned = (caScanData.value && caScanData.value.apps) || [];
  const byId = new Map(scanned.map((s) => [s.appId, s]));
  return apps.map((entry) => {
    const s = byId.get(entry.appId);
    const w = caWritePosture.value[entry.appId] || null;
    return {
      appId: entry.appId,
      name: entry.name,
      desc: entry.desc,
      pkgName: entry.pkgName,
      category: entry.category,
      installed: s ? s.installed : null,
      badge: s ? s.badge : '',
      detail: s ? s.detail : null,
      // 写姿态来自 /preview（后端 previewConfigure）。三态：
      // ready 可写 / blocked 本期不接（带理由）/ unknown 还没问到。
      writeState: w ? w.state : 'unknown',
      writeBlockedReason: w ? w.reason : '',
      writeBlockedShort: w ? w.short : '未开放',
    };
  });
});

const caFiltered = computed(() => {
  const q = caSearch.value.trim().toLowerCase();
  return caApps.value.filter((a) => {
    if (caCategory.value !== 'all' && a.category !== caCategory.value) return false;
    if (!q) return true;
    return (
      String(a.name).toLowerCase().includes(q) ||
      String(a.pkgName).toLowerCase().includes(q)
    );
  });
});

async function caFetchAll() {
  caBusy.value = true;
  caError.value = '';
  try {
    // 登记表与扫描各自失败要分开报：前者是运营问题（catalog.json 被改坏），
    // 后者是本机探测问题。混成一句「加载失败」用户没法下手。
    const catalog = await clientAppsApi.catalog();
    caCatalog.value = catalog;
    try {
      caScanData.value = await clientAppsApi.scan();
    } catch (e) {
      caScanData.value = null;
      showWarning(`应用清单已加载，但本机扫描失败：${(e && e.message) || e}`);
    }
    // 写姿态单独问 /preview：它只算路径不做探测，13 个并行可接受。
    // 失败不阻塞页面——卡片退化成「未开放」而不是整页报错。
    caLoadWritePosture();
  } catch (e) {
    caError.value = (e && e.message) || String(e);
  } finally {
    caBusy.value = false;
  }
}

// 并行问一遍 preview，把每个 app 的写姿态收进 caWritePosture。
// 单个失败只让那个 app 退化成 unknown，不影响其余。
async function caLoadWritePosture() {
  const apps = (caCatalog.value && caCatalog.value.apps) || [];
  const results = await Promise.all(
    apps.map(async (a) => {
      try {
        const p = await clientAppsApi.preview(a.appId, {});
        return [a.appId, p.ok
          ? { state: 'ready', reason: '', short: '' }
          : { state: 'blocked', reason: p.message || '本期不接', short: '未开放' }];
      } catch {
        return [a.appId, { state: 'unknown', reason: '', short: '未开放' }];
      }
    })
  );
  caWritePosture.value = Object.fromEntries(results);
}

// 一键配置：真实写入（备份 → 写 → 逐键回报）。
// 409 是「本次没写成」的正常业务结果，不是服务端故障——故单独提示并展示原因。
async function caConfigure(app) {
  caBusy.value = true;
  try {
    const card = await pickCardForApp(app);
    if (!card) return;
    const out = await clientAppsApi.configure(app.appId, { card, mode: 'proxy' });
    if (out.ok) {
      const bad = (out.readBack || []).filter((r) => r.status === 'MISSING' || r.status === 'DIFF');
      if (bad.length) {
        showWarning(`已写入，但有 ${bad.length} 项回读不一致：${bad.map((b) => b.key).join(', ')}`);
      } else {
        showSuccess(`${app.name} 配置完成`);
      }
      await caRescan();
    } else {
      showError(`配置失败：${out.message || '未知原因'}`);
    }
  } catch (e) {
    const status = e && e.response && e.response.status;
    if (status === 409) {
      showError(`配置未执行：${(e.response.data && e.response.data.message) || '被拒'}`);
    } else {
      showError(`配置失败：${(e && e.message) || e}`);
    }
  } finally {
    caBusy.value = false;
  }
}

// 卡片选择：复用 ccSwitch 的卡片列表，让用户选一张供应商卡。
// 返回 null 表示用户取消。
async function pickCardForApp(app) {
  try {
    const cards = await ccSwitchApi.listCards();
    const list = (cards && cards.cards) || cards || [];
    if (!list.length) {
      showWarning('还没有供应商卡片，请先到「密钥与供应商」建一张');
      return null;
    }
    // 单张卡时不必问；多张时让用户选。
    if (list.length === 1) return list[0];
    const picked = await ElMessageBox.prompt(
      `选择要写入 ${app.name} 的供应商卡片`,
      '一键配置',
      { inputValue: String(list[0].id), confirmButtonText: '写入', cancelButtonText: '取消' }
    );
    return list.find((c) => String(c.id) === String(picked.value)) || null;
  } catch {
    return null; // 用户取消
  }
}

async function caRescan() {
  caBusy.value = true;
  caError.value = '';
  try {
    caScanData.value = await clientAppsApi.scan();
    showSuccess('扫描完成');
  } catch (e) {
    showError(`扫描失败：${(e && e.message) || e}`);
  } finally {
    caBusy.value = false;
  }
}

// 新手引导：是否已有任何配置（已配 relay / 供应商 Key / 模型）。决定引导默认展开还是折叠。
const isConfigured = computed(() => {
  if (Array.isArray(gw.providers.value) && gw.providers.value.length) return true;
  if (Array.isArray(gw.models.value) && gw.models.value.length) return true;
  const relay = gw.relayConfig.value;
  if (relay && (relay.baseUrl || relay.apiKey || relay.model)) return true;
  return false;
});

// ── Interactive provider/key config wizard (ProviderConfigDialog) ──
// `configEntry` is the provider's primary key row when editing (null when adding);
// `configInitialModels` are that provider's current models so the dialog can show
// them as removable tags and the submit handler can diff add/remove.
const configVisible = ref(false);
const configMode = ref('add');
const configEntry = ref(null);
const configBusy = ref(false);
const configInitialModels = computed(() => {
  if (configMode.value !== 'edit' || !configEntry.value) return [];
  const provider = String(configEntry.value.provider || '').toLowerCase();
  return (gw.models.value || []).filter(
    (m) => m && String(m.provider || '').toLowerCase() === provider
  );
});

function onOpenConfig({ mode, entry }) {
  configMode.value = mode === 'edit' ? 'edit' : 'add';
  configEntry.value = entry || null;
  configVisible.value = true;
}

// Multi-pivot view over my own catalog edges (shared pivot logic with global plane).
const viewMode = ref('by-provider');
const search = ref('');
const pivotedGroups = computed(() =>
  pivotEdges(Array.isArray(gw.catalogEdges.value) ? gw.catalogEdges.value : [], viewMode.value, {
    search: search.value,
  })
);

// Capability options for the inline pivot editor (mirrors MyModelsCard).
const CAPABILITIES = [
  { value: 'text', label: '文本' },
  { value: 'audio', label: '语音' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
];

// ── Image-generation model selection (per-user) ──
// `imageConfig` is { backend, model, source }; options come from the image edges
// already present in the per-user catalog (capability/source = 'image').
const imageCurrent = computed(() => ({
  backend: gw.imageConfig.value?.backend || 'auto',
  model: gw.imageConfig.value?.model || '',
}));
const imageOptions = computed(() => {
  const edges = Array.isArray(gw.catalogEdges.value) ? gw.catalogEdges.value : [];
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    if (!e || (e.capability !== 'image' && e.source !== 'image')) continue;
    const backend = e.provider || e.backend;
    const model = e.model || '';
    if (!backend) continue;
    const key = `${backend}::${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ backend, model, supportsEdit: !!e.supportsEdit });
  }
  return out;
});
async function onUpdateImageConfig(payload) {
  try {
    await gw.updateImageConfig(payload);
    showSuccess('图像模型已更新');
  } catch (err) {
    showError(err?.response?.data?.message || err?.message || '更新失败');
  }
}

// Resolve the user_provider_models row backing an editable edge (by provider+model).
function userEdgeRow(edge) {
  const id = userEdgeRowId(edge, gw.models.value);
  if (id == null) return null;
  return (gw.models.value || []).find((r) => r && r.id === id) || null;
}

// ── by-key group classification (header affordances) ────────────────────────
// Only meaningful in the by-key view. 'system'  = the read-only (系统密钥) bucket
// (system key real but id hidden for tenant isolation); 'no-key' = the (无 Key)
// bucket; 'own-key' = a real group keyed by one of the user's OWN key ids.
function keyGroupKind(group) {
  if (viewMode.value !== 'by-key') return 'other';
  if (group.groupKey === SYSTEM_KEY_BUCKET) return 'system';
  if (group.groupKey === NO_KEY_BUCKET) return 'no-key';
  return 'own-key';
}

// The user's own provider/key row backing an own-key group (or null). Source for
// the masked preview + the authoritative target provider for add/edit jumps. The
// join (group key → masked row) is the single-source pure helper in
// gatewayInlineEdit; system keys never match here (tenant isolation).
function ownKeyInfo(group) {
  if (keyGroupKind(group) !== 'own-key') return null;
  return ownKeyRowForGroup(group.groupKey, gw.providers.value);
}

// Group-head display name: own-key groups show the friendly provider name
// (display name → provider) rather than the opaque numeric key id; everything
// else keeps the pivot's own label.
function groupHeadName(group) {
  const info = ownKeyInfo(group);
  if (info) return info.displayName || info.provider || group.groupLabel;
  return group.groupLabel;
}

// The single provider an own-key group belongs to (for + 添加模型 / edit jump).
// Prefer the joined own-key row (authoritative); fall back to the edges' single
// provider. '' when synthetic, multi-provider, or no user-owned edge — then we
// expose no affordance (honest, never guess a target).
function ownKeyGroupProvider(group) {
  if (keyGroupKind(group) !== 'own-key') return '';
  const info = ownKeyInfo(group);
  if (info && info.provider) return String(info.provider);
  const owned = (group.edges || []).filter(
    (e) => e && (e.source === 'provider' || e.source === 'relay')
  );
  if (!owned.length) return '';
  const providers = new Set(owned.map((e) => String(e.provider || '')));
  return providers.size === 1 ? owned[0].provider : '';
}

// The provider to add a model into for this group: by-provider uses the group
// key directly; by-key uses the resolved own-key provider; otherwise none.
function addModelProvider(group) {
  if (viewMode.value === 'by-provider' && group.groupKey) return group.groupKey;
  if (viewMode.value === 'by-key') return ownKeyGroupProvider(group);
  return '';
}

// Coverage summary for the read-only system-key bucket (state transparency:
// explain WHAT it covers and WHY it's read-only, instead of a bare label).
function systemBucketSummary(group) {
  const edges = group.edges || [];
  const providers = new Set(edges.map((e) => String(e.provider || '')).filter(Boolean));
  return `系统统管 · 只读 · 覆盖 ${providers.size} 个供应商 / ${edges.length} 个模型`;
}

// Jump to the provider/key editor card. Replacing a key is a one-click action
// on each key entry there (the「替换」button), so the pivot only routes there.
function scrollToProviderEditor(provider) {
  // 供应商 / 密钥卡现在位于「密钥与供应商」标签页。若目标 pane 未激活,
  // 元素处于 display:none 无法滚动定位 —— 先切到该页,nextTick 后再滚动。
  activeTab.value = 'keys';
  nextTick(() => {
    const el = typeof document !== 'undefined' ? document.getElementById('mg-provider-card') : null;
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  if (provider) {
    showInfo(
      `请在「自定义供应商 / 密钥池」里点供应商「${provider}」某条密钥旁的「替换」按钮更新 Key`
    );
  }
}

// Human-readable summary of the last detection / catalog read (state transparency).
const detectionLine = computed(() => {
  const s = gw.detectionSummary.value || gw.catalogSources.value;
  if (!s) return '';
  const parts = [];
  if (s.upstream)
    parts.push(`上游探测新增 ${s.upstream.added ?? 0}（共 ${s.upstream.total ?? 0}）`);
  if (s.local)
    parts.push(s.local.running ? `本地 Ollama ${s.local.count ?? 0} 个` : '本地 Ollama 未运行');
  if (s.system) parts.push(`系统/全局 ${s.system.count ?? 0} 个`);
  return parts.join(' · ');
});
const detectionErrors = computed(() => {
  const s = gw.detectionSummary.value || gw.catalogSources.value;
  const errs = s && Array.isArray(s.errors) ? s.errors : [];
  // Only REAL failures get a red tag. Benign outcomes (an upstream simply has no
  // /models endpoint, e.g. anthropic) are folded into the soft note below instead
  // of flashing a scary "not found" on every detect.
  return errs
    .filter((e) => e && !e.benign)
    .map((e) => `${e.provider ? e.provider + ': ' : ''}${e.error || ''}`.trim())
    .filter(Boolean);
});
// Providers that were probed but legitimately advertise no catalog — shown as a
// muted note (state transparency) rather than an error.
const detectionSkipped = computed(() => {
  const s = gw.detectionSummary.value || gw.catalogSources.value;
  const errs = s && Array.isArray(s.errors) ? s.errors : [];
  const names = errs.filter((e) => e && e.benign && e.provider).map((e) => e.provider);
  return Array.from(new Set(names));
});

onMounted(() => {
  gw.fetchAll();
  // 客户端应用页签懒加载：只在用户真的打开过时才拉登记表 + 扫描，
  // 避免每次进「我的网关」都白跑一次本机探测（12 个 app 的 existsSync + 反读）。
  if (activeTab.value === 'clientApps' && !caCatalog.value) caFetchAll();
});

// 打开页签时若还没加载过就加载一次；已加载过则不重复拉（扫描靠用户点按钮刷新）。
watch(activeTab, (v) => {
  safeSet(TAB_STORAGE_KEY, v);
  if (v === 'clientApps' && !caCatalog.value) caFetchAll();
});

async function onDetect() {
  try {
    await gw.detectModels();
    showSuccess('检测完成');
  } catch (err) {
    showError(err?.response?.data?.message || '检测失败');
  }
}

async function onSaveRelay(payload) {
  try {
    await gw.saveRelayConfig(payload);
    showSuccess('上游配置已保存');
  } catch (err) {
    showError(err?.response?.data?.message || '保存失败');
  }
}

async function onAddProvider(payload) {
  providerBusy.value = true;
  try {
    // The card always sends a `models` array (possibly empty); the provider+key
    // is created first, then each seed model is added to it so a brand-new
    // provider/key/model trio lands in one submit. Key creation must succeed
    // before seeding; seeding failures are reported but never undo the key.
    const seedModels = Array.isArray(payload?.models) ? payload.models : [];
    const provider = String(payload?.provider || '')
      .trim()
      .toLowerCase();
    const providerPayload = { ...payload };
    delete providerPayload.models;
    await gw.addProvider(providerPayload);

    let seeded = 0;
    const failed = [];
    for (const model of seedModels) {
      // 状态透明:多条目循环要带「动作+目标+进度」(RUNTIME-002),不能只给静态 spinner。
      providerProgress.value = `正在添加模型 ${model}（第 ${seeded + 1}/${seedModels.length} 个）…`;
      try {
        // eslint-disable-next-line no-await-in-loop
        await gw.addModel({ provider, model });
        seeded += 1;
      } catch (e) {
        // A 409 (already present) is benign — the model is effectively there.
        if (e?.response?.status === 409) seeded += 1;
        else failed.push(model);
      }
    }
    providerProgress.value = '';
    if (!seedModels.length) showSuccess('已添加密钥');
    else if (!failed.length) showSuccess(`已添加密钥，并新增 ${seeded} 个模型`);
    else
      showWarning(
        `已添加密钥；${seeded} 个模型已加，${failed.length} 个失败：${failed.join(', ')}`
      );
  } catch (err) {
    providerProgress.value = '';
    const code = err?.response?.status;
    showError(code === 409 ? '该密钥已存在' : err?.response?.data?.message || '添加失败');
  } finally {
    providerBusy.value = false;
  }
}

// ── Config wizard submit (ProviderConfigDialog) ──
// add  → create the provider+key, then seed each chosen model.
// edit → updateProvider (may rotate key / rename provider — backend migrates the
//        provider's models), then diff the chosen model set against the original
//        and add/remove rows keyed by the (possibly new) provider name.
async function onConfigSubmit(payload) {
  configBusy.value = true;
  try {
    if (payload.mode === 'edit') await submitEditConfig(payload);
    else await submitAddConfig(payload);
    configVisible.value = false;
  } catch (err) {
    const code = err?.response?.status;
    showError(
      code === 409 ? '该供应商 / 密钥已存在' : err?.response?.data?.message || '保存失败'
    );
  } finally {
    configBusy.value = false;
  }
}

async function submitAddConfig(payload) {
  const provider = payload.provider;
  const providerPayload = { provider, displayName: payload.displayName, key: payload.key };
  if (payload.baseUrl) providerPayload.baseUrl = payload.baseUrl;
  if (payload.apiFormat) providerPayload.apiFormat = payload.apiFormat;
  if (payload.endpoint) providerPayload.endpoint = payload.endpoint;
  await gw.addProvider(providerPayload);

  let seeded = 0;
  const failed = [];
  const total = payload.models.length;
  for (const model of payload.models) {
    providerProgress.value = total
      ? `正在添加模型 ${model}（第 ${seeded + 1}/${total} 个）…`
      : '';
    try {
      // eslint-disable-next-line no-await-in-loop
      await gw.addModel({ provider, model });
      seeded += 1;
    } catch (e) {
      if (e?.response?.status === 409) seeded += 1;
      else failed.push(model);
    }
  }
  providerProgress.value = '';
  if (!total) showSuccess('已添加供应商');
  else if (!failed.length) showSuccess(`已添加供应商，并新增 ${seeded} 个模型`);
  else
    showWarning(
      `已添加供应商；${seeded} 个模型已加，${failed.length} 个失败：${failed.join(', ')}`
    );
}

async function submitEditConfig(payload) {
  const patch = {
    provider: payload.provider,
    displayName: payload.displayName,
    baseUrl: payload.baseUrl,
    apiFormat: payload.apiFormat,
    endpoint: payload.endpoint,
  };
  // Empty key means "keep the current secret" — only send a rotation when typed.
  if (payload.key) patch.key = payload.key;
  await gw.updateProvider(payload.id, patch);
  // Rename migrates the provider's models to the new name; refresh before diffing.
  await gw.fetchModels();

  const provider = payload.provider;
  const finalSet = new Set(payload.models);
  const initialSet = new Set(payload.initialModels);

  // Add models the user introduced in the dialog (409 = already there, benign).
  const toAdd = payload.models.filter((m) => !initialSet.has(m));
  let added = 0;
  for (const model of toAdd) {
    providerProgress.value = toAdd.length
      ? `正在添加模型 ${model}（第 ${added + 1}/${toAdd.length} 个）…`
      : '';
    try {
      // eslint-disable-next-line no-await-in-loop
      await gw.addModel({ provider, model });
      added += 1;
    } catch (e) {
      if (e?.response?.status !== 409) throw e;
      added += 1;
    }
  }
  // Remove models the user dropped — resolve each to its row id under the (new)
  // provider name. Only touch rows that were in the original set (never delete a
  // model that detection added between open and submit).
  const rows = (gw.models.value || []).filter(
    (m) => m && String(m.provider || '').toLowerCase() === provider
  );
  const toRemove = rows.filter(
    (row) => initialSet.has(row.model) && !finalSet.has(row.model)
  );
  const removeFailures = [];
  for (let i = 0; i < toRemove.length; i += 1) {
    const row = toRemove[i];
    providerProgress.value = toRemove.length
      ? `正在移除模型 ${row.model}（第 ${i + 1}/${toRemove.length} 个）…`
      : '';
    try {
      // eslint-disable-next-line no-await-in-loop
      await gw.removeModel(row.id);
    } catch (e) {
      // 删除失败不再静默吞掉：收集起来，最终用 warning 诚实汇报（RUNTIME-002.2）。
      removeFailures.push(`${row.model}（${e?.response?.status || '请求失败'}）`);
    }
  }
  providerProgress.value = '';
  if (removeFailures.length) {
    showWarning(
      `供应商配置已保存；但有 ${removeFailures.length} 个模型删除失败：` +
        removeFailures.slice(0, 5).join('、') +
        (removeFailures.length > 5 ? ' 等' : '') +
        '（可稍后在「模型总览」手动移除）'
    );
  } else {
    showSuccess('供应商配置已保存');
  }
}

async function onAddProviderModel(provider) {
  await promptAddModelForProvider(
    String(provider || '')
      .trim()
      .toLowerCase()
  );
}

async function onRemoveEntry(id) {
  try {
    await gw.removeProviderEntry(id);
    showSuccess('已移除密钥');
  } catch (err) {
    showError(err?.response?.data?.message || '移除失败');
  }
}

async function onReplaceEntry({ id, key }) {
  try {
    await gw.replaceProviderKey(id, key);
    showSuccess('密钥已替换');
  } catch (err) {
    const code = err?.response?.status;
    showError(code === 409 ? '该密钥已存在' : err?.response?.data?.message || '替换失败');
  }
}

async function onRemoveProvider(provider) {
  try {
    await gw.removeProvider(provider);
    showSuccess(`已删除 provider「${provider}」`);
  } catch (err) {
    showError(err?.response?.data?.message || '删除失败');
  }
}

async function onAddModel(payload) {
  modelBusy.value = true;
  try {
    await gw.addModel(payload);
    showSuccess('已添加模型');
  } catch (err) {
    const code = err?.response?.status;
    showError(code === 409 ? '该模型已存在' : err?.response?.data?.message || '添加失败');
  } finally {
    modelBusy.value = false;
  }
}

async function onUpdateModel({ id, patch }) {
  try {
    await gw.updateModel(id, patch);
    showSuccess('已更新');
  } catch (err) {
    const code = err?.response?.status;
    showError(code === 409 ? '同名模型已存在' : err?.response?.data?.message || '更新失败');
  }
}

async function onRemoveModel(id) {
  try {
    await gw.removeModel(id);
    showSuccess('已删除模型');
  } catch (err) {
    showError(err?.response?.data?.message || '删除失败');
  }
}

// ── Inline pivot edits (any view) — drive the SAME row mutations as MyModelsCard.
//    gw.updateModel/removeModel refetch the catalog internally, so the change is
//    immediately visible in every pivot view. Only row-backed user edges reach
//    here (template gate userEdgeEditable); system / local / rowless stay read-only.

async function onPivotChangeCapability(edge, capability) {
  const id = userEdgeRowId(edge, gw.models.value);
  if (id == null || capability === edge.capability) return;
  modelBusy.value = true;
  try {
    await gw.updateModel(id, { capability });
    showSuccess('已更新能力');
  } catch (err) {
    showError(err?.response?.data?.message || '更新失败');
  } finally {
    modelBusy.value = false;
  }
}

async function onPivotToggleActive(edge, isActive) {
  const id = userEdgeRowId(edge, gw.models.value);
  if (id == null) return;
  modelBusy.value = true;
  try {
    await gw.updateModel(id, { isActive });
    showSuccess(isActive ? '已启用' : '已停用');
  } catch (err) {
    showError(err?.response?.data?.message || '更新失败');
  } finally {
    modelBusy.value = false;
  }
}

async function onPivotRemove(edge) {
  const id = userEdgeRowId(edge, gw.models.value);
  if (id == null) return;
  try {
    await ElMessageBox.confirm(`确认从你的列表删除「${edge.model}」吗？`, '删除模型', {
      type: 'warning',
    });
  } catch {
    return; /* cancelled */
  }
  modelBusy.value = true;
  try {
    await gw.removeModel(id);
    showSuccess('已删除模型');
  } catch (err) {
    showError(err?.response?.data?.message || '删除失败');
  } finally {
    modelBusy.value = false;
  }
}

// Single source for "add one model to a resolved provider": prompt for the id,
// then call the per-user models API. Shared by the catalog pivot affordance and
// the provider-key card's "+ 添加模型".
async function promptAddModelForProvider(provider) {
  if (!provider) return showWarning('该分组无法确定归属供应商，无法添加');
  let model = '';
  try {
    const res = await ElMessageBox.prompt(`为供应商「${provider}」添加一个模型 ID`, '添加模型', {
      inputPlaceholder: '如 deepseek-chat / gpt-4o-mini',
      confirmButtonText: '添加',
      cancelButtonText: '取消',
    });
    model = String(res?.value || '').trim();
  } catch {
    return; /* cancelled */
  }
  if (!model) return showWarning('请填写模型 ID');
  modelBusy.value = true;
  try {
    await gw.addModel({ provider, model });
    showSuccess('已添加模型');
  } catch (err) {
    const code = err?.response?.status;
    showError(code === 409 ? '该模型已存在' : err?.response?.data?.message || '添加失败');
  } finally {
    modelBusy.value = false;
  }
}

async function onAddModelToGroup(group) {
  // by-provider → group key is the provider; by-key own-key → resolved provider.
  await promptAddModelForProvider(addModelProvider(group));
}

async function onIssueToken(label) {
  ccBusy.value = true;
  try {
    const row = await gw.issueCcToken(label);
    if (row?.key) {
      justIssued.value = row.key;
      showSuccess('已签发新 Token');
    }
  } catch (err) {
    showError(err?.response?.data?.message || '签发失败');
  } finally {
    ccBusy.value = false;
  }
}

async function onRevokeToken(id) {
  try {
    await gw.revokeCcToken(id);
    showSuccess('Token 已撤销');
  } catch (err) {
    showError(err?.response?.data?.message || '撤销失败');
  }
}
</script>

<style scoped>
.my-gateway {
  max-width: 1280px;
  margin: 0 auto;
}
.mg-intro {
  margin-bottom: 20px;
  padding: 16px 20px;
  border: 1px solid var(--khy-border-light);
  border-radius: var(--khy-radius);
  background:
    radial-gradient(120% 140% at 0% 0%, var(--khy-primary-soft), transparent 55%),
    var(--khy-bg-card-grad);
  box-shadow: var(--khy-shadow);
}
.mg-title {
  margin: 0 0 4px;
  padding-left: 12px;
  font-size: 20px;
  font-weight: 700;
  color: var(--khy-text-strong);
  position: relative;
}
.mg-title::before {
  content: '';
  position: absolute;
  left: 0;
  top: 2px;
  bottom: 2px;
  width: 4px;
  border-radius: 4px;
  background: linear-gradient(180deg, var(--khy-primary), var(--khy-primary-strong));
}
.mg-sub {
  margin: 0;
  color: var(--khy-text-secondary);
  font-size: 13px;
  line-height: 1.5;
}
.mg-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 16px;
  align-items: start;
}
.mg-tabs {
  margin-top: 4px;
}
.mg-catalog-card {
  margin-top: 16px;
}
.mg-catalog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.mg-catalog-title {
  font-weight: 600;
  color: var(--khy-text-strong);
}
.mg-catalog-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.mg-catalog-search {
  max-width: 220px;
}
.mg-detect-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.mg-detect-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.mg-detect-skip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  opacity: 0.8;
}
.mg-pivot-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.mg-pivot-group {
  padding: 12px 14px;
  border: 1px solid var(--khy-border-light);
  border-radius: var(--khy-radius-sm);
  background: var(--khy-bg-card);
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.2s ease;
}
.mg-pivot-group:hover {
  border-color: var(--khy-border);
  box-shadow: var(--khy-shadow);
  transform: translateY(-1px);
}
.mg-pivot-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.mg-pivot-group-name {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.mg-pivot-group-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.mg-key-mask {
  font-family: var(--el-font-family, monospace);
  letter-spacing: 0.5px;
}
.mg-pivot-group-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.mg-pivot-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mg-pivot-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-radius: var(--khy-radius-sm);
  background: var(--khy-bg-soft);
  transition: background-color 0.15s ease;
}
.mg-pivot-row:hover {
  background: var(--khy-bg-hover);
}
.mg-pivot-model {
  font-family: var(--el-font-family, monospace);
  font-size: 13px;
  color: var(--el-text-color-primary);
}
.mg-pivot-cap {
  width: 92px;
}

/* ---- 客户端应用（[DESIGN-ARCH-189] S1）------------------------------------ */
.mg-clientapps {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.mg-clientapps-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.mg-clientapps-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}
.mg-clientapps-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.mg-clientapps-filters {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.mg-clientapps-search {
  width: 220px;
}
.mg-clientapps-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.mg-clientapps-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--khy-radius-sm, 6px);
  background: var(--khy-bg-soft);
}
/* 未安装的卡淡化，但不禁用——用户仍需要看到「有这个客户端、该配什么」。 */
.mg-clientapps-card[data-installed='0'] {
  opacity: 0.62;
}
.mg-clientapps-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.mg-clientapps-card-name {
  font-size: 13px;
  font-weight: 600;
}
.mg-clientapps-card-desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-regular);
}
.mg-clientapps-card-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.mg-clientapps-pkg {
  font-family: var(--el-font-family, monospace);
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.mg-clientapps-card-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mg-clientapps-model-disabled {
  font-size: 12px;
  color: var(--el-text-color-disabled);
  border-bottom: 1px dashed var(--el-border-color);
  cursor: not-allowed;
}
.mg-clientapps-card-note {
  font-size: 11px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
