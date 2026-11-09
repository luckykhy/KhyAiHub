'use strict';

/**
 * apiAdapter.listModels 的 id 两套形态收口。
 *
 * 同一条路由会在列表里出现两次：
 *   - MultiFreeService 内置 provider → `opencode-zen:mimo-v2.6-flash-free`
 *   - apiKeyPool / customProviderRegistry → `api:opencode-zen:mimo-v2.6-flash-free`
 * parseProviderModel 两者都认，所以都能打通，但选择器里就是两条一样的模型。
 * 本测试钉住：三条腿合并后每个 (provider, model) 只留三段式那一行，
 * 且只在单腿出现的模型一个都不能少。
 */

const mockServiceProviders = [];
const mockCustomProviders = [];
const mockPool = {
  providers: [],
  init() {},
  getProviders() {
    return this.providers;
  },
  hasAvailableKeys(key) {
    return this.providers.includes(key);
  },
  pick() {
    // 无 endpoint → 跳过远端探测，直接用 customProviderRegistry 的静态模型表。
    return { keyId: 'test-key' };
  },
  markSuccess() {},
};

jest.mock('../../src/services/multiFreeService', () =>
  jest.fn().mockImplementation(() => ({
    getAvailableProviders: () => mockServiceProviders,
    getStatus: () => ({ available: true, provider: 'test' }),
  }))
);

jest.mock('../../src/services/apiKeyPool', () => mockPool);

jest.mock('../../src/services/customProviderRegistry', () => ({
  listProviders: () => mockCustomProviders,
}));

jest.mock('../../src/services/zenGatekeeper', () => ({
  filterFreeZenModels: (models) => models,
}));

jest.mock('../../src/services/zenModelStability', () => ({
  classify: () => null,
}));

function resetFixtures() {
  mockServiceProviders.length = 0;
  mockCustomProviders.length = 0;
  mockPool.providers = [];
}

async function loadAdapter() {
  jest.resetModules();
  return require('../../src/services/gateway/adapters/apiAdapter');
}

describe('apiAdapter.listModels — 两段/三段 id 去重', () => {
  beforeEach(resetFixtures);

  test('同 provider 同模型的两种 id 只保留三段式一行', async () => {
    mockServiceProviders.push({
      key: 'opencode-zen',
      name: 'OpenCode Zen',
      model: 'mimo-v2.6-flash-free',
      availableModels: [{ id: 'mimo-v2.6-flash-free' }],
    });
    mockPool.providers = ['opencode-zen'];
    mockCustomProviders.push({
      poolKey: 'opencode-zen',
      name: 'OpenCode Zen',
      models: ['mimo-v2.6-flash-free'],
      defaults: { contextWindow: 128000 },
      defaultModel: 'mimo-v2.6-flash-free',
    });

    const apiAdapter = await loadAdapter();
    const rows = await apiAdapter.listModels();
    const ids = rows.map((r) => r.id);

    expect(ids).toContain('api:opencode-zen:mimo-v2.6-flash-free');
    expect(ids).not.toContain('opencode-zen:mimo-v2.6-flash-free');
    expect(ids.filter((id) => id.endsWith('mimo-v2.6-flash-free'))).toHaveLength(1);
    // 保留的是带上下文窗口/输出上限的那一行。
    expect(rows.find((r) => r.id === 'api:opencode-zen:mimo-v2.6-flash-free')).toMatchObject({
      contextWindow: 128000,
    });
  });

  test('只在内置 provider 腿出现的模型不会被误删', async () => {
    mockServiceProviders.push({
      key: 'opencode-zen',
      name: 'OpenCode Zen',
      model: 'mimo-v2.6-flash-free',
      availableModels: [{ id: 'mimo-v2.6-flash-free' }],
    });
    mockPool.providers = ['opencode-zen'];
    mockCustomProviders.push({
      poolKey: 'opencode-zen',
      name: 'OpenCode Zen',
      models: ['other-model'],
    });

    const apiAdapter = await loadAdapter();
    const ids = (await apiAdapter.listModels()).map((r) => r.id);

    expect(ids).toContain('api:opencode-zen:other-model');
    expect(ids).toContain('opencode-zen:mimo-v2.6-flash-free');
  });

  test('不同 provider 下同名模型各自保留', async () => {
    mockServiceProviders.push(
      { key: 'openai', name: 'OpenAI', model: 'gpt-4o', availableModels: [{ id: 'gpt-4o' }] },
      { key: 'opencode-zen', name: 'OpenCode Zen', model: 'gpt-4o', availableModels: [{ id: 'gpt-4o' }] }
    );
    mockPool.providers = ['opencode-zen'];
    mockCustomProviders.push({
      poolKey: 'opencode-zen',
      name: 'OpenCode Zen',
      models: ['gpt-4o'],
    });

    const apiAdapter = await loadAdapter();
    const ids = (await apiAdapter.listModels()).map((r) => r.id);

    expect(ids).toContain('openai:gpt-4o');
    expect(ids).toContain('api:opencode-zen:gpt-4o');
    expect(ids).not.toContain('opencode-zen:gpt-4o');
  });
});
