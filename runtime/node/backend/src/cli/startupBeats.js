'use strict';

/**
 * startupBeats — 启动板块的节拍契约（纯叶子）。
 *
 * 真源：[DESIGN-ARCH-115] TUI 启动板块设计 §4（节拍表与契约）、§6（失败态）。
 * 定位：启动板块的**单一状态真源**。TUI（BootScreen）、经典模式（startupHeader）、
 * pre-Ink 阶段行（bootPhaseLine）三个渲染器都消费这一份状态 —— 界面只是节拍表的投影，
 * 这是「一条路径胜过两条」（[DESIGN-ARCH-102] P8）在启动板块的落法。
 *
 * 三条硬规则（[DESIGN-ARCH-115] §4.2）：
 *   1. 每拍必须有真实工作负载 —— 禁止时长驱动的空壳拍；
 *   2. 完成信号必须是本拍自己的 resolve —— **禁止引用其它功能的副作用**。
 *      这条是为 D1 而写：历史实现把 banner 的 git 来源探测（`bannerUpdateLine`）
 *      当成「会话就绪」的信号，于是一个与启动无关的探测决定了启动时长。
 *   3. 就绪 = 最后一拍完成；**超时只用于降级并告知用户，绝不用来判定完成**。
 *      因此本模块不提供任何 `markDoneAfter(ms)` 之类的 API —— 想超时只能走 `fail()`，
 *      那会被记成降级并在界面上可见，而不是伪装成成功。
 *
 * 模块级单例：pre-mount 阶段（`replSession.js`）与 Ink 内（`App.js`）共享同一份进度，
 * 于是首帧即可呈现「预热起点」—— 在 Ink 挂载前就做完的拍直接显示 ✓，
 * 而不是让用户看着已完成的工作转圈。
 *
 * 纯叶子：零 IO、零 require、不读 process.env、不写 console。**never throws** ——
 * 未知 id / 重复上报一律静默忽略（fail-soft，对齐「自愈优先于报错」）。
 *
 * 另有一份**显示层**口径：`progress().percent` —— 以真实拍为硬锚、按真实流逝时间平滑
 * 推进的实时百分比（见下方 PERCENT_* 注释）。它只影响观感，不产生完成信号、不参与
 * isReady()，因此上面三条硬规则原样成立。
 */

const STATUS = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  DONE: 'done',
  FAILED: 'failed',
});

/**
 * 六拍。顺序即显示顺序，也是「真实工作」的顺序。
 * critical=true 的拍失败即阻断（[DESIGN-ARCH-115] §6）；非 critical 失败 = 降级继续。
 */
const BEATS = Object.freeze([
  { id: 'env', label: '环境与配置', critical: true },
  { id: 'auth', label: '认证', critical: true },
  { id: 'render', label: '渲染引擎', critical: true },
  { id: 'workspace', label: '工作区', critical: false },
  { id: 'gateway', label: '网关', critical: false },
  { id: 'session', label: '会话', critical: false },
]);

const TERMINAL = Object.freeze([STATUS.DONE, STATUS.FAILED]);

function isTerminal(status) {
  return TERMINAL.indexOf(status) !== -1;
}

// ── 实时百分比（**显示层口径**，与就绪判定完全无关）─────────────────────────
//
// 为什么需要它：`done/total` 的阶梯百分比对启动毫无意义 —— 六拍的耗时极不均衡。
// 实测（Windows，真实 PTY）：env/auth/workspace/session 四拍在 **0.4s** 内全部做完，
// 而 render（ink 渲染引擎装载 + App 首帧渲染）要 **20s+**。于是阶梯百分比的真实观感是
// 「一出场就是 4/6 = 67%，然后冻住」——这正是用户报的缺陷（实测首帧 67%，冻结 7.3s）。
//
// 做法：**以真实拍为硬锚**，在锚之间按真实流逝时间平滑推进。
//   · 永不虚报：某拍未推进时，显示值严格低于它的下界（护栏 PERCENT_GUARD）
//   · 单调：只随真实推进与时间流逝上升，绝不回退
//   · 恰达 100：全部拍推进完毕才 100 —— 否则「网关降级」时进度条永远停在 83%
//   · 起步斜坡：进程刚起时不从 0 瞬跳到「已完成拍的下界」，而是平滑爬上去
//
// 三条硬规则（§4.2）不受影响：本函数不产生完成信号、不参与 isReady()、不引入任何
// 定时完成语义 —— 它只是把**已经真实发生**的推进画成一条连续的曲线。
const PERCENT_RAMP_MS = 4000; // 起步斜坡时长：0 → 真实下界
const PERCENT_CREEP_MS = 12000; // 单拍内：向「下一拍的下界」缓慢逼近的时间常数
const PERCENT_GUARD = 0.4; // 与下一拍下界的护栏：未推进时绝不到达

/**
 * Create an independent beat tracker.
 *
 * @param {{beats?: Array, now?: () => number}} [options]
 *        `beats` 可覆盖默认六拍（测试用）；`now` 注入时钟（测试确定性）。
 * @returns {object} tracker
 */
function createBeatTracker(options) {
  const opts = options || {};
  const defs = Array.isArray(opts.beats) && opts.beats.length ? opts.beats : BEATS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  const order = defs.map((b) => b.id);
  const state = new Map();
  defs.forEach((b) => {
    state.set(b.id, {
      id: b.id,
      label: b.label,
      critical: b.critical === true,
      status: STATUS.PENDING,
      note: '',
      at: 0,
    });
  });

  const listeners = new Set();
  const startedAt = now();

  function notify() {
    listeners.forEach((fn) => {
      try {
        fn(tracker);
      } catch {
        /* 订阅者异常绝不能拖垮启动 */
      }
    });
  }

  /** 只允许 pending → active → (done|failed)，单调推进，不可回退（§4.2 规则 4）。 */
  function canTransition(from, to) {
    if (isTerminal(from)) return false;
    if (to === STATUS.ACTIVE) return from === STATUS.PENDING;
    if (to === STATUS.DONE || to === STATUS.FAILED) {
      return from === STATUS.PENDING || from === STATUS.ACTIVE;
    }
    return false;
  }

  function move(id, to, note) {
    const b = state.get(id);
    if (!b || !canTransition(b.status, to)) return false;
    b.status = to;
    b.note = typeof note === 'string' ? note : '';
    b.at = now();
    notify();
    return true;
  }

  /**
   * 「已推进」的拍数。done 与 **非 critical 的 failed**（降级）都算 —— 降级同样意味着
   * 「这一拍不再等了」，若不计入，网关降级时进度条会永远停在 5/6。
   * critical 的 failed 不算：那是**阻断**，启动并没有往前走（此时 isReady() 恒 false，
   * 界面显示红色的阻断行，进度条绝不能谎报接近完成）。
   */
  function progressedCount() {
    let n = 0;
    order.forEach((id) => {
      const b = state.get(id);
      if (b.status === STATUS.DONE || (b.status === STATUS.FAILED && !b.critical)) n += 1;
    });
    return n;
  }

  /** 最近一次「推进」发生的真实时刻；还没有任何推进 → startedAt。 */
  function lastProgressedAt() {
    let at = 0;
    order.forEach((id) => {
      const b = state.get(id);
      if ((b.status === STATUS.DONE || b.status === STATUS.FAILED) && b.at > at) at = b.at;
    });
    return at || startedAt;
  }

  /**
   * 实时百分比（0..100，可带小数）。纯函数：只读状态 + 注入时钟，无副作用。
   * @param {number} t 当前时刻（毫秒）
   */
  function percentAt(t) {
    const total = order.length;
    if (!total) return 100;
    const progressed = progressedCount();
    if (progressed >= total) return 100;
    const floor = (progressed / total) * 100;
    const ceiling = ((progressed + 1) / total) * 100;
    // 起步斜坡：进程刚起时不让显示值瞬跳到真实下界（否则「一出场就是 67%」）。
    const ramp = Math.min(100, (Math.max(0, t - startedAt) / PERCENT_RAMP_MS) * 100);
    const base = Math.max(0, Math.min(floor, ramp));
    // 单拍内缓慢爬升：向下一拍的下界逼近，但被护栏挡住 —— 永不虚报那一拍已完成。
    const sinceProgress = Math.max(0, t - lastProgressedAt());
    const creep = base + (ceiling - base) * (1 - Math.exp(-sinceProgress / PERCENT_CREEP_MS));
    return Math.max(0, Math.min(creep, ceiling - PERCENT_GUARD));
  }

  const tracker = {
    /** 全部拍的快照（新数组，调用方可自由持有）。 */
    get beats() {
      return order.map((id) => Object.assign({}, state.get(id)));
    },
    /** 单拍快照；未知 id → null。 */
    get(id) {
      const b = state.get(id);
      return b ? Object.assign({}, b) : null;
    },
    /** pending → active。已在推进/已终态 → 静默忽略。 */
    start(id) {
      return move(id, STATUS.ACTIVE);
    },
    /** active|pending → done。这是**唯一**的完成入口，没有定时版本。 */
    done(id) {
      return move(id, STATUS.DONE);
    },
    /**
     * → failed。critical 拍的失败会阻断（见 blockingFailure）；
     * 非 critical 拍的失败是降级，启动继续（[DESIGN-ARCH-115] §6）。
     */
    fail(id, note) {
      return move(id, STATUS.FAILED, note);
    },
    /**
     * 预热起点：把 Ink 挂载**之前**就已完成的一批拍标记为 done。
     * 用于让首帧直接显示 ✓，而不是让用户看着已完成的工作转圈。
     */
    preload(ids) {
      if (!Array.isArray(ids)) return 0;
      let n = 0;
      ids.forEach((id) => {
        const b = state.get(id);
        if (b && !isTerminal(b.status)) {
          b.status = STATUS.DONE;
          b.note = '';
          b.at = now();
          n += 1;
        }
      });
      if (n > 0) notify();
      return n;
    },
    /** 订阅变更；返回退订函数。 */
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /**
     * 就绪判据：每一拍都进入终态（done 或 failed）**且**没有 critical 拍失败。
     * 注意「failed 也算终态」—— 非 critical 的失败是降级就绪，不是卡住。
     */
    isReady() {
      for (const id of order) {
        const b = state.get(id);
        if (!isTerminal(b.status)) return false;
        if (b.status === STATUS.FAILED && b.critical) return false;
      }
      return true;
    },
    /** 第一个阻断性失败（critical 且 failed）；无 → null。 */
    blockingFailure() {
      for (const id of order) {
        const b = state.get(id);
        if (b.critical && b.status === STATUS.FAILED) return Object.assign({}, b);
      }
      return null;
    },
    /** 降级项（非 critical 且 failed）。界面据此显示「! N 项降级」。 */
    degraded() {
      return order
        .map((id) => state.get(id))
        .filter((b) => b.status === STATUS.FAILED && !b.critical)
        .map((b) => Object.assign({}, b));
    },
    /**
     * 进度概览。
     *   done/total  真实拍账本（只数 DONE）—— 清单行的 ✓ 由此而来
     *   percent     实时百分比（见 percentAt 上方注释）—— 进度条 / 引导行由此而来
     *   elapsedMs   自本 tracker 起算的真实耗时
     */
    progress() {
      const total = order.length;
      let done = 0;
      order.forEach((id) => {
        if (state.get(id).status === STATUS.DONE) done += 1;
      });
      return {
        done,
        total,
        percent: percentAt(now()),
        ready: tracker.isReady(),
        elapsedMs: Math.max(0, now() - startedAt),
      };
    },
    /** 复位到初始态（测试用；生产路径不应调用）。 */
    reset() {
      order.forEach((id) => {
        const b = state.get(id);
        b.status = STATUS.PENDING;
        b.note = '';
        b.at = 0;
      });
      notify();
    },
  };

  return tracker;
}

/**
 * 模块级单例 —— pre-mount（`replSession.js`）与 Ink（`App.js`）共享。
 * 测试请用 `createBeatTracker()` 构造独立实例，不要动这个单例。
 */
const beats = createBeatTracker();

module.exports = { BEATS, STATUS, createBeatTracker, beats, isTerminal };
