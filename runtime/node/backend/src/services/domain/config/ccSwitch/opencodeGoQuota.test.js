'use strict';

/**
 * opencodeGoQuota.js contract tests — env-only quota endpoint resolution,
 * tolerant three-window parsing, and the Bearer-auth fetch fail-soft contract.
 *
 * No real network: the module destructures `request` from utils/nativeHttp at
 * load time, so the stub is installed into require.cache by its fully resolved
 * path and the module under test is re-required fresh inside the (synchronous)
 * stub window, restored in a `finally`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseWindows, resolveQuotaUrl, WINDOWS } = require('./opencodeGoQuota');

const HTTP_PATH = require.resolve('../../../../utils/nativeHttp');
const SELF_PATH = require.resolve('./opencodeGoQuota');
const ENV_KEY = 'KHY_OPENCODE_GO_QUOTA_URL';

// Re-require the module under a stubbed nativeHttp. The window is intentionally
// synchronous: the fresh instance captures the stub by destructuring at load,
// so restoring the cache before the promise settles stays correct.
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

const envWithUrl = (extra = {}) => ({ [ENV_KEY]: 'https://quota.invalid/v1/usage', ...extra });
const stubReturning = (resp) => withStubbedRequest(async () => resp, (fresh) => fresh);

test('WINDOWS 固定为 5h/week/month 三窗口顺序', () => {
  assert.deepEqual(WINDOWS, ['5h', 'week', 'month']);
});

test('resolveQuotaUrl：只有非空字符串才算已配置，产出经 trim', () => {
  assert.equal(resolveQuotaUrl({}), null);
  assert.equal(resolveQuotaUrl({ [ENV_KEY]: '   ' }), null);
  assert.equal(resolveQuotaUrl({ [ENV_KEY]: '  https://x/y  ' }), 'https://x/y');
  assert.equal(resolveQuotaUrl(null), null, 'null env must not throw');
});

test('resolveQuotaUrl：假值降级为未配置，非字符串真值被 String() 硬转换', () => {
  for (const junk of [0, NaN, '', false, [], null, undefined]) {
    assert.equal(resolveQuotaUrl({ [ENV_KEY]: junk }), null, `env value ${String(junk)}`);
  }
  assert.equal(resolveQuotaUrl({ [ENV_KEY]: ['https://a'] }), 'https://a');
  assert.equal(resolveQuotaUrl({ [ENV_KEY]: 12 }), '12');
  // Measured: an object env value is not rejected — it stringifies to a garbage URL.
  assert.equal(resolveQuotaUrl({ [ENV_KEY]: {} }), '[object Object]');
});

test('未配置端点时诚实返回 configured:false 且绝不发起请求（零硬编码红线）', () => {
  let called = 0;
  return withStubbedRequest(
    async () => {
      called += 1;
      return { status: 200, body: {} };
    },
    (fresh) =>
      fresh.fetchOpenCodeGoQuota({ apiKey: 'k', env: {} }).then((r) => {
        assert.equal(called, 0, 'no request may be fired without an endpoint');
        assert.deepEqual(r, {
          ok: false,
          configured: false,
          error: '未配置 KHY_OPENCODE_GO_QUOTA_URL（零硬编码：额度端点必须由 env 提供）',
        });
      })
  );
});

test('已配置但缺 API 密钥：configured:true，不发请求（该端点只认 Bearer）', () => {
  let called = 0;
  return withStubbedRequest(
    async () => {
      called += 1;
      return { status: 200, body: {} };
    },
    (fresh) =>
      Promise.all([
        fresh.fetchOpenCodeGoQuota({ apiKey: '', env: envWithUrl() }),
        fresh.fetchOpenCodeGoQuota({ env: envWithUrl() }),
        fresh.fetchOpenCodeGoQuota({ apiKey: 0, env: envWithUrl() }),
      ]).then((rs) => {
        for (const r of rs) {
          assert.deepEqual(r, { ok: false, configured: true, error: '缺少 API 密钥（该端点只认 Bearer 认证）' });
        }
        assert.equal(called, 0);
      })
  );
});

test('请求形状：GET + Bearer 头 + 默认 10s 超时；垃圾 timeout 回落到 10000', () => {
  const seen = [];
  return withStubbedRequest(
    async (url, opts) => {
      seen.push({ url, opts });
      return { status: 200, body: { usage: [{ window: '5h', percent: 1 }] } };
    },
    (fresh) =>
      Promise.all([
        fresh.fetchOpenCodeGoQuota({ apiKey: 'sk-1', env: envWithUrl() }),
        fresh.fetchOpenCodeGoQuota({ apiKey: 'sk-2', timeoutMs: '8000', env: envWithUrl() }),
        fresh.fetchOpenCodeGoQuota({ apiKey: 'sk-3', timeoutMs: 0, env: envWithUrl() }),
        fresh.fetchOpenCodeGoQuota({ apiKey: 'sk-4', timeoutMs: -5, env: envWithUrl() }),
        fresh.fetchOpenCodeGoQuota({ apiKey: 'sk-5', timeoutMs: 'abc', env: envWithUrl() }),
      ]).then(() => {
        assert.equal(seen.length, 5);
        assert.equal(seen[0].url, 'https://quota.invalid/v1/usage');
        assert.equal(seen[0].opts.method, 'GET');
        assert.deepEqual(seen[0].opts.headers, { authorization: 'Bearer sk-1' });
        assert.equal(seen[0].opts.timeoutMs, 10000);
        assert.equal(seen[1].opts.timeoutMs, 8000, 'numeric strings are coerced');
        assert.deepEqual(seen.slice(2).map((s) => s.opts.timeoutMs), [10000, 10000, 10000]);
      })
  );
});

test('403 有专属文案，其余非 200 走通用文案；成功响应不带 status 字段', () => {
  const cases = [
    [403, { ok: false, configured: true, error: 'HTTP 403：密钥有效但未订阅 OpenCode Go 计划', status: 403 }],
    [500, { ok: false, configured: true, error: 'HTTP 500', status: 500 }],
    [404, { ok: false, configured: true, error: 'HTTP 404', status: 404 }],
  ];
  return Promise.all(
    cases.map(([status, expected]) =>
      withStubbedRequest(
        async () => ({ status, body: { windows: { '5h': { percent: 9 } } } }),
        (fresh) =>
          fresh.fetchOpenCodeGoQuota({ apiKey: 'k', env: envWithUrl() }).then((r) => {
            assert.deepEqual(r, expected, `status ${status}`);
          })
      )
    ).concat([
      withStubbedRequest(
        async () => ({ status: 200, body: { windows: { '5h': { percent: 9 } } } }),
        (fresh) =>
          fresh.fetchOpenCodeGoQuota({ apiKey: 'k', env: envWithUrl() }).then((r) => {
            assert.deepEqual(r, { ok: true, configured: true, windows: [{ window: '5h', percent: 9, resetAt: null }] });
            assert.equal('status' in r, false, 'success shape carries no status');
          })
      ),
    ])
  );
});

test('body 是 JSON 字符串时先解析；形状无法识别时报 status:200 的诚实失败', () => {
  return Promise.all([
    withStubbedRequest(
      async () => ({ status: 200, body: JSON.stringify({ week: { percent: 12.5, resetAt: '2026-10-01' } }) }),
      (fresh) =>
        fresh.fetchOpenCodeGoQuota({ apiKey: 'k', env: envWithUrl() }).then((r) => {
          assert.deepEqual(r.windows, [{ window: 'week', percent: 12.5, resetAt: '2026-10-01' }]);
          assert.equal(r.ok, true);
        })
    ),
    withStubbedRequest(
      async () => ({ status: 200, body: { nothing: 'usable' } }),
      (fresh) =>
        fresh.fetchOpenCodeGoQuota({ apiKey: 'k', env: envWithUrl() }).then((r) => {
          assert.deepEqual(r, { ok: false, configured: true, error: '无法识别的用量响应形状', status: 200 });
        })
    ),
    withStubbedRequest(
      async () => ({ status: 200, body: null }),
      (fresh) =>
        fresh.fetchOpenCodeGoQuota({ apiKey: 'k', env: envWithUrl() }).then((r) => {
          assert.equal(r.error, '无法识别的用量响应形状');
        })
    ),
  ]);
});

test('请求抛错被吞成 verdict 对象：Error 用 message，非 Error 用 String(e)', () => {
  return Promise.all([
    withStubbedRequest(
      async () => {
        throw new Error('socket hang up');
      },
      (fresh) =>
        fresh.fetchOpenCodeGoQuota({ apiKey: 'k', env: envWithUrl() }).then((r) => {
          assert.deepEqual(r, { ok: false, configured: true, error: 'socket hang up' });
        })
    ),
    withStubbedRequest(
      async () => {
        throw 'plain string';
      },
      (fresh) =>
        fresh.fetchOpenCodeGoQuota({ apiKey: 'k', env: envWithUrl() }).then((r) => {
          assert.equal(r.error, 'plain string');
        })
    ),
    withStubbedRequest(
      async () => {
        throw null;
      },
      (fresh) =>
        fresh.fetchOpenCodeGoQuota({ apiKey: 'k', env: envWithUrl() }).then((r) => {
          assert.equal(r.error, 'null');
        })
    ),
  ]);
});

test('env 缺省回落到 process.env（临时注入后原样还原，不留下状态）', async () => {
  const original = process.env[ENV_KEY];
  process.env[ENV_KEY] = 'https://quota.invalid/from-process-env';
  try {
    const withKey = await withStubbedRequest(
      async (url) => {
        assert.equal(url, 'https://quota.invalid/from-process-env');
        return { status: 200, body: { month: { percent: 1 } } };
      },
      (fresh) => fresh.fetchOpenCodeGoQuota({ apiKey: 'k' })
    );
    assert.equal(withKey.ok, true);
    // A no-arg call also reads process.env instead of throwing.
    const noKey = await withStubbedRequest(
      async () => ({ status: 200, body: { month: { percent: 1 } } }),
      (fresh) => fresh.fetchOpenCodeGoQuota()
    );
    assert.deepEqual(noKey, { ok: false, configured: true, error: '缺少 API 密钥（该端点只认 Bearer 认证）' });
  } finally {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  }
  assert.equal(process.env[ENV_KEY], original, 'the injected env var left no residue');
});

test('env 传成非对象真值时降级为未配置而不是抛错', () => {
  return withStubbedRequest(
    async () => ({ status: 200, body: {} }),
    (fresh) =>
      Promise.all([
        fresh.fetchOpenCodeGoQuota({ apiKey: 'k', env: 'not-an-env' }),
        fresh.fetchOpenCodeGoQuota({ apiKey: 'k', env: 42 }),
        fresh.fetchOpenCodeGoQuota({ apiKey: 'k', env: [] }),
      ]).then((rs) => {
        for (const r of rs) assert.equal(r.configured, false, JSON.stringify(r));
      })
  );
});

test('parseWindows：三种形状归一到同一输出契约并按 WINDOWS 排序', () => {
  assert.deepEqual(
    parseWindows({ windows: { month: { percent: 30 }, week: { percent: 20 }, '5h': { percent: 10 } } }),
    [
      { window: '5h', percent: 10, resetAt: null },
      { window: 'week', percent: 20, resetAt: null },
      { window: 'month', percent: 30, resetAt: null },
    ],
    'output order follows WINDOWS, not the input order'
  );
  assert.deepEqual(
    parseWindows({ usage: [{ window: 'month', percent: 3 }, { window: '5h', percent: 1 }, 'junk', { window: 'unknown', percent: 9 }] }),
    [
      { window: '5h', percent: 1, resetAt: null },
      { window: 'month', percent: 3, resetAt: null },
    ],
    'usage array shape ignores unknown windows and non-object items'
  );
  assert.deepEqual(
    parseWindows({ '5h': { percent: 0 }, week: { percent: 1, resetAt: '  2026 ' }, month: { percent: 2, resetAt: null } }),
    [
      { window: '5h', percent: 0, resetAt: null },
      { window: 'week', percent: 1, resetAt: '  2026 ' },
      { window: 'month', percent: 2, resetAt: null },
    ],
    'bare shape; resetAt is trimmed only for the emptiness test, never in the output'
  );
});

test('parseWindows：percent 强制数字并夹进 [0,100]；不可换算的值整条丢弃', () => {
  assert.deepEqual(parseWindows({ '5h': { percent: 150, resetAt: 'x' } }), [
    { window: '5h', percent: 100, resetAt: 'x' },
  ]);
  assert.deepEqual(parseWindows({ week: { percent: -5 } }), [{ window: 'week', percent: 0, resetAt: null }]);
  assert.deepEqual(parseWindows({ week: { percent: '12' } }), [{ window: 'week', percent: 12, resetAt: null }]);
  for (const bad of [NaN, 'x', undefined, '12kg', Infinity, -Infinity]) {
    assert.deepEqual(parseWindows({ '5h': { percent: bad } }), [], `percent=${String(bad)} dropped`);
  }
  // Measured: Number() coercion accepts true→1, []→0, ['7']→7 — and null/''/false
  // are NOT "missing", they are a real 0% window.
  assert.deepEqual(parseWindows({ '5h': { percent: true } }), [{ window: '5h', percent: 1, resetAt: null }]);
  assert.deepEqual(parseWindows({ '5h': { percent: [] } }), [{ window: '5h', percent: 0, resetAt: null }]);
  assert.deepEqual(parseWindows({ '5h': { percent: ['7'] } }), [{ window: '5h', percent: 7, resetAt: null }]);
  for (const zero of [null, '', false]) {
    assert.deepEqual(parseWindows({ '5h': { percent: zero } }), [
      { window: '5h', percent: 0, resetAt: null },
    ], `percent=${String(zero)} becomes a 0% window, not a skipped one`);
  }
});

test('parseWindows：非对象条目与 resetAt 的非字符串形状安全降级', () => {
  assert.deepEqual(parseWindows({ '5h': 'x', week: 7, month: null }), []);
  assert.deepEqual(parseWindows({ '5h': { percent: 3, resetAt: '   ' } }), [
    { window: '5h', percent: 3, resetAt: null },
  ]);
  assert.deepEqual(parseWindows({ '5h': { percent: 3, resetAt: 12345 } }), [
    { window: '5h', percent: 3, resetAt: null },
  ]);
  // The "丢弃占位重置时间" special case only fires when resetAt is ALREADY absent.
  assert.deepEqual(parseWindows({ '5h': { percent: 0, resetAt: 'soon' } }), [
    { window: '5h', percent: 0, resetAt: 'soon' },
  ]);
});

test('parseWindows：垃圾 body 一律返回空数组，绝不抛错', () => {
  for (const body of [null, undefined, 'str', 42, [], true, () => 1]) {
    assert.doesNotThrow(() => parseWindows(body));
    assert.deepEqual(parseWindows(body), [], `body=${String(body)}`);
  }
});

test('KNOWN-DEFECT windows 数组形状被静默丢弃（usage 数组却支持），顶层 _arr 键还会撞内部哨兵', () => {
  // Measured: `{windows: [...]}` passes the `typeof === 'object'` gate, so the
  // array wins as `src`; then `src['5h']` and `src._arr` are both absent → [].
  assert.deepEqual(parseWindows({ windows: [{ window: '5h', percent: 30, resetAt: 't' }] }), []);
  // The same entries handed over as `usage` parse fine — asymmetric tolerance.
  assert.deepEqual(parseWindows({ usage: [{ window: '5h', percent: 30, resetAt: 't' }] }), [
    { window: '5h', percent: 30, resetAt: 't' },
  ]);
  // `windows` winning over `usage` also silently drops the supported shape:
  assert.deepEqual(parseWindows({ windows: { '5h': { percent: 1 } }, usage: [{ window: 'week', percent: 9 }] }), [
    { window: '5h', percent: 1, resetAt: null },
  ]);
  // And the private `_arr` sentinel is reachable from a real payload key:
  assert.deepEqual(parseWindows({ _arr: [{ window: 'month', percent: 7 }] }), [
    { window: 'month', percent: 7, resetAt: null },
  ]);
});

test('KNOWN-DEFECT status 用严格相等：字符串 "200" 的成功响应被报成 "HTTP 200"，且异常分支丢失 status', () => {
  return Promise.all([
    stubReturning({ status: '200', body: { '5h': { percent: 1 } } })
      .fetchOpenCodeGoQuota({ apiKey: 'k', env: envWithUrl() })
      .then((r) => {
        assert.deepEqual(r, { ok: false, configured: true, error: 'HTTP 200', status: '200' });
      }),
    // Same string shape for 403 loses the dedicated "未订阅" wording.
    stubReturning({ status: '403', body: {} })
      .fetchOpenCodeGoQuota({ apiKey: 'k', env: envWithUrl() })
      .then((r) => {
        assert.equal(r.error, 'HTTP 403');
        assert.ok(!/未订阅/.test(r.error), 'the friendly 403 branch was skipped');
      }),
    // The catch branch reports no status at all, so a malformed-JSON 200 is
    // indistinguishable from a network failure for the caller.
    stubReturning({ status: 200, body: 'not json' })
      .fetchOpenCodeGoQuota({ apiKey: 'k', env: envWithUrl() })
      .then((r) => {
        assert.equal(r.ok, false);
        assert.equal(r.configured, true);
        assert.equal('status' in r, false, 'status dropped on the JSON-parse path');
        assert.match(r.error, /JSON|Unexpected/);
      }),
  ]);
});
