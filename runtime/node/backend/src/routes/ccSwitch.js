'use strict';

/**
 * Express wrapper for the CC-Switch provider-card API.
 *
 * The monolith Express server (server.js) mounts this router at /api/cc-switch.
 * It adapts the raw-http dispatcher (services/ccSwitch/apiHandlers.js) onto
 * Express's req/res so both servers share one implementation. Auth middleware
 * is applied at the mount point (same as /api/proxy-subscriptions).
 */

const express = require('express');

const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

// 全部端点需登录且需 admin 角色（对齐 channelApis 门禁强度：卡片切换会改写
// 本机各 agent 的 live 配置，属 admin 级操作；apiHandlers 内部的
// authenticateRequest 依赖此中间件先注入的 req.authContext / req.user）。
router.use(authMiddleware);
router.use(adminMiddleware);

// Re-inject HTTP deps from Express's own send helpers.
const api = require('../services/domain/config/ccSwitch/apiHandlers.js');

router.all('*', (req, res, next) => {
  const { sendJson, sendError, parseBody } = _expressAdapters(res, req);  api.setCcSwitchHttpDeps({
    sendJson,
    sendError,
    parseBody,
    authenticateRequest: () => Promise.resolve(req.authContext || { ok: true, user: req.user || null }),
  });
  const pathname = req.baseUrl ? `${req.baseUrl}${req.path}` : req.originalUrl;
  api
    .handleCcSwitchApi(req, res, pathname)
    .then(() => {
      /* response already sent */
    })
    .catch((err) => {
      try {
        res.status(500).json({ success: false, message: (err && err.message) || String(err) });
      } catch {
        /* ignore */
      }
    });
});

function _expressAdapters(res, req) {
  // apiHandlers 的约定是 sendJson(res, status, payload) / sendError(res, status, message)
  //（res 在第一位，原始 http 风格）；Express 侧把 res 原样透传并借其方法实现。
  return {
    sendJson: (targetRes, status, data) => {
      try {
        targetRes.status(status).json(data);
      } catch {
        /* ignore */
      }
    },
    sendError: (targetRes, status, message) => {
      try {
        targetRes.status(status).json({ success: false, message });
      } catch {
        /* ignore */
      }
    },
    parseBody: () =>
      new Promise((resolve) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch {
            resolve({});
          }
        });
        req.on('error', () => resolve({}));
      }),
  };
}

module.exports = router;
