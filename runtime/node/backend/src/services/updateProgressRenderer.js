'use strict';

/**
 * updateProgressRenderer — 更新流程的进度行（TTY 覆写一行 / 非 TTY 逐行打印）。
 *
 * 两条车道：
 *   · **分母已知**（`completed`/`total` 都是有限数且 total>0）—— 真实百分比是权威目标，
 *     显示值 1% 1% 地追它、**永不越过**；行里的 `50/100` 那一段仍是**真实账本**（它是事实，
 *     不是进度条），百分比与条宽则由节拍器出 —— 两者同源，免得条与读数分家自相矛盾。
 *   · **分母未知**（只给了 `phase` 与可选的 `progress` 文案）—— 今日只打一句静态的
 *     `进行中` / `第 1/3 阶段`，**没有任何可数的推进刻度**：一个跑几分钟的更新在人眼里
 *     和卡死无异。现在由 `services/progressiveProgress` 的节拍器补一条 1% 1% 逼近
 *     天花板（恒不到 100）的条，并按 `RENDER_MS` 自行重画 —— 于是「还在干」是看得见的。
 *
 * 进度数是节拍器给的**权威口径**：单调、整数、**每次采样最多 +1%**（攒下的时间丢弃，
 * 所以稀疏事件也不会一跳几十个百分点）。`finish()` 收尾时停节拍并打一句终态文案
 * （`✓ 完成 · …`）—— 它**不**补画一条 100% 的条，因为那既是虚报（条没 1% 1% 走到那）
 * 又要让调用方多等几帧；这里诚实的终态是「话说完了」，不是「条满了」。
 *
 * 门控 KHY_PROGRESS_PACED（default-on）：关 → 分母未知时逐字节回退到今日的静态文案，
 * 也不起重画定时器。`options.pacer === false` 可显式关掉（测试/嵌入式调用）。
 */

let _progressive = null;
try {
  _progressive = require('./progressiveProgress');
} catch {
  _progressive = null;
}

function createProgressRenderer(options = {}) {
  const isTTY = options.isTTY !== undefined ? !!options.isTTY : !!process.stdout.isTTY;
  const streamWidth = Math.max(40, Number(options.streamWidth) || Number(process.stdout.columns) || 80);
  const output = options.output || process.stdout;
  const clock = options.clock || (() => Date.now());
  const minIntervalMs = Math.max(0, Number(options.minIntervalMs) || 0);
  const env = options.env || process.env;
  let lastLine = '';
  let lastPhase = '';
  let lastAt = 0;
  let lastEvent = null;
  let pacer = null; // 不确定进度车道（分母未知）
  let detPacer = null; // 确定进度车道（分母已知）
  let ticker = null;

  // 门控：显式 options.pacer === false 一律关；否则跟着 KHY_PROGRESS_PACED 走。
  // 引擎不可用 / 门关 → 不介入（fail-soft：不确定就回退今日观感）。
  const pacedEnabled =
    options.pacer !== false &&
    !!_progressive &&
    (typeof _progressive.isPacedEnabled !== 'function' || _progressive.isPacedEnabled(env));

  function text(value) {
    return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ');
  }

  function reducedMotion() {
    return typeof _progressive.isReducedMotion === 'function' && _progressive.isReducedMotion(env);
  }

  /** 事件里的真实百分比（分母不成立 → 0）。 */
  function realPercentOf(event) {
    const completed = Number(event && event.completed);
    const total = Number(event && event.total);
    if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((completed * 100) / total)));
  }

  function isDeterminate(event) {
    const completed = Number(event && event.completed);
    const total = Number(event && event.total);
    return Number.isFinite(completed) && Number.isFinite(total) && total > 0;
  }

  /**
   * 惰性建节拍器。分母已知与未知是**两条车道**（目标不同：真实值 vs 天花板），各建一个、
   * 各归各用 —— 一条车道无法同时表达「追真实值」与「逼近天花板」。
   *
   * 已知分母若错走不确定车道，一个只下到 5% 的包会画出逼近 96% 的条 = **虚报进度**；
   * 未知分母若走确定车道，目标恒为 0 → 条**一动不动**（正是要消灭的观感）。
   */
  function ensurePacer(determinate) {
    if (!pacedEnabled) {
      return null;
    }
    if (determinate) {
      if (!detPacer) {
        try {
          detPacer = _progressive.createPacer({
            now: () => Number(clock()),
            determinate: true,
            static: reducedMotion(),
          });
        } catch {
          detPacer = null;
        }
      }
      return detPacer;
    }
    if (pacer) {
      return pacer;
    }
    try {
      pacer = _progressive.createPacer({
        now: () => Number(clock()),
        static: reducedMotion(),
      });
    } catch {
      pacer = null;
    }
    return pacer;
  }

  /** 本行此刻该显示的整数百分比（分母已知走确定车道，否则走不确定车道）。 */
  function shownPercent(event, determinate) {
    const own = determinate ? detPacer : pacer;
    if (!own) {
      return determinate ? realPercentOf(event) : 0;
    }
    return own.percent();
  }

  /**
   * 这条车道还需要重画吗（到了目标就没有东西可动，停表避免空转）。
   *
   * 判据直接交给引擎的 `settled()`（静态档恒真 / 确定进度追平真实值 / 不确定进度走到
   * `TAIL_CAP`，已完成则要走到 100）。**不能**用 `isFinished()` 早停：那一个问的是
   * 「显示值已到 100」，而收尾（`done && shown < 100`）正是需要继续重画的阶段 ——
   * 旧实现在这里停表，条就冻在 96% 然后由调用方一句「✓ 完成」跳过去，正是用户说的
   * 「卡在一个地方很久，然后突然加载完成」。
   */
  function laneSettled(determinate) {
    const own = determinate ? detPacer : pacer;
    if (!own) {
      return true;
    }
    return own.settled();
  }

  /** 分母未知时的重画节拍：只在 TTY 下挂（非 TTY 逐行打印不适合空转）。 */
  function ensureTicker() {
    if (ticker || !isTTY || !pacedEnabled || (!pacer && !detPacer)) {
      return;
    }
    const intervalMs = Number(_progressive && _progressive.RENDER_MS) || 160;
    ticker = setInterval(() => {
      try {
        if (!lastEvent) {
          return;
        }
        const determinate = isDeterminate(lastEvent);
        // 先取一次数（这一步就是「一帧最多 +1%」的推进），再判有没有东西可动。
        if (laneSettled(determinate)) {
          stopTicker();
          return;
        }
        drawLine(lastEvent);
      } catch {
        stopTicker();
      }
    }, intervalMs);
    if (ticker && typeof ticker.unref === 'function') {
      ticker.unref();
    }
  }

  function stopTicker() {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  /** 组装并写出这一行（不推进状态 —— 推进只发生在 percent()/laneSettled() 里）。 */
  function drawLine(event) {
    const action = text(event.action || '更新');
    const target = text(event.target || 'KhyOS');
    const phase = text(event.phase || '进行中');
    const completed = Number(event.completed);
    const total = Number(event.total);
    const determinate = isDeterminate(event);
    // 条宽与读数**同源**：都来自节拍器（分母已知时它 1% 1% 追真实值、永不越过）。
    // 条走节拍而读数走真实会自相矛盾（同一个 50% 里条画 8 格、读数写 50%），比粗粒度
    // 跳动更让人困惑。`50/100` 那一段仍是真实账本 —— 它不是进度条，是事实。
    const percent = shownPercent(event, determinate);
    const barWidth = Math.max(8, Math.min(20, Math.floor(streamWidth / 5)));
    const filled =
      _progressive && typeof _progressive.filledCells === 'function'
        ? _progressive.filledCells(percent, barWidth)
        : Math.round((barWidth * percent) / 100);
    const bar = isTTY ? `[${'#'.repeat(filled)}${'-'.repeat(barWidth - filled)}] ` : '';
    let quantified;
    if (determinate) {
      quantified = `${bar}${Math.max(0, completed)}/${total} ${percent}%`;
    } else {
      // 节拍条 + 百分比 + 描述词。描述词（调用方给的「第 1/3 阶段」或兜底「进行中」）
      // 仍然在，但它不再**独自**承担「进度」这个职责 —— 它说不了还剩多远，百分比能。
      const label = text(event.progress || '') || '进行中';
      const paced = (pacer || detPacer) ? `${bar}${percent}%` : '';
      quantified = paced ? `${paced} · ${label}` : label;
    }
    const rate =
      Number.isFinite(Number(event.rate)) && Number(event.rate) > 0
        ? ` ${Math.round(Number(event.rate) / 1024)}KiB/s`
        : '';
    const line = `${action} · ${target} · ${phase} · ${quantified}${rate}`;
    const clipped = line.length > streamWidth - 1 ? `${line.slice(0, streamWidth - 2)}…` : line;
    if (isTTY) {
      output.write(`\r${clipped.padEnd(Math.max(0, streamWidth - 1), ' ')}`);
    } else {
      output.write(`${clipped}\n`);
    }
    lastLine = clipped;
    return clipped;
  }

  function render(event = {}) {
    const phase = text(event.phase || '进行中');
    const completed = Number(event.completed);
    const total = Number(event.total);
    const determinate = isDeterminate(event);
    if (determinate) {
      // 真实值成为权威目标：显示值 1% 1% 地追，永不越过。
      const own = ensurePacer(true);
      if (own) {
        own.observe(realPercentOf(event));
      }
    } else {
      ensurePacer(false);
    }
    // 两条车道都要重画节拍 —— 分母已知若靠事件驱动，推进速度就取决于事件密度，
    // 稀疏事件下「一跳好几格」（正是用户否掉的观感）。
    ensureTicker();
    lastEvent = event;
    const now = Number(clock());
    if (
      !isTTY &&
      phase === lastPhase &&
      minIntervalMs > 0 &&
      now - lastAt < minIntervalMs &&
      !(Number.isFinite(completed) && Number.isFinite(total) && completed >= total)
    ) {
      return lastLine;
    }
    lastPhase = phase;
    lastAt = now;
    return drawLine(event);
  }

  function finish(event = {}) {
    // 收尾即停节拍 —— 行已终态，不该再被重画覆盖。
    // `pacer.finish()` 现在只把目标设成终态（不再直接把显示值赋成 100），所以这里**不**去
    // 补画那最后几帧：终态这一行的内容是一句状态话（`✓ 完成 · …`），不是一条 100% 的条。
    // 要补画就得让调用方多等几帧才看到「结束了」，而那正是用户否掉的另一种等待。
    stopTicker();
    if (pacer) {
      pacer.finish();
    }
    if (detPacer) {
      detPacer.finish();
    }
    const status = text(event.status || '完成');
    const message = text(event.message || '更新流程结束');
    const line = `${status} · ${message}`;
    if (isTTY) output.write(`\r${line.slice(0, streamWidth - 1).padEnd(Math.max(0, streamWidth - 1), ' ')}\n`);
    else output.write(`${line}\n`);
    lastLine = line;
    return line;
  }

  return {
    render,
    finish,
    /** 释放重画定时器（finish 已停；调用方提前放弃时用）。 */
    dispose: stopTicker,
    getLastLine: () => lastLine,
  };
}

module.exports = { createProgressRenderer };