'use strict';

/**
 * 密钥池的两条不变量（GW-01 / GW-02）：
 *
 *   GW-01 并发槽泄漏：acquire 之后若走 continue / return 路径，releaseSlot()
 *         不会被调用 ⇒ 槽只增不减 ⇒ key 被永久判死（max=1 的适配器一次即死）。
 *   GW-02 fast-fail 自锁：池内第 0 次失败会同步写进冷却镜像，第 1 次尝试
 *         紧接着读到这条冷却 → virtualSkip → 「同池换 key 重试」退化成 1 次。
 *
 * concurrencySlots 与冷却镜像（_recordAdapterFailure / _getRecentFastFail）
 * 都用**真实实现**——正是它们的行为构成了这两个缺陷。
 */

jest.mock('../../src/services/diagnosticEvents', () => ({
  diagnostics: {
    emitModelRequest: jest.fn(),
    emitModelResponse: jest.fn(),
  },
  generateTraceId: () => 'trace-keypool',
}));

jest.mock('../../src/services/usageTracker', () => ({
  usageTracker: { record: jest.fn() },
}));

jest.mock('../../src/services/contextWindowGuard', () => ({
  evaluateGuard: jest.fn(() => ({ passed: true })),
  formatWarning: jest.fn(() => ''),
}));

jest.mock('../../src/services/aiMonitor', () => ({
  startTrace: jest.fn(() => 'trace-1'),
  endTrace: jest.fn(),
  addCascadeAttempt: jest.fn(),
}));

jest.mock('../../src/services/liveModelSwitch', () => ({
  getInstance: () => ({
    getActiveModel: () => null,
    generationStarted: jest.fn(),
    generationCompleted: jest.fn(),
  }),
}));

jest.mock('../../src/services/advancedDiagnostics', () => ({
  getInstance: () => ({
    recordLatency: jest.fn(),
    recordError: jest.fn(),
  }),
}));

jest.mock('../../src/services/usageHabitService', () => ({
  getPreferredModel: jest.fn(() => null),
  recordModelUsage: jest.fn(),
  recordInteraction: jest.fn(),
}));

jest.mock('../../src/services/gateway/pluginChain', () => ({
  executeBeforeRequest: jest.fn(async (ctx) => ctx),
  executeAfterResponse: jest.fn(async (ctx) => ctx),
}));

// 网关单例初始化时会去拉在线模型目录（会发网络请求，且在测试结束后才落地 →
// "import after teardown" 噪音）。这里只把目录列表打桩掉，其余导出保持真实。
jest.mock('../../src/services/dynamicFreeModelService', () => {
  const actual = jest.requireActual('../../src/services/dynamicFreeModelService');
  return { ...actual, listCatalogModels: jest.fn(async () => []) };
});

const KEYS = [
  { keyId: 'k1', key: 'sk-key-1', endpoint: 'https://pool-1.example/v1', label: 'k1' },
  { keyId: 'k2', key: 'sk-key-2', endpoint: 'https://pool-2.example/v1', label: 'k2' },
  { keyId: 'k3', key: 'sk-key-3', endpoint: 'https://pool-3.example/v1', label: 'k3' },
];

const mockPool = {
  init: jest.fn(),
  hasAvailableKeys: jest.fn(() => true),
  listAvailableKeys: jest.fn((provider) => {
    // 真实 apiKeyPool 在入池时会登记并发槽；这里照做，否则槽是「未注册=无限」
    const slots = require('../../src/services/concurrencySlots');
    for (const k of KEYS) {
      slots.register(k.keyId, provider);
    }
    return KEYS.map((k) => ({ ...k, status: 'active', backoffLevel: 0 }));
  }),
  pickById: jest.fn((provider, keyId) => KEYS.find((k) => k.keyId === keyId) || null),
  pick: jest.fn(() => KEYS[0]),
  markSuccess: jest.fn(),
  markFailure: jest.fn(),
};

jest.mock('../../src/services/apiKeyPool', () => mockPool);

jest.mock('../../src/services/gateway/keySelector', () => ({
  resolveStrategy: jest.fn(() => 'least-used'),
  selectCandidate: jest.fn((candidates) => (candidates && candidates[0]) || null),
}));

describe('密钥池：并发槽归还与 fast-fail 不自锁（GW-01 / GW-02）', () => {
  let gateway = null;

  beforeEach(() => {
    jest.resetModules();
    gateway = require('../../src/services/gateway/aiGateway');
    require('../../src/services/concurrencySlots').resetAll();
    process.env.GATEWAY_POOL_MAX_RETRIES = '3';
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.GATEWAY_POOL_MAX_RETRIES;
  });

  /** 搭一个走密钥池的网关：适配器每次都抛 429（触发换 key 重试）。 */
  function buildGateway(adapterGenerate) {
    const gw = Object.create(gateway);
    const mockAdapter = {
      detect: jest.fn(() => true),
      getStatus: jest.fn(() => ({ name: 'API 云端服务', type: 'api', available: true })),
      generate: jest.fn(adapterGenerate),
      listModels: jest.fn(async () => []),
      destroy: jest.fn(),
    };

    gw._initialized = true;
    gw._adapters = [
      { key: 'api', adapter: mockAdapter, priority: 0, enabled: true, available: true },
    ];
    gw._adapterFailures = {};
    gw._adapterLastError = {};
    gw._requestLog = {};
    gw._localAdapters = new Set();
    gw._serializedAdapterKeys = new Set();
    gw._adapterQueue = (key, fn) => fn();
    gw._keyedLimiter = { consume: () => ({ allowed: true }) };
    gw._lastRefreshTime = Date.now();

    gw._enforceRateLimit = async () => {};
    gw._generateWithAdapterIsolation = gateway._generateWithAdapterIsolation.bind(gw);
    gw._clearAdapterFailure = () => {};
    gw._shouldSerializeAdapter = () => false;
    gw._maybeBackgroundProbeToolCalling = () => {};
    gw.refreshAdapters = async () => {};
    // 注意：_recordAdapterFailure / _getRecentFastFail **不桩**——GW-02 的成因
    // 正是前者同步写冷却镜像、后者读到它。
    return { gw, mockAdapter };
  }

  test('429 后仍轮换到池内下一个 key（fast-fail 不得把同池重试锁死）', async () => {
    const { gw, mockAdapter } = buildGateway(async () => {
      const err = new Error('rate limited');
      err.status = 429;
      throw err;
    });

    const result = await gateway.generate.call(gw, 'hello', { model: 'openai:gpt-4o-mini' });

    // 三个 key 都试过（此前第一个失败后，其余两个被 fast-fail 跳过 → 只调 1 次）
    expect(mockAdapter.generate).toHaveBeenCalledTimes(3);
    const usedKeys = mockAdapter.generate.mock.calls.map(([, o]) => o.apiKey);
    expect(new Set(usedKeys).size).toBe(3);

    // 失败记录里不应出现 virtualSkip（virtualSkip 就是「被 fast-fail 跳过」的痕迹）
    const attempts = result.attempts || [];
    expect(attempts.filter((a) => a.virtualSkip).length).toBe(0);
  });

  test('任何跳出路径都要归还并发槽（槽只增不减会把 key 永久判死）', async () => {
    const { gw, mockAdapter } = buildGateway(async () => {
      const err = new Error('rate limited');
      err.status = 429;
      throw err;
    });

    await gateway.generate.call(gw, 'hello', { model: 'openai:gpt-4o-mini' });
    expect(mockAdapter.generate).toHaveBeenCalled();

    const slots = require('../../src/services/concurrencySlots');
    for (const k of KEYS) {
      const status = slots.getSlotStatus(k.keyId);
      expect(status).not.toBeNull();
      expect(status.current).toBe(0); // 泄漏过就会 > 0
    }
  });
});
