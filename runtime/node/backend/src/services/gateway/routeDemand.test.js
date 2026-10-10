'use strict';

/**
 * routeDemand 的对抗性测试。
 *
 * 重心不在「算得出档位」,而在三条容易被无声违反的纪律:
 *   单词命中不得抬档(实测 73.8% 误报,见 works/data/khy/feedback/185-p0-price-truth/flag-false-positive.md)
 *   经济档永不到 T0(否则「经济」只是 auto 的别名)
 *   打分失败落中间值而不是 0(0 = 判成最便宜,是危险方向)
 */

const test = require('node:test');
const assert = require('node:assert');

const rd = require('./routeDemand');
const rm = require('./routingMode');

const card = rm._loadCard({});
const modeOf = (n) => rm.resolveMode(n, { card });

function tierOf(prompt, modeName, ctx) {
  const r = rd.decide(prompt, Object.assign({ card, mode: modeOf(modeName) }, ctx || {}));
  assert.ok(r, 'decide 返回 null');
  return r;
}

test('卡与词表真的加载到了(防空配置假绿)', () => {
  assert.ok(card && card.flag_rules, 'routing-modes.json 未加载');
  assert.ok(Array.isArray(card.flag_rules.high_risk.keywords_zh)
    && card.flag_rules.high_risk.keywords_zh.length > 5, 'high_risk 词表缺失或过短');
  const f = rd.extractFeatures('帮我迁移一下目录', {});
  f.text = '帮我迁移一下目录';
  const hits = rd.matchFlagsDetailed(f, card);
  assert.deepStrictEqual(hits, [{ flag: 'high_risk', hits: 1 }], '词表命中链路本身不通');
});

test('REGRESSION LOCK: 单个风险词不得抬档(实测 73.8% 语料误报)', () => {
  const single = tierOf('帮我迁移一下目录', 'economy');
  assert.strictEqual(single.tier, 'T2', '单词命中把经济档抬走了 —— 这正是 73.8% 误报的来源');
  assert.ok(single.flags.includes('high_risk'), '命中信息不应丢失,只是不该夺走降档权');

  const double = tierOf('在生产环境部署这个迁移并删除旧表', 'economy');
  assert.strictEqual(double.tier, 'T1', '多词共现必须抬档,否则 minHits 是把门焊死');
});

test('经济档永远到不了 T0,无论输入多吓人', () => {
  const scary = '生产环境 部署 迁移 回滚 删除 覆盖 客户 法务 财务 凭据 密钥 '
    + 'deploy rollback migration overwrite production credential secret\n'
    + '```js\nconst a = 1;\n'.repeat(200)
    + '\nTraceback (most recent call last):\nTypeError: x\n';
  const eco = tierOf(scary, 'economy');
  assert.strictEqual(eco.tier, 'T1', '经济档 ceiling=T1;越界即与 auto 语义重叠');
  // 同一输入在 auto 下应当允许更强 —— 证明差异来自档位而不是打分坏了
  const auto = tierOf(scary, 'auto');
  assert.ok(['T0', 'T1'].includes(auto.tier), `auto 应能上到强档,实际 ${auto.tier}`);
});

test('极致档恒 T0:band 收束在两端都生效', () => {
  assert.strictEqual(tierOf('好', 'extreme').tier, 'T0');
  assert.strictEqual(tierOf('在生产环境部署并删除', 'extreme').tier, 'T0');
});

test('多模态是硬约束,不是权重', () => {
  const r = tierOf('看这张图', 'economy', { hasImage: true });
  assert.strictEqual(r.capabilityRequired, 'vision');
  // 权重表里 hasImage 记 0 —— 它不该通过加权重影响档位
  assert.strictEqual(card.demand_weights.hasImage, 0);
});

test('trivial 短路要求「无任何 flag 命中」,不是「很短」', () => {
  const plain = tierOf('好的', 'auto');
  assert.strictEqual(plain.admitted, true);
  assert.strictEqual(plain.tier, 'T3');
  // 同样短,但含风险词 → 不许走 trivial 快路。
  // 用表里的原词「删除」而不是口语「删掉」:词表命中是字面包含,
  // 这条同时也是「词表覆盖范围」的可见文档。
  const risky = tierOf('删除吧', 'auto');
  assert.ok(risky.flags.includes('high_risk'), '词表应命中「删除」');
  assert.strictEqual(risky.admitted, false, '有 flag 命中时不得走 trivial 短路');
});

test('会话深度规则:第 4 轮之后不许留在最便宜档(E1 context_rules)', () => {
  assert.strictEqual(tierOf('继续', 'auto', { turnIndex: 1 }).tier, 'T3');
  assert.ok(['T0', 'T1', 'T2'].includes(tierOf('继续', 'auto', { turnIndex: 9 }).tier));
  assert.strictEqual(tierOf('继续', 'economy', { turnIndex: 9 }).tier, 'T2');
});

test('打分内部异常落中间值 0.5,不落 0', () => {
  // 0 会被映射到最便宜档 —— 「算不出来」绝不能等于「这题很简单」
  const w = card.demand_weights;
  const broken = JSON.parse(JSON.stringify(card));
  broken.demand_weights = { flags: { high_risk: { bad: 1 } } };
  const m = modeOf('auto');
  const r = rd.decide('生产环境 部署 迁移', { card: broken, mode: m });
  assert.ok(r, '坏权重表不应导致 decide 返回 null');
  assert.ok(r.demand > 0 && r.demand < 1, `demand=${r.demand},应落在中间区间`);
  assert.ok(w.flags.high_risk > 0, '对照:正常表应有 high_risk 权重');
});

test('打分器抛异常落中间值 0.5,不落 0(catch 路径)', () => {
  // 上面那条走的是「坏权重表」分支；catch 分支此前无人守——变异控制 8 把 scoreDemand 的
  // catch 兜底从 0.5 改成 0 时全套仍 16 绿，那才是这条存在的理由。
  // 0 会被映射到最便宜档：「算不出来」不等于「这题很简单」。
  const throwing = JSON.parse(JSON.stringify(card));
  Object.defineProperty(throwing, 'demand_weights', {
    get() { throw new Error('controlled throw'); },
    configurable: true,
  });
  const r = rd.decide('生产环境 部署 迁移', { card: throwing, mode: modeOf('auto') });
  assert.ok(r, '读权重表抛异常时 decide 仍应给出结果，而不是 null');
  assert.ok(
    r.demand > 0 && r.demand < 1,
    `demand=${r.demand}: catch 兜底必须落中间值，落 0 就等于把「算不出来」判成「最便宜」`
  );
});

test('确定性:同输入两次结果逐字段相同', () => {
  const p = '帮我把 monorepo 的依赖分层重构一下，报错 TypeError: Cannot read properties';
  const a = tierOf(p, 'auto');
  const b = tierOf(p, 'auto');
  assert.deepStrictEqual(
    { tier: a.tier, demand: a.demand, flags: a.flags, reasons: a.reasons },
    { tier: b.tier, demand: b.demand, flags: b.flags, reasons: b.reasons }
  );
});

test('绝不抛:畸形输入一律 null 或安全值', () => {
  const m = modeOf('auto');
  for (const junk of [null, undefined, 42, {}, []]) {
    assert.strictEqual(rd.decide(junk, { card, mode: m }).tier !== undefined, true,
      'decide 对畸形 prompt 应仍能出结果(按空文本处理)');
  }
  assert.strictEqual(rd.decide('x', { card: null, mode: m }), null);
  assert.strictEqual(rd.decide('x', { card, mode: null }), null);
  assert.deepStrictEqual(rd.matchFlagsDetailed(null, card), []);
  assert.ok(rd.extractFeatures(undefined, {}).chars === 0);
});

test('feature 抽取:代码块 / 文件引用 / CJK 比例都真的算出来了', () => {
  const p = '看 a.js 和 b.py 的实现\n```js\nconst x = 1;\nconsole.log(x);\n```\n这段中文呢';
  const f = rd.extractFeatures(p, {});
  assert.ok(f.codeBlockChars > 10, `codeBlockChars=${f.codeBlockChars}`);
  assert.strictEqual(f.fileRefs, 2);
  assert.ok(f.cjkRatio > 0.05, `cjkRatio=${f.cjkRatio} —— CJK 正则失效时这里是 0 且不报错`);
  assert.deepStrictEqual(f.incomplete, [], '任何特征没算出来都必须登记');
});

test('REGRESSION: console.log(x) 不算文件引用（旧正则用 (?![\\w(]) 排除）', () => {
  // 改成逐 token 判后缀时差点丢了这条排除：token `console.log` 确实以 .log 结尾。
  assert.strictEqual(rd.extractFeatures('调用 console.log(x) 和 util.format(y)', {}).fileRefs, 0);
  // 真文件仍要算上
  assert.strictEqual(rd.extractFeatures('改 config.yaml 和 src/index.ts', {}).fileRefs, 2);
});

test('REGRESSION: 长无点号串不得退化成 O(n²)（实测曾 6500 字符 → 25ms）', () => {
  // 旧正则 `[\w./\\-]+\.(?:…)` 在无点长串上每个起点都贪婪吞到串尾再回溯。
  // 这里给一个宽松上界：旧实现按平方律 20000 字符约需 230ms，新实现应远低于 50ms。
  const long = 'x'.repeat(20000);
  rd.extractFeatures(long, {}); // 预热
  const t0 = process.hrtime.bigint();
  const f = rd.extractFeatures(long, {});
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(f.fileRefs, 0);
  assert.ok(ms < 50, `20000 字符抽取耗时 ${ms.toFixed(1)}ms —— 疑似回到平方律`);
});

// §15-2 的可见化：判据来自几条执行状态，必须能在样本里看见。
// 现在实测三个输入(ctxRatio/estCtxTokens/toolFails)全仓无生产方 ⇒ queryOnly 为真。
// 这条测试不是为了「通过」，是为了让人看见这件事，并在生产方补上后自动翻向另一边。
test('§15-2 decide 报告执行状态覆盖度；只有主诉时如实承认接近 query-only', () => {
  const rd = require('./routeDemand');
  const rm = require('./routingMode');
  const mode = rm.resolveMode('auto');
  const card = rm._loadCard();
  assert.ok(mode && card, '档位卡不可读 —— 本测试的前置不成立');

  const bare = rd.decide('重构这块路由逻辑，要把通道拆开', { mode, card });
  assert.ok(bare, 'decide 应返回结果');
  assert.ok(bare.stateInputs, 'decide 必须带 stateInputs（否则 §15-2 的自查是空话）');
  assert.deepStrictEqual(
    bare.stateInputs.present.filter((k) => k !== 'hasImage'),
    [],
    `只给主诉时不该有任何执行状态输入，实际 present=${JSON.stringify(bare.stateInputs.present)}`
  );
  assert.strictEqual(bare.stateInputs.queryOnly, true, '只有主诉时必须如实标 queryOnly');

  const withState = rd.decide('重构这块路由逻辑，要把通道拆开', {
    mode,
    card,
    ctxRatio: 0.62,
    estCtxTokens: 48000,
    toolFails: 2,
    turnIndex: 7,
    hasImage: true,
  });
  assert.strictEqual(withState.stateInputs.queryOnly, false, '有执行状态时不得仍标 queryOnly');
  assert.strictEqual(withState.stateInputs.present.length, 5);
  // 有执行状态与没有，判据应当真的不同（否则这个字段只是装饰）
  assert.notStrictEqual(
    withState.demand,
    bare.demand,
    '执行状态输入未参与打分 —— 那 §5.1 的「风险定价」就只是文字'
  );
});

// 读数诚实性：`estCtxTokens` 在没有历史时是拿主诉文本估的。
// 把它当「执行状态」会让一轮什么都没带的请求被 replay 报成「有执行状态」——
// 那是仪器自己造分母，与本方案反对的「编造价」同一种病。
test('§15-2 queryOnly 只数独立于主诉的信号；estCtxTokens 单独不算证据', () => {
  const rd = require('./routeDemand');
  const rm = require('./routingMode');
  const mode = rm.resolveMode('auto');
  const card = rm._loadCard();
  assert.ok(mode && card, '档位卡不可读 —— 前置不成立');

  const promptOnly = rd.decide('重构这块路由逻辑，要把通道拆开', {
    mode,
    card,
    estCtxTokens: 1234, // 由主诉文本本身估出来的体量
  });
  assert.ok(promptOnly, 'decide 应返回结果');
  assert.ok(promptOnly.stateInputs.present.includes('estCtxTokens'),
    '取到的东西要如实列在 present 里（看得见），但不能拿去充当证据');
  assert.deepStrictEqual(promptOnly.stateInputs.independent, [],
    '没有任何独立信号时 independent 必须是空数组');
  assert.strictEqual(promptOnly.stateInputs.queryOnly, true,
    '只有主诉体量时仍须如实承认 query-only —— 否则 replay 的覆盖度会被自己灌高');

  // 带一个真独立信号（历史里的工具失败数）⇒ 才允许翻成非 query-only
  const withReal = rd.decide('重构这块路由逻辑，要把通道拆开', {
    mode, card, estCtxTokens: 1234, toolFails: 3,
  });
  assert.deepStrictEqual(withReal.stateInputs.independent, ['toolFails']);
  assert.strictEqual(withReal.stateInputs.queryOnly, false);
});

// 空洞值不算证据：首轮请求天然 toolFails=0 / ctxRatio=0 / hasImage=false。
// 若按「字段有值」判定，replay 的覆盖度会被仪器自己的默认值灌高。
test('§15-2 空洞的 0 / false 不算执行状态；非零才算', () => {
  const rd = require('./routeDemand');
  const rm = require('./routingMode');
  const mode = rm.resolveMode('auto');
  const card = rm._loadCard();

  const vacuous = rd.decide('把这里改一下', {
    mode, card, toolFails: 0, ctxRatio: 0, hasImage: false, turnIndex: 0,
  });
  assert.deepStrictEqual(vacuous.stateInputs.independent, [],
    `全是空值时不得有任何独立信号，实际 ${JSON.stringify(vacuous.stateInputs.independent)}`);
  assert.strictEqual(vacuous.stateInputs.queryOnly, true, '空值冒充证据 ⇒ 覆盖度被自己灌高');
  assert.strictEqual(vacuous.stateInputs.present.length, 4, '取到过的字段仍要如实列在 present 里');

  const real = rd.decide('把这里改一下', { mode, card, toolFails: 0, ctxRatio: 0.62 });
  assert.deepStrictEqual(real.stateInputs.independent, ['ctxRatio'], '非零占比才是真信号');
  assert.strictEqual(real.stateInputs.queryOnly, false);

  const img = rd.decide('看图', { mode, card, toolFails: 0, hasImage: true });
  assert.deepStrictEqual(img.stateInputs.independent, ['hasImage'], 'hasImage=true 是真信号，false 不是');
});
