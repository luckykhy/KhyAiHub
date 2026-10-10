'use strict';

/**
 * autoModelSelect.test.js — 纯叶子契约:模型列表「Auto」入口 + 任务感知的可用模型排序。
 * /goal「khy 在模型列表下设置一个 auto 模型自动选择最适合当前任务且可用的模型模式」。
 *
 * 覆盖:门控(flagRegistry 优先 + 本地 CANON 回退)、isAutoSelection 各形状、rankAutoModels
 * 的任务→tier 贴合度 + 可用性过滤 + 稳定/确定性、pickAutoModel 头名、buildAutoChoice 形状与
 * 预览、fail-soft。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/gateway/autoModelSelect'));

test('isEnabled: default ON; CANON off-words disable', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_AUTO_MODEL_SELECT: 'true' }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(leaf.isEnabled({ KHY_AUTO_MODEL_SELECT: off }), false, `off=${off}`);
  }
  // non-CANON word stays ON (superset-safe)
  assert.equal(leaf.isEnabled({ KHY_AUTO_MODEL_SELECT: 'disabled' }), true);
});

test('isAutoSelection: object/string/edge shapes', () => {
  assert.equal(leaf.isAutoSelection({ adapter: 'auto', model: 'auto' }), true);
  assert.equal(leaf.isAutoSelection({ adapter: 'AUTO', model: 'x' }), true);
  assert.equal(leaf.isAutoSelection({ adapter: 'api', model: 'auto' }), true);
  assert.equal(leaf.isAutoSelection('auto'), true);
  assert.equal(leaf.isAutoSelection(' Auto '), true);
  assert.equal(leaf.isAutoSelection({ adapter: 'api', model: 'glm-4.6' }), false);
  assert.equal(leaf.isAutoSelection(null), false);
  assert.equal(leaf.isAutoSelection(42), false);
});

test('rankAutoModels: filters unavailable (disabled/cooldown)', () => {
  const cands = [
    { model: 'a', tier: 'T2', status: 'active' },
    { model: 'b', tier: 'T2', status: 'disabled' },
    { model: 'c', tier: 'T2', status: 'cooldown' },
    { model: 'd', tier: 'T2', status: '' }, // unknown status → treated available
  ];
  const ranked = leaf.rankAutoModels('conversation', cands);
  const ids = ranked.map((r) => r.model);
  assert.ok(ids.includes('a'));
  assert.ok(ids.includes('d'));
  assert.ok(!ids.includes('b'));
  assert.ok(!ids.includes('c'));
});

test('rankAutoModels: reasoning prefers strongest tier (T0), conversation prefers balanced (T2)', () => {
  const cands = [
    { model: 'light', tier: 'T3', status: 'active' },
    { model: 'balanced', tier: 'T2', status: 'active' },
    { model: 'strong', tier: 'T1', status: 'active' },
    { model: 'flagship', tier: 'T0', status: 'active' },
  ];
  assert.equal(leaf.pickAutoModel('reasoning', cands).model, 'flagship');
  assert.equal(leaf.pickAutoModel('conversation', cands).model, 'balanced');
  assert.equal(leaf.pickAutoModel('code', cands).model, 'strong');
});

test('rankAutoModels: deterministic + stable (tie broken by original index)', () => {
  const cands = [
    { model: 'x', tier: 'T2', status: 'active' },
    { model: 'y', tier: 'T2', status: 'active' },
    { model: 'z', tier: 'T2', status: 'active' },
  ];
  const a = leaf.rankAutoModels('conversation', cands).map((r) => r.model);
  const b = leaf.rankAutoModels('conversation', cands).map((r) => r.model);
  assert.deepEqual(a, b);
  assert.deepEqual(a, ['x', 'y', 'z']); // all T2 → tie → original order
});

test('rankAutoModels: source credibility breaks tier ties (remote/chat > config > hint)', () => {
  const cands = [
    { model: 'hinted', tier: 'T2', status: 'active', source: 'hint' },
    { model: 'remoted', tier: 'T2', status: 'active', source: 'remote' },
    { model: 'configed', tier: 'T2', status: 'active', source: 'config' },
  ];
  assert.equal(leaf.pickAutoModel('conversation', cands).model, 'remoted');
});

test('rankAutoModels: bare string ids + tier inferred via modelTier', () => {
  const ranked = leaf.rankAutoModels('conversation', ['glm-4.6', 'some-model']);
  assert.ok(Array.isArray(ranked));
  assert.ok(ranked.length >= 1);
  ranked.forEach((r) => assert.ok(/^T[0-3]$/.test(r.tier)));
});

test('rankAutoModels: dedupe by model id (first wins)', () => {
  const cands = [
    { model: 'dup', tier: 'T1', status: 'active' },
    { model: 'DUP', tier: 'T3', status: 'active' },
  ];
  const ranked = leaf.rankAutoModels('conversation', cands);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].model, 'dup');
});

test('rankAutoModels / pickAutoModel: fail-soft on bad input', () => {
  assert.deepEqual(leaf.rankAutoModels('x', null), []);
  assert.deepEqual(leaf.rankAutoModels('x', undefined), []);
  assert.deepEqual(leaf.rankAutoModels('x', 'not-array'), []);
  assert.deepEqual(leaf.rankAutoModels('x', []), []);
  assert.equal(leaf.pickAutoModel('x', null), null);
  assert.equal(leaf.pickAutoModel('x', [{ model: 'a', status: 'disabled' }]), null);
});

test('buildAutoChoice: shape + sentinel value + preview label', () => {
  const c = leaf.buildAutoChoice();
  assert.equal(c.value.adapter, 'auto');
  assert.equal(c.value.model, 'auto');
  assert.equal(c.disabled, false);
  assert.ok(/Auto/.test(c.name));

  const withPreview = leaf.buildAutoChoice({ previewModel: 'glm-4.6' });
  assert.ok(withPreview.name.includes('glm-4.6'));

  // chalk that throws must not break the choice (fail-soft)
  const bad = leaf.buildAutoChoice({ chalk: { dim() { throw new Error('boom'); } }, previewModel: 'm' });
  assert.equal(bad.value.adapter, 'auto');
});

/**
 * [DESIGN-ARCH-167] Auto 是 ModelPicker 的**第 5 个** choice 产出点。前 4 个（apiAdapter
 * 配置路/池路、默认模型兜底、外部智能体投影）都供了 `group`/`primary`/`secondary`/`groupMeta`，
 * 漏掉这一个会让 Auto 行成为唯一「不参与分层」的行，并静默依赖渲染侧 `c.primary || c.name` 回退。
 * 真数据实测（.khyos/diag/model-picker-grouping/real-choices-ab.js）：漏供时
 * `字段未定义计数 = {group:1, primary:1, secondary:1, groupMeta:1}`，那 1 条就是 Auto。
 *
 * §12-Q11：次信息**只留预览**，17 字说明让位。80×24 真帧里加上说明后全表只剩这 1 行被 `…`
 * 截断，且切掉的正是最有信息量的预览 —— 这是「说明」与「预览」在同一行里的宽度零和。
 */
test('buildAutoChoice: 分层字段齐备；次信息只留预览(§12-Q11)；name 一字未改', () => {
  const bare = leaf.buildAutoChoice();
  assert.equal(bare.group, 'Auto');
  assert.equal(bare.groupMeta, '');
  assert.equal(bare.primary, '★ Auto');
  // §12-Q11：17 字说明**不进次信息**（正是它把预览挤出 80 列）
  assert.equal(bare.secondary, '');
  assert.ok(!bare.secondary.includes('自动选择最适合当前任务且可用的模型'));
  // 但 `name` 逐字未改 ⇒ 两个既有消费者不受影响：
  //   ① advisor.js 拿 c.name 当候选 label；② ModelPicker.filterChoices 拿它当搜索匹配文本。
  // 同时它也是本改动 A/B 量具的「改前形态」（只喂 name ⇒ 逐字回退旧渲染），所以钉到字节。
  assert.equal(bare.name, '★ Auto 自动选择最适合当前任务且可用的模型');

  const withPreview = leaf.buildAutoChoice({ previewModel: 'glm-4.6' });
  assert.equal(withPreview.primary, '★ Auto');
  assert.equal(withPreview.secondary, '(当前最优: glm-4.6)');
  assert.equal(withPreview.name, '★ Auto 自动选择最适合当前任务且可用的模型 (当前最优: glm-4.6)');
  // 行内上屏文本 = primary + 次信息（两段之间的分隔由渲染器补，`secondary` 不带前导空格）
  assert.equal(`${withPreview.primary}  ${withPreview.secondary}`, '★ Auto  (当前最优: glm-4.6)');

  // fail-soft 分支也必须齐备，否则「chalk 一抛就退回不分层」= 静默降级
  const bad = leaf.buildAutoChoice({ chalk: { dim() { throw new Error('boom'); } }, previewModel: 'm' });
  assert.equal(bad.group, 'Auto');
  assert.equal(bad.primary, '★ Auto');
  assert.equal(bad.secondary, '');
  assert.equal(bad.name, '★ Auto 自动选择最适合当前任务且可用的模型');
});

test('AUTO_SENTINEL + describe are stable exports', () => {
  assert.equal(leaf.AUTO_SENTINEL, 'auto');
  const d = leaf.describeAutoModelSelect();
  assert.equal(d.gate, 'KHY_AUTO_MODEL_SELECT');
  assert.equal(d.defaultOn, true);
  assert.equal(d.sentinel, 'auto');
});

test('rankAutoModels: taskScale 下限只上抬期望 tier(DESIGN-ARCH-161 P3-Q1)', () => {
  const cands = [
    { model: 'tiny-7b-mini' }, // T3 weak
    { model: 'deepseek-v3' }, // T1 strong
    { model: 'gpt-5' }, // T0 frontier
    { model: 'unknown-cloud-1' }, // T2 default
  ];
  // 不传 taskScale → 历史行为:均衡默认 T2,未知模型距离 0 排头名。
  const base = leaf.rankAutoModels('conversation', cands);
  assert.equal(base[0].model, 'unknown-cloud-1');
  // large → 下限 T1:T1/T0 能力模型抬到 T2/T3 之前。
  const large = leaf.rankAutoModels('conversation', cands, { taskScale: 'large' });
  assert.equal(large[0].model, 'deepseek-v3');
  assert.ok(large.findIndex((x) => x.model === 'gpt-5') < large.findIndex((x) => x.model === 'unknown-cloud-1'));
  // xlarge → 下限 T0:前沿模型头名。
  assert.equal(leaf.rankAutoModels('conversation', cands, { taskScale: 'xlarge' })[0].model, 'gpt-5');
  // 下限不下调:reasoning 已期望 T0,scale 不会把它抬得更低。
  const reasoning = leaf.rankAutoModels('reasoning', cands, { taskScale: 'large' });
  assert.equal(reasoning[0].model, 'gpt-5');
  // 非法/空 scale → 与不传逐字节一致。
  assert.deepEqual(
    leaf.rankAutoModels('conversation', cands, { taskScale: 'bogus' }),
    base
  );
});
