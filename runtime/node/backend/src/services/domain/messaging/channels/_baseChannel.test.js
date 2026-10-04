'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');

const { BaseChannel } = require('./_baseChannel');

describe('BaseChannel —— 外部消息信道抽象基类', () => {
  it('继承 EventEmitter 且导出面只有 BaseChannel', () => {
    assert.deepStrictEqual(Object.keys(require('./_baseChannel')), ['BaseChannel']);
    assert.ok(new BaseChannel({ name: 'x' }) instanceof EventEmitter);
  });

  it('构造时写入 name、缺省 config 为空对象、初始未连接', () => {
    const c = new BaseChannel({ name: 'slack' });
    assert.equal(c.name, 'slack');
    assert.deepStrictEqual(c.config, {});
    assert.equal(c.connected, false);
    assert.equal(c._connected, false);
  });

  it('透传 config 引用并让 connected 反映 _connected', () => {
    const cfg = { token: 't', nested: { a: 1 } };
    const c = new BaseChannel({ name: 'discord', config: cfg });
    assert.equal(c.config, cfg);
    c._connected = true;
    assert.equal(c.connected, true);
  });

  // Measured: constructor dereferences opts.name with no guard, so an omitted or
  // null opts throws a raw TypeError instead of a descriptive argument error.
  it('KNOWN-DEFECT: 缺 opts 或 opts 为 null 时构造以原生 TypeError 崩溃', () => {
    assert.throws(() => new BaseChannel(), TypeError);
    assert.throws(() => new BaseChannel(null), TypeError);
    assert.throws(() => new BaseChannel(undefined), (err) =>
      /Cannot read properties of undefined/.test(err.message));
    const ok = new BaseChannel({});
    assert.equal(ok.name, undefined);
    assert.equal(ok.connected, false);
  });

  it('未实现 connect 时抛出带信道名的错误', async () => {
    const c = new BaseChannel({ name: 'slack' });
    await assert.rejects(() => c.connect(), /^Error: slack: connect\(\) not implemented$/);
  });

  it('未实现 sendMessage 时抛出带信道名的错误', async () => {
    const c = new BaseChannel({ name: 'telegram' });
    await assert.rejects(
      () => c.sendMessage('chan', 'hi'),
      /^Error: telegram: sendMessage\(\) not implemented$/,
    );
  });

  it('基类 connect 抛错时不改动 _connected', async () => {
    const c = new BaseChannel({ name: 'x' });
    await c.connect().catch(() => {});
    assert.equal(c.connected, false);
  });

  it('disconnect 置未连接并 emit disconnected', async () => {
    const c = new BaseChannel({ name: 'x' });
    c._connected = true;
    let fired = 0;
    c.on('disconnected', () => {
      fired += 1;
    });
    await c.disconnect();
    assert.equal(c.connected, false);
    assert.equal(fired, 1);
  });

  // Measured: disconnect is unconditional — it emits 'disconnected' even when the
  // channel was never connected, and there is no connect()/disconnect symmetry.
  it('KNOWN-DEFECT: 从未连接过也照样 emit disconnected', async () => {
    const c = new BaseChannel({ name: 'x' });
    assert.equal(c.connected, false);
    let fired = 0;
    c.on('disconnected', () => {
      fired += 1;
    });
    await c.disconnect();
    assert.equal(fired, 1);
    assert.equal(c.connected, false);
  });

  it('sendReply 默认回落 sendMessage 并转发 (channelId, text, opts)', async () => {
    const seen = [];
    class Sub extends BaseChannel {
      async sendMessage(channelId, text, opts) {
        seen.push({ channelId, text, opts });
        return { ok: true, echoed: text };
      }
    }
    const s = new Sub({ name: 'sub' });
    const result = await s.sendReply('chan-1', 'thread-ignored', 'hello', { attach: 1 });
    assert.deepStrictEqual(result, { ok: true, echoed: 'hello' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].channelId, 'chan-1');
    assert.equal(seen[0].text, 'hello');
    assert.deepStrictEqual(seen[0].opts, { attach: 1 });
  });

  // Measured: base sendReply drops threadId entirely (falls back to sendMessage),
  // so when a subclass has NOT overridden sendMessage it inherits the abstract
  // throw — "reply" can fail purely because send is unimplemented.
  it('KNOWN-DEFECT: 基类 sendReply 丢掉 threadId 并透传抽象 sendMessage 的抛错', async () => {
    const c = new BaseChannel({ name: 'abstract' });
    await assert.rejects(
      () => c.sendReply('chan', 'thread', 'hi', {}),
      /^Error: abstract: sendMessage\(\) not implemented$/,
    );
  });

  it('toJSON 只暴露 name 与 connected', () => {
    const c = new BaseChannel({ name: 'x', config: { secret: 'do-not-leak' } });
    c._connected = true;
    assert.deepStrictEqual(c.toJSON(), { name: 'x', connected: true });
    assert.equal('secret' in c.toJSON(), false);
    assert.equal('config' in c.toJSON(), false);
  });
});
