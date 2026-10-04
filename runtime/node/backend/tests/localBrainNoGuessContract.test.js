'use strict';

/**
 * 「信息不足 → 拒绝臆测」契约(2026-09-27)。
 *
 * 此前这些实时技能在抽不到实体时会**静默用默认值顶上**:
 *   天气 → 北京、币价 → bitcoin、节假日 → CN。
 * 用户问「今天天气怎么样」会收到北京天气,模型再复述成「你那边今天…」——
 * 猜测被当成事实。本套件把「不许猜」锁成契约:缺实体必须**拒绝**并给出两条出路。
 *
 * 零网络:只调 detect/needsInput/format,不触发任何执行器。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const api = require('../src/services/localBrainExternalApi');

// ── 实体校验:挡住「时间词当城市」这类垃圾抽取 ──────────────────────────
test('_isPlausibleEntity:正常地名/币名/国名通过', () => {
  for (const v of ['上海', '北京', 'Tokyo', 'new york', '比特币']) {
    assert.equal(api._isPlausibleEntity(v), true, `${v} 应判为可用实体`);
  }
});

test('_isPlausibleEntity:时间/指代词一律不通过(旧 regex 会把它当城市)', () => {
  for (const v of ['今天', '明天', '现在', '最近', '本周', '周末', 'today', 'now', 'latest']) {
    assert.equal(api._isPlausibleEntity(v), false, `${v} 是时间词,不得当实体`);
  }
});

test('_isPlausibleEntity:空/超长/含句内标点一律不通过', () => {
  for (const v of ['', '   ', null, undefined, 'x'.repeat(30), '上海，天气']) {
    assert.equal(api._isPlausibleEntity(v), false, `${JSON.stringify(v)} 不应通过`);
  }
});

test('_resolveEntity:三个来源判定(explicit / deictic / missing)', () => {
  const re = /(?:天气|weather)\s*[:：]?\s*(\S+)|(\S+)\s*(?:的?天气)/i;
  assert.deepEqual(api._resolveEntity('上海天气', re), { value: '上海', source: 'explicit' });
  // 「今天天气」的候选是时间词 → 不得当实体;又没给地名 → missing
  assert.deepEqual(api._resolveEntity('今天天气怎么样', re), { value: '', source: 'missing' });
  // 指代「我这里」→ deictic(出路是取位置,不是猜一个城市)
  assert.equal(api._resolveEntity('我这里天气', re).source, 'deictic');
  assert.equal(api._resolveEntity('本地天气', re).source, 'deictic');
});

// ── 天气:不猜城市 ──────────────────────────────────────────────────────
test('天气:未给城市 → needsInput 拒绝,绝不回退到北京', () => {
  for (const q of ['今天天气怎么样', '天气', '现在天气如何', 'weather']) {
    const plan = api._detectWeather(q);
    assert.ok(plan.needsInput, `「${q}」必须要求补城市,而不是猜一个`);
    assert.equal(plan.city, undefined, `「${q}」不得带任何默认城市`);
    assert.equal(plan.lat, undefined);
    assert.equal(plan.needsInput.field, '城市');
  }
});

test('天气:指代「我这里」→ 出路指向 GetLocation', () => {
  const plan = api._detectWeather('我这里天气怎么样');
  assert.ok(plan.needsInput);
  assert.equal(plan.needsInput.source, 'deictic');
  assert.match(plan.needsInput.options[1], /GetLocation/);
});

test('天气:给了城市 → 照常解析(含坐标与 wttr 兜底)', () => {
  const sh = api._detectWeather('上海天气');
  assert.equal(sh.city, '上海');
  assert.deepEqual([sh.lat, sh.lon], [31.2, 121.5]);
  assert.equal(sh.needsInput, undefined);

  const unknown = api._detectWeather('克拉玛依天气');
  assert.equal(unknown.city, '克拉玛依');
  assert.equal(unknown.useWttr, true);
  assert.equal(unknown.needsInput, undefined);
});

test('天气:「今天天气」不得拿「今天」去查(旧行为会把时间词当地名)', () => {
  const plan = api._detectWeather('今天天气');
  assert.ok(plan.needsInput, '时间词不得被当成城市');
  assert.notEqual(plan.city, '今天');
});

test('天气:拒绝的文案含「缺什么 + 不能猜 + 两条出路」', () => {
  const plan = api._detectWeather('天气');
  const text = api._formatNeedsInput('天气', plan.needsInput);
  assert.match(text, /不能猜测/);
  assert.match(text, /城市/);
  assert.match(text, /①/);
  assert.match(text, /②/);
  assert.match(text, /GetLocation/);
});

test('天气:执行器对 needsInput 计划短路拒绝(零网络),且 error 已含出路', async () => {
  const plan = api._detectWeather('天气怎么样');
  const result = await api._executeWeather(plan);
  assert.equal(result.success, false);
  assert.equal(result.needsInput.source, 'missing');
  assert.match(result.error, /GetLocation/);
  // 渲染不得叠加两层前缀
  const out = api._formatWeather(result);
  assert.equal(out, result.error);
  assert.equal((out.match(/查询失败/g) || []).length, 1);
});

// ── 行情:不猜币种 ──────────────────────────────────────────────────────
test('加密货币:未指明币种 → needsInput 拒绝,绝不回退到 bitcoin', () => {
  const plan = api._detectCrypto('币价多少');
  assert.ok(plan.needsInput, '必须问清是哪一个币');
  assert.equal(plan.coin, undefined, '不得带默认币种');
  assert.equal(plan.needsInput.field, '币种');
});

test('加密货币:指明币种 → 照常解析', () => {
  for (const [q, coin] of [
    ['比特币价格', 'bitcoin'],
    ['以太坊现在多少钱', 'ethereum'],
  ]) {
    const plan = api._detectCrypto(q);
    assert.equal(plan.coin, coin, `「${q}」应解析为 ${coin}`);
    assert.equal(plan.needsInput, undefined);
  }
});

test('加密货币:执行器对 needsInput 计划短路拒绝(零网络)', async () => {
  const result = await api._executeCrypto(api._detectCrypto('币价'));
  assert.equal(result.success, false);
  assert.match(result.error, /币种/);
  assert.equal(api._formatCrypto(result), result.error, '渲染不得叠加两层前缀');
});

// ── 节假日:不猜国家 ────────────────────────────────────────────────────
test('节假日:未指明国家 → needsInput 拒绝,绝不回退到 CN', () => {
  const plan = api._detectHoliday('今年有哪些节假日');
  assert.ok(plan.needsInput, '必须问清是哪个国家');
  assert.equal(plan.country, undefined, '不得带默认国家');
  assert.equal(plan.needsInput.field, '国家/地区');
});

test('节假日:指明国家 → 照常解析', () => {
  const plan = api._detectHoliday('中国 2026 年节假日');
  assert.equal(plan.country, 'CN');
  assert.equal(plan.needsInput, undefined);
  assert.ok(plan.year >= 2026);
});

test('节假日:执行器对 needsInput 计划短路拒绝(零网络)', async () => {
  const result = await api._executeHoliday(api._detectHoliday('有哪些节假日'));
  assert.equal(result.success, false);
  assert.match(result.error, /国家/);
});

// ── 反例:已有正确先例不得被改坏 ────────────────────────────────────────
test('词典:抽不到单词仍返回 null(既有正确先例,未被本契约改动)', () => {
  assert.equal(api._detectDict('这个词什么意思'), null);
});
