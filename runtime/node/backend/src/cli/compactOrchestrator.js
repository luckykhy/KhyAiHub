'use strict';

/**
 * compactOrchestrator.js — /compact 手动压缩的单一编排器（AI 摘要优先，失败回退本地）。
 *
 * 修复前：/compact 三入口（routerDispatchSlash case 'compact'、replSession 菜单/键入
 * 孪生）直连 compactHistory —— 同步本地启发式折叠，不调 AI、不发进度事件、不落盘，
 * 对外文案却承诺「AI 生成摘要，约需 10-30 秒」。用户观感：没反应、没进度条、压缩完
 * 上下文没变化。
 *
 * 修复后（本模块，三入口共用）：
 *   1. AI 路径：contextCompressor.compress({ force: true }) —— 手动压缩旁路自动压缩
 *      的四道统计门（占用阈值/冷却/低效/恢复首跳；用户点名 /compact 就是要压缩，统计
 *      门只属于自动链路），callModelFn 走 buildContextSummary（自带三级降级），
 *      onPhase 事件驱动真进度条（阶段/百分比与 compactionDisplay 单一真源同源）。
 *      压缩强度档映射 preserve 比例：light 0.5 / balanced 0.3 / aggressive 0.15。
 *   2. 本地回退：仅当 compress 抛错或网关不可用时降级 compactHistory 启发式折叠，
 *      结果如实标注降级原因。compress 自身的摘要降级（模型失败 → 本地抽取）不经此路
 *      —— 它返回 summaryGenerated:true 即 AI 压缩成功，降级已由 notice 通道如实上报。
 *   3. 诚实 no-op：消息数不足（≤keepRecent+1 或 <MIN_COMPRESSIBLE_MESSAGES）不发起
 *      模型往返直接返回 changed:false；compress 主动跳过（PreCompact 钩子拒绝/无可
 *      折叠历史）同样如实返回，不偷偷降级本地重折（那会绕过钩子、毁掉既有 AI 摘要）。
 *
 * 成功收尾三件事：压缩视图等价替换写回 _chatState.messages（applyCompactedContext，
 * [DESIGN-ARCH-135] 语义）；_persistLiveSession() 写 JSONL 全保真路径（否则 /resume
 * 复活压缩前历史）；返回兼容 compactHistory 字段形状的结果对象（三入口与既有测试
 * 依赖 previousCount/nextCount/compactedCount/mode 等字段）。
 *
 * 打印职责：本模块打印起始行与结果行（formatters 单一出口，入口层不再自打文案）；
 * 进度条渲染交给调用方注入的 ui.onPhase（REPL 用 DynamicSpinner +
 * compactionDisplay.buildCompactionLine，与对话轮内自动压缩同款视觉）。
 * compress 成功时 compactionUiPort 会自发打印「上下文已压缩：词元」行（token 视角），
 * 本模块的结果行是消息条数视角（条数 + 折叠数 + 持久化确认），两行角度不同不重复。
 */

// 压缩强度档 → preserve 比例（保留尾部比例，越小压得越狠）。与 compactHistory 的
// light/balanced/aggressive 语义对齐；compress 内部 clamp 到 ≤0.7。
const MODE_PRESERVE_RATIO = Object.freeze({
  light: 0.5,
  balanced: 0.3,
  aggressive: 0.15,
});

const VALID_MODES = ['light', 'balanced', 'aggressive'];

function _resolveMode(mode, messageCount, keepRecent) {
  let m = String(mode || 'auto')
    .trim()
    .toLowerCase();
  // auto 档规则与 compactHistory 的 auto 分支同口径，保证两条路径强度一致。
  if (m === 'auto') {
    if (messageCount >= 60 || keepRecent <= 8) {
      m = 'aggressive';
    } else if (messageCount >= 28) {
      m = 'balanced';
    } else {
      m = 'light';
    }
  }
  return VALID_MODES.includes(m) ? m : 'balanced';
}

/** 网关可用性探测：至少一个适配器 available。探测失败视为不可用（fail-closed）。 */
function _isGatewayAvailable() {
  try {
    const gateway = require('../services/gateway/aiGateway');
    const statuses = typeof gateway.getStatus === 'function' ? gateway.getStatus() : null;
    return Array.isArray(statuses) && statuses.some((s) => s && s.available === true);
  } catch {
    return false;
  }
}

function _fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) {
    return '';
  }
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
}

function _formatters(ui) {
  let fmt = null;
  try {
    fmt = require('./formatters');
  } catch {
    /* headless：回退 console */
  }
  return {
    printInfo: ui.printInfo || (fmt && fmt.printInfo) || ((s) => console.log(s)),
    printSuccess: ui.printSuccess || (fmt && fmt.printSuccess) || ((s) => console.log(s)),
    printWarn: ui.printWarn || (fmt && fmt.printWarn) || ((s) => console.log(s)),
    printError: ui.printError || (fmt && fmt.printError) || ((s) => console.log(s)),
  };
}

/** 压缩视图写回后的持久化。_persistLiveSession 自身 best-effort 永不抛，require 兜一层。 */
function _persistSafe() {
  try {
    require('./aiSession')._persistLiveSession();
  } catch {
    /* persistence is best-effort */
  }
}

function _safeLogger() {
  try {
    return require('../utils/logger');
  } catch {
    return null;
  }
}

/**
 * 把压缩后的占用估算推给 HUD（底栏上下文条 + /hud 面板的数字与百分比）。
 *
 * HUD 的 used 每轮由 API 报数经 setContextUsage 刷新；手动 /compact 后没有新一轮，
 * 数字会停在压缩前的旧值 —— 这是「压缩完上下文没变化」观感的最后一块。这里用与
 * 释放量报告同一把尺（khyUpgradeRuntime.estimateTokens）对写回后的会话重估并立即
 * 回显；下一轮 API 报数会再校准（setContextUsage 既有语义）。limit 透传 HUD 现值
 * （setContextUsage 只在 >0 时覆盖）。best-effort：HUD 缺席（headless）时静默跳过。
 */
function _refreshHudUsage(opsRef) {
  try {
    const hud = require('./hudRenderer');
    if (typeof hud.setContextUsage !== 'function') {
      return;
    }
    const runtime = require('../services/khyUpgradeRuntime');
    let used = 0;
    for (const m of opsRef.getConversation()) {
      used += runtime.estimateTokens(m && m.content ? m.content : '');
    }
    let limit = 0;
    try {
      const state = typeof hud.getState === 'function' ? hud.getState() : null;
      limit = (state && state.contextWindow && Number(state.contextWindow.limit)) || 0;
    } catch {
      /* limit 未知 → 传 0，setContextUsage 保持 HUD 现值 */
    }
    hud.setContextUsage(Math.max(0, Math.round(used)), limit);
  } catch {
    /* HUD 刷新是 best-effort，永不拖垮压缩收尾 */
  }
}

/**
 * 执行手动 /compact 压缩。
 *
 * @param {object} [options] - { mode, instructions, keepRecent }（buildCompactOptions 产物超集）
 * @param {object} [ui] - { onPhase(evt), printInfo, printSuccess, printWarn, printError }。
 *   onPhase 收到 { stage, pct, startedAt }，stage/pct 与 compactionDisplay 的
 *   STAGE_LABELS/STAGE_PCT 同源；缺省时无进度条，仅起始/结果行。
 * @returns {Promise<object>} 兼容 compactHistory 字段 + { source: 'ai'|'local'|'none',
 *   elapsedMs, freedTokens?, degradedReason?, noOpReason? }
 */
async function compactSession(options = {}, ui = {}) {
  const startedAt = Date.now();
  const fmt = _formatters(ui);
  const onPhase = typeof ui.onPhase === 'function' ? ui.onPhase : null;
  const emit = (stage, pct) => {
    if (!onPhase) {
      return;
    }
    try {
      onPhase({ stage, pct, startedAt });
    } catch {
      /* UI 回调故障不拖垮压缩本身 */
    }
  };

  const ops = require('./aiConversationOps');
  const messages = ops.getConversation();
  const previousCount = messages.length;

  // keepRecent 与 compactHistory 同口径（4..40，默认 12）
  const keepRecent = Math.max(
    4,
    Math.min(
      40,
      Number.isFinite(Number(options.keepRecent)) ? Math.floor(Number(options.keepRecent)) : 12
    )
  );
  const focus = String(options.instructions || options.focus || '').trim();
  const mode = _resolveMode(options.mode, previousCount, keepRecent);

  // ── 诚实 no-op：与 compactHistory 同口径（≤keepRecent+1），外加压缩器硬地板。
  // 说清「为什么不动」，绝不静默返回。
  let minMessages = 5;
  try {
    minMessages = require('../services/contextCompressor').MIN_COMPRESSIBLE_MESSAGES;
  } catch {
    /* 回退字面量 5，与压缩器常量当前值一致 */
  }
  if (previousCount <= keepRecent + 1 || previousCount < minMessages) {
    return {
      success: true,
      changed: false,
      source: 'none',
      previousCount,
      nextCount: previousCount,
      compactedCount: 0,
      keepRecent,
      mode: 'none',
      elapsedMs: Date.now() - startedAt,
      noOpReason: `当前 ${previousCount} 条消息（保留最近 ${Math.min(previousCount, keepRecent)} 条），无历史可折叠`,
    };
  }

  // ── AI 路径前提：网关至少有一个可用适配器。不可用直接本地折叠并如实说明，
  // 不做一次注定失败的模型往返。
  const aiReady = _isGatewayAvailable();
  let aiError = null;

  if (aiReady) {
    fmt.printInfo(
      `压缩会话上下文（${previousCount} 条消息，保留最近 ${keepRecent} 条）：正在生成 AI 摘要...`
    );
    emit('starting', 5);
    try {
      const runtime = require('../services/khyUpgradeRuntime');
      const { compress } = require('../services/contextCompressor');
      let budget = 0;
      try {
        budget = ops.getContextLimit();
      } catch {
        /* 无模型信息时回退默认预算 */
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        budget = runtime.CONTEXT_TOKEN_LIMIT;
      }

      const result = await compress(messages, {
        estimateTokensFn: (text) => runtime.estimateTokens(text),
        callModelFn: (text, callOpts) =>
          runtime.buildContextSummary([{ role: 'user', content: text }], {
            maxTokens: 4000,
            instructions: focus,
            ...callOpts,
          }),
        contextWindowTokens: budget,
        preserveRatioOverride: MODE_PRESERVE_RATIO[mode],
        force: true,
        onPhase: (evt) => emit(evt && evt.stage, evt && evt.pct),
        logger: _safeLogger(),
      });

      if (result && result.summaryGenerated) {
        const compacted = result.compressed;
        const applied = ops.applyCompactedContext(compacted);
        _persistSafe();
        _refreshHudUsage(ops);
        emit('done', 100);
        const nextCount = applied.to;
        const compactedCount = Math.max(0, previousCount - nextCount);
        const summaryChars =
          compacted[0] && typeof compacted[0].content === 'string' ? compacted[0].content.length : 0;
        const elapsedMs = Date.now() - startedAt;
        fmt.printSuccess(_successLine({ previousCount, nextCount, compactedCount, summaryChars, freedTokens: result.freedTokens, elapsedMs, source: 'ai', mode }));
        return {
          success: true,
          changed: true,
          source: 'ai',
          mode,
          keepRecent,
          previousCount,
          nextCount,
          compactedCount,
          summaryChars,
          freedTokens: result.freedTokens,
          elapsedMs,
        };
      }

      // compress 主动跳过（PreCompact 钩子拒绝 / 无值得折叠的历史）：其 notice 通道
      // 已打印具体跳过原因。这里如实返回 no-op —— 不偷偷降级本地重折，那会绕过钩子
      // 并用启发式折叠覆盖既有 AI 摘要。
      emit('done', 100);
      fmt.printInfo(
        `无需压缩：当前 ${previousCount} 条消息，压缩器判定无值得折叠的历史（详见上方跳过原因）`
      );
      return {
        success: true,
        changed: false,
        source: 'ai',
        mode,
        keepRecent,
        previousCount,
        nextCount: previousCount,
        compactedCount: 0,
        elapsedMs: Date.now() - startedAt,
        noOpReason: '压缩器判定无值得折叠的历史（详见上方跳过原因）',
      };
    } catch (err) {
      // compress 抛错（模块缺失/意外异常）→ 落到下方本地回退，如实说明降级原因。
      aiError = err;
    }
  }

  // ── 本地回退：compactHistory 既有启发式折叠（它内部直接写回 _chatState.messages）
  const degradedReason = aiError
    ? `AI 摘要失败（${String(aiError && aiError.message ? aiError.message : aiError).slice(0, 120)}）`
    : 'AI 网关不可用';
  fmt.printWarn(`AI 摘要不可用，已降级为本地折叠：${degradedReason}`);
  emit('summarizing', 45);
  const local = ops.compactHistory({ keepRecent, mode, instructions: focus });
  const localChanged = !!(local && local.changed);
  if (localChanged) {
    _persistSafe();
    _refreshHudUsage(ops);
  }
  emit('done', 100);
  const elapsedMs = Date.now() - startedAt;
  if (localChanged) {
    const freedTokens = _estimateFreed(messages, ops);
    fmt.printSuccess(
      _successLine({
        previousCount: local.previousCount,
        nextCount: local.nextCount,
        compactedCount: local.compactedCount,
        summaryChars: local.summaryChars,
        freedTokens,
        elapsedMs,
        source: 'local',
        mode,
      })
    );
    return {
      ...local,
      source: 'local',
      degraded: true,
      degradedReason,
      elapsedMs,
      freedTokens,
    };
  }
  fmt.printInfo(
    `无需压缩：当前 ${local.previousCount} 条消息（保留最近 ${keepRecent} 条），无历史可折叠`
  );
  return { ...local, source: 'local', degraded: true, degradedReason, elapsedMs };

  // ── helpers ──
  function _successLine(r) {
    const parts = [`会话已压缩：${r.previousCount} -> ${r.nextCount} 条消息`];
    const detail = [];
    detail.push(r.source === 'ai' ? `AI 摘要（${r.mode}）` : `本地折叠（${r.mode}）`);
    if (r.compactedCount > 0) {
      detail.push(`折叠 ${r.compactedCount} 条`);
    }
    if (r.summaryChars > 0) {
      detail.push(`摘要 ${r.summaryChars} 字`);
    }
    const freed = _fmtTokens(r.freedTokens);
    if (freed) {
      detail.push(`释放约 ${freed} 词元`);
    }
    if (r.elapsedMs > 0) {
      detail.push(`${(r.elapsedMs / 1000).toFixed(1)}s`);
    }
    detail.push('已写回会话并持久化');
    return `${parts[0]}（${detail.join(' · ')}）`;
  }

  function _estimateFreed(before, opsRef) {
    try {
      const runtime = require('../services/khyUpgradeRuntime');
      const est = (arr) => arr.reduce((s, m) => s + runtime.estimateTokens(m.content || ''), 0);
      const after = opsRef.getConversation();
      return Math.max(0, est(before) - est(after));
    } catch {
      return 0;
    }
  }
}

module.exports = {
  compactSession,
  MODE_PRESERVE_RATIO,
};
