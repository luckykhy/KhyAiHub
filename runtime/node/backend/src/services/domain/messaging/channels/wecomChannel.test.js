'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const inboundPath = require.resolve('../messaging/msgInboundCore');
const senderPath = require.resolve('../messaging/msgSender');

let inboundCalls;
let sendCalls;
let inboundResult;
let sendResult;

function installStub(abs, exports) {
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
}

const senderStub = {
  sendText(args) {
    sendCalls.push(args);
    return Promise.resolve(sendResult);
  },
};

// The webhook POST lives inside msgSender and the AES/SHA1 work inside
// msgInboundCore; both are replaced by recorders before the channel loads so
// this suite cannot open a socket or read a credential.
installStub(inboundPath, {
  handleWecom(args) {
    inboundCalls.push(args);
    return inboundResult;
  },
});
installStub(senderPath, senderStub);

const { WecomChannel } = require('./wecomChannel');
const { BaseChannel } = require('./_baseChannel');

after(() => {
  delete require.cache[inboundPath];
  delete require.cache[senderPath];
  delete require.cache[require.resolve('./wecomChannel')];
});

beforeEach(() => {
  inboundCalls = [];
  sendCalls = [];
  inboundResult = { ok: true, kind: 'event', message: { platform: 'wecom', userId: '', text: '', raw: '' } };
  sendResult = { ok: true, status: 200 };
});

test('导出面只有 WecomChannel 且继承 BaseChannel，name 钉成 wecom', () => {
  assert.deepStrictEqual(Object.keys(require('./wecomChannel')), ['WecomChannel']);
  const c = new WecomChannel({ webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook' });
  assert.ok(c instanceof BaseChannel);
  assert.equal(c.name, 'wecom');
  assert.equal(c.connected, false);
});

test('config 缺字段与非对象入参都回落空串，假值字段不报错', () => {
  const bare = new WecomChannel();
  assert.equal(bare.webhook, '');
  assert.equal(bare.token, '');
  assert.equal(bare.encodingAesKey, '');
  assert.deepStrictEqual(bare.config, {});
  const partial = new WecomChannel({ token: 'T' });
  assert.equal(partial.webhook, '');
  assert.equal(partial.encodingAesKey, '');
  const odd = new WecomChannel({ webhook: {}, token: 0, encodingAesKey: false });
  assert.deepStrictEqual(odd.webhook, {});
  assert.equal(odd.token, '');
  assert.equal(odd.encodingAesKey, '');
});

test('connect 缺 webhook 时抛固定错误且不发 connected', async () => {
  const c = new WecomChannel({});
  let fired = 0;
  c.on('connected', () => {
    fired += 1;
  });
  await assert.rejects(() => c.connect(), /^Error: wecom: webhook is required$/);
  assert.equal(fired, 0);
  assert.equal(c.connected, false);
});

test('connect 有 webhook 时置连接并 emit connected，disconnect 复位', async () => {
  const c = new WecomChannel({ webhook: 'https://group' });
  const events = [];
  c.on('connected', () => events.push('connected'));
  c.on('disconnected', () => events.push('disconnected'));
  await c.connect();
  assert.equal(c.connected, true);
  await c.disconnect();
  assert.equal(c.connected, false);
  assert.deepStrictEqual(events, ['connected', 'disconnected']);
});

test('sendMessage 只交平台标记、群 webhook 与文本，不带任何签名字段', async () => {
  const c = new WecomChannel({ webhook: 'https://group', token: 'T', encodingAesKey: 'AES' });
  const result = await c.sendMessage('chatid-1', '你好');
  assert.deepStrictEqual(sendCalls, [{ platform: 'wecom', webhook: 'https://group', text: '你好' }]);
  assert.equal(result, sendResult);
  assert.equal('secret' in sendCalls[0], false);
  assert.equal('token' in sendCalls[0], false);
});

test('发送失败时 emit error 且原样返回失败结果（不抛）', async () => {
  const c = new WecomChannel({ webhook: 'https://group' });
  const failure = { ok: false, status: 200, error: '企业微信返回错误 93000' };
  sendResult = failure;
  const errs = [];
  c.on('error', (payload) => errs.push(payload));
  const result = await c.sendMessage('room', 'hi');
  assert.equal(result, failure);
  assert.equal(errs.length, 1);
  assert.ok(errs[0].error instanceof Error);
  assert.equal(errs[0].error.message, '企业微信返回错误 93000');
});

test('失败结果缺 error 字段时 emit 空消息 Error；成功不 emit', async () => {
  const c = new WecomChannel({ webhook: 'https://group' });
  const errs = [];
  c.on('error', (payload) => errs.push(payload));
  sendResult = { ok: false };
  await c.sendMessage('room', 'hi');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].error.message, '');
  sendResult = { ok: true };
  await c.sendMessage('room', 'hi');
  assert.equal(errs.length, 1);
});

test('sendReply 委托 sendMessage 并丢掉 threadId', async () => {
  const c = new WecomChannel({ webhook: 'https://group' });
  await c.sendReply('chatid-1', 'th-9', '回复');
  assert.deepStrictEqual(sendCalls[0], { platform: 'wecom', webhook: 'https://group', text: '回复' });
});

test('handleInbound 把渠道凭据与回调参数拼成单对象交 core，并广播归一消息', () => {
  const c = new WecomChannel({ webhook: 'https://group', token: 'T', encodingAesKey: 'AES' });
  inboundResult = {
    ok: true, kind: 'event',
    message: { platform: 'wecom', userId: 'ZhangSan', text: '在吗', msgType: 'text', chatId: 'wr_chat', raw: 'xml-plain' },
  };
  const msgs = [];
  c.on('message', (m) => msgs.push(m));
  const args = { timestamp: '1700000000', nonce: 'n1', msgSignature: 'sig', xmlBody: 'encrypt-block' };
  const ret = c.handleInbound(args);
  assert.deepStrictEqual(ret, { ok: true, kind: 'event' });
  assert.deepStrictEqual(inboundCalls[0], {
    token: 'T', encodingAesKey: 'AES', timestamp: '1700000000', nonce: 'n1',
    msgSignature: 'sig', echostr: undefined, xmlBody: 'encrypt-block',
  });
  assert.equal(inboundCalls[0].hasOwnProperty('echostr'), true);
  assert.equal(inboundCalls[0] === args, false);
  assert.equal(msgs.length, 1);
  assert.deepStrictEqual(msgs[0], {
    channelId: 'wr_chat', userId: 'ZhangSan', text: '在吗', threadId: '', timestamp: '1700000000', raw: 'xml-plain',
  });
});

test('GET 地址校验（echostr）透传 core 的 verify 结果且不 emit message', () => {
  const c = new WecomChannel({ webhook: 'https://group', token: 'T', encodingAesKey: 'AES' });
  inboundResult = { ok: true, kind: 'verify', plaintext: 'echo-plain', receiveId: 'corp' };
  const msgs = [];
  c.on('message', (m) => msgs.push(m));
  const ret = c.handleInbound({ echostr: 'e', timestamp: '1', nonce: '2', msgSignature: '3' });
  assert.equal(ret, inboundResult);
  assert.equal(inboundCalls[0].echostr, 'e');
  assert.equal(inboundCalls[0].xmlBody, undefined);
  assert.equal(msgs.length, 0);
});

test('core 判失败时原样返回错误对象、不 emit', () => {
  const c = new WecomChannel({ webhook: 'https://group' });
  inboundResult = { ok: false, error: '企业微信 msg_signature 校验失败。' };
  const msgs = [];
  c.on('message', (m) => msgs.push(m));
  assert.equal(c.handleInbound({}), inboundResult);
  assert.equal(msgs.length, 0);
});

test('文本为空不 emit；chatId 缺失时 channelId 回落群 webhook', () => {
  const c = new WecomChannel({ webhook: 'https://group' });
  const msgs = [];
  c.on('message', (m) => msgs.push(m));
  inboundResult = { ok: true, kind: 'event', message: { platform: 'wecom', text: '', chatId: '', raw: '' } };
  assert.deepStrictEqual(c.handleInbound({ timestamp: '1' }), { ok: true, kind: 'event' });
  assert.equal(msgs.length, 0);
  inboundResult = { ok: true, kind: 'event', message: { platform: 'wecom', text: 'hi', chatId: '' } };
  c.handleInbound({});
  assert.equal(msgs[0].channelId, 'https://group');
  assert.equal(msgs[0].userId, undefined);
});

test('handleInbound 省略参数走默认空对象，字段全缺时照样拼对象转交 core', () => {
  const c = new WecomChannel({ webhook: 'https://group' });
  assert.deepStrictEqual(c.handleInbound(), { ok: true, kind: 'event' });
  assert.deepStrictEqual(inboundCalls[0], {
    token: '', encodingAesKey: '', timestamp: undefined, nonce: undefined,
    msgSignature: undefined, echostr: undefined, xmlBody: undefined,
  });
});

test('KNOWN-DEFECT: handleInbound(null) 默认参数兜不住 null，拼参数时直接抛 TypeError', () => {
  const c = new WecomChannel({ webhook: 'https://group' });
  assert.throws(() => c.handleInbound(null), TypeError);
  assert.equal(inboundCalls.length, 0);
});

test('toJSON 只上报 has* 布尔，不泄露 webhook/token/AESKey', () => {
  const full = new WecomChannel({ webhook: 'https://group', token: 'TOK', encodingAesKey: 'AESKEY' });
  assert.deepStrictEqual(full.toJSON(), {
    name: 'wecom', connected: false, hasWebhook: true, hasToken: true, hasAesKey: true,
  });
  const bare = new WecomChannel();
  assert.deepStrictEqual(bare.toJSON(), {
    name: 'wecom', connected: false, hasWebhook: false, hasToken: false, hasAesKey: false,
  });
  assert.equal(JSON.stringify(full).includes('AESKEY'), false);
  assert.equal(JSON.stringify(full).includes('TOK'), false);
});

test('KNOWN-DEFECT: timestamp 为数字 0 时被 String(... ||) 吞成空串，其它非字符串被强转', () => {
  const c = new WecomChannel({ webhook: 'https://group' });
  const msgs = [];
  c.on('message', (m) => msgs.push(m));
  inboundResult = { ok: true, kind: 'event', message: { platform: 'wecom', text: 'hi', chatId: 'oc' } };
  const last = () => msgs[msgs.length - 1];
  c.handleInbound({ timestamp: 0 });
  assert.equal(last().timestamp, '');
  c.handleInbound({ timestamp: 1700 });
  assert.equal(last().timestamp, '1700');
  c.handleInbound({ timestamp: { v: 1 } });
  assert.equal(last().timestamp, '[object Object]');
});

test('KNOWN-DEFECT: toJSON 的脱敏是假的——config 与调用方对象同引用，inspect/展开带出明文凭据', () => {
  const cfg = { webhook: 'https://group', token: 'TOK', encodingAesKey: 'AESKEY' };
  const c = new WecomChannel(cfg);
  assert.equal(c.config, cfg);
  assert.equal(require('util').inspect(c).includes('AESKEY'), true);
  const copy = Object.assign({}, c);
  assert.equal(copy.token, 'TOK');
  assert.equal(copy.encodingAesKey, 'AESKEY');
});

test('KNOWN-DEFECT: sendMessage 忽略 channelId 与 opts，定向投递与消息类型都传不出去', async () => {
  const c = new WecomChannel({ webhook: 'https://group' });
  await c.sendMessage('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=other', 'hi', { msgtype: 'markdown' });
  assert.deepStrictEqual(sendCalls[0], { platform: 'wecom', webhook: 'https://group', text: 'hi' });
  assert.equal('channelId' in sendCalls[0], false);
  assert.equal('msgtype' in sendCalls[0], false);
});

test('KNOWN-DEFECT: connect 只是置标志，未连接且 webhook 为空时 sendMessage 照旧把空目标交给 sender', async () => {
  const c = new WecomChannel();
  assert.equal(c.connected, false);
  const result = await c.sendMessage('room', 'hi');
  assert.deepStrictEqual(sendCalls[0], { platform: 'wecom', webhook: '', text: 'hi' });
  assert.equal(result, sendResult);
});

test('KNOWN-DEFECT: 任何 ok 且非 verify 的结果都上报成 kind=event，即使 core 没给出消息', () => {
  const c = new WecomChannel({ webhook: 'https://group' });
  const msgs = [];
  c.on('message', (m) => msgs.push(m));
  inboundResult = { ok: true };
  assert.deepStrictEqual(c.handleInbound({}), { ok: true, kind: 'event' });
  inboundResult = { ok: true, kind: 'future-kind', message: { text: 'hi' } };
  assert.deepStrictEqual(c.handleInbound({}), { ok: true, kind: 'event' });
  assert.equal(msgs.length, 1);
});
