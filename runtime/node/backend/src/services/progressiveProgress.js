'use strict';

/**
 * progressiveProgress — 「渐进节拍」的单一真源。
 *
 * 为什么需要它（用户目标）：khyos 里的进度条此前分两类病灶 ——
 *   ① **不确定进度**（等待模型、探测、压缩、心跳）干脆没有百分比：要么是一枚走马灯
 *      （`░▒▒▒░` 来回扫），要么只有「已等待 12s」。用户看着它几十秒不动一个数，体感就是卡死。
 *   ② **确定进度**但分母粗（`done/total` 只有 3~6 拍，或 2 个适配器）→ 一出场就 67%，
 *      之后长时间冻住。
 * 用户要的是「**宁可慢一些，1% 1% 地加载**」：进度条必须持续以 **1% 的步长**前进，
 * 让人看见 khyos 在干活，而不是一次跳一大格然后长时间静止。
 *
 * 核心是一条**单调、诚实、以 1% 为步长**推进的曲线。两条车道：
 *
 *   · **不确定进度**（`determinate:false`，分母未知）—— 以 1% 的步长爬三段递慢的曲线：
 *     前 `easeAfter`（70%）每 `stepMs` +1 → 到 `cap`（96）换 `slowStepMs` → 过 `cap` 换
 *     `TAIL_STEP_MS`（尾巴档）继续爬到 `TAIL_CAP`（99）。于是长任务下它**一直在动**，
 *     只是越走越慢；又永远到不了 100（100 只有两个入口：真实值到 100、调用方 `finish()`）。
 *     `cap` 因此是**换档点**而不是终点 —— 旧实现把 cap 当终点，长任务就冻在 96% 等收尾。
 *
 *   · **确定进度**（`determinate:true`，分母已知）—— 目标是**真实百分比**，同样以 1% 的
 *     步长**追赶**它。真实值必须由调用方 `observe()` 喂进来，显示值**永不越过真实值**
 *     （这就是「诚实」的全部含义：条满不到真实进度之外）。从 0% 跳到 67% 的粗分母
 *     因此被摊成一条 1% 1% 走的曲线。
 *
 * 两车道共用的五条硬约束：
 *   · **单调**：显示值只增不减（内部取历史最大值），真实值回退也不会让条往回缩。
 *   · **永不虚报完成**：显示值到 100 的**唯一**入口是 `finish()`（或确定进度下真实值
 *     真的到 100）。没有 `markDoneAfter(ms)` 之类的定时版本 —— 与 startupBeats 的
 *     「超时只用于降级并告知，绝不用来判定完成」同源。
 *   · **不静止**：不确定进度在 `TAIL_CAP`（99）之前一定在动，`cap` 不是终点；`static`
 *     （减少动效）档例外 —— 那一种情况下只报真实值、**且不逐步爬**（假动效也是一种欺骗，
 *     而让减少动效的用户去等 1% 1% 地爬更是南辕北辙）。
 *   · **一帧最多 +1%**（`MAX_STEPS_PER_CALL = 1`）：任何**一次**采样最多让显示值涨 1%，
 *     攒下的时间一律丢弃。这条是「显示不跳」的硬保证 —— 事件稀疏的渲染器不会在同一帧里
 *     从 30% 跳到 70%。代价是采样频率低于 `stepMs` 时条走得更慢（宁可慢，不要跳），
 *     所以每个渲染器都必须**自持**一个 `RENDER_MS`（= `STEP_MS`）的渲染节拍。
 *   · **收尾也逐步**：`finish()` / 真实值到 100 都**不**直接把显示值赋成 100，只把目标设成
 *     终态，仍由同一套 1%/帧的节拍走过去（96 → 100 只需 4 帧）。旧实现是直接赋 100，
 *     于是「卡在一个地方很久」的下一幕就是「突然加载完成」—— 两端都让用户怀疑它没在干活。
 *
 * 与 startupBeats 的关系：那一个是**启动六拍**的投影（回答「启动走到第几拍了」），
 * 本叶子回答「任意一段等待，条该画多满」。两者显示层口径同源（按真实流逝时间平滑推进
 * + 护栏防虚报），但本叶子刻意不依赖启动拍表 —— 通用等待没有拍可投影。
 *
 * 纯度边界：曲线（`pacedPercent` / `renderBar` / `createPacer`）**纯**——零 IO、
 * 不读 env、不写 console。只有门控助手（`isPacedEnabled` / `isReducedMotion`）读 env，
 * 因为若干消费方必须用**同一个**门与同一个降级判据，不能让各自抄一遍。
 *
 * 消费方（全仓**进度条**的收敛点）：
 *   · cli/tui/ink-components/ProgressBar.js      —— ink 进度条（pulse / time / 无分母的 count）
 *   · cli/tui/ink-components/CompactionProgress.js —— 压缩条（真实 floor 之间的缓动）
 *   · cli/ui/inkComponents.js                    —— 经典模式字符串进度条
 *   · cli/bootPhaseLine.js                       —— pre-Ink 引导行（只共用 renderBar，见下）
 *   · services/updateProgressRenderer.js         —— TTY 覆写行
 *   · cli/handlers/device.js                     —— 下载条的填充节拍
 *
 * **刻意不接入的两类**（不是遗漏）：
 *   · **spinner**（cli/spinner.js、cli/tui/ink-components/Spinner.js）—— 它们是**走马灯**
 *     而非进度条：字形本身就在转（原生 motion），并且已经带「动作+目标+进度」（已等待
 *     Xs / ↑↓ tokens / 工具 done/total）。在那儿再挂一个合成百分比，等于给一个不存在的
 *     分母编进度 —— 是凭空断言，不是把粗分母摊细。
 *   · **额度表**（模型额度、上下文用量、任务看板的 progressPct 的**文字**部分）—— 值是
 *     既成事实，不是在跑的等待；把 72% 从 0% 爬到 72% 会让用户误读成「我只用了很少」。
 *     任务看板那类**粗分母的进行中进度**除外（TaskCard 的填充确实接了节拍）。
 */

// ── 节拍常量（单一真源；调用方可逐项覆盖）───────────────────────────────────────
//
// STEP_MS = 160ms/1%：这是**刻意选定的进度步长**，不是渲染节拍的产物 —— 它决定
//   「1% 要花多久」（0→100 约 16 秒），不决定「多久重画一次」；后者由各渲染器自持的
//   RENDER_MS 决定，且 RENDER_MS 必须 = 本值（见 ProgressBar 的派生处）。
//   历史注记：本段曾把 STEP_MS 说成「对齐 ink 动画节拍（perfTunables.spinnerFrameMs
//   默认值）」的产物，而 ProgressBar 又反过来从 spinnerFrameMs 派生 RENDER_MS —— 这个
//   循环让 KHY_TUI_LOW_POWER 把 RENDER_MS 放宽到 320ms 而步长仍是 160ms，于是一跳 2%，
//   恰好推翻「1% 1%」。2026-09-29 解耦：方向改为 STEP_MS → RENDER_MS，单向。
//   取值更密（如 110ms）在本仓已有性能纪律下（Windows ConHost 每次 write 都是阻塞
//   系统调用）会出现「渲染跟不上节拍」→ 一跳 2%，反而破坏「1% 1%」的观感。
// EASE_AFTER = 70%：到七成后换慢速档。前七成是「还在快速推进」的观感区间（约 11 秒）。
// SLOW_STEP_MS = 1400ms/1%：慢档每 1.4 秒 +1。70 → 96 要 36 秒 —— 一个典型的 AI 长回答、
//   上下文压缩、依赖下载都能被覆盖住而不触顶。
// CAP = 96%：慢档的**换档点**，不再是终点。到达它之后转尾巴档继续爬 —— 旧实现到此为止
//   （目标=cap，触顶即静止），长任务就冻在 96% 不动，等收尾再一跳画到 100：前半截
//   「卡在一个地方很久」+ 后半截「突然加载完成」，正是用户否掉的两件事。
// TAIL_STEP_MS = 4000ms/1%：尾巴档。96 → 99 约 12 秒，全程仍在动，且**绝不到 100**
//   （100 只有一个入口：真实值到 100，或调用方 finish()）。
// TAIL_CAP = 99%：不确定进度的最终显示上限。再往上就只能靠「已等待 12s」这类文本报活了 ——
//   整数百分比在 99 处物理到顶，这是它的诚实边界（想更久就得报小数）。
// RENDER_MS = 160ms：自己持有时钟的渲染器应当用这个节拍重画（= STEP_MS，保证每帧 1%）。
const STEP_MS = 160;
const EASE_AFTER = 70;
const SLOW_STEP_MS = 1400;
const CAP = 96;
const TAIL_STEP_MS = 4000;
const TAIL_CAP = 99;
const RENDER_MS = 160;

const DEFAULTS = Object.freeze({
  stepMs: STEP_MS,
  easeAfter: EASE_AFTER,
  slowStepMs: SLOW_STEP_MS,
  tailStepMs: TAIL_STEP_MS,
  cap: CAP,
});

// 单次 percent() 调用里最多推进的步数 —— **恒为 1**，这是硬不变式而非防御性上界。
//
// 「显示必须逐步走」是用户明说的要求：任何一帧里显示值最多 +1%。旧实现按「已流逝时间」
// 在**一次调用**里补齐几十步（事件稀疏的渲染器于是同一帧从 30% 跳到 70%），正是要消灭的观感。
// 代价说清楚：调用频率低于 stepMs 时条会走得比节拍**慢**。宁可慢，不要跳 —— 所以每个
// 渲染器都必须自持一个 RENDER_MS（= STEP_MS）的渲染节拍（见各消费方）。
const MAX_STEPS_PER_CALL = 1;

// 正数兜底：只有有限且 > 0 才采纳，否则回退默认（配置写错不得把节拍带崩）。
function _positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 0..100（含端点）的有限数兜底；非法 → 默认值。
function _percent(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

/**
 * 天花板兜底。两条硬约束：**非正数 → 回退默认**（`cap: 0` / 负数都是配置写错，
 * 若照收就成了「条永远不动」—— 正是本模块要消灭的观感）；**上限钉在 99**（未完成时
 * 绝不出 100 —— `cap: 100` 会让不确定进度的条爬到 100% 停住，那就是虚报完成）。
 */
function _cap(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(99, n);
}

function normalizeOptions(options) {
  const o = options || {};
  return {
    stepMs: _positive(o.stepMs, STEP_MS),
    easeAfter: _percent(o.easeAfter, EASE_AFTER),
    slowStepMs: _positive(o.slowStepMs, SLOW_STEP_MS),
    tailStepMs: _positive(o.tailStepMs, TAIL_STEP_MS),
    cap: _cap(o.cap, CAP),
  };
}

/**
 * 节拍曲线 —— 纯函数：给定「已流逝毫秒」，返回**此刻节拍应到的整数百分比**
 * （0..cap），单调不减且每步恰好 +1。
 *
 * 这是 `createPacer` 不确定进度车道的**目标函数**；也直接供只需要一个数、
 * 不需要状态与逐步推进的场合（如一行文案里的 `42%`）使用。
 *
 * ⚠ **不要拿它当显示值**：它是「按已流逝时间算，此刻**应该**到哪」的绝对时间函数，
 * 一次求值就能返回任意高的数（比如刚问就回 96）。**要与用户见面的显示值一律走
 * `createPacer().percent()`** —— 那一侧有「一帧最多 +1%」的硬不变式，不会跳。
 *
 * @param {number} elapsedMs 已流逝毫秒（<0 / 非有限 → 0）
 * @param {object} [options] 覆盖 DEFAULTS（stepMs / easeAfter / slowStepMs / cap）
 * @returns {number} 0..cap 的整数
 */
function pacedPercent(elapsedMs, options) {
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
 * 百分比 → 定宽条里应当点亮的**格数**（单一真源：所有画条的地方都从这里取数，
 * 免得各自的 round/clamp 口径分叉 —— 两处口径不同就会出现「同一个 42% 一个 8 格
 * 一个 9 格」这种对不上的观感）。
 * @param {number} percent 0..100（越界只影响比例，不影响宽度）
 * @param {number} [width] 格数（默认 20）
 * @returns {number} 0..width 的整数
 */
function filledCells(percent, width) {
  const w = Math.max(1, Math.floor(_positive(width, 20)));
  const pct = _percent(percent, 0);
  return Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
}

/**
 * 把百分比画成定宽条（单一真源：全仓 CLI 的条都用它，字形可换）。
 * @param {number} percent 0..100
 * @param {number} [width] 格数（默认 20）
 * @param {{filled?: string, empty?: string}} [glyphs] 实心/空心字形
 * @returns {string} 恒为 width 个字符（percent 越界只影响填充比例，不影响宽度）
 */
function renderBar(percent, width, glyphs) {
  const w = Math.max(1, Math.floor(_positive(width, 20)));
  const g = glyphs || {};
  const filledChar = typeof g.filled === 'string' && g.filled ? g.filled : '█';
  const emptyChar = typeof g.empty === 'string' && g.empty ? g.empty : '░';
  const filled = filledCells(percent, w);
  return filledChar.repeat(filled) + emptyChar.repeat(w - filled);
}

/**
 * 创建一个有状态的节拍器。所有方法 **never throw**，输入非法一律收敛到安全值。
 *
 * @param {object} [options]
 * @param {object} [options.pace] 节拍参数（stepMs / easeAfter / slowStepMs / cap）
 * @param {() => number} [options.now] 注入时钟（测试确定性；默认 Date.now）
 * @param {boolean} [options.determinate=false] true=真实分母已知（目标=真实值，永不越过）；
 *   false=分母未知（目标=cap，靠节拍持续推进）
 * @param {boolean} [options.static=false] 减少动效档：只**直接报**真实值（不叠加节拍、不逐步爬）
 * @param {number} [options.startPercent=0] 起始百分比（新起一段等待时不想从 0 重来）
 * @param {number} [options.startedAt] 操作**真实开始**的时刻（epoch ms）。给了它，**起点**按
 *   「曲线在这一刻的位置」播种（组件在等待开始之后才挂载，如 TUI 里 `gatewayProgress`
 *   中途出现，条不该从 0 重来）；此后仍按 1% 1% 走。它**不是**计时基准 —— 迟到的时间不会
 *   在第一次采样里补足（补足就是跳）。缺省 → 用注入时钟的当前时刻。
 * @returns {object} pacer
 */
function createPacer(options) {
  const o = options || {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const pace = normalizeOptions(o.pace);
  const isStatic = o.static === true;
  const determinate = o.determinate === true;
  const createdAt = now();
  const declaredStart = Number(o.startedAt);
  // 操作**真实开始**的时刻（回填值通常早于创建时刻 —— 组件在等待开始之后才挂载）。
  const startedAt = Number.isFinite(declaredStart) ? declaredStart : createdAt;
  const startPercent = _percent(o.startPercent, 0);

  /**
   * 起点播种。不确定进度车道若回填了 `startedAt`（这一段等待已经跑了一会儿），显示值直接
   * **从曲线此刻的位置起步** —— 而不是稍后在第一次采样里补足。
   *
   * 补足就是跳（60 秒不采样 → 一帧画出 96%），而「这一段已经跑了 3.2 秒」本来就可以如实
   * 播报 —— 它与 `startPercent`、与额度表同类：**起点是既成事实，不是动画**。于是中途挂载
   * 的条既不从 0 重来（那会让「已经做了四成」的活看起来刚起步），也不会一跳几十个百分点，
   * 从那一刻起照旧 1% 1% 地走。
   */
  const seedFromClock = determinate || isStatic ? 0 : pacedPercent(createdAt - startedAt, pace);

  // 显示值：整数、只增不减。上限见 `_displayCeiling()`（未完成时不确定进度到 99，
  // 完成后才到 100）。
  let shown = Math.min(Math.floor(Math.max(startPercent, seedFromClock)), TAIL_CAP);
  let real = _percent(startPercent, 0);
  // `done` = **工作已经结束**（真实值到 100，或调用方 finish()）。它不是「显示值已在 100」——
  // 收尾也是一步 1% 走过去的，两者分开记才不会把「已结束」画成「一瞬间满格」。
  let done = real >= 100;
  // 节拍基准取**创建**时刻 —— 回填的 `startedAt` 只用于起点播种与 `elapsed()` 口径，
  // 不再充当计时基准（否则第一帧就会补一步）。
  let lastStepAt = createdAt;

  /**
   * 显示上限。三条口径：
   *
   * · **已结束**（`done`）→ 100。这是 100 的唯一合法出口。
   * · **确定进度 / 减少动效**（未结束）→ 99。这两条车道的目标是**真实值**，用 4% 的余量压住
   *   就成了凭空少画（真实值 98 却只画 96）；但未完成时也绝不出 100。
   * · **不确定进度**（未结束）→ `TAIL_CAP`（99）。`cap`（96）只是**换档点**：到了它转尾巴档
   *   继续爬，于是长任务也不会冻在 96 上等收尾（旧实现到此为止，那就是「卡住很久」）。
   */
  function _displayCeiling() {
    if (done) return 100;
    if (determinate || isStatic) return 99;
    return TAIL_CAP;
  }

  /**
   * 当前目标百分比（可能是小数；显示值取 floor 后不得超过它）。
   *
   * 终态目标（`done`）只有不确定进度车道取 100 —— 那条车道没有真实值，工作结束就等于
   * 这段活动 100% 走完。确定进度车道的目标恒为**真实值**（含真实值自己走到 100）：调用方在
   * 只下了 67% 时喊 finish()，条也不许凭空画到 100 —— 那与旁边 `67/100` 的账本自相矛盾。
   */
  function _target() {
    if (determinate || isStatic) return real;
    if (done) return 100;
    // 不确定进度：正常档爬到换档点，之后由尾巴档继续（目标给到 TAIL_CAP，档位现算）。
    return TAIL_CAP;
  }

  /**
   * 此刻该用的档位。
   *   · 已结束（`done`）→ `stepMs`：收尾仍是一帧 +1%，但不再用慢档拖着（96 → 100 只需 4 帧）。
   *   · 未结束、确定进度 / 减少动效 → 快档 + 慢档两档就够：目标是**真实值**，不存在
   *     「没东西可跟、需要靠拖时间来装作还在动」的问题。
   *   · 未结束、不确定进度 → 三档递慢，`cap` 只是换档点，过它转尾巴档继续爬（不静止）。
   */
  function _rate() {
    if (done) return pace.stepMs;
    if (shown < pace.easeAfter) return pace.stepMs;
    if (determinate || isStatic) return pace.slowStepMs;
    return shown < pace.cap ? pace.slowStepMs : pace.tailStepMs;
  }

  /**
   * 以 1% 为步长向 target 推进 —— **每次调用最多一步**（`MAX_STEPS_PER_CALL`）。
   *
   * 「显示不跳」的落点就在这里：迟到的采样不会把攒下的时间一次性兑换成几十个百分点，
   * 超出一步的时间债直接丢弃（把基准收到 `at - rate`）。于是推进速度由**采样频率**决定，
   * 而不是事件密度 —— 自持 RENDER_MS 节拍的渲染器恒为 1%/帧。
   * @param {number} at 时刻
   * @param {number} target 目标（绝对值，非步数）
   */
  function _advance(at, target) {
    const limit = Math.floor(target);
    if (shown >= limit) {
      // 已到目标之上：不倒退，但把计时基准拉到现在，避免攒下「步数债」在后续一次吐出。
      if (at > lastStepAt) lastStepAt = at;
      return;
    }
    const rate = _rate();
    // 攒下的时间只保留一步的量 —— 这就是「一下加载百分之几十」的拦口。
    if (at - lastStepAt > rate) lastStepAt = at - rate;
    if (at - lastStepAt < rate) return;
    lastStepAt += rate * MAX_STEPS_PER_CALL;
    shown += MAX_STEPS_PER_CALL;
  }

  /**
   * 喂入真实百分比（权威来源）。确定进度车道据此推进目标；不确定进度车道下，
   * 真实值无法换算成条宽，只有「到 100」这一件事有意义。
   * 单调：比当前记录小则忽略。
   */
  function observe(value) {
    const p = _percent(value, NaN);
    if (!Number.isFinite(p)) return percent();
    if (p > real) real = p;
    // 真实值到 100 = 工作结束 → 转终态。**不**在这里把显示值赋成 100：那是从 97 直接跳到
    // 100 的「突然加载完成」，收尾同样要 1% 1% 地走（三帧而已）。
    if (real >= 100) done = true;
    return percent();
  }

  /**
   * 明确完成 —— 「工作已结束」的信号（没有定时版本）。
   *
   * **不再**把显示值直接赋成 100（旧实现如此）：那一跳正是用户说的「卡在一个地方很久、
   * 然后突然加载完成」。现在它只把目标设成终态，收尾由**同一套 1%/帧的节拍**走过去：
   * 条在 96 时 4 帧到顶（约 0.6 秒），消费方若只想短停就自己收起（见各消费方的 settleMs）。
   */
  function finish() {
    done = true;
    _advance(now(), _target());
    return percent();
  }

  /**
   * 当前应显示的整数百分比（0..100）。
   * @param {number} [at] 时刻（默认注入时钟）
   * @returns {number} 0..100 的整数
   */
  function percent(at) {
    // 减少动效档：**不叠加节拍**，直接报真实值。若这里还去 `_advance`，减少动效的用户
    // 反而要等 1% 1% 地爬 —— 与「减少动效」的诉求正好相反（那是把动效问题变成了等待问题）。
    // 真实值由调用方 observe() 喂入；没人喂时就是 startPercent 的落点（不是 0）。
    // 工作结束（done）时直接报 100：这一档不许有动效，也就不许有「爬上去」的过程。
    // 顺带把 `shown` 同步过来 —— `isFinished()` / `settled()` 读的是它，不同步就会
    // 出现「percent() 报 100 而 isFinished() 说没有」的自相矛盾。
    if (isStatic) {
      shown = done ? 100 : Math.max(0, Math.min(Math.floor(real), _displayCeiling()));
      return shown;
    }
    const t = at === undefined ? now() : Number(at);
    const at2 = Number.isFinite(t) ? t : now();
    _advance(at2, _target());
    // 天花板：未结束绝不越过上限（确定进度车道的真实值本身已 ≤100，
    // 但 real 可能是 99.6——那也不该显示成 100）。
    return Math.max(0, Math.min(shown, _displayCeiling()));
  }

  /** 当前应显示的条（定宽字符串）。 */
  function bar(width, glyphs, at) {
    return renderBar(percent(at), width, glyphs);
  }

  return {
    percent,
    bar,
    observe,
    finish,
    /** 工作是否已结束（真实值到 100 或调用方 finish()）—— 显示值可能仍在收尾的路上。 */
    isDone: () => done,
    /**
     * 显示值是否**真的**到了 100（收尾走完）。
     *
     * 与 `isDone()` 分开是刻意的：`isDone()` 一喊就得停定时器的写法，会让条停在 96 上不动
     * —— 那正是「卡住很久然后突然完成」。要等条到位就用 `settled()`（它会等收尾走完）。
     */
    isFinished: () => done && shown >= 100,
    /**
     * 这条车道**已经没有任何东西可动**了吗（渲染器据此停表，避免空转定时器）。
     *   · 减少动效档 → 恒 true（本来就不动）。
     *   · 确定进度 → 追平 `floor(真实值)` 即静止（目标恒为真实值）。
     *   · 不确定进度 → 走到 `TAIL_CAP`（99）才算静止；收尾中（`done`）则要等显示到 100。
     */
    settled: () => {
      if (isStatic) return true;
      if (determinate) return shown >= Math.floor(real);
      return done ? shown >= 100 : shown >= TAIL_CAP;
    },
    /** 调用方喂进来的真实百分比（权威口径；供「已下载 12.4/56.8 MB」这类措辞取数）。 */
    real: () => real,
    /** 已流逝毫秒。 */
    elapsed: (at) => {
      const t = at === undefined ? now() : Number(at);
      return Math.max(0, (Number.isFinite(t) ? t : now()) - startedAt);
    },
    pace,
    determinate,
    /** 复位到新建态（测试用）。 */
    reset() {
      shown = Math.min(Math.floor(startPercent), TAIL_CAP);
      real = _percent(startPercent, 0);
      done = real >= 100;
      lastStepAt = now();
      return percent(0);
    },
  };
}

// ── 门控与降级判据（唯一的 env 触点；各消费方共用，不各自抄）─────────────────────

// flagRegistry 走 fail-soft require：注册表不可用按**关**处理（不冒进 —— 拿不准就不改观感）。
let _flagRegistry = null;
try {
  _flagRegistry = require('./flagRegistry');
} catch {
  _flagRegistry = null;
}

/**
 * 渐进节拍门是否开（KHY_PROGRESS_PACED·default-on·off=CANON）。
 * 注册表异常 / 助手缺失 → false（fail-soft：不确定就回退到「只画真实值」的今日观感）。
 * @param {object} [env]
 * @returns {boolean}
 */
function isPacedEnabled(env = process.env) {
  try {
    if (!_flagRegistry || typeof _flagRegistry.isFlagEnabled !== 'function') return false;
    return _flagRegistry.isFlagEnabled('KHY_PROGRESS_PACED', env || {}) === true;
  } catch {
    return false;
  }
}

const REDUCED_MOTION_VALUES = ['1', 'true', 'on', 'yes'];

/**
 * 用户是否要求「减少动态效果」（KHY_REDUCED_MOTION）。真值时不能用节拍**兜**观感
 * —— 那本身就是一种假动效；此时节拍器退化为「只报真实值」。
 * @param {object} [env]
 * @returns {boolean}
 */
function isReducedMotion(env = process.env) {
  try {
    const raw = env && env.KHY_REDUCED_MOTION;
    return REDUCED_MOTION_VALUES.includes(
      String(raw === undefined || raw === null ? '' : raw)
        .trim()
        .toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * 面向渲染器的节拍器工厂：把「门是否开」与「是否减少动效」两件事一次算清。
 *
 * 返回 `null` 表示**门关** —— 调用方据此逐字节回退今日观感（不确定进度干脆不画条/不报数）。
 * 返回 pacer 时，reduced-motion 已折算为 `static:true`（只报真实值，不用节拍兜底）。
 *
 * @param {object} [env] 门控环境（测试注入）
 * @param {object} [options] 透传给 createPacer（pace / now / startPercent / determinate）
 * @returns {object|null} pacer 或 null（门关）
 */
function createDisplayPacer(env = process.env, options = {}) {
  if (!isPacedEnabled(env)) return null;
  return createPacer(Object.assign({ static: isReducedMotion(env) }, options || {}));
}

module.exports = {
  STEP_MS,
  EASE_AFTER,
  SLOW_STEP_MS,
  CAP,
  TAIL_STEP_MS,
  TAIL_CAP,
  RENDER_MS,
  DEFAULTS,
  MAX_STEPS_PER_CALL,
  normalizeOptions,
  pacedPercent,
  filledCells,
  renderBar,
  createPacer,
  isPacedEnabled,
  isReducedMotion,
  createDisplayPacer,
};