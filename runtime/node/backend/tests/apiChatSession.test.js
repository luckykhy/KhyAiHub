'use strict';

/**
 * apiChatSession.test.js — the /api/ai/chat/stream turn that lands in the
 * shared session store must be readable by every other end (desktop, TUI,
 * /api/khy-sessions), so this pins the on-disk result, not just the helpers:
 * message count, chain, title, source and createdAt continuity across turns.
 *
 * Data homes are redirected before any service is required — the resolvers
 * cache their paths at require time.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-api-chat-session-'));
process.env.KHY_DATA_HOME = path.join(TMP, 'khy');
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'project');
process.env.KHYOS_HOME = path.join(TMP, 'khyos');
delete process.env.KHY_DISABLE_SESSION_PERSIST;

const apiChatSession = require('../src/services/apiChatSession');
const sessionPersistence = require('../src/services/sessionPersistence');
const sessionSearchIndex = require('../src/services/sessionSearchIndex');

/** Snapshot writes on a cache-hit session are deferred to the next tick. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function readSnapshot(sessionId) {
  const file = sessionPersistence.jsonlPathFor(sessionId).replace(/\.jsonl$/, '.json');
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

describe('normalizeSessionId', () => {
  test('accepts the ids the app and the CLI mint', () => {
    assert.equal(apiChatSession.normalizeSessionId('conv_1762660000000'), 'conv_1762660000000');
    assert.equal(
      apiChatSession.normalizeSessionId('0c5f0d31-59a4-4ed1-9af8-e6833d5ee9b4'),
      '0c5f0d31-59a4-4ed1-9af8-e6833d5ee9b4'
    );
    assert.equal(apiChatSession.normalizeSessionId('  sess-abcdef12  '), 'sess-abcdef12');
  });

  test('rejects anything that cannot be a session file name', () => {
    for (const raw of ['../x', 'a b', 'a/b', '会话', 'x'.repeat(65), '', '   ', null, undefined, 42, {}]) {
      assert.equal(apiChatSession.normalizeSessionId(raw), null, JSON.stringify(raw));
    }
  });
});

describe('composeTurnMessages', () => {
  test('seeds a new session from client history, then appends the turn', () => {
    const messages = apiChatSession.composeTurnMessages({
      history: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，有什么可以帮你' },
        { role: 'system', content: 'skip me' },
        { role: 'user', content: '   ' },
      ],
      prompt: '第二个问题',
      reply: '第二个答复',
    });
    assert.deepStrictEqual(messages, [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你' },
      { role: 'user', content: '第二个问题' },
      { role: 'assistant', content: '第二个答复' },
    ]);
  });

  test('does not store the question twice when the client put it in history', () => {
    const messages = apiChatSession.composeTurnMessages({
      history: [{ role: 'user', content: '同一个问题' }],
      prompt: '同一个问题',
      reply: '答复',
    });
    assert.deepStrictEqual(messages.map((m) => [m.role, m.content]), [
      ['user', '同一个问题'],
      ['assistant', '答复'],
    ]);
  });

  test('a stored transcript wins over client history and keeps chain fields', () => {
    const prior = [
      { role: 'user', content: '盘上第一句', uuid: 'u1', parentUuid: null },
      { role: 'assistant', content: '盘上第一答', uuid: 'u2', parentUuid: 'u1' },
    ];
    const messages = apiChatSession.composeTurnMessages({
      prior,
      history: [{ role: 'user', content: '客户端以为的历史' }],
      prompt: '新问题',
      reply: '新答复',
    });
    assert.strictEqual(messages.length, 4);
    assert.strictEqual(messages[0].uuid, 'u1');
    assert.strictEqual(messages[2].content, '新问题');
  });

  test('caps how much client history a seed turn can import', () => {
    const history = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
    }));
    const messages = apiChatSession.composeTurnMessages({ history, prompt: 'q', reply: 'a' });
    assert.strictEqual(messages.length, 22);
    assert.strictEqual(messages[0].content, 'm20');
  });
});

describe('persistChatTurn', () => {
  test('round-trips two turns into one shared session', async () => {
    const sessionId = 'conv_1762660000000';

    const first = apiChatSession.persistChatTurn({
      sessionId,
      question: '第一句话',
      reply: '第一个回答',
      model: 'test-model',
      history: [{ role: 'user', content: '第一句话' }],
      cwd: path.join(TMP, 'workspace-a'),
    });
    assert.strictEqual(first, sessionId);
    await flush();

    const snap1 = readSnapshot(sessionId);
    assert.strictEqual(snap1.messages.length, 2);
    assert.strictEqual(snap1.title, '第一句话');
    assert.strictEqual(snap1.model, 'test-model');
    assert.deepStrictEqual(snap1.metadata.source, { type: 'manual', id: 'mobile' });
    assert.strictEqual(snap1.metadata.cwd, path.join(TMP, 'workspace-a'));

    const second = apiChatSession.persistChatTurn({
      sessionId,
      question: '第二句话',
      reply: '第二个回答',
      model: 'test-model',
      // A different cwd must not split the session into another bucket.
      cwd: path.join(TMP, 'workspace-b'),
    });
    assert.strictEqual(second, sessionId);
    await flush();

    const snap2 = readSnapshot(sessionId);
    assert.strictEqual(snap2.messages.length, 4);
    assert.strictEqual(snap2.title, '第一句话');
    assert.strictEqual(snap2.createdAt, snap1.createdAt);
    assert.strictEqual(snap2.metadata.cwd, path.join(TMP, 'workspace-a'));

    const restored = sessionPersistence.restoreSession(sessionId);
    assert.strictEqual(restored._source, 'jsonl');
    assert.deepStrictEqual(
      restored.messages.map((m) => [m.role, m.content]),
      [
        ['user', '第一句话'],
        ['assistant', '第一个回答'],
        ['user', '第二句话'],
        ['assistant', '第二个回答'],
      ]
    );

    // The list every other end reads: title/source/message count must agree.
    const row = sessionPersistence.listPersistedSessions({ limit: 200 }).find((s) => s.sessionId === sessionId);
    assert.ok(row, '会话必须出现在共享会话列表里');
    assert.strictEqual(row.title, '第一句话');
    assert.strictEqual(row.messageCount, 4);
    assert.strictEqual(row.sourceType, 'manual');
    assert.strictEqual(row.sourceId, 'mobile');
  });

  test('does not write when the client sent no session id', async () => {
    assert.strictEqual(
      apiChatSession.persistChatTurn({ question: 'q', reply: 'a', cwd: TMP }),
      null
    );
    assert.strictEqual(
      apiChatSession.persistChatTurn({ sessionId: '../escape', question: 'q', reply: 'a' }),
      null
    );
    await flush();
    assert.strictEqual(fs.existsSync(sessionPersistence.jsonlPathFor('../escape')), false);
  });

  test('does not write an empty answer', () => {
    assert.strictEqual(
      apiChatSession.persistChatTurn({ sessionId: 'conv_empty_answer', question: 'q', reply: '   ' }),
      null
    );
    assert.strictEqual(sessionPersistence.loadSessionMeta('conv_empty_answer'), null);
  });

  test('honors KHY_DISABLE_SESSION_PERSIST', async () => {
    process.env.KHY_DISABLE_SESSION_PERSIST = '1';
    try {
      assert.strictEqual(
        apiChatSession.persistChatTurn({ sessionId: 'conv_disabled', question: 'q', reply: 'a' }),
        null
      );
      await flush();
      assert.strictEqual(sessionPersistence.loadSessionMeta('conv_disabled'), null);
    } finally {
      delete process.env.KHY_DISABLE_SESSION_PERSIST;
    }
  });

  test('the stream route is actually wired to it', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf-8');
    assert.match(source, /require\('\.\.\/services\/apiChatSession'\)/);
    assert.match(source, /const persistedId = apiChatSession\.persistChatTurn\(\{/);
    assert.match(source, /apiChatSession\.normalizeSessionId\(/);
    // start + three done branches + the sync ack.
    const echoed = source.match(/sessionId: sharedSessionId/g) || [];
    assert.ok(echoed.length >= 5, `sessionId 回显点不足: ${echoed.length}`);
    // The client must be able to tell "id echoed" from "turn written": that is
    // what this event carries, and only callers that joined get it.
    assert.match(source, /type: 'sync', sessionId: sharedSessionId, persisted: !!persistedId/);
  });
});

test.after(async () => {
  try {
    sessionSearchIndex.shutdown();
  } catch {
    /* index may never have initialised */
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* Windows may still hold the sqlite handle; the temp dir is disposable */
  }
});
