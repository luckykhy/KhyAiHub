'use strict';

/**
 * proxyServer.ccSwitchCardRoute.test.js — 「卡片接进网关路由」+「合法池名」+「非流式
 * tool_use stop_reason」三个缺口的集成锁定。驱动**真实的 proxyServer**（真 HTTP 端口、
 * 真鉴权、真协议转换），只把 aiGateway 换成可观测的假网关。
 *
 * 缺口①（卡对象没接进网关路由）：domain/config/ccSwitch/routeResolver.js 的
 *   resolveCardRoute（active card → adapterKey='api' + apiPoolProvider）全仓无调用方，
 *   桌面端激活的卡片对网关完全不可见。本文件断言 handleMultiProtocol 真的调它、
 *   真的把 apiPoolProvider 透传给出线选项，且 Anthropic 入站的「放宽进级联」分支
 *   不会把卡片路由的 preferredAdapter 清掉。
 *
 * 缺口②（自带 key 的卡生成的模型名网关解不出）：历史池名 `cc-switch:<cardId>` 含冒号，
 *   而三段式 `api:<pool>:<model>` 的池段正则只认 [a-z0-9_-]
 *   （apiAdapter.parseProviderModel / aiGateway._resolveApiPoolProviderForRequest）
 *   → 池名被截成 'cc-switch'、apiKeyPool.pick 精确匹配不到 key/endpoint、模型 id 被
 *   污染成 '<cardId>:<model>'。本文件钉死现行池名形态 + 旧名的只读别名兼容。
 *
 * 缺口⑥（非流式 tool_use 响应 stop_reason 错报 end_turn）：proxyServer 写
 *   canonical.stopReason='tool_use'，而 shared protocolConverter/anthropic.js 的
 *   mapStopReason 没有 'tool_use' 键 → 回落 'end_turn'（Claude Code 因此不执行工具）。
 *   node_modules 禁改，故修在 proxyServer 侧：改写 'tool_calls'。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const { getDataHome } = require('../../src/utils/dataHome');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function postJson({ port, token, pathname, body }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 10_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += String(c);
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            /* keep null */
          }
          resolve({ statusCode: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.write(payload);
    req.end();
  });
}

// cc_switch.json 的最小卡片（自带 key：store.addCard 会把它登记进 apiKeyPool）。
function makeCard(id, overrides = {}) {
  return {
    id,
    name: 'My OpenAI Card',
    baseUrl: 'https://api.openai.com/v1',
    keyId: 'pool-key-id-1',
    protocol: 'openai',
    wireApi: 'chat',
    models: ['gpt-4o-mini'],
    defaultModel: 'gpt-4o-mini',
    apps: ['claude-code'],
    enabled: true,
    requiresOpenaiAuth: false,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

/** 写 cc_switch.json 到（jest 已钉住的）数据家。 */
function writeStore(doc) {
  fs.writeFileSync(path.join(getDataHome(), 'cc_switch.json'), JSON.stringify(doc, null, 2), 'utf8');
}

/** 写 api_keys.json：把卡片的 key 登记在给定命名空间下（可模拟历史非法名）。 */
function writePool(provider, key, cardKeyId) {
  const file = path.join(getDataHome(), 'api_keys.json');
  const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  doc[provider] = [{ key, endpoint: 'https://api.openai.com/v1', priority: 0, label: 'cc-switch' }];
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  void cardKeyId;
}

// md5(`${provider}:${key}`) 前 12 位 —— 与 apiKeyPool._registerKey / proxyAccess._keyIdFor 同式。
function keyIdFor(provider, key) {
  return crypto.createHash('md5').update(`${provider}:${key}`).digest('hex').slice(0, 12);
}

const ANTHROPIC_BODY = (model) => ({
  model,
  max_tokens: 16,
  messages: [{ role: 'user', content: 'ping' }],
});

describe('proxyServer ← ccSwitch 活跃卡片路由 / 合法池名 / 非流式 stop_reason', () => {
  // 每个用例都要真起一次 proxyServer（模块图 + 端口 + 鉴权），本机实测 0.1–19s/例，
  // 默认 5s 会把冷启动误判成挂死。
  jest.setTimeout(180_000);

  const originalEnv = { ...process.env };
  let gatewayMock = null;

  beforeEach(() => {
    jest.resetModules();
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proxy-card-'));
    process.env.PROXY_AUTH_TOKEN = 'khy-test-token';
    delete process.env.GATEWAY_MODEL_ROUTE_MAP;
    delete process.env.GATEWAY_API_POOL_PROVIDER;

    gatewayMock = {
      _initialized: true,
      isInitialized() {
        return this._initialized;
      },
      getAdapters() {
        return this._adapters || [];
      },
      init: jest.fn(async () => {}),
      generate: jest.fn(async (prompt, options) => ({
        success: true,
        content: 'ok',
        provider: options.preferredAdapter || 'mock',
        adapter: options.preferredAdapter || 'mock',
        model: options.model || null,
      })),
      listModels: jest.fn(async () => []),
    };

    jest.doMock('../../src/services/gateway/aiGateway', () => gatewayMock);
    jest.doMock('../../src/services/modelTrainingService', () => ({
      recordConversation: jest.fn(() => ({ accepted: true })),
    }));
    jest.doMock('../../src/services/usageHabitService', () => ({
      recordModelUsage: jest.fn(),
      recordInteraction: jest.fn(),
    }));
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      process.env[k] = v;
    }
  });

  /** 起代理并 POST /v1/messages，返回 { http, options }。 */
  async function postAnthropic(body) {
    const proxy = require('../../src/services/gateway/proxyServer');
    const port = await getFreePort();
    const started = await proxy.start({ host: '127.0.0.1', port });
    const http0 = await postJson({ port, token: started.authToken, pathname: '/v1/messages', body });
    await proxy.stop();
    return http0;
  }

  test('活跃卡片 → 路由改写为 api 适配器 + 合法 apiPoolProvider，且不被 Anthropic 放宽分支清掉', async () => {
    const cardId = 'c_card0001';
    writeStore({
      schemaVersion: 1,
      cards: [makeCard(cardId)],
      active: { 'claude-code': cardId },
      apps: {},
      agentMode: {},
    });

    const resp = await postAnthropic(ANTHROPIC_BODY('gpt-4o-mini'));
    expect(resp.statusCode).toBe(200);
    expect(gatewayMock.generate).toHaveBeenCalledTimes(1);

    const [, options] = gatewayMock.generate.mock.calls[0];
    expect(options.preferredAdapter).toBe('api');
    expect(options.apiPoolProvider).toBe(`cc_switch_${cardId}`);
    // 放宽分支不许清掉 preferredAdapter（卡片是首次尝试的通道）。
    // strictPreferred 仍为 false 是**有意的**：routeResolver 的口径是「卡片只是默认，
    // 不是枷锁」——首次尝试走卡片池，失败后允许级联到其它通道。

    // 模型名：裸 gpt-4o-mini 会先被 modelRouter 的 builtin-family 规则改写成
    // `openai:gpt-4o-mini`（pool 段来自家族推断，与卡片无关），apiAdapter 再把它
    // 解析回裸 id + provider。真正决定「用哪把 key」的是 apiPoolProvider 提示，
    // 而它在 resolveProviderScope 里压过模型自带的 provider 段 —— 这条链必须闭合。
    const { parseProviderModel } = require('../../src/services/gateway/adapters/apiAdapter');
    const parsed = parseProviderModel(options.model);
    expect(parsed.model).toBe('gpt-4o-mini');
    // resolveProviderScope 未导出，这里用它的同源判据复算：池提示优先于模型段。
    const poolFromModel = parsed.poolProvider || parsed.provider || null;
    expect(options.apiPoolProvider).toBe(`cc_switch_${cardId}`);
    expect(options.apiPoolProvider).not.toBe(poolFromModel);
  });

  test('apiPoolProvider 必匹配三段式池名正则 [a-z0-9_-]+（历史含冒号名的修复点）', async () => {
    const cardId = 'c_card0002';
    writeStore({
      schemaVersion: 1,
      cards: [makeCard(cardId)],
      active: { 'claude-code': cardId },
      apps: {},
      agentMode: {},
    });

    await postAnthropic(ANTHROPIC_BODY('gpt-4o-mini'));
    const [, options] = gatewayMock.generate.mock.calls[0];
    expect(options.apiPoolProvider).toMatch(/^[a-z0-9_-]+$/);

    // 反证（旧名的真实病症，比「正则不匹配」更精确）：`api:cc-switch:<id>:<model>`
    // **能**过 apiAdapter 的三段式正则，但捕获出来是错的 ——
    //   池段 = 'cc-switch'（apiKeyPool.pick 精确匹配不到任何 key/endpoint）
    //   模型  = '<cardId>:<model>'（id 被污染）
    // 这正是「卡片自带 key 却解不出」的根因，故断言捕获值而非仅断言匹配与否。
    const POOL_RE = /^api[:/]([a-z0-9_-]+)[:/](.+)$/;
    const legacy = `api:cc-switch:${cardId}:gpt-4o-mini`.match(POOL_RE);
    expect(legacy).not.toBeNull();
    expect(legacy[1]).toBe('cc-switch');
    expect(legacy[2]).toBe(`${cardId}:gpt-4o-mini`);

    const fixed = `api:${options.apiPoolProvider}:gpt-4o-mini`.match(POOL_RE);
    expect(fixed[1]).toBe(options.apiPoolProvider);
    expect(fixed[2]).toBe('gpt-4o-mini');
  });

  test('显式适配器前缀压过活跃卡片（卡片只是默认，不是枷锁）', async () => {
    const cardId = 'c_card0003';
    writeStore({
      schemaVersion: 1,
      cards: [makeCard(cardId)],
      active: { 'claude-code': cardId },
      apps: {},
      agentMode: {},
    });

    const resp = await postAnthropic(ANTHROPIC_BODY('kiro/claude-sonnet-4'));
    expect(resp.statusCode).toBe(200);
    const [, options] = gatewayMock.generate.mock.calls[0];
    expect(options.preferredAdapter).toBe('kiro');
    expect(options.apiPoolProvider).toBeUndefined();
    expect(options.strictPreferred).toBe(true);
  });

  test('无活跃卡片 → 不透传 apiPoolProvider，Anthropic 放宽分支照旧生效', async () => {
    writeStore({ schemaVersion: 1, cards: [makeCard('c_card0004')], active: {}, apps: {}, agentMode: {} });

    const resp = await postAnthropic(ANTHROPIC_BODY('gpt-4o-mini'));
    expect(resp.statusCode).toBe(200);
    const [, options] = gatewayMock.generate.mock.calls[0];
    expect(options.apiPoolProvider).toBeUndefined();
    // 非 explicit/route-map/卡片路由 → 清空 preferredAdapter 进级联（今日行为不变）
    expect(options.preferredAdapter).toBeUndefined();
    expect(options.strictPreferred).toBe(false);
  });

  test('活跃卡片被禁用 → 不接路由（级联照旧）', async () => {
    const cardId = 'c_card0005';
    writeStore({
      schemaVersion: 1,
      cards: [makeCard(cardId, { enabled: false })],
      active: { 'claude-code': cardId },
      apps: {},
      agentMode: {},
    });

    const resp = await postAnthropic(ANTHROPIC_BODY('gpt-4o-mini'));
    expect(resp.statusCode).toBe(200);
    const [, options] = gatewayMock.generate.mock.calls[0];
    expect(options.apiPoolProvider).toBeUndefined();
  });

  test('claude-code 没有活跃卡片（活跃的是别的 app）→ 不接路由', async () => {
    const cardId = 'c_card0006';
    writeStore({
      schemaVersion: 1,
      cards: [makeCard(cardId)],
      active: { codex: cardId },
      apps: {},
      agentMode: {},
    });

    const resp = await postAnthropic(ANTHROPIC_BODY('gpt-4o-mini'));
    expect(resp.statusCode).toBe(200);
    const [, options] = gatewayMock.generate.mock.calls[0];
    expect(options.apiPoolProvider).toBeUndefined();
    expect(options.preferredAdapter).toBeUndefined();
  });

  test('非流式响应带 tool_use 时 stop_reason 是 tool_use（不再是 end_turn）', async () => {
    gatewayMock.generate = jest.fn(async () => ({
      success: true,
      content: '',
      provider: 'api',
      adapter: 'api',
      model: 'gpt-4o-mini',
      toolUseBlocks: [{ id: 'toolu_01', name: 'Read', input: { file_path: 'README.md' } }],
    }));

    const resp = await postAnthropic(ANTHROPIC_BODY('gpt-4o-mini'));
    expect(resp.statusCode).toBe(200);
    // Anthropic 线：stop_reason 必须让 Claude Code 去执行工具
    expect(resp.body.stop_reason).toBe('tool_use');
    expect(resp.body.content.some((b) => b.type === 'tool_use')).toBe(true);
    // 反证 shared 转换器的口径：'tool_use' 这个 canonical 拼写它不认
    const { convertResponse } = require('../../src/services/gateway/protocolConverter');
    expect(convertResponse({ stopReason: 'tool_use', content: '' }, 'anthropic').stop_reason).toBe('end_turn');
    expect(convertResponse({ stopReason: 'tool_calls', content: '' }, 'anthropic').stop_reason).toBe('tool_use');
  });

  test('claude-* 模型名 + 活跃卡片 → 卡片压过「claude-* 走 claude 适配器」的启发式', async () => {
    const cardId = 'c_card0008';
    writeStore({
      schemaVersion: 1,
      cards: [makeCard(cardId, { protocol: 'anthropic', defaultModel: 'claude-sonnet-4-5', models: ['claude-sonnet-4-5'] })],
      active: { 'claude-code': cardId },
      apps: {},
      agentMode: {},
    });
    // 假网关上挂一个「可用」的 claude 适配器：没有卡片路由守卫时，这条启发式会把
    // 请求钉到它上面、绕过用户激活的卡片。
    gatewayMock.getAdapters = () => [
      { key: 'claude', adapter: { isAvailable: () => true, getStatus: () => ({ name: 'Claude' }) } },
    ];

    const resp = await postAnthropic(ANTHROPIC_BODY('claude-sonnet-4-5'));
    expect(resp.statusCode).toBe(200);
    const [, options] = gatewayMock.generate.mock.calls[0];
    expect(options.preferredAdapter).toBe('api');
    expect(options.apiPoolProvider).toBe(`cc_switch_${cardId}`);
  });

  test('claude-* 模型名 + 无活跃卡片 → 启发式照旧（无回归）', async () => {
    writeStore({ schemaVersion: 1, cards: [], active: {}, apps: {}, agentMode: {} });
    gatewayMock.getAdapters = () => [
      { key: 'claude', adapter: { isAvailable: () => true, getStatus: () => ({ name: 'Claude' }) } },
    ];

    const resp = await postAnthropic(ANTHROPIC_BODY('claude-sonnet-4-5'));
    expect(resp.statusCode).toBe(200);
    const [, options] = gatewayMock.generate.mock.calls[0];
    expect(options.preferredAdapter).toBe('claude');
    expect(options.apiPoolProvider).toBeUndefined();
  });

  test('非流式无工具时 stop_reason 仍是 end_turn（无回归）', async () => {
    const resp = await postAnthropic(ANTHROPIC_BODY('gpt-4o-mini'));
    expect(resp.statusCode).toBe(200);
    expect(resp.body.stop_reason).toBe('end_turn');
  });

  test('非流式思考内容透到 Anthropic thinking block（过去被硬编码 null 丢掉）', async () => {
    gatewayMock.generate = jest.fn(async () => ({
      success: true,
      content: '',
      thinking: '先想一下再答',
      provider: 'api',
      adapter: 'api',
      model: 'gpt-4o-mini',
    }));

    const resp = await postAnthropic(ANTHROPIC_BODY('gpt-4o-mini'));
    expect(resp.statusCode).toBe(200);
    const thinkingBlocks = (resp.body.content || []).filter((b) => b.type === 'thinking');
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0].thinking).toBe('先想一下再答');
  });

  test('OpenAI 线入站（/v1/chat/completions）不因新增卡片路由而回归', async () => {
    // handleChatCompletions 有自己的路由语义，本次接线**不**覆盖它（方案范围）。
    // 这里只锁「没有因为新增卡片路由而崩」——老路径必须逐字节可走。
    const cardId = 'c_card0007';
    writeStore({
      schemaVersion: 1,
      cards: [makeCard(cardId)],
      active: { 'claude-code': cardId },
      apps: {},
      agentMode: {},
    });

    const proxy = require('../../src/services/gateway/proxyServer');
    const port = await getFreePort();
    const started = await proxy.start({ host: '127.0.0.1', port });
    const resp = await postJson({
      port,
      token: started.authToken,
      pathname: '/v1/chat/completions',
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }] },
    });
    await proxy.stop();

    expect(resp.statusCode).toBe(200);
    const [, options] = gatewayMock.generate.mock.calls[0];
    // 老路径不透传卡片池（那是 handleMultiProtocol 的职责）
    expect(options.apiPoolProvider).toBeUndefined();
    void cardId;
  });
});

describe('apiKeyPool 池名别名（旧 cc-switch:<id> 命名空间的只读兼容）', () => {
  test('新名 ↔ 旧名互为别名；其它 provider 只有原样一个', () => {
    const pool = require('../../src/services/apiKeyPool');
    const aliases = pool._poolProviderAliases('cc_switch_c_ab12');
    expect(aliases).toEqual(['cc_switch_c_ab12', 'cc-switch:c_ab12']);
    expect(pool._poolProviderAliases('cc-switch:c_ab12')).toEqual(['cc-switch:c_ab12', 'cc_switch_c_ab12']);
    expect(pool._poolProviderAliases('openai')).toEqual(['openai']);
    expect(pool._poolProviderAliases('')).toEqual([]);
  });

  test('用新名查得到旧命名空间落盘的 key（零迁移）', () => {
    jest.resetModules();
    const pool = require('../../src/services/apiKeyPool');
    const legacy = 'cc-switch:c_legacy01';
    const key = 'sk-legacy-abcdefghijklmnop';
    pool.addKey(legacy, { key, endpoint: 'https://legacy.example/v1', label: 'cc-switch' });

    const legal = 'cc_switch_c_legacy01';
    expect(pool.hasAvailableKeys(legal)).toBe(true);
    const picked = pool.pick(legal);
    expect(picked).not.toBeNull();
    expect(picked.key).toBe(key);
    expect(picked.endpoint).toBe('https://legacy.example/v1');
    expect(pool.listAvailableKeys(legal).map((e) => e.key)).toContain(key);
    // 旧名自己也照旧可用（双向）
    expect(pool.pickById(legal, keyIdFor(legacy, key))).not.toBeNull();
  });

  test('新命名空间写入的 key 用旧名也读得到（反向兼容）', () => {
    jest.resetModules();
    const pool = require('../../src/services/apiKeyPool');
    const legal = 'cc_switch_c_new01';
    const key = 'sk-new-abcdefghijklmnop';
    pool.addKey(legal, { key, endpoint: 'https://new.example/v1' });
    expect(pool.hasAvailableKeys('cc-switch:c_new01')).toBe(true);
    expect(pool.pick('cc-switch:c_new01').key).toBe(key);
  });
});

describe('proxyAccess 池名归一（卡片 key 扫到的历史名 → 合法三名）', () => {
  test('resolvePoolKeyFromCard 扫到 cc-switch:<id> 时输出 cc_switch_<id>', () => {
    const cardId = 'c_pool0001';
    const provider = `cc-switch:${cardId}`;
    const key = 'sk-pool-abcdefghijklmnop';
    writePool(provider, key, keyIdFor(provider, key));

    const store = {
      getCard: () => null,
      getActiveCardId: () => null,
    };
    void store;
    const proxyAccess = require('../../src/services/domain/config/ccSwitch/proxyAccess');
    const card = { id: cardId, name: 'Pool Card', keyId: keyIdFor(provider, key) };
    const poolKey = proxyAccess.resolvePoolKeyFromCard(card, { raw: true });

    expect(poolKey.poolKey).toBe(`cc_switch_${cardId}`);
    expect(poolKey.poolKey).toMatch(/^[a-z0-9_-]+$/);
    // 拼出来的三名必须过网关正则
    const three = proxyAccess.__test__._routableModelName(poolKey.poolKey, 'gpt-4o-mini');
    expect(three).toBe(`api:cc_switch_${cardId}:gpt-4o-mini`);
    expect(/^api[:/]([a-z0-9_-]+)[:/].+$/.test(three)).toBe(true);
  });

  test('已是合法名的 provider 原样透传（不误伤 openai/deepseek 等）', () => {
    const provider = 'openai';
    const key = 'sk-openai-abcdefghijklmnop';
    writePool(provider, key, keyIdFor(provider, key));
    const proxyAccess = require('../../src/services/domain/config/ccSwitch/proxyAccess');
    const card = { id: 'c_pool0002', name: 'OpenAI Card', keyId: keyIdFor(provider, key) };
    expect(proxyAccess.resolvePoolKeyFromCard(card)).toBe('openai');
  });

  test('池里扫不到 → 回退卡片名 slug（仍合法）', () => {
    const proxyAccess = require('../../src/services/domain/config/ccSwitch/proxyAccess');
    const card = { id: 'c_pool0003', name: 'My DeepSeek Card', keyId: 'no-such-key' };
    const poolKey = proxyAccess.resolvePoolKeyFromCard(card);
    expect(poolKey).toBe('my_deepseek_card');
    expect(poolKey).toMatch(/^[a-z0-9_]+$/);
  });

  test('旧命名空间必须逐字映射成现行名（通用字符折叠会对不上别名表）', () => {
    const proxyAccess = require('../../src/services/domain/config/ccSwitch/proxyAccess');
    const canon = proxyAccess.__test__._canonicalPoolProviderName;

    // 逐字映射 → 与 apiKeyPool 别名表的键一致
    expect(canon('cc-switch:c_ab12')).toBe('cc_switch_c_ab12');
    // 反证：若走通用折叠（[^a-z0-9_-]+→_），`-` 会被保留成 'cc-switch_c_ab12'，
    // 那个名字在别名表里没有对应项 → 卡片 key 依旧 pick 不到。钉死别退化成折叠。
    expect(canon('cc-switch:c_ab12')).not.toBe('cc-switch_c_ab12');

    // 已合法名原样透传（连字符也不许被折叠掉）
    expect(canon('openai')).toBe('openai');
    expect(canon('my-provider')).toBe('my-provider');
    expect(canon('')).toBe('');
  });

  test('现行命名空间自洽：store 注册名 === proxyAccess 扫出的名 === 网关三名池段', () => {
    jest.resetModules();
    const { cardPoolProvider } = require('../../src/services/domain/config/ccSwitch/constants');
    const proxyAccess = require('../../src/services/domain/config/ccSwitch/proxyAccess');
    const pool = require('../../src/services/apiKeyPool');

    const cardId = 'c_selftest';
    const provider = cardPoolProvider(cardId); // store.addCard 现在用的命名空间
    const key = 'sk-self-abcdefghijklmnop';
    pool.addKey(provider, { key, endpoint: 'https://api.openai.com/v1', label: 'cc-switch' });

    const scanned = proxyAccess.resolvePoolKeyFromCard({
      id: cardId,
      name: 'Self',
      keyId: keyIdFor(provider, key),
    });
    expect(scanned).toBe(provider);
    expect(pool.hasAvailableKeys(scanned)).toBe(true);
    expect(pool.pick(scanned).key).toBe(key);
  });
});
