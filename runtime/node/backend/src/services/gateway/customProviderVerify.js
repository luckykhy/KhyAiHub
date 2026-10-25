'use strict';

/**
 * customProviderVerify — 中转站（relay / 自定义 Provider）注册前的「先测绿再落盘」闸门。
 *
 * 为什么有这道闸：2026-10-20 事故——把中转站当「填个地址就能用」的入口，地址少写了
 * /v1 也照样存进去，模型 id 靠手敲猜，运行期才炸成 `404 page not found`，而且要等到
 * 一次真实对话才暴露。配置期一次真实探测的成本远低于运行期一次失败的对话。
 *
 * 两级判定，都不发副作用、不落盘：
 *   1. fetchRealModels() — 拉中转站自己 /models 报的模型 id。真实列表，绝不臆造。
 *   2. verifyCustomProvider() — 真发一次 chat/completions，判定「到底能不能用」。
 *
 * models 的三种结果语义不同，不可混为一谈：
 *   - `[]`   端点可达 + 鉴权通过，但上游没报任何模型 → 判红（没有模型可选）
 *   - 非空   真实模型列表，交互流程据此给选择器、注册也据此写路由
 *   - `null` 探测没跑成（老中转没实现 /models、网络抖动）→ **不直接判红**，
 *            以第 2 步那一次真实对话的绿/红为准 —— 那一发才是决定性证据。
 *
 * fail-soft：任何网络异常都转成一个 verdict 结果对象，绝不抛；错误文案按规则 2.2
 * 写成「问题：原因，修复建议」，不写「连接失败」这种没有下文的空话。
 *
 * @module services/gateway/customProviderVerify
 */

const { fetchWithTimeout } = require('../fetchTimeout');
const { probeUpstreamModels, buildHeaders, buildProxyDispatcher } = require('./upstreamModelProbe');

// 短 I/O 探测超时（规则 3 的合法例外：一发就返回的网络请求，不是任务截止时间）。
const VERIFY_TIMEOUT_MS = parseInt(process.env.KHY_PROVIDER_VERIFY_TIMEOUT_MS || '8000', 10);

// 探针提示词：只要一个字。max_tokens 压到 10 —— 这次调用是为了证明「能通」，
// 不是为了拿结果，多花一个 token 都是白花的用户配额。
const PROBE_PROMPT = 'Reply with the single word: ok';
const PROBE_MAX_TOKENS = 10;

/** 中转的对话地址由 base 派生，不含任何厂商字面量。 */
function buildChatUrl(base, apiFormat) {
  const root = String(base || '')
    .trim()
    .replace(/\/+$/, '');
  if (!root) {
    return '';
  }
  if (apiFormat === 'anthropic') {
    return /\/v\d+$/.test(root) ? `${root}/messages` : `${root}/v1/messages`;
  }
  return `${root}/chat/completions`;
}

/**
 * 把 HTTP 状态码 / 网络错误码翻译成人能照着改的结论。
 * @param {number} status
 * @param {string} networkError 'timeout' | 'network_error' | ''
 * @param {string} upstreamHint 上游响应体里带的错误摘要（可为空）
 */
function explainFailure({ status, networkError, upstreamHint, stage }) {
  const hint = String(upstreamHint || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const suffix = hint ? ` 上游原话：${hint}` : '';

  if (networkError === 'timeout') {
    return `${stage}超时：地址或网络在 ${VERIFY_TIMEOUT_MS / 1000}s 内没回包，请确认地址可达、代理已配`;
  }
  if (networkError) {
    return `${stage}失败：连不上该地址（DNS/证书/网络），请检查地址拼写与本机网络`;
  }
  if (status === 401 || status === 403) {
    return `密钥被拒（${status}）：该地址认不出这把 key，请确认 key 属于这个中转站且未过期`;
  }
  if (status === 404) {
    return `地址不对（404）：该地址没有对话接口。OpenAI 兼容中转通常要带 /v1（如 https://host/v1），请补上再试`;
  }
  if (status === 400 || status === 422) {
    return `请求被拒（${status}）：多半是模型 id 不存在或该模型没开通，请用 /models 返回的真实 id 重试。${suffix}`;
  }
  if (status === 429) {
    return `限流（429）：key 额度或并发已满，稍后重试或换一把 key`;
  }
  if (status >= 500) {
    return `上游异常（${status}）：中转站自己挂了或转发失败，请稍后重试或换一家中转`;
  }
  return `未通过（${status || '无状态码'}）：上游未返回可用响应${suffix}`;
}

/**
 * 拉中转站真实模型列表。
 *
 * @param {object} opts
 * @param {string} opts.endpoint  Base URL（形如 https://host/v1）
 * @param {string} opts.apiKey
 * @param {string} [opts.apiFormat] 'openai' | 'anthropic'
 * @param {string} [opts.proxyUrl]
 * @returns {Promise<{models:string[], ok:boolean, status:number, reason:string}>}
 *   models: [] = 通了但没报模型；null = 没探成（reason 里有原因）。
 *   ok=true 表示「这一发请求本身通了」，与「有没有模型」无关。
 */
async function fetchRealModels({ endpoint, apiKey, apiFormat = 'openai', proxyUrl = '' } = {}) {
  const probe = await probeUpstreamModels({ endpoint, apiKey, apiFormat, proxyUrl });
  if (!probe.ok) {
    return {
      models: null,
      ok: false,
      status: probe.status,
      reason: explainFailure({
        status: probe.status,
        networkError: probe.status ? '' : probe.error,
        upstreamHint: '',
        stage: '模型列表探测',
      }),
    };
  }
  const models = probe.models.map((m) => m.id);
  if (!models.length) {
    return {
      models: [],
      ok: true,
      status: probe.status,
      reason: '模型列表为空：该地址的 /models 通得了但没报任何模型，无法选择默认模型',
    };
  }
  return { models, ok: true, status: probe.status, reason: '' };
}

/**
 * 注册前的绿灯判定：真发一次对话。
 *
 * 判红一律返回 reason，不抛、不落盘、不改任何配置 —— 调用方据此回绝保存。
 *
 * @param {object} opts
 * @param {string} opts.endpoint
 * @param {string} opts.apiKey
 * @param {string} opts.model      待验证的模型 id
 * @param {string} [opts.apiFormat]
 * @param {string} [opts.proxyUrl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean, status:number, preview:string, reason:string, latencyMs:number}>}
 */
async function verifyCustomProvider({
  endpoint,
  apiKey,
  model,
  apiFormat = 'openai',
  proxyUrl = '',
  timeoutMs = VERIFY_TIMEOUT_MS,
} = {}) {
  const started = Date.now();
  const format = String(apiFormat || 'openai')
    .trim()
    .toLowerCase();
  const url = buildChatUrl(endpoint, format);
  if (!url || !apiKey || !model) {
    return {
      ok: false,
      status: 0,
      preview: '',
      latencyMs: 0,
      reason: '连通性自检缺少地址/密钥/模型 id，无法判定',
    };
  }

  const dispatcher = buildProxyDispatcher(proxyUrl, url);
  const headers = {
    ...buildHeaders(apiKey, format),
    'Content-Type': 'application/json',
  };
  const body = {
    model,
    max_tokens: PROBE_MAX_TOKENS,
    messages: [{ role: 'user', content: PROBE_PROMPT }],
  };

  try {
    const resp = await fetchWithTimeout(
      (signal) =>
        fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
          ...(dispatcher ? { dispatcher } : {}),
        }),
      { timeoutMs, operation: 'customProviderVerify-connectivity' }
    );
    const latencyMs = Date.now() - started;
    if (!resp) {
      return {
        ok: false,
        status: 0,
        preview: '',
        latencyMs,
        reason: explainFailure({ networkError: 'network_error', stage: '连通性自检' }),
      };
    }
    if (!resp.ok) {
      const parsed = await resp.json().catch(() => ({}));
      return {
        ok: false,
        status: resp.status,
        preview: '',
        latencyMs,
        reason: explainFailure({
          status: resp.status,
          networkError: '',
          upstreamHint: parsed?.error?.message || parsed?.message || '',
          stage: '连通性自检',
        }),
      };
    }
    const parsed = await resp.json().catch(() => ({}));
    const preview =
      parsed?.choices?.[0]?.message?.content || parsed?.content?.[0]?.text || '';
    return {
      ok: true,
      status: resp.status,
      preview: String(preview).trim().slice(0, 50),
      latencyMs,
      reason: '',
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      preview: '',
      latencyMs: Date.now() - started,
      reason: explainFailure({
        networkError: err && err.name === 'AbortError' ? 'timeout' : 'network_error',
        stage: '连通性自检',
      }),
    };
  }
}

/**
 * 注册前的完整闸门：拉真实模型列表核对模型 id + 真发一次对话。
 *
 * CLI（`khy gateway add`）、Web 管理端（POST /api/ai-gateway/custom-providers）走同一份
 * 判定 —— 同一个「中转站入口」不该有两种放行口径。判红一律返回 {ok:false, reason}，
 * 调用方据此一个字节都不写 .env / custom_providers.json。
 *
 * @param {{endpoint:string, keyInput:string, defaultModel:string}} draft
 * @param {{force?:boolean, skip?:boolean, proxyUrl?:string, apiFormat?:string}} [opts]
 *   force/skip 是人显式点头的跳过（CLI `--force` / `--test false`，HTTP `force:true`
 *   / `verify:false`），跳过时 summary 明确标注，绝不假装测过。
 * @returns {Promise<{ok:boolean, reason:string, summary:object}>}
 */
async function verifyCustomProviderDraft(draft = {}, opts = {}) {
  const skipped = {
    attempted: false,
    success: null,
    forced: !!opts.force,
    message: opts.force ? '已跳过（显式 --force）' : '已跳过（显式关闭自检）',
  };
  if (opts.force || opts.skip) {
    return { ok: true, reason: '', summary: skipped };
  }

  const { parseApiKeyEntries } = require('../apiKeyFormat');
  const endpoint = String(draft.endpoint || '')
    .trim()
    .replace(/\/+$/, '');
  const entries = parseApiKeyEntries(draft.keyInput, { endpoint });
  const apiKey = entries.length > 0 ? entries[0].key : String(draft.keyInput || '').trim();
  const apiFormat = opts.apiFormat || 'openai';

  const fetched = await fetchRealModels({ endpoint, apiKey, apiFormat, proxyUrl: opts.proxyUrl });
  // 上游报了模型，那手敲的模型 id 就必须真的在里面 —— 写错名字过去要等到
  // 真实对话才炸成 400/404。探不到列表（老中转没实现 /models）则跳过这一步，
  // 交由下面的对话自检判绿判红。
  if (fetched.models && !fetched.models.includes(draft.defaultModel)) {
    const sample = fetched.models.slice(0, 8).join(', ');
    return {
      ok: false,
      reason: `模型 "${draft.defaultModel}" 不在上游真实列表里：该中转现有 ${fetched.models.length} 个模型，如 ${sample}${fetched.models.length > 8 ? ' …' : ''}`,
      summary: { attempted: true, success: false, error: 'model_not_in_upstream_list' },
    };
  }

  const verdict = await verifyCustomProvider({
    endpoint,
    apiKey,
    model: draft.defaultModel,
    apiFormat,
    proxyUrl: opts.proxyUrl,
  });
  if (!verdict.ok) {
    return {
      ok: false,
      reason: verdict.reason,
      summary: { attempted: true, success: false, error: `http_${verdict.status}` },
    };
  }
  return {
    ok: true,
    reason: '',
    summary: {
      attempted: true,
      success: true,
      preview: verdict.preview,
      latencyMs: verdict.latencyMs,
      upstreamModels: fetched.models ? fetched.models.length : null,
    },
  };
}

module.exports = {
  fetchRealModels,
  verifyCustomProvider,
  verifyCustomProviderDraft,
  buildChatUrl,
  explainFailure,
  VERIFY_TIMEOUT_MS,
};
