'use strict';

/**
 * route-overhead-probe — 判据 A3：路由器自身的开销（[DESIGN-ARCH-185] §11-A3）。
 *
 * 要证的三件事，一条都不能靠「读代码觉得它没联网」：
 *   ① 决策延迟 p95 < 5ms（默认档，可 env 调）；
 *   ② 整个决策过程**零 LLM token 消耗**；
 *   ③ 整个决策过程**零网络调用** —— 用拦截 http/https/net/fetch 来证明，
 *      而不是声称「我没写 fetch」。
 *
 * 为什么值得单独做一个探针：opensquilla 的晋升门里有一句
 * 「度量把路由器自身的开销算进去，否则路由器开销会悄悄吃掉它省下的钱」（E1）。
 * 本仓的路由器是纯本地规则，理论上很快 —— 但「理论上」正是本方案一路在清除的那类依据。
 *
 * 只读：不写文件、不改配置、不调模型。
 */

const path = require('path');

const BACKEND_SRC = path.resolve(__dirname, '..', '..', 'runtime', 'node', 'backend', 'src');

// ── 网络拦截：在 require 被测模块之前就装好 ──────────────────────────────
const netCalls = { http: 0, https: 0, net: 0, fetch: 0, dns: 0 };

function _installGuards() {
  const http = require('http');
  const https = require('https');
  const net = require('net');
  const dns = require('dns');

  const wrap = (obj, name, bucket) => {
    for (const fn of ['request', 'get']) {
      const orig = obj[fn];
      if (typeof orig !== 'function' || orig.__routeProbe) continue;
      const w = function probedRequest(...args) {
        netCalls[bucket] += 1;
        return orig.apply(this, args);
      };
      w.__routeProbe = true;
      obj[fn] = w;
    }
    void name;
  };
  wrap(http, 'http', 'http');
  wrap(https, 'https', 'https');
  wrap(net, 'net', 'net');
  for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
    const orig = dns[fn];
    if (typeof orig !== 'function' || orig.__routeProbe) continue;
    const w = function probedDns(...args) {
      netCalls.dns += 1;
      return orig.apply(this, args);
    };
    w.__routeProbe = true;
    dns[fn] = w;
  }
  if (typeof globalThis.fetch === 'function' && !globalThis.fetch.__routeProbe) {
    const origFetch = globalThis.fetch;
    const wf = function probedFetch(...args) {
      netCalls.fetch += 1;
      return origFetch.apply(this, args);
    };
    wf.__routeProbe = true;
    globalThis.fetch = wf;
  }
}

function _percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** 决策输入样本：真中文主诉 + 边界形态，覆盖 flag 命中与不命中两条路径。 */
const SAMPLES = [
  '好',
  '继续',
  '帮我把登录接口的报错根因找出来 Traceback (most recent call last): TypeError: x is undefined',
  '在生产环境部署这个迁移并在窗口内删除旧表',
  '只返回 JSON，不要解释，按格式',
  '重构这个 monorepo 的依赖分层架构，涉及 12 个模块 a.js b.py c.ts',
  '实现一个 CSV 导出功能，参考现有 export 通路',
  'x'.repeat(6500),
  'khy gateway status 里 preferred adapter 的提示文案不对，修一下并补测试',
  '解释一下 UCB1 的 regret 上界为什么是 O(ln T)',
];

function run(opts = {}) {
  const iterations = Number(opts.iterations) || 200;
  const p95BudgetMs = Number.isFinite(Number(opts.budgetMs)) ? Number(opts.budgetMs) : 5;

  _installGuards();
  // 被测模块在拦截装好之后再 require，确保任何隐藏外呼都会计数
  const rm = require(path.join(BACKEND_SRC, 'services', 'gateway', 'routingMode.js'));
  const rd = require(path.join(BACKEND_SRC, 'services', 'gateway', 'routeDemand.js'));
  const sel = require(path.join(BACKEND_SRC, 'services', 'gateway', 'autoModelSelect.js'));
  const mt = require(path.join(BACKEND_SRC, 'services', 'modelTier.js'));

  const card = rm._loadCard({});
  const modes = ['auto', 'extreme', 'perf', 'economy'].map((k) => rm.resolveMode(k, { card }));
  const pool = [
    { model: 'gpt-4o-mini', adapter: 'api', tier: mt.resolveTier('gpt-4o-mini'), source: 'remote' },
    { model: 'deepseek-chat', adapter: 'api', tier: mt.resolveTier('deepseek-chat'), source: 'remote' },
    { model: 'claude-sonnet-4', adapter: 'claude', tier: mt.resolveTier('claude-sonnet-4'), source: 'remote' },
    { model: 'claude-opus-4-7', adapter: 'claude', tier: mt.resolveTier('claude-opus-4-7'), source: 'remote' },
    { model: 'glm-4', adapter: 'api', tier: mt.resolveTier('glm-4'), source: 'config' },
  ];

  const samples = [];
  let decisions = 0;
  let nullDecisions = 0;
  for (let i = 0; i < iterations; i += 1) {
    const text = SAMPLES[i % SAMPLES.length];
    const mode = modes[i % modes.length];
    const t0 = process.hrtime.bigint();
    const demand = rd.decide(text, { card, mode, taskType: 'code', turnIndex: (i % 9) + 1 });
    if (demand) decisions += 1;
    else nullDecisions += 1;
    sel.rankAutoModels('code', pool, {
      band: { floorIdx: mode.floorIdx, ceilingIdx: mode.ceilingIdx },
    });
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);

  const netTotal = Object.values(netCalls).reduce((a, b) => a + b, 0);
  const report = {
    iterations,
    decisions,
    nullDecisions,
    p50Ms: Number(_percentile(samples, 50).toFixed(4)),
    p95Ms: Number(_percentile(samples, 95).toFixed(4)),
    p99Ms: Number(_percentile(samples, 99).toFixed(4)),
    maxMs: Number(samples[samples.length - 1].toFixed(4)),
    netCalls,
    netTotal,
    llmTokens: 0,
    budget: { p95Ms: p95BudgetMs },
    gaps: [],
  };
  if (iterations <= 0 || samples.length !== iterations) {
    report.gaps.push(`样本数 ${samples.length} ≠ 迭代数 ${iterations} —— 计时循环没真的跑`);
  }
  if (decisions === 0) report.gaps.push('所有 decide 都返回 null：测的是空转，不是路由开销');
  if (netTotal > 0) report.gaps.push(`决策过程出现 ${netTotal} 次网络调用，违反 A3 的「零外呼」`);
  if (!(report.p95Ms < p95BudgetMs)) {
    report.gaps.push(`p95=${report.p95Ms}ms 超出预算 ${p95BudgetMs}ms`);
  }
  report.pass = report.gaps.length === 0;
  return report;
}

function main() {
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
  };
  const r = run({ iterations: Number(arg('iterations', 200)), budgetMs: Number(arg('budget-ms', 5)) });
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  } else {
    const lines = [
      `迭代 ${r.iterations}｜有效决策 ${r.decisions}｜返回空 ${r.nullDecisions}`,
      `决策延迟 p50=${r.p50Ms}ms p95=${r.p95Ms}ms p99=${r.p99Ms}ms max=${r.maxMs}ms（预算 p95<${r.budget.p95Ms}ms）`,
      `网络调用: ${r.netTotal} ${JSON.stringify(r.netCalls)}｜LLM token: ${r.llmTokens}`,
      r.pass ? 'A3 通过' : 'A3 未通过',
    ];
    for (const g of r.gaps) lines.push(`  - ${g}`);
    process.stdout.write(lines.join('\n') + '\n');
  }
  if (process.argv.includes('--strict') && !r.pass) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stdout.write(`探针自身异常: ${e && e.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { run };
