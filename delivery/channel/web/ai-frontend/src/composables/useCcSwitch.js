import { ref } from 'vue';
import { ccSwitchApi } from '@/api/ccSwitch';
import { unwrap } from '@/api/unwrap';

/**
 * Composable for CC-Switch agent application matrix (DESIGN-ARCH-101).
 *
 * One provider card → many agents: the view picks a card per app and applies it
 * with a mode. mode: 'proxy' (default) points the agent at the khy gateway
 * (gateway token, protocol bridging); 'direct' writes the provider endpoint+key.
 */
export function useCcSwitch() {
  const apps = ref([]);
  const cards = ref([]);
  const loading = ref(false);
  const applying = ref('');
  // app → 选中的卡片 id（应用矩阵行上的选择器状态）
  const pick = ref({});

  async function fetchAll() {
    try {
      loading.value = true;
      const [statusRes, cardsRes] = await Promise.all([ccSwitchApi.status(), ccSwitchApi.listCards()]);
      apps.value = unwrap(statusRes) || [];
      cards.value = (unwrap(cardsRes) || []).filter((c) => c.enabled !== false);
      // 预填：状态里已有激活卡的 app 默认选中该卡
      const prefill = {};
      for (const a of apps.value) {
        if (a.activeCardId) prefill[a.app] = a.activeCardId;
      }
      pick.value = { ...prefill, ...pick.value };
    } catch {
      /* 拦截器已 toast；矩阵置空即可 */
    } finally {
      loading.value = false;
    }
  }

  /**
   * 把卡片应用到 agent。mode 省略时走后端默认（proxy）。
   * 成功后回读状态以刷新 activeCardId（来源唯一：后端 store）。
   */
  async function applyToApp(app, mode) {
    const cardId = pick.value[app];
    if (!cardId) return { ok: false, error: '请先为该应用选择一张卡片' };
    try {
      applying.value = app;
      const res = await ccSwitchApi.useCard(cardId, app, mode);
      const data = unwrap(res);
      await fetchAll();
      return { ok: true, data, mode: data?.mode || mode || 'proxy' };
    } catch (e) {
      return { ok: false, error: e?.message || '应用失败' };
    } finally {
      applying.value = '';
    }
  }

  function labelOf(appId) {
    const hit = apps.value.find((a) => a.app === appId);
    return hit?.label || appId;
  }

  return { apps, cards, pick, loading, applying, fetchAll, applyToApp, labelOf };
}
