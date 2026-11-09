import { ref, onUnmounted } from 'vue';
import request from '@/api/request';
import { unwrap } from '@/api/unwrap';
import { useLoadError, loadInto } from '@/api/loadError';

/**
 * Composable for real-time AI Monitor SSE connection.
 */
export function useAIMonitor() {
  const traces = ref([]);
  const stats = ref(null);
  const connected = ref(false);
  const loadError = useLoadError();
  // 'idle' 未连 | 'connecting' 首连/重连中 | 'connected' 已连 | 'failed' 重连预算用尽。
  // 'failed' 是终态：不再有后台重试，UI 必须改成让用户手动点，而不是继续说
  // 「正在重连」。
  const linkStatus = ref('idle');
  let eventSource = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 10;

  async function fetchStats() {
    const next = await loadInto('监控统计', loadError, async () =>
      unwrap(await request.get('/api/ai-gateway/monitor/stats'))
    );
    if (next) stats.value = next;
  }

  async function fetchTraces(filter = {}) {
    const next = await loadInto('调用轨迹', loadError, async () => {
      const params = new URLSearchParams();
      if (filter.limit) params.set('limit', filter.limit);
      if (filter.offset) params.set('offset', filter.offset);
      if (filter.provider) params.set('provider', filter.provider);
      if (filter.success !== undefined && filter.success !== null && filter.success !== '') {
        params.set('success', String(filter.success));
      }
      if (filter.since) params.set('since', filter.since);
      return unwrap(await request.get(`/api/ai-gateway/monitor/traces?${params}`));
    });
    // 读失败时不清空已有轨迹：空列表在页面上和「这段时间没有请求」长得一样。
    if (next) traces.value = next.traces || [];
  }

  function connectSSE() {
    if (eventSource) return;
    clearTimeout(reconnectTimer);
    const baseUrl = request.defaults?.baseURL || '';
    eventSource = new EventSource(`${baseUrl}/api/ai-gateway/monitor/stream`);
    eventSource.onopen = () => {
      connected.value = true;
      linkStatus.value = 'connected';
      reconnectAttempts = 0;
    };
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.id) {
          // Update or add trace
          const idx = traces.value.findIndex((t) => t.id === data.id);
          if (idx >= 0) traces.value[idx] = data;
          else traces.value.unshift(data);
          // Keep max 50
          if (traces.value.length > 50) traces.value.pop();
        }
      } catch {
        /* ignore */
      }
    };
    eventSource.onerror = () => {
      connected.value = false;
      // Close the broken connection and schedule a reconnect with exponential backoff
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts));
        reconnectAttempts++;
        linkStatus.value = 'connecting';
        reconnectTimer = setTimeout(connectSSE, delay);
      } else {
        // 10 次用尽：落终态并停表。留在这里不置位的话，UI 会一直显示「重连中」，
        // 而下一次连接永远不会被安排。
        linkStatus.value = 'failed';
      }
    };
  }

  // 终态后的手动重连：重置预算并立刻再连一次，不让用户干等下一个定时器。
  function retryNow() {
    if (linkStatus.value !== 'failed') return;
    reconnectAttempts = 0;
    linkStatus.value = 'connecting';
    connectSSE();
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempts = 0;
    if (eventSource) {
      eventSource.close();
      eventSource = null;
      connected.value = false;
      linkStatus.value = 'idle';
    }
  }

  onUnmounted(disconnect);

  return {
    traces,
    stats,
    connected,
    loadError,
    linkStatus,
    retryNow,
    fetchStats,
    fetchTraces,
    connectSSE,
    disconnect,
  };
}
