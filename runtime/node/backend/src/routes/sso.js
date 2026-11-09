'use strict';

const express = require('express');

const apiResponse = require('../utils/apiResponse');
const { authMiddleware } = require('../middleware/auth');
const ssoTicketService = require('../services/sso/ssoTicketService');
const { findConsumer, normalizeReturnUrl } = require('../services/sso/ssoConsumerRegistry');

const router = express.Router();

const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 30;
const rateBuckets = new Map();

// Rate-limit key must be the proxy-validated req.ip (server.js sets 'trust proxy',
// 1 hop): reading X-Forwarded-For directly lets a client rotate the header and
// get a fresh bucket on every request, plus unbounded Map growth under flooding.
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

const rateCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets.entries()) {
    if (bucket.resetAt <= now) rateBuckets.delete(ip);
  }
}, 60 * 1000);
if (typeof rateCleanup.unref === 'function') rateCleanup.unref();

router.get('/public-key', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=300');
  if (!ssoTicketService.isConfigured()) {
    return res.status(503).json({
      success: false,
      message:
        'KhyOS SSO 尚未配置密钥对：请在 backend .env 配置 KHYOS_SSO_PRIVATE_KEY(_FILE)/KHYOS_SSO_PUBLIC_KEY(_FILE) 后重启后端',
    });
  }
  return res.json({
    success: true,
    data: {
      algorithm: 'RS256',
      issuer: ssoTicketService.getIssuer(),
      pem: ssoTicketService.getPublicKeyPem(),
    },
  });
});

router.post('/ticket', authMiddleware, (req, res) => {
  if (isRateLimited(clientIp(req))) {
    return res.status(429).json({
      success: false,
      message: '请求过于频繁 (限流)：本机 60 秒内签发票据超过 30 次，请 1 分钟后再试',
    });
  }
  const applicationId = String(req.body?.applicationId || '').trim();
  const consumer = findConsumer(applicationId);
  if (!consumer) {
    return res.status(404).json({
      success: false,
      message:
        '这个项目还没有登记到 KhyOS 生态 (404)：请先在 backend .env 的 KHYOS_SSO_CONSUMERS 登记该 applicationId',
    });
  }
  try {
    const issued = ssoTicketService.issueTicket(req.user, consumer.applicationId);
    return apiResponse.success(res, { ...issued, name: consumer.name });
  } catch (error) {
    if (error && error.code === 'SSO_NOT_CONFIGURED') {
      return res.status(503).json({
        success: false,
        message:
          'KhyOS SSO 尚未配置密钥对：请在 backend .env 配置 KHYOS_SSO_PRIVATE_KEY(_FILE)/KHYOS_SSO_PUBLIC_KEY(_FILE) 后重启后端',
      });
    }
    return res.status(500).json({
      success: false,
      message: '签发登录票据失败 (500)：服务端内部错误，请稍后重试；持续失败请联系维护者',
    });
  }
});

// One-time redemption for ecosystem backends: verify the ticket with the SSO
// public key and burn its jti, so a ticket captured from a redirect URL can
// never complete a second login. The consumer calls this (server-side) before
// trusting the khy_ticket parameter it received.
router.post('/redeem', (req, res) => {
  if (isRateLimited(clientIp(req))) {
    return res.status(429).json({
      success: false,
      message: '请求过于频繁 (限流)：本机 60 秒内超过 30 次，请 1 分钟后再试',
    });
  }
  const ticket = String(req.body?.ticket || '').trim();
  if (!ticket) {
    return res.status(400).json({
      success: false,
      message: '缺少 ticket：把回跳 URL 里的 khy_ticket 原样放进请求体',
    });
  }
  const applicationId = String(req.body?.applicationId || '').trim();
  try {
    const claims = ssoTicketService.redeemTicket(ticket, applicationId);
    return apiResponse.success(res, { claims });
  } catch (error) {
    if (error && error.code === 'SSO_NOT_CONFIGURED') {
      return res.status(503).json({
        success: false,
        message: 'KhyOS SSO 尚未配置密钥对：请在 backend .env 配置密钥路径并重启后端',
      });
    }
    return res.status(401).json({
      success: false,
      message: '票据核销失败：票据无效、已过期或已被核销，请回到项目重新发起登录',
    });
  }
});

function escapeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function renderErrorPage(message) {
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    '<title>KhyOS 授权登录</title>' +
    '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;' +
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}' +
    '.card{max-width:420px;padding:24px;border:1px solid #334155;border-radius:14px;background:#111827;line-height:1.6}' +
    'h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#94a3b8}</style></head><body><main class="card">' +
    '<h1>无法发起授权</h1><p>' +
    String(message || '这个登录请求无效') +
    '</p></main></body></html>'
  );
}

function renderAuthorizePage(config) {
  const configJson = escapeJsonForScript(config);
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    '<title>KhyOS 授权登录</title><style>' +
    'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;' +
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}' +
    '.card{width:min(92vw,420px);padding:24px;border:1px solid #334155;border-radius:14px;background:#111827;' +
    'box-shadow:0 20px 50px rgba(0,0,0,.45)}h1{font-size:18px;margin:0 0 10px}' +
    '#status{margin:0;color:#cbd5e1;line-height:1.6}#status.err{color:#fca5a5}' +
    '.hint{margin:14px 0 0;color:#64748b;font-size:13px;line-height:1.5}' +
    '</style></head><body><main class="card"><h1>KhyOS 授权登录</h1>' +
    '<p id="status">步骤 1/2：校验 KhyOS 登录态…</p>' +
    '<p class="hint">授权完成后会自动回到请求登录的项目。</p>' +
    '</main><script>(function () { var cfg = ' +
    configJson +
    ';' +
    'var statusEl = document.getElementById("status");' +
    'function fail(message) { statusEl.textContent = message; statusEl.className = "err"; }' +
    'function appendTicket(url, ticket, state) {' +
    'var params = new URLSearchParams({ khy_ticket: ticket, state: state });' +
    'var hashIndex = url.indexOf("#");' +
    'if (hashIndex >= 0) { var base = url.slice(0, hashIndex); var fragment = url.slice(hashIndex + 1);' +
    'var sep = fragment.indexOf("?") >= 0 ? "&" : "?";' +
    'return base + "#" + fragment + sep + params.toString(); }' +
    'return url + (url.indexOf("?") >= 0 ? "&" : "?") + params.toString(); }' +
    'var token = ""; try { token = localStorage.getItem("token") || ""; } catch (error) { token = ""; }' +
    'if (!token) { location.replace("/login?redirect=" + encodeURIComponent(location.href)); return; }' +
    'statusEl.textContent = "步骤 2/2：为「" + cfg.appName + "」签发登录票据…";' +
    'fetch("/api/auth/sso/ticket", { method: "POST",' +
    'headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },' +
    'body: JSON.stringify({ applicationId: cfg.applicationId }) })' +
    '.then(function (response) { return response.json().then(function (body) { return { ok: response.ok, body: body }; }); })' +
    '.then(function (result) {' +
    'if (!result.ok || !result.body || !result.body.success) {' +
    'fail((result.body && result.body.message) || "授权请求被拒绝：请回到项目重新发起登录"); return; }' +
    'var ticket = result.body.data && result.body.data.ticket;' +
    'if (!ticket) { fail("签发成功但票据为空：请回到项目重新发起登录"); return; }' +
    'location.replace(appendTicket(cfg.returnUrl, ticket, cfg.state));' +
    '}).catch(function () { fail("授权请求失败：网络或 KhyOS 服务异常，请稍后重试"); });' +
    '})();</script></body></html>'
  );
}

router.get('/authorize', (req, res) => {
  const applicationId = String(req.query.app || '').trim();
  const consumer = findConsumer(applicationId);
  const returnUrl = consumer ? normalizeReturnUrl(req.query.return, consumer) : null;
  res.set('Cache-Control', 'no-store');
  if (!consumer || !returnUrl) {
    return res
      .status(400)
      .type('html')
      .send(
        renderErrorPage(
          '登录请求无效：app 未登记或 return 不在白名单，请检查 KHYOS_SSO_CONSUMERS 配置后重新发起'
        )
      );
  }
  if (!ssoTicketService.isConfigured()) {
    return res
      .status(503)
      .type('html')
      .send(
        renderErrorPage(
          'KhyOS SSO 尚未配置密钥对：请在 backend .env 配置密钥路径并重启后端，再重新发起登录'
        )
      );
  }
  const state = String(req.query.state || '').slice(0, 128);
  return res.type('html').send(
    renderAuthorizePage({
      applicationId: consumer.applicationId,
      appName: consumer.name,
      returnUrl,
      state,
    })
  );
});

module.exports = router;
