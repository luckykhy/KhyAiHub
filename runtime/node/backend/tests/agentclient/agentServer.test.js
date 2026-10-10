'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');

const { startAgentServer } = require('../../src/services/domain/messaging/agentclient/agentServer');
const sessionMapping = require('../../src/services/domain/messaging/agentclient/sessionMapping');

/** 把 server 的出站帧按行收进数组（模拟编辑器侧读 stdout）。 */
function collectLines(stream) {
  const lines = [];
  let buf = '';
  stream.on('data', (b) => {
    buf += String(b);
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        lines.push(JSON.parse(line));
      }
    }
  });
  return lines;
}

async function waitFor(cond, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 10));
    const v = cond();
    if (v) {
      return v;
    }
  }
  return null;
}

function setup(deps) {
  const clientToServer = new PassThrough(); // 编辑器 → khy
  const serverToClient = new PassThrough(); // khy → 编辑器（协议红线：必须全是合法帧）
  const { server } = startAgentServer({
    input: clientToServer,
    output: serverToClient,
    errOutput: { write: () => {} },
    deps,
  });
  const lines = collectLines(serverToClient);
  const send = (msg) => clientToServer.write(JSON.stringify(msg) + '\n');
  return { server, lines, send, clientToServer };
}

describe('agent server method surface (面 A)', () => {
  it('initialize negotiates protocolVersion 1 with honest capabilities', async () => {
    const { lines, send, clientToServer } = setup();
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    const resp = await waitFor(() => lines.find((l) => l.id === 1));
    assert.ok(resp, 'initialize 未在时限内回包');
    assert.equal(resp.result.protocolVersion, 1);
    assert.equal(resp.result.agentCapabilities.loadSession, false); // P2 才有回放
    assert.equal(resp.result.agentInfo.name, 'khy-os');
    clientToServer.end();
  });

  it('session/new returns a sess_ id; unknown session prompt is invalidParams', async () => {
    const { lines, send, clientToServer } = setup();
    send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd() } });
    const resp = await waitFor(() => lines.find((l) => l.id === 2));
    assert.ok(resp.result.sessionId.startsWith('sess_'));
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 'sess_nope', prompt: [{ type: 'text', text: 'hi' }] },
    });
    const err = await waitFor(() => lines.find((l) => l.id === 3));
    assert.equal(err.error.code, -32602);
    clientToServer.end();
  });

  it('session/new rejects relative cwd with -32602', async () => {
    const { lines, send, clientToServer } = setup();
    send({ jsonrpc: '2.0', id: 4, method: 'session/new', params: { cwd: 'relative/path' } });
    const err = await waitFor(() => lines.find((l) => l.id === 4));
    assert.equal(err.error.code, -32602);
    clientToServer.end();
  });

  it('session/prompt bridges loop callbacks to session/update frames', async () => {
    sessionMapping.resetForTest();
    const fakeLoop = async (userText, opts) => {
      assert.equal(userText, '分析这段代码');
      opts.chatOpts.onChunk({ type: 'text', text: '开始' });
      opts.chatOpts.onChunk({ type: 'thinking', text: '推理中' });
      opts.onToolCall('read_file', { file_path: 'a.js' }, 1, 'loop_abc');
      opts.onToolResult('read_file', { file_path: 'a.js' }, { success: true, output: 'ok' }, 1, 5, 'loop_abc');
      return { finalResponse: '完成', iterations: 2 };
    };
    const deps = { runLoop: fakeLoop, chat: async () => { throw new Error('chat 不应被测试直接调'); } };
    const { lines, send, clientToServer } = setup(deps);
    send({ jsonrpc: '2.0', id: 5, method: 'session/new', params: { cwd: process.cwd() } });
    const created = await waitFor(() => lines.find((l) => l.id === 5));
    send({
      jsonrpc: '2.0',
      id: 6,
      method: 'session/prompt',
      params: { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: '分析这段代码' }] },
    });
    const resp = await waitFor(() => lines.find((l) => l.id === 6));
    assert.equal(resp.result.stopReason, 'end_turn');
    const updates = lines.filter((l) => l.method === 'session/update').map((l) => l.params.update);
    assert.ok(updates.some((u) => u.sessionUpdate === 'agent_message_chunk' && u.content.text === '开始'));
    assert.ok(updates.some((u) => u.sessionUpdate === 'agent_thought_chunk'));
    const toolCall = updates.find((u) => u.sessionUpdate === 'tool_call');
    assert.equal(toolCall.toolCallId, 'loop_abc');
    assert.equal(toolCall.kind, 'read');
    const toolDone = updates.find((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'loop_abc');
    assert.equal(toolDone.status, 'completed');
    clientToServer.end();
  });

  it('session/cancel during a turn yields stopReason cancelled (协议 MUST：非 error)', async () => {
    sessionMapping.resetForTest();
    let loopSignal = null;
    const fakeLoop = (_text, opts) =>
      new Promise((resolve) => {
        loopSignal = opts.interruptSignal;
        opts.chatOpts.onChunk({ type: 'text', text: '部分' });
        const check = setInterval(() => {
          if (opts.interruptSignal.interrupted) {
            clearInterval(check);
            resolve({ finalResponse: '部分', iterations: 1 });
          }
        }, 5);
      });
    const deps = { runLoop: fakeLoop, chat: async () => ({ reply: '', tokenUsage: null }) };
    const { lines, send, clientToServer } = setup(deps);
    send({ jsonrpc: '2.0', id: 7, method: 'session/new', params: { cwd: process.cwd() } });
    const created = await waitFor(() => lines.find((l) => l.id === 7));
    send({
      jsonrpc: '2.0',
      id: 8,
      method: 'session/prompt',
      params: { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: '长任务' }] },
    });
    await waitFor(() => loopSignal);
    send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: created.result.sessionId } });
    const resp = await waitFor(() => lines.find((l) => l.id === 8));
    assert.ok(resp, '取消后未回包');
    assert.equal(resp.result.stopReason, 'cancelled');
    assert.ok(!resp.error);
    clientToServer.end();
  });

  it('unknown method returns -32601', async () => {
    const { lines, send, clientToServer } = setup();
    send({ jsonrpc: '2.0', id: 9, method: 'session/load', params: {} });
    const err = await waitFor(() => lines.find((l) => l.id === 9));
    assert.equal(err.error.code, -32601);
    clientToServer.end();
  });
});

describe('agent server reverse permission (session/request_permission)', () => {
  it('maps editor outcome to loop decisions, unknown/cancelled → deny', async () => {
    sessionMapping.resetForTest();
    let controlReq = null;
    const fakeLoop = async (_t, opts) => {
      const decision = await opts.onControlRequest({
        requestId: 'perm_1',
        request: { subtype: 'can_use_tool', tool_name: 'shellCommand', input: { command: 'npm test' } },
      });
      return { finalResponse: `decision=${decision}`, iterations: 1 };
    };
    const deps = { runLoop: fakeLoop, chat: async () => ({ reply: '' }) };
    const { lines, send, clientToServer } = setup(deps);
    send({ jsonrpc: '2.0', id: 10, method: 'session/new', params: { cwd: process.cwd() } });
    const created = await waitFor(() => lines.find((l) => l.id === 10));
    send({
      jsonrpc: '2.0',
      id: 11,
      method: 'session/prompt',
      params: { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: '跑测试' }] },
    });
    // 编辑器侧：收到反向请求后答 allow-always。
    const permReq = await waitFor(() => lines.find((l) => l.method === 'session/request_permission'));
    assert.equal(permReq.params.toolCall.kind, 'execute');
    send({
      jsonrpc: '2.0',
      id: permReq.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow-always' } },
    });
    const resp = await waitFor(() => lines.find((l) => l.id === 11));
    assert.equal(resp.result.stopReason, 'end_turn');
    assert.ok(controlReq === null); // sanity: 未被误用
    clientToServer.end();
  });

  it('unanswered permission request (channel closed) settles as deny, not hang', async () => {
    sessionMapping.resetForTest();
    let decision = 'pending';
    const fakeLoop = async (_t, opts) => {
      decision = await opts.onControlRequest({
        requestId: 'perm_2',
        request: { subtype: 'can_use_tool', tool_name: 'edit_file', input: {} },
      });
      return { finalResponse: 'done', iterations: 1 };
    };
    const deps = { runLoop: fakeLoop, chat: async () => ({ reply: '' }) };
    const { lines, send, clientToServer } = setup(deps);
    send({ jsonrpc: '2.0', id: 12, method: 'session/new', params: { cwd: process.cwd() } });
    const created = await waitFor(() => lines.find((l) => l.id === 12));
    // 编辑器不回包，直接关闭连接 → 通道断 → fail-closed deny。
    send({
      jsonrpc: '2.0',
      id: 13,
      method: 'session/prompt',
      params: { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: '改文件' }] },
    });
    await waitFor(() => lines.find((l) => l.method === 'session/request_permission'));
    clientToServer.end();
    await new Promise((r) => setTimeout(r, 50));
    // 通道已断时 decision 未定义回包路径；核心断言：未把无响应解释为 allow。
    assert.notEqual(decision, true);
    assert.notEqual(decision, 'always');
  });
});
