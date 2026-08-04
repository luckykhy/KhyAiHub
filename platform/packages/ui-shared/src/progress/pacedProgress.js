/**
 * pacedProgress — 「渐进节拍」的浏览器侧单一真源（与后端
 * `services/backend/src/services/progressiveProgress.js` 同一套口径）。
 *
 * 为什么需要它（用户目标）：khyos 里的进度条此前分两类病灶 ——
 *   ① **不确定进度**（等后端响应、拉模型列表、路由切换 + 懒加载分块）干脆没有百分比，
 *      要么是一枚转圈图标，要么干脆什么都没有，用户盯着一个不动的界面几十秒就是「卡死」。
 *   ② **确定进度**但分母粗（18 个适配器、2 个网关分组）→ 一出场就是 50%，然后长时间冻住。
 * 用户要的是「**宁可慢一些，1% 1% 地加载**」：条必须持续以 1% 的步长前进。
 *
 * 两条车道，与后端逐字同义：
 *   · **不确定进度**（`determinate:false`）—— 以 1% 的步长爬三段递慢的曲线：前 `easeAfter`
 *     （70%）每 `stepMs` +1 → 到 `cap`（96）换 `slowStepMs` → 过 `cap` 换 `TAIL_STEP_MS`
 *     继续爬到 `TAIL_CAP`（99）。永不静止（`cap` 只是换档点，不是终点），也永不到 100。
 *   · **确定进度**（`determinate:true`）—— 目标是**真实百分比**，同样以 1% 的步长追赶，
 *     显示值**永不越过真实值**。
 *
 * 五条硬约束（与后端一致）：**单调**（只增不减）、**永不虚报完成**（到 100 的唯一入口是
 * `finish()` 或真实值真的到 100）、**不静止**（不确定进度到 `TAIL_CAP` 之前一定在动）、
 * **一帧最多 +1%**（单次采样最多涨 1%，攒下的时间丢弃 —— 事件稀疏时也不会一跳几十个百分点；
 * 代价是采样频率低于 stepMs 时走得更慢，故渲染器必须自持 RENDER_MS 节拍）、
 * **收尾也逐步**（`finish()` / 真实值到 100 都只设**目标**，显示值仍 1%/帧走过去 ——
 * 旧实现直接赋 100，那一跳正是「卡在一个地方很久然后突然加载完成」）。
 *
 * 与后端的差异只有一处：浏览器没有 `process.env` 门控，降级判据改为 Web 平台原生信号
 * —— `prefers-reduced-motion`（等价于后端的 `KHY_REDUCED_MOTION`）。真值时不叠加节拍，
 * 只**直接报**真实值（假动效也是一种欺骗）。
 *
 * 纯叶子：零 IO、不读全局、不写 console；时钟可注入（测试确定性）。**never throws**。
 */

// ── 节拍常量（与后端 services/progressiveProgress.js 逐值一致，改动请两边一起改）──
export const STEP_MS = 160; // 每 1% 的快速档耗时（对齐渲染节拍：每帧恰好 +1%）
export const EASE_AFTER = 70; // 过七成后换慢速档
export const SLOW_STEP_MS = 1400; // 慢速档每 1% 耗时（70 → 96 约 36 秒）
export const CAP = 96; // 慢速档的**换档点**（不再是终点：过它转尾巴档继续爬）
export const TAIL_STEP_MS = 4000; // 尾巴档每 1% 耗时（96 → 99 约 12 秒，长任务也不静止）
export const TAIL_CAP = 99; // 不确定进度的最终上限（整数百分比在 99 处物理到顶）
export const RENDER_MS = 160; // 自持时钟的渲染器应当用这个节拍重绘

export const DEFAULTS = Object.freeze({
  stepMs: STEP_MS,
  easeAfter: EASE_AFTER,
  slowStepMs: SLOW_STEP_MS,
  tailStepMs: TAIL_STEP_MS,
  cap: CAP,
});

// 单次 percent() 调用里最多推进的步数 —— **恒为 1**（与后端 MAX_STEPS_PER_CALL 同值同义）。
// 「显示必须逐步走」：任何一帧里显示值最多 +1%，迟到的采样不会把攒下的时间一次性
// 兑换成几十个百分点（那正是「一下加载百分之几十」的病灶）。代价：采样频率低于
// stepMs 时条走得更慢 —— 所以渲染器必须自持 RENDER_MS 节拍（usePacedProgress 已自持）。
const MAX_STEPS_PER_CALL = 1;

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clampPercent(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

/**
 * 天花板兜底。两条硬约束（与后端 `progressiveProgress._cap` 同义）：**非正数 → 回退
 * 默认**（`cap: 0` / 负数都是配置写错，照收就成了「条永远不动」）；**上限钉在 99**
 * （未完成时绝不出 100 —— `cap: 100` 会让条爬到 100% 停住，那就是虚报完成）。
 */
function clampCap(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(99, n);
}

export function normalizeOptions(options) {
  const o = options || {};
  return {
    stepMs: positive(o.stepMs, STEP_MS),
    easeAfter: clampPercent(o.easeAfter, EASE_AFTER),
    slowStepMs: positive(o.slowStepMs, SLOW_STEP_MS),
    tailStepMs: positive(o.tailStepMs, TAIL_STEP_MS),
    cap: clampCap(o.cap, CAP),
  };
}

/**
 * 节拍曲线 —— 纯函数：给定「已流逝毫秒」，返回此刻节拍应到的整数百分比（0..TAIL_CAP），
 * 单调不减且每步恰好 +1。这是不确定进度车道的**目标函数**。
 *
 * ⚠ **不要拿它当显示值**：它是绝对时间函数，一次求值就能返回任意高的数。
 * 要与用户见面的显示值一律走 `createPacer().percent()` —— 那一侧有「一帧最多 +1%」
 * 的硬不变式，不会一跳几十个百分点。
 */
export function pacedPercent(elapsedMs, options) {
  const { stepMs, easeAfter, slowStepMs, tailStepMs, cap } = normalizeOptions(options);
  const t = Number(elapsedMs);
  if (!Number.isFinite(t) || t <= 0 || cap <= 0) return 0;
  const easeBand = Math.min(cap, Math.floor(easeAfter));
  const reachEaseAt = easeBand * stepMs;
  if (t < reachEaseAt) {
    return Math.min(cap, Math.floor(t / stepMs));
  }
  const slowSteps = Math.floor((t - reachEaseAt) / slowStepMs);
  if (slowSteps <= 0) return easeBand;
  if (easeBand + slowSteps <= cap) return easeBand + slowSteps;
  // 尾巴档：cap 之后每 tailStepMs +1，恒不越过 TAIL_CAP（与 createPacer 的曲线同形）。
  const reachCapAt = reachEaseAt + (cap - easeBand) * slowStepMs;
  const tailSteps = Math.floor((t - reachCapAt) / tailStepMs);
  return Math.min(TAIL_CAP, cap + Math.max(0, tailSteps));
}

/**
 * 百分比 → 定宽条里应当点亮的格数（单一真源：所有画条的地方都从这里取数）。
 */
export function filledCells(percent, width = 20) {
  const w = Math.max(1, Math.floor(positive(width, 20)));
  const pct = clampPercent(percent, 0);
  return Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
}

/**
 * 把百分比画成定宽条。
 * @param {number} percent 0..100
 * @param {number} [width] 格数（默认 20）
 * @param {{filled?: string, empty?: string}} [glyphs] 实心/空心字形
 * @returns {string} 恒为 width 个字符
 */
export function renderBar(percent, width = 20, glyphs) {
  const w = Math.max(1, Math.floor(positive(width, 20)));
  const g = glyphs || {};
  const filledChar = typeof g.filled === 'string' && g.filled ? g.filled : '█';
  const emptyChar = typeof g.empty === 'string' && g.empty ? g.empty : '░';
  const filled = filledCells(percent, w);
  return filledChar.repeat(filled) + emptyChar.repeat(w - filled);
}

/**
 * 创建一个有状态的节拍器（与后端同名 API 同语义）。**never throws**。
 *
 * @param {object} [options]
 * @param {object} [options.pace] stepMs / easeAfter / slowStepMs / cap
 * @param {() => number} [options.now] 注入时钟（默认 Date.now）
 * @param {boolean} [options.determinate=false] true=真实分母已知（目标=真实值，永不越过）
 * @param {boolean} [options.static=false] 减少动效档：只**直接报**真实值（不叠加节拍、不逐步爬）
 * @param {number} [options.startPercent=0] 起始百分比（中途挂载时不从 0 重来）
 * @param {number} [options.startedAt] 操作真实开始的时刻（epoch ms）。给了它，**起点**按
 *   「曲线在这一刻的位置」播种，此后仍按 1% 1% 走 —— 它**不是**计时基准，迟到的时间不会
 *   在第一次采样里补足（补足就是跳）。
 */
export function createPacer(options) {
  const o = options || {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const pace = normalizeOptions(o.pace);
  const isStatic = o.static === true;
  const determinate = o.determinate === true;
  const createdAt = now();
  const declaredStart = Number(o.startedAt);
  const startedAt = Number.isFinite(declaredStart) ? declaredStart : createdAt;
  const startPercent = clampPercent(o.startPercent, 0);

  // 起点播种（与后端同义）：中途挂载的条从「曲线此刻的位置」起步，而不是稍后补足 —— 补足就是跳。
  const seedFromClock = determinate || isStatic ? 0 : pacedPercent(createdAt - startedAt, pace);
  let shown = Math.min(Math.floor(Math.max(startPercent, seedFromClock)), TAIL_CAP);
  let real = clampPercent(startPercent, 0);
  // `done` = **工作已经结束**（真实值到 100 或调用方 finish()）—— 与「显示值已在 100」分开记：
  // 收尾也是一步 1% 走过去的，混为一谈就会把「已结束」画成「一瞬间满格」。
  let done = real >= 100;
  // 节拍基准取创建时刻：startedAt 只用于起点播种与 elapsed() 口径。
  let lastStepAt = createdAt;

  function target() {
    if (determinate || isStatic) return real; // 真实值是权威（含它自己走到 100）
    return done ? 100 : TAIL_CAP; // 不确定进度：未结束爬到 TAIL_CAP，结束后收尾到 100
  }

  /**
   * 显示上限（与后端 `_displayCeiling` 同义）：已结束 → 100；确定进度 / 减少动效（未结束）
   * → 99、不确定进度（未结束）→ `TAIL_CAP`（99，`cap` 只是换档点）。
   */
  function ceiling() {
    if (done) return 100;
    if (determinate || isStatic) return 99;
    return TAIL_CAP;
  }

  /** 此刻该用的档位（与后端 `_rate` 同义）：收尾回快档；确定进度两档；不确定进度三档。 */
  function rate() {
    if (done) return pace.stepMs;
    if (shown < pace.easeAfter) return pace.stepMs;
    if (determinate || isStatic) return pace.slowStepMs;
    return shown < pace.cap ? pace.slowStepMs : pace.tailStepMs;
  }

  /**
   * 以 1% 为步长向目标推进 —— **每次调用最多一步**（与后端 `_advance` 同义）。
   *
   * 「显示不跳」的落点：超出一步的时间债直接丢弃（基准收到 `at - rate`），于是推进速度
   * 由采样频率决定而非事件密度。自持 RENDER_MS 节拍的渲染器恒为 1%/帧。
   */
  function advance(at, to) {
    const limit = Math.floor(to);
    if (shown >= limit) {
      // 已到目标之上：不倒退，但把基准拉到现在，避免攒下步数债在后续一次吐出。
      if (at > lastStepAt) lastStepAt = at;
      return;
    }
    const r = rate();
    if (at - lastStepAt > r) lastStepAt = at - r; // 只保留一步的时间债
    if (at - lastStepAt < r) return;
    lastStepAt += r * MAX_STEPS_PER_CALL;
    shown += MAX_STEPS_PER_CALL;
  }

  function percent(at) {
    // 减少动效：不叠加节拍，直接报真实值（没人 observe 时就是 startPercent 的落点）；
    // 工作结束时直接报 100 —— 这一档不许有动效，也就不许有「爬上去」的过程。
    // 顺带同步 `shown`，否则 isFinished()/settled() 会与 percent() 自相矛盾。
    if (isStatic) {
      shown = done ? 100 : Math.max(0, Math.min(Math.floor(real), ceiling()));
      return shown;
    }
    const t = at === undefined ? now() : Number(at);
    const at2 = Number.isFinite(t) ? t : now();
    advance(at2, target());
    return Math.max(0, Math.min(shown, ceiling()));
  }

  return {
    percent,
    bar: (width, glyphs, at) => renderBar(percent(at), width, glyphs),
    observe(value) {
      const p = clampPercent(value, NaN);
      if (!Number.isFinite(p)) return percent();
      if (p > real) real = p;
      // 真实值到 100 = 工作结束 → 转终态。**不**在这里把显示值赋成 100：收尾同样 1% 1% 地走。
      if (real >= 100) done = true;
      return percent();
    },
    /**
     * 明确完成 —— 只把**目标**设成终态，显示值由同一套 1%/帧的节拍走过去（96 → 100 四帧）。
     * 旧实现直接赋 100，那一跳正是「卡在一个地方很久、然后突然加载完成」。
     */
    finish() {
      done = true;
      advance(now(), target());
      return percent();
    },
    /** 工作是否已结束（显示值可能仍在收尾的路上）。 */
    isDone: () => done,
    /** 显示值是否**真的**到了 100。 */
    isFinished: () => done && shown >= 100,
    /**
     * 这条车道已经没有任何东西可动了吗（渲染器据此停表）。与后端同义。
     */
    settled() {
      if (isStatic) return true;
      if (determinate) return shown >= Math.floor(real);
      return done ? shown >= 100 : shown >= TAIL_CAP;
    },
    real: () => real,
    elapsed: (at) => {
      const t = at === undefined ? now() : Number(at);
      return Math.max(0, (Number.isFinite(t) ? t : now()) - startedAt);
    },
    pace,
    determinate,
    /**
     * 只把节拍基准收到此刻，**不改显示值**（前端独有：后端每个消费方都是一操作一 pacer，
     * 不存在「同一 pacer 跨两段等待」的情形）。用途是等待状态 false→true 时别把攒下的
     * 时间一次性折算成一大跳 —— 而那又不该以「显示值回退」为代价（破坏单调性）。
     */
    rebase(at) {
      const t = at === undefined ? now() : Number(at);
      lastStepAt = Number.isFinite(t) ? t : now();
      return percent(0);
    },
    /** 复位到新建态（同一段加载重新开始时用；否则条会带着上一段的 99% 继续）。 */
    reset() {
      shown = Math.min(Math.floor(startPercent), TAIL_CAP);
      real = clampPercent(startPercent, 0);
      done = real >= 100;
      lastStepAt = now();
      return percent(0);
    },
  };
}

/**
 * 用户是否要求「减少动态效果」。浏览器里用平台原生信号（与后端 KHY_REDUCED_MOTION 同义）。
 * SSR / 无 matchMedia 环境 → false（fail-soft：拿不准就按默认走）。
 */
export function prefersReducedMotion() {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}