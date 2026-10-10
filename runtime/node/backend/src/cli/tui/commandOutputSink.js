'use strict';

/**
 * commandOutputSink — 斜杠命令执行期的 stdout 收集叶（2026-10-10）。
 *
 * 病史（用户报「/ 命令除了 /model 都是一闪即过」）：`App.runRouted` 原来
 * `setInputActive(false)` + suspend topicBar/sidebarRail + `app.clear()`，把
 * 整块屏幕让给 handler 直接往终端打。两条路都取死：
 *   ① ink 的 patchConsole 拦住每一次 console.log → `writeToStdout` →
 *      `log.clear` + 写行 + `restoreLastOutput`（整帧重画）：一行输出要花约
 *      5 个屏幕行。/help 的百行输出 ≈ 300 行，30 行终端瞬间滚光；
 *   ② 命令收尾后那一帧以换行收尾，屏幕整体上滚 2 行，把输出顶出视口；TUI 跑在
 *      备用缓冲区（`KHY_ALT_SCREEN` 默认开）里，滚出去即永久消失，无回滚可翻。
 * /model 从来不受影响：它走原生 ModelPicker 覆盖层，根本不往终端打。
 *
 * 修法与仓内既有范式同源（`tuiCommandReports.dispatchNativeCommand`：/cost、
 * /usage、/stats、/scan… 收行 → `role:'notice'` → transcript）：命令执行期间
 * 收编 console 与直接 stdout 写，跑完作为一条 notice 落进 transcript —— 它在
 * 会话里可滚可翻，不随帧重画消失。
 *
 * 两条硬边界：
 *   - **ink 自己的帧必须原样透传**。ink 经 `tui/app.js` 的 stdout Proxy 写屏，
 *     Proxy 末尾是 `target.write(...)`（target = process.stdout）。故 Proxy 在
 *     代写期间经 `runInkWrite` 置位本叶的闸；闸开着 → 透传，否则整帧会被收进
 *     buffer，屏幕直接冻住。
 *   - **绝不抛**。任何一步失败都退化成「不收集」，命令行为逐字节回退今天。
 *
 * 门控 `KHY_TUI_COMMAND_CAPTURE` 默认开；显式 0/false/off/no →
 * `captureEnabled` 为假，调用方不走收集路径（逐字节回退让出终端的旧行为）。
 */

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控判定。默认开，仅显式 0/false/off/no 关闭。 */
function captureEnabled(env = process.env) {
  const raw = env && env.KHY_TUI_COMMAND_CAPTURE;
  return !(raw !== undefined && _OFF.has(String(raw).trim().toLowerCase()));
}

// ── ink 帧透传闸 ───────────────────────────────────────────────────────────
// 计数器而非布尔：Proxy 的写是同步单层的，计数器只为嵌套/重入留余量。
let _inkWriteDepth = 0;

/** 当前是否正处于 ink 的代写窗口（调用方只读，不直接置位）。 */
function isInkWrite() {
  return _inkWriteDepth > 0;
}

/** 在「ink 正在写帧」窗口内执行 fn（app.js 的 stdout Proxy 用）。 */
function runInkWrite(fn) {
  _inkWriteDepth += 1;
  try {
    return fn();
  } finally {
    _inkWriteDepth -= 1;
  }
}

/**
 * 建一个收集器：patch console 四件套 + process.stdout.write。
 * @param {object} [deps] 测试注入：{ gate, stripAnsi, stdout }
 * @returns {{restore: function(): void, text: function(): string, isLive: function(): boolean}}
 */
function createSink(deps = {}) {
  const gate = deps.gate || { isInkWrite, runInkWrite };
  let strip = deps.stripAnsi;
  if (typeof strip !== 'function') {
    try {
      strip = require('../../utils/stripAnsi');
    } catch {
      strip = (s) => String(s == null ? '' : s);
    }
  }
  const stdout = deps.stdout || process.stdout;

  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    write: stdout.write,
  };
  const parts = [];
  let live = true;

  const push = (s) => {
    if (!live) return;
    try {
      parts.push(String(s == null ? '' : s));
    } catch {
      /* 收集绝不抛 */
    }
  };
  const collect = (...args) => {
    let line = '';
    for (const a of args) {
      line += (line ? ' ' : '') + (typeof a === 'string' ? a : String(a));
    }
    push(line);
  };

  // formatters 的 printInfo / printWarn / printError / printSuccess /
  // printTable / printHelp 全走 console.log —— 命令输出的主干。
  console.log = collect;
  console.info = collect;
  console.warn = collect;
  console.error = collect;

  // 直接 stdout 写：backup / arena / doctor / update… 一批 handler 用
  // process.stdout.write。ink 的帧走 Proxy 代写（闸开）→ 原样透传。
  stdout.write = function sinkWrite(chunk, enc, cb) {
    if (gate.isInkWrite()) {
      return orig.write.call(stdout, chunk, enc, cb);
    }
    try {
      push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk == null ? '' : chunk));
    } catch {
      /* 收集绝不抛 */
    }
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };

  function restore() {
    if (!live) return;
    live = false;
    console.log = orig.log;
    console.info = orig.info;
    console.warn = orig.warn;
    console.error = orig.error;
    stdout.write = orig.write;
  }

  /** 收成的净文本：剥 ANSI/OSC、去行尾空白、去首尾空行；空 → ''。 */
  function text() {
    const raw = parts.join('');
    if (!raw) return '';
    let lines;
    try {
      lines = raw.split('\n').map((ln) => strip(ln).replace(/\r/g, '').replace(/\s+$/, ''));
    } catch {
      lines = raw.split('\n');
    }
    while (lines.length && lines[0].trim() === '') lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.join('\n').trim();
  }

  return { restore, text, isLive: () => live };
}

module.exports = { captureEnabled, isInkWrite, runInkWrite, createSink };
