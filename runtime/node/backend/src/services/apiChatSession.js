'use strict';

/**
 * apiChatSession.js — land /api/ai/chat/stream turns in the shared session store.
 *
 * The route serves both the web UI and the mobile app. Only a caller that sends
 * its own `sessionId` opts into .khy/sessions — web and khyquant conversations
 * stay in their own stores, and a web question would otherwise mint a new
 * session file on every request.
 *
 * Writing is delegated to sessionPersistence: this module only decides which
 * messages to store and what title/source to carry.
 */

const fs = require('fs');

const sessionPersistence = require('./sessionPersistence');

// Same alphabet the read-only /api/khy-sessions route and _safeId accept.
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
// A history that arrives with no stored session is seeded once; anything older
// than this is already beyond what the gateway shows the model (last 10).
const MAX_SEED_HISTORY = 20;

/**
 * @param {unknown} raw
 * @returns {string|null} the id when it is safe to use as a file name, else null
 */
function normalizeSessionId(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const id = raw.trim();
  return SESSION_ID_RE.test(id) ? id : null;
}

function _turnPersistenceDisabled() {
  const raw = process.env.KHY_DISABLE_SESSION_PERSIST;
  return raw === '1' || raw === 'true';
}

function _isSameUserText(content, prompt) {
  return typeof content === 'string' && content.trim() === prompt;
}

/** 已存 transcript 的消息（uuid/parentUuid 原样保留，回退链靠它）。 */
function _seedFromPrior(prior) {
  const out = [];
  for (const m of prior) {
    if (m && (m.role === 'user' || m.role === 'assistant') && m.content !== undefined) {
      out.push(m);
    }
  }
  return out;
}

/** 新会话：用客户端历史播种，只收非空文本，超窗口的丢掉。 */
function _seedFromHistory(history) {
  const out = [];
  for (const m of history.slice(-MAX_SEED_HISTORY)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      continue;
    }
    if (typeof m.content !== 'string' || !m.content.trim()) {
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/**
 * Messages to persist for one turn.
 *
 * An existing transcript wins over client history: the client may have
 * truncated, compacted or edited its copy, while the stored chain is what every
 * end reads. Stored messages are passed through untouched so uuid/parentUuid
 * (the rewind chain) survive.
 *
 * @param {{prior?: unknown[], history?: unknown[], prompt: string, reply: string}} input
 * @returns {Array<{role: string, content: unknown}>}
 */
function composeTurnMessages({ prior, history, prompt, reply }) {
  const hasPrior = Array.isArray(prior) && prior.length > 0;
  const out = hasPrior
    ? _seedFromPrior(prior)
    : Array.isArray(history)
      ? _seedFromHistory(history)
      : [];

  // Clients often append the question being asked to the history they send
  // (the route appends it again for the model). Storing it once keeps the
  // transcript from showing the same sentence twice.
  const last = out[out.length - 1];
  if (last && last.role === 'user' && _isSameUserText(last.content, prompt)) {
    out.pop();
  }

  out.push({ role: 'user', content: prompt });
  out.push({ role: 'assistant', content: reply });
  return out;
}

/**
 * Append one completed turn to the shared session store.
 *
 * Best-effort by contract: persistence failure must never fail a request whose
 * answer the user already received. The caller gets the canonical id back so it
 * can echo it to the client; null means nothing was written.
 *
 * @param {object} input
 * @param {unknown} input.sessionId - client-supplied; invalid/missing → no write
 * @param {unknown} input.question - the user turn actually sent
 * @param {unknown} input.reply - the full answer the client received
 * @param {string} [input.model]
 * @param {unknown} [input.history] - client history, used only to seed a new session
 * @param {string} [input.cwd] - bucket cwd for a new session
 * @param {unknown} [input.userId] - 请求者身份；写入时记为会话属主（AGT-03）
 * @returns {string|null}
 */
function persistChatTurn({ sessionId, question, reply, model, history, cwd, userId }) {
  const id = normalizeSessionId(sessionId);
  const prompt = typeof question === 'string' ? question.trim() : '';
  const answer = typeof reply === 'string' ? reply : '';
  if (!id || !prompt || !answer.trim() || _turnPersistenceDisabled()) {
    return null;
  }

  const requesterId = userId != null && String(userId).trim() ? String(userId) : null;

  let prior = null;
  try {
    if (fs.existsSync(sessionPersistence.jsonlPathFor(id)) || sessionPersistence.loadSessionMeta(id)) {
      prior = sessionPersistence.restoreSession(id);
    }
  } catch {
    prior = null;
  }

  // AGT-03：会话有属主时，只有属主能继续写。此前任何已登录用户都能带别人的
  // sessionId 往他的会话里追加消息 —— 等于把任意文本注入另一个用户的 agent 上下文。
  const priorOwner =
    prior && prior.metadata && prior.metadata.ownerUserId
      ? String(prior.metadata.ownerUserId)
      : null;
  // 有属主的会话只认属主本人：认不出请求者（requesterId 为空）时同样拒绝。
  // 读侧 khySessions._isOwnedBy 早就是 fail-closed，写侧若对空身份放行，
  // 同一个「对象级授权」在两条路径上就给出两种答案。
  if (priorOwner && priorOwner !== requesterId) {
    return null;
  }
  // 旧会话（无属主）在第一次被续写时由当前请求者认领
  const ownerUserId = priorOwner || requesterId;

  const priorMeta = (prior && prior.metadata) || {};
  const messages = composeTurnMessages({
    prior: prior && prior.messages,
    history,
    prompt,
    reply: answer,
  });

  // Continuing a session must keep its bucket: persistSession derives the
  // project directory from metadata.cwd, so a different cwd here would split
  // one session across two buckets.
  const metadata = {
    ...priorMeta,
    cwd: (typeof priorMeta.cwd === 'string' && priorMeta.cwd) || cwd || process.cwd(),
    source:
      priorMeta.source && typeof priorMeta.source === 'object'
        ? priorMeta.source
        : { type: 'manual', id: 'mobile' },
    ...(ownerUserId ? { ownerUserId } : {}),
  };

  try {
    sessionPersistence.persistSession(id, {
      messages,
      title: (prior && prior.title) || sessionPersistence._pickTitleCandidate(messages),
      model: model || (prior && prior.model) || '',
      metadata,
      ...(prior && prior.createdAt ? { createdAt: prior.createdAt } : {}),
    });
    return id;
  } catch (error) {
    // 惰性取 logger：本模块在 /api/ai/chat/stream 的挂载路径上，顶层 require
    // 会把 winston 拉进冷闭包。
    require('../utils/logger').warn('[apiChatSession] 会话落盘失败', {
      sessionId: id,
      error: String((error && error.message) || error),
    });
    return null;
  }
}

module.exports = {
  normalizeSessionId,
  composeTurnMessages,
  persistChatTurn,
};
