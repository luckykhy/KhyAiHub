'use strict';

/**
 * index.test.js — 钉死聊天状态隔离的两出口：isErrorTurn 的结构化判错与
 * commitTurn 的原子提交语义（成功轮落历史+截断、失败轮回滚快照、坏输入不动数组）。
 *
 * 为什么这支套件必须存在：本模块守的是「失败轮的兜底文案绝不进会话历史」这条
 * 反复读防线。commitTurn 的三种返回 {persisted, rolledBack} 组合调用方都会分支，
 * 任何一格语义漂移（比如失败轮误回滚、或截断吃掉本轮 assistant）都会直接
 * 表现为用户看到的「对话失忆」或「复读机」回归。
 *
 * 实测更正（与直觉不同处，按真实语义钉死）：
 *   · 失败轮但 historyMark 非法（非整数/负数/超当前长度）时不回滚，返回
 *     {persisted:false, rolledBack:false}——数组原样保留（含本轮 user 消息），
 *     只保证「不落兜底文案」。
 *   · historyMark === messages.length 是合法下标：返回 rolledBack:true 但数组
 *     长度不变（回滚了个寂寞，如实钉死边界）。
 *   · reply 走 String(reply || '')：非字符串假值(0/''/false/null)一律视作空
 *     不落历史；数字 123 会落成字符串 '123'。
 *   · maxHistory 截断只在 Number.isInteger 且 > 0 时发生，保留的是末尾切片。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isErrorTurn, commitTurn } = require('./index');

test('isErrorTurn: errorType 或 error_code 任一存在即判错误轮', () => {
  assert.equal(isErrorTurn({ errorType: 'timeout' }), true);
  assert.equal(isErrorTurn({ error_code: 'E01' }), true);
  assert.equal(isErrorTurn({ reply: 'ok' }), false);
  // 假值不算命中（结构化信号取 truthy 语义）
  assert.equal(isErrorTurn({ errorType: '' }), false);
  assert.equal(isErrorTurn({ error_code: 0 }), false);
});

test('isErrorTurn: 非对象输入一律 false，绝不抛', () => {
  assert.equal(isErrorTurn(null), false);
  assert.equal(isErrorTurn(undefined), false);
  assert.equal(isErrorTurn('timeout'), false);
  assert.equal(isErrorTurn(42), false);
});

test('commitTurn: 非数组输入返回双 false，不尝试变异', () => {
  assert.deepEqual(commitTurn(null, {}), { persisted: false, rolledBack: false });
  assert.deepEqual(commitTurn('nope', { reply: 'x' }), { persisted: false, rolledBack: false });
});

test('commitTurn: 成功轮 push assistant 并保持调用方数组引用', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const res = commitTurn(messages, { reply: 'hello' });
  assert.deepEqual(res, { persisted: true, rolledBack: false });
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1], { role: 'assistant', content: 'hello' });
});

test('commitTurn: 空回复不落历史（含数字假值与字符串化边界）', () => {
  const m = [{ role: 'user', content: 'q' }];
  assert.deepEqual(commitTurn(m, { reply: '' }), { persisted: false, rolledBack: false });
  assert.deepEqual(commitTurn(m, {}), { persisted: false, rolledBack: false });
  assert.deepEqual(commitTurn(m, { reply: 0 }), { persisted: false, rolledBack: false });
  assert.equal(m.length, 1);
  // 数字 123 经 String() 变成非空 '123' → 会落历史（实测更正：判空在字符串化之后）
  commitTurn(m, { reply: 123 });
  assert.equal(m[1].content, '123');
});

test('commitTurn: maxHistory 截断保留末尾切片', () => {
  const m = [];
  for (let i = 0; i < 4; i++) m.push({ role: 'user', content: `u${i}` });
  const before = m.slice();
  const res = commitTurn(m, { reply: 'ans', maxHistory: 3 });
  assert.equal(res.persisted, true);
  assert.equal(m.length, 3);
  assert.equal(m[2].content, 'ans');
  // 被截掉的是最前面的 u0，末尾两条 user 保留
  assert.deepEqual(m.slice(0, 2), before.slice(2, 4));
});

test('commitTurn: maxHistory 非整数或非正数不截断（实测：3.5 与 0 都放行）', () => {
  const m = [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }];
  commitTurn(m, { reply: 'c', maxHistory: 3.5 });
  commitTurn(m, { reply: 'd', maxHistory: 0 });
  assert.equal(m.length, 4);
});

test('commitTurn: 失败轮回滚到 historyMark，撤回本轮 user 且不落兜底文案', () => {
  const m = [
    { role: 'user', content: '上一轮问题' },
    { role: 'assistant', content: '上一轮回答' },
    { role: 'user', content: '本轮问题' },
  ];
  const res = commitTurn(m, {
    reply: '抱歉，我无法回答',
    finalResult: { errorType: 'network' },
    historyMark: 2,
  });
  assert.deepEqual(res, { persisted: false, rolledBack: true });
  assert.equal(m.length, 2);
  assert.ok(!m.some((x) => String(x.content).includes('抱歉')));
});

test('commitTurn: 失败轮 + 非法 historyMark → 不回滚也不落文案，数组原样', () => {
  const m = [{ role: 'user', content: '本轮问题' }];
  const snap = m.slice();
  for (const bad of [-1, 1.5, 99, undefined, null, '0']) {
    const res = commitTurn(m, {
      reply: '兜底',
      finalResult: { error_code: 'E02' },
      historyMark: bad,
    });
    assert.deepEqual(res, { persisted: false, rolledBack: false }, `mark=${String(bad)}`);
  }
  assert.deepEqual(m, snap);
});

test('commitTurn: historyMark === 当前长度是合法边界（rolledBack:true 但零撤回）', () => {
  const m = [{ role: 'user', content: '本轮问题' }];
  const res = commitTurn(m, {
    reply: '兜底',
    finalResult: { errorType: 'empty_reply' },
    historyMark: m.length,
  });
  assert.deepEqual(res, { persisted: false, rolledBack: true });
  assert.equal(m.length, 1);
});
