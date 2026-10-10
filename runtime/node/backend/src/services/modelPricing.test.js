'use strict';

/**
 * modelPricing 的对抗性回归测试。
 *
 * 这个文件存在的理由是 [DESIGN-ARCH-185] §3.4 那个缺陷的形状:它**不会**让任何东西变红 ——
 * 价格照样算出来、账单照样显示、测试照样绿,只是 claude-opus 与 gpt-4o-mini 报同一个数。
 * 所以下面每条断言都刻意写成「若实现退回到静默兜底,这条必须失败」,而不是「返回了个东西」。
 *
 * 跑法:node --test src/services/modelPricing.test.js(jest.config.js 会把 node:test 系让给内置 runner)
 */

const test = require('node:test');
const assert = require('node:assert');

const mp = require('./modelPricing');
const tokenPricing = require('./tokenPricing');

const IN = 20000;
const OUT = 2000;

test('表真的加载到了东西(防空表假绿)', () => {
  const r = mp.resolvePrice('gpt-4o-mini');
  assert.ok(r, 'resolvePrice returned nothing');
  // 若 config/models/pricing.json 读不到,families 为空 → 下面所有 priced 断言都会
  // 以「unknown」通过式失败,但这条先给出可诊断的原因。
  assert.strictEqual(
    r.state,
    'priced',
    `价格表未加载或路径错:got ${r.state}/${r.via}`
  );
});

test('A8:claude-opus 与 gpt-4o-mini 不再拿到同一个价', () => {
  const mini = mp.estimateCostDetailed(IN, OUT, 'gpt-4o-mini');
  const opus = mp.estimateCostDetailed(IN, OUT, 'claude-opus-4-7');

  assert.strictEqual(mini.state, 'priced');
  assert.strictEqual(mini.via, 'family');
  // 精确值:0.15/1M * 20000 + 0.6/1M * 2000 = 0.003 + 0.0012
  assert.ok(Math.abs(mini.costUSD - 0.0042) < 1e-9, `mini=${mini.costUSD}`);

  // opus 的价本仓从未公布 → 必须是 unknown 且 cost 为 null,
  // 而不是旧实现那个与 mini 相等的 default 兜底。
  assert.strictEqual(opus.state, 'unknown');
  assert.strictEqual(opus.costUSD, null);
  assert.notStrictEqual(mini.costUSD, opus.costUSD);
});

test('回归锁:旧的编造 default 不可再被模型名触达', () => {
  // 修复前:estimateCost(20000,2000,'claude-opus-4-7') === 0.0026(default 兜底)
  const legacyFabricated = 0.0026;
  const now = tokenPricing.estimateCost(IN, OUT, 'claude-opus-4-7');
  assert.strictEqual(now, 0, `仍返回编造的 default 价:${now}`);
  assert.notStrictEqual(now, legacyFabricated);
});

test('家族声明顺序即优先级:70B 特例不得被泛化条抢走', () => {
  // 这条测的是本表唯一的机器不可守不变量(_ordering_note)。
  // 把 pricing.json 里两条 llama-3.3 的顺序换一下,这条必须变红。
  const groq = mp.resolvePrice('llama-3.3-70b-turbo');
  assert.strictEqual(groq.state, 'priced');
  assert.strictEqual(groq.price.input, 0.88, '拿到的是 Groq 的价 → 顺序错');
  assert.match(groq.source, /Together/);

  const plain = mp.resolvePrice('llama-3.3-instruct');
  assert.strictEqual(plain.price.input, 0.05, '泛化条自身也应命中');
});

test('不跨小版本外推:glm-4 的价不得盖到 glm-4.6 上', () => {
  assert.strictEqual(mp.resolvePrice('glm-4').state, 'priced');
  // 「未公布的价格」必须保持「不知道」,否则就是把外推当数据。
  assert.strictEqual(mp.resolvePrice('glm-4.6').state, 'unknown');
  assert.strictEqual(mp.resolvePrice('glm-4.6').price, null);
});

test('free 与 flat 是两件事:本地推理=最便宜,订阅包月=不可计价', () => {
  const local = mp.resolvePrice('ollama-llama3');
  assert.strictEqual(local.state, 'free');
  assert.ok(mp.isCostUsable(local.state), 'free 应作为成本项参与(它真的最便宜)');

  const sub = mp.resolvePrice('kiro-default');
  assert.strictEqual(sub.state, 'flat');
  assert.ok(!mp.isCostUsable(sub.state), 'flat 若被当成免费,路由器会把流量全推过去');
  assert.strictEqual(mp.estimateCostDetailed(IN, OUT, 'kiro-default').costUSD, null);
});

test('provider 粗价命中记 assumed,且成本项退出', () => {
  const r = mp.resolvePrice('Anthropic');
  assert.strictEqual(r.state, 'assumed', 'provider 级价格不得伪装成模型级 priced');
  assert.ok(!mp.isCostUsable(r.state));
  assert.strictEqual(mp.estimateCostDetailed(IN, OUT, 'Anthropic').costUSD, null);
});

test('priceCoverage:只要有一个不可用状态,allUsable 必须为 false', () => {
  const clean = mp.priceCoverage(['gpt-4o-mini', 'ollama-llama3']);
  assert.ok(clean.total > 0, '输入为空 —— 空数组会让 allUsable 假真');
  assert.strictEqual(clean.allUsable, true);
  assert.strictEqual(clean.usable, 2);

  const dirty = mp.priceCoverage(['gpt-4o-mini', 'claude-opus-4-7']);
  assert.strictEqual(dirty.allUsable, false);
  assert.strictEqual(dirty.byState.unknown, 1);

  // 空输入的语义是「无从判断」,不是「全部可用」
  const empty = mp.priceCoverage([]);
  assert.strictEqual(empty.total, 0);
  assert.strictEqual(empty.allUsable, false);
});

test('坏表 / 坏正则 / 坏入参一律收敛到 unknown,绝不抛', () => {
  const badTable = {
    families: [
      { id: 'broken', match: '([unclosed', price: { input: 1, output: 1 } },
      { id: 'ok', match: 'goodmodel', price: { input: 2, output: 2 } },
    ],
    models: {},
  };
  assert.strictEqual(mp.resolvePrice('goodmodel', { table: badTable }).state, 'priced');
  assert.strictEqual(mp.resolvePrice('anything-else', { table: badTable }).state, 'unknown');

  for (const junk of [null, undefined, 42, {}, [], '']) {
    const r = mp.resolvePrice(junk, { table: badTable });
    assert.strictEqual(r.state, 'unknown', `非字符串入参未收敛:${String(junk)}`);
  }

  const badInline = { KHY_MODEL_PRICING_JSON: '{not json' };
  assert.strictEqual(mp.resolvePrice('gpt-4o-mini', { env: badInline }).state, 'unknown');
});

test('back-compat:provider 粗价改走 assumed,但 record 求和路径不受影响', () => {
  // estimateCost 走模型价解析:provider 键只有粗价 → assumed → 成本项退出(返回 0)。
  // 这是**有意的行为变更**([DESIGN-ARCH-185] §3.4):宁可没有数字,不要假数字。
  const viaModel = mp.estimateCostDetailed(IN, OUT, 'DeepSeek');
  assert.strictEqual(viaModel.state, 'assumed');
  assert.strictEqual(viaModel.costUSD, null);
  assert.strictEqual(tokenPricing.estimateCost(IN, OUT, 'DeepSeek'), 0);

  // 而 sumRecordsCost / calculateCost 用的是 record.provider 精确键,这条路径一字未动,
  // 会话总额与账单仍照旧 —— 锁住它是为了证明「退出成本项」只发生在模型级估算上。
  const summed = tokenPricing.sumRecordsCost([
    { provider: 'DeepSeek', inputTokens: IN, outputTokens: OUT },
  ]);
  assert.ok(Math.abs(summed.costUSD - 0.0076) < 1e-9, `summed=${summed.costUSD}`);
});

test('负数 token 不钳位(数学叶子不做上游的事),但负价格声明必须被拒', () => {
  // 两个方向不同的规则,容易在实现里被一个 _isNum 混掉 —— 混掉的后果是「坏配置 = 最便宜」,
  // 路由器会把流量全推给一个价格写成负数的渠道。
  const neg = mp.estimateCostDetailed(-1000000, 0, 'gpt-4o-mini');
  assert.ok(Math.abs(neg.costUSD + 0.15) < 1e-9, `costUSD=${neg.costUSD}`);

  const badTable = {
    families: [{ id: 'negative-price', match: 'evil', price: { input: -5, output: -5 } }],
    models: {},
  };
  const r = mp.resolvePrice('evil-model', { table: badTable });
  assert.strictEqual(r.state, 'unknown', '负价被当成合法价格接受了');
  assert.ok(!mp.isCostUsable(r.state));
});

test('env 内联覆盖优先于仓内文件(运维逃生阀)', () => {
  const env = {
    KHY_MODEL_PRICING_JSON: JSON.stringify({
      families: [{ id: 'x', match: 'mythical', price: { input: 1, output: 1 } }],
    }),
  };
  assert.strictEqual(mp.resolvePrice('mythical-model', { env }).state, 'priced');
  assert.strictEqual(mp.resolvePrice('gpt-4o-mini', { env }).state, 'unknown');
});

test('家族覆盖范围由 source 注释是否点名版本决定(把规则写出来而不是藏在正则里)', () => {
  // 注释点了版本号的行 → 只覆盖该版本本体与日期后缀:glm-4 有价,glm-4.6 无价(上一条测过)。
  assert.strictEqual(mp.resolvePrice('glm-4-0109').state, 'priced', '日期后缀应视为同型号');
  // 注释只写家族名、无版本的行(ERNIE)→ 家族级覆盖。
  // 这条断言不是在证明它「对」,而是在把当前的取舍钉住:改任何一行的 match 都会撞到这里。
  assert.strictEqual(mp.resolvePrice('ernie-speed-128k').state, 'priced');
  assert.strictEqual(mp.resolvePrice('ernie-4.5').state, 'priced');
});
