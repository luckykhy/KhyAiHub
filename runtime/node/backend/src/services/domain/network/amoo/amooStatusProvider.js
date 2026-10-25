'use strict';

/**
 * amooStatusProvider.js — 薄 IO 外壳：Amoo 协作链状态的 TTL 缓存供数器。
 *
 * 面板（以及任何未来的只读消费者）不直接调 collectStatus()，而是经这一个 provider。
 * 理由是真机实测出来的三条：collectStatus 的无保护耗时区间约 **3.1s ~ 28s**
 * （74% 是单条 uiautomator dump，设备断线时 ensureDevice 最坏 45s 级），所以
 *   ① 必须单飞——并发轮询会叠成真实 adb.exe 子进程堆积，同时拖慢 PC 和手机 adbd；
 *   ② TTL 必须从**完成时刻**起算——12s/28s 的坏样本会让「发起时刻起算」永久排队；
 *   ③ 必须带 outer deadline——但 deadline 只能放弃等待，杀不掉已经 spawn 的 adb，
 *      所以晚到的结果用**序号判废**，不许覆盖更新的快照。
 *
 * 失败语义：一次 collectStatus 失败**不抛、不清空**，返回上一份好快照并打陈旧标记
 * ——断网时「上次 3 秒前还在线」比空白有用。首次就失败才给 state='error'。
 *
 * 忙位互斥：dispatch 进行期间（setBusy(true)）不跑 collectStatus。uiautomator dump
 * 是设备级争用资源，面板的 dump 和 dispatch 自己的 dump 同时跑，会把一次成功的下发
 * 伪造成 screen_unreadable 停止原因。此时只跑 liveness.probe()（读 status.json 心跳，
 * 实测 176-207ms / 1 条 adb），合成一份标记 partial 的心跳快照——没测过的字段一律
 * 留空，由视图模型渲染成 '—'，绝不猜。
 *
 * 令牌自愈：桥重装后 token.txt 变了，旧令牌让所有 HTTP 调用 401，而 client 的令牌缓存
 * 是 6 小时——不处理的话面板会连续数小时显示「桥不在线」。见到 http_401 就
 * invalidateToken()，下一次 refresh 会重新从设备读。
 *
 * 本文件模块装载期零副作用：只 require 纯叶子视图模型，runner / liveness 全部经构造子
 * 注入（鸭子类型，不 import 任何兄弟 shell）。
 *
 * @module services/domain/network/amoo/amooStatusProvider
 */

const { buildAmooPanelModel } = require('./amooPanelViewModel');

// 默认值与 TUI 的关系：AGENTS.md（src/cli/tui）§3.1 规定间隔唯一合法来源是
// utils/ccTimers.js 的 TIMING，所以 TUI 的 hook 必须显式传 ttlMs（语义对口的是
// TIMING.mcp.interval = 5000ms，「后台低优先级轮询」档）。这里的 5000 只是不传参时的
// 兜底，不是第二真源。
const DEFAULT_TTL_MS = 5000;
// 大于实测最坏 collectStatus（约 28s）中的合理值：25s dump 超时 + 余量。再大就失去
// 「面板不能整轮无响应」的意义。
const DEFAULT_DEADLINE_MS = 12000;
// 实时进度只留最近这么多步；一次 dispatch 的记录步上限是 11，留一倍余量。
const MAX_PROGRESS_STEPS = 24;

function _isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function _str(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function _num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function _oneLine(text) {
  return _str(text).replace(/\s+/g, ' ').trim();
}

/**
 * 给一个 promise 加 outer deadline。**杀不掉已经跑起来的 IO**：放弃的 collectStatus
 * 仍在后台 spawn adb，它的晚到结果由调用方的序号判废丢弃，不会覆盖新快照。
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @returns {Promise<unknown>} 原值；超时时 `{__deadline:true}`；拒绝时 `{__error:Error}`
 */
function withDeadline(promise, ms) {
  const limit = _num(ms);
  const timeoutMs = limit !== null && limit > 0 ? limit : DEFAULT_DEADLINE_MS;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ __deadline: true });
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ __error: error });
      }
    );
  });
}

class AmooStatusProvider {
  /**
   * @param {object} [opts]
   * @param {{collectStatus:Function, client?:object, config?:object}} [opts.runner]
   *        AmooDispatchRunner（或任何有 collectStatus 的鸭子类型）
   * @param {{probe:Function}} [opts.liveness] phone facade 的 client，忙位期间的心跳源
   * @param {number} [opts.ttlMs] 缓存寿命，从完成时刻起算
   * @param {number} [opts.deadlineMs] 单次 refresh 的 outer deadline
   * @param {Function} [opts.now] 时钟注入（测试用）
   * @param {number} [opts.maxValueChars] 行值字符上限，透传给视图模型
   */
  constructor(opts = {}) {
    const options = _isPlainObject(opts) ? opts : {};
    this._runner = options.runner || null;
    this._liveness = options.liveness || null;
    const ttl = _num(options.ttlMs);
    this._ttlMs = ttl !== null && ttl > 0 ? ttl : DEFAULT_TTL_MS;
    const deadline = _num(options.deadlineMs);
    this._deadlineMs = deadline !== null && deadline > 0 ? deadline : DEFAULT_DEADLINE_MS;
    this._maxValueChars = _num(options.maxValueChars);
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();

    this._snapshot = null;
    this._model = null;
    this._modelStale = false;
    this._inflight = null;
    this._seq = 0;
    this._ttlBypass = false;
    this._busy = false;
    this._listeners = new Set();
    this._progress = null;
    this._lastDispatch = null;
    this._stats = { fetches: 0, cacheHits: 0, timeouts: 0, tokenHeals: 0, lastMs: 0, lastAt: 0 };
    this._touch();
  }

  // ── 读 ───────────────────────────────────────────────────────────────────

  /**
   * 同步快照。render 路径只准调这一个方法（纯读，零 IO，不新建行对象）。
   * @returns {{state:'idle'|'loading'|'ready'|'error', model:object,
   *            status:object|null, at:number|null, ageMs:number|null,
   *            stale:boolean, busy:boolean, degraded:boolean,
   *            lastError:string|null, stats:object}}
   */
  getSnapshot() {
    const snapshot = this._snapshot;
    const now = this._now();
    const ageMs = snapshot ? Math.max(0, now - snapshot.at) : null;
    const stale = snapshot ? ageMs > this._ttlMs : false;
    if (snapshot && stale !== this._modelStale) {
      // 徽章要跟「现在」走。这里刻意不通知订阅者——getter 里 emit 会重入；
      // 下一次 refresh 落定（或 note*）会带着通知一起补上。
      this._modelStale = stale;
      this._model = this._buildModel(snapshot);
    }
    const state = snapshot ? snapshot.state : this._inflight ? 'loading' : 'idle';
    return {
      state,
      model: this._model,
      status: snapshot ? snapshot.status : null,
      at: snapshot ? snapshot.at : null,
      ageMs,
      stale,
      busy: this._busy,
      degraded: snapshot ? snapshot.degraded === true : false,
      lastError: snapshot ? snapshot.lastError : null,
      stats: this.stats(),
    };
  }

  stats() {
    return {
      fetches: this._stats.fetches,
      cacheHits: this._stats.cacheHits,
      timeouts: this._stats.timeouts,
      tokenHeals: this._stats.tokenHeals,
      lastMs: this._stats.lastMs,
      lastAt: this._stats.lastAt,
    };
  }

  // ── 写（IO 只在这里发生） ────────────────────────────────────────────────

  /**
   * 取一份新快照。TTL 内且非 force 直接回缓存；已在飞的这个 promise 被复用（单飞）。
   * @param {{force?:boolean}} [opts]
   * @returns {Promise<object|null>} 落定后的内部快照（可能是旧的，失败时）
   */
  async refresh(opts = {}) {
    const force = opts && opts.force === true;
    if (this._inflight) {
      this._stats.cacheHits += 1;
      return this._inflight;
    }
    const now = this._now();
    if (!force && !this._ttlBypass && this._snapshot && now - this._snapshot.at < this._ttlMs) {
      this._stats.cacheHits += 1;
      return this._snapshot;
    }
    const seq = ++this._seq;
    this._ttlBypass = false;
    const promise = this._fetch(seq);
    this._inflight = promise;
    try {
      return await promise;
    } finally {
      if (this._inflight === promise) {
        this._inflight = null;
      }
    }
  }

  /** 手动刷新键：让下一次 refresh 无视 TTL。 */
  invalidate() {
    this._ttlBypass = true;
  }

  /**
   * 忙位。true = 有 dispatch 在跑，此后 refresh 只读心跳不读屏；false = 下发结束，
   * 同时作废 TTL，让下一次 refresh 立刻补一份全量快照。
   * @param {boolean} busy
   */
  setBusy(busy) {
    const next = busy === true;
    if (next === this._busy) {
      return this._busy;
    }
    this._busy = next;
    if (!next) {
      this._ttlBypass = true;
    }
    this._touch();
    this._emit();
    return this._busy;
  }

  /**
   * 记一步下发进度（dispatchTask 的 onStep 喂进来）。零 IO，只入队 + 重画。
   * @param {{id:string, ok:boolean, detail:string}} step
   */
  noteStep(step) {
    if (!_isPlainObject(step)) {
      return;
    }
    if (!this._progress) {
      this._progress = { steps: [], poll: null, startedAt: this._now() };
    }
    this._progress.steps.push({
      id: _str(step.id),
      ok: step.ok === true,
      detail: _oneLine(step.detail) || null,
    });
    if (this._progress.steps.length > MAX_PROGRESS_STEPS) {
      this._progress.steps.shift();
    }
    this._touch();
    this._emit();
  }

  /**
   * 记一轮轮询进度（dispatchTask 的 onPoll 喂进来）。
   * @param {{round:number, maxRounds:number, waitedMs:number, chatChars:number}} poll
   */
  notePoll(poll) {
    if (!_isPlainObject(poll)) {
      return;
    }
    if (!this._progress) {
      this._progress = { steps: [], poll: null, startedAt: this._now() };
    }
    this._progress.poll = {
      round: _num(poll.round),
      maxRounds: _num(poll.maxRounds),
      waitedMs: _num(poll.waitedMs),
      chatChars: _num(poll.chatChars),
    };
    this._touch();
    this._emit();
  }

  /**
   * 记一次 dispatch 的最终结果。实时进度到此清空（结果优先）。
   * @param {object} result dispatchTask 的返回值
   */
  noteDispatchResult(result) {
    this._progress = null;
    this._lastDispatch = _isPlainObject(result) ? result : null;
    this._touch();
    this._emit();
  }

  /**
   * 订阅快照变化。hook 在这里 setState；渲染路径不准调 refresh。
   * @param {(snapshot:object)=>void} fn
   * @returns {()=>void} unsubscribe
   */
  onChange(fn) {
    if (typeof fn !== 'function') {
      return () => {};
    }
    this._listeners.add(fn);
    let closed = false;
    return () => {
      if (closed) {
        return;
      }
      closed = true;
      this._listeners.delete(fn);
    };
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  async _fetch(seq) {
    const canProbe = !!(this._liveness && typeof this._liveness.probe === 'function');
    if (this._busy && !canProbe) {
      // 忙位且没有心跳源：什么都不测。一次多余的 dump 会和 dispatch 自己的 dump
      // 争用设备，把成功的下发伪造成 screen_unreadable——宁可显示旧数据。
      this._stats.cacheHits += 1;
      return this._snapshot;
    }

    const startedAt = this._now();
    this._stats.fetches += 1;
    let status = null;
    let degraded = false;
    let lastError = null;
    try {
      if (this._busy) {
        degraded = true;
        status = await this._probeStatus();
      } else if (this._runner && typeof this._runner.collectStatus === 'function') {
        const raced = await withDeadline(this._runner.collectStatus(), this._deadlineMs);
        if (raced && raced.__deadline === true) {
          this._stats.timeouts += 1;
          lastError = 'status_deadline';
        } else if (raced && raced.__error) {
          lastError = _oneLine(raced.__error && raced.__error.message) || 'collectStatus_failed';
        } else {
          status = raced;
        }
      } else {
        lastError = 'no_status_source';
      }
    } catch (error) {
      lastError = _oneLine(error && error.message) || 'collectStatus_threw';
      status = null;
    }

    // 序号判废：被 deadline 放弃的那个 collectStatus 还在后台跑，它晚到的结果
    // 不许覆盖这期间开始的更新的快照。
    if (seq !== this._seq) {
      return this._snapshot;
    }

    const at = this._now();
    this._stats.lastMs = Math.max(0, at - startedAt);
    this._stats.lastAt = at;

    if (!status) {
      // 失败不清空：保留上一份好快照，ageMs 从原 at 继续长，stale 由 getSnapshot 算。
      const prev = this._snapshot;
      this._snapshot = prev
        ? { status: prev.status, at: prev.at, state: 'ready', stale: true, degraded: prev.degraded, lastError }
        : { status: null, at, state: 'error', stale: false, degraded, lastError };
      this._touch();
      this._emit();
      return this._snapshot;
    }

    this._healToken(status);
    this._snapshot = { status, at, state: 'ready', stale: false, degraded, lastError: null };
    this._touch();
    this._emit();
    return this._snapshot;
  }

  /**
   * 忙位期间的心跳快照。只填 probe 真正测到的东西（桥端口/工具数/模式），adb / 设备 /
   * 转发 / 屏幕一律留空——没测的字段留空，视图模型渲染成 '—'，不猜。
   * @returns {Promise<object>} 标记 partial 的 collectStatus 形状
   */
  async _probeStatus() {
    const config = this._runner && _isPlainObject(this._runner.config) ? this._runner.config : {};
    const bridgeConfig = _isPlainObject(config.bridge) ? config.bridge : {};
    let res = null;
    try {
      res = await this._liveness.probe();
    } catch (error) {
      res = { ok: false, error: _oneLine(error && error.message) || 'probe_threw' };
    }
    const heartbeat = res && _isPlainObject(res.status) ? res.status : {};
    const tools = _num(heartbeat.tools);
    const online = !!(res && res.ok === true && res.httpPortBound === true);
    return {
      ok: false,
      partial: true,
      adb: null,
      device: null,
      forwards: null,
      bridge: {
        online,
        latencyMs: null,
        detail: online
          ? '下发期间只读心跳（status.json），未发 HTTP 探活'
          : `心跳探活失败：${_oneLine(res && res.error) || '无响应'}`,
        port: _num(bridgeConfig.port),
        transport: _str(bridgeConfig.transport) || null,
        baseUrl: _str(bridgeConfig.baseUrl) || null,
        token: null,
        tokenDetail: '下发期间未读令牌',
        tools: tools === null ? null : tools,
        mode: _str(heartbeat.mode) || null,
      },
      screen: null,
      uiAutomation: null,
      summary: '',
    };
  }

  /**
   * 401 自愈。client 的令牌缓存 6 小时，桥重装后旧令牌会让面板连续数小时误报
   * 「桥不在线」——目前只有 _fillInput 的失败路径会失效化它，这里补上只读路径。
   */
  _healToken(status) {
    const bridge = status && _isPlainObject(status.bridge) ? status.bridge : null;
    if (!bridge || bridge.online !== false) {
      return;
    }
    if (!/http_401/.test(_str(bridge.detail))) {
      return;
    }
    const client = this._runner && this._runner.client;
    if (!client || typeof client.invalidateToken !== 'function') {
      return;
    }
    try {
      client.invalidateToken();
      this._stats.tokenHeals += 1;
    } catch {
      /* 自愈失败不值得让整次 refresh 失败 */
    }
  }

  _buildModel(snapshot) {
    const now = this._now();
    const at = snapshot ? snapshot.at : null;
    const ageMs = at === null ? null : Math.max(0, now - at);
    const stale = at === null ? false : ageMs > this._ttlMs;
    const progress = this._progress
      ? {
          steps: this._progress.steps,
          poll: this._progress.poll,
          elapsedMs:
            _num(this._progress.startedAt) !== null
              ? Math.max(0, now - this._progress.startedAt)
              : _num(this._progress.poll && this._progress.poll.waitedMs),
        }
      : null;
    return buildAmooPanelModel({
      status: snapshot ? snapshot.status : null,
      dispatch: this._lastDispatch,
      progress,
      busy: this._busy,
      stale,
      ageMs,
      now,
      maxValueChars: this._maxValueChars,
    });
  }

  _touch() {
    const snapshot = this._snapshot;
    const at = snapshot ? snapshot.at : null;
    const ageMs = at === null ? null : Math.max(0, this._now() - at);
    this._modelStale = at === null ? false : ageMs > this._ttlMs;
    this._model = this._buildModel(snapshot);
  }

  _emit() {
    if (this._listeners.size === 0) {
      return;
    }
    const snapshot = this.getSnapshot();
    for (const fn of [...this._listeners]) {
      try {
        fn(snapshot);
      } catch {
        /* 一个坏订阅者不该弄坏供数器 */
      }
    }
  }
}

module.exports = {
  AmooStatusProvider,
  withDeadline,
  DEFAULT_TTL_MS,
  DEFAULT_DEADLINE_MS,
};
