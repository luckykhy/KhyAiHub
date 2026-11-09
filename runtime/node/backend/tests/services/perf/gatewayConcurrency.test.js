'use strict';

/**
 * gatewayConcurrency.test.js — 网关并发压测套件（进程内，零网络零 token）。
 *
 * 落点选 tests/services/perf/ 而不是新建 tests/perf/：同族 perf 测试已在此
 * （perfReport.test.js），再开一个 perf 目录就是仓库里第二个同名目录——
 * 顶层归属问 [DESIGN-LAY-005]，答案跟随现状。
 *
 * 与 k6 的分工：[DESIGN-TEST-001] §10 指定 k6 为 HTTP 层负载工具（全仓尚无实际
 * 调用），本套件补它覆盖不到的那层——进程内并发正确性、适配器注入失败后的降级
 * 路径、空闲超时的诚实上报。并发性用「同时在飞请求数」证明，不用墙钟倒推；
 * 计时只做统计不断言阈值，CI 机器抖动不该让这套件误报。
 *
 * 不新增 package.json 脚本：test:node 已 glob tests/ 下全部 node:test 套件，
 * 另加入口会让同一批文件跑两遍。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// ── 零外呼用计数器证明，不靠在注释里声称（scripts/ci/route-overhead-probe.js 同款） ──
// 装在 require 之前：http(s) 的 request/get 是调用期属性查找，后装也能拦到。
const _netCalls = { http: 0, https: 0, net: 0, dns: 0, fetch: 0 };
const _netRestores = [];
(function installNetworkCounters() {
  const wrap = (obj, name, bucket) => {
    const orig = obj[name];
    if (typeof orig !== 'function' || orig.__gwconc) return;
    const w = function counted(...args) {
      _netCalls[bucket] += 1;
      return orig.apply(this, args);
    };
    w.__gwconc = true;
    obj[name] = w;
    _netRestores.push(() => { obj[name] = orig; });
  };
  for (const mod of ['http', 'https']) {
    const m = require(mod);
    for (const fn of ['request', 'get']) wrap(m, fn, mod);
  }
  const net = require('net');
  for (const fn of ['connect', 'createConnection']) wrap(net, fn, 'net');
  const dns = require('dns');
  for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6']) wrap(dns, fn, 'dns');
  if (typeof globalThis.fetch === 'function') wrap(globalThis, 'fetch', 'fetch');
})();

// 工具回路的门控必须在 require 之前落定——部分门在加载期读取（同
// tests/toolUseLoop.pureGreeting.test.js 的做法）。原值先快照，after 里还原真原值，
// 不还原自己刚写进去的那个。
const _ENV_KEYS = [
  'KHY_TOOL_CAP_PROBE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_FALLBACK_MODEL',
  'KHY_TASK_CAPABILITY_GATE', 'KHY_EXEC_APPROVAL', 'KHY_TOOL_LOOP_RECOVERY_DELAY_MS',
  'GATEWAY_WALL_CLOCK_TIMEOUT_MS', 'GATEWAY_ACTIVITY_PULSE_MS',
];
const _ORIGINAL_ENV = {};
for (const k of _ENV_KEYS) _ORIGINAL_ENV[k] = process.env[k];
process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';
process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS = '1';

const h = require('../../gateway/_ocrGatewayHarness');
const toolUseLoop = require('../../../src/services/toolUseLoop');

const env = h.envSandbox(_ENV_KEYS);
// 每次请求恰好一次 adapter 调用：关掉会额外发一次探测的门，调用数才可数。
const GATEWAY_ENV_OFF = { KHY_TOOL_CAP_PROBE: 'off', KHY_GLM_VISION_MODEL: 'off', KHY_VISION_FALLBACK_MODEL: '' };
const LOOP_ENV = { KHY_TASK_CAPABILITY_GATE: 'false', KHY_EXEC_APPROVAL: 'off', KHY_TOOL_LOOP_RECOVERY_DELAY_MS: '1' };

const CONCURRENCY = 8;
// 普通用例的失败上限：把「挂死」变成响亮的失败，而不是挂住 CI。
const TEST_TIMEOUT_MS = 20000;
// 负载敏感用例的失败上限。这四个用例（回路并发、注入 chat 失败、挂死、持续出流）的期望
// 时长由**真实睡眠**或**每回合子进程**撑起来，没法靠调小参数压缩：挂死/出流两例必须跨过
// 生产侧固定 5s 看门狗检查点（aiGatewayGenerateMethod.js:1042），两个回路例每回合要付
// changeWatch 的 3–5 个 git 派生（changeWatchService.js:87-88 记 Windows 上各
// 110–300ms）。门禁机重度 CPU 饥饿时这些墙钟会成倍拉长——同一次门禁里一个 ~1s 的存量
// 用例跑到了 95.9s——20s 对本文件只有 2.6–4.5 倍余量，会把「机器慢」误报成「用例挂死」；
// 60s 是 8–14 倍，真挂死仍然会被钉死。
const LOAD_SENSITIVE_TIMEOUT_MS = 60000;
// 预热上限同理：首次 runToolUseLoop 要探测全部工具的可用性（where / python / git 等
// 阻塞子进程，src/tools/index.js:1148 自己记的是 ~1.4s，慢机器上远超这个数）。
const WARMUP_TIMEOUT_MS = 180000;
// 挂死用例的空闲预算。看门狗检查间隔固定 5s（aiGatewayGenerateMethod.js:1042），
// 所以预算再小也只会在第一个 5s 检查点兑现，这就是该用例 ~5s 的由来。
const IDLE_BUDGET_MS = 3000;
const PULSE_MS = 2000;

let _netBaseline = null;

before(async () => {
  env.save();
  env.set({ ...GATEWAY_ENV_OFF, ...LOOP_ENV });
  await warmUp();
  // 基线取在预热之后：只钉「测量段」零外呼，预热期的子系统自探测不算测量。
  _netBaseline = { ..._netCalls };
}, { timeout: WARMUP_TIMEOUT_MS });

after(() => {
  const delta = Object.keys(_netCalls).reduce((sum, k) => sum + (_netCalls[k] - _netBaseline[k]), 0);
  for (const restore of _netRestores) restore();
  assert.equal(delta, 0, `本套件测量段应零网络外呼，实测 ${delta} 次`);
  for (const [k, v] of Object.entries(_ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// 两个子系统都有一次性懒初始化（网关的 mesh / 插件，回路的工具注册表探测）。
// 不先预热，测到的就是初始化而不是稳态并发。
async function warmUp() {
  const rec = h.makeRecordingAdapter({ content: '预热' });
  h.wireSingle(rec);
  await h.gw.generate('预热请求', { model: 'text-only-model' });
  const chat = async () => ({ reply: substantiveReply('预热'), stopReason: 'stop', provider: 'mock', model: 'mock-model' });
  await toolUseLoop.runToolUseLoop('预热任务', { chat, maxIterations: 5 });
}

// ── 栅栏：等约定数量的请求都在飞才放行——并发性由栅栏保证，不靠固定 sleep 猜时序 ──
// 兜底死线防「有请求永不到场」把用例挂死；真到不了，断言会带着在飞数响亮失败。
function makeBarrier(expected, deadlineMs = 5000) {
  let arrived = 0;
  let open = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deadline = setTimeout(() => { open = true; release(); }, deadlineMs);
  return {
    arrive: () => {
      arrived += 1;
      if (!open && arrived >= expected) {
        open = true;
        clearTimeout(deadline);
        release();
      }
    },
    wait: () => gate,
  };
}

function makeFlightProbe() {
  const state = { inFlight: 0, maxInFlight: 0 };
  return {
    state,
    enter: () => {
      state.inFlight += 1;
      if (state.inFlight > state.maxInFlight) state.maxInFlight = state.inFlight;
    },
    leave: () => { state.inFlight -= 1; },
  };
}

// 在既有假适配器外包一层计数+栅栏，适配器本身不动。
function wrapAdapter(adapter, { probe = null, barrier = null, counter = null } = {}) {
  const inner = adapter.generate;
  adapter.generate = async (prompt, o) => {
    if (counter) counter.n += 1;
    if (probe) probe.enter();
    try {
      if (barrier) {
        barrier.arrive();
        await barrier.wait();
      }
      return await inner(prompt, o);
    } finally {
      if (probe) probe.leave();
    }
  };
  return adapter;
}

// 工具回路对「无工具的实质答复」有 >=400 非空白字符的单回合收尾捷径
// （src/services/tool/toolUseLoopCore.js:5551，concludeNow 判定在 5547-5553）；
// 异质长文才行，重复句会被退化检测拦下再审一轮。
function substantiveReply(marker) {
  return [
    `${marker}：已盘点入口与层级关系，路由器按命令名分派到各 handler。`,
    '服务层承载 AI 网关与领域服务，网关统一多供应商调用与失败降级。',
    '数据落点分项目级与用户级两处，目录语义由登记表统一寻址。',
    '测试树按 src 镜像组织，node:test 与 jest 并存且入口互不重叠。',
    '构建产物统一落 entries/ 下，忽略规则由登记表派生而非手写两份。',
    '启动链分子系统与后端两层，Python 侧只负责拉起 Node 进程。',
    '别名表把中文拼音映射到规范命令名，路由器再按规范名分派。',
    '会话看门狗只上报不杀进程，真同步死循环由提交前静态体检拦截。',
    '轨迹回放按 sessionId 分目录落盘，审计通道不压缩不裁剪。',
    '规则门成员资格从登记表派生，不在门脚本里硬编码第二份名单。',
    '版本三条轨道各自独立递增，组内一致组间刻意不同。',
    '命令面棘轮只降不升，新增一条须先退役一条。',
    '材料生成只用仓内工具链，口径要改只改契约文件。',
    '多机协作靠租约协调，任务状态真源随仓库入版本库。',
    '结论：分层清晰、边界明确，上述各点可直接采纳为现状描述。',
  ].join('');
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    avgMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1],
  };
}

// 只钉数学不变量：绝不为「快」设绝对阈值，那正是 CI 抖动的误报来源。
function assertStatsSane(stats) {
  assert.equal(stats.n, CONCURRENCY, '每个请求都要有一样本');
  for (const v of [stats.avgMs, stats.minMs, stats.p50Ms, stats.p95Ms, stats.maxMs]) {
    assert.ok(Number.isFinite(v) && v >= 0, `统计量应为有限非负数，得到 ${v}`);
  }
  assert.ok(stats.minMs <= stats.p50Ms && stats.p50Ms <= stats.p95Ms && stats.p95Ms <= stats.maxMs);
  assert.ok(stats.minMs <= stats.avgMs && stats.avgMs <= stats.maxMs);
}

function report(t, label, stats, okCount) {
  const pct = ((okCount / CONCURRENCY) * 100).toFixed(0);
  t.diagnostic(
    `${label} 并发 ${CONCURRENCY}：成功率 ${pct}%（${okCount}/${CONCURRENCY}），`
    + `avg=${stats.avgMs.toFixed(1)}ms p50=${stats.p50Ms.toFixed(1)}ms `
    + `p95=${stats.p95Ms.toFixed(1)}ms max=${stats.maxMs.toFixed(1)}ms`,
  );
}

// 逐请求计时：t0 取在发起前，t1 取在各自 promise 落定时，合计才有 avg/p50/p95。
function timedCall(fn, samples) {
  const t0 = process.hrtime.bigint();
  return fn().then((r) => {
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    return r;
  });
}

describe('aiGateway.generate — 进程内并发', () => {
  test('并发请求全部成功，在飞数达到并发数', { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const probe = makeFlightProbe();
    const barrier = makeBarrier(CONCURRENCY);
    const rec = h.makeRecordingAdapter({ content: '并发答复' });
    wrapAdapter(rec.adapter, { probe, barrier });
    h.wireSingle(rec);

    const samples = [];
    const jobs = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      jobs.push(timedCall(() => h.gw.generate(`并发请求 ${i}`, { model: 'text-only-model' }), samples));
    }
    const results = await Promise.all(jobs);

    const ok = results.filter((r) => r.success).length;
    assert.equal(ok, CONCURRENCY, '零失败才算成功率 100%');
    assert.equal(probe.state.maxInFlight, CONCURRENCY, '并发性由在飞数证明，不靠墙钟倒推');
    assert.ok(results.every((r) => r.content === '并发答复'));

    const stats = summarize(samples);
    assertStatsSane(stats);
    report(t, 'generate', stats, ok);
  });

  test('注入首选通道失败：请求级联降级，全部由下一通道承接', { timeout: TEST_TIMEOUT_MS }, async (t) => {
    const probe = makeFlightProbe();
    const barrier = makeBarrier(CONCURRENCY);
    const failingCalls = { n: 0 };
    const backupCalls = { n: 0 };
    // 通道名带排序意图：默认路由打分对两个测试键完全打平（basePriority 999、同额
    // penalty），最终按 adapter key 的 localeCompare 定序——要断言「先试的通道失败后
    // 降级」，失败的通道就必须排在前面。下面 failingCalls === N 的断言就是这条定序
    // 的哨兵：真变了会响亮失败，不会静默降级成「备用通道直接作答」。
    const failing = wrapAdapter(
      h.makeRejectAdapter({ name: 'aaa-fail', provider: 'aaa-fail', activeModel: 'm' }),
      { counter: failingCalls },
    );
    const backup = h.makeRecordingAdapter({ name: 'zzz-backup', provider: 'zzz-backup', activeModel: 'm', content: '兜底答复' });
    wrapAdapter(backup.adapter, { probe, barrier, counter: backupCalls });
    h.wireGateway([
      { key: 'aaa-fail', adapter: failing, priority: 0 },
      { key: 'zzz-backup', adapter: backup.adapter, priority: 1 },
    ], { key: 'aaa-fail', activeModel: 'm' });

    const samples = [];
    const jobs = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      jobs.push(timedCall(() => h.gw.generate(`降级请求 ${i}`, { model: 'm' }), samples));
    }
    const results = await Promise.all(jobs);

    const ok = results.filter((r) => r.success).length;
    assert.equal(ok, CONCURRENCY, '降级后仍应全部成功');
    assert.equal(failingCalls.n, CONCURRENCY, '每个请求都先试了首选通道');
    assert.equal(backupCalls.n, CONCURRENCY, '每个请求都落到了兜底通道');
    assert.equal(probe.state.maxInFlight, CONCURRENCY, '兜底通道同样要扛住并发');
    assert.ok(results.every((r) => /兜底答复/.test(String(r.content))), '答复必须来自兜底通道');

    const stats = summarize(samples);
    assertStatsSane(stats);
    report(t, '级联降级', stats, ok);
  });

  test('注入全部通道失败：不伪装成功，错误文案带问题与纠正命令', { timeout: TEST_TIMEOUT_MS }, async () => {
    h.wireSingle(h.makeRejectAdapter());

    const res = await h.gw.generate('全通道失败请求', { model: 'gpt-4o' });

    assert.equal(res.success, false, '通道全失败时必须报失败，不能返回空内容冒充成功');
    assert.ok(res.errorType, '失败要被归类，不能只有一个笼统 error');
    assert.match(String(res.content), /诊断/, '要给出确定性诊断');
    assert.match(String(res.content), /khy gateway model/, '要给出用户能执行的纠正动作');
  });
});

describe('runToolUseLoop — 进程内并发', () => {
  test('并发回合全部完成，在飞数达到并发数', { timeout: LOAD_SENSITIVE_TIMEOUT_MS }, async (t) => {
    const probe = makeFlightProbe();
    const barrier = makeBarrier(CONCURRENCY);
    let chatCalls = 0;
    const chat = async () => {
      chatCalls += 1;
      probe.enter();
      try {
        barrier.arrive();
        await barrier.wait();
        return { reply: substantiveReply('回合'), stopReason: 'stop', provider: 'mock', model: 'mock-model' };
      } finally {
        probe.leave();
      }
    };

    const samples = [];
    const jobs = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      jobs.push(timedCall(() => toolUseLoop.runToolUseLoop(`压测任务 ${i}`, { chat, maxIterations: 5 }), samples));
    }
    const results = await Promise.all(jobs);

    assert.ok(chatCalls >= CONCURRENCY, '每个回合至少问过模型一次');
    assert.equal(probe.state.maxInFlight, CONCURRENCY, '并发性由在飞数证明，不靠墙钟倒推');
    assert.ok(results.every((r) => /回合：已盘点入口与层级关系/.test(String(r.finalResponse))), '每个回合都要交付自己的答复');
    assert.ok(results.every((r) => Array.isArray(r.toolCallLog) && r.toolCallLog.length === 0), '纯文本回合零工具派发');

    const stats = summarize(samples);
    assertStatsSane(stats);
    report(t, 'toolUseLoop', stats, results.length);
  });

  test('注入 chat 失败：每个并发回合都拿到诚实的错误文案，不返回空白', { timeout: LOAD_SENSITIVE_TIMEOUT_MS }, async () => {
    const scripts = [
      { errorType: 'auth', expect: /认证失败[\s\S]*API Key/ },
      { errorType: 'rate_limit', expect: /限流[\s\S]*重试/ },
    ];
    const jobs = [];
    for (const s of scripts) {
      for (let i = 0; i < CONCURRENCY / 2; i++) {
        const chat = async () => ({ reply: '', errorType: s.errorType, stopReason: 'error', provider: 'mock' });
        jobs.push(toolUseLoop.runToolUseLoop(`失败任务 ${s.errorType} ${i}`, { chat, maxIterations: 3 }).then((r) => ({ s, r })));
      }
    }
    const settled = await Promise.all(jobs);

    for (const { s, r } of settled) {
      assert.ok(String(r.finalResponse || '').length > 0, `${s.errorType} 失败不许交白卷`);
      assert.match(String(r.finalResponse), s.expect, `${s.errorType} 的文案要说清问题与下一步`);
    }
  });
});

describe('网关空闲超时（规则 3）', () => {
  test('适配器挂死：有界终止并上报超时原因，等待期有进度脉冲', { timeout: LOAD_SENSITIVE_TIMEOUT_MS }, async () => {
    env.set({ GATEWAY_WALL_CLOCK_TIMEOUT_MS: String(IDLE_BUDGET_MS), GATEWAY_ACTIVITY_PULSE_MS: String(PULSE_MS) });
    try {
      const hang = {
        detect: () => true,
        generate: () => new Promise(() => {}), // 永不 resolve：只应被看门狗收掉
        getStatus: () => ({ name: 'hangchan', available: true, activeModel: 'hang-model' }),
        listModels: async () => [],
      };
      h.wireSingle(hang);

      const statuses = [];
      const res = await h.gw.generate('挂死请求', {
        model: 'hang-model',
        onChunk: (c) => { if (c && c.type === 'status') statuses.push(String(c.text || '')); },
      });

      assert.equal(res.success, false, '挂死必须收口，不能假装成功');
      assert.equal(res.errorType, 'timeout');
      assert.match(String(res.content), /超时/, '要说明是超时收的口');
      assert.match(String(res.content), /空闲保护|idle/, '要说明触发的是空闲保护');
      assert.ok(
        statuses.some((s) => /已耗时 \d+s/.test(s)),
        `等待中要有进度信号，实际状态：${JSON.stringify(statuses)}`,
      );
      assert.ok(statuses.some((s) => /无推进/.test(s)), '终止时要说明空闲了多久');
    } finally {
      env.set({ GATEWAY_WALL_CLOCK_TIMEOUT_MS: undefined, GATEWAY_ACTIVITY_PULSE_MS: undefined });
    }
  });

  test('适配器持续出流：空闲计时被活动重置，请求不被杀', { timeout: LOAD_SENSITIVE_TIMEOUT_MS }, async () => {
    env.set({ GATEWAY_WALL_CLOCK_TIMEOUT_MS: String(IDLE_BUDGET_MS), GATEWAY_ACTIVITY_PULSE_MS: String(PULSE_MS) });
    try {
      const streamer = {
        detect: () => true,
        generate: async (_p, o) => {
          // 12 × 500ms：跨过 5s 看门狗检查点，靠 chunk 活动续命。
          for (let i = 0; i < 12; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if (o && typeof o.onChunk === 'function') o.onChunk({ type: 'content', text: `chunk-${i}` });
          }
          return { success: true, content: '流式完成', provider: 'stream', adapter: 'stream', model: 'stream-model' };
        },
        getStatus: () => ({ name: 'streamchan', available: true, activeModel: 'stream-model' }),
        listModels: async () => [],
      };
      h.wireSingle(streamer);

      const res = await h.gw.generate('流式请求', { model: 'stream-model' });

      assert.equal(res.success, true, '持续出流的请求必须活过空闲预算（活动式超时，不是硬死线）');
      assert.equal(res.content, '流式完成');
    } finally {
      env.set({ GATEWAY_WALL_CLOCK_TIMEOUT_MS: undefined, GATEWAY_ACTIVITY_PULSE_MS: undefined });
    }
  });
});
