import { ref } from 'vue';
import request from '@/api/request';
import { unwrap } from '@/api/unwrap';
import { useLoadError, loadInto } from '@/api/loadError';

// Read-only view of the ecosystem market snapshot (GET /api/eco-markets).
// Assembly happens once on the backend (services/marketCatalog) and the same
// payload feeds the desktop pane and the CLI, so this composable must not
// recompute counts, freshness or source status — it only normalizes shapes.
//
// The endpoint never blocks on upstreams: it returns the latest snapshot (or a
// static-only one on the first call) with `refreshing`, and swaps in live data
// on the next poll. That is why there are three refresh knobs here:
//   - `loadMarkets()`      normal poll, server decides whether to re-fetch
//   - `loadMarkets(true)`  explicit user refresh, server starts a background pass
//   - `startAutoRefresh()` 3s while a pass is running, 60s otherwise
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

// Entry-level fields (compat / khyosMarket / license) stay verbatim so the view
// can label them; only the four list slots are guaranteed to exist.
function normalizeMarket(market) {
  if (!market || typeof market !== 'object') return null;
  return {
    ...market,
    entries: asArray(market.entries),
    blocked: asArray(market.blocked),
    marketplaces: asArray(market.marketplaces),
    uncertainties: asArray(market.uncertainties),
  };
}

const AUTO_REFRESH_MS = 60000;
const LIVE_POLL_MS = 3000;

export function useEcoMarkets() {
  const markets = ref([]);
  const rules = ref([]);
  const licenseGate = ref('');
  const generatedAt = ref('');
  const fetchedAt = ref('');
  const refreshing = ref(false);
  const refreshStartedAt = ref('');
  const refreshError = ref('');
  const sources = ref([]);
  const totals = ref(null);
  const degraded = ref('');
  const warnings = ref([]);
  const loading = ref(false);
  const loadError = useLoadError();
  let timer = null;

  async function loadMarkets(refresh = false) {
    // Polling must not flash the blocking overlay over a populated table.
    loading.value = markets.value.length === 0;
    try {
      const payload = await loadInto('生态市场', loadError, async () =>
        unwrap(
          await request.get('/api/eco-markets', refresh ? { params: { refresh: 1 } } : undefined)
        ) || {}
      );
      if (!payload) return;
      markets.value = asArray(payload.ecosystems)
        .map(normalizeMarket)
        .filter((m) => m && asText(m.eco));
      rules.value = asArray(payload.rules);
      licenseGate.value = asText(payload.licenseGate);
      generatedAt.value = asText(payload.generatedAt);
      fetchedAt.value = asText(payload.fetchedAt);
      refreshing.value = payload.refreshing === true;
      refreshStartedAt.value = asText(payload.refreshStartedAt);
      refreshError.value = asText(payload.refreshError);
      sources.value = asArray(payload.sources);
      totals.value = payload.totals && typeof payload.totals === 'object' ? payload.totals : null;
      degraded.value = asText(payload.degraded);
      warnings.value = asArray(payload.warnings);
    } finally {
      loading.value = false;
    }
  }

  // Single-market lookup by the ecosystem key. The same upstream can be surveyed
  // once per ecosystem with different verdicts, so callers must never merge by
  // name — `eco` is the only identity.
  function marketFor(eco) {
    const key = asText(eco);
    return markets.value.find((m) => m.eco === key) || null;
  }

  function stopTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNext(delay) {
    stopTimer();
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (hidden) return;
    timer = setTimeout(async () => {
      await loadMarkets();
      scheduleNext(refreshing.value ? LIVE_POLL_MS : AUTO_REFRESH_MS);
    }, delay);
  }

  // Pausing on hide must resume on show, otherwise a single tab switch stops
  // freshness for the rest of the session while the page still claims to be live.
  let visibilityBound = false;
  function onVisibilityChange() {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') stopTimer();
    else if (!timer) scheduleNext(0);
  }

  function startAutoRefresh() {
    if (typeof document !== 'undefined' && !visibilityBound) {
      document.addEventListener('visibilitychange', onVisibilityChange);
      visibilityBound = true;
    }
    if (timer) return;
    scheduleNext(refreshing.value ? LIVE_POLL_MS : AUTO_REFRESH_MS);
  }

  function stopAutoRefresh() {
    stopTimer();
    if (typeof document !== 'undefined' && visibilityBound) {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      visibilityBound = false;
    }
  }

  return {
    markets,
    rules,
    licenseGate,
    generatedAt,
    fetchedAt,
    refreshing,
    refreshStartedAt,
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
    marketFor,
  };
}
