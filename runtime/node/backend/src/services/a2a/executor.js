'use strict';

/**
 * executor.js — A2A 入站消息的 agent 执行器（P0-2：把 message/send 接进真运行时）。
 *
 * 定位：`serverMethods.js` 的 executor 是唯一业务接缝，默认实现只回显（诚实占位）。
 * 本模块提供那个"真身"：把入站文本转成**一次** `runToolUseLoop` 调用，循环期进度经
 * `onProgress` 回报成任务态（working + 第 N 次迭代），终态由循环结果决定
 * （completed / failed / canceled）。迭代预算与空闲超时仍由循环自己的 IterationBudget
 * 管 —— 本执行器不另设任何时钟（RUNTIME-003：不新造硬 kill）。
 *
 * 为什么必须走 runToolUseLoop 而不是自己拼工具调用：外部任务要与终端用户**同权**过
 * 审批 / shell 安全 / 循环检测，这些闸门全都长在循环里；绕开它就得自己再实现一遍，
 * 那才是绕开后门。本执行器刻意**不接** onControlRequest —— A2A 这条路没有交互面，
 * 无人应答时权限闸门按 fail-closed 拒绝（与守护进程同口径），绝不把"没人理"解释成
 * 放行。L2 高危/破坏性工具在没有交互器时同样被拒，不因调用来自 HTTP 而放宽。
 *
 * 门控 KHY_A2A_EXECUTOR（default-off，PROCESS-008 S1 观察者档）：未设 → 启动代码不安装
 * 本执行器，`routes/a2a.js` 的默认回显行为逐字节不变。要打开它，先确认
 * KHY_A2A_API_KEY 已配置（否则任何能连上后端的人都可驱动真 agent）。
 *
 * @module services/a2a/executor
 */

const envFlagByName = require('../../utils/envFlagByName');
const { extractMessageText } = require('./serverMethods');

/** 门控：入站 A2A 任务是否真驱 agent 运行时（默认关；仅显式真值开）。 */
function isExecutorEnabled() {
  return envFlagByName('KHY_A2A_EXECUTOR', false);
}

/**
 * 取结构化工具循环；不可用/未启用 → null（调用方据此落 failed，不回退成回显）。
 * 判定顺序与 ilinkDispatcher._resolveToolLoop 同口径：模块缺失、缺入口、isEnabled()
 * 为假，三者任一都算不可用。
 * @returns {object|null}
 */
function resolveToolLoop() {
  try {
    const loop = require('../tool/toolUseLoop');
    if (loop && typeof loop.runToolUseLoop === 'function') {
      if (typeof loop.isEnabled === 'function' && !loop.isEnabled()) return null;
      return loop;
    }
  } catch {
    /* 运行时不可用：由调用方诚实落 failed，不假装跑过 */
  }
  return null;
}

/**
 * 取 chat 管线（与 agentclient/agentServer 同口径：cli/ai 的 chat）。
 * 取不到 → null。
 * @returns {Function|null}
 */
function resolveChat() {
  try {
    const ai = require('../../cli/ai');
    return typeof ai.chat === 'function' ? (message, chatOpts) => ai.chat(message, chatOpts) : null;
  } catch {
    return null;
  }
}

/** 读一个可选的迭代上限（env KHY_A2A_MAX_ITERATIONS）；未设/非法 → undefined（用循环自己的预算）。 */
function resolveMaxIterations() {
  const raw = Number(process.env.KHY_A2A_MAX_ITERATIONS);
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.floor(raw);
}

/**
 * 构造 agent 执行器。
 * @param {object} [opts]
 * @param {Function} [opts.chat]    注入 chat（测试用；缺省懒加载 cli/ai.chat）
 * @param {object} [opts.runLoop]   注入工具循环（测试用 stub；缺省懒加载真身）
 * @returns {Function} executor(task, params, ctx)
 */
function createAgentExecutor(opts = {}) {
  const injectedChat = typeof opts.chat === 'function' ? opts.chat : null;
  const injectedLoop = opts.runLoop && typeof opts.runLoop.runToolUseLoop === 'function' ? opts.runLoop : null;
  const maxIterations = resolveMaxIterations();

  return async function agentExecutor(task, params, ctx) {
    const text = extractMessageText(params);
    if (!text) {
      throw new Error('message/send 缺少 text part：没有可驱动的输入，任务不会空跑');
    }

    const loop = injectedLoop || resolveToolLoop();
    if (!loop) {
      throw new Error('agent 运行时不可用（toolUseLoop 未启用或加载失败）：请检查 khy doctor，或临时保持 KHY_A2A_EXECUTOR 关闭走回显');
    }
    const chat = injectedChat || resolveChat();
    if (!chat) {
      throw new Error('chat 管线不可用（cli/ai 加载失败）：请运行 khy doctor 检查网关配置');
    }

    const onProgress = ctx && typeof ctx.onProgress === 'function' ? ctx.onProgress : null;
    const result = await loop.runToolUseLoop(text, {
      chat,
      chatOpts: {
        // 出处标记进 journal/receipt：达成率的分母要把入站 A2A 任务与真人请求分开。
        turnSource: 'a2a',
        // 每个任务独立 sessionId：外部任务之间不共享对话历史。
        // 注意它只影响 trace/journal —— 进程级 live 历史（_chatState.messages）是单槽，
        // 隔离要靠 scopeSession()，而那个调用会切全局单槽：并发入站任务互相踩历史。
        // 故本执行器**不调** scopeSession（多任务隔离留作后续，见工单 open 项）。
        sessionId: `a2a:${task.id}`,
      },
      ...(maxIterations ? { maxIterations } : {}),
      onIteration: (iteration, totalCalls) => {
        if (!onProgress) return;
        onProgress('working', {
          message: `执行 agent 循环：第 ${iteration} 次迭代（工具调用 ${totalCalls} 次）`,
        });
      },
      // 刻意不传 onControlRequest：无交互面 → 权限闸门 fail-closed（见文件头）。
    });

    const finalText = String((result && result.finalResponse) || '').trim();
    // 循环自陈「没跑完」的返回面（读 toolUseLoopCore 的各 return 归纳）：
    //   - maxIterationsReached / timeLimitReached / truncated：撞迭代预算或时间上限
    //   - loopDetected / consecutiveFailureBailout：循环检测或工具连续失败后退出
    //   - stopped / errorType：AI 出错、工具被审批拒绝、通道穷尽（含 errorType 的诊断文本）
    // 这些都必须落 failed 并把循环的诚实收尾原文带给调用方 —— 落 completed 等于向
    // 外部 orchestrator 谎报任务成功。recoveredFromInterruptedChannel 是恢复后确实
    // 交了答案的路径，不算失败。
    const cancelled = !!(result && (result.cancelled || result.interrupted));
    const unfinished =
      !!result &&
      !cancelled &&
      !result.recoveredFromInterruptedChannel &&
      (result.maxIterationsReached ||
        result.timeLimitReached ||
        result.truncated ||
        result.loopDetected ||
        result.consecutiveFailureBailout ||
        result.stopped ||
        result.errorType);

    if (cancelled) {
      return {
        state: 'canceled',
        text: finalText || '任务已被取消。',
      };
    }
    if (!finalText) {
      return {
        state: 'failed',
        text: 'agent 循环没有产出最终文本：可能模型无输出或端点异常，请运行 khy gateway status 检查通道',
      };
    }
    if (unfinished) {
      const reason = result.errorType ? `（${result.errorType}）` : '';
      return {
        state: 'failed',
        text: `${finalText}\n\n${reason}未完成：可把任务拆小重试、检查通道后重试，或调大 KHY_A2A_MAX_ITERATIONS`,
      };
    }
    return {
      state: 'completed',
      text: finalText,
      artifacts: [
        { artifactId: `art_${task.id}`, name: 'agent-response', parts: [{ kind: 'text', text: finalText }] },
      ],
    };
  };
}

/**
 * 启动代码调用：门控开 → 用真 executor 重建方法组并装进路由；门控关 → 什么都不做
 * （默认回显 executor 原样生效）。
 * @param {object} [opts]
 * @param {object} [opts.route]  routes/a2a 模块（缺省懒加载）
 * @param {object} [opts.deps]   透传给 createAgentExecutor 的依赖（测试注入 stub 循环用）
 * @returns {{ installed: boolean, reason?: string }}
 */
function installServerExecutor(opts = {}) {
  if (!isExecutorEnabled()) return { installed: false, reason: 'gate-off' };
  let route = opts.route || null;
  if (!route) {
    try {
      route = require('../../routes/a2a');
    } catch (err) {
      return { installed: false, reason: `route-load-failed: ${err && err.message}` };
    }
  }
  if (typeof route.setServerMethods !== 'function') {
    return { installed: false, reason: 'route-missing-setter' };
  }
  const { createServerMethods } = require('./serverMethods');
  route.setServerMethods(createServerMethods({ executor: createAgentExecutor(opts.deps || {}) }));
  return { installed: true };
}

module.exports = {
  isExecutorEnabled,
  createAgentExecutor,
  installServerExecutor,
};
