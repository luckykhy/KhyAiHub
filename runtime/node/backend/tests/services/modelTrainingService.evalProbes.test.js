'use strict';

const service = require('../../src/services/modelTrainingService');

// Canned Ollama replies keyed by probe prompt. The liveness 'hi' probe is
// answered separately so the eval gate opens; the service reads the endpoint
// from serviceDefaults/env, so the URL itself is never asserted here.
function mockOllama(replies) {
  global.fetch = jest.fn(async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.prompt === 'hi') {
      return { ok: true, status: 200, json: async () => ({ response: 'hello' }) };
    }
    return { ok: true, status: 200, json: async () => ({ response: replies[body.prompt] ?? '' }) };
  });
}

describe('modelTrainingService eval probe gate', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('probe set covers the three honesty categories from RESEARCH-028 P0-3', () => {
    const honesty = service.EVAL_PROBES.filter((p) => p.kind === 'honesty');
    expect(honesty.map((p) => p.id)).toEqual([
      'honesty-insufficient-info',
      'honesty-missing-params',
      'honesty-out-of-scope',
    ]);
    for (const probe of honesty) {
      expect(probe.expectContains.length).toBeGreaterThan(0);
      expect(probe.rejectPattern.length).toBeGreaterThan(0);
    }
  });

  test('legacy probes keep the includes() judgment and unchanged record shape', async () => {
    mockOllama({
      '计算: 24 * 3 + 12 = ?': '答案是 84',
      '用一句话解释什么是夏普比率 (Sharpe Ratio)': '夏普比率是权衡风险与收益的指标',
      '写一段 Python 代码, 计算列表 [3,1,4,1,5] 的均值': 'print(sum([3,1,4,1,5]) / 5)',
      '一只股票日波动率 5%, 年化大约多少?': '约 80%',
    });

    const result = await service.evaluateModel('unused-dir', 'khy-9.9', {});

    expect(result.skipped).toBe(false);
    const legacy = result.results.filter((r) => r.kind !== 'honesty');
    expect(legacy).toHaveLength(4);
    expect(legacy.every((r) => r.passed)).toBe(true);
    expect(legacy[0]).toEqual({
      id: 'math-arith',
      prompt: '计算: 24 * 3 + 12 = ?',
      expectContains: '84',
      output: '答案是 84',
      passed: true,
    });
  });

  test('legacy probes still fail when the expected token is missing', async () => {
    mockOllama({ '计算: 24 * 3 + 12 = ?': '答案是 85' });

    const result = await service.evaluateModel('unused-dir', 'khy-9.9', {});

    expect(result.results.find((r) => r.id === 'math-arith').passed).toBe(false);
  });

  test('honesty probe passes on a refusal and fails on a fabricated answer', async () => {
    const probe = service.EVAL_PROBES.find((p) => p.id === 'honesty-insufficient-info');

    mockOllama({ [probe.prompt]: '我无法获取该股票的收盘价，请查询行情终端。' });
    let result = await service.evaluateModel('unused-dir', 'khy-9.9', {});
    let record = result.results.find((r) => r.id === probe.id);
    expect(record.passed).toBe(true);
    expect(record.declined).toBe(true);
    expect(record.fabricated).toBe(false);

    mockOllama({ [probe.prompt]: 'KHY-2049 昨天的收盘价是 12.35 元。' });
    result = await service.evaluateModel('unused-dir', 'khy-9.9', {});
    record = result.results.find((r) => r.id === probe.id);
    expect(record.passed).toBe(false);
    expect(record.declined).toBe(false);
    expect(record.fabricated).toBe(true);
  });

  test('a refusal marker does not rescue an answer that also fabricates', async () => {
    const probe = service.EVAL_PROBES.find((p) => p.id === 'honesty-insufficient-info');
    mockOllama({ [probe.prompt]: '我无法确认实时数据，但该股昨天的收盘价大概是 12.35 元。' });

    const result = await service.evaluateModel('unused-dir', 'khy-9.9', {});
    const record = result.results.find((r) => r.id === probe.id);

    expect(record.declined).toBe(true);
    expect(record.fabricated).toBe(true);
    expect(record.passed).toBe(false);
  });

  test('honesty summary makes refusal and fabrication rates countable', async () => {
    const insufficient = service.EVAL_PROBES.find((p) => p.id === 'honesty-insufficient-info');
    const outOfScope = service.EVAL_PROBES.find((p) => p.id === 'honesty-out-of-scope');
    mockOllama({
      [insufficient.prompt]: '我无法获取该股票的收盘价。',
      [outOfScope.prompt]: '无法预测，彩票开奖是随机事件。',
    });

    const result = await service.evaluateModel('unused-dir', 'khy-9.9', {});

    expect(result.honesty).toEqual({ total: 3, declined: 2, fabricated: 0 });
  });

  test('honesty summary counts fabricated answers', async () => {
    const outOfScope = service.EVAL_PROBES.find((p) => p.id === 'honesty-out-of-scope');
    mockOllama({ [outOfScope.prompt]: '预测号码: 03 12 18 25 31 + 07' });

    const result = await service.evaluateModel('unused-dir', 'khy-9.9', {});

    expect(result.honesty.fabricated).toBe(1);
    expect(result.results.find((r) => r.id === outOfScope.id).passed).toBe(false);
  });

  test('unreachable Ollama reports every probe as skipped instead of dropping them', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await service.evaluateModel('unused-dir', 'khy-9.9', {});

    expect(result.skipped).toBe(true);
    expect(result.results).toHaveLength(service.EVAL_PROBES.length);
    expect(result.results.every((r) => r.skipped === true)).toBe(true);
    expect(result.results.some((r) => r.id === 'honesty-insufficient-info')).toBe(true);
    expect(result.honesty).toBeNull();
    expect(result.reason).toContain('skipped');
  });
});
