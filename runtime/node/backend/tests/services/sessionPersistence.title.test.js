'use strict';
// Locks the session-title derivation quality bar in sessionPersistence.js
// (_buildSessionMeta / _pickTitleCandidate). The desktop sidebar and the '#'
// mention panel both fall back to firstUserMessage when title is '(untitled)';
// machine-injected user-role messages (tool-result relay, [SYSTEM:] protocol,
// slash/@ commands) and leading punctuation used to leak into task names.
// Whoever breaks this test first breaks the sidebar titles.
const test = require('node:test');
const assert = require('node:assert');
const { _buildSessionMeta, _pickTitleCandidate, _isSyntheticUserMessage } = require('../../src/services/sessionPersistence');

function metaFor(messages) {
  return _buildSessionMeta('/root/sess-1.json', { sessionId: 'sess-1', messages }, '/root');
}

test('真实用户消息 → 原样保留（含截断到 200）', () => {
  const long = '实现完整的用户认证系统'.repeat(30);
  const meta = metaFor([{ role: 'user', content: long }]);
  assert.strictEqual(meta.firstUserMessage.length, 200);
  assert.ok(meta.firstUserMessage.startsWith('实现完整的用户认证系统'));
});

test('合成消息被跳过：[Tool Result] / [SYSTEM: / 斜杠命令 / @文件', () => {
  const messages = [
    { role: 'user', content: '[Tool Result]\nYou are a general-purpose assistant...' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: '[SYSTEM: 你刚才对 khy 源码的改动(.claude/)]' },
    { role: 'user', content: '/cost请用 shell 工具执行 echo PERMTEST_ONLY' },
    { role: 'user', content: '@.env' },
    { role: 'user', content: '曲靖今天天气如何？' },
  ];
  const meta = metaFor(messages);
  assert.strictEqual(meta.firstUserMessage, '曲靖今天天气如何？');
});

test('全部是合成消息 → 回退保留非空标题，但剥离注入标记前缀', () => {
  const meta = metaFor([
    { role: 'user', content: '[Tool Result]\nraw payload' },
    { role: 'user', content: '/cost' },
  ]);
  assert.strictEqual(meta.firstUserMessage, 'raw payload');
});

test('前导标点被剥离：空 part 拍平留下的「，请用一句话…」', () => {
  assert.strictEqual(_pickTitleCandidate([{ role: 'user', content: '，请用一句话介绍你自己' }]),
    '请用一句话介绍你自己');
});

test('数组 content（多 part）拍平后再判定合成前缀', () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'tool_result', content: '' },
      { type: 'text', text: '帮我看看这段报错' },
    ],
  }];
  assert.strictEqual(_pickTitleCandidate(messages), '帮我看看这段报错');
});

test('_isSyntheticUserMessage：前缀精确匹配，正文中途出现不算', () => {
  assert.strictEqual(_isSyntheticUserMessage('[Tool Result] x'), true);
  assert.strictEqual(_isSyntheticUserMessage('[SYSTEM: y'), true);
  assert.strictEqual(_isSyntheticUserMessage('@file'), true);
  assert.strictEqual(_isSyntheticUserMessage('说说 [SYSTEM: 这是什么]'), false);
  assert.strictEqual(_isSyntheticUserMessage(''), false);
});

test('title 仍以快照 title 优先，firstUserMessage 只是回退源', () => {
  const data = { sessionId: 's', title: '我的任务', messages: [{ role: 'user', content: '[Tool Result] x' }] };
  const meta = _buildSessionMeta('/root/s.json', data, '/root');
  assert.strictEqual(meta.title, '我的任务');
});

test('无消息 / 空消息 → firstUserMessage 为空串', () => {
  assert.strictEqual(metaFor(undefined).firstUserMessage, '');
  assert.strictEqual(metaFor([]).firstUserMessage, '');
});
