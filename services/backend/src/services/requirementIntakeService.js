'use strict';

/**
 * requirementIntakeService.js — 用户需求理解聚合层（[DESIGN-ARCH-164]）。
 *
 * khy-os 的需求理解散件齐全、编排缺席：taskScale / clarificationCards /
 * referenceDisambiguation / promptIntentRepair 各自独立向系统提示词注入指令，
 * 互不知晓 —— 同一轮可能同时命中「澄清卡指令」与「消歧指令」，模型收到两份
 * 互相竞争的问询指引。本服务是**聚合前置层**：一次输入 → 一份 understandingState
 * （route: clarify | disambiguate | plan | proceed），按「消歧 > 澄清 > 计划」
 * 互斥排序，同一轮至多建议注入一份问询指令。
 *
 * 设计边界（对齐既有模式 clarificationCards / mathSolvePolicy）：
 *  - 纯叶子：无随机、绝不抛；判据全部**复用单一真源**（本文件不定义第二份
 *    问候/清晰度/规模判据，只消费调用方传入的既有判定结果）。
 *  - S1 观察者（PROCESS-008）：本服务只算 route 并返回，由调用方决定是否
 *    采纳；门控 KHY_REQUIREMENT_INTAKE 默认关（仅显式 on 启用），关 →
 *    调用方逐字节回退现有散装注入行为。
 *  - 与 clarificationCards 正交：本服务产出的是「何时注入」的裁决；
 *    指令文本仍由 clarificationCards.buildClarificationDirective 提供。
 */

// 与 clarificationCards.CLEAR_MODES 一致：意图模式活跃即视为「用户已给出明确指令」。
const CLEAR_MODES = Object.freeze(['goal', 'ultrawork', 'coding', 'analyze', 'learn']);

/** 聚合门控。仅显式 on/1/true/yes 启用（默认关，对齐 DESIGN-ARCH-164 §8）。 */
function isEnabled(options = {}) {
  if (options && options.requirementIntake !== undefined) {
    const raw = String(options.requirementIntake).trim().toLowerCase();
    return ['1', 'true', 'on', 'yes'].includes(raw);
  }
  const raw = String(process.env.KHY_REQUIREMENT_INTAKE || '')
    .trim()
    .toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(raw);
}

/**
 * 聚合五路裁决（互斥排序，首个命中即停）。
 *
 * @param {object} input
 * @param {string} input.text                 用户原始消息
 * @param {boolean} [input.hasMedia]          是否伴随媒体
 * @param {string[]} [input.modes]            intentGate.detectModes().modes
 * @param {'small'|'normal'|'large'} [input.scale]  调用方已算好的任务规模（taskScale 真源）
 * @param {boolean} [input.disambiguationNeeded]    referenceDisambiguation 判定「需用户选择」
 * @param {boolean} [input.clarificationNeeded]     clarificationCards 判定「提示词不清」
 * @param {object} [input.options]            env 覆盖（{requirementIntake}）
 * @returns {{
 *   enabled:boolean,
 *   modeActive:boolean,
 *   scale:'small'|'normal'|'large'|'unknown',
 *   route:'disambiguate'|'clarify'|'plan'|'proceed',
 *   reason:string,
 *   injectedDirectives:string[]
 * }}
 */
function aggregate(input = {}) {
  const options = input.options || {};
  const enabled = isEnabled(options);
  const modes = (Array.isArray(input.modes) ? input.modes : [])
    .map((m) => String(m || '').trim().toLowerCase())
    .filter(Boolean);
  const modeActive = modes.some((m) => CLEAR_MODES.includes(m));
  const scale = ['small', 'normal', 'large'].includes(input.scale)
    ? input.scale
    : 'unknown';

  if (!enabled) {
    return {
      enabled,
      modeActive,
      scale,
      route: 'proceed',
      reason: 'disabled',
      injectedDirectives: [],
    };
  }

  // 互斥排序：消歧 > 澄清 > 计划。先弄清「在说什么」，再弄清「要什么」，最后「怎么做」。
  if (input.disambiguationNeeded && !modeActive) {
    return {
      enabled,
      modeActive,
      scale,
      route: 'disambiguate',
      reason: 'reference-ambiguous',
      injectedDirectives: ['referenceDisambiguation'],
    };
  }
  if (input.clarificationNeeded && !modeActive) {
    return {
      enabled,
      modeActive,
      scale,
      route: 'clarify',
      reason: 'prompt-unclear',
      injectedDirectives: ['clarification'],
    };
  }

  // plan 路由（S1 只记录不注入）：中大型任务且无意图模式活跃 → 建议需求固化。
  // small 任务（一句话可答）与模式活跃（用户已明确指令）都不打扰。
  if (!modeActive && (scale === 'normal' || scale === 'large')) {
    return {
      enabled,
      modeActive,
      scale,
      route: 'plan',
      reason: `mid-large-task-${scale}`,
      injectedDirectives: [],
    };
  }

  return {
    enabled,
    modeActive,
    scale,
    route: 'proceed',
    reason: modeActive ? 'mode-active' : 'small-or-clear',
    injectedDirectives: [],
  };
}

/**
 * 观察记录（S1 只记录不阻断，规则 2 规范：动作 + 目标 + 进度）。
 * 返回一行状态文本；调用方决定是否展示/落台账。
 * @param {object} understandingState  aggregate() 的返回值
 * @returns {string|null}
 */
function formatIntakeStatus(understandingState) {
  if (!understandingState || !understandingState.enabled) {
    return null;
  }
  const routeText = {
    disambiguate: '指代消歧',
    clarify: '选项卡澄清',
    plan: '需求固化建议',
    proceed: '直接推进',
  }[understandingState.route] || understandingState.route;
  return `需求理解聚合：route=${routeText}（规模 ${understandingState.scale}，${understandingState.reason}）`;
}

module.exports = {
  CLEAR_MODES,
  isEnabled,
  aggregate,
  formatIntakeStatus,
};
