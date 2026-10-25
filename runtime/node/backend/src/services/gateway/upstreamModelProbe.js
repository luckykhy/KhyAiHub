/**
 * Upstream model probe — read an OpenAI/Anthropic-compatible upstream's
 * advertised model list from its own `/models` endpoint.
 *
 * Single source for "what models does this configured upstream actually
 * expose": both the admin apiAdapter (legacy `_fetchRemoteModels`) and the
 * per-user detection service delegate here so probe semantics stay identical.
 *
 * Zero-fabrication + never-throw: on any timeout, non-2xx, malformed body, or
 * network error this returns `null` (probe failed → caller degrades, leaves the
 * model unset, never invents one). A successful probe returns the raw model ids
 * the upstream reported, nothing more. Endpoints are DERIVED from baseUrl +
 * apiFormat — no hardcoded provider URLs.
 *
 * 两级入口，同一份代码：`fetchUpstreamModels` 只回模型列表（null = 没探成）；
 * `probeUpstreamModels` 额外回 HTTP 状态码，供「注册前闸门」告诉人到底错在哪
 * （404 多半是地址少了 /v1，401 是密钥不对）。
 *
 * @pattern Strategy
 */
'use strict';

const { fetchWithTimeout } = require('../fetchTimeout');

/**
 * Build an undici ProxyAgent dispatcher for native fetch when a per-provider
 * proxy URL is configured. Native fetch (Node's global) has no httpsAgent knob;
 * the supported injection point is the `dispatcher` option, and undici is the
 * bundled implementation — least-intrusive, dependency-consistent path.
 *
 * Never-throw: empty/blank proxy → undefined (direct). An illegal proxy URL is
 * caught here and degrades to direct (returns undefined) with a credential-safe
 * warning (only err.code, never the URL), so the probe can never crash the
 * caller before the request.
 *
 * @param {string} [proxyUrl]
 * @param {string} [label] diagnostic label (never a credential)
 * @returns {import('undici').ProxyAgent|undefined}
 */
function buildProxyDispatcher(proxyUrl, label) {
  const raw = String(proxyUrl || '').trim();
  if (!raw) {
    return undefined;
  }
  try {
    // undici 惰性加载。它现在是本包的显式依赖（^7，与 cheerio 对齐），但仍
    // 不放模块顶层 require：那会让「压根没配代理」的绝大多数调用方也在加载期
    // 一起炸掉 —— 而本文件的契约是「探测失败即降级、绝不抛」。同一个依赖在
    // src/utils/proxyDispatcherAgent.js 里也是这个惰性写法，这里对齐它。
    const { ProxyAgent } = require('undici');
    return new ProxyAgent(raw);
  } catch (err) {
    const reason =
      err && err.code === 'MODULE_NOT_FOUND'
        ? 'undici 不可用'
        : `代理地址无效（${(err && err.code) || 'invalid'}）`;
    console.warn(`[proxy] ${label || 'model-probe'} ${reason}，模型探测回退直连`);
    return undefined;
  }
}

// '2023-06-01' is the published stable Anthropic API version; overridable so a
// relay pinned to a newer dated version can still be probed. Kept in sync with
// adapters/relayApiAdapter.js (single convention, not a magic literal).
const ANTHROPIC_VERSION =
  process.env.RELAY_ANTHROPIC_VERSION || process.env.ANTHROPIC_VERSION || '2023-06-01';

const PROBE_TIMEOUT_MS = parseInt(process.env.KHY_MODEL_PROBE_TIMEOUT_MS || '5000', 10);

/**
 * Build the `/models` URL for a given base + api format without double-/v1.
 * OpenAI-compatible: `{base}/models` (base normally already ends in /v1).
 * Anthropic: `{base}/v1/models` (anthropic has no published /models endpoint —
 * the probe is best-effort and degrades gracefully when it 404s).
 */
function buildModelsUrl(base, apiFormat) {
  const root = String(base || '')
    .trim()
    .replace(/\/+$/, '');
  if (!root) {
    return '';
  }
  if (apiFormat === 'anthropic') {
    // Avoid `/v1/v1/models` when the base already carries a version segment.
    return /\/v\d+$/.test(root) ? `${root}/models` : `${root}/v1/models`;
  }
  return `${root}/models`;
}

function buildHeaders(apiKey, apiFormat) {
  if (apiFormat === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Probe an upstream's `/models` endpoint.
 *
 * @param {object} opts
 * @param {string} [opts.baseUrl]   Upstream base (e.g. https://api.x.com/v1)
 * @param {string} [opts.endpoint]  Explicit endpoint base; takes precedence over baseUrl
 * @param {string} opts.apiKey      Bearer / x-api-key secret (server-side only, never returned)
 * @param {string} [opts.apiFormat] 'openai' | 'anthropic' (default 'openai')
 * @param {string} [opts.proxyUrl]  Optional per-provider proxy URL; injected as
 *   an undici ProxyAgent dispatcher. Blank/illegal → direct (degrades safely).
 * @returns {Promise<Array<{id:string, contextWindow:number, maxOutputTokens?:number}>|null>}
 *   Reported models, or null when the probe could not be completed.
 */
async function fetchUpstreamModels({ baseUrl, endpoint, apiKey, apiFormat, proxyUrl } = {}) {
  const probe = await probeUpstreamModels({ baseUrl, endpoint, apiKey, apiFormat, proxyUrl });
  // null = 探测没跑成（网络/超时/非 2xx），[] = 跑成了但上游没报模型。两者语义
  // 不同，故保留区分 —— 零臆造是这个模块的承诺。
  return probe.ok ? probe.models : null;
}

/**
 * 同 fetchUpstreamModels，但**带上诊断**：非 2xx 时把 HTTP 状态码交回调用方。
 *
 * 为什么需要：注册新中转时要告诉人「你填的地址返回 404，OpenAI 兼容端点一般
 * 要带 /v1」——只回一个 null 的话，人只能自己再去猜哪里错了。探测本身与
 * fetchUpstreamModels 完全同一份代码（URL 构造 / 头 / 代理 / 超时），不存在第二套语义。
 *
 * @returns {Promise<{ok:boolean, status:number, models:Array, error:string}>}
 */
async function probeUpstreamModels({ baseUrl, endpoint, apiKey, apiFormat, proxyUrl } = {}) {
  const base = endpoint || baseUrl;
  if (!base || !apiKey) {
    return { ok: false, status: 0, models: [], error: 'missing_endpoint_or_key' };
  }
  const format = String(apiFormat || 'openai')
    .trim()
    .toLowerCase();
  const url = buildModelsUrl(base, format);
  if (!url) {
    return { ok: false, status: 0, models: [], error: 'invalid_endpoint' };
  }

  // per-provider 代理透传：配了 proxyUrl 则经代理探测（如 Agnes），否则直连。
  const dispatcher = buildProxyDispatcher(proxyUrl, url);

  try {
    // fetchWithTimeout takes a (signal)=>Promise thunk + { timeoutMs }, NOT a
    // URL. (The legacy apiAdapter call passed a URL string and `timeout:` — both
    // wrong — so it silently always failed; this is the corrected form.)
    const resp = await fetchWithTimeout(
      (signal) =>
        fetch(url, {
          method: 'GET',
          headers: buildHeaders(apiKey, format),
          signal,
          ...(dispatcher ? { dispatcher } : {}),
        }),
      { timeoutMs: PROBE_TIMEOUT_MS, operation: 'upstreamModelProbe' }
    );
    if (!resp) {
      return { ok: false, status: 0, models: [], error: 'no_response' };
    }
    if (!resp.ok) {
      return { ok: false, status: resp.status, models: [], error: `http_${resp.status}` };
    }
    const body = await resp.json();
    // OpenAI shape: { data: [{ id, ... }] }. Anthropic (when present) also
    // returns { data: [{ id, ... }] }. Accept either; ignore anything else.
    const data = Array.isArray(body?.data) ? body.data : [];
    return {
      ok: true,
      status: resp.status,
      error: '',
      models: data
        .filter((m) => m && m.id)
        .map((m) => {
          // API 返回的 context_window/context_length 优先；未返回则为 0（由探测层补全）。
          // 不做模型名推断——上下文窗口必须来自实际 API 响应。
          const entry = {
            id: m.id,
            contextWindow: m.context_window || m.context_length || m.max_context_length || 0,
          };
          // Output token limit — field name varies by provider; fail-soft: absent
          // → property not set at all (callers treat missing as unknown).
          const maxOut =
            m.max_output_tokens ||
            m.max_completion_tokens ||
            m.max_output_length ||
            m.output_token_limit ||
            m.max_output ||
            m.max_tokens ||
            0;
          if (maxOut > 0) {
            entry.maxOutputTokens = maxOut;
          }
          return entry;
        }),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      models: [],
      error: err && err.name === 'AbortError' ? 'timeout' : 'network_error',
    };
  }
}

/**
 * 从 max_tokens 超限错误消息中解析**输出上限**（非 context 窗口）。
 * 实测形态（apihub.agnes-ai.com 2026-09-26）：
 *   "max_tokens exceeds the limit of 65536"
 * 泛化形态："max_tokens ... 65536 tokens" / "max completion tokens ... 65536"。
 * 刻意保守：两个明确形态之外一律 0 —— 提取错一个数比提取不到更糟。
 * @param {string} msg
 * @returns {number} 输出上限 token 数（0 = 未识别）
 */
function parseMaxTokensOverflow(msg) {
  const s = String(msg || '');
  const m1 = s.match(/max_tokens\s+exceeds\s+the\s+limit\s+of\s+(\d+)/i);
  if (m1) {
    const n = parseInt(m1[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const m2 = s.match(/(?:max_tokens|max completion tokens)[^\d]{0,80}?(\d{3,})\s*tokens?/i);
  if (m2) {
    const n = parseInt(m2[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * 实际探测模型上下文窗口：发送最小请求，从响应中提取真实值。
 *
 * 与 fetchUpstreamModels（/v1/models 列表）不同，此函数通过实际 API 调用探测：
 * 1. 发送 1 token 请求（max_tokens=1）
 * 2. 从响应 headers 中提取上下文窗口（x-ratelimit-* 等）
 * 3. 从响应体中提取（部分 provider 在 usage/model 字段携带）
 * 4. 若均无 → 触发一次超限探测（发送大 max_tokens）→ 从错误消息提取
 *    —— context 超限（OpenAI 风格 "maximum context length is N"）与
 *    max_tokens 超限（agnes 实测 "max_tokens exceeds the limit of M"）
 *    可在同一次请求的两种 provider 措辞中分别命中，互不冲突。
 *
 * @param {object} opts
 * @param {string} opts.endpoint  API 端点（如 https://apihub.agnes-ai.com/v1）
 * @param {string} opts.apiKey    API key
 * @param {string} opts.modelId   模型 ID（如 agnes-2.5-flash）
 * @param {string} [opts.proxyUrl] 代理 URL
 * @param {number} [opts.timeoutMs=5000] 超时
 * @returns {Promise<{contextWindow:number, maxOutputTokens:number}>}
 *   两字段均 0 = 未探测到任何真值（绝不臆造）
 */
async function probeContextWindow({ endpoint, apiKey, modelId, proxyUrl, timeoutMs = 5000 } = {}) {
  const out = { contextWindow: 0, maxOutputTokens: 0 };
  if (!endpoint || !apiKey || !modelId) return out;

  const chatUrl = `${endpoint.replace(/\/+$/, '')}/chat/completions`;
  const dispatcher = buildProxyDispatcher(proxyUrl, chatUrl);
  const headers = {
    ...buildHeaders(apiKey, 'openai'),
    'Content-Type': 'application/json',
  };

  // ── Step 1: 最小请求，从 headers/body 提取 ─────────────────────
  try {
    const resp = await fetchWithTimeout(
      (signal) =>
        fetch(chatUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
          }),
          signal,
          ...(dispatcher ? { dispatcher } : {}),
        }),
      { timeoutMs, operation: 'probeContextWindow' }
    );

    if (resp) {
      // 从 headers 提取（部分 provider 在响应头中返回限制信息）
      const headerChecks = [
        'x-ratelimit-limit-tokens',
        'x-ratelimit-limit-context',
        'x-context-window',
        'x-model-context-window',
      ];
      for (const h of headerChecks) {
        const val = parseInt(resp.headers?.get?.(h) || resp.headers?.[h], 10);
        if (Number.isFinite(val) && val > 0) return { ...out, contextWindow: val };
      }

      // 从响应体提取
      if (resp.ok) {
        const body = await resp.json();
        // 部分 provider 在响应中返回模型元数据
        const bodyCtx =
          body?.context_window ||
          body?.model_info?.context_window ||
          body?.usage?.context_window ||
          0;
        if (bodyCtx > 0) return { ...out, contextWindow: bodyCtx };
      }
    }
  } catch {
    /* fail-soft: 继续到 Step 2 */
  }

  // ── Step 2: 超限探测（发送极大 max_tokens 触发错误） ────────────
  // 从错误消息中提取真实上下文窗口（如 "maximum context length is 512000 tokens"）
  try {
    const resp = await fetchWithTimeout(
      (signal) =>
        fetch(chatUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 999999999,
          }),
          signal,
          ...(dispatcher ? { dispatcher } : {}),
        }),
      { timeoutMs, operation: 'probeContextWindow-overflow' }
    );

    if (resp && !resp.ok) {
      const body = await resp.json().catch(() => ({}));
      const errMsg = body?.error?.message || body?.message || '';
      if (errMsg) {
        const { parseContextOverflowTokens } = require('../errorClassifier');
        const parsed = parseContextOverflowTokens(errMsg);
        if (parsed && parsed.limitTokens > 0) out.contextWindow = parsed.limitTokens;
        const parsedMax = parseMaxTokensOverflow(errMsg);
        if (parsedMax > 0) out.maxOutputTokens = parsedMax;
      }
    }
  } catch {
    /* fail-soft: 探测失败返回零值 */
  }

  return out;
}

module.exports = {
  fetchUpstreamModels,
  probeUpstreamModels,
  probeContextWindow,
  parseMaxTokensOverflow,
  buildModelsUrl,
  buildHeaders,
  buildProxyDispatcher,
  ANTHROPIC_VERSION,
};
