'use strict';

// Co-located contract tests for responseCompressor.js (tokenless budget trimming).
//
// Every expectation below was copied from the module's ACTUAL output (probed with
// node -e before writing), not from the docstring. Where the returned object
// disagrees with the `{text:string}` / "reduce tokens" contract, the real behaviour
// is pinned under a KNOWN-DEFECT title and left unfixed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { compressResponse, compressToolOutput } = require('./responseCompressor');

test('compressResponse 对假值/非字符串返回空 text 与全零 stats', () => {
  for (const input of ['', null, undefined, false, 0]) {
    assert.deepEqual(compressResponse(input), {
      text: '',
      stats: { original: 0, compressed: 0, savedPercent: 0 },
    });
  }
});

test('compressResponse 去掉开场套话（仅句首生效，无 m 标志）', () => {
  assert.equal(compressResponse('Sure, go now.').text, 'go now.');
  assert.equal(compressResponse('Let me think about it').text, 'think about it');
  // The anchored patterns only match at the very start of the whole string.
  const mid = compressResponse('line one\nSure, go.');
  assert.equal(mid.text, 'line one\nSure, go.');
});

test('compressResponse 折叠多余空白：连续空行、空格串、纯空白行', () => {
  assert.equal(compressResponse('a\n\n\n\nb').text, 'a\n\nb');
  assert.equal(compressResponse('a    b').text, 'a b');
  assert.equal(compressResponse('a\n   \nb').text, 'a\n\nb');
});

test('compressResponse 合并重复分隔行：3 行才折叠，2 行保留', () => {
  assert.equal(compressResponse('----\n----\n----', { stripFillers: false, collapseWhitespace: false }).text, '----');
  assert.equal(compressResponse('----\n----', { stripFillers: false, collapseWhitespace: false }).text, '----\n----');
});

test('compressResponse 重复行合并的 40 字符边界：40 折叠、41 不折叠', () => {
  const L40 = 'y'.repeat(40);
  const L41 = 'x'.repeat(41);
  assert.equal(compressResponse(`${L40}\n${L40}\n${L40}`, { stripFillers: false, collapseWhitespace: false }).text, L40);
  assert.equal(compressResponse(`${L41}\n${L41}\n${L41}`, { stripFillers: false, collapseWhitespace: false }).text.length, 41 * 3 + 2);
});

test('compressResponse 关闭全部策略时原样返回（仅 trim）', () => {
  const r = compressResponse('  keep  me  ', { stripFillers: false, collapseWhitespace: false });
  assert.equal(r.text, 'keep  me');
});

test('compressResponse maxLength 超长截断并追加标记；未超长或 maxLength<=0 不动', () => {
  const cut = compressResponse('abcdefghij k', { maxLength: 5 });
  assert.equal(cut.text, 'abcde\n... [truncated]');
  const exact = compressResponse('abcdefghij', { maxLength: 10 });
  assert.equal(exact.text, 'abcdefghij');
  assert.equal(compressResponse('abcdefghij k', { maxLength: 0 }).text, 'abcdefghij k');
  assert.equal(compressResponse('abcdefghij k', { maxLength: -5 }).text, 'abcdefghij k');
});

test('compressResponse stats 报告 original/compressed/savedPercent 三个长度字段', () => {
  const r = compressResponse('Sure, this is a long-ish sentence that should shrink.');
  assert.equal(r.stats.original, 'Sure, this is a long-ish sentence that should shrink.'.length);
  assert.ok(r.stats.savedPercent > 0);
});

test('KNOWN-DEFECT: compressResponse 对真值非字符串把入参原样塞回 text，破坏 {text:string} 契约', () => {
  // Probe: compressResponse(5) -> { text: 5, stats: {0,0,0} } — the guard only
  // rejects FALSY non-strings, so a truthy number/object/array is echoed back and
  // stats claims a zero-length result even though text is the raw object.
  assert.equal(compressResponse(5).text, 5);
  assert.deepEqual(compressResponse({ a: 1 }).text, { a: 1 });
  assert.deepEqual(compressResponse([1, 2]).text, [1, 2]);
  assert.equal(compressResponse(5).stats.original, 0);
});

test('KNOWN-DEFECT: stats.compressed 计的是未 trim 的结果，与返回 text.length 不一致', () => {
  // Probe: "hi   " (5) -> text "hi" (2) but stats.compressed 5. The length is read
  // off `result` before the final `.trim()`, so callers trusting stats get wrong math.
  const r = compressResponse('hi   ', { stripFillers: false, collapseWhitespace: false });
  assert.equal(r.text, 'hi');
  assert.equal(r.text.length, 2);
  assert.equal(r.stats.compressed, 5);
});

test('KNOWN-DEFECT: maxLength 接近阈值时截断反而撑长文本，savedPercent 变负', () => {
  // Probe: original 12 chars, maxLength 10 -> slice(0,10) + '\n... [truncated]'
  // = 26 chars, so the "compressed" output is longer than the input and the
  // token-saving percentage goes negative.
  const r = compressResponse('abcdefghijkl', { maxLength: 10, stripFillers: false, collapseWhitespace: false });
  assert.equal(r.stats.original, 12);
  assert.equal(r.stats.compressed, 26);
  assert.equal(r.text.length, 26);
  assert.ok(r.stats.savedPercent < 0, 'expected negative savedPercent');
});

test('compressToolOutput 对假值返回空串、对不超长/等长原样返回', () => {
  assert.equal(compressToolOutput(''), '');
  assert.equal(compressToolOutput(0), '');
  assert.equal(compressToolOutput('abc', 10), 'abc');
  assert.equal(compressToolOutput('abcdefghij', 10), 'abcdefghij');
});

test('compressToolOutput 超长时保留头 70% 尾 20% 并标注省略字数', () => {
  const out = 'x'.repeat(200);
  const r = compressToolOutput(out, 100);
  const head = 'x'.repeat(70);
  const tail = 'x'.repeat(20);
  assert.equal(r, `${head}\n\n... [110 chars omitted] ...\n\n${tail}`);
});

test('KNOWN-DEFECT: compressToolOutput 对真值非字符串同样原样回传', () => {
  // Probe: compressToolOutput(5) -> 5 (not coerced, not stringified).
  assert.equal(compressToolOutput(5), 5);
  assert.deepEqual(compressToolOutput({ a: 1 }), { a: 1 });
});

test('KNOWN-DEFECT: compressToolOutput maxChars=0 把整段原文当“tail”泄漏，还声称全部省略', () => {
  // Probe: tailSize = floor(0*0.2) = 0, and output.slice(-0) === output.slice(0)
  // returns the WHOLE string. So maxChars in [0,4] (tailSize rounds to 0) inflates
  // the output beyond the original while the marker reports every char omitted.
  const out = 'y'.repeat(50);
  const r = compressToolOutput(out, 0);
  assert.ok(r.includes(out), 'full payload leaks as the zero-size tail');
  assert.match(r, /\[50 chars omitted\]/);
  assert.ok(r.length > out.length, 'output grew past the intended cap');
});
