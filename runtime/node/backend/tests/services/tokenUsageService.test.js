'use strict';

/**
 * Tests for tokenUsageService.js — pure function tests.
 * Avoids disk I/O by testing estimateTokens, calculateCost, and
 * session-level functions after resetUsage().
 */

// Mock fs to prevent real disk I/O
// statSync + promises 不可省：mtime 重载与 _flushAsync 走这两条，缺了会
// 「TypeError: fs.statSync is not a function」，让新路径在测试里永远走不到
// ——那等于没测。（不要改成「整段 try/catch 掉 statSync」绕过。）
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
  getSessionCost,
  resetUsage,
  recordCompressionSavings,
  getCompressionStats,
  reconcileCost,
  formatReconcileSummary,
  auditFlatChannels,
  formatCostReport,
  getUsageHistory,
  getModelUsage,
  getCostCoverage,
  getUsageFileStamp,
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

// ── driftKind：把「不可比」与「不一致」分开（第七批）──────────────────────
// 立论：主路径 aiChatCore.js 传给 recordUsage 的 costUSD 是**字面量 0**，adapters 也
// 不产 cost（_responseBuilder.js 无该字段）⇒ 实时会话里上游侧一条记录都没有值。此时
// driftPct 稳定落在 -100%，照旧显示会读成「重算值错得离谱」，而真相是「没有上游值可比」。
// 拿一个算得出来但没有意义的数字冒充诊断，正是本仓注释反复警告的那类事。

describe('reconcileCost driftKind（上游没数据 ≠ 两条路径不一致）', () => {
  test('costUSD 全 0 → no-upstream，且 upstreamReported=0', () => {
    const r = reconcileCost([
      { provider: 'claude', model: 'm', inputTokens: 1000, outputTokens: 500, costUSD: 0 },
      { provider: 'claude', model: 'm', inputTokens: 800, outputTokens: 300, costUSD: 0 },
    ]);
    expect(r.driftKind).toBe('no-upstream');
    expect(r.upstreamReported).toBe(0);
    // 数字本身仍然算得出来（算术没错）——错的是把它当漂移展示
    expect(r.driftPct).toBe(-100);
  });

  test('有任一 costUSD>0 → 不再判 no-upstream', () => {
    const r = reconcileCost([
      { provider: 'claude', model: 'm', inputTokens: 1000, outputTokens: 500, costUSD: 0 },
      { provider: 'claude', model: 'm', inputTokens: 800, outputTokens: 300, costUSD: 0.01 },
    ]);
    expect(r.driftKind).not.toBe('no-upstream');
    expect(r.upstreamReported).toBe(1);
  });

  test('上游高于重算 → over', () => {
    const r = reconcileCost([
      { provider: 'Anthropic', model: 'm', inputTokens: 1000, outputTokens: 0, costUSD: 0.05 },
    ]);
    expect(r.driftKind).toBe('over');
    expect(r.driftUSD).toBeGreaterThan(0);
  });

  test('与牌价精确一致 → agree 且漂移 0', () => {
    // OpenAI input 0.15/M ⇒ 1M input tokens 恰好 $0.15
    const r = reconcileCost([
      { provider: 'OpenAI', model: 'gpt-4o-mini', inputTokens: 1000000, outputTokens: 0, costUSD: 0.15 },
    ]);
    expect(r.driftKind).toBe('agree');
    expect(r.driftPct).toBe(0);
  });

  test('空记录 → empty', () => {
    expect(reconcileCost([]).driftKind).toBe('empty');
  });

  test('有上游但重算为 0 → no-recalc（百分比无定义）', () => {
    const r = reconcileCost([
      { provider: '讯飞星火', model: 'free', inputTokens: 0, outputTokens: 0, costUSD: 0.01 },
    ]);
    expect(r.upstreamReported).toBe(1);
    expect(r.recalculatedUSD).toBe(0);
    expect(r.driftKind).toBe('no-recalc');
    expect(r.driftPct).toBeNull();
  });

  test('driftKind 不改变任何既有数字（纯加法）', () => {
    const recs = [
      { provider: 'Anthropic', model: 'm', inputTokens: 1000, outputTokens: 500, costUSD: 0.05 },
      { provider: 'kiro', model: 'm', inputTokens: 100, outputTokens: 50, costUSD: 0.01 },
    ];
    const r = reconcileCost(recs);
    expect(r.upstreamUSD).toBeCloseTo(0.06, 10);
    expect(r.driftUSD).toBeCloseTo(r.upstreamUSD - r.recalculatedUSD, 10);
    expect(r.driftPct).toBeCloseTo((r.driftUSD / r.recalculatedUSD) * 100, 8);
  });
});

describe('formatReconcileSummary 的 no-upstream 一档', () => {
  test('上游没数据时说「无法对账」并指出唯一可读口径，绝不打 -100%', () => {
    const r = reconcileCost([
      { provider: 'claude', model: 'm', inputTokens: 1000, outputTokens: 500, costUSD: 0 },
    ]);
    const s = formatReconcileSummary(r);
    expect(s).toContain('无法对账');
    expect(s).toContain('0/1 条带 costUSD');
    // 误导性读数不许出现
    expect(s).not.toContain('-100');
    expect(s).not.toContain('漂移');
  });

  test('两侧真可比时格式与改造前逐字节一致', () => {
    const r = reconcileCost([
      { provider: 'Anthropic', model: 'm', inputTokens: 1000, outputTokens: 500, costUSD: 0.05, cacheReadTokens: 2000 },
      { provider: 'kiro', model: 'm', inputTokens: 100, outputTokens: 50, costUSD: 0.01 },
    ]);
    const s = formatReconcileSummary(r);
    expect(s).toContain('成本对账: 上游 $0.0600 / 重算 $');
    expect(s).toContain('漂移 +');
    expect(s).toContain('（2 条）');
    // 附带的两行（缓存缺口 / 落 default）仍在
    expect(s).toContain('条请求含缓存 token');
    expect(s).toContain('已回落 default');
  });
});

// ── L1：壳真正委托定价叶子（[MGMT-RPT-035] 第一批查出的「提取了却没接线」）────
// tokenPricing.js 自称 canonical 叶子、契约写明「壳以原签名薄委托本叶子」，
// 但 tokenUsageService 从未 require 它，各自持有一份 12 键表副本。两份表已漂移：
// 叶子有 DeepSeek / Together AI，副本没有 ⇒ 这两家用量一直静默落 default 粗价。

describe('L1 pricing delegation', () => {
  const tokenPricing = require('../../src/services/tokenPricing');

  test('TOKEN_PRICING 与叶子是同一对象（单一真源，不再是两份会漂移的副本）', () => {
    expect(TOKEN_PRICING).toBe(tokenPricing.TOKEN_PRICING);
  });

  test('USD_TO_CNY 与叶子同源', () => {
    expect(USD_TO_CNY).toBe(tokenPricing.USD_TO_CNY);
  });

  test('接口恒等：12 个既有 provider 的价格与委托前逐一相同', () => {
    // 委托前本壳那份表的价格（摘自委托前的字面量）
    const legacy = {
      OpenAI: [0.15, 0.6], Anthropic: [3, 15], 'Google Gemini': [0.075, 0.3],
      Groq: [0.05, 0.08], OpenRouter: [0.1, 0.3], '智谱AI': [0.1, 0.1],
      '讯飞星火': [0, 0], '百度文心': [0.12, 0.12], '通义千问': [0.008, 0.02],
      HuggingFace: [0, 0], Ollama: [0, 0], default: [0.1, 0.3],
    };
    for (const [provider, [input, output]] of Object.entries(legacy)) {
      expect(TOKEN_PRICING[provider].input).toBe(input);
      expect(TOKEN_PRICING[provider].output).toBe(output);
    }
  });

  test('接口恒等：calculateCost 对既有 provider 的结果与叶子一致', () => {
    for (const provider of ['OpenAI', 'Anthropic', 'Ollama', 'UnknownProvider']) {
      expect(calculateCost(provider, 1000, 500)).toEqual(tokenPricing.calculateCost(provider, 1000, 500));
    }
  });

  test('净收益：DeepSeek / Together AI 不再落 default 粗价', () => {
    // 委托前两者不在表里 → 落 default(0.10/0.30)，1M/1M 应为 0.40
    expect(TOKEN_PRICING.DeepSeek).toEqual({ input: 0.27, output: 1.1 });
    expect(TOKEN_PRICING['Together AI']).toEqual({ input: 0.88, output: 0.88 });
    expect(calculateCost('DeepSeek', 1e6, 1e6).costUSD).toBeCloseTo(1.37, 6);
    expect(calculateCost('DeepSeek', 1e6, 1e6).costUSD).toBeCloseTo(
      tokenPricing.calculateCost('DeepSeek', 1e6, 1e6).costUSD, 10
    );
  });

  test('接口恒等：getSessionCost 与叶子 sumRecordsCost 对同一批 records 同结果', () => {
    recordUsage('OpenAI', 'gpt-4o-mini', 1000, 500);
    recordUsage('Anthropic', 'claude-3-5-sonnet', 2000, 1000);
    const viaShell = getSessionCost();
    const viaLeaf = tokenPricing.sumRecordsCost(getSessionUsage().records);
    expect(viaShell.costUSD).toBeCloseTo(viaLeaf.costUSD, 12);
    expect(viaShell.costCNY).toBeCloseTo(viaLeaf.costCNY, 12);
  });
});

// ── L1 第二半：订阅制通道不该有 token 价（flat 态审计）──────────────────
// 判据是仓内既有裁定而非本函数发明：config/models/pricing.json 的
// flat-subscription-relays 写着「账单是包月，按 token 计价本身不成立」，
// 而 TOKEN_PRICING 没有这些 provider ⇒ 它们一直静默落 default 发明出一个价格。

describe('auditFlatChannels', () => {
  // 仓内既有裁定的原文（config/models/pricing.json 的 flat-subscription-relays）。
  // 必须显式注入：本文件的 fs mock 让 modelPricing 读到空表，不注入就测不到 flat。
  const FLAT_TABLE = {
    families: [
      {
        id: 'flat-subscription-relays',
        match: '(^|[^a-z])(kiro|cursor|trae|warp|vscode|clipboard|opencode|openclaw)([^a-z]|$)',
        state: 'flat',
        source: '[DESIGN-ARCH-185] §2.2-2',
      },
    ],
    models: {},
  };

  test('认出订阅制通道，并算出被 default 粗价发明出来的那部分金额', () => {
    const r = auditFlatChannels([
      { provider: 'kiro', model: 'kiro', inputTokens: 1000, outputTokens: 500 },
      { provider: 'trae', model: 'trae', inputTokens: 2000, outputTokens: 1000 },
      { provider: 'Anthropic', model: 'claude-3-5-sonnet', inputTokens: 1000, outputTokens: 500 },
      { provider: 'OpenAI', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 },
    ], { table: FLAT_TABLE });
    expect(r.degraded).toBe(false);
    expect(r.requests).toBe(2);
    expect(r.providers).toEqual(['kiro', 'trae']);
    expect(r.tokens).toBe(4500);
    // kiro 1000/500 + trae 2000/1000 全落 default(0.10/0.30)：
    // (1000*0.10 + 500*0.30 + 2000*0.10 + 1000*0.30)/1e6
    expect(r.recalculatedUSD).toBeCloseTo(0.00075, 10);
  });

  test('非订阅通道一律不计入', () => {
    const r = auditFlatChannels([
      { provider: 'Anthropic', model: 'claude-3-5-sonnet', inputTokens: 9999, outputTokens: 9999 },
      { provider: 'OpenAI', model: 'gpt-4o-mini', inputTokens: 9999, outputTokens: 9999 },
      { provider: 'Ollama', model: 'llama3', inputTokens: 9999, outputTokens: 9999 },
    ]);
    expect(r.requests).toBe(0);
    expect(r.providers).toEqual([]);
    expect(r.recalculatedUSD).toBe(0);
  });

  test('空输入与畸形输入不抛，且不算 degraded', () => {
    expect(auditFlatChannels([])).toMatchObject({ requests: 0, degraded: false });
    expect(() => auditFlatChannels(null)).not.toThrow();
    expect(() => auditFlatChannels('nope')).not.toThrow();
    expect(() => auditFlatChannels([null, 42, {}, { provider: 'kiro' }])).not.toThrow();
    // provider 是 kiro 但缺 token 字段 → 仍算一条 flat，只是token 记 0
    const r = auditFlatChannels([{ provider: 'kiro' }], { table: FLAT_TABLE });
    expect(r.requests).toBe(1);
    expect(r.tokens).toBe(0);
  });

  test('审计没跑成时必须报 degraded，而不是假装「没有 flat 通道」', () => {
    // 这条锁的是本函数最初的真实 bug：require 路径写错被 catch 静默吞成全 0，
    // 于是「审计坏了」和「没问题」长得一模一样——那等于给一个已经存在的错误计价
    // 发一张无问题的健康证明，比不审计更糟。
    jest.resetModules();
    jest.doMock('../../src/services/modelPricing', () => ({
      resolvePrice: () => { throw new Error('pricing table broken'); },
    }));
    try {
      // eslint-disable-next-line global-require
      const tuFresh = require('../../src/services/tokenUsageService');
      const r = tuFresh.auditFlatChannels([
        { provider: 'kiro', model: 'kiro', inputTokens: 1, outputTokens: 1 },
      ]);
      expect(r.degraded).toBe(true);
      expect(r.requests).toBe(0);
    } finally {
      jest.dontMock('../../src/services/modelPricing');
      jest.resetModules();
    }
  });
});

describe('formatCostReport 接入计价体检（L2/L1 的消费面）', () => {
  const FLAT_TABLE = {
    families: [
      {
        id: 'flat-subscription-relays',
        match: '(^|[^a-z])(kiro|cursor|trae|warp|vscode|clipboard|opencode|openclaw)([^a-z]|$)',
        state: 'flat',
        source: '[DESIGN-ARCH-185] §2.2-2',
      },
    ],
    models: {},
  };

  test('无记录 ⇒ 不追加体检段（安静的用户看到与今日逐字节一致的输出）', () => {
    resetUsage();
    const out = formatCostReport();
    expect(out).not.toContain('计价体检');
  });

  test('有订阅制通道记录 ⇒ /cost 里点名它，并说明那部分不是真实花费', () => {
    resetUsage();
    recordUsage('kiro', 'kiro', 1000, 500);
    const out = formatCostReport({ pricingTable: FLAT_TABLE });
    expect(out).toContain('计价体检');
    expect(out).toContain('订阅制通道按 token 计价不成立');
    expect(out).toContain('kiro');
    expect(out).toContain('不是真实花费');
  });

  test('有未计价缓存 token ⇒ /cost 里点名重算值系统性偏低', () => {
    resetUsage();
    recordUsage('Anthropic', 'claude-3-5-sonnet', 1000, 200, 0, 30, 50);
    const out = formatCostReport();
    expect(out).toContain('缓存 token 未计价');
    expect(out).toContain('系统性偏低');
  });

  test('provider 无专属价目 ⇒ /cost 里点名回落 default', () => {
    resetUsage();
    recordUsage('SomeNewVendor', 'some-model', 1000, 100);
    const out = formatCostReport();
    expect(out).toContain('无专属价目');
    expect(out).toContain('SomeNewVendor');
  });

  test('成本口径漂移超阈值 ⇒ /cost 里给出两条路径的数字', () => {
    resetUsage();
    // 上游 0.90 vs 两桶重算 0.45 ⇒ +100%
    recordUsage('OpenAI', 'gpt-4o-mini', 1e6, 5e5, 0.9);
    const out = formatCostReport();
    expect(out).toContain('成本口径漂移');
    expect(out).toContain('+100.0%');
  });

  test('漂移在阈值内且无其他发现 ⇒ 仍不追加体检段', () => {
    resetUsage();
    recordUsage('OpenAI', 'gpt-4o-mini', 1e6, 5e5, 0.46); // ~+2.2%，低于 10%
    const out = formatCostReport();
    expect(out).not.toContain('计价体检');
  });

  // ── 第七批：上游侧没数据时，[MGMT-RPT-035] 主路径（aiChatCore 传字面量 0）的真实形状 ──
  test('上游未提供成本 ⇒ 说「无法对账」，绝不再打 -100% 冒充漂移', () => {
    resetUsage();
    recordUsage('claude', 'claude-sonnet-4-5', 1000, 500, 0, 2000, 0); // costUSD=0 + 缓存
    const out = formatCostReport();
    expect(out).toContain('计价体检');
    expect(out).toContain('上游未提供成本，无法对账');
    expect(out).toContain('0/1 条带 costUSD');
    // 误导性读数：主路径下 driftPct 恒为 -100，不许出现在 /cost 里
    expect(out).not.toContain('-100.0%');
    expect(out).not.toContain('成本口径漂移');
    // 其余发现照旧出现（它们与上游有没有数据无关）
    expect(out).toContain('缓存 token 未计价');
  });

  test('上游没数据但也没有其他发现 ⇒ 仍然要提示（接线缺口本身就是发现）', () => {
    resetUsage();
    recordUsage('OpenAI', 'gpt-4o-mini', 1e6, 5e5, 0); // 有牌价、无缓存、上游 0
    const out = formatCostReport();
    expect(out).toContain('计价体检');
    expect(out).toContain('无法对账');
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

// ── 使用统计页的新增导出（KhyOS Desktop 消费面）─────────────────────────

describe('getUsageHistory: 8 键投影', () => {
  const KEYS = [
    'date', 'inputTokens', 'outputTokens', 'totalTokens',
    'requests', 'costUSD', 'cacheReadTokens', 'cacheWriteTokens',
  ];

  test('每行恰 8 键，且与日桶逐字相等', () => {
    resetUsage();
    recordUsage('Anthropic', 'claude-3-5-sonnet', 1_964_263, 16_463, 0, 952_320, 0);
    const rows = getUsageHistory(1);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([...KEYS].sort());
    const row = rows[0];
    expect(row.inputTokens).toBe(1_964_263);
    expect(row.outputTokens).toBe(16_463);
    expect(row.totalTokens).toBe(1_980_726);
    expect(row.requests).toBe(1);
    expect(row.cacheReadTokens).toBe(952_320);
    expect(row.cacheWriteTokens).toBe(0);
  });

  test('totalTokens 是日桶原值，**不是**四桶和（两者不等，是既有事实不是 bug）', () => {
    resetUsage();
    recordUsage('Anthropic', 'claude-3-5-sonnet', 1_964_263, 16_463, 0, 952_320, 0);
    const row = getUsageHistory(1)[0];
    const fourBucketSum =
      row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
    // 2,933,046 ≠ 1,980,726 —— 缓存两列是独立累加器，加进去就成了第三个总量口径
    expect(fourBucketSum).toBe(2_933_046);
    expect(row.totalTokens).toBe(1_980_726);
    expect(row.totalTokens).toBe(row.inputTokens + row.outputTokens);
    expect(row.totalTokens).not.toBe(fourBucketSum);
  });

  test('无记录的日期返回全 0 行而不是被跳过（日期轴不能缺天）', () => {
    resetUsage();
    const rows = getUsageHistory(3);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.totalTokens).toBe(0);
      expect(r.requests).toBe(0);
    }
  });
});

describe('mtime 重载：长驻进程读得到盘上更新', () => {
  afterEach(() => {
    fs.statSync.mockReturnValue({ mtimeMs: 1 });
    fs.readFileSync.mockReturnValue('{}');
  });

  test('statSync 返回新 mtime 时重载镜像', () => {
    resetUsage();
    fs.statSync.mockReturnValue({ mtimeMs: 1 });
    // 第一次读：镜像里什么都没有（resetUsage 清空 + 盘上 mock 是 {}）
    expect(getUsageHistory(1)[0].requests).toBe(0);

    // 另一个进程（CLI / REPL）写了盘
    const dayKey = new Date().toISOString().slice(0, 10);
    fs.readFileSync.mockReturnValue(JSON.stringify({
      daily: { [dayKey]: { inputTokens: 5, outputTokens: 5, totalTokens: 10, requests: 2, costUSD: 0.1 } },
      monthlyTotals: {},
    }));
    fs.statSync.mockReturnValue({ mtimeMs: 2 });
    fs.existsSync.mockReturnValue(true);

    const row = getUsageHistory(1)[0];
    expect(row.requests).toBe(2);
    expect(row.totalTokens).toBe(10);
  });

  test('mtime 未变时不重载（不白读盘）', () => {
    resetUsage();
    fs.statSync.mockReturnValue({ mtimeMs: 7 });
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('{"daily":{},"monthlyTotals":{}}');
    getUsageHistory(1);
    const callsAfterFirst = fs.readFileSync.mock.calls.length;
    getUsageHistory(1);
    getUsageHistory(1);
    expect(fs.readFileSync.mock.calls.length).toBe(callsAfterFirst);
  });

  test('statSync 抛错时保留旧镜像，不把错误抛给调用方', () => {
    resetUsage();
    // 先用固定 mtime 读一次把 _fileMtimeMs 锚住（它是模块级状态，跨用例留存；
    // 不先锚就 recordUsage，重载会拿 mock 的空盘把刚记的这笔抹掉）
    fs.statSync.mockReturnValue({ mtimeMs: 555 });
    getUsageHistory(1);
    recordUsage('OpenAI', 'gpt-4o-mini', 100, 50, 0);
    expect(getUsageHistory(1)[0].requests).toBe(1);
    fs.statSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(() => getUsageHistory(1)).not.toThrow();
    expect(getUsageHistory(1)[0].requests).toBe(1);
  });

  test('flush 进行中（_dirty 已清、_flushing 未清）不重载——盘上文件还是旧的', () => {
    // NODE_ENV=test 时 _scheduleFlush 走同步路径，_dirty 当场清零，看不到那个窗口。
    // 切成非 test 才走 _flushAsync：它先 _dirty=false 再 _flushing=true，
    // 中间横跨两次 await —— recordUsage 返回那一刻正落在这个窗口里。
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      resetUsage();
      recordUsage('OpenAI', 'gpt-4o-mini', 7, 3, 0);
      // 此刻 _dirty=false（已清）但 _flushing=true（未清）：只看 _dirty 会放行，
      // 拿盘上的旧文件覆盖刚记的这笔。
      fs.statSync.mockReturnValue({ mtimeMs: 999 });
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{"daily":{},"monthlyTotals":{}}');
      expect(getUsageHistory(1)[0].totalTokens).toBe(10);
    } finally {
      process.env.NODE_ENV = prevEnv;
      fs.statSync.mockReturnValue({ mtimeMs: 1 });
    }
  });

  test('盘上文件形状不全时不炸读路径（老文件只有 daily / 只有 monthlyTotals）', () => {
    resetUsage();
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({ mtimeMs: 42 });
    fs.readFileSync.mockReturnValue('{"daily":{"2026-10-11":{"totalTokens":3,"requests":1}}}');
    expect(getUsageHistory(1)[0].totalTokens).toBe(3);
    fs.statSync.mockReturnValue({ mtimeMs: 43 });
    fs.readFileSync.mockReturnValue('{"monthlyTotals":{}}');
    expect(() => getUsageHistory(1)).not.toThrow();
    expect(getCostCoverage(7).byDay.daysWithRequests).toBe(0);
    fs.existsSync.mockReturnValue(false);
  });
});

describe('getUsageFileStamp', () => {
  afterEach(() => { fs.statSync.mockReturnValue({ mtimeMs: 1 }); });

  test('返回 ISO 字符串', () => {
    fs.statSync.mockReturnValue({ mtimeMs: Date.parse('2026-10-11T10:00:16.839Z') });
    expect(getUsageFileStamp()).toBe('2026-10-11T10:00:16.839Z');
  });

  test('文件不存在返回 null，不把 ENOENT 抛给调用方', () => {
    fs.statSync.mockImplementation(() => {
      const e = new Error('ENOENT');
      e.code = 'ENOENT';
      throw e;
    });
    expect(getUsageFileStamp()).toBeNull();
  });

  test('mtime 非有限返回 null（调用方据此整行不渲染「数据截至」）', () => {
    fs.statSync.mockReturnValue({ mtimeMs: NaN });
    expect(getUsageFileStamp()).toBeNull();
  });
});

describe('getCostCoverage: 两个时间轴口径的返回体', () => {
  test('返回体只有 byDay 与 flatThisProcess 两个字段名', () => {
    resetUsage();
    const cov = getCostCoverage(7);
    expect(Object.keys(cov).sort()).toEqual(['byDay', 'flatThisProcess']);
    // 日桶结构下拿不到「部分计价的日子」，这两个键不得被加回来
    expect(cov.byDay).not.toHaveProperty('pricedRequests');
    expect(cov.byDay).not.toHaveProperty('totalRequests');
    expect(cov.byDay).not.toHaveProperty('coverage');
    expect(Object.keys(cov.byDay).sort()).toEqual([
      'daysWithRequests', 'pricedDays', 'unpricedDayDates', 'unpricedDays',
    ]);
  });

  test('造两天：一天计价、一天没计价', () => {
    jest.useFakeTimers();
    try {
      resetUsage();
      jest.setSystemTime(new Date('2026-10-10T12:00:00Z'));
      recordUsage('OpenAI', 'gpt-4o-mini', 1000, 1000, 0.5);
      jest.setSystemTime(new Date('2026-10-11T12:00:00Z'));
      recordUsage('Anthropic', 'claude-3-5-sonnet', 500, 500, 0);
      const cov = getCostCoverage(2);
      expect(cov.byDay.daysWithRequests).toBe(2);
      expect(cov.byDay.pricedDays).toBe(1);
      expect(cov.byDay.unpricedDays).toBe(1);
      expect(cov.byDay.unpricedDayDates).toContain('2026-10-11');
    } finally {
      jest.useRealTimers();
    }
  });

  test('无请求的日期不进分母（byDay 只数有请求的天）', () => {
    resetUsage();
    const cov = getCostCoverage(30);
    expect(cov.byDay.daysWithRequests).toBe(0);
    expect(cov.byDay.pricedDays).toBe(0);
    expect(cov.byDay.unpricedDayDates).toEqual([]);
  });

  test('flatThisProcess 原样透出 degraded：审计没跑成必须让调用方知道', () => {
    jest.resetModules();
    jest.doMock('../../src/services/modelPricing', () => ({
      resolvePrice: () => { throw new Error('pricing table broken'); },
    }));
    try {
      // eslint-disable-next-line global-require
      const tuFresh = require('../../src/services/tokenUsageService');
      // auditFlatChannels 只在遍历 records 时碰价目表，空 records 走不到那里，
      // degraded 自然为 false —— 先记一笔，才有「审计本该跑却没跑成」的形状。
      tuFresh.recordUsage('kiro', 'kiro', 10, 10, 0);
      const cov = tuFresh.getCostCoverage(7);
      expect(cov.flatThisProcess.degraded).toBe(true);
      expect(cov.flatThisProcess.requests).toBe(0);
      // 三个「没有」里只有 degraded 是真话，另两个不许被读成「本进程无订阅制通道」
      expect(cov.byDay.daysWithRequests).toBeGreaterThanOrEqual(0);
    } finally {
      jest.dontMock('../../src/services/modelPricing');
      jest.resetModules();
    }
  });

  test('审计正常时 degraded 为 false', () => {
    resetUsage();
    recordUsage('OpenAI', 'gpt-4o-mini', 100, 50, 0);
    expect(getCostCoverage(7).flatThisProcess.degraded).toBe(false);
  });
});

describe('getModelUsage: 本进程按模型归组', () => {
  test('records 为空返回 [] 而不抛（本次报错的回归锁）', () => {
    resetUsage();
    const rows = getModelUsage();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(0);
  });

  test('行形状与 host 侧类型声明一致，且带 scope=process', () => {
    resetUsage();
    recordUsage('OpenAI', 'gpt-4o-mini', 1000, 200, 0);
    recordUsage('Anthropic', 'claude-3-5-sonnet', 300, 100, 0);
    const rows = getModelUsage();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual([
        'costUSD', 'inputTokens', 'model', 'outputTokens', 'percentage', 'requests', 'scope', 'totalTokens',
      ]);
      expect(r.scope).toBe('process');
    }
  });

  test('按 totalTokens 降序（costUSD 主路径恒 0 时这就是「谁吃得多」）', () => {
    resetUsage();
    recordUsage('OpenAI', 'gpt-4o-mini', 1000, 200, 0);
    recordUsage('Anthropic', 'claude-3-5-sonnet', 300, 100, 0);
    const rows = getModelUsage();
    expect(rows[0].model).toBe('gpt-4o-mini');
    expect(rows[1].model).toBe('claude-3-5-sonnet');
    expect(rows[0].totalTokens).toBe(1200);
  });

  test('percentage 之和 ≈100（误差 ≤0.5）', () => {
    resetUsage();
    recordUsage('OpenAI', 'gpt-4o-mini', 1000, 200, 0);
    recordUsage('Anthropic', 'claude-3-5-sonnet', 333, 111, 0);
    recordUsage('Ollama', 'llama3', 7, 5, 0);
    const rows = getModelUsage();
    const sum = rows.reduce((a, r) => a + r.percentage, 0);
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.5);
  });

  test('畸形 records 不炸（叶子承诺绝不抛）', () => {
    resetUsage();
    expect(() => getModelUsage()).not.toThrow();
    expect(() => getCostCoverage(0)).not.toThrow();
    expect(() => getCostCoverage(-1)).not.toThrow();
  });
});
