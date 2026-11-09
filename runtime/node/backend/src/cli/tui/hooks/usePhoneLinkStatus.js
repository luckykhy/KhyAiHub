'use strict';

/**
 * usePhoneLinkStatus.js — 手机联动（桥 / 设备 / Amoo）状态的 TUI 轮询 Hook。
 *
 * 形状镜像 hooks/useMcpStatus.js（同为「外部子系统在线态」）：IO 只在 effect 里发起，
 * render 只消费 provider 的**同步**快照。差别有两条，都是真机实测逼出来的：
 *
 *   ① 不能直接 setState 进轮询函数。collectStatus 的无保护耗时区间约 3.1s ~ 28s
 *      （74% 是单条 uiautomator dump），单飞 / TTL / outer deadline / 序号判废四件套
 *      全在 provider（services/domain/network/amoo/amooStatusProvider.js）里。hook 若
 *      自己 await，就等于把并发控制搬进 React —— 面板关得比 adb 快时晚到的结果会写进
 *      已卸载组件的 state。所以 hook 只做「订阅 + 定点击发」，判废由 provider 负责。
 *   ② 必须订阅 onChange。轮询间隔 5s 而一次 collectStatus 可能 3s：没有订阅时，
 *      中间的 noteStep / notePoll（下发进度）与 setBusy 都不会反映到画面。
 *
 * 间隔唯一合法来源是 utils/ccTimers.js 的 TIMING（AGENTS.md §3.1）。复用 `mcp.interval`
 * （5000ms，「后台低优先级轮询」档）而不是新加一条 `phone` 字面量 —— 同一文件里出现
 * 第二个 5000 就是第二真源，而语义本来就对得上。
 *
 * enabled=false（面板没打开）时**不建定时器、不发第一次请求**：没打开过的面板不该
 * 已经有 adb 在跑。
 */

const React = require('react');
const { TIMING } = require('../utils/ccTimers');

// provider 缺失 / 不可用时的空快照。结构固定，渲染侧不必逐字段判空。
const EMPTY_SNAPSHOT = Object.freeze({
  state: 'idle',
  model: null,
  status: null,
  at: null,
  ageMs: null,
  stale: false,
  busy: false,
  degraded: false,
  lastError: null,
  stats: Object.freeze({
    fetches: 0,
    cacheHits: 0,
    timeouts: 0,
    tokenHeals: 0,
    lastMs: 0,
    lastAt: 0,
  }),
});

/**
 * 退订。失败不该阻断卸载，所以单独一个 helper（也让 effect 的清理函数只有一层）。
 * @param {Function|null} unsubscribe
 */
function _unsubscribe(unsubscribe) {
  if (typeof unsubscribe !== 'function') {
    return;
  }
  try {
    unsubscribe();
  } catch {
    /* ignore */
  }
}

/**
 * 订阅 provider 的变化。鸭子类型：没有 onChange（或它抛错）就返回 null，
 * 调用方退化成纯轮询。
 * @param {{onChange?:Function}|null} provider
 * @param {(snapshot:object)=>void} fn
 * @returns {Function|null} unsubscribe
 */
function _subscribe(provider, fn) {
  if (!provider || typeof provider.onChange !== 'function') {
    return null;
  }
  try {
    const off = provider.onChange(fn);
    return typeof off === 'function' ? off : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} [options]
 * @param {{getSnapshot:Function, refresh?:Function, onChange?:Function}|null} [options.provider]
 *        供数器；鸭子类型，缺 onChange 时退化成纯轮询
 * @param {boolean} [options.enabled] 是否启用轮询（面板打开才 true）
 * @param {number} [options.intervalMs] 轮询间隔；缺省 TIMING.mcp.interval
 * @returns {object} provider.getSnapshot() 的同形快照
 */
function usePhoneLinkStatus({ provider = null, enabled = true, intervalMs } = {}) {
  const canRead =
    !!provider && typeof provider.getSnapshot === 'function';
  const interval =
    Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0
      ? Math.floor(Number(intervalMs))
      : TIMING.mcp.interval;

  const [snapshot, setSnapshot] = React.useState(() =>
    canRead ? provider.getSnapshot() : EMPTY_SNAPSHOT
  );

  const refresh = React.useCallback(() => {
    if (!provider || typeof provider.refresh !== 'function') {
      return Promise.resolve(null);
    }
    try {
      // provider.refresh 自己绝不抛（失败保留旧快照）；这里的 try 只是防御
      // 一个不符合契约的注入对象把 effect 弄炸。
      return Promise.resolve(provider.refresh());
    } catch {
      return Promise.resolve(null);
    }
  }, [provider]);

  React.useEffect(() => {
    if (!enabled || !canRead) {
      return;
    }
    let alive = true;
    // 订阅失败 → 退化成纯轮询，面板仍能刷（绝不因为一个坏 provider 白屏）。
    const unsubscribe = _subscribe(provider, (next) => {
      if (alive && next) {
        setSnapshot(next);
      }
    });

    refresh();
    const timer = setInterval(refresh, interval);

    return () => {
      alive = false;
      clearInterval(timer);
      _unsubscribe(unsubscribe);
    };
  }, [enabled, canRead, provider, refresh, interval]);

  return canRead ? snapshot : EMPTY_SNAPSHOT;
}

module.exports = { usePhoneLinkStatus, EMPTY_SNAPSHOT };
