'use strict';

/**
 * dragAutoScrollTimer —— 拖选时「指针停在视口边缘」的**持续**滚动(hold-to-scroll)。
 *
 * 为什么必须有这个定时器(2026-09-24 用户主诉「我需要流畅的[单]选滚动页面复制」):
 *   1002(button-event)只在**指针位置发生变化**时上报位移。指针一旦停在窗口下沿
 *   (或拖出窗口),终端就再也不发事件 —— 于是「每个位移事件滚一格」这条实现
 *   (App.js 的 `vp.dragAutoScroll`)在物理上只能滚**最后那一次移动**对应的一格,
 *   之后彻底停住。用户看到的是:选区卡在一屏之内、跨页内容选不到;想继续就得
 *   不停抖动鼠标,而这显然不是「流畅」。
 *   真正的 auto-scroll 必须由**定时器**驱动:指针**停在**边缘区这件事本身,
 *   就足以让视口持续滚动,直到松手或指针离开边缘。
 *
 * 为什么做成独立模块而不是塞进 App.js 的 useEffect:
 *   本仓的 TUI 缺陷绝大多数是「判据/默认值」问题,而不是「链路没写」。判据要能被
 *   无头探针直接驱动(见 `.khyos/diag/tui-select-singleclick-probe.js` 的 C4),
 *   才谈得上「修复前后同一份代码跑出两种结果」。藏在 React 生命周期里的定时器
 *   只能靠挂真 App 才能观测,而那正是历史上一堆假绿/假红的来源。
 *
 * 契约(极薄运行时,与 `mouseButtons.createMouseDispatcher` 同范式):
 *   - **不持有业务状态**:它不知道行号、偏移、选区,只负责「该不该继续 tick」。
 *   - **不判边缘**:边缘判据的唯一真源仍是 `Viewport.dragAutoScroll`。调用方每次
 *     tick 重新算一次,算出来是 0 就 `note(0)`,本模块据此自行停表。
 *   - 绝不抛:`onRepeat` 抛异常 → 停表(宁可少滚,不可让定时器把 UI 拖死)。
 *   - 时间源/定时器可注入,便于确定性单测(不 sleep 真实时间)。
 *
 * ⚠ 节拍为什么留在这里、不进 `perfTunables`(该叶子是本仓计时节奏的 SSOT):
 *   ① `check-tui-gates` 的 `KHY_*` token 预算**正好顶格**(227/227),给新参数加一个
 *      env override 会直接顶破上限;② `perfTunables` 的定位是「LOW_POWER 可放宽的
 *      渲染/动画节奏」,而 hold-to-scroll 是**响应性**参数 —— 指针停在边缘却滚得更慢
 *      不是省电,是坏掉。真要收口到 SSOT 时,调用方传 `intervalMs` 即可(一行改动)。
 *
 * @param {{onRepeat?: (dir: -1|1) => void, intervalMs?: number,
 *          setTimer?: Function, clearTimer?: Function}} [opts]
 * @returns {{note: (delta:number) => boolean, stop: () => void,
 *            active: () => boolean, dir: () => -1|0|1}}
 */

/** 每格之间的毫秒数。60ms ≈ 16 行/秒 —— 高于 ink 的 34ms 节流,不会把帧挤爆。 */
const DEFAULT_INTERVAL_MS = 60;

/**
 * 失控保护:连续 tick 的上限(默认 900 ≈ 54s @60ms)。
 *
 * 为什么需要:正常情况下「滚到底」会自然终止(边缘判据返回 0 → `note(0)` 停表),
 * 但有一类**丢事件**场景会绕过它 —— 用户把指针拖到窗口下沿后松手点落在窗口**外**
 * (或拖到一半 alt-tab 走了),`up` 永远不到,而转录还在**流式增长**(内容不断追加,
 * 于是永远滚不到底)。没有上限的话视口会一直自己滚下去。
 * 取 54s:远大于任何真实拖选(400 行 ≈ 25s),只在「事件真的丢了」时才触发。
 */
const DEFAULT_MAX_TICKS = 900;

function createHoldScroller(opts = {}) {
  const rawInterval = Number(opts && opts.intervalMs);
  const intervalMs = Number.isFinite(rawInterval) && rawInterval > 0
    ? Math.floor(rawInterval)
    : DEFAULT_INTERVAL_MS;
  const rawMaxTicks = Number(opts && opts.maxTicks);
  const maxTicks = Number.isFinite(rawMaxTicks) && rawMaxTicks > 0
    ? Math.floor(rawMaxTicks)
    : DEFAULT_MAX_TICKS;
  const onRepeat = opts && typeof opts.onRepeat === 'function' ? opts.onRepeat : null;
  const setTimer = opts && typeof opts.setTimer === 'function' ? opts.setTimer : setInterval;
  const clearTimer = opts && typeof opts.clearTimer === 'function' ? opts.clearTimer : clearTimeout;

  let handle = null;
  let dir = 0;
  let ticks = 0;

  function stop() {
    if (handle !== null) {
      try {
        clearTimer(handle);
      } catch {
        /* fail-soft —— 清理失败也绝不能抛(可能在 unload 之后) */
      }
      handle = null;
    }
    dir = 0;
    ticks = 0;
  }

  /**
   * 上报一次**真实**位移事件算出来的边缘判定。
   *   delta === 0 → 指针不在边缘(或已滚到底) ⇒ 停表。
   *   delta === ±1 → 在边缘 ⇒ 起表;方向没变则不重启(避免每次位移都把节拍归零,
   *                 否则「连续位移 + 定时器」会互相打断,反而更不流畅)。
   * @param {number} delta
   * @returns {boolean} 表是否在走
   */
  function note(delta) {
    const n = Number(delta);
    const d = Number.isFinite(n) && n > 0 ? 1 : Number.isFinite(n) && n < 0 ? -1 : 0;
    if (d === 0) {
      stop();
      return false;
    }
    if (handle !== null && d === dir) {
      return true;
    }
    stop();
    dir = d;
    handle = setTimer(() => {
      if (!onRepeat) {
        stop();
        return;
      }
      if (ticks >= maxTicks) {
        // 丢事件兜底:见 DEFAULT_MAX_TICKS 的注释。宁可少滚,不可无限滚。
        stop();
        return;
      }
      ticks++;
      try {
        onRepeat(dir);
      } catch {
        stop();
      }
    }, intervalMs);
    return true;
  }

  return {
    note,
    stop,
    active: () => handle !== null,
    dir: () => dir,
    ticks: () => ticks,
  };
}

module.exports = { DEFAULT_INTERVAL_MS, DEFAULT_MAX_TICKS, createHoldScroller };
