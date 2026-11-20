'use strict';

/**
 * AGT-03：会话的对象级授权。
 *
 * 修复前：会话存储键只有 (bucket=cwd, sessionId)，没有用户维度；/api/khy-sessions
 * 的两个处理器只认证不授权 —— 任一已登录用户都能读任何会话全文；/api/ai/chat
 * 也允许任何已登录用户带别人的 sessionId 往他人会话追加消息（跨用户注入）。
 *
 * 修复后：会话元数据记录 ownerUserId；读侧非属主一律 404（含无属主的旧会话，
 * fail-closed）；写侧非属主直接不落盘。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockTmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-session-owner-'));
process.env.KHY_PROJECT_DATA_HOME = mockTmpHome;
process.env.KHY_DATA_HOME = mockTmpHome;

const express = require('express');
const request = require('supertest');

jest.mock('../../src/utils/dataHome', () => {
  const actual = jest.requireActual('../../src/utils/dataHome');
  return {
    ...actual,
    getProjectDataDir: (...segs) => {
      const p = require('path').join(mockTmpHome, ...segs);
      require('fs').mkdirSync(p, { recursive: true });
      return p;
    },
    getDataHome: () => mockTmpHome,
  };
});

const sessionPersistence = require('../../src/services/sessionPersistence');
const apiChatSession = require('../../src/services/apiChatSession');
const sessionsRouter = require('../../src/routes/khySessions');

function makeApp(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = userId == null ? null : { id: userId };
    next();
  });
  app.use('/api/khy-sessions', sessionsRouter);
  return app;
}

describe('AGT-03 会话属主', () => {
  afterAll(() => {
    try {
      fs.rmSync(mockTmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('写入时记录属主；属主可读，他人得到 404', async () => {
    const sid = 'sess-owner-a';
    const wrote = apiChatSession.persistChatTurn({
      sessionId: sid,
      question: '我的私有问题',
      reply: '我的私有回答',
      userId: 'u-A',
      cwd: mockTmpHome,
    });
    expect(wrote).toBe(sid);

    const okRes = await request(makeApp('u-A')).get(`/api/khy-sessions/${sid}`);
    expect(okRes.status).toBe(200);
    expect(JSON.stringify(okRes.body.data.messages)).toContain('我的私有回答');

    const crossRes = await request(makeApp('u-B')).get(`/api/khy-sessions/${sid}`);
    expect(crossRes.status).toBe(404);
    // 不泄露存在性：与真正不存在的 id 同一个 404 形状
    const missing = await request(makeApp('u-B')).get('/api/khy-sessions/sess-nope');
    expect(missing.status).toBe(404);
    expect(crossRes.body.message).toBe(missing.body.message);
  });

  test('列表只返回自己的会话', async () => {
    apiChatSession.persistChatTurn({
      sessionId: 'sess-owner-b',
      question: 'B 的问题',
      reply: 'B 的回答',
      userId: 'u-B',
      cwd: mockTmpHome,
    });

    const aList = await request(makeApp('u-A')).get('/api/khy-sessions');
    expect(aList.status).toBe(200);
    const aIds = aList.body.data.sessions.map((s) => s.sessionId);
    expect(aIds).toContain('sess-owner-a');
    expect(aIds).not.toContain('sess-owner-b');
  });

  test('未认证（无 req.user）一律拿不到会话', async () => {
    const res = await request(makeApp(null)).get('/api/khy-sessions/sess-owner-a');
    expect(res.status).toBe(404);
  });

  test('他人不能往我的会话追加消息（写侧同样校验）', () => {
    const sid = 'sess-owner-c';
    apiChatSession.persistChatTurn({
      sessionId: sid,
      question: 'C 问',
      reply: 'C 答',
      userId: 'u-A',
      cwd: mockTmpHome,
    });

    const stolen = apiChatSession.persistChatTurn({
      sessionId: sid,
      question: 'B 注入',
      reply: 'B 注入的回答',
      userId: 'u-B',
      cwd: mockTmpHome,
    });
    expect(stolen).toBeNull();

    // 磁盘上仍是 A 的内容，未被注入
    const restored = sessionPersistence.restoreSession(sid);
    const flat = JSON.stringify(restored && restored.messages);
    expect(flat).not.toContain('B 注入');
    expect(restored.metadata.ownerUserId).toBe('u-A');
  });

  test('认不出请求者（userId 为空）时不能续写有属主的会话（写侧 fail-closed）', () => {
    const sid = 'sess-owner-d';
    apiChatSession.persistChatTurn({
      sessionId: sid,
      question: 'D 问',
      reply: 'D 答',
      userId: 'u-A',
      cwd: mockTmpHome,
    });

    // 读侧对空身份早已 fail-closed（见上一组用例）；写侧必须给出同一答案，
    // 否则「对象级授权」在两条路径上是两种判定。
    const anonymous = apiChatSession.persistChatTurn({
      sessionId: sid,
      question: '匿名注入',
      reply: '匿名注入的回答',
      cwd: mockTmpHome,
    });
    expect(anonymous).toBeNull();

    const restored = sessionPersistence.restoreSession(sid);
    expect(JSON.stringify(restored && restored.messages)).not.toContain('匿名注入');
  });

  test('无属主的旧会话：HTTP 读按不存在处理（fail-closed）', async () => {
    const sid = 'sess-legacy';
    // 模拟修复前落盘的会话：直接 persistSession 且不带 ownerUserId
    sessionPersistence.persistSession(sid, {
      messages: [
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: '旧回答' },
      ],
      title: 'legacy',
      model: 'demo',
      metadata: { cwd: mockTmpHome },
    });

    const res = await request(makeApp('u-A')).get(`/api/khy-sessions/${sid}`);
    expect(res.status).toBe(404);

    // CLI 直读路径（不经 HTTP）仍可恢复 —— 不影响本地使用
    const restored = sessionPersistence.restoreSession(sid);
    expect(JSON.stringify(restored && restored.messages)).toContain('旧回答');
  });
});
