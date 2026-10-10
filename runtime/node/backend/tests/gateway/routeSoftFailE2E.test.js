'use strict';

/**
 * 判据 A4 —— [DESIGN-ARCH-185] §5.6：路由器自己坏了的时候，必须**落中间档**且**不静默**。
 *
 * 为什么必须端到端：这条的性质是「catch 到底把什么写进了样本」。叶子级断言只能证明
 * `fallbackModeName()` 返回 'perf'，证明不了 generate 里那段真的用它、真的把 softFail
 * 传进 observeSelection、真的发了状态行。§16.3 里这格长期是「可执行、未执行」，
 * 卡的就是没有这条注入路径。
 *
 * 注入点：`routeDemand.decide` 抛错（真实模块，只改 require.cache 上的那一个方法）。
 *
 * 三行必须互不相同，所以共用一份候选池：
 *   A 请求 extreme + decide 抛错 → 落 perf（带 {T0,T1}）：T1 可选、T3 出局、softFail 点名、状态行发出
 *   B 请求 extreme + decide 正常 → 留在 extreme（带 {T0}）：T1 **必须**出局
 *     ↑ A 的对照行。没有它，A 里「T1 可选」可能只是因为带约束根本没生效。
 *   C 显式关闸（KHY_ROUTING_MODES=0）→ 模式轴缺席：softFail **必须**为 null
 *     ↑ §5.6 的不对称：运维关闸不是故障，把它记成故障会让 route-replay 的 softFail 计数失真。
 *
 * 另有 D/E 两行验「档名本身」（与软失败正交，共用这套真实 generate 量具最省事）：
 *   D 用**屏幕上显示的那个词**（经济）写进 env → 端到端必须真的按 economy 跑。
 *     修好之前它是红的：resolveMode 只认 key，中文 label 静默回 auto——
 *     用户照 UI 配置，模式轴在场但档名丢了，且没有任何守卫会变红。
 *   E 不认识的档名 → 按默认档跑（不许借机降档），但状态行必须点名、并带上原词。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const h = require('./_ocrGatewayHarness');
const gw = require(BE + '/src/services/gateway/aiGateway');
const routeDemand = require(BE + '/src/services/gateway/routeDemand');
const autoRouting = require(BE + '/src/services/gateway/autoModelRouting');
const routingMode = require(BE + '/src/services/gateway/routingMode');

// 池里刻意**不放 T0**：这样 A 侧 T1 能否入选完全由「落点档的带」决定，
// 而 B 侧 extreme 的带是 {T0}，T1 必然出局 —— 两行才可分离。
const POOL = [{ model: 'zzz-sonnet-4' }, { model: 'zzz-mini' }]; // T1, T3

const env = h.envSandbox([
  'KHY_ROUTING_MODES',
  'GATEWAY_ROUTING_MODE',
  'GATEWAY_PREFERRED_ADAPTER',
  'GATEWAY_PREFERRED_MODEL',
  'KHY_AUTO_MODEL_SELECT',
  'KHY_AUTO_MODEL_HEALTH_AWARE',
  'KHY_ROUTE_DEMAND',
  'KHY_ROUTE_APPLY',
  'KHY_ROUTE_APPLY_STAGE',
  'KHY_TOOL_CAP_PROBE',
]);

let samples = [];
let rec;
const real = {
  observeSelection: autoRouting.observeSelection,
  observeOutcome: autoRouting.observeOutcome,
  observeFailure: autoRouting.observeFailure,
  decide: routeDemand.decide,
  listModels: gw.listModels,
};

function install({ decideThrows = false, activeModel = 'zzz-sonnet-4' } = {}) {
  samples = [];
  rec = h.makeRecordingAdapter({ content: 'A4 已作答' });
  h.wireSingle(rec, { key: 'pool', activeModel });
  // 记录适配器**实际收到**的 model —— 判据 A1 的两行要靠它区分「观测」与「改道」。
  const innerGenerate = rec.adapter.generate.bind(rec.adapter);
  rec.adapter.generate = (p, o) => {
    rec.finalModel = o && o.model;
    return innerGenerate(p, o);
  };
  gw.listModels = async () => POOL.map((r) => ({ ...r }));
  autoRouting.observeSelection = (row) => {
    samples.push(row);
    return null;
  };
  // 三个写手全部截住。本测驱动的是**真实** generate()，成功路径末尾会补一条
  // ev=outcome；而 select 行被我截在内存里 → 磁盘上会留下「有结论、无路由记录」的
  // 孤儿样本，正好污染 §6.1/§14 那条按 turnId join 的 200 样本毕业判据。
  // 实测代价：首版没截时，一次跑往 auto-route.jsonl 写了 3 条这种孤儿行（已清）。
  autoRouting.observeOutcome = () => null;
  autoRouting.observeFailure = () => null;
  routeDemand.decide = decideThrows
    ? () => {
        throw new Error('A4 注入：四道 pass 故障');
      }
    : real.decide;
}

function uninstall() {
  autoRouting.observeSelection = real.observeSelection;
  autoRouting.observeOutcome = real.observeOutcome;
  autoRouting.observeFailure = real.observeFailure;
  routeDemand.decide = real.decide;
  gw.listModels = real.listModels;
}

async function run(tag, extra) {
  const statuses = [];
  const res = await gw.generate(`A4 端到端注入探针 ${tag} ${process.pid}`, Object.assign({
    adapter: 'auto',
    model: 'auto',
    onChunk: (c) => {
      if (c && c.type === 'status' && c.text) statuses.push(c.text);
    },
  }, extra || {}));
  return { res, statuses };
}

describe('A4 端到端注入：软失败落中间档、点名、且不把运维关闸当故障', () => {
  before(async () => {
    env.save();
    env.set({
      GATEWAY_PREFERRED_ADAPTER: 'auto',
      GATEWAY_ROUTING_MODE: 'extreme',
      KHY_ROUTING_MODES: '1',
      KHY_AUTO_MODEL_SELECT: '1',
      KHY_AUTO_MODEL_HEALTH_AWARE: '1',
      KHY_TOOL_CAP_PROBE: 'off',
    });
    // 带约束只在「模式解析成功」时参与；先确认档位卡真的解析得出 perf/extreme，
    // 否则下面三行全都在测一个不存在的功能。
    assert.ok(routingMode.resolveMode('extreme'), '档位卡解析不出 extreme —— 本文件的前置不成立');
    assert.strictEqual(
      routingMode.fallbackModeName(),
      'perf',
      '卡里 fallbackMode 不是 perf —— 断言里的档名需要跟着卡改'
    );
  });

  after(() => {
    uninstall();
    env.restore();
  });

  test('A 注入：decide 抛错 → 落 perf、softFail 点名、T3 出局、状态行发出', async () => {
    install({ decideThrows: true });
    await autoRouting.refreshPool(gw);
    const { statuses } = await run('A');

    assert.strictEqual(samples.length, 1, `样本应恰好 1 条（实际 ${samples.length}）—— auto 分支或观测门没走到`);
    const s = samples[0];
    assert.ok(s.softFail, '软失败必须留痕，不许静默');
    assert.match(String(s.softFail), /A4 注入/, 'softFail 应带上原始故障信息');
    assert.strictEqual(s.mode, 'perf', `软失败应落中间档 perf，实际 ${s.mode}`);

    const tiers = (s.ranked || []).map((r) => r.tier);
    assert.ok(tiers.length > 0, `ranked 为空 —— 带约束没被测量，本行将空跑`);
    assert.ok(tiers.includes('T1'), `落 perf 后 T1 应可选，实际 tiers=${JSON.stringify(tiers)}`);
    assert.ok(!tiers.includes('T3'), `落中间档却仍把 T3 放进候选，tiers=${JSON.stringify(tiers)}`);
    assert.ok(
      statuses.some((t) => /路由降级/.test(String(t))),
      `必须发状态行点名，实际 statuses=${JSON.stringify(statuses)}`
    );
    assert.ok(rec.finalPrompt || s, '生成链路应仍然完成（软失败不得打断作答）');
  });

  test('B 对照：decide 正常 → 留在 extreme，T1 必须出局（证明 A 的 T1 来自落点档）', async () => {
    install({ decideThrows: false });
    await autoRouting.refreshPool(gw);
    await run('B');

    assert.strictEqual(samples.length, 1, 'B 行也必须走到观测点');
    const s = samples[0];
    assert.strictEqual(s.softFail, null, '没故障却记了软失败 → A 的 softFail 不可信');
    assert.strictEqual(s.mode, 'extreme', `未注入时应保持请求档，实际 ${s.mode}`);

    const tiers = (s.ranked || []).map((r) => r.tier);
    assert.ok(
      !tiers.includes('T1'),
      `extreme 的带是 {T0}，T1 不该出现在候选里：tiers=${JSON.stringify(tiers)}。` +
        '若这行变红，说明带约束本就无效，A 行「T1 可选」是假信号。'
    );
  });

  test('C 对照：显式关闸 → 模式轴缺席，绝不算软失败', async () => {
    install({ decideThrows: true });
    env.set({ KHY_ROUTING_MODES: '0' });
    await autoRouting.refreshPool(gw);
    const { statuses } = await run('C');

    assert.strictEqual(samples.length, 1, '关闸时 rank 观测仍在（162 那条线），样本照写');
    const s = samples[0];
    assert.strictEqual(s.mode, null, '关闸 = 模式轴缺席');
    assert.strictEqual(s.softFail, null, '运维显式关闸不是故障；记成故障会污染 route-replay 的 softFail 计数');
    assert.ok(
      !statuses.some((t) => /路由降级/.test(String(t))),
      '关闸时不该发「路由降级」状态行'
    );
    env.set({ KHY_ROUTING_MODES: '1' });
    uninstall();
  });

  // D/E 验的是「屏幕上写着的词，写进 .env 之后到底生不生效」。
  // 选择器画的是 label（经济/性能/极致），而卡的 key 是 economy/perf/extreme ——
  // 修复前 resolveMode('经济') 静默回 auto：模式轴在，档名丢了，且没有任何守卫变红。
  test('D 用 UI 显示的中文档名配置 → 端到端真的按那一档跑（不是被记成 auto）', async () => {
    install({ decideThrows: false });
    env.set({ GATEWAY_ROUTING_MODE: '经济' });
    await autoRouting.refreshPool(gw);
    await run('D');

    assert.strictEqual(samples.length, 1, 'D 行没走到观测点');
    const s = samples[0];
    assert.strictEqual(s.softFail, null, '认识的名字不是故障');
    assert.strictEqual(s.mode, 'economy', `写「经济」应落到 economy 档，实际 ${s.mode}（静默回 auto = 选了没用）`);

    // 只断言 mode 还不够（β 那次的教训）：必须看到**带真的按 economy 收窄**。
    // economy 是 {T2,T1}、auto 是 {T3..T0}，池里有 T3 与 T1 → T3 该出局。
    const tiers = (s.ranked || []).map((r) => r.tier);
    assert.ok(tiers.length > 0, 'ranked 为空，本行将空跑');
    assert.ok(tiers.includes('T1'), `economy 带含 T1，实际 ${JSON.stringify(tiers)}`);
    assert.ok(!tiers.includes('T3'), `economy 带不含 T3，实际 ${JSON.stringify(tiers)}`);
  });

  test('E 不认识的档名 → 按默认档跑，但状态行必须点名（不静默、也不降档）', async () => {
    install({ decideThrows: false });
    env.set({ GATEWAY_ROUTING_MODE: '随便写一个不存在的档名' });
    await autoRouting.refreshPool(gw);
    const { statuses } = await run('E');

    const s = samples[0];
    assert.strictEqual(s.mode, 'auto', '不认识的档名回默认档，不许借机降档');
    assert.strictEqual(s.softFail, null, '拼错档名不是路由器故障，不该计进 softFail');
    assert.ok(
      statuses.some((t) => /档名未识别/.test(String(t))),
      `必须点名，实际 statuses=${JSON.stringify(statuses)}`
    );
    assert.ok(
      statuses.some((t) => /随便写一个不存在的档名/.test(String(t))),
      '状态行要带上用户原本写的是什么，否则无法自查'
    );
  });

  // ── 判据 A1：状态行必须含「档名 + 选中 tier + 原因」────────────────────────────
  // 设计里那条完整状态行长在 **S3 改道分支内部**，于是阶段未到 S3 时 A1 根本不成立
  // ——「只观测不改道」阶段的意义恰恰是让人看见它本来会选谁。F/G 两行把这条链钉住。
  test('F 判据 A1（S1 观测档）：状态行含档名+tier+原因，且**确实没改道**', async () => {
    install({ decideThrows: false, activeModel: 'zzz-mini' });
    env.set({
      GATEWAY_ROUTING_MODE: '经济',
      KHY_ROUTE_APPLY: '0',
      KHY_ROUTE_APPLY_STAGE: 'S1',
    });
    await autoRouting.refreshPool(gw);
    const { statuses } = await run('F');

    const line = statuses.find((t) => /路由\(.*定带/.test(String(t)));
    assert.ok(
      line,
      `A1 要求状态行点名档位，实际 statuses=${JSON.stringify(statuses)}`
    );
    assert.match(String(line), /经济/, '状态行要带档名（用卡里的 label，不是内部 key）');
    assert.match(String(line), /T2[–-]T1/, '状态行要带本档的定带区间');
    assert.match(String(line), /\(T1\)/, '状态行要带选中模型的 tier');
    assert.match(String(line), /成本项未参与/, 'RUNTIME-002：必须说明成本项有没有参与');
    assert.match(String(line), /未改道/, 'S1 阶段必须如实说明没改道');
    // 最强的一条：观测归观测，实际送去适配器的 model 不许被换掉。
    assert.notStrictEqual(
      rec.finalModel,
      'zzz-sonnet-4',
      'S1 只观测却把 model 换成了档内头名 = 提前改道，违反 PROCESS-008 的 S1 语义'
    );
  });

  test('G 判据 A1 的另一半：到 S3 且开了 apply 才真的改道，且不再发「未改道」行', async () => {
    install({ decideThrows: false, activeModel: 'zzz-mini' });
    env.set({
      GATEWAY_ROUTING_MODE: '经济',
      KHY_ROUTE_APPLY: '1',
      KHY_ROUTE_APPLY_STAGE: 'S3',
    });
    try {
      const rm = require('../../src/services/gateway/routingMode');
      // 前置**不许静默跳过**（跳过的绿行等于没测）。放行与否由三层判定给答案，
      // 没放行就把「被哪一层挡住」写进断言消息里 —— applyBlockedBy 就是为此存在的。
      assert.strictEqual(
        rm.isApplyEnabled(process.env),
        true,
        `apply 未放行: ${rm.applyBlockedBy(process.env)}（本行需要登记表有 KHY_ROUTE_APPLY + env 开 + 阶段 S3）`
      );
      await autoRouting.refreshPool(gw);
      const { statuses } = await run('G');

      const applied = statuses.find((t) => /^路由: /.test(String(t)));
      assert.ok(applied, `应发改道行，实际 statuses=${JSON.stringify(statuses)}`);
      assert.ok(
        !statuses.some((t) => /未改道/.test(String(t))),
        '改道时不能再发观测行（两行同现 = 状态与实际不符）'
      );
      assert.strictEqual(
        rec.finalModel,
        'zzz-sonnet-4',
        'apply 开启后必须真的把 model 换成档内头名（经济带 {T2,T1} 里 T1 胜出，T3 被带滤掉）'
      );
    } finally {
      env.set({ KHY_ROUTE_APPLY: '0', KHY_ROUTE_APPLY_STAGE: 'S1' });
    }
  });

  // H 是 §15-2 的**接缝**证明：新叶子写得再对，如果 generate 不传，四道 pass 依然 query-only。
  // 上一轮我在这个形态上错过两次（β 只接了一处 profile、stateInputs 算出来却没进样本白名单），
  // 所以这条不做单元测，直接驱动真实 generate。
  test('H 判据 §15-2：带真实对话历史的请求，demand 不再自称 query-only', async () => {
    install({ decideThrows: false });
    env.set({ GATEWAY_ROUTING_MODE: 'auto', KHY_ROUTE_APPLY: '0', KHY_ROUTE_APPLY_STAGE: 'S1' });
    await autoRouting.refreshPool(gw);

    const history = [
      { role: 'user', content: 'y'.repeat(3000) },
      { role: 'assistant', content: 'z'.repeat(3000) },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '失败', is_error: true }] },
    ];
    await run('H', { messages: history, contextWindow: 16000, turnIndex: 4 });

    assert.strictEqual(samples.length, 1, 'H 行没走到观测点');
    const s = samples[0];
    assert.ok(s.demand, '样本里应有 demand');
    assert.ok(s.demand.stateInputs, 'stateInputs 必须在样本里（§16.4n 的那道白名单）');
    assert.strictEqual(
      s.demand.stateInputs.queryOnly,
      false,
      `带真实历史与窗口却仍标 query-only ⇒ 接缝没接上：${JSON.stringify(s.demand.stateInputs)}`
    );
    // 只断言 generate 这一侧**能**自己算出来的四个；hasImage 不在其中 ——
    // 它只有调用方（知道图在哪一层）才说得出，从 messages 里猜会猜错。
    for (const k of ['ctxRatio', 'estCtxTokens', 'toolFails', 'turnIndex']) {
      assert.ok(
        s.demand.stateInputs.present.includes(k),
        `${k} 应由 generate 供给侧补上，实际 present=${JSON.stringify(s.demand.stateInputs.present)}`
      );
    }
    assert.ok(
      s.demand.stateInputs.absent.includes('hasImage'),
      'hasImage 不该被假装成已知（它只能由调用方声明）'
    );

    // 对照（**这一条第一版是我写错的期望，不是代码错**）：不带历史时，
    // `estCtxTokens`(主诉本身的体量) 与 `toolFails`(无历史 ⇒ 真 0) 仍是**真实**执行状态，
    // 所以 queryOnly 为 false 是对的；真正不可知的是**占比** —— 没给窗口就不许编一个 0。
    await run('H2', { turnIndex: 1 });
    const s2 = samples[samples.length - 1];
    assert.ok(
      s2.demand.stateInputs.absent.includes('ctxRatio'),
      `没给窗口时占比必须是缺席，实际 ${JSON.stringify(s2.demand.stateInputs)}`
    );
    assert.ok(
      s2.demand.stateInputs.present.includes('estCtxTokens'),
      '主诉体量是真实可算的，不该被当成缺输入'
    );
    assert.ok(s2.demand.stateInputs.absent.includes('hasImage'), 'hasImage 只能由调用方声明');
  });

  // §5.2 的 β：档位卡写着 thinking=max/extreme，而 `thinkingFloor` 的唯一消费者
  //（toolUseLoopCore 的 auto-reasoning 段）只在 `reasoning_effort === 'auto'` 的请求上运行，
  // 且**全仓没有任何生产方把 effort 设成 'auto'**（EFFORT_PRESETS 只有 max/high/medium/low）。
  // 两行都是正向断言 —— 上一轮我写过「A 与 B 一致」这种两边皆零也成立的对照，这次不复犯。
  test('K β 的载体缺位必须被量出来：extreme 档 + 无 effort ⇒ carried=false', async () => {
    install({ decideThrows: false });
    env.set({ GATEWAY_ROUTING_MODE: 'extreme' });
    await autoRouting.refreshPool(gw);
    await run('K');

    const s = samples[samples.length - 1];
    assert.ok(s.beta, `样本里应有 beta 读数（键：${JSON.stringify(Object.keys(s))}）`);
    assert.strictEqual(s.beta.declared, 'max', `extreme 档应声明 max，实际 ${s.beta.declared}`);
    assert.strictEqual(s.beta.carried, false, '没带 reasoning_effort 的请求不该有 β 载体');
    // §5.4 目标侧的接缝：档卡的 strongShare 必须随观测一起出去（M33 证明这行不是装饰）
    assert.strictEqual(
      s.strongTarget,
      1,
      `extreme 档的 strongShare=1.0 没随样本写出，实际 ${JSON.stringify(s.strongTarget)}`
    );
  });

  test('K2 同一档位、请求显式带 reasoning_effort=auto ⇒ carried=true（载体的正反两面）', async () => {
    install({ decideThrows: false });
    env.set({ GATEWAY_ROUTING_MODE: 'extreme' });
    await autoRouting.refreshPool(gw);
    await run('K2', { reasoningEffort: 'auto' });

    const s = samples[samples.length - 1];
    assert.ok(s.beta, '样本里应有 beta 读数');
    assert.strictEqual(s.beta.declared, 'max', '档位声明不变');
    assert.strictEqual(
      s.beta.carried,
      true,
      `带 effort=auto 时载体必须在场，实际 ${JSON.stringify(s.beta)} ⇒ 载体判据读错了字段`
    );
  });
});
