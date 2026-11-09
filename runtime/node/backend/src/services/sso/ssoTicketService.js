'use strict';

const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');

function readPem(inline, file) {
  const filePath = String(file || '').trim();
  if (filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch {
      /* fallthrough */
    }
  }
  return String(inline || '')
    .replace(/\\n/g, '\n')
    .trim();
}

const PRIVATE_KEY = readPem(
  process.env.KHYOS_SSO_PRIVATE_KEY,
  process.env.KHYOS_SSO_PRIVATE_KEY_FILE
);
const PUBLIC_KEY = readPem(process.env.KHYOS_SSO_PUBLIC_KEY, process.env.KHYOS_SSO_PUBLIC_KEY_FILE);
const ISSUER = String(process.env.KHYOS_SSO_ISSUER || 'khyos').trim() || 'khyos';
const TTL_SECONDS = (() => {
  const n = Number.parseInt(process.env.KHYOS_SSO_TICKET_TTL_SECONDS || '120', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 600) : 120;
})();

const issuedTickets = new Map();
const timer = setInterval(() => {
  const now = Date.now();
  for (const [jti, exp] of issuedTickets) if (exp <= now) issuedTickets.delete(jti);
}, 60 * 1000);
if (typeof timer.unref === 'function') timer.unref();

function isConfigured() {
  return Boolean(PRIVATE_KEY && PUBLIC_KEY);
}
function getPublicKeyPem() {
  return PUBLIC_KEY;
}
function getTicketTtlSeconds() {
  return TTL_SECONDS;
}
function getIssuer() {
  return ISSUER;
}

function issueTicket(user, applicationId) {
  if (!isConfigured()) {
    const error = new Error('KhyOS SSO 尚未配置密钥对');
    error.code = 'SSO_NOT_CONFIGURED';
    throw error;
  }
  const userId = user && user.id != null ? String(user.id) : '';
  const audience = String(applicationId || '').trim();
  if (!userId || !audience) {
    const error = new Error('签发参数不完整');
    error.code = 'SSO_INVALID_INPUT';
    throw error;
  }

  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();
  const payload = {
    iss: ISSUER,
    aud: audience,
    sub: userId,
    jti,
    iat: now,
    exp: now + TTL_SECONDS,
    username:
      String(user.username || '')
        .trim()
        .slice(0, 32) || undefined,
    email:
      String(user.email || '')
        .trim()
        .toLowerCase() || undefined,
    phone: String(user.phone || user.mobile || '').trim() || undefined,
  };
  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined) delete payload[key];
  });

  const ticket = jwt.sign(payload, PRIVATE_KEY, {
    algorithm: 'RS256',
    keyid: 'khyos-sso-v1',
  });

  issuedTickets.set(jti, (now + TTL_SECONDS) * 1000);

  return {
    ticket,
    applicationId: audience,
    expiresAt: new Date((now + TTL_SECONDS) * 1000).toISOString(),
    expiresIn: TTL_SECONDS,
  };
}

// One-time enforcement lives here: a ticket is redeemable only while its jti is
// still in this process's issuance ledger, and redemption burns it. The ledger
// is memory-only, so after a backend restart older tickets can no longer be
// redeemed — consumers must re-run the authorize flow in that case.
function redeemTicket(ticket, expectedApplicationId) {
  if (!isConfigured()) {
    const error = new Error('KhyOS SSO 尚未配置密钥对');
    error.code = 'SSO_NOT_CONFIGURED';
    throw error;
  }
  const verifyOptions = { algorithms: ['RS256'], issuer: ISSUER };
  const audience = String(expectedApplicationId || '').trim();
  if (audience) verifyOptions.audience = audience;
  let claims;
  try {
    claims = jwt.verify(String(ticket || ''), PUBLIC_KEY, verifyOptions);
  } catch {
    // aud mismatch must not burn the ticket — it may still belong to another consumer
    const error = new Error('登录票据无效、已过期或不属于这个项目');
    error.code = 'SSO_TICKET_INVALID';
    throw error;
  }
  const ledgerExp = typeof claims.jti === 'string' ? issuedTickets.get(claims.jti) : undefined;
  if (!ledgerExp || ledgerExp <= Date.now()) {
    issuedTickets.delete(claims.jti);
    const error = new Error('登录票据已核销、已过期或后端已重启，请重新发起登录');
    error.code = 'SSO_TICKET_REDEEMED';
    throw error;
  }
  issuedTickets.delete(claims.jti);
  return claims;
}

module.exports = {
  isConfigured,
  getPublicKeyPem,
  getTicketTtlSeconds,
  getIssuer,
  issueTicket,
  redeemTicket,
};
