'use strict';

/**
 * pass D（matching）的落地测试：band 硬约束、λ 成本项、margin 可得性。
 *
 * 最重要的一条是第 1 条：**不传新参数时输出与改动前逐字节一致**。
 * rankAutoModels 有三个既有消费者（选择器预览、enhancedModelSelector、autoModelRouting），
 * 我加的是可选参数，一旦默认路径也变了，就是拿「四档功能」的名义改坏了现状路由。
 */

const test = require('node:test');
const assert = require('node:assert');

const sel = require('./autoModelSelect');

const POOL = [
  { model: 'gpt-4o-mini', adapter: 'api', tier: 'T3', source: 'remote', status: 'active' },
  { model: 'deepseek-chat', adapter: 'api', tier: 'T1', source: 'remote', status: 'active' },
  { model: 'claude-sonnet-4', adapter: 'claude', tier: 'T1', source: 'remote', status: 'active' },
  { model: 'claude-opus-4-7', adapter: 'claude', tier: 'T0', source: 'remote', status: 'active' },
];

test('REGRESSION: 不传 band/lambda 时位次与字段集与改动前一致', () => {
  const legacy = sel.rankAutoModels('code', POOL);
  assert.ok(legacy.length > 0, '空输入会让这条断言恒真');
  // 旧实现的输出对象只有这四个键；多出一个 score 就说明默认路径被我改了
  for (const r of legacy) {
    assert.deepStrictEqual(
      Object.keys(r).sort(),
      ['adapter', 'model', 'status', 'tier'],
      `默认路径多出了字段: ${Object.keys(r)}`
    );
  }
  // 位次：'code' 的期望档是 T1 → dist(T1)=0 < dist(T0)=1 < dist(T3)=2，
  // 同 dist 内按原始下标（deepseek 在 sonnet 前）。
  // 这条序列不是猜的：对照已变成活的锁 —— 见同目录 autoModelSelect.headRevert.test.js
  // （git show HEAD: 取旧模块编译进来比 JSON 串，含键序）。此前这里只写「用临时探针实跑过、
  // 之后删除探针」，等于没有锁：默认路径被人改坏时不会有任何东西变红。
  assert.deepStrictEqual(
    legacy.map((r) => `${r.tier}:${r.model}`),
    [
      'T1:deepseek-chat',
      'T1:claude-sonnet-4',
      'T0:claude-opus-4-7',
      'T3:gpt-4o-mini',
    ],
    '默认离散排序的位次变了 —— 既有消费者依赖它'
  );
});

test('band 是硬约束：区间外候选直接出池，不因贴合度回捞', () => {
  // 经济档语义：floor=T2(idx2) ceiling=T1(idx1) → 只允许 T1/T2
  const eco = sel.rankAutoModels('code', POOL, { band: { floorIdx: 2, ceilingIdx: 1 } });
  assert.ok(eco.length > 0);
  for (const r of eco) {
    assert.ok(r.tier === 'T1' || r.tier === 'T2', `经济档拿到了 ${r.tier}`);
  }
  assert.ok(!eco.some((r) => r.model === 'claude-opus-4-7'), 'T0 必须出池');
  assert.ok(!eco.some((r) => r.model === 'gpt-4o-mini'), 'T3 必须出池');

  // 极致档：只允许 T0
  const extreme = sel.rankAutoModels('code', POOL, { band: { floorIdx: 0, ceilingIdx: 0 } });
  assert.deepStrictEqual(extreme.map((r) => r.model), ['claude-opus-4-7']);
});

test('band 把池滤空时返回空数组，不静默放宽', () => {
  // 池里没有 T3 —— 经济档若「放宽一档」就会悄悄用上 T1/T0，那正是「经济=auto」的塌缩路径
  const onlyStrong = [{ model: 'claude-opus-4-7', adapter: 'claude', tier: 'T0', source: 'remote' }];
  const r = sel.rankAutoModels('code', onlyStrong, { band: { floorIdx: 3, ceilingIdx: 2 } });
  assert.deepStrictEqual(r, []);
});

test('λ 参与时同贴合度内便宜者胜，且输出带 score 供 margin 计算', () => {
  const priceOf = (m) => (m === 'deepseek-chat' ? 1.37 : m === 'claude-sonnet-4' ? 18 : 0);
  const r = sel.rankAutoModels('code', POOL, {
    band: { floorIdx: 1, ceilingIdx: 0 },
    lambda: 0.5,
    priceOf,
  });
  assert.ok(r.length > 0);
  for (const e of r) assert.ok(Number.isFinite(e.score), '连续打分路径必须带 score');
  // 两个 T1 同 dist，便宜的 deepseek 必须在前面
  const d = r.findIndex((e) => e.model === 'deepseek-chat');
  const c = r.findIndex((e) => e.model === 'claude-sonnet-4');
  assert.ok(d >= 0 && c >= 0);
  assert.ok(d < c, 'λ=0.5 下贵的排前面，成本项没真的参与');
});

test('价格未知的候选不得被当成免费午餐', () => {
  // claude-sonnet-4 有价、deepseek-chat 无价。若把「无价」当 0，它会白赢。
  const priceOf = (m) => (m === 'claude-sonnet-4' ? 18 : null);
  const r = sel.rankAutoModels('code', POOL, {
    band: { floorIdx: 1, ceilingIdx: 1 },
    lambda: 0.9,
    priceOf,
  });
  assert.strictEqual(r.length, 2);
  // λ 高达 0.9 也只作用在「有价的」候选上；无价候选按 fit 排，不许拿 0 成本加分
  assert.ok(Number.isFinite(r[0].score));
  const priced = r.find((e) => e.model === 'claude-sonnet-4');
  const unknown = r.find((e) => e.model === 'deepseek-chat');
  assert.ok(priced && unknown);
  // 两者 fit 相同（同为 T1），有价的那个 costNorm=1 → 无价者 score 更高属预期；
  // 真正要锁的是：**不许出现「有价候选因对手无价而被降权」**，所以断言无价者的 score 不来自成本项
  assert.ok(Math.abs(unknown.score - priced.score) <= 1, 'score 量纲异常');
  assert.ok(unknown.score >= priced.score, '无价候选应退回纯 fit，而不是被成本项压到底');
});

test('λ 非有限（未标定）时成本项整项退出：无 score、位次同默认', () => {
  const withNull = sel.rankAutoModels('code', POOL, { lambda: null, priceOf: () => 1 });
  const plain = sel.rankAutoModels('code', POOL);
  assert.deepStrictEqual(withNull.map((r) => r.model), plain.map((r) => r.model));
  for (const r of withNull) {
    assert.strictEqual(r.score, undefined, 'λ 退出后不该留下 score 假装参与过');
  }
});

test('buildModeChoices：四行的 value 全部保持 auto 语义（否则会被当成钉选真实渠道）', () => {
  const specs = [
    { key: 'auto', label: 'Auto', intent: '自动定档', costHint: '≈1.8×', preview: 'm-a' },
    { key: 'extreme', label: '极致', intent: '不计成本', costHint: '≈9×', current: true },
    { key: 'perf', label: '性能', intent: '兼顾成本', costHint: '?' },
    { key: 'economy', label: '经济', intent: '性价比', costHint: '包月' },
  ];
  const rows = sel.buildModeChoices({ modes: specs });
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows.map((r) => r.value.mode), ['auto', 'extreme', 'perf', 'economy']);
  for (const r of rows) {
    assert.strictEqual(r.value.adapter, 'auto');
    assert.strictEqual(r.value.model, 'auto');
    assert.strictEqual(sel.isAutoSelection(r.value), true, `${r.value.mode} 不被认成 auto 选择`);
    // [DESIGN-ARCH-167] 分层字段必须齐，否则这四行成为表里唯一不分层的行
    for (const k of ['name', 'primary', 'secondary', 'group', 'groupMeta', 'value', 'disabled']) {
      assert.ok(Object.prototype.hasOwnProperty.call(r, k), `缺分层字段 ${k}`);
    }
    assert.strictEqual(r.group, '模式');
  }
  // 当前档标星，其余不标
  assert.match(rows[1].primary, /^★/);
  assert.ok(!/★/.test(rows[0].primary), '非当前档也被标星 = 高亮失效');
  // 成本提示与预览都进 secondary（可计算，不写死）
  assert.match(rows[1].secondary, /≈9×/);
  assert.match(rows[0].secondary, /当前最优: m-a/);
});

// §14-D11 / §15-1：钉选时模式轴整体旁路，这四行「可选但不生效」= 画面在说谎。
// 置灰是强制性的：ModelPicker 真的跳过 disabled 行、Enter 与数字直选都拒、并画 (不可选)。
test('buildModeChoices：inert 时四行全部置灰并说明原因，但 value 语义一字不改', () => {
  const specs = [
    { key: 'auto', label: 'Auto', intent: '自动定档', costHint: '≈1.8×', preview: 'm-a' },
    { key: 'economy', label: '经济', intent: '性价比', costHint: '包月', current: true },
  ];
  const inertRows = sel.buildModeChoices({ modes: specs, inert: true });
  assert.strictEqual(inertRows.length, 2, '置灰不该减少行数（隐藏会让功能看起来消失）');
  for (const r of inertRows) {
    assert.strictEqual(r.disabled, true, `${r.value.mode} 行必须置灰`);
    assert.match(r.secondary, /档位不生效/, '要说清为什么不生效，含糊的「不可选」违反 RUNTIME-002');
    // 置灰只改可选性，不改语义：value 仍是 auto 哨兵对，否则会被当成钉选真实渠道
    assert.strictEqual(r.value.adapter, 'auto');
    assert.strictEqual(r.value.model, 'auto');
    assert.strictEqual(sel.isAutoSelection(r.value), true);
  }
  // 自定义原因文案（消费点会带上钉的是渠道还是模型）
  const custom = sel.buildModeChoices({ modes: specs, inert: true, inertNote: '已钉选模型 · 档位不生效' });
  assert.match(custom[0].secondary, /已钉选模型/);

  // 对照：没钉选时不得置灰（否则整条功能对正常安装直接不可用）。
  // 显式传 `env: {}` 而不是依赖进程环境 —— 自查钉选之后，这台机器上真的配了钉选时
  // 这一行会变成「期望可选却置灰」的假红，测试的对照面必须由自己控制。
  const openRows = sel.buildModeChoices({ modes: specs, env: {} });
  for (const r of openRows) {
    assert.strictEqual(r.disabled, false, '未钉选却置灰 = 功能对正常安装消失');
    assert.doesNotMatch(r.secondary, /档位不生效/);
  }
});

// §16.4o 里唯一只有静态证据的环节：供数点有没有把 inert 传下来。
// 现在 inert 由本函数自查 ⇒ 「忘传实参」这条路根本不存在，这条测就是它的证明。
test('buildModeChoices：inert 不靠调用方传 —— 钉选状态由叶子自查（防「删一个实参就静默失效」）', () => {
  const pinKeys = ['GATEWAY_PREFERRED_ADAPTER', 'GATEWAY_PREFERRED_MODEL'];
  const saved = {};
  for (const k of pinKeys) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    delete process.env[k];
  }
  try {
    const specs = [{ key: 'economy', label: '经济', intent: '性价比', costHint: '?' }];

    // 没传 inert、也没钉选 ⇒ 可选
    const open = sel.buildModeChoices({ modes: specs });
    assert.strictEqual(open[0].disabled, false, '未钉选且未传 inert 时必须可选');

    // 钉了渠道，仍然**不传** inert ⇒ 自查必须自己发现并置灰
    process.env.GATEWAY_PREFERRED_ADAPTER = 'api';
    const pinned = sel.buildModeChoices({ modes: specs });
    assert.strictEqual(
      pinned[0].disabled,
      true,
      '钉选却没传 inert ⇒ 曾经是一处删掉实参就静默说谎、且无任何测试会红的接缝'
    );
    assert.match(pinned[0].secondary, /档位不生效/);

    // env 参数注入路径也要认（调用方可以指定读哪份 env，不能只认 process.env）
    const viaEnvArg = sel.buildModeChoices({
      modes: specs,
      env: { GATEWAY_PREFERRED_MODEL: 'claude-opus-4-7' },
    });
    assert.strictEqual(viaEnvArg[0].disabled, true, 'opts.env 里的钉选也要被自查看到');

    // 显式布尔覆盖仍然优先（运维/测试留的口）
    const forced = sel.buildModeChoices({ modes: specs, inert: false });
    assert.strictEqual(forced[0].disabled, false, '调用方显式 inert:false 应当被尊重');
  } finally {
    for (const k of pinKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('buildModeChoices：坏输入返回空数组，不抛', () => {
  assert.deepStrictEqual(sel.buildModeChoices({}), []);
  assert.deepStrictEqual(sel.buildModeChoices({ modes: [] }), []);
  assert.deepStrictEqual(sel.buildModeChoices({ modes: [null, 42, { label: '无 key' }] }), []);
  const one = sel.buildModeChoices({ modes: [{ key: 'auto', label: 'Auto' }] });
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].secondary, '', '无提示无预览时应留空串而不是 undefined');
});

test('确定性 + 绝不抛', () => {
  const opts = { band: { floorIdx: 3, ceilingIdx: 0 }, lambda: 0.3, priceOf: () => 1 };
  const a = sel.rankAutoModels('code', POOL, opts);
  const b = sel.rankAutoModels('code', POOL, opts);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(sel.rankAutoModels('code', null, opts), []);
  assert.deepStrictEqual(sel.rankAutoModels('code', POOL, { band: { floorIdx: 'x' } }), sel.rankAutoModels('code', POOL));
  assert.deepStrictEqual(
    sel.rankAutoModels('code', POOL, { lambda: 0.5, priceOf: () => { throw new Error('boom'); } }),
    []
  );
});

// ── 组合链：routingMode → band/λ → rankAutoModels ──────────────────────────
// 三个模块各自单测都过，不代表连起来对：band 的 floorIdx/ceilingIdx 语义在
// routingMode 里是「T0 最强=索引 0」，在 rankAutoModels 里是比较两端，
// 任一侧方向写反都会让「经济」拿到 T0 而两边单测都发现不了。

const rm = require('./routingMode');
const mp = require('../modelPricing');

test('四档各自的 band 在真实池上的可及档位符合 §4.2 的语义边界', () => {
  const card = rm._loadCard({});
  const expect = {
    extreme: ['T0'],
    perf: ['T0', 'T1'],
    economy: ['T1'],
    auto: ['T0', 'T1', 'T3'],
  };
  for (const [name, allowed] of Object.entries(expect)) {
    const mode = rm.resolveMode(name, { card });
    assert.ok(mode, `${name} 档解析失败`);
    const r = sel.rankAutoModels('code', POOL, {
      band: { floorIdx: mode.floorIdx, ceilingIdx: mode.ceilingIdx },
    });
    const tiers = Array.from(new Set(r.map((x) => x.tier))).sort();
    assert.deepStrictEqual(tiers, allowed.slice().sort(), `${name} 档拿到了不该触及的档位`);
  }
  // 经济档在本池里没有 T2 → 只剩 T1；这同时证明 band 不会为「凑满档位」而放宽
  const eco = rm.resolveMode('economy', { card });
  const ecoR = sel.rankAutoModels('code', POOL, {
    band: { floorIdx: eco.floorIdx, ceilingIdx: eco.ceilingIdx },
  });
  assert.ok(ecoR.every((x) => x.tier !== 'T0'), '经济档越界');
});

test('真实价格表接入后：池内含 unknown 候选时 λ 整项退出，位次退回默认', () => {
  const card = rm._loadCard({});
  const mode = rm.resolveMode('perf', { card });
  const coverage = mp.priceCoverage(POOL.map((p) => p.model));
  // 本池含 claude-opus-4-7（无价）→ allUsable 必须为 false
  assert.strictEqual(coverage.allUsable, false, `覆盖率判定失真: ${JSON.stringify(coverage.byState)}`);
  assert.strictEqual(rm.lambdaFor({ ...mode, lambda: 0.4 }, { coverage }), null);

  const withMode = sel.rankAutoModels('code', POOL, {
    band: { floorIdx: mode.floorIdx, ceilingIdx: mode.ceilingIdx },
    lambda: rm.lambdaFor({ ...mode, lambda: 0.4 }, { coverage }),
    priceOf: (m) => (mp.isCostUsable(mp.resolvePrice(m).state) ? 1 : null),
  });
  const plain = sel.rankAutoModels('code', POOL, {
    band: { floorIdx: mode.floorIdx, ceilingIdx: mode.ceilingIdx },
  });
  assert.deepStrictEqual(withMode.map((r) => r.model), plain.map((r) => r.model));
  for (const r of withMode) assert.strictEqual(r.score, undefined);
});

test('全池有价时 λ 才真的参与（证明上一条不是恒绿的空测）', () => {
  const pricedPool = [
    { model: 'gpt-4o-mini', adapter: 'api', tier: 'T1', source: 'remote', status: 'active' },
    { model: 'deepseek-chat', adapter: 'api', tier: 'T1', source: 'remote', status: 'active' },
  ];
  const coverage = mp.priceCoverage(pricedPool.map((p) => p.model));
  assert.strictEqual(coverage.allUsable, true, '本条要证明上一条的退出是条件性的，不是永远退出');
  const card = rm._loadCard({});
  const mode = rm.resolveMode('perf', { card });
  const lambda = rm.lambdaFor({ ...mode, lambda: 0.4 }, { coverage });
  assert.ok(Number.isFinite(lambda), '全池有价时 λ 应当参与');
  const r = sel.rankAutoModels('code', pricedPool, {
    band: { floorIdx: mode.floorIdx, ceilingIdx: mode.ceilingIdx },
    lambda,
    priceOf: (m) => {
      const p = mp.resolvePrice(m);
      return p.price ? p.price.input + p.price.output : null;
    },
  });
  assert.ok(Number.isFinite(r[0].score));
  // deepseek-chat(1.37) 比 gpt-4o-mini(0.75) 贵 → 同 T1 下 mini 应在前
  assert.strictEqual(r[0].model, 'gpt-4o-mini');
});
