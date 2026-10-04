'use strict';

// 单元契约测试：resultGuard 的收尾判据契约——结论判据由调用方注入（本叶子绝不重算），
// 主门控 + 两个子门控各自「关闭即逐字节回退历史」，以及三条 unfinished 分支的 reason 字面量。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rg = require('./resultGuard');

const ON = {};

test('导出面与零 require 纯度', () => {
  assert.deepEqual(Object.keys(rg).sort(), [
    'assessClosure',
    'buildClosureNotice',
    'deliveryNudgeForcedForWeakTier',
    'emptyAfterToolsGuardEnabled',
    'looksLikeForwardPromise',
    'looksLikeProgressNarration',
    'progressOnlyGuardEnabled',
    'resultGuardEnabled',
    'shouldAppendDeliverySummary',
  ]);
  const src = fs.readFileSync(path.join(__dirname, 'resultGuard.js'), 'utf8');
  assert.ok(!src.includes('require('), '本叶子必须零 require（结论判据由入参给）');
});

test('四个门控都缺省为开，取值 0/false/off/no 关闭', () => {
  for (const gate of [
    rg.resultGuardEnabled,
    rg.emptyAfterToolsGuardEnabled,
    rg.progressOnlyGuardEnabled,
    rg.deliveryNudgeForcedForWeakTier,
  ]) {
    assert.equal(gate(ON), true);
    for (const off of ['0', 'false', 'off', 'no']) {
      const key = gate === rg.resultGuardEnabled
        ? 'KHY_RESULT_GUARD'
        : gate === rg.emptyAfterToolsGuardEnabled
          ? 'KHY_RESULT_GUARD_EMPTY'
          : gate === rg.progressOnlyGuardEnabled
            ? 'KHY_RESULT_GUARD_PROGRESS_ONLY'
            : 'KHY_T0_DELIVERY_NUDGE';
      assert.equal(gate({ [key]: off }), false, `${key}=${off}`);
    }
  }
});

test('前置短路：没跑工具 / 已交付结论 / 主门控关 → 一律 unfinished:false', () => {
  assert.deepEqual(rg.assessClosure({ totalToolCalls: 0, hasDeliveredConclusion: false, finalText: '让我先看' }, ON),
    { unfinished: false, reason: null });
  assert.deepEqual(rg.assessClosure({ totalToolCalls: 3, hasDeliveredConclusion: true, finalText: '让我先看' }, ON),
    { unfinished: false, reason: null });
  assert.deepEqual(rg.assessClosure({ totalToolCalls: 3, hasDeliveredConclusion: false, finalText: '让我先看' },
    { KHY_RESULT_GUARD: '0' }), { unfinished: false, reason: null });
  // 非数字的工具次数不当作「跑过工具」
  assert.equal(rg.assessClosure({ totalToolCalls: 'abc', finalText: '' }, ON).unfinished, false);
});

test('分支①：承诺式前言 → promise-without-delivery', () => {
  // 契约：前言引导 ∧ 「延迟连接词 + 交付名词」**同时**出现才算未兑现承诺；只有前言不算（保守不误伤）
  assert.equal(rg.looksLikeForwardPromise('让我先看代码结构，再给针对性建议'), true);
  assert.equal(rg.looksLikeForwardPromise('让我先看看代码结构'), false);
  assert.deepEqual(
    rg.assessClosure({ totalToolCalls: 2, hasDeliveredConclusion: false, finalText: '我先梳理，然后给出结论' }, ON),
    { unfinished: true, reason: 'promise-without-delivery' },
  );
});

test('分支②：纯进度旁白 → progress-only-after-tools；含代码块即视为有产物', () => {
  const narration = '找到 3 处匹配，我逐个核对，先从第一处入手。';
  assert.equal(rg.looksLikeProgressNarration(narration), true);
  assert.deepEqual(
    rg.assessClosure({ totalToolCalls: 2, hasDeliveredConclusion: false, finalText: narration }, ON),
    { unfinished: true, reason: 'progress-only-after-tools' },
  );
  // 子门控关 → 整支跳过（逐字节回退：只剩前言与空文本两支）
  assert.equal(
    rg.assessClosure({ totalToolCalls: 2, hasDeliveredConclusion: false, finalText: narration },
      { KHY_RESULT_GUARD_PROGRESS_ONLY: '0' }).reason,
    null,
  );
  assert.equal(rg.looksLikeProgressNarration(`${narration}\`\`\``), false, '含代码块必须判为有实质产物');
  assert.equal(rg.looksLikeProgressNarration(''), false);
});

test('分支③：工具跑完但文本为空 → empty-after-tools；子门控关则不报', () => {
  assert.deepEqual(
    rg.assessClosure({ totalToolCalls: 1, hasDeliveredConclusion: false, finalText: '   ' }, ON),
    { unfinished: true, reason: 'empty-after-tools' },
  );
  assert.equal(
    rg.assessClosure({ totalToolCalls: 1, hasDeliveredConclusion: false, finalText: '' },
      { KHY_RESULT_GUARD_EMPTY: '0' }).unfinished,
    false,
  );
});

test('收尾文案：门控关 → 空串（call-site 据此不追加）；门控开 → 非空且说明未完成', () => {
  assert.equal(rg.buildClosureNotice({ reason: 'empty-after-tools' }, { KHY_RESULT_GUARD: '0' }), '');
  const notice = rg.buildClosureNotice({ reason: 'empty-after-tools' }, ON);
  assert.equal(typeof notice, 'string');
  assert.ok(notice.length > 0);
});

test('shouldAppendDeliverySummary：门控开用真结论判据，门控关等价于历史「去空白 < 40」粗代理', () => {
  assert.equal(rg.shouldAppendDeliverySummary({ finalText: '结论如上', hasDeliveredConclusion: false }, ON), true);
  assert.equal(rg.shouldAppendDeliverySummary({ finalText: '结论如上', hasDeliveredConclusion: true }, ON), false);
  const long40 = 'x'.repeat(40); // 去空白长度恰为 40 → 历史粗代理判「已写结论」
  assert.equal(rg.shouldAppendDeliverySummary({ finalText: long40, hasDeliveredConclusion: false },
    { KHY_RESULT_GUARD: '0' }), false);
  assert.equal(rg.shouldAppendDeliverySummary({ finalText: '短', hasDeliveredConclusion: true },
    { KHY_RESULT_GUARD: '0' }), true);
});

test('垃圾入参绝不抛', () => {
  assert.equal(rg.assessClosure(undefined, ON).unfinished, false);
  assert.equal(rg.assessClosure({}, ON).unfinished, false);
  assert.equal(rg.looksLikeForwardPromise(null), false);
  assert.equal(rg.shouldAppendDeliverySummary(undefined, ON), true);
});
