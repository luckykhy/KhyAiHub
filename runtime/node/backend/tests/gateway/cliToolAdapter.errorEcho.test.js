'use strict';
// Locks the CLI upstream-error-echo detection in cliToolAdapter.js. Claude Code
// prints "API Error: ..." as its stream-json result and exits 0; before the
// guard, that echo was returned as a successful reply (success:true), which
// killed adapter failover and shipped raw English errors to the user as the
// assistant's answer (repro: .ai feedback task gateway-error-echo, audit event
// sess_muh25uvm llm.response attempts[] where provider "Claude Code" succeeded
// with contentPreview "API Error: Connection refused ...").
// Whoever breaks this test first re-opens that failure mode.
const test = require('node:test');
const assert = require('node:assert');
const {
  __test__: { _looksLikeCliErrorEcho, _cliErrorEchoDetectEnabled },
} = require('../../src/services/gateway/adapters/cliToolAdapter');

test('事故原文（单行 API Error 回声）→ 判定为错误回声', () => {
  assert.strictEqual(
    _looksLikeCliErrorEcho(
      'API Error: Connection refused \u2014 a firewall or proxy may be blocking it (ConnectionRefused)'
    ),
    true
  );
});

test('多行正文 / 无前缀正文 / 空串 → 不误判', () => {
  assert.strictEqual(_looksLikeCliErrorEcho('API Error: 开头但\n这是多行真实回答'), false);
  assert.strictEqual(_looksLikeCliErrorEcho(' Connection refused (ConnectionRefused)'), false);
  assert.strictEqual(_looksLikeCliErrorEcho(''), false);
  // 中途提到 API Error 的正常回答不命中（只匹配开头）
  assert.strictEqual(_looksLikeCliErrorEcho('看到 API Error: 401 时应先检查密钥'), false);
});

test('error: / fatal error: 前缀同样命中', () => {
  assert.strictEqual(_looksLikeCliErrorEcho('Error: connect ECONNREFUSED 127.0.0.1:3000'), true);
  assert.strictEqual(_looksLikeCliErrorEcho('Fatal error: model unavailable'), true);
});

test('超过 2000 字符的长文本不判回声（避免吞掉真实长回答）', () => {
  const long = 'API Error: ' + 'x'.repeat(2100);
  assert.strictEqual(_looksLikeCliErrorEcho(long), false);
});

test('门控默认开，KHY_CLI_ERROR_ECHO_DETECT=0 可逐字节回退', () => {
  assert.strictEqual(_cliErrorEchoDetectEnabled(), true);
  assert.strictEqual(
    _cliErrorEchoDetectEnabled({ KHY_CLI_ERROR_ECHO_DETECT: '0' }),
    false
  );
});
