'use strict';

/**
 * upstreamTruthLabel.js — 纯叶子：把「上游自己写明的真因」提炼成一行可读标签。
 *
 * 背景（用户实测）：429/5xx 的上游故障体被 classifyAdapterError 归成 network
 * （TRANSIENT_STATUS_CODES 先命中，见 adapters/_errorClassifiers.js:21 与 :159 的
 * isTransientError），失败墙于是把上游明明写清楚的
 * `server_error: Upstream request failed: Endpoint is unavailable.` 显示成 `[network]`，
 * 把用户带去查网络/代理——排障方向整个跑偏。同一族还有：`Model … is not supported`
 * 的 401 被归成 auth，用户以为是自己 key 坏了。
 *
 * 这个**内部类别不能改**：network 在熔断排除集里（aiGatewayCooldownMethods.js:347），
 * 正是「歇一会自动恢复」能生效的原因；改成 server_error 反而会被熔断到 30s~300s。
 * 所以本叶子只在**展示层**补真因，一个字都不动重试语义。
 *
 * 零 IO / 确定性 / 绝不抛。门控 KHY_UPSTREAM_TRUTH_LABEL（默认开；取 0/false/off/no 关闭
 * → 全部返回 null，调用方逐字节回退到今日文案）。
 */

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控是否启用。env 不存在时按默认开（与仓内其它默认开门一致）。 */
function isEnabled(env) {
  const v = String((env && env.KHY_UPSTREAM_TRUTH_LABEL) || '')
    .trim()
    .toLowerCase();
  return !_OFF.has(v);
}

// 类别本身掩盖了上游真因的两个集合。其余类别（timeout/rate_limit/process…）已自证真因，
// 再补只会更吵。
//   generic：命中已知语义 → 用语义标签；认不出但上游给了结构化 error.type → 端类型名上来，
//            总比裸 [network] 具体。
//   ruleOnly：这类类别默认是准确的（auth/bad_request），**只有**命中已知语义时才改写——
//            否则上游真在报「key 无效」时会被无意义地覆盖。
const _GENERIC_TYPES = new Set(['', 'network', 'unknown', 'server_error']);
const _RULE_ONLY_TYPES = new Set(['auth', 'bad_request']);

// 已知上游语义 → 中文标签 + 一句可操作建议。顺序敏感：更具体的在前。
const _RULES = [
  {
    re: /endpoint is unavailable|upstream request failed/i,
    label: '上游端点不可用',
    transient: true,
    advice: '属瞬态，稍后重试可自愈；也可 /model 换一个更稳的通道',
  },
  {
    re: /free tier can only be used|freetiererror/i,
    label: '免费层客户端校验未通过',
    transient: false,
    advice: '该免费层要求 OpenCode 客户端指纹，需改用其它通道',
  },
  {
    re: /not supported|unsupported model|modelerror/i,
    label: '该模型不被上游支持',
    transient: false,
    advice: '该模型已在上游下线，请 /model 换一个模型',
  },
];

/** 只解析 OpenAI 风格 JSON 错误体；非 JSON / 解析失败 → null。绝不抛。 */
function _parseBody(raw) {
  const s = String(raw || '').trim();
  if (!s || s[0] !== '{') {
    return null;
  }
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/** 取 body.error（OpenAI / OpenCode Zen 两种信封都落在 error 字段）。 */
function _errField(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const e = body.error;
  return e && typeof e === 'object' ? e : null;
}

/**
 * 从上一条原始错误串提炼上游真因。
 *
 * @param {*} raw 原始错误串（多为上游 JSON body）
 * @param {object} [opts]
 * @param {string} [opts.errorType] 已归类的 errorType
 * @param {object} [opts.env] 注入 env（可测）
 * @returns {{label:string, message:string, advice:string, transient:boolean}|null}
 *          无法提炼（门关 / 类别已自证 / 认不出）→ null
 */
function describeUpstream(raw, opts = {}) {
  try {
    const env = opts.env || (typeof process !== 'undefined' ? process.env : {});
    if (!isEnabled(env)) {
      return null;
    }
    const type = String(opts.errorType || '')
      .trim()
      .toLowerCase();
    if (!_GENERIC_TYPES.has(type) && !_RULE_ONLY_TYPES.has(type)) {
      return null;
    }
    const text = String(raw == null ? '' : raw);
    if (!text.trim()) {
      return null;
    }

    const body = _parseBody(text);
    const errf = _errField(body);
    const upstreamType = errf ? String(errf.type || '').trim() : '';
    const upstreamMsg = errf ? String(errf.message || '').trim() : '';
    const hay = `${upstreamType} ${upstreamMsg} ${text}`;

    for (const r of _RULES) {
      if (r.re.test(hay)) {
        return { label: r.label, message: upstreamMsg, advice: r.advice, transient: r.transient };
      }
    }

    // 认不出语义：只在 generic 类别上退回「上游 <type>」。ruleOnly 类别保持原样，
    // 免得把一次真实的 [auth] 覆盖成没人看得懂的 `上游 invalid_request_error`。
    if (upstreamType && _GENERIC_TYPES.has(type)) {
      return { label: `上游 ${upstreamType}`, message: upstreamMsg, advice: '', transient: false };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 从 gateway 的 attempts[] 里找出第一条能提炼出真因的失败项。
 * 展示层与失败文案都用它，避免各处重复扫描。
 *
 * @param {Array<object>} attempts
 * @param {object} [opts] { env }
 * @returns {{label:string, message:string, advice:string, transient:boolean}|null}
 */
function describeFromAttempts(attempts, opts = {}) {
  try {
    if (!Array.isArray(attempts)) {
      return null;
    }
    for (const a of attempts) {
      if (!a || a.success !== false) {
        continue;
      }
      const d = describeUpstream(a.error || a.message, {
        errorType: a.errorType,
        env: opts.env,
      });
      if (d) {
        return d;
      }
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  describeUpstream,
  describeFromAttempts,
};
