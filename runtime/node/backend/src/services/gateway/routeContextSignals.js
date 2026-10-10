'use strict';

/**
 * routeContextSignals — 把 §5.1「风险定价」需要的**执行状态输入**从真实请求上下文里取出来。
 *
 * 为什么存在（不是锦上添花）：`routeDemand.decide` 收 `ctxRatio` / `estCtxTokens` / `toolFails`
 * 三个入参，但 [DESIGN-ARCH-185] §16.4n 实测**全仓没有任何生产方**（逐 key grep 赋值点为 0），
 * 于是四道 pass 事实上退化成「只看用户这句话」—— 与 §15-2「不做 query 级路由」直接相抵。
 * 论文 P1 的核心论点就是 query-only 看不到执行状态；本叶子补的就是「看不见」的那一侧。
 *
 * 两条刻意不自造的原则：
 *   - **不造第二套 token 估算**：口径走 `contextDiagnostics.diagnoseContext`
 *     （全管线：WASM 估算优先，char/4 兜底）。另写一个 char/4 会让「占用」在
 *     压缩器、诊断、路由三处各算一遍且互不相等（RUNTIME-002 的同类病）。
 *   - **不自己数 error 字样**：工具失败读既有 `is_error` 标记。
 *     `contentBlockUtils.ensureToolResultPairing` 会显式把「为回收上下文而丢弃」的
 *     结果标成 `is_error:false`（注释里写明这是刻意的），所以 `is_error===true`
 *     只可能是真失败 —— 按文本猜会把被丢弃的历史算成失败，方向正好相反。
 *
 * 契约（与全仓纯叶子一致）：零 IO（不碰 fs/网络/子进程/时钟/随机），确定性，绝不抛。
 * 窗口不可知时 `ctxRatio` 返回 **null**（不是 0）—— 0 会被下游当成「上下文很空」而误判。
 */

/** 数真失败的工具结果：顶层 is_error 与 content 数组里的 tool_result 块都算。 */
function _countToolFails(list) {
  let n = 0;
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    if (m.is_error === true) {
      n += 1;
      continue;
    }
    const c = m.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b && typeof b === 'object' && b.is_error === true) n += 1;
    }
  }
  return n;
}

/**
 * @param {Array} messages  真实对话历史（可为 undefined / 非数组 ⇒ 视作空）
 * @param {{contextWindow?:number, systemPrompt?:string, userPrompt?:string}} [opts]
 * @returns {{estCtxTokens:(number|null), ctxRatio:(number|null), toolFails:number}}
 */
function derive(messages, opts = {}) {
  try {
    const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
    const cw = Number(opts && opts.contextWindow);
    const window = Number.isFinite(cw) && cw > 0 ? cw : 0;
    let estCtxTokens = null;
    let ctxRatio = null;
    const sys = typeof (opts && opts.systemPrompt) === 'string' ? opts.systemPrompt : '';
    const usr = typeof (opts && opts.userPrompt) === 'string' ? opts.userPrompt : '';
    if (list.length > 0 || sys || usr) {
      const diag = require('../contextDiagnostics').diagnoseContext(list, {
        contextWindow: window,
        systemPrompt: sys,
        userPrompt: usr,
      });
      const t = diag && diag.tokens ? diag.tokens : null;
      if (t && Number.isFinite(t.total)) {
        estCtxTokens = t.total;
        // diagnoseContext 在无窗口时把 usageRatio 记成 0；这里换成 null，
        // 因为「不知道占比」和「占比为 0」对路由是两个不同的事实。
        ctxRatio = t.window > 0 ? t.usageRatio : null;
      }
    }
    return { estCtxTokens, ctxRatio, toolFails: _countToolFails(list) };
  } catch {
    return { estCtxTokens: null, ctxRatio: null, toolFails: 0 };
  }
}

module.exports = { derive };
