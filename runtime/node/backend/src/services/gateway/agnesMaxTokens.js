'use strict';

/**
 * agnesMaxTokens — 纯叶子:把发往 Agnes 网关的 `max_tokens` 钳到网关硬上限
 * (默认 65536),避免上游返回 400「max_tokens 不能超过 65536」。
 *
 * 背景 / 实测根因(与 ZCode 侧同源):
 *   Agnes 网关(国际站 apihub.agnes-ai.com / 中国站 api.agnes-ai.cn)对 chat
 *   completions 的 max_tokens 有 65536 硬上限。ZCode 侧因模型规则缺
 *   maxOutputTokens 覆盖、继承内置通配规则的 128000,每轮请求直接 400。
 *   khyos 侧同构风险:gateway/maxTokensPolicy 只认 contextWindow /
 *   maxOutputTokens 元数据,而 Agnes 在 khyos 无任何元数据(providerPresets
 *   无 defaults、/v1/models 不报上限)→ 策略对 Agnes 实际放行,调用方
 *   (经本地代理的 agent CLI / khy CLI / 自定义集成)显式携带的更高值会
 *   原样到达上游,撞同一条上限。
 *
 * 本叶子只做一件事:命中 Agnes 目标(模型名或端点主机判定)时,把请求的
 * max_tokens 收进 [1, 上限];其余模型/端点原样透传,不改任何行为。
 * 与 glmVisionMaxTokens(GLM 视觉 [1,1024] 钳位)同款同源:
 *   - 门控 KHY_AGNES_MAX_TOKENS_CLAMP 默认开;0/false/off/no → 关;
 *   - 关门 / 异常 / 非 Agnes → 原样透传 requested(逐字节回退今日行为);
 *   - 上限默认 65536,可用 KHY_AGNES_MAX_TOKENS 覆盖(两站上限若分化或官方
 *     调整,单点旋钮即可,不必改码)。
 *
 * 与 GLM 先例的有意差异:非有限值(undefined/NaN/≤0)→ 原样透传而非送上限。
 * khyos 内部各调用方的默认值均 ≤4096(generateResponse 1024 / analyze 1500 /
 * proxyServer 低档 4096),无高默认值隐患,透传即零行为变化;只有显式超上限
 * 的值才被钳。
 *
 * 纯函数:除 env 读取外零副作用、绝不抛。
 */

const DEFAULT_AGNES_MAX_TOKENS = 65536;

/**
 * 门控 KHY_AGNES_MAX_TOKENS_CLAMP:默认开;0/false/off/no → 关。异常 → 关门(false)。
 * @param {object} [env]
 * @returns {boolean}
 */
function clampEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_AGNES_MAX_TOKENS_CLAMP;
    if (raw == null || String(raw).trim() === '') {
      return true;
    } // 缺省 → 默认开
    const v = String(raw).trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  } catch {
    return false;
  }
}

/**
 * 上限旋钮 KHY_AGNES_MAX_TOKENS:正整数生效;解析失败 → 回退默认 65536。
 * @param {object} [env]
 * @returns {number}
 */
function resolveCap(env = process.env) {
  try {
    const n = Number(env && env.KHY_AGNES_MAX_TOKENS);
    if (Number.isFinite(n) && n > 0) {
      return Math.floor(n);
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_AGNES_MAX_TOKENS;
}

/**
 * 模型名是否命中 Agnes 家族(容忍 provider 前缀: `agnes/agnes-3.0-flash`、
 * `api:agnes:agnes-2.0-flash` 均命中)。与端点判定取并集。
 * @param {string} model
 * @returns {boolean}
 */
function isAgnesModelName(model) {
  const m = String(model || '')
    .trim()
    .toLowerCase();
  if (!m) {
    return false;
  }
  const bare = m.split(/[:/]/).pop();
  return bare.startsWith('agnes-');
}

/**
 * 端点主机是否命中 Agnes 网关(国际站 + 中国站)。
 * 纯主机探测:域名仅作 endsWith 比较操作数,同一行无 http(s):// URL
 * (RUNTIME-001 豁免);解析失败(空串/非 URL)→ false。
 * @param {string} endpoint
 * @returns {boolean}
 */
function isAgnesEndpoint(endpoint) {
  try {
    const host = new URL(String(endpoint || '')).hostname.toLowerCase();
    if (!host) {
      return false;
    }
    return host.endsWith('agnes-ai.com') || host.endsWith('agnes-ai.cn');
  } catch {
    return false;
  }
}

/** 模型名或端点任一命中即视为 Agnes 目标。 */
function isAgnesTarget(model, endpoint) {
  return isAgnesModelName(model) || isAgnesEndpoint(endpoint);
}

/**
 * 若目标是 Agnes 网关且门控开,把 max_tokens 钳到 [1, cap];否则原样返回 requested。
 * @param {string} model              目标模型串(可带 provider 前缀)
 * @param {number|undefined} requested 调用方拟发送的 max_tokens
 * @param {object} [env]              环境(默认 process.env)
 * @param {string} [endpoint]         目标端点 baseUrl(模型名未命中时兜底判定)
 * @returns {number|undefined}        钳位后的值;不命中/门关/非有限值 → 原样透传
 */
function clampMaxTokensForAgnes(model, requested, env = process.env, endpoint = '') {
  try {
    if (!clampEnabled(env)) {
      return requested;
    }
    if (!isAgnesTarget(model, endpoint)) {
      return requested;
    }
    // 非有限数(undefined / null / NaN / ≤0)→ 原样透传:内部默认值均 ≤4095,
    // 无 GLM 那条「高默认值误发」隐患,透传即零行为变化。
    const n = Number(requested);
    if (!Number.isFinite(n) || n <= 0) {
      return requested;
    }
    return Math.min(Math.floor(n), resolveCap(env));
  } catch {
    return requested;
  }
}

module.exports = {
  clampMaxTokensForAgnes,
  clampEnabled,
  resolveCap,
  isAgnesModelName,
  isAgnesEndpoint,
  isAgnesTarget,
  AGNES_MAX_TOKENS: DEFAULT_AGNES_MAX_TOKENS,
};
