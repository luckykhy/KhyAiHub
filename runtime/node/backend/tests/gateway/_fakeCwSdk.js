'use strict';

/**
 * _fakeCwSdk.js — 可观测的假 `@aws/codewhisperer-streaming-client`（测试专用）。
 *
 * 为什么需要它：trae/kiro 两个 adapter 的 CodeWhisperer 路径**只有「SDK 坏掉」这一支被测过**
 * （harness 的 `cwBroken: true` 只把 getCWModule 变成抛错）。真正会跑的那段——
 * `new CodeWhispererStreaming(clientOpts)`、`client.middlewareStack.add(...)`、
 * `client.send(command[, sendConfig])`——**从来没有测试覆盖**。
 *
 * 而那段正是 [MGMT-RPT-035] L5 想要抽成「协议族叶子」的共享面（trae+kiro 共有 44–53 行）。
 * 在抽之前必须先能观测它：这个假 SDK 把构造参数、middleware 注册次数、send 调用
 * 全部记录下来，测试因此能断言「两个 adapter 到底共享了什么、各自特化了什么」。
 *
 * 它同时是**行为正确**的假 SDK：send() 返回的 async-iterable 吐出真实形状的 CW 事件
 * （assistantResponseEvent / reasoningContentEvent / metadataEvent.tokenUsage …），
 * 足以驱动 parseCWStreamEvents 走完一遍。
 *
 * 事件形状真源：src/services/gateway/adapters/_cwStreamParser.js 的 processEvent()。
 */

/** 造一个假 CW 模块，并把观测窗口挂到返回值的 `__record` 上。 */
function makeFakeCwModule(events) {
  const script = Array.isArray(events) && events.length ? events : defaultEvents();
  const record = {
    ctorOpts: [],
    middleware: [],
    commandInputs: [],
    sendCalls: [],
  };

  class FakeCommand {
    constructor(input) {
      this.input = input;
      record.commandInputs.push(input);
    }
  }

  class FakeCodeWhispererStreaming {
    constructor(opts) {
      this.opts = opts;
      this.__middleware = [];
      record.ctorOpts.push(opts);
      // 复刻 AWS SDK 的 middlewareStack：add(fn) 收 (next) => async (args) => {...}
      this.middlewareStack = {
        add: (fn) => {
          this.__middleware.push(fn);
          record.middleware.push(fn);
        },
      };
    }

    async send(command, config) {
      record.sendCalls.push({ command, config });
      // 让 middleware 真的跑一遍：测试要靠它验证「header 是被 middleware 注入的」。
      // AWS SDK 的契约是 add((next) => async (args) => {...})，所以必须**逐层把 next
      // 作为函数交下去**，最外层才喂 args。第一版把 invoke(i) 立即调用，导致 next 是个
      // Promise，middleware 里 `next(args)` 直接 "next is not a function"。
      let args = { request: { headers: { ...(this.__seedHeaders || {}) } } };
      const chain = this.__middleware;
      const run = async (i, a) => {
        if (i >= chain.length) return a;
        const next = async (na) => run(i + 1, na || a);
        return chain[i](next)(a);
      };
      await run(0, args);
      this.__lastArgs = args;
      // 记录 middleware 跑完后的最终 header：测试靠它证明「header 是 middleware 注入的」
      record.lastHeaders = args && args.request && args.request.headers ? args.request.headers : {};
      // 真 SDK 的 send() 返回 { generateAssistantResponseResponse: <async-iterable> }
      // （两个 adapter 都读这个字段；读错字段名就是 "Empty response"）。
      return {
        generateAssistantResponseResponse: {
          [Symbol.asyncIterator]: async function* () {
            for (const ev of script) yield ev;
          },
        },
      };
    }
  }

  return {
    CodeWhispererStreaming: FakeCodeWhispererStreaming,
    GenerateAssistantResponseCommand: FakeCommand,
    __record: record,
  };
}

/** 一组最小但形状齐全的事件：一段正文 + 一次 thinking + 一次 token 用量。 */
function defaultEvents() {
  return [
    { assistantResponseEvent: { content: 'Hello', modelId: 'CLAUDE_SONNET_4_20250514_V1_0' } },
    { reasoningContentEvent: { text: 'thinking...', signature: 'sig-1' } },
    {
      metadataEvent: {
        tokenUsage: {
          uncachedInputTokens: 11,
          outputTokens: 7,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 5,
          totalTokens: 26,
        },
      },
    },
  ];
}

module.exports = { makeFakeCwModule, defaultEvents };
