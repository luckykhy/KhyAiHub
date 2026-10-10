'use strict';

/**
 * agentServer.js — 面 A：khy 作为编辑器 ACP 智能体被 Zed/JetBrains 拉起（stdio Agent 端）。
 *
 * 方法面（v1 稳定面，[DESIGN-ARCH-184] §3/§4.1）：
 *   initialize / session/new / session/prompt / session/cancel（通知）/
 *   session/request_permission（反向调用编辑器）。
 * 对话上下文由 ai.chat 的 live session（模块级 _chatState）承载并自动持久化。
 * 已知限制（§11.3）：多会话并发共享进程级上下文——P1 回合串行（一次一个 prompt
 * turn），跨会话隔离留 P2。
 *
 * stdout 红线（协议 MUST）：本进程 stdout 只写合法 ACP 消息，横幅/日志一律 stderr。
 * 权限 fail-closed：编辑器不响应/未知选项/连接断开 → 一律按 deny 结算（RUNTIME-010
 * A2-3/A2-7 口径），绝不把「没等到响应」解释为放行。
 */

const path = require('path');

const { createJsonRpcChannel } = require('./jsonrpcStdio');
const acp = require('./acpTypes');
const sessionMapping = require('./sessionMapping');

/** 会话并发闸（P1 串行，见文件头已知限制）。 */
let _turnLock = Promise.resolve();

/** 当前在跑回合的取消态（session/cancel 命中它；null = 无活跃回合）。 */
let _activeTurn = null; // { controller, signal, sessionId }

/** 协议参数错误（带 JSON-RPC 错误码上抛，通道按 code 回包）。 */
class AcpParamError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 懒加载循环与 chat 管线（serve 进程独占整仓这些模块，不缓存依赖袋以保测试可注入）。 */
function _loadDefaultDeps() {
  // eslint-disable-next-line global-require
  const { runToolUseLoop } = require('../../../tool/toolUseLoop');
  // eslint-disable-next-line global-require
  const ai = require('../../../../cli/ai');
  return {
    runLoop: runToolUseLoop,
    chat: (message, chatOpts) => ai.chat(message, chatOpts),
  };
}

/** prompt 内容块 → 纯文本（P1 只接 text；image/embeddedContext 未广告，客户端不应发送）。 */
function textFromPrompt(prompt) {
  if (!Array.isArray(prompt)) {
    return '';
  }
  return prompt
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** 工具调用的人面标题（动词+目标，RUNTIME-002 合规；params 摘要截 40 字）。 */
function toolTitle(name, params) {
  const target = params && (params.file_path || params.path || params.pattern || params.command || params.query);
  const tail = target ? ` ${String(target).slice(0, 40)}` : '';
  return `${name}${tail}`;
}

/**
 * 创建 Agent 端处理器（与传输解耦，单测可注入 fake channel）。
 *
 * @param {object} opts
 * @param {object} opts.channel - createJsonRpcChannel 实例（write/request）
 * @param {string} [opts.version] - agentInfo.version；缺省从 backend package.json 动态读
 * @param {(line: string) => void} [opts.onErrorLog] - 诊断输出（约定 stderr）
 * @param {{runLoop: Function, chat: Function}} [opts.deps] - 测试注入；缺省懒加载真身
 * @returns {{ handleRequest: Function, handleNotification: Function, close: Function }}
 */
function createAgentServer({ channel, version, onErrorLog, deps } = {}) {
  const _log = onErrorLog || (() => {});
  const _deps = deps || null;
  const _ownSessions = new Set();
  // 客户端声明过的 khy 扩展能力（initialize 时 latch 一次，见 handleInitialize）。
  // null = 还没握手过 ⇒ clientSupports 一律 false（fail-closed）。
  let _clientKhyCaps = null;

  function _getDeps() {
    return _deps || _loadDefaultDeps();
  }

  function _khyVersion() {
    try {
      // eslint-disable-next-line global-require
      const pkg = require('../../../../../package.json');
      return (pkg && pkg.version) || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  function sendUpdate(sessionId, update) {
    channel.write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  }

  // ── 双向能力协商（[MGMT-RPT-035] L7，借鉴 goose `acp/server.rs`）──────────
  //
  // 面 A（khy 作为 ACP agent）将来若要发「khy 自有扩展」的 session/update —— 即
  // ACP v1 稳定面之外的东西 —— 必须先让客户端声明收得到。否则就是往标准协议里
  // 渗私有方言，正是 [DESIGN-ARCH-184] §0 术语红线要拦的形态。
  //
  // goose 的做法（实证）：agent 在 initialize 响应的 meta 里声明自己支持什么；
  // client 在 initialize **请求**的 `clientCapabilities.goose` 里声明自己能收什么；
  // 两侧各 latch 一次，读取处一律 `.unwrap_or(false)` —— **客户端没声明就不发**。
  //
  // 这里只取「读客户端声明 + 默认 false」这一半（khy 侧声明见 handleInitialize 的
  // agentCapabilities）。命名空间用标准字段 `clientCapabilities.khy`，不新造协议字段。

  /** 从 initialize 请求里取出客户端声明的 khy 扩展能力（缺省/畸形 → 空对象）。 */
  function extractClientKhyCaps(params) {
    const cc = params && typeof params === 'object' ? params.clientCapabilities : null;
    if (!cc || typeof cc !== 'object') {
      return {};
    }
    const khy = cc.khy;
    if (!khy || typeof khy !== 'object' || Array.isArray(khy)) {
      return {};
    }
    return khy;
  }

  /**
   * 客户端是否声明过某项 khy 扩展能力。**未握手 / 未声明 / 声明为非 true 一律 false**——
   * 拿 true 假装客户端收得到，比漏发严重得多（漏发只是少一个特性，误发是污染协议）。
   */
  function clientSupports(name) {
    if (!_clientKhyCaps || typeof name !== 'string' || !name) {
      return false;
    }
    return _clientKhyCaps[name] === true;
  }

  // ── initialize / session/new ─────────────────────────────────────────

  function handleInitialize(params) {
    // latch 一次：后到的 initialize 不翻转已协商结果（对齐 goose 的 OnceCell 语义）。
    // 同一进程被第二个客户端重连时，静默改能力会让「发/不发」的判定随时序漂移。
    if (_clientKhyCaps === null) {
      _clientKhyCaps = extractClientKhyCaps(params);
    }
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false }, // session/load 回放是 P2
      agentInfo: { name: 'khy-os', title: 'Khy OS Agent', version: version || _khyVersion() },
      authMethods: [],
    };
  }

  function handleSessionNew(params) {
    const cwd = params && params.cwd;
    if (!cwd || !path.isAbsolute(cwd)) {
      throw new AcpParamError(acp.JSONRPC_ERRORS.invalidParams, 'session/new 需要 cwd 绝对路径');
    }
    const rec = sessionMapping.createSession(cwd);
    _ownSessions.add(rec.id);
    return { sessionId: rec.id };
  }

  // ── session/prompt：一个回合 = runToolUseLoop ────────────────────────

  function runTurn(session, userText) {
    const { runLoop, chat } = _getDeps();
    const controller = new AbortController();
    const signal = { interrupted: false };
    _activeTurn = { controller, signal, sessionId: session.id };
    const messageId = `msg_agent_${Date.now().toString(36)}`;

    const onChunk = (chunk) => {
      if (!chunk || typeof chunk !== 'object') {
        return;
      }
      if (chunk.type === 'text' && chunk.text) {
        sendUpdate(session.id, {
          sessionUpdate: 'agent_message_chunk',
          messageId,
          content: { type: 'text', text: chunk.text },
        });
      } else if (chunk.type === 'thinking' && chunk.text) {
        sendUpdate(session.id, {
          sessionUpdate: 'agent_thought_chunk',
          messageId,
          content: { type: 'text', text: chunk.text },
        });
      }
    };

    // 反向授权：编辑器是审批的呈现面，闸门链仍在 khy 侧（§5）。
    const onControlRequest = async (req) => {
      const toolName = (req && req.request && req.request.tool_name) || 'unknown';
      const input = (req && req.request && req.request.input) || {};
      const options = [
        { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
        { optionId: 'allow-always', name: '总是允许', kind: 'allow_always' },
        { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
      ];
      try {
        const resp = await channel.request('session/request_permission', {
          sessionId: session.id,
          toolCall: {
            toolCallId: (req && req.requestId) || `perm_${Date.now()}`,
            name: toolName,
            title: toolTitle(toolName, input),
            kind: acp.toolKindFromName(toolName),
            rawInput: input,
          },
          options,
        });
        const outcome = resp && resp.result && resp.result.outcome;
        if (!outcome || outcome.outcome !== 'selected') {
          return null; // cancelled / 异形响应 → deny（fail-closed）
        }
        if (outcome.optionId === 'allow-once') {
          return true;
        }
        if (outcome.optionId === 'allow-always') {
          return 'always';
        }
        if (outcome.optionId === 'reject-once') {
          return false;
        }
        return null; // 未知 optionId → deny
      } catch {
        return null; // 连接断开/超时无响应 → deny
      }
    };

    const loopOpts = {
      chat,
      chatOpts: {
        onChunk,
        abortSignal: controller.signal,
      },
      sessionId: session.id,
      interruptSignal: signal,
      onControlRequest,
      onToolCall: (name, params, _iteration, toolUseId) => {
        sendUpdate(session.id, {
          sessionUpdate: 'tool_call',
          toolCallId: toolUseId || `${name}_${Date.now()}`,
          name,
          title: toolTitle(name, params),
          kind: acp.toolKindFromName(name),
          status: 'pending',
        });
      },
      onToolResult: (name, params, result, _iteration, _elapsed, toolUseId) => {
        const failed = result && result.success === false;
        const detail =
          (result && (result.error || result.errorText || result.output || result.stdout)) || '';
        sendUpdate(session.id, {
          sessionUpdate: 'tool_call_update',
          toolCallId: toolUseId || `${name}_${Date.now()}`,
          status: failed ? 'failed' : 'completed',
          ...(detail
            ? {
                content: [
                  { type: 'content', content: { type: 'text', text: String(detail).slice(0, 4000) } },
                ],
              }
            : {}),
        });
      },
    };

    return runLoop(userText, loopOpts)
      .then((loopResult) => {
        // 取消态以 abort 信号为准（session/cancel → interrupted + abort）。
        const wasCancelled = signal.interrupted || controller.signal.aborted;
        const stopReason = wasCancelled ? 'cancelled' : acp.stopReasonFromError(loopResult || {});
        // 回复正文已随流式 chunk 送达；finalResponse 不重复发（协议允许 chunk 聚合）。
        return { stopReason };
      })
      .catch((err) => {
        if (
          signal.interrupted ||
          controller.signal.aborted ||
          /abort|cancel/i.test(String((err && err.errorType) || (err && err.message) || ''))
        ) {
          // 协议 MUST：取消不得以 error 回给编辑器。
          return { stopReason: 'cancelled' };
        }
        throw err;
      })
      .finally(() => {
        if (_activeTurn && _activeTurn.sessionId === session.id) {
          _activeTurn = null;
        }
      });
  }

  function handleSessionPrompt(msg) {
    const params = msg.params || {};
    const session = sessionMapping.getSession(params.sessionId);
    if (!session || !_ownSessions.has(params.sessionId)) {
      throw new AcpParamError(acp.JSONRPC_ERRORS.invalidParams, `未知会话: ${params.sessionId}`);
    }
    const userText = textFromPrompt(params.prompt);
    if (!userText) {
      throw new AcpParamError(
        acp.JSONRPC_ERRORS.invalidParams,
        'session/prompt 至少需要一个 text 内容块'
      );
    }
    // P1 串行闸：后续回合排队（见文件头已知限制）。
    const run = _turnLock.then(() => runTurn(session, userText));
    _turnLock = run.catch(() => {});
    return run;
  }

  // ── 入口分派 ─────────────────────────────────────────────────────────

  async function handleRequest(msg) {
    switch (msg.method) {
      case 'initialize':
        return handleInitialize(msg.params);
      case 'session/new':
        return handleSessionNew(msg.params);
      case 'session/prompt':
        return handleSessionPrompt(msg);
      case 'session/load':
      case 'session/resume':
      case 'session/close':
      case 'session/set_mode':
      case 'session/list':
      case 'session/delete':
      case 'authenticate':
        throw new AcpParamError(
          acp.JSONRPC_ERRORS.methodNotFound,
          `方法未实现（编辑器 ACP v1 稳定面之外，P2 排期）: ${msg.method}`
        );
      default:
        throw new AcpParamError(
          acp.JSONRPC_ERRORS.methodNotFound,
          `未知方法（编辑器 ACP v1 方法面外）: ${msg.method}`
        );
    }
  }

  function handleNotification(msg) {
    if (msg.method !== 'session/cancel') {
      return;
    }
    const sessionId = msg.params && msg.params.sessionId;
    if (_activeTurn && (!sessionId || _activeTurn.sessionId === sessionId)) {
      _activeTurn.signal.interrupted = true;
      try {
        _activeTurn.controller.abort(new Error('cancelled by client session/cancel'));
      } catch {
        /* best effort */
      }
    }
  }

  function close() {
    for (const id of _ownSessions) {
      sessionMapping.deleteSession(id);
    }
    _ownSessions.clear();
  }

  return { handleRequest, handleNotification, close, clientSupports, extractClientKhyCaps };
}

/**
 * 标准启动：stdin/stdout 上拉起通道 + server（serve 进程入口用；单测注入流）。
 * @returns {{ channel: object, server: object }}
 */
function startAgentServer({ input, output, errOutput, version, deps } = {}) {
  const channel = createJsonRpcChannel({
    input: input || process.stdin,
    output: output || process.stdout,
    onMessage: (msg) => {
      if (acp.isNotification(msg)) {
        server.handleNotification(msg);
      }
    },
    onRequest: (msg) => server.handleRequest(msg),
    onErrorLog: (line) => {
      try {
        (errOutput || process.stderr).write(`${line}\n`);
      } catch {
        /* ignore */
      }
    },
  });
  const server = createAgentServer({ channel, version, deps });
  return { channel, server };
}

module.exports = {
  createAgentServer,
  startAgentServer,
  textFromPrompt,
  toolTitle,
  AcpParamError,
};
