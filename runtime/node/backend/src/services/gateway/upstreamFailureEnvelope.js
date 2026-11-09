'use strict';

/**
 * upstreamFailureEnvelope.js — 纯叶子：判断「上游是否已经渲染好 CLI 失败信封」。
 *
 * 背景（[DESIGN-ARCH-198] §2.5，2026-11-01 用户实测）：RUNTIME-005 已要求
 * 「CLI / TUI 的失败展示**必须**由结构化失败信封渲染」，`cliFailureEnvelope.js` 也已实现，
 * 门 `KHY_CLI_FAILURE_ENVELOPE` 默认开、渲染正确（实测同一份 attempts 给出
 * `[AUTH_FAILED]` + 「运行 `ai config` 检查/更新该通道的 API key」）。
 *
 * **断桥在中间一层**：`aiChatCore.chat()` 在网关失败时**已经把信封渲染好**并随
 * `reply` + `failureCode` 返回；而 `toolUseLoopCore` 的错误收口**弃之不用**，
 * 改从 `failureDetails` 重新拼散文墙 → 用户看到的是
 * 「具体原因：真实失败原因: - kiro [unavailable]: …」压扁的一行，
 * 信封首屏的机器码 / 通道名 / 可执行 hint 全丢。
 *
 * 本叶子只回答一件事：**这份 `aiResult` 里，信封是不是已经渲染好了？**
 * 判别信号 = `failureCode` **存在且非空** ——
 * 它**只**在 `aiChatCore` 的信封分支被写入（`aiChatCore.js` 的
 * `failureCode: _env0.code`），老散文分支**不写**。
 * 故它是「上游已渲染信封」的**可靠**判别式，而不必去嗅探文本（嗅探会误判：
 * 老散文里也可能出现方括号）。
 *
 * 契约（与全仓纯叶子一致）：
 *   - 零 IO、确定性、绝不抛；
 *   - 门控 `KHY_TUI_FAILURE_ENVELOPE`（默认开；关 → 一律判定为「未渲染」，
 *     调用方逐字节回退今日散文墙路径）。
 */

/** 门控是否启用。flagRegistry 优先（集中真源），失败/不可用 → 本地 CANON 回退。 */
function isEnabled(env = process.env) {
  try {
    const reg = require('../flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(env) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_TUI_FAILURE_ENVELOPE', env);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const raw = (env && env.KHY_TUI_FAILURE_ENVELOPE) === undefined ? 'true' : env.KHY_TUI_FAILURE_ENVELOPE;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * 这份失败结果里，上游是否已渲染好 CLI 失败信封？
 *
 * @param {object} aiResult  失败结果对象（aiChatCore.chat() 的返回）
 * @param {object} [env]     注入 env（可测）
 * @returns {boolean} true = 上游已渲染信封，调用方**应当沿用**其首屏
 */
function hasRenderedEnvelope(aiResult, env = process.env) {
  try {
    if (!isEnabled(env)) {
      return false;
    }
    if (!aiResult || typeof aiResult !== 'object') {
      return false;
    }
    // 机器码存在且非空 —— 只在信封分支写入（见文件头）。
    const code = typeof aiResult.failureCode === 'string' ? aiResult.failureCode.trim() : '';
    if (!code) {
      return false;
    }
    // 且首屏确实带那个机器码 —— 防止「带了 code 但正文不是信封」的畸形返回。
    const reply = typeof aiResult.reply === 'string' ? aiResult.reply : '';
    if (!reply) {
      return false;
    }
    return reply.includes(`[${code}]`);
  } catch {
    return false;
  }
}

/**
 * 若上游已渲染信封，把 `reply` 拆成「信封首屏」+「其余（旧诊断墙 = 展开层）」。
 *
 * 拆法：信封首屏 = reply 开头到**首个空行**为止；其后是旧诊断墙。
 * 拆出来是为了**保证信封在前**（即使某个上游把信封放在中段也不会倒置），
 * 同时**不丢**后面的墙 —— 信息量不减（[DESIGN-ARCH-198] §4.1）。
 *
 * @param {object} aiResult
 * @param {object} [env]
 * @returns {{head:string, rest:string}|null} null = 上游没给信封 → 调用方走今日路径
 */
function splitRenderedEnvelope(aiResult, env = process.env) {
  try {
    if (!hasRenderedEnvelope(aiResult, env)) {
      return null;
    }
    const reply = String(aiResult.reply || '');
    const code = String(aiResult.failureCode || '').trim();
    const lines = reply.split('\n');
    const headLines = [];
    let i = 0;
    for (; i < lines.length; i += 1) {
      if (lines[i].trim() === '') {
        break;
      }
      headLines.push(lines[i]);
    }
    const head = headLines.join('\n').trim();
    if (!head || !head.includes(`[${code}]`)) {
      return null;
    }
    // 首个空行之后 = 展开层（去掉开头那个空行本身）。
    const rest = lines
      .slice(i)
      .join('\n')
      .replace(/^\n+/, '')
      .trim();
    return { head, rest };
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  hasRenderedEnvelope,
  splitRenderedEnvelope,
};
