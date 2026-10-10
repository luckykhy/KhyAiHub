'use strict';

/**
 * perfReport.test.js — 钉死会话性能叶子的聚合（token/成本/按模型分解/回合/墙钟）与
 * md/json/csv 三格式渲染。
 *
 * 为什么这支套件必须存在：文件头的核心承诺是「诚实」——khy 不记录每工具耗时/缓存命中，
 * 报告绝不无中生有；聚合公式里有一串 `||` 回退（totalTokens=0 也会掉进回退分支），这类
 * 「0 被当缺失」的语义只有测试钉住，改公式的人才不会悄悄破坏既有报表。
 *
 * 实测更正（与注释/直觉不同处，按真实语义钉死）：
 *   · `total = _num(su.totalTokens) || input+output`、`requests = _num(su.requests) || records.length`、
 *     `costUSD = _num(su.costUSD) || Σrecords` —— 显式 0 值同样掉进回退，不是只有缺失才回退。
 *   · formatPerfReport 的「绝不抛」只在 stats 为 analyzePerf 输出或非对象时成立：传入形状
 *     不对的真对象（如 {}）走 csv/md 会 TypeError，此处如实钉死边界。
 *   · transcript 里 isMeta 优先级高于 role（else-if 链）；timestamp 经 Number 强转，字符串
 *     毫秒数可用，≤0 的时间戳不参与墙钟。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const M = require('./perfReport');

// ── analyzePerf ────────────────────────────────────────────────────────

test('analyzePerf: 空输入给出全零形状，绝不抛', () => {
  const s = M.analyzePerf();
  assert.deepEqual(s.tokens, { input: 0, output: 0, total: 0 });
  assert.equal(s.requests, 0);
  assert.equal(s.costUSD, 0);
  assert.deepEqual(s.byModel, []);
  assert.deepEqual(s.turns, { user: 0, assistant: 0, meta: 0, total: 0 });
  assert.equal(s.wallClockMs, 0);
  assert.equal(s.firstAt, null);
  assert.equal(s.lastAt, null);
});

test('analyzePerf: 基本聚合 + 平均值（total 四舍五入到整数）', () => {
  const s = M.analyzePerf({
    sessionUsage: {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      requests: 3,
      costUSD: 0.3,
      records: [],
    },
  });
  assert.equal(s.avgTokensPerRequest, 500);
  assert.ok(Math.abs(s.avgCostPerRequest - 0.1) < 1e-12);
});

test('analyzePerf: 显式 0 的 total/requests/cost 也掉进 || 回退（真实语义）', () => {
  const records = [
    { provider: 'p', model: 'm', inputTokens: 10, outputTokens: 5, total: 15, costUSD: 0.2 },
    { provider: 'p', model: 'm', inputTokens: 20, outputTokens: 5, total: 25, costUSD: 0.3 },
  ];
  const s = M.analyzePerf({
    sessionUsage: { inputTokens: 30, outputTokens: 10, totalTokens: 0, requests: 0, costUSD: 0, records },
  });
  assert.equal(s.tokens.total, 40, 'totalTokens=0 → 回退 input+output');
  assert.equal(s.requests, 2, 'requests=0 → 回退 records.length');
  assert.ok(Math.abs(s.costUSD - 0.5) < 1e-12, 'costUSD=0 → 回退 Σrecords');
});

test('analyzePerf: 按 provider+model 分组聚合，total 缺字段回退 in+out', () => {
  const s = M.analyzePerf({
    sessionUsage: {
      records: [
        { provider: 'openai', model: 'gpt', inputTokens: 100, outputTokens: 20 },
        { provider: 'openai', model: 'gpt', inputTokens: 1, outputTokens: 1, total: 8, costUSD: 0.5 },
        { provider: 'deep', model: 'ds', costUSD: '0.25' },
        null,
        'junk',
      ],
    },
  });
  assert.equal(s.byModel.length, 2);
  const gpt = s.byModel.find((g) => g.model === 'gpt');
  assert.equal(gpt.requests, 2);
  assert.equal(gpt.total, 128, '首条无 total → 回退 100+20=120，次条显式 8');
  assert.equal(s.byModel.find((g) => g.model === 'ds').costUSD, 0.25, '字符串数字经 Number 强转');
});

test('analyzePerf: byModel 排序 = total 降序，平手按 model 名升序（确定性）', () => {
  const s = M.analyzePerf({
    sessionUsage: {
      records: [
        { provider: 'p', model: 'b', total: 100 },
        { provider: 'p', model: 'a', total: 100 },
        { provider: 'p', model: 'c', total: 300 },
      ],
    },
  });
  assert.deepEqual(s.byModel.map((g) => g.model), ['c', 'a', 'b']);
});

test('analyzePerf: 回合统计 meta 优先于 role；字符串时间戳参与墙钟', () => {
  const s = M.analyzePerf({
    transcript: [
      { role: 'user', timestamp: '5000' },
      { role: 'user', isMeta: true, timestamp: 1000 },
      { role: 'assistant', timestamp: 91000 },
      { role: 'system', timestamp: -5 },
      null,
    ],
  });
  assert.deepEqual(s.turns, { user: 1, assistant: 1, meta: 1, total: 2 });
  assert.equal(s.firstAt, 1000, 'meta 条目的时间戳同样参与墙钟（统计独立于 role 分支）');
  assert.equal(s.lastAt, 91000);
  assert.equal(s.wallClockMs, 90000);
});

// ── formatPerfReport ───────────────────────────────────────────────────

const baseStats = () =>
  M.analyzePerf({
    sessionUsage: {
      inputTokens: 60,
      outputTokens: 30,
      totalTokens: 90,
      requests: 2,
      costUSD: 0.0001234,
      records: [{ provider: 'openai', model: 'gpt-4o', inputTokens: 60, outputTokens: 30, total: 90, costUSD: 0.0001234 }],
    },
    transcript: [
      { role: 'user', timestamp: 1000 },
      { role: 'assistant', timestamp: 91000 },
    ],
  });

test('formatPerfReport md: 概览/表头/诚实脚注/时长格式', () => {
  const md = M.formatPerfReport(baseStats(), 'md', { sessionId: 's-1', generatedAt: '2026-09-28' });
  assert.ok(md.startsWith('# 会话性能报告'));
  assert.ok(md.includes('- 会话: `s-1`'));
  assert.ok(md.includes('- 生成时间: 2026-09-28'));
  assert.ok(md.includes('- 墙钟: 1m 30s'), '90000ms → 1m 30s');
  assert.ok(md.includes('| gpt-4o | openai | 1 | 60 | 30 | 90 | $0.0001 |'), '成本 4 位小数');
  assert.ok(md.includes('不记录每工具耗时/缓存命中'), '诚实脚注必须在');
});

test('formatPerfReport md: 无用量时会话/时间可缺省，空表打占位', () => {
  const md = M.formatPerfReport(M.analyzePerf({}), 'MD');
  assert.ok(!md.includes('- 会话:'));
  assert.ok(md.includes('(本会话尚无已记录的模型用量)'));
  assert.ok(md.includes('- 请求数: 0'), 'format 大小写不敏感，仍走 md');
});

test('formatPerfReport json: 可解析且合并 meta，tokens 结构原样', () => {
  const s = baseStats();
  const parsed = JSON.parse(M.formatPerfReport(s, 'json', { sessionId: 'abc', generatedAt: 111 }));
  assert.equal(parsed.sessionId, 'abc');
  assert.equal(parsed.generatedAt, 111);
  assert.deepEqual(parsed.tokens, { input: 60, output: 30, total: 90 });
  assert.equal(parsed.byModel[0].model, 'gpt-4o');
  const bare = JSON.parse(M.formatPerfReport(s, 'json'));
  assert.equal(bare.sessionId, '');
  assert.equal(bare.generatedAt, '');
});

test('formatPerfReport csv: 表头/数据行/TOTAL 行/6 位小数/逗号转义', () => {
  const s = baseStats();
  s.byModel[0].model = 'a,b';
  const csv = M.formatPerfReport(s, 'csv');
  const rows = csv.split('\n');
  assert.equal(rows[0], 'model,provider,requests,input_tokens,output_tokens,total_tokens,cost_usd');
  assert.ok(rows[1].startsWith('"a,b",openai,1,60,30,90,0.000123'), '含逗号单元格加引号');
  assert.equal(rows[2], `TOTAL,,2,60,30,90,${(0.0001234).toFixed(6)}`);
});

test('formatPerfReport: stats 非对象回退空聚合；形状错的真对象会抛（边界钉死）', () => {
  const md = M.formatPerfReport(null, 'md');
  assert.ok(md.includes('- 请求数: 0'));
  assert.throws(() => M.formatPerfReport({}, 'csv'), TypeError);
  assert.throws(() => M.formatPerfReport({}, 'md'), TypeError);
});

// ── isEnabled ──────────────────────────────────────────────────────────

test('isEnabled: KHY_PERF_ISSUE 默认开，off 值族关闭，null → false', () => {
  assert.equal(M.isEnabled({}), true);
  assert.equal(M.isEnabled({ KHY_PERF_ISSUE: 'off' }), false);
  assert.equal(M.isEnabled({ KHY_PERF_ISSUE: '1' }), true);
  assert.equal(M.isEnabled(null), false, 'null 不触发默认参数，与 isEnabled({}) 相反');
});
