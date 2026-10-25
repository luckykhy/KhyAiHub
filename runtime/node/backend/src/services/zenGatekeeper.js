'use strict';

const crypto = require('crypto');

const {
  ZEN_BASE_URL,
  OPENCODE_USER_AGENT,
} = require('../constants/serviceDefaults');

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function _base62(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += BASE62[bytes[i] % BASE62.length];
  }
  return out;
}

/**
 * OpenCode Identifier.create format (opencode id/id.ts):
 *   prefix + "_" + timeBytes(6→12 hex) + randomBase62(14)
 * Session ids use descending (~timestamp); message ids ascending.
 * Free-tier gate rejects ids that do not start with 12 hex chars.
 */
function _timeHex(descending) {
  let now = BigInt(Date.now()) * BigInt(0x1000) + BigInt(1);
  if (descending) {
    now = ~now;
  }
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  return timeBytes.toString('hex');
}

function newSessionId() {
  return `ses_${_timeHex(true)}${_base62(14)}`;
}

function newRequestId() {
  return `msg_${_timeHex(false)}${_base62(14)}`;
}

function newUuid() {
  return crypto.randomUUID();
}

// ── Identity: 每机一份、跨重启稳定（zenIdentity） ────────────────────────
// 旧行为是「进程级随机」：每重启一次就是一个"新设备"，与固定 IP 组合正是上游
// 反滥用模型里最像批量刷量的形态；多用户共用一个服务端 IP 时更糟——一个 IP 的免费
// 配额被所有人吃干 → 全员 429 → 再全员被封。
// 现在改为「每机一份、跨重启稳定」：**在哪台机器上允许，就在那台机器上用它的机器码**。
// env 显式覆盖优先；主门 KHY_ZEN_IDENTITY 关或叶子不可用 → 逐字节回退旧行为。
let _sessionId = null;
let _projectUuid = null;

/** 取每机持久身份；叶子缺失/异常/门关 → null（调用方回退进程级随机）。 */
function _persistedIdentity() {
  try {
    const id = require('./zenIdentity');
    if (!id || typeof id.getIdentity !== 'function') {
      return null;
    }
    return id.getIdentity(process.env);
  } catch {
    return null;
  }
}

function getSessionId() {
  if (_sessionId) {
    return _sessionId;
  }
  const persisted = _persistedIdentity();
  if (persisted && persisted.sessionId) {
    _sessionId = persisted.sessionId;
    return _sessionId;
  }
  _sessionId = process.env.KHY_ZEN_SESSION_ID || newSessionId();
  return _sessionId;
}

function getProjectUuid() {
  if (_projectUuid) {
    return _projectUuid;
  }
  const persisted = _persistedIdentity();
  if (persisted && persisted.projectUuid) {
    _projectUuid = persisted.projectUuid;
    return _projectUuid;
  }
  _projectUuid = process.env.KHY_ZEN_PROJECT_ID || newUuid();
  return _projectUuid;
}

/** Reset process-stable ids (tests only). */
function _reset() {
  _sessionId = null;
  _projectUuid = null;
  try {
    const id = require('./zenIdentity');
    if (id && typeof id._reset === 'function') {
      id._reset(false); // 只清内存态，不动落盘文件（落盘由叶子自己的 _reset(true) 管）
    }
  } catch {
    /* 叶子缺失 → 无需清 */
  }
}

function getClient() {
  return String(process.env.OPENCODE_CLIENT || 'cli').trim() || 'cli';
}

/**
 * True when `url` points at the Zen free gateway (SSOT endpoint match).
 * Trailing slashes and an optional /v1 suffix on either side are tolerated.
 */
function isZenEndpoint(url) {
  const raw = String(url || '').trim();
  if (!raw) {
    return false;
  }
  try {
    const a = new URL(raw);
    const b = new URL(ZEN_BASE_URL);
    const strip = (u) => `${u.origin}${u.pathname}`.replace(/\/+$/, '').replace(/\/v1$/, '');
    return strip(a) === strip(b);
  } catch {
    return false;
  }
}

/**
 * True when a Zen catalog id is free-tier usable without a paid key.
 * Only `*-free` passes the upstream 401 gate (paid names in /v1/models do not).
 */
function isFreeZenModelId(id) {
  return String(id || '').endsWith('-free');
}

/**
 * Drop paid/non-free ids from a Zen model list (string or {id} entries).
 *
 * 同时剔除已废弃项：`/v1/models` 会继续挂着上游已下线的 id（exo-free 实测 410
 * ModelDeprecated 至今仍在目录里），只判 `-free` 后缀会让用户选中后才在调用时炸。
 * 废弃判定见 zenRetiredModels（静态名单 + 调用反馈落盘账本）。
 *
 * Non-array → []; never throws. Order preserved.
 * @param {Array<string|{id?:string}>|null|undefined} models
 */
function filterFreeZenModels(models) {
  if (!Array.isArray(models)) {
    return [];
  }
  let retired;
  try {
    retired = require('./zenRetiredModels');
  } catch {
    retired = null; // 账本模块缺失不该清空整个列表
  }
  return models.filter((entry) => {
    const id = typeof entry === 'string' ? entry : entry && entry.id;
    if (!isFreeZenModelId(id)) {
      return false;
    }
    if (retired && retired.isRetired(id)) {
      return false;
    }
    return true;
  });
}

/**
 * Build the free-tier gate headers for one request.
 * @param {object} [opts]
 * @param {string} [opts.sessionId]  override sticky session (default: process-stable)
 * @param {string} [opts.requestId]  override per-request id (default: fresh)
 * @param {string} [opts.bearer]     Authorization bearer value ('' or 'public')
 * @returns {Record<string,string>}
 */
function buildZenHeaders(opts = {}) {
  const sessionId = String(opts.sessionId || getSessionId());
  const requestId = String(opts.requestId || newRequestId());
  const bearer = opts.bearer !== undefined ? String(opts.bearer) : 'public';
  const ua = String(process.env.KHY_OPENCODE_USER_AGENT || OPENCODE_USER_AGENT);
  return {
    'User-Agent': ua,
    'x-opencode-session': sessionId,
    'x-opencode-request': requestId,
    'x-opencode-client': getClient(),
    'x-opencode-project': getProjectUuid(),
    'x-session-id': sessionId,
    Authorization: bearer ? `Bearer ${bearer}` : 'Bearer ',
  };
}

/**
 * Whether a chat request body must force stream:true (Zen gate).
 * @param {string} baseUrl
 * @returns {boolean}
 */
function requiresStream(baseUrl) {
  return isZenEndpoint(baseUrl);
}

/**
 * Minimal tool definitions the free-tier body gate accepts.
 * Empirically: stream:true AND tools[] containing both names "bash" and "read"
 * (case-sensitive; schema shape is not fingerprinted). Captured via mitmproxy
 * against official opencode 1.18.27 → FreeTierError otherwise.
 */
const ZEN_GATE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command and return its output.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file from disk and return its contents.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Absolute path to the file' },
        },
        required: ['filePath'],
      },
    },
  },
];

function _toolName(t) {
  return String((t && (t.function?.name || t.name)) || '');
}

/**
 * Mutate an OpenAI chat body so it passes the Zen free-tier body gate.
 * - forces stream:true
 * - ensures tools[] contains both "bash" and "read" (adds ZEN_GATE_TOOLS if missing)
 * - when no caller tools were present, sets tool_choice:"none" so the model
 *   does not attempt to call the synthetic gate tools
 *
 * Never throws; returns the same body reference (or the input if not an object).
 * @param {object} requestBody
 * @param {object} [opts]
 * @param {boolean} [opts.hadCallerTools] true when the caller intentionally passed tools
 * @returns {object}
 */
function applyZenBodyGate(requestBody, opts = {}) {
  try {
    if (!requestBody || typeof requestBody !== 'object') {
      return requestBody;
    }
    requestBody.stream = true;
    const gateNames = new Set(ZEN_GATE_TOOLS.map(_toolName));
    const tools = Array.isArray(requestBody.tools) ? requestBody.tools.slice() : [];
    const presentBefore = new Set(tools.map(_toolName));
    const hadNonGate = [...presentBefore].some((n) => n && !gateNames.has(n));
    const hadCallerTools =
      opts.hadCallerTools === true ||
      (opts.hadCallerTools === undefined && hadNonGate);
    for (const gateTool of ZEN_GATE_TOOLS) {
      const name = _toolName(gateTool);
      if (!presentBefore.has(name)) {
        tools.push(gateTool);
        presentBefore.add(name);
      }
    }
    if (tools.length > 0) {
      requestBody.tools = tools;
    }
    if (!hadCallerTools && requestBody.tool_choice === undefined) {
      requestBody.tool_choice = 'none';
    }
    return requestBody;
  } catch {
    return requestBody;
  }
}

module.exports = {
  ZEN_BASE_URL,
  OPENCODE_USER_AGENT,
  ZEN_GATE_TOOLS,
  isZenEndpoint,
  isFreeZenModelId,
  filterFreeZenModels,
  requiresStream,
  buildZenHeaders,
  applyZenBodyGate,
  getSessionId,
  getProjectUuid,
  getClient,
  newSessionId,
  newRequestId,
  newUuid,
  _reset,
};
