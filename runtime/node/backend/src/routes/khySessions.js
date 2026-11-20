'use strict';

/**
 * khySessions.js — khy REPL 会话真源的只读 HTTP 暴露（CH-4）。
 *
 * 真源：services/sessionPersistence（.khy/sessions/ 的 JSONL+JSON 双轨持久化，
 * CLI REPL 经 CH-2 直调）。桌面端按 [DESIGN-LAY-005] L3→L2 仅 HTTP 消费它，
 * 因此这里提供最小的只读视图；一切写操作仍走 CLI/服务层正门，本路由不提供写端点。
 *
 * 挂载：server.js 以 `app.use('/api/khy-sessions', authMiddleware, ...)` 挂载
 * （JWT Bearer / API key，见 src/middleware/auth.js）。
 *
 * AGT-03：认证只回答「你是谁」，不回答「这个会话是不是你的」。会话元数据里记录
 * ownerUserId（routes/ai.js → apiChatSession.persistChatTurn 写入），本路由在此
 * 之上做对象级授权：非属主一律 404（不是 403，避免泄露存在性）；本次修复之前
 * 落盘、没有属主字段的旧会话同样按不存在处理（fail-closed 迁移）。
 */

const express = require('express');

const router = express.Router();

const sessionPersistence = require('../services/sessionPersistence');

const MAX_LIST_LIMIT = 200;
const MAX_CHAIN_MESSAGES = 500;

function _clampLimit(raw, fallback, max) {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.min(n, max);
}

/** 请求者 id（字符串），缺失返回 null。 */
function _requesterId(req) {
  const id = req && req.user ? req.user.id : null;
  return id == null || String(id).trim() === '' ? null : String(id);
}

/**
 * 会话是否属于请求者。旧会话（无属主字段）不通过 —— 迁移期 fail-closed。
 * @param {object} meta - loadSessionMeta / listPersistedSessions 的返回
 * @param {string|null} requesterId
 */
function _isOwnedBy(meta, requesterId) {
  if (!requesterId) {
    return false;
  }
  // loadSessionMeta 把属主放在 metadata 里；listPersistedSessions 的投影把它放在顶层。
  const fromMetadata = meta && meta.metadata ? meta.metadata.ownerUserId : null;
  const owner = fromMetadata != null ? fromMetadata : meta ? meta.ownerUserId : null;
  return owner != null && String(owner) !== '' && String(owner) === requesterId;
}

/**
 * GET /api/khy-sessions
 * 列出已持久化的 REPL 会话（按 updatedAt 倒序），只返回属于请求者的会话。
 */
router.get('/', async (req, res) => {
  try {
    const limit = _clampLimit(req.query.limit, 100, MAX_LIST_LIMIT);
    const requesterId = _requesterId(req);
    const sessions = sessionPersistence
      .listPersistedSessions({ limit })
      .filter((meta) => _isOwnedBy(meta, requesterId));
    res.json({ success: true, data: { sessions, count: sessions.length } });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `读取会话列表失败: ${error.message}`,
    });
  }
});

/**
 * GET /api/khy-sessions/:sessionId
 * 读取单个会话：元数据 + 消息链（uuid 链，leaf 反向遍历）。
 * 非属主（含无属主的旧会话）→ 404。
 */
router.get('/:sessionId', async (req, res) => {
  try {
    const sessionId = String(req.params.sessionId || '').trim();
    // 与 sessionPersistence._safeId 同规则：只放行文件名安全字符
    if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return res.status(400).json({ success: false, message: '非法的会话 ID' });
    }

    const meta = sessionPersistence.loadSessionMeta(sessionId);
    if (!meta || !_isOwnedBy(meta, _requesterId(req))) {
      return res.status(404).json({ success: false, message: '会话不存在' });
    }

    const messages = sessionPersistence
      .buildConversationChain(sessionId)
      .slice(-MAX_CHAIN_MESSAGES);

    res.json({ success: true, data: { session: meta, messages } });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `读取会话失败: ${error.message}`,
    });
  }
});

module.exports = router;
