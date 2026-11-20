'use strict';

// fs is mocked so the usage ledger never touches ~/.khyquant during tests.
// statSync + promises are required by the mtime reload and async flush paths.
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(() => '{}'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  renameSync: jest.fn(),
  statSync: jest.fn(() => ({ mtimeMs: 1 })),
  promises: {
    writeFile: jest.fn(async () => {}),
    rename: jest.fn(async () => {}),
  },
}));

jest.mock('../../src/services/subscriptionService', () => ({
  getCurrentTier: () => 'free',
  TIERS: { free: { limits: { cloud_ai_tokens: 100000 } } },
}), { virtual: true });

process.env.NO_COLOR = '1';
process.env.FORCE_COLOR = '0';

const transparency = require('../../src/services/transparencyService');
const tokenUsage = require('../../src/services/tokenUsageService');

const baseTurn = {
  inputTokens: 20000,
  outputTokens: 2000,
  model: 'claude-opus-4-7',
  adapter: 'anthropic',
  durationMs: 1200,
};

beforeEach(() => {
  tokenUsage.resetUsage();
});

describe('formatTurnCost price provenance', () => {
  test('unknown 档不打印金额，只说明价目表里没有这个模型', () => {
    const line = transparency.formatTurnCost({
      ...baseTurn,
      costUSD: 0.0026, // stale rough value must not leak through as a measured number
      costState: 'unknown',
    });
    expect(line).not.toContain('$');
    expect(line).toContain('价格未知（价目表无此模型）');
  });

  test('flat / assumed 档保留金额并标注为粗价', () => {
    const flat = transparency.formatTurnCost({ ...baseTurn, costUSD: 0.07, costState: 'flat' });
    expect(flat).toContain('~粗价');
    expect(flat).toContain('$0.07');

    const assumed = transparency.formatTurnCost({ ...baseTurn, costUSD: 0.0026, costState: 'assumed' });
    expect(assumed).toContain('~粗价');
    expect(assumed).toContain('$0.0026');
  });

  test('priced 档与旧的纯 costUSD 输出逐字节一致', () => {
    const oldLine = transparency.formatTurnCost({ ...baseTurn, costUSD: 0.0042 });
    const pricedLine = transparency.formatTurnCost({
      ...baseTurn,
      costUSD: 0.0042,
      costState: 'priced',
    });
    expect(pricedLine).toBe(oldLine);
  });

  test('free 档显示免费，而不是零金额', () => {
    const line = transparency.formatTurnCost({ ...baseTurn, costUSD: 0, costState: 'free' });
    expect(line).toContain('免费');
    expect(line).not.toContain('$');
  });
});

describe('usage ledger cost provenance', () => {
  test('老记录（无 costState/estimated）读取不报错，也不被算成估算', () => {
    // Old call signature: no 8th meta argument.
    tokenUsage.recordUsage('OpenAI', 'gpt-4o-mini', 1000, 500, 0.001);

    const rec = tokenUsage.getSessionUsage().records[0];
    expect(rec).not.toHaveProperty('costState');
    expect(rec).not.toHaveProperty('estimated');

    const legacy = [{ provider: 'OpenAI', model: 'gpt-4o-mini', inputTokens: 1, outputTokens: 1 }];
    expect(tokenUsage.summarizeCostProvenance(legacy)).toEqual({ total: 0, estimated: 0, rough: 0 });
    expect(() => tokenUsage.formatUsageReport()).not.toThrow();
    expect(tokenUsage.formatUsageReport()).not.toContain('为估算 / 回落粗价');
  });

  test('estimated 与 flat/unknown 分开计数，报表出现「其中 N 条」', () => {
    tokenUsage.recordUsage('unknown', 'model-a', 10, 5, 0, 0, 0, { estimated: true });
    tokenUsage.recordUsage('kiro', 'claude-opus-4-7', 20, 5, 0.07, 0, 0, { costState: 'flat' });
    tokenUsage.recordUsage('OpenAI', 'gpt-4o-mini', 30, 5, 0.0042, 0, 0, { costState: 'priced' });

    const prov = tokenUsage.summarizeCostProvenance(tokenUsage.getSessionUsage().records);
    expect(prov).toEqual({ total: 2, estimated: 1, rough: 1 });

    const usage = tokenUsage.formatUsageReport();
    expect(usage).toContain('其中 2 条为估算 / 回落粗价');

    const cost = tokenUsage.formatCostReport();
    expect(cost).toContain('其中 2 条为估算 / 回落粗价');
  });
});
