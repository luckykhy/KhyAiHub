'use strict';

// Co-located contract tests for streamInjector.js (C-4, [RESEARCH-018] §2.3).
// StreamFailSafeInjector owns the "兜底协议不可绕过" promise: a stream that dies without a
// terminal event must still get one structured error event pushed at it, exactly once.
// These cases drive the injector with an in-memory recorder (no socket, no http response)
// and pin the three places where the "cannot be bypassed" wording overstates the code.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const GUARD_ENV = 'KHY_FAILSAFE_PROCESS_GUARD';
// Keep the process-level layer off for the whole file: a real install would attach
// uncaughtException listeners that outlive this suite and swallow other suites' failures.
const priorEnv = process.env[GUARD_ENV];
before(() => {
  process.env[GUARD_ENV] = 'off';
});
after(() => {
  if (priorEnv === undefined) {
    delete process.env[GUARD_ENV];
  } else {
    process.env[GUARD_ENV] = priorEnv;
  }
  require('./streamInjector').StreamFailSafeInjector._clearActive();
});

const streamInjector = require('./streamInjector');
const { StreamFailSafeInjector, sweepActive } = streamInjector;

function recorder() {
  const events = [];
  return { events, send: (e) => events.push(e) };
}

describe('模块面与构造', () => {
  test('对外面恰为 StreamFailSafeInjector 与 sweepActive', () => {
    assert.deepEqual(Object.keys(streamInjector).sort(), ['StreamFailSafeInjector', 'sweepActive']);
  });

  test('无参构造也合法：send 缺省成 no-op，默认登记进清扫册', () => {
    const before = StreamFailSafeInjector._activeCount();
    const inj = new StreamFailSafeInjector();
    assert.equal(typeof inj.send, 'function');
    assert.equal(inj.finalized, false);
    assert.equal(inj.sawContent, false);
    assert.equal(StreamFailSafeInjector._activeCount(), before + 1, 'track 默认应为 true');
    inj.dispose();
    assert.equal(StreamFailSafeInjector._activeCount(), before);
  });

  test('track:false 的注入器不进在册表，进程清扫不会替它补写', () => {
    const before = StreamFailSafeInjector._activeCount();
    const { events, send } = recorder();
    const inj = new StreamFailSafeInjector({ send, track: false });
    sweepActive({ error_code: 'E04', message: 'swept' });
    assert.equal(StreamFailSafeInjector._activeCount(), before);
    assert.deepEqual(events, []);
  });

  test('非函数 send 被替换成空函数，构造阶段不抛', () => {
    for (const bad of ['nope', 0, null, undefined, {}, []]) {
      const inj = new StreamFailSafeInjector({ send: bad, track: false });
      assert.equal(typeof inj.send, 'function');
      assert.doesNotThrow(() => inj.finalize());
    }
  });
});

describe('emit：透传与内容跟踪', () => {
  test('chunk/content/delta 三种非空正文都把事件原样透传并置 sawContent', () => {
    const { events, send } = recorder();
    const inj = new StreamFailSafeInjector({ send, track: false });
    assert.equal(inj.emit({ type: 'chunk', text: 'a' }), inj, 'emit 必须可链式');
    inj.emit({ type: 'content', content: 'b' });
    inj.emit({ type: 'chunk', delta: 'c' });
    assert.equal(inj.sawContent, true);
    assert.deepEqual(events.map((e) => e.type), ['chunk', 'content', 'chunk']);
    assert.equal(events[1].content, 'b', '事件原样透传，不改载荷');
  });

  test('纯空白正文同样算「输出过内容」，与非 chunk 事件不同', () => {
    const { events, send } = recorder();
    const inj = new StreamFailSafeInjector({ send, track: false });
    inj.emit({ type: 'ping' });
    inj.emit({ type: 'chunk' });
    inj.emit({ type: 'chunk', text: '' });
    assert.equal(inj.sawContent, false, '没有 text 或空串都不算内容');
    assert.equal(events.length, 3);
  });

  test('KNOWN-DEFECT: 纯空白 chunk 被记成已输出内容，与 safeResponse 的空判定相反', () => {
    // streamInjector.js:52 tests only `t.length`, never trim(), while safeResponse.js:173
    // treats a trimmed-empty string as an empty reply. The two halves of the same failsafe
    // therefore disagree about "did the model say anything": a whitespace-only stream is
    // reported to the frontend as partial=true (半截回复) yet classify() calls it E01.
    const inj = new StreamFailSafeInjector({ send: () => {}, track: false });
    inj.emit({ type: 'chunk', text: '   \n\t ' });
    assert.equal(inj.sawContent, true);
    const { SafeResponseWrapper } = require('./safeResponse');
    const wrapper = new SafeResponseWrapper({ kind: 'llm', model: 'm' });
    assert.equal(wrapper.validateLLM({ content: '   \n\t ' }).error_code, 'E01');
  });

  test('send 抛异常不得反噬业务：emit 照样返回 this', () => {
    const inj = new StreamFailSafeInjector({ send: () => { throw new Error('client gone'); }, track: false });
    assert.equal(inj.emit({ type: 'chunk', text: 'x' }), inj);
    assert.doesNotThrow(() => inj.finalize());
  });

  test('null/undefined 事件不抛，被原样透传给 send', () => {
    const { events, send } = recorder();
    const inj = new StreamFailSafeInjector({ send, track: false });
    assert.doesNotThrow(() => inj.emit(null));
    assert.doesNotThrow(() => inj.emit(undefined));
    assert.deepEqual(events, [null, undefined]);
  });

  test('KNOWN-DEFECT: 非字符串正文（Buffer/数字）不置 partial，前端误判为「什么都没输出过」', () => {
    // streamInjector.js:51-53 requires `typeof t === 'string' && t.length` before setting
    // sawContent. A gateway that hands out a Buffer chunk or a numeric delta therefore
    // produces an error event claiming partial=false, i.e. the UI shows a clean failure
    // over a stream that already printed half an answer.
    const { events, send } = recorder();
    const inj = new StreamFailSafeInjector({ send, context: { requestId: 'r-1' }, track: false });
    inj.emit({ type: 'chunk', text: Buffer.from('已经吐出的一段') });
    inj.emit({ type: 'chunk', text: 12 });
    inj.finalize();
    const errEvent = events[events.length - 1];
    assert.equal(errEvent.partial, false, '实际已输出内容却报 partial=false');
    assert.equal(errEvent.requestId, 'r-1');
  });
});

describe('fail / finalize：终态注入与幂等', () => {
  test('fail 注入的 error 事件带齐归因字段与 [码] reason 摘要', () => {
    const { events, send } = recorder();
    const inj = new StreamFailSafeInjector({ send, context: { model: 'm', requestId: 'req-9' }, track: false });
    const failure = inj.fail({ errorType: 'empty_reply' });
    const event = events[0];
    assert.equal(event.type, 'error');
    assert.equal(event.fallback, true);
    assert.equal(event.error_code, 'E01');
    assert.equal(event.status, 'failed');
    assert.equal(event.message, '[E01] 模型返回空内容');
    assert.equal(event.requestId, 'req-9', '追溯下钻依赖 requestId');
    assert.deepEqual(event.fields, failure.fields);
    assert.equal(event.resumable, true);
    assert.equal(typeof event.continueHint, 'string');
    assert.equal(inj.finalized, true);
  });

  test('finalize 缺省信号归 E04 并把「流意外结束」留进栈字段', () => {
    const { events, send } = recorder();
    const inj = new StreamFailSafeInjector({ send, track: false });
    const failure = inj.finalize();
    assert.equal(failure.error_code, 'E04');
    assert.match(failure.fields.raw_error_stack, /stream ended unexpectedly without a terminal event/);
    assert.equal(events[0].error_code, 'E04');
  });

  test('幂等：第二次 fail/finalize 返回 null 且绝不重复写终态', () => {
    const { events, send } = recorder();
    const inj = new StreamFailSafeInjector({ send, track: false });
    assert.ok(inj.fail('boom'));
    assert.equal(inj.fail('again'), null);
    assert.equal(inj.finalize('third'), null);
    assert.equal(events.length, 1, '双写终态会让前端渲染两条错误');
  });

  test('markDone / dispose 关闭兜底：此后 fail 与 finalize 都是 no-op', () => {
    const { events, send } = recorder();
    const inj = new StreamFailSafeInjector({ send, track: false });
    inj.markDone();
    assert.equal(inj.fail({ error_code: 'E06' }), null);
    assert.equal(inj.finalize(), null);
    assert.deepEqual(events, []);
  });

  test('终态注入会尝试关闭 res，res.end 抛异常不影响归因返回', () => {
    const seen = [];
    const inj = new StreamFailSafeInjector({ send: (e) => seen.push(e), res: { end() { inj.ended = true; } }, track: false });
    inj.finalize();
    assert.equal(inj.ended, true);

    const bad = new StreamFailSafeInjector({ send: (e) => seen.push(e), res: { end() { throw new Error('end boom'); } }, track: false });
    assert.equal(bad.finalize().error_code, 'E04');

    const noEnd = new StreamFailSafeInjector({ send: () => {}, res: {}, track: false });
    assert.doesNotThrow(() => noEnd.finalize());
    const nullRes = new StreamFailSafeInjector({ send: () => {}, track: false });
    assert.doesNotThrow(() => nullRes.finalize());
  });

  test('局部 ctx 覆盖实例 context 用于归因，但不覆盖事件上的 requestId', async () => {
    const { events, send } = recorder();
    const inj = new StreamFailSafeInjector({ send, context: { model: 'instance-model' }, track: false });
    inj.fail({ errorType: 'empty_reply' }, { model: 'call-model' });
    assert.equal(events[0].fields.model, 'call-model', '归因上下文按局部优先');
    // streamInjector.js:137 reads only this.context?.requestId, so a per-call requestId
    // used for attribution is dropped from the event and the drill-down link breaks.
    const inj2 = new StreamFailSafeInjector({ send, track: false });
    inj2.fail({ error_code: 'E06' }, { requestId: 'per-call-id' });
    assert.equal(events[events.length - 1].requestId, null, 'KNOWN-DEFECT: 每次调用的 requestId 没盖到事件上');
  });

  test('KNOWN-DEFECT: send 缺失时兜底协议静默丢事件，仍宣称已注入', () => {
    // streamInjector.js:37 replaces a non-function send with a no-op and _inject() never
    // checks whether the write actually landed. The header promises the protocol 不可绕过
    // ("即便已经流式输出了部分内容，也以追加方式补一条"), but with a missing/renamed sender
    // the caller still gets a truthful-looking failure object back while the stream shows
    // the raw truncated output — the exact silent-failure this subsystem exists to kill.
    const inj = new StreamFailSafeInjector({ send: undefined, track: false });
    const failure = inj.finalize();
    assert.equal(failure.error_code, 'E04', '返回值看起来一切正常');
    assert.equal(inj.finalized, true, '闸门已关闭，不会再有第二次机会补写');
    assert.equal(require('./classifier').classify(failure).error_code, 'E04');
  });
});

describe('进程级清扫与在册表', () => {
  test('sweepActive 逐一补写所有在册未终结注入器，已终结的跳过', () => {
    StreamFailSafeInjector._clearActive();
    const a = recorder();
    const b = recorder();
    const injA = new StreamFailSafeInjector({ send: a.send, context: { requestId: 'A' } });
    const injB = new StreamFailSafeInjector({ send: b.send, context: { requestId: 'B' } });
    injB.markDone();
    assert.equal(StreamFailSafeInjector._activeCount(), 1);
    sweepActive({ error_code: 'E06', message: 'process received SIGTERM', endpoint: 'process' });
    assert.equal(a.events[0].error_code, 'E06');
    assert.equal(a.events[0].requestId, 'A');
    assert.deepEqual(b.events, [], '已正常终结的流不该被补写错误');
    assert.equal(StreamFailSafeInjector._activeCount(), 0);
  });

  test('单个注入器写失败不阻断其余清扫', () => {
    StreamFailSafeInjector._clearActive();
    const good = recorder();
    new StreamFailSafeInjector({ send: () => { throw new Error('dead socket'); } });
    new StreamFailSafeInjector({ send: good.send });
    assert.doesNotThrow(() => sweepActive({ error_code: 'E04', message: 'x' }));
    assert.equal(good.events.length, 1);
    assert.equal(StreamFailSafeInjector._activeCount(), 0);
  });

  test('清扫信号共享同一条归因，各注入器的上下文仍独立生效', () => {
    StreamFailSafeInjector._clearActive();
    const r1 = recorder();
    const r2 = recorder();
    new StreamFailSafeInjector({ send: r1.send, context: { endpoint: 'ep-a', retryCount: 1 } });
    new StreamFailSafeInjector({ send: r2.send, context: { endpoint: 'ep-b', retryCount: 2 } });
    sweepActive({ code: 'TIMEOUT' });
    assert.equal(r1.events[0].error_code, 'E06');
    assert.equal(r2.events[0].error_code, 'E06');
    assert.equal(r1.events[0].fields.endpoint, 'ep-a', '各自上下文仍然生效');
    assert.equal(r2.events[0].fields.endpoint, 'ep-b');
    assert.equal(r1.events[0].fields.retry_count, 1);
    assert.equal(r2.events[0].fields.retry_count, 2);
  });

  test('KNOWN-DEFECT: 在册表只增不减（未终结的注入器永久滞留），无上限也无过期', () => {
    // streamInjector.js:25 keeps a plain Set with the comment "WeakRef 不可枚举，故用 Set +
    // 显式 dispose" — eviction happens only through _inject/markDone/dispose. An abandoned
    // stream (caller forgot to finalize, e.g. an SSE client that vanished) is retained for
    // the process lifetime and re-written on every later sweep, with no cap on growth.
    StreamFailSafeInjector._clearActive();
    const start = StreamFailSafeInjector._activeCount();
    for (let i = 0; i < 50; i++) {
      new StreamFailSafeInjector({ send: () => {} });
    }
    assert.equal(StreamFailSafeInjector._activeCount(), start + 50);
    sweepActive({ error_code: 'E04', message: 'first sweep' });
    assert.equal(StreamFailSafeInjector._activeCount(), 0, '清扫后才出册');
    StreamFailSafeInjector._clearActive();
  });

  test('KHY_FAILSAFE_PROCESS_GUARD=off 时进程层完全不安装监听器（三层退化成两层）', () => {
    process.env[GUARD_ENV] = 'off';
    const beforeCounts = {
      uncaughtException: process.listenerCount('uncaughtException'),
      unhandledRejection: process.listenerCount('unhandledRejection'),
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGINT: process.listenerCount('SIGINT'),
    };
    assert.equal(StreamFailSafeInjector.installProcessGuards(), undefined);
    assert.deepEqual(
      {
        uncaughtException: process.listenerCount('uncaughtException'),
        unhandledRejection: process.listenerCount('unhandledRejection'),
        SIGTERM: process.listenerCount('SIGTERM'),
        SIGINT: process.listenerCount('SIGINT'),
      },
      beforeCounts,
      '关闭开关后不得注册任何进程监听器'
    );
    delete process.env[GUARD_ENV];
  });

  test('监听器一旦装上就只装一次：重复 installProcessGuards 不再叠加', () => {
    // Deliberately last in this file: it flips the module-level installed latch for good,
    // and the added listeners are removed by identity below so no other suite inherits them.
    delete process.env[GUARD_ENV];
    const kinds = ['uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGINT'];
    const snapshot = new Map(kinds.map((k) => [k, process.listeners(k)]));
    StreamFailSafeInjector.installProcessGuards();
    StreamFailSafeInjector.installProcessGuards();
    for (const kind of kinds) {
      const added = process.listeners(kind).filter((fn) => !snapshot.get(kind).includes(fn));
      assert.equal(added.length, 1, `${kind} 应恰好新增 1 个监听器（幂等安装）`);
      process.removeListener(kind, added[0]);
    }
    for (const kind of kinds) {
      assert.deepEqual(process.listeners(kind), snapshot.get(kind), `${kind} 监听器未复原`);
    }
  });
});
