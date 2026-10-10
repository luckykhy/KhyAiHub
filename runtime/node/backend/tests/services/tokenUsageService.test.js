'use strict';

/**
 * Tests for tokenUsageService.js — pure function tests.
 * Avoids disk I/O by testing estimateTokens, calculateCost, and
 * session-level functions after resetUsage().
 */

// Mock fs to prevent real disk I/O
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(() => '{}'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

// Mock subscriptionService to avoid external dependency
jest.mock('../../src/services/subscriptionService', () => ({
  getCurrentTier: () => 'free',
  TIERS: { free: { limits: { cloud_ai_tokens: 100000 } } },
}), { virtual: true });

// 拿到被 mock 的 fs，用于断言「对账过程零写入」
const fs = require('fs');

const {
  estimateTokens,
  calculateCost,
  recordUsage,
  getSessionUsage,
  resetUsage,
  recordCompressionSavings,
  getCompressionStats,
  reconcileCost,
  formatReconcileSummary,
  TOKEN_PRICING,
  USD_TO_CNY,
} = require('../../src/services/tokenUsageService');

beforeEach(() => {
  resetUsage();
});

describe('estimateTokens', () => {
  test('returns 0 for null/undefined/empty input', () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens('')).toBe(0);
  });

  test('estimates English text at ~4 chars per token', () => {
    const text = 'Hello world, this is a test string for estimation.';
    const tokens = estimateTokens(text);
    // 50 chars / 4 = ~12-13 tokens
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(25);
  });

  test('estimates Chinese text at ~1.5 chars per token', () => {
    const text = '你好世界测试字符串';
    const tokens = estimateTokens(text);
    // 9 CJK chars / 1.5 = 6 tokens
    expect(tokens).toBe(6);
  });

  test('handles mixed CJK and ASCII text', () => {
    const text = 'Hello你好World世界';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });

  test('returns integer values (ceiling)', () => {
    const text = 'a';
    const tokens = estimateTokens(text);
    expect(Number.isInteger(tokens)).toBe(true);
  });
});

describe('calculateCost', () => {
  test('calculates cost for known provider', () => {
    const { costUSD, costCNY } = calculateCost('OpenAI', 1000000, 500000);
    // OpenAI: input $0.15/1M, output $0.60/1M
    // cost = (1M * 0.15 + 500K * 0.60) / 1M = 0.15 + 0.30 = 0.45
    expect(costUSD).toBeCloseTo(0.45, 4);
    expect(costCNY).toBeCloseTo(costUSD * USD_TO_CNY, 4);
  });

  test('uses default pricing for unknown provider', () => {
    const { costUSD } = calculateCost('UnknownProvider', 1000000, 1000000);
    const defaultPricing = TOKEN_PRICING['default'];
    const expected = (1000000 * defaultPricing.input + 1000000 * defaultPricing.output) / 1000000;
    expect(costUSD).toBeCloseTo(expected, 6);
  });

  test('returns zero cost for local/free providers', () => {
    const { costUSD, costCNY } = calculateCost('Ollama', 100000, 50000);
    expect(costUSD).toBe(0);
    expect(costCNY).toBe(0);
  });

  test('returns CNY using USD_TO_CNY exchange rate', () => {
    const { costUSD, costCNY } = calculateCost('Anthropic', 100000, 50000);
    expect(costCNY).toBeCloseTo(costUSD * USD_TO_CNY, 6);
  });

  test('handles zero tokens', () => {
    const { costUSD } = calculateCost('OpenAI', 0, 0);
    expect(costUSD).toBe(0);
  });
});

describe('session usage tracking', () => {
  test('starts with zero session usage after reset', () => {
    const usage = getSessionUsage();
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.totalTokens).toBe(0);
    expect(usage.requests).toBe(0);
  });

  test('recordUsage accumulates session tokens', () => {
    recordUsage('OpenAI', 'gpt-4o-mini', 100, 200, 0.01);
    recordUsage('OpenAI', 'gpt-4o-mini', 50, 75, 0.005);
    const usage = getSessionUsage();
    expect(usage.inputTokens).toBe(150);
    expect(usage.outputTokens).toBe(275);
    expect(usage.totalTokens).toBe(425);
    expect(usage.requests).toBe(2);
  });

  test('resetUsage clears session data', () => {
    recordUsage('OpenAI', 'gpt-4o-mini', 100, 200);
    resetUsage();
    const usage = getSessionUsage();
    expect(usage.totalTokens).toBe(0);
    expect(usage.requests).toBe(0);
  });
});

describe('compression stats', () => {
  test('starts at zero after reset', () => {
    const stats = getCompressionStats();
    expect(stats.originalTokens).toBe(0);
    expect(stats.savedPercent).toBe(0);
    expect(stats.requests).toBe(0);
  });

  test('tracks compression savings correctly', () => {
    recordCompressionSavings(1000, 600);
    recordCompressionSavings(2000, 1200);
    const stats = getCompressionStats();
    expect(stats.originalTokens).toBe(3000);
    expect(stats.compressedTokens).toBe(1800);
    expect(stats.savedTokens).toBe(1200);
    expect(stats.savedPercent).toBe(40);
    expect(stats.requests).toBe(2);
  });

  test('handles case where compressed > original (no negative savings)', () => {
    recordCompressionSavings(100, 150);
    const stats = getCompressionStats();
    expect(stats.savedTokens).toBe(0);
  });
});

describe('cache read/write ledger split (c79c931)', () => {
  // The gateway adapters already return cacheReadInputTokens/cacheWriteInputTokens
  // (claude/codex direct paths); the ledger previously dropped them at the
  // recordUsage entry, so cache-write tokens (billed at a 1.25x premium) were
  // invisible to the daily/monthly spend. The split is ADDITIVE: the existing
  // input/output/total columns keep their semantics — a write turn must stop
  // masquerading as (or vanishing from) the miss column, not inflate it.

  test('records cache read/write as separate columns without polluting input/total', () => {
    recordUsage('Anthropic', 'claude-3-5-sonnet', 100, 200, 0.01, 30, 50);
    const usage = getSessionUsage();
    expect(usage.cacheReadTokens).toBe(30);
    expect(usage.cacheWriteTokens).toBe(50);
    // The split must NOT inflate the existing columns (write ≠ miss).
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(200);
    expect(usage.totalTokens).toBe(300);
    // Per-request detail carries the split.
    expect(usage.records[usage.records.length - 1].cacheReadTokens).toBe(30);
    expect(usage.records[usage.records.length - 1].cacheWriteTokens).toBe(50);
  });

  test('legacy 5-arg calls keep cache columns at 0 (not undefined)', () => {
    recordUsage('OpenAI', 'gpt-4o-mini', 100, 200);
    const usage = getSessionUsage();
    expect(usage.cacheReadTokens).toBe(0);
    expect(usage.cacheWriteTokens).toBe(0);
    expect(usage.inputTokens).toBe(100);
  });

  test('cache columns accumulate across calls and reset with resetUsage', () => {
    recordUsage('Anthropic', 'claude-3-5-sonnet', 100, 200, 0, 30, 50);
    recordUsage('Anthropic', 'claude-3-5-sonnet', 100, 200, 0, 0, 50);
    let usage = getSessionUsage();
    expect(usage.cacheReadTokens).toBe(30);
    expect(usage.cacheWriteTokens).toBe(100);
    resetUsage();
    usage = getSessionUsage();
    expect(usage.cacheReadTokens).toBe(0);
    expect(usage.cacheWriteTokens).toBe(0);
  });
});

// ── 成本对账（L2，借鉴 ccusage 的 display/calculate 双档）──────────────
// 见 [MGMT-PLAN-011] 落地记录 L2。核心契约：**只读**——不写文件、不改会话状态、不改入参。

describe('reconcileCost', () => {
  /** 清掉 beforeEach/resetUsage 留下的写调用，之后即可断言「零写入」。 */
  function clearFsWrites() {
    fs.writeFileSync.mockClear();
  }

  test('is read-only: performs zero filesystem writes', () => {
    clearFsWrites();
    const r = reconcileCost([
      { provider: 'OpenAI', inputTokens: 1000, outputTokens: 500, costUSD: 0.001 },
    ]);
    expect(r.records).toBe(1);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  test('does not mutate the input array or its records', () => {
    const input = [{ provider: 'OpenAI', inputTokens: 1000, outputTokens: 500, costUSD: 0.42 }];
    const snapshot = JSON.stringify(input);
    reconcileCost(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test('does not mutate session state', () => {
    recordUsage('OpenAI', 'gpt-4o-mini', 1000, 500, 0.42);
    const before = JSON.stringify(getSessionUsage());
    clearFsWrites();
    reconcileCost(); // 无参 → 读会话 records
    expect(JSON.stringify(getSessionUsage())).toBe(before);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  test('reports zero drift when upstream equals the two-bucket recomputation', () => {
    // OpenAI: input 0.15/1M, output 0.60/1M → (1M*0.15 + 500K*0.60)/1M = 0.45
    const r = reconcileCost([
      { provider: 'OpenAI', inputTokens: 1e6, outputTokens: 5e5, costUSD: 0.45 },
    ]);
    expect(r.upstreamUSD).toBeCloseTo(0.45, 6);
    expect(r.recalculatedUSD).toBeCloseTo(0.45, 6);
    expect(r.driftUSD).toBeCloseTo(0, 6);
    expect(r.driftPct).toBeCloseTo(0, 6);
  });

  test('surfaces drift between the two cost paths (the reason this exists)', () => {
    // 上游说 0.90，两桶重算只有 0.45 ⇒ 漂移 +100%
    const r = reconcileCost([
      { provider: 'OpenAI', inputTokens: 1e6, outputTokens: 5e5, costUSD: 0.9 },
    ]);
    expect(r.upstreamUSD).toBeCloseTo(0.9, 6);
    expect(r.recalculatedUSD).toBeCloseTo(0.45, 6);
    expect(r.driftUSD).toBeCloseTo(0.45, 6);
    expect(r.driftPct).toBeCloseTo(100, 4);
  });

  test('driftPct is null (not 0, not Infinity) when the recomputed baseline is zero', () => {
    const r = reconcileCost([
      { provider: 'Ollama', inputTokens: 1000, outputTokens: 500, costUSD: 0.5 },
    ]);
    expect(r.recalculatedUSD).toBe(0);
    expect(r.upstreamUSD).toBeCloseTo(0.5, 6);
    expect(r.driftUSD).toBeCloseTo(0.5, 6);
    expect(r.driftPct).toBeNull();
  });

  test('quantifies the cache-token gap instead of silently mis-costing it', () => {
    const r = reconcileCost([
      { provider: 'Anthropic', inputTokens: 1000, outputTokens: 200, costUSD: 0, cacheReadTokens: 30, cacheWriteTokens: 50 },
      { provider: 'Anthropic', inputTokens: 1000, outputTokens: 200, costUSD: 0 },
    ]);
    expect(r.cacheUncostedRequests).toBe(1);
    expect(r.cacheUncostedTokens).toBe(80);
  });

  test('names providers that fall back to the default price list', () => {
    const r = reconcileCost([
      { provider: 'SomeNewVendor', inputTokens: 1000, outputTokens: 100, costUSD: 0 },
      { provider: 'OpenAI', inputTokens: 1000, outputTokens: 100, costUSD: 0 },
      { provider: 'AnotherVendor', inputTokens: 1000, outputTokens: 100, costUSD: 0 },
    ]);
    expect(r.unpricedProviders).toEqual(['AnotherVendor', 'SomeNewVendor']);
  });

  test('tolerates malformed input without throwing', () => {
    expect(() => reconcileCost(null)).not.toThrow();
    expect(() => reconcileCost(undefined)).not.toThrow();
    expect(() => reconcileCost('nope')).not.toThrow();
    expect(() => reconcileCost([null, 42, {}, { inputTokens: 'x', outputTokens: null }])).not.toThrow();
    const r = reconcileCost([null, 42, {}]);
    expect(r.records).toBe(3);
    expect(r.upstreamUSD).toBe(0);
    expect(r.recalculatedUSD).toBe(0);
  });

  test('empty input yields zeros and a null percentage', () => {
    const r = reconcileCost([]);
    expect(r).toMatchObject({ records: 0, upstreamUSD: 0, recalculatedUSD: 0, driftUSD: 0, driftPct: null });
  });
});

describe('formatReconcileSummary', () => {
  test('flags drift at or beyond the warn threshold', () => {
    const r = reconcileCost([
      { provider: 'OpenAI', inputTokens: 1e6, outputTokens: 5e5, costUSD: 0.9 }, // +100%
    ]);
    expect(formatReconcileSummary(r)).toContain('⚠');
    expect(formatReconcileSummary(r)).toContain('+100.0%');
  });

  test('stays unflagged below the warn threshold', () => {
    const r = reconcileCost([
      { provider: 'OpenAI', inputTokens: 1e6, outputTokens: 5e5, costUSD: 0.46 }, // ~+2.2%
    ]);
    const line = formatReconcileSummary(r);
    expect(line.startsWith('⚠')).toBe(false);
    expect(line).toContain('上游');
  });

  test('calls out the cache gap and unpriced providers', () => {
    const r = reconcileCost([
      { provider: 'BrandNew', inputTokens: 1000, outputTokens: 100, costUSD: 0, cacheReadTokens: 10 },
    ]);
    const out = formatReconcileSummary(r);
    expect(out).toContain('缓存 token');
    expect(out).toContain('BrandNew');
  });

  test('handles a missing/invalid result object', () => {
    expect(formatReconcileSummary(null)).toBe('  成本对账: 无数据');
  });
});
