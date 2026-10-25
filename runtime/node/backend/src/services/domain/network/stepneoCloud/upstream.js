'use strict';

/**
 * stepneoCloud/upstream.js — the signed call to the StepOS cloud gateway.
 *
 * One method does the work: POST a chat completion with freshly computed
 * signature headers. Everything else here is the failure mapping that makes a
 * 401 legible.
 *
 * The two things worth getting right, both learned the hard way:
 *
 *   1. HTTP 200 does NOT mean the call succeeded. The model emits reasoning
 *      before content, so a small max_tokens is exhausted during reasoning and
 *      the body comes back empty with finish_reason "length". A caller that
 *      checks only the status code reports success on an empty answer.
 *   2. 401 has two very different causes — a bad signature and an expired
 *      token — and they need opposite fixes. Conflating them sends people to
 *      renew a token that was fine.
 */

const { buildHeaders, DEFAULT_BASE_URL, PROD_APP_ID } = require('./signing');

/** Finish reasons that mean "the model stopped", not "it failed". */
const STOP_REASONS = new Set(['stop', 'tool_calls', 'end_turn', 'stop_sequence']);

/** The model the gateway serves. */
const DEFAULT_MODEL = 'step-5-preview';

/**
 * Default token budget.
 *
 * Must stay >= 128. The model emits reasoning before content, so a smaller
 * budget is exhausted during reasoning: HTTP 200, empty content,
 * finish_reason "length". Measured 128 / 512 / 2048 all produce content; 64
 * usually does not.
 *
 * Raised from 4096 after a measured failure: asked to write a game, the model
 * tried to emit the whole HTML file as its REPLY instead of calling phone_write,
 * and burned the entire budget with no content and no tool call. A budget that
 * is too small does not fail loudly — it fails as a 200 with an empty body.
 */
const DEFAULT_MAX_TOKENS = 16384;

/**
 * Classify an upstream HTTP status into something a human can act on.
 *
 * @returns {{code: string, error: string, renewToken?: boolean, retryable: boolean}}
 */
function classifyStatus(status, bodyText) {
  const snippet = (bodyText || '').slice(0, 300);
  if (status === 401 || status === 403) {
    // Both are credential-shaped. The distinction that matters is whether the
    // signature could be wrong, which the caller cannot tell from here — so the
    // advice names both and puts the cheaper check first.
    return {
      code: 'UPSTREAM_AUTH',
      error: `上游拒绝凭据（HTTP ${status}）。两种原因，先查便宜的：`
        + '① 应用签名密钥不对（换过 AIEngine 版本它会变）；'
        + '② 账号 token 过期（它没有 exp 字段，只能靠真实请求判断，实测可用约 20–48 小时）。',
      renewToken: true,
      retryable: false,
      detail: snippet,
    };
  }
  if (status === 429) {
    // Retrying amplifies the limit. The upstream says so in its own body.
    return {
      code: 'UPSTREAM_RATE_LIMIT',
      error: `上游按账号限流（TPM）。原样返回，本模块不自动重试——重试会放大限流。`,
      retryable: false,
      detail: snippet,
    };
  }
  if (status >= 500) {
    return {
      code: 'UPSTREAM_5XX',
      error: `上游服务端错误（HTTP ${status}）。`,
      retryable: true,
      detail: snippet,
    };
  }
  return {
    code: 'UPSTREAM_HTTP',
    error: `上游返回非预期状态 HTTP ${status}。`,
    retryable: false,
    detail: snippet,
  };
}

/**
 * Whether a completion body actually carries an answer.
 *
 * Exported because "200 with an empty body" is the single most misleading
 * outcome in this whole path, and every caller has to make the same judgement.
 */
function isEmptyCompletion(body) {
  if (!body || typeof body !== 'object') return true;
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return true;
  const msg = choices[0] && choices[0].message;
  if (!msg) return true;
  const hasContent = typeof msg.content === 'string' && msg.content.trim().length > 0;
  const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
  return !hasContent && !hasTools;
}

/**
 * POST /v1/chat/completions with a fresh signature.
 *
 * Takes `messages` and `tools` directly and builds the body itself. An earlier
 * version took a pre-built `body` instead, which meant the session wrapper had
 * to assemble it — and it assembled `body: args.body` while the agent loop was
 * passing `{messages, tools}`, so the body was `undefined` and every request
 * 400'd. The nested form had exactly one advantage (flexibility) and one fatal
 * disadvantage (two places to get it wrong), so the shape is flat now.
 *
 * @param {object} deps
 * @param {string} deps.token account token (in memory only — never persisted)
 * @param {string} deps.deviceId from the token's `a` field
 * @param {string} deps.appSecret the client signing key, from env only
 * @param {Array} deps.messages the conversation
 * @param {Array} [deps.tools] function schemas
 * @param {string} [deps.model]
 * @param {number} [deps.maxTokens] must be >= 128; see isEmptyCompletion
 * @param {Function|null} [deps.fetchImpl] injectable for tests. Pass null to
 *   force the no-fetch path; omit it to use the global.
 * @param {number} [deps.timeoutMs] total budget; SSE bodies outlive the default
 * @param {string} [deps.baseUrl]
 * @param {string} [deps.appId]
 * @param {Function} [deps.now]
 */
async function chatCompletion({
  token,
  deviceId,
  appSecret,
  messages,
  tools,
  model = DEFAULT_MODEL,
  maxTokens = DEFAULT_MAX_TOKENS,
  fetchImpl,
  timeoutMs = 600000,
  baseUrl = DEFAULT_BASE_URL,
  appId = PROD_APP_ID,
  now = () => Date.now(),
  signal,
}) {
  // Resolved rather than defaulted in the signature. `fetchImpl = fetch` as a
  // default parameter looks equivalent but is not: the global always exists on
  // Node 18+, so the no-fetch branch below would be unreachable and a caller
  // that genuinely has no fetch would get a network attempt instead of a clear
  // refusal.
  const fetchFn = fetchImpl !== undefined ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, code: 'NO_FETCH', error: '没有可用的 fetch 实现（需要 Node 18+ 或注入 fetchImpl）。' };
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, code: 'NO_MESSAGES', error: 'chatCompletion: messages 不能为空。' };
  }

  const body = { model, max_tokens: maxTokens, messages };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
  }

  const headers = buildHeaders({ token, appId, appSecret, deviceId, now });
  const url = `${baseUrl}/v1/chat/completions`;

  // A total AbortSignal timeout, NOT the default. The documented failure is a
  // stream that has already started emitting and then dies at ~180s because the
  // signal covered the whole SSE body.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let res;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
    const aborted = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    return {
      ok: false,
      code: aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      error: aborted
        ? `上游在 ${timeoutMs}ms 内没有返回。注意：首 token 到达也不能证明这次调用会成功，要以 [DONE] 和流内错误为准。`
        : `连不上上游：${error && error.message}`,
      retryable: aborted,
    };
  }

  const text = await res.text();
  clearTimeout(timer);
  if (signal) signal.removeEventListener('abort', onExternalAbort);

  if (!res.ok) {
    return { ok: false, ...classifyStatus(res.status, text), status: res.status };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: 'UPSTREAM_NOT_JSON', error: `上游响应不是 JSON：${e.message}`, detail: text.slice(0, 300) };
  }

  if (isEmptyCompletion(parsed)) {
    // The misleading one. Reported as a failure with the reason attached, and
    // NOT rewritten: the caller asked for a short answer and got one, and hiding
    // that would be lying about what the model did.
    const finish = parsed.choices && parsed.choices[0] && parsed.choices[0].finish_reason;
    const usage = parsed.usage;
    return {
      ok: false,
      code: 'EMPTY_DUE_TO_TOKEN_BUDGET',
      error: `HTTP 200 但正文为空（finish_reason=${finish || '未知'}，usage=${JSON.stringify(usage)}）。`
        + '模型先产出思考再产出正文，max_tokens 太小会在思考阶段就用尽。请把 max_tokens 设到 128 以上。',
      status: res.status,
      body: parsed,
      retryable: false,
    };
  }

  return {
    ok: true,
    status: res.status,
    body: parsed,
    message: parsed.choices[0].message,
    finishReason: parsed.choices[0].finish_reason,
    usage: parsed.usage,
    stoppedCleanly: STOP_REASONS.has(parsed.choices[0].finish_reason),
  };
}

module.exports = {
  STOP_REASONS,
  classifyStatus,
  isEmptyCompletion,
  chatCompletion,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
};
