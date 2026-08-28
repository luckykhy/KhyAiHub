'use strict';

/**
 * bootPhaseLine.js — 启动引导阶段的「瞬时进度行」。
 *
 * 修的问题:引导进度用 `\r` 反复覆写同一行(`  ⏳ 加载环境配置...`),行尾不带换行,
 * 于是光标始终停在这一行的中间。启动路径上别处的输出 —— ensureAuthenticated 的
 * 「ℹ 已登录」、_scheduleStartupUpdateCheck 的版本通知、bootstrap 各步骤的 ⚠ 警告 ——
 * 都会从那个位置继续写,把进度行和通知糊成一行。实测捕获:
 *   `  🔄 准备运行环境 ...  ℹ 已登录: mfplg075`
 * 进度行本该是瞬时的、用完即抹,却因此变成一条永久残留的半截行。
 *
 * 做法:进度行「点亮」期间接管 console.log/info/warn/error,在真正输出之前先
 * `\r\x1b[K` 擦掉整行、把光标让回行首;擦完即标记熄灭,直到下一次 write() 重新点亮。
 *
 * 光包 console.* 不够:winston 的 Console transport 走 `console._stdout.write`,inquirer 走
 * readline/stdout,两者都绕开 console.*。所以进度行亮着的这段时间里同时给
 * process.stdout.write 挂一层让位 —— 但只挂这一小段:第一笔写入让完位就立刻把这条最热的
 * 路径还原,进度行熄灭 / end() 也各自还原一次,绝不让包装层活到 TUI 稳态。
 *
 * 与 promptOutputGuard 的关系:那一个管「提问期间把 console 输出暂存后补发」,这一个管
 * 「输出落地前先让出瞬时行」。二者都靠包装 console.* 生效,且都在 finally/end() 里还原
 * 自己那一层;本模块在 main() 最开头装、提问闸门在提问期间装,天然内外嵌套,不冲突。
 *
 * 门控 KHY_BOOT_PHASE_LINE(默认开;仅 0/false/off/no 关)。关 → create() 返回空实现,
 * 逐字节回退到「不显示引导进度行」的行为。
 * 失败软化:stderr 不可写、console 被别处换过等情况一律吞掉 —— 引导本身永远优先。
 *
 * 三种行形态(按传入参数择一):
 *   write(text, step, totalSteps)   → `text (1/5)`        调用方控制步进节奏,静态
 *   write(text, 0, 0, percentSrc)   → `text ████░░ 42%`   按 PERCENT_TICK_MS 实时重画
 *   write(text)                     → `text (已等待 Xs)`  每 1s 刷新 elapsed
 *
 * 为什么第三种形态**不**补一条渐进条(2026-09-24「所有进度条都要渐进加载」时的判断):
 * 它现在只被 sub-second 的引导拍使用(khy.js 的 5 步引导实测 0.37s 走完),给它画一条
 * 恒停在 0% 的条反而**更像卡死**;而启动最长的窗口(ink 装载 + 首帧)由第二种形态的
 * 实时百分比源覆盖,那一条本来就是按真实时间平滑推进的曲线。所以这里保持原样 ——
 * 只把**画条的算法**收敛到单一真源(progressiveProgress.renderBar),不新增条。
 * 第三种是历史行为,逐字节保持不变。
 *
 * 另见 openBootWindow(label):把上面第二种形态封装成「ink 装载窗口」的一站式句柄
 * (见其文档),让调用方(replSession)只需一行接线。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 需要让位的 console 方法。绕开 console 的直写(winston / inquirer)另由 stdout 让位层兜住。
const METHODS = ['log', 'info', 'warn', 'error'];

// 擦除整行并把光标收回行首。CSI K 只清光标到行尾,配合 \r 才是「整行清空」。
const CLEAR_LINE = '\r\x1b[K';

// 实时百分比模式下的刷新间隔。1000ms 是「已等待 Xs」时钟的节拍,对百分比太粗 ——
// 用户要的是「进度在动」,所以有百分比源时改用 250ms 重画(仍是同一行的 \r 覆写,零闪烁)。
const PERCENT_TICK_MS = 250;

// 百分比条宽。与 ink 侧 ProgressBar 的 BAR_WIDTH 同值同字形,让 pre-Ink 行与启动屏
// 视觉连续。这里不复用 ProgressBar 是因为它是 ink 组件(需要 react + inkRuntime),
// 而本模块跑在 Ink 挂载**之前**,那时 ink 还没装载。
// 条的**画法**则复用单一真源(progressiveProgress.renderBar),宽度与字形在这儿定。
const PERCENT_BAR_WIDTH = 20;

// 渐进节拍引擎（条的唯一画法真源）。fail-soft require：本模块跑在启动最早期，
// 任何加载异常都不得拖垮引导 —— 引擎不可用就退回本地那份等价实现。
let _progressive = null;
try {
  _progressive = require('../services/progressiveProgress');
} catch {
  _progressive = null;
}

function _renderPercentBar(pct) {
  if (_progressive && typeof _progressive.renderBar === 'function') {
    return _progressive.renderBar(pct, PERCENT_BAR_WIDTH);
  }
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * PERCENT_BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(PERCENT_BAR_WIDTH - filled);
}

/**
 * 进度行是否启用。默认开;仅显式 0/false/off/no 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_BOOT_PHASE_LINE;
    if (raw === undefined || raw === null) {
      return true;
    }
    return !OFF_VALUES.includes(String(raw).trim().toLowerCase());
  } catch {
    return true;
  }
}

/**
 * 门控关闭时的空实现:两个方法都存在,调用方无需分支判断。
 * @returns {{write: function(string): void, end: function(): void}}
 */
function _noopHandle() {
  return { write() {}, end() {} };
}

// 格式化已等待毫秒 → 人类可读:「320ms」「3.2s」「1m 04s」。
function _elapsedMsToStr(ms) {
  const v = Math.max(0, ms | 0);
  if (v < 1000) return `${v}ms`;
  const s = v / 1000;
  if (s < 60) return `${s.toFixed(1).replace(/\.0$/, '')}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s - m * 60);
  return `${m}m ${String(rs).padStart(2, '0')}s`;
}

/**
 * 创建一条瞬时进度行,并在其存活期间接管 console.*。
 *
 * 每次 write(text[, totalSteps]) 点亮后,若未传 totalSteps,则启动 1s 间隔的
 * elapsed 时钟(显示「已等待 Xs」);传 totalSteps(整数 > 0)时改用步骤分母
 * 显示「text 2/5」,并停止 elapsed 时钟(由调用方控制步进节奏)。
 *
 * @param {object} [options]
 * @param {object} [options.env] - 门控环境(测试注入)
 * @param {{write: function(string): *}} [options.stream] - 进度行输出流,默认 process.stderr
 * @param {object} [options.console] - 被接管的 console 对象(测试注入)
 * @param {{write: function(string): *}} [options.stdout] - 被让位的 stdout,默认 process.stdout
 * @returns {{write: function(string, [number]): void, end: function(): void}}
 *   write(text, totalSteps?) 覆写进度行;end() 擦掉进度行并还原所有接管。两者均可重复调用。
 */
function create(options = {}) {
  const env = options.env || process.env;
  if (!isEnabled(env)) {
    return _noopHandle();
  }

  const stream = options.stream || process.stderr;
  const sink = options.console || console;
  const out = options.stdout || process.stdout;

  let live = false;
  let ended = false;
  let stdoutPatch = null;
  let phaseStartHr = 0;
  let elapsedTimer = null;
  let lastText = '';
  let lastStep = 0;
  let lastTotalSteps = 0;
  let lastPercentSource = null;

  /**
   * 读一次百分比源。源由调用方注入（通常是 startupBeats 的实时百分比）。
   * 它抛异常 / 返回非法值一律当作「没有百分比」，逐字节回退到「已等待 Xs」文案 ——
   * 一行显示绝不能拖垮启动。
   */
  const readPercent = () => {
    if (!lastPercentSource) {
      return undefined;
    }
    try {
      const v = Number(lastPercentSource());
      return Number.isFinite(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };

  const unpatchStdout = () => {
    if (!stdoutPatch) {
      return;
    }
    const { target, original } = stdoutPatch;
    stdoutPatch = null;
    try {
      target.write = original;
    } catch {
      /* 还原不了也不能抛 */
    }
  };

  const stopElapsedTimer = () => {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  };

  // 渲染一行进度:
  //   有 step/totalSteps  →  `text (step/total)`
  //   有实时百分比        →  `text ████░░░░ 42%`
  //   都没有              →  `text` 或 `text (已等待 Xs)`
  const _renderLine = (text, step, totalSteps, elapsedMs, pct) => {
    let display = text;
    const hasStep = Number.isInteger(totalSteps) && totalSteps > 0 && Number.isInteger(step) && step > 0;
    if (hasStep) {
      display = `${text} (${step}/${totalSteps})`;
    } else if (typeof pct === 'number') {
      const rounded = Math.max(0, Math.min(100, Math.round(pct)));
      display = `${text} ${_renderPercentBar(rounded)} ${rounded}%`;
    }
    const suffix = hasStep ? '' : elapsedMs > 0 ? ` (已等待 ${_elapsedMsToStr(elapsedMs)})` : '';
    return `\r  ${display}${suffix}...\x1b[K`;
  };

  const clear = () => {
    unpatchStdout();
    stopElapsedTimer();
    if (!live) {
      return;
    }
    live = false;
    try {
      stream.write(CLEAR_LINE);
    } catch {
      /* 终端可能已关闭 */
    }
  };

  const patchStdout = () => {
    if (stdoutPatch || !out || typeof out.write !== 'function') {
      return;
    }
    const original = out.write;
    stdoutPatch = { target: out, original };
    out.write = (...args) => {
      clear();
      return original.apply(out, args);
    };
  };

  const original = {};
  for (const m of METHODS) {
    const prev = sink[m];
    if (typeof prev !== 'function') {
      continue;
    }
    original[m] = prev;
    sink[m] = (...args) => {
      clear();
      return prev.apply(sink, args);
    };
  }

  return {
    /**
     * 覆写进度行。
     * @param {string} text - 阶段文本
     * @param {number} [step] - 当前步骤号(1-based)
     * @param {number} [totalSteps] - 总步骤数;step+totalSteps 同时传时显示「(step/total)」,
     *   否则(仅 text)显示已等待 elapsed 时钟(≥1s 后开始)
     * @param {function} [percentSource] - 实时百分比源(返回 0..100 的数字)。给了它,
     *   行内会显示 `████░░ 42%`,并按 PERCENT_TICK_MS 重画(而不是 1s 的 elapsed 时钟)——
     *   这是「进度必须实时显示」的落点:启动最耗时的一段(ink 装载)发生在本模块的
     *   可见窗口内,启动屏此时还挂不出来(它依赖 ink)。
     */
    write(text, step, totalSteps, percentSource) {
      if (ended) {
        return;
      }
      stopElapsedTimer();
      lastText = text;
      lastStep = Number.isInteger(step) ? step : 0;
      lastTotalSteps = Number.isInteger(totalSteps) ? totalSteps : 0;
      lastPercentSource = typeof percentSource === 'function' ? percentSource : null;
      phaseStartHr = process.hrtime.bigint();
      try {
        stream.write(_renderLine(text, lastStep, lastTotalSteps, 0, readPercent()));
        live = true;
        // 有步骤分母时保持静态(由调用方控制步进节奏);否则按 tick 刷新
        // (有百分比源 → 250ms,只有 elapsed 时钟 → 1000ms)
        if (!lastTotalSteps) {
          elapsedTimer = setInterval(() => {
            if (!live || ended) {
              stopElapsedTimer();
              return;
            }
            try {
              const ms = Number(process.hrtime.bigint() - phaseStartHr) / 1e6;
              stream.write(_renderLine(lastText, 0, 0, ms, readPercent()));
            } catch {
              /* stderr 不可写 */
            }
          }, lastPercentSource ? PERCENT_TICK_MS : 1000);
          if (elapsedTimer.unref) {
            elapsedTimer.unref();
          }
        }
      } catch {
        /* stderr 不可写时静默 */
        return;
      }
      patchStdout();
    },
    end() {
      if (ended) {
        return;
      }
      ended = true;
      stopElapsedTimer();
      clear();
      for (const m of METHODS) {
        if (typeof original[m] === 'function') {
          sink[m] = original[m];
        }
      }
    },
  };
}

/**
 * 「Ink 装载窗口」的一站式进度行 —— 覆盖 ink 装载 → 界面初始化这段 Ink 之前的窗口。
 *
 * 为什么需要它(实测数据,Windows 真实 PTY):bin/khy.js 的 5 步引导行在 **0.37s** 就走完
 * 并 end() 了,而整个启动有 30s+。剩下最长的两段是 **ink 渲染引擎装载(11.5s)** 与
 * **App 首帧渲染(11s)**,两者都跑在 Ink 挂载**之前** —— 启动屏(BootScreen 依赖 ink)
 * 结构上不可能显示它们。历史观感因此是:0.4s 之后全黑 ~25s,启动屏一出场就是
 * 4/6 = 67% 并冻住。
 *
 * 做法:用本模块(pre-Ink 渲染器)显示**同一条实时百分比曲线**
 * (startupBeats.progress().percent —— 以真实拍为硬锚、按真实时间平滑推进),
 * 交棒给 Ink 时 close()。于是「0% → 100%」在整条启动路径上是一条连续的线,
 * 启动屏接手时接的是同一个数,不再跳变。
 *
 * 失败软化:返回的句柄**恒非 null**且两个方法**永不抛** —— 一行显示绝不能拖垮启动。
 * 调用方因此无需 try/catch,也无需分支判断(门关时得到的是空操作句柄)。
 *
 * @param {string} label 首帧文案(如 '⏳ 加载渲染引擎')
 * @param {object} [env] 门控环境
 * @param {object} [options] 透传给 create() 的注入点(stream/console/stdout),供测试用
 * @returns {{phase: function(string): void, close: function(): void}}
 */
function openBootWindow(label, env = process.env, options = {}) {
  const noop = { phase() {}, close() {} };
  try {
    if (!isEnabled(env)) {
      return noop;
    }
    const beats = require('./startupBeats').beats;
    // 百分比源必须**每次都带上**。少带一次,行就会退回「已等待 Xs」的 elapsed 时钟 ——
    // 条形消失、秒表从头开始,用户看到的是「进度断了一下」。同一个源复用同一个闭包即可。
    const percentSource = () => beats.progress().percent;
    const handle = create({ ...options, env });
    handle.write(label, 0, 0, percentSource);
    return {
      phase(text) {
        try {
          handle.write(text, 0, 0, percentSource);
        } catch {
          /* 辅助显示,绝不抛 */
        }
      },
      close() {
        try {
          handle.end();
        } catch {
          /* 终端可能已关闭 */
        }
      },
    };
  } catch {
    return noop;
  }
}

module.exports = {
  create,
  openBootWindow,
  isEnabled,
  _elapsedMsToStr, // export for tests
  _renderPercentBar, // export for tests
  METHODS,
  OFF_VALUES,
  CLEAR_LINE,
  PERCENT_TICK_MS,
  PERCENT_BAR_WIDTH,
};
