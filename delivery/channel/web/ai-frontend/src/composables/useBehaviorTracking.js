// useBehaviorTracking — 前端行为埋点(A5):显性交互(点击/点赞/点踩/纠正/拒绝建议)
// 与隐性节奏(页面停留/滚动深度/输入节奏)归一成 user.behavior.* 事件,批量经既有
// HTTP 通道送给后端事件管道(eventLog)。
//
// 埋点是观察者不是参与者:任何一环失败只丢当前批次,绝不碰交互与渲染。所以本
// 模块没有一处异常逃得出去,views 里也不需要 try/catch 包埋点调用。
//
// 用法:
//   const behavior = useBehaviorTracking({ source: 'web:ai-chat', traceId: () => activeId.value });
//   onMounted(() => {
//     behavior.observeDwell();
//     behavior.observeScroll(chatContainer.value);
//     behavior.observeInput(chatInputBarRef.value?.$el);
//   });
//   onBeforeUnmount(() => behavior.stop());
//   behavior.track('reject', { messageId: msg.id }); // 撤回本轮 = 拒绝这条建议
import request from '@/api/request';

// 后端事件管道入口(裸路径,origin 由 request 的 baseURL 决定——规则 1 禁止把
// host 写进源码)。接收端落地前这里会 404:传输失败即丢批,不重试。
const INGEST_PATH = '/api/behavior-events';

// 显性事件词表。后端 eventLog 白名单放行整个 user.behavior. 族前缀,五 kind
// 限制是前端自查:表外 kind 直接忽略,不让拼写错误变成管道里的新类型。
const EXPLICIT_KINDS = ['click', 'like', 'dislike', 'correct', 'reject'];

// 攒够一批就发、5s 周期兜底:一次发送失败只丢该批,不重试成风暴。队列长度由
// FLUSH_BATCH 天然兜住(flush() 的 splice 发生在 await 之前),无需第二道上限。
const FLUSH_BATCH = 20;
const FLUSH_INTERVAL_MS = 5000;

// 滚动深度按 25% 一档上报;输入节奏每 20 个键一条。
const SCROLL_STEP_PCT = 25;
const INPUT_BATCH_KEYS = 20;

// 单次 HTTP 发送超时(短生命周期网络超时,不终止任何本地工作)。
const TRANSPORT_TIMEOUT_MS = 5000;

export function useBehaviorTracking(opts = {}) {
  const source = opts.source || 'web';
  // traceId 接受值或取值函数:AIChat 的会话会切换,每次 enqueue 时现取才不会
  // 把整场会话钉在第一个对话上。
  const traceIdOf =
    typeof opts.traceId === 'function' ? opts.traceId : () => (opts.traceId ?? null);
  const transport = typeof opts.transport === 'function' ? opts.transport : httpTransport;

  const queue = [];
  const teardowns = [];
  let seq = 0;
  let flushTimer = null;
  let stopped = false;

  function currentPath() {
    try {
      return typeof window !== 'undefined' && window.location
        ? String(window.location.pathname || '')
        : '';
    } catch {
      return '';
    }
  }

  function enqueue(type, payload) {
    if (stopped) {
      return;
    }
    queue.push({
      ts: new Date().toISOString(),
      seq: ++seq,
      type,
      source,
      traceId: traceIdOf(),
      payload: payload || {},
    });
    if (queue.length >= FLUSH_BATCH) {
      flush();
    }
    ensureTimer();
  }

  function ensureTimer() {
    if (flushTimer || stopped || typeof window === 'undefined') {
      return;
    }
    // 这个周期只把攒着的批次送走,不终止任何工作;页面隐藏/卸载另有监听抢先冲库。
    flushTimer = setInterval(() => {
      if (queue.length) {
        flush();
      }
    }, FLUSH_INTERVAL_MS);
  }

  async function flush() {
    if (!queue.length) {
      return;
    }
    const batch = queue.splice(0, queue.length);
    try {
      await transport(batch);
    } catch {
      // 传输失败只丢这批:埋点不许把交互或渲染拖下水,也不该弹错误提示。
    }
  }

  function track(kind, payload) {
    if (!EXPLICIT_KINDS.includes(kind)) {
      return false;
    }
    enqueue(`user.behavior.${kind}`, payload);
    return true;
  }

  // 隐性一:页面停留时长。hidden 与 pagehide 各结算一次并重置基点,stop()(视图
  // 卸载)结算剩余——SPA 路由切换不走 pagehide,只靠卸载这一路。
  function observeDwell() {
    if (typeof window === 'undefined') {
      return () => {};
    }
    let base = Date.now();
    const settle = () => {
      const ms = Date.now() - base;
      base = Date.now();
      if (ms > 0) {
        enqueue('user.behavior.dwell', { ms, path: currentPath() });
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        settle();
        // 隐藏即时送出:后台标签页的定时器会被浏览器降频,等 5s 周期可能等到
        // 用户再也不回来。
        flush();
      }
    };
    window.addEventListener('visibilitychange', onVisibility);
    const onPagehideSettle = () => {
      settle();
      flush();
    };
    window.addEventListener('pagehide', onPagehideSettle);
    const stopWatcher = () => {
      window.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPagehideSettle);
      settle();
    };
    teardowns.push(stopWatcher);
    return stopWatcher;
  }

  // 隐性二:滚动深度。rAF 节流 + 25% 档位:滚动是高频事件,每像素一条会把管道
  // 淹掉,而"用户看没看到底"只需要档位。el 缺省时看 document.scrollingElement。
  function observeScroll(el) {
    const target = el || (typeof document !== 'undefined' ? document.scrollingElement : null);
    if (!target || typeof target.addEventListener !== 'function') {
      return () => {};
    }
    let lastStep = 0;
    let rafId = 0;
    const measure = () => {
      rafId = 0;
      const scrollable = target.scrollHeight - target.clientHeight;
      const pct = scrollable <= 0 ? 100 : Math.round((target.scrollTop / scrollable) * 100);
      const step = Math.min(100, Math.floor(pct / SCROLL_STEP_PCT) * SCROLL_STEP_PCT);
      if (step > lastStep) {
        lastStep = step;
        enqueue('user.behavior.scroll', { depthPct: step, path: currentPath() });
      }
    };
    const onScroll = () => {
      if (rafId) {
        return;
      }
      rafId = requestAnimationFrame(measure);
    };
    target.addEventListener('scroll', onScroll, { passive: true });
    const stopWatcher = () => {
      target.removeEventListener('scroll', onScroll);
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };
    teardowns.push(stopWatcher);
    return stopWatcher;
  }

  // 隐性三:输入节奏。相邻击键间隔的中位数——快慢与停顿反映的是在"想"还是在
  // "抄"。每 INPUT_BATCH_KEYS 个键一条,不足一批的剩余在 stop() 时结算。
  function observeInput(el) {
    if (!el || typeof el.addEventListener !== 'function') {
      return () => {};
    }
    const gaps = [];
    let lastAt = 0;
    let since = 0;
    const emit = () => {
      if (!since) {
        return;
      }
      const sorted = gaps.slice().sort((a, b) => a - b);
      const medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
      enqueue('user.behavior.input', { keys: since, medianMs });
      gaps.length = 0;
      since = 0;
    };
    const onKeydown = () => {
      const now = Date.now();
      if (lastAt) {
        gaps.push(now - lastAt);
      }
      lastAt = now;
      since += 1;
      if (since >= INPUT_BATCH_KEYS) {
        emit();
      }
    };
    el.addEventListener('keydown', onKeydown);
    const stopWatcher = () => {
      el.removeEventListener('keydown', onKeydown);
      emit();
    };
    teardowns.push(stopWatcher);
    return stopWatcher;
  }

  // 页面隐藏/卸载抢先冲库:不等 5s 周期,也不等 stop()。
  const onPagehide = () => {
    flush();
  };
  const onHidden = () => {
    if (document.visibilityState === 'hidden') {
      flush();
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPagehide);
    window.addEventListener('visibilitychange', onHidden);
  }

  function stop() {
    // 先收 watcher(它们会结算最后的 dwell/input 样本),再关门、停表、冲库。
    for (const teardown of teardowns.splice(0)) {
      try {
        teardown();
      } catch {
        // 一个监听器拆不下来不能挡住其余,更不能抛给调用方。
      }
    }
    stopped = true;
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onPagehide);
      window.removeEventListener('visibilitychange', onHidden);
    }
    return flush();
  }

  return { track, observeDwell, observeScroll, observeInput, flush, stop };
}

async function httpTransport(batch) {
  // silent: true 是 request.js 错误拦截器唯一认的旗标(:168 `cfg.silent === true`
  // 才跳过 :171-173 的 notifyError)。接收端缺席时每个失败批次都是 4xx,不标
  // silent 会每 3s 去重窗口弹一条全局错误 toast——埋点失败是采集侧自己的事,
  // 与用户无关。(曾误写 __skipErrorNotify:全库无读取方,是死旗标。)
  await request.post(INGEST_PATH, { events: batch }, { timeout: TRANSPORT_TIMEOUT_MS, silent: true });
}
