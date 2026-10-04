'use strict';
// Locks the api_retry / system-error reason extraction shared by
// _streamProcessor.js and cliToolAdapter.js. Before the fix, Claude Code's
// api_retry events carried `error` as null (transport failures) or as an
// object, and the status line printed "(unknown)" / "[object Object]" —
// hiding the actual failure reason from the user (repro 2026-09-26:
// "Claude API retry 4/10 (unknown)" during a ConnectionRefused outage).
const test = require('node:test');
const assert = require('node:assert');
const { processStreamEvent, extractStreamErrorReason } = require('../../src/services/gateway/adapters/_streamProcessor');

function statusTextOf(event) {
  const chunks = [];
  processStreamEvent(event, (c) => chunks.push(c), () => {}, null);
  return chunks.length > 0 ? chunks[0].text : '';
}

test('error 为字符串 → 原样透出', () => {
  assert.strictEqual(
    statusTextOf({ type: 'system', subtype: 'api_retry', attempt: 4, max_retries: 10, error: 'overloaded_error' }),
    'Claude API retry 4/10 (overloaded_error)'
  );
});

test('error 为对象 → 取 type/message，不再打出 [object Object]', () => {
  const text = statusTextOf({
    type: 'system',
    subtype: 'api_retry',
    attempt: 2,
    max_retries: 10,
    error: { type: 'connection_refused', message: 'Unable to connect' },
  });
  assert.strictEqual(text, 'Claude API retry 2/10 (connection_refused: Unable to connect)');
});

test('error 缺失但有 error_status → 透出 HTTP 状态码', () => {
  const text = statusTextOf({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 5, error_status: 529 });
  assert.strictEqual(text, 'Claude API retry 1/5 (HTTP 529)');
});

test('全部字段为空 → 如实 unknown（不编造原因）', () => {
  assert.strictEqual(extractStreamErrorReason({ type: 'system', subtype: 'api_retry' }), 'unknown');
  assert.strictEqual(extractStreamErrorReason(null), 'unknown');
});

test('system error 子类型同样走提取器', () => {
  const text = statusTextOf({ type: 'system', subtype: 'error', error: { type: 'auth_error' } });
  assert.strictEqual(text, 'Claude system error: auth_error');
});
