'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');

const {
  encodeFrame,
  decodeFrame,
  createJsonRpcChannel,
} = require('../../src/services/domain/messaging/agentclient/jsonrpcStdio');

describe('acp frame codec', () => {
  it('encodeFrame appends newline; embedded newlines stay escaped by JSON', () => {
    assert.equal(encodeFrame({ a: 1 }), '{"a":1}\n');
    // JSON.stringify 对字符串值把 \n 转义成 \\n，帧不会错位；encodeFrame 的
    // 裸换行守卫只防带 toJSON 的怪对象（防御性，正常路径不触发）。
    assert.equal(encodeFrame({ a: 'x\ny' }), '{"a":"x\\ny"}\n');
  });

  it('decodeFrame parses, ignores blank lines', () => {
    assert.deepEqual(decodeFrame('{"a":1}'), { a: 1 });
    assert.equal(decodeFrame('   '), null);
    assert.throws(() => decodeFrame('not json'), SyntaxError);
  });
});

describe('jsonrpc channel', () => {
  it('routes inbound responses back to request() by id', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const channel = createJsonRpcChannel({ input, output, onMessage: () => {} });
    const pending = channel.request('session/request_permission', { sessionId: 's1' });
    // 对端回包（模拟编辑器）：读我们写出的请求，按 id 回 result。
    let wrote = '';
    output.on('data', (b) => (wrote += String(b)));
    await new Promise((r) => setTimeout(r, 20));
    input.write('{"jsonrpc":"2.0","id":1,"result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}\n');
    const resp = await pending;
    assert.deepEqual(resp.result.outcome, { outcome: 'selected', optionId: 'allow-once' });
    assert.ok(wrote.includes('"method":"session/request_permission"'));
    channel.close();
  });

  it('ignores unparseable inbound lines and keeps working', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const inbound = [];
    const channel = createJsonRpcChannel({ input, output, onMessage: (m) => inbound.push(m) });
    input.write('garbage line\n');
    input.write('{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s1"}}\n');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].method, 'session/cancel');
    channel.close();
  });

  it('rejects pending requests when the peer closes the stream', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const channel = createJsonRpcChannel({ input, output, onMessage: () => {} });
    const pending = channel.request('initialize', {});
    input.end();
    await assert.rejects(pending, /未获响应/);
  });

  it('honors err.code from onRequest throws', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let wrote = '';
    output.on('data', (b) => (wrote += String(b)));
    const err = new Error('需要 cwd 绝对路径');
    err.code = -32602;
    const channel = createJsonRpcChannel({
      input,
      output,
      onMessage: () => {},
      onRequest: () => {
        throw err;
      },
    });
    input.write('{"jsonrpc":"2.0","id":7,"method":"session/new","params":{}}\n');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(wrote.includes('"code":-32602'));
    assert.ok(wrote.includes('需要 cwd 绝对路径'));
    channel.close();
  });
});
