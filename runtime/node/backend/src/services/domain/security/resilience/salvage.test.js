'use strict';

// Unit-level contract tests for salvage.js (co-located, per [RESEARCH-018] §2.3).
// SalvageProtector is the protocol's "must hand in something" endgame: the shape
// guarantees (status/intent/attempted_paths/salvage_data/next_action_suggestion always
// present, attempted_paths never empty) are the contract upper layers parse, so both
// the guarantees and every _suggest branch get exact-value assertions.

const test = require('node:test');
const assert = require('node:assert/strict');

const { SalvageProtector } = require('./salvage');

test('module face exports exactly the protector class', () => {
  assert.deepEqual(Object.keys(require('./salvage')), ['SalvageProtector']);
});

test('assemble() with nothing at all still returns the full five-field report', () => {
  const s = SalvageProtector.assemble();
  assert.equal(s.status, 'failed_with_salvage');
  assert.equal(s.intent, '(未命名意图)');
  assert.deepEqual(s.attempted_paths, [{ plan: '(none)', reason: 'aborted:tree-exhausted', retry: 0 }],
    'empty attempted is replaced by the mandatory aborted placeholder — never []');
  assert.equal(s.salvage_data, '', 'field is present even when empty');
  assert.ok(s.next_action_suggestion.length > 0, 'suggestion is never blank');
  assert.deepEqual(Object.keys(s),
    ['status', 'intent', 'attempted_paths', 'salvage_data', 'next_action_suggestion']);
});

test('assemble(): intent label prefers description, falls back to intent', () => {
  assert.equal(SalvageProtector.assemble({ intent: 'i', description: '获取网页内容' }).intent,
    '获取网页内容');
  assert.equal(SalvageProtector.assemble({ intent: 'only-intent' }).intent, 'only-intent');
});

test('assemble(): attempted entries are normalized, hostile shapes defang', () => {
  const s = SalvageProtector.assemble({
    intent: 'i',
    attempted: [
      { plan: 'A', reason: 'timeout', retry: 1 },
      { plan: '', reason: '' },            // falsy strings → placeholders
      { plan: 'C', retry: 'x' },           // unparseable retry → 0
      { plan: 'D', retry: '2' },           // numeric string → 2
    ],
  });
  assert.deepEqual(s.attempted_paths, [
    { plan: 'A', reason: 'timeout', retry: 1 },
    { plan: '(unknown)', reason: 'unknown', retry: 0 },
    { plan: 'C', reason: 'unknown', retry: 0 },
    { plan: 'D', reason: 'unknown', retry: 2 },
  ]);
});

test('assemble(): non-array attempted/salvageData degrade to defaults, no throw', () => {
  const s = SalvageProtector.assemble({ intent: 'i', attempted: 'nope', salvageData: {x: 1} });
  assert.deepEqual(s.attempted_paths, [{ plan: '(none)', reason: 'aborted:tree-exhausted', retry: 0 }]);
  assert.equal(s.salvage_data, '');
});

test('_bestSalvage: longest trimmed text wins among strings', () => {
  const s = SalvageProtector.assemble({
    intent: 'i',
    salvageData: ['ab', '    ', 'abcd longer text here', 'abc'],
  });
  assert.equal(s.salvage_data, 'abcd longer text here');
});

test('_bestSalvage: whitespace-only/empty pool yields empty string', () => {
  assert.equal(SalvageProtector.assemble({ salvageData: ['', '   ', null, undefined] }).salvage_data, '');
});

test('_bestSalvage: text beats structure; structure-only pool returns the FIRST item by identity', () => {
  const obj = { partial: 'html' };
  const arr = [1, 2, 3];
  assert.equal(SalvageProtector.assemble({ salvageData: [obj, 'note'] }).salvage_data, 'note',
    'one non-empty text outranks all objects');
  assert.equal(SalvageProtector.assemble({ salvageData: [arr, obj] }).salvage_data, arr,
    'no texts → items[0] verbatim, not a copy — avoids info loss by design');
});

test('_suggest: budget circuits get the budget-specific advice', () => {
  for (const circuit of ['budget-floor', 'budget-insufficient']) {
    const s = SalvageProtector.assemble({ intent: 'i', circuit });
    assert.match(s.next_action_suggestion, /预算.*不足以安全开启新的降级路径/s);
    assert.match(s.next_action_suggestion, /缩小目标范围、分批执行，或提高预算上限后重试/);
  }
});

test('_suggest: executor-error circuit gets environment-check advice', () => {
  const s = SalvageProtector.assemble({ intent: 'i', circuit: 'executor-error' });
  assert.match(s.next_action_suggestion, /执行器自身遇到异常/);
});

test('_suggest: missing-dependency advice names the dependency when known', () => {
  const withDep = SalvageProtector.assemble({
    intent: 'i',
    lastFailure: { reason: 'missing-dependency', missingDependency: 'puppeteer' },
  });
  assert.equal(withDep.next_action_suggestion,
    '手动安装依赖 puppeteer（如 npm i puppeteer / pip install puppeteer），或改用不依赖它的来源后重试。');
  const noDep = SalvageProtector.assemble({
    intent: 'i',
    lastFailure: { reason: 'missing-dependency', missingDependency: null },
  });
  assert.equal(noDep.next_action_suggestion, '手动安装缺失的依赖后重试，或改用不依赖它的路径。');
});

test('_suggest: auth/antibot vs 5xx vs timeout vs network vs not-found branches', () => {
  const cases = [
    ['http-401', /目标拒绝访问/],
    ['http-403', /目标拒绝访问/],
    ['http-429', /目标拒绝访问/],
    ['permission', /目标拒绝访问/],
    ['http-503', /目标服务端错误（5xx）/],
    ['timeout', /所有路径均超时/],
    ['network', /网络不可达/],
    ['not-found', /目标资源不存在/],
  ];
  for (const [reason, re] of cases) {
    const s = SalvageProtector.assemble({ intent: 'i', lastFailure: { reason } });
    assert.match(s.next_action_suggestion, re, `reason=${reason}`);
  }
});

test('_suggest: http-404 deliberately does NOT take the auth branch (regex is 401|403|429)', () => {
  const s = SalvageProtector.assemble({
    intent: 'i',
    lastFailure: { reason: 'http-404' },
    attempted: [{ plan: 'WebSearch', reason: 'http-404' }],
  });
  assert.match(s.next_action_suggestion, /^已穷尽 1 条降级路径/);
  assert.match(s.next_action_suggestion, /最后失败于 WebSearch：http-404/);
});

test('_suggest: generic tail reports path count and last failed plan', () => {
  const s = SalvageProtector.assemble({
    intent: 'i',
    lastFailure: { reason: 'weird-code' },
    attempted: [
      { plan: 'A', reason: 'x' },
      { plan: 'B', reason: 'weird-code' },
    ],
  });
  assert.match(s.next_action_suggestion, /已穷尽 2 条降级路径（最后失败于 B：weird-code）/);
});

test('_suggest: no lastFailure at all still lands on the generic tail, never blank', () => {
  const s = SalvageProtector.assemble({
    intent: 'i',
    attempted: [{ plan: 'Only', reason: 'boom' }],
  });
  assert.match(s.next_action_suggestion, /最后失败于 Only：未知原因/);
});

test('circuit is reflected in the placeholder reason when attempted is empty', () => {
  const s = SalvageProtector.assemble({ intent: 'i', circuit: 'budget-floor' });
  assert.equal(s.attempted_paths[0].reason, 'aborted:budget-floor');
});
