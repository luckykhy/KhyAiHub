'use strict';

/**
 * registry.js — the single tool exit used by the HTTP server and the mailbox.
 *
 * Registered sets:
 *   - the 12 Phase 1 wire tools from contracts.TOOLS (bridge + phone handlers);
 *   - lib/local-tools.js' local tools are intentionally NOT registered.
 *
 * Scope rules (frozen by contracts.TOOL_POLICY):
 *   operator : everything
 *   phone    : descriptors whose scopes include "phone"
 *   file     : only ping / bridge_status / mailbox_status, never khy_ask
 *
 * Handler results are normalized to {ok:true,data} or a thrown BridgeError so
 * the HTTP layer has exactly one error path. phone-tools returns
 * {ok:false,error} instead of throwing; that is converted here.
 */

const path = require('path');

const C = require('./contracts');
const { createBridgeTools } = require('./bridge-tools');

const FILE_SCOPE_TOOLS = new Set(C.TOOL_POLICY.fileScope.tools);
const DIAGNOSTIC_TOOLS = new Set(['ping', 'bridge_status', 'mailbox_status']);

/** Dotted shorthand with no mechanical underscore equivalent. */
const PHONE_TOOL_ALIASES = Object.freeze({
  'phone.shot': 'phone_screenshot',
});

/**
 * Resolve the dotted shorthand used in docs (phone.info, phone.app.list) to
 * the underscore wire name. Only the phone namespace is aliased; local tool
 * names such as khy.ask stay unregistered on purpose.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeToolName(name) {
  if (typeof name !== 'string') return name;
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  if (Object.prototype.hasOwnProperty.call(PHONE_TOOL_ALIASES, trimmed)) {
    return PHONE_TOOL_ALIASES[trimmed];
  }
  if (trimmed.startsWith('phone.')) return trimmed.replace(/\./g, '_');
  return trimmed;
}

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function asArgs(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new C.BridgeError('invalid_args', '工具参数必须是 JSON 对象');
  }
  return value;
}

function toBridgeError(err, fallbackMessage) {
  if (C.isBridgeError(err)) return err;
  return new C.BridgeError(
    'internal_error',
    err && err.message ? String(err.message).slice(0, 400) : fallbackMessage || '内部错误'
  );
}

/**
 * @param {{
 *   config: object,
 *   deps?: {
 *     adb?: object,
 *     localTools?: object,
 *     phoneTools?: object,
 *     getMailbox?: Function,
 *     getWireless?: Function,
 *     getTasks?: Function,
 *     getRuntime?: Function,
 *     logger?: object,
 *     clock?: Function,
 *   },
 * }} options
 */
function createRegistry(options = {}) {
  const config = options.config || {};
  const deps = options.deps && typeof options.deps === 'object' ? options.deps : {};
  const logger = deps.logger || silentLogger();
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now;
  const localTools = deps.localTools || null;
  const startedAt = clock();

  const bridge = createBridgeTools({
    config,
    adb: deps.adb || null,
    localTools,
    phoneTools: deps.phoneTools || null,
    getMailbox: deps.getMailbox,
    getWireless: deps.getWireless,
    getTasks: deps.getTasks,
    getRuntime: deps.getRuntime,
    logger,
    clock,
  });

  const descriptors = new Map();
  const handlers = new Map();
  const phoneAskUsage = new Map();

  for (const tool of C.TOOLS) {
    const handler = bridge.handlers[tool.name];
    if (typeof handler !== 'function') {
      throw new C.BridgeError('invalid_config', `工具 ${tool.name} 没有对应的处理器`);
    }
    descriptors.set(tool.name, tool);
    handlers.set(tool.name, handler);
  }

  // Local tools are NOT registered: the bridge must not expose a PC shell.
  // localTools is injected only as the internal khy_ask runner (and its jobs).

  function scopeOf(ctx) {
    const scope = ctx && ctx.principal && ctx.principal.scope;
    if (!Object.values(C.SCOPES).includes(scope)) {
      // Fail closed: a missing principal is never treated as operator.
      throw new C.BridgeError('forbidden_scope', '缺少 principal.scope，拒绝调用');
    }
    return scope;
  }

  function assertScope(name, descriptor, scope) {
    if (scope === C.SCOPES.OPERATOR) return;
    if (scope === C.SCOPES.FILE) {
      if (!FILE_SCOPE_TOOLS.has(name)) {
        throw new C.BridgeError('forbidden_scope', `file scope 不允许调用 ${name}`);
      }
      return;
    }
    if (scope === C.SCOPES.PHONE) {
      const scopes = descriptor && Array.isArray(descriptor.scopes) ? descriptor.scopes : [];
      if (!scopes.includes(C.SCOPES.PHONE)) {
        throw new C.BridgeError('forbidden_scope', `phone scope 不允许调用 ${name}`);
      }
      return;
    }
    throw new C.BridgeError('forbidden_scope', `未知 scope：${scope}`);
  }

  function checkPhoneAskQuota(ctx) {
    const key = (ctx && ctx.principal && ctx.principal.tokenId) || 'phone';
    const now = clock();
    const dayMs = 24 * 60 * 60 * 1000;
    const events = (phoneAskUsage.get(key) || []).filter((at) => now - at < dayMs);
    const lastMinute = events.filter((at) => now - at < 60 * 1000).length;
    if (lastMinute >= C.RATE_LIMITS.phoneAsk.perMinute) {
      throw new C.BridgeError('rate_limited', 'phone khy_ask 触发 3/min 限流', {
        retry_after_s: 60,
        limit: C.RATE_LIMITS.phoneAsk.perMinute,
      });
    }
    if (events.length >= C.RATE_LIMITS.phoneAsk.perDay) {
      throw new C.BridgeError('rate_limited', 'phone khy_ask 触发 20/day 限流', {
        retry_after_s: 3600,
        limit: C.RATE_LIMITS.phoneAsk.perDay,
      });
    }
    events.push(now);
    phoneAskUsage.set(key, events);
  }

  function applyPhoneAskPolicy(name, args, scope, ctx) {
    if (name !== 'khy_ask' || scope !== C.SCOPES.PHONE) return args;
    const capability = bridge.readCapability();
    const required = C.TOOL_POLICY.phoneAsk.requiresCapability;
    const capabilityOk = !required || capability[required] === true;
    if (!config.allowPhoneAsk || !capabilityOk) {
      throw new C.BridgeError(
        'phone_ask_disabled',
        `手机侧 khy_ask 默认关闭（需 KHY_AMOON_PHONE_ASK=1 且 capability.json 的 ${required}=true）`,
        {
          allow_phone_ask: Boolean(config.allowPhoneAsk),
          capability_required: required,
          capability_ok: capabilityOk,
          capability_http: capability.http === true,
          capability_status: capability.status,
        }
      );
    }
    checkPhoneAskQuota(ctx);
    return {
      ...args,
      max_turns: 1,
      cwd: '',
      allowed_tools: [C.TOOL_POLICY.sentinelTool],
      timeout_ms: Math.min(Number.isInteger(args.timeout_ms) ? args.timeout_ms : 30000, 30000),
    };
  }

  /**
   * @param {string} name
   * @param {object} rawArgs
   * @param {{principal?:object, requestId?:string, id?:string, source?:string, signal?:AbortSignal}} [ctx]
   * @returns {Promise<{ok:boolean,data?:object,error?:object}>}
   */
  async function call(name, rawArgs, ctx = {}) {
    const requestedName = typeof name === 'string' ? name : String(name);
    const toolName = normalizeToolName(name);
    const descriptor = descriptors.get(toolName);
    if (!descriptor) {
      throw new C.BridgeError('not_found', `未知工具：${requestedName}`);
    }
    const scope = scopeOf(ctx);
    assertScope(toolName, descriptor, scope);
    if (config.enabled === false && !DIAGNOSTIC_TOOLS.has(toolName)) {
      throw new C.BridgeError('bridge_disabled', '桥已被 KHY_AMOON_ENABLED=0 关闭；仅 ping/bridge_status/mailbox_status 可用');
    }
    if (ctx.signal && ctx.signal.aborted) {
      throw new C.BridgeError('timeout', '请求已取消');
    }

    let args = asArgs(rawArgs);
    if (toolName === 'khy_ask') {
      args = applyPhoneAskPolicy(toolName, args, scope, ctx);
    }

    let result;
    try {
      result = await handlers.get(toolName)(args, ctx);
    } catch (err) {
      throw toBridgeError(err);
    }

    if (result && result.ok === false) {
      const error = result.error && typeof result.error === 'object' ? result.error : {};
      throw new C.BridgeError(
        typeof error.code === 'string' ? error.code : 'internal_error',
        typeof error.message === 'string' ? error.message : '工具执行失败',
        error.details
      );
    }
    if (result && result.ok === true) {
      const { ok, ...data } = result;
      return { ok: true, data };
    }
    return { ok: true, data: result === undefined ? {} : result };
  }

  function get(name) {
    return descriptors.get(normalizeToolName(name)) || null;
  }

  function list(scope) {
    const effective = Object.values(C.SCOPES).includes(scope) ? scope : C.SCOPES.FILE;
    const out = [];
    for (const descriptor of descriptors.values()) {
      if (effective === C.SCOPES.OPERATOR) {
        out.push(descriptor);
        continue;
      }
      if (effective === C.SCOPES.FILE) {
        if (FILE_SCOPE_TOOLS.has(descriptor.name)) out.push(descriptor);
        continue;
      }
      if (effective === C.SCOPES.PHONE) {
        const scopes = Array.isArray(descriptor.scopes) ? descriptor.scopes : [];
        if (scopes.includes(C.SCOPES.PHONE)) out.push(descriptor);
      }
    }
    return out;
  }

  function status(scope) {
    const effective = Object.values(C.SCOPES).includes(scope) ? scope : C.SCOPES.FILE;
    const wireless = typeof deps.getWireless === 'function' ? deps.getWireless() : null;
    const mailbox = typeof deps.getMailbox === 'function' ? deps.getMailbox() : null;
    const tasks = typeof deps.getTasks === 'function' ? deps.getTasks() : null;
    const mailboxStatus = mailbox && typeof mailbox.status === 'function' ? mailbox.status() : null;
    const snapshot = wireless && typeof wireless.snapshot === 'function' ? wireless.snapshot() : {};
    const visible = list(effective);
    const taskStatus = tasks && typeof tasks.status === 'function' ? tasks.status() : null;
    if (taskStatus && effective !== C.SCOPES.OPERATOR) delete taskStatus.state_dir;
    return {
      version: C.BRIDGE_VERSION,
      protocol: C.PROTOCOL,
      pid: process.pid,
      started_at: new Date(startedAt).toISOString(),
      uptime_s: Math.max(0, Math.round((clock() - startedAt) / 1000)),
      state: snapshot.state || C.STATES.STOPPED,
      tools: visible.map((descriptor) => descriptor.name),
      tool_count: visible.length,
      mailbox: mailboxStatus
        ? {
            running: mailboxStatus.running,
            inflight: mailboxStatus.inflight,
            last_poll_at: mailboxStatus.last_poll_at,
            last_error: mailboxStatus.last_error,
          }
        : { running: false },
      tasks: taskStatus,
      capability: bridge.readCapability(),
    };
  }

  function close() {
    return localTools && typeof localTools.close === 'function' ? localTools.close() : Promise.resolve();
  }

  return {
    call,
    get,
    list,
    status,
    close,
    has: (name) => descriptors.has(name),
    names: () => [...descriptors.keys()],
    flushSpool: bridge.flushOutbox,
    waitForJob: localTools && typeof localTools.waitForJob === 'function' ? localTools.waitForJob : null,
    cancelJob: localTools && typeof localTools.cancelJob === 'function' ? localTools.cancelJob : null,
    listJobs: localTools && typeof localTools.listJobs === 'function' ? localTools.listJobs : null,
    stateDir: config.stateDir || (localTools && localTools.stateDir) || null,
  };
}

module.exports = {
  FILE_SCOPE_TOOLS,
  createRegistry,
};
