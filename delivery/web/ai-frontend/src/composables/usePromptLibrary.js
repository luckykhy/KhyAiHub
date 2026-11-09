import { ref } from 'vue';
import request from '@/api/request';
import { unwrap } from '@/api/unwrap';
import { useLoadError, loadInto } from '@/api/loadError';

/**
 * Composable for the per-user Prompt Library.
 *
 * `prompts` holds the active library (status:'active'); `pending` holds the
 * AI-discovered review queue (status:'pending') the user confirms-keep (approve)
 * or discards (delete). Backed by the `/api/ai/prompts` routes.
 */
export function usePromptLibrary() {
  const prompts = ref([]);
  const pending = ref([]);
  const builtinTemplates = ref([]);
  const loading = ref(false);
  const loadError = useLoadError();

  async function fetchPrompts() {
    loading.value = true;
    try {
      const next = await loadInto('我的提示词', loadError, async () =>
        unwrap(await request.get('/api/ai/prompts', { params: { status: 'active' } })) || []
      );
      if (next) prompts.value = next;
    } finally {
      loading.value = false;
    }
  }

  async function fetchPending() {
    const next = await loadInto('待审核提示词', loadError, async () =>
      unwrap(await request.get('/api/ai/prompts', { params: { status: 'pending' } })) || []
    );
    if (next) pending.value = next;
  }

  // Built-in multi-angle starter templates (backend catalog at
  // GET /api/ai/prompts/builtin, backed by promptTemplateCatalog.js). silent:true
  // so a transient failure never pops a toast — the page keeps its local fallback,
  // so the template section is NEVER blank even offline / gated off.
  async function fetchBuiltin() {
    try {
      const res = await request.get('/api/ai/prompts/builtin', { silent: true });
      const payload = res?.data?.data || res?.data || res;
      const templates = payload && Array.isArray(payload.templates) ? payload.templates : [];
      builtinTemplates.value = templates;
    } catch {
      builtinTemplates.value = [];
    }
  }

  async function fetchAll() {
    await Promise.all([fetchPrompts(), fetchPending(), fetchBuiltin()]);
  }

  async function createPrompt(data) {
    const res = await request.post('/api/ai/prompts', data);
    await fetchAll();
    return unwrap(res);
  }

  async function updatePrompt(id, data) {
    const res = await request.put(`/api/ai/prompts/${id}`, data);
    await fetchAll();
    return unwrap(res);
  }

  async function removePrompt(id) {
    await request.delete(`/api/ai/prompts/${id}`);
    await fetchAll();
  }

  async function usePrompt(id) {
    const res = await request.post(`/api/ai/prompts/${id}/use`);
    await fetchPrompts();
    return unwrap(res);
  }

  // Promote an AI-discovered pending prompt into the active library.
  async function approvePrompt(id) {
    const res = await request.post(`/api/ai/prompts/${id}/approve`);
    await fetchAll();
    return unwrap(res);
  }

  return {
    prompts,
    pending,
    builtinTemplates,
    loading,
    loadError,
    fetchPrompts,
    fetchPending,
    fetchBuiltin,
    fetchAll,
    createPrompt,
    updatePrompt,
    removePrompt,
    usePrompt,
    approvePrompt,
  };
}
