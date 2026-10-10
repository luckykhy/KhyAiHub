'use strict';

/**
 * routeContextSignals.test.js — §15-2（不做 query 级路由）的输入侧契约。
 *
 * 这个叶子存在的唯一理由是把「用户这句话之外的事实」送进 routeDemand，
 * 所以测试必须证明两件事：① 数字是**真**从上下文来的；② 拿不到时如实给 null，
 * 而不是给一个看起来合理、实则编出来的 0。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rcs = require('./routeContextSignals');

const LONG = 'x'.repeat(4000);

test('derive：窗口存在时给出真实占比；无上下文时全空', () => {
  const withCtx = rcs.derive([{ role: 'user', content: LONG }, { role: 'assistant', content: LONG }], {
    contextWindow: 8000,
  });
  assert.ok(Number.isFinite(withCtx.estCtxTokens), '有历史就该有 token 估算');
  assert.ok(withCtx.estCtxTokens > 0);
  assert.ok(Number.isFinite(withCtx.ctxRatio), `窗口给了就必须有占比，实际 ${withCtx.ctxRatio}`);
  assert.ok(withCtx.ctxRatio > 0 && withCtx.ctxRatio <= 1.5, `占比应可解释，实际 ${withCtx.ctxRatio}`);
  assert.strictEqual(withCtx.toolFails, 0);

  const empty = rcs.derive(undefined, { contextWindow: 8000 });
  assert.strictEqual(empty.estCtxTokens, null, '没有上下文时不许编一个 0 当估算');
  assert.strictEqual(empty.ctxRatio, null, '没有上下文时占比必须是 null');
});

test('derive：没有窗口 ⇒ ctxRatio 是 null 而不是 0（0 会被下游读成「上下文很空」）', () => {
  const r = rcs.derive([{ role: 'user', content: LONG }], { contextWindow: 0 });
  assert.ok(Number.isFinite(r.estCtxTokens), '没有窗口也得给出绝对占用估算');
  assert.strictEqual(r.ctxRatio, null);
  const r2 = rcs.derive([{ role: 'user', content: LONG }], {});
  assert.strictEqual(r2.ctxRatio, null, '缺 contextWindow 键同样必须是 null');
});

test('derive：只数真失败 —— 被丢弃的历史结果不算失败（is_error 显式为 false）', () => {
  const messages = [
    { role: 'user', content: '开始' },
    // 真失败：content 块级 is_error
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'boom', is_error: true }] },
    // ensureToolResultPairing 为回收上下文补的空壳：**必须**不算失败
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: '[tool result dropped]', is_error: false }] },
    // 真失败：顶层标记
    { role: 'tool', is_error: true, content: '执行失败' },
    // 文本里带 error 字样但不是 is_error 标记 —— 不许按文本猜
    { role: 'assistant', content: 'The earlier call returned an error, but it succeeded on retry.' },
  ];
  const r = rcs.derive(messages, { contextWindow: 200000 });
  assert.strictEqual(r.toolFails, 2, `只应数到 2 个真失败，实际 ${r.toolFails}`);
});

test('derive：绝不抛 —— 畸形输入退回中性值', () => {
  for (const bad of [null, 'not-an-array', {}, [null, undefined, 3], [{ content: {} }]]) {
    assert.doesNotThrow(() => rcs.derive(bad, { contextWindow: 'NaN' }));
    const r = rcs.derive(bad, { contextWindow: 'NaN' });
    assert.strictEqual(r.toolFails, 0);
    assert.ok(r.ctxRatio === null || Number.isFinite(r.ctxRatio));
  }
});
