/**
 * customProviderVerify 的闸门判定测试（node --test）。
 *
 * 覆盖的是「红了一定拦住」这一条：判红的分支比判绿多，因为判绿只要网络通，
 * 判红漏一条就等于闸门不存在。fetch 在这里被替换成桩，不发真实请求。
 *
 *   node --test src/services/gateway/customProviderVerify.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  fetchRealModels,
  verifyCustomProvider,
  verifyCustomProviderDraft,
  buildChatUrl,
  explainFailure,
} = require('./customProviderVerify');

const ENDPOINT = 'https://relay.example.test/v1';
const KEY = 'sk-not-a-real-key';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function withFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve(fn()).finally(() => {
    global.fetch = original;
  });
}

test('buildChatUrl 按协议族派生，不带 /v1 与 /v1/v1 双段', () => {
  assert.equal(buildChatUrl(`${ENDPOINT}/`, 'openai'), `${ENDPOINT}/chat/completions`);
  assert.equal(buildChatUrl('https://host.tld', 'anthropic'), 'https://host.tld/v1/messages');
  assert.equal(buildChatUrl('https://host.tld/v1', 'anthropic'), 'https://host.tld/v1/messages');
  assert.equal(buildChatUrl('', 'openai'), '');
});

test('fetchRealModels 返回上游真实报的 id', async () => {
  const models = await withFetch(
    async () => jsonResponse({ data: [{ id: 'a-model' }, { id: 'b-model' }, { id: '' }] }),
    () => fetchRealModels({ endpoint: ENDPOINT, apiKey: KEY })
  );
  assert.equal(models.ok, true);
  assert.deepEqual(models.models, ['a-model', 'b-model']);
});

test('fetchRealModels：地址没 /v1（404）判红，并给出可照改的说法', async () => {
  const r = await withFetch(
    async () => jsonResponse({}, { ok: false, status: 404 }),
    () => fetchRealModels({ endpoint: 'https://relay.example.test', apiKey: KEY })
  );
  assert.equal(r.ok, false);
  assert.equal(r.models, null);
  assert.match(r.reason, /404/);
  assert.match(r.reason, /\/v1/);
});

test('fetchRealModels：401 判红成密钥问题，不是地址问题', async () => {
  const r = await withFetch(
    async () => jsonResponse({}, { ok: false, status: 401 }),
    () => fetchRealModels({ endpoint: ENDPOINT, apiKey: KEY })
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /密钥/);
});

test('fetchRealModels：通了但没报模型 → models=[]（不是 null）', async () => {
  const r = await withFetch(
    async () => jsonResponse({ data: [] }),
    () => fetchRealModels({ endpoint: ENDPOINT, apiKey: KEY })
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, []);
});

test('fetchRealModels：网络异常 fail-soft，不抛', async () => {
  const r = await withFetch(
    async () => {
      throw new Error('ECONNREFUSED');
    },
    () => fetchRealModels({ endpoint: ENDPOINT, apiKey: KEY })
  );
  assert.equal(r.ok, false);
  assert.equal(r.models, null);
});

test('verifyCustomProvider：2xx 判绿并带回复摘要', async () => {
  const v = await withFetch(
    async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    () => verifyCustomProvider({ endpoint: ENDPOINT, apiKey: KEY, model: 'a-model' })
  );
  assert.equal(v.ok, true);
  assert.equal(v.preview, 'ok');
});

test('verifyCustomProvider：400 带出上游原话，指出多半是模型 id 错', async () => {
  const v = await withFetch(
    async () =>
      jsonResponse({ error: { message: 'model not found: nope' } }, { ok: false, status: 400 }),
    () => verifyCustomProvider({ endpoint: ENDPOINT, apiKey: KEY, model: 'nope' })
  );
  assert.equal(v.ok, false);
  assert.equal(v.status, 400);
  assert.match(v.reason, /模型 id 不存在/);
  assert.match(v.reason, /model not found: nope/);
});

test('verifyCustomProvider：缺地址/密钥/模型 → 判红而不是静默放行', async () => {
  const v = await verifyCustomProvider({ endpoint: ENDPOINT, apiKey: KEY, model: '' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /无法判定/);
});

test('verifyCustomProviderDraft：模型不在上游真实列表里 → 拦下且报出现有模型', async () => {
  let call = 0;
  const r = await withFetch(
    async () => {
      call += 1;
      return jsonResponse({ data: [{ id: 'real-a' }, { id: 'real-b' }] });
    },
    () =>
      verifyCustomProviderDraft({
        endpoint: ENDPOINT,
        keyInput: KEY,
        defaultModel: 'guessed-model',
      })
  );
  assert.equal(call, 1, '模型 id 已在探测阶段判红，不该再发那一次对话');
  assert.equal(r.ok, false);
  assert.equal(r.summary.error, 'model_not_in_upstream_list');
  assert.match(r.reason, /real-a, real-b/);
});

test('verifyCustomProviderDraft：全绿才放行', async () => {
  const r = await withFetch(
    async (url, init) =>
      String(url).endsWith('/models')
        ? jsonResponse({ data: [{ id: 'real-a' }] })
        : jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    () =>
      verifyCustomProviderDraft({ endpoint: ENDPOINT, keyInput: KEY, defaultModel: 'real-a' })
  );
  assert.equal(r.ok, true);
  assert.equal(r.summary.upstreamModels, 1);
  assert.equal(r.summary.success, true);
});

test('verifyCustomProviderDraft：force / skip 放行，但摘要如实标注未验证', async () => {
  const forced = await verifyCustomProviderDraft(
    { endpoint: ENDPOINT, keyInput: KEY, defaultModel: 'x' },
    { force: true }
  );
  assert.equal(forced.ok, true);
  assert.equal(forced.summary.attempted, false);
  assert.equal(forced.summary.forced, true);

  const skipped = await verifyCustomProviderDraft(
    { endpoint: ENDPOINT, keyInput: KEY, defaultModel: 'x' },
    { skip: true }
  );
  assert.equal(skipped.ok, true);
  assert.equal(skipped.summary.attempted, false);
  assert.equal(skipped.summary.forced, false);
});

test('verifyCustomProviderDraft：上游无 /models 时不就此判红，交给对话自检', async () => {
  let call = 0;
  const r = await withFetch(
    async (url) => {
      call += 1;
      return String(url).endsWith('/models')
        ? jsonResponse({}, { ok: false, status: 404 })
        : jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    },
    () =>
      verifyCustomProviderDraft({ endpoint: ENDPOINT, keyInput: KEY, defaultModel: 'typed-id' })
  );
  assert.equal(call, 2, '探不到列表也要真发一次对话，那一发才是决定性证据');
  assert.equal(r.ok, true);
  assert.equal(r.summary.upstreamModels, null);
});

test('explainFailure 每条结论都带可执行的下一步', () => {
  for (const input of [
    { status: 401, networkError: '', upstreamHint: '' },
    { status: 404, networkError: '', upstreamHint: '' },
    { status: 429, networkError: '', upstreamHint: '' },
    { status: 503, networkError: '', upstreamHint: '' },
    { status: 0, networkError: 'timeout', upstreamHint: '' },
    { status: 0, networkError: 'network_error', upstreamHint: '' },
  ]) {
    const reason = explainFailure(input);
    assert.ok(reason.length > 10, `结论太短，等于没结论: ${reason}`);
    assert.match(reason, /[：，]/, `结论缺「问题：原因」结构: ${reason}`);
  }
});
