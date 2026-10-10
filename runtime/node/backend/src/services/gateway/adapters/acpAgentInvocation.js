'use strict';

/**
 * acpAgentInvocation.js — 面 B：外部编辑器 ACP 智能体的子进程会话生命周期。
 *
 * khy 网关把外部 ACP 智能体（claude-code-acp、gemini-cli 等）当第 19 个适配器：
 * 本叶子管「一个子进程 = 一个长驻 ACP 连接」，adapter 只做网关接口翻译。
 * 子进程按 adapter-key 缓存复用（session/new 一次、后续 session/prompt 复用）；
 * destroy() 优雅关闭（stdin EOF），绝不硬杀（RUNTIME-003）。
 *
 * 会话并发模型：一个子进程连接上允许多个 ACP 会话（协议：each connection can
 * support several concurrent sessions），但一次只跑一个 prompt turn（串行化锁）——
 * 超发直接报错而不是排队挂死，对调用方诚实。
 *
 * 设计真源：[DESIGN-ARCH-184] §4.2。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const { createJsonRpcChannel } = require('../../domain/messaging/agentclient/jsonrpcStdio');

/** 外部智能体注册表（env 覆盖，逗号分隔 key=command[ args...]）。 */
function loadAgentRegistry(env = process.env) {
  const out = {};
  try {
    const raw = String(env.KHY_ACPCLIENT_AGENTS || '').trim();
    if (raw) {
      // 形如 "claude-acp=npx @zed-industries/claude-code-acp,gemini=gemini-cli --experimental-acp"
      for (const token of raw.split(',')) {
        const part = token.trim();
        if (!part) {
          continue;
        }
        const eq = part.indexOf('=');
        if (eq <= 0) {
          continue;
        }
        const key = part.slice(0, eq).trim();
        const cmd = part.slice(eq + 1).trim();
        if (key && cmd) {
          out[key] = cmd;
        }
      }
    }
  } catch {
    /* env 只读等异常 → 空注册表 */
  }
  return out;
}

/**
 * 解析外部智能体可执行命令（单一真源、确定性、绝不抛；仿 opencodeBinResolver 口径）。
 * @returns {{command: string, args: string[]}|null} 未登记/不可达 → null
 */
function resolveAgentCommand(agentKey, env = process.env) {
  const registry = loadAgentRegistry(env);
  const cmdSpec = registry[agentKey];
  if (!cmdSpec) {
    return null;
  }
  const parts = cmdSpec.split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return null;
  }
  const command = parts[0];
  const args = parts.slice(1);
  // 绝对路径/相对路径显式存在性检查；裸命令交给 PATH。
  if (command.includes('/') || command.includes('\\')) {
    try {
      if (!fs.statSync(path.resolve(command)).isFile()) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return { command, args };
}

/**
 * 一条到外部智能体的 ACP 连接（子进程 + JSON-RPC 通道）。
 * @param {{command:string, args:string[]}} resolved
 * @param {{cwd?:string, onErrorLog?:Function}} [opts]
 */
class AcpAgentConnection {
  constructor(resolved, opts = {}) {
    this._resolved = resolved;
    this._cwd = opts.cwd || process.cwd();
    this._log = opts.onErrorLog || (() => {});
    this._child = null;
    this._channel = null;
    this._turnLock = Promise.resolve();
    this._sessionIds = new Set();
    this._closed = false;
    this.agentInfo = null; // initialize 响应回填
  }

  _ensureProcess() {
    if (this._child) {
      return;
    }
    this._child = spawn(this._resolved.command, this._resolved.args, {
      cwd: this._cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, KHY_RUNTIME_MODE: process.env.KHY_RUNTIME_MODE || '' },
    });
    this._child.stderr.on('data', (buf) => {
      // stderr 是对端的日志通道：截尾转发到本端 stderr，不进 stdout 帧流。
      this._log(`[acp-agent:${this._resolved.command}] ${String(buf).trimEnd().slice(0, 2000)}`);
    });
    this._channel = createJsonRpcChannel({
      input: this._child.stdout,
      output: this._child.stdin,
      onMessage: (msg) => this._onInbound(msg),
      onRequest: (msg) => this._onInboundRequest(msg),
      onClose: () => {
        // 对端进程退出：清子进程引用，下次 generate 重新拉起（自动重连语义）。
        this._child = null;
        this._channel = null;
        this._sessionIds.clear();
      },
    });
  }

  /** 入站通知（agent → 本端 session/update 等）。由 adapter 注册 sink。 */
  setUpdateSink(fn) {
    this._updateSink = typeof fn === 'function' ? fn : null;
  }

  _onInbound(msg) {
    if (this._updateSink && msg.method === 'session/update') {
      try {
        this._updateSink(msg);
      } catch {
        /* sink 是呈现侧，绝不影响协议流 */
      }
    }
  }

  /**
   * 入站反向请求（agent → 本端）：目前只有 session/request_permission 有意义。
   * 决策由 adapter 注入的 _permissionHandler 给出（映射 khy 自己的审批 UI）；
   * 未注入处理器时 fail-closed：一律拒绝（RUNTIME-010 A2-3/A2-7 口径）。
   */
  async _onInboundRequest(msg) {
    if (msg.method === 'session/request_permission') {
      try {
        if (!this._permissionHandler) {
          return { outcome: { outcome: 'cancelled' } };
        }
        const outcome = await this._permissionHandler(msg.params || {});
        return { outcome: outcome || { outcome: 'cancelled' } };
      } catch {
        return { outcome: { outcome: 'cancelled' } };
      }
    }
    // 未实现的对端请求：明确拒绝而不是假装成功。
    throw new Error(`khy 未实现该方法（编辑器 ACP v1）: ${msg.method}`);
  }

  setPermissionHandler(fn) {
    this._permissionHandler = typeof fn === 'function' ? fn : null;
  }

  /** 串行化执行 fn；同一连接上的 prompt turn 一次只跑一个（§11 会话并发限制）。 */
  _serialized(fn) {
    const run = this._turnLock.then(fn, fn);
    this._turnLock = run.catch(() => {});
    return run;
  }

  async _ensureAgentSession() {
    if (this._sessionIds.size) {
      return;
    }
    this._ensureProcess();
    const initResp = await this._channel.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'khy-os', version: this._khyVersion() },
    });
    if (initResp.error) {
      throw new Error(`编辑器 ACP initialize 被拒: ${initResp.error.message || 'unknown'}`);
    }
    this.agentInfo = initResp.result && initResp.result.agentInfo;
    const newResp = await this._channel.request('session/new', { cwd: this._cwd, mcpServers: [] });
    if (newResp.error || !newResp.result || !newResp.result.sessionId) {
      throw new Error(`session/new 失败: ${(newResp.error && newResp.error.message) || '无 sessionId'}`);
    }
    this._sessionIds.add(newResp.result.sessionId);
  }

  /**
   * 探测用会话握手（T-025 / [MGMT-PLAN-011] L4）——**加法式公开面**，不改 prompt 路径。
   *
   * 复用 `_ensureAgentSession()` 的 initialize + session/new（空会话、不跑 prompt），
   * 把结果翻译成结构化探测结论。这是「已装但未登录」与「已装且可用」的唯一判据：
   * ACP 的 `initialize` 只能证明智能体会说 ACP，不能证明它登录了（借鉴 AionUi
   * `custom_agent_probe.rs` 的同款注释与做法）。
   *
   * @returns {Promise<{ok:boolean, errorCode?:string, message?:string, authMethods?:number}>}
   */
  async probeSession() {
    let authMethods = 0;
    try {
      await this._ensureAgentSession();
      return { ok: true, authMethods };
    } catch (err) {
      const message = (err && err.message) || String(err);
      // initialize 阶段就能拿到 authMethods（空数组 = 无需登录）
      if (this.agentInfo && Array.isArray(this.agentInfo.authMethods)) {
        authMethods = this.agentInfo.authMethods.length;
      }
      if (_looksLikeAuthError(message) || (authMethods > 0 && /session\/new/.test(message))) {
        return { ok: false, errorCode: 'auth_required', message, authMethods };
      }
      return { ok: false, errorCode: 'session_probe_failed', message, authMethods };
    }
  }

  _khyVersion() {
    try {
      // eslint-disable-next-line global-require
      const pkg = require('../../../../package.json');
      return (pkg && pkg.version) || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  /**
   * 跑一个 prompt turn。resolve 整个 session/prompt 响应（含 stopReason）。
   * onChunk（消息/思考流）、onUpdate（原始 session/update，如 usage_update）、
   * onControlRequest（授权决策）均为可选回调（网关适配器契约）。
   */
  prompt(text, { onChunk, onUpdate, onControlRequest } = {}) {
    return this._serialized(async () => {
      await this._ensureAgentSession();
      const sessionId = Array.from(this._sessionIds)[0];
      const prevSink = this._updateSink;
      const prevPerm = this._permissionHandler;
      this.setUpdateSink((msg) => {
        const u = msg.params && msg.params.update;
        if (!u) {
          return;
        }
        if (typeof onUpdate === 'function') {
          try {
            onUpdate(u);
          } catch {
            /* 呈现/采集回调绝不影响协议流 */
          }
        }
        if (!onChunk) {
          return;
        }
        if (u.sessionUpdate === 'agent_message_chunk') {
          const text2 = u.content && u.content.type === 'text' ? u.content.text : '';
          if (text2) {
            onChunk({ type: 'text', text: text2 });
          }
        } else if (u.sessionUpdate === 'agent_thought_chunk') {
          const text2 = u.content && u.content.type === 'text' ? u.content.text : '';
          if (text2) {
            onChunk({ type: 'thinking', text: text2 });
          }
        }
      });
      if (onControlRequest) {
        this.setPermissionHandler(async (params) => {
          const opts = Array.isArray(params.options) ? params.options : [];
          const allow = opts.find((o) => o.kind === 'allow_once');
          const allowAlways = opts.find((o) => o.kind === 'allow_always');
          const reject = opts.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
          const decision = await onControlRequest({
            requestId: `acp_perm_${params.toolCall && params.toolCall.toolCallId}`,
            request: {
              subtype: 'can_use_tool',
              tool_name: (params.toolCall && params.toolCall.name) || 'unknown',
              input: params.toolCall || {},
              _acpOptions: { allow, allowAlways, reject },
            },
          });
          if (decision === true || decision === 'allow') {
            return allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' };
          }
          if (decision === 'always' || decision === 'allow-always' || decision === 'allow_always') {
            return allowAlways
              ? { outcome: 'selected', optionId: allowAlways.optionId }
              : allow
                ? { outcome: 'selected', optionId: allow.optionId }
                : { outcome: 'cancelled' };
          }
          return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
        });
      }
      try {
        const resp = await this._channel.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: String(text || '') }],
        });
        return resp;
      } finally {
        this.setUpdateSink(prevSink);
        this.setPermissionHandler(prevPerm);
      }
    });
  }

  /** 取消当前 prompt turn（协议：session/cancel 是通知，无响应）。 */
  cancel() {
    if (!this._channel || this._channel.isClosed()) {
      return;
    }
    const sessionId = Array.from(this._sessionIds)[0];
    if (sessionId) {
      this._channel.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    }
  }

  /** 优雅关闭：关 stdin → 对端自行退出。绝不 kill（RUNTIME-003）。 */
  async destroy() {
    this._closed = true;
    if (this._channel) {
      this._channel.close();
    }
    if (this._child) {
      try {
        this._child.stdin.end();
      } catch {
        /* already gone */
      }
    }
    this._child = null;
    this._channel = null;
    this._sessionIds.clear();
  }
}

/** 连接缓存（key = agentKey），adapter 单例复用。测试用 reset 清空。 */
const _connections = new Map();

/**
 * 判一条错误消息是否「未登录/未授权」（ACP 无统一错误码，只能按消息形状匹配；
 * 保守匹配——误判为 auth_required 的代价是 UI 多提示一次登录，远小于漏判）。
 * @param {string} message
 * @returns {boolean}
 */
function _looksLikeAuthError(message) {
  return /auth|unauthor|login|credential|sign ?in|token|forbidden|permission denied/i.test(String(message || ''));
}

function getConnection(agentKey, resolved, opts = {}) {
  let conn = _connections.get(agentKey);
  if (!conn || conn._closed) {
    conn = new AcpAgentConnection(resolved, opts);
    _connections.set(agentKey, conn);
  }
  return conn;
}

async function destroyConnection(agentKey) {
  const conn = _connections.get(agentKey);
  if (conn) {
    await conn.destroy();
    _connections.delete(agentKey);
  }
}

function resetForTest() {
  for (const [k, conn] of _connections) {
    conn.destroy();
  }
  _connections.clear();
}

module.exports = {
  loadAgentRegistry,
  resolveAgentCommand,
  AcpAgentConnection,
  getConnection,
  destroyConnection,
  resetForTest,
};
