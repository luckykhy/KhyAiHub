'use strict';

/**
 * promptScaffolding.js — 纯叶子：剥掉用户消息里的「系统注入旁注」。
 *
 * 背景（[DESIGN-ARCH-198] §2.1，2026-11-01 用户实测）：工具循环会把各种系统旁注
 * **前置或后置进**本轮 user 消息（重复请求轮次提示、capability precheck、计划指令…），
 * 然后这条**混装**的消息被 push 进 `conversationMessages` —— 而它同时就是**下一轮**的
 * `initialMessages`（模型上下文）。
 *
 * 于是「数用户重复发了几次同一请求」的计数器拿到的是**混装文本**：
 *   干净提示词  vs  「[SYSTEM] 重复请求识别:…\n\n干净提示词」
 * 字符二元组 Jaccard = 0.0476 ≪ 阈值 0.9 → 判「不同请求」→ 重复计数**不增**
 * → 轮次**饱和在 2**（实测连发 4 次同款恒为 1/2/2/2，真值 1/2/3/4）。
 * 界面上永远只显示「第 2 次」，而模型自己数出「第 3 轮」——两者互相矛盾。
 *
 * 为什么在这里剥、而不是「不让它进历史」：
 *   那条混装消息**必须**留在模型上下文里（旁注就是给模型看的），
 *   且旁注种类繁多（不止轮次提示），逐类从注入点剥离 = 改巨型文件的多个注入点。
 *   而**计数**只需要「用户原话」。故正确的切分是：
 *   **上下文保留混装（模型要看到），计数只看原话（判定要看真话）。**
 *
 * 剥离判据（刻意保守，宁可少剥不可错剥）：
 *   注入形态恒为 `<一行 [SYSTEM… 旁注>\n\n<用户原话>` —— **必须有那个空行分隔符**
 *   （注入点就是 `${hint}\n\n${message}` 拼的）。故只认「行首 [SYSTEM … + 空行」这一形态。
 *   用户自己敲的普通文本（含正文里的 [SYSTEM 字样）**不动**。
 *
 * 契约：零 IO、确定性、绝不抛、纯函数。
 */

/** 注入形态：行首一行 `[SYSTEM…]` 旁注，紧跟一个空行分隔符。 */
const _INJECTED_LEAD_RE = /^\[SYSTEM[^\n]*\n\n/;

/**
 * 剥掉用户消息**开头**的系统注入旁注；没有则原样返回。
 *
 * 多个旁注叠加时反复剥（注入点可能多层前置）。
 *
 * @param {string} text
 * @returns {string}
 */
function stripLeadingInjectedScaffold(text) {
  const s = text == null ? '' : String(text);
  if (!s) {
    return s;
  }
  let out = s;
  // 上限 8 层：防御性上界，避免任何异常形态下死循环。
  for (let i = 0; i < 8; i += 1) {
    const m = _INJECTED_LEAD_RE.exec(out);
    if (!m) {
      break;
    }
    out = out.slice(m[0].length);
  }
  return out;
}

/**
 * 消息文本是否**只**是系统注入旁注（剥完为空）—— 用于识别「这条 user 消息其实不是人说的」。
 *
 * @param {string} text
 * @returns {boolean}
 */
function isOnlyInjectedScaffold(text) {
  const s = text == null ? '' : String(text);
  if (!s) {
    return false;
  }
  return _INJECTED_LEAD_RE.test(s) && stripLeadingInjectedScaffold(s).trim() === '';
}

module.exports = {
  stripLeadingInjectedScaffold,
  isOnlyInjectedScaffold,
};
