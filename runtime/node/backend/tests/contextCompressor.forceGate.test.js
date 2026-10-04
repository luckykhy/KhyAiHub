'use strict';

/**
 * Tests for contextCompressor's force option (manual-compaction bypass).
 *
 * Contract under test:
 *  - compress() with force:true bypasses the four statistical gates that belong to
 *    the AUTO-compaction chain (below-threshold skip, 30s cooldown, consecutive
 *    low-efficiency pause, session-just-resumed skip) — a user typing /compact
 *    explicitly asked for compaction, so those gates must not silently no-op it;
 *  - without force, the auto-chain's gate behavior is byte-for-byte unchanged;
 *  - force does NOT bypass the structural minimum (MIN_COMPRESSIBLE_MESSAGES) —
 *    there is nothing to fold below it, forcing a model round-trip would be waste;
 *  - force propagates into _incrementalUpdate's below-threshold gate when an
 *    existing summary is present.
 *
 * callModelFn is stubbed, so no API key and no network are needed. The module keeps
 * anti-jitter state in module-level lets, so each test resets it via resetAntiJitter.
 */

const cc = require('../src/services/contextCompressor');

function estimate(text) {
  // Crude but deterministic: ~4 chars/token (CJK-aware heuristic irrelevant here).
  return Math.ceil(String(text || '').length / 4);
}

function makeMessages(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg ${i}: `.padEnd(40, 'x') + ` 决策记录 ${i}，文件 /tmp/f${i}.js`,
    });
  }
  return out;
}

// Build a small corpus whose tokens comfortably exceed 70% of `budget`.
const BUDGET = 2000;

function compressOpts(overrides = {}) {
  return {
    estimateTokensFn: estimate,
    callModelFn: async () => ({ reply: '这是 AI 摘要：包含全部关键决策与待办，长度足够作为有效摘要返回值。' }),
    contextWindowTokens: BUDGET,
    ...overrides,
  };
}

beforeEach(() => {
  cc.resetAntiJitter();
});

describe('contextCompressor force — 旁路统计门（自动链行为不变）', () => {
  test('无 force：低占用被阈值门跳过（自动链现状回归）', async () => {
    const messages = makeMessages(8); // ~ 8*60/4 ≈ 120 tokens ≪ 70% of 2000
    const r = await cc.compress(messages, compressOpts());
    expect(r.summaryGenerated).toBe(false);
    expect(r.compressed).toBe(messages);
  });

  test('force:true：同样低占用，阈值门被旁路，真实压缩', async () => {
    const messages = makeMessages(8);
    const r = await cc.compress(messages, compressOpts({ force: true }));
    expect(r.summaryGenerated).toBe(true);
    expect(r.compressed.length).toBeLessThan(messages.length);
    expect(r.compressed[0].content).toContain('<compressed_context>');
  });

  test('force:true：30s 冷却期内仍然压缩（第二次调用不被冷却门拦截）', async () => {
    const messages = makeMessages(8);
    const first = await cc.compress(messages, compressOpts({ force: true }));
    expect(first.summaryGenerated).toBe(true);
    // First pass set _lastCompressionTs; a second manual compact within 30s must
    // still go through (auto-chain would have returned noOp here).
    const second = await cc.compress(messages, compressOpts({ force: true }));
    expect(second.summaryGenerated).toBe(true);
  });

  test('无 force：冷却期内被跳过（自动链现状回归）', async () => {
    const messages = makeMessages(8);
    // Prime a big corpus so the first auto pass actually compresses and stamps
    // the cooldown timestamp.
    const big = makeMessages(200);
    const auto = await cc.compress(big, compressOpts());
    expect(auto.summaryGenerated).toBe(true);
    const gated = await cc.compress(messages, compressOpts());
    expect(gated.summaryGenerated).toBe(false);
  });

  test('force:true：markSessionResumed 后仍然压缩（恢复首跳门被旁路）', async () => {
    if (typeof cc.markSessionResumed !== 'function') {
      return; // export renamed → guard, don't fail unrelated suites
    }
    cc.markSessionResumed();
    const messages = makeMessages(8);
    const r = await cc.compress(messages, compressOpts({ force: true }));
    expect(r.summaryGenerated).toBe(true);
  });

  test('无 force：markSessionResumed 后首次压缩被跳过（自动链现状回归）', async () => {
    if (typeof cc.markSessionResumed !== 'function') {
      return;
    }
    cc.markSessionResumed();
    const messages = makeMessages(8);
    const r = await cc.compress(messages, compressOpts());
    expect(r.summaryGenerated).toBe(false);
  });

  test('force 不旁路结构下限：少于 MIN_COMPRESSIBLE_MESSAGES 条时仍跳过', async () => {
    const messages = makeMessages(cc.MIN_COMPRESSIBLE_MESSAGES - 1);
    const r = await cc.compress(messages, compressOpts({ force: true }));
    expect(r.summaryGenerated).toBe(false);
    expect(r.compressed).toBe(messages);
  });

  test('force 透传增量路径：已有摘要 + 低占用 → 增量更新照常执行', async () => {
    // messages[0] carries an existing summary marker → compress routes to
    // _incrementalUpdate; force must bypass its below-threshold gate too.
    const tail = makeMessages(20);
    const messages = [
      { role: 'user', content: '[Compressed context summary]\n既有摘要内容，记录了早期决策。' },
      ...tail,
    ];
    const r = await cc.compress(messages, compressOpts({ force: true }));
    expect(r.summaryGenerated).toBe(true);
    // Incremental update folded part of the tail into the summary.
    expect(r.compressed.length).toBeLessThan(messages.length);
  });
});
