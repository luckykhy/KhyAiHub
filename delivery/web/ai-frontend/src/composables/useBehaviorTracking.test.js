import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useBehaviorTracking } from './useBehaviorTracking.js';

/**
 * useBehaviorTracking 契约测试。
 *
 * 钉住三条不变式:① 事件归一成 {ts,seq,type,source,traceId,payload} 且 type 落在
 * user.behavior.* 词表内;② 传输失败只丢批次,绝不向调用方抛;③ 隐性采集
 * (停留/滚动/输入)按档位与批大小节流,不做每像素/每击键一条的事件洪泛。
 *
 * 环境说明:vitest 默认 environment:'node',无 window/document/rAF,全部用
 * 最小桩替代(同 useModalFocus.test.js 的手法);request 用 vi.mock 打桩,
 * 不发真实请求。传输用注入的假 transport:它被调用时同步入账,所以多数断言
 * 在 flush() 之后即可成立。
 */

const post = vi.fn();

vi.mock('@/api/request', () => ({
  default: {
    post: (...a) => post(...a),
  },
}));

// ── 最小浏览器桩 ────────────────────────────────────────────────────────────

function stubWindow() {
  const listeners = new Map();
  const win = {
    location: { pathname: '/ai-chat' },
    addEventListener: (type, fn) => {
      const arr = listeners.get(type) || [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    removeEventListener: (type, fn) => {
      listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn));
    },
  };
  win.emit = (type) => {
    for (const fn of listeners.get(type) || []) fn();
  };
  win.listenerCount = (type) => (listeners.get(type) || []).length;
  vi.stubGlobal('window', win);
  return win;
}

function stubDocument(visibility = 'visible') {
  const doc = { visibilityState: visibility, scrollingElement: null };
  vi.stubGlobal('document', doc);
  doc.hide = () => {
    doc.visibilityState = 'hidden';
  };
  return doc;
}

function stubRaf() {
  const queue = [];
  vi.stubGlobal('requestAnimationFrame', (fn) => {
    queue.push(fn);
    return queue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return {
    flush() {
      const pending = queue.splice(0, queue.length);
      pending.forEach((fn) => fn());
    },
    get pending() {
      return queue.length;
    },
  };
}

function fakeScrollTarget({ scrollHeight, clientHeight, scrollTop = 0 }) {
  const listeners = {};
  return {
    scrollHeight,
    clientHeight,
    scrollTop,
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    removeEventListener: (type) => {
      delete listeners[type];
    },
    emitScroll() {
      listeners.scroll && listeners.scroll();
    },
    get attached() {
      return Boolean(listeners.scroll);
    },
  };
}

function fakeInputTarget() {
  const listeners = {};
  return {
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    removeEventListener: (type) => {
      delete listeners[type];
    },
    press() {
      listeners.keydown && listeners.keydown();
    },
    get attached() {
      return Boolean(listeners.keydown);
    },
  };
}

function recordingTransport(sink) {
  return async (batch) => {
    sink.push(...batch);
  };
}

beforeEach(() => {
  post.mockReset();
  stubWindow();
  stubDocument('visible');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('显性事件归一', () => {
  it('track() 产出六字段形状,type 落在 user.behavior.<kind>', async () => {
    const sent = [];
    const b = useBehaviorTracking({
      source: 'web:ai-chat',
      traceId: () => 'conv-42',
      transport: recordingTransport(sent),
    });
    expect(b.track('reject', { messageId: 'm1' })).toBe(true);
    await b.flush();

    expect(sent).toHaveLength(1);
    const [event] = sent;
    expect(Object.keys(event).sort()).toEqual([
      'payload',
      'seq',
      'source',
      'traceId',
      'ts',
      'type',
    ]);
    expect(event.type).toBe('user.behavior.reject');
    expect(event.source).toBe('web:ai-chat');
    expect(event.traceId).toBe('conv-42');
    expect(event.payload).toEqual({ messageId: 'm1' });
    expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
  });

  it('词表外 kind 被忽略,不进批次', async () => {
    const sent = [];
    const b = useBehaviorTracking({ transport: recordingTransport(sent) });
    expect(b.track('thumb-up', {})).toBe(false);
    expect(b.track(undefined)).toBe(false);
    await b.flush();
    expect(sent).toEqual([]);
  });

  it('五个显性 kind 全部映射到 user.behavior.*', async () => {
    const sent = [];
    const b = useBehaviorTracking({ transport: recordingTransport(sent) });
    for (const kind of ['click', 'like', 'dislike', 'correct', 'reject']) {
      b.track(kind, { kind });
    }
    await b.flush();
    expect(sent.map((e) => e.type)).toEqual([
      'user.behavior.click',
      'user.behavior.like',
      'user.behavior.dislike',
      'user.behavior.correct',
      'user.behavior.reject',
    ]);
  });
});

describe('批次与 fail-soft', () => {
  it('flush() 整批送出并清空队列,二次 flush 不再调用传输', async () => {
    const calls = [];
    const b = useBehaviorTracking({ transport: async (batch) => calls.push(batch) });
    b.track('click', { a: 1 });
    b.track('like', { a: 2 });
    await b.flush();
    await b.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
  });

  it('传输抛异常只丢该批:不向调用方抛,后续采集照常', async () => {
    let failNext = true;
    const seen = [];
    const b = useBehaviorTracking({
      transport: async (batch) => {
        if (failNext) {
          failNext = false;
          throw new Error('network down');
        }
        seen.push(batch);
      },
    });
    b.track('click', { a: 1 });
    await expect(b.flush()).resolves.toBeUndefined();
    b.track('like', { a: 2 });
    await b.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0][0].type).toBe('user.behavior.like');
  });

  it('攒够 FLUSH_BATCH(20)条自动冲库,不等周期', async () => {
    const calls = [];
    const b = useBehaviorTracking({ transport: async (batch) => calls.push(batch) });
    for (let i = 0; i < 19; i += 1) b.track('click', { i });
    expect(calls).toHaveLength(0);
    b.track('click', { i: 19 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(20);
  });

  it('默认传输打到 /api/behavior-events,并标 silent:失败批次不弹全局错误条', async () => {
    post.mockResolvedValueOnce({ data: { success: true } });
    const b = useBehaviorTracking({ source: 'web:marketplace' });
    b.track('click', { action: 'install' });
    await b.flush();
    const [path, body, config] = post.mock.calls[0];
    expect(path).toBe('/api/behavior-events');
    expect(body.events).toEqual([
      expect.objectContaining({ type: 'user.behavior.click', source: 'web:marketplace' }),
    ]);
    // silent 是 request.js:168 唯一认的旗标(:168 `cfg.silent === true` 才跳过
    // :171-173 的 notifyError)。不标它,接收端缺席时每个失败批次都会每 3s 去重
    // 窗口弹一条全局错误 toast。这里钉的是「传输失败不产生用户可见错误」这条
    // 契约,不是某个字段名。
    expect(config).toEqual(expect.objectContaining({ timeout: 5000, silent: true }));
  });

  it('stop() 之后 track() 被丢弃(视图已卸载)', async () => {
    const calls = [];
    const b = useBehaviorTracking({ transport: async (batch) => calls.push(batch) });
    await b.stop();
    b.track('click', {});
    await b.flush();
    expect(calls).toEqual([]);
  });
});

describe('隐性一:页面停留时长', () => {
  it('visibilitychange→hidden 结算并即时送出一段停留;stop() 结算剩余并摘监听', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T00:00:00Z'));
    const win = stubWindow();
    const doc = stubDocument('visible');
    const sent = [];
    const b = useBehaviorTracking({ transport: recordingTransport(sent) });
    b.observeDwell();

    vi.setSystemTime(new Date('2026-11-05T00:00:05Z'));
    win.emit('visibilitychange'); // 仍可见:不结算
    expect(sent).toHaveLength(0);

    doc.hide();
    win.emit('visibilitychange');
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('user.behavior.dwell');
    expect(sent[0].payload).toEqual({ ms: 5000, path: '/ai-chat' });

    vi.setSystemTime(new Date('2026-11-05T00:00:08Z'));
    await b.stop(); // 剩余 3s 一并结算
    expect(sent).toHaveLength(2);
    expect(sent[1].payload.ms).toBe(3000);
    expect(win.listenerCount('visibilitychange')).toBe(0);
    expect(win.listenerCount('pagehide')).toBe(0);
  });

  it('stop() 时 dwell 为 0 不产生事件', async () => {
    const sent = [];
    const b = useBehaviorTracking({ transport: recordingTransport(sent) });
    b.observeDwell();
    await b.stop();
    expect(sent).toEqual([]);
  });
});

describe('隐性二:滚动深度', () => {
  it('按 25% 档位上报,档内滚动不重复上报;rAF 未冲刷不上报', async () => {
    const raf = stubRaf();
    const sent = [];
    const b = useBehaviorTracking({ transport: recordingTransport(sent) });
    const target = fakeScrollTarget({ scrollHeight: 1000, clientHeight: 400 });
    b.observeScroll(target);

    target.scrollTop = 150; // 150/600 = 25%
    target.emitScroll();
    target.emitScroll(); // 一帧内重复触发被节流
    expect(raf.pending).toBe(1);
    expect(sent).toHaveLength(0); // 等 rAF 冲刷
    raf.flush();
    await b.flush();
    expect(sent.map((e) => e.payload.depthPct)).toEqual([25]);

    target.scrollTop = 200; // 33% 仍属 25 档
    target.emitScroll();
    raf.flush();
    await b.flush();
    expect(sent).toHaveLength(1);

    target.scrollTop = 300; // 50%
    target.emitScroll();
    raf.flush();
    await b.flush();
    target.scrollTop = 600; // 100%
    target.emitScroll();
    raf.flush();
    await b.flush();
    expect(sent.map((e) => e.payload.depthPct)).toEqual([25, 50, 100]);

    await b.stop();
    expect(target.attached).toBe(false);
  });

  it('observeScroll() 缺省看 document.scrollingElement', async () => {
    const raf = stubRaf();
    const doc = stubDocument('visible');
    doc.scrollingElement = fakeScrollTarget({ scrollHeight: 800, clientHeight: 400 });
    const sent = [];
    const b = useBehaviorTracking({ transport: recordingTransport(sent) });
    b.observeScroll();
    doc.scrollingElement.scrollTop = 200; // 200/400 = 50%
    doc.scrollingElement.emitScroll();
    raf.flush();
    await b.flush();
    expect(sent.map((e) => e.payload.depthPct)).toEqual([50]);
  });

  it('目标不可监听时静默降级,不抛', async () => {
    const b = useBehaviorTracking({ transport: async () => {} });
    expect(() => b.observeScroll(null)).not.toThrow();
    await expect(b.stop()).resolves.toBeUndefined();
  });
});

describe('隐性三:输入节奏', () => {
  it('每 20 键一条,payload 带键数与间隔中位数;stop() 结算剩余', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T00:00:00Z'));
    const sent = [];
    const b = useBehaviorTracking({ transport: recordingTransport(sent) });
    const el = fakeInputTarget();
    b.observeInput(el);

    for (let i = 0; i < 20; i += 1) {
      vi.setSystemTime(new Date(Date.now() + 120));
      el.press();
    }
    await b.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('user.behavior.input');
    expect(sent[0].payload).toEqual({ keys: 20, medianMs: 120 });

    for (let i = 0; i < 3; i += 1) {
      vi.setSystemTime(new Date(Date.now() + 300));
      el.press();
    }
    await b.stop(); // 不足一批的剩余在 stop() 结算并送出
    expect(sent).toHaveLength(2);
    expect(sent[1].payload).toEqual({ keys: 3, medianMs: 300 });
    expect(el.attached).toBe(false);
  });

  it('目标缺失时静默降级,不抛', async () => {
    const b = useBehaviorTracking({ transport: async () => {} });
    expect(() => b.observeInput(null)).not.toThrow();
    await expect(b.stop()).resolves.toBeUndefined();
  });
});
