'use strict';

/**
 * goalModeService.js
 *
 * Goal Mode (目标模式) — 给定目标后自动评估能力、提升权限、自主执行、恢复权限。
 *
 * 触发方式: "目标：xxx" 或 "goal: xxx"
 * 流程: preflightCheck → activate → AI 自主执行 → deactivate
 */

const GOAL_TRIGGER_RE = /^(?:goal|目标)[：:\s]+(.+)/is;

/**
 * 从用户输入中提取目标文本。
 * @param {string} text - 用户原始输入
 * @returns {string|null} 目标文本，未匹配返回 null
 */
function extractGoal(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }
  const m = text.trim().match(GOAL_TRIGGER_RE);
  return m ? m[1].trim() : null;
}

/**
 * 三维能力评估: 模型等级 + 上下文窗口 + 工具可用性。
 * @param {string} goalText - 提取后的目标文本
 * @param {object} [opts] - { modelName, contextRemaining, contextTotal, enabledTools }
 * @returns {{ canProceed: boolean, reasons: string[], warnings: string[], assessment: object }}
 */
function preflightCheck(goalText, opts = {}) {
  const reasons = [];
  const warnings = [];
  const assessment = { model: 'unknown', contextRatio: 1, toolCount: 0 };

  // ── 1. 模型等级检查 ─────────────────────────────────────────────
  const LOW_TIER_RE = /(mini|lite|flash|haiku|small|7b|8b|3b|1\.5b|nano|tiny)/i;
  const modelName = String(opts.modelName || process.env.GATEWAY_PREFERRED_MODEL || '').trim();
  assessment.model = modelName || 'unknown';

  if (modelName && LOW_TIER_RE.test(modelName)) {
    reasons.push(
      `模型 "${modelName}" 等级过低，goal 模式需要中高端模型 (claude-sonnet/opus/gpt-4o/qwen-max 等)`
    );
  }

  // ── 2. 上下文窗口检查 ───────────────────────────────────────────
  const contextRemaining = Number(opts.contextRemaining) || 0;
  const contextTotal = Number(opts.contextTotal) || 0;
  if (contextTotal > 0) {
    const ratio = contextRemaining / contextTotal;
    assessment.contextRatio = Math.round(ratio * 100) / 100;
    if (ratio < 0.3) {
      reasons.push(
        `上下文剩余空间不足 (${Math.round(ratio * 100)}%)，goal 模式需要 >=30% 剩余空间`
      );
    } else if (ratio < 0.5) {
      warnings.push(`上下文剩余空间偏低 (${Math.round(ratio * 100)}%)，复杂目标可能中途截断`);
    }
  }

  // ── 3. 工具可用性检查 ───────────────────────────────────────────
  const REQUIRED_TOOL_PATTERNS = ['read', 'write', 'edit', 'bash', 'shell', 'glob', 'grep'];
  const enabledTools = Array.isArray(opts.enabledTools) ? opts.enabledTools : [];
  assessment.toolCount = enabledTools.length;

  if (enabledTools.length > 0) {
    const lowerTools = enabledTools.map((t) => String(t).toLowerCase());
    const hasFileOps = lowerTools.some((t) => /read|write|edit/i.test(t));
    const hasShell = lowerTools.some((t) => /bash|shell|command/i.test(t));
    const hasSearch = lowerTools.some((t) => /glob|grep|search/i.test(t));

    if (!hasFileOps) {
      reasons.push('缺少文件操作工具 (read/write/edit)');
    }
    if (!hasShell) {
      warnings.push('缺少 shell 执行工具 (bash/shell)，部分操作可能受限');
    }
    if (!hasSearch) {
      warnings.push('缺少搜索工具 (glob/grep)，代码探索能力受限');
    }
  }

  return {
    canProceed: reasons.length === 0,
    reasons,
    warnings,
    assessment,
  };
}

/**
 * 格式化前置检查失败报告。
 * @param {{ canProceed: boolean, reasons: string[], warnings: string[], assessment: object }} preflight
 * @returns {string}
 */
function formatPreflightFailure(preflight) {
  const lines = ['## Goal Mode 前置检查未通过\n'];
  lines.push('无法进入目标模式，原因如下：\n');

  for (const reason of preflight.reasons) {
    lines.push(`- ${reason}`);
  }

  if (preflight.warnings.length > 0) {
    lines.push('\n**额外警告：**');
    for (const w of preflight.warnings) {
      lines.push(`- ${w}`);
    }
  }

  lines.push('\n**建议：**');
  lines.push('- 切换到更高端的模型 (claude-sonnet/opus, gpt-4o, qwen-max)');
  lines.push('- 确保上下文窗口有足够剩余空间');
  lines.push('- 检查工具配置，确保文件读写和 shell 工具已启用');

  return lines.join('\n');
}

/**
 * 进程内并发 goal 会话计数。
 *
 * 提权的三件事（permissionStore profile / toolCalling dangerous mode /
 * KHY_GOAL_MODE_ACTIVE 标记）都是**进程级**的——仓里没有按会话隔离的权限通道
 * （toolCallingPermissions._permissionMode 同样是模块单例）。既然是进程级，就必须
 * 引用计数：先结束的那个会话不能把提权撤掉，否则仍在跑的那个会突然失去权限；
 * 反过来也不能重复快照，否则后一个会话的 deactivate 会把 profile 恢复成
 * 「第一个会话快照」的值。
 *
 * 已知残留（架构面，非本批范围）：提权仍是进程级的，同进程内并发的另一个
 * 普通会话会共享这份提权。要根治需把权限真源收窄到会话，属第三批。
 */
let _activeGoalSessions = 0;
let _sharedSavedState = null;

/**
 * 激活 goal 模式: 快照当前权限状态，提升到全权限。
 * @returns {object} savedState — 传递给 deactivate() 恢复权限
 */
function activate() {
  // 已有 goal 会话在自主模式里:复用已有提权,不再快照
  if (_activeGoalSessions > 0) {
    _activeGoalSessions += 1;
    return { shared: true };
  }

  // 快照当前状态
  const savedState = {
    dangerousMode: false,
    permissionProfile: 'normal',
    goalModeActive: process.env.KHY_GOAL_MODE_ACTIVE || '',
    planAutoApproveMs: process.env.KHY_PLAN_AUTO_APPROVE_MS || '',
  };

  // 1. permissionStore → yolo (所有工具一律放行)
  try {
    const permissionStore = require('./permissionStore');
    savedState.permissionProfile = permissionStore.getProfile();
    // persist:false —— 本轮的临时提权**不许**改写用户的磁盘档案。口径与
    // toolCallingPermissions._syncPermissionProfile 一致(那里同样明确
    // 「in-session 模式变更不得覆盖用户 durable on-disk profile」)。
    // 曾按默认语义落盘:进程被 SIGKILL/崩溃时 finally 不执行,permissions.json
    // 里就留下 profile:'yolo',此后每次启动都是全自动放行(AGT-01)。
    permissionStore.setProfile('yolo', { persist: false });
  } catch {
    /* permissionStore 不可用时跳过 */
  }

  // 2. toolCalling → dangerousMode (跳过危险操作二次确认)
  try {
    const toolCalling = require('./toolCalling');
    savedState.dangerousMode = toolCalling.isDangerousMode();
    toolCalling.enableDangerousMode();
    toolCalling.acknowledgeDangerousMode();
  } catch {
    /* toolCalling 不可用时跳过 */
  }

  // 3. 环境变量标记
  process.env.KHY_GOAL_MODE_ACTIVE = 'true';
  process.env.KHY_PLAN_AUTO_APPROVE_MS = '1';

  _sharedSavedState = savedState;
  _activeGoalSessions = 1;
  return savedState;
}

/**
 * 恢复权限到 activate 之前的状态。
 * @param {object} savedState — 由 activate() 返回
 */
function deactivate(savedState) {
  if (!savedState) {
    return;
  }

  // 引用计数:还有 goal 会话在跑就不撤提权(撤了会让那个会话突然失去权限)
  _activeGoalSessions = Math.max(0, _activeGoalSessions - 1);
  if (_activeGoalSessions > 0) {
    return;
  }

  // 共享提权时,恢复的是**首个**会话的快照(那才是提权前的状态)
  const restore = savedState.shared ? _sharedSavedState : savedState;
  _sharedSavedState = null;
  if (!restore) {
    return;
  }

  // 1. 恢复 permissionStore profile（同样不落盘：activate 没写盘,恢复也不该写）
  try {
    const permissionStore = require('./permissionStore');
    permissionStore.setProfile(restore.permissionProfile || 'normal', { persist: false });
  } catch {
    /* permissionStore 不可用时跳过 */
  }

  // 2. 恢复 dangerous mode
  try {
    const toolCalling = require('./toolCalling');
    if (!restore.dangerousMode) {
      toolCalling.disableDangerousMode();
    }
  } catch {
    /* toolCalling 不可用时跳过 */
  }

  // 恢复环境变量
  if (restore.goalModeActive) {
    process.env.KHY_GOAL_MODE_ACTIVE = restore.goalModeActive;
  } else {
    delete process.env.KHY_GOAL_MODE_ACTIVE;
  }

  if (restore.planAutoApproveMs) {
    process.env.KHY_PLAN_AUTO_APPROVE_MS = restore.planAutoApproveMs;
  } else {
    delete process.env.KHY_PLAN_AUTO_APPROVE_MS;
  }
}

/** 是否启用富完成报告(逃生阀 KHY_REPORT_RICH=0/false/off/no 关闭)。 */
function _isRichReportEnabled(env = process.env) {
  const flag = String((env && env.KHY_REPORT_RICH) || '')
    .trim()
    .toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * 构建完成报告(对标富计划骨架:为什么做 / 状态 / 做了什么 / 预计结果·实际 / 验证 / 收尾)。
 *
 * 所有富字段均**可选**:缺则整段省略。只传旧字段(goalText/success/steps/elapsed/deliverables/error)
 * 时输出与历史等价。逃生阀 KHY_REPORT_RICH=0 完全回退旧扁平模板。
 *
 * @param {object} opts - {
 *   goalText, success, steps, elapsed, deliverables, error,   // 旧字段(兼容)
 *   why, verification, residualRisks, nextSteps               // 富字段(可选)
 * }
 * @returns {string}
 */
function buildCompletionReport(opts = {}) {
  const {
    goalText,
    success,
    steps,
    elapsed,
    deliverables,
    error,
    why,
    verification,
    residualRisks,
    nextSteps,
  } = opts;
  const lines = [];

  if (success) {
    lines.push('## 任务执行完成\n');
    lines.push(`**目标：** ${goalText || '(未知)'}\n`);
  } else {
    lines.push('## 任务执行结束\n');
    lines.push(`**目标：** ${goalText || '(未知)'}\n`);
  }

  const rich = _isRichReportEnabled();

  // 为什么做(富字段,缺则省略)。
  if (rich && typeof why === 'string' && why.trim()) {
    lines.push(`**为什么做：** ${why.trim()}\n`);
  }

  if (success) {
    lines.push('**状态：** 成功\n');
  } else {
    lines.push(`**状态：** ${error ? '失败' : '部分完成'}\n`);
    if (error) {
      lines.push(`**错误：** ${error}\n`);
    }
  }

  if (typeof elapsed === 'number' && elapsed > 0) {
    const sec = Math.round(elapsed / 1000);
    lines.push(`**耗时：** ${sec >= 60 ? `${Math.floor(sec / 60)}分${sec % 60}秒` : `${sec}秒`}\n`);
  }

  // 做了什么(执行步骤,沿用图标)。
  if (Array.isArray(steps) && steps.length > 0) {
    lines.push(rich ? '**做了什么：**' : '**执行步骤：**');
    for (const s of steps) {
      const icon = s.status === 'completed' ? '+' : s.status === 'error' ? 'x' : '-';
      lines.push(`  ${icon} ${s.description || s.id}`);
    }
    lines.push('');
  }

  // 预计结果 vs 实际(交付物)。
  if (Array.isArray(deliverables) && deliverables.length > 0) {
    lines.push('**交付物：**');
    for (const d of deliverables) {
      lines.push(`  - ${d}`);
    }
    lines.push('');
  }

  // 验证(富字段,缺则省略)。
  if (rich && Array.isArray(verification) && verification.length > 0) {
    lines.push('**验证：**');
    for (const v of verification) {
      lines.push(`  ✓ ${v}`);
    }
    lines.push('');
  }

  // 收尾:残留风险 + 下一步(富字段,缺则省略)。
  const hasResidual = rich && Array.isArray(residualRisks) && residualRisks.length > 0;
  const hasNext = rich && Array.isArray(nextSteps) && nextSteps.length > 0;
  if (hasResidual || hasNext) {
    lines.push('**收尾：**');
    if (hasResidual) {
      for (const r of residualRisks) {
        lines.push(`  ⚠ 残留：${r}`);
      }
    }
    if (hasNext) {
      for (const n of nextSteps) {
        lines.push(`  ↳ 下一步：${n}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 检查是否已处于自主执行模式（goal/ultrawork/coding 激活期间）。
 * @returns {boolean}
 */
function isActive() {
  return process.env.KHY_GOAL_MODE_ACTIVE === 'true';
}

/**
 * 若尚未激活则 activate，已激活则返回 null（防止嵌套重复提升）。
 * @returns {object|null} savedState 或 null
 */
function activateIfNeeded() {
  // 我们自己在自主模式里(计数>0):这个会话复用已有提权,并登记一次计数。
  // 少了这一步,先结束的那个会话会把提权撤掉,仍在跑的那个会突然失去权限。
  if (_activeGoalSessions > 0) {
    _activeGoalSessions += 1;
    return { shared: true };
  }
  // 外部标记(用户自己设了 KHY_GOAL_MODE_ACTIVE):不接管提权,保持原语义
  if (isActive()) {
    return null;
  }
  return activate();
}

/**
 * 配合 activateIfNeeded 使用，savedState 为 null 时不操作。
 * @param {object|null} savedState
 */
function deactivateIfNeeded(savedState) {
  if (savedState) {
    deactivate(savedState);
  }
}

module.exports = {
  GOAL_TRIGGER_RE,
  extractGoal,
  preflightCheck,
  formatPreflightFailure,
  isActive,
  activate,
  activateIfNeeded,
  deactivate,
  deactivateIfNeeded,
  buildCompletionReport,
};
