'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { SessionMetaSchema, SessionMessageSchema, AppendResultSchema } = require('./session.schema');

test('会话元数据：id/cwd/terminalId 必填，title 可缺省', () => {
  const meta = SessionMetaSchema.parse({ id: 's1', cwd: 'D:/w', terminalId: 'cli', createdAt: 1 });
  assert.strictEqual(meta.title, undefined);
  assert.strictEqual(SessionMetaSchema.safeParse({ id: 's1', cwd: '', terminalId: 'cli', createdAt: 1 }).success, false);
});

test('消息：role 限定四值，clientMsgId 必填（幂等键）', () => {
  const msg = SessionMessageSchema.parse({ role: 'user', content: 'hi', clientMsgId: 'm1' });
  assert.strictEqual(msg.ts, undefined);
  assert.strictEqual(SessionMessageSchema.safeParse({ role: 'human', content: 'x', clientMsgId: 'm' }).success, false);
  assert.strictEqual(SessionMessageSchema.safeParse({ role: 'user', content: 'x' }).success, false);
});

test('append 结果：seq 非负、deduped 布尔', () => {
  assert.strictEqual(AppendResultSchema.safeParse({ seq: 0, deduped: false }).success, true);
  assert.strictEqual(AppendResultSchema.safeParse({ seq: '0', deduped: 'no' }).success, false);
});
