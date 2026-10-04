'use strict';

/**
 * toolCallParser.truncatedFunctionTag.test.js — regression for max_tokens-truncated
 * function-tag tool calls (the D1 deferred-boundary closure + call-site salvage).
 *
 * A weak/truncated model emits an OPEN function-tag with no closing tag because
 * generation was cut off mid-JSON. The leaf now recovers that trailing tail
 * (gated KHY_FUNCTION_TAG_TRUNCATED_TOLERANT, default-on) and parseToolCalls
 * salvages the incomplete JSON body into real params, flagging the call
 * _repaired. This file builds the tag literals from char codes so the tool-call
 * dialect tokens never appear verbatim in source (they are mangled by some
 * editors' parsers).
 */

const { parseToolCalls } = require('../../src/services/toolCallParser');
const assert = require('node:assert/strict');

const LT = String.fromCharCode(60); // '<'
const GT = String.fromCharCode(62); // '>'

function ft(name, body, closed) {
  const open = LT + 'function=' + name + GT;
  return closed ? open + body + LT + '/function' + GT : open + body;
}

describe('parseToolCalls — truncated function-tag dialect (D1 salvage)', () => {
  test('truncated JSON tail is salvaged into a repaired call', () => {
    const calls = parseToolCalls('running now.\n' + ft('shell_command', '{"command": "ls -la'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'shell_command');
    assert.deepEqual(calls[0].params, { command: 'ls -la' });
    assert.equal(calls[0]._repaired, true, 'truncated recovery is flagged _repaired');
  });

  test('dangling trailing key is dropped so complete leading pairs survive', () => {
    const calls = parseToolCalls(ft('shell_command', '{"command": "ls", "cwd":'));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, { command: 'ls' });
    assert.equal(calls[0]._repaired, true);
  });

  test('well-formed closed call parses normally and is NOT flagged', () => {
    const calls = parseToolCalls(ft('shell_command', '{"command": "ls"}', true));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'shell_command');
    assert.deepEqual(calls[0].params, { command: 'ls' });
    assert.ok(!('_repaired' in calls[0]), 'closed call carries no _repaired marker');
  });

  test('truncation-tolerant gate off → byte-revert to no recovery', () => {
    const prev = process.env.KHY_FUNCTION_TAG_TRUNCATED_TOLERANT;
    process.env.KHY_FUNCTION_TAG_TRUNCATED_TOLERANT = 'off';
    try {
      assert.deepEqual(parseToolCalls(ft('shell_command', '{"command": "ls -la')), []);
    } finally {
      if (prev === undefined) delete process.env.KHY_FUNCTION_TAG_TRUNCATED_TOLERANT;
      else process.env.KHY_FUNCTION_TAG_TRUNCATED_TOLERANT = prev;
    }
  });
});
