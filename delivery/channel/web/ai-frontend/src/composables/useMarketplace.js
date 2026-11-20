import { ref } from 'vue';
import request from '@/api/request';
import { unwrap } from '@/api/unwrap';
import { useLoadError, loadInto } from '@/api/loadError';

/**
 * Per-user (multi-tenant) plugin marketplace state.
 *
 * Talks to `/api/marketplace/*` (catalog browse + install) and `/api/plugins/*`
 * (the caller's installed plugins). Mirrors `useWorkflow`: shared `unwrap(res)`
 * envelope handling (from `@/api/unwrap`) and ref-backed state. Everything is
 * scoped to the logged-in user on the backend — a user only ever sees/changes
 * their own installs.
 */

export function useMarketplace() {
  const catalog = ref([]);
  const categories = ref([]);
  const installed = ref([]);
  const loading = ref(false);
  const busy = ref(false);
  const loadError = useLoadError();

  // ── Catalog (browse / search / detail) ──────────────────────────────────
  async function listCatalog(params = {}) {
    loading.value = true;
    try {
      // 读失败时 catalog 保持上一次的结果并把原因交给横幅：写回 [] 会让一个
      // 500 的市场在页面上显示成「插件市场还空着」。
      const next = await loadInto('插件市场', loadError, async () =>
        unwrap(await request.get('/api/marketplace', { params })) || []
      );
      if (next) catalog.value = next;
      return catalog.value;
    } finally {
      loading.value = false;
    }
  }

  async function fetchCategories() {
    const next = await loadInto('插件分类', loadError, async () =>
      unwrap(await request.get('/api/marketplace/categories')) || []
    );
    if (next) categories.value = next;
    return categories.value;
  }

  async function getDetail(id) {
    const res = await request.get(`/api/marketplace/${id}`);
    return unwrap(res);
  }

  async function install(id, authConfig) {
    busy.value = true;
    try {
      const res = await request.post(
        `/api/marketplace/${id}/install`,
        authConfig ? { authConfig } : {}
      );
      return unwrap(res);
    } finally {
      busy.value = false;
    }
  }

  async function uninstallFromCatalog(id) {
    const res = await request.post(`/api/marketplace/${id}/uninstall`, {});
    return unwrap(res);
  }

  // ── Installed (the caller's plugins) ────────────────────────────────────
  async function listInstalled() {
    loading.value = true;
    try {
      const next = await loadInto('已安装插件', loadError, async () =>
        unwrap(await request.get('/api/plugins')) || []
      );
      if (next) installed.value = next;
      return installed.value;
    } finally {
      loading.value = false;
    }
  }

  // Import a plugin from raw OpenAPI / a URL / a Coze manifest (publishes a
  // private catalog row + auto-installs). Default does NOT persist on preview.
  async function previewImport(body) {
    const res = await request.post('/api/plugins/preview', body || {});
    return unwrap(res);
  }

  async function importPlugin(body) {
    busy.value = true;
    try {
      const res = await request.post('/api/plugins/import', body || {});
      await listInstalled();
      return unwrap(res);
    } finally {
      busy.value = false;
    }
  }

  async function setEnabled(installId, enabled) {
    const res = await request.patch(`/api/plugins/${installId}`, { enabled });
    await listInstalled();
    return unwrap(res);
  }

  async function setAuth(installId, authConfig) {
    const res = await request.put(`/api/plugins/${installId}/auth`, { authConfig });
    await listInstalled();
    return unwrap(res);
  }

  async function testInvoke(installId, operationId, args) {
    const res = await request.post(`/api/plugins/${installId}/test`, {
      operationId,
      args: args || {},
    });
    return unwrap(res);
  }

  async function uninstall(installId) {
    await request.delete(`/api/plugins/${installId}`);
    await listInstalled();
  }

  // Callable plugin tools for the workflow toolCall picker (the exact
  // `plugin__<slug>__<op>` names the executor/agent dispatch on).
  async function listPluginTools() {
    const res = await request.get('/api/plugins/tools');
    return unwrap(res) || [];
  }

  return {
    catalog,
    categories,
    installed,
    loading,
    busy,
    loadError,
    listCatalog,
    fetchCategories,
    getDetail,
    install,
    uninstallFromCatalog,
    listInstalled,
    previewImport,
    importPlugin,
    setEnabled,
    setAuth,
    testInvoke,
    uninstall,
    listPluginTools,
  };
}
