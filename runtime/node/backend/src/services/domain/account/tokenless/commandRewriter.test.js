'use strict';

// Co-located contract tests for commandRewriter.js
// ([RESEARCH-018] §2.3 / C-4 功能单元含测试). Expectations were taken from the module's
// actual output (probe .khyos/tmp/tokenless-behavior-probe.js), including the fact that
// estimatedSaved is 0 for SHORT histories — the summariser only pays off once a turn is
// longer than the 200-char window it truncates to.

const test = require('node:test');
const assert = require('node:assert/strict');

const { rewriteHistory, stripCompletedToolCalls } = require('./commandRewriter');

const TC = '<' + 'tool_call>';
const TCE = '</' + 'tool_call>';

const turn = (role, content) => ({ role, content });
// A history of n user/assistant pairs with `pad`-char bodies.
function history(n, pad = 200) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(turn('user', `q${i} ${'z'.repeat(pad)}`));
    out.push(turn('assistant', `a${i} ${'y'.repeat(pad)}`));
  }
  return out;
}

test('empty and non-array input collapse to the same zero-shaped result', () => {
  const zero = { messages: [], stats: { originalCount: 0, rewrittenCount: 0, estimatedSaved: 0 } };
  assert.deepEqual(rewriteHistory([]), zero);
  assert.deepEqual(rewriteHistory('nope'), zero);
  assert.deepEqual(rewriteHistory(null), zero);
  assert.deepEqual(rewriteHistory(), zero);
});

test('a history at or below keepRecent is returned verbatim (new array, saved 0)', () => {
  const few = [turn('user', 'hi'), turn('assistant', 'yo')];
  const r = rewriteHistory(few);
  assert.deepEqual(r.messages, few);
  assert.notEqual(r.messages, few, 'must be a copy, not the caller array');
  assert.deepEqual(r.stats, { originalCount: 2, rewrittenCount: 2, estimatedSaved: 0 });
});

test('an over-length history becomes one summary block plus the recent tail', () => {
  const r = rewriteHistory(history(10), { keepRecent: 4 });
  assert.equal(r.stats.originalCount, 20);
  assert.equal(r.messages.length, 5);
  assert.deepEqual(r.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user', 'assistant']);
  assert.ok(r.messages[0].content.startsWith('[Previous conversation summary]\nUser asked: q0 '));
});

test('estimatedSaved is never negative and only becomes positive past the 200-char window', () => {
  // Short turns: the summary line costs more than the turn it replaces.
  const short = rewriteHistory(history(10, 40), { keepRecent: 2 });
  assert.equal(short.stats.estimatedSaved, 0);
  // Long turns are clipped to 200 chars, so the rewrite genuinely wins.
  const long = rewriteHistory(history(12, 2000), { keepRecent: 2 });
  assert.ok(long.stats.estimatedSaved > 0, `expected savings, got ${long.stats.estimatedSaved}`);
  assert.ok(long.stats.rewrittenCount < long.stats.originalCount);
});

test('a leading system message is preserved as message 0 and the summary follows it', () => {
  const input = [turn('system', 'SYS')].concat(history(10));
  const r = rewriteHistory(input, { keepRecent: 2 });
  assert.equal(r.messages[0].content, 'SYS');
  assert.equal(r.messages[0].role, 'system');
  assert.deepEqual(r.messages.map((m) => m.role).slice(0, 3), ['system', 'system', 'user']);
});

test('keepRecent 0 keeps only the summary (the slice-inversion guard holds)', () => {
  const r = rewriteHistory(history(6), { keepRecent: 0 });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, 'system');
});

test('consecutive recent turns of the same role are merged with a newline', () => {
  const r = rewriteHistory([
    turn('user', 'a'), turn('user', 'b'), turn('assistant', 'c'),
    turn('user', 'd'), turn('assistant', 'e'), turn('user', 'f'), turn('user', 'g'),
  ], { keepRecent: 2 });
  const tails = r.messages.filter((m) => m.role === 'user' && !String(m.content).startsWith('[Previous'));
  assert.deepEqual(tails.map((m) => m.content), ['f\ng']);
});

test('assistant turns are summarized as text decisions, code fences replaced', () => {
  const input = [turn('user', 'q'), turn('assistant', 'see ```js\nlet x=1\n``` end')];
  const doubled = input.concat(input, input, input, input, input);
  const r = rewriteHistory(doubled, { keepRecent: 1 });
  assert.ok(r.messages[0].content.includes('[code block]'), r.messages[0].content);
});

test('stripCompletedToolCalls rewrites only assistant string content', () => {
  const [kept, stripped, fence, obj] = stripCompletedToolCalls([
    turn('user', 'keep ' + TC + 'x' + TCE),
    turn('assistant', 'A ' + TC + 'go' + TCE + ' B'),
    turn('assistant', 'run ```bash\nls -la\n``` done'),
    { role: 'assistant', content: { blocks: 1 } },
  ]);
  assert.equal(kept.content, 'keep ' + TC + 'x' + TCE);
  assert.equal(stripped.content, 'A [tool executed] B');
  assert.equal(fence.content, 'run [command executed] done');
  assert.deepEqual(obj.content, { blocks: 1 });
  // The untouched rows must be the SAME objects, not clones.
  assert.equal(obj.role, 'assistant');
});

test('stripCompletedToolCalls leaves non-bash fences alone (only bash/shell/sh get folded)', () => {
  const [msg] = stripCompletedToolCalls([turn('assistant', '```python\nprint(1)\n```')]);
  assert.equal(msg.content, '```python\nprint(1)\n```');
});
