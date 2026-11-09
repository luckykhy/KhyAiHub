'use strict';

/**
 * repeatedPromptRounds.js — 识别「同一请求被重复发送的轮次」(单一真源,纯叶子)。
 *
 * 背景(goal 2026-06-25):用户在用 Khyos 开发时,会**重复发送基本相同的提示词**,本意是
 * 「在上一轮成果的基础上继续往前推进 / 换个角度再挖一层」。但弱模型常把这理解成「这事我
 * 已经做完了」而原地复述上一轮的结论,甚至直接回一句「已经做完了」。用户的诉求很明确:
 *
 *   「如果在我重复发送相同提示词时 khyos 要知道这是第一轮、第二轮、第三轮,
 *     而不是说我已经做完了。」
 *
 * 本模块只做一件事:给定当前 user 提示词 + 历史 user 轮次,**无状态地数出这是第几轮重复**,
 * 并产出一条 `[SYSTEM]` 指令,告诉模型「这是第 N 轮,请继续深入而非声称已完成」。
 *
 * 设计要点:
 *   - **无状态**:轮次完全从对话历史(initialMessages 里的历史 user 轮)派生,不持有跨请求
 *     状态。历史被 compaction 截断会少数几轮 → 保守退化(只会少报,不会误报),可接受。
 *   - **纯叶子**:零 IO、确定性、可单测。判同主要靠 normalize 后的精确相等;模糊兜底用字符
 *     二元组 Jaccard,既能容忍尾随「,继续」之类的小改动,又对 CJK/拉丁混排都成立。
 *   - **只增不减**:仅在 round≥2 注入提示;round=1(首次)返回 null,对正常单次请求零影响。
 *
 * env:
 *   KHY_PROMPT_ROUND_TRACKER = (默认开) 0 | false | off 关闭 → countRound 恒为 1、不注入。
 *   KHY_PROMPT_ROUND_SIM     = 模糊判同的 Jaccard 阈值(默认 0.9;精确相等始终判同)。
 */

function isEnabled(env = process.env) {
  const v = env && env.KHY_PROMPT_ROUND_TRACKER;
  return !(v === '0' || v === 'false' || v === 'off');
}

function _simThreshold(env) {
  const v = Number(env && env.KHY_PROMPT_ROUND_SIM);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.9;
}

/** 归一化:转字符串、去首尾空白、小写、折叠内部连续空白为单空格。 */
function normalize(text) {
  return String(text == null ? '' : text)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** 字符二元组集合(模糊判同用)。单字符串本身回退为单元素集。 */
function _bigrams(s) {
  const set = new Set();
  if (s.length <= 1) {
    if (s) {
      set.add(s);
    }
    return set;
  }
  for (let i = 0; i < s.length - 1; i++) {
    set.add(s.slice(i, i + 2));
  }
  return set;
}

/** 两段文本的相似度 ∈ [0,1]:归一精确相等→1;否则字符二元组 Jaccard。 */
function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na && !nb) {
    return 1;
  }
  if (!na || !nb) {
    return 0;
  }
  if (na === nb) {
    return 1;
  }
  const A = _bigrams(na);
  const B = _bigrams(nb);
  if (!A.size || !B.size) {
    return 0;
  }
  let inter = 0;
  for (const g of A) {
    if (B.has(g)) {
      inter++;
    }
  }
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}

/** 是否「同一请求」:归一精确相等,或模糊相似度 ≥ 阈值。 */
function isSamePrompt(a, b, env = process.env) {
  if (normalize(a) === normalize(b)) {
    return true;
  }
  return similarity(a, b) >= _simThreshold(env);
}

/**
 * 「剥离系统注入旁注」门（[DESIGN-ARCH-198] W2 / KHY_PROMPT_ROUND_UNPOLLUTED）。
 * 默认开；关 → **逐字节**回退今日行为（不剥离，轮次照旧饱和在 2）。
 * flagRegistry 优先（集中真源），失败/不可用 → 本地 CANON 回退。
 */
function _unpollutedEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('./flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_PROMPT_ROUND_UNPOLLUTED', e);
    }
  } catch {
    /* 注册表不可用 → 本地 CANON */
  }
  const raw = e.KHY_PROMPT_ROUND_UNPOLLUTED;
  const v = String(raw === undefined || raw === null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * 从消息数组里抽取历史 user 轮次的文本(role==='user')。
 *
 * ⚠ [DESIGN-ARCH-198] §2.1（W2）：**必须剥掉系统注入旁注**再返回。
 * 工具循环会把旁注（如「[SYSTEM] 重复请求识别:…」）混装进 user 消息并回灌进
 * `initialMessages`（那既是模型上下文、也是下一轮计数的输入源）。
 * 若拿混装文本去跟**干净**的新提示词比，字符二元组 Jaccard = 0.0476 ≪ 阈值 0.9
 * → 判「不同请求」→ 重复计数不增 → 轮次**饱和在 2**（实测连发 4 次同款恒为 1/2/2/2，
 * 真值 1/2/3/4）。界面上永远只显示「第 2 次」，模型自己却数出「第 3 轮」——互相矛盾。
 *
 * 剥的是**旁注**（给模型看的），留的是**用户原话**（判定要看真话）。
 * 门 `KHY_PROMPT_ROUND_UNPOLLUTED` 关 → 不剥离 → 逐字节回退今日行为。
 */
function priorUserTextsFrom(messages, env = process.env) {
  if (!Array.isArray(messages)) {
    return [];
  }
  let strip = null;
  if (_unpollutedEnabled(env)) {
    try {
      strip = require('./promptScaffolding').stripLeadingInjectedScaffold;
    } catch {
      strip = null;
    }
  }
  const out = [];
  for (const m of messages) {
    if (m && m.role === 'user') {
      const raw =
        typeof m.content === 'string'
          ? m.content
          : JSON.stringify(m.content == null ? '' : m.content);
      out.push(strip ? strip(raw) : raw);
    }
  }
  return out;
}

/**
 * 当前提示词是第几轮重复 = 1 + 历史 user 轮里与当前「同一请求」的条数。
 * 首次发送(无历史同款)→ 1。关闭或空提示 → 1。
 * @param {string} currentText
 * @param {string[]} priorUserTexts  历史 user 轮文本(通常来自 priorUserTextsFrom(initialMessages))
 */
function countRound(currentText, priorUserTexts, env = process.env) {
  if (!isEnabled(env)) {
    return 1;
  }
  // ⚠ [DESIGN-ARCH-198] §2.1（W2）：当前提示词**也可能**带着上一轮的注入旁注
  // （工具循环把它前置进 currentMessage 后又回灌）。两侧都剥，判定才对称。
  // 门 KHY_PROMPT_ROUND_UNPOLLUTED 关 → 不剥 → 逐字节回退今日行为。
  let _cur = currentText;
  if (_unpollutedEnabled(env)) {
    try {
      _cur = require('./promptScaffolding').stripLeadingInjectedScaffold(currentText);
    } catch {
      /* 叶子不可用 → 用原值（行为等价于今日） */
    }
  }
  if (!normalize(_cur)) {
    return 1;
  }
  const arr = Array.isArray(priorUserTexts) ? priorUserTexts : [];
  let repeats = 0;
  for (const p of arr) {
    // ⚠ [DESIGN-ARCH-198] §2.1（W2）：**历史侧也必须剥**。
    // priorUserTextsFrom 已剥过一次，但 countRound 是公开叶子、可能被**直接**喂入
    // 未剥的历史（如调用方自持 initialMessages）→ 两侧都剥，判定才对称、
    // 才不会出现「只剥一半」的隐性不一致。
    let _prior = p;
    if (_unpollutedEnabled(env)) {
      try {
        _prior = require('./promptScaffolding').stripLeadingInjectedScaffold(p);
      } catch {
        /* 叶子不可用 → 用原值 */
      }
    }
    if (isSamePrompt(_cur, _prior, env)) {
      repeats++;
    }
  }
  return repeats + 1;
}

const _ORDINAL = [
  '第一轮',
  '第二轮',
  '第三轮',
  '第四轮',
  '第五轮',
  '第六轮',
  '第七轮',
  '第八轮',
  '第九轮',
];
function _ordinal(n) {
  return _ORDINAL[n - 1] || `第 ${n} 轮`;
}

/**
 * 产出注入给模型的 `[SYSTEM]` 指令:告诉它这是同一请求的第 N 轮重复,**不要回答「已经做完了」**,
 * 而要把重复当作「在已完成的基础上继续深入 / 换角度 / 找出还没覆盖到的部分」。round≤1 返回 null。
 * @param {number} round
 * @returns {string|null}
 */
function buildRoundHint(round, env = process.env) {
  if (!isEnabled(env)) {
    return null;
  }
  if (!(round >= 2)) {
    return null;
  }
  const ord = _ordinal(round);
  return (
    `[SYSTEM] 重复请求识别:用户已第 ${round} 次发送基本相同的请求(这是${ord})。` +
    `这通常不是要你回答「已经做完了」,而是希望你在上一轮成果之上继续推进。请在本轮:` +
    `①明确说明这是${ord};②给出与前几轮不重复的新进展、更深一层的实现,或换一个角度的处理;` +
    `③只有当你确信确实再无可做时,才明确说「已穷尽,无新增可做」并给出依据,而不是笼统地说「已完成」。`
  );
}

module.exports = {
  isEnabled,
  normalize,
  similarity,
  isSamePrompt,
  priorUserTextsFrom,
  countRound,
  buildRoundHint,
};
