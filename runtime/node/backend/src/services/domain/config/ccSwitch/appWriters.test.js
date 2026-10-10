'use strict';

/**
 * Colocated contract tests for appWriters.js (ccSwitch 逐应用 live-config 写入层).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 *
 * Isolation: appWriters is the only write-capable module in the ccSwitch domain,
 * so EVERY write seam is stubbed in require.cache keyed by the FULL resolved path
 * (extension included) and restored in `after`:
 *   - the 11 external-app adapters (src/services/domain/network/externalApps/*Adapter.js)
 *   - the gateway codex adapter (src/services/gateway/adapters/codexAdapter.js)
 *   - ./codexWriter (per-case stub, since applyCardToApp requires it lazily)
 * and src/utils/dataHome.js is redirected into a directory created by
 * fs.mkdtempSync(os.tmpdir()) so the read-only proxy-access path never touches
 * ~/.khy, ~/.khyquant or the repo tree. The stubs record payloads instead of
 * writing, so no case in this suite can mutate a real external-app config.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('node:path');
const crypto = require('node:crypto');

const SRC = path.resolve(__dirname, '../../../..');
const EXT_APPS_DIR = path.join(SRC, 'services/domain/network/externalApps');
const DATAHOME_ID = require.resolve(path.join(SRC, 'utils/dataHome.js'));
const GATEWAY_CODEX_ID = require.resolve(path.join(SRC, 'services/gateway/adapters/codexAdapter.js'));
const CODEXWRITER_ID = require.resolve(path.join(__dirname, 'codexWriter.js'));

const ADAPTERS = [
  'claudeCodeAdapter',
  'opencodeAdapter',
  'geminiCliAdapter',
  'commandCodeAdapter',
  'ycodeAdapter',
  'zcodeAdapter',
  'deepseekTuiAdapter',
  'reasonixAdapter',
  'openclawAdapter',
  'cozeAdapter',
  'traeAppAdapter',
];

const calls = [];
const addOutcomes = {};
const listOutcomes = {};
const savedCache = new Map();
const tmpRoots = [];

let HOME_DIR = null;
let LEGACY_DIR = null;
let codexSnap = null;

function cacheStub(absPath, exports) {
  const id = require.resolve(absPath);
  if (!savedCache.has(id)) savedCache.set(id, require.cache[id]);
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return id;
}

function restoreCache() {
  for (const [id, entry] of savedCache) {
    if (entry) require.cache[id] = entry;
    else delete require.cache[id];
  }
  savedCache.clear();
}

// ── stub installation (must happen BEFORE requiring the module under test) ──
for (const name of ADAPTERS) {
  cacheStub(path.join(EXT_APPS_DIR, `${name}.js`), {
    add: (payload) => {
      calls.push({ name, payload });
      const custom = addOutcomes[name];
      return typeof custom === 'function'
        ? custom(payload)
        : { success: true, wrote: `${name}:${payload.endpoint}` };
    },
    list: () => {
      const custom = listOutcomes[name];
      if (typeof custom === 'function') return custom();
      return { success: true, providers: [{ id: `${name}-default` }] };
    },
  });
}

cacheStub(GATEWAY_CODEX_ID, {
  getCodexUpstreamSnapshot: () => codexSnap,
});

const savedDataHome = require.cache[DATAHOME_ID];
const savedEndpointEnv = process.env.KHY_PROXY_ENDPOINT;
require.cache[DATAHOME_ID] = {
  id: DATAHOME_ID,
  filename: DATAHOME_ID,
  loaded: true,
  exports: {
    getDataHome: () => HOME_DIR,
    getLegacyDataHome: () => LEGACY_DIR,
    getAppHome: () => HOME_DIR,
  },
};

const aw = require('./appWriters');
const { APPS, PROTOCOLS } = require('./constants');

test.after(() => {
  if (savedDataHome) require.cache[DATAHOME_ID] = savedDataHome;
  else delete require.cache[DATAHOME_ID];
  if (savedEndpointEnv === undefined) delete process.env.KHY_PROXY_ENDPOINT;
  else process.env.KHY_PROXY_ENDPOINT = savedEndpointEnv;
  restoreCache();
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

/** Fresh temp homes; every file this suite reads/writes lives under root. */
function useHomes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ccswitch-writers-'));
  tmpRoots.push(root);
  HOME_DIR = path.join(root, 'home');
  LEGACY_DIR = path.join(root, 'legacy');
  fs.mkdirSync(HOME_DIR, { recursive: true });
  assert.ok(HOME_DIR.startsWith(root), 'stubbed data home must be inside the temp root');
  delete process.env.KHY_PROXY_ENDPOINT;
  calls.length = 0;
  return root;
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  assert.ok(file.startsWith(HOME_DIR), '接入文件必须写在临时 data home 内');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

/** Temp home + a "gateway is running" runtime/auth pair. */
function useGateway(overrides = {}) {
  const root = useHomes();
  const opts = { endpoint: 'http://127.0.0.1:9100', token: 'khy-gateway-token-abcdef', ...overrides };
  if (opts.endpoint !== null) {
    const doc = { endpoint: opts.endpoint };
    if (opts.startedAt !== undefined) doc.startedAt = opts.startedAt;
    writeJson(HOME_DIR, 'proxy_server_runtime.json', doc);
  }
  if (opts.token !== null) writeJson(HOME_DIR, 'proxy_server_auth.json', { authToken: opts.token });
  if (opts.pool) writeJson(HOME_DIR, 'api_keys.json', opts.pool);
  return root;
}

function keyIdFor(provider, key) {
  return crypto.createHash('md5').update(`${provider}:${key}`).digest('hex').slice(0, 12);
}

function makeCard(overrides = {}) {
  return {
    id: 'c1',
    name: 'DeepSeek API',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: PROTOCOLS.OPENAI,
    models: ['deepseek-chat'],
    defaultModel: 'deepseek-chat',
    ...overrides,
  };
}

function makeStore({ credential = 'sk-from-store', throwOnCredential = false, throwOnSetMode = false } = {}) {
  const seen = [];
  const agentModes = [];
  return {
    seen,
    agentModes,
    getCardCredential(id) {
      seen.push(id);
      if (throwOnCredential) throw new Error('pool read blew up');
      return credential;
    },
    setAgentMode(app, mode, cardId) {
      agentModes.push([app, mode, cardId]);
      if (throwOnSetMode) throw new Error('bookkeeping blew up');
    },
  };
}

function withCodexWriterStub(stubExports, body) {
  if (!savedCache.has(CODEXWRITER_ID)) savedCache.set(CODEXWRITER_ID, require.cache[CODEXWRITER_ID]);
  require.cache[CODEXWRITER_ID] = {
    id: CODEXWRITER_ID,
    filename: CODEXWRITER_ID,
    loaded: true,
    exports: stubExports,
  };
  try {
    return body();
  } finally {
    const saved = savedCache.get(CODEXWRITER_ID);
    if (saved) require.cache[CODEXWRITER_ID] = saved;
    else delete require.cache[CODEXWRITER_ID];
    savedCache.delete(CODEXWRITER_ID);
  }
}

const ALL_PROTOCOLS = [PROTOCOLS.OPENAI, PROTOCOLS.ANTHROPIC, PROTOCOLS.RESPONSES, PROTOCOLS.GEMINI];

// ─────────────────────────────── preflight ──────────────────────────────────

test('preflightCardForApp：协议门按应用逐个拒绝，被拒时只给 ok/reason 两键', () => {
  const verdicts = {};
  for (const app of Object.values(APPS)) {
    verdicts[app] = {};
    for (const protocol of ALL_PROTOCOLS) {
      verdicts[app][protocol] = aw.preflightCardForApp({ name: 'N', baseUrl: 'https://a', protocol }, app);
    }
  }
  // claude-code never rejects on protocol.
  assert.deepEqual(verdicts[APPS.CLAUDE_CODE][PROTOCOLS.OPENAI], {
    ok: true,
    reason: '卡片为 OpenAI 协议，Claude Code 需经 khy 代理转换（ANTHROPIC_BASE_URL 指向本地代理）',
  }, 'OpenAI 卡片给的是「带建议的放行」');
  assert.deepEqual(verdicts[APPS.CLAUDE_CODE][PROTOCOLS.ANTHROPIC], { ok: true });
  assert.deepEqual(verdicts[APPS.CLAUDE_CODE][PROTOCOLS.GEMINI], { ok: true });
  // codex / ycode：只收 OpenAI 兼容两种。
  assert.deepEqual(verdicts[APPS.CODEX][PROTOCOLS.ANTHROPIC], {
    ok: false,
    reason: 'Codex 仅支持 OpenAI 兼容协议（openai / openai_responses）',
  });
  assert.deepEqual(verdicts[APPS.CODEX][PROTOCOLS.GEMINI].ok, false);
  assert.equal(verdicts[APPS.CODEX][PROTOCOLS.RESPONSES].ok, true);
  assert.deepEqual(verdicts[APPS.YCODE][PROTOCOLS.ANTHROPIC], {
    ok: false,
    reason: 'YCode api 连接仅支持 OpenAI 兼容协议（openai / openai_responses）',
  });
  // opencode / zcode：openai + anthropic 两种。
  assert.deepEqual(verdicts[APPS.OPENCODE][PROTOCOLS.RESPONSES], {
    ok: false,
    reason: 'OpenCode 支持 openai / anthropic 协议',
  });
  assert.deepEqual(verdicts[APPS.ZCODE][PROTOCOLS.GEMINI], {
    ok: false,
    reason: 'ZCode 仅支持 anthropic / OpenAI 兼容端点（openai / anthropic 协议卡片）；其余协议请先经 khy 代理转换为 OpenAI 协议',
  });
  assert.equal(verdicts[APPS.ZCODE][PROTOCOLS.ANTHROPIC].ok, true);
  // 无协议门的应用：gemini/deepseek/reasonix/openclaw/coze/trae 全放行。
  for (const app of [APPS.GEMINI, APPS.DEEPSEEK, APPS.REASONIX, APPS.OPENCLAW, APPS.COZE, APPS.TRAE]) {
    for (const protocol of ALL_PROTOCOLS) {
      assert.deepEqual(verdicts[app][protocol], { ok: true }, `${app}/${protocol}`);
    }
  }
  // 未知应用同样落到兜底放行。
  assert.deepEqual(verdicts[APPS.COMMAND_CODE][PROTOCOLS.GEMINI].ok, false);
  assert.deepEqual(aw.preflightCardForApp({ name: 'N', baseUrl: 'https://a', protocol: 'openai' }, 'nope'), { ok: true });
  // 卡片没有 protocol 字段时按「非 OpenAI」处理：codex 因此也拒。
  assert.equal(aw.preflightCardForApp({ name: 'N', baseUrl: 'https://a' }, APPS.CODEX).ok, false);
});

test('KNOWN-DEFECT preflightCardForApp(command-code)：门放过 openai_responses，文案却只列 openai / anthropic', () => {
  const card = { name: 'N', baseUrl: 'https://a' };
  // Gate allows responses ...
  assert.deepEqual(aw.preflightCardForApp({ ...card, protocol: PROTOCOLS.RESPONSES }, APPS.COMMAND_CODE), { ok: true });
  // ... and rejects only gemini, with a message that omits responses.
  assert.deepEqual(aw.preflightCardForApp({ ...card, protocol: PROTOCOLS.GEMINI }, APPS.COMMAND_CODE), {
    ok: false,
    reason: 'Command Code BYOK 支持 openai / anthropic 协议',
  });
  // Asymmetry: ZCode has the SAME two-wire capability list but a message that
  // documents the fallback path, while Command Code's text under-states its gate.
  assert.deepEqual(aw.preflightCardForApp({ ...card, protocol: PROTOCOLS.RESPONSES }, APPS.ZCODE).ok, false);
});

test('preflightCardForApp：卡片名与 baseUrl 缺失的两类前置拒绝（含 0 / 空串假值）', () => {
  assert.deepEqual(aw.preflightCardForApp(null, APPS.CODEX), { ok: false, reason: '卡片无效（缺少名称）' });
  assert.deepEqual(aw.preflightCardForApp(undefined, APPS.CODEX), { ok: false, reason: '卡片无效（缺少名称）' });
  assert.deepEqual(aw.preflightCardForApp({}, APPS.CODEX), { ok: false, reason: '卡片无效（缺少名称）' });
  assert.deepEqual(aw.preflightCardForApp({ name: '' , baseUrl: 'https://a' }, APPS.CODEX), {
    ok: false,
    reason: '卡片无效（缺少名称）',
  });
  assert.deepEqual(aw.preflightCardForApp({ name: 'N' }, APPS.CODEX), { ok: false, reason: '卡片缺少 baseUrl，无法切换' });
  assert.deepEqual(aw.preflightCardForApp({ name: 'N', baseUrl: 0 }, APPS.CODEX), {
    ok: false,
    reason: '卡片缺少 baseUrl，无法切换',
  });
  // name 非字符串但 truthy 就通过（0 除外）；协议门随后按字面比较。
  assert.deepEqual(aw.preflightCardForApp({ name: 123, baseUrl: 'https://a', protocol: 'openai' }, APPS.CODEX), { ok: true });
  // 代理模式下同样要求 baseUrl（池条目缺 endpoint 路由不可解析）。
  assert.deepEqual(aw.preflightCardForApp({ name: 'N' }, APPS.CODEX, { mode: 'proxy' }), {
    ok: false,
    reason: '卡片缺少 baseUrl，无法切换',
  });
});

test('preflightCardForApp：mode="proxy" 一律放行，其余 mode 走直连门', () => {
  const card = { name: 'N', baseUrl: 'https://a', protocol: PROTOCOLS.GEMINI };
  for (const app of Object.values(APPS)) {
    assert.deepEqual(aw.preflightCardForApp(card, app, { mode: 'proxy' }), { ok: true }, app);
  }
  assert.equal(aw.preflightCardForApp(card, APPS.CODEX, { mode: 'direct' }).ok, false);
  assert.equal(aw.preflightCardForApp(card, APPS.CODEX, { mode: 'PROXY' }).ok, false, '大小写敏感');
  assert.equal(aw.preflightCardForApp(card, APPS.CODEX, { mode: '' }).ok, false);
});

test('KNOWN-DEFECT preflightCardForApp：不传 opts 时默认按 direct 从严，而 applyCardToApp 默认是 proxy 从宽', () => {
  const card = { name: 'N', baseUrl: 'https://a', protocol: PROTOCOLS.GEMINI };
  // Direct call without opts → strict gate.
  assert.equal(aw.preflightCardForApp(card, APPS.CODEX).ok, false);
  assert.equal(aw.preflightCardForApp(card, APPS.CODEX, {}).ok, false);
  // But applyCardToApp's own default mode is proxy, where the same card passes.
  assert.deepEqual(aw.preflightCardForApp(card, APPS.CODEX, { mode: 'proxy' }), { ok: true });
  useHomes();
  // OPENCODE is used here on purpose: the codex branch reaches codexWriter,
  // which resolves ~/.codex through os.homedir() and is not stubbed in this case.
  return aw.applyCardToApp(card, APPS.OPENCODE, { proxyBaseUrl: 'http://e:1', proxyToken: 't' }).then((r) => {
    assert.equal(r.mode, 'proxy', '未显式传 mode → 写入路径按 proxy 语义跑');
    assert.equal(r.success, true);
  });
});

// ─────────────────────────────── applyCardToApp ─────────────────────────────

test('applyCardToApp：默认模式是 proxy，网关接入缺失时状态透明失败且不触碰任何适配器', async () => {
  useHomes();
  const store = makeStore();
  const res = await aw.applyCardToApp(makeCard(), APPS.CLAUDE_CODE, { store });
  assert.equal(res.mode, 'proxy');
  assert.equal(res.success, false);
  assert.equal(res.app, 'claude-code');
  assert.match(res.error, /^代理未运行：未发现网关端点/);
  assert.equal(res.detail, undefined);
  assert.deepEqual(calls, [], '接入失败必须发生在写盘之前');
  assert.deepEqual(store.agentModes, []);
  assert.deepEqual(store.seen, ['c1'], '凭据读取先于接入解析');
});

test('applyCardToApp(claude-code, proxy)：写网关端点 + 网关令牌 + 三段可路由模型名（池扫 poolKey）', async () => {
  const poolKey = 'deepseek_api';
  const realKey = 'sk-real-1';
  useGateway({ pool: { [poolKey]: [{ key: realKey }] } });
  const card = makeCard({ keyId: keyIdFor(poolKey, realKey) });
  const store = makeStore();
  const res = await aw.applyCardToApp(card, APPS.CLAUDE_CODE, { store });
  assert.equal(res.success, true);
  assert.deepEqual(calls, [
    {
      name: 'claudeCodeAdapter',
      payload: {
        provider: 'deepseek_api',
        model: 'api:deepseek_api:deepseek-chat',
        apiKey: 'khy-gateway-token-abcdef',
        endpoint: 'http://127.0.0.1:9100',
        literalAnthropicEnv: true,
      },
    },
  ], '代理模式：真实 key 必须被网关令牌覆盖，模型名改写成三段可路由格式');
  assert.deepEqual(res.detail.proxy, {
    endpoint: 'http://127.0.0.1:9100',
    tokenMasked: 'khy-ga…cdef',
    poolKey: 'deepseek_api',
    poolKeySource: 'pool-scan',
    model: 'api:deepseek_api:deepseek-chat',
    source: { endpoint: 'runtime-file', token: 'runtime-file' },
  });
  assert.equal(res.detail.wrote, 'claudeCodeAdapter:http://127.0.0.1:9100', 'detail 是适配器返回值 + proxy 键');
  assert.equal(card.baseUrl, 'https://api.deepseek.com/v1', '入参卡片不被就地改写');
  assert.deepEqual(store.seen, ['c1']);
  assert.deepEqual(store.agentModes, [['claude-code', 'proxy', 'c1']]);
});

test('applyCardToApp：池里扫不到 keyId 时 poolKey 回退卡片名 slug（name-fallback）', async () => {
  useGateway({ pool: { other_provider: [{ key: 'sk-other' }] } });
  const res = await aw.applyCardToApp(makeCard({ keyId: 'aaaaaaaaaaaa' }), APPS.OPENCODE, {});
  assert.equal(res.detail.proxy.poolKeySource, 'name-fallback');
  assert.equal(res.detail.proxy.poolKey, 'deepseek_api', '「DeepSeek API」→ slug');
  assert.equal(calls[0].payload.model, 'api:deepseek_api:deepseek-chat');
  // 没有 keyId 字段也走回退，且卡片名是垃圾时 poolKey 为空 → 模型名原样透传。
  const res2 = await aw.applyCardToApp(makeCard({ keyId: undefined, name: '!!!' }), APPS.OPENCODE, {});
  assert.equal(res2.detail.proxy.poolKey, '');
  assert.equal(res2.detail.proxy.model, 'deepseek-chat', '无 poolKey 时不拼三段格式');
});

test('applyCardToApp(claude-code, direct)：写真实端点与真实 key，literalAnthropicEnv=false 且不回写 agentMode', async () => {
  useHomes();
  const store = makeStore({ credential: 'sk-from-store' });
  const res = await aw.applyCardToApp(makeCard(), APPS.CLAUDE_CODE, { mode: 'direct', store });
  assert.equal(res.success, true);
  assert.equal(res.mode, 'direct');
  assert.deepEqual(calls[0].payload, {
    provider: 'deepseek_api',
    model: 'deepseek-chat',
    apiKey: 'sk-from-store',
    endpoint: 'https://api.deepseek.com/v1',
    literalAnthropicEnv: false,
  });
  assert.deepEqual(store.agentModes, [], 'direct 是历史默认，不污染 agentMode');
  assert.deepEqual(res.detail, { success: true, wrote: 'claudeCodeAdapter:https://api.deepseek.com/v1' }, 'detail 即适配器返回值，无 proxy 键');
});

test('applyCardToApp：显式 proxyBaseUrl + proxyToken 短路接入解析，detail 保留尾斜杠、适配器收到去尾斜杠', async () => {
  useHomes();
  const res = await aw.applyCardToApp(makeCard(), APPS.ZCODE, {
    proxyBaseUrl: 'http://explicit:1/v1/',
    proxyToken: 'tok',
  });
  assert.equal(res.success, true);
  assert.equal(res.detail.proxy.endpoint, 'http://explicit:1/v1/', '未去尾斜杠');
  assert.equal(res.detail.proxy.source.endpoint, 'explicit');
  assert.equal(res.detail.proxy.source.token, 'explicit');
  assert.equal(calls[0].payload.endpoint, 'http://explicit:1/v1', 'buildProxyCard 去了尾斜杠');
  assert.equal(calls[0].payload.provider, 'DeepSeek API', 'zcode 用原始卡片名（不 slug）');
  assert.equal(calls[0].payload.protocol, 'openai', 'protocol 从原卡片透传');
  assert.deepEqual(calls[0].payload.apiKey, 'tok');
});

test('KNOWN-DEFECT applyCardToApp：显式端点配空令牌会退回解析真实接入（&& 门只认成对参数）', async () => {
  useHomes();
  const res = await aw.applyCardToApp(makeCard(), APPS.CLAUDE_CODE, { proxyBaseUrl: 'http://e:1', proxyToken: '' });
  assert.equal(res.success, false);
  assert.match(res.error, /^代理未运行/, '本应使用显式端点，却整条改走 runtime 文件解析');
  // Same with the reverse pairing.
  const res2 = await aw.applyCardToApp(makeCard(), APPS.CLAUDE_CODE, { proxyBaseUrl: '', proxyToken: 'tok' });
  assert.equal(res2.success, false);
  assert.match(res2.error, /^代理未运行/);
  // And the temp home was NOT consulted for a file we never wrote: still zero writes.
  assert.deepEqual(calls, []);
});

test('applyCardToApp：网关令牌脱敏（空串 / ≤10 全遮 / >10 留首 6 末 4）', async () => {
  const cases = [
    ['0123456789', '****'],
    ['01234567890', '012345…7890'],
    ['khy-' + 'a'.repeat(48), 'khy-aa…aaaa'],
  ];
  for (const [token, masked] of cases) {
    useGateway({ token });
    const res = await aw.applyCardToApp(makeCard(), APPS.GEMINI, {});
    assert.equal(res.detail.proxy.tokenMasked, masked, token);
    assert.ok(!JSON.stringify(res).includes(token), '返回值绝不含令牌原文');
  }
  // Empty token: proxy access resolution itself fails before masking.
  useGateway({ token: '' });
  const noToken = await aw.applyCardToApp(makeCard(), APPS.GEMINI, {});
  assert.equal(noToken.success, false);
  assert.match(noToken.error, /^网关令牌不可用/);
});

// ────────────────────────────────── codex ───────────────────────────────────

test('applyCardToApp(codex)：透传给 codexWriter 的字段与 wireApi / requiresOpenaiAuth 归一', async () => {
  useGateway({});
  const seen = [];
  const stub = {
    setCodexUpstreamConfigOnly: (o) => {
      seen.push(o);
      return { success: true, configPath: '/tmp/never', provider: o.providerName };
    },
  };
  await withCodexWriterStub(stub, () =>
    aw.applyCardToApp(makeCard(), APPS.CODEX, { proxyBaseUrl: 'http://e:1', proxyToken: 'tok' })
  );
  assert.deepEqual(seen, [
    {
      providerName: 'DeepSeek API',
      baseUrl: 'http://e:1',
      model: 'api:deepseek_api:deepseek-chat',
      apiKey: 'tok',
      wireApi: 'chat',
      requiresOpenaiAuth: false,
    },
  ], 'codex 走原始卡片名；requiresOpenaiAuth 只认真字 true');

  await withCodexWriterStub(stub, () =>
    aw.applyCardToApp(
      makeCard({ protocol: PROTOCOLS.RESPONSES, wireApi: 'CHAT', requiresOpenaiAuth: 'yes' }),
      APPS.CODEX,
      { mode: 'direct', key: 'sk' }
    )
  );
  assert.deepEqual(seen[1], {
    providerName: 'DeepSeek API',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: 'sk',
    wireApi: 'CHAT',
    requiresOpenaiAuth: false,
  }, 'card.wireApi 原样送出（大小写归一交给 codexWriter）；responses 协议只在 wireApi 缺省时生效');

  await withCodexWriterStub(stub, () =>
    aw.applyCardToApp(makeCard({ wireApi: '', protocol: PROTOCOLS.RESPONSES, requiresOpenaiAuth: true }), APPS.CODEX, {
      mode: 'direct',
      key: 'sk',
    })
  );
  assert.equal(seen[2].wireApi, 'responses');
  assert.equal(seen[2].requiresOpenaiAuth, true);
});

test('KNOWN-DEFECT applyCardToApp(codex)：writer 返回 success:false 仍上报 success:true（硬编码）', async () => {
  useHomes();
  const stub = { setCodexUpstreamConfigOnly: () => ({ success: false, error: 'codex refused' }) };
  const res = await withCodexWriterStub(stub, () =>
    aw.applyCardToApp(makeCard(), APPS.CODEX, { mode: 'direct', key: 'sk' })
  );
  assert.equal(res.success, true, '真实失败被硬编码的 success:true 吞掉');
  assert.equal(res.error, 'codex refused');
  assert.deepEqual(res.detail, {
    success: true,
    error: 'codex refused',
    detail: { success: false, error: 'codex refused' },
  }, '外层 detail.success=true，内层 detail.detail.success=false：同一结果两种真相');

  // writer 抛错时才会真的报失败（try 包住 switch）。
  const boom = { setCodexUpstreamConfigOnly: () => { throw new Error('writer blew up'); } };
  const res2 = await withCodexWriterStub(boom, () =>
    aw.applyCardToApp(makeCard(), APPS.CODEX, { mode: 'direct', key: 'sk' })
  );
  assert.deepEqual(res2, { success: false, app: 'codex', mode: 'direct', error: 'writer blew up' });

  // 其他应用则尊重适配器返回值。
  addOutcomes['opencodeAdapter'] = () => ({ success: false, error: 'adapter refused' });
  const res3 = await aw.applyCardToApp(makeCard(), APPS.OPENCODE, { mode: 'direct', key: 'sk' });
  assert.equal(res3.success, false);
  assert.equal(res3.error, 'adapter refused');
  delete addOutcomes['opencodeAdapter'];
});

// ───────────────────────────── bookkeeping / guards ─────────────────────────

test('applyCardToApp：agentMode 只在成功 + proxy 时回写，且其抛错被吞掉不影响结果', async () => {
  useGateway({});
  const store = makeStore({ throwOnSetMode: true });
  const res = await aw.applyCardToApp(makeCard(), APPS.COZE, { store, proxyBaseUrl: 'http://e:1', proxyToken: 'tok' });
  assert.equal(res.success, true);
  assert.deepEqual(store.agentModes, [['coze', 'proxy', 'c1']]);

  // Failure → no write-back.
  addOutcomes['cozeAdapter'] = () => ({ success: false, error: 'nope' });
  const store2 = makeStore();
  const res2 = await aw.applyCardToApp(makeCard(), APPS.COZE, { store: store2, proxyBaseUrl: 'http://e:1', proxyToken: 'tok' });
  assert.equal(res2.success, false);
  assert.deepEqual(store2.agentModes, []);
  delete addOutcomes['cozeAdapter'];

  // No store at all → silent skip.
  const res3 = await aw.applyCardToApp(makeCard(), APPS.COZE, { proxyBaseUrl: 'http://e:1', proxyToken: 'tok' });
  assert.equal(res3.success, true);

  // Store without setAgentMode → typeof guard skips it.
  const res4 = await aw.applyCardToApp(makeCard(), APPS.COZE, {
    store: { getCardCredential: () => 'sk' },
    proxyBaseUrl: 'http://e:1',
    proxyToken: 'tok',
  });
  assert.equal(res4.success, true);
});

test('KNOWN-DEFECT applyCardToApp：store.getCardCredential 抛穿（try 只包住 switch），两种模式都读池', async () => {
  useGateway({});
  const store = makeStore({ throwOnCredential: true });
  const card = makeCard();
  // Proxy mode: the credential read is dead weight — the key is overwritten by
  // the gateway token a few lines later — yet it can still blow up the call.
  await assert.rejects(
    () => aw.applyCardToApp(card, APPS.CLAUDE_CODE, { store, proxyBaseUrl: 'http://e:1', proxyToken: 'tok' }),
    /pool read blew up/,
    '文档承诺 "never throws"，实测直接 reject'
  );
  await assert.rejects(
    () => aw.applyCardToApp(card, APPS.CLAUDE_CODE, { store, mode: 'direct' }),
    /pool read blew up/
  );
  assert.deepEqual(calls, [], '抛点在写盘之前');
  // opts.key 存在时短路，不再读池。
  const res = await aw.applyCardToApp(card, APPS.CLAUDE_CODE, { store, mode: 'direct', key: 'explicit' });
  assert.equal(res.success, true);
  assert.equal(store.seen.length, 2, '只有两次抛穿的读取');
});

test('applyCardToApp：未知应用在直连模式回报不支持，冻结卡片不被修改', async () => {
  useHomes();
  const card = Object.freeze(makeCard({ name: 'Frozen' }));
  const res = await aw.applyCardToApp(card, 'nope', { mode: 'direct', key: 'sk' });
  assert.deepEqual(res, { success: false, app: 'nope', mode: 'direct', error: '暂不支持把卡片写到应用: nope' });
  assert.deepEqual(calls, []);

  // 代理模式下未知应用先撞接入门（错误来源与 mode 相关）。
  useHomes();
  const res2 = await aw.applyCardToApp(card, 'nope', { key: 'sk' });
  assert.equal(res2.success, false);
  assert.match(res2.error, /^代理未运行/);

  // 冻结卡片走成功路径也不抛（buildProxyCard 只读入参）。
  useGateway({});
  const res3 = await aw.applyCardToApp(card, APPS.TRAE, { proxyBaseUrl: 'http://e:1', proxyToken: 'tok' });
  assert.equal(res3.success, true);
  assert.equal(card.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(calls[0].payload.provider, 'Frozen', 'trae 用原始卡片名');
  assert.equal(calls[0].payload.model, 'api:frozen:deepseek-chat');

  // 卡片无效时前置拒绝，mode 与 app 都在返回值里。
  const res4 = await aw.applyCardToApp(null, APPS.CODEX, { mode: 'direct' });
  assert.deepEqual(res4, { success: false, app: 'codex', mode: 'direct', error: '卡片无效（缺少名称）' });
});

// ────────────────────────────── detectCardInApp ─────────────────────────────

test('detectCardInApp：codex 走网关快照映射成单条 provider，其余应用原样透传 list()', () => {
  codexSnap = { provider: 'alpha', baseUrl: 'http://b', hasApiKey: true, model: 'gpt-5' };
  assert.deepEqual(aw.detectCardInApp(APPS.CODEX), {
    success: true,
    providers: [{ id: 'alpha', endpoint: 'http://b', hasKey: true, models: ['gpt-5'] }],
  });
  codexSnap = { provider: 'alpha' };
  assert.deepEqual(aw.detectCardInApp(APPS.CODEX), {
    success: true,
    providers: [{ id: 'alpha', endpoint: '', hasKey: undefined, models: [] }],
  }, '快照缺字段时 endpoint 兜空串，hasKey 原样 undefined');
  codexSnap = {};
  assert.deepEqual(aw.detectCardInApp(APPS.CODEX), { success: true, providers: [] });

  for (const name of ADAPTERS) {
    listOutcomes[name] = () => ({ success: true, providers: [{ id: `from-${name}` }] });
  }
  assert.deepEqual(aw.detectCardInApp(APPS.CLAUDE_CODE), { success: true, providers: [{ id: 'from-claudeCodeAdapter' }] });
  assert.deepEqual(aw.detectCardInApp(APPS.TRAE), { success: true, providers: [{ id: 'from-traeAppAdapter' }] });
  // 垃圾返回值不做任何归一（与 codex 分支的结构化映射相反）。
  listOutcomes['geminiCliAdapter'] = () => 'not-an-object';
  assert.equal(aw.detectCardInApp(APPS.GEMINI), 'not-an-object');
  listOutcomes['deepseekTuiAdapter'] = () => undefined;
  assert.equal(aw.detectCardInApp(APPS.DEEPSEEK), undefined);
});

test('KNOWN-DEFECT detectCardInApp(codex)：网关快照返回 null 时抛 TypeError 被兜住，而其他应用原样返回 null', () => {
  codexSnap = null;
  assert.deepEqual(aw.detectCardInApp(APPS.CODEX), {
    success: false,
    providers: [],
    error: "Cannot read properties of null (reading 'provider')",
  }, 'codex 分支直接 snap.provider（无 ?. 兜底）');
  listOutcomes['opencodeAdapter'] = () => null;
  assert.equal(aw.detectCardInApp(APPS.OPENCODE), null, '同一「无数据」语义在别的分支是 null 直通');
  delete listOutcomes['opencodeAdapter'];
  codexSnap = { provider: '' };
  assert.deepEqual(aw.detectCardInApp(APPS.CODEX), { success: true, providers: [] }, '空串 provider 才是真的空列表');
});

test('detectCardInApp：未知应用与适配器抛错都返回 {success:false, providers:[]}', () => {
  assert.deepEqual(aw.detectCardInApp('nope'), {
    success: false,
    providers: [],
    error: '不支持的应用: nope',
  });
  assert.deepEqual(aw.detectCardInApp(undefined), {
    success: false,
    providers: [],
    error: '不支持的应用: undefined',
  });
  listOutcomes['cozeAdapter'] = () => {
    throw new Error('list blew up');
  };
  assert.deepEqual(aw.detectCardInApp(APPS.COZE), {
    success: false,
    providers: [],
    error: 'list blew up',
  });
  delete listOutcomes['cozeAdapter'];
  assert.deepEqual(aw.detectCardInApp(APPS.COZE), { success: true, providers: [{ id: 'cozeAdapter-default' }] });
});

test('导出面：三个自有函数 + proxyAccess 的三个再导出，无多余键', () => {
  assert.deepEqual(Object.keys(aw).sort(), [
    'applyCardToApp',
    'buildProxyCard',
    'detectCardInApp',
    'preflightCardForApp',
    'resolvePoolKeyFromCard',
    'resolveProxyAccess',
  ]);
  assert.equal(aw.buildProxyCard, require('./proxyAccess').buildProxyCard);
  assert.equal(typeof aw.resolveProxyAccess, 'function');
});
