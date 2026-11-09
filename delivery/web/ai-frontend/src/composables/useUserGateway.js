import { ref } from 'vue';
import request from '@/api/request';
import { unwrap } from '@/api/unwrap';
import { useLoadError, loadInto, describeLoadError } from '@/api/loadError';

/**
 * Per-user (multi-tenant) gateway state.
 *
 * Talks ONLY to `/api/user-gateway/*` (auth-only, scoped to req.user.id on the
 * backend). This is the user-domain twin of the admin `useGateway` composable;
 * the two share the presentational gateway cards but never share endpoints —
 * a normal user can only ever read/write their own relay config, provider key
 * pool, and CC tokens. Shared `unwrap(res)` envelope handling from `@/api/unwrap`.
 */

export function useUserGateway() {
  const relayConfig = ref(null);
  const providers = ref([]);
  const ccEndpoint = ref(null);
  const ccTokens = ref([]);
  const catalogEdges = ref([]);
  const catalogSources = ref(null);
  const detectionSummary = ref(null);
  const detecting = ref(false);
  const providerPresets = ref([]);
  const models = ref([]);
  const imageConfig = ref(null);
  const loading = ref(false);
  const saving = ref(false);
  // detectionSummary 的 error 标签是给「已发起探测但上游有问题」用的；列表读取本身
  // 失败时页面上还没有任何探测上下文，只能靠这条错误位让横幅说话。
  const loadError = useLoadError();

  // 读取失败要同时喂两条通道：detectionSummary.errors 是本文件既有的错误面
  // （MyGateway 的 danger 标签在渲染它），loadError 是页面级横幅。两条都得写，
  // 少一条就有一处 UI 拿不到失败原因。
  function recordFetchFailure(source, subject, err) {
    surfaceError(source, err);
    loadError.value = describeLoadError(err, subject);
  }

  // ── Relay config (per-user upstream) ──
  async function fetchRelayConfig() {
    try {
      const res = await request.get('/api/user-gateway/model-config');
      relayConfig.value = unwrap(res);
    } catch {
      /* ignore */
    }
  }

  async function saveRelayConfig(payload) {
    saving.value = true;
    try {
      const res = await request.put('/api/user-gateway/model-config', payload);
      relayConfig.value = unwrap(res);
      // The save auto-probes the relay; surface its outcome + refresh the catalog
      // so newly detected models appear without a separate click.
      const detection = res?.data?.detection;
      if (detection)
        detectionSummary.value = {
          upstream: { ...detection },
          errors:
            detection.error && !detection.benign
              ? [{ source: 'upstream', provider: detection.provider, error: detection.error }]
              : [],
        };
      await fetchCatalog();
      return relayConfig.value;
    } finally {
      saving.value = false;
    }
  }

  // Surface a backend failure into the already-rendered detection-error channel
  // (the model-overview shows `detectionSummary.errors` as danger tags). This is
  // what turns a silent blank "失效为空" into a diagnosable reason — without it a
  // catalog/providers 500 (e.g. DB unreachable, schema not materialized) is
  // indistinguishable from an empty config. Merges into any existing errors
  // rather than clobbering them, and de-duplicates by source.
  function surfaceError(source, err) {
    const message = err?.response?.data?.message || err?.message || '请求失败';
    const prev =
      detectionSummary.value && Array.isArray(detectionSummary.value.errors)
        ? detectionSummary.value.errors
        : [];
    detectionSummary.value = {
      ...(detectionSummary.value || {}),
      errors: [...prev.filter((e) => e.source !== source), { source, error: message }],
    };
  }

  // ── Custom providers + key pool (per-user) ──
  async function fetchProviders() {
    try {
      const res = await request.get('/api/user-gateway/custom-providers');
      providers.value = unwrap(res) || [];
      loadError.value = '';
    } catch (err) {
      providers.value = [];
      recordFetchFailure('providers', '供应商列表', err);
    }
  }

  async function addProvider(payload) {
    const res = await request.post('/api/user-gateway/custom-providers', payload);
    await fetchProviders();
    // The add auto-probes the new provider; surface its outcome + refresh catalog.
    applyDetection(res?.data?.detection);
    await fetchCatalog();
    return unwrap(res);
  }

  async function removeProviderEntry(id) {
    await request.delete(`/api/user-gateway/custom-providers/${id}`);
    await fetchProviders();
  }

  // Surface a post-save detection probe into detectionSummary. A benign outcome
  // (upstream simply has no /models endpoint) is NOT shown as an error so the UI
  // stays quiet instead of flashing a scary "not found" on every save.
  function applyDetection(detection) {
    if (!detection) return;
    detectionSummary.value = {
      upstream: { ...detection },
      errors:
        detection.error && !detection.benign
          ? [{ source: 'upstream', provider: detection.provider, error: detection.error }]
          : [],
    };
  }

  async function replaceProviderKey(id, key) {
    const res = await request.put(`/api/user-gateway/custom-providers/${id}`, { key });
    await fetchProviders();
    applyDetection(res?.data?.detection);
    await fetchCatalog();
    return unwrap(res);
  }

  // Edit a provider entry in place — a richer patch than replaceProviderKey. May
  // change displayName / baseUrl / apiFormat / endpoint, rotate the key (omit or
  // empty `key` to keep the current one), and even RENAME the provider (backend
  // migrates that provider's models to the new name). Refreshes providers +
  // catalog and surfaces the post-save re-probe like addProvider does.
  async function updateProvider(id, patch) {
    const res = await request.put(`/api/user-gateway/custom-providers/${id}`, patch || {});
    await fetchProviders();
    applyDetection(res?.data?.detection);
    await fetchCatalog();
    return unwrap(res);
  }

  // DRY-RUN "测试连接": probe an upstream config (baseUrl/endpoint + key +
  // apiFormat) WITHOUT persisting, so the config dialog can verify a key and
  // offer one-click model import before the user commits. Returns
  // { ok, count, models:[{id,capability}], error }.
  async function testProviderConfig(payload) {
    const res = await request.post('/api/user-gateway/providers/test', payload || {});
    return unwrap(res) || { ok: false, count: 0, models: [], error: '测试失败' };
  }

  async function removeProvider(provider) {
    await request.delete(`/api/user-gateway/providers/by-name/${encodeURIComponent(provider)}`);
    await fetchProviders();
  }

  // ── Unified multi-pivot catalog (per-user) ──
  async function fetchCatalog() {
    try {
      const res = await request.get('/api/user-gateway/catalog');
      const payload = unwrap(res) || {};
      catalogEdges.value = Array.isArray(payload.edges) ? payload.edges : [];
      catalogSources.value = payload.sources || null;
      loadError.value = '';
    } catch (err) {
      catalogEdges.value = [];
      catalogSources.value = null;
      recordFetchFailure('catalog', '模型目录', err);
    }
  }

  // Manual "检测/刷新": run a fresh upstream probe + persist sweep, then refresh
  // the catalog from the enriched result. `detectionSummary` exposes the
  // per-source counts + any probe errors for transparent display.
  async function detectModels() {
    detecting.value = true;
    try {
      const res = await request.post('/api/user-gateway/detect', {});
      const payload = unwrap(res) || {};
      catalogEdges.value = Array.isArray(payload.edges) ? payload.edges : [];
      catalogSources.value = payload.sources || null;
      detectionSummary.value = payload.sources || null;
      return payload;
    } catch (err) {
      detectionSummary.value = {
        errors: [{ source: 'request', error: err?.message || 'detect failed' }],
      };
      throw err;
    } finally {
      detecting.value = false;
    }
  }

  // ── CC access (unified proxy endpoint + channel tokens) ──
  async function fetchCcEndpoint() {
    try {
      const res = await request.get('/api/user-gateway/cc/endpoint');
      ccEndpoint.value = unwrap(res);
    } catch {
      /* ignore */
    }
  }

  async function fetchCcTokens() {
    const next = await loadInto('CC 令牌', loadError, async () =>
      unwrap(await request.get('/api/user-gateway/cc/tokens')) || []
    );
    if (next) ccTokens.value = next;
  }

  // Returns the freshly issued token row, including the one-time plaintext `key`.
  async function issueCcToken(label) {
    const res = await request.post('/api/user-gateway/cc/tokens', { label });
    await fetchCcTokens();
    return unwrap(res);
  }

  async function revokeCcToken(id) {
    await request.delete(`/api/user-gateway/cc/tokens/${id}`);
    await fetchCcTokens();
  }

  // ── My model list (per-user persisted models — full CRUD) ──
  // Edits the user's own user_provider_models rows directly: add/rename/edit
  // capability/toggle active/delete. The live catalog still merges these with
  // local Ollama + system metadata; this is the editable source of truth for the
  // user's OWN models. Every write refreshes the catalog so pivots stay in sync.
  async function fetchModels(provider) {
    const url = provider
      ? `/api/user-gateway/models?provider=${encodeURIComponent(provider)}`
      : '/api/user-gateway/models';
    const next = await loadInto('我的模型', loadError, async () => unwrap(await request.get(url)) || []);
    if (next) models.value = next;
    return models.value;
  }

  async function addModel(payload) {
    const res = await request.post('/api/user-gateway/models', payload);
    await Promise.all([fetchModels(), fetchCatalog()]);
    return unwrap(res);
  }

  async function updateModel(id, patch) {
    const res = await request.patch(`/api/user-gateway/models/${id}`, patch);
    await Promise.all([fetchModels(), fetchCatalog()]);
    return unwrap(res);
  }

  async function removeModel(id) {
    await request.delete(`/api/user-gateway/models/${id}`);
    await Promise.all([fetchModels(), fetchCatalog()]);
  }

  // ── Built-in provider presets (relay + custom-provider dropdowns) ──
  async function fetchProviderPresets() {
    try {
      const res = await request.get('/api/user-gateway/provider-presets');
      providerPresets.value = unwrap(res) || [];
    } catch {
      providerPresets.value = [];
    }
  }

  // ── Image-generation model preference (per-user) ──
  async function fetchImageConfig() {
    try {
      const res = await request.get('/api/user-gateway/image-config');
      imageConfig.value = unwrap(res);
    } catch {
      /* ignore */
    }
  }

  async function updateImageConfig(payload) {
    const res = await request.put('/api/user-gateway/image-config', payload);
    await fetchImageConfig();
    return unwrap(res);
  }

  async function fetchAll() {
    loading.value = true;
    try {
      await Promise.all([
        fetchRelayConfig(),
        fetchProviders(),
        fetchCatalog(),
        fetchCcEndpoint(),
        fetchCcTokens(),
        fetchProviderPresets(),
        fetchModels(),
        fetchImageConfig(),
      ]);
    } finally {
      loading.value = false;
    }
  }

  return {
    relayConfig,
    providers,
    ccEndpoint,
    ccTokens,
    catalogEdges,
    catalogSources,
    detectionSummary,
    detecting,
    providerPresets,
    models,
    imageConfig,
    loading,
    saving,
    loadError,
    fetchRelayConfig,
    saveRelayConfig,
    fetchProviders,
    addProvider,
    removeProviderEntry,
    removeProvider,
    replaceProviderKey,
    updateProvider,
    testProviderConfig,
    fetchCatalog,
    detectModels,
    fetchProviderPresets,
    fetchModels,
    addModel,
    updateModel,
    removeModel,
    fetchImageConfig,
    updateImageConfig,
    fetchCcEndpoint,
    fetchCcTokens,
    issueCcToken,
    revokeCcToken,
    fetchAll,
  };
}
