'use strict';

/**
 * toolCallParser.truncatedXmlToolCall.test.js — regression for T5: the Format 2d
 * nested-XML tool-call dialect cut off by max_tokens (deferred-boundary closure).
 *
 * A weak model emits the Claude-style nested block
 *   <tool_call> <Read> <args> <file_path>…</file_path> …
 * and generation stops before the closing tags arrive. The main Format 2d pass
 * requires </args></ToolName> so it never matches a truncated tail — the call is
 * silently dropped (same "tool never executed" family as the function-tag hole).
 * T5 recovers the trailing OPENED block, keeping only parameter pairs that
 * themselves closed and dropping the dangling last one; gated
 * KHY_XML_TOOLCALL_TRUNC_TOLERANT (default-on), OFF → byte-revert to no recovery.
 *
 * Tags are assembled from char codes so the source never contains a verbatim tool
 * -call dialect token (which some editors'/parsers mangle).
 */

const { parseToolCalls } = require('../../src/services/toolCallParser');
const assert = require('node:assert/strict');

const LT = String.fromCharCode(60); // '<'
const GT = String.fromCharCode(62); // '>'

function block(name, innerParams, opts) {
  const o = opts || {};
  let s = LT + 'tool_call' + GT + LT + name + GT + LT + 'args' + GT;
  for (const p of innerParams) {
    s += LT + p.k + GT + p.v + (p.closed ? LT + '/' + p.k + GT : '');
  }
  if (o.closeInner) s += LT + '/args' + GT + LT + '/' + name + GT;
  if (o.closeOuter) s += LT + '/tool_call' + GT;
  return s;
}

describe('parseToolCalls T5 — truncated nested-XML dialect recovery', () => {
  test('well-formed closed block parses normally and is NOT flagged', () => {
    const calls = parseToolCalls(
      block('Read', [{ k: 'file_path', v: 'a.txt', closed: true }], {
        closeInner: true,
        closeOuter: true,
      })
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.file_path, 'a.txt');
    assert.ok(!('_repaired' in calls[0]), 'closed block carries no _repaired marker');
  });

  test('truncated tail recovers the one closed parameter', () => {
    const calls = parseToolCalls(
      block('Read', [
        { k: 'file_path', v: 'a.txt', closed: true },
        { k: 'offset', v: '12', closed: false },
      ])
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.file_path, 'a.txt');
    assert.ok(!('offset' in calls[0].params), 'dangling unclosed parameter is dropped');
    assert.equal(calls[0]._repaired, true);
  });

  test('tail with no closed parameter → nothing recoverable', () => {
    const calls = parseToolCalls(
      block('Read', [{ k: 'file_path', v: 'a.t', closed: false }])
    );
    assert.deepEqual(calls, []);
  });

  test('truncation-tolerant gate off → byte-revert (no recovery)', () => {
    const prev = process.env.KHY_XML_TOOLCALL_TRUNC_TOLERANT;
    process.env.KHY_XML_TOOLCALL_TRUNC_TOLERANT = 'off';
    try {
      const calls = parseToolCalls(
        block('Read', [{ k: 'file_path', v: 'a.txt', closed: true }])
      );
      assert.deepEqual(calls, []);
    } finally {
      if (prev === undefined) delete process.env.KHY_XML_TOOLCALL_TRUNC_TOLERANT;
      else process.env.KHY_XML_TOOLCALL_TRUNC_TOLERANT = prev;
    }
  });
});
