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

// 阶段权威（对齐 check-agent-feedback.js 的 STAGE 常量模式,PROCESS-008）:
// S1 = 只记录不改变注入行为;升 S2 后 aiChatCore 才会按 aggregate() 的互斥裁决
// 收口散装注入。升阶是人的决定,毕业看样本量（≥200 条无解释不了的样本）。
const KHY_REQUIREMENT_INTAKE_STAGE = 'S1';

function getStage() {
  return KHY_REQUIREMENT_INTAKE_STAGE;
}

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

// ── ⑤ 验收口径判定（本文件唯一的新增判据,[DESIGN-ARCH-164] §4.1）──────────────
// 保守、零假阳性优先：宁可漏判走 proceed，也绝不误打扰。三类信号：
//   验收标记（有验收词 = 不缺）→ 动作动词（无动作 = 不是工程任务）→ 缺口成立。
const _ACCEPTANCE_MARK =
  /验收|测试|跑通|复现|验证|期望|报错|错误|日志|截图|命令行|可运行|能跑|能运行|通过|reproduce|verify|acceptance|expected|error log|test case/i;
const _ACTION_MARK =
  /(加|添加|实现|写|做|改|修|优化|重构|开发|创建|删除|部署|升级|配置|fix|add|implement|create|build|refactor|optimize|deploy|update|configure)/i;

/**
 * 判定「动作型请求缺验收口径」。纯函数。
 * @param {string} text
 * @param {'small'|'normal'|'large'|'unknown'} scale
 * @returns {{gap:boolean, reason:string}}
 */
function assessAcceptanceGap(text, scale) {
  if (scale !== 'normal' && scale !== 'large') {
    return { gap: false, reason: 'scale-small-or-unknown' };
  }
  const t = String(text || '').trim();
  if (t.length < 12) {
    return { gap: false, reason: 'too-short' };
  }
  if (_ACCEPTANCE_MARK.test(t)) {
    return { gap: false, reason: 'has-acceptance-mark' };
  }
  if (!_ACTION_MARK.test(t)) {
    return { gap: false, reason: 'no-action-verb' };
  }
  return { gap: true, reason: 'action-without-acceptance' };
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

  // plan 路由（S1 只记录不注入）：中大型任务且无意图模式活跃且缺验收口径 →
  // 建议需求固化。small 任务（一句话可答）与模式活跃（用户已明确指令）都不打扰。
  if (!modeActive && (scale === 'normal' || scale === 'large')) {
    const _gap = assessAcceptanceGap(input.text, scale);
    if (_gap.gap) {
      return {
        enabled,
        modeActive,
        scale,
        route: 'plan',
        reason: `acceptance-gap-${scale}`,
        injectedDirectives: [],
        acceptanceGap: _gap,
      };
    }
    return {
      enabled,
      modeActive,
      scale,
      route: 'proceed',
      reason: `clear-acceptance-${_gap.reason}`,
      injectedDirectives: [],
      acceptanceGap: _gap,
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

// ── S1 观察台账已下沉 ────────────────────────────────────────────────────────
// 本件是纯叶子（无 IO、确定性、绝不抛），裁决落盘（.khy/requirements/observations.jsonl）
// 这一 IO 归 requirementArtifact.observeIntake（设计指定的唯一落盘点）。调用方
// （aiChatCore）在拿到 aggregate() 结果后自行调它，本件不再导出 observe。

module.exports = {
  CLEAR_MODES,
  STAGE: KHY_REQUIREMENT_INTAKE_STAGE,
  getStage,
  isEnabled,
  aggregate,
  assessAcceptanceGap,
  formatIntakeStatus,
};
