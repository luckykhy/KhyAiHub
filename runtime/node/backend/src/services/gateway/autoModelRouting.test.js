'use strict';

/**
 * autoModelRouting 的 turnId 记账路径测试 [DESIGN-ARCH-185] §3.5/§6.1。
 *
 * 这条测的不是「函数返回什么」，而是**写出去的字节能不能被 route-replay 连回来** ——
 * join key 的全部意义就在这一环。单测里各测各的写入与读取，会双双通过而线上依然连不上号。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const amr = require('./autoModelRouting');
// gateway → services → src → backend → node → runtime → 仓根 = 上 6 层。
// （同一类错误本次落地已犯三次，故把链条写出来而不是留个数字。）
const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
const REPLAY = path.join(REPO, 'scripts', 'ci', 'route-replay.js');

function _env(file) {
  // 只重定向落盘位置；门控保持默认开（关着写不出东西，测试就成了自证）。
  return { KHY_AUTO_MODEL_OBSERVE_FILE: file, KHY_AUTO_MODEL_OBSERVE: '1' };
}

test('beginTurn 给同 session 的连续轮次不同 id，且不同 session 不串号', () => {
  const a1 = amr.beginTurn({ sessionId: 'S1' });
  const a2 = amr.beginTurn({ sessionId: 'S1' });
  const b1 = amr.beginTurn({ sessionId: 'S2' });
  assert.notStrictEqual(a1, a2);
  assert.notStrictEqual(a1, b1);
  assert.match(a1, /^.+:S1:1$/);
  assert.match(a2, /^.+:S1:2$/);
  assert.ok(amr.openTurnCount() >= 3);
});

test('beginTurn 不抛：入参畸形也要给出可用于 join 的 id', () => {
  for (const junk of [null, undefined, 42, 'x']) {
    const id = amr.beginTurn(junk);
    assert.strictEqual(typeof id, 'string');
    assert.ok(id.length > 0);
  }
});

test('select + outcome 写进同一 turnId 后，route-replay 能 join 回一轮', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-turn-'));
  const file = path.join(dir, 'auto-route.jsonl');
  const env = _env(file);
  const turnId = amr.beginTurn({ sessionId: 'JOIN' });

  amr.observeSelection(
    {
      turnId,
      mode: 'economy',
      taskType: 'code',
      legacy: { adapter: 'api', model: 'old' },
      ranked: [{ adapter: 'api', model: 'gpt-4o-mini', tier: 'T3', status: 'active' }],
      skipped: [],
      demand: { tier: 'T3', demand: 0.12, flags: [], admitted: true, reasons: ['琐碎轮次'] },
    },
    env
  );
  amr.observeOutcome(
    {
      turnId,
      ok: true,
      mode: 'economy',
      picked: { adapter: 'api', model: 'gpt-4o-mini' },
      priceState: 'priced',
      costUSD: 0.0042,
      tokens: { i: 20000, o: 2000 },
      latencyMs: 812,
    },
    env
  );
  amr.observeFailure({ turnId, adapter: 'claude', model: 'opus', errorType: 'rate_limit' }, env);

  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 3, '三类事件都应落在同一 turnId 下');
  for (const l of lines) assert.strictEqual(l.turnId, turnId, '落盘的 turnId 与 beginTurn 返回值不一致');
  assert.ok(lines.every((l) => l.pid), 'pid 必须存在，否则跨进程撞号无法区分');

  // 关键一步：让**另一个进程**（重放工具）去读，证明 join 不依赖内存态
  const out = execFileSync(process.execPath, [REPLAY, '--file', file], {
    cwd: REPO, encoding: 'utf8', timeout: 30000,
  });
  assert.match(out, /可 join 1/);
  assert.match(out, /mode=economy: n=1 ok=1 fail=0/);
  assert.match(out, /合计 0\.00420/);
  assert.match(out, /GAP/); // 只有 1 轮，A9 基线必然报缺样本 —— 不许它装作体检通过
});

test('observeOutcome 无 turnId 时不写（宁缺毋假）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-noturn-'));
  const file = path.join(dir, 'auto-route.jsonl');
  const env = _env(file);
  amr.observeOutcome({ ok: true, costUSD: 1 }, env);
  fs.writeFileSync(file, '', 'utf8');
  amr.observeOutcome({ ok: true, costUSD: 1 }, env);
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), '');
});

test('§5.6 softFail 必须真的落盘（否则 route-replay 的那一列是恒 0 的假绿）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-softfail-'));
  const file = path.join(dir, 'auto-route.jsonl');
  const env = _env(file);
  const t1 = amr.beginTurn({ sessionId: 'SF' });
  const t2 = amr.beginTurn({ sessionId: 'SF' });

  amr.observeSelection(
    {
      turnId: t1, mode: 'perf', softFail: '档位卡解析失败(请求档=ghost)，落 perf',
      legacy: { adapter: 'api', model: 'a' },
      ranked: [{ adapter: 'api', model: 'a', tier: 'T1' }], skipped: [],
    },
    env
  );
  amr.observeSelection(
    { turnId: t2, mode: 'perf', legacy: { adapter: 'api', model: 'b' }, ranked: [], skipped: [] },
    env
  );

  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].softFail, '档位卡解析失败(请求档=ghost)，落 perf');
  assert.strictEqual(lines[1].softFail, null, '没发生时必须是 null，不能是 undefined/空串混用');
});

test('记账路径绝不抛：坏入参不得冒泡到生成主路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-junk-'));
  const file = path.join(dir, 'auto-route.jsonl');
  const env = _env(file);
  assert.doesNotThrow(() => amr.observeSelection(null, env));
  assert.doesNotThrow(() => amr.observeSelection({ legacy: null }, env));
  assert.doesNotThrow(() => amr.observeFailure(null, env));
  assert.doesNotThrow(() => amr.observeOutcome(null, env));
  // 落盘目录不可写时也必须静默
  assert.doesNotThrow(() =>
    amr.observeOutcome({ turnId: 'x', ok: true }, { ...env, KHY_AUTO_MODEL_OBSERVE_FILE: '.' })
  );
});

// ── [DESIGN-ARCH-185] §5.5 升档 / §5.6 弃权：rank 这一层的可达性 ────────────────
// 这两条此前**只有叶子级测试**（applyEscalation 收手工构造的 ctx），rank 完全没测。
// 于是「rank 自己算出了 margin，却从不传给 applyEscalation」这种断线可以长期全绿存在
// —— 半个都有测试，中间那道接缝没有。
const RANK_ENV = {
  KHY_AUTO_MODEL_HEALTH_AWARE: '1',
  KHY_ROUTING_MODES: '1',
  GATEWAY_ROUTING_MODE: 'auto',
};
function probeGw(models) {
  return {
    _adapters: [{ key: 'rankprobe', enabled: true, available: true }],
    listModels: async () => models.map((m) => ({ model: m })),
  };
}

test('§5.5 rank 把可得的 margin 传进升档：低差值会真的抬档，且不越 ceiling', async () => {
  const rm = require('./routingMode');
  const mode = rm.resolveMode('auto', { env: RANK_ENV });
  assert.ok(
    mode && mode.escalateOn.includes('lowMargin'),
    '卡里 auto 不再声明 lowMargin —— 本测试的前置不成立'
  );
  // 'rank-probe-a' → T2（未识别名默认档），'zzz-sonnet-4' → T1。
  // conversation 档的偏好是 T2 ⇒ 头名是 T2，所以 lowMargin 抬到 T1 后收紧应剩 T1。
  const gw = probeGw(['rank-probe-a', 'zzz-sonnet-4']);
  await amr.refreshPool(gw, RANK_ENV);

  const fired = amr.rank(
    gw,
    'conversation',
    { mode, escalate: { demand: 0.9, margin: 0.001 } },
    RANK_ENV
  );
  assert.ok(fired, 'rank 应返回结果（门关/池空才是 null）');
  assert.strictEqual(fired.ranked.length, 1, `低差值升档后应只剩 T1，实际 ${JSON.stringify(fired.ranked.map((r) => r.tier))}`);
  assert.strictEqual(fired.ranked[0].tier, 'T1');
  assert.ok(fired.escalatedFrom, 'escalatedFrom 必须留痕，否则样本里看不出发生过升档');
  assert.strictEqual(fired.escalatedFrom.tier, 'T2');
  assert.match(String(fired.escalateReason), /lowMargin/);

  // 对照：调用方没给 margin 时，rank 补的是**自己算的那个**（当前为 null）→ 不该触发。
  // 这一行同时防止我把修复写成「无条件抬档」。
  const silent = amr.rank(gw, 'conversation', { mode, escalate: { demand: 0.9 } }, RANK_ENV);
  assert.strictEqual(silent.escalatedFrom, null, 'margin 不可得时不得凭空升档');
});

test('§5.5/§5.6 的可达性闸链：margin 只有走连续打分才存在（价表+λ 是两个前置）', async () => {
  const rm = require('./routingMode');
  const mode = rm.resolveMode('auto', { env: RANK_ENV });
  const gw = probeGw(['rank-probe-a', 'zzz-sonnet-4']);
  await amr.refreshPool(gw, RANK_ENV);
  const r = amr.rank(gw, 'conversation', { mode, escalate: { demand: 0.9 } }, RANK_ENV);

  // 实测：score 只在 useCost 分支里附着，而 useCost 要求 λ 有限 ∈[0,1] 且有 priceOf；
  // λ 又要求「池内价格全可算」+ 已标定。两者现在都不成立 ⇒ margin === null
  // ⇒ lowMargin 升档与 §5.6 弃权在生产路径上**结构上不可达**。
  assert.strictEqual(r.margin, null, 'margin 应当不可得');
  assert.strictEqual(r.cost.participated, false, '成本项未参与（λ 未标定/覆盖不全）');
  assert.strictEqual(r.escalatedFrom, null, 'margin 不可得 ⇒ 不得有升档');
  assert.strictEqual(r.abstained, false, 'margin 不可得 ⇒ 弃权路径不可达（不是「算过决定不弃权」）');
  // ⚠ 这不是「永远如此」的断言，而是**闸链的可见化**：一旦 6 个型号价表补齐(§14-D4)
  // 且 λ 标定完成(§14-D3)，这几行会翻红 —— 那时必须同步更新设计文档 §16.4l 的可达性表，
  // 而不是把测试改掉。
});

// 这条才是「rank 自己算出的 margin 真的传进了升档」的承重测。
// 前置用价桩造出来：真实价表里每个档只有一个可计价型号，
// 造不出「fit 打平、只差成本」的候选对 —— 于是把 margin 压到阈值以下只能桩 priceCoverage/resolvePrice。
test('§5.5 承重：margin 由 rank 算出时低置信升档会触发，且收紧后无候选时**不放宽**', async () => {
  const mp = require('../modelPricing');
  const rm = require('./routingMode');
  const realCoverage = mp.priceCoverage;
  const realPrice = mp.resolvePrice;
  const PRICES = { 'rank-probe-t2': 1.0, 'rank-probe-t1': 2.0 };
  mp.priceCoverage = (list) => ({
    total: list.length,
    usable: list.length,
    byState: { priced: list.length, free: 0, assumed: 0, flat: 0, unknown: 0 },
    allUsable: true,
  });
  mp.resolvePrice = (m) =>
    PRICES[m] ? { state: 'priced', price: { input: PRICES[m], output: 0 } } : { state: 'unknown', price: null };

  try {
    const card = {
      defaultMode: 'probe',
      modes: {
        probe: {
          label: 'Probe',
          capabilityFloor: 'T3',
          capabilityCeiling: 'T0',
          escalateOn: ['lowMargin'],
          lambda: 0.05,
          thinking: 'auto',
          promptPolicy: 'P1',
        },
      },
    };
    const env = {
      ...RANK_ENV,
      GATEWAY_ROUTING_MODE: 'probe',
      KHY_ROUTING_MODES_JSON: JSON.stringify(card),
    };
    const mode = rm.resolveMode('probe', { env });
    assert.strictEqual(mode.lambda, 0.05, '内联卡没把 lambda 带进来 —— 前置不成立');

    // 两个**同档**(都 T2)候选：fit 完全打平 ⇒ 分数只差成本项 ⇒ margin = λ = 0.05 < 阈值 0.1。
    const gw = probeGw(['rank-probe-t2', 'rank-probe-t2b']);
    await amr.refreshPool(gw, env);
    const tied = amr.rank(gw, 'conversation', { mode, escalate: { demand: 0.9 } }, env);
    assert.ok(
      Number.isFinite(tied.margin) && tied.margin < 0.1,
      `margin 应是有限且低于阈值，实际 ${tied.margin}`
    );
    assert.match(
      String(tied.escalateReason),
      /lowMargin/,
      'rank 自己算出的有限 margin 必须传进 applyEscalation（此前传的是 undefined ⇒ 这一行永远不会红）'
    );
    // 收紧到 T1 后池里没有 T1 ⇒ **保持原档**，绝不为了「有得选」而放宽带。
    assert.strictEqual(tied.escalatedFrom, null, '收紧后无候选时不得伪造升档痕迹');
    assert.strictEqual(tied.ranked.length, 2, '收紧后无候选 ⇒ 保持原列表，不删候选');

    // 对照：候选跨档时 fit 差值主导，margin 会远大于阈值 ⇒ 不该触发。
    // （'zzz-sonnet-4' 才真的是 T1；'rank-probe-t1' 这种未识别名会被 modelTier 兜到 T2，
    //   拿它当 T1 是错的 —— 这条注释是给下一个改这里的人省的。）
    const gwWide = probeGw(['rank-probe-t2', 'zzz-sonnet-4']);
    await amr.refreshPool(gwWide, env);
    const wide = amr.rank(gwWide, 'conversation', { mode, escalate: { demand: 0.9 } }, env);
    assert.ok(wide.margin > 0.1, `构造失败：wide 场景 margin 应大于阈值，实际 ${wide.margin}`);
    assert.strictEqual(wide.escalateReason, null, '差值明显时不该升档');
  } finally {
    mp.priceCoverage = realCoverage;
    mp.resolvePrice = realPrice;
  }
});


// §15-2 的落盘证据：queryOnly 只活在内存里等于没说。
// 这条测的是**写手**，不是 decide —— 因为本文件的样本投影是白名单式的，
// 新字段不加进白名单就会被静默丢掉（这次就是这样差点丢掉）。
test('§15-2 stateInputs.queryOnly 必须进样本行（否则执行状态缺位无人可见）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-state-'));
  const file = path.join(dir, 'auto-route.jsonl');
  const env = _env(file);
  const t1 = amr.beginTurn({ sessionId: 'ST' });

  amr.observeSelection(
    {
      turnId: t1,
      mode: 'auto',
      demand: {
        tier: 'T2',
        demand: 0.31,
        flags: ['implement'],
        admitted: false,
        reasons: ['含实现类动词'],
        capabilityRequired: null,
        stateInputs: {
          present: [],
          absent: ['ctxRatio', 'estCtxTokens', 'toolFails', 'turnIndex', 'hasImage'],
          queryOnly: true,
        },
      },
      legacy: { adapter: 'api', model: 'a' },
      ranked: [{ adapter: 'api', model: 'a', tier: 'T2' }],
      skipped: [],
    },
    env
  );

  const row = JSON.parse(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)[0]);
  assert.ok(row.demand, 'demand 应在样本行里');
  assert.ok(row.demand.stateInputs, 'stateInputs 没进样本行 —— 白名单漏了它');
  assert.strictEqual(row.demand.stateInputs.queryOnly, true);
  assert.deepStrictEqual(row.demand.stateInputs.absent, [
    'ctxRatio',
    'estCtxTokens',
    'toolFails',
    'turnIndex',
    'hasImage',
  ]);
  assert.strictEqual(row.demand.stateInputs.present.length, 0);

  // 对照：老形态 demand（没有 stateInputs）必须仍写得出，且如实为 null，
  // 不许把「没有这个字段」当成「有但没有执行状态」。
  const t2 = amr.beginTurn({ sessionId: 'ST' });
  amr.observeSelection(
    {
      turnId: t2,
      mode: 'auto',
      demand: { tier: 'T1', demand: 0.5, flags: [], admitted: false, reasons: [] },
      legacy: { adapter: 'api', model: 'b' },
      ranked: [],
      skipped: [],
    },
    env
  );
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].demand.stateInputs, null, '缺 stateInputs 时应写 null，不是写一个假的空壳');
});

// M11 的同类风险重演了一次：样本投影是白名单式的，`independent` 是新加的字段，
// 不写进白名单就只活在内存里。这条测专门锁它的落盘。
test('§15-2 independent 必须进样本行（否则覆盖度为什么算数无人可见）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-indep-'));
  const file = path.join(dir, 'auto-route.jsonl');
  const env = _env(file);
  const t = amr.beginTurn({ sessionId: 'IND' });
  amr.observeSelection(
    {
      turnId: t,
      mode: 'auto',
      demand: {
        tier: 'T2',
        demand: 0.4,
        flags: [],
        admitted: false,
        reasons: [],
        stateInputs: {
          present: ['ctxRatio', 'toolFails', 'estCtxTokens'],
          absent: ['hasImage', 'turnIndex'],
          independent: ['ctxRatio'],
          queryOnly: false,
        },
      },
      legacy: { adapter: 'api', model: 'a' },
      ranked: [],
      skipped: [],
    },
    env
  );
  const row = JSON.parse(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)[0]);
  assert.deepStrictEqual(
    row.demand.stateInputs.independent,
    ['ctxRatio'],
    `independent 没落盘 ⇒ 报表只能说「有执行状态」却说不出凭什么：${JSON.stringify(row.demand.stateInputs)}`
  );
  assert.strictEqual(row.demand.stateInputs.queryOnly, false);
});

// 同一道白名单第三次锁：§8-⑦ 的 capability 与 §5.2 的 beta 都是本轮新加的键。
// 生成侧的测试读的是**内存里**的 ctx，摘掉白名单它们照样绿（M26 实测如此）——
// 所以只有从落盘那侧锁，才防得住「字段进了内存、没进账本」这种最贵的漏。
test('capability 与 beta 必须真的进样本行（内存里有 ≠ 账本上有）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-capbeta-'));
  const file = path.join(dir, 'auto-route.jsonl');
  const env = _env(file);
  const turn = amr.beginTurn({ sessionId: 'CB' });

  amr.observeSelection(
    {
      turnId: turn,
      mode: 'economy',
      demand: { tier: 'T2', demand: 0.4, flags: [], admitted: false, reasons: [], capabilityRequired: 'vision' },
      capability: { required: 'vision', blocked: 'vision', dropped: 2, unknown: 1, kept: 0 },
      beta: { declared: 'low', carried: true },
      strongTarget: 0.1,
      margin: 0.07,
      legacy: { adapter: 'api', model: 'a' },
      ranked: [],
      skipped: [],
    },
    env
  );

  const row = JSON.parse(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)[0]);
  assert.ok(row.capability, `capability 没进样本行 —— 白名单漏了它：${JSON.stringify(Object.keys(row))}`);
  assert.strictEqual(row.capability.blocked, 'vision');
  assert.strictEqual(row.capability.dropped, 2);
  assert.strictEqual(row.capability.unknown, 1);
  assert.ok(row.beta, `beta 没进样本行 —— 白名单漏了它：${JSON.stringify(Object.keys(row))}`);
  assert.strictEqual(row.beta.declared, 'low');
  assert.strictEqual(row.beta.carried, true);
  // §5.4 的目标侧：strongTarget 不落白名单，replay 就只能印实测、没法印差。
  assert.strictEqual(row.strongTarget, 0.1, `strongTarget 没进样本行：${JSON.stringify(row.strongTarget)}`);
  // margin 同一条纪律：§14-D3 的阈值（marginUpgrade）要人拍板，而拍板的输入就是这个差值；
  // 它不落盘，「低置信升档今天可达吗」就永远只有代码推理没有实测（§16.4ak）。
  assert.strictEqual(row.margin, 0.07, `margin 没进样本行：${JSON.stringify(row.margin)}`);
});
