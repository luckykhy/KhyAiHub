'use strict';

/**
 * connectivity.js contract tests — protocol-family routing of the probe request,
 * the pure status→verdict classifier, and the fail-soft shape of
 * testCardConnectivity.
 *
 * The network call is stubbed by installing a fake utils/nativeHttp into
 * require.cache under its fully resolved path before the module is re-required
 * (it destructures `request` at load), restored in a `finally`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { classify, _protocolFamily } = require('./connectivity');
const { PROTOCOLS } = require('./constants');

const HTTP_PATH = require.resolve('../../../../utils/nativeHttp');
const SELF_PATH = require.resolve('./connectivity');

// Sync stub window: the fresh instance keeps the stub reference after restore.
function withStubbedRequest(requestImpl, fn) {
  const savedHttp = require.cache[HTTP_PATH];
  const savedSelf = require.cache[SELF_PATH];
  delete require.cache[SELF_PATH];
  require.cache[HTTP_PATH] = {
    id: HTTP_PATH,
    filename: HTTP_PATH,
    loaded: true,
    exports: { request: requestImpl },
    children: [],
    paths: [],
  };
  try {
    return fn(require(SELF_PATH));
  } finally {
    if (savedHttp) require.cache[HTTP_PATH] = savedHttp;
    else delete require.cache[HTTP_PATH];
    if (savedSelf) require.cache[SELF_PATH] = savedSelf;
    else delete require.cache[SELF_PATH];
  }
}

// Capture the outbound request and answer with a fixed response.
function probe(reply, impl) {
  const seen = [];
  const requester = impl
    ? impl
    : async (url, opts) => {
        seen.push({ url, opts });
        if (reply instanceof Error) throw reply;
        return reply;
      };
  return { seen, run: (fn) => withStubbedRequest(requester, fn) };
}

test('_protocolFamily：anthropic/gemini 精确匹配，其余全部落到 openai', () => {
  assert.equal(_protocolFamily(PROTOCOLS.ANTHROPIC), 'anthropic');
  assert.equal(_protocolFamily(PROTOCOLS.GEMINI), 'gemini');
  assert.equal(_protocolFamily(PROTOCOLS.OPENAI), 'openai');
  assert.equal(_protocolFamily(PROTOCOLS.RESPONSES), 'openai', 'responses shares the openai probe');
  for (const junk of [undefined, null, '', 0, 'OpenAI', 'ANTHROPIC', {}, []]) {
    assert.equal(_protocolFamily(junk), 'openai', `junk=${String(junk)} fails open to openai`);
  }
});

test('classify：四个专属状态码给出各自的结论与文案', () => {
  assert.deepEqual(classify({ status: 200 }), { verdict: 'ok', label: '连通且鉴权通过' });
  assert.deepEqual(classify({ status: 401 }), { verdict: 'bad-key', label: '端点可达但密钥无效' });
  assert.deepEqual(classify({ status: 403 }), { verdict: 'bad-key', label: '端点可达但密钥无效' });
  assert.deepEqual(classify({ status: 404 }), { verdict: 'model-not-found', label: '端点可达，模型不存在' });
  assert.deepEqual(classify({ status: 429 }), { verdict: 'rate-limited', label: '端点可达但被限流' });
});

test('classify：区间边界用 >= 判定，500/400 入档而 499/399 走通用档', () => {
  assert.equal(classify({ status: 500 }).verdict, 'server-error');
  assert.equal(classify({ status: 599 }).verdict, 'server-error');
  assert.equal(classify({ status: 499 }).verdict, 'http-error');
  assert.equal(classify({ status: 400 }).verdict, 'http-error');
  assert.equal(classify({ status: 399 }).verdict, 'unknown');
  assert.equal(classify({ status: 500 }).label, '服务端错误（HTTP 500）');
  assert.equal(classify({ status: 418 }).label, 'HTTP 错误（418）');
});

test('classify：status 走 Number()||0 强转，字符串可用而不可换算的等于 0', () => {
  assert.equal(classify({ status: '404' }).verdict, 'model-not-found');
  assert.equal(classify({ status: ' 200 ' }).verdict, 'ok');
  assert.equal(classify({ status: '200x' }).verdict, 'unknown');
  for (const junk of [undefined, NaN, {}, [], 'abc']) {
    assert.deepEqual(classify({ status: junk }), { verdict: 'unknown', label: '未知结果' }, String(junk));
  }
  assert.deepEqual(classify(), { verdict: 'unknown', label: '未知结果' });
  assert.deepEqual(classify({}), { verdict: 'unknown', label: '未知结果' });
  // Measured: the destructuring default only fires for undefined — null explodes,
  // while every other primitive is safely boxed into an empty shape.
  assert.throws(() => classify(null), TypeError);
  assert.deepEqual(classify(0), { verdict: 'unknown', label: '未知结果' });
  assert.equal(classify({ status: -1 }).verdict, 'unknown');
});

test('classify：状态码优先于错误码；只有 status 归零时 errorCode 才生效', () => {
  assert.equal(classify({ status: 429, errorCode: 'ECONNRESET' }).verdict, 'rate-limited');
  assert.equal(classify({ status: 0, errorCode: 'ETIMEDOUT' }).verdict, 'unreachable');
  assert.equal(classify({ status: 'abc', errorCode: 'ECONNREFUSED' }).verdict, 'unreachable');
  assert.equal(classify({ status: 0, errorCode: '' }).verdict, 'unknown', 'empty errorCode is falsy');
  assert.equal(classify({ errorCode: 'ECONNREFUSED' }).verdict, 'unreachable');
  assert.equal(classify({ status: 500, errorCode: 'ECONNRESET' }).verdict, 'server-error');
});

test('classify 只产出 verdict+label 两个键，且 verdict 词表与所镜像的 spec 不同形', () => {
  for (const input of [{ status: 200 }, { status: 401 }, { status: 404 }, { status: 0, errorCode: 'X' }, { status: 503 }]) {
    assert.deepEqual(Object.keys(classify(input)).sort(), ['label', 'verdict'], JSON.stringify(input));
  }
  const spec = require('../../../gateway/providerConnectivitySpec');
  const statuses = [[200, 'ok'], [401, 'bad_key'], [404, 'model_or_endpoint'], [429, 'rate_limited'], [500, 'server_error']];
  const mine = statuses.map(([s]) => classify({ status: s }).verdict);
  const theirs = statuses.map(([s]) => spec.classifyConnectivityResult({ status: s }).verdict);
  // Measured: only the 'ok' verdict agrees; every failure verdict drifts on the
  // separator (or on the whole name, for 404/500).
  assert.deepEqual(mine, ['ok', 'bad-key', 'model-not-found', 'rate-limited', 'server-error']);
  assert.deepEqual(theirs, ['ok', 'bad_key', 'model_or_endpoint', 'rate_limited', 'server_error']);
  assert.deepEqual(mine.filter((v, i) => v !== theirs[i]), mine.slice(1), '4 of 5 verdicts are not portable');
  // The spec also answers `reachable` / `keyValid`; classify answers neither.
  assert.deepEqual(Object.keys(spec.classifyConnectivityResult({ status: 401 })).sort(), ['keyValid', 'label', 'reachable', 'verdict']);
  assert.deepEqual(Object.keys(classify({ status: 401 })).sort(), ['label', 'verdict']);
});

test('testCardConnectivity：无 baseUrl 给出 skipped 结论且绝不发起请求', () => {
  const { seen, run } = probe({ status: 200 });
  return run((m) =>
    Promise.all([
      m.testCardConnectivity(),
      m.testCardConnectivity({}),
      m.testCardConnectivity({ card: null }),
      m.testCardConnectivity({ card: { protocol: 'anthropic' } }),
      m.testCardConnectivity({ card: { baseUrl: '' } }),
      m.testCardConnectivity({ card: { baseUrl: '///' } }),
    ])
  ).then((rs) => {
    assert.equal(seen.length, 0, 'no probe may be fired without an endpoint');
    for (const r of rs) {
      assert.equal(r.ok, false);
      assert.equal(r.verdict, 'skipped');
      assert.equal(r.label, '卡片缺少 baseUrl，跳过');
      assert.equal(r.status, 0);
      assert.equal(typeof r.latencyMs, 'number');
      assert.equal(r.model, undefined, 'no model is reported when the probe never ran');
    }
  });
});

test('testCardConnectivity：baseUrl 的尾部斜杠被剥掉，但空白串不算缺失（实测）', () => {
  const { seen, run } = probe({ status: 200 });
  return Promise.all([
    run((m) => m.testCardConnectivity({ card: { baseUrl: 'https://a.com///', protocol: PROTOCOLS.OPENAI } })),
    run((m) => m.testCardConnectivity({ card: { baseUrl: '   ', protocol: PROTOCOLS.OPENAI } })),
  ]).then(() => {
    assert.deepEqual(seen.map((s) => s.url), ['https://a.com/chat/completions', '   /chat/completions']);
  });
});

test('testCardConnectivity：anthropic 线路走 /v1/messages + x-api-key + 版本头', () => {
  const { seen, run } = probe({ status: 200 });
  return run((m) =>
    m.testCardConnectivity({ card: { baseUrl: 'https://a', protocol: PROTOCOLS.ANTHROPIC }, key: 'kk', model: 'mm' })
  ).then((r) => {
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://a/v1/messages');
    assert.equal(seen[0].opts.method, 'POST');
    assert.deepEqual(seen[0].opts.headers, {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'kk',
    });
    assert.deepEqual(JSON.parse(seen[0].opts.body), {
      model: 'mm',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(seen[0].opts.timeoutMs, 15000);
    assert.deepEqual(r, {
      ok: true,
      verdict: 'ok',
      label: '连通且鉴权通过',
      status: 200,
      latencyMs: r.latencyMs,
      model: 'mm',
    });
  });
});

test('testCardConnectivity：无 key 时不发任何鉴权头，模型回落到各线路默认值', () => {
  const { seen, run } = probe({ status: 200 });
  return Promise.all([
    run((m) => m.testCardConnectivity({ card: { baseUrl: 'https://a', protocol: PROTOCOLS.ANTHROPIC } })),
    run((m) => m.testCardConnectivity({ card: { baseUrl: 'https://o', protocol: PROTOCOLS.OPENAI } })),
    run((m) => m.testCardConnectivity({ card: { baseUrl: 'https://o', protocol: PROTOCOLS.RESPONSES }, key: '' })),
    run((m) => m.testCardConnectivity({ card: { baseUrl: 'https://g', protocol: PROTOCOLS.GEMINI } })),
  ]).then(() => {
    assert.equal(seen[0].url, 'https://a/v1/messages');
    assert.equal('x-api-key' in seen[0].opts.headers, false);
    assert.equal(JSON.parse(seen[0].opts.body).model, 'claude-sonnet-4-5');
    assert.equal(seen[1].url, 'https://o/chat/completions');
    assert.equal('authorization' in seen[1].opts.headers, false);
    assert.equal(JSON.parse(seen[1].opts.body).model, 'gpt-4o-mini');
    assert.equal(seen[2].url, 'https://o/chat/completions', 'responses wire probes chat/completions');
    assert.equal('authorization' in seen[2].opts.headers, false, 'empty key sends no Bearer');
    assert.equal(seen[3].url, 'https://g/v1beta/models:generateContent', 'no model part when probeModel empty');
    assert.deepEqual(seen[3].opts.headers, { 'content-type': 'application/json' });
    assert.deepEqual(JSON.parse(seen[3].opts.body), { contents: [{ parts: [{ text: 'ping' }] }] });
  });
});

test('testCardConnectivity：gemini 有模型时拼出 /v1beta/models/<model>:generateContent + x-goog-api-key', () => {
  const { seen, run } = probe({ status: 404 });
  return run((m) =>
    m.testCardConnectivity({ card: { baseUrl: 'https://g/', protocol: PROTOCOLS.GEMINI, defaultModel: 'gemini-2.5-pro' }, key: 'gk' })
  ).then((r) => {
    assert.equal(seen[0].url, 'https://g/v1beta/models/gemini-2.5-pro:generateContent');
    assert.deepEqual(seen[0].opts.headers, { 'content-type': 'application/json', 'x-goog-api-key': 'gk' });
    assert.deepEqual(r, {
      ok: false,
      verdict: 'model-not-found',
      label: '端点可达，模型不存在',
      status: 404,
      latencyMs: r.latencyMs,
      model: 'gemini-2.5-pro',
    });
    assert.equal(r.ok, false, 'only verdict ok maps to ok:true');
  });
});

test('testCardConnectivity：timeoutMs 只有正数生效，数字串强转，其余回落 15000', () => {
  const { seen, run } = probe({ status: 200 });
  return run((m) =>
    Promise.all([
      m.testCardConnectivity({ card: { baseUrl: 'https://x' }, timeoutMs: 1 }),
      m.testCardConnectivity({ card: { baseUrl: 'https://x' }, timeoutMs: '9000' }),
      m.testCardConnectivity({ card: { baseUrl: 'https://x' }, timeoutMs: 0 }),
      m.testCardConnectivity({ card: { baseUrl: 'https://x' }, timeoutMs: -100 }),
      m.testCardConnectivity({ card: { baseUrl: 'https://x' }, timeoutMs: 'abc' }),
      m.testCardConnectivity({ card: { baseUrl: 'https://x' }, timeoutMs: null }),
    ])
  ).then(() => {
    assert.deepEqual(seen.map((s) => s.opts.timeoutMs), [1, 9000, 15000, 15000, 15000, 15000]);
  });
});

test('testCardConnectivity：异常路径按 err.response.status / err.code 归类并保留 message', () => {
  const withStatus = Object.assign(new Error('http fail'), { response: { status: 401 }, code: 'ECONNRESET' });
  const codeOnly = Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
  const bare = new Error('nothing attached');
  const thrownString = 'plain rejection';
  return Promise.all([
    probe({ status: 200 }, async () => { throw withStatus; }).run((m) => m.testCardConnectivity({ card: { baseUrl: 'https://x' }, model: 'mm' })),
    probe({ status: 200 }, async () => { throw codeOnly; }).run((m) => m.testCardConnectivity({ card: { baseUrl: 'https://x' } })),
    probe({ status: 200 }, async () => { throw bare; }).run((m) => m.testCardConnectivity({ card: { baseUrl: 'https://x' } })),
    probe({ status: 200 }, async () => { throw thrownString; }).run((m) => m.testCardConnectivity({ card: { baseUrl: 'https://x' } })),
  ]).then((rs) => {
    assert.equal(rs[0].verdict, 'bad-key', 'status wins over the network code');
    assert.equal(rs[0].status, 401);
    assert.equal(rs[0].error, 'http fail');
    assert.equal(rs[0].model, 'mm');
    assert.equal(rs[1].verdict, 'unreachable');
    assert.equal(rs[1].status, 0);
    assert.equal(rs[2].error, 'nothing attached');
    assert.equal(rs[3].error, 'plain rejection', 'non-Error throws fall back to String(err)');
    for (const r of rs) assert.equal(r.ok, false);
  });
});

test('testCardConnectivity：响应缺 status 时归为 unknown，且返回体不带 error 键', () => {
  return probe({}).run((m) => m.testCardConnectivity({ card: { baseUrl: 'https://x' } })).then((r) => {
    assert.equal(r.verdict, 'unknown');
    assert.equal('status' in r, true);
    assert.equal(r.status, undefined);
    assert.equal('error' in r, false);
  });
});

test('testCardConnectivity：密钥不出现在结论里，卡片对象不被改写', () => {
  const card = { baseUrl: 'https://x', protocol: PROTOCOLS.OPENAI, defaultModel: 'dm', extra: 1 };
  const before = JSON.stringify(card);
  return probe({ status: 200 }, async (url, opts) => {
    assert.equal(opts.headers.authorization, 'Bearer SECRET-KEY');
    return { status: 200 };
  }).run((m) => m.testCardConnectivity({ card, key: 'SECRET-KEY' })).then((r) => {
    assert.equal(JSON.stringify(r).includes('SECRET-KEY'), false, 'the key never leaves the request headers');
    assert.equal(JSON.stringify(card), before, 'the caller card is untouched');
  });
});

test('KNOWN-DEFECT 只认 status===200：201/204 等 2xx 成功被判 unknown（与 spec 的 2xx 区间不一致）', () => {
  const spec = require('../../../gateway/providerConnectivitySpec');
  for (const s of [200, 201, 202, 204, 299]) {
    const mine = classify({ status: s });
    const theirs = spec.classifyConnectivityResult({ status: s });
    assert.equal(theirs.verdict, 'ok', `spec accepts ${s}`);
    assert.equal(mine.verdict, s === 200 ? 'ok' : 'unknown', `classify(${s}) is not ok`);
  }
  // Consequence: a probe whose upstream answers 204 reads as "未知结果" → ok:false.
  return probe({ status: 204 }).run((m) =>
    m.testCardConnectivity({ card: { baseUrl: 'https://x' } })
  ).then((r) => {
    assert.equal(r.ok, false);
    assert.equal(r.verdict, 'unknown');
  });
});

test('KNOWN-DEFECT 跳过结论有两种拼写：缺 baseUrl 报 "skipped"，构造失败报 "skip"', () => {
  return Promise.all([
    probe({ status: 200 }).run((m) => m.testCardConnectivity({ card: { baseUrl: '' } })),
    // Measured: the only reachable way into the in-body catch is a value
    // JSON.stringify refuses — a BigInt model on the openai family.
    probe({ status: 200 }).run((m) => m.testCardConnectivity({ card: { baseUrl: 'https://x' }, model: 10n })),
  ]).then(([noEndpoint, buildFailure]) => {
    assert.equal(noEndpoint.verdict, 'skipped');
    assert.equal(buildFailure.verdict, 'skip', 'two spellings for the same "did not probe" outcome');
    assert.match(buildFailure.label, /构造探针请求失败/);
    assert.equal('model' in buildFailure, false, 'the skip branch reports no model at all');
  });
});

test('KNOWN-DEFECT 头注释承诺 "never throws"，但 baseUrl 的 toString 抛错会击穿成 rejection', () => {
  const src = fs.readFileSync(SELF_PATH, 'utf-8');
  assert.match(src, /Fail-soft: never throws/, 'the module promises it in the header');
  const boom = {
    baseUrl: {
      toString() {
        throw new Error('host resolution exploded');
      },
    },
  };
  return probe({ status: 200 })
    .run((m) => m.testCardConnectivity({ card: boom }))
    .then(
      (r) => {
        throw new Error(`expected a rejection, got ${JSON.stringify(r)}`);
      },
      (e) => {
        assert.equal(e.message, 'host resolution exploded');
      }
    );
});

test('KNOWN-DEFECT 返回的 status 不做数字化，而 verdict 是按数字判的（两者可能不同形）', () => {
  return probe({ status: '503' }).run((m) =>
    m.testCardConnectivity({ card: { baseUrl: 'https://x' } })
  ).then((r) => {
    assert.equal(r.verdict, 'server-error');
    assert.equal(r.status, '503', 'raw string status is echoed while classify() compared 503');
    assert.equal(typeof r.status, 'string');
  });
});

test('KNOWN-DEFECT 探针实际使用的默认模型不回传：model 只反映入参', () => {
  const { seen, run } = probe({ status: 200 });
  return run((m) => m.testCardConnectivity({ card: { baseUrl: 'https://x', protocol: PROTOCOLS.OPENAI } })).then((r) => {
    assert.equal(JSON.parse(seen[0].opts.body).model, 'gpt-4o-mini', 'the request asked for the fallback model');
    assert.equal(r.model, undefined, 'the verdict hides which model was actually probed');
  });
});

test('KNOWN-DEFECT connectivity.js 引入 providerConnectivitySpec 却从未使用（死依赖）', () => {
  const src = fs.readFileSync(SELF_PATH, 'utf-8');
  assert.match(src, /require\('\.\.\/\.\.\/\.\.\/gateway\/providerConnectivitySpec'\)/);
  assert.equal(/\bspec\./.test(src), false, 'the binding `spec` is never read');
  assert.match(src, /Mirrors[\s\S]{0,12}providerConnectivitySpec/, 'the header claims a mirror nothing enforces');
});
