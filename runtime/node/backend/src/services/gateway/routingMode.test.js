'use strict';

/**
 * routingMode 的对抗性测试。
 *
 * 每条都挑「实现退回到看起来合理但方向危险」的那一侧下刀:
 * 不认识档名回落到哪一档、λ 缺失时是乘 0 还是整项退出、省思考要不要证据。
 */

const test = require('node:test');
const assert = require('node:assert');

const rm = require('./routingMode');

const card = rm._loadCard({});

test('档位卡加载到了,且四档齐全(防空配置假绿)', () => {
  // 先断言文件真的在:路径写错时 _loadCard 返回 null,下游全部退化成「卡不存在」的
  // 安全分支 —— 那是一种**不会变红**的失效。
  assert.ok(require('fs').existsSync(rm.cardFile()), `档位卡路径不存在:${rm.cardFile()}`);
  assert.ok(card && card.modes, 'routing-modes.json 未加载');
  const keys = Object.keys(card.modes).sort();
  assert.deepStrictEqual(keys, ['auto', 'economy', 'extreme', 'perf']);
  const listed = rm.listModes({ card });
  assert.strictEqual(listed.length, 4);
  assert.ok(listed.some((m) => m.label === '极致' && m.label === card.modes.extreme.label));
});

test('不认识的档名回落 auto,绝不回落 economy', () => {
  // 拼写错误变成一次静默降档,是这类配置最坏的失败模式。
  const m = rm.resolveMode('extremly', { card });
  assert.ok(m);
  assert.strictEqual(m.used, 'auto');
  assert.strictEqual(m.requested, 'extremly');
  assert.notStrictEqual(m.used, 'economy');
});

test('floor/ceiling 写反视为卡坏(返回 null),而不是将错就错滤光全池', () => {
  const broken = {
    defaultMode: 'auto',
    modes: { auto: { capabilityFloor: 'T0', capabilityCeiling: 'T3' } },
  };
  assert.strictEqual(rm.resolveMode('auto', { card: broken }), null);
});

test('band 判定含端点,且方向正确(T0 最强)', () => {
  const eco = rm.resolveMode('economy', { card });
  assert.strictEqual(eco.floor, 'T2');
  assert.strictEqual(eco.ceiling, 'T1');
  assert.strictEqual(rm.allowsTier(eco, 'T2'), true, 'floor 端点应可用');
  assert.strictEqual(rm.allowsTier(eco, 'T1'), true, 'ceiling 端点应可用');
  assert.strictEqual(rm.allowsTier(eco, 'T0'), false, '越 ceiling 必须拒');
  assert.strictEqual(rm.allowsTier(eco, 'T3'), false, '越 floor 必须拒');
  assert.strictEqual(rm.allowsTier(eco, 'nonsense'), false);
});

test('S1 红线:模式轴开着时,改写路由必须默认关', () => {
  // PROCESS-008:新机制不得直进生效档。这条断言的是「默认值」,不是「能否被打开」。
  assert.strictEqual(rm.isEnabled({}), true);
  assert.strictEqual(rm.isApplyEnabled({}), false);
  assert.strictEqual(rm.applyBlockedBy({}), 'KHY_ROUTE_APPLY=off');
  // 只开 flag 不够 —— 阶段仍是 S1(见下一条)
  assert.strictEqual(rm.isApplyEnabled({ KHY_ROUTE_APPLY: '1' }), false);
  // 总闸关 → apply 必须连带关(不能出现「轴不存在但结果仍改写路由」)
  assert.strictEqual(
    rm.isApplyEnabled({ KHY_ROUTING_MODES: '0', KHY_ROUTE_APPLY: '1', KHY_ROUTE_APPLY_STAGE: 'S3' }),
    false
  );
  assert.strictEqual(rm.applyBlockedBy({ KHY_ROUTING_MODES: '0' }), 'KHY_ROUTING_MODES=off');
});

// §16.4ar：钉选是第四层，且它才是「选了档没反应」的真原因。此前 applyBlockedBy 在
// 钉选机器上报 KHY_ROUTE_APPLY=off —— 指向了一个本次并没有挡路的层。
test('applyBlockedBy 认得钉选这一层，且排序不错（总闸 > 钉选 > flag/阶段）', () => {
  assert.strictEqual(rm.applyBlockedBy({ GATEWAY_PREFERRED_ADAPTER: 'api' }), 'pinned',
    '钉了渠道必须报 pinned，否则诊断会把人支到 KHY_ROUTE_APPLY 上去');
  assert.strictEqual(
    rm.applyBlockedBy({ GATEWAY_PREFERRED_MODEL: 'api:foo:bar' }), 'pinned',
    '钉模型同样是旁路层'
  );
  // 顺序 1：总闸关时不因钉选改变措辞（轴本就不存在，钉选是 moot）
  assert.strictEqual(
    rm.applyBlockedBy({ KHY_ROUTING_MODES: '0', GATEWAY_PREFERRED_ADAPTER: 'api' }),
    'KHY_ROUTING_MODES=off'
  );
  // 顺序 2：钉选 + 应用侧全开 也必须报 pinned（挡住他的是钉选，不是 flag）
  assert.strictEqual(
    rm.applyBlockedBy({
      GATEWAY_PREFERRED_ADAPTER: 'api',
      KHY_ROUTE_APPLY: '1',
      KHY_ROUTE_APPLY_STAGE: 'S3',
    }),
    'pinned'
  );
  // 反对照：不钉选时三层措辞照旧（证明上面几条不是恒返回 pinned）。
  // 期望值第一版写成 'KHY_ROUTE_APPLY-unregistered' 是我猜错了：该门**已登记**（§7-⑬），
  // 所以不钉选应落到下一层 —— 产品对、断言错，红的是我的期望。
  assert.strictEqual(
    rm.applyBlockedBy({ GATEWAY_PREFERRED_ADAPTER: 'auto', GATEWAY_PREFERRED_MODEL: 'auto' }),
    'KHY_ROUTE_APPLY=off'
  );
});

test('lambdaFor:未标定返回 null,不是 0', () => {
  // 返回 0 会让调用方「乘一下就算参与了」,而 null 才能表达「成本项整项退出」。
  const perf = rm.resolveMode('perf', { card });
  assert.strictEqual(perf.lambda, null, '本仓 λ 未标定,卡里必须是 null');
  assert.strictEqual(rm.lambdaFor(perf, { coverage: { allUsable: true } }), null);

  const priced = { ...perf, lambda: 0.4 };
  // 池内有一个价格不可用 → 退出。这是 §5.4 那条硬规则的唯一落点。
  assert.strictEqual(rm.lambdaFor(priced, { coverage: { allUsable: false } }), null);
  assert.strictEqual(rm.lambdaFor(priced, { coverage: { allUsable: true } }), 0.4);
  assert.strictEqual(rm.lambdaFor(priced, {}), 0.4, '未给 coverage 时不擅自退出');
});

test('lambdaFor(auto):预算比缺失则退出,且 λ 有上限不冲顶', () => {
  const auto = { ...rm.resolveMode('auto', { card }), lambda: 0.5, used: 'auto' };
  assert.strictEqual(rm.lambdaFor(auto, { coverage: { allUsable: true } }), null);
  const poor = rm.lambdaFor(auto, { coverage: { allUsable: true }, budgetRatio: 0.05 });
  const rich = rm.lambdaFor(auto, { coverage: { allUsable: true }, budgetRatio: 0.95 });
  assert.ok(poor > rich, '预算越少越该看重成本');
  assert.ok(poor <= 0.95, '成本权重必须有顶,留一条质量优先的路');
});

test('deriveThinking:省思考需要双证据,单有「判成轻档」不够', () => {
  const auto = rm.resolveMode('auto', { card });
  const noneRule = card.thinking_mode_rules.none;
  // 低 margin 的轻档 → 不给 none(这正是 opensquilla 把降档条件写成双门的原因)
  const unsure = rm.deriveThinking(auto, { cls: 'T3', margin: 0.1, flags: [] });
  assert.notStrictEqual(unsure.level, 'none');
  const sure = rm.deriveThinking(auto, { cls: 'T3', margin: noneRule.minMargin + 0.1, flags: [] });
  assert.strictEqual(sure.level, 'none');
  // flag 命中即升,不需要 margin
  const dbg = rm.deriveThinking(auto, { cls: 'T2', margin: 0.0, flags: ['debug'] });
  assert.strictEqual(dbg.level, 'high');
  // mode 钉死优先于规则
  const extreme = rm.resolveMode('extreme', { card });
  assert.strictEqual(rm.deriveThinking(extreme, { cls: 'T0', margin: 1, flags: [] }).level, 'max');
});

test('derivePromptPolicy:P0 的 noFlags 门控连 mode 钉选也不许越过', () => {
  const eco = rm.resolveMode('economy', { card });
  assert.strictEqual(eco.promptPolicy, 'P0');
  // 经济档 + 高风险主诉 → 必须退回中性,而不是照钉选缩短回答
  const blocked = rm.derivePromptPolicy(eco, { flags: ['high_risk'], difficulty: 0.1, margin: 0.9 });
  assert.strictEqual(blocked.id, 'P1');
  assert.strictEqual(blocked.via, 'noFlags-override');
  // 无 flag 的琐碎轮次才允许 P0
  const ok = rm.derivePromptPolicy(eco, { flags: [], difficulty: 0.1, margin: 0.9 });
  assert.strictEqual(ok.id, 'P0');
  // 规则路径:anyFlags 命中 → P2
  const auto = rm.resolveMode('auto', { card });
  assert.strictEqual(rm.derivePromptPolicy(auto, { flags: ['strict_format'] }).id, 'P2');
});

test('escalateTier:到 ceiling 即停并给出可打印原因', () => {
  const eco = rm.resolveMode('economy', { card });
  assert.strictEqual(rm.escalateTier(eco, 'T2').tier, 'T1');
  const atTop = rm.escalateTier(eco, 'T1');
  assert.strictEqual(atTop.changed, false);
  assert.strictEqual(atTop.blocked, 'ceiling');
  // 经济档永远升不到 T0 —— 否则「经济」只是 auto 的别名
  assert.strictEqual(rm.escalateTier(eco, 'T0').blocked, 'ceiling');
  assert.strictEqual(rm.allowsTier(eco, 'T0'), false);
});

test('坏卡 / 坏入参一律收敛,绝不抛', () => {
  // 注意:opts.card 传 null/undefined 是「没给卡」→ 会去加载仓内卡,不是「卡坏」。
  // 卡坏的判据是结构不合法,下面三种都必须返回 null。
  assert.strictEqual(rm.resolveMode('auto', { card: {} }), null);
  assert.strictEqual(rm.resolveMode('auto', { card: { modes: 'not-an-object' } }), null);
  assert.strictEqual(rm.resolveMode('auto', { card: { modes: { auto: 42 } } }), null);
  assert.deepStrictEqual(rm.listModes({ card: {} }), []);
  assert.strictEqual(rm.allowsTier(null, 'T1'), false);
  assert.strictEqual(rm.canEscalate(null, 'lowMargin'), false);
  assert.strictEqual(rm.canEscalate(rm.resolveMode('extreme', { card }), 'lowMargin'), false,
    '极致档 escalateOn 为空:已在顶,无处可升');
  assert.strictEqual(rm.thresholdOf(null, 'marginUpgrade', 0.1), 0.1);
  assert.strictEqual(rm.thresholdOf(rm.resolveMode('auto', { card }), 'nope', 0.42), 0.42);
});

test('S1 闸的登记事实(防「未登记 = 默认开」这条静默通路)', () => {
  // isFlagEnabled 对未登记 flag 返回 true。所以 KHY_ROUTE_APPLY 光在代码里
  // 「默认 false」不够 —— 必须真的登记为 opt-in,否则一次漏登记就是上线即全开。
  const { FLAGS } = require('../../utils/flagRegistry');
  assert.ok(FLAGS.KHY_ROUTE_APPLY, 'KHY_ROUTE_APPLY 未登记 → isFlagEnabled 会放行');
  assert.strictEqual(FLAGS.KHY_ROUTE_APPLY.mode, 'opt-in');
  assert.strictEqual(FLAGS.KHY_ROUTE_APPLY.default, false);
  assert.strictEqual(FLAGS.KHY_ROUTING_MODES.default, true);
});

test('阶段维度独立于开关:flag 打开但阶段是 S1 时仍不改道,且能点名是谁挡的', () => {
  assert.strictEqual(rm.getStage({}), 'S1');
  const onButS1 = { KHY_ROUTE_APPLY: '1' };
  assert.strictEqual(rm.isApplyEnabled(onButS1), false);
  assert.strictEqual(rm.applyBlockedBy(onButS1), 'stage=S1');
  // 两层都放行才生效
  assert.strictEqual(rm.isApplyEnabled({ KHY_ROUTE_APPLY: '1', KHY_ROUTE_APPLY_STAGE: 'S3' }), true);
  assert.strictEqual(rm.applyBlockedBy({ KHY_ROUTE_APPLY: '1', KHY_ROUTE_APPLY_STAGE: 'S3' }), '');
  // 未知阶段值绝不 fail-open 到更高阶段
  assert.strictEqual(rm.getStage({ KHY_ROUTE_APPLY_STAGE: 'S9' }), 'S1');
  assert.strictEqual(rm.getStage({ KHY_ROUTE_APPLY_STAGE: 'yes' }), 'S1');
  assert.strictEqual(rm.isApplyEnabled({ KHY_ROUTE_APPLY: '1', KHY_ROUTE_APPLY_STAGE: 'S9' }), false);
  // 登记表里的 stage 必须与代码常量一致(守卫比对前的自查)。
  // 路径深度:gateway → services → backend → node → runtime → 仓根 = 上 6 层。
  const path = require('path');
  const regFile = path.resolve(
    __dirname, '..', '..', '..', '..', '..', '..',
    'docs', '10_规范', 'registry', 'FEATURE-OWNERSHIP.json'
  );
  const fs = require('fs');
  assert.ok(fs.existsSync(regFile), `登记表路径不存在(数错层数):${regFile}`);
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  const mech = ((reg.rollout || {}).mechanisms || []).find((m) => m.id === 'routing-mode-tiers');
  assert.ok(mech, 'FEATURE-OWNERSHIP.json 未登记 routing-mode-tiers');
  assert.strictEqual(mech.stage, rm.KHY_ROUTE_APPLY_STAGE);
  assert.strictEqual(mech.executorStage.constant, 'KHY_ROUTE_APPLY_STAGE');
});

test('costHintOf 不许编造倍率：价格不可知的三种形态各有独立标签', () => {
  const mode = rm.resolveMode('auto', { card });
  assert.ok(mode);
  // 全无价 → '?'，不是一个数字
  assert.strictEqual(rm.costHintOf(mode, [{ model: 'nonexistent-model-x', tier: 'T2' }]).label, '?');
  // 全订阅包月 → '包月'
  assert.strictEqual(rm.costHintOf(mode, [{ model: 'kiro-default', tier: 'T1' }]).label, '包月');
  // 混合（有价 + 无价）→ '?'：只要有算不出的，倍率就是猜
  assert.strictEqual(
    rm.costHintOf(mode, [
      { model: 'gpt-4o-mini', tier: 'T1' },
      { model: 'claude-opus-4-7', tier: 'T0' },
    ]).label,
    '?'
  );
  // 空候选 / 坏入参
  assert.strictEqual(rm.costHintOf(mode, []).label, '—');
  assert.strictEqual(rm.costHintOf(null, [{ model: 'x', tier: 'T1' }]).label, '—');
});

test('costHintOf 的倍率是算出来的：换一张价表标签必须跟着变', () => {
  // 这条是 §4.4「禁止写死成本倍率」的机器锁。写死字面量的实现会在这里红。
  const mode = rm.resolveMode('perf', { card });
  const cand = [
    { model: 'gpt-4o-mini', tier: 'T1' },
    { model: 'deepseek-chat', tier: 'T1' },
  ];
  const real = rm.costHintOf(mode, cand);
  assert.strictEqual(real.state, 'priced');
  assert.match(real.label, /^≈[0-9.]+×$/);

  const mp = require('../modelPricing');
  const saved = process.env.KHY_MODEL_PRICING_JSON;
  let stubbed;
  try {
    // 等价价表（两个模型同价）→ 倍率必须是 ≈1×，而不是仓内真实价算出的那个数
    process.env.KHY_MODEL_PRICING_JSON = JSON.stringify({
      families: [
        { id: 'a', match: 'gpt-4o-mini', price: { input: 1, output: 1 } },
        { id: 'b', match: 'deepseek-chat', price: { input: 1, output: 1 } },
      ],
      models: {},
    });
    mp._resetTableCache();
    stubbed = rm.costHintOf(mode, cand);
  } finally {
    if (saved === undefined) delete process.env.KHY_MODEL_PRICING_JSON;
    else process.env.KHY_MODEL_PRICING_JSON = saved;
    mp._resetTableCache();
  }
  assert.strictEqual(stubbed.label, '≈1×', `等价价表应得 ≈1×，实得 ${stubbed.label}`);
  assert.notStrictEqual(real.label, stubbed.label, '两次相同说明 label 不随价表变化 = 写死了');
});

test('applyEscalation：只抬不降，且不越 ceiling（§5.5 的三条边界）', () => {
  const eco = rm.resolveMode('economy', { card });
  // 1) 升一档：T2 → T1（经济档 ceiling=T1，到此为止）
  const up = rm.applyEscalation(eco, { tier: 'T2', verifyFailed: true });
  assert.strictEqual(up.tier, 'T1');
  assert.strictEqual(up.changed, true);
  assert.strictEqual(up.reason, 'verifyFailed');
  // 2) 已在 ceiling：不再升，且如实报 unchanged
  const atTop = rm.applyEscalation(eco, { tier: 'T1', verifyFailed: true, irreversible: true });
  assert.strictEqual(atTop.tier, 'T1');
  assert.strictEqual(atTop.changed, false);
  // 3) 永不降档：强档 + 低 margin 也不许变弱
  const strong = rm.applyEscalation(eco, { tier: 'T1', margin: 0.01, demand: 0.9 });
  assert.ok(rm.tierIdx(strong.tier) <= rm.tierIdx('T1'), `降档了: ${strong.tier}`);
  // 4) 极致档 escalateOn 为空 → 任何触发都不动
  const ext = rm.resolveMode('extreme', { card });
  for (const ctx of [{ tier: 'T0', verifyFailed: true }, { tier: 'T0', irreversible: true },
                     { tier: 'T0', margin: 0.0, demand: 0.1 }]) {
    const r = rm.applyEscalation(ext, ctx);
    assert.strictEqual(r.changed, false, `极致档被改动 → ${r.tier}`);
    assert.strictEqual(r.tier, 'T0');
  }
});

test('applyEscalation 弃权：双低置信落中间档，且只在上方落（§5.6）', () => {
  const auto = rm.resolveMode('auto', { card });
  const r = rm.applyEscalation(auto, { tier: 'T3', margin: 0.02, demand: 0.05 });
  assert.strictEqual(r.abstained, true);
  assert.ok(r.reason.startsWith('abstain'), r.reason);
  // fallbackMode=perf → T2；从 T3 抬到 T2 是上抬，合法
  assert.strictEqual(r.tier, 'T2');
  assert.strictEqual(r.changed, true);
  // 已经比中间档强时，弃权不得把它拉下来
  const r2 = rm.applyEscalation(auto, { tier: 'T0', margin: 0.02, demand: 0.05 });
  assert.strictEqual(r2.tier, 'T0');
  assert.strictEqual(r2.changed, false);
  assert.strictEqual(r2.abstained, true, '仍应标记弃权，供状态行与统计点名');
});

test('applyEscalation：坏输入不抛、不改档', () => {
  const eco = rm.resolveMode('economy', { card });
  assert.strictEqual(rm.applyEscalation(null, { tier: 'T1' }).changed, false);
  assert.strictEqual(rm.applyEscalation(eco, {}).changed, false);
  assert.strictEqual(rm.applyEscalation(eco, { tier: 'nonsense' }).changed, false);
  assert.strictEqual(rm.applyEscalation(eco, { tier: 'T2', margin: 'x', demand: null }).tier, 'T2');
  assert.ok(Number.isNaN(rm.tierIdx('T9')));
  assert.strictEqual(rm.tierIdx('T0'), 0);
});

test('staticIntentForTier：固定档的 β/π 生效，auto 如实返回 null（已知缺口不假装）', () => {
  const saved = process.env.GATEWAY_ROUTING_MODE;
  try {
    process.env.GATEWAY_ROUTING_MODE = 'extreme';
    const ext = rm.staticIntentForTier('T0');
    assert.ok(ext, '极致档应产出意图');
    assert.strictEqual(ext.thinkingFloor, 'max');
    assert.strictEqual(ext.promptVerbosity, 'full'); // P2 → full

    process.env.GATEWAY_ROUTING_MODE = 'economy';
    const eco = rm.staticIntentForTier('T2');
    assert.strictEqual(eco.thinkingFloor, 'low');
    assert.strictEqual(eco.promptVerbosity, 'lean'); // P0 → lean

    process.env.GATEWAY_ROUTING_MODE = 'perf';
    assert.strictEqual(rm.staticIntentForTier('T1').thinkingFloor, 'high');

    process.env.GATEWAY_ROUTING_MODE = 'auto';
    assert.strictEqual(rm.staticIntentForTier('T2'), null,
      'auto 的 β 需要请求内 margin/flags，这里拿不到就必须返回 null');

    // 模式轴关 → 一律 null（逐字节回退）。
    // 必须同时传 GATEWAY_ROUTING_MODE，否则 currentModeName 会退到 defaultMode='auto'
    // 而返回 null —— 那样这条就在测「auto 返回 null」，与上面重复，测不到总闸。
    assert.strictEqual(
      rm.staticIntentForTier('T0', { KHY_ROUTING_MODES: '0', GATEWAY_ROUTING_MODE: 'extreme' }),
      null,
      '总闸关了仍产出意图 = 关不掉'
    );
    // 对照：同一 env 只把总闸打开，就必须产出意图
    assert.ok(rm.staticIntentForTier('T0', { GATEWAY_ROUTING_MODE: 'extreme' }));
  } finally {
    if (saved === undefined) delete process.env.GATEWAY_ROUTING_MODE;
    else process.env.GATEWAY_ROUTING_MODE = saved;
  }
});

test('harnessProfile：mode 意图生效，但 env 显式覆盖必须压过它', () => {
  const mt = require('../modelTier');
  const savedFloor = process.env.KHY_HARNESS_THINKING_FLOOR;
  const savedVerb = process.env.KHY_HARNESS_PROMPT_VERBOSITY;
  try {
    // 1) 无意图 → 与今日一致（T1 默认 thinkingFloor=null / promptVerbosity=full）
    const base = mt.harnessProfile('T1', {});
    assert.strictEqual(base.thinkingFloor, null);
    assert.strictEqual(base.promptVerbosity, 'full');
    assert.strictEqual(base.modeApplied, undefined, '无意图时不许留下 modeApplied 痕迹');

    // 2) 有意图 → 生效
    const withMode = mt.harnessProfile('T1', {
      modeIntent: { thinkingFloor: 'high', promptVerbosity: 'lean' },
    });
    assert.strictEqual(withMode.thinkingFloor, 'high');
    assert.strictEqual(withMode.promptVerbosity, 'lean');

    // 3) 坏意图不抛、保持 tier 默认。
    //    ⚠ 必须排在 env 覆盖那一段**之前**：否则它读到的是上一段留下的
    //    KHY_HARNESS_THINKING_FLOOR='max'，会把「env 生效」误判成「坏意图没被挡住」。
    const junk = mt.harnessProfile('T1', { modeIntent: { thinkingFloor: 'T9', promptVerbosity: 42 } });
    assert.strictEqual(junk.thinkingFloor, null);
    assert.strictEqual(junk.promptVerbosity, 'full');
    assert.doesNotThrow(() => mt.harnessProfile('T1', { modeIntent: 'not-an-object' }));

    // 4) env 必须压过 mode —— 运维逃生阀不能被子系统默认值架空
    process.env.KHY_HARNESS_THINKING_FLOOR = 'max';
    process.env.KHY_HARNESS_PROMPT_VERBOSITY = 'full';
    const withEnv = mt.harnessProfile('T1', {
      modeIntent: { thinkingFloor: 'high', promptVerbosity: 'lean' },
    });
    assert.strictEqual(withEnv.thinkingFloor, 'max', 'env 被 mode 压过了 —— 优先级反了');
    assert.strictEqual(withEnv.promptVerbosity, 'full');
  } finally {
    if (savedFloor === undefined) delete process.env.KHY_HARNESS_THINKING_FLOOR;
    else process.env.KHY_HARNESS_THINKING_FLOOR = savedFloor;
    if (savedVerb === undefined) delete process.env.KHY_HARNESS_PROMPT_VERBOSITY;
    else process.env.KHY_HARNESS_PROMPT_VERBOSITY = savedVerb;
  }
});

test('thinking 词表只含本仓 dial 表达得出的值（防「配了等于没配」）', () => {
  // modelTier 的 _EFFORT_TIERS 只有 low|high|max，加上 'none'(=null) 共四态。
  // 卡里若出现第五级（如 medium），会被静默降级成 null —— 这条把词表钉住。
  // 断言对象是**规则实际写入的值** sets，不是规则名：'default' 是规则标签而非级别。
  // 'auto' 是「由规则现场推导」的哨兵，不是 dial 值 —— 它单独一组断言。
  const modeAllowed = new Set(['auto', 'none', 'low', 'high', 'max']);
  for (const [name, m] of Object.entries(card.modes)) {
    assert.ok(modeAllowed.has(String(m.thinking)), `${name} 的 thinking=${m.thinking} 不在词表内`);
  }
  // 只有 auto 档允许 'auto'；固定档若写 'auto'，staticIntentForTier 会拿不到确定值
  assert.strictEqual(card.modes.auto.thinking, 'auto');
  for (const k of ['extreme', 'perf', 'economy']) {
    assert.notStrictEqual(card.modes[k].thinking, 'auto', `${k} 是固定档，thinking 必须钉死`);
  }
  const dial = new Set([null, 'low', 'high', 'max']);
  for (const [k, rule] of Object.entries(card.thinking_mode_rules)) {
    if (k.startsWith('_')) continue;
    assert.ok(rule && typeof rule === 'object', `规则 ${k} 不是对象`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(rule, 'sets'),
      `规则 ${k} 没有 sets 字段，无法核对它到底往 dial 写什么`
    );
    assert.ok(dial.has(rule.sets), `规则 ${k} 的 sets=${rule.sets} 不在 dial 词表内`);
  }
});

test('REGRESSION: none 一级必须可达（规则曾把 low 排在它前面）', () => {
  // margin=0.6 同时满足 low(≥0.4) 与 none(≥0.5)。若先判 low，none 就永远不可达，
  // 表现为「最省的那级配了但从来没生效」，且不会有任何报错。
  const auto = rm.resolveMode('auto', { card });
  const r = rm.deriveThinking(auto, { cls: 'T3', margin: 0.6, flags: [] });
  assert.strictEqual(r.level, 'none');
  assert.strictEqual(r.sets, null, 'none 应写 null（不设下限），不是字符串 "none"');
  // 中间地带仍是 low
  const mid = rm.deriveThinking(auto, { cls: 'T3', margin: 0.45, flags: [] });
  assert.strictEqual(mid.level, 'low');
  assert.strictEqual(mid.sets, 'low');
});

test('§5.6 软失败落点：fallbackMode 必须是中间档，且坏卡时如实返回 null', () => {
  assert.strictEqual(rm.fallbackModeName({}), 'perf');
  const fb = rm.resolveMode(rm.fallbackModeName({}), { card });
  assert.ok(fb);
  // 机器锁：兜底档的 band **不许包含 T3**。包含就等于「出错时落最便宜档」，
  // 而那正是 §5.6 明令禁止的方向（三个独立佐证见 §5.6）。
  assert.notStrictEqual(fb.floor, 'T3', 'fallbackMode 覆盖到 T3 = 出错时静默降最便宜');
  assert.ok(rm.allowsTier(fb, 'T1') || rm.allowsTier(fb, 'T2'), '兜底档必须真的落在中间');

  // 卡坏 / 兜底指向不存在的档 → null（调用方按「模式轴缺席」处理，不猜一个档）
  // 内联卡必须自己声明 fallbackMode；没声明就返回 null（调用方按「模式轴缺席」处理，
  // 不擅自挑一个档当兜底 —— 那是替用户做决定）。
  assert.strictEqual(rm.fallbackModeName({
    KHY_ROUTING_MODES_JSON: JSON.stringify({ fallbackMode: 'perf', modes: { perf: { label: 'P' } } }),
  }), 'perf');
  assert.strictEqual(rm.fallbackModeName({
    KHY_ROUTING_MODES_JSON: JSON.stringify({ modes: { perf: { label: 'P' } } }),
  }), null, '卡里没声明 fallbackMode 却猜一个档 = 替用户决定兜底');
  assert.strictEqual(rm.fallbackModeName({
    KHY_ROUTING_MODES_JSON: JSON.stringify({ fallbackMode: 'ghost', modes: { perf: {} } }),
  }), null);
  assert.strictEqual(rm.fallbackModeName({ KHY_ROUTING_MODES_JSON: '{bad json' }), null);
});

test('requestModeIntent（P2d）：auto 的 β 按主诉内容生效，且缺 margin 只会多想不会少想', () => {
  const saved = process.env.GATEWAY_ROUTING_MODE;
  try {
    process.env.GATEWAY_ROUTING_MODE = 'auto';
    // 1) 命中 debug flag → 抬思考
    const dbg = rm.requestModeIntent({
      tier: 'T1',
      prompt: '这段报错的根因是什么 TypeError: Cannot read properties of undefined',
    });
    assert.ok(dbg, 'auto + 有 flag 的主诉应产出意图');
    assert.ok(dbg.flags.includes('debug'), `flag 没命中: ${JSON.stringify(dbg.flags)}`);
    assert.strictEqual(dbg.thinkingFloor, 'high');

    // 2) 方向安全锁：没有 margin 时，「省思考」的两级绝不能出现
    for (const p of ['好', '继续', '把这里改一下', 'x'.repeat(300)]) {
      const r = rm.requestModeIntent({ tier: 'T3', prompt: p });
      const floor = r ? r.thinkingFloor : null;
      assert.notStrictEqual(floor, 'low', `无 margin 却降到低思考（prompt=${p.slice(0, 8)}）`);
      assert.notStrictEqual(floor, 'none', '无 margin 却取消了下限');
    }

    // 3) 固定档不看主诉：经济档恒 low
    process.env.GATEWAY_ROUTING_MODE = 'economy';
    assert.strictEqual(rm.requestModeIntent({ tier: 'T2', prompt: '好' }).thinkingFloor, 'low');
    assert.strictEqual(
      rm.requestModeIntent({ tier: 'T2', prompt: '生产环境 部署 迁移 删除 回滚' }).thinkingFloor,
      'low',
      '固定档的 β 不该被主诉内容改动（那是 auto 的语义）'
    );

    // 4) 总闸关 → null
    assert.strictEqual(
      rm.requestModeIntent({ tier: 'T1', prompt: '报错', env: { KHY_ROUTING_MODES: '0', GATEWAY_ROUTING_MODE: 'auto' } }),
      null
    );
    // 5) 坏输入不抛。auto 的 β 阶梯（thinking_mode_rules 里 minClass 与 anyFlags 是**或**）：
    //    T0→max、T1→high（类别单独就够）、T2/T3→不干预除非 flag 命中。
    //    所以「无 flag 无 margin」只在 T2/T3 时才返回 null —— 第一版我拿 T1 期待 null，
    //    测的是我对规则的想当然而不是代码。
    assert.doesNotThrow(() => rm.requestModeIntent());
    process.env.GATEWAY_ROUTING_MODE = 'auto';
    assert.strictEqual(rm.requestModeIntent({ tier: 'T3', prompt: null }), null,
      'T3 + 无 flag + 无 margin 不该产出任何意图');
    assert.strictEqual(rm.requestModeIntent({}), null);
    assert.strictEqual(
      rm.requestModeIntent({ tier: 'T1', prompt: null }).thinkingFloor, 'high',
      'T1 类别应单独触发 high');
    assert.strictEqual(
      rm.requestModeIntent({ tier: 'T0', prompt: '' }).thinkingFloor, 'max');
    process.env.GATEWAY_ROUTING_MODE = 'economy';
    const econNoPrompt = rm.requestModeIntent({ tier: 'T2', prompt: null });
    assert.ok(econNoPrompt && econNoPrompt.thinkingFloor === 'low',
      '固定档的 β 必须与主诉无关');
  } finally {
    if (saved === undefined) delete process.env.GATEWAY_ROUTING_MODE;
    else process.env.GATEWAY_ROUTING_MODE = saved;
  }
});

test('band 把候选滤空时显示 —，不显示 0× 或空串', () => {
  // 极致档只允许 T0；给一批 T1/T3 候选
  const extreme = rm.resolveMode('extreme', { card });
  const h = rm.costHintOf(extreme, [
    { model: 'gpt-4o-mini', tier: 'T1' },
    { model: 'ollama-llama3', tier: 'T3' },
  ]);
  assert.strictEqual(h.label, '—');
  assert.strictEqual(h.state, 'empty-band');
});

test('env 内联覆盖优先于仓内文件(运维逃生阀)', () => {
  const env = {
    KHY_ROUTING_MODES_JSON: JSON.stringify({
      defaultMode: 'mydefault',
      modes: { mydefault: { label: 'M', capabilityFloor: 'T1', capabilityCeiling: 'T1' } },
    }),
  };
  const m = rm.resolveMode('whatever', { env });
  assert.strictEqual(m.used, 'mydefault');
  assert.strictEqual(rm.resolveMode('perf', { env }).used, 'mydefault');
  assert.strictEqual(rm.currentModeName({ GATEWAY_ROUTING_MODE: 'Economy' }), 'economy',
    '档名大小写不敏感');
});

// 屏幕上画的是 label（极致/性能/经济），人在 .env 里只会写他看见的那个词。
// 写 UI 显示的词却静默变成 auto = 「选了没用」，而且没有守卫会变红。
test('UI 上显示的档名（label）也是合法档名；不认识的词会被点名而不是静默吞掉', () => {
  const card = rm._loadCard ? rm._loadCard() : null;
  const modes = card && card.modes ? card.modes : {};
  // 配对从**公开**的 listModes 取，确认它和卡里的 key/label 一致（不然选择器画的
  // 与解析器认的是两套名字，本测试就只是在自我确认）。
  const listed = rm.listModes().map((m) => [m.key, String(m.label || '').trim()]);
  assert.ok(listed.length === Object.keys(modes).length, 'listModes 与卡里的档数不一致');
  const pairs = listed.filter(([, lb]) => lb);
  assert.ok(pairs.length >= 2, `卡里可对齐的 key/label 不足 2 对（实际 ${pairs.length}）—— 本测试将空跑`);

  for (const [key, label] of pairs) {
    assert.strictEqual(rm.resolveMode(label).used, key, `label「${label}」应解析到 ${key}`);
    assert.strictEqual(rm.resolveMode(label).unrecognized, false, `「${label}」是卡里的名字，不该算未识别`);
    assert.strictEqual(rm.resolveMode(key).used, key, `key「${key}」仍要直接命中（label 不得遮蔽 key）`);
  }

  // 空档名 = 没配，不是配置错误：必须回默认档，且**不许**标成未识别。
  // 这条锁的是我在实现 label 别名时引入的真实回归：当时把「回退默认档」的条件
  // 从「名字不在卡里」改成了「unrecognized」，于是空串停在 ''，
  // resolveMode('') 返回 null —— 相当于「没配 env」被当成「卡坏了」，模式轴对
  // 未配置的安装直接消失。
  const empty = rm.resolveMode('');
  assert.ok(empty, "resolveMode('') 不得返回 null（没配 ≠ 卡坏）");
  assert.strictEqual(empty.unrecognized, false, '空档名不该被标记为未识别');
  assert.strictEqual(empty.used, String(card.defaultMode || 'auto'));

  // 认识的与不认识的，差别必须留在**非空**那侧。
  const junk = rm.resolveMode('随便写一个不存在的档名');
  assert.strictEqual(junk.used, 'auto', '不认识的档名回默认档，不降档');
  assert.strictEqual(junk.unrecognized, true, '不认识的档名必须可被调用方点名');
  assert.strictEqual(junk.requested, '随便写一个不存在的档名', '原始请求名要留着，状态行才说得出是什么');

  // 别名必须是**逐字面**匹配，不做模糊：「经济型」接到 economy 属于猜用户意图。
  assert.strictEqual(rm.resolveMode('经济型').unrecognized, true, '模糊命中 = 把错配当配置成功');
});

// §15-1 红线：钉选状态下模式轴**一律旁路**，连观测都不写。
// 选路那侧天然满足（钉选时不进入 auto 分支），坏在 β/π 那侧：两个 harnessProfile
// 调用点只看 GATEWAY_ROUTING_MODE + tier，不看有没有钉选 —— 于是用户钉死了通道，
// 思考预算与提示词详略仍被一个他没在用的档改掉，而画面上一切正常。
test('§15-1 钉选时 β/π 整体旁路；auto 哨兵不算钉选', () => {
  const base = { KHY_ROUTING_MODES: '1', GATEWAY_ROUTING_MODE: 'extreme' };
  // 前置：不钉选时这一档必须**真的**给意图，否则下面的断言是在测一个空功能。
  assert.ok(rm.staticIntentForTier('T2', { ...base }), '未钉选时 extreme 应给出 β/π 意图');

  // 钉渠道
  const pinnedAdapter = rm.staticIntentForTier('T2', {
    ...base,
    GATEWAY_PREFERRED_ADAPTER: 'api',
  });
  assert.strictEqual(pinnedAdapter, null, '钉了渠道却仍返回模式意图');
  assert.strictEqual(
    rm.requestModeIntent({ tier: 'T0', prompt: '重构这块路由', env: { ...base, GATEWAY_PREFERRED_ADAPTER: 'api' } }),
    null,
    '钉渠道时 auto 侧的请求内 β 也必须缺席'
  );

  // 钉模型（§15 字面是「渠道**或**模型」）
  assert.strictEqual(
    rm.staticIntentForTier('T2', { ...base, GATEWAY_PREFERRED_MODEL: 'claude-opus-4-7' }),
    null,
    '钉了模型却仍返回模式意图'
  );

  // 哨兵不算钉选：auto 是「没钉」的形态，把它当钉选会让整个档位在默认配置下失效
  assert.strictEqual(rm.pinnedBypass({ GATEWAY_PREFERRED_ADAPTER: 'auto', GATEWAY_PREFERRED_MODEL: 'auto' }), false);
  assert.strictEqual(rm.pinnedBypass({}), false, '什么都没配不是钉选');
  assert.strictEqual(rm.pinnedBypass({ GATEWAY_PREFERRED_ADAPTER: 'api' }), true);
});
