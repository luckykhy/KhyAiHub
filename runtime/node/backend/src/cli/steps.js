/**
 * Step / Process Tracking — extracted from aiRenderer.js
 *
 * Contains: startSparkle, printStepLine, printStepDetail,
 *           ProcessTracker, printCompactingNotice,
 *           printProcessStep, printToolCall, printActionHint, printThinkingStep
 */
const { ccFormatDurationOr } = require('./ccFormat');
const { displayWidth, truncateToWidth } = require('./formatters');
const {
  c,
  THEME,
  isInteractiveInputActive,
  SPINNER_FRAMES,
  SPINNER_ACTIVE_CHAR,
  REDUCED_MOTION_DOT,
  PHASE_LABELS,
  _formatElapsed,
  DOT_INDICATOR,
  DOT_SUCCESS,
  DOT_ERROR,
  DOT_DONE,
  DOT_PENDING,
  TREE_LAST,
  TREE_MID,
  getToolDisplayName,
  getToolFamilyIcon,
} = require('./renderTheme');
const { isCoreToolDisplay } = require('./toolDisplayPolicy');

// core 工具的焦点锚点（[DESIGN-ARCH-073] §2.3）：▌ 加粗焦点行 > 头行 > ⎿ 结果行。
const FOCUS_ANCHOR = '▌';

const _sparkleTimers = new Set();

// 步骤行的宽度预算（与 aiRenderer.js 的 effectiveCols 口径一致）:长命令/长路径
// 会把行顶到终端软折行,折行后 '  ● ' / '  ⎿ ' 前缀丢掉,步骤树的缩进当场断裂。
function _stepBudget() {
  try {
    // 洋葱下沉：终端尺寸真源已归位到 utils/terminal/（通用能力，非视觉皮专属）。
    // 直连逻辑侧，切断「逻辑层 → 视觉皮」的倒挂边。
    return Math.max(24, require('../utils/terminal/effectiveCols').effectiveCols(80) - 6);
  } catch {
    return 74;
  }
}

// 尾部优先截断:路径截到只剩前缀目录没用,用户要认的是文件名那一段。
function _truncateTail(text, maxW) {
  if (maxW <= 0) {
    return '';
  }
  const chars = [...String(text)];
  let w = 0;
  let i = chars.length;
  while (i > 0 && w + displayWidth(chars[i - 1]) <= maxW - 1) {
    w += displayWidth(chars[i - 1]);
    i--;
  }
  return '…' + chars.slice(i).join('');
}

// 预算内适配:路径优先保尾部 —— 整段无空格(纯路径),或在 tailIfLastTokenPath
// 下最后一个词就是路径(「已写入 <路径>」这类结果行)时,用户要认的是文件名那一段;
// 其余(带参数的命令、说明句)按头部截断。
function _fitStepText(text, maxW, tailIfLastTokenPath = false) {
  const s = String(text == null ? '' : text);
  if (maxW <= 0) {
    return '';
  }
  if (displayWidth(s) <= maxW) {
    return s;
  }
  const hasSep = /[\\/]/.test(s);
  const lastWord = s.trim().split(/\s+/).pop() || '';
  const pathLike = hasSep && (!/\s/.test(s) || (tailIfLastTokenPath && /[\\/]/.test(lastWord)));
  return pathLike ? _truncateTail(s, maxW) : truncateToWidth(s, maxW);
}

// Ink TUI takeover switch: set to '1' in tui/app.jsx while Ink owns the
// terminal, deleted on exit. isTTY answers "are we rendering to a terminal";
// this answers "must the classic renderer yield to the TUI".
function _isInkTuiActive() {
  return process.env.KHY_INK_TUI_ACTIVE === '1';
}

/**
 * Start an animated spinner for tool call in-progress display.
 * Uses a blinking solid dot to match Claude Code active step indicator.
 *
 * @param {string} label - tool display name (e.g. "Bash", "Read")
 * @param {string} target - parameter string
 * @param {string} detail - extra detail
 * @returns {{ stop: Function }}
 */
function startSparkle(label, target = '', detail = '') {
  if (!process.stdout.isTTY) {
    return { stop() {} };
  }
  // When the Ink TUI owns the terminal it renders through its own loop, so the
  // classic sparkle must yield. isTTY above is the render precondition; the env
  // flag is the TUI-takeover switch (previously a self-contradicting isTTY).
  if (_isInkTuiActive()) {
    return { stop() {} };
  }

  let frame = 0;
  const startTime = Date.now();
  const ELAPSED_SHOW_THRESHOLD = 2; // show elapsed after 2s (Qwen Code style)
  const ELAPSED_WARN_THRESHOLD = 8; // shift to red after 8s

  const timer = setInterval(() => {
    if (isInteractiveInputActive()) {
      return;
    }
    if (process.stdin.isRaw) {
      return;
    }
    frame++;
    const blinkDim = frame % 2 === 0;
    const elapsed = (Date.now() - startTime) / 1000;

    // Color: normal -> red after 8s (gradual shift)
    let charColor;
    if (elapsed > ELAPSED_WARN_THRESHOLD) {
      const t = Math.min(1, (elapsed - ELAPSED_WARN_THRESHOLD) / 12);
      const r = Math.round(169 + (255 - 169) * t);
      const g = Math.round(169 + (107 - 169) * t);
      const b = Math.round(169 + (128 - 169) * t);
      charColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    } else {
      charColor = THEME.text;
    }
    const icon = blinkDim
      ? c().hex(charColor).dim(DOT_INDICATOR)
      : c().hex(charColor)(DOT_INDICATOR);
    const targetStr = target ? c().dim(`(${target})`) : '';
    const detailStr = detail ? c().dim(` ${detail}`) : '';

    // Elapsed time display (Qwen Code: >2s show, DeepSeek: "running (5s)")
    let elapsedStr = '';
    if (elapsed >= ELAPSED_SHOW_THRESHOLD) {
      const secs = Math.floor(elapsed);
      const elapsedText = _formatElapsed(secs);
      if (elapsed > ELAPSED_WARN_THRESHOLD) {
        elapsedStr = ` ${c().hex(THEME.error)(elapsedText)}`;
      } else {
        elapsedStr = ` ${c().dim(elapsedText)}`;
      }
    }

    const line = `  ${icon} ${c().bold(label)} ${targetStr}${detailStr}${elapsedStr}`;
    let _sw;
    try {
      _sw = require('./syncOutput').syncWrite;
    } catch {
      /* ignore */
    }
    if (typeof _sw !== 'function') {
      _sw = (fn) => fn();
    }
    _sw(() => process.stdout.write(`\r\x1b[K${line}`));
  }, 120); // 120ms = ~8fps matching Claude Code

  _sparkleTimers.add(timer);

  return {
    stop() {
      clearInterval(timer);
      _sparkleTimers.delete(timer);
      if (!isInteractiveInputActive()) {
        process.stdout.write('\r\x1b[K');
      }
    },
  };
}

/**
 * Print a single process step line (Claude Code style).
 * @param {'pending'|'active'|'success'|'error'|'done'} status
 * @param {string} label - e.g. "Read", "Bash", "Write", "Search", "Update"
 * @param {string} [target] - e.g. "src/cli/repl.js", "node -c ..."
 * @param {string} [detail] - e.g. "(ctrl+o to expand)", "-> OK"
 * @param {{ toolName?: string }} [opts] - 传 toolName 时按显示矩阵分级：core 工具在
 *   active 态把指示点换成 ▌ 焦点锚点；不传则保持旧渲染（逐字节兼容）。
 */
function printStepLine(status, label, target = '', detail = '', opts = {}) {
  if (!process.stdout.isTTY) {
    return;
  }
  if (_isInkTuiActive()) {
    return;
  }
  let dot;
  switch (status) {
    case 'active':
      dot = c().hex(THEME.text)(DOT_INDICATOR);
      break;
    case 'success':
      dot = c().hex(THEME.success)(DOT_SUCCESS);
      break;
    case 'error':
      dot = c().hex(THEME.error)(DOT_ERROR);
      break;
    case 'done':
      dot = c().dim(DOT_DONE);
      break;
    default:
      dot = c().dim(DOT_PENDING);
      break;
  }

  // core 工具（opts.toolName 命中显示矩阵 core 档）→ 指示点换成 ▌ 焦点锚点。
  // 仅 'active' 态强调（执行中的焦点行）；未传 toolName 的旧调用方逐字节回退。
  const _toolName = opts && typeof opts === 'object' ? opts.toolName : null;
  if (status === 'active' && _toolName && isCoreToolDisplay(_toolName)) {
    dot = c().hex(THEME.text).bold(FOCUS_ANCHOR);
  }

  const labelColor =
    status === 'success'
      ? c().hex(THEME.success)(label)
      : status === 'error'
        ? c().hex(THEME.error)(label)
        : status === 'active'
          ? c().hex(THEME.text).bold(label)
          : c().dim(label);

  // 按预算收缩 target/detail,整行不超一屏(折行会吃掉 '  ● ' 前缀,步骤树缩进断裂)。
  const restBudget = Math.max(
    0,
    _stepBudget() - 2 - displayWidth(dot) - 1 - displayWidth(label) - 1
  );
  const targetFit = target
    ? _fitStepText(target, Math.max(6, restBudget - 2 - (detail ? 1 : 0)))
    : '';
  const usedByTarget = targetFit ? displayWidth(targetFit) + 2 : 0;
  const detailFit = detail
    ? _fitStepText(detail, Math.max(4, restBudget - usedByTarget - 1))
    : '';
  const targetStr = targetFit ? c().dim(`(${targetFit})`) : '';
  const detailStr = detailFit ? ` ${detailFit}` : '';

  console.log(`  ${dot} ${labelColor} ${targetStr}${detailStr}`);
}

/**
 * Print an indented detail line with tree branch character.
 * @param {string} text - detail text
 * @param {boolean} [isLast=true] - whether this is the last detail line
 */
function printStepDetail(text, isLast = true) {
  if (!process.stdout.isTTY) {
    return;
  }
  if (_isInkTuiActive()) {
    return;
  }
  // Claude Code style: ⎿ prefix for result detail lines
  const branch = isLast ? TREE_LAST : TREE_MID;
  // 长路径同样按预算收缩(保尾部),否则折行会丢掉 '  ⎿ ' 前缀。
  const fitted = _fitStepText(text, Math.max(4, _stepBudget() - 5), true);
  console.log(`  ${c().dim(branch)}  ${fitted}`);
}

/**
 * ProcessTracker — manages a sequence of process steps with live updates.
 *
 * Usage:
 *   const tracker = new ProcessTracker();
 *   tracker.start('Reading', 'src/cli/repl.js', '1 file...');
 *   // ... do work ...
 *   tracker.complete('Read 245 lines');
 *   tracker.start('Write', 'src/cli/ai.js');
 *   // ... do work ...
 *   tracker.complete('Added 3 lines');
 */
class ProcessTracker {
  constructor() {
    this._current = null;
    this._startTime = null;
    this._sparkle = null;
  }

  /**
   * Start a new step. Completes any previous in-progress step first.
   * @param {string} label - e.g. "Reading", "Write", "Bash", "AI thinking"
   * @param {string} [target] - e.g. file path, command, etc.
   * @param {string} [hint] - e.g. "1 file...", "ctrl+o to expand"
   */
  start(label, target = '', hint = '') {
    // Auto-complete previous step if still active
    if (this._current) {
      this._finishCurrent('done');
    }
    this._current = { label, target, hint };
    this._startTime = Date.now();

    // Print the initial static line, then overlay sparkle animation
    printStepLine('active', label, target, hint);
    this._sparkle = startSparkle(label, target, hint);

    // Sync to HUD
    try {
      require('./hudRenderer').toolStart(label, target);
    } catch {}
  }

  /**
   * Complete the current step — shows gray dot (finished, no longer active).
   * @param {string} [detail] - completion detail shown on tree line
   */
  complete(detail = '') {
    this._finishCurrent('done', detail);
  }

  /**
   * Mark the current step as failed.
   * @param {string} [detail] - error detail shown on tree line
   */
  fail(detail = '') {
    this._finishCurrent('error', detail);
  }

  /**
   * Internal: overwrite current active line with final status + detail.
   */
  _finishCurrent(status, detail = '') {
    if (!this._current) {
      return;
    }
    // Ink TUI active → it renders the line itself; stop sparkle, skip stdout.
    if (_isInkTuiActive()) {
      if (this._sparkle) {
        this._sparkle.stop();
        this._sparkle = null;
      }
      try {
        require('./hudRenderer').toolEnd(this._current.label, status, Date.now() - this._startTime);
      } catch {}
      this._current = null;
      this._startTime = null;
      return;
    }

    // Stop sparkle animation
    if (this._sparkle) {
      this._sparkle.stop();
      this._sparkle = null;
    }

    const elapsed = Date.now() - this._startTime;
    const elapsedStr =
      elapsed > 1000
        ? ` (${ccFormatDurationOr(elapsed, `${(elapsed / 1000).toFixed(1)}s`, process.env)})`
        : '';

    // Sync to HUD
    try {
      require('./hudRenderer').toolEnd(this._current.label, status, elapsed);
    } catch {}

    if (process.stdout.isTTY && !isInteractiveInputActive()) {
      let _sw;
      try {
        _sw = require('./syncOutput').syncWrite;
      } catch {
        /* ignore */
      }
      if (typeof _sw !== 'function') {
        _sw = (fn) => fn();
      }
      _sw(() => {
        process.stdout.write('\x1b[1A\r\x1b[K');
        const { label, target } = this._current;
        printStepLine(status, label, target, elapsedStr);
      });
    } else if (process.stdout.isTTY) {
      // Keep output stable while user is typing a busy-time interjection.
      const { label, target } = this._current;
      printStepLine(status, label, target, elapsedStr);
    }
    // On non-TTY, skip rewrite — the active line stays as-is (no double output)

    if (detail) {
      printStepDetail(detail);
    }

    this._current = null;
    this._startTime = null;
  }

  /**
   * Whether a step is currently in progress.
   */
  get isActive() {
    return this._current !== null;
  }
}

// ── Context Compaction Notice ──────────────────────────────────────────

/**
 * Print a "Compacting conversation..." notice (Claude Code style).
 * @param {object} opts - { elapsed, tokens, thought }
 */
function printCompactingNotice(opts = {}) {
  if (!process.stdout.isTTY) {
    return;
  }
  if (_isInkTuiActive()) {
    return;
  }
  const parts = [];
  if (opts.elapsed) {
    parts.push(`耗时 ${opts.elapsed}`);
  }
  if (opts.tokens) {
    parts.push(`\u2191 ${opts.tokens} tokens`);
  }
  if (opts.thought) {
    parts.push(`思考 ${opts.thought}`);
  }

  const meta = parts.length > 0 ? c().dim(` (${parts.join(' \u00B7 ')})`) : '';
  // Claude Code style: ✻ + 中文一句话(feature 文案已全中文,这里原来漏了)
  console.log(
    `  ${c().hex(THEME.warning)('\u273B')} ${c().hex(THEME.warning).bold('会话已压缩')}${meta}`
  );

  if (opts.tip) {
    printStepDetail(`提示: ${opts.tip}`);
  }
}

// ── Legacy helpers (preserved for backward compatibility) ──────────────

function printProcessStep(icon, message, detail = '') {
  if (!process.stdout.isTTY) {
    return;
  }
  if (_isInkTuiActive()) {
    return;
  }
  const detailStr = detail ? c().dim(` (${detail})`) : '';
  console.log(`  ${icon} ${c().white(message)}${detailStr}`);
}

function printToolCall(toolName, args = '') {
  if (!process.stdout.isTTY) {
    return;
  }
  if (_isInkTuiActive()) {
    return;
  }
  const displayName = getToolDisplayName(toolName);
  const icon = getToolFamilyIcon(toolName);
  const targetStr = args ? c().dim(`(${args})`) : '';
  console.log(
    `  ${c().hex(THEME.text)(icon)} ${c().hex(THEME.text).bold(displayName)} ${targetStr}`
  );
}

/**
 * Print a brief description line before an action (Claude Code style).
 * Shows a dim one-liner explaining what will be done next.
 * @param {string} description - e.g. "Updating the spinner icon to use ..."
 */
function printActionHint(description) {
  if (!process.stdout.isTTY) {
    return;
  }
  if (_isInkTuiActive()) {
    return;
  }
  console.log(c().dim(`  ${description}`));
}

function printThinkingStep(thought) {
  if (!process.stdout.isTTY) {
    return;
  }
  if (_isInkTuiActive()) {
    return;
  }
  const truncated = truncateToWidth(thought, 80);
  console.log(`  ${c().dim(DOT_DONE)} ${c().dim(truncated)}`);
}

module.exports = {
  startSparkle,
  printStepLine,
  printStepDetail,
  ProcessTracker,
  printCompactingNotice,
  printProcessStep,
  printToolCall,
  printActionHint,
  printThinkingStep,
};
