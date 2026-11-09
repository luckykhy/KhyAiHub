'use strict';

/**
 * multiFreeService.retryNoticeInbox.test.js — 死连接重试通告的落点回归。
 *
 * 病史（用户截图，2026-11-04）：TUI 会话里「连接被服务端关闭(ECONNRESET)，正在用
 * 新连接重试 OpenAI (第1/1次)...」压在**用户自己那句话的上面**。时序不可能——那条
 * 通告是用户这句话触发的请求发出的。
 *
 * 根因：通告用 `console.warn` 直写。ink 的 patch-console 把 warn 路由到 stderr 通道
 * （ink/build/ink.js 的 writeToStderr = `log.clear()` + 写行 + `restoreLastOutput()`），
 * 那一行落在**活帧上面**；默认 KHY_INLINE_TRANSCRIPT 下转录本身就是活帧的一部分，
 * 于是通告盖过了刚提交的用户消息。
 *
 * 修法：`_announceRetry` 先走 noticeInbox（TUI 落成 role:'notice' 转录行，次序正确），
 * 无人认领（经典 REPL / 单命令进程 / 测试）时回落 console.warn，逐字节回到旧行为。
 *
 * 复现脚本（端到端，含 ink 真身）：
 *   works/data/khy/feedback/econnreset-notice-order-20261104/repro.mjs
 */

const http = require('http');

const noticeInbox = require('../../src/utils/terminal/noticeInbox');
const MultiFreeService = require('../../src/services/multiFreeService');

// 上游桩：第一个请求 RST（真 ECONNRESET、无 err.response ⇒ 死连接），
// 第二个请求回一条真 SSE 流。与复现脚本同一手法。
function startUpstream() {
  let served = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      served += 1;
      if (served === 1) {
        if (typeof req.socket.resetAndDestroy === 'function') req.socket.resetAndDestroy();
        else req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
          }) +
          '\n\n'
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function providerOn(port) {
  return {
    name: 'OpenAI',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

describe('死连接重试通告：noticeInbox 优先，无人认领回落 console.warn', () => {
  beforeEach(() => {
    noticeInbox.resetForTest();
  });

  afterEach(() => {
    noticeInbox.resetForTest();
  });

  test('有订阅者（TUI 会话期）：通告进收件箱，不写 console.warn', async () => {
    const { server, port } = await startUpstream();
    const seen = [];
    const unsubscribe = noticeInbox.subscribe((line) => {
      seen.push(line);
      return true;
    });
    const warnings = [];
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation((...a) => warnings.push(a.join(' ')));

    let reply = null;
    try {
      reply = await new MultiFreeService().callOpenAI(providerOn(port), 'hi', {
        onChunk: () => {},
        timeoutMs: 5000,
      });
    } finally {
      warnSpy.mockRestore();
      unsubscribe();
      server.close();
    }

    // 重试确实成功了（否则这条断言先炸，后面的落点断言没有意义）。
    expect(reply.content).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/连接被服务端关闭/);
    expect(seen[0]).toMatch(/ECONNRESET/);
    expect(seen[0]).toMatch(/正在用新连接重试 OpenAI \(第1\/1次\)/);
    // 关键：收件箱已认领，就绝不能再落到 console —— 那正是压在用户消息上面的那条。
    expect(warnings.some((w) => w.includes('连接被服务端关闭'))).toBe(false);
  });

  test('无订阅者（经典 REPL / 单命令进程）：逐字节回落 console.warn', async () => {
    const { server, port } = await startUpstream();
    const warnings = [];
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation((...a) => warnings.push(a.join(' ')));

    let reply = null;
    try {
      reply = await new MultiFreeService().callOpenAI(providerOn(port), 'hi', {
        onChunk: () => {},
        timeoutMs: 5000,
      });
    } finally {
      warnSpy.mockRestore();
      server.close();
    }

    expect(reply.content).toBe('ok');
    const line = warnings.find((w) => w.includes('连接被服务端关闭'));
    expect(line).toBeTruthy();
    expect(line).toBe(
      '连接被服务端关闭(ECONNRESET)，正在用新连接重试 OpenAI (第1/1次)...'
    );
  });

  test('订阅者拒收（返回 false）时同样回落 console.warn', async () => {
    const { server, port } = await startUpstream();
    const unsubscribe = noticeInbox.subscribe(() => false);
    const warnings = [];
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation((...a) => warnings.push(a.join(' ')));

    try {
      await new MultiFreeService().callOpenAI(providerOn(port), 'hi', {
        onChunk: () => {},
        timeoutMs: 5000,
      });
    } finally {
      warnSpy.mockRestore();
      unsubscribe();
      server.close();
    }

    expect(warnings.some((w) => w.includes('正在用新连接重试'))).toBe(true);
  });
});
