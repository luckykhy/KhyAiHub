'use strict';

// Co-located contract tests for nlActionResolver.js (纯叶子 NL → 动作意图)。
// Measured via .khyos/tmp/probeAction.js. Zero-IO, but resolveActionIntent/routeActionIntent
// default to the real process.env, so every call injects an env object.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isEnabled,
  ACTIONS,
  resolveActionIntent,
  describeActions,
  findAction,
  routeActionIntent,
} = require('./nlActionResolver');

const ON = { KHY_NL_ACTION: 'true' };
const BUG = '找出你自己的 bug 并修复';
const LEARN = '学习一下 GitHub 上最火的项目';

test('门控默认开，仅 CANON 四词关；空串读作开、数字 0 读作关', () => {
  assert.equal(isEnabled({}), true);
  for (const word of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(isEnabled({ KHY_NL_ACTION: word }), false, `${word} closes`);
  }
  for (const word of ['', null, undefined, 'true', '1', 'NOPE']) {
    assert.equal(isEnabled({ KHY_NL_ACTION: word }), true, `${String(word)} stays open`);
  }
  assert.equal(isEnabled({ KHY_NL_ACTION: 0 }), false);
  assert.equal(isEnabled({ KHY_NL_ACTION: false }), false);
  assert.equal(isEnabled(null), true);
  assert.equal(isEnabled(0), false, 'a falsy env becomes its own "0" literal');
  assert.equal(isEnabled('x'), true);
});

test('self-bug-fix 需要 self 引用 + bug 名词 + 查找或修复动词三者同现', () => {
  for (const s of [
    BUG, '修复 khy 自身的缺陷', '审查一下它自己的错误', '排查自身漏洞',
    'find bugs in yourself and fix them', '检查 khyos 本体的问题代码', '检查 khy 自己的 issues',
    'self-review 的 defects 找出来',
  ]) {
    assert.equal(resolveActionIntent(s, ON).id, 'self-bug-fix', s);
  }
  for (const s of ['找 bug', '修 bug', '修复你代码里的 bug', '把这段代码修一下', '我的服务有 bug 帮我看看']) {
    assert.equal(resolveActionIntent(s, ON), null, s);
  }
});

test('没有 bug 名词时 self 引用不成立（避免抢普通对话）', () => {
  assert.equal(resolveActionIntent('你自己的项目体验不错', ON), null);
  assert.equal(resolveActionIntent('列出你的自身能力', ON), null);
  assert.equal(resolveActionIntent('你的自身有什么问题', ON), null, '问题 alone is not 问题代码');
  assert.equal(resolveActionIntent('自身的错误', ON), null, 'self + bug noun without a find/fix verb still declines');
  assert.equal(resolveActionIntent('排查自身的错误', ON).id, 'self-bug-fix', '错误 is a bug noun once a verb arrives');
  assert.equal(resolveActionIntent('检查自身的问题代码', ON).id, 'self-bug-fix');
});

test('KNOWN-DEFECT 「我自己的项目里的 bug」被判成 khy 自查，与头注的零假阳性声明直接冲突', () => {
  // The header lists 帮我找我项目里的 bug (the user's own project) as a must-not-fire case.
  assert.equal(resolveActionIntent('帮我找我项目里的 bug', ON), null, 'without 自己的 it does decline');
  assert.equal(resolveActionIntent('帮我修一下我自己的项目里的 bug', ON).id, 'self-bug-fix', 'adding 自己的 flips it');
  assert.equal(ACTIONS[0].match('帮我修一下自己的项目里的 bug'), true, 'the self token is a plain substring test');
});

test('forge-learn：平台+学习动词即成立，无平台时须 学习+项目+热度词 三者', () => {
  for (const s of [
    LEARN, '去 github 学习', '参考 gitlab 上的开源仓库', '学习最新的开源项目',
    '借鉴 gitee 码云 的项目', 'study the trending repos on forge', '去开源界取经',
    '看看别人的开源项目', '研究一下热门项目', '研究热门框架',
  ]) {
    assert.equal(resolveActionIntent(s, ON).id, 'forge-learn', s);
  }
  for (const s of ['学习一下 promise', '看看最火的项目', '学习别人怎么写', '研究一下项目', 'research popular repositories']) {
    assert.equal(resolveActionIntent(s, ON), null, s);
  }
});

test('命中两个动作时按注册表顺序取第一个（确定性）', () => {
  assert.equal(resolveActionIntent('去 github 学习最火项目，并修复你自己的 bug', ON).id, 'self-bug-fix');
  assert.equal(resolveActionIntent('修复你自己的 bug，再去 github 学习', ON).id, 'self-bug-fix');
  assert.deepEqual(ACTIONS.map((a) => a.id), ['self-bug-fix', 'forge-learn'], 'the order is part of the contract');
});

test('代码块与行内 code 里的关键词不算用户指令', () => {
  assert.equal(resolveActionIntent('```\n' + BUG + '\n```', ON), null);
  assert.equal(resolveActionIntent('请把`自己的 bug`修一下', ON), null);
  assert.equal(resolveActionIntent('自己的 bug 见 README：\n```\n修复它\n```', ON), null);
  assert.equal(resolveActionIntent(BUG, ON).id, 'self-bug-fix', 'the same text outside code does fire');
});

test('垃圾输入一律 null 且绝不抛（契约 fail-soft）', () => {
  for (const junk of [null, undefined, '', '   ', 0, 123, NaN, true, false, [], {}, new Set()]) {
    assert.equal(resolveActionIntent(junk, ON), null, `junk ${String(junk)}`);
  }
  assert.doesNotThrow(() => resolveActionIntent({
    toString() { throw new Error('boom'); },
  }, ON));
  assert.equal(resolveActionIntent({
    toString() { throw new Error('boom'); },
  }, ON), null);
});

test('门控关时恒 null，空串门控仍开', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(resolveActionIntent(BUG, { KHY_NL_ACTION: off }), null);
    assert.equal(resolveActionIntent(LEARN, { KHY_NL_ACTION: off }), null);
  }
  assert.equal(resolveActionIntent(BUG, { KHY_NL_ACTION: '' }).id, 'self-bug-fix');
});

test('解析不设长度上限（兄弟叶子截 500 / 守卫叶截 4000）', () => {
  assert.equal(resolveActionIntent(BUG.repeat(200), ON).id, 'self-bug-fix');
  assert.equal(resolveActionIntent('x'.repeat(20000) + ' 修复自身的 bug', ON).id, 'self-bug-fix');
  assert.equal(resolveActionIntent(`x${'y'.repeat(5000)}${LEARN}`, ON).id, 'forge-learn');
});

test('意图对象三键，directive 复用注册表里的同一字符串（单一真源）', () => {
  const intent = resolveActionIntent(BUG, ON);
  assert.deepEqual(Object.keys(intent), ['id', 'summary', 'directive']);
  assert.equal(intent.summary, '查找并修复 khy 自身的 bug');
  assert.equal(intent.directive, ACTIONS[0].directive);
  assert.equal(intent.directive.startsWith('[SYSTEM:'), true);
  assert.equal(intent.directive.split('\n').length, 13);
  assert.equal(findAction('forge-learn').directive.split('\n').length, 11);
});

test('describeActions 每次返回新的精简副本，只暴露 id 与 summary', () => {
  const listed = describeActions();
  assert.deepEqual(listed, [
    { id: 'self-bug-fix', summary: '查找并修复 khy 自身的 bug' },
    { id: 'forge-learn', summary: '去开源平台学习最新/最火的项目' },
  ]);
  assert.notEqual(listed, describeActions(), 'a fresh array each call');
  assert.notEqual(listed[0], ACTIONS[0], 'and fresh element objects');
  assert.equal('directive' in listed[0], false, 'the heavy text is not handed out');
  assert.equal('match' in listed[0], false);
});

test('KNOWN-DEFECT findAction 返回注册表内部的活对象（与 describeActions 的副本语义不一致）', () => {
  const a = findAction('self-bug-fix');
  assert.equal(a === ACTIONS[0], true, 'same reference: a caller can rewrite the shared registry');
  assert.deepEqual(Object.keys(a), ['id', 'summary', 'match', 'directive']);
  assert.equal(findAction('self-bug-fix') === findAction('self-bug-fix'), true);
  assert.equal(a.id, 'self-bug-fix', 'read-only assertion: this test never mutates it');
});

test('findAction 去空白但不折叠大小写，未知/空 id 返回 null', () => {
  assert.equal(findAction(' self-bug-fix ').id, 'self-bug-fix');
  assert.equal(findAction('SELF-BUG-FIX'), null, 'the lookup is case sensitive');
  for (const junk of [null, undefined, '', 0, false, {}, [], 'nope']) {
    assert.equal(findAction(junk), null, `junk id ${String(junk)}`);
  }
  assert.equal(findAction(123), null);
});

test('缝入口命中给 {directive,intent}，未命中零注入', () => {
  const routed = routeActionIntent({ text: BUG, env: ON });
  assert.deepEqual(Object.keys(routed), ['directive', 'intent']);
  assert.equal(routed.directive, ACTIONS[0].directive);
  assert.equal(routed.intent.id, 'self-bug-fix');
  assert.equal(routeActionIntent({ text: '今天天气不错', env: ON }), null);
  assert.equal(routeActionIntent({ text: BUG, env: { KHY_NL_ACTION: 'off' } }), null);
});

test('缝入口对畸形 opts 一律 fail-soft 成 null', () => {
  assert.equal(routeActionIntent(), null);
  assert.equal(routeActionIntent({}), null);
  assert.equal(routeActionIntent(null), null);
  assert.equal(routeActionIntent('x'), null);
  assert.equal(routeActionIntent(0), null);
  assert.equal(routeActionIntent({ text: {} }), null);
  assert.equal(routeActionIntent({ text: { toString() { throw new Error('b'); } }, env: ON }), null);
  assert.equal(routeActionIntent({ text: BUG, get env() { throw new Error('t'); } }), null);
});

test('缝入口省略 env 时读真实 process.env（测试必须显式注入以保持确定性）', () => {
  // Measured: omitting env still resolves through the host environment instead of a neutral default.
  const withOut = routeActionIntent({ text: BUG });
  assert.equal(withOut === null || withOut.intent.id === 'self-bug-fix', true);
  const explicit = routeActionIntent({ text: BUG, env: ON });
  assert.equal(explicit.intent.id, 'self-bug-fix');
  assert.notEqual(explicit, routeActionIntent({ text: BUG, env: ON }), 'new wrapper per call');
});

test('解析不改动注入的 env', () => {
  const env = { KHY_NL_ACTION: 'true', KEEP: 'me' };
  resolveActionIntent(BUG, env);
  routeActionIntent({ text: BUG, env });
  isEnabled(env);
  assert.deepEqual(env, { KHY_NL_ACTION: 'true', KEEP: 'me' });
});
