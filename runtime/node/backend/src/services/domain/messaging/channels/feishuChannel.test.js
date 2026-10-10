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

// Both outbound paths (webhook POST inside msgSender, crypto/XML parse in
// msgInboundCore) are replaced by in-memory recorders before the channel loads,
// so no socket can ever be opened by this suite.
installStub(inboundPath, {
  handleFeishu(body, opts) {
    inboundCalls.push({ body, opts });
    return inboundResult;
  },
});
installStub(senderPath, senderStub);

const { FeishuChannel } = require('./feishuChannel');
const { BaseChannel } = require('./_baseChannel');

after(() => {
  delete require.cache[inboundPath];
  delete require.cache[senderPath];
  delete require.cache[require.resolve('./feishuChannel')];
});

beforeEach(() => {
  inboundCalls = [];
  sendCalls = [];
  inboundResult = { ok: true, kind: 'event', message: { platform: 'feishu', userId: '', text: '', raw: {} } };
  sendResult = { ok: true, status: 200 };
});

test('导出面只有 FeishuChannel 且继承 BaseChannel，name 钉成 feishu', () => {
  assert.deepStrictEqual(Object.keys(require('./feishuChannel')), ['FeishuChannel']);
  const c = new FeishuChannel({ webhook: 'https://open.feishu.cn/hook' });
  assert.ok(c instanceof BaseChannel);
  assert.equal(c.name, 'feishu');
  assert.equal(c.connected, false);
});

test('config 缺字段与非对象入参都回落空串，缺省参走默认值', () => {
  const bare = new FeishuChannel();
  assert.equal(bare.webhook, '');
  assert.equal(bare.secret, '');
  assert.equal(bare.encryptKey, '');
  assert.equal(bare.verificationToken, '');
  assert.deepStrictEqual(bare.config, {});
  const partial = new FeishuChannel({ webhook: 'https://h', encryptKey: 'EK' });
  assert.equal(partial.secret, '');
  assert.equal(partial.encryptKey, 'EK');
  const numeric = new FeishuChannel({ webhook: 1, secret: 0, verificationToken: null });
  assert.equal(numeric.webhook, 1);
  assert.equal(numeric.secret, '');
  assert.equal(numeric.verificationToken, '');
});

test('connect 缺 webhook 时抛固定错误且不改连接态、不发 connected', async () => {
  const c = new FeishuChannel({});
  let fired = 0;
  c.on('connected', () => {
    fired += 1;
  });
  await assert.rejects(() => c.connect(), /^Error: feishu: webhook is required$/);
  assert.equal(fired, 0);
  assert.equal(c.connected, false);
  assert.equal(sendCalls.length, 0);
});

test('connect 有 webhook 时置连接并 emit connected，disconnect 复位', async () => {
  const c = new FeishuChannel({ webhook: 'https://h' });
  const events = [];
  c.on('connected', () => events.push('connected'));
  c.on('disconnected', () => events.push('disconnected'));
  assert.equal(await c.connect(), undefined);
  assert.equal(c.connected, true);
  await c.disconnect();
  assert.equal(c.connected, false);
  assert.deepStrictEqual(events, ['connected', 'disconnected']);
});

test('connect 不校验 webhook 合法性也不发网络请求，随便一个字符串都算已连接', async () => {
  const c = new FeishuChannel({ webhook: 'not-a-url' });
  await c.connect();
  assert.equal(c.connected, true);
  assert.equal(sendCalls.length, 0);
  assert.equal(inboundCalls.length, 0);
});

test('sendMessage 交平台标记、群 webhook、签名密钥与文本给 sender 并原样返回结果', async () => {
  const c = new FeishuChannel({ webhook: 'https://group', secret: 'SEC' });
  const result = await c.sendMessage('oc_chat_1', '你好');
  assert.deepStrictEqual(sendCalls, [{ platform: 'feishu', webhook: 'https://group', secret: 'SEC', text: '你好' }]);
  assert.equal(result, sendResult);
  assert.equal(sendCalls[0].timestampMs, undefined);
});

test('发送失败时 emit error 且不抛，返回体保持 sender 原样', async () => {
  const c = new FeishuChannel({ webhook: 'https://group' });
  const failure = { ok: false, status: 200, error: '飞书返回错误 19021' };
  sendResult = failure;
  const errs = [];
  c.on('error', (payload) => errs.push(payload));
  const result = await c.sendMessage('room', 'hi');
  assert.equal(result, failure);
  assert.equal(errs.length, 1);
  assert.ok(errs[0].error instanceof Error);
  assert.equal(errs[0].error.message, '飞书返回错误 19021');
});

test('失败结果缺 error 字段时 emit 空消息 Error', async () => {
  const c = new FeishuChannel({ webhook: 'https://group' });
  sendResult = { ok: false };
  const errs = [];
  c.on('error', (payload) => errs.push(payload));
  await c.sendMessage('room', 'hi');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].error.message, '');
});

test('成功发送不 emit error；sender 自身 reject 时信道不吞、原样上抛', async () => {
  const c = new FeishuChannel({ webhook: 'https://group' });
  let fired = 0;
  c.on('error', () => {
    fired += 1;
  });
  await c.sendMessage('room', 'hi');
  assert.equal(fired, 0);
  const original = senderStub.sendText;
  senderStub.sendText = (args) => {
    sendCalls.push(args);
    return Promise.reject(new Error('socket hang up'));
  };
  try {
    await assert.rejects(() => c.sendMessage('room', 'hi'), /socket hang up/);
    assert.equal(fired, 0);
  } finally {
    senderStub.sendText = original;
  }
});

test('sendReply 委托 sendMessage，threadId 与 opts 都不进 sender', async () => {
  const c = new FeishuChannel({ webhook: 'https://group', secret: 'S' });
  const result = await c.sendReply('oc_chat_1', 'om_msg_9', '回复内容', { card: true });
  assert.equal(sendCalls.length, 1);
  assert.deepStrictEqual(sendCalls[0], { platform: 'feishu', webhook: 'https://group', secret: 'S', text: '回复内容' });
  assert.equal(result, sendResult);
});

test('handleInbound 把渠道密钥作为第二参交 core，并把归一消息广播成 message 事件', () => {
  const c = new FeishuChannel({ webhook: 'https://group', encryptKey: 'EK', verificationToken: 'VT' });
  inboundResult = {
    ok: true,
    kind: 'event',
    message: {
      platform: 'feishu', userId: 'ou_1', text: '在吗', messageId: 'om_1', chatId: 'oc_2',
      raw: { header: { event_type: 'im.message.receive_v1' } },
    },
  };
  const msgs = [];
  c.on('message', (m) => msgs.push(m));
  const body = { encrypt: 'cipher' };
  const ret = c.handleInbound(body);
  assert.deepStrictEqual(ret, { ok: true, kind: 'event' });
  assert.equal(inboundCalls.length, 1);
  assert.equal(inboundCalls[0].body, body);
  assert.deepStrictEqual(inboundCalls[0].opts, { encryptKey: 'EK', verificationToken: 'VT' });
  assert.equal(msgs.length, 1);
  assert.deepStrictEqual(msgs[0], {
    channelId: 'oc_2', userId: 'ou_1', text: '在吗', threadId: 'om_1', timestamp: '',
    raw: { header: { event_type: 'im.message.receive_v1' } },
  });
});

test('challenge 回调原样透传 core 结果且不 emit message', () => {
  const c = new FeishuChannel({ webhook: 'https://group' });
  inboundResult = { ok: true, kind: 'challenge', challenge: 'ch-1', token: 'tok' };
  const msgs = [];
  c.on('message', (m) => msgs.push(m));
  const ret = c.handleInbound({ type: 'url_verification' });
  assert.equal(ret, inboundResult);
  assert.deepStrictEqual(ret, { ok: true, kind: 'challenge', challenge: 'ch-1', token: 'tok' });
  assert.equal(msgs.length, 0);
});

test('core 判失败时原样返回错误、不 emit', () => {
  const c = new FeishuChannel({ webhook: 'https://group', verificationToken: 'VT' });
  inboundResult = { ok: false, error: '飞书 verification token 不匹配。' };
  const msgs = [];
  c.on('message', (m) => msgs.push(m));
  assert.equal(c.handleInbound({}), inboundResult);
  assert.equal(msgs.length, 0);
});

test('归一文本为空时返回成功事件但不 emit，chatId 缺失回落群 webhook', () => {
  const c = new FeishuChannel({ webhook: 'https://group' });
  inboundResult = { ok: true, kind: 'event', message: { platform: 'feishu', text: '', chatId: '', raw: {} } };
  const msgs = [];
  c.on('message', (m) => msgs.push(m));
  assert.deepStrictEqual(c.handleInbound({}), { ok: true, kind: 'event' });
  assert.equal(msgs.length, 0);
  inboundResult = { ok: true, kind: 'event', message: { platform: 'feishu', text: 'hi', chatId: '', messageId: 0 } };
  c.handleInbound({});
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].channelId, 'https://group');
  assert.equal(msgs[0].threadId, '');
  assert.equal(msgs[0].userId, undefined);
});

test('handleInbound 省略参数走默认空对象，显式 null 原样转交 core（默认参不兜住 null）', () => {
  const c = new FeishuChannel({ webhook: 'https://group' });
  assert.deepStrictEqual(c.handleInbound(), { ok: true, kind: 'event' });
  assert.deepStrictEqual(inboundCalls[0].body, {});
  c.handleInbound(null);
  assert.equal(inboundCalls[1].body, null);
  c.handleInbound(undefined, 'extra-arg-ignored');
  assert.equal(inboundCalls.length, 3);
  assert.deepStrictEqual(inboundCalls[2].body, {});
});

test('toJSON 只上报 has* 布尔，不泄露 webhook 与密钥原值', () => {
  const full = new FeishuChannel({ webhook: 'https://group', secret: 'SEC', encryptKey: 'EK', verificationToken: 'VT' });
  assert.deepStrictEqual(full.toJSON(), {
    name: 'feishu', connected: false, hasWebhook: true, hasSecret: true, hasEncryptKey: true,
  });
  const bare = new FeishuChannel();
  assert.deepStrictEqual(bare.toJSON(), {
    name: 'feishu', connected: false, hasWebhook: false, hasSecret: false, hasEncryptKey: false,
  });
  const json = JSON.stringify(full);
  assert.equal(json.includes('SEC'), false);
  assert.equal(json.includes('https://group'), false);
  assert.equal(json.includes('VT'), false);
  assert.equal('hasVerificationToken' in full.toJSON(), false);
});

test('KNOWN-DEFECT: toJSON 的脱敏是假的——config 与调用方对象同引用且实例字段可枚举，inspect/展开会带出明文密钥', () => {
  const cfg = { webhook: 'https://group', secret: 'SEC', encryptKey: 'EK', verificationToken: 'VT' };
  const c = new FeishuChannel(cfg);
  assert.equal(c.config, cfg);
  assert.equal(JSON.stringify(c.toJSON()).includes('SEC'), false);
  assert.equal(require('util').inspect(c).includes('SEC'), true);
  const copy = Object.assign({}, c);
  assert.equal(copy.secret, 'SEC');
  assert.equal(copy.encryptKey, 'EK');
  assert.equal(copy.verificationToken, 'VT');
});

test('KNOWN-DEFECT: sendMessage 完全忽略 channelId 与 opts，跨会话定向与飞书消息类型都传不出去', async () => {
  const c = new FeishuChannel({ webhook: 'https://group' });
  await c.sendMessage('https://open.feishu.cn/open-apis/bot/v2/hook/session-specific', 'hi', {
    msgType: 'interactive', card: { elements: [] },
  });
  assert.deepStrictEqual(sendCalls[0], { platform: 'feishu', webhook: 'https://group', secret: '', text: 'hi' });
  assert.equal('channelId' in sendCalls[0], false);
  assert.equal('msgType' in sendCalls[0], false);
  assert.equal('card' in sendCalls[0], false);
});

test('KNOWN-DEFECT: emit 的 timestamp 硬编码空串，core 已带回的事件时间被丢弃', () => {
  const c = new FeishuChannel({ webhook: 'https://group' });
  inboundResult = {
    ok: true,
    kind: 'event',
    message: {
      platform: 'feishu', userId: 'ou', text: 'hi', chatId: 'oc',
      raw: { event: { message: { create_time: '1700000000000' } } },
    },
  };
  const msgs = [];
  c.on('message', (m) => msgs.push(m));
  c.handleInbound({});
  assert.equal(msgs[0].timestamp, '');
  assert.equal(msgs[0].raw.event.message.create_time, '1700000000000');
});

test('KNOWN-DEFECT: 任何 ok 且非 challenge 的结果都被上报成 kind=event，即使 core 没给出消息', () => {
  const c = new FeishuChannel({ webhook: 'https://group' });
  const msgs = [];
  c.on('message', (m) => msgs.push(m));
  inboundResult = { ok: true };
  assert.deepStrictEqual(c.handleInbound({}), { ok: true, kind: 'event' });
  inboundResult = { ok: true, kind: 'event' };
  assert.deepStrictEqual(c.handleInbound({}), { ok: true, kind: 'event' });
  inboundResult = { ok: true, kind: 'unknown-future-kind', message: { text: 'hi' } };
  assert.deepStrictEqual(c.handleInbound({}), { ok: true, kind: 'event' });
  assert.equal(msgs.length, 1);
});

test('KNOWN-DEFECT: 构造后改 config 不影响发送目标，改实例字段才生效（两份真源静默分叉）', async () => {
  const cfg = { webhook: 'https://old' };
  const c = new FeishuChannel(cfg);
  cfg.webhook = 'https://new';
  c.config.secret = 'added-later';
  await c.sendMessage('room', 'hi');
  assert.equal(sendCalls[0].webhook, 'https://old');
  assert.equal(sendCalls[0].secret, '');
  assert.equal(c.config.webhook, 'https://new');
});
