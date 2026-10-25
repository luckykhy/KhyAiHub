'use strict';

/**
 * gelabActionGrammar.test.js — co-located suite for the model-output parser.
 *
 * IO: none. Every case here is a tolerance decision about what a 4B model
 * actually emits, pinned so a "cleanup" cannot quietly narrow the accepted
 * grammar and make the agent fail on inputs it used to survive.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const grammar = require('./gelabActionGrammar');

function ok(text) {
  const r = grammar.str2action(text);
  assert.equal(r.ok, true, `expected ok, got ${r.code}: ${r.error}`);
  return r.action;
}

function fails(text, code) {
  const r = grammar.str2action(text);
  assert.equal(r.ok, false, 'expected failure');
  assert.equal(r.code, code, `expected ${code}, got ${r.code}: ${r.error}`);
  return r;
}

test('parses CLICK with newline separated fields', () => {
  const a = ok('action: CLICK\nexplain: tap the icon\npoint: 500,500');
  assert.equal(a.action, 'CLICK');
  assert.equal(a.explain, 'tap the icon');
  assert.deepEqual(a.point, [500, 500]);
});

test('accepts x,y and x y point forms interchangeably', () => {
  assert.deepEqual(ok('action: CLICK\nexplain: x\npoint: 500,500').point, [500, 500]);
  assert.deepEqual(ok('action: CLICK\nexplain: x\npoint: 500 500').point, [500, 500]);
  assert.deepEqual(ok('action: CLICK\nexplain: x\npoint: 0,0').point, [0, 0]);
  assert.deepEqual(ok('action: CLICK\nexplain: x\npoint: 1000,1000').point, [1000, 1000]);
});

test('accepts tab separated fields on one line', () => {
  const a = ok('action: CLICK\texplain: x\tpoint: 500,500');
  assert.equal(a.action, 'CLICK');
  assert.deepEqual(a.point, [500, 500]);
});

test('value containing a colon is not split', () => {
  const a = ok('action: TYPE\nexplain: x\nvalue: https://example.com/a:b');
  assert.equal(a.value, 'https://example.com/a:b');
});

test('value containing a tab is rejected as bad_point', () => {
  // A tab is a field separator in this grammar, so a coordinate carrying one
  // is a half-emitted coordinate. Guessing the other half is how an agent
  // clicks the wrong thing.
  fails('action: CLICK\nexplain: x\npoint: 500\t500', 'bad_point');
});

test('normalises THINK tag variants <TINK> <think> < think> </THINK>', () => {
  const variants = [
    '<think>reasoning</think>',
    '<TINK>reasoning</TINK>',
    '<tink>reasoning</tink>',
    '< think >reasoning</ think >',
    '<THINK>reasoning</THINK>',
  ];
  for (const v of variants) {
    const a = ok(`${v}\naction: CLICK\nexplain: x\npoint: 1,2`);
    assert.equal(a.cot, 'reasoning', v);
  }
});

test('takes the last think block when several appear', () => {
  const a = ok('<think>first</think>\nsome prose\n<think>second</think>\naction: CLICK\nexplain: x\npoint: 1,2');
  assert.equal(a.cot, 'second');
});

test('falls back to kv parsing when THINK label is absent and leaves cot empty', () => {
  const a = ok('action: CLICK\nexplain: x\npoint: 1,2');
  assert.equal(a.cot, '');
});

test('strips markdown code fences', () => {
  const a = ok('```\naction: CLICK\nexplain: x\npoint: 1,2\n```');
  assert.equal(a.action, 'CLICK');
  const b = ok('```json\naction: BACK\nexplain: x\n```');
  assert.equal(b.action, 'BACK');
});

test('takes content after the last action: when several appear', () => {
  // A model that answers twice — or quotes its own previous answer — must not
  // have its stale first answer executed.
  const a = ok('action: CLICK\nexplain: first\npoint: 1,2\n\naction: BACK\nexplain: second');
  assert.equal(a.action, 'BACK');
  assert.equal(a.explain, 'second');
});

test('COMPLETE reads return not value', () => {
  const a = ok('action: COMPLETE\nexplain: done\nreturn: task finished');
  assert.equal(a.return, 'task finished');
  assert.equal(a.value, undefined);
  // And the other way round: reporting through `value` is a missing field.
  fails('action: COMPLETE\nexplain: done\nvalue: task finished', 'missing_field');
});

test('ABORT has no required field and reason lives only in explain', () => {
  const a = ok('action: ABORT\nexplain: the screen is a payment page');
  assert.equal(a.action, 'ABORT');
  assert.equal(a.explain, 'the screen is a payment page');
  assert.equal(grammar.REQUIRED_FIELDS.ABORT.length, 0);
});

test('ABORT accepts its reason in value or explain, as the shipped grammar moves it', () => {
  // parser_0920_summary puts the reason in `value`; the newer generation puts
  // it in `explain`. Both are honest, so neither is rejected.
  const viaValue = ok('action: ABORT\nexplain: giving up\nvalue: stuck on a login wall');
  assert.equal(viaValue.value, 'stuck on a login wall');
  const viaExplain = ok('action: ABORT\nexplain: stuck on a login wall');
  assert.equal(viaExplain.explain, 'stuck on a login wall');
  // But an ABORT with neither is a refusal, not a silent success.
  fails('action: ABORT', 'missing_field');
});

test('explain is required on every action because a human reads the step log', () => {
  fails('action: BACK', 'missing_field');
  fails('action: HOME', 'missing_field');
  fails('action: CLICK\npoint: 5,5', 'missing_field');
});

test('CALL_USER requires value and tag', () => {
  const a = ok('action: CALL_USER\nexplain: need a human\nvalue: please confirm the payment\ntag: confirm_action');
  assert.equal(a.tag, 'confirm_action');
  fails('action: CALL_USER\nexplain: x\nvalue: help', 'missing_field');
  fails('action: CALL_USER\nexplain: x\ntag: confirm_action', 'missing_field');
});

test('BACK and HOME parse with no parameters', () => {
  assert.equal(ok('action: BACK\nexplain: go back').action, 'BACK');
  assert.equal(ok('action: HOME\nexplain: to the launcher').action, 'HOME');
});

test('missing required fields yield missing_field, not a crash', () => {
  fails('action: CLICK\nexplain: x', 'missing_field');
  fails('action: SLIDE\nexplain: x\npoint1: 1,2', 'missing_field');
  fails('action: TYPE\nexplain: x', 'missing_field');
  fails('action: AWAKE\nexplain: x', 'missing_field');
});

test('unknown action names are rejected with the full list in the error', () => {
  const r = fails('action: FLY\nexplain: x', 'unknown_action');
  assert.match(r.error, /CLICK/);
  assert.match(r.error, /CALL_USER/);
});

test('empty and action-less output are coded, never thrown', () => {
  for (const bad of ['', '   ', undefined, null, 42, {}]) {
    const r = grammar.str2action(bad);
    assert.equal(r.ok, false);
    assert.ok(['empty', 'no_action'].includes(r.code), String(r.code));
  }
  assert.equal(grammar.str2action('just some prose, no fields').code, 'no_action');
});

test('the action list is the full eleven and is frozen', () => {
  assert.equal(grammar.GELAB_ACTIONS.length, 12);
  assert.throws(() => { grammar.GELAB_ACTIONS.push('NOPE'); });
});

test('action2str round-trips int and float without AttributeError', () => {
  // Upstream compared with `type(value) == int`, which is Python 2 and always
  // false, so every coordinate was rendered as a float. typeof keeps ints ints.
  const dict = { action: 'SLIDE', explain: 'x', cot: '', point1: [1, 2], point2: [1000, 999] };
  const text = grammar.action2str(dict);
  assert.match(text, /point1: 1,2/);
  assert.match(text, /point2: 1000,999/);
  assert.doesNotMatch(text, /1\.0/);
  const back = ok(text);
  assert.deepEqual(back.point1, [1, 2]);
  assert.deepEqual(back.point2, [1000, 999]);
});

test('describeAction renders one Chinese line per action', () => {
  assert.equal(grammar.describeAction({ action: 'CLICK', point: [500, 500] }), '点击 (500,500)');
  assert.equal(grammar.describeAction({ action: 'SLIDE', point1: [1, 2], point2: [3, 4] }), '从 (1,2) 滑到 (3,4)');
  assert.equal(grammar.describeAction({ action: 'BACK' }), '返回');
  assert.equal(grammar.describeAction({ action: 'HOME' }), '回到桌面');
  assert.equal(grammar.describeAction({ action: 'COMPLETE', return: 'done' }), '完成：done');
  assert.match(grammar.describeAction({ action: 'CALL_USER', value: 'pay', tag: 'confirm_action' }), /需要人介入/);
  assert.match(grammar.describeAction({ action: 'TYPE', value: 'hello' }), /输入/);
  assert.equal(grammar.describeAction(null), '（无法描述的动作）');
});

test('validateAction agrees with str2action on the same dict', () => {
  const a = ok('action: CLICK\nexplain: x\npoint: 5,5');
  assert.equal(grammar.validateAction(a).ok, true);
  assert.equal(grammar.validateAction({ action: 'CLICK', explain: 'x' }).ok, false);
  assert.equal(grammar.validateAction({ action: 'NOPE' }).code, 'unknown_action');
  assert.equal(grammar.validateAction({ action: 'CLICK', explain: 'x', point: [1] }).code, 'bad_point');
  assert.equal(grammar.validateAction(null).ok, false);
});

test('a repeated key keeps the first occurrence rather than guessing', () => {
  // Which of two `point:` lines the model "meant" is not knowable. Refusing to
  // guess is the whole design; this pins that the refusal is deterministic.
  const a = ok('action: CLICK\nexplain: x\npoint: 111,111\npoint: 999,999');
  assert.deepEqual(a.point, [111, 111]);
});
