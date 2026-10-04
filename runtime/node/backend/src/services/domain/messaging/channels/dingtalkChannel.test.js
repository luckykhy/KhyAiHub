'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const loggerPath = require.resolve('../../../../utils/logger');
const inboundPath = require.resolve('../messaging/msgInboundCore');
const senderPath = require.resolve('../messaging/msgSender');

// Redirect every dependency that could touch fs/network/config into memory stubs
// keyed by absolute resolved path BEFORE the module under test is required.
function makeStub(abs, exports) {
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
}

let verifyCalls;
let parseCalls;
let sendCalls;
let verifyResult;
let parseResult;
let sendResult;
let Channel;

before(() => {
  makeStub(loggerPath, Object.assign(() => {}, {
    info() {}, warn() {}, error() {}, debug() {},
  }));
  makeStub(inboundPath, {
    verifyDingtalk(args) {
      verifyCalls.push(args);
      return verifyResult;
    },
    parseDingtalk(body) {
      parseCalls.push(body);
      return parseResult;
    },
  });
  makeStub(senderPath, {
    sendText(args) {
      sendCalls.push(args);
      return Promise.resolve(sendResult);
    },
  });
  Channel = require('./dingtalkChannel').DingTalkChannel;
});

after(() => {
  delete require.cache[loggerPath];
  delete require.cache[inboundPath];
  delete require.cache[senderPath];
  delete require.cache[require.resolve('./dingtalkChannel')];
});

beforeEach(() => {
  verifyCalls = [];
  parseCalls = [];
  sendCalls = [];
  verifyResult = true;
  parseResult = { platform: 'dingtalk', userId: '', text: '', sessionWebhook: '', raw: {} };
  sendResult = { ok: true, status: 200 };
});

describe('DingTalkChannel —— 钉钉群机器人信道', () => {
  it('导出面只有 DingTalkChannel 且继承 BaseChannel', () => {
    assert.deepStrictEqual(Object.keys(require('./dingtalkChannel')), ['DingTalkChannel']);
    const { BaseChannel } = require('./_baseChannel');
    const c = new Channel({ webhook: 'https://oapi.dingtalk.com/robot' });
    assert.ok(c instanceof BaseChannel);
    assert.equal(c.name, 'dingtalk');
  });

  it('缺省 config 与缺字段都回落空串', () => {
    const empty = new Channel();
    assert.equal(empty.webhook, '');
    assert.equal(empty.secret, '');
    assert.deepStrictEqual(empty.config, {});
    const partial = new Channel({ webhook: 'https://x' });
    assert.equal(partial.webhook, 'https://x');
    assert.equal(partial.secret, '');
  });

  it('connect 无 webhook 时抛 "webhook is required" 且不发 connected', async () => {
    const c = new Channel({});
    let connectedFired = 0;
    c.on('connected', () => {
      connectedFired += 1;
    });
    await assert.rejects(() => c.connect(), /^Error: dingtalk: webhook is required$/);
    assert.equal(connectedFired, 0);
    assert.equal(c.connected, false);
  });

  it('connect 有 webhook 时置连接并 emit connected', async () => {
    const c = new Channel({ webhook: 'https://oapi.dingtalk.com/robot' });
    let connectedFired = 0;
    c.on('connected', () => {
      connectedFired += 1;
    });
    await c.connect();
    assert.equal(connectedFired, 1);
    assert.equal(c.connected, true);
  });

  it('sendMessage 用配置群 webhook 并交平台标记与密钥给 sender', async () => {
    const c = new Channel({ webhook: 'https://group', secret: 'SEC' });
    const result = await c.sendMessage('room-1', '你好');
    assert.equal(sendCalls.length, 1);
    assert.deepStrictEqual(sendCalls[0], {
      platform: 'dingtalk', webhook: 'https://group', secret: 'SEC', text: '你好',
    });
    assert.equal(result, sendResult);
  });

  it('sendMessage 把 https:// 开头的 channelId 当作会话 webhook', async () => {
    const c = new Channel({ webhook: 'https://group' });
    await c.sendMessage('https://session.webhook/x', 'hi');
    assert.equal(sendCalls[0].webhook, 'https://session.webhook/x');
  });

  it('https 判定大小写不敏感', async () => {
    const c = new Channel({ webhook: 'https://group' });
    await c.sendMessage('HTTPS://session/x', 'hi');
    assert.equal(sendCalls[0].webhook, 'HTTPS://session/x');
  });

  // Measured: only /^https:\/\//i qualifies as a session webhook. A plain
  // http:// sessionWebhook silently falls back to the configured group webhook.
  it('KNOWN-DEFECT: 非 https 的 sessionWebhook 被忽略，回落群 webhook', async () => {
    const c = new Channel({ webhook: 'https://group' });
    await c.sendMessage('http://session/insecure', 'hi');
    assert.equal(sendCalls[0].webhook, 'https://group');
  });

  // Measured: sendMessage accepts opts but never forwards them to sender.sendText.
  it('KNOWN-DEFECT: sendMessage 的 opts 参数被静默丢弃，sender 收不到', async () => {
    const c = new Channel({ webhook: 'https://group' });
    await c.sendMessage('room', 'hi', { at: { atMobiles: ['1'] }, markdown: true });
    assert.deepStrictEqual(sendCalls[0], {
      platform: 'dingtalk', webhook: 'https://group', secret: '', text: 'hi',
    });
    assert.equal('at' in sendCalls[0], false);
    assert.equal('opts' in sendCalls[0], false);
  });

  it('发送失败时 emit error 且原样返回失败结果（不抛）', async () => {
    const c = new Channel({ webhook: 'https://group' });
    const failure = { ok: false, status: 200, error: '钉钉返回错误 310000' };
    sendResult = failure;
    const errs = [];
    c.on('error', (payload) => errs.push(payload));
    const result = await c.sendMessage('room', 'hi');
    assert.equal(result, failure);
    assert.equal(errs.length, 1);
    assert.ok(errs[0].error instanceof Error);
    assert.equal(errs[0].error.message, '钉钉返回错误 310000');
  });

  // Measured: a failure result without an `error` string builds new Error(undefined)
  // whose message is '' — the emitted error carries no diagnostic text.
  it('KNOWN-DEFECT: 失败结果缺 error 字段时 emit 空消息 Error', async () => {
    const c = new Channel({ webhook: 'https://group' });
    sendResult = { ok: false };
    const errs = [];
    c.on('error', (payload) => errs.push(payload));
    const result = await c.sendMessage('room', 'hi');
    assert.deepStrictEqual(result, { ok: false });
    assert.equal(errs.length, 1);
    assert.ok(errs[0].error instanceof Error);
    assert.equal(errs[0].error.message, '');
  });

  it('成功发送不 emit error', async () => {
    const c = new Channel({ webhook: 'https://group' });
    let fired = 0;
    c.on('error', () => {
      fired += 1;
    });
    await c.sendMessage('room', 'hi');
    assert.equal(fired, 0);
  });

  it('sendReply 委托 sendMessage 并丢掉 threadId', async () => {
    const c = new Channel({ webhook: 'https://group' });
    await c.sendReply('https://session', 'thread-9', 'reply-text');
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].webhook, 'https://session');
    assert.equal(sendCalls[0].text, 'reply-text');
  });

  it('未配 secret 时 handleInbound 跳过验签并 emit message', () => {
    const c = new Channel({ webhook: 'https://group' });
    parseResult = {
      platform: 'dingtalk', userId: 'staff-7', text: '在吗',
      sessionWebhook: 'https://session/reply', raw: { msgtype: 'text' },
    };
    const msgs = [];
    c.on('message', (m) => msgs.push(m));
    const ret = c.handleInbound({ timestamp: '1700000000000', sign: 'whatever' }, { any: 1 });
    assert.equal(verifyCalls.length, 0);
    assert.deepStrictEqual(ret, { ok: true });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].channelId, 'https://session/reply');
    assert.equal(msgs[0].userId, 'staff-7');
    assert.equal(msgs[0].text, '在吗');
    assert.equal(msgs[0].threadId, 'https://session/reply');
    assert.equal(msgs[0].timestamp, '1700000000000');
    assert.deepStrictEqual(msgs[0].raw, { msgtype: 'text' });
    assert.deepStrictEqual(parseCalls, [{ any: 1 }]);
  });

  it('配 secret 且验签失败时返回固定错误、不解析也不 emit', () => {
    const c = new Channel({ webhook: 'https://group', secret: 'SEC' });
    verifyResult = false;
    const msgs = [];
    c.on('message', (m) => msgs.push(m));
    const ret = c.handleInbound({ timestamp: '123', sign: 'bad' }, { text: { content: 'x' } });
    assert.deepStrictEqual(ret, { ok: false, error: 'dingtalk 签名校验失败' });
    assert.equal(verifyCalls.length, 1);
    assert.deepStrictEqual(verifyCalls[0], { secret: 'SEC', timestamp: '123', sign: 'bad' });
    assert.equal(parseCalls.length, 0);
    assert.equal(msgs.length, 0);
  });

  it('验签通过后才解析并 emit', () => {
    const c = new Channel({ webhook: 'https://group', secret: 'SEC' });
    verifyResult = true;
    parseResult = { platform: 'dingtalk', userId: 'u', text: 'hi', sessionWebhook: '', raw: {} };
    const msgs = [];
    c.on('message', (m) => msgs.push(m));
    c.handleInbound({ timestamp: '9', sign: 'good' }, {});
    assert.equal(verifyCalls.length, 1);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].channelId, 'https://group');
    assert.equal(msgs[0].threadId, '');
  });

  it('文本为空时返回 {ok:true} 且不 emit message', () => {
    const c = new Channel({ webhook: 'https://group' });
    parseResult = { platform: 'dingtalk', userId: 'u', text: '', sessionWebhook: '', raw: {} };
    const msgs = [];
    c.on('message', (m) => msgs.push(m));
    const ret = c.handleInbound({ timestamp: '1', sign: '2' }, {});
    assert.deepStrictEqual(ret, { ok: true });
    assert.equal(msgs.length, 0);
  });

  // Measured: timestamp is normalized with `String(headers.timestamp || '')`, so a
  // numeric 0 collapses to '' instead of "0".
  it('KNOWN-DEFECT: timestamp 为数字 0 时被 String(...) || 逻辑吞成空串', () => {
    const c = new Channel({ webhook: 'https://group' });
    parseResult = { platform: 'dingtalk', userId: 'u', text: 'hi', sessionWebhook: '', raw: {} };
    const msgs = [];
    c.on('message', (m) => msgs.push(m));
    c.handleInbound({ timestamp: 0 }, {});
    assert.equal(msgs[0].timestamp, '');
  });

  // Measured: default params only fire on undefined. Passing an explicit null
  // headers reaches the emit path (with non-empty text) and crashes on property
  // access of null.
  it('KNOWN-DEFECT: handleInbound(null, body) 默认参数不生效，非空文本时抛 TypeError', () => {
    const c = new Channel({ webhook: 'https://group' });
    parseResult = { platform: 'dingtalk', userId: 'u', text: 'hi', sessionWebhook: '', raw: {} };
    c.on('message', () => {});
    assert.throws(() => c.handleInbound(null, { text: { content: 'hi' } }), TypeError);
  });

  it('handleInbound 省略参数走默认空对象且解析出空文本 → {ok:true}', () => {
    const c = new Channel({ webhook: 'https://group' });
    const ret = c.handleInbound();
    assert.deepStrictEqual(ret, { ok: true });
    assert.deepStrictEqual(parseCalls, [{}]);
  });

  it('toJSON 上报 hasWebhook / hasSecret 布尔而不泄露原值', () => {
    const full = new Channel({ webhook: 'https://group', secret: 'SEC' });
    assert.deepStrictEqual(full.toJSON(), {
      name: 'dingtalk', connected: false, hasWebhook: true, hasSecret: true,
    });
    const bare = new Channel();
    assert.deepStrictEqual(bare.toJSON(), {
      name: 'dingtalk', connected: false, hasWebhook: false, hasSecret: false,
    });
    const json = JSON.stringify(full.toJSON());
    assert.equal(json.includes('SEC'), false);
    assert.equal(json.includes('https://group'), false);
  });
});
