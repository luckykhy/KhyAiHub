'use strict';

/**
 * stepneoCloud/upstream.test.js — co-located suite for the signed upstream call.
 *
 * IO: none — fetch is injected. What is asserted here is the failure mapping,
 * because that is the part a caller cannot recover from on its own: a 401 that
 * reads as "expired token" sends people to renew the wrong credential, and a 200
 * with an empty body reads as success.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyStatus, isEmptyCompletion, chatCompletion, STOP_REASONS,
} = require('./upstream');

// ── status classification ────────────────────────────────────────────────────

test('401 is reported as a credential problem with both causes named', () => {
  // The two causes need opposite fixes. A message that names only one sends
  // people to renew a token that was fine.
  const c = classifyStatus(401, 'unauthorized');
  assert.equal(c.code, 'UPSTREAM_AUTH');
  assert.match(c.error, /签名密钥/);
  assert.match(c.error, /token 过期/);
  assert.equal(c.renewToken, true);
});

test('429 is passed through with no automatic retry', () => {
  // Retrying amplifies an account-level TPM limit.
  const c = classifyStatus(429, 'request limited TPM reached');
  assert.equal(c.code, 'UPSTREAM_RATE_LIMIT');
  assert.equal(c.retryable, false);
  assert.match(c.error, /不自动重试/);
});

test('5xx is retryable, 4xx is not', () => {
  assert.equal(classifyStatus(503, '').retryable, true);
  assert.equal(classifyStatus(400, '').retryable, false);
  assert.equal(classifyStatus(404, '').retryable, false);
});

test('the upstream body is kept as detail but truncated', () => {
  // A full error page in a log line is noise; nothing at all loses the clue.
  const c = classifyStatus(500, 'x'.repeat(5000));
  assert.equal(c.detail.length, 300);
});

// ── the empty-body trap ──────────────────────────────────────────────────────

test('a completion with no content and no tool calls is empty', () => {
  assert.equal(isEmptyCompletion({ choices: [{ message: { content: '' } }] }), true);
  assert.equal(isEmptyCompletion({ choices: [{ message: { content: '   ' } }] }), true);
  assert.equal(isEmptyCompletion({ choices: [] }), true);
  assert.equal(isEmptyCompletion({}), true);
  assert.equal(isEmptyCompletion(null), true);
});

test('a completion with tool calls is NOT empty even with no content', () => {
  // Tool-calling turns routinely have empty content. Treating that as a failure
  // would break every agent loop on its first tool round.
  const body = { choices: [{ message: { content: '', tool_calls: [{ id: '1' }] } }] };
  assert.equal(isEmptyCompletion(body), false);
});

test('a completion with content is not empty', () => {
  assert.equal(isEmptyCompletion({ choices: [{ message: { content: '47' } }] }), false);
});

// ── the call itself ──────────────────────────────────────────────────────────

function okFetch(body, { status = 200 } = {}) {
  const text = JSON.stringify(body);
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  });
}

const BASE_ARGS = {
  token: 'tok',
  deviceId: 'dev',
  appSecret: 'sec',
  messages: [{ role: 'user', content: 'hi' }],
};

test('a good response is unwrapped into message/finishReason/usage', async () => {
  const body = {
    choices: [{ message: { role: 'assistant', content: '47' }, finish_reason: 'stop' }],
    usage: { total_tokens: 72 },
  };
  const out = await chatCompletion({ ...BASE_ARGS, fetchImpl: okFetch(body) });
  assert.equal(out.ok, true);
  assert.equal(out.message.content, '47');
  assert.equal(out.finishReason, 'stop');
  assert.equal(out.usage.total_tokens, 72);
  assert.equal(out.stoppedCleanly, true);
});

test('the signed headers are sent on the request', async () => {
  let seen = null;
  await chatCompletion({
    ...BASE_ARGS,
    fetchImpl: async (url, init) => { seen = { url, init }; return okFetch({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] })(); },
  });
  assert.equal(seen.url, 'https://biz-gw.stepaos.com/stepfun-proxy/v1/chat/completions');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  assert.match(seen.init.headers['zy-sign'], /^[0-9a-f]{64}$/);
  assert.equal(seen.init.headers['zy-app-id'], 'ai-engine-prod');
  assert.equal(seen.init.headers['zy-device-id'], 'dev');
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, 'step-5-preview');
  assert.equal(sent.messages.length, 1);
  assert.ok(sent.max_tokens >= 128, 'max_tokens 必须 >= 128，否则思考阶段就会用尽');
});

test('the request body is never empty or undefined', () => {
  // THE REGRESSION. The agent loop calls chatCompletion({messages, tools}) but
  // the session wrapper used to read `args.body`, so `body` was undefined and
  // JSON.stringify(undefined) sent no body at all — every request 400'd with
  // "unexpected status", which looks like a gateway problem and is not one.
  // This asserts the flat shape is what actually reaches the wire.
  return chatCompletion({
    ...BASE_ARGS,
    tools: [{ type: 'function', function: { name: 'x' } }],
    fetchImpl: async (url, init) => {
      assert.ok(init.body, '请求体不能为空');
      assert.ok(init.body.length > 2, `请求体不能是空对象：${init.body}`);
      const parsed = JSON.parse(init.body);
      assert.ok(Array.isArray(parsed.messages));
      assert.equal(parsed.tools.length, 1);
      return okFetch({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] })();
    },
  });
});

test('tools are omitted from the body when none are given', async () => {
  // Sending `tools: []` is not the same as sending no tools key, and some
  // gateways reject the empty array.
  let seen = null;
  await chatCompletion({
    ...BASE_ARGS,
    fetchImpl: async (url, init) => { seen = init; return okFetch({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] })(); },
  });
  assert.ok(!('tools' in JSON.parse(seen.body)));
});

test('an empty messages array is refused rather than sent', async () => {
  const out = await chatCompletion({ ...BASE_ARGS, messages: [] });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NO_MESSAGES');
});

test('a 200 with an empty body is a FAILURE, and says why', async () => {
  // The single most misleading outcome on this path. A caller that checks only
  // the status code reports success on an empty answer.
  const body = {
    choices: [{ message: { content: '' }, finish_reason: 'length' }],
    usage: { completion_tokens: 64 },
  };
  const out = await chatCompletion({ ...BASE_ARGS, fetchImpl: okFetch(body) });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'EMPTY_DUE_TO_TOKEN_BUDGET');
  assert.match(out.error, /128/);
  // The body is still returned — the caller may want to log it.
  assert.equal(out.body.usage.completion_tokens, 64);
});

test('a 401 maps to UPSTREAM_AUTH and flags the token for renewal', async () => {
  const out = await chatCompletion({ ...BASE_ARGS, fetchImpl: okFetch({}, { status: 401 }) });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'UPSTREAM_AUTH');
  assert.equal(out.renewToken, true);
  assert.equal(out.status, 401);
});

test('a 429 maps to UPSTREAM_RATE_LIMIT and is not retryable', async () => {
  const out = await chatCompletion({ ...BASE_ARGS, fetchImpl: okFetch({}, { status: 429 }) });
  assert.equal(out.code, 'UPSTREAM_RATE_LIMIT');
  assert.equal(out.retryable, false);
});

test('a non-JSON 200 is reported as such, not parsed into nonsense', async () => {
  const out = await chatCompletion({
    ...BASE_ARGS,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>gateway</html>' }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'UPSTREAM_NOT_JSON');
});

test('an aborted request maps to UPSTREAM_TIMEOUT, not a generic error', async () => {
  const out = await chatCompletion({
    ...BASE_ARGS,
    fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
  });
  assert.equal(out.code, 'UPSTREAM_TIMEOUT');
  assert.match(out.error, /\[DONE\]/);
});

test('a connection failure maps to UPSTREAM_UNREACHABLE', async () => {
  const out = await chatCompletion({
    ...BASE_ARGS,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(out.code, 'UPSTREAM_UNREACHABLE');
  assert.match(out.error, /ECONNREFUSED/);
});

test('a caller with no fetch at all is refused, not crashed on', async () => {
  // `fetchImpl = fetch` as a signature default would make this branch
  // unreachable — the global always exists on Node 18+, so a genuinely
  // fetch-less caller would get a network attempt instead of a clear refusal.
  const out = await chatCompletion({ ...BASE_ARGS, fetchImpl: null });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NO_FETCH');
});

test('a tool_calls finish reason counts as a clean stop', () => {
  // Otherwise every agent loop reports its own tool rounds as abnormal.
  assert.equal(STOP_REASONS.has('tool_calls'), true);
  assert.equal(STOP_REASONS.has('length'), false);
  assert.equal(STOP_REASONS.has('content_filter'), false);
});
