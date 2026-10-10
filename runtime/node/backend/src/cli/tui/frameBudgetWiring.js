'use strict';

/**
 * 帧预算守卫接线（[DESIGN-ARCH-176] P4，2026-10-03）—— 从 tui/app.js 抽出。
 *
 * 这里修的是一个「看起来对、其实从未生效」，而且踩中 ink 一处**实例复用陷阱**的接缝：
 *
 *   `frameBudget.js` 写得完整、有单测、有棘轮设计，注释甚至写着「app.js feeds
 *   that into record() here」—— 但全仓 **零 require**。ink 每帧都报的
 *   `onRender({renderTime})` 从来没人接，「渲染帧超预算」这件事从未被观测过。
 *   用户报「卡死不动只能结束进程」时，仓库里拿不出任何帧耗时数据来定位。
 *
 *   而「接上」这件事本身还有个坑：ink 的 `instances` WeakMap **按 stdout 复用实例**
 *   （node_modules/ink/build/render.js:55 `getInstance`）。BootScreen 那次 `render()`
 *   用**同一个 _tuiStdout** 先建了实例；第二次 `render(App, {onRender})` 命中同一实例
 *   → ink 只替换根元素，**整个 inkOptions 被丢弃**。于是 onRender 传了也永不触发
 *   （实测：boot 完成时 diagFrame 行数 = 0，且最初那版把守卫只挂在第二次 render 上
 *   —— 必须挪到第一次）。
 *
 *   故调用方（app.js）**两次 render 都要展开**同一份返回值；boot screen 被门控关掉时
 *   第一次不存在，第二次就是第一次 —— 两条路都覆盖。
 *
 * 契约：叶子模块、绝不抛错；record() 是 O(1) 入环，不引入新热路径。任何异常 →
 * 返回 `{}`（调用方 render 不传 onRender，逐字节回退旧行为）。
 *
 * env `KHY_TUI_DIAG_FRAME=N`：每 N 帧往 stderr 打一行滚动统计（与既有 KHY_TUI_DIAG /
 * KHY_TUI_DIAG_H 同族，默认关、不参与行为分支）。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{onRender?: (e: {renderTime: number}) => void}}
 */
function buildInkRenderOpts(env) {
  const e = env || {};
  try {
    const guard = _createGuard(e);
    if (!guard) return {};
    // counter 必须建在闭包外：每帧新建会让 frames 恒为 1，诊断频次闸永不触发。
    const counter = { frames: 0 };
    const diagEvery = _diagEvery(e);
    return { onRender: (ev) => _recordFrame(guard, ev, diagEvery, counter) };
  } catch {
    // 叶子不可用 → 逐字节回退今日行为（render 不传 onRender）
    return {};
  }
}

/** 建守卫（预算来自 perfTunables 单一真源，告警走 stderr）。 */
function _createGuard(e) {
  const _perf = require('./perfTunables');
  const _fb = require('./frameBudget');
  return _fb.createGuard({
    budgetMs: _perf.frameBudgetMs(e),
    sink: { warn: (msg) => _writeStderr(msg) },
  });
}

/**
 * 单帧回调的实现。单独成函数是为了让逐帧热路径的缩进停在棘轮线内（COMP-001 嵌套），
 * 语义与原先内联在 app.js IIFE 里的实现逐行一致。
 */
function _recordFrame(guard, ev, diagEvery, counter) {
  const rt = ev && Number.isFinite(Number(ev.renderTime)) ? Number(ev.renderTime) : null;
  if (rt == null) return;
  guard.record(rt);
  if (diagEvery > 0) {
    counter.frames += 1;
    if (counter.frames % diagEvery === 0) _writeDiagFrame(guard);
  }
  guard.maybeWarn();
}

/** 诊断频次闸：只有显式开了 KHY_TUI_DIAG_FRAME 才计数/打印，默认零开销。 */
function _diagEvery(e) {
  const raw = String(e.KHY_TUI_DIAG_FRAME || '').trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 滚动统计行（纯诊断，写失败静默）。 */
function _writeDiagFrame(guard) {
  const s = guard.stats();
  _writeStderr(
    `[diagFrame] frames=${s.count} p50=${s.p50.toFixed(1)}ms p95=${s.p95.toFixed(1)}ms ` +
      `p99=${s.p99.toFixed(1)}ms max=${s.max.toFixed(1)}ms budget=${s.budgetMs}ms ` +
      `over=${s.overBudget ? 'YES' : 'no'}`
  );
}

/** stderr 写入（不可写 → 静默，诊断/告警都走这里）。 */
function _writeStderr(msg) {
  try {
    process.stderr.write(`${msg}\n`);
  } catch {
    /* stderr 不可写 → 静默 */
  }
}

module.exports = { buildInkRenderOpts };
