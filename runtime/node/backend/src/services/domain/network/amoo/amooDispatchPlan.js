'use strict';

/**
 * amooDispatchPlan.js — pure leaf: the ordered plan for one "send a task to Amoo
 * and read the answer back" run, plus the waiting strategy.
 *
 * WHY a plan object instead of an imperative runner: an actuation on the user's
 * phone must be reviewable BEFORE it happens. The runner renders this plan when
 * `confirm` is missing, so the caller sees exactly which adb commands would run
 * and can assert the whole shape with no device attached.
 *
 * The waiting strategy is the part that has to be boring and honest:
 *   - poll on a capped schedule (never a flat tight loop that burns the phone),
 *   - stop on a stability rule (chat text byte-identical N rounds in a row),
 *   - stop on a wall-clock deadline and a round cap, whichever comes first,
 *   - always report WHICH stop condition fired.
 *
 * Text routing: `adb shell input text` cannot inject CJK, so any text outside
 * ASCII goes through the bridge clipboard + KEYCODE_PASTE. This is the only
 * verified CJK route on this device (`cmd clipboard` is unimplemented,
 * `service call clipboard` is version-fragile, no ADBIME is installed).
 *
 * Contract: zero IO, deterministic, never throws.
 *
 * @module services/domain/network/amoo/amooDispatchPlan
 */

const NON_ASCII_RE = /[^\x20-\x7E\t\r\n]/;

/**
 * Pick the text-entry route for a payload.
 * @param {string} text
 * @returns {{route:'clipboard'|'adb-input-text', reason:string}}
 */
function chooseInputRoute(text) {
  const value = typeof text === 'string' ? text : '';
  if (!value.trim()) {
    return { route: 'adb-input-text', reason: 'payload_empty' };
  }
  if (NON_ASCII_RE.test(value)) {
    return { route: 'clipboard', reason: 'payload_has_non_ascii' };
  }
  return { route: 'adb-input-text', reason: 'payload_is_ascii' };
}

/**
 * Capped linear backoff. Round 1..5 → base, then +base every 5 rounds, capped.
 *
 * `baseMs <= 0` means "no interval given" and falls back to the documented
 * default; it is NOT read as "poll as fast as possible", which is what a plain
 * `Number(x) || fallback` would silently do for 0.
 * @param {number} round 1-based
 * @param {number} baseMs
 * @param {number} maxMs
 * @returns {number}
 */
function nextPollDelay(round, baseMs, maxMs) {
  const rawBase = Number(baseMs);
  const rawCap = Number(maxMs);
  const safeBase = Number.isFinite(rawBase) && rawBase > 0 ? Math.max(250, rawBase) : 3000;
  const safeCap = Number.isFinite(rawCap) && rawCap > 0 ? Math.max(safeBase, rawCap) : safeBase;
  const step = Math.floor((Math.max(1, Number(round) || 1) - 1) / 5);
  return Math.min(safeCap, safeBase * (1 + step));
}

/**
 * Wall-clock deadline for the whole poll phase.
 * @param {number} pollIntervalMs
 * @param {number} pollMaxRounds
 * @param {number} [capMs]
 * @returns {number}
 */
function computePollDeadlineMs(pollIntervalMs, pollMaxRounds, capMs = 600000) {
  const base = Math.max(250, Number(pollIntervalMs) || 3000);
  const rounds = Math.max(1, Number(pollMaxRounds) || 1);
  // Worst case is the capped backoff, not the base interval.
  const worst = Math.min(base * (1 + Math.floor(rounds / 5)), 5 * base) * rounds;
  return Math.min(Math.max(worst, base), Math.max(base, Number(capMs) || 600000));
}

/**
 * @param {{round:number, maxRounds:number, elapsedMs:number, deadlineMs:number,
 *          stability:{stable:boolean,reason:string}}} state
 * @returns {{stop:boolean, reason:string|null}}
 */
function shouldStopPolling(state = {}) {
  const round = Number(state.round) || 0;
  const maxRounds = Math.max(1, Number(state.maxRounds) || 1);
  if (round >= maxRounds) {
    return { stop: true, reason: 'round_cap_reached' };
  }
  const elapsed = Number(state.elapsedMs) || 0;
  const deadline = Number(state.deadlineMs) || 0;
  if (deadline > 0 && elapsed >= deadline) {
    return { stop: true, reason: 'deadline_reached' };
  }
  const stability = state.stability || {};
  if (stability.stable === true) {
    return { stop: true, reason: `reply_stable_${stability.reason || 'text_stable'}` };
  }
  return { stop: false, reason: null };
}

/**
 * Build the dispatch plan. `config` is the output of resolveAmooConfig.
 * @param {{taskText:string, config:object, channel?:'http'|'mailbox'}} input
 * @returns {{channel:string, inputRoute:string, inputRouteReason:string,
 *            steps:object[], poll:object, taskChars:number}}
 */
function buildDispatchPlan(input = {}) {
  const config = input.config || {};
  const dispatch = config.dispatch || {};
  const amoo = config.amoo || {};
  const bridge = config.bridge || {};
  const taskText = typeof input.taskText === 'string' ? input.taskText : '';
  const route = chooseInputRoute(taskText);
  const channel = input.channel === 'mailbox' ? 'mailbox' : 'http';
  const pollIntervalMs = Number(dispatch.pollIntervalMs) || 3000;
  const pollMaxRounds = Number(dispatch.pollMaxRounds) || 40;
  const pollMaxIntervalMs = Number(dispatch.pollMaxIntervalMs) || 8000;
  const stableRounds = Number(dispatch.replyStableRounds) || 3;

  const steps = [
    {
      id: 'ensure-device',
      kind: 'adb',
      detail: `确认设备 ${config.adb ? config.adb.serial : '?'} 在线；不在线才 connect，绝不 pair`,
    },
  ];
  if (channel === 'http') {
    // The mailbox channel needs no forward, and a plan that lists one would be
    // a lie about what the runner is going to do.
    steps.push({
      id: 'ensure-forward',
      kind: 'adb',
      detail: `建立 tcp:${bridge.port || 0} 与别名 tcp:${bridge.aliasPort || 0} 两条 forward（幂等）`,
    });
  }
  steps.push(
    {
      id: 'bridge-ping',
      kind: 'bridge',
      detail: '探活桥服务；死了先走 monkey 拉起再重试一次',
    },
    {
      id: 'launch-amoo',
      kind: 'adb',
      detail: `按组件+动作打开 Amoo：${amoo.component || '?'}`,
    },
    {
      id: 'focus-input',
      kind: 'adb',
      detail: `点输入框 ${amoo.inputId || '?'}（坐标从当次截图解析，不用记忆值）`,
    },
    {
      id: 'fill-text',
      kind: route.route === 'clipboard' ? 'bridge+adb' : 'adb',
      detail:
        route.route === 'clipboard'
          ? '桥 clipboard 写入任务文本，再 keyevent 279 粘贴进输入框'
          : 'adb input text 写入任务文本（纯 ASCII）',
    },
    {
      id: 'verify-input',
      kind: 'adb',
      detail: '再 dump 一次，确认输入框里真的是这段文本，避免空发',
    },
    {
      id: 'tap-send',
      kind: 'adb',
      detail: `点发送按钮 ${amoo.sendId || '?'}（坐标从当次截图解析）`,
    },
    {
      id: 'poll-reply',
      kind: 'adb',
      detail: `定时 dump，按稳定判据回收 Amoo 答复（间隔 ${pollIntervalMs}ms 起，上限 ${pollMaxIntervalMs}ms）`,
    },
    {
      id: 'collect-reply',
      kind: 'local',
      detail: '抽取聊天列表文本，截断到上限后返回',
    }
  );

  return {
    channel,
    inputRoute: route.route,
    inputRouteReason: route.reason,
    taskChars: taskText.length,
    steps,
    poll: {
      intervalMs: pollIntervalMs,
      maxIntervalMs: pollMaxIntervalMs,
      maxRounds: pollMaxRounds,
      stableRounds,
      deadlineMs: computePollDeadlineMs(pollIntervalMs, pollMaxRounds),
    },
  };
}

/**
 * Render the plan as Chinese lines for the terminal. Used both for the
 * confirm-gated preview and for verbose runs.
 * @param {object} plan output of buildDispatchPlan
 * @returns {string[]}
 */
function renderDispatchPlan(plan) {
  const lines = [];
  lines.push(`下发通道：${plan.channel === 'mailbox' ? '文件信箱（兜底）' : 'HTTP（经 adb forward）'}`);
  lines.push(
    `文本写入：${plan.inputRoute === 'clipboard' ? '剪贴板 + 粘贴键（含非 ASCII）' : 'input text（纯 ASCII）'}，任务文本 ${plan.taskChars} 字`
  );
  lines.push(`等待策略：间隔 ${plan.poll.intervalMs}ms 起、上限 ${plan.poll.maxIntervalMs}ms，最多 ${plan.poll.maxRounds} 轮，稳定 ${plan.poll.stableRounds} 轮判定完成，硬上限 ${plan.poll.deadlineMs}ms`);
  lines.push('步骤：');
  plan.steps.forEach((step, index) => {
    lines.push(`  ${index + 1}. [${step.kind}] ${step.detail}`);
  });
  return lines;
}

/**
 * Hard-truncate a body for a tool/CLI result, with an explicit marker so the
 * caller can see it was cut.
 *
 * Cap resolution: not a number → the documented default; <= 0 → the 50-char
 * floor (asking for zero must not silently mean "keep everything", which is what
 * `Number(x) || default` would do); otherwise the requested value with the same
 * floor applied.
 * @param {string} text
 * @param {number} maxChars
 * @returns {{text:string, truncated:boolean, originalChars:number}}
 */
function truncateForResult(text, maxChars) {
  const value = typeof text === 'string' ? text : '';
  const raw = Number(maxChars);
  let cap;
  if (!Number.isFinite(raw)) {
    cap = 20000;
  } else if (raw <= 0) {
    cap = 50;
  } else {
    cap = Math.max(50, raw);
  }
  if (value.length <= cap) {
    return { text: value, truncated: false, originalChars: value.length };
  }
  return {
    text: `${value.slice(0, cap)}\n……（已截断，原文 ${value.length} 字，保留前 ${cap} 字）`,
    truncated: true,
    originalChars: value.length,
  };
}

// Stop reasons that deserve a human sentence instead of a raw code. Unknown
// reasons pass through untouched — the code is always better than a guess.
// Single source: the runner renders poll outcomes with it, the panel view model
// (amooPanelViewModel.js) renders the same stop reason with it. Two renderers,
// one mapping; a third copy is how the CLI and the panel start disagreeing.
const STOP_REASON_TEXT = Object.freeze({
  screen_unreadable: '屏幕持续读不到（uiautomator 重试后仍失败，Amoo 可能还在流式生成）',
  round_cap_reached: 'round_cap_reached（轮次上限）',
  deadline_reached: 'deadline_reached（超时）',
});

/**
 * @param {string} reason stop reason from shouldStopPolling / the poll loop
 * @returns {string} Chinese sentence when known, the raw code otherwise
 */
function describeStopReason(reason) {
  return STOP_REASON_TEXT[reason] || String(reason || 'unknown');
}

module.exports = {
  NON_ASCII_RE,
  chooseInputRoute,
  nextPollDelay,
  computePollDeadlineMs,
  shouldStopPolling,
  buildDispatchPlan,
  renderDispatchPlan,
  truncateForResult,
  describeStopReason,
};
