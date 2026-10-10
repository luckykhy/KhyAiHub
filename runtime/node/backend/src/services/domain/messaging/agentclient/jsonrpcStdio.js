'use strict';

/**
 * jsonrpcStdio.js — 编辑器 ACP 的 NDJSON 双向 stdio 帧（共享内核）。
 *
 * 面 A（agentServer，khy 作为 Agent 被 Zed 拉起）与面 B（acpAgentAdapter，khy 作为
 * Client 拉起外部智能体）都用这一份：Agent 端的 stdout 就是 Client 端读到的 stdin，
 * 两侧的帧纪律完全对称，没必要各写一遍。
 *
 * 协议红线（agentclientprotocol.com/protocol/v1/transports，MUST）：
 *   消息 UTF-8、以 \n 分隔、不得内嵌换行；一端 stdout/stdin 只允许合法消息。
 * 所以这里只暴露 writeMessage/逐行解析两个动作，绝不提供「顺手打日志」的口子——
 * 诊断一律走 stderr，由调用方自己写（mcpStdioServer 先例的同一纪律）。
 *
 * 设计真源：[DESIGN-ARCH-184] §4/§6。
 */

const readline = require('readline');

/** 单帧上限。默认 16MB：超过视为对端失控，断链比吞帧诚实。 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * 序列化一帧。内嵌换行会让 stdio 帧错位，encode 阶段直接拒绝（fail-fast）。
 * @param {object} msg - 可 JSON 序列化的消息
 * @returns {string} 带结尾 \n 的行
 * @throws {TypeError} 入参不可序列化或序列化结果含换行
 */
function encodeFrame(msg) {
  const line = JSON.stringify(msg);
  if (line.includes('\n') || line.includes('\r')) {
    // JSON.stringify 正常不会产生裸换行（会转义成 \\n）；能走到这说明入参
    // 不是普通 JSON 值（如带 toJSON 的怪对象），宁可炸也不让帧错位。
    throw new TypeError('acp frame contains a newline after serialization');
  }
  return line + '\n';
}

/**
 * 解析一行。空行忽略（返回 null）；坏 JSON 抛 TypeError 由调用方决定回包/断链。
 * @param {string} line
 * @returns {object|null}
 */
function decodeFrame(line) {
  const trimmed = String(line == null ? '' : line).trim();
  if (!trimmed) {
    return null;
  }
  return JSON.parse(trimmed);
}

/**
 * 写一帧到输出流。写失败静默（对端已关 stdin/stdout → 无处可写，非错误）。
 * @param {NodeJS.WritableStream} output
 * @param {object} msg
 */
function writeFrame(output, msg) {
  try {
    output.write(encodeFrame(msg));
  } catch {
    /* stdout closed — nothing to write to */
  }
}

/**
 * 在输入流上挂逐行回调。返回 { close }。
 * 超长行（> MAX_FRAME_BYTES）按协议红线视为对端失控：回调 onError 后断链，
 * 不尝试「跳过这一行继续」——帧边界已经不可信了。
 *
 * @param {NodeJS.ReadableStream} input
 * @param {object} handlers
 * @param {(msg: object) => void} handlers.onMessage
 * @param {(err: Error) => void} [handlers.onParseError] - 坏 JSON 行
 * @param {(err: Error) => void} [handlers.onOversize] - 超长帧
 * @param {number} [opts.maxFrameBytes]
 */
function attachFrameReader(input, handlers = {}, opts = {}) {
  const maxBytes = opts.maxFrameBytes || MAX_FRAME_BYTES;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (Buffer.byteLength(String(line), 'utf8') > maxBytes) {
      const err = new Error(`acp frame exceeds ${maxBytes} bytes`);
      if (handlers.onOversize) {
        handlers.onOversize(err);
      }
      try {
        rl.close();
      } catch {
        /* ignore */
      }
      return;
    }
    let msg;
    try {
      msg = decodeFrame(line);
    } catch (err) {
      if (handlers.onParseError) {
        handlers.onParseError(err);
      }
      return;
    }
    if (msg !== null) {
      handlers.onMessage(msg);
    }
  });
  return {
    rl,
    close() {
      try {
        rl.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * 双向 JSON-RPC 通道：在 attachFrameReader 之上加「本端 request() ↔ 对端 response 按 id 回配」。
 *
 * 面 A 用它反向调编辑器的 session/request_permission；面 B 用它接收外部智能体的
 * session/request_permission、fs/* 反向请求。对端响应分三类：有 method=请求/通知，
 * 交给调用方 onMessage；无 method=对端给本端 request() 的回包，按 id 结算。
 *
 * 未决请求的生命周期（RUNTIME-003）：不设硬超时——协议层没有 deadline，审批请求
 * 挂到用户点头为止是合法的；连接关闭（stdin EOF）时统一以错误拒绝，绝不悬挂。
 *
 * @param {object} opts
 * @param {NodeJS.ReadableStream} opts.input
 * @param {NodeJS.WritableStream} opts.output
 * @param {(msg: object) => void} opts.onMessage - 入站请求/通知
 * @param {(msg: object) => void} [opts.onRequest] - 入站「对端请求」（有 method 且有 id），
 *   返回值（或 Promise）作为 result 回包；抛错则以 internalError 回包
 * @param {() => void} [opts.onClose]
 * @param {(msg: string) => void} [opts.onErrorLog] - 诊断输出（约定走 stderr）
 * @param {number} [opts.maxFrameBytes]
 * @returns {{ request: Function, write: Function, close: Function, isClosed: Function }}
 */
function createJsonRpcChannel(opts = {}) {
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  const _log = opts.onErrorLog || (() => {});

  const reader = attachFrameReader(
    opts.input || process.stdin,
    {
      onMessage: (msg) => _dispatch(msg),
      onParseError: (err) => _log(`jsonrpcStdio: 丢弃无法解析的入站行（JSON 解析失败: ${err.message}）`),
      onOversize: (err) => _log(`jsonrpcStdio: 入站帧超限，断开通道（${err.message}）`),
    },
    { maxFrameBytes: opts.maxFrameBytes }
  );

  const readerRl = reader.rl;
  readerRl.on('close', () => {
    if (closed) {
      return;
    }
    closed = true;
    for (const [id, p] of pending) {
      p.reject(new Error(`对端已关闭连接，请求 id=${id} 未获响应（按失败结算）`));
    }
    pending.clear();
    if (opts.onClose) {
      opts.onClose();
    }
  });

  const _out = () => opts.output || process.stdout;

  function _dispatch(msg) {
    if (!msg || typeof msg !== 'object') {
      _log('jsonrpcStdio: 丢弃非对象入站消息');
      return;
    }
    if (msg.method === undefined) {
      // 对端回包：按 id 结算本端 request()。
      const p = pending.get(msg.id);
      if (!p) {
        _log(`jsonrpcStdio: 收到无主响应 id=${JSON.stringify(msg.id)}`);
        return;
      }
      pending.delete(msg.id);
      p.resolve(msg);
      return;
    }
    if (msg.id === undefined || msg.id === null) {
      // 通知：无回包。
      if (opts.onMessage) {
        opts.onMessage(msg);
      }
      return;
    }
    // 对端请求：执行并回包（协议要求请求必须有响应，出错回 error；AcpParamError 等
    // 带 JSON-RPC code 的错误按其 code 回，其余归 internalError）。
    Promise.resolve()
      .then(() => (opts.onRequest ? opts.onRequest(msg) : null))
      .then(
        (result) => writeFrame(_out(), { jsonrpc: '2.0', id: msg.id, result: result === undefined ? {} : result }),
        (err) =>
          writeFrame(_out(), {
            jsonrpc: '2.0',
            id: msg.id,
            error: {
              code: typeof (err && err.code) === 'number' ? err.code : -32603,
              message: String((err && err.message) || err),
            },
          })
      );
  }

  /**
   * 向对端发起请求并等它的响应（resolve 整个 JSON-RPC 响应对象，含 result/error —— 由调用方判）。
   */
  function request(method, params) {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('jsonrpcStdio: 通道已关闭，无法发送请求'));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      writeFrame(_out(), { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  return {
    request,
    write: (msg) => writeFrame(_out(), msg),
    close: () => reader.close(),
    isClosed: () => closed,
  };
}

module.exports = {
  MAX_FRAME_BYTES,
  encodeFrame,
  decodeFrame,
  writeFrame,
  attachFrameReader,
  createJsonRpcChannel,
};
