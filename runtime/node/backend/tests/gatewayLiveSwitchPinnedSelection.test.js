'use strict';
/**
 * Regression: the process-wide liveModelSwitch used to overwrite the model a
 * caller had just picked. Web/desktop send {preferredAdapter, preferredModel}
 * on every request; an auto-escalation or an earlier /model pick left a stale
 * override behind, generate() copied it into options.model before resolving
 * the pin, and the request went out with another channel's model id →
 * model_not_found ("选中的模型跳到另一个不可用模型").
 *
 * Root cause B lives in syncModelSwitch: switchModel(null) is a no-op, so
 * picking Auto / a channel-only entry kept the previous override in force.
 */

const mockLiveSwitch = {
  activeModel: null,
  started: 0,
  cleared: [],
};

jest.mock('../src/services/liveModelSwitch', () => {
  const instance = {
    getActiveModel: () => mockLiveSwitch.activeModel,
    generationStarted: () => { mockLiveSwitch.started += 1; },
    generationCompleted: () => {},
    switchModel: jest.fn(),
    clearOverride: jest.fn((reason) => {
      mockLiveSwitch.cleared.push(reason);
      mockLiveSwitch.activeModel = null;
    }),
  };
  mockLiveSwitch.instance = instance;
  return { getInstance: () => instance };
});

jest.mock('../src/services/diagnosticEvents', () => ({
  diagnostics: {
    emitModelRequest: jest.fn(),
    emitModelResponse: jest.fn(),
  },
  generateTraceId: () => 'test-trace-id',
}));

jest.mock('../src/services/usageTracker', () => ({
  usageTracker: { record: jest.fn() },
}));

jest.mock('../src/services/contextWindowGuard', () => ({
  evaluateGuard: jest.fn(() => ({ passed: true })),
  formatWarning: jest.fn(() => ''),
}));

jest.mock('../src/services/aiMonitor', () => ({
  startTrace: jest.fn(() => 'trace-1'),
  endTrace: jest.fn(),
  addCascadeAttempt: jest.fn(),
}));

jest.mock('../src/services/advancedDiagnostics', () => ({
  getInstance: () => ({
    recordLatency: jest.fn(),
    recordError: jest.fn(),
  }),
}));

jest.mock('../src/services/usageHabitService', () => ({
  getPreferredModel: jest.fn(() => null),
  recordModelUsage: jest.fn(),
  recordInteraction: jest.fn(),
}));

jest.mock('../src/services/apiKeyPool', () => ({
  init: jest.fn(),
  hasAvailableKeys: jest.fn(() => false),
}));

jest.mock('../src/services/concurrencySlots', () => ({
  acquire: jest.fn(() => jest.fn()),
}));

jest.mock('../src/services/modelTrainingService', () => ({
  recordConversation: jest.fn(() => ({ accepted: true })),
}));

const AI_GATEWAY_MODULE_PATH = require.resolve('../src/services/gateway/aiGateway');

function createMockAdapter(name, generateFn) {
  return {
    detect: () => true,
    generate: jest.fn(generateFn || (async () => ({
      success: true,
      content: `response from ${name}`,
      provider: name,
      adapter: name,
    }))),
    getStatus: () => ({
      name,
      type: 'test',
      available: true,
      activeModel: null,
    }),
    listModels: async () => [],
    destroy: jest.fn(),
  };
}

function configureGateway(gw, adapters) {
  gw._adapters = adapters;
  gw._initialized = true;
  gw._adapterFailures = {};
  gw._adapterLastError = {};
  gw._requestLog = {};
  gw._localAdapters = new Set();
  gw._serializedAdapterKeys = new Set();
  gw._adapterQueue = (key, fn) => fn();
  gw._keyedLimiter = { consume: () => ({ allowed: true }) };
  gw._lastRefreshTime = Date.now();
  gw._enforceRateLimit = async () => {};
  gw._generateWithAdapterIsolation = async (entry, prompt, opts) => entry.adapter.generate(prompt, opts);
  gw._getRecentFastFail = () => null;
  gw._clearAdapterFailure = (k) => { delete gw._adapterLastError[k]; };
  gw._recordAdapterFailure = () => {};
  gw._shouldSerializeAdapter = () => false;
  gw.refreshAdapters = async () => {};
}

afterEach(() => {
  const cached = require.cache[AI_GATEWAY_MODULE_PATH];
  if (cached && cached.exports && typeof cached.exports.destroy === 'function') {
    try {
      cached.exports.destroy();
    } catch {
      /* best effort */
    }
  }
  delete require.cache[AI_GATEWAY_MODULE_PATH];
  mockLiveSwitch.activeModel = null;
  mockLiveSwitch.started = 0;
  mockLiveSwitch.cleared = [];
  if (mockLiveSwitch.instance) {
    mockLiveSwitch.instance.switchModel.mockClear();
    mockLiveSwitch.instance.clearOverride.mockClear();
  }
  jest.restoreAllMocks();
});

describe('pinned model selection vs process-wide live switch', () => {
  test('generate() sends the pinned model, not the stale live override', async () => {
    mockLiveSwitch.activeModel = 'claude-opus-5::auto';
    const gateway = require('../src/services/gateway/aiGateway');
    const gw = Object.create(gateway);
    const apiAdapter = createMockAdapter('api');
    configureGateway(gw, [
      { key: 'test', adapter: apiAdapter, priority: 0, enabled: true, available: true },
    ]);

    const result = await gateway.generate.call(gw, 'ping', {
      preferredAdapter: 'test',
      preferredModel: 'opencode-zen:mimo-v2.6-flash-free',
    });

    expect(result.success).toBe(true);
    expect(apiAdapter.generate).toHaveBeenCalledWith(
      'ping',
      expect.objectContaining({ model: 'opencode-zen:mimo-v2.6-flash-free' })
    );
    // The override must not be applied at all — not even as a fallback.
    expect(mockLiveSwitch.activeModel).toBe('claude-opus-5::auto');
  });

  test('generate() still honours the live override when nothing is pinned', async () => {
    mockLiveSwitch.activeModel = 'claude-opus-5::auto';
    const gateway = require('../src/services/gateway/aiGateway');
    const gw = Object.create(gateway);
    const claudeAdapter = createMockAdapter('claude');
    configureGateway(gw, [
      { key: 'test', adapter: claudeAdapter, priority: 0, enabled: true, available: true },
    ]);

    const result = await gateway.generate.call(gw, 'ping', {});

    expect(result.success).toBe(true);
    expect(claudeAdapter.generate).toHaveBeenCalledWith(
      'ping',
      expect.objectContaining({ model: 'claude-opus-5::auto' })
    );
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['auto', 'auto'],
  ])('syncModelSwitch(%s) clears the stale override instead of leaving it', (label, value) => {
    const gateway = require('../src/services/gateway/aiGateway');
    gateway.syncModelSwitch(value);
    expect(mockLiveSwitch.cleared).toContain('gateway_preference_cleared');
  });

  test('syncModelSwitch(concrete model) still switches to it', () => {
    const gateway = require('../src/services/gateway/aiGateway');
    gateway.syncModelSwitch('glm-4.7');
    const switcher = require('../src/services/liveModelSwitch').getInstance();
    expect(switcher.clearOverride).not.toHaveBeenCalled();
    expect(switcher.switchModel).toHaveBeenCalledWith(
      'glm-4.7',
      expect.objectContaining({ reason: 'gateway_preference', persist: false, force: true })
    );
  });
});
